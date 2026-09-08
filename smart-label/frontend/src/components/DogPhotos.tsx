import { useMemo, useState } from "react";
import { Button, Empty, Image, Modal, Popconfirm, Space, Spin, Tag, Typography, Upload, message } from "antd";
import { useQuery } from "@tanstack/react-query";
import { deleteDogPhoto, dogPhotoUrl, listDogPhotos, uploadDogPhoto, type DogPhoto } from "@/api/dogs";

/**
 * 一只狗的照片和视频：看 + 传 + 删。
 *
 * 跟「皮肤照片」那个相册不是一回事——那个是素材库 NAS 上按日期归档的问诊照片，
 * 只读；这里是档案资料，用来认狗（长什么样、什么颜色、戴的哪个项圈），以及存
 * 一小段视频看它平时的动作，存在可写的 ai_data 那块 NAS 上，按狗编号分目录。
 *
 * 图片/视频本身不走登录态：<img>/<video> 带不了 Authorization 头，所以后端给每个
 * 文件签一个有时效的 token 拼在 URL 里。视频流支持 Range，能拖进度条。
 */
export default function DogPhotos({ dogId, onChange }: { dogId: number; onChange?: () => void }) {
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["dog-photos", dogId],
    queryFn: () => listDogPhotos(dogId),
  });
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ open: boolean; current: number }>({ open: false, current: 0 });
  const [playing, setPlaying] = useState<DogPhoto | null>(null);

  const items = data ?? [];
  // 图片走 antd 的 PreviewGroup（放大能左右翻），视频走自己的播放弹窗。
  // 索引得按「只算图片」来编，不然翻到视频那一张会是空白
  const images = useMemo(() => items.filter((p) => p.kind === "image"), [items]);

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

  const src = (p: DogPhoto) => dogPhotoUrl(dogId, p.filename, p.token);

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Upload multiple accept="image/*,video/*" showUploadList={false} beforeUpload={(f) => doUpload(f as File)}>
          <Button type="primary" loading={busy}>
            传照片 / 视频
          </Button>
        </Upload>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          图片 jpg/png/webp/bmp 单张 20MB；视频 mp4/mov/webm 单个 500MB。存在 NAS 上，按狗编号分目录
        </Typography.Text>
      </Space>

      {isLoading ? (
        <Spin />
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有照片或视频" />
      ) : (
        <>
          {/* 缩略图不各自带预览，统一交给外层一个 PreviewGroup，放大后能一路左右翻 */}
          <Image.PreviewGroup
            items={images.map((p) => ({ src: src(p), alt: p.filename }))}
            preview={{
              visible: preview.open,
              current: preview.current,
              onVisibleChange: (v) => setPreview((s) => ({ ...s, open: v })),
              onChange: (c) => setPreview((s) => ({ ...s, current: c })),
            }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {items.map((p) => (
              <div key={p.filename} style={{ width: 160 }}>
                <div
                  style={{
                    position: "relative",
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
                  onClick={() =>
                    p.kind === "video"
                      ? setPlaying(p)
                      : setPreview({ open: true, current: images.findIndex((x) => x.filename === p.filename) })
                  }
                >
                  {p.kind === "video" ? (
                    <>
                      {/* preload="metadata" 只拉头上那点数据出首帧当封面，不会把整段视频下下来 */}
                      <video src={src(p)} preload="metadata" muted style={{ maxWidth: 160, maxHeight: 120 }} />
                      <Tag color="blue" style={{ position: "absolute", left: 4, top: 4, margin: 0 }}>
                        视频
                      </Tag>
                    </>
                  ) : (
                    <img
                      src={src(p)}
                      alt={p.filename}
                      loading="lazy"
                      style={{ maxWidth: 160, maxHeight: 120, objectFit: "contain" }}
                    />
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis={{ tooltip: p.filename }}>
                    {p.uploaded_at.slice(0, 10)} · {(p.size_bytes / 1024 / 1024).toFixed(1)}M
                  </Typography.Text>
                  <Popconfirm title={`删掉这${p.kind === "video" ? "段视频" : "张照片"}？`} onConfirm={() => remove(p)}>
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

      <Modal open={!!playing} title={playing?.filename} onCancel={() => setPlaying(null)} footer={null} width={880} destroyOnClose>
        {playing && <video src={src(playing)} controls autoPlay style={{ width: "100%", maxHeight: "70vh" }} />}
      </Modal>
    </div>
  );
}
