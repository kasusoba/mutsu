/**
 * YtPlayer — drives a YouTube embed on the room page via the YouTube IFrame
 * Player API (SPEC §15 / §4). YouTube exposes no raw `<video>` we can hook, so
 * for YT sources the room page itself controls the official player, showing
 * YouTube's OWN controls.
 *
 * Unlike WebPlayer (one-way), this is BIDIRECTIONAL: it enforces the server's
 * truth AND reports the viewer's own play/pause/seek (done on YT's native
 * controls) back as room commands — same model as the embed VideoHook. A set of
 * expect-flags suppress the echoes of our own apply() so they aren't misread as
 * user actions (the feedback loop that would make everyone snap).
 *
 * Autoplay: we start muted so the synced video auto-starts on every viewer with
 * no click (browser policy allows muted autoplay); a one-tap unmute gets audio.
 * Content-neutral: it plays a YouTube id the user supplied; no extraction.
 */

import type { GateMessage, Intent, MemberStatus, SyncMessage } from "@sixseven/protocol";

const HARD_SEEK = 1.5; // YT can't fine-slew playbackRate, so just snap big desync.
const SEEK_JUMP = 1.2; // unexpected position jump (s) → the viewer scrubbed.
const TICK_MS = 250;

export interface YtApi {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
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
  /** The viewer played/paused/seeked via YT's own controls → relay to the room. */
  onUserControl: (intent: Intent, time: number) => void = () => {};
  /** Mute state changed (drives the "tap to unmute" hint). */
  onMutedChange: (muted: boolean) => void = () => {};
  solo = false;

  private state: MemberStatus = "loading";
  private last: { intent: SyncMessage["intent"]; gatePaused: boolean } | null = null;
  private rate = 1;
  private poll: ReturnType<typeof setInterval> | null = null;
  // Echo suppression for our own apply():
  private expectPlay = false;
  private expectPause = false;
  private expectSeekTo: number | null = null;
  private expectSeekAt = 0;
  // Seek detection:
  private lastTime = 0;
  private lastWall = 0;

  constructor(private readonly yt: YtApi) {}

  start(): void {
    this.yt.mute(); // muted autoplay — starts in sync with no gesture
    this.lastWall = performance.now();
    this.lastTime = this.cur();
    this.poll = setInterval(() => this.tick(), TICK_MS);
  }

  /** Map a YT state change to readiness + report genuine user play/pause. */
  onYtState(s: number): void {
    if (s === 3) {
      this.state = "stalled";
      this.emit();
      return;
    }
    if (s === PLAYING || s === 2 || s === 5 || s === 0) {
      this.state = "ready";
      this.emit();
    }
    if (s === PLAYING) {
      if (this.expectPlay) this.expectPlay = false;
      else this.onUserControl("playing", this.cur());
    } else if (s === 2) {
      if (this.expectPause) this.expectPause = false;
      else this.onUserControl("paused", this.cur());
    }
  }

  /** Enforce the server truth on the YT player (SPEC §4). */
  apply(sync: SyncMessage, gate: GateMessage): void {
    const shouldPlay = sync.intent === "playing" && !gate.paused;
    this.last = { intent: sync.intent, gatePaused: gate.paused };
    this.rate = Number.isFinite(sync.rate) && sync.rate > 0 ? sync.rate : 1;

    const cur = this.cur();
    const drift = Math.abs(cur - sync.time);
    if (sync.force ? drift > 0.5 : !this.solo && drift > HARD_SEEK) {
      this.expectSeekTo = sync.time;
      this.expectSeekAt = performance.now();
      this.yt.seekTo(sync.time, true);
      this.lastTime = sync.time;
      this.lastWall = performance.now();
    }

    const playing = this.yt.getPlayerState() === PLAYING;
    if (shouldPlay && !playing) {
      this.expectPlay = true;
      this.yt.playVideo();
    } else if (!shouldPlay && playing) {
      this.expectPause = true;
      this.yt.pauseVideo();
    }
  }

  unmute(): void {
    this.yt.unMute();
    this.onMutedChange(false);
  }

  private tick(): void {
    const cur = this.cur();
    const now = performance.now();
    const playing = this.yt.getPlayerState() === PLAYING;

    // Detect a user scrub on YT's native bar: position jumped vs where normal
    // playback would be, and it wasn't our own seek.
    if (playing) {
      const expected = this.lastTime + ((now - this.lastWall) / 1000) * this.rate;
      const ourSeek =
        this.expectSeekTo != null &&
        (now - this.expectSeekAt < 1500 || Math.abs(cur - this.expectSeekTo) < 1.0);
      if (!ourSeek && Math.abs(cur - expected) > SEEK_JUMP) {
        this.onUserControl("playing", cur);
      }
      if (this.expectSeekTo != null && Math.abs(cur - this.expectSeekTo) < 1.0) {
        this.expectSeekTo = null;
      }
    }
    this.lastTime = cur;
    this.lastWall = now;

    this.onMutedChange(this.yt.isMuted());
    this.emit();
  }

  private emit(): void {
    this.onStatus(this.state, this.cur(), this.yt.getDuration() || 0);
  }

  private cur(): number {
    return this.yt.getCurrentTime() || 0;
  }

  currentTime(): number {
    return this.cur();
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
