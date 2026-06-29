<script lang="ts">
  import { untrack } from "svelte";
  import ExtensionNotice from "./ExtensionNotice.svelte";

  interface Props {
    room: string;
    initialNick: string;
    onJoin: (nick: string) => void;
  }
  const { room, initialNick, onJoin }: Props = $props();

  // Seed the field once from the prop; later prop changes shouldn't clobber typing.
  let nick = $state(untrack(() => initialNick));

  function submit(e: Event) {
    e.preventDefault();
    const v = nick.trim();
    if (v) onJoin(v);
  }
</script>

<div class="join">
  <form onsubmit={submit}>
    <h1>mutsu</h1>
    <p class="sub">Joining room <strong>{room || "(none)"}</strong></p>
    <label for="nick">Your nickname</label>
    <input id="nick" bind:value={nick} placeholder="e.g. alice" autocomplete="off" />
    <button type="submit" disabled={!nick.trim()}>Join the room</button>
    <ExtensionNotice />
  </form>
</div>

<style>
  .join {
    display: grid;
    place-items: center;
    height: 100%;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 320px;
    padding: 28px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
  }
  h1 {
    margin: 0;
    font-size: 26px;
    letter-spacing: 0.5px;
  }
  .sub {
    margin: 0 0 8px;
    color: var(--muted);
  }
  label {
    color: var(--muted);
    font-size: 12px;
  }
  button {
    background: var(--accent);
    border-color: var(--accent);
    margin-top: 4px;
  }
</style>
