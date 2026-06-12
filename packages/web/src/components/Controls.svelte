<script lang="ts">
  import type { RoomClient } from "../lib/room.svelte";
  import { extractSourceUrl } from "../lib/source";

  interface Props {
    room: RoomClient;
    pos: { t: number; dur: number; at: number };
  }
  const { room, pos }: Props = $props();

  let srcInput = $state("");
  let srcError = $state<string | null>(null);

  // Scrubbing state — while dragging, show the dragged value and don't fight the
  // incoming position reports.
  let scrubbing = $state(false);
  let scrubValue = $state(0);

  // Hover preview: where on the timeline the cursor is pointing.
  let hoverX = $state(-1);
  let hoverTime = $state(0);

  // A 250ms ticker so the displayed time advances smoothly between 1s reports.
  let tick = $state(0);
  $effect(() => {
    const id = setInterval(() => (tick = performance.now()), 250);
    return () => clearInterval(id);
  });

  const playing = $derived(room.sync?.intent === "playing");
  const mode = $derived(room.sync?.mode ?? "open");
  const rate = $derived(room.sync?.rate ?? 1);
  const hasSrc = $derived(Boolean(room.sync?.src));

  // Interpolated current time: last report + elapsed wall-clock if playing.
  const liveTime = $derived.by(() => {
    void tick;
    if (scrubbing) return scrubValue;
    const base = pos.t;
    if (!playing) return base;
    return base + ((performance.now() - pos.at) / 1000) * rate;
  });
  const clampedTime = $derived(Math.min(Math.max(0, liveTime), pos.dur || liveTime));

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
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    hoverX = e.clientX - rect.left;
    hoverTime = frac * (pos.dur || 0);
  }
  function onScrubLeave() {
    hoverX = -1;
  }
  function setRate(r: number) {
    room.control(room.sync?.intent ?? "paused", clampedTime, r);
  }
  function setSource() {
    const { url, error } = extractSourceUrl(srcInput);
    if (error || !url) {
      srcError = error ?? "Invalid source.";
      return;
    }
    srcError = null;
    room.setSource(url);
    srcInput = "";
  }
</script>

<div class="bar">
  <!-- scrubber -->
  <div class="row seek">
    <span class="time">{fmt(clampedTime)}</span>
    <div
      class="scrub-wrap"
      role="presentation"
      onmousemove={onScrubHover}
      onmouseleave={onScrubLeave}
    >
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
      />
      {#if hoverX >= 0 && pos.dur}
        <span class="seek-tip" style="left: {hoverX}px">{fmt(hoverTime)}</span>
      {/if}
    </div>
    <span class="time">{pos.dur ? fmt(pos.dur) : "--:--"}</span>
  </div>

  <!-- transport -->
  <div class="row">
    <button class="play" onclick={togglePlay} disabled={!room.canControl || !hasSrc}>
      {playing ? "⏸ Pause" : "▶ Play"}
    </button>
    <button onclick={() => nudge(-10)} disabled={!room.canControl || !hasSrc}>−10s</button>
    <button onclick={() => nudge(10)} disabled={!room.canControl || !hasSrc}>+10s</button>

    <label class="rate">
      speed
      <select
        value={rate}
        disabled={!room.canControl || !hasSrc}
        onchange={(e) => setRate(+e.currentTarget.value)}
      >
        {#each [0.5, 0.75, 1, 1.25, 1.5, 2] as r (r)}
          <option value={r}>{r}×</option>
        {/each}
      </select>
    </label>

    {#if room.gate.paused}
      <span class="badge warn">buffering… ({room.gate.waitingFor.length})</span>
    {/if}

    <span class="spacer"></span>

    <button
      onclick={() => room.setMode(mode === "host" ? "open" : "host")}
      disabled={!room.canControl}
      title="open = anyone controls; host = only the host"
    >
      mode: {mode}
    </button>
  </div>

  <!-- source -->
  <div class="row">
    <input
      class="src"
      bind:value={srcInput}
      placeholder="paste an embed/source URL or <iframe> code…"
      onkeydown={(e) => e.key === "Enter" && setSource()}
    />
    <button onclick={setSource} disabled={!room.canControl || !srcInput.trim()}>set source</button>
  </div>
  {#if srcError}<p class="src-err">{srcError}</p>{/if}
</div>

<style>
  .bar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--panel);
    border-top: 1px solid var(--line);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .seek {
    gap: 10px;
  }
  .scrub-wrap {
    position: relative;
    flex: 1;
    display: flex;
  }
  .scrub {
    flex: 1;
    accent-color: var(--accent);
  }
  .seek-tip {
    position: absolute;
    bottom: 18px;
    transform: translateX(-50%);
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    color: var(--text);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    white-space: nowrap;
  }
  .src {
    flex: 1;
  }
  .time {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    font-size: 12px;
    min-width: 44px;
    text-align: center;
  }
  .play {
    min-width: 92px;
  }
  .rate {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--muted);
    font-size: 12px;
  }
  .rate select {
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 6px;
  }
  .spacer {
    flex: 1;
  }
  .badge {
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
  }
  .warn {
    background: color-mix(in srgb, var(--warn) 20%, transparent);
    color: var(--warn);
  }
  .src-err {
    margin: 0;
    color: var(--bad);
    font-size: 12px;
  }
</style>
