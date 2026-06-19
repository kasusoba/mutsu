/**
 * Background service worker (§11) — the cross-tab relay for `site` parties.
 *
 * A frame-forbidding source can't be iframed into the web room page, so its
 * `<video>` plays in a SEPARATE tab. The web room page is still the hub (it owns
 * the WebSocket + renders members/chat/call/queue); this worker is the ONLY MV3
 * context that can `tabs.sendMessage` between the hub tab and the site tab, so it
 * relays the bridge messages between them. No video bytes (§2).
 *
 * Pairings are keyed by the HUB TAB id (not by room): one browser can have several
 * hubs for the same room (e.g. two windows in one profile, or two rooms at once),
 * and each must drive its OWN satellite tab. Relays route by the sending tab —
 * hub→its satellite, satellite→its hub — so two hubs never cross wires. Opening a
 * satellite reuses an on-source tab only if it isn't already another pairing's hub
 * or satellite, else opens a fresh one. State lives in `storage.session` so a
 * recycled worker recovers it.
 */

import type {
  AssignSatelliteMessage,
  RelayUpMessage,
  SatelliteStateMessage,
  XtabMessage,
} from "@sixseven/protocol/xtab";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/sandbox";
import { sameSource } from "../lib/config";

/** A hub tab and the site tab it drives. Keyed in the store by `String(webTabId)`. */
interface Pairing {
  room: string;
  webTabId: number;
  siteTabId?: number;
  url: string;
}
type Store = Record<string, Pairing>;

export default defineBackground(() => {
  // session storage survives a worker recycle but clears on browser close — right
  // for ephemeral tab pairings. Older engines without it fall back to local.
  const store = browser.storage.session ?? browser.storage.local;
  const KEY = "sixseven:pairings";

  const load = async (): Promise<Store> => ((await store.get(KEY))[KEY] as Store) ?? {};
  const save = (s: Store): Promise<void> => store.set({ [KEY]: s });
  const bySite = (s: Store, siteTabId: number): Pairing | undefined =>
    Object.values(s).find((p) => p.siteTabId === siteTabId);

  const toTab = (tabId: number | undefined, msg: XtabMessage): void => {
    if (tabId != null) void browser.tabs.sendMessage(tabId, msg).catch(() => {});
  };
  const notifyHub = (p: Pairing, state: SatelliteStateMessage["state"]): void =>
    toTab(p.webTabId, { kind: "satelliteState", room: p.room, state });
  const standDown = (p: Pairing): void =>
    toTab(p.siteTabId, { kind: "assignSatellite", room: p.room, active: false });

  browser.runtime.onMessage.addListener((raw: unknown, sender: { tab?: { id?: number } }) => {
    const msg = raw as XtabMessage | null;
    if (!msg || typeof msg !== "object" || !("kind" in msg)) return;
    const tabId = sender.tab?.id;

    switch (msg.kind) {
      // The web room page announces itself as the hub for a site room.
      case "registerHub":
        if (tabId == null) return;
        return (async () => {
          const s = await load();
          const key = String(tabId);
          const p = s[key] ?? { room: msg.room, webTabId: tabId, url: "" };
          p.room = msg.room;
          p.webTabId = tabId;
          s[key] = p;
          await save(s);
          if (p.siteTabId != null) notifyHub(p, "open"); // satellite already live
          return { ok: true };
        })();

      // User gesture on the hub: get the source playing in its own tab. Reuse an
      // on-source tab that ISN'T already someone's hub/satellite (the creator's own
      // tab), else open a fresh one (a joiner / a second window), then drive it.
      case "openSatellite":
        if (tabId == null) return;
        return (async () => {
          const s = await load();
          const key = String(tabId);
          const p = s[key] ?? { room: msg.room, webTabId: tabId, url: msg.url };
          p.room = msg.room;
          p.webTabId = tabId;
          p.url = msg.url;
          s[key] = p;
          const taken = new Set<number>();
          for (const x of Object.values(s)) {
            if (x.webTabId != null) taken.add(x.webTabId);
            if (x.siteTabId != null) taken.add(x.siteTabId);
          }
          const tabs = await browser.tabs.query({});
          const existing = tabs.find(
            (t) => t.id != null && !taken.has(t.id) && t.url != null && sameSource(t.url, msg.url),
          );
          const target = existing ?? (await browser.tabs.create({ url: msg.url, active: true }));
          p.siteTabId = target.id;
          await save(s);
          if (existing?.id != null) {
            // Already loaded → assign proactively + focus it (a fresh tab instead
            // self-announces via satelliteHello once its content script boots).
            toTab(existing.id, { kind: "assignSatellite", room: msg.room, active: true });
            void browser.tabs.update(existing.id, { active: true });
          }
          return { ok: true };
        })();

      // A site tab's content script booted and asks whether it's a satellite.
      case "satelliteHello":
        if (tabId == null) return;
        return (async () => {
          const p = bySite(await load(), tabId);
          return { room: p?.room ?? null };
        })();

      // The satellite confirms it's driving → let its hub know it's live.
      case "registerSatellite":
        if (tabId == null) return;
        return (async () => {
          const s = await load();
          const p = bySite(s, tabId);
          if (p) {
            p.url = msg.src;
            await save(s);
            notifyHub(p, "open");
          }
          return { ok: true };
        })();

      // The hub is done (left / switched off a site source).
      case "unpair":
        if (tabId == null) return;
        return (async () => {
          const s = await load();
          const p = s[String(tabId)];
          if (p) {
            standDown(p);
            delete s[String(tabId)];
            await save(s);
          }
          return { ok: true };
        })();

      // Bridge traffic — route by the SENDING tab: hub→its satellite, satellite→its hub.
      case "relay":
        if (tabId == null) return;
        return (async () => {
          const s = await load();
          if (msg.dir === "down") toTab(s[String(tabId)]?.siteTabId, msg);
          else toTab(bySite(s, tabId)?.webTabId, msg as RelayUpMessage);
        })();
    }
  });

  // A tab vanished — tear down the half that's gone and tell the survivor.
  browser.tabs.onRemoved.addListener(async (closedId) => {
    const s = await load();
    let dirty = false;
    for (const key of Object.keys(s)) {
      const p = s[key];
      if (p.siteTabId === closedId) {
        notifyHub(p, "closed");
        p.siteTabId = undefined;
        dirty = true;
      } else if (p.webTabId === closedId) {
        standDown(p); // hub gone → satellite stops driving
        delete s[key];
        dirty = true;
      }
    }
    if (dirty) await save(s);
  });
});
