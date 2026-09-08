import type { CSide, STotalOut, TrackingRow } from "@/api/skin";

/**
 * 跟踪表里几个数字的「怎么来的」——鼠标放上去弹出来的那张小算式表。
 *
 * 表格里只放得下一个 85 分、一个 57 次，光看数字没人知道从哪来：C 值是四项
 * 加出来的（还可能被红旗直接顶到 C2，跟总分无关），S 是三部分按权重加的，
 * 抓挠次数则要说清楚它统计的是哪段时间。规则都在 label_service 那边算好了
 * （c_detail / s_no_q 里就带着各项得分），这里只负责摊开来显示，不重算——
 * 重算就会有两套规则，迟早对不上。
 */

const num = (v: unknown, digits = 1) =>
  typeof v === "number" && Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(digits)) : "—";

/**
 * antd 的 tooltip 默认最宽 250px，内层 div 写多宽都没用（外面那层会把它压回去），
 * 于是每行都折成三四行、挤成一坨。这份 props 摊到 Tooltip 上把外层一起放宽，
 * 并让宽度跟着内容走（max-content），短的不留白、长的到 560 才折。
 */
export const EXPLAIN_TOOLTIP = {
  overlayStyle: { maxWidth: 560 },
  overlayInnerStyle: { width: "max-content", maxWidth: 560 },
} as const;

function Row({ name, value, note }: { name: string; value: string; note?: string }) {
  return (
    <div style={{ display: "flex", gap: 10, lineHeight: "20px", whiteSpace: "nowrap" }}>
      <span style={{ flex: "0 0 76px", opacity: 0.75 }}>{name}</span>
      <span style={{ flex: "0 0 66px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{value}</span>
      {note && <span style={{ opacity: 0.65 }}>{note}</span>}
    </div>
  );
}

const Title = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontWeight: 600, marginBottom: 4 }}>{children}</div>
);

const Foot = ({ children }: { children: React.ReactNode }) => (
  <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px solid rgba(255,255,255,0.25)" }}>{children}</div>
);

/** C 值：四项打分 + 红旗规则 */
export function CExplain({ side, source }: { side: CSide | null | undefined; source?: string | null }) {
  if (!side) return <span>还没算过这天的 C 值</span>;
  const d = side.c_detail;
  const cin = side.c_inputs ?? {};
  const who = source === "human" ? "人工版" : "AI 版";
  if (!d?.components) {
    // 老数据是在存 c_detail 之前算的，只有结果没有过程；说清楚而不是装作没有
    return (
      <div style={{ maxWidth: 320 }}>
        <Title>C 值 {num(side.c_value)} → {side.c_tier}（{who}）</Title>
        <div style={{ opacity: 0.75 }}>这天是旧版本算的，没存下各项得分。去「项目联动」重新拉取一次就有了。</div>
      </div>
    );
  }
  const c = d.components;
  return (
    <div>
      <Title>C 值 {num(d.total)} / {d.max_possible} → {d.tier}（{who}）</Title>
      {/* note 由 label_service 生成：里面写明命中了哪一档，比在前端拼一遍安全 */}
      <Row
        name="变化幅度"
        value={`${num(c.delta.score)} / ${c.delta.max}`}
        note={
          c.delta.note ??
          (c.delta.counted === false
            ? "没有基线，这项不计分"
            : `按${c.delta.by ?? "次数"}比基线 ${c.delta.ratio != null ? `${c.delta.ratio.toFixed(2)} 倍` : ""}`)
        }
      />
      <Row
        name="聚集程度"
        value={`${num(c.cluster.score)} / ${c.cluster.max}`}
        note={c.cluster.note ?? `聚集时段 ${num(cin.cluster_count)} 个`}
      />
      <Row
        name="持续程度"
        value={`${num(c.persistence.score)} / ${c.persistence.max}`}
        note={c.persistence.note ?? `连续 ${num(cin.persistence_days)} 天`}
      />
      <Row
        name="中断影响"
        value={`${num(c.interruption.score)} / ${c.interruption.max}`}
        note={c.interruption.note ?? `打断睡眠 ${num(cin.zd)} 次${cin.long_scratch ? "、有长时间抓挠" : ""}`}
      />
      <Foot>
        <Row name="合计" value={num(d.total)} note={`≥50 判 C2，≥30 判 C1，否则 C0`} />
        {d.red_flags?.length ? (
          <div style={{ marginTop: 4, maxWidth: 460, whiteSpace: "normal" }}>🚩 {d.red_flags.join("、")} —— 红旗直接判 C2，不看总分</div>
        ) : null}
        {d.has_baseline === false && (
          <div style={{ marginTop: 4, opacity: 0.8, maxWidth: 460, whiteSpace: "normal" }}>
            ⚠️ 还没有个人基线，「变化幅度」不计分，上限只有 70 分，会偏低；这是「信息不足」，不是「确实没变化」
          </div>
        )}
      </Foot>
    </div>
  );
}

/** S 总分：C 占 40%、皮肤组 35%、毛发组 25% */
export function SExplain({ s, withQ }: { s: STotalOut | null | undefined; withQ: boolean }) {
  if (!s || s.total == null) return <span>还没算出这天的 S 总分</span>;
  return (
    <div>
      <Title>S 总分 {num(s.total)} → {s.s_tier}（{withQ ? "含问答" : "问答留空"}）</Title>
      <Row name="C 值 ×40%" value={num(s.c_score)} note={`C=${num(s.c_value_used)}`} />
      <Row name="皮肤组 ×35%" value={num(s.skin_group_score)} note={`原始分 ${num(s.skin_group_raw)}`} />
      <Row name="毛发组 ×25%" value={num(s.hair_group_score)} note={`原始分 ${num(s.hair_group_raw)}`} />
      <Foot>
        <Row name="合计" value={num(s.total)} note={s.s_tier ?? ""} />
        {!withQ && (
          <div style={{ marginTop: 4, opacity: 0.8, maxWidth: 460, whiteSpace: "normal" }}>
            问答留空时皮肤组/毛发组都按 0 分算，所以这是这一天的下限，只有 C 值那 40% 在起作用
          </div>
        )}
        {s.red_flags?.length ? <div style={{ marginTop: 4 }}>🚩 {s.red_flags.join("、")} —— 直接判 S2</div> : null}
      </Foot>
    </div>
  );
}

/**
 * AI 版 / 人工版两个 C 值和它们的差。
 *
 * 这一列最容易被误读成"模型错得离谱"：人工版只统计**已提交/已通过**任务里的
 * 抓挠，这天还有一半时段没审核通过，人工版当然只看得见一部分片段，次数少、
 * C 值自然低。差得多不一定是模型有问题，先看这天审完了几个时段。
 */
export function DeltaExplain({ r }: { r: TrackingRow }) {
  const tasks = r.tasks_detail ?? [];
  const done = tasks.filter((t) => t.status === "APPROVED" || t.status === "SUBMITTED").length;
  const partial = tasks.length > 0 && done < tasks.length;
  return (
    <div style={{ maxWidth: 460 }}>
      <Title>AI 版 vs 人工版 C 值</Title>
      <Row name="AI 版" value={num(r.c_ai?.c_value)} note={r.c_ai?.c_tier ?? ""} />
      <Row name="人工版" value={num(r.c_human?.c_value)} note={r.c_human?.c_tier ?? ""} />
      <Row name="Δ（人工−AI）" value={r.delta_c != null ? (r.delta_c > 0 ? `+${r.delta_c}` : String(r.delta_c)) : "—"} />
      <Foot>
        <div style={{ opacity: 0.85 }}>
          AI 版 = 稳定版预标注的原始结果，人改了也不受影响；人工版 = 已提交/已通过任务里当前的片段。
        </div>
        {tasks.length > 0 && (
          <div style={{ marginTop: 4 }}>
            这天 {tasks.length} 个时段，已提交/通过 {done} 个。
            {partial && (
              <b>
                {" "}
                剩下 {tasks.length - done} 个还没审，人工版只看得见已通过那部分的抓挠，次数天然偏少、C 值偏低
                —— 差得多不代表模型错，等这天全部审完再比。
              </b>
            )}
          </div>
        )}
      </Foot>
    </div>
  );
}

/** 抓挠次数/时长：说清楚统计的是哪段时间、跟基线比怎么样 */
export function ScratchExplain({ r }: { r: TrackingRow }) {
  const st = r.stats ?? {};
  const n = st.event_count as number | undefined;
  const min = st.total_duration_min as number | undefined;
  const wear = st.valid_wear_hours as number | undefined;
  const ratio = r.baseline_count && n != null ? n / r.baseline_count : null;
  return (
    <div style={{ maxWidth: 460 }}>
      <Title>这天的抓挠</Title>
      <Row name="次数" value={`${num(n)} 次`} />
      <Row name="总时长" value={`${num(min)} 分`} note={n ? `平均每次 ${num(((min ?? 0) * 60) / n)} 秒` : undefined} />
      <Row name="有效佩戴" value={`${num(wear)} 小时`} />
      <Foot>
        <div style={{ opacity: 0.8 }}>
          统计口径：这一天有效佩戴时段内、所有时段任务加起来的抓挠片段，按{" "}
          {r.c_source === "human" ? "人工确认后的片段" : "AI 预标注结果"}算。
        </div>
        {r.baseline_count != null && (
          <div style={{ marginTop: 4 }}>
            基线（这只狗别的日子的中位数）{num(r.baseline_count)} 次
            {ratio != null && <>，今天是基线的 {ratio.toFixed(2)} 倍</>}
            {r.n_baseline_days != null && <>（取自 {num(r.n_baseline_days)} 天）</>}
          </div>
        )}
      </Foot>
    </div>
  );
}
