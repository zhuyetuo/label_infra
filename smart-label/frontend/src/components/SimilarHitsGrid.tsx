import { useEffect, useRef, useState } from "react";
import { Button, Segmented, Space, Spin, Tag, Tooltip, Typography } from "antd";
import { SIMILAR_VIEW_HELP, SIMILAR_VIEW_OPTIONS, similarThumbToken, similarThumbUrl, type SimilarHit, type SimilarThumbView } from "@/api/candidates";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { getSampleMedia } from "@/api/samples";
import { formatMs } from "@/components/SegmentPanel";

interface Props {
  taskId: number;
  /** 当前项目：跨项目搜时别的项目的命中标出来 */
  projectId?: number | null;
  /** 样例：哪路视频第几秒（一句话搜的时候没有） */
  refPath: string | null;
  refT: number | null;
  /** 样例那一路是本任务样本的哪个槽位：内嵌播放器循环样例那几秒用 */
  refSampleId?: number | null;
  refCam?: string | null;
  hits: SimilarHit[];
  centered: boolean;
  /** 这次有没有用上姿态那一路 */
  poseUsed?: boolean;
  /** 点某个命中：本任务直接跳过去；别的任务开新页 */
  onJump: (hit: SimilarHit) => void;
  /** 缩略图看哪种（跟样例大图共用一个开关，由外面管） */
  view: SimilarThumbView;
  onViewChange: (v: SimilarThumbView) => void;
}

/** 内嵌循环播放的那一段：前后各留几秒 */
const LOOP_BEFORE_S = 2;
const LOOP_AFTER_S = 4;

interface Clip {
  key: string;
  title: string;
  sampleId: number;
  cam: string;
  t: number;
  hit: SimilarHit | null;
}

// 「先看命中」：写候选之前，把样例那一块和命中的那一块并排摆出来，一眼看出检索靠不靠谱。
// 缩略图是视觉服务现取的（每张要解一帧、跑一次狗检测），懒加载，滚到哪取到哪。
// 点一张：下面内嵌一个小播放器循环播那几秒——不用关掉预览去主画面找，主画面被这个弹窗挡着也看不见。
export default function SimilarHitsGrid({ taskId, projectId, refPath, refT, refSampleId, refCam, hits, centered, poseUsed, onJump, view, onViewChange }: Props) {
  const [token, setToken] = useState<string | null>(null);
  // 本任务 / 其他任务分开看：跨任务的命中往往差得多（别的狗、别的天），分开才看得出问题在哪
  const [scope, setScope] = useState<"all" | "own" | "other">("all");
  // 排序：综合（视觉服务给的顺序）/ 纯画面 / 纯姿态。混在一起的分看不出是哪一路把它顶上来的
  const [sortBy, setSortBy] = useState<"score" | "vis" | "pose">("score");
  const hasVis = hits.some((h) => h.vis_score != null);
  const hasPose = hits.some((h) => h.pose_score != null);
  const keyOf = (h: SimilarHit) =>
    sortBy === "vis" ? (h.vis_score ?? h.score) : sortBy === "pose" ? (h.pose_score ?? -1) : h.score;
  const ordered = [...hits].sort((a, b) => keyOf(b) - keyOf(a));
  const own = ordered.filter((h) => h.task_id === taskId);
  const other = ordered.filter((h) => h.task_id !== taskId);
  const shown = scope === "own" ? own : scope === "other" ? other : ordered;
  useEffect(() => {
    let alive = true;
    similarThumbToken(taskId).then((r) => alive && setToken(r.token)).catch(() => alive && setToken(null));
    return () => {
      alive = false;
    };
  }, [taskId]);

  // ── 内嵌循环播放 ──
  const [clip, setClip] = useState<Clip | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [clipErr, setClipErr] = useState<string | null>(null);
  // 同一份样本的视频流地址缓存：token 换一次够用，点十几个命中不用十几次请求
  const urlCache = useRef(new Map<string, Promise<string | null>>());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const resolveUrl = (sampleId: number, cam: string): Promise<string | null> => {
    const k = `${sampleId}:${cam}`;
    let p = urlCache.current.get(k);
    if (!p) {
      p = (async () => {
        const m = await getSampleMedia(sampleId);
        const id = cam === "cam1" ? m.video1_id : cam === "cam2" ? m.video2_id : cam === "cam3" ? m.video3_id : null;
        if (id == null) return null;
        const { token: tk } = await getMediaToken(id);
        return mediaStreamUrl(id, tk);
      })();
      urlCache.current.set(k, p);
    }
    return p;
  };
  useEffect(() => {
    if (!clip) {
      setClipUrl(null);
      return;
    }
    let alive = true;
    setClipUrl(null);
    setClipErr(null);
    resolveUrl(clip.sampleId, clip.cam)
      .then((u) => {
        if (!alive) return;
        if (u) setClipUrl(u);
        else setClipErr("这一路视频在媒体库里找不到（没传上 NAS 或还没扫到）");
      })
      .catch((e) => alive && setClipErr(`拿不到视频：${e?.message ?? e}`));
    return () => {
      alive = false;
    };
  }, [clip?.key]);
  // 区间循环：播到 t+4 就跳回 t-2。用 timeupdate 不用 loop 属性——loop 是整段循环
  const loopStart = clip ? Math.max(0, clip.t - LOOP_BEFORE_S) : 0;
  const loopEnd = clip ? clip.t + LOOP_AFTER_S : 0;
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

  const playHit = (h: SimilarHit) => {
    if (h.sample_id != null && h.cam) {
      setClip({ key: `${h.path}@${h.t}`, title: `${h.sample_code ?? h.path.split("/").pop()} · ${formatMs(h.t * 1000)}`, sampleId: h.sample_id, cam: h.cam, t: h.t, hit: h });
    } else {
      setClipErr("这个命中对不上样本，播不了");
    }
    // 本任务的命中：主画面也一起跳过去循环，关掉预览就接着看
    if (h.task_id === taskId) onJump(h);
  };
  const playRef = () => {
    if (refPath == null || refT == null || refSampleId == null) return;
    setClip({ key: `ref@${refT}`, title: `样例 · ${formatMs(refT * 1000)}`, sampleId: refSampleId, cam: refCam || "cam1", t: refT, hit: null });
  };

  const url = (path: string, t: number) => (token ? similarThumbUrl(taskId, path, t, token, view) : "");
  const scoreColor = (s: number) => (s >= 0.6 ? "#52c41a" : s >= 0.3 ? "#fa8c16" : "#999");
  const isPlaying = (h: SimilarHit) => clip?.key === `${h.path}@${h.t}`;

  return (
    <div>
      <Space size={8} style={{ marginBottom: 6 }} wrap>
        <Typography.Text strong>命中 {hits.length} 帧</Typography.Text>
        <Segmented size="small" value={scope} onChange={(v) => setScope(v as "all" | "own" | "other")}
                   options={[{ label: `全部 ${hits.length}`, value: "all" }, { label: `本任务 ${own.length}`, value: "own" }, { label: `其他任务 ${other.length}`, value: "other" }]} />
        <Tooltip title={SIMILAR_VIEW_HELP}>
          <Segmented size="small" value={view} onChange={(v) => onViewChange(v as SimilarThumbView)} options={SIMILAR_VIEW_OPTIONS} />
        </Tooltip>
        <Tooltip title="综合 = 画面 × (1−姿态占比) + 姿态 × 姿态占比，视觉服务按它排的；画面 / 姿态是各自单独的分，看看是哪一路把它顶上来的">
          <Segmented size="small" value={sortBy} onChange={(v) => setSortBy(v as "score" | "vis" | "pose")}
                     options={[{ label: "按综合", value: "score" }, { label: "按画面", value: "vis", disabled: !hasVis }, { label: "按姿态", value: "pose", disabled: !hasPose }]} />
        </Tooltip>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {centered ? "已去共同背景（减掉所有帧的平均向量再比），分数是相对的，0.3 以上算像" : "没去背景，分数普遍 0.9+，看相对高低"}
          {poseUsed ? "；已混入姿态相似（悬停看姿态分）" : "；这次没用上姿态（算法机没装姿态模型，或样例 / 索引里没测到关键点）"}
          。点一张：下面循环播那几秒；本任务的主画面也一起跳过去
        </Typography.Text>
      </Space>
      {!token ? (
        <Spin />
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, maxHeight: clip ? 240 : 420, overflowY: "auto" }}>
          {refPath != null && refT != null && (
            <div
              onClick={playRef}
              style={{ width: 150, border: `2px solid ${clip && clip.hit === null ? "#faad14" : "#1677ff"}`, borderRadius: 6, padding: 3, background: "rgba(22,119,255,0.08)", cursor: refSampleId != null ? "pointer" : "default" }}
            >
              <img src={url(refPath, refT)} alt="样例" loading="lazy" style={{ width: "100%", height: 110, objectFit: "contain", background: "#000", borderRadius: 4 }} />
              <div style={{ fontSize: 12, lineHeight: 1.4, marginTop: 2 }}>
                <Tag color="blue" style={{ marginRight: 4 }}>样例</Tag>
                {formatMs(refT * 1000)}
              </div>
            </div>
          )}
          {shown.map((h) => (
            <div
              key={`${h.path}@${h.t}`}
              onClick={() => playHit(h)}
              style={{ width: 150, border: isPlaying(h) ? "2px solid #faad14" : "1px solid #f0f0f0", borderRadius: 6, padding: 3, cursor: "pointer", background: isPlaying(h) ? "rgba(250,173,20,0.08)" : undefined }}
              title={`${h.sample_code ?? h.path} · ${formatMs(h.t * 1000)} · 综合 ${h.score.toFixed(3)}${h.vis_score != null ? ` · 画面 ${h.vis_score.toFixed(3)}` : ""}${h.pose_score != null ? ` · 姿态 ${h.pose_score.toFixed(3)}` : ""}`}
            >
              <img src={url(h.path, h.t)} alt="" loading="lazy" style={{ width: "100%", height: 110, objectFit: "contain", background: "#000", borderRadius: 4 }} />
              <div style={{ fontSize: 12, lineHeight: 1.4, marginTop: 2, display: "flex", justifyContent: "space-between", gap: 4 }}>
                <span style={{ color: "#999" }}>#{ordered.indexOf(h) + 1}</span>
                <span style={{ color: scoreColor(keyOf(h)), fontWeight: 600 }}>{keyOf(h).toFixed(3)}</span>
              </div>
              <div style={{ fontSize: 11, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.task_id === taskId ? <Tag color="blue" style={{ marginRight: 4, fontSize: 10, lineHeight: "16px", padding: "0 4px" }}>本任务</Tag> : null}
                {h.project_id != null && projectId != null && h.project_id !== projectId ? (
                  <Tag color="purple" style={{ marginRight: 4, fontSize: 10, lineHeight: "16px", padding: "0 4px" }}>项目 #{h.project_id}</Tag>
                ) : null}
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
      {clip && (
        <div style={{ marginTop: 8, border: "1px solid #faad14", borderRadius: 6, padding: 6, background: "rgba(250,173,20,0.05)" }}>
          <Space size={8} wrap style={{ marginBottom: 4 }}>
            <Typography.Text strong>循环播放：{clip.title}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatMs(loopStart * 1000)} ~ {formatMs(loopEnd * 1000)}（命中前 {LOOP_BEFORE_S} 秒到后 {LOOP_AFTER_S} 秒）
            </Typography.Text>
            {clip.hit && clip.hit.task_id != null && clip.hit.task_id !== taskId && (
              <Tooltip title="新页打开那个任务：那一条候选置顶高亮，视频停在这一刻循环播">
                <Button size="small" onClick={() => onJump(clip.hit!)}>在新页打开那个任务</Button>
              </Tooltip>
            )}
            {clip.hit && clip.hit.task_id === taskId && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>主画面已跳到这一刻并循环，关掉预览就能看大图</Typography.Text>
            )}
            <Button size="small" onClick={() => setClip(null)}>收起</Button>
          </Space>
          {clipErr ? (
            <Typography.Text type="danger">{clipErr}</Typography.Text>
          ) : !clipUrl ? (
            <Spin size="small" />
          ) : (
            <video
              ref={videoRef}
              key={clip.key}
              src={clipUrl}
              muted
              playsInline
              controls
              onLoadedMetadata={onLoaded}
              onTimeUpdate={onTime}
              style={{ width: "100%", maxHeight: 360, background: "#000", borderRadius: 4 }}
            />
          )}
        </div>
      )}
    </div>
  );
}
