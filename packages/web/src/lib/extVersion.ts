/**
 * Extension presence + version, read off the `<html>` tag the content script sets.
 *
 * The attribute NAME stays `data-sixseven-ext` — it's part of the web↔extension
 * wire contract (renaming it would break compatibility with published builds).
 * Older builds set it to `"1"` (no version); 0.2.5+ set it to the extension's
 * version string, which lets the web nudge an update once a newer build ships.
 */

export const EXT_ATTR = "data-sixseven-ext";

/** The latest published extension version. Bump when a new build ships so older
 *  (version-reporting) installs get the "update available" nudge. Legacy `"1"`
 *  builds can't be assessed, so they're never nagged (treated as installed). */
export const LATEST_EXT_VERSION = "0.2.5";

export type ExtState = "missing" | "legacy" | "outdated" | "ok";

export function readExtTag(): string | null {
  return document.documentElement.getAttribute(EXT_ATTR);
}

/** Compare dotted versions: <0 if a<b, 0 if equal, >0 if a>b. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function extState(raw: string | null = readExtTag()): ExtState {
  if (raw === null) return "missing";
  if (raw === "1") return "legacy"; // installed, but pre-version-reporting
  return cmpVersion(raw, LATEST_EXT_VERSION) < 0 ? "outdated" : "ok";
}
