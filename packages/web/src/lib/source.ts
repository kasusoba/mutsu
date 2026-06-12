/**
 * Normalize whatever the user pastes into a real source URL.
 * Accepts a bare URL or a full `<iframe …>` embed snippet (we pull out `src`).
 * Rejects non-URLs and our own origin (pasting our app would recurse into the
 * room page — SPEC §4 embeds a *source*, not ourselves).
 */

import type { SourceKind } from "@sixseven/protocol";

export interface SourceResult {
  url?: string;
  error?: string;
}

const FILE_EXT = /\.(m3u8|mp4|webm|ogg|ogv|mov|m4v|mp3|m4a|aac|flac|wav)(\?|#|$)/i;

/** True if the URL path looks like an HLS playlist. */
export function isHlsUrl(url: string): boolean {
  try {
    return /\.m3u8(\?|#|$)/i.test(new URL(url).pathname + new URL(url).search);
  } catch {
    return /\.m3u8(\?|#|$)/i.test(url);
  }
}

/**
 * Best-effort auto-classification of a source URL (SPEC §15 P4). A recognizable
 * media file / HLS playlist → `direct` (our `<video>` player); anything else →
 * `embed` (framed page). Tokenized stream URLs without a file extension look
 * like `embed` here — the user can override to `direct` in the source picker.
 */
export function classifySource(url: string): SourceKind {
  try {
    const u = new URL(url);
    return FILE_EXT.test(u.pathname) ? "direct" : "embed";
  } catch {
    return "embed";
  }
}

export function extractSourceUrl(input: string): SourceResult {
  const raw = input.trim();
  if (!raw) return { error: "Enter a URL." };

  let candidate = raw;
  // Full embed snippet pasted? Pull the src attribute out.
  if (/<iframe/i.test(raw)) {
    const m = raw.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!m?.[1]) return { error: "Couldn't find a src= in that embed code." };
    candidate = m[1];
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: "That doesn't look like a full URL (needs https://…)." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "Only http(s) sources are supported." };
  }
  if (parsed.origin === window.location.origin) {
    return { error: "That's this app's own URL — paste the video/embed source instead." };
  }
  return { url: parsed.toString() };
}
