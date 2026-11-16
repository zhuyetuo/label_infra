import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Card, Checkbox, Col, Empty, Pagination, Popconfirm, Row, Select, Space, Spin, Tag, Typography, message,
} from "antd";
import { useQuery } from "@tanstack/react-query";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import {
  listCamSessions, resetCamMap, saveCamBatch, saveCamMap, type CamCheckSession,
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

function SessionCard({ session, onChanged, checked, onCheck }: {
  session: CamCheckSession;
  onChanged: () => void;
  checked: boolean;
  onCheck: (v: boolean) => void;
}) {
  const [map, setMap] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const init: Record<number, number> = {};
    for (const c of session.cams) init[c.recorded_cam] = c.real_cam;
    setMap(init);
  }, [session]);

  const changed = useMemo(
    () => session.cams.some((c) => map[c.recorded_cam] !== c.real_cam),
    [session, map]
  );
  const duplicated = useMemo(() => {
    const v = Object.values(map);
    return new Set(v).size !== v.length;
  }, [map]);

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
      const res = await saveCamMap(session.session_key, Object.fromEntries(Object.entries(map)));
      if (res.missing_rooms?.length) {
        message.warning(`已保存，但这几个房间没找到对应画面：${res.missing_rooms.join("、")}`);
      } else {
        message.success(`已纠正 ${res.updated} 份样本的画面`);
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
      await resetCamMap(session.session_key);
      message.success("已恢复按采集端文件名算");
      onChanged();
    } catch (e) {
      message.error(`恢复失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const roomLabel = (v: number | null) =>
    session.rooms.find((r) => r.value === v)?.label ?? (v == null ? "未知" : `cam${v}`);

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Space wrap>
          <Checkbox checked={checked} onChange={(e) => onCheck(e.target.checked)} />
          <Typography.Text strong>{sessionTime(session.session_key)}</Typography.Text>
          <Tag>{session.site_name || session.site || "未知场地"}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {session.cams.length} 路画面 · {session.samples.length} 份样本
          </Typography.Text>
          {session.corrected && <Tag color="green">已人工纠正</Tag>}
        </Space>
      }
      extra={
        <Space>
          <Popconfirm
            title="恢复成按采集端文件名算？"
            description="这一场的人工纠正会清掉，样本画面按文件名里的 camN 重挂"
            onConfirm={reset}
            disabled={saving}
          >
            <Button size="small" disabled={saving || !session.corrected}>恢复默认</Button>
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
        message="看画面里是哪一间，再把「实际房间」选对。两台采集机的场次是分开的，各改各的"
      />
      {duplicated && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }}
               message="两路画面选了同一个房间，先改开再保存" />
      )}
      <Row gutter={[12, 12]}>
        {session.cams.map((c) => (
          <Col key={c.recorded_cam} xs={24} sm={12} md={8} lg={6}>
            <CamThumb mediaId={c.media_id} />
            <Space style={{ marginTop: 6, width: "100%", justifyContent: "space-between" }}>
              <Typography.Text strong>录制 cam{c.recorded_cam}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                挂在 {c.samples} 份样本
              </Typography.Text>
            </Space>
            <Select
              size="small"
              style={{ width: "100%", marginTop: 4 }}
              value={map[c.recorded_cam] ?? c.real_cam}
              options={c.room_options}
              onChange={(v) => pick(c.recorded_cam, v)}
              disabled={c.room_options.length <= 1}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis={{ tooltip: c.path }}>
              {c.path.split("/").pop()}
            </Typography.Text>
          </Col>
        ))}
      </Row>
      {session.samples.length > 0 && (
        <Space wrap style={{ marginTop: 12 }}>
          {session.samples.map((s) => (
            <Tag key={s.id}>
              {s.imu != null ? `IMU${s.imu}` : s.sample_code}
              {s.dog_name ? ` ${s.dog_name}` : ""} → {roomLabel(s.room)}
            </Tag>
          ))}
        </Space>
      )}
    </Card>
  );
}

export default function CamCheck() {
  const [date, setDate] = useState<string | undefined>();
  const [site, setSite] = useState<string | undefined>();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["cam-map", date, site],
    queryFn: () => listCamSessions(date, site),
  });

  useEffect(() => {
    if (!date && data?.date) setDate(data.date);
  }, [date, data?.date]);

  const dates = data?.dates ?? [];
  const sessions = useMemo(() => data?.sessions ?? [], [data]);

  // 一次只渲染一段：一天几十段、每段好几个视频，全铺出来会卡
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [date, site, data?.date]);
  const current = sessions[Math.min(page, sessions.length) - 1];
  const pageCount = sessions.length;

  // ── 整日批量：一天 24 场一条条点太费时间 ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchMap, setBatchMap] = useState<Record<number, number>>({});
  const [batchSaving, setBatchSaving] = useState(false);

  useEffect(() => {
    // 默认勾上还没人工纠正的场：已纠正的多半是对的，批量时别顺手盖掉
    setSelected(new Set(sessions.filter((s) => !s.corrected).map((s) => s.session_key)));
  }, [sessions]);

  // 当天所有场次出现过的录制机位并集，批量对照按它编辑
  const allRecorded = useMemo(
    () => [...new Set(sessions.flatMap((s) => s.cams.map((c) => c.recorded_cam)))].sort((a, b) => a - b),
    [sessions]
  );

  // 每个录制机位能用哪些房间：cam1~3 只配 1~3 号间，cam4~6 只配 4~6 号间
  const batchRooms = useMemo(() => {
    const m = new Map<number, { value: number; label: string }[]>();
    for (const s of sessions)
      for (const c of s.cams) if (!m.has(c.recorded_cam)) m.set(c.recorded_cam, c.room_options);
    return m;
  }, [sessions]);

  useEffect(() => {
    const init: Record<number, number> = {};
    for (const c of allRecorded) init[c] = c;
    setBatchMap(init);
  }, [allRecorded]);

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
    setBatchSaving(true);
    try {
      const res = await saveCamBatch(
        data.date,
        Object.fromEntries(Object.entries(batchMap)),
        [...selected]
      );
      if (res.failed.length) {
        message.warning(
          `成了 ${res.results.length} 场；${res.failed.length} 场没改成：${res.failed.map((f) => f.error).join("；")}`
        );
      } else {
        message.success(`已把 ${res.results.length} 场一起纠正，共 ${res.updated} 份样本`);
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

      {sessions.length > 0 && (
        <Card
          size="small"
          style={{ marginBottom: 16 }}
          title={
            <Space wrap>
              <Typography.Text strong>整日批量</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                改一套对照，勾选下面要应用的场次一次改完。默认勾上还没纠正的；
                上午插错就只勾上午的场，下午对的别勾
              </Typography.Text>
            </Space>
          }
          extra={
            <Space>
              <Button size="small" onClick={() => setSelected(new Set(sessions.map((s) => s.session_key)))}>
                全选
              </Button>
              <Button size="small" onClick={() => setSelected(new Set())}>清空</Button>
              <Button
                size="small"
                type="primary"
                loading={batchSaving}
                disabled={selected.size === 0 || batchDuplicated}
                onClick={applyBatch}
              >
                应用到选中场次（{selected.size}）
              </Button>
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
        {sessions.length === 0 && !isLoading ? (
          <Empty description="这一天没有需要核对的场次" />
        ) : (
          <>
            {current && (
              <SessionCard
                key={current.session_key}
                session={current}
                onChanged={() => refetch()}
                checked={selected.has(current.session_key)}
                onCheck={(v) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (v) next.add(current.session_key);
                    else next.delete(current.session_key);
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
