/**
 * Picker internals — the runtime messages the popup exchanges with the content
 * script, plus the in-page scan that finds `<video>`/`<iframe>` sources.
 *
 * Flow (SPEC §12, ARCHITECTURE §10.3):
 *   popup --executeScript(collectFrameCandidates, allFrames)--> media list
 *   popup --AreYouRoom (every http tab)----------------------> room tabs
 *   popup --DeliverSource (chosen room tab)-----------------> content script
 *          content script --window.postMessage(pick-source)--> room page
 *
 * The runtime messages here are extension-internal; the page-facing `pick-source`
 * message and `ROOM_ATTR` live in `@mutsu/protocol/picker` (shared with web).
 */

/** popup → content script (any tab): "are you a mutsu room? if so, which?" */
export const PICKER_PING = "sixseven:are-you-room" as const;
/** popup → content script (a room tab): deliver the picked source URL. */
export const PICKER_DELIVER = "sixseven:deliver-source" as const;

export interface AreYouRoomMessage {
  type: typeof PICKER_PING;
}
export interface AreYouRoomReply {
  /** The room name if this tab is a mutsu room page, else null. */
  room: string | null;
}
export interface DeliverSourceMessage {
  type: typeof PICKER_DELIVER;
  url: string;
  srcKind?: "embed" | "direct" | "site";
  queue?: boolean;
}
export interface DeliverSourceReply {
  ok: boolean;
}

export type PickerRuntimeMessage = AreYouRoomMessage | DeliverSourceMessage;

/**
 * One detected media source in a single frame. Direct http(s) `<video>` srcs and
 * `<iframe>` srcs are usable as-is; a `<video>` playing from `blob:`/MSE has no
 * embeddable URL, so we fall back to the frame's own page URL (embed *that* — it
 * already loads the player first-party, which is exactly the model in SPEC §4).
 */
export interface MediaCandidate {
  type: "video" | "iframe";
  /** The URL we'd hand to `setSource` (resolved, absolute, http(s)). */
  url: string;
  /** Suggested render kind: framed `embed` page, a `direct` media/stream URL, or
   *  `site` (the page plays its own blob/MSE video in its own tab — §11). */
  kind: "embed" | "direct" | "site";
  /** The document URL of the frame it was found in (for context). */
  pageUrl: string;
  pageTitle: string;
  /** True for a direct media URL; false when `url` is the hosting page (blob/MSE video). */
  direct: boolean;
  playing: boolean;
  width: number;
  height: number;
}

/**
 * Runs IN the page (via `executeScript`) for each frame. Must be fully
 * self-contained — no imports, no closure over outer scope. Returns the frame's
 * media candidates; the popup merges/dedupes/ranks across frames.
 */
export function collectFrameCandidates(): MediaCandidate[] {
  const out: MediaCandidate[] = [];
  const here = location.href;
  const isHttp = (u: string) => /^https?:\/\//i.test(u);
  // Skip our own room page's embed machinery if this frame is itself a room.
  const SELF_ATTR = "data-sixseven-room";

  // A YouTube watch/embed page → offer the canonical video URL as the one pick.
  // The room re-classifies it to the `youtube` source kind (IFrame API player).
  if (window.top === window.self) {
    let ytId: string | null = null;
    try {
      const u = new URL(here);
      const host = u.hostname.replace(/^www\./, "");
      if (host === "youtu.be") ytId = u.pathname.slice(1).split("/")[0] || null;
      else if (host.endsWith("youtube.com") || host === "youtube-nocookie.com") {
        if (u.pathname === "/watch") ytId = u.searchParams.get("v");
        else {
          const m = u.pathname.match(/^\/(?:embed|shorts|v|live)\/([^/?#]+)/);
          if (m) ytId = m[1] ?? null;
        }
      }
    } catch {
      /* not a URL we can parse */
    }
    if (ytId) {
      return [
        {
          type: "video",
          url: `https://www.youtube.com/watch?v=${ytId}`,
          kind: "embed", // the room maps YouTube URLs to the `youtube` kind
          pageUrl: here,
          pageTitle: document.title,
          direct: false,
          playing: true,
          width: 1280,
          height: 720,
        },
      ];
    }
  }

  // Players like vidstack/shaka mount the <video> inside a shadow root, where a
  // plain document.querySelectorAll can't see it. Walk open shadow roots too so
  // we still find the element (and its <source> stream URL).
  const deepAll = (sel: string): Element[] => {
    const acc: Element[] = [];
    const visit = (root: ParentNode) => {
      for (const el of Array.from(root.querySelectorAll(sel))) acc.push(el);
      for (const el of Array.from(root.querySelectorAll("*"))) {
        const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (sr) visit(sr);
      }
    };
    visit(document);
    return acc;
  };

  for (const f of deepAll("iframe") as HTMLIFrameElement[]) {
    const src = f.src;
    if (!src || !isHttp(src)) continue;
    if (f.contentDocument?.documentElement?.hasAttribute(SELF_ATTR)) continue;
    const r = f.getBoundingClientRect();
    out.push({
      type: "iframe",
      url: src,
      kind: "embed",
      pageUrl: here,
      pageTitle: document.title,
      direct: true,
      playing: false,
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }

  for (const v of deepAll("video") as HTMLVideoElement[]) {
    const r = v.getBoundingClientRect();
    const playing = !v.paused && !v.ended && v.readyState > 2;
    const w = Math.round(r.width || v.videoWidth);
    const h = Math.round(r.height || v.videoHeight);
    const media = v.currentSrc || v.src || "";
    if (isHttp(media)) {
      out.push({
        type: "video",
        url: media,
        kind: "direct",
        pageUrl: here,
        pageTitle: document.title,
        direct: true,
        playing,
        width: w,
        height: h,
      });
    } else {
      // blob:/MSE — no addressable URL. In the TOP frame that means "this page
      // plays its own video": offer it as a `site` source (own tab + sync, §11),
      // which works whether or not the site allows framing. In a NESTED frame the
      // url is a provider iframe that usually DOES allow framing, so embed it.
      out.push({
        type: "video",
        url: here,
        kind: window.top === window.self ? "site" : "embed",
        pageUrl: here,
        pageTitle: document.title,
        direct: false,
        playing,
        width: w,
        height: h,
      });
    }
    // Also surface the real stream URL from <source> children (e.g. an HLS
    // playlist behind a blob/MSE video) — a direct source the room can load.
    for (const s of Array.from(v.querySelectorAll("source"))) {
      const ss = (s as HTMLSourceElement).src;
      if (isHttp(ss)) {
        out.push({
          type: "video",
          url: ss,
          kind: "direct",
          pageUrl: here,
          pageTitle: document.title,
          direct: true,
          playing,
          width: w,
          height: h,
        });
      }
    }
  }

  return out;
}

/** Higher = more likely the source the user means. */
function score(c: MediaCandidate): number {
  let s = 0;
  if (c.playing) s += 1000;
  // SPEC §4: prefer the provider's inner /embed/ iframe over the catalog page.
  if (c.type === "iframe" && /\/embed[/?]|\/e\/|embed\./i.test(c.url)) s += 500;
  if (c.type === "video" && c.direct) s += 300;
  if (c.type === "iframe") s += 100;
  s += Math.min(200, (c.width * c.height) / 5000); // bigger players rank higher
  return s;
}

/** Merge per-frame results: dedupe by URL (keeping the richest), then rank. */
export function rankCandidates(frames: MediaCandidate[][]): MediaCandidate[] {
  const byUrl = new Map<string, MediaCandidate>();
  for (const list of frames) {
    for (const c of list) {
      const prev = byUrl.get(c.url);
      if (!prev) {
        byUrl.set(c.url, c);
        continue;
      }
      // Keep the more informative duplicate (playing / larger).
      const merged: MediaCandidate = {
        ...prev,
        playing: prev.playing || c.playing,
        width: Math.max(prev.width, c.width),
        height: Math.max(prev.height, c.height),
      };
      byUrl.set(c.url, merged);
    }
  }
  return Array.from(byUrl.values()).sort((a, b) => score(b) - score(a));
}
