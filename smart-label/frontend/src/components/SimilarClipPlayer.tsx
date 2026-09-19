import { useEffect, useRef, useState } from "react";
import { Button, Space, Spin, Tooltip, Typography } from "antd";
import type { SimilarHit } from "@/api/candidates";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { getSampleMedia } from "@/api/samples";
import { formatMs } from "@/components/SegmentPanel";

/** 内嵌循环播放的那一段：前后各留几秒 */
export const LOOP_BEFORE_S = 2;
export const LOOP_AFTER_S = 4;

export interface Clip {
  key: string;
  title: string;
  sampleId: number;
  cam: string;
  t: number;
  /** 命中；样例是 null */
  hit: SimilarHit | null;
}

export const clipKeyOf = (h: SimilarHit) => `${h.path}@${h.t}`;

interface Props {
  taskId: number;
  clip: Clip | null;
  /** 命中在别的任务：新页打开那个任务 */
  onOpenTask?: (hit: SimilarHit) => void;
  onClose: () => void;
}

// 找相似预览里点一张命中，就在这里循环播那几秒：不用关掉预览去主画面找。
// 同一份样本的视频流地址缓存：token 换一次够用，点十几个命中不用十几次请求
const urlCache = new Map<string, Promise<string | null>>();
const resolveUrl = (sampleId: number, cam: string): Promise<string | null> => {
  const k = `${sampleId}:${cam}`;
  let p = urlCache.get(k);
  if (!p) {
    p = (async () => {
      const m = await getSampleMedia(sampleId);
      const id = cam === "cam1" ? m.video1_id : cam === "cam2" ? m.video2_id : cam === "cam3" ? m.video3_id : null;
      if (id == null) return null;
      const { token } = await getMediaToken(id);
      return mediaStreamUrl(id, token);
    })();
    urlCache.set(k, p);
    // 失败的别缓存，下次再试
    p.catch(() => urlCache.delete(k));
  }
  return p;
};

export default function SimilarClipPlayer({ taskId, clip, onOpenTask, onClose }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!clip) {
      setUrl(null);
      return;
    }
    let alive = true;
    setUrl(null);
    setErr(null);
    resolveUrl(clip.sampleId, clip.cam)
      .then((u) => {
        if (!alive) return;
        if (u) setUrl(u);
        else setErr("这一路视频在媒体库里找不到（没传上 NAS 或还没扫到）");
      })
      .catch((e) => alive && setErr(`拿不到视频：${(e as { message?: string })?.message ?? e}`));
    return () => {
      alive = false;
    };
  }, [clip?.sampleId, clip?.cam]);

  // 区间循环：播到 t+4 就跳回 t-2。用 timeupdate 不用 loop 属性——loop 是整段循环
  const loopStart = clip ? Math.max(0, clip.t - LOOP_BEFORE_S) : 0;
  const loopEnd = clip ? clip.t + LOOP_AFTER_S : 0;
  // 换命中但视频是同一路：不重新加载，直接跳到新起点
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !clip) return;
    v.currentTime = loopStart;
    v.play().catch(() => undefined);
  }, [clip?.key]);
  const onTime = () => {
    const v = videoRef.current;
    if (!v || !clip) return;
    if (v.currentTime >= loopEnd || v.currentTime < loopStart - 0.5) v.currentTime = loopStart;
  };
  const onLoaded = () => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = loopStart;
    v.play().catch(() => undefined);
  };

  if (!clip) {
    return (
      <div style={{ border: "1px dashed #d9d9d9", borderRadius: 6, padding: 16, textAlign: "center", color: "#999", fontSize: 12 }}>
        右边点一张命中（或样例），这里循环播那几秒
      </div>
    );
  }
  const other = clip.hit && clip.hit.task_id != null && clip.hit.task_id !== taskId;
  return (
    <div style={{ border: "1px solid #faad14", borderRadius: 6, padding: 6, background: "rgba(250,173,20,0.05)" }}>
      <Space size={8} wrap style={{ marginBottom: 4 }}>
        <Typography.Text strong>循环播放：{clip.title}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatMs(loopStart * 1000)} ~ {formatMs(loopEnd * 1000)}（命中前 {LOOP_BEFORE_S} 秒到后 {LOOP_AFTER_S} 秒）
        </Typography.Text>
        {other && onOpenTask && (
          <Tooltip title="新页打开那个任务：那一条候选置顶高亮，视频停在这一刻循环播">
            <Button size="small" onClick={() => onOpenTask(clip.hit!)}>在新页打开那个任务</Button>
          </Tooltip>
        )}
        {clip.hit && clip.hit.task_id === taskId && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>主画面已跳到这一刻并循环，关掉预览就能看大图</Typography.Text>
        )}
        <Button size="small" onClick={onClose}>收起</Button>
      </Space>
      {err ? (
        <Typography.Text type="danger">{err}</Typography.Text>
      ) : !url ? (
        <Spin size="small" />
      ) : (
        <video
          ref={videoRef}
          key={url}
          src={url}
          muted
          playsInline
          controls
          onLoadedMetadata={onLoaded}
          onTimeUpdate={onTime}
          style={{ width: "100%", maxHeight: 420, background: "#000", borderRadius: 4 }}
        />
      )}
    </div>
  );
}
