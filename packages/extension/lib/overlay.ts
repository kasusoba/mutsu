/**
 * In-iframe overlay (SPEC §12): a small status badge rendered INSIDE the embed
 * iframe so it tracks the video and follows fullscreen (SPEC §16 risk 10).
 *
 * IMPORTANT: this layer is `pointer-events: none` — it must NOT eat clicks. The
 * native player has to stay usable (autoplay needs a user gesture; server-switch,
 * captcha, login all live in the native UI). A full ad-hiding takeover is future
 * work; blocking all interaction broke real embeds, so the badge no longer does it.
 */

const HOST_ID = "sixseven-overlay";

export class Overlay {
  private host: HTMLDivElement;
  private badge: HTMLDivElement;

  constructor() {
    this.host = document.createElement("div");
    this.host.id = HOST_ID;
    Object.assign(this.host.style, {
      position: "fixed",
      top: "0",
      left: "0",
      zIndex: "2147483647",
      pointerEvents: "none", // never block the native player
      background: "transparent",
    } satisfies Partial<CSSStyleDeclaration>);

    this.badge = document.createElement("div");
    this.badge.textContent = "● synced by sixseven";
    Object.assign(this.badge.style, {
      margin: "10px",
      padding: "4px 9px",
      borderRadius: "999px",
      font: "12px system-ui, sans-serif",
      color: "#fff",
      background: "rgba(108,124,255,0.85)",
      pointerEvents: "none",
      userSelect: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    this.host.appendChild(this.badge);

    document.addEventListener("fullscreenchange", () => this.reattach());
  }

  mount(): void {
    this.reattach();
  }

  private reattach(): void {
    const parent = document.fullscreenElement ?? document.body;
    if (parent && this.host.parentElement !== parent) parent.appendChild(this.host);
  }

  /** Reflects sync state in the badge text. Does not block interaction. */
  setTakeover(on: boolean): void {
    this.badge.textContent = on ? "● synced by sixseven" : "● sixseven — paused/idle";
  }

  destroy(): void {
    this.host.remove();
  }
}
