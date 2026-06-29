# Releasing mutsu

Per-version **changelogs live in [GitHub Releases](https://github.com/kasusoba/mutsu/releases)**,
not in this repo. This file is the *process*: the release checklist (so the manual
`LATEST_EXT_VERSION` bump never gets forgotten) and the reusable store
reviewer-notes template.

## Release checklist

The web deploys instantly; the extension goes through store review (days). **Deploy
web/server first, submit the extension last** — production must keep working with
the *currently-published* extension (`@mutsu/protocol/{bridge,xtab,picker}` is an
additive-only public API; never rename the wire tags / DOM attrs / storage keys).

1. **Bump the extension version** — `packages/extension/package.json` (`version`).
2. **Bump the web's `LATEST_EXT_VERSION`** — `packages/web/src/lib/extVersion.ts` to
   the *same* version. This drives the in-page "update available" nudge; if you
   skip it, installs behind the new build won't be told to update. ⚠️ easy to miss.
3. **Server** — only redeploy if server-facing protocol changed: `pnpm deploy:server`.
4. **Verify** — `pnpm typecheck`, build all (`pnpm --filter @mutsu/web build`,
   `pnpm --filter @mutsu/extension build` + `build:firefox`).
5. **Deploy web** — `pnpm deploy:web` (→ `mutsu.onesal.me`).
6. **Zip the extension** — `pnpm --filter @mutsu/extension zip` (Chrome) and
   `pnpm --filter @mutsu/extension exec wxt zip -b firefox` (Firefox + a sources
   zip AMO requires). Outputs in `packages/extension/.output/`.
7. **Tag + GitHub Release** — `gh release create vX.Y.Z --title "mutsu X.Y.Z"
   --notes "…changelog…" packages/extension/.output/mutsuextension-X.Y.Z-*.zip`.
   The user-facing changelog goes in the release notes.
8. **Submit to stores** — Chrome Web Store + Firefox AMO, using the zips and the
   reviewer notes below. Keep the **Firefox add-on id `sixseven@onesal.me`**
   unchanged so existing installs update in place.

## Store reviewer notes (reusable template)

> Paste into the Chrome "notes for reviewers" / Firefox AMO reviewer fields.
> Update only the "Rename" line once the listing name has settled.

**Rename note (until the listings read "mutsu"):** previously published as
**"sixseven"**, renamed to **"mutsu"** (branding only). The **add-on id is
unchanged** (`sixseven@onesal.me`) on purpose so existing users update in place —
that's why the manifest `name` ("mutsu") differs from the gecko id.

**What it does:** mutsu keeps a watch party's **video playback in sync**. Everyone
plays their own copy of the source in their own browser; the extension reads and
nudges the `<video>` element's **clock** (play/pause/seek/time) so playback stays
aligned. It does **not** download, record, relay, re-encode, or unlock any video —
no media bytes pass through any server. The companion room page is
`https://mutsu.onesal.me`.

**Data / privacy:** no data collection, analytics, telemetry, tracking, ads, or
cookies. Only the source **URL** + **playback position** are sent to the room
server so peers can sync. Firefox: `data_collection_permissions: ["none"]`. A
nickname is stored in `localStorage` on the web page only.

**No remote code:** all logic ships in the package; no remote scripts, no `eval`.

**Permissions:**
- `host_permissions: <all_urls>` + content script on all frames — the watched
  source can be *any* site/embed chosen at runtime, so the content script must run
  in any page/iframe to find and sync its `<video>`; inert outside an active party.
- `scripting` — the popup scans the active tab for `<video>`/`<iframe>` sources.
- `tabs` — a background worker relays sync between the room tab and a streaming tab
  (only context that can message between two tabs); also finds the open room tab.
- `storage` — local tab-pairing state; session-scoped.
- `web_accessible_resources: icon/*.png` — the in-tab widget bubble shows the icon.

**How to test:** open `https://mutsu.onesal.me` (in two profiles to simulate two
people), pick a source in the **Source** panel, and verify play/pause/seek stays in
sync. No login required.

**Reproducing the build (AMO source review):** Node ≥ 22, pnpm 9.15.0; from the
repo root: `pnpm install` then `pnpm --filter @mutsu/extension build:firefox`
(→ `.output/firefox-mv2`). Output is minified; the `*-sources.zip` is included.
Repo: `https://github.com/kasusoba/mutsu`. No build secrets — the room host is a
public URL baked in (`mutsu.onesal.me`), not a credential.
