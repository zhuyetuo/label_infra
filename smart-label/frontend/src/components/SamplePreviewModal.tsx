import { useEffect, useState } from "react";
import { Modal, Segmented, Spin, Typography } from "antd";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { getSampleMedia } from "@/api/samples";
import ImuChart from "@/components/ImuChart";
import ImuTable from "@/components/ImuTable";
import SyncedVideoGroup from "@/components/SyncedVideoGroup";

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
  const [imuView, setImuView] = useState<"曲线图" | "表格">("曲线图");

  useEffect(() => {
    if (sampleId == null) {
      setVideos([]);
      setHasCsv(false);
      return;
    }
    setLoading(true);
    setImuView("曲线图");
    (async () => {
      const media = await getSampleMedia(sampleId);
      const entries: [string, number | null][] = [
        ["视角1", media.video1_id],
        ["视角2", media.video2_id],
        ["视角3", media.video3_id],
      ];
      const vids: VideoSrc[] = [];
      for (const [label, id] of entries) {
        if (id == null) continue;
        const { token } = await getMediaToken(id);
        vids.push({ label, url: mediaStreamUrl(id, token) });
      }
      setVideos(vids);
      setHasCsv(media.csv_id != null);
      setLoading(false);
    })();
  }, [sampleId]);

  return (
    <Modal
      title={`预览 - ${sampleCode ?? ""}`}
      open={sampleId != null}
      onCancel={onClose}
      footer={null}
      width={960}
      destroyOnClose
    >
      <Spin spinning={loading}>
        {videos.length > 0 && <SyncedVideoGroup videos={videos} />}
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
              {imuView === "曲线图" ? <ImuChart sampleId={sampleId} /> : <ImuTable sampleId={sampleId} />}
            </>
          ) : (
            !loading && <Typography.Text type="secondary">没有找到 IMU CSV</Typography.Text>
          )}
        </div>
      </Spin>
    </Modal>
  );
}
