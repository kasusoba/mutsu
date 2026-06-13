/**
 * Popup "Watch together" section (§11) — create or join an own-tab watch party.
 *
 * No invite links: you share the room CODE out-of-band and people enter it here.
 * On join we connect briefly as an `observer` to read the room's source URL, so
 * we can show "Now watching X — [Open & join]" before sending you there. The
 * real member is the source tab's content script, not this popup.
 */

import { browser } from "wxt/browser";
import type { GateMessage, Member, MemberId, MemberStatus } from "@sixseven/protocol";
import {
  loadNickname,
  makeCode,
  MSG_GET_STATE,
  MSG_SET_WIDGET_HIDDEN,
  MSG_START_OWNTAB,
  MSG_STOP_OWNTAB,
  type OwnTabParty,
  PARTYKIT_HOST,
  partyForUrl,
  removeParty,
  sameSource,
  saveNickname,
  saveParty,
} from "../../lib/config";
import { RoomSocket } from "../../lib/roomSocket";

interface PartyState {
  code: string;
  connected: boolean;
  members: Member[];
  gate: GateMessage;
  selfId: MemberId | null;
  playerStatus: MemberStatus;
}

const HIDDEN_KEY = "sixseven:widgetHidden";

function host(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

interface ActiveTab {
  id: number;
  url: string;
  title: string;
}

export async function initOwnTab(rootIn?: HTMLElement): Promise<void> {
  const root = rootIn ?? document.getElementById("ownTab");
  if (!root) return;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const active: ActiveTab | null =
    tab?.id && /^https?:/i.test(tab.url ?? "")
      ? { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" }
      : null;

  const nickname = await loadNickname();
  const existing = active ? await partyForUrl(active.url) : null;

  if (existing && active) renderActive(root, active, existing);
  else renderEntry(root, active, nickname);
}

// ── active party on this tab ──────────────────────────────────────────────────

function renderActive(root: HTMLElement, active: ActiveTab, party: OwnTabParty): void {
  root.innerHTML = `
    <div class="ot-card">
      <div class="ot-row"><span class="ot-title">Watch party</span><span class="ot-code">${party.code}</span></div>
      <div class="ot-status" id="otStatus">connecting…</div>
      <ul class="ot-members" id="otMembers"></ul>
      <div class="ot-actions">
        <button id="otHide" class="ot-btn">Hide widget</button>
        <button id="otCopy" class="ot-btn">Copy code</button>
        <button id="otLeave" class="ot-btn danger">Leave</button>
      </div>
    </div>`;

  const statusEl = root.querySelector<HTMLElement>("#otStatus");
  const membersEl = root.querySelector<HTMLElement>("#otMembers");

  // Ask the source tab's controller for live state — the popup never opens its
  // own connection, so it can't show up as a phantom member.
  const poll = async () => {
    const st = (await browser.tabs
      .sendMessage(active.id, { type: MSG_GET_STATE })
      .catch(() => null)) as PartyState | null;
    if (!st) {
      if (statusEl) statusEl.textContent = "starting on this tab…";
      return;
    }
    if (statusEl) {
      statusEl.textContent = !st.connected
        ? "reconnecting…"
        : st.gate.paused
          ? `waiting for ${st.gate.waitingFor.length} to buffer…`
          : st.playerStatus === "loading"
            ? "loading the video…"
            : st.playerStatus === "failed"
              ? "no video found on this page"
              : "in sync";
    }
    if (membersEl) {
      membersEl.innerHTML = st.members
        .map((m) => `<li><span class="md ${m.status}"></span>${escapeHtml(m.name)}</li>`)
        .join("");
    }
  };
  poll();
  const pollId = setInterval(poll, 1500);
  window.addEventListener("pagehide", () => clearInterval(pollId));

  root.querySelector("#otCopy")?.addEventListener("click", () => {
    navigator.clipboard.writeText(party.code).catch(() => {});
  });
  root.querySelector("#otHide")?.addEventListener("click", async () => {
    const cur = (await browser.storage.local.get(HIDDEN_KEY))[HIDDEN_KEY];
    const next = !cur;
    await browser.tabs.sendMessage(active.id, { type: MSG_SET_WIDGET_HIDDEN, hidden: next }).catch(() => {});
    await browser.storage.local.set({ [HIDDEN_KEY]: next });
    const btn = root.querySelector("#otHide");
    if (btn) btn.textContent = next ? "Show widget" : "Hide widget";
  });
  root.querySelector("#otLeave")?.addEventListener("click", async () => {
    clearInterval(pollId);
    await removeParty(party.sourceUrl);
    await browser.tabs.sendMessage(active.id, { type: MSG_STOP_OWNTAB }).catch(() => {});
    await initOwnTab(root);
  });
}

// ── create / join entry ───────────────────────────────────────────────────────

function renderEntry(root: HTMLElement, active: ActiveTab | null, nickname: string): void {
  root.innerHTML = `
    <div class="ot-card">
      <div class="ot-row"><span class="ot-title">Watch together</span></div>
      <input id="otNick" class="ot-input" placeholder="your nickname" value="${escapeHtml(nickname)}" />
      <button id="otStart" class="ot-btn primary" ${active ? "" : "disabled"}>Watch together on this tab</button>
      <div class="ot-or">or join a code</div>
      <div class="ot-join">
        <input id="otCode" class="ot-input" placeholder="e.g. K7Q2ABCD" autocomplete="off" />
        <button id="otJoin" class="ot-btn">Join</button>
      </div>
      <div class="ot-join-result" id="otJoinResult"></div>
      ${active ? "" : '<div class="ot-hint">Open a page with a video to start a party here.</div>'}
    </div>`;

  const nickEl = root.querySelector<HTMLInputElement>("#otNick");
  const codeEl = root.querySelector<HTMLInputElement>("#otCode");
  const resultEl = root.querySelector<HTMLElement>("#otJoinResult");

  const nick = () => (nickEl?.value.trim() || "anon");

  root.querySelector("#otStart")?.addEventListener("click", async () => {
    if (!active) return;
    await saveNickname(nick());
    const party: OwnTabParty = {
      code: makeCode(),
      nickname: nick(),
      sourceUrl: active.url,
      role: "creator",
      createMode: "open",
    };
    await saveParty(party);
    await browser.tabs.sendMessage(active.id, { type: MSG_START_OWNTAB }).catch(() => {});
    await initOwnTab(root);
  });

  const doJoin = async () => {
    const code = (codeEl?.value || "").trim().toUpperCase();
    if (!code || !resultEl) return;
    await saveNickname(nick());
    resultEl.textContent = "Looking up that party…";

    // Observer-peek the room to learn its source URL before sending you there.
    const obs = new RoomSocket(
      { host: PARTYKIT_HOST, room: code, secret: code, name: nick(), observer: true },
      {
        onSync: () => {
          const src = obs.sync?.src;
          const kind = obs.sync?.srcKind;
          if (kind !== "site" || !src) {
            resultEl.textContent =
              "That party has no own-tab source yet (the host hasn't picked one).";
            return;
          }
          // Already on the source? join in place. Otherwise offer to open it.
          if (active && sameSource(active.url, src)) {
            resultEl.innerHTML = `<button id="otJoinHere" class="ot-btn primary">Join — you're on it ✓</button>`;
            resultEl.querySelector("#otJoinHere")?.addEventListener("click", async () => {
              await saveParty({ code, nickname: nick(), sourceUrl: src, role: "joiner" });
              await browser.tabs.sendMessage(active.id, { type: MSG_START_OWNTAB }).catch(() => {});
              obs.destroy();
              await initOwnTab(root);
            });
          } else {
            resultEl.innerHTML = `<div class="ot-now">Now watching <b>${escapeHtml(host(src))}</b></div><button id="otOpen" class="ot-btn primary">Open &amp; join</button>`;
            resultEl.querySelector("#otOpen")?.addEventListener("click", async () => {
              await saveParty({ code, nickname: nick(), sourceUrl: src, role: "joiner" });
              obs.destroy();
              await browser.tabs.create({ url: src });
            });
          }
        },
      },
    );
    // Give it a moment; if no sync arrives the code is probably wrong.
    setTimeout(() => {
      if (resultEl.textContent === "Looking up that party…") {
        resultEl.textContent = "Couldn't reach that party — check the code.";
        obs.destroy();
      }
    }, 4000);
    window.addEventListener("pagehide", () => obs.destroy());
  };

  root.querySelector("#otJoin")?.addEventListener("click", doJoin);
  codeEl?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") doJoin();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
