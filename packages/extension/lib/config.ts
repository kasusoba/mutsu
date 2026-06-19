/**
 * Extension config (§11).
 *
 * The extension no longer owns any WebSocket — the web room page is the hub for
 * every party. The extension's jobs are (a) the popup launcher, which opens a
 * freshly-minted room on the deployed web page, and (b) the content-script
 * satellite, which the background relay pairs to a room to drive a frame-forbidding
 * site's `<video>`. So all this module holds is the web app URL and a small
 * same-source helper shared by the popup and the background.
 */

/** The web room page the popup opens (`/r/<name>#k=<secret>`). Defaults to the
 *  deployed page in production builds and the local Vite dev server under
 *  `wxt dev` (`import.meta.env.DEV`), so local testing "just works" without an
 *  edit. Override with `WXT_WEB_APP_URL` (e.g. a tunnel host or a non-default
 *  port: `WXT_WEB_APP_URL=http://localhost:4000 pnpm --filter @sixseven/extension build`). */
const ENV = import.meta.env as Record<string, string | undefined>;
export const WEB_APP_URL =
  ENV.WXT_WEB_APP_URL ||
  (import.meta.env.DEV ? "http://localhost:5173" : "https://sixseven-3kc.pages.dev");

/** Two URLs identify the same source if origin + pathname match (ignore
 *  query/hash — streaming sites tack on tracking params, hash routing, etc.).
 *  Used to reuse an already-open tab when pairing a site satellite. */
export function sameSource(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.origin === ub.origin && ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "")
    );
  } catch {
    return a === b;
  }
}
