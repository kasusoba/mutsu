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

  const playing = $derived(state === "open" && (status === "ready" || status === "stalled"));

  // What the panel says, derived from the tab lifecycle + the player's status.
  const line = $derived(
    state === "open"
      ? status === "failed"
        ? "No video found in that tab — make sure it's playing, then it'll sync."
        : status === "loading"
          ? "Connecting to the tab…"
          : "Playing in your own tab — kept in sync with the room here."
      : state === "closed"
        ? "That tab closed. Reopen it to keep watching together."
        : "This site can't play inside the room, so the video opens in its own tab.",
  );

  // A plain connection chip so "did it work?" is never a question.
  type Chip = { text: string; cls: "ok" | "wait" | "bad" };
  const chip = $derived<Chip>(
    state === "open"
      ? playing
        ? { text: "Site tab connected", cls: "ok" }
        : status === "failed"
          ? { text: "No video in the tab", cls: "bad" }
          : { text: "Connecting…", cls: "wait" }
      : state === "closed"
        ? { text: "Site tab closed", cls: "bad" }
        : { text: "Site tab not open yet", cls: "wait" },
  );
</script>

<div class="sat" class:live={playing}>
  <div class="badge"><MonitorPlay size={40} /></div>
  <p class="host">{host(src)}</p>
  <p class="chip {chip.cls}"><span class="led"></span>{chip.text}</p>
  <p class="line">{line}</p>
  {#if state !== "open"}
    <button class="open" onclick={onOpen}>
      <ExternalLink size={16} /> Open {host(src)} to watch
    </button>
    <p class="hint">
      You'll have two tabs: <strong>this room</strong> for chat, members &amp; sync — and the
      <strong>site tab</strong> for the actual video.
    </p>
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
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    background: #ffffff14;
    color: #cfcfd6;
  }
  .chip .led {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: #9a9aa6;
  }
  .chip.ok {
    color: #7ee787;
  }
  .chip.ok .led {
    background: #7ee787;
  }
  .chip.wait .led {
    background: #f5a623;
  }
  .chip.bad {
    color: #ff8b95;
  }
  .chip.bad .led {
    background: #ff5d6c;
  }
  .hint {
    color: var(--muted, #9a9aa6);
    max-width: 26rem;
    font-size: 0.85rem;
    line-height: 1.5;
  }
  .hint strong {
    color: #cfcfd6;
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
