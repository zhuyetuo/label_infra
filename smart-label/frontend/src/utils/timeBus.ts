// 视频播放位置 <-> IMU曲线 的双向同步总线。刻意不用 React state：视频播放时
// currentTime 是高频更新（timeupdate事件每秒触发几十次），塞进React state会
// 导致整棵树跟着高频重渲染，这里用普通的订阅/发布，视频和图表都是直接操作
// 自己的DOM/uPlot实例，互不经过React渲染循环。
export class TimeBus {
  private timeListeners: ((sec: number) => void)[] = [];
  private seekHandler: ((sec: number) => void) | null = null;
  private pendingSec: number | null = null;
  private rafId: number | null = null;

  onTime(cb: (sec: number) => void): () => void {
    this.timeListeners.push(cb);
    return () => {
      this.timeListeners = this.timeListeners.filter((c) => c !== cb);
    };
  }

  // 3路视频各自都会触发 timeupdate，同一帧内可能收到好几次上报；
  // 用 rAF 合并成每帧最多一次通知，避免图表在一帧内被重复redraw导致卡顿。
  reportTime(sec: number): void {
    this.pendingSec = sec;
    if (this.rafId != null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (this.pendingSec == null) return;
      const s = this.pendingSec;
      this.pendingSec = null;
      for (const cb of this.timeListeners) cb(s);
    });
  }

  setSeekHandler(fn: ((sec: number) => void) | null): void {
    this.seekHandler = fn;
  }

  seek(sec: number): void {
    this.seekHandler?.(sec);
  }
}
