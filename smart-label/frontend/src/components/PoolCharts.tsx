import { useMemo, useState } from "react";
import { Card, Col, Empty, Row, Segmented, Tooltip, Typography, theme } from "antd";
import type { PoolBucket, PoolSummary } from "@/api/dataPool";

/**
 * 数据池统计的图：每个维度一张横向条形图（一个量、一种颜色——比的是大小，不需要分色图例），
 * 日期单独一张按天的柱图。段数 / 时长切换；悬停看两个数；点一根条 = 按它筛选。
 */
type Metric = "n" | "hours";

const fmtH = (h: number) => {
  const s = Math.round(h * 3600);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`;
};
const fmtShortH = (h: number) => (h >= 1 ? `${h.toFixed(1)}h` : h * 60 >= 1 ? `${(h * 60).toFixed(0)}m` : `${Math.round(h * 3600)}s`);

function BarList({ title, rows, metric, onPick, active, top = 8 }: {
  title: string;
  rows: PoolBucket[];
  metric: Metric;
  onPick?: (b: PoolBucket) => void;
  /** 已经按它筛了的名字：条加深 */
  active?: (b: PoolBucket) => boolean;
  top?: number;
}) {
  const { token } = theme.useToken();
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => [...rows].sort((a, b) => b[metric] - a[metric]), [rows, metric]);
  const shown = all ? sorted : sorted.slice(0, top);
  const max = Math.max(1e-9, ...sorted.map((b) => b[metric]));
  const total = sorted.reduce((s, b) => s + b[metric], 0) || 1;
  return (
    <Card size="small" title={title} styles={{ body: { padding: "8px 12px" } }}
      extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{rows.length} 个</Typography.Text>}>
      {!sorted.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有" /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {shown.map((b) => {
            const v = b[metric];
            const on = active?.(b);
            return (
              <Tooltip key={`${b.id ?? ""}-${b.name}`} placement="right"
                title={<span>{b.name}<br />{b.n} 段 · {fmtH(b.hours)}<br />占 {((v / total) * 100).toFixed(1)}%{onPick ? <><br />点一下按它筛</> : null}</span>}>
                <div onClick={() => onPick?.(b)}
                  style={{ display: "grid", gridTemplateColumns: "minmax(70px, 34%) 1fr auto", alignItems: "center", gap: 8,
                    cursor: onPick ? "pointer" : "default", padding: "2px 0" }}>
                  <span style={{ fontSize: 12, color: token.colorText, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                  <div style={{ height: 12, background: token.colorFillTertiary, borderRadius: 4 }}>
                    <div style={{ width: `${Math.max(1.5, (v / max) * 100)}%`, height: "100%", borderRadius: 4,
                      background: token.colorPrimary, opacity: on ? 1 : 0.7 }} />
                  </div>
                  <span style={{ fontSize: 12, color: token.colorTextSecondary, minWidth: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {metric === "n" ? b.n : fmtShortH(b.hours)}
                  </span>
                </div>
              </Tooltip>
            );
          })}
          {sorted.length > top && (
            <Typography.Link style={{ fontSize: 12 }} onClick={() => setAll(!all)}>
              {all ? "收起" : `全部 ${sorted.length} 个`}
            </Typography.Link>
          )}
        </div>
      )}
    </Card>
  );
}

/** 按天的柱图：时间轴横着走，看哪几天数据多、有没有断档 */
function DateColumns({ rows, metric, onPick, height = 120 }: {
  rows: PoolBucket[];
  metric: Metric;
  onPick?: (date: string) => void;
  height?: number;
}) {
  const { token } = theme.useToken();
  // 没数据的日子补 0：断档要看得出来，不能把前后两天挤在一起
  const days = useMemo(() => {
    const have = [...rows].filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (have.length < 2) return have;
    const by = new Map(have.map((b) => [b.name, b]));
    const out: PoolBucket[] = [];
    const d = new Date(`${have[0].name}T00:00:00`);
    const end = new Date(`${have[have.length - 1].name}T00:00:00`);
    while (d <= end && out.length < 400) {
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      out.push(by.get(k) ?? { name: k, n: 0, hours: 0 });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }, [rows]);
  if (!days.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有日期" />;
  const max = Math.max(1e-9, ...days.map((b) => b[metric]));
  const labelEvery = Math.max(1, Math.ceil(days.length / 10));
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height, borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        {days.map((b) => (
          <Tooltip key={b.name} title={<span>{b.name}<br />{b.n ? `${b.n} 段 · ${fmtH(b.hours)}` : "这天没有"}{onPick && b.n ? <><br />点一下只看这天</> : null}</span>}>
            <div onClick={() => b.n && onPick?.(b.name)}
              style={{ flex: 1, minWidth: 3, height: "100%", display: "flex", alignItems: "flex-end", cursor: onPick ? "pointer" : "default" }}>
              <div style={{ width: "100%", height: b[metric] > 0 ? `${Math.max(2, (b[metric] / max) * 100)}%` : 0, background: token.colorPrimary,
                opacity: 0.75, borderRadius: "4px 4px 0 0" }} />
            </div>
          </Tooltip>
        ))}
      </div>
      <div style={{ display: "flex", gap: 2, marginTop: 4 }}>
        {days.map((b, i) => (
          <div key={b.name} style={{ flex: 1, minWidth: 3, fontSize: 10, color: token.colorTextTertiary, whiteSpace: "nowrap", overflow: "visible" }}>
            {i % labelEvery === 0 ? b.name.slice(5) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PoolCharts({ sum, onPickRoot, onPickLabel, onPickProject, onPickDog, onPickHz, onPickDate, picked }: {
  sum: PoolSummary | undefined;
  onPickRoot: (name: string) => void;
  onPickLabel: (name: string) => void;
  onPickProject: (id: number) => void;
  onPickDog: (id: number) => void;
  onPickHz: (hz: number) => void;
  onPickDate: (date: string) => void;
  picked: { labels: string[]; projects: number[]; dogs: number[]; hzs: number[] };
}) {
  const [metric, setMetricState] = useState<Metric>(() => {
    try { return localStorage.getItem("smart-label:pool-metric") === "hours" ? "hours" : "n"; } catch { return "n"; }
  });
  const setMetric = (m: Metric) => { setMetricState(m); try { localStorage.setItem("smart-label:pool-metric", m); } catch { /* ignore */ } };
  if (!sum) return null;
  // 细类：跟大类同名的那一行是「只标到大类、没细分」的那部分，写清楚
  const roots = new Set(sum.by_root.map((b) => b.name));
  const leaves = sum.by_label.map((b) => (roots.has(b.name) ? { ...b, name: `${b.name}（未细分）`, pickName: b.name } : { ...b, pickName: b.name }));
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Segmented size="small" value={metric} onChange={(v) => setMetric(v as Metric)}
          options={[{ value: "n", label: "按段数" }, { value: "hours", label: "按时长" }]} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>悬停看段数和时长，点一根条就按它筛选</Typography.Text>
      </div>
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={10}>
          <BarList title="类别" rows={sum.by_root} metric={metric} top={12}
            onPick={(b) => onPickRoot(b.name)} active={(b) => picked.labels.includes(b.name)} />
        </Col>
        <Col xs={24} lg={14}>
          <Card size="small" title="按天" styles={{ body: { padding: "12px 12px 8px" } }}
            extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{(sum.by_date ?? []).length} 天</Typography.Text>}>
            <DateColumns rows={sum.by_date ?? []} metric={metric} onPick={onPickDate} height={170} />
          </Card>
        </Col>
        <Col xs={24} md={12} xl={6}>
          <BarList title="细类" rows={leaves} metric={metric}
            onPick={(b) => onPickLabel((b as PoolBucket & { pickName?: string }).pickName ?? b.name)}
            active={(b) => picked.labels.includes((b as PoolBucket & { pickName?: string }).pickName ?? b.name)} />
        </Col>
        <Col xs={24} md={12} xl={6}>
          <BarList title="项目" rows={sum.by_project} metric={metric}
            onPick={(b) => b.id != null && onPickProject(b.id)} active={(b) => b.id != null && picked.projects.includes(b.id)} />
        </Col>
        <Col xs={24} md={12} xl={6}>
          <BarList title="狗" rows={sum.by_dog} metric={metric}
            onPick={(b) => b.id != null && onPickDog(b.id)} active={(b) => b.id != null && picked.dogs.includes(b.id)} />
        </Col>
        <Col xs={24} md={12} xl={6}>
          <BarList title="采样率" rows={sum.by_hz} metric={metric}
            onPick={(b) => { const hz = parseInt(b.name, 10); if (hz) onPickHz(hz); }}
            active={(b) => picked.hzs.includes(parseInt(b.name, 10))} />
        </Col>
      </Row>
    </div>
  );
}
