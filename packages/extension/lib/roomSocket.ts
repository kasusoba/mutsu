/**
 * RoomSocket — a framework-agnostic client for the sixseven sync server, used by
 * the extension's own-tab watch-party mode (§11). It mirrors the web's
 * `RoomClient` (packages/web/src/lib/room.svelte.ts) but with plain callbacks
 * instead of Svelte `$state`, so it can run inside a content script.
 *
 * Same protocol, same single-clock model. In own-tab mode the member that holds
 * this socket is the SOURCE TAB's content script — close the tab and the member
 * leaves, which is exactly right. The popup also uses it briefly as an
 * `observer` to peek a room's current source before the user is on it.
 */

import {
  type ClientMessage,
  type GateMessage,
  type Intent,
  type LogEvent,
  type Member,
  type MemberId,
  type Mode,
  type SourceKind,
  type SyncMessage,
  parseServerMessage,
} from "@sixseven/protocol";
import { PartySocket } from "partysocket";

export interface RoomSocketOpts {
  host: string;
  room: string;
  secret: string | null;
  name: string;
  /** Carry the creator's chosen control mode on the room-creating join. */
  createMode?: Mode;
  /** Read-only peek (no presence) — used by the popup's join preview. */
  observer?: boolean;
}

export interface RoomSocketHandlers {
  onWelcome?: (self: MemberId) => void;
  onSync?: (sync: SyncMessage) => void;
  onMembers?: (members: Member[]) => void;
  onGate?: (gate: GateMessage) => void;
  onLog?: (event: LogEvent) => void;
  onConnected?: (connected: boolean) => void;
}

export class RoomSocket {
  self: MemberId | null = null;
  connected = false;
  sync: SyncMessage | null = null;
  members: Member[] = [];
  gate: GateMessage = { type: "gate", paused: false, waitingFor: [] };
  log: LogEvent[] = [];

  private socket: PartySocket;

  constructor(
    private readonly opts: RoomSocketOpts,
    private readonly h: RoomSocketHandlers = {},
  ) {
    this.socket = new PartySocket({ host: opts.host, room: opts.room });
    this.socket.addEventListener("open", () => {
      this.connected = true;
      this.h.onConnected?.(true);
      this.send({
        type: "join",
        secret: this.opts.secret,
        name: this.opts.name,
        mode: this.opts.createMode,
        observer: this.opts.observer,
      });
    });
    this.socket.addEventListener("close", () => {
      this.connected = false;
      this.h.onConnected?.(false);
    });
    this.socket.addEventListener("message", (e) => this.onMessage(e.data as string));
  }

  /** Am I allowed privileged actions right now? (mirrors RoomClient.canControl) */
  canControl(): boolean {
    return !this.sync || this.sync.mode === "open" || this.sync.hostId === this.self;
  }

  private onMessage(raw: string): void {
    const msg = parseServerMessage(raw);
    if (!msg) return;
    switch (msg.type) {
      case "welcome":
        this.self = msg.self;
        this.h.onWelcome?.(msg.self);
        break;
      case "sync":
        this.sync = msg;
        this.h.onSync?.(msg);
        break;
      case "members":
        this.members = msg.list;
        this.h.onMembers?.(msg.list);
        break;
      case "gate":
        this.gate = msg;
        this.h.onGate?.(msg);
        break;
      case "log":
        if (!this.log.some((e) => e.id === msg.event.id)) {
          this.log = [...this.log, msg.event].slice(-100);
          this.h.onLog?.(msg.event);
        }
        break;
      case "error":
        console.warn(`[sixseven] server error: ${msg.code} — ${msg.message}`);
        break;
    }
  }

  private send(msg: ClientMessage): void {
    this.socket.send(JSON.stringify(msg));
  }

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
  resync(): void {
    this.send({ type: "resync" });
  }

  destroy(): void {
    this.socket.close();
  }
}
