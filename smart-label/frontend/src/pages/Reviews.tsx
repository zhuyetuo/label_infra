import { useMemo, useState } from "react";
import { Button, Input, Modal, Select, Space, Table, Tag, Tooltip, message } from "antd";
import dayjs from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { claimReview, decideReview, releaseReview, reviewQueue } from "@/api/reviews";
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
  const { data, isLoading } = useQuery({ queryKey: ["review-queue"], queryFn: reviewQueue });
  const { data: labels } = useQuery({ queryKey: ["labels"], queryFn: () => listLabels() });

  // 按项目筛：一天一个项目，「9-23 的抓挠审完了没」就是看这个项目还剩几条
  const [projectFilter, setProjectFilter] = useState<number | undefined>();
  const projectOptions = useMemo(() => {
    const m = new Map<number, { name: string; n: number; scratch: number; cand: number }>();
    for (const t of data ?? []) {
      const cur = m.get(t.project_id) ?? { name: t.project_name ?? String(t.project_id), n: 0, scratch: 0, cand: 0 };
      cur.n += 1;
      cur.scratch += t.scratch_items ?? 0;
      cur.cand += t.cand_pending ?? 0;
      m.set(t.project_id, cur);
    }
    return [...m.entries()]
      .sort((a, b) => b[1].name.localeCompare(a[1].name))
      .map(([value, v]) => ({ value, label: `${v.name}（${v.n} 个待审 · 抓挠 ${v.scratch} 段 · 疑似待判 ${v.cand}）` }));
  }, [data]);
  const shown = useMemo(
    () => (projectFilter ? (data ?? []).filter((t) => t.project_id === projectFilter) : data ?? []),
    [data, projectFilter],
  );
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

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <span>项目</span>
        <Select
          allowClear
          placeholder={`全部（${data?.length ?? 0} 个待审）`}
          style={{ minWidth: 360 }}
          popupMatchSelectWidth={false}
          options={projectOptions}
          value={projectFilter}
          onChange={setProjectFilter}
        />
      </Space>
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={shown}
        columns={[
          { title: "任务ID", dataIndex: "id", width: 80 },
          {
            title: "项目",
            dataIndex: "project_name",
            width: 120,
            sorter: (a: Task, b: Task) => (a.project_name ?? "").localeCompare(b.project_name ?? ""),
            render: (n: string | null, t: Task) => n ?? t.project_id,
          },
          {
            title: "样本",
            dataIndex: "sample_id",
            render: (id: number, task: Task) =>
              task.sample_code ? sampleDisplayName(task.sample_code, task.video_duration_sec, role) : id,
          },
          {
            title: "总时长",
            width: 110,
            sorter: (a: Task, b: Task) => (a.video_duration_sec ?? 0) - (b.video_duration_sec ?? 0),
            render: (_: unknown, task: Task) => formatDuration(task.video_duration_sec),
          },
          { title: "轮次", dataIndex: "round_no", width: 60 },
          {
            title: "标注员",
            dataIndex: "assigned_to_name",
            render: (n: string | null, t: Task) => n ?? (t.assigned_to ?? "-"),
          },
          {
            title: "提交时间",
            dataIndex: "submitted_at",
            width: 150,
            sorter: (a: Task, b: Task) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""),
            render: (v: string | null) => (v ? dayjs(v).format("MM-DD HH:mm") : "-"),
          },
          {
            title: <Tooltip title="从人第一次动手（加/改片段、判候选）到提交。中途去吃饭的会虚高">用时</Tooltip>,
            dataIndex: "work_seconds",
            width: 90,
            sorter: (a: Task, b: Task) => (a.work_seconds ?? -1) - (b.work_seconds ?? -1),
            render: (s: number | null) => (s == null ? "-" : s < 60 ? `${s} 秒` : `${Math.round(s / 60)} 分`),
          },
          { title: "片段", dataIndex: "item_count", width: 60, render: (n: number | null) => n ?? "-" },
          {
            title: <Tooltip title="这一轮里抓挠类片段几段；括号里是 AI 给的还没人确认的——审核时重点看这些">抓挠</Tooltip>,
            dataIndex: "scratch_items",
            width: 90,
            sorter: (a: Task, b: Task) => (a.scratch_items ?? 0) - (b.scratch_items ?? 0),
            render: (n: number | null, t: Task) =>
              n ? (
                <span>
                  <Tag color="red" style={{ marginInlineEnd: 4 }}>{n}</Tag>
                  {t.scratch_pending ? <span style={{ color: "#faad14" }}>待确认 {t.scratch_pending}</span> : null}
                </span>
              ) : (
                "-"
              ),
          },
          {
            title: <Tooltip title="疑似抓挠候选：还没判的 / 总共">疑似</Tooltip>,
            dataIndex: "cand_pending",
            width: 80,
            sorter: (a: Task, b: Task) => (a.cand_pending ?? 0) - (b.cand_pending ?? 0),
            render: (p: number | null, t: Task) =>
              t.cand_total ? (
                <span style={{ color: p ? "#faad14" : undefined }}>{p ?? 0} / {t.cand_total}</span>
              ) : (
                "-"
              ),
          },
          {
            title: "审核占用",
            dataIndex: "reviewer_id",
            render: (r: number | null) => (r ? <Tag color="blue">已被认领</Tag> : <Tag>空闲</Tag>),
          },
          {
            title: "操作",
            render: (_, task: Task) => (
              <Space>
                <Button size="small" type="link" onClick={() => setViewTask(task)}>
                  查看标注
                </Button>
                {task.reviewer_id == null && (
                  <Button size="small" onClick={() => handleClaim(task.id)}>
                    认领审核
                  </Button>
                )}
                {task.reviewer_id === userId && (
                  <>
                    <Button size="small" type="primary" onClick={() => handleApprove(task.id)}>
                      通过
                    </Button>
                    <Button size="small" danger onClick={() => setRejectTaskId(task.id)}>
                      驳回
                    </Button>
                    <Button size="small" type="link" onClick={() => handleReleaseReview(task.id)}>
                      放弃认领
                    </Button>
                  </>
                )}
              </Space>
            ),
          },
        ]}
      />

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
