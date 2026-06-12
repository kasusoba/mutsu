<script lang="ts">
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
  let scrubValue = $state(0);
  let hoverX = $state(-1);
  let hoverTime = $state(0);

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
    if (scrubbing) return scrubValue;
    const base = pos.t;
    if (!playing) return base;
    return base + ((performance.now() - pos.at) / 1000) * rate;
  });
  const clampedTime = $derived(Math.min(Math.max(0, liveTime), pos.dur || liveTime));
  const frac = $derived(pos.dur ? Math.min(1, clampedTime / pos.dur) : 0);

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
  function onScrubInput(e: Event) {
    scrubbing = true;
    scrubValue = +(e.target as HTMLInputElement).value;
  }
  function onScrubCommit() {
    room.control(room.sync?.intent ?? "paused", scrubValue, rate);
    scrubbing = false;
  }
  function onScrubHover(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    hoverX = e.clientX - rect.left;
    hoverTime = f * (pos.dur || 0);
  }
  function setRate(r: number) {
    room.control(room.sync?.intent ?? "paused", clampedTime, r);
  }
</script>

<div class="bar">
  <div
    class="scrub-wrap"
    role="presentation"
    onmousemove={onScrubHover}
    onmouseleave={() => (hoverX = -1)}
  >
    <div class="track"><div class="fill" style="width: {frac * 100}%"></div></div>
    <input
      class="scrub"
      type="range"
      min="0"
      max={pos.dur || 0}
      step="0.1"
      value={clampedTime}
      disabled={!room.canControl || !hasSrc || !pos.dur}
      oninput={onScrubInput}
      onchange={onScrubCommit}
      aria-label="Seek"
    />
    {#if hoverX >= 0 && pos.dur}
      <span class="seek-tip" style="left: {hoverX}px">{fmt(hoverTime)}</span>
    {/if}
  </div>

  <div class="ctl">
    <button class="ico play" onclick={togglePlay} disabled={!room.canControl || !hasSrc} title={playing ? "Pause" : "Play"}>
      {playing ? "⏸" : "▶"}
    </button>
    <button class="ico" onclick={() => nudge(-10)} disabled={!room.canControl || !hasSrc} title="Back 10s">⏪</button>
    <button class="ico" onclick={() => nudge(10)} disabled={!room.canControl || !hasSrc} title="Forward 10s">⏩</button>

    <div class="vol">
      <button class="ico" onclick={onMute} title={muted ? "Unmute" : "Mute"}>{muted || volume === 0 ? "🔇" : "🔊"}</button>
      <input class="vol-slider" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} oninput={(e) => onVolume(+e.currentTarget.value)} aria-label="Volume" />
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
    <button class="ico" onclick={onFullscreen} title="Fullscreen">⛶</button>
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
  }
  .track {
    position: absolute;
    left: 0;
    right: 0;
    height: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.25);
    overflow: hidden;
    pointer-events: none;
  }
  .fill {
    height: 100%;
    background: var(--accent);
  }
  .scrub {
    position: absolute;
    inset: 0;
    width: 100%;
    margin: 0;
    padding: 0;
    background: none;
    border: none;
    accent-color: var(--accent);
    opacity: 0;
    cursor: pointer;
  }
  .scrub:disabled {
    cursor: default;
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
    background: none;
    border: none;
    border-radius: 8px;
    padding: 6px 8px;
    min-width: 34px;
    color: #fff;
    font-size: 15px;
    line-height: 1;
  }
  .ico:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.15);
  }
  .ico.play {
    font-size: 18px;
  }
  .vol {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .vol-slider {
    width: 72px;
    accent-color: #fff;
    background: none;
    border: none;
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
