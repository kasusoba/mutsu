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
import { browser } from "wxt/browser";

interface WidgetState {
  connected: boolean;
  members: Member[];
  gate: GateMessage;
  selfId: MemberId | null;
  log: LogEvent[];
  playerStatus: MemberStatus;
}

interface WidgetOpts {
  code: string;
  sourceUrl: string;
  onLeave: () => void;
}

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
    width: 280px; max-height: 60vh; background: #171922; color: #e7e9ef;
    border: 1px solid #2a2e3d; border-radius: 14px; overflow: hidden;
    box-shadow: 0 16px 48px rgba(0,0,0,.55);
  }
  .head { display:flex; align-items:center; gap:8px; padding: 10px 12px; border-bottom: 1px solid #2a2e3d; }
  .head .logo { font-weight: 800; letter-spacing: .5px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .dot.on { background:#41d18a; } .dot.off { background:#f5a623; }
  .head .code { margin-left:auto; font: 700 13px ui-monospace, monospace; letter-spacing:1px; color:#6c7cff; }
  .status { padding: 8px 12px; font-size: 12px; color: #9aa0b4; border-bottom: 1px solid #2a2e3d; }
  .section-title { padding: 8px 12px 4px; font-size: 11px; text-transform: uppercase; letter-spacing:.5px; color:#9aa0b4; display:flex; gap:6px; }
  ul { list-style:none; margin:0; padding: 0 12px 8px; display:flex; flex-direction:column; gap:5px; }
  .members li { display:flex; align-items:center; gap:8px; font-size:13px; }
  .mdot { width:8px; height:8px; border-radius:50%; background:#9aa0b4; flex:none; }
  .mdot.ready{background:#41d18a;} .mdot.stalled{background:#f5a623;} .mdot.failed{background:#ff5d6c;}
  .mname{flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
  .you{color:#9aa0b4;}
  .mstat{font-size:11px; color:#9aa0b4;}
  .log { max-height: 140px; overflow:auto; }
  .log li { font-size:12px; color:#c7cad6; }
  .foot { display:flex; gap:8px; padding:10px 12px; border-top:1px solid #2a2e3d; }
  button { font:inherit; font-size:12px; cursor:pointer; border-radius:8px; padding:6px 10px; border:1px solid #2a2e3d; background:#1f2230; color:#e7e9ef; }
  button:hover { border-color:#6c7cff; }
  .copy { margin-left:auto; }
  .leave { color:#ff5d6c; border-color:#3a2730; }
</style>
<div class="bubble" title="sixseven watch party — drag me, click to open">
  <span class="logo">66</span>
  <span class="bubble-count"></span>
  <span class="bdot dot off"></span>
</div>
<div class="panel">
  <div class="head"><span class="dot off"></span><span class="logo">sixseven</span><span class="code">${esc(this.opts.code)}</span></div>
  <div class="status">connecting…</div>
  <div class="section-title">Members <span class="mcount">0</span></div>
  <ul class="members"></ul>
  <div class="section-title">Activity</div>
  <ul class="log"></ul>
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
