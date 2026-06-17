/**
 * Video call (§17) — ICE server config for WebRTC.
 *
 * STUN is free and unlimited (`stun.cloudflare.com`); a couple at home almost
 * always connects peer-to-peer with STUN alone. TURN (a media relay, the only
 * piece that costs egress) is added ONLY when the room env carries Cloudflare
 * Realtime TURN keys — generated as short-lived credentials so the secret key
 * never reaches the client. No keys → STUN-only, still fully functional.
 *
 * The keys stay server-side (same model as the subtitle/GIF proxy keys); the
 * server only ever hands the client an ICE-server list, never media.
 */

export interface RtcEnv {
  /** Cloudflare Realtime TURN key id + API token (optional — STUN-only without). */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

/** Matches the browser's `RTCIceServer` shape (urls + optional creds). */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const STUN_ONLY: IceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

/**
 * Build the ICE-server list for a call. Returns Cloudflare's STUN by default;
 * if TURN keys are present, mints short-lived TURN credentials and returns the
 * full list (STUN + TURN). Any failure falls back to STUN-only — a call still
 * works for the common (P2P-reachable) case.
 */
export async function iceServers(env: RtcEnv): Promise<IceServer[]> {
  const id = env.TURN_KEY_ID;
  const token = env.TURN_KEY_API_TOKEN;
  if (!id || !token) return STUN_ONLY;
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
    if (!res.ok) return STUN_ONLY; // bad/expired token → degrade to STUN-only
    const json = (await res.json()) as { iceServers?: IceServer[] };
    return Array.isArray(json.iceServers) && json.iceServers.length ? json.iceServers : STUN_ONLY;
  } catch {
    return STUN_ONLY; // couldn't reach the TURN API → STUN-only
  }
}
