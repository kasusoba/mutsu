<div align="center">

<img src="packages/web/public/android-chrome-512x512.png" alt="sixseven logo" width="120" height="120" />

# sixseven

**Watch video in sync with friends while you hang out in Discord voice.**

</div>

A self-hosted watch-party tool. No virtual browser, no screen-sharing, no re-encoding — just a
tiny sync server, a web player, and a browser extension that keeps everyone's playback clock
aligned. Runs on free hosting and feels instant.

> **Core idea:** move the *URL and the clock*, never the video bytes. Every viewer plays their
> own stream locally; the server only broadcasts `play` / `pause` / `seek`.

## How it works

- **Sync server** — a WebSocket relay (PartyKit Durable Object, one per room) holding per-room
  state (`{src, paused, time, rate, mode, hostId}`), with the server's own clock as the single
  source of truth for drift correction. No video bytes pass through it.
- **Room page** — a static Svelte SPA. It owns the WebSocket and follows room state. Direct
  sources (HLS / files) play in its own hls.js `<video>`; embeds are bridged via the extension.
- **Extension** — an MV3 content script that finds the `<video>` on whatever page each person
  opens and syncs its timeline. Needed because the same-origin policy blocks a normal page from
  reaching into a cross-origin player; an extension can.

## What it syncs

- **Embeds** — framable streaming pages/providers, hooked by the extension.
- **Direct** — HLS `.m3u8` streams or `.mp4`/`.webm` files, played in the room page (no extension).
- **YouTube** — via the YouTube IFrame Player API.
- **Own-tab** — start a party in place on a site that won't embed; friends join with a room code.

Plus: a source picker (extension popup), personal subtitles (upload / online search / the
source's own caption tracks, restyled and time-shifted per viewer), a shared queue with
auto-advance, reactions/chat/GIFs, presence + activity log, open/host control modes, and a
buffer gate that waits for whoever is still loading.

## Quick start

```bash
pnpm install
pnpm dev:server                          # sync backend (:1999)
pnpm --filter @sixseven/web dev          # room page
pnpm --filter @sixseven/extension build  # then load .output/chrome-mv3 unpacked
```

Open the printed room URL (`/r/<room>#k=<secret>`) in two browsers to watch it sync. Hosting on
free Cloudflare tiers → [docs/DEPLOY.md](docs/DEPLOY.md). Extension specifics →
[packages/extension/README.md](packages/extension/README.md).

## Docs

| Doc | What's in it |
|---|---|
| **[docs/SPEC.md](docs/SPEC.md)** | **Canonical consolidated spec — start here. Wins over other docs on conflict.** |
| [docs/PRD.md](docs/PRD.md) | Product requirements — problem, users, scope, features, flows |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technical design — components, sync protocol, drift correction, hosting |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Build phases and milestones |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Deploy the server (PartyKit), room page (Cloudflare Pages), and extension |
| [CLAUDE.md](CLAUDE.md) | Guidance for Claude Code working in this repo |

## Non-goals

This is a control-sync tool: it aligns playback of sources each viewer can already access. It
does **not** bypass DRM, rip/rehost protected streams, or forge headers to defeat a site's
access controls. If a source won't load for you on its own, sixseven won't make it. See
[ARCHITECTURE.md → Non-goals](docs/ARCHITECTURE.md#non-goals).
