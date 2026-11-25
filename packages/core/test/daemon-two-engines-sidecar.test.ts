// Lane XC, step 4's host-level proof: two real daemons on two temp homes, each with its own link sidecar (the built
// `moss-link`) on loopback with no relay and no lookup, pair through the product's own path (A's QR, B's join, the four
// words in each user's terminal, the terminals' confirm) and then A reads a file on B's disk through the tree. Run by
// the link job, which builds the sidecar (`MOSS_LINK_REQUIRE_BINARY=1`); skipped where it isn't built, and on Windows.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOSS_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/moss-protocol";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { FileSecretStore } from "../src/auth/secret-store";
import { Drivers } from "../src/bots/tests/fixtures";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../src/daemon";

setDefaultTimeout(120_000);

const BIN = process.env.MOSS_LINK_BIN ?? join(import.meta.dir, "../../../native/link/target/release/moss-link");
const built = existsSync(BIN);
if (!built && process.env.MOSS_LINK_REQUIRE_BINARY === "1") throw new Error(`MOSS_LINK_REQUIRE_BINARY=1, but there is no moss-link at ${BIN}`);

const running: RunningDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop();
});

/** A raw MOSS connection: requests by id, and every notification the daemon sends. */
async function rpc(path: string) {
  const decoder = new LineDecoder();
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  const heard: Record<string, unknown>[] = [];
  let next = 1;
  const socket = await Bun.connect({ unix: path, socket: {
    data(_s, chunk) {
      for (const l of decoder.push(chunk)) {
        const m = JSON.parse(l) as Record<string, unknown>;
        // A request from the daemon (its app.ping): answered as an app would, so the pair stays up past 15 s.
        if (typeof m["method"] === "string" && m["id"] !== undefined) { writer.enqueue(encodeLine({ jsonrpc: "2.0", id: m["id"], result: {} })); continue; }
        if (typeof m["id"] === "number") { pending.get(m["id"])?.(m); pending.delete(m["id"]); } else heard.push(m);
      }
    },
    drain() { writer.onDrain(); },
  } });
  const writer = new ConnWriter(socket as unknown as WritableSocket);
  return {
    heard,
    request(method: string, params?: unknown): Promise<Record<string, unknown>> {
      const id = next++;
      writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
      return new Promise((r) => pending.set(id, r));
    },
    close() { socket.end(); },
  };
}
type Conn = Awaited<ReturnType<typeof rpc>>;

const ok = async <T>(c: Conn, method: string, params?: unknown): Promise<T> => {
  const r = await c.request(method, params);
  if (r["error"] !== undefined) throw new Error(`${method}: ${JSON.stringify(r["error"])}`);
  return r["result"] as T;
};
let lastSeenText = "";
const lastSeen = () => lastSeenText;
const until = async <T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 60_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}${lastSeen() === "" ? "" : ` (last: ${lastSeen()})`}`);
    await Bun.sleep(50);
  }
};

async function engine(root: string, name: string): Promise<{ daemon: RunningDaemon; home: string; user: string; app: Conn; terminal: Conn }> {
  const home = join(root, name);
  const user = join(root, `${name}-user`);
  mkdirSync(user, { recursive: true });
  const daemon = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none",
    // Loopback only, no relay, nothing published: nothing leaves the machine.
    links: {
      binary: BIN, sidecar: { relay: "disabled", n0Lookup: false, bind: "127.0.0.1:0" }, handshake: null, publicTime: null,
      mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name, os: process.platform === "darwin" ? "macos" : "linux" },
    },
    parts: {
      userHome: user,
      node: { terminals: { launch: () => ({ cmd: ["/bin/cat"], env: {} }) } },
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => new Drivers().factory, defaultModel: () => ({ model: "winter-test/calls" }) },
      agents: false,
    },
  });
  running.push(daemon);
  await daemon.mossParts.ready;
  const app = await rpc(daemon.socketPath);
  expect((await app.request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "test-app", features: [] }))["error"]).toBeUndefined();
  // The user's own terminal (the CLI role, the harness token): the one place the four words are said.
  const terminal = await rpc(daemon.socketPath);
  expect((await terminal.request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "cli", token: daemon.tokens.harness, clientName: "test-terminal", features: [] }))["error"]).toBeUndefined();
  expect((await terminal.request("events.subscribe", { areas: ["devices"] }))["error"]).toBeUndefined();
  return { daemon, home, user, app, terminal };
}

const wordsHeard = (c: Conn): string[] | undefined => c.heard
  .map((m) => (m["params"] ?? m) as Record<string, unknown>).map((p) => (p["event"] ?? p) as Record<string, unknown>)
  .find((ev) => ev["type"] === "pairing_changed" && ev["step"] === "words")?.["words"] as string[] | undefined;

describe.skipIf(!built || process.platform === "win32")("two engines over the real link sidecar (lane XC)", () => {
  test("they pair through the product's own path on loopback, and one reads a file on the other's disk through the tree", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-xc-link-")));
    const a = await engine(root, "Alpha");
    const b = await engine(root, "Beta");
    try {
      // Begun and joined in each user's own terminal, so each confirms there with the words it shows (a pairing an app
      // began is confirmed on its sealed card instead).
      const begun = await ok<{ pairingId: string; qr: string }>(a.terminal, "device.pair.begin", {});
      const joined = await ok<{ pairingId: string }>(b.terminal, "device.pair.join", { code: begun.qr });
      const wa = await until("Alpha's terminal hearing the words", () => wordsHeard(a.terminal));
      const wb = await until("Beta's terminal hearing the words", () => wordsHeard(b.terminal));
      expect(wa).toEqual(wb);
      await ok(a.terminal, "device.pair.confirm", { pairingId: begun.pairingId, words: wa });
      await ok(b.terminal, "device.pair.confirm", { pairingId: joined.pairingId, words: wb });
      const names = async (c: Conn) => (await ok<{ devices: { name: string }[] }>(c, "device.list", {})).devices.map((d) => d.name).sort();
      await until("both listing Alpha and Beta", async () => ((await names(a.app)).join() === "Alpha,Beta" && (await names(b.app)).join() === "Alpha,Beta" ? true : undefined));
      // A file only Beta's disk holds, read from Alpha through the tree.
      writeFileSync(join(b.user, "kept-on-beta.md"), "PROBE-ON-BETA");
      let last = "";
      const data = await until("Alpha reading Beta's file", async () => {
        // Through Alpha's own node (the tree's methods are a peer's and a plugin layer's, never the user's socket's): it
        // goes over the link to Beta, whose holder reads its own disk.
        try {
          return await a.daemon.mossParts.node()!.tree.read("home/Beta/kept-on-beta.md", { as: { kind: "core" }, encoding: "utf8" });
        } catch (e) { last = String(e); lastSeenText = last; return undefined; }
      });
      expect(JSON.stringify(data)).toContain("PROBE-ON-BETA");
      void last;
    } finally {
      for (const e of [a, b]) { e.app.close(); e.terminal.close(); }
    }
  });
});
