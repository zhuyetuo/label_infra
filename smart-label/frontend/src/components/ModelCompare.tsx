import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Button, DatePicker, Input, InputNumber, Progress, Segmented, Select, Space, Table, Tag, Tooltip,
  Typography, message,
} from "antd";
import dayjs from "dayjs";
import { useQuery } from "@tanstack/react-query";
import { listLabels } from "@/api/labels";
import { useInferModes } from "@/hooks/useInferModes";
import {
  compareModels, createEvalSet, getEvalRunProgress, listEvalRuns, listEvalSets,
  startEvalRun, type CompareResult, type VersionDiff, type VersionResult,
} from "@/api/modelEval";
import { modeLabelOf } from "@/utils/inferMode";
import ThresholdCurve from "@/components/ThresholdCurve";
import ModelABDiff from "@/components/ModelABDiff";

/**
 * 模型对比：同一批数据，几个模型/版本各跟人工标注比一遍。
 *
 * 训完新模型必然要问的那几个问题，这一页就是拿来回答的：
 *   以前漏的现在找到了吗？以前对的现在还对吗（回归）？起止变准还是变差了？
 *   置信度整体漂了没有——以前设的过滤阈值还管不管用？
 *
 * 三步：① 冻一个评测集（一批审过的样本，以后每次都用它，指标才可比）
 *      ② 让几个版本对这批各跑一遍（只存结果，不动任何人的草稿）
 *      ③ 出报告：P/R/F1、阈值曲线、以及"相对基准版本改进/回归了多少"
 */

// 版本显示名跟预标注那几处同一份：以前这里自己拼，服务端其它模型显示成 srv:xxx 原文
const modeLabel = modeLabelOf;
/** "model::mode" → 给人看的名字 */
const keyLabel = (k: string) => {
  const [tag, mode] = k.split("::");
  return `${tag} · ${modeLabel(mode ?? "")}`;
};

function HumanCompare() {
  const [setId, setSetId] = useState<number | undefined>();
  const [range, setRange] = useState<[string, string]>([
    dayjs().subtract(7, "day").format("YYYY-MM-DD"),
    dayjs().format("YYYY-MM-DD"),
  ]);
  const [setName, setSetName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [runModes, setRunModes] = useState<string[]>(["stable", "viterbi"]);
  const [iouMin, setIouMin] = useState(0.3);
  // 评哪个类别。**以前写死「抓挠」**（前端根本没传这个字段），于是拆成
  // 二级标签之后没法回答"它能不能分出是头颈耳还是躯干"这个问题
  const [evalLabel, setEvalLabel] = useState("抓挠");
  // 跑哪几个版本：跟预标注下拉同一份选项（含「不吞甩身体」、训练记录、端侧三种后处理）。
  // 以前这里自己拼一份，漏了好几项，训出来的端侧模型也只能选其中一种后处理
  const { options: modeOptions, edgeOffline } = useInferModes();
  // 候选类别从项目标签里来——这样拆出来的二级标签（抓挠-头颈耳）自动就在列表里，
  // 不用每加一个类别回来改一次代码
  const { data: allLabels } = useQuery({ queryKey: ["labels", "all"], queryFn: () => listLabels() });
  const labelOptions = useMemo(() => {
    const names = [...new Set((allLabels ?? []).map((l) => l.display_name))];
    // 「抓挠」和它的子类排最前：九成场合评的就是它们
    names.sort((a, b) => Number(b.startsWith("抓挠")) - Number(a.startsWith("抓挠")) || a.localeCompare(b));
    return (names.length ? names : ["抓挠"]).map((n) => ({ value: n, label: n }));
  }, [allLabels]);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [busy, setBusy] = useState(false);

  const scope = () => (setId ? { set_id: setId } : { date_from: range[0], date_to: range[1] });
  // 版本列表按当前这批样本数：显示「这批里跑了几个」，而不是全库。以前是全库，
  // 选上一个在这批里根本没跑过的版本，报告里全是漏检，看起来像模型很差
  const { data: runsResp, refetch: refetchRuns } = useQuery({
    queryKey: ["eval-runs", setId ?? null, setId ? null : range],
    queryFn: () => listEvalRuns(scope()),
  });
  const runs = runsResp?.runs;
  const nScope = runsResp?.n_scope ?? null;
  const { data: sets, refetch: refetchSets } = useQuery({ queryKey: ["eval-sets"], queryFn: listEvalSets });
  // 跑批期间轮询进度。**点了「跑」之后要手动拉一次**：初始状态是 idle，
  // refetchInterval 只在 running 时才转，以前不拉的话进度条永远不出来、
  // 也不会提示跑完，看起来像点了没反应
  const { data: prog, refetch: refetchProg } = useQuery({
    queryKey: ["eval-run-progress"],
    queryFn: getEvalRunProgress,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false),
  });
  // 跑完自动刷新版本列表，不用人再点一下
  const lastStatus = useRef(prog?.status);
  useEffect(() => {
    if (lastStatus.current === "running" && prog?.status && prog.status !== "running") {
      refetchRuns();
      if (prog.status === "done") {
        message[prog.failed ? "warning" : "success"](`跑完了：成功 ${prog.done}，失败 ${prog.failed}`);
      }
    }
    lastStatus.current = prog?.status;
  }, [prog?.status, prog?.done, prog?.failed, refetchRuns]);

  const options = useMemo(
    () =>
      (runs ?? []).map((r) => ({
        value: `${r.model_tag}::${r.mode}`,
        label:
          `${r.model_tag} · ${modeLabel(r.mode)}` +
          (nScope != null ? `（这批跑了 ${r.n_samples}/${nScope}）` : `（${r.n_samples} 个样本）`),
      })),
    [runs, nScope]
  );
  // 换了范围之后，已选的版本可能在新范围里没跑过，留着会一直报"没跑"
  useEffect(() => {
    if (!runs) return;
    const ok = new Set(runs.map((r) => `${r.model_tag}::${r.mode}`));
    setPicked((p) => (p.every((k) => ok.has(k)) ? p : p.filter((k) => ok.has(k))));
  }, [runs]);

  const handleCreateSet = async () => {
    if (!setName.trim()) return message.warning("给评测集起个名字");
    const r = await createEvalSet({ name: setName.trim(), date_from: range[0], date_to: range[1] });
    message.success(`已冻结「${r.name}」，${r.n_samples} 个样本`);
    setSetName("");
    await refetchSets();
    // 冻完直接选中：下一步就是拿它跑版本
    setSetId(r.id);
  };

  const handleRun = async () => {
    if (!runModes.length) return message.warning("至少选一个版本");
    const r = await startEvalRun({ ...scope(), modes: runModes });
    message[r.started ? "success" : "warning"](
      r.started ? `开始跑：${r.n_samples} 个样本 × ${r.modes.length} 个版本` : "已经有一批在跑了，等它跑完"
    );
    refetchProg();
  };

  const handleCompare = async () => {
    if (picked.length < 1) return message.warning("至少选一个版本来看");
    setBusy(true);
    try {
      setResult(
        await compareModels({
          ...scope(),
          versions: picked.map((p) => {
            const [model_tag, mode] = p.split("::");
            return { model_tag, mode };
          }),
          iou_min: iouMin,
          label: evalLabel,
        })
      );
    } finally {
      setBusy(false);
    }
  };

  const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="怎么用"
        description={
          <>
            ① 先<b>冻一个评测集</b>（一批已经审过的样本）——以后每训完一个模型都拿这同一批跑，指标才可比；
            ② 让几个版本<b>各跑一遍</b>（只存结果，不动任何人的草稿）；
            ③ <b>出报告</b>看 P/R/F1、阈值曲线、以及相对基准版本改进/回归了多少。
            只算<b>人工审过</b>、且<b>选中的版本都跑过</b>的样本；人工标了「待定」的片段和采集掉数据的时段也不计分——那些本来就没有正确答案。
          </>
        }
      />

      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear
          style={{ width: 260 }}
          placeholder="选评测集（不选就按下面的日期范围）"
          value={setId}
          onChange={setSetId}
          options={(sets ?? []).map((s) => ({ value: s.id, label: `${s.name}（${s.n_samples} 个样本）` }))}
        />
        {!setId && (
          <DatePicker.RangePicker
            value={[dayjs(range[0]), dayjs(range[1])]}
            onChange={(v) =>
              v && v[0] && v[1] && setRange([v[0].format("YYYY-MM-DD"), v[1].format("YYYY-MM-DD")])
            }
          />
        )}
        {!setId && (
          <Space.Compact>
            <Input
              style={{ width: 180 }}
              placeholder="冻成评测集，起个名字"
              value={setName}
              onChange={(e) => setSetName(e.target.value)}
            />
            <Button onClick={handleCreateSet}>冻结</Button>
          </Space.Compact>
        )}
      </Space>

      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          mode="multiple"
          style={{ width: 240 }}
          value={runModes}
          onChange={setRunModes}
          placeholder="选要跑的版本"
          options={modeOptions}
          popupMatchSelectWidth={false}
          maxTagCount="responsive"
        />
        <Tooltip title="几个版本对这批样本各跑一遍，结果按 (模型, 版本) 分开存。不写任何草稿，标注员那边不受影响">
          <Button onClick={handleRun} disabled={prog?.status === "running"}>
            跑这几个版本
          </Button>
        </Tooltip>
        {/* 配了但连不上时下拉里那一组是空的，而人看不出为什么——
            "没开这个功能"和"开了但服务挂了"必须分得开，否则会以为是自己选错了 */}
        {edgeOffline && (
          <Tooltip title="后端配了 EDGE_SERVICE_URL，但连不上或者那边没挂模型。去跑 edge_service.py 那台看一下">
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
        {prog?.status === "error" && <Tag color="error">跑批出错：{prog.current}</Tag>}
      </Space>
      {/* 失败原因以前只存在后端，界面上看不到——全失败的时候人只会觉得"点了没用" */}
      {prog && prog.status !== "idle" && prog.detail.length > 0 && (
        <Alert
          type={prog.failed ? "warning" : "info"}
          showIcon
          style={{ marginBottom: 12 }}
          message={`上一批：成功 ${prog.done}，失败 ${prog.failed}`}
          description={
            <div style={{ maxHeight: 120, overflow: "auto", fontSize: 12 }}>
              {prog.detail.map((d, i) => <div key={i}>{d}</div>)}
            </div>
          }
        />
      )}

      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          mode="multiple"
          style={{ width: 420 }}
          placeholder={runs && !runs.length ? "这批样本还没跑过任何版本，先点上面「跑这几个版本」" : "选要对比的版本（第一个当基准）"}
          value={picked}
          onChange={setPicked}
          options={options}
          maxTagCount="responsive"
        />
        {/* 评哪个类别。**以前写死「抓挠」**，拆成二级标签之后就没法回答
            "它到底能不能分出是头颈耳还是躯干"——那正是要拿这一页验的事 */}
        <Tooltip title="拿哪个类别的人工标注当答案。想验「能不能分出部位」就分别评「抓挠-头颈耳」和「抓挠-躯干」：两个的召回都不错 = 分得开；合起来的「抓挠」召回高、单看各自都低 = 检出没问题但部位认错了">
          <Select
            showSearch
            style={{ width: 170 }}
            value={evalLabel}
            onChange={setEvalLabel}
            placeholder="评哪个类别"
            options={labelOptions}
          />
        </Tooltip>
        <Tooltip title="重叠多少算「同一段」。0.3 宽松，起止差一点也认；想专门考察边界准不准就调到 0.5 以上">
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
        <Button type="primary" loading={busy} onClick={handleCompare}>
          出对比报告
        </Button>
      </Space>

      {result && (
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            评的是 <Tag color="blue">{evalLabel}</Tag>——
            {result.n_samples} 个样本、{result.n_truth} 段人工标注当正确答案，IoU≥{result.iou_min} 算同一段。
            {/* 不写清评的是哪个类别的话，分别评了头颈耳和躯干之后，
                两份报告摆在一起根本分不出哪份是哪份 */}
          </Typography.Paragraph>
          {result.warnings.length > 0 && (
            <Alert
              type="warning"
              style={{ marginBottom: 8 }}
              message={`有 ${result.warnings.length} 条提示`}
              description={<div style={{ maxHeight: 120, overflow: "auto", fontSize: 12 }}>{result.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>}
            />
          )}
          <Table<VersionResult>
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={result.versions}
            style={{ marginBottom: 16 }}
            columns={[
              {
                title: "版本",
                render: (_, v) => (
                  <Space size={4}>
                    <b>{v.model_tag}</b>
                    <Tag>{modeLabel(v.mode)}</Tag>
                  </Space>
                ),
              },
              { title: "覆盖样本", dataIndex: "n_samples_with_result", width: 90 },
              {
                title: "命中 / 误报 / 漏检",
                width: 160,
                render: (_, v) => (
                  <Space size={4}>
                    <Tag color="green">{v.tp}</Tag>
                    <Tag color="red">{v.fp}</Tag>
                    <Tag color="orange">{v.fn}</Tag>
                  </Space>
                ),
              },
              {
                title: "精确率",
                width: 90,
                sorter: (a, b) => a.precision - b.precision,
                render: (_, v) => pct(v.precision),
              },
              { title: "召回率", width: 90, sorter: (a, b) => a.recall - b.recall, render: (_, v) => pct(v.recall) },
              { title: "F1", width: 80, sorter: (a, b) => a.f1 - b.f1, render: (_, v) => pct(v.f1) },
              {
                title: "平均 IoU",
                width: 100,
                // 起止准不准就看这个：命中数一样但 IoU 掉了，说明边界变差了
                render: (_, v) => (
                  <Tooltip title="命中的那些段跟人工标注重叠得有多准。命中数一样但这个掉了 = 起止位置变差">
                    <span>{v.mean_iou == null ? "—" : v.mean_iou.toFixed(3)}</span>
                  </Tooltip>
                ),
              },
              {
                title: "置信度（命中 / 误报）",
                width: 170,
                render: (_, v) => (
                  <Tooltip title="误报的平均置信度往上漂 = 以前靠阈值能滤掉的误报现在滤不掉了，阈值得重新定">
                    <span>
                      {pct(v.hit_conf_mean)} / <b>{pct(v.fp_conf_mean)}</b>
                    </span>
                  </Tooltip>
                ),
              },
            ]}
          />

          {(result.diffs?.length ?? 0) > 0 && (
            <>
              <Typography.Text strong>相对基准（{result.versions[0]?.model_tag} · {modeLabel(result.versions[0]?.mode ?? "")}）</Typography.Text>
              <Table<VersionDiff>
                size="small"
                rowKey="other"
                pagination={false}
                style={{ marginTop: 4, marginBottom: 16 }}
                dataSource={result.diffs}
                columns={[
                  { title: "版本", dataIndex: "other", render: (k: string) => keyLabel(k) },
                  {
                    title: "新增命中",
                    width: 110,
                    render: (_, d) => <Tag color="green">+{d.gained}</Tag>,
                  },
                  {
                    title: "新增漏检（回归）",
                    width: 150,
                    render: (_, d) => (d.lost ? <Tag color="red">-{d.lost}</Tag> : <Tag color="green">0</Tag>),
                  },
                  { title: "两版都命中", width: 110, dataIndex: "both" },
                  {
                    title: "回归发生在哪些样本",
                    render: (_, d) =>
                      d.lost_samples.length ? (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          #{d.lost_samples.join(", #")}
                        </Typography.Text>
                      ) : (
                        "—"
                      ),
                  },
                ]}
              />
            </>
          )}

          <Typography.Text strong>阈值曲线</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
            横轴是置信度阈值，纵轴是精确率/召回率。阈值该设多少，看两条线的交叉点；换了模型之后曲线整体左右移动，就说明旧阈值不能直接沿用。
          </Typography.Paragraph>
          <ThresholdCurve versions={result.versions} />
        </>
      )}
    </div>
  );
}

/**
 * 模型对比页：两种比法。
 *   - 跟人工标注比：要有人标的正确答案，回答"准不准"
 *   - 两个版本互比：A/B 互相参照，不需要标注，回答"换模型之后哪里变了"
 * 默认还是老的那一个；从项目页点「两版对比」进来直接落在第二种。
 */
export default function ModelCompare({
  initialMode = "human",
  initialProjectId,
}: {
  initialMode?: "human" | "ab";
  initialProjectId?: number;
}) {
  const [mode, setMode] = useState<"human" | "ab">(initialMode);
  useEffect(() => setMode(initialMode), [initialMode]);
  return (
    <div>
      <Segmented
        style={{ marginBottom: 12 }}
        value={mode}
        onChange={(v) => setMode(v as "human" | "ab")}
        options={[
          { label: "跟人工标注比", value: "human" },
          { label: "两个版本互比", value: "ab" },
        ]}
      />
      {mode === "human" ? <HumanCompare /> : <ModelABDiff initialProjectId={initialProjectId} />}
    </div>
  );
}
