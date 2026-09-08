import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Checkbox, DatePicker, Descriptions, Input, InputNumber, Modal, Popconfirm, Radio, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography, message,
} from "antd";
import dayjs from "dayjs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/authStore";
import PhotoGallery from "@/components/PhotoGallery";
import { CExplain, DeltaExplain, EXPLAIN_TOOLTIP, SExplain, ScratchExplain } from "@/components/ScoreExplain";
import { METRICS, TierDistribution, TrendChart } from "@/components/TrackingCharts";
import { sampleDisplayName } from "@/utils/sampleName";
import { TaskStatusTag } from "@/utils/taskStatus";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import { claimTask, getTask } from "@/api/tasks";
import { approveWholeTask, confirmScratchOnly } from "@/utils/confirmTask";
import { listLabels } from "@/api/labels";
import type { LabelDefinition, Task } from "@/types";
import {
  deleteSkinRecord, deleteWeekly, getSkinOptions, listSkinRecords, listWeekly, saveSkinRecord, skinCScore, skinMlPredictC, skinMlPredictS,
  skinDailyTracking, skinLinkStats, skinMlPreview, skinMlScan, skinQScore, skinSTotal, skinStatsScan, skinStatsToC, upsertWeekly, weeklyAutofill, weeklyDefaults, weeklyRecomputeAll,
  type Answers, type CInputs, type CResult, type CSource, type LinkRow, type MlPredict, type MlRow, type QScore, type SResult, type SkinOptions, type SkinRecord, type StatsRow, type TrackingRow, type WeeklyRow,
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
  // PM 版里再分两块：auto = 每天每只狗自动跑出来的长期跟踪；manual = 自己编数据验算规则
  const [pmMode, setPmMode] = useState<"auto" | "manual">("auto");
  const [pmTab, setPmTab] = useState("tracking");
  // 跟踪表点「去填问答」时在弹窗里填：看完不填直接关掉也能回到那张表，
  // 不像切 tab 那样把跟踪表的滚动位置和筛选弄丢
  const [qModal, setQModal] = useState(false);
  const [mlTab, setMlTab] = useState("ml");
  const tab = version === "pm" ? pmTab : mlTab;
  // 各 tab 之间跳转（比如 ML 对比 → 填写问答）时顺带切到对应版本
  const AUTO_TABS = new Set(["tracking", "charts", "link", "weekly", "history", "photos"]);
  const setTab = (key: string) => {
    if (ML_TABS.has(key)) { setVersion("ml"); setMlTab(key); return; }
    setVersion("pm");
    setPmMode(AUTO_TABS.has(key) ? "auto" : "manual");
    setPmTab(key);
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
        {version === "pm" && (
          <Radio.Group
            optionType="button"
            value={pmMode}
            onChange={(e) => { setPmMode(e.target.value); setPmTab(e.target.value === "auto" ? "tracking" : "q"); }}
            options={[
              { label: "每日跟踪（自动）", value: "auto" },
              { label: "手动验证", value: "manual" },
            ]}
          />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {version === "pm" && pmMode === "auto"
            ? "每天每只狗自动跑出来：IMU 抓挠统计 → C 值（AI 版 / 人工版）→ 要不要问答 → S 总分。长期跟踪看这里。"
            : version === "pm"
            ? "PM 版皮肤评估：问答分 → C 值（IMU 抓挠统计）→ S 总分（C×40% + 皮肤组×35% + 毛发组×25%）。分值规则全部在 imu_train/label_service 里（跟命令行 Gradio 版逐字一致），这里只做界面和记录存储。"
            : "ML 版：同一套问答输入喂给合成数据训出来的模型 A/B，跟 PM 版结果对比。"}
        </Typography.Text>
      </Space>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={(version === "ml" ? [
          { key: "ml", label: "模型对比", children: <MlTab opts={opts} answers={answers} dogName={dogName} onGotoQ={(d, dog) => { setFillDate(d); setDogName(dog); setPmMode("manual"); setVersion("pm"); setPmTab("q"); }} /> },
        ] : pmMode === "auto" ? [
          { key: "tracking", label: "每日跟踪表", children: (
            <TrackingTab opts={opts} onGotoQ={(d, dog) => { setFillDate(d); setDogName(dog); setQModal(true); }} />
          ) },
          { key: "charts", label: "趋势图表", children: <ChartsTab /> },
          { key: "link", label: "项目联动（AI vs 人工）", children: (
            <LinkTab opts={opts} onApply={(c, meta) => {
              setCIn(c); setCSource(meta.source); setCCompare({ ai: meta.ai, human: meta.human });
              if (meta.fill_date) setFillDate(meta.fill_date); if (meta.dog_name) setDogName(meta.dog_name); setImu(meta.imu); setPmMode("manual"); setPmTab("c");
            }} />
          ) },
          { key: "weekly", label: "周报表", children: <WeeklyTab opts={opts} /> },
          { key: "history", label: "历史记录", children: <HistoryTab /> },
          { key: "photos", label: "皮肤照片", children: <PhotoGallery album="skin" hint="皮肤瘙痒问诊照片，来自素材库 NAS" /> },
        ] : [
          { key: "q", label: "填写问答", children: (
            <QuestionnaireTab opts={opts} dogName={dogName} setDogName={setDogName} fillDate={fillDate} setFillDate={setFillDate} filler={filler} setFiller={setFiller}
              answers={answers} setAnswer={setAnswer} qScore={qScore} imu={imu} cRes={cRes} sRes={sRes} cIn={cIn} cSource={cSource} cCompare={cCompare}
              onSaved={() => qc.invalidateQueries({ queryKey: ["skin-records"] })} goto={setTab} />
          ) },
          { key: "stats", label: "导入IMU统计数据", children: (
            <StatsTab opts={opts} onApply={(c, meta) => { setCIn(c); setCSource("stats"); setCCompare({ ai: null, human: null }); if (meta.fill_date) setFillDate(meta.fill_date); if (meta.dog_name) setDogName(meta.dog_name); setImu(meta.imu); setTab("c"); }} />
          ) },
          { key: "c", label: "C值计算", children: <CTab cIn={cIn} setCIn={(c) => { setCIn(c); setCSource("manual"); }} cRes={cRes} cSource={cSource} cCompare={cCompare} goto={setTab} /> },
          { key: "s", label: "S总分", children: <STab sRes={sRes} sCValue={sCValue} setSCValue={(v) => { setSCValue(v); setSCTierHint(null); }} answers={answers} qScore={qScore} goto={setTab} /> },
        ])}
      />

      <Modal
        title={`填写问答 - ${dogName ?? ""} ${fillDate}`}
        open={qModal}
        onCancel={() => setQModal(false)}
        footer={null}
        width={900}
        styles={{ body: { maxHeight: "72vh", overflow: "auto" } }}
        destroyOnClose
      >
        <QuestionnaireTab
          opts={opts} dogName={dogName} setDogName={setDogName} fillDate={fillDate} setFillDate={setFillDate}
          filler={filler} setFiller={setFiller} answers={answers} setAnswer={setAnswer} qScore={qScore}
          imu={imu} cRes={cRes} sRes={sRes} cIn={cIn} cSource={cSource} cCompare={cCompare}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["skin-records"] });
            qc.invalidateQueries({ queryKey: ["skin-tracking"] });
            setQModal(false);
          }}
          // 弹窗里的跳转按钮先关弹窗，不然新页面被挡在后面
          goto={(k) => { setQModal(false); setTab(k); }}
        />
      </Modal>
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

// ── 趋势图表：跟跟踪表共用同一套筛选条件（localStorage 同一个 key），只看图 ──

function ChartsTab() {
  const [f, setF] = useState(loadTrackFilter);
  const setFilter = (patch: Partial<ReturnType<typeof loadTrackFilter>>) =>
    setF((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(TRACK_FILTER_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  const { data, isFetching } = useQuery({
    queryKey: ["skin-tracking", f.from, f.to],
    queryFn: () => skinDailyTracking({ date_from: f.from, date_to: f.to }),
    refetchOnWindowFocus: false,
  });
  const all = data?.rows ?? [];
  const dogs = [...new Set(all.map((r) => r.dog_name))].sort();
  const rows = all.filter((r) => f.dogs.length === 0 || f.dogs.includes(r.dog_name));

  // 每只狗一组概览数字：多少天、平均/最高 C、几天 C2、最近一天什么样
  const summary = useMemo(() => {
    const m = new Map<string, TrackingRow[]>();
    for (const r of rows) m.set(r.dog_name, [...(m.get(r.dog_name) ?? []), r]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dog, rs]) => {
      const cs = rs.map((r) => r.c_value).filter((v): v is number => v != null);
      const sorted = [...rs].sort((a, b) => a.date.localeCompare(b.date));
      const last = sorted[sorted.length - 1];
      return {
        dog,
        days: rs.length,
        avgC: cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : null,
        maxC: cs.length ? Math.max(...cs) : null,
        c2Days: rs.filter((r) => r.c_tier === "C2").length,
        needQ: rs.filter((r) => r.question_triggered).length,
        last,
      };
    });
  }, [rows]);

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <DatePicker.RangePicker
          value={[dayjs(f.from), dayjs(f.to)]}
          onChange={(v) => v && v[0] && v[1] && setFilter({ from: v[0].format("YYYY-MM-DD"), to: v[1].format("YYYY-MM-DD") })}
          allowClear={false}
        />
        <Select
          mode="multiple"
          allowClear
          placeholder="全部狗"
          style={{ minWidth: 240 }}
          value={f.dogs}
          onChange={(v) => setFilter({ dogs: v })}
          options={dogs.map((d) => ({ value: d, label: d }))}
          maxTagCount="responsive"
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          跟「每日跟踪表」共用筛选条件，两边改一处另一处也跟着变。
        </Typography.Text>
      </Space>

      {isFetching && !all.length ? <Spin /> : null}
      {!isFetching && !all.length ? (
        <Alert type="info" showIcon message="这段日期还没有数据，先去「项目联动」点一次「重新拉取」" />
      ) : null}

      {summary.length > 0 && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
          {summary.map((sm) => (
            <Descriptions
              key={sm.dog}
              size="small"
              bordered
              column={2}
              style={{ minWidth: 340, flex: "1 1 340px" }}
              title={<span style={{ fontSize: 14 }}>{sm.dog}</span>}
            >
              <Descriptions.Item label="有数据天数">{sm.days}</Descriptions.Item>
              <Descriptions.Item label="需要问答">{sm.needQ} 天</Descriptions.Item>
              <Descriptions.Item label="平均 C">{fmt(sm.avgC, 1)}</Descriptions.Item>
              <Descriptions.Item label="最高 C">{sm.maxC ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="C2 天数">
                {sm.c2Days ? <Tag color="red">{sm.c2Days} 天</Tag> : "0"}
              </Descriptions.Item>
              <Descriptions.Item label="最近一天">
                {sm.last ? (
                  <span>
                    {sm.last.date} {sm.last.c_value ?? "—"} <Tag color={tierColor(sm.last.c_tier)}>{sm.last.c_tier}</Tag>
                  </span>
                ) : "—"}
              </Descriptions.Item>
            </Descriptions>
          ))}
        </div>
      )}

      {rows.length > 0 &&
        METRICS.map((m) => (
          <div key={m.value} style={{ marginBottom: 20 }}>
            <Typography.Text strong>{m.label}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              {m.value === "count" && "虚线是基线（这只狗别的日子的中位数），C 值里的「变化幅度」就是跟它比出来的"}
              {m.value === "c" && "0–30 是 C0，30–50 是 C1，50 以上是 C2；红旗信号会直接判 C2"}
              {m.value === "s" && "有问答记录的用含问答的 S，没有的用不填问答的下限值"}
            </Typography.Text>
            <TrendChart rows={rows} metric={m.value} height={220} />
          </div>
        ))}
      <TierDistribution rows={rows} />
    </div>
  );
}

// ── 每日跟踪表：一行 = (日期, 狗)，长期看每只狗的走势 ────────────────────

const TRACK_FILTER_KEY = "skin-tracking-filter";
const loadTrackFilter = (): { from: string; to: string; onlyTriggered: boolean; dogs: string[] } => {
  try {
    const raw = localStorage.getItem(TRACK_FILTER_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* 用默认值 */ }
  return { from: dayjs().subtract(29, "day").format("YYYY-MM-DD"), to: dayjs().format("YYYY-MM-DD"), onlyTriggered: false, dogs: [] as string[] };
};

// 复看进度（看过 / 抓挠已确认 / 整份已通过）记在浏览器本地，按任务 id 存。
// 这几件事都是"我这个人做到哪了"，不是任务本身的状态，没必要落库；只留最近
// 这些条，免得无限长下去。
const VIEWED_KEY = "smart-label:skin-viewed";
const SCRATCH_OK_KEY = "smart-label:skin-scratch-ok";
const APPROVED_KEY = "smart-label:skin-approved";
const MARKS_MAX = 3000;

function loadTaskMarks(key: string): Set<number> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "number") : []);
  } catch {
    return new Set();
  }
}

function saveTaskMark(key: string, prev: Set<number>, taskId: number): Set<number> {
  const next = new Set(prev).add(taskId);
  try {
    // Set 保持插入顺序，超了就从最早的开始丢
    const arr = [...next];
    localStorage.setItem(key, JSON.stringify(arr.slice(-MARKS_MAX)));
  } catch { /* 存不进去就算了，页面照常用 */ }
  return next;
}

function TrackingTab(p: { opts: SkinOptions; onGotoQ: (date: string, dog: string) => void }) {
  const userId = useAuthStore((st) => st.userInfo?.id);
  const role = useAuthStore((st) => st.userInfo?.role);
  const [f, setF] = useState(loadTrackFilter);
  const setFilter = (patch: Partial<ReturnType<typeof loadTrackFilter>>) =>
    setF((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(TRACK_FILTER_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  const [photoFor, setPhotoFor] = useState<TrackingRow | null>(null);
  const [checkFor, setCheckFor] = useState<TrackingRow | null>(null);
  // 复看标注直接在这一页开工作台，关掉就回到跟踪表——跳去任务页的话关掉会落在
  // 任务列表，还得自己切回来
  const [wsTask, setWsTask] = useState<Task | null>(null);
  const [wsLabels, setWsLabels] = useState<LabelDefinition[]>([]);
  const [wsLoading, setWsLoading] = useState<number | null>(null);
  // 看过哪几个时段，列表里标出来，好接着往下看。记到 localStorage：
  // 复看是分好几次做的，切去别的页面再回来不该从头再认一遍哪些看过了
  const [viewed, setViewed] = useState<Set<number>>(() => loadTaskMarks(VIEWED_KEY));
  const openWorkspace = async (taskId: number) => {
    setWsLoading(taskId);
    try {
      const t = await getTask(taskId);
      setWsLabels(await listLabels(t.project_id));
      setWsTask(t);
      setViewed((prev) => saveTaskMark(VIEWED_KEY, prev, taskId));
      // 故意不关时段选择弹窗：工作台盖在它上面，关掉工作台就露出列表，
      // 可以接着看下一个时段，不用从跟踪表重新点进来
    } finally {
      setWsLoading(null);
    }
  };
  // 复看的时候就地确认，不用再跑去任务页认领、提交，再去审核页通过一遍。
  // 只给管理员/超管：别的角色后端本来也不让自己标自己审。
  const canConfirm = role === "admin" || role === "super_admin";
  const [confirming, setConfirming] = useState<number | null>(null);
  // 复看过/确认过哪几个时段，跟「已看过」一样记到 localStorage，切走再回来还在
  const [scratchOk, setScratchOk] = useState<Set<number>>(() => loadTaskMarks(SCRATCH_OK_KEY));
  const [approved, setApproved] = useState<Set<number>>(() => loadTaskMarks(APPROVED_KEY));

  // 这天这只狗底下的任务都在同一个项目里，标签按项目取一次就够
  const scratchIdsOf = async (projectId: number) =>
    (await listLabels(projectId))
      .filter((l) => l.display_name === "抓挠" || l.code === "抓挠")
      .map((l) => l.id);

  /** 「抓挠没标错」：只确认抓挠这一类的 AI 片段，别的类别和候选都不动 */
  const confirmScratch = async (task: Task) => {
    setConfirming(task.id);
    try {
      const n = await confirmScratchOnly(task, await scratchIdsOf(task.project_id), userId);
      setScratchOk((prev) => saveTaskMark(SCRATCH_OK_KEY, prev, task.id));
      // 确认完任务已经放回待认领，工作台里那份状态得跟上（不然底部按钮
      // 还按"标注中"渲染）
      setWsTask((cur) => (cur && cur.id === task.id ? { ...cur, status: "PENDING_ASSIGN", locked_by: null } : cur));
      message.success(n ? `已确认 ${n} 段抓挠` : "这段里的抓挠之前就确认过了");
    } catch (e) {
      message.error(`确认失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConfirming(null);
    }
  };

  /** 「整份通过」：连活动/睡觉一起认，任务就此审核通过 */
  const approveTask = async (task: Task, date?: string) => {
    setConfirming(task.id);
    try {
      await approveWholeTask(task, userId);
      setApproved((prev) => saveTaskMark(APPROVED_KEY, prev, task.id));
      // 通过之后这天的「人工版」数字才会变（联动只认已提交/已通过的任务），
      // 顺手只重算这一天再刷新跟踪表
      if (date) {
        await skinLinkStats({ date_from: date, date_to: date });
        await refetch();
      }
      message.success(date ? "已通过，这天的数字已重算" : "已通过");
    } catch (e) {
      message.error(`通过失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConfirming(null);
    }
  };
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["skin-tracking", f.from, f.to],
    queryFn: () => skinDailyTracking({ date_from: f.from, date_to: f.to }),
    refetchOnWindowFocus: false,
  });
  const all = data?.rows ?? [];
  const dogs = [...new Set(all.map((r) => r.dog_name))].sort();
  const rows = all.filter(
    (r) => (!f.onlyTriggered || r.question_triggered) && (f.dogs.length === 0 || f.dogs.includes(r.dog_name))
  );

  const sTag = (s: TrackingRow["s_no_q"]) =>
    s && s.total != null ? (
      <span>
        {s.total} <Tag color={tierColor(s.s_tier)}>{s.s_tier}</Tag>
      </span>
    ) : (
      <Typography.Text type="secondary">—</Typography.Text>
    );

  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        <DatePicker.RangePicker
          value={[dayjs(f.from), dayjs(f.to)]}
          onChange={(v) => v && v[0] && v[1] && setFilter({ from: v[0].format("YYYY-MM-DD"), to: v[1].format("YYYY-MM-DD") })}
          allowClear={false}
        />
        <Select
          mode="multiple"
          allowClear
          placeholder="全部狗"
          style={{ minWidth: 220 }}
          value={f.dogs}
          onChange={(v) => setFilter({ dogs: v })}
          options={dogs.map((d) => ({ value: d, label: d }))}
          maxTagCount="responsive"
        />
        <Checkbox checked={f.onlyTriggered} onChange={(e) => setFilter({ onlyTriggered: e.target.checked })}>
          只看需要问答的
        </Checkbox>
        <Button loading={isFetching} onClick={() => refetch()}>刷新</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          共 {rows.length} 行 / {dogs.length} 只狗。C 值来自「项目联动」存下来的结果（人工版优先，没有就用 AI 版）；
          C 到 {(data?.trigger_tiers ?? ["C1", "C2"]).join(" / ")} 才需要做问答。
        </Typography.Text>
      </Space>
      {(data?.warnings?.length ?? 0) > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={data!.warnings.join("；")} />
      )}
      <Table
        size="small"
        rowKey={(r: TrackingRow) => `${r.date}-${r.imu}`}
        loading={isFetching}
        dataSource={rows}
        pagination={{ pageSize: 30, showSizeChanger: true }}
        scroll={{ x: "max-content" }}
        columns={[
          { title: "日期", dataIndex: "date", width: 110, sorter: (a: TrackingRow, b: TrackingRow) => a.date.localeCompare(b.date), defaultSortOrder: "descend" as const },
          {
            title: "狗",
            width: 110,
            // PM 那边的狗名是「品种-名字」，全写出来再加机位号就三行了。列表里
            // 只留名字（一眼能认），品种和机位号放 tooltip
            render: (_: unknown, r: TrackingRow) => {
              const short = r.dog_name.includes("-") ? r.dog_name.split("-").slice(-1)[0] : r.dog_name;
              return (
                <Tooltip title={`${r.dog_name}（${r.imu}）`}>
                  <span style={{ whiteSpace: "nowrap" }}>{short}</span>
                </Tooltip>
              );
            },
          },
          {
            title: "有效佩戴",
            width: 120,
            sorter: (a: TrackingRow, b: TrackingRow) =>
              ((a.stats?.valid_wear_hours as number) ?? 0) - ((b.stats?.valid_wear_hours as number) ?? 0),
            // 佩戴不够的天抓挠次数天然偏低，不看这个列会把"没戴够"误读成"不痒了"
            render: (_: unknown, r: TrackingRow) => {
              const h = r.stats?.valid_wear_hours as number | undefined;
              const flag = r.stats?.data_quality_flag as string | undefined;
              if (h == null) return "—";
              const good = flag === "good";
              return (
                <Tooltip title={good ? "佩戴 ≥12 小时，数据够用" : "佩戴不足 12 小时，这天的抓挠次数天然偏低，别当成「不痒了」；基线也不会采用这天"}>
                  <Space size={4}>
                    <span>{fmt(h, 1)} h</span>
                    {!good && <Tag color="orange">{flag === "partial" ? "偏少" : "不足"}</Tag>}
                  </Space>
                </Tooltip>
              );
            },
          },
          {
            title: "抓挠 次数/时长",
            width: 130,
            sorter: (a: TrackingRow, b: TrackingRow) =>
              ((a.stats?.event_count as number) ?? 0) - ((b.stats?.event_count as number) ?? 0),
            render: (_: unknown, r: TrackingRow) => {
              const n = r.stats?.event_count as number | undefined;
              const m = r.stats?.total_duration_min as number | undefined;
              if (n == null) return "—";
              return (
                <Tooltip {...EXPLAIN_TOOLTIP} title={<ScratchExplain r={r} />}>
                  <span>{`${n} 次 / ${fmt(m, 1)} 分`}</span>
                </Tooltip>
              );
            },
          },
          {
            title: "基线",
            width: 110,
            render: (_: unknown, r: TrackingRow) =>
              r.n_baseline_days ? (
                <Tooltip title={`${r.n_baseline_days} 天历史的中位数；C 值里的「变化幅度」就是拿当天跟它比`}>
                  <Typography.Text type="secondary">{r.baseline_count} 次 / {fmt(r.baseline_duration_min, 1)} 分</Typography.Text>
                </Tooltip>
              ) : (
                <Tooltip title="还没有基线，变化幅度那 30 分不计，C 值上限只有 70">
                  <Tag>无基线</Tag>
                </Tooltip>
              ),
          },
          {
            title: "C 值",
            width: 150,
            sorter: (a: TrackingRow, b: TrackingRow) => (a.c_value ?? -1) - (b.c_value ?? -1),
            render: (_: unknown, r: TrackingRow) =>
              r.c_value == null ? "—" : (
                <Tooltip {...EXPLAIN_TOOLTIP} title={<CExplain side={r.c_source === "human" ? r.c_human : r.c_ai} source={r.c_source} />}>
                  <Space size={4}>
                    <b>{r.c_value}</b>
                    <Tag color={tierColor(r.c_tier)}>{r.c_tier}</Tag>
                    <Tag>{r.c_source === "human" ? "人工" : "AI"}</Tag>
                  </Space>
                </Tooltip>
              ),
          },
          {
            title: "AI / 人工",
            width: 120,
            render: (_: unknown, r: TrackingRow) => (
              <Tooltip {...EXPLAIN_TOOLTIP} title={<DeltaExplain r={r} />}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {r.c_ai?.c_value ?? "—"} / {r.c_human?.c_value ?? "—"}
                  {r.delta_c != null && <span style={{ color: Math.abs(r.delta_c) >= 10 ? "#ff4d4f" : undefined }}>（Δ{r.delta_c > 0 ? "+" : ""}{r.delta_c}）</span>}
                </Typography.Text>
              </Tooltip>
            ),
          },
          {
            title: "问答",
            width: 170,
            // 没触发就整个留空：48 行里大半是 C0，每行都挂个「不必问答」全是噪音，
            // 一眼扫过去只想看到哪几天真的要去问
            render: (_: unknown, r: TrackingRow) => {
              if (!r.question_triggered && !r.has_answers) return <Typography.Text type="secondary">—</Typography.Text>;
              return (
                <Space size={4}>
                  {r.question_triggered && <Tag color="orange">需要问答</Tag>}
                  {r.has_answers ? (
                    <Tooltip title={`填写人：${r.filler ?? "-"}，问答分 ${r.q_score ?? "-"}`}>
                      <Tag color="green">已填</Tag>
                    </Tooltip>
                  ) : (
                    <Tag color="red">未填</Tag>
                  )}
                </Space>
              );
            },
          },
          {
            title: "S 总分（不填问答）",
            width: 150,
            sorter: (a: TrackingRow, b: TrackingRow) => (a.s_no_q?.total ?? -1) - (b.s_no_q?.total ?? -1),
            render: (_: unknown, r: TrackingRow) => (
              <Tooltip {...EXPLAIN_TOOLTIP} title={<SExplain s={r.s_no_q} withQ={false} />}>
                <span>{sTag(r.s_no_q)}</span>
              </Tooltip>
            ),
          },
          {
            title: "S 总分（含问答）",
            width: 150,
            sorter: (a: TrackingRow, b: TrackingRow) => (a.s_with_q?.total ?? -1) - (b.s_with_q?.total ?? -1),
            render: (_: unknown, r: TrackingRow) =>
              r.s_with_q ? (
                <Tooltip {...EXPLAIN_TOOLTIP} title={<SExplain s={r.s_with_q} withQ />}>
                  <span>{sTag(r.s_with_q)}</span>
                </Tooltip>
              ) : (
                sTag(r.s_with_q)
              ),
          },
          {
            title: "复看标注",
            width: 100,
            // 这天的抓挠是好几个小时段任务加起来的，点开挑一个进标注工作台，
            // 片段列表会默认筛到「抓挠」，直接核对是不是真有这么多
            render: (_: unknown, r: TrackingRow) =>
              r.tasks_detail?.length ? (
                <Button size="small" type="link" onClick={() => setCheckFor(r)}>
                  查看标注
                </Button>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          {
            title: "照片",
            width: 80,
            render: (_: unknown, r: TrackingRow) =>
              r.photo_count ? (
                <Button size="small" type="link" onClick={() => setPhotoFor(r)}>
                  {r.photo_count} 张
                </Button>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          {
            title: "操作",
            render: (_: unknown, r: TrackingRow) => {
              // 只有「需要问答」或者已经填过的才给入口
              if (!r.question_triggered && !r.has_answers) return <Typography.Text type="secondary">—</Typography.Text>;
              return (
                <Space size={4}>
                  <Button size="small" type={r.question_triggered && !r.has_answers ? "primary" : "link"} onClick={() => p.onGotoQ(r.date, r.dog_name)}>
                    {r.has_answers ? "改问答" : "去填问答"}
                  </Button>
                  {/* 填错了、或者只是随手测试填的，删掉整份重新填一遍，
                      比在表单里一项项改回去干净 */}
                  {r.has_answers && r.record_id != null && (
                    <Popconfirm
                      title="清空这天的问答？"
                      description="这份记录会被删掉，S 总分（含问答）跟着没有，可以重新填一遍"
                      okButtonProps={{ danger: true }}
                      onConfirm={async () => {
                        await deleteSkinRecord(r.record_id as number);
                        await refetch();
                        message.success("已清空，可以重新填了");
                      }}
                    >
                      <Button size="small" type="link" danger>
                        清空
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              );
            },
          },
        ]}
      />
      <AnnotationWorkspace
        task={wsTask}
        labels={wsLabels}
        focusLabelName="抓挠"
        readOnly={!(wsTask?.status === "IN_PROGRESS" && wsTask?.locked_by === userId)}
        onClose={() => setWsTask(null)}
        onSubmitted={() => setWsTask(null)}
        // 两个结论都给：只认抓挠 / 连活动睡觉一起认。名字写清楚各自认的是什么
        approveText="整份通过"
        confirmScratchText="抓挠确认无误"
        onConfirmScratch={
          canConfirm && wsTask && wsTask.status !== "APPROVED"
            ? async () => {
                await confirmScratch(wsTask);
              }
            : undefined
        }
        onApprove={
          canConfirm && wsTask && wsTask.status !== "APPROVED"
            ? async () => {
                await approveTask(wsTask, checkFor?.date);
                setWsTask(null);
              }
            : undefined
        }
        // 发现 AI 标错了几段，就地认领改，改完再确认
        onClaim={
          canConfirm && wsTask && (wsTask.status === "PENDING_ASSIGN" || wsTask.status === "REJECTED")
            ? async () => {
                const t = await claimTask(wsTask.id);
                setWsTask(t);
              }
            : undefined
        }
      />
      <Modal
        title={`${checkFor?.date ?? ""} ${checkFor?.dog_name ?? ""} —— 挑一段去复看抓挠`}
        open={checkFor != null}
        onCancel={() => setCheckFor(null)}
        footer={null}
        // 一天最多二十几行，一行要放"时间段 + 段数 + 状态 + 三个操作"，
        // 720 挤得时间段要折行；给到 1000 上限一屏宽，一行一行看着不累
        width="min(1000px, 96vw)"
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          这天分成好几个小时段各一个任务。点进去会打开标注工作台，片段列表已经筛好「抓挠」，
          逐条跳转/循环看视频就能核对是不是真有这么多。看完关掉工作台会回到这个列表，可以接着看下一段。
          <br />
          看完在工作台底部下结论：<b>抓挠确认无误</b> 只认这几段抓挠标得对（不碰活动/睡觉，也不碰
          「疑似抓挠」候选，任务还是待认领）；<b>整份通过</b> 是连活动/睡觉一起认、任务就此审核通过
          ——跟踪表里「人工版」的次数/时长只有走这一步才会变。下面这张表只管挑段落，状态列会记着
          哪些看过、哪些已经确认过了。
        </Typography.Paragraph>
        <Table<TrackingRow["tasks_detail"][number]>
          size="small"
          rowKey="task_id"
          dataSource={checkFor?.tasks_detail ?? []}
          pagination={false}
          scroll={{ y: "60vh" }}
          columns={[
            {
              title: "时间段",
              width: 220,
              // 「09:00:14 ~ 10:00:00」不能折成三行，宽度给够并且不许换行
              render: (_: unknown, t) => (
                <span style={{ whiteSpace: "nowrap" }}>
                  {sampleDisplayName(t.sample_code, t.video_duration_sec, null)}
                </span>
              ),
            },
            {
              title: "抓挠片段",
              width: 100,
              sorter: (a, b) => a.scratch_segments - b.scratch_segments,
              defaultSortOrder: "descend" as const,
              render: (_: unknown, t) =>
                t.scratch_segments ? <Tag color="red">{t.scratch_segments} 段</Tag> : <Typography.Text type="secondary">0</Typography.Text>,
            },
            { title: "状态", width: 110, dataIndex: "status", render: (v: string) => <TaskStatusTag status={v as never} /> },
            {
              title: "",
              width: 110,
              render: (_: unknown, t) =>
                approved.has(t.task_id) || t.status === "APPROVED" ? (
                  <Tag color="green">整份已通过</Tag>
                ) : scratchOk.has(t.task_id) ? (
                  <Tag color="cyan">抓挠已确认</Tag>
                ) : viewed.has(t.task_id) ? (
                  <Tag color="blue">已看过</Tag>
                ) : null,
            },
            {
              title: "操作",
              width: 110,
              // 这里只负责挑一段进去看：没看过视频就下结论没有意义，所以确认/通过
              // 都放在工作台底部，看完当场点
              render: (_: unknown, t) => (
                <Button size="small" type="link" loading={wsLoading === t.task_id} onClick={() => openWorkspace(t.task_id)}>
                  查看标注
                </Button>
              ),
            },
          ]}
        />
      </Modal>
      <Modal
        title={`${photoFor?.date ?? ""} ${photoFor?.dog_name ?? ""} 的皮肤照片（${photoFor?.photo_count ?? 0} 张）`}
        open={photoFor != null}
        onCancel={() => setPhotoFor(null)}
        footer={null}
        width={820}
      >
        {photoFor && (
          <PhotoGallery
            album="skin"
            hint="点图放大，可左右翻"
            filterDate={photoFor.date}
            filterDog={photoFor.photo_dog ?? photoFor.dog_name}
          />
        )}
      </Modal>
    </div>
  );
}

// ── 项目联动：标注平台 AI 版 / 人工版抓挠统计 ──────────────────────────

// 筛选条件记在浏览器本地；结果本身存在后端 skin_daily_stats 表里，打开页面直接读库
const LINK_FILTER_KEY = "skin-link-filter";
type LinkFilter = { from: string; to: string; projectId: number | null; includeDrafts: boolean };
const loadLinkFilter = (): LinkFilter => {
  try {
    const raw = localStorage.getItem(LINK_FILTER_KEY);
    if (raw) return JSON.parse(raw) as LinkFilter;
  } catch { /* 存不了就用默认值 */ }
  return {
    from: dayjs().subtract(13, "day").format("YYYY-MM-DD"),
    to: dayjs().format("YYYY-MM-DD"),
    projectId: null,
    includeDrafts: false,
  };
};

function LinkTab(p: {
  opts: SkinOptions;
  onApply: (c: CInputs, meta: { fill_date: string | null; dog_name: string | null; imu: string; source: CSource; ai: { total: number | null; tier: string | null } | null; human: { total: number | null; tier: string | null } | null }) => void;
}) {
  const qcLink = useQueryClient();
  const [f, setF] = useState<LinkFilter>(loadLinkFilter);
  const setFilter = (patch: Partial<LinkFilter>) =>
    setF((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(LINK_FILTER_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  const range: [dayjs.Dayjs, dayjs.Dayjs] = [dayjs(f.from), dayjs(f.to)];
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: listProjects });

  // 打开就读库里存好的结果，不扫 NAS、不调 AI 服务
  const { data, isFetching } = useQuery({
    queryKey: ["skin-link", f.from, f.to],
    queryFn: () => skinLinkStats({ date_from: f.from, date_to: f.to }),
    refetchOnWindowFocus: false,
  });
  const [recomputing, setRecomputing] = useState(false);
  const rows = data?.rows ?? [];
  const warnings = data?.warnings ?? [];
  const loading = isFetching || recomputing;

  // 重新拉取 = 扫一遍 NAS / 任务重算，覆盖库里的结果；标注有更新时才需要点
  const pull = async () => {
    setRecomputing(true);
    try {
      const r = await skinLinkStats({
        date_from: f.from, date_to: f.to, project_id: f.projectId, include_drafts: f.includeDrafts, refresh: true,
      });
      qcLink.setQueryData(["skin-link", f.from, f.to], r);
      if (!r.rows.length) message.info(r.warnings[0] ?? "这段日期里没有样本/任务");
      else message.success(`已重新计算并保存 ${r.rows.length} 行`);
    } finally {
      setRecomputing(false);
    }
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
        <DatePicker.RangePicker
          value={range}
          onChange={(v) => v && v[0] && v[1] && setFilter({ from: v[0].format("YYYY-MM-DD"), to: v[1].format("YYYY-MM-DD") })}
          allowClear={false}
        />
        <Select allowClear placeholder="全部项目" style={{ width: 220 }} value={f.projectId ?? undefined} onChange={(v) => setFilter({ projectId: v ?? null })}
          options={(projects ?? []).map((pr) => ({ value: pr.id, label: pr.name }))} />
        <Checkbox checked={f.includeDrafts} onChange={(e) => setFilter({ includeDrafts: e.target.checked })}>
          人工版包含未审核的草稿
        </Checkbox>
        <Button type="primary" loading={loading} onClick={pull}>重新拉取</Button>
        {data && !loading && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {rows.length} 行{data.from_cache ? "（存在服务器上，打开就有）" : "（刚算完并已保存）"}
            {/* 过几天再看这张表，得知道它是不是还反映当前的标注 */}
            {data.computed_at && <>，数据算于 <b>{data.computed_at}</b></>}；
            标注有更新、或者改了上面的条件，再点「重新拉取」
          </Typography.Text>
        )}
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        按 (日期, IMU) 聚合标注平台上的「抓挠」片段：<b>AI 版</b> = 稳定版预标注的原始结果（人改过也不受影响），
        <b>人工版</b> = 已提交/已通过任务里当前的片段（勾上「包含未审核的草稿」就把标注中/待认领里已经标了的也算进来）。结果存在服务器上，打开页面直接读；基线用<b>所有算过的天</b>算，不只是这次选的范围。
        「人工完整」= 当天所有任务都已通过；「部分」= 有的还没审，人工版数字偏低。
      </Typography.Paragraph>
      {warnings.length > 0 && (
        // 拉不到数或者数字看着不对时，原因基本都在这里（AI 服务没起、样本缺时间戳……）
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={`有 ${warnings.length} 条提示`}
          description={
            <div style={{ maxHeight: 120, overflow: "auto", fontSize: 12 }}>
              {warnings.slice(0, 20).map((w, i) => (
                <div key={i}>{w}</div>
              ))}
              {warnings.length > 20 && <div>…还有 {warnings.length - 20} 条</div>}
            </div>
          }
        />
      )}
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
