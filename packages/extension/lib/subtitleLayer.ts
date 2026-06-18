/**
 * SubtitleLayer — renders personal WebVTT cues over the video (SPEC §13),
 * asbplayer-style: independent of the player's own captions, so it works on any
 * frame-allowing source. Synced to the video clock with a per-viewer offset and
 * styled per-viewer. Lives inside the iframe so it tracks fullscreen (risk #10).
 *
 * Subtitles are personal and never synced to the room — this layer only ever
 * receives `setSubtitles`/`setSubtitleStyle` from the page, never the network.
 */

import {
  DEFAULT_SUBTITLE_STYLE,
  type SubtitleCue,
  type SubtitleStyle,
} from "@sixseven/protocol/bridge";

/**
 * On-screen readout for debugging when devtools is blocked (e.g. streamimdb).
 * Off by default; flip to true to confirm cues/offset/style reach the frame.
 */
const DEBUG_HUD = false;

/**
 * The video rect barely moves, but reading it (getBoundingClientRect) forces a
 * synchronous reflow — doing that every rAF frame on a heavy SPA (YouTube) is a
 * real perf hit. The cue box only needs repositioning a few times a second, so
 * we throttle the layout read to this interval (cue *text* still updates every
 * frame — that's a cheap string compare, no layout).
 */
const LAYOUT_INTERVAL_MS = 200;

export class SubtitleLayer {
  private host: HTMLDivElement;
  private box: HTMLDivElement;
  private hud: HTMLDivElement | null = null;
  private cues: SubtitleCue[] = [];
  private style: SubtitleStyle = { ...DEFAULT_SUBTITLE_STYLE };
  private raf = 0;
  private lastLayoutAt = 0;
  private lastText = "";
  private hostH = 0;
  private styleCalls = 0;
  private cueCalls = 0;

  /**
   * @param getTime  current video time (seconds), or null when no video.
   * @param getRect  optional: the video's on-screen rect. When given (own-tab —
   *   the video is one element on a normal page), the layer sits OVER the video.
   *   When omitted (embed sub-frame, where the iframe IS the video area), it
   *   covers the viewport as before.
   */
  constructor(
    private readonly getTime: () => number | null,
    private readonly getRect?: () => DOMRect | null,
  ) {
    this.host = document.createElement("div");
    Object.assign(this.host.style, {
      position: "fixed",
      zIndex: "2147483646",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      pointerEvents: "none",
      boxSizing: "border-box",
    } satisfies Partial<CSSStyleDeclaration>);

    this.box = document.createElement("div");
    Object.assign(this.box.style, {
      maxWidth: "90%",
      textAlign: "center",
      whiteSpace: "pre-line",
      lineHeight: "1.3",
      fontFamily: "system-ui, sans-serif",
      fontWeight: "600",
      textShadow: "0 1px 2px rgba(0,0,0,0.9)",
      borderRadius: "6px",
      padding: "2px 10px",
    } satisfies Partial<CSSStyleDeclaration>);
    this.host.appendChild(this.box);
    this.applyStyle();

    if (DEBUG_HUD) {
      this.hud = document.createElement("div");
      Object.assign(this.hud.style, {
        position: "fixed",
        top: "8px",
        right: "8px",
        zIndex: "2147483647",
        padding: "3px 7px",
        borderRadius: "5px",
        font: "11px/1.4 monospace",
        color: "#9ff",
        background: "rgba(0,0,0,0.7)",
        pointerEvents: "none",
        whiteSpace: "pre",
      } satisfies Partial<CSSStyleDeclaration>);
    }

    document.addEventListener("fullscreenchange", () => this.reattach());
  }

  mount(): void {
    this.reattach();
    const loop = (now: number) => {
      this.render(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private reattach(): void {
    const parent = document.fullscreenElement ?? document.body;
    if (parent && this.host.parentElement !== parent) parent.appendChild(this.host);
    if (this.hud && parent && this.hud.parentElement !== parent) parent.appendChild(this.hud);
  }

  setCues(cues: SubtitleCue[] | null): void {
    this.cues = cues ?? [];
    // NB: don't reset lastText here — render()'s setText() dedupes against it, so
    // zeroing it would make a clear (new text "" === lastText "") skip the DOM
    // update and leave the last cue stuck on screen. Leaving lastText as the
    // showing text lets the next render detect the change to "" and clear it.
    this.cueCalls++;
  }

  /** Hide/show the subtitle overlay ("use the site's own player"). */
  setHidden(hidden: boolean): void {
    this.host.style.display = hidden ? "none" : "";
  }

  setStyle(style: SubtitleStyle): void {
    this.style = style;
    this.styleCalls++;
    this.applyStyle();
  }

  /** Colour/box only — geometry (position, size, margin) is per-frame in layout(). */
  private applyStyle(): void {
    const s = this.style;
    this.box.style.color = s.color;
    this.box.style.opacity = String(s.opacity);
    this.box.style.background = `rgba(0,0,0,${s.background})`;
  }

  /** Anchor the layer over the video rect (own-tab) or the viewport (embed),
   *  and size the cue + its margin relative to that box's height. */
  private layout(): void {
    const s = this.style;
    const rect = this.getRect?.() ?? null;
    const full = document.fullscreenElement;
    if (rect && rect.width > 1 && rect.height > 1 && !full) {
      this.host.style.left = `${rect.left}px`;
      this.host.style.top = `${rect.top}px`;
      this.host.style.width = `${rect.width}px`;
      this.host.style.height = `${rect.height}px`;
      this.hostH = rect.height;
    } else {
      this.host.style.left = "0";
      this.host.style.top = "0";
      this.host.style.width = "100vw";
      this.host.style.height = "100vh";
      this.hostH = window.innerHeight;
    }
    this.host.style.justifyContent = s.position === "top" ? "flex-start" : "flex-end";
    const pad = `${(s.marginPct / 100) * this.hostH}px`;
    this.host.style.paddingTop = s.position === "top" ? pad : "0";
    this.host.style.paddingBottom = s.position === "top" ? "0" : pad;
    this.host.style.paddingLeft = "5%";
    this.host.style.paddingRight = "5%";
    this.box.style.fontSize = `${Math.max(12, this.hostH * 0.05 * (s.sizePct / 100))}px`;
  }

  private render(now: number): void {
    // Idle: no cues loaded and nothing showing → don't touch layout at all (the
    // common case when subtitles are off). Keeps the loop a no-op, zero reflow.
    if (this.cues.length === 0 && this.lastText === "") return;
    if (now - this.lastLayoutAt >= LAYOUT_INTERVAL_MS) {
      this.layout();
      this.lastLayoutAt = now;
    }
    const t = this.getTime();
    const ref = t == null ? null : t - this.style.offsetMs / 1000;

    let text = "";
    if (ref != null) {
      for (const c of this.cues) {
        if (c.start > ref) break; // cues are sorted by start
        if (ref <= c.end) {
          text = c.text;
          break;
        }
      }
    }
    this.setText(text);

    if (this.hud) {
      const off = (this.style.offsetMs / 1000).toFixed(2);
      const time = t == null ? "—" : t.toFixed(1);
      this.hud.textContent = `sixseven subs
cues ${this.cues.length} · off ${off}s
t ${time} · ${text ? "CUE" : "—"} · ${this.style.sizePct}% ${this.style.position}
rx: style ${this.styleCalls} · cue ${this.cueCalls}`;
    }
  }

  private setText(text: string): void {
    if (text === this.lastText) return;
    this.lastText = text;
    this.box.textContent = text;
    this.box.style.display = text ? "block" : "none";
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.host.remove();
    this.hud?.remove();
  }
}
