import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Checkbox, Dropdown, Empty, Input, InputNumber, Modal, Radio, Select, Space, Table, Tag, Tooltip, Typography, message,
} from "antd";
import { CheckOutlined, DownOutlined, RightOutlined, RollbackOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listLabels } from "@/api/labels";
import { getTask } from "@/api/tasks";
import { segClaim, segDecide, segEdit, segQueue, segRelease, type SegItem, type SegStatus } from "@/api/segReview";
import AnnotationWorkspace from "@/components/AnnotationWorkspace";
import { formatMs, REVIEW_NOTE_PRESETS } from "@/components/SegmentPanel";
import { useAuthStore } from "@/stores/authStore";
import type { Task } from "@/types";
import { Navigate } from "react-router-dom";

/**
 * 片段审核：审核、退回、修改的最小单位是一条片段，不是整个任务。
 *
 * 人手少，不可能所有项目的片段都标完审完再用。要做的是「重点补某几类想识别的数据」：
 * 挑一个类别，跨所有项目一条条看——起止准不准、类别对不对、有没有混进别的动作。
 * 通过的才算高质量数据（导出训练集可以选「只要片段审核通过的」）。
 *
 *   审核员 / 管理员：选类别 → 领一批（别人看不到这一批，24 小时没审完自动放回）→ 逐条
 *                   通过 / 退回（写原因）/ 在波形浮窗里直接改好起止再通过
 *   标注员：看「退回给我的」，逐条改；改了起止就自动交回重审，没改的点「改好了」
 */

const STATUS_META: Record<SegStatus, { label: string; color: string }> = {
  pending: { label: "待审", color: "default" },
  returned: { label: "退回", color: "red" },
  approved: { label: "通过", color: "green" },
};

// 刷新页面回来还是原样：筛选条件、正在改的是哪一条，存在 localStorage（按用户分开）
const loadJson = <T,>(k: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(k) || "null") as T | null;
  } catch {
    return null;
  }
};
const saveJson = (k: string, v: unknown) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* 存不了就算了 */
  }
};
type SavedFilters = {
  labelName: string | null; status: SegStatus | "all"; mine: boolean; withAi: boolean;
  order?: "time" | "long"; minSec?: number | null;
};

export default function SegmentReview() {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.userInfo?.role);
  const userId = useAuthStore((s) => s.userInfo?.id);
  const isReviewer = role === "admin" || role === "super_admin" || role === "reviewer";

  const { data: labels } = useQuery({ queryKey: ["labels", "all"], queryFn: () => listLabels() });
  // 类别按名字选（跨项目）：同一个「抓挠-头颈耳」每个项目一条，id 不一样
  const labelOptions = useMemo(() => {
    const names = [...new Set((labels ?? []).filter((l) => l.is_active !== false).map((l) => l.display_name))];
    names.sort((a, b) => a.localeCompare(b));
    // 「抓挠-头颈耳」缩进挂在「抓挠」下面，一眼看出层级
    return names.map((n) => ({ value: n, label: `${"　".repeat(n.split("-").length - 1)}${n}` }));
  }, [labels]);

  const labelColorOf = (id: number) => (labels ?? []).find((l) => l.id === id)?.color ?? null;
  const filtersKey = `seg-review-filters:${userId ?? ""}`;
  const openKey = `seg-review-open:${userId ?? ""}`;
  const saved = loadJson<SavedFilters>(filtersKey);
  const [labelName, setLabelName] = useState<string | null>(saved?.labelName ?? null);
  const [status, setStatus] = useState<SegStatus | "all">(saved?.status ?? (isReviewer ? "pending" : "returned"));
  const [mine, setMine] = useState(saved?.mine ?? isReviewer);
  const [withAi, setWithAi] = useState(saved?.withAi ?? false);
  // 长片段优先：长的往往更干净，先审先进数据池
  const [order, setOrder] = useState<"time" | "long">(saved?.order ?? "time");
  const [minSec, setMinSec] = useState<number | null>(saved?.minSec ?? null);
  useEffect(
    () => saveJson(filtersKey, { labelName, status, mine, withAi, order, minSec }),
    [filtersKey, labelName, status, mine, withAi, order, minSec],
  );
  const [claimN, setClaimN] = useState(30);

  const params = {
    label_name: labelName,
    seg_status: status,
    source: (withAi ? "all" : "touched") as "all" | "touched",
    mine: isReviewer && mine,
    order,
    min_sec: minSec || null,
  };
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["seg-queue", params],
    queryFn: () => segQueue(params),
    // 审核员不选类别就不拉：跨所有类别的列表又长又没法审
    enabled: !isReviewer || !!labelName || mine,
  });
  const rows = data?.items ?? [];

  // ── 打开工作台审一条 ──
  const [cur, setCur] = useState<SegItem | null>(null);
  const [curTask, setCurTask] = useState<Task | null>(null);
  const open = async (it: SegItem) => {
    const t = await getTask(it.task_id);
    setCur(it);
    setCurTask(t);
  };
  // 正在改的那一条跟着存；刷新回来自动打开（打不开——任务删了 / 没权限——就算了）
  useEffect(() => {
    if (cur) saveJson(openKey, cur);
  }, [openKey, cur]);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    // 等登录信息到了再恢复（key 按用户分开）
    if (restored || userId == null) return;
    setRestored(true);
    const it = loadJson<SegItem>(openKey);
    if (it?.id && it.task_id) open(it).catch(() => saveJson(openKey, null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);
  const close = () => {
    saveJson(openKey, null);
    setCur(null);
    setCurTask(null);
    qc.invalidateQueries({ queryKey: ["seg-queue"] });
    // 菜单 / 项目列表上的红色数字跟着变
    qc.invalidateQueries({ queryKey: ["seg-returned-summary"] });
  };
  // 审完一条接着下一条：按当前列表的顺序，跳过刚审的这条
  const goNext = async () => {
    const r = await refetch();
    const list = (r.data?.items ?? []).filter((x) => x.id !== cur?.id);
    const idx = rows.findIndex((x) => x.id === cur?.id);
    const next = list.find((x) => rows.findIndex((y) => y.id === x.id) > idx) ?? list[0];
    if (next) await open(next);
    else {
      message.success("这一批审完了");
      close();
    }
  };
  const decide = async (d: "approved" | "returned" | "pending", note?: string) => {
    if (!cur) return;
    await segDecide(cur.id, d, note);
    qc.invalidateQueries({ queryKey: ["seg-returned-summary"] });
    message.success(d === "approved" ? "已通过" : d === "returned" ? "已退回" : "已交回重审");
    await goNext();
  };
  const askReturn = (preset?: string) => {
    let note = preset ?? "";
    if (preset) return decide("returned", preset);
    Modal.confirm({
      title: "退回原因",
      content: <Input.TextArea autoFocus rows={2} maxLength={300} onChange={(e) => (note = e.target.value)} />,
      okText: "退回",
      onOk: () => (note.trim() ? decide("returned", note.trim()) : Promise.reject(message.warning("写一下原因"))),
    });
  };

  // 改类别：退回原因常常就是「类别错了」，光能拖起止改不了。改完让工作台重新拉一遍草稿
  const [reloadKey, setReloadKey] = useState(0);
  const projLabels = curTask ? (labels ?? []).filter((l) => l.project_id === curTask.project_id) : [];
  const relabel = async (labelId: number) => {
    if (!cur || labelId === cur.label_id) return;
    const r = await segEdit(cur.id, { start_time_ms: cur.start_time_ms, end_time_ms: cur.end_time_ms, label_id: labelId });
    const name = projLabels.find((l) => l.id === labelId)?.display_name ?? `#${labelId}`;
    setCur({ ...cur, label_id: labelId, label_name: name, seg_status: r.seg_status });
    setReloadKey((k) => k + 1);
    qc.invalidateQueries({ queryKey: ["seg-returned-summary"] });
    message.success(isReviewer ? `已改成「${name}」` : `已改成「${name}」，交回重审了`);
  };

  const actions = cur && (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        片段审核 · {cur.label_name} · 第 {Math.max(1, rows.findIndex((x) => x.id === cur.id) + 1)} / {rows.length} 条
      </Typography.Text>
      {cur.review_note && <Tag color="red">退回原因：{cur.review_note}</Tag>}
      <span style={{ flex: 1 }} />
      <Tooltip title="类别不对就在这里改。标注员改了自动交回重审">
        <Select
          size="small"
          showSearch
          style={{ width: 150 }}
          value={cur.label_id}
          optionFilterProp="label"
          popupMatchSelectWidth={false}
          onChange={relabel}
          options={projLabels.filter((l) => l.is_active !== false || l.id === cur.label_id)
            .map((l) => ({ value: l.id, label: l.display_name }))}
        />
      </Tooltip>
      {isReviewer ? (
        <>
          <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => decide("approved")}>通过</Button>
          <Dropdown
            menu={{
              items: [...REVIEW_NOTE_PRESETS.map((t) => ({ key: t, label: t })), { key: "__other", label: "其他原因…" }],
              onClick: ({ key }) => askReturn(key === "__other" ? undefined : key),
            }}
          >
            <Button size="small" danger icon={<RollbackOutlined />}>退回 <DownOutlined /></Button>
          </Dropdown>
        </>
      ) : (
        <Tooltip title="改了起止会自动交回重审；起止没问题、确认改好了的点这个">
          <Button size="small" type="primary" onClick={() => decide("pending")}>改好了，交回重审</Button>
        </Tooltip>
      )}
      <Button size="small" icon={<RightOutlined />} onClick={goNext}>下一条</Button>
    </div>
  );

  const claim = async () => {
    if (!labelName) return message.warning("先选要审的类别");
    const r = await segClaim({ label_name: labelName, n: claimN, source: withAi ? "all" : "touched", order, min_sec: minSec || null });
    message[r.claimed ? "success" : "info"](r.claimed ? `领了 ${r.claimed} 条` : "这一类没有能领的待审片段了");
    setMine(true);
    setStatus("pending");
    refetch();
  };

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={isReviewer ? "按类别一条条审：要的是起止准、类别对、没混别的动作的高质量片段" : "退回给你的片段"}
        description={
          isReviewer ? (
            <>
              选类别 → <b>领一批</b>（领了别人看不到，24 小时没审完自动放回）→ 点「审」打开，片段自动循环播放，
              波形浮窗里看波形、拖起止改好 → <b>通过</b> / <b>退回</b>（写原因）→ 自动跳下一条。
              只看人碰过的片段；没人看过的 AI 片段勾「含 AI 未确认」才出来。导出训练集可以选「只要片段审核通过的」。
            </>
          ) : (
            <>审核员退回的片段，点「改」打开：按退回原因在波形浮窗里把起止改好（改了自动交回重审），没改动但确认没问题的点「改好了」。</>
          )
        }
      />
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          showSearch
          allowClear
          style={{ width: 220 }}
          placeholder="选要审的类别"
          value={labelName ?? undefined}
          onChange={(v) => setLabelName(v ?? null)}
          options={labelOptions}
          optionFilterProp="value"
          // 选中后显示原名，不带下拉里那几个缩进空格
          optionLabelProp="value"
        />
        <Radio.Group size="small" value={status} onChange={(e) => setStatus(e.target.value)} optionType="button" buttonStyle="solid">
          {(["pending", "returned", "approved"] as SegStatus[]).map((s) => (
            <Radio.Button key={s} value={s}>
              {STATUS_META[s].label} {data?.counts?.[s] ?? ""}
            </Radio.Button>
          ))}
          <Radio.Button value="all">全部</Radio.Button>
        </Radio.Group>
        <Radio.Group size="small" value={order} onChange={(e) => setOrder(e.target.value)} optionType="button">
          <Radio.Button value="time">按时间</Radio.Button>
          <Tooltip title="最长的排前面，「领这么多条」也从最长的领起">
            <Radio.Button value="long">长片段优先</Radio.Button>
          </Tooltip>
        </Radio.Group>
        <Tooltip title="只看不短于这么多秒的片段（领的时候也一样）">
          <InputNumber
            size="small"
            min={0}
            step={5}
            value={minSec}
            onChange={(v) => setMinSec(v ?? null)}
            placeholder="最短"
            addonAfter="秒以上"
            style={{ width: 130 }}
          />
        </Tooltip>
        {isReviewer && (
          <>
            <Checkbox checked={mine} onChange={(e) => setMine(e.target.checked)}>只看我领的 {data?.mine ?? ""}</Checkbox>
            <Checkbox checked={withAi} onChange={(e) => setWithAi(e.target.checked)}>
              <Tooltip title="默认只审人碰过的（确认过 / 改过 / 人加的）。勾上把没人看过的 AI 片段也拿来审——审核通过就算确认">
                含 AI 未确认
              </Tooltip>
            </Checkbox>
            <Space.Compact>
              <InputNumber size="small" min={1} max={500} value={claimN} onChange={(v) => setClaimN(v ?? 30)} style={{ width: 70 }} />
              <Button size="small" type="primary" onClick={claim} disabled={!labelName}>领这么多条</Button>
            </Space.Compact>
            {(data?.mine ?? 0) > 0 && (
              <Button size="small" onClick={async () => { const r = await segRelease(); message.success(`放回 ${r.released} 条`); refetch(); }}>
                放回我领的
              </Button>
            )}
          </>
        )}
      </Space>

      <Table<SegItem>
        size="small"
        rowKey="id"
        loading={isFetching && !data}
        dataSource={rows}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        locale={{
          emptyText: (
            <Empty description={isReviewer && !labelName && !mine ? "先选一个类别" : mine ? "你没有领着的片段，选类别后点「领这么多条」" : "没有"} />
          ),
        }}
        rowClassName={(r) => (r.id === cur?.id ? "ant-table-row-selected" : "")}
        columns={[
          {
            title: "类别", dataIndex: "label_name", width: 140,
            // 跟工作台、项目页同一个颜色：一眼认出是哪类
            render: (v: string, r) => <Tag color={labelColorOf(r.label_id) ?? undefined}>{v}</Tag>,
          },
          {
            title: "样本", width: 260,
            render: (_, r) => (
              <Typography.Text style={{ fontSize: 12 }}>
                {r.project_name} · {r.sample_code} <Typography.Text type="secondary">#{r.task_id}</Typography.Text>
              </Typography.Text>
            ),
          },
          { title: "起止", width: 200, render: (_, r) => `${formatMs(r.start_time_ms)} ~ ${formatMs(r.end_time_ms)}` },
          { title: "时长", width: 70, sorter: (a, b) => (a.end_time_ms - a.start_time_ms) - (b.end_time_ms - b.start_time_ms), render: (_, r) => `${((r.end_time_ms - r.start_time_ms) / 1000).toFixed(1)}s` },
          {
            title: "来历", width: 150,
            render: (_, r) => (
              <Space size={2}>
                {r.source_type === "ai_generated" ? (
                  <Tag color={r.is_modified ? "blue" : r.ai_confirmed ? "green" : "orange"}>
                    {r.is_modified ? "AI 已纠正" : r.ai_confirmed ? "AI 已确认" : "AI 未确认"}
                  </Tag>
                ) : r.from_candidate_id ? <Tag color="cyan">疑似确认</Tag> : <Tag>人工</Tag>}
                {r.n_boundary_edits > 0 && <Tag color="geekblue">调过 {r.n_boundary_edits} 次</Tag>}
              </Space>
            ),
          },
          {
            title: "状态", width: 220,
            render: (_, r) => (
              <Space size={2} wrap>
                <Tag color={STATUS_META[r.seg_status].color}>{STATUS_META[r.seg_status].label}</Tag>
                {r.review_note && <Tag color="red">{r.review_note}</Tag>}
                {r.seg_reviewed_by_name && r.seg_status !== "pending" && (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>{r.seg_reviewed_by_name}</Typography.Text>
                )}
                {r.claimed_by && r.claimed_by !== userId && <Tag>{r.claimed_by_name} 在审</Tag>}
              </Space>
            ),
          },
          {
            title: "操作", width: 80,
            render: (_, r) => (
              <Button size="small" type="link" onClick={() => open(r)}>{isReviewer ? "审" : "改"}</Button>
            ),
          },
        ]}
      />

      {curTask && cur && (
        <AnnotationWorkspace
          task={curTask}
          labels={(labels ?? []).filter((l) => l.project_id === curTask.project_id)}
          readOnly
          initialSeekMs={cur.start_time_ms}
          onClose={close}
          segReview={{
            itemId: cur.id,
            onEdit: async (s, e) => {
              const r = await segEdit(cur.id, { start_time_ms: s, end_time_ms: e });
              // 标注员改了起止就交回重审：红色数字少一条
              qc.invalidateQueries({ queryKey: ["seg-returned-summary"] });
              setCur({ ...cur, start_time_ms: r.start_time_ms, end_time_ms: r.end_time_ms, seg_status: r.seg_status });
            },
            actions,
            reloadKey,
            onChanged: (m) => {
              // 拆开 / 改了：都回到待审。红色数字少一条，列表刷新（拆出来的新段也会出现在待审里）
              qc.invalidateQueries({ queryKey: ["seg-returned-summary"] });
              qc.invalidateQueries({ queryKey: ["seg-queue"] });
              setCur({ ...cur, ...m, seg_status: "pending" });
            },
          }}
        />
      )}
    </div>
  );
}

/** /segment-review：标注员看退回给自己的片段；审核员 / 管理员转到审核页的「片段审核」标签 */
export function SegmentReviewEntry() {
  const role = useAuthStore((s) => s.userInfo?.role);
  if (role === "admin" || role === "super_admin" || role === "reviewer") return <Navigate to="/reviews?tab=seg" replace />;
  return <SegmentReview />;
}
