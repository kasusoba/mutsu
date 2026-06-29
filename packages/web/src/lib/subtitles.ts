/**
 * Subtitle parsing (SPEC §13). Now hosted in `@mutsu/protocol/subtitles` so
 * the web room page and the extension (own-tab mode) parse uploads identically.
 * Re-exported here to keep existing room-page imports stable.
 */

export { parseSubtitles } from "@mutsu/protocol/subtitles";
