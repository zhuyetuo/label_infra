import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Badge, Button, Card, Checkbox, Descriptions, Empty, Input, Modal, Popconfirm, Radio, Segmented, Select, Slider,
  Space, Spin, Table, Tag, Tooltip, Typography, message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { materialPhotoUrl } from "@/api/material";
import {
  createVisionAssignments, deleteVisionAssignment, deleteVisionDataset, exportVisionDataset,
  getSamStatus, getVisionAnnotations, getVisionLabels, getVisionPhotoToken, getVisionStats, listVisionAnnotators,
  listVisionAssignments, listVisionDatasets, listVisionPhotos, reviewVisionAssignment,
  samSegment, saveVisionAnnotations, submitVisionAssignment, suggestToothCodes,
  type VisionAlbum, type VisionAssetState, type VisionAssignment, type VisionAssignmentState,
  type VisionAttrDef, type VisionBox, type VisionDatasetMeta, type VisionItem, type VisionPhoto,
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

const ASSIGN_META: Record<VisionAssignmentState, { color: string; text: string }> = {
  open: { color: "blue", text: "标注中" },
  submitted: { color: "gold", text: "待审" },
  approved: { color: "green", text: "已通过" },
  rejected: { color: "red", text: "被打回" },
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
  const [exporting, setExporting] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [assigning, setAssigning] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // SAM 点选模式：开着的时候单击 = 让 SAM 出一个框，而不是拖框
  const [samMode, setSamMode] = useState(false);

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
  // SAM 可能没配、没起、没权重。查一次就够，用不了就把按钮置灰——
  // 这是设计里说的 L4 降级：SAM 挂了只影响 SAM，手画照常。
  const { data: sam } = useQuery({ queryKey: ["vision-sam-status"], queryFn: getSamStatus, retry: false });
  const samOk = !!sam?.available;

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
      // 先把上一张的框清掉，再去加载。不清的话，这张加载失败时上一张的框还留在
      // state 里，而保存按钮仍然可点——一按就把 A 图的框写进了 B 图，
      // 而且两边都不会报错。
      setItems([]);
      setAssetAttrs({});
      setDirty(false);
      try {
        const [tok, ann] = await Promise.all([
          getVisionPhotoToken(album, relPath),
          getVisionAnnotations(album, relPath),
        ]);
        setImgUrl(materialPhotoUrl(album, relPath, tok.token));
        setItems((ann.items ?? []).map(asDraft));
        setAssetAttrs(ann.asset?.attrs ?? {});
        setDirty(false);
      } catch {
        // imgUrl 保持 null，下面的保存/跳过/SAM 都会因此不可用
        message.error("这张图打不开，换一张试试");
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

  const samPick = useMutation({
    mutationFn: async (pt: { x: number; y: number }) => {
      const forPath = current!;
      const r = await samSegment({ album, path: forPath, points: [{ ...pt, label: 1 }] });
      return { ...r, forPath };
    },
    onSuccess: (r) => {
      // SAM 一次要几百毫秒，这期间人很可能已经翻到下一张了。不认发起时那张的话，
      // 这个框会落到新打开的图上——位置还是按旧图算的
      if (!brush || r.forPath !== current) return;
      setItems((prev) => [...prev, { label_code: brush, bbox: r.bbox, attrs: {} }]);
      setSelected(items.length);
      setDirty(true);
    },
    onError: () => message.warning("SAM 这下没分出东西来，换个位置再点，或者直接拖个框"),
  });

  // 推牙位：纯几何后处理。推不出来时它会说清楚为什么（没拍到锚点/牙太少/视角不对），
  // 原样转述给标注员——他据此决定是换个角度重拍还是接着手填。
  const suggestCodes = useMutation({
    mutationFn: () =>
      suggestToothCodes({
        album,
        path: current!,
        view_code: String(assetAttrs.view_code ?? ""),
        boxes: items.map((it) => ({ label_code: it.label_code, bbox: it.bbox })),
      }),
    onSuccess: (r) => {
      if (!r.suggestions.length) return void message.warning(r.reason || "推不出牙位");
      setItems((prev) =>
        prev.map((it, i) => {
          const hit = r.suggestions.find((s) => s.index === i);
          return hit ? { ...it, attrs: { ...it.attrs, tooth_code: hit.tooth_code } } : it;
        }),
      );
      setDirty(true);
      message.success(
        r.verdict === "ok"
          ? `推出 ${r.suggestions.length} 颗牙的牙位，请逐颗核对`
          : `推出 ${r.suggestions.length} 颗；${r.reason}`,
      );
    },
  });

  const submit = useMutation({
    mutationFn: (id: number) => submitVisionAssignment(id),
    onSuccess: () => {
      message.success("已提交，等审核");
      qc.invalidateQueries({ queryKey: ["vision-photos", album] });
      qc.invalidateQueries({ queryKey: ["vision-assignments", album] });
    },
  });

  const nextPhoto = () => {
    const i = photos.findIndex((p) => p.rel_path === current);
    if (i < 0 || i + 1 >= photos.length) return void message.info("已经是最后一张了");
    // 走跟点左边列表同一条路：保存失败（比如网断）之后按「下一张」，
    // 直接 openPhoto 会把没存上的框静默丢掉
    tryOpen(photos[i + 1].rel_path);
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
    if (samMode && samOk && !hit) {
      // 点在空白处 = 让 SAM 出框。点在已有框上还是当选中，不然改不了已经画好的
      samPick.mutate({ x: px / w, y: py / h });
      return;
    }
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
        // 图没加载出来就不让存：那时 items 是空的，存下去等于把这张图清空
        if (current && imgUrl && !save.isPending) save.mutate("done");
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
  }, [catalog, selected, current, imgUrl, save]);

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
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            <Segmented
              size="small"
              block
              value={album}
              onChange={(v) => setAlbum(v as VisionAlbum)}
              options={[{ label: "口腔", value: "oral" }, { label: "皮肤", value: "skin" }]}
            />
            {tree?.is_manager && (
              selectMode ? (
                <Space size={4}>
                  <Button size="small" type="primary" disabled={!picked.length} onClick={() => setAssigning(true)}>
                    指派这 {picked.length} 组
                  </Button>
                  <Button size="small" onClick={() => { setSelectMode(false); setPicked([]); }}>取消</Button>
                </Space>
              ) : (
                <Space size={4}>
                  <Button size="small" onClick={() => setSelectMode(true)}>指派…</Button>
                  {tree?.can_review && <Button size="small" onClick={() => setReviewing(true)}>审核</Button>}
                </Space>
              )
            )}
            {!tree?.is_manager && tree?.can_review && (
              <Button size="small" block onClick={() => setReviewing(true)}>审核</Button>
            )}
          </Space>
        }
      >
        {isLoading ? (
          <Spin />
        ) : !photos.length ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={tree?.can_review ? "这个相册里没有照片" : "还没有指派给你的照片，找管理员派一组"}
          />
        ) : (
          (tree?.folders ?? []).map((f) => (
            <div key={f.folder} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>{f.folder}</div>
              {f.dogs.map((d) => (
                <div key={d.name} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, display: "flex", alignItems: "center", gap: 4 }}>
                    <span>{d.name}</span>
                    {d.assignment && <Tag color={ASSIGN_META[d.assignment.state].color} style={{ marginInlineEnd: 0 }}>
                      {ASSIGN_META[d.assignment.state].text}
                    </Tag>}
                    {tree?.is_manager && d.assignment?.assignee_name && (
                      <span style={{ color: "#aaa", fontWeight: 400 }}>{d.assignment.assignee_name}</span>
                    )}
                    {selectMode && (
                      <input
                        type="checkbox"
                        style={{ marginLeft: "auto" }}
                        checked={picked.includes(d.group_key)}
                        onChange={(e) =>
                          setPicked((prev) => (e.target.checked ? [...prev, d.group_key] : prev.filter((g) => g !== d.group_key)))
                        }
                      />
                    )}
                  </div>
                  {d.assignment?.state === "rejected" && d.assignment.review_note && (
                    <div style={{ fontSize: 12, color: "#d4380d", background: "#fff2e8", padding: "2px 6px", borderRadius: 3 }}>
                      打回：{d.assignment.review_note}
                    </div>
                  )}
                  {d.assignment && !tree?.can_review && ["open", "rejected"].includes(d.assignment.state) && (
                    <Button
                      size="small"
                      type="link"
                      style={{ padding: 0, height: 20, fontSize: 12 }}
                      loading={submit.isPending}
                      onClick={() => submit.mutate(d.assignment!.id)}
                    >
                      这组标完了，提交
                    </Button>
                  )}
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
              <Button size="small" disabled={!imgUrl} onClick={() => save.mutate("skipped")} loading={save.isPending}>跳过</Button>
              <Button size="small" type="primary" disabled={!imgUrl} onClick={() => save.mutate("done")} loading={save.isPending}>
                保存（Ctrl+S）
              </Button>
              <Button size="small" onClick={nextPhoto}>下一张</Button>
              {catalog?.domain === "tooth" && (
                <Tooltip
                  title={
                    !assetAttrs.view_code
                      ? "先在右栏选这张图的视角（左颊/右颊），牙位是按象限推的"
                      : "按 Triadan 规则推每颗牙的牙位：以犬齿 x04 和第一臼齿 x09 为锚点沿牙弓递推，缺牙留空号。两个锚点少一个就整排不给号——宁可不给，也不要给一个自洽但整排错位的结果。推完请逐颗核对。"
                  }
                >
                  <Button
                    size="small"
                    disabled={!imgUrl || !items.length || !assetAttrs.view_code}
                    loading={suggestCodes.isPending}
                    onClick={() => suggestCodes.mutate()}
                  >
                    推牙位
                  </Button>
                </Tooltip>
              )}
              <Tooltip title={samOk ? "开着的时候，在牙上点一下就出一个框；点已有的框还是选中它" : (sam?.error || "SAM 辅助没开")}>
                <Button
                  size="small"
                  type={samMode ? "primary" : "default"}
                  disabled={!samOk}
                  loading={samPick.isPending}
                  onClick={() => setSamMode((v) => !v)}
                >
                  SAM 点选
                </Button>
              </Tooltip>
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
              style={{ position: "absolute", left: 0, top: 0, cursor: samMode && samOk ? "cell" : "crosshair" }}
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
        <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>
          进度：{stats?.total_boxes ?? 0} 个框
          {stats?.by_state?.length ? `　${stats.by_state.map((s) => `${STATE_META[s.state as VisionAssetState]?.text ?? s.state} ${s.n}`).join("　")}` : ""}
        </div>
        <Button size="small" block onClick={() => setExporting(true)}>导出训练集…</Button>
      </Card>

      <ExportModal open={exporting} album={album} onClose={() => setExporting(false)} />
      <AssignModal
        open={assigning}
        album={album}
        groups={picked}
        onClose={(done) => {
          setAssigning(false);
          if (done) {
            setSelectMode(false);
            setPicked([]);
          }
        }}
      />
      <ReviewModal open={reviewing} album={album} onClose={() => setReviewing(false)} />
    </div>
  );
}

/** 把选中的几组指派给一个人。一组同时只属于一个人——允许多人同标一组，
 *  而标注又是整张覆盖保存的，两个人会互相覆盖且谁都收不到提示。 */
function AssignModal({ open, album, groups, onClose }: {
  open: boolean; album: VisionAlbum; groups: string[]; onClose: (done: boolean) => void;
}) {
  const qc = useQueryClient();
  const [who, setWho] = useState<number | null>(null);
  const { data: people } = useQuery({ queryKey: ["vision-annotators"], queryFn: listVisionAnnotators, enabled: open });

  const run = useMutation({
    mutationFn: () => createVisionAssignments({ album, group_keys: groups, assignee_id: who! }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["vision-photos", album] });
      qc.invalidateQueries({ queryKey: ["vision-assignments", album] });
      if (r.locked.length) {
        message.warning(`${r.created + r.moved} 组已指派；${r.locked.length} 组已审核通过、锁定了，要改派先让审核员打回`);
      } else {
        message.success(`已指派 ${r.created + r.moved} 组`);
      }
      onClose(true);
    },
  });

  return (
    <Modal
      open={open}
      title={`指派 ${groups.length} 组照片`}
      onCancel={() => onClose(false)}
      onOk={() => who && run.mutate()}
      okButtonProps={{ disabled: !who, loading: run.isPending }}
      okText="指派"
      cancelText="取消"
    >
      <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>
        {groups.join("、") || "还没选组"}
      </div>
      <Select
        style={{ width: "100%" }}
        placeholder="指派给谁"
        value={who}
        onChange={setWho}
        options={(people ?? []).map((p) => ({ value: p.id, label: `${p.name}（${p.role}）` }))}
      />
      <Alert
        type="info"
        showIcon
        style={{ marginTop: 10 }}
        message="标注员只看得到指派给自己的组"
        description="别的组在接口层就被剔掉了，不是靠前端不显示。已经指派过的组会改派，改派会把状态退回「标注中」。"
      />
    </Modal>
  );
}

/** 审核：通过（锁定）或打回（要写清楚哪里改）。 */
function ReviewModal({ open, album, onClose }: { open: boolean; album: VisionAlbum; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState<Record<number, string>>({});
  const { data: rows } = useQuery({
    queryKey: ["vision-assignments", album],
    queryFn: () => listVisionAssignments(album),
    enabled: open,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["vision-assignments", album] });
    qc.invalidateQueries({ queryKey: ["vision-photos", album] });
  };

  const act = useMutation({
    mutationFn: (v: { id: number; approve: boolean }) =>
      reviewVisionAssignment(v.id, { approve: v.approve, note: note[v.id] }),
    onSuccess: (_d, v) => {
      message.success(v.approve ? "已通过，这组锁定了" : "已打回");
      refresh();
    },
  });
  const drop = useMutation({
    mutationFn: (id: number) => deleteVisionAssignment(id),
    onSuccess: () => {
      message.success("已撤销指派（标好的框留着）");
      refresh();
    },
  });

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={820} title="指派与审核">
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={rows ?? []}
        locale={{ emptyText: "还没有指派" }}
        columns={[
          { title: "组", dataIndex: "group_key" },
          { title: "标注员", dataIndex: "assignee_name" },
          {
            title: "状态",
            dataIndex: "state",
            render: (s: VisionAssignmentState, r: VisionAssignment) => (
              <Space direction="vertical" size={0}>
                <Tag color={ASSIGN_META[s].color}>{ASSIGN_META[s].text}</Tag>
                {r.review_note && <span style={{ fontSize: 12, color: "#888" }}>{r.review_note}</span>}
              </Space>
            ),
          },
          {
            title: "打回意见",
            width: 220,
            render: (_: unknown, r: VisionAssignment) => (
              <Input
                size="small"
                placeholder="打回必须写哪里要改"
                value={note[r.id] ?? ""}
                onChange={(e) => setNote((p) => ({ ...p, [r.id]: e.target.value }))}
              />
            ),
          },
          {
            title: "",
            width: 190,
            render: (_: unknown, r: VisionAssignment) => (
              <Space size={4}>
                <Popconfirm title={`通过并锁定 ${r.group_key}？`} onConfirm={() => act.mutate({ id: r.id, approve: true })}>
                  <Button size="small" type="primary" disabled={r.state === "approved"}>通过</Button>
                </Popconfirm>
                <Button
                  size="small"
                  danger
                  disabled={!((note[r.id] ?? "").trim())}
                  onClick={() => act.mutate({ id: r.id, approve: false })}
                >
                  打回
                </Button>
                <Popconfirm title="撤销指派？标好的框会留着" onConfirm={() => drop.mutate(r.id)}>
                  <Button size="small" type="text">撤销</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <div style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
        通过 = 锁定，之后连管理员也不能直接改，要改先在这里打回。
      </div>
    </Modal>
  );
}

/** 导出成 YOLO 检测数据集。落 data_train_vision/，跟模型训练页那边的 data_train 分开。 */
function ExportModal({ open, album, onClose }: { open: boolean; album: VisionAlbum; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [valRatio, setValRatio] = useState(0.2);
  const [onlyApproved, setOnlyApproved] = useState(false);
  const [last, setLast] = useState<VisionDatasetMeta | null>(null);

  const { data: datasets } = useQuery({ queryKey: ["vision-datasets"], queryFn: listVisionDatasets, enabled: open });
  const refresh = () => qc.invalidateQueries({ queryKey: ["vision-datasets"] });

  const run = useMutation({
    mutationFn: () => exportVisionDataset({ album, name: name.trim(), val_ratio: valRatio, only_approved: onlyApproved }),
    onSuccess: (meta) => {
      setLast(meta);
      setName("");
      refresh();
      message.success(`导出好了：${meta.n_images} 张图，${meta.total_boxes} 个框`);
    },
  });

  const del = useMutation({
    mutationFn: (n: string) => deleteVisionDataset(n),
    onSuccess: () => {
      refresh();
      message.success("已删除");
    },
  });

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={720} title="导出 YOLO 检测数据集">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="只有「标完」的图会进数据集"
        description={
          <span style={{ fontSize: 13 }}>
            标完但一个框都没有的图 = <b>显式负样本</b>（写一个空 txt，模型会把它当纯背景图学）；
            「未标」和「跳过」的一律不进。所以标之前先想清楚：这张是真没有目标，还是你还没标。
          </span>
        }
      />
      <Space.Compact style={{ width: "100%", marginBottom: 10 }}>
        <Input
          placeholder="数据集名，字母数字下划线短横线，比如 oral_v1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={() => name.trim() && run.mutate()}
        />
        <Button type="primary" loading={run.isPending} disabled={!name.trim()} onClick={() => run.mutate()}>
          导出
        </Button>
      </Space.Compact>
      <div style={{ fontSize: 12, color: "#888" }}>
        验证集比例 {Math.round(valRatio * 100)}%
        <Tooltip title="按「日期/狗」整组切分，同一次拍摄的连拍不会散到两边——散了的话 val 里全是 train 的近邻图，指标会虚高。切分按组名哈希，同一批标注导多少次结果都一样。">
          <span style={{ marginLeft: 4, cursor: "help", borderBottom: "1px dotted #aaa" }}>?</span>
        </Tooltip>
      </div>
      <Slider min={0} max={0.5} step={0.05} value={valRatio} onChange={setValRatio} />
      <Checkbox checked={onlyApproved} onChange={(e) => setOnlyApproved(e.target.checked)}>
        只要审核通过的组
        <Tooltip title="不勾：被审核员打回的组一律排除，其余（通过 / 还没审 / 没指派）都进——小团队里管理员常常自己标自己不审，全要求通过的话就导不出东西。勾上：只有审核通过的组才进。">
          <span style={{ marginLeft: 4, cursor: "help", borderBottom: "1px dotted #aaa" }}>?</span>
        </Tooltip>
      </Checkbox>

      {last && (
        <Descriptions size="small" bordered column={2} style={{ marginBottom: 12 }} title={`刚导出：${last.name}`}>
          <Descriptions.Item label="图片">{last.counts.train} 训练 / {last.counts.val} 验证</Descriptions.Item>
          <Descriptions.Item label="框">{last.total_boxes}</Descriptions.Item>
          <Descriptions.Item label="负样本">{last.negatives.train + last.negatives.val}</Descriptions.Item>
          <Descriptions.Item label="排除">
            {Object.entries(last.excluded).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join("　") || "无"}
          </Descriptions.Item>
          <Descriptions.Item label="各类别" span={2}>
            {Object.entries(last.boxes_per_class).map(([k, v]) => <Tag key={k}>{k} {v}</Tag>)}
          </Descriptions.Item>
          {!!last.warnings.length && (
            <Descriptions.Item label="注意" span={2}>
              {last.warnings.map((w) => <div key={w} style={{ color: "#d46b08" }}>{w}</div>)}
            </Descriptions.Item>
          )}
        </Descriptions>
      )}

      <Table
        size="small"
        rowKey="name"
        pagination={false}
        dataSource={datasets ?? []}
        locale={{ emptyText: "还没导出过" }}
        columns={[
          { title: "名字", dataIndex: "name" },
          { title: "相册", dataIndex: "album", render: (a: string) => (a === "oral" ? "口腔" : "皮肤") },
          { title: "图", render: (_: unknown, r: VisionDatasetMeta) => `${r.counts.train}/${r.counts.val}` },
          { title: "框", dataIndex: "total_boxes" },
          { title: "导出时间", dataIndex: "exported_at", render: (v: string) => v?.replace("T", " ") },
          {
            title: "",
            render: (_: unknown, r: VisionDatasetMeta) => (
              <Popconfirm title={`删掉 ${r.name}？`} onConfirm={() => del.mutate(r.name)}>
                <Button size="small" danger type="text">删除</Button>
              </Popconfirm>
            ),
          },
        ]}
      />
      <div style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
        产出在 NAS 的 <code>data_train_vision/&lt;名字&gt;/</code>：<code>data.yaml</code> +{" "}
        <code>images|labels/train|val/</code>，ultralytics 可以直接吃。
        <code>manifest.json</code> 能把导出的文件名查回原始照片路径。
      </div>
    </Modal>
  );
}
