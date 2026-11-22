// The preview's control, running inside the preview command (scripts/preview/run.ts --control): it serves scripts/preview/ctl.ts on a
// private socket and does what a person at the window could do, through the window's own page (the app's control door, relayed as a
// DevTools client: scripts/acceptance/cdp.ts's, so presses and typing are the harness's real input events) and through the preview's own
// engine (as the person's app, on the throwaway home).
//
// Rules, each enforced where it is written:
//   * ONE socket for ctl, `<run folder>/ctl/ctl.sock`: the folder is made 0700 by run.ts and re-checked here, the socket is 0600.
//   * Nothing is served before the first line names this run's token (kept in the run's record, a 0600 file in a 0700 folder).
//   * The app's own door has a DIFFERENT token that only this process holds (handed to the app in its environment); ctl never sees it.
//   * It ends with the preview: run.ts closes it first in its cleanup, and the socket lives in the run's folder.
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { MOSS_PROTOCOL_VERSION } from "../../packages/protocol/src/index";
import { hello, MossClient, RpcError } from "../acceptance/client";
import { Cdp, MAIN_PAGE_URL, type WsLike } from "../acceptance/cdp";
import { folderProblem } from "../../apps/desktop/src/main/preview-control-rules";
import { LineReader, MAX_LINE, encodeLine, sameToken, type CtlRequest, type Target } from "./control-lib";
import { CENTER_JS, CLEAR_TARGET_JS, DUMP_JS, FOCUS_JS, findJs } from "./page-js";
import { chooseCard, chooseOption, cardTitle, placeWords, type CardRow, type Placed } from "./cards-lib";
import { noteApproval, readSpent, renderSpent } from "./real-lib";
import { seedScene, type SceneName, type SeedInput } from "./seed";

export interface ControlDeps {
  socketPath: string;
  token: string;
  appSocketPath: string;
  appToken: string;
  engineSock: string;
  engineTokenFile: string;
  /** What `seed` needs but the client: the engine client is made per request. */
  seed: Omit<SeedInput, "c">;
  logs: { app: string; engine: string; appOut: string };
  /** A real-agents preview: where the budget's counters are (real-lib.ts), else undefined. */
  budgetDir?: string;
  say(line: string): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── the app's door, as a DevTools-shaped transport ──────────────────────────────────────────────────────────────────────
/** The app's control door as a WebSocket-shaped door for `Cdp.over`: DevTools commands go to the main window's page; its events come back. The page is session "main". */
class AppDoor implements WsLike {
  private readonly listeners: ((m: { data: unknown }) => void)[] = [];
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private seq = 1_000_000;
  private readonly reader = new LineReader();

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { try { for (const line of this.reader.push(chunk)) this.onLine(line); } catch { socket.destroy(); } });
    socket.on("close", () => { for (const p of this.pending.values()) p.reject(new Error("the window's control door closed")); this.pending.clear(); });
    socket.on("error", () => undefined);
  }

  static async connect(path: string, token: string, waitMs: number): Promise<AppDoor> {
    const end = Date.now() + waitMs;
    for (;;) {
      if (existsSync(path)) {
        try {
          const s = await new Promise<Socket>((ok, bad) => { const c = createConnection({ path }); c.once("connect", () => ok(c)); c.once("error", bad); });
          const door = new AppDoor(s);
          await door.hello(token);
          return door;
        } catch { /* not serving yet */ }
      }
      if (Date.now() > end) throw new Error("the window's control door did not come up (was the app started with --control?)");
      await sleep(400);
    }
  }

  private hello(token: string): Promise<void> {
    return new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error("the window's control door did not answer its hello")), 5_000);
      this.pending.set(0, { resolve: () => { clearTimeout(t); ok(); }, reject: (e) => { clearTimeout(t); bad(e); } });
      this.socket.write(encodeLine({ hello: token }));
    });
  }

  private onLine(line: string): void {
    if (line === "") return;
    const m = JSON.parse(line) as { hello?: string; id?: number; result?: unknown; error?: string; event?: { method: string; params: unknown; sessionId?: string } };
    if (m.hello === "ok") { this.pending.get(0)?.resolve(true); this.pending.delete(0); return; }
    if (m.event !== undefined) { this.emit({ method: m.event.method, params: m.event.params, sessionId: m.event.sessionId ?? "main" }); return; }
    if (m.id === undefined) return;
    const p = this.pending.get(m.id);
    if (p === undefined) return;
    this.pending.delete(m.id);
    if (m.error !== undefined) p.reject(new Error(m.error)); else p.resolve(m.result);
  }

  private emit(msg: unknown): void { for (const l of this.listeners) l({ data: JSON.stringify(msg) }); }

  addEventListener(_type: "message", fn: (m: { data: unknown }) => void): void { this.listeners.push(fn); }

  /** A DevTools message from the client (`{id, method, params, sessionId}`): the page's own session ("main") is the connection itself. */
  send(data: string): void {
    const m = JSON.parse(data) as { id: number; method: string; params?: object; sessionId?: string };
    const sessionId = m.sessionId === "main" || m.sessionId === "browser" ? undefined : m.sessionId;
    this.socket.write(encodeLine({ id: m.id, cdp: { method: m.method, params: m.params ?? {}, ...(sessionId !== undefined ? { sessionId } : {}) } }));
    // The answer comes back as `{id, result}` / `{id, error}`: the client's pending map is keyed by its own ids.
    this.pending.set(m.id, {
      resolve: (result) => this.emit({ id: m.id, result }),
      reject: (e) => this.emit({ id: m.id, error: { message: e.message } }),
    });
  }

  /** An app-level action (theme, size, reload, close). */
  app(op: string, value?: unknown): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(encodeLine({ id, app: op, ...(value !== undefined ? { value } : {}) }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`the window did not answer ${op}`)); }, 20_000);
    });
  }

  /** Announces the page to the client, as the browser-level DevTools would: its session is "main". */
  announcePage(): void {
    this.emit({ method: "Target.attachedToTarget", params: { sessionId: "main", targetInfo: { url: MAIN_PAGE_URL, type: "page" } } });
  }

  close(): void { try { this.socket.destroy(); } catch { /* gone */ } }
}

// ── the commands ─────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Doc { session: string; url: string; text: string }

const describe = (t: Target): string => (t.kind === "css" ? `the selector ${t.selector}` : `the text "${t.text}"${t.exact ? " (a whole line or label)" : ""}`);

function pngSize(png: Buffer): { width: number; height: number } {
  return png.length > 24 && png.toString("ascii", 1, 4) === "PNG" ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : { width: 0, height: 0 };
}

class Control {
  constructor(private readonly d: ControlDeps, private readonly cdp: Cdp, private readonly door: AppDoor) {}

  /** The drawn documents: the window's page and every frame in it that has an address. */
  private async docs(): Promise<Doc[]> {
    return (await this.cdp.documents()).filter((x) => x.url !== "" && x.url !== "about:blank");
  }

  /** The first element a target names, found in any document, centred and scrolled into view the way the harness's presses do. */
  private async locate(t: Target): Promise<{ session: string; x: number; y: number; matches: number }> {
    for (const doc of await this.docs()) {
      const n = Number(await this.cdp.evaluate(doc.session, findJs(t)).catch(() => 0));
      if (!(n > 0)) continue;
      const at = (await this.cdp.evaluate(doc.session, CENTER_JS).catch(() => undefined)) as { x: number; y: number } | null | undefined ?? undefined;
      await this.cdp.evaluate(doc.session, CLEAR_TARGET_JS).catch(() => undefined);
      if (at !== undefined) return { session: doc.session, x: at.x, y: at.y, matches: n };
    }
    throw new Error(`nothing on screen that a press can reach matches ${describe(t)}`);
  }

  /** The document that has the keyboard focus on something, if any. */
  private async focusedDoc(): Promise<string | undefined> {
    for (const doc of await this.docs()) if (String(await this.cdp.evaluate(doc.session, FOCUS_JS).catch(() => "")) !== "") return doc.session;
    return undefined;
  }

  private async mouse(session: string, type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
    await this.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "none", ...extra }, session);
  }

  async run(req: CtlRequest, stream: (m: unknown) => void): Promise<unknown> {
    const a = req.args as Record<string, any>;
    switch (req.cmd) {
      case "shot": {
        const full = a.full === true;
        let params: Record<string, unknown> = { format: "png" };
        if (full) {
          const m = await this.cdp.send<{ cssContentSize?: { width: number; height: number } }>("Page.getLayoutMetrics", {}, "main");
          const c = m.cssContentSize;
          if (c !== undefined) params = { ...params, captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(c.width), height: Math.ceil(c.height), scale: 1 } };
        }
        const r = await this.cdp.send<{ data: string }>("Page.captureScreenshot", params, "main");
        const png = Buffer.from(r.data, "base64");
        return { png: r.data, ...pngSize(png), full };
      }
      case "text": {
        const out: string[] = [];
        for (const doc of await this.docs()) {
          const t = String(await this.cdp.evaluate(doc.session, DUMP_JS).catch((e) => `(unreadable: ${(e as Error).message})`));
          if (t.trim() === "") continue;
          if (a.frames === true) {
            const size = await this.cdp.evaluate(doc.session, "innerWidth + 'x' + innerHeight").catch(() => "?");
            out.push(`── ${doc.url} (${size}) ──`);
          }
          out.push(t);
        }
        return { text: out.join("\n") };
      }
      case "click": case "hover": {
        const at = await this.locate(a.target as Target);
        if (req.cmd === "hover") { await this.mouse(at.session, "mouseMoved", at.x, at.y); return { message: `hovering ${describe(a.target)} at ${Math.round(at.x)},${Math.round(at.y)}` }; }
        const button = a.right === true ? "right" : "left";
        for (let n = 1; n <= (a.double === true ? 2 : 1); n++) {
          await this.mouse(at.session, "mouseMoved", at.x, at.y);
          await this.mouse(at.session, "mousePressed", at.x, at.y, { button, clickCount: n, buttons: button === "left" ? 1 : 2 });
          await this.mouse(at.session, "mouseReleased", at.x, at.y, { button, clickCount: n, buttons: 0 });
        }
        return { message: `pressed ${describe(a.target)} at ${Math.round(at.x)},${Math.round(at.y)}${at.matches > 1 ? ` (the first of ${at.matches} matches)` : ""}` };
      }
      case "type": {
        let session: string | undefined;
        if (a.into !== undefined) { const at = await this.locate(a.into as Target); await this.cdp.click(at.session, at.x, at.y); session = at.session; await sleep(150); }
        session ??= await this.focusedDoc();
        if (session === undefined) throw new Error("nothing has the keyboard focus: click a field first, or give --into <target>");
        await this.cdp.send("Input.insertText", { text: String(a.text) }, session);
        return { message: `typed ${String(a.text).length} character(s)` };
      }
      case "key": {
        const c = a.chord as { key: string; code: string; vk: number; text?: string; modifiers: number };
        const session = (await this.focusedDoc()) ?? "main";
        const base = { key: c.key, code: c.code, windowsVirtualKeyCode: c.vk, nativeVirtualKeyCode: c.vk, modifiers: c.modifiers };
        await this.cdp.send("Input.dispatchKeyEvent", { type: c.text !== undefined ? "keyDown" : "rawKeyDown", ...base, ...(c.text !== undefined ? { text: c.text } : {}) }, session);
        await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, session);
        return { message: `sent ${c.key}${c.modifiers !== 0 ? ` (modifiers ${c.modifiers})` : ""}` };
      }
      case "scroll": {
        let session = "main", x = 0, y = 0;
        if (a.target !== undefined) { const at = await this.locate(a.target as Target); session = at.session; x = at.x; y = at.y; }
        else {
          const size = (await this.cdp.evaluate("main", "[innerWidth, innerHeight]")) as [number, number];
          x = size[0] / 2; y = size[1] / 2;
        }
        await this.mouse(session, "mouseMoved", x, y);
        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: a.dx, deltaY: a.dy }, session);
        return { message: `scrolled by ${a.dx},${a.dy} at ${Math.round(x)},${Math.round(y)}` };
      }
      case "drag": {
        const from = await this.locate(a.from as Target);
        const to = await this.locate(a.to as Target);
        if (from.session !== to.session) throw new Error("drag needs both ends in one frame");
        await this.mouse(from.session, "mouseMoved", from.x, from.y);
        await this.mouse(from.session, "mousePressed", from.x, from.y, { button: "left", clickCount: 1, buttons: 1 });
        for (let s = 1; s <= 8; s++) { await this.mouse(from.session, "mouseMoved", from.x + ((to.x - from.x) * s) / 8, from.y + ((to.y - from.y) * s) / 8, { buttons: 1 }); await sleep(30); }
        await this.mouse(from.session, "mouseReleased", to.x, to.y, { button: "left", clickCount: 1, buttons: 0 });
        return { message: `dragged ${describe(a.from)} to ${describe(a.to)}` };
      }
      case "go": {
        const to = a.to as { where: string; id?: string; name?: string };
        if (to.where === "session") {
          for (const doc of await this.docs()) {
            const at = await this.cdp.sessionRowCenter(doc.session, to.id).catch(() => undefined);
            if (at !== undefined) { await this.cdp.click(doc.session, at.x, at.y); return { message: `opened session ${to.id}` }; }
          }
          const block = await this.locate({ kind: "css", selector: `[data-block="${String(to.id).replace(/"/g, "")}"]` }).catch(() => undefined);
          if (block !== undefined) { await this.cdp.click(block.session, block.x, block.y); return { message: `opened session ${to.id} (its block)` }; }
          throw new Error(`no row or block for session ${to.id} on screen`);
        }
        const at = await this.locate({ kind: "text", text: to.where === "start" ? "New session" : String(to.name), exact: true });
        await this.cdp.click(at.session, at.x, at.y);
        return { message: to.where === "start" ? "the start page" : `the ${to.name} page` };
      }
      case "wait": {
        const t = a.target as Target;
        const end = Date.now() + Number(a.timeoutS) * 1000;
        for (;;) {
          for (const doc of await this.docs()) {
            const n = Number(await this.cdp.evaluate(doc.session, findJs(t)).catch(() => 0));
            await this.cdp.evaluate(doc.session, CLEAR_TARGET_JS).catch(() => undefined);
            if (n > 0) return { message: `${describe(t)} is drawn` };
            if (t.kind === "text" && String(await this.cdp.evaluate(doc.session, DUMP_JS).catch(() => "")).includes(t.text)) return { message: `${describe(t)} is drawn` };
          }
          if (Date.now() > end) throw new Error(`${describe(t)} was not drawn within ${a.timeoutS} s`);
          await sleep(400);
        }
      }
      case "theme": await this.door.app("theme", a.value); return { message: `the window is ${a.value}` };
      case "size": await this.door.app("size", { w: a.w, h: a.h }); await sleep(400); return { message: `the window is ${a.w}x${a.h}` };
      case "reload": await this.door.app("reload"); return { message: "reloading the window" };
      case "end": await this.door.app("close").catch(() => undefined); return { message: "the window is closing; the preview ends" };
      case "call": {
        const c = await this.engine();
        try { return { result: await c.request(String(a.method), a.params, 60_000) }; } finally { c.close(); }
      }
      case "sessions": {
        const c = await this.engine();
        try {
          const r = await c.request<{ sessions: unknown[] }>("session.list", {}, 30_000);
          return { sessions: r.sessions };
        } finally { c.close(); }
      }
      case "cards": {
        const c = await this.engine();
        try {
          const cards = (await c.request<{ cards: CardRow[] }>("card.list", {}, 30_000)).cards;
          const placed = new Map((await c.request<{ placements: { card: string; place: Placed }[] }>("card.placement", {}, 30_000).catch(() => ({ placements: [] }))).placements.map((p) => [p.card, p.place]));
          const rows = cards.map((x) => ({ id: x.id, session: x.session ?? null, title: cardTitle(x), place: placeWords(placed.get(x.id)), options: x.options.map((o) => `${o.id}:${o.kind}`) }));
          return { cards: rows, text: rows.length === 0 ? "no pending cards" : rows.map((r) => `${r.id}  session ${r.session ?? "-"}  "${r.title}"  drawn in ${r.place}  [${r.options.join(", ")}]`).join("\n") };
        } finally { c.close(); }
      }
      case "approve": {
        const c = await this.engine();
        try {
          const cards = (await c.request<{ cards: CardRow[] }>("card.list", {}, 30_000)).cards;
          const chosen = chooseCard(cards, { ...(a.id !== undefined ? { id: String(a.id) } : {}), ...(a.session !== undefined ? { session: String(a.session) } : {}) });
          if ("error" in chosen) throw new Error(chosen.error);
          const card = chosen.card;
          const option = chooseOption(card, a.deny === true);
          if (option === undefined) throw new Error(`card ${card.id} has no ${a.deny === true ? "deny" : "approve"} option without a saved rule`);
          let agent: string | undefined;
          if (card.session !== undefined) agent = (await c.request<{ session: { backend?: string } }>("session.get", { id: card.session }, 30_000).catch(() => undefined))?.session.backend;
          // The answer goes through the app's own connection (the one that reports the window), because the engine takes a card placed in a window only from the connection that draws it.
          const r = (await this.door.app("card.answer", { id: card.id, hash: card.hash, option: option.id })) as { accepted?: boolean; reason?: string };
          if (r.accepted !== true) throw new Error(`the engine did not take the answer to ${card.id}: ${r.reason ?? "no reason given"}`);
          const counted = agent !== undefined && this.d.budgetDir !== undefined ? noteApproval(this.d.budgetDir, agent) : undefined;
          const said = `${a.deny === true ? "denied" : "approved"} card ${card.id} "${cardTitle(card)}" (option ${option.id}${card.session !== undefined ? `, session ${card.session}` : ""}${agent !== undefined ? `, agent ${agent}` : ""})${counted !== undefined ? "; counted in spent" : ""}`;
          return { message: said, card: card.id, option: option.id, agent: agent ?? null, accepted: true };
        } finally { c.close(); }
      }
      case "front": await this.door.app("front"); return { message: "the preview's own window is in front" };
      case "seed": {
        const c = await this.engine();
        try {
          const made = await seedScene(a.scene as SceneName, { ...this.d.seed, c });
          return { sessions: made, message: `${made.length} session(s) made: ${made.map((m) => `${m.id} (${m.what})`).join("; ")}` };
        } finally { c.close(); }
      }
      case "events": return await this.events(a as { areas: string[]; forS: number; count: number }, stream);
      case "logs": return { text: this.logs(a as { which: string; sinceMs?: number; tail: number }) };
      case "frames": return { frames: [...this.cdp.frames.values()], text: [...this.cdp.frames.values()].map((f) => `${f.type}  ${f.session}  ${f.url}`).join("\n") };
      case "eval": {
        const docs = (await this.docs()).filter((x) => a.frame === undefined || x.url.includes(String(a.frame)));
        if (docs.length === 0) throw new Error(a.frame === undefined ? "no page is drawn" : `no frame has "${a.frame}" in its address`);
        return { value: await this.cdp.evaluate(docs[0]!.session, String(a.js)), url: docs[0]!.url };
      }
      case "spent": return { spent: this.d.budgetDir === undefined ? [] : readSpent(this.d.budgetDir), text: this.d.budgetDir === undefined ? "this preview has no real agents (start it with --real-agents)" : renderSpent(readSpent(this.d.budgetDir)) };
      default: throw new Error(`unknown command ${req.cmd}`);
    }
  }

  private async engine(): Promise<MossClient> {
    const token = readFileSync(this.d.engineTokenFile, "utf8").trim();
    return (await hello(this.d.engineSock, "app", token, "moss-preview-ctl", MOSS_PROTOCOL_VERSION)).client;
  }

  private async events(a: { areas: string[]; forS: number; count: number }, stream: (m: unknown) => void): Promise<unknown> {
    const c = await this.engine();
    let n = 0;
    try {
      let done: () => void = () => undefined;
      const finished = new Promise<void>((r) => { done = r; });
      c.onNotification((method, params) => {
        if (method !== "core.event") return;
        n++;
        stream({ method, params });
        if (n >= a.count) done();
      });
      await c.request("events.subscribe", { areas: a.areas });
      await Promise.race([finished, sleep(a.forS * 1000)]);
    } finally { c.close(); }
    return { message: `${n} event(s) in ${a.forS} s at most` };
  }

  private logs(a: { which: string; sinceMs?: number; tail: number }): string {
    const read = (path: string, since: boolean): string[] => {
      let lines: string[];
      try { lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== ""); } catch { return []; }
      if (since && a.sinceMs !== undefined) {
        const cut = Date.now() - a.sinceMs;
        lines = lines.filter((l) => { const t = Date.parse(l.slice(0, 24)); return Number.isNaN(t) || t >= cut; });
      }
      return lines.slice(-a.tail);
    };
    const parts: string[] = [];
    if (a.which !== "engine") { parts.push("── app ──", ...read(this.d.logs.app, true)); }
    if (a.which !== "app") { parts.push(`── engine${a.sinceMs !== undefined ? " (its log has no times: the last lines, not filtered by --since)" : ""} ──`, ...read(this.d.logs.engine, false)); }
    return parts.join("\n");
  }
}

// ── the server ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface RunningControl { close(): void }

export async function startControl(d: ControlDeps): Promise<RunningControl> {
  const problem = folderProblem(dirname(d.socketPath));
  if (problem !== undefined) throw new Error(`the control socket's folder is not private: ${problem}`);
  const door = await AppDoor.connect(d.appSocketPath, d.appToken, 120_000);
  const cdp = Cdp.over(door);
  door.announcePage();
  await sleep(300);
  const control = new Control(d, cdp, door);
  rmSync(d.socketPath, { force: true });

  const server: Server = createServer((s) => {
    const reader = new LineReader(MAX_LINE);
    let authed = false;
    let chain: Promise<void> = Promise.resolve();
    s.setEncoding("utf8");
    const send = (m: unknown): void => { if (!s.destroyed) s.write(encodeLine(m)); };
    s.on("data", (chunk: string) => {
      let lines: string[];
      try { lines = reader.push(chunk); } catch { s.destroy(); return; }
      for (const line of lines) {
        let msg: { hello?: unknown; id?: number; cmd?: string; args?: Record<string, unknown> };
        try { msg = JSON.parse(line); } catch { s.destroy(); return; }
        if (!authed) {
          if (typeof msg.hello !== "string" || !sameToken(msg.hello, d.token)) { s.destroy(); return; }
          authed = true;
          send({ hello: "ok" });
          continue;
        }
        const id = msg.id ?? 0;
        // One request after another on a connection; a failure is its answer, never a crash of the preview.
        chain = chain.then(async () => {
          try {
            const result = await control.run({ cmd: String(msg.cmd), args: msg.args ?? {} }, (event) => send({ id, event }));
            send({ id, ok: true, result });
          } catch (err) {
            send({ id, ok: false, error: err instanceof RpcError ? err.message : err instanceof Error ? err.message : String(err) });
          }
        });
      }
    });
    s.on("error", () => undefined);
  });
  await new Promise<void>((ok, bad) => { server.once("error", bad); server.listen(d.socketPath, () => ok()); });
  // The folder is already closed to everyone else; the file is closed too.
  chmodSync(d.socketPath, 0o600);
  if ((statSync(d.socketPath).mode & 0o077) !== 0) throw new Error("the control socket is open to other users");
  d.say(`control: ${d.socketPath}`);
  return { close: () => { try { server.close(); } catch { /* gone */ } door.close(); rmSync(d.socketPath, { force: true }); } };
}

