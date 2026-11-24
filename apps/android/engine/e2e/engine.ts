// The engine the Android apps' instrumented proof pairs with (.github/workflows/android-engine.yml): `startDaemon` from
// source on a temp home of its own, the real link sidecar (`moss-link`) on a FIXED loopback port (so the phone finds it
// again after the engine restarts: it dials only the QR's hints, with no relay), and the throwaway secrets file of the core
// tests. It plays the computer's person through its own app connection, and answers the emulator on a loopback control
// port (the emulator reaches the runner's loopback at 10.0.2.2).
//
// "The fake provider": the embedded runtime that runs a real model turn is macOS-only, so every bot's conversation and
// the coding session run on a scripted driver that answers each message with "Echo: <text>" (no model, no network).
//
// Run from the repo root: bun --preload ./packages/core/test/preload.ts apps/android/engine/e2e/engine.ts
//   MOSS_LINK_BIN   the built sidecar (default native/link/target/release/moss-link)
//   --link-port N   the sidecar's fixed port (default 47123); --control-port N the control port (default 8790)
//
// Control (GET, plain JSON answers; the QR goes only to the emulator that asked, never to a log):
//   /pair                        begin a pairing; answers {pairingId, qr}. In the background the engine's person confirms
//                                the four words the add card shows and approves the card.
//   /words?pairing=ID            the four words the engine's person read, once shown ("w1 w2 w3 w4")
//   /bot                         the test bot {id, mainSession}   /coding  the test coding session {id}
//   /card?bot=ID | ?session=ID   raise a card for that bot or session: {cardId}
//   /decision?card=ID            the card's outcome once answered: {decision}
//   /restart                     stop the engine and start it again on the same home
//   /phones                      the phones the engine has paired: [{id, app}]
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const core = join(repo, "packages/core");
const { startDaemon } = await import(join(core, "src/daemon"));
const { FileSecretStore } = await import(join(core, "src/auth/secret-store"));
const { FakePluginRegistry } = await import(join(core, "src/contracts/fakes/plugin-registry"));
const { catalogPointDecl } = await import(join(repo, "packages/plugin-sdk/src/catalogs/index"));
const { decode, encode } = await import(join(core, "src/links/codec"));
const { MOSS_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS } = await import(Bun.resolveSync("@waifucave/moss-protocol", core));

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const BIN = process.env.MOSS_LINK_BIN ?? join(repo, "native/link/target/release/moss-link");
const LINK_PORT = Number(opt("--link-port") ?? 47123);
const CONTROL_PORT = Number(opt("--control-port") ?? 8790);
const ADVERTISE = "10.0.2.2";
const log = (line: string) => process.stderr.write(`[engine] ${line}\n`);

const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-aw-engine-")));
const home = join(root, "home");
const userHome = join(root, "user");
mkdirSync(join(userHome, "project1"), { recursive: true });

type Ctl = { record(e: { type: string; [k: string]: unknown }): void; signal: AbortSignal };
/** The scripted "provider": each message is answered with "Echo: <its text>", after a short think. */
class EchoDriver {
  readonly canFold = false;
  async turn(input: { text?: string }, ctl: Ctl) {
    await Bun.sleep(300);
    if (ctl.signal.aborted) return { reason: "interrupted" as const };
    ctl.record({ type: "assistant_message", threadId: "main", text: `Echo: ${input.text ?? ""}` });
    return { reason: "end_turn" as const };
  }
  async interrupt() {}
  async stop() {}
  async setModel() {}
}

type App = { request(method: string, params?: unknown): Promise<Record<string, unknown>>; close(): void };
let daemon: any;
let app: App;

async function connectApp(): Promise<App> {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  let next = 1;
  const socket = await Bun.connect({ unix: daemon.socketPath, socket: {
    data(_s: unknown, chunk: Uint8Array) {
      for (const l of decoder.push(chunk)) {
        const m = JSON.parse(l) as Record<string, unknown>;
        // The engine's own requests to its app (`app.ping`): answered, or it takes the app for gone.
        if (typeof m.method === "string" && m.id !== undefined) writer.enqueue(encodeLine({ jsonrpc: "2.0", id: m.id, result: {} }));
        else if (typeof m.id === "number") { pending.get(m.id)?.(m); pending.delete(m.id); }
      }
    },
    drain() { writer.onDrain(); },
  } });
  const writer = new ConnWriter(socket);
  const conn: App = {
    request(method, params) {
      const id = next++;
      writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return new Promise((r) => pending.set(id, r));
    },
    close() { socket.end(); },
  };
  const hello = await conn.request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "android-e2e-engine", features: [] });
  if (hello.error !== undefined) throw new Error(`hello: ${JSON.stringify(hello.error)}`);
  return conn;
}

async function boot(): Promise<void> {
  daemon = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none",
    links: {
      binary: BIN, sidecar: { relay: "disabled", n0Lookup: false, bind: `127.0.0.1:${LINK_PORT}` }, handshake: null, publicTime: null,
      mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "linux" },
    },
    parts: {
      userHome,
      node: { terminals: { launch: () => ({ cmd: ["/bin/cat"], env: {} }) } },
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => () => new EchoDriver(), defaultModel: () => ({ model: "winter-test/calls" }) },
      agents: false,
    },
  });
  await daemon.mossParts.ready;
  app = await connectApp();
}

const ok = async <T>(method: string, params?: unknown): Promise<T> => {
  const r = await app.request(method, params);
  if (r.error !== undefined) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result as T;
};
const until = async (what: string, f: () => boolean | Promise<boolean>, ms = 60_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(50);
  }
};
const broker = () => daemon.mossParts.broker()!;
const answerHere = async (card: string, option: "approve" | "deny"): Promise<void> => {
  await until("the card", () => broker().cards().some((c: { id: string }) => c.id === card));
  const c = broker().cards().find((x: { id: string }) => x.id === card)!;
  const r = await broker().answer(c.id, { optionId: option, hash: c.hash, proof: { via: "sealed-frame", frame: broker().frameChannel(c.id)!, input: "click", at: Date.now() } }, { role: "app" });
  if (r !== "accepted") throw new Error(`the card answer was ${r}`);
};
// The words the engine's person reads, on the add card it raises at the words step. One pairing at a time.
const ADD_WORDS = /four words are the same[^:]*: ([a-z-]+) ([a-z-]+) ([a-z-]+) ([a-z-]+)/;
const readAddCards = new Set<string>();
const newWords = (): string[] | undefined => {
  for (const c of broker()?.cards() ?? []) {
    if (readAddCards.has(c.id) || !ADD_WORDS.test(JSON.stringify(c.fields))) continue;
    readAddCards.add(c.id);
    const m = ADD_WORDS.exec(JSON.stringify(c.fields))!;
    return [m[1]!, m[2]!, m[3]!, m[4]!];
  }
  return undefined;
};
const advertise = (qr: string): string => {
  const prefix = "clover-pair:1:";
  const v = decode(Buffer.from(qr.slice(prefix.length), "base64url")) as unknown[];
  const port = (a: string) => a.slice(a.lastIndexOf(":") + 1);
  const all = [...(v[4] as string[]), ...(v[5] as string[])];
  v[4] = [];
  v[5] = [...new Set(all.map((a) => `${ADVERTISE}:${port(a)}`))];
  return prefix + Buffer.from(encode(v)).toString("base64url");
};

const words = new Map<string, string[]>();
const decisions = new Map<string, Promise<unknown>>();
let testBot: { id: string; mainSession: string } | undefined;
let testCoding: string | undefined;

async function pair(): Promise<{ pairingId: string; qr: string }> {
  const v = await ok<{ pairingId: string; qr: string }>("device.pair.begin", { ttlMs: 10 * 60_000 });
  void (async () => {
    let w: string[] | undefined;
    await until("the phone's words", () => (w = newWords()) !== undefined, 10 * 60_000);
    words.set(v.pairingId, w!);
    log(`pairing ${v.pairingId}: words shown; confirming`);
    const r = await app.request("device.pair.confirm", { pairingId: v.pairingId, words: w });
    if (r.error !== undefined) return log(`confirm refused: ${JSON.stringify(r.error)}`);
    const res = r.result as { applied: boolean; card?: string };
    if (!res.applied && res.card) await answerHere(res.card, "approve");
    log(`pairing ${v.pairingId}: confirmed and approved`);
  })().catch((e) => log(`pairing ${v.pairingId} failed: ${(e as Error).message}`));
  return { pairingId: v.pairingId, qr: advertise(v.qr) };
}

async function bot(): Promise<{ id: string; mainSession: string }> {
  if (testBot) return testBot;
  const r = await ok<{ bot: { id: string; mainSession: string } }>("bot.create", { name: "Echo" });
  testBot = { id: r.bot.id, mainSession: r.bot.mainSession };
  log(`bot ${testBot.id} made`);
  return testBot;
}

async function coding(): Promise<string> {
  if (testCoding) return testCoding;
  const side = daemon.mossParts.bots()!;
  const v = side.host.open({ kind: "coding", computer: "Studio", title: "Phone test session", backend: "moss-code", root: "home/Studio/project1" }, new EchoDriver());
  testCoding = v.id as string;
  log(`coding session ${testCoding} opened`);
  return testCoding;
}

async function raiseCard(target: { bot?: string; session?: string }): Promise<string> {
  let shown: (id: string) => void = () => {};
  const id = new Promise<string>((r) => { shown = r; });
  const decision = broker().request(
    { kind: "change", change: "computer-level", effect: "other", origin: "user", computers: [], ...target, fields: { title: { type: "text", text: "Android test card" } } },
    { onCard: (c: string) => shown(c) },
  );
  const cardId = await id;
  decisions.set(cardId, decision);
  log(`card ${cardId} raised for ${JSON.stringify(target)}`);
  return cardId;
}

async function restart(): Promise<void> {
  log("restarting the engine");
  app.close();
  await daemon.stop();
  await boot();
  // The coding session's driver was this process's: open it again under its id, so it answers after the restart too.
  if (testCoding) {
    const side = daemon.mossParts.bots()!;
    // The host reloads it from its log with no driver; opening it under its id gives it this one (it refuses when it
    // already has one or has ended, which the log says).
    try {
      side.host.open({ id: testCoding, kind: "coding", computer: "Studio", title: "Phone test session", backend: "moss-code", root: "home/Studio/project1" }, new EchoDriver());
    } catch (e) {
      log(`the coding session wasn't opened again: ${(e as Error).message}`);
    }
  }
  log("restarted");
}

await boot();
await bot();
await coding();

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
Bun.serve({
  hostname: "127.0.0.1",
  port: CONTROL_PORT,
  idleTimeout: 255,
  async fetch(req) {
    const u = new URL(req.url);
    try {
      switch (u.pathname) {
        case "/pair": return json(await pair());
        case "/words": {
          const id = u.searchParams.get("pairing") ?? "";
          await until("the words", () => words.has(id), 120_000);
          return new Response(words.get(id)!.join(" "));
        }
        case "/bot": return json(await bot());
        case "/coding": return json({ id: await coding() });
        case "/card": {
          const b = u.searchParams.get("bot");
          const s = u.searchParams.get("session");
          return json({ cardId: await raiseCard(b ? { bot: b } : s ? { session: s } : {}) });
        }
        case "/decision": {
          const d = decisions.get(u.searchParams.get("card") ?? "");
          if (!d) return new Response("no such card", { status: 404 });
          return json({ decision: await Promise.race([d, Bun.sleep(60_000).then(() => "timeout")]) });
        }
        case "/restart": await restart(); return json({ ok: true });
        case "/phones": {
          const r = await ok<{ devices: { id: string; kind: string; app?: string }[] }>("device.list", {});
          return json(r.devices.filter((d) => d.kind === "phone").map((d) => ({ id: d.id, app: d.app ?? null })));
        }
        default: return new Response("not found", { status: 404 });
      }
    } catch (e) {
      log(`${u.pathname} failed: ${(e as Error).message}`);
      return new Response((e as Error).message, { status: 500 });
    }
  },
});
log(`control ready on ${CONTROL_PORT}; link on ${LINK_PORT}`);

async function stop(): Promise<void> {
  app.close();
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
}
process.on("SIGTERM", () => void stop().then(() => process.exit(0)));
