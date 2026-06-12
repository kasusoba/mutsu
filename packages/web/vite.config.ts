import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Static SPA → Cloudflare Pages (SPEC §5).
//
// `__PARTYKIT_HOST__` is the WS/HTTP host for the room backend. When unset it
// defaults to "" → the client uses the page's OWN origin (window.location.host)
// and the dev server proxies `/parties/*` to the local PartyKit on :1999. That
// means everything is one origin, so a single tunnel (e.g. `cloudflared tunnel
// --url http://localhost:5173`) exposes both the page and the sync server for
// cross-device testing — no env var, no deploy. Set VITE_PARTYKIT_HOST to a
// deployed backend for production.
export default defineConfig({
  plugins: [svelte()],
  define: {
    __PARTYKIT_HOST__: JSON.stringify(process.env.VITE_PARTYKIT_HOST ?? ""),
  },
  server: {
    host: true, // bind 0.0.0.0 so a LAN device / tunnel can reach the dev server
    // Vite blocks unknown Host headers (anti-DNS-rebinding). Allow any so a
    // tunnel/LAN host (e.g. *.trycloudflare.com, ngrok, a LAN IP) can load the
    // page during cross-device testing.
    allowedHosts: true,
    proxy: {
      "/parties": {
        target: "http://127.0.0.1:1999",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
  },
});
