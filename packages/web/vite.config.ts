import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Static SPA → Cloudflare Pages (SPEC §5). The PartyKit host is injected at
// build time; defaults to local dev.
export default defineConfig({
  plugins: [svelte()],
  define: {
    __PARTYKIT_HOST__: JSON.stringify(process.env.VITE_PARTYKIT_HOST ?? "127.0.0.1:1999"),
  },
  build: {
    target: "es2022",
  },
});
