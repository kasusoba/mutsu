/**
 * VideoHook — the only code that touches the embed's `<video>`. It runs the
 * SPEC §4 drift-correction against the real element and reports readiness for
 * the buffer gate (SPEC §9). Re-hooks when the embed swaps its `<video>`
 * (ad break / server switch — SPEC §16 risk 1), and polls `readyState` as a
 * fallback because player buffer events are unreliable (risk 2).
 *
 * It reads/sets a `<video>` clock. It does not rip, relay, or unlock anything.
 */

import { DRIFT_THRESHOLD, type Intent } from "@sixseven/protocol";
import { STATUS_REPORT_MS } from "@sixseven/protocol/bridge";

type State = "loading" | "ready" | "stalled" | "failed";

interface ApplyState {
  intent: Intent;
  time: number;
  rate: number;
  gatePaused: boolean;
}

export class VideoHook {
  onStatus: (state: State, currentTime: number, duration: number) => void = () => {};
  onHookChange: (found: boolean) => void = () => {};
  onLocalControl: (intent: Intent, time: number) => void = () => {};

  /** Set by the entrypoint from overlay state: forward native UI actions? */
  allowLocalControl = false;

  private video: HTMLVideoElement | null = null;
  private last: ApplyState | null = null;
  private state: State = "loading";
  /** True while we are the ones mutating the video (suppresses echo events). */
  private applying = false;
  private observer: MutationObserver | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly boundEvents: Array<[keyof HTMLMediaElementEventMap, EventListener]> = [];

  start(): void {
    this.hook();
    this.observer = new MutationObserver(() => {
      // Re-hook if our video vanished or a better one appeared.
      if (!this.video || !this.video.isConnected || this.findBest() !== this.video) this.hook();
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });

    this.poll = setInterval(() => this.tick(), STATUS_REPORT_MS);
  }

  /** Current position of the hooked video, or null if none (for the subtitle layer). */
  currentTime(): number | null {
    return this.video?.currentTime ?? null;
  }

  /** Apply the latest server truth to the video (SPEC §4). */
  apply(s: ApplyState): void {
    this.last = s;
    const v = this.video;
    if (!v) {
      this.hook();
      return;
    }
    this.applying = true;
    if (Number.isFinite(s.rate) && s.rate > 0 && v.playbackRate !== s.rate) {
      v.playbackRate = s.rate;
    }
    if (Math.abs(v.currentTime - s.time) > DRIFT_THRESHOLD) {
      v.currentTime = s.time;
    }
    const shouldPlay = s.intent === "playing" && !s.gatePaused;
    if (shouldPlay && v.paused) {
      v.play().catch(() => this.setState("stalled")); // autoplay blocked → gate holds
    } else if (!shouldPlay && !v.paused) {
      v.pause();
    }
    // Release the echo-suppression flag after the events settle.
    setTimeout(() => {
      this.applying = false;
    }, 50);
  }

  // ── hooking ────────────────────────────────────────────────────────────────

  private findBest(): HTMLVideoElement | null {
    const vids = Array.from(document.querySelectorAll("video"));
    if (vids.length === 0) return null;
    // Prefer a playing video, then the largest by area.
    const score = (v: HTMLVideoElement) =>
      (v.paused ? 0 : 1_000_000_000) + v.clientWidth * v.clientHeight;
    return vids.reduce((best, v) => (score(v) > score(best) ? v : best));
  }

  private hook(): void {
    const next = this.findBest();
    if (next === this.video) return;

    if (this.video) this.detach(this.video);
    this.video = next;
    this.onHookChange(Boolean(next));

    if (next) {
      this.attach(next);
      // Re-assert the last known server state onto the fresh element.
      if (this.last) this.apply(this.last);
      this.refreshState();
    }
  }

  private attach(v: HTMLVideoElement): void {
    const on = (name: keyof HTMLMediaElementEventMap, fn: EventListener) => {
      v.addEventListener(name, fn);
      this.boundEvents.push([name, fn]);
    };
    on("waiting", () => this.setState("stalled"));
    on("stalled", () => this.setState("stalled"));
    on("playing", () => this.refreshState());
    on("canplay", () => this.refreshState());
    on("loadeddata", () => this.refreshState());
    on("error", () => this.setState("failed"));
    // Native-UI actions (only reachable when the escape hatch is open).
    on("play", () => this.maybeLocal("playing"));
    on("pause", () => this.maybeLocal("paused"));
    on("seeked", () => this.maybeLocal(v.paused ? "paused" : "playing"));
  }

  private detach(v: HTMLVideoElement): void {
    for (const [name, fn] of this.boundEvents) v.removeEventListener(name, fn);
    this.boundEvents.length = 0;
  }

  private maybeLocal(intent: Intent): void {
    if (this.applying || !this.allowLocalControl || !this.video) return;
    this.onLocalControl(intent, this.video.currentTime);
  }

  // ── status ─────────────────────────────────────────────────────────────────

  private setState(s: State): void {
    this.state = s;
  }

  /** Derive readiness from readyState as the reliable fallback (risk #2). */
  private refreshState(): void {
    const v = this.video;
    if (!v) return;
    // HAVE_FUTURE_DATA (3) or better ⇒ can play through "now".
    this.setState(v.readyState >= 3 ? "ready" : "stalled");
  }

  private tick(): void {
    if (!this.video) {
      // Stay SILENT when there's no video — this frame may just be embed chrome
      // with the real player nested deeper. The page owns the failed-timeout, so
      // an empty frame must not report `failed` (it would fight the real one).
      this.hook();
      return;
    }
    // Fold in the readyState fallback unless an event already marked failed.
    if (this.state !== "failed") this.refreshState();
    const dur = Number.isFinite(this.video.duration) ? this.video.duration : 0;
    this.onStatus(this.state, this.video.currentTime, dur);
  }

  destroy(): void {
    this.observer?.disconnect();
    if (this.poll) clearInterval(this.poll);
    if (this.video) this.detach(this.video);
  }
}
