import { useMemo, useState } from "react";
import {
  Button,
  Input,
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
  claimReview,
  decideReview,
  releaseReview,
  reviewQueue,
} from "@/api/reviews";
import { listLabels } from "@/api/labels";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
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
  const [rejectTaskId, setRejectTaskId] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [viewTask, setViewTask] = useState<Task | null>(null);
  // 刷新页面还能回到打开着的任务（?task=ID）
  useUrlTask(data, viewTask?.id ?? null, setViewTask);

  const refresh = () => qc.invalidateQueries({ queryKey: ["review-queue"] });

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
          title: <Tooltip title="疑似抓挠候选：还没判的 / 总共">疑似</Tooltip>,
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
            width: 100,
            render: (_, g: Group) => g.tasks.length,
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
              <Tooltip title="疑似抓挠候选：还没判的 / 总共">疑似抓挠</Tooltip>
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
