/**
 * Cross-tab protocol — web room page ↔ background ↔ streaming-site tab (§11).
 *
 * For a frame-forbidding `site` source the web room page is the hub (it owns the
 * WebSocket and renders members/chat/call/queue), but the actual `<video>` lives
 * in a SEPARATE tab (e.g. netflix.com) that the page can't reach with
 * `window.postMessage`. So we route the SAME bridge messages
 * (`PageToFrameMessage`/`FrameToPageMessage`) through the extension background
 * service worker — the only MV3 context that can `tabs.sendMessage` between two
 * arbitrary tabs.
 *
 * Path (one browser, local pairing — NOT cross-user):
 *   App.svelte (CrossTabBridge)
 *     ──window.postMessage──▶ web-page content script
 *     ──runtime.sendMessage─▶ BACKGROUND  ──tabs.sendMessage──▶ site content script
 *   …and the reverse for status/localControl/tracks/ended.
 *
 * Still "move the URL and the clock, never the bytes": these carry the same
 * positions/intents the in-iframe bridge does, never media.
 */

import type { FrameToPageMessage, PageToFrameMessage } from "./bridge.ts";

/** Tag on the window.postMessage hop (page ↔ its content script), so the content
 *  script can tell xtab messages apart from bridge/picker postMessages. */
export const XTAB_TAG = "sixseven-xtab" as const;

// ── hub (web page) → background ───────────────────────────────────────────────

/** The web room page announces itself as the hub for `room` (background records
 *  its tab id so it can route `up` relays here). Sent on connect. */
export interface RegisterHubMessage {
  kind: "registerHub";
  room: string;
}

/** User gesture on the hub: open `url` in a new tab and pair it as the satellite
 *  playing for `room`. */
export interface OpenSatelliteMessage {
  kind: "openSatellite";
  room: string;
  url: string;
}

/** The hub is done with `room` (left / switched away from a site source). */
export interface UnpairMessage {
  kind: "unpair";
  room: string;
}

// ── satellite (site tab) → background ─────────────────────────────────────────

/** A site tab's content script asks on load "am I a satellite?" — background
 *  matches it against pending/known pairings by tab id and assigns if so. */
export interface SatelliteHelloMessage {
  kind: "satelliteHello";
  url: string;
}

/** A site tab confirms it is now driving `room` (after being assigned). Carries
 *  its own URL for the hub's display. */
export interface RegisterSatelliteMessage {
  kind: "registerSatellite";
  room: string;
  src: string;
}

// ── background → satellite (site tab) ─────────────────────────────────────────

/** Background tells a site tab to start (`active:true`) or stand down
 *  (`active:false`, e.g. the hub tab closed) driving `room`. */
export interface AssignSatelliteMessage {
  kind: "assignSatellite";
  room: string;
  active: boolean;
}

// ── background → hub (web page) ───────────────────────────────────────────────

/** Background tells the hub the lifecycle state of its satellite tab. */
export interface SatelliteStateMessage {
  kind: "satelliteState";
  room: string;
  /** `open` = paired & live · `closed` = the tab went away · `none` = not opened yet. */
  state: "open" | "closed" | "none";
}

// ── relay (carries a bridge message in either direction) ──────────────────────

/** Hub → satellite: an `apply`/subtitle/overlay command for the site's video. */
export interface RelayDownMessage {
  kind: "relay";
  dir: "down";
  room: string;
  msg: PageToFrameMessage;
}

/** Satellite → hub: a `status`/`localControl`/`tracks`/`ended` report. */
export interface RelayUpMessage {
  kind: "relay";
  dir: "up";
  room: string;
  msg: FrameToPageMessage;
}

export type RelayMessage = RelayDownMessage | RelayUpMessage;

/** Everything that flows over the cross-tab channel. */
export type XtabMessage =
  | RegisterHubMessage
  | OpenSatelliteMessage
  | UnpairMessage
  | SatelliteHelloMessage
  | RegisterSatelliteMessage
  | AssignSatelliteMessage
  | SatelliteStateMessage
  | RelayMessage;

// ── window.postMessage envelope (page ↔ content script hop only) ──────────────

export interface XtabEnvelope {
  tag: typeof XTAB_TAG;
  msg: XtabMessage;
}

export function wrapXtab(msg: XtabMessage): XtabEnvelope {
  return { tag: XTAB_TAG, msg };
}

/** Validate + unwrap a window.postMessage payload; null if it isn't an xtab msg. */
export function unwrapXtab(data: unknown): XtabMessage | null {
  if (!data || typeof data !== "object") return null;
  const env = data as Partial<XtabEnvelope>;
  if (env.tag !== XTAB_TAG || !env.msg) return null;
  return env.msg;
}
