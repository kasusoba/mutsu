/**
 * SubtitleController — per-viewer subtitle state (SPEC §13). Holds the active
 * cues + personal style/offset, drives the panel UI, and pushes changes straight
 * to the content script via the bridge (subtitles are never synced to the room).
 */

import {
  DEFAULT_SUBTITLE_STYLE,
  type SubtitleCue,
  type SubtitleStyle,
} from "@sixseven/protocol/bridge";
import type { PageBridge } from "./bridge";
import type { RoomClient, SubResult } from "./room.svelte";
import { parseSubtitles } from "./subtitles";

export class SubtitleController {
  cues = $state<SubtitleCue[] | null>(null);
  activeLabel = $state<string | null>(null);
  style = $state<SubtitleStyle>({ ...DEFAULT_SUBTITLE_STYLE });

  results = $state<SubResult[]>([]);
  searching = $state(false);
  error = $state<string | null>(null);

  constructor(
    private readonly room: RoomClient,
    private readonly bridge: PageBridge,
  ) {}

  // The bridge does a structured clone (postMessage). Svelte $state values are
  // Proxies, which are NOT cloneable — passing one silently fails to cross the
  // frame. So ALWAYS send a plain `$state.snapshot()` over the bridge.
  private sendCues(): void {
    this.bridge.setSubtitles(this.cues ? $state.snapshot(this.cues) : null);
  }
  private sendStyle(): void {
    this.bridge.setSubtitleStyle($state.snapshot(this.style));
  }

  /** Re-push current subtitle state to a frame that just engaged (App calls this). */
  resend(): void {
    this.sendStyle();
    this.sendCues();
  }

  private setCues(cues: SubtitleCue[], label: string): void {
    this.cues = cues;
    this.activeLabel = label;
    this.error = cues.length === 0 ? "No cues found in that file." : null;
    this.sendCues();
  }

  clear(): void {
    this.cues = null;
    this.activeLabel = null;
    this.sendCues();
  }

  async loadFile(file: File): Promise<void> {
    const text = await file.text();
    this.setCues(parseSubtitles(text), file.name);
  }

  async search(query: string, season?: number, episode?: number): Promise<void> {
    if (!query.trim()) return;
    this.searching = true;
    this.error = null;
    try {
      const { results } = await this.room.subsSearch(query.trim(), "en", season, episode);
      // Best-first: most-downloaded on top (the providers' strongest quality
      // signal). We also ask the server to order, but sort here too so mixed
      // providers / older servers still rank sensibly.
      this.results = [...results].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
      if (results.length === 0) this.error = "No subtitles found — try the show's exact title.";
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.searching = false;
    }
  }

  async loadResult(r: SubResult): Promise<void> {
    this.searching = true;
    this.error = null;
    try {
      const { vtt } = await this.room.subsDownload(r.id);
      this.setCues(parseSubtitles(vtt), `${r.title}${r.release ? ` · ${r.release}` : ""}`);
      this.results = [];
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.searching = false;
    }
  }

  // ── personal style / sync ───────────────────────────────────────────────

  patchStyle(patch: Partial<SubtitleStyle>): void {
    this.style = { ...this.style, ...patch };
    this.sendStyle();
  }
  nudgeOffset(deltaMs: number): void {
    this.patchStyle({ offsetMs: this.style.offsetMs + deltaMs });
  }
}
