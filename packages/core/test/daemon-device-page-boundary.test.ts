// What a plugin's page can do about pairing, against two real engines (spec §8, §5.5; the standing ruling that the four words and the
// confirming are a sealed card the person presses). The page is the worst one: it holds every capability, main hands it a fresh key
// press on EVERY call (main's door is given every capability; the engine's own layer grant is what its OK card gave), and it calls every method its door names, the layer door's whole list, `card.answer` and `device.pair.confirm`,
// with the pairing's real id, forged words, the other device's id and a made-up card answer. The page's door is main's
// `routeCall` (apps/desktop), joined to a real app connection and a real layer connection of the engine.
//
//   * no device is added on either side until the person presses the add card on each (the engine's own sealed card);
//   * nothing the page is handed, a result, an error or an event, holds the four words, nor does any app connection's event;
//   * the same page, pressing for the person (the positive control), pairs only through the card, and Remove asks on its own card.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOSS_PROTOCOL_VERSION, ConnWriter, encodeLine, LineDecoder, METHODS, allowedMethods, type WritableSocket } from "@waifucave/moss-protocol";
import { CAPABILITIES } from "../../plugin-sdk/src/catalogs/capabilities";
import { PLUGIN_API_VERSION } from "@waifucave/moss-plugin-sdk";
import { catalogPointDecl } from "../../plugin-sdk/src/catalogs/index";
import { NEVER, TREE_CALLS, routeCall } from "../../../apps/desktop/src/main/ui/tree-calls";
import { FileSecretStore } from "../src/auth/secret-store";
import { Drivers } from "../src/bots/tests/fixtures";
import { FakePluginRegistry } from "../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { MemoryNetwork } from "../src/links/memory-wire";

setDefaultTimeout(120_000);

const running: RunningDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop();
});

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
type Conn = Awaited<ReturnType<typeof rpc>>;
type Engine = { daemon: RunningDaemon; app: Conn };

/** The page's plugin: a third party, approved by the person's OK card and on, holding what a devices page asks for. */
const PAGE = "acme-page";
const GRANTED = ["devices.read", "devices.manage", "approvals"];

async function engine(root: string, name: string, net: MemoryNetwork): Promise<Engine> {
  const home = join(root, name);
  // The page's plugin on A's home: a folder the engine finds, whose OK card the person presses below.
  if (name === "Studio") {
    const folder = join(home, "plugins", PAGE);
    mkdirSync(join(folder, "client"), { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(folder, "client", "index.js"), "export default {};\n");
    writeFileSync(join(folder, "moss.json"), JSON.stringify({ manifest: 1, id: PAGE, name: "Page", version: "1.0.0", engines: { moss: `^${PLUGIN_API_VERSION}` }, client: { entry: "client/index.js" }, capabilities: GRANTED }));
  }
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
  expect((await app.request("events.subscribe", { areas: ["devices", "approvals"] }))["error"]).toBeUndefined();
  const e = { daemon, app };
  if (name === "Studio") {
    const stateOf = async () => ((await app.request("plugin.get", { id: PAGE }))["result"] as { plugin: { state: string } } | undefined)?.plugin.state;
    await until("the page's plugin found", async () => (await stateOf()) !== undefined);
    const switched = await ok<{ applied: boolean; card: string }>(app, "plugin.setEnabled", { id: PAGE, enabled: true });
    await press(e, switched.card);
    await until("the page's plugin running", async () => (await stateOf()) === "running");
  }
  return e;
}

const ok = async <T>(c: Conn, method: string, params?: unknown): Promise<T> => {
  const r = await c.request(method, params);
  if (r["error"] !== undefined) throw new Error(`${method}: ${JSON.stringify(r["error"])}`);
  return r["result"] as T;
};
const until = async (what: string, f: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 400; i++) { if (await f()) return; await Bun.sleep(15); }
  throw new Error(`timed out: ${what}`);
};
/** The person's press on a card in its sealed frame (the one thing that adds or removes a device). */
const press = async (e: Engine, card: string, optionId = "approve"): Promise<void> => {
  const broker = e.daemon.mossParts.broker()!;
  await until("the card", () => broker.cards().some((c) => c.id === card));
  const c = broker.cards().find((x) => x.id === card)!;
  expect(await broker.answer(c.id, { optionId, hash: c.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(c.id)!, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
};
type Devices = { devices: { id: string; name: string; isThis: boolean }[] };
const addCards = (e: Engine) => e.daemon.mossParts.broker()!.cards().filter((c) => c.change === "device-add");

const events = (c: Conn) => c.heard.map((m) => (m["params"] ?? m) as Record<string, unknown>).map((p) => (p["event"] ?? p) as Record<string, unknown>);

test("a page calling everything it can reach, with a key press on every call, adds no device: only the person's press on the sealed card does", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-pd-page-")));
  const net = new MemoryNetwork();
  const a = await engine(root, "Studio", net);
  const b = await engine(root, "Laptop", net);

  // The user's terminal on A: the one place the words are told (never to the page), here so the test knows them.
  const terminal = await rpc(a.daemon.socketPath);
  expect((await terminal.request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "cli", token: a.daemon.tokens.harness, clientName: "test-terminal", features: [] }))["error"]).toBeUndefined();
  expect((await terminal.request("events.subscribe", { areas: ["devices"] }))["error"]).toBeUndefined();

  // The page's two doors: A's app connection (main's, for what the table names) and a layer connection of the page's own plugin.
  const { token } = await ok<{ token: string }>(a.app, "layer.token", { pluginId: PAGE });
  const layer = await rpc(a.daemon.socketPath);
  expect((await layer.request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "layer", token, pluginId: PAGE, clientName: "page", features: [] }))["error"]).toBeUndefined();
  // The page's layer is a plugin with every grant: it hears the devices and the cards' areas.
  expect((await layer.request("events.subscribe", { areas: ["devices", "approvals"] }))["error"]).toBeUndefined();
  // ... and its grants are real: what it may read, it reads (so a refusal below is the boundary's, not a missing grant).
  expect((await layer.request("device.list", {}))["error"]).toBeUndefined();
  // Main's door is given the worst page: every capability the catalog names, whatever the plugin was granted.
  const capabilities = new Set(CAPABILITIES.map((c) => c.name));
  const seen: string[] = [];
  const logs: string[] = [];
  /** One request on a door, answered or not within 400 ms (a card nobody presses waits for ever): what comes back is kept. */
  const ask = async (c: Conn, method: string, params: unknown): Promise<unknown> => {
    const r = (await Promise.race([c.request(method, params), Bun.sleep(400).then(() => ({ error: "no answer in 400 ms" }))])) as Record<string, unknown>;
    seen.push(JSON.stringify(r));
    if (r["error"] !== undefined) throw new Error(JSON.stringify(r["error"]));
    return r["result"];
  };
  const page = (method: string, params: unknown, held: ReadonlySet<string> = capabilities): Promise<unknown> => routeCall({
    caller: { windowId: 1, pluginId: PAGE, capabilities: held },
    method, params,
    takeGesture: () => true,
    request: (m, p) => ask(a.app, m, p),
    layer: () => ask(layer, method, params),
    log: (l) => void logs.push(l),
    refuse: (why) => new Error(why),
  });

  // The relay is its own capability: a page that may pair and remove devices, and holds the rest, can neither read nor choose it, and the
  // engine's relay stays n0's (a relay of someone's choosing learns which devices are online and can drop their traffic).
  const noRelay = new Set([...capabilities].filter((c) => c !== "devices.relay"));
  for (const [m, p] of [["device.relay.set", { mode: "off" }], ["device.relay.set", { mode: "custom", url: "https://relay.example.test" }], ["device.relay.get", {}]] as const) {
    await expect(page(m, p, noRelay)).rejects.toThrow("devices.relay");
  }
  expect(await ok(a.app, "device.relay.get", {})).toEqual({ mode: "n0" });

  // The page begins a pairing (its own press, in its own frame): the code is its to show. B's person joins it from B's app.
  const begun = (await page("device.pair.begin", {})) as { pairingId: string; qr: string };
  expect(typeof begun.qr).toBe("string");
  const joined = await ok<{ pairingId: string; words?: string[] }>(b.app, "device.pair.join", { code: begun.qr });
  expect(joined.words).toBeUndefined();
  await until("A's terminal hearing the words", () => events(terminal).some((e) => e["type"] === "pairing_changed" && e["step"] === "words"));
  const words = events(terminal).find((e) => e["type"] === "pairing_changed" && e["step"] === "words")!["words"] as string[];
  expect(words).toHaveLength(4);
  const phrase = words.join(" ");
  // The engine drew its card on each side by itself; nothing is paired.
  await until("a card on each side", () => addCards(a).length === 1 && addCards(b).length === 1);
  const card = addCards(a)[0]!;
  expect(JSON.stringify(card)).toContain(phrase);
  const listA = await ok<Devices>(a.app, "device.list", {});
  const listB = await ok<Devices>(b.app, "device.list", {});
  expect([listA.devices.length, listB.devices.length]).toEqual([1, 1]);

  // Every method the page can reach: the table's, the layer door's whole list, and the ones it must never have. With the real
  // pairing id, the real four words and forged ones, the other device's id, a made-up answer to the real card, and the empty call.
  const forged = { id: card.id, hash: card.hash, option: "approve", proof: { via: "sealed-frame", frame: "chan_forged", input: "click", at: Date.now() } };
  const variants: unknown[] = [
    {},
    { code: begun.qr },
    { pairingId: begun.pairingId, words },
    { pairingId: begun.pairingId, words: ["one", "two", "three", "four"] },
    { id: begun.pairingId },
    { id: card.id, hash: card.hash, option: "approve" },
    forged,
    { mode: "off" },
    { text: "Add the device?" },
  ];
  const methods = new Set<string>([...Object.keys(TREE_CALLS), ...allowedMethods("layer"), ...NEVER, "device.pair.confirm", "card.answer", "card.confirm"]);
  // Cancelling the pairing is the page's own press too, so it goes last: the rest are called against a live pairing.
  const order = [...methods].sort().filter((m) => m !== "device.pair.cancel").concat("device.pair.cancel");
  for (const m of order) {
    for (const v of variants) await page(m, v).catch(() => undefined);
  }
  // Calls by the other door, straight on the layer connection: whatever the table doesn't hold, a layer may still ask for.
  for (const m of [...allowedMethods("layer")].sort()) for (const v of variants) await Promise.race([layer.request(m, v), Bun.sleep(300)]);

  // No device on either side: the page's calls were refused, or only asked for a card.
  expect((await ok<Devices>(a.app, "device.list", {})).devices).toHaveLength(1);
  expect((await ok<Devices>(b.app, "device.list", {})).devices).toHaveLength(1);
  // Nothing the page was handed, and nothing any app connection or the page's layer heard, holds the four words.
  const forbidden = (text: string): string[] => [phrase, ...words.map((w) => `"${w}"`)].filter((w) => text.includes(w));
  expect(forbidden(seen.join("\n"))).toEqual([]);
  expect(forbidden(logs.join("\n"))).toEqual([]);
  // The page's layer did hear the pairing (the step and the name), so the check that it heard no words has something to fail on.
  const heardByLayer = events(layer).filter((e) => e["type"] === "pairing_changed");
  expect(heardByLayer.some((e) => e["step"] === "words" && e["peerName"] === "Laptop")).toBe(true);
  // The page's layer hears nothing of them. The app's own connection is main's: it is told the card (`card_requested`, fields and
  // all), which main keeps in its sealed store and draws in the sealed frame; a part gets only the frame's single-use url, never a
  // field (apps/desktop/src/main/sealed.ts header; `sealedFrameOf` in ui/runtime.ts: "sees nothing of them"). Every other event the
  // app's connection hears (the pairing's step) has no words.
  expect(forbidden(JSON.stringify(layer.heard))).toEqual([]);
  for (const c of [a.app, b.app]) expect(forbidden(JSON.stringify(events(c).filter((e) => e["type"] !== "card_requested")))).toEqual([]);
  // The terminal did hear them (so the check above could have failed).
  expect(forbidden(JSON.stringify(terminal.heard)).length).toBeGreaterThan(0);

  // The positive control: a fresh pairing begun by the page pairs through the person's press on each card, and on nothing else.
  const second = (await page("device.pair.begin", {})) as { pairingId: string; qr: string };
  await ok(b.app, "device.pair.join", { code: second.qr });
  await until("the new cards", () => addCards(a).length === 2 && addCards(b).length === 2);
  const secondCardA = addCards(a).find((c) => c.id !== card.id)!;
  const secondCardB = addCards(b).find((c) => c.id !== addCards(b)[0]!.id) ?? addCards(b)[1]!;
  await press(a, secondCardA.id);
  await Bun.sleep(100);
  expect((await ok<Devices>(a.app, "device.list", {})).devices).toHaveLength(1);
  await press(b, secondCardB.id);
  await until("both lists holding both computers", async () => (await ok<Devices>(a.app, "device.list", {})).devices.length === 2 && (await ok<Devices>(b.app, "device.list", {})).devices.length === 2);

  // Remove: the page asks, the engine raises its own card, the device stays until the person presses it, and it goes after.
  const other = (await ok<Devices>(a.app, "device.list", {})).devices.find((d) => !d.isThis)!;
  const removal = (await page("device.revoke", { id: other.id })) as { applied: boolean; card?: string };
  expect(removal.applied).toBe(false);
  expect((await ok<Devices>(a.app, "device.list", {})).devices).toHaveLength(2);
  await press(a, removal.card!);
  await until("the laptop gone from A", async () => (await ok<Devices>(a.app, "device.list", {})).devices.length === 1);
  terminal.close();
  layer.close();
});
