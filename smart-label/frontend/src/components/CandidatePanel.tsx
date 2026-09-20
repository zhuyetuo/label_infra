import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Dropdown, Empty, Popconfirm, Radio, Select, Space, Table, Tag, Tooltip, message } from "antd";
import { DeleteOutlined, DownOutlined, PauseCircleOutlined, QuestionCircleOutlined, RetweetOutlined, SearchOutlined } from "@ant-design/icons";
import { clearSimilarCandidates, decideCandidate, type AiCandidate } from "@/api/candidates";
import { formatMs } from "@/components/SegmentPanel";
import { flatten } from "@/utils/labelTree";

/**
 * 疑似抓挠候选面板：正式片段（稳定版）为了准会滤掉一部分真抓挠，这里是低门槛
 * 再抽一遍的结果。人工点「跳转」或「循环」看两秒视频，确认就变成一条正式的人工
 * 片段，排除就记一笔——两种决定都是重训模型最有价值的数据。
 */

const REASON_LABEL: Record<AiCandidate["reason"], string> = {
  low_conf: "模型低置信",
  spectral: "频谱像抓挠",
  // 只靠加速度姿态挑出来的：头伸到某个部位并保持住。给「舔/啃哪个部位」攒标注用，
  // 人只看这几段，不用翻 24 小时视频
  grooming: "姿态像舔/啃",
  // 视觉大模型看视频挑出来的：画面里狗在做这个动作。类别是项目里选的那几类（含部位）
  vision: "画面看像",
  // 画面向量索引：拿一帧样例（或一句话）在整个项目里找长得像的几秒。不问大模型，免费
  similar: "画面相似",
};

const REASON_COLOR: Record<AiCandidate["reason"], string> = {
  low_conf: "orange",
  spectral: "purple",
  grooming: "cyan",
  vision: "magenta",
  similar: "geekblue",
};

interface Props {
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
   * 跟「疑似抓挠（17 待确认 / 17）」拼一行——工作台里高度是最紧的资源，
   * 一排筛选、一排说明、一排分页三行下来，能看的片段就剩四五条
   */
  controlsPortalTarget?: HTMLElement | null;
  /** 「找相似」：拿当前画面（或一句话）在项目里找长得像的几秒。没建索引时不给 */
  onFindSimilar?: () => void;
  /** 从找相似的结果/链接跳进来：起点是这个毫秒的那条排最前并高亮 */
  focusMs?: number | null;
  /** 打开时先筛哪一档（从找相似的链接进来默认只看「画面相似」） */
  initialFilter?: "pending" | "all" | "similar";
  /** 清掉全部还没判过的「画面相似」候选；返回删了几条。给了才显示按钮 */
  onClearSimilar?: () => Promise<number>;
}

// 跟正式片段上的「待定」同一套三种：没画面的除非补拍否则永远定不了（可以直接
// 跳过）、看不清的换个人/换个视角也许还能定（值得再看）、要细切的是已经确定
// 是抓挠、只是起止要调，纯排期问题。每处都写明是哪一种，不然得逐条点开才知道
const UNCERTAIN_KINDS = [
  { value: "no_view", short: "没画面", label: "画面里没拍到狗" },
  { value: "ambiguous", short: "看不清", label: "拍到了但看不准" },
  { value: "needs_split", short: "要细切", label: "是抓挠，但起止要调 / 要拆细" },
] as const;

export default function CandidatePanel({
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
}: Props) {
  const [filter, setFilter] = useState<"pending" | "all" | "similar">(initialFilter ?? "pending");
  useEffect(() => {
    if (initialFilter) setFilter(initialFilter);
  }, [initialFilter]);
  const similarCount = candidates.filter((c) => c.reason === "similar" && c.status === "pending").length;
  // 只看某一类：找相似 / 找片段常常一次落好几个类别，混在一起没法逐类核对
  const [labelFilter, setLabelFilter] = useState<string[]>([]);
  const labelCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of candidates) m.set(c.label_name, (m.get(c.label_name) ?? 0) + 1);
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
    if (pendingCount === 0 && candidates.length > 0) setFilter("all");
  }, [pendingCount, candidates.length]);

  // 从找相似的链接进来带的是 ?cand=similar，但那个任务的候选可能一条「画面相似」
  // 都没有（是 AI 预标注 / 画面找片段落下的）。这时「画面相似」那个档根本不渲染，
  // 于是筛选框看着一个都没选中、表格空着，标题上却写着「4 待确认」——
  // 只会让人以为是坏了。选不到的档就别停在那儿，退回「待确认」。
  useEffect(() => {
    if (filter === "similar" && similarCount === 0 && candidates.length > 0) setFilter("pending");
  }, [filter, similarCount, candidates.length]);

  const rows = useMemo(() => {
    let list = candidates.filter((c) =>
      filter === "all"
        ? true
        : filter === "similar"
          ? c.reason === "similar" && (c.status === "pending" || justDecided.has(c.id))
          : c.status === "pending" || justDecided.has(c.id)
    );
    if (labelFilter.length) list = list.filter((c) => labelFilter.includes(c.label_name));
    // 从找相似/链接跳进来的那条排最前，人一眼就知道"是这段"
    if (focusMs != null) {
      const hit = (c: AiCandidate) => Math.abs(c.start_time_ms - focusMs) < 1500;
      list = [...list.filter(hit), ...list.filter((c) => !hit(c))];
    }
    return list;
  }, [candidates, filter, labelFilter, justDecided, focusMs]);
  const isFocus = (c: AiCandidate) => focusMs != null && Math.abs(c.start_time_ms - focusMs) < 1500;


  const decide = async (
    c: AiCandidate,
    decision: AiCandidate["status"],
    labelId?: number,
    labelName?: string,
    uncertainReason?: string
  ) => {
    setBusy(c.id);
    try {
      await onBeforeDecide?.();
      await decideCandidate(c.id, decision, labelId, uncertainReason);
      message.success(
        decision === "rejected"
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
  /** 某个标签底下的直接子部位。按 parent_id 找，找不到再按「父名-」前缀兜底
   *  （老项目里的标签可能没挂 parent_id，那时候层级只体现在名字上）。 */
  const partsOf = (name: string) => {
    const parent = labels.find((l) => l.display_name === name);
    const kids = parent ? labels.filter((l) => l.parent_id === parent.id) : [];
    if (kids.length) return kids;
    return labels.filter((l) => l.display_name.startsWith(name + "-")
                                && !l.display_name.slice(name.length + 1).includes("-"));
  };

  // 点错了、或者看完视频改主意了，得能退回去重判——不然只能去「已标注片段」
  // 那边找到对应的条目再退回候选，绕一大圈；排除/待定的更是根本没有入口
  const undo = async (c: AiCandidate) => {
    if (!onUndo) return;
    setBusy(c.id);
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
          ...(similarCount > 0 ? [{ label: `画面相似 ${similarCount}`, value: "similar" }] : []),
          { label: `全部 ${candidates.length}`, value: "all" },
        ]}
      />
      {labelCounts.length > 1 && (
        <Tooltip title="只看某几类。找相似 / 找片段一次会落好几个类别，混在一起没法逐类核对">
          <Select
            size="small"
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            placeholder="只看类别"
            style={{ minWidth: 150, maxWidth: 320 }}
            value={labelFilter}
            onChange={setLabelFilter}
            options={labelCounts.map(([name, n]) => ({
              value: name,
              label: (
                <span>
                  <Tag color={labels.find((l) => l.display_name === name)?.color || undefined} style={{ marginRight: 4 }}>{name}</Tag>
                  <span style={{ color: "#999", fontSize: 12 }}>{n}</span>
                </span>
              ),
            }))}
          />
        </Tooltip>
      )}
      {onFindSimilar && (
        <Tooltip title="拿视频当前这一帧（比如正在舔尾巴）在整个项目里找长得像的几秒，写成候选。靠画面向量索引，不问大模型、不花钱">
          <Button size="small" icon={<SearchOutlined />} onClick={onFindSimilar}>
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
            正式片段之外、模型可能漏掉的抓挠。看一眼视频：
            <br />
            是抓挠就「确认是抓挠」；
            <br />
            其实是别的动作就「改成别的」——比单纯排除有用，等于给了那个类别一个正例，
            同时是抓挠最缺的难负样本；
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
        onRow={(c: AiCandidate) => (isFocus(c) ? { style: { background: "#e6f4ff" } } : {})}
        pagination={false}
        // 只留横向滚动：给了 y 之后表格自己会出一条纵向滚动条，跟外面那条
        // 套在一起——鼠标在表格里滚的是里面那条，想滚整页还得把鼠标挪出去。
        // 一页就十条，让它整个铺开，纵向交给外层那一条
        scroll={{ x: 720 }}
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
                  {labelFilter.length ? `「只看类别：${labelFilter.join("、")}」` : ""}
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
            width: 190,
            render: (_, c: AiCandidate) => `${formatMs(c.start_time_ms)} ~ ${formatMs(c.end_time_ms)}`,
          },
          {
            title: "时长",
            width: 80,
            sorter: (a: AiCandidate, b: AiCandidate) =>
              a.end_time_ms - a.start_time_ms - (b.end_time_ms - b.start_time_ms),
            render: (_, c: AiCandidate) => `${((c.end_time_ms - c.start_time_ms) / 1000).toFixed(1)}s`,
          },
          {
            title: "线索",
            width: 150,
            render: (_, c: AiCandidate) => (
              <Space size={2}>
                <Tag color={REASON_COLOR[c.reason] ?? "orange"}>{REASON_LABEL[c.reason] ?? c.reason}</Tag>
                {/* 不是抓挠的候选要看得出是哪类——列表里混着两种，光看时间分不出 */}
                {c.label_name !== "抓挠" && <Tag>{c.label_name}</Tag>}
                {/* 两个模型各跑一遍时并排放着，得看得出哪条是谁给的 */}
                {c.model && (
                  <Tag style={{ marginRight: 0, fontSize: 11 }} title={c.model}>
                    {c.model.split(":")[1] ?? c.model}
                  </Tag>
                )}
              </Space>
            ),
          },
          {
            title: "置信度",
            width: 90,
            sorter: (a: AiCandidate, b: AiCandidate) => (a.confidence ?? 0) - (b.confidence ?? 0),
            render: (_, c: AiCandidate) => (c.confidence != null ? `${Math.round(c.confidence * 100)}%` : "—"),
          },
          {
            // 画面候选的「依据」：模型看到了什么 + 为什么这么判。
            // 光看「舔身体 62%」还得点开视频才知道对不对；有了这一句，
            // 「一只狗趴在地毯上」这种一眼就能排掉，不用播。IMU 来的候选没有这一列的值
            title: "模型看到了什么",
            width: 200,
            render: (_, c: AiCandidate) =>
              c.evidence ? (
                <Tooltip title={c.evidence}>
                  <span style={{ fontSize: 12, color: "#595959", display: "block",
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
            width: 80,
            sorter: (a: AiCandidate, b: AiCandidate) => (a.spec ?? 0) - (b.spec ?? 0),
            render: (_, c: AiCandidate) => (
              <Tooltip title="陀螺仪 4–8Hz 能量占比；抓挠是后腿高频往复，这个值越高越像">
                <span>{c.spec != null ? c.spec.toFixed(2) : "—"}</span>
              </Tooltip>
            ),
          },
          {
            title: "状态",
            width: 130,
            render: (_, c: AiCandidate) =>
              // 改成别的类别的要写清楚改成了什么，不然「已确认」看着像确认成抓挠了
              c.status === "confirmed" ? (
                (() => {
                  const other = otherLabels.find((l) => l.id === c.decided_label_id);
                  return other ? <Tag color="blue">已改成 {other.display_name}</Tag> : <Tag color="green">已确认</Tag>;
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
              ),
          },
          {
            title: "操作",
            render: (_, c: AiCandidate) => (
              <Space size={0}>
                <Button size="small" type="link" onClick={() => onSeek(c.start_time_ms)}>
                  跳转
                </Button>
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
                {!readOnly && c.status === "pending" && (
                  <>
                    <Button size="small" type="link" loading={busy === c.id} onClick={() => decide(c, "confirmed")}>
                      确认是{c.label_name}
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
                          {l.display_name.startsWith(c.label_name + "-")
                            ? l.display_name.slice(c.label_name.length + 1)
                            : l.display_name}
                        </Tag>
                      </Tooltip>
                    ))}
                    {otherLabels.length > 0 && (
                      <Dropdown
                        menu={{
                          // 标签多了（四个大类各带部位）一屏放不下：限高，里面滚
                          style: { maxHeight: 380, overflowY: "auto" },
                          // 跟「已标注片段」那边的标签选择器一样带颜色，扫一眼就能对上
                          // 按层级排、子类缩进：舔 › 舔-前爪 › 舔-前左爪 挨着，扫一眼就能挑到最细的
                          items: flatten(otherLabels.map((l) => ({ ...l, parent_id: l.parent_id ?? null }))).map(({ label: l, depth }) => ({
                            key: String(l.id),
                            label: (
                              <span style={{ paddingLeft: depth * 12 }}>
                                {depth > 0 && <span style={{ color: "#bbb", marginRight: 4 }}>└</span>}
                                <Tag color={l.color || undefined} style={{ marginRight: 0 }}>
                                  {l.display_name}
                                </Tag>
                              </span>
                            ),
                          })),
                          onClick: ({ key }) => {
                            const l = otherLabels.find((x) => String(x.id) === key);
                            if (l) decide(c, "confirmed", l.id, l.display_name);
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
                {!readOnly && c.status !== "pending" && onUndo && (
                  <Popconfirm
                    title="撤回这次判断？"
                    description={
                      c.status === "confirmed"
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
    </div>
  );
}
