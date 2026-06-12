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

let rooms: RoomTab[] = [];

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
    ico.textContent = c.type === "iframe" ? "▣" : "▶";

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
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active?.id) return [];
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: active.id, allFrames: true },
      func: collectFrameCandidates,
    });
    return rankCandidates(results.map((r) => (r.result as MediaCandidate[]) ?? []));
  } catch {
    // Restricted page (chrome://, the web store, a PDF viewer, etc.).
    notice("Can't scan this page. Open the site with the video, then reopen this.", "err");
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
  return found;
}

manualSend.addEventListener("click", () => {
  const url = manualInput.value.trim();
  if (url) deliver(url);
});
manualInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && manualInput.value.trim()) deliver(manualInput.value.trim());
});

async function main(): Promise<void> {
  const [candidates, found] = await Promise.all([scanActiveTab(), discoverRooms()]);
  rooms = found;
  renderRooms();
  renderCandidates(candidates);
  if (!rooms.length) {
    notice("No open sixseven room found. Open your room link, then reopen this.", "err");
  }
}

main();
