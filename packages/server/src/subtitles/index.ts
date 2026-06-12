/**
 * Subtitle orchestrator — runs the enabled providers per the configured order
 * (default OpenSubtitles for quality, SubDL for volume). Search merges results
 * from all providers so the user can pick; download routes by the result's
 * provider prefix and falls through to the quota-safe error.
 */

import { opensubtitles } from "./opensubtitles.ts";
import { subdl } from "./subdl.ts";
import {
  QuotaError,
  type SearchQuery,
  type SubEnv,
  type SubProvider,
  type SubResult,
} from "./types.ts";

const ALL: Record<string, SubProvider> = {
  opensubtitles,
  subdl,
};

function ordered(env: SubEnv): SubProvider[] {
  const order = (env.SUBS_PROVIDER_ORDER ?? "opensubtitles,subdl")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return order.map((name) => ALL[name]).filter((p): p is SubProvider => p?.enabled(env) ?? false);
}

/** Merged search across providers, in configured order (provider-labelled). */
export async function searchSubtitles(q: SearchQuery, env: SubEnv): Promise<SubResult[]> {
  const providers = ordered(env);
  const settled = await Promise.allSettled(providers.map((p) => p.search(q, env)));
  const out: SubResult[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") out.push(...r.value);
  }
  return out;
}

/** Resolve a `${provider}:${id}` to WebVTT. Throws QuotaError if over limit. */
export async function downloadSubtitle(id: string, env: SubEnv): Promise<string> {
  const sep = id.indexOf(":");
  if (sep < 0) throw new Error("bad subtitle id");
  const providerName = id.slice(0, sep);
  const providerId = id.slice(sep + 1);
  const provider = ALL[providerName];
  if (!provider || !provider.enabled(env)) throw new Error(`provider unavailable: ${providerName}`);
  return provider.fetchVtt(providerId, env);
}

export { QuotaError };
export type { SearchQuery, SubEnv, SubResult };
