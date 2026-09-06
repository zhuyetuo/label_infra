import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, InputNumber, Radio, Slider, Space, Typography } from "antd";
import { PauseCircleOutlined, PlayCircleOutlined } from "@ant-design/icons";
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
// 都会同步给另外两路，并联动 IMU 曲线的竖线标记。
//
// 防"同步死循环"用的是一个时间窗口而不是布尔开关：程序化 seek/play/pause 之后，
// 浏览器的 seeked/play/pause 事件是异步补发的，等事件到的时候同步布尔早已经
// 复位，三路各自把对方的程序化动作当成"用户操作"再同步回去，一次跳转会引发
// 好几轮互相 seek——每次 seek 都要重新解码一小段，表现就是跳转/循环之后
// 三路视频播一下停一下来回抖。改成"程序化动作之后 SUPPRESS_MS 内到的事件
// 一律当作程序化的"就没有这个问题。
const DRIFT_TOLERANCE_SEC = 0.1;
// 漂移超过这个值才硬 seek；以内用临时微调倍速追上去，画面不会顿
const DRIFT_HARD_SEEK_SEC = 0.6;
const SUPPRESS_MS = 400;
const SPEED_OPTIONS = [0.25, 0.5, 1, 1.5, 2, 4];
// 实测三路 720p 同播在 10x 时丢帧率 ~24%（getVideoPlaybackQuality 量出来的），
// 是浏览器解码吞吐跟不上，不是代码问题，前端修不了。先把上限收到解码顶得住的
// 范围，比瞎放开到卡顿强。
const MAX_SPEED = 5;
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
  // 程序化操作的抑制截止时间（performance.now()），见文件顶部说明
  const suppressUntil = useRef(0);
  const markProgrammatic = (ms = SUPPRESS_MS) => {
    suppressUntil.current = Math.max(suppressUntil.current, performance.now() + ms);
  };
  const isSuppressed = () => performance.now() < suppressUntil.current;
  // 播放/暂停的同步不用时间窗口，改成"逐个登记预期"：我们自己对某一路调 play()/pause()
  // 之前先记一笔，等它的 play/pause 事件来了对得上就吞掉；对不上的才是用户点了原生
  // 控制条，这时才去带动其它两路。时间窗口那套要么漏（漂移校正一直在刷窗口，用户的
  // 暂停被吞）要么多（seek 后的自动续播和用户暂停互相触发，三路来回播放/暂停停不下来）。
  const expectedRef = useRef(new WeakMap<HTMLVideoElement, "play" | "pause">());
  const progPlay = (v: HTMLVideoElement) => {
    if (!v.paused) return;
    expectedRef.current.set(v, "play");
    v.play().catch(() => expectedRef.current.delete(v));
  };
  const progPause = (v: HTMLVideoElement) => {
    if (v.paused) return;
    expectedRef.current.set(v, "pause");
    v.pause();
  };
  /** 事件是不是我们自己触发的：是就消费掉并返回 true */
  const consumeExpected = (v: HTMLVideoElement, kind: "play" | "pause") => {
    if (expectedRef.current.get(v) !== kind) return false;
    expectedRef.current.delete(v);
    return true;
  };
  const [speed, setSpeed] = useState(1);
  const [frame, setFrame] = useState(0);
  // 总的播放状态（以第一路为准），给总播放/暂停按钮显示用
  const [playing, setPlaying] = useState(false);
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

    all().forEach((self, idx) => {
      const others = () => all().filter((v) => v !== self);

      const syncOthers = (action: "play" | "pause" | "seek") => {
        markProgrammatic();
        for (const o of others()) {
          // 只有用户真的拖了进度条才把别人也拖过去；play/pause 不碰 currentTime——
          // 三路的 currentTime 本来就按各自帧对齐，天然差零点几帧，按这个差去
          // seek 就是无意义的来回抖，漂移交给下面的定时校正
          if (action === "seek" && Math.abs(o.currentTime - self.currentTime) > 0.15) o.currentTime = self.currentTime;
          if (action === "play") progPlay(o);
          if (action === "pause") progPause(o);
        }
      };

      const onPlay = () => {
        if (idx === 0) setPlaying(true);
        if (consumeExpected(self, "play")) return; // 我们自己让它播的，不再往外传
        syncOthers("play");
      };
      const onPause = () => {
        if (idx === 0) setPlaying(false);
        if (consumeExpected(self, "pause")) return;
        // 用户亲手暂停：seek 之后排着的"等 ready 再续播"作废，不然过一会儿又自己播起来
        resumeToken++;
        pendingSeek = null;
        syncOthers("pause");
      };
      const onSeeked = () => {
        if (isSuppressed()) return;
        syncOthers("seek");
      };
      const onTimeUpdate = () => {
        if (isSuppressed()) return;
        // 区间循环：播过终点就跳回起点。只让第一路来判断，其它路会被同步过去，
        // 不然三路各自触发会来回抢着 seek
        const loop = bus.getLoop();
        if (loop && idx === 0 && self.currentTime >= loop.end) {
          bus.seek(loop.start);
          return;
        }
        bus.reportTime(self.currentTime);
      };
      const onRateChange = () => {
        if (isSuppressed()) return;
        markProgrammatic();
        for (const o of others()) o.playbackRate = self.playbackRate;
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

    // 程序化跳转走"先暂停 → 三路一起 seek → 等三路都解码好了 → 一起恢复播放"：
    // 直接在播放中 seek，三路各自解码完成的时机不一样，先好的先跑，后面
    // 漂移校正又把它拉回来，肉眼看就是播一下停一下。等齐了再一起播就平了。
    let resumeToken = 0;
    const applyPendingSeek = () => {
      if (pendingSeek == null) return;
      const vids = all();
      const lead = vids[0];
      if (!lead || lead.seeking) return;
      const target = pendingSeek;
      pendingSeek = null;
      const wasPlaying = !lead.paused;
      markProgrammatic();
      for (const v of vids) {
        if (wasPlaying) progPause(v);
        v.currentTime = target;
      }
      bus.reportTime(target);
      if (!wasPlaying) return;

      const token = ++resumeToken;
      const started = performance.now();
      const tryResume = () => {
        if (token !== resumeToken) return; // 又来了新的 seek，这一轮作废
        const ready = vids.every((v) => !v.seeking && v.readyState >= 3);
        // 最多等 1.5s，某一路一直不 ready（比如坏帧）也别永远卡在暂停
        if (!ready && performance.now() - started < 1500) {
          requestAnimationFrame(tryResume);
          return;
        }
        markProgrammatic();
        for (const v of vids) progPlay(v);
      };
      requestAnimationFrame(tryResume);
    };

    bus.setSeekHandler((sec) => {
      pendingSeek = sec;
      applyPendingSeek();
    });

    // 设了循环就自动开始播，不然点"循环"只是跳过去停在起点，还得再点播放；
    // 停止循环则把视频暂停——循环是拿来核对这一段的，停了还往后播就跑出这段了。
    // 终点判断不能只靠 timeupdate（一秒只来四次，0.5s 的片段能冲出去 200ms），
    // 循环期间再用 rAF 逐帧盯着第一路，到点立刻跳回起点。
    let loopRaf: number | null = null;
    const stopLoopRaf = () => {
      if (loopRaf != null) cancelAnimationFrame(loopRaf);
      loopRaf = null;
    };
    const offLoop = bus.onLoopChange((loop) => {
      stopLoopRaf();
      if (!loop) {
        // 循环刚跳回起点那一下是"暂停 -> seek -> 等三路 ready -> 再播"，如果正好
        // 在等 ready 的窗口里点了停止，这里 pause 完，那个延后的"再播"还会把视频
        // 重新放起来。把那一轮作废、pending 的 seek 也丢掉，停止就是真的停。
        resumeToken++;
        pendingSeek = null;
        markProgrammatic();
        for (const v of all()) progPause(v);
        return;
      }
      for (const v of all()) progPlay(v);
      const tick = () => {
        const cur = bus.getLoop();
        if (!cur) return;
        const lead0 = all()[0];
        if (lead0 && !lead0.seeking && lead0.currentTime >= cur.end) bus.seek(cur.start);
        loopRaf = requestAnimationFrame(tick);
      };
      loopRaf = requestAnimationFrame(tick);
    });
    cleanups.push(() => {
      stopLoopRaf();
      offLoop();
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
    // 校正方式分两档：漂移不大（< DRIFT_HARD_SEEK_SEC）就让落后/超前的那路临时
    // 快/慢 15% 一秒追上去，画面连续不打断；真的差得远才硬 seek。任何一路还在
    // seeking/没解码好的时候不校正——那不是漂移，是还没准备好，这时候去 seek
    // 只会越搞越乱。
    const nudged = new Set<HTMLVideoElement>();
    const driftTimer = setInterval(() => {
      const [lead, ...rest] = all();
      if (!lead || lead.paused || isSuppressed()) return;
      if ([lead, ...rest].some((v) => v.seeking || v.readyState < 3)) return;
      const base = lead.playbackRate;
      const tolerance = DRIFT_TOLERANCE_SEC * Math.max(1, base);
      markProgrammatic();
      for (const v of rest) {
        const drift = v.currentTime - lead.currentTime; // >0 超前，<0 落后
        if (Math.abs(drift) > DRIFT_HARD_SEEK_SEC) {
          v.currentTime = lead.currentTime;
          if (nudged.delete(v)) v.playbackRate = base;
        } else if (Math.abs(drift) > tolerance) {
          v.playbackRate = base * (drift > 0 ? 0.85 : 1.15);
          nudged.add(v);
        } else if (nudged.delete(v)) {
          v.playbackRate = base;
        }
      }
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
      // 平移不能把画面拖出框：放大后画面比框大 (scale-1)*框 这么多，左右/上下各最多
      // 挪一半，超过就露底色了
      const clamp = () => {
        const maxX = ((state.scale - 1) * wrapper.clientWidth) / 2;
        const maxY = ((state.scale - 1) * wrapper.clientHeight) / 2;
        state.tx = Math.max(-maxX, Math.min(maxX, state.tx));
        state.ty = Math.max(-maxY, Math.min(maxY, state.ty));
      };
      const apply = () => {
        clamp();
        video.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
        wrapper.style.cursor = state.scale > ZOOM_MIN ? "grab" : "";
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
        } else {
          // 以鼠标所在点为中心缩放：鼠标指着的那块画面缩放前后停在同一个位置
          const rect = wrapper.getBoundingClientRect();
          const px = e.clientX - rect.left - rect.width / 2;
          const py = e.clientY - rect.top - rect.height / 2;
          const k = state.scale / prevScale;
          state.tx = px - (px - state.tx) * k;
          state.ty = py - (py - state.ty) * k;
        }
        apply();
      };

      // 放大之后直接按住左键就能拖（不用再按 shift）；没放大时不拦截，让原生控制条正常用
      const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0 || state.scale <= ZOOM_MIN) return;
        // 点在原生控制条上（画面底部约 40px）不当作拖拽
        const rect = wrapper.getBoundingClientRect();
        if (e.clientY > rect.bottom - 44) return;
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        wrapper.style.cursor = "grabbing";
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
        if (!dragging) return;
        dragging = false;
        apply();
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
        wrapper.style.cursor = "";
      });
    });
    return () => cleanups.forEach((fn) => fn());
  }, [videos]);

  const handleSpeedChange = (rate: number) => {
    setSpeed(rate);
    markProgrammatic();
    const wasPlaying = refs.current.some((v) => v && !v.paused);
    for (const v of refs.current) {
      if (v) v.playbackRate = rate;
    }
    // 播放中途改速率，Chrome 的音画同步管线经常从这一刻开始卡顿，得暂停再播放
    // 才能重新同步——用户手动暂停/播放能验证不卡，这里就直接把这个动作自动做一遍。
    if (wasPlaying) {
      for (const v of refs.current) if (v) progPause(v);
      for (const v of refs.current) if (v) progPlay(v);
    }
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

  // 总播放/暂停：三路一起动，不用挨个点每路自己的控制条
  const toggleAll = () => {
    const vids = refs.current.filter((v): v is HTMLVideoElement => v != null);
    if (vids.length === 0) return;
    const anyPlaying = vids.some((v) => !v.paused);
    markProgrammatic();
    for (const v of vids) {
      if (anyPlaying) progPause(v);
      else progPlay(v);
    }
    setPlaying(!anyPlaying);
  };

  // 空格 = 总播放/暂停（焦点在输入框里时不抢）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON" || el.isContentEditable)) return;
      e.preventDefault();
      toggleAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const speedControls = (
    <Space wrap>
      <Button
        size="small"
        type="primary"
        icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
        onClick={toggleAll}
        title="三路一起播放/暂停（快捷键：空格）"
      >
        {playing ? "暂停" : "播放"}
      </Button>
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
        max={MAX_SPEED}
        step={0.05}
        value={speed}
        onChange={handleSpeedChange}
        style={{ width: 140 }}
        tooltip={{ formatter: (v) => `${v}x` }}
      />
      <InputNumber
        size="small"
        min={0.25}
        max={MAX_SPEED}
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
            of {totalFrames ?? "..."}（{fps} fps，画面内 Shift+滚轮缩放，放大后直接拖拽平移，双击复原）
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
                    ? // overflow:hidden 是关键：放大后的画面只能在自己这一格里放大/拖动，
                      // 不能溢出去盖住旁边两路
                      { flex: 1, minWidth: 0, display: "flex", overflow: "hidden", position: "relative", background: "#000" }
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
