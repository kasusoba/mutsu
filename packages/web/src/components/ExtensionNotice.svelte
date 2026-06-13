<script lang="ts">
  // Shows whether the sixseven extension is present (the content script tags
  // <html data-sixseven-ext>). Used on the create/join screens so people know
  // up front — embedded sites + own-tab parties need it; direct & YouTube don't.
  import { EXTENSION_URL } from "../lib/links";

  // null = still checking (give the content script a moment so we don't flash
  // "not detected" then correct ourselves).
  let installed = $state<boolean | null>(null);
  $effect(() => {
    const id = setTimeout(() => {
      installed = document.documentElement.getAttribute("data-sixseven-ext") === "1";
    }, 1200);
    return () => clearTimeout(id);
  });
</script>

{#if installed === true}
  <p class="ext ok">✓ sixseven extension ready</p>
{:else if installed === false}
  <p class="ext warn">
    No sixseven extension detected — it's needed to sync embedded sites and own-tab
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
