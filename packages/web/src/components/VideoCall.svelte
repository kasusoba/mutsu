<script lang="ts">
  import { Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-svelte";
  import { onDestroy, onMount } from "svelte";
  import { CallManager } from "../lib/call";
  import type { RoomClient } from "../lib/room.svelte";

  interface Props {
    room: RoomClient;
    /** Leave the call (camera off) — App hides this component. */
    onClose: () => void;
  }
  const { room, onClose }: Props = $props();

  let localEl = $state<HTMLVideoElement | null>(null);
  let remotes = $state<{ id: string; stream: MediaStream }[]>([]);
  let micOn = $state(true);
  let camOn = $state(true);
  let error = $state<string | null>(null);
  let ready = $state(false);
  let mgr: CallManager | undefined;

  onMount(() => {
    const self = room.self ?? "";
    mgr = new CallManager(
      self,
      (to, data) => room.rtcSignal(to, data),
      async () => (await room.iceServers()).iceServers,
      (id, stream) => {
        if (stream) {
          if (!remotes.some((r) => r.id === id)) remotes = [...remotes, { id, stream }];
        } else {
          remotes = remotes.filter((r) => r.id !== id);
        }
      },
    );
    // Inbound signals + the "room is full" rejection route to us while mounted.
    room.onRtcSignal = (from, data) => mgr?.handleSignal(from, data);
    room.onCallError = (msg) => {
      error = msg;
      onClose();
    };
    start();
  });

  // Reconcile WebRTC peers with whoever else has their camera on.
  $effect(() => {
    if (!ready || !mgr) return;
    const me = room.self;
    const ids = room.members.filter((m) => m.id !== me && m.cam).map((m) => m.id);
    mgr.setPeers(ids);
  });

  // Attach the local preview once we have both the element and the stream.
  // `ready` flips after startMedia(), re-running this so the late stream attaches.
  $effect(() => {
    void ready;
    if (localEl && mgr?.localStream) localEl.srcObject = mgr.localStream;
  });

  function nameOf(id: string): string {
    return room.members.find((m) => m.id === id)?.name ?? "guest";
  }

  function attach(el: HTMLVideoElement, stream: MediaStream) {
    el.srcObject = stream;
    return {
      update(s: MediaStream) {
        el.srcObject = s;
      },
    };
  }

  async function start() {
    try {
      await mgr?.startMedia();
      room.setCam(true);
      ready = true;
    } catch {
      error = "Couldn't access your camera/mic. Check the browser permission and try again.";
      onClose();
    }
  }

  function toggleMic() {
    micOn = !micOn;
    mgr?.setMicEnabled(micOn);
  }
  function toggleCam() {
    camOn = !camOn;
    mgr?.setCamEnabled(camOn);
  }
  function leave() {
    onClose();
  }

  onDestroy(() => {
    room.onRtcSignal = () => {};
    room.onCallError = () => {};
    room.setCam(false);
    mgr?.stop();
  });
</script>

<div class="call-dock">
  {#if error}
    <div class="tile msg">{error}</div>
  {/if}

  {#each remotes as r (r.id)}
    <div class="tile">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video use:attach={r.stream} autoplay playsinline></video>
      <span class="name">{nameOf(r.id)}</span>
    </div>
  {/each}

  <div class="tile self" class:camoff={!camOn}>
    <!-- svelte-ignore a11y_media_has_caption -->
    <video bind:this={localEl} autoplay playsinline muted></video>
    {#if !camOn}<span class="off-badge"><VideoOff size={20} /></span>{/if}
    <span class="name">you</span>
    {#if ready && remotes.length === 0 && !error}
      <span class="waiting">waiting for someone to join…</span>
    {/if}
  </div>

  <div class="controls">
    <button class="cbtn" class:off={!micOn} onclick={toggleMic} title={micOn ? "Mute" : "Unmute"}>
      {#if micOn}<Mic size={16} />{:else}<MicOff size={16} />{/if}
    </button>
    <button class="cbtn" class:off={!camOn} onclick={toggleCam} title={camOn ? "Camera off" : "Camera on"}>
      {#if camOn}<Video size={16} />{:else}<VideoOff size={16} />{/if}
    </button>
    <button class="cbtn end" onclick={leave} title="Leave call"><PhoneOff size={16} /></button>
  </div>
</div>

<style>
  .call-dock {
    position: absolute;
    right: 12px;
    bottom: 12px;
    z-index: 6;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-end;
    pointer-events: none;
  }
  .tile {
    position: relative;
    width: 180px;
    aspect-ratio: 4 / 3;
    border-radius: 10px;
    overflow: hidden;
    background: #000;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    pointer-events: auto;
  }
  .tile video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .tile.self video {
    transform: scaleX(-1); /* mirror your own preview, like every webcam UI */
  }
  .tile.camoff video {
    visibility: hidden;
  }
  .off-badge {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--muted);
  }
  .name {
    position: absolute;
    left: 6px;
    bottom: 5px;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
  }
  .waiting {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    text-align: center;
    padding: 0 10px;
    font-size: 12px;
    color: var(--muted);
    background: rgba(0, 0, 0, 0.35);
  }
  .msg {
    width: 200px;
    aspect-ratio: auto;
    padding: 10px 12px;
    font-size: 12px;
    color: var(--text);
    background: color-mix(in srgb, var(--bad) 30%, #000);
    display: flex;
    align-items: center;
  }
  .controls {
    display: flex;
    gap: 6px;
    padding: 5px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.65);
    pointer-events: auto;
  }
  .cbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.14);
    color: #fff;
  }
  .cbtn:hover {
    background: rgba(255, 255, 255, 0.25);
  }
  .cbtn.off {
    background: var(--bad);
    color: #fff;
  }
  .cbtn.end {
    background: var(--bad);
    color: #fff;
  }
</style>
