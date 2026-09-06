import { useEffect, useMemo, useState } from "react";
import { Modal, Segmented, Spin, Typography } from "antd";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { getSampleMedia } from "@/api/samples";
import ImuChart from "@/components/ImuChart";
import ImuTable from "@/components/ImuTable";
import SyncedVideoGroup from "@/components/SyncedVideoGroup";
import { TimeBus } from "@/utils/timeBus";

interface Props {
  sampleId: number | null;
  sampleCode?: string;
  onClose: () => void;
}

interface VideoSrc {
  label: string;
  url: string;
}

export default function SamplePreviewModal({ sampleId, sampleCode, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [videos, setVideos] = useState<VideoSrc[]>([]);
  const [hasCsv, setHasCsv] = useState(false);
  const [fps, setFps] = useState<number | null>(null);
  const [imuView, setImuView] = useState<"曲线图" | "表格">("曲线图");
  const bus = useMemo(() => new TimeBus(), [sampleId]);

  useEffect(() => {
    if (sampleId == null) {
      setVideos([]);
      setHasCsv(false);
      setFps(null);
      return;
    }
    setLoading(true);
    setImuView("曲线图");
    (async () => {
      try {
        const media = await getSampleMedia(sampleId);
        const entries: [string, number | null][] = [
          ["视角1", media.video1_id],
          ["视角2", media.video2_id],
          ["视角3", media.video3_id],
        ];
        // 三路 token 一起要，不用一个等一个
        const vids = (
          await Promise.all(
            entries.map(async ([label, id]) => {
              if (id == null) return null;
              const { token } = await getMediaToken(id);
              return { label, url: mediaStreamUrl(id, token) } as VideoSrc;
            })
          )
        ).filter((v): v is VideoSrc => v != null);
        setVideos(vids);
        setHasCsv(media.csv_id != null);
        setFps(media.video_fps);
      } finally {
        // 任何一步失败（超时/403）也要把转圈收掉，不然弹窗一直卡在 loading
        setLoading(false);
      }
    })();
  }, [sampleId]);

  return (
    <Modal
      title={`预览 - ${sampleCode ?? ""}`}
      open={sampleId != null}
      onCancel={onClose}
      footer={null}
      width="95vw"
      style={{ top: 16 }}
      destroyOnClose
    >
      <Spin spinning={loading}>
        {videos.length > 0 && <SyncedVideoGroup videos={videos} bus={bus} fps={fps} />}
        {!loading && videos.length === 0 && (
          <Typography.Text type="secondary">没有找到可播放的视频（可能未走标准导入流程）</Typography.Text>
        )}

        <div style={{ marginTop: 16 }}>
          {hasCsv && sampleId != null ? (
            <>
              <Segmented
                options={["曲线图", "表格"]}
                value={imuView}
                onChange={(v) => setImuView(v as "曲线图" | "表格")}
                style={{ marginBottom: 8 }}
              />
              {imuView === "曲线图" ? (
                <ImuChart sampleId={sampleId} bus={bus} />
              ) : (
                <ImuTable sampleId={sampleId} />
              )}
            </>
          ) : (
            !loading && <Typography.Text type="secondary">没有找到 IMU CSV</Typography.Text>
          )}
        </div>
      </Spin>
    </Modal>
  );
}
