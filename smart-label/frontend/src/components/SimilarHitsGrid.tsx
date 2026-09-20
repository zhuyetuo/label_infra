import { useEffect, useState } from "react";
import { Button, Checkbox, Segmented, Select, Space, Spin, Tag, Tooltip, Typography } from "antd";
import { SIMILAR_VIEW_HELP, SIMILAR_VIEW_OPTIONS, similarThumbToken, similarThumbUrl, type SimilarHit, type SimilarThumbView } from "@/api/candidates";
import { clipKeyOf, type Clip } from "@/components/SimilarClipPlayer";
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
  /** 点一张 → 左边的播放器循环播那几秒（播放器在外面，这里只报"要播哪段"） */
  playing: Clip | null;
  onPlay: (clip: Clip | null) => void;
  /** 勾中的命中 → 这一帧标成哪个类别（`路径@秒` → 类别名）。没勾的不在里面。
   *  一次检索常常混着别的动作，逐帧能改类别，就不用写完再回头一条条改 */
  picked: Map<string, string>;
  onPicked: (next: Map<string, string>) => void;
  /** 默认标成哪个类别（左上角「标成」选的）。没选时勾不了，得先选 */
  defaultLabel?: string | null;
  /** 项目里可选的类别（改某一帧的类别用） */
  labelNames?: { name: string; color?: string | null }[];
}

export const hitKeyOf = (h: SimilarHit) => `${h.path}@${h.t}`;

// 「先看命中」：写候选之前，把样例那一块和命中的那一块并排摆出来，一眼看出检索靠不靠谱。
// 缩略图是视觉服务现取的（每张要解一帧、跑一次狗检测），懒加载，滚到哪取到哪。
// 点一张：下面内嵌一个小播放器循环播那几秒——不用关掉预览去主画面找，主画面被这个弹窗挡着也看不见。
export default function SimilarHitsGrid({ taskId, projectId, refPath, refT, refSampleId, refCam, hits, centered, poseUsed, onJump, view, onViewChange, playing, onPlay, picked, onPicked, defaultLabel, labelNames = [] }: Props) {
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

  const clip = playing;
  const playHit = (h: SimilarHit) => {
    if (h.sample_id != null && h.cam) {
      // 大图就是**命中那一帧**本身，而且跟这一屏看的是同一种（抠图/原图/姿态/整帧）——
      // 拿抠图跟整帧比大小形状，比出来的差别是裁剪造成的，不是动作
      onPlay({ key: clipKeyOf(h), title: `${h.sample_code ?? h.path.split("/").pop()} · ${formatMs(h.t * 1000)}`, sampleId: h.sample_id, cam: h.cam, t: h.t, hit: h, poster: url(h.path, h.t) || undefined });
    }
    // 本任务的命中：主画面也一起跳过去循环，关掉预览就接着看
    if (h.task_id === taskId) onJump(h);
  };
  const playRef = () => {
    if (refPath == null || refT == null || refSampleId == null) return;
    onPlay({ key: `ref@${refT}`, title: `样例 · ${formatMs(refT * 1000)}`, sampleId: refSampleId, cam: refCam || "cam1", t: refT, hit: null, poster: url(refPath, refT) || undefined });
  };

  const url = (path: string, t: number) => (token ? similarThumbUrl(taskId, path, t, token, view) : "");
  // 换了看法（抠图/原图/姿态/整帧）或者 token 刚拿到：左边那张大图跟着换，
  // 不然它还停在上一种看法上，跟这一屏和样例大图对不上，比出来的差别是假的
  useEffect(() => {
    if (!clip || !token) return;
    const next = clip.hit ? url(clip.hit.path, clip.hit.t) : refPath != null && refT != null ? url(refPath, refT) : "";
    if (next && next !== clip.poster) onPlay({ ...clip, poster: next });
  }, [view, token, clip?.key, clip?.poster]);
  const scoreColor = (s: number) => (s >= 0.6 ? "#52c41a" : s >= 0.3 ? "#fa8c16" : "#999");
  const isPlaying = (h: SimilarHit) => clip?.key === clipKeyOf(h);
  // 勾上的才写候选，**默认一张都不勾**：低分那一截基本全不对，默认全勾的话
  // 人要去挑错的那些，挑漏一张就多写一条脏候选；默认不勾，挑漏只是少写一条
  const isDropped = (h: SimilarHit) => !picked.has(hitKeyOf(h));
  const keptN = picked.size;
  const toggle = (h: SimilarHit) => {
    if (!defaultLabel) return;      // 还没选「标成」哪个类别：勾了也不知道标成什么
    const next = new Map(picked);
    const k = hitKeyOf(h);
    if (next.has(k)) next.delete(k);
    else next.set(k, defaultLabel);
    onPicked(next);
  };
  // 某一帧改成别的类别：检索是按"长得像"找的，混进别的动作很正常（舔着舔着开始
  // 甩身体）。当场改掉，比写完一堆错类别再回去一条条改省事得多
  const relabel = (h: SimilarHit, name: string) => {
    const next = new Map(picked);
    next.set(hitKeyOf(h), name);
    onPicked(next);
  };
  // 批量只作用在**当前这一屏**（本任务 / 其他任务筛过之后的）：跨任务的命中常常整批不对，
  // 切到「其他任务」一键全不要，比一张张点快得多
  const bulk = (keep: boolean) => {
    const next = new Map(picked);
    for (const h of shown) {
      if (keep) {
        if (defaultLabel) next.set(hitKeyOf(h), defaultLabel);
      } else next.delete(hitKeyOf(h));
    }
    onPicked(next);
  };

  return (
    <div>
      <Space size={8} style={{ marginBottom: 6 }} wrap>
        <Typography.Text strong>命中 {hits.length} 帧</Typography.Text>
        <Tooltip title="勾上的才写候选，默认一张都不勾。分高的那一截往往是对的，可以「这一屏全要」再把不对的点掉；低分那一截基本全不对，一张都别勾。勾中的那张上会出现类别，混进来的别的动作当场改掉就行">
          <Typography.Text type={keptN ? "success" : "secondary"} style={{ fontSize: 12 }}>
            要 {keptN} / {hits.length}
          </Typography.Text>
        </Tooltip>
        <Space size={4}>
          <Button size="small" onClick={() => bulk(true)}>这一屏全要</Button>
          <Button size="small" onClick={() => bulk(false)}>这一屏全不要</Button>
        </Space>
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
          。点一张：左边看那一帧的大图（要看动作再点「循环播放」）；本任务的主画面也一起跳过去
        </Typography.Text>
      </Space>
      {!token ? (
        <Spin />
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignContent: "flex-start" }}>
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
              key={hitKeyOf(h)}
              onClick={() => playHit(h)}
              // 没勾的**不压暗、不去色**：这一屏是拿来比"像不像"的，把没勾的调暗，
              // 等于在人还没判断之前就先把画面改了，还怎么比。选没选只体现在
              // 勾选框和边框上——那是状态，不该动图本身
              style={{ width: 150, border: `2px solid ${isPlaying(h) ? "#faad14" : isDropped(h) ? "#f0f0f0" : "#52c41a"}`, borderRadius: 6, padding: 3, cursor: "pointer", background: isPlaying(h) ? "rgba(250,173,20,0.08)" : isDropped(h) ? undefined : "rgba(82,196,26,0.08)", position: "relative" }}
              title={`${h.sample_code ?? h.path} · ${formatMs(h.t * 1000)} · 综合 ${h.score.toFixed(3)}${h.vis_score != null ? ` · 画面 ${h.vis_score.toFixed(3)}` : ""}${h.pose_score != null ? ` · 姿态 ${h.pose_score.toFixed(3)}` : ""}`}
            >
              {/* 勾选框盖在图上：点它只管要不要，别顺带把这几秒放起来 */}
              <Tooltip title={defaultLabel ? undefined : "先在左上角选「标成」哪个类别，再勾"}>
                <Checkbox
                  checked={!isDropped(h)}
                  disabled={!defaultLabel}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(h)}
                  style={{ position: "absolute", top: 6, left: 6, zIndex: 2, background: "rgba(0,0,0,0.45)", borderRadius: 3, padding: "0 3px" }}
                />
              </Tooltip>
              <img src={url(h.path, h.t)} alt="" loading="lazy" style={{ width: "100%", height: 110, objectFit: "contain", background: "#000", borderRadius: 4 }} />
              <div style={{ fontSize: 12, lineHeight: 1.4, marginTop: 2, display: "flex", justifyContent: "space-between", gap: 4 }}>
                <span style={{ color: "#999" }}>#{ordered.indexOf(h) + 1}</span>
                <span style={{ color: scoreColor(keyOf(h)), fontWeight: 600 }}>{keyOf(h).toFixed(3)}</span>
              </div>
              {/* 勾中的才显示类别：检索是按"长得像"找的，混进别的动作很正常
                  （舔着舔着开始甩身体）。在这儿当场改掉，比写完一堆错类别再回去
                  一条条改省事得多 */}
              {!isDropped(h) && labelNames.length > 0 && (
                <Select
                  size="small"
                  variant="borderless"
                  value={picked.get(hitKeyOf(h))}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(v) => relabel(h, v)}
                  style={{ width: "100%", marginTop: 2 }}
                  popupMatchSelectWidth={180}
                  title="这一帧标成哪个类别"
                  options={labelNames.map((l) => ({
                    value: l.name,
                    label: <Tag color={l.color || undefined} style={{ marginRight: 0 }}>{l.name}</Tag>,
                  }))}
                />
              )}
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
    </div>
  );
}
