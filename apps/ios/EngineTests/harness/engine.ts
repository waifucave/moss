// A real engine for the iPhone apps' engine tests (lane IW): `startDaemon` from source on a temp home of its own, with the
// real link sidecar (`moss-link`) on a FIXED loopback port, no relay, nothing published, and the throwaway secrets file the
// core tests use. It plays the computer's person through its own app connection (shows a pairing, confirms the words and
// approves the sealed add card, raises a card, restarts the whole engine on the same home, revokes a device), and gives the
// bots and a coding session fake brains that answer at once:
//   * every bot's turn records `Reply: <the message>` and ends (a driver of this file's, no model);
//   * the coding session runs on a scripted fake agent backend (`FakeAgentBackend`) that says `Coding reply`.
//
// The simulator test drives it over a loopback TCP port (`--control-port`, default 8790), one JSON line per command
// ({id, cmd, ...}) answered by one line ({id, ok, result | error}). Nothing secret is printed: the QR goes only back over
// that socket to the test that asked for it.
//
// Run with `--preload packages/core/test/preload.ts` (temp roots, the throwaway keychain service). `--memory` uses an
// in-memory wire instead of the sidecar (to try the engine side on a machine with no moss-link; no phone can dial it).
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const core = join(repo, "packages/core");
const { startDaemon } = await import(join(core, "src/daemon"));
const { FileSecretStore } = await import(join(core, "src/auth/secret-store"));
const { FakePluginRegistry } = await import(join(core, "src/contracts/fakes/plugin-registry"));
const { FakeAgentBackend } = await import(join(core, "src/contracts/fakes/agent-backend"));
const { SystemClock } = await import(join(core, "src/clock/system-clock"));
const { MemoryNetwork } = await import(join(core, "src/links/memory-wire"));
const { MossSecretStore, KeychainValues, memoryVault } = await import(join(core, "src/secrets/moss-secret-store"));
const { catalogPointDecl } = await import(join(repo, "packages/plugin-sdk/src/catalogs/index"));
const { MOSS_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS } = await import(Bun.resolveSync("@waifucave/moss-protocol", core));

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const BIN = process.env.MOSS_LINK_BIN ?? join(repo, "native/link/target/release/moss-link");
const BIND = opt("--bind") ?? "127.0.0.1:47811";
const CONTROL_PORT = Number(opt("--control-port") ?? 8790);
const MEMORY = args.includes("--memory");
const log = (line: string) => process.stderr.write(`[iw-engine] ${line}\n`);

const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-iw-engine-")));
const home = join(root, "home");
const userHome = join(root, "user");
const project = join(userHome, "project1");
mkdirSync(project, { recursive: true });

/** A bot's brain for these tests: each turn says `Reply: <the message>` and ends. */
class ReplyDriver {
  readonly canFold = true;
  async turn(input: { text?: string }, ctl: { record(e: { type: string; [k: string]: unknown }): void; signal: AbortSignal }) {
    await Bun.sleep(150);
    if (ctl.signal.aborted) return { reason: "interrupted" as const };
    const text = `Reply: ${String(input.text ?? "").slice(0, 200)}`;
    ctl.record({ type: "assistant_message", text });
    return { reason: "end_turn" as const, text };
  }
  async interrupt() {}
  async stop() {}
}

const clock = new SystemClock();
const fakeAgent = () => new FakeAgentBackend({ id: "fake-agent", clock, script: Array.from({ length: 50 }, () => [{ say: "Coding reply" }, { end: "end_turn" }]) });

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
let daemon: Daemon;
const net = MEMORY ? new MemoryNetwork() : undefined;
// The engine's own secrets (its device key among them) in memory, as a test daemon keeps them, but ONE store for the
// harness's whole life: an engine restarted on this home is the same device, with the same link key.
const contractSecrets = new MossSecretStore({ home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });

async function boot(): Promise<void> {
  daemon = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), contractSecrets, agentProvider: null, appPeer: "none",
    links: {
      ...(net ? { wire: (k: { publicKey: Uint8Array }) => net.endpoint(k.publicKey) } : { binary: BIN, sidecar: { relay: "disabled", n0Lookup: false, bind: BIND } }),
      handshake: null, publicTime: null,
      mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "linux" },
    },
    parts: {
      userHome,
      node: { terminals: { launch: () => ({ cmd: ["/bin/cat"], env: {} }) } },
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => () => new ReplyDriver(), defaultModel: () => ({ model: "winter-test/calls" }) },
      agents: { defaultModel: () => "winter-test/calls", backends: () => [fakeAgent()] },
    },
  });
  await daemon.mossParts.ready;
  await connectApp();
}

// The engine's own app connection, as the app reaches its socket.
let app: { request(method: string, params?: unknown): Promise<Record<string, unknown>>; close(): void };
const heard: Record<string, unknown>[] = [];
async function connectApp(): Promise<void> {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  let next = 1;
  // eslint-disable-next-line prefer-const
  let writer: InstanceType<typeof ConnWriter>;
  const socket = await Bun.connect({ unix: daemon.socketPath, socket: {
    data(_s: unknown, chunk: Uint8Array) {
      for (const l of decoder.push(chunk)) {
        const m = JSON.parse(l) as Record<string, unknown>;
        if (typeof m.method === "string" && m.id !== undefined) writer.enqueue(encodeLine({ jsonrpc: "2.0", id: m.id, result: {} }));
        else if (typeof m.id === "number") { pending.get(m.id)?.(m); pending.delete(m.id); } else heard.push(m);
      }
    },
    drain() { writer.onDrain(); },
  } });
  writer = new ConnWriter(socket);
  app = {
    request(method: string, params?: unknown) {
      const id = next++;
      writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return new Promise((r) => pending.set(id, r));
    },
    close() { socket.end(); },
  };
  const hello = await app.request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "iw-harness", features: [] });
  if (hello.error !== undefined) throw new Error(`hello: ${JSON.stringify(hello.error)}`);
  await ok("events.subscribe", { areas: ["devices"] });
}

const ok = async <T>(method: string, params?: unknown): Promise<T> => {
  const r = await app.request(method, params);
  if (r.error !== undefined) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result as T;
};
const until = async (what: string, f: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(20);
  }
};
const broker = () => daemon.mossParts.broker()!;
const answerHere = async (card: string, option: "approve" | "deny"): Promise<void> => {
  await until("the card", () => broker().cards().some((c: { id: string }) => c.id === card));
  const c = broker().cards().find((x: { id: string }) => x.id === card)!;
  const r = await broker().answer(c.id, { optionId: option, hash: c.hash, proof: { via: "sealed-frame", frame: broker().frameChannel(c.id)!, input: "click", at: Date.now() } }, { role: "app" });
  if (r !== "accepted") throw new Error(`the card answer was ${r}`);
};
/** The words the engine shows its person, read where the person reads them: on the add card (as phone-core's harness). */
const ADD_WORDS = /four words are the same[^:]*: ([a-z-]+) ([a-z-]+) ([a-z-]+) ([a-z-]+)/;
const readAddCards = new Set<string>();
const wordsNow = (): string[] | undefined => {
  for (const c of broker()?.cards() ?? []) {
    const m = ADD_WORDS.exec(JSON.stringify(c.fields));
    if (!m || readAddCards.has(c.id)) continue;
    readAddCards.add(c.id);
    return [m[1]!, m[2]!, m[3]!, m[4]!];
  }
  return undefined;
};

const decisions = new Map<string, Promise<unknown>>();
async function run(cmd: Record<string, unknown>): Promise<unknown> {
  switch (cmd.cmd) {
    case "begin": {
      const v = await ok<{ pairingId: string; qr: string }>("device.pair.begin", {});
      return { pairingId: v.pairingId, qr: v.qr };
    }
    case "words": {
      let words: string[] | undefined;
      await until("the engine showing the words", () => (words = wordsNow()) !== undefined);
      return words;
    }
    case "confirm": {
      const r = await app.request("device.pair.confirm", { pairingId: cmd.pairingId, words: cmd.words });
      if (r.error !== undefined) return { refused: (r.error as { message?: string }).message ?? "refused" };
      const res = r.result as { applied: boolean; card?: string };
      if (!res.applied && res.card) await answerHere(res.card, "approve");
      return { card: res.card ?? null };
    }
    case "waitDevice":
      await until("the phone in the device list", async () => (await ok<{ devices: { id: string }[] }>("device.list", {})).devices.some((d) => d.id === cmd.device), 20_000);
      return true;
    case "devices":
      return ok("device.list", {});
    case "phones": {
      // The phones the engine knows (not revoked), by id.
      const d = await ok<{ devices: { id: string; kind?: string; isThis: boolean }[] }>("device.list", {});
      return d.devices.filter((x) => !x.isThis && x.kind === "phone").map((x) => x.id);
    }
    case "makeBot": {
      const bots = await ok<{ bots: { id: string; name: string; mainSession: string }[] }>("bot.list", {});
      const have = bots.bots.find((b) => b.name === cmd.name);
      if (have) return have;
      const made = await ok<{ bot: { id: string; name: string; mainSession: string } }>("bot.create", { name: cmd.name });
      return made.bot;
    }
    case "startCoding": {
      // A coding session on the fake agent, in a folder of this computer's home, as the desktop's start makes one.
      const r = await ok<{ session: string }>("agent.start", { backend: "fake-agent", computer: "Studio", root: (cmd.root as string) ?? "home/Studio/project1" });
      return r;
    }
    case "sessions":
      return ok("session.list", {});
    case "appSend":
      // The computer's person sends in a session (to try the fake brains without a phone).
      return ok("session.send", { id: cmd.session, message: { text: cmd.text, clientMessageId: `app-${Date.now()}` } });
    case "history":
      return ok("session.history", { id: cmd.session, limit: 50 });
    case "raiseCard": {
      // A change card: always a card, whatever the level. `bot` or `session` says whose it is (which app shows it).
      let shown: (id: string) => void = () => {};
      const id = new Promise<string>((r) => { shown = r; });
      const decision = broker().request(
        {
          kind: "change", change: "computer-level", effect: "other", origin: "user", computers: [],
          ...(typeof cmd.bot === "string" ? { bot: cmd.bot } : {}), ...(typeof cmd.session === "string" ? { session: cmd.session } : {}),
          fields: { title: { type: "text", text: (cmd.title as string) ?? "Phone test card" } },
        },
        { onCard: (c: string) => shown(c) },
      );
      const cardId = await id;
      decisions.set(cardId, decision);
      return { cardId };
    }
    case "decision":
      return decisions.get(cmd.cardId as string);
    case "pendingCards":
      return broker().cards().map((c: { id: string }) => c.id);
    case "restart": {
      // The whole engine stops and starts again on the same home: the same link key, the same bound address.
      app.close();
      await daemon.stop();
      decisions.clear();
      await boot();
      return { restarted: true };
    }
    case "revoke": {
      const r = await ok<{ applied: boolean; card?: string }>("device.revoke", { id: cmd.device });
      if (!r.applied && r.card) await answerHere(r.card, "approve");
      await until("the device gone", async () => !(await ok<{ devices: { id: string }[] }>("device.list", {})).devices.some((d) => d.id === cmd.device));
      return true;
    }
    default:
      throw new Error(`unknown command ${String(cmd.cmd)}`);
  }
}

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try { app.close(); await daemon.stop(); } finally { rmSync(root, { recursive: true, force: true }); }
}
process.on("SIGTERM", () => void stop().then(() => process.exit(0)));
process.on("SIGINT", () => void stop().then(() => process.exit(0)));

await boot();

// The control port: loopback only.
Bun.listen({
  hostname: "127.0.0.1", port: CONTROL_PORT,
  socket: {
    data(s, chunk) {
      const buf = ((s.data as { buf?: string } | undefined)?.buf ?? "") + new TextDecoder().decode(chunk);
      const lines = buf.split("\n");
      s.data = { buf: lines.pop() ?? "" };
      for (const line of lines) {
        if (line.trim() === "") continue;
        let cmd: Record<string, unknown>;
        try { cmd = JSON.parse(line); } catch { continue; }
        // The command's name and outcome only: never a QR or a word.
        run(cmd).then(
          (result) => { log(`${String(cmd.cmd)} ok`); s.write(`${JSON.stringify({ id: cmd.id, ok: true, result: result ?? null })}\n`); },
          (err: unknown) => { log(`${String(cmd.cmd)} failed: ${err instanceof Error ? err.message : String(err)}`); s.write(`${JSON.stringify({ id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) })}\n`); },
        );
      }
    },
  },
});
log(`engine ready; control on 127.0.0.1:${CONTROL_PORT}${MEMORY ? " (memory wire)" : ` sidecar ${BIND}`}`);
