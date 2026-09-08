import { useRef, useState } from "react";
import { Button, Empty, Image, Popconfirm, Space, Spin, Typography, Upload, message } from "antd";
import { useQuery } from "@tanstack/react-query";
import { deleteDogPhoto, dogPhotoUrl, listDogPhotos, uploadDogPhoto, type DogPhoto } from "@/api/dogs";

/**
 * 一只狗的照片：看 + 传 + 删。
 *
 * 跟「皮肤照片」那个相册不是一回事——那个是素材库 NAS 上按日期归档的问诊照片，
 * 只读；这里是档案照，用来认狗（长什么样、什么颜色、戴的哪个项圈），存在可写的
 * ai_data 那块 NAS 上，按狗编号分目录。
 *
 * 图片本身不走登录态：<img src> 带不了 Authorization 头，所以后端给每个文件签一个
 * 有时效的 token，拼在 URL 里。
 */
export default function DogPhotos({ dogId, onChange }: { dogId: number; onChange?: () => void }) {
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["dog-photos", dogId],
    queryFn: () => listDogPhotos(dogId),
  });
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ open: boolean; current: number }>({ open: false, current: 0 });
  const seq = useRef(0);

  const photos = data ?? [];

  const doUpload = async (file: File) => {
    setBusy(true);
    try {
      await uploadDogPhoto(dogId, file);
      message.success("上传好了");
      await refetch();
      onChange?.();
    } catch (e) {
      message.error(`传不上去：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
    return false; // 交给我们自己传，antd 别再发一次
  };

  const remove = async (p: DogPhoto) => {
    await deleteDogPhoto(dogId, p.filename);
    await refetch();
    onChange?.();
  };

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Upload
          multiple
          accept="image/*"
          showUploadList={false}
          beforeUpload={(f) => {
            // 一次选多张时 beforeUpload 会被调多次，顺着传就行
            seq.current += 1;
            return doUpload(f as File);
          }}
        >
          <Button type="primary" loading={busy}>
            传照片
          </Button>
        </Upload>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          jpg/png/webp/bmp，单张不超过 20MB；存在 NAS 上，按狗编号分目录
        </Typography.Text>
      </Space>

      {isLoading ? (
        <Spin />
      ) : photos.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有照片" />
      ) : (
        <>
          {/* 缩略图不各自带预览，统一交给外层一个 PreviewGroup，放大后能一路左右翻 */}
          <Image.PreviewGroup
            items={photos.map((p) => ({ src: dogPhotoUrl(dogId, p.filename, p.token), alt: p.filename }))}
            preview={{
              visible: preview.open,
              current: preview.current,
              onVisibleChange: (v) => setPreview((s) => ({ ...s, open: v })),
              onChange: (c) => setPreview((s) => ({ ...s, current: c })),
            }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {photos.map((p, i) => (
              <div key={p.filename} style={{ width: 160 }}>
                <div
                  style={{
                    width: 160,
                    height: 120,
                    background: "#f0f0f0",
                    borderRadius: 4,
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                  }}
                  onClick={() => setPreview({ open: true, current: i })}
                >
                  <img
                    src={dogPhotoUrl(dogId, p.filename, p.token)}
                    alt={p.filename}
                    loading="lazy"
                    style={{ maxWidth: 160, maxHeight: 120, objectFit: "contain" }}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis={{ tooltip: p.filename }}>
                    {p.uploaded_at.slice(0, 10)} · {(p.size_bytes / 1024 / 1024).toFixed(1)}M
                  </Typography.Text>
                  <Popconfirm title="删掉这张照片？" onConfirm={() => remove(p)}>
                    <Button size="small" type="link" danger style={{ padding: 0 }}>
                      删除
                    </Button>
                  </Popconfirm>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
