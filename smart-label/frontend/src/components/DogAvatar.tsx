import { useState } from "react";
import { Modal, Tooltip } from "antd";
import { useQuery } from "@tanstack/react-query";
import { dogPhotoUrl, listDogPhotos } from "@/api/dogs";
import DogPhotos from "@/components/DogPhotos";

/**
 * 狗档案头像：圆形小图，点开弹窗看这只狗的全部照片/视频。
 * 挂在工作台标题、机位核对这些地方——画面里几只狗长得像，光看名字分不清，
 * 对着档案照片才能确认画面里这只是不是标签写的那只（IMU 挂错、机位错乱都靠它核）。
 * dog_id 拿不到就不渲染，狗档案里没照片时显示占位，点了也能进弹窗看（空就空）。
 */
export default function DogAvatar({ dogId, name, size = 36 }: {
  dogId: number | null | undefined;
  name?: string | null;
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["dog-photos", dogId],
    queryFn: () => listDogPhotos(dogId!),
    enabled: dogId != null,
    // 认狗用的图不会变，切任务时别反复去 NAS 列目录
    staleTime: 5 * 60_000,
  });
  const photo = (data ?? []).find((p) => p.kind === "image");
  if (dogId == null) return null;

  return (
    <>
      <Tooltip
        title={photo
          ? `${name ?? "这只狗"}的档案照片，点开看大图`
          : `${name ?? "这只狗"}：狗档案里还没有照片`}
      >
        <div
          onClick={() => setOpen(true)}
          style={{
            width: size, height: size, flex: `0 0 ${size}px`,
            borderRadius: "50%", overflow: "hidden",
            background: "var(--sl-fill2, #eee)", border: "1px solid #d9d9d9",
            cursor: "pointer", display: "grid", placeItems: "center",
          }}
        >
          {photo ? (
            <img
              src={dogPhotoUrl(dogId, photo.filename, photo.token)}
              alt={name ?? ""}
              loading="lazy"
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <span style={{ fontSize: Math.round(size / 2.2) }}>🐕</span>
          )}
        </div>
      </Tooltip>
      <Modal
        open={open}
        title={name ? `${name} 的档案照片` : "狗档案照片"}
        footer={null}
        width={880}
        destroyOnClose
        onCancel={() => setOpen(false)}
      >
        {open && <DogPhotos dogId={dogId} readOnly />}
      </Modal>
    </>
  );
}
