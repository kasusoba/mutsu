# CLAUDE.md — sixseven

Guidance for Claude Code working in this repo. Read the docs before writing code:
[README](README.md) · [PRD](docs/PRD.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Roadmap](docs/ROADMAP.md).

## What this is

A self-hosted **watch-party** tool. Friends hang out in Discord voice; sixseven keeps
their video playback in **sync**. It is a **control-sync** system: every viewer plays their
own copy of the source locally, and the server broadcasts only `play`/`pause`/`seek`.
**No video bytes ever pass through the server.**

**MVP = room page + embedded source.** Everyone gathers on a free **static room page**
(Svelte on Cloudflare Pages); the shared source is **embedded as an `<iframe>`**; the
**extension bridges into the cross-origin iframe** to hook the `<video>`, draw a clean
full-takeover overlay (+ escape hatch), and keep everyone synced. Custom **subtitle overlay**
(offset/position/style) works on *any* frame-allowing source by rendering cues ourselves over
the video (asbplayer-style). This is the Twoseven "media in the room" feel **via embedding,
not extraction**. Works for frame-allowing sources (embed providers, YouTube); we do **not**
strip `X-Frame-Options` for frame-forbidding sites. Standalone paste-a-URL player = later.

## The one principle that drives every decision

> **Move the URL and the clock, never the bytes.**

If a proposed feature would route video through the server, re-encode it, or run a browser
in the cloud — stop and reconsider. That's how this stays free to host and instant to use.
Those approaches (server relay, virtual browser, screen capture) are explicit non-goals.

## Stack (decided — Phase 0)

- **Sync server:** PartyKit / Cloudflare Durable Objects (one DO per room). Deploy via
  `npx partykit deploy`.
- **Frontend:** Svelte (static SPA).
- **Extension:** MV3.
- **Control modes:** per-room `mode` toggle — `open` (anyone controls) and `host`
  (designated controller + `passControl`). Default `open`. Server enforces acceptance.
- **Auth:** locked-by-default capability URL (secret in URL fragment) + open toggle + reset-link.
- **Buffer gate:** one unified stall gate; soft-pause vs. hard-pause kept separate; 25s skip
  valve (perm = control mode); no tab-out opt-out; start uses the same gate.
- **Host disconnect:** auto-promote longest-connected, else fall back to `open`.
- **Source pick:** privileged action gated by control mode; auto-loads on all clients.
- **Subtitles:** personal offset/position/style, our-player sources only.
- **Identity:** nickname only (localStorage). **Devices:** desktop-only. **Torrents:** out of
  scope. **Playlist:** one at a time. **Activity log:** sidebar of meaningful events.

## Architecture in one breath

- **Sync server** — WebSocket relay (PartyKit DO), per-room state
  `{src, paused, time, rate, updatedAt, mode, hostId}`, with the **server's own clock as the
  single source of truth** for drift correction. All playback-time projection happens
  server-side so clients never do cross-clock math.
- **Frontend** — static Svelte SPA + hls.js player; follows room `sync` messages.
- **Extension** — MV3 content script that finds the page's `<video>` and syncs its clock
  (needed because the same-origin policy blocks a page from scripting a cross-origin player).

See ARCHITECTURE.md for the protocol, the single-clock rule, and the drift algorithm.

## Scope guardrails (do not cross)

This repo builds **content-neutral control-sync infrastructure**. The hard lines that stay are:

- **No DRM circumvention** of any kind.
- **No rehosting / relay** — never route or transcode video bytes through a server. Each viewer
  loads the source **first-party** from their own browser; we only move the URL + the clock.
- **No header/CORS/referer forging** — never rewrite `Referer`/`Origin` or inject CORS headers to
  defeat a site's hotlink/access controls. A source that 403s without its origin's referer just
  won't load (we surface that), and that's fine.

The picker MAY surface URLs already present in a page's DOM (an `<iframe>` src, a `<video>` src,
or a `<video><source>` stream URL) and hand the chosen one to the room, where each viewer loads it
first-party — same as the user copy-pasting it themselves. That's the project owner's call; it is
**not** rehosting or forging, which remain forbidden. The design still assumes **every viewer can
already access the source they sync**.

## Conventions

- Keep the sync protocol small and JSON; document any new message type in ARCHITECTURE.md.
- Drift correction uses a **dead-zone**: the content script hard-seeks only when the video is
  off by more than `SEEK_DEADZONE = 1.0s` (`extension/lib/videoHook.ts`). Real embed players
  wander a few hundred ms while buffering; the old 0.5s threshold yanked the video every 3s
  heartbeat (visible jitter). `DRIFT_THRESHOLD = 0.5s` remains the "in sync" notion / echo
  tolerance. Don't tighten the dead-zone without testing on a real embed.
- Prefer the cheapest hosting path that fits (free tiers first).
- Update the relevant doc in the same change when behavior changes.

## Status

🛠️ Phases 1–3 built **and browser-verified** on real embeds (streamimdb, YouTube): control-sync
works via both our control bar and the embed's native player; custom subtitles (upload + online
search) render, restyle, and time-shift. Server side also has automated checks: `pnpm test:sync`
→ 23/23; subtitle proxy `packages/server/test/subs-smoke.mjs` (live OpenSubtitles+SubDL); `vtt.test.mts`.
All four packages typecheck + build (Chromium + Firefox); Biome clean.

The **video/iframe picker** is **built**: an extension popup (toolbar button) scans the active tab
across all frames for `<video>`/`<iframe>` sources, discovers open room tabs (pings content scripts;
the room page tags `<html>` with `data-sixseven-room`), and delivers the chosen URL to the room page
(content script → `window.postMessage` → page re-validates → `setSource`). Manual paste box too.
Shared types in `@sixseven/protocol/picker`; popup + scan in `packages/extension` (`entrypoints/popup`,
`lib/picker.ts`); needs the `scripting` permission. See ARCHITECTURE "Source picker". Typechecks +
builds (Chromium + Firefox); **pending the live real-embed verification run**.

The **standalone paste-a-URL / HLS player** (Phase 4) is **built**: a source carries a `srcKind`
(`embed` | `direct`). `direct` URLs (HLS `.m3u8` / video files) play in the room page's own
same-origin `<video>` via `web/src/lib/webPlayer.ts` (`WebPlayer` — same drift/dead-zone/echo/gate
logic as the extension's `VideoHook`) + `DirectPlayer.svelte` with **lazy-loaded hls.js**. **No
extension needed** for direct sources. Kind is auto-detected by extension (`classifySource`) or
forced via the source picker's mode dropdown (auto/embed/direct). It's content-neutral playback of
a user-supplied URL — **not** stream extraction or header/referer forging (§3 holds): a token/referer-
locked stream that 403s just won't load, and we say so. See ARCHITECTURE §4 "Source kinds".

**Sync model (unified across direct + embed, see ARCHITECTURE §4 + the `sync.force` flag):** the
server tags each `sync` as a real **command** (`force:true` — play/pause/seek/setSource) vs a routine
**heartbeat/presence tick** (`force:false`). Commands snap; on a tick a **solo** viewer is left alone
and a **multi** viewer glides back via a small `playbackRate` slew (hard-seek only for a >3s desync) —
this killed the periodic black-screen jitter. The direct player (`WebPlayer`) is **one-way**; the
embed player (`VideoHook`) only reports a native play/pause/seek when it follows a **user gesture** in
that frame (so a buffering pause / the embed's internal seeks don't loop back as commands). (Re)join
and resync are `force:false` so a brief reconnect glides instead of snapping. Buffer gate is skipped
for solo rooms; ghost members are pruned on start/join. `?hud` on the room URL shows
currentTime/server-time/drift (works for both direct and embed). Verified smooth solo + 2-device,
direct + embed.

**Deploy:** see [docs/DEPLOY.md](docs/DEPLOY.md). Server → `npx partykit deploy` (Cloudflare DO, free);
room page → Cloudflare Pages with `VITE_PARTYKIT_HOST` baked in (`public/_redirects` gives the SPA
fallback for `/r/<room>`); extension → load unpacked or publish. In dev, the web talks to its own
origin and Vite proxies `/parties` to the local server, so one tunnel serves both for cross-device tests.

**UI/UX (M1+M2) — built:** the room page is a proper player surface: a top bar (room name +
Invite/Subtitles/Source/mode/sidebar buttons), a full-bleed `.player-area`, popover Source/Subtitle
panels, a custom video control bar **for the direct player only** (embeds keep their native bar +
our subtitle overlay), and a collapsible right sidebar (Members + Activity). Icons are unified on
**Lucide** across both surfaces — `lucide-svelte` in the web, hand-inlined matching SVG paths in the
extension popup (`entrypoints/popup/icons.ts`). **Room creation (M2):** a `CreateRoom` landing page
(shown when the URL has no room) takes nickname + room name + control mode; it mints a capability
secret, `history.pushState`es to `/r/<name>#k=<secret>` (no reload), and joins. Control mode is
**picked at creation** — carried on the creator's `join` as `mode?` (honoured only on the
room-creating join → creator is host) — and still flips live via the top-bar toggle (`setMode`) and
`passControl` (host handoff). The Invite button copies the capability URL.

**Own-tab watch party (§11) — built:** an extension-native party with **no web room page** — start
on any tab (popup → "Watch together"), share a short **room code** (no invite links), join via the
popup. The connection lives in the **source tab's content script** (it's the member); the room page
is optional. A draggable, edge-magnetic, hideable Shadow-DOM widget carries members/chat/subs/leave;
reuses `VideoHook`/the frame bridge/gate. Subtitles work in own-tab too (upload + online search +
embedded-track picker for top-frame video + full personal style). `srcKind:"site"`; `lib/ownTab.ts`,
`lib/partyWidget.ts`, `lib/roomSocket.ts`, `lib/config.ts`.

**YouTube (§13) — built:** `srcKind:"youtube"` driven on the room page via the **IFrame Player API**
(no extension). Native YT controls + muted autoplay ("tap to unmute") + bidirectional sync.
`lib/ytPlayer.ts`, `components/YouTubePlayer.svelte`.

**Subtitles — expanded:** directed online search (title + season/episode, sorted by downloads),
numeric offset input, embedded-track picker (the source's *own* caption tracks, listed under "From
this site"). The content script reads `<video>.textTracks` in the engaged frame **at any depth** —
nested-iframe embeds included — reports them up the bridge (`tracks`), and `selectTrack` routes back
down so the frame reads the chosen track's cues into our overlay (offset/style apply), native
fallback when cues aren't CORS-readable. Same `SubtitleController`/panel as upload + online search,
mutually exclusive with them. Works for `embed` + own-tab `site` (over the bridge) **and** the
same-origin direct `WebPlayer` (which reads its own `<video>.textTracks` directly — no bridge —
via the controller's `directTracks` hook). Only YouTube lacks a "From this site" list. Parser
shared at `@sixseven/protocol/subtitles`.

**Onboarding — built:** guided empty room (pick-a-source / invite / waiting-for-host), live
extension-presence notice on create/join (`components/ExtensionNotice.svelte`, install link in
`lib/links.ts`), solo-invite nudge, "how it works", live source-kind detection.

**Fun layer (§12) — built:** ephemeral `say`/`event` broadcast → emoji reactions (float), chat
(sidebar/widget + bubbles), GIFs via a GIPHY proxy (`gif.search` op, `GIPHY_API_KEY` in `room.env`)
with per-browser favorites (tag-filterable), and per-viewer display settings (per-type on/off +
Linger speed). Room launcher is in the top bar (off the video). `components/{Reactions,Chat,GifPicker}.svelte`,
`extension/lib/reactionLayer.ts`, `server/src/gif.ts`.

**Playlist (§14) — built:** a per-room queue (Source panel: `+ Queue`, an "Up next" list with
drag-to-reorder, play/remove/clear) with auto-advance when a video ends (players' `onEnded` / a new
`ended` bridge msg) and a room-level autoplay toggle. The picker can add to the queue too. Server:
`queue`/`currentId`/`autoplay`, control-mode gated. Room-page modes only; own-tab ignores it.

**Video call (§17) — built (room page + own-tab), pending live test:** optional 1:1 webcam/mic between
viewers (for groups not on Discord). **Peer-to-peer media — never through the server** (§2): the DO
only relays SDP/ICE text. **Asymmetric:** `setCall {on}` flips `Member.inCall` (capped at `CALL_CAP=2`,
over-cap → `error {code:"call_full"}`) = "join to watch"; turning the camera on is a separate
`enableCamera()`+`setCam {on}` (display hint). So one can broadcast while the other just watches —
STUN-only unaffected. `rtcSignal {to/from,data}` relays signals to one peer. Core in
`web/src/lib/call.ts` (`CallManager`, perfect-negotiation, renegotiates when a camera turns on; ICE via the member-gated `rtc.iceServers` op (`server/src/rtc.ts`): Cloudflare STUN always
(free); TURN only if `TURN_KEY_ID`+`TURN_KEY_API_TOKEN` are set (Cloudflare Realtime TURN, free ≤1000
GB/mo, creds minted server-side) → STUN-only otherwise. **Two surfaces, same `CallManager` (duplicated
in `web/src/lib/call.ts` + `extension/lib/call.ts` — protocol is DOM-free so can't host it):** the
**room page** (`components/VideoCall.svelte` + top-bar **Call** button; a **draggable + resizable**
corner dock), and **own-tab** (signaling over `RoomSocket`; tiles in a **separate draggable floating
window** `.call-float`, and the widget panel's sections are an **accordion** — one open at a time —
so it's not bloated; tiles managed imperatively so re-render never reloads them). Caveat for own-tab:
a content script's `getUserMedia` is subject to the host page's `Permissions-Policy camera`, so a
locked-down site (maybe Netflix) can block it — we surface a clear "site may block it" error.

**Popup room launcher — built:** the popup's first tab is now **Room** (second = "Watch on this page").
The Room tab *creates* "our room" from the extension: **＋ New empty room**, or pick a scanned video /
paste a URL → **new room** (opens the deployed web room at `/r/<name>?src=…&kind=…#k=<secret>`; the page
applies `?src` once the creator joins, then strips the query — see `session.ts`/App effect). A **Send to
an open room instead** checkbox (shown only when a room tab is open) keeps the old deliver-to-open-room
flow. Web base URL = `WEB_APP_URL` in `extension/lib/config.ts`.

**Next up (idea list):** audio-only sources (YouTube Music etc. → "Spotify jam").

**Deploy reminder:** new server features (own-tab `observer`, fun-layer `say`/`gif`, M2 mode, subtitle
ordering, video-call `setCam`/`rtcSignal`/`rtc.iceServers`) only work once `npx partykit deploy` +
`env push` are run — the extension always talks to the deployed server, and the deployed web is a static
build (redeploy via `wrangler pages deploy`). The video call works STUN-only with no env; TURN turns on
once `TURN_KEY_ID`+`TURN_KEY_API_TOKEN` are in `.env` and `env push`ed.

**Known caveats:** YouTube/own-tab need a user gesture per viewer for *sound* (autoplay policy;
muted autostart works); anti-devtools / sandboxed-iframe sites may not be hookable (we don't fight
them — §3). A `DEBUG_HUD` flag in `extension/lib/subtitleLayer.ts` toggles an on-screen subtitle readout (off).

**Gotcha for contributors:** never pass a Svelte `$state` value straight to `postMessage` — proxies
aren't structured-cloneable and silently throw. Send `$state.snapshot(...)` (see `subtitleController`).

## Repo layout

pnpm monorepo (`packages/*`):
- **protocol** — shared TS wire types; the one source of truth for the sync protocol. Main
  entry = server↔client messages; `./bridge` subpath = room-page↔iframe postMessage messages.
  Server, web, and extension all import it.
- **server** — PartyKit Durable Object (one per room): authoritative state, single clock,
  control-mode enforcement, buffer gate, heartbeat. Verified by `test/sync-client.mjs`.
- **web** — Svelte 5 + Vite static SPA. **Owns the WebSocket** and room state; relays each
  `sync`/`gate` into the embed iframe via the bridge; renders overlay controls, presence, log.
- **extension** — WXT MV3 content script (`all_frames`). The only code that touches the embed's
  `<video>`: runs drift-correction (SPEC §4), reports `status`, re-hooks on `<video>` swap,
  draws the in-iframe takeover overlay **and the personal subtitle layer**. Talks to the room
  page over `window.postMessage`.

The DO also hosts a **member-gated subtitle proxy** (`onRequest`, `src/subtitles/`): OpenSubtitles
+ SubDL behind one interface, normalized to WebVTT, keys in `room.env` (never on the client). This
is control-plane text, not video — see SPEC §2 ("no server in the *video path*"), §13.

Architecture decision: **the room page owns the WS**, not a background service worker (SPEC §6
allowed either). Stack: pnpm · TS (strict) · PartyKit · Svelte (Vite SPA) · WXT (MV3) · Biome
(TS/JS) + Prettier (`.svelte`).

## Build/run commands

```bash
pnpm install            # bootstrap the workspace
pnpm dev:server         # PartyKit backend (:1999). Loads packages/server/.env via --with-env
pnpm test:sync          # throwaway 2-client sync test (needs dev:server running) → 23/23
node packages/server/test/subs-smoke.mjs "Inception"      # live subtitle-proxy test (needs dev:server)
node --experimental-strip-types packages/server/test/vtt.test.mts  # SRT→VTT unit test
pnpm --filter @sixseven/web dev          # room page dev server (Vite)
pnpm --filter @sixseven/extension dev    # extension dev (Chromium); :firefox for FF
pnpm --filter @sixseven/extension build  # → .output/chrome-mv3 (load unpacked)
pnpm typecheck          # across all packages (svelte-check for web)
pnpm lint               # biome check (TS/JS); pnpm format also runs prettier on .svelte
```

**Secrets:** `packages/server/.env` (gitignored) holds the OpenSubtitles + SubDL keys; PartyKit
dev loads it via `--with-env` (already in the `dev` script). For deploy: `npx partykit env push`.
Never commit keys; `.env.example` documents the vars.

To try the MVP locally: `pnpm dev:server` + `pnpm --filter @sixseven/web dev`, build & load the
extension unpacked, then open the printed URL as `/r/<room>#k=<secret>` in two browsers.
