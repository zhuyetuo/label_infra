import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Col, Modal, Row, Select, Space, Spin, Tag, Typography, message } from "antd";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { getSampleCams, saveCamBatch, type CamSampleCams } from "@/api/camMap";

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${s.toFixed(1)}s`;
}

/** 一路画面循环播这一段：先停到起点，播过终点就跳回去。
 *  offsetMs：跨机的机位，这一路第 0 秒在本样本时间轴上的位置。 */
function CamClip({ mediaId, startS, endS, offsetMs }: {
  mediaId: number | null;
  startS: number;
  endS: number;
  offsetMs: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const off = offsetMs / 1000;
  const start = Math.max(0, startS - off);
  const end = endS - off;
  const empty = end <= start + 0.1;

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

  if (empty) {
    return (
      <div style={{ aspectRatio: "16 / 9", background: "#111", color: "#888", display: "grid",
                    placeItems: "center", fontSize: 12, borderRadius: 4, textAlign: "center", padding: 8 }}>
        这一段这一路还没开始录（跟本机差 {fmt(Math.abs(off))}）
      </div>
    );
  }
  if (url == null) {
    return (
      <div style={{ aspectRatio: "16 / 9", background: "#111", color: "#888", display: "grid",
                    placeItems: "center", fontSize: 12, borderRadius: 4 }}>
        {mediaId == null ? "这一路没有可播放的文件" : failed ? "取画面失败" : "加载画面…"}
      </div>
    );
  }
  return (
    <video
      src={url}
      muted
      playsInline
      autoPlay
      preload="auto"
      onLoadedMetadata={(e) => {
        e.currentTarget.currentTime = start;
      }}
      onTimeUpdate={(e) => {
        if (e.currentTarget.currentTime >= end) e.currentTarget.currentTime = start;
      }}
      style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", background: "#111", borderRadius: 4 }}
    />
  );
}

/** 标注工作台里就地核对机位：循环看这一段，把这只狗那一间换到画面对的那一路。
 *  改的是整场录制（同一时段所有样本一起换），进来时已经写清楚。 */
export default function CamFixModal({ open, sampleId, startMs, endMs, onClose, onApplied }: {
  open: boolean;
  sampleId: number | null;
  startMs: number;
  endMs: number;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const [data, setData] = useState<CamSampleCams | null>(null);
  const [loading, setLoading] = useState(false);
  const [map, setMap] = useState<Record<number, number>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || sampleId == null) return;
    let alive = true;
    setLoading(true);
    setData(null);
    setMap({});
    getSampleCams(sampleId)
      .then((d) => {
        if (!alive) return;
        setData(d);
        const init: Record<number, number> = {};
        for (const c of d.cams ?? []) init[c.recorded_cam] = c.real_cam;
        setMap(init);
      })
      .catch((e) => alive && message.error(`读取机位失败：${(e as Error).message}`))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, sampleId]);

  const cams = data?.cams ?? [];
  const startS = startMs / 1000;
  const endS = endMs / 1000;
  const changed = cams.some((c) => map[c.recorded_cam] !== c.real_cam);
  const duplicated = useMemo(() => {
    const v = Object.values(map);
    return new Set(v).size !== v.length;
  }, [map]);

  /** 改一路时如果那个房间已经被另一路占着，两路对调——插错基本都是成对对调 */
  const pick = (recorded: number, real: number) => {
    setMap((prev) => {
      const next = { ...prev };
      const other = Object.entries(next).find(([r, v]) => Number(r) !== recorded && v === real);
      if (other) next[Number(other[0])] = prev[recorded];
      next[recorded] = real;
      return next;
    });
  };

  const roomLabel = (v: number | null | undefined) =>
    (data?.rooms ?? []).find((r) => r.value === v)?.label ?? (v == null ? "未知" : `cam${v}`);

  const apply = async () => {
    if (!data?.date || !data.session_key) return;
    setSaving(true);
    try {
      const res = await saveCamBatch(
        data.date,
        Object.fromEntries(Object.entries(map)),
        data.session_keys ?? [data.session_key],
      );
      const missing = res.results.flatMap((r) => r.missing_rooms);
      if (res.failed?.length) {
        message.warning(`部分场次没保存成功：${res.failed.map((f) => f.error).join("；")}`);
      } else if (missing.length) {
        message.warning(`已保存，但这几个房间没找到对应画面：${missing.map(roomLabel).join("、")}`);
      } else {
        message.success(`已纠正 ${res.updated} 份样本的画面，这一场都换过来了`);
      }
      onApplied?.();
      onClose();
    } catch (e) {
      message.error(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={
        <Space wrap>
          <span>机位纠正</span>
          {data?.sample_code && <Tag>{data.sample_code}</Tag>}
          {data?.room_label && <Tag color="green">这只狗应该是 {data.room_label}</Tag>}
        </Space>
      }
      width={1180}
      styles={{ body: { maxHeight: "70vh", overflowY: "auto", paddingRight: 4 } }}
      onCancel={onClose}
      destroyOnClose
      footer={
        data?.applicable ? (
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" loading={saving} disabled={!changed || duplicated} onClick={apply}>
              应用纠正
            </Button>
          </Space>
        ) : null
      }
    >
      {loading ? (
        <div style={{ padding: 40, textAlign: "center" }}>
          <Spin />
        </div>
      ) : !data ? null : !data.applicable ? (
        <Alert type="info" showIcon message={data.reason ?? "这个样本不需要核对机位"} />
      ) : (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`下面循环播放的是 ${fmt(startS)} – ${fmt(endS)}。哪一路里是这只狗，就把那一间选成「${data.room_label ?? "它所在的房间"}」，占着那个房间的另一路会自动对调。`}
            description="机位插错是整场录制的事：保存后同一时段的所有样本一起换，不是只改当前这一条。深圳雷诺 7 路是独立装的，列表里会连对面采集机的机位一起列出来。"
          />
          {duplicated && (
            <Alert type="error" showIcon style={{ marginBottom: 12 }} message="两路选了同一个房间，先改开再保存" />
          )}
          <Row gutter={[12, 12]}>
            {cams.map((c) => {
              const pending = map[c.recorded_cam] ?? c.real_cam;
              const isTarget = pending === data.room;
              return (
                <Col key={c.recorded_cam} xs={24} sm={12} md={6}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                    <Typography.Text strong>录制 cam{c.recorded_cam}</Typography.Text>
                    <Tag color={isTarget ? "green" : "default"} style={{ marginInlineEnd: 0 }}>
                      {isTarget ? "这一间" : roomLabel(pending)}
                    </Tag>
                    {pending !== c.real_cam && (
                      <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                        待保存 → {roomLabel(pending)}
                      </Tag>
                    )}
                  </div>
                  <CamClip
                    mediaId={c.media_id}
                    startS={startS}
                    endS={endS}
                    offsetMs={c.offset_ms ?? 0}
                  />
                  <Select
                    size="small"
                    style={{ width: "100%", marginTop: 6 }}
                    value={pending}
                    options={c.room_options}
                    onChange={(v) => pick(c.recorded_cam, v)}
                    disabled={c.room_options.length <= 1}
                  />
                </Col>
              );
            })}
          </Row>
        </>
      )}
    </Modal>
  );
}
