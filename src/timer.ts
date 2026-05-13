export interface TimerConfig {
  pauseAfter: number;   // seconds of idle before auto-pause
  autoStart: boolean;   // start timer on first keystroke automatically
}

export interface PersistedState {
  total: number;
  current: number;
}

const TICK_MS = 1000;

export type ResumeFromPauseHandler = (awaySeconds: number) => void;
export type PersistFn = (state: PersistedState) => void;

export class Timer {
  private current: number;
  private total: number;
  private lastKeystroke = 0;
  private lastTickAt = 0;
  private pausedAt = 0;
  private active = false;
  private manualPause = false;
  private tickHandle: NodeJS.Timeout | undefined;

  constructor(
    initial: PersistedState,
    private getConfig: () => TimerConfig,
    private persist: PersistFn,
    private onChange: () => void,
    private onResumeFromPause?: ResumeFromPauseHandler,
  ) {
    this.current = initial.current;
    this.total = initial.total;
  }

  getSeconds(): number { return this.current; }
  getTotal(): number { return this.total; }
  isActive(): boolean { return this.active; }

  setState(state: PersistedState): void {
    this.current = state.current;
    this.total = state.total;
    this.onChange();
  }

  onKeystroke(): void {
    const cfg = this.getConfig();
    if (!cfg.autoStart && !this.active) return;

    const now = Date.now();
    const resumingFromPause = !this.active && this.lastKeystroke > 0;

    if (resumingFromPause && !this.manualPause) {
      const awaySec = (now - this.pausedAt) / 1000;
      this.onResumeFromPause?.(awaySec);
    }
    this.manualPause = false;

    this.lastKeystroke = now;
    if (!this.active) {
      this.active = true;
      this.lastTickAt = now;
      this.startTick();
      this.onChange();
    }
  }

  pause(): void {
    this.manualPause = true;
    this.doPause();
  }

  resume(): void {
    if (this.active) return;
    this.manualPause = false;
    this.active = true;
    const now = Date.now();
    this.lastKeystroke = now;
    this.lastTickAt = now;
    this.startTick();
    this.onChange();
  }

  private doPause(): void {
    if (!this.active) return;
    this.active = false;
    this.pausedAt = Date.now();
    this.stopTick();
    this.save();
    this.onChange();
  }

  // Clears `current` (per-commit count). Lifetime `total` is preserved.
  reset(): void {
    this.current = 0;
    this.pause();
    this.lastKeystroke = 0;
    this.save();
    this.onChange();
  }

  // Clears both `current` and lifetime `total`.
  resetTotal(): void {
    this.current = 0;
    this.total = 0;
    this.pause();
    this.lastKeystroke = 0;
    this.save();
    this.onChange();
  }

  adjust(deltaSeconds: number): void {
    this.current = Math.max(0, this.current + deltaSeconds);
    this.total = Math.max(0, this.total + deltaSeconds);
    this.save();
    this.onChange();
  }

  dispose(): void {
    this.stopTick();
  }

  private startTick(): void {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTick(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
  }

  private tick(): void {
    if (!this.active) return;
    const cfg = this.getConfig();
    const now = Date.now();
    const pauseAt = this.lastKeystroke + cfg.pauseAfter * 1000;

    if (now >= pauseAt) {
      if (pauseAt > this.lastTickAt) {
        const delta = (pauseAt - this.lastTickAt) / 1000;
        this.current += delta;
        this.total += delta;
      }
      this.lastTickAt = now;
      this.doPause();
      return;
    }

    const delta = (now - this.lastTickAt) / 1000;
    this.current += delta;
    this.total += delta;
    this.lastTickAt = now;
    this.save();
    this.onChange();
  }

  private save(): void {
    this.persist({ total: this.total, current: this.current });
  }
}
