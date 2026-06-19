/**
 * Picker protocol — extension popup ↔ room page (SPEC §12, ARCHITECTURE §10.3).
 *
 * The "share to room" picker is an extension popup that scans the tab you're
 * browsing for `<video>`/`<iframe>` sources and hands the chosen URL to an open
 * room page, which calls `setSource`. The popup can't touch the room page's
 * Svelte state directly, so the extension's content script (top frame) bridges
 * the two over `window.postMessage`.
 *
 * Two pieces live here because both `web` and `extension` need them:
 *  - `ROOM_ATTR`: the room page tags `<html>` so the popup (via the content
 *    script) can recognise a sixseven room tab and read its name.
 *  - `pick-source`: the message the content script posts to the room page with
 *    the URL the user picked. The page validates it and calls `setSource`.
 *
 * Still "move the URL and the clock, never the bytes": this carries a source
 * URL, never media. The runtime messages between the popup and the content
 * script (scan/ping/deliver) are extension-internal and live in the extension.
 */

/** Tag on the page-facing picker message, so the room page can ignore unrelated postMessages. */
export const PICKER_TAG = "sixseven-picker" as const;

/**
 * Attribute the room page sets on `<html>` once joined, value = the room name.
 * The content script reads it to answer the popup's "are you a room?" ping.
 */
export const ROOM_ATTR = "data-sixseven-room" as const;

/**
 * Content script → room page: the user picked this source URL in the popup.
 * Posted with the room page's own origin as `targetOrigin`; the page also
 * re-validates the URL (origin/protocol) before calling `setSource`.
 */
export interface PickSourceMessage {
  tag: typeof PICKER_TAG;
  kind: "pick-source";
  url: string;
  /** Suggested render kind ("embed"|"direct"|"site"); the page may still re-detect.
   *  "site" = a frame-forbidding page that plays in its own tab (§11). */
  srcKind?: "embed" | "direct" | "site";
  /** Add to the playlist queue (§14) instead of playing it now. */
  queue?: boolean;
}

/** Validate + narrow an incoming postMessage payload to a PickSourceMessage. */
export function isPickSourceMessage(data: unknown): data is PickSourceMessage {
  if (!data || typeof data !== "object") return false;
  const m = data as Partial<PickSourceMessage>;
  return m.tag === PICKER_TAG && m.kind === "pick-source" && typeof m.url === "string";
}
