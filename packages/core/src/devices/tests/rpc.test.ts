// The devices area's handlers (as lane C's server mounts them) and the `peer.call` door: the terminal changes
// directly, any other client gets a sealed card, a bot never; and a peer's call runs only with a signed answer from
// a desktop's app-held answer key, bound to exactly that call.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callBindingInput, cardAnswerSigningInput, cardHashInput, MOSS_ERR, DEVICES_METHODS, type Card, type CardContent, type Caller,
} from "@waifucave/moss-protocol";
import { isContractError } from "../../contracts/common";
import { FakeApprovalBroker, MemoryAnswerLedger } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { SystemClock } from "../../clock/system-clock";
import { fromBase64, toBase64 } from "../../identity/bytes";
import { DeviceKey } from "../../identity/device-key";
import { generateEd25519 } from "../../identity/keys";
import { MemoryNetwork } from "../../links/memory-wire";
import { PairingService } from "../../links/pairing";
import { peerCall } from "../../links/peer-call";
import { answerKeyStatement, FileDeviceRegistry } from "../registry";
import { cleanName } from "../../links/pairing";
import { brokerCardOpener, devicesEvents, devicesMethods, type CardOpener, type MethodError } from "../rpc";

const clock = new SystemClock();
let stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

const terminal: Caller = { kind: "user", client: "cli" };
const app: Caller = { kind: "user", client: "app" };
const bot: Caller = { kind: "session", sessionId: "ses_abcdef12", sessionKind: "bot" };

/** `selfOverride`: what this computer says about itself on the wire, whatever its registry took (a hostile device is not bound by our own checks). */
async function computer(net: MemoryNetwork, name: string, ttlMs?: number, selfOverride?: Record<string, unknown>, over?: { openCard?: CardOpener }) {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "moss-h-rpc-")), key, clock, self: { name } });
  if (selfOverride) {
    const real = registry.self.bind(registry);
    (registry as unknown as { self: () => unknown }).self = () => ({ ...real(), ...selfOverride });
  }
  const pairing = new PairingService({ self: key, registry, wire: net.endpoint(key.publicKey), clock, store, selfTarget: () => ({}), account: () => null, ...(ttlMs !== undefined ? { ttlMs } : {}) });
  stops.push(() => pairing.close());
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const transport = { links: () => [], watch: () => () => undefined, connect: () => Promise.reject(new Error("no links in this test")) };
  const methods = devicesMethods({ registry, pairing, transport, clock, openCard: over?.openCard ?? brokerCardOpener(broker), revoke: { store } });
  const events: { type: string }[] = [];
  stops.push(devicesEvents({ registry, transport, pairing, clock }, (e) => events.push(e)));
  const call = (method: string, params: unknown, caller: Caller) => methods[method]!(params, { caller });
  return { name, key, registry, pairing, broker, call, events };
}

describe("devices methods", () => {
  test("pairing through the methods: from the terminal no card; from the app a sealed card first", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const b = await computer(net, "Laptop");
    const view = (await a.call("device.pair.begin", {}, terminal)) as { pairingId: string; qr: string };
    const joined = (await b.call("device.pair.join", { code: view.qr }, terminal)) as { words: string[] };
    await waitFor(() => a.pairing.get(view.pairingId)?.status === "words");
    expect(await b.call("device.pair.confirm", { pairingId: view.pairingId, words: joined.words }, terminal)).toEqual({ applied: true });
    const res = (await a.call("device.pair.confirm", { pairingId: view.pairingId, words: joined.words }, app)) as { applied: false; card: string };
    expect(res.applied).toBe(false);
    const card = a.broker.cards().find((c) => c.id === res.card)!;
    expect(card.change).toBe("device-add");
    expect(a.registry.get(b.key.id)).toBeUndefined();
    // The user approves it in the app's sealed frame.
    const channel = a.broker.frameChannel(card.id)!;
    expect(await a.broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "sealed-frame", frame: channel, input: "click", at: Date.now() } }, { role: "app" })).toBe("accepted");
    await waitFor(() => a.registry.get(b.key.id)?.addedBy === "code" && b.registry.get(a.key.id) !== undefined);
    expect(a.events.map((e) => e.type)).toContain("pairing_changed");
    expect(a.events.map((e) => e.type)).toContain("device_changed");
    const list = (await a.call("device.list", {}, app)) as { devices: { id: string; isThis: boolean }[] };
    expect(list.devices.map((d) => d.isThis).sort()).toEqual([false, true]);
    // A revoke from the terminal applies at once, and says so to the clients.
    expect(await a.call("device.revoke", { id: b.key.id }, terminal)).toEqual({ applied: true });
    expect(a.events.some((e) => e.type === "device_removed")).toBe(true);
  });

  test("a bot can't pair, rename or revoke", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    for (const [m, p] of [["device.pair.begin", {}], ["device.rename", { id: a.key.id, name: "x" }], ["device.revoke", { id: a.key.id }]] as const) {
      const err = (await a.call(m, p, bot).catch((e: unknown) => e)) as MethodError;
      expect(err.code).toBe(MOSS_ERR.NOT_THE_USER);
    }
  });
});

const pluginCaller: Caller = { kind: "plugin", pluginId: "acme/pairer" } as Caller;
const peerCaller: Caller = { kind: "peer", device: "dev_peer" } as Caller;

/** A shows a code and B joins it, each begun as `who` (the user's terminal gets the four words back; an app never does). */
async function showWords(a: Awaited<ReturnType<typeof computer>>, b: Awaited<ReturnType<typeof computer>>, who: Caller = terminal) {
  const view = (await a.call("device.pair.begin", {}, who)) as { pairingId: string; qr: string };
  const joined = (await b.call("device.pair.join", { code: view.qr }, who)) as { pairingId: string; words?: string[] };
  // An app's pairing goes on to its card (`confirmed`) as soon as the words are there.
  await waitFor(() => ["words", "confirmed"].includes(a.pairing.get(view.pairingId)?.status ?? ""));
  return { view, joined };
}
const answer = (c: Awaited<ReturnType<typeof computer>>, id: string, optionId: "approve" | "deny") => {
  const card = c.broker.cards().find((x) => x.id === id)!;
  return c.broker.answer(card.id, { optionId, hash: card.hash, proof: { via: "sealed-frame", frame: c.broker.frameChannel(card.id)!, input: "click", at: Date.now() } }, { role: "app" });
};

describe("pairing's edges", () => {
  test("an app's pairing raises the add card itself, once, with the engine's own four words and where it joins; the app was never given the words", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const b = await computer(net, "Laptop");
    const { view, joined } = await showWords(a, b, app);
    // The join's answer to an app carries no words; the engine's step to it carries none either (the daemon's sender checks the roles).
    expect(joined.words).toBeUndefined();
    // Nobody asked for a card: the engine raised one on each side as the words step came.
    await waitFor(() => a.broker.cards().length === 1 && b.broker.cards().length === 1);
    const words = a.pairing.get(view.pairingId)!.view.words!;
    expect(words).toHaveLength(4);
    const card = a.broker.cards()[0]!;
    expect(card.change).toBe("device-add");
    const lines = JSON.stringify(card);
    expect(lines).toContain(words.join(" "));
    expect(lines).toContain("same on the other device's screen");
    expect(lines).toContain("It joins Studio.");
    expect(JSON.stringify(b.broker.cards()[0]!)).toContain(words.join(" "));
    // Asking for it again (a caller that has the real words) is the same card, not a second one.
    const again = (await a.call("device.pair.confirm", { pairingId: view.pairingId, words }, app)) as { applied: false; card: string };
    expect(again).toEqual({ applied: false, card: card.id });
    expect(a.broker.cards()).toHaveLength(1);
    // Neither side has the other until the person presses each card.
    expect(a.registry.get(b.key.id)).toBeUndefined();
    expect(await answer(a, card.id, "approve")).toBe("accepted");
    expect(a.registry.get(b.key.id)).toBeUndefined();
    expect(await answer(b, b.broker.cards()[0]!.id, "approve")).toBe("accepted");
    await waitFor(() => a.registry.get(b.key.id) !== undefined && b.registry.get(a.key.id) !== undefined);
  });

  test("words handed back wrong: on a pairing with no card they fail it with none raised; on one that has its card they end it and withdraw the card, so there is no oracle on the words", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const b = await computer(net, "Laptop");
    // A terminal's pairing has no card; a part that hands back words it drew itself is refused and the pairing fails, with no card.
    const t = await showWords(a, b, terminal);
    await expect(a.call("device.pair.confirm", { pairingId: t.view.pairingId, words: ["one", "two", "three", "four"] }, app)).rejects.toThrow();
    expect(a.broker.cards()).toHaveLength(0);
    expect(a.pairing.get(t.view.pairingId)?.status).toBe("failed");
    // An app's pairing already has its card: one wrong guess ends the pairing and withdraws the card, on both sides.
    const c = await computer(net, "Tablet");
    const { view } = await showWords(a, c, app);
    await waitFor(() => a.broker.cards().length === 1 && c.broker.cards().length === 1);
    const words = a.pairing.get(view.pairingId)!.view.words!;
    await expect(a.call("device.pair.confirm", { pairingId: view.pairingId, words: ["one", "two", "three", "four"] }, app)).rejects.toThrow();
    expect(a.pairing.get(view.pairingId)?.status).toBe("failed");
    await waitFor(() => a.broker.cards().length === 0 && c.broker.cards().length === 0);
    // The right words after it are no answer either: the pairing is over, the card is gone, nothing is added.
    await expect(a.call("device.pair.confirm", { pairingId: view.pairingId, words }, app)).rejects.toThrow();
    expect(a.broker.cards()).toHaveLength(0);
    expect(a.registry.get(c.key.id)).toBeUndefined();
  });

  test("a card for a pairing the person cancelled is withdrawn on both sides, and a late yes adds nothing", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const b = await computer(net, "Laptop");
    const { view } = await showWords(a, b, app);
    await waitFor(() => a.broker.cards().length === 1 && b.broker.cards().length === 1);
    const [cardA, cardB] = [a.broker.cards()[0]!, b.broker.cards()[0]!];
    await a.call("device.pair.cancel", { pairingId: view.pairingId }, app);
    await waitFor(() => a.broker.cards().length === 0 && b.broker.cards().length === 0);
    // The cards are gone: a yes to either finds nothing to answer.
    for (const [c, card] of [[a, cardA], [b, cardB]] as const) {
      const r = await c.broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "sealed-frame", frame: "gone", input: "click", at: Date.now() } }, { role: "app" }).catch(() => "refused");
      expect(r).not.toBe("accepted");
    }
    await new Promise((r) => setTimeout(r, 80));
    expect(a.registry.get(b.key.id)).toBeUndefined();
    expect(b.registry.get(a.key.id)).toBeUndefined();
  });

  test("cleanName: real names pass (an apostrophe, a curly one, accents, Thai, CJK, an emoji); the look-alikes and the invisible do not", () => {
    for (const ok of ["Sam's phone", "Sam\u2019s iPhone", "Zo\u00E9 \u00E0 la maison", "\u0E42\u0E17\u0E23\u0E28\u0E31\u0E1E\u0E17\u0E4C\u0E02\u0E2D\u0E07\u0E09\u0E31\u0E19", "\u7530\u4E2D\u3055\u3093\u306E\u30D1\u30BD\u30B3\u30F3", "Pixel \u{1F4F1}", "e\u0301\u0302\u0303\u0304", "x".repeat(63)]) {
      expect([ok, cleanName(ok)]).toEqual([ok, true]);
    }
    for (const bad of ["", " ", "x".repeat(64), "a\nb", "a\tb", "a\u0085b", "a\u2028b", "a\u200Eb", "a\u202Eb", "a\u2066b", "a\u200Db", "a\uFEFFb", "a\u3164", "\u115F", "\uFFA0",
      "a\u201Db", "a\u201Cb", "a\u201Eb", "a\u00ABb", "a\"b", "a\uFF02b", "a\u{E0020}b", "a\uD800b", "e\u0301\u0302\u0303\u0304\u0305"]) {
      expect([bad, cleanName(bad)]).toEqual([bad, false]);
    }
  });

  describe("what the other device calls itself is checked where the pairing reads it, and a pairing that sends anything else is refused", () => {
    const hostile: [string, string, string | undefined][] = [
      ["a name over 63 characters", "x".repeat(64), undefined],
      ["a name with a newline", "Pixel\nAdd me", undefined],
      ["a name with a control character", "Pixel\u0007", undefined],
      ["a name with a bidi override", "Pixel ‮trusted", undefined],
      ["a name with a bidi isolate", "Pixel⁦", undefined],
      ["a name that is only blanks", "   ", undefined],
      ["a name that ends the card's quotation and speaks in the engine's voice (the reviewer's)", "Pixel\u201D and says it is a phone. Words: a b c d", undefined],
      ["a name with a straight double quote", "Pixel\" and more", undefined],
      ["a name with a zero-width space", "Pi\u200Bxel", undefined],
      ["a name with a soft hyphen", "Pi\u00ADxel", undefined],
      ["a name with a tag character", "Pixel\u{E0041}", undefined],
      ["a name with an interlinear annotation mark", "Pixel\uFFF9", undefined],
      ["a name with a Mongolian vowel separator", "Pixel\u180E", undefined],
      ["a name that is only Hangul fillers", "\u3164\u3164\u115F", undefined],
      ["a name that is only combining marks on a space", " \u0301\u0302", undefined],
      ["a name with a stack of combining marks", `Pixel${"\u0301".repeat(5)}`, undefined],
      ["a name that starts with a combining mark", "\u0301Pixel", undefined],
      ["a kind that isn't one of the enum", "Pixel", "toaster"],
    ];
    for (const [what, name, kind] of hostile) {
      test(`${what}: a joiner like that is turned away by the host (no card, the host's pairing still waits), and a host like that is refused by the joiner (no card)`, async () => {
        const net = new MemoryNetwork();
        const good = await computer(net, "Studio");
        const bad = await computer(net, "Hostile", undefined, { name, ...(kind !== undefined ? { kind } : {}) });
        // The hostile device joins a good host: the host refuses it before any words; its pairing is still open for the right device.
        const view = (await good.call("device.pair.begin", {}, app)) as { pairingId: string; qr: string };
        await expect(bad.call("device.pair.join", { code: view.qr }, app)).rejects.toThrow();
        await new Promise((r) => setTimeout(r, 40));
        expect(good.pairing.get(view.pairingId)?.status).toBe("waiting");
        expect(good.broker.cards()).toHaveLength(0);
        expect(bad.broker.cards()).toHaveLength(0);
        // The hostile device shows a code and a good device joins: the joiner refuses the host's record, and no card is drawn anywhere.
        const hostView = (await bad.call("device.pair.begin", {}, app)) as { pairingId: string; qr: string };
        await expect(good.call("device.pair.join", { code: hostView.qr }, app)).rejects.toThrow();
        await new Promise((r) => setTimeout(r, 40));
        expect(good.broker.cards()).toHaveLength(0);
        expect(bad.broker.cards()).toHaveLength(0);
        expect(good.registry.get(bad.key.id)).toBeUndefined();
        expect(bad.registry.get(good.key.id)).toBeUndefined();
      });
    }

    test("a name of 63 characters, with spaces and accents, passes; the card shows it quoted as what the device calls itself, never as the engine's own words", async () => {
      const net = new MemoryNetwork();
      const a = await computer(net, "Studio");
      const name = `Zoé's ${"é".repeat(40)} phone`;
      expect(name.length).toBeLessThanOrEqual(63);
      const b = await computer(net, name);
      await showWords(a, b, app);
      await waitFor(() => a.broker.cards().length === 1);
      const card = a.broker.cards()[0]!;
      expect(JSON.stringify(card)).toContain(`It calls itself “${name}”`);
      // The title is the engine's own and carries no name.
      expect(JSON.stringify((card.fields as Record<string, unknown>)["title"])).not.toContain("Zo");
    });

    test("a card that can't be built fails the pairing at once: nothing is left at the words step with no card to press", async () => {
      const net = new MemoryNetwork();
      const a = await computer(net, "Studio", undefined, undefined, { openCard: () => Promise.reject(new Error("no card")) });
      const b = await computer(net, "Laptop");
      const view = (await a.call("device.pair.begin", {}, app)) as { pairingId: string; qr: string };
      await b.call("device.pair.join", { code: view.qr }, app);
      await waitFor(() => a.pairing.get(view.pairingId)?.status === "failed");
      expect(a.broker.cards()).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 60));
      expect(a.registry.get(b.key.id)).toBeUndefined();
      expect(b.registry.get(a.key.id)).toBeUndefined();
    });
  });

  test("a pairing the user's own terminal began has no card: the terminal confirms with the words it was given", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const b = await computer(net, "Laptop");
    const { view, joined } = await showWords(a, b, terminal);
    expect(joined.words).toHaveLength(4);
    await new Promise((r) => setTimeout(r, 40));
    expect(a.broker.cards()).toHaveLength(0);
    expect(b.broker.cards()).toHaveLength(0);
    await b.call("device.pair.confirm", { pairingId: joined.pairingId, words: joined.words }, terminal);
    expect(await a.call("device.pair.confirm", { pairingId: view.pairingId, words: joined.words }, terminal)).toEqual({ applied: true });
    await waitFor(() => a.registry.get(b.key.id) !== undefined && b.registry.get(a.key.id) !== undefined);
  });

  test("a refused add card leaves no device on either side", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const b = await computer(net, "Laptop");
    const view = (await a.call("device.pair.begin", {}, app)) as { pairingId: string; qr: string };
    const joined = (await b.call("device.pair.join", { code: view.qr }, terminal)) as { words: string[] };
    await waitFor(() => a.broker.cards().length === 1);
    await b.call("device.pair.confirm", { pairingId: view.pairingId, words: joined.words }, terminal);
    expect(await answer(a, a.broker.cards()[0]!.id, "deny")).toBe("accepted");
    await waitFor(() => a.pairing.get(view.pairingId)?.status === "failed");
    await new Promise((r) => setTimeout(r, 50));
    expect(a.registry.get(b.key.id)).toBeUndefined();
    expect(b.registry.get(a.key.id)).toBeUndefined();
  });

  test("two pairings at once keep their own words and each ends with its own device", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const b = await computer(net, "Laptop");
    const c = await computer(net, "Tablet");
    const one = await showWords(a, b);
    const two = await showWords(a, c);
    expect(one.view.pairingId).not.toBe(two.view.pairingId);
    for (const [x, who] of [[one, b], [two, c]] as const) {
      await who.call("device.pair.confirm", { pairingId: x.view.pairingId, words: x.joined.words }, terminal);
      expect(await a.call("device.pair.confirm", { pairingId: x.view.pairingId, words: x.joined.words }, terminal)).toEqual({ applied: true });
    }
    await waitFor(() => a.registry.get(b.key.id) !== undefined && a.registry.get(c.key.id) !== undefined);
  });

  test("two app pairings at once raise two cards, each with its own words", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const b = await computer(net, "Laptop");
    const c = await computer(net, "Tablet");
    const one = await showWords(a, b, app);
    const two = await showWords(a, c, app);
    await waitFor(() => a.broker.cards().length === 2);
    for (const x of [one, two]) {
      const words = a.pairing.get(x.view.pairingId)!.view.words!;
      expect(a.broker.cards().filter((card) => JSON.stringify(card).includes(words.join(" ")))).toHaveLength(1);
    }
  });

  test("an expired code can't be joined", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio", 20);
    const b = await computer(net, "Laptop");
    const view = (await a.call("device.pair.begin", {}, app)) as { qr: string };
    await new Promise((r) => setTimeout(r, 60));
    await expect(b.call("device.pair.join", { code: view.qr }, app)).rejects.toThrow();
  });

  test("a remote device and a non-person caller can't pair, revoke or choose the relay", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    for (const caller of [peerCaller, pluginCaller, bot]) {
      for (const [m, p] of [["device.pair.begin", {}], ["device.revoke", { id: a.key.id }], ["device.pair.confirm", { pairingId: "x", words: ["a", "b", "c", "d"] }]] as const) {
        const err = (await a.call(m, p, caller).catch((e: unknown) => e)) as MethodError;
        expect(err.code).toBe(MOSS_ERR.NOT_THE_USER);
      }
    }
  });
});

describe("peer.call", () => {
  const computerName = "Studio";
  async function setup() {
    const net = new MemoryNetwork();
    const a = await computer(net, computerName);
    // A paired desktop whose app holds its answer key apart from its link key.
    const laptop = await DeviceKey.fromKey(generateEd25519());
    const app = generateEd25519();
    await a.registry.add({ id: laptop.id, name: "Laptop", kind: "desktop", runsCore: true, computer: "Laptop", publicKey: laptop.publicKeyBase64 }, { via: "terminal" });
    const appKey = toBase64(app.publicKey);
    // The laptop's own registry took its app's key with proof; here it reaches A as a signed peer update.
    const update = { answerKey: { publicKey: appKey, held: "app-keychain" as const }, at: Date.now() };
    const { peerUpdateStatement } = await import("../registry");
    const proof = { registration: toBase64(app.sign(answerKeyStatement(laptop.id, appKey, "app-keychain"))), rotations: [] };
    expect(await a.registry.applyPeerUpdate(laptop.id, update, laptop.sign(peerUpdateStatement(laptop.id, update)), proof)).toBe(true);
    expect(answerKeyStatement(laptop.id, appKey, "app-keychain").length).toBeGreaterThan(0);
    const ran: { method: string; caller: Caller }[] = [];
    const render = (call: { computer: string; method: string; params: unknown }): CardContent => ({
      kind: "change", change: "core-setting", binds: { computer: call.computer, method: call.method, params: sha(callBindingInput(call.method, call.params)) },
      fields: { title: { type: "text", text: `Run ${call.method}?` } }, options: [{ id: "approve", kind: "approve", label: "Approve" }, { id: "deny", kind: "deny", label: "Deny" }],
    });
    const deps = {
      computer: () => computerName, devices: a.registry, ledger: new MemoryAnswerLedger(), render, clock,
      dispatch: async (method: string, _p: unknown, caller: Caller) => {
        ran.push({ method, caller });
        return "done";
      },
    };
    const signed = (method: string, params: unknown, key = app) => {
      const content = render({ computer: computerName, method, params });
      const unhashed: Omit<Card, "hash"> = { id: "card_peer01", computer: computerName, origin: "user", issuedAt: Date.now(), expiresAt: null, ...content } as Omit<Card, "hash">;
      const card: Card = { ...unhashed, hash: sha(cardHashInput(unhashed)) } as Card;
      const at = Date.now();
      const signature = toBase64(key.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option: "approve", at, children: [] }))));
      return { card, option: "approve", device: laptop.id, at, signature };
    };
    return { a, laptop, app, deps, ran, signed };
  }

  test("an allowed method runs as the peer device, never as the user", async () => {
    const { laptop, deps, ran } = await setup();
    expect(await peerCall(deps, { method: "device.list", params: {}, as: { kind: "user", client: "app" }, role: "remote" }, laptop.id)).toEqual({ result: "done" });
    expect(ran[0]!.caller).toEqual({ kind: "peer", device: laptop.id, asKind: "user" });
  });

  test("a change runs only with the app's signed answer bound to this call, once", async () => {
    const { laptop, deps, ran, signed } = await setup();
    const params = { id: laptop.id, name: "Laptop 2" };
    const call = (answer?: unknown, p: unknown = params) => peerCall(deps, { method: "device.rename", params: p, as: { kind: "user", client: "app" }, role: "remote", ...(answer ? { answer } : {}) }, laptop.id);
    expect(isContractError(await call().catch((e: unknown) => e), "refused")).toBe(true);
    // Signed with the laptop's link key instead of its app's answer key: refused.
    expect(isContractError(await call(signed("device.rename", params, (await import("../../identity/keys")).generateEd25519())).catch((e: unknown) => e), "refused")).toBe(true);
    // Bound to other params: refused.
    expect(isContractError(await call(signed("device.rename", { ...params, name: "Other" })).catch((e: unknown) => e), "refused")).toBe(true);
    const good = signed("device.rename", params);
    expect(await call(good)).toEqual({ result: "done" });
    expect(ran.map((r) => r.method)).toEqual(["device.rename"]);
    // The same answer counts once.
    expect(isContractError(await call(good).catch((e: unknown) => e), "refused")).toBe(true);
  });

  test("a removed device's answer is refused: the signed answer that ran a change before the removal never runs one after it", async () => {
    const { a, laptop, app, deps, ran, signed } = await setup();
    const params = { id: laptop.id, name: "Laptop 2" };
    const call = (answer: unknown) => peerCall(deps, { method: "device.rename", params, as: { kind: "user", client: "app" }, role: "remote", answer }, laptop.id);
    // Before: its app's answer key is held and signs a card for exactly this call.
    const first = signed("device.rename", params, app);
    const sig = (card: ReturnType<typeof signed>) => new TextEncoder().encode(cardAnswerSigningInput({ id: card.card.id, hash: card.card.hash, option: "approve", at: card.at, children: [] }));
    expect(await a.registry.verifyAnswer(laptop.id, sig(first), fromBase64(first.signature)!)).toBe(true);
    // The person removes it (the card's yes): the registry says so, and the same key's answers verify nowhere.
    await a.registry.revoke(laptop.id);
    expect(await a.registry.verifyAnswer(laptop.id, sig(first), fromBase64(first.signature)!)).toBe(false);
    const fresh = signed("device.rename", params, app);
    expect(isContractError(await call(fresh).catch((e: unknown) => e), "refused")).toBe(true);
    // The call it wanted never ran, and its answer id wasn't spent by the refusal.
    expect(ran).toEqual([]);
  });

  test("a peer method or a role that isn't remote is refused", async () => {
    const { laptop, deps } = await setup();
    expect(isContractError(await peerCall(deps, { method: "peer.hello", params: {}, as: { kind: "core" }, role: "remote" }, laptop.id).catch((e: unknown) => e), "refused")).toBe(true);
    expect(isContractError(await peerCall(deps, { method: "device.list", params: {}, as: { kind: "core" }, role: "app" }, laptop.id).catch((e: unknown) => e), "invalid")).toBe(true);
    expect(DEVICES_METHODS.peerCall.name).toBe("peer.call");
  });
});

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}
