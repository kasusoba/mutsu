/**
 * mutsu room backend — one PartyKit Durable Object per room (SPEC §6, §7).
 *
 * Responsibilities (Phase 1):
 *  - hold the authoritative Room state (SPEC §7)
 *  - be the SINGLE CLOCK: project playback time server-side so clients never
 *    do cross-clock math (SPEC §7 "single-clock rule")
 *  - enforce control-mode acceptance: open vs host (SPEC §8)
 *  - run the buffer gate: soft-pause vs hard-pause, 25s skip valve (SPEC §9)
 *  - heartbeat a `sync` every 3s while playing (SPEC §7)
 *  - survive hibernation: persist state to DO storage, resync on reconnect
 *
 * Non-goals held here (SPEC §3): no media bytes, no stream extraction, no
 * header/CORS/X-Frame-Options forging. This DO only relays control + state.
 */

import {
  type ClientMessage,
  type GateMessage,
  HEARTBEAT_MS,
  type Intent,
  type LogEvent,
  type LogKind,
  type Member,
  type MemberId,
  type MemberStatus,
  type Mode,
  SKIP_GRACE_MS,
  type ServerMessage,
  type SourceItem,
  type SourceKind,
  encode,
  parseClientMessage,
} from "@mutsu/protocol";
import { type Connection, type ConnectionContext, Server, routePartykitRequest } from "partyserver";
import { searchGifs } from "./gif.ts";
import { type RtcEnv, iceServers } from "./rtc.ts";
import { QuotaError, type SubEnv, downloadSubtitle, searchSubtitles } from "./subtitles/index.ts";

/** Worker bindings: the room Durable Object namespace + the server-side secrets
 *  (subtitle/GIF/TURN provider keys). Secrets come from `.dev.vars` in dev and
 *  `wrangler secret` in production — never the client. */
interface Env {
  /** DO namespace; binding name `Main` so routePartykitRequest maps the client's
   *  default party "main" (`/parties/main/<room>`) to this server. */
  Main: DurableObjectNamespace<RoomServer>;
  OPENSUBTITLES_API_KEY?: string;
  OS_USERNAME?: string;
  OS_PASSWORD?: string;
  SUBDL_API_KEY?: string;
  SUBS_PROVIDER_ORDER?: string;
  GIPHY_API_KEY?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

/** Per-room authoritative state, persisted under a single storage key. */
interface RoomState {
  src: string | null;
  /** How clients render `src`: framed embed, or our own direct player (SPEC §15 P4). */
  srcKind: SourceKind;
  intent: Intent;
  /** Position (s) as of `updatedAt`. */
  time: number;
  rate: number;
  /** SERVER clock (ms) — the basis for all drift projection. */
  updatedAt: number;
  mode: Mode;
  hostId: MemberId | null;
  /** Soft-pause: room is gated waiting on a stalled member (SPEC §9). */
  gated: boolean;
  /** Capability auth (SPEC §10). Established on first join (trust-on-first-use). */
  auth: { secret: string | null; open: boolean } | null;
  members: Record<MemberId, StoredMember>;
  /** Members currently buffering (subset of members). */
  stalled: MemberId[];
  /** Members dropped from the gate (subset of members). */
  skipped: MemberId[];
  /** When each stalled/failed member began waiting (ms), for the 25s grace. */
  waitingSince: Record<MemberId, number>;
  log: LogEvent[];
  /** Monotonic join counter — lowest seq = longest-connected (host promotion). */
  seq: number;
  /** Playlist (§16): queued sources + which one is playing. */
  queue: SourceItem[];
  currentId: string | null;
  /** Whether queue items start playing on their own (continuous playback). */
  autoplay: boolean;
}

interface StoredMember {
  name: string;
  status: MemberStatus;
  joinSeq: number;
  /** In the video call (§17), and publishing-camera hint. Ephemeral — reset on (re)join. */
  inCall?: boolean;
  cam?: boolean;
}

const STORAGE_KEY = "room";
const LOG_CAP = 100;
/** Max simultaneous video-call participants per room (§17). Caps the WebRTC mesh
 *  and keeps any TURN egress trivially inside the free tier. 2 = a 1:1 call. */
const CALL_CAP = 2;
/** A control whose time jumps more than this (s) from the live position is a
 *  user scrub, not drift — only those get logged as "seeked" (SPEC §11). */
const SEEK_LOG_THRESHOLD = 2;

/** Format a playback position (seconds) as m:ss or h:mm:ss for the activity log. */
function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function freshState(): RoomState {
  return {
    src: null,
    srcKind: "embed",
    intent: "paused",
    time: 0,
    rate: 1,
    updatedAt: 0,
    mode: "open",
    hostId: null,
    gated: false,
    auth: null,
    members: {},
    stalled: [],
    skipped: [],
    waitingSince: {},
    log: [],
    seq: 0,
    queue: [],
    currentId: null,
    autoplay: true,
  };
}

export class RoomServer extends Server<Env> {
  /** Enable hibernation; state lives in storage, not memory (SPEC §16 risk 7). */
  static override options = { hibernate: true };

  private s: RoomState = freshState();
  private loaded = false;
  /** Per-connection rate limit for the fun layer (§14), in-memory (ephemeral). */
  private sayBuckets = new Map<string, { count: number; resetAt: number }>();

  // ── lifecycle ───────────────────────────────────────────────────────────

  override async onStart(): Promise<void> {
    const saved = await this.ctx.storage.get<RoomState>(STORAGE_KEY);
    if (saved) this.s = saved;
    if (!this.s.srcKind) this.s.srcKind = "embed"; // storage predating srcKind
    if (!this.s.queue) this.s.queue = []; // storage predating the playlist (§16)
    if (this.s.currentId === undefined) this.s.currentId = null;
    if (this.s.autoplay === undefined) this.s.autoplay = true;
    // A (re)start drops every socket, but `members` was persisted — so anything
    // left over is a GHOST with no live connection. Prune them, or they sit in
    // presence (and possibly the gate, freezing the clock) forever. Real clients
    // re-join when their socket reconnects.
    this.pruneGhosts();
    this.loaded = true;
  }

  /** Drop members that no longer have a live connection (stale presence). */
  private pruneGhosts(): boolean {
    const live = new Set<string>();
    for (const conn of this.getConnections()) live.add(conn.id);
    let changed = false;
    for (const id of Object.keys(this.s.members)) {
      if (live.has(id)) continue;
      delete this.s.members[id];
      delete this.s.waitingSince[id];
      this.s.stalled = this.s.stalled.filter((x) => x !== id);
      this.s.skipped = this.s.skipped.filter((x) => x !== id);
      changed = true;
    }
    if (changed) this.recomputeGate();
    return changed;
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, this.s);
  }

  // ── subtitle proxy (SPEC §13) — HTTP, member-gated ────────────────────────
  // Proxies subtitle TEXT only (search JSON + KB-sized cue files), never video.
  // Same control-plane category as the sync clock; keeps provider keys server-side.

  override async onRequest(req: Request): Promise<Response> {
    if (!this.loaded) await this.onStart();
    const cors: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-mutsu-secret",
      "Access-Control-Max-Age": "86400",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return this.json({ error: "method" }, 405, cors);

    // Gate to room members: the room must be initialised and the caller must
    // present the capability secret (or the room is open). No anonymous use.
    const secret = req.headers.get("x-mutsu-secret");
    const ok = this.s.auth && (this.s.auth.open || this.s.auth.secret === (secret || null));
    if (!ok) return this.json({ error: "unauthorized" }, 401, cors);

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return this.json({ error: "bad json" }, 400, cors);
    }

    const env = this.env as unknown as SubEnv;
    try {
      if (body.op === "subs.search") {
        const results = await searchSubtitles(
          {
            query: String(body.query ?? ""),
            languages: typeof body.languages === "string" ? body.languages : undefined,
            season: typeof body.season === "number" ? body.season : undefined,
            episode: typeof body.episode === "number" ? body.episode : undefined,
          },
          env,
        );
        return this.json({ results }, 200, cors);
      }
      if (body.op === "subs.download") {
        const vtt = await downloadSubtitle(String(body.id ?? ""), env);
        return this.json({ vtt }, 200, cors);
      }
      if (body.op === "gif.search") {
        if (!env.GIPHY_API_KEY) return this.json({ error: "gif_not_configured" }, 200, cors);
        const results = await searchGifs(String(body.query ?? ""), env.GIPHY_API_KEY);
        return this.json({ results }, 200, cors);
      }
      if (body.op === "rtc.iceServers") {
        // Video call (§17): STUN always, TURN if keys are configured. Keys stay
        // server-side; the client only ever sees the resolved ICE-server list.
        const servers = await iceServers(this.env as unknown as RtcEnv);
        return this.json({ iceServers: servers }, 200, cors);
      }
      return this.json({ error: "unknown op" }, 400, cors);
    } catch (e) {
      if (e instanceof QuotaError)
        return this.json({ error: "quota", provider: e.provider }, 429, cors);
      return this.json({ error: (e as Error)?.message ?? "proxy error" }, 502, cors);
    }
  }

  private json(obj: unknown, status: number, extra: Record<string, string>): Response {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json", ...extra },
    });
  }

  override async onConnect(conn: Connection, _ctx: ConnectionContext): Promise<void> {
    if (!this.loaded) await this.onStart();
    // Not a member until a valid `join` arrives. Other messages are ignored
    // until then (admission gate, SPEC §10).
    conn.setState({ admitted: false });
  }

  override async onMessage(sender: Connection, message: string | ArrayBuffer): Promise<void> {
    if (!this.loaded) await this.onStart();
    // Clients send text frames (protocol `encode` → JSON string); decode the
    // rare binary frame defensively so a stray ArrayBuffer can't crash the DO.
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    const msg = parseClientMessage(raw);
    if (!msg) return this.reject(sender, "bad_message", "unparseable message");

    if (msg.type === "join") return this.handleJoin(sender, msg);

    const state = sender.state as { admitted?: boolean; observer?: boolean } | undefined;
    if (!state?.admitted) {
      return this.reject(sender, "not_admitted", "send `join` first");
    }
    // Observers are read-only: they can refresh their snapshot but never mutate
    // room state (they aren't even members). Anything else is silently dropped.
    if (state.observer) {
      if (msg.type === "resync") {
        this.send(sender, this.syncMessage(Date.now(), false));
        this.send(sender, this.gateMessage());
      }
      return;
    }

    switch (msg.type) {
      case "setSource":
        return this.handleSetSource(sender, msg.src, msg.kind);
      case "control":
        return this.handleControl(sender, msg.intent, msg.time, msg.rate);
      case "setMode":
        return this.handleSetMode(sender, msg.mode);
      case "passControl":
        return this.handlePassControl(sender, msg.toId);
      case "status":
        return this.handleStatus(sender, msg.state);
      case "skip":
        return this.handleSkip(sender, msg.memberId);
      case "resync":
        // Not a command — let the client glide small drift (a brief reconnect)
        // and only hard-seek if it's genuinely far off.
        this.send(sender, this.syncMessage(Date.now(), false));
        this.send(sender, this.gateMessage());
        return;
      case "say":
        return this.handleSay(sender, msg.kind, msg.text);
      case "queueAdd":
        return void this.handleQueueAdd(sender, msg.src, msg.kind, msg.title);
      case "queueRemove":
        return void this.handleQueueRemove(sender, msg.id);
      case "queueClear":
        return void this.handleQueueClear(sender);
      case "playItem":
        return void this.handlePlayItem(sender, msg.id);
      case "queueReorder":
        return void this.handleQueueReorder(sender, msg.id, msg.toIndex);
      case "playNext":
        return void this.handlePlayNext(sender, msg.afterId);
      case "setAutoplay":
        return void this.handleSetAutoplay(sender, msg.on);
      case "setCall":
        return this.handleSetCall(sender, msg.on);
      case "setCam":
        return this.handleSetCam(sender, msg.on);
      case "rtcSignal":
        return this.handleRtcSignal(sender, msg.to, msg.data);
    }
  }

  override async onClose(
    conn: Connection,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    if (!this.loaded) await this.onStart();
    const member = this.s.members[conn.id];
    if (!member) return; // never admitted
    const name = member.name;

    delete this.s.members[conn.id];
    delete this.s.waitingSince[conn.id];
    this.s.stalled = this.s.stalled.filter((id) => id !== conn.id);
    this.s.skipped = this.s.skipped.filter((id) => id !== conn.id);

    this.appendLog({ kind: "left", actor: conn.id, detail: name });

    // Host disconnect (host mode): promote longest-connected, else fall back to
    // open (SPEC §8).
    if (this.s.mode === "host" && this.s.hostId === conn.id) {
      const next = this.longestConnected();
      if (next) {
        this.s.hostId = next;
        this.appendLog({ kind: "hostPromoted", target: next });
      } else {
        this.s.mode = "open";
        this.s.hostId = null;
        this.appendLog({ kind: "modeChanged", detail: "open" });
      }
    }

    this.recomputeGate(); // membership change may clear the gate
    this.broadcastMembers();
    this.broadcastGate();
    // A peer leaving is a presence change, not a playback command — `force:false`
    // so the remaining viewers don't snap/seek. (With 2 devices over a flaky
    // tunnel, peer drops/reconnects were forcing seeks on the other device.)
    this.broadcastSync(false);
    await this.persist();
  }

  // ── message handlers ──────────────────────────────────────────────────────

  private async handleJoin(
    sender: Connection,
    msg: Extract<ClientMessage, { type: "join" }>,
  ): Promise<void> {
    // Trust-on-first-use: the first join establishes the room secret (the
    // capability URL's fragment). Later joins must match, unless open (SPEC §10).
    const isNewRoom = !this.s.auth;
    if (!this.s.auth) {
      this.s.auth = { secret: msg.secret ?? null, open: false };
    } else if (!this.s.auth.open && this.s.auth.secret !== (msg.secret ?? null)) {
      this.reject(sender, "unauthorized", "bad room secret");
      sender.close(4001, "unauthorized");
      return;
    }

    // Observer join (own-tab §11): admit + snapshot the current truth, but stay
    // OUT of presence — no members entry, no log, never holds the gate. Used by
    // the own-tab popup to read a room's source before the user is on it.
    if (msg.observer) {
      sender.setState({ admitted: true, observer: true });
      this.send(sender, { type: "welcome", self: sender.id });
      this.send(sender, this.syncMessage(Date.now(), false));
      this.send(sender, this.membersMessage());
      this.send(sender, this.gateMessage());
      this.send(sender, this.playlistMessage());
      return;
    }

    // Clear out any dead peers first (e.g. a tab that closed without a clean
    // disconnect) so presence reflects who's actually here.
    this.pruneGhosts();

    const name = (msg.name ?? "").trim() || "anon";
    const isReconnect = Boolean(this.s.members[sender.id]);
    const joinSeq = this.s.members[sender.id]?.joinSeq ?? this.s.seq++;
    this.s.members[sender.id] = { name, status: "loading", joinSeq };
    sender.setState({ admitted: true });

    // The room's creator picks the control mode up front (M2). Honour it only on
    // the join that CREATES the room — the creator becomes host. Later joins (and
    // reconnects) carry no authority to reset mode; that's `setMode`/`passControl`.
    if (isNewRoom && msg.mode === "host") {
      this.s.mode = "host";
      this.s.hostId = sender.id;
    }

    if (!isReconnect) this.appendLog({ kind: "joined", actor: sender.id, detail: name });

    // Snapshot for the (re)joining client: who they are + current truth. The
    // sync is force=false: a first join is far off → hard-seek catches up; a
    // brief reconnect is ~in place → glide, don't snap (the tunnel-reconnect
    // jitter). Real commands are what force a snap.
    this.send(sender, { type: "welcome", self: sender.id });
    this.send(sender, this.syncMessage(Date.now(), false));
    this.send(sender, this.membersMessage());
    this.send(sender, this.gateMessage());
    this.send(sender, this.playlistMessage());
    for (const event of this.s.log.slice(-20)) this.send(sender, { type: "log", event });

    this.broadcastMembers();
    await this.persist();
  }

  private async handleSetSource(sender: Connection, src: string, kind?: SourceKind): Promise<void> {
    if (!this.canControl(sender.id)) return this.correct(sender);
    this.s.currentId = null; // a manually-set source isn't a queue item
    await this.applySource(src, kind, sender.id);
    this.broadcastPlaylist();
  }

  /** Apply a new room source (reset clock/gate, everyone reloads). Shared by
   *  manual setSource and playing a queue item (§16). No permission check. */
  private async applySource(
    src: string,
    kind: SourceKind | undefined,
    actor: MemberId,
    play = false,
  ): Promise<void> {
    const now = Date.now();
    this.s.src = src;
    this.s.srcKind = kind === "direct" || kind === "site" || kind === "youtube" ? kind : "embed";
    // Autoplay queue items start `playing`; the buffer gate still holds until
    // everyone's loaded (a not-ready client reports stalled → soft-pause).
    this.s.intent = play ? "playing" : "paused";
    this.s.time = 0;
    this.s.rate = 1;
    this.s.updatedAt = now;
    this.s.gated = false;
    this.s.stalled = [];
    this.s.skipped = [];
    this.s.waitingSince = {};
    // Everyone must reload the new source before it can play.
    for (const id of Object.keys(this.s.members)) {
      const m = this.s.members[id];
      if (m) m.status = "loading";
    }

    this.appendLog({ kind: "setSource", actor, detail: src });
    this.broadcastSync();
    this.broadcastMembers();
    this.broadcastGate();
    await this.persist();
  }

  // ── playlist (§16) ──────────────────────────────────────────────────────────

  private async handleQueueAdd(
    sender: Connection,
    src: string,
    kind?: SourceKind,
    title?: string,
  ): Promise<void> {
    if (!this.canControl(sender.id)) return this.correct(sender);
    if (typeof src !== "string" || !src.trim()) return;
    const item: SourceItem = {
      id: `q${this.s.seq++}`,
      src,
      kind: kind === "direct" || kind === "site" || kind === "youtube" ? kind : "embed",
      title: typeof title === "string" ? title.slice(0, 200) : undefined,
    };
    this.s.queue.push(item);
    // If nothing is playing yet, start this one.
    if (!this.s.src) {
      this.s.currentId = item.id;
      await this.applySource(item.src, item.kind, sender.id);
    }
    this.broadcastPlaylist();
    await this.persist();
  }

  private async handleQueueRemove(sender: Connection, id: string): Promise<void> {
    if (!this.canControl(sender.id)) return this.correct(sender);
    this.s.queue = this.s.queue.filter((i) => i.id !== id);
    if (this.s.currentId === id) this.s.currentId = null;
    this.broadcastPlaylist();
    await this.persist();
  }

  private async handleQueueClear(sender: Connection): Promise<void> {
    if (!this.canControl(sender.id)) return this.correct(sender);
    this.s.queue = [];
    this.s.currentId = null;
    this.broadcastPlaylist();
    await this.persist();
  }

  private async handlePlayItem(sender: Connection, id: string): Promise<void> {
    if (!this.canControl(sender.id)) return this.correct(sender);
    const item = this.s.queue.find((i) => i.id === id);
    if (!item) return;
    this.s.currentId = id;
    await this.applySource(item.src, item.kind, sender.id, this.s.autoplay);
    this.broadcastPlaylist();
  }

  private async handlePlayNext(sender: Connection, afterId?: string | null): Promise<void> {
    if (!this.canControl(sender.id)) return this.correct(sender);
    // Dedup auto-advance from multiple clients: only advance if the item the
    // sender saw end is still the current one.
    if (afterId != null && this.s.currentId !== afterId) return;
    const i = this.s.queue.findIndex((x) => x.id === this.s.currentId);
    const next = i >= 0 ? this.s.queue[i + 1] : this.s.queue[0];
    if (!next) return; // end of queue — stop
    this.s.currentId = next.id;
    await this.applySource(next.src, next.kind, sender.id, this.s.autoplay);
    this.broadcastPlaylist();
  }

  private async handleSetAutoplay(sender: Connection, on: boolean): Promise<void> {
    if (!this.canControl(sender.id)) return this.correct(sender);
    this.s.autoplay = Boolean(on);
    this.broadcastPlaylist();
    await this.persist();
  }

  // ── video call (§17) ──────────────────────────────────────────────────────

  /** Join/leave the call, capped at CALL_CAP participants. Joining just flips
   *  presence — peers open a connection to whoever is `inCall`; the SDP/ICE
   *  handshake is relayed peer-to-peer via `rtcSignal`. You can be in the call
   *  without publishing (watch-only); leaving also clears the camera hint. */
  private handleSetCall(sender: Connection, on: boolean): void {
    const member = this.s.members[sender.id];
    if (!member) return;
    if (on && !member.inCall) {
      const inCall = Object.values(this.s.members).filter((m) => m.inCall).length;
      if (inCall >= CALL_CAP) {
        this.reject(sender, "call_full", `Video chat is limited to ${CALL_CAP} people in a room.`);
        return;
      }
    }
    member.inCall = Boolean(on);
    if (!on) member.cam = false;
    this.broadcastMembers();
  }

  /** Camera-publishing display hint (no cap; only meaningful while in the call). */
  private handleSetCam(sender: Connection, on: boolean): void {
    const member = this.s.members[sender.id];
    if (!member || !member.inCall) return;
    member.cam = Boolean(on);
    this.broadcastMembers();
  }

  /** Relay a WebRTC signal (SDP/ICE) to ONE peer. The server never inspects the
   *  payload — control-plane text only, no media (the call is peer-to-peer). */
  private handleRtcSignal(sender: Connection, to: MemberId, data: unknown): void {
    if (typeof to !== "string" || !this.s.members[to] || !this.s.members[sender.id]) return;
    const peer = this.getConnection(to);
    if (peer) this.send(peer, { type: "rtcSignal", from: sender.id, data });
  }

  private async handleQueueReorder(sender: Connection, id: string, toIndex: number): Promise<void> {
    if (!this.canControl(sender.id)) return this.correct(sender);
    const from = this.s.queue.findIndex((x) => x.id === id);
    if (from < 0 || typeof toIndex !== "number") return;
    const [item] = this.s.queue.splice(from, 1);
    if (!item) return;
    const to = Math.max(0, Math.min(this.s.queue.length, Math.floor(toIndex)));
    this.s.queue.splice(to, 0, item);
    this.broadcastPlaylist();
    await this.persist();
  }

  private playlistMessage(): ServerMessage {
    return {
      type: "playlist",
      items: this.s.queue,
      currentId: this.s.currentId,
      autoplay: this.s.autoplay,
    };
  }
  private broadcastPlaylist(): void {
    this.broadcast(encode(this.playlistMessage()));
  }

  private async handleControl(
    sender: Connection,
    intent: Intent,
    time: number,
    rate?: number,
  ): Promise<void> {
    if (!this.canControl(sender.id)) return this.correct(sender);
    if (intent !== "playing" && intent !== "paused") return;
    if (typeof time !== "number" || !Number.isFinite(time)) return;

    const now = Date.now();
    // A control reuses the same intent for a seek, so distinguish: a play/pause
    // TRANSITION logs played/paused; otherwise a big jump from where the clock
    // actually is right now means the user scrubbed → log "seeked to <time>".
    // The threshold keeps routine drift corrections out of the log (SPEC §11).
    if (intent !== this.s.intent) {
      this.appendLog({ kind: intent === "playing" ? "played" : "paused", actor: sender.id });
    } else {
      const projected =
        this.s.intent === "playing"
          ? this.s.time + ((now - this.s.updatedAt) / 1000) * this.s.rate
          : this.s.time;
      if (Math.abs(time - projected) > SEEK_LOG_THRESHOLD) {
        this.appendLog({ kind: "seeked", actor: sender.id, detail: fmtClock(time) });
      }
    }
    this.s.intent = intent;
    this.s.time = Math.max(0, time);
    this.s.updatedAt = now;
    if (typeof rate === "number" && rate > 0) this.s.rate = rate;

    // Pausing/seeking can clear or re-arm the gate; recompute then broadcast.
    this.recomputeGate();
    this.broadcastSync();
    this.broadcastGate();
    await this.scheduleHeartbeat();
    await this.persist();
  }

  private async handleSetMode(sender: Connection, mode: Mode): Promise<void> {
    if (mode !== "open" && mode !== "host") return;
    // setMode is privileged the same way control is (SPEC §8/§12).
    if (!this.canControl(sender.id)) return this.correct(sender);

    this.s.mode = mode;
    this.s.hostId = mode === "host" ? sender.id : null;
    this.appendLog({ kind: "modeChanged", actor: sender.id, detail: mode });
    this.broadcastSync(false); // mode change carries no new position — don't seek
    await this.persist();
  }

  private async handlePassControl(sender: Connection, toId: MemberId): Promise<void> {
    // Only the current host in host mode can hand off (SPEC §8).
    if (this.s.mode !== "host" || sender.id !== this.s.hostId) return this.correct(sender);
    if (!this.s.members[toId]) return;

    this.s.hostId = toId;
    this.appendLog({ kind: "passedControl", actor: sender.id, target: toId });
    this.broadcastSync(false); // host handoff carries no new position — don't seek
    await this.persist();
  }

  private async handleStatus(sender: Connection, state: MemberStatus): Promise<void> {
    const member = this.s.members[sender.id];
    if (!member) return;
    member.status = state;

    const blocking = state === "stalled" || state === "failed";
    if (blocking) {
      if (!this.s.stalled.includes(sender.id)) this.s.stalled.push(sender.id);
      this.s.waitingSince[sender.id] ??= Date.now();
    } else {
      this.s.stalled = this.s.stalled.filter((id) => id !== sender.id);
      delete this.s.waitingSince[sender.id];
      // A recovered member that was skipped rejoins at live (SPEC §9).
      this.s.skipped = this.s.skipped.filter((id) => id !== sender.id);
    }

    const gateFlipped = this.recomputeGate();
    this.broadcastMembers();
    // On a gate flip the clock was rebased — push a fresh `sync` so clients
    // project from the current position, not a stale one. But mark it
    // `force:false`: a gate flip is a soft pause/resume, not a command, so it
    // should only correct genuinely-large drift (>1s), never snap on a 0.3s
    // wobble — otherwise a buffering peer makes everyone jitter.
    if (gateFlipped) this.broadcastSync(false);
    this.broadcastGate();
    await this.scheduleHeartbeat();
    await this.persist();
  }

  private async handleSkip(sender: Connection, memberId: MemberId): Promise<void> {
    // Skipping is permissioned by the control mode (SPEC §9).
    if (!this.canControl(sender.id)) return this.correct(sender);
    if (!this.s.members[memberId]) return;

    if (!this.s.skipped.includes(memberId)) this.s.skipped.push(memberId);
    this.s.stalled = this.s.stalled.filter((id) => id !== memberId);
    delete this.s.waitingSince[memberId];

    this.appendLog({ kind: "skipped", actor: sender.id, target: memberId });
    this.recomputeGate(); // skipping may release the gate — but never moves in-sync members
    this.broadcastMembers();
    this.broadcastGate();
    this.broadcastSync(false); // skip resumes in place — in-sync members must not seek
    await this.persist();
  }

  // ── fun layer (§14): ephemeral reaction / chat / gif fan-out ───────────────

  private handleSay(sender: Connection, kind: unknown, text: unknown): void {
    const member = this.s.members[sender.id];
    if (!member) return;
    if (kind !== "reaction" && kind !== "chat" && kind !== "gif") return;
    const clean = String(text ?? "")
      .slice(0, kind === "chat" ? 500 : 400)
      .trim();
    if (!clean) return;

    // Light per-connection rate limit so a key-spammer can't flood the room.
    const now = Date.now();
    const b = this.sayBuckets.get(sender.id);
    if (!b || now > b.resetAt) {
      this.sayBuckets.set(sender.id, { count: 1, resetAt: now + 4000 });
    } else if (b.count >= 12) {
      return; // over budget — drop silently
    } else {
      b.count++;
    }

    // Fan out and forget — never stored in room state (it's not playback truth).
    this.broadcast(
      encode({ type: "event", kind, text: clean, from: sender.id, name: member.name, at: now }),
    );
  }

  // ── the single clock (SPEC §7) ────────────────────────────────────────────

  /** True playback advances only when intent is playing AND the gate is clear. */
  private effectivePlaying(): boolean {
    return this.s.intent === "playing" && !this.s.gated;
  }

  /** Project the room position to `now` using the server's own clock. */
  private projectedTime(now: number): number {
    if (!this.effectivePlaying()) return this.s.time;
    return this.s.time + ((now - this.s.updatedAt) / 1000) * this.s.rate;
  }

  /**
   * Re-base the clock: capture the current projected position into `time` and
   * reset `updatedAt`. Call this immediately BEFORE any change that flips
   * `effectivePlaying` (gate on/off) so the soft-pause doesn't lose or gain time.
   */
  private rebase(now: number): void {
    this.s.time = this.projectedTime(now);
    this.s.updatedAt = now;
  }

  // ── buffer gate (SPEC §9) ─────────────────────────────────────────────────

  /** Members blocking the gate: stalled/failed, not skipped, still present. */
  private blockingMembers(): MemberId[] {
    return this.s.stalled.filter((id) => !this.s.skipped.includes(id) && this.s.members[id]);
  }

  /**
   * Recompute the soft gate. If the effective-playing state flips, rebase the
   * clock first so the projected position freezes/resumes cleanly. Returns
   * whether the gate flipped — callers must then broadcast a fresh `sync`, since
   * rebasing moved `time`/`updatedAt` and any stale client `time` would seek.
   */
  private recomputeGate(): boolean {
    // Never gate a solo room: there's no one to wait for, and gating yourself
    // freezes the server clock while your own video keeps playing — which then
    // makes every heartbeat seek you backward (the reported 3s-cycle jitter).
    const memberCount = Object.keys(this.s.members).length;
    const shouldGate =
      memberCount > 1 && this.s.intent === "playing" && this.blockingMembers().length > 0;
    if (shouldGate === this.s.gated) return false;
    this.rebase(Date.now());
    this.s.gated = shouldGate;
    return true;
  }

  // ── heartbeat + auto-skip (SPEC §7, §9) ───────────────────────────────────

  /**
   * Arm the storage alarm while intent is playing. One alarm drives both the 3s
   * heartbeat (when ungated) and the 25s skip-grace check (when gated). Survives
   * hibernation because it's storage-backed.
   */
  private async scheduleHeartbeat(): Promise<void> {
    if (this.s.intent === "playing") {
      const existing = await this.ctx.storage.getAlarm();
      if (existing == null) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    }
  }

  override async onAlarm(): Promise<void> {
    if (!this.loaded) await this.onStart();
    const now = Date.now();

    // 25s grace: auto-skip anyone stalled/failed too long so the room never
    // freezes (SPEC §9). Failed members are skippable on the same grace.
    let changed = false;
    for (const id of this.blockingMembers()) {
      const since = this.s.waitingSince[id];
      if (since != null && now - since >= SKIP_GRACE_MS) {
        this.s.skipped.push(id);
        this.s.stalled = this.s.stalled.filter((x) => x !== id);
        delete this.s.waitingSince[id];
        this.appendLog({ kind: "autoSkipped", target: id });
        changed = true;
      }
    }
    if (changed) {
      this.recomputeGate();
      this.broadcastMembers();
      this.broadcastGate();
    }

    // Heartbeat to mop up slow drift while actually playing (SPEC §7). Marked
    // force=false so a solo viewer doesn't snap to it mid-playback (the jitter).
    if (this.effectivePlaying()) this.broadcastSync(false);

    // Re-arm while still playing; otherwise let the alarm lapse.
    if (this.s.intent === "playing") {
      await this.ctx.storage.setAlarm(now + HEARTBEAT_MS);
    }
    await this.persist();
  }

  // ── permissions (SPEC §8) ─────────────────────────────────────────────────

  /** Server-enforced acceptance: open mode, or the sender is the host. */
  private canControl(id: MemberId): boolean {
    return this.s.mode === "open" || id === this.s.hostId;
  }

  /** Send the rejected sender a corrective sync so they snap back (SPEC §8). */
  private correct(conn: Connection): void {
    this.send(conn, this.syncMessage(Date.now()));
  }

  private longestConnected(): MemberId | null {
    let best: MemberId | null = null;
    let bestSeq = Number.POSITIVE_INFINITY;
    for (const [id, m] of Object.entries(this.s.members)) {
      if (m.joinSeq < bestSeq) {
        bestSeq = m.joinSeq;
        best = id;
      }
    }
    return best;
  }

  // ── message builders / senders ────────────────────────────────────────────

  /** `force` = a real command (snap to it); false = a routine heartbeat tick. */
  private syncMessage(now: number, force = true): ServerMessage {
    return {
      type: "sync",
      src: this.s.src,
      srcKind: this.s.srcKind ?? "embed",
      intent: this.s.intent,
      time: this.projectedTime(now),
      rate: this.s.rate,
      mode: this.s.mode,
      hostId: this.s.hostId,
      force,
    };
  }

  private membersMessage(): ServerMessage {
    const list: Member[] = Object.entries(this.s.members).map(([id, m]) => ({
      id,
      name: m.name,
      status: m.status,
      inCall: m.inCall ?? false,
      cam: m.cam ?? false,
    }));
    return { type: "members", list };
  }

  private gateMessage(): GateMessage {
    return { type: "gate", paused: this.s.gated, waitingFor: this.blockingMembers() };
  }

  private appendLog(partial: Omit<LogEvent, "id" | "at">): void {
    const event: LogEvent = { ...partial, id: `${this.s.seq++}`, at: Date.now() };
    this.s.log.push(event);
    if (this.s.log.length > LOG_CAP) this.s.log = this.s.log.slice(-LOG_CAP);
    this.broadcast(encode({ type: "log", event }));
  }

  /** `force` defaults true (a command); the heartbeat passes false. */
  private broadcastSync(force = true): void {
    this.broadcast(encode(this.syncMessage(Date.now(), force)));
  }

  private broadcastMembers(): void {
    this.broadcast(encode(this.membersMessage()));
  }

  private broadcastGate(): void {
    this.broadcast(encode(this.gateMessage()));
  }

  private send(conn: Connection, msg: ServerMessage): void {
    conn.send(encode(msg));
  }

  private reject(conn: Connection, code: string, message: string): void {
    conn.send(encode({ type: "error", code: code as never, message }));
  }
}

/**
 * Worker entry. `routePartykitRequest` matches `/parties/:server/:room` against
 * the DO bindings (server = kebab-cased binding name), so the client's default
 * party "main" → the `Main` binding → a `RoomServer` instance per room. Handles
 * both the WebSocket upgrade (sync) and the HTTP POST (subtitle/GIF/ICE proxy,
 * via the DO's `onRequest`). Same `/parties/main/<room>` URLs as before, so no
 * client change.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env as never)) ??
      new Response("Not Found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
