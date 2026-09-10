// 视频播放位置 <-> IMU曲线 的双向同步总线。刻意不用 React state：视频播放时
// currentTime 是高频更新（timeupdate事件每秒触发几十次），塞进React state会
// 导致整棵树跟着高频重渲染，这里用普通的订阅/发布，视频和图表都是直接操作
// 自己的DOM/uPlot实例，互不经过React渲染循环。
export class TimeBus {
  private timeListeners: ((sec: number) => void)[] = [];
  private seekHandler: ((sec: number) => void) | null = null;
  // handler 还没注册时收到的 seek，等注册上来再补发（见 setSeekHandler）
  private pendingSeek: number | null = null;
  private pendingSec: number | null = null;
  private rafId: number | null = null;
  // 区间循环：设了之后视频播到 end 就跳回 start 接着播（片段列表"循环"按钮用，
  // 反复看一段抓挠的起止）。存在这里而不是 React state，跟 currentTime 一样
  // 是视频 timeupdate 里高频读的东西，不该走渲染循环。
  private loop: { start: number; end: number } | null = null;
  private loopListeners: ((loop: { start: number; end: number } | null) => void)[] = [];

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
    // 补上注册之前就发生的那次 seek。
    // 从别处点「去修」进来时，工作台是在拿到媒体列表的同一个 tick 里就调 seek 的，
    // 而那一刻 SyncedVideoGroup 还没挂载、还没注册 handler——原来 seek 是
    // `this.seekHandler?.(sec)`，没有 handler 就静默什么都不做。表现是视频停在
    // 0:00、帧号 0，人以为功能没做，其实是调早了一拍。
    // 这里存下来等 handler 来了再补一次，比要求每个调用方自己去等挂载靠谱。
    if (fn && this.pendingSeek != null) {
      const s = this.pendingSeek;
      this.pendingSeek = null;
      fn(s);
    }
  }

  seek(sec: number): void {
    if (!this.seekHandler) {
      this.pendingSeek = sec;
      return;
    }
    this.seekHandler(sec);
  }

  getLoop(): { start: number; end: number } | null {
    return this.loop;
  }

  /** 设区间循环并跳到起点开始播；传 null 取消循环（不动播放状态） */
  setLoop(loop: { start: number; end: number } | null): void {
    this.loop = loop;
    for (const cb of this.loopListeners) cb(loop);
    if (loop) this.seek(loop.start);
  }

  onLoopChange(cb: (loop: { start: number; end: number } | null) => void): () => void {
    this.loopListeners.push(cb);
    return () => {
      this.loopListeners = this.loopListeners.filter((c) => c !== cb);
    };
  }
}
