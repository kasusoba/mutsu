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

/** Renders the own-tab section; resolves true if this tab is in an active party
 *  (so the popup can open on the "Watch here" tab). */
export async function initOwnTab(rootIn?: HTMLElement): Promise<boolean> {
  const root = rootIn ?? document.getElementById("ownTab");
  if (!root) return false;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const active: ActiveTab | null =
    tab?.id && /^https?:/i.test(tab.url ?? "")
      ? { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" }
      : null;

  const nickname = await loadNickname();
  const existing = active ? await partyForUrl(active.url) : null;

  if (existing && active) {
    renderActive(root, active, existing);
    return true;
  }
  renderEntry(root, active, nickname);
  return false;
}

// ── active party on this tab ──────────────────────────────────────────────────

function renderActive(root: HTMLElement, active: ActiveTab, party: OwnTabParty): void {
  root.innerHTML = `
    <div class="ot-card">
      <div class="ot-mode">Watch on this page</div>
      <div class="ot-row"><span class="ot-title">In a party</span><span class="ot-code">${party.code}</span></div>
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

  // The widget can be hidden from the widget itself OR from here — reflect the
  // real stored state in the label, not the static "Hide widget" default.
  const hideBtn = root.querySelector<HTMLElement>("#otHide");
  const labelHide = (hidden: boolean) => {
    if (hideBtn) hideBtn.textContent = hidden ? "Show widget" : "Hide widget";
  };
  browser.storage.local.get(HIDDEN_KEY).then((g) => labelHide(Boolean(g[HIDDEN_KEY])));
  // Keep the label right if the widget is hidden from the widget while we're open.
  const onStore = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === "local" && changes[HIDDEN_KEY]) labelHide(Boolean(changes[HIDDEN_KEY].newValue));
  };
  browser.storage.onChanged.addListener(onStore);
  window.addEventListener("pagehide", () => browser.storage.onChanged.removeListener(onStore));

  root.querySelector("#otCopy")?.addEventListener("click", () => {
    navigator.clipboard.writeText(party.code).catch(() => {});
  });
  hideBtn?.addEventListener("click", async () => {
    const cur = (await browser.storage.local.get(HIDDEN_KEY))[HIDDEN_KEY];
    const next = !cur;
    await browser.tabs.sendMessage(active.id, { type: MSG_SET_WIDGET_HIDDEN, hidden: next }).catch(() => {});
    await browser.storage.local.set({ [HIDDEN_KEY]: next });
    labelHide(next);
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
      <div class="ot-mode">Watch on this page</div>
      <div class="ot-desc">Sync this site's video with friends — each of you watches in their own tab.</div>

      <label class="ot-field"><span>Your name</span>
        <input id="otNick" class="ot-input" placeholder="e.g. alice" value="${escapeHtml(nickname)}" autocomplete="off" />
        <span class="ot-fieldhint">Shown to everyone — used whether you start or join.</span>
      </label>

      <div class="ot-divider"><span>start a party</span></div>
      <button id="otStart" class="ot-btn primary block" ${active ? "" : "disabled"}>Start a new party on this tab</button>
      ${active ? "" : '<div class="ot-hint">Open a page with a video to start a party.</div>'}

      <div class="ot-divider"><span>or join a party</span></div>
      <div class="ot-join">
        <input id="otCode" class="ot-input" placeholder="paste room code" autocomplete="off" />
        <button id="otJoin" class="ot-btn">Join</button>
      </div>
      <div class="ot-join-result" id="otJoinResult"></div>
    </div>`;

  const nickEl = root.querySelector<HTMLInputElement>("#otNick");
  const codeEl = root.querySelector<HTMLInputElement>("#otCode");
  const joinBtn = root.querySelector<HTMLButtonElement>("#otJoin");
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
    if (!resultEl || !joinBtn) return;
    if (!code) {
      codeEl?.focus();
      return;
    }
    await saveNickname(nick());
    joinBtn.disabled = true;
    resultEl.textContent = "Looking up that party…";
    let settled = false;

    // Observer-peek the room to learn its source URL before sending you there.
    const obs = new RoomSocket(
      { host: PARTYKIT_HOST, room: code, secret: code, name: nick(), observer: true },
      {
        onSync: () => {
          if (settled) return;
          const src = obs.sync?.src;
          const kind = obs.sync?.srcKind;
          if (kind !== "site" || !src) {
            resultEl.textContent = "That party hasn't picked a video yet — try again in a moment.";
            joinBtn.disabled = false;
            return;
          }
          settled = true;
          const onIt = active && sameSource(active.url, src);
          // Show the name we'll join AS — makes a wrong name (e.g. the code typed
          // into the name box) immediately obvious before committing.
          resultEl.innerHTML = `<div class="ot-found">Found — watching <b>${escapeHtml(host(src))}</b></div>
            <button id="otGo" class="ot-btn primary block">${onIt ? "Join" : "Open &amp; join"} as ${escapeHtml(nick())}</button>`;
          resultEl.querySelector("#otGo")?.addEventListener("click", async () => {
            await saveParty({ code, nickname: nick(), sourceUrl: src, role: "joiner" });
            obs.destroy();
            if (onIt && active) {
              await browser.tabs.sendMessage(active.id, { type: MSG_START_OWNTAB }).catch(() => {});
              await initOwnTab(root);
            } else {
              await browser.tabs.create({ url: src });
            }
          });
        },
      },
    );
    // Give it a moment; if no sync arrives the code is probably wrong.
    setTimeout(() => {
      if (settled) return;
      resultEl.textContent = "Couldn't find a party with that code.";
      joinBtn.disabled = false;
      obs.destroy();
    }, 4000);
    window.addEventListener("pagehide", () => obs.destroy());
  };

  joinBtn?.addEventListener("click", doJoin);
  codeEl?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") doJoin();
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
