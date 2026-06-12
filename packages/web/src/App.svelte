<script lang="ts">
  import type { MemberStatus } from "@sixseven/protocol";
  import ActivityLog from "./components/ActivityLog.svelte";
  import Controls from "./components/Controls.svelte";
  import Embed from "./components/Embed.svelte";
  import Join from "./components/Join.svelte";
  import Members from "./components/Members.svelte";
  import SubtitlePanel from "./components/SubtitlePanel.svelte";
  import { PageBridge } from "./lib/bridge";
  import { RoomClient } from "./lib/room.svelte";
  import { loadNickname, readRoomLocation, saveNickname } from "./lib/session";
  import { SubtitleController } from "./lib/subtitleController.svelte";

  const loc = readRoomLocation();
  let nickname = $state(loadNickname());
  let room = $state<RoomClient | null>(null);
  let bridge = $state<PageBridge | null>(null);
  let subs = $state<SubtitleController | null>(null);
  // Live playback position reported by the active frame (drives the scrubber).
  // `at` is a performance.now() stamp so the bar can interpolate between reports.
  let pos = $state({ t: 0, dur: 0, at: 0 });
  // Extension presence: the content script tags <html> on our page if installed.
  let extMissing = $state(false);

  // De-dupe status reports to the server (the bridge reports every second).
  let lastStatus: MemberStatus | null = null;
  // The page owns the failed-timeout: a content-script frame only reports once it
  // has a <video>, so if none appears within the grace we mark this member failed.
  let failTimer: ReturnType<typeof setTimeout> | null = null;
  const FAIL_GRACE_MS = 15_000;

  function report(state: MemberStatus) {
    if (state === lastStatus) return;
    lastStatus = state;
    room?.reportStatus(state);
  }
  function clearFailTimer() {
    if (failTimer) {
      clearTimeout(failTimer);
      failTimer = null;
    }
  }

  function join(nick: string) {
    saveNickname(nick);
    nickname = nick;

    const b = new PageBridge();
    const r = new RoomClient(__PARTYKIT_HOST__, loc.room, loc.secret, nick);

    b.onStatus = (state, currentTime, duration) => {
      // A real video frame is reporting — it's no longer a no-video failure.
      if (state === "ready" || state === "stalled") clearFailTimer();
      report(state);
      pos = { t: currentTime, dur: duration, at: performance.now() };
    };
    const s = new SubtitleController(r, b);

    // Re-push personal subtitle state to a frame once it actually has the video.
    // Cues/style are only sent on change, so a frame that engages later (or is
    // nested deep) would otherwise miss them — this is what makes the settings
    // reliably "reflect" on the rendered subs. (resend() sends plain snapshots,
    // since Svelte $state proxies can't cross postMessage.)
    b.onHooked = (found) => {
      if (found) {
        clearFailTimer();
        s.resend();
      }
    };
    b.onReady = () => s.resend();
    b.onLocalControl = (intent, time) => r.control(intent, time);

    bridge = b;
    room = r;
    subs = s;
  }

  // Forward the latest server truth into the iframe whenever it changes (SPEC §4).
  $effect(() => {
    if (room?.sync && bridge) bridge.apply(room.sync, room.gate);
  });

  // When the room source changes: clear personal subtitles (they belonged to the
  // previous video) and restart the loading→failed grace for this client.
  let lastSrc: string | null | undefined;
  $effect(() => {
    const src = room?.sync?.src;
    if (src === lastSrc) return;
    const first = lastSrc === undefined;
    lastSrc = src;
    clearFailTimer();
    if (!first) subs?.clear();
    if (src) {
      report("loading");
      failTimer = setTimeout(() => {
        failTimer = null;
        report("failed");
      }, FAIL_GRACE_MS);
    }
  });

  // Detect the extension shortly after load (the content script tags <html>).
  $effect(() => {
    const id = setTimeout(() => {
      extMissing = document.documentElement.getAttribute("data-sixseven-ext") !== "1";
    }, 2000);
    return () => clearTimeout(id);
  });

  $effect(() => {
    return () => {
      room?.destroy();
      bridge?.destroy();
    };
  });

  const joined = $derived(room !== null && nickname !== "");
</script>

{#if !joined}
  <Join room={loc.room} initialNick={nickname} onJoin={join} />
{:else if room && bridge}
  <div class="layout">
    <main>
      {#if extMissing}
        <div class="ext-warn">
          ⚠ sixseven extension not detected — playback can't sync. Install/enable it, then reload.
        </div>
      {/if}
      <Embed src={room.sync?.src ?? null} {bridge} />
      <Controls {room} {pos} />
      {#if subs}<SubtitlePanel {subs} />{/if}
    </main>
    <aside>
      <div class="brand">
        sixseven
        <span class="conn {room.connected ? 'on' : 'off'}">
          {room.connected ? "connected" : "reconnecting…"}
        </span>
      </div>
      <Members {room} />
      <ActivityLog {room} />
    </aside>
  </div>
{/if}

<style>
  .layout {
    display: grid;
    grid-template-columns: 1fr 300px;
    height: 100%;
  }
  main {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .ext-warn {
    padding: 8px 12px;
    background: color-mix(in srgb, var(--bad) 22%, var(--bg));
    color: var(--text);
    font-size: 13px;
    border-bottom: 1px solid var(--line);
  }
  aside {
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--line);
    background: var(--panel);
    min-height: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px;
    font-weight: 600;
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--line);
  }
  .conn {
    font-size: 11px;
    font-weight: 400;
    padding: 2px 8px;
    border-radius: 999px;
  }
  .conn.on {
    color: var(--good);
    background: color-mix(in srgb, var(--good) 18%, transparent);
  }
  .conn.off {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 18%, transparent);
  }
</style>
