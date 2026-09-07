import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Collapse, Empty, Image, Space, Spin, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getMaterialPhotoToken, listMaterialPhotos, materialPhotoUrl, type Album, type MaterialPhoto } from "@/api/material";

// 素材库相册只读浏览：按 日期目录 > 狗 折叠，缩略图网格，点开大图（antd Image 预览，
// 同一只狗同一天的照片可以左右翻）。皮肤评估页的「皮肤照片」用；牙齿识别页有自己带
// 检测结果的版本（Tooth.tsx）。

export default function PhotoGallery({ album, hint, filterDate, filterDog }: { album: Album; hint?: string; filterDate?: string; filterDog?: string }) {
  const { data: raw, isLoading, error } = useQuery({ queryKey: ["material-photos", album], queryFn: () => listMaterialPhotos(album) });
  // 每日跟踪表里点「N 张」时只看那一天那只狗的；不传就是全部
  const data = useMemo(() => {
    if (!raw || (!filterDate && !filterDog)) return raw;
    const folders = raw.folders
      .filter((f) => !filterDate || f.folder.slice(0, 10) === filterDate)
      .map((f) => ({ ...f, dogs: f.dogs.filter((d) => !filterDog || d.name === filterDog) }))
      .filter((f) => f.dogs.length > 0);
    return { ...raw, folders };
  }, [raw, filterDate, filterDog]);
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
  if (!data?.folders.length) return <Empty description="还没有照片" />;

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
