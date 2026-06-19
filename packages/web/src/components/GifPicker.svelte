<script lang="ts">
  import { Search, Star } from "lucide-svelte";
  import type { GifResult, RoomClient } from "../lib/room.svelte";

  interface Props {
    room: RoomClient;
    /** Broadcast the chosen GIF to the room. */
    onSend: (url: string) => void;
  }
  const { room, onSend }: Props = $props();

  // A favorite remembers the search term it was saved under, so favorites can be
  // filtered by that tag later (not just searched fresh from GIPHY).
  type FavGif = GifResult & { q: string };

  const FAV_KEY = "sixseven:gifFavs";
  function loadFavs(): FavGif[] {
    try {
      return JSON.parse(localStorage.getItem(FAV_KEY) ?? "[]");
    } catch {
      return [];
    }
  }

  let tab = $state<"search" | "favs">("search");
  let query = $state("");
  let favFilter = $state("");
  let results = $state<GifResult[]>([]);
  let favs = $state<FavGif[]>(loadFavs());
  let searching = $state(false);
  let error = $state<string | null>(null);

  function persist() {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(favs.slice(0, 60)));
    } catch {
      /* storage full / disabled — non-fatal */
    }
  }
  const isFav = (url: string) => favs.some((f) => f.url === url);
  function toggleFav(g: GifResult, q: string) {
    favs = isFav(g.url) ? favs.filter((f) => f.url !== g.url) : [{ ...g, q }, ...favs].slice(0, 60);
    persist();
  }

  async function search() {
    const q = query.trim();
    if (!q) return;
    searching = true;
    error = null;
    try {
      const r = await room.gifSearch(q);
      results = r?.results ?? [];
      if (!results.length) error = "No GIFs found.";
    } catch (e) {
      error = (e as Error).message;
    } finally {
      searching = false;
    }
  }

  const shownFavs = $derived.by(() => {
    const f = favFilter.trim().toLowerCase();
    return f ? favs.filter((g) => g.q.toLowerCase().includes(f)) : favs;
  });
</script>

<div class="gif">
  <div class="tabs">
    <button class:on={tab === "search"} onclick={() => (tab = "search")}>Search</button>
    <button class:on={tab === "favs"} onclick={() => (tab = "favs")}>★ Favorites</button>
  </div>

  {#if tab === "search"}
    <div class="row">
      <input bind:value={query} placeholder="Search GIFs…" onkeydown={(e) => e.key === "Enter" && search()} />
      <button class="go" onclick={search} disabled={searching || !query.trim()}><Search size={14} /></button>
    </div>
    {#if error}<p class="err">{error}</p>{/if}
    <div class="grid">
      {#each results as g (g.id)}
        <div class="tile">
          <button class="send" onclick={() => onSend(g.url)} title="Send"><img src={g.preview} alt="gif" loading="lazy" /></button>
          <button class="star" class:on={isFav(g.url)} onclick={() => toggleFav(g, query.trim())} title="Favorite">
            <Star size={12} fill={isFav(g.url) ? "currentColor" : "none"} />
          </button>
        </div>
      {/each}
    </div>
  {:else}
    <div class="row">
      <input bind:value={favFilter} placeholder="Filter favorites…" />
    </div>
    {#if favs.length === 0}
      <p class="hint">No favorites yet — star a GIF from Search.</p>
    {:else if shownFavs.length === 0}
      <p class="hint">No favorites match “{favFilter}”.</p>
    {/if}
    <div class="grid">
      {#each shownFavs as g (g.url)}
        <div class="tile">
          <button class="send" onclick={() => onSend(g.url)} title="Send"><img src={g.preview} alt="gif" loading="lazy" /></button>
          <button class="star on" onclick={() => toggleFav(g, g.q)} title="Unfavorite"><Star size={12} fill="currentColor" /></button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="credit">Powered by GIPHY</div>
</div>

<style>
  .gif {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 300px;
  }
  .tabs {
    display: flex;
    gap: 4px;
  }
  .tabs button {
    flex: 1;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: 6px;
    color: var(--muted);
    font-size: 12px;
    cursor: pointer;
  }
  .tabs button.on {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .row {
    display: flex;
    gap: 6px;
  }
  .row input {
    flex: 1;
    min-width: 0;
  }
  .go {
    display: inline-flex;
    align-items: center;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    max-height: 250px;
    overflow-y: auto;
  }
  .tile {
    position: relative;
    aspect-ratio: 1;
  }
  .send {
    width: 100%;
    height: 100%;
    padding: 0;
    border: none;
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg);
    cursor: pointer;
  }
  .send img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .star {
    position: absolute;
    top: 3px;
    right: 3px;
    display: inline-flex;
    padding: 3px;
    border: none;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    cursor: pointer;
  }
  .star.on {
    color: var(--warn);
  }
  .err,
  .hint {
    margin: 0;
    font-size: 12px;
  }
  .err {
    color: var(--bad);
  }
  .hint {
    color: var(--muted);
  }
  .credit {
    font-size: 10px;
    color: var(--muted);
    text-align: right;
  }
</style>
