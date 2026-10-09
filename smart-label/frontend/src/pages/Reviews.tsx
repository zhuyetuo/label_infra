import { useMemo, useState } from "react";
import {
  Button,
  Collapse,
  Input,
  Popconfirm,
  Modal,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import dayjs from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bulkApprove,
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
import { useUrlTask } from "@/utils/urlTask";
import { formatDuration, sampleDisplayName } from "@/utils/sampleName";
import type { Task } from "@/types";

export default function Reviews() {
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
  }, [data]);
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
    message.success(`已通过 ${r.approved} 个任务${r.skipped ? `；${r.skipped} 个别的审核员正在审，跳过了` : ""}`);
    refresh();
    qc.invalidateQueries({ queryKey: ["project-progress"] });
    qc.invalidateQueries({ queryKey: ["dataset-stats"] });
  };
  const bulkWarn =
    "一次性全部标为「已通过」，不逐条看。注意：通过的任务里没人看过的纯 AI 片段，导出训练集选「整份取：审核通过」时会一起带进去——" +
    "下面「可用数据类别统计」里切到「只算人确认过的」能看到差多少。通过后要改可以在任务上「退回重标」。";

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
        ]}
      />
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
            render: (_, g: Group) => <CategoryOverview p={progressOf.get(g.project_id)} />,
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
  if (!p?.categories) return <span>-</span>;
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
              {c.name}：{c.n} 段，共 {fmtDur(c.seconds)}，分布在 {c.tasks} 个任务里
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
          <Tag color={c.color ?? undefined} style={{ marginInlineEnd: 0 }}>
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
        <Tooltip key={name} title={`疑似${currentName(name)} ${v.n} 条，还没判 ${v.pending} 条`}>
          <Tag bordered style={{ marginInlineEnd: 0, borderStyle: "dashed", background: "transparent" }}>
            疑似{currentName(name)} {v.pending}/{v.n}
          </Tag>
        </Tooltip>
      ))}
    </Space>
  );
}
