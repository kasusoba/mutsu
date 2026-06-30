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

// Witty, IP-free watch-party room names. Three sentence shapes are mixed for
// variety (~1.3k slug-safe combos): "verb-the-object", "adj-subject-crowd",
// and "gerund-adverb". Keep every entry lowercase + hyphen-safe (slugifyRoom
// would mangle anything else). The creator can always override the name.
const RN_VERB = [
  "summon",
  "pause",
  "queue",
  "befriend",
  "cancel",
  "heckle",
  "ignore",
  "bribe",
  "defend",
  "interrogate",
  "negotiate",
  "resurrect",
  "reschedule",
  "fistfight",
];
const RN_OBJECT = [
  "the-popcorn",
  "the-snacks",
  "the-remote",
  "the-couch",
  "the-plot",
  "the-credits",
  "the-villain",
  "the-subtitles",
  "the-group-chat",
  "the-spoilers",
  "the-buffering",
  "the-intermission",
  "the-cliffhanger",
];
const RN_ADJ = [
  "feral",
  "sleepy",
  "unhinged",
  "crispy",
  "cursed",
  "emotional",
  "certified",
  "nocturnal",
  "chaotic",
  "cozy",
  "caffeinated",
  "mildly-feral",
  "sentimental",
];
const RN_SUBJECT = ["movie", "popcorn", "couch", "snack", "plot", "gremlin", "subtitle", "rewatch"];
const RN_CROWD = [
  "gremlins",
  "goblins",
  "enjoyers",
  "watchers",
  "critics",
  "agents",
  "raccoons",
  "nerds",
  "goblin-mode-watchers",
];
const RN_GERUND = [
  "buffering",
  "plotting",
  "snacking",
  "vibing",
  "rewatching",
  "crying",
  "narrating",
  "theorizing",
  "spoiling",
  "binging",
  "emoting",
  "pausing",
];
const RN_ADVERB = [
  "emotionally",
  "aggressively",
  "illegally",
  "quietly",
  "again",
  "professionally",
  "at-3am",
  "unprompted",
  "with-snacks",
  "in-the-dark",
  "together",
  "ironically",
];

const RN_BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A friendly default room name (the creator can override it). A 2-char base36
 *  suffix (×1296) keeps independently-generated names from colliding into one
 *  room — the room name *is* the room id (TOFU secret), so a clash would bounce
 *  the second creator with a confusing "bad key" error (SPEC §10). */
export function makeRoomName(): string {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  const pick = (arr: string[], b: number | undefined) => arr[(b ?? 0) % arr.length] ?? arr[0] ?? "";
  const suffix = (RN_BASE36[(buf[4] ?? 0) % 36] ?? "0") + (RN_BASE36[(buf[5] ?? 0) % 36] ?? "0");
  let phrase: string;
  switch ((buf[0] ?? 0) % 3) {
    case 0:
      phrase = `${pick(RN_VERB, buf[1])}-${pick(RN_OBJECT, buf[2])}`;
      break;
    case 1:
      phrase = `${pick(RN_ADJ, buf[1])}-${pick(RN_SUBJECT, buf[2])}-${pick(RN_CROWD, buf[3])}`;
      break;
    default:
      phrase = `${pick(RN_GERUND, buf[1])}-${pick(RN_ADVERB, buf[2])}`;
  }
  return `${phrase}-${suffix}`;
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
