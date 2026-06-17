/**
 * Room identity from the URL (SPEC §10): id in the path, secret in the
 * fragment so it's never sent in HTTP requests or logged.
 *   /r/<name>#k=<secret>
 * Nickname is local-only (SPEC §11), kept in localStorage.
 */

export interface RoomLocation {
  room: string;
  secret: string | null;
  /** Optional source to auto-set once joined (`?src=…&kind=…`) — used when the
   *  extension popup creates a room pre-loaded with a picked video (§12). */
  initialSrc?: string;
  initialKind?: string;
}

export function readRoomLocation(): RoomLocation {
  const path = window.location.pathname.replace(/^\/+/, "");
  const m = path.match(/^r\/([^/]+)/);
  const room = m?.[1] ? decodeURIComponent(m[1]) : "";

  let secret: string | null = null;
  const frag = window.location.hash.replace(/^#/, "");
  for (const part of frag.split("&")) {
    const [k, v] = part.split("=");
    if (k === "k" && v) secret = decodeURIComponent(v);
  }

  const q = new URLSearchParams(window.location.search);
  const initialSrc = q.get("src") ?? undefined;
  const initialKind = q.get("kind") ?? undefined;
  return { room, secret, initialSrc, initialKind };
}

/** A URL-safe capability secret (SPEC §10) — goes in the `#k=` fragment. */
export function makeSecret(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const ROOM_ADJ = ["cosy", "late", "rainy", "neon", "velvet", "amber", "quiet", "lucky"];
const ROOM_NOUN = ["sofa", "lounge", "den", "balcony", "cinema", "loft", "patio", "booth"];

/** A friendly default room name (the creator can override it). */
export function makeRoomName(): string {
  const buf = new Uint8Array(3);
  crypto.getRandomValues(buf);
  const adj = ROOM_ADJ[(buf[0] ?? 0) % ROOM_ADJ.length] ?? "cosy";
  const noun = ROOM_NOUN[(buf[1] ?? 0) % ROOM_NOUN.length] ?? "lounge";
  const n = 10 + ((buf[2] ?? 0) % 90);
  return `${adj}-${noun}-${n}`;
}

/** Normalise a user-typed room name into a URL-safe slug. */
export function slugifyRoom(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Build the capability URL for a room + secret (`/r/<name>#k=<secret>`). */
export function roomUrl(room: string, secret: string): string {
  return `/r/${encodeURIComponent(room)}#k=${encodeURIComponent(secret)}`;
}

const NICK_KEY = "sixseven:nick";

export function loadNickname(): string {
  try {
    return localStorage.getItem(NICK_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveNickname(nick: string): void {
  try {
    localStorage.setItem(NICK_KEY, nick);
  } catch {
    // private mode / disabled storage — non-fatal.
  }
}
