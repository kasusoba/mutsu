/**
 * Extension config + own-tab party storage (§11).
 *
 * Own-tab mode is fully extension-driven — no web room page. The only backend is
 * the PartyKit relay (content-neutral clock). The party code IS the room name
 * AND the capability: a single token users share out-of-band (Discord, etc.),
 * entered in the popup. No invite links — nothing external touches our state.
 */

import { browser } from "wxt/browser";

/**
 * The deployed PartyKit relay the extension talks to (mirrors the web's baked
 * VITE_PARTYKIT_HOST). Change this if you self-host a different backend.
 */
export const PARTYKIT_HOST = "sixseven.kasusoba.partykit.dev";

// popup ↔ source-tab content script (own-tab mode)
export const MSG_START_OWNTAB = "sixseven:start-owntab" as const;
export const MSG_STOP_OWNTAB = "sixseven:stop-owntab" as const;
export const MSG_SET_WIDGET_HIDDEN = "sixseven:set-widget-hidden" as const;
/** Popup asks the source tab's controller for a live state snapshot (so the
 *  popup never opens its own connection — no phantom member). */
export const MSG_GET_STATE = "sixseven:get-state" as const;

export type PartyRole = "creator" | "joiner";

/** Personal fun-layer display settings (§14) — how YOU see reactions/gifs/chat
 *  bubbles over the video. Not synced; gates display only. */
export interface FunSettings {
  reactions: boolean;
  gifs: boolean;
  bubbles: boolean;
  speed: "fast" | "normal" | "slow";
}
export const FUN_DEFAULTS: FunSettings = { reactions: true, gifs: true, bubbles: true, speed: "normal" };
export const FUN_SPEED_MULT: Record<FunSettings["speed"], number> = { fast: 0.5, normal: 1, slow: 1.9 };
const FUN_KEY = "sixseven:funSettings";

export async function loadFunSettings(): Promise<FunSettings> {
  const got = await browser.storage.local.get(FUN_KEY);
  return { ...FUN_DEFAULTS, ...((got[FUN_KEY] as Partial<FunSettings>) ?? {}) };
}
export async function saveFunSettings(s: FunSettings): Promise<void> {
  await browser.storage.local.set({ [FUN_KEY]: s });
}

/** An active own-tab party this browser is part of (one per source tab). */
export interface OwnTabParty {
  /** Room name AND shared capability — the short code users exchange. */
  code: string;
  nickname: string;
  /** Page URL where the video lives ("open this to watch"). */
  sourceUrl: string;
  role: PartyRole;
  /** Creator's chosen control mode (honoured only on the room-creating join). */
  createMode?: "open" | "host";
}

export const PARTIES_KEY = "sixseven:ownTabParties";
const NICK_KEY = "sixseven:nick";

export async function getParties(): Promise<OwnTabParty[]> {
  const got = await browser.storage.local.get(PARTIES_KEY);
  const list = got[PARTIES_KEY];
  return Array.isArray(list) ? (list as OwnTabParty[]) : [];
}

async function setParties(list: OwnTabParty[]): Promise<void> {
  await browser.storage.local.set({ [PARTIES_KEY]: list });
}

/** Add/replace a party, keyed by normalized source URL. */
export async function saveParty(party: OwnTabParty): Promise<void> {
  const list = (await getParties()).filter((p) => !sameSource(p.sourceUrl, party.sourceUrl));
  list.push(party);
  await setParties(list);
}

export async function removeParty(sourceUrl: string): Promise<void> {
  const list = (await getParties()).filter((p) => !sameSource(p.sourceUrl, sourceUrl));
  await setParties(list);
}

/** The active party for a given page URL, if this tab is a party source. */
export async function partyForUrl(url: string): Promise<OwnTabParty | null> {
  return (await getParties()).find((p) => sameSource(p.sourceUrl, url)) ?? null;
}

export async function loadNickname(): Promise<string> {
  const got = await browser.storage.local.get(NICK_KEY);
  return typeof got[NICK_KEY] === "string" ? (got[NICK_KEY] as string) : "";
}

export async function saveNickname(nick: string): Promise<void> {
  await browser.storage.local.set({ [NICK_KEY]: nick });
}

/** Two URLs identify the same source if origin + pathname match (ignore
 *  query/hash — streaming sites tack on tracking params, hash routing, etc.). */
export function sameSource(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "");
  } catch {
    return a === b;
  }
}

/** A short, readable, shareable party code (room name + capability). ~41 bits. */
export function makeCode(len = 8): string {
  // No 0/O/1/I/L to avoid read-aloud ambiguity.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[(buf[i] ?? 0) % alphabet.length];
  return out;
}
