# mutsu — Product Requirements

## 1. Problem

Watching something together remotely is harder than it should be. The existing options
each have a real downside:

- **Native group-watch** (Disney+ GroupWatch, Prime Watch Party) — locked to one platform's
  catalog.
- **Screen-sharing** (Discord) — bad quality, high latency, ties up the sharer's machine,
  drains their CPU/upload.
- **Server-relay / virtual-browser tools** — expensive to host (a VM per room), laggy.

What's missing for a small friend group is a **lightweight, self-hosted** tool that keeps
everyone's playback in sync without re-encoding or relaying video, and works across many
kinds of sources.

## 2. Target users

- **Primary:** the host (you) + a small group of friends (≈2–10 people) already together in
  a **Discord voice channel** for audio/chat. mutsu only handles **video sync**, not
  voice or text chat — Discord covers that.
- **Technical comfort:** host is comfortable self-hosting (running a small server, loading an
  unpacked extension). Friends can install a browser extension and click a link.

## 3. Goals

1. **Frame-loose, second-tight sync** — everyone within ~0.5s of each other; corrects drift
   automatically.
2. **Cheap to run** — free/near-free hosting for the sync server (no video passes through it).
3. **Low friction to join** — share a room link; install the extension once.
4. **Broad source support** via control-sync (see matrix below).
5. **Self-hostable** — the host runs the whole thing; no dependency on a third-party SaaS.

## 4. Non-goals

- ❌ No voice/text chat (Discord handles it).
- ❌ No virtual browser, no server-side screen capture.
- ❌ No DRM circumvention.
- ❌ No stream extraction/rehosting or header-forging to bypass site access controls.
- ❌ Not built for large public audiences / streamer-scale broadcast (small private rooms).

## 5. Core concept — control-sync

Nobody relays the video. **Each viewer independently loads the same source in their own
browser**, and the server broadcasts only **control events** (`play`, `pause`, `seek to T`).
Each client applies them locally so all timelines stay aligned.

Consequences:
- The server stays tiny and cheap (it's a glorified chatroom).
- DRM stays intact (each browser does its own licensed decryption) — but can't be *hosted*.
- Each viewer must be able to access the source themselves.

## 6. Source support matrix

| Source | Supported | Mechanism |
|---|---|---|
| Direct file (`.mp4`/`.webm`) | ✅ | player loads URL, control-sync |
| HLS / DASH (no DRM) | ✅ | hls.js / dash.js, control-sync |
| YouTube / Vimeo | ✅ (later) | embed their iframe player, sync via player API |
| A file the host owns | ✅ (Phase 5) | P2P (WebTorrent) seed to room, control-sync |
| Legal / web-seed magnet | ✅ (Phase 5) | browser WebTorrent, control-sync |
| Arbitrary magnet | ❌ out of scope | would need a 2nd always-on server; revisit later |
| Arbitrary site with `<video>` | ✅ | extension hooks the element, control-sync |
| Netflix/Disney+/etc. (DRM) | ⚠️ sync-only | each viewer uses own login; extension syncs native player; **cannot be hosted/relayed** |

## 7. Key feature list

### MVP — the room page + embedded source (Phase 1–2)
Everyone gathers on a free hosted **room page**; the shared source is **embedded as an
`<iframe>`**; the extension bridges into the iframe to sync + overlay.
- **Pick a source:** host clicks "share" on an embed page (extension grabs the URL) or pastes
  a source URL. Detection lists the page's `<video>`s (default to main/playing).
- **Gather:** share the room link (capability-URL secret) in Discord → everyone opens the
  **room page**, which embeds the source in an iframe (each loads it first-party).
- **Extension bridges** into the cross-origin iframe to hook the `<video>` and render the
  **clean overlay** (full takeover + escape hatch) over it.
- **Synced transport:** play, pause, seek propagate to everyone; **0.5s drift correction**;
  **late-joiner** lands at the current position.
- **Control modes:** per-room toggle, **open** (anyone) / **host** (controller + pass-control).
- **Buffer gate:** soft-pause on any stall; 25s skip valve.
- **Presence + activity log** panel in the overlay.

### Fast-follow (Phase 3)
- **Custom subtitle overlay** on ANY source (offset / position / style); sources: upload,
  embedded tracks, online search.

### Later
- Secondary standalone **web player** (paste-a-URL / HLS) as a no-extension fallback path.
- YouTube/Vimeo via their iframe player APIs.
- Host local-file sharing via **WebTorrent** (P2P, web-seed-compatible).
- Room niceties: end-of-video "pick next" prompt, richer presence.

## 8. Primary user flow (MVP)

1. Host opens mutsu, creates room `movie-night` → gets a share link.
2. Host pastes a source URL (or, Phase 3, opens a page and clicks "sync this video").
3. Friends open the link (and have the extension installed for Phase 3 sources).
4. Host hits play → everyone plays. Someone seeks → everyone seeks.
5. A friend's connection hiccups and drifts → client auto-resyncs within a few seconds.

## 9. Success criteria

- Two+ browsers stay within 0.5s across play/pause/seek and over a 30-min session.
- Late joiner is in sync within ~2s of opening the link.
- Sync server runs comfortably on a free tier for a 10-person room.
- A friend can go from "click link" to "watching in sync" in under 2 minutes.
