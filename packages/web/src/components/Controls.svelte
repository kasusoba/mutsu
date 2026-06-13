<script lang="ts">
  import { FastForward, Maximize, Pause, Play, Rewind, Volume2, VolumeX } from "lucide-svelte";
  import type { RoomClient } from "../lib/room.svelte";

  interface Props {
    room: RoomClient;
    pos: { t: number; dur: number; at: number };
    muted: boolean;
    volume: number;
    onMute: () => void;
    onVolume: (v: number) => void;
    onFullscreen: () => void;
  }
  const { room, pos, muted, volume, onMute, onVolume, onFullscreen }: Props = $props();

  let scrubbing = $state(false);
  let scrubFrac = $state(0);
  let hoverX = $state(-1);
  let hoverTime = $state(0);
  // After a seek we optimistically show the target until the next status report
  // arrives (pos.at advances past `at`), so the bar lands exactly where clicked
  // instead of snapping back to the stale position and jumping forward ~1s later.
  let seekHold = $state<{ target: number; at: number; until: number } | null>(null);
  let volDragging = $state(false);

  let tick = $state(0);
  $effect(() => {
    const id = setInterval(() => (tick = performance.now()), 250);
    return () => clearInterval(id);
  });

  const playing = $derived(room.sync?.intent === "playing");
  const rate = $derived(room.sync?.rate ?? 1);
  const hasSrc = $derived(Boolean(room.sync?.src));

  const liveTime = $derived.by(() => {
    void tick;
    if (scrubbing) return scrubFrac * (pos.dur || 0);
    const hold = seekHold;
    if (hold && pos.at <= hold.at && performance.now() < hold.until) {
      return playing ? hold.target + ((performance.now() - hold.at) / 1000) * rate : hold.target;
    }
    const base = pos.t;
    if (!playing) return base;
    return base + ((performance.now() - pos.at) / 1000) * rate;
  });
  const clampedTime = $derived(Math.min(Math.max(0, liveTime), pos.dur || liveTime));
  const frac = $derived(pos.dur ? Math.min(1, clampedTime / pos.dur) : 0);
  const volFracDisplay = $derived(muted ? 0 : volume);

  function fmt(t: number): string {
    if (!Number.isFinite(t)) return "0:00";
    const s = Math.max(0, Math.floor(t));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = `${m}`.padStart(h ? 2 : 1, "0");
    return `${h ? `${h}:` : ""}${mm}:${`${sec}`.padStart(2, "0")}`;
  }
  function togglePlay() {
    room.control(playing ? "paused" : "playing", clampedTime, rate);
  }
  function nudge(delta: number) {
    room.control(room.sync?.intent ?? "paused", Math.max(0, clampedTime + delta), rate);
  }
  // Pixel-accurate fraction from a pointer over a track element. A native
  // <input type=range> maps clicks through its (invisible) thumb width, so the
  // value never quite reaches the ends and a click lands a few px off — we read
  // the geometry directly instead so the seek/volume hit exactly where you click.
  function fracOf(e: PointerEvent, el: HTMLElement): number {
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function onSeekDown(e: PointerEvent) {
    if (!room.canControl || !hasSrc || !pos.dur) return;
    scrubbing = true;
    scrubFrac = fracOf(e, e.currentTarget as HTMLElement);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onSeekMove(e: PointerEvent) {
    if (scrubbing) scrubFrac = fracOf(e, e.currentTarget as HTMLElement);
  }
  function onSeekUp() {
    if (!scrubbing) return;
    scrubbing = false;
    const target = scrubFrac * (pos.dur || 0);
    room.control(room.sync?.intent ?? "paused", target, rate);
    seekHold = { target, at: performance.now(), until: performance.now() + 6000 };
  }
  function onScrubHover(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    hoverX = e.clientX - rect.left;
    hoverTime = f * (pos.dur || 0);
  }

  function onVolDown(e: PointerEvent) {
    volDragging = true;
    onVolume(fracOf(e, e.currentTarget as HTMLElement));
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onVolMove(e: PointerEvent) {
    if (volDragging) onVolume(fracOf(e, e.currentTarget as HTMLElement));
  }

  function setRate(r: number) {
    room.control(room.sync?.intent ?? "paused", clampedTime, r);
  }
</script>

<div class="bar">
  <div
    class="scrub-wrap"
    class:disabled={!room.canControl || !hasSrc || !pos.dur}
    role="slider"
    tabindex="0"
    aria-label="Seek"
    aria-valuemin="0"
    aria-valuemax={Math.round(pos.dur || 0)}
    aria-valuenow={Math.round(clampedTime)}
    onpointerdown={onSeekDown}
    onpointermove={(e) => {
      onSeekMove(e);
      onScrubHover(e);
    }}
    onpointerup={onSeekUp}
    onmouseleave={() => (hoverX = -1)}
  >
    <div class="track">
      <div class="fill" style="width: {frac * 100}%"></div>
      <div class="knob" style="left: {frac * 100}%"></div>
    </div>
    {#if hoverX >= 0 && pos.dur}
      <span class="seek-tip" style="left: {hoverX}px">{fmt(hoverTime)}</span>
    {/if}
  </div>

  <div class="ctl">
    <button class="ico play" onclick={togglePlay} disabled={!room.canControl || !hasSrc} title={playing ? "Pause" : "Play"}>
      {#if playing}<Pause size={20} fill="currentColor" />{:else}<Play size={20} fill="currentColor" />{/if}
    </button>
    <button class="ico" onclick={() => nudge(-10)} disabled={!room.canControl || !hasSrc} title="Back 10s"><Rewind size={18} /></button>
    <button class="ico" onclick={() => nudge(10)} disabled={!room.canControl || !hasSrc} title="Forward 10s"><FastForward size={18} /></button>

    <div class="vol">
      <button class="ico" onclick={onMute} title={muted ? "Unmute" : "Mute"}>
        {#if muted || volume === 0}<VolumeX size={18} />{:else}<Volume2 size={18} />{/if}
      </button>
      <div
        class="vol-track"
        role="slider"
        tabindex="0"
        aria-label="Volume"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(volFracDisplay * 100)}
        onpointerdown={onVolDown}
        onpointermove={onVolMove}
        onpointerup={() => (volDragging = false)}
      >
        <div class="vol-fill" style="width: {volFracDisplay * 100}%"></div>
        <div class="knob" style="left: {volFracDisplay * 100}%"></div>
      </div>
    </div>

    <span class="time">{fmt(clampedTime)} <span class="sep">/</span> {pos.dur ? fmt(pos.dur) : "--:--"}</span>

    {#if room.gate.paused}
      <span class="badge">buffering… {room.gate.waitingFor.length}</span>
    {/if}

    <span class="spacer"></span>

    <select class="rate" value={rate} disabled={!room.canControl || !hasSrc} onchange={(e) => setRate(+e.currentTarget.value)} title="Speed">
      {#each [0.5, 0.75, 1, 1.25, 1.5, 2] as r (r)}
        <option value={r}>{r}×</option>
      {/each}
    </select>
    <button class="ico" onclick={onFullscreen} title="Fullscreen"><Maximize size={18} /></button>
  </div>
</div>

<style>
  .bar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 12px 10px;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.85), rgba(0, 0, 0, 0.4) 70%, transparent);
  }
  .scrub-wrap {
    position: relative;
    height: 16px;
    display: flex;
    align-items: center;
    cursor: pointer;
    touch-action: none;
  }
  .scrub-wrap.disabled {
    cursor: default;
  }
  .scrub-wrap:hover .knob {
    transform: translate(-50%, -50%) scale(1);
  }
  .track {
    position: absolute;
    left: 0;
    right: 0;
    height: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.25);
  }
  .fill {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
  }
  .knob {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
    transform: translate(-50%, -50%) scale(0);
    transition: transform 0.12s ease;
    pointer-events: none;
  }
  .scrub-wrap.disabled .knob {
    display: none;
  }
  .seek-tip {
    position: absolute;
    bottom: 20px;
    transform: translateX(-50%);
    padding: 2px 6px;
    border-radius: 4px;
    background: #000;
    color: #fff;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    white-space: nowrap;
  }
  .ctl {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .ico {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    border-radius: 8px;
    padding: 7px;
    color: #fff;
    line-height: 0;
  }
  .ico:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.15);
  }
  .vol {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .vol-track {
    position: relative;
    width: 72px;
    height: 14px;
    display: flex;
    align-items: center;
    cursor: pointer;
    touch-action: none;
  }
  .vol-track::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    height: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.25);
  }
  .vol-fill {
    position: absolute;
    left: 0;
    height: 4px;
    border-radius: 999px;
    background: #fff;
  }
  .vol-track .knob {
    background: #fff;
    transform: translate(-50%, -50%) scale(0);
  }
  .vol-track:hover .knob {
    transform: translate(-50%, -50%) scale(1);
  }
  .time {
    font-variant-numeric: tabular-nums;
    color: #fff;
    font-size: 12px;
    padding: 0 6px;
    white-space: nowrap;
  }
  .time .sep {
    color: rgba(255, 255, 255, 0.5);
  }
  .spacer {
    flex: 1;
  }
  .rate {
    color: #fff;
    background: rgba(255, 255, 255, 0.12);
    border: none;
    border-radius: 8px;
    padding: 6px 6px;
    font-size: 12px;
  }
  .rate option {
    color: var(--text);
    background: var(--panel);
  }
  .badge {
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    background: color-mix(in srgb, var(--warn) 30%, transparent);
    color: #fff;
  }
</style>
