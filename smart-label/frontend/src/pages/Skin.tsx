import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Checkbox, DatePicker, Descriptions, Input, InputNumber, Popconfirm, Radio, Select, Space, Spin, Table, Tabs, Tag, Typography, message,
} from "antd";
import dayjs from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/authStore";
import PhotoGallery from "@/components/PhotoGallery";
import {
  deleteSkinRecord, deleteWeekly, getSkinOptions, listSkinRecords, listWeekly, saveSkinRecord, skinCScore, skinMlPredictC, skinMlPredictS,
  skinLinkStats, skinMlPreview, skinMlScan, skinQScore, skinSTotal, skinStatsScan, skinStatsToC, upsertWeekly, weeklyAutofill, weeklyDefaults, weeklyRecomputeAll,
  type Answers, type CInputs, type CResult, type CSource, type LinkRow, type MlPredict, type MlRow, type QScore, type SResult, type SkinOptions, type SkinRecord, type StatsRow, type WeeklyRow,
} from "@/api/skin";
import { listProjects } from "@/api/projects";

// 皮肤评估：pm_skin_scoring 那个 Gradio（填写问答 / 导入IMU统计 / C值 / S总分 / ML对比 /
// 周报表 / 历史记录）的 React 版。所有分值由 imu_train/label_service 按 PM 规则算
// （规则只有一份在那边），这边只做界面和记录/周报表的存储。几个标签页共享同一份
// 状态（问答答案、C 值结果、选中的日期/机位/狗），跟 Gradio 版"跨标签联动"一致。

const EMPTY_C: CInputs = {
  baseline_count: 0, baseline_duration_min: 0, today_count: 0, today_duration_min: 0,
  cluster_count: 0, persistence_days: 0, zn: 0, zd: 0, long_scratch: false, has_baseline: true,
};
const tierColor = (t?: string | null) => (t?.endsWith("2") ? "red" : t?.endsWith("1") ? "orange" : t ? "green" : undefined);
const fmt = (v: unknown, nd = 2) => (v == null || v === "" ? "—" : typeof v === "number" ? v.toFixed(nd) : String(v));
const SOURCE_LABEL: Record<CSource, string> = { ai: "来源：标注平台 AI 版", human: "来源：标注平台人工版", stats: "来源：stats.csv", manual: "来源：手填" };

export default function Skin() {
  const qc = useQueryClient();
  const userInfo = useAuthStore((s) => s.userInfo);
  const { data: opts, isLoading, error } = useQuery({ queryKey: ["skin-options"], queryFn: getSkinOptions });

  // ── 跨标签共享状态 ──
  const [dogName, setDogName] = useState<string | null>(null);
  const [fillDate, setFillDate] = useState<string>(dayjs().format("YYYY-MM-DD"));
  const [filler, setFiller] = useState<string>(userInfo?.display_name || userInfo?.username || "");
  const [imu, setImu] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [qScore, setQScore] = useState<QScore | null>(null);
  const [cIn, setCIn] = useState<CInputs>(EMPTY_C);
  const [cRes, setCRes] = useState<CResult | null>(null);
  // C 输入是从哪来的（ai/human=标注平台，stats=stats.csv，manual=手改），以及从标注平台
  // 拉取时另一个版本的 C 值——保存记录时两个版本一起存，历史里对比模型 vs 人工
  const [cSource, setCSource] = useState<CSource>("manual");
  const [cCompare, setCCompare] = useState<{ ai: { total: number | null; tier: string | null } | null; human: { total: number | null; tier: string | null } | null }>({ ai: null, human: null });
  const [sRes, setSRes] = useState<SResult | null>(null);
  const [sCValue, setSCValue] = useState<number | null>(null);
  const [sCTierHint, setSCTierHint] = useState<string | null>(null);
  // 两个版本：PM 版（问答/IMU/C 值/S 总分/周报/历史/照片）和 ML 版（模型对比，后续在这里加）
  const ML_TABS = new Set(["ml"]);
  const [version, setVersion] = useState<"pm" | "ml">("pm");
  const [pmTab, setPmTab] = useState("q");
  const [mlTab, setMlTab] = useState("ml");
  const tab = version === "pm" ? pmTab : mlTab;
  // 各 tab 之间跳转（比如 ML 对比 → 填写问答）时顺带切到对应版本
  const setTab = (key: string) => {
    if (ML_TABS.has(key)) { setVersion("ml"); setMlTab(key); } else { setVersion("pm"); setPmTab(key); }
  };

  // 问答改动 → 实时重算问答分（跟 Gradio 版 .change 一样）
  useEffect(() => {
    if (!opts) return;
    skinQScore(answers).then(setQScore).catch(() => {});
  }, [answers, opts]);
  // C 输入改动 → 实时重算 C 值，并同步到 S 页
  useEffect(() => {
    if (!opts) return;
    skinCScore(cIn).then((r) => { setCRes(r); setSCValue(r.total); setSCTierHint(r.tier); }).catch(() => {});
  }, [cIn, opts]);
  // S 页输入改动 → 重算 S 总分
  useEffect(() => {
    if (!opts) return;
    skinSTotal({ ...answers, c_value: sCValue, c_tier_hint: sCTierHint }).then(setSRes).catch(() => {});
  }, [answers, sCValue, sCTierHint, opts]);

  if (error) return <Alert type="error" showIcon message="AI 服务连不上" description={`皮肤评估的规则/模型在 imu_train/label_service 里，${(error as Error).message}`} />;
  if (isLoading || !opts) return <Spin />;

  const setAnswer = (k: keyof Answers, v: string | null) => {
    setAnswers((prev) => {
      const next = { ...prev, [k]: v };
      // 前置题不是"是"时清掉 5/6 题（PM 规则：不评估、计 0 分）
      if (k === "has_hair_loss" && v !== "是") { next.hair_spot = null; next.hair_diameter = null; }
      return next;
    });
  };

  return (
    <div>
      <Space style={{ marginBottom: 8 }} wrap>
        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          options={[
            { label: "PM 版", value: "pm" },
            { label: "ML 版", value: "ml" },
          ]}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {version === "pm"
            ? "PM 版皮肤评估：问答分 → C 值（IMU 抓挠统计）→ S 总分（C×40% + 皮肤组×35% + 毛发组×25%）。分值规则全部在 imu_train/label_service 里（跟命令行 Gradio 版逐字一致），这里只做界面和记录存储。"
            : "ML 版：同一套问答输入喂给合成数据训出来的模型 A/B，跟 PM 版结果对比。"}
        </Typography.Text>
      </Space>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={(version === "pm" ? [
          { key: "q", label: "填写问答", children: (
            <QuestionnaireTab opts={opts} dogName={dogName} setDogName={setDogName} fillDate={fillDate} setFillDate={setFillDate} filler={filler} setFiller={setFiller}
              answers={answers} setAnswer={setAnswer} qScore={qScore} imu={imu} cRes={cRes} sRes={sRes} cIn={cIn} cSource={cSource} cCompare={cCompare}
              onSaved={() => qc.invalidateQueries({ queryKey: ["skin-records"] })} goto={setTab} />
          ) },
          { key: "link", label: "项目联动（AI vs 人工）", children: (
            <LinkTab opts={opts} onApply={(c, meta) => {
              setCIn(c); setCSource(meta.source); setCCompare({ ai: meta.ai, human: meta.human });
              if (meta.fill_date) setFillDate(meta.fill_date); if (meta.dog_name) setDogName(meta.dog_name); setImu(meta.imu); setTab("c");
            }} />
          ) },
          { key: "stats", label: "导入IMU统计数据", children: (
            <StatsTab opts={opts} onApply={(c, meta) => { setCIn(c); setCSource("stats"); setCCompare({ ai: null, human: null }); if (meta.fill_date) setFillDate(meta.fill_date); if (meta.dog_name) setDogName(meta.dog_name); setImu(meta.imu); setTab("c"); }} />
          ) },
          { key: "c", label: "C值计算", children: <CTab cIn={cIn} setCIn={(c) => { setCIn(c); setCSource("manual"); }} cRes={cRes} cSource={cSource} cCompare={cCompare} goto={setTab} /> },
          { key: "s", label: "S总分", children: <STab sRes={sRes} sCValue={sCValue} setSCValue={(v) => { setSCValue(v); setSCTierHint(null); }} answers={answers} qScore={qScore} goto={setTab} /> },
          { key: "weekly", label: "周报表", children: <WeeklyTab opts={opts} /> },
          { key: "history", label: "历史记录", children: <HistoryTab /> },
          { key: "photos", label: "皮肤照片", children: <PhotoGallery album="skin" hint="皮肤瘙痒问诊照片，来自素材库 NAS" /> },
        ] : [
          { key: "ml", label: "模型对比", children: <MlTab opts={opts} answers={answers} dogName={dogName} onGotoQ={(d, dog) => { setFillDate(d); setDogName(dog); setTab("q"); }} /> },
        ])}
      />
    </div>
  );
}

// ── 填写问答 ────────────────────────────────────────────────────────────

function QuestionnaireTab(p: {
  opts: SkinOptions; dogName: string | null; setDogName: (v: string | null) => void; fillDate: string; setFillDate: (v: string) => void;
  filler: string; setFiller: (v: string) => void; answers: Answers; setAnswer: (k: keyof Answers, v: string | null) => void; qScore: QScore | null;
  imu: string | null; cRes: CResult | null; sRes: SResult | null; cIn: CInputs; cSource: CSource;
  cCompare: { ai: { total: number | null; tier: string | null } | null; human: { total: number | null; tier: string | null } | null };
  onSaved: () => void; goto: (k: string) => void;
}) {
  const { opts, answers, setAnswer, qScore } = p;
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const q = opts.questions;
  const radio = (key: keyof Answers, question: SkinOptions["questions"][keyof SkinOptions["questions"]]) => (
    <div style={{ marginBottom: 12 }}>
      <Typography.Text strong>{question.label}</Typography.Text>
      <Radio.Group value={answers[key] ?? undefined} onChange={(e) => setAnswer(key, e.target.value)} style={{ display: "block", marginTop: 4 }}>
        {(question.options as (string | { text: string; score: number })[]).map((o) => {
          const text = typeof o === "string" ? o : o.text;
          return (
            <Radio key={text} value={text} style={{ display: "block", lineHeight: "28px" }}>
              {text}{typeof o !== "string" && <Typography.Text type="secondary"> （{o.score}分）</Typography.Text>}
            </Radio>
          );
        })}
      </Radio.Group>
    </div>
  );
  const hairLoss = answers.has_hair_loss === "是";

  const save = async () => {
    if (!p.dogName || !p.fillDate || !p.filler) { message.error("请先选择狗狗名字、填表日期、填写人再保存"); return; }
    if (qScore?.missing.length) { message.error(`还有必填题没填：${qScore.missing.join("、")}`); return; }
    setSaving(true);
    try {
      await saveSkinRecord({
        dog_name: p.dogName, fill_date: p.fillDate, filler: p.filler, imu: p.imu,
        has_hair_loss: answers.has_hair_loss ?? null,
        color: qScore?.letters.color || null, odor: qScore?.letters.odor || null, lesion: qScore?.letters.lesion || null,
        hair_spot: qScore?.letters.hair_spot || null, hair_diameter: qScore?.letters.hair_diameter || null, coat: qScore?.letters.coat || null,
        q_score: qScore?.total ?? null, c_value: p.cRes?.total ?? null, c_tier: p.cRes?.tier ?? null,
        s_total: p.sRes?.total ?? null, s_tier: p.sRes?.s_tier ?? null, c_inputs: p.cIn, confirm_overwrite: confirm,
        c_source: p.cSource,
        c_value_ai: p.cCompare.ai?.total ?? null, c_tier_ai: p.cCompare.ai?.tier ?? null,
        c_value_human: p.cCompare.human?.total ?? null, c_tier_human: p.cCompare.human?.tier ?? null,
      });
      message.success(confirm ? "已覆盖旧记录" : "已保存新记录");
      setConfirm(false);
      p.onSaved();
    } catch {
      /* 409 等错误 request.ts 已弹出 msg */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 420 }}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select placeholder="狗狗名字" style={{ width: 180 }} value={p.dogName ?? undefined} onChange={p.setDogName} options={opts.dog_names.map((d) => ({ value: d, label: d }))} allowClear showSearch />
          <DatePicker value={p.fillDate ? dayjs(p.fillDate) : null} onChange={(d) => p.setFillDate(d ? d.format("YYYY-MM-DD") : "")} placeholder="填表日期" />
          <Input placeholder="填写人" style={{ width: 140 }} value={p.filler} onChange={(e) => p.setFiller(e.target.value)} />
          {p.imu && <Tag>机位 {p.imu}</Tag>}
        </Space>
        <Typography.Title level={5}>一、前置问题</Typography.Title>
        {radio("has_hair_loss", q.has_hair_loss)}
        <Typography.Title level={5}>二、皮肤色泽 / 三、体味 / 四、皮肤损伤</Typography.Title>
        {radio("color", q.color)}
        {radio("odor", q.odor)}
        {radio("lesion", q.lesion)}
        <Typography.Title level={5}>五、毛发状态</Typography.Title>
        {hairLoss && radio("hair_spot", q.hair_spot)}
        {hairLoss && radio("hair_diameter", q.hair_diameter)}
        {!hairLoss && <Typography.Text type="secondary">前置问题选「是」才评估秃毛分布/秃毛面积（否则这两项计 0 分）</Typography.Text>}
        {radio("coat", q.coat)}
      </div>
      <div style={{ width: 380 }}>
        <Descriptions title={<span>问答分数：<b style={{ fontSize: 20 }}>{qScore ? qScore.total : "—"}</b></span>} column={1} size="small" bordered>
          <Descriptions.Item label="皮肤颜色 / 体味 / 皮损">{qScore ? `${qScore.items.color} / ${qScore.items.odor} / ${qScore.items.lesion}` : "—"}</Descriptions.Item>
          <Descriptions.Item label={`皮肤状态组小计 ×${opts.weights.skin_group}`}>{qScore ? `${qScore.skin_group_raw} → ${qScore.skin_group_score.toFixed(2)}` : "—"}</Descriptions.Item>
          <Descriptions.Item label="秃毛分布 / 秃毛面积 / 整体毛质">{qScore ? `${qScore.items.spot} / ${qScore.items.diameter} / ${qScore.items.coat}${qScore.hair_questions_counted ? "" : "（前两项未评估计0）"}` : "—"}</Descriptions.Item>
          <Descriptions.Item label={`毛发状态组小计 ×${opts.weights.hair_group}`}>{qScore ? `${qScore.hair_group_raw} → ${qScore.hair_group_score.toFixed(2)}` : "—"}</Descriptions.Item>
        </Descriptions>
        {!!qScore?.red_flag_items.length && (
          <Alert style={{ marginTop: 8 }} type="warning" showIcon message={`🚩 「${qScore.red_flag_items.join("、")}」选了满分选项——算 S 总分时不看加权总分、直接判 S2`} />
        )}
        {!!qScore?.missing.length && <Typography.Text type="secondary" style={{ display: "block", marginTop: 8 }}>还没填：{qScore.missing.join("、")}</Typography.Text>}
        <Space direction="vertical" style={{ width: "100%", marginTop: 12 }}>
          <Checkbox checked={confirm} onChange={(e) => setConfirm(e.target.checked)}>确认覆盖已有的同名记录（同狗/同日期/同填写人）</Checkbox>
          <Button type="primary" block loading={saving} onClick={save}>保存记录</Button>
          <Button block onClick={() => p.goto("s")}>问答填完了，回 PM 版「S总分」看结果</Button>
          <Button block onClick={() => p.goto("ml")}>问答填完了，回「ML版对比」用模型 B 预测</Button>
        </Space>
      </div>
    </div>
  );
}

// ── 导入 IMU 统计数据 ───────────────────────────────────────────────────

// ── 项目联动：标注平台 AI 版 / 人工版抓挠统计 ──────────────────────────

function LinkTab(p: {
  opts: SkinOptions;
  onApply: (c: CInputs, meta: { fill_date: string | null; dog_name: string | null; imu: string; source: CSource; ai: { total: number | null; tier: string | null } | null; human: { total: number | null; tier: string | null } | null }) => void;
}) {
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs().subtract(13, "day"), dayjs()]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [rows, setRows] = useState<LinkRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  const pull = async () => {
    setLoading(true);
    try {
      const r = await skinLinkStats({ date_from: range[0].format("YYYY-MM-DD"), date_to: range[1].format("YYYY-MM-DD"), project_id: projectId });
      setRows(r.rows); setWarnings(r.warnings);
      if (!r.rows.length) message.info("这段日期里没有样本/任务");
    } finally { setLoading(false); }
  };
  const apply = (row: LinkRow, source: "ai" | "human") => {
    const side = source === "ai" ? row.ai : row.human;
    if (!side) return;
    const { fill_date, dog_name, warnings: w, ...cin } = side.c_inputs;
    w.forEach((x) => message.warning(x, 6));
    p.onApply(cin, {
      fill_date: fill_date ?? row.date, dog_name: dog_name ?? p.opts.imu_dog_default_map[row.imu] ?? null, imu: row.imu, source,
      ai: row.ai ? { total: row.ai.c.total, tier: row.ai.c.tier } : null,
      human: row.human ? { total: row.human.c.total, tier: row.human.c.tier } : null,
    });
    message.success(`已把 ${row.date} ${row.imu} 的${source === "ai" ? "AI 版" : "人工版"}统计填进「C值计算」`);
  };
  const side = (s: LinkRow["ai"]) => s ? (
    <span>
      {s.stats.event_count} 次 / {fmt(s.stats.total_duration_min, 1)} 分 → <b>{s.c.total ?? "—"}</b> <Tag color={tierColor(s.c.tier)}>{s.c.tier}</Tag>
      {s.stats.data_quality_flag !== "good" && <Tag color="orange">佩戴 {fmt(s.stats.valid_wear_hours, 1)}h</Tag>}
    </span>
  ) : <Typography.Text type="secondary">—</Typography.Text>;

  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} allowClear={false} />
        <Select allowClear placeholder="全部项目" style={{ width: 220 }} value={projectId ?? undefined} onChange={(v) => setProjectId(v ?? null)}
          options={(projects ?? []).map((pr) => ({ value: pr.id, label: pr.name }))} />
        <Button type="primary" loading={loading} onClick={pull}>拉取</Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        按 (日期, IMU) 聚合标注平台上的「抓挠」片段：<b>AI 版</b> = 稳定版预标注的原始结果（人改过也不受影响），
        <b>人工版</b> = 已提交/已通过任务里当前的片段。基线用这段日期里的其它天算，范围拉长基线更准。
        「人工完整」= 当天所有任务都已通过；「部分」= 有的还没审，人工版数字偏低。
        {warnings.length > 0 && <div style={{ color: "#faad14" }}>{warnings.slice(0, 5).join("；")}{warnings.length > 5 ? ` …共 ${warnings.length} 条` : ""}</div>}
      </Typography.Paragraph>
      <Table size="small" rowKey={(r) => `${r.date}-${r.imu}`} dataSource={rows} pagination={false} scroll={{ x: "max-content" }}
        columns={[
          { title: "日期", dataIndex: "date" },
          { title: "机位 / 狗", render: (_, r: LinkRow) => `${r.imu} / ${p.opts.imu_dog_default_map[r.imu] ?? "?"}` },
          { title: "任务进度", render: (_, r: LinkRow) => (
            <Space size={4}>
              <span>{r.tasks.approved}/{r.tasks.total} 已通过</span>
              {r.tasks.submitted > 0 && <Tag color="blue">待审 {r.tasks.submitted}</Tag>}
              {r.tasks.no_ai > 0 && <Tag>无 AI {r.tasks.no_ai}</Tag>}
              <Tag color={r.human_status === "complete" ? "green" : r.human_status === "partial" ? "orange" : undefined}>
                {r.human_status === "complete" ? "人工完整" : r.human_status === "partial" ? "人工部分" : "无人工"}
              </Tag>
              {r.ai_mode.includes("raw") && <Tag color="volcano">AI 调试版</Tag>}
            </Space>
          ) },
          { title: "AI 版：次数 / 时长 → C", render: (_, r: LinkRow) => side(r.ai) },
          { title: "人工版：次数 / 时长 → C", render: (_, r: LinkRow) => side(r.human) },
          { title: "ΔC", render: (_, r: LinkRow) => {
            if (r.ai?.c.total == null || r.human?.c.total == null) return "—";
            const d = r.human.c.total - r.ai.c.total;
            return <span style={{ color: Math.abs(d) >= 10 ? "#ff4d4f" : undefined }}>{d > 0 ? "+" : ""}{d.toFixed(1)}</span>;
          } },
          { title: "操作", render: (_, r: LinkRow) => (
            <Space>
              <Button size="small" disabled={!r.ai} onClick={() => apply(r, "ai")}>用 AI 版</Button>
              <Button size="small" type="primary" disabled={!r.human} onClick={() => apply(r, "human")}>用人工版</Button>
            </Space>
          ) },
        ]} />
    </div>
  );
}

function StatsTab(p: { opts: SkinOptions; onApply: (c: CInputs, meta: { fill_date: string | null; dog_name: string | null; imu: string }) => void }) {
  const [roots, setRoots] = useState(p.opts.default_stats_roots);
  const [rows, setRows] = useState<StatsRow[]>([]);
  const [status, setStatus] = useState("");
  const [dateLabel, setDateLabel] = useState<string | null>(null);
  const [imu, setImu] = useState<string | null>(null);
  const [dog, setDog] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const dates = useMemo(() => [...new Set(rows.map((r) => r.date_label))].sort(), [rows]);
  const imus = useMemo(() => [...new Set(rows.filter((r) => r.date_label === dateLabel).map((r) => r.imu))].sort(), [rows, dateLabel]);
  const match = rows.find((r) => r.date_label === dateLabel && r.imu === imu);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await skinStatsScan(roots);
      setRows(r.rows); setStatus(r.message);
      if (r.rows.length) { const last = r.date_labels![r.date_labels!.length - 1]; setDateLabel(last); }
    } finally { setScanning(false); }
  };
  useEffect(() => { if (imus.length) { setImu(imus[0]); } }, [imus]);
  useEffect(() => { if (imu) setDog(p.opts.imu_dog_default_map[imu] ?? null); }, [imu, p.opts]);

  const apply = async () => {
    if (!match) return;
    const c = await skinStatsToC(match);
    const { fill_date, dog_name, warnings, ...cin } = c;
    warnings.forEach((w) => message.warning(w, 6));
    p.onApply(cin, { fill_date, dog_name: dog ?? dog_name, imu: match.imu });
    message.success(`已把 ${match.date} ${match.imu} 的统计数据填进「C值计算」`);
  };

  return (
    <div>
      <Space.Compact style={{ width: "100%", maxWidth: 800 }}>
        <Input value={roots} onChange={(e) => setRoots(e.target.value)} placeholder="推理结果根目录（逗号分隔，相对 imu_train 仓库或绝对路径）" />
        <Button type="primary" loading={scanning} onClick={scan}>扫描</Button>
      </Space.Compact>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4 }}>
        扫 {"{root}/{day}/抓挠/imu_daily_scratch_stats.csv"}（run_review_bins_all_days.sh 加 IMU_STATS=1 的产出）。{status}
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select placeholder="日期" style={{ width: 260 }} value={dateLabel ?? undefined} onChange={setDateLabel} options={dates.map((d) => ({ value: d, label: d }))} />
        <Select placeholder="机位（IMU）" style={{ width: 140 }} value={imu ?? undefined} onChange={setImu} options={imus.map((i) => ({ value: i, label: i }))} />
        <Select placeholder="对应狗狗" style={{ width: 180 }} value={dog ?? undefined} onChange={setDog} allowClear options={p.opts.dog_names.map((d) => ({ value: d, label: d }))} />
        <Button type="primary" disabled={!match} onClick={apply}>应用到「C值计算」</Button>
      </Space>
      {match && (
        <Descriptions column={2} size="small" bordered style={{ maxWidth: 900 }}>
          <Descriptions.Item label="佩戴时长">{fmt(match.valid_wear_hours, 1)} 小时（{match.data_quality_flag}）</Descriptions.Item>
          <Descriptions.Item label="今日次数 / 时长">{match.event_count} 次 / {fmt(match.total_duration_min, 1)} 分钟</Descriptions.Item>
          <Descriptions.Item label="最长单次抓挠">{fmt(match.max_event_duration_sec, 0)} 秒</Descriptions.Item>
          <Descriptions.Item label="聚集时段数">{match.cluster_count}</Descriptions.Item>
          <Descriptions.Item label="夜间事件数">{match.night_event_count}</Descriptions.Item>
          <Descriptions.Item label="ZN / ZD">{match.zn} / {match.zd}</Descriptions.Item>
          <Descriptions.Item label="长时间抓挠">{match.long_scratch ? "是" : "否"}</Descriptions.Item>
          <Descriptions.Item label="持续天数（自动估算）">{match.persistence_days}</Descriptions.Item>
          <Descriptions.Item label="基线次数 / 时长（自动估算）" span={2}>
            {match.has_baseline ? `${match.baseline_count} 次 / ${fmt(match.baseline_duration_min, 1)} 分钟（${match.n_baseline_days} 天历史）` : "— 还没有基线（变化幅度不计分，C 值上限 70）"}
          </Descriptions.Item>
        </Descriptions>
      )}
      {match && match.data_quality_flag !== "good" && <Alert style={{ marginTop: 8, maxWidth: 900 }} type="warning" showIcon message="这天佩戴时长不足 12 小时（数据不完整），抓挠次数天然偏低，不建议直接拿这天定 C 档位" />}
    </div>
  );
}

// ── C 值计算 ──────────────────────────────────────────────────────────

function CTab(p: {
  cIn: CInputs; setCIn: (c: CInputs) => void; cRes: CResult | null; cSource: CSource;
  cCompare: { ai: { total: number | null; tier: string | null } | null; human: { total: number | null; tier: string | null } | null }; goto: (k: string) => void;
}) {
  const { cIn, setCIn, cRes } = p;
  const num = (k: keyof CInputs, label: string, info?: string) => (
    <div>
      <Typography.Text>{label}</Typography.Text>
      {info && <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>{info}</Typography.Text>}
      <InputNumber min={0} value={cIn[k] as number} onChange={(v) => setCIn({ ...cIn, [k]: v ?? 0 })} style={{ width: 160 }} />
    </div>
  );
  const comp = cRes?.components;
  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 420 }}>
        <Checkbox checked={cIn.has_baseline} onChange={(e) => setCIn({ ...cIn, has_baseline: e.target.checked })} style={{ marginBottom: 12 }}>
          已经有个人基线（没有的话「变化幅度」不计分，C 值上限 70）
        </Checkbox>
        <Space wrap size={16} style={{ marginBottom: 12 }}>
          {num("baseline_count", "基线抓挠次数")}{num("baseline_duration_min", "基线抓挠时长（分钟）")}
          {num("today_count", "今日抓挠次数")}{num("today_duration_min", "今日抓挠时长（分钟）")}
        </Space>
        <Space wrap size={16} style={{ marginBottom: 12 }}>
          {num("cluster_count", "聚集时段数", "1 小时内抓挠事件 ≥5 次记为 1 个")}
          {num("persistence_days", "持续天数", "过去 7 天变化幅度分连续 ≥10 分的天数")}
          {num("zn", "ZN：普通抓挠次数", "没打断睡眠的")}
          {num("zd", "ZD：打断睡眠的抓挠次数", "夜间 22:00-06:00，相邻 <5 分钟合并")}
        </Space>
        <Checkbox checked={cIn.long_scratch} onChange={(e) => setCIn({ ...cIn, long_scratch: e.target.checked })}>今日出现长时间抓挠（连续/高聚集达 60 秒）</Checkbox>
        <div style={{ marginTop: 12 }}>
          <Space><Button onClick={() => p.goto("q")}>去「填写问答」填问卷</Button><Button onClick={() => p.goto("s")}>跳过问答，直接看「S总分」</Button></Space>
        </div>
      </div>
      <div style={{ width: 380 }}>
        <Descriptions title={<span>C 值：<b style={{ fontSize: 20 }}>{cRes?.total ?? "—"}</b> <Tag color={tierColor(cRes?.tier)}>{cRes?.tier}</Tag>
            <Tag>{SOURCE_LABEL[p.cSource]}</Tag>
            {p.cCompare.ai && <Tag color="purple">AI 版 {p.cCompare.ai.total ?? "—"} {p.cCompare.ai.tier}</Tag>}
            {p.cCompare.human && <Tag color="green">人工版 {p.cCompare.human.total ?? "—"} {p.cCompare.human.tier}</Tag>}
          </span>} column={1} size="small" bordered>
          <Descriptions.Item label="变化幅度 (0-30)">{comp ? (comp.delta.counted ? `${comp.delta.score}${comp.delta.by ? `（按${comp.delta.by}，比值 ${comp.delta.ratio?.toFixed(2)}）` : ""}` : "不计分（无基线）") : "—"}</Descriptions.Item>
          <Descriptions.Item label="聚集程度 (0-20)">{comp?.cluster.score ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="持续程度 (0-20)">{comp?.persistence.score ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="中断影响 (0-30)">{comp?.interruption.score ?? "—"}</Descriptions.Item>
        </Descriptions>
        {!!cRes?.red_flags.length && <Alert style={{ marginTop: 8 }} type="error" showIcon message={`🚩 红旗：${cRes.red_flags.join("、")} → 直接判 C2`} />}
      </div>
    </div>
  );
}

// ── S 总分 ────────────────────────────────────────────────────────────

function STab(p: { sRes: SResult | null; sCValue: number | null; setSCValue: (v: number | null) => void; answers: Answers; qScore: QScore | null; goto: (k: string) => void }) {
  const r = p.sRes;
  return (
    <div style={{ maxWidth: 700 }}>
      <Space style={{ marginBottom: 12 }}>
        <Typography.Text>C 值（0-100，留空按 0 算；从「C值计算」页会自动带过来）</Typography.Text>
        <InputNumber min={0} max={100} value={p.sCValue} onChange={p.setSCValue} />
      </Space>
      <Descriptions title={<span>S 总分：<b style={{ fontSize: 20 }}>{r?.total ?? "—"}</b> <Tag color={tierColor(r?.c_tier)}>{r?.c_tier || "C?"}</Tag><Tag color={tierColor(r?.s_tier)}>{r?.s_tier}</Tag></span>} column={1} size="small" bordered>
        <Descriptions.Item label="C 值 ×40%">{r ? `${r.c_missing ? "⚠️ 还没填 C 值，按 0 算" : r.c_value_used} → ${r.c_score.toFixed(2)}` : "—"}</Descriptions.Item>
        <Descriptions.Item label="皮肤状态组 ×35%">{r ? `${r.skin_group_raw} → ${r.skin_group_score.toFixed(2)}` : "—"}</Descriptions.Item>
        <Descriptions.Item label="毛发状态组 ×25%">{r ? `${r.hair_group_raw} → ${r.hair_group_score.toFixed(2)}` : "—"}</Descriptions.Item>
      </Descriptions>
      {!!r?.red_flags.length && <Alert style={{ marginTop: 8 }} type="error" showIcon message={`🚩 红旗：${r.red_flags.join("、")} → 直接判 S2`} />}
      {!!p.qScore?.missing.length && <Alert style={{ marginTop: 8 }} type="info" showIcon message={`问答还有没填的：${p.qScore.missing.join("、")}`} action={<Button size="small" onClick={() => p.goto("q")}>去填</Button>} />}
    </div>
  );
}

// ── ML 版对比 ─────────────────────────────────────────────────────────

function MlTab(p: { opts: SkinOptions; answers: Answers; dogName: string | null; onGotoQ: (date: string, dog: string | null) => void }) {
  const [roots, setRoots] = useState(p.opts.default_stats_roots);
  const [rows, setRows] = useState<MlRow[]>([]);
  const [status, setStatus] = useState("");
  const [dateLabel, setDateLabel] = useState<string | null>(null);
  const [imu, setImu] = useState<string | null>(null);
  const [dog, setDog] = useState<string | null>(p.dogName);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [cRes, setCRes] = useState<MlPredict | null>(null);
  const [sRes, setSRes] = useState<MlPredict | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const dates = useMemo(() => [...new Set(rows.map((r) => r.date_label))].sort(), [rows]);
  const imus = useMemo(() => [...new Set(rows.filter((r) => r.date_label === dateLabel).map((r) => r.imu))].sort(), [rows, dateLabel]);
  const match = rows.find((r) => r.date_label === dateLabel && r.imu === imu);
  useEffect(() => { if (imus.length) setImu(imus[0]); }, [imus]);
  useEffect(() => { if (imu) setDog(p.opts.imu_dog_default_map[imu] ?? null); }, [imu, p.opts]);

  const sel = match ? { rows, date_label: match.date_label, imu: match.imu, dog_name: dog } : null;
  const answered = ["has_hair_loss", "color", "odor", "lesion", "coat", ...(p.answers.has_hair_loss === "是" ? ["hair_spot", "hair_diameter"] : [])].filter((k) => p.answers[k as keyof Answers]).length;
  const total = p.answers.has_hair_loss === "是" ? 7 : 5;

  const run = async (what: "preview" | "c" | "s") => {
    if (!sel) { message.warning("请先扫描并选好日期、机位"); return; }
    setBusy(what);
    try {
      if (what === "preview") { const r = await skinMlPreview(sel); setPreview(r.ok ? (r.empty ? { 提示: r.message } : r.features ?? null) : { 错误: r.message }); }
      else if (what === "c") setCRes(await skinMlPredictC(sel));
      else setSRes(await skinMlPredictS({ ...sel, answers: p.answers }));
    } finally { setBusy(null); }
  };
  const probaTable = (r: MlPredict) => (
    <Table size="small" pagination={false} rowKey="k" dataSource={Object.entries(r.proba ?? {}).map(([k, v]) => ({ k, v }))}
      columns={[{ title: "档位", dataIndex: "k", render: (k: string) => (k === r.tier ? <b>{k}</b> : k) }, { title: "模型概率", dataIndex: "v", render: (v: number, row) => (row.k === r.tier ? <b>{(v * 100).toFixed(1)}%</b> : `${(v * 100).toFixed(1)}%`) }]} />
  );
  const featureLabels: Record<string, string> = { valid_wear_hours: "佩戴时长(小时)", data_quality_flag: "数据质量", event_count: "今日次数", total_duration_min: "今日时长(分钟)", max_event_duration_sec: "最长单次(秒)", cluster_count: "聚集时段数", night_ratio: "夜间占比", sleep_disruption_count: "睡眠中断次数", history_days_available: "历史天数", has_any_baseline: "已建立基线", z_score_vs_self: "z分数", consecutive_days_above_baseline: "连续偏高天数" };

  return (
    <div>
      <Space.Compact style={{ width: "100%", maxWidth: 800 }}>
        <Input value={roots} onChange={(e) => setRoots(e.target.value)} />
        <Button type="primary" loading={busy === "scan"} onClick={async () => { setBusy("scan"); try { const r = await skinMlScan(roots); setRows(r.rows); setStatus(r.message); if (r.rows.length) setDateLabel(r.date_labels![r.date_labels!.length - 1]); } finally { setBusy(null); } }}>扫描</Button>
      </Space.Compact>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4 }}>扫 {"{root}/{day}/_infer 或 {day}/抓挠/_infer 下的 *_infer.json"}（只看目录名，不读内容）。{status}</Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select placeholder="日期" style={{ width: 260 }} value={dateLabel ?? undefined} onChange={setDateLabel} options={dates.map((d) => ({ value: d, label: d }))} />
        <Select placeholder="机位" style={{ width: 140 }} value={imu ?? undefined} onChange={setImu} options={imus.map((i) => ({ value: i, label: i }))} />
        <Select placeholder="对应狗狗（决定品种）" style={{ width: 200 }} value={dog ?? undefined} onChange={setDog} allowClear options={p.opts.dog_names.map((d) => ({ value: d, label: d }))} />
        <Button disabled={!sel} loading={busy === "preview"} onClick={() => run("preview")}>① 查看这天的统计数据</Button>
      </Space>
      {preview && <Descriptions column={3} size="small" bordered style={{ maxWidth: 1000, marginBottom: 12 }}>{Object.entries(preview).map(([k, v]) => <Descriptions.Item key={k} label={featureLabels[k] ?? k}>{typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v ?? "—")}</Descriptions.Item>)}</Descriptions>}
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div style={{ width: 360 }}>
          <Button type="primary" block disabled={!sel} loading={busy === "c"} onClick={() => run("c")}>② 预测 C 档位（模型 A）</Button>
          {cRes && (cRes.ok ? <div style={{ marginTop: 8 }}><Tag color={tierColor(cRes.tier)} style={{ fontSize: 16, padding: "4px 12px" }}>{cRes.tier}</Tag>{probaTable(cRes)}</div> : <Alert style={{ marginTop: 8 }} type="warning" message={cRes.message} />)}
        </div>
        <div style={{ width: 360 }}>
          <Space direction="vertical" style={{ width: "100%" }}>
            <Button block onClick={() => match && p.onGotoQ(match.date, dog)}>去「填写问答」填问卷（可选）</Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{answered ? `✅ 问答已填 ${answered}/${total} 题，预测 S 时会带上` : "⚠️ 还没填问答——模型 B 会只用 IMU 特征预测"}</Typography.Text>
            <Button type="primary" block disabled={!sel} loading={busy === "s"} onClick={() => run("s")}>③ 预测 S 档位（模型 B）</Button>
          </Space>
          {sRes && (sRes.ok ? (
            <div style={{ marginTop: 8 }}>
              <Tag color={tierColor(sRes.tier)} style={{ fontSize: 16, padding: "4px 12px" }}>{sRes.tier}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{sRes.used_questionnaire ? "（用了问答答案）" : "（没有问答，只用 IMU 特征）"}{sRes.c_tier_from_a ? `，模型 A：${sRes.c_tier_from_a}` : ""}</Typography.Text>
              {probaTable(sRes)}
              {!!sRes.missing_features?.length && <Typography.Text type="secondary" style={{ fontSize: 12 }}>另有 {sRes.missing_features.length} 个特征因历史不够/没填问答暂缺（模型原生支持缺失值）</Typography.Text>}
            </div>
          ) : <Alert style={{ marginTop: 8 }} type="warning" message={sRes.message} />)}
        </div>
      </div>
      <Alert style={{ marginTop: 12, maxWidth: 800 }} type="info" showIcon message={p.opts.ml_caveat} />
    </div>
  );
}

// ── 周报表 ────────────────────────────────────────────────────────────

function WeeklyTab(p: { opts: SkinOptions }) {
  const qc = useQueryClient();
  const cols = p.opts.weekly_report_columns;
  const autofillCols = new Set(p.opts.weekly_autofill_indices.map((i) => cols[i]));
  const [imu, setImu] = useState<string>("IMU1");
  const { data: rows, isLoading } = useQuery({ queryKey: ["skin-weekly", imu], queryFn: () => listWeekly(imu) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["skin-weekly"] });

  // 批量自动填
  const [roots, setRoots] = useState(p.opts.default_stats_roots);
  const [stats, setStats] = useState<StatsRow[]>([]);
  const [statsMsg, setStatsMsg] = useState("");
  const [pickDates, setPickDates] = useState<string[]>([]);
  const [dog, setDog] = useState<string | null>(p.opts.imu_dog_default_map[imu] ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setDog(p.opts.imu_dog_default_map[imu] ?? null); }, [imu, p.opts]);
  const statsImus = useMemo(() => [...new Set(stats.map((r) => r.imu))].sort(), [stats]);
  const statsDates = useMemo(() => [...new Set(stats.filter((r) => r.imu === imu).map((r) => r.date_label))].sort(), [stats, imu]);

  // 编辑单独一天
  const [editDate, setEditDate] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const loadDay = async (d: string) => {
    const existing = rows?.find((r) => r.report_date === d);
    const base: Record<string, unknown> = existing ? existing.data : Object.fromEntries(cols.map((c) => [c, ""]));
    base[cols[0]] = d;
    const withDefaults = await weeklyDefaults({ imu, report_date: d, data: base });
    setForm(Object.fromEntries(cols.map((c) => [c, String(withDefaults[c] ?? "")])));
  };
  const sections: [string, string[]][] = [
    ["今日佩戴", ["今日佩戴时长", "今日佩戴时间段"]],
    ["模型输出", ["模型-抓挠次数", "模型-抓挠总时长(分钟)", "模型-C级评级", "模型-S级评级", "模型-导出事件记录"]],
    ["人工标注", ["人工-抓挠次数", "人工-抓挠总时长(分钟)", "人工-睡眠打断次数", "人工-导出事件记录"]],
    ["对比（模型vs人工）", ["对比-错误集(模型vs人工)", "对比-误差(模型vs人工)"]],
    ["兽医1", ["兽医1-姓名", "兽医1-抓挠次数", "兽医1-抓挠总时长(分钟)", "兽医1-导出事件记录", "兽医1-睡眠打断次数", "兽医1-C级评级", "兽医1-S评分", "兽医1-状态评估描述", "兽医1-问答分数"]],
    ["兽医2", ["兽医2-姓名", "兽医2-睡眠打断次数", "兽医2-C级评级", "兽医2-S评分", "兽医2-状态评估描述", "兽医2-问答分数"]],
    ["对比（人工vs兽医）", ["对比-错误集(人工vs兽医)", "对比-误差(人工vs兽医)"]],
    ["误差分析（保存时自动算，也可手动改）", ["误差分析-抓挠次数误差(人工vs兽医1)", "误差分析-抓挠时长误差(人工vs兽医1)", "误差分析-C评级误差(兽医1vs兽医2)", "误差分析-S评分误差(兽医1vs兽医2)"]],
    ["素材库", ["素材库地址"]],
  ];

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Typography.Text>机位/狗：</Typography.Text>
        <Radio.Group optionType="button" buttonStyle="solid" value={imu} onChange={(e) => { setImu(e.target.value); setEditDate(null); setForm({}); }}
          options={Object.keys(p.opts.imu_dog_default_map).map((k) => ({ value: k, label: `${k} ${p.opts.imu_dog_default_map[k]}` }))} />
      </Space>

      <Typography.Title level={5}>批量自动填「模型-」列</Typography.Title>
      <Space.Compact style={{ width: "100%", maxWidth: 800 }}>
        <Input value={roots} onChange={(e) => setRoots(e.target.value)} />
        <Button loading={busy === "scan"} onClick={async () => { setBusy("scan"); try { const r = await skinStatsScan(roots); setStats(r.rows); setStatsMsg(r.message); } finally { setBusy(null); } }}>扫描</Button>
      </Space.Compact>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", margin: "4px 0 8px" }}>{statsMsg}{statsImus.length && !statsImus.includes(imu) ? `（扫描结果里没有 ${imu}，有：${statsImus.join("、")}）` : ""}</Typography.Text>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select mode="multiple" placeholder="选要自动填的日期（可多选）" style={{ minWidth: 360 }} value={pickDates} onChange={setPickDates} options={statsDates.map((d) => ({ value: d, label: d }))} />
        <Button size="small" onClick={() => setPickDates(statsDates)}>全选</Button>
        <Select placeholder="对应狗狗" style={{ width: 180 }} value={dog ?? undefined} onChange={setDog} allowClear options={p.opts.dog_names.map((d) => ({ value: d, label: d }))} />
        <Button type="primary" disabled={!pickDates.length} loading={busy === "fill"} onClick={async () => {
          setBusy("fill");
          try { const r = await weeklyAutofill({ imu, dog_name: dog, stats_rows: stats, date_labels: pickDates }); message.success(`已自动填 ${r.filled} 天${r.skipped.length ? `，跳过：${r.skipped.join("、")}` : ""}`); refresh(); }
          finally { setBusy(null); }
        }}>批量自动填模型列（直接存盘）</Button>
      </Space>

      <Typography.Title level={5}>编辑单独一天</Typography.Title>
      <Space wrap style={{ marginBottom: 8 }}>
        <Select style={{ width: 260 }} placeholder="选已有日期，或输入新日期（2026_8_29）" showSearch allowClear value={editDate ?? undefined}
          onChange={(v) => { setEditDate(v ?? null); if (v) loadDay(v); else setForm({}); }}
          onSearch={(v) => { if (/^\d{4}_\d{1,2}_\d{1,2}$/.test(v)) { setEditDate(v); loadDay(v); } }}
          options={(rows ?? []).map((r) => ({ value: r.report_date, label: r.report_date }))} />
        {editDate && rows?.find((r) => r.report_date === editDate) && (
          <Popconfirm title={`删除 ${imu} ${editDate} 这一天？`} onConfirm={async () => { await deleteWeekly(rows!.find((r) => r.report_date === editDate)!.id); message.success("已删除"); setEditDate(null); setForm({}); refresh(); }}>
            <Button danger>删除这一天</Button>
          </Popconfirm>
        )}
      </Space>
      {editDate && Object.keys(form).length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {sections.map(([title, keys]) => (
            <div key={title} style={{ marginBottom: 8 }}>
              <Typography.Text strong>{title}</Typography.Text>
              <Space wrap style={{ marginTop: 4 }}>
                {keys.map((k) => (
                  <div key={k} style={{ width: 220 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{k}{autofillCols.has(k) && "（自动填）"}</Typography.Text>
                    <Input size="small" value={form[k] ?? ""} disabled={autofillCols.has(k)} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                  </div>
                ))}
              </Space>
            </div>
          ))}
          <Button type="primary" loading={busy === "save"} onClick={async () => {
            setBusy("save");
            try { await upsertWeekly({ imu, report_date: editDate, dog_name: dog, data: form }); message.success(`已保存 ${imu} ${editDate}`); refresh(); await loadDay(editDate); }
            finally { setBusy(null); }
          }}>保存这一天（自动算对比/误差列）</Button>
        </div>
      )}

      <Space style={{ marginBottom: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>全部记录（{imu}）</Typography.Title>
        <Button size="small" onClick={async () => { const r = await weeklyRecomputeAll(imu); message.success(`已重算 ${r.count} 行`); refresh(); }}>重新计算全部对比/误差列</Button>
      </Space>
      <Table size="small" rowKey="id" loading={isLoading} dataSource={rows ?? []} pagination={false} scroll={{ x: "max-content" }}
        columns={cols.map((c) => ({ title: c, dataIndex: ["data", c], width: 130, ellipsis: true, render: (v: unknown) => (v === "" || v == null ? "" : String(v)) }))}
        onRow={(r) => ({ onClick: () => { setEditDate(r.report_date); loadDay(r.report_date); }, style: { cursor: "pointer" } })} />
    </div>
  );
}

// ── 历史记录 ──────────────────────────────────────────────────────────

function HistoryTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["skin-records"], queryFn: listSkinRecords });
  return (
    <Table size="small" rowKey="id" loading={isLoading} dataSource={data ?? []} pagination={{ pageSize: 20 }} scroll={{ x: "max-content" }}
      columns={[
        { title: "狗狗", dataIndex: "dog_name" }, { title: "日期", dataIndex: "fill_date" }, { title: "填写人", dataIndex: "filler" }, { title: "机位", dataIndex: "imu", render: (v) => v || "-" },
        { title: "有无毛发稀疏", dataIndex: "has_hair_loss" },
        { title: "颜色/体味/皮损", render: (_, r: SkinRecord) => `${r.color ?? "-"} / ${r.odor ?? "-"} / ${r.lesion ?? "-"}` },
        { title: "分布/面积/毛质", render: (_, r: SkinRecord) => `${r.hair_spot ?? "-"} / ${r.hair_diameter ?? "-"} / ${r.coat ?? "-"}` },
        { title: "问答分", dataIndex: "q_score" },
        { title: "C 值", render: (_, r: SkinRecord) => (r.c_value != null ? <span>{r.c_value} <Tag color={tierColor(r.c_tier)}>{r.c_tier}</Tag>{r.c_source && <Tag style={{ marginLeft: 4 }}>{{ ai: "AI", human: "人工", stats: "csv", manual: "手填" }[r.c_source]}</Tag>}</span> : "-") },
        { title: "AI 版 C", render: (_, r: SkinRecord) => (r.c_value_ai != null ? <span>{r.c_value_ai} <Tag color={tierColor(r.c_tier_ai)}>{r.c_tier_ai}</Tag></span> : "-") },
        { title: "人工版 C", render: (_, r: SkinRecord) => (r.c_value_human != null ? <span>{r.c_value_human} <Tag color={tierColor(r.c_tier_human)}>{r.c_tier_human}</Tag></span> : "-") },
        { title: "ΔC (人工-AI)", render: (_, r: SkinRecord) => (r.c_value_ai != null && r.c_value_human != null ? <span style={{ color: Math.abs(r.c_value_human - r.c_value_ai) >= 10 ? "#ff4d4f" : undefined }}>{(r.c_value_human - r.c_value_ai).toFixed(1)}</span> : "-") },
        { title: "S 总分", render: (_, r: SkinRecord) => (r.s_total != null ? <span>{r.s_total} <Tag color={tierColor(r.s_tier)}>{r.s_tier}</Tag></span> : "-") },
        { title: "保存时间", dataIndex: "updated_at", render: (v: string | null) => v?.replace("T", " ").slice(0, 19) },
        { title: "操作", render: (_, r: SkinRecord) => (
          <Popconfirm title="删除这条记录？" onConfirm={async () => { await deleteSkinRecord(r.id); message.success("已删除"); qc.invalidateQueries({ queryKey: ["skin-records"] }); }}>
            <Button size="small" type="link" danger>删除</Button>
          </Popconfirm>
        ) },
      ]} />
  );
}
