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
  // 每路画面的宽高比，用来按比例分配每列宽度（宽高比大的分到更宽的列），
  // 这样每路都能等高、完整显示（不裁不留黑边），比直接三等分更能利用屏幕——
  // 摄像头本来就不是同一个画幅，三等分要么裁掉画面要么留黑边。
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
          ? // flex: 1 with minHeight: 0 让这个div占满剩余高度；display:flex + flexDirection:column
            // 使内部子元素按竖向排列（播放速度控制条 + 视频组）
            { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }
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
            ? // 每列宽度按该路画面的宽高比分配（flexGrow: aspect），而不是死板三等分：
              // 这样每路都等高、宽度正好占满整行，完整显示画面，不裁不留黑边。
              // alignItems:center + overflow:hidden 只是兜底：极端宽高比时按算出来的高度
              // 会超出可用空间，裁掉的是上下均匀的一圈，而不是把内容顶到看不见。
              { display: "flex", gap: 0, flex: 1, minHeight: 0, overflow: "hidden", alignItems: "center" }
            : { display: "flex", gap: 12, flexWrap: "wrap" }
        }
      >
        {videos.map((v, i) => (
          <div
            key={v.label}
            style={
              fill
                ? {
                    flexGrow: aspects[i] ?? 1,
                    flexShrink: 1,
                    flexBasis: 0,
                    minWidth: 0,
                    display: "flex",
                    position: "relative",
                  }
                : { flex: "1 1 420px", minWidth: 380 }
            }
          >
            {!fill && <Typography.Text type="secondary">{v.label}</Typography.Text>}
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
                        // width:100% + aspectRatio 算出高度：三路按各自比例分到的宽度不同，
                        // 但算出来的高度相同，画面完整显示。maxHeight+objectFit:contain 只是
                        // 兜底，避免极端比例时被 maxHeight 削到变形。
                        width: "100%",
                        height: "auto",
                        aspectRatio: aspects[i],
                        maxHeight: "100%",
                        objectFit: "contain",
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
