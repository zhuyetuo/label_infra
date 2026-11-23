import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Button, Checkbox, Descriptions, InputNumber, Progress, Segmented, Select, Space, Table, Tag,
  Tooltip, Typography, message,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import { listLabels } from "@/api/labels";
import { listProjects } from "@/api/projects";
import { useInferModes } from "@/hooks/useInferModes";
import {
  diffModels, getEvalRunProgress, listEvalRuns, startEvalRun,
  type ABDiffResult, type ABSampleDiff, type ABSegRow, type ScopeParams,
} from "@/api/modelEval";
import { modeLabelOf } from "@/utils/inferMode";

/**
 * 两个版本互比：同一批样本，A/B 各跑一遍，看两边答得一样不一样。
 *
 * 跟「跟人工标注比」是两回事，也**不依赖人工标注**：
 *   - 跟人工比：要有人标的正确答案，回答"准不准"
 *   - 两版互比：A 和 B 互相就是参照物，回答"换模型之后哪里变了"
 * 所以还没人审过的项目也能直接比——那恰恰是最想先看一眼的时候。
 *
 * 范围三种：单个项目 / 多选项目 / 全部项目。多数时候看一个项目；
 * 有空了再挑几个或者全量扫一遍。
 */

type ScopeMode = "single" | "multi" | "all";

const clock = (ms: number) => {
  const t = Math.max(0, ms) / 1000;
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
};
// 带正负的秒数：正 = B 比 A 晚
const signed = (ms: number | null | undefined) =>
  ms == null ? "—" : `${ms >= 0 ? "+" : ""}${(ms / 1000).toFixed(1)}s`;
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

/** 上一次的对比参数和报告。刷新/切走再回来直接用，不用重新跑一遍 */
const STORAGE_KEY = "model-ab-diff-v1";
type SavedDiff = {
  scopeMode: ScopeMode;
  singleId?: number;
  multiIds: number[];
  runA?: string;
  runB?: string;
  pickA?: string;
  pickB?: string;
  evalLabel: string;
  iouMin: number;
  maxSamples: number;
  realOnly: boolean;
  result: ABDiffResult;
};
const readSavedDiff = (): SavedDiff | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedDiff) : null;
  } catch {
    return null;
  }
};

/** 把「界面上的版本 spec」对到「库里存的 (model_tag, mode)」。
 *  存的 mode 可能是 spec 本身（srv:train49@viterbi_precise）、基础 mode（viterbi），
 *  端侧则是 (模型标签, board/raw/viterbi)，前缀不进库。 */
const findRun = <T extends { model_tag: string; mode: string }>(spec: string, rs: T[]): T | undefined => {
  const exact = rs.find((r) => r.mode === spec);
  if (exact) return exact;
  if (spec.startsWith("edge:")) {
    const [tag, suffix] = spec.slice(5).split("@");
    const mode = suffix || "viterbi";
    const hit = rs.find((r) => r.model_tag === tag && r.mode === mode);
    if (hit) return hit;
  }
  const base = spec.split("@")[0];
  return rs.find((r) => r.mode === base || r.mode.startsWith(`${base}@`));
};

const SegList = ({ rows }: { rows: ABSegRow[] }) => (
  <div style={{ fontSize: 12, lineHeight: 1.9, maxHeight: 260, overflow: "auto" }}>
    {rows.length === 0 && <Typography.Text type="secondary">没有片段</Typography.Text>}
    {rows.map((r, i) => {
      if (r.kind === "both") {
        const same = r.same_label !== false;
        return (
          <div key={i}>
            <Tag color={same ? "green" : "red"}>{same ? "类别一致" : "类别不同"}</Tag>
            <Tag>{r.label_a ?? "—"}</Tag>
            {!same && <>→ <Tag color="orange">{r.label_b ?? "—"}</Tag></>}
            A {clock(r.a!.start_ms)}–{clock(r.a!.end_ms)} → B {clock(r.b!.start_ms)}–{clock(r.b!.end_ms)}
            <Typography.Text type="secondary">
              {same
                ? `（Δ起 ${signed(r.d_start_ms)}，Δ止 ${signed(r.d_end_ms)}，IoU ${r.iou?.toFixed(2)}）`
                : "（类别都不同，起止差不用比）"}
            </Typography.Text>
          </div>
        );
      }
      if (r.kind === "only_a") {
        return (
          <div key={i}>
            <Tag color="blue">只有 A</Tag>
            {r.label && <Tag>{r.label}</Tag>}
            {clock(r.a!.start_ms)}–{clock(r.a!.end_ms)}
            <Typography.Text type="secondary">（B 这一版没认出来）</Typography.Text>
          </div>
        );
      }
      return (
        <div key={i}>
          <Tag color="purple">只有 B</Tag>
          {r.label && <Tag>{r.label}</Tag>}
          {clock(r.b!.start_ms)}–{clock(r.b!.end_ms)}
          <Typography.Text type="secondary">（A 这一版没认出来）</Typography.Text>
        </div>
      );
    })}
  </div>
);

export default function ModelABDiff({ initialProjectId }: { initialProjectId?: number }) {
  const navigate = useNavigate();
  // 恢复上次的报告和参数。从项目页点进来时只恢复同一个项目的——
  // 否则点 A 项目的「两版对比」，会把上次 B 项目的报告显示过来
  const saved = useMemo(
    () => {
      const s = readSavedDiff();
      if (!s) return null;
      if (initialProjectId && !(s.scopeMode === "single" && s.singleId === initialProjectId)) return null;
      return s;
    },
    [initialProjectId]
  );
  const [scopeMode, setScopeMode] = useState<ScopeMode>(saved?.scopeMode ?? "single");
  const [singleId, setSingleId] = useState<number | undefined>(saved?.singleId ?? initialProjectId);
  const [multiIds, setMultiIds] = useState<number[]>(
    saved?.multiIds ?? (initialProjectId ? [initialProjectId] : [])
  );
  const [runA, setRunA] = useState<string | undefined>(saved?.runA);
  const [runB, setRunB] = useState<string | undefined>(saved?.runB);
  const [pickA, setPickA] = useState<string | undefined>(saved?.pickA);
  const [pickB, setPickB] = useState<string | undefined>(saved?.pickB);
  // 以「抓挠」为事件来比：两边都检出抓挠的看类别和起止；一边检出抓挠、
  // 另一边在这段认成活动/睡觉的，算类别不一致。选「全部类别」则把状态段也全部比一遍
  const [evalLabel, setEvalLabel] = useState(saved?.evalLabel ?? "抓挠");
  const [iouMin, setIouMin] = useState(saved?.iouMin ?? 0.3);
  const [maxSamples, setMaxSamples] = useState(saved?.maxSamples ?? 30);
  const [realOnly, setRealOnly] = useState(saved?.realOnly ?? true);
  const [result, setResult] = useState<ABDiffResult | null>(saved?.result ?? null);
  const [busy, setBusy] = useState(false);

  const { options: modeOptions, edgeOffline } = useInferModes();
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: listProjects, staleTime: 60_000 });
  const { data: allLabels } = useQuery({ queryKey: ["labels", "all"], queryFn: () => listLabels() });
  const labelOptions = useMemo(() => {
    const names = [...new Set((allLabels ?? []).map((l) => l.display_name))];
    names.sort((a, b) => Number(b.startsWith("抓挠")) - Number(a.startsWith("抓挠")) || a.localeCompare(b));
    return [
      { value: "", label: "全部类别" },
      ...(names.length ? names : ["抓挠"]).map((n) => ({ value: n, label: n })),
    ];
  }, [allLabels]);

  // 范围：单个项目 / 多选项目 / 全部项目
  const scope = useMemo<ScopeParams | null>(() => {
    if (scopeMode === "single") return singleId ? { project_ids: [singleId] } : null;
    if (scopeMode === "multi") return multiIds.length ? { project_ids: multiIds } : null;
    return { all_projects: true };
  }, [scopeMode, singleId, multiIds]);

  const { data: runsResp, refetch: refetchRuns } = useQuery({
    queryKey: ["ab-runs", scope],
    queryFn: () => listEvalRuns(scope as ScopeParams),
    enabled: Boolean(scope),
  });
  const runs = runsResp?.runs ?? [];
  const nScope = runsResp?.n_scope ?? null;

  // 跑批进度：跟「跟人工比」那页共用同一份后端单例
  const { data: prog, refetch: refetchProg } = useQuery({
    queryKey: ["eval-run-progress"],
    queryFn: getEvalRunProgress,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false),
  });
  // 点了「跑」之后记下选的两个版本，跑完自动选进 A/B 下拉
  const pending = useRef<string[]>([]);
  const lastStatus = useRef(prog?.status);
  useEffect(() => {
    if (lastStatus.current === "running" && prog?.status && prog.status !== "running") {
      void (async () => {
        const res = await refetchRuns();
        const rs = res.data?.runs ?? [];
        const keys = pending.current.map((spec) => {
          const hit = findRun(spec, rs);
          return hit ? `${hit.model_tag}::${hit.mode}` : undefined;
        });
        if (keys[0]) setPickA(keys[0]);
        if (keys[1]) setPickB(keys[1]);
        if (prog.status === "done") {
          message[prog.failed ? "warning" : "success"](`跑完了：成功 ${prog.done}，失败 ${prog.failed}`);
        }
      })();
    }
    lastStatus.current = prog?.status;
  }, [prog?.status, prog?.done, prog?.failed, refetchRuns]);

  const runOptions = useMemo(
    () =>
      runs.map((r) => ({
        value: `${r.model_tag}::${r.mode}`,
        label:
          `${r.model_tag} · ${modeLabelOf(r.mode)}` +
          (nScope != null ? `（这批跑了 ${r.n_samples}/${nScope}）` : `（${r.n_samples} 个样本）`),
      })),
    [runs, nScope]
  );
  // 换范围之后旧的选项可能不在了；顺手把前两个已跑过的版本选上
  useEffect(() => {
    const ok = new Set(runOptions.map((o) => o.value));
    setPickA((p) => (p && ok.has(p) ? p : runOptions[0]?.value));
    setPickB((p) => (p && ok.has(p) ? p : runOptions[1]?.value));
  }, [runOptions]);

  // 这批里各自跑了没有。**跑过的不再重跑**：两个版本都跑满就只剩「出差异报告」这一步；
  // 只缺一个就只补那一个——以前点一下会把两个都重跑一遍，白等一倍时间
  const foundA = runA ? findRun(runA, runs) : undefined;
  const foundB = runB ? findRun(runB, runs) : undefined;
  const fullA = Boolean(foundA && nScope != null && foundA.n_samples >= nScope);
  const fullB = Boolean(foundB && nScope != null && foundB.n_samples >= nScope);
  const missingModes: string[] = [];
  if (runA && !fullA) missingModes.push(runA);
  if (runB && !fullB && runB !== runA) missingModes.push(runB);
  const bothDone = Boolean(runA && runB && runA !== runB && fullA && fullB);

  const selectBothPicks = () => {
    if (runA && foundA) setPickA(`${foundA.model_tag}::${foundA.mode}`);
    if (runB && foundB) setPickB(`${foundB.model_tag}::${foundB.mode}`);
  };

  const handleRun = async () => {
    if (!scope) return message.warning("先选项目");
    if (!runA || !runB) return message.warning("选两个版本");
    if (runA === runB) return message.warning("A 和 B 是同一个版本，换一个");
    if (!missingModes.length) {
      selectBothPicks();
      return message.success("两个版本这批都已经跑过了，直接点「出差异报告」就行");
    }
    const r = await startEvalRun({ ...scope, modes: missingModes });
    message[r.started ? "success" : "warning"](
      r.started
        ? `开始跑：${r.n_samples} 个样本 × ${missingModes.length} 个版本` +
            (missingModes.length === 1 ? "（另一个这批已经跑过，跳过）" : "")
        : "已经有一批在跑了，等它跑完"
    );
    pending.current = [runA, runB];
    if (r.started) refetchProg();
  };

  const splitKey = (k: string) => {
    const [model_tag, mode] = k.split("::");
    return { model_tag, mode };
  };

  // 选了跟另一边相同的版本就顺手对调，而不是把人拦住（只有两个选项时也能换 A/B）
  const chooseA = (v: string) => {
    if (v === pickB) setPickB(pickA);
    setPickA(v);
  };
  const chooseB = (v: string) => {
    if (v === pickA) setPickA(pickB);
    setPickB(v);
  };

  const handleDiff = async () => {
    if (!scope) return message.warning("先选项目");
    if (!pickA || !pickB) return message.warning("选两个已经跑过的版本");
    if (pickA === pickB) return message.warning("A 和 B 是同一个版本");
    setBusy(true);
    try {
      const res = await diffModels({
        ...scope,
        a: splitKey(pickA),
        b: splitKey(pickB),
        label: evalLabel || undefined,
        iou_min: iouMin,
        max_samples: maxSamples,
      });
      setResult(res);
      // 报告和它对应的参数一起存：刷新、切去别页再回来直接还在，
      // 不用为了看一眼上次的结果重新算一遍
      try {
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            scopeMode, singleId, multiIds, runA, runB, pickA, pickB,
            evalLabel, iouMin, maxSamples, realOnly, result: res,
          })
        );
      } catch {
        // 隐私模式 / 存储满了：退回只在内存里保留
      }
    } finally {
      setBusy(false);
    }
  };

  const showRows = (result?.diverged_samples ?? []).filter(
    (s) => !realOnly || s.only_a + s.only_b + s.label_diff > 0
  );

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="怎么用"
        description={
          <>
            同一批样本，让<b>两个版本各跑一遍</b>，然后看两边答得一样不一样——<b>不需要人工标注</b>，
            所以还没审过的项目也能直接比。
            「只有 A 有」= B 这一版没认出来；「只有 B 有」= B 新认出来的；两边都有的，先看<b>类别是不是一样</b>，
            类别相同时再看<b>起止差了多少</b>。
            多数时候只看一个项目；有空了再选几个或全部项目扫一遍。
          </>
        }
      />

      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented
          value={scopeMode}
          onChange={(v) => setScopeMode(v as ScopeMode)}
          options={[
            { label: "单个项目", value: "single" },
            { label: "多选项目", value: "multi" },
            { label: "全部项目", value: "all" },
          ]}
        />
        {scopeMode === "single" && (
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 260 }}
            placeholder="选项目"
            value={singleId}
            onChange={setSingleId}
            options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
          />
        )}
        {scopeMode === "multi" && (
          <Select
            mode="multiple"
            showSearch
            optionFilterProp="label"
            style={{ minWidth: 300, maxWidth: 560 }}
            placeholder="选几个项目（可多选）"
            value={multiIds}
            onChange={setMultiIds}
            maxTagCount="responsive"
            options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
          />
        )}
        {scopeMode === "all" && (
          <Tag color="orange">
            全部项目{nScope != null ? `：${nScope} 个样本` : ""}，跑起来很重
          </Tag>
        )}
        {scopeMode !== "all" && nScope != null && (
          <Typography.Text type="secondary">这批 {nScope} 个样本</Typography.Text>
        )}
      </Space>

      {scopeMode === "all" && nScope != null && nScope > 3000 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`全部项目有 ${nScope} 个样本，两个版本各跑一遍会占用 AI 服务很久`}
          description="建议先挑一个项目验证效果，确认值得跑再全量。跑批在后台进行，跑完这一页会自动刷新版本下拉。"
        />
      )}

      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          style={{ width: 300 }}
          value={runA}
          onChange={setRunA}
          placeholder="选 A 版"
          options={modeOptions}
          popupMatchSelectWidth={false}
        />
        <Select
          style={{ width: 300 }}
          value={runB}
          onChange={setRunB}
          placeholder="选 B 版"
          options={modeOptions}
          popupMatchSelectWidth={false}
        />
        <Tooltip
          title={
            bothDone
              ? "两个版本这批都跑满了，不用再跑，直接点下面「出差异报告」"
              : "已经在这批跑满的版本会自动跳过，只补跑缺的那个；结果分开存，不写任何人的草稿"
          }
        >
          <Button onClick={handleRun} disabled={prog?.status === "running" || bothDone}>
            {bothDone
              ? "两个版本都已跑过"
              : missingModes.length === 1
                ? "补跑缺的 1 个版本"
                : "跑这两个版本"}
          </Button>
        </Tooltip>
        {runA && nScope != null && (
          <Tag color={fullA ? "green" : foundA ? "orange" : undefined}>
            A {foundA ? `已跑 ${foundA.n_samples}/${nScope}` : "这批未跑"}
          </Tag>
        )}
        {runB && nScope != null && (
          <Tag color={fullB ? "green" : foundB ? "orange" : undefined}>
            B {foundB ? `已跑 ${foundB.n_samples}/${nScope}` : "这批未跑"}
          </Tag>
        )}
        {edgeOffline && (
          <Tooltip title="后端配了 EDGE_SERVICE_URL，但连不上或者那边没挂模型">
            <Tag color="warning">端侧服务连不上</Tag>
          </Tooltip>
        )}
        {prog?.status === "running" && (
          <Space>
            <Progress
              size="small"
              style={{ width: 160 }}
              percent={prog.total ? Math.round(((prog.done + prog.failed) / prog.total) * 100) : 0}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {prog.current} · 成功 {prog.done} / 失败 {prog.failed}
            </Typography.Text>
          </Space>
        )}
      </Space>

      {/* 「已跑过」只算当前这批样本，跟训练页的「训练记录」不是一回事：
          模型训过不代表已经在这批数据上跑过。这里把两边的差别说清楚，
          免得以为少了一个选项是页面坏了 */}
      {runs.length === 1 && !bothDone && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="「已跑过」里只有 1 个版本，是因为它只算当前这批样本跑过的版本"
          description="训练记录里的模型训过，不等于已经在这批样本上跑过。点上面的按钮会补跑缺的那个版本，已经跑满的不会重跑；两个都跑完后会一起出现在「已跑过」下拉里。"
        />
      )}

      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          style={{ width: 300 }}
          placeholder={runs.length ? "A 版（已跑过）" : "这批还没跑过，先点上面「跑这两个版本」"}
          value={pickA}
          onChange={chooseA}
          options={runOptions}
          popupMatchSelectWidth={false}
        />
        <Select
          style={{ width: 300 }}
          placeholder="B 版（已跑过）"
          value={pickB}
          onChange={chooseB}
          options={runOptions}
          popupMatchSelectWidth={false}
        />
        <Select
          showSearch
          style={{ width: 160 }}
          value={evalLabel}
          onChange={setEvalLabel}
          options={labelOptions}
        />
        <Tooltip title="两边片段重叠多少算「同一段」。0.3 宽松；想专门考察起止就调到 0.5 以上">
          <InputNumber
            addonBefore="IoU≥"
            min={0.1}
            max={0.9}
            step={0.1}
            value={iouMin}
            onChange={(v) => setIouMin(v ?? 0.3)}
            style={{ width: 130 }}
          />
        </Tooltip>
        <Tooltip title="分歧样本最多列多少个（按分歧数排序）">
          <InputNumber
            addonBefore="最多"
            min={1}
            max={200}
            value={maxSamples}
            onChange={(v) => setMaxSamples(v ?? 30)}
            style={{ width: 120 }}
          />
        </Tooltip>
        <Button type="primary" loading={busy} onClick={handleDiff}>
          出差异报告
        </Button>
      </Space>

      {result && (
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            A = <Tag color="blue">{result.a.model_tag} · {modeLabelOf(result.a.mode)}</Tag>
            B = <Tag color="purple">{result.b.model_tag} · {modeLabelOf(result.b.mode)}</Tag>
            评的是「{evalLabel || "全部类别"}」；{result.n_covered}/{result.n_scope} 个样本两版都跑过，IoU≥{result.iou_min} 算同一时段。
          </Typography.Paragraph>
          {result.warnings.length > 0 && (
            <Alert
              type="warning"
              style={{ marginBottom: 8 }}
              message={`有 ${result.warnings.length} 条提示`}
              description={
                <div style={{ maxHeight: 120, overflow: "auto", fontSize: 12 }}>
                  {result.warnings.map((w, i) => <div key={i}>{w}</div>)}
                </div>
              }
            />
          )}
          <Descriptions size="small" bordered column={4} style={{ marginBottom: 12 }}>
            <Descriptions.Item label="A 段数">{result.totals.n_seg_a ?? "—"}</Descriptions.Item>
            <Descriptions.Item label="B 段数">{result.totals.n_seg_b ?? "—"}</Descriptions.Item>
            <Descriptions.Item label="两边都有（配对）">
              <Tag color="green">{result.totals.matched ?? 0}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="平均 IoU">
              {result.totals.mean_iou == null ? "—" : result.totals.mean_iou.toFixed(3)}
            </Descriptions.Item>
            <Descriptions.Item label="只有 A 有">
              <Tag color="blue">{result.totals.only_a ?? 0}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="只有 B 有">
              <Tag color="purple">{result.totals.only_b ?? 0}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="类别不一致">
              <Tag color={(result.totals.label_diff ?? 0) ? "red" : "green"}>
                {result.totals.label_diff ?? 0}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="类别一致率">
              {pct(result.totals.label_same_ratio)}
            </Descriptions.Item>
            <Descriptions.Item label={`同类别起止差 > ${result.edge_2s_ms / 1000}s`}>
              <Tag color={(result.totals.boundary_bad ?? 0) ? "orange" : "green"}>
                {result.totals.boundary_bad ?? 0}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="起止都在 ±2s">
              {pct(result.totals.within_2s_ratio)}
            </Descriptions.Item>
            <Descriptions.Item label="Δ起（B−A）">
              {signed(result.totals.d_start_mean_ms)}
            </Descriptions.Item>
            <Descriptions.Item label="Δ止（B−A）">
              {signed(result.totals.d_end_mean_ms)}
            </Descriptions.Item>
            <Descriptions.Item label="起止平均偏差">
              {signed(result.totals.d_start_abs_mean_ms)} / {signed(result.totals.d_end_abs_mean_ms)}
            </Descriptions.Item>
            <Descriptions.Item label="有分歧的样本">
              {result.n_diverged}
            </Descriptions.Item>
          </Descriptions>

          <Space style={{ marginBottom: 8 }}>
            <Typography.Text strong>分歧样本（按分歧数排序）</Typography.Text>
            <Checkbox checked={realOnly} onChange={(e) => setRealOnly(e.target.checked)}>
              只看有实质分歧的（排除仅起止差 ≤2s 且类别一致的）
            </Checkbox>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              点样本行前面的箭头展开看具体片段
            </Typography.Text>
          </Space>
          <Table<ABSampleDiff>
            size="small"
            rowKey="sample_id"
            dataSource={showRows}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            expandable={{ expandedRowRender: (s) => <SegList rows={s.segments} /> }}
            columns={[
              { title: "样本", dataIndex: "sample_code", width: 180 },
              {
                title: "任务",
                width: 90,
                render: (_, s) =>
                  s.task_id ? (
                    <Button type="link" size="small" onClick={() => navigate(`/projects?task=${s.task_id}`)}>
                      #{s.task_id}
                    </Button>
                  ) : (
                    "—"
                  ),
              },
              {
                title: "A / B 段数",
                width: 100,
                render: (_, s) => `${s.n_a} / ${s.n_b}`,
              },
              { title: "配对", dataIndex: "matched", width: 70 },
              {
                title: "只有 A",
                width: 80,
                render: (_, s) => (s.only_a ? <Tag color="blue">{s.only_a}</Tag> : 0),
              },
              {
                title: "只有 B",
                width: 80,
                render: (_, s) => (s.only_b ? <Tag color="purple">{s.only_b}</Tag> : 0),
              },
              {
                title: "类别不一致",
                width: 100,
                render: (_, s) => (s.label_diff ? <Tag color="red">{s.label_diff}</Tag> : 0),
              },
              {
                title: "起止偏 >2s",
                width: 100,
                render: (_, s) => (s.boundary_bad ? <Tag color="orange">{s.boundary_bad}</Tag> : 0),
              },
              {
                title: "平均 Δ起 / Δ止",
                width: 140,
                render: (_, s) => `${signed(s.d_start_mean_ms)} / ${signed(s.d_end_mean_ms)}`,
              },
              { title: "分歧数", dataIndex: "diff_count", width: 80 },
            ]}
          />
        </>
      )}
    </div>
  );
}
