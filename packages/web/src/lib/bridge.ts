/**
 * PageBridge — the room page's side of the postMessage channel to the in-iframe
 * content script (see protocol/bridge.ts). The page never touches the embed's
 * `<video>` directly (cross-origin); it forwards server truth down and receives
 * status/local-control up.
 */

import type {
  GateMessage,
  Intent,
  Member,
  MemberId,
  SayKind,
  SourceKind,
  SyncMessage,
} from "@mutsu/protocol";
import {
  type ApplyMessage,
  type FrameToPageMessage,
  type PageToFrameMessage,
  type SubtitleCue,
  type SubtitleStyle,
  type TrackInfo,
  type WidgetProxyOp,
  unwrap,
  wrap,
} from "@mutsu/protocol/bridge";
import {
  type SatelliteStateMessage,
  type XtabMessage,
  unwrapXtab,
  wrapXtab,
} from "@mutsu/protocol/xtab";

type StatusState = "loading" | "ready" | "stalled" | "failed";

/** A fun-layer event pushed to the in-site-tab widget (§11/§12). */
export interface WidgetEvent {
  sayKind: SayKind;
  text: string;
  from: MemberId;
  name: string;
  self: boolean;
}

/** The callback surface both transports report up into (wired by RoomBridge). */
export interface BridgeCallbacks {
  onReady: (() => void) | null;
  onHooked: ((found: boolean) => void) | null;
  onStatus: ((state: StatusState, currentTime: number, duration: number) => void) | null;
  onLocalControl: ((intent: Intent, time: number) => void) | null;
  onEnded: (() => void) | null;
  onTracks: ((tracks: TrackInfo[]) => void) | null;
  /** The site widget sent a chat/reaction (§11) — the hub relays it as a `say`. */
  onSay: ((sayKind: SayKind, text: string) => void) | null;
  /** The site widget pressed "Play this page for everyone" (§11) — the hub
   *  re-broadcasts it as a `setSource` (control-mode permitting). */
  onSiteNavigate: ((url: string) => void) | null;
  /** The site widget asked the hub to run a member-gated proxy op (§11). */
  onProxy: ((reqId: number, op: WidgetProxyOp, payload: Record<string, unknown>) => void) | null;
}

/** Build the `apply` command from the latest server truth — shared by both transports. */
function buildApply(sync: SyncMessage, gate: GateMessage, solo: boolean): ApplyMessage {
  return {
    kind: "apply",
    src: sync.src,
    intent: sync.intent,
    time: sync.time,
    rate: sync.rate,
    gatePaused: gate.paused,
    force: sync.force,
    solo,
  };
}

/** Dispatch a frame→page report into a callback bag — shared by both transports. */
function dispatchFrameMessage(msg: FrameToPageMessage, cb: BridgeCallbacks): void {
  switch (msg.kind) {
    case "ready":
      cb.onReady?.();
      break;
    case "hooked":
      cb.onHooked?.(msg.found);
      break;
    case "status":
      cb.onStatus?.(msg.state, msg.currentTime, msg.duration);
      break;
    case "localControl":
      cb.onLocalControl?.(msg.intent, msg.time);
      break;
    case "ended":
      cb.onEnded?.();
      break;
    case "tracks":
      cb.onTracks?.(msg.tracks);
      break;
    case "widgetSay":
      cb.onSay?.(msg.sayKind, msg.text);
      break;
    case "siteNavigate":
      cb.onSiteNavigate?.(msg.url);
      break;
    case "widgetProxy":
      cb.onProxy?.(msg.reqId, msg.op, msg.payload);
      break;
  }
}

export class PageBridge {
  private frame: Window | null = null;
  private readonly onMessage: (e: MessageEvent) => void;

  // Callbacks wired by the app.
  onReady: (() => void) | null = null;
  onHooked: ((found: boolean) => void) | null = null;
  onStatus: ((state: StatusState, currentTime: number, duration: number) => void) | null = null;
  onLocalControl: ((intent: Intent, time: number) => void) | null = null;
  onEnded: (() => void) | null = null;
  onTracks: ((tracks: TrackInfo[]) => void) | null = null;

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
        case "ended":
          this.onEnded?.();
          break;
        case "tracks":
          this.onTracks?.(msg.tracks);
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
  apply(sync: SyncMessage, gate: GateMessage, solo: boolean): void {
    const msg: ApplyMessage = {
      kind: "apply",
      src: sync.src,
      intent: sync.intent,
      time: sync.time,
      rate: sync.rate,
      gatePaused: gate.paused,
      force: sync.force,
      solo,
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

  /** Hide/show our in-iframe overlay + subtitle layer ("use the site's player"). */
  setHidden(hidden: boolean): void {
    this.post({ kind: "setHidden", hidden });
  }

  /** Select one of the embed's own caption tracks (or null = off) — §13. */
  selectTrack(trackId: string | null): void {
    this.post({ kind: "selectTrack", trackId });
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

/**
 * CrossTabBridge — the `site` transport (§11). Same bridge protocol as PageBridge,
 * but the `<video>` lives in a SEPARATE tab we can't postMessage directly. We post
 * xtab envelopes to our OWN window; the page's content script forwards them to the
 * background relay, which `tabs.sendMessage`s them to the site tab — and back.
 */
export class CrossTabBridge {
  /** Frame→page reports route here (wired by RoomBridge). */
  callbacks: BridgeCallbacks = {
    onReady: null,
    onHooked: null,
    onStatus: null,
    onLocalControl: null,
    onEnded: null,
    onTracks: null,
    onSay: null,
    onSiteNavigate: null,
    onProxy: null,
  };
  /** Lifecycle of the satellite tab (open / closed / not-yet-opened). */
  onSatelliteState: ((state: SatelliteStateMessage["state"]) => void) | null = null;

  private readonly onMessage: (e: MessageEvent) => void;
  private activated = false;

  constructor(private readonly room: string) {
    this.onMessage = (e: MessageEvent) => {
      // The content script posts background→page traffic to our own window.
      if (e.source !== window) return;
      const msg = unwrapXtab(e.data);
      if (!msg) return;
      if (msg.kind === "relay" && msg.dir === "up") dispatchFrameMessage(msg.msg, this.callbacks);
      else if (msg.kind === "satelliteState" && msg.room === this.room) {
        this.onSatelliteState?.(msg.state);
      }
      // (our own outbound posts echo here too — they're ignored by kind above.)
    };
    window.addEventListener("message", this.onMessage);
  }

  /** Announce this page as the hub for the room (content script → background). */
  activate(): void {
    if (this.activated) return;
    this.activated = true;
    this.post({ kind: "registerHub", room: this.room });
  }

  /** The room switched AWAY from a `site` source — tear the satellite tab down
   *  (the background stands it down, removing its in-tab widget) and reset so a
   *  later switch back to `site` re-registers the hub cleanly. */
  deactivate(): void {
    if (!this.activated) return;
    this.activated = false;
    this.post({ kind: "unpair", room: this.room });
  }

  apply(sync: SyncMessage, gate: GateMessage, solo: boolean): void {
    this.down(buildApply(sync, gate, solo));
  }
  setOverlay(takeover: boolean): void {
    this.down({ kind: "overlay", takeover });
  }
  setSubtitles(cues: SubtitleCue[] | null): void {
    this.down({ kind: "setSubtitles", cues });
  }
  setSubtitleStyle(style: SubtitleStyle): void {
    this.down({ kind: "setSubtitleStyle", style });
  }
  setHidden(hidden: boolean): void {
    this.down({ kind: "setHidden", hidden });
  }
  selectTrack(trackId: string | null): void {
    this.down({ kind: "selectTrack", trackId });
  }

  /** User gesture: get the source playing in its own tab and pair it. */
  openSatellite(url: string): void {
    this.post({ kind: "openSatellite", room: this.room, url });
  }
  /** Auto-pair: adopt a tab already open on `url` (no new tab, no focus steal). */
  adoptSatellite(url: string): void {
    this.post({ kind: "adoptSatellite", room: this.room, url });
  }
  /** Navigate this hub's paired satellite tab to a new source (follow the room). */
  navigateSatellite(url: string): void {
    this.post({ kind: "navigateSatellite", room: this.room, url });
  }
  /** Tell the in-tab widget whether this viewer can change the source + the room's
   *  current source URL (so it can offer "Play this page for everyone"). */
  widgetControl(canControl: boolean, roomSrc: string | null): void {
    this.down({ kind: "widgetControl", canControl, roomSrc });
  }

  /** Push the room's members down to the in-site-tab widget (§11). */
  pushMembers(members: Member[], self: MemberId | null): void {
    this.down({ kind: "widgetMembers", members, self });
  }
  /** Push a fun-layer event (chat/reaction/gif) down to the widget (§11/§12). */
  pushEvent(ev: WidgetEvent): void {
    this.down({ kind: "widgetEvent", ...ev });
  }
  /** Reply to a widget proxy RPC (§11), matched by reqId. */
  pushProxyResult(reqId: number, ok: boolean, result?: unknown, error?: string): void {
    this.down({ kind: "widgetProxyResult", reqId, ok, result, error });
  }

  private down(msg: PageToFrameMessage): void {
    this.post({ kind: "relay", dir: "down", room: this.room, msg });
  }
  private post(msg: XtabMessage): void {
    window.postMessage(wrapXtab(msg), window.location.origin);
  }

  destroy(): void {
    if (this.activated) this.post({ kind: "unpair", room: this.room });
    window.removeEventListener("message", this.onMessage);
  }
}

/**
 * RoomBridge — one bridge the app holds, routing to the iframe transport
 * (`PageBridge`, for `embed`) or the cross-tab transport (`CrossTabBridge`, for
 * `site`) based on the current source kind. `direct`/`youtube` don't use a bridge
 * at all (their players report via component props), so they simply never call it.
 */
export class RoomBridge implements BridgeCallbacks {
  onReady: (() => void) | null = null;
  onHooked: ((found: boolean) => void) | null = null;
  onStatus: ((state: StatusState, currentTime: number, duration: number) => void) | null = null;
  onLocalControl: ((intent: Intent, time: number) => void) | null = null;
  onEnded: (() => void) | null = null;
  onTracks: ((tracks: TrackInfo[]) => void) | null = null;
  onSay: ((sayKind: SayKind, text: string) => void) | null = null;
  onSiteNavigate: ((url: string) => void) | null = null;
  onProxy: ((reqId: number, op: WidgetProxyOp, payload: Record<string, unknown>) => void) | null =
    null;
  /** Satellite tab lifecycle (only meaningful for `site`). */
  onSatelliteState: ((state: SatelliteStateMessage["state"]) => void) | null = null;

  private readonly page = new PageBridge();
  private readonly cross: CrossTabBridge;
  private kind: SourceKind = "embed";

  constructor(room: string) {
    this.cross = new CrossTabBridge(room);
    // Forward both transports' reports into our own callbacks.
    const fwd: BridgeCallbacks = {
      onReady: () => this.onReady?.(),
      onHooked: (f) => this.onHooked?.(f),
      onStatus: (s, t, d) => this.onStatus?.(s, t, d),
      onLocalControl: (i, t) => this.onLocalControl?.(i, t),
      onEnded: () => this.onEnded?.(),
      onTracks: (t) => this.onTracks?.(t),
      onSay: (k, t) => this.onSay?.(k, t),
      onSiteNavigate: (u) => this.onSiteNavigate?.(u),
      onProxy: (id, op, p) => this.onProxy?.(id, op, p),
    };
    this.page.onReady = fwd.onReady;
    this.page.onHooked = fwd.onHooked;
    this.page.onStatus = fwd.onStatus;
    this.page.onLocalControl = fwd.onLocalControl;
    this.page.onEnded = fwd.onEnded;
    this.page.onTracks = fwd.onTracks;
    this.cross.callbacks = fwd;
    this.cross.onSatelliteState = (s) => this.onSatelliteState?.(s);
  }

  /** Tell the bridge which transport is live; activates the hub on `site`, and
   *  tears the satellite down when switching away from `site`. */
  setKind(kind: SourceKind): void {
    if (kind === this.kind) return;
    const was = this.kind;
    this.kind = kind;
    if (kind === "site") this.cross.activate();
    else if (was === "site") this.cross.deactivate();
  }

  private active(): PageBridge | CrossTabBridge {
    return this.kind === "site" ? this.cross : this.page;
  }

  apply(sync: SyncMessage, gate: GateMessage, solo: boolean): void {
    this.active().apply(sync, gate, solo);
  }
  setOverlay(takeover: boolean): void {
    this.active().setOverlay(takeover);
  }
  setSubtitles(cues: SubtitleCue[] | null): void {
    this.active().setSubtitles(cues);
  }
  setSubtitleStyle(style: SubtitleStyle): void {
    this.active().setSubtitleStyle(style);
  }
  setHidden(hidden: boolean): void {
    this.active().setHidden(hidden);
  }
  selectTrack(trackId: string | null): void {
    this.active().selectTrack(trackId);
  }

  /** Embed only — hand the iframe's content window to the iframe transport. */
  setFrame(win: Window | null): void {
    this.page.setFrame(win);
  }
  /** Site only — open/pair the satellite tab. */
  openSatellite(url: string): void {
    this.cross.openSatellite(url);
  }
  /** Site only — adopt a tab already open on `url` (auto-pair, no new tab). */
  adoptSatellite(url: string): void {
    if (this.kind === "site") this.cross.adoptSatellite(url);
  }
  /** Site only — navigate the paired satellite tab to follow a new source. */
  navigateSatellite(url: string): void {
    if (this.kind === "site") this.cross.navigateSatellite(url);
  }
  /** Site only — push control-ability + current source to the in-tab widget. */
  widgetControl(canControl: boolean, roomSrc: string | null): void {
    if (this.kind === "site") this.cross.widgetControl(canControl, roomSrc);
  }
  /** Site only — push room members to the in-tab widget (no-op for other kinds). */
  pushMembers(members: Member[], self: MemberId | null): void {
    if (this.kind === "site") this.cross.pushMembers(members, self);
  }
  /** Site only — push a fun-layer event to the in-tab widget. */
  pushEvent(ev: WidgetEvent): void {
    if (this.kind === "site") this.cross.pushEvent(ev);
  }
  /** Site only — reply to a widget proxy RPC. */
  pushProxyResult(reqId: number, ok: boolean, result?: unknown, error?: string): void {
    if (this.kind === "site") this.cross.pushProxyResult(reqId, ok, result, error);
  }

  destroy(): void {
    this.page.destroy();
    this.cross.destroy();
  }
}
