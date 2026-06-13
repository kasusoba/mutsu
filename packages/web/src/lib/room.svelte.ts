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
  type SourceKind,
  type SyncMessage,
  parseServerMessage,
} from "@sixseven/protocol";
import { PartySocket } from "partysocket";

export class RoomClient {
  self = $state<MemberId | null>(null);
  connected = $state(false);
  sync = $state<SyncMessage | null>(null);
  members = $state<Member[]>([]);
  gate = $state<GateMessage>({ type: "gate", paused: false, waitingFor: [] });
  log = $state<LogEvent[]>([]);

  /** Ephemeral fun-layer events (§14) — reactions/chat/gif. Transient, so they
   *  flow through a callback the UI subscribes to, not into reactive state. */
  onEvent: (e: EventMessage) => void = () => {};

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
    this.socket.addEventListener("close", () => {
      this.connected = false;
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
      case "error":
        console.warn(`[sixseven] server error: ${msg.code} — ${msg.message}`);
        break;
    }
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
    if (!res.ok || !json) {
      const code = json?.error ?? `http ${res.status}`;
      throw new Error(code === "quota" ? "Daily subtitle limit reached — try again later." : code);
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

  destroy(): void {
    this.socket.close();
  }
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
