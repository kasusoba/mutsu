/**
 * GIPHY search proxy (§14, fun layer). The DO proxies the search so the API key
 * never reaches the client — same control-plane category as the subtitle proxy
 * (it moves a GIF URL + metadata, never video bytes; §2). Each viewer then loads
 * the chosen GIF first-party from GIPHY's CDN.
 */

const BASE = "https://api.giphy.com/v1/gifs/search";

/** A normalized GIF search hit. `url` is the GIF to broadcast; `preview` is a
 *  smaller still/loop for the picker grid. */
export interface GifResult {
  id: string;
  url: string;
  preview: string;
  width: number;
  height: number;
}

interface GiphyImage {
  url?: string;
  width?: string;
  height?: string;
}

export async function searchGifs(query: string, key: string): Promise<GifResult[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({
    api_key: key,
    q,
    limit: "24",
    rating: "pg-13",
    bundle: "messaging_non_clips",
  });
  const res = await fetch(`${BASE}?${params}`);
  if (!res.ok) {
    // Surface GIPHY's reason (e.g. an invalid/unactivated key → 401/403) instead
    // of silently returning no results — otherwise a bad key looks like "no gifs".
    let detail = "";
    try {
      const j = (await res.json()) as { message?: string; meta?: { msg?: string } };
      detail = j?.message ?? j?.meta?.msg ?? "";
    } catch {
      /* non-JSON body */
    }
    throw new Error(`GIPHY ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ id?: string; images?: Record<string, GiphyImage> }>;
  };

  const out: GifResult[] = [];
  for (const g of json.data ?? []) {
    const img = g.images?.fixed_width;
    const small = g.images?.fixed_width_small ?? img;
    if (!img?.url || !g.id) continue;
    out.push({
      id: g.id,
      url: img.url,
      preview: small?.url ?? img.url,
      width: Number(img.width ?? 0),
      height: Number(img.height ?? 0),
    });
  }
  return out;
}
