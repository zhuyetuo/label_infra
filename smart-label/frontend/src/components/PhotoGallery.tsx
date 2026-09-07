import { useEffect, useMemo, useState } from "react";
import { Alert, Collapse, Empty, Image, Space, Spin, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getMaterialPhotoToken, listMaterialPhotos, materialPhotoUrl, type Album, type MaterialPhoto } from "@/api/material";

// 素材库相册只读浏览：按 日期目录 > 狗 折叠，缩略图网格，点开大图（antd Image 预览，
// 同一只狗同一天的照片可以左右翻）。皮肤评估页的「皮肤照片」用；牙齿识别页有自己带
// 检测结果的版本（Tooth.tsx）。

export default function PhotoGallery({ album, hint }: { album: Album; hint?: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: ["material-photos", album], queryFn: () => listMaterialPhotos(album) });
  const [urls, setUrls] = useState<Record<string, string>>({});
  const allPhotos = useMemo(() => (data?.folders ?? []).flatMap((f) => f.dogs.flatMap((d) => d.photos)), [data]);

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

  const grid = (photos: MaterialPhoto[]) => (
    <Image.PreviewGroup>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {photos.map((p) => (
          <div key={p.rel_path} style={{ width: 160 }}>
            <div style={{ width: 160, height: 120, background: "#f0f0f0", borderRadius: 4, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {urls[p.rel_path] ? <Image src={urls[p.rel_path]} alt={p.filename} style={{ maxWidth: 160, maxHeight: 120, objectFit: "contain" }} /> : <Spin size="small" />}
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis={{ tooltip: p.filename }}>{p.filename}</Typography.Text>
          </div>
        ))}
      </div>
    </Image.PreviewGroup>
  );

  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {hint ?? "照片来自素材库 NAS"} <code>{data.root}</code>，按「日期目录 / 狗」归类，只读；共 {allPhotos.length} 张。
      </Typography.Paragraph>
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
