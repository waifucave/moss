// MCP Apps view documents (`ui/app-page.ts`): the host page, its relay, and what a view may navigate to or fetch.
import { describe, expect, test } from "bun:test";
import { HOST_CSP, HOST_SCRIPT, appNavigationAllowed, appAllowedOrigins, appRequestAllowed, mayPlaceAppView, hostDocument, pageHeaders } from "../src/main/ui/app-page";

describe("the host page", () => {
  test("holds the page in a sandboxed frame with no same-origin right, and nothing else", () => {
    const doc = hostDocument("abc", "tok");
    expect(doc).toContain('sandbox="allow-scripts"');
    expect(doc).not.toContain("allow-same-origin");
    expect(doc).toContain('src="moss-app://abc/view"');
    expect(doc.match(/<iframe/g)).toHaveLength(1);
  });
  test("the relay's script runs before the page's frame exists, and finds the frame only when a message needs it (a first message posted before the listener was lost, and the page waited for ever)", () => {
    const doc = hostDocument("abc", "tok");
    expect(doc.indexOf('<script src="/host.js">')).toBeGreaterThan(-1);
    expect(doc.indexOf('<script src="/host.js">')).toBeLessThan(doc.indexOf("<iframe"));
    expect(HOST_SCRIPT).not.toMatch(/const frame = document\.getElementById/);
    // Run it with no frame in the document yet: loading must not throw, and the listener must be attached.
    const listeners: string[] = [];
    const fakeDoc = { getElementById: () => null, querySelector: () => ({ content: "tok" }) };
    const fakeWindow = { addEventListener: (t: string) => { listeners.push(t); } } as Record<string, unknown>;
    new Function("document", "window", "fetch", HOST_SCRIPT)(fakeDoc, fakeWindow, async () => ({ ok: true, json: async () => ({}) }));
    expect(listeners).toContain("message");
  });
  test("its policy allows only its own script, one frame and its own fetch", () => {
    expect(HOST_CSP).toContain("default-src 'none'");
    expect(HOST_CSP).toContain("script-src 'self'");
    expect(HOST_CSP).toContain("connect-src 'self'");
    expect(HOST_CSP).toContain("frame-ancestors 'none'");
    expect(HOST_CSP).not.toContain("*");
  });
  test("the relay ignores a message that is not from its own frame or not JSON-RPC, and bounds a body", () => {
    expect(HOST_SCRIPT).toContain("e.source !== frame.contentWindow");
    expect(HOST_SCRIPT).toContain('d.jsonrpc !== "2.0"');
    expect(HOST_SCRIPT).toContain("body.length >");
  });
  test("the page is served under the engine's policy and the permissions policy of every web page", () => {
    const h = pageHeaders("default-src 'none'");
    expect(h["Content-Security-Policy"]).toBe("default-src 'none'");
    expect(h["Content-Type"]).toContain("text/html");
  });
});

describe("what a view may navigate to", () => {
  test("only its own two documents", () => {
    expect(appNavigationAllowed("abc", "moss-app://abc/")).toBe(true);
    expect(appNavigationAllowed("abc", "moss-app://abc/view")).toBe(true);
    expect(appNavigationAllowed("abc", "about:blank")).toBe(true);
  });
  test("not another origin, path, a web address, a file or a script", () => {
    for (const u of ["moss-app://other/view", "moss-app://abc/host.js", "moss-app://abc/view?x=1", "moss-app://abc/view#x", "https://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "moss-core://app/", "nonsense"]) {
      expect(appNavigationAllowed("abc", u)).toBe(false);
    }
  });
});

describe("what a view's session may fetch", () => {
  test("a page that declared no host reaches no network", () => {
    const csp = "default-src 'none'; connect-src 'none'; frame-src 'none'";
    const none = appAllowedOrigins(csp);
    expect(none).toEqual([]);
    expect(appRequestAllowed("https://example.com/x", none)).toBe(false);
    expect(appRequestAllowed("http://example.com/x", none)).toBe(false);
    expect(appRequestAllowed("file:///etc/passwd", none)).toBe(false);
    expect(appRequestAllowed("moss-app://abc/view", none)).toBe(true);
    expect(appRequestAllowed("data:text/plain,hi", none)).toBe(true);
  });
  test("a page that declared a host reaches only that origin, never any https", () => {
    const o = appAllowedOrigins("connect-src https://api.example.com https://*.cdn.example.net https://x.example.org:8443");
    expect(appRequestAllowed("https://api.example.com/x", o)).toBe(true);
    expect(appRequestAllowed("http://api.example.com/x", o)).toBe(false);
    expect(appRequestAllowed("https://other.example.com/x", o)).toBe(false);
    expect(appRequestAllowed("https://evil.com/?https://api.example.com", o)).toBe(false);
    expect(appRequestAllowed("https://api.example.com.evil.com/", o)).toBe(false);
    expect(appRequestAllowed("https://a.cdn.example.net/x", o)).toBe(true);
    expect(appRequestAllowed("https://cdn.example.net/x", o)).toBe(false);
    expect(appRequestAllowed("https://x.example.org/x", o)).toBe(false);
    expect(appRequestAllowed("https://x.example.org:8443/x", o)).toBe(true);
    expect(appRequestAllowed("https://u:p@api.example.com/x", o)).toBe(false);
  });
});

describe("who may place an app view", () => {
  test("only a part that reads sessions or bots' conversations", () => {
    expect(mayPlaceAppView(new Set(["sessions.read"]))).toBe(true);
    expect(mayPlaceAppView(new Set(["conversation.read"]))).toBe(true);
    expect(mayPlaceAppView(new Set(["browser", "user.send", "approvals"]))).toBe(false);
    expect(mayPlaceAppView(new Set())).toBe(false);
  });
});
