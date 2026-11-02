import { useMemo, useState } from "react";
import {
  Button,
  Collapse,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Modal,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import dayjs from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approvedSummary,
  bulkApprove,
  unapprove,
  claimReview,
  decideReview,
  releaseReview,
  reviewQueue,
} from "@/api/reviews";
import { listLabels } from "@/api/labels";
import { listProjectProgress, type ProjectProgress } from "@/api/dashboard";
import { currentName } from "@/utils/labelTree";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import DatasetStats from "@/components/DatasetStats";
import { useAuthStore } from "@/stores/authStore";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useUrlTask } from "@/utils/urlTask";
import { formatDuration, sampleDisplayName } from "@/utils/sampleName";
import type { Task } from "@/types";
import { candTitle } from "@/utils/candReason";
import { fmtSecs } from "@/utils/fmtDuration";

const fmtSec = (ms: number) => fmtSecs(ms / 1000);
import SegmentReview from "@/pages/SegmentReview";

/**
 * 审核页两个入口：按任务审（整份提交上来的任务，原来的流程）、按片段审（选一个类别
 * 跨所有项目一条条审）。用哪个记在 URL 的 ?tab= 里，刷新还在
 */
export default function Reviews() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "seg" ? "seg" : "task";
  return (
    <Tabs
      activeKey={tab}
      onChange={(k) => {
        const p = new URLSearchParams(params);
        if (k === "seg") p.set("tab", "seg");
        else p.delete("tab");
        // 换入口时把打开着的任务参数清掉：两边的 ?task= 不是一回事
        p.delete("task");
        setParams(p, { replace: true });
      }}
      items={[
        { key: "task", label: "按任务审核", children: <TaskReviews /> },
        { key: "seg", label: "片段审核（按类别逐条）", children: <SegmentReview /> },
      ]}
    />
  );
}

function TaskReviews() {
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.userInfo?.id);
  const role = useAuthStore((s) => s.userInfo?.role);
  const { data, isLoading } = useQuery({
    queryKey: ["review-queue"],
    queryFn: reviewQueue,
  });
  const { data: labels } = useQuery({
    queryKey: ["labels"],
    queryFn: () => listLabels(),
  });

  // 按类别筛：「seg:饮水」= 含饮水片段的任务，「cand:饮水」= 含疑似饮水候选的任务。
  // 筛了之后打开任务，工作台的片段列表 / 疑似片段面板也先只看这一类
  const [kind, setKind] = useState<string | null>(null);
  const kindType = kind?.split(":")[0] ?? null;
  const kindName = kind ? kind.slice(kind.indexOf(":") + 1) : null;
  const [minSec, setMinSec] = useState<number | null>(null);
  // 标签 id → 大类名：沿父链走到顶，再按「-」取前一截（没挂父类的「抓挠-头颈耳」也归抓挠），跟后端统计同一口径
  const catOf = useMemo(() => {
    const byId = new Map((labels ?? []).map((l) => [l.id, l]));
    const out = new Map<number, string>();
    for (const l of labels ?? []) {
      let cur = l;
      const seen = new Set<number>();
      while (cur.parent_id != null && byId.has(cur.parent_id) && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.parent_id)!;
      }
      out.set(l.id, cur.display_name.split("-")[0]);
    }
    return out;
  }, [labels]);
  const kindHits = (t: Task) => {
    if (!kindName) return { seg: 0, cand: 0, candPending: 0, maxMs: 0, ms: 0 };
    let seg = 0;
    let maxMs = 0;
    let ms = 0;
    for (const [id, c] of Object.entries(t.label_counts ?? {}))
      if (catOf.get(Number(id)) === kindName) {
        seg += c.n;
        maxMs = Math.max(maxMs, c.max_ms ?? 0);
        ms += c.ms ?? 0;
      }
    let cand = 0;
    let candPending = 0;
    for (const [n, c] of Object.entries(t.cand_labels ?? {}))
      if (currentName(n) === kindName || n === kindName) {
        cand += c.n;
        candPending += c.pending;
      }
    return { seg, cand, candPending, maxMs, ms };
  };
  const kindMatch = (t: Task) => {
    if (!kind) return true;
    const h = kindHits(t);
    if (kindType === "seg") return h.seg > 0 && (!minSec || h.maxMs >= minSec * 1000);
    return h.cand > 0;
  };
  const kindOptions = useMemo(() => {
    const seg = new Map<string, number>();
    const cand = new Map<string, number>();
    for (const t of data ?? []) {
      for (const [id, c] of Object.entries(t.label_counts ?? {})) {
        const k = catOf.get(Number(id));
        if (k && c.n) seg.set(k, (seg.get(k) ?? 0) + 1);
      }
      for (const [n, c] of Object.entries(t.cand_labels ?? {})) if (c.n) cand.set(currentName(n), (cand.get(currentName(n)) ?? 0) + 1);
    }
    return [
      { label: "片段", options: [...seg].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ value: `seg:${k}`, label: `${k}（${n} 个任务）` })) },
      { label: "疑似片段", options: [...cand].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ value: `cand:${k}`, label: `${candTitle(k)}（${n} 个任务）` })) },
    ];
  }, [data, catOf]);

  // 一天一个项目，按项目分组展示：外层一行一个项目（几个待审、抓挠几段、疑似待判几条），
  // 展开看任务。以前是平铺一张大表，标注员一天标好几个日期的话根本看不出哪天审完了
  type Group = {
    project_id: number;
    name: string;
    tasks: Task[];
    scratch: number;
    scratchPending: number;
    cand: number;
    candTotal: number;
  };
  const groups = useMemo<Group[]>(() => {
    const m = new Map<number, Group>();
    for (const t of data ?? []) {
      if (!kindMatch(t)) continue;
      let g = m.get(t.project_id);
      if (!g) {
        g = {
          project_id: t.project_id,
          name: t.project_name ?? String(t.project_id),
          tasks: [],
          scratch: 0,
          scratchPending: 0,
          cand: 0,
          candTotal: 0,
        };
        m.set(t.project_id, g);
      }
      g.tasks.push(t);
      g.scratch += t.scratch_items ?? 0;
      g.scratchPending += t.scratch_pending ?? 0;
      g.cand += t.cand_pending ?? 0;
      g.candTotal += t.cand_total ?? 0;
    }
    return [...m.values()].sort((a, b) => b.name.localeCompare(a.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, kind, catOf]);
  const [expanded, setExpanded] = useState<number[]>([]);
  // 整个项目还剩多少没做（不只是已提交的这些）：抓挠待确认、疑似待判、还没交的任务。
  // 审核队列只看得到交上来的，标注员手里那 200 多个任务里压着的待确认根本不在这里
  const { data: progress } = useQuery({ queryKey: ["project-progress"], queryFn: listProjectProgress, refetchInterval: 60_000 });
  const progressOf = useMemo(() => {
    const m = new Map<number, ProjectProgress>();
    for (const p of progress ?? []) m.set(p.project_id, p);
    return m;
  }, [progress]);
  const [rejectTaskId, setRejectTaskId] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [viewTask, setViewTask] = useState<Task | null>(null);
  // 刷新页面还能回到打开着的任务（?task=ID）
  useUrlTask(data, viewTask?.id ?? null, setViewTask);

  const refresh = () => qc.invalidateQueries({ queryKey: ["review-queue"] });

  // 超级管理员一键通过（没人审核的时候用）。通过后可用数据统计、项目进度都要刷新
  const isSuper = role === "super_admin";
  const handleBulkApprove = async (projectId?: number) => {
    const r = await bulkApprove(projectId);
    const why = [
      r.skipped_unconfirmed ? `${r.skipped_unconfirmed} 个还有 AI 片段没人确认` : "",
      r.skipped_cand_pending ? `${r.skipped_cand_pending} 个还有疑似没判` : "",
      r.skipped_locked ? `${r.skipped_locked} 个别的审核员正在审` : "",
    ].filter(Boolean);
    message.success(`已通过 ${r.approved} 个任务${why.length ? `；跳过：${why.join("，")}` : ""}`, 8);
    qc.invalidateQueries({ queryKey: ["approved-summary"] });
    refresh();
    qc.invalidateQueries({ queryKey: ["project-progress"] });
    qc.invalidateQueries({ queryKey: ["dataset-stats"] });
  };
  const bulkWarn =
    "只通过「人都看完了」的待审任务：每段 AI 片段都确认 / 改过（或标了待定）、疑似片段都判了。" +
    "还有没确认的片段、没判的疑似的跳过，标注中的任务本来就不在这里。" +
    "通过后发现有问题，可以在下面「已通过」里退回待审核（原样，不改轮次不动片段），或在项目页单个任务上退回。";

  // 已通过的：按项目看有多少、其中批量通过多少，可以整体退回待审核
  const { data: approved } = useQuery({
    queryKey: ["approved-summary"],
    queryFn: approvedSummary,
    enabled: role === "admin" || role === "super_admin",
  });
  const handleUnapprove = async (projectId?: number) => {
    const r = await unapprove({ projectId, onlyBulk: true });
    message.success(`已退回待审核 ${r.reverted} 个任务（原样）`);
    refresh();
    qc.invalidateQueries({ queryKey: ["approved-summary"] });
    qc.invalidateQueries({ queryKey: ["project-progress"] });
    qc.invalidateQueries({ queryKey: ["dataset-stats"] });
  };
  const bulkTotal = (approved ?? []).reduce((n, a) => n + a.bulk_approved, 0);

  const handleClaim = async (id: number) => {
    await claimReview(id);
    message.success("已认领待审核");
    refresh();
  };

  const handleReleaseReview = async (id: number) => {
    await releaseReview(id);
    message.success("已放弃认领，任务退回待审核队列");
    refresh();
  };

  const handleApprove = async (id: number) => {
    await decideReview(id, "approved");
    message.success("已通过");
    refresh();
  };

  const handleReject = async () => {
    if (rejectTaskId == null) return;
    await decideReview(rejectTaskId, "rejected", comment);
    message.success("已驳回，草稿已保留供重新标注");
    setRejectTaskId(null);
    setComment("");
    refresh();
  };

  const renderTasks = (tasks: Task[]) => (
    <Table
      rowKey="id"
      size="small"
      dataSource={tasks}
      pagination={
        tasks.length > 20 ? { pageSize: 20, showSizeChanger: false } : false
      }
      columns={[
        { title: "任务ID", dataIndex: "id", width: 80 },
        ...(kind
          ? [
              {
                title: kindType === "seg" ? kindName : candTitle(kindName ?? ""),
                width: kindType === "seg" ? 190 : 110,
                // 片段：按「最长一段」排，长片段往往更干净，先审先进数据池
                ...(kindType === "seg"
                  ? {
                      sorter: (a: Task, b: Task) => kindHits(a).maxMs - kindHits(b).maxMs,
                      defaultSortOrder: "descend" as const,
                    }
                  : {}),
                render: (_: unknown, t: Task) => {
                  const h = kindHits(t);
                  if (kindType !== "seg") return `${h.candPending} / ${h.cand} 待判`;
                  return (
                    <Tooltip title={`合计 ${fmtSec(h.ms)}`}>
                      {h.seg} 段{h.maxMs ? <Typography.Text type="secondary"> · 最长 {fmtSec(h.maxMs)}</Typography.Text> : null}
                    </Tooltip>
                  );
                },
              },
            ]
          : []),
        {
          title: "样本",
          dataIndex: "sample_id",
          render: (id: number, task: Task) =>
            task.sample_code
              ? sampleDisplayName(
                  task.sample_code,
                  task.video_duration_sec,
                  role,
                )
              : id,
        },
        {
          title: "总时长",
          width: 110,
          sorter: (a: Task, b: Task) =>
            (a.video_duration_sec ?? 0) - (b.video_duration_sec ?? 0),
          render: (_: unknown, task: Task) =>
            formatDuration(task.video_duration_sec),
        },
        { title: "轮次", dataIndex: "round_no", width: 60 },
        {
          title: "标注员",
          dataIndex: "assigned_to_name",
          render: (n: string | null, t: Task) => n ?? t.assigned_to ?? "-",
        },
        {
          title: "提交时间",
          dataIndex: "submitted_at",
          width: 150,
          sorter: (a: Task, b: Task) =>
            (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""),
          render: (v: string | null) =>
            v ? dayjs(v).format("MM-DD HH:mm") : "-",
        },
        {
          title: (
            <Tooltip title="从人第一次动手（加/改片段、判候选）到提交。中途去吃饭的会虚高">
              用时
            </Tooltip>
          ),
          dataIndex: "work_seconds",
          width: 90,
          sorter: (a: Task, b: Task) =>
            (a.work_seconds ?? -1) - (b.work_seconds ?? -1),
          render: (s: number | null) =>
            s == null ? "-" : s < 60 ? `${s} 秒` : `${Math.round(s / 60)} 分`,
        },
        {
          title: "片段",
          dataIndex: "item_count",
          width: 60,
          render: (n: number | null) => n ?? "-",
        },
        {
          title: (
            <Tooltip title="这一轮里抓挠类片段几段；括号里是 AI 给的还没人确认的——审核时重点看这些">
              抓挠
            </Tooltip>
          ),
          dataIndex: "scratch_items",
          width: 90,
          sorter: (a: Task, b: Task) =>
            (a.scratch_items ?? 0) - (b.scratch_items ?? 0),
          render: (n: number | null, t: Task) =>
            n ? (
              <span>
                <Tag color="red" style={{ marginInlineEnd: 4 }}>
                  {n}
                </Tag>
                {t.scratch_pending ? (
                  <span style={{ color: "#faad14" }}>
                    待确认 {t.scratch_pending}
                  </span>
                ) : null}
              </span>
            ) : (
              "-"
            ),
        },
        {
          title: <Tooltip title="疑似片段候选：还没判的 / 总共">疑似</Tooltip>,
          dataIndex: "cand_pending",
          width: 80,
          sorter: (a: Task, b: Task) =>
            (a.cand_pending ?? 0) - (b.cand_pending ?? 0),
          render: (p: number | null, t: Task) =>
            t.cand_total ? (
              <span style={{ color: p ? "#faad14" : undefined }}>
                {p ?? 0} / {t.cand_total}
              </span>
            ) : (
              "-"
            ),
        },
        {
          title: "审核占用",
          dataIndex: "reviewer_id",
          render: (r: number | null) =>
            r ? <Tag color="blue">已被认领</Tag> : <Tag>空闲</Tag>,
        },
        {
          title: "操作",
          render: (_, task: Task) => (
            <Space>
              <Button
                size="small"
                type="link"
                onClick={() => setViewTask(task)}
              >
                查看标注
              </Button>
              {task.reviewer_id == null && (
                <Button size="small" onClick={() => handleClaim(task.id)}>
                  认领审核
                </Button>
              )}
              {task.reviewer_id === userId && (
                <>
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => handleApprove(task.id)}
                  >
                    通过
                  </Button>
                  <Button
                    size="small"
                    danger
                    onClick={() => setRejectTaskId(task.id)}
                  >
                    驳回
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    onClick={() => handleReleaseReview(task.id)}
                  >
                    放弃认领
                  </Button>
                </>
              )}
            </Space>
          ),
        },
      ]}
    />
  );

  return (
    <div>
      <Collapse
        style={{ marginBottom: 12 }}
        items={[
          {
            key: "stats",
            label: "可用数据类别统计（审核通过的任务：各类别多少段、多长、占比，看类别均不均衡）",
            children: <DatasetStats />,
          },
          ...((approved ?? []).length
            ? [
                {
                  key: "approved",
                  label: `已通过（${(approved ?? []).reduce((n, a) => n + a.approved, 0)} 个任务，其中批量通过 ${bulkTotal} 个）——发现有问题可以退回待审核`,
                  children: (
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Space wrap>
                        <Popconfirm
                          title={`全部 ${bulkTotal} 个批量通过的任务退回待审核？`}
                          description="原样退回：轮次、片段、标注员都不变，只是从「已通过」回到「待审核」。逐条审过的不动。"
                          disabled={!bulkTotal}
                          onConfirm={() => handleUnapprove()}
                        >
                          <Button danger disabled={!bulkTotal}>
                            全部批量通过的退回待审核
                          </Button>
                        </Popconfirm>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          单个任务：项目页里展开项目，已通过的任务上点「退回待审核」
                        </Typography.Text>
                      </Space>
                      <Table
                        size="small"
                        rowKey="project_id"
                        pagination={false}
                        dataSource={approved}
                        columns={[
                          { title: "项目", dataIndex: "project_name", width: 160 },
                          { title: "已通过", dataIndex: "approved", width: 100 },
                          { title: "其中批量通过", dataIndex: "bulk_approved", width: 120 },
                          {
                            title: "操作",
                            render: (_, a) => (
                              <Popconfirm
                                title={`${a.project_name} 的 ${a.bulk_approved} 个批量通过的任务退回待审核？`}
                                description="原样退回，逐条审过的不动"
                                disabled={!a.bulk_approved}
                                onConfirm={() => handleUnapprove(a.project_id)}
                              >
                                <Button size="small" danger disabled={!a.bulk_approved}>
                                  退回待审核
                                </Button>
                              </Popconfirm>
                            ),
                          },
                        ]}
                      />
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />
      <Space style={{ marginBottom: 8, marginRight: 16 }} wrap>
        <Typography.Text type="secondary">按类别筛：</Typography.Text>
        <Select
          allowClear
          showSearch
          style={{ width: 240 }}
          placeholder="只看含某类别的待审任务（如 饮水）"
          value={kind ?? undefined}
          onChange={(v) => setKind(v ?? null)}
          options={kindOptions}
        />
        {kindType === "seg" && (
          <Tooltip title="只留最长一段不短于这么多秒的任务；表里按最长一段从长到短排">
            <InputNumber
              min={0}
              step={5}
              value={minSec}
              onChange={(v) => setMinSec(v ?? null)}
              placeholder="最长一段"
              addonAfter="秒以上"
              style={{ width: 150 }}
            />
          </Tooltip>
        )}
        {kind && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            打开任务时片段列表 / 疑似片段面板会先只显示这一类
          </Typography.Text>
        )}
      </Space>
      {isSuper && groups.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <Popconfirm
            title="所有项目的待审任务一键通过？"
            description={<div style={{ maxWidth: 360 }}>{bulkWarn}</div>}
            onConfirm={() => handleBulkApprove()}
          >
            <Button type="primary">全部一键通过</Button>
          </Popconfirm>
          <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            超级管理员才有；也可以在项目行里只通过那一个项目
          </Typography.Text>
        </div>
      )}
      <Table
        rowKey="project_id"
        loading={isLoading}
        dataSource={groups}
        pagination={false}
        size="small"
        expandable={{
          expandedRowKeys: expanded,
          onExpandedRowsChange: (keys) => setExpanded(keys.map(Number)),
          expandRowByClick: true,
          expandedRowRender: (g: Group) => renderTasks(g.tasks),
        }}
        columns={[
          {
            title: "项目",
            dataIndex: "name",
            width: 160,
            render: (n: string) => <b>{n}</b>,
          },
          {
            title: "待审任务",
            width: isSuper ? 170 : 100,
            render: (_, g: Group) => (
              <Space size={6}>
                {g.tasks.length}
                {isSuper && (
                  // 行是点击展开的，按钮上的点击别冒泡上去
                  <span onClick={(e) => e.stopPropagation()}>
                    <Popconfirm
                      title={`${g.name} 的待审任务一键通过？`}
                      description={<div style={{ maxWidth: 360 }}>{bulkWarn}</div>}
                      onConfirm={() => handleBulkApprove(g.project_id)}
                    >
                      <Button size="small">一键通过</Button>
                    </Popconfirm>
                  </span>
                )}
              </Space>
            ),
          },
          {
            title: (
              <Tooltip title="这些任务里抓挠类片段合计；括号里是 AI 给的还没人确认的">
                抓挠片段
              </Tooltip>
            ),
            width: 160,
            render: (_, g: Group) =>
              g.scratch ? (
                <span>
                  <Tag color="red" style={{ marginInlineEnd: 4 }}>
                    {g.scratch}
                  </Tag>
                  {g.scratchPending ? (
                    <span style={{ color: "#faad14" }}>
                      待确认 {g.scratchPending}
                    </span>
                  ) : (
                    <span style={{ color: "#52c41a" }}>都确认了</span>
                  )}
                </span>
              ) : (
                "-"
              ),
          },
          {
            title: (
              <Tooltip title="疑似片段候选：还没判的 / 总共">疑似片段</Tooltip>
            ),
            width: 120,
            render: (_, g: Group) =>
              g.candTotal ? (
                <span style={{ color: g.cand ? "#faad14" : "#52c41a" }}>
                  {g.cand} / {g.candTotal}
                </span>
              ) : (
                "-"
              ),
          },
          {
            title: <Tooltip title="整个项目（含标注员手里还没交的任务）：还有几个任务没交、抓挠片段还剩几段没确认、疑似片段还剩几条没判。三个都到 0 这一天才算做完">项目整体还剩</Tooltip>,
            render: (_, g: Group) => {
              const p = progressOf.get(g.project_id);
              if (!p) return "-";
              const left = p.tasks_total - p.tasks_submitted;
              const done = !left && !p.scratch_pending && !p.cand_pending;
              return done ? (
                <Tag color="green">全部完成</Tag>
              ) : (
                <Space size={4} wrap>
                  <Tag color={left ? "orange" : "green"}>未交任务 {left} / {p.tasks_total}</Tag>
                  <Tag color={p.scratch_pending ? "red" : "green"}>抓挠待确认 {p.scratch_pending} / {p.scratch_total}</Tag>
                  <Tag color={p.cand_pending ? "magenta" : "green"}>疑似待判 {p.cand_pending} / {p.cand_total}</Tag>
                </Space>
              );
            },
          },
          {
            title: (
              <Tooltip title="整个项目（含还没交的任务）每个大类标了多少：段数 · 总时长，鼠标移上去看人确认了几段、细分到哪些子类。灰色的是项目里有这个类别但一段都没有——比如舔一直是 0，就该让标注员去补">
                全部类别（整个项目）
              </Tooltip>
            ),
            width: 420,
            render: (_, g: Group) => (
              // 行是点击展开的，点标签跳转别连带展开
              <span onClick={(e) => e.stopPropagation()}>
                <CategoryOverview p={progressOf.get(g.project_id)} />
              </span>
            ),
          },
          {
            title: "标注员",
            render: (_, g: Group) =>
              [...new Set(g.tasks.map((t) => t.assigned_to_name ?? "-"))].join(
                "、",
              ),
          },
        ]}
      />
      {!isLoading && groups.length === 0 && (
        <Typography.Text type="secondary">没有待审核的任务</Typography.Text>
      )}

      <AnnotationWorkspace
        task={viewTask}
        labels={labels ?? []}
        // 按类别筛着进来的：片段列表 / 疑似片段面板先只看这一类
        focusLabelIds={
          kindType === "seg" && viewTask
            ? (labels ?? []).filter((l) => l.project_id === viewTask.project_id && catOf.get(l.id) === kindName).map((l) => l.id)
            : undefined
        }
        focusCandLabels={
          kindType === "cand" && viewTask
            ? Object.keys(viewTask.cand_labels ?? {}).filter((n) => currentName(n) === kindName || n === kindName)
            : undefined
        }
        readOnly
        onClose={() => setViewTask(null)}
        // 只有自己认领了的才给下结论的按钮，跟列表里的判断保持一致
        onApprove={
          viewTask && viewTask.reviewer_id === userId
            ? async () => {
                await handleApprove(viewTask.id);
                setViewTask(null);
              }
            : undefined
        }
        onReject={
          viewTask && viewTask.reviewer_id === userId
            ? () => {
                setRejectTaskId(viewTask.id);
                setViewTask(null);
              }
            : undefined
        }
      />

      <Modal
        title="驳回意见"
        open={rejectTaskId != null}
        onCancel={() => setRejectTaskId(null)}
        onOk={handleReject}
        destroyOnClose
      >
        <Input.TextArea
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="填写驳回原因，标注员重新认领后能看到"
        />
      </Modal>
    </div>
  );
}

const fmtDur = (sec: number) =>
  sec >= 3600 ? `${(sec / 3600).toFixed(1)}h` : sec >= 60 ? `${Math.round(sec / 60)}分` : `${Math.round(sec)}秒`;

/** 审核页一行项目的「全部类别」：有片段的按段数从多到少，没有的灰着列在后面，疑似片段按类别再一排 */
function CategoryOverview({ p }: { p: ProjectProgress | undefined }) {
  const navigate = useNavigate();
  if (!p?.categories) return <span>-</span>;
  // 点类别 → 项目页展开这个项目、按这一类筛好（含已通过的任务，不只是待审的），进任务就只看这一类
  const go = (q: string) => navigate(`/projects?project=${p.project_id}&${q}`);
  const has = p.categories.filter((c) => c.n > 0).sort((a, b) => b.n - a.n);
  const none = p.categories.filter((c) => c.n === 0);
  const cands = Object.entries(p.cand_labels ?? {}).filter(([, v]) => v.n > 0).sort(([, a], [, b]) => b.n - a.n);
  return (
    <Space size={[4, 4]} wrap>
      {has.map((c) => (
        <Tooltip
          key={c.name}
          title={
            <div style={{ lineHeight: 1.7 }}>
              {c.name}：{c.n} 段，共 {fmtDur(c.seconds)}，分布在 {c.tasks} 个任务里（点击去项目页只看这一类）
              <br />
              人确认 / 改过 / 自己加的 {c.confirmed} 段；AI 给的还没人看 {c.pending} 段
              {Object.keys(c.sub).length > 1 && (
                <>
                  <br />
                  {Object.entries(c.sub)
                    .sort(([, a], [, b]) => b - a)
                    .map(([k, v]) => `${k} ${v}`)
                    .join("，")}
                </>
              )}
            </div>
          }
        >
          <Tag color={c.color ?? undefined} style={{ marginInlineEnd: 0, cursor: "pointer" }}
               onClick={() => go(`label=${encodeURIComponent(c.name)}`)}>
            {c.name} {c.n}
            <span style={{ opacity: 0.75 }}> · {fmtDur(c.seconds)}</span>
          </Tag>
        </Tooltip>
      ))}
      {none.length > 0 && (
        <Tooltip title="项目里有这些类别，但整个项目一段都没标">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            没有：{none.map((c) => c.name).join("、")}
          </Typography.Text>
        </Tooltip>
      )}
      {cands.map(([name, v]) => (
        <Tooltip key={name} title={`${candTitle(currentName(name))} ${v.n} 条，还没判 ${v.pending} 条（点击去项目页只看这一类）`}>
          <Tag bordered style={{ marginInlineEnd: 0, borderStyle: "dashed", background: "transparent", cursor: "pointer" }}
               onClick={() => go(`cand=${encodeURIComponent(currentName(name))}`)}>
            {candTitle(currentName(name))} {v.pending}/{v.n}
          </Tag>
        </Tooltip>
      ))}
    </Space>
  );
}
