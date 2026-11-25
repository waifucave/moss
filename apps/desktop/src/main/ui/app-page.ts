// MCP Apps views (spec §5.5 "MCP Apps", the extension `io.modelcontextprotocol/ui` 2026-01-26): the documents the app serves
// for ONE view, pure so they are unit-tested. A view is a `WebContentsView` of its own session whose top document is the
// host page below: it holds the server's page in an inner `<iframe sandbox="allow-scripts">` (no `allow-same-origin`: the
// page has an opaque origin, so it cannot read the host page, the app, a cookie or a file), and relays the page's
// JSON-RPC to the engine through `fetch` on its own scheme. The page itself is served with the content policy the engine
// built from its declared domains (default: no network), so it reaches only what the extension lets it.
import { APP_SCHEME, webHeaders } from "./documents";

/** The most a page may post in one message, in UTF-16 units (the engine's own bound; the relay checks it first). */
export const APP_RELAY_MAX = 1_000_000;

/** The host page's own policy: its one script is the app's, the page is its one frame, and the relay is its one fetch. */
export const HOST_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

export function hostDocument(id: string, token: string): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta name="moss-app-token" content="${token}">`,
    "<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{border:0;display:block;width:100%;height:100%;color-scheme:light dark}</style>",
    // The relay's script comes BEFORE the frame: the page posts its first message (`ui/initialize`) the moment its own script runs, and a
    // message posted before the host's listener exists is dropped (nothing queues it), so the page would wait for an answer for ever. A
    // blocking script in the head has run before the parser creates the frame.
    '<script src="/host.js"></script>',
    "</head><body>",
    `<iframe id="v" sandbox="allow-scripts" src="${APP_SCHEME}://${id}/view" referrerpolicy="no-referrer"></iframe>`,
    "</body></html>",
  ].join("\n");
}

/** The relay. It forwards only JSON-RPC 2.0 objects that came from its own frame, bounded, and posts back what the engine
 *  answers; it decides nothing. `__mossTeardown` is the extension's `ui/resource-teardown`, which the app calls before the
 *  view closes and waits briefly for the page's answer. */
export const HOST_SCRIPT = `(() => {
  // The script runs before the frame exists (see hostDocument), so the frame is looked up when a message needs it, never at load.
  const frameOf = () => document.getElementById("v");
  const token = document.querySelector('meta[name="moss-app-token"]').content;
  const post = (m) => { try { const f = frameOf(); if (f && f.contentWindow) f.contentWindow.postMessage(m, "*"); } catch (e) {} };
  window.addEventListener("message", async (e) => {
    const frame = frameOf();
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data;
    if (d === null || typeof d !== "object" || d.jsonrpc !== "2.0") return;
    let body;
    try { body = JSON.stringify(d); } catch (e2) { return; }
    if (typeof body !== "string" || body.length > ${APP_RELAY_MAX}) return;
    try {
      const r = await fetch("/_bridge", { method: "POST", headers: { "content-type": "application/json", "x-moss-app-token": token }, body });
      if (!r.ok) {
        if (d.id !== undefined && typeof d.method === "string") post({ jsonrpc: "2.0", id: d.id, error: { code: -32000, message: "the host refused that" } });
        return;
      }
      const out = await r.json();
      if (out && Array.isArray(out.messages)) for (const m of out.messages) post(m);
    } catch (e3) { /* the host is gone */ }
  });
  window.__mossTeardown = () => new Promise((resolve) => {
    const id = "teardown-" + Date.now();
    const done = (ev) => { const f = frameOf(); if (f && ev.source === f.contentWindow && ev.data && ev.data.id === id) { window.removeEventListener("message", done); resolve(); } };
    window.addEventListener("message", done);
    post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: { reason: "the view was closed" } });
    setTimeout(resolve, 250);
  });
})();
`;

/** Headers of the host page and its script: the app's own, with no isolation pair (as a web page's). */
export function hostHeaders(contentType: string): Record<string, string> {
  return { ...webHeaders(), "Content-Type": contentType, "Content-Security-Policy": HOST_CSP };
}

/** Headers of the page itself: the engine's content policy, and nothing else a page could use (`webHeaders` carries the
 *  permissions policy that gives it no camera, microphone, location or clipboard). */
export function pageHeaders(csp: string): Record<string, string> {
  return { ...webHeaders(), "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp };
}

/** Whether a navigation inside the view stays in it: the host page and the page, on the view's own origin, and nothing else
 *  (`about:srcdoc` and `about:blank` carry no content a page could use to leave). */
export function appNavigationAllowed(id: string, url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const u = new URL(url);
    return u.protocol === `${APP_SCHEME}:` && u.host === id && (u.pathname === "/" || u.pathname === "/view") && u.search === "" && u.hash === "";
  } catch {
    return false;
  }
}

/** The origins the page's own policy names (its declared domains, `https://host[:port]`, a leading `*.` for subdomains): the
 *  ONLY network the view's session reaches, a second belt beside the policy. None declared: none. */
export function appAllowedOrigins(csp: string): string[] {
  return [...new Set(csp.match(/https:\/\/[^\s;]+/g) ?? [])];
}
/** `origins` are the ones `appAllowedOrigins` read from the policy. The app's own scheme, `data:` and `blob:` always pass; an `https:`
 *  request passes only to a declared origin (host and port, a wildcard covering subdomains), never to "any https" once one is declared. */
export function appRequestAllowed(url: string, origins: readonly string[]): boolean {
  if (/^(moss-app|data|blob):/.test(url)) return true;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return false;
  const port = u.port === "" ? "443" : u.port;
  for (const o of origins) {
    let d: URL;
    try { d = new URL(o.replace("://*.", "://")); } catch { continue; }
    if ((d.port === "" ? "443" : d.port) !== port) continue;
    if (o.startsWith("https://*.") ? u.hostname.endsWith(`.${d.hostname}`) : u.hostname === d.hostname) return true;
  }
  return false;
}

/** Who may place an MCP Apps page: only a part that draws a conversation, which is a part its OK let read one (spec §5.4:
 *  `sessions.read` for code sessions, `conversation.read` for bots'), the same rule that lets it see the call whose page this is.
 *  Enforced in main (`moss:app-view`): any other part's request changes nothing. */
export function mayPlaceAppView(capabilities: ReadonlySet<string>): boolean {
  return capabilities.has("sessions.read") || capabilities.has("conversation.read");
}
