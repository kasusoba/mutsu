/**
 * SatelliteController (§11) — runs in the TOP frame of a frame-forbidding site
 * that a web room is driving as a `site` source. It is a "dumb player + widget":
 * it hooks the site's `<video>` and syncs its clock, renders the personal
 * subtitle layer + reaction floats, and hosts the in-tab room widget — but owns
 * NO WebSocket. Commands/members/events arrive from, and reports/chat/proxy RPCs
 * go to, the background relay (which bridges this tab ↔ the web hub tab).
 *
 * Cross-tab twin of the in-iframe content script: same bridge messages, same
 * frame-tree relay for nested-iframe players. The widget has no socket, so its
 * member-gated ops (GIPHY + subtitle search/download) are run by the hub via a
 * `widgetProxy` RPC. VideoHook.apply never touches `video.src` (§2).
 */

import type { MemberStatus } from "@sixseven/protocol";
import type {
  FrameToPageMessage,
  PageToFrameMessage,
  SubtitleStyle,
  TrackInfo,
  WidgetProxyOp,
} from "@sixseven/protocol/bridge";
import { DEFAULT_SUBTITLE_STYLE, unwrap, wrap } from "@sixseven/protocol/bridge";
import { parseSubtitles } from "@sixseven/protocol/subtitles";
import type { RelayUpMessage, XtabMessage } from "@sixseven/protocol/xtab";
import { browser } from "wxt/browser";
import { sameSource } from "./config";
import { ReactionLayer } from "./reactionLayer";
import { type GifHit, SiteWidget, type SubHit } from "./siteWidget";
import { SubtitleLayer } from "./subtitleLayer";
import { VideoHook } from "./videoHook";

const FAIL_GRACE_MS = 15_000;
const PROXY_TIMEOUT_MS = 20_000;

export class SatelliteController {
  private hook = new VideoHook();
  private subtitles = new SubtitleLayer(
    () => this.hook.currentTime(),
    () => this.hook.videoRect(),
  );
  private reactions = new ReactionLayer(() => this.hook.videoRect());
  private widget: SiteWidget;
  private subStyle: SubtitleStyle = { ...DEFAULT_SUBTITLE_STYLE };
  // The source's own caption tracks + whether they live in a nested frame (then
  // selection routes down the frame tree instead of the top-frame hook).
  private tracks: TrackInfo[] = [];
  private tracksNested = false;
  // Pending widgetProxy RPCs (gif/subtitle search) keyed by reqId.
  private proxySeq = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private failTimer: ReturnType<typeof setTimeout> | null = null;
  private lastApply: Parameters<VideoHook["apply"]>[0] | null = null;
  private destroyed = false;
  // "Play this page for everyone" (§11): the room's current source + whether this
  // viewer may change it. The button shows only when this page differs from the
  // room source AND we're allowed to push it (control mode). `lastHref` lets us
  // notice in-site SPA navigation (no reload) so the button appears/updates.
  private roomSrc: string | null = null;
  private canControl = false;
  private lastHref = location.href;
  private navTimer: ReturnType<typeof setInterval> | null = null;
  // Widget visibility + member count, surfaced to the popup so it can show/hide
  // the in-tab widget (some viewers don't want it overlaying the video).
  private widgetHidden = false;
  private memberCount = 0;

  constructor(private readonly room: string) {
    this.widget = new SiteWidget({
      room,
      onChat: (text) => this.sendUp({ kind: "widgetSay", sayKind: "chat", text }),
      onReact: (emoji) => this.sendUp({ kind: "widgetSay", sayKind: "reaction", text: emoji }),
      onGif: (url) => this.sendUp({ kind: "widgetSay", sayKind: "gif", text: url }),
      onGoToRoom: () => this.post({ kind: "focusHub" }),
      onClose: () => this.setWidgetHidden(true),
      onPlayPage: () => this.playThisPage(),
      gifSearch: async (q) => {
        const r = (await this.proxy("gif.search", { query: q })) as { results: GifHit[] };
        return r.results ?? [];
      },
      subs: {
        loadFile: async (f) => this.setCues(parseSubtitles(await f.text()), f.name),
        search: async (q, season, episode) => {
          const r = (await this.proxy("subs.search", { query: q, season, episode })) as {
            results: SubHit[];
          };
          return [...(r.results ?? [])].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
        },
        loadResult: async (hit) => {
          const r = (await this.proxy("subs.download", { id: hit.id })) as { vtt: string };
          this.setCues(
            parseSubtitles(r.vtt),
            `${hit.title}${hit.release ? ` · ${hit.release}` : ""}`,
          );
        },
        clear: () => this.setCues(null, null),
        setStyle: (patch) => this.patchSubStyle(patch),
        selectTrack: (id) => this.selectTrack(id),
      },
    });
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    this.subtitles.mount();
    this.subtitles.setStyle(this.subStyle);
    this.reactions.mount();
    this.widget.mount();
    this.widget.setSubStyle(this.subStyle);
    this.hook.allowLocalControl = true; // native play/pause/seek → room commands
    this.hook.onHookChange = (found) => {
      if (!found) return;
      this.clearFailTimer();
      this.sendUp({ kind: "hooked", found: true });
    };
    this.hook.onStatus = (state, t, dur) => this.reportStatus(state, t, dur);
    this.hook.onLocalControl = (intent, time) =>
      this.sendUp({ kind: "localControl", intent, time });
    this.hook.onEnded = () => this.sendUp({ kind: "ended" });
    this.hook.onTextTracksChanged = () => {
      this.tracks = this.hook.getTextTracks();
      this.tracksNested = false;
      this.sendUp({ kind: "tracks", tracks: this.tracks });
      this.widget.setTracks(this.tracks);
    };
    this.hook.start();

    // The real <video> may live in a nested iframe — drive the same frame-tree
    // relay the room page uses. Children engage on `hello`, then bubble status up.
    window.addEventListener("message", this.onFrameMessage);
    this.broadcastDown({ kind: "hello" });

    this.post({ kind: "registerSatellite", room: this.room, src: location.href });
    this.armFailTimer();

    // Notice in-site navigation (SPA route change → no reload) so "Play this page"
    // tracks the page you're actually on. A full reload reboots us instead.
    window.addEventListener("popstate", this.onNav);
    window.addEventListener("hashchange", this.onNav);
    this.navTimer = setInterval(this.onNav, 1000);
  }

  // The current page differs from what the room navigated to (a new title).
  private onNav = (): void => {
    if (location.href === this.lastHref) return;
    this.lastHref = location.href;
    // Keep the background's record of our URL fresh so the hub's follow-navigate
    // won't reload the page we just moved to ourselves, and the hub display tracks.
    this.post({ kind: "registerSatellite", room: this.room, src: location.href });
    this.refreshPlayPage();
  };

  // Show "Play this page for everyone" only when we're on a different page than the
  // room's current source AND we're allowed to change it (control mode).
  private refreshPlayPage(): void {
    const differs = !this.roomSrc || !sameSource(location.href, this.roomSrc);
    this.widget.setCanPlayPage(this.canControl && differs);
  }

  // User pressed "Play this page for everyone": tell the hub to setSource here.
  private playThisPage(): void {
    const url = location.href;
    // Register our URL first so the hub's resulting follow-navigate skips us.
    this.post({ kind: "registerSatellite", room: this.room, src: url });
    this.sendUp({ kind: "siteNavigate", url });
  }

  // ── popup control (show/hide the in-tab widget) ──────────────────────────────

  setWidgetHidden(hidden: boolean): void {
    this.widgetHidden = hidden;
    this.widget.setGone(hidden); // fully hide the widget; the popup re-shows it
  }
  popupState(): { active: boolean; hidden: boolean; members: number } {
    return { active: true, hidden: this.widgetHidden, members: this.memberCount };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearFailTimer();
    if (this.navTimer) clearInterval(this.navTimer);
    window.removeEventListener("popstate", this.onNav);
    window.removeEventListener("hashchange", this.onNav);
    for (const p of this.pending.values()) p.reject(new Error("closed"));
    this.pending.clear();
    window.removeEventListener("message", this.onFrameMessage);
    this.hook.destroy();
    this.subtitles.destroy();
    this.reactions.destroy();
    this.widget.destroy();
  }

  // ── commands from the hub (relayed down by the background) ────────────────────

  handleDown(msg: PageToFrameMessage): void {
    switch (msg.kind) {
      case "hello":
        break; // we generate hello toward our own children; ignore inbound
      case "apply":
        this.lastApply = {
          intent: msg.intent,
          time: msg.time,
          rate: msg.rate,
          gatePaused: msg.gatePaused,
          force: msg.force,
          solo: msg.solo,
        };
        // The room's current source rides on `apply` — keep it for the "Play this
        // page" comparison (widgetControl also carries it, but apply is steadier).
        if (msg.src != null) {
          this.roomSrc = msg.src;
          this.refreshPlayPage();
        }
        this.hook.apply(this.lastApply);
        this.broadcastDown(msg);
        break;
      case "setSubtitles":
        this.subtitles.setCues(msg.cues);
        this.broadcastDown(msg);
        break;
      case "setSubtitleStyle":
        this.subStyle = msg.style;
        this.subtitles.setStyle(msg.style);
        this.broadcastDown(msg);
        break;
      case "setHidden":
        this.subtitles.setHidden(msg.hidden);
        this.broadcastDown(msg);
        break;
      case "selectTrack":
        this.applyTrack(msg.trackId);
        this.broadcastDown(msg);
        break;
      case "overlay":
        this.broadcastDown(msg); // no top-frame overlay; nested players may use it
        break;
      // Room widget data from the hub (members + fun-layer events). Top-frame only.
      case "widgetMembers":
        this.memberCount = msg.members.length;
        this.widget.setMembers(msg.members, msg.self);
        break;
      case "widgetControl":
        this.canControl = msg.canControl;
        this.roomSrc = msg.roomSrc;
        this.refreshPlayPage();
        break;
      case "widgetEvent":
        if (msg.sayKind === "chat") {
          this.widget.addChat(msg.name, msg.text, msg.self);
          this.reactions.chat(msg.name, msg.text);
        } else if (msg.sayKind === "reaction") {
          this.reactions.spawn(msg.text);
        } else if (msg.sayKind === "gif") {
          this.reactions.gif(msg.text);
        }
        break;
      case "widgetProxyResult": {
        const p = this.pending.get(msg.reqId);
        if (p) {
          this.pending.delete(msg.reqId);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error ?? "proxy failed"));
        }
        break;
      }
    }
  }

  // ── subtitles (local layer + nested-frame relay) ──────────────────────────────

  private setCues(cues: Parameters<SubtitleLayer["setCues"]>[0], label: string | null): void {
    this.deselectTrack();
    this.subtitles.setCues(cues);
    this.broadcastDown({ kind: "setSubtitles", cues });
    this.widget.setSubLabel(label);
  }
  private patchSubStyle(patch: Partial<SubtitleStyle>): void {
    this.subStyle = { ...this.subStyle, ...patch };
    this.subtitles.setStyle(this.subStyle);
    this.broadcastDown({ kind: "setSubtitleStyle", style: this.subStyle });
    this.widget.setSubStyle(this.subStyle);
  }
  private deselectTrack(): void {
    this.hook.disableTextTracks();
    if (this.tracksNested) this.broadcastDown({ kind: "selectTrack", trackId: null });
  }
  private selectTrack(id: string | null): void {
    if (id === null) {
      this.setCues(null, null);
      return;
    }
    this.applyTrack(id);
    const label = this.tracks.find((t) => t.id === id)?.label ?? "captions";
    this.widget.setSubLabel(`site · ${label}`);
  }
  private applyTrack(id: string | null): void {
    if (id === null) {
      this.hook.disableTextTracks();
      return;
    }
    if (this.tracksNested) {
      this.subtitles.setCues(null);
      this.broadcastDown({ kind: "selectTrack", trackId: id });
      return;
    }
    this.hook.useTextTrack(id, (cues) => this.subtitles.setCues(cues));
  }

  // ── widgetProxy RPC (run member-gated ops on the hub) ─────────────────────────

  private proxy(op: WidgetProxyOp, payload: Record<string, unknown>): Promise<unknown> {
    const reqId = ++this.proxySeq;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.sendUp({ kind: "widgetProxy", reqId, op, payload });
      setTimeout(() => {
        if (this.pending.delete(reqId)) reject(new Error("timed out"));
      }, PROXY_TIMEOUT_MS);
    });
  }

  // ── frame-tree relay (top frame ↔ nested player iframes) ──────────────────────

  private broadcastDown(msg: PageToFrameMessage): void {
    const env = wrap(msg);
    for (const f of Array.from(document.querySelectorAll("iframe"))) {
      f.contentWindow?.postMessage(env, "*");
    }
  }

  private onFrameMessage = (e: MessageEvent): void => {
    if (e.source === window) return;
    const msg = unwrap<FrameToPageMessage>(e.data);
    if (!msg) return;
    switch (msg.kind) {
      case "ready":
        this.broadcastDown({ kind: "hello" });
        if (this.lastApply) this.broadcastDown({ kind: "apply", src: null, ...this.lastApply });
        break;
      case "hooked":
        if (msg.found) {
          this.clearFailTimer();
          this.sendUp({ kind: "hooked", found: true });
        }
        break;
      case "status":
        this.reportStatus(msg.state, msg.currentTime, msg.duration);
        break;
      case "localControl":
        this.sendUp(msg);
        break;
      case "ended":
        this.sendUp(msg);
        break;
      case "tracks":
        // The real video is a nested frame — its caption tracks live there.
        this.tracks = msg.tracks;
        this.tracksNested = true;
        this.sendUp(msg);
        this.widget.setTracks(this.tracks);
        break;
    }
  };

  // ── status + transport ────────────────────────────────────────────────────────

  private reportStatus(state: MemberStatus, t: number, dur: number): void {
    if (state === "ready" || state === "stalled") this.clearFailTimer();
    this.sendUp({ kind: "status", state, currentTime: t, duration: dur });
  }

  private sendUp(msg: FrameToPageMessage): void {
    const relay: RelayUpMessage = { kind: "relay", dir: "up", room: this.room, msg };
    this.post(relay);
  }
  private post(msg: XtabMessage): void {
    void browser.runtime.sendMessage(msg).catch(() => {});
  }

  // ── failed-source grace (mirrors the room page) ───────────────────────────────

  private armFailTimer(): void {
    this.clearFailTimer();
    this.reportStatus("loading", 0, 0);
    this.failTimer = setTimeout(() => {
      this.failTimer = null;
      this.reportStatus("failed", 0, 0);
    }, FAIL_GRACE_MS);
  }
  private clearFailTimer(): void {
    if (this.failTimer) {
      clearTimeout(this.failTimer);
      this.failTimer = null;
    }
  }
}
