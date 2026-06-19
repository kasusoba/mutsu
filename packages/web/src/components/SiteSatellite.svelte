<script lang="ts">
  import type { MemberStatus } from "@sixseven/protocol";
  import { ExternalLink, MonitorPlay } from "lucide-svelte";

  interface Props {
    /** The frame-forbidding source URL (plays in its own tab). */
    src: string | null;
    /** Satellite tab lifecycle: not opened yet / driving / went away. */
    state: "none" | "open" | "closed";
    /** Player status reported up from the satellite once it's driving. */
    status: MemberStatus;
    /** User gesture — open/pair the satellite tab. */
    onOpen: () => void;
  }
  const { src, state, status, onOpen }: Props = $props();

  function host(u: string | null): string {
    if (!u) return "the source";
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  }

  // What the panel says, derived from the tab lifecycle + the player's status.
  const line = $derived(
    state === "open"
      ? status === "failed"
        ? "No video found in that tab — make sure it's playing, then it'll sync."
        : status === "loading"
          ? "Connecting to the tab…"
          : "Playing in your own tab — kept in sync here."
      : state === "closed"
        ? "That tab closed. Reopen it to keep watching together."
        : "This source can't be embedded, so it plays in its own tab — open it to join.",
  );
  const playing = $derived(state === "open" && (status === "ready" || status === "stalled"));
</script>

<div class="sat" class:live={playing}>
  <div class="badge"><MonitorPlay size={40} /></div>
  <p class="host">{host(src)}</p>
  <p class="line">{line}</p>
  {#if state !== "open"}
    <button class="open" onclick={onOpen}>
      <ExternalLink size={16} /> Open {host(src)} to watch
    </button>
  {:else}
    <button class="reopen" onclick={onOpen}>
      <ExternalLink size={14} /> Reopen tab
    </button>
  {/if}
</div>

<style>
  .sat {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 0.7rem;
    text-align: center;
    padding: 2rem;
    background: radial-gradient(circle at 50% 35%, #1b1b22, #000);
    color: #fff;
  }
  .badge {
    color: var(--muted, #9a9aa6);
  }
  .sat.live .badge {
    color: #7ee787;
  }
  .host {
    font-size: 1.1rem;
    font-weight: 600;
    word-break: break-all;
  }
  .line {
    color: var(--muted, #9a9aa6);
    max-width: 30rem;
  }
  .open,
  .reopen {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    border: 0;
    border-radius: 0.5rem;
    cursor: pointer;
    font: inherit;
  }
  .open {
    padding: 0.6rem 1rem;
    background: var(--accent, #6d6dff);
    color: #fff;
    font-weight: 600;
  }
  .reopen {
    padding: 0.35rem 0.7rem;
    background: #ffffff1a;
    color: var(--muted, #cfcfd6);
    font-size: 0.85rem;
  }
</style>
