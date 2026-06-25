# Deploying sixseven

Everything here is free-tier. Three pieces: the **sync server** (PartyKit
Durable Object), the **room page** (static, Cloudflare Pages), and the
**extension** (per-browser). The room page talks to its own origin in dev; in
production it talks to the deployed server via `VITE_PARTYKIT_HOST`.

## 1. Sync server (PartyKit on your own Cloudflare)

The server deploys to **your own Cloudflare account** under the custom domain
`sync.onesal.me` — no `*.partykit.dev` username subdomain (PartyKit binds that to
your original GitHub handle permanently, so a custom domain is the only way to
keep the host handle-free). Cloud-prem deploys are free.

One-time setup:

- Add **onesal.me** to your Cloudflare account so it's a Cloudflare zone — the
  `sync` record is created there automatically on deploy.
- Create a Cloudflare API token at <https://dash.cloudflare.com/profile/api-tokens>
  with the **Edit Cloudflare Workers** template, and copy your **Account ID**
  from the dashboard.

The custom domain is already set in `packages/server/partykit.json`
(`"domain": "sync.onesal.me"`), so deploy just needs the Cloudflare credentials:

```bash
cd packages/server
CLOUDFLARE_ACCOUNT_ID=<your-account-id> \
CLOUDFLARE_API_TOKEN=<your-api-token> \
  npx partykit deploy               # → https://sync.onesal.me
npx partykit env push               # push .env (OpenSubtitles/SubDL keys) for the subtitle proxy
```

The stable backend is then `wss://sync.onesal.me`. (Forkers: set your own
`"domain"` in `partykit.json`, or drop the field to fall back to the
`<project>.<github-username>.partykit.dev` managed subdomain.)

## 2. Room page (Cloudflare Pages)

Build with the server URL baked in, then deploy the static output. `_redirects`
(in `packages/web/public/`) gives the SPA fallback so `/r/<room>` URLs resolve.

```bash
pnpm deploy:web                              # build (host baked in) + wrangler pages deploy
#   → https://sixseven.pages.dev
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

Send friends `https://sixseven.pages.dev/r/<room>#k=<secret>`. The secret lives
in the URL fragment, so it's never sent to any server. First join establishes
the room (trust-on-first-use); later joins must match the secret unless the room
is opened.
