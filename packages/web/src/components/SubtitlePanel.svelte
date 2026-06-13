<script lang="ts">
  import { Search, Upload } from "lucide-svelte";
  import type { SubtitleController } from "../lib/subtitleController.svelte";

  interface Props {
    subs: SubtitleController;
  }
  const { subs }: Props = $props();

  let query = $state("");
  let season = $state("");
  let episode = $state("");
  let showEp = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  async function onFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) await subs.loadFile(file);
  }
  function runSearch() {
    subs.search(query, season ? +season : undefined, episode ? +episode : undefined);
  }

  const offsetSec = $derived((subs.style.offsetMs / 1000).toFixed(2));
</script>

<section>
  <!-- ── source ── -->
  <div class="group">
    <div class="grp-head">
      <span class="grp-title">Subtitles</span>
      {#if subs.activeLabel}
        <span class="active" title={subs.activeLabel}>{subs.activeLabel}</span>
        <button class="link" onclick={() => subs.clear()}>clear</button>
      {/if}
    </div>

    <button class="wide with-ico" onclick={() => fileInput?.click()}>
      <Upload size={15} /> Upload a .srt / .vtt file
    </button>
    <input bind:this={fileInput} type="file" accept=".srt,.vtt" onchange={onFile} hidden />

    <div class="search">
      <input
        class="grow"
        bind:value={query}
        placeholder="Search online — movie or show title"
        onkeydown={(e) => e.key === "Enter" && runSearch()}
      />
      <button
        class="ep-toggle"
        class:on={showEp}
        title="Searching a TV episode?"
        onclick={() => (showEp = !showEp)}>S/E</button
      >
      <button class="with-ico" onclick={runSearch} disabled={subs.searching || !query.trim()}>
        <Search size={15} /> {subs.searching ? "…" : "Search"}
      </button>
    </div>

    {#if showEp}
      <div class="ep">
        <label>Season <input type="number" min="1" bind:value={season} placeholder="1" /></label>
        <label>Episode <input type="number" min="1" bind:value={episode} placeholder="1" /></label>
      </div>
    {/if}

    {#if subs.error}<p class="err">{subs.error}</p>{/if}

    {#if subs.results.length > 0}
      <ul class="results">
        {#each subs.results.slice(0, 15) as r (r.id)}
          <li>
            <button class="result" onclick={() => subs.loadResult(r)}>
              <span class="rtitle">{r.release ?? r.title}</span>
              <span class="rmeta">
                {r.language}{#if r.downloads}
                  · ↓{r.downloads.toLocaleString()}{/if} · {r.provider}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- ── sync + style (only when a track is loaded) ── -->
  {#if subs.activeLabel}
    <div class="group">
      <div class="grp-title">Sync &amp; style</div>

      <div class="ctl">
        <span class="lbl">offset</span>
        <button class="step" onclick={() => subs.nudgeOffset(-50)}>−</button>
        <input
          class="grow"
          type="range"
          min="-10"
          max="10"
          step="0.05"
          value={subs.style.offsetMs / 1000}
          oninput={(e) => subs.patchStyle({ offsetMs: Math.round(+e.currentTarget.value * 1000) })}
        />
        <button class="step" onclick={() => subs.nudgeOffset(50)}>+</button>
        <input
          class="numval"
          type="number"
          step="0.05"
          value={offsetSec}
          oninput={(e) =>
            subs.patchStyle({ offsetMs: Math.round((+e.currentTarget.value || 0) * 1000) })}
        /><span class="unit">s</span>
      </div>

      <div class="ctl">
        <span class="lbl">place</span>
        <button class:on={subs.style.position === "bottom"} onclick={() => subs.patchStyle({ position: "bottom" })}>bottom</button>
        <button class:on={subs.style.position === "top"} onclick={() => subs.patchStyle({ position: "top" })}>top</button>
        <span class="lbl">dist</span>
        <input
          class="grow"
          type="range"
          min="0"
          max="40"
          step="1"
          value={subs.style.marginPct}
          oninput={(e) => subs.patchStyle({ marginPct: +e.currentTarget.value })}
        />
        <span class="val">{subs.style.marginPct}%</span>
      </div>

      <div class="ctl">
        <span class="lbl">size</span>
        <input
          class="grow"
          type="range"
          min="60"
          max="220"
          step="5"
          value={subs.style.sizePct}
          oninput={(e) => subs.patchStyle({ sizePct: +e.currentTarget.value })}
        />
        <span class="val">{subs.style.sizePct}%</span>
        <span class="lbl">colour</span>
        <input type="color" value={subs.style.color} oninput={(e) => subs.patchStyle({ color: e.currentTarget.value })} />
        <span class="lbl">box</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={subs.style.background}
          oninput={(e) => subs.patchStyle({ background: +e.currentTarget.value })}
        />
      </div>
    </div>
  {/if}
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px;
    width: min(440px, 92vw);
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .grp-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grp-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
  }
  .with-ico {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .wide {
    width: 100%;
  }
  .search {
    display: flex;
    gap: 6px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .ep-toggle {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .ep-toggle.on,
  button.on {
    border-color: var(--accent);
    color: var(--accent);
  }
  .ep {
    display: flex;
    gap: 10px;
  }
  .ep label {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .ep input {
    width: 64px;
  }
  .active {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--text);
  }
  .link {
    background: none;
    border: 0;
    color: var(--accent);
    padding: 0;
  }
  .err {
    margin: 0;
    color: var(--bad);
    font-size: 12px;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 180px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .result {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 7px 9px;
  }
  .rtitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .rmeta {
    font-size: 11px;
    color: var(--muted);
  }
  .ctl {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ctl input[type="range"] {
    accent-color: var(--accent);
  }
  .step {
    padding: 4px 10px;
  }
  .lbl {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--muted);
  }
  .val {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    min-width: 44px;
    text-align: right;
  }
  .numval {
    width: 64px;
    font-variant-numeric: tabular-nums;
    text-align: right;
    padding: 5px 6px;
  }
  .unit {
    font-size: 12px;
    color: var(--muted);
  }
</style>
