<script lang="ts">
  import type { GateMessage, Intent, MemberStatus, SyncMessage } from "@sixseven/protocol";
  import type HlsInstance from "hls.js";
  import { isHlsUrl } from "../lib/source";
  import type { SubtitleController } from "../lib/subtitleController.svelte";
  import { WebPlayer } from "../lib/webPlayer";

  interface Props {
    src: string;
    sync: SyncMessage | null;
    gate: GateMessage;
    subs: SubtitleController | null;
    /** Alone in the room → don't force realtime, just play (no drift seeks). */
    solo: boolean;
    onStatus: (state: MemberStatus, currentTime: number, duration: number) => void;
    /** A user action on OUR controls (click-to-toggle) → relayed to the room. */
    onUserControl: (intent: Intent, time: number) => void;
  }
  const { src, sync, gate, subs, solo, onStatus, onUserControl }: Props = $props();

  let video = $state<HTMLVideoElement | null>(null);
  let player = $state<WebPlayer | null>(null);
  let loadError = $state<string | null>(null);
  let hls: HlsInstance | null = null;
  let loadGen = 0;
  // The URL currently loaded into the element. Guards against re-loading the
  // same source (which would reset currentTime to 0 — replaying the intro).
  let loadedUrl: string | null = null;

  // Live subtitle cue + (opt-in) debug readout, refreshed on a small timer.
  let cueText = $state<string | null>(null);
  let hud = $state<{ t: number; want: number; drift: number; seeks: number } | null>(null);
  const showHud = new URLSearchParams(location.search).has("hud");
  // When the current sync arrived (perf clock), so we can project the server's
  // time forward between heartbeats — that's the "where you should be NOW".
  let syncAt = 0;
  let seekCount = 0;

  const PLAIN_FILE = /\.(mp4|webm|ogg|ogv|mov|m4v|mp3|m4a|aac|flac|wav)(\?|#|$)/i;

  function teardownHls() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
  }

  async function useHls(v: HTMLVideoElement, url: string, allowNativeFallback: boolean) {
    const gen = loadGen;
    const { default: Hls } = await import("hls.js");
    if (gen !== loadGen) return;
    if (!Hls.isSupported()) {
      v.src = url;
      v.load();
      return;
    }
    const inst = new Hls({ enableWorker: true });
    hls = inst;
    let fellBack = false;
    inst.on(Hls.Events.ERROR, (_evt, data) => {
      console.warn("[6seven] hls error:", data.type, data.details, "fatal:", data.fatal);
      if (!data.fatal || gen !== loadGen) return;
      if (allowNativeFallback && !fellBack) {
        fellBack = true;
        teardownHls();
        v.src = url;
        v.load();
        return;
      }
      loadError = `Couldn't load this stream (${data.type} / ${data.details}). If it's a real stream, it may be locked to its origin site (referer/token), which sixseven won't bypass.`;
    });
    inst.loadSource(url);
    inst.attachMedia(v);
  }

  function loadSource(v: HTMLVideoElement, url: string) {
    if (url === loadedUrl) return; // already loaded this exact source — don't reset to 0
    loadedUrl = url;
    loadGen++;
    teardownHls();
    loadError = null;
    v.removeAttribute("src");
    const nativeHls = v.canPlayType("application/vnd.apple.mpegurl") !== "";
    if (isHlsUrl(url)) {
      if (nativeHls) {
        v.src = url;
        v.load();
      } else {
        void useHls(v, url, false);
      }
      return;
    }
    if (PLAIN_FILE.test(url)) {
      v.src = url;
      v.load();
      return;
    }
    if (nativeHls) {
      v.src = url;
      v.load();
      return;
    }
    void useHls(v, url, true);
  }

  function toggle() {
    if (!sync || !video) return;
    onUserControl(sync.intent === "playing" ? "paused" : "playing", video.currentTime);
  }

  // (Re)load when the URL changes.
  $effect(() => {
    const url = src;
    const v = video;
    if (!v || !url) return;
    loadSource(v, url);
  });

  // Create the one-way controller once the element exists.
  $effect(() => {
    const v = video;
    if (!v) return;
    const p = new WebPlayer(v);
    p.onStatus = onStatus;
    p.onSeek = () => {
      seekCount++;
    };
    p.solo = solo;
    p.start();
    player = p;
    // Subtitle + HUD ticker (independent of the 1s status poll for smoothness).
    const tick = setInterval(() => {
      const t = v.currentTime;
      const cues = subs?.cues;
      if (cues && cues.length) {
        const ref = t - (subs?.style.offsetMs ?? 0) / 1000;
        const cur = cues.find((c) => ref >= c.start && ref <= c.end);
        cueText = cur?.text ?? null;
      } else if (cueText !== null) {
        cueText = null;
      }
      if (showHud) {
        // Project the server clock forward from when this sync arrived — this is
        // the position the server thinks you should be at *now*, the real target.
        const playing = sync?.intent === "playing" && !gate.paused;
        const want =
          (sync?.time ?? 0) + (playing ? ((performance.now() - syncAt) / 1000) * (sync?.rate ?? 1) : 0);
        hud = { t, want, drift: t - want, seeks: seekCount };
      }
    }, 150);
    return () => {
      clearInterval(tick);
      p.destroy();
      player = null;
    };
  });

  // Keep the controller's solo flag current as members come and go.
  $effect(() => {
    if (player) player.solo = solo;
  });

  // Enforce server truth — only on a fresh sync or a gate-pause flip.
  let lastSync: SyncMessage | null = null;
  let lastPaused: boolean | null = null;
  $effect(() => {
    const p = player;
    if (!p || !sync) return;
    if (sync === lastSync && gate.paused === lastPaused) return;
    lastSync = sync;
    lastPaused = gate.paused;
    syncAt = performance.now();
    p.apply(sync, gate);
  });

  $effect(() => () => teardownHls());

  const style = $derived(subs?.style ?? null);
</script>

<div class="stage">
  <!-- svelte-ignore a11y_media_has_caption -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <video bind:this={video} playsinline onclick={toggle}></video>

  {#if cueText && style}
    <div
      class="subs"
      style:font-size={`calc(3.2vh * ${style.sizePct / 100})`}
      style:top={style.position === "top" ? `${style.marginPct}%` : "auto"}
      style:bottom={style.position === "top" ? "auto" : `${style.marginPct}%`}
    >
      <span
        style:color={style.color}
        style:opacity={style.opacity}
        style:background={`rgba(0,0,0,${style.background})`}
      >
        {@html cueText.replace(/\n/g, "<br>")}
      </span>
    </div>
  {/if}

  {#if showHud && hud}
    <div class="hud">
      t={hud.t.toFixed(2)} · want={hud.want.toFixed(2)} · drift={hud.drift.toFixed(2)} · seeks={hud.seeks}
      · {sync?.intent}{gate.paused ? " · GATED" : ""}{solo ? " · solo" : ""}
    </div>
  {/if}

  {#if loadError}
    <div class="err">{loadError}</div>
  {/if}
</div>

<style>
  .stage {
    position: relative;
    flex: 1;
    background: #000;
    min-height: 0;
  }
  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: #000;
    cursor: pointer;
  }
  .subs {
    position: absolute;
    left: 0;
    right: 0;
    text-align: center;
    pointer-events: none;
    padding: 0 6%;
    line-height: 1.3;
  }
  .subs span {
    padding: 0.1em 0.4em;
    border-radius: 4px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
    white-space: pre-wrap;
  }
  .hud {
    position: absolute;
    top: 8px;
    left: 8px;
    padding: 4px 8px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.7);
    color: #6ea8fe;
    font: 12px/1.2 ui-monospace, monospace;
    pointer-events: none;
  }
  .err {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 12px;
    padding: 10px 12px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--bad) 30%, #000);
    color: var(--text);
    font-size: 13px;
  }
</style>
