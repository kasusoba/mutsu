/**
 * WebPlayer — drives a same-origin `<video>` on the room page for `direct`
 * sources (SPEC §15 P4). It is ONE-WAY: it enforces the server's truth on the
 * element (SPEC §4 drift/dead-zone) and reports readiness for the buffer gate
 * (SPEC §9). It deliberately does NOT translate the element's own media events
 * back into `control` messages — because we own this element and provide our own
 * UI, every state change either came from us (an echo to ignore) or from the
 * player buffering (not a user intent). All user input flows through the room
 * controls instead. That removes the video→server→video feedback loop that
 * caused jitter and made play/pause logging unreliable.
 *
 * Content-neutral: plays whatever URL it's handed; no extraction/forging (§3).
 */

import type { GateMessage, MemberStatus, SyncMessage } from "@mutsu/protocol";
import { STATUS_REPORT_MS, type SubtitleCue, type TrackInfo } from "@mutsu/protocol/bridge";

const STALL_DEBOUNCE_MS = 700;
const SELF_SEEK_QUIET_MS = 1000;
// Multi-viewer drift correction (heartbeat ticks): glide back via a small
// playbackRate slew instead of a hard seek, which is invisible vs. the
// black-screen jump a seek causes mid-playback.
const NUDGE_ZONE = 0.4; // below this drift (s) we're "in sync" — leave rate alone
const HARD_SEEK = 3.0; // above this drift (s) it's a real desync → snap
const MAX_NUDGE = 0.08; // cap the rate slew at ±8% (subtle, barely audible)
const NUDGE_GAIN = 0.06; // rate slew per second of drift (before the cap)

export class WebPlayer {
  /** Readiness + position, reported on change and every STATUS_REPORT_MS. */
  onStatus: (state: MemberStatus, currentTime: number, duration: number) => void = () => {};
  /** Fired whenever apply() hard-seeks the video (for the debug HUD). */
  onSeek: (from: number, to: number) => void = () => {};
  /** Fired when the video reaches its end (drives playlist auto-advance, §16). */
  onEnded: () => void = () => {};
  /** Fired when the element's own caption tracks appear/change (§13). The same-
   *  origin element exposes them directly — no bridge, unlike the embed path. */
  onTextTracksChanged: () => void = () => {};
  /** True when this viewer is alone: don't force realtime, just let it play. */
  solo = false;

  private state: MemberStatus = "loading";
  private selfSeekAt = 0;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickTime = -1;
  private last: { intent: SyncMessage["intent"]; gatePaused: boolean } | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly bound: Array<[keyof HTMLMediaElementEventMap, EventListener]> = [];
  private ttBound: EventListener | null = null;

  constructor(private readonly v: HTMLVideoElement) {}

  start(): void {
    const on = (name: keyof HTMLMediaElementEventMap, fn: EventListener) => {
      this.v.addEventListener(name, fn);
      this.bound.push([name, fn]);
    };
    on("waiting", () => this.armStall());
    on("stalled", () => this.armStall());
    on("playing", () => this.recover());
    on("canplay", () => this.recover());
    on("loadeddata", () => this.recover());
    on("seeked", () => this.recover());
    on("ended", () => this.onEnded());
    on("error", () => {
      this.state = "failed";
      this.emit();
    });
    // In-band tracks (HLS / fragmented mp4) arrive asynchronously — surface them
    // as they appear so the panel can list them under "From this site".
    const notify = () => this.onTextTracksChanged();
    this.v.textTracks.addEventListener("addtrack", notify);
    this.v.textTracks.addEventListener("removetrack", notify);
    this.ttBound = notify;
    this.poll = setInterval(() => this.tick(), STATUS_REPORT_MS);
  }

  /** Enforce the latest server truth on the video (SPEC §4). One-way. */
  apply(sync: SyncMessage, gate: GateMessage): void {
    const v = this.v;
    const shouldPlay = sync.intent === "playing" && !gate.paused;
    this.last = { intent: sync.intent, gatePaused: gate.paused };

    const baseRate = Number.isFinite(sync.rate) && sync.rate > 0 ? sync.rate : 1;
    const signed = v.currentTime - sync.time; // + = video ahead of the server
    const drift = Math.abs(signed);

    // The server marks real commands (play/pause/seek/join) `force`; heartbeats
    // are `force:false`.
    //   • force        → snap precisely to where it moved.
    //   • solo + tick  → leave it alone (the video just plays).
    //   • multi + tick → glide back via a small playbackRate nudge; hard-seek
    //     only for a big desync. Hard-seeking small drift mid-playback is the
    //     black-screen jitter — slewing the rate is invisible.
    let targetRate = baseRate;
    let snapTo: number | null = null;
    if (sync.force) {
      if (drift > 0.25) snapTo = sync.time;
    } else if (!this.solo) {
      if (drift > HARD_SEEK) snapTo = sync.time;
      else if (drift > NUDGE_ZONE) {
        // ahead → play a touch slower (<1); behind → a touch faster (>1).
        const frac = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, -signed * NUDGE_GAIN));
        targetRate = baseRate * (1 + frac);
      }
    }

    if (v.playbackRate !== targetRate) v.playbackRate = targetRate;
    if (snapTo !== null) {
      this.onSeek(v.currentTime, snapTo);
      this.selfSeekAt = performance.now();
      v.currentTime = snapTo;
    }

    if (shouldPlay && v.paused) {
      v.play().catch(() => this.markStalled()); // autoplay blocked → gate holds
    } else if (!shouldPlay && !v.paused) {
      v.pause();
    }
  }

  private emit(): void {
    const dur = Number.isFinite(this.v.duration) ? this.v.duration : 0;
    this.onStatus(this.state, this.v.currentTime, dur);
  }

  private shouldBePlaying(): boolean {
    return Boolean(this.last && this.last.intent === "playing" && !this.last.gatePaused);
  }

  private recover(): void {
    this.clearStall();
    if (this.state === "failed") return;
    if (this.v.readyState >= 3 && this.state !== "ready") {
      this.state = "ready";
      this.emit();
    }
  }

  private armStall(): void {
    if (this.stallTimer) return;
    if (performance.now() - this.selfSeekAt < SELF_SEEK_QUIET_MS) return;
    if (!this.shouldBePlaying()) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.v.readyState < 3 && this.shouldBePlaying()) this.markStalled();
    }, STALL_DEBOUNCE_MS);
  }

  private clearStall(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private markStalled(): void {
    if (this.state === "stalled" || this.state === "failed") return;
    this.state = "stalled";
    this.emit();
  }

  private tick(): void {
    const v = this.v;
    if (this.state !== "failed") {
      const advancing = v.currentTime > this.lastTickTime + 0.01;
      if (this.shouldBePlaying()) {
        if (advancing || v.readyState >= 3) {
          this.clearStall();
          if (this.state !== "ready") this.state = "ready";
        } else {
          this.armStall();
        }
      } else {
        this.clearStall();
        if (v.readyState >= 3 && this.state === "stalled") this.state = "ready";
      }
    }
    this.lastTickTime = v.currentTime;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    this.onStatus(this.state, v.currentTime, dur);
  }

  /** Current position (for the subtitle overlay). */
  currentTime(): number {
    return this.v.currentTime;
  }

  // ── embedded caption tracks (the element's own subtitles, §13) ──────────────
  // Same-origin, so we read cues directly — no bridge. Mirrors VideoHook's logic.

  /** The element's subtitle/caption text tracks. */
  getTextTracks(): TrackInfo[] {
    const out: TrackInfo[] = [];
    const tt = this.v.textTracks;
    for (let i = 0; i < tt.length; i++) {
      const t = tt[i];
      if (!t) continue;
      if (t.kind && t.kind !== "subtitles" && t.kind !== "captions") continue;
      out.push({
        id: String(i),
        label: t.label || t.language || `Track ${i + 1}`,
        language: t.language || "",
      });
    }
    return out;
  }

  /** Turn off every embedded track (so a native-rendered one doesn't show under
   *  an uploaded/searched sub). */
  disableTextTracks(): void {
    const tt = this.v.textTracks;
    for (let i = 0; i < tt.length; i++) {
      const t = tt[i];
      if (t) t.mode = "disabled";
    }
  }

  /**
   * Select an embedded track: set it `hidden` (loads cues without native
   * rendering) and read the cues so OUR overlay draws them (offset/style apply).
   * If the cues can't be read, fall back to native rendering (`showing`) and
   * report null.
   */
  useTextTrack(id: string | null, onCues: (cues: SubtitleCue[] | null) => void): void {
    const tt = this.v.textTracks;
    for (let i = 0; i < tt.length; i++) {
      const t = tt[i];
      if (t) t.mode = "disabled";
    }
    if (id === null) {
      onCues(null);
      return;
    }
    const track = tt[Number(id)];
    if (!track) {
      onCues(null);
      return;
    }
    track.mode = "hidden";
    let tries = 0;
    const read = () => {
      if (this.v.textTracks[Number(id)] !== track) return; // track list changed
      const cues = track.cues;
      if (cues?.length) {
        const arr: SubtitleCue[] = [];
        for (let i = 0; i < cues.length; i++) {
          const c = cues[i] as VTTCue;
          arr.push({
            start: c.startTime,
            end: c.endTime,
            text: (c.text || "").replace(/<[^>]+>/g, ""),
          });
        }
        onCues(arr);
      } else if (tries++ < 30) {
        setTimeout(read, 100);
      } else {
        track.mode = "showing"; // can't read cues → let the player render natively
        onCues(null);
      }
    };
    read();
  }

  destroy(): void {
    this.clearStall();
    if (this.poll) clearInterval(this.poll);
    for (const [name, fn] of this.bound) this.v.removeEventListener(name, fn);
    this.bound.length = 0;
    if (this.ttBound) {
      this.v.textTracks.removeEventListener("addtrack", this.ttBound);
      this.v.textTracks.removeEventListener("removetrack", this.ttBound);
      this.ttBound = null;
    }
  }
}
