import { useMemo, useState } from "react";
import { Button, Checkbox, Empty, Input, Popconfirm, Radio, Select, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { claimAllTasks, claimTask, deleteTask, listTasks, releaseAllTasks, releaseTask, reopenTask } from "@/api/tasks";
import { listProjects } from "@/api/projects";
import { listSamples } from "@/api/samples";
import { listLabels } from "@/api/labels";
import { listUsers } from "@/api/users";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import ResizableTable from "@/components/ResizableTable";
import { useAuthStore } from "@/stores/authStore";
import { imuOf, sortImuKeys } from "@/utils/imuOf";
import { formatDuration, sampleDisplayName } from "@/utils/sampleName";
import { UserTag } from "@/utils/roleTag";
import { useUrlTask } from "@/utils/urlTask";
import { TASK_STATUS_META, TASK_TYPE_LABEL, TaskStatusTag } from "@/utils/taskStatus";
import type { LabelDefinition, Project, Task, TaskStatus } from "@/types";

// 任务按项目分组展示：项目多起来之后，用一个下拉一次只能看一个项目太难用，
// 这里跟项目页一样列出项目、展开看它下面的任务，再配一个按名字搜索的框。
export default function Tasks() {
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.userInfo?.id);
  const role = useAuthStore((s) => s.userInfo?.role);
  const isAdmin = role === "admin" || role === "super_admin";

  const { data: projects, isLoading: loadingProjects } = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
  });
  const { data: tasks, isLoading } = useQuery({ queryKey: ["tasks"], queryFn: () => listTasks() });
  const { data: samples } = useQuery({ queryKey: ["samples"], queryFn: listSamples, enabled: isAdmin });
  // /users 只对管理员开放，其他角色拿不到就退回显示ID
  const { data: users } = useQuery({ queryKey: ["users"], queryFn: listUsers, enabled: isAdmin });
  const { data: labels } = useQuery({ queryKey: ["labels"], queryFn: () => listLabels() });

  const [keyword, setKeyword] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const [workspaceTask, setWorkspaceTask] = useState<Task | null>(null);
  const [workspaceReadOnly, setWorkspaceReadOnly] = useState(false);
  // 打开工作台时把该任务所属项目的标签带进去
  const [workspaceLabels, setWorkspaceLabels] = useState<LabelDefinition[]>([]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["projects"] });
  };

  const handleClaim = async (id: number) => {
    await claimTask(id);
    message.success("认领成功");
    refresh();
  };

  const handleDelete = async (id: number) => {
    await deleteTask(id);
    message.success("任务已删除");
    refresh();
  };

  const handleReopen = async (id: number) => {
    await reopenTask(id);
    message.success("已退回重标，上一轮内容已带到新一轮");
    refresh();
  };

  const handleRelease = async (id: number) => {
    await releaseTask(id);
    message.success("已放弃，任务退回公共池，草稿已保留");
    refresh();
  };

  const openWorkspace = (task: Task, readOnly: boolean) => {
    setWorkspaceReadOnly(readOnly);
    setWorkspaceTask(task);
  };

  // 刷新页面还能回到打开着的任务（?task=ID）
  useUrlTask(tasks, workspaceTask?.id ?? null, (task) => {
    setWorkspaceLabels(labelsOf(task.project_id));
    openWorkspace(task, !(task.status === "IN_PROGRESS" && task.locked_by === userId));
  });

  // 列表接口自带 sample_code / assigned_to_name，标注员、审核员拿不到 /samples、/users 也能正常显示
  const sampleCode = (t: Task) => t.sample_code ?? samples?.find((s) => s.id === t.sample_id)?.sample_code ?? t.sample_id;
  const durationOf = (t: Task) => t.video_duration_sec ?? samples?.find((s) => s.id === t.sample_id)?.video_duration_sec ?? null;
  // 超级管理员看原始编号，其他人看"哪天 几点~几点"
  const sampleName = (t: Task) => sampleDisplayName(String(sampleCode(t)), durationOf(t), role);
  const userName = (t: Task) => {
    if (t.assigned_to == null) return null;
    if (t.assigned_to_name) return t.assigned_to_name;
    const u = users?.find((x) => x.id === t.assigned_to);
    return u ? u.display_name || u.username : `#${t.assigned_to}`;
  };

  const tasksOf = (projectId: number) => {
    const rows = tasks?.filter((t) => t.project_id === projectId) ?? [];
    return onlyMine ? rows.filter((t) => t.assigned_to === userId) : rows;
  };
  // 标注工作台的标签按钮要取任务所属项目的标签，不能把别的项目的混进来
  const labelsOf = (projectId: number): LabelDefinition[] =>
    labels?.filter((l) => l.project_id === projectId) ?? [];

  const visibleProjects = useMemo(() => {
    let list = projects ?? [];
    const kw = keyword.trim().toLowerCase();
    if (kw) list = list.filter((p) => p.name.toLowerCase().includes(kw));
    // 勾了"只看我的"就把没有我的任务的项目整个收起来
    if (onlyMine) list = list.filter((p) => tasksOf(p.id).length > 0);
    return list;
  }, [projects, keyword, onlyMine, tasks, userId]);

  const statusSummary = (projectId: number) => {
    const counts: Partial<Record<TaskStatus, number>> = {};
    for (const t of tasksOf(projectId)) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return counts;
  };

  // 每个项目各自一套筛选，跟项目页一样：imu 目录 / 状态 / 搜索 / 含类别 / 只看有 AI 待确认。
  // 标注员、审核员平时只在这个页面干活，批量预标注完想专门标某一类（比如抓挠）全靠这些
  type StatusFilter = TaskStatus | "ALL" | "IN_PROGRESS_STARTED" | "IN_PROGRESS_EMPTY";
  type TaskFilter = { status: StatusFilter; q: string; labels: number[]; aiPending: boolean; imu: string };
  const [taskFilters, setTaskFilters] = useState<Record<number, TaskFilter>>({});
  const filterOf = (projectId: number): TaskFilter =>
    taskFilters[projectId] ?? { status: "ALL" as const, q: "", labels: [], aiPending: false, imu: "ALL" };
  const setFilter = (projectId: number, patch: Partial<TaskFilter>) =>
    setTaskFilters((prev) => ({ ...prev, [projectId]: { ...filterOf(projectId), ...patch } }));

  const renderTaskTable = (p: Project) => {
    const all = tasksOf(p.id);
    const projLabels = labelsOf(p.id);
    const f = filterOf(p.id);
    const counts = statusSummary(p.id);
    const q = f.q.trim().toLowerCase();
    const matchStatus = (t: Task) => {
      if (f.status === "ALL") return true;
      if (f.status === "IN_PROGRESS_STARTED") return t.status === "IN_PROGRESS" && (t.draft_item_count ?? 0) > 0;
      if (f.status === "IN_PROGRESS_EMPTY") return t.status === "IN_PROGRESS" && !(t.draft_item_count ?? 0);
      return t.status === f.status;
    };
    const inProgress = all.filter((t) => t.status === "IN_PROGRESS");
    const startedCount = inProgress.filter((t) => (t.draft_item_count ?? 0) > 0).length;
    const matchLabels = (t: Task) => {
      const lc = t.label_counts ?? {};
      if (f.aiPending && !Object.values(lc).some((c) => c.ai_pending > 0)) return false;
      if (f.labels.length && !f.labels.some((id) => (lc[id]?.n ?? 0) > 0)) return false;
      return true;
    };
    // 按样本编号 _imu{N} 归成目录，一个 imu 对应一只狗
    const imuCounts = new Map<string, number>();
    for (const t of all) {
      const k = imuOf(String(sampleCode(t)));
      imuCounts.set(k, (imuCounts.get(k) ?? 0) + 1);
    }
    const matchImu = (t: Task) => f.imu === "ALL" || imuOf(String(sampleCode(t))) === f.imu;
    const rows = all.filter(
      (t) =>
        matchImu(t) &&
        matchStatus(t) &&
        matchLabels(t) &&
        (!q || String(sampleCode(t)).toLowerCase().includes(q) || sampleName(t).includes(q) || String(t.id) === q)
    );
    // 项目级各类别汇总：多少段、分布在多少个任务里、多少段还是 AI 待确认——点一下就按这个类别筛
    const labelTotals = projLabels
      .map((l) => {
        let n = 0, pending = 0, tasksN = 0;
        for (const t of all) {
          const c = t.label_counts?.[l.id];
          if (!c?.n) continue;
          n += c.n; pending += c.ai_pending; tasksN += 1;
        }
        return { label: l, n, pending, tasksN };
      })
      .filter((x) => x.n > 0);
    const totalPending = labelTotals.reduce((s, x) => s + x.pending, 0);
    const filtered = f.status !== "ALL" || q || f.labels.length > 0 || f.aiPending || f.imu !== "ALL";
    return (
      <>
      {imuCounts.size > 1 && (
        <Space wrap style={{ marginBottom: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>按设备/狗：</Typography.Text>
          <Radio.Group
            size="small"
            optionType="button"
            buttonStyle="solid"
            value={f.imu}
            onChange={(e) => setFilter(p.id, { imu: e.target.value })}
            options={[
              { label: `全部 ${all.length}`, value: "ALL" },
              ...sortImuKeys(imuCounts.keys()).map((k) => ({ label: `${k} ${imuCounts.get(k)}`, value: k })),
            ]}
          />
        </Space>
      )}
      <Space wrap style={{ marginBottom: 8 }}>
        <Radio.Group
          size="small"
          optionType="button"
          value={f.status}
          onChange={(e) => setFilter(p.id, { status: e.target.value })}
          options={[
            { label: `全部 ${all.length}`, value: "ALL" },
            ...(Object.keys(TASK_STATUS_META) as TaskStatus[]).flatMap((s) => {
              const meta = TASK_STATUS_META[s];
              const opt = (text: string, n: number, value: StatusFilter, disabled: boolean) => ({
                value,
                disabled,
                label: (
                  <span style={disabled ? undefined : { color: meta.hex, fontWeight: 500 }}>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: meta.hex, marginRight: 5, opacity: disabled ? 0.3 : 1 }} />
                    {text} {n}
                  </span>
                ),
              });
              const base = opt(meta.label, counts[s] ?? 0, s, !counts[s]);
              if (s !== "IN_PROGRESS" || !counts[s]) return [base];
              return [
                base,
                opt("标注中·已有内容", startedCount, "IN_PROGRESS_STARTED", !startedCount),
                opt("标注中·还没动手", inProgress.length - startedCount, "IN_PROGRESS_EMPTY", inProgress.length === startedCount),
              ];
            }),
          ]}
        />
        <Input.Search
          size="small"
          allowClear
          placeholder="搜样本名 / 任务ID"
          style={{ width: 240 }}
          value={f.q}
          onChange={(e) => setFilter(p.id, { q: e.target.value })}
        />
        <Select
          size="small"
          mode="multiple"
          allowClear
          placeholder="含类别…"
          style={{ minWidth: 160 }}
          value={f.labels}
          onChange={(v) => setFilter(p.id, { labels: v })}
          options={projLabels.map((l) => ({ value: l.id, label: l.display_name }))}
        />
        <Checkbox checked={f.aiPending} onChange={(e) => setFilter(p.id, { aiPending: e.target.checked })}>
          只看有 AI 待确认
        </Checkbox>
        {filtered && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            筛出 {rows.length} 个
          </Typography.Text>
        )}
      </Space>
      {labelTotals.length > 0 && (
        <Space wrap size={4} style={{ marginBottom: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            片段汇总{totalPending ? `（AI 待确认 ${totalPending} 段）` : ""}：
          </Typography.Text>
          {labelTotals.map(({ label, n, pending, tasksN }) => (
            <Tooltip key={label.id} title={`${n} 段，分布在 ${tasksN} 个任务里${pending ? `，其中 ${pending} 段 AI 待确认` : ""}；点击只看含「${label.display_name}」的任务`}>
              <Tag
                color={label.color ?? undefined}
                style={{ cursor: "pointer", outline: f.labels.includes(label.id) ? "2px solid #1677ff" : undefined }}
                onClick={() =>
                  setFilter(p.id, {
                    labels: f.labels.includes(label.id) ? f.labels.filter((x) => x !== label.id) : [...f.labels, label.id],
                  })
                }
              >
                {label.display_name} {n}
                {pending ? <span style={{ opacity: 0.75 }}>（待确认 {pending}）</span> : null}
                <span style={{ opacity: 0.6 }}> · {tasksN} 任务</span>
              </Tag>
            </Tooltip>
          ))}
        </Space>
      )}
      <ResizableTable
        storageKey="tasks-tasks"
        size="small"
        rowKey="id"
        dataSource={rows}
        sortDirections={["ascend", "descend", "ascend"]}
        pagination={rows.length > 10 ? { pageSize: 10 } : false}
        locale={{ emptyText: onlyMine ? "这个项目下没有指派给你的任务" : filtered ? "没有符合筛选条件的任务" : "这个项目下还没有任务" }}
        columns={[
          { title: "任务ID", dataIndex: "id", width: 80, sorter: (a: Task, b: Task) => a.id - b.id },
          {
            title: "样本",
            dataIndex: "sample_id",
            // 编号里带采集时间，按编号排就是按采集时间排
            sorter: (a: Task, b: Task) => String(sampleCode(a)).localeCompare(String(sampleCode(b))),
            defaultSortOrder: "ascend" as const,
            render: (_: number, task: Task) => (
              <Tooltip title={String(sampleCode(task))}>
                <span>{sampleName(task)}</span>
              </Tooltip>
            ),
          },
          {
            title: "总时长",
            width: 110,
            // 按时长排，想先挑短的就点一下
            sorter: (a: Task, b: Task) => (durationOf(a) ?? 0) - (durationOf(b) ?? 0),
            render: (_: unknown, task: Task) => formatDuration(durationOf(task)),
          },
          {
            title: "类型",
            dataIndex: "task_type",
            width: 150,
            render: (t: string) => TASK_TYPE_LABEL[t] ?? t,
          },
          { title: "轮次", dataIndex: "round_no", width: 60 },
          {
            title: "状态",
            dataIndex: "status",
            width: 150,
            render: (s: TaskStatus, task: Task) => (
              <Space size={4}>
                <TaskStatusTag status={s} />
                {/* 之前有人标了一半又放弃了，草稿还在，接手的人不用从零开始 */}
                {s === "PENDING_ASSIGN" && task.has_draft && (
                  <Tag color="gold">有草稿 {task.draft_item_count ?? ""}段</Tag>
                )}
                {s === "IN_PROGRESS" &&
                  (task.draft_item_count ? <Tag color="geekblue">已标 {task.draft_item_count} 段</Tag> : <Tag>还没动手</Tag>)}
                {/* 被驳回时把审核意见带出来，不用另外去问审核员为什么 */}
                {s === "REJECTED" && task.review_comment && (
                  <Tooltip title={task.review_comment}>
                    <Tag color="red" style={{ cursor: "help" }}>
                      审核意见
                    </Tag>
                  </Tooltip>
                )}
              </Space>
            ),
          },
          {
            title: "片段",
            width: 260,
            // 按总段数排，点表头切换升序/降序
            sorter: (a: Task, b: Task) =>
              Object.values(a.label_counts ?? {}).reduce((s, c) => s + c.n, 0) -
              Object.values(b.label_counts ?? {}).reduce((s, c) => s + c.n, 0),
            sortDirections: ["descend", "ascend", "descend"],
            render: (_, task: Task) => {
              const lc = task.label_counts ?? {};
              const entries = projLabels.filter((l) => (lc[l.id]?.n ?? 0) > 0);
              if (!entries.length) return <Typography.Text type="secondary">-</Typography.Text>;
              return (
                <Space size={2} wrap>
                  {entries.map((l) => {
                    const c = lc[l.id];
                    return (
                      <Tooltip key={l.id} title={c.ai_pending ? `${c.n} 段，其中 ${c.ai_pending} 段 AI 待确认` : `${c.n} 段`}>
                        <Tag color={l.color ?? undefined} style={{ marginRight: 0 }}>
                          {l.display_name} {c.n}
                          {c.ai_pending ? <span style={{ opacity: 0.7 }}>/{c.ai_pending}待确认</span> : null}
                        </Tag>
                      </Tooltip>
                    );
                  })}
                </Space>
              );
            },
          },
          {
            title: "指派给",
            dataIndex: "assigned_to",
            width: 130,
            render: (_: number | null, task: Task) => {
              const name = userName(task);
              if (name == null) return <Typography.Text type="secondary">未指派</Typography.Text>;
              // 按角色上色，指派给自己的再标一个「我」
              const role = task.assigned_to_role ?? users?.find((u) => u.id === task.assigned_to)?.role ?? null;
              return <UserTag name={name} role={role} me={task.assigned_to === userId} />;
            },
          },
          {
            title: "操作",
            render: (_, task: Task) => {
              // 自己锁着的进行中任务才能改，其余情况（已提交/别人在标/管理员旁观）只读
              const editable = task.status === "IN_PROGRESS" && task.locked_by === userId;
              return (
                <Space>
                  {task.status === "PENDING_ASSIGN" && (
                    <Button size="small" onClick={() => handleClaim(task.id)}>
                      认领
                    </Button>
                  )}
                  <Button
                    size="small"
                    type="link"
                    onClick={() => {
                      setWorkspaceLabels(projLabels);
                      openWorkspace(task, !editable);
                    }}
                  >
                    {editable ? "编辑标注" : "查看标注"}
                  </Button>
                  {editable && (
                    <Popconfirm
                      title="放弃任务"
                      description="退回公共池，别人可以接手；已经标的内容会保留成草稿，不会丢"
                      onConfirm={() => handleRelease(task.id)}
                    >
                      <Button size="small" type="link">
                        放弃
                      </Button>
                    </Popconfirm>
                  )}
                  {((isAdmin || role === "reviewer") &&
                    (task.status === "APPROVED" || task.status === "REJECTED")) ||
                  // 被驳回的任务，标注员本人不用等审核员/管理员，自己就能点着重标
                  (task.status === "REJECTED" && task.assigned_to === userId) ? (
                    <Popconfirm
                      title="退回重标"
                      description="轮次+1，这一轮的标注内容会原样带到新一轮，任务回到待认领"
                      onConfirm={() => handleReopen(task.id)}
                    >
                      <Button size="small" type="link">
                        退回重标
                      </Button>
                    </Popconfirm>
                  ) : null}
                  {isAdmin && (
                    <Popconfirm
                      title="删除任务"
                      description="会一并删掉该任务下的标注草稿和审核记录，不可恢复"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => handleDelete(task.id)}
                    >
                      <Button size="small" danger type="link">
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              );
            },
          },
        ]}
      />
      </>
    );
  };

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          placeholder="按项目名搜索"
          allowClear
          style={{ width: 240 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Button type={onlyMine ? "primary" : "default"} onClick={() => setOnlyMine((v) => !v)}>
          只看指派给我的
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          展开项目就能看到它下面的任务；项目多的时候用上面的搜索框找。
        </Typography.Text>
      </Space>

      <ResizableTable
        storageKey="tasks-projects"
        rowKey="id"
        loading={loadingProjects || isLoading}
        dataSource={visibleProjects}
        sortDirections={["descend", "ascend", "descend"]}
        pagination={visibleProjects.length > 20 ? { pageSize: 20 } : false}
        locale={{
          emptyText: (
            <Empty description={onlyMine ? "没有指派给你的任务" : keyword ? "没有匹配的项目" : "还没有项目"} />
          ),
        }}
        expandable={{
          expandedRowRender: renderTaskTable,
          // 只有一个项目时默认展开，省一次点击
          defaultExpandedRowKeys: visibleProjects.length === 1 ? [visibleProjects[0].id] : [],
          // 点行内空白处就能展开，不用非得点最左边那个小箭头
          expandRowByClick: true,
          // 一个任务都没有的项目不给展开箭头，一眼就能看出哪些项目还没建任务
          rowExpandable: (p: Project) => tasksOf(p.id).length > 0,
        }}
        columns={[
          { title: "项目ID", dataIndex: "id", width: 80, sorter: (a: Project, b: Project) => a.id - b.id },
          {
            title: "项目",
            key: "name",
            width: 200,
            sorter: (a: Project, b: Project) => a.name.localeCompare(b.name),
            render: (_, p: Project) => (
              <Space>
                <strong>{p.name}</strong>
                {!p.is_active && <Tag>已停用</Tag>}
              </Space>
            ),
          },
          { title: "说明", dataIndex: "description", width: 200, ellipsis: true, render: (d: string | null) => d || "-" },
          {
            title: "任务",
            width: 300,
            render: (_, p: Project) => {
              const counts = statusSummary(p.id);
              const total = tasksOf(p.id).length;
              if (!total) return <Typography.Text type="secondary">0</Typography.Text>;
              return (
                <Space size={4} wrap>
                  <span>共 {total}</span>
                  {(Object.keys(counts) as TaskStatus[]).map((s) => (
                    <Tag key={s} color={TASK_STATUS_META[s]?.color}>
                      {TASK_STATUS_META[s]?.label ?? s} {counts[s]}
                    </Tag>
                  ))}
                </Space>
              );
            },
          },
          {
            title: "操作",
            width: 220,
            render: (_, p: Project) => {
              // 一个人要领几百个/不干了要退几百个，一个个点太折磨，这里按项目一次搞定。
              // 数字按当前列表算（能领的=待认领且没预指派给别人；能退的=我名下标注中的），
              // 真正以后端 UPDATE...WHERE 的结果为准，有人同时在抢也不会重复
              const claimable = (tasks?.filter((t) => t.project_id === p.id) ?? []).filter(
                (t) => t.status === "PENDING_ASSIGN" && (t.assigned_to == null || t.assigned_to === userId)
              ).length;
              const releasable = (tasks?.filter((t) => t.project_id === p.id) ?? []).filter((t) => t.status === "IN_PROGRESS" && t.locked_by === userId).length;
              return (
                <Space size={0} onClick={(e) => e.stopPropagation()}>
                  <Popconfirm
                    title={`一次认领这 ${claimable} 个待认领任务？`}
                    disabled={!claimable}
                    onConfirm={async () => {
                      const r = await claimAllTasks(p.id);
                      message.success(`已认领 ${r.count} 个任务`);
                      refresh();
                    }}
                  >
                    <Button size="small" type="link" disabled={!claimable}>
                      全部认领{claimable ? ` (${claimable})` : ""}
                    </Button>
                  </Popconfirm>
                  <Popconfirm
                    title={`放弃你名下这 ${releasable} 个标注中的任务？草稿会保留，任务退回公共池`}
                    disabled={!releasable}
                    okButtonProps={{ danger: true }}
                    onConfirm={async () => {
                      const r = await releaseAllTasks(p.id);
                      message.success(`已放弃 ${r.count} 个任务，草稿已保留`);
                      refresh();
                    }}
                  >
                    <Button size="small" type="link" danger disabled={!releasable}>
                      全部放弃{releasable ? ` (${releasable})` : ""}
                    </Button>
                  </Popconfirm>
                </Space>
              );
            },
          },
        ]}
      />

      <AnnotationWorkspace
        task={workspaceTask}
        labels={workspaceLabels}
        readOnly={workspaceReadOnly}
        onClose={() => setWorkspaceTask(null)}
        onSubmitted={refresh}
      />
    </div>
  );
}
