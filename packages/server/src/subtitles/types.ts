/**
 * Subtitle proxy types (SPEC §13, §17 resolved). The DO proxies subtitle TEXT
 * (search JSON + KB-sized cue files) — control-plane data, never video bytes.
 * This stays on the right side of the §2 principle ("no server in the video
 * path") and the §3 lines (no DRM/extraction/header-forging).
 *
 * Providers are swappable behind one interface so we're never locked in and can
 * fall back when one provider's daily quota is spent.
 */

/** A normalized search hit. `id` is provider-prefixed so download routes back. */
export interface SubResult {
  /** `${provider}:${providerSpecificId}` — opaque to the client. */
  id: string;
  provider: string;
  /** Human label: movie/episode title. */
  title: string;
  /** ISO-ish language code, e.g. "en". */
  language: string;
  /** Release/version hint (e.g. "1080p.WEB.x264"), if the provider gives one. */
  release?: string;
  /** Provider download count, if exposed (helps rank). */
  downloads?: number;
}

export interface SearchQuery {
  query: string;
  /** Comma-separated language codes; defaults to "en". */
  languages?: string;
  season?: number;
  episode?: number;
}

/** Env bag passed to providers (subset of `room.env`). */
export interface SubEnv {
  OPENSUBTITLES_API_KEY?: string;
  OS_USERNAME?: string;
  OS_PASSWORD?: string;
  SUBDL_API_KEY?: string;
  SUBS_PROVIDER_ORDER?: string;
  /** GIPHY search key (§14 fun layer); proxied so it never reaches the client. */
  GIPHY_API_KEY?: string;
}

export interface SubProvider {
  readonly name: string;
  /** Available iff its key is configured. */
  enabled(env: SubEnv): boolean;
  search(q: SearchQuery, env: SubEnv): Promise<SubResult[]>;
  /** Resolve a provider-specific id to WebVTT text. */
  fetchVtt(providerId: string, env: SubEnv): Promise<string>;
}

/** Raised when a provider is over quota — lets the orchestrator fall back. */
export class QuotaError extends Error {
  constructor(public provider: string) {
    super(`${provider}: subtitle quota exhausted`);
    this.name = "QuotaError";
  }
}
