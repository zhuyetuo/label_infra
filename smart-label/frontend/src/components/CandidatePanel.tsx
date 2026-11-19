import { useEffect, useMemo, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Button, Dropdown, Empty, Input, Modal, Popconfirm, Radio, Select, Space, Table, Tag, Tooltip, message, type MenuProps } from "antd";
import { DeleteOutlined, DownOutlined, PauseCircleOutlined, QuestionCircleOutlined, RetweetOutlined, SearchOutlined } from "@ant-design/icons";
import { clearSimilarCandidates, decideCandidate, splitCandidate, type AiCandidate } from "@/api/candidates";
import { formatMs } from "@/components/SegmentPanel";
import BoundaryEditsTag from "@/components/BoundaryEditsTag";
import { REASON_LABEL, SPOT_KIND, spotKindOf, spotOverlapState } from "@/utils/candReason";
import { currentName, findLabel } from "@/utils/labelTree";

/**
 * 疑似片段候选面板：AI 挑出来、还没进正式片段的段，给人逐条确认。抓挠那一类是正式片段
 * （稳定版）为了准滤掉的低门槛再抽一遍；舔 / 进食 / 饮水 / 吠叫是 IMU 规则挑的，让人不用
 * 从零翻视频。人工点「跳转」或「循环」看两秒视频，确认就变成一条正式的人工
 * 片段，排除就记一笔——两种决定都是重训模型最有价值的数据。
 */

const REASON_COLOR: Record<AiCandidate["reason"], string> = {
  low_conf: "orange",
  spectral: "purple",
  grooming: "cyan",
  eating: "volcano",
  drinking: "blue",
  barking: "red",
  shaking: "green",
  toileting: "gold",
  model_neg: "lime",
  vision: "magenta",
  similar: "geekblue",
  spot: "red",
  act_scr: "magenta",
};

interface Props {
  /** 视频现在播到哪（毫秒）：专项片段「在这切开」用 */
  getCurrentMs?: () => number;
  /** 切开以后重新拉一遍疑似片段 */
  onSplit?: () => void | Promise<void>;
  candidates: AiCandidate[];
  readOnly?: boolean;
  onSeek: (ms: number) => void;
  onLoop?: (range: { startMs: number; endMs: number } | null) => void;
  loopRange?: { startMs: number; endMs: number } | null;
  /** 暂停 / 继续播放（不动循环区间：暂停只是停在这一帧去看、去检索，回来还知道是哪一段） */
  onTogglePlay?: () => void;
  /** 确认/排除之后刷新列表；确认时还要把新片段拉进草稿，所以一并重载草稿 */
  onDecided: (c: AiCandidate, decision: AiCandidate["status"]) => void;
  /** 项目里的标签，给「改成别的类别」用（带颜色，跟已标注片段那边的选择器一致） */
  labels?: { id: number; display_name: string; color?: string | null; parent_id?: number | null; sort_order?: number }[];
  /** 「抓挠」在这个项目里的标签 id，下拉里要把它排掉（那是「确认是抓挠」干的事） */
  scratchLabelIds?: number[];
  /** 撤回已经做过的判断，回到「待确认」。确认过的还要把带上去的那条片段一起收回 */
  onUndo?: (c: AiCandidate) => Promise<void>;
  /**
   * 判断之前先把本地改动落库。**顺序很要紧**：确认/改类别是后端直接往草稿里写一条，
   * 如果先写、再拿本地这份（还不知道那条）的列表去存草稿，存的那一步会把它当成
   * "被删掉的条目"清掉——刚建的片段立刻就没了。
   */
  onBeforeDecide?: () => Promise<void>;
  /**
   * 筛选/分页这排控件渲染到哪儿。给了就 portal 到折叠面板的标题行上，
   * 跟「疑似片段（17 待确认 / 17）」拼一行——工作台里高度是最紧的资源，
   * 一排筛选、一排说明、一排分页三行下来，能看的片段就剩四五条
   */
  controlsPortalTarget?: HTMLElement | null;
  /** 「找相似」：拿当前画面（或一句话）在项目里找长得像的几秒。没建索引时不给 */
  onFindSimilar?: (atSec?: number, labelName?: string) => void;
  /** 从找相似的结果/链接跳进来：起点是这个毫秒的那条排最前并高亮 */
  focusMs?: number | null;
  /** 打开时先筛哪一档（从找相似的链接进来默认只看「画面相似」） */
  initialFilter?: "pending" | "all" | "similar";
  /** 打开时先只看这几类候选（从列表页按「疑似饮水」之类筛进来的） */
  initialLabelFilter?: string[];
  /** 清掉全部还没判过的「画面相似」候选；返回删了几条。给了才显示按钮 */
  onClearSimilar?: () => Promise<number>;
  /** 审核标「这条判断有问题」/ 清掉。不给就不显示那个按钮（没权限的人）。note=null 是清掉 */
  onReviewNote?: (c: AiCandidate, note: string | null) => void;
  /** 只有清掉的权限（标注员）：不显示「有问题」，只显示「已改好」 */
  reviewNoteClearOnly?: boolean;
  /** 打开时先只看被标有问题的（标注员拿到被退回的任务） */
  initialFlaggedOnly?: boolean;
}

// 审核标「这条判断有问题」时的常见原因；不在里面的选「其他原因…」自己写
const CAND_NOTE_PRESETS = ["判断错了", "不该排除", "应该确认", "改成的类别不对", "起止不准"];

// 跟正式片段上的「待定」同一套三种：没画面的除非补拍否则永远定不了（可以直接
// 跳过）、看不清的换个人/换个视角也许还能定（值得再看）、要细切的是已经确定
// 是抓挠、只是起止要调，纯排期问题。每处都写明是哪一种，不然得逐条点开才知道
/**
 * 从「找相似」跳进来的那一刻，算不算命中这一条候选。
 *
 * 原来只比起点（|起点 - 这一刻| < 1.5 秒）——**候选是一段，不是一个点**。
 * 找相似给的是段里的某一刻，而候选常常三五秒长，起点比那一刻早两三秒是常态：
 * 于是明明有这一条，却不置顶也不高亮，横幅还在说"这一条置顶高亮"。
 * 先按"这一刻落在这一段里"算（跟已标注片段那边一个口径），起点近的再兜一下——
 * 导出挖过洞的段起止会差几十毫秒。
 */
export const candFocus = (c: AiCandidate, focusMs: number): boolean =>
  (c.start_time_ms <= focusMs && focusMs < c.end_time_ms) ||
  Math.abs(c.start_time_ms - focusMs) < 1500;

/**
 * 这条候选是哪来的。
 *
 * reason 只分到「画面相似」就到头了——一句话找画面 和 用这一张去扩 写出来的是同一个
 * reason，而这两件事人是分开做的：某一次一句话搜得一塌糊涂，想整批清掉，不能把
 * 以图搜图辛苦扩出来的一起带走。所以再看一眼 model 上带的那一截来源。
 *
 * 旧数据的 model 就是光秃秃的 "siglip"（那时两个入口还没分开）：单独一档，
 * **不并进任何一边**——分不清来源却猜一个，人按那一档删就会误删。
 */
export const srcOf = (c: AiCandidate): string => {
  if (c.reason !== "similar") return c.reason;
  if (c.model === "siglip:text") return "text";
  if (c.model === "siglip:img") return "image";
  return "similar_old";
};

export const SRC_CN: Record<string, string> = {
  text: "一句话找画面",
  image: "用这一张去扩",
  similar_old: "画面相似（旧）",
  low_conf: "AI 低置信",
  spectral: "频谱像抓挠",
  grooming: "姿态像舔/啃",
  eating: "姿态+节律像进食",
  drinking: "姿态+节律像饮水",
  barking: "冲击串像吠叫",
  shaking: "振荡像甩头/抖身",
  toileting: "走停走像如厕",
  model_neg: "模型判成这一类",
  vision: "大模型看视频",
  spot: "抽查·新模型报的",
  act_scr: "专项·活动里疑似抓挠",
};

const UNCERTAIN_KINDS = [
  { value: "no_view", short: "没画面", label: "画面里没拍到狗" },
  { value: "ambiguous", short: "看不清", label: "拍到了但看不准" },
  { value: "needs_split", short: "起止要调", label: "是这个动作，但起止不对 / 要拆细" },
  { value: "compound", short: "复合动作", label: "几个动作混在一起（比如边挠边舔、挠完接着抖）" },
] as const;
// 专项（给模型调整用）：判断只记在疑似片段上，不写进任务标注——只读 / 已通过的任务也能判，不用提交
const isSpecialReason = (r: string) => r === "spot" || r === "act_scr";
/** 专项待判数变了（判掉一条 -1、撤回 +1）：项目页上的「专项 待判 N」先立刻改，后台再去对账。
 *  不等服务器那边的统计刷新——原来要等最多一分钟，判完了还挂着「待判 1」，看着像 bug */
const sameKind = (cand: string, picked: string) => {
  const base = currentName(cand);
  const p = currentName(picked);
  return p === base || p.startsWith(base + "-");
};
function notifySpecial(c: AiCandidate, delta: number) {
  if (!isSpecialReason(c.reason)) return;
  window.dispatchEvent(new CustomEvent("special-cand-changed", { detail: { taskId: c.task_id, label: c.label_name, delta } }));
}

export default function CandidatePanel({
  getCurrentMs,
  onSplit,
  candidates,
  readOnly,
  onSeek,
  onLoop,
  loopRange,
  onTogglePlay,
  onDecided,
  labels = [],
  scratchLabelIds = [],
  onUndo,
  onBeforeDecide,
  controlsPortalTarget,
  onFindSimilar,
  onClearSimilar,
  focusMs,
  initialFilter,
  initialLabelFilter,
  onReviewNote,
  reviewNoteClearOnly,
  initialFlaggedOnly,
}: Props) {
  const [filter, setFilter] = useState<"pending" | "all" | "similar" | "flagged" | "spot">(
    initialFlaggedOnly ? "flagged" : initialFilter ?? "pending");
  useEffect(() => {
    if (initialFlaggedOnly) setFilter("flagged");
  }, [initialFlaggedOnly]);
  const flaggedCount = candidates.filter((c) => c.review_note).length;
  const [noteFor, setNoteFor] = useState<AiCandidate | null>(null);
  const [noteText, setNoteText] = useState("");
  useEffect(() => {
    if (initialFilter) setFilter(initialFilter);
  }, [initialFilter]);
  const similarCount = candidates.filter((c) => c.reason === "similar" && c.status === "pending").length;
  // 抽查（reason=spot）还没判的：有就默认先只看它们（打开一次只自动切一次，人切走了不再拽回来）
  const isSpecial = isSpecialReason;
  const spotCount = candidates.filter((c) => isSpecial(c.reason) && c.status === "pending").length;
  const autoSpot = useRef(false);
  useEffect(() => {
    if (!autoSpot.current && spotCount > 0 && !initialFlaggedOnly) {
      autoSpot.current = true;
      setFilter("spot");
    }
  }, [spotCount, initialFlaggedOnly]);
  // 只看某一类：找相似 / 找片段常常一次落好几个类别，混在一起没法逐类核对
  const [labelFilter, setLabelFilter] = useState<string[]>(initialLabelFilter ?? []);
  useEffect(() => {
    if (initialLabelFilter?.length) setLabelFilter(initialLabelFilter);
  }, [initialLabelFilter]);
  const labelCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of candidates) m.set(c.label_name, (m.get(c.label_name) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [candidates]);
  // 只看某个来源：一句话找画面 / 用这一张去扩 / AI 低置信…混在一起时，
  // 想核对"刚才那一轮搜出来的到底对不对"根本挑不出来
  const [srcFilter, setSrcFilter] = useState<string[]>([]);
  const srcCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of candidates) m.set(srcOf(c), (m.get(srcOf(c)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [candidates]);
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  // 刚在这一屏处理过的候选。一确认/改类别它就不是"待确认"了，直接从列表消失的话
  // 人没法核对自己刚才做了什么——留着，直到手动收起或换任务
  const [justDecided, setJustDecided] = useState<Set<number>>(new Set());
  const pendingCount = candidates.filter((c) => c.status === "pending").length;
  const empty = candidates.length === 0;
  useEffect(() => {
    if (empty) setJustDecided(new Set());
  }, [empty]);

  // 全处理完了就自动切到「全部」：不然这一块只剩一句"没有待确认的候选"，
  // 刚才确认/改类别/待定的那几条全看不见了，回头想核对只能靠猜
  useEffect(() => {
    // 只在停在「待确认」时切：停在「有问题」那档的人是来改那几条的，别把他拽走
    if (pendingCount === 0 && candidates.length > 0) setFilter((f) => (f === "pending" ? "all" : f));
  }, [pendingCount, candidates.length]);

  // 从找相似的链接进来带的是 ?cand=similar，但那个任务的候选可能一条「画面相似」
  // 都没有（是 AI 预标注 / 大模型看视频找动作落下的）。这时「画面相似」那个档根本不渲染，
  // 于是筛选框看着一个都没选中、表格空着，标题上却写着「4 待确认」——
  // 只会让人以为是坏了。选不到的档就别停在那儿，退回「待确认」。
  useEffect(() => {
    if (filter === "similar" && similarCount === 0 && candidates.length > 0) setFilter("pending");
  }, [filter, similarCount, candidates.length]);

  const rows = useMemo(() => {
    let list = candidates.filter((c) =>
      filter === "all"
        ? true
        : filter === "flagged"
          ? !!c.review_note || justDecided.has(c.id)
        : filter === "similar"
          ? c.reason === "similar" && (c.status === "pending" || justDecided.has(c.id))
        : filter === "spot"
          ? isSpecial(c.reason) && (c.status === "pending" || justDecided.has(c.id))
          : c.status === "pending" || justDecided.has(c.id)
    );
    if (labelFilter.length) list = list.filter((c) => labelFilter.includes(c.label_name));
    if (srcFilter.length) list = list.filter((c) => srcFilter.includes(srcOf(c)));
    // 从找相似/链接跳进来的那条排最前，人一眼就知道"是这段"
    if (focusMs != null) {
      const hit = (c: AiCandidate) => candFocus(c, focusMs);
      list = [...list.filter(hit), ...list.filter((c) => !hit(c))];
    }
    return list;
  }, [candidates, filter, labelFilter, srcFilter, justDecided, focusMs]);
  const isFocus = (c: AiCandidate) => focusMs != null && candFocus(c, focusMs);


  const decide = async (
    c: AiCandidate,
    decision: AiCandidate["status"],
    labelId?: number,
    labelName?: string,
    uncertainReason?: string
  ) => {
    setBusy(c.id);
    // 先改界面，再等服务器
    const counted = c.status === "pending" && decision !== "pending";
    if (counted) notifySpecial(c, -1);
    try {
      await onBeforeDecide?.();
      try {
        await decideCandidate(c.id, decision, labelId, uncertainReason);
      } catch (e) {
        if (counted) notifySpecial(c, +1);
        throw e;
      }
      const special = isSpecial(c.reason);
      message.success(
        special
          ? decision === "rejected"
            ? "已记下：不是，模型误报"
            : decision === "uncertain"
              ? `已记下：待定·${UNCERTAIN_KINDS.find((k) => k.value === uncertainReason)?.short ?? ""}`
              : labelName && !sameKind(c.label_name, labelName)
                ? `已记下：其实是「${labelName}」（模型认错了）`
                : `已记下：确实是${currentName(c.label_name)}（之前漏标了）${labelName ? `，部位 ${labelName.slice(currentName(c.label_name).length + 1) || labelName}` : ""}`
          : decision === "rejected"
          ? "已排除"
          : decision === "uncertain"
            ? "已标成待定，这段不会进训练集"
            : labelName
              ? `已标成「${labelName}」，加入标注片段`
              : "已确认，已加入标注片段"
      );
      setJustDecided((prev) => new Set(prev).add(c.id));
      onDecided(c, decision);
    } finally {
      setBusy(null);
    }
  };

  // 候选里常有"其实是别的动作"的段（甩身体最多）。标成那个类别比「排除」有用：
  // 排除只是记一笔"不是抓挠"，标成甩身体则给了模型一个正例，同时天然成为抓挠
  // 的难负样本——正是最缺的那种训练数据
  const otherLabels = labels.filter((l) => !scratchLabelIds.includes(l.id));
  // 「改成别的」：一上来只摆大类，有小类的再一层层展开（子菜单第一项是「就是 X」，大类本身也能选）。
  // 原来上百项平铺，判一条要翻半天
  const otherIds = new Set(otherLabels.map((l) => l.id));
  const kidsOf = (id: number | null) => otherLabels.filter((l) =>
    id == null ? l.parent_id == null || !otherIds.has(l.parent_id) : l.parent_id === id);
  const labelTag = (l: (typeof labels)[number]) => (
    <Tag color={l.color || undefined} style={{ marginRight: 0 }}>{l.display_name}</Tag>
  );
  const relabelItems = (id: number | null): NonNullable<MenuProps["items"]> => kidsOf(id).map((l) => {
    const kids = kidsOf(l.id);
    if (!kids.length) return { key: String(l.id), label: labelTag(l) };
    return {
      key: `g${l.id}`,
      label: labelTag(l),
      popupClassName: "cand-relabel-sub",
      children: [
        { key: String(l.id), label: <span>就是 {labelTag(l)}</span> },
        { type: "divider" as const },
        ...relabelItems(l.id),
      ],
    };
  });
  // 记住上一次改成了什么：一连几条都是同一种（比如都是舔-后肢）时直接点，不用再展开
  const [lastRelabel, setLastRelabel] = useState<string | null>(() => {
    try { return localStorage.getItem("cand-last-relabel"); } catch { return null; }
  });
  const lastLabel = lastRelabel ? otherLabels.find((l) => l.display_name === lastRelabel) : undefined;
  const relabel = (c: AiCandidate, l: (typeof labels)[number]) => {
    setLastRelabel(l.display_name);
    try { localStorage.setItem("cand-last-relabel", l.display_name); } catch { /* 存不了就只管这一次 */ }
    return decide(c, "confirmed", l.id, l.display_name);
  };
  /** 某个标签底下的直接子部位。按 parent_id 找，找不到再按「父名-」前缀兜底
   *  （老项目里的标签可能没挂 parent_id，那时候层级只体现在名字上）。 */
  const partsOf = (rawName: string) => {
    // 候选里存的可能是旧名（舔身体），项目标签叫「舔」——按旧名找，父标签找不到、
    // 前缀也对不上，结果是「确认是舔身体」底下一个部位按钮都没有，
    // 而旁边没改过名的「抓挠」一切正常。看着像"这一类就是没有部位"
    const name = currentName(rawName);
    const parent = findLabel(labels, name);
    const kids = parent ? labels.filter((l) => l.parent_id === parent.id) : [];
    if (kids.length) return kids;
    return labels.filter((l) => l.display_name.startsWith(name + "-")
                                && !l.display_name.slice(name.length + 1).includes("-"));
  };

  // 专项片段里混着几个动作：把视频播到动作换了的地方，点「在这切开」，前后两段各自去判
  const split = async (c: AiCandidate) => {
    const at = getCurrentMs?.();
    if (at == null) return;
    if (at - c.start_time_ms < 500 || c.end_time_ms - at < 500) {
      message.warning("先把视频播到这一段中间、动作换了的地方（离两头各至少 0.5 秒），再点「在这切开」");
      return;
    }
    setBusy(c.id);
    try {
      await splitCandidate(c.id, Math.round(at));
      notifySpecial(c, +1);
      message.success(`已在 ${formatMs(Math.round(at))} 切开成两段，分别判`);
      await onSplit?.();
    } finally {
      setBusy(null);
    }
  };

  // 点错了、或者看完视频改主意了，得能退回去重判——不然只能去「已标注片段」
  // 那边找到对应的条目再退回候选，绕一大圈；排除/待定的更是根本没有入口
  const undo = async (c: AiCandidate) => {
    if (!onUndo) return;
    setBusy(c.id);
    if (c.status !== "pending") notifySpecial(c, +1);
    try {
      await onUndo(c);
      setJustDecided((prev) => new Set(prev).add(c.id));
      message.success("已撤回，可以重新判断");
    } finally {
      setBusy(null);
    }
  };

  const isLooping = (c: AiCandidate) =>
    loopRange != null && loopRange.startMs === c.start_time_ms && loopRange.endMs === c.end_time_ms;

  // 筛选、说明、翻页挤在一起放标题行上；说明本身收进问号里——它只在第一次
  // 用的时候有用，天天占一整行不值当
  const controls = (
    // 这排东西 portal 到折叠面板标题上，点它们不能顺带把面板折起来
    <Space size={6} onClick={(e) => e.stopPropagation()}>
      <Radio.Group
        size="small"
        optionType="button"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        options={[
          { label: `待确认 ${pendingCount}`, value: "pending" },
          ...(flaggedCount > 0 || filter === "flagged" ? [{ label: `有问题 ${flaggedCount}`, value: "flagged" }] : []),
          ...(spotCount > 0 || filter === "spot" ? [{ label: `专项 ${spotCount}`, value: "spot" }] : []),
          ...(similarCount > 0 ? [{ label: `画面相似 ${similarCount}`, value: "similar" }] : []),
          { label: `全部 ${candidates.length}`, value: "all" },
        ]}
      />
      {labelCounts.length > 1 && (
        <Tooltip title="只看某几类。列出来的**就是这批候选里实有的类别**和各自的条数（不是项目的全量标签），所以数字加起来等于「全部」。找相似 / 找片段一次会落好几个类别，混在一起没法逐类核对">
          <Select
            size="small"
            mode="multiple"
            allowClear
            // 不用 maxTagCount="responsive"：它靠量宽度决定收不收标签，容器宽度
            // 是弹的时候会自己跟自己打架（展开→撑爆→收起→放得下→再展开），一帧
            // 一个样地闪。固定宽度 + 固定收几个，不量宽度就不会打架
            maxTagCount={1}
            placeholder="只看类别"
            style={{ width: 170 }}
            value={labelFilter}
            onChange={setLabelFilter}
            options={labelCounts.map(([name, n]) => ({
              value: name,
              label: (
                <span>
                  {/* 按新名找颜色：候选里存的可能是旧名（舔身体），项目标签叫「舔」，
                      直接按 display_name 找会落空，这一条就成了没颜色的灰标签 */}
                  <Tag color={findLabel(labels, name)?.color || undefined} style={{ marginRight: 4 }}>
                    {currentName(name)}
                  </Tag>
                  <span style={{ color: "#999", fontSize: 12 }}>{n}</span>
                </span>
              ),
            }))}
          />
        </Tooltip>
      )}
      {srcCounts.length > 1 && (
        <Tooltip title="只看某个来源。一句话找画面 和 用这一张去扩 写出来的都是「画面相似」，但人是分开做的：某一轮一句话搜得不好想整批清掉，不该把以图搜图扩出来的一起带走。「画面相似（旧）」是两个入口还没分开时写的，认不出是哪一边">
          <Select
            size="small"
            mode="multiple"
            allowClear
            maxTagCount={1}
            placeholder="只看来源"
            style={{ width: 160 }}
            value={srcFilter}
            onChange={setSrcFilter}
            options={srcCounts.map(([k, n]) => ({
              value: k,
              label: (
                <span>
                  {SRC_CN[k] ?? k} <span style={{ color: "#999", fontSize: 12 }}>{n}</span>
                </span>
              ),
            }))}
          />
        </Tooltip>
      )}
      {onFindSimilar && (
        <Tooltip title="拿视频当前这一帧（比如正在舔尾巴）在整个项目里找长得像的几秒，写成候选。靠画面向量索引，不问大模型、不花钱">
          <Button size="small" icon={<SearchOutlined />} onClick={() => onFindSimilar()}>
            找相似
          </Button>
        </Tooltip>
      )}
      {similarCount > 0 && onClearSimilar && (
        <Popconfirm
          title={`把 ${similarCount} 条还没判过的「画面相似」候选全删掉？`}
          description="已经确认 / 排除 / 待定的不动。找相似只是试参数、找错一堆时用"
          okText="清掉"
          okButtonProps={{ danger: true }}
          onConfirm={async () => {
            setClearing(true);
            try {
              const n = await onClearSimilar();
              message.success(`清掉了 ${n} 条画面相似候选`);
              if (filter === "similar") setFilter("pending");
            } finally {
              setClearing(false);
            }
          }}
        >
          <Tooltip title="清掉全部还没判过的「画面相似」候选（找相似试错了一堆时用）；判过的不动">
            <Button size="small" danger icon={<DeleteOutlined />} loading={clearing}>
              清掉相似
            </Button>
          </Tooltip>
        </Popconfirm>
      )}
      {justDecided.size > 0 && filter === "pending" && (
        <Tooltip title="刚处理过的这几条暂时留着不受筛选影响，方便核对；核对完可以收起来">
          <Button size="small" onClick={() => setJustDecided(new Set())}>
            收起刚处理的 {justDecided.size} 条
          </Button>
        </Tooltip>
      )}
      <Tooltip
        title={
          <div style={{ lineHeight: 1.7 }}>
            AI 挑出来、正式片段里还没有的段：模型可能漏掉的抓挠，以及规则猜的舔 / 进食 / 饮水 / 吠叫
            （「线索」列写着是怎么挑出来的）。看一眼视频：
            <br />
            猜对了就「确认是 X」；
            <br />
            其实是别的动作就「改成别的」——比单纯排除有用，等于给了那个类别一个正例，
            同时是原类别最缺的难负样本；
            <br />
            都不是就「排除」；
            <br />
            看了也拿不准就「待定」（那段时间不进训练集）。
            <br />
            这几种都会成为下次训练的数据。
          </div>
        }
      >
        <QuestionCircleOutlined style={{ color: "#999", cursor: "help" }} />
      </Tooltip>
    </Space>
  );

  return (
    <div>
      {controlsPortalTarget ? createPortal(controls, controlsPortalTarget) : <div style={{ marginBottom: 8 }}>{controls}</div>}
      <Table
        size="small"
        rowKey="id"
        dataSource={rows}
        // 正在循环的那一行高亮：暂停去干别的回来，一眼看到是哪一段
        rowClassName={(c: AiCandidate) => [isFocus(c) ? "cand-focus-row" : "", isLooping(c) ? "cand-loop-row" : ""].filter(Boolean).join(" ")}
        onRow={(c: AiCandidate) => (isFocus(c) ? { style: { background: "var(--sl-hl-blue)" } } : {})}
        pagination={false}
        // 只留横向滚动：给了 y 之后表格自己会出一条纵向滚动条，跟外面那条
        // 套在一起——鼠标在表格里滚的是里面那条，想滚整页还得把鼠标挪出去。
        // 一页就十条，让它整个铺开，纵向交给外层那一条
        scroll={{ x: 720 }}
        // 固定列宽：自动列宽时一条长说明 + 一排操作按钮会把表格撑得比面板宽，人得左右拉。
        // 固定之后长说明省略成一行（悬停看全文），线索 / 操作放不下就折行，一屏看完
        tableLayout="fixed"
        locale={{
          // 一条都不显示、标题上却写着「4 待确认」，人只会以为是坏了。
          // 是被筛选挡住的就直说是哪一档挡的，并给一个当场取消的按钮——
          // 让人自己去猜是哪个控件干的，等于把 bug 甩给用户
          emptyText: candidates.length && (labelFilter.length || filter !== "all") ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span>
                  这条数据有 {candidates.length} 条疑似片段，但
                  {labelFilter.length ? `「只看类别：${labelFilter.map(currentName).join("、")}」` : ""}
                  {labelFilter.length && filter === "similar" ? "和" : ""}
                  {filter === "similar" ? "「画面相似」" : labelFilter.length ? "" : "当前这一档"}
                  把它们全挡住了
                </span>
              }
            >
              <Button size="small" onClick={() => { setLabelFilter([]); setFilter("all"); }}>
                看全部 {candidates.length} 条
              </Button>
            </Empty>
          ) : candidates.length ? (
            <Empty description="没有待确认的候选" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Empty description="这条数据没有疑似片段（跑一次 AI 预标注才会生成）" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ),
        }}
        columns={[
          {
            title: "时间",
            width: 118,
            render: (_, c: AiCandidate) => (
              <span style={{ whiteSpace: "nowrap", lineHeight: 1.35 }}>
                {formatMs(c.start_time_ms)}<br />~ {formatMs(c.end_time_ms)}
              </span>
            ),
          },
          {
            title: "时长",
            width: 66,
            sorter: (a: AiCandidate, b: AiCandidate) =>
              a.end_time_ms - a.start_time_ms - (b.end_time_ms - b.start_time_ms),
            render: (_, c: AiCandidate) => `${((c.end_time_ms - c.start_time_ms) / 1000).toFixed(1)}s`,
          },
          {
            title: "线索",
            width: 150,
            render: (_, c: AiCandidate) => (
              <Space size={2} wrap>
                {/* 画面相似那一档直接写清是哪个入口写的：两行时间一样、类别不同的
                    候选，多半是同一段在两个入口各写了一遍，看不出来源就只能猜 */}
                <Tag color={REASON_COLOR[c.reason] ?? "orange"}>
                  {c.reason === "similar" ? SRC_CN[srcOf(c)] ?? REASON_LABEL.similar : REASON_LABEL[c.reason] ?? c.reason}
                </Tag>
                {/* 不是抓挠的候选要看得出是哪类——列表里混着两种，光看时间分不出 */}
                {c.label_name !== "抓挠" && (
                  <Tag color={findLabel(labels, c.label_name)?.color || undefined}>{currentName(c.label_name)}</Tag>
                )}
                {/* 两个模型各跑一遍时并排放着，得看得出哪条是谁给的 */}
                {c.model && (
                  <Tag style={{ marginRight: 0, fontSize: 11 }} title={c.model}>
                    {c.model.split(":")[1] ?? c.model}
                  </Tag>
                )}
                <BoundaryEditsTag edits={c.boundary_edits} />
              </Space>
            ),
          },
          {
            title: "置信度",
            width: 72,
            sorter: (a: AiCandidate, b: AiCandidate) => (a.confidence ?? 0) - (b.confidence ?? 0),
            render: (_, c: AiCandidate) => (c.confidence != null ? `${Math.round(c.confidence * 100)}%` : "—"),
          },
          {
            // 画面候选的「依据」：模型看到了什么 + 为什么这么判。
            // 光看「舔身体 62%」还得点开视频才知道对不对；有了这一句，
            // 「一只狗趴在地毯上」这种一眼就能排掉，不用播。IMU 来的候选没有这一列的值
            title: "模型看到了什么",
            width: 160,
            render: (_, c: AiCandidate) =>
              c.evidence ? (
                <Tooltip title={c.evidence}>
                  {isSpecial(c.reason) && (() => {
                    // 专项片段的背景：普通 / 任务已通过 / 跟已有片段重叠（那条现在什么状态）/ 两样都是
                    const k = spotKindOf(c.evidence);
                    const st = spotOverlapState(c.evidence);
                    return (
                      <Tag color={SPOT_KIND[k].color} style={{ marginRight: 0, marginBottom: 2 }}>
                        {SPOT_KIND[k].short}{st ? `·那条${st}` : ""}
                      </Tag>
                    );
                  })()}
                  <span style={{ fontSize: 12, color: "var(--sl-text2)", display: "block",
                                 overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.evidence}
                  </span>
                </Tooltip>
              ) : (
                <span style={{ color: "#bfbfbf" }}>—</span>
              ),
          },
          {
            title: "频谱",
            width: 64,
            sorter: (a: AiCandidate, b: AiCandidate) => (a.spec ?? 0) - (b.spec ?? 0),
            render: (_, c: AiCandidate) => (
              <Tooltip title="陀螺仪 4–8Hz 能量占比；抓挠是后腿高频往复，这个值越高越像">
                <span>{c.spec != null ? c.spec.toFixed(2) : "—"}</span>
              </Tooltip>
            ),
          },
          {
            title: "状态",
            width: 96,
            render: (_, c: AiCandidate) => (
              <>
              {c.review_note && (
                <Tooltip title={`审核标的问题：${c.review_note}。重新判断这一条（确认 / 改类别 / 排除 / 待定，或先撤回）就算处理过`}>
                  <Tag color="red" style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "middle" }}>
                    有问题：{c.review_note}
                  </Tag>
                </Tooltip>
              )}
              {/* 改成别的类别的要写清楚改成了什么，不然「已确认」看着像确认成抓挠了 */}
              {c.status === "confirmed" ? (
                (() => {
                  const picked = labels.find((l) => l.id === c.decided_label_id);
                  // 同一类的部位（抓挠 → 抓挠-头颈耳）是确认，不是改成别的
                  if (picked && sameKind(c.label_name, picked.display_name)) {
                    const part = picked.display_name.slice(currentName(c.label_name).length + 1);
                    return <Tag color="green">已确认{part ? `·${part}` : ""}</Tag>;
                  }
                  return picked ? <Tag color="blue">已改成 {picked.display_name}</Tag> : <Tag color="green">已确认</Tag>;
                })()
              ) :
              c.status === "rejected" ? (
                <Tag>已排除</Tag>
              ) : c.status === "uncertain" ? (
                (() => {
                  const k = UNCERTAIN_KINDS.find((x) => x.value === c.uncertain_reason);
                  return (
                    <Tooltip title={`${k?.label ?? "拿不准"}；不进训练集，也不算抓挠`}>
                      <Tag color="purple">{k ? `待定·${k.short}` : "待定"}</Tag>
                    </Tooltip>
                  );
                })()
              ) : (
                <Tag color="gold">待确认</Tag>
              )}
              </>
            ),
          },
          {
            title: "操作",
            render: (_, c: AiCandidate) => (
              <Space size={0} wrap>
                <Button size="small" type="link" onClick={() => onSeek(c.start_time_ms)}>
                  跳转
                </Button>
                {/* 第一阶段找到一条之后，扩样本的入口就该在这一条身上。
                    原来只有顶上一个「找相似」，用的是**视频当前播到哪**——人得先跳转、
                    再等它播到对的地方、再点，中间任何一步错了样例就取错了 */}
                {onFindSimilar && (
                  <Tooltip title="拿这一条中间那一帧当样例，在整个项目里找长得像的几秒。类别也一起带过去">
                    <Button size="small" type="link" icon={<SearchOutlined />}
                      onClick={() => onFindSimilar(Math.round((c.start_time_ms + c.end_time_ms) / 200) / 10, c.label_name)}>
                      用它去扩
                    </Button>
                  </Tooltip>
                )}
                {onLoop &&
                  (isLooping(c) ? (
                    <>
                      {onTogglePlay && (
                        <Tooltip title="暂停 / 继续，循环还在这一段上（空格键也行）。想细看用哪一帧去检索：暂停后 ← → 逐帧">
                          <Button size="small" type="link" icon={<PauseCircleOutlined />} onClick={onTogglePlay}>
                            暂停/继续
                          </Button>
                        </Tooltip>
                      )}
                      <Tooltip title="取消这一段的循环并停下">
                        <Button size="small" type="link" danger icon={<RetweetOutlined />} onClick={() => onLoop(null)}>
                          停止循环
                        </Button>
                      </Tooltip>
                    </>
                  ) : (
                    <Button
                      size="small"
                      type="link"
                      icon={<RetweetOutlined />}
                      onClick={() => onLoop({ startMs: c.start_time_ms, endMs: c.end_time_ms })}
                    >
                      循环播放
                    </Button>
                  ))}
                {isSpecial(c.reason) && c.status === "pending" && getCurrentMs && (
                  <Tooltip title="这一段里混着几个动作（抓一会、歇一会、又抓、甩身体）：把视频播到动作换了的地方，点这里切成前后两段，各自去判。可以连着切几刀">
                    <Button size="small" type="link" loading={busy === c.id} onClick={() => split(c)}>
                      在这切开
                    </Button>
                  </Tooltip>
                )}
                {(!readOnly || isSpecial(c.reason)) && c.status === "pending" && (
                  <>
                    <Button size="small" type="link" loading={busy === c.id} onClick={() => decide(c, "confirmed")}>
                      确认是{currentName(c.label_name)}
                    </Button>
                    {/* 这一条候选那个标签底下的部位，直接摆出来一键点。
                        「改成别的」是上百项的下拉（22 类各带部位），复核一条要在里面翻——
                        而补部位数据集时要做的就是「看一眼视频 → 点部位 → 下一条」这一个动作，
                        重复几百遍。2026-09-20：画面自动判部位这条路验完走不通（几何 1/6、
                        人也有 45% 判不了），部位这一级确定要靠人，那就让人点得快。 */}
                    {partsOf(c.label_name).map((l) => (
                      <Tooltip key={l.id} title={`确认成「${l.display_name}」`}>
                        <Tag
                          color={l.color || "default"}
                          style={{ cursor: busy === c.id ? "wait" : "pointer", marginRight: 2 }}
                          onClick={() => busy !== c.id && decide(c, "confirmed", l.id, l.display_name)}
                        >
                          {/* 只显示部位那一截：标签名是「舔身体-后左爪」，前缀每条都一样，
                              占地方又帮不上忙 */}
                          {l.display_name.startsWith(currentName(c.label_name) + "-")
                            ? l.display_name.slice(currentName(c.label_name).length + 1)
                            : l.display_name}
                        </Tag>
                      </Tooltip>
                    ))}
                    {lastLabel && (
                      <Tooltip title={`上一条改成的是「${lastLabel.display_name}」，这条一样就直接点`}>
                        <Button size="small" type="link" loading={busy === c.id} onClick={() => relabel(c, lastLabel)}>
                          改成 {labelTag(lastLabel)}
                        </Button>
                      </Tooltip>
                    )}
                    {otherLabels.length > 0 && (
                      <Dropdown
                        menu={{
                          // 只摆大类，鼠标移上去再展开小类；大类本身在子菜单第一项「就是 X」
                          items: relabelItems(null),
                          onClick: ({ key }) => {
                            const l = otherLabels.find((x) => String(x.id) === key);
                            if (l) relabel(c, l);
                          },
                        }}
                      >
                        <Button size="small" type="link" loading={busy === c.id}>
                          改成别的 <DownOutlined style={{ fontSize: 10 }} />
                        </Button>
                      </Dropdown>
                    )}
                    {/* 跟正式片段那边一样的两种待定：看了拿不准的，既不确认也不
                        排除，那段时间从训练集里挖掉 */}
                    <Dropdown
                      menu={{
                        items: UNCERTAIN_KINDS.map((k) => ({ key: k.value, label: k.label })),
                        onClick: ({ key }) => decide(c, "uncertain", undefined, undefined, key),
                      }}
                    >
                      <Button size="small" type="link" loading={busy === c.id}>
                        待定 <DownOutlined style={{ fontSize: 10 }} />
                      </Button>
                    </Dropdown>
                    <Popconfirm title="排除这一段？" onConfirm={() => decide(c, "rejected")}>
                      <Button size="small" type="link" danger loading={busy === c.id}>
                        排除
                      </Button>
                    </Popconfirm>
                  </>
                )}
                {/* 审核：这一条判断不对就标出来，退回时标注员只需要重判这几条 */}
                {onReviewNote && (c.review_note ? (
                  <Button size="small" type="link" style={{ color: "#999" }} onClick={() => onReviewNote(c, null)}>
                    {reviewNoteClearOnly ? "已改好" : "清除问题"}
                  </Button>
                ) : !reviewNoteClearOnly && (
                  <Dropdown
                    menu={{
                      items: [...CAND_NOTE_PRESETS.map((t) => ({ key: t, label: t })), { key: "__other", label: "其他原因…" }],
                      onClick: ({ key }) => {
                        if (key === "__other") { setNoteFor(c); setNoteText(""); }
                        else onReviewNote(c, key);
                      },
                    }}
                  >
                    <Button size="small" type="link" danger>
                      有问题 <DownOutlined style={{ fontSize: 10 }} />
                    </Button>
                  </Dropdown>
                ))}
                {(!readOnly || isSpecial(c.reason)) && c.status !== "pending" && onUndo && (
                  <Popconfirm
                    title="撤回这次判断？"
                    description={
                      isSpecial(c.reason)
                        ? "这一段会回到「待确认」，重新判断（专项不碰任务标注）"
                        : c.status === "confirmed"
                        ? "这一段会回到「待确认」，之前带到「已标注片段」的那条也一起收回"
                        : "这一段会回到「待确认」，重新判断"
                    }
                    onConfirm={() => undo(c)}
                  >
                    <Button size="small" type="link" loading={busy === c.id}>
                      撤回
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title="这条判断有什么问题？"
        open={noteFor != null}
        okText="标为有问题"
        okButtonProps={{ disabled: !noteText.trim() }}
        onOk={() => { if (noteFor && onReviewNote) onReviewNote(noteFor, noteText.trim()); setNoteFor(null); }}
        onCancel={() => setNoteFor(null)}
        destroyOnClose
      >
        <Input.TextArea
          autoFocus
          maxLength={300}
          rows={3}
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="写给标注员看的一句话，比如：其实是在舔后腿，不是活动"
        />
      </Modal>
    </div>
  );
}
