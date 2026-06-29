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
  // WXT's dev/hot-reload server defaults to :3000 (commonly taken); move it.
  dev: { server: { port: 3197 } },
  manifest: ({ browser }) => ({
    name: "mutsu",
    description: "Keep a watch party's video playback in sync.",
    // Firefox-only manifest keys (Chrome ignores/flags browser_specific_settings).
    // AMO now requires `data_collection_permissions` on every new extension, and a
    // stable `gecko.id` for the listing. We collect no data — the server only ever
    // sees the room URL + playback clock, never video bytes or personal data (SPEC
    // §2/§3) — so we declare `required: ["none"]` (the explicit "no data" consent).
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "sixseven@onesal.me",
              data_collection_permissions: { required: ["none"] },
            },
          },
        }
      : {}),
    // `scripting` lets the picker popup scan the active tab for <video>/<iframe>
    // sources (SPEC §12). The content script in the embed frame needs no API
    // permission; host_permissions lets it run inside cross-origin iframes and
    // lets the popup read tab URLs to find the room tab.
    // `storage` holds session pairings for site parties (§11), shared between the
    // background relay and the content scripts. `tabs` lets the background relay
    // route bridge messages between the hub tab and the site tab and notice when
    // either closes (`tabs.onRemoved`).
    permissions: ["scripting", "storage", "tabs"],
    host_permissions: ["<all_urls>"],
    // The in-tab widget (§11) renders the extension icon in its floating bubble;
    // a content-script <img> can only load extension resources that are
    // web-accessible.
    web_accessible_resources: [{ resources: ["icon/*.png"], matches: ["<all_urls>"] }],
    // The toolbar button opens the "share to room" picker — WXT wires the action
    // from the popup entrypoint and takes its tooltip from the popup's <title>.
    // WXT auto-fills `manifest.icons` from public/icon/{size}.png, but not the
    // toolbar action icon — set it explicitly so the button shows our logo.
    action: {
      default_icon: {
        16: "/icon/16.png",
        32: "/icon/32.png",
        48: "/icon/48.png",
        128: "/icon/128.png",
      },
    },
  }),
});
