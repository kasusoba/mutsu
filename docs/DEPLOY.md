# Deploying sixseven

Everything here is free-tier. Three pieces: the **sync server** (a Cloudflare
Durable Object via [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver)),
the **room page** (static, Cloudflare Pages), and the **extension** (per-browser).
The room page talks to its own origin in dev; in production it talks to the
deployed server via `VITE_PARTYKIT_HOST`.

## 1. Sync server (PartyServer → Cloudflare Workers)

The server is a plain Worker + Durable Object (one DO per room) built on
PartyServer, deployed with `wrangler` to the custom domain `sync.onesal.me`. The
client still speaks PartyKit-style `/parties/main/<room>` URLs — `partysocket`
needs no change. Free tier: the DO is SQLite-backed (`new_sqlite_classes` in
`wrangler.jsonc`), which is what the free plan requires.

One-time setup:

- Add **onesal.me** to your Cloudflare account so it's a zone — `wrangler`
  creates the `sync` DNS record + cert from the `routes` entry on first deploy.
- `npx wrangler login` (browser OAuth) — or set `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` for CI.
- Local dev secrets: copy `.dev.vars.example` → `.dev.vars` and fill in (it's
  gitignored). Production secrets are pushed separately (below).

```bash
cd packages/server
cp .dev.vars.example .dev.vars   # fill in OpenSubtitles/SubDL/GIPHY/TURN keys
pnpm dev                         # wrangler dev on http://127.0.0.1:8787

# deploy:
npx wrangler secret bulk .dev.vars   # push the same keys as production secrets (once / when they change)
pnpm run deploy                      # wrangler deploy → https://sync.onesal.me
#   NB: `pnpm run deploy`, not `pnpm deploy` — the latter is pnpm's built-in command.
```

The stable backend is then `wss://sync.onesal.me`. (Forkers: change `name`,
`routes`, and the DO binding in `packages/server/wrangler.jsonc` to your own
Worker + domain; the `new_sqlite_classes` migration must stay for the free plan.)

## 2. Room page (Cloudflare Pages)

Build with the server URL baked in, then deploy the static output. `_redirects`
(in `packages/web/public/`) gives the SPA fallback so `/r/<room>` URLs resolve.

```bash
pnpm deploy:web                              # build (host baked in) + wrangler pages deploy
#   → https://mutsu.onesal.me (custom domain on the Pages project `sixseven`)
```

`deploy:web` defaults `VITE_PARTYKIT_HOST` to `sync.onesal.me` (the sync server
from step 1). Forkers override it with their own host without editing tracked
files:

```bash
VITE_PARTYKIT_HOST=<your-sync-host> pnpm deploy:web
```

First deploy needs a one-time Cloudflare login: `npx wrangler login` (opens a
browser). The PartyKit host is **not a secret** — it ships in the client bundle
and is fine to commit; only `packages/server/.env` keys stay out of the repo.

`deploy:web` pins `--branch main`, so it always updates **production**
(`sixseven.pages.dev`) even when you run it from a feature branch. Without that,
`wrangler pages deploy` on a non-production branch creates a throwaway *preview*
deployment (`<branch>.sixseven-3kc.pages.dev`) and leaves production untouched.

Manual equivalent:

```bash
VITE_PARTYKIT_HOST=sync.onesal.me \
  pnpm --filter @sixseven/web build          # → packages/web/dist

npx wrangler pages deploy packages/web/dist --project-name sixseven --branch main
```

Or connect the GitHub repo in the Pages dashboard with:
- **Build command:** `VITE_PARTYKIT_HOST=sync.onesal.me pnpm --filter @sixseven/web build`
- **Output directory:** `packages/web/dist`

The client auto-uses secure `wss://`/`https://` for any non-local host, so no
extra config is needed.

## 3. Extension (per browser)

```bash
pnpm --filter @sixseven/extension build           # → .output/chrome-mv3
pnpm --filter @sixseven/extension build:firefox   # → .output/firefox-mv2
```

Load unpacked (`chrome://extensions` → Developer mode → Load unpacked), or zip
(`pnpm --filter @sixseven/extension zip`) and publish to the store. **Direct /
HLS sources need no extension; embed sources need it installed on each device.**

## 4. Share

Send friends `https://mutsu.onesal.me/r/<room>#k=<secret>`. The secret lives
in the URL fragment, so it's never sent to any server. First join establishes
the room (trust-on-first-use); later joins must match the secret unless the room
is opened.
