import * as vscode from 'vscode';

export interface TimerConfig {
  pauseAfter: number;   // seconds of idle before auto-pause
  autoStart: boolean;   // start timer on first keystroke automatically
}

const STATE_KEY = 'codeTimer.seconds';
const TICK_MS = 1000;

export type ResumeFromPauseHandler = (awaySeconds: number) => void;

export class Timer {
  private seconds: number;
  private lastKeystroke = 0;
  private lastTickAt = 0;
  private pausedAt = 0;
  private active = false;
  private tickHandle: NodeJS.Timeout | undefined;

  constructor(
    private state: vscode.Memento,
    private getConfig: () => TimerConfig,
    private onChange: () => void,
    private onResumeFromPause?: ResumeFromPauseHandler,
  ) {
    this.seconds = state.get<number>(STATE_KEY, 0);
  }

  getSeconds(): number { return this.seconds; }
  isActive(): boolean { return this.active; }

  onKeystroke(): void {
    const cfg = this.getConfig();
    if (!cfg.autoStart && !this.active) return;

    const now = Date.now();
    const resumingFromPause = !this.active && this.lastKeystroke > 0;

    if (resumingFromPause) {
      const awaySec = (now - this.pausedAt) / 1000;
      this.onResumeFromPause?.(awaySec);
    }

    this.lastKeystroke = now;
    if (!this.active) {
      this.active = true;
      this.lastTickAt = now;
      this.startTick();
      this.onChange();
    }
  }

  pause(): void {
    if (!this.active) return;
    this.active = false;
    this.pausedAt = Date.now();
    this.stopTick();
    this.persist();
    this.onChange();
  }

  resume(): void {
    if (this.active) return;
    this.active = true;
    const now = Date.now();
    this.lastKeystroke = now;
    this.lastTickAt = now;
    this.startTick();
    this.onChange();
  }

  reset(): void {
    this.seconds = 0;
    this.pause();
    this.lastKeystroke = 0;
    this.persist();
    this.onChange();
  }

  adjust(deltaSeconds: number): void {
    this.seconds = Math.max(0, this.seconds + deltaSeconds);
    this.persist();
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
      // Credit time up to the pause boundary, then stop.
      if (pauseAt > this.lastTickAt) {
        this.seconds += (pauseAt - this.lastTickAt) / 1000;
      }
      this.lastTickAt = now;
      this.pause();
      return;
    }

    this.seconds += (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    this.persist();
    this.onChange();
  }

  private persist(): void {
    void this.state.update(STATE_KEY, this.seconds);
  }
}
