<script lang="ts">
  import type { Intent, MemberStatus, SyncMessage } from "@sixseven/protocol";
  import ActivityLog from "./components/ActivityLog.svelte";
  import Controls from "./components/Controls.svelte";
  import DirectPlayer from "./components/DirectPlayer.svelte";
  import Embed from "./components/Embed.svelte";
  import Join from "./components/Join.svelte";
  import Members from "./components/Members.svelte";
  import SubtitlePanel from "./components/SubtitlePanel.svelte";
  import { isPickSourceMessage, ROOM_ATTR } from "@sixseven/protocol/picker";
  import { PageBridge } from "./lib/bridge";
  import { RoomClient } from "./lib/room.svelte";
  import { loadNickname, readRoomLocation, saveNickname } from "./lib/session";
  import { classifySource, extractSourceUrl } from "./lib/source";
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
  // Debug HUD (?hud): for embed sources, show the iframe video's time vs the
  // server clock + drift on the page (the embed can't be DevTools'd).
  const showHud = new URLSearchParams(window.location.search).has("hud");
  let hud = $state<{ t: number; want: number; drift: number } | null>(null);
  let syncAt = 0;
  // Transient banner for picker deliveries (SPEC §12) — the extension popup
  // hands us a source URL it found on another tab.
  let pickerNotice = $state<{ text: string; ok: boolean } | null>(null);
  let pickerTimer: ReturnType<typeof setTimeout> | null = null;
  function flashPicker(text: string, ok: boolean) {
    pickerNotice = { text, ok };
    if (pickerTimer) clearTimeout(pickerTimer);
    pickerTimer = setTimeout(() => (pickerNotice = null), 5000);
  }

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

  // Shared by both player paths (iframe bridge + direct <video>): a readiness
  // report drives the buffer gate and the scrubber position.
  function onStatusReport(state: MemberStatus, currentTime: number, duration: number) {
    if (state === "ready" || state === "stalled") clearFailTimer();
    report(state);
    pos = { t: currentTime, dur: duration, at: performance.now() };
  }
  function onLocalControlReport(intent: Intent, time: number) {
    room?.control(intent, time);
  }

  function join(nick: string) {
    saveNickname(nick);
    nickname = nick;

    const b = new PageBridge();
    // No configured host → talk to our own origin (the dev server proxies
    // /parties to the local PartyKit; in prod set VITE_PARTYKIT_HOST). This lets
    // one tunnel serve both the page and the backend for cross-device testing.
    const host = __PARTYKIT_HOST__ || window.location.host;
    const r = new RoomClient(host, loc.room, loc.secret, nick);
    // Throttle resync requests across rapid (re)hooks (see b.onHooked).
    let lastResyncAt = 0;

    b.onStatus = onStatusReport;
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
        // A frame that just (re)hooked a <video> may have loaded after the last
        // `apply` (we no longer spam apply every second), so pull a freshly
        // projected `sync` to enforce the current state on it. Throttle: an embed
        // that churns its DOM can re-hook rapidly, and we don't want a resync storm.
        const now = performance.now();
        if (now - lastResyncAt > 1500) {
          lastResyncAt = now;
          r.resync();
        }
      }
    };
    b.onReady = () => s.resend();
    b.onLocalControl = onLocalControlReport;

    bridge = b;
    room = r;
    subs = s;
  }

  // Forward the latest server truth into the iframe (SPEC §4). Only when the
  // `sync` object itself changes (a fresh server-projected `time`) or the gate's
  // pause flips — NOT on every no-op `gate` rebroadcast (~1/s from status
  // reports). Re-applying a stale `sync.time` would make the content script seek
  // backward to an old position every second (visible as jitter).
  let lastAppliedSync: SyncMessage | null = null;
  let lastGatePaused: boolean | null = null;
  $effect(() => {
    if (!room?.sync || !bridge) return;
    // Direct sources are driven by DirectPlayer, not the iframe bridge.
    if (room.sync.srcKind === "direct") return;
    const sync = room.sync;
    const paused = room.gate.paused;
    if (sync === lastAppliedSync && paused === lastGatePaused) return;
    lastAppliedSync = sync;
    lastGatePaused = paused;
    bridge.apply(sync, room.gate, room.members.length <= 1);
  });

  // HUD: stamp when each sync arrives, then project both clocks on a small timer.
  $effect(() => {
    void room?.sync;
    syncAt = performance.now();
  });
  $effect(() => {
    if (!showHud) return;
    const id = setInterval(() => {
      const r = room;
      const sync = r?.sync;
      if (!r || !sync) {
        hud = null;
        return;
      }
      const rate = sync.rate || 1;
      const playing = sync.intent === "playing" && !r.gate.paused;
      const now = performance.now();
      const want = sync.time + (playing ? ((now - syncAt) / 1000) * rate : 0);
      const t = pos.t + (playing ? ((now - pos.at) / 1000) * rate : 0);
      hud = { t, want, drift: t - want };
    }, 150);
    return () => clearInterval(id);
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

  // While joined, tag <html> with the room name so the extension picker popup
  // can recognise this tab as a sixseven room and deliver a picked source. The
  // delivery arrives as a window message (posted by the content script on our
  // own origin); we re-validate it exactly like a pasted URL and `setSource`.
  $effect(() => {
    if (!joined || !room) return;
    const r = room;
    document.documentElement.setAttribute(ROOM_ATTR, loc.room);
    const onPick = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || !isPickSourceMessage(e.data)) return;
      if (!r.canControl) {
        flashPicker("Can't set source — host mode is on and you're not the host.", false);
        return;
      }
      const { url, error } = extractSourceUrl(e.data.url);
      if (error || !url) {
        flashPicker(error ?? "The picker sent an invalid source.", false);
        return;
      }
      r.setSource(url, classifySource(url));
      flashPicker("Source set from the extension picker.", true);
    };
    window.addEventListener("message", onPick);
    return () => {
      window.removeEventListener("message", onPick);
      document.documentElement.removeAttribute(ROOM_ATTR);
    };
  });

  $effect(() => {
    return () => {
      room?.destroy();
      bridge?.destroy();
      if (pickerTimer) clearTimeout(pickerTimer);
    };
  });

  const joined = $derived(room !== null && nickname !== "");
  // How the current source is rendered: framed embed vs our own <video> player.
  const sourceKind = $derived(room?.sync?.srcKind ?? "embed");
</script>

{#if !joined}
  <Join room={loc.room} initialNick={nickname} onJoin={join} />
{:else if room && bridge}
  <div class="layout">
    <main>
      {#if extMissing && sourceKind !== "direct"}
        <div class="ext-warn">
          ⚠ sixseven extension not detected — embedded playback can't sync. Install/enable it, then
          reload. (Direct/HLS sources play without the extension.)
        </div>
      {:else if sourceKind === "embed" && room.sync?.src && room.me?.status === "failed"}
        <div class="ext-warn">
          ⚠ This source didn't load — it may block embedding (frame-forbidden) or be unreachable. Try
          <strong>direct/HLS</strong> mode, a different source, or <strong>reload</strong>.
        </div>
      {/if}
      {#if sourceKind === "direct" && room.sync?.src}
        <DirectPlayer
          src={room.sync.src}
          sync={room.sync}
          gate={room.gate}
          {subs}
          solo={room.members.length <= 1}
          onStatus={onStatusReport}
          onUserControl={onLocalControlReport}
        />
      {:else}
        <Embed src={room.sync?.src ?? null} {bridge} />
      {/if}
      {#if showHud && sourceKind === "embed" && hud}
        <div class="hud">
          t={hud.t.toFixed(2)} · want={hud.want.toFixed(2)} · drift={hud.drift.toFixed(2)} ·
          {room.sync?.intent}{room.gate.paused ? " · GATED" : ""}{room.members.length <= 1
            ? " · solo"
            : ` · ${room.members.length}`}
        </div>
      {/if}
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
  .hud {
    position: fixed;
    top: 8px;
    left: 8px;
    z-index: 50;
    padding: 4px 8px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.75);
    color: #6ea8fe;
    font: 12px/1.2 ui-monospace, monospace;
    pointer-events: none;
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
