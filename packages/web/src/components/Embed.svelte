<script lang="ts">
  import type { PageBridge } from "../lib/bridge";

  interface Props {
    src: string | null;
    bridge: PageBridge;
  }
  const { src, bridge }: Props = $props();

  let iframe = $state<HTMLIFrameElement | null>(null);

  // When the embed (re)loads, hand its content window to the bridge so it can
  // postMessage the in-iframe content script. Cross-origin is fine: we only
  // need the window reference for postMessage, never its document.
  function onLoad() {
    bridge.setFrame(iframe?.contentWindow ?? null);
  }
</script>

<div class="stage">
  {#if src}
    <iframe
      bind:this={iframe}
      {src}
      title="shared source"
      onload={onLoad}
      allow="autoplay; fullscreen; encrypted-media"
      referrerpolicy="no-referrer-when-downgrade"
    ></iframe>
  {:else}
    <div class="empty">
      <p>No source yet.</p>
      <p class="muted">Anyone with control can paste a source URL below.</p>
    </div>
  {/if}
</div>

<style>
  .stage {
    position: relative;
    flex: 1;
    background: #000;
    min-height: 0;
  }
  iframe {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
  }
  .empty {
    display: grid;
    place-content: center;
    height: 100%;
    text-align: center;
  }
  .muted {
    color: var(--muted);
  }
</style>
