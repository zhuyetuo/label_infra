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
  Segmented,
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
  getProjectPrelabelHistory,
  cancelProjectPrelabel,
  getProjectPrelabelStatus,
  listProjects,
  startProjectPrelabel,
  updateProject,
  type PrelabelProgress,
  type PrelabelRun,
} from "@/api/projects";
import {
  bulkCreateTasks,
  claimAllTasks,
  claimTask,
  createTask,
  deleteTask,
  deleteTasksBatch,
  listTasks,
  releaseAllTasks,
  releaseTask,
  reopenTask,
} from "@/api/tasks";
import { getSavedBool, getSavedText, saveBool, saveText } from "@/utils/persistedSize";
import { listLabels } from "@/api/labels";
import { applyLabelTemplate, listLabelTemplates } from "@/api/labelTemplates";
import { listSamples } from "@/api/samples";
import { listUsers } from "@/api/users";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import ResizableTable from "@/components/ResizableTable";
import { useAuthStore } from "@/stores/authStore";
import { imuOf, sortImuKeys } from "@/utils/imuOf";
import { formatDuration, sampleDisplayName } from "@/utils/sampleName";
import { UserTag } from "@/utils/roleTag";
import { INFER_MODE_HINT, INFER_MODE_LABEL, INFER_MODE_OPTIONS, type InferMode } from "@/utils/inferMode";

// 上次用的预标注版本：用惯哪个就默认哪个，省得每次重选
const PRELABEL_MODE_KEY = "smart-label:prelabel-mode";
const CREATE_MODE_KEY = "smart-label:create-infer-mode";
// 「连已经有 AI 片段的也重跑」也记住：换了模型想全量刷新时，每个项目都要重勾
// 一遍太烦，而这个选择在一轮刷新里通常是一致的
const PRELABEL_OVERWRITE_KEY = "smart-label:prelabel-overwrite";
// 没选过时的默认版本。稳定版 v2 是现在实际在用的那个
const DEFAULT_INFER_MODE: InferMode = "viterbi";
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
  // labels：只看含这些类别片段的任务；aiPending：只看还有 AI 待确认片段的任务——
  // 批量预标注完想专门审某一类（比如抓挠），靠这两个直接挑出要看的任务
  // noCsv：只看 IMU CSV 是空的任务（打开就报"CSV 没有数据行"），管理员筛出来一键删掉，别分给别人
  type TaskFilter = { status: StatusFilter; q: string; labels: number[]; aiPending: boolean; imu: string; noCsv: boolean };
  const [taskFilters, setTaskFilters] = useState<Record<number, TaskFilter>>({});
  const [expandedKeys, setExpandedKeys] = useState<number[]>([]);
  const filterOf = (projectId: number): TaskFilter =>
    taskFilters[projectId] ?? { status: "ALL" as const, q: "", labels: [], aiPending: false, imu: "ALL", noCsv: false };
  const setFilter = (projectId: number, patch: Partial<TaskFilter>) =>
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
  const [prelabelOverwrite, setPrelabelOverwrite] = useState(() => getSavedBool(PRELABEL_OVERWRITE_KEY, false));
  // 记住上次用的版本：用惯哪个就默认哪个，不用每次重选
  const [prelabelMode, setPrelabelMode] = useState<InferMode>(
    () => (getSavedText(PRELABEL_MODE_KEY, DEFAULT_INFER_MODE) as InferMode)
  );
  // 新建项目 / 批量导入时 ai_assisted 自动跑预标注用哪个版本
  const [createInferMode, setCreateInferMode] = useState<InferMode>(
    () => (getSavedText(CREATE_MODE_KEY, DEFAULT_INFER_MODE) as InferMode)
  );
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
  // 秒数 → "0:07" / "3:42" / "1:02:15"，精确到秒，从 0 开始计，跑完看总耗时用
  const fmtClock = (sec: number | null | undefined) => {
    const s = Math.max(0, Math.round(sec ?? 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
  };
  const prevStatusRef = useRef<Record<number, string>>({});
  // 弹窗里展示的历史运行记录（每次跑完后端记一条）
  const [prelabelHistory, setPrelabelHistory] = useState<PrelabelRun[]>([]);
  useEffect(() => {
    if (!prelabelTarget) return;
    getProjectPrelabelHistory(prelabelTarget.id)
      .then(setPrelabelHistory)
      .catch(() => setPrelabelHistory([]));
  }, [prelabelTarget?.id]);

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
      const r = await startProjectPrelabel(prelabelTarget.id, prelabelOverwrite, prelabelMode);
      message.info(r.queued ? "这个项目已经有一批在跑，本次请求已排在后面" : "已开始，进度在项目行里看");
      await pollPrelabel([prelabelTarget.id]);
      setPrelabelTarget(null);
    } finally {
      setPrelabelStarting(false);
    }
  };

  // 新建项目一步到位：选样本 -> 建项目 -> 套标签模板 -> 批量建任务（可选 AI 预标注、
  // 指派）。项目名默认用选中样本的日期目录名，改过就不再自动覆盖。
  const [createSelected, setCreateSelected] = useState<Set<number>>(new Set());
  const [createTaskType, setCreateTaskType] = useState<"from_scratch" | "ai_assisted">("ai_assisted");
  const [createAssignee, setCreateAssignee] = useState<number | null>(null);
  const [nameAuto, setNameAuto] = useState(true);
  const [creating, setCreating] = useState(false);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({ name: "", description: "", templateId: templates?.[0]?.id });
    setCreateSelected(new Set());
    setCreateTaskType("ai_assisted");
    // 默认指派给自己（管理员/超管建项目大多是自己先调试），不想要就在下拉里清掉进公共池
    setCreateAssignee(isAdmin ? (userId ?? null) : null);
    setNameAuto(true);
    setOpen(true);
  };

  // 选中的样本落在哪些日期目录里 -> 默认项目名
  const defaultNameFor = (ids: Set<number>) => {
    const dates = [...new Set((samples ?? []).filter((s) => ids.has(s.id)).map((s) => s.session_date ?? "未知日期"))].sort();
    if (dates.length === 0) return "";
    if (dates.length === 1) return dates[0];
    if (dates.length === 2) return `${dates[0]}、${dates[1]}`;
    return `${dates[0]}~${dates[dates.length - 1]}（${dates.length}天）`;
  };
  const updateCreateSelected = (updater: (prev: Set<number>) => Set<number>) => {
    setCreateSelected((prev) => {
      const next = updater(prev);
      if (nameAuto) form.setFieldsValue({ name: defaultNameFor(next) });
      return next;
    });
  };

  const openEdit = (p: Project) => {
    setEditing(p);
    form.setFieldsValue({ name: p.name, description: p.description ?? "", templateId: undefined });
    setOpen(true);
  };

  const handleSubmit = async ({ templateId, ...values }: FormValues) => {
    setCreating(true);
    try {
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
      if (!editing && projectId != null && createSelected.size > 0) {
        const r = await bulkCreateTasks({
          project_id: projectId,
          sample_ids: [...createSelected],
          task_type: createTaskType,
          infer_mode: createTaskType === "ai_assisted" ? createInferMode : null,
          assigned_to: createAssignee ?? undefined,
        });
        message.success(
          `已导入 ${r.created} 个任务${createTaskType === "ai_assisted" ? "，AI 预标注已在后台开始，进度在项目行里看" : ""}`,
          6
        );
        if (createTaskType === "ai_assisted") setTimeout(() => pollPrelabel([projectId!]), 800);
      }
      setOpen(false);
      form.resetFields();
      refresh();
    } finally {
      setCreating(false);
    }
  };

  // 按日期分组的样本勾选器：新建项目和批量导入共用一套
  const renderSamplePicker = (
    selected: Set<number>,
    setSelected: (updater: (prev: Set<number>) => Set<number>) => void,
    importedIds: Set<number>
  ) => (
    <Collapse
      size="small"
      items={samplesByDate.map(([date, dateSamples]) => {
        const selectable = (dateSamples ?? []).filter((s) => !importedIds.has(s.id));
        const selectedCount = selectable.filter((s) => selected.has(s.id)).length;
        const allSelected = selectable.length > 0 && selectedCount === selectable.length;
        return {
          key: date,
          label: (
            <Space onClick={(e) => e.stopPropagation()}>
              <Checkbox
                indeterminate={selectedCount > 0 && !allSelected}
                checked={allSelected}
                disabled={selectable.length === 0}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    for (const s of selectable) {
                      if (e.target.checked) next.add(s.id);
                      else next.delete(s.id);
                    }
                    return next;
                  })
                }
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
                const imported = importedIds.has(s.id);
                return (
                  <Checkbox
                    key={s.id}
                    disabled={imported}
                    checked={selected.has(s.id)}
                    onChange={(e) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(s.id);
                        else next.delete(s.id);
                        return next;
                      })
                    }
                  >
                    {s.sample_code}
                    {s.is_sensitive && <Tag color="red" style={{ marginLeft: 6 }}>敏感</Tag>}
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
  );

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
  // 非管理员拿不到 /users、/samples，优先用任务列表接口自带的 assigned_to_name / sample_code
  const userName = (id: number | null) => {
    if (id == null) return null;
    const fromTask = allTasks?.find((t) => t.assigned_to === id)?.assigned_to_name;
    if (fromTask) return fromTask;
    const u = users?.find((x) => x.id === id);
    return u ? u.display_name || u.username : `#${id}`;
  };
  const sampleCode = (id: number) =>
    samples?.find((s) => s.id === id)?.sample_code ?? allTasks?.find((t) => t.sample_id === id)?.sample_code ?? id;
  const durationOf = (id: number) =>
    samples?.find((s) => s.id === id)?.video_duration_sec ?? allTasks?.find((t) => t.sample_id === id)?.video_duration_sec ?? null;
  // 超级管理员看原始编号，其他人看"哪天 几点~几点"
  const sampleName = (id: number) => sampleDisplayName(String(sampleCode(id)), durationOf(id), role);
  // CSV 行数 0 = 空文件；null 是导入时没统计到，不当成"没数据"
  const noCsv = (t: Task) => {
    const n = t.imu_row_count ?? samples?.find((s) => s.id === t.sample_id)?.imu_row_count;
    return n === 0;
  };

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

  const handleBulkImport = async () => {
    if (!bulkForProject || bulkSelected.size === 0) return;
    setBulkSubmitting(true);
    try {
      const r = await bulkCreateTasks({
        project_id: bulkForProject.id,
        sample_ids: [...bulkSelected],
        task_type: bulkTaskType,
        infer_mode: bulkTaskType === "ai_assisted" ? createInferMode : null,
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

  // 某个任务在指定类别（不传=全部类别）上一共有多少段，"片段"列排序用
  const segCount = (t: Task, labelIds: number[]) => {
    const lc = t.label_counts ?? {};
    const ids = labelIds.length ? labelIds : Object.keys(lc).map(Number);
    return ids.reduce((sum, id) => sum + (lc[id]?.n ?? 0), 0);
  };

  const statusSummary = (projectId: number) => {
    const counts: Partial<Record<TaskStatus, number>> = {};
    for (const t of tasksOf(projectId)) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return counts;
  };

  // 项目下这些任务都指派给谁了
  const roleOf = (id: number | null) =>
    id == null ? null : allTasks?.find((t) => t.assigned_to === id)?.assigned_to_role ?? users?.find((u) => u.id === id)?.role ?? null;
  const assigneeSummary = (projectId: number) => {
    const ids = new Set(tasksOf(projectId).map((t) => t.assigned_to));
    const named = [...ids].filter((i): i is number => i != null).map((i) => ({ id: i, name: userName(i) ?? `#${i}`, role: roleOf(i) }));
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

      <ResizableTable
        storageKey="projects"
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
            const matchLabels = (t: Task) => {
              const lc = t.label_counts ?? {};
              if (f.aiPending && !Object.values(lc).some((c) => c.ai_pending > 0)) return false;
              if (f.labels.length && !f.labels.some((id) => (lc[id]?.n ?? 0) > 0)) return false;
              return true;
            };
            // imu 目录：按样本编号的 _imu{N} 后缀分，一个 imu 对应一只狗，先选目录再看任务
            const imuCounts = new Map<string, number>();
            for (const t of all) {
              const k = imuOf(String(sampleCode(t.sample_id)));
              imuCounts.set(k, (imuCounts.get(k) ?? 0) + 1);
            }
            const matchImu = (t: Task) => f.imu === "ALL" || imuOf(String(sampleCode(t.sample_id))) === f.imu;
            const noCsvTasks = all.filter(noCsv);
            const rows = all.filter(
              (t) =>
                matchImu(t) &&
                (!f.noCsv || noCsv(t)) &&
                matchStatus(t) &&
                matchLabels(t) &&
                (!q || String(sampleCode(t.sample_id)).toLowerCase().includes(q) || sampleName(t.sample_id).includes(q) || String(t.id) === q)
            );
            // 项目级各类别汇总：多少段、分布在多少个任务里、多少段还是 AI 待确认——点一下就按这个类别筛
            const projLabels = labelsOf(p.id);
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
                {isAdmin && noCsvTasks.length > 0 && (
                  <>
                    <Checkbox checked={f.noCsv} onChange={(e) => setFilter(p.id, { noCsv: e.target.checked })}>
                      <span style={{ color: "#ff4d4f" }}>无 CSV 数据 {noCsvTasks.length}</span>
                    </Checkbox>
                    <Popconfirm
                      title={`删除这 ${noCsvTasks.length} 个无 CSV 数据的任务？`}
                      description="这些任务的 IMU 文件是空的，打开就报「CSV 没有数据行」，没法标；会一并删掉草稿和审核记录，不可恢复"
                      okButtonProps={{ danger: true }}
                      onConfirm={async () => {
                        const r = await deleteTasksBatch(noCsvTasks.map((t) => t.id));
                        message.success(`已删除 ${r.count} 个任务`);
                        setFilter(p.id, { noCsv: false });
                        refresh();
                      }}
                    >
                      <Button size="small" danger>
                        删除无 CSV 任务
                      </Button>
                    </Popconfirm>
                  </>
                )}
                {(f.status !== "ALL" || q || f.labels.length > 0 || f.aiPending || f.imu !== "ALL" || f.noCsv) && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    筛出 {rows.length} 个
                  </Typography.Text>
                )}
              </Space>
              {labelTotals.length > 0 && (
                // 各类别在这个项目里总共有多少段/在几个任务里，点一个 Tag 就只看含这个类别的任务
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
                storageKey="project-tasks"
                size="small"
                rowKey="id"
                dataSource={rows}
                pagination={rows.length > 10 ? { pageSize: 10, showSizeChanger: true } : false}
                // 只在升/降之间切，不要 antd 默认第三档"取消排序"（看着像乱序）
                sortDirections={["ascend", "descend", "ascend"]}
                locale={{ emptyText: all.length ? "没有符合筛选条件的任务" : "这个项目下还没有任务" }}
                columns={[
                  { title: "任务ID", dataIndex: "id", width: 80, sorter: (a: Task, b: Task) => a.id - b.id },
                  {
                    title: "样本",
                    dataIndex: "sample_id",
                    // 样本编号里带采集时间，按字符串排就是按采集时间排；默认升序
                    sorter: (a: Task, b: Task) => String(sampleCode(a.sample_id)).localeCompare(String(sampleCode(b.sample_id))),
                    defaultSortOrder: "ascend" as const,
                    render: (id: number, task: Task) => {
                      const s = samples?.find((x) => x.id === id);
                      return (
                        <Space size={4}>
                          <Tooltip title={String(sampleCode(id))}>
                            <span>{sampleName(id)}</span>
                          </Tooltip>
                          {noCsv(task) && (
                            <Tooltip title="IMU CSV 文件是空的，打开工作台会报「CSV 没有数据行」，没法标注，建议删除">
                              <Tag color="red" style={{ marginRight: 0 }}>无CSV</Tag>
                            </Tooltip>
                          )}
                          {s?.is_sensitive && (
                            <Tooltip title={`含敏感隐私信息，只有管理员能看能标${s.sensitive_note ? `：${s.sensitive_note}` : ""}`}>
                              <Tag color="red" style={{ marginRight: 0 }}>敏感</Tag>
                            </Tooltip>
                          )}
                        </Space>
                      );
                    },
                  },
                  {
                    title: "总时长",
                    width: 110,
                    // 按时长排，想先挑短的就点一下
                    sorter: (a: Task, b: Task) => (durationOf(a.sample_id) ?? 0) - (durationOf(b.sample_id) ?? 0),
                    render: (_: unknown, task: Task) => formatDuration(durationOf(task.sample_id)),
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
                    // 选了"含类别"就按选中类别的段数排（想看抓挠最多/最少的任务），
                    // 没选就按总段数排；点表头切换升序/降序
                    title: f.labels.length
                      ? `片段（按${f.labels.map((id) => projLabels.find((l) => l.id === id)?.display_name ?? id).join("+")}排序）`
                      : "片段",
                    width: 260,
                    sorter: (a: Task, b: Task) => segCount(a, f.labels) - segCount(b, f.labels),
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
                    render: (id: number | null) =>
                      id == null ? <Typography.Text type="secondary">未指派</Typography.Text> : <UserTag name={userName(id) ?? `#${id}`} role={roleOf(id)} me={id === userId} />,
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
          { title: "ID", dataIndex: "id", width: 60, sorter: (a: Project, b: Project) => a.id - b.id },
          {
            title: "项目名",
            key: "name",
            width: 160,
            ellipsis: true,
            // 项目名就是日期，按名字排 = 按日期排
            sorter: (a: Project, b: Project) => a.name.localeCompare(b.name),
            sortDirections: ["descend", "ascend", "descend"],
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
                // 进度块单独占一行，别跟"共 N"和状态 Tag 混在同一个 wrap 的 Space 里
                // ——混在一起时"共 N"会被挤到进度条右边，看着像显示错了
                <div>
                  {pp?.status === "running" && (
                    <Tooltip
                      title={`${pp.current_sample_code ?? ""}
成功 ${pp.succeeded} · 跳过 ${pp.skipped} · 失败 ${pp.failed} · 等 AI 共 ${fmtClock(pp.ai_wait_sec)}`}
                    >
                      <div style={{ marginBottom: 4 }} onClick={(e) => e.stopPropagation()}>
                        <Progress
                          size="small"
                          status="active"
                          percent={pp.total ? Math.round((pp.processed / pp.total) * 100) : 0}
                          format={() => `AI ${pp.processed}/${pp.total}`}
                        />
                        {/* 已用时长从 0 秒精确计，跑完就知道总共花了多久；剩余时间按已完成
                            速率估，第一批还没回来之前没有数据，先显示"预估中" */}
                        <Space size={4}>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            已用 {fmtClock(pp.elapsed_sec)} ·{" "}
                            {pp.estimated_remaining_sec != null ? `预计还需 ${fmtEta(pp.estimated_remaining_sec)}` : "预估中…"}
                          </Typography.Text>
                          {/* 一跑就是几十分钟，选错版本/挑错项目只能干等着实在难受。
                              已经发给 AI 的那一批撤不回来（中途停会留下写一半的草稿），
                              所以是"跑完这批就停"，几十秒内生效 */}
                          <Popconfirm
                            title="停止预标注？"
                            description="当前这一批跑完就停，已经写好的草稿保留；剩下没跑的任务下次再跑"
                            onConfirm={async () => {
                              await cancelProjectPrelabel(p.id);
                              message.success("正在停止，当前这一批跑完就停");
                            }}
                          >
                            <Button size="small" danger type="link" style={{ padding: 0 }}>
                              停止
                            </Button>
                          </Popconfirm>
                        </Space>
                      </div>
                    </Tooltip>
                  )}
                  {pp?.status === "done" && pp.total > 0 && (
                    // 上一次的总耗时一直留在这里（后端重启后从 audit_logs 取），不用点开弹窗找
                    <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 2 }}>
                      上次 AI 预标注：{pp.succeeded} 个，总耗时 {fmtClock(pp.elapsed_sec)}
                      {pp.finished_at != null && `（${new Date(pp.finished_at * 1000).toLocaleString("zh-CN", { hour12: false })}）`}
                    </Typography.Text>
                  )}
                <Space size={4} wrap>
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
                </div>
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
                    <UserTag key={n.id} name={n.name} role={n.role} me={n.id === userId} />
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
        // 里面有版本选择 + 一张历史记录表，默认 520 宽两边都挤
        width={880}
        destroyOnClose
      >
        {prelabelTarget && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              会对这个项目里 <b>待认领 / 标注中</b> 且还没有人动过的任务逐个调用 AI 模型，把预测出来的行为片段
              直接写进任务草稿。标注员打开任务时就已经有 AI 框了，只需要确认或纠正。
              已提交、已通过、被驳回、以及已经有人工标注的任务不会被碰。
            </Typography.Paragraph>
            {/* 三个按钮挤在一行文字旁边会被压得换行；Segmented 是一整条，
                自己占一行，说明另起一行 */}
            <div>
              <Typography.Text style={{ marginRight: 8 }}>版本：</Typography.Text>
              <Segmented
                size="small"
                value={prelabelMode}
                onChange={(v) => {
                  setPrelabelMode(v as InferMode);
                  saveText(PRELABEL_MODE_KEY, String(v));
                }}
                options={INFER_MODE_OPTIONS}
              />
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {INFER_MODE_HINT[prelabelMode]}
            </Typography.Text>
            <Checkbox
              checked={prelabelOverwrite}
              onChange={(e) => {
                setPrelabelOverwrite(e.target.checked);
                saveBool(PRELABEL_OVERWRITE_KEY, e.target.checked);
              }}
            >
              连已经有 AI 片段的任务也重跑，用新结果<b>覆盖</b>旧的
            </Checkbox>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              不勾：已经有 AI 片段的任务直接跳过（只跑还没跑过的），换模型想刷新就得勾上。
              两种情况下<b>有人改过/确认过/标了待定的任务都不会被碰</b>——那是复看的成果。
            </Typography.Text>
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
                    上一次/当前：
                    {pp.status === "running"
                      ? "进行中"
                      : pp.status === "done"
                        ? "已完成"
                        : pp.status === "cancelled"
                          ? "已停止（剩下的没跑）"
                          : "出错"}
                    ，
                    {pp.processed}/{pp.total}，成功 {pp.succeeded}，跳过 {pp.skipped}，失败 {pp.failed}，
                    {pp.status === "running" ? "已用" : "总耗时"} {fmtClock(pp.elapsed_sec)}（其中等 AI {fmtClock(pp.ai_wait_sec)}）
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
            {prelabelHistory.length > 0 && (
              <div>
                <Typography.Text strong style={{ fontSize: 12 }}>
                  历史运行记录（每次跑完记一条，觉得慢了拿这些数字反馈）
                </Typography.Text>
                <Table
                  size="small"
                  rowKey="id"
                  pagination={false}
                  dataSource={prelabelHistory}
                  style={{ marginTop: 4 }}
                  columns={[
                    {
                      title: "时间",
                      width: 130,
                      render: (_, r: PrelabelRun) => (r.finished_at ? new Date(r.finished_at).toLocaleString("zh-CN", { hour12: false }) : "-"),
                    },
                    {
                      title: "数量",
                      width: 120,
                      render: (_, r: PrelabelRun) => (
                        <span>
                          {r.succeeded}
                          <span style={{ color: "#999" }}>
                            {" "}
                            / 跳过 {r.skipped} / 失败 {r.failed}
                          </span>
                        </span>
                      ),
                    },
                    {
                      title: "版本 / 模型",
                      width: 190,
                      // 换了模型重跑之后，两行数字差很多得说得清是模型变了还是数据变了
                      render: (_, r: PrelabelRun) =>
                        r.mode || r.model_path ? (
                          <Space size={4}>
                            {r.mode && <Tag>{INFER_MODE_LABEL[r.mode] ?? r.mode}</Tag>}
                            {r.model_path && (
                              <Tooltip title={r.model_path}>
                                <span style={{ color: "#999", fontSize: 12 }}>
                                  {r.model_path.split("/").slice(-1)[0]}
                                </span>
                              </Tooltip>
                            )}
                          </Space>
                        ) : (
                          <span style={{ color: "#999" }}>—</span>
                        ),
                    },
                    { title: "总耗时", width: 80, render: (_, r: PrelabelRun) => fmtClock(r.elapsed_sec) },
                    { title: "等 AI", width: 80, render: (_, r: PrelabelRun) => fmtClock(r.ai_wait_sec) },
                    {
                      title: "平均/个",
                      width: 80,
                      render: (_, r: PrelabelRun) => (r.avg_sec_per_task != null ? `${r.avg_sec_per_task}s` : "-"),
                    },
                    {
                      title: "结果",
                      render: (_, r: PrelabelRun) =>
                        r.status === "done" ? <Tag color="green">完成</Tag> : <Tag color="red">{r.error_message || "出错"}</Tag>,
                    },
                  ]}
                />
              </div>
            )}
          </Space>
        )}
      </Modal>

      <Modal
        title={editing ? `编辑项目 - ${editing.name}` : "新建项目"}
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={editing ? 520 : 680}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          {!editing && (
            <Form.Item
              label={
                <Space>
                  <span>要标的样本</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    已选 {createSelected.size} 个；不选也能建空项目，之后再「批量导入」
                  </Typography.Text>
                </Space>
              }
            >
              <div style={{ maxHeight: 260, overflow: "auto" }}>
                {renderSamplePicker(createSelected, updateCreateSelected, new Set())}
              </div>
            </Form.Item>
          )}
          <Form.Item
            name="name"
            label="项目名"
            rules={[{ required: true }]}
            extra={!editing && nameAuto ? "默认用选中样本的日期目录名，可以改" : undefined}
          >
            <Input
              placeholder={editing ? undefined : "先勾样本会自动填成日期，或自己起名"}
              onChange={() => setNameAuto(false)}
            />
          </Form.Item>
          {!editing && (
            <Form.Item label="标注模式 / 指派">
              <Space wrap>
                <Select
                  style={{ width: 300 }}
                  value={createTaskType}
                  onChange={setCreateTaskType}
                  options={[
                    { value: "ai_assisted", label: "AI预标注+人工修改（建好后自动跑 AI）" },
                    { value: "from_scratch", label: "从零标注" },
                  ]}
                />
                {createTaskType === "ai_assisted" && (
                  <Select style={{ width: 130 }} value={createInferMode} onChange={(v) => { setCreateInferMode(v); saveText(CREATE_MODE_KEY, v); }} options={INFER_MODE_OPTIONS} title={INFER_MODE_HINT[createInferMode]} />
                )}
                <Select
                  style={{ width: 200 }}
                  allowClear
                  placeholder="指派给（留空进公共池）"
                  value={createAssignee ?? undefined}
                  onChange={(v) => setCreateAssignee(v ?? null)}
                  options={users
                    ?.filter((u) => u.is_active)
                    .map((u) => ({ value: u.id, label: u.display_name || u.username }))}
                  showSearch
                  optionFilterProp="label"
                />
              </Space>
            </Form.Item>
          )}
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
          <Button type="primary" htmlType="submit" block loading={creating}>
            {editing
              ? "保存"
              : createSelected.size > 0
                ? `创建项目并导入 ${createSelected.size} 个任务${createTaskType === "ai_assisted" ? "（自动 AI 预标注）" : ""}`
                : "创建空项目"}
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
              ?.filter((u) => u.is_active)
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
          {bulkTaskType === "ai_assisted" && (
            <Select style={{ width: 130 }} value={createInferMode} onChange={(v) => { setCreateInferMode(v); saveText(CREATE_MODE_KEY, v); }} options={INFER_MODE_OPTIONS} title={INFER_MODE_HINT[createInferMode]} />
          )}
          <Typography.Text>指派给</Typography.Text>
          <Select
            style={{ width: 160 }}
            allowClear
            placeholder="不指派（进公共池）"
            value={bulkAssignee ?? undefined}
            onChange={(v) => setBulkAssignee(v ?? null)}
            options={users
              ?.filter((u) => u.is_active)
              .map((u) => ({ value: u.id, label: u.display_name || u.username }))}
          />
        </Space>
        {renderSamplePicker(bulkSelected, setBulkSelected, alreadyImportedIds)}
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
