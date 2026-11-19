import { useEffect, useMemo, useState } from "react";
import DogAvatar from "@/components/DogAvatar";
import {
  Alert, Button, Card, Col, Empty, Modal, Pagination, Popconfirm, Row, Select, Space, Spin, Tag, Tooltip,
  Typography, message,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { dogPhotoUrl, listDogPhotos } from "@/api/dogs";
import DogPhotos from "@/components/DogPhotos";
import {
  listCamSessions, resetCamMap, saveCamBatch, type CamCheckSample, type CamCheckSegment,
} from "@/api/camMap";

/** 文件名里那串开机时刻 → 给人看的时间 */
function sessionTime(key: string): string {
  const m = /_(\d{8})_(\d{2})(\d{2})(\d{2})(\d{3})/.exec(key);
  return m ? `${m[2]}:${m[3]}:${m[4]}` : key;
}

/** 一路画面的第一帧当缩略图。media token 要单独换，换不到就只显示文件名 */
function CamThumb({ mediaId }: { mediaId: number | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);
    if (mediaId == null) return;
    getMediaToken(mediaId)
      .then(({ token }) => alive && setUrl(mediaStreamUrl(mediaId, token)))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [mediaId]);

  if (url == null) {
    return (
      <div style={{ aspectRatio: "16 / 9", background: "#111", color: "#888", display: "grid",
                    placeItems: "center", fontSize: 12 }}>
        {mediaId == null ? "没有可播放的文件" : failed ? "取画面失败" : "加载画面…"}
      </div>
    );
  }
  return (
    <video
      src={url}
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={(e) => {
        // 跳到第 1 秒：第 0 帧常常是黑的
        if (e.currentTarget.duration > 1) e.currentTarget.currentTime = 1;
      }}
      style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", background: "#111", borderRadius: 4 }}
    />
  );
}

/** 一路画面旁边挂的狗：小头像 + IMU/狗名，点开看狗档案里的照片，方便对着画面认狗。
 *  同一间的两只 IMU 是一对（同一只狗），合并成一个标签只挂一张照片：IMU9/10 */
function DogChip({ dogId, name, imus, room }: {
  dogId: number | null;
  name: string | null;
  imus: number[];
  room: string;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["dog-photos", dogId],
    queryFn: () => listDogPhotos(dogId!),
    enabled: dogId != null,
    // 认狗用的图不会变，切段时别反复去 NAS 列目录
    staleTime: 5 * 60_000,
  });
  const photo = (data ?? []).find((p) => p.kind === "image");
  const label = imus.length ? `IMU${imus.join("/")}` : name ?? "";

  return (
    <>
      <Tooltip title={`${label}${name ? ` ${name}` : ""} · ${room}${photo ? "，点开看照片" : "，狗档案里还没有照片"}`}>
        <div
          onClick={() => dogId != null && setOpen(true)}
          style={{
            display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%",
            padding: "1px 6px 1px 1px", border: "1px solid #f0f0f0", borderRadius: 12,
            background: "var(--sl-fill2, #fafafa)", cursor: dogId != null ? "pointer" : "default",
          }}
        >
          <div
            style={{
              width: 20, height: 20, flex: "0 0 20px", borderRadius: "50%", overflow: "hidden",
              background: "#eee", display: "grid", placeItems: "center",
            }}
          >
            {photo ? (
              <img
                src={dogPhotoUrl(dogId!, photo.filename, photo.token)}
                alt={name ?? ""}
                loading="lazy"
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              <span style={{ fontSize: 9, color: "#999" }}>?</span>
            )}
          </div>
          <span style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {label}{name ? ` ${name}` : ""}
          </span>
        </div>
      </Tooltip>
      {dogId != null && (
        <Modal
          open={open}
          title={name ? `${name} 的照片` : "狗档案照片"}
          footer={null}
          width={880}
          destroyOnClose
          onCancel={() => setOpen(false)}
        >
          {open && <DogPhotos dogId={dogId} readOnly />}
        </Modal>
      )}
    </>
  );
}

function SegmentCard({ segment, onChanged }: {
  segment: CamCheckSegment;
  onChanged: () => void;
}) {
  const [map, setMap] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const init: Record<number, number> = {};
    for (const c of segment.cams) init[c.recorded_cam] = c.real_cam;
    setMap(init);
  }, [segment]);

  const changed = useMemo(
    () => segment.cams.some((c) => map[c.recorded_cam] !== c.real_cam),
    [segment, map]
  );
  const duplicated = useMemo(() => {
    const v = Object.values(map);
    return new Set(v).size !== v.length;
  }, [map]);

  // 每路画面旁边显示挂在这路上的狗：同一间的两只 IMU 是一对，合成一个标签；
  // 按房间归组（配对 IMU 必然同房间），组内 IMU 升序排，组之间也按最小 IMU 号排
  const dogsByCam = useMemo(() => {
    const m = new Map<number, { key: string; samples: CamCheckSample[] }[]>();
    for (const s of segment.samples) {
      if (s.cam == null) continue;
      const key = s.room != null ? `room${s.room}` : `sample${s.id}`;
      const list = m.get(s.cam) ?? [];
      const g = list.find((x) => x.key === key);
      if (g) g.samples.push(s);
      else list.push({ key, samples: [s] });
      m.set(s.cam, list);
    }
    for (const list of m.values()) {
      list.sort((a, b) => {
        const ia = Math.min(...a.samples.map((s) => s.imu ?? 999));
        const ib = Math.min(...b.samples.map((s) => s.imu ?? 999));
        return ia - ib;
      });
    }
    return m;
  }, [segment]);

  /** 改一路时如果那个房间已经被另一路占着，两路对调——摄像头插反基本都是成对对调 */
  const pick = (recorded: number, real: number) => {
    setMap((prev) => {
      const next = { ...prev };
      const other = Object.entries(next).find(([r, v]) => Number(r) !== recorded && v === real);
      if (other) next[Number(other[0])] = prev[recorded];
      next[recorded] = real;
      return next;
    });
  };

  const apply = async () => {
    setSaving(true);
    try {
      const res = await saveCamBatch(segment.date, Object.fromEntries(Object.entries(map)), segment.session_keys);
      const missing = res.results.flatMap((r) => r.missing_rooms);
      const pair = res.extra.length ? `；另外把配对 IMU 单独出现的 ${res.extra.length} 场一起改了` : "";
      if (missing.length) {
        message.warning(`已保存，但这几个房间没找到对应画面：${missing.join("、")}${pair}`);
      } else {
        message.success(`已纠正 ${res.updated} 份样本的画面${pair}`);
      }
      onChanged();
    } catch (e) {
      message.error(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      await Promise.all(segment.session_keys.map((k) => resetCamMap(k)));
      message.success("已恢复按采集端文件名算");
      onChanged();
    } catch (e) {
      message.error(`恢复失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const roomLabel = (v: number | null) =>
    segment.rooms.find((r) => r.value === v)?.label ?? (v == null ? "未知" : `cam${v}`);

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Space wrap>
          <Typography.Text strong>{sessionTime(segment.segment_key)}</Typography.Text>
          <Tag>{segment.site_name || segment.site || "未知场地"}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {segment.cams.length} 路画面 · {segment.samples.length} 份样本
          </Typography.Text>
          {segment.corrected && <Tag color="green">已人工纠正</Tag>}
        </Space>
      }
      extra={
        <Space>
          <Popconfirm
            title="恢复成按采集端文件名算？"
            description="这一段的人工纠正会清掉，样本画面按文件名里的 camN 重挂"
            onConfirm={reset}
            disabled={saving}
          >
            <Button size="small" disabled={saving || !segment.corrected}>恢复默认</Button>
          </Popconfirm>
          <Button
            size="small"
            type="primary"
            loading={saving}
            disabled={!changed || duplicated}
            onClick={apply}
          >
            应用纠正
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="两台采集机各 3 路，同屏对比看哪台错位了。只会在同一台机器的 3 路之间调整（cam1~3 对 1~3 号间，cam4~6 对 4~6 号间）"
      />
      {duplicated && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }}
               message="两路画面选了同一个房间，先改开再保存" />
      )}
      <Row gutter={[12, 12]}>
        {/* 按「现在算的是几号间」从小到大排（纠正保存后跟着重排），一眼核对 1、2、3 号间是不是各就各位；
            编辑中不跟着跳，免得刚选完画面就挪走 */}
        {[...segment.cams].sort((a, b) => (a.real_cam ?? 99) - (b.real_cam ?? 99) || a.recorded_cam - b.recorded_cam).map((c) => (
          <Col key={c.recorded_cam} xs={24} sm={12} md={8}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
              <Typography.Text strong style={{ fontSize: 16 }}>{roomLabel(c.real_cam)}</Typography.Text>
              {c.real_cam !== c.recorded_cam && <Tag color="orange" style={{ marginRight: 0 }}>已纠正</Tag>}
              {map[c.recorded_cam] !== c.real_cam && (
                <Tag color="blue" style={{ marginRight: 0 }}>待保存 → {roomLabel(map[c.recorded_cam] ?? null)}</Tag>
              )}
            </div>
            {/* 这一间应该是哪只狗：大头像叠在画面右上角，直接跟画面里那只比，看纠正有没有生效 */}
            <div style={{ position: "relative" }}>
              <CamThumb mediaId={c.media_id} />
              <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 6 }}>
                {(dogsByCam.get(c.recorded_cam) ?? []).map((g) => {
                  const withDog = g.samples.find((s) => s.dog_id != null) ?? g.samples[0];
                  return (
                    <Tooltip key={g.key} title={`这间应该是 ${withDog.dog_name ?? "（没建档）"}：跟画面里那只比一比，是同一只就说明纠正生效了`}>
                      <div style={{ background: "rgba(0,0,0,.55)", borderRadius: 10, padding: 4, textAlign: "center" }}>
                        <DogAvatar dogId={withDog.dog_id} name={withDog.dog_name ?? undefined} size={64} />
                        <div style={{ color: "#fff", fontSize: 12, marginTop: 2, maxWidth: 72, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          应是 {withDog.dog_name ?? "？"}
                        </div>
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <Typography.Text type="secondary">录制 cam{c.recorded_cam}</Typography.Text>
              {(dogsByCam.get(c.recorded_cam) ?? []).map((g) => {
                const withDog = g.samples.find((s) => s.dog_id != null) ?? g.samples[0];
                const imus = g.samples
                  .map((s) => s.imu)
                  .filter((v): v is number => v != null)
                  .sort((a, b) => a - b);
                return (
                  <DogChip
                    key={g.key}
                    dogId={withDog.dog_id}
                    name={withDog.dog_name}
                    imus={imus}
                    room={roomLabel(withDog.room)}
                  />
                );
              })}
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: "auto" }}>
                挂在 {c.samples} 份样本
              </Typography.Text>
            </div>
            <Select
              size="small"
              style={{ width: "100%", marginTop: 4 }}
              value={map[c.recorded_cam] ?? c.real_cam}
              options={c.room_options}
              onChange={(v) => pick(c.recorded_cam, v)}
              disabled={c.room_options.length <= 1}
            />
            {/* 文件名里的 imuN 只是录像时同步的那只项圈，跟这路现在挂给谁无关，整行显示容易看岔：收进提示里 */}
            <Tooltip title={`视频文件：${c.path.split("/").pop()}（文件名里的 imu 号只是录像时同步的项圈，跟这路现在挂给哪只狗无关）`}>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>录制 cam{c.recorded_cam} 的视频</Typography.Text>
            </Tooltip>
          </Col>
        ))}
      </Row>
    </Card>
  );
}

export default function CamCheck() {
  const [date, setDate] = useState<string | undefined>();
  const [site, setSite] = useState<string | undefined>();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["cam-map", date, site],
    queryFn: () => listCamSessions(date, site),
    // 切回窗口别自动重拉：原来一重拉，下面「整日批量」的对照和勾选就被悄悄清回默认，
    // 再点应用提交的是「不改」，画面不变、还提示成功
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!date && data?.date) setDate(data.date);
  }, [date, data?.date]);

  const dates = data?.dates ?? [];
  // 一段 = 两台机器同一时间段的两个 session 合起来，一次看 6 路
  const segments = useMemo(() => data?.segments ?? [], [data]);

  // 一次只渲染一段：一天几十段、每段 6 个视频，全铺出来会卡
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [date, site, data?.date]);
  const current = segments[Math.min(page, segments.length) - 1];
  const pageCount = segments.length;

  // ── 整日对调：在每段「现在的对照」基础上把两间画面互换，不用勾选、不管之前纠正过没有 ──
  const [swapping, setSwapping] = useState<string | null>(null);
  // 这一天出现过的房间，按机器分组（1 号机 1~3 号间、2 号机 4~6 号间），列出能对调的两两组合
  const swapPairs = useMemo(() => {
    const rooms = [...new Set(segments.flatMap((s) => s.cams.flatMap((c) => c.room_options.map((o) => o.value))))].sort((x, y) => x - y);
    const out: [number, number][] = [];
    for (const x of rooms) for (const y of rooms) if (x < y && (x <= 3) === (y <= 3)) out.push([x, y]);
    return out;
  }, [segments]);
  const roomName = (v: number) =>
    segments.flatMap((s) => s.cams.flatMap((c) => c.room_options)).find((o) => o.value === v)?.label ?? `${v} 号间`;
  const swapDay = async (x: number, y: number) => {
    setSwapping(`${x}-${y}`);
    let n = 0, samples = 0;
    const failed: string[] = [];
    try {
      for (const seg of segments) {
        if (!seg.cams.some((c) => c.real_cam === x || c.real_cam === y)) continue;
        const mapping: Record<string, number> = {};
        for (const c of seg.cams) mapping[String(c.recorded_cam)] = c.real_cam === x ? y : c.real_cam === y ? x : c.real_cam;
        try {
          const res = await saveCamBatch(seg.date, mapping, seg.session_keys);
          n += 1; samples += res.updated;
        } catch (e) {
          failed.push(`${sessionTime(seg.segment_key)}：${(e as Error).message}`);
        }
      }
      if (failed.length) message.warning(`对调了 ${n} 段；${failed.length} 段没成：${failed.slice(0, 3).join("；")}`);
      else message.success(`这一天 ${n} 段的「${roomName(x)}」和「${roomName(y)}」画面已对调（${samples} 份样本）。看下面头像跟画面里的狗对不对`);
      await refetch();
    } finally {
      setSwapping(null);
    }
  };
  const resetDay = async () => {
    setSwapping("reset");
    try {
      await Promise.all(segments.flatMap((s) => s.session_keys).map((k) => resetCamMap(k).catch(() => null)));
      message.success("这一天全部恢复成按文件名算（cam 几就是几号间）");
      await refetch();
    } finally {
      setSwapping(null);
    }
  };

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Typography.Text strong>机位核对</Typography.Text>
          <Select
            style={{ width: 200 }}
            value={site ?? "__all__"}
            onChange={(v) => setSite(v === "__all__" ? undefined : v)}
            options={[
              { value: "__all__", label: "全部场地" },
              ...(data?.sites ?? []).map((s) => ({
                value: s.key,
                label: s.active ? s.name : `${s.name}（暂停合作）`,
              })),
            ]}
          />
          <Select
            style={{ width: 140 }}
            value={date ?? data?.date ?? undefined}
            options={dates.map((d) => ({ value: d, label: d }))}
            onChange={setDate}
            placeholder="选择日期"
          />
          <Button onClick={() => refetch()}>刷新</Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            摄像头重插后，文件名里的 cam 号可能已经不是原来那间；看画面改一次，
            这一场所有样本一起修正，自动扫描不会再盖回去
          </Typography.Text>
        </Space>
      </Card>

      {segments.length > 0 && (
        <Card
          size="small"
          style={{ marginBottom: 16 }}
          title={
            <Space wrap>
              <Typography.Text strong>整日对调</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                这一天两间画面整个对调：每一段都在「现在」的基础上互换，不管之前纠正过没有。点完看下面头像跟画面里的狗对不对
              </Typography.Text>
            </Space>
          }
          extra={
            <Popconfirm title="这一天全部恢复成按文件名算？" description="所有段的人工纠正都清掉，cam 几就是几号间" onConfirm={resetDay}>
              <Button size="small" loading={swapping === "reset"} disabled={!!swapping}>全天恢复默认</Button>
            </Popconfirm>
          }
        >
          <Space wrap>
            {swapPairs.map(([x, y]) => (
              <Popconfirm
                key={`${x}-${y}`}
                title={`把这一天所有段的「${roomName(x)}」和「${roomName(y)}」画面对调？`}
                description="每段在现在的基础上互换；点错了再点一次就换回来"
                okText="对调"
                onConfirm={() => swapDay(x, y)}
              >
                <Button loading={swapping === `${x}-${y}`} disabled={!!swapping}>
                  {roomName(x)} ⇄ {roomName(y)}
                </Button>
              </Popconfirm>
            ))}
          </Space>
        </Card>
      )}

      <Spin spinning={isLoading}>
        {segments.length === 0 && !isLoading ? (
          <Empty description="这一天没有需要核对的场次" />
        ) : (
          <>
            {current && (
              <SegmentCard
                key={current.segment_key}
                segment={current}
                onChanged={() => refetch()}
              />
            )}
            <Space style={{ width: "100%", justifyContent: "center", marginTop: 8 }}>
              <Pagination
                size="small"
                current={Math.min(page, Math.max(pageCount, 1))}
                pageSize={1}
                total={pageCount}
                showSizeChanger={false}
                onChange={setPage}
                showTotal={(t, range) => `第 ${range[0]} / ${t} 段`}
              />
            </Space>
          </>
        )}
      </Spin>
    </div>
  );
}
