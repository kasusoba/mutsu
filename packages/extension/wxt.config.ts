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
    // `scripting` lets the picker popup scan the active tab for <video>/<iframe>
    // sources (SPEC §12). The content script in the embed frame needs no API
    // permission; host_permissions lets it run inside cross-origin iframes and
    // lets the popup read tab URLs to find the room tab.
    // `storage` holds own-tab party state (§11) shared between the popup and the
    // source-tab content script.
    permissions: ["scripting", "storage"],
    host_permissions: ["<all_urls>"],
    // The toolbar button opens the "share to room" picker — WXT wires the action
    // from the popup entrypoint and takes its tooltip from the popup's <title>.
  },
});
