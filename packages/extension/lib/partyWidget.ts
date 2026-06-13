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

import type { GateMessage, Member, MemberId, MemberStatus } from "@sixseven/protocol";
import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from "@sixseven/protocol/bridge";
import { browser } from "wxt/browser";
import type { GifResult, SubResult } from "./roomSocket";
import type { TrackInfo } from "./videoHook";

interface WidgetState {
  connected: boolean;
  members: Member[];
  gate: GateMessage;
  selfId: MemberId | null;
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
  /** Send a GIF (by URL) to the room (§14). */
  onGif: (url: string) => void;
  /** Search GIPHY via the proxy. */
  gifSearch: (query: string) => Promise<GifResult[]>;
}

type FavGif = GifResult & { q: string };
const GIF_FAV_KEY = "sixseven:gifFavs";

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
  // GIF picker state (§14).
  private gifTab: "search" | "favs" = "search";
  private gifResults: GifResult[] = [];
  private gifFavs: FavGif[] = [];
  private state: WidgetState = {
    connected: false,
    members: [],
    gate: { type: "gate", paused: false, waitingFor: [] },
    selfId: null,
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
    const savedFavs = (await browser.storage.local.get(GIF_FAV_KEY))[GIF_FAV_KEY];
    if (Array.isArray(savedFavs)) this.gifFavs = savedFavs as FavGif[];
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
    const dot = this.$(".head .dot");
    if (dot) dot.className = `dot ${s.connected ? "on" : "off"}`;

    const status = this.$(".status");
    if (status) status.textContent = this.statusText();

    const count = this.$(".mcount");
    if (count) count.textContent = String(s.members.length);

    // Bubble: keep it clean — show the member count only when there's more than
    // you, and the warning dot only when disconnected.
    const bubbleCount = this.$(".bubble-count");
    if (bubbleCount) {
      bubbleCount.textContent = String(s.members.length);
      (bubbleCount as HTMLElement).hidden = s.members.length <= 1;
    }
    const bdot = this.$(".bdot");
    if (bdot) (bdot as HTMLElement).hidden = s.connected;

    const list = this.$(".members");
    if (list) {
      list.innerHTML = s.members
        .map((m) => {
          const you = m.id === s.selfId ? ' <span class="you">(you)</span>' : "";
          return `<li><span class="mdot ${m.status}"></span><span class="mname">${esc(m.name)}${you}</span><span class="mstat">${STATUS_LABEL[m.status]}</span></li>`;
        })
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

  // ── GIF picker grid ──────────────────────────────────────────────────────────

  private renderGifGrid(): void {
    const grid = this.$(".gif-grid");
    if (!grid) return;
    let items: GifResult[];
    if (this.gifTab === "favs") {
      if (!this.gifFavs.length) {
        grid.innerHTML = `<div class="gif-msg">No favorites yet — star a GIF from Search.</div>`;
        return;
      }
      const f = (this.$(".gif-q") as HTMLInputElement | null)?.value.trim().toLowerCase() ?? "";
      items = f ? this.gifFavs.filter((g) => g.q.toLowerCase().includes(f)) : this.gifFavs;
    } else {
      items = this.gifResults;
    }
    grid.replaceChildren();
    for (const g of items) {
      const tile = document.createElement("div");
      tile.className = "gtile";
      const send = document.createElement("button");
      send.className = "gsend";
      send.title = "Send";
      const img = document.createElement("img");
      img.src = g.preview;
      img.alt = "gif";
      img.loading = "lazy";
      send.append(img);
      send.addEventListener("click", () => this.opts.onGif(g.url));
      const star = document.createElement("button");
      star.className = "gstar";
      star.textContent = "★";
      star.classList.toggle("on", this.gifFavs.some((f) => f.url === g.url));
      star.addEventListener("click", () => this.toggleGifFav(g));
      tile.append(send, star);
      grid.append(tile);
    }
  }

  private toggleGifFav(g: GifResult): void {
    const exists = this.gifFavs.some((f) => f.url === g.url);
    const q = (this.$(".gif-q") as HTMLInputElement | null)?.value.trim() ?? "";
    this.gifFavs = exists
      ? this.gifFavs.filter((f) => f.url !== g.url)
      : [{ ...g, q }, ...this.gifFavs].slice(0, 60);
    browser.storage.local.set({ [GIF_FAV_KEY]: this.gifFavs });
    this.renderGifGrid();
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
      if (this.expanded) this.positionPanel();
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

    this.$(".sub-toggle")?.addEventListener("click", () => {
      const body = this.$(".subs");
      const t = this.$(".sub-toggle");
      if (!body) return;
      const show = (body as HTMLElement).hidden;
      (body as HTMLElement).hidden = !show;
      t?.classList.toggle("open", show);
    });

    // ── GIF picker ──
    this.$(".gif-toggle")?.addEventListener("click", () => {
      const body = this.$(".gifs");
      const t = this.$(".gif-toggle");
      if (!body) return;
      const show = (body as HTMLElement).hidden;
      (body as HTMLElement).hidden = !show;
      t?.classList.toggle("open", show);
    });
    const gifQ = this.$(".gif-q") as HTMLInputElement | null;
    const setGifTab = (tab: "search" | "favs") => {
      this.gifTab = tab;
      this.$(".gt-search")?.classList.toggle("on", tab === "search");
      this.$(".gt-favs")?.classList.toggle("on", tab === "favs");
      if (gifQ) gifQ.placeholder = tab === "search" ? "Search GIFs…" : "Filter favorites…";
      this.renderGifGrid();
    };
    this.$(".gt-search")?.addEventListener("click", () => setGifTab("search"));
    this.$(".gt-favs")?.addEventListener("click", () => setGifTab("favs"));
    const runGifSearch = async () => {
      const q = gifQ?.value.trim();
      if (!q) return;
      const grid = this.$(".gif-grid");
      if (grid) grid.innerHTML = `<div class="gif-msg">Searching…</div>`;
      try {
        this.gifResults = await this.opts.gifSearch(q);
        this.renderGifGrid();
      } catch {
        if (grid) grid.innerHTML = `<div class="gif-msg">Search failed.</div>`;
      }
    };
    this.$(".gif-go")?.addEventListener("click", runGifSearch);
    gifQ?.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter" && this.gifTab === "search") runGifSearch();
    });
    gifQ?.addEventListener("input", () => {
      if (this.gifTab === "favs") this.renderGifGrid();
    });

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
  /** Open the panel toward screen center so it's never clipped off-edge: to the
   *  right of the bubble when it's on the left half (and vice-versa), top-aligned
   *  when near the top (extends down) or bottom-aligned when near the bottom. */
  private positionPanel(): void {
    const host = this.host;
    const panel = this.$(".panel");
    if (!host || !panel) return;
    const r = host.getBoundingClientRect();
    const onLeft = r.left + r.width / 2 < window.innerWidth / 2;
    const onTop = r.top + r.height / 2 < window.innerHeight / 2;
    Object.assign(panel.style, {
      left: onLeft ? "60px" : "auto",
      right: onLeft ? "auto" : "60px",
      top: onTop ? "0" : "auto",
      bottom: onTop ? "auto" : "0",
    });
  }

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
    width: 50px; height: 50px; border-radius: 50%;
    background: radial-gradient(circle at 50% 35%, #20232f, #14161d);
    border: 1px solid #343a4a; color: #e7e9ef;
    display: grid; place-items: center; cursor: grab; position: relative;
    box-shadow: 0 6px 22px rgba(0,0,0,.55); user-select: none; touch-action: none;
    transition: border-color .15s, transform .1s;
  }
  .bubble:hover { border-color: #6c7cff; }
  .bubble:active { cursor: grabbing; transform: scale(.96); }
  .bubble .logo { margin-left: 2px; }
  .bubble-count {
    position: absolute; top: -3px; right: -3px; min-width: 18px; height: 18px;
    padding: 0 5px; border-radius: 999px; background: #6c7cff; color: #fff;
    font-size: 11px; font-weight: 700; display: grid; place-items: center;
    border: 2px solid #14161d;
  }
  .bubble-count[hidden] { display: none; }
  .bdot { position:absolute; bottom: 1px; right: 1px; width: 12px; height: 12px;
          border-radius: 50%; background: #f5a623; border: 2px solid #14161d; }
  .bdot[hidden] { display: none; }
  .panel {
    display: none; flex-direction: column; gap: 0; position: absolute;
    width: 290px; max-height: 72vh; background: #171922; color: #e7e9ef;
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
  button.sub-toggle { width:100%; background:none; border:none; border-radius:0; justify-content:space-between; align-items:center; cursor:pointer; }
  button.sub-toggle:hover { color:#e7e9ef; }
  .subs[hidden] { display:none; }
  .caret { transition: transform .15s; }
  button.sub-toggle.open .caret, button.gif-toggle.open .caret { transform: rotate(180deg); }
  button.gif-toggle { width:100%; background:none; border:none; border-radius:0; justify-content:space-between; align-items:center; cursor:pointer; }
  button.gif-toggle:hover { color:#e7e9ef; }
  .gifs[hidden] { display:none; }
  .gifs { padding: 0 12px 8px; display:flex; flex-direction:column; gap:6px; }
  .gif-tabs { display:flex; gap:4px; }
  .gt { flex:1; background:none; border:none; border-bottom:2px solid transparent; border-radius:0; color:#9aa0b4; font-size:12px; padding:4px; cursor:pointer; }
  .gt.on { color:#e7e9ef; border-bottom-color:#6c7cff; }
  .gif-row { display:flex; gap:6px; }
  .gif-q { flex:1; min-width:0; font:inherit; font-size:12px; color:#e7e9ef; background:#0e0f13; border:1px solid #2a2e3d; border-radius:6px; padding:5px 8px; }
  .gif-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:4px; max-height:200px; overflow:auto; }
  .gtile { position:relative; aspect-ratio:1; }
  .gtile .gsend { width:100%; height:100%; padding:0; border:none; border-radius:8px; overflow:hidden; background:#0e0f13; cursor:pointer; }
  .gtile img { width:100%; height:100%; object-fit:cover; display:block; }
  .gtile .gstar { position:absolute; top:3px; right:3px; width:20px; height:20px; padding:0; border:none; border-radius:50%; background:rgba(0,0,0,.6); color:#fff; font-size:11px; cursor:pointer; }
  .gtile .gstar.on { color:#f5a623; }
  .gif-msg { font-size:12px; color:#9aa0b4; padding:4px 0; }
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
  <div class="section-title">Chat</div>
  <ul class="chat"></ul>
  <form class="chat-form"><input class="chat-in" type="text" placeholder="Message…" maxlength="500" /><button class="chat-send">Send</button></form>
  <button class="section-title gif-toggle">GIF<span class="caret">▾</span></button>
  <div class="gifs" hidden>
    <div class="gif-tabs"><button class="gt gt-search on">Search</button><button class="gt gt-favs">★ Favs</button></div>
    <div class="gif-row"><input class="gif-q" type="text" placeholder="Search GIFs…" /><button class="gif-go">Go</button></div>
    <div class="gif-grid"></div>
  </div>
  <button class="section-title sub-toggle">Subtitles<span class="caret">▾</span></button>
  <div class="subs" hidden>
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
