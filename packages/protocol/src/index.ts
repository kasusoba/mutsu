/**
 * sixseven sync protocol — shared message types (SPEC §7).
 *
 * The single source of truth for the wire contract between the room page,
 * the extension, and the PartyKit DO. Keep it small and JSON. Any new
 * message type must also be documented in docs/ARCHITECTURE.md.
 *
 * Guiding rule: "move the URL and the clock, never the bytes" — every message
 * here carries control/state, never media.
 */

export type MemberId = string;

/** Human playback intent (the "hard" state). Distinct from the soft buffer gate. */
export type Intent = "playing" | "paused";

/** Per-room control mode (SPEC §8). */
export type Mode = "open" | "host";

/**
 * Per-member readiness (SPEC §9).
 * - loading : iframe/source still coming up, no playable video yet
 * - ready   : has a playable video, in sync
 * - stalled : was playable but is buffering now (soft-pauses the room)
 * - failed  : never produced a playable video (dead server / geo-block / frame-bust)
 */
export type MemberStatus = "loading" | "ready" | "stalled" | "failed";

export interface Member {
  id: MemberId;
  name: string;
  status: MemberStatus;
}

/** Activity-log event kinds (SPEC §11) — meaningful events only, never play/pause/seek. */
export type LogKind =
  | "joined"
  | "left"
  | "setSource"
  | "played"
  | "paused"
  | "skipped"
  | "autoSkipped"
  | "tookControl"
  | "passedControl"
  | "modeChanged"
  | "hostPromoted";

export interface LogEvent {
  id: string;
  kind: LogKind;
  /** Member who caused the event, when applicable. */
  actor?: MemberId;
  /** Member the event is about (e.g. skipped/passedControl target). */
  target?: MemberId;
  /** Free-form detail (e.g. the new mode, or a source label). */
  detail?: string;
  /** SERVER clock (ms). */
  at: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Client → server
// ──────────────────────────────────────────────────────────────────────────

/** First message on a connection. Admission gated by the room secret (SPEC §10). */
export interface JoinMessage {
  type: "join";
  /** Capability secret from the URL fragment. null/"" attempts an open join. */
  secret: string | null;
  name: string;
  /**
   * Initial control mode, honoured ONLY when this join creates the room (the
   * first join, trust-on-first-use). Lets the creation flow pick `host` up front
   * (the creator becomes host). Ignored on every later/reconnect join — the room
   * already has a mode, changed live via `setMode`/`passControl` (SPEC §8).
   */
  mode?: Mode;
  /**
   * Observer join: receive room state (welcome/sync/members/gate/log) but DON'T
   * count as a presence member — no `members` entry, no joined/left log, never
   * holds the buffer gate, can't issue privileged actions. Used by the own-tab
   * popup to peek a room's current source before the user is on the source tab
   * (the real member is the source tab's content script). See ARCHITECTURE §11.
   */
  observer?: boolean;
}

/**
 * How a source is rendered (SPEC §15 P4 / own-tab §11):
 * - `embed`  : a framable page → loaded in an `<iframe>`, hooked by the extension.
 * - `direct` : a raw media URL (HLS `.m3u8` / a video file) → played in our own
 *   `<video>` (hls.js) on the room page. Content-neutral: it plays whatever URL
 *   it's given; it does NOT extract streams from pages or forge headers (§3).
 * - `site`   : own-tab mode (§11) — `src` is the PAGE URL where the video lives.
 *   No room page / iframe: each member opens that URL in their own tab and the
 *   extension hooks the site's native `<video>` there. The URL is metadata
 *   ("open this to watch"), not a stream — same "move the URL + clock" model.
 * - `youtube`: a YouTube video → driven on the room page via the YouTube IFrame
 *   Player API (no extension; YT exposes no raw `<video>` to hook). Same control
 *   model as `direct` — our control bar moves the clock.
 */
export type SourceKind = "embed" | "direct" | "site" | "youtube";

/** Privileged (control-mode gated): pick the source everyone loads (SPEC §12). */
export interface SetSourceMessage {
  type: "setSource";
  src: string;
  /** How to render `src`. Omitted ⇒ server defaults to `embed`. */
  kind?: SourceKind;
}

/** Play / pause / seek. `time` is the target position in seconds. */
export interface ControlMessage {
  type: "control";
  intent: Intent;
  time: number;
  /** Optional playback-rate change; omitted keeps the current rate. */
  rate?: number;
}

/** Privileged: switch control mode (SPEC §8). */
export interface SetModeMessage {
  type: "setMode";
  mode: Mode;
}

/** Host-only: hand the controller role to another member. */
export interface PassControlMessage {
  type: "passControl";
  toId: MemberId;
}

/** Report this member's readiness for the buffer gate (SPEC §9). */
export interface StatusMessage {
  type: "status";
  state: MemberStatus;
}

/** Privileged: drop a stalled/failed member from the gate (SPEC §9). */
export interface SkipMessage {
  type: "skip";
  memberId: MemberId;
}

/** Ask the server for a fresh snapshot (used on reconnect, SPEC §7). */
export interface ResyncMessage {
  type: "resync";
}

/** Ephemeral "fun layer" broadcast (§14): an emoji reaction or a chat line, or a
 *  GIF/image URL. The server fans it out to everyone and forgets it — never
 *  stored in room state (it's not playback truth). `text` is the emoji, the chat
 *  body, or the media URL depending on `kind`. */
export type SayKind = "reaction" | "chat" | "gif";
export interface SayMessage {
  type: "say";
  kind: SayKind;
  text: string;
}

export type ClientMessage =
  | JoinMessage
  | SetSourceMessage
  | ControlMessage
  | SetModeMessage
  | PassControlMessage
  | StatusMessage
  | SkipMessage
  | ResyncMessage
  | SayMessage;

// ──────────────────────────────────────────────────────────────────────────
// Server → client
// ──────────────────────────────────────────────────────────────────────────

/** Admission result + this connection's own member id. */
export interface WelcomeMessage {
  type: "welcome";
  self: MemberId;
}

/**
 * Authoritative playback state. `time` is already projected to "now" by the
 * server's single clock (SPEC §7) — the client treats it as "where you should
 * be right now" and never does cross-clock math.
 */
export interface SyncMessage {
  type: "sync";
  src: string | null;
  /** How the client should render `src` (SPEC §15 P4). */
  srcKind: SourceKind;
  intent: Intent;
  time: number;
  rate: number;
  mode: Mode;
  hostId: MemberId | null;
  /**
   * True when this sync is a real **command** (play/pause/seek/setSource/join/
   * resync/correct) the client must snap to. False for a routine **heartbeat**
   * tick. A solo viewer ignores heartbeat drift (only honors commands) so it's
   * never yanked to realtime mid-playback; multi-viewers still drift-correct on
   * heartbeats to stay aligned.
   */
  force: boolean;
}

/** Full presence list (SPEC §11). */
export interface MembersMessage {
  type: "members";
  list: Member[];
}

/** A single appended activity-log event. */
export interface LogMessage {
  type: "log";
  event: LogEvent;
}

/**
 * Soft buffer gate (SPEC §9). `paused === true` means the room is soft-paused
 * waiting for `waitingFor`. This is independent of `SyncMessage.intent`; the
 * client plays only when intent==='playing' AND gate paused===false.
 */
export interface GateMessage {
  type: "gate";
  paused: boolean;
  waitingFor: MemberId[];
}

/** Connection refused or an action rejected. */
export interface ErrorMessage {
  type: "error";
  code: "unauthorized" | "not_admitted" | "forbidden" | "bad_message";
  message: string;
}

/** A fanned-out ephemeral fun-layer event (§14) — reaction/chat/gif. Carries the
 *  sender so clients can label it without a member lookup. Never persisted. */
export interface EventMessage {
  type: "event";
  kind: SayKind;
  text: string;
  from: MemberId;
  name: string;
  at: number;
}

export type ServerMessage =
  | WelcomeMessage
  | SyncMessage
  | MembersMessage
  | LogMessage
  | GateMessage
  | ErrorMessage
  | EventMessage;

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Drift threshold (s) — the "in sync" notion / echo-match tolerance (SPEC §7). */
export const DRIFT_THRESHOLD = 0.5;

/**
 * Seek dead-zone (s): a client hard-seeks to re-sync only when off by more than
 * this. Real players wander a few hundred ms while buffering; correcting at the
 * tight `DRIFT_THRESHOLD` every heartbeat caused visible jitter. Shared by the
 * extension content script and the room-page direct player.
 */
export const SEEK_DEADZONE = 1.0;

/** Heartbeat interval (ms) while playing (SPEC §7). */
export const HEARTBEAT_MS = 3000;

/** Grace before a stalled/failed member is auto-skipped (ms) (SPEC §9). */
export const SKIP_GRACE_MS = 25_000;

export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const v = JSON.parse(raw) as { type?: unknown };
    if (v && typeof v.type === "string") return v as ClientMessage;
    return null;
  } catch {
    return null;
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const v = JSON.parse(raw) as { type?: unknown };
    if (v && typeof v.type === "string") return v as ServerMessage;
    return null;
  } catch {
    return null;
  }
}
