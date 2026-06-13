/**
 * Inline Lucide SVG icons for the popup, so the extension surface matches the
 * web app (which uses lucide-svelte). Same stroke geometry, just hand-inlined
 * because the popup is vanilla DOM, not Svelte. Keep these paths in sync with
 * the Lucide icon set if you bump the web dependency.
 */

const PATHS: Record<string, string> = {
  // a framed embed / iframe surface
  embed: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 8h20"/><path d="M6 4v4"/><path d="M10 4v4"/>',
  // a direct video file/stream
  video: '<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/>',
  // a page that merely contains a player
  page: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};

/** Build a Lucide-style SVG element for `name` at the given pixel size. */
export function icon(name: keyof typeof PATHS | string, size = 16): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = PATHS[name] ?? PATHS.video;
  return svg;
}
