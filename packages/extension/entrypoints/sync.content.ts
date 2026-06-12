/**
 * sixseven content script (SPEC §6) — injected into every frame. Embed providers
 * nest the real <video> several iframes deep, so a flat parent↔child bridge isn't
 * enough. This relays the bridge through the WHOLE frame tree:
 *
 *   - page→frame messages (apply/overlay/subs) flow DOWN: each frame handles them
 *     locally and re-broadcasts to its own child iframes.
 *   - frame→page messages (status/ready/localControl) bubble UP: each frame
 *     forwards a child's message to its own parent until it reaches the room page.
 *
 * A frame only "engages" (mounts overlay + subtitles, reports status) once it
 * actually has a <video>. Empty frames (embed chrome) stay silent and just relay,
 * so they don't fight the real player's status. The room page owns the
 * failed-timeout. No bytes, no extraction, no header forging.
 */

import type { FrameToPageMessage, PageToFrameMessage } from "@sixseven/protocol/bridge";
import { unwrap, wrap } from "@sixseven/protocol/bridge";
import { defineContentScript } from "wxt/sandbox";
import { Overlay } from "../lib/overlay";
import { SubtitleLayer } from "../lib/subtitleLayer";
import { VideoHook } from "../lib/videoHook";

const FRAME_KINDS = new Set(["hello", "apply", "overlay", "setSubtitles", "setSubtitleStyle"]);

export default defineContentScript({
  matches: ["<all_urls>"],
  allFrames: true,
  runAt: "document_idle",
  main() {
    // Top frame = the room page (our origin); it talks to the DO directly. Mark
    // the DOM so the page can detect the extension is installed/enabled and warn
    // the user if it isn't (no extension ⇒ no bridge ⇒ nothing syncs).
    if (window.top === window.self) {
      document.documentElement.setAttribute("data-sixseven-ext", "1");
      return;
    }

    const parent = window.parent;
    const overlay = new Overlay();
    const hook = new VideoHook();
    const subtitles = new SubtitleLayer(() => hook.currentTime());

    let engaged = false;
    // Last-known state, replayed onto the video once this frame engages.
    let lastApply: Parameters<VideoHook["apply"]>[0] | null = null;
    let lastTakeover = true;
    let lastCues: Parameters<SubtitleLayer["setCues"]>[0] = null;
    let lastStyle: Parameters<SubtitleLayer["setStyle"]>[0] | null = null;

    const sendUp = (msg: FrameToPageMessage) => parent.postMessage(wrap(msg), "*");

    /** Re-broadcast a raw page→frame envelope to every child iframe. */
    const broadcastDown = (data: unknown) => {
      for (const f of Array.from(document.querySelectorAll("iframe"))) {
        f.contentWindow?.postMessage(data, "*");
      }
    };

    /** This frame found a <video>: become the active player surface. */
    const engage = () => {
      if (engaged) return;
      engaged = true;
      overlay.mount();
      subtitles.mount();
      overlay.setTakeover(lastTakeover);
      // Always forward the user's native-player actions to the room — the
      // overlay no longer blocks the native UI, so this is how "their iframe
      // player" stays in sync (not just our control bar).
      hook.allowLocalControl = true;
      if (lastStyle) subtitles.setStyle(lastStyle);
      subtitles.setCues(lastCues);
      if (lastApply) hook.apply(lastApply);
      sendUp({ kind: "hooked", found: true });
    };

    hook.onHookChange = (found) => {
      if (found) engage();
    };
    hook.onStatus = (state, currentTime, duration) => {
      if (engaged) sendUp({ kind: "status", state, currentTime, duration });
    };
    hook.onLocalControl = (intent, time) => sendUp({ kind: "localControl", intent, time });

    window.addEventListener("message", (e: MessageEvent) => {
      const env = e.data as { tag?: unknown; msg?: { kind?: string } } | null;
      if (!env || typeof env !== "object" || !env.msg) return;
      const kind = env.msg.kind;

      if (e.source === parent && typeof kind === "string" && FRAME_KINDS.has(kind)) {
        // page→frame: handle locally, then relay down the tree.
        const msg = unwrap<PageToFrameMessage>(e.data);
        if (msg) handleDown(msg);
        broadcastDown(e.data);
        return;
      }
      if (e.source !== parent) {
        // frame→page (from a child): bubble up toward the room page.
        const up = unwrap<FrameToPageMessage>(e.data);
        if (up) parent.postMessage(e.data, "*");
      }
    });

    function handleDown(msg: PageToFrameMessage) {
      switch (msg.kind) {
        case "hello":
          sendUp({ kind: "ready" });
          break;
        case "apply":
          lastApply = {
            intent: msg.intent,
            time: msg.time,
            rate: msg.rate,
            gatePaused: msg.gatePaused,
          };
          if (engaged) hook.apply(lastApply);
          break;
        case "overlay":
          lastTakeover = msg.takeover;
          if (engaged) overlay.setTakeover(msg.takeover);
          break;
        case "setSubtitles":
          lastCues = msg.cues;
          if (engaged) subtitles.setCues(msg.cues);
          break;
        case "setSubtitleStyle":
          lastStyle = msg.style;
          if (engaged) subtitles.setStyle(msg.style);
          break;
      }
    }

    hook.start();
    // Announce readiness so the page (re)sends the current state down to us.
    sendUp({ kind: "ready" });
  },
});
