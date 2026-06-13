<script lang="ts">
  interface FloatingReaction {
    id: number;
    x: number;
    emoji?: string;
    gif?: string;
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
    {#if r.gif}
      <img class="r gif" style:left="{r.x}%" src={r.gif} alt="gif" />
    {:else}
      <span class="r" style:left="{r.x}%">{r.emoji}</span>
    {/if}
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
  .r.gif {
    max-width: 160px;
    max-height: 160px;
    border-radius: 10px;
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.5);
    animation: gif-float 6s ease-out forwards;
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
  @keyframes gif-float {
    0% {
      transform: translateY(20px) scale(0.85);
      opacity: 0;
    }
    8% {
      transform: translateY(0) scale(1);
      opacity: 1;
    }
    85% {
      transform: translateY(-40px);
      opacity: 1;
    }
    100% {
      transform: translateY(-70px);
      opacity: 0;
    }
  }
</style>
