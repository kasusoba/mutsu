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
import type { FrameToPageMessage, PageToFrameMessage } from "@sixseven/protocol/bridge";
import { unwrap, wrap } from "@sixseven/protocol/bridge";
import type { Intent } from "@sixseven/protocol";
import { type OwnTabParty, PARTYKIT_HOST, removeParty } from "./config";
import { PartyWidget } from "./partyWidget";
import { RoomSocket } from "./roomSocket";
import { VideoHook } from "./videoHook";

const FAIL_GRACE_MS = 15_000;

export class OwnTabController {
  private socket: RoomSocket;
  private hook = new VideoHook();
  private widget: PartyWidget;
  private lastStatus: MemberStatus | null = null;
  private failTimer: ReturnType<typeof setTimeout> | null = null;
  private lastResyncAt = 0;
  private destroyed = false;
  // Re-apply only when the server truth or the gate actually changes — never on a
  // routine gate rebroadcast, which would re-push a stale `time` and nudge the
  // video backward every status tick (mirrors App.svelte's guard).
  private lastAppliedSync: SyncMessage | null = null;
  private lastPaused: boolean | null = null;

  constructor(private readonly party: OwnTabParty) {
    this.widget = new PartyWidget({
      code: party.code,
      sourceUrl: party.sourceUrl,
      onLeave: () => this.leave(),
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
        onLog: () => this.widget.update({ log: this.socket.log }),
      },
    );
  }

  start(): void {
    this.widget.mount();
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

  async leave(): Promise<void> {
    await removeParty(this.party.sourceUrl);
    this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearFailTimer();
    window.removeEventListener("message", this.onFrameMessage);
    this.socket.destroy();
    this.hook.destroy();
    this.widget.destroy();
  }
}
