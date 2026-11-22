// MCP Apps' reader (`mcp-apps/resource.ts`): a server's page, read as untrusted data.
import { describe, expect, test } from "bun:test";
import { MCP_APP_HTML_MAX } from "@waifucave/moss-protocol";
import { cspSourceOf, isUiUri, McpAppRefusal, parseUiCsp, parseUiResource, toolVisibilityOf, UI_MIME, uiCspHeader, uiResourceUriOf } from "../../src/mcp-apps/resource";

const page = (over: Record<string, unknown> = {}) => [{ uri: "ui://x/y", mimeType: UI_MIME, text: "<!doctype html><p>hi</p>", ...over }];
const refusal = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (e) { return e instanceof McpAppRefusal ? e.code : `other:${String(e)}`; } };

describe("which tool names a page", () => {
  test("_meta.ui.resourceUri, and the deprecated flat key", () => {
    expect(uiResourceUriOf({ _meta: { ui: { resourceUri: "ui://a/b" } } })).toBe("ui://a/b");
    expect(uiResourceUriOf({ _meta: { "ui/resourceUri": "ui://a/c" } })).toBe("ui://a/c");
    expect(uiResourceUriOf({ _meta: { ui: { resourceUri: "ui://a/b" }, "ui/resourceUri": "ui://old" } })).toBe("ui://a/b");
  });
  test("anything that is not a bounded ui:// address names none", () => {
    for (const v of ["https://evil/x", "file:///etc/passwd", "ui://", "ui:// space", "javascript:alert(1)", 5, null, {}, "ui://" + "a".repeat(3000), "ui://a\nb"]) {
      expect(uiResourceUriOf({ _meta: { ui: { resourceUri: v } } })).toBeUndefined();
    }
    for (const meta of [undefined, null, "x", [], { ui: "x" }, { ui: [] }]) expect(uiResourceUriOf({ _meta: meta })).toBeUndefined();
    expect(isUiUri("ui://ok/1")).toBe(true);
  });
  test("visibility: the default is both; an unusable list is the default, never none", () => {
    expect(toolVisibilityOf({})).toEqual(["model", "app"]);
    expect(toolVisibilityOf({ _meta: { ui: { visibility: ["app"] } } })).toEqual(["app"]);
    expect(toolVisibilityOf({ _meta: { ui: { visibility: ["model", "app", "model", "x"] } } })).toEqual(["model", "app"]);
    expect(toolVisibilityOf({ _meta: { ui: { visibility: [] } } })).toEqual(["model", "app"]);
    expect(toolVisibilityOf({ _meta: { ui: { visibility: "app" } } })).toEqual(["model", "app"]);
  });
});

describe("the page", () => {
  test("text and a base64 blob both read", () => {
    expect(parseUiResource("ui://x/y", page()).html).toContain("hi");
    const blob = Buffer.from("<p>blob</p>").toString("base64");
    expect(parseUiResource("ui://x/y", page({ text: undefined, blobBase64: blob })).html).toBe("<p>blob</p>");
  });
  test("the mime type must be the extension's, exactly", () => {
    for (const mimeType of ["text/html", "text/plain", "application/javascript", undefined, "text/html;profile=other"]) {
      expect(refusal(() => parseUiResource("ui://x/y", page({ mimeType })))).toBe("wrong_mime_type");
    }
    expect(parseUiResource("ui://x/y", page({ mimeType: "Text/HTML; profile=mcp-app" })).html).toBeTruthy();
  });
  test("a huge page, an oversized or malformed blob, an empty or non-text page are refused", () => {
    expect(refusal(() => parseUiResource("ui://x/y", page({ text: "x".repeat(MCP_APP_HTML_MAX + 1) })))).toBe("too_large");
    expect(refusal(() => parseUiResource("ui://x/y", page({ text: undefined, blobBase64: "A".repeat(MCP_APP_HTML_MAX * 2) })))).toBe("too_large");
    expect(refusal(() => parseUiResource("ui://x/y", page({ text: undefined, blobBase64: "!!not base64!!" })))).toBe("too_large");
    expect(refusal(() => parseUiResource("ui://x/y", page({ text: undefined, blobBase64: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64") })))).toBe("bad_content");
    expect(refusal(() => parseUiResource("ui://x/y", page({ text: "  " })))).toBe("bad_content");
    expect(refusal(() => parseUiResource("ui://x/y", page({ text: undefined })))).toBe("bad_content");
  });
  test("a different resource than the one asked for, none at all, or a non-ui address is refused", () => {
    expect(refusal(() => parseUiResource("ui://x/y", page({ uri: "ui://x/other" })))).toBe("not_found");
    expect(refusal(() => parseUiResource("ui://x/y", []))).toBe("not_found");
    expect(refusal(() => parseUiResource("file:///etc/passwd", page({ uri: "file:///etc/passwd" })))).toBe("not_a_ui_uri");
  });
});

describe("the declared content rules", () => {
  test("none declared is no network at all", () => {
    const header = uiCspHeader(parseUiCsp(undefined));
    expect(header).toContain("default-src 'none'");
    expect(header).toContain("connect-src 'none'");
    expect(header).toContain("frame-src 'none'");
    expect(header).toContain("object-src 'none'");
    expect(header).not.toContain("http");
  });
  test("declared domains widen exactly the directives the extension names", () => {
    const csp = parseUiCsp({ ui: { csp: { connectDomains: ["https://api.example.com"], resourceDomains: ["https://cdn.example.com", "https://*.fonts.example.com:8443"], frameDomains: ["https://embed.example.com"], baseUriDomains: ["https://base.example.com"] } } });
    const h = uiCspHeader(csp);
    expect(h).toContain("connect-src https://api.example.com;");
    expect(h).toContain("script-src 'self' 'unsafe-inline' https://cdn.example.com https://*.fonts.example.com:8443;");
    expect(h).toContain("frame-src https://embed.example.com;");
    expect(h).toContain("base-uri 'self' https://base.example.com;");
  });
  test("a declaration that could write more policy than a host is refused", () => {
    const bad = ["*", "https://*", "http://plain.example.com", "https://a.example.com/path", "https://a.example.com; script-src *", "https://u:p@a.example.com", "https://a.example.com:99999", "https://a b.example.com", "'unsafe-eval'", "data:", "blob:", "https://localhost", "", 5, null, "https://a.example.com\n"];
    for (const d of bad) expect(refusal(() => parseUiCsp({ ui: { csp: { connectDomains: [d] } } }))).toBe("bad_csp");
    expect(refusal(() => parseUiCsp({ ui: { csp: "x" } }))).toBe("bad_csp");
    expect(refusal(() => parseUiCsp({ ui: { csp: { connectDomains: "https://a.example.com" } } }))).toBe("bad_csp");
    expect(refusal(() => parseUiCsp({ ui: { csp: { connectDomains: Array.from({ length: 40 }, (_, i) => `https://h${i}.example.com`) } } }))).toBe("bad_csp");
    expect(cspSourceOf("https://A.Example.COM")).toBe("https://a.example.com");
  });
  test("a page's permissions are never read: nothing in the policy or the page object carries one", () => {
    const parsed = parseUiResource("ui://x/y", page({ _meta: { ui: { permissions: { camera: {}, microphone: {} }, prefersBorder: true } } }));
    expect(parsed.prefersBorder).toBe(true);
    expect(Object.keys(parsed).sort()).toEqual(["csp", "html", "prefersBorder"]);
  });
});
