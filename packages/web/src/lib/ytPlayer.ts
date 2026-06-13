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

// YT can't fine-slew playbackRate like the direct player, so we DON'T correct
// small drift at all (that backward yank was the jitter) — only snap a genuine
// desync, matching WebPlayer's 3s ceiling. The buffer gate keeps steady-state
// drift well under this, so heartbeats rarely seek.
const HARD_SEEK = 3.0;
const SEEK_JUMP = 1.2; // unexpected position jump (s) → the viewer scrubbed.
const TICK_MS = 250;
const STALL_DEBOUNCE_MS = 500; // buffering must persist this long before we gate
const SELF_QUIET_MS = 1500; // ignore buffering / seek-detection right after our own apply

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
  /** Video ended → playlist auto-advance (§16). */
  onEnded: () => void = () => {};
  solo = false;

  private state: MemberStatus = "loading";
  private last: { intent: SyncMessage["intent"]; gatePaused: boolean } | null = null;
  private rate = 1;
  private poll: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last time WE drove the player (play/pause/seek) — buffering and position
   *  jumps within SELF_QUIET_MS of this are our own doing, not a stall/scrub. */
  private selfActAt = 0;
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
    if (s === 0) this.onEnded(); // ENDED → auto-advance
    if (s === 3) {
      // Buffering: gate the room only if it PERSISTS while we should be playing
      // and it isn't the buffering our own seek/play just caused (debounced).
      this.armStall();
      return;
    }
    if (s === PLAYING || s === 2 || s === 5 || s === 0) {
      this.clearStall();
      this.setState("ready");
    }
    if (s === PLAYING) {
      if (this.expectPlay) this.expectPlay = false;
      else this.onUserControl("playing", this.cur());
    } else if (s === 2) {
      if (this.expectPause) this.expectPause = false;
      else this.onUserControl("paused", this.cur());
    }
  }

  private shouldBePlaying(): boolean {
    return Boolean(this.last && this.last.intent === "playing" && !this.last.gatePaused);
  }
  private setState(s: MemberStatus): void {
    if (this.state === s) return;
    this.state = s;
    this.emit();
  }
  private armStall(): void {
    if (this.stallTimer) return;
    if (performance.now() - this.selfActAt < SELF_QUIET_MS) return; // our own seek/play
    if (!this.shouldBePlaying()) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.yt.getPlayerState() === 3 && this.shouldBePlaying()) this.setState("stalled");
    }, STALL_DEBOUNCE_MS);
  }
  private clearStall(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /** Enforce the server truth on the YT player (SPEC §4). */
  apply(sync: SyncMessage, gate: GateMessage): void {
    const shouldPlay = sync.intent === "playing" && !gate.paused;
    this.last = { intent: sync.intent, gatePaused: gate.paused };
    this.rate = Number.isFinite(sync.rate) && sync.rate > 0 ? sync.rate : 1;
    this.selfActAt = performance.now(); // anything we do here is "our own action"

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
    const dt = (now - this.lastWall) / 1000;
    const playing = this.yt.getPlayerState() === PLAYING;

    // Detect a user scrub on YT's native bar: in ONE normal tick the position
    // jumped far more (or backward) than playback would advance. Skip if the
    // tick was delayed (dt too long — a throttled background tab, not a scrub)
    // or right after our own action; buffering only lags ~one tick, so it stays
    // under the threshold and won't false-fire.
    if (playing && dt < 1.0 && now - this.selfActAt > SELF_QUIET_MS) {
      const expected = this.lastTime + dt * this.rate;
      const ourSeek =
        this.expectSeekTo != null &&
        (now - this.expectSeekAt < SELF_QUIET_MS || Math.abs(cur - this.expectSeekTo) < 1.0);
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
    this.clearStall();
    try {
      this.yt.destroy();
    } catch {
      /* player may already be gone */
    }
  }
}
