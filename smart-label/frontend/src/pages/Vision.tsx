import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Badge, Button, Card, Empty, Modal, Radio, Segmented, Select, Space, Spin, Tag, Tooltip, Typography, message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getMaterialPhotoToken, materialPhotoUrl } from "@/api/material";
import {
  getVisionAnnotations, getVisionLabels, getVisionStats, listVisionPhotos, saveVisionAnnotations,
  type VisionAlbum, type VisionAssetState, type VisionAttrDef, type VisionBox, type VisionItem, type VisionPhoto,
} from "@/api/vision";

// 视觉标注工作台（雏形）：在素材库的口腔/皮肤照片上画框、打类别、填属性。
//
// 跟现有标注工作台（AnnotationWorkspace）没有任何关系——那套是一维时间段 + IMU 波形，
// 几何标注塞不进去。这里自成一套，照片走 /material 只读相册（一行没改），标注落
// vision_* 两张新表。所以这个页面出问题不会影响任何现有功能。
//
// 画布是裸 canvas，没引 konva/fabric：雏形阶段只要"画框、选框、挪框、拉大小"，
// 几十行的事，引个库反而要处理它和 antd、和图片缩放的配合。

const STATE_META: Record<VisionAssetState, { color: string; text: string }> = {
  todo: { color: "default", text: "未标" },
  done: { color: "success", text: "标完" },
  skipped: { color: "warning", text: "跳过" },
};

/** 犬 modified Triadan 牙位：上颌每象限 10 颗（x01-x10），下颌 11 颗（x01-x11）。
 *  111/211 在犬中不存在（上颌只有 2 颗臼齿），所以上颌到 10 为止。 */
const TOOTH_CODES = (() => {
  const out: { value: number; label: string }[] = [];
  const names: Record<number, string> = { 1: "右上", 2: "左上", 3: "左下", 4: "右下" };
  for (const q of [1, 2, 3, 4]) {
    const last = q <= 2 ? 10 : 11;
    for (let i = 1; i <= last; i++) out.push({ value: q * 100 + i, label: `${q * 100 + i}（${names[q]}）` });
  }
  return out;
})();

type Draft = { label_code: string; bbox: VisionBox; attrs: Record<string, number | string> };

const asDraft = (it: VisionItem): Draft => ({ label_code: it.label_code, bbox: it.bbox, attrs: it.attrs ?? {} });

/** 拖动中的临时框 → 归一化，并把负宽高翻正（从右下往左上拖是常见操作） */
function rectToBox(x0: number, y0: number, x1: number, y1: number, w: number, h: number): VisionBox {
  const x = Math.min(x0, x1) / w;
  const y = Math.min(y0, y1) / h;
  const bw = Math.abs(x1 - x0) / w;
  const bh = Math.abs(y1 - y0) / h;
  const cx = Math.min(Math.max(x, 0), 1);
  const cy = Math.min(Math.max(y, 0), 1);
  return [cx, cy, Math.min(bw, 1 - cx), Math.min(bh, 1 - cy)];
}

export default function Vision() {
  const qc = useQueryClient();
  const [album, setAlbum] = useState<VisionAlbum>("oral");
  const [current, setCurrent] = useState<string | null>(null);
  const [items, setItems] = useState<Draft[]>([]);
  const [assetAttrs, setAssetAttrs] = useState<Record<string, number | string>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // 当前要画的类别。画完框立刻就带上它，省掉"画框 → 再点类别"的第二步。
  const [brush, setBrush] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<
    | { mode: "create"; x0: number; y0: number; x1: number; y1: number }
    | { mode: "move" | "resize"; idx: number; px: number; py: number; orig: VisionBox }
    | null
  >(null);
  const [, forceDraw] = useState(0);

  const { data: catalog } = useQuery({ queryKey: ["vision-labels", album], queryFn: () => getVisionLabels(album) });
  const { data: tree, isLoading, error } = useQuery({ queryKey: ["vision-photos", album], queryFn: () => listVisionPhotos(album) });
  const { data: stats } = useQuery({ queryKey: ["vision-stats", album], queryFn: () => getVisionStats(album) });

  const photos = useMemo(
    () => (tree?.folders ?? []).flatMap((f) => f.dogs.flatMap((d) => d.photos.map((p) => ({ ...p, folder: f.folder, dog: d.name })))),
    [tree],
  );
  const labelOf = useCallback(
    (code: string) => catalog?.labels.find((l) => l.code === code),
    [catalog],
  );

  // 切相册就把当前照片和草稿清掉，不然会拿口腔的类别去存皮肤的图
  useEffect(() => {
    setCurrent(null);
    setItems([]);
    setAssetAttrs({});
    setSelected(null);
    setDirty(false);
    setBrush(null);
  }, [album]);

  useEffect(() => {
    if (catalog && !brush) setBrush(catalog.labels[0]?.code ?? null);
  }, [catalog, brush]);

  // 打开一张图：换 token 拿图片 URL，同时把已存的框读回来
  const openPhoto = useCallback(
    async (relPath: string) => {
      setCurrent(relPath);
      setSelected(null);
      setImgUrl(null);
      setNatural(null);
      try {
        const [tok, ann] = await Promise.all([
          getMaterialPhotoToken(album, relPath),
          getVisionAnnotations(album, relPath),
        ]);
        setImgUrl(materialPhotoUrl(album, relPath, tok.token));
        setItems((ann.items ?? []).map(asDraft));
        setAssetAttrs(ann.asset?.attrs ?? {});
        setDirty(false);
      } catch {
        message.error("这张图打不开");
      }
    },
    [album],
  );

  const tryOpen = (relPath: string) => {
    if (relPath === current) return;
    if (!dirty) return void openPhoto(relPath);
    Modal.confirm({
      title: "这张还没保存",
      content: "切到别的照片会丢掉刚画的框。",
      okText: "丢掉并切换",
      cancelText: "留下",
      onOk: () => openPhoto(relPath),
    });
  };

  const save = useMutation({
    mutationFn: (state: VisionAssetState) =>
      saveVisionAnnotations({
        album,
        path: current!,
        items: items.map((it) => ({ label_code: it.label_code, bbox: it.bbox, attrs: it.attrs })),
        state,
        asset_attrs: assetAttrs,
        width: natural?.w,
        height: natural?.h,
      }),
    onSuccess: (_d, state) => {
      setDirty(false);
      message.success(state === "skipped" ? "已标记为跳过" : `已保存 ${items.length} 个框`);
      qc.invalidateQueries({ queryKey: ["vision-photos", album] });
      qc.invalidateQueries({ queryKey: ["vision-stats", album] });
    },
  });

  const nextPhoto = () => {
    const i = photos.findIndex((p) => p.rel_path === current);
    if (i >= 0 && i + 1 < photos.length) openPhoto(photos[i + 1].rel_path);
    else message.info("已经是最后一张了");
  };

  // ── 画布 ────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    const img = imgRef.current;
    if (!cv || !img || !img.complete || !img.clientWidth) return;
    const w = img.clientWidth;
    const h = img.clientHeight;
    // 按设备像素比放大画布，否则高分屏上线是糊的
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    items.forEach((it, i) => {
      const [x, y, bw, bh] = it.bbox;
      const color = labelOf(it.label_code)?.color ?? "#666";
      const on = i === selected;
      ctx.lineWidth = on ? 3 : 2;
      ctx.strokeStyle = color;
      ctx.strokeRect(x * w, y * h, bw * w, bh * h);
      if (on) {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.12;
        ctx.fillRect(x * w, y * h, bw * w, bh * h);
        ctx.globalAlpha = 1;
        // 右下角把手：拉大小
        ctx.fillRect((x + bw) * w - 5, (y + bh) * h - 5, 10, 10);
      }
      const name = labelOf(it.label_code)?.name ?? it.label_code;
      const code = it.attrs?.tooth_code;
      const text = code ? `${name} ${code}` : name;
      ctx.font = "12px system-ui, sans-serif";
      const tw = ctx.measureText(text).width + 8;
      ctx.fillStyle = color;
      ctx.fillRect(x * w, Math.max(y * h - 16, 0), tw, 16);
      ctx.fillStyle = "#fff";
      ctx.fillText(text, x * w + 4, Math.max(y * h - 4, 12));
    });

    const d = dragRef.current;
    if (d?.mode === "create") {
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = labelOf(brush ?? "")?.color ?? "#333";
      ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.setLineDash([]);
    }
  }, [items, selected, labelOf, brush]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  const posOf = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top, w: r.width, h: r.height };
  };

  const hitTest = (px: number, py: number, w: number, h: number) => {
    // 从后往前找：后画的在上面，压住的那个应该先被选中
    for (let i = items.length - 1; i >= 0; i--) {
      const [x, y, bw, bh] = items[i].bbox;
      const x1 = x * w;
      const y1 = y * h;
      const x2 = (x + bw) * w;
      const y2 = (y + bh) * h;
      if (px >= x2 - 8 && px <= x2 + 4 && py >= y2 - 8 && py <= y2 + 4) return { idx: i, corner: true };
      if (px >= x1 && px <= x2 && py >= y1 && py <= y2) return { idx: i, corner: false };
    }
    return null;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!current || !imgUrl) return;
    const { px, py, w, h } = posOf(e);
    const hit = hitTest(px, py, w, h);
    if (hit) {
      setSelected(hit.idx);
      dragRef.current = { mode: hit.corner ? "resize" : "move", idx: hit.idx, px, py, orig: items[hit.idx].bbox };
    } else {
      setSelected(null);
      dragRef.current = { mode: "create", x0: px, y0: py, x1: px, y1: py };
    }
    forceDraw((n) => n + 1);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const { px, py, w, h } = posOf(e);
    if (d.mode === "create") {
      d.x1 = px;
      d.y1 = py;
      forceDraw((n) => n + 1);
      draw();
      return;
    }
    const [ox, oy, ow, oh] = d.orig;
    const dx = (px - d.px) / w;
    const dy = (py - d.py) / h;
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== d.idx) return it;
        if (d.mode === "move") {
          const nx = Math.min(Math.max(ox + dx, 0), 1 - ow);
          const ny = Math.min(Math.max(oy + dy, 0), 1 - oh);
          return { ...it, bbox: [nx, ny, ow, oh] as VisionBox };
        }
        const nw = Math.min(Math.max(ow + dx, 0.005), 1 - ox);
        const nh = Math.min(Math.max(oh + dy, 0.005), 1 - oy);
        return { ...it, bbox: [ox, oy, nw, nh] as VisionBox };
      }),
    );
    setDirty(true);
  };

  const onMouseUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.mode !== "create") return void forceDraw((n) => n + 1);
    const cv = canvasRef.current;
    if (!cv || !brush) return;
    const r = cv.getBoundingClientRect();
    const box = rectToBox(d.x0, d.y0, d.x1, d.y1, r.width, r.height);
    // 点一下没拖（<6px）不算画框，否则会到处留下看不见的小框
    if (box[2] * r.width < 6 || box[3] * r.height < 6) return void forceDraw((n) => n + 1);
    setItems((prev) => [...prev, { label_code: brush, bbox: box, attrs: {} }]);
    setSelected(items.length);
    setDirty(true);
  };

  // 热键：数字键切类别（选中了框就顺便改它的类别）、Delete 删框、Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (current && !save.isPending) save.mutate("done");
        return;
      }
      const hit = catalog?.labels.find((l) => l.hotkey === e.key);
      if (hit) {
        setBrush(hit.code);
        if (selected != null) {
          setItems((prev) => prev.map((it, i) => (i === selected ? { ...it, label_code: hit.code } : it)));
          setDirty(true);
        }
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected != null) {
        setItems((prev) => prev.filter((_, i) => i !== selected));
        setSelected(null);
        setDirty(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [catalog, selected, current, save]);

  // ── 属性面板 ────────────────────────────────────────────────────────
  const renderAttr = (def: VisionAttrDef, value: number | string | undefined, onChange: (v: number | string | undefined) => void) => {
    const control =
      def.type === "tooth_code" ? (
        <Select
          size="small"
          allowClear
          showSearch
          style={{ width: 160 }}
          placeholder="看不出来就留空"
          value={value as number | undefined}
          onChange={(v) => onChange(v)}
          options={TOOTH_CODES}
          optionFilterProp="label"
        />
      ) : (
        <Radio.Group size="small" value={value} onChange={(e) => onChange(e.target.value)}>
          {(def.options ?? []).map((o) => (
            <Radio.Button key={String(o.value)} value={o.value}>{o.label}</Radio.Button>
          ))}
        </Radio.Group>
      );
    return (
      <div key={def.key} style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 2 }}>
          {def.name}
          {def.help && (
            <Tooltip title={def.help}>
              <span style={{ marginLeft: 4, cursor: "help", borderBottom: "1px dotted #aaa" }}>?</span>
            </Tooltip>
          )}
        </div>
        {control}
      </div>
    );
  };

  const setItemAttr = (key: string, v: number | string | undefined) => {
    if (selected == null) return;
    setItems((prev) =>
      prev.map((it, i) => {
        if (i !== selected) return it;
        const attrs = { ...it.attrs };
        if (v === undefined || v === null) delete attrs[key];
        else attrs[key] = v;
        return { ...it, attrs };
      }),
    );
    setDirty(true);
  };

  const currentPhoto = photos.find((p) => p.rel_path === current);

  if (error) return <Alert type="error" showIcon message="照片目录读不到" description={String(error)} />;

  return (
    <div style={{ display: "flex", gap: 12, height: "calc(100vh - 120px)" }}>
      {/* 左：照片列表 */}
      <Card
        size="small"
        style={{ width: 260, display: "flex", flexDirection: "column" }}
        styles={{ body: { overflow: "auto", flex: 1, padding: 8 } }}
        title={
          <Segmented
            size="small"
            block
            value={album}
            onChange={(v) => setAlbum(v as VisionAlbum)}
            options={[{ label: "口腔", value: "oral" }, { label: "皮肤", value: "skin" }]}
          />
        }
      >
        {isLoading ? (
          <Spin />
        ) : !photos.length ? (
          <Empty description="这个相册里没有照片" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          (tree?.folders ?? []).map((f) => (
            <div key={f.folder} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>{f.folder}</div>
              {f.dogs.map((d) => (
                <div key={d.name} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{d.name}</div>
                  {d.photos.map((p: VisionPhoto) => (
                    <div
                      key={p.rel_path}
                      onClick={() => tryOpen(p.rel_path)}
                      style={{
                        cursor: "pointer", padding: "2px 6px", borderRadius: 3, fontSize: 12,
                        background: p.rel_path === current ? "#e6f4ff" : undefined,
                        display: "flex", justifyContent: "space-between", gap: 6,
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.filename}</span>
                      <span style={{ flexShrink: 0 }}>
                        {p.n_boxes > 0 && <Badge count={p.n_boxes} color="blue" size="small" />}
                        {p.state !== "todo" && (
                          <Badge status={p.state === "done" ? "success" : "warning"} style={{ marginLeft: 4 }} />
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))
        )}
      </Card>

      {/* 中：画布 */}
      <Card
        size="small"
        style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}
        styles={{ body: { flex: 1, overflow: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center", background: "#fafafa" } }}
        title={
          currentPhoto ? (
            <Space size={6} wrap>
              <Typography.Text style={{ fontSize: 13 }}>{currentPhoto.filename}</Typography.Text>
              <Tag color={STATE_META[currentPhoto.state].color}>{STATE_META[currentPhoto.state].text}</Tag>
              {dirty && <Tag color="orange">未保存</Tag>}
            </Space>
          ) : (
            "从左边挑一张照片"
          )
        }
        extra={
          current && (
            <Space size={4}>
              <Button size="small" onClick={() => save.mutate("skipped")} loading={save.isPending}>跳过</Button>
              <Button size="small" type="primary" onClick={() => save.mutate("done")} loading={save.isPending}>
                保存（Ctrl+S）
              </Button>
              <Button size="small" onClick={nextPhoto}>下一张</Button>
            </Space>
          )
        }
      >
        {!current ? (
          <Empty description="左边选一张照片开始标" style={{ marginTop: 60 }} />
        ) : !imgUrl ? (
          <Spin style={{ marginTop: 60 }} />
        ) : (
          <div style={{ position: "relative", lineHeight: 0 }}>
            <img
              ref={imgRef}
              src={imgUrl}
              alt=""
              style={{ maxWidth: "100%", maxHeight: "calc(100vh - 210px)", display: "block", userSelect: "none" }}
              draggable={false}
              onLoad={(e) => {
                const el = e.currentTarget;
                setNatural({ w: el.naturalWidth, h: el.naturalHeight });
                draw();
              }}
            />
            <canvas
              ref={canvasRef}
              style={{ position: "absolute", left: 0, top: 0, cursor: "crosshair" }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
            />
          </div>
        )}
      </Card>

      {/* 右：类别 + 属性 */}
      <Card size="small" style={{ width: 300 }} styles={{ body: { overflow: "auto", maxHeight: "calc(100vh - 160px)" } }} title="类别与属性">
        <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>画框用哪个类别（数字键切换）</div>
        <Space wrap size={4} style={{ marginBottom: 12 }}>
          {(catalog?.labels ?? []).map((l) => (
            <Button
              key={l.code}
              size="small"
              type={brush === l.code ? "primary" : "default"}
              onClick={() => {
                setBrush(l.code);
                if (selected != null) {
                  setItems((prev) => prev.map((it, i) => (i === selected ? { ...it, label_code: l.code } : it)));
                  setDirty(true);
                }
              }}
              style={{ borderLeft: `4px solid ${l.color}` }}
            >
              {l.hotkey} {l.name}
            </Button>
          ))}
        </Space>

        {selected != null && items[selected] ? (
          <>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>
              选中的框 · {labelOf(items[selected].label_code)?.name}
            </div>
            {(catalog?.item_attrs ?? []).map((def) =>
              renderAttr(def, items[selected].attrs?.[def.key], (v) => setItemAttr(def.key, v)),
            )}
            <Button
              size="small"
              danger
              onClick={() => {
                setItems((prev) => prev.filter((_, i) => i !== selected));
                setSelected(null);
                setDirty(true);
              }}
            >
              删掉这个框（Delete）
            </Button>
          </>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            在图上拖一个框，或者点已有的框来改它。
          </Typography.Text>
        )}

        {!!catalog?.asset_attrs?.length && current && (
          <>
            <div style={{ borderTop: "1px solid #f0f0f0", margin: "14px 0 10px" }} />
            <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>这张图整体</div>
            {catalog.asset_attrs.map((def) =>
              renderAttr(def, assetAttrs[def.key], (v) => {
                setAssetAttrs((prev) => {
                  const next = { ...prev };
                  if (v === undefined || v === null) delete next[def.key];
                  else next[def.key] = v;
                  return next;
                });
                setDirty(true);
              }),
            )}
          </>
        )}

        <div style={{ borderTop: "1px solid #f0f0f0", margin: "14px 0 10px" }} />
        <div style={{ fontSize: 12, color: "#888" }}>
          进度：{stats?.total_boxes ?? 0} 个框
          {stats?.by_state?.length ? `　${stats.by_state.map((s) => `${STATE_META[s.state as VisionAssetState]?.text ?? s.state} ${s.n}`).join("　")}` : ""}
        </div>
      </Card>
    </div>
  );
}
