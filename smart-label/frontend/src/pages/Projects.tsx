import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  assignProject,
  createProject,
  deleteProject,
  getProjectPrelabelStatus,
  listProjects,
  startProjectPrelabel,
  updateProject,
  type PrelabelProgress,
} from "@/api/projects";
import {
  bulkCreateTasks,
  claimAllTasks,
  claimTask,
  createTask,
  deleteTask,
  listTasks,
  releaseAllTasks,
  releaseTask,
  reopenTask,
} from "@/api/tasks";
import { listLabels } from "@/api/labels";
import { applyLabelTemplate, listLabelTemplates } from "@/api/labelTemplates";
import { listSamples } from "@/api/samples";
import { listUsers } from "@/api/users";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import { useAuthStore } from "@/stores/authStore";
import { useUrlTask } from "@/utils/urlTask";
import { ROLE_META, TASK_STATUS_META, TASK_TYPE_LABEL, TaskStatusTag } from "@/utils/taskStatus";
import type { LabelDefinition, Project, Task, TaskStatus } from "@/types";

interface FormValues {
  name: string;
  description?: string;
  templateId?: number;
}

export default function Projects() {
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.userInfo?.id);
  const role = useAuthStore((s) => s.userInfo?.role);
  const isAdmin = role === "admin" || role === "super_admin";

  const { data, isLoading } = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const { data: allTasks } = useQuery({ queryKey: ["tasks"], queryFn: () => listTasks() });
  const { data: allLabels } = useQuery({ queryKey: ["labels"], queryFn: () => listLabels() });
  const { data: samples } = useQuery({ queryKey: ["samples"], queryFn: listSamples, enabled: isAdmin });
  const { data: users } = useQuery({ queryKey: ["users"], queryFn: listUsers, enabled: isAdmin });
  const { data: templates } = useQuery({
    queryKey: ["label-templates"],
    queryFn: listLabelTemplates,
    enabled: isAdmin,
  });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [form] = Form.useForm<FormValues>();

  const [assignTarget, setAssignTarget] = useState<Project | null>(null);
  const [assignUserId, setAssignUserId] = useState<number | null>(null);
  const [includeClaimed, setIncludeClaimed] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const [workspaceTask, setWorkspaceTask] = useState<Task | null>(null);
  // 每个项目展开后的任务筛选（按状态 / 按样本名搜索），一个项目上百个任务时靠翻页找
  // "标注中"的那几个太费劲。展开状态自己管，这样点汇总里的状态 Tag 能直接展开并筛选。
  type StatusFilter = TaskStatus | "ALL" | "IN_PROGRESS_STARTED" | "IN_PROGRESS_EMPTY";
  const [taskFilters, setTaskFilters] = useState<Record<number, { status: StatusFilter; q: string }>>({});
  const [expandedKeys, setExpandedKeys] = useState<number[]>([]);
  const filterOf = (projectId: number) => taskFilters[projectId] ?? { status: "ALL" as const, q: "" };
  const setFilter = (projectId: number, patch: Partial<{ status: StatusFilter; q: string }>) =>
    setTaskFilters((prev) => ({ ...prev, [projectId]: { ...filterOf(projectId), ...patch } }));
  const [workspaceReadOnly, setWorkspaceReadOnly] = useState(false);
  const [workspaceLabels, setWorkspaceLabels] = useState<LabelDefinition[]>([]);

  const [createForProject, setCreateForProject] = useState<Project | null>(null);
  const [createForm] = Form.useForm();
  const [bulkForProject, setBulkForProject] = useState<Project | null>(null);
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set());
  const [bulkTaskType, setBulkTaskType] = useState<"from_scratch" | "ai_assisted">("from_scratch");
  const [bulkAssignee, setBulkAssignee] = useState<number | null>(null);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  // 项目级批量 AI 预标注：每个项目各自一份进度，正在跑的每 2 秒轮询一次
  const [prelabelTarget, setPrelabelTarget] = useState<Project | null>(null);
  const [prelabelOverwrite, setPrelabelOverwrite] = useState(false);
  const [prelabelStarting, setPrelabelStarting] = useState(false);
  const [prelabelProgress, setPrelabelProgress] = useState<Record<number, PrelabelProgress>>({});

  // 秒数 → "约 3 分钟" / "约 1 小时 20 分钟" / "不到 1 分钟"，进度条旁边和弹窗里都用
  const fmtEta = (sec: number | null | undefined) => {
    if (sec == null) return null;
    const m = Math.ceil(sec / 60);
    if (m < 1) return "不到 1 分钟";
    if (m < 60) return `约 ${m} 分钟`;
    return `约 ${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
  };
  const prevStatusRef = useRef<Record<number, string>>({});

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["labels"] });
  };

  const pollPrelabel = async (ids: number[]) => {
    const results = await Promise.all(ids.map((id) => getProjectPrelabelStatus(id).catch(() => null)));
    setPrelabelProgress((prev) => {
      const next = { ...prev };
      results.forEach((p, i) => {
        if (p) next[ids[i]] = p;
      });
      return next;
    });
    results.forEach((p, i) => {
      if (!p) return;
      const id = ids[i];
      const was = prevStatusRef.current[id];
      prevStatusRef.current[id] = p.status;
      // 从"跑着"变成"跑完"的那一刻提示一次并刷新任务列表（草稿段数变了）
      if (was === "running" && p.status !== "running") {
        if (p.status === "done") {
          message.success(`AI 预标注完成：成功 ${p.succeeded}，跳过 ${p.skipped}，失败 ${p.failed}`, 6);
        } else if (p.status === "error") {
          message.error(`AI 预标注出错：${p.error_message}`);
        }
        refresh();
      }
    });
  };

  // 页面打开先各查一次（刷新页面时正在跑的还能接着看进度），之后只轮询在跑的
  const projectIds = (data ?? []).map((p) => p.id).join(",");
  useEffect(() => {
    if (!projectIds) return;
    pollPrelabel(projectIds.split(",").map(Number));
  }, [projectIds]);
  const runningIds = Object.values(prelabelProgress)
    .filter((p) => p.status === "running")
    .map((p) => p.project_id)
    .join(",");
  useEffect(() => {
    if (!runningIds) return;
    const timer = setInterval(() => pollPrelabel(runningIds.split(",").map(Number)), 2000);
    return () => clearInterval(timer);
  }, [runningIds]);

  // 项目里哪些任务会被批量预标注碰到：待认领/标注中，且还没存过任何片段
  const prelabelEligible = (projectId: number, overwrite: boolean) =>
    tasksOf(projectId).filter(
      (t) =>
        (t.status === "PENDING_ASSIGN" || t.status === "IN_PROGRESS") && (overwrite || !(t.draft_item_count ?? 0))
    ).length;

  const handleStartPrelabel = async () => {
    if (!prelabelTarget) return;
    setPrelabelStarting(true);
    try {
      const r = await startProjectPrelabel(prelabelTarget.id, prelabelOverwrite);
      message.info(r.queued ? "这个项目已经有一批在跑，本次请求已排在后面" : "已开始，进度在项目行里看");
      await pollPrelabel([prelabelTarget.id]);
      setPrelabelTarget(null);
    } finally {
      setPrelabelStarting(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({ name: "", description: "", templateId: undefined });
    setOpen(true);
  };

  const openEdit = (p: Project) => {
    setEditing(p);
    form.setFieldsValue({ name: p.name, description: p.description ?? "", templateId: undefined });
    setOpen(true);
  };

  const handleSubmit = async ({ templateId, ...values }: FormValues) => {
    let projectId = editing?.id;
    if (editing) {
      await updateProject(editing.id, values);
      message.success("已保存");
    } else {
      const created = await createProject(values);
      projectId = created.id;
      message.success("项目已创建");
    }
    if (templateId != null && projectId != null) {
      const r = await applyLabelTemplate(templateId, projectId);
      message.success(`已套用模板，添加 ${r.created} 个标签${r.skipped ? `，跳过已存在的 ${r.skipped} 个` : ""}`);
    }
    setOpen(false);
    form.resetFields();
    refresh();
  };

  const handleDelete = async (id: number) => {
    await deleteProject(id);
    message.success("项目及其任务、标签已删除");
    refresh();
  };

  const openAssign = (p: Project) => {
    setAssignTarget(p);
    setAssignUserId(null);
    setIncludeClaimed(false);
  };

  const handleAssign = async () => {
    if (!assignTarget) return;
    setAssigning(true);
    try {
      const r = await assignProject(assignTarget.id, assignUserId, includeClaimed);
      message.success(`已指派 ${r.assigned} 个任务${r.skipped ? `，跳过 ${r.skipped} 个` : ""}`);
      setAssignTarget(null);
      refresh();
    } finally {
      setAssigning(false);
    }
  };

  const tasksOf = (projectId: number) => allTasks?.filter((t) => t.project_id === projectId) ?? [];
  const labelCount = (projectId: number) =>
    allLabels?.filter((l) => l.project_id === projectId).length ?? 0;
  const userName = (id: number | null) => {
    if (id == null) return null;
    const u = users?.find((x) => x.id === id);
    return u ? u.display_name || u.username : `#${id}`;
  };
  const sampleCode = (id: number) => samples?.find((s) => s.id === id)?.sample_code ?? id;

  const handleCreateTask = async (values: { sample_id: number; task_type: "from_scratch" | "ai_assisted" }) => {
    if (!createForProject) return;
    await createTask({ ...values, project_id: createForProject.id });
    message.success("任务已创建");
    setCreateForProject(null);
    createForm.resetFields();
    refresh();
  };

  // 样本按日期分组，导入任务时按天批量选，跟样本页的分组方式保持一致
  const samplesByDate = useMemo(() => {
    const groups = new Map<string, typeof samples>();
    for (const s of samples ?? []) {
      const key = s.session_date ?? "未知日期";
      (groups.get(key) ?? groups.set(key, []).get(key)!)!.push(s);
    }
    return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [samples]);

  const alreadyImportedIds = useMemo(
    () => new Set(bulkForProject ? tasksOf(bulkForProject.id).map((t) => t.sample_id) : []),
    [bulkForProject, allTasks]
  );

  const openBulkImport = (p: Project) => {
    setBulkForProject(p);
    setBulkSelected(new Set());
    setBulkTaskType("from_scratch");
    setBulkAssignee(null);
  };

  const toggleDate = (dateSamples: typeof samples, checked: boolean) => {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      for (const s of dateSamples ?? []) {
        if (alreadyImportedIds.has(s.id)) continue;
        if (checked) next.add(s.id);
        else next.delete(s.id);
      }
      return next;
    });
  };

  const handleBulkImport = async () => {
    if (!bulkForProject || bulkSelected.size === 0) return;
    setBulkSubmitting(true);
    try {
      const r = await bulkCreateTasks({
        project_id: bulkForProject.id,
        sample_ids: [...bulkSelected],
        task_type: bulkTaskType,
        assigned_to: bulkAssignee ?? undefined,
      });
      message.success(`已导入 ${r.created} 个任务${r.skipped ? `，跳过已导入过的 ${r.skipped} 个` : ""}`);
      setBulkForProject(null);
      refresh();
    } finally {
      setBulkSubmitting(false);
    }
  };

  // 标注工作台的标签按钮要取任务所属项目的标签，不能把别的项目的混进来
  const labelsOf = (projectId: number): LabelDefinition[] =>
    allLabels?.filter((l) => l.project_id === projectId) ?? [];

  const openWorkspace = (task: Task, readOnly: boolean, projectId: number) => {
    setWorkspaceLabels(labelsOf(projectId));
    setWorkspaceReadOnly(readOnly);
    setWorkspaceTask(task);
  };

  // 刷新页面还能回到打开着的任务（?task=ID），顺便把它所在的项目行展开
  useUrlTask(allTasks, workspaceTask?.id ?? null, (task) => {
    setExpandedKeys((prev) => (prev.includes(task.project_id) ? prev : [...prev, task.project_id]));
    openWorkspace(task, !(task.status === "IN_PROGRESS" && task.locked_by === userId), task.project_id);
  });

  const handleClaimTask = async (id: number) => {
    await claimTask(id);
    message.success("认领成功");
    refresh();
  };

  const handleReleaseTask = async (id: number) => {
    await releaseTask(id);
    message.success("已放弃，任务退回公共池，草稿已保留");
    refresh();
  };

  const handleReopenTask = async (id: number) => {
    await reopenTask(id);
    message.success("已退回重标，上一轮内容已带到新一轮");
    refresh();
  };

  const handleDeleteTask = async (id: number) => {
    await deleteTask(id);
    message.success("任务已删除");
    refresh();
  };

  // 项目下任务按状态汇总，一眼看出进度
  const renderBulkClaim = (p: Project) => {
    // 一个人要领几百个/不干了要退几百个，一个个点太折磨，这里按项目一次搞定。
    // 数字按当前列表算（能领的=待认领且没预指派给别人；能退的=我名下标注中的），
    // 真正以后端 UPDATE...WHERE 的结果为准，有人同时在抢也不会重复
    const claimable = tasksOf(p.id).filter(
      (t) => t.status === "PENDING_ASSIGN" && (t.assigned_to == null || t.assigned_to === userId)
    ).length;
    const releasable = tasksOf(p.id).filter((t) => t.status === "IN_PROGRESS" && t.locked_by === userId).length;
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
  };

  const statusSummary = (projectId: number) => {
    const counts: Partial<Record<TaskStatus, number>> = {};
    for (const t of tasksOf(projectId)) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return counts;
  };

  // 项目下这些任务都指派给谁了
  const assigneeSummary = (projectId: number) => {
    const ids = new Set(tasksOf(projectId).map((t) => t.assigned_to));
    const named = [...ids].filter((i): i is number => i != null).map(userName);
    const hasUnassigned = ids.has(null);
    return { named, hasUnassigned };
  };

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        {isAdmin && (
          <Button type="primary" onClick={openCreate}>
            新建项目
          </Button>
        )}
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        同一批数据在不同业务下要标的东西不一样，所以先建项目，再在项目里建任务、配标签。
        项目之间的标签互不干扰，同一个样本可以同时出现在多个项目里。
        点左侧箭头可以展开看项目下的任务；「指派」可以把整个项目的任务一次性分给某个人。
      </Typography.Paragraph>

      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data}
        expandable={{
          // 点行内空白处就能展开，不用非得点最左边那个小箭头
          expandRowByClick: true,
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: (keys) => setExpandedKeys(keys as number[]),
          // 一个任务都没有的项目不给展开箭头，一眼就能看出哪些项目还没建任务
          rowExpandable: (p: Project) => tasksOf(p.id).length > 0,
          // 展开就能看到这个项目下都有哪些任务、分给谁了、做到哪一步了
          expandedRowRender: (p: Project) => {
            const all = tasksOf(p.id);
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
            const rows = all.filter(
              (t) => matchStatus(t) && (!q || String(sampleCode(t.sample_id)).toLowerCase().includes(q) || String(t.id) === q)
            );
            return (
              <>
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
                      // 每个状态前面一个跟 Tag 同色的色点，一排灰字看着吃力
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
                      // 标注中再拆成"已有内容 / 还没动手"，找到底哪几个是真的在标
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
                {(f.status !== "ALL" || q) && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    筛出 {rows.length} 个
                  </Typography.Text>
                )}
              </Space>
              <Table
                size="small"
                rowKey="id"
                dataSource={rows}
                pagination={rows.length > 10 ? { pageSize: 10, showSizeChanger: true } : false}
                locale={{ emptyText: all.length ? "没有符合筛选条件的任务" : "这个项目下还没有任务" }}
                columns={[
                  { title: "任务ID", dataIndex: "id", width: 80 },
                  {
                    title: "样本",
                    dataIndex: "sample_id",
                    render: (id: number) => sampleCode(id),
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
                    width: 190,
                    render: (s: TaskStatus, task: Task) => (
                      <Space size={4}>
                        <TaskStatusTag status={s} />
                        {/* 之前有人标了一半又放弃了，草稿还在，接手的人不用从零开始 */}
                        {s === "PENDING_ASSIGN" && task.has_draft && (
                          <Tag color="gold">有草稿 {task.draft_item_count ?? ""}段</Tag>
                        )}
                        {/* 标注中的分两种：只是认领了进去看了一眼，和已经标了一堆，列表里要能一眼分开 */}
                        {s === "IN_PROGRESS" &&
                          (task.draft_item_count ? (
                            <Tag color="geekblue">已标 {task.draft_item_count} 段</Tag>
                          ) : (
                            <Tag>还没动手</Tag>
                          ))}
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
                    title: "指派给",
                    dataIndex: "assigned_to",
                    render: (id: number | null) =>
                      id == null ? <Typography.Text type="secondary">未指派</Typography.Text> : userName(id),
                  },
                  {
                    title: "操作",
                    render: (_, task: Task) => {
                      // 自己锁着的进行中任务才能改，其余情况（已提交/别人在标/管理员旁观）只读
                      const editable = task.status === "IN_PROGRESS" && task.locked_by === userId;
                      return (
                        <Space>
                          {task.status === "PENDING_ASSIGN" && (
                            <Button size="small" onClick={() => handleClaimTask(task.id)}>
                              认领
                            </Button>
                          )}
                          <Button
                            size="small"
                            type="link"
                            onClick={() => openWorkspace(task, !editable, p.id)}
                          >
                            {editable ? "编辑标注" : "查看标注"}
                          </Button>
                          {editable && (
                            <Popconfirm
                              title="放弃任务"
                              description="退回公共池，别人可以接手；已经标的内容会保留成草稿，不会丢"
                              onConfirm={() => handleReleaseTask(task.id)}
                            >
                              <Button size="small" type="link">
                                放弃
                              </Button>
                            </Popconfirm>
                          )}
                          {(isAdmin || role === "reviewer" || task.assigned_to === userId) &&
                            (task.status === "APPROVED" || task.status === "REJECTED") && (
                              <Popconfirm
                                title="退回重标"
                                description="轮次+1，这一轮的标注内容会原样带到新一轮，任务回到待认领"
                                onConfirm={() => handleReopenTask(task.id)}
                              >
                                <Button size="small" type="link">
                                  退回重标
                                </Button>
                              </Popconfirm>
                            )}
                          {isAdmin && (
                            <Popconfirm
                              title="删除任务"
                              description="会一并删掉该任务下的标注草稿和审核记录，不可恢复"
                              okButtonProps={{ danger: true }}
                              onConfirm={() => handleDeleteTask(task.id)}
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
          },
        }}
        columns={[
          { title: "ID", dataIndex: "id", width: 60 },
          {
            title: "项目名",
            width: 160,
            ellipsis: true,
            render: (_, p: Project) => (
              <Space>
                <strong>{p.name}</strong>
                {!p.is_active && <Tag>已停用</Tag>}
              </Space>
            ),
          },
          {
            title: "说明",
            dataIndex: "description",
            width: 180,
            ellipsis: true,
            render: (d: string | null) => d || "-",
          },
          {
            title: "任务",
            width: 240,
            render: (_, p: Project) => {
              const counts = statusSummary(p.id);
              const total = tasksOf(p.id).length;
              if (!total) return <Typography.Text type="secondary">0</Typography.Text>;
              const pp = prelabelProgress[p.id];
              return (
                <Space size={4} wrap>
                  {pp?.status === "running" && (
                    // 批量 AI 预标注进行中：总共多少个、跑到第几个、正在跑哪个样本
                    <Tooltip
                      title={`正在跑：${pp.current_sample_code ?? ""}（任务 #${pp.current_task_id ?? ""}）
成功 ${pp.succeeded} · 跳过 ${pp.skipped} · 失败 ${pp.failed}${
                        pp.estimated_remaining_sec != null ? ` · 预计还需 ${Math.ceil(pp.estimated_remaining_sec / 60)} 分钟` : ""
                      }`}
                    >
                      <div style={{ width: "100%", minWidth: 200 }} onClick={(e) => e.stopPropagation()}>
                        <Progress
                          size="small"
                          status="active"
                          percent={pp.total ? Math.round((pp.processed / pp.total) * 100) : 0}
                          format={() => `AI ${pp.processed}/${pp.total}`}
                        />
                        {/* 耗时预估直接摆出来，不用悬停才看得到；后端按已完成的速率算，
                            第一批还没回来之前没有数据，先显示"预估中" */}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          已用 {fmtEta(pp.elapsed_sec) ?? "-"} ·{" "}
                          {pp.estimated_remaining_sec != null ? `预计还需 ${fmtEta(pp.estimated_remaining_sec)}` : "预估中…"}
                        </Typography.Text>
                      </div>
                    </Tooltip>
                  )}
                  <span>共 {total}</span>
                  {(Object.keys(counts) as TaskStatus[]).map((s) => (
                    <Tag
                      key={s}
                      color={TASK_STATUS_META[s]?.color}
                      style={{ cursor: "pointer" }}
                      title={`只看${TASK_STATUS_META[s]?.label ?? s}的任务`}
                      onClick={(e) => {
                        // 点状态 Tag = 展开这个项目并只看这个状态；别触发行本身的展开/收起切换
                        e.stopPropagation();
                        setFilter(p.id, { status: s });
                        setExpandedKeys((prev) => (prev.includes(p.id) ? prev : [...prev, p.id]));
                      }}
                    >
                      {TASK_STATUS_META[s]?.label ?? s} {counts[s]}
                    </Tag>
                  ))}
                </Space>
              );
            },
          },
          {
            title: "指派给",
            width: 180,
            render: (_, p: Project) => {
              const { named, hasUnassigned } = assigneeSummary(p.id);
              if (!named.length && !hasUnassigned) return "-";
              return (
                <Space size={4} wrap>
                  {named.map((n) => (
                    <Tag key={n} color="blue">
                      {n}
                    </Tag>
                  ))}
                  {hasUnassigned && <Tag>有未指派</Tag>}
                </Space>
              );
            },
          },
          { title: "标签数", width: 80, render: (_, p: Project) => labelCount(p.id) },
          {
            title: "操作",
            width: 360,
            render: (_, p: Project) =>
              isAdmin && (
                // 整行点击展开后，操作按钮得挡住这个冒泡，不然点"编辑"之类的
                // 按钮会连带把行展开/收起，体验很怪
                <Space wrap onClick={(e) => e.stopPropagation()}>
                  <Button size="small" type="link" onClick={() => setCreateForProject(p)}>
                    新建任务
                  </Button>
                  <Button size="small" type="link" onClick={() => openBulkImport(p)}>
                    批量导入
                  </Button>
                  <Button size="small" type="link" onClick={() => openAssign(p)}>
                    指派
                  </Button>
                  {renderBulkClaim(p)}
                  <Button
                    size="small"
                    type="link"
                    loading={prelabelProgress[p.id]?.status === "running"}
                    onClick={() => {
                      setPrelabelOverwrite(false);
                      setPrelabelTarget(p);
                    }}
                  >
                    AI预标注
                  </Button>
                  <Button size="small" type="link" onClick={() => openEdit(p)}>
                    编辑
                  </Button>
                  <Button
                    size="small"
                    type="link"
                    onClick={async () => {
                      await updateProject(p.id, { is_active: !p.is_active });
                      refresh();
                    }}
                  >
                    {p.is_active ? "停用" : "启用"}
                  </Button>
                  <Popconfirm
                    title="删除项目"
                    description={
                      <div style={{ maxWidth: 320 }}>
                        会连同该项目下的 <b>{tasksOf(p.id).length}</b> 个任务（含它们的标注结果和审核记录）
                        和 <b>{labelCount(p.id)}</b> 个标签一起删掉，不可恢复。
                        只是暂时不用的话建议改成「停用」。
                      </div>
                    }
                    okButtonProps={{ danger: true }}
                    onConfirm={() => handleDelete(p.id)}
                  >
                    <Button size="small" danger type="link">
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
          },
        ]}
      />

      <Modal
        title={`批量 AI 预标注 - ${prelabelTarget?.name ?? ""}`}
        open={prelabelTarget != null}
        onCancel={() => setPrelabelTarget(null)}
        onOk={handleStartPrelabel}
        okText="开始"
        confirmLoading={prelabelStarting}
        okButtonProps={{ disabled: !prelabelTarget || prelabelEligible(prelabelTarget.id, prelabelOverwrite) === 0 }}
        destroyOnClose
      >
        {prelabelTarget && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              会对这个项目里 <b>待认领 / 标注中</b> 且还没有人动过的任务逐个调用 AI 模型，把预测出来的行为片段
              直接写进任务草稿。标注员打开任务时就已经有 AI 框了，只需要确认或纠正。
              已提交、已通过、被驳回、以及已经有人工标注的任务不会被碰。
            </Typography.Paragraph>
            <Checkbox checked={prelabelOverwrite} onChange={(e) => setPrelabelOverwrite(e.target.checked)}>
              连已经有 AI 片段（但没人改过/确认过）的任务也重新跑一遍（比如换了模型想刷新）
            </Checkbox>
            <Typography.Text>
              本次将处理 <b>{prelabelEligible(prelabelTarget.id, prelabelOverwrite)}</b> 个任务。AI 服务按文件多进程并行跑，
              整个过程在后台进行，项目行里能看到进度和预计剩余时间。
            </Typography.Text>
            {(() => {
              const pp = prelabelProgress[prelabelTarget.id];
              if (!pp || pp.status === "idle") return null;
              return (
                <div style={{ background: "#fafafa", padding: 8, borderRadius: 4 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    上一次/当前：{pp.status === "running" ? "进行中" : pp.status === "done" ? "已完成" : "出错"}，
                    {pp.processed}/{pp.total}，成功 {pp.succeeded}，跳过 {pp.skipped}，失败 {pp.failed}，已用 {fmtEta(pp.elapsed_sec) ?? "-"}
                    {pp.status === "running" && (
                      <>，{pp.estimated_remaining_sec != null ? `预计还需 ${fmtEta(pp.estimated_remaining_sec)}` : "剩余时间预估中…"}</>
                    )}
                  </Typography.Text>
                  {pp.unmatched_labels.length > 0 && (
                    <Alert
                      style={{ marginTop: 6 }}
                      type="warning"
                      showIcon
                      message={`AI 类别「${pp.unmatched_labels.join("、")}」在项目标签里没有同名标签，这些片段被丢弃了；去「标签管理」补上后重新跑`}
                    />
                  )}
                  {pp.detail.length > 0 && (
                    <div style={{ maxHeight: 160, overflow: "auto", marginTop: 6, fontSize: 12, color: "#666" }}>
                      {pp.detail.slice(-30).map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </Space>
        )}
      </Modal>

      <Modal
        title={editing ? `编辑项目 - ${editing.name}` : "新建项目"}
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="name" label="项目名" rules={[{ required: true }]}>
            <Input placeholder="如：狗行为标注 / 项圈佩戴检测" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={3} placeholder="这个项目要标什么、给谁用" />
          </Form.Item>
          <Form.Item
            name="templateId"
            label="标签模板（可选）"
            extra={
              editing
                ? "套用会把模板里的标签添加进来，已有同 code 的会跳过，不会覆盖"
                : "创建后立即套用该模板的标签，不用另外去标签管理页配一遍"
            }
          >
            <Select
              allowClear
              placeholder="不选则不套用，之后可以去「标签管理」页再套"
              options={templates?.map((t) => ({
                value: t.id,
                label: `${t.name}（${t.items.length} 个标签）`,
              }))}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          {editing && (
            <Form.Item label="启用">
              <Switch
                checked={editing.is_active}
                onChange={async (v) => {
                  await updateProject(editing.id, { is_active: v });
                  setEditing({ ...editing, is_active: v });
                  refresh();
                }}
              />
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" block>
            {editing ? "保存" : "创建"}
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`指派项目 - ${assignTarget?.name ?? ""}`}
        open={assignTarget != null}
        onCancel={() => setAssignTarget(null)}
        onOk={handleAssign}
        okText="指派"
        confirmLoading={assigning}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          把这个项目下的任务一次性分给一个人，不用一个一个点。默认只改还没被认领的任务，
          已经有人在标或已提交的不动，免得把别人做了一半的活儿抢走。
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Select
            style={{ width: "100%" }}
            placeholder="选择标注员（留空 = 收回指派，回到公共池）"
            allowClear
            value={assignUserId ?? undefined}
            onChange={(v) => setAssignUserId(v ?? null)}
            options={users
              ?.filter((u) => u.is_active && u.role !== "reviewer")
              .map((u) => ({
                value: u.id,
                label: `${u.display_name || u.username}（${ROLE_META[u.role]?.label ?? u.role}）`,
              }))}
            showSearch
            optionFilterProp="label"
          />
          <Checkbox checked={includeClaimed} onChange={(e) => setIncludeClaimed(e.target.checked)}>
            连已被认领/已提交的任务一起改派（会退回待认领状态，已通过的不受影响）
          </Checkbox>
          {assignTarget && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              该项目共 {tasksOf(assignTarget.id).length} 个任务，其中待认领{" "}
              {tasksOf(assignTarget.id).filter((t: Task) => t.status === "PENDING_ASSIGN").length} 个
            </Typography.Text>
          )}
        </Space>
      </Modal>

      <Modal
        title={`新建任务 - ${createForProject?.name ?? ""}`}
        open={createForProject != null}
        onCancel={() => setCreateForProject(null)}
        footer={null}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreateTask}>
          <Form.Item name="sample_id" label="样本" rules={[{ required: true }]}>
            <Select
              options={samples?.map((s) => ({ value: s.id, label: `#${s.id} ${s.sample_code}` }))}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item name="task_type" label="标注模式" rules={[{ required: true }]} initialValue="from_scratch">
            <Select
              options={[
                { value: "from_scratch", label: "从零标注" },
                { value: "ai_assisted", label: "AI预标注+人工修改" },
              ]}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            创建
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`批量导入样本到任务 - ${bulkForProject?.name ?? ""}`}
        open={bulkForProject != null}
        onCancel={() => setBulkForProject(null)}
        onOk={handleBulkImport}
        okText={`导入选中的 ${bulkSelected.size} 个`}
        okButtonProps={{ disabled: bulkSelected.size === 0 }}
        confirmLoading={bulkSubmitting}
        width={640}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          按天勾选整批样本，一次性各建一个覆盖整个样本的任务，不用一个个点「新建任务」。
          已经在这个项目下建过任务的样本会自动跳过（灰色，勾不了）。
        </Typography.Paragraph>
        <Space style={{ marginBottom: 12 }}>
          <Typography.Text>标注模式</Typography.Text>
          <Select
            style={{ width: 200 }}
            value={bulkTaskType}
            onChange={setBulkTaskType}
            options={[
              { value: "from_scratch", label: "从零标注" },
              { value: "ai_assisted", label: "AI预标注+人工修改（建好后自动跑 AI）" },
            ]}
          />
          <Typography.Text>指派给</Typography.Text>
          <Select
            style={{ width: 160 }}
            allowClear
            placeholder="不指派（进公共池）"
            value={bulkAssignee ?? undefined}
            onChange={(v) => setBulkAssignee(v ?? null)}
            options={users
              ?.filter((u) => u.is_active && u.role !== "reviewer")
              .map((u) => ({ value: u.id, label: u.display_name || u.username }))}
          />
        </Space>
        <Collapse
          size="small"
          items={samplesByDate.map(([date, dateSamples]) => {
            const selectable = (dateSamples ?? []).filter((s) => !alreadyImportedIds.has(s.id));
            const selectedCount = selectable.filter((s) => bulkSelected.has(s.id)).length;
            const allSelected = selectable.length > 0 && selectedCount === selectable.length;
            return {
              key: date,
              label: (
                <Space onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    indeterminate={selectedCount > 0 && !allSelected}
                    checked={allSelected}
                    disabled={selectable.length === 0}
                    onChange={(e) => toggleDate(dateSamples, e.target.checked)}
                  />
                  <span>
                    {date}（{dateSamples?.length ?? 0} 个样本
                    {selectable.length < (dateSamples?.length ?? 0) && `，${selectable.length} 个可导入`}）
                  </span>
                </Space>
              ),
              children: (
                <Space direction="vertical" size={2}>
                  {(dateSamples ?? []).map((s) => {
                    const imported = alreadyImportedIds.has(s.id);
                    return (
                      <Checkbox
                        key={s.id}
                        disabled={imported}
                        checked={bulkSelected.has(s.id)}
                        onChange={(e) =>
                          setBulkSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(s.id);
                            else next.delete(s.id);
                            return next;
                          })
                        }
                      >
                        {s.sample_code}
                        {imported && (
                          <Typography.Text type="secondary" style={{ marginLeft: 6 }}>
                            （已导入）
                          </Typography.Text>
                        )}
                      </Checkbox>
                    );
                  })}
                </Space>
              ),
            };
          })}
        />
      </Modal>

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
