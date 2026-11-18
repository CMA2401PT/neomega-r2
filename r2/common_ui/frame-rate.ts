/** 每个样本是两张连续预览画面之间的毫秒数。静止、地图和拍照可打断一段预览。 */
export class FrameRate {
  readonly intervals: number[] = [];
  private last: number | null = null;
  private pending: Promise<void> | null = null;

  get waiting() { return this.pending !== null; }

  complete(now: number) {
    if (this.last === null) this.intervals.length = 0;
    else if (now > this.last) {
      this.intervals.push(now - this.last);
      if (this.intervals.length > 240) this.intervals.shift();
    }
    this.last = now;
  }

  track(frame: Promise<void>) {
    this.pending = frame;
    frame.then(() => {
      if (this.pending !== frame) return;
      this.pending = null;
      this.complete(performance.now());
    }, () => {
      if (this.pending === frame) this.reset();
    });
  }

  idle() {
    if (!this.waiting) this.last = null;
  }

  reset() {
    this.pending = null;
    this.last = null;
    this.intervals.length = 0;
  }

  /** 最近约两秒的吞吐量。低于 4 FPS 的长帧也完整计入。 */
  get fps(): number | null {
    let elapsed = 0, count = 0;
    for (let i = this.intervals.length - 1; i >= 0 && elapsed < 2000; i--) {
      elapsed += this.intervals[i];
      count++;
    }
    return elapsed > 0 ? 1000 * count / elapsed : null;
  }
}
