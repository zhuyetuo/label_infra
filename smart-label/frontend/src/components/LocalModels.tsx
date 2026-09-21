import { useState } from "react";
import { Alert, Button, Modal, Popconfirm, Progress, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { actLocalModel, getVllmLog, listLocalModels, type LocalModel } from "@/api/llmProviders";

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

// 「模型服务」里的本地模型：算法机上的狗检测 / SAM / 画面向量 / 姿态，一张表看状态，
// 能加载（含预热）、卸载（释放显存）、一键测试（跑一次最小推理看通不通、多快）。
export default function LocalModels() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["local-models"], queryFn: listLocalModels, refetchInterval: 10_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["local-models"] });
  // vLLM 的整份日志：引擎那边的报错在 API 进程堆栈之前，30 行尾巴看不到
  const [log, setLog] = useState<{ lines: string[]; errors: string[] } | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const openLog = async () => {
    setLogLoading(true);
    try {
      setLog(await getVllmLog(400));
    } finally {
      setLogLoading(false);
    }
  };

  const act = async (m: LocalModel, action: "load" | "unload" | "test") => {
    setBusy(`${m.key}:${action}`);
    try {
      const r = await actLocalModel(m.key, action);
      if (action === "test") {
        if (r.ok) message.success(`${m.name} 通了：${fmtMs(r.latency_ms ?? 0)}${r.detail ? `，${r.detail}` : ""}`, 8);
        else message.error(`${m.name} 测试失败：${r.error}`, 10);
      } else if (r.ok) {
        message.success(action === "load" ? (m.vllm ? `${m.name} 已拉起，模型加载要一两分钟，状态变「已加载」才能用` : `${m.name} 已加载`) : `${m.name} 已${m.vllm ? "停止" : "卸载"}，显存已释放`, 6);
      } else {
        message.error(`${m.name} ${action === "load" ? "加载" : "卸载"}失败：${r.error}`, 10);
      }
      refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        算法机（视觉服务）上的本地模型。「加载」把权重搬上显卡并预热，之后第一次调用不用等；「卸载」释放显存
        （要给 vLLM 腾地方时用，下次用到会自动再加载）；「测试」跑一次最小推理，看通不通、多快。
        状态每 10 秒自动刷新。
        {data?.gpu && (
          <>
            {" "}显卡：{data.gpu.gpu ?? "无"}{data.gpu.cuda_available === false && data.gpu.why ? `（CUDA 不可用：${data.gpu.why}）` : ""}
            {data.uptime_s != null ? ` · 视觉服务已运行 ${Math.round(data.uptime_s / 60)} 分钟` : ""}
          </>
        )}
      </Typography.Paragraph>
      {data && !data.available && (
        <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`连不上视觉服务：${data.error ?? ""}`}
               description="算法机上 cd ~/imu_train && ./up.sh deploy -g 起服务；平台的 VISION_SERVICE_URL 要指向那台机器" />
      )}
      <Table
        rowKey="key"
        size="small"
        loading={isLoading}
        dataSource={data?.models ?? []}
        pagination={false}
        columns={[
          {
            title: "模型",
            width: 260,
            render: (_, m: LocalModel) => (
              <div>
                <div>{m.name}</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{m.purpose}</Typography.Text>
              </div>
            ),
          },
          {
            title: "状态",
            width: 130,
            render: (_, m: LocalModel) =>
              m.available ? (
                <Tag color="green">{m.warm === false ? "已加载（未预热）" : "已加载"}</Tag>
              ) : m.loading ? (
                <Tag color="blue">{m.progress ? `下载中${m.progress.pct != null ? ` ${m.progress.pct}%` : ""}` : m.startup ? `加载中 ${m.startup.pct}%` : "加载中"}</Tag>
              ) : m.error ? (
                <Tooltip title={m.error}>
                  <Tag color="red">不可用</Tag>
                </Tooltip>
              ) : (
                <Tag>未加载</Tag>
              ),
          },
          { title: "设备", dataIndex: "device", width: 90, render: (v: string | null) => v ?? "—" },
          {
            title: "权重",
            render: (_, m: LocalModel) => (
              <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: "break-all" }}>{m.weights ?? "—"}</Typography.Text>
            ),
          },
          {
            title: <Tooltip title="视觉服务进程内存里的计数，服务重启归零。「帧」是处理过的图片数（批量检测一次几十张）">调用（自启动起）</Tooltip>,
            width: 230,
            render: (_, m: LocalModel) =>
              m.meter.calls ? (
                <span style={{ fontSize: 12 }}>
                  {m.meter.calls} 次 · {m.meter.frames} 帧 · 均 {fmtMs(m.meter.avg_ms)}/次 · {m.meter.avg_ms_per_frame} ms/帧
                  {m.meter.errors ? <span style={{ color: "#ff4d4f" }}> · 失败 {m.meter.errors}</span> : null}
                </span>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>还没调过</Typography.Text>
              ),
          },
          {
            title: <Tooltip title="页面上最近一次点「测试」的结果；视觉服务重启后清空">最近测试</Tooltip>,
            width: 170,
            render: (_, m: LocalModel) =>
              m.last_test ? (
                <Tooltip title={m.last_test.ok ? m.last_test.detail : m.last_test.error}>
                  <span style={{ fontSize: 12 }}>
                    {m.last_test.ok ? <Tag color="green">通过</Tag> : <Tag color="red">失败</Tag>}
                    {fmtMs(m.last_test.latency_ms)} · {new Date(m.last_test.at * 1000).toLocaleTimeString("zh-CN", { hour12: false })}
                  </span>
                </Tooltip>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>没测过</Typography.Text>
              ),
          },
          {
            title: "错误 / 说明",
            render: (_, m: LocalModel) => (
              <div>
                {m.progress && m.vllm?.downloading ? (
                  <div style={{ minWidth: 260 }}>
                    <Progress
                      percent={m.progress.pct ?? 0}
                      size="small"
                      status="active"
                      format={() => (m.progress?.pct != null ? `${m.progress.pct}%` : `${(m.progress?.done_mb ?? 0) / 1000 | 0} GB`)}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {(m.progress.done_mb / 1000).toFixed(2)}{m.progress.total_mb ? ` / ${(m.progress.total_mb / 1000).toFixed(2)}` : ""} GB
                      {" · "}{m.progress.speed_mbps ?? 0} MB/s
                      {m.progress.eta_s != null ? ` · 预计还要 ${Math.floor(m.progress.eta_s / 60)} 分 ${m.progress.eta_s % 60} 秒` : ""}
                    </Typography.Text>
                  </div>
                ) : m.startup && m.vllm?.running && !m.available ? (
                  <div style={{ minWidth: 260 }}>
                    <Progress percent={m.startup.pct} size="small" status="active" />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      加载中：{m.startup.stage} · 已用 {Math.floor(m.startup.elapsed_s / 60)} 分 {m.startup.elapsed_s % 60} 秒（7B 一般一两分钟）
                    </Typography.Text>
                  </div>
                ) : m.error && !m.available ? (
                  <Typography.Text type={m.loading ? "secondary" : "danger"} style={{ fontSize: 12 }}>{m.error}</Typography.Text>
                ) : null}
                {m.vllm && (
                  <div style={{ fontSize: 12, color: "#888" }}>
                    {m.vllm.backend === "docker" ? `docker ${m.vllm.image ?? ""} · ` : ""}
                    {m.vllm.running ? `${m.vllm.pid != null ? `进程 ${m.vllm.pid} · ` : ""}端口 ${m.vllm.port}${m.vllm.uptime_s != null ? ` · 已跑 ${Math.round(m.vllm.uptime_s / 60)} 分` : ""}` : `端口 ${m.vllm.port}`}
                    {(m.vllm.log_tail.length > 0 || m.vllm.exited) && (
                      <Button size="small" type="link" style={{ padding: "0 4px" }} loading={logLoading} onClick={openLog}>
                        日志
                      </Button>
                    )}
                    {m.vllm.exited && (m.vllm.log_errors?.length ?? 0) > 0 && (
                      <div style={{ color: "#ff4d4f", marginTop: 2 }}>
                        {m.vllm.log_errors!.slice(-3).map((l, i) => (
                          <div key={i} style={{ wordBreak: "break-all" }}>{l}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ),
          },
          {
            title: "操作",
            width: 220,
            render: (_, m: LocalModel) => (
              <Space size={0}>
                {m.vllm ? (
                  m.vllm.running ? (
                    <Popconfirm title="停掉 vLLM？" description="结束进程、释放显存；「大模型看视频找动作」选本地服务时会连不上" onConfirm={() => act(m, "unload")}>
                      <Button size="small" type="link" danger loading={busy === `${m.key}:unload`} disabled={!!busy}>
                        停止
                      </Button>
                    </Popconfirm>
                  ) : (
                    <Tooltip title="拉起 vllm 进程：权重不在本地会先下（几 GB），下好再点一次；模型加载要一两分钟，状态变「已加载」才能用">
                      <Button size="small" type="link" loading={busy === `${m.key}:load`} disabled={!!busy || m.vllm.downloading || !!m.vllm.pulling} onClick={() => act(m, "load")}>
                        {m.vllm.downloading ? "下载中…" : m.vllm.pulling ? "拉镜像中…" : "启动"}
                      </Button>
                    </Tooltip>
                  )
                ) : !m.available ? (
                  <Button size="small" type="link" loading={busy === `${m.key}:load`} disabled={!!busy} onClick={() => act(m, "load")}>
                    加载
                  </Button>
                ) : (
                  <Popconfirm title={`卸载 ${m.name}？`} description="释放显存；下次用到会自动再加载（要等几秒到十几秒）" onConfirm={() => act(m, "unload")}>
                    <Button size="small" type="link" danger loading={busy === `${m.key}:unload`} disabled={!!busy}>
                      卸载
                    </Button>
                  </Popconfirm>
                )}
                <Tooltip title="跑一次最小推理（随机图），看通不通、一次多少毫秒。没加载会先加载">
                  <Button size="small" type="link" loading={busy === `${m.key}:test`} disabled={!!busy || !data?.available} onClick={() => act(m, "test")}>
                    测试
                  </Button>
                </Tooltip>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title="vLLM 日志（这次启动起）"
        open={log != null}
        onCancel={() => setLog(null)}
        footer={null}
        width={960}
      >
        {log && (
          <div>
            {log.errors.length > 0 && (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 8 }}
                message="挑出来的报错行"
                description={<pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{log.errors.join("\n")}</pre>}
              />
            )}
            <pre style={{ maxHeight: 480, overflow: "auto", background: "#111", color: "#ddd", padding: 8, fontSize: 11, whiteSpace: "pre-wrap" }}>
              {log.lines.join("\n")}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}
