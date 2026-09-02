import { useEffect, useRef, useState } from "react";
import { Radio, Space, Typography } from "antd";
import type { TimeBus } from "@/utils/timeBus";

interface VideoSrc {
  label: string;
  url: string;
}

interface Props {
  videos: VideoSrc[];
  bus: TimeBus;
}

// 三路视频完全对等，没有"主控"概念：任意一路播放/暂停/拖拽进度条/调速，
// 都会同步给另外两路，并联动 IMU 曲线的竖线标记。用 isProgrammatic 防止
// 程序化设置 currentTime/play/pause 时触发的事件又反过来引发同步死循环。
const DRIFT_TOLERANCE_SEC = 0.1;
const SPEED_OPTIONS = [0.25, 0.5, 1, 1.5, 2, 4];

export default function SyncedVideoGroup({ videos, bus }: Props) {
  const refs = useRef<(HTMLVideoElement | null)[]>([]);
  const isProgrammatic = useRef(false);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    const all = () => refs.current.filter((v): v is HTMLVideoElement => v != null);

    const cleanups: (() => void)[] = [];

    all().forEach((self) => {
      const others = () => all().filter((v) => v !== self);

      const syncOthers = (action: "play" | "pause" | "seek") => {
        isProgrammatic.current = true;
        for (const o of others()) {
          if (Math.abs(o.currentTime - self.currentTime) > 0.02) o.currentTime = self.currentTime;
          if (action === "play") o.play().catch(() => {});
          if (action === "pause") o.pause();
        }
        isProgrammatic.current = false;
      };

      const onPlay = () => {
        if (isProgrammatic.current) return;
        syncOthers("play");
      };
      const onPause = () => {
        if (isProgrammatic.current) return;
        syncOthers("pause");
      };
      const onSeeked = () => {
        if (isProgrammatic.current) return;
        syncOthers("seek");
      };
      const onTimeUpdate = () => {
        if (isProgrammatic.current) return;
        bus.reportTime(self.currentTime);
      };
      const onRateChange = () => {
        if (isProgrammatic.current) return;
        isProgrammatic.current = true;
        for (const o of others()) o.playbackRate = self.playbackRate;
        isProgrammatic.current = false;
        setSpeed(self.playbackRate);
      };

      self.addEventListener("play", onPlay);
      self.addEventListener("pause", onPause);
      self.addEventListener("seeked", onSeeked);
      self.addEventListener("timeupdate", onTimeUpdate);
      self.addEventListener("ratechange", onRateChange);

      cleanups.push(() => {
        self.removeEventListener("play", onPlay);
        self.removeEventListener("pause", onPause);
        self.removeEventListener("seeked", onSeeked);
        self.removeEventListener("timeupdate", onTimeUpdate);
        self.removeEventListener("ratechange", onRateChange);
      });
    });

    bus.setSeekHandler((sec) => {
      isProgrammatic.current = true;
      for (const v of all()) v.currentTime = sec;
      isProgrammatic.current = false;
      bus.reportTime(sec);
    });

    // 播放中定期做漂移校正，以第一路为基准
    const driftTimer = setInterval(() => {
      const [lead, ...rest] = all();
      if (!lead || lead.paused || isProgrammatic.current) return;
      isProgrammatic.current = true;
      for (const v of rest) {
        if (Math.abs(v.currentTime - lead.currentTime) > DRIFT_TOLERANCE_SEC) {
          v.currentTime = lead.currentTime;
        }
      }
      isProgrammatic.current = false;
    }, 1000);

    return () => {
      cleanups.forEach((fn) => fn());
      bus.setSeekHandler(null);
      clearInterval(driftTimer);
    };
  }, [videos, bus]);

  const handleSpeedChange = (rate: number) => {
    setSpeed(rate);
    isProgrammatic.current = true;
    for (const v of refs.current) {
      if (v) v.playbackRate = rate;
    }
    isProgrammatic.current = false;
  };

  return (
    <div>
      <Space style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary">播放速度：</Typography.Text>
        <Radio.Group size="small" value={speed} onChange={(e) => handleSpeedChange(e.target.value)}>
          {SPEED_OPTIONS.map((s) => (
            <Radio.Button key={s} value={s}>
              {s}x
            </Radio.Button>
          ))}
        </Radio.Group>
      </Space>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {videos.map((v, i) => (
          <div key={v.label} style={{ flex: "1 1 420px", minWidth: 380 }}>
            <Typography.Text type="secondary">{v.label}</Typography.Text>
            <video
              ref={(el) => {
                refs.current[i] = el;
              }}
              src={v.url}
              controls
              style={{ width: "100%", maxHeight: "45vh", background: "#000" }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
