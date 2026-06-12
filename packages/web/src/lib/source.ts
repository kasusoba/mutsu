/**
 * Normalize whatever the user pastes into a real source URL.
 * Accepts a bare URL or a full `<iframe …>` embed snippet (we pull out `src`).
 * Rejects non-URLs and our own origin (pasting our app would recurse into the
 * room page — SPEC §4 embeds a *source*, not ourselves).
 */

export interface SourceResult {
  url?: string;
  error?: string;
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
