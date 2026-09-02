import { useState } from "react";
import { Button, Input, Modal, Space, Table, Tag, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { claimReview, decideReview, reviewQueue } from "@/api/reviews";
import { listLabels } from "@/api/labels";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import { useAuthStore } from "@/stores/authStore";
import type { Task } from "@/types";

export default function Reviews() {
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.userInfo?.id);
  const { data, isLoading } = useQuery({ queryKey: ["review-queue"], queryFn: reviewQueue });
  const { data: labels } = useQuery({ queryKey: ["labels"], queryFn: () => listLabels() });

  const [rejectTaskId, setRejectTaskId] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [viewTask, setViewTask] = useState<Task | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["review-queue"] });

  const handleClaim = async (id: number) => {
    await claimReview(id);
    message.success("已认领待审核");
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
          { title: "样本ID", dataIndex: "sample_id" },
          { title: "轮次", dataIndex: "round_no" },
          { title: "标注员ID", dataIndex: "assigned_to" },
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
