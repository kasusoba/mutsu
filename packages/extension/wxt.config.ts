import { defineConfig } from "wxt";

// MV3, two builds (Chromium + Firefox) from one codebase (SPEC §5).
// The extension's only job is to bridge into the cross-origin embed iframe and
// sync its <video>. It reads a <video> element's clock — it does not rip,
// relay, or unlock anything (SPEC §3 non-goals).
export default defineConfig({
  // Don't auto-launch a throwaway Chrome in dev — load `.output/chrome-mv3`
  // into your own browser (Edge/Chrome) instead. The dev build still hot-reloads
  // because it connects back to the running `wxt dev` server.
  runner: { disabled: true },
  manifest: {
    name: "sixseven",
    description: "Keep a watch party's video playback in sync.",
    // No special API permissions needed — a content script in the embed frame
    // is enough. host_permissions lets it run inside cross-origin iframes.
    permissions: [],
    host_permissions: ["<all_urls>"],
  },
});
