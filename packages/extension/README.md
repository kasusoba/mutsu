<div align="center">

<img src="public/icon/128.png" alt="mutsu extension icon" width="96" height="96" />

# mutsu browser extension

**Keep a watch party's video in sync, on any site.**

</div>

The mutsu extension is the piece that reaches into a video player your browser otherwise
can't touch (cross-origin embeds and the sites you're already on) and keeps its playback
clock lined up with everyone else in your party. It only ever moves a playback position —
play / pause / seek — never video itself.

Part of [mutsu](../../README.md), a self-hosted watch-party tool.

---

## For developers

```bash
pnpm install
pnpm --filter @mutsu/extension dev          # Chromium, hot-reload
pnpm --filter @mutsu/extension dev:firefox  # Firefox
pnpm --filter @mutsu/extension build        # → .output/chrome-mv3 (load unpacked)
pnpm --filter @mutsu/extension zip          # packaged zip for store upload
```

Load unpacked: `chrome://extensions` → enable Developer mode → **Load unpacked** →
`packages/extension/.output/chrome-mv3`.

The extension no longer owns a WebSocket — the **web room page is the hub**. The popup opens
the deployed room page at `WEB_APP_URL` in `lib/config.ts` (defaults to the local Vite dev
server under `pnpm dev:ext`, the deployed page in production; override with `WXT_WEB_APP_URL`).
Change `WEB_APP_URL` if you host the room page elsewhere.

---

# Store listing copy

Everything below is ready to paste into the Chrome Web Store / Firefox AMO listing fields.

## Short description / summary

> Watch videos in sync with friends. mutsu keeps everyone's play, pause, and seek lined up — on embeds, direct links, YouTube, or any tab.

*(128 characters — fits the Chrome Web Store summary limit. A tighter alternative: "Keep a watch party's video playback in sync with friends, on any site.")*

## Detailed description

> **Watch together, in perfect sync.**
>
> mutsu keeps a group's video playback lined up while you hang out — same moment, same
> pause, same rewind. Everyone plays their own copy of the video in their own browser;
> mutsu just shares the play / pause / seek so all the screens stay together.
>
> **The video never passes through any server.** mutsu only moves the playback position
> and the link — that's why it's lightweight and instant.
>
> **What it syncs**
> • Embeddable streaming sites and providers — it hooks the site's own player.
> • Direct video links (HLS .m3u8 and .mp4/.webm files).
> • YouTube.
> • Non-embeddable sites — the video plays in your own tab, kept in sync from the room page,
>   with an in-page widget for members, chat, reactions, GIFs, and subtitles.
>
> **Also included**
> • Personal subtitles — upload a file, search online, or use the source's own captions, then restyle and time-shift them just for you.
> • Reactions, chat, and GIFs over the video.
> • A shared "up next" queue with auto-advance.
> • A buffer gate that waits for whoever is still loading.
>
> **What mutsu is not:** it does not bypass DRM, rip or rehost streams, or get around a
> site's access controls. It only syncs playback of sources you can already open yourself.
> If a video won't load for you on its own, mutsu won't make it.

## Single-purpose description

> mutsu has one purpose: synchronize video playback (play, pause, and seek position)
> between members of a watch party so they can watch the same video at the same time.

## Permission justifications

| Permission | Why it's needed |
|---|---|
| **Host permissions (`<all_urls>`)** | The content script must run inside the streaming page or cross-origin video iframe the user chooses to watch — which can be any site — to read the `<video>` element's playback time and apply play/pause/seek. It also lets the toolbar popup read the active tab's media URLs to "share to room". The extension stays inert until the user explicitly starts or joins a party. |
| **`scripting`** | When the user clicks the toolbar button, the popup scans the active tab's frames for `<video>`/`<iframe>` sources so the user can pick what to share with the room. One read-only scan; no persistent injection. |
| **`tabs`** | A watch party can play a non-embeddable site's video in its own tab while a separate **room page** tab controls it. The background service worker is the only context that can pass messages **between two tabs**, so it uses the tabs API to: relay play/pause/seek between the room tab and the site tab (`tabs.sendMessage`); detect when either tab navigates or closes so it can stop syncing (`tabs.onUpdated` / `tabs.onRemoved`); focus the room tab from the in-page "go to room" button (`tabs.update`); and find or open the site tab (`tabs.query` / `tabs.create`). The popup also reads the active tab's URL to offer "watch this page" and to find open room tabs. No browsing history is collected, stored, or transmitted. |
| **`storage`** | `storage.session` holds the local room-tab ↔ site-tab pairing so a recycled background worker can recover it; `storage.local` keeps your GIF favorites and nickname. Local to your browser only. |
| **`web_accessible_resources` (`icon/*.png`)** | The in-page widget shows the extension's icon in its floating bubble; a content-script `<img>` can only load extension resources that are marked web-accessible. |

No remote code is loaded or executed — all logic ships in the package.

Short version for the store's **`tabs`** justification field:

> A watch party plays a non-embeddable site's video in its own tab while a separate room
> tab controls it. The extension's background worker uses the tabs API to relay
> play/pause/seek between those two tabs, to detect when either tab closes or navigates so
> it can stop syncing, to focus the room tab on user request, and to read the active tab's
> URL so the popup can offer to share that page to a room. No browsing history is collected,
> stored, or transmitted.

## Data usage / privacy disclosures

- **No analytics, no tracking, no ads, no data selling.**
- The extension reads the playback time of the `<video>` on the page you choose to sync, and
  passes it **locally to the room-page tab** (which holds the connection). This **website
  content is not stored, and the extension itself contacts no server** — only a numeric
  playback position travels, and only via the room page.
- The room page (not the extension) sends that position and the **nickname you type** to the
  sync server to keep the party aligned and label you. No accounts, no emails, no passwords.
- Pairing state + GIF favorites + nickname are stored **locally** in the browser (`storage`);
  they aren't sent anywhere by the extension.
- The sync server is the one you (or the party host) run/point to — mutsu does not send
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
- [ ] **`WEB_APP_URL`** in `lib/config.ts` points at the live room page in production builds (it does by default), or the popup will open the wrong place. The room page in turn must point at a live sync server (`VITE_PARTYKIT_HOST`, baked at web build — see `docs/DEPLOY.md`).
