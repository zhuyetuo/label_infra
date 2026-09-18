import { useEffect, useState } from "react";
import { Segmented, Space, Spin, Tag, Tooltip, Typography } from "antd";
import { similarThumbToken, similarThumbUrl, type SimilarHit } from "@/api/candidates";
import { formatMs } from "@/components/SegmentPanel";

interface Props {
  taskId: number;
  /** 样例：哪路视频第几秒（一句话搜的时候没有） */
  refPath: string | null;
  refT: number | null;
  hits: SimilarHit[];
  centered: boolean;
  /** 点某个命中：本任务直接跳过去；别的任务开新页 */
  onJump: (hit: SimilarHit) => void;
}

// 「先看命中」：写候选之前，把样例那一块和命中的那一块并排摆出来，一眼看出检索靠不靠谱。
// 缩略图是视觉服务现取的（每张要解一帧、跑一次狗检测），懒加载，滚到哪取到哪。
export default function SimilarHitsGrid({ taskId, refPath, refT, hits, centered, onJump }: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [mode, setMode] = useState<"crop" | "full">("crop");
  useEffect(() => {
    let alive = true;
    similarThumbToken(taskId).then((r) => alive && setToken(r.token)).catch(() => alive && setToken(null));
    return () => {
      alive = false;
    };
  }, [taskId]);

  const url = (path: string, t: number) => (token ? similarThumbUrl(taskId, path, t, token, mode === "crop") : "");
  const scoreColor = (s: number) => (s >= 0.6 ? "#52c41a" : s >= 0.3 ? "#fa8c16" : "#999");

  return (
    <div>
      <Space size={8} style={{ marginBottom: 6 }} wrap>
        <Typography.Text strong>命中 {hits.length} 帧</Typography.Text>
        <Segmented size="small" value={mode} onChange={(v) => setMode(v as "crop" | "full")}
                   options={[{ label: "狗框那一块", value: "crop" }, { label: "整帧", value: "full" }]} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {centered ? "已去共同背景（减掉所有帧的平均向量再比），分数是相对的，0.3 以上算像" : "没去背景，分数普遍 0.9+，看相对高低"}
          。点一张：本任务直接跳过去循环播放，别的任务开新页
        </Typography.Text>
      </Space>
      {!token ? (
        <Spin />
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, maxHeight: 420, overflowY: "auto" }}>
          {refPath != null && refT != null && (
            <div style={{ width: 150, border: "2px solid #1677ff", borderRadius: 6, padding: 3, background: "rgba(22,119,255,0.08)" }}>
              <img src={url(refPath, refT)} alt="样例" loading="lazy" style={{ width: "100%", height: 110, objectFit: "contain", background: "#000", borderRadius: 4 }} />
              <div style={{ fontSize: 12, lineHeight: 1.4, marginTop: 2 }}>
                <Tag color="blue" style={{ marginRight: 4 }}>样例</Tag>
                {formatMs(refT * 1000)}
              </div>
            </div>
          )}
          {hits.map((h, i) => (
            <div
              key={`${h.path}@${h.t}`}
              onClick={() => onJump(h)}
              style={{ width: 150, border: "1px solid #f0f0f0", borderRadius: 6, padding: 3, cursor: "pointer" }}
              title={`${h.sample_code ?? h.path} · ${formatMs(h.t * 1000)} · 分数 ${h.score.toFixed(3)}`}
            >
              <img src={url(h.path, h.t)} alt="" loading="lazy" style={{ width: "100%", height: 110, objectFit: "contain", background: "#000", borderRadius: 4 }} />
              <div style={{ fontSize: 12, lineHeight: 1.4, marginTop: 2, display: "flex", justifyContent: "space-between", gap: 4 }}>
                <span style={{ color: "#999" }}>#{i + 1}</span>
                <span style={{ color: scoreColor(h.score), fontWeight: 600 }}>{h.score.toFixed(3)}</span>
              </div>
              <div style={{ fontSize: 11, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.task_id === taskId ? <Tag color="blue" style={{ marginRight: 4, fontSize: 10, lineHeight: "16px", padding: "0 4px" }}>本任务</Tag> : null}
                {h.multi_dog ? (
                  <Tooltip title="多狗同场（影棚 / 公共区）：画面里那只不一定是这条 IMU 的狗">
                    <Tag color="orange" style={{ marginRight: 4, fontSize: 10, lineHeight: "16px", padding: "0 4px" }}>多狗</Tag>
                  </Tooltip>
                ) : null}
                {formatMs(h.t * 1000)} · {h.sample_code ?? h.path.split("/").pop()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
