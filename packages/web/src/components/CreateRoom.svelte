<script lang="ts">
  import type { Mode } from "@mutsu/protocol";
  import { Crown, Users } from "lucide-svelte";
  import { untrack } from "svelte";
  import { makeRoomName, slugifyRoom } from "../lib/session";
  import ExtensionNotice from "./ExtensionNotice.svelte";

  interface Props {
    initialNick: string;
    onCreate: (name: string, nick: string, mode: Mode) => void;
  }
  const { initialNick, onCreate }: Props = $props();

  // Seed once; later prop changes shouldn't clobber what the user is typing.
  let name = $state(makeRoomName());
  let nick = $state(untrack(() => initialNick));
  let mode = $state<Mode>("open");

  const slug = $derived(slugifyRoom(name));
  const ready = $derived(slug.length > 0 && nick.trim().length > 0);

  function submit(e: Event) {
    e.preventDefault();
    if (ready) onCreate(slug, nick.trim(), mode);
  }
</script>

<div class="wrap">
  <form onsubmit={submit}>
    <h1>mutsu</h1>
    <p class="tag">Start a watch party. Everyone plays their own copy — we just keep it in sync.</p>
    <ol class="how">
      <li>Create a room</li>
      <li>Share the link with friends</li>
      <li>Pick something to watch — embed, direct video, or YouTube</li>
    </ol>

    <label for="nick">Your nickname</label>
    <input id="nick" bind:value={nick} placeholder="e.g. alice" autocomplete="off" />

    <label for="room">Room name</label>
    <div class="room-field">
      <span class="prefix">/r/</span>
      <input id="room" bind:value={name} placeholder="cosy-sofa-42" autocomplete="off" />
    </div>

    <span class="label">Who can control playback?</span>
    <div class="modes">
      <button
        type="button"
        class="mode"
        class:on={mode === "open"}
        onclick={() => (mode = "open")}
      >
        <Users size={18} />
        <span class="m-title">Anyone</span>
        <span class="m-sub">Everyone can play, pause and seek.</span>
      </button>
      <button
        type="button"
        class="mode"
        class:on={mode === "host"}
        onclick={() => (mode = "host")}
      >
        <Crown size={18} />
        <span class="m-title">Host only</span>
        <span class="m-sub">You control playback; hand off anytime.</span>
      </button>
    </div>

    <button type="submit" class="create" disabled={!ready}>Create room</button>
    <p class="hint">A private link with a secret key is generated — share it to invite people.</p>
    <ExtensionNotice />
  </form>
</div>

<style>
  .wrap {
    display: grid;
    place-items: center;
    height: 100%;
    padding: 24px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 380px;
    max-width: 100%;
    padding: 30px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 16px;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    letter-spacing: 0.5px;
  }
  .tag {
    margin: 0 0 8px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .how {
    margin: 0 0 10px;
    padding-left: 20px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
  }
  label,
  .label {
    color: var(--muted);
    font-size: 12px;
    margin-top: 6px;
  }
  .room-field {
    display: flex;
    align-items: center;
    gap: 0;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
  }
  .room-field .prefix {
    padding: 0 4px 0 10px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .room-field input {
    border: none;
    background: none;
    flex: 1;
    min-width: 0;
  }
  .modes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 2px;
  }
  .mode {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 12px;
    text-align: left;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--muted);
  }
  .mode.on {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, var(--bg));
    color: var(--text);
  }
  .m-title {
    font-weight: 600;
    font-size: 14px;
    color: var(--text);
  }
  .m-sub {
    font-size: 11px;
    line-height: 1.4;
  }
  .create {
    margin-top: 12px;
    background: var(--accent);
    border-color: var(--accent);
    padding: 10px;
    font-weight: 600;
  }
  .hint {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }
</style>
