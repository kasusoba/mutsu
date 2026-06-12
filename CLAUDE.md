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

This repo builds **content-neutral control-sync infrastructure**. Do **not** add:

- DRM circumvention of any kind.
- Stream **extraction/rehosting** — pulling a stream URL out of a page to rebroadcast one
  source to people who can't access it themselves.
- **Header/CORS forging** — rewriting `Referer`/`Origin` or injecting CORS headers to defeat
  a site's hotlink/access controls.

The design assumes **every viewer can already access the source they sync**. The extension
reads a `<video>` element's clock; it does not rip, relay, or unlock anything. Keep new code
on that side of the line.

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

The direct player is **one-way** (`web/src/lib/webPlayer.ts`): it enforces server truth on our
`<video>` but never reads its media events back as `control` (no localControl), so there's no
video→server→video echo loop. Direct-source **control is UI-only** (the control bar + click-to-toggle
on the video). It renders its **own subtitle overlay** in `DirectPlayer.svelte` from
`SubtitleController` (no bridge). `?hud` on the room URL shows currentTime/server-time/drift.

**Next up:** Phase 4 remainder (frame-forbidding own-tab fallback, YouTube iframe API), embedded-track subs.
Embed-source subtitles still render via the in-iframe layer (bridge). The embed path keeps localControl
(needed for the per-viewer autoplay gesture on cross-origin players) — if embed jitter persists, that's
the place to look next.

**Known caveats:** YouTube needs a user gesture per viewer before it'll play (autoplay policy);
anti-devtools / sandboxed-iframe sites may not be hookable (we don't fight them — §3). A
`DEBUG_HUD` flag in `extension/lib/subtitleLayer.ts` toggles an on-screen subtitle readout (off).

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
