# sixseven — Consolidated Spec

> Single source of truth. Folds together PRD, ARCHITECTURE, and ROADMAP into one coherent
> read. Where this disagrees with older docs, **this wins.**

Status: **planning** (no code yet). Last consolidated after the room-page/iframe decision and
the first stress test.

---

## 1. What it is (one paragraph)

A self-hosted **watch-party** tool. Friends are together in **Discord voice**; sixseven
keeps their **video playback in sync**. Everyone **gathers on a hosted room page**; the chosen
source is **embedded as an `<iframe>`** inside that page; a **browser extension** bridges into
the iframe to align the clock and draw a clean overlay (controls + custom subtitles). The
media "is in the room" by **embedding** it — never by ripping or relaying it. No video bytes
pass through any server, so it runs for **$0**.

## 2. Guiding principle

> **Move the URL and the clock, never the bytes.**

Every design decision is tested against this. If a feature would route/transcode video through
a server or run a browser in the cloud, it's rejected. That's what keeps hosting free and sync
instant.

**Precisely: the principle is "no server in the _video path_," not "no server."** We already run
a server — the PartyKit DO — for control-plane data (the sync clock, presence). Adding more
control-plane traffic (e.g. the subtitle-text proxy, §13) does **not** break the principle: it
carries KB of text, never video bytes, and costs ~$0 on free tiers. What stays forbidden is
anything in the *video* path — relay, transcode, cloud browser, stream extraction (§3).

## 3. Goals / non-goals

**Goals**
- Second-tight sync (≤0.5s), auto-correcting drift.
- "Gather in a room" feel — a shared page with the media in it.
- $0 hosting (static room page + free room backend; no video relay).
- Low join friction (share a link).
- Works with frame-allowing sources, especially **embed providers** (the primary use case).

**Non-goals (hard lines)**
- ❌ No DRM circumvention.
- ❌ No stream **extraction/rehosting**.
- ❌ No **header/CORS/X-Frame-Options forging** to defeat a site's access controls.
- ❌ No virtual browser, server-side screen capture, or video relay.
- ❌ No voice/text chat (Discord covers it). No torrents. No public/broadcast scale.

## 4. The model & its one boundary

**Model:** room page → embeds source in an `<iframe>` → extension bridges into the iframe to
sync `currentTime`/play/pause/seek and render the overlay. Each viewer loads the source
**first-party** in their own iframe (tokens/referer/CORS satisfied as if they opened it
directly). This is **control-sync via embedding**, not extraction.

**The single fault line: can we frame the source?**
- **Frame-allowing** (embed providers, YouTube `/embed/`, many watch pages) → full "gather in
  the room" experience.
- **Frame-forbidding** (`X-Frame-Options`/`frame-ancestors`, or frame-busting JS) → cannot be
  embedded. Fallback: **Phase-4 "open in your own tab" sync** (each viewer opens the source in
  their own tab; extension syncs across tabs). Loses the gather-in-a-page feel. We do **not**
  strip framing headers to force it.

**Targeting & detecting frame-ability (runtime, automatic):**
- Prefer the **provider embed URL** (the inner `/embed/…` iframe `src` already on the page —
  the detector reads it), NOT the outer aggregator/catalog site. Provider embeds are built to
  be framed; the catalog around them often forbids it.
- The extension **tries to frame** the chosen URL and watches for failure (load error / blank
  frame / CSP console error). On failure → **auto-fall back to own-tab sync** and notify the
  room. Users never have to know whether a site is frameable.

**vs. Twoseven:** Twoseven *rips the stream URL and forges headers* to play it in its own
player, which lets it handle frame-forbidding sites and gives a fully unified player — at the
cost of circumventing access controls. We trade that universality for legitimacy. For
frame-allowing embed providers the gap is small. **Why URL type is irrelevant to us:** we sync
the `<video>` *element*, not the stream, so direct-file / HLS / `blob:`(MSE) all hook
identically — we never need to find the real stream URL (the thing ripping requires).

## 5. Stack

| Layer | Choice |
|---|---|
| Room page | **Svelte**, static build on **Cloudflare Pages** (free) |
| Room backend | **PartyKit** (Cloudflare **Durable Objects**) — one DO per room (free tier) |
| Extension | **MV3**, two builds: **Chromium + Firefox** |

## 6. Components

```
┌──────────────────────── Room page (static, our origin) ────────────────────────┐
│  Svelte UI: overlay controls · members/presence · activity log · subtitle panel  │
│  ┌──────────────── <iframe src=SOURCE> (cross-origin, e.g. 1embed) ───────────┐  │
│  │   the embed's own player + <video>  ◄── extension content script hooks it   │  │
│  └────────────────────────────────────────────────────────────────────────────┘  │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                │ WebSocket (control msgs only — no video bytes)
                ▼
        ┌───────────────── PartyKit DO (one per room) ─────────────────┐
        │  authoritative state · single server clock · broadcast        │
        └───────────────────────────────────────────────────────────────┘
```

- **Room page** — gathers everyone; embeds the source; hosts the overlay UI; holds the WS
  connection (or delegates to the extension's service worker).
- **PartyKit DO** — per-room authoritative state; the **single clock** for drift correction;
  enforces control-mode permissions; broadcasts `sync`.
- **Extension** — injects into the cross-origin iframe (same-origin policy blocks the room page
  from doing it), hooks the `<video>`, renders the overlay + subtitle layer **inside the
  iframe** (so it aligns with the video and follows fullscreen).

## 7. Sync protocol

### State (per room, in the DO)
```
Room {
  src        : string | null     // source URL embedded in the iframe
  intent     : 'playing' | 'paused'   // human intent (hard state)
  time       : number            // position (s) as of updatedAt
  rate       : number            // playback rate
  updatedAt  : number            // SERVER clock (ms) — drift projection basis
  mode       : 'open' | 'host'
  hostId     : string | null
  members    : Map<id,{ name, status }>   // status: loading|ready|stalled|failed
  stalled    : Set<id>
  skipped    : Set<id>
  log        : Event[]           // ephemeral activity log
}
```

### Single-clock rule
All playback-time projection happens **on the server** (one clock). Clients never do
cross-clock math:
```
projected = intent==='paused' ? time : time + (serverNow() - updatedAt)/1000
```
The DO sends `{...projected}`; arriving ~instantly, the client treats it as "where you should
be now."

### Messages
**Client → server:** `join{room,secret,name}` · `setSource{src}` · `control{intent,time}` ·
`setMode{mode}` · `passControl{toId}` · `status{state}` (loading/ready/stalled/failed) ·
`skip{memberId}`

**Server → client:** `sync{src,intent,time,rate,mode,hostId}` · `members{list}` ·
`log{event}` · `gate{paused, waitingFor:[ids]}`

### Drift correction (client)
On `sync`:
```
if (videoSrc != expected) (re)load
playbackRate = rate
if (|currentTime - time| > 0.5) currentTime = time   // threshold avoids stutter
intent==='paused' ? pause() : play()
```
- **Seek debounce:** local scrubbing emits `control` only on seek-*end* (or throttled ≥250ms)
  to avoid broadcast storms.
- **Heartbeat:** while playing, the DO broadcasts a `sync` every 3s to mop up slow drift.
- **Reconnect:** on WS reconnect, client requests current `sync` and snaps in.

## 8. Control modes
- **`open`** (default): any member's `control`/`setSource` is accepted.
- **`host`**: only `hostId` controls; others' `control` is dropped server-side and they get a
  corrective `sync`. Host hands off via `passControl`.
- **Host disconnect (host mode):** auto-promote the **longest-connected** member; if none
  eligible, fall back to `open`.
- **Server-enforced:** acceptance = `mode==='open' || sender===hostId`.

## 9. Buffer gate (ready-gating)
```
effective_play = (intent==='playing') AND (stalled is empty among non-skipped members)
```
- `waiting` → add to `stalled`; `playing`/`canplay` → remove. **Fallback signal:** also poll
  `readyState`/`buffered` (player events aren't always reliable).
- **Soft pause** (gate) is distinct from **hard pause** (human `intent`), so neither stomps the
  other. Soft auto-resumes when the gate clears.
- **One unified gate** — the initial start trips the same gate; no separate "system
  pre-buffer." Buffering is personal/per-browser.
- **Skip valve:** stalled > **25s** → `Continue without <name>` appears (perm = control mode).
  Skipped member is dropped from the gate; rejoins by jumping to live on recovery. **Skipping
  never moves in-sync members.**
- **`failed` vs `stalled`:** a member whose iframe never produced a playable video is `failed`
  (not merely buffering — dead server / geo-block / frame-bust). Failed members are surfaced in
  presence and **auto-skipped after the same 25s grace** so the room never freezes; they rejoin
  at live once they fix it (retry / re-pick a server).
- **No tab-out opt-out** — backgrounded members stay in the gate and become skippable normally.

## 10. Room auth
- ID in path, secret in **fragment**: `/r/<name>#k=<secret>`. Fragment is never sent in HTTP
  requests / never logged; client passes it to the DO only over the WS.
- Create → DO stores `{name, secret, open:false}`. Join → admit iff `open` or secret matches.
- **Open toggle** (skip secret). **Reset link** (regenerate secret → old links die = soft kick).

## 11. Identity, presence, activity log
- **Identity:** nickname typed on join, stored in `localStorage`. No accounts. Auto color/avatar.
- **Presence:** members sidebar with live status (watching / buffering / skipped / failed).
- **Activity log:** ephemeral, in the DO; logs `joined/left/setSource/skipped/tookControl/
  passedControl/modeChanged` (not play/pause/seek — too noisy); cleared when the room dies.

## 12. Source selection & overlay
- **Pick a source:** host clicks "share" on an embed page (extension detects `<video>`s, lists
  them, defaults to main/playing) **or** pastes a source URL. `setSource` is gated by control
  mode; auto-loads in everyone's iframe.
- **Overlay:** **full takeover + escape hatch** — covers site chrome/ads/native controls for a
  clean surface; a **"show site"** toggle reveals the native UI when needed (server-switch,
  captcha, login, the play button if autoplay is blocked). Rendered by the in-iframe content
  script so it tracks the video and follows fullscreen.

## 13. Subtitles (personal, any source)
- **Overlay engine** (asbplayer-style): we render WebVTT/SRT cues ourselves, synced to the
  video's `currentTime`, so custom subs work on **any frame-allowing source** (YouTube/embeds
  included), independent of the native player's subs.
- Per-viewer, local (never synced): **offset/delay**, **position**, **style** (size/color/
  box/opacity).
- **Sources:** **upload** (`.srt`/`.vtt`) + **online search** (OpenSubtitles + SubDL). No paste-URL.
- **Online search = a control-plane proxy in the DO** (`onRequest`, member-gated): provider keys
  live as deploy secrets, never on the client; results normalize to WebVTT. Providers are
  swappable behind one interface — default **OpenSubtitles** (catalog + hash matching, ~20/day),
  with **SubDL** merged in for volume (2000 req/day). Configurable via `SUBS_PROVIDER_ORDER`.
  This is text, not video — on the right side of §2. *(Embedded-track extraction = later.)*

## 14. Hosting & cost
> **Static page ≠ server.** The room page is static (free); only an always-on video-relaying
> server costs money, and we have none.

| Piece | Option | Cost |
|---|---|---|
| Room page (static) | Cloudflare Pages | $0 |
| Room backend | PartyKit / Durable Objects | $0 (free tier) |
| Subtitle proxy | same DO (`onRequest`), text only | $0 (free tier) |
| Domain | optional (free `*.pages.dev`) | $0 / ~$10yr |
| Extension | unpacked → publish | $0 / store acct (have it) |

**MVP total: $0.** The subtitle proxy doesn't change this: text-sized, scales to zero, free tier.

## 15. Roadmap (milestone per phase)
- **P0 Decisions** — ✅ done (this spec).
- **P1 Room backend** — ✅ done. PartyKit DO: state, protocol, single-clock projection,
  control-mode enforcement, buffer gate, 3s heartbeat, 25s auto-skip, reconnect, DO-storage
  persistence. *Milestone met: two test clients sync; host mode drops non-host control
  (`packages/server`, `pnpm test:sync` → 23/23).*
- **P2 Room page + extension MVP** — 🟡 built, pending live browser test. Static room page
  (`packages/web`) embeds source iframe + holds the WS; extension (`packages/extension`) hooks the
  iframe `<video>`; clean overlay (+escape hatch); control-sync (0.5s); buffer gate (25s skip);
  presence + log; re-hook on `<video>` swap. Builds + typechecks pass. **Share-to-room picker
  done**: an extension popup scans the active tab (all frames) for `<video>`/`<iframe>` sources,
  finds open room tabs, and delivers the chosen URL to the room page (which `setSource`s it). See
  ARCHITECTURE "Source picker". *Remaining: the real-embed verification run for the picker.*
- **P3 Subtitle overlay** — 🟡 built (proxy verified live; cue rendering pending browser test).
  Server-side **subtitle proxy** (OpenSubtitles + SubDL, normalize→VTT, member-gated) verified
  end-to-end (`test/subs-smoke.mjs` → 80 results + VTT download; `test/vtt.test.mts` green).
  Web: VTT/SRT parser + subtitle panel (upload + online search + offset/position/style). Extension:
  in-iframe cue renderer synced to `currentTime`+offset. *Remaining: embedded-track source + the
  browser render verification.*
- **P4 Secondary paths** — 🟡 **standalone paste-a-URL/HLS player done**: sources carry a
  `srcKind` (`embed`\|`direct`); `direct` URLs (HLS `.m3u8` / video files) play in the room page's
  own `<video>` via `WebPlayer` + hls.js, no extension needed, same drift/gate logic as the embed
  path (ARCHITECTURE §4 "Source kinds"). *Remaining: YouTube via iframe API; **frame-forbidding
  fallback** (own-tab sync); end-of-video "pick next."* *Milestone: paste-a-URL party ✓ + a working
  fallback for non-embeddable sites (pending).*
- **P5 Host local file** — browser WebTorrent for web-seed files (no 2nd backend). *Milestone:
  share a local file without central upload.*
- **P6 Polish & deploy** — Chromium+Firefox builds; unpacked → publish; 2-min join guide.

## 16. Risks & mitigations (from stress test)
| # | Risk | Sev | Mitigation |
|---|---|---|---|
| 1 | Embed swaps its `<video>` (ad break / server switch) → hook lost | **High** | `MutationObserver` re-hook; re-apply sync on new element |
| 2 | Buffer events (`waiting`/`playing`) unreliable across players | **High** | Poll `readyState`/`buffered` as fallback gate signal |
| 3 | Member's iframe never loads the video (geo/server fail) ≠ buffering | **High** | `failed` status distinct from `stalled`; auto-skippable; surfaced in UI |
| 4 | Autoplay blocked → iframe won't start without a gesture | Med | "click to start" via escape hatch; gate holds until ready |
| 5 | Overlay covers ads **and** the native play/UI you sometimes need | Med | Escape hatch toggle; careful `pointer-events` layering |
| 6 | Open-mode griefing (hijack playback / change source / seek spam) | Med | Host mode; per-member control rate-limit; quick "lock" toggle |
| 7 | WS drop / DO hibernation loses sync | Med | Persist room state to DO storage; reconnect + resync handshake |
| 8 | Seek storm from scrubbing | Med | Debounce `control` to seek-end / throttle |
| 9 | Viewers get different servers/encodings/geo availability | Med | Same content ⇒ `currentTime` still aligns; failed loads → #3 |
| 10 | Fullscreen drops the overlay/subtitles | Med | Render overlay inside the fullscreened container (in-iframe) |
| 11 | Capability-URL link leaks | Low | Reset-link re-locks; acceptable for friend group |
| 12 | Extension `<all_urls>` permission scares friends / supply-chain risk | Low | Expected; minimize scope where possible; self-signed/trusted distribution |
| 13 | Frame-busting JS on a header-allowing site | Low | Falls back to own-tab sync (P4) |
| 14 | Live streams (no fixed timeline) don't fit `currentTime` sync | Low | Out of scope (VOD only); detect & warn |
| 15 | Nickname impersonation (no accounts) | Low | Acceptable for trusted group; not solving for MVP |

## 17. Open questions
- Project name (currently `sixseven`).

**Resolved in P3:** online-subtitle **provider + API-key handling** → shared keys as **deploy
secrets** behind a **member-gated proxy in the DO** (`onRequest`), providers swappable
(OpenSubtitles default + SubDL volume), keys never on the client (§13). This clarified §2: the
principle is "no server in the *video path*," and a text proxy doesn't cross it.

**Resolved in stress test:** failed-to-load member → **auto-skip after 25s grace** (§9); **no**
open-mode "lock" button (host mode suffices); frame-ability **auto-detected at runtime** with
own-tab fallback (§4).
