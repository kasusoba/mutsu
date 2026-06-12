/**
 * Room identity from the URL (SPEC §10): id in the path, secret in the
 * fragment so it's never sent in HTTP requests or logged.
 *   /r/<name>#k=<secret>
 * Nickname is local-only (SPEC §11), kept in localStorage.
 */

export interface RoomLocation {
  room: string;
  secret: string | null;
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
  return { room, secret };
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
