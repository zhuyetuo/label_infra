import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Collapse, Empty, Image, Select, Space, Spin, Tabs, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getMaterialPhotoToken, listMaterialPhotos, materialPhotoUrl, type Album, type MaterialPhoto } from "@/api/material";
import { getSavedText, saveText } from "@/utils/persistedSize";

// 素材库相册只读浏览：按 日期目录 > 狗 折叠，缩略图网格，点开大图（antd Image 预览，
// 同一只狗同一天的照片可以左右翻）。皮肤评估页的「皮肤照片」用；牙齿识别页有自己带
// 检测结果的版本（Tooth.tsx）。

export default function PhotoGallery({ album, hint, filterDate, filterDog }: { album: Album; hint?: string; filterDate?: string; filterDog?: string }) {
  const { data: raw, isLoading, error } = useQuery({ queryKey: ["material-photos", album], queryFn: () => listMaterialPhotos(album) });
  // 来源（视频问诊 / 雷喏斯达 / 博朗旺…）和狗：几个地方很多天混在一起没法看，先按来源分开。
  // 从外面带了日期/狗进来（每日跟踪表里点「N 张」）时不显示这两个筛选，只看那一格
  const pinned = !!(filterDate || filterDog);
  const sourceKey = `smart-label:photos-source:${album}`;
  const [source, setSourceState] = useState(() => getSavedText(sourceKey, "all"));
  const setSource = (k: string) => { setSourceState(k); saveText(sourceKey, k); setDog(undefined); };
  const [dog, setDog] = useState<string | undefined>(undefined);
  const sources = raw?.sources ?? [];
  // 记住的来源这次没扫到（比如那个狗场目录改名了）→ 回到全部，别停在空页上
  const curSource = source === "all" || sources.some((s) => s.source === source) ? source : "all";
  const inSource = useMemo(
    () => (raw?.folders ?? []).filter((f) => curSource === "all" || f.source === curSource),
    [raw, curSource]
  );
  const dogNames = useMemo(() => [...new Set(inSource.flatMap((f) => f.dogs.map((d) => d.name)))].sort(), [inSource]);
  const data = useMemo(() => {
    if (!raw) return raw;
    const wantDate = filterDate, wantDog = filterDog ?? (pinned ? undefined : dog);
    const base = pinned ? raw.folders : inSource;
    const folders = base
      // 按解析出来的日期比：狗场那几棵树的目录名开头是树名，按前 10 个字符比永远对不上
      .filter((f) => !wantDate || f.date === wantDate)
      .map((f) => ({ ...f, dogs: f.dogs.filter((d) => !wantDog || d.name === wantDog) }))
      .filter((f) => f.dogs.length > 0);
    return { ...raw, folders };
  }, [raw, inSource, filterDate, filterDog, dog, pinned]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ open: boolean; current: number }>({ open: false, current: 0 });

  // 带上狗名，弹窗标题里能看出翻到哪只狗了；顺序 = 页面上的顺序（日期 > 狗 > 文件名）
  const allPhotos = useMemo(
    () => (data?.folders ?? []).flatMap((f) => f.dogs.flatMap((d) => d.photos.map((p) => ({ ...p, dog: d.name, folder: f.folder })))),
    [data]
  );

  useEffect(() => {
    // 缩略图要带路径签名 token，8 个一组换，几百张几秒钟
    const missing = allPhotos.filter((p) => !urls[p.rel_path]).map((p) => p.rel_path);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < missing.length; i += 8) {
        const chunk = missing.slice(i, i + 8);
        const tokens = await Promise.all(chunk.map((p) => getMaterialPhotoToken(album, p).catch(() => null)));
        if (cancelled) return;
        const next: Record<string, string> = {};
        chunk.forEach((p, j) => { if (tokens[j]) next[p] = materialPhotoUrl(album, p, tokens[j]!.token); });
        setUrls((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allPhotos, album]);
  if (error) {
    return <Alert type="error" showIcon message="照片目录读不到" description={`${(error as Error).message}。确认素材库 NAS 已挂到 /home/toky/alg_material 并在 docker-compose 里挂进了容器。`} />;
  }
  if (isLoading) return <Spin />;

  // 扫到了目录却没出照片的来源：把原因摆出来，不然人只会看到"这个狗场的数据不见了"
  const problems = sources.filter((s) => (curSource === "all" || s.source === curSource) && (s.photos === 0 || s.unclassified > 0));
  const problemAlert = !pinned && problems.length > 0 && (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message="有照片没显示出来"
      description={
        <div>
          {problems.map((s) => (
            <div key={s.path} style={{ marginBottom: 4 }}>
              <b>{s.source}</b>（{s.path}）：显示 {s.photos} 张
              {s.unclassified > 0 && <>，另有 {s.unclassified} 张分不出是皮肤还是口腔，没放进来。例：{s.examples.map((e) => <code key={e} style={{ marginLeft: 4 }}>{e}</code>)}</>}
              {s.photos === 0 && s.unclassified === 0 && <>，一张都没扫到。目录要按「日期（含8位数字）/ 狗 / 品类 / 照片」放</>}
            </div>
          ))}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            狗场目录里，品类子目录名或照片文件名要带「皮肤 / 瘙痒」或「口腔 / 牙齿」，平台才知道放进哪个相册。
          </Typography.Text>
        </div>
      }
    />
  );
  const filters = !pinned && sources.length > 1 && (
    <>
      <Tabs
        size="small"
        activeKey={curSource}
        onChange={setSource}
        items={[
          { key: "all", label: `全部 ${sources.reduce((n, s) => n + s.photos, 0)}` },
          ...sources.map((s) => ({ key: s.source, label: `${s.source} ${s.photos}` })),
        ]}
      />
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear
          showSearch
          size="small"
          style={{ width: 200 }}
          placeholder="全部狗"
          value={dog}
          onChange={setDog}
          options={dogNames.map((n) => ({ value: n, label: n }))}
        />
      </Space>
    </>
  );
  if (!data?.folders.length) return <div>{filters}{problemAlert}<Empty description="还没有照片" /></div>;

  // 缩略图只渲染（不带预览），预览统一由外层一个 PreviewGroup 接管，这样整页的图
  // 在放大状态下能一路左右翻，不用关掉再点下一张；工具栏里加两个明显的左右按钮
  const grid = (photos: MaterialPhoto[]) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      {photos.map((p) => {
        const idx = allPhotos.findIndex((x) => x.rel_path === p.rel_path);
        return (
          <div key={p.rel_path} style={{ width: 160, cursor: "pointer" }} onClick={() => urls[p.rel_path] && setPreview({ open: true, current: idx })}>
            <div style={{ width: 160, height: 120, background: "#f0f0f0", borderRadius: 4, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {urls[p.rel_path] ? <img src={urls[p.rel_path]} alt={p.filename} style={{ maxWidth: 160, maxHeight: 120, objectFit: "contain" }} loading="lazy" /> : <Spin size="small" />}
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis={{ tooltip: p.filename }}>{p.filename}</Typography.Text>
          </div>
        );
      })}
    </div>
  );

  return (
    <div>
      {filters}
      {problemAlert}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {hint ?? "照片来自素材库 NAS"} <code>{data.root}</code>，按「日期目录 / 狗」归类，只读；共 {allPhotos.length} 张。点图放大，工具栏左右按钮或键盘方向键翻上一张/下一张。
      </Typography.Paragraph>
      <Image.PreviewGroup
        items={allPhotos.map((p) => ({ src: urls[p.rel_path] ?? "", alt: `${p.folder} / ${p.dog} / ${p.filename}` }))}
        preview={{
          visible: preview.open,
          current: preview.current,
          onVisibleChange: (open: boolean) => setPreview((prev) => ({ ...prev, open })),
          onChange: (current: number) => setPreview((prev) => ({ ...prev, current })),
          // 路径放图片最上面（imageRender 里贴一条），工具栏只留"上一张 | 原生按钮 | 下一张"，两个翻页按钮挨着
          // 不能给 originalNode 外面套 div——会破坏 antd 给图片定的最大尺寸，图片撑满整屏；
          // 标签用 fixed 定位单独贴，跟图片布局无关
          imageRender: (originalNode, { current }) => (
            <>
              {originalNode}
              {allPhotos[current] && <ImageCaption text={`${allPhotos[current].folder} / ${allPhotos[current].dog} / ${allPhotos[current].filename}`} />}
            </>
          ),
          toolbarRender: (originalNode, info) => (
            <Space size={8}>
              <Button size="small" disabled={info.current <= 0} onClick={() => info.actions.onActive?.(-1)}>← 上一张</Button>
              {originalNode}
              <Button size="small" disabled={info.current >= info.total - 1} onClick={() => info.actions.onActive?.(1)}>下一张 →</Button>
            </Space>
          ),
        }}
      />
      <Collapse
        key={`${curSource}|${dog ?? ""}`}
        defaultActiveKey={[data.folders[0].folder]}
        items={data.folders.map((f) => ({
          key: f.folder,
          label: (
            <Space>
              <b>{f.folder}</b>
              {!f.ok && <Tag color="orange">未整理（目录名没有 -ok）</Tag>}
              <Typography.Text type="secondary">{f.dogs.map((d) => `${d.name} ${d.photos.length}`).join(" · ")}</Typography.Text>
            </Space>
          ),
          children: (
            <Collapse
              size="small"
              defaultActiveKey={f.dogs.map((d) => d.name)}
              items={f.dogs.map((d) => ({ key: d.name, label: <Space><b>{d.name}</b><Typography.Text type="secondary">{d.photos.length} 张</Typography.Text></Space>, children: grid(d.photos) }))}
            />
          ),
        }))}
      />
    </div>
  );
}


// 贴在预览图正上方的路径标签：不能给 antd 的 img 套容器（会破坏它的尺寸约束），
// 所以单独 fixed 定位，位置按实际渲染出来的图片边框算（缩放/旋转/换图都跟着走）
function ImageCaption({ text }: { text: string }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const img = document.querySelector<HTMLImageElement>(".ant-image-preview-img");
      if (img) {
        const r = img.getBoundingClientRect();
        setPos((prev) => {
          const next = { top: Math.max(8, r.top - 34), left: r.left + r.width / 2 };
          return prev && Math.abs(prev.top - next.top) < 1 && Math.abs(prev.left - next.left) < 1 ? prev : next;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]);
  if (!pos) return null;
  return (
    <div style={{ position: "fixed", top: pos.top, left: pos.left, transform: "translateX(-50%)", background: "rgba(0,0,0,0.6)", color: "#fff", padding: "4px 12px", borderRadius: 4, fontSize: 13, pointerEvents: "none", zIndex: 1, whiteSpace: "nowrap" }}>
      {text}
    </div>
  );
}
