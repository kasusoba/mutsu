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
import { PICKER_TAG, type PickSourceMessage, ROOM_ATTR } from "@sixseven/protocol/picker";
import { type XtabMessage, unwrapXtab, wrapXtab } from "@sixseven/protocol/xtab";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/sandbox";
import { MSG_SATELLITE_STATE, MSG_SET_WIDGET_HIDDEN } from "../lib/config";
import { Overlay } from "../lib/overlay";
import {
  type AreYouRoomReply,
  type DeliverSourceReply,
  PICKER_DELIVER,
  PICKER_PING,
  type PickerRuntimeMessage,
} from "../lib/picker";
import { SatelliteController } from "../lib/satellite";
import { SubtitleLayer } from "../lib/subtitleLayer";
import { VideoHook } from "../lib/videoHook";

const FRAME_KINDS = new Set([
  "hello",
  "apply",
  "overlay",
  "setSubtitles",
  "setSubtitleStyle",
  "setHidden",
  "selectTrack",
]);

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

      // Picker bridge (SPEC §12): the popup discovers room tabs and delivers the
      // chosen source URL through us, since it can't script the room page's
      // Svelte state. We only translate — the page re-validates and decides.
      browser.runtime.onMessage.addListener((raw: unknown) => {
        const msg = raw as PickerRuntimeMessage | null;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === PICKER_PING) {
          const reply: AreYouRoomReply = {
            room: document.documentElement.getAttribute(ROOM_ATTR),
          };
          return Promise.resolve(reply);
        }
        if (msg.type === PICKER_DELIVER && typeof msg.url === "string") {
          // Hand it to the room page on its own origin; the page calls setSource.
          const pick: PickSourceMessage = {
            tag: PICKER_TAG,
            kind: "pick-source",
            url: msg.url,
            srcKind: msg.srcKind,
            queue: msg.queue,
          };
          window.postMessage(pick, window.location.origin);
          const reply: DeliverSourceReply = { ok: true };
          return Promise.resolve(reply);
        }
        return; // not ours — let other listeners (if any) handle it
      });

      // Site party plumbing (§11). This top frame plays one of two message-driven
      // roles — never both:
      //   HUB: the web room page. App.svelte posts xtab envelopes to our window;
      //        we forward them to the background relay, and post background→page
      //        traffic (relay-up / satellite state) back to the window for App.
      //   SATELLITE: a frame-forbidding site the background has paired to a room;
      //        we run a SatelliteController that drives this tab's <video>.
      let satellite: SatelliteController | null = null;
      const stopSatellite = () => {
        satellite?.destroy();
        satellite = null;
      };
      const startSatellite = (room: string) => {
        if (satellite) return;
        satellite = new SatelliteController(room);
        satellite.start();
      };

      // page → background: forward the hub's OUTBOUND xtab envelopes. (Our own
      // window.postMessage of background→page traffic echoes here too, but those
      // are inbound kinds and are skipped — so no loop.)
      window.addEventListener("message", (e: MessageEvent) => {
        if (e.source !== window || e.origin !== location.origin) return;
        const msg = unwrapXtab(e.data);
        if (!msg) return;
        if (
          msg.kind === "registerHub" ||
          msg.kind === "openSatellite" ||
          msg.kind === "adoptSatellite" ||
          msg.kind === "navigateSatellite" ||
          msg.kind === "unpair" ||
          (msg.kind === "relay" && msg.dir === "down")
        ) {
          void browser.runtime.sendMessage(msg).catch(() => {});
        }
      });

      // background → this tab: assignment (satellite) or hub-bound traffic.
      browser.runtime.onMessage.addListener((raw: unknown) => {
        const msg = raw as XtabMessage | null;
        if (!msg || typeof msg !== "object" || !("kind" in msg)) return;
        switch (msg.kind) {
          case "assignSatellite":
            if (msg.active) startSatellite(msg.room);
            else stopSatellite();
            return Promise.resolve({ ok: true });
          case "relay":
            // Down → this tab is the satellite (drive the video). Up → this tab is
            // the hub (hand it to App via the window).
            if (msg.dir === "down" && satellite) satellite.handleDown(msg.msg);
            else if (msg.dir === "up") window.postMessage(wrapXtab(msg), location.origin);
            return;
          case "satelliteState":
            window.postMessage(wrapXtab(msg), location.origin);
            return;
        }
        return;
      });

      // popup → this tab: query party state + show/hide the in-tab widget (§11).
      browser.runtime.onMessage.addListener((raw: unknown) => {
        const m = raw as { type?: string; hidden?: boolean } | null;
        if (!m || typeof m !== "object") return;
        if (m.type === MSG_SATELLITE_STATE) {
          return Promise.resolve(
            satellite ? satellite.popupState() : { active: false, hidden: false, members: 0 },
          );
        }
        if (m.type === MSG_SET_WIDGET_HIDDEN) {
          satellite?.setWidgetHidden(Boolean(m.hidden));
          return Promise.resolve({ ok: true });
        }
        return;
      });

      // Am I a paired satellite? (Opened/assigned for a room, or just reloaded.)
      void browser.runtime
        .sendMessage({ kind: "satelliteHello", url: location.href } satisfies XtabMessage)
        .then((r) => {
          const room = (r as { room?: string | null } | null)?.room;
          if (room) startSatellite(room);
        })
        .catch(() => {});
      return;
    }

    const parent = window.parent;
    const overlay = new Overlay();
    const hook = new VideoHook();
    const subtitles = new SubtitleLayer(() => hook.currentTime());

    let engaged = false;
    // Only activate inside an actual sixseven party: a `hello` from the room page
    // (relayed down the frame tree) means we're embedded in a room. Without it —
    // just a video on some random page the user is browsing — we stay inert and
    // draw nothing (no badge, no hooking, no reporting).
    let sawHello = false;
    // Last-known state, replayed onto the video once this frame engages.
    let lastApply: Parameters<VideoHook["apply"]>[0] | null = null;
    let lastTakeover = true;
    let lastCues: Parameters<SubtitleLayer["setCues"]>[0] = null;
    let lastStyle: Parameters<SubtitleLayer["setStyle"]>[0] | null = null;
    let lastHidden = false;
    let lastSelectedTrack: string | null = null;

    const sendUp = (msg: FrameToPageMessage) => parent.postMessage(wrap(msg), "*");

    /** Re-broadcast a raw page→frame envelope to every child iframe. */
    const broadcastDown = (data: unknown) => {
      for (const f of Array.from(document.querySelectorAll("iframe"))) {
        f.contentWindow?.postMessage(data, "*");
      }
    };

    /** This frame found a <video>: become the active player surface. Only does
     *  anything once we've seen the room page's `hello` (i.e. we're in a party). */
    const engage = () => {
      if (engaged || !sawHello) return;
      engaged = true;
      overlay.mount();
      subtitles.mount();
      overlay.setTakeover(lastTakeover);
      overlay.setHidden(lastHidden);
      subtitles.setHidden(lastHidden);
      // Always forward the user's native-player actions to the room — the
      // overlay no longer blocks the native UI, so this is how "their iframe
      // player" stays in sync (not just our control bar).
      hook.allowLocalControl = true;
      if (lastStyle) subtitles.setStyle(lastStyle);
      subtitles.setCues(lastCues);
      if (lastSelectedTrack != null) applyTrack(lastSelectedTrack);
      if (lastApply) hook.apply(lastApply);
    };

    /** Use an embedded caption track: read its cues into our layer, or fall back
     *  to the site's native rendering when the cues aren't CORS-readable. */
    function applyTrack(trackId: string | null) {
      if (trackId === null) {
        hook.disableTextTracks();
        return;
      }
      hook.useTextTrack(trackId, (cues) => subtitles.setCues(cues));
    }

    hook.onHookChange = (found) => {
      if (!found) return;
      engage();
      if (!engaged) return; // not in a party (no hello yet) → stay silent
      // Notify the page on EVERY (re)hook, not just the first. When an embed
      // swaps its <video> (ad break / quality switch) the cached `lastApply`
      // position is stale; the page reacts by pulling a fresh `sync` so the new
      // element snaps to the correct time instead of an old one.
      sendUp({ kind: "hooked", found: true });
    };
    hook.onStatus = (state, currentTime, duration) => {
      if (engaged) sendUp({ kind: "status", state, currentTime, duration });
    };
    hook.onLocalControl = (intent, time) => sendUp({ kind: "localControl", intent, time });
    hook.onEnded = () => {
      if (engaged) sendUp({ kind: "ended" });
    };
    // Surface the source's own caption tracks so the page can offer them (§13).
    hook.onTextTracksChanged = () => {
      if (engaged) sendUp({ kind: "tracks", tracks: hook.getTextTracks() });
    };

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
          // We're in a party now — engage if a <video> is already hooked.
          sawHello = true;
          if (hook.currentTime() != null) {
            engage();
            if (engaged) sendUp({ kind: "hooked", found: true });
          }
          sendUp({ kind: "ready" });
          break;
        case "apply":
          lastApply = {
            intent: msg.intent,
            time: msg.time,
            rate: msg.rate,
            gatePaused: msg.gatePaused,
            force: msg.force,
            solo: msg.solo,
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
        case "setHidden":
          lastHidden = msg.hidden;
          if (engaged) {
            overlay.setHidden(msg.hidden);
            subtitles.setHidden(msg.hidden);
          }
          break;
        case "selectTrack":
          lastSelectedTrack = msg.trackId;
          if (engaged) applyTrack(msg.trackId);
          break;
      }
    }

    hook.start();
    // Announce readiness so the page (re)sends the current state down to us.
    sendUp({ kind: "ready" });
  },
});
