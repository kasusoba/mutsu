/**
 * RoomClient — owns the WebSocket to the PartyKit DO and the reactive room
 * state (SPEC §6: "the room page holds the WS connection"). Components read its
 * `$state` fields; the bridge feeds `sync`/`gate` into the iframe and pushes
 * `status`/local control back through this client.
 */

import {
  type ClientMessage,
  type EventMessage,
  type GateMessage,
  type Intent,
  type LogEvent,
  type Member,
  type MemberId,
  type Mode,
  type SayKind,
  type SourceItem,
  type SourceKind,
  type SyncMessage,
  parseServerMessage,
} from "@sixseven/protocol";
import { PartySocket } from "partysocket";

export class RoomClient {
  self = $state<MemberId | null>(null);
  connected = $state(false);
  /** Set when the server rejects us for good (bad/expired invite key). The socket
   *  stops reconnecting and the UI shows this instead of an endless "reconnecting…". */
  fatalError = $state<string | null>(null);
  sync = $state<SyncMessage | null>(null);
  members = $state<Member[]>([]);
  gate = $state<GateMessage>({ type: "gate", paused: false, waitingFor: [] });
  log = $state<LogEvent[]>([]);
  playlist = $state<SourceItem[]>([]);
  playlistCurrentId = $state<string | null>(null);
  autoplay = $state(true);

  /** Ephemeral fun-layer events (§14) — reactions/chat/gif. Transient, so they
   *  flow through a callback the UI subscribes to, not into reactive state. */
  onEvent: (e: EventMessage) => void = () => {};

  /** Video call (§17): an inbound WebRTC signal from a peer (SDP/ICE). */
  onRtcSignal: (from: MemberId, data: unknown) => void = () => {};
  /** Video call: server refused turning the camera on (room at the publisher cap). */
  onCallError: (message: string) => void = () => {};

  /** Derived: this member's own presence row (status etc.). */
  me = $derived(this.members.find((m) => m.id === this.self) ?? null);
  /** Derived: am I allowed to issue privileged actions right now? */
  canControl = $derived(!this.sync || this.sync.mode === "open" || this.sync.hostId === this.self);

  private socket: PartySocket;

  constructor(
    readonly host: string,
    readonly room: string,
    private readonly secret: string | null,
    private readonly name: string,
    /** Initial control mode when this client CREATES the room (M2). The server
     *  honours it only on the room-creating join; ignored on reconnects. */
    private readonly createMode?: Mode,
  ) {
    this.socket = new PartySocket({ host, room });
    this.socket.addEventListener("open", () => {
      this.connected = true;
      // (Re)join on every open so reconnects re-admit + resync (SPEC §7).
      this.send({ type: "join", secret: this.secret, name: this.name, mode: this.createMode });
    });
    this.socket.addEventListener("close", (e) => {
      this.connected = false;
      // 4001 = the server refused the secret (it also sends an `error` first, but
      // catch the close code too as a backstop). Stop the auto-reconnect loop.
      if (e.code === 4001 && !this.fatalError) this.failAuth();
    });
    this.socket.addEventListener("message", (e) => this.onMessage(e.data));
  }

  private onMessage(raw: string): void {
    const msg = parseServerMessage(raw);
    if (!msg) return;
    switch (msg.type) {
      case "welcome":
        this.self = msg.self;
        break;
      case "sync":
        this.sync = msg;
        break;
      case "members":
        this.members = msg.list;
        break;
      case "gate":
        this.gate = msg;
        break;
      case "log":
        // Dedupe by id: on reconnect the server replays its recent log, so the
        // same events arrive again. Appending duplicates crashes the keyed
        // {#each} in ActivityLog (each_key_duplicate) and freezes the whole log.
        if (!this.log.some((e) => e.id === msg.event.id)) {
          this.log = [...this.log, msg.event].slice(-100);
        }
        break;
      case "event":
        this.onEvent(msg);
        break;
      case "playlist":
        this.playlist = msg.items;
        this.playlistCurrentId = msg.currentId;
        this.autoplay = msg.autoplay;
        break;
      case "rtcSignal":
        this.onRtcSignal(msg.from, msg.data);
        break;
      case "error":
        console.warn(`[sixseven] server error: ${msg.code} — ${msg.message}`);
        // A bad/expired invite key is terminal — without it the server keeps
        // closing us and PartySocket reconnects forever. Stop and tell the user.
        if (msg.code === "unauthorized") this.failAuth();
        else if (msg.code === "call_full") this.onCallError(msg.message);
        break;
    }
  }

  /** Terminal auth failure: halt the reconnect loop and surface a clear message.
   *  Calling socket.close() explicitly tells PartySocket NOT to reconnect. */
  private failAuth(): void {
    this.fatalError =
      "This room link's key is wrong or expired. Ask whoever invited you for a fresh link.";
    this.connected = false;
    this.socket.close();
  }

  private send(msg: ClientMessage): void {
    this.socket.send(JSON.stringify(msg));
  }

  // ── intents from the UI / bridge ──────────────────────────────────────────

  setSource(src: string, kind?: SourceKind): void {
    this.send({ type: "setSource", src, kind });
  }
  control(intent: Intent, time: number, rate?: number): void {
    this.send({ type: "control", intent, time, rate });
  }
  setMode(mode: Mode): void {
    this.send({ type: "setMode", mode });
  }
  passControl(toId: MemberId): void {
    this.send({ type: "passControl", toId });
  }
  skip(memberId: MemberId): void {
    this.send({ type: "skip", memberId });
  }
  reportStatus(state: Member["status"]): void {
    this.send({ type: "status", state });
  }
  /** Ask the server for a freshly-projected `sync` (e.g. when a frame newly hooks). */
  resync(): void {
    this.send({ type: "resync" });
  }
  /** Fire an ephemeral fun-layer event to the room (§14). */
  say(kind: SayKind, text: string): void {
    this.send({ type: "say", kind, text });
  }

  // ── playlist (§16) ──────────────────────────────────────────────────────────
  queueAdd(src: string, kind?: SourceKind, title?: string): void {
    this.send({ type: "queueAdd", src, kind, title });
  }
  queueRemove(id: string): void {
    this.send({ type: "queueRemove", id });
  }
  queueClear(): void {
    this.send({ type: "queueClear" });
  }
  playItem(id: string): void {
    this.send({ type: "playItem", id });
  }
  queueReorder(id: string, toIndex: number): void {
    this.send({ type: "queueReorder", id, toIndex });
  }
  setAutoplay(on: boolean): void {
    this.send({ type: "setAutoplay", on });
  }
  playNext(afterId?: string | null): void {
    this.send({ type: "playNext", afterId });
  }

  // ── video call (§17) ──────────────────────────────────────────────────────
  /** Join or leave the call (capped server-side). Joining lets you receive even
   *  without publishing — turn the camera on separately with `setCam`. */
  setCall(on: boolean): void {
    this.send({ type: "setCall", on });
  }
  /** Camera-publishing display hint (only meaningful while in the call). */
  setCam(on: boolean): void {
    this.send({ type: "setCam", on });
  }
  /** Relay a WebRTC signal (SDP/ICE) to one peer. */
  rtcSignal(to: MemberId, data: unknown): void {
    this.send({ type: "rtcSignal", to, data });
  }
  /** Fetch the ICE servers (STUN, + TURN if the room is configured for it). */
  iceServers(): Promise<{ iceServers: RTCIceServer[] }> {
    return this.proxy("rtc.iceServers", {});
  }

  // ── subtitle proxy (SPEC §13) ─────────────────────────────────────────────

  /** HTTP base for the room's DO (proxy endpoint), matching the WS host. */
  private httpBase(): string {
    const local = /^(localhost|127\.|0\.0\.0\.0|\[?::1)/.test(this.host);
    return `${local ? "http" : "https"}://${this.host}/parties/main/${this.room}`;
  }

  private async proxy<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.httpBase(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sixseven-secret": this.secret ?? "" },
      body: JSON.stringify({ op, ...payload }),
    });
    const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    // Surface error payloads (the server returns these with HTTP 200, e.g. an
    // unconfigured proxy) instead of letting callers see an empty result.
    if (!res.ok || !json || json.error) {
      const code = json?.error ?? `http ${res.status}`;
      const friendly: Record<string, string> = {
        quota: "Daily subtitle limit reached — try again later.",
        gif_not_configured:
          "GIF search isn't set up on this server (no GIPHY_API_KEY). For the deployed server, run `partykit env push`.",
      };
      throw new Error(friendly[code] ?? code);
    }
    return json;
  }

  subsSearch(
    query: string,
    languages = "en",
    season?: number,
    episode?: number,
  ): Promise<{ results: SubResult[] }> {
    return this.proxy("subs.search", { query, languages, season, episode });
  }
  subsDownload(id: string): Promise<{ vtt: string }> {
    return this.proxy("subs.download", { id });
  }

  /** GIPHY search via the member-gated proxy (§14). */
  gifSearch(query: string): Promise<{ results: GifResult[] }> {
    return this.proxy("gif.search", { query });
  }

  destroy(): void {
    this.socket.close();
  }
}

/** A GIF search hit from the proxy (§14). */
export interface GifResult {
  id: string;
  url: string;
  preview: string;
  width: number;
  height: number;
}

/** A subtitle search hit from the proxy (mirrors the server's normalized shape). */
export interface SubResult {
  id: string;
  provider: string;
  title: string;
  language: string;
  release?: string;
  downloads?: number;
}
