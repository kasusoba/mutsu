/**
 * SubDL provider (api.subdl.com). Far more generous free limit (2000 req/day);
 * smaller catalog, coarser matching. Used as the volume fallback. Returns a ZIP
 * download URL, so we unzip in the worker and pick the subtitle file.
 */

import { unzipSync } from "fflate";
import {
  QuotaError,
  type SearchQuery,
  type SubEnv,
  type SubProvider,
  type SubResult,
} from "./types.ts";
import { toVtt } from "./vtt.ts";

const API = "https://api.subdl.com/api/v1/subtitles";
const DL = "https://dl.subdl.com";

interface SubdlResponse {
  status?: boolean;
  error?: string;
  subtitles?: Array<{
    release_name?: string;
    name?: string;
    lang?: string;
    language?: string;
    url?: string;
    author?: string;
  }>;
}

export const subdl: SubProvider = {
  name: "subdl",

  enabled(env) {
    return Boolean(env.SUBDL_API_KEY);
  },

  async search(q: SearchQuery, env): Promise<SubResult[]> {
    const langs = (q.languages ?? "en")
      .split(",")
      .map((l) => l.trim().slice(0, 2).toUpperCase())
      .join(",");
    const params = new URLSearchParams({
      api_key: env.SUBDL_API_KEY ?? "",
      film_name: q.query,
      languages: langs,
      subs_per_page: "30",
    });
    if (q.season != null) params.set("season_number", String(q.season));
    if (q.episode != null) params.set("episode_number", String(q.episode));

    const res = await fetch(`${API}?${params}`);
    if (res.status === 429) throw new QuotaError("subdl");
    if (!res.ok) return [];
    const json = (await res.json()) as SubdlResponse;
    if (json.status === false) {
      if (/limit|quota|exceeded/i.test(json.error ?? "")) throw new QuotaError("subdl");
      return [];
    }

    const results: SubResult[] = [];
    for (const s of json.subtitles ?? []) {
      if (!s.url) continue;
      results.push({
        id: `subdl:${s.url}`,
        provider: "subdl",
        title: s.name ?? s.release_name ?? q.query,
        language: (s.language ?? s.lang ?? "en").toLowerCase(),
        release: s.release_name ?? undefined,
      });
    }
    return results;
  },

  async fetchVtt(providerId, _env): Promise<string> {
    const url = providerId.startsWith("/") ? `${DL}${providerId}` : `${DL}/${providerId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`subdl download failed: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());

    const files = unzipSync(buf);
    const pick =
      Object.keys(files).find((n) => /\.vtt$/i.test(n)) ??
      Object.keys(files).find((n) => /\.srt$/i.test(n)) ??
      Object.keys(files)[0];
    if (!pick) throw new Error("subdl: empty archive");
    const text = new TextDecoder("utf-8").decode(files[pick]);
    return toVtt(text);
  },
};
