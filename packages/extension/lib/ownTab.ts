/**
 * OwnTabController (§11) — runs in the TOP frame of a streaming site that's an
 * active own-tab watch party. It's the vanilla-TS mirror of what the web room
 * page does (App.svelte + RoomClient + PageBridge), but with no web page:
 *
 *  - owns the WebSocket (RoomSocket) — the source tab IS the room member
 *  - syncs the site's `<video>`: hooks one in this frame AND relays apply/status
 *    through the frame tree (the player may be a nested iframe), reusing the
 *    exact sub-frame engage logic in sync.content.ts
 *  - injects NO video controls (the site has its own) — only the party widget
 *
 * VideoHook.apply never touches `video.src`, so syncing the site's own video is
 * the same as syncing an embed: we move the clock, never the bytes.
 */

import type { MemberStatus, SyncMessage } from "@sixseven/protocol";
import type { FrameToPageMessage, PageToFrameMessage, SubtitleStyle } from "@sixseven/protocol/bridge";
import { DEFAULT_SUBTITLE_STYLE, unwrap, wrap } from "@sixseven/protocol/bridge";
import type { Intent } from "@sixseven/protocol";
import { parseSubtitles } from "@sixseven/protocol/subtitles";
import {
  FUN_DEFAULTS,
  FUN_SPEED_MULT,
  type FunSettings,
  loadFunSettings,
  type OwnTabParty,
  PARTYKIT_HOST,
  saveFunSettings,
} from "./config";
import { PartyWidget } from "./partyWidget";
import { ReactionLayer } from "./reactionLayer";
import { RoomSocket, type SubResult } from "./roomSocket";
import { SubtitleLayer } from "./subtitleLayer";
import { VideoHook } from "./videoHook";

const FAIL_GRACE_MS = 15_000;

export class OwnTabController {
  private socket: RoomSocket;
  private hook = new VideoHook();
  private widget: PartyWidget;
  // Personal subtitles (SPEC §13), never synced — anchored OVER the site's video
  // element (not the whole page) via its rect.
  private subtitles = new SubtitleLayer(
    () => this.hook.currentTime(),
    () => this.hook.videoRect(),
  );
  private subStyle: SubtitleStyle = { ...DEFAULT_SUBTITLE_STYLE };
  private subLabel: string | null = null;
  // Fun layer (§14): floating emoji reactions over the site's video.
  private reactions = new ReactionLayer(() => this.hook.videoRect());
  private chatLog: { id: number; name: string; text: string; self: boolean }[] = [];
  private chatSeq = 0;
  private fun: FunSettings = FUN_DEFAULTS;
  private lastStatus: MemberStatus | null = null;
  private failTimer: ReturnType<typeof setTimeout> | null = null;
  private lastResyncAt = 0;
  private destroyed = false;
  // Re-apply only when the server truth or the gate actually changes — never on a
  // routine gate rebroadcast, which would re-push a stale `time` and nudge the
  // video backward every status tick (mirrors App.svelte's guard).
  private lastAppliedSync: SyncMessage | null = null;
  private lastPaused: boolean | null = null;

  constructor(
    private readonly party: OwnTabParty,
    /** Full teardown (remove stored party + stop) — owned by the content script
     *  so the widget's Leave and the popup's Leave follow the exact same path. */
    private readonly onLeave: () => void,
  ) {
    this.widget = new PartyWidget({
      code: party.code,
      sourceUrl: party.sourceUrl,
      onLeave: () => this.onLeave(),
      subs: {
        loadFile: (f) => this.loadSubtitleFile(f),
        clear: () => this.clearSubtitles(),
        patchStyle: (p) => this.patchSubStyle(p),
        search: (q, s, e) => this.searchSubs(q, s, e),
        loadResult: (r) => this.loadSubResult(r),
        selectTrack: (id) => this.selectEmbeddedTrack(id),
      },
      onReact: (emoji) => this.socket.say("reaction", emoji),
      onChat: (text) => this.socket.say("chat", text),
      onGif: (url) => this.socket.say("gif", url),
      gifSearch: (q) => this.socket.gifSearch(q).then((r) => r.results),
      onFunSettings: (s) => {
        this.fun = s;
        saveFunSettings(s);
        this.reactions.setMult(FUN_SPEED_MULT[s.speed]);
      },
    });

    this.socket = new RoomSocket(
      {
        host: PARTYKIT_HOST,
        room: party.code,
        secret: party.code, // the code doubles as the capability (§11)
        name: party.nickname,
        createMode: party.role === "creator" ? party.createMode : undefined,
      },
      {
        onConnected: (c) => this.widget.update({ connected: c }),
        onWelcome: () => {
          // The creator's join establishes the room; pin its source to THIS page
          // so joiners know what to open. (Server ignores it from non-creators.)
          if (this.party.role === "creator") {
            this.socket.setSource(location.href, "site");
          }
          this.widget.update({ selfId: this.socket.self });
        },
        onSync: () => this.maybeApply(),
        onGate: () => {
          this.maybeApply();
          this.widget.update({ gate: this.socket.gate });
        },
        onMembers: () => this.widget.update({ members: this.socket.members, selfId: this.socket.self }),
        onEvent: (e) => {
          if (e.kind === "reaction") {
            if (this.fun.reactions) this.reactions.spawn(e.text);
          } else if (e.kind === "gif") {
            if (this.fun.gifs) this.reactions.gif(e.text);
          } else if (e.kind === "chat") {
            if (this.fun.bubbles) this.reactions.chat(e.name, e.text);
            this.chatLog = [
              ...this.chatLog,
              { id: this.chatSeq++, name: e.name, text: e.text, self: e.from === this.socket.self },
            ].slice(-100);
            this.widget.update({ chat: this.chatLog });
          }
        },
      },
    );
  }

  start(): void {
    this.widget.mount();
    this.reactions.mount();
    this.subtitles.mount();
    loadFunSettings().then((s) => {
      this.fun = s;
      this.reactions.setMult(FUN_SPEED_MULT[s.speed]);
      this.widget.update({ fun: s });
    });
    this.subtitles.setStyle(this.subStyle);
    this.hook.allowLocalControl = true; // native play/pause/seek → room commands
    this.hook.onHookChange = (found) => {
      if (!found) return;
      this.clearFailTimer();
      const now = performance.now();
      if (now - this.lastResyncAt > 1500) {
        this.lastResyncAt = now;
        this.socket.resync();
      }
    };
    this.hook.onStatus = (state, t, dur) => this.reportStatus(state, t, dur);
    this.hook.onLocalControl = (intent, time) => this.socket.control(intent, time);
    // Surface the source's own caption tracks to the widget as they appear.
    this.hook.onTextTracksChanged = () => this.widget.update({ tracks: this.hook.getTextTracks() });
    this.hook.start();

    // The real <video> may live in a nested iframe — drive the same frame-tree
    // relay the room page uses. Children engage on `hello`, then bubble status up.
    window.addEventListener("message", this.onFrameMessage);
    this.broadcastDown({ kind: "hello" });

    // Loading→failed grace, like the room page: if no video surfaces, say so.
    this.armFailTimer();
  }

  // ── apply the server truth (local hook + down the frame tree) ───────────────

  private maybeApply(): void {
    const sync = this.socket.sync;
    if (!sync) return;
    const paused = this.socket.gate.paused;
    if (sync === this.lastAppliedSync && paused === this.lastPaused) return;
    this.lastAppliedSync = sync;
    this.lastPaused = paused;
    const apply = this.buildApply(sync);
    this.hook.apply(apply);
    this.broadcastDown({ kind: "apply", src: sync.src, ...apply });
  }

  /** Build the current ApplyState from the latest server truth. */
  private buildApply(sync: SyncMessage) {
    return {
      intent: sync.intent,
      time: sync.time,
      rate: sync.rate,
      gatePaused: this.socket.gate.paused,
      force: sync.force,
      solo: this.socket.members.length <= 1,
    };
  }

  /** Push current state down to a freshly-(re)loaded child frame, bypassing the
   *  re-apply guard (the child needs it even if our own sync hasn't changed). */
  private pushDownToFrames(): void {
    const sync = this.socket.sync;
    if (!sync) return;
    this.broadcastDown({ kind: "apply", src: sync.src, ...this.buildApply(sync) });
  }

  private reportStatus(state: MemberStatus, _t: number, _dur: number): void {
    if (state === "ready" || state === "stalled") this.clearFailTimer();
    if (state === this.lastStatus) return;
    this.lastStatus = state;
    this.socket.reportStatus(state);
    this.widget.update({ playerStatus: state });
  }

  // ── frame-tree bridge (top frame ↔ nested player iframes) ───────────────────

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
        // A (re)loaded child frame — re-announce so it engages + gets current state.
        this.broadcastDown({ kind: "hello" });
        this.pushDownToFrames();
        break;
      case "hooked":
        if (msg.found) {
          this.clearFailTimer();
          const now = performance.now();
          if (now - this.lastResyncAt > 1500) {
            this.lastResyncAt = now;
            this.socket.resync();
          }
        }
        break;
      case "status":
        this.reportStatus(msg.state, msg.currentTime, msg.duration);
        break;
      case "localControl":
        this.relayLocalControl(msg.intent, msg.time);
        break;
    }
  };

  private relayLocalControl(intent: Intent, time: number): void {
    this.socket.control(intent, time);
  }

  // ── failed-source grace ─────────────────────────────────────────────────────

  private armFailTimer(): void {
    this.clearFailTimer();
    this.reportStatus("loading", 0, 0);
    this.failTimer = setTimeout(() => {
      this.failTimer = null;
      this.lastStatus = null; // force the report through
      this.reportStatus("failed", 0, 0);
    }, FAIL_GRACE_MS);
  }
  private clearFailTimer(): void {
    if (this.failTimer) {
      clearTimeout(this.failTimer);
      this.failTimer = null;
    }
  }

  // ── teardown ────────────────────────────────────────────────────────────────

  setWidgetHidden(hidden: boolean): void {
    this.widget.setHidden(hidden);
  }

  // ── personal subtitles (apply to our layer + broadcast down to nested frames) ─

  async loadSubtitleFile(file: File): Promise<void> {
    this.hook.disableTextTracks(); // an uploaded sub wins over any embedded track
    const cues = parseSubtitles(await file.text());
    this.subLabel = file.name;
    this.subtitles.setCues(cues);
    this.broadcastDown({ kind: "setSubtitles", cues });
    this.widget.update({ subLabel: this.subLabel, subStyle: this.subStyle, selectedTrack: null });
  }
  clearSubtitles(): void {
    this.hook.disableTextTracks();
    this.subLabel = null;
    this.subtitles.setCues(null);
    this.broadcastDown({ kind: "setSubtitles", cues: null });
    this.widget.update({ subLabel: null, selectedTrack: null });
  }
  patchSubStyle(patch: Partial<SubtitleStyle>): void {
    this.subStyle = { ...this.subStyle, ...patch };
    this.subtitles.setStyle(this.subStyle);
    this.broadcastDown({ kind: "setSubtitleStyle", style: this.subStyle });
    this.widget.update({ subStyle: this.subStyle });
  }

  /** Online search via the member-gated proxy; best-first (most-downloaded). */
  async searchSubs(query: string, season?: number, episode?: number): Promise<SubResult[]> {
    const { results } = await this.socket.subsSearch(query, "en", season, episode);
    return [...results].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
  }
  async loadSubResult(r: SubResult): Promise<void> {
    this.hook.disableTextTracks(); // a chosen online sub wins over any embedded track
    const { vtt } = await this.socket.subsDownload(r.id);
    const cues = parseSubtitles(vtt);
    this.subLabel = `${r.title}${r.release ? ` · ${r.release}` : ""}`;
    this.subtitles.setCues(cues);
    this.broadcastDown({ kind: "setSubtitles", cues });
    this.widget.update({ subLabel: this.subLabel, subStyle: this.subStyle, selectedTrack: null });
  }

  /** Use one of the source's OWN caption tracks — read its cues into our overlay
   *  (offset/style apply), or fall back to the player's native rendering. */
  selectEmbeddedTrack(id: string | null): void {
    if (id === null) {
      this.clearSubtitles();
      return;
    }
    const label = this.hook.getTextTracks().find((t) => t.id === id)?.label ?? "captions";
    this.hook.useTextTrack(id, (cues) => {
      if (cues) {
        this.subLabel = `site · ${label}`;
        this.subtitles.setCues(cues);
        this.broadcastDown({ kind: "setSubtitles", cues });
      } else {
        // Cues weren't CORS-readable → the site renders this track itself.
        this.subLabel = `site · ${label} (native)`;
        this.subtitles.setCues(null);
        this.broadcastDown({ kind: "setSubtitles", cues: null });
      }
      this.widget.update({ subLabel: this.subLabel, subStyle: this.subStyle, selectedTrack: id });
    });
  }

  /** Live snapshot for the popup (which queries us instead of opening its own
   *  connection — avoids a phantom presence member). */
  getState() {
    return {
      code: this.party.code,
      connected: this.socket.connected,
      members: this.socket.members,
      gate: this.socket.gate,
      selfId: this.socket.self,
      playerStatus: this.lastStatus ?? "loading",
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearFailTimer();
    window.removeEventListener("message", this.onFrameMessage);
    this.socket.destroy();
    this.hook.destroy();
    this.subtitles.destroy();
    this.reactions.destroy();
    this.widget.destroy();
  }
}
