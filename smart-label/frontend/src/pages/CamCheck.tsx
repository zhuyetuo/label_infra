import { useEffect, useMemo, useRef, useState } from "react";
import DogAvatar from "@/components/DogAvatar";
import {
  Alert, Button, Card, Checkbox, Col, Empty, Modal, Pagination, Popconfirm, Row, Select, Space, Spin, Tag, Tooltip,
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

function SegmentCard({ segment, onChanged, checked, onCheck }: {
  segment: CamCheckSegment;
  onChanged: () => void;
  checked: boolean;
  onCheck: (v: boolean) => void;
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
          <Checkbox checked={checked} onChange={(e) => onCheck(e.target.checked)} />
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

  // ── 整日批量：一天 24 段一条条点太费时间 ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchMap, setBatchMap] = useState<Record<number, number>>({});
  const [batchSaving, setBatchSaving] = useState(false);

  // 勾选和批量对照只在换了日期 / 场地时重置；同一天刷新数据（应用后、点刷新）不动，免得人刚改好就被清掉
  const dayKey = `${data?.date ?? ""}|${site ?? ""}`;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  useEffect(() => {
    // 默认勾上还没人工纠正的段：已纠正的多半是对的，批量时别顺手盖掉
    setSelected(new Set(segmentsRef.current.filter((s) => !s.corrected).map((s) => s.segment_key)));
  }, [dayKey]);

  // 当天所有段出现过的录制机位并集，批量对照按它编辑
  const allRecorded = useMemo(
    () => [...new Set(segments.flatMap((s) => s.cams.map((c) => c.recorded_cam)))].sort((a, b) => a - b),
    [segments]
  );

  // 每个录制机位能用哪些房间：cam1~3 只配 1~3 号间，cam4~6 只配 4~6 号间
  const batchRooms = useMemo(() => {
    const m = new Map<number, { value: number; label: string }[]>();
    for (const s of segments)
      for (const c of s.cams) if (!m.has(c.recorded_cam)) m.set(c.recorded_cam, c.room_options);
    return m;
  }, [segments]);

  useEffect(() => {
    setBatchMap((prev) => {
      // 同一天新冒出来的机位补上默认值；已经改过的不动
      const next: Record<number, number> = {};
      for (const c of allRecorded) next[c] = prev[c] ?? c;
      return next;
    });
  }, [allRecorded]);
  useEffect(() => {
    // 换了日期 / 场地：对照回到默认
    const init: Record<number, number> = {};
    for (const c of segmentsRef.current.flatMap((s) => s.cams.map((x) => x.recorded_cam))) init[c] = c;
    setBatchMap(init);
  }, [dayKey]);
  // 对照里实际改了哪几路（录制 cam → 几号间）：一个都没改就别让应用
  const batchChanges = useMemo(
    () => Object.entries(batchMap).filter(([r, v]) => Number(r) !== v).map(([r, v]) => [Number(r), v] as const),
    [batchMap]
  );

  const batchDuplicated = useMemo(() => {
    const v = Object.values(batchMap);
    return v.length > 0 && new Set(v).size !== v.length;
  }, [batchMap]);

  /** 批量对照也支持「选了别人占着的房间就两路对调」 */
  const batchPick = (recorded: number, real: number) => {
    setBatchMap((prev) => {
      const next = { ...prev };
      const other = Object.entries(next).find(([r, v]) => Number(r) !== recorded && v === real);
      if (other) next[Number(other[0])] = prev[recorded];
      next[recorded] = real;
      return next;
    });
  };

  const applyBatch = async () => {
    if (!data?.date) return;
    const keys = segments.filter((s) => selected.has(s.segment_key)).flatMap((s) => s.session_keys);
    setBatchSaving(true);
    try {
      const res = await saveCamBatch(
        data.date,
        Object.fromEntries(Object.entries(batchMap)),
        keys
      );
      const pair = res.extra.length ? `；另外把配对 IMU 单独出现的 ${res.extra.length} 场一起改了` : "";
      if (res.failed.length) {
        message.warning(
          `成了 ${res.results.length} 场；${res.failed.length} 场没改成：${res.failed.map((f) => f.error).join("；")}${pair}`
        );
      } else {
        const what = batchChanges.map(([r, v]) => `cam${r}→${v}号间`).join("、");
        message.success(`已把 ${selected.size} 段按「${what}」纠正，共 ${res.updated} 份样本${pair}。下面每段的画面已经按房间号重排`);
      }
      refetch();
    } catch (e) {
      message.error(`批量失败：${(e as Error).message}`);
    } finally {
      setBatchSaving(false);
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
              <Typography.Text strong>整日批量</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                改一套对照，勾选下面要应用的段一次改完。默认勾上还没纠正的；
                上午插错就只勾上午的段，下午对的别勾
              </Typography.Text>
            </Space>
          }
          extra={
            <Space>
              <Button size="small" onClick={() => setSelected(new Set(segments.map((s) => s.segment_key)))}>
                全选
              </Button>
              <Button size="small" onClick={() => setSelected(new Set())}>清空</Button>
              <Popconfirm
                title={`把 ${selected.size} 段按这套对照改？`}
                description={
                  <div style={{ maxWidth: 320 }}>
                    {batchChanges.map(([r, v]) => (
                      <div key={r}>录制 cam{r} → {(batchRooms.get(r) ?? []).find((o) => o.value === v)?.label ?? `${v} 号间`}</div>
                    ))}
                    <div style={{ color: "#999", marginTop: 4 }}>没列出来的机位保持原样（cam 几就是几号间）</div>
                  </div>
                }
                okText="应用"
                onConfirm={applyBatch}
                disabled={selected.size === 0 || batchDuplicated || batchChanges.length === 0}
              >
                <Tooltip title={batchChanges.length === 0 ? "上面的对照还是默认（cam 几就是几号间），应用了画面也不会变；先在下面把要改的机位选好" : undefined}>
                  <Button
                    size="small"
                    type="primary"
                    loading={batchSaving}
                    disabled={selected.size === 0 || batchDuplicated || batchChanges.length === 0}
                  >
                    应用到选中段（{selected.size}）
                  </Button>
                </Tooltip>
              </Popconfirm>
            </Space>
          }
        >
          {batchDuplicated && (
            <Alert type="error" showIcon style={{ marginBottom: 12 }}
                   message="两路画面选了同一个房间，先改开再应用" />
          )}
          <Row gutter={[12, 12]}>
            {allRecorded.map((c) => (
              <Col key={c} xs={12} sm={8} md={6} lg={4}>
                <Typography.Text strong>录制 cam{c}</Typography.Text>
                <Select
                  size="small"
                  style={{ width: "100%", marginTop: 4 }}
                  value={batchMap[c] ?? c}
                  options={batchRooms.get(c) ?? []}
                  onChange={(v) => batchPick(c, v)}
                  disabled={(batchRooms.get(c) ?? []).length <= 1}
                />
              </Col>
            ))}
          </Row>
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
                checked={selected.has(current.segment_key)}
                onCheck={(v) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(current.segment_key);
                    else next.delete(current.segment_key);
                    return next;
                  })
                }
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
