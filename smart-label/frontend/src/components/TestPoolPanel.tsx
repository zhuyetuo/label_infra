import { useState } from "react";
import {
  Alert, Button, Input, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Tooltip, Typography, message,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addTestPoolToSet, checkTestPoolWindow, getTestPool, moveTestPoolToTrain, type TestPoolWindowItem,
} from "@/api/dataPool";
import { listTestSets } from "@/api/modelTests";
import { listLabels } from "@/api/labels";
import { getTask } from "@/api/tasks";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import { useAuthStore } from "@/stores/authStore";
import type { LabelDefinition, Task } from "@/types";

const fmtMs = (ms: number | null) => {
  if (ms == null) return "整段";
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

export default function TestPoolPanel() {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.userInfo?.role);
  const curator = role === "admin" || role === "super_admin" || role === "reviewer";

  const [status, setStatus] = useState<"active" | "moved_to_train" | "all">("active");
  const [checked, setChecked] = useState<"all" | "checked" | "unchecked">("all");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<number[]>([]);
  const [moving, setMoving] = useState(false);

  // 加入测试集弹窗
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [targetSetId, setTargetSetId] = useState<number | null>(null);
  const [addingToSet, setAddingToSet] = useState(false);

  // 打开工作台核对窗口
  const [wsTask, setWsTask] = useState<Task | null>(null);
  const [wsLabels, setWsLabels] = useState<LabelDefinition[]>([]);
  const [wsWin, setWsWin] = useState<TestPoolWindowItem | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["test-pool", status, checked, keyword, page],
    queryFn: () => getTestPool({ status, checked, keyword: keyword.trim() || undefined, page, page_size: 50 }),
  });
  const { data: testSets } = useQuery({
    queryKey: ["model-test-sets-for-pool"],
    queryFn: listTestSets,
    enabled: addModalOpen,
  });

  const summary = data?.summary;
  const rows = data?.items ?? [];

  const invalidateAll = () => {
    void refetch();
    qc.invalidateQueries({ queryKey: ["data-pool"] });
    qc.invalidateQueries({ queryKey: ["model-test"] });
  };

  const openVerify = async (row: TestPoolWindowItem) => {
    try {
      const t = await getTask(row.task_id);
      const lbs = await listLabels(t.project_id);
      setWsLabels(lbs);
      setWsTask(t);
      setWsWin(row);
    } catch {
      /* interceptor handles error */
    }
  };

  const doMoveToTrain = async (ids: number[]) => {
    if (!ids.length) return;
    setMoving(true);
    try {
      const r = await moveTestPoolToTrain(ids);
      message.success(
        `已将 ${r.moved_windows} 个测试窗口拨到训练数据池（${r.pooled_segments} 条片段入训练池${r.removed_from_sets ? `，并从未冻结测试集移出 ${r.removed_from_sets} 条` : ""}）`,
        5,
      );
      setPicked((prev) => prev.filter((id) => !ids.includes(id)));
      invalidateAll();
    } finally {
      setMoving(false);
    }
  };

  const doAddToSet = async () => {
    if (!targetSetId || !picked.length) return;
    setAddingToSet(true);
    try {
      const r = await addTestPoolToSet(picked, targetSetId);
      message.success(`已加入 ${r.added} 个测试窗口（自动继承已核对状态${r.skipped ? `，跳过已在集合内的 ${r.skipped} 个` : ""}）`, 4);
      setAddModalOpen(false);
      setPicked([]);
      invalidateAll();
    } finally {
      setAddingToSet(false);
    }
  };

  const unfrozenSets = (testSets?.sets ?? []).filter((s) => !s.frozen_at);

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="测试数据池与训练数据池严格隔离：测试池内的数据不会进入模型训练；在任意测试集核对完的窗口会自动沉淀到这里（新测试集复用免重审），需要优化模型时可一键将多余或难例窗口拨到训练数据池。"
      />

      {/* 顶部汇总 */}
      <Space wrap size={16} style={{ marginBottom: 12 }}>
        <Tag color="geekblue" style={{ fontSize: 13, padding: "4px 10px" }}>
          测试池在池：<b>{summary?.active ?? 0}</b> 段（已核对 {summary?.checked ?? 0} / 未核对 {summary?.unchecked ?? 0}）
        </Tag>
        <Tag color="green" style={{ fontSize: 13, padding: "4px 10px" }}>
          已拨入训练池：<b>{summary?.moved_to_train ?? 0}</b> 段
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          当前筛选覆盖 {summary?.n_dogs ?? 0} 只狗 · 共 {((summary?.total_sec ?? 0) / 60).toFixed(1)} 分钟
        </Typography.Text>
      </Space>

      {/* 筛选 + 批量操作 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <Segmented
          size="small"
          value={status}
          onChange={(v) => { setStatus(v as typeof status); setPage(1); setPicked([]); }}
          options={[
            { value: "active", label: `在测试池 (${summary?.active ?? 0})` },
            { value: "moved_to_train", label: `已拨入训练池 (${summary?.moved_to_train ?? 0})` },
            { value: "all", label: "全部" },
          ]}
        />
        <Segmented
          size="small"
          value={checked}
          onChange={(v) => { setChecked(v as typeof checked); setPage(1); }}
          options={[
            { value: "all", label: "全部核对状态" },
            { value: "checked", label: "已核对" },
            { value: "unchecked", label: "未核对" },
          ]}
        />
        <Input.Search
          size="small"
          allowClear
          placeholder="搜狗名 / 样本 / 类别 / 备注"
          style={{ width: 220 }}
          value={keyword}
          onChange={(e) => { setKeyword(e.target.value); setPage(1); }}
        />
        <span style={{ flex: 1 }} />
        {curator && picked.length > 0 && status !== "moved_to_train" && (
          <>
            <Button size="small" onClick={() => setAddModalOpen(true)}>
              ➕ 加入测试集（{picked.length}）
            </Button>
            <Popconfirm
              title={`将勾选的 ${picked.length} 个测试窗口拨到训练数据池？`}
              description="拨出后将解除测试隔离、从未冻结测试集移出，且窗内全部已核对标注直接进入训练数据池。"
              okText="确认拨入训练池"
              onConfirm={() => doMoveToTrain(picked)}
            >
              <Button size="small" type="primary" loading={moving}>
                ➡️ 拨到训练数据池（{picked.length}）
              </Button>
            </Popconfirm>
          </>
        )}
      </div>

      <Table<TestPoolWindowItem>
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={rows}
        rowSelection={curator && status !== "moved_to_train" ? {
          selectedRowKeys: picked,
          onChange: (keys) => setPicked(keys as number[]),
          getCheckboxProps: (r) => ({ disabled: r.status === "moved_to_train" }),
        } : undefined}
        pagination={{
          current: page,
          pageSize: 50,
          total: data?.total ?? 0,
          showTotal: (t) => `共 ${t} 段`,
          onChange: (p) => setPage(p),
        }}
        columns={[
          {
            title: "样本 / 项目",
            width: 220,
            render: (_, r) => (
              <div>
                <div style={{ fontWeight: 500, fontSize: 12 }}>{r.sample_code}</div>
                <div style={{ color: "#888", fontSize: 11 }}>{r.project_name || "-"}</div>
              </div>
            ),
          },
          {
            title: "狗 / 场地",
            width: 140,
            render: (_, r) => {
              const sz = r.size || r.size_group;
              return (
                <div>
                  <div>{r.dog_name || "-"} {sz ? <Tag style={{ fontSize: 11 }}>{sz}</Tag> : null}</div>
                  <div style={{ color: "#888", fontSize: 11 }}>{r.site || "-"}</div>
                </div>
              );
            },
          },
          {
            title: "测试窗口",
            width: 165,
            render: (_, r) => (
              <div>
                <div style={{ fontFamily: "monospace", fontSize: 12 }}>
                  {r.start_ms != null ? `${fmtMs(r.start_ms)} ~ ${fmtMs(r.end_ms)}` : "整个任务"}
                </div>
                <div style={{ color: "#888", fontSize: 11 }}>
                  {r.dur_sec != null ? `${(r.dur_sec / 60).toFixed(1)} 分钟（${Math.round(r.dur_sec)}s）` : "-"}
                </div>
              </div>
            ),
          },
          {
            title: "窗内标注",
            width: 220,
            render: (_, r) => {
              const entries: { name: string; n?: number; sec?: number }[] = Array.isArray(r.labels)
                ? r.labels.map((name) => ({ name }))
                : Object.entries(r.labels ?? {}).map(([name, v]) => ({ name, n: v?.n, sec: v?.sec }));
              return (
                <Space size={[4, 4]} wrap>
                  {entries.slice(0, 5).map(({ name, n, sec }) => (
                    <Tooltip key={name} title={n != null ? `${name}：${n} 段 / ${sec ?? 0}s` : name}>
                      <Tag style={{ marginInlineEnd: 0, fontSize: 11 }}>
                        {name}{n != null ? ` ${n}` : ""}
                      </Tag>
                    </Tooltip>
                  ))}
                  {entries.length > 5 && <Tag style={{ fontSize: 11 }}>+{entries.length - 5}</Tag>}
                  {(r.n_ai_pending ?? 0) > 0 && <Tag color="orange" style={{ fontSize: 11 }}>AI待确 {r.n_ai_pending}</Tag>}
                </Space>
              );
            },
          },
          {
            title: "所属测试集",
            width: 160,
            render: (_, r) => (
              <Space size={[4, 4]} wrap>
                {(r.sets ?? []).length ? (r.sets ?? []).map((s) => (
                  <Tag key={s.id} color={s.frozen ? "purple" : "blue"} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                    {s.name}{s.frozen ? " 🔒" : ""}
                  </Tag>
                )) : <Typography.Text type="secondary" style={{ fontSize: 11 }}>未挂测试集</Typography.Text>}
              </Space>
            ),
          },
          {
            title: "池状态 / 核对",
            width: 150,
            render: (_, r) => (
              <Space direction="vertical" size={2}>
                {r.status === "moved_to_train" ? (
                  <Tooltip title={`${r.moved_by_name ?? ""} 于 ${r.moved_at ?? ""} 拨入训练池`}>
                    <Tag color="green" style={{ marginInlineEnd: 0 }}>已拨入训练池</Tag>
                  </Tooltip>
                ) : r.checked_at ? (
                  <Tooltip title={`${r.checked_by_name ?? ""} 核对通过，新测试集复用免重审`}>
                    <Tag color="cyan" style={{ marginInlineEnd: 0 }}>✓ 已核对</Tag>
                  </Tooltip>
                ) : (
                  <Tag color="default" style={{ marginInlineEnd: 0 }}>未核对</Tag>
                )}
              </Space>
            ),
          },
          {
            title: "操作",
            width: 210,
            render: (_, r) => (
              <Space size={4}>
                <Button size="small" type="link" style={{ paddingInline: 4 }} onClick={() => void openVerify(r)}>
                  打开核对
                </Button>
                {curator && r.status === "active" && (
                  <>
                    <Button
                      size="small"
                      type="link"
                      style={{ paddingInline: 4 }}
                      onClick={async () => {
                        await checkTestPoolWindow(r.id, !r.checked_at);
                        message.success(r.checked_at ? "已取消核对标记" : "已标记核对（同步测试池）");
                        invalidateAll();
                      }}
                    >
                      {r.checked_at ? "取消核对" : "标已核对"}
                    </Button>
                    <Popconfirm
                      title="将该窗口拨到训练数据池？"
                      description="窗内已核对片段直接入训练池，解除测试隔离。"
                      okText="拨入训练池"
                      onConfirm={() => doMoveToTrain([r.id])}
                    >
                      <Button size="small" type="link" style={{ paddingInline: 4, color: "#52c41a" }}>
                        拨到训练池
                      </Button>
                    </Popconfirm>
                  </>
                )}
              </Space>
            ),
          },
        ]}
      />

      {/* 加入测试集弹窗 */}
      <Modal
        title={`将选中的 ${picked.length} 个测试窗口加入测试集`}
        open={addModalOpen}
        onCancel={() => setAddModalOpen(false)}
        onOk={() => void doAddToSet()}
        confirmLoading={addingToSet}
        okButtonProps={{ disabled: !targetSetId }}
        okText="加入（继承已核对）"
      >
        <div style={{ marginBottom: 8, fontSize: 12, color: "#888" }}>
          仅可加入未冻结的测试集；测试数据池里已核对的窗口加入后自动保持「已核对」，无需重复审核。
        </div>
        <Select
          style={{ width: "100%" }}
          placeholder="选择目标测试集"
          value={targetSetId}
          onChange={setTargetSetId}
          options={unfrozenSets.map((s) => ({ value: s.id, label: `${s.name}（当前 ${s.n_items} 段）` }))}
        />
      </Modal>

      {/* 直接打开工作台核对测试池窗口 */}
      <AnnotationWorkspace
        task={wsTask}
        labels={wsLabels}
        readOnly={false}
        hideSubmit
        focusWindow={wsWin && wsWin.start_ms != null && wsWin.end_ms != null
          ? { startMs: wsWin.start_ms, endMs: wsWin.end_ms }
          : null}
        onClose={() => { setWsTask(null); setWsWin(null); }}
        onSaved={async () => {
          if (wsWin && wsWin.status === "active" && !wsWin.checked_at) {
            await checkTestPoolWindow(wsWin.id, true);
          }
          invalidateAll();
        }}
      />
    </div>
  );
}
