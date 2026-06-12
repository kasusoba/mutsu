/**
 * PageBridge — the room page's side of the postMessage channel to the in-iframe
 * content script (see protocol/bridge.ts). The page never touches the embed's
 * `<video>` directly (cross-origin); it forwards server truth down and receives
 * status/local-control up.
 */

import type { GateMessage, Intent, SyncMessage } from "@sixseven/protocol";
import {
  type ApplyMessage,
  type FrameToPageMessage,
  type SubtitleCue,
  type SubtitleStyle,
  unwrap,
  wrap,
} from "@sixseven/protocol/bridge";

type StatusState = "loading" | "ready" | "stalled" | "failed";

export class PageBridge {
  private frame: Window | null = null;
  private readonly onMessage: (e: MessageEvent) => void;

  // Callbacks wired by the app.
  onReady: (() => void) | null = null;
  onHooked: ((found: boolean) => void) | null = null;
  onStatus: ((state: StatusState, currentTime: number, duration: number) => void) | null = null;
  onLocalControl: ((intent: Intent, time: number) => void) | null = null;

  constructor() {
    this.onMessage = (e: MessageEvent) => {
      // Only trust messages from our embedded frame. Origin varies per embed
      // provider, so we authenticate by the bridge tag, not the origin.
      if (this.frame && e.source !== this.frame) return;
      const msg = unwrap<FrameToPageMessage>(e.data);
      if (!msg) return;
      switch (msg.kind) {
        case "ready":
          this.onReady?.();
          break;
        case "hooked":
          this.onHooked?.(msg.found);
          break;
        case "status":
          this.onStatus?.(msg.state, msg.currentTime, msg.duration);
          break;
        case "localControl":
          this.onLocalControl?.(msg.intent, msg.time);
          break;
      }
    };
    window.addEventListener("message", this.onMessage);
  }

  /** Point the bridge at the embed iframe's content window (or null on unload). */
  setFrame(win: Window | null): void {
    this.frame = win;
    if (win) this.post({ kind: "hello" });
  }

  /** Forward the latest server truth for the content script to enforce (SPEC §4). */
  apply(sync: SyncMessage, gate: GateMessage): void {
    const msg: ApplyMessage = {
      kind: "apply",
      src: sync.src,
      intent: sync.intent,
      time: sync.time,
      rate: sync.rate,
      gatePaused: gate.paused,
    };
    this.post(msg);
  }

  /** Escape hatch: false lifts the takeover so native UI is clickable (SPEC §12). */
  setOverlay(takeover: boolean): void {
    this.post({ kind: "overlay", takeover });
  }

  /** Load (or clear, with null) this viewer's personal subtitle track (SPEC §13). */
  setSubtitles(cues: SubtitleCue[] | null): void {
    this.post({ kind: "setSubtitles", cues });
  }

  /** Update this viewer's subtitle appearance/offset. */
  setSubtitleStyle(style: SubtitleStyle): void {
    this.post({ kind: "setSubtitleStyle", style });
  }

  private post(msg: Parameters<typeof wrap>[0]): void {
    // targetOrigin "*" — embed origin is unknown; the content script validates
    // the bridge tag. We never send anything sensitive over this channel.
    this.frame?.postMessage(wrap(msg), "*");
  }

  destroy(): void {
    window.removeEventListener("message", this.onMessage);
  }
}
