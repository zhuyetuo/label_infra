import { useEffect, useState } from "react";
import { Modal, Spin, Typography } from "antd";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { getSampleMedia } from "@/api/samples";
import ImuChart from "@/components/ImuChart";

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

  useEffect(() => {
    if (sampleId == null) {
      setVideos([]);
      setHasCsv(false);
      return;
    }
    setLoading(true);
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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {videos.map((v) => (
            <div key={v.label} style={{ flex: "1 1 280px", minWidth: 260 }}>
              <Typography.Text type="secondary">{v.label}</Typography.Text>
              <video src={v.url} controls style={{ width: "100%", background: "#000" }} />
            </div>
          ))}
        </div>
        {!loading && videos.length === 0 && (
          <Typography.Text type="secondary">没有找到可播放的视频（可能未走标准导入流程）</Typography.Text>
        )}

        <div style={{ marginTop: 16 }}>
          {hasCsv && sampleId != null ? (
            <ImuChart sampleId={sampleId} />
          ) : (
            !loading && <Typography.Text type="secondary">没有找到 IMU CSV</Typography.Text>
          )}
        </div>
      </Spin>
    </Modal>
  );
}
