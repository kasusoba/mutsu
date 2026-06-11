# sixseven — Roadmap

Phases are ordered so there's something *usable* as early as possible. Each phase ends with
a concrete "you can now…" milestone.

> **MVP focus (decided):** the **extension flow** is the MVP — detect the video on any site,
> "share to room," everyone's extension auto-opens it, and a clean overlay player keeps the
> group synced. The standalone web player (direct-URL) is demoted to a later/secondary path.
> We build **control-sync** (everyone loads the source themselves; we sync the clock + overlay
> UI), **not** stream-ripping into a central player.

## Phase 0 — Decisions (no code)
- [x] Sync server: **PartyKit / Cloudflare Durable Objects**.
- [x] Frontend stack: **Svelte**.
- [x] Control model: **both** — per-room `mode` toggle (`open` / `host` + pass-control).
- [ ] Resolve remaining open questions (room auth, buffered-gate timing, host-disconnect).
- [ ] Name the project (currently `sixseven`).

**Milestone:** core stack chosen ✅ — remaining items are minor and can be settled in Phase 1.

## Phase 1 — Sync server core (PartyKit)
- [ ] PartyKit project; one Durable Object per room holding the `Room` state object.
- [ ] Implement protocol: `join`, `setSource`, `control`, `setMode`, `passControl` → `sync`,
      `members`.
- [ ] Single-clock projection (`projected = paused ? time : time + (now - updatedAt)/1000`).
- [ ] Server-enforced control-acceptance rule (open vs. host mode).
- [ ] 3s heartbeat `sync` tick while playing.
- [ ] Throwaway CLI/test client to verify state broadcasts.

**Milestone:** two test clients see each other's play/pause/seek via the server, and host
mode correctly drops non-host control.

## Phase 2 — Room page + extension MVP (the core product)
Everyone gathers on a hosted room page; the source is embedded as an iframe; the extension
bridges in to sync + overlay.
- [ ] **Static room page** (Svelte, Cloudflare Pages): `/r/<name>#k=<secret>`, join + nickname.
- [ ] Room page **embeds the shared source** in an `<iframe>`.
- [ ] MV3 extension: content script (`all_frames: true`) that **detects `<video>`** (for the
      "share" picker) and **hooks the embedded iframe's `<video>`** for sync.
- [ ] **"Share to room"** popup → create/join room; store source URL in the room.
- [ ] Background service worker holds the WS connection per room.
- [ ] **Clean overlay player:** full takeover + escape hatch over the iframe; our control bar
      drives the native `<video>` via JS (no peek-through).
- [ ] Control-sync: report `play`/`pause`/`seeked` + `currentTime`; apply `sync` (0.5s drift).
- [ ] **Buffer gate:** soft-pause on any stall, 25s skip valve, unified with start.
- [ ] Members/presence + activity-log panel inside the overlay.
- [ ] Handle the `<video>` appearing late / being swapped (observe DOM/MSE changes).

**Milestone:** host shares an embed, the crew opens the room link, and everyone watches the
embedded source in sync inside a clean overlay — control-sync, no ripping/forging.

## Phase 3 — Custom subtitle overlay (works on ANY source)
- [ ] Render WebVTT/SRT cues ourselves as an **overlay layer** synced to `currentTime` —
      so custom subs work on YouTube/embeds too, not just direct files (asbplayer-style).
- [ ] Per-viewer local controls: **offset/delay**, **position**, **style** (size/color/box/opacity).
- [ ] Subtitle sources: **upload**, **embedded tracks**, **online search** (OpenSubtitles-style).

**Milestone:** anyone can load + restyle + time-shift their own subtitles over any synced video.

## Phase 4 — Secondary web-player path & niceties
- [ ] Standalone web player (direct-URL / HLS) for sources that don't need the extension /
      for quick links (the originally-planned Svelte SPA player).
- [ ] YouTube/Vimeo via their iframe player APIs where cleaner than raw `<video>` hooking.
- [ ] End-of-video → "pick the next thing" prompt (one-at-a-time).

**Milestone:** paste-a-URL watch-party works without the extension, as a fallback path.

## Phase 5 — Host local file (optional, advanced)
- [ ] Host-file sharing via browser **WebTorrent** (P2P) for web-seed-compatible files —
      stays on the free Cloudflare path, no second backend.
- [ ] _(Torrents from arbitrary magnets are out of scope — would need a second always-on
      server; revisit only if wanted.)_

**Milestone:** host shares a local file to the room without uploading it to a central server.

## Phase 6 — Polish & deploy
- [ ] Deploy sync server (PartyKit on your Cloudflare, free) + any static assets (Pages).
- [ ] Build **both extension targets**: Chromium (MV3) and Firefox (manifest differences).
- [ ] Distribute **unpacked first** (dev install for the crew), then **publish** to the Web
      Store / AMO when stable (you already have the store account).
- [ ] Write a 2-minute "how your homies join" guide.

**Milestone:** a friend goes from install → watching in sync in under 2 minutes.

---

### Deliberately out of scope (see ARCHITECTURE.md → Non-goals)
DRM bypass · stream ripping/rehosting · header/CORS forging · virtual browser ·
public/broadcast scale.
