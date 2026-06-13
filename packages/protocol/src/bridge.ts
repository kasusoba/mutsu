/**
 * Bridge protocol — room page ↔ in-iframe content script (SPEC §4, §6).
 *
 * The room page (our origin) holds the WebSocket and the authoritative room
 * state, but it CANNOT script the cross-origin embed's `<video>` (same-origin
 * policy). The extension's content script, injected INTO that iframe, is the
 * only code that can. They talk over `window.postMessage`.
 *
 * Division of labour:
 *  - Page → frame: forward the latest server truth (`apply`) + overlay toggles.
 *  - Frame → page: report whether a video is hooked, its readiness `status`,
 *    and any LOCAL user control (when the escape hatch exposes native UI), which
 *    the page then relays to the server as a `control`.
 *
 * The actual drift-correction algorithm (SPEC §4) runs in the content script,
 * because it's the only side that can read/write `video.currentTime`.
 *
 * Still "move the URL and the clock, never the bytes": these messages carry
 * positions and intents, never media.
 */

import type { Intent } from "./index.ts";

/** Tag on every bridge message so each side can ignore unrelated postMessages. */
export const BRIDGE_TAG = "sixseven-bridge" as const;
export const BRIDGE_VERSION = 1 as const;

/** How often the content script reports the video's position upward (ms). */
export const STATUS_REPORT_MS = 1000;

// ── page → frame ────────────────────────────────────────────────────────────

/** Handshake: page announces itself and asks the frame to hook a `<video>`. */
export interface HelloMessage {
  kind: "hello";
}

/**
 * The current server truth to enforce on the `<video>`. The content script runs
 * the SPEC §4 algorithm against this: (re)load `src`, set `rate`, seek if drift
 * exceeds the threshold, and play iff `intent==='playing' && !gatePaused`.
 */
export interface ApplyMessage {
  kind: "apply";
  src: string | null;
  intent: Intent;
  time: number;
  rate: number;
  /** Soft buffer gate (SPEC §9): when true, hold playback even if intent plays. */
  gatePaused: boolean;
  /** Real command (snap) vs heartbeat/presence tick (gentle correct only). */
  force: boolean;
  /** Alone in the room → don't force realtime, just let it play. */
  solo: boolean;
}

/** Escape hatch (SPEC §12): reveal/hide the native site UI under the overlay. */
export interface OverlayMessage {
  kind: "overlay";
  /** false = "show site" (lift the takeover so the user can click native UI). */
  takeover: boolean;
}

/** A single subtitle cue, times in seconds against the video clock. */
export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export type SubtitlePosition = "bottom" | "top";

/** Personal subtitle appearance + sync (SPEC §13) — per-viewer, never synced. */
export interface SubtitleStyle {
  /** Sync offset in ms: positive = show cues later, negative = earlier. */
  offsetMs: number;
  position: SubtitlePosition;
  /** Distance from the chosen edge, as a % of viewport height. */
  marginPct: number;
  /** Font size as a percentage of the default. */
  sizePct: number;
  color: string;
  /** Background box opacity, 0–1. */
  background: number;
  /** Text opacity, 0–1. */
  opacity: number;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  offsetMs: 0,
  position: "bottom",
  marginPct: 8,
  sizePct: 100,
  color: "#ffffff",
  background: 0.5,
  opacity: 1,
};

/** Load (or clear, with null) this viewer's personal subtitle track. */
export interface SetSubtitlesMessage {
  kind: "setSubtitles";
  cues: SubtitleCue[] | null;
}

/** Update this viewer's subtitle appearance/offset. */
export interface SetSubtitleStyleMessage {
  kind: "setSubtitleStyle";
  style: SubtitleStyle;
}

/** Hide/show our in-iframe UI (badge + subtitle layer) — "use the site's own
 *  player" escape hatch (SPEC §12). Sync still runs; we just stop drawing. */
export interface SetHiddenMessage {
  kind: "setHidden";
  hidden: boolean;
}

/** A text track exposed by the source's own `<video>` (its built-in captions). */
export interface TrackInfo {
  /** Index into `video.textTracks` (opaque string id). */
  id: string;
  label: string;
  language: string;
}

/** Select one of the frame video's embedded caption tracks — read its cues into
 *  our overlay (or null to turn embedded captions off). §13. */
export interface SelectTrackMessage {
  kind: "selectTrack";
  trackId: string | null;
}

export type PageToFrameMessage =
  | HelloMessage
  | ApplyMessage
  | OverlayMessage
  | SetSubtitlesMessage
  | SetSubtitleStyleMessage
  | SetHiddenMessage
  | SelectTrackMessage;

// ── frame → page ────────────────────────────────────────────────────────────

/** Frame acknowledges the handshake. */
export interface ReadyMessage {
  kind: "ready";
}

/**
 * Hook state: whether the content script currently has a `<video>` bound.
 * Drives the page's failed/loading distinction (SPEC §9) when no video appears.
 */
export interface HookedMessage {
  kind: "hooked";
  found: boolean;
}

/** Readiness + current position, reported on events and every STATUS_REPORT_MS. */
export interface FrameStatusMessage {
  kind: "status";
  state: "loading" | "ready" | "stalled" | "failed";
  currentTime: number;
  /** Video duration in seconds (0 until known) — drives the page scrubber. */
  duration: number;
}

/**
 * A LOCAL user action on the native player (only reachable via the escape
 * hatch). The page relays this to the server as a `control` so the room follows.
 */
export interface LocalControlMessage {
  kind: "localControl";
  intent: Intent;
  time: number;
}

/** The hooked video reached its end — drives playlist auto-advance (§16). */
export interface EndedMessage {
  kind: "ended";
}

/** The frame's video exposes these embedded caption tracks (§13). Reported on
 *  hook + when the track list changes, so the page can offer them in the picker. */
export interface TracksMessage {
  kind: "tracks";
  tracks: TrackInfo[];
}

export type FrameToPageMessage =
  | ReadyMessage
  | HookedMessage
  | FrameStatusMessage
  | LocalControlMessage
  | EndedMessage
  | TracksMessage;

// ── envelope + helpers ──────────────────────────────────────────────────────

export interface BridgeEnvelope<T> {
  tag: typeof BRIDGE_TAG;
  v: typeof BRIDGE_VERSION;
  msg: T;
}

export function wrap<T extends PageToFrameMessage | FrameToPageMessage>(msg: T): BridgeEnvelope<T> {
  return { tag: BRIDGE_TAG, v: BRIDGE_VERSION, msg };
}

/** Validate + unwrap an incoming postMessage payload; null if it isn't ours. */
export function unwrap<T>(data: unknown): T | null {
  if (!data || typeof data !== "object") return null;
  const env = data as Partial<BridgeEnvelope<T>>;
  if (env.tag !== BRIDGE_TAG || env.v !== BRIDGE_VERSION || !env.msg) return null;
  return env.msg;
}
