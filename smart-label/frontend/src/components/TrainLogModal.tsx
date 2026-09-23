import { useEffect, useRef, useState } from "react";
import { Alert, Checkbox, Modal, Space, Tag, Typography } from "antd";
import { trainLog, type TrainLog } from "@/api/training";

/**
 * 训练的实时日志。
 *
 * 训练动辄几十分钟，以前网页上只看得到「排队中 / 训练中」——出错了也得去算法机上
 * 翻文件。2026-09-23 第一次在网页上提交训练，步骤 0 就挂了，界面上还一直排着队。
 *
 * 做法：按偏移一段段接着要（每 2 秒），拿回来的直接追加。不每次拉全量——训练日志
 * 一跑就是几万行，每 2 秒全量拉一遍既慢又会让滚动条跳回顶上。
 */

const POLL_MS = 2000;
// 浏览器里最多留这么多字。几十分钟的训练能攒出几 MB 日志，全塞进一个 <pre>
// 页面会越来越卡；前面的截掉，要看全量去算法机上看文件
const MAX_CHARS = 400_000;

const STATUS: Record<TrainLog["status"], { color: string; label: string }> = {
  queued: { color: "default", label: "排队中" },
  running: { color: "processing", label: "训练中" },
  done: { color: "success", label: "完成" },
  failed: { color: "error", label: "失败" },
};

function fmtDur(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

export default function TrainLogModal({
  versionId, onClose, onFinished,
}: {
  versionId: number | null;
  onClose: () => void;
  /** 训练结束（成功或失败）那一刻调一次，外面好刷新列表 */
  onFinished?: () => void;
}) {
  const [text, setText] = useState("");
  const [info, setInfo] = useState<TrainLog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const offsetRef = useRef(0);
  const preRef = useRef<HTMLPreElement | null>(null);
  const finishedRef = useRef(false);
  const truncatedRef = useRef(false);

  // 换一版看：清空重来
  useEffect(() => {
    setText("");
    setInfo(null);
    setErr(null);
    offsetRef.current = 0;
    finishedRef.current = false;
    truncatedRef.current = false;
  }, [versionId]);

  useEffect(() => {
    if (versionId == null) return;
    let stop = false;
    let timer: number | null = null;

    const tick = async () => {
      // 本轮看到的状态和是否追到了末尾。**不能用组件 state 里的 info 判断**——
      // 这个函数是在 effect 里建的，闭包里的 info 永远是最初那个 null，
      // 拿它判断的话训练跑完了轮询也停不下来
      let lastStatus: TrainLog["status"] | null = null;
      let caughtUp = false;
      try {
        // 一次拿不完就接着拿，别等下一个 2 秒——刚打开一个跑完的任务时，
        // 一口气把已有的日志补齐
        for (let i = 0; i < 20 && !stop; i++) {
          const r = await trainLog(versionId, offsetRef.current);
          if (stop) return;
          setErr(null);
          setInfo(r);
          lastStatus = r.status;
          if (r.text) {
            setText((prev) => {
              const next = prev + r.text;
              if (next.length > MAX_CHARS) {
                truncatedRef.current = true;
                return next.slice(next.length - MAX_CHARS);
              }
              return next;
            });
          }
          const moved = r.offset !== offsetRef.current;
          offsetRef.current = r.offset;
          caughtUp = r.offset >= r.size;
          if (!moved || caughtUp) break;
        }
      } catch (e) {
        if (!stop) setErr(String((e as Error)?.message ?? e));
      }
      if (stop) return;
      // 结束了、而且日志已经追到末尾，就不再轮询
      if ((lastStatus === "done" || lastStatus === "failed") && caughtUp) return;
      timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [versionId]);

  // 训练结束那一刻通知外面一次（刷新列表）
  useEffect(() => {
    if (!info) return;
    if ((info.status === "done" || info.status === "failed") && !finishedRef.current) {
      finishedRef.current = true;
      onFinished?.();
    }
  }, [info, onFinished]);

  // 计时：跑着的时候每秒走一下
  useEffect(() => {
    if (info?.status !== "running") return;
    const t = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(t);
  }, [info?.status]);

  // 跟随到底：新日志进来自动滚到最下面。人往上翻着看的时候把勾去掉就不跳
  useEffect(() => {
    if (follow && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [text, follow]);

  const st = info ? STATUS[info.status] : null;
  const elapsed =
    info?.started_at != null
      ? (info.finished_at ?? (info.status === "running" ? now : info.started_at)) - info.started_at
      : null;

  return (
    <Modal
      title={`训练日志 #${versionId ?? ""}`}
      open={versionId != null}
      onCancel={onClose}
      footer={null}
      width="80vw"
      destroyOnClose
    >
      <Space wrap style={{ marginBottom: 8 }}>
        {st && <Tag color={st.color}>{st.label}</Tag>}
        {info?.stage && (
          <Typography.Text>
            现在：<b>{info.stage}</b>
          </Typography.Text>
        )}
        {elapsed != null && elapsed > 0 && (
          <Typography.Text type="secondary">已用 {fmtDur(elapsed)}</Typography.Text>
        )}
        <Checkbox checked={follow} onChange={(e) => setFollow(e.target.checked)}>
          自动滚到最新
        </Checkbox>
      </Space>
      {err && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`拿日志出错了（会接着重试）：${err}`} />}
      {info?.status === "failed" && info.error && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 8 }}
          message="训练失败"
          description={<pre style={{ whiteSpace: "pre-wrap", margin: 0, maxHeight: 160, overflow: "auto" }}>{info.error.slice(-1500)}</pre>}
        />
      )}
      {truncatedRef.current && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          日志太长，前面的已经截掉了，这里只留最近的一段。要看全量去算法机上看文件。
        </Typography.Text>
      )}
      <pre
        ref={preRef}
        onScroll={(e) => {
          // 人往上翻就别再把他拽回底下；翻回到底再自动跟上
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (atBottom !== follow) setFollow(atBottom);
        }}
        style={{
          height: "60vh",
          overflow: "auto",
          margin: 0,
          padding: 12,
          background: "#0b0b0b",
          color: "#d6d6d6",
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          borderRadius: 6,
        }}
      >
        {text || (info?.status === "queued" ? "排队中，还没开始跑…" : "等日志…")}
      </pre>
    </Modal>
  );
}
