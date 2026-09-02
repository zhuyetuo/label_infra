import { useEffect, useRef } from "react";
import { Typography } from "antd";

interface VideoSrc {
  label: string;
  url: string;
}

interface Props {
  videos: VideoSrc[];
}

// 第一路视频是主控（master），播放/暂停/跳转都以它为准同步给其余视频；
// 播放过程中每隔一段时间做一次漂移校正（跟架构里定的100ms容忍误差一致），
// 避免几路视频各自解码进度慢慢跑偏。
const DRIFT_TOLERANCE_SEC = 0.1;

export default function SyncedVideoGroup({ videos }: Props) {
  const refs = useRef<(HTMLVideoElement | null)[]>([]);
  const isProgrammatic = useRef(false);

  useEffect(() => {
    const master = refs.current[0];
    const followers = refs.current.slice(1).filter((v): v is HTMLVideoElement => v != null);
    if (!master || followers.length === 0) return;

    const syncFollowers = (action: "play" | "pause" | "seek") => {
      isProgrammatic.current = true;
      for (const f of followers) {
        if (Math.abs(f.currentTime - master.currentTime) > 0.02) f.currentTime = master.currentTime;
        if (action === "play") f.play().catch(() => {});
        if (action === "pause") f.pause();
      }
      isProgrammatic.current = false;
    };

    const onPlay = () => syncFollowers("play");
    const onPause = () => syncFollowers("pause");
    const onSeeked = () => syncFollowers("seek");

    master.addEventListener("play", onPlay);
    master.addEventListener("pause", onPause);
    master.addEventListener("seeked", onSeeked);

    // 播放中定期做漂移校正
    const driftTimer = setInterval(() => {
      if (master.paused || isProgrammatic.current) return;
      for (const f of followers) {
        if (Math.abs(f.currentTime - master.currentTime) > DRIFT_TOLERANCE_SEC) {
          f.currentTime = master.currentTime;
        }
      }
    }, 1000);

    return () => {
      master.removeEventListener("play", onPlay);
      master.removeEventListener("pause", onPause);
      master.removeEventListener("seeked", onSeeked);
      clearInterval(driftTimer);
    };
  }, [videos]);

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {videos.map((v, i) => (
        <div key={v.label} style={{ flex: "1 1 280px", minWidth: 260 }}>
          <Typography.Text type="secondary">
            {v.label}
            {i === 0 && "（主控）"}
          </Typography.Text>
          <video
            ref={(el) => {
              refs.current[i] = el;
            }}
            src={v.url}
            controls={i === 0}
            muted={i !== 0}
            style={{ width: "100%", background: "#000" }}
          />
        </div>
      ))}
    </div>
  );
}
