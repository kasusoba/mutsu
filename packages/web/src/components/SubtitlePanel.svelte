<script lang="ts">
  import { Search, Upload } from "lucide-svelte";
  import type { SubtitleController } from "../lib/subtitleController.svelte";

  interface Props {
    subs: SubtitleController;
  }
  const { subs }: Props = $props();

  let query = $state("");
  let fileInput = $state<HTMLInputElement | null>(null);

  async function onFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) await subs.loadFile(file);
  }

  const offsetSec = $derived((subs.style.offsetMs / 1000).toFixed(2));
</script>

<section>
  <!-- source row -->
  <div class="row">
    <span class="lbl">subs</span>
    <button class="with-ico" onclick={() => fileInput?.click()}><Upload size={14} /> upload</button>
    <input bind:this={fileInput} type="file" accept=".srt,.vtt" onchange={onFile} hidden />
    <input
      class="search"
      bind:value={query}
      placeholder="search online (movie/show name)…"
      onkeydown={(e) => e.key === "Enter" && subs.search(query)}
    />
    <button class="with-ico" onclick={() => subs.search(query)} disabled={subs.searching || !query.trim()}>
      <Search size={14} /> {subs.searching ? "…" : "search"}
    </button>
    {#if subs.activeLabel}
      <span class="active" title={subs.activeLabel}>{subs.activeLabel}</span>
      <button class="link" onclick={() => subs.clear()}>clear</button>
    {/if}
  </div>

  {#if subs.error}<p class="err">{subs.error}</p>{/if}

  {#if subs.results.length > 0}
    <ul class="results">
      {#each subs.results.slice(0, 12) as r (r.id)}
        <li>
          <button class="result" onclick={() => subs.loadResult(r)}>
            <span class="rtitle">{r.release ?? r.title}</span>
            <span class="rmeta">{r.provider} · {r.language}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if subs.activeLabel}
    <!-- personal sync + style -->
    <div class="row style">
      <span class="lbl">offset</span>
      <button onclick={() => subs.nudgeOffset(-50)}>−</button>
      <input
        class="grow"
        type="range"
        min="-10"
        max="10"
        step="0.05"
        value={subs.style.offsetMs / 1000}
        oninput={(e) => subs.patchStyle({ offsetMs: Math.round(+e.currentTarget.value * 1000) })}
      />
      <button onclick={() => subs.nudgeOffset(50)}>+</button>
      <span class="val">{offsetSec}s</span>
    </div>

    <div class="row style">
      <span class="lbl">place</span>
      <button
        class:on={subs.style.position === "bottom"}
        onclick={() => subs.patchStyle({ position: "bottom" })}>bottom</button
      >
      <button
        class:on={subs.style.position === "top"}
        onclick={() => subs.patchStyle({ position: "top" })}>top</button
      >
      <span class="lbl">dist</span>
      <input
        type="range"
        min="0"
        max="40"
        step="1"
        value={subs.style.marginPct}
        oninput={(e) => subs.patchStyle({ marginPct: +e.currentTarget.value })}
      />
      <span class="val">{subs.style.marginPct}%</span>
    </div>

    <div class="row style">
      <span class="lbl">size</span>
      <input
        type="range"
        min="60"
        max="220"
        step="5"
        value={subs.style.sizePct}
        oninput={(e) => subs.patchStyle({ sizePct: +e.currentTarget.value })}
      />
      <span class="val">{subs.style.sizePct}%</span>
      <span class="lbl">color</span>
      <input
        type="color"
        value={subs.style.color}
        oninput={(e) => subs.patchStyle({ color: e.currentTarget.value })}
      />
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
  {/if}
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 12px 10px;
    background: var(--panel);
    border-top: 1px solid var(--line);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .lbl {
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .with-ico {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .search {
    flex: 1;
    min-width: 120px;
  }
  .style input[type="range"] {
    width: 120px;
    accent-color: var(--accent);
  }
  .style input.grow {
    flex: 1;
  }
  .val {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    min-width: 42px;
  }
  .active {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--muted);
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
    max-height: 160px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .result {
    width: 100%;
    text-align: left;
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 8px;
  }
  .rtitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  .rmeta {
    font-size: 10px;
    color: var(--muted);
    flex: none;
  }
  button.on {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
