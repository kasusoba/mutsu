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
import {
  type AreYouRoomReply,
  collectFrameCandidates,
  type DeliverSourceReply,
  type MediaCandidate,
  PICKER_DELIVER,
  PICKER_PING,
  rankCandidates,
} from "../../lib/picker";
import { icon } from "./icons";
import { initOwnTab } from "./ownTab";

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
  try {
    const reply = (await browser.tabs.sendMessage(tabId, {
      type: PICKER_DELIVER,
      url,
      srcKind,
    })) as DeliverSourceReply | undefined;
    if (reply?.ok) {
      const room = rooms.find((r) => r.tabId === tabId)?.room ?? "room";
      notice(`Sent to ${room} ✓`, "ok");
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
    btn.addEventListener("click", () => deliver(c.url, c.kind));
    listEl.append(btn);
  }
}

function renderRooms(): void {
  if (!rooms.length) {
    targetRow.hidden = true;
    return;
  }
  targetRow.hidden = false;
  roomSelect.replaceChildren();
  for (const r of rooms) {
    const opt = document.createElement("option");
    opt.value = String(r.tabId);
    opt.textContent = r.room;
    roomSelect.append(opt);
  }
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
    const results = await browser.scripting.executeScript({
      target: { tabId: active.id, allFrames: true },
      func: collectFrameCandidates,
    });
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

async function discoverRooms(): Promise<RoomTab[]> {
  const tabs = await browser.tabs.query({});
  const found: RoomTab[] = [];
  await Promise.all(
    tabs.map(async (t) => {
      if (!t.id || !/^https?:/i.test(t.url ?? "")) return;
      try {
        const reply = (await browser.tabs.sendMessage(t.id, {
          type: PICKER_PING,
        })) as AreYouRoomReply | undefined;
        if (reply?.room) found.push({ tabId: t.id, room: reply.room, title: t.title ?? "" });
      } catch {
        // No content script on that tab (or it's not loaded) — not a room.
      }
    }),
  );
  console.debug(`[sixseven] discovered ${found.length} room tab(s)`, found);
  return found;
}

manualSend.prepend(icon("send", 14));
manualSend.addEventListener("click", () => {
  const url = manualInput.value.trim();
  if (url) deliver(url);
});
manualInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && manualInput.value.trim()) deliver(manualInput.value.trim());
});

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
    // Prioritise the most useful problem: a scan error first (we couldn't even
    // look), then a missing room (we looked but you've nowhere to send it).
    if (scanError) {
      notice(scanError, "err");
    } else if (!rooms.length) {
      notice("No open sixseven room found. Open & join your room link, then Rescan.", "err");
    }
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

async function main(): Promise<void> {
  // The own-tab "watch together" section runs independently of the room picker.
  initOwnTab().catch((e) => console.warn("[sixseven] own-tab init failed", e));
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
