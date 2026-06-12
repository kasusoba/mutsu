<script lang="ts">
  import type { LogEvent } from "@sixseven/protocol";
  import type { RoomClient } from "../lib/room.svelte";

  interface Props {
    room: RoomClient;
  }
  const { room }: Props = $props();

  function nameOf(id: string | undefined): string {
    if (!id) return "someone";
    return room.members.find((m) => m.id === id)?.name ?? "someone";
  }

  function describe(e: LogEvent): string {
    switch (e.kind) {
      case "joined":
        return `${e.detail ?? nameOf(e.actor)} joined`;
      case "left":
        return `${e.detail ?? nameOf(e.actor)} left`;
      case "setSource":
        return `${nameOf(e.actor)} changed the source`;
      case "played":
        return `${nameOf(e.actor)} pressed play`;
      case "paused":
        return `${nameOf(e.actor)} pressed pause`;
      case "skipped":
        return `${nameOf(e.actor)} skipped ${nameOf(e.target)}`;
      case "autoSkipped":
        return `${nameOf(e.target)} was auto-skipped (stalled 25s)`;
      case "tookControl":
        return `${nameOf(e.actor)} took control`;
      case "passedControl":
        return `${nameOf(e.actor)} gave host to ${nameOf(e.target)}`;
      case "modeChanged":
        return `mode → ${e.detail}`;
      case "hostPromoted":
        return `${nameOf(e.target)} promoted to host`;
      default:
        return e.kind;
    }
  }
</script>

<section>
  <h2>Activity</h2>
  <ul>
    {#each room.log.slice(-40).reverse() as e (e.id)}
      <li>{describe(e)}</li>
    {/each}
    {#if room.log.length === 0}
      <li class="muted">No activity yet.</li>
    {/if}
  </ul>
</section>

<style>
  section {
    padding: 12px;
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  li {
    font-size: 12px;
    color: var(--text);
  }
  .muted {
    color: var(--muted);
  }
</style>
