// A real engine for the phone core's tests: `startDaemon` from source on a temp home of its own, with the real link
// sidecar (`moss-link`, built from native/link) on loopback, no relay, nothing published, and the throwaway secrets
// file the core's own tests use. It plays the computer's person through its app connection: shows a pairing, confirms
// the words and approves (or denies) the sealed card, raises a card, revokes a device.
//
// Run with `--preload packages/core/test/preload.ts` (the core tests' isolation: temp roots, the throwaway keychain service).
// Driven by JSON lines on stdin ({id, cmd, ...}); answers one JSON line each on stdout ({id, ok, result | error}).
// The first line out is {"ready": true}. Nothing secret is printed: the QR (which carries the pairing secret) goes only
// back over the pipe to the test that asked, or with `--qr-file` to a file the Android job pushes to the emulator.
//
//   MOSS_LINK_BIN   the built sidecar (default native/link/target/release/moss-link)
//   --advertise H   rewrite the QR's addresses to host H (the Android emulator reaches its host at 10.0.2.2)
//   --qr-file P     with --auto: write one pairing's QR to P
//   --auto          confirm whatever words the pairing shows and approve its card; then raise a card when a phone is
//                   paired (the Android job's engine, which no test drives)
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const repo = resolve(import.meta.dir, "../../../..");
const core = join(repo, "packages/core");
const { startDaemon } = await import(join(core, "src/daemon"));
const { FileSecretStore } = await import(join(core, "src/auth/secret-store"));
const { Drivers } = await import(join(core, "src/bots/tests/fixtures"));
const { FakePluginRegistry } = await import(join(core, "src/contracts/fakes/plugin-registry"));
const { catalogPointDecl } = await import(join(repo, "packages/plugin-sdk/src/catalogs/index"));
const { decode, encode } = await import(join(core, "src/links/codec"));
const { MOSS_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS } = await import(Bun.resolveSync("@waifucave/moss-protocol", core));

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const BIN = process.env.MOSS_LINK_BIN ?? join(repo, "native/link/target/release/moss-link");
const log = (line: string) => process.stderr.write(`[engine] ${line}\n`);

const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-pc-engine-")));
const home = join(root, "home");
const daemon = await startDaemon({
  home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none",
  links: {
    binary: BIN, sidecar: { relay: "disabled", n0Lookup: false, bind: opt("--bind") ?? "127.0.0.1:0" }, handshake: null, publicTime: null,
    mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "linux" },
  },
  parts: {
    userHome: join(root, "user"),
    node: { terminals: { launch: () => ({ cmd: ["/bin/cat"], env: {} }) } },
    bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => new Drivers().factory, defaultModel: () => ({ model: "winter-test/calls" }) },
    agents: false,
  },
});
await daemon.mossParts.ready;

// The engine's own app connection, as the app reaches its socket.
const heard: Record<string, unknown>[] = [];
const app = await (async () => {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  let next = 1;
  const socket = await Bun.connect({ unix: daemon.socketPath, socket: {
    data(_s: unknown, chunk: Uint8Array) {
      for (const l of decoder.push(chunk)) {
        const m = JSON.parse(l) as Record<string, unknown>;
        // The engine's own requests to its app (`app.ping` among them): answered, or it takes the app for gone.
        if (typeof m.method === "string" && m.id !== undefined) writer.enqueue(encodeLine({ jsonrpc: "2.0", id: m.id, result: {} }));
        else if (typeof m.id === "number") { pending.get(m.id)?.(m); pending.delete(m.id); } else heard.push(m);
      }
    },
    drain() { writer.onDrain(); },
  } });
  const writer = new ConnWriter(socket);
  return {
    request(method: string, params?: unknown): Promise<Record<string, unknown>> {
      const id = next++;
      writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return new Promise((r) => pending.set(id, r));
    },
    close() { socket.end(); },
  };
})();
const ok = async <T>(method: string, params?: unknown): Promise<T> => {
  const r = await app.request(method, params);
  if (r.error !== undefined) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result as T;
};
const hello = await app.request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "phone-core-harness", features: [] });
if (hello.error !== undefined) throw new Error(`hello: ${JSON.stringify(hello.error)}`);
await ok("events.subscribe", { areas: ["devices"] });

const until = async (what: string, f: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(20);
  }
};
const broker = () => daemon.mossParts.broker()!;
/** Answers a card as the computer's person does, in the card's sealed frame. */
const answerHere = async (card: string, option: "approve" | "deny"): Promise<void> => {
  await until("the card", () => broker().cards().some((c: { id: string }) => c.id === card));
  const c = broker().cards().find((x: { id: string }) => x.id === card)!;
  const r = await broker().answer(c.id, { optionId: option, hash: c.hash, proof: { via: "sealed-frame", frame: broker().frameChannel(c.id)!, input: "click", at: Date.now() } }, { role: "app" });
  if (r !== "accepted") throw new Error(`the card answer was ${r}`);
};
/** The words the engine shows its person: an app is never given them, so they are read where the person reads them, on
 *  the add card the engine raises at the words step ("Check that these four words are the same ...: w1 w2 w3 w4"). One
 *  pairing at a time here, so the pending add card is this pairing's. */
const ADD_WORDS = /four words are the same[^:]*: ([a-z-]+) ([a-z-]+) ([a-z-]+) ([a-z-]+)/;
/** Add cards already read for an earlier pairing: never this pairing's. */
const readAddCards = new Set<string>();
const pendingAddCards = () => (broker()?.cards() ?? []).filter((c: { fields: unknown }) => ADD_WORDS.test(JSON.stringify(c.fields)));
const wordsOf = (_pairingId: string): string[] | undefined => {
  for (const c of pendingAddCards()) {
    if (readAddCards.has(c.id)) continue;
    const m = ADD_WORDS.exec(JSON.stringify(c.fields))!;
    readAddCards.add(c.id);
    return [m[1]!, m[2]!, m[3]!, m[4]!];
  }
  return undefined;
};
/** The QR with its dial hints pointed at another host (they are hints only: not in the transcript, and iroh checks
 *  the key). */
const advertise = (qr: string, host: string): string => {
  const prefix = "clover-pair:1:";
  const v = decode(Buffer.from(qr.slice(prefix.length), "base64url")) as unknown[];
  const port = (a: string) => a.slice(a.lastIndexOf(":") + 1);
  const all = [...(v[4] as string[]), ...(v[5] as string[])];
  v[4] = [];
  v[5] = [...new Set(all.map((a) => `${host}:${port(a)}`))];
  return prefix + Buffer.from(encode(v)).toString("base64url");
};

const decisions = new Map<string, Promise<unknown>>();
async function run(cmd: Record<string, unknown>): Promise<unknown> {
  switch (cmd.cmd) {
    case "begin": {
      const v = await ok<{ pairingId: string; qr: string }>("device.pair.begin", {});
      return { pairingId: v.pairingId, qr: typeof cmd.advertise === "string" ? advertise(v.qr, cmd.advertise) : v.qr };
    }
    case "addCards":
      // How many add cards are still pending (a pairing that ended should leave none).
      return pendingAddCards().length;
    case "words": {
      let words: string[] | undefined;
      await until("the engine showing the words", () => (words = wordsOf(cmd.pairingId as string)) !== undefined);
      return words;
    }
    case "confirm": {
      // The person confirms the words they read (`words`, possibly wrong); an app caller's add is a sealed card.
      const r = await app.request("device.pair.confirm", { pairingId: cmd.pairingId, words: cmd.words });
      if (r.error !== undefined) return { refused: (r.error as { message?: string }).message ?? "refused" };
      const res = r.result as { applied: boolean; card?: string };
      if (!res.applied && res.card) await answerHere(res.card, cmd.approve === false ? "deny" : "approve");
      return { card: res.card ?? null };
    }
    case "cancel":
      return ok("device.pair.cancel", { pairingId: cmd.pairingId });
    case "devices":
      return ok("device.list", {});
    case "waitDevice":
      try {
        await until("the phone in the device list", async () => (await ok<{ devices: { id: string }[] }>("device.list", {})).devices.some((d) => d.id === cmd.device), 15_000);
      } catch (err) {
        // What the engine's pairing said (its steps and error), the words left out.
        const steps = heard.map((m) => (m.params ?? m) as Record<string, unknown>).map((p) => (p.event ?? p) as Record<string, unknown>)
          .filter((ev) => ev.type === "pairing_changed").map(({ words: _w, ...rest }) => rest);
        throw new Error(`${(err as Error).message}; the engine's pairing events: ${JSON.stringify(steps)}`);
      }
      return true;
    case "raiseCard": {
      // A change card: always a card, whatever the level (rule 1).
      let shown: (id: string) => void = () => {};
      const id = new Promise<string>((r) => { shown = r; });
      const decision = broker().request(
        { kind: "change", change: "computer-level", effect: "other", origin: "user", computers: [], fields: { title: { type: "text", text: (cmd.title as string) ?? "Phone core test card" } } },
        { onCard: (c: string) => shown(c) },
      );
      const cardId = await id;
      decisions.set(cardId, decision);
      return { cardId };
    }
    case "bounce": {
      // The link sidecar this engine started dies (its own child, by its pid); the engine starts it again on the same
      // address, and the phone must notice the loss and dial back.
      const pid = daemon.mossParts.links()?.sidecarPid();
      if (!pid) throw new Error("no link sidecar");
      process.kill(pid, "SIGKILL");
      return { pid };
    }
    case "decision":
      return decisions.get(cmd.cardId as string);
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
  app.close();
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
}
process.on("SIGTERM", () => void stop().then(() => process.exit(0)));

if (flag("--auto")) {
  // The Android job's engine: one pairing, confirmed and approved as soon as it shows words, then a card per phone.
  const v = await ok<{ pairingId: string; qr: string }>("device.pair.begin", { ttlMs: 30 * 60_000 });
  const qr = opt("--advertise") ? advertise(v.qr, opt("--advertise")!) : v.qr;
  if (opt("--qr-file")) writeFileSync(opt("--qr-file")!, qr, { mode: 0o600 });
  // The emulator reads it from this socket (10.0.2.2 from inside it): loopback only, one QR per connection.
  if (opt("--qr-port")) Bun.listen({ hostname: "127.0.0.1", port: Number(opt("--qr-port")), socket: { open(s) { s.write(qr); s.end(); }, data() {} } });
  log("pairing shown; QR ready");
  let words: string[] | undefined;
  await until("the phone's words", () => (words = wordsOf(v.pairingId)) !== undefined, 30 * 60_000);
  log("words shown; confirming");
  await run({ cmd: "confirm", pairingId: v.pairingId, words });
  log("confirmed and approved");
  for (;;) {
    const devices = await ok<{ devices: { kind?: string; isThis: boolean }[] }>("device.list", {});
    if (devices.devices.some((d) => !d.isThis)) break;
    await Bun.sleep(200);
  }
  const { cardId } = (await run({ cmd: "raiseCard", title: "Android test card" })) as { cardId: string };
  log(`card raised ${cardId}`);
  log(`card decision ${JSON.stringify(await decisions.get(cardId))}`);
  await new Promise(() => {});
}

process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let cmd: Record<string, unknown>;
  try { cmd = JSON.parse(line); } catch { return; }
  if (cmd.cmd === "stop") {
    void stop().then(() => { process.stdout.write(`${JSON.stringify({ id: cmd.id, ok: true })}\n`); process.exit(0); });
    return;
  }
  run(cmd).then(
    (result) => process.stdout.write(`${JSON.stringify({ id: cmd.id, ok: true, result: result ?? null })}\n`),
    (err: unknown) => process.stdout.write(`${JSON.stringify({ id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) })}\n`),
  );
});
rl.on("close", () => void stop().then(() => process.exit(0)));
