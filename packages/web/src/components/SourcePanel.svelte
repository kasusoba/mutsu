<script lang="ts">
  import type { SourceKind } from "@sixseven/protocol";
  import type { RoomClient } from "../lib/room.svelte";
  import { classifySource, extractSourceUrl } from "../lib/source";

  interface Props {
    room: RoomClient;
  }
  const { room }: Props = $props();

  let srcInput = $state("");
  let srcError = $state<string | null>(null);
  let srcMode = $state<"auto" | "embed" | "direct">("auto");
  let copied = $state(false);

  const currentSrc = $derived(room.sync?.src ?? null);
  const currentKind = $derived(room.sync?.srcKind ?? "embed");

  const KIND_LABEL: Record<string, string> = {
    embed: "Embedded page",
    direct: "Direct video / HLS",
    youtube: "YouTube",
    site: "Own-tab site",
  };
  // Live feedback: what the pasted URL will load as (before committing).
  const detected = $derived.by(() => {
    const raw = srcInput.trim();
    if (!raw) return null;
    const { url } = extractSourceUrl(raw);
    return url ? classifySource(url) : null;
  });
  const effectiveKind = $derived(srcMode === "auto" ? detected : srcMode);

  function resolve(): { url: string; kind: SourceKind } | null {
    const { url, error } = extractSourceUrl(srcInput);
    if (error || !url) {
      srcError = error ?? "Invalid source.";
      return null;
    }
    srcError = null;
    return { url, kind: srcMode === "auto" ? classifySource(url) : srcMode };
  }
  function setSource() {
    const r = resolve();
    if (!r) return;
    room.setSource(r.url, r.kind);
    srcInput = "";
  }
  function addToQueue() {
    const r = resolve();
    if (!r) return;
    room.queueAdd(r.url, r.kind);
    srcInput = "";
  }
  function host(u: string): string {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  }

  // Drag-to-reorder the queue.
  let dragId = $state<string | null>(null);
  let dragOverId = $state<string | null>(null);
  function onDrop(toIndex: number) {
    if (dragId) room.queueReorder(dragId, toIndex);
    dragId = null;
    dragOverId = null;
  }
  async function copySrc() {
    if (!currentSrc) return;
    try {
      await navigator.clipboard.writeText(currentSrc);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      srcInput = currentSrc;
    }
  }
  function reloadSrc() {
    if (currentSrc) room.setSource(currentSrc, room.sync?.srcKind);
  }
</script>

<div class="panel">
  <label class="field">
    <span class="lbl">Paste a YouTube link, an embed page, or a video / HLS URL</span>
    <input
      bind:value={srcInput}
      placeholder="https://… (YouTube, embed page, or .m3u8 / .mp4)"
      disabled={!room.canControl}
      onkeydown={(e) => e.key === "Enter" && setSource()}
    />
  </label>

  <div class="row">
    <select bind:value={srcMode} disabled={!room.canControl} title="How to load it">
      <option value="auto">Auto-detect</option>
      <option value="embed">Embed page</option>
      <option value="direct">Direct / HLS</option>
    </select>
    <button class="primary" onclick={setSource} disabled={!room.canControl || !srcInput.trim()}>
      Set source
    </button>
    <button onclick={addToQueue} disabled={!room.canControl || !srcInput.trim()} title="Add to the queue">
      + Queue
    </button>
  </div>
  {#if effectiveKind}
    <p class="detect">Will load as <strong>{KIND_LABEL[effectiveKind]}</strong></p>
  {/if}
  {#if srcError}<p class="err">{srcError}</p>{/if}

  {#if room.playlist.length}
    <div class="queue">
      <div class="q-head">
        <span class="lbl">Up next · {room.playlist.length}</span>
        <label class="auto"><input type="checkbox" checked={room.autoplay} disabled={!room.canControl} onchange={(e) => room.setAutoplay(e.currentTarget.checked)} /> autoplay</label>
        <button class="link" onclick={() => room.queueClear()} disabled={!room.canControl}>clear</button>
      </div>
      <ul>
        {#each room.playlist as it, i (it.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <li
            class:playing={it.id === room.playlistCurrentId}
            class:dragover={dragOverId === it.id}
            draggable={room.canControl}
            ondragstart={() => (dragId = it.id)}
            ondragend={() => { dragId = null; dragOverId = null; }}
            ondragover={(e) => { e.preventDefault(); if (dragId) dragOverId = it.id; }}
            ondrop={(e) => { e.preventDefault(); onDrop(i); }}
          >
            {#if room.canControl}<span class="q-grip" title="Drag to reorder">⠿</span>{/if}
            <button class="q-play" onclick={() => room.playItem(it.id)} disabled={!room.canControl} title="Play now">▶</button>
            <span class="q-title" title={it.src}>{it.title ?? host(it.src)}</span>
            <span class="q-kind">{KIND_LABEL[it.kind] ?? it.kind}</span>
            <button class="q-x" onclick={() => room.queueRemove(it.id)} disabled={!room.canControl} aria-label="Remove">✕</button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if currentSrc}
    <div class="current">
      <span class="lbl">Now playing · {KIND_LABEL[currentKind] ?? currentKind}</span>
      <input class="url" value={currentSrc} readonly title={currentSrc} />
      <div class="row">
        <button onclick={copySrc} title="Copy the current source URL">
          {copied ? "Copied ✓" : "Copy link"}
        </button>
        <button onclick={reloadSrc} disabled={!room.canControl} title="Re-load for everyone">
          Reload
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(420px, 90vw);
    padding: 14px;
  }
  .field,
  .current {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .lbl {
    font-size: 12px;
    color: var(--muted);
  }
  .row {
    display: flex;
    gap: 8px;
  }
  input {
    width: 100%;
  }
  select {
    flex: none;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 7px 10px;
  }
  .primary {
    flex: 1;
    background: var(--accent);
    border-color: transparent;
    color: #fff;
    font-weight: 600;
  }
  .current {
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .url {
    font-size: 12px;
    color: var(--muted);
  }
  .detect {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
  }
  .detect strong {
    color: var(--text);
  }
  .err {
    margin: 0;
    color: var(--bad);
    font-size: 12px;
  }
  .queue {
    border-top: 1px solid var(--line);
    padding-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .q-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .link {
    background: none;
    border: 0;
    color: var(--accent);
    padding: 0;
    font-size: 12px;
  }
  .queue ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 200px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .queue li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px;
    border-radius: 8px;
    font-size: 12px;
  }
  .queue li.playing {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .q-play,
  .q-x {
    flex: none;
    padding: 2px 5px;
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
  }
  .q-play:hover:not(:disabled),
  .q-x:hover:not(:disabled) {
    color: var(--text);
  }
  .q-grip {
    flex: none;
    color: var(--muted);
    cursor: grab;
    user-select: none;
    font-size: 13px;
  }
  .queue li[draggable="true"] {
    cursor: grab;
  }
  .queue li.dragover {
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .auto {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    font-size: 11px;
    color: var(--muted);
  }
  .q-head .link {
    margin-left: 8px;
  }
  .q-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .q-kind {
    flex: none;
    font-size: 10px;
    color: var(--muted);
  }
</style>
