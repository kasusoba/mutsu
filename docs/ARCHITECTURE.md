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
- The mode is a room setting **chosen at room creation** (the create-room landing page) and
  carried on the creator's `join` as an optional `mode` — the server honours it **only on the
  room-creating join** (trust-on-first-use), making the creator the host. It can still be
  flipped live via `setMode` (host locks/unlocks) and `passControl` (host hands off). The
  server enforces acceptance — a `control` from a non-host in `host` mode is dropped server-side.

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

> **Source of truth:** the wire types live in `packages/protocol/src/index.ts`, imported by
> the server, room page, and extension alike. Keep this table and that file in lockstep.
> Note the SPEC `intent: 'playing' | 'paused'` model (human hard-state) replaces the older
> `paused` boolean, so it can stay distinct from the soft buffer gate.

Client → server:
| type | payload | meaning |
|---|---|---|
| `join` | `{ secret, name, mode?, observer? }` | join a room; secret = capability-URL fragment; `mode` is the creator's chosen control mode, honoured only on the room-creating join (SPEC §10); `observer:true` reads state without being a presence member (own-tab join-peek, §11). Server replies with `welcome` + a snapshot |
| `setSource` | `{ src, kind? }` | change the room's source; resets time to 0 (control-mode gated). `kind` = `embed`\|`direct`\|`site`\|`youtube` (default `embed`) — how clients render it |
| `control` | `{ intent, time, rate? }` | user played/paused/seeked locally (accepted per control mode) |
| `setMode` | `{ mode }` | switch room between `open` and `host` (control-mode gated) |
| `passControl` | `{ toId }` | (host mode) hand control to another member |
| `status` | `{ state }` | report readiness `loading\|ready\|stalled\|failed` for the buffer gate (SPEC §9) |
| `skip` | `{ memberId }` | drop a stalled/failed member from the gate (control-mode gated) |
| `resync` | `{}` | request a fresh `sync` + `gate` snapshot (used on reconnect) |
| `say` | `{ kind, text }` | ephemeral fun-layer broadcast — `kind` = `reaction`\|`chat`\|`gif`; the server fans it out and forgets it (§12). Rate-limited |
| `queueAdd` / `queueRemove` / `queueClear` / `playItem` / `queueReorder {id,toIndex}` / `playNext {afterId}` / `setAutoplay {on}` | playlist mutations (§14, control-mode gated). `playNext` auto-advances (`afterId` dedups concurrent ends); `setAutoplay` toggles whether queue items start playing on their own |

Server → client:
| type | payload | meaning |
|---|---|---|
| `welcome` | `{ self }` | admission ok; this connection's own member id |
| `sync` | `{ src, srcKind, intent, time, rate, mode, hostId, force }` | authoritative state, `time` already projected to now; apply it. `force:true` = a real command (snap to it); `false` = a heartbeat/presence tick (only large drift corrects) |
| `members` | `{ list }` | presence list (`id, name, status`) |
| `gate` | `{ paused, waitingFor }` | soft buffer gate; play only when `sync.intent==='playing'` AND `gate.paused===false` |
| `log` | `{ event }` | one appended activity-log event (SPEC §11) |
| `event` | `{ kind, text, from, name, at }` | a fanned-out fun-layer event (reaction/chat/gif) — ephemeral, never stored (§12) |
| `playlist` | `{ items, currentId, autoplay }` | the room queue + which item is playing + autoplay flag (§14); broadcast on change + join |
| `error` | `{ code, message }` | connection refused / action rejected |

**Control acceptance rule (server-enforced):** a `control`/`setSource`/`setMode`/`skip` is
applied iff `room.mode === 'open'` OR `senderId === room.hostId`. Otherwise it's dropped and
the sender gets a fresh `sync` to snap back into line.

### Sync cadence
- On `join` → immediate `sync`.
- On any `control` / `setSource` → immediate `sync` broadcast to the room.
- While a room is playing → server broadcasts a `sync` tick every **3s** (heartbeat) so
  slow drift gets corrected without anyone touching the controls.

### Page ↔ iframe bridge (cross-origin)

The room page owns the WS but **cannot script the cross-origin embed's `<video>`** (same-origin
policy). The extension's content script — injected into that iframe — is the only code that can.
They talk over `window.postMessage` with a tagged envelope (`packages/protocol/src/bridge.ts`,
imported as `@sixseven/protocol/bridge`). Drift-correction (§4) runs in the content script,
since it's the only side that can read/write `video.currentTime`.

Page → frame: `hello` (handshake) · `apply { src, intent, time, rate, gatePaused }` (the server
truth to enforce) · `overlay { takeover }` (escape hatch) · `setSubtitles { cues }` · `setSubtitleStyle { style }`
(personal subtitles, §13 — page→frame only, never networked) · `setHidden { hidden }` ("use the
site's player") · `selectTrack { trackId }` (turn one of the embed's **own** caption tracks on/off,
§13 — `trackId:null` = off).
Frame → page: `ready` · `hooked { found }` · `status { state, currentTime, duration }` (every 1s + on
events) · `localControl { intent, time }` (native-UI action when the escape hatch is open, which
the page relays to the server as a `control`) · `ended` (video reached its end → playlist
auto-advance, §14) · `tracks { tracks }` (the embed's own caption tracks, reported on hook + when
the list changes, so the page can offer them).

### Source picker (extension popup → room page)

"Share to room" (SPEC §12, §10.3) is an extension **popup** (toolbar button). It scans the tab
you're browsing for `<video>`/`<iframe>` sources and hands the chosen URL to an open room page,
which calls `setSource`. It moves a **URL only** (§2) — no scanning, ripping, or relaying of bytes.

Three hops, no background worker (discovery is live, so it survives a suspended service worker):
- **Scan:** the popup runs `collectFrameCandidates` via `chrome.scripting.executeScript` across
  **all frames** of the active tab. Each frame returns its `<iframe>` srcs and `<video>` srcs;
  a `blob:`/MSE video (no embeddable URL) falls back to that frame's own page URL. The popup
  dedupes by URL and ranks (playing video first, then `/embed/` provider iframes per §4, then size).
- **Discover rooms:** the popup pings every http(s) tab with `are-you-room`; the content script
  (top frame) answers with the room name if the page set `data-sixseven-room` on `<html>` (the
  web app sets it while joined). Matching tabs become the "send to" targets.
- **Deliver:** the popup sends `deliver-source { url }` to the chosen room tab's content script,
  which **`window.postMessage`s `pick-source { url }` to the room page on its own origin**. The
  page re-validates the URL (same `extractSourceUrl` as the paste box — origin/protocol checks,
  iframe-snippet unwrap) and calls `setSource` iff the viewer `canControl` (else a banner explains
  host mode). The popup also has a manual paste box that delivers the same way.

The page-facing message (`pick-source`) and the `data-sixseven-room` marker live in
`packages/protocol/src/picker.ts` (`@sixseven/protocol/picker`) since both web and extension need
them; the `are-you-room`/`deliver-source` runtime messages are extension-internal
(`packages/extension/lib/picker.ts`). The popup needs the `scripting` permission (to scan) on top
of the existing `<all_urls>` host permission (to read tab URLs and reach content scripts).

### Subtitle proxy (HTTP, member-gated)

The DO also serves an HTTP `onRequest` endpoint at the room's URL for subtitle **search/download**
(SPEC §13, §17). It proxies subtitle *text* only (search JSON + KB-sized cue files) — control-plane,
same category as `sync`, never video bytes. Requests must carry `x-sixseven-secret` (the room
capability) so only members use it; provider API keys live in `room.env`, never on the client.
`POST {op:'subs.search', query}` → `{results:[{id,provider,title,language,release}]}`;
`POST {op:'subs.download', id}` → `{vtt}`. Providers (OpenSubtitles, SubDL) sit behind one
interface and all output is normalized to WebVTT. CORS-enabled so the static page can call it.

Messages are authenticated by the bridge tag/version, not origin (embed origin varies per
provider). The channel carries positions and intents only — never media.

**Nested frames.** Embed providers nest the real `<video>` several iframes deep, so the bridge
**relays through the whole frame tree**: page→frame messages broadcast DOWN (each frame re-posts
to its child iframes), frame→page messages bubble UP (each frame forwards a child's message to
its own parent) until they reach the room page. A frame only **engages** (mounts overlay +
subtitles, reports `status`) once it actually has a `<video>`; empty frames (embed chrome) stay
silent and just relay, so they don't fight the real player's status. Because a video-less frame
reports nothing, the **room page owns the failed-timeout**: a source set marks the member
`loading`, then `failed` if no frame reports a video within ~15s (SPEC §9).

The in-iframe overlay is **`pointer-events: none`** (a status badge only) — it must never block
the native player, since autoplay needs a user gesture and server-switch/captcha/login live in
the native UI. A full ad-hiding takeover is deferred.

## 4. Client drift-correction algorithm

Runs in the in-iframe content script on each `apply` (the page's forward of the server `sync`):
```
video.playbackRate = rate
if (Math.abs(video.currentTime - time) > SEEK_DEADZONE)   // SEEK_DEADZONE = 1.0s
    video.currentTime = time
const shouldPlay = intent === 'playing' && !gatePaused   // gate = soft-pause (SPEC §9)
shouldPlay ? video.play() : video.pause()
```
- **The seek dead-zone is a *band*, not a tight target.** Real embed players (YouTube, HLS)
  wander a few hundred ms as they buffer/decode; at the old 0.5s threshold the 3s heartbeat
  re-seeked the video back and forth every cycle — the visible "jitter". A ~1s dead-zone is
  imperceptible over Discord voice yet still snaps genuine desyncs (a scrub, a fresh join, a
  `<video>` swap). `DRIFT_THRESHOLD` (0.5s) is kept only as the echo-match tolerance.
- On a `<video>` swap the content script re-notifies the page (`hooked`), which throttled-pulls a
  fresh `sync` (`resync`) so the new element snaps to the live position, not a stale cached one.
- The page sets the iframe `src`; the content script does not load sources (no extraction).
- **The page only forwards `apply` on a *fresh* `sync` (new server-projected `time`) or a real
  gate-pause flip — never on the ~1/s no-op `gate` rebroadcasts that status reports trigger.**
  Re-applying a stale `time` between 3s heartbeats would make the content script seek backward to
  an old position every second (visible as jitter). Correspondingly, when the **server** flips the
  gate it rebases the clock and broadcasts a fresh `sync` (before the `gate` message), so clients
  seek to the current position, not a stale one.
- **Echo suppression is event-matched, not timer-based.** Our own `apply()` causes `seeked`/`play`/
  `pause` events asynchronously (often >50ms later, while re-buffering). We mark the exact event we
  expect (the seek target / a play / a pause) and consume it when it lands, so a self-induced event
  is never misreported as a user `localControl` (which would re-base the server clock or flip
  `intent` to a hard pause — the old fixed 50ms window let these leak and caused jitter, stray
  pauses, and missing play/pause log entries).
- **Stall detection is conservative** (avoids self-gating a solo viewer): a stall is reported only
  when the room is meant to be playing AND playback isn't advancing AND `readyState < 3`, and it is
  **debounced ~700ms** so a transient dip (HLS segment boundary) doesn't soft-pause the room.
  `readyState` dips in the ~1s after our own seek are ignored (seeking naturally dips it). No
  playable video within the page's ~15s grace ⇒ `failed`, not `stalled`.

### Source kinds: embed vs direct (SPEC §15 P4)

A source carries a **`srcKind`** (`SetSource { src, kind? }` → `Sync { src, srcKind }`). It picks
how every client renders the source:

- **`embed`** (default) — `src` is a framable page. The room page loads it in an `<iframe>` and
  the extension content script hooks the `<video>` inside (everything in §3–§4 above).
- **`direct`** — `src` is a raw media URL (HLS `.m3u8` or a video file). The room page plays it in
  its **own same-origin `<video>`** via `WebPlayer` (`web/src/lib/webPlayer.ts`): the SPEC §4 drift
  dead-zone + buffer-gate status reporting, driven directly because the element is first-party.
  **No extension needed.** It is deliberately **one-way** — the player enforces server truth onto
  the element but never turns the element's own media events into `control` messages. Every state
  change is therefore either ours (an apply) or buffering, never mistaken for a user intent — which
  removes the video→server→video echo loop that the bidirectional embed path is prone to (the
  source of jitter and unreliable play/pause logging). **User input on a direct source flows only
  through the room UI** (the control bar + click-to-toggle on the video) → explicit `control`.
  `DirectPlayer.svelte` renders the personal subtitle overlay itself (from `SubtitleController`,
  no bridge) and loads HLS with **hls.js** (lazy-imported into its own chunk; native HLS on Safari;
  plain `<video src>` for `.mp4`/`.webm`; ambiguous extension-less URLs try hls.js then fall back).
  Add `?hud` to the room URL for an on-video readout of `currentTime` vs the server `time` + drift.

  **Drift model (`WebPlayer`):** the server tags each `sync` with `force` (real command vs
  heartbeat/presence tick — see the protocol table). A `force` sync always snaps. On a heartbeat a
  **solo** viewer is left alone (the video just plays — forcing realtime only rebuffers it for
  nobody); a **multi** viewer glides back into sync via a small `playbackRate` slew (≤8%, the
  `NUDGE_ZONE`→`HARD_SEEK` band) and only hard-seeks for a >3s desync. This replaced hard-seeking
  every ~1s drift, which showed up as periodic black-screen jitter. Presence/mode/skip/gate events
  are `force:false` so a buffering or reconnecting peer never yanks the others.

The kind is chosen when the source is set: the web auto-detects by file extension (`classifySource`)
or the user forces `embed`/`direct` in the source picker. It is **content-neutral playback of a URL
the user supplies** — sixseven does not extract stream URLs out of pages or forge `Referer`/headers
to defeat a site's hotlink/token protection (§3 lines hold). A protected stream that 403s without
its origin's referer simply won't load, and we surface that rather than bypass it.

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
- Subtitle sources (decided): **upload** (`.srt`/`.vtt`), **embedded tracks**, **online search**
  (OpenSubtitles-style API). No paste-URL.
- **Embedded tracks (built):** the source's *own* baked-in caption tracks. The content script reads
  `<video>.textTracks` (in the engaged frame — which may be several iframes deep), surfaces them up
  the bridge as `tracks`, and the web panel lists them under **"From this site"**. Picking one sends
  `selectTrack { trackId }` back **down** the frame tree; the frame with the video reads that track's
  cues into **our own overlay layer** (so the same offset/position/style apply) — or, if the cues
  aren't CORS-readable, falls back to the player's native rendering. Mutually exclusive with an
  uploaded/searched file (selecting one clears the other); the same `SubtitleController` drives all
  three sources. **Scope:** embedded tracks come via the bridge, so they work for `embed` + own-tab
  `site` sources; the same-origin **direct** player (`WebPlayer`) doesn't yet surface its in-band
  tracks (upload + online-search still work there).

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

## 11. Own-tab watch party (extension-native)

A second party surface, **fully driven by the extension** — no web room page involved.
It's for watching on the *actual* streaming site (in your own tab), including sites that
refuse to be framed. The only backend is the same PartyKit relay (content-neutral clock).

**The principle: the connection lives with the video.** In room-page mode the room page owns
the WebSocket because the video is on that page. In own-tab mode the video is in *your own tab*,
so the **source tab's content script** owns the socket and is the room member. Close any other
tab → sync is unaffected; close the source tab → you leave the party (correct). No MV3
service-worker is involved (a tab can hold a socket indefinitely; an idle SW can't).

**Flow (room codes, no invite links — nothing external touches our state):**
- **Start** (popup → "Watch together on this tab"): mint a short **code**, connect, hook the
  site's `<video>`, show the widget. The code is BOTH the room name and the capability
  (~41 bits; gates casual guessing). The creator's content script `setSource(location.href, "site")`
  so joiners know what to open.
- **Join** (popup → enter code): the popup connects briefly as an **`observer`** (read-only,
  not a presence member) to read the room's source URL, shows "Now watching X — [Open & join]",
  then opens that page; its content script reads `chrome.storage` and joins as the real member.

**Reuse:** `VideoHook` (drift/gate/echo/gesture), the frame-tree bridge (the player may be a
nested iframe — same relay as the room page), host/open mode, the buffer gate, the protocol.
**No injected video controls** (the site has its own); native play/pause/seek are relayed via the
existing gesture-gated `localControl`. The only in-page UI is the **widget** (`partyWidget.ts`):
a Shadow-DOM floating bubble, draggable + edge-magnetic, hideable (controls also mirror in the
popup). Source-of-truth coherence is preserved by URL match: a tab only engages if its URL matches
the room's source; a member on a different video shows as "not on the source", never silently synced.

Code: `lib/roomSocket.ts` (framework-agnostic client), `lib/ownTab.ts` (top-frame controller),
`lib/partyWidget.ts`, `lib/config.ts` (party storage + code), `entrypoints/popup/ownTab.ts`.

## 12. Fun layer (reactions · chat · GIFs)

Ephemeral social overlay on top of any source — never persisted (it isn't playback truth) and
never in the video path (§2). One small channel carries it all: a client `say {kind,text}`
(`kind` = `reaction` | `chat` | `gif`) that the DO fans out to everyone as `event` and forgets,
with a light per-connection rate limit. Works identically on the room page and the own-tab widget
because both hold a socket.

- **Reactions** — an emoji floats up over the video and fades. Launcher lives in the room top bar
  (out of the video, non-disruptive) / the widget panel.
- **Chat** — text in the sidebar (room) / widget panel, *and* a brief bubble over the video.
- **GIFs** — searched via GIPHY through the **member-gated proxy** (`gif.search` op, key in
  `room.env`, never on the client — same model as subtitles). The chosen GIF's **URL** is
  broadcast; each viewer loads it first-party from GIPHY's CDN ("move the URL, not the bytes").
  A picker with Search + ★ Favorites; favorites persist locally (per-browser) and remember the
  search term as a tag, so favorites are filterable.
- **Personal display settings** — each viewer chooses how *they* see it: per-type on/off for
  floating reactions/GIFs/chat-bubbles, plus a Linger speed (a `--fun-mult` CSS var scales the
  animation/lifetime). Gates display only; sending and receiving are unchanged. Stored locally.

Code: protocol `SayMessage`/`EventMessage`; server `handleSay` + `gif.ts`; web `Reactions.svelte`,
`Chat.svelte`, `GifPicker.svelte`; extension `reactionLayer.ts` + widget sections.

## 13. YouTube (IFrame Player API)

YouTube exposes no raw `<video>` to hook, so a `youtube` source is driven on the room page by the
official **IFrame Player API** — no extension needed. `srcKind: "youtube"` (auto-detected from the
URL by `parseYouTubeId`; the picker sends a YouTube tab as the canonical video). `YtPlayer`
(`ytPlayer.ts`) is the analogue of `WebPlayer`: it enforces the server truth (seek on a command or
a >3s desync — YT can't fine-slew the rate) AND reports the viewer's own play/pause/seek on
YouTube's native controls back to the room (`onStateChange` + position-jump detection, with
expect-flags suppressing our own apply echoes). **Autoplay:** starts muted so it auto-starts in
sync with no click (browser policy allows muted autoplay); a "Tap to unmute" pill gets audio.
Buffering is debounced before it gates the room (a seek/play naturally buffers).

## 14. Playlist

A per-room queue of sources you line up and auto-advance through (room-page modes;
own-tab is single-source-per-site and ignores it). Server state: `queue: SourceItem[]`
+ `currentId`. Adding the first item to an empty room starts it; `playItem` jumps to one;
`playNext` advances. All mutations are control-mode gated and reuse the same `applySource`
path as a manual `setSource` (reset clock/gate, everyone reloads).

**Auto-advance:** each player reports when its video **ends** — `WebPlayer`/`YtPlayer` via an
`onEnded` callback, embed via a new `ended` bridge message (`VideoHook` 'ended' → up the frame
tree). The room page then sends `playNext {afterId: currentId}`; the server only advances if
`currentId` still equals `afterId`, so several viewers ending at once skip exactly one item.
End of queue → it just stops.

**Autoplay:** a room-level toggle (`setAutoplay`, default on). When on, a queue item that's
auto-advanced or picked starts `playing` (the buffer gate still holds until everyone's loaded —
a not-ready client reports stalled → soft-pause); off → it loads paused. A manually-pasted
`setSource` always loads paused. UI: the Source panel — `+ Queue` adds, an "Up next" list with
**drag-to-reorder** (`queueReorder {id,toIndex}`), play/remove, an autoplay checkbox, and clear.
The extension picker can also add to the queue (a "Add to queue" toggle → `PickSourceMessage.queue`).
Own-tab ignores the playlist (single-source-per-site).
