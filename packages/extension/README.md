<div align="center">

<img src="public/icon/128.png" alt="sixseven extension icon" width="96" height="96" />

# sixseven browser extension

**Keep a watch party's video in sync, on any site.**

</div>

The sixseven extension is the piece that reaches into a video player your browser otherwise
can't touch (cross-origin embeds and the sites you're already on) and keeps its playback
clock lined up with everyone else in your party. It only ever moves a playback position —
play / pause / seek — never video itself.

Part of [sixseven](../../README.md), a self-hosted watch-party tool.

---

## For developers

```bash
pnpm install
pnpm --filter @sixseven/extension dev          # Chromium, hot-reload
pnpm --filter @sixseven/extension dev:firefox  # Firefox
pnpm --filter @sixseven/extension build        # → .output/chrome-mv3 (load unpacked)
pnpm --filter @sixseven/extension zip          # packaged zip for store upload
```

Load unpacked: `chrome://extensions` → enable Developer mode → **Load unpacked** →
`packages/extension/.output/chrome-mv3`.

The extension talks to the deployed sync server hardcoded in `lib/config.ts`
(`PARTYKIT_HOST`) — change it if you self-host your own backend.

---

# Store listing copy

Everything below is ready to paste into the Chrome Web Store / Firefox AMO listing fields.

## Short description / summary

> Watch videos in sync with friends. sixseven keeps everyone's play, pause, and seek lined up — on embeds, direct links, YouTube, or any tab.

*(128 characters — fits the Chrome Web Store summary limit. A tighter alternative: "Keep a watch party's video playback in sync with friends, on any site.")*

## Detailed description

> **Watch together, in perfect sync.**
>
> sixseven keeps a group's video playback lined up while you hang out — same moment, same
> pause, same rewind. Everyone plays their own copy of the video in their own browser;
> sixseven just shares the play / pause / seek so all the screens stay together.
>
> **The video never passes through any server.** sixseven only moves the playback position
> and the link — that's why it's lightweight and instant.
>
> **What it syncs**
> • Embeddable streaming sites and providers — it hooks the site's own player.
> • Direct video links (HLS .m3u8 and .mp4/.webm files).
> • YouTube.
> • Any tab — start a party right where you are and share a short room code.
>
> **Also included**
> • Personal subtitles — upload a file, search online, or use the source's own captions, then restyle and time-shift them just for you.
> • Reactions, chat, and GIFs over the video.
> • A shared "up next" queue with auto-advance.
> • A buffer gate that waits for whoever is still loading.
>
> **What sixseven is not:** it does not bypass DRM, rip or rehost streams, or get around a
> site's access controls. It only syncs playback of sources you can already open yourself.
> If a video won't load for you on its own, sixseven won't make it.

## Single-purpose description

> sixseven has one purpose: synchronize video playback (play, pause, and seek position)
> between members of a watch party so they can watch the same video at the same time.

## Permission justifications

| Permission | Why it's needed |
|---|---|
| **Host permissions (`<all_urls>`)** | The content script must run inside the streaming page or cross-origin video iframe the user chooses to watch — which can be any site — to read the `<video>` element's playback time and apply play/pause/seek. It also lets the toolbar popup read the active tab's media URLs to "share to room". The extension stays inert until the user explicitly starts or joins a party. |
| **`scripting`** | When the user clicks the toolbar button, the popup scans the active tab's frames for `<video>`/`<iframe>` sources so the user can pick what to share with the room. |
| **`storage`** | Remembers the active "own-tab party" for a tab so the popup and the in-page content script share the same state. Local only. |

No remote code is loaded or executed — all logic ships in the package.

## Data usage / privacy disclosures

- **No analytics, no tracking, no ads, no data selling.**
- The extension reads the playback time of the `<video>` on the page you choose to sync. This
  **website content is not stored or transmitted** anywhere except as a numeric playback
  position sent to the sync server so the party stays aligned.
- The only personal-ish data is the **nickname you type**, sent to the sync server to label
  you in the room. No accounts, no emails, no passwords.
- Party state is stored **locally** in the browser (`storage`); it isn't sent anywhere.
- The sync server is the one you (or the party host) run/point to — sixseven does not send
  your data to the developer.

---

## Before you submit — checklist

Things the stores require that **aren't** in this repo and you'll need to provide:

- [ ] **Screenshots** — Chrome requires at least one **1280×800** or **640×400** PNG/JPEG. Firefox wants at least one too. (Grab a room with a video playing + the widget/subtitle panel.)
- [ ] **Icon** — 128×128 ✅ already in `public/icon/128.png`.
- [ ] **Small promo tile** — 440×280 (optional but recommended for Chrome).
- [ ] **Privacy policy URL** — **required** because the extension has broad host permissions and handles a user-provided nickname. The "Data usage / privacy disclosures" section above can be the basis; host it somewhere public (a GitHub Pages page or a `PRIVACY.md` link) and paste the URL. *(I can draft a `PRIVACY.md` if you want.)*
- [ ] **Category** — suggest "Entertainment" (Chrome) / "Other" or "Social & Communication" (Firefox).
- [ ] **Chrome data-usage form** — declare: does NOT sell data; data used only for the extension's single purpose; tick "website content" + "user-provided content (nickname)" as handled-but-not-sold.
- [ ] **Account / developer fee** — Chrome Web Store has a one-time US$5 developer registration; Firefox AMO is free.
- [ ] **`PARTYKIT_HOST`** in `lib/config.ts` points at a live server before you publish, or the published extension won't connect.
