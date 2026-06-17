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

## Phase 1 — Sync server core (PartyKit) ✅
- [x] PartyKit project; one Durable Object per room holding the `Room` state object.
      (`packages/server/src/server.ts`)
- [x] Implement protocol: `join`, `setSource`, `control`, `setMode`, `passControl`, `status`,
      `skip`, `resync` → `welcome`, `sync`, `members`, `gate`, `log`, `error`.
      (shared types in `packages/protocol`)
- [x] Single-clock projection (`projected = intent==='paused' ? time : time + (now-updatedAt)/1000 * rate`),
      with rebase-on-gate so the soft-pause neither loses nor gains time.
- [x] Server-enforced control-acceptance rule (open vs. host mode); host-disconnect auto-promote.
- [x] 3s heartbeat `sync` tick + 25s auto-skip grace, both via one storage alarm (survives hibernation).
- [x] Buffer gate (soft-pause vs. hard-pause, manual + auto skip).
- [x] State persisted to DO storage; reconnect → resync snapshot.
- [x] Throwaway test client (`packages/server/test/sync-client.mjs`, native Node WebSocket).

**Milestone:** ✅ two test clients converge on play/pause/seek via the server, the server clock
projects time forward, host mode drops non-host control (and snaps them back), the buffer gate
soft-pauses on stall and releases on recovery/skip, and reconnect resyncs. Run: `pnpm dev:server`
then `pnpm test:sync` → **23/23 checks pass**.

## Phase 2 — Room page + extension MVP (the core product) 🟡 built, pending live browser test
Everyone gathers on a hosted room page; the source is embedded as an iframe; the extension
bridges in to sync + overlay. Code complete, builds + typechecks pass; **end-to-end browser
sync against a real embed is the next verification step** (manual).
- [x] **Static room page** (`packages/web`, Svelte 5 + Vite SPA): `/r/<name>#k=<secret>`, join + nickname.
- [x] Room page **embeds the shared source** in an `<iframe>` (`components/Embed.svelte`).
- [x] MV3 extension (`packages/extension`, WXT): content script (`all_frames: true`) that
      **hooks the embedded iframe's `<video>`** for sync, with `MutationObserver` re-hook on swap.
- [x] **Room page holds the WS** (decided: simpler than a background SW; SPEC §6 allowed either).
      Source is set by **pasting a URL** in the control bar → `setSource`.
- [x] **Clean overlay:** full-takeover click-catcher + escape hatch ("show site") inside the
      iframe, follows fullscreen. Our control bar (on the page) drives the `<video>` via the bridge.
- [x] Control-sync: content script applies `sync` (0.5s drift), reports `status` + `currentTime`.
- [x] **Buffer gate:** soft-pause on stall, 25s skip valve, `readyState` fallback signal.
- [x] Members/presence + activity-log panel (page sidebar).
- [x] Handle the `<video>` appearing late / being swapped (`MutationObserver`; `failed` after 12s grace).
- [x] **"Share to room" popup + `<video>`/`<iframe>` picker:** extension popup scans the active
      tab (all frames) for sources, finds open room tabs, and delivers the chosen URL to the room
      page (→ `setSource`); manual paste box too. (ARCHITECTURE "Source picker".)
- [ ] **Remaining:** the live browser verification pass (incl. the picker on real embeds).

**Milestone (code):** ✅ host pastes an embed URL, the crew opens the room link, and the page
relays the server clock into each iframe where the content script enforces it — control-sync,
no ripping/forging. **Milestone (verified):** ⏳ pending a real-embed browser run.

## Phase 3 — Custom subtitle overlay (works on ANY source) 🟡 built, render pending browser test
- [x] Render WebVTT/SRT cues ourselves as an **overlay layer** synced to `currentTime`
      (`packages/extension/lib/subtitleLayer.ts`) — asbplayer-style, follows fullscreen.
- [x] Per-viewer local controls: **offset/delay**, **position**, **style** (size/color/box)
      (`components/SubtitlePanel.svelte`; personal, never synced).
- [x] Subtitle sources: **upload** + **online search** via a member-gated proxy in the DO
      (OpenSubtitles + SubDL, normalize→VTT, keys server-side). **Verified live** end-to-end.
- [ ] **Remaining:** embedded-track extraction as a source; the in-browser render verification.

**Milestone (code+proxy):** ✅ proxy returns merged results and converts to VTT
(`pnpm --filter @sixseven/server exec node test/subs-smoke.mjs`). **Milestone (render):** ⏳
load + restyle + time-shift subs over a real synced video — pending browser run.

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

## Backlog — captured ideas (not yet scheduled)

### Video call (webcam + mic between viewers) — 🟡 built (room page + own-tab), pending live test
**Status:** 1:1 call shipped on **both** surfaces — `setCam`/`rtcSignal` signaling on the DO, a shared
`CallManager` (perfect negotiation, duplicated in `web/src/lib/call.ts` + `extension/lib/call.ts`).
Room page = `VideoCall.svelte` + top-bar **Call**; own-tab = the widget's **Start video call** + tiles.
STUN-only by default (free); TURN auto-enables when `TURN_KEY_ID`+`TURN_KEY_API_TOKEN` are env-set
(Cloudflare Realtime TURN, free ≤1000 GB/mo). Capped at 2 publishers. **Own-tab caveat:** a content
script's `getUserMedia` is governed by the host page's `Permissions-Policy camera`, so a locked-down
site (maybe Netflix) can block it — handled with a graceful error, not a fight. Original design notes below.

### Popup "create a room" launcher — ✅ built
Popup tab order is now **Room** (first) / **Watch on this page** (second). The Room tab creates "our
room" from the extension: ＋ New empty room, or a scanned video / pasted URL → new room (opens
`WEB_APP_URL` `/r/<name>?src=…&kind=…#k=<secret>`; the page applies `?src` on join then strips it). A
"Send to an open room instead" checkbox preserves the old deliver-to-open-room flow.
- **Why:** for people who *don't* use Discord (e.g. a couple watching together), so sixseven is
  self-contained — no separate voice app needed.
- **Approach (free, on-architecture):** WebRTC **peer-to-peer** media (never through our server).
  **Signaling** (SDP/ICE exchange) rides the existing PartyKit DO as new message types
  (`rtc-offer`/`rtc-answer`/`rtc-ice`) — tiny control-plane JSON, same category as `sync`.
  **STUN** = `stun.cloudflare.com` (free, unlimited). **TURN** fallback (only when P2P is blocked)
  = Cloudflare Realtime TURN, **free up to 1,000 GB/mo** (a couple's usage is a rounding error).
- **Hard cap = the safety valve:** gate video to **≤2 publishers per room** so the mesh never goes
  O(N²) and TURN egress stays trivially inside the free tier. Bump later only if we ever choose to pay.
- **Key constraint:** for the Netflix/DRM use case the call must live in the **own-tab widget**, not
  just the room page — those viewers never load the web room. So design the call to work over the
  own-tab `RoomSocket`/widget, not only `RoomClient`/room page.
- **Start small:** v1 = STUN-only 1:1 on the room page (zero setup, ~85% connect). v1.1 = add free
  Cloudflare TURN for the NAT-blocked minority. Stays at zero cost throughout. Not DRM-related — webcam
  streams between friends are a separate category from the watched source (§3 still holds).

### Popup redesign — make the popup a room *launcher*, not just a sender
- **Now:** popup tab order is "Watch on this page" then "Send to a room"; the room tab only delivers a
  picked source to an **already-open** room tab.
- **Want:** **Room tab first**, "Watch on this page" second. The Room tab should *create* "our room"
  from the extension — flexibly: **make an empty room**, **make a room with a video from this page**, or
  **send to an existing open room** (today's behavior). Popup mints `name + #k=secret` and opens the
  deployed room URL; for "with a video" it hands the scanned source to the freshly-opened tab (wait for
  `data-sixseven-room` then deliver, or carry `?src=` on the URL + a small room-page change).
- **Framing to honor:** the two tabs really mean **framable source → our (web) room** vs
  **non-framable/DRM → sync it in place (own-tab)**. Netflix etc. can *only* use the second tab; don't
  bury it. Consider labels that say so.

### Netflix (and other DRM / non-framable sites) — own-tab only
- **Room-page embed: never** — Netflix forbids framing (`X-Frame-Options`/`frame-ancestors`) and we
  don't strip headers (§3); plus DRM. You cannot "send Netflix to the web room."
- **Own-tab: yes** — each viewer plays Netflix in their own tab on their own account; the extension only
  reads/sets the native `<video>` clock (play/pause/seek). No decryption/extraction — the Teleparty model,
  within scope. **Unverified on Netflix specifically** (own-tab tested on embeds, not Netflix); both must
  manually open the same title on their own accounts.

---

### Deliberately out of scope (see ARCHITECTURE.md → Non-goals)
DRM bypass · stream ripping/rehosting · header/CORS forging · virtual browser ·
public/broadcast scale.
