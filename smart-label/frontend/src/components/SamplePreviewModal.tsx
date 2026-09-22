import { useEffect, useMemo, useState } from "react";
import { Modal, Segmented, Spin, Typography } from "antd";
import { getMediaToken, mediaStreamUrl } from "@/api/media";
import { getSampleMedia, getVisionScanTimeline, type VisionScanTimeline } from "@/api/samples";
import ImuChart from "@/components/ImuChart";
import ImuTable from "@/components/ImuTable";
import SyncedVideoGroup from "@/components/SyncedVideoGroup";
import { TimeBus } from "@/utils/timeBus";

interface Props {
  sampleId: number | null;
  sampleCode?: string;
  onClose: () => void;
  /** 按槽位（cam1/cam2/cam3）给的固定区域（公用机位里各单间的位置），虚线叠在画面上 */
  regionsBySlot?: Record<string, { label: string; x: number; y: number; w: number; h: number }[]>;
}

interface VideoSrc {
  label: string;
  url: string;
  /** 这一路的第 0 秒在样本时间轴上是第几秒（见 SyncedVideoGroup） */
  offsetSec?: number;
  /** 这一路在样本上的槽位（cam1/cam2/cam3），对应扫描结果的 cam */
  cam: string;
}

/** 扫描时间线 → "这一刻有哪些框"。采样点每 every_sec 一个，取离当前时刻最近的那个，
 *  超过半个间隔就算没有（画面已经走到下一个采样点之间了，框位置不可信） */
function overlayOf(tl: VisionScanTimeline | undefined): ((t: number) => number[][] | null) | null {
  if (!tl || !tl.points.length) return null;
  const pts = tl.points;
  const half = (tl.every_sec || 5) / 2 + 0.05;
  return (t: number) => {
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][0] < t) lo = mid + 1;
      else hi = mid;
    }
    const cands = [pts[lo], pts[lo - 1]].filter(Boolean) as VisionScanTimeline["points"];
    const best = cands.sort((a, b) => Math.abs(a[0] - t) - Math.abs(b[0] - t))[0];
    if (!best || Math.abs(best[0] - t) > half) return null;
    return best[2] ?? null;
  };
}

export default function SamplePreviewModal({ sampleId, sampleCode, onClose, regionsBySlot }: Props) {
  const [loading, setLoading] = useState(false);
  const [videos, setVideos] = useState<VideoSrc[]>([]);
  const [hasCsv, setHasCsv] = useState(false);
  const [fps, setFps] = useState<number | null>(null);
  const [timelines, setTimelines] = useState<Record<string, VisionScanTimeline>>({});
  const [imuView, setImuView] = useState<"曲线图" | "表格">("曲线图");
  const bus = useMemo(() => new TimeBus(), [sampleId]);

  useEffect(() => {
    if (sampleId == null) {
      setVideos([]);
      setHasCsv(false);
      setFps(null);
      setTimelines({});
      return;
    }
    setLoading(true);
    setImuView("曲线图");
    (async () => {
      try {
        const media = await getSampleMedia(sampleId);
        const entries: [string, number | null, string][] = [
          ["视角1", media.video1_id, "cam1"],
          ["视角2", media.video2_id, "cam2"],
          ["视角3", media.video3_id, "cam3"],
        ];
        // 扫描时间线（带框）另外拿，拿不到不影响看视频
        getVisionScanTimeline(sampleId).then(setTimelines).catch(() => setTimelines({}));
        // 三路 token 一起要，不用一个等一个
        const vids = (
          await Promise.all(
            entries.map(async ([label, id, cam], i) => {
              if (id == null) return null;
              const { token } = await getMediaToken(id);
              // 跨 session 挂过来的那一路（看全场的 cam7）跟样本差着几秒到几十分钟，
              // 不换算就是放了十几分钟之外的画面，而且看不出来
              const off = (media.video_offsets_ms?.[i] ?? 0) / 1000;
              return {
                label: off ? `${label}（差 ${off.toFixed(1)}s，已对齐）` : label,
                url: mediaStreamUrl(id, token), cam, offsetSec: off,
              } as VideoSrc;
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
        {videos.length > 0 && (
          <SyncedVideoGroup
            videos={videos}
            bus={bus}
            fps={fps}
            overlays={videos.map((v) => overlayOf(timelines[v.cam]))}
            statics={videos.map((v) => regionsBySlot?.[v.cam] ?? timelines[v.cam]?.regions ?? null)}
          />
        )}
        {videos.some((v) => timelines[v.cam]) && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            绿框是画面扫描时检测到的狗（每 {timelines[videos.find((v) => timelines[v.cam])!.cam].every_sec} 秒看一帧，框跟着最近的那一帧走，中间的时刻不画）。
            没框不等于没狗，只是那一帧没检出来；白色虚线是公共区里各单间的位置。
            {videos.filter((v) => timelines[v.cam] && !timelines[v.cam].points.length).map((v) => ` ${v.label} 还没扫过。`).join("")}
          </Typography.Text>
        )}
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
