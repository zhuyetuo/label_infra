import { useMemo, useState } from "react";
import {
  Alert, Button, DatePicker, Input, InputNumber, Progress, Select, Space, Table, Tag, Tooltip, Typography, message,
} from "antd";
import dayjs from "dayjs";
import { useQuery } from "@tanstack/react-query";
import {
  compareModels, createEvalSet, getEvalRunProgress, listEvalRuns, listEvalSets, startEvalRun,
  type CompareResult, type VersionDiff, type VersionResult,
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
const modeLabel = (m: string) => INFER_MODE_LABEL[m] ?? m;

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
  const [result, setResult] = useState<CompareResult | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: runs, refetch: refetchRuns } = useQuery({ queryKey: ["eval-runs"], queryFn: listEvalRuns });
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
          options={MODES.map((m) => ({ value: m, label: modeLabel(m) }))}
          maxTagCount="responsive"
        />
        <Tooltip title="几个版本对这批样本各跑一遍，结果按 (模型, 版本) 分开存。不写任何草稿，标注员那边不受影响">
          <Button onClick={handleRun} disabled={prog?.status === "running"}>
            跑这几个版本
          </Button>
        </Tooltip>
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
            {result.n_samples} 个样本、{result.n_truth} 段人工标注当正确答案，IoU≥{result.iou_min} 算同一段。
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
