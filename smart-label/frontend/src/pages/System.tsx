import { useEffect, useRef, useState } from "react";
import {
  Alert, Button, Card, Col, Input, InputNumber, Progress, Radio, Row, Select, Space, Statistic, Switch, Table, Tag,
  Tooltip, Typography, theme,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { sysLogs, sysStatus } from "@/api/system";

const gb = (b?: number | null) => (b == null ? "-" : `${(b / 1024 ** 3).toFixed(1)} GB`);
const pctColor = (p: number) => (p >= 90 ? "#ff4d4f" : p >= 75 ? "#faad14" : "#52c41a");

/**
 * 系统监控：服务器 CPU / 内存 / 磁盘、数据库（连接数、正在跑的慢查询）、依赖服务通不通，
 * 加上 api / access / scheduler 三份日志。页面一片 timeout 时先来这看：慢查询、SLOW 请求、ERROR。
 */
export default function System() {
  const { token } = theme.useToken();
  const [auto, setAuto] = useState(true);
  const { data: st, isFetching, refetch } = useQuery({
    queryKey: ["sys-status"],
    queryFn: sysStatus,
    refetchInterval: auto ? 5000 : false,
  });

  const [file, setFile] = useState("api.log");
  const [lines, setLines] = useState(500);
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [level, setLevel] = useState("");
  const [date, setDate] = useState("");
  // 日志默认收起、默认不实时：一直往下刷看着烦，要看的时候展开；要盯着看再打开「实时」
  const [logOpen, setLogOpenState] = useState(() => { try { return localStorage.getItem("smart-label:sys-log-open") === "1"; } catch { return false; } });
  const setLogOpen = (v: boolean) => { setLogOpenState(v); try { localStorage.setItem("smart-label:sys-log-open", v ? "1" : "0"); } catch { /* ignore */ } };
  const [logLive, setLogLive] = useState(false);
  const { data: lg, isFetching: loadingLog, refetch: refetchLog } = useQuery({
    queryKey: ["sys-logs", file, lines, q, level, date],
    queryFn: () => sysLogs({ file, lines, q, level, date }),
    enabled: logOpen,
    refetchInterval: logOpen && logLive && !date ? 3000 : false,
  });
  // 新日志到了自动滚到底（人往上翻着看的时候不打扰）
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lg]);

  const memUsed = st?.mem.total && st.mem.available != null ? 1 - st.mem.available / st.mem.total : null;
  const lineColor = (l: string) =>
    / (ERROR|CRITICAL) /.test(l) || l.startsWith("Traceback") || /^\s+File "/.test(l)
      ? token.colorError
      : / WARNING /.test(l)
        ? token.colorWarning
        : / [45]\d\d$/.test(l) || /" [45]\d\d\b/.test(l)
          ? token.colorWarningText
          : undefined;

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>系统监控</Typography.Title>
        <Tooltip title="每 5 秒自动刷新资源（CPU / 内存 / GPU / 数据库）。日志单独开关">
          <Switch checked={auto} onChange={setAuto} checkedChildren="自动刷新" unCheckedChildren="已暂停" />
        </Tooltip>
        <Button icon={<ReloadOutlined />} loading={isFetching || loadingLog} onClick={() => { refetch(); if (logOpen) refetchLog(); }}>刷新</Button>
      </Space>

      <Row gutter={12}>
        <Col xs={24} md={6}>
          <Card size="small" title="CPU">
            <Progress type="dashboard" size={90} percent={st?.cpu.percent ?? 0} strokeColor={pctColor(st?.cpu.percent ?? 0)} />
            <div style={{ fontSize: 12 }}>
              {st?.cpu.count} 核 · 负载 {st?.cpu.load?.map((x) => x.toFixed(2)).join(" / ") ?? "-"}
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>（1 / 5 / 15 分钟）</Typography.Text>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card size="small" title="内存">
            <Progress type="dashboard" size={90} percent={memUsed == null ? 0 : Math.round(memUsed * 100)}
              strokeColor={pctColor((memUsed ?? 0) * 100)} />
            <div style={{ fontSize: 12 }}>
              可用 {gb(st?.mem.available)} / 共 {gb(st?.mem.total)}
              {st?.mem.swap_total ? ` · swap 用了 ${gb((st.mem.swap_total ?? 0) - (st.mem.swap_free ?? 0))}` : ""}
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>后端进程占 {gb(st?.api_rss)}</Typography.Text>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title="磁盘">
            {(st?.disks ?? []).map((d) => {
              const p = Math.round((d.used / d.total) * 100);
              return (
                <div key={d.path} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 12 }}>
                    <Typography.Text code>{d.path}</Typography.Text> 剩 {gb(d.free)} / 共 {gb(d.total)}
                  </div>
                  <Progress percent={p} strokeColor={pctColor(p)} size="small" />
                </div>
              );
            })}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              服务器已运行 {st?.uptime_sec ? `${(st.uptime_sec / 86400).toFixed(1)} 天` : "-"}
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Card size="small" title="GPU（视觉服务那台机器）" style={{ marginTop: 12 }}>
        {st?.gpu?.error ? (
          <Typography.Text type="secondary">读不到：{st.gpu.error}</Typography.Text>
        ) : !st?.gpu?.gpus?.length ? (
          <Typography.Text type="secondary">{st?.gpu?.why || "没读到 GPU（视觉服务所在容器里没有 nvidia-smi，或者视觉服务还是旧版本）"}</Typography.Text>
        ) : (
          <Row gutter={12}>
            {st.gpu.gpus.map((g) => {
              const memP = g.mem_total_mib ? Math.round(((g.mem_used_mib ?? 0) / g.mem_total_mib) * 100) : 0;
              return (
                <Col key={g.index} xs={24} md={12} xl={8}>
                  <Space align="start" size={16}>
                    <div style={{ textAlign: "center" }}>
                      <Progress type="dashboard" size={90} percent={Math.round(g.util_pct ?? 0)} strokeColor={pctColor(g.util_pct ?? 0)} />
                      <div style={{ fontSize: 11, color: token.colorTextSecondary }}>利用率</div>
                    </div>
                    <div style={{ fontSize: 12, minWidth: 220 }}>
                      <b>GPU {g.index}</b> · {g.name}
                      <div style={{ marginTop: 4 }}>显存 {((g.mem_used_mib ?? 0) / 1024).toFixed(1)} / {((g.mem_total_mib ?? 0) / 1024).toFixed(1)} GB</div>
                      <Progress percent={memP} strokeColor={pctColor(memP)} size="small" />
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {g.temp_c != null ? `${g.temp_c}°C` : ""}{g.power_w != null ? ` · ${g.power_w.toFixed(0)} W` : ""}
                      </Typography.Text>
                    </div>
                  </Space>
                </Col>
              );
            })}
          </Row>
        )}
        {!!st?.gpu?.models && Object.keys(st.gpu.models).length > 0 && (
          <div style={{ fontSize: 11, marginTop: 6, color: token.colorTextSecondary }}>
            视觉服务里常驻的模型：
            {Object.entries(st.gpu.models).map(([k, v]) => `${k} ${v.mib != null ? `${(v.mib / 1024).toFixed(1)} GB` : "?"}`).join(" · ")}
            {st.gpu.cached_idle_mib ? ` · torch 缓存着没在用的 ${(st.gpu.cached_idle_mib / 1024).toFixed(1)} GB` : ""}
            <Tooltip title="显存是整张卡所有进程加起来（训练 / 推理 / vLLM 也在里面），模型那行只算视觉服务自己的">
              <Typography.Text type="secondary" style={{ marginLeft: 6, cursor: "help" }}>（?）</Typography.Text>
            </Tooltip>
          </div>
        )}
      </Card>

      <Row gutter={12} style={{ marginTop: 12 }}>
        <Col xs={24} md={12}>
          <Card size="small" title="数据库">
            {st?.db.ok ? (
              <Space size={24}>
                <Statistic title="响应" value={st.db.ms ?? 0} suffix="ms" />
                <Statistic title="连接数" value={st.db.connections ?? "-"} />
                <Statistic title="跑了 ≥3 秒的查询" value={st.db.slow_queries?.length ?? 0}
                  valueStyle={{ color: st.db.slow_queries?.length ? token.colorError : undefined }} />
              </Space>
            ) : (
              <Alert type="error" showIcon message="数据库连不上" description={st?.db.error} />
            )}
            {!!st?.db.slow_queries?.length && (
              <Table size="small" rowKey="id" pagination={false} style={{ marginTop: 8 }} dataSource={st.db.slow_queries}
                columns={[
                  { title: "秒", dataIndex: "sec", width: 60 },
                  { title: "状态", dataIndex: "state", width: 120 },
                  { title: "SQL", dataIndex: "sql", render: (v: string) => <Typography.Text style={{ fontSize: 11 }} ellipsis={{ tooltip: v }}>{v}</Typography.Text> },
                ]} />
            )}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title="依赖服务">
            {(st?.services ?? []).map((s) => (
              <div key={s.name} style={{ marginBottom: 6, fontSize: 12 }}>
                {s.ok == null ? <Tag>没配置</Tag> : s.ok ? <Tag color="success">通</Tag> : <Tag color="error">连不上</Tag>}
                <b>{s.name}</b> <Typography.Text type="secondary">{s.url}</Typography.Text>
                {s.ms != null && <Typography.Text type="secondary"> · {s.ms}ms</Typography.Text>}
                {s.error && s.ok === false && <div style={{ color: token.colorError, fontSize: 11 }}>{s.error}</div>}
              </div>
            ))}
          </Card>
        </Col>
      </Row>

      <Card size="small" style={{ marginTop: 12 }}
        title={
          <Space>
            <Button type="text" size="small" onClick={() => setLogOpen(!logOpen)} style={{ fontWeight: 600, paddingLeft: 0 }}>
              {logOpen ? "▾" : "▸"} 日志
            </Button>
            {logOpen && (
              <Tooltip title="打开后每 3 秒自动拉新的（看往天的日志时不刷）；关着就是手动点「刷新」">
                <Switch size="small" checked={logLive} onChange={setLogLive} checkedChildren="实时" unCheckedChildren="不实时" />
              </Tooltip>
            )}
          </Space>
        }
        styles={{ body: logOpen ? undefined : { display: "none" } }}
        extra={logOpen && (
          <Space wrap size={6}>
            <Radio.Group size="small" value={file} onChange={(e) => { setFile(e.target.value); setDate(""); }} optionType="button"
              options={[
                { value: "api.log", label: "后端" },
                { value: "access.log", label: "访问" },
                { value: "scheduler.log", label: "定时任务" },
              ]} />
            <Select size="small" style={{ width: 130 }} value={date} onChange={setDate}
              options={[{ value: "", label: "今天" }, ...(lg?.dates ?? []).map((d) => ({ value: d, label: d }))]} />
            <Radio.Group size="small" value={level} onChange={(e) => setLevel(e.target.value)} optionType="button"
              options={[{ value: "", label: "全部" }, { value: "WARNING", label: "警告+" }, { value: "ERROR", label: "错误" }]} />
            <Tooltip title="慢请求（≥3 秒）都记成 SLOW">
              <Button size="small" onClick={() => { setFile("api.log"); setQInput("SLOW"); setQ("SLOW"); }}>慢请求</Button>
            </Tooltip>
            <Input.Search size="small" allowClear placeholder="关键字" style={{ width: 160 }} value={qInput}
              onChange={(e) => { setQInput(e.target.value); if (!e.target.value) setQ(""); }} onSearch={setQ} />
            <InputNumber size="small" min={50} max={5000} step={100} value={lines} onChange={(v) => setLines(v ?? 500)} addonAfter="行" style={{ width: 110 }} />
            <Button size="small" icon={<ReloadOutlined />} loading={loadingLog} onClick={() => refetchLog()} />
          </Space>
        )}
      >
        {lg && !lg.exists && <Alert type="info" showIcon message={`没有 ${lg.file}`} style={{ marginBottom: 8 }} />}
        <div
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          style={{
            height: "55vh", overflow: "auto", background: token.colorFillQuaternary, borderRadius: 6, padding: 8,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, lineHeight: 1.5,
            whiteSpace: "pre-wrap", wordBreak: "break-all",
          }}
        >
          {(lg?.lines ?? []).map((l, i) => (
            <div key={i} style={{ color: lineColor(l) }}>{l}</div>
          ))}
          {lg && !lg.lines.length && lg.exists && <Typography.Text type="secondary">没有匹配的行</Typography.Text>}
        </div>
      </Card>
    </div>
  );
}
