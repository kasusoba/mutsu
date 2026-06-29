/**
 * OpenSubtitles provider (api.opensubtitles.com REST). Best catalog + hash
 * matching; free downloads are limited (5/day, or 20/day if OS_USERNAME/PASSWORD
 * are set to log in). We proxy so the API key never reaches the client.
 */

import {
  QuotaError,
  type SearchQuery,
  type SubEnv,
  type SubProvider,
  type SubResult,
} from "./types.ts";
import { toVtt } from "./vtt.ts";

const BASE = "https://api.opensubtitles.com/api/v1";
const UA = "mutsu/0.1";

interface OsSearchResponse {
  data?: Array<{
    attributes?: {
      language?: string;
      download_count?: number;
      release?: string;
      feature_details?: { title?: string; movie_name?: string };
      files?: Array<{ file_id?: number; file_name?: string }>;
    };
  }>;
}

function headers(env: SubEnv, token?: string): HeadersInit {
  const h: Record<string, string> = {
    "Api-Key": env.OPENSUBTITLES_API_KEY ?? "",
    "User-Agent": UA,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function login(env: SubEnv): Promise<string | undefined> {
  if (!env.OS_USERNAME || !env.OS_PASSWORD) return undefined;
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ username: env.OS_USERNAME, password: env.OS_PASSWORD }),
  });
  if (!res.ok) return undefined;
  const json = (await res.json()) as { token?: string };
  return json.token;
}

export const opensubtitles: SubProvider = {
  name: "opensubtitles",

  enabled(env) {
    return Boolean(env.OPENSUBTITLES_API_KEY);
  },

  async search(q: SearchQuery, env): Promise<SubResult[]> {
    const params = new URLSearchParams({
      query: q.query,
      languages: (q.languages ?? "en").toLowerCase(),
      // Best-first: most-downloaded is the API's strongest quality signal.
      order_by: "download_count",
      order_direction: "desc",
    });
    if (q.season != null) params.set("season_number", String(q.season));
    if (q.episode != null) params.set("episode_number", String(q.episode));
    if (q.season != null || q.episode != null) params.set("type", "episode");

    const res = await fetch(`${BASE}/subtitles?${params}`, { headers: headers(env) });
    if (res.status === 429) throw new QuotaError("opensubtitles");
    if (!res.ok) return [];
    const json = (await res.json()) as OsSearchResponse;

    const results: SubResult[] = [];
    for (const item of json.data ?? []) {
      const a = item.attributes;
      const fileId = a?.files?.[0]?.file_id;
      if (!a || fileId == null) continue;
      results.push({
        id: `opensubtitles:${fileId}`,
        provider: "opensubtitles",
        title: a.feature_details?.title ?? a.feature_details?.movie_name ?? q.query,
        language: a.language ?? "en",
        release: a.release ?? undefined,
        downloads: a.download_count ?? undefined,
      });
    }
    return results;
  },

  async fetchVtt(providerId, env): Promise<string> {
    const token = await login(env);
    const res = await fetch(`${BASE}/download`, {
      method: "POST",
      headers: headers(env, token),
      body: JSON.stringify({ file_id: Number(providerId) }),
    });
    if (res.status === 406 || res.status === 429) throw new QuotaError("opensubtitles");
    if (!res.ok) throw new Error(`opensubtitles download failed: ${res.status}`);
    const json = (await res.json()) as { link?: string };
    if (!json.link) throw new Error("opensubtitles: no download link");

    const file = await fetch(json.link);
    if (!file.ok) throw new Error(`opensubtitles file fetch failed: ${file.status}`);
    return toVtt(await file.text());
  },
};
