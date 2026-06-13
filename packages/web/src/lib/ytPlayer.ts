/**
 * YtPlayer — drives a YouTube embed on the room page via the YouTube IFrame
 * Player API (SPEC §15 / §4). YouTube exposes no raw `<video>` we can hook, so
 * for YT sources the room page itself controls the official player. Same model
 * as WebPlayer: ONE-WAY (enforce the server's truth; report readiness for the
 * gate), with all user input flowing through our own control bar — so there's
 * no player→server→player feedback loop.
 *
 * Content-neutral: it plays a YouTube id the user supplied; no extraction.
 */

import type { GateMessage, MemberStatus, SyncMessage } from "@sixseven/protocol";
import { STATUS_REPORT_MS } from "@sixseven/protocol/bridge";

const HARD_SEEK = 1.5; // YT can't fine-slew playbackRate, so just snap big desync.

/** The slice of the YT.Player API we use. */
export interface YtApi {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setVolume(v: number): void;
  mute(): void;
  unMute(): void;
  destroy(): void;
}

// YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
const PLAYING = 1;

let apiPromise: Promise<unknown> | null = null;

/** Load the YouTube IFrame API once (idempotent); resolves with `window.YT`. */
export function loadYouTubeApi(): Promise<{ Player: new (el: HTMLElement, opts: unknown) => YtApi }> {
  if (!apiPromise) {
    apiPromise = new Promise((resolve) => {
      const w = window as unknown as {
        YT?: { Player: unknown };
        onYouTubeIframeAPIReady?: () => void;
      };
      if (w.YT?.Player) return resolve(w.YT);
      const prev = w.onYouTubeIframeAPIReady;
      w.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve(w.YT);
      };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    });
  }
  return apiPromise as Promise<{ Player: new (el: HTMLElement, opts: unknown) => YtApi }>;
}

export class YtPlayer {
  onStatus: (state: MemberStatus, currentTime: number, duration: number) => void = () => {};
  solo = false;

  private state: MemberStatus = "loading";
  private last: { intent: SyncMessage["intent"]; gatePaused: boolean } | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly yt: YtApi) {}

  start(): void {
    this.poll = setInterval(() => this.emit(), STATUS_REPORT_MS);
  }

  /** Map a YT state change to our readiness model + emit. */
  onYtState(s: number): void {
    if (s === 3) this.state = "stalled";
    else if (s === 1 || s === 2 || s === 5 || s === 0) this.state = "ready";
    this.emit();
  }

  /** Enforce the server truth on the YT player (SPEC §4). One-way. */
  apply(sync: SyncMessage, gate: GateMessage): void {
    const shouldPlay = sync.intent === "playing" && !gate.paused;
    this.last = { intent: sync.intent, gatePaused: gate.paused };

    const cur = this.yt.getCurrentTime() || 0;
    const drift = Math.abs(cur - sync.time);
    // force = real command (snap precisely); tick = only correct a big desync
    // (solo viewers are left alone). YT seekTo is the only correction available.
    if (sync.force ? drift > 0.5 : !this.solo && drift > HARD_SEEK) {
      this.yt.seekTo(sync.time, true);
    }

    const playing = this.yt.getPlayerState() === PLAYING;
    if (shouldPlay && !playing) this.yt.playVideo();
    else if (!shouldPlay && playing) this.yt.pauseVideo();
  }

  private emit(): void {
    this.onStatus(this.state, this.yt.getCurrentTime() || 0, this.yt.getDuration() || 0);
  }

  setVolume(volume: number, muted: boolean): void {
    if (muted || volume === 0) this.yt.mute();
    else {
      this.yt.unMute();
      this.yt.setVolume(Math.round(volume * 100));
    }
  }

  currentTime(): number {
    return this.yt.getCurrentTime() || 0;
  }

  destroy(): void {
    if (this.poll) clearInterval(this.poll);
    try {
      this.yt.destroy();
    } catch {
      /* player may already be gone */
    }
  }
}
