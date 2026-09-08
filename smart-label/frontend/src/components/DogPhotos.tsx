import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Image, Modal, Popconfirm, Progress, Space, Spin, Tag, Typography, Upload, message } from "antd";
import { useQuery } from "@tanstack/react-query";
import { deleteDogPhoto, dogPhotoUrl, listDogPhotos, uploadDogPhoto, type DogPhoto } from "@/api/dogs";

// 从剪贴板贴进来的图往往没有文件名（或者叫 image.png 之类），后端是按后缀判类型的，
// 没后缀会被直接挡掉——这里按 MIME 补一个，顺便给个带时间的名字，不然一天贴十张
// 全叫 image.png，在 NAS 上看不出哪张是哪张
const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/bmp": ".bmp",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
};

function namedForUpload(f: File, i: number): File {
  const hasExt = /\.[A-Za-z0-9]{2,4}$/.test(f.name || "");
  if (f.name && hasExt) return f;
  const ext = MIME_EXT[f.type] ?? "";
  return new File([f], `粘贴${i + 1}${ext}`, { type: f.type });
}

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
  // 一次可以扔一堆（选多个 / 拖一把 / 粘贴），排队一个一个传：
  // 并发传几百 MB 的视频只会互相抢带宽，还容易把 NAS 写爆
  const [queue, setQueue] = useState<{ done: number; total: number; name: string } | null>(null);
  const running = useRef(false);
  const pending = useRef<File[]>([]);
  const [preview, setPreview] = useState<{ open: boolean; current: number }>({ open: false, current: 0 });
  const [playing, setPlaying] = useState<DogPhoto | null>(null);

  const items = data ?? [];
  // 图片走 antd 的 PreviewGroup（放大能左右翻），视频走自己的播放弹窗。
  // 索引得按「只算图片」来编，不然翻到视频那一张会是空白
  const images = useMemo(() => items.filter((p) => p.kind === "image"), [items]);

  const enqueue = useCallback(
    async (files: File[]) => {
      const ok = files.filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
      if (!ok.length) return;
      pending.current.push(...ok.map((f, i) => namedForUpload(f, i)));
      if (running.current) return; // 已经有一批在传，新来的接在后面
      running.current = true;
      let done = 0;
      let failed = 0;
      const total = () => done + failed + pending.current.length;
      while (pending.current.length) {
        const f = pending.current.shift()!;
        setQueue({ done: done + failed, total: total(), name: f.name });
        try {
          await uploadDogPhoto(dogId, f);
          done += 1;
        } catch (e) {
          failed += 1;
          message.error(`${f.name} 传不上去：${(e as Error).message}`);
        }
      }
      running.current = false;
      setQueue(null);
      if (done) message.success(`上传好了 ${done} 个${failed ? `，${failed} 个失败` : ""}`);
      // 传完一次性刷新，不要每传一个刷一次
      await refetch();
      onChange?.();
    },
    [dogId, refetch, onChange]
  );

  // Ctrl+V 直接贴：从聊天窗口、截图工具、文件管理器复制过来的图和视频都能进
  // （复制文件时 clipboardData.files 就是那些文件本身）。
  // 组件是 destroyOnClose 挂载的，所以监听整个窗口不会串到别的页面上
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      enqueue(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [enqueue]);

  const remove = async (p: DogPhoto) => {
    await deleteDogPhoto(dogId, p.filename);
    await refetch();
    onChange?.();
  };

  const src = (p: DogPhoto) => dogPhotoUrl(dogId, p.filename, p.token);

  return (
    <div>
      <Upload.Dragger
        multiple
        accept="image/*,video/*"
        showUploadList={false}
        disabled={!!queue}
        style={{ marginBottom: 12, padding: "8px 0" }}
        // antd 每个文件调一次 beforeUpload，但每次都把整批 fileList 给我们——
        // 只在第一个文件上整批入队，不然一批 10 个文件会排出 55 个任务
        beforeUpload={(f, fileList) => {
          if (f === fileList[0]) enqueue(fileList as unknown as File[]);
          return false; // 我们自己传，antd 别再发一次
        }}
      >
        <p style={{ margin: 0, fontSize: 15 }}>
          <b>Ctrl+V 粘贴</b>，或者把文件拖进来，也可以点这里挑
        </p>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          图片和视频可以混在一起一次传多个。图片 jpg/png/webp/bmp 单张 20MB；视频 mp4/mov/webm 单个 500MB
        </Typography.Text>
      </Upload.Dragger>

      {queue && (
        <Space style={{ marginBottom: 8 }} size={8}>
          <Progress
            size="small"
            style={{ width: 160 }}
            percent={queue.total ? Math.round((queue.done / queue.total) * 100) : 0}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            正在传第 {queue.done + 1} / {queue.total} 个：{queue.name}
          </Typography.Text>
        </Space>
      )}

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
