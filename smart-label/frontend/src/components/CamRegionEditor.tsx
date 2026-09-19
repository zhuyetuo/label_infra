import { useEffect, useRef, useState } from "react";
import { Alert, Button, InputNumber, Modal, Select, Space, Spin, Tag, Typography, message } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { frameUrl, getFrameToken, listCamRegions, saveCamRegions, type CamRegion } from "@/api/dailyStats";

const { Text } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
  site: string;
  /** 公用机位号（7） */
  cam: number;
  /** 拿哪段画面来划：这份样本的这一路 */
  sampleId: number;
  slot: string;
  /** 这个场地有哪些单间（机位号），下拉里选 */
  rooms: number[];
}

type Rect = { room: number; x: number; y: number; w: number; h: number };

/**
 * 在公用机位（天花板 cam7）的一帧画面上，把每个单间占的那块框出来。
 *
 * cam7 是固定机位，每间在画面里的位置不会变，所以框一次就行。之后 cam7 里检出的狗，
 * 框的中心落在哪一块就算哪间的，跟单间自己的机位取并集——单间有死角时靠它补。
 * 归一化坐标存库，换分辨率不用重画。
 */
export default function CamRegionEditor({ open, onClose, site, cam, sampleId, slot, rooms }: Props) {
  const qc = useQueryClient();
  const { data: saved } = useQuery({ queryKey: ["cam-regions", site], queryFn: () => listCamRegions(site), enabled: open });
  const [rects, setRects] = useState<Rect[]>([]);
  const [room, setRoom] = useState<number | null>(null);
  const [t, setT] = useState(60);
  const [img, setImg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    if (!open || !saved) return;
    setRects(saved.filter((r) => r.cam === cam).map(({ room, x, y, w, h }) => ({ room, x, y, w, h })));
  }, [open, saved, cam]);
  useEffect(() => {
    if (!open) return;
    setRoom(rooms[0] ?? null);
  }, [open, rooms]);

  // 取帧：t 秒那一帧，整帧带狗框（有狗更好认哪间是哪间）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    getFrameToken(sampleId)
      .then(({ token }) => {
        if (alive) setImg(frameUrl(sampleId, slot, t, token));
      })
      .catch(() => alive && setImg(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, sampleId, slot, t]);

  const rel = (e: React.MouseEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const onDown = (e: React.MouseEvent) => {
    if (room == null || e.button !== 0) return;
    const p = rel(e);
    drag.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    e.preventDefault();
  };
  const onMove = (e: React.MouseEvent) => {
    if (!drag.current) return;
    const p = rel(e);
    drag.current.x1 = p.x;
    drag.current.y1 = p.y;
    force((n) => n + 1);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || room == null) return;
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0);
    const h = Math.abs(d.y1 - d.y0);
    if (w < 0.02 || h < 0.02) return;      // 点一下不算画
    setRects((prev) => [...prev.filter((r) => r.room !== room), { room, x, y, w, h }]);
    // 画完自动跳到下一个还没画的房间，一口气画完
    const next = rooms.find((r) => r !== room && !rects.some((x) => x.room === r));
    if (next != null) setRoom(next);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveCamRegions({ site, cam, regions: rects });
      message.success(`已保存 ${rects.length} 个单间的区域，统计会按它把 cam${cam} 里的狗算到各间`);
      qc.invalidateQueries({ queryKey: ["cam-regions"] });
      qc.invalidateQueries({ queryKey: ["room-presence"] });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const d = drag.current;
  const missing = rooms.filter((r) => !rects.some((x) => x.room === r));
  return (
    <Modal title={`划分公共区（cam${cam}）里各单间的位置`} open={open} onCancel={onClose} onOk={handleSave} okText="保存" confirmLoading={saving} width={1100} destroyOnClose>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 8 }}
        message="选一个房间号，在画面上拖一个框把那间圈起来；每间一个框。cam7 里检出的狗，框的中心落在哪块就算哪间的，跟单间自己的机位取并集"
      />
      <Space wrap style={{ marginBottom: 8 }}>
        <span>正在画：</span>
        <Select style={{ width: 140 }} value={room ?? undefined} onChange={setRoom} options={rooms.map((r) => ({ value: r, label: `${r} 号单间（cam${r}）` }))} />
        <span>画面时刻</span>
        <InputNumber min={0} step={30} value={t} onChange={(v) => v != null && setT(v)} addonAfter="秒" style={{ width: 130 }} />
        {missing.length > 0 ? <Text type="secondary">还没画：{missing.join("、")} 号</Text> : <Text type="success">全部画完了</Text>}
      </Space>
      <Spin spinning={loading}>
        <div
          ref={boxRef}
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
          style={{ position: "relative", width: "100%", background: "#000", cursor: room != null ? "crosshair" : "default", userSelect: "none" }}
        >
          {img ? <img src={img} alt="" style={{ width: "100%", display: "block" }} draggable={false} /> : <div style={{ height: 400 }} />}
          {rects.map((r) => (
            <div key={r.room} style={{ position: "absolute", left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`, border: `2px solid ${r.room === room ? "#faad14" : "#52c41a"}`, boxSizing: "border-box", pointerEvents: "none" }}>
              <span style={{ position: "absolute", left: 2, top: 2, background: r.room === room ? "#faad14" : "#52c41a", color: "#000", fontSize: 12, padding: "0 4px" }}>{r.room} 号</span>
            </div>
          ))}
          {d && (
            <div style={{ position: "absolute", left: `${Math.min(d.x0, d.x1) * 100}%`, top: `${Math.min(d.y0, d.y1) * 100}%`, width: `${Math.abs(d.x1 - d.x0) * 100}%`, height: `${Math.abs(d.y1 - d.y0) * 100}%`, border: "2px dashed #faad14", pointerEvents: "none" }} />
          )}
        </div>
      </Spin>
      <Space wrap style={{ marginTop: 8 }}>
        {[...rects].sort((a, b) => a.room - b.room).map((r) => (
          <Tag key={r.room} closable onClose={() => setRects((prev) => prev.filter((x) => x.room !== r.room))} color={r.room === room ? "gold" : "green"}>
            {r.room} 号
          </Tag>
        ))}
        {rects.length === 0 && <Text type="secondary">还没画任何一间</Text>}
      </Space>
    </Modal>
  );
}
