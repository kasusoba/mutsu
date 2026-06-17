/**
 * Picker popup (SPEC §12, ARCHITECTURE §10.3) — "share to room".
 *
 * Scans the tab you're browsing for `<video>`/`<iframe>` sources, lists the open
 * sixseven room tabs, and on a click hands the chosen URL to a room page (which
 * calls `setSource`). It never touches video bytes — it moves a URL (SPEC §2).
 *
 * Discovery is done live (no background worker): we ping every http(s) tab and
 * the content script answers whether it's a room. Delivery routes through that
 * same content script, which posts the URL to the room page on its own origin.
 */

import { browser } from "wxt/browser";
import { WEB_APP_URL } from "../../lib/config";
import {
  type AreYouRoomReply,
  type DeliverSourceReply,
  type MediaCandidate,
  PICKER_DELIVER,
  PICKER_PING,
  collectFrameCandidates,
  rankCandidates,
} from "../../lib/picker";
import { icon } from "./icons";
import { initOwnTab } from "./ownTab";

const ROOM_ADJ = ["cosy", "late", "rainy", "neon", "velvet", "amber", "quiet", "lucky"];
const ROOM_NOUN = ["sofa", "lounge", "den", "balcony", "cinema", "loft", "patio", "booth"];

/** A URL-safe capability secret — mirrors the web's `makeSecret` (§10). */
function makeSecret(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A friendly default room name — mirrors the web's `makeRoomName`. */
function makeRoomName(): string {
  const buf = new Uint8Array(3);
  crypto.getRandomValues(buf);
  const adj = ROOM_ADJ[(buf[0] ?? 0) % ROOM_ADJ.length] ?? "cosy";
  const noun = ROOM_NOUN[(buf[1] ?? 0) % ROOM_NOUN.length] ?? "lounge";
  return `${adj}-${noun}-${10 + ((buf[2] ?? 0) % 90)}`;
}

/** Open a freshly-minted room on the deployed web page, optionally pre-loaded
 *  with a source (`?src=…&kind=…`, applied once the creator joins). */
function createRoom(url?: string, kind?: "embed" | "direct"): void {
  const name = makeRoomName();
  let path = `/r/${encodeURIComponent(name)}`;
  if (url) {
    const q = new URLSearchParams({ src: url });
    if (kind) q.set("kind", kind);
    path += `?${q.toString()}`;
  }
  path += `#k=${makeSecret()}`;
  browser.tabs.create({ url: WEB_APP_URL + path });
  window.close();
}

interface RoomTab {
  tabId: number;
  room: string;
  title: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const listEl = $("list");
const targetRow = $("targetRow");
const roomSelect = $<HTMLSelectElement>("room");
const countEl = $("count");
const noticeEl = $("notice");
const manualInput = $<HTMLInputElement>("manualUrl");
const manualSend = $<HTMLButtonElement>("manualSend");
const rescanBtn = $<HTMLButtonElement>("rescan");
const newRoomBtn = $<HTMLButtonElement>("newRoom");
const sendModeRow = $("sendModeRow");
const sendModeBox = $<HTMLInputElement>("sendMode");
const queueModeRow = $("queueModeRow");

/** "Send to an open room" is only possible when a room tab exists AND the user
 *  ticked the box; otherwise the popup creates a brand-new room. */
function sendMode(): boolean {
  return rooms.length > 0 && sendModeBox.checked;
}

/** A picked source (a scanned video or the paste box): create a room with it, or
 *  send it to an open room — depending on the mode. */
function act(url: string, kind?: "embed" | "direct"): void {
  if (sendMode()) deliver(url, kind);
  else createRoom(url, kind);
}

/** Reflect the current mode: show send-related controls only when sending. */
function updateModeUI(): void {
  sendModeRow.hidden = rooms.length === 0;
  if (rooms.length === 0) sendModeBox.checked = false;
  const sending = sendMode();
  targetRow.hidden = !sending;
  queueModeRow.hidden = !sending;
  manualSend.textContent = sending ? "send" : "new room";
}

let rooms: RoomTab[] = [];
// Last scan's failure reason (if any), shown to the user instead of being
// swallowed — a silent empty list is indistinguishable from a real error.
let scanError: string | null = null;

function notice(msg: string, kind: "ok" | "err"): void {
  noticeEl.textContent = msg;
  noticeEl.className = kind;
}

function selectedRoomTab(): number | null {
  if (!rooms.length) return null;
  const id = Number(roomSelect.value);
  return Number.isFinite(id) ? id : rooms[0].tabId;
}

async function deliver(url: string, srcKind?: "embed" | "direct"): Promise<void> {
  const tabId = selectedRoomTab();
  if (tabId === null) {
    notice("Open your sixseven room page in another tab, then reopen this.", "err");
    return;
  }
  const queue = $<HTMLInputElement>("queueMode").checked;
  try {
    const reply = (await browser.tabs.sendMessage(tabId, {
      type: PICKER_DELIVER,
      url,
      srcKind,
      queue,
    })) as DeliverSourceReply | undefined;
    if (reply?.ok) {
      const room = rooms.find((r) => r.tabId === tabId)?.room ?? "room";
      notice(`${queue ? "Queued in" : "Sent to"} ${room} ✓`, "ok");
    } else {
      notice("Couldn't reach the room tab — is it still open?", "err");
    }
  } catch {
    notice("Couldn't reach the room tab — reload it and try again.", "err");
  }
}

function host(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function renderCandidates(candidates: MediaCandidate[]): void {
  listEl.replaceChildren();
  countEl.textContent = candidates.length ? `${candidates.length} found` : "";
  if (!candidates.length) {
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No video or embed found on this tab. Try the paste box below.";
    listEl.append(div);
    return;
  }
  for (const c of candidates) {
    const btn = document.createElement("button");
    btn.className = "cand";
    btn.type = "button";

    const ico = document.createElement("span");
    ico.className = "ico";
    ico.append(icon(c.type === "iframe" ? "embed" : c.direct ? "video" : "page"));

    const meta = document.createElement("div");
    meta.className = "meta";
    const url = document.createElement("div");
    url.className = "url";
    url.textContent = c.direct ? c.url : host(c.url);
    const sub = document.createElement("div");
    sub.className = "sub";
    const dims = c.width && c.height ? `${c.width}×${c.height}` : "";
    sub.textContent = [
      c.type === "iframe" ? "embed" : c.direct ? "video" : "page with player",
      dims,
    ]
      .filter(Boolean)
      .join(" · ");
    meta.append(url, sub);

    btn.append(ico, meta);
    if (c.playing) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "playing";
      btn.append(tag);
    }
    btn.addEventListener("click", () => act(c.url, c.kind));
    listEl.append(btn);
  }
}

function renderRooms(): void {
  roomSelect.replaceChildren();
  for (const r of rooms) {
    const opt = document.createElement("option");
    opt.value = String(r.tabId);
    opt.textContent = r.room;
    roomSelect.append(opt);
  }
  updateModeUI(); // show/hide the send-mode controls based on whether rooms exist
}

async function scanActiveTab(): Promise<MediaCandidate[]> {
  scanError = null;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active?.id) {
    scanError = "No active tab to scan.";
    return [];
  }
  if (!/^https?:/i.test(active.url ?? "")) {
    scanError = "This isn't a web page the extension can scan (chrome://, store, PDF…).";
    return [];
  }
  try {
    const results = await withTimeout(
      browser.scripting.executeScript({
        target: { tabId: active.id, allFrames: true },
        func: collectFrameCandidates,
      }),
      8000,
    );
    const merged = rankCandidates(results.map((r) => (r.result as MediaCandidate[]) ?? []));
    console.debug(`[sixseven] scanned ${active.url} → ${merged.length} candidate(s)`, merged);
    return merged;
  } catch (e) {
    // Host access not granted, restricted page, or the frame rejected injection.
    scanError = `Can't scan this page: ${(e as Error)?.message ?? "unknown error"}`;
    console.warn("[sixseven] scan failed", e);
    return [];
  }
}

/** Race a promise against a timeout — a frozen/discarded background tab can leave
 *  `tabs.sendMessage` pending forever, which would hang the whole scan. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function discoverRooms(): Promise<RoomTab[]> {
  const tabs = await browser.tabs.query({});
  const found: RoomTab[] = [];
  await Promise.all(
    tabs.map(async (t) => {
      if (!t.id || !/^https?:/i.test(t.url ?? "")) return;
      try {
        const reply = (await withTimeout(
          browser.tabs.sendMessage(t.id, { type: PICKER_PING }),
          1500,
        )) as AreYouRoomReply | undefined;
        if (reply?.room) found.push({ tabId: t.id, room: reply.room, title: t.title ?? "" });
      } catch {
        // No content script, not loaded, or unresponsive (frozen tab) — not a room.
      }
    }),
  );
  console.debug(`[sixseven] discovered ${found.length} room tab(s)`, found);
  return found;
}

manualSend.addEventListener("click", () => {
  const url = manualInput.value.trim();
  if (url) act(url);
});
manualInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && manualInput.value.trim()) act(manualInput.value.trim());
});
newRoomBtn.addEventListener("click", () => createRoom());
sendModeBox.addEventListener("change", updateModeUI);

let scanning = false;

async function refresh(): Promise<void> {
  if (scanning) return;
  scanning = true;
  rescanBtn.disabled = true;
  rescanBtn.textContent = "Scanning…";
  try {
    const [candidates, found] = await Promise.all([scanActiveTab(), discoverRooms()]);
    rooms = found;
    renderRooms();
    renderCandidates(candidates);
    // Only a scan error is worth surfacing now — "no open room" is no longer a
    // problem since creating a fresh room is the default action.
    if (scanError) notice(scanError, "err");
  } catch (e) {
    console.warn("[sixseven] refresh failed", e);
    notice(`Something went wrong: ${(e as Error)?.message ?? "unknown error"}`, "err");
  } finally {
    scanning = false;
    rescanBtn.disabled = false;
    rescanBtn.textContent = "Rescan";
  }
}

rescanBtn.addEventListener("click", refresh);

const TAB_KEY = "sixseven:popupTab";

/** Two modes, one at a time: own-tab "watch here" vs the send-to-room picker. */
async function initTabs(forced?: "here" | "room"): Promise<void> {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"));
  const panels: Record<string, HTMLElement> = {
    here: $("herePanel"),
    room: $("roomPanel"),
  };
  const select = (name: string) => {
    for (const t of tabs) t.classList.toggle("active", t.dataset.tab === name);
    for (const [key, el] of Object.entries(panels)) el.hidden = key !== name;
    browser.storage.local.set({ [TAB_KEY]: name });
  };
  for (const t of tabs) t.addEventListener("click", () => select(t.dataset.tab ?? "here"));
  const saved = (await browser.storage.local.get(TAB_KEY))[TAB_KEY];
  // Default to the Room tab (creating "our room" is the main flow); only fall
  // back to "Watch on this page" when explicitly forced or last used.
  select(forced ?? (saved === "here" ? "here" : "room"));
}

async function main(): Promise<void> {
  // If this tab is already in an own-tab party, open on "Watch here" so the user
  // sees it; otherwise fall back to the last-used tab.
  const inParty = await initOwnTab().catch((e) => {
    console.warn("[sixseven] own-tab init failed", e);
    return false;
  });
  initTabs(inParty ? "here" : undefined).catch((e) =>
    console.warn("[sixseven] tabs init failed", e),
  );
  await refresh();
  // Players (and room pages) often mount their <video>/attribute asynchronously,
  // after the popup's first scan. If we came up empty, retry once shortly — this
  // catches late-loading embeds without making the user click Rescan.
  if (!listEl.querySelector(".cand") || !rooms.length) {
    setTimeout(() => {
      if (!listEl.querySelector(".cand") || !rooms.length) refresh();
    }, 1200);
  }
}

main();
