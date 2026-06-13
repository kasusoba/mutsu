<script lang="ts">
  import { SmilePlus } from "lucide-svelte";

  interface FloatingReaction {
    id: number;
    emoji: string;
    x: number;
  }
  interface Props {
    /** Active floating reactions (managed by the parent; removed on timeout). */
    reactions: FloatingReaction[];
    /** Send a reaction to the room. */
    onReact: (emoji: string) => void;
  }
  const { reactions, onReact }: Props = $props();

  const EMOJIS = ["😂", "❤️", "🔥", "👍", "😮", "😢", "🎉"];
  let open = $state(false);

  function react(e: string) {
    onReact(e);
  }
</script>

<!-- Float-up layer: reactions drift up over the video and fade. -->
<div class="float">
  {#each reactions as r (r.id)}
    <span class="r" style:left="{r.x}%">{r.emoji}</span>
  {/each}
</div>

<!-- Launcher -->
<div class="launcher">
  {#if open}
    <div class="strip">
      {#each EMOJIS as e (e)}
        <button class="emoji" onclick={() => react(e)}>{e}</button>
      {/each}
    </div>
  {/if}
  <button class="toggle" class:on={open} onclick={() => (open = !open)} title="React" aria-label="React">
    <SmilePlus size={18} />
  </button>
</div>

<style>
  .float {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 15;
  }
  .r {
    position: absolute;
    bottom: 8%;
    font-size: 34px;
    animation: float-up 2.2s ease-out forwards;
    will-change: transform, opacity;
  }
  @keyframes float-up {
    0% {
      transform: translateY(0) scale(0.6);
      opacity: 0;
    }
    15% {
      transform: translateY(-10px) scale(1.1);
      opacity: 1;
    }
    100% {
      transform: translateY(-220px) scale(1);
      opacity: 0;
    }
  }
  .launcher {
    position: absolute;
    right: 14px;
    bottom: 78px;
    z-index: 24;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .strip {
    display: flex;
    gap: 2px;
    padding: 4px 6px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 999px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  }
  .emoji {
    background: none;
    border: none;
    border-radius: 999px;
    padding: 4px 6px;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
  }
  .emoji:hover {
    background: var(--panel-2);
    transform: scale(1.15);
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--panel);
    border: 1px solid var(--line);
    color: var(--text);
    cursor: pointer;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  }
  .toggle.on,
  .toggle:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
