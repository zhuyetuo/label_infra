import { useMemo, useState } from "react";
import {
  Alert, Button, DatePicker, Input, InputNumber, Progress, Select, Space, Table, Tag, Tooltip, Typography, message,
} from "antd";
import dayjs from "dayjs";
import { useQuery } from "@tanstack/react-query";
import { listLabels } from "@/api/labels";
import {
  compareModels, createEvalSet, getEvalRunProgress, listEdgeModels, listEvalRuns, listEvalSets,
  startEvalRun, type CompareResult, type VersionDiff, type VersionResult,
} from "@/api/modelEval";
import { INFER_MODE_LABEL } from "@/utils/inferMode";
import ThresholdCurve from "@/components/ThresholdCurve";

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

const MODES = ["stable", "viterbi", "raw"];
/** 端侧模型的版本字符串前缀，跟后端 edge_client.EDGE_PREFIX 是同一个约定 */
const EDGE_PREFIX = "edge:";
const isEdge = (m: string) => m.startsWith(EDGE_PREFIX);
const modeLabel = (m: string) =>
  isEdge(m) ? `端侧 · ${m.slice(EDGE_PREFIX.length)}` : (INFER_MODE_LABEL[m] ?? m);

export default function ModelCompare() {
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

  const { data: runs, refetch: refetchRuns } = useQuery({ queryKey: ["eval-runs"], queryFn: listEvalRuns });
  // 端侧服务挂着哪些模型。**问服务，不读前端写死的列表**——
  // 写死的话服务换了模型，这里会出现一个选了就报错的选项
  const { data: edge } = useQuery({ queryKey: ["edge-models"], queryFn: listEdgeModels });
  const { data: sets, refetch: refetchSets } = useQuery({ queryKey: ["eval-sets"], queryFn: listEvalSets });
  // 跑批期间轮询进度
  const { data: prog } = useQuery({
    queryKey: ["eval-run-progress"],
    queryFn: getEvalRunProgress,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false),
  });

  const options = useMemo(
    () =>
      (runs ?? []).map((r) => ({
        value: `${r.model_tag}::${r.mode}`,
        label: `${r.model_tag} · ${modeLabel(r.mode)}（${r.n_samples} 个样本）`,
      })),
    [runs]
  );

  const scope = () => (setId ? { set_id: setId } : { date_from: range[0], date_to: range[1] });

  const handleCreateSet = async () => {
    if (!setName.trim()) return message.warning("给评测集起个名字");
    const r = await createEvalSet({ name: setName.trim(), date_from: range[0], date_to: range[1] });
    message.success(`已冻结「${r.name}」，${r.n_samples} 个样本`);
    setSetName("");
    refetchSets();
  };

  const handleRun = async () => {
    if (!runModes.length) return message.warning("至少选一个版本");
    const r = await startEvalRun({ ...scope(), modes: runModes });
    message[r.started ? "success" : "warning"](
      r.started ? `开始跑：${r.n_samples} 个样本 × ${r.modes.length} 个版本` : "已经有一批在跑了，等它跑完"
    );
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
            人工标了「待定」的片段和采集掉数据的时段一律不计分——那些本来就没有正确答案。
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
          style={{ minWidth: 240 }}
          value={runModes}
          onChange={setRunModes}
          options={[
            { label: "算法服务（imu_train 的 label_service）", options: MODES.map((m) => ({ value: m, label: modeLabel(m) })) },
            // 端侧那组：服务没配/没起来时这一组是空的，antd 会自动不显示分组标题。
            // 不写死在前端，是因为写死的话服务换了模型，这里会出现一个
            // 选了就报错的选项，而错误是"没有这个端侧模型"
            {
              label: "端侧模型（跑的是烧进项圈的那份 C）",
              options: (edge?.models ?? []).map((m) => ({
                value: m.spec,
                label: `${m.tag}（${m.window} 点 @${m.hz}Hz）`,
              })),
            },
          ]}
          maxTagCount="responsive"
        />
        <Tooltip title="几个版本对这批样本各跑一遍，结果按 (模型, 版本) 分开存。不写任何草稿，标注员那边不受影响">
          <Button onClick={handleRun} disabled={prog?.status === "running"}>
            跑这几个版本
          </Button>
        </Tooltip>
        {/* 配了但连不上时下拉里那一组是空的，而人看不出为什么——
            "没开这个功能"和"开了但服务挂了"必须分得开，否则会以为是自己选错了 */}
        {edge?.enabled && (edge?.models?.length ?? 0) === 0 && (
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
        {prog?.status === "done" && (
          <Button size="small" type="link" onClick={() => refetchRuns()}>
            跑完了，刷新版本列表
          </Button>
        )}
      </Space>

      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          mode="multiple"
          style={{ minWidth: 420 }}
          placeholder="选要对比的版本（第一个当基准）"
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

          {result.diffs.length > 0 && (
            <>
              <Typography.Text strong>相对基准（{result.versions[0]?.model_tag} · {modeLabel(result.versions[0]?.mode ?? "")}）</Typography.Text>
              <Table<VersionDiff>
                size="small"
                rowKey="other"
                pagination={false}
                style={{ marginTop: 4, marginBottom: 16 }}
                dataSource={result.diffs}
                columns={[
                  { title: "版本", dataIndex: "other" },
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
