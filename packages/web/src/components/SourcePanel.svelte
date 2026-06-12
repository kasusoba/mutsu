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

  function setSource() {
    const { url, error } = extractSourceUrl(srcInput);
    if (error || !url) {
      srcError = error ?? "Invalid source.";
      return;
    }
    srcError = null;
    const kind: SourceKind = srcMode === "auto" ? classifySource(url) : srcMode;
    room.setSource(url, kind);
    srcInput = "";
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
    <span class="lbl">Paste an embed page, or an HLS / .mp4 URL</span>
    <input
      bind:value={srcInput}
      placeholder="https://…"
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
  </div>
  {#if srcError}<p class="err">{srcError}</p>{/if}

  {#if currentSrc}
    <div class="current">
      <span class="lbl">Now playing · {currentKind}</span>
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
  .err {
    margin: 0;
    color: var(--bad);
    font-size: 12px;
  }
</style>
