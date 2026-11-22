// MCP Apps (spec §5.5, §14.2 item 66): what the engine reads of an MCP server's page and how much it believes of it.
// Built against the MCP Apps extension `io.modelcontextprotocol/ui`, specification 2026-01-26 (SEP-1865):
//   * a tool names its page in `_meta.ui.resourceUri` (the flat `_meta["ui/resourceUri"]` is the deprecated spelling,
//     read too), and who may call it in `_meta.ui.visibility` (`model`, `app`; default both);
//   * the page is a `ui://` resource of mime type `text/html;profile=mcp-app`, as `text` or a base64 `blob`;
//   * its `_meta.ui.csp` declares the domains it needs (`connectDomains`, `resourceDomains`, `frameDomains`,
//     `baseUriDomains`); without them the default policy has no network at all.
//
// EVERYTHING HERE IS A SERVER'S OWN WORDS, so it is untrusted: the uri is checked before a read, the size before and
// after decoding, the mime type exactly, and each declared domain is reduced to a plain https origin (or refused);
// anything else in the metadata is ignored, and the page never gets a permission (camera, microphone, location,
// clipboard: the spec's rule is that the page "gets none", §5.5). Pure, so the hostile cases are unit-tested.
import { MCP_APP_HTML_MAX } from "@waifucave/moss-protocol";

/** The extension's id and the version these rules were written against (quoted in the lane's report). */
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
export const MCP_APPS_SPEC_VERSION = "2026-01-26";
export const UI_MIME = "text/html;profile=mcp-app";
export const UI_URI_MAX = 2_048;
/** The most declared domains of one kind, and of all kinds together; a page that declares more is refused, not trimmed. */
export const CSP_DOMAINS_PER_KIND_MAX = 16;

/** Why a page or a request was refused: a code for the logs and the tests, words for the person and the page. */
export class McpAppRefusal extends Error {
  constructor(readonly code: McpAppRefusalCode, message: string) {
    super(message);
    this.name = "McpAppRefusal";
  }
}
export type McpAppRefusalCode =
  | "not_a_ui_uri" | "no_such_server" | "no_such_tool" | "not_app_visible" | "not_found" | "wrong_mime_type" | "too_large"
  | "bad_content" | "bad_csp" | "refused_by_user" | "no_session" | "not_here" | "bad_message" | "unsupported" | "timeout" | "failed";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A `ui://` address: the scheme, then something, printable ASCII only, bounded. */
export function isUiUri(v: unknown): v is string {
  return typeof v === "string" && v.length >= 6 && v.length <= UI_URI_MAX && /^ui:\/\/[!-~]+$/.test(v);
}

/** The page a tool names (`_meta.ui.resourceUri`, or the deprecated `_meta["ui/resourceUri"]`), when it is a `ui://` address. */
export function uiResourceUriOf(tool: { _meta?: unknown }): string | undefined {
  const meta = tool._meta;
  if (!isObject(meta)) return undefined;
  const ui = meta["ui"];
  const named = isObject(ui) && Object.hasOwn(ui, "resourceUri") ? ui["resourceUri"] : Object.hasOwn(meta, "ui/resourceUri") ? meta["ui/resourceUri"] : undefined;
  return isUiUri(named) ? named : undefined;
}

export type ToolVisibility = "model" | "app";

/** Who may call a tool (`_meta.ui.visibility`): an absent or malformed list is the default, both. */
export function toolVisibilityOf(tool: { _meta?: unknown }): readonly ToolVisibility[] {
  const meta = tool._meta;
  const ui = isObject(meta) ? meta["ui"] : undefined;
  const raw = isObject(ui) ? ui["visibility"] : undefined;
  if (!Array.isArray(raw)) return ["model", "app"];
  const seen = new Set<ToolVisibility>();
  for (const v of raw) if (v === "model" || v === "app") seen.add(v);
  // A list with nothing valid in it is no promise to anyone: it is the default, never "no one" and never "everyone's choice".
  return seen.size === 0 ? ["model", "app"] : [...seen];
}

/** The declared domains, already reduced to plain origins. */
export interface UiCsp {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
}

export const NO_CSP: UiCsp = { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] };

/** Names a person's own machine or network answers to, whatever the address behind them: never a page's to reach. */
const LOCAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|home\.arpa)$/;

/** One declared domain as a CSP source: an `https://host[:port]` origin (a leading `*.` host wildcard allowed, covering the
 *  subdomains of a name of at least two labels), nothing else. No path, query, credentials, other scheme, bare `*`, quote,
 *  semicolon or space: a value that would let a declaration write more policy than a host is refused. THE PAGE'S REACH
 *  STOPS AT THE PUBLIC INTERNET: an address (any all-numeric label, so every dotted IPv4 form), a name for this machine or
 *  a private network (`localhost`, `.local`, `.internal`, …) and a wildcard on a bare top-level name (`*.com`) are refused. */
export function cspSourceOf(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0 || v.length > 253) return undefined;
  const m = /^https:\/\/((?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::([0-9]{1,5}))?$/i.exec(v);
  if (m === null) return undefined;
  if (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65_535)) return undefined;
  const host = m[1]!.toLowerCase();
  const wildcard = host.startsWith("*.");
  const labels = (wildcard ? host.slice(2) : host).split(".");
  // The last label of a real name has a letter (a top-level name is never all digits): an all-numeric one is an address.
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return undefined;
  if (LOCAL_NAME.test(labels.join("."))) return undefined;
  // A wildcard covers one name's subdomains and no more: the pattern above already needs the base to have two labels (`*.com` never matches).
  return `https://${host}${m[2] === undefined ? "" : `:${Number(m[2])}`}`;
}

/** `_meta.ui.csp` as the server declared it. Absent: no network. Declared but malformed (not an object, a kind that is not
 *  a list, a bad or too many domains): refused, so a page never runs with less policy than it asked for. */
export function parseUiCsp(meta: unknown): UiCsp {
  const ui = isObject(meta) ? meta["ui"] : undefined;
  const raw = isObject(ui) ? ui["csp"] : undefined;
  if (raw === undefined) return { ...NO_CSP, connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] };
  if (!isObject(raw)) throw new McpAppRefusal("bad_csp", "the page's declared content rules aren't an object");
  const out: UiCsp = { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] };
  for (const kind of Object.keys(out) as (keyof UiCsp)[]) {
    const list = raw[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > CSP_DOMAINS_PER_KIND_MAX) throw new McpAppRefusal("bad_csp", `the page's ${kind} aren't a short list`);
    const seen = new Set<string>();
    for (const d of list) {
      const source = cspSourceOf(d);
      if (source === undefined) throw new McpAppRefusal("bad_csp", `the page declares a domain this app won't allow in ${kind}`);
      seen.add(source);
    }
    out[kind] = [...seen];
  }
  return out;
}

/** The page's `Content-Security-Policy` (the extension's mapping): the default has scripts and styles from the page
 *  itself, inline included, images, media and fonts from it and `data:`, and no network (`connect-src 'none'`, no
 *  frames, `base-uri 'self'`); declared domains widen exactly the directives the extension names. `object-src 'none'`
 *  and `form-action 'none'` always, and the page is never framed by anything the host did not put it in. */
export function uiCspHeader(csp: UiCsp): string {
  const res = csp.resourceDomains.join(" ");
  const add = (base: string, extra: string): string => (extra === "" ? base : `${base} ${extra}`);
  return [
    "default-src 'none'",
    add("script-src 'self' 'unsafe-inline'", res),
    add("style-src 'self' 'unsafe-inline'", res),
    add("img-src 'self' data:", res),
    add("media-src 'self' data:", res),
    add("font-src 'self'", res),
    csp.connectDomains.length === 0 ? "connect-src 'none'" : `connect-src ${csp.connectDomains.join(" ")}`,
    csp.frameDomains.length === 0 ? "frame-src 'none'" : `frame-src ${csp.frameDomains.join(" ")}`,
    add("base-uri 'self'", csp.baseUriDomains.join(" ")),
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** What a server answered for a read: the SDK's own content shape, plus the `_meta` the extension puts on it where a
 *  client carries it. */
export interface UiResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blobBase64?: string;
  _meta?: unknown;
}

export interface UiPage {
  html: string;
  csp: UiCsp;
  prefersBorder?: boolean;
}

/** Decodes a base64 string that must be well formed; a page must be text, so a decode that isn't UTF-8 is refused. */
function decodeBlob(b64: string): string {
  if (b64.length > Math.ceil(MCP_APP_HTML_MAX * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) {
    throw new McpAppRefusal("too_large", "the page is bigger than this app shows, or isn't base64");
  }
  const bytes = Buffer.from(b64, "base64");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new McpAppRefusal("bad_content", "the page isn't UTF-8 text");
  }
}

/** The page of `uri` out of a `resources/read` answer: the one content with that exact uri and the extension's mime
 *  type, bounded, as text. The mime type must match exactly (the extension's only type; parameters other than the
 *  profile and any case difference are not a match). Anything else is a typed refusal, never a partial page. */
export function parseUiResource(uri: string, contents: readonly UiResourceContent[]): UiPage {
  if (!isUiUri(uri)) throw new McpAppRefusal("not_a_ui_uri", "that isn't a ui:// address");
  if (!Array.isArray(contents) || contents.length === 0) throw new McpAppRefusal("not_found", "the server returned nothing for the page");
  const hit = contents.find((c) => isObject(c) && c.uri === uri);
  if (hit === undefined) throw new McpAppRefusal("not_found", "the server returned a different resource than the page asked for");
  if (typeof hit.mimeType !== "string" || hit.mimeType.replace(/\s+/g, "").toLowerCase() !== UI_MIME) {
    throw new McpAppRefusal("wrong_mime_type", `the page isn't ${UI_MIME}`);
  }
  let html: string;
  if (typeof hit.text === "string") {
    if (hit.text.length > MCP_APP_HTML_MAX) throw new McpAppRefusal("too_large", "the page is bigger than this app shows");
    html = hit.text;
  } else if (typeof hit.blobBase64 === "string") {
    html = decodeBlob(hit.blobBase64);
    if (html.length > MCP_APP_HTML_MAX) throw new McpAppRefusal("too_large", "the page is bigger than this app shows");
  } else {
    throw new McpAppRefusal("bad_content", "the page has no content");
  }
  if (html.trim() === "") throw new McpAppRefusal("bad_content", "the page is empty");
  const ui = isObject(hit._meta) ? (hit._meta as Record<string, unknown>)["ui"] : undefined;
  const border = isObject(ui) ? ui["prefersBorder"] : undefined;
  return { html, csp: parseUiCsp(hit._meta), ...(typeof border === "boolean" ? { prefersBorder: border } : {}) };
}
