/**
 * SubtitleController — per-viewer subtitle state (SPEC §13). Holds the active
 * cues + personal style/offset, drives the panel UI, and pushes changes straight
 * to the content script via the bridge (subtitles are never synced to the room).
 */

import {
  DEFAULT_SUBTITLE_STYLE,
  type SubtitleCue,
  type SubtitleStyle,
  type TrackInfo,
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

  /** Caption tracks the source's own player exposes (§13), reported by the frame. */
  embeddedTracks = $state<TrackInfo[]>([]);
  /** Which embedded track is active (its cues render in the frame's layer), or null. */
  selectedTrackId = $state<string | null>(null);

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
    // A re-hooked frame lost its track selection — replay it so the embed's own
    // captions come back. Its cues live in the frame, so only the id round-trips.
    if (this.selectedTrackId !== null) this.bridge.selectTrack(this.selectedTrackId);
  }

  /** The frame told us which caption tracks the source exposes (§13). */
  setTracks(tracks: TrackInfo[]): void {
    this.embeddedTracks = tracks;
    // If our selected track vanished (video swap), drop the stale selection.
    if (this.selectedTrackId !== null && !tracks.some((t) => t.id === this.selectedTrackId)) {
      this.selectedTrackId = null;
    }
  }

  /** Turn one of the source's own caption tracks on (or null = off). Mutually
   *  exclusive with an uploaded/searched file — both feed the one frame layer. */
  selectEmbeddedTrack(trackId: string | null): void {
    this.selectedTrackId = trackId;
    if (trackId === null) {
      this.activeLabel = null;
      this.bridge.selectTrack(null);
      return;
    }
    // Embedded cues render in the frame, not here — clear any uploaded cues and
    // hand the track id down; the frame reads its cues into the same layer.
    const label = this.embeddedTracks.find((t) => t.id === trackId)?.label || "captions";
    this.cues = null;
    this.activeLabel = `site · ${label}`;
    this.error = null;
    this.bridge.setSubtitles(null);
    this.bridge.selectTrack(trackId);
  }

  private setCues(cues: SubtitleCue[], label: string): void {
    // Uploaded/searched subs win over an embedded track — turn it off first.
    if (this.selectedTrackId !== null) {
      this.selectedTrackId = null;
      this.bridge.selectTrack(null);
    }
    this.cues = cues;
    this.activeLabel = label;
    this.error = cues.length === 0 ? "No cues found in that file." : null;
    this.sendCues();
  }

  clear(): void {
    if (this.selectedTrackId !== null) {
      this.selectedTrackId = null;
      this.bridge.selectTrack(null);
    }
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
