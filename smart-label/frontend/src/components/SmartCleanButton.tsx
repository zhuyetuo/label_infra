import { useEffect, useRef, useState } from "react";
import { Alert, Button, Popconfirm, Progress, Space, Typography, message } from "antd";
import {
  segSmartCleanCancel,
  segSmartCleanProgress,
  segSmartCleanStart,
  type SmartCleanProgress,
} from "@/api/segReview";

type Props = {
  /** 按钮文案 */
  label: string;
  /** 确认弹窗标题 */
  confirmTitle: string;
  size?: "small" | "middle";
  disabled?: boolean;
};

/** 通用「⚡ 一键批量智能处理」按钮 + 实时进度条 + 停止按钮（复用后端 smart_clean_service，严格保留原审核状态） */
export function useSmartCleanRunner(onDone?: () => void) {
  const [prog, setProg] = useState<SmartCleanProgress | null>(null);
  const prevStatusRef = useRef<string>("idle");
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    segSmartCleanProgress()
      .then((p) => {
        prevStatusRef.current = p.status;
        if (p.status === "running") setProg(p);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (prog?.status !== "running") return;
    const t = setInterval(() => {
      segSmartCleanProgress()
        .then((p) => {
          setProg(p);
          if (prevStatusRef.current === "running" && p.status !== "running") {
            onDoneRef.current?.();
          }
          prevStatusRef.current = p.status;
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [prog?.status]);

  const start = async (opts?: { projectIds?: number[] | null; taskIds?: number[] | null; scope?: "test_pool" | null }) => {
    const r = await segSmartCleanStart(opts?.projectIds ?? null, 1500, {
      task_ids: opts?.taskIds ?? null,
      scope: opts?.scope ?? null,
    });
    prevStatusRef.current = r.progress.status;
    setProg(r.progress);
    if (!r.started) {
      message.info("已有批量智能处理正在后台运行");
    }
  };

  return { prog, setProg, start };
}

export function SmartCleanProgressBanner({
  prog,
  onClose,
}: {
  prog: SmartCleanProgress | null;
  onClose: () => void;
}) {
  if (!prog || prog.status === "idle") return null;
  const fmtSec = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : `${sec}秒`);

  if (prog.status === "running") {
    const isCsvPhase = prog.phase === "csv_scan" && (prog.scan_total ?? 0) > 0;
    const pct = isCsvPhase
      ? Math.min(99, Math.round(((prog.scan_done ?? 0) / (prog.scan_total ?? 1)) * 100))
      : prog.tasks_total
        ? Math.min(99, Math.round((prog.tasks_done / prog.tasks_total) * 100))
        : 0;
    const s = prog.summary;
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 8 }}
        message={
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            <Space wrap size={12}>
              <b>{isCsvPhase ? "阶段 1/2：快速检测无信号 CSV" : "后台智能批量处理中"}</b>
              {isCsvPhase ? (
                <span>CSV <b>{prog.scan_done ?? 0}/{prog.scan_total ?? 0}</b></span>
              ) : (
                <>
                  <span>项目 {prog.projects_done}/{prog.projects_total}</span>
                  <span>任务 <b>{prog.tasks_done}/{prog.tasks_total}</b></span>
                </>
              )}
              {prog.current_project && !isCsvPhase && <span>当前：{prog.current_project}</span>}
              <span>已用 {fmtSec(prog.elapsed_sec)}{prog.eta_sec != null ? ` · 预计剩余 ${fmtSec(prog.eta_sec)}` : ""}</span>
            </Space>
            <Progress percent={pct} size="small" status="active" style={{ margin: 0 }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已改动 {s.tasks_changed} 个任务 · 无信号切分 {s.zero_carved}（标出 {s.no_signal_added}）· 智能挖洞 {s.carved_motion} · 去重 {s.dedupe_merged + s.removed_parent} · 合并 {s.adj_groups_merged} 组
            </Typography.Text>
          </Space>
        }
        action={
          <Button size="small" danger onClick={() => void segSmartCleanCancel().then(() => message.info("正在停止，当前任务收尾后停下"))}>
            停止
          </Button>
        }
      />
    );
  }

  return (
    <Alert
      type={prog.status === "error" ? "error" : prog.status === "cancelled" ? "warning" : "success"}
      showIcon
      closable
      onClose={onClose}
      style={{ marginBottom: 8 }}
      message={
        prog.status === "error"
          ? `批量智能处理出错：${prog.error}`
          : `${prog.status === "cancelled" ? "批量智能处理已停止" : "批量智能处理完成"}（处理 ${prog.tasks_done}/${prog.tasks_total} 任务，改动 ${prog.summary.tasks_changed} 个，耗时 ${prog.elapsed_sec}s）`
      }
      description={
        prog.status !== "error" ? (
          <div style={{ fontSize: 12 }}>
            去无信号：切开 {prog.summary.zero_carved} 段，标出「无信号」{prog.summary.no_signal_added} 段 ·
            智能挖洞 {prog.summary.carved_motion} 段 ·
            去重合并 {prog.summary.dedupe_merged} 段 / 删粗类 {prog.summary.removed_parent} 段 ·
            相邻合并 {prog.summary.adj_groups_merged} 组（消掉 {prog.summary.adj_removed} 条碎片）
            {prog.summary.conflicts_left > 0 ? ` · 还剩 ${prog.summary.conflicts_left} 处类别冲突需人工核对` : ""}
          </div>
        ) : undefined
      }
    />
  );
}

export default function SmartCleanButton({
  label,
  confirmTitle,
  size = "middle",
  disabled,
  prog,
  onStart,
}: Props & {
  prog: SmartCleanProgress | null;
  onStart: () => void;
}) {
  const isRunning = prog?.status === "running";
  return (
    <Popconfirm
      title={confirmTitle}
      description={
        <div style={{ maxWidth: 420, lineHeight: 1.6 }}>
          后台异步执行 6 步（严格保留原审核状态，未审核片段绝不自动入池）：<br />
          ① 自动切无信号（复用已缓存断流，无信号不入池）<br />
          ② 自动智能挖洞（具体行为 / 未佩戴挖空活动，活动挖空静止）<br />
          ③ 自动去重 → ④ 自动合并（≤1.5s）→ ⑤ 再去重 → ⑥ 再合并 + 终轮挖洞
        </div>
      }
      okText="后台开始处理"
      disabled={isRunning || disabled}
      onConfirm={onStart}
    >
      <Button size={size} loading={isRunning} disabled={disabled}>
        {isRunning ? `智能处理中 ${prog?.tasks_done ?? 0}/${prog?.tasks_total || "?"}` : label}
      </Button>
    </Popconfirm>
  );
}
