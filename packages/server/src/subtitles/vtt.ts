/**
 * SubRip (.srt) → WebVTT (.vtt) conversion + light normalization. Our overlay
 * engine renders WebVTT cues itself (SPEC §13), so every provider's output is
 * normalized to VTT here before it leaves the proxy.
 */

/** True if the text already looks like WebVTT. */
function isVtt(text: string): boolean {
  return /^﻿?WEBVTT/.test(text);
}

/** `00:00:01,234` (srt) → `00:00:01.234` (vtt). Also pads `H:MM:SS` forms. */
function fixTimestamp(ts: string): string {
  const t = ts.trim().replace(",", ".");
  // Ensure HH:MM:SS.mmm (some srt use M:SS or MM:SS.mmm).
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!m) return t;
  const [, h = "0", min = "00", sec = "00", ms = "000"] = m;
  const pad = (s: string, n = 2) => s.padStart(n, "0");
  return `${pad(h)}:${pad(min)}:${pad(sec)}.${ms.padEnd(3, "0")}`;
}

const CUE_TIMING =
  /(\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3}/;

/** Convert SRT (or pass through VTT) to a clean WebVTT string. */
export function toVtt(input: string): string {
  const text = input.replace(/\r\n/g, "\n").replace(/^﻿/, "");
  if (isVtt(text)) return text;

  const out: string[] = ["WEBVTT", ""];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    // Drop a leading numeric counter line if present.
    if (/^\d+$/.test(lines[0]?.trim() ?? "")) lines.shift();
    const timing = lines[0] ?? "";
    if (!CUE_TIMING.test(timing)) continue;
    const [start, end] = timing.split("-->");
    const cueTiming = `${fixTimestamp(start ?? "")} --> ${fixTimestamp(end ?? "")}`;
    const body = lines.slice(1).join("\n");
    out.push(cueTiming, body, "");
  }
  return out.join("\n");
}
