/**
 * ReactionLayer (§14) — floats emoji reactions up over the site's video in
 * own-tab mode, anchored to the video rect (like SubtitleLayer). Ephemeral: each
 * emoji animates up + fades, then removes itself. Shadow-isolated so the host
 * site's CSS can't touch it.
 */

export class ReactionLayer {
  private host: HTMLDivElement;
  private root: ShadowRoot;
  private layer: HTMLDivElement;
  private raf = 0;
  private seq = 0;

  constructor(private readonly getRect: () => DOMRect | null) {
    this.host = document.createElement("div");
    this.host.style.cssText = "position:fixed;z-index:2147483645;pointer-events:none;inset:0;";
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.innerHTML = `<style>
      .layer { position:fixed; overflow:hidden; pointer-events:none; }
      .r { position:absolute; bottom:0; font-size:34px; will-change:transform,opacity;
           animation: up 2.2s ease-out forwards; }
      @keyframes up {
        0% { transform: translate(-50%,0) scale(.6); opacity:0; }
        15% { transform: translate(-50%,-10px) scale(1.1); opacity:1; }
        100% { transform: translate(-50%,-220px) scale(1); opacity:0; }
      }
    </style><div class="layer"></div>`;
    this.layer = this.root.querySelector(".layer") as HTMLDivElement;
  }

  mount(): void {
    (document.body ?? document.documentElement).append(this.host);
    const loop = () => {
      this.position();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Keep the float region over the video (or the viewport if no rect). */
  private position(): void {
    const rect = this.getRect();
    const full = document.fullscreenElement;
    if (rect && rect.width > 1 && rect.height > 1 && !full) {
      Object.assign(this.layer.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    } else {
      Object.assign(this.layer.style, { left: "0", top: "0", width: "100vw", height: "100vh" });
    }
  }

  spawn(emoji: string): void {
    const el = document.createElement("span");
    el.className = "r";
    el.textContent = emoji;
    el.style.left = `${8 + Math.random() * 84}%`;
    const id = ++this.seq;
    el.dataset.id = String(id);
    this.layer.append(el);
    setTimeout(() => el.remove(), 2300);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.host.remove();
  }
}
