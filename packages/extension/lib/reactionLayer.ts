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
  private chatbox: HTMLDivElement;
  private raf = 0;
  private seq = 0;

  constructor(private readonly getRect: () => DOMRect | null) {
    this.host = document.createElement("div");
    this.host.style.cssText = "position:fixed;z-index:2147483645;pointer-events:none;inset:0;";
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.innerHTML = `<style>
      * { box-sizing:border-box; font-family: system-ui, sans-serif; }
      .layer { position:fixed; overflow:hidden; pointer-events:none; }
      .r { position:absolute; bottom:0; font-size:34px; will-change:transform,opacity;
           animation: up 2.2s ease-out forwards; }
      @keyframes up {
        0% { transform: translate(-50%,0) scale(.6); opacity:0; }
        15% { transform: translate(-50%,-10px) scale(1.1); opacity:1; }
        100% { transform: translate(-50%,-220px) scale(1); opacity:0; }
      }
      .chatbox { position:absolute; left:14px; bottom:14px; display:flex; flex-direction:column;
                 gap:6px; max-width:60%; }
      .cb { align-self:flex-start; padding:6px 11px; border-radius:14px; background:rgba(0,0,0,.72);
            color:#fff; font-size:13px; line-height:1.35; animation: cbin .2s ease-out, cbout .4s ease-in 5.6s forwards; }
      .cb b { color:#9ec1ff; margin-right:4px; }
      @keyframes cbin { from { opacity:0; transform:translateY(8px); } }
      @keyframes cbout { to { opacity:0; } }
    </style><div class="layer"><div class="chatbox"></div></div>`;
    this.layer = this.root.querySelector(".layer") as HTMLDivElement;
    this.chatbox = this.root.querySelector(".chatbox") as HTMLDivElement;
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
    this.layer.append(el);
    setTimeout(() => el.remove(), 2300);
  }

  /** Float a transient chat bubble over the video (own-tab). */
  chat(name: string, text: string): void {
    const el = document.createElement("div");
    el.className = "cb";
    const b = document.createElement("b");
    b.textContent = name;
    el.append(b, document.createTextNode(text));
    this.chatbox.append(el);
    setTimeout(() => el.remove(), 6000);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.host.remove();
  }
}
