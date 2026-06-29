<script lang="ts">
  import { Crown } from "lucide-svelte";
  import type { MemberStatus } from "@mutsu/protocol";
  import type { RoomClient } from "../lib/room.svelte";

  interface Props {
    room: RoomClient;
    onInvite: () => void;
  }
  const { room, onInvite }: Props = $props();

  const statusLabel: Record<MemberStatus, string> = {
    loading: "loading",
    ready: "watching",
    stalled: "buffering",
    failed: "failed",
  };

  function canSkip(status: MemberStatus): boolean {
    return room.canControl && (status === "stalled" || status === "failed");
  }
</script>

<section>
  <h2>Members <span class="count">{room.members.length}</span></h2>
  <ul>
    {#each room.members as m (m.id)}
      <li>
        <span class="dot {m.status}"></span>
        <span class="name">
          {m.name}{#if m.id === room.self}<span class="you"> (you)</span>{/if}
          {#if room.sync?.hostId === m.id}<span class="host" title="host"><Crown size={13} fill="currentColor" /></span>{/if}
        </span>
        <span class="status {m.status}">{statusLabel[m.status]}</span>
        {#if canSkip(m.status)}
          <button class="skip" onclick={() => room.skip(m.id)}>skip</button>
        {/if}
        {#if room.sync?.mode === "host" && room.sync?.hostId === room.self && m.id !== room.self}
          <button class="skip" onclick={() => room.passControl(m.id)}>give host</button>
        {/if}
      </li>
    {/each}
  </ul>

  {#if room.members.length <= 1}
    <div class="solo">
      <p>It's just you here.</p>
      <button class="invite" onclick={onInvite}>Copy invite link</button>
    </div>
  {/if}
</section>

<style>
  section {
    padding: 12px;
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 0 0 8px;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--muted);
  }
  .count {
    color: var(--text);
  }
  .solo {
    margin-top: 10px;
    padding: 10px;
    border: 1px dashed var(--line);
    border-radius: 10px;
    text-align: center;
  }
  .solo p {
    margin: 0 0 8px;
    color: var(--muted);
    font-size: 12px;
  }
  .invite {
    width: 100%;
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .you {
    color: var(--muted);
  }
  .host {
    color: var(--accent);
    display: inline-flex;
    vertical-align: middle;
    line-height: 0;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
    flex: none;
  }
  .dot.ready {
    background: var(--good);
  }
  .dot.stalled {
    background: var(--warn);
  }
  .dot.failed {
    background: var(--bad);
  }
  .status {
    font-size: 11px;
    color: var(--muted);
  }
  .status.failed {
    color: var(--bad);
  }
  .skip {
    padding: 2px 8px;
    font-size: 11px;
  }
</style>
