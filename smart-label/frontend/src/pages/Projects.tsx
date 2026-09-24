import { useEffect, useMemo, useRef, useState } from "react";
import InferModeHelp from "@/components/InferModeHelp";
import { currentName, descendantIds } from "@/utils/labelTree";
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Radio,
  Segmented,
  Select,
  Space,
  Spin,
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
  splitProjectByDate,
  unsplitProject,
  getProjectPrelabelHistory,
  cancelProjectPrelabel,
  getProjectPrelabelStatus,
  getCamSlots,
  getProjectLabelTemplate,
  getCandidateSources,
  purgeCandidates,
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
import { defaultTemplateId } from "@/utils/defaultTemplate";
import { usePersistedSort } from "@/utils/persistedSort";
import { useResizableColumns } from "@/utils/resizableColumns";
import { listLabels } from "@/api/labels";
import SeekReviewGrid from "@/components/SeekReviewGrid";
import ProjectPhraseSearch from "@/components/ProjectPhraseSearch";
import { applyLabelTemplate, listLabelTemplates } from "@/api/labelTemplates";
import { listSamples } from "@/api/samples";
import { listUsers } from "@/api/users";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import ResizableTable from "@/components/ResizableTable";
import { useAuthStore } from "@/stores/authStore";
import { imuOf, sortImuKeys } from "@/utils/imuOf";
import { formatDuration, sampleDisplayName } from "@/utils/sampleName";
import { UserTag } from "@/utils/roleTag";
import { hintOf, modeLabelOf, type InferMode } from "@/utils/inferMode";
import { INFER_SELECT_PROPS, useInferModes } from "@/hooks/useInferModes";

// 上次用的预标注版本：用惯哪个就默认哪个，省得每次重选
const PRELABEL_MODE_KEY = "smart-label:prelabel-mode";
const CREATE_MODE_KEY = "smart-label:create-infer-mode";
// 新建项目时上次选的标签模板：一段时间里建的项目基本都套同一个模板，
// 每次都要从下拉里重新找一遍很烦。存 "none" 表示上次是特意清掉不套的。
const CREATE_TEMPLATE_KEY = "smart-label:create-template-id";
// 大模型看视频找动作上次用的哪家哪个模型，"provider|model"
const SEEK_LLM_KEY = "smart-label:seek-llm";

// 「连已经有 AI 片段的也重跑」也记住：换了模型想全量刷新时，每个项目都要重勾
// 一遍太烦，而这个选择在一轮刷新里通常是一致的
const PRELABEL_OVERWRITE_KEY = "smart-label:prelabel-overwrite";
// 没选过时的默认版本。稳定版 v2 是现在实际在用的那个
const DEFAULT_INFER_MODE: InferMode = "viterbi";
import { useUrlTask } from "@/utils/urlTask";
import { listLlmProviders } from "@/api/llmProviders";
import {
  cancelVisionIndex,
  getVisionIndexStatus,
  pauseVisionIndex,
  resumeVisionIndex,
  startVisionIndex,
  type VisionIndexProgress,
} from "@/api/projects";
import {
  cancelVisionSeek,
  pauseVisionSeek,
  resumeVisionSeek,
  getVisionSeekStatus,
  startVisionSeek,
  getVisionSeekFound,
  type SeekFound,
  type VisionSeekProgress,
} from "@/api/projects";
import { ROLE_META, TASK_STATUS_META, TASK_TYPE_LABEL, TaskStatusTag } from "@/utils/taskStatus";
import type { LabelDefinition, Project, Task, TaskStatus } from "@/types";

interface FormValues {
  name: string;
  description?: string;
  templateId?: number;
}

/** 这一轮的产出该报哪个数。
 *
 * **「先筛一遍再写」模式下候选恒等于 0**——那个模式本来就不写库，段都攒在
 * found 里等人筛。照搬 candidates 等于给人一个永远是 0 的数字，看着就像
 * "跑了很多遍全是 0、模型坏了"，而真正的产出在旁边那个「筛一筛 N 段」上。
 */
const seekYield = (sp: { review?: boolean; found?: number; candidates: number }): string =>
  sp.review ? `找到 ${sp.found ?? 0} 段待筛（这个模式不直接写候选）` : `得 ${sp.candidates} 条候选`;

/** 模型这一批是怎么答的，写成一句人话。
 *  只报「得 0 条候选」的话，四种完全不同的原因长得一模一样（见 ans_* 的注释）。 */
const answerNote = (sp: { clips_sent: number; ans_label?: number; ans_unclear?: number;
                          ans_lowconf?: number; ans_error?: number }): string => {
  const sent = sp.clips_sent || 0;
  if (!sent) return "";
  const label = sp.ans_label ?? 0, unclear = sp.ans_unclear ?? 0;
  const low = sp.ans_lowconf ?? 0, err = sp.ans_error ?? 0;
  if (!label && !unclear && !low && !err) return "";      // 老数据没有这几个数
  const none = Math.max(0, sent - label - unclear - err);
  const bits: string[] = [];
  if (none) bits.push(`判 none ${none}`);
  if (unclear) bits.push(`看不清 ${unclear}`);
  if (low) bits.push(`判出来但没过置信度线 ${low}`);
  if (err) bits.push(`失败 ${err}`);
  return bits.length ? `（${bits.join("、")}）` : "";
};

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
  // cand：只看还有「疑似抓挠」待判断的任务。它跟 labels 是两回事——候选不在片段里，
  // 一个"抓挠 0 段"的任务照样可能压着十几条候选，光看类别筛选会整个漏掉
  // candLabels：「疑似抓挠」里的二级筛选——只看某几类候选。选项只列**这批候选里
  // 实有的类别**，项目全量标签里大半是一条候选都没有的，摆出来只是让人一个个试
  type TaskFilter = { status: StatusFilter; q: string; labels: number[]; aiPending: boolean; cand: boolean; candLabels: string[]; imu: string; noCsv: boolean };
  const [taskFilters, setTaskFilters] = useState<Record<number, TaskFilter>>({});
  const [expandedKeys, setExpandedKeys] = useState<number[]>([]);
  const filterOf = (projectId: number): TaskFilter =>
    taskFilters[projectId] ?? { status: "ALL" as const, q: "", labels: [], aiPending: false, cand: false, candLabels: [], imu: "ALL", noCsv: false };
  const setFilter = (projectId: number, patch: Partial<TaskFilter>) =>
    setTaskFilters((prev) => ({ ...prev, [projectId]: { ...filterOf(projectId), ...patch } }));
  const [workspaceReadOnly, setWorkspaceReadOnly] = useState(false);
  // 打开工作台时带过去的类别筛选，见 openWorkspace
  const [workspaceFocusLabels, setWorkspaceFocusLabels] = useState<number[]>([]);
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
  // 版本下拉的选项（线上 + 端侧）。端侧有哪几个是问服务拿的，不写死
  const { options: inferOptions, edgeOffline } = useInferModes();
  const [createInferMode, setCreateInferMode] = useState<InferMode>(
    () => (getSavedText(CREATE_MODE_KEY, DEFAULT_INFER_MODE) as InferMode)
  );
  const [prelabelStarting, setPrelabelStarting] = useState(false);
  const [prelabelProgress, setPrelabelProgress] = useState<Record<number, PrelabelProgress>>({});
  // 大模型看视频找动作：视觉大模型（API）看视频挑出像舔/啃/抓/蹭的几秒，写成候选给人确认
  const [seekTarget, setSeekTarget] = useState<Project | null>(null);
  const [seekProgress, setSeekProgress] = useState<Record<number, VisionSeekProgress>>({});
  const [seekLabels, setSeekLabels] = useState<string[]>([]);
  // 部位问到多细。层级标签上线后「啃」底下有 37 条子孙，全送过去 prompt 又长、模型在几十个
  // 选项里也挑不准（几帧俯拍根本分不出左右）。默认到「具体部位」这一层
  const [seekPartDepth, setSeekPartDepth] = useState(2);
  // 默认跑「全部机位」：一只狗常常两三路都有，只跑一个槽位等于凭空扔掉别的角度，
  // 而槽位编号本身又不是机位号（见 camSlots），让人去猜该选哪个是不合理的
  const [seekCam, setSeekCam] = useState<"cam1" | "cam2" | "cam3" | "all">("all");
  const [seekMaxClips, setSeekMaxClips] = useState(120);
  const [seekLimit, setSeekLimit] = useState<number | null>(null);
  // 默认**直接跑**，不是先试算。试算只回答"这一批要花多少钱"，它没有结果可看，
  // 而默认勾着它的后果是：人点了「开始」，等半天，回来发现什么都没有。
  // 想知道花费的时候再勾——跑完有「先筛一遍再写」兜着，写不写还是人说了算
  // 界面上不再有这个勾（本地模型不花钱，试算没意义，跑完还没结果）。
  // 常量 false：请求体那一项保持原样，接口不用改
  const seekDryRun = false;
  // 先筛一遍再写：跑完不直接写候选，把找到的段摆成一屏让人勾。默认开——
  // 模型一次能出几千段，错的直接进候选列表的话，人得跨几十个任务一条条排除
  const [seekReview, setSeekReview] = useState(true);
  // 筛选那一屏
  const [reviewOpen, setReviewOpen] = useState<number | null>(null);
  const [phraseTarget, setPhraseTarget] = useState<Project | null>(null);
  // 按来源清理画面候选：一轮搜坏了，不用为它删掉整个项目
  // cam1/cam2/cam3 这三个槽位各装了什么（按真实路径数出来的）。
  // 那不是机位号——狗场的「cam2」往往是天花板公共区，影棚的「cam2」只是另一个角度，
  // 光写 cam1/cam2/cam3 让人以为是同一回事，选错了找到的狗对不上这条 IMU
  const [camSlots, setCamSlots] = useState<Awaited<ReturnType<typeof getCamSlots>> | null>(null);
  // 只跑这几处「场地·机位」。空 = 不限。
  // **人脑子里的单位是「影棚」「狗场2 的 cam4」，不是"第几个槽位"**——槽位是导入时
  // 的装箱顺序，影棚和狗场恰好都被塞进第 1 个，于是"选 cam1"等于两处一起跑
  const [seekScopes, setSeekScopes] = useState<string[]>([]);
  const [purgeTarget, setPurgeTarget] = useState<Project | null>(null);
  const [purgeSrc, setPurgeSrc] = useState<Awaited<ReturnType<typeof getCandidateSources>> | null>(null);
  const [purgeBusy, setPurgeBusy] = useState(false);
  // 默认不碰人已经判过的：已确认/已排除/待定是人的判断，删了就白判了
  const [purgeDecided, setPurgeDecided] = useState(false);
  const loadPurge = async (id: number) => {
    setPurgeSrc(null);
    setPurgeSrc(await getCandidateSources(id));
  };
  const openPurge = (p: Project) => {
    setPurgeTarget(p);
    setPurgeDecided(false);
    loadPurge(p.id);
  };
  const [reviewFound, setReviewFound] = useState<SeekFound[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const openReview = async (pid: number) => {
    setReviewOpen(pid);
    setReviewLoading(true);
    try {
      setReviewFound((await getVisionSeekFound(pid)).found);
    } finally {
      setReviewLoading(false);
    }
  };
  const [seekLlm, setSeekLlm] = useState<string>(() => getSavedText(SEEK_LLM_KEY, ""));
  const { data: llmProviders } = useQuery({ queryKey: ["llm-providers"], queryFn: listLlmProviders, enabled: isAdmin });
  const [seekStarting, setSeekStarting] = useState(false);
  const seekPrevRef = useRef<Record<number, string>>({});
  // 画面向量索引：建一次，之后工作台里「找相似」免费瞬间
  const [indexTarget, setIndexTarget] = useState<Project | null>(null);
  // 档位：fast 只解关键帧（这批素材约 12 秒一帧，全量几分钟），fine 每秒一帧（一路十几秒）。
  // 默认 fast：第一次建索引的人要的是"先能搜起来"，而不是等 40 分钟；
  // 精档留给"这几路我要认真扩样本"那一步，按需建
  const [indexMode, setIndexMode] = useState<"fine" | "fast">("fast");
  const [indexProgress, setIndexProgress] = useState<Record<number, VisionIndexProgress>>({});
  const [indexCam, setIndexCam] = useState<"all" | "cam1" | "cam2" | "cam3">("all");
  const [indexForce, setIndexForce] = useState(false);
  const [indexStarting, setIndexStarting] = useState(false);
  const indexPrevRef = useRef<Record<number, string>>({});
  const pollIndex = async (ids: number[]) => {
    const results = await Promise.all(ids.map((id) => getVisionIndexStatus(id).catch(() => null)));
    setIndexProgress((prev) => {
      const next = { ...prev };
      results.forEach((p, i) => {
        if (p) next[ids[i]] = p;
      });
      return next;
    });
    results.forEach((p, i) => {
      if (!p) return;
      const was = indexPrevRef.current[ids[i]];
      indexPrevRef.current[ids[i]] = p.status;
      if (was === "running" && p.status !== "running") {
        if (p.status === "done") message.success(`画面索引完成：新建 ${p.built} 路，已有 ${p.cached} 路，失败 ${p.failed} 路`, 6);
        else if (p.status === "error") message.error(`建索引出错：${p.error_message}`);
      }
    });
  };

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

  const pollSeek = async (ids: number[]) => {
    const results = await Promise.all(ids.map((id) => getVisionSeekStatus(id).catch(() => null)));
    setSeekProgress((prev) => {
      const next = { ...prev };
      results.forEach((p, i) => {
        if (p) next[ids[i]] = p;
      });
      return next;
    });
    results.forEach((p, i) => {
      if (!p) return;
      const id = ids[i];
      const was = seekPrevRef.current[id];
      seekPrevRef.current[id] = p.status;
      if (was === "running" && p.status !== "running") {
        if (p.status === "done") {
          message.success(
            p.dry_run
              ? `预览完成：${p.succeeded} 个任务，本地筛出 ${p.clips_candidate} 段会送去问模型（没花钱）`
              : `大模型看视频找动作完成：${p.succeeded} 个任务，送 ${p.clips_sent} 段，${seekYield(p)}${answerNote(p)}，约 $${p.est_usd}`,
            8
          );
        } else if (p.status === "error") {
          message.error(`大模型看视频找动作出错：${p.error_message}`);
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
    pollSeek(projectIds.split(",").map(Number));
    pollIndex(projectIds.split(",").map(Number));
  }, [projectIds]);
  const indexRunningIds = Object.values(indexProgress)
    .filter((p) => p.status === "running" || p.status === "paused")
    .map((p) => p.project_id)
    .join(",");
  useEffect(() => {
    if (!indexRunningIds) return;
    const timer = setInterval(() => pollIndex(indexRunningIds.split(",").map(Number)), 3000);
    return () => clearInterval(timer);
  }, [indexRunningIds]);
  const seekRunningIds = Object.values(seekProgress)
    .filter((p) => p.status === "running")
    .map((p) => p.project_id)
    .join(",");
  useEffect(() => {
    if (!seekRunningIds) return;
    const timer = setInterval(() => pollSeek(seekRunningIds.split(",").map(Number)), 3000);
    return () => clearInterval(timer);
  }, [seekRunningIds]);
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

  // 大模型看视频找动作只认这四个父类（vision_service 有它们的一句话描述），部位子标签自动带上
  const SEEK_GROUPS = ["舔身体", "啃身体", "抓挠", "蹭身体"];
  const seekableLabels = (projectId: number) =>
    SEEK_GROUPS.filter((n) => (allLabels ?? []).some((l) => l.project_id === projectId && l.is_active && l.display_name === n));
  const seekEligible = (projectId: number) =>
    tasksOf(projectId).filter((t) => t.status === "PENDING_ASSIGN" || t.status === "IN_PROGRESS");
  const openSeek = (p: Project) => {
    setSeekLabels(seekableLabels(p.id));
    setSeekLimit(null);
    setSeekTarget(p);
    // 三个槽位各装了什么，要按这个项目的真实路径数出来才知道——写死 cam1/cam2/cam3
    // 只会让人以为那是机位号。数不出来就保持原样，别把整个对话框卡住
    setCamSlots(null);
    setSeekScopes([]);
    getCamSlots(p.id).then(setCamSlots).catch(() => setCamSlots(null));
    pollSeek([p.id]);
  };
  const handleStartSeek = async () => {
    if (!seekTarget) return;
    setSeekStarting(true);
    try {
      const eligible = seekEligible(seekTarget.id).map((t) => t.id);
      await startVisionSeek(seekTarget.id, {
        task_ids: seekLimit != null && seekLimit < eligible.length ? eligible.slice(0, seekLimit) : undefined,
        labels: seekLabels,
        part_depth: seekPartDepth,
        cam: seekCam,
        scopes: seekScopes,
        max_clips: seekMaxClips,
        dry_run: seekDryRun,
        review: seekReview,
        provider: seekLlm ? seekLlm.split("|")[0] : undefined,
        model: seekLlm ? seekLlm.split("|")[1] : undefined,
      });
      saveText(SEEK_LLM_KEY, seekLlm);
      message.info(seekDryRun
        ? "开始试算（只数会送多少段，不问模型、不花钱、没有结果），进度在项目行里看"
        : seekReview
          ? "已开始，进度在项目行里看。跑完先不写候选，回来点「筛一筛」过一眼再写"
          : "已开始，进度在项目行里看");
      await pollSeek([seekTarget.id]);
      setSeekTarget(null);
    } finally {
      setSeekStarting(false);
    }
  };

  // 新建项目一步到位：选样本 -> 建项目 -> 套标签模板 -> 批量建任务（可选 AI 预标注、
  // 指派）。项目名默认用选中样本的日期目录名，改过就不再自动覆盖。
  const [createSelected, setCreateSelected] = useState<Set<number>>(new Set());
  const [createTaskType, setCreateTaskType] = useState<"from_scratch" | "ai_assisted">("ai_assisted");
  const [createAssignee, setCreateAssignee] = useState<number | null>(null);
  const [nameAuto, setNameAuto] = useState(true);
  // 一次勾十几天的样本，然后每天各建一个项目。以前只能一天一天来：勾样本、
  // 起名、建、再重开弹窗——十几天就是十几遍同样的操作
  const [perDate, setPerDate] = useState(false);
  // 批量建的时候按钮上显示"第几天 / 共几天"，不然十几天下来只有一个转圈
  const [batchProgress, setBatchProgress] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({
      name: "",
      description: "",
      templateId: defaultTemplateId(getSavedText(CREATE_TEMPLATE_KEY, ""), templates?.map((t) => t.id) ?? []),
    });
    setCreateSelected(new Set());
    setCreateTaskType("ai_assisted");
    // 默认指派给自己（管理员/超管建项目大多是自己先调试），不想要就在下拉里清掉进公共池
    setCreateAssignee(isAdmin ? (userId ?? null) : null);
    setNameAuto(true);
    setPerDate(false);
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
      // 「每天各建一个」时名字由日期决定，别被这里的自动填名盖掉
      if (nameAuto && !perDate) form.setFieldsValue({ name: defaultNameFor(next) });
      return next;
    });
  };

  // 这个项目现在的标签是从哪来的。模板那一栏是「套用」动作，不是存着的字段，
  // 打开编辑框只看到一个空下拉，人根本不知道现在用的是哪个
  const [curTpl, setCurTpl] = useState<Awaited<ReturnType<typeof getProjectLabelTemplate>> | null>(null);
  const openEdit = (p: Project) => {
    setEditing(p);
    form.setFieldsValue({ name: p.name, description: p.description ?? "", templateId: undefined });
    setCurTpl(null);
    getProjectLabelTemplate(p.id).then(setCurTpl).catch(() => setCurTpl(null));
    setOpen(true);
  };

  const handleSubmit = async ({ templateId, ...values }: FormValues) => {
    setCreating(true);
    // 新建时记住这次选的模板（清掉了也记，下次就不默认套）；编辑项目那条路不算
    if (!editing) saveText(CREATE_TEMPLATE_KEY, templateId == null ? "none" : String(templateId));
    try {
      let projectId = editing?.id;
      // 每天一个项目：按样本的采集日期分组，一组建一个，名字就用那天的日期。
      // 中间某天失败（比如重名）不影响别的天，最后一起报
      if (!editing && perDate && createSelected.size > 0) {
        const byDate = new Map<string, number[]>();
        for (const smp of samples ?? []) {
          if (!createSelected.has(smp.id)) continue;
          const d = smp.session_date ?? "未知日期";
          byDate.set(d, [...(byDate.get(d) ?? []), smp.id]);
        }
        const entries = [...byDate.entries()].sort();
        const ids: number[] = [];
        const failed: string[] = [];
        let done = 0;
        const oneDay = async ([date, sampleIds]: [string, number[]]) => {
          try {
            const created = await createProject({ name: date, description: values.description });
            ids.push(created.id);
            if (templateId != null) await applyLabelTemplate(templateId, created.id);
            await bulkCreateTasks({
              project_id: created.id,
              sample_ids: sampleIds,
              task_type: createTaskType,
              infer_mode: createTaskType === "ai_assisted" ? createInferMode : null,
              assigned_to: createAssignee ?? undefined,
            });
          } catch (e) {
            failed.push(`${date}（${e instanceof Error ? e.message : String(e)}）`);
          } finally {
            done += 1;
            setBatchProgress(`正在建：${done} / ${entries.length} 天`);
          }
        };
        // 一天一天串着来，十几天就是十几个来回，每个还要插上千行任务，等得很久。
        // 并发几路一起跑；不开太多是怕一次几千行插入把库压住，反而更慢
        const CONCURRENCY = 4;
        setBatchProgress(`正在建：0 / ${entries.length} 天`);
        const queue = [...entries];
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
            for (;;) {
              const next = queue.shift();
              if (!next) return;
              await oneDay(next);
            }
          })
        );
        setBatchProgress(null);
        message.success(
          `已建 ${ids.length} 个项目${failed.length ? `，${failed.length} 天失败` : ""}` +
            (createTaskType === "ai_assisted" ? "，AI 预标注已在后台开始" : ""),
          6
        );
        if (failed.length) message.error(`没建成的：${failed.join("；")}`, 10);
        if (createTaskType === "ai_assisted" && ids.length) setTimeout(() => pollPrelabel(ids), 800);
        setOpen(false);
        form.resetFields();
        refresh();
        return;
      }
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
  // 排序记住：任务表常按「片段数 / 样本」排着找活干，切走再回来不用重排
  const taskSort = usePersistedSort("project-tasks-sort");
  // 外层项目表自己的排序记忆。里层任务表早就有了，外层一直没接——
  // 排一次"按项目名（= 日期）降序"，换个页面回来又变回默认，每次都得重排
  const projectSort = usePersistedSort("projects-sort");
  // 列宽也让人自己拖：「片段」那列内容长短差得远，写死一个宽度总有一头不合适
  const taskWidth = useResizableColumns("project-tasks-widths");
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
    // 列表这一层已经按类别筛过了（比如只看「抓挠」），带进工作台当片段列表的
    // 初始筛选——否则进去看到的是全部类别，还得在片段面板里把同一个筛选再点一遍，
    // 而一份任务动辄几十段，要找的那 3 段抓挠就淹在里面
    setWorkspaceFocusLabels(filterOf(projectId).labels);
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

  // 「片段」列的排序键。候选（疑似抓挠）不算片段，只按段数排的话，一个项目里
  // 全是"0 段 + N 条候选"的任务就全部并列，点表头看着毫无反应。所以段数相同再
  // 比待判断的候选数、再比候选总数；点了「疑似抓挠」筛选时候选优先。
  const segmentsOrder = (a: Task, b: Task, labelIds: number[], candFirst: boolean) => {
    const keys = (t: Task) => {
      const seg = segCount(t, labelIds);
      const pend = t.cand_pending ?? 0;
      const cand = t.cand_count ?? 0;
      return candFirst ? [pend, cand, seg] : [seg, pend, cand];
    };
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
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
        // 排序是人的看法，不是页面的初始状态——记住它，下次回来还按上次排的
        onChange={projectSort.onTableChange}
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

            // 选中的类别连同它们的子类：选「抓挠」= 抓挠 + 抓挠-头颈耳 + 抓挠-头颈耳-耳/耳后…
            const wantLabelIds = f.labels.length
              ? descendantIds(labelsOf(p.id), f.labels)
              : new Set<number>();
            const matchLabels = (t: Task) => {
              const lc = t.label_counts ?? {};
              if (f.aiPending && !Object.values(lc).some((c) => c.ai_pending > 0)) return false;
              if (f.cand && !(t.cand_pending ?? 0)) return false;
              // 「含类别」只认**片段**。曾经把候选也算进来过（为了让"一句话找画面
              // 刚写的候选"能被搜到），结果更糟：疑似抓挠的候选 label_name 就是
              // 「抓挠」，236 个任务全有，筛「抓挠」等于筛了大半个项目，
              // 「哪些任务有抓挠片段」这个问题反而问不出来了。
              // 候选按类别筛是旁边那个「候选类别」的活儿——两件事，两个控件。
              //
              // **选父类要连子类一起**（跟工作台里的片段筛选同一个口径）。
              // 不这样的话，把 30 段「抓挠」细标成「抓挠-头颈耳」之后，项目页筛
              // 「抓挠」就只剩没细标的那些——细标这件事本身会让段"消失"，
              // 而这恰恰是人正要去做的事
              if (f.labels.length && !wantLabelIds.size) return false;
              if (f.labels.length && ![...wantLabelIds].some((id) => (lc[id]?.n ?? 0) > 0)) return false;
              if (f.candLabels.length && !f.candLabels.some((name) => (t.cand_labels?.[name]?.n ?? 0) > 0)) return false;
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
            // 「疑似抓挠」候选跟上面那些类别并排显示。它不是一个 label，是另一张表，
            // 但对"这个项目还剩多少活"来说是同一个问题，分开放两处反而要人自己去合
            const candTotal = all.reduce((s, t) => s + (t.cand_count ?? 0), 0);
            const candPending = all.reduce((s, t) => s + (t.cand_pending ?? 0), 0);
            const candTasksN = all.filter((t) => (t.cand_count ?? 0) > 0).length;
            // 候选里实有哪些类别、各多少条：二级筛选的选项就是它，条数多的排前面
            const candLabelTotals = (() => {
              const m = new Map<string, { n: number; pending: number }>();
              for (const t of all) {
                for (const [name, c] of Object.entries(t.cand_labels ?? {})) {
                  const e = m.get(name) ?? { n: 0, pending: 0 };
                  e.n += c.n ?? 0;
                  e.pending += c.pending ?? 0;
                  m.set(name, e);
                }
              }
              return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
            })();
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
                <Tooltip title="按片段的类别筛。选父类连子类一起算——选「抓挠」也会带上「抓挠-头颈耳」，跟工作台里那个筛选同一个口径。候选（疑似抓挠）不在这里，走旁边的「候选类别」">
                  <Select
                    size="small"
                    mode="multiple"
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    placeholder="含类别（含子类）…"
                    style={{ minWidth: 180 }}
                    value={f.labels}
                    onChange={(v) => setFilter(p.id, { labels: v })}
                    options={projLabels.map((l) => ({ value: l.id, label: l.display_name }))}
                  />
                </Tooltip>
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
                {taskWidth.hasCustom && (
                  <Tooltip title="列宽是拖出来的，记在这台电脑上。拖乱了点这里回到默认">
                    <Button size="small" type="link" onClick={taskWidth.reset}>
                      恢复列宽
                    </Button>
                  </Tooltip>
                )}
                {(f.status !== "ALL" || q || f.labels.length > 0 || f.aiPending || f.cand || f.imu !== "ALL" || f.noCsv) && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    筛出 {rows.length} 个
                  </Typography.Text>
                )}
              </Space>
              {(labelTotals.length > 0 || candTotal > 0) && (
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
                  {candTotal > 0 && (
                    <Tooltip title={`${candTotal} 条疑似抓挠候选，分布在 ${candTasksN} 个任务里${candPending ? `，其中 ${candPending} 条还没判断` : "，都判断过了"}；点击只看还有待判断的任务`}>
                      <Tag
                        // 描边而不是实心：它跟左边那些实心的类别 Tag 不是一回事，
                        // 那些是已经成段的标注，这个是还没进片段的候选
                        color="magenta"
                        bordered
                        style={{
                          cursor: "pointer",
                          background: "transparent",
                          outline: f.cand ? "2px solid #1677ff" : undefined,
                        }}
                        onClick={() => setFilter(p.id, { cand: !f.cand })}
                      >
                        疑似抓挠 {candTotal}
                        {candPending ? <span style={{ opacity: 0.75 }}>（待判断 {candPending}）</span> : null}
                        <span style={{ opacity: 0.6 }}> · {candTasksN} 任务</span>
                      </Tag>
                    </Tooltip>
                  )}
                  {/* 疑似抓挠的二级筛选。选项**只列这批候选里实有的类别**——项目全量
                      标签里大半一条候选都没有，摆出来只能让人一个个试 */}
                  {candLabelTotals.length > 1 && (
                    <Tooltip title="只看含某几类候选的任务。列出来的就是「疑似抓挠」里实有的类别和条数，加起来等于候选总数">
                      <Select
                        size="small"
                        mode="multiple"
                        allowClear
                        // 不要 maxTagCount="responsive"：它靠量宽度决定收不收，
                        // 而这一行的宽度是弹的——标签全文显示就撑爆 → 收成「+1...」→
                        // 收完又放得下 → 再展开，一帧一个样地闪。固定宽度 + 固定收几个，
                        // 不量宽度就不会打架
                        maxTagCount={1}
                        placeholder="候选类别…"
                        style={{ width: 190 }}
                        value={f.candLabels}
                        onChange={(v) => setFilter(p.id, { candLabels: v })}
                        // 选中后标签里只留类别名：条数写进去就会撑长标签，
                        // 而条数是给人挑的时候看的，挑完了不用一直占着地方
                        optionLabelProp="title"
                        options={candLabelTotals.map(([name, c]) => ({
                          value: name,
                          title: currentName(name),
                          label: (
                            <span>
                              {currentName(name)}{" "}
                              <span style={{ color: "#999", fontSize: 12 }}>
                                {c.n}
                                {c.pending ? ` / 待判断 ${c.pending}` : ""}
                              </span>
                            </span>
                          ),
                        }))}
                      />
                    </Tooltip>
                  )}
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
                onChange={taskSort.onTableChange}
                components={taskWidth.components}
                tableLayout={taskWidth.tableLayout}
                // 拖出来的列宽要生效，表格得是固定布局——antd 靠 scroll.x 切过去
                scroll={{ x: "max-content" }}
                columns={taskWidth.applyResize<Task>(taskSort.applySort<Task>([
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
                    key: "duration",
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
                    // 标题会随「含类别」筛选变，不能拿它当 key——记住的排序会认不出来
                    key: "segments",
                    width: 260,
                    sorter: (a: Task, b: Task) => segmentsOrder(a, b, f.labels, f.cand),
                    sortDirections: ["descend", "ascend", "descend"],
                    render: (_, task: Task) => {
                      const lc = task.label_counts ?? {};
                      const entries = projLabels.filter((l) => (lc[l.id]?.n ?? 0) > 0);
                      const candN = task.cand_count ?? 0;
                      if (!entries.length && !candN) return <Typography.Text type="secondary">-</Typography.Text>;
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
                          {candN > 0 && (
                            <Tooltip
                              title={
                                (task.cand_pending ?? 0)
                                  ? `${candN} 条疑似抓挠候选，其中 ${task.cand_pending} 条还没判断——它们不算片段，打开工作台在「疑似抓挠」里逐条确认或排除`
                                  : `${candN} 条疑似抓挠候选，都判断过了`
                              }
                            >
                              <Tag color="magenta" bordered style={{ marginRight: 0, background: "transparent" }}>
                                疑似抓挠 {candN}
                                {(task.cand_pending ?? 0) ? <span style={{ opacity: 0.7 }}>/{task.cand_pending}待判断</span> : null}
                              </Tag>
                            </Tooltip>
                          )}
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
                ]))}
              />
              </>
            );
          },
        }}
        columns={projectSort.applySort<Project>([
          { title: "ID", dataIndex: "id", width: 60, sorter: (a: Project, b: Project) => a.id - b.id },
          {
            title: "项目名",
            key: "name",
            width: 230,   // 说明那一列撤了，宽度还给项目名——导入的项目名很长
            ellipsis: true,
            // 项目名就是日期，按名字排 = 按日期排
            sorter: (a: Project, b: Project) => a.name.localeCompare(b.name),
            sortDirections: ["descend", "ascend", "descend"],
            // 说明挪到项目名的悬浮提示里，不单占一列。
            // 那一列 180px 装不下一句话，永远是「从 L…」这种截断，占着位置又
            // 什么都没说清楚；而说明本来就不是每行都要看的东西，需要时鼠标
            // 放上去就有。腾出来的宽度给右边的任务进度，那个才是天天在看的。
            render: (_, p: Project) => (
              <Space>
                <Tooltip title={p.description || undefined}>
                  <strong style={p.description ? { cursor: "help" } : undefined}>{p.name}</strong>
                </Tooltip>
                {!p.is_active && <Tag>已停用</Tag>}
              </Space>
            ),
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
                  {(() => {
                    const sp = seekProgress[p.id];
                    if (!sp || sp.status === "idle") return null;
                    // 暂停时这一整块照样要显示——不然按了暂停进度条就消失了，
                    // 看着像任务没了
                    if (sp.status === "running" || sp.status === "paused") {
                      const seekPaused = sp.status === "paused";
                      return (
                        <div style={{ marginBottom: 4 }} onClick={(e) => e.stopPropagation()}>
                          {/* 跑起来之后**最要紧的是能随时看见它在答什么**。
                              一批跑一两个小时，最后得 0 条候选才发现不对，那是白等；
                              而每一行日志里已经写着「判 none 4、看不清 3、…」，
                              早看一眼就知道该不该停下来改参数。鼠标放上去就出，
                              不用点开弹窗（弹窗一开，项目列表就看不见了） */}
                          <Tooltip
                            placement="bottomLeft"
                            overlayStyle={{ maxWidth: 720 }}
                            title={
                              sp.detail?.length ? (
                                <div style={{ fontSize: 12, lineHeight: 1.7, maxHeight: 320, overflow: "auto" }}>
                                  {sp.detail.slice(-14).map((d, i) => (
                                    <div key={`${i}-${d.slice(0, 12)}`}>{d}</div>
                                  ))}
                                </div>
                              ) : "刚开始，还没有日志"
                            }
                          >
                            <Progress
                              size="small"
                              status={seekPaused ? "normal" : "active"}
                              strokeColor={seekPaused ? "#bfbfbf" : "#eb2f96"}
                              percent={sp.total ? Math.round((sp.processed / sp.total) * 100) : 0}
                              format={() => `${sp.dry_run ? "预览" : "画面"} ${sp.processed}/${sp.total}${seekPaused ? " 已暂停" : ""}`}
                            />
                          </Tooltip>
                          <Space size={4}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {sp.dry_run ? `会送 ${sp.clips_candidate} 段` : `已送 ${sp.clips_sent} 段 · ${seekYield(sp)}${answerNote(sp)} · 约 $${sp.est_usd}`}
                              {" · "}已用 {fmtClock(sp.elapsed_sec)}
                            </Typography.Text>
                            {/* 这一步是花钱的（每段问一次大模型），能随时按住比建索引那边更要紧：
                                看到前几条结果不对就该停下来改问法，而不是把钱花完再说 */}
                            {seekPaused ? (
                              <Tooltip title="接着问没问的那些视频">
                                <Button size="small" type="link" style={{ padding: 0 }}
                                  onClick={async () => { await resumeVisionSeek(p.id); pollSeek([p.id]); }}>继续</Button>
                              </Tooltip>
                            ) : (
                              <Tooltip title="正在问的这个视频问完就停住，后面的不开始；点「继续」接着问。钱只花到停住那一刻">
                                <Button size="small" type="link" style={{ padding: 0 }}
                                  onClick={async () => { await pauseVisionSeek(p.id); pollSeek([p.id]); }}>暂停</Button>
                              </Tooltip>
                            )}
                            <Popconfirm
                              title="停止找片段？"
                              description="正在问的这个视频会跑完，之后的不再发；已写好的候选保留"
                              onConfirm={async () => {
                                await cancelVisionSeek(p.id);
                                message.success("正在停止");
                              }}
                            >
                              <Button size="small" danger type="link" style={{ padding: 0 }}>
                                停止
                              </Button>
                            </Popconfirm>
                          </Space>
                        </div>
                      );
                    }
                    if (sp.total > 0) {
                      return (
                        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 2 }}>
                          上次大模型看视频找动作{sp.dry_run ? "（预览）" : ""}：{sp.succeeded} 个任务，
                          {sp.dry_run ? `会送 ${sp.clips_candidate} 段` : `送 ${sp.clips_sent} 段，${seekYield(sp)}${answerNote(sp)}，约 $${sp.est_usd}`}
                          {sp.status === "cancelled" && "（已停止）"}
                          {sp.status === "error" && `（出错：${sp.error_message}）`}
                          {/* 攒着等人筛的：不摆个按钮在这儿，跑完就没人知道它们在哪 */}
                          {!!sp.found && (
                            <Button size="small" type="link" style={{ padding: "0 4px" }}
                              onClick={(e) => { e.stopPropagation(); openReview(p.id); }}>
                              筛一筛（{sp.found} 段待处理）
                            </Button>
                          )}
                        </Typography.Text>
                      );
                    }
                    return null;
                  })()}
                  {(() => {
                    const ip = indexProgress[p.id];
                    if (!ip || ip.status === "idle") return null;
                    if (ip.status === "running" || ip.status === "paused") {
                      const paused = ip.status === "paused";
                      return (
                        <div style={{ marginBottom: 4 }} onClick={(e) => e.stopPropagation()}>
                          <Progress size="small" status={paused ? "normal" : "active"} strokeColor={paused ? "#8c8c8c" : "#2f54eb"}
                            percent={ip.total ? Math.round((ip.processed / ip.total) * 100) : 0}
                            format={() => `索引 ${ip.processed}/${ip.total}${paused ? "（已暂停）" : ""}`} />
                          <Space size={4}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {ip.current ?? ""} · 已用 {fmtClock(ip.elapsed_sec)}
                            </Typography.Text>
                            {paused ? (
                              <Tooltip title="接着建没建的那些路">
                                <Button size="small" type="link" style={{ padding: 0 }}
                                  onClick={async () => { await resumeVisionIndex(p.id); pollIndex([p.id]); }}>继续</Button>
                              </Tooltip>
                            ) : (
                              <Tooltip title="正在建的那几路建完就停住，后面的不开始；点「继续」接着建">
                                <Button size="small" type="link" style={{ padding: 0 }}
                                  onClick={async () => { await pauseVisionIndex(p.id); pollIndex([p.id]); }}>暂停</Button>
                              </Tooltip>
                            )}
                            <Popconfirm title="停止建索引？" description="立刻停，正在建的那几路也掐掉；建好的保留，下次不用重建"
                              onConfirm={async () => { await cancelVisionIndex(p.id); message.success("已停止"); pollIndex([p.id]); }}>
                              <Button size="small" danger type="link" style={{ padding: 0 }}>停止</Button>
                            </Popconfirm>
                          </Space>
                        </div>
                      );
                    }
                    if (ip.total > 0) {
                      return (
                        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 2 }}>
                          上次画面索引（{ip.cam}）：新建 {ip.built}，已有 {ip.cached}，失败 {ip.failed}
                          {ip.status === "cancelled" && "（已停止）"}
                          {ip.status === "error" && `（出错：${ip.error_message}）`}
                        </Typography.Text>
                      );
                    }
                    return null;
                  })()}
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
                  {/* 跑起来之后鼠标放到这个按钮上就出实时日志。一批跑一两个小时，
                      最后得 0 条候选才发现不对是白等——而日志里每一行都写着模型
                      在答什么（判 none / 看不清 / 没过置信度线），早看一眼就能决定
                      停不停。放在按钮上是因为**人跑起来之后还会来点它**，那一刻
                      正是他想知道"现在怎么样了" */}
                  <Tooltip
                    placement="bottomRight"
                    overlayStyle={{ maxWidth: 720 }}
                    title={(() => {
                      const sp = seekProgress[p.id];
                      if (!sp || !["running", "paused"].includes(sp.status)) {
                        return "视觉大模型通看整段视频，把像舔/啃/抓挠/蹭的几秒挑出来";
                      }
                      return (
                        <div style={{ fontSize: 12, lineHeight: 1.7, maxHeight: 320, overflow: "auto" }}>
                          <div style={{ marginBottom: 4 }}>
                            {sp.processed}/{sp.total} · 已送 {sp.clips_sent} 段 · {seekYield(sp)}
                            {answerNote(sp)}
                          </div>
                          {sp.detail?.length
                            ? sp.detail.slice(-14).map((d, i) => <div key={`${i}-${d.slice(0, 12)}`}>{d}</div>)
                            : <div>刚开始，还没有日志</div>}
                        </div>
                      );
                    })()}
                  >
                    <Button
                      size="small"
                      type="link"
                      loading={seekProgress[p.id]?.status === "running"}
                      onClick={() => openSeek(p)}
                    >
                      大模型看视频找动作
                    </Button>
                  </Tooltip>
                  <Button
                    size="small"
                    type="link"
                    loading={["running", "paused"].includes(indexProgress[p.id]?.status ?? "")}
                    onClick={() => {
                      setIndexTarget(p);
                      pollIndex([p.id]);
                    }}
                  >
                    建画面索引
                  </Button>
                  {/* 第一阶段的落点：「我想要一张狗咬尾巴的图」。不挑任务、不要样例帧，
                      一句话搜整个项目——原来这个功能藏在某个任务的工作台里，
                      而想找第一张的时候，人手上恰恰还没有任何一条样例 */}
                  <Tooltip title="一句英文搜整个项目已建索引的画面（免费、秒出）。找到第一张之后，就能拿它去「找相似」扩一批">
                    <Button size="small" type="link" onClick={() => setPhraseTarget(p)}>
                      一句话找画面
                    </Button>
                  </Tooltip>
                  {/* 试错留下的候选散在几百个任务里。没有这一处，想推倒重来
                      只能删掉整个项目重建——那会把人工标的片段一起带走 */}
                  <Tooltip title="按来源清点 / 整批删掉画面候选（一句话找画面、用这一张去扩）。不用为了清一轮试错去删项目">
                    <Button size="small" type="link" onClick={() => openPurge(p)}>
                      清理候选
                    </Button>
                  </Tooltip>
                  {/* 早期导进来的项目十几天混在一起，查某一天要翻半天。拆成跟新采数据
                      一样"一天一个项目"的形状。任务是搬走的不是复制的，标注一条不丢 */}
                  {(p.description ?? "").includes("已按日期拆成") ? (
                    <Popconfirm
                      title="撤销拆分？"
                      description={
                        <div style={{ maxWidth: 340 }}>
                          拆出来的那几个「YYYY-MM-DD」项目会整个删掉（里面是副本），这个项目回到拆分前的样子。
                          在拆出来的项目里改过的标注会丢。
                        </div>
                      }
                      okButtonProps={{ danger: true }}
                      onConfirm={async () => {
                        const r = await unsplitProject(p.id);
                        message.success(`已撤销：删掉 ${r.removed.length} 个拆出来的项目` +
                          (r.moved_back ? `，搬回 ${r.moved_back} 个任务` : ""), 8);
                        refresh();
                      }}
                    >
                      <Button size="small" type="link">
                        撤销拆分
                      </Button>
                    </Popconfirm>
                  ) : (
                    <Popconfirm
                      title="按采集日期拆成一天一个项目？"
                      description={
                        <div style={{ maxWidth: 340 }}>
                          这个项目的 <b>{tasksOf(p.id).length}</b> 个任务会按各自样本的采集日期
                          <b>复制</b>到新建的「YYYY-MM-DD」项目里（标注结果、轮次一起复制；标签整套克隆）。
                          <b>这个项目原样保留</b>，用来对照拆得对不对；核对完把它「停用」即可——
                          导出训练集时不指定项目会跳过停用的项目，同一段标注不会算两遍。
                        </div>
                      }
                      okText="拆"
                      onConfirm={async () => {
                        const r = await splitProjectByDate(p.id);
                        message.success(
                          `拆成 ${r.created.length} 个项目：${r.created.map((c) => `${c.name}（${c.n_tasks}）`).join("、")}` +
                            (r.skipped_no_date ? `；${r.skipped_no_date} 个没有采集日期的任务没拆` : ""),
                          10,
                        );
                        refresh();
                      }}
                    >
                      <Tooltip title="老项目十几天混在一起的话，拆成一天一个项目，跟新采的数据一个形状，方便查阅调整。原项目不动">
                        <Button size="small" type="link">
                          按日期拆分
                        </Button>
                      </Tooltip>
                    </Popconfirm>
                  )}
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
        ])}
      />

      <Modal
        title={`建画面索引 - ${indexTarget?.name ?? ""}`}
        open={indexTarget != null}
        onCancel={() => setIndexTarget(null)}
        okText="开始建"
        confirmLoading={indexStarting}
        okButtonProps={{
          disabled:
            !indexTarget ||
            ["running", "paused"].includes(indexProgress[indexTarget.id]?.status ?? "") ||
            indexProgress[indexTarget.id]?.service?.available === false,
        }}
        onOk={async () => {
          if (!indexTarget) return;
          setIndexStarting(true);
          try {
            await startVisionIndex(indexTarget.id, { cam: indexCam, force: indexForce, mode: indexMode });
            message.info("已开始，进度在项目行里看");
            await pollIndex([indexTarget.id]);
            setIndexTarget(null);
          } finally {
            setIndexStarting(false);
          }
        }}
        destroyOnClose
      >
        {indexTarget && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              给项目里每路视频框出狗、算成向量存起来（本地跑 SigLIP，不花钱）。
              建好之后「找相似」「一句话找画面」才有东西可搜。索引建一次就够，加新标签不用重建。
            </Typography.Paragraph>
            {indexProgress[indexTarget.id]?.service?.available === false && (
              <Alert type="warning" showIcon message={`视觉服务那边向量模型不可用：${indexProgress[indexTarget.id]?.service?.error ?? ""}`} />
            )}
            {/* 档位：这是这一屏最要紧的选择，摆在最前面 */}
            <div>
              <Typography.Text strong style={{ marginRight: 8 }}>密度：</Typography.Text>
              <Radio.Group size="small" value={indexMode} onChange={(e) => setIndexMode(e.target.value)}>
                <Radio.Button value="fast">快档（只取关键帧）</Radio.Button>
                <Radio.Button value="fine">精档（每秒一帧）</Radio.Button>
              </Radio.Group>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                {indexMode === "fast" ? (
                  <>
                    只解关键帧，<b>全量 224 路几分钟</b>。但这批素材关键帧约 12 秒一个——
                    <b>短动作会整个漏掉</b>（5 秒的抓挠有一半以上概率一帧都没采到）。
                    适合「先把索引建起来、一句话找到第一张样例」和粗筛哪几路有戏。
                  </>
                ) : (
                  <>
                    每秒一帧，<b>一路十几秒、全量 224 路约 40 分钟</b>。找相似扩样本、写候选要用这一档。
                    建议：先用快档全量刷一遍找到目标，再**只对要扩的那几路**建精档。
                  </>
                )}
                <br />
                已经有精档的那几路，再建快档会直接跳过——<b>不会被降级</b>。
              </Typography.Paragraph>
            </div>
            <Space wrap>
              <span>
                哪一路：
                <Select size="small" value={indexCam} onChange={(v) => setIndexCam(v)} style={{ width: 200 }}
                  options={[
                    { value: "all", label: "全部（有几路建几路）" },
                    { value: "cam1", label: "视角1（cam1）" },
                    { value: "cam2", label: "视角2（cam2）" },
                    { value: "cam3", label: "视角3（cam3）" },
                  ]} />
              </span>
              <Checkbox checked={indexForce} onChange={(e) => setIndexForce(e.target.checked)}>
                已有索引的也重建
              </Checkbox>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              视角1/2/3 是<b>每只狗样本里的槽位</b>（跟工作台里的视角1/2/3 一样），不是现场摄像头编号。
              「全部」的意思：狗场只建每只狗自己房间那一路（公共区几只狗同在，对不上是哪只的 IMU）；
              影棚三路都是公共的，全建。
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              一小时视频一两分钟（狗检测每秒一帧）。已经建过的直接跳过。
              {indexProgress[indexTarget.id]?.service?.indexed_videos != null && ` 视觉服务上已有 ${indexProgress[indexTarget.id]?.service?.indexed_videos} 路索引。`}
            </Typography.Text>
            {(() => {
              const ip = indexProgress[indexTarget.id];
              if (!ip || ip.status === "idle" || !ip.detail.length) return null;
              return (
                <div style={{ maxHeight: 160, overflow: "auto", fontSize: 12, color: "#666", background: "#fafafa", padding: 8 }}>
                  {ip.detail.slice(-30).map((line, i) => (<div key={i}>{line}</div>))}
                </div>
              );
            })()}
          </Space>
        )}
      </Modal>
      <Modal
        title={`大模型看视频找动作 - ${seekTarget?.name ?? ""}`}
        open={seekTarget != null}
        onCancel={() => setSeekTarget(null)}
        onOk={handleStartSeek}
        okText={seekDryRun ? "试算（不花钱）" : seekReview ? "开始找（跑完再筛）" : "开始找"}
        confirmLoading={seekStarting}
        okButtonProps={{
          disabled:
            !seekTarget ||
            seekLabels.length === 0 ||
            seekEligible(seekTarget.id).length === 0 ||
            seekProgress[seekTarget.id]?.status === "running" ||
            (!seekDryRun && seekProgress[seekTarget.id]?.service?.available === false),
        }}
        destroyOnClose
      >
        {seekTarget && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Paragraph style={{ marginBottom: 0 }}>
              让视觉大模型<b>通看整段视频</b>，把像<b>舔 / 啃 / 抓挠 / 蹭</b>的几秒挑出来（还会说是身上哪一处、
              为什么这么判），跑完先筛一遍，勾中的写成「疑似片段」候选。不用人从 24 小时视频里翻。
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                跟「找相似」的分工：这边<b>不需要你先有样例</b>，某个动作一条都没标过时只有它能从零找出来，
                代价是按段问大模型、慢且花钱；一旦某个类别攒够几条，后面用「找相似」扩，免费又瞬间。
              </Typography.Text>
            </Typography.Paragraph>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              流程：本地先筛「画面里有狗且在动」的几秒窗（不花钱）→ 裁出狗那一块、抽几帧问大模型（走 API，按段计费）
              → 相邻同类合成一段。每个视频最多送 <b>{seekMaxClips}</b> 段，这是花费上限（本地模型不花钱，这个数只影响耗时）。
              <b>先「建画面索引」再来</b>：建过索引的视频这里不用再解码检测，预览秒出；没建的每路要一两分钟。
            </Typography.Text>
            {seekProgress[seekTarget.id]?.service?.available === false && (
              <Alert
                type="warning"
                showIcon
                message={`视觉服务那边找片段不可用：${seekProgress[seekTarget.id]?.service?.error ?? ""}（预览不需要它问模型，还能跑）`}
              />
            )}
            {seekableLabels(seekTarget.id).length === 0 ? (
              <Alert type="error" showIcon message="项目里没有 舔身体 / 啃身体 / 抓挠 / 蹭身体 这几个标签，先去标签管理套用「抓/舔/啃/蹭」模板" />
            ) : (
              <div>
                <Typography.Text style={{ marginRight: 8 }}>找哪些：</Typography.Text>
                <Select
                  mode="multiple"
                  size="small"
                  style={{ minWidth: 280 }}
                  value={seekLabels}
                  onChange={(v) => setSeekLabels(v)}
                  options={seekableLabels(seekTarget.id).map((n) => ({ value: n, label: n }))}
                />
                <Tooltip title="让模型顺便判断是身上哪一处。层级标签上线后「啃」底下有 37 条部位，全问一遍 prompt 会很长、模型在几十个选项里也挑不准（几帧俯拍分不出左右），选项越细越容易乱选。候选写进来是「抓挠-耳/耳后」这种，人在工作台里还能改细">
                  <span style={{ marginLeft: 12 }}>
                    部位问到：
                    <Select size="small" value={seekPartDepth} onChange={(v) => setSeekPartDepth(v)} style={{ width: 130 }}
                      options={[
                        { value: 0, label: "不问部位" },
                        { value: 1, label: "大区域" },
                        { value: 2, label: "具体部位" },
                        { value: 3, label: "连左右" },
                      ]} />
                  </span>
                </Tooltip>
              </div>
            )}
            <div>
              <Typography.Text style={{ marginRight: 8 }}>用哪个模型：</Typography.Text>
              <Select
                size="small"
                style={{ minWidth: 320 }}
                value={seekLlm}
                onChange={(v) => setSeekLlm(v)}
                options={[
                  { value: "", label: "视觉服务环境变量里的 Claude key（老方式）" },
                  ...(llmProviders ?? [])
                    .filter((p) => p.enabled && (p.has_key || p.key_optional))
                    .flatMap((p) =>
                      p.models.map((m) => ({
                        value: `${p.provider}|${m.name}`,
                        label: `${p.display_name} · ${m.name}${m.price_in ? `（$${m.price_in}/$${m.price_out} 每百万）` : ""}`,
                      }))
                    ),
                ]}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                在「大模型 API」页配 key 和模型。换一个模型再跑同一批，两家的候选会并排放着，不互相覆盖
              </Typography.Text>
            </div>
            <Space wrap>
              <span>
                看哪一路：
                <Select size="small" value={seekCam} onChange={(v) => setSeekCam(v)} style={{ width: 320 }}
                  options={[
                    // 「全部」不是字面全部，是 usable_cams：按文件名里的 _imuM 和布局表，
                    // **只跑这只狗自己单间那一路**，狗场的 cam7 公共区自动排掉。
                    // 这就是"按 imu 对应 cam 来跑"，正常情况下人根本不用碰下面那几项——
                    // 它们是手动指定某个槽位的后路，而槽位编号不是机位号（见 camSlots），
                    // 选错了就会去公共区找，找到的狗对不上这条 IMU
                    { value: "all", label: "按 IMU 配对的那一路（推荐，默认）" },
                    ...(camSlots?.slots ?? [{ slot: "cam1" }, { slot: "cam2" }, { slot: "cam3" }] as never[])
                      .map((x: { slot: string; videos?: number; public?: number;
                                 cams?: { label: string; videos: number }[] }) => ({
                        value: x.slot,
                        disabled: x.videos === 0,
                        label: (
                          <span>
                            {x.slot}
                            {x.cams?.length ? (
                              <span style={{ color: "#999", fontSize: 12 }}>
                                {" · "}{x.cams.slice(0, 2).map((c) => c.label).join("、")}
                                {x.cams.length > 2 ? " 等" : ""}
                                {" · "}{x.videos} 路
                              </span>
                            ) : x.videos === 0 ? (
                              <span style={{ color: "#999", fontSize: 12 }}> · 这个项目里没有</span>
                            ) : null}
                          </span>
                        ),
                      })),
                  ]} />
              </span>
              {/* 选中的槽位里有多少路是公共区：那一路六只狗同框，找到的对不上这条 IMU。
                  这句不说，人只会看到一批"看着对、其实是别的狗"的候选 */}
              {(() => {
                const cur = camSlots?.slots?.find((x) => x.slot === seekCam);
                if (!cur || !cur.public) return null;
                return (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    这一路里有 {cur.public} 路是公共区（几只狗同框），找到的狗不一定是这条 IMU 的
                  </Typography.Text>
                );
              })()}
              <span>
                只跑这几处：
                <Tooltip title="按场地和机位挑，不是按「第几个槽位」——槽位是导入时的装箱顺序，影棚和狗场恰好都被塞进第 1 个，选它等于两处一起跑。留空 = 不限">
                  <Select
                    size="small"
                    mode="multiple"
                    allowClear
                    maxTagCount={1}
                    placeholder="不限（全跑）"
                    style={{ width: 260 }}
                    value={seekScopes}
                    onChange={setSeekScopes}
                    options={(camSlots?.scopes ?? []).map((x) => ({
                      value: x.key,
                      label: (
                        <span>
                          {x.label}{" "}
                          <span style={{ color: "#999", fontSize: 12 }}>
                            {x.videos} 路{x.public ? `・公共区` : ""}
                          </span>
                        </span>
                      ),
                    }))}
                  />
                </Tooltip>
              </span>
              {seekCam === "all" && (
                <Tooltip title="按视频文件名里的 _imuM 和现场布局表配对（site_layout）。狗场一间一狗一摄像头，配得上；影棚 4 只狗共处、3 路全公共，配不上——那里的候选会带「多狗同场」标记，画面里哪只是这条 IMU 的只能人看">
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    按文件名里的 IMU 号配对，只跑这只狗自己单间那一路；狗场的公共区（cam7）自动排掉。
                    影棚 4 只狗共处、没有单间，那里的候选会标「多狗同场」
                  </Typography.Text>
                </Tooltip>
              )}
              {/* 每个槽位实际装了哪些场地·机位，**全列出来**。
                  下拉里那一行只放得下前两个，剩下的收进「等」里——而"等"里的
                  恰恰是人要核对的那部分（这个项目到底有没有狗场1 的素材）。
                  这一屏是布局表跟现场对不对得上的唯一照面，截断等于白做 */}
              {camSlots?.slots?.some((x) => (x.cams?.length ?? 0) > 2) && (
                <Tooltip title="按视频文件名和布局表数出来的。跟现场对不上就是布局表（site_layout）该改了">
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    每一路的明细：
                    {camSlots.slots
                      .filter((x) => x.videos > 0)
                      .map((x) => `${x.slot}=${x.cams.map((c) => `${c.label} ${c.videos}`).join("、")}`)
                      .join("；")}
                  </Typography.Text>
                </Tooltip>
              )}
              <span>
                每个视频最多送：
                <InputNumber size="small" min={1} max={2000} value={seekMaxClips} onChange={(v) => setSeekMaxClips(v ?? 120)} style={{ width: 90 }} /> 段
              </span>
              <span>
                只跑前：
                <InputNumber size="small" min={1} max={seekEligible(seekTarget.id).length || 1} value={seekLimit ?? undefined}
                  placeholder="全部" onChange={(v) => setSeekLimit(v ?? null)} style={{ width: 90 }} /> 个任务
              </span>
            </Space>
            {/* 「只数会送多少段」那个勾去掉了：它回答的是"这一批要花多少钱"，
                而本地模型不花钱；跑完又什么结果都没有，占一行还得让人读一遍才知道
                不该勾。接口上的 dry_run 留着（别的调用方和测试在用），界面不给入口 */}
            <Tooltip title="模型一次能出几千段，里面混着的错的要是直接写进候选，人得跨几十个任务一条条排除。先摆成一屏缩略图过一眼，勾中的才写，类别不对还能当场改">
              <Checkbox checked={seekReview}
                        onChange={(e) => setSeekReview(e.target.checked)}>
                <b>先筛一遍再写</b>：跑完不直接写候选，把找到的段摆成一屏让你勾（跟「找相似」那一屏一样）
              </Checkbox>
            </Tooltip>
            <Typography.Text>
              本次将处理 <b>{Math.min(seekLimit ?? Infinity, seekEligible(seekTarget.id).length)}</b> 个待认领/标注中的任务。
              一小时视频本地筛选一两分钟，问模型每段一两秒、几段并行。
            </Typography.Text>
            {(() => {
              const sp = seekProgress[seekTarget.id];
              if (!sp || sp.status === "idle") return null;
              return (
                <div style={{ background: "#fafafa", padding: 8, borderRadius: 4 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    上一次/当前{sp.dry_run ? "（预览）" : ""}：
                    {sp.status === "running" ? "进行中" : sp.status === "done" ? "已完成" : sp.status === "cancelled" ? "已停止" : "出错"}，
                    {sp.processed}/{sp.total}，成功 {sp.succeeded}，跳过 {sp.skipped}，失败 {sp.failed}，
                    会送/已送 {sp.clips_candidate}/{sp.clips_sent} 段，候选 {sp.candidates} 条，约 ${sp.est_usd}，
                    {sp.status === "running" ? "已用" : "总耗时"} {fmtClock(sp.elapsed_sec)}
                    {sp.labels.length > 0 && `，找的是 ${sp.labels.join("、")}`}
                    {sp.llm && `，模型 ${sp.llm}`}
                  </Typography.Text>
                  {sp.error_message && <Alert style={{ marginTop: 6 }} type="error" showIcon message={sp.error_message} />}
                  {sp.detail.length > 0 && (
                    <div style={{ maxHeight: 160, overflow: "auto", marginTop: 6, fontSize: 12, color: "#666" }}>
                      {sp.detail.slice(-30).map((line, i) => (
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
              {/* 原来是 Segmented。加上端侧那两个之后有 5 个选项，Segmented 会很宽，
                  而且它**不支持分组**——线上和端侧混在一排看不出区别。换成 Select。 */}
              <Select
                size="small"
                {...INFER_SELECT_PROPS}
                value={prelabelMode}
                onChange={(v) => {
                  setPrelabelMode(v as InferMode);
                  saveText(PRELABEL_MODE_KEY, String(v));
                }}
                options={inferOptions}
              />
              <InferModeHelp />
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {hintOf(prelabelMode)}
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
                            {r.mode && <Tag>{modeLabelOf(r.mode)}</Tag>}
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
          {!editing && (
            <Form.Item style={{ marginBottom: 8 }}>
              <Checkbox
                checked={perDate}
                onChange={(e) => {
                  setPerDate(e.target.checked);
                  // 分开建的时候名字是每天各自的日期，这里的输入框用不上；
                  // 但表单的必填校验还在，填个占位让它过
                  if (e.target.checked) form.setFieldsValue({ name: "（按日期分别命名）" });
                  else form.setFieldsValue({ name: defaultNameFor(createSelected) });
                }}
              >
                每天各建一个项目
              </Checkbox>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                勾了之后，选中的样本按采集日期分组，一天一个项目、名字就是那天的日期；
                标注模式、模型版本、指派、标签模板每个项目都一样
              </Typography.Text>
            </Form.Item>
          )}
          <Form.Item
            name="name"
            label="项目名"
            rules={[{ required: true }]}
            extra={
              editing
                ? undefined
                : perDate
                  ? `会建 ${new Set((samples ?? []).filter((x) => createSelected.has(x.id)).map((x) => x.session_date ?? "未知日期")).size} 个项目，名字分别是各自的日期`
                  : nameAuto
                    ? "默认用选中样本的日期目录名，可以改"
                    : undefined
            }
          >
            <Input
              disabled={!editing && perDate}
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
                  <Space size={6}><Select {...INFER_SELECT_PROPS} value={createInferMode} onChange={(v) => { setCreateInferMode(v); saveText(CREATE_MODE_KEY, v); }} options={inferOptions} title={hintOf(createInferMode)} /><InferModeHelp /></Space>
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
              editing ? (
                <>
                  {/* 先说清楚现在是什么，再说这个框会干什么。**这个框是「套用」，
                      不是「当前值」**——它永远空着，而人打开编辑框第一个想知道的
                      恰恰是"现在用的哪个" */}
                  <div>
                    现在：
                    {curTpl == null
                      ? "读取中…"
                      : curTpl.templates.length === 0
                        ? `没有跟着任何模板（${curTpl.total} 个标签都是手动加的，或者改过颜色断开了跟随）`
                        : curTpl.templates.map((t) => `${t.name}（${t.labels} 个标签跟着它）`).join("、")}
                    {curTpl != null && curTpl.templates.length > 0 && curTpl.unlinked > 0 && (
                      <>
                        ；另有 {curTpl.unlinked} 个不跟模板
                        <Tooltip title="手动加的，或者套进来之后自己改过颜色——改颜色会断开跟随，之后模板改颜色不再同步过来">
                          <span style={{ borderBottom: "1px dashed #bbb", marginLeft: 2 }}>为什么</span>
                        </Tooltip>
                      </>
                    )}
                  </div>
                  <div>套用会把模板里的标签添加进来，已有同 code 的会跳过，不会覆盖</div>
                </>
              ) : (
                "创建后立即套用该模板的标签，不用另外去标签管理页配一遍"
              )
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
            {batchProgress
              ? batchProgress
              : editing
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
            <Space size={6}><Select {...INFER_SELECT_PROPS} value={createInferMode} onChange={(v) => { setCreateInferMode(v); saveText(CREATE_MODE_KEY, v); }} options={inferOptions} title={hintOf(createInferMode)} /><InferModeHelp /></Space>
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

      {/* 按来源清理画面候选。**只删候选，不动片段**——片段是人工成果，
          归人工管；候选是机器的提议，试坏了就该能整批扔掉 */}
      <Modal
        title={`清理画面候选 - ${purgeTarget?.name ?? ""}`}
        open={purgeTarget != null}
        onCancel={() => setPurgeTarget(null)}
        footer={null}
        width={620}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="删候选不会动片段"
          description="已确认的候选生成过正式片段，那是人工成果，删候选不会带走它。反过来也一样：删片段不会带走候选——留着的候选会挡住同一段以后再被写进来。"
        />
        {purgeSrc == null ? (
          <Spin />
        ) : (
          <>
            <Checkbox
              checked={purgeDecided}
              onChange={(e) => setPurgeDecided(e.target.checked)}
              style={{ marginBottom: 10 }}
            >
              连<b>已经判过的</b>一起删（已确认 / 已排除 / 待定）
              <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                不勾就只删「待确认」的。推倒重来才勾
              </Typography.Text>
            </Checkbox>
            <Space direction="vertical" style={{ width: "100%" }} size={8}>
              {([
                ["text", "一句话找画面", "项目页那个入口写的"],
                ["image", "用这一张去扩", "工作台里拿一帧去找相似写的"],
                ["similar_old", "画面相似（旧）", "两个入口还没分开时写的，认不出是哪一边"],
              ] as const).map(([key, name, why]) => {
                const s = purgeSrc.sources[key] ?? { total: 0, pending: 0 };
                const n = purgeDecided ? s.total : s.pending;
                return (
                  <Space key={key} style={{ width: "100%", justifyContent: "space-between" }}>
                    <span>
                      <b>{name}</b>{" "}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        共 {s.total} 条，其中待确认 {s.pending} · {why}
                      </Typography.Text>
                    </span>
                    <Popconfirm
                      title={`删掉 ${n} 条「${name}」候选？`}
                      description="删掉之后这些段可以被重新搜出来、重新写。已确认的那些对应的片段不受影响"
                      okText="删"
                      okButtonProps={{ danger: true }}
                      disabled={n === 0}
                      onConfirm={async () => {
                        setPurgeBusy(true);
                        try {
                          const r = await purgeCandidates(purgeTarget!.id, key, purgeDecided);
                          message.success(`删了 ${r.deleted} 条`);
                          await loadPurge(purgeTarget!.id);
                          refresh();
                        } finally {
                          setPurgeBusy(false);
                        }
                      }}
                    >
                      <Button size="small" danger disabled={n === 0} loading={purgeBusy}>
                        删 {n} 条
                      </Button>
                    </Popconfirm>
                  </Space>
                );
              })}
            </Space>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
              别的来源（AI 预标注、频谱、大模型看视频）共 {purgeSrc.other.total} 条，这里不碰。
            </Typography.Paragraph>
          </>
        )}
      </Modal>

      {/* 项目级「一句话找画面」：第一阶段的落点 */}
      <Modal
        title={`一句话找画面 - ${phraseTarget?.name ?? ""}`}
        open={phraseTarget != null}
        onCancel={() => setPhraseTarget(null)}
        width="100vw"
        style={{ top: 0, maxWidth: "100vw", paddingBottom: 0 }}
        styles={{ body: { height: "calc(100vh - 110px)", overflow: "hidden", padding: "8px 12px" }, content: { borderRadius: 0 } }}
        footer={null}
        destroyOnClose
      >
        {phraseTarget && (
          <ProjectPhraseSearch
            projectId={phraseTarget.id}
            labelNames={labelsOf(phraseTarget.id).filter((l) => l.is_active).map((l) => ({ name: l.display_name, color: l.color }))}
          />
        )}
      </Modal>

      {/* 「大模型看视频找动作」跑完之后的筛选屏：跟「找相似」那一屏同一套操作 */}
      <Modal
        title={`筛一筛：大模型看视频找动作找到的段（项目 #${reviewOpen ?? ""}）`}
        open={reviewOpen != null}
        onCancel={() => { setReviewOpen(null); setReviewFound([]); }}
        width="100vw"
        style={{ top: 0, maxWidth: "100vw", paddingBottom: 0 }}
        styles={{ body: { height: "calc(100vh - 110px)", overflow: "hidden", padding: "8px 12px" }, content: { borderRadius: 0 } }}
        footer={null}
        destroyOnClose
      >
        {reviewLoading ? (
          <Spin />
        ) : reviewOpen != null ? (
          <SeekReviewGrid
            projectId={reviewOpen}
            found={reviewFound}
            labelNames={labelsOf(reviewOpen).filter((l) => l.is_active).map((l) => ({ name: l.display_name, color: l.color }))}
            onWritten={(_n, left) => {
              pollSeek([reviewOpen]);
              if (!left) { setReviewOpen(null); setReviewFound([]); }
              else getVisionSeekFound(reviewOpen).then((r) => setReviewFound(r.found)).catch(() => undefined);
            }}
          />
        ) : null}
      </Modal>

      <AnnotationWorkspace
        task={workspaceTask}
        focusLabelIds={workspaceFocusLabels}
        labels={workspaceLabels}
        readOnly={workspaceReadOnly}
        // 关掉也刷一遍：中途改过类别、删过段，不刷的话列表上的数还是进去之前那份
        onClose={() => { setWorkspaceTask(null); refresh(); }}
        onSaved={refresh}
        onSubmitted={refresh}
      />
    </div>
  );
}
