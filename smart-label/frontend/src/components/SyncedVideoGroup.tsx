import { useEffect, useRef, useState } from "react";
import { InputNumber, Radio, Space, Typography } from "antd";
import type { TimeBus } from "@/utils/timeBus";

interface VideoSrc {
  label: string;
  url: string;
}

interface Props {
  videos: VideoSrc[];
  bus: TimeBus;
  fps?: number | null;
}

// 三路视频完全对等，没有"主控"概念：任意一路播放/暂停/拖拽进度条/调速，
// 都会同步给另外两路，并联动 IMU 曲线的竖线标记。用 isProgrammatic 防止
// 程序化设置 currentTime/play/pause 时触发的事件又反过来引发同步死循环。
const DRIFT_TOLERANCE_SEC = 0.1;
const SPEED_OPTIONS = [0.25, 0.5, 1, 1.5, 2, 4];
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

interface ZoomState {
  scale: number;
  tx: number;
  ty: number;
}

export default function SyncedVideoGroup({ videos, bus, fps }: Props) {
  const refs = useRef<(HTMLVideoElement | null)[]>([]);
  const wrapperRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isProgrammatic = useRef(false);
  const [speed, setSpeed] = useState(1);
  const [frame, setFrame] = useState(0);

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

  // 帧数显示做节流：播放时 bus 上报很频繁，这里每250ms才更新一次输入框，
  // 避免每帧都触发 React 重渲染反而造成新的卡顿。
  useEffect(() => {
    if (!fps) return;
    let lastUpdate = 0;
    const unsubscribe = bus.onTime((sec) => {
      const now = performance.now();
      if (now - lastUpdate < 250) return;
      lastUpdate = now;
      setFrame(Math.round(sec * fps));
    });
    return unsubscribe;
  }, [bus, fps]);

  // 画面缩放/平移：按住shift+滚轮缩放，按住shift+左键拖拽平移；双击复原。
  // 直接操作DOM的transform，不进React状态，避免拖拽过程中的频繁重渲染。
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    wrapperRefs.current.forEach((wrapper, i) => {
      const video = refs.current[i];
      if (!wrapper || !video) return;

      const state: ZoomState = { scale: 1, tx: 0, ty: 0 };
      const apply = () => {
        video.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
      };

      let dragging = false;
      let lastX = 0;
      let lastY = 0;

      const onWheel = (e: WheelEvent) => {
        if (!e.shiftKey) return;
        e.preventDefault();
        const prevScale = state.scale;
        const next = e.deltaY < 0 ? prevScale * 1.15 : prevScale / 1.15;
        state.scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
        if (state.scale === ZOOM_MIN) {
          state.tx = 0;
          state.ty = 0;
        }
        apply();
      };

      const onMouseDown = (e: MouseEvent) => {
        if (!e.shiftKey || e.button !== 0 || state.scale <= ZOOM_MIN) return;
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        e.preventDefault();
      };
      const onMouseMove = (e: MouseEvent) => {
        if (!dragging) return;
        state.tx += e.clientX - lastX;
        state.ty += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        apply();
      };
      const onMouseUp = () => {
        dragging = false;
      };
      const onDblClick = (e: MouseEvent) => {
        if (!e.shiftKey && state.scale === ZOOM_MIN) return;
        state.scale = 1;
        state.tx = 0;
        state.ty = 0;
        apply();
      };

      wrapper.addEventListener("wheel", onWheel, { passive: false });
      wrapper.addEventListener("mousedown", onMouseDown);
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      wrapper.addEventListener("dblclick", onDblClick);

      cleanups.push(() => {
        wrapper.removeEventListener("wheel", onWheel);
        wrapper.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        wrapper.removeEventListener("dblclick", onDblClick);
        video.style.transform = "";
      });
    });
    return () => cleanups.forEach((fn) => fn());
  }, [videos]);

  const handleSpeedChange = (rate: number) => {
    setSpeed(rate);
    isProgrammatic.current = true;
    for (const v of refs.current) {
      if (v) v.playbackRate = rate;
    }
    isProgrammatic.current = false;
  };

  const handleFrameJump = (value: number | null) => {
    if (value == null || !fps) return;
    setFrame(value);
    bus.seek(value / fps);
  };

  return (
    <div>
      <Space style={{ marginBottom: 8 }} wrap>
        <Typography.Text type="secondary">播放速度：</Typography.Text>
        <Radio.Group size="small" value={speed} onChange={(e) => handleSpeedChange(e.target.value)}>
          {SPEED_OPTIONS.map((s) => (
            <Radio.Button key={s} value={s}>
              {s}x
            </Radio.Button>
          ))}
        </Radio.Group>
        {!!fps && (
          <>
            <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
              帧：
            </Typography.Text>
            <InputNumber size="small" min={0} value={frame} onChange={handleFrameJump} />
            <Typography.Text type="secondary">（{fps} fps，画面内 Shift+滚轮缩放 / Shift+拖拽平移）</Typography.Text>
          </>
        )}
      </Space>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {videos.map((v, i) => (
          <div key={v.label} style={{ flex: "1 1 420px", minWidth: 380 }}>
            <Typography.Text type="secondary">{v.label}</Typography.Text>
            <div
              ref={(el) => {
                wrapperRefs.current[i] = el;
              }}
              style={{ overflow: "hidden", maxHeight: "45vh", background: "#000" }}
            >
              <video
                ref={(el) => {
                  refs.current[i] = el;
                }}
                src={v.url}
                controls
                style={{ width: "100%", maxHeight: "45vh", display: "block", transformOrigin: "center" }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
