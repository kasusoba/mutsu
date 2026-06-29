<script lang="ts">
  import type { LogEvent } from "@mutsu/protocol";
  import type { RoomClient } from "../lib/room.svelte";

  interface Props {
    room: RoomClient;
  }
  const { room }: Props = $props();

  function nameOf(id: string | undefined): string {
    if (!id) return "someone";
    return room.members.find((m) => m.id === id)?.name ?? "someone";
  }

  /** Local HH:MM for a log event's timestamp. */
  function fmtTime(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  /** Short, human label for a source URL for the activity log: host + a trimmed
   *  path so two titles on the same site (e.g. netflix.com/81…) read differently. */
  function sourceLabel(url: string | undefined): string {
    if (!url) return "a new source";
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/\/$/, "");
      const label = `${u.host}${path}`;
      return label.length > 48 ? `${label.slice(0, 47)}…` : label;
    } catch {
      return url.slice(0, 40);
    }
  }

  function describe(e: LogEvent): string {
    switch (e.kind) {
      case "joined":
        return `${e.detail ?? nameOf(e.actor)} joined`;
      case "left":
        return `${e.detail ?? nameOf(e.actor)} left`;
      case "setSource":
        return `${nameOf(e.actor)} set the source → ${sourceLabel(e.detail)}`;
      case "played":
        return `${nameOf(e.actor)} pressed play`;
      case "paused":
        return `${nameOf(e.actor)} pressed pause`;
      case "seeked":
        return `${nameOf(e.actor)} seeked to ${e.detail ?? "?"}`;
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
      <li>
        <time datetime={new Date(e.at).toISOString()}>{fmtTime(e.at)}</time>
        <span>{describe(e)}</span>
      </li>
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
    display: flex;
    gap: 8px;
    font-size: 12px;
    color: var(--text);
  }
  time {
    flex: none;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    padding-top: 1px;
  }
  .muted {
    color: var(--muted);
  }
</style>
