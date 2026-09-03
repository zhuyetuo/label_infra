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
  /** 撑满可用高度（标注工作台全屏时用），默认按 45vh 封顶（预览弹窗用） */
  fill?: boolean;
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

export default function SyncedVideoGroup({ videos, bus, fps, fill }: Props) {
  const refs = useRef<(HTMLVideoElement | null)[]>([]);
  const wrapperRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isProgrammatic = useRef(false);
  const [speed, setSpeed] = useState(1);
  const [frame, setFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState<number | null>(null);
  // 每路画面的宽高比，元数据加载后才知道。用它给容器定死比例，
  // 画面就能等比缩放到刚好填满位置，既不会留黑边也不会被裁切。
  const [aspects, setAspects] = useState<Record<number, number>>({});

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

    // 拖播放头时会以鼠标移动的频率不停发 seek 请求，如果每来一次就直接写
    // currentTime，浏览器的解码请求会排队堆积，画面反而更新得又慢又顿。
    // 这里改成"合并最新目标"：上一次 seek 还没完成就先把目标存起来，
    // 等 seeked 回来立刻跳到最新目标，尽可能快地刷出每一帧。
    let pendingSeek: number | null = null;

    const applyPendingSeek = () => {
      if (pendingSeek == null) return;
      const vids = all();
      const lead = vids[0];
      if (!lead || lead.seeking) return;
      const target = pendingSeek;
      pendingSeek = null;
      isProgrammatic.current = true;
      for (const v of vids) v.currentTime = target;
      isProgrammatic.current = false;
      bus.reportTime(target);
    };

    bus.setSeekHandler((sec) => {
      pendingSeek = sec;
      applyPendingSeek();
    });

    const lead = all()[0];
    const onLeadSeeked = () => applyPendingSeek();
    lead?.addEventListener("seeked", onLeadSeeked);
    cleanups.push(() => lead?.removeEventListener("seeked", onLeadSeeked));

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
    let trailing: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = bus.onTime((sec) => {
      const now = performance.now();
      if (now - lastUpdate < 250) {
        // 节流会把中间的值丢掉，补一个"最后一次"的延迟更新，
        // 否则停下来之后帧号会停在上一次节流的旧值上，对不上画面
        if (trailing) clearTimeout(trailing);
        trailing = setTimeout(() => setFrame(Math.round(sec * fps)), 260);
        return;
      }
      lastUpdate = now;
      setFrame(Math.round(sec * fps));
    });
    return () => {
      unsubscribe();
      if (trailing) clearTimeout(trailing);
    };
  }, [bus, fps]);

  useEffect(() => {
    const cleanups: (() => void)[] = [];
    refs.current.forEach((video, i) => {
      if (!video) return;
      const update = () => {
        if (video.videoWidth && video.videoHeight) {
          setAspects((prev) =>
            prev[i] === video.videoWidth / video.videoHeight
              ? prev
              : { ...prev, [i]: video.videoWidth / video.videoHeight }
          );
        }
      };
      update();
      video.addEventListener("loadedmetadata", update);
      cleanups.push(() => video.removeEventListener("loadedmetadata", update));
    });
    return () => cleanups.forEach((fn) => fn());
  }, [videos]);

  // 总帧数从视频元数据的 duration 算出来（duration*fps 四舍五入），不是瞎写的
  useEffect(() => {
    if (!fps) {
      setTotalFrames(null);
      return;
    }
    const video = refs.current[0];
    if (!video) return;
    const update = () => {
      if (video.duration && Number.isFinite(video.duration)) {
        setTotalFrames(Math.round(video.duration * fps));
      }
    };
    update();
    video.addEventListener("loadedmetadata", update);
    return () => video.removeEventListener("loadedmetadata", update);
  }, [videos, fps]);

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
    <div
      className={fill ? "ws-videos" : undefined}
      style={
        fill
          ? // overflow:hidden 是关键：画面按宽度定高，遇到偏竖屏的素材算出来的高度
            // 可能超过这块区域实际分到的空间。不裁掉的话，超出的部分不会把下面的
            // 标签按钮推下去，而是直接盖在它们上面（就是"挤在一起"那个问题）。
            { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }
          : undefined
      }
    >
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
            <InputNumber
              size="small"
              min={0}
              max={totalFrames ?? undefined}
              value={frame}
              onChange={handleFrameJump}
            />
            <Typography.Text type="secondary">
              of {totalFrames ?? "..."}（{fps} fps，画面内 Shift+滚轮缩放 / Shift+拖拽平移）
            </Typography.Text>
          </>
        )}
      </Space>
      <div
        className={fill ? "ws-videos-row" : undefined}
        style={
          fill
            ? // 三路画面无缝挨在一起：不留间距，每路正好占三分之一宽度。
              // 高度由宽高比推出来，不去拉伸容器——一旦用高度反过来限制宽度，
              // 画面就会缩得比三分之一窄，中间露出白缝。
              // alignItems:center 是为了配合外层的 overflow:hidden：万一算出来的
              // 高度超出可用空间，裁掉的是上下均匀的一圈，而不是整段被顶到看不见。
              { display: "flex", gap: 0, flex: "0 0 auto", alignItems: "center", margin: "auto 0" }
            : { display: "flex", gap: 12, flexWrap: "wrap" }
        }
      >
        {videos.map((v, i) => (
          <div
            key={v.label}
            style={
              fill
                ? { flex: "1 1 0", minWidth: 0, display: "flex", position: "relative" }
                : { flex: "1 1 420px", minWidth: 380 }
            }
          >
            {fill ? (
              <span
                style={{
                  position: "absolute",
                  top: 2,
                  left: 4,
                  zIndex: 2,
                  fontSize: 12,
                  color: "#fff",
                  textShadow: "0 0 3px rgba(0,0,0,0.9)",
                  pointerEvents: "none",
                }}
              >
                {v.label}
              </span>
            ) : (
              <Typography.Text type="secondary">{v.label}</Typography.Text>
            )}
            <div
              ref={(el) => {
                wrapperRefs.current[i] = el;
              }}
              style={
                fill
                  ? { flex: 1, minWidth: 0, display: "flex" }
                  : { overflow: "hidden", maxHeight: "45vh", background: "#000" }
              }
            >
              <video
                ref={(el) => {
                  refs.current[i] = el;
                }}
                src={v.url}
                controls
                style={
                  fill
                    ? {
                        // 定死宽高比 + 宽度占满：元素大小始终等于画面大小，
                        // 既没有黑边，也不会比三分之一窄
                        aspectRatio: aspects[i],
                        width: "100%",
                        height: "auto",
                        display: "block",
                        transformOrigin: "center",
                      }
                    : { width: "100%", maxHeight: "45vh", display: "block", transformOrigin: "center" }
                }
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
