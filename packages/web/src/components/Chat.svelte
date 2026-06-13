<script lang="ts">
  import type { RoomClient } from "../lib/room.svelte";

  export interface ChatLine {
    id: number;
    name: string;
    text: string;
    self: boolean;
  }
  interface Props {
    room: RoomClient;
    messages: ChatLine[];
  }
  const { room, messages }: Props = $props();

  let draft = $state("");
  let list = $state<HTMLUListElement | null>(null);

  function send(e: Event) {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    room.say("chat", t);
    draft = "";
  }

  // Auto-scroll to the newest message.
  $effect(() => {
    void messages.length;
    if (list) list.scrollTop = list.scrollHeight;
  });
</script>

<section class="chat">
  <ul bind:this={list}>
    {#each messages as m (m.id)}
      <li class:me={m.self}>
        <span class="cn">{m.name}</span>
        <span class="ct">{m.text}</span>
      </li>
    {/each}
    {#if messages.length === 0}
      <li class="empty">No messages yet — say hi 👋</li>
    {/if}
  </ul>
  <form onsubmit={send}>
    <input bind:value={draft} placeholder="Message…" maxlength="500" autocomplete="off" />
    <button type="submit" disabled={!draft.trim()}>Send</button>
  </form>
</section>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 10px 12px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  li {
    font-size: 13px;
    line-height: 1.4;
    word-break: break-word;
  }
  .cn {
    font-weight: 600;
    color: var(--accent);
  }
  li.me .cn {
    color: var(--good);
  }
  .ct {
    color: var(--text);
  }
  .empty {
    color: var(--muted);
  }
  form {
    display: flex;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--line);
  }
  input {
    flex: 1;
    min-width: 0;
  }
  button {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 600;
  }
</style>
