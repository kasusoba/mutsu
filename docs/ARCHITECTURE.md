# sixseven — Architecture

## 1. Components

```
┌─────────────┐     WebSocket      ┌──────────────────────────┐
│  Browser A  │◄──────────────────►│      Sync Server         │
│  (player /  │                    │  - rooms: { state }      │
│  extension) │     control msgs   │  - single authoritative  │
└─────────────┘                    │    clock (drift source)  │
┌─────────────┐                    │  - broadcasts to room    │
│  Browser B  │◄──────────────────►│                          │
└─────────────┘                    └──────────────────────────┘
       ▲
       │ each browser fetches its OWN video bytes directly from the source CDN.
       │ NO video ever passes through the sync server.
       ▼
┌──────────────────┐
│  Source CDN /     │
│  file / YouTube   │
└──────────────────┘
```

Three deliverables:

1. **Sync server** — WebSocket relay + per-room state. The only always-on backend.
2. **Frontend** — static web app: room UI + video player (hls.js).
3. **Extension** — content script for syncing the `<video>` on arbitrary pages.

## 2. Why the server stays tiny (and cheap)

The server moves **control messages** (a few hundred bytes, a few times per session) and
**periodic sync ticks** (small). It never touches video bytes. So:

- No bandwidth cost for media, no transcoding, no per-room VM.
- Fits a free tier (Cloudflare Durable Objects / PartyKit, or a small Node `ws` server).

## 3. Sync server

**Implementation: PartyKit (Cloudflare Durable Objects).** Each room is one Durable Object
instance holding the state below; the DO broadcasts to its connected sockets. Free tier,
auto-scaling, nothing to babysit. Deploy with `npx partykit deploy`.

### State (per room)
```
Room {
  src:        string | null   // current source URL / descriptor
  paused:     boolean
  time:       number          // playback position in seconds, as of `updatedAt`
  rate:       number          // playback rate (default 1)
  updatedAt:  number          // SERVER clock (ms) when state was last set
  mode:       'open' | 'host'  // who may control (see Control modes below)
  hostId:     string | null    // current controller when mode === 'host'
  members:    Map<id, {name}>
}
```

### Control modes (both supported, per-room toggle)
- **`open`** (default — chill mode): any member's `control` message is accepted and
  broadcast. No roles. Best for a trusting friend group.
- **`host`**: only `hostId`'s `control` messages are accepted; others are ignored (their
  local player still follows `sync`). The host can hand off with `passControl`.
- The mode is a room setting and can be flipped live via `setMode`. The server enforces
  acceptance — a `control` from a non-host in `host` mode is dropped server-side.

### The single-clock rule (this is the important design decision)

Drift correction is hard if clients project playback time using their own wall clocks
(client clocks disagree). **Solution: all projection happens on the server, using one clock.**

- When a client acts, it sends its raw `video.currentTime`. The server stamps
  `updatedAt = serverNow()` and stores it.
- When the server needs to tell clients where playback *should be now*, it computes:
  ```
  projected = paused ? time : time + (serverNow() - updatedAt) / 1000
  ```
  and sends `{ paused, time: projected }`. Because the message arrives ~instantly,
  the client treats `time` as "where you should be right now."
- Clients never do cross-clock math. They just obey `sync` messages.

### Protocol (WebSocket JSON messages)

Client → server:
| type | payload | meaning |
|---|---|---|
| `join` | `{ room, name }` | join a room; server replies with a `sync` |
| `setSource` | `{ src }` | change the room's source; resets time to 0 |
| `control` | `{ paused, time }` | user played/paused/seeked locally (accepted per control mode) |
| `setMode` | `{ mode }` | switch room between `open` and `host` |
| `passControl` | `{ toId }` | (host mode) hand control to another member |

Server → client:
| type | payload | meaning |
|---|---|---|
| `sync` | `{ src, paused, time, rate, mode, hostId }` | authoritative state; apply it |
| `members` | `{ list }` | who's in the room (id, name, isHost) |

**Control acceptance rule (server-enforced):** a `control` is applied iff
`room.mode === 'open'` OR `senderId === room.hostId`. Otherwise it's dropped and the sender
gets a fresh `sync` to snap back into line.

### Sync cadence
- On `join` → immediate `sync`.
- On any `control` / `setSource` → immediate `sync` broadcast to the room.
- While a room is playing → server broadcasts a `sync` tick every **3s** (heartbeat) so
  slow drift gets corrected without anyone touching the controls.

## 4. Client drift-correction algorithm

On receiving a `sync { paused, time, rate }`:
```
if (video.src !== expected) load the new source
video.playbackRate = rate
if (Math.abs(video.currentTime - time) > THRESHOLD)   // THRESHOLD = 0.5s
    video.currentTime = time
if (paused) video.pause() else video.play()
```
- `THRESHOLD` prevents constant micro-seeking (which causes stutter).
- Local user actions (the user clicks play/seek) emit a `control` message; they are NOT
  echoed back to the actor as a correction unless drift exceeds threshold.
- A manual **"resync"** button forces `currentTime = time` for the "I fell behind" case.

## 5. Frontend

- Static SPA built with **Svelte** (reactive room state, small bundle).
- Player: **hls.js** feeding a `<video>` for HLS; native `<video src>` for direct files.
- Connects to the sync server over WebSocket; renders room state; wires the player's
  `play`/`pause`/`seeked` events to `control` messages.
- Hostable free on Cloudflare Pages / Vercel / Netlify / GitHub Pages.

## 6. Extension (control-sync)

### Why it's needed: the same-origin policy
A normal page **cannot** reach into a cross-origin `<iframe>` (can't read a player's
`currentTime`, can't call `.play()`). A **browser extension** can inject a **content
script** into any page/frame via host permissions. So the extension is the bridge that the
same-origin policy otherwise blocks.

### What it does (and only this)
1. Inject a content script into the page (and its frames).
2. **Find the `<video>` element.**
3. **Report** its timeline (`play`/`pause`/`seeked` + `currentTime`) to the room.
4. **Apply** incoming `sync` messages to that element (set `currentTime`, play/pause).

That's **control-sync**: the source loads first-party in each viewer's browser (in the MVP,
inside the room page's `<iframe>` — see §10.7), and the extension only aligns the clock.

### Why everyone needs it
Each viewer's own browser must host the injector to (a) reach the **cross-origin iframe's**
`<video>` (the same-origin policy blocks the room page itself from doing it) and (b)
participate in sync. The extension just needs to be **installed and enabled**.

### MV3 notes
- `content_scripts` / programmatic injection with `host_permissions`.
- A background service worker holds the WebSocket connection to the sync server.
- `all_frames: true` so it can reach players inside iframes.

## 7. Hosting & cost

> **Static page ≠ server.** The room page is a *static* build (HTML/JS/CSS) on free hosting —
> nothing always-on, no video relayed through it. The only thing that costs real money is an
> always-on server transcoding/relaying video, which this design deliberately avoids.

| Piece | Option | Cost |
|---|---|---|
| Room page (static) | Cloudflare Pages / Netlify / GitHub Pages | $0 |
| Sync server | Cloudflare Durable Objects / PartyKit | $0 (free tier) |
| Sync server (alt) | Fly.io / Railway / Render free tier, or Hetzner VPS | $0–6/mo |
| Domain | optional (free `*.pages.dev` works) | $0 or ~$10/yr |
| Extension | load unpacked / publish | $0 / one-time $5 |

**MVP total: $0.**

### Cost traps (intentionally excluded)
- Virtual browser (VM per room) — expensive. Not built.
- Server-side media proxy / relay — costs bandwidth. Avoided (clients fetch their own bytes).
- TURN server — only if P2P file sharing is added later; relays cost bandwidth.

## 8. Non-goals

sixseven is **content-neutral control-sync infrastructure**. It is explicitly **not**:

- **A DRM bypass.** DRM is real cryptography (Widevine/PlayReady/FairPlay + licensed CDM).
  No part of this defeats it. DRM content can be *synced* (each viewer's own licensed
  playback) but never *hosted/relayed*.
- **A stream ripper / rehoster.** The extension reads a `<video>` element's clock to sync
  it; it does not extract stream URLs to rebroadcast a single source to people who can't
  access it themselves.
- **A header/CORS forger.** It does not rewrite `Referer`/`Origin` or inject CORS headers to
  defeat a site's hotlink/access protections.

The design assumption throughout: **every viewer can already access the source they're
syncing.** sixseven only aligns the clock.

## 9. Decisions

**Resolved (Phase 0):**
- **Sync server:** PartyKit / Cloudflare Durable Objects (one DO per room).
- **Frontend:** Svelte.
- **Control model:** per-room `mode` toggle (`open` = anyone controls; `host` = designated
  host + `passControl`). Default `open`.

**Resolved (Phase 0.5 — see §10 for full specs):**
- **MVP shape:** a **hosted room page** (free static, Cloudflare Pages) where everyone gathers;
  the shared source is **embedded as an `<iframe>`**; the extension bridges into the iframe to
  sync + overlay. Backend = free PartyKit room. (A "static page" is free; only a video-relaying
  server costs money — we have none.)
- **Gathering model:** room page + embedded source (Twoseven "media in the room" feel) — NOT
  the synclify "everyone on the same site, controls only" model.
- **Join:** link-based — the share link opens the room page; secret in fragment.
- **Overlay:** full takeover + escape hatch ("show site" toggle for server-switch/captcha/login).
- **Room UI:** in the room-page overlay.
- **Media detection:** smart default (main/playing video) + picker of all detected.
- **Embed watch-party:** supported by **embedding** the source iframe (each viewer loads it
  first-party; we sync the clock). Works for frame-allowing sources (embed providers, YouTube);
  no header-stripping for frame-forbidding sites.
- **Devices:** desktop-only crew → extension feature set fully in scope.
- **Room auth:** locked-by-default capability URL (secret in URL fragment); open toggle;
  reset-link to re-lock.
- **Buffer gate:** single unified stall gate (personal buffering, no separate system
  pre-buffer); 25s grace then skippable; no tab-out opt-out.
- **Host disconnect:** auto-promote longest-connected member; else fall back to `open`.
- **Source picking:** follows control mode (open = anyone; host = host only).
- **Activity log:** server-side log of meaningful events, shown in a sidebar.
- **Subtitles:** personal offset / position / style — on our-player sources only.
- **Identity:** nickname only, remembered in localStorage.
- **Torrents:** out of scope.
- **Playlist:** one source at a time.

**Still open (see open-questions tracker in conversation):**
- Where subtitle files come from (upload / embedded / online search).
- Extension distribution (publish vs. unpacked) and target browsers.
- Activity-log persistence; room reuse across sessions.

## 10. Detailed feature specs (resolved)

### 10.1 Room auth (capability URL)
- Room ID lives in the path: `/r/<name>`. Secret lives in the **fragment**: `#k=<secret>`.
- Fragment is chosen deliberately: it is **never sent in HTTP requests / never logged**; the
  client reads it and passes it to the server only over the (encrypted) WebSocket.
- On create: server generates a random secret, stores `{name, secret, open:false}` in the DO.
- On join: client sends `join {room, secret, nickname}`; server admits iff `open` or
  `secret` matches.
- **Open toggle:** flips `open=true`, secret check skipped (anyone with the name joins).
- **Reset link:** regenerate the secret → all old links instantly invalid (soft "kick all").

### 10.2 Buffer gate (ready-gating) — the single unified gate
Distinguish **intent** from **effect**:
```
intent     = playing | paused(hard)        // what a human chose
gate open  = stalled set is empty          // is everyone ready?
effective  = (intent == playing) AND gate  // what actually plays
```
- Each client reports `waiting` → add self to `stalled`; `playing`/`canplay` → remove self.
- While `intent == playing` and `stalled` non-empty → broadcast **soft pause** (distinct from
  a human **hard pause**, so neither stomps the other).
- When `stalled` empties → auto-resume from the paused position.
- **No separate "initial pre-buffer" system** — the start trips this same gate. Buffering is
  personal/per-browser.
- **Skip valve:** if a member is stalled > **25s**, a `Continue without <name>` action appears
  (permission = same as control: open→anyone, host→host). On skip, the member is dropped from
  the gate and the room resumes; the skipped client **jumps to the live position** when it
  recovers (it just applies the next `sync`). Skipping never moves the in-sync members.
- **No tab-out opt-out** — a backgrounded/stalled member stays in the gate and becomes
  skippable via the normal 25s path.

State additions: `stalled: Set<id>`, `intent: 'playing'|'paused'`, `skipped: Set<id>`.

### 10.3 Source selection & permissions
- Changing the source (`setSource`) is a **privileged action gated by control mode**:
  open → any member; host → host only (handed over via `passControl`).
- *Later:* host may grant "can pick" to specific members without full control.
- Auto-load: on `setSource`, all clients load the new source automatically (web player loads
  the URL; extension opens/loads the page for arbitrary-site sources).

### 10.4 Activity log
- DO records meaningful events: `joined`, `left`, `setSource`, `skipped`, `tookControl`,
  `passedControl`, `modeChanged`. Each: `{actor, type, detail, at}`.
- Broadcast to room; rendered in a sidebar. (Play/pause/seek are **not** logged by default —
  too noisy.)
- Persistence: TBD (likely ephemeral in the DO, cleared when the room is destroyed).

### 10.5 Subtitles (personal) — overlay engine, works on ANY source
- We render WebVTT/SRT cues **ourselves as an overlay layer** positioned over the video,
  synced to the native `<video>`'s `currentTime` (which the extension can read). This is the
  asbplayer technique: it does **not** rely on the native player's subtitle system, so custom
  subs work on **YouTube / embeds / any site**, not just direct files. (Earlier draft said
  "our-player sources only" — superseded by the overlay approach.)
- Per-viewer, local (never synced): **offset/delay**, **position** (vertical), **style**
  (font size, color, background box, opacity).
- Subtitle sources (decided): **upload** (`.srt`/`.vtt`), **embedded tracks** (if present in
  the HLS/file), **online search** (OpenSubtitles-style API). No paste-URL.

### 10.7 The room page + embedded source (the MVP model)

Everyone **gathers on a hosted room page** (free static site). The shared source is **embedded
as an `<iframe>`** inside that page; the extension bridges into the iframe to sync + overlay.
This gives the Twoseven "the media is in the room" feel **without extraction** — we embed the
source, we don't rip it.

**Hosting:** the room page is a **static** Svelte build on Cloudflare Pages (free). The only
"backend" is the PartyKit room (also free). No always-on/video-relaying server exists.

**Flow:**
1. **Pick a source:** host is on an embed page and clicks "share" (extension grabs the page
   URL), *or* pastes a source URL into the room. The room stores the source URL.
2. **Gather:** host shares the room link (`/r/<name>#k=<secret>`) in Discord. Everyone opens
   the **room page**, which connects to the PartyKit room and gets the source URL.
3. **Embed:** the room page renders the source in an `<iframe>`. Each viewer's iframe loads
   the embed **first-party from their own browser** → the stream plays for them (tokens /
   referer / CORS satisfied, exactly as if they'd opened the embed directly).
4. **Bridge:** the extension (content script, `all_frames: true`) injects into the cross-origin
   iframe, hooks the `<video>` (reads `currentTime`, drives play/pause/seek), and renders the
   **overlay UI + subtitle layer**. Required because the same-origin policy blocks the room
   page from scripting a cross-origin iframe.
5. **Sync:** control-sync via the room (drift correction, buffer gate). Members/presence,
   activity log, and subtitle controls live in the room-page overlay.

**Detection:** when sharing, the extension lists detected `<video>`s (default to main/playing).

**Model = control-sync via embedding, not extraction.** Each viewer is a first-party visitor
to the source; we embed a URL + sync a clock + draw an overlay. We do not rip/rehost streams
or forge headers (see Non-goals).

**Caveats / limitations:**
- **Frame-allowing sources only.** Works for embed providers (the primary use case) and
  official embeds (YouTube). Sites that send `X-Frame-Options`/`frame-ancestors` to forbid
  framing **cannot** be embedded — and we will **not** strip those headers (circumvention
  line). Such sources fall back to the secondary "open in your own tab" path (Phase 4) or are
  unsupported.
- **Multi-step embeds:** if a source needs choose-a-server / dismiss-popup / click-play, each
  viewer does it themselves inside their iframe (the escape-hatch reveals the native UI).
  Seamless for auto-playing embeds and YouTube.

### 10.6 Identity
- Nickname typed on join, stored in `localStorage` (remembered next time). No accounts.
- Auto color/avatar derived from the nickname.
