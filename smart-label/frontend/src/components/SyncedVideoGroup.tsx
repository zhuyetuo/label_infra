import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { InputNumber, Radio, Slider, Space, Typography } from "antd";
import type { TimeBus } from "@/utils/timeBus";
import { getSavedHeight, saveHeight } from "@/utils/persistedSize";

const VIDEO_HEIGHT_KEY = "smart-label:video-area-height";

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
  /** 传入后，播放速度/帧号那行控件改成 portal 到这个节点里（跟弹窗标题拼一行），不再占视频上方的位置 */
  controlsPortalTarget?: HTMLElement | null;
  /**
   * 视频区宽度被外部 CSS 收窄时用（比如波形展开全部时），让视频区按算出来的
   * 高度收缩，而不是占满整个可用高度——不然算出来的画面明明变矮了，
   * 外层容器却还占着原来一整份 flex:1 的高度，中间露一大块空白。
   */
  shrinkToFit?: boolean;
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

export default function SyncedVideoGroup({ videos, bus, fps, fill, controlsPortalTarget, shrinkToFit }: Props) {
  const refs = useRef<(HTMLVideoElement | null)[]>([]);
  const wrapperRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const isProgrammatic = useRef(false);
  const [speed, setSpeed] = useState(1);
  const [frame, setFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState<number | null>(null);
  // 每路画面的宽高比，用来按比例分配每列宽度（宽高比大的分到更宽的列），
  // 这样每路都能等高、完整显示（不裁不留黑边），比直接三等分更能利用屏幕——
  // 摄像头本来就不是同一个画幅，三等分要么裁掉画面要么留黑边。
  const [aspects, setAspects] = useState<Record<number, number>>({});
  // 整行容器的实际像素尺寸，用来精确算出每路视频的像素宽高（而不是靠 flex/百分比
  // 隐式推导）——CSS 那套在高度不确定的祖先链上会算不出正确的 max-height，
  // 直接量像素、按算好的宽高铺，才能保证画面绝对完整，一点都不裁。
  const [rowSize, setRowSize] = useState({ w: 0, h: 0 });
  // 三路视频是一个整体区域，手动拖高度就在这块区域里调整，三路视频跟着自适应
  // （靠上面 rowSize 的 ResizeObserver 自动重算宽高，不用额外写联动逻辑）。
  // null = 沿用默认的自动铺满高度，拖过一次之后才切换成固定高度。拖过的高度记
  // 到 localStorage，下次打开别的任务还是这个高度，不用每次重新拖。
  const [customHeight, setCustomHeightState] = useState<number | null>(() => (fill ? getSavedHeight(VIDEO_HEIGHT_KEY) : null));
  const setCustomHeight = (h: number | null) => {
    setCustomHeightState(h);
    if (fill) saveHeight(VIDEO_HEIGHT_KEY, h);
  };

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const update = () => setRowSize({ w: row.clientWidth, h: row.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(row);
    return () => ro.disconnect();
  }, [fill]);

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

    // 播放中定期做漂移校正，以第一路为基准。容差要跟着倍速放大：容差是"视频时间"，
    // 但三路解码器之间的天然抖动是按"真实时间"发生的——倍速越高，同样一段真实时间
    // 里视频时间流逝得越快，天然抖动换算成视频时间也跟着放大，用固定容差会导致
    // 高倍速时几乎每秒都触发一次强制 seek（这本身就是很明显的卡顿），而不是真的
    // 不同步了。按倍速放大容差，只在真正能感知到的不同步时才纠偏。
    const driftTimer = setInterval(() => {
      const [lead, ...rest] = all();
      if (!lead || lead.paused || isProgrammatic.current) return;
      const tolerance = DRIFT_TOLERANCE_SEC * Math.max(1, lead.playbackRate);
      isProgrammatic.current = true;
      for (const v of rest) {
        if (Math.abs(v.currentTime - lead.currentTime) > tolerance) {
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
    const wasPlaying = refs.current.some((v) => v && !v.paused);
    for (const v of refs.current) {
      if (v) v.playbackRate = rate;
    }
    // 播放中途改速率，Chrome 的音画同步管线经常从这一刻开始卡顿，得暂停再播放
    // 才能重新同步——用户手动暂停/播放能验证不卡，这里就直接把这个动作自动做一遍。
    if (wasPlaying) {
      for (const v of refs.current) v?.pause();
      for (const v of refs.current) v?.play().catch(() => {});
    }
    isProgrammatic.current = false;
  };

  // 拖拽区域底边的把手改高度；双击把手恢复自动铺满。拖的过程只更新状态（不落盘，
  // 不然每次 mousemove 都写 localStorage 太浪费），松手那一刻才存下来。
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = rowRef.current?.getBoundingClientRect().height ?? 0;
    const maxHeight = Math.max(240, window.innerHeight - 260);
    let latest = startHeight;
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(maxHeight, Math.max(160, startHeight + (ev.clientY - startY)));
      setCustomHeightState(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (fill) saveHeight(VIDEO_HEIGHT_KEY, latest);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleFrameJump = (value: number | null) => {
    if (value == null || !fps) return;
    setFrame(value);
    bus.seek(value / fps);
  };

  // 按行容器的实际像素宽度 + 各路宽高比，算出一个所有列共用的高度。
  // shrinkToFit（比如波形展开全部、外部把宽度收窄了）时只按宽度推算高度，
  // 让视频区跟着变矮，把空出来的高度让给别的区域；否则再跟可用高度取较小值兜底，
  // 保证不会超出容器——不会裁，最多某一侧留一点空隙。
  const sumAspect = videos.reduce((sum, _v, i) => sum + (aspects[i] ?? 16 / 9), 0) || 1;
  const rowHeight =
    rowSize.w <= 0
      ? 0
      : shrinkToFit
        ? rowSize.w / sumAspect
        : rowSize.h > 0
          ? Math.min(rowSize.h, rowSize.w / sumAspect)
          : 0;

  const speedControls = (
    <Space wrap>
      <Typography.Text type="secondary">播放速度：</Typography.Text>
      <Radio.Group size="small" value={speed} onChange={(e) => handleSpeedChange(e.target.value)}>
        {SPEED_OPTIONS.map((s) => (
          <Radio.Button key={s} value={s}>
            {s}x
          </Radio.Button>
        ))}
      </Radio.Group>
      {/* 上面几档是常用速度，拖动条+输入框用来微调到中间值（比如 0.75x、1.2x），
          按钮点不出来的精细速度用这个，两者数值实时联动 */}
      <Slider
        min={0.25}
        max={10}
        step={0.05}
        value={speed}
        onChange={handleSpeedChange}
        style={{ width: 140 }}
        tooltip={{ formatter: (v) => `${v}x` }}
      />
      <InputNumber
        size="small"
        min={0.25}
        max={10}
        step={0.05}
        precision={2}
        value={speed}
        addonAfter="x"
        style={{ width: 100 }}
        onChange={(v) => v != null && handleSpeedChange(v)}
      />
      {!!fps && (
        <>
          <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
            帧：
          </Typography.Text>
          <InputNumber size="small" min={0} max={totalFrames ?? undefined} value={frame} onChange={handleFrameJump} />
          <Typography.Text type="secondary">
            of {totalFrames ?? "..."}（{fps} fps，画面内 Shift+滚轮缩放 / Shift+拖拽平移）
          </Typography.Text>
        </>
      )}
    </Space>
  );

  return (
    <div
      className={fill ? "ws-videos" : undefined}
      style={
        fill
          ? // flex: 1 with minHeight: 0 让这个div占满剩余高度；display:flex + flexDirection:column
            // 使内部子元素按竖向排列（播放速度控制条 + 视频组）。shrinkToFit 或拖过高度
            // 之后改成 flex:"0 0 auto"——按内容（算出来的画面高度）撑开，不抢占整份可用
            // 高度，省下来的空间让给挤在旁边的波形图（或者干脆就是用户想要的高度）。
            {
              display: "flex",
              flexDirection: "column",
              flex: shrinkToFit || customHeight != null ? "0 0 auto" : 1,
              minHeight: 0,
            }
          : undefined
      }
    >
      {controlsPortalTarget ? createPortal(speedControls, controlsPortalTarget) : (
        <div style={{ marginBottom: 8 }}>{speedControls}</div>
      )}
      <div
        ref={rowRef}
        className={fill ? "ws-videos-row" : undefined}
        style={
          fill
            ? // justifyContent:center 把整排在水平方向居中：算出来的总宽度可能比容器窄
              // （高度先顶到头的情况），留出来的空隙左右对半分，不会挤到一边。
              // 拖过把手之后 customHeight 生效，三路视频靠 rowSize 的 ResizeObserver
              // 自动重新算宽高，不用额外写联动逻辑。
              {
                display: "flex",
                gap: 0,
                flex: customHeight != null ? "0 0 auto" : shrinkToFit ? "0 0 auto" : 1,
                height: customHeight ?? undefined,
                minHeight: 0,
                justifyContent: "center",
                alignItems: "center",
              }
            : { display: "flex", gap: 12, flexWrap: "wrap" }
        }
      >
        {videos.map((v, i) => {
          // 用行容器的实际像素尺寸 + 这一路的宽高比算出精确像素宽高，不靠 CSS 百分比/
          // flex 在不确定高度的祖先链上瞎推导——量出来多少就是多少，画面绝对不会被裁掉，
          // rowHeight 算出来之前（还没测量到尺寸）先用 flex 等分兜底，避免出现 0x0。
          const aspect = aspects[i] ?? 16 / 9;
          const pixelSize = rowHeight > 0 ? { width: rowHeight * aspect, height: rowHeight } : null;
          return (
            <div
              key={v.label}
              style={
                fill
                  ? pixelSize
                    ? { width: pixelSize.width, height: pixelSize.height, flex: "0 0 auto", display: "flex", position: "relative" }
                    : { flex: "1 1 0", minWidth: 0, display: "flex", position: "relative" }
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
                    // preservesPitch 默认开着会让浏览器在变速时对音频做变调处理，
                    // 这个处理本身就是常见的"改速率后卡顿，暂停重播才顺畅"的元凶之一
                    if (el) el.preservesPitch = false;
                  }}
                  src={v.url}
                  controls
                  preload="auto"
                  style={
                    fill
                      ? { width: "100%", height: "100%", display: "block", transformOrigin: "center" }
                      : { width: "100%", maxHeight: "45vh", display: "block", transformOrigin: "center" }
                  }
                />
              </div>
            </div>
          );
        })}
      </div>
      {fill && (
        // 三路视频是一整块区域，拖这个把手改这块区域的高度，视频跟着自适应铺满；
        // 双击恢复自动铺满可用高度
        <div
          onMouseDown={handleResizeStart}
          onDoubleClick={() => setCustomHeight(null)}
          title="拖拽调整视频区域高度，双击恢复自动"
          style={{
            flex: "0 0 auto",
            height: 8,
            margin: "2px 0",
            cursor: "row-resize",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ width: 40, height: 3, borderRadius: 2, background: "#d9d9d9" }} />
        </div>
      )}
    </div>
  );
}
