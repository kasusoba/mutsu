/**
 * SiteWidget (§11) — the in-site-tab room widget for a `site` source. Draggable,
 * edge-magnetic, hideable Shadow-DOM panel with members + chat + reactions + a
 * GIF picker (with favorites) + a subtitle panel (upload / online search / sync +
 * style / "From this site" tracks), so you never need to tab back to the web room
 * while watching. It owns no socket: the web hub pushes members/events down the
 * cross-tab relay and runs member-gated proxy ops (gif/subtitle search) on the
 * widget's behalf; chat/reactions/gifs go back up. The video call is NOT here —
 * it floats from the hub via Document Picture-in-Picture (WebRTC can't cross
 * tabs). Shadow-isolated so the host site's CSS can't touch it.
 */

import type { Member, MemberId } from "@sixseven/protocol";
import type { SubtitleStyle, TrackInfo } from "@sixseven/protocol/bridge";
import { browser } from "wxt/browser";

const EMOJIS = ["😂", "❤️", "🔥", "👍", "😮", "🎉"];
const FAVS_KEY = "sixseven:gifFavs";
/** Keys that move the caret / change the selection / edit text in a field —
 *  swallowed inside our fields so they don't drive page/extension shortcuts
 *  (e.g. asbplayer's Shift+Arrow subtitle offset) while you type. */
const EDIT_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
]);
function isTextField(node: EventTarget | undefined): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
}
/** Pixel movement before a header press counts as a drag (else it's a tap → hide). */
const DRAG_THRESHOLD = 5;

export interface GifHit {
  id: string;
  url: string;
  preview: string;
}
export interface SubHit {
  id: string;
  title: string;
  release?: string;
  downloads?: number;
  language: string;
}
type FavGif = GifHit & { q: string };

export interface SiteWidgetOpts {
  /** The room this widget belongs to (shown so it's not "clueless"). */
  room: string;
  onChat: (text: string) => void;
  onReact: (emoji: string) => void;
  onGif: (url: string) => void;
  /** Focus the paired hub tab ("go to room") — fired by tapping the room name. */
  onGoToRoom: () => void;
  /** Hide the whole widget (the ✕) — reopened from the extension popup. */
  onClose: () => void;
  /** "Play this page for everyone": make the room follow to the page you're on. */
  onPlayPage: () => void;
  gifSearch: (q: string) => Promise<GifHit[]>;
  subs: {
    loadFile: (f: File) => Promise<void>;
    search: (q: string, season?: number, episode?: number) => Promise<SubHit[]>;
    loadResult: (r: SubHit) => Promise<void>;
    clear: () => void;
    setStyle: (patch: Partial<SubtitleStyle>) => void;
    selectTrack: (id: string | null) => void;
  };
}

interface ChatLine {
  id: number;
  name: string;
  text: string;
  self: boolean;
}
type Tab = "chat" | "gif" | "subs";

export class SiteWidget {
  private host: HTMLDivElement;
  private root: ShadowRoot;
  private chat: ChatLine[] = [];
  private seq = 0;
  private tab: Tab = "chat";
  private gifTab: "search" | "favs" = "search";
  private tracks: TrackInfo[] = [];
  private subLabel: string | null = null;
  private style: SubtitleStyle | null = null;
  private favs: FavGif[] = [];
  private lastGifResults: GifHit[] = [];
  private lastGifQuery = "";
  // drag / anchor
  private dragging = false;
  private moved = false;
  private sx = 0;
  private sy = 0;
  private dx = 0;
  private dy = 0;

  /** Window capture-phase shield: keystrokes typed in the widget never reach the
   *  page's or another extension's shortcut listeners. Two classes are swallowed,
   *  only when the event originates inside our host:
   *   1. printable single-character keys (a, k, space…) — letter shortcuts.
   *   2. caret/selection/editing keys (arrows incl. Shift/Ctrl+Arrow, Home, End,
   *      PageUp/Down, Backspace, Delete; Enter in a textarea) — but ONLY while
   *      focus is in one of our own fields, else e.g. asbplayer's "Shift+Arrow =
   *      subtitle offset" fires and even preventDefaults our input so text can't
   *      be selected.
   *  stopPropagation never cancels the DEFAULT action, so the caret still moves,
   *  text still highlights, and characters still insert (inputs read `input`, not
   *  keydown). Enter (in single-line inputs), Escape and Tab pass through to our
   *  own panel handlers; layer 1 keeps those from leaking on the bubble back up. */
  private readonly shield = (e: KeyboardEvent): void => {
    const path = e.composedPath();
    if (!path.includes(this.host)) return; // not our widget
    if (e.key.length === 1) {
      e.stopImmediatePropagation(); // printable → letter/space shortcuts
      return;
    }
    const target = path[0];
    if (!isTextField(target)) return; // editing keys only matter while typing
    const isTextarea = target instanceof HTMLElement && target.tagName === "TEXTAREA";
    if (EDIT_KEYS.has(e.key) || (e.key === "Enter" && isTextarea)) {
      e.stopImmediatePropagation();
    }
  };

  constructor(private readonly opts: SiteWidgetOpts) {
    this.host = document.createElement("div");
    this.host.style.cssText = "position:fixed;top:84px;right:16px;z-index:2147483646;";
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.innerHTML = this.html();
    // Keyboard isolation, layer 1 (bubble): any key event originating inside the
    // widget is stopped at the shadow root so it never reaches the host page (its
    // player hotkeys: space/m/f) or other extensions' BUBBLE-phase listeners.
    // Typing still works: the input gets the key first; we only stop it crossing
    // out of the shadow.
    for (const ev of ["keydown", "keyup", "keypress"] as const) {
      this.root.addEventListener(ev, (e) => e.stopImmediatePropagation());
    }
    // Keyboard isolation, layer 2 (window capture): the bubble stop above is too
    // LATE for site players and especially OTHER extensions, which bind keydown in
    // the CAPTURE phase on document/window — that fires BEFORE the event reaches
    // our input. A window capture-phase listener runs first of all, and DOM
    // propagation is shared across isolated worlds, so stopping here blocks those
    // handlers too. It swallows printable keys plus (while typing in our fields)
    // text caret/selection/editing keys — arrows, Shift+Arrow selection, Home/End,
    // Backspace — which would otherwise drive page/extension shortcuts (e.g.
    // asbplayer's Shift+Arrow subtitle offset) instead of editing. See `shield`.
    for (const ev of ["keydown", "keyup", "keypress"] as const) {
      window.addEventListener(ev, this.shield, true);
    }
    this.wireHeader();
    this.wirePlayPage();
    this.wireChat();
    this.wireTabs();
    this.wireGif();
    this.wireSubs();
    void this.loadFavs();
    this.renderMembers([], null);
    this.renderFeed();
    this.renderGif();
    this.renderTracks();
    this.renderSubLabel();
    this.setTab("chat");
  }

  mount(): void {
    document.documentElement.append(this.host);
  }
  setMembers(members: Member[], self: MemberId | null): void {
    this.renderMembers(members, self);
  }
  addChat(name: string, text: string, self: boolean): void {
    this.chat = [...this.chat, { id: this.seq++, name, text, self }].slice(-80);
    this.renderFeed();
  }
  setTracks(tracks: TrackInfo[]): void {
    this.tracks = tracks;
    this.renderTracks();
  }
  setSubLabel(label: string | null): void {
    this.subLabel = label;
    this.renderSubLabel();
  }
  setSubStyle(style: SubtitleStyle): void {
    this.style = style;
    this.renderStyle();
  }
  /** Show/hide "Play this page for everyone" — on when you're on a different page
   *  than the room source and you're allowed to change it. */
  setCanPlayPage(show: boolean): void {
    this.q(".playpage").hidden = !show;
  }
  /** Minimize ↔ expand (panel vs floating bubble) — the header minimize button. */
  setHidden(hidden: boolean): void {
    this.q(".panel").hidden = hidden;
    this.q(".bubble").hidden = !hidden;
  }
  /** Hide/show the whole widget — both the in-widget ✕ and the popup's "Hide
   *  widget" route here (via the controller). Reopen from the extension popup. */
  setGone(gone: boolean): void {
    this.host.style.display = gone ? "none" : "";
    if (!gone) this.setHidden(false); // popup re-show → bring back the panel
  }
  /** A brief, self-dismissing hint after ✕ so users know how to bring it back.
   *  Lives OUTSIDE the host (which we're hiding), with inline styles so the site's
   *  CSS can't restyle it. */
  private showClosedHint(): void {
    const t = document.createElement("div");
    t.textContent = "Widget hidden — reopen it from the extension toolbar icon.";
    t.style.cssText =
      "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
      "background:#171922f2;color:#e7e9ef;font:13px/1.4 system-ui,sans-serif;padding:9px 14px;" +
      "border:1px solid #2a2e3d;border-radius:8px;box-shadow:0 8px 30px #0009;max-width:90vw;";
    document.documentElement.append(t);
    setTimeout(() => t.remove(), 4500);
  }
  destroy(): void {
    for (const ev of ["keydown", "keyup", "keypress"] as const) {
      window.removeEventListener(ev, this.shield, true);
    }
    this.host.remove();
  }

  // ── header: room-name link + minimize/close; drag = move (edge-magnet) ──

  private wireHeader(): void {
    const icon = this.q<HTMLImageElement>(".bubble img");
    icon.src = browser.runtime.getURL("/icon/48.png");
    this.q(".rn-text").textContent = this.opts.room;
    const rn = this.q<HTMLButtonElement>(".roomname");
    rn.title = `Go to the room tab (${this.opts.room})`;
    // The room name is a narrow link, NOT a drag handle: stop its pointerdown so
    // the .hd pointer-capture can't swallow the click (that's why it "did
    // nothing"). Drag the widget by the rest of the header.
    rn.addEventListener("pointerdown", (e) => e.stopPropagation());
    rn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.onGoToRoom();
    });
    const min = this.q<HTMLButtonElement>(".min");
    min.addEventListener("pointerdown", (e) => e.stopPropagation());
    min.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setHidden(true); // minimize to the floating bubble
    });
    const close = this.q<HTMLButtonElement>(".close");
    // The ✕ must not start a drag; click hides the widget (popup re-shows it).
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showClosedHint();
      this.opts.onClose();
    });
    this.initDrag(this.q(".hd"));
    this.initDrag(this.q(".bubble"), () => this.setHidden(false)); // tap bubble → expand
  }

  private wirePlayPage(): void {
    this.q<HTMLButtonElement>(".playpage").addEventListener("click", () => this.opts.onPlayPage());
  }

  private initDrag(handle: HTMLElement, onTap?: () => void): void {
    handle.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.moved = false;
      this.sx = e.clientX;
      this.sy = e.clientY;
      const r = this.host.getBoundingClientRect();
      this.dx = e.clientX - r.left;
      this.dy = e.clientY - r.top;
      this.host.style.transition = "none";
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      if (Math.abs(e.clientX - this.sx) + Math.abs(e.clientY - this.sy) > DRAG_THRESHOLD) {
        this.moved = true;
      }
      const x = Math.max(4, Math.min(window.innerWidth - 44, e.clientX - this.dx));
      const y = Math.max(4, Math.min(window.innerHeight - 44, e.clientY - this.dy));
      this.host.style.left = `${x}px`;
      this.host.style.top = `${y}px`;
      this.host.style.right = "auto";
      this.host.style.bottom = "auto";
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      if (this.moved) this.snap();
      else onTap?.();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /** Edge-magnet HORIZONTALLY only (snap to nearest side); keep the vertical
   *  position you dropped at — but anchor it by top vs bottom so the panel opens
   *  toward the screen centre (never off-edge). Eased snap = a little springy. */
  private snap(): void {
    const r = this.host.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    this.host.style.transition =
      "left .24s cubic-bezier(.22,1.1,.36,1), right .24s cubic-bezier(.22,1.1,.36,1)";
    if (cx > window.innerWidth / 2) {
      this.host.style.right = "16px";
      this.host.style.left = "auto";
    } else {
      this.host.style.left = "16px";
      this.host.style.right = "auto";
    }
    // Lower half → anchor by bottom (panel grows up); upper half → by top. Either
    // way we keep the dropped position, so it doesn't jump to a corner.
    if (cy > window.innerHeight / 2) {
      this.host.style.bottom = `${Math.max(8, Math.round(window.innerHeight - r.bottom))}px`;
      this.host.style.top = "auto";
    } else {
      this.host.style.top = `${Math.max(8, Math.round(r.top))}px`;
      this.host.style.bottom = "auto";
    }
  }

  // ── chat ──────────────────────────────────────────────────────────────────────

  private wireChat(): void {
    const react = this.q(".react");
    for (const e of EMOJIS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = e;
      b.addEventListener("click", () => this.opts.onReact(e));
      react.append(b);
    }
    const input = this.q<HTMLInputElement>(".chatrow input");
    const send = () => {
      const t = input.value.trim();
      if (!t) return;
      this.opts.onChat(t);
      input.value = "";
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") send();
    });
    this.q<HTMLButtonElement>(".chatrow .send").addEventListener("click", send);
  }

  // ── tabs ──────────────────────────────────────────────────────────────────────

  private wireTabs(): void {
    for (const t of ["chat", "gif", "subs"] as Tab[]) {
      this.q<HTMLButtonElement>(`.tabs [data-tab="${t}"]`).addEventListener("click", () =>
        this.setTab(t),
      );
    }
  }
  private setTab(t: Tab): void {
    this.tab = t;
    for (const k of ["chat", "gif", "subs"] as Tab[]) {
      this.q(`.tabs [data-tab="${k}"]`).classList.toggle("on", k === t);
      this.q(`.pane.${k}`).hidden = k !== t;
    }
  }

  // ── gif (search + favorites) ────────────────────────────────────────────────

  private async loadFavs(): Promise<void> {
    const got = await browser.storage.local.get(FAVS_KEY).catch(() => ({}));
    const list = (got as Record<string, unknown>)[FAVS_KEY];
    this.favs = Array.isArray(list) ? (list as FavGif[]) : [];
    if (this.gifTab === "favs") this.renderGif();
  }
  private saveFavs(): void {
    void browser.storage.local.set({ [FAVS_KEY]: this.favs.slice(0, 60) }).catch(() => {});
  }
  private isFav(url: string): boolean {
    return this.favs.some((f) => f.url === url);
  }
  private toggleFav(g: GifHit, q: string): void {
    this.favs = this.isFav(g.url)
      ? this.favs.filter((f) => f.url !== g.url)
      : [{ ...g, q }, ...this.favs].slice(0, 60);
    this.saveFavs();
    this.renderGif();
  }

  private wireGif(): void {
    for (const t of ["search", "favs"] as const) {
      this.q<HTMLButtonElement>(`.giftabs [data-g="${t}"]`).addEventListener("click", () => {
        this.gifTab = t;
        this.renderGif();
      });
    }
    const input = this.q<HTMLInputElement>(".gifsearch input");
    const run = async () => {
      const q = input.value.trim();
      if (!q) return;
      this.lastGifQuery = q;
      this.setGifNote("searching…");
      try {
        this.lastGifResults = await this.opts.gifSearch(q);
        this.renderGif();
        if (!this.lastGifResults.length) this.setGifNote("no gifs found");
      } catch (e) {
        this.setGifNote((e as Error).message || "search failed");
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
    this.q<HTMLButtonElement>(".gifsearch .send").addEventListener("click", run);
  }

  private renderGif(): void {
    for (const t of ["search", "favs"] as const) {
      this.q(`.giftabs [data-g="${t}"]`).classList.toggle("on", this.gifTab === t);
    }
    this.q(".gifsearch").hidden = this.gifTab !== "search";
    const grid = this.q(".gifgrid");
    grid.replaceChildren();
    const items = this.gifTab === "search" ? this.lastGifResults : this.favs;
    if (!items.length) {
      grid.append(this.note(this.gifTab === "favs" ? "No favorites yet." : "Search for a GIF."));
      return;
    }
    for (const g of items) {
      const tile = document.createElement("div");
      tile.className = "giftile";
      const img = document.createElement("img");
      img.src = g.preview;
      img.alt = "gif";
      img.loading = "lazy";
      img.addEventListener("click", () => this.opts.onGif(g.url));
      const star = document.createElement("button");
      star.type = "button";
      star.className = `star${this.isFav(g.url) ? " on" : ""}`;
      star.textContent = "★";
      star.title = this.isFav(g.url) ? "Unfavorite" : "Favorite";
      const q = this.gifTab === "favs" ? (g as FavGif).q : this.lastGifQuery;
      star.addEventListener("click", () => this.toggleFav(g, q));
      tile.append(img, star);
      grid.append(tile);
    }
  }
  private setGifNote(text: string): void {
    const grid = this.q(".gifgrid");
    grid.replaceChildren(this.note(text));
  }

  // ── subtitles ───────────────────────────────────────────────────────────────

  private wireSubs(): void {
    const file = this.q<HTMLInputElement>(".subupload");
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (f) await this.opts.subs.loadFile(f);
      file.value = "";
    });
    const sInput = this.q<HTMLInputElement>(".subsearch input");
    const results = this.q(".subresults");
    const run = async () => {
      const q = sInput.value.trim();
      if (!q) return;
      results.replaceChildren(this.note("searching…"));
      try {
        const hits = await this.opts.subs.search(q);
        results.replaceChildren();
        if (!hits.length) {
          results.append(this.note("no subtitles found"));
          return;
        }
        for (const s of hits.slice(0, 15)) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "subhit";
          const title = document.createElement("span");
          title.className = "rtitle";
          title.textContent = s.release ?? s.title;
          const meta = document.createElement("span");
          meta.className = "rmeta";
          meta.textContent = `${s.language}${s.downloads ? ` · ↓${s.downloads.toLocaleString()}` : ""}`;
          b.append(title, meta);
          b.addEventListener("click", async () => {
            results.replaceChildren(); // clear the list once a pick is chosen
            await this.opts.subs.loadResult(s);
          });
          results.append(b);
        }
      } catch (e) {
        results.replaceChildren(this.note((e as Error).message || "search failed"));
      }
    };
    sInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
    this.q<HTMLButtonElement>(".subsearch .send").addEventListener("click", run);
    this.q<HTMLButtonElement>(".subclear").addEventListener("click", () => this.opts.subs.clear());
    this.q<HTMLSelectElement>(".subtracks").addEventListener("change", (e) => {
      this.opts.subs.selectTrack((e.target as HTMLSelectElement).value || null);
    });
    // style controls
    const set = (patch: Partial<SubtitleStyle>) => this.opts.subs.setStyle(patch);
    this.q<HTMLButtonElement>(".off-minus").addEventListener("click", () =>
      set({ offsetMs: (this.style?.offsetMs ?? 0) - 50 }),
    );
    this.q<HTMLButtonElement>(".off-plus").addEventListener("click", () =>
      set({ offsetMs: (this.style?.offsetMs ?? 0) + 50 }),
    );
    this.q<HTMLInputElement>(".off-num").addEventListener("input", (e) =>
      set({ offsetMs: Math.round((+(e.target as HTMLInputElement).value || 0) * 1000) }),
    );
    this.q<HTMLButtonElement>(".pos-bottom").addEventListener("click", () =>
      set({ position: "bottom" }),
    );
    this.q<HTMLButtonElement>(".pos-top").addEventListener("click", () => set({ position: "top" }));
    this.q<HTMLInputElement>(".size").addEventListener("input", (e) =>
      set({ sizePct: +(e.target as HTMLInputElement).value }),
    );
    this.q<HTMLInputElement>(".dist").addEventListener("input", (e) =>
      set({ marginPct: +(e.target as HTMLInputElement).value }),
    );
    this.q<HTMLInputElement>(".colour").addEventListener("input", (e) =>
      set({ color: (e.target as HTMLInputElement).value }),
    );
    this.q<HTMLInputElement>(".box").addEventListener("input", (e) =>
      set({ background: +(e.target as HTMLInputElement).value }),
    );
  }

  private renderTracks(): void {
    const sel = this.q<HTMLSelectElement>(".subtracks");
    const cur = sel.value;
    sel.replaceChildren();
    const off = document.createElement("option");
    off.value = "";
    off.textContent = this.tracks.length ? "From this site: off" : "No site captions";
    sel.append(off);
    for (const t of this.tracks) {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.label || t.language || "track";
      sel.append(o);
    }
    sel.value = cur;
    sel.disabled = this.tracks.length === 0;
  }
  private renderSubLabel(): void {
    this.q(".sublabel").textContent = this.subLabel ?? "off";
    this.q(".substyle").hidden = !this.subLabel;
  }
  private renderStyle(): void {
    if (!this.style) return;
    this.q<HTMLInputElement>(".off-num").value = (this.style.offsetMs / 1000).toFixed(2);
    this.setRange(".size", this.style.sizePct, 60, 220);
    this.setRange(".dist", this.style.marginPct, 0, 40);
    this.setRange(".box", this.style.background, 0, 1);
    this.q<HTMLInputElement>(".colour").value = this.style.color;
    this.q(".pos-bottom").classList.toggle("on", this.style.position === "bottom");
    this.q(".pos-top").classList.toggle("on", this.style.position === "top");
  }
  /** Set a range input's value + the `--fill` % (WebKit has no fill pseudo). */
  private setRange(sel: string, value: number, min: number, max: number): void {
    const el = this.q<HTMLInputElement>(sel);
    el.value = String(value);
    el.style.setProperty("--fill", `${((value - min) / (max - min)) * 100}%`);
  }

  // ── members + feed ─────────────────────────────────────────────────────────

  private renderMembers(members: Member[], self: MemberId | null): void {
    const el = this.q(".members");
    el.replaceChildren();
    if (!members.length) {
      el.append(this.note("connecting…"));
      return;
    }
    for (const m of members) {
      const s = document.createElement("span");
      s.className = "m";
      const dot = document.createElement("span");
      dot.className = `dot ${m.status}`;
      const name = document.createElement("span");
      name.textContent = m.id === self ? `${m.name} (you)` : m.name;
      s.append(dot, name);
      el.append(s);
    }
  }
  private renderFeed(): void {
    const el = this.q(".feed");
    el.replaceChildren();
    if (!this.chat.length) {
      el.append(this.note("No messages yet."));
      return;
    }
    for (const c of this.chat) {
      const line = document.createElement("div");
      line.className = `line${c.self ? " self" : ""}`;
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = `${c.self ? "you" : c.name}: `;
      line.append(who, document.createTextNode(c.text));
      el.append(line);
    }
    el.scrollTop = el.scrollHeight;
  }

  // ── helpers ───────────────────────────────────────────────────────────────────

  private note(text: string): HTMLDivElement {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = text;
    return d;
  }
  private q<T extends HTMLElement = HTMLDivElement>(sel: string): T {
    return this.root.querySelector(sel) as T;
  }

  private html(): string {
    return `
      <style>
        * { box-sizing: border-box; }
        .panel { width: 250px; max-height: 72vh; display: flex; flex-direction: column;
          font: 13px/1.4 system-ui, sans-serif; color: #e7e9ef; background: #171922f2;
          border: 1px solid #2a2e3d; border-radius: 10px; box-shadow: 0 8px 30px #0009;
          overflow: hidden; backdrop-filter: blur(4px); }
        .hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: grab;
          background: #1f2230; border-bottom: 1px solid #2a2e3d; user-select: none; touch-action: none; }
        .hd:active { cursor: grabbing; }
        .roomname { display: inline-flex; align-items: center; gap: 4px; max-width: 70%; min-width: 0; border: 0;
          background: none; color: #e7e9ef; font: inherit; font-weight: 600; cursor: pointer; padding: 3px 2px;
          text-align: left; }
        .roomname .rn-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .roomname .rn-arrow { flex: none; color: #9aa0b4; font-size: 11px; }
        .roomname:hover .rn-text { text-decoration: underline; }
        .min, .close { flex: none; border: 0; background: #ffffff14; color: #cfcfd6; border-radius: 6px;
          padding: 3px 9px; cursor: pointer; font-size: 13px; line-height: 1.3; }
        .min { margin-left: auto; }
        .min:hover, .close:hover { background: #ffffff28; color: #fff; }
        .members { display: flex; flex-wrap: wrap; gap: 4px 8px; padding: 7px 10px; border-bottom: 1px solid #2a2e3d; }
        .playpage { display: block; width: calc(100% - 20px); margin: 8px 10px; padding: 7px 10px; border: 0;
          border-radius: 6px; background: #6c7cff; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
        .playpage:hover { background: #5563f5; }
        .m { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #9aa0b4; }
        .dot.ready { background: #41d18a; } .dot.stalled { background: #f5a623; } .dot.failed { background: #ff5d6c; }
        .tabs, .giftabs { display: flex; border-bottom: 1px solid #2a2e3d; }
        .tabs button, .giftabs button { flex: 1; border: 0; background: none; color: #9aa0b4; font: inherit;
          font-size: 12px; padding: 6px 0; cursor: pointer; border-bottom: 2px solid transparent; }
        .tabs button.on, .giftabs button.on { color: #e7e9ef; border-bottom-color: #6c7cff; }
        .section { flex: 1; overflow-y: auto; min-height: 60px; }
        .pane { display: flex; flex-direction: column; }
        .pane[hidden], [hidden] { display: none !important; }
        .feed { flex: 1; overflow-y: auto; padding: 7px 10px; display: flex; flex-direction: column; gap: 4px; min-height: 56px; max-height: 28vh; }
        .line { font-size: 12px; word-break: break-word; }
        .line .who { color: #9aa0b4; } .line.self .who { color: #6c7cff; }
        .empty { color: #6a6a74; font-size: 11px; padding: 6px 2px; }
        .react { display: flex; gap: 3px; padding: 6px 10px; border-top: 1px solid #2a2e3d; }
        .react button { flex: 1; border: 0; background: #1f2230; border-radius: 6px; cursor: pointer; font-size: 14px; padding: 3px 0; }
        .react button:hover { background: #2a2e3d; }
        .chatrow, .gifsearch, .subsearch { display: flex; gap: 6px; padding: 7px 10px; border-top: 1px solid #2a2e3d; }
        input, select { font: inherit; color: #e7e9ef; background: #0e0f13; border: 1px solid #2a2e3d; border-radius: 6px; padding: 5px 7px; min-width: 0; }
        .chatrow input, .gifsearch input, .subsearch input { flex: 1; }
        .send { border: 0; background: #6c7cff; color: #fff; border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit; }
        .gifgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 7px 10px; }
        .giftile { position: relative; }
        .giftile img { width: 100%; border-radius: 6px; cursor: pointer; display: block; aspect-ratio: 1; object-fit: cover; }
        .star { position: absolute; top: 3px; right: 3px; border: 0; border-radius: 50%; width: 20px; height: 20px;
          background: #0009; color: #fff; cursor: pointer; font-size: 11px; line-height: 1; }
        .star.on { color: #f5a623; }
        .pane.subs { gap: 6px; padding: 8px 10px; }
        .pane.subs .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .up { display: inline-block; background: #1f2230; border: 1px solid #2a2e3d; border-radius: 6px; padding: 5px 9px; cursor: pointer; font-size: 12px; }
        .subupload { display: none; }
        .subtracks { width: 100%; }
        .subsearch { padding: 0; border: 0; }
        .subresults { display: flex; flex-direction: column; gap: 3px; max-height: 20vh; overflow-y: auto; }
        .subhit { display: flex; flex-direction: column; gap: 1px; text-align: left; border: 0;
          background: #1f2230; color: #e7e9ef; border-radius: 6px; padding: 6px 8px; cursor: pointer; font: inherit; }
        .subhit:hover { background: #2a2e3d; }
        .subhit .rtitle { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .subhit .rmeta { font-size: 10px; color: #9aa0b4; }
        .substyle { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid #2a2e3d; padding-top: 7px; }
        .labelrow { display: flex; align-items: center; gap: 6px; }
        .sublabel { flex: 1; min-width: 0; font-size: 12px; color: #cfcfd6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: #9aa0b4; min-width: 30px; }
        .pill { border: 1px solid #2a2e3d; background: #1f2230; color: #e7e9ef; border-radius: 6px; padding: 3px 8px; cursor: pointer; font: inherit; font-size: 12px; }
        .pill.on { border-color: #6c7cff; color: #6c7cff; }
        .substyle input[type=range] { flex: 1; }
        .substyle input[type=number] { width: 58px; text-align: right; }
        .substyle input[type=color] { width: 28px; height: 24px; padding: 0; border: 0; background: none; }
        /* Sliders styled to match the web's volume bar (Shadow DOM ignores page CSS). */
        input[type=range] { -webkit-appearance: none; appearance: none; height: 16px; padding: 0; border: 0; background: transparent; cursor: pointer; }
        input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 999px;
          background: linear-gradient(#6c7cff, #6c7cff) left center / var(--fill, 0%) 100% no-repeat, #ffffff38; }
        input[type=range]::-moz-range-track { height: 4px; border-radius: 999px; background: #ffffff38; }
        input[type=range]::-moz-range-progress { height: 4px; border-radius: 999px; background: #6c7cff; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; margin-top: -4px; width: 12px; height: 12px; border: 0; border-radius: 50%; background: #6c7cff; }
        input[type=range]::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: #6c7cff; }
        .subclear { margin-left: auto; border: 0; background: #1f2230; color: #ff8b95; border-radius: 6px; padding: 3px 8px; cursor: pointer; font: inherit; font-size: 12px; }
        .bubble { width: 42px; height: 42px; border-radius: 50%; border: 1px solid #2a2e3d; cursor: grab;
          background: #171922f2; box-shadow: 0 6px 20px #0008; padding: 0; touch-action: none; overflow: hidden; }
        .bubble img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
      </style>
      <div class="panel">
        <div class="hd"><button class="roomname"><span class="rn-text"></span><span class="rn-arrow">↗</span></button><button class="min" title="Minimize" aria-label="Minimize">–</button><button class="close" title="Hide widget" aria-label="Hide widget">✕</button></div>
        <div class="members"></div>
        <button class="playpage" hidden>▶ Play this page for everyone</button>
        <div class="tabs">
          <button data-tab="chat">Chat</button><button data-tab="gif">GIF</button><button data-tab="subs">Subs</button>
        </div>
        <div class="section">
          <div class="pane chat">
            <div class="feed"></div>
            <div class="react"></div>
            <div class="chatrow"><input type="text" placeholder="message…" maxlength="500" /><button class="send">send</button></div>
          </div>
          <div class="pane gif" hidden>
            <div class="giftabs"><button data-g="search">Search</button><button data-g="favs">★ Favorites</button></div>
            <div class="gifgrid"></div>
            <div class="gifsearch"><input type="text" placeholder="search GIPHY…" /><button class="send">go</button></div>
          </div>
          <div class="pane subs" hidden>
            <div class="row"><label class="up">Upload .srt/.vtt<input class="subupload" type="file" accept=".srt,.vtt,text/vtt" /></label></div>
            <div class="row"><select class="subtracks"></select></div>
            <div class="subsearch"><input type="text" placeholder="search online subs…" /><button class="send">go</button></div>
            <div class="subresults"></div>
            <div class="substyle" hidden>
              <div class="labelrow"><span class="lbl">subs</span><span class="sublabel">off</span><button class="subclear">clear</button></div>
              <div class="row"><span class="lbl">offset</span><button class="pill off-minus">−</button>
                <input class="off-num" type="number" step="0.05" /><span class="lbl">s</span><button class="pill off-plus">+</button></div>
              <div class="row"><span class="lbl">place</span><button class="pill pos-bottom">bottom</button><button class="pill pos-top">top</button>
                <span class="lbl">dist</span><input class="dist" type="range" min="0" max="40" step="1" /></div>
              <div class="row"><span class="lbl">size</span><input class="size" type="range" min="60" max="220" step="5" />
                <input class="colour" type="color" /><span class="lbl">box</span><input class="box" type="range" min="0" max="1" step="0.1" /></div>
            </div>
          </div>
        </div>
      </div>
      <button class="bubble" hidden><img alt="" /></button>`;
  }
}
