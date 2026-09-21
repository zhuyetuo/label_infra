import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Empty, Segmented, Select, Space, Spin, Tag, Tooltip, Typography, message } from "antd";
import { SIMILAR_VIEW_HELP, SIMILAR_VIEW_OPTIONS, similarThumbTokens, similarThumbUrl, type SimilarThumbView } from "@/api/candidates";
import { writeVisionSeekPicks, type SeekFound } from "@/api/projects";
import SimilarClipPlayer, { type Clip } from "@/components/SimilarClipPlayer";
import { formatMs } from "@/components/SegmentPanel";

/**
 * 「大模型看视频找动作」跑完之后的筛选屏：左边操作台（大图 / 循环播放 / 模型说了什么 /
 * 改类别），右边一屏结果。跟「找相似」那一屏同一套操作，别让人学两遍。
 *
 * 为什么要这一步：模型一次能出几千段，里面混着的错的要是直接写进候选，人得
 * **跨几十个任务**一条条排除——每条都要开任务、找到那一行、点排除。摆成一屏
 * 缩略图，一眼扫过去勾几下就完事，类别不对也能当场改（模型常把舔和啃弄混，
 * 部位那一层更是实测判不准）。
 */

const keyOf = (f: SeekFound) => `${f.task_id}@${f.start_ms}`;

interface Props {
  projectId: number;
  found: SeekFound[];
  /** 项目里可选的类别：某一段的类别不对时当场改 */
  labelNames?: { name: string; color?: string | null }[];
  /** 写完之后刷新外面的进度/列表 */
  onWritten?: (written: number, left: number) => void;
}

export default function SeekReviewGrid({ projectId, found, labelNames = [], onWritten }: Props) {
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [view, setView] = useState<SimilarThumbView>("box");
  // 勾中的 → 标成哪个类别。**默认一张都不勾**：模型出的这一批里错的不少，
  // 默认全勾等于让人去挑错的那些，挑漏一张就多一条脏候选
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [labelFilter, setLabelFilter] = useState<string[]>([]);
  const [cur, setCur] = useState<SeekFound | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [busy, setBusy] = useState(false);

  // 一屏的段横跨几十上百个任务，一个个换 token 就是几十上百个请求
  useEffect(() => {
    const ids = [...new Set(found.map((f) => f.task_id))].slice(0, 500);
    if (!ids.length) return;
    let alive = true;
    similarThumbTokens(ids).then((r) => alive && setTokens(r.tokens)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [found]);

  const labelCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of found) m.set(f.label_name, (m.get(f.label_name) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [found]);
  // 一类一类地筛比混着筛准得多：同一个动作连着看，标准不会飘
  const shown = labelFilter.length ? found.filter((f) => labelFilter.includes(f.label_name)) : found;

  const urlOf = (f: SeekFound, v: SimilarThumbView = view) => {
    const tk = tokens[String(f.task_id)];
    return tk ? similarThumbUrl(f.task_id, f.path, f.t, tk, v) : "";
  };
  const toggle = (f: SeekFound) => {
    const next = new Map(picked);
    const k = keyOf(f);
    if (next.has(k)) next.delete(k);
    else next.set(k, f.label_name);
    setPicked(next);
  };
  const bulk = (keep: boolean) => {
    const next = new Map(picked);
    for (const f of shown) {
      if (keep) next.set(keyOf(f), next.get(keyOf(f)) ?? f.label_name);
      else next.delete(keyOf(f));
    }
    setPicked(next);
  };
  const relabel = (f: SeekFound, name: string) => setPicked(new Map(picked).set(keyOf(f), name));
  // 点一张：左边看大图。**不顺带勾上**——看和选是两件事，混在一起就会出现
  // "只是想看看，结果给自己勾了一堆"
  const select = (f: SeekFound) => {
    setCur(f);
    setClip(f.sample_id != null && f.cam
      ? { key: keyOf(f), title: `${f.sample_code ?? f.path.split("/").pop()} · ${formatMs(f.start_ms)}`,
          sampleId: f.sample_id, cam: f.cam, t: f.t, hit: null, poster: urlOf(f) || undefined }
      : null);
  };
  // 换看法时左边那张大图跟着换，不然它停在上一种看法上，跟右边对不上
  useEffect(() => {
    if (cur) setClip((c) => (c ? { ...c, poster: urlOf(cur) || undefined } : c));
  }, [view, tokens]);

  const write = async () => {
    const picks = found.filter((f) => picked.has(keyOf(f)))
      .map((f) => ({ ...f, label_name: picked.get(keyOf(f))! }));
    if (!picks.length) return;
    setBusy(true);
    try {
      const r = await writeVisionSeekPicks(projectId, picks);
      message.success(`写了 ${r.written} 条候选，还剩 ${r.left} 段没处理`);
      setPicked(new Map());
      onWritten?.(r.written, r.left);
    } finally {
      setBusy(false);
    }
  };

  if (!found.length) {
    return <Empty description="没有待筛的段（跑的时候取消「只数会送多少段」、勾上「先筛一遍再写」才会攒到这儿）" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  const curKey = cur ? keyOf(cur) : null;
  return (
    <div style={{ display: "flex", gap: 12, height: "100%", minHeight: 0 }}>
      {/* 左：操作台。跟「找相似」那一屏一个位置一个用法 */}
      <div style={{ width: 380, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, gap: 8 }}>
        {cur ? (
          <>
            <div>
              <Typography.Text strong>
                {formatMs(cur.start_ms)} ~ {formatMs(cur.end_ms)}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                任务 #{cur.task_id} · {cur.sample_code ?? cur.path.split("/").pop()}
                {cur.confidence != null && ` · 置信 ${(cur.confidence * 100).toFixed(0)}%`}
              </Typography.Text>
            </div>
            <Space size={4} wrap>
              <Checkbox checked={picked.has(curKey!)} onChange={() => toggle(cur)}>
                <b>要这一段</b>
              </Checkbox>
              {/* 类别在左边也能改：右边卡片上那个太小，挑细部位时看不清 */}
              {labelNames.length > 0 && (
                <Select
                  size="small"
                  value={picked.get(curKey!) ?? cur.label_name}
                  onChange={(v) => { if (!picked.has(curKey!)) toggle(cur); relabel(cur, v); }}
                  style={{ minWidth: 190 }}
                  showSearch
                  optionFilterProp="value"
                  title="这一段标成哪个类别"
                  options={labelNames.map((l) => ({ value: l.name, label: <Tag color={l.color || undefined} style={{ marginRight: 0 }}>{l.name}</Tag> }))}
                />
              )}
              {/* 第一阶段（大模型找到第一张）→ 第二阶段（拿它去扩）的那根线。
                  没有它，人得记住"刚才那段在几分几秒"，再自己开任务、拖进度条、
                  点找相似——而那正是这一套工具最该省掉的那几步 */}
              <Tooltip title="拿这一段中点那一帧当样例，去整个项目里找长得像的几秒。类别和时刻都带过去，开新页">
                <Button size="small" type="primary" ghost
                  onClick={() => window.open(
                    `/tasks?task=${cur.task_id}&seek=${Math.round(cur.t * 1000)}&similar=1&slabel=${encodeURIComponent(picked.get(curKey!) ?? cur.label_name)}`,
                    "_blank")}>
                  用这一张去扩
                </Button>
              </Tooltip>
              <Button size="small" onClick={() => window.open(`/tasks?task=${cur.task_id}&seek=${cur.start_ms}`, "_blank")}>
                打开那个任务
              </Button>
            </Space>
            {/* 模型说了什么：很多明显不对的看这一句就能排掉，不用点开视频 */}
            <div style={{ fontSize: 12, color: "#888", maxHeight: 72, overflow: "auto", background: "rgba(0,0,0,0.03)", borderRadius: 4, padding: "4px 6px" }}>
              {cur.evidence ? `模型说：${cur.evidence}` : "这一段模型没给依据（老版本视觉服务不返回）"}
            </div>
            {clip ? (
              <SimilarClipPlayer taskId={cur.task_id} clip={clip} onClose={() => setClip(null)} />
            ) : (
              <div style={{ flex: 1, minHeight: 0, background: "#000", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {urlOf(cur) ? (
                  <img src={urlOf(cur)} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                ) : (
                  <Spin size="small" />
                )}
              </div>
            )}
          </>
        ) : (
          <div style={{ flex: 1, border: "1px dashed #d9d9d9", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "#999", fontSize: 13, padding: 12, textAlign: "center" }}>
            右边点一张：这里看大图、看模型说了什么，要看动作再点「循环播放」。
            <br />勾选框只管要不要，点图不会顺带勾上
          </div>
        )}
      </div>

      {/* 右：结果 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <Space size={8} style={{ marginBottom: 6 }} wrap>
          <Typography.Text strong>待筛 {found.length} 段</Typography.Text>
          <Tooltip title="勾上的才写成候选，默认一张都不勾。看着对的勾上；类别不对当场改（模型常把舔和啃弄混，部位那一层实测判不准）">
            <Typography.Text type={picked.size ? "success" : "secondary"} style={{ fontSize: 12 }}>
              要 {picked.size} / {found.length}
            </Typography.Text>
          </Tooltip>
          <Button size="small" onClick={() => bulk(true)}>这一屏全要</Button>
          <Button size="small" onClick={() => bulk(false)}>这一屏全不要</Button>
          {labelCounts.length > 1 && (
            <Tooltip title="一类一类地筛比混着筛准：同一个动作连着看，标准不会飘。上面两个批量按钮只作用在筛出来的这一屏">
              <Select
                size="small"
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                placeholder="只看类别"
                style={{ minWidth: 160, maxWidth: 320 }}
                value={labelFilter}
                onChange={setLabelFilter}
                options={labelCounts.map(([name, n]) => ({ value: name, label: `${name}（${n}）` }))}
              />
            </Tooltip>
          )}
          <Tooltip title={SIMILAR_VIEW_HELP}>
            <Segmented size="small" value={view} onChange={(v) => setView(v as SimilarThumbView)} options={SIMILAR_VIEW_OPTIONS} />
          </Tooltip>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            图是这一段中点那一帧（整帧带框最看得出在干嘛）
          </Typography.Text>
        </Space>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexWrap: "wrap", gap: 8, alignContent: "flex-start" }}>
          {shown.map((f) => {
            const k = keyOf(f);
            const on = picked.has(k);
            const now = k === curKey;
            return (
              <div
                key={k}
                onClick={() => select(f)}
                style={{ width: 160, border: `2px solid ${now ? "#faad14" : on ? "#52c41a" : "#f0f0f0"}`, background: now ? "rgba(250,173,20,0.08)" : on ? "rgba(82,196,26,0.08)" : undefined, borderRadius: 6, padding: 3, cursor: "pointer", position: "relative" }}
                title={`${f.sample_code ?? f.path} · ${formatMs(f.start_ms)} ~ ${formatMs(f.end_ms)}${f.confidence != null ? ` · 置信 ${(f.confidence * 100).toFixed(0)}%` : ""}${f.evidence ? `\n模型说：${f.evidence}` : ""}`}
              >
                <Checkbox
                  checked={on}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(f)}
                  style={{ position: "absolute", top: 6, left: 6, zIndex: 2, background: "rgba(0,0,0,0.45)", borderRadius: 3, padding: "0 3px" }}
                />
                {tokens[String(f.task_id)] ? (
                  // 图一律原样，不因为没勾就压暗——这一屏是拿来判断"是不是这个动作"的，
                  // 在人判断之前先把画面改了，还怎么判
                  <img src={urlOf(f)} alt="" loading="lazy" style={{ width: "100%", height: 110, objectFit: "contain", background: "#000", borderRadius: 4 }} />
                ) : (
                  <div style={{ height: 110, display: "flex", alignItems: "center", justifyContent: "center", background: "#000", borderRadius: 4 }}><Spin size="small" /></div>
                )}
                <div style={{ fontSize: 12, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <Tag style={{ marginRight: 0 }} color={on ? "green" : undefined}>{picked.get(k) ?? f.label_name}</Tag>
                </div>
                <div style={{ fontSize: 11, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.confidence != null ? `${(f.confidence * 100).toFixed(0)}% · ` : ""}
                  {formatMs(f.start_ms)} · #{f.task_id} {f.sample_code ?? ""}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 8, textAlign: "right" }}>
          <Button type="primary" loading={busy} disabled={!picked.size} onClick={write}>
            写入候选（要 {picked.size} / {found.length} 段）
          </Button>
        </div>
      </div>
    </div>
  );
}
