import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, Progress, Select, Space, Table, Tag, Tooltip, Typography, theme } from "antd";
import { RightOutlined } from "@ant-design/icons";
import { analyzeSelfTest, reportCharts, reportHtml, samplesCsv, type StReport, type StSample, type StStatus } from "@/utils/selfTest";
import { makeZip } from "@/utils/zip";
// 给嵌入式自己跑的脚本：同一套算法，能复现、能自己测、能把多次结果并排比（后端有测试钉住它）
import selfTestPy from "@/assets/petcollar_selftest.py?raw";

/**
 * 设备调试页「一键自检」：连续采一段（1~30 分钟），出一份报告：
 * 采样率 / 稳定性、帧间隔 / 稳定性、丢帧、板子时钟快慢 / 漂移、三轴底噪 / 稳定性。
 * 报告（HTML）和原始数据（CSV）可以下载，发给嵌入式一起看。
 *
 * 采样由页面推过来：sink.current 不为 null 时，页面每收到一个样本就 push 进去。
 */
const STATUS: Record<StStatus, { color: string; text: string }> = {
  ok: { color: "success", text: "通过" }, warn: { color: "warning", text: "注意" }, fail: { color: "error", text: "不通过" }, info: { color: "default", text: "参考" },
};

const OPEN_KEY = "smart-label:device-selftest-open";

const readme = (r: StReport, base: string) => {
  const wit = r.meta.kind === "wit";
  return `设备自检结果：${r.meta.device || "-"}，${new Date(r.meta.startedAt).toLocaleString()}，${(r.meta.durationS / 60).toFixed(1)} 分钟

文件
  report.html            报告，浏览器打开
  raw.csv                原始数据${wit ? "（时间用接收端的，含角速度）" : ""}
${wit ? "" : "  behavior.csv           0x07 当前行为的时间戳\n"}  result.json            结果
  petcollar_selftest.py  自检脚本

脚本用法（只要 Python 3；自己测再 pip install bleak）
  # 复现这次的结果
  python petcollar_selftest.py analyze raw.csv
  # 自己测（${wit ? "WitMotion" : "项圈要 PB_RAW_STREAM=1 的调试固件"}；--static = 设备静置平放）
  python petcollar_selftest.py run${wit ? " --device wit" : ""} --minutes 5 --static --tag 名字
  # 多次 / 多人的结果并排比（给 result.json 或文件夹）
  python petcollar_selftest.py compare ${base}/ selftest_xxx/

脚本和网页是同一套算法、判定和文字：同一份 raw.csv 算出来一模一样。对不上就是数据不同，不是算法不同。
`;
};

const save = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

export default function DeviceSelfTest({ sink, behavSink, connected, kind, device, expectHz, hasRaw }: {
  sink: React.MutableRefObject<StSample[] | null>;
  behavSink: React.MutableRefObject<number[] | null>;
  connected: boolean;
  kind: string;
  device: string;
  expectHz: number;
  /** 收到过 0x08 原始采样没有（正式固件不发） */
  hasRaw: boolean;
}) {
  const { token } = theme.useToken();
  const [minutes, setMinutes] = useState(5);
  const [still, setStill] = useState(true);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [report, setReport] = useState<StReport | null>(null);
  const data = useRef<{ samples: StSample[]; behav: number[] } | null>(null);
  // 收起来不占地方；记住上次的
  const [open, setOpenState] = useState(() => { try { return localStorage.getItem(OPEN_KEY) !== "0"; } catch { return true; } });
  const setOpen = (v: boolean) => { setOpenState(v); try { localStorage.setItem(OPEN_KEY, v ? "1" : "0"); } catch { /* ignore */ } };

  const start = () => {
    sink.current = [];
    behavSink.current = [];
    data.current = null;
    setReport(null);
    setStartedAt(Date.now());
    setRunning(true);
  };
  const finish = () => {
    const samples = sink.current ?? [], behav = behavSink.current ?? [];
    sink.current = null;
    behavSink.current = null;
    setRunning(false);
    data.current = { samples, behav };
    setReport(analyzeSelfTest(samples, {
      expectHz, device, kind, startedAt, staticClaimed: still, behavTs: behav, timeOrigin: performance.timeOrigin,
    }));
  };
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() - startedAt >= minutes * 60_000) finish();
    }, 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, startedAt, minutes]);
  // 离开页面时别把采集挂着
  useEffect(() => () => { sink.current = null; behavSink.current = null; }, [sink, behavSink]);

  const charts = useMemo(() => (report ? reportCharts(report) : null), [report]);
  const elapsed = running ? (now - startedAt) / 1000 : 0;
  const stamp = new Date(startedAt || Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, "");
  const base = `${(device || kind).replace(/[^\w-]/g, "_")}_selftest_${stamp}`;
  const fails = report?.items.filter((i) => i.status === "fail").length ?? 0;
  const warns = report?.items.filter((i) => i.status === "warn").length ?? 0;

  return (
    <Card size="small" style={{ marginTop: 12 }} styles={{ body: open ? undefined : { display: "none" } }}
      title={<span style={{ cursor: "pointer" }} onClick={() => setOpen(!open)}>
        <RightOutlined style={{ fontSize: 11, marginRight: 6, transition: "transform .2s", transform: open ? "rotate(90deg)" : undefined }} />
        一键自检 <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
          {running ? `测试中 ${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")} / ${minutes}:00`
            : report ? `上次：${fails ? `${fails} 项不通过` : "没有不通过"}${warns ? `，${warns} 项注意` : ""}` : "采样率 · 帧间隔 · 丢帧 · 板子时钟 · 三轴底噪"}
        </Typography.Text></span>}
      extra={
        <Space size={8} wrap>
          <Select size="small" value={minutes} onChange={setMinutes} disabled={running} style={{ width: 110 }}
            options={[1, 3, 5, 10, 30].map((m) => ({ value: m, label: `测 ${m} 分钟` }))} />
          <Tooltip title="测底噪 / 三轴稳定性要把设备静置平放在桌上；戴在狗身上测的话这几项不下结论">
            <Checkbox checked={still} onChange={(e) => setStill(e.target.checked)} disabled={running}>设备静置</Checkbox>
          </Tooltip>
          {running
            ? <Button size="small" danger onClick={finish}>提前结束并出报告</Button>
            : <Button size="small" type="primary" disabled={!connected || !hasRaw} onClick={() => { setOpen(true); start(); }}>开始自检</Button>}
        </Space>
      }>
      {!hasRaw && connected && kind === "pc" && (
        <Alert type="info" showIcon style={{ marginBottom: 8 }} message="要原始采样（0x08）：用 PB_RAW_STREAM=1 编的调试固件才能自检" />
      )}
      {running && (
        <div style={{ marginBottom: 8 }}>
          <Progress percent={Math.min(100, Math.round((elapsed / (minutes * 60)) * 100))} size="small"
            format={() => `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")} / ${minutes}:00`} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已收 {sink.current?.length ?? 0} 个样本{still ? " · 测试期间别碰设备" : ""} · 掉线会自动重连接着测（中间的缝会算进丢帧）
          </Typography.Text>
        </div>
      )}
      {!running && !report && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {kind === "wit"
            ? <>WitMotion 不带时间戳，时间用接收端的：测采样率、稳定性、三轴 + 角速度的底噪和零偏（帧间隔 / 丢帧 / 设备时钟测不了）。3~5 分钟够了。</>
            : <>采样率、帧间隔、丢帧、底噪 3~5 分钟够了；<b>板子时钟漂移</b>要测准建议 10 分钟以上（误差跟时长成反比）。
              全部按板子时间戳算，蓝牙晚到 / 成批到不影响；丢帧分不清是蓝牙丢的还是板子没发，报告里有给固件的建议。</>}
        </Typography.Text>
      )}
      {report && charts && (
        <>
          <Space size={12} wrap style={{ marginBottom: 8 }}>
            {fails ? <Tag color="error">{fails} 项不通过</Tag> : <Tag color="success">没有不通过的项</Tag>}
            {warns > 0 && <Tag color="warning">{warns} 项需要注意</Tag>}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {report.meta.n} 个样本 · {(report.meta.durationS / 60).toFixed(1)} 分钟{report.meta.droppedHead ? ` · 中途板子时间跳过（校时），只用了之后的 ${report.meta.n} 个` : ""}
            </Typography.Text>
            <Tooltip title="报告（HTML）+ 原始数据（CSV）+ 结果（JSON）+ 自检脚本 + 说明，一个压缩包发给嵌入式：他能用脚本复现、自己再测、把多次结果并排比">
              <Button size="small" type="primary" onClick={() => save(`${base}.zip`, makeZip([
                { name: `${base}/report.html`, data: reportHtml(report) },
                { name: `${base}/raw.csv`, data: samplesCsv(data.current?.samples ?? [], performance.timeOrigin) },
                { name: `${base}/result.json`, data: JSON.stringify(report, null, 1) },
                ...(kind === "wit" ? [] : [{ name: `${base}/behavior.csv`, data: ["dev_ts_ms", ...(data.current?.behav ?? []).map(String)].join("\n") }]),
                { name: `${base}/petcollar_selftest.py`, data: selfTestPy },
                { name: `${base}/README.txt`, data: readme(report, base) },
              ]))}>下载压缩包（报告 + 原始数据 + 自检脚本）</Button>
            </Tooltip>
          </Space>
          <Table size="small" pagination={false} rowKey={(r) => `${r.group}-${r.name}`} dataSource={report.items}
            columns={[
              { title: "分组", dataIndex: "group", width: 80,
                onCell: (r, i) => {
                  const idx = i ?? 0;
                  if (idx > 0 && report.items[idx - 1].group === r.group) return { rowSpan: 0 };
                  let span = 1;
                  while (report.items[idx + span]?.group === r.group) span++;
                  return { rowSpan: span };
                } },
              { title: "项目", dataIndex: "name", width: 260 },
              { title: "结果", render: (_: unknown, r) => <>{r.value}{r.note && <div style={{ fontSize: 12, color: token.colorTextTertiary }}>{r.note}</div>}</> },
              { title: "判定", width: 80, render: (_: unknown, r) => <Tag color={STATUS[r.status].color}>{STATUS[r.status].text}</Tag> },
            ]} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 12, marginTop: 12 }}>
            {[["采样率（每 10 秒：传感器节奏 / 实际到手）", charts.rate], ["帧间隔分布（红 = 缝 / 异常，纵轴开方）", charts.hist],
              ["板子时钟（板上 − 电脑，从 0 起）", charts.clock], ["三轴每 10 秒均值变化（mg）", charts.axes]].map(([t, svg]) => svg ? (
              <div key={t} style={{ background: "var(--sl-fill)", borderRadius: 6, padding: 8 }}>
                <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>{t}</div>
                {/* SVG 是自己拼的、只有数字，没有外部内容 */}
                <div dangerouslySetInnerHTML={{ __html: svg }} />
              </div>
            ) : null)}
          </div>
        </>
      )}
    </Card>
  );
}
