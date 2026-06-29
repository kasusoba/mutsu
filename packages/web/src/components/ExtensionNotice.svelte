<script lang="ts">
  // Shows whether the mutsu extension is present + up to date (the content script
  // tags <html data-sixseven-ext> with its version). Used on the create/join
  // screens — embedded sites + own-tab parties need it; direct & YouTube don't.
  import { type ExtState, extState } from "../lib/extVersion";
  import { EXTENSION_URL } from "../lib/links";

  // null = still checking (give the content script a moment so we don't flash
  // "not detected" then correct ourselves).
  let state = $state<ExtState | null>(null);
  $effect(() => {
    const id = setTimeout(() => {
      state = extState();
    }, 1200);
    return () => clearTimeout(id);
  });
</script>

{#if state === "ok" || state === "legacy"}
  <p class="ext ok">✓ mutsu extension ready</p>
{:else if state === "outdated"}
  <p class="ext warn">
    Your mutsu extension is out of date.
    <a href={EXTENSION_URL} target="_blank" rel="noreferrer">Update it</a> for the latest fixes.
  </p>
{:else if state === "missing"}
  <p class="ext warn">
    No mutsu extension detected — it's needed to sync embedded sites and own-tab
    parties. <a href={EXTENSION_URL} target="_blank" rel="noreferrer">Get it</a>. Direct video
    &amp; YouTube links work without it.
  </p>
{/if}

<style>
  .ext {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    border-radius: 8px;
    padding: 8px 10px;
  }
  .ext.ok {
    color: var(--good);
    background: color-mix(in srgb, var(--good) 12%, transparent);
  }
  .ext.warn {
    color: var(--text);
    background: color-mix(in srgb, var(--warn) 16%, transparent);
  }
  .ext a {
    color: var(--accent);
    font-weight: 600;
  }
</style>
