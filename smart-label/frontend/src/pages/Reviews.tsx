import { useState } from "react";
import { Button, Input, Modal, Space, Table, Tag, Tooltip, message } from "antd";
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
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data}
        columns={[
          { title: "任务ID", dataIndex: "id", width: 80 },
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
            render: (v: string | null) => (v ? v.replace("T", " ").slice(0, 16) : "-"),
          },
          {
            title: <Tooltip title="从这一轮第一次保存草稿到提交。中途去吃饭的会虚高">用时</Tooltip>,
            dataIndex: "work_seconds",
            width: 90,
            sorter: (a: Task, b: Task) => (a.work_seconds ?? -1) - (b.work_seconds ?? -1),
            render: (s: number | null) => (s == null ? "-" : s < 60 ? `${s} 秒` : `${Math.round(s / 60)} 分`),
          },
          { title: "片段", dataIndex: "item_count", width: 60, render: (n: number | null) => n ?? "-" },
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
