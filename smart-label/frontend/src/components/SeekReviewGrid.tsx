import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Empty, Segmented, Select, Space, Spin, Tag, Tooltip, Typography, message } from "antd";
import { SIMILAR_VIEW_HELP, SIMILAR_VIEW_OPTIONS, similarThumbTokens, similarThumbUrl, type SimilarThumbView } from "@/api/candidates";
import { writeVisionSeekPicks, type SeekFound } from "@/api/projects";
import { formatMs } from "@/components/SegmentPanel";

/**
 * 「画面找片段」跑完之后的筛选屏：跟「找相似」那一屏同一套操作。
 *
 * 为什么要这一步：模型一次能出几千段，里面混着的错的要是直接写进候选，人得
 * **跨几十个任务**一条条排除——每条都要开任务、找到那一行、点排除。摆成一屏
 * 缩略图，一眼扫过去勾几下就完事，类别不对也能当场改（模型常把舔和啃弄混）。
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

  const urlOf = (f: SeekFound) => {
    const tk = tokens[String(f.task_id)];
    return tk ? similarThumbUrl(f.task_id, f.path, f.t, tk, view) : "";
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
    return <Empty description="没有待筛的段（跑的时候勾上「先筛一遍再写」才会攒到这儿）" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Space size={8} style={{ marginBottom: 6 }} wrap>
        <Typography.Text strong>待筛 {found.length} 段</Typography.Text>
        <Tooltip title="勾上的才写成候选，默认一张都不勾。看着对的勾上；类别不对当场改（模型常把舔和啃弄混）">
          <Typography.Text type={picked.size ? "success" : "secondary"} style={{ fontSize: 12 }}>
            要 {picked.size} / {found.length}
          </Typography.Text>
        </Tooltip>
        <Button size="small" onClick={() => bulk(true)}>这一屏全要</Button>
        <Button size="small" onClick={() => bulk(false)}>这一屏全不要</Button>
        {labelCounts.length > 1 && (
          <Tooltip title="一类一类地筛比混着筛准：同一个动作连着看，标准不会飘">
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
          图是这一段**中点**那一帧（整帧带框最看得出在干嘛）。鼠标悬停看模型说了什么
        </Typography.Text>
      </Space>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexWrap: "wrap", gap: 8, alignContent: "flex-start" }}>
        {shown.map((f) => {
          const k = keyOf(f);
          const on = picked.has(k);
          return (
            <div
              key={k}
              onClick={() => toggle(f)}
              style={{ width: 160, border: `2px solid ${on ? "#52c41a" : "#f0f0f0"}`, background: on ? "rgba(82,196,26,0.08)" : undefined, borderRadius: 6, padding: 3, cursor: "pointer", position: "relative" }}
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
              {on && labelNames.length > 0 ? (
                <Select
                  size="small"
                  variant="borderless"
                  value={picked.get(k)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(v) => relabel(f, v)}
                  style={{ width: "100%" }}
                  popupMatchSelectWidth={200}
                  title="这一段标成哪个类别"
                  options={labelNames.map((l) => ({ value: l.name, label: <Tag color={l.color || undefined} style={{ marginRight: 0 }}>{l.name}</Tag> }))}
                />
              ) : (
                <div style={{ fontSize: 12, marginTop: 2 }}><Tag style={{ marginRight: 0 }}>{f.label_name}</Tag></div>
              )}
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
  );
}
