# sixseven

A self-hosted **watch-party** tool: watch video in perfect sync with friends while you
hang out in Discord voice. No virtual browser, no screen-sharing, no re-encoding —
just a tiny sync server, a web player, and a browser extension that keeps everyone's
playback clock aligned.

> **Core idea:** move the *URL and the clock*, never the video bytes. Every viewer plays
> their own stream locally; the server only broadcasts `play` / `pause` / `seek`. That's
> why it runs on a free tier and feels instant.

## Docs

| Doc | What's in it |
|---|---|
| **[docs/SPEC.md](docs/SPEC.md)** | **Canonical consolidated spec — start here. Wins over other docs on conflict.** |
| [docs/PRD.md](docs/PRD.md) | Product requirements — problem, users, scope, features, flows |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technical design — components, sync protocol, drift correction, hosting |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Build phases and milestones |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Deploy the server (PartyKit), room page (Cloudflare Pages), and extension |
| [CLAUDE.md](CLAUDE.md) | Guidance for Claude Code working in this repo |

## Status

🛠️ **Working.** Control-sync is smooth across **solo + multi-viewer** and both source types:
**embed** (framable pages/providers, hooked by the extension) and **direct** (HLS `.m3u8` / video
files, played in the room page's own hls.js `<video>` — no extension needed). Plus the source picker
(extension popup), personal subtitles (upload + online search), presence, activity log, control
modes, and the buffer gate. Four packages typecheck + build (Chromium + Firefox); `pnpm test:sync` →
23/23. Deploy guide in [docs/DEPLOY.md](docs/DEPLOY.md).

**Next:** own-tab sync for sites that refuse to embed; YouTube iframe API; embedded-track subtitles.

## TL;DR of the design

- **Sync server** — a WebSocket relay holding per-room state (`{src, paused, time}`),
  with the server's own clock as the single source of truth for drift correction.
- **Frontend** — a static web player (hls.js) that joins a room and follows room state.
- **Extension** — a content script that finds the `<video>` on whatever page each person
  opens and syncs its timeline through the server. Required because the same-origin policy
  blocks a normal page from reaching into a cross-origin player; an extension can.

## Explicit non-goals

This is a **control-sync** tool (align playback of sources each viewer can already access).
It does **not** bypass DRM, rip/rehost protected streams, or forge headers to defeat a
site's access controls. See [ARCHITECTURE.md → Non-goals](docs/ARCHITECTURE.md#non-goals).
