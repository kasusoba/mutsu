/**
 * In-iframe overlay host (SPEC §12): an empty, `pointer-events: none` layer
 * inside the embed iframe, reserved for future in-iframe UI. We intentionally
 * render NO visible badge — the "synced by mutsu" pill was noise (it showed
 * on every embed and inside our own party). Sync status lives on the room page.
 * The host follows fullscreen so any future overlay tracks the video (risk 10).
 */

const HOST_ID = "mutsu-overlay";

export class Overlay {
  private host: HTMLDivElement;

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

    document.addEventListener("fullscreenchange", () => this.reattach());
  }

  mount(): void {
    this.reattach();
  }

  private reattach(): void {
    const parent = document.fullscreenElement ?? document.body;
    if (parent && this.host.parentElement !== parent) parent.appendChild(this.host);
  }

  /** No-op (no visible badge); kept for the bridge's escape-hatch message. */
  setTakeover(_on: boolean): void {}

  /** Hide/show the overlay host ("use the site's own player" escape hatch). */
  setHidden(hidden: boolean): void {
    this.host.style.display = hidden ? "none" : "";
  }

  destroy(): void {
    this.host.remove();
  }
}
