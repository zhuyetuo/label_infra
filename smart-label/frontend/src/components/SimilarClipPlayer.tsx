import { useEffect, useRef, useState } from "react";
import { Button, Spin, Tag, Tooltip, Typography } from "antd";
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
  /** 封面：**检索命中的那一帧本身**。循环是从命中前 2 秒开始的，视频停着时
   *  第一帧是那个起点，不是命中的那一刻——拿它当封面会让人以为"检索找的是这个" */
  poster?: string;
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
  // 点一张先**停在那一帧**，不直接放。要比"像不像"得盯着两张静止的图看，
  // 一进来就动起来根本比不了；想看动作再点「循环播放」
  const [playing, setPlaying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 换一张命中就回到静止：上一张正在播不代表这一张也想直接看动作
  useEffect(() => {
    setPlaying(false);
  }, [clip?.key]);
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
      <div style={{ flex: 1, border: "1px dashed #d9d9d9", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "#999", fontSize: 12 }}>
        右边点一张命中（或样例），这里看大图；要看动作再点「循环播放」
      </div>
    );
  }
  const other = clip.hit && clip.hit.task_id != null && clip.hit.task_id !== taskId;
  const own = clip.hit && clip.hit.task_id === taskId;
  // 占满给它的高度：一行标题 + 视频撑满剩下的，不出滚动条
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", border: "1px solid #faad14", borderRadius: 6, padding: 6, background: "rgba(250,173,20,0.05)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, whiteSpace: "nowrap", minWidth: 0 }}>
        <Tooltip title={`${clip.title}；${playing ? `循环 ${formatMs(loopStart * 1000)} ~ ${formatMs(loopEnd * 1000)}（命中前 ${LOOP_BEFORE_S} 秒到后 ${LOOP_AFTER_S} 秒）` : "停在检索命中的那一刻"}${own ? "。主画面已跳到这一刻并循环，关掉预览就能看大图" : ""}`}>
          <Typography.Text strong ellipsis style={{ flex: 1, minWidth: 0 }}>
            {playing ? `循环 ${formatMs(loopStart * 1000)} ~ ${formatMs(loopEnd * 1000)}` : formatMs(clip.t * 1000)} · {clip.title}
          </Typography.Text>
        </Tooltip>
        {/* 比"像不像"得盯着静止的图看，所以默认停在命中那一帧；想看动作再放 */}
        <Tooltip title={playing ? "停回检索命中的那一帧，好跟左上角的样例静静地比" : `循环播放命中前 ${LOOP_BEFORE_S} 秒到后 ${LOOP_AFTER_S} 秒`}>
          <Button size="small" type={playing ? "default" : "primary"} onClick={() => setPlaying(!playing)}>
            {playing ? "停在那一帧" : "循环播放"}
          </Button>
        </Tooltip>
        {own && <Tag color="blue" style={{ marginRight: 0 }}>主画面已同步</Tag>}
        {other && onOpenTask && (
          <Tooltip title="新页打开那个任务：那一条候选置顶高亮，视频停在这一刻循环播">
            <Button size="small" onClick={() => onOpenTask(clip.hit!)}>打开那个任务</Button>
          </Tooltip>
        )}
        <Button size="small" onClick={onClose}>收起</Button>
      </div>
      <div style={{ flex: 1, minHeight: 0, background: "#000", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {!playing ? (
          // 静止的那一帧：就是检索命中的那一刻本身（跟右边那张缩略图同一帧，
          // 只是大）。两张静止的图摆在一起才比得出像不像
          clip.poster ? (
            <img src={clip.poster} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
          ) : (
            <Spin size="small" />
          )
        ) : err ? (
          <Typography.Text type="danger">{err}</Typography.Text>
        ) : !url ? (
          <Spin size="small" />
        ) : (
          <video
            ref={videoRef}
            key={url}
            src={url}
            poster={clip.poster}
            muted
            playsInline
            controls
            onLoadedMetadata={onLoaded}
            onTimeUpdate={onTime}
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
          />
        )}
      </div>
    </div>
  );
}
