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
import { STATUS_REPORT_MS, type SubtitleCue, type TrackInfo } from "@sixseven/protocol/bridge";

export type { TrackInfo };

/**
 * Diagnostic logging. Flip to `true`, rebuild, fully reload the room tab, and
 * watch the page console: every line is prefixed `[6seven]`. It shows who moves
 * the clock — `apply` seeks are ours; an `EMBED moved clock` line means the
 * source's own player jumped (not us). Leave `false` in normal use.
 */
const DEBUG = false;
const dbg = (...a: unknown[]) => {
  if (DEBUG) console.log("[6seven]", ...a);
};

type State = "loading" | "ready" | "stalled" | "failed";

/** A real stall must persist this long before we gate the room (avoids blips). */
const STALL_DEBOUNCE_MS = 700;
/** Ignore `readyState` dips for this long after our own seek (seeking dips it). */
const SELF_SEEK_QUIET_MS = 1000;
/** Coalesce DOM-mutation re-hook checks so a churny embed can't thrash the hook. */
const REHOOK_DEBOUNCE_MS = 400;
/** A native play/pause/seek within this long of a user gesture is a real user
 *  action (worth syncing); without a recent gesture it's the embed buffering. */
const GESTURE_WINDOW_MS = 700;
// Multi-viewer drift correction (heartbeat ticks): glide via a small playbackRate
// slew instead of a hard seek (the black-screen jump). Mirrors WebPlayer.
const NUDGE_ZONE = 0.4;
const HARD_SEEK = 3.0;
const MAX_NUDGE = 0.08;
const NUDGE_GAIN = 0.06;

interface ApplyState {
  intent: Intent;
  time: number;
  rate: number;
  gatePaused: boolean;
  /** Real command (snap) vs heartbeat/presence tick (gentle correct only). */
  force: boolean;
  /** Alone in the room → don't force realtime, just let it play. */
  solo: boolean;
}

export class VideoHook {
  onStatus: (state: State, currentTime: number, duration: number) => void = () => {};
  onHookChange: (found: boolean) => void = () => {};
  onLocalControl: (intent: Intent, time: number) => void = () => {};
  /** Fired when the hooked video reaches its end (playlist auto-advance, §16). */
  onEnded: () => void = () => {};
  /** Fired when the hooked video's embedded text-track list changes. */
  onTextTracksChanged: () => void = () => {};
  private trackCleanup: (() => void) | null = null;

  /** Set by the entrypoint from overlay state: forward native UI actions? */
  allowLocalControl = false;

  private video: HTMLVideoElement | null = null;
  private last: ApplyState | null = null;
  private state: State = "loading";
  /** performance.now() of the last user gesture in this frame (click/key). */
  private lastGestureAt = 0;
  private readonly gestureBound: Array<[string, EventListener]> = [];
  /** True while we are the ones mutating the video (suppresses echo events). */
  private applying = false;
  // Self-mutation bookkeeping: we consume the specific echo events our own
  // `apply()` causes, instead of trusting a fixed timer. A `seeked`/`play`/
  // `pause` that matches one of these is OURS, not the user — never report it.
  private expectPlay = false;
  private expectPause = false;
  private expectSeek: number | null = null;
  /** performance.now() of our last self-seek — readyState dips right after are expected. */
  private selfSeekAt = 0;
  /** Debounce timer before we tell the room we've stalled (avoids gating on blips). */
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** Video position at the previous tick, to detect whether playback is advancing. */
  private lastTickTime = -1;
  private observer: MutationObserver | null = null;
  private rehookPending = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly boundEvents: Array<[keyof HTMLMediaElementEventMap, EventListener]> = [];

  start(): void {
    this.hook();
    // STICKY + debounced. Churny embeds (popcornmovies/HLS) mutate the DOM
    // constantly; the old check re-ran findBest() on every mutation and switched
    // the hooked <video> whenever another element momentarily looked "better",
    // re-applying (and seeking) each time — jitter that only happens inside the
    // room. Now we keep a working video and only (re)hook when ours is actually
    // gone/ended, and at most a few times a second.
    this.observer = new MutationObserver(() => {
      if (this.rehookPending) return;
      this.rehookPending = true;
      setTimeout(() => {
        this.rehookPending = false;
        if (!this.video || !this.video.isConnected || this.video.ended) this.hook();
      }, REHOOK_DEBOUNCE_MS);
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });

    // Track user gestures in this frame so a native play/pause/seek can be told
    // apart from the embed's own buffering events (capture phase, passive).
    const mark = () => {
      this.lastGestureAt = performance.now();
    };
    for (const ev of ["pointerdown", "pointerup", "keydown"]) {
      document.addEventListener(ev, mark, { capture: true, passive: true });
      this.gestureBound.push([ev, mark]);
    }

    this.poll = setInterval(() => this.tick(), STATUS_REPORT_MS);
  }

  /** Did the user interact with this frame in the last GESTURE_WINDOW_MS? */
  private userActedRecently(): boolean {
    return performance.now() - this.lastGestureAt < GESTURE_WINDOW_MS;
  }

  /** Current position of the hooked video, or null if none (for the subtitle layer). */
  currentTime(): number | null {
    return this.video?.currentTime ?? null;
  }

  /** The hooked video's on-screen rect, so the subtitle layer can sit OVER the
   *  video (not the whole page) when it's just one element on a normal site. */
  videoRect(): DOMRect | null {
    return this.video?.getBoundingClientRect() ?? null;
  }

  // ── embedded caption tracks (the source's own subtitles) ────────────────────

  /** The hooked video's subtitle/caption text tracks. */
  getTextTracks(): TrackInfo[] {
    const v = this.video;
    if (!v) return [];
    const out: TrackInfo[] = [];
    const tt = v.textTracks;
    for (let i = 0; i < tt.length; i++) {
      const t = tt[i];
      if (!t) continue;
      if (t.kind && t.kind !== "subtitles" && t.kind !== "captions") continue;
      out.push({ id: String(i), label: t.label || t.language || `Track ${i + 1}`, language: t.language || "" });
    }
    return out;
  }

  /** Turn off every embedded track (e.g. when switching to an uploaded sub, so a
   *  native-rendered track doesn't show on top of our overlay). */
  disableTextTracks(): void {
    const v = this.video;
    if (!v) return;
    for (let i = 0; i < v.textTracks.length; i++) {
      const t = v.textTracks[i];
      if (t) t.mode = "disabled";
    }
  }

  /**
   * Select an embedded track. We set it `hidden` (loads cues without native
   * rendering) and read the cues so OUR overlay renders them (offset/style apply).
   * If the cues can't be read — cross-origin track without CORS, or none load —
   * fall back to the player's native rendering (`showing`) and report null.
   */
  useTextTrack(id: string | null, onCues: (cues: SubtitleCue[] | null) => void): void {
    const v = this.video;
    if (!v) return onCues(null);
    const tt = v.textTracks;
    for (let i = 0; i < tt.length; i++) {
      const t = tt[i];
      if (t) t.mode = "disabled";
    }
    if (id === null) return onCues(null);
    const track = tt[Number(id)];
    if (!track) return onCues(null);
    track.mode = "hidden";
    let tries = 0;
    const read = () => {
      // Bail if the video swapped out from under us.
      if (!this.video || this.video.textTracks[Number(id)] !== track) return;
      const cues = track.cues;
      if (cues && cues.length) {
        const arr: SubtitleCue[] = [];
        for (let i = 0; i < cues.length; i++) {
          const c = cues[i] as VTTCue;
          arr.push({ start: c.startTime, end: c.endTime, text: (c.text || "").replace(/<[^>]+>/g, "") });
        }
        onCues(arr);
      } else if (tries++ < 30) {
        setTimeout(read, 100);
      } else {
        track.mode = "showing"; // can't read cues → let the site render natively
        onCues(null);
      }
    };
    read();
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

    // Same drift model as the direct WebPlayer: a `force` sync (command) snaps;
    // a heartbeat tick leaves a solo viewer alone and glides a multi viewer back
    // via a small playbackRate slew, hard-seeking only for a big desync. We flag
    // any seek BEFORE issuing it so the async `seeked` echo is consumed (not
    // misread as a user scrub).
    const baseRate = Number.isFinite(s.rate) && s.rate > 0 ? s.rate : 1;
    const signed = v.currentTime - s.time; // + = video ahead of the server
    const drift = Math.abs(signed);
    let targetRate = baseRate;
    let snapTo: number | null = null;
    if (s.force) {
      if (drift > 0.25) snapTo = s.time;
    } else if (!s.solo) {
      if (drift > HARD_SEEK) snapTo = s.time;
      else if (drift > NUDGE_ZONE) {
        const frac = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, -signed * NUDGE_GAIN));
        targetRate = baseRate * (1 + frac);
      }
    }
    if (v.playbackRate !== targetRate) v.playbackRate = targetRate;
    if (snapTo !== null) {
      dbg(`apply SEEK ${v.currentTime.toFixed(2)}→${snapTo.toFixed(2)} (drift ${signed.toFixed(2)})`);
      this.expectSeek = snapTo;
      this.selfSeekAt = performance.now();
      v.currentTime = snapTo;
    }
    const shouldPlay = s.intent === "playing" && !s.gatePaused;
    if (shouldPlay && v.paused) {
      this.expectPlay = true;
      v.play().catch(() => {
        this.expectPlay = false;
        this.markStalled(); // autoplay blocked → gate holds until a gesture
      });
    } else if (!shouldPlay && !v.paused) {
      this.expectPause = true;
      v.pause();
    }
    // `applying` only covers the synchronous burst; the async echoes are caught
    // by the expect-flags above (which fire whenever the events actually land).
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

    dbg(
      `(re)HOOK ${this.video ? "switching" : "first"} video` +
        ` (total <video> on page: ${document.querySelectorAll("video").length})`,
    );
    if (this.video) this.detach(this.video);
    this.video = next;
    this.onHookChange(Boolean(next));

    if (next) {
      this.attach(next);
      this.lastTickTime = -1;
      // Re-assert the last known server state onto the fresh element.
      if (this.last) this.apply(this.last);
      this.refreshReady();
    }
  }

  private attach(v: HTMLVideoElement): void {
    const on = (name: keyof HTMLMediaElementEventMap, fn: EventListener) => {
      v.addEventListener(name, fn);
      this.boundEvents.push([name, fn]);
    };
    on("waiting", () => this.armStall());
    on("stalled", () => this.armStall());
    on("playing", () => this.recover());
    on("canplay", () => this.recover());
    on("loadeddata", () => this.recover());
    on("error", () => {
      this.state = "failed";
      this.emit();
    });
    // Native-player control IS supported, but only as a real USER action: we
    // report a native play/pause/seek only if it follows a user gesture in this
    // frame. An embed (a foreign player) also fires these for its OWN reasons —
    // buffering, quality switches, reacting to our sync — and reporting THOSE as
    // commands makes the server `force` everyone to snap, which yanks the embed
    // and feeds back as jitter. The gesture check keeps user clicks, drops noise.
    on("play", () => {
      if (this.expectPlay) {
        this.expectPlay = false;
        return;
      }
      if (this.userActedRecently()) this.maybeLocalIntent("playing");
    });
    on("pause", () => {
      if (this.expectPause) {
        this.expectPause = false;
        return;
      }
      if (this.userActedRecently()) this.maybeLocalIntent("paused");
    });
    on("seeked", () => {
      if (this.expectSeek != null && Math.abs(v.currentTime - this.expectSeek) <= DRIFT_THRESHOLD) {
        this.expectSeek = null;
        this.recover();
        return;
      }
      this.recover();
      // A user scrub on the native scrubber → relay the new position.
      if (this.userActedRecently() && !this.applying) {
        this.onLocalControl(v.paused ? "paused" : "playing", v.currentTime);
      }
    });

    on("ended", () => this.onEnded());

    // Watch the embedded caption-track list (players add tracks asynchronously).
    const tt = v.textTracks;
    const notify = () => this.onTextTracksChanged();
    tt.addEventListener("addtrack", notify);
    tt.addEventListener("removetrack", notify);
    this.trackCleanup = () => {
      tt.removeEventListener("addtrack", notify);
      tt.removeEventListener("removetrack", notify);
    };
    notify();
  }

  private detach(v: HTMLVideoElement): void {
    for (const [name, fn] of this.boundEvents) v.removeEventListener(name, fn);
    this.boundEvents.length = 0;
    this.trackCleanup?.();
    this.trackCleanup = null;
    this.clearStall();
    this.expectPlay = this.expectPause = false;
    this.expectSeek = null;
  }

  private maybeLocalIntent(intent: Intent): void {
    if (this.applying || !this.allowLocalControl || !this.video) return;
    // The video is already doing what the server told it to → not a user action,
    // just the player echoing our command. Reporting it would flip intent back
    // and forth forever (the play/pause flood).
    if (this.last && intent === this.last.intent) return;
    this.onLocalControl(intent, this.video.currentTime);
  }

  // ── status / buffer gate (SPEC §9) ──────────────────────────────────────────
  //
  // The gate must only trip on a REAL stall, never on a transient `readyState`
  // dip (HLS segment boundaries, or the dip our own seek causes). Otherwise a
  // solo viewer soft-pauses itself, and the resume re-seek shows up as jitter.
  // So: stalls are debounced and require playback to actually be stuck, and we
  // ignore dips right after a self-seek.

  private emit(): void {
    const v = this.video;
    if (!v) return;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    this.onStatus(this.state, v.currentTime, dur);
  }

  /** Is the room supposed to be playing right now (per the last server truth)? */
  private shouldBePlaying(): boolean {
    return Boolean(this.last && this.last.intent === "playing" && !this.last.gatePaused);
  }

  /** Set readiness straight from `readyState` (used on (re)hook). */
  private refreshReady(): void {
    const v = this.video;
    if (!v || this.state === "failed") return;
    this.state = v.readyState >= 3 ? "ready" : "loading";
  }

  /** A media event says we're playable again — clear any pending/active stall. */
  private recover(): void {
    this.clearStall();
    const v = this.video;
    if (!v || this.state === "failed") return;
    if (v.readyState >= 3 && this.state !== "ready") {
      this.state = "ready";
      this.emit();
    }
  }

  /** Begin (debounced) stall reporting — only if we're genuinely stuck. */
  private armStall(): void {
    if (this.stallTimer || !this.video) return;
    // A readyState dip in the moment after our own seek is expected, not a stall.
    if (performance.now() - this.selfSeekAt < SELF_SEEK_QUIET_MS) return;
    if (!this.shouldBePlaying()) return; // paused/gated: buffering is fine, don't gate
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      const v = this.video;
      // Still stuck after the grace? Then it's a real stall worth gating on.
      if (v && v.readyState < 3 && this.shouldBePlaying()) this.markStalled();
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
    const v = this.video;
    if (!v) {
      // Stay SILENT when there's no video — this frame may just be embed chrome
      // with the real player nested deeper. The page owns the failed-timeout, so
      // an empty frame must not report `failed` (it would fight the real one).
      this.hook();
      return;
    }
    // Detect a clock jump the embed made on its own (no `apply` seek): between
    // 1s ticks a playing video should advance ~1s. A big deviation = the source's
    // player moved the clock — the jitter is then theirs, not ours.
    if (this.lastTickTime >= 0 && performance.now() - this.selfSeekAt > SELF_SEEK_QUIET_MS) {
      const delta = v.currentTime - this.lastTickTime;
      const expected = this.shouldBePlaying() ? (STATUS_REPORT_MS / 1000) * (this.last?.rate ?? 1) : 0;
      if (Math.abs(delta - expected) > 0.5) {
        dbg(`EMBED moved clock between ticks: Δ${delta.toFixed(2)}s (expected ~${expected.toFixed(2)}s)`);
      }
    }
    if (this.state !== "failed") {
      const advancing = v.currentTime > this.lastTickTime + 0.01;
      if (this.shouldBePlaying()) {
        if (advancing || v.readyState >= 3) {
          this.clearStall();
          if (this.state !== "ready") this.state = "ready";
        } else {
          this.armStall(); // meant to play but not moving and under-buffered
        }
      } else {
        // Hard-paused or gated: not blocking. Don't gate on buffering; report
        // ready once we have data so the gate can release when we're caught up.
        this.clearStall();
        if (v.readyState >= 3 && this.state === "stalled") this.state = "ready";
      }
    }
    this.lastTickTime = v.currentTime;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    this.onStatus(this.state, v.currentTime, dur);
  }

  destroy(): void {
    this.observer?.disconnect();
    if (this.poll) clearInterval(this.poll);
    for (const [ev, fn] of this.gestureBound) document.removeEventListener(ev, fn, true);
    this.gestureBound.length = 0;
    this.clearStall();
    if (this.video) this.detach(this.video);
  }
}
