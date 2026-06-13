<script lang="ts">
  interface FloatingReaction {
    id: number;
    emoji: string;
    x: number;
  }
  interface Props {
    /** Active floating reactions (managed by the parent; removed on timeout). */
    reactions: FloatingReaction[];
  }
  const { reactions }: Props = $props();
</script>

<!-- Float-up layer only: reactions drift up over the video and fade. The launcher
     lives in the top bar so nothing persistent overlays the video. -->
<div class="float">
  {#each reactions as r (r.id)}
    <span class="r" style:left="{r.x}%">{r.emoji}</span>
  {/each}
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
</style>
