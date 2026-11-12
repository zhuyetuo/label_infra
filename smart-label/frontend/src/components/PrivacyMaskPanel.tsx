import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Modal, Popconfirm, Progress, Select, Space, Switch, Typography, message } from "antd";
import { LockOutlined } from "@ant-design/icons";
import { getPrivacyMask, runPrivacyMask, togglePrivacyMask } from "@/api/projects";
import { PREVIEW_MASK_KEY } from "@/api/media";
import type { Project } from "@/types";

/**
 * 隐私遮罩（只有超级管理员看得到这个按钮）。
 *
 * 一键遮罩：项目里所有视频交给视觉服务生成「狗框以外全黑」的版本（后台排队，一小时的视频十来分钟）。
 * 开关：开了之后除超级管理员外的人只拿得到遮罩版——服务端强制，不是页面上盖一层。
 * 处理一次就够，之后随时开关，不用重做。
 */
export default function PrivacyMaskPanel({ project, onChanged }: { project: Project; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [pad, setPad] = useState(0.3);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const [preview, setPreview] = useState(() => {
    try { return localStorage.getItem(PREVIEW_MASK_KEY) === "1"; } catch { return false; }
  });
  const { data: st, refetch } = useQuery({
    queryKey: ["privacy-mask", project.id],
    queryFn: () => getPrivacyMask(project.id),
    enabled: open,
    refetchInterval: (q) => (q.state.data && (q.state.data.queued > 0 || q.state.data.running > 0) ? 5000 : false),
  });
  useEffect(() => { if (open) void refetch(); }, [open, refetch]);

  const allDone = !!st && st.total > 0 && st.done === st.total;
  const pct = st && st.total ? Math.floor((st.done / st.total) * 100) : 0;

  const run = async (force: boolean) => {
    setBusy(true);
    try {
      const r = await runPrivacyMask(project.id, { force, pad });
      message.success(`排进队列 ${r.queued} 个视频${r.skipped ? `，${r.skipped} 个已经做好 / 在排队，跳过` : ""}`);
      void refetch();
    } finally { setBusy(false); }
  };

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await togglePrivacyMask(project.id, on);
      message.success(on ? "隐私遮罩已开：标注员 / 审核员现在只看得到狗框里的画面" : "隐私遮罩已关：恢复原画面");
      void refetch();
      void qc.invalidateQueries({ queryKey: ["projects"] });
      onChanged?.();
    } finally { setBusy(false); }
  };

  return (
    <>
      <Button size="small" type="link" icon={<LockOutlined />} onClick={() => setOpen(true)}
        style={project.privacy_mask ? { color: "#52c41a" } : undefined}>
        隐私遮罩{project.privacy_mask ? "（开）" : ""}
      </Button>
      <Modal open={open} onCancel={() => setOpen(false)} footer={null} width={560} destroyOnClose
        title={<span><LockOutlined /> 隐私遮罩 · {project.name}</span>}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          自动把狗框出来（框放大一圈），狗框以外全黑，另存一份视频。开了之后<b>除超级管理员外</b>的人只拿得到这一份
          ——视频、夜视、缩略图都是，服务端强制。漏检时沿用上一次的框最多 3 秒，再找不到整帧全黑。
          处理一次就够，之后随时开关。
        </Typography.Paragraph>
        {st && !st.available && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`视觉服务不可用：${st.error ?? "未知原因"}`} />}
        {st?.service_error && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`查不到排队进度：${st.service_error}`} />}
        {st && (
          <>
            <Progress percent={pct} status={st.failed ? "exception" : allDone ? "success" : "active"} />
            <Space wrap size={12} style={{ marginBottom: 12 }}>
              <span>共 {st.total} 个视频</span>
              <span style={{ color: "#52c41a" }}>做好 {st.done}</span>
              {st.running > 0 && <span style={{ color: "#1677ff" }}>正在做 {st.running}</span>}
              {st.queued > 0 && <span>排队 {st.queued}</span>}
              {st.none > 0 && <span style={{ color: "#999" }}>没做 {st.none}</span>}
              {st.failed > 0 && <span style={{ color: "#ff4d4f" }}>失败 {st.failed}</span>}
            </Space>
            {st.running_items.map((r) => (
              <div key={r.path} style={{ fontSize: 12, color: "#888" }}>
                {r.stage === "detect" ? "找狗" : "涂黑编码"} {r.progress != null ? `${Math.round(r.progress * 100)}%` : ""} · {r.path}
              </div>
            ))}
            {st.failed_items.length > 0 && (
              <Alert type="error" style={{ margin: "8px 0" }} message="失败的视频（再点一次「一键遮罩」会重试）"
                description={<div style={{ fontSize: 12, maxHeight: 120, overflow: "auto" }}>
                  {st.failed_items.map((f) => <div key={f.path}>{f.path}：{f.error}</div>)}
                </div>} />
            )}
          </>
        )}
        <Space wrap style={{ margin: "8px 0 16px" }}>
          <span>框放大</span>
          <Select size="small" value={pad} onChange={setPad} style={{ width: 110 }}
            options={[{ value: 0.2, label: "20%" }, { value: 0.3, label: "30%（默认）" }, { value: 0.5, label: "50%" }]} />
          <Button type="primary" loading={busy} disabled={!st?.available} onClick={() => run(false)}>一键遮罩</Button>
          <Popconfirm title="已经做好的也全部重做？（改了框放大比例时用）" onConfirm={() => run(true)}>
            <Button size="small" disabled={!st?.available || busy}>全部重做</Button>
          </Popconfirm>
        </Space>
        <div style={{ borderTop: "1px solid rgba(128,128,128,.2)", paddingTop: 12 }}>
          <Space direction="vertical" size={8}>
            <Space>
              <Switch checked={!!st?.enabled} loading={busy} onChange={toggle}
                disabled={!st || (!st.enabled && !allDone)} />
              <span>{st?.enabled ? "已开：标注员 / 审核员只看得到狗框里的画面" : "关着：大家看原画面"}</span>
            </Space>
            {st && !st.enabled && !allDone && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>全部视频做好之后才能打开（不然没做好的那几段标注员直接看不了）</Typography.Text>
            )}
            {st?.enabled && st.done < st.total && (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                有 {st.total - st.done} 个视频还没遮罩（新加的任务？），标注员打开这几段会提示看不了——点「一键遮罩」补上
              </Typography.Text>
            )}
            <Checkbox checked={preview} onChange={(e) => {
              setPreview(e.target.checked);
              try { localStorage.setItem(PREVIEW_MASK_KEY, e.target.checked ? "1" : "0"); } catch { /* 隐私模式 */ }
            }}>
              我自己也看遮罩版（检查遮得对不对；只影响这台电脑上的你，重新打开视频生效）
            </Checkbox>
          </Space>
        </div>
      </Modal>
    </>
  );
}
