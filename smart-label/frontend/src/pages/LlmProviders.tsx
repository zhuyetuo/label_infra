import { useState } from "react";
import { Tabs } from "antd";
import LocalModels from "@/components/LocalModels";
import { Alert, Button, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listLlmProviders,
  testLlmProvider,
  updateLlmProvider,
  type LlmModel,
  type LlmProvider,
} from "@/api/llmProviders";
import LlmCallStats from "@/components/LlmCallStats";

interface EditModel extends LlmModel {
  key: number;
}

// 「大模型 API」：六家各一行。key 在这里填，视觉服务那边不存 key，每次找片段时平台带过去。
// key 只写不读：填过之后这里只显示末四位，没有任何地方能把整串拿回来。
// 「模型服务」：算法机上的本地模型（加载 / 卸载 / 测试）、大模型 API（key / 模型 / 测试）、
// 调用统计各一个标签页，别混在一起。
export default function LlmProviders() {
  const [tab, setTab] = useState("local");
  return (
    <Tabs
      activeKey={tab}
      onChange={setTab}
      items={[
        { key: "local", label: "本地模型", children: <LocalModels /> },
        { key: "api", label: "大模型 API", children: <LlmApiPanel /> },
        { key: "stats", label: "调用统计", children: <LlmCallStats /> },
      ]}
    />
  );
}

function LlmApiPanel() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["llm-providers"], queryFn: listLlmProviders });
  const refresh = () => qc.invalidateQueries({ queryKey: ["llm-providers"] });

  const [editing, setEditing] = useState<LlmProvider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState<EditModel[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  const openEdit = (p: LlmProvider) => {
    setEditing(p);
    setApiKey("");
    setBaseUrl(p.base_url ?? "");
    setModels(p.models.map((m, i) => ({ ...m, key: i })));
    setDefaultModel(p.default_model);
  };

  const patchRow = (key: number, patch: Partial<EditModel>) =>
    setModels((prev) => prev.map((m) => (m.key === key ? { ...m, ...patch } : m)));

  const handleSave = async () => {
    if (!editing) return;
    const bad = models.find((m) => !m.name.trim());
    if (bad) {
      message.warning("每个模型都要有名字");
      return;
    }
    setSaving(true);
    try {
      const body: Parameters<typeof updateLlmProvider>[1] = {
        base_url: baseUrl.trim(),
        models: models.map(({ name, price_in, price_out }) => ({ name: name.trim(), price_in, price_out })),
        default_model: defaultModel ?? "",
      };
      // 没填就不动原来的 key；想清掉用行上的「清掉 key」
      if (apiKey.trim()) body.api_key = apiKey.trim();
      await updateLlmProvider(editing.provider, body);
      message.success("已保存");
      setEditing(null);
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (p: LlmProvider) => {
    setTesting(p.provider);
    try {
      const r = await testLlmProvider(p.provider);
      if (r.ok) message.success(`${p.display_name} 通了：${r.latency_ms} ms，回复「${r.reply ?? ""}」`, 6);
      else message.error(`${p.display_name} 不通：${r.error}`, 10);
    } finally {
      setTesting(null);
    }
  };

  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        「画面找片段」用的视觉大模型。key 在这里填，存在平台数据库里，视觉服务那边不存；
        填过之后只显示末四位，没有地方能再看到整串。「测试」是用存着的 key 发一句最短的话（不带图，几乎不花钱），
        看 key 和模型名对不对。价格是 $/百万 token，只用来估花费，账以各家后台为准。
        本地服务（vLLM / SGLang / Ollama 开 OpenAI 兼容口）不需要 key，只填地址。
        <br />
        <b>模型必须是能看图的（多模态 / 视觉版）</b>：找片段是把几帧画面发过去问，纯文本模型收不了图会直接报错。
        各家默认列的都是视觉模型（Claude / GPT-5 / Gemini 本身多模态；豆包选带 vision 的；智谱选 glm-4.5v / glm-4v；本地选 Qwen-VL 这类）。
      </Typography.Paragraph>
      <Table
        rowKey="provider"
        loading={isLoading}
        dataSource={data}
        pagination={false}
        size="small"
        columns={[
          { title: "提供方", dataIndex: "display_name", width: 220 },
          {
            title: "API key",
            width: 160,
            render: (_, p: LlmProvider) =>
              p.has_key ? (
                <Tag color="green">已配 {p.key_hint}</Tag>
              ) : p.key_optional ? (
                <Tag>不需要</Tag>
              ) : (
                <Tag color="red">未配</Tag>
              ),
          },
          { title: "地址", dataIndex: "base_url", render: (v: string | null) => v ?? <Typography.Text type="secondary">官方</Typography.Text> },
          {
            title: "模型",
            render: (_, p: LlmProvider) => (
              <Space size={4} wrap>
                {p.models.map((m) => (
                  <Tag key={m.name} color={m.name === p.default_model ? "blue" : undefined}>
                    {m.name}
                    {m.name === p.default_model ? "（默认）" : ""}
                  </Tag>
                ))}
              </Space>
            ),
          },
          {
            title: "启用",
            width: 70,
            render: (_, p: LlmProvider) => (
              <Switch
                size="small"
                checked={p.enabled}
                onChange={async (v) => {
                  await updateLlmProvider(p.provider, { enabled: v });
                  refresh();
                }}
              />
            ),
          },
          {
            title: "操作",
            width: 220,
            render: (_, p: LlmProvider) => (
              <Space size={0}>
                <Button size="small" type="link" onClick={() => openEdit(p)}>
                  编辑
                </Button>
                <Button
                  size="small"
                  type="link"
                  loading={testing === p.provider}
                  disabled={!p.has_key && !p.key_optional}
                  onClick={() => handleTest(p)}
                >
                  测试
                </Button>
                {p.has_key && (
                  <Button
                    size="small"
                    type="link"
                    danger
                    onClick={async () => {
                      await updateLlmProvider(p.provider, { api_key: "" });
                      message.success("已清掉 key");
                      refresh();
                    }}
                  >
                    清掉 key
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={`编辑 - ${editing?.display_name ?? ""}`}
        open={editing != null}
        onCancel={() => setEditing(null)}
        onOk={handleSave}
        okText="保存"
        confirmLoading={saving}
        width={720}
        destroyOnClose
      >
        {editing && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <div>
              <Typography.Text>API key{editing.key_optional ? "（本地服务可不填）" : ""}：</Typography.Text>
              <Input.Password
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={editing.has_key ? `已配 ${editing.key_hint}，留空不改；填了就换成新的` : "粘贴 key"}
                autoComplete="new-password"
              />
            </div>
            <div>
              <Typography.Text>地址（base_url）：</Typography.Text>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="留空用官方地址；走代理/本地服务就填" />
            </div>
            <div>
              <Space style={{ marginBottom: 4 }}>
                <Typography.Text>模型列表：</Typography.Text>
                <Button size="small" onClick={() => setModels((prev) => [{ key: Date.now(), name: "", price_in: 0, price_out: 0 }, ...prev])}>
                  加一个
                </Button>
              </Space>
              <Table
                size="small"
                rowKey="key"
                pagination={false}
                dataSource={models}
                columns={[
                  {
                    title: "模型名（各家后台的原名，必须能看图：多模态 / 视觉版）",
                    render: (_, m: EditModel) => <Input size="small" value={m.name} onChange={(e) => patchRow(m.key, { name: e.target.value })} />,
                  },
                  {
                    title: "输入 $/M",
                    width: 110,
                    render: (_, m: EditModel) => <InputNumber size="small" min={0} value={m.price_in} onChange={(v) => patchRow(m.key, { price_in: v ?? 0 })} />,
                  },
                  {
                    title: "输出 $/M",
                    width: 110,
                    render: (_, m: EditModel) => <InputNumber size="small" min={0} value={m.price_out} onChange={(v) => patchRow(m.key, { price_out: v ?? 0 })} />,
                  },
                  {
                    title: "",
                    width: 60,
                    render: (_, m: EditModel) => (
                      <Button size="small" type="link" danger onClick={() => setModels((prev) => prev.filter((x) => x.key !== m.key))}>
                        删
                      </Button>
                    ),
                  },
                ]}
              />
            </div>
            <div>
              <Typography.Text>默认模型：</Typography.Text>
              <Select
                size="small"
                style={{ minWidth: 260 }}
                value={defaultModel ?? undefined}
                onChange={(v) => setDefaultModel(v)}
                options={models.filter((m) => m.name.trim()).map((m) => ({ value: m.name.trim(), label: m.name.trim() }))}
              />
            </div>
            {editing.provider === "local" && (
              <Alert
                type="info"
                showIcon
                message="本地服务：在算法机（GPU）上 vllm serve <模型名> --port 8386 起一个 OpenAI 兼容口（8000 太常用，别用）。地址默认按视觉服务所在的算法机局域网地址算出来（http://192.168.x.x:8386/v1），换机器就在这里改；模型名跟 vllm 起的一致。"
              />
            )}
          </Space>
        )}
      </Modal>
    </div>
  );
}
