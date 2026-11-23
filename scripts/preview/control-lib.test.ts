import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, existsSync, statSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderProblem, MAX_REQUEST_BYTES } from "../../apps/desktop/src/main/preview-control-rules";
import { CTL_USAGE, LineReader, MAX_LINE, SCENES, UsageError, classifyTarget, encodeLine, newToken, parseChord, parseCtl, render, sameToken } from "./control-lib";
import { startControl } from "./control";
import { appArgs, appEnv, isolationProblems, layoutFor, parseOptions, parseRecord } from "./lib";

describe("the token rule", () => {
  test("a token is 32 random bytes, and only the same token is the token", () => {
    const t = newToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken()).not.toBe(t);
    expect(sameToken(t, t)).toBe(true);
    expect(sameToken(t, `${t.slice(0, 63)}0`)).toBe(t.endsWith("0"));
    expect(sameToken(t, t.slice(1))).toBe(false);
    expect(sameToken("", "")).toBe(false);
    expect(sameToken(t, "")).toBe(false);
  });
  test("the request limit is the door's own", () => expect(MAX_LINE).toBe(MAX_REQUEST_BYTES));
});

describe("the socket's folder", () => {
  const base = mkdtempSync(join(tmpdir(), "mprev-test-"));
  test("only a plain folder of this user closed to everyone else may hold the door", () => {
    try {
      const ok = join(base, "ok"); mkdirSync(ok, { mode: 0o700 }); chmodSync(ok, 0o700);
      expect(folderProblem(ok)).toBeUndefined();
      const open = join(base, "open"); mkdirSync(open); chmodSync(open, 0o755);
      expect(folderProblem(open)).toContain("open to other users");
      const group = join(base, "group"); mkdirSync(group); chmodSync(group, 0o770);
      expect(folderProblem(group)).toContain("open to other users");
      expect(folderProblem(join(base, "none"))).toContain("does not exist");
      const link = join(base, "link"); symlinkSync(ok, link);
      expect(folderProblem(link)).toContain("not a plain folder");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe("targets and chords", () => {
  test("what a target names", () => {
    expect(classifyTarget("New session")).toEqual({ kind: "text", text: "New session", exact: false });
    expect(classifyTarget("=Archive")).toEqual({ kind: "text", text: "Archive", exact: true });
    expect(classifyTarget("+")).toEqual({ kind: "text", text: "+", exact: false });
    expect(classifyTarget(".cv-node")).toEqual({ kind: "css", selector: ".cv-node" });
    expect(classifyTarget("#root button")).toEqual({ kind: "css", selector: "#root button" });
    expect(classifyTarget("[data-block]")).toEqual({ kind: "css", selector: "[data-block]" });
    expect(classifyTarget("css=button.x")).toEqual({ kind: "css", selector: "button.x" });
    expect(classifyTarget("button.primary")).toEqual({ kind: "css", selector: "button.primary" });
    expect(() => classifyTarget("")).toThrow(UsageError);
  });
  test("a chord's DevTools fields and modifier bits", () => {
    expect(parseChord("Enter")).toMatchObject({ key: "Enter", vk: 13, modifiers: 0, text: "\r" });
    expect(parseChord("Escape")).toMatchObject({ key: "Escape", vk: 27, modifiers: 0 });
    expect(parseChord("Escape").text).toBeUndefined();
    expect(parseChord("Cmd+K")).toMatchObject({ key: "k", code: "KeyK", modifiers: 4 });
    expect(parseChord("Cmd+K").text).toBeUndefined();
    expect(parseChord("Shift+Tab")).toMatchObject({ key: "Tab", modifiers: 8 });
    expect(parseChord("ctrl+alt+Delete").modifiers).toBe(3);
    expect(parseChord("a")).toMatchObject({ key: "a", text: "a", modifiers: 0 });
    expect(parseChord("Shift+a")).toMatchObject({ key: "A", text: "A", modifiers: 8 });
    expect(parseChord("F5")).toMatchObject({ key: "F5", vk: 116 });
    expect(parseChord("+")).toMatchObject({ key: "+", modifiers: 0 });
    for (const bad of ["", "Cmd+", "Hyper+K", "ab", "Cmd++K"]) expect(() => parseChord(bad)).toThrow(UsageError);
  });
});

describe("the command line", () => {
  const ok = (...a: string[]) => parseCtl(a);
  test("every command parses to one request", () => {
    expect(ok("shot", "/x/a.png", "--full").request).toEqual({ cmd: "shot", args: { full: true } });
    expect(ok("text", "--frames", "--json")).toMatchObject({ json: true, request: { cmd: "text", args: { frames: true } } });
    expect(ok("click", "+").request.args.target).toEqual({ kind: "text", text: "+", exact: false });
    expect(ok("click", "Save", "--double").request.args.double).toBe(true);
    expect(ok("type", "hello world", "--into", "Message").request.args).toMatchObject({ text: "hello world", into: { kind: "text", text: "Message" } });
    expect(ok("key", "Cmd+K").request.args.chord).toMatchObject({ key: "k", modifiers: 4 });
    expect(ok("scroll", "--dy", "300").request.args).toMatchObject({ dy: 300, dx: 0 });
    expect(ok("hover", ".x").request.cmd).toBe("hover");
    expect(ok("drag", "A", "B").request.args).toMatchObject({ from: { text: "A" }, to: { text: "B" } });
    expect(ok("go", "start").request.args.to).toEqual({ where: "start" });
    expect(ok("go", "session", "agent_1").request.args.to).toEqual({ where: "session", id: "agent_1" });
    expect(ok("go", "Plugins").request.args.to).toEqual({ where: "page", name: "Plugins" });
    expect(ok("wait", "Working", "--timeout", "5").request.args).toMatchObject({ timeoutS: 5 });
    expect(ok("wait", "Working").request.args.timeoutS).toBe(30);
    expect(ok("theme", "dark").request.args.value).toBe("dark");
    expect(ok("size", "1180x760").request.args).toMatchObject({ w: 1180, h: 760 });
    expect(ok("call", "session.list", '{"kinds":["agent"]}').request.args).toEqual({ method: "session.list", params: { kinds: ["agent"] } });
    expect(ok("call", "bot.list").request.args.params).toEqual({});
    expect(ok("events", "--area", "sessions", "--for", "3").request.args).toMatchObject({ areas: ["sessions"], forS: 3 });
    expect(ok("sessions").request.cmd).toBe("sessions");
    expect(ok("spent").request.cmd).toBe("spent");
    for (const s of SCENES) expect(ok("seed", s).request.args.scene).toBe(s);
    expect(ok("logs", "--app", "--since", "5m").request.args).toMatchObject({ which: "app", sinceMs: 300_000 });
    expect(ok("logs").request.args).toMatchObject({ which: "both", tail: 60 });
  });
  test("what is refused is refused here, with a plain reason", () => {
    const bad: string[][] = [["shot"], ["shot", "a.txt"], ["shot", "a.png", "b.png"], ["click"], ["click", "a", "b"], ["key"], ["key", "Hyper+K"], ["scroll"], ["scroll", "--dy", "x"],
      ["theme", "blue"], ["size", "10x10"], ["size", "big"], ["size", "9000x9000"], ["call"], ["call", "Bad Name"], ["call", "x.y", "{"], ["events", "--area", "nope"], ["seed", "nope"],
      ["seed"], ["logs", "--since", "soon"], ["go"], ["go", "session"], ["text", "--full"], ["frobnicate"], ["click", "x", "--wat"], ["wait", "x", "--timeout", "0"]];
    for (const b of bad) expect(() => parseCtl(b)).toThrow(UsageError);
  });
  test("help names every command and says the glass is not in a picture", () => {
    expect(ok().help).toBe(true);
    expect(ok("--help").help).toBe(true);
    for (const c of ["shot", "text", "click", "type", "key", "scroll", "hover", "drag", "go", "wait", "theme", "size", "call", "events", "sessions", "seed", "logs"]) expect(CTL_USAGE).toContain(`  ${c}`);
    expect(CTL_USAGE).toContain("glass");
    expect(CTL_USAGE).toContain("no macOS permission");
  });
  test("an answer's terminal form", () => {
    expect(render("text", { text: "a\nb" })).toBe("a\nb");
    expect(render("sessions", { sessions: [{ id: "s1", backend: "codex", status: "idle", title: "T", startedBy: { kind: "agent" } }] })).toContain("[started by agent]");
    expect(render("sessions", { sessions: [] })).toBe("no sessions");
    expect(render("shot", { path: "/x.png", width: 10, height: 5, full: false })).toBe("/x.png (10x5)");
  });
  test("lines are cut and bounded", () => {
    const r = new LineReader(10);
    expect(r.push("ab\ncd")).toEqual(["ab"]);
    expect(r.push("e\n")).toEqual(["cde"]);
    expect(() => r.push("0123456789ab")).toThrow();
    expect(encodeLine({ a: 1 })).toBe('{"a":1}\n');
  });
});

describe("the preview's options and record carry the door", () => {
  test("--control is allowed alone and with --headless, never with --shot or --stop", () => {
    expect(parseOptions(["--control"]).control).toBe(true);
    expect(parseOptions(["--control", "--headless"])).toMatchObject({ control: true, headless: true });
    expect(parseOptions([]).control).toBe(false);
    expect(() => parseOptions(["--control", "--headless", "--shot", "a.png"])).toThrow(UsageError);
    expect(() => parseOptions(["--stop", "--control"])).toThrow(UsageError);
    expect(() => parseOptions(["--headless"])).toThrow(UsageError);
  });
  const layout = layoutFor("/tmp/mprev-abc123");
  const input = { layout, service: "com.waifucave.moss.core.test.preview-deadbeef", bunDir: "/cache/moss-bun/1.2.3" };
  test("without --control the app is given no door and no token; with it, its socket inside the run's folder, and no DevTools port", () => {
    const plain = appEnv({ ...input, headless: false, appearance: "system" });
    expect(Object.keys(plain).filter((k) => k.startsWith("MOSS_PREVIEW_CONTROL"))).toEqual([]);
    const t = newToken();
    const ctl = appEnv({ ...input, headless: true, appearance: "system", control: { token: t } });
    expect(ctl.MOSS_PREVIEW_CONTROL_SOCKET).toBe("/tmp/mprev-abc123/ctl/a.sock");
    expect(ctl.MOSS_PREVIEW_CONTROL_TOKEN).toBe(t);
    expect(ctl.MOSS_DEV_DEBUG).toBeUndefined();
    expect(isolationProblems(ctl, layout, "/Users/someone")).toEqual([]);
    expect(appArgs({ desktopDir: "/d", headless: true, control: true }).join(" ")).not.toContain("remote-debugging");
    expect(appArgs({ desktopDir: "/d", headless: true, port: 9 }).join(" ")).toContain("--remote-debugging-port=9");
    expect(appArgs({ desktopDir: "/d", headless: false, control: true }).join(" ")).not.toMatch(/remote-debugging|inspect/);
    // a socket outside the run's folder is a leak
    expect(isolationProblems({ ...ctl, MOSS_PREVIEW_CONTROL_SOCKET: "/tmp/elsewhere/a.sock" }, layout, "/Users/someone").join(" ")).toContain("MOSS_PREVIEW_CONTROL_SOCKET");
  });
  test("the record keeps the door's place and token only when both are well formed", () => {
    const base = { v: 1, pid: 1, start: "s", root: "/tmp/mprev-x", at: 1, children: [] };
    const t = newToken();
    expect(parseRecord(JSON.stringify({ ...base, control: { socket: "/tmp/mprev-x/ctl/c.sock", token: t } }))?.control).toEqual({ socket: "/tmp/mprev-x/ctl/c.sock", token: t });
    expect(parseRecord(JSON.stringify(base))?.control).toBeUndefined();
    expect(parseRecord(JSON.stringify({ ...base, control: { socket: "/x", token: "short" } }))?.control).toBeUndefined();
    expect(parseRecord(JSON.stringify({ ...base, control: { token: t } }))?.control).toBeUndefined();
  });
});

describe("the control socket (a stand-in window behind it)", () => {
  /** A stand-in for the app's door: hello with its token, then any DevTools command answered with an empty result, any app action answered. */
  function fakeApp(path: string, token: string): { server: Server; seen: string[] } {
    const seen: string[] = [];
    const server = createServer((s: Socket) => {
      const r = new LineReader();
      let authed = false;
      s.setEncoding("utf8");
      s.on("data", (c: string) => { for (const line of r.push(c)) {
        const m = JSON.parse(line);
        if (!authed) { if (m.hello !== token) { s.destroy(); return; } authed = true; s.write(encodeLine({ hello: "ok" })); continue; }
        if (m.app !== undefined) { seen.push(`app:${m.app}:${JSON.stringify(m.value ?? null)}`); s.write(encodeLine({ id: m.id, result: { ok: true } })); continue; }
        seen.push(`cdp:${m.cdp?.method}`);
        s.write(encodeLine({ id: m.id, result: {} }));
      } });
      s.on("error", () => undefined);
    });
    server.listen(path);
    return { server, seen };
  }
  const talk = (path: string, lines: unknown[], waitMs = 600): Promise<{ replies: any[]; closed: boolean }> => new Promise((ok) => {
    const replies: any[] = [];
    let closed = false;
    const s = createConnection({ path });
    const r = new LineReader();
    s.setEncoding("utf8");
    s.on("connect", () => { for (const l of lines) s.write(encodeLine(l)); });
    s.on("data", (c: string) => { for (const line of r.push(c)) replies.push(JSON.parse(line)); });
    s.on("close", () => { closed = true; });
    s.on("error", () => { closed = true; });
    setTimeout(() => { s.destroy(); ok({ replies, closed }); }, waitMs);
  });

  test("nothing is served before the token; the right token runs a command; the socket and its folder are private", async () => {
    const root = mkdtempSync(join(tmpdir(), "mprev-test-"));
    const dir = join(root, "ctl"); mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700);
    const appToken = newToken(), token = newToken();
    const app = fakeApp(join(dir, "a.sock"), appToken);
    const layout = layoutFor(root);
    let control;
    try {
      control = await startControl({
        socketPath: join(dir, "c.sock"), token, appSocketPath: join(dir, "a.sock"), appToken, engineSock: join(root, "none.sock"), engineTokenFile: join(root, "none.token"),
        seed: { layout, keyedModel: "m", dummyKey: "k", fakeAcpAgent: "x", quirks: {}, say: () => undefined }, logs: { app: join(root, "a.log"), engine: join(root, "e.log"), appOut: join(root, "o.log") }, say: () => undefined,
      });
      expect(statSync(join(dir, "c.sock")).mode & 0o077).toBe(0);
      // no hello: a command is not answered and the connection is closed
      const noToken = await talk(join(dir, "c.sock"), [{ id: 1, cmd: "reload", args: {} }]);
      expect(noToken.replies).toEqual([]);
      expect(noToken.closed).toBe(true);
      // a wrong token: the same
      const wrong = await talk(join(dir, "c.sock"), [{ hello: newToken() }, { id: 1, cmd: "reload", args: {} }]);
      expect(wrong.replies).toEqual([]);
      expect(app.seen.filter((x) => x.startsWith("app:"))).toEqual([]);
      // the token: the command reaches the window
      const good = await talk(join(dir, "c.sock"), [{ hello: token }, { id: 1, cmd: "theme", args: { value: "dark" } }, { id: 2, cmd: "nonsense", args: {} }]);
      expect(good.replies[0]).toEqual({ hello: "ok" });
      expect(good.replies.find((r) => r.id === 1)).toMatchObject({ ok: true });
      expect(good.replies.find((r) => r.id === 2)).toMatchObject({ ok: false });
      expect(app.seen).toContain('app:theme:"dark"');
      // an oversized line closes the connection
      const big = await talk(join(dir, "c.sock"), [{ hello: token }, { id: 3, cmd: "text", args: { pad: "x".repeat(MAX_LINE + 10) } }]);
      expect(big.closed).toBe(true);
    } finally {
      control?.close();
      app.server.close();
      rmSync(root, { recursive: true, force: true });
    }
    expect(existsSync(root)).toBe(false);
  }, 30_000);

  test("a folder open to others is refused before any socket exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "mprev-test-"));
    const dir = join(root, "ctl"); mkdirSync(dir); chmodSync(dir, 0o755);
    try {
      await expect(startControl({
        socketPath: join(dir, "c.sock"), token: newToken(), appSocketPath: join(dir, "a.sock"), appToken: newToken(), engineSock: "", engineTokenFile: "",
        seed: { layout: layoutFor(root), keyedModel: "m", dummyKey: "k", fakeAcpAgent: "x", quirks: {}, say: () => undefined }, logs: { app: "", engine: "", appOut: "" }, say: () => undefined,
      })).rejects.toThrow(/not private/);
      expect(existsSync(join(dir, "c.sock"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("ctl cards, approve and front", () => {
  const ok = (...a: string[]) => parseCtl(a);
  test("approve names exactly one card", () => {
    expect(ok("approve", "card_abc").request).toEqual({ cmd: "approve", args: { id: "card_abc", deny: false } });
    expect(ok("approve", "--session", "agent_x", "--deny").request.args).toEqual({ session: "agent_x", deny: true });
    for (const bad of [["approve"], ["approve", "a", "b"], ["approve", "card_a", "--session", "s"], ["approve", "--session"], ["approve", "a b"], ["approve", "--all"], ["approve", "*"]]) expect(() => parseCtl(bad)).toThrow(UsageError);
  });
  test("cards and front take nothing", () => {
    expect(ok("cards").request.cmd).toBe("cards");
    expect(ok("front").request.cmd).toBe("front");
    expect(() => parseCtl(["cards", "x"])).toThrow(UsageError);
    expect(() => parseCtl(["front", "--deny"])).toThrow(UsageError);
  });
});
