import { useMemo, useState } from "react";
import {
  Alert, Button, Card, Checkbox, Col, DatePicker, Descriptions, Form, InputNumber, Popconfirm, Row, Select, Space, Spin,
  Statistic, Table, Tag, Tooltip, Typography, message,
} from "antd";
import dayjs from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getSkinDataRange, mlAddExtra, mlModelStatus, mlRemoveExtra, mlRetrainSynthetic, mlScenarios, mlSimulate, skinDailyTracking,
  type MlScenario, type MlSimDay, type MlSimResult, type TrackingRow,
} from "@/api/skin";
import DogMetaFilter, { dogMetaText, dogOptions, matchDogMeta, type DogMetaValue } from "@/components/DogMetaFilter";
import { RealRetrainCard } from "@/components/SkinAccuracy";
import { MlExplainDrawer } from "@/components/SkinMlExplain";

const tierColor = (t?: string | null) => (t?.endsWith("2") ? "red" : t?.endsWith("1") ? "orange" : t ? "green" : undefined);
const pct = (x?: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const probaText = (p?: Record<string, number>) => (p ? Object.entries(p).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" · ") : "");

// ── ML 结果：每只狗每天，模型 A / B 怎么判 ─────────────────────────────────

export function MlResults() {
  const { data: range } = useQuery({ queryKey: ["skin-data-range"], queryFn: getSkinDataRange });
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const f0 = from ?? (range?.date_to ? dayjs(range.date_to).subtract(13, "day").format("YYYY-MM-DD") : null);
  const t0 = to ?? range?.date_to ?? null;
  const [cPrefer, setCPrefer] = useState<"ai" | "human">("ai");
  const { data, isFetching } = useQuery({
    queryKey: ["skin-ml-results", f0, t0, cPrefer],
    queryFn: () => skinDailyTracking({ date_from: f0!, date_to: t0!, c_prefer: cPrefer }),
    enabled: !!f0 && !!t0,
    refetchOnWindowFocus: false,
  });
  const { data: st } = useQuery({ queryKey: ["skin-ml-status"], queryFn: mlModelStatus, retry: false });
  const [meta, setMeta] = useState<DogMetaValue>({});
  const [explain, setExplain] = useState<{ imu: string; date: string; dog?: string } | null>(null);
  const open = (r: TrackingRow) => setExplain({ imu: r.imu, date: r.date, dog: r.dog_name });
  const [dogs, setDogs] = useState<string[]>([]);
  const all = data?.rows ?? [];
  const metaRows = all.filter((r) => matchDogMeta(r, meta));
  const rows = metaRows.filter((r) => !dogs.length || dogs.includes(r.dog_name));
  const withMl = rows.filter((r) => r.ml?.s_tier);
  const pmS = (r: TrackingRow) => (r.s_with_q ?? r.s_no_q)?.s_tier;
  const count = (k: (r: TrackingRow) => string | null | undefined, v: string) => withMl.filter((r) => k(r) === v).length;

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <DatePicker.RangePicker
          value={f0 && t0 ? [dayjs(f0), dayjs(t0)] : null}
          onChange={(v) => { if (v?.[0] && v[1]) { setFrom(v[0].format("YYYY-MM-DD")); setTo(v[1].format("YYYY-MM-DD")); } }}
          allowClear={false}
        />
        <Select mode="multiple" allowClear showSearch placeholder="全部狗" style={{ width: 220 }} maxTagCount="responsive"
          value={dogs} onChange={setDogs} options={dogOptions(metaRows)} />
        <DogMetaFilter rows={all} value={meta} onChange={(p) => setMeta((m) => ({ ...m, ...p }))} />
        <Select size="middle" style={{ width: 170 }} value={cPrefer} onChange={setCPrefer}
          options={[{ value: "ai", label: "输入用 AI 版事件" }, { value: "human", label: "人工版优先" }]} />
        {st && <Tag color={st.active === "real" ? "purple" : "default"}>模型 B：{st.active === "real" ? "兽医评级训练版" : "合成数据版"}</Tag>}
      </Space>

      {isFetching && !all.length && <Spin />}
      {!isFetching && all.length > 0 && !all.some((r) => r.ml) && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message="这段日期还没有 ML 结果：去「PM 版 → 每日跟踪（自动）→ 项目联动」点一次「重新拉取」，ML 跟 C 值一起算" />
      )}

      {withMl.length > 0 && (
        <Row gutter={12} style={{ marginBottom: 12 }}>
          <Col xs={12} md={6}><Card size="small"><Statistic title="有 ML 结果的天" value={withMl.length} suffix={`/ ${rows.length}`} /></Card></Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="ML S 档分布" value={["S0", "S1", "S2"].map((g) => `${g} ${count((r) => r.ml?.s_tier, g)}`).join(" · ")} valueStyle={{ fontSize: 16 }} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="PM S 档分布（同样这些天）" value={["S0", "S1", "S2"].map((g) => `${g} ${count(pmS, g)}`).join(" · ")} valueStyle={{ fontSize: 16 }} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="ML 跟 PM 的 S 档一致" value={pct(withMl.filter((r) => r.ml?.s_tier === pmS(r)).length / withMl.length)} />
            </Card>
          </Col>
        </Row>
      )}

      <Table
        size="small" rowKey={(r) => `${r.date}-${r.imu}`} loading={isFetching && !data} dataSource={rows}
        pagination={{ pageSize: 50, hideOnSinglePage: true }} scroll={{ x: "max-content" }}
        columns={[
          { title: "日期", dataIndex: "date", width: 110, sorter: (a: TrackingRow, b: TrackingRow) => a.date.localeCompare(b.date), defaultSortOrder: "descend" as const },
          { title: "狗", width: 170, render: (_: unknown, r: TrackingRow) => <div>{r.dog_name}<div style={{ fontSize: 11, color: "#888", whiteSpace: "nowrap" }}>{dogMetaText(r)}</div></div> },
          { title: "抓挠", render: (_: unknown, r: TrackingRow) => {
            const s = r.stats as { event_count?: number; total_duration_min?: number } | null;
            return s?.event_count != null ? `${s.event_count} 次 / ${(s.total_duration_min ?? 0).toFixed(1)} 分` : "—";
          } },
          {
            title: <Tooltip title="模型 A 预测的 C 档（本质是 PM 抓挠规则的近似）">ML C</Tooltip>,
            render: (_: unknown, r: TrackingRow) => r.ml?.c_tier
              ? <Tooltip title={`${probaText(r.ml.c_proba)}（点开看为什么）`}><Tag color={tierColor(r.ml.c_tier)} style={{ cursor: "pointer" }} onClick={() => open(r)}>{r.ml.c_tier}</Tag></Tooltip>
              : <Tooltip title={r.ml?.reason}><Typography.Text type="secondary">—</Typography.Text></Tooltip>,
          },
          {
            title: <Tooltip title="模型 B 预测的 S 档；有问卷的天会用上问卷">ML S</Tooltip>,
            sorter: (a: TrackingRow, b: TrackingRow) => (a.ml?.s_tier ?? "").localeCompare(b.ml?.s_tier ?? ""),
            render: (_: unknown, r: TrackingRow) => r.ml?.s_tier
              ? (
                <Tooltip title={`${probaText(r.ml.s_proba)}${r.ml.used_questionnaire ? "（用上了问卷）" : ""}（点开看为什么）`}>
                  <Tag color={tierColor(r.ml.s_tier)} style={{ cursor: "pointer" }} onClick={() => open(r)}>{r.ml.s_tier}</Tag>{r.ml.used_questionnaire && <Typography.Text type="secondary" style={{ fontSize: 11 }}>问卷</Typography.Text>}
                </Tooltip>
              )
              : <Typography.Text type="secondary">—</Typography.Text>,
          },
          {
            title: "", key: "why", render: (_: unknown, r: TrackingRow) =>
              r.ml?.s_tier ? <Button size="small" type="link" onClick={() => open(r)}>为什么</Button> : null,
          },
          { title: "PM C", render: (_: unknown, r: TrackingRow) => r.c_tier ? <span>{r.c_value} <Tag color={tierColor(r.c_tier)}>{r.c_tier}</Tag></span> : "—" },
          { title: "PM S", render: (_: unknown, r: TrackingRow) => pmS(r) ? <Tag color={tierColor(pmS(r))}>{pmS(r)}</Tag> : "—" },
          {
            title: "照片评级", render: (_: unknown, r: TrackingRow) => {
              const g = r.photo_grade_vet ?? r.photo_grade;
              if (!g) return "—";
              return <Tooltip title={r.photo_grade_vet ? "兽医评的" : "非兽医评的"}><Tag color={tierColor(g)}>{g === "unsure" ? "看不清" : g}{r.photo_grade_vet ? "（兽医）" : ""}</Tag></Tooltip>;
            },
          },
        ]}
      />
      <MlExplainDrawer target={explain} cPrefer={cPrefer} onClose={() => setExplain(null)} />
    </div>
  );
}

// ── 模拟：按参数造一只狗的抓挠历史，看模型怎么判 ─────────────────────────

const PATTERNS: { value: string; label: string; days: string[] }[] = [
  { value: "stable", label: "一直平稳", days: [] },
  { value: "step_onset", label: "某天突然变多（阶跃）", days: ["onset_day"] },
  { value: "ramp_onset", label: "慢慢变多（爬坡）", days: ["onset_day", "peak_day"] },
  { value: "spike_recover", label: "一阵变多又好了", days: ["onset_day", "recover_day"] },
  { value: "gradual_decline_recovery", label: "一开始就多、慢慢好转", days: ["onset_day", "recover_day"] },
  { value: "single_day_spike", label: "只有一天特别多", days: ["spike_day"] },
  { value: "cyclical", label: "反反复复（周期）", days: ["onset_day", "cycle_period_days", "n_cycles"] },
  { value: "chronic_high_from_start", label: "从头到尾都多（慢性）", days: [] },
];
const DAY_LABEL: Record<string, string> = {
  onset_day: "从第几天开始", peak_day: "第几天到最高", recover_day: "第几天恢复", spike_day: "哪一天",
  cycle_period_days: "周期（天）", n_cycles: "几个周期",
};
const BREEDS = ["比熊", "金毛", "中华田园犬", "马尔济斯"];
const SCEN_LABEL: Record<string, string> = {
  pattern: "抓挠怎么变", n_days: "天数", severity_multiplier: "严重几倍", baseline_events_per_day: "平时每天几次",
  breed: "品种", night_bias: "夜里占比", wear_quality: "佩戴", noise_dispersion: "每天波动", questionnaire_behavior: "问卷",
  clustering_bias: "抓挠扎堆", sleep_interrupt_injection: "夜里抓醒", long_scratch_injection: "一次抓很久", ...DAY_LABEL,
};

export function MlSimulate() {
  const qc = useQueryClient();
  const { data: templates } = useQuery({ queryKey: ["skin-ml-scenarios"], queryFn: mlScenarios, staleTime: Infinity });
  const [form] = Form.useForm<MlScenario>();
  const [res, setRes] = useState<MlSimResult | null>(null);
  const [running, setRunning] = useState(false);
  const [adding, setAdding] = useState(false);
  const pattern = Form.useWatch("pattern", form);
  const days = PATTERNS.find((p) => p.value === pattern)?.days ?? [];

  const run = async () => {
    setRunning(true);
    try {
      const v = await form.validateFields();
      setRes(await mlSimulate(v));
    } catch (e) {
      if (e instanceof Error) message.error(`模拟失败：${e.message}`);
    } finally {
      setRunning(false);
    }
  };
  const addToTraining = async () => {
    if (!res) return;
    setAdding(true);
    try {
      await mlAddExtra({ ...res.scenario, scenario_id: `custom_${dayjs().format("YYYYMMDDHHmmss")}` });
      message.success("已加进合成训练数据；到「模型与训练」点「重训合成版」生效");
      qc.invalidateQueries({ queryKey: ["skin-ml-status"] });
    } finally {
      setAdding(false);
    }
  };

  return (
    <Row gutter={16}>
      <Col xs={24} lg={8}>
        <Card size="small" title="造一只狗">
          <Form form={form} layout="vertical" size="small"
            initialValues={{ pattern: "step_onset", n_days: 35, breed: "比熊", severity_multiplier: 3, baseline_events_per_day: 4,
              onset_day: 20, night_bias: 0.3, wear_quality: "good", noise_dispersion: "medium", questionnaire_behavior: "answered_consistent",
              clustering_bias: "diffuse", sleep_interrupt_injection: false, long_scratch_injection: false }}>
            <Form.Item label="从现成的场景开始（可选）">
              <Select allowClear showSearch placeholder="合成数据里的 86 个场景" optionFilterProp="label"
                options={(templates ?? []).map((t) => ({ value: t.scenario_id, label: `${t.scenario_id}` }))}
                onChange={(id) => {
                  const t = templates?.find((x) => x.scenario_id === id);
                  if (t) form.setFieldsValue({ ...t, scenario_id: undefined });
                }} />
            </Form.Item>
            <Form.Item name="pattern" label="抓挠怎么变"><Select options={PATTERNS} /></Form.Item>
            <Space wrap>
              <Form.Item name="n_days" label="几天"><InputNumber min={7} max={120} /></Form.Item>
              <Form.Item name="severity_multiplier" label={<Tooltip title="异常期是平时的几倍">严重几倍</Tooltip>}><InputNumber min={1} max={10} step={0.5} /></Form.Item>
              <Form.Item name="baseline_events_per_day" label="平时每天几次"><InputNumber min={0} max={50} /></Form.Item>
            </Space>
            {days.length > 0 && (
              <Space wrap>
                {days.map((k) => <Form.Item key={k} name={k} label={DAY_LABEL[k]}><InputNumber min={0} max={119} /></Form.Item>)}
              </Space>
            )}
            <Space wrap>
              <Form.Item name="breed" label="品种"><Select style={{ width: 120 }} options={BREEDS.map((b) => ({ value: b, label: b }))} /></Form.Item>
              <Form.Item name="night_bias" label={<Tooltip title="异常期新增的抓挠有多少在夜里">夜里占比</Tooltip>}><InputNumber min={0} max={1} step={0.1} /></Form.Item>
            </Space>
            <Space wrap>
              <Form.Item name="wear_quality" label="佩戴">
                <Select style={{ width: 150 }} options={[
                  { value: "good", label: "每天都戴好" }, { value: "partial", label: "有几天只戴半天" },
                  { value: "off_body_days", label: "有几天没戴" }, { value: "loose_days", label: "有几天松了" },
                  { value: "sparse_history", label: "刚戴没几天" },
                ]} />
              </Form.Item>
              <Form.Item name="noise_dispersion" label="每天波动">
                <Select style={{ width: 100 }} options={[{ value: "low", label: "小" }, { value: "medium", label: "中" }, { value: "high", label: "大" }]} />
              </Form.Item>
            </Space>
            <Form.Item name="questionnaire_behavior" label={<Tooltip title="C1 / C2 的天会触发问卷；合成的问卷答案跟皮肤真实状况怎么对应">问卷</Tooltip>}>
              <Select options={[
                { value: "answered_consistent", label: "填了，跟抓挠程度一致" },
                { value: "answered_conflicting_worse", label: "填了，皮肤比抓挠看起来更糟" },
                { value: "answered_conflicting_better", label: "填了，皮肤比抓挠看起来好" },
                { value: "not_triggered", label: "不填" },
              ]} />
            </Form.Item>
            <Space wrap>
              <Form.Item name="clustering_bias" label="抓挠扎堆">
                <Select style={{ width: 110 }} options={[{ value: "diffuse", label: "分散" }, { value: "clustered", label: "扎堆" }]} />
              </Form.Item>
              <Form.Item name="sleep_interrupt_injection" valuePropName="checked" label=" "><Checkbox>夜里抓醒</Checkbox></Form.Item>
              <Form.Item name="long_scratch_injection" valuePropName="checked" label=" "><Checkbox>一次抓很久</Checkbox></Form.Item>
            </Space>
            <Button type="primary" block loading={running} onClick={run}>模拟</Button>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              「真值」：C 是 PM 抓挠规则算的，S 是合成数据的组合规则（皮肤 65% + 抓挠 35%）。模型第一次加载要几十秒。
            </Typography.Paragraph>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={16}>
        {!res && !running && <Alert type="info" showIcon message="左边设好参数点「模拟」：看模型 A / B 每天怎么判，跟规则真值差多少。判错的场景可以加进训练数据再训练" />}
        {running && <Spin />}
        {res && !running && <SimResult res={res} onAdd={addToTraining} adding={adding} />}
      </Col>
    </Row>
  );
}

function SimResult({ res, onAdd, adding }: { res: MlSimResult; onAdd: () => void; adding: boolean }) {
  const maxEv = Math.max(1, ...res.days.map((d) => d.events));
  const cell = (v: string | null | undefined, truth?: string | null) => {
    if (!v) return <span style={{ opacity: 0.3 }}>·</span>;
    const wrong = truth && v !== truth;
    return (
      <span style={{ display: "inline-block", width: 26, textAlign: "center", fontSize: 11, borderRadius: 3,
        background: tierColor(v) === "red" ? "#a8071a55" : tierColor(v) === "orange" ? "#d4880655" : "#389e0d40",
        outline: wrong ? "2px solid #ff4d4f" : undefined }}>
        {v}
      </span>
    );
  };
  const line = (label: string, get: (d: MlSimDay) => React.ReactNode) => (
    <tr>
      <td style={{ whiteSpace: "nowrap", paddingRight: 8, fontSize: 12, color: "#888" }}>{label}</td>
      {res.days.map((d) => <td key={d.day} style={{ padding: 1, textAlign: "center" }}>{get(d)}</td>)}
    </tr>
  );
  return (
    <Card size="small" title={`模拟结果（${res.days.length} 天）`}
      extra={<Popconfirm title="把这个场景加进合成训练数据？到「模型与训练」重训后生效" onConfirm={onAdd}>
        <Button size="small" loading={adding}>加进训练数据</Button>
      </Popconfirm>}>
      <Space size={24} style={{ marginBottom: 8 }}>
        <Statistic title="模型 A 对上规则 C" value={pct(res.acc_c.acc)} suffix={<span style={{ fontSize: 12 }}>{res.acc_c.n} 天</span>} />
        <Statistic title="模型 B 对上合成 S" value={pct(res.acc_s.acc)} suffix={<span style={{ fontSize: 12 }}>{res.acc_s.n} 天（触发问卷的天才有）</span>} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>模型 B：{res.model_b === "real" ? "兽医评级训练版" : "合成数据版"}；红框 = 跟真值不一样</Typography.Text>
      </Space>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 0 }}>
          <tbody>
            <tr>
              <td style={{ fontSize: 12, color: "#888" }}>抓挠次数</td>
              {res.days.map((d) => (
                <td key={d.day} style={{ verticalAlign: "bottom", padding: 1 }}>
                  <Tooltip title={`第 ${d.day} 天：${d.events} 次 / ${d.duration_min} 分，戴了 ${d.wear_h} 小时${d.quality !== "good" ? `（${d.quality}，不出预测）` : ""}`}>
                    <div style={{ width: 26, height: 4 + (60 * d.events) / maxEv, background: d.quality === "good" ? "#4096ff" : "#888", borderRadius: 2 }} />
                  </Tooltip>
                </td>
              ))}
            </tr>
            {line("第几天", (d) => <span style={{ fontSize: 10, color: "#888" }}>{d.day}</span>)}
            {line("规则 C（真值）", (d) => cell(d.truth_c))}
            {line("模型 A 的 C", (d) => cell(d.ml_c, d.truth_c))}
            {line("合成 S（真值）", (d) => cell(d.truth_s))}
            {line("模型 B 的 S", (d) => cell(d.ml_s, d.truth_s))}
            {line("有问卷", (d) => (d.has_q ? <span style={{ fontSize: 11 }}>✓</span> : null))}
          </tbody>
        </table>
      </div>
      <Descriptions size="small" column={3} style={{ marginTop: 12 }}
        items={Object.entries(res.scenario).filter(([k]) => k in SCEN_LABEL).map(([k, v]) => ({
          key: k, label: SCEN_LABEL[k],
          children: k === "pattern" ? PATTERNS.find((p) => p.value === v)?.label ?? String(v) : typeof v === "boolean" ? (v ? "是" : "否") : String(v),
        }))} />
    </Card>
  );
}

// ── 模型与训练 ──────────────────────────────────────────────────────────

export function MlTraining() {
  const qc = useQueryClient();
  const { data: st, refetch } = useQuery({ queryKey: ["skin-ml-status"], queryFn: mlModelStatus, retry: false });
  const [busy, setBusy] = useState(false);
  const syn = st?.synthetic_report;
  const retrain = async () => {
    setBusy(true);
    try {
      const r = await mlRetrainSynthetic();
      message.success("合成版重训完了，库里的 ML 结果已按新模型重算");
      r.warnings?.forEach((w) => message.warning(w));
      refetch();
      qc.invalidateQueries({ queryKey: ["skin-ml-results"] });
      qc.invalidateQueries({ queryKey: ["skin-tracking"] });
    } catch (e) {
      message.error(`重训失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const extras = useMemo(() => st?.extras ?? [], [st]);
  return (
    <div>
      <Card size="small" title="合成数据版（模型 A + 模型 B）"
        extra={<Button type="primary" loading={busy} onClick={retrain}>{busy ? "重训中（一两分钟）" : "重训合成版"}</Button>}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          训练数据是仓库里 86 个合成场景（每个场景一只狗几十天），加上在「模拟」里「加进训练数据」的场景。
          模型 A 学 PM 抓挠规则算出来的 C 档；模型 B 学合成的 S 档（皮肤状况 + 抓挠）。重训后库里所有天的 ML 结果按新模型重算。
        </Typography.Paragraph>
        {syn ? (
          <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered items={[
            { key: "t", label: "上次训练", children: syn.trained_at.replace("T", " ") },
            { key: "a", label: "模型 A 训练行", children: `${syn.rows_a} 天 / ${syn.dogs_a} 只场景狗（${Object.entries(syn.c_counts).map(([k, v]) => `${k} ${v}`).join(" · ")}）` },
            { key: "b", label: "模型 B 训练行", children: `${syn.rows_b} 天（${Object.entries(syn.s_counts).map(([k, v]) => `${k} ${v}`).join(" · ")}）` },
            { key: "ca", label: <Tooltip title="按场景狗分组 3 折：没见过的狗上，模型 A 跟规则 C 对上多少">模型 A 交叉验证</Tooltip>, children: pct(syn.cv_acc_a) },
            { key: "cb", label: <Tooltip title="同上，模型 B 跟合成 S 真值">模型 B 交叉验证</Tooltip>, children: pct(syn.cv_acc_b) },
            { key: "e", label: "加进来的场景", children: syn.extra_scenarios },
          ]} />
        ) : (
          <Typography.Text type="secondary">还没在这台服务器上重训过（现在用的是仓库里自带的那份，或者服务启动时自动重训的那份）</Typography.Text>
        )}
        <div style={{ marginTop: 12 }}>
          <Typography.Text strong style={{ fontSize: 13 }}>在「模拟」里加进来的场景（{extras.length}）</Typography.Text>
          <Table size="small" rowKey="scenario_id" pagination={false} style={{ marginTop: 6 }} dataSource={extras}
            locale={{ emptyText: "还没有：在「模拟」里造一个模型判错的场景，点「加进训练数据」" }}
            columns={[
              { title: "场景", dataIndex: "scenario_id" },
              { title: "变化", dataIndex: "pattern", render: (v: string) => PATTERNS.find((p) => p.value === v)?.label ?? v },
              { title: "品种", dataIndex: "breed" },
              { title: "天数", dataIndex: "n_days" },
              { title: "严重几倍", dataIndex: "severity_multiplier" },
              {
                title: "", render: (_: unknown, r: { scenario_id: string }) => (
                  <Popconfirm title="从训练数据里去掉？重训后生效" onConfirm={async () => { await mlRemoveExtra(r.scenario_id); refetch(); }}>
                    <Button size="small" type="link" danger>去掉</Button>
                  </Popconfirm>
                ),
              },
            ]} />
        </div>
      </Card>
      <div style={{ marginTop: 12 }}>
        <RealRetrainCard cPrefer="ai" hasLabels />
      </div>
    </div>
  );
}
