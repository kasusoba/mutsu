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
  /** How many things are floating right now — the rAF loop only runs while > 0. */
  private live = 0;
  private seq = 0;
  /** Linger multiplier (personal "speed" setting) — scales lifetimes. */
  private mult = 1;

  constructor(private readonly getRect: () => DOMRect | null) {
    this.host = document.createElement("div");
    this.host.style.cssText = "position:fixed;z-index:2147483645;pointer-events:none;inset:0;";
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.innerHTML = `<style>
      * { box-sizing:border-box; font-family: system-ui, sans-serif; }
      .layer { position:fixed; overflow:hidden; pointer-events:none; }
      .layer { --fun-mult: 1; }
      .r { position:absolute; bottom:0; font-size:34px; will-change:transform,opacity;
           animation: up calc(2.2s * var(--fun-mult)) ease-out forwards; }
      @keyframes up {
        0% { transform: translate(-50%,0) scale(.6); opacity:0; }
        15% { transform: translate(-50%,-10px) scale(1.1); opacity:1; }
        100% { transform: translate(-50%,-220px) scale(1); opacity:0; }
      }
      .g { position:absolute; bottom:10%; max-width:160px; max-height:160px; border-radius:10px;
           box-shadow:0 6px 22px rgba(0,0,0,.5); animation: gfloat calc(6s * var(--fun-mult)) ease-out forwards; }
      @keyframes gfloat {
        0% { transform: translate(-50%,20px) scale(.85); opacity:0; }
        8% { transform: translate(-50%,0) scale(1); opacity:1; }
        85% { transform: translate(-50%,-40px); opacity:1; }
        100% { transform: translate(-50%,-70px); opacity:0; }
      }
      .chatbox { position:absolute; left:14px; bottom:14px; display:flex; flex-direction:column;
                 gap:6px; max-width:60%; }
      .cb { align-self:flex-start; padding:6px 11px; border-radius:14px; background:rgba(0,0,0,.72);
            color:#fff; font-size:13px; line-height:1.35; animation: cblife calc(6s * var(--fun-mult)) ease forwards; }
      .cb b { color:#9ec1ff; margin-right:4px; }
      @keyframes cblife {
        0% { opacity:0; transform:translateY(8px); }
        4% { opacity:1; transform:translateY(0); }
        90% { opacity:1; }
        100% { opacity:0; }
      }
    </style><div class="layer"><div class="chatbox"></div></div>`;
    this.layer = this.root.querySelector(".layer") as HTMLDivElement;
    this.chatbox = this.root.querySelector(".chatbox") as HTMLDivElement;
  }

  mount(): void {
    (document.body ?? document.documentElement).append(this.host);
    // No rAF while idle. The loop reads getBoundingClientRect() every frame to
    // anchor the float region over the video — on a heavy SPA (YouTube) that
    // forces a full reflow 60×/s. Reactions are rare and ephemeral, so we only
    // spin the loop while something is actually on screen (`live > 0`).
  }

  /** Start the position loop if it isn't already running. */
  private ensureLoop(): void {
    if (this.raf) return;
    const loop = () => {
      if (this.live <= 0) {
        this.raf = 0;
        return; // nothing floating → stop until the next spawn (no reflow when idle)
      }
      this.position();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Register a floating element: keep the loop alive until it removes itself. */
  private hold(el: HTMLElement, ms: number): void {
    this.live++;
    this.ensureLoop();
    setTimeout(() => {
      el.remove();
      this.live--;
    }, ms);
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

  /** Set the linger multiplier (drives animation duration + cleanup timing). */
  setMult(m: number): void {
    this.mult = m;
    this.layer.style.setProperty("--fun-mult", String(m));
  }

  spawn(emoji: string): void {
    const el = document.createElement("span");
    el.className = "r";
    el.textContent = emoji;
    el.style.left = `${8 + Math.random() * 84}%`;
    this.layer.append(el);
    this.hold(el, 2300 * this.mult);
  }

  /** Float a transient GIF over the video (own-tab). */
  gif(url: string): void {
    const el = document.createElement("img");
    el.className = "g";
    el.src = url;
    el.alt = "gif";
    el.style.left = `${20 + Math.random() * 60}%`;
    this.layer.append(el);
    this.hold(el, 6000 * this.mult);
  }

  /** Float a transient chat bubble over the video (own-tab). */
  chat(name: string, text: string): void {
    const el = document.createElement("div");
    el.className = "cb";
    const b = document.createElement("b");
    b.textContent = name;
    el.append(b, document.createTextNode(text));
    this.chatbox.append(el);
    this.hold(el, 6000 * this.mult);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.host.remove();
  }
}
