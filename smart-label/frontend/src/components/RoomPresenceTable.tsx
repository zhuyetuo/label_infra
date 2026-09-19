import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Progress, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelRoomScan, getRoomScanStatus, listCamRegions, listRoomPresence, pauseRoomScan, resumeRoomScan, scanRoomVideo, startRoomScan,
  type RoomPresenceRow, type RoomVideo,
} from "@/api/dailyStats";
import SamplePreviewModal from "@/components/SamplePreviewModal";
import CamRegionEditor from "@/components/CamRegionEditor";

const { Text } = Typography;

const fmtH = (sec: number) => {
  if (!sec) return "0";
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} 小时 ${m} 分` : `${m} 分`;
};

/**
 * 狗场单间的采集时长：按**摄像头**算，不按 IMU 算。
 *
 * 一只狗两个项圈轮换充电、而且两个同时录，按样本加时长就是双倍，哪天只戴一个又是单倍——
 * "总共采了多少小时"按 IMU 根本算不准。一间一狗一摄像头，一段画面不管配了几个 IMU 只算一次。
 * 房间和狗都从视频文件名 `_camN_imuM` 读（采集端写死的：cam4_imu15 = 4 号单间、15 号项圈），
 * 不做重识别；「在单间里」用画面扫描（每 5 秒一点看有没有狗）的时间线算。每段画面能点开复查。
 */
export default function RoomPresenceTable({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  // 扫描跑着的时候每 5 秒刷一次：只在第一次没数据时转圈，后台刷新不遮表、不闪
  const { data, isLoading } = useQuery({
    queryKey: ["room-presence", dateFrom, dateTo],
    queryFn: () => listRoomPresence({ date_from: dateFrom, date_to: dateTo }),
    placeholderData: keepPreviousData,
  });
  const rows = data ?? [];
  const [preview, setPreview] = useState<RoomVideo | null>(null);
  const qc = useQueryClient();
  // 公共区（天花板 cam7）：各单间在它画面里的位置。没划的话 cam7 不参与单间统计
  const { data: regions } = useQuery({ queryKey: ["cam-regions", "gouchang"], queryFn: () => listCamRegions("gouchang") });
  const [regionEdit, setRegionEdit] = useState<{ cam: number; sampleId: number; slot: string } | null>(null);
  const sharedRows = rows.filter((r) => r.shared);
  const roomNos = [...new Set(rows.filter((r) => !r.shared).map((r) => Number(r.cam.replace("cam", ""))))].sort((a, b) => a - b);
  const regionsMissing = rows.some((r) => r.regions_missing);
  // 划区域要一段 cam7 的画面：挑一段扫过的（有狗框更好认），没有就随便一段
  const openRegionEditor = () => {
    const vids = sharedRows.flatMap((r) => r.videos.map((v) => ({ v, cam: Number(r.cam.replace("cam", "")) })));
    const pick = vids.find((x) => x.v.scanned) ?? vids[0];
    if (!pick) {
      message.info("这段日期里没有公共区的画面");
      return;
    }
    setRegionEdit({ cam: pick.cam, sampleId: pick.v.sample_id, slot: pick.v.slot });
  };
  const regionsOf = (cam: number) => (regions ?? []).filter((r) => r.cam === cam).map((r) => ({ label: `${r.room} 号`, x: r.x, y: r.y, w: r.w, h: r.h }));

  // 补扫是后台跑的（一段几十秒，几百段要个把小时）：跑着的时候每 3 秒问一次进度，
  // 跑完把统计刷新一下。扫描没有自动触发——扫画面吃 GPU，要人决定什么时候扫
  const { data: job } = useQuery({
    queryKey: ["room-scan-status"],
    queryFn: getRoomScanStatus,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false),
  });
  const running = job?.status === "running";
  const paused = job?.status === "paused";
  const active = running || paused;
  useEffect(() => {
    if (job?.status === "done" || job?.status === "error" || job?.status === "cancelled") qc.invalidateQueries({ queryKey: ["room-presence"] });
  }, [job?.status, qc]);
  // 跑着的时候统计也跟着刷（每段扫完就写库了，不用等整批结束）
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => qc.invalidateQueries({ queryKey: ["room-presence"] }), 5_000);
    return () => clearInterval(t);
  }, [running, qc]);
  const nPending = rows.reduce((a, r) => a + r.n_unscanned, 0);
  const refreshJob = () => qc.invalidateQueries({ queryKey: ["room-scan-status"] });
  const handleScan = async (force = false) => {
    const r = await startRoomScan({ date_from: dateFrom, date_to: dateTo, force });
    if (r.already_running) message.info("已经有一批在后台扫了，看进度就行");
    else if (!r.started) message.info("这段日期没有要扫的");
    else message.success(`开始扫 ${r.total} 段，${job?.concurrency ?? 4} 路并行，可以先干别的`);
    refreshJob();
  };
  const [scanningOne, setScanningOne] = useState<string | null>(null);
  const handleScanOne = async (v: RoomVideo) => {
    setScanningOne(v.file);
    try {
      const r = await scanRoomVideo({ sample_id: v.sample_id, slot: v.slot });
      message.success(`扫完：${r.sampled} 个采样点，${r.frames_with_dog} 个有狗`);
      qc.invalidateQueries({ queryKey: ["room-presence"] });
    } finally {
      setScanningOne(null);
    }
  };

  // 每个单间在这段日期里的累计：录了多久、扫了多久、有狗多久
  const totals = useMemo(() => {
    const m = new Map<string, { cam: string; dog: Set<string>; rec: number; scanned: number; present: number; unscanned: number; days: Set<string> }>();
    for (const r of rows) {
      if (r.shared) continue;
      const t = m.get(r.cam) ?? { cam: r.cam, dog: new Set(), rec: 0, scanned: 0, present: 0, unscanned: 0, days: new Set() };
      if (r.dog_name) t.dog.add(r.dog_name);
      t.rec += r.recorded_seconds;
      t.scanned += r.scanned_seconds;
      t.present += r.present_seconds;
      t.unscanned += r.n_unscanned;
      t.days.add(r.stat_date);
      m.set(r.cam, t);
    }
    return [...m.values()].sort((a, b) => a.cam.localeCompare(b.cam, undefined, { numeric: true }));
  }, [rows]);
  const grand = totals.reduce((a, t) => ({ rec: a.rec + t.rec, present: a.present + t.present, scanned: a.scanned + t.scanned }), { rec: 0, present: 0, scanned: 0 });
  const anyUnscanned = rows.some((r) => r.n_unscanned > 0);
  const anyOver = rows.some((r) => r.over_day);

  const pct = (present: number, scanned: number) => (scanned > 0 ? `${Math.round((present / scanned) * 100)}%` : "—");

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
      <Alert
        type="info"
        showIcon
        message="按摄像头算，不按 IMU 算；狗是按视频文件名认的，不是识别出来的"
        description={
          <>
            <div>一只狗两个项圈同时录，按样本加时长会翻倍。这里一间一路画面，同一段视频只算一次。</div>
            <div>
              狗场一间一狗，采集端把「几号单间、几号项圈」写死在文件名里（cam4_imu15），狗 = 文件名里的项圈号 → 狗档案。
              不看样本挂的是哪个 IMU（老数据里有一批错误导入的样本把所有房间的画面都挂到了每只狗名下）。
            </div>
            <div>「在单间里」是画面扫描（每 5 秒看一次有没有狗）里有狗的时间。展开一行能看每段画面，点「看画面」复查。天花板公用机位不算。</div>
          </>
        }
      />
      {(anyUnscanned || active || job?.status === "error" || job?.status === "cancelled") && (
        <Alert
          type={job?.status === "error" ? "error" : "warning"}
          showIcon
          message={
            active
              ? `${paused ? "已暂停" : "正在扫"}：${job!.done + job!.failed} / ${job!.total} 段${job!.failed ? `，失败 ${job!.failed}` : ""}${running && job!.estimated_remaining_sec != null ? `，预计还要 ${Math.ceil(job!.estimated_remaining_sec / 60)} 分钟` : ""}`
              : job?.status === "error"
                ? `上一批扫描出错：${job.error}`
                : job?.status === "cancelled"
                  ? `上一批已取消：扫了 ${job.done} 段，剩下的没扫。还有 ${nPending} 段没扫`
                  : `有 ${nPending} 段还没扫过画面，它们的时间只算进「录了多久」，不算进「在单间里」`
          }
          description={
            active ? (
              <div>
                <Progress percent={Math.round(((job!.done + job!.failed) / Math.max(1, job!.total)) * 100)} size="small" status={paused ? "normal" : "active"} />
                <Space wrap size={8}>
                  {running ? (
                    <Tooltip title="立刻停：正在扫的那几段直接中断、回到队列，继续时先扫它们">
                      <Button size="small" onClick={async () => { await pauseRoomScan(); refreshJob(); }}>暂停</Button>
                    </Tooltip>
                  ) : (
                    <Button size="small" type="primary" onClick={async () => { await resumeRoomScan(); refreshJob(); }}>继续</Button>
                  )}
                  <Tooltip title="立刻停，剩下的不扫了；已经扫完的结果留着，下次只扫剩下的">
                    <Button size="small" danger onClick={async () => { await cancelRoomScan(); refreshJob(); }}>取消</Button>
                  </Tooltip>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {job!.concurrency} 路并行（{job!.date_from} ~ {job!.date_to}）
                    {job!.current?.length ? `，正在扫：${job!.current.join("、")}` : ""}
                  </Text>
                </Space>
              </div>
            ) : (
              <Space wrap>
                <Tooltip title="扫描不会自动跑：扫画面吃算法机的 GPU，什么时候扫由人决定。只扫这段日期里没扫过的，扫过的不重扫；同一段画面挂在几份样本上也只扫一次。几路并行，一小时的视频几秒钟">
                  <Button type="primary" size="small" onClick={() => handleScan(false)} disabled={nPending === 0}>
                    扫这段日期没扫的画面（{nPending} 段）
                  </Button>
                </Tooltip>
                <Tooltip title="连扫过的也重扫一遍（换了检测权重、或者老结果没存框的时候用）">
                  <Button size="small" onClick={() => handleScan(true)}>全部重扫</Button>
                </Tooltip>
                <Text type="secondary" style={{ fontSize: 12 }}>先在「模型服务」页确认狗检测（YOLO）已加载。展开某一行也可以单独扫一段</Text>
              </Space>
            )
          }
        />
      )}
      {sharedRows.length > 0 && (
        <Alert
          type={regionsMissing ? "warning" : "info"}
          showIcon
          message={regionsMissing ? "公共区（cam7）还没划分各单间的位置，它看到的狗暂时没算进单间" : "公共区（cam7）已划分各单间的位置，跟单间机位取并集补死角"}
          description={
            <Space wrap>
              <Button size="small" type={regionsMissing ? "primary" : "default"} onClick={openRegionEditor}>
                {regionsMissing ? "划分公共区区域" : "重新划分"}
              </Button>
              <Text type="secondary" style={{ fontSize: 12 }}>
                cam7 是固定机位，每间在画面里的位置不变，框一次就行。cam7 里检出的狗按框的中心落在哪一块算哪间，跟那间自己的机位按绝对时刻对齐取并集
              </Text>
            </Space>
          }
        />
      )}
      {anyOver && (
        <Alert
          type="error"
          showIcon
          message="有单间一天录了超过 24 小时"
          description="同一段画面多半以不同名字导了两遍（两台机器各传一份、或者原始和重采样各一份但时间戳不一样）。展开那一行看是哪几段重了。"
        />
      )}
      <Table
        size="small"
        rowKey="cam"
        pagination={false}
        loading={isLoading}
        title={() => (
          <b>
            这段日期累计：录了 {fmtH(grand.rec)}，扫过 {fmtH(grand.scanned)}，画面里有狗 {fmtH(grand.present)}
            {grand.scanned > 0 ? `（占扫过的 ${pct(grand.present, grand.scanned)}）` : ""}
            {!anyUnscanned && !active && rows.length > 0 && (
              <Tooltip title="连扫过的也重扫一遍（换了检测权重、或者老结果没存框的时候用）">
                <Button size="small" type="link" onClick={() => handleScan(true)}>全部重扫</Button>
              </Tooltip>
            )}
          </b>
        )}
        dataSource={totals}
        columns={[
          { title: "单间", dataIndex: "cam", width: 110, render: (c: string) => <Tag>{c.replace("cam", "")} 号（{c}）</Tag> },
          { title: "狗", width: 140, render: (_, t) => [...t.dog].join("、") || <Text type="secondary">未登记</Text> },
          { title: "有数据的天数", width: 110, render: (_, t) => t.days.size },
          { title: "录了多久", render: (_, t) => fmtH(t.rec) },
          {
            title: <Tooltip title="只按扫过画面的那些段算，没扫的段不算">扫过多久</Tooltip>,
            render: (_, t) => fmtH(t.scanned),
          },
          {
            title: <Tooltip title="扫过的段里，画面里有狗的时间。评估「这间到底采到了多少有狗的数据」看这个">在单间里</Tooltip>,
            render: (_, t) => (
              <span>
                <b>{fmtH(t.present)}</b>
                <Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>{pct(t.present, t.scanned)}</Text>
              </span>
            ),
          },
          { title: "没扫的段", width: 90, render: (_, t) => (t.unscanned ? <Tag color="orange">{t.unscanned}</Tag> : "0") },
        ]}
      />
      <Table
        size="small"
        rowKey={(r) => `${r.stat_date}-${r.cam}`}
        loading={isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50, showSizeChanger: true }}
        expandable={{
          expandedRowRender: (r: RoomPresenceRow) => (
            <Table
              size="small"
              rowKey="file"
              pagination={false}
              dataSource={r.videos}
              columns={[
                { title: "开始", dataIndex: "start", width: 90, render: (v: string | null) => v ?? "—" },
                { title: "文件", dataIndex: "file", render: (f: string) => <Text style={{ fontSize: 12 }}>{f}</Text> },
                {
                  title: "狗（按文件名）",
                  width: 150,
                  render: (_: unknown, v: RoomVideo) => (
                    <Space size={4}>
                      <b>{v.imu ? v.dog_name || "未登记" : "公共区"}</b>
                      <Text type="secondary" style={{ fontSize: 12 }}>{v.imu ?? ""}</Text>
                    </Space>
                  ),
                },
                { title: "时长", width: 110, render: (_: unknown, v: RoomVideo) => fmtH(v.duration_seconds) },
                {
                  title: "有狗",
                  width: 130,
                  render: (_: unknown, v: RoomVideo) =>
                    v.job === "scanning" ? (
                      <Tag color="processing">扫描中</Tag>
                    ) : v.job === "queued" ? (
                      <Tag color="blue">排队中{v.scanned ? "（重扫）" : ""}</Tag>
                    ) : v.scanned && v.present_seconds != null ? (
                      <span>
                        {fmtH(v.present_seconds)}
                        <Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>{pct(v.present_seconds, v.duration_seconds)}</Text>
                      </span>
                    ) : (
                      <Tag color="orange">没扫</Tag>
                    ),
                },
                {
                  title: "样本",
                  render: (_: unknown, v: RoomVideo) => (
                    <span style={{ fontSize: 12 }}>
                      {v.sample_code}
                      {v.also_on.length > 0 && (
                        <Tooltip title={`这段画面还挂在这些样本上（轮换的另一个项圈，或者错误导入的）：${v.also_on.join("、")}`}>
                          <Text type="secondary" style={{ marginLeft: 6 }}>+{v.also_on.length}</Text>
                        </Tooltip>
                      )}
                    </span>
                  ),
                },
                {
                  title: "",
                  width: 170,
                  render: (_: unknown, v: RoomVideo) => (
                    <Space size={0}>
                      <Tooltip title={v.scanned ? "看画面，扫描到的狗会用绿框叠在视频上" : "还没扫，看画面时没有框"}>
                        <Button size="small" type="link" onClick={() => setPreview(v)}>
                          看画面
                        </Button>
                      </Tooltip>
                      <Tooltip title={v.scanned ? "重扫这一段（几秒钟）" : "单独扫这一段（几秒钟），不用等整批"}>
                        <Button size="small" type="link" loading={scanningOne === v.file} disabled={!!scanningOne || running} onClick={() => handleScanOne(v)}>
                          {v.scanned ? "重扫" : "扫这段"}
                        </Button>
                      </Tooltip>
                    </Space>
                  ),
                },
              ]}
            />
          ),
        }}
        columns={[
          { title: "日期", dataIndex: "stat_date", width: 110, sorter: (a: RoomPresenceRow, b: RoomPresenceRow) => a.stat_date.localeCompare(b.stat_date) },
          {
            title: "单间",
            dataIndex: "cam",
            width: 100,
            sorter: (a: RoomPresenceRow, b: RoomPresenceRow) => a.cam.localeCompare(b.cam, undefined, { numeric: true }),
            render: (c: string, r: RoomPresenceRow) => (r.shared ? <Tag>公共区 {c}</Tag> : c),
          },
          {
            title: <Tooltip title="按视频文件名里的项圈号查狗档案，不是识别出来的">狗</Tooltip>,
            width: 170,
            render: (_: unknown, r: RoomPresenceRow) => (
              <Space size={4}>
                <b>{r.dog_name || "未登记"}</b>
                <Text type="secondary" style={{ fontSize: 12 }}>{r.imus.join(" / ")}</Text>
              </Space>
            ),
          },
          { title: "段数", dataIndex: "n_videos", width: 70 },
          {
            title: "录了多久",
            render: (_: unknown, r: RoomPresenceRow) => (
              <span>
                {fmtH(r.recorded_seconds)}
                {r.over_day && <Tag color="red" style={{ marginLeft: 6 }}>超过 24 小时</Tag>}
              </span>
            ),
          },
          { title: "扫过多久", render: (_: unknown, r: RoomPresenceRow) => fmtH(r.scanned_seconds) },
          {
            title: <Tooltip title="自己机位看到有狗的时间 ∪ 公共区（cam7）里落在这间区域的狗的时间。括号里是 cam7 补上的、自己机位没看到的部分">在单间里</Tooltip>,
            render: (_: unknown, r: RoomPresenceRow) =>
              r.shared ? (
                <Tooltip title="公共区画面里有狗（任何一间）的时间；它的贡献已经按区域算进各单间那一行了">
                  <Text type="secondary">{fmtH(r.present_own_seconds)} 有狗</Text>
                </Tooltip>
              ) : (
                <span>
                  <b>{fmtH(r.present_seconds)}</b>
                  <Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>{pct(r.present_seconds, r.scanned_seconds)}</Text>
                  {r.present_shared_extra_seconds > 0 && (
                    <Tooltip title={`自己机位 ${fmtH(r.present_own_seconds)}，cam7 补了 ${fmtH(r.present_shared_extra_seconds)}`}>
                      <Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>（+{fmtH(r.present_shared_extra_seconds)} 来自公共区）</Text>
                    </Tooltip>
                  )}
                  {r.regions_missing && (
                    <Tooltip title="公共区还没划这间的区域，cam7 没参与">
                      <Tag style={{ marginLeft: 6 }}>没划区域</Tag>
                    </Tooltip>
                  )}
                </span>
              ),
          },
          {
            title: "没扫的段",
            width: 130,
            render: (_: unknown, r: RoomPresenceRow) => (
              <span>
                {r.n_unscanned ? <Tag color="orange">{r.n_unscanned}</Tag> : "0"}
                {r.n_in_job > 0 && (
                  <Tooltip title="这批后台扫描里排队或正在扫的段数（全部重扫时已经扫过的段也会在这里）">
                    <Tag color="processing" style={{ marginLeft: 4 }}>扫描中 {r.n_in_job}</Tag>
                  </Tooltip>
                )}
              </span>
            ),
          },
        ]}
      />
      <SamplePreviewModal
        sampleId={preview?.sample_id ?? null}
        sampleCode={preview?.sample_code}
        onClose={() => setPreview(null)}
        // 预览公共区那段时把各单间的区域用虚线叠上去
        regionsBySlot={preview && !preview.imu ? { [preview.slot]: regionsOf(Number((preview.file.match(/_cam(\d+)_raw/) ?? [])[1] ?? 7)) } : undefined}
      />
      {regionEdit && (
        <CamRegionEditor
          open
          onClose={() => setRegionEdit(null)}
          site="gouchang"
          cam={regionEdit.cam}
          sampleId={regionEdit.sampleId}
          slot={regionEdit.slot}
          rooms={roomNos}
        />
      )}
    </Space>
  );
}
