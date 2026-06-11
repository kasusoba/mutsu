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
- Drift `THRESHOLD = 0.5s`; don't seek under it (avoids stutter).
- Prefer the cheapest hosting path that fits (free tiers first).
- Update the relevant doc in the same change when behavior changes.

## Status

📐 Planning — docs only, no code yet. Start at Roadmap Phase 0 (decisions).

## Build/run commands

_TBD — none yet. Will be added when Phase 1 lands._
