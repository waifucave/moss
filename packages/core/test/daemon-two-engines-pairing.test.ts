// Two real engines pair with no account (spec §8.1, lane DV's row): each a `startDaemon` on a home of its own, over one in-memory
// network (a source run has no link sidecar, and nothing here leaves the process). The app of each reaches its engine's socket as
// the app does: A shows a code, B joins it. An app is not a terminal: the engine raises the add card itself on each side, drawing
// the four words only there (never in the app's join result nor in any event an app hears; the user's terminal gets them), and
// the add takes effect only when the person presses each card in its sealed frame. Then the device list on both sides, the
// removal's own card, and the relay choice kept across a restart.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOSS_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, type WritableSocket } from "@waifucave/moss-protocol";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { FileSecretStore } from "../src/auth/secret-store";
import { Drivers } from "../src/bots/tests/fixtures";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { MemoryNetwork } from "../src/links/memory-wire";

setDefaultTimeout(90_000);

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


type Engine = { daemon: RunningDaemon; home: string; app: Awaited<ReturnType<typeof rpc>> };

async function engine(root: string, name: string, net: MemoryNetwork): Promise<Engine> {
  const home = join(root, name);
  const daemon = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none",
    links: {
      wire: (k) => net.endpoint(k.publicKey), handshake: null, publicTime: null,
      mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name, os: "macos" },
    },
    parts: {
      userHome: join(root, `${name}-user`),
      node: { terminals: { launch: () => ({ cmd: ["/bin/cat"], env: {} }) } },
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => new Drivers().factory, defaultModel: () => ({ model: "winter-test/calls" }) },
      agents: false,
    },
  });
  running.push(daemon);
  await daemon.mossParts.ready;
  const app = await rpc(daemon.socketPath);
  const hello = await app.request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "app", token: readFileSync(join(home, "run", "app.token"), "utf8"), clientName: "test-app", features: [] });
  expect(hello["error"]).toBeUndefined();
  expect((await app.request("events.subscribe", { areas: ["devices"] }))["error"]).toBeUndefined();
  return { daemon, home, app };
}

const ok = async <T>(e: Engine, method: string, params?: unknown): Promise<T> => {
  const r = await e.app.request(method, params);
  if (r["error"] !== undefined) throw new Error(`${method}: ${JSON.stringify(r["error"])}`);
  return r["result"] as T;
};
const until = async (what: string, f: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 400; i++) { if (await f()) return; await Bun.sleep(15); }
  throw new Error(`timed out: ${what}`);
};
const approve = async (e: Engine, card: string): Promise<void> => {
  const broker = e.daemon.mossParts.broker()!;
  await until("the card", async () => broker.cards().some((c) => c.id === card));
  const c = broker.cards().find((x) => x.id === card)!;
  expect(await broker.answer(c.id, { optionId: "approve", hash: c.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(c.id)!, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
};
type Devices = { devices: { id: string; name: string; isThis: boolean }[] };

test("two engines on two temp homes pair without an account, list each other, and the removal asks on its sealed card", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-dv-pair-")));
  const net = new MemoryNetwork();
  const a = await engine(root, "Studio", net);
  const b = await engine(root, "Laptop", net);

  // The user's terminal on A hears the words (the one place a typed confirm needs them); the apps never do.
  const terminal = await rpc(a.daemon.socketPath);
  expect((await terminal.request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "cli", token: a.daemon.tokens.harness, clientName: "test-terminal", features: [] }))["error"]).toBeUndefined();
  expect((await terminal.request("events.subscribe", { areas: ["devices"] }))["error"]).toBeUndefined();

  // A shows a code; B joins it, both from the app.
  const begun = await ok<{ pairingId: string; qr: string }>(a, "device.pair.begin", {});
  const joined = await ok<{ pairingId: string; words?: string[] }>(b, "device.pair.join", { code: begun.qr });
  // B's app is given no words in the join's answer.
  expect(joined.words).toBeUndefined();
  const stepOf = (c: { heard: Record<string, unknown>[] }, step: string) => c.heard.map((m) => (m["params"] ?? m) as Record<string, unknown>).map((p) => (p["event"] ?? p) as Record<string, unknown>).find((ev) => ev["type"] === "pairing_changed" && ev["step"] === step);
  await until("A's terminal hearing the words", async () => stepOf(terminal, "words") !== undefined);
  const words = stepOf(terminal, "words")!["words"] as string[];
  expect(words).toHaveLength(4);
  // A's app hears the step and the other device's name; never the words.
  await until("A's app hearing the step", async () => stepOf(a.app, "words") !== undefined);
  expect(stepOf(a.app, "words")!["peerName"]).toBe("Laptop");
  // The words are ordinary words, and a few of them ("card", "step", "name", "area") are also words the events themselves use, so one word
  // alone proves nothing: what must never be heard is the four together, in any form the engine writes them (the phrase, a list, a joined string).
  const heardAll = JSON.stringify([a.app.heard, b.app.heard]);
  for (const form of [words.join(" "), words.join(","), words.join("-"), JSON.stringify(words), words.join(`","`)]) expect(heardAll).not.toContain(form);
  // Nobody asked for a card: the engine drew one on each side, with the four words, and nothing is added yet.
  const brokerA = a.daemon.mossParts.broker()!;
  const brokerB = b.daemon.mossParts.broker()!;
  await until("a card on each side", async () => brokerA.cards().length === 1 && brokerB.cards().length === 1);
  expect(JSON.stringify(brokerA.cards()[0])).toContain(words.join(" "));
  expect(JSON.stringify(brokerB.cards()[0])).toContain(words.join(" "));
  expect((await ok<Devices>(a, "device.list", {})).devices).toHaveLength(1);
  // A page that asks to confirm (any caller but the terminal) gets the same card back, never a second.
  const again = await ok<{ applied: boolean; card?: string }>(a, "device.pair.confirm", { pairingId: begun.pairingId, words });
  expect(again).toEqual({ applied: false, card: brokerA.cards()[0]!.id });
  expect(brokerA.cards()).toHaveLength(1);
  // The person presses A's card: still nothing, B's has not been pressed.
  await approve(a, brokerA.cards()[0]!.id);
  await Bun.sleep(100);
  expect((await ok<Devices>(a, "device.list", {})).devices).toHaveLength(1);
  await approve(b, brokerB.cards()[0]!.id);
  terminal.close();
  await until("both lists holding both computers", async () => (await ok<Devices>(a, "device.list", {})).devices.length === 2 && (await ok<Devices>(b, "device.list", {})).devices.length === 2);
  const listA = (await ok<Devices>(a, "device.list", {})).devices;
  const listB = (await ok<Devices>(b, "device.list", {})).devices;
  expect(listA.map((d) => d.name).sort()).toEqual(["Laptop", "Studio"]);
  expect(listB.map((d) => d.name).sort()).toEqual(["Laptop", "Studio"]);
  expect(listA.filter((d) => d.isThis).map((d) => d.name)).toEqual(["Studio"]);
  expect(listB.filter((d) => d.isThis).map((d) => d.name)).toEqual(["Laptop"]);

  // Removing the other computer asks first, on a sealed card; only approving it takes the device away.
  const laptop = listA.find((d) => !d.isThis)!;
  const removal = await ok<{ applied: boolean; card?: string }>(a, "device.revoke", { id: laptop.id });
  expect(removal.applied).toBe(false);
  expect((await ok<Devices>(a, "device.list", {})).devices).toHaveLength(2);
  await approve(a, removal.card!);
  await until("the laptop gone from A", async () => (await ok<Devices>(a, "device.list", {})).devices.length === 1);
  expect((await ok<Devices>(a, "device.list", {})).devices[0]!.name).toBe("Studio");
});

test("the relay choice: n0's public relays until chosen, kept in the settings, refused without an https address, and read back after a restart", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-dv-relay-")));
  const first = await engine(root, "Studio", new MemoryNetwork());
  expect(await ok(first, "device.relay.get", {})).toEqual({ mode: "n0" });
  expect((await first.app.request("device.relay.set", { mode: "custom", url: "http://relay.example.test" }))["error"]).toBeDefined();
  expect(await ok(first, "device.relay.set", { mode: "custom", url: "https://relay.example.test" })).toEqual({ mode: "custom", url: "https://relay.example.test/" });
  first.app.close();
  await running.splice(running.indexOf(first.daemon), 1)[0]!.stop();
  const again = await engine(root, "Studio", new MemoryNetwork());
  expect(await ok(again, "device.relay.get", {})).toEqual({ mode: "custom", url: "https://relay.example.test/" });
  expect(await ok(again, "device.relay.set", { mode: "off" })).toEqual({ mode: "off" });
  expect(await ok(again, "device.relay.set", { mode: "n0" })).toEqual({ mode: "n0" });
});
