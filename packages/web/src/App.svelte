<script lang="ts">
  import type { Intent, MemberStatus, Mode, SyncMessage } from "@sixseven/protocol";
  import {
    Captions,
    Crown,
    Link2,
    PanelRightClose,
    PanelRightOpen,
    Share2,
    SmilePlus,
    Users,
    Video,
    X,
  } from "lucide-svelte";
  import ActivityLog from "./components/ActivityLog.svelte";
  import Controls from "./components/Controls.svelte";
  import CreateRoom from "./components/CreateRoom.svelte";
  import DirectPlayer from "./components/DirectPlayer.svelte";
  import Embed from "./components/Embed.svelte";
  import YouTubePlayer from "./components/YouTubePlayer.svelte";
  import Join from "./components/Join.svelte";
  import Chat from "./components/Chat.svelte";
  import GifPicker from "./components/GifPicker.svelte";
  import Members from "./components/Members.svelte";
  import Reactions from "./components/Reactions.svelte";
  import SourcePanel from "./components/SourcePanel.svelte";
  import SubtitlePanel from "./components/SubtitlePanel.svelte";
  import VideoCall from "./components/VideoCall.svelte";
  import { isPickSourceMessage, ROOM_ATTR } from "@sixseven/protocol/picker";
  import { PageBridge } from "./lib/bridge";
  import { RoomClient } from "./lib/room.svelte";
  import {
    loadNickname,
    makeSecret,
    readRoomLocation,
    roomUrl,
    saveNickname,
  } from "./lib/session";
  import { classifySource, extractSourceUrl } from "./lib/source";
  import { SubtitleController } from "./lib/subtitleController.svelte";

  let loc = $state(readRoomLocation());
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
  // Local copy of the active player's readiness, for an immediate buffering
  // spinner (no server round-trip). Direct player only — embeds are opaque.
  let playerStatus = $state<MemberStatus>("loading");
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
    playerStatus = state;
    report(state);
    pos = { t: currentTime, dur: duration, at: performance.now() };
  }
  function onLocalControlReport(intent: Intent, time: number) {
    room?.control(intent, time);
  }
  // Playlist auto-advance (§16): when our player ends, ask the server for the
  // next queued item. Gated to controllers; the server dedups via afterId so
  // multiple viewers ending at once don't skip several.
  function onEnded() {
    if (room?.canControl) room.playNext(room.playlistCurrentId);
  }

  // Create a brand-new room: mint a secret, push the capability URL into history
  // (no reload — keeps it a single SPA session), then join with the chosen mode.
  // The server honours `createMode` only on the room-creating join (M2).
  function createRoom(name: string, nick: string, mode: Mode) {
    const secret = makeSecret();
    history.pushState({}, "", roomUrl(name, secret));
    loc = { room: name, secret };
    join(nick, mode);
  }

  function join(nick: string, createMode?: Mode) {
    saveNickname(nick);
    nickname = nick;

    const b = new PageBridge();
    // No configured host → talk to our own origin (the dev server proxies
    // /parties to the local PartyKit; in prod set VITE_PARTYKIT_HOST). This lets
    // one tunnel serve both the page and the backend for cross-device testing.
    const host = __PARTYKIT_HOST__ || window.location.host;
    const r = new RoomClient(host, loc.room, loc.secret, nick, createMode);
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
    b.onEnded = onEnded; // embed video ended → playlist auto-advance (§16)
    b.onTracks = (tracks) => s.setTracks(tracks); // embed's own caption tracks (§13)

    // Fun layer (§14): every event echoes back from the server (incl. our own),
    // so all clients render the same. Reactions float; chat goes to the panel +
    // briefly floats as a bubble.
    r.onEvent = (e) => {
      if (e.kind === "reaction") spawnReaction(e.text);
      else if (e.kind === "gif") spawnGif(e.text);
      else if (e.kind === "chat") addChat(e.name, e.text, e.from === r.self);
    };

    bridge = b;
    room = r;
    subs = s;
  }

  // ── reactions + gifs (float-up) ─────────────────────────────────────────────
  let reactions = $state<{ id: number; x: number; emoji?: string; gif?: string }[]>([]);
  let funSeq = 0;
  function spawnReaction(emoji: string) {
    if (!fun.reactions) return;
    const id = funSeq++;
    const x = 8 + Math.random() * 84;
    reactions = [...reactions, { id, emoji, x }];
    setTimeout(() => {
      reactions = reactions.filter((r) => r.id !== id);
    }, 2300 * funMult);
  }
  function spawnGif(url: string) {
    if (!fun.gifs) return;
    const id = funSeq++;
    const x = 12 + Math.random() * 60;
    reactions = [...reactions, { id, gif: url, x }];
    setTimeout(() => {
      reactions = reactions.filter((r) => r.id !== id);
    }, 6000 * funMult);
  }

  // ── chat (sidebar panel + transient bubbles over the player) ────────────────
  let chatLog = $state<{ id: number; name: string; text: string; self: boolean }[]>([]);
  let chatBubbles = $state<{ id: number; name: string; text: string }[]>([]);
  let sideTab = $state<"chat" | "activity">("chat");
  let reactOpen = $state(false);
  const REACT_EMOJIS = ["😂", "❤️", "🔥", "👍", "😮", "😢", "🎉"];

  // Personal fun-layer display settings (§14) — how YOU see reactions/gifs/chat
  // bubbles. Not synced; you still receive everything, this only gates display.
  type FunSettings = { reactions: boolean; gifs: boolean; bubbles: boolean; speed: "fast" | "normal" | "slow" };
  const FUN_KEY = "sixseven:funSettings";
  function loadFun(): FunSettings {
    try {
      return { reactions: true, gifs: true, bubbles: true, speed: "normal", ...JSON.parse(localStorage.getItem(FUN_KEY) ?? "{}") };
    } catch {
      return { reactions: true, gifs: true, bubbles: true, speed: "normal" };
    }
  }
  let fun = $state<FunSettings>(loadFun());
  const SPEED_MULT = { fast: 0.5, normal: 1, slow: 1.9 } as const;
  const funMult = $derived(SPEED_MULT[fun.speed]);
  function setFun<K extends keyof FunSettings>(k: K, v: FunSettings[K]) {
    fun = { ...fun, [k]: v };
    try {
      localStorage.setItem(FUN_KEY, JSON.stringify(fun));
    } catch {
      /* non-fatal */
    }
  }
  function addChat(name: string, text: string, self: boolean) {
    const id = funSeq++;
    chatLog = [...chatLog, { id, name, text, self }].slice(-100);
    if (!fun.bubbles) return; // chat still shows in the panel; just no float
    chatBubbles = [...chatBubbles, { id, name, text }];
    setTimeout(() => {
      chatBubbles = chatBubbles.filter((b) => b.id !== id);
    }, 6000 * funMult);
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
    // Only embed sources use the iframe bridge; direct/youtube play in their own
    // room-page components, site (own-tab) isn't rendered on the room page.
    if (room.sync.srcKind !== "embed") return;
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
      // YouTube always wins (a YT embed would otherwise arrive tagged "embed").
      const auto = classifySource(url);
      const kind = auto === "youtube" ? "youtube" : (e.data.srcKind ?? auto);
      if (e.data.queue) {
        r.queueAdd(url, kind);
        flashPicker("Added to the queue from the extension picker.", true);
      } else {
        r.setSource(url, kind);
        flashPicker("Source set from the extension picker.", true);
      }
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

  // ── player UI state (M1) ──────────────────────────────────────────────────
  let sidebarOpen = $state(true);
  let activePanel = $state<"source" | "subs" | null>(null);
  let callOn = $state(false);
  let playerArea = $state<HTMLElement | null>(null);
  // Personal audio (direct player only; not synced).
  let muted = $state(false);
  let volume = $state(1);
  const mode = $derived(room?.sync?.mode ?? "open");

  function togglePanel(p: "source" | "subs") {
    activePanel = activePanel === p ? null : p;
  }
  // Copy the capability URL (room + secret) so the creator can invite people.
  function copyInvite() {
    const path = loc.secret ? roomUrl(loc.room, loc.secret) : `/r/${encodeURIComponent(loc.room)}`;
    const url = window.location.origin + path;
    navigator.clipboard.writeText(url).then(
      () => flashPicker("Invite link copied — share it to bring people in.", true),
      () => flashPicker("Couldn't copy — grab the URL from the address bar.", false),
    );
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else playerArea?.requestFullscreen?.();
  }
  function setVolume(v: number) {
    volume = v;
    muted = v === 0;
  }
</script>

{#if !loc.room}
  <CreateRoom initialNick={nickname} onCreate={createRoom} />
{:else if !joined}
  <Join room={loc.room} initialNick={nickname} onJoin={join} />
{:else if room?.fatalError}
  <div class="fatal">
    <div class="fatal-card">
      <h1>Can't join this room</h1>
      <p>{room.fatalError}</p>
      <button onclick={() => location.assign('/')}>Start a new room</button>
    </div>
  </div>
{:else if room && bridge}
  <div class="layout" class:full={!sidebarOpen}>
    <main>
      <header class="topbar">
        <span class="brand">sixseven</span>
        <span class="dot {room.connected ? 'on' : 'off'}" title={room.connected ? 'connected' : 'reconnecting…'}></span>
        <span class="room-name" title="Room">{loc.room}</span>
        <span class="spacer"></span>
        <div class="react-wrap">
          <button class="tb" class:on={reactOpen} onclick={() => (reactOpen = !reactOpen)} disabled={!room.sync?.src} title="React">
            <SmilePlus size={16} /> React
          </button>
          {#if reactOpen}
            <div class="react-pop">
              <div class="emoji-row">
                {#each REACT_EMOJIS as e (e)}
                  <button class="react-emoji" onclick={() => room?.say('reaction', e)}>{e}</button>
                {/each}
              </div>
              <GifPicker {room} onSend={(url) => room?.say('gif', url)} />
              <div class="fun-settings">
                <span class="fs-title">Show over video</span>
                <label><input type="checkbox" checked={fun.reactions} onchange={(e) => setFun('reactions', e.currentTarget.checked)} /> Reactions</label>
                <label><input type="checkbox" checked={fun.gifs} onchange={(e) => setFun('gifs', e.currentTarget.checked)} /> GIFs</label>
                <label><input type="checkbox" checked={fun.bubbles} onchange={(e) => setFun('bubbles', e.currentTarget.checked)} /> Chat bubbles</label>
                <div class="fs-speed">
                  <span>Linger</span>
                  <select value={fun.speed} onchange={(e) => setFun('speed', e.currentTarget.value as 'fast' | 'normal' | 'slow')}>
                    <option value="fast">Fast</option>
                    <option value="normal">Normal</option>
                    <option value="slow">Slow</option>
                  </select>
                </div>
              </div>
            </div>
          {/if}
        </div>
        <button class="tb" class:on={callOn} onclick={() => (callOn = !callOn)} title="Video call (up to 2)">
          <Video size={16} /> Call
        </button>
        <button class="tb" onclick={copyInvite} title="Copy the invite link">
          <Share2 size={16} /> Invite
        </button>
        <button class="tb" class:on={activePanel === 'subs'} onclick={() => togglePanel('subs')} disabled={!room.sync?.src}>
          <Captions size={16} /> Subtitles
        </button>
        <button class="tb" class:on={activePanel === 'source'} onclick={() => togglePanel('source')} disabled={!room.canControl}>
          <Link2 size={16} /> Source
        </button>
        <button
          class="tb"
          onclick={() => room?.setMode(mode === 'host' ? 'open' : 'host')}
          disabled={!room.canControl}
          title={mode === 'host' ? 'Host-only — click to let anyone control' : 'Anyone can control — click to lock to host'}
        >
          {#if mode === 'host'}<Crown size={16} /> Host-only{:else}<Users size={16} /> Anyone{/if}
        </button>
        <button class="tb icon-only" onclick={() => (sidebarOpen = !sidebarOpen)} title={sidebarOpen ? 'Hide panel' : 'Show panel'}>
          {#if sidebarOpen}<PanelRightClose size={16} />{:else}<PanelRightOpen size={16} />{/if}
        </button>
      </header>

      <div class="player-area" bind:this={playerArea}>
        {#if !room.sync?.src}
          <div class="empty-state">
            {#if room.canControl}
              <p class="es-title">Nothing playing yet</p>
              <p class="es-sub">Pick something to watch — paste a link or grab a video with the extension.</p>
              <div class="es-actions">
                <button class="es-go" onclick={() => togglePanel('source')}>
                  <Link2 size={16} /> Pick a source
                </button>
                <button class="es-alt" onclick={copyInvite}>
                  <Share2 size={16} /> Invite friends
                </button>
              </div>
            {:else}
              <p class="es-title">Waiting for the host…</p>
              <p class="es-sub">They'll pick something to watch in a moment.</p>
            {/if}
          </div>
        {:else if sourceKind === "direct"}
          <DirectPlayer
            src={room.sync.src}
            sync={room.sync}
            gate={room.gate}
            {subs}
            solo={room.members.length <= 1}
            {muted}
            {volume}
            onStatus={onStatusReport}
            onUserControl={onLocalControlReport}
            {onEnded}
          />
        {:else if sourceKind === "youtube"}
          <YouTubePlayer
            src={room.sync.src}
            sync={room.sync}
            gate={room.gate}
            {subs}
            solo={room.members.length <= 1}
            onStatus={onStatusReport}
            onUserControl={onLocalControlReport}
            {onEnded}
          />
        {:else}
          <Embed src={room.sync.src} {bridge} />
        {/if}

        {#if callOn && room.self}
          <VideoCall {room} onClose={() => (callOn = false)} />
        {/if}

        {#if (sourceKind === "direct" || sourceKind === "youtube") && room.sync?.src && (playerStatus === "loading" || playerStatus === "stalled")}
          <div class="spinner-wrap"><span class="spinner"></span></div>
        {/if}

        {#if showHud && sourceKind === "embed" && hud}
          <div class="hud">
            t={hud.t.toFixed(2)} · want={hud.want.toFixed(2)} · drift={hud.drift.toFixed(2)} ·
            {room.sync?.intent}{room.gate.paused ? " · GATED" : ""}{room.members.length <= 1
              ? " · solo"
              : ` · ${room.members.length}`}
          </div>
        {/if}

        {#if !room.connected}
          <div class="toast warn">reconnecting…</div>
        {:else if pickerNotice}
          <div class="toast {pickerNotice.ok ? 'ok' : 'bad'}">{pickerNotice.text}</div>
        {/if}

        {#if extMissing && sourceKind === "embed"}
          <div class="banner">
            ⚠ sixseven extension not detected — embedded playback can't sync. Install/enable it,
            then reload. (Direct, YouTube, and HLS sources play without the extension.)
          </div>
        {:else if sourceKind === "embed" && room.sync?.src && room.me?.status === "failed"}
          <div class="banner">
            ⚠ This source didn't load — it may block embedding or be unreachable. Try
            <strong>Direct / HLS</strong> mode in Source, a different source, or Reload.
          </div>
        {/if}

        {#if activePanel === "source"}
          <div class="popover">
            <div class="pop-head"><span>Source</span><button class="x" onclick={() => (activePanel = null)} aria-label="Close"><X size={16} /></button></div>
            <SourcePanel {room} />
          </div>
        {:else if activePanel === "subs" && subs}
          <div class="popover">
            <div class="pop-head"><span>Subtitles</span><button class="x" onclick={() => (activePanel = null)} aria-label="Close"><X size={16} /></button></div>
            <SubtitlePanel {subs} />
          </div>
        {/if}

        <!-- Our video bar is for the direct player only; embeds + YouTube use their own. -->
        {#if sourceKind === "direct" && room.sync?.src}
          <div class="bar-wrap">
            <Controls
              {room}
              {pos}
              {muted}
              {volume}
              onMute={() => (muted = !muted)}
              onVolume={setVolume}
              onFullscreen={toggleFullscreen}
            />
          </div>
        {/if}

        {#if room.sync?.src}
          <Reactions {reactions} mult={funMult} />
        {/if}

        {#if chatBubbles.length}
          <div class="chat-bubbles" style="--fun-mult: {funMult}">
            {#each chatBubbles as b (b.id)}
              <div class="bubble-msg"><span class="bn">{b.name}</span> {b.text}</div>
            {/each}
          </div>
        {/if}
      </div>
    </main>

    {#if sidebarOpen}
      <aside>
        <Members {room} onInvite={copyInvite} />
        <div class="side-tabs">
          <button class:on={sideTab === 'chat'} onclick={() => (sideTab = 'chat')}>Chat</button>
          <button class:on={sideTab === 'activity'} onclick={() => (sideTab = 'activity')}>Activity</button>
        </div>
        {#if sideTab === 'chat'}
          <Chat {room} messages={chatLog} />
        {:else}
          <ActivityLog {room} />
        {/if}
      </aside>
    {/if}
  </div>
{/if}

<style>
  .fatal {
    display: grid;
    place-items: center;
    height: 100%;
    padding: 24px;
    background: var(--bg);
  }
  .fatal-card {
    max-width: 420px;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 28px;
    border-radius: 12px;
    background: var(--panel);
  }
  .fatal-card h1 {
    margin: 0;
    font-size: 20px;
  }
  .fatal-card p {
    margin: 0;
    color: var(--muted);
    line-height: 1.5;
  }
  .fatal-card button {
    align-self: center;
    margin-top: 4px;
    background: var(--accent);
    color: #fff;
  }
  .layout {
    display: grid;
    grid-template-columns: 1fr 320px;
    height: 100%;
  }
  .layout.full {
    grid-template-columns: 1fr;
  }
  main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: #000;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }
  .topbar .brand {
    font-weight: 700;
    letter-spacing: 0.5px;
  }
  .room-name {
    color: var(--muted);
    font-size: 13px;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
  }
  .dot.on {
    background: var(--good);
  }
  .dot.off {
    background: var(--warn);
  }
  .spacer {
    flex: 1;
  }
  .tb {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 13px;
  }
  .tb.icon-only {
    padding: 6px 8px;
  }
  .react-wrap {
    position: relative;
  }
  .react-pop {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  }
  .emoji-row {
    display: flex;
    gap: 2px;
  }
  .fun-settings {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding-top: 8px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    color: var(--muted);
  }
  .fun-settings .fs-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .fun-settings label {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
  }
  .fs-speed {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .fs-speed select {
    flex: 1;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 6px;
  }
  .react-emoji {
    background: none;
    border: none;
    border-radius: 999px;
    padding: 4px 6px;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
  }
  .react-emoji:hover {
    background: var(--panel-2);
    transform: scale(1.15);
  }
  .tb.on {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 22%, var(--panel-2));
  }
  .player-area {
    position: relative;
    flex: 1;
    display: flex;
    min-width: 0;
    min-height: 0;
    background: #000;
  }
  .bar-wrap {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
  }
  .empty-state {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    text-align: center;
    padding: 24px;
  }
  .es-title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  .es-sub {
    margin: 0;
    color: var(--muted);
    max-width: 360px;
    line-height: 1.5;
  }
  .es-actions {
    display: flex;
    gap: 10px;
    margin-top: 12px;
  }
  .es-go,
  .es-alt {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 10px 16px;
    font-weight: 600;
  }
  .es-go {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .spinner-wrap {
    position: absolute;
    inset: 0;
    z-index: 18;
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .spinner {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    border: 4px solid rgba(255, 255, 255, 0.2);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .popover {
    position: absolute;
    right: 12px;
    top: 12px;
    z-index: 25;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
    overflow: hidden;
    max-height: calc(100% - 90px);
    display: flex;
    flex-direction: column;
  }
  .pop-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
    font-weight: 600;
  }
  .pop-head .x {
    display: inline-flex;
    align-items: center;
    line-height: 0;
    padding: 4px;
    background: none;
    border: none;
    color: var(--muted);
  }
  .pop-head .x:hover {
    color: var(--text);
  }
  .hud {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 30;
    padding: 4px 8px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.75);
    color: #6ea8fe;
    font: 12px/1.2 ui-monospace, monospace;
    pointer-events: none;
  }
  .toast {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 30;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 13px;
    pointer-events: none;
  }
  .toast.warn {
    background: color-mix(in srgb, var(--warn) 85%, #000);
    color: #000;
  }
  .toast.ok {
    background: color-mix(in srgb, var(--good) 85%, #000);
    color: #000;
  }
  .toast.bad {
    background: color-mix(in srgb, var(--bad) 90%, #000);
    color: #fff;
  }
  .banner {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 22;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--bad) 38%, #000);
    color: var(--text);
    font-size: 13px;
  }
  aside {
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--line);
    background: var(--panel);
    min-height: 0;
  }
  .side-tabs {
    display: flex;
    border-bottom: 1px solid var(--line);
  }
  .side-tabs button {
    flex: 1;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: 8px;
    color: var(--muted);
    font-size: 13px;
    cursor: pointer;
  }
  .side-tabs button.on {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .chat-bubbles {
    position: absolute;
    left: 12px;
    bottom: 84px;
    z-index: 16;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 60%;
    pointer-events: none;
  }
  .bubble-msg {
    align-self: flex-start;
    padding: 6px 11px;
    border-radius: 14px;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
    font-size: 13px;
    line-height: 1.35;
    animation: bubble-life calc(6s * var(--fun-mult, 1)) ease forwards;
  }
  .bubble-msg .bn {
    font-weight: 700;
    color: #9ec1ff;
    margin-right: 4px;
  }
  @keyframes bubble-life {
    0% {
      opacity: 0;
      transform: translateY(8px);
    }
    4% {
      opacity: 1;
      transform: translateY(0);
    }
    90% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
</style>
