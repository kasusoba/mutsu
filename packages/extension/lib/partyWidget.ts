/**
 * PartyWidget (§11) — the in-page control surface for an own-tab watch party.
 *
 * A small floating bubble that's draggable and edge-magnetic (snaps to the
 * nearest screen edge on release). Click it to expand the panel: room code,
 * sync status, members, activity log, and Leave. It can be hidden entirely (the
 * popup mirrors all controls, so hiding it never strands you). Rendered in a
 * Shadow DOM so the host site's CSS can't bleed in or out. NO video controls —
 * the site has its own; we only show party state.
 */

import type { GateMessage, LogEvent, Member, MemberId, MemberStatus } from "@sixseven/protocol";
import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from "@sixseven/protocol/bridge";
import { browser } from "wxt/browser";
import type { SubResult } from "./roomSocket";
import type { TrackInfo } from "./videoHook";

interface WidgetState {
  connected: boolean;
  members: Member[];
  gate: GateMessage;
  selfId: MemberId | null;
  log: LogEvent[];
  playerStatus: MemberStatus;
  subLabel: string | null;
  subStyle: SubtitleStyle;
  tracks: TrackInfo[];
  selectedTrack: string | null;
  chat: { id: number; name: string; text: string; self: boolean }[];
}

interface WidgetOpts {
  code: string;
  sourceUrl: string;
  onLeave: () => void;
  /** Personal subtitle controls — owned by the controller. */
  subs: {
    loadFile: (file: File) => void;
    clear: () => void;
    patchStyle: (patch: Partial<SubtitleStyle>) => void;
    search: (query: string, season?: number, episode?: number) => Promise<SubResult[]>;
    loadResult: (r: SubResult) => Promise<void>;
    selectTrack: (id: string | null) => void;
  };
  /** Send an emoji reaction to the room (§14). */
  onReact: (emoji: string) => void;
  /** Send a chat message to the room (§14). */
  onChat: (text: string) => void;
}

const REACT_EMOJIS = ["😂", "❤️", "🔥", "👍", "😮", "😢", "🎉"];

const POS_KEY = "sixseven:widgetPos";
const HIDDEN_KEY = "sixseven:widgetHidden";

const STATUS_LABEL: Record<MemberStatus, string> = {
  loading: "loading",
  ready: "watching",
  stalled: "buffering",
  failed: "failed",
};

export class PartyWidget {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private expanded = false;
  private dragging = false;
  private moved = false;
  private state: WidgetState = {
    connected: false,
    members: [],
    gate: { type: "gate", paused: false, waitingFor: [] },
    selfId: null,
    log: [],
    playerStatus: "loading",
    subLabel: null,
    subStyle: { ...DEFAULT_SUBTITLE_STYLE },
    tracks: [],
    selectedTrack: null,
    chat: [],
  };

  constructor(private readonly opts: WidgetOpts) {}

  async mount(): Promise<void> {
    if (this.host) return;
    const host = document.createElement("div");
    host.id = "sixseven-party-widget";
    host.style.cssText = "position:fixed;z-index:2147483647;top:0;left:0;";
    this.host = host;
    this.root = host.attachShadow({ mode: "open" });
    this.root.innerHTML = this.template();
    (document.body ?? document.documentElement).append(host);

    this.wire();
    await this.restorePosition();
    const hidden = (await browser.storage.local.get(HIDDEN_KEY))[HIDDEN_KEY];
    if (hidden) this.setHidden(true);
    this.render();
  }

  update(partial: Partial<WidgetState>): void {
    Object.assign(this.state, partial);
    this.render();
  }

  setHidden(hidden: boolean): void {
    if (this.host) this.host.style.display = hidden ? "none" : "block";
    browser.storage.local.set({ [HIDDEN_KEY]: hidden });
  }

  destroy(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
  }

  // ── rendering ───────────────────────────────────────────────────────────────

  private $(sel: string): HTMLElement | null {
    return this.root?.querySelector(sel) ?? null;
  }

  private render(): void {
    if (!this.root) return;
    const s = this.state;
    const dot = this.$(".dot");
    if (dot) dot.className = `dot ${s.connected ? "on" : "off"}`;

    const status = this.$(".status");
    if (status) status.textContent = this.statusText();

    const count = this.$(".mcount");
    if (count) count.textContent = String(s.members.length);

    const bubbleCount = this.$(".bubble-count");
    if (bubbleCount) bubbleCount.textContent = String(s.members.length || "");

    const list = this.$(".members");
    if (list) {
      list.innerHTML = s.members
        .map((m) => {
          const you = m.id === s.selfId ? ' <span class="you">(you)</span>' : "";
          return `<li><span class="mdot ${m.status}"></span><span class="mname">${esc(m.name)}${you}</span><span class="mstat">${STATUS_LABEL[m.status]}</span></li>`;
        })
        .join("");
    }

    const log = this.$(".log");
    if (log) {
      log.innerHTML = s.log
        .slice(-30)
        .reverse()
        .map((e) => `<li>${esc(describe(e, s.members))}</li>`)
        .join("");
    }

    const chat = this.$(".chat");
    if (chat) {
      const atBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 4;
      chat.innerHTML = s.chat
        .slice(-50)
        .map((m) => `<li class="${m.self ? "me" : ""}"><span class="cn">${esc(m.name)}</span>${esc(m.text)}</li>`)
        .join("");
      if (atBottom) chat.scrollTop = chat.scrollHeight;
    }

    const subLabel = this.$(".sub-label");
    if (subLabel) subLabel.textContent = s.subLabel ?? "no subtitles";
    const tracksEl = this.$(".sub-tracks") as HTMLSelectElement | null;
    if (tracksEl) {
      (tracksEl as HTMLElement).hidden = s.tracks.length === 0;
      // Rebuild options only when the track set changes (don't clobber selection).
      const sig = s.tracks.map((t) => t.id).join(",");
      if (tracksEl.dataset.sig !== sig) {
        tracksEl.dataset.sig = sig;
        tracksEl.replaceChildren();
        const off = document.createElement("option");
        off.value = "";
        off.textContent = "Site captions: off";
        tracksEl.append(off);
        for (const t of s.tracks) {
          const o = document.createElement("option");
          o.value = t.id;
          o.textContent = `Site: ${t.label}`;
          tracksEl.append(o);
        }
      }
      tracksEl.value = s.selectedTrack ?? "";
    }
    const has = Boolean(s.subLabel);
    const subStyleRow = this.$(".sub-style");
    if (subStyleRow) (subStyleRow as HTMLElement).hidden = !has;
    const subStyle2 = this.$(".sub-style2");
    if (subStyle2) (subStyle2 as HTMLElement).hidden = !has;
    const offNumEl = this.$(".sub-off-num") as HTMLInputElement | null;
    if (offNumEl && this.root?.activeElement !== offNumEl) {
      offNumEl.value = (s.subStyle.offsetMs / 1000).toFixed(2);
    }
    const subPos = this.$(".sub-pos");
    if (subPos) subPos.textContent = s.subStyle.position;
    // Reflect the style sliders (only overwrite when not focused, so dragging
    // one doesn't fight the re-render).
    const setRange = (sel: string, v: number) => {
      const el = this.$(sel) as HTMLInputElement | null;
      if (el && this.root?.activeElement !== el) el.value = String(v);
    };
    setRange(".sub-offset", s.subStyle.offsetMs / 1000);
    setRange(".sub-size", s.subStyle.sizePct);
    setRange(".sub-dist", s.subStyle.marginPct);
    setRange(".sub-box", s.subStyle.background);
    const color = this.$(".sub-color") as HTMLInputElement | null;
    if (color && this.root?.activeElement !== color) color.value = s.subStyle.color;
  }

  private statusText(): string {
    const s = this.state;
    if (!s.connected) return "reconnecting…";
    if (s.gate.paused) return `waiting for ${s.gate.waitingFor.length} to buffer…`;
    if (s.playerStatus === "loading") return "loading the video…";
    if (s.playerStatus === "failed") return "no video found on this page";
    if (s.playerStatus === "stalled") return "buffering…";
    return "in sync";
  }

  // ── interaction (expand, drag, edge-snap) ───────────────────────────────────

  private wire(): void {
    const bubble = this.$(".bubble");
    const panel = this.$(".panel");
    bubble?.addEventListener("pointerdown", this.onDown);
    bubble?.addEventListener("click", () => {
      if (this.moved) return; // a drag, not a click
      this.expanded = !this.expanded;
      if (panel) panel.style.display = this.expanded ? "flex" : "none";
    });
    this.$(".copy")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(this.opts.code);
        const c = this.$(".copy");
        if (c) {
          c.textContent = "Copied ✓";
          setTimeout(() => c && (c.textContent = "Copy code"), 1400);
        }
      } catch {
        /* clipboard blocked — code is visible anyway */
      }
    });
    this.$(".hide")?.addEventListener("click", () => {
      this.expanded = false;
      const p = this.$(".panel");
      if (p) p.style.display = "none";
      this.setHidden(true);
    });
    this.$(".leave")?.addEventListener("click", () => this.opts.onLeave());

    for (const b of this.root?.querySelectorAll<HTMLButtonElement>(".react") ?? []) {
      b.addEventListener("click", () => this.opts.onReact(b.textContent ?? ""));
    }

    const chatIn = this.$(".chat-in") as HTMLInputElement | null;
    this.$(".chat-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const t = chatIn?.value.trim();
      if (t) {
        this.opts.onChat(t);
        if (chatIn) chatIn.value = "";
      }
    });

    // Subtitles (personal): file upload + offset/position.
    const fileInput = this.$(".sub-file") as HTMLInputElement | null;
    this.$(".sub-upload")?.addEventListener("click", () => fileInput?.click());
    fileInput?.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (f) this.opts.subs.loadFile(f);
      fileInput.value = "";
    });
    this.$(".sub-off-dn")?.addEventListener("click", () =>
      this.opts.subs.patchStyle({ offsetMs: this.state.subStyle.offsetMs - 100 }),
    );
    this.$(".sub-off-up")?.addEventListener("click", () =>
      this.opts.subs.patchStyle({ offsetMs: this.state.subStyle.offsetMs + 100 }),
    );
    const offset = this.$(".sub-offset") as HTMLInputElement | null;
    offset?.addEventListener("input", () =>
      this.opts.subs.patchStyle({ offsetMs: Math.round(+offset.value * 1000) }),
    );
    const offNum = this.$(".sub-off-num") as HTMLInputElement | null;
    offNum?.addEventListener("input", () =>
      this.opts.subs.patchStyle({ offsetMs: Math.round((+offNum.value || 0) * 1000) }),
    );
    this.$(".sub-pos")?.addEventListener("click", () =>
      this.opts.subs.patchStyle({
        position: this.state.subStyle.position === "bottom" ? "top" : "bottom",
      }),
    );
    this.$(".sub-clear")?.addEventListener("click", () => this.opts.subs.clear());

    const size = this.$(".sub-size") as HTMLInputElement | null;
    size?.addEventListener("input", () => this.opts.subs.patchStyle({ sizePct: +size.value }));
    const dist = this.$(".sub-dist") as HTMLInputElement | null;
    dist?.addEventListener("input", () => this.opts.subs.patchStyle({ marginPct: +dist.value }));
    const color = this.$(".sub-color") as HTMLInputElement | null;
    color?.addEventListener("input", () => this.opts.subs.patchStyle({ color: color.value }));
    const box = this.$(".sub-box") as HTMLInputElement | null;
    box?.addEventListener("input", () => this.opts.subs.patchStyle({ background: +box.value }));

    // Online subtitle search (member-gated proxy via the controller).
    const q = this.$(".sub-q") as HTMLInputElement | null;
    const seasonEl = this.$(".sub-season") as HTMLInputElement | null;
    const epEl = this.$(".sub-ep") as HTMLInputElement | null;
    const results = this.$(".sub-results");
    this.$(".sub-se-toggle")?.addEventListener("click", () => {
      const se = this.$(".sub-se");
      if (se) (se as HTMLElement).hidden = !(se as HTMLElement).hidden;
      this.$(".sub-se-toggle")?.classList.toggle("on");
    });
    const cancelBtn = this.$(".sub-cancel") as HTMLButtonElement | null;
    const clearSearch = () => {
      if (q) q.value = "";
      results?.replaceChildren();
      if (cancelBtn) cancelBtn.hidden = true;
    };
    cancelBtn?.addEventListener("click", clearSearch);

    const doSearch = async () => {
      const query = q?.value.trim();
      if (!query || !results) return;
      if (cancelBtn) cancelBtn.hidden = false;
      results.textContent = "Searching…";
      try {
        const hits = await this.opts.subs.search(
          query,
          seasonEl?.value ? +seasonEl.value : undefined,
          epEl?.value ? +epEl.value : undefined,
        );
        if (!hits.length) {
          results.textContent = "No subtitles found — try the exact title.";
          return;
        }
        results.replaceChildren();
        for (const r of hits.slice(0, 12)) {
          const b = document.createElement("button");
          b.className = "sub-result";
          const dl = r.downloads ? ` · ↓${r.downloads.toLocaleString()}` : "";
          b.innerHTML = `<span class="sr-title">${esc(r.release ?? r.title)}</span><span class="sr-meta">${esc(r.language)}${dl} · ${esc(r.provider)}</span>`;
          b.addEventListener("click", async () => {
            results.textContent = "Loading…";
            try {
              await this.opts.subs.loadResult(r);
              clearSearch();
            } catch (e) {
              results.textContent = (e as Error).message;
            }
          });
          results.append(b);
        }
      } catch (e) {
        results.textContent = (e as Error).message;
      }
    };
    this.$(".sub-go")?.addEventListener("click", doSearch);
    q?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") doSearch();
    });

    const tracks = this.$(".sub-tracks") as HTMLSelectElement | null;
    tracks?.addEventListener("change", () => this.opts.subs.selectTrack(tracks.value || null));
  }

  private onDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.moved = false;
    const host = this.host;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    host.style.transition = "none";
    const move = (ev: PointerEvent) => {
      if (!this.dragging) return;
      this.moved = true;
      host.style.left = `${ev.clientX - offX}px`;
      host.style.top = `${ev.clientY - offY}px`;
    };
    const up = () => {
      this.dragging = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (this.moved) this.snapToEdge();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Snap horizontally to the nearest screen edge with a little glide. */
  private snapToEdge(): void {
    const host = this.host;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 12;
    const side: "left" | "right" = rect.left + rect.width / 2 < vw / 2 ? "left" : "right";
    const top = Math.max(margin, Math.min(vh - rect.height - margin, rect.top));
    host.style.transition = "left 0.22s cubic-bezier(.22,1,.36,1), top 0.22s ease";
    host.style.left = side === "left" ? `${margin}px` : `${vw - rect.width - margin}px`;
    host.style.top = `${top}px`;
    browser.storage.local.set({ [POS_KEY]: { side, topPx: top } });
  }

  private async restorePosition(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const saved = (await browser.storage.local.get(POS_KEY))[POS_KEY] as
      | { side: "left" | "right"; topPx: number }
      | undefined;
    const margin = 12;
    const w = host.getBoundingClientRect().width || 52;
    const side = saved?.side ?? "right";
    const top = saved?.topPx ?? Math.round(window.innerHeight * 0.4);
    host.style.left = side === "left" ? `${margin}px` : `${window.innerWidth - w - margin}px`;
    host.style.top = `${top}px`;
  }

  // ── markup ──────────────────────────────────────────────────────────────────

  private template(): string {
    return `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .bubble {
    width: 52px; height: 52px; border-radius: 50%;
    background: #171922; border: 1px solid #2a2e3d; color: #e7e9ef;
    display: grid; place-items: center; cursor: grab; position: relative;
    box-shadow: 0 8px 28px rgba(0,0,0,.5); user-select: none; touch-action: none;
  }
  .bubble:active { cursor: grabbing; }
  .bubble .logo { font-weight: 800; font-size: 11px; letter-spacing: .5px; color: #6c7cff; }
  .bubble-count {
    position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
    padding: 0 5px; border-radius: 999px; background: #6c7cff; color: #fff;
    font-size: 11px; font-weight: 700; display: grid; place-items: center;
  }
  .bdot { position:absolute; bottom: 2px; right: 2px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #171922; }
  .panel {
    display: none; flex-direction: column; gap: 0; position: absolute; bottom: 0; right: 60px;
    width: 280px; max-height: 70vh; background: #171922; color: #e7e9ef;
    border: 1px solid #2a2e3d; border-radius: 14px; overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0,0,0,.55);
  }
  .head { display:flex; align-items:center; gap:8px; padding: 10px 12px; border-bottom: 1px solid #2a2e3d; }
  .head .logo { font-weight: 800; letter-spacing: .5px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .dot.on { background:#41d18a; } .dot.off { background:#f5a623; }
  .head .code { margin-left:auto; font: 700 13px ui-monospace, monospace; letter-spacing:1px; color:#6c7cff; }
  .status { padding: 8px 12px; font-size: 12px; color: #9aa0b4; border-bottom: 1px solid #2a2e3d; }
  .reacts { display: flex; flex-wrap: wrap; gap: 2px; padding: 6px 10px; border-bottom: 1px solid #2a2e3d; }
  .react { background: none; border: none; font-size: 20px; line-height: 1; padding: 3px 5px; cursor: pointer; border-radius: 8px; }
  .react:hover { background: #1f2230; transform: scale(1.15); }
  .section-title { padding: 8px 12px 4px; font-size: 11px; text-transform: uppercase; letter-spacing:.5px; color:#9aa0b4; display:flex; gap:6px; }
  ul { list-style:none; margin:0; padding: 0 12px 8px; display:flex; flex-direction:column; gap:5px; }
  .members li { display:flex; align-items:center; gap:8px; font-size:13px; }
  .mdot { width:8px; height:8px; border-radius:50%; background:#9aa0b4; flex:none; }
  .mdot.ready{background:#41d18a;} .mdot.stalled{background:#f5a623;} .mdot.failed{background:#ff5d6c;}
  .mname{flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
  .you{color:#9aa0b4;}
  .mstat{font-size:11px; color:#9aa0b4;}
  .log { max-height: 110px; overflow:auto; }
  .log li { font-size:12px; color:#c7cad6; }
  .chat { max-height: 120px; overflow:auto; }
  .chat li { font-size:12px; color:#e7e9ef; word-break:break-word; }
  .chat li .cn { font-weight:700; color:#6c7cff; margin-right:4px; }
  .chat li.me .cn { color:#41d18a; }
  .chat-form { display:flex; gap:6px; padding:0 12px 8px; }
  .chat-in { flex:1; min-width:0; font:inherit; font-size:12px; color:#e7e9ef; background:#0e0f13; border:1px solid #2a2e3d; border-radius:6px; padding:5px 8px; }
  .subs { padding: 0 12px 8px; display:flex; flex-direction:column; gap:6px; }
  .sub-row { display:flex; align-items:center; gap:8px; }
  .sub-label { font-size:11px; color:#9aa0b4; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
  .sub-style { display:flex; align-items:center; gap:6px; }
  .sub-style[hidden], .sub-style2[hidden] { display:none; }
  .sub-off-num { width:56px; font:12px ui-monospace,monospace; text-align:right; color:#e7e9ef; background:#0e0f13; border:1px solid #2a2e3d; border-radius:6px; padding:4px 6px; }
  .sub-clear { margin-left:auto; color:#9aa0b4; }
  .subs button { padding:4px 8px; }
  .sub-style2 { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
  .sub-mini { font-size:11px; color:#9aa0b4; }
  .sub-range { flex:1; min-width:54px; accent-color:#6c7cff; }
  .sub-color { width:28px; height:24px; padding:0; border:1px solid #2a2e3d; background:none; border-radius:6px; cursor:pointer; }
  .sub-tracks { font:inherit; font-size:12px; color:#e7e9ef; background:#0e0f13; border:1px solid #2a2e3d; border-radius:6px; padding:5px 8px; width:100%; }
  .sub-tracks[hidden] { display:none; }
  .sub-search { display:flex; gap:6px; }
  .sub-se { display:flex; gap:6px; }
  .sub-se[hidden] { display:none; }
  .sub-q, .sub-se input { font:inherit; font-size:12px; color:#e7e9ef; background:#0e0f13; border:1px solid #2a2e3d; border-radius:6px; padding:5px 8px; }
  .sub-q { flex:1; min-width:0; }
  .sub-se input { flex:1; min-width:0; }
  .sub-se-toggle.on { border-color:#6c7cff; color:#6c7cff; }
  .sub-cancel[hidden] { display:none; }
  .sub-cancel { color:#9aa0b4; }
  .sub-results { display:flex; flex-direction:column; gap:4px; max-height:150px; overflow:auto; font-size:12px; color:#9aa0b4; }
  .sub-result { width:100%; text-align:left; display:flex; flex-direction:column; gap:2px; padding:5px 8px; }
  .sr-title { color:#e7e9ef; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sr-meta { font-size:10px; color:#9aa0b4; }
  .foot { display:flex; gap:8px; padding:10px 12px; border-top:1px solid #2a2e3d; }
  button { font:inherit; font-size:12px; cursor:pointer; border-radius:8px; padding:6px 10px; border:1px solid #2a2e3d; background:#1f2230; color:#e7e9ef; }
  button:hover { border-color:#6c7cff; }
  .copy { margin-left:auto; }
  .leave { color:#ff5d6c; border-color:#3a2730; }
</style>
<div class="bubble" title="sixseven watch party — drag me, click to open">
  <svg class="logo" viewBox="0 0 24 24" width="22" height="22" fill="#6c7cff" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
  <span class="bubble-count"></span>
  <span class="bdot dot off"></span>
</div>
<div class="panel">
  <div class="head"><span class="dot off"></span><span class="logo">sixseven</span><span class="code">${esc(this.opts.code)}</span></div>
  <div class="status">connecting…</div>
  <div class="reacts">${REACT_EMOJIS.map((e) => `<button class="react">${e}</button>`).join("")}</div>
  <div class="section-title">Members <span class="mcount">0</span></div>
  <ul class="members"></ul>
  <div class="section-title">Activity</div>
  <ul class="log"></ul>
  <div class="section-title">Chat</div>
  <ul class="chat"></ul>
  <form class="chat-form"><input class="chat-in" type="text" placeholder="Message…" maxlength="500" /><button class="chat-send">Send</button></form>
  <div class="section-title">Subtitles</div>
  <div class="subs">
    <div class="sub-row">
      <button class="sub-upload">Upload .srt / .vtt</button>
      <span class="sub-label">no subtitles</span>
    </div>
    <select class="sub-tracks" hidden></select>
    <div class="sub-search">
      <input class="sub-q" type="text" placeholder="search online — title" />
      <button class="sub-se-toggle" title="TV show?">S/E</button>
      <button class="sub-go">Search</button>
      <button class="sub-cancel" title="Clear search" hidden>✕</button>
    </div>
    <div class="sub-se" hidden>
      <input class="sub-season" type="number" min="1" placeholder="season" />
      <input class="sub-ep" type="number" min="1" placeholder="episode" />
    </div>
    <div class="sub-results"></div>
    <div class="sub-style" hidden>
      <span class="sub-mini">offset</span>
      <button class="sub-off-dn" title="−0.1s">−</button>
      <input class="sub-offset sub-range" type="range" min="-5" max="5" step="0.05" />
      <button class="sub-off-up" title="+0.1s">+</button>
      <input class="sub-off-num" type="number" step="0.05" /><span class="sub-mini">s</span>
    </div>
    <div class="sub-style2" hidden>
      <button class="sub-pos">bottom</button>
      <span class="sub-mini">size</span>
      <input class="sub-size sub-range" type="range" min="60" max="220" step="5" />
      <span class="sub-mini">dist</span>
      <input class="sub-dist sub-range" type="range" min="0" max="40" step="1" />
      <input class="sub-color" type="color" title="Text colour" />
      <span class="sub-mini">box</span>
      <input class="sub-box sub-range" type="range" min="0" max="1" step="0.1" />
      <button class="sub-clear">clear</button>
    </div>
    <input class="sub-file" type="file" accept=".srt,.vtt" hidden />
  </div>
  <div class="foot">
    <button class="hide" title="Hide the widget (controls stay in the popup)">Hide</button>
    <button class="copy">Copy code</button>
    <button class="leave">Leave</button>
  </div>
</div>`;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

function nameOf(id: string | undefined, members: Member[]): string {
  if (!id) return "someone";
  return members.find((m) => m.id === id)?.name ?? "someone";
}

function describe(e: LogEvent, members: Member[]): string {
  switch (e.kind) {
    case "joined": return `${e.detail ?? nameOf(e.actor, members)} joined`;
    case "left": return `${e.detail ?? nameOf(e.actor, members)} left`;
    case "played": return `${nameOf(e.actor, members)} pressed play`;
    case "paused": return `${nameOf(e.actor, members)} pressed pause`;
    case "setSource": return `${nameOf(e.actor, members)} set the source`;
    case "skipped": return `${nameOf(e.actor, members)} skipped ${nameOf(e.target, members)}`;
    case "autoSkipped": return `${nameOf(e.target, members)} was auto-skipped`;
    case "passedControl": return `${nameOf(e.actor, members)} gave host to ${nameOf(e.target, members)}`;
    case "modeChanged": return `mode → ${e.detail}`;
    case "hostPromoted": return `${nameOf(e.target, members)} promoted to host`;
    default: return e.kind;
  }
}
