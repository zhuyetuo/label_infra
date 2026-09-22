import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Collapse, Input, Modal, Popconfirm, Progress, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from "antd";
import { LockOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cleanupMissingFileSamples,
  deleteSamplesBatch,
  getImportScanStatus,
  listMissingFileSamples,
  startImportScan,
  listSamples,
  setSamplesDog,
  setSamplesSensitive,
  updateSample,
  type ScanProgress,
  listVisionScans,
  runVisionScan,
  getVisionScanStatus,
  sharedCamApply,
  sharedCamPlan,
} from "@/api/samples";
import { listDogs } from "@/api/dogs";
import SamplePreviewModal from "@/components/SamplePreviewModal";
import type { Sample } from "@/types";
import { imuOf, sortImuKeys } from "@/utils/imuOf";
import { useAuthStore } from "@/stores/authStore";
import { usePersistedSort } from "@/utils/persistedSort";
import { useResizableColumns } from "@/utils/resizableColumns";

const statusColor: Record<Sample["import_status"], string> = {
  pending: "default",
  verified: "green",
  error: "red",
};

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}分${s}秒`;
}

type DayItem = { key: string; label: React.ReactNode; children: React.ReactNode; count?: number };

/** 把按天的折叠项归成 年 → 月 → 日 三层。key 是 YYYY-MM-DD；认不出日期的归到「其他」。
 *  每层标题带样本数；最新的月默认展开，年由外层的 defaultActiveKey 管 */
function nestByYearMonth(days: DayItem[]) {
  const years = new Map<string, Map<string, DayItem[]>>();
  for (const d of days) {
    const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(d.key);
    const y = m ? m[1] : "其他";
    const mo = m ? `${m[1]}-${m[2]}` : "其他";
    if (!years.has(y)) years.set(y, new Map());
    const months = years.get(y)!;
    if (!months.has(mo)) months.set(mo, []);
    months.get(mo)!.push(d);
  }
  const sum = (items: DayItem[]) => items.reduce((a, d) => a + (d.count ?? 0), 0);
  return [...years.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([y, months]) => {
      const monthKeys = [...months.keys()].sort((a, b) => b.localeCompare(a));
      const monthItems = monthKeys.map((mo) => {
        const items = months.get(mo)!;
        return {
          key: mo,
          label: `${mo === "其他" ? "其他" : `${Number(mo.slice(5))} 月`}（${items.length} 天 · ${sum(items)} 个样本）`,
          children: <Collapse size="small" items={items} />,
        };
      });
      const all = monthKeys.flatMap((mo) => months.get(mo)!);
      return {
        key: y,
        label: `${y === "其他" ? "其他" : `${y} 年`}（${all.length} 天 · ${sum(all)} 个样本）`,
        children: <Collapse size="small" defaultActiveKey={monthKeys[0] ? [monthKeys[0]] : []} items={monthItems} />,
      };
    });
}

export default function Samples() {
  const qc = useQueryClient();
  const isAdmin = useAuthStore((st) => st.userInfo?.role === "admin" || st.userInfo?.role === "super_admin");
  // 「看全场的那一路」补挂的报告。只看不改——偏移是从文件名的开机时刻推出来的，
  // 这个前提对不对，只有拿两路画面上同一个可辨认的瞬间核一次才知道
  const [sharedCam, setSharedCam] = useState<Awaited<ReturnType<typeof sharedCamPlan>> | null>(null);
  const [sharedCamLoading, setSharedCamLoading] = useState(false);
  // 只写一天：偏移的前提（文件名那串数 = 开机时刻）只能拿眼睛核，
  // 先挑一天挂上去核完再铺开。默认挑报告里样本最多的那一天
  const [sharedCamDay, setSharedCamDay] = useState<string | undefined>();
  const [sharedCamBusy, setSharedCamBusy] = useState(false);
  const loadSharedCam = async () => {
    setSharedCamLoading(true);
    try {
      setSharedCam(await sharedCamPlan());
    } finally {
      setSharedCamLoading(false);
    }
  };
  const { data, isLoading, refetch } = useQuery({ queryKey: ["samples"], queryFn: listSamples });
  const { data: dogs } = useQuery({ queryKey: ["dogs"], queryFn: listDogs });
  // 画面扫描结果。一次拉回来按样本查，不每行一个请求——几百行的话那就是几百个请求。
  // 没扫过的样本**不在这个表里**，查不到就是"未扫描"，不是"没狗"。
  const { data: vscans } = useQuery({ queryKey: ["vision-scans"], queryFn: listVisionScans });
  const { data: vstatus } = useQuery({ queryKey: ["vision-scan-status"], queryFn: getVisionScanStatus, retry: false });
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [preview, setPreview] = useState<Sample | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startPolling = () => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const p = await getImportScanStatus();
      setProgress(p);
      if (p.status === "done" || p.status === "error") {
        stopPolling();
        if (p.status === "done") {
          message.success(`扫描完成：新增 ${p.created}，跳过已存在 ${p.skipped_existing}，出错 ${p.errors}`);
        } else {
          message.error(`扫描出错：${p.error_message}`);
        }
        qc.invalidateQueries({ queryKey: ["samples"] });
      }
    }, 1000);
  };

  useEffect(() => stopPolling, []);

  const handleAssignDog = async (sample: Sample, dogId: number | null) => {
    await updateSample(sample.id, { dog_id: dogId });
    message.success(dogId == null ? "已取消关联" : "已关联");
    qc.invalidateQueries({ queryKey: ["samples"] });
  };

  // 敏感隐私：标了之后标注员/审核员在任何地方都看不到这些样本和上面的任务，
  // 只有管理员/超级管理员能看能标；确认不敏感了可以解除。支持勾选一批一起标。
  // 排序记住：样本按 CSV 行数/时长找异常时排一次序，切走再回来不用重排
  const sort = usePersistedSort("samples-sort");
  const width = useResizableColumns("samples-widths");
  const [sensitiveFilter, setSensitiveFilter] = useState<"全部" | "仅敏感" | "仅非敏感">("全部");
  // 空 CSV：文件建出来了但一行数据都没写，打开就报「CSV 没有数据行」，也算不出
  // 任何指标。行数为 null 是导入时没探到，不算空
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [markOpen, setMarkOpen] = useState(false);
  const [markNote, setMarkNote] = useState("");
  const [marking, setMarking] = useState(false);

  const handleToggleSensitive = async (sample: Sample, on: boolean) => {
    await updateSample(sample.id, { is_sensitive: on });
    message.success(on ? "已标记为敏感，仅管理员可见" : "已解除敏感标记");
    qc.invalidateQueries({ queryKey: ["samples"] });
  };

  // NAS 上文件已经没了的样本（当天重录过、或者人工删过原始数据）。
  // 由扫描标出来，这里只负责展示和一键清理
  const { data: missing } = useQuery({
    queryKey: ["samples", "missing-files"],
    queryFn: listMissingFileSamples,
  });

  const cleanupMissing = async () => {
    const r = await cleanupMissingFileSamples();
    message.success(`已清理 ${r.deleted} 个样本${r.tasks_deleted ? `、${r.tasks_deleted} 个任务` : ""}`);
    qc.invalidateQueries({ queryKey: ["samples"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };

  const removeSamples = async (ids: number[]) => {
    const r = await deleteSamplesBatch(ids);
    message.success(`已删除 ${r.deleted} 个样本${r.tasks_deleted ? `、${r.tasks_deleted} 个任务` : ""}`);
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["samples"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };

  // 跟「所属狗」列的下拉显示同一套写法，两处不一致的话人会以为选错了
  const dogLabel = (dogId: number) => {
    const d = dogs?.find((x) => x.id === dogId);
    if (!d) return `#${dogId}`;
    return d.name ? `${d.dog_code}（${d.name}）` : d.dog_code;
  };

  // 一天一个机位就有 30 份样本（每小时一段），而同一天同一个机位戴在哪只狗身上
  // 是固定的——挨个下拉选 30 次纯属白费功夫
  const assignDog = async (ids: number[], dogId: number | null) => {
    if (ids.length === 0) return;
    const r = await setSamplesDog(ids, dogId);
    const who = dogId == null ? "解除关联" : `关联到 ${dogLabel(dogId)}`;
    message.success(`已把 ${r.updated} 个样本${who}`);
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["samples"] });
  };
  const assignDogBulk = (dogId: number | null) => assignDog([...selected], dogId);

  const dogOptions = dogs?.map((d) => ({
    value: d.id,
    label: d.name ? `${d.dog_code}（${d.name}）` : d.dog_code,
  }));

  /** 这一组现在都关联到谁了：全一样就报那只狗，有多有少就是"混合" */
  const groupDog = (rows: Sample[]) => {
    const ids = new Set(rows.map((r) => r.dog_id ?? 0));
    if (ids.size !== 1) return { text: "多只/部分未关联", mixed: true };
    const only = [...ids][0];
    return only ? { text: dogLabel(only), mixed: false } : null;
  };

  const applyBulk = async (on: boolean) => {
    if (selected.size === 0) return;
    setMarking(true);
    try {
      const r = await setSamplesSensitive([...selected], on, on ? markNote.trim() || null : null);
      message.success(on ? `已把 ${r.updated} 个样本标记为敏感` : `已解除 ${r.updated} 个样本的敏感标记`);
      setSelected(new Set());
      setMarkOpen(false);
      setMarkNote("");
      qc.invalidateQueries({ queryKey: ["samples"] });
    } finally {
      setMarking(false);
    }
  };

  const columns = [
    { title: "ID", dataIndex: "id", width: 80, sorter: (a: Sample, b: Sample) => a.id - b.id },
    {
      title: "样本编号",
      dataIndex: "sample_code",
      // 编号里带采集时间（multicam_日期_时分秒_imuN），按字符串排就是按采集时间排
      sorter: (a: Sample, b: Sample) => a.sample_code.localeCompare(b.sample_code),
      defaultSortOrder: "ascend" as const,
      render: (code: string, r: Sample) => (
        <Space size={4}>
          <span>{code}</span>
          {r.is_sensitive && (
            <Tooltip title={`含敏感隐私信息，仅管理员可见${r.sensitive_note ? `：${r.sensitive_note}` : ""}`}>
              <Tag color="red" icon={<LockOutlined />} style={{ marginRight: 0 }}>
                敏感
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: "隐私",
      dataIndex: "is_sensitive",
      width: 90,
      sorter: (a: Sample, b: Sample) => Number(a.is_sensitive) - Number(b.is_sensitive),
      render: (on: boolean, r: Sample) => (
        <Tooltip title={on ? "点击解除：其他人重新可见" : "点击标记：只有管理员/超级管理员能看能标"}>
          <Switch size="small" checked={on} onChange={(v) => handleToggleSensitive(r, v)} checkedChildren="敏感" unCheckedChildren="公开" />
        </Tooltip>
      ),
    },
    {
      title: "状态",
      dataIndex: "import_status",
      sorter: (a: Sample, b: Sample) => a.import_status.localeCompare(b.import_status),
      render: (s: Sample["import_status"]) => <Tag color={statusColor[s]}>{s}</Tag>,
    },
    {
      title: "所属狗",
      dataIndex: "dog_id",
      width: 160,
      // 没关联的排最后，关联了的按狗编号
      sorter: (a: Sample, b: Sample) => {
        const na = dogs?.find((d) => d.id === a.dog_id)?.dog_code ?? "￿";
        const nb = dogs?.find((d) => d.id === b.dog_id)?.dog_code ?? "￿";
        return na.localeCompare(nb, undefined, { numeric: true });
      },
      // 采集端文件名还没带 dog 编号之前，只能靠这里手动关联；等以后文件名
      // 自动带出来了，这里照样能用来改关联
      render: (dogId: number | null, record: Sample) => (
        <Select
          size="small"
          allowClear
          placeholder="未关联"
          style={{ width: 140 }}
          value={dogId ?? undefined}
          options={dogs?.map((d) => ({ value: d.id, label: d.name ? `${d.dog_code}（${d.name}）` : d.dog_code }))}
          onChange={(v) => handleAssignDog(record, v ?? null)}
          showSearch
          optionFilterProp="label"
        />
      ),
    },
    {
      // 这一列的全部意义：让人**不点进去**就知道这段该不该看。
      // 标注员现在只有标到一半发现波形是平的、或者点开视频，才知道这半小时
      // 狗根本不在画面里（跑开了、被抱走了、摄像头对着空笼子）。
      //
      // 「未扫描」和「没狗」必须显示成不同的东西：前者是这个功能还没跑到它，
      // 后者是跑过了、确认没有。混了的话人分不清"不用看"和"还没查"。
      title: "画面",
      key: "vision",
      width: 110,
      filters: [
        { text: "有狗", value: "has_dog" },
        { text: "大部分空镜", value: "mostly_empty" },
        { text: "没狗", value: "no_dog" },
        { text: "没看成", value: "unknown" },
        { text: "未扫描", value: "unscanned" },
      ],
      onFilter: (v: React.Key | boolean, r: Sample) => (vscans?.[String(r.id)]?.verdict ?? "unscanned") === v,
      render: (_: unknown, r: Sample) => {
        const hit = vscans?.[String(r.id)];
        const v = hit?.verdict ?? "unscanned";
        const METAS: Record<string, { color?: string; text: string; tip: string }> = {
          has_dog: { color: "green", text: "有狗", tip: "画面里看得到狗" },
          mostly_empty: { color: "orange", text: "多数空镜", tip: "大部分时间画面里没狗，但不是整段都没有" },
          no_dog: { color: "red", text: "没狗", tip: "每一路都扫了、整段都没看见狗——这段可以不用看" },
          unknown: { color: "default", text: "没看成", tip: "扫了但没得出结论（视频读不出、或者有一路没扫成）。不等于没狗" },
          unscanned: { text: "未扫描", tip: "还没跑过画面扫描。不等于没狗" },
        };
        const meta = METAS[v] ?? METAS.unscanned;
        const cams = hit?.cams ?? [];
        const detail = cams.length
          ? cams.map((c) => `${c.cam}: ${c.state === "failed" ? `失败（${c.error ?? "?"}）`
              : `${c.verdict}，最多 ${c.max_dogs ?? "?"} 只`}`).join("\n")
          : "";
        return (
          <Tooltip title={detail ? `${meta.tip}\n\n${detail}` : meta.tip}>
            <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.text}</Tag>
          </Tooltip>
        );
      },
    },
    {
      // 「要标的那只狗在不在这段画面里」。跟上面那列不是一回事：
      // 上面是"画面里有没有狗"，这里是"有没有**那只**狗"。
      //
      // 判不了是一个明确的第三档，不是灰着不显示——影棚多只狗同场，光看
      // "有几只狗"判不出哪只是 bibi。判不了时说"不在"的话，影棚每份样本都会
      // 挂一个错提示，人看两次就再也不信这一列了。
      title: "那只狗",
      key: "presence",
      width: 100,
      filters: [
        { text: "在画面里", value: "present" },
        { text: "不在画面里", value: "absent" },
        { text: "判不了", value: "unknown" },
      ],
      onFilter: (v: React.Key | boolean, r: Sample) => vscans?.[String(r.id)]?.presence?.state === v,
      render: (_: unknown, r: Sample) => {
        const p = vscans?.[String(r.id)]?.presence;
        if (!p) return <Typography.Text type="secondary">-</Typography.Text>;
        const meta = {
          present: { color: "green", text: "在" },
          absent: { color: "red", text: "不在" },
          unknown: { color: undefined, text: "判不了" },
        }[p.state];
        return (
          <Tooltip title={p.reason}>
            <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.text}</Tag>
          </Tooltip>
        );
      },
    },
    { title: "时长(秒)", dataIndex: "video_duration_sec", sorter: (a: Sample, b: Sample) => (a.video_duration_sec ?? 0) - (b.video_duration_sec ?? 0) },
    { title: "CSV行数", dataIndex: "imu_row_count", sorter: (a: Sample, b: Sample) => (a.imu_row_count ?? 0) - (b.imu_row_count ?? 0), render: (n: number | null) => n ?? "-" },
    {
      // 不是所有样本一个频率：8-11 之前采集端就降到 16Hz 存了，8-11 起才是 50Hz
      // 原始流。按错的频率跑推理，重采样和特征窗口全错，所以这一列要看得见
      title: "采样率",
      dataIndex: "sample_hz",
      width: 100,
      sorter: (a: Sample, b: Sample) => (a.sample_hz ?? 0) - (b.sample_hz ?? 0),
      render: (v: number | null | undefined) =>
        v == null ? (
          <Tooltip title="导入时没量出来（老样本或时间戳解析不了）。重新扫描一次会补上">
            <Typography.Text type="secondary">—</Typography.Text>
          </Tooltip>
        ) : (
          <Tag color={v >= 40 ? "blue" : "orange"}>{v} Hz</Tag>
        ),
    },
    { title: "分辨率", dataIndex: "video_resolution" },
    { title: "错误信息", dataIndex: "import_error" },
    {
      title: "操作",
      render: (_: unknown, record: Sample) => (
        <Button size="small" type="link" onClick={() => setPreview(record)}>
          预览
        </Button>
      ),
    },
  ];

  const sensitiveCount = useMemo(() => (data ?? []).filter((s) => s.is_sensitive).length, [data]);
  const emptySamples = useMemo(() => (data ?? []).filter((s) => s.imu_row_count === 0), [data]);

  const groups = useMemo(() => {
    const map = new Map<string, Sample[]>();
    for (const s of data ?? []) {
      if (sensitiveFilter === "仅敏感" && !s.is_sensitive) continue;
      if (sensitiveFilter === "仅非敏感" && s.is_sensitive) continue;
      if (onlyEmpty && s.imu_row_count !== 0) continue;
      const key = s.session_date ?? "未知日期";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [data, sensitiveFilter, onlyEmpty]);
  // 最新的那一年默认展开（年 → 月 → 日三层，见 nestByYearMonth）
  const latestYear = groups.map(([k]) => (/^\d{4}-/.test(k) ? k.slice(0, 4) : "其他")).sort().reverse()[0];

  const handleScan = async () => {
    const result = await startImportScan();
    if (result.already_running) {
      message.info("已经有一个扫描在后台跑了，直接看进度");
    }
    startPolling();
  };

  const isRunning = progress?.status === "running";

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={handleScan} disabled={isRunning}>
          立即扫描一次
        </Button>
        <Button onClick={() => refetch()}>刷新列表</Button>
        {/* 「看全场的那一路」补挂：狗场两台采集机各自开机、落成两个 session，
            cam7 的文件名带着 2 号机的时间戳，于是只挂给了它那三间——可它拍的是
            全部六间。这里先出报告，核对偏移对不对再谈写库（写库还没开放：
            播放器还没按偏移换算，挂上去那一路的每条标注都会差几秒） */}
        {isAdmin && (
          <Tooltip title="狗场的 cam7 一台俯拍看全部六间，但因为两台采集机各自开机、落成两个 session，它现在只挂在其中三间的样本上。这里算一下该补挂给谁、时间差多少——只看报告，不改数据">
            <Button onClick={loadSharedCam} loading={sharedCamLoading}>
              公共区补挂（看报告）
            </Button>
          </Tooltip>
        )}
        {width.hasCustom && (
          <Tooltip title="列宽是拖出来的，记在这台电脑上。拖乱了点这里回到默认">
            <Button size="small" type="link" onClick={width.reset}>
              恢复列宽
            </Button>
          </Tooltip>
        )}
        <Typography.Text type="secondary">系统每 10 分钟自动扫描一次新数据，通常不用手动点</Typography.Text>
      </Space>

      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented
          options={["全部", "仅敏感", "仅非敏感"]}
          value={sensitiveFilter}
          onChange={(v) => setSensitiveFilter(v as typeof sensitiveFilter)}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          敏感样本 {sensitiveCount} 个：仅管理员/超级管理员可见可标，其他人在项目、任务、审核里都看不到
        </Typography.Text>
        {emptySamples.length > 0 && (
          <>
            <Checkbox checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)}>
              <span style={{ color: "#ff4d4f" }}>空 CSV {emptySamples.length}</span>
            </Checkbox>
            <Popconfirm
              title={`删除这 ${emptySamples.length} 个空 CSV 样本？`}
              description="文件建出来了但一行数据都没写，打开就报错、也算不出指标。会连同上面的任务、草稿、审核记录一起删；NAS 上的文件不动，只删数据库登记"
              okButtonProps={{ danger: true }}
              onConfirm={() => removeSamples(emptySamples.map((s) => s.id))}
            >
              <Button size="small" danger>
                删除空 CSV 样本
              </Button>
            </Popconfirm>
          </>
        )}
        {(missing?.total ?? 0) > 0 && (
          <>
            <Tooltip
              title={
                <div>
                  <div>这些样本在库里，但 NAS 上对应的文件已经没了——当天重录过、或者原始数据被删了。</div>
                  <div style={{ marginTop: 6 }}>点预览就是 No such file or directory。清理只删数据库登记，NAS 上本来也没东西可删。</div>
                  {(missing?.with_tasks ?? 0) > 0 && (
                    <div style={{ marginTop: 6, color: "#ffa39e" }}>
                      其中 {missing?.with_tasks} 个上面还挂着任务，删掉会连标注一起没。
                    </div>
                  )}
                </div>
              }
            >
              <Tag color="red" style={{ cursor: "help" }}>
                NAS 上已删除 {missing?.total}
              </Tag>
            </Tooltip>
            <Popconfirm
              title={`清理这 ${missing?.total} 个样本？`}
              description={
                <div style={{ maxWidth: 420 }}>
                  NAS 上文件已经没了，只删数据库登记。
                  {(missing?.with_tasks ?? 0) > 0
                    ? `其中 ${missing?.with_tasks} 个上面还挂着任务，会连同标注、草稿、审核记录一起删，不可恢复。`
                    : "这些样本上没有任何任务。"}
                </div>
              }
              okButtonProps={{ danger: true }}
              onConfirm={cleanupMissing}
            >
              <Button size="small" danger>
                清理已删除的样本
              </Button>
            </Popconfirm>
          </>
        )}
        {selected.size > 0 && (
          <>
            <Tag>已勾选 {selected.size}</Tag>
            {/* 扫描是串行的（同一张卡上还挂着 SAM，并发会把两个一起 OOM），
                一小时的视频几十秒——所以按钮上要把"要等多久"说清楚，
                不然人会以为卡死了又点一次 */}
            <Tooltip
              title={
                vstatus?.available
                  ? `跑一遍画面检测：这几段视频里有没有狗。串行，一小时的视频约几十秒，${selected.size} 份大概 ${Math.ceil(selected.size * 0.7)} 分钟。重扫会覆盖上次结果。`
                  : (vstatus?.error || "视觉服务里的狗检测不可用")
              }
            >
              <Button
                size="small"
                loading={scanning}
                disabled={!vstatus?.available}
                onClick={async () => {
                  setScanning(true);
                  try {
                    const r = await runVisionScan([...selected]);
                    const bad = r.items.filter((x) => x.failed > 0).length;
                    if (bad) message.warning(`扫完 ${r.samples} 份，其中 ${bad} 份有路没扫成——列表里会显示「没看成」，不是「没狗」`);
                    else message.success(`扫完 ${r.samples} 份`);
                    qc.invalidateQueries({ queryKey: ["vision-scans"] });
                  } catch (e) {
                    message.error(`扫描失败：${e instanceof Error ? e.message : e}`);
                  } finally {
                    setScanning(false);
                  }
                }}
              >
                扫画面有没有狗
              </Button>
            </Tooltip>
            <Select
              size="small"
              allowClear
              placeholder={`批量关联狗（${selected.size} 个）`}
              style={{ width: 190 }}
              // 不受控：选完就发请求、清空选中，下拉自己不该留着上次选的值
              value={null}
              options={dogOptions}
              onChange={(v) => assignDogBulk(v ?? null)}
              showSearch
              optionFilterProp="label"
            />
            <Popconfirm
              title={`解除这 ${selected.size} 个样本的狗关联？`}
              onConfirm={() => assignDogBulk(null)}
            >
              <Button size="small">解除关联</Button>
            </Popconfirm>
            <Button size="small" danger icon={<LockOutlined />} onClick={() => setMarkOpen(true)}>
              标记为敏感
            </Button>
            <Popconfirm title={`解除这 ${selected.size} 个样本的敏感标记？其他人将重新可见`} onConfirm={() => applyBulk(false)}>
              <Button size="small" loading={marking}>
                解除敏感
              </Button>
            </Popconfirm>
            <Popconfirm
              title={`删除勾选的 ${selected.size} 个样本？`}
              description="会连同上面的任务、草稿、审核记录一起删；NAS 上的文件不动，只删数据库登记。不可恢复"
              okButtonProps={{ danger: true }}
              onConfirm={() => removeSamples([...selected])}
            >
              <Button size="small" danger>
                删除样本
              </Button>
            </Popconfirm>
            <Button size="small" type="link" onClick={() => setSelected(new Set())}>
              取消勾选
            </Button>
          </>
        )}
      </Space>

      {progress && (progress.status === "running" || progress.status === "error") && (
        <div style={{ marginBottom: 16 }}>
          {progress.status === "running" && (
            <>
              <Progress
                percent={
                  progress.total_groups ? Math.round((progress.processed / progress.total_groups) * 100) : 0
                }
                status="active"
                format={() => `${progress.processed}/${progress.total_groups || "?"}`}
              />
              <Typography.Text type="secondary">
                已耗时 {formatDuration(progress.elapsed_sec)}
                {progress.estimated_remaining_sec != null &&
                  ` · 预计还需 ${formatDuration(progress.estimated_remaining_sec)}`}
              </Typography.Text>
            </>
          )}
          {progress.status === "error" && (
            <Alert type="error" message="扫描出错" description={progress.error_message} showIcon />
          )}
        </div>
      )}

      {isLoading ? (
        <Table loading rowKey="id" columns={columns} dataSource={[]} />
      ) : (
        <Collapse
          // 年 → 月 → 日三层，最新的年和月默认展开：几十天平铺一列太空，翻到底才看到早的
          defaultActiveKey={latestYear ? [latestYear] : []}
          items={nestByYearMonth(groups.map(([dateKey, samples]) => {
            // 日期目录下再按 imu 分成子目录：imu1/imu2/imu3/imu4 各对应一只狗，
            // 看某只狗的数据直接点开它的目录。NAS 上的文件不动，只是页面里这么归纳
            const byImu = new Map<string, Sample[]>();
            for (const smp of samples) {
              const k = imuOf(smp.sample_code);
              if (!byImu.has(k)) byImu.set(k, []);
              byImu.get(k)!.push(smp);
            }
            const renderTable = (rows: Sample[]) => (
              <Table
                rowKey="id"
                size="small"
                dataSource={rows}
                pagination={rows.length > 20 ? { pageSize: 20 } : false}
                columns={width.applyResize<Sample>(sort.applySort<Sample>(columns))}
                onChange={sort.onTableChange}
                components={width.components}
                tableLayout={width.tableLayout}
                // 拖出来的列宽要生效，表格得是固定布局——antd 靠 scroll.x 切过去
                scroll={{ x: "max-content" }}
                // antd 默认点三下是 升序 -> 降序 -> 取消排序（回到原始顺序），第三种
                // 看着像乱序；这里只在升/降之间切
                sortDirections={["ascend", "descend", "ascend"]}
                // 勾选跨日期/跨 imu 分组共用一个集合，可以在几天里各挑几个一起标
                rowSelection={{
                  selectedRowKeys: rows.filter((s) => selected.has(s.id)).map((s) => s.id),
                  onChange: (_, picked) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      rows.forEach((s) => next.delete(s.id));
                      picked.forEach((s) => next.add(s.id));
                      return next;
                    });
                  },
                }}
              />
            );
            return {
              key: dateKey,
              count: samples.length,
              // 整天删掉：NAS 上传错了、改了文件之后，库里已经登记的那批是错的，扫描只认新
              // sample_code 不会回头改。删掉这一天再扫一次，就按 NAS 上现在的样子重新进
              label: (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {dateKey}（{samples.length} 个样本）
                  <span onClick={(e) => e.stopPropagation()}>
                    <Popconfirm
                      title={`删除 ${dateKey} 这 ${samples.length} 个样本？`}
                      description="连同上面的任务、草稿、审核记录一起删；NAS 上的文件不动。之后点「立即扫描一次」会按 NAS 上现在的文件重新登记。不可恢复"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => removeSamples(samples.map((r) => r.id))}
                    >
                      <Tooltip title="NAS 上传错了 / 改过文件，库里登记的还是旧的：删掉这一天再扫一次">
                        <Button size="small" type="link" danger style={{ padding: 0 }}>删除这一天</Button>
                      </Tooltip>
                    </Popconfirm>
                  </span>
                </span>
              ),
              children: (
                <Collapse
                  size="small"
                  items={sortImuKeys(byImu.keys()).map((imu) => {
                    const rows = byImu.get(imu)!;
                    const cur = groupDog(rows);
                    return {
                      key: imu,
                      // 关联狗这件事天然是"整组一样"：一天里同一个机位戴在哪只狗身上
                      // 是固定的，一组就是 30 份（每小时一段）。所以入口放在组标题上，
                      // 比"先勾 30 个再去工具栏"少一整步——而后者恰恰是想省事的人
                      // 第一眼找不到的地方（工具栏没勾选时整个是隐藏的）。
                      label: (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span>
                            {imu}（{rows.length} 个样本）
                          </span>
                          {/* 关联状态、解除、下拉都紧跟在组名后面挨着放：摆到右边的话跟组名隔着一整行空白，
                              对不上是哪一组的 */}
                          <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            {cur ? (
                              <>
                                <Tag color={cur.mixed ? "orange" : "blue"} style={{ marginRight: 0 }}>
                                  {cur.text}
                                </Tag>
                                {/* 解除单独放一个按钮，不塞进下拉当一个选项：它是清空不是改值，混在狗名列表里太容易点错 */}
                                <Popconfirm
                                  title={`解除 ${imu} 这 ${rows.length} 个样本的狗关联？`}
                                  onConfirm={() => assignDog(rows.map((r) => r.id), null)}
                                >
                                  <Button size="small" type="link" style={{ padding: 0 }}>
                                    解除
                                  </Button>
                                </Popconfirm>
                              </>
                            ) : (
                              <Tooltip title="这一组还没关联到哪只狗。平台按狗档案里的 IMU 号也能认，但明确关联一下更稳">
                                <Tag style={{ marginRight: 0 }}>未关联</Tag>
                              </Tooltip>
                            )}
                            {/* 挡掉冒泡：不挡的话点下拉会把这个折叠面板收起来，选项列表跟着消失 */}
                            <Select
                              size="small"
                              placeholder={`整组关联到…（${rows.length} 个）`}
                              style={{ width: 200 }}
                              // 不受控：选完就发请求，下拉自己不该留着上次选的值
                              value={null}
                              options={dogOptions}
                              onChange={(v) => assignDog(rows.map((r) => r.id), v ?? null)}
                              showSearch
                              optionFilterProp="label"
                            />
                            <Popconfirm
                              title={`删除 ${imu} 这 ${rows.length} 个样本？`}
                              description="连同上面的任务、草稿、审核记录一起删；NAS 上的文件不动。之后点「立即扫描一次」会按 NAS 上现在的文件重新登记。不可恢复"
                              okButtonProps={{ danger: true }}
                              onConfirm={() => removeSamples(rows.map((r) => r.id))}
                            >
                              <Tooltip title="这一组登记错了（NAS 上传错 / 改过文件）：删掉再扫一次">
                                <Button size="small" type="link" danger style={{ padding: 0 }}>删除这组</Button>
                              </Tooltip>
                            </Popconfirm>
                          </span>
                        </div>
                      ),
                      children: renderTable(rows),
                    };
                  })}
                />
              ),
            };
          }))}
        />
      )}

      <Modal
        title={`标记 ${selected.size} 个样本为敏感`}
        open={markOpen}
        onCancel={() => setMarkOpen(false)}
        onOk={() => applyBulk(true)}
        okText="标记"
        okButtonProps={{ danger: true }}
        confirmLoading={marking}
        destroyOnClose
      >
        <Typography.Paragraph>
          标记后标注员/审核员在项目、任务、审核、视频、IMU 任何入口都看不到这些样本；已经认领的任务也会从他们列表里消失。
          只有管理员/超级管理员能看能标。之后确认不敏感可以随时解除。
        </Typography.Paragraph>
        <Input
          placeholder="备注（可选）：为什么敏感，比如「画面里有人脸」"
          maxLength={200}
          value={markNote}
          onChange={(e) => setMarkNote(e.target.value)}
        />
      </Modal>

      <Modal
        title="公共区补挂 · 报告（只看，不改数据）"
        open={sharedCam != null}
        onCancel={() => setSharedCam(null)}
        footer={null}
        width={900}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="偏移是从文件名里的开机时刻推出来的"
          description={
            <>
              狗场两台采集机各自开机、落成两个 session（<code>..._000016301_...</code> / <code>..._000012130_...</code>），
              而 cam7 一台俯拍看的是<b>全部六间</b>。补挂时必须带上两者的时间差，
              否则那一路上每条标注都会差几秒、而且错得看不出来。
              <br />
              两台机器是人手动开的，同一场差 5~8 分钟很正常（实测 2026-09-17 就是
              −317 秒和 −513 秒），所以时间差多大都可能是对的。
              <br />
              <b>「盖住多少」是"能看到多少"，不是"对不对"</b>：公共区那一路录得短、
              开得晚，覆盖就低，但重叠的那一段照样是对齐的（实测有一批只盖 52%，
              而时间差只有 1.25 秒——那是录了一半就停，不是挂错场）。覆盖低只意味着
              后半段没有公共区画面可看。
              <br />
              <b>要核对的是「重叠的那一段画面对不对得上」</b>——这只能拿两路画面上同一个
              可辨认的瞬间（狗站起来那一下）对一眼。所以下一步是：我做播放器换算，
              然后挑一天写库，你去核这一眼。
            </>
          }
        />
        {sharedCam && (
          <>
            <Table
              size="small"
              rowKey="sample_id"
              pagination={{ pageSize: 10, size: "small" }}
              dataSource={sharedCam.items}
              columns={[
                { title: "样本", dataIndex: "sample_code" },
                { title: "挂到哪个槽位", dataIndex: "slot", width: 110 },
                {
                  title: "盖住多少",
                  dataIndex: "coverage",
                  width: 110,
                  sorter: (a: { coverage: number | null }, b: { coverage: number | null }) =>
                    (a.coverage ?? -1) - (b.coverage ?? -1),
                  defaultSortOrder: "ascend" as const,
                  render: (v: number | null) =>
                    v == null ? (
                      <Tag>缺时长，算不了</Tag>
                    ) : (
                      <Tag color={v >= 0.9 ? "green" : v >= 0.5 ? "orange" : "red"}>{(v * 100).toFixed(0)}%</Tag>
                    ),
                },
                {
                  title: "时间差",
                  dataIndex: "offset_ms",
                  width: 150,
                  // 时间差不上色：它多大都可能是对的，判据在「盖住多少」那一列
                  render: (v: number) => (
                    <span>
                      {(v / 1000).toFixed(3)} 秒{v < 0 ? "（公共区先开）" : v > 0 ? "（公共区后开）" : ""}
                    </span>
                  ),
                },
                { title: "要挂的那一路", dataIndex: "path", ellipsis: true },
              ]}
            />
            <Space wrap style={{ marginTop: 12 }}>
              <Typography.Text>挂哪一天：</Typography.Text>
              <Select
                size="small"
                allowClear
                showSearch
                placeholder="挑一天（建议先只挂一天）"
                style={{ width: 300 }}
                value={sharedCamDay}
                onChange={setSharedCamDay}
                options={[...new Set(sharedCam.items.map((i) => i.path.split("/").slice(-2, -1)[0]))]
                  .sort()
                  .map((d) => ({
                    value: d,
                    label: `${d}（${sharedCam.items.filter((i) => i.path.includes(`/${d}/`)).length} 份）`,
                  }))}
              />
              <Popconfirm
                title={sharedCamDay ? `把 ${sharedCamDay} 这一天挂上？` : "把全部 561 份一次挂上？"}
                description={
                  sharedCamDay
                    ? "挂上之后去打开一个 imu9~14 的样本，两路一起播，找狗动的那一下核对。不对就告诉我，能原样退回去"
                    : "**建议先只挂一天**。偏移的前提（文件名那串数 = 开机时刻）只能拿眼睛核一次，一次全挂上而前提不成立的话，几百份样本的第二路都是错的"
                }
                okText={sharedCamDay ? "挂" : "还是先挂一天"}
                okButtonProps={{ danger: !sharedCamDay }}
                onConfirm={async () => {
                  if (!sharedCamDay) return;
                  setSharedCamBusy(true);
                  try {
                    const r = await sharedCamApply(sharedCamDay);
                    // **挂了 0 份不是成功**。报告里明明列着这一天的样本，却一份都没挂上，
                    // 只弹个绿勾的话人只能干瞪眼——要么说清哪里被挡了，要么就承认不知道
                    if (r.attached === 0) {
                      const why = Object.entries(r.skipped).map(([k, v]) => `${k} ${v}`).join("；");
                      message.warning(
                        `一份都没挂上。${why ? `被挡下的：${why}` : "报告里这一天没有待挂的样本——换一天试试"}`,
                        10,
                      );
                    } else {
                      message.success(`挂上了 ${r.attached} 份。去开一个 imu9~14 的样本核对两路画面`);
                    }
                    await loadSharedCam();
                    qc.invalidateQueries({ queryKey: ["samples"] });
                  } finally {
                    setSharedCamBusy(false);
                  }
                }}
              >
                <Button type="primary" size="small" disabled={!sharedCamDay} loading={sharedCamBusy}>
                  写库（挂上这一天）
                </Button>
              </Popconfirm>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                挂上之后播放器会自动按偏移对齐，那一路的标题上写着差了多少秒
              </Typography.Text>
            </Space>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              共 {sharedCam.items.length} 份样本该补挂
              {(() => {
                const low = sharedCam.items.filter((i) => i.coverage != null && i.coverage < 0.9).length;
                const none = sharedCam.items.filter((i) => i.coverage == null).length;
                return low || none
                  ? `（其中盖住不到 90% 的 ${low} 份${none ? `，算不了的 ${none} 份` : ""}——这几份值得点开看一眼）`
                  : "，全部盖住 90% 以上";
              })()}
              。
              {Object.entries(sharedCam.skipped).length > 0 && (
                <>
                  {" "}没挂的：
                  {Object.entries(sharedCam.skipped).map(([why, n]) => `${why} ${n}`).join("；")}
                </>
              )}
            </Typography.Paragraph>
          </>
        )}
      </Modal>

      <SamplePreviewModal
        sampleId={preview?.id ?? null}
        sampleCode={preview?.sample_code}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}
