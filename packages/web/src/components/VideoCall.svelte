<script lang="ts">
  import {
    ChevronDown,
    ChevronUp,
    GripVertical,
    Mic,
    MicOff,
    PhoneOff,
    Video,
    VideoOff,
  } from "lucide-svelte";
  import { onDestroy, onMount } from "svelte";
  import { CallManager } from "../lib/call";
  import type { RoomClient } from "../lib/room.svelte";

  interface Props {
    room: RoomClient;
    /** Leave the call — App hides this component. */
    onClose: () => void;
  }
  const { room, onClose }: Props = $props();

  let localEl = $state<HTMLVideoElement | null>(null);
  let remotes = $state<{ id: string; stream: MediaStream }[]>([]);
  let publishing = $state(false); // is our camera/mic acquired
  let micOn = $state(true);
  let camOn = $state(true);
  let error = $state<string | null>(null);
  let ready = $state(false); // joined the call
  let mgr: CallManager | undefined;

  // Draggable + resizable dock (defaults to the bottom-right corner).
  let dockEl = $state<HTMLElement | null>(null);
  let pos = $state<{ x: number; y: number } | null>(null);
  let width = $state(200);
  // Minimize to just the grip bar — a way to tuck the webcam out of the way
  // (it overlays the video, including in fullscreen).
  let collapsed = $state(false);

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
    room.onRtcSignal = (from, data) => mgr?.handleSignal(from, data);
    room.onCallError = (msg) => {
      error = msg;
      onClose();
    };
    void joinCall();
  });

  // Connect to / drop peers as people join and leave the call.
  $effect(() => {
    if (!ready || !mgr) return;
    const me = room.self;
    const ids = room.members.filter((m) => m.id !== me && m.inCall).map((m) => m.id);
    mgr.setPeers(ids);
  });

  // Attach the local preview once we're publishing and the element exists.
  $effect(() => {
    void publishing;
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

  async function joinCall() {
    await mgr?.join();
    room.setCall(true);
    ready = true;
  }

  async function turnOnCamera() {
    try {
      await mgr?.enableCamera();
      publishing = true;
      micOn = true;
      camOn = true;
      room.setCam(true);
    } catch {
      error = "Couldn't access your camera/mic. Check the browser permission and try again.";
    }
  }

  function toggleMic() {
    micOn = !micOn;
    mgr?.setMicEnabled(micOn);
  }
  function toggleCam() {
    camOn = !camOn;
    mgr?.setCamEnabled(camOn);
    room.setCam(camOn);
  }
  function leave() {
    onClose();
  }

  // ── drag + resize ──────────────────────────────────────────────────────────
  function startDrag(e: PointerEvent) {
    const parent = dockEl?.offsetParent as HTMLElement | null;
    if (!dockEl || !parent) return;
    const d = dockEl.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    const offX = e.clientX - d.left;
    const offY = e.clientY - d.top;
    const move = (ev: PointerEvent) => {
      const x = Math.max(0, Math.min(pr.width - d.width, ev.clientX - pr.left - offX));
      const y = Math.max(0, Math.min(pr.height - d.height, ev.clientY - pr.top - offY));
      pos = { x, y };
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function startResize(e: PointerEvent) {
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => {
      width = Math.max(130, Math.min(380, startW + (ev.clientX - startX)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  onDestroy(() => {
    room.onRtcSignal = () => {};
    room.onCallError = () => {};
    room.setCall(false);
    mgr?.stop();
  });
</script>

<div
  class="call-dock"
  bind:this={dockEl}
  style:width={`${width}px`}
  style:left={pos ? `${pos.x}px` : "auto"}
  style:top={pos ? `${pos.y}px` : "auto"}
  style:right={pos ? "auto" : "12px"}
  style:bottom={pos ? "auto" : "12px"}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="grip" onpointerdown={startDrag}>
    <GripVertical size={13} /> <span>Call</span>
    <button
      class="mini"
      onpointerdown={(e) => e.stopPropagation()}
      onclick={() => (collapsed = !collapsed)}
      title={collapsed ? "Expand" : "Minimize"}
    >
      {#if collapsed}<ChevronUp size={14} />{:else}<ChevronDown size={14} />{/if}
    </button>
  </div>

  {#if !collapsed}
    {#if error}<div class="msg">{error}</div>{/if}

    {#each remotes as r (r.id)}
      <div class="tile">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video use:attach={r.stream} autoplay playsinline></video>
        <span class="name">{nameOf(r.id)}</span>
      </div>
    {/each}

    {#if publishing}
      <div class="tile self" class:camoff={!camOn}>
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={localEl} autoplay playsinline muted></video>
        {#if !camOn}<span class="off-badge"><VideoOff size={20} /></span>{/if}
        <span class="name">you</span>
      </div>
    {/if}

    {#if ready && remotes.length === 0 && !error}
      <div class="hint">waiting for someone else to join the call…</div>
    {/if}

    <div class="controls">
      {#if publishing}
        <button class="cbtn" class:off={!micOn} onclick={toggleMic} title={micOn ? "Mute" : "Unmute"}>
          {#if micOn}<Mic size={15} />{:else}<MicOff size={15} />{/if}
        </button>
        <button class="cbtn" class:off={!camOn} onclick={toggleCam} title={camOn ? "Camera off" : "Camera on"}>
          {#if camOn}<Video size={15} />{:else}<VideoOff size={15} />{/if}
        </button>
      {:else}
        <button class="cbtn cam-on" onclick={turnOnCamera} title="Turn on your camera"><Video size={15} /> Camera</button>
      {/if}
      <button class="cbtn end" onclick={leave} title="Leave call"><PhoneOff size={15} /></button>
    </div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="resize" onpointerdown={startResize} title="Resize"></div>
  {/if}
</div>

<style>
  .call-dock {
    position: absolute;
    z-index: 6;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(6px);
  }
  .grip {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    cursor: grab;
    touch-action: none;
    user-select: none;
    padding: 1px 2px;
  }
  .grip:active {
    cursor: grabbing;
  }
  .mini {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    padding: 1px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
  }
  .mini:hover {
    background: rgba(255, 255, 255, 0.18);
    color: #fff;
  }
  .tile {
    position: relative;
    width: 100%;
    aspect-ratio: 4 / 3;
    border-radius: 8px;
    overflow: hidden;
    background: #000;
  }
  .tile video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .tile.self video {
    transform: scaleX(-1);
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
  .hint {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.75);
    text-align: center;
    padding: 8px 4px;
  }
  .msg {
    padding: 8px 10px;
    font-size: 12px;
    color: #fff;
    border-radius: 8px;
    background: color-mix(in srgb, var(--bad) 35%, #000);
  }
  .controls {
    display: flex;
    gap: 6px;
    justify-content: center;
  }
  .cbtn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 30px;
    padding: 0 10px;
    border: none;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.16);
    color: #fff;
    font-size: 12px;
  }
  .cbtn:hover {
    background: rgba(255, 255, 255, 0.28);
  }
  .cbtn.off,
  .cbtn.end {
    background: var(--bad);
  }
  .cbtn.cam-on {
    background: var(--accent);
  }
  .resize {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    touch-action: none;
    background: linear-gradient(
      135deg,
      transparent 0 50%,
      rgba(255, 255, 255, 0.5) 50% 60%,
      transparent 60% 70%,
      rgba(255, 255, 255, 0.5) 70% 80%,
      transparent 80%
    );
  }
</style>
