/**
 * Subtitle parsing for the room page (SPEC §13). Turns uploaded/fetched
 * WebVTT or SubRip text into `SubtitleCue[]` (times in seconds) that we send
 * to the content script to render over the video. Online-search results arrive
 * already normalized to VTT by the proxy, but we parse SRT too for local uploads.
 */

import type { SubtitleCue } from "@sixseven/protocol/bridge";

/** `HH:MM:SS.mmm` / `MM:SS,mmm` / `H:MM:SS` → seconds. */
function toSeconds(ts: string): number {
  const t = ts.trim().replace(",", ".");
  const parts = t.split(":");
  if (parts.length === 0) return 0;
  let s = 0;
  for (const p of parts) s = s * 60 + Number.parseFloat(p);
  return Number.isFinite(s) ? s : 0;
}

const TIMING =
  /((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3})/;

/** Parse WebVTT or SRT into cues. Tolerant of counter lines and cue settings. */
export function parseSubtitles(input: string): SubtitleCue[] {
  const text = input
    .replace(/\r\n/g, "\n")
    .replace(/^﻿/, "")
    .replace(/^WEBVTT.*?\n/, "");
  const cues: SubtitleCue[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    if (/^\d+$/.test(lines[0]?.trim() ?? "")) lines.shift(); // drop SRT counter
    const timingLine = lines[0] ?? "";
    const m = timingLine.match(TIMING);
    if (!m) continue;
    const start = toSeconds(m[1] ?? "");
    const end = toSeconds(m[2] ?? "");
    const body = lines
      .slice(1)
      .join("\n")
      .replace(/<[^>]+>/g, ""); // strip simple inline tags
    if (body.trim()) cues.push({ start, end, text: body });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}
