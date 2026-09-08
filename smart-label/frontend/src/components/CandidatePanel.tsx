import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Dropdown, Empty, Popconfirm, Radio, Space, Table, Tag, Tooltip, message } from "antd";
import { DownOutlined, QuestionCircleOutlined, RetweetOutlined } from "@ant-design/icons";
import { decideCandidate, type AiCandidate } from "@/api/candidates";
import { formatMs } from "@/components/SegmentPanel";

/**
 * 疑似抓挠候选面板：正式片段（稳定版）为了准会滤掉一部分真抓挠，这里是低门槛
 * 再抽一遍的结果。人工点「跳转」或「循环」看两秒视频，确认就变成一条正式的人工
 * 片段，排除就记一笔——两种决定都是重训模型最有价值的数据。
 */

const REASON_LABEL: Record<AiCandidate["reason"], string> = {
  low_conf: "模型低置信",
  spectral: "频谱像抓挠",
};

interface Props {
  candidates: AiCandidate[];
  readOnly?: boolean;
  onSeek: (ms: number) => void;
  onLoop?: (range: { startMs: number; endMs: number } | null) => void;
  loopRange?: { startMs: number; endMs: number } | null;
  /** 确认/排除之后刷新列表；确认时还要把新片段拉进草稿，所以一并重载草稿 */
  onDecided: (c: AiCandidate, decision: AiCandidate["status"]) => void;
  /** 项目里的标签，给「改成别的类别」用（带颜色，跟已标注片段那边的选择器一致） */
  labels?: { id: number; display_name: string; color?: string | null }[];
  /** 「抓挠」在这个项目里的标签 id，下拉里要把它排掉（那是「确认是抓挠」干的事） */
  scratchLabelIds?: number[];
  /** 撤回已经做过的判断，回到「待确认」。确认过的还要把带上去的那条片段一起收回 */
  onUndo?: (c: AiCandidate) => Promise<void>;
  /**
   * 筛选/分页这排控件渲染到哪儿。给了就 portal 到折叠面板的标题行上，
   * 跟「疑似抓挠（17 待确认 / 17）」拼一行——工作台里高度是最紧的资源，
   * 一排筛选、一排说明、一排分页三行下来，能看的片段就剩四五条
   */
  controlsPortalTarget?: HTMLElement | null;
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
  onDecided,
  labels = [],
  scratchLabelIds = [],
  onUndo,
  controlsPortalTarget,
}: Props) {
  const [filter, setFilter] = useState<"pending" | "all">("pending");
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

  const rows = useMemo(
    () => candidates.filter((c) => (filter === "all" ? true : c.status === "pending" || justDecided.has(c.id))),
    [candidates, filter, justDecided]
  );


  const decide = async (
    c: AiCandidate,
    decision: AiCandidate["status"],
    labelId?: number,
    labelName?: string,
    uncertainReason?: string
  ) => {
    setBusy(c.id);
    try {
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
          { label: `全部 ${candidates.length}`, value: "all" },
        ]}
      />
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
        pagination={false}
        // 只留横向滚动：给了 y 之后表格自己会出一条纵向滚动条，跟外面那条
        // 套在一起——鼠标在表格里滚的是里面那条，想滚整页还得把鼠标挪出去。
        // 一页就十条，让它整个铺开，纵向交给外层那一条
        scroll={{ x: 720 }}
        locale={{
          emptyText: candidates.length ? (
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
            width: 130,
            render: (_, c: AiCandidate) => (
              <Tag color={c.reason === "spectral" ? "purple" : "orange"}>{REASON_LABEL[c.reason]}</Tag>
            ),
          },
          {
            title: "置信度",
            width: 90,
            sorter: (a: AiCandidate, b: AiCandidate) => (a.confidence ?? 0) - (b.confidence ?? 0),
            render: (_, c: AiCandidate) => (c.confidence != null ? `${Math.round(c.confidence * 100)}%` : "—"),
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
                    <Button size="small" type="link" danger icon={<RetweetOutlined />} onClick={() => onLoop(null)}>
                      停止
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      type="link"
                      icon={<RetweetOutlined />}
                      onClick={() => onLoop({ startMs: c.start_time_ms, endMs: c.end_time_ms })}
                    >
                      循环
                    </Button>
                  ))}
                {!readOnly && c.status === "pending" && (
                  <>
                    <Button size="small" type="link" loading={busy === c.id} onClick={() => decide(c, "confirmed")}>
                      确认是抓挠
                    </Button>
                    {otherLabels.length > 0 && (
                      <Dropdown
                        menu={{
                          // 跟「已标注片段」那边的标签选择器一样带颜色，扫一眼就能对上
                          items: otherLabels.map((l) => ({
                            key: String(l.id),
                            label: (
                              <Tag color={l.color || undefined} style={{ marginRight: 0 }}>
                                {l.display_name}
                              </Tag>
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
