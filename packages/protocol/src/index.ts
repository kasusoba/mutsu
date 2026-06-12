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
}

/** Privileged (control-mode gated): pick the source everyone embeds (SPEC §12). */
export interface SetSourceMessage {
  type: "setSource";
  src: string;
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

export type ClientMessage =
  | JoinMessage
  | SetSourceMessage
  | ControlMessage
  | SetModeMessage
  | PassControlMessage
  | StatusMessage
  | SkipMessage
  | ResyncMessage;

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
  intent: Intent;
  time: number;
  rate: number;
  mode: Mode;
  hostId: MemberId | null;
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

export type ServerMessage =
  | WelcomeMessage
  | SyncMessage
  | MembersMessage
  | LogMessage
  | GateMessage
  | ErrorMessage;

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Drift threshold (s) — don't seek under this to avoid stutter (SPEC §7). */
export const DRIFT_THRESHOLD = 0.5;

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
