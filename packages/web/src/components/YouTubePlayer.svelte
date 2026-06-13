<script lang="ts">
  import type { GateMessage, Intent, MemberStatus, SyncMessage } from "@sixseven/protocol";
  import { Volume2 } from "lucide-svelte";
  import { parseYouTubeId } from "../lib/source";
  import type { SubtitleController } from "../lib/subtitleController.svelte";
  import { loadYouTubeApi, type YtApi, YtPlayer } from "../lib/ytPlayer";

  interface Props {
    src: string;
    sync: SyncMessage | null;
    gate: GateMessage;
    subs: SubtitleController | null;
    solo: boolean;
    onStatus: (state: MemberStatus, currentTime: number, duration: number) => void;
    /** The viewer's play/pause/seek on YouTube's own controls → relay to the room. */
    onUserControl: (intent: Intent, time: number) => void;
  }
  const { src, sync, gate, subs, solo, onStatus, onUserControl }: Props = $props();

  let mount = $state<HTMLDivElement | null>(null);
  let player = $state<YtPlayer | null>(null);
  let loadError = $state<string | null>(null);
  let muted = $state(true);
  let cueText = $state<string | null>(null);

  const videoId = $derived(parseYouTubeId(src));

  // Build the YT player once the mount node exists. YouTube's NATIVE controls
  // stay visible (controls:1); we sync through the API and report the viewer's
  // own actions back. Muted autoplay so it starts in sync with no click.
  $effect(() => {
    const el = mount;
    const id = videoId;
    if (!el || !id) {
      if (!id) loadError = "Couldn't read a YouTube video id from that URL.";
      return;
    }
    let p: YtPlayer | null = null;
    let cancelled = false;
    loadError = null;

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;
        const host = document.createElement("div");
        el.appendChild(host);
        const ytPlayer = new YT.Player(host, {
          videoId: id,
          playerVars: { controls: 1, modestbranding: 1, rel: 0, playsinline: 1 },
          events: {
            onReady: (e: { target: YtApi }) => {
              if (cancelled) return;
              p = new YtPlayer(e.target);
              p.onStatus = onStatus;
              p.onUserControl = onUserControl;
              p.onMutedChange = (m) => (muted = m);
              p.solo = solo;
              p.start();
              player = p;
              if (sync) p.apply(sync, gate);
            },
            onStateChange: (e: { data: number }) => p?.onYtState(e.data),
            onError: () => {
              loadError = "YouTube wouldn't play this video (removed, private, or embedding disabled).";
            },
          },
        });
        void ytPlayer;
      })
      .catch(() => {
        loadError = "Couldn't load the YouTube player.";
      });

    return () => {
      cancelled = true;
      p?.destroy();
      player = null;
      el.replaceChildren();
    };
  });

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
    p.apply(sync, gate);
  });

  // Subtitle overlay ticker (our personal cues, over the player).
  $effect(() => {
    const p = player;
    if (!p) return;
    const tick = setInterval(() => {
      const cues = subs?.cues;
      if (cues && cues.length) {
        const ref = p.currentTime() - (subs?.style.offsetMs ?? 0) / 1000;
        cueText = cues.find((c) => ref >= c.start && ref <= c.end)?.text ?? null;
      } else if (cueText !== null) {
        cueText = null;
      }
    }, 150);
    return () => clearInterval(tick);
  });

  const style = $derived(subs?.style ?? null);
</script>

<div class="stage">
  <div class="yt" bind:this={mount}></div>

  {#if muted && !loadError}
    <button class="unmute" onclick={() => player?.unmute()}>
      <Volume2 size={16} /> Tap to unmute
    </button>
  {/if}

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
  .yt {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .yt :global(iframe) {
    width: 100%;
    height: 100%;
  }
  .unmute {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 3;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: 999px;
    border: none;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .subs {
    position: absolute;
    left: 0;
    right: 0;
    text-align: center;
    pointer-events: none;
    padding: 0 6%;
    line-height: 1.3;
    z-index: 2;
    /* sit above YouTube's control bar */
    margin-bottom: 8%;
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
  .err {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 12px;
    z-index: 3;
    padding: 10px 12px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--bad) 30%, #000);
    color: var(--text);
    font-size: 13px;
  }
</style>
