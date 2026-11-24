// The devices area's handlers (as lane C's server mounts them) and the `peer.call` door: the terminal changes
// directly, any other client gets a sealed card, a bot never; and a peer's call runs only with a signed answer from
// a desktop's app-held answer key, bound to exactly that call.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callBindingInput, cardAnswerSigningInput, cardHashInput, ERR, MOSS_ERR, DEVICES_METHODS, type Card, type CardContent, type Caller,
} from "@waifucave/moss-protocol";
import type { Clock } from "../../contracts/clock";
import { isContractError } from "../../contracts/common";
import { FakeApprovalBroker, MemoryAnswerLedger } from "../../contracts/fakes/approval-broker";
import { makeFakePhone, type FakeDevice } from "../../contracts/fakes/device-registry";
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
import { deviceProofVerifier } from "../../contracts/approval-broker";
import { brokerCardOpener, devicesEvents, devicesMethods, type CardOpener, type MethodError } from "../rpc";
import { openOnBroker } from "../../ipc/device-links";

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
async function computer(net: MemoryNetwork, name: string, ttlMs?: number, selfOverride?: Record<string, unknown>, over?: { openCard?: CardOpener; clock?: Clock }) {
  const clk = over?.clock ?? clock;
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "moss-h-rpc-")), key, clock, self: { name } });
  if (selfOverride) {
    const real = registry.self.bind(registry);
    (registry as unknown as { self: () => unknown }).self = () => ({ ...real(), ...selfOverride });
  }
  const pairing = new PairingService({ self: key, registry, wire: net.endpoint(key.publicKey), clock: clk, store, selfTarget: () => ({}), account: () => null, ...(ttlMs !== undefined ? { ttlMs } : {}) });
  stops.push(() => pairing.close());
  // Who is a computer comes from this registry's kind recorded at pairing, and a device's own signature from its answer key.
  const brokerClock = new FakeClock();
  const broker = new FakeApprovalBroker({ clock: brokerClock, verify: deviceProofVerifier(registry), deviceKind: (id) => registry.get(id)?.kind });
  const transport = { links: () => [], watch: () => () => undefined, connect: () => Promise.reject(new Error("no links in this test")) };
  const methods = devicesMethods({ registry, pairing, transport, clock: clk, openCard: over?.openCard ?? brokerCardOpener(broker), revoke: { store } });
  const events: { type: string; step?: string; reason?: string; peerName?: string }[] = [];
  stops.push(devicesEvents({ registry, transport, pairing, clock: clk }, (e) => events.push(e)));
  const call = (method: string, params: unknown, caller: Caller) => methods[method]!(params, { caller });
  return { name, key, registry, pairing, broker, brokerClock, call, events };
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

describe("the card that removes a device is never the removed device's", () => {
  test("a revoke from the app raises a card about that device: it can't answer it (not by its link, not relayed), another device's yes revokes at once", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const b = await computer(net, "Laptop");
    const { view, joined } = await showWords(a, b);
    await b.call("device.pair.confirm", { pairingId: view.pairingId, words: joined.words! }, terminal);
    await a.call("device.pair.confirm", { pairingId: view.pairingId, words: joined.words! }, terminal);
    await waitFor(() => a.registry.get(b.key.id) !== undefined);
    const res = (await a.call("device.revoke", { id: b.key.id }, app)) as { applied: false; card: string };
    expect(res.applied).toBe(false);
    const card = a.broker.cards().find((c) => c.id === res.card)!;
    expect(card.change).toBe("device-revoke");
    expect(a.broker.aboutDevice(card.id)).toBe(b.key.id);
    // The removed device's own answer, on its own link and as a proof another computer relays: refused, whatever it says, and the card stays.
    const proof = { via: "device" as const, device: b.key.id, at: Date.now(), signature: "AAAA" };
    expect(await a.broker.answer(card.id, { optionId: "deny", hash: card.hash, proof }, { role: "remote", device: b.key.id })).toBe("bad-origin");
    expect(await a.broker.answer(card.id, { optionId: "deny", hash: card.hash, proof }, { role: "peer", device: "dev_other" })).toBe("bad-origin");
    expect(a.broker.cards().map((c) => c.id)).toContain(card.id);
    expect(a.registry.get(b.key.id)?.revokedAt).toBeUndefined();
    // The person's own yes at the computer: revoked at once (the links' transport shuts a revoked device's link on this change, `links/tests/transport.test.ts`).
    expect(await answer(a, card.id, "approve")).toBe("accepted");
    await waitFor(() => a.registry.get(b.key.id)?.revokedAt !== undefined);
    expect(a.events.some((e) => e.type === "device_removed")).toBe(true);
  });

  /** One phone with both its apps paired is two devices of kind phone (the owner's design), A (`code`) and B (`moss`); C is another phone. */
  async function withPhones(a: Awaited<ReturnType<typeof computer>>) {
    const phones = { A: await makeFakePhone(), B: await makeFakePhone(), C: await makeFakePhone() };
    const names = { A: "Pocket (MOSS Code)", B: "Pocket (MOSS)", C: "Another phone" };
    const apps = { A: "code", B: "moss", C: "moss" } as const;
    for (const k of ["A", "B", "C"] as const) {
      await a.registry.add({ id: phones[k].id, name: names[k], kind: "phone", runsCore: false, publicKey: phones[k].publicKey, answerKey: phones[k].answerKey, app: apps[k] }, { via: "account", account: "acct_1" });
    }
    return phones;
  }
  const signedBy = async (a: { brokerClock: FakeClock }, who: FakeDevice, card: Card, option: "approve" | "deny", device = who.id) => {
    const at = a.brokerClock.now();
    return { via: "device" as const, device, at, signature: toBase64(await who.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option, at, children: [] })))) };
  };
  const phoneCaller = (device: string): Caller => ({ kind: "user", client: "ios", device }) as Caller;

  test("the person removes app A's device at the computer: neither A nor B is sent the card, both are refused whatever way they answer, the computer's yes cuts A at once", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const { A, B, C } = await withPhones(a);
    const res = (await a.call("device.revoke", { id: A.id }, app)) as { applied: false; card: string };
    const card = a.broker.cards().find((c) => c.id === res.card)!;
    // Hidden from every phone: not sent, not listed (the routing and the card methods ask this one question), refused when they answer.
    for (const who of [A, B, C]) {
      expect(a.broker.answerableBy(card.id, who.id)).toBe(false);
      expect(await a.broker.answer(card.id, { optionId: "deny", hash: card.hash, proof: await signedBy(a, who, card, "deny") }, { role: "remote", device: who.id })).toBe("bad-origin");
      // Relayed by another computer, with the phone's own good signature: the proof names the phone.
      expect(await a.broker.answer(card.id, { optionId: "deny", hash: card.hash, proof: await signedBy(a, who, card, "deny") }, { role: "peer", device: "dev_other" })).toBe("bad-origin");
    }
    expect(a.broker.cards().map((c) => c.id)).toContain(card.id);
    expect(a.registry.get(A.id)?.revokedAt).toBeUndefined();
    // The computer's own app answers: A is cut at once; B and C are untouched.
    expect(await answer(a, card.id, "approve")).toBe("accepted");
    await waitFor(() => a.registry.get(A.id)?.revokedAt !== undefined);
    expect(a.registry.get(B.id)?.revokedAt).toBeUndefined();
    expect(a.registry.get(C.id)?.revokedAt).toBeUndefined();
  });

  test("a phone's own request to remove a device: that same phone answers it; a second phone can't, nor the one it names; the computer still can", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const { A, B, C } = await withPhones(a);
    // B asks, from its own link, to remove C.
    const res = (await a.call("device.revoke", { id: C.id }, phoneCaller(B.id))) as { applied: false; card: string };
    const card = a.broker.cards().find((c) => c.id === res.card)!;
    expect(a.broker.answerableBy(card.id, A.id)).toBe(false);
    expect(a.broker.answerableBy(card.id, C.id)).toBe(false);
    expect(a.broker.answerableBy(card.id, B.id)).toBe(true);
    // A second phone (the other app of the same phone, or another phone) is refused, on its own link and as a relayed proof.
    expect(await a.broker.answer(card.id, { optionId: "deny", hash: card.hash, proof: await signedBy(a, A, card, "deny") }, { role: "remote", device: A.id })).toBe("bad-origin");
    expect(await a.broker.answer(card.id, { optionId: "deny", hash: card.hash, proof: await signedBy(a, A, card, "deny") }, { role: "peer", device: "dev_other" })).toBe("bad-origin");
    expect(a.broker.cards().map((c) => c.id)).toContain(card.id);
    // The asking phone's own answer counts, the owner's decision (a phone's own request stays its own to answer).
    expect(await a.broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: await signedBy(a, B, card, "approve") }, { role: "remote", device: B.id })).toBe("accepted");
    await waitFor(() => a.registry.get(C.id)?.revokedAt !== undefined);
    expect(a.registry.get(A.id)?.revokedAt).toBeUndefined();
    // The same request, answered at the computer instead.
    const again = (await a.call("device.revoke", { id: A.id }, phoneCaller(B.id))) as { applied: false; card: string };
    expect(await answer(a, again.card, "approve")).toBe("accepted");
    await waitFor(() => a.registry.get(A.id)?.revokedAt !== undefined);
  });

  test("a card is raised for a phone-kind caller only with that phone as its asker; a caller no link authenticated (the app) names none", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const { A, B } = await withPhones(a);
    const fromApp = (await a.call("device.revoke", { id: A.id }, app)) as { card: string };
    expect(a.broker.answerableBy(fromApp.card, B.id)).toBe(false);
    expect(a.broker.answerableBy(fromApp.card, undefined)).toBe(true);
  });

  test("a revoke from the terminal needs no card at all (the person's own act at that computer)", async () => {
    const net = new MemoryNetwork();
    const a = await computer(net, "Studio");
    const b = await computer(net, "Laptop");
    const { view, joined } = await showWords(a, b);
    await b.call("device.pair.confirm", { pairingId: view.pairingId, words: joined.words! }, terminal);
    await a.call("device.pair.confirm", { pairingId: view.pairingId, words: joined.words! }, terminal);
    await waitFor(() => a.registry.get(b.key.id) !== undefined);
    expect(await a.call("device.revoke", { id: b.key.id }, terminal)).toEqual({ applied: true });
    expect(a.broker.cards()).toEqual([]);
    expect(a.registry.get(b.key.id)?.revokedAt).toBeDefined();
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
/** The rows of a card's `detail` field. */
type Row = { label: string; value: string; name?: true };
const rawRows = (card: { fields?: unknown }): Row[] => ((card.fields as Record<string, { rows?: Row[] }>)["detail"]?.rows ?? []);
const cardRows = (card: { fields?: unknown }): { label: string; value: string }[] => rawRows(card).map((r) => ({ label: r.label, value: r.value }));
/** The labels of the rows the card's builder marked as a human name (their joiners may draw as written). */
const nameLabels = (card: { fields?: unknown }): string[] => rawRows(card).filter((r) => r.name === true).map((r) => r.label);
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
    expect(cardRows(card)).toContainEqual({ label: "It would join", value: "Studio" });
    expect(nameLabels(card)).toEqual(["The name it gives itself", "It would join"]);
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

  // The phone's way (native/phone-core/tests/engine.rs): the computer's pairing is begun by its app, the other device joins over the link with
  // no card of its own (a terminal-like joiner), confirms its side, and the computer's person then types wrong words.
  for (const joinerConfirmsFirst of [true, false]) {
    test(`a remote joiner ${joinerConfirmsFirst ? "has confirmed" : "has not yet confirmed"} when the computer's person types wrong words: the pairing fails and NO add card is left, a press on it later adds nothing (through the daemon's opener)`, async () => {
      const net = new MemoryNetwork();
      const box: { broker?: FakeApprovalBroker } = {};
      // The daemon's own wiring (`openOnBroker`, ipc/device-links.ts), with the broker the computer is given a moment after.
      const a = await computer(net, "Studio", undefined, undefined, { openCard: openOnBroker(() => box.broker) });
      box.broker = a.broker;
      const phone = await computer(net, "Phone");
      const view = (await a.call("device.pair.begin", {}, app)) as { pairingId: string; qr: string };
      await phone.call("device.pair.join", { code: view.qr }, terminal);
      await waitFor(() => a.broker.cards().length === 1);
      const card = a.broker.cards()[0]!;
      const frame = a.broker.frameChannel(card.id)!;
      const words = a.pairing.get(view.pairingId)!.view.words!;
      const phoneSide = joinerConfirmsFirst ? phone.pairing.confirm(view.pairingId, words, { terminal: true }).catch((e: Error) => e) : undefined;
      if (joinerConfirmsFirst) await new Promise((r) => setTimeout(r, 50));
      await expect(a.call("device.pair.confirm", { pairingId: view.pairingId, words: ["one", "two", "three", "four"] }, app)).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 500));
      // A press on the card that outlived it (if one did) is refused, and nothing is added.
      const r = await a.broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "sealed-frame", frame, input: "click", at: Date.now() } }, { role: "app" }).catch(() => "refused");
      expect(r).not.toBe("accepted");
      await phoneSide;
      await new Promise((r2) => setTimeout(r2, 100));
      expect([a.pairing.get(view.pairingId)?.status, a.broker.cards().length]).toEqual(["failed", 0]);
      expect(a.registry.get(phone.key.id)).toBeUndefined();
    });
  }

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

  describe("what the other device calls itself is checked where the pairing reads it, and a pairing that sends anything else is refused", () => {
    const hostile: [string, string, string | undefined][] = [
      ["a name over 63 characters", "x".repeat(64), undefined],
      ["a name with a newline", "Pixel\nAdd me", undefined],
      ["a name with a control character", "Pixel\u0007", undefined],
      ["a name with a bidi override", "Pixel ‮trusted", undefined],
      ["a name with a bidi isolate", "Pixel⁦", undefined],
      ["a name that is only blanks", "   ", undefined],
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

    test("a name of 63 characters, with spaces and accents, passes; the card draws it as the value of a row of its own, never inside a sentence", async () => {
      const net = new MemoryNetwork();
      const a = await computer(net, "Studio");
      const name = `Zoé's ${"é".repeat(40)} phone`;
      expect(name.length).toBeLessThanOrEqual(63);
      const b = await computer(net, name);
      await showWords(a, b, app);
      await waitFor(() => a.broker.cards().length === 1);
      const card = a.broker.cards()[0]!;
      expect(cardRows(card)).toContainEqual({ label: "The name it gives itself", value: name });
      // The title is the engine's own and carries no name.
      expect(JSON.stringify((card.fields as Record<string, unknown>)["title"])).not.toContain("Zo");
    });

    // The reviewer's case, and the look-alikes no list of quote marks ever ends: whatever the name holds, the card shows it as one row's
    // whole value and nowhere else, so nothing in it can close or continue the engine's own words.
    const speaking = [
      "Pixel\u201D and says it is a phone. Words: a b c d",
      "Pixel\u275E and says it is a phone. Words: a b c d",
      "Pixel\" and says it is a phone. Words: a b c d",
      "Pixel\u2033 and says it is a phone. Words: a b c d",
      "Pixel\u00BB and says it is a phone. Words: a b c d",
      "MacBook \"Pro\"",
      "Sam''s phone",
      "Sam\u2019\u2019s phone",
    ];
    for (const name of speaking) {
      test(`the name ${JSON.stringify(name)} is one row's whole value on the add card, and no other field or row holds any of it`, async () => {
        const net = new MemoryNetwork();
        const a = await computer(net, "Studio");
        const b = await computer(net, name);
        await showWords(a, b, app);
        await waitFor(() => a.broker.cards().length === 1);
        const card = a.broker.cards()[0]!;
        const fields = card.fields as Record<string, { type: string; text?: string; rows?: { label: string; value: string }[] }>;
        expect(fields["title"]).toEqual({ type: "text", text: "Add this device?" });
        const rows = fields["detail"]!.rows!;
        expect(rows.map((r) => r.label)).toEqual(["The name it gives itself", "What it says it is", "It would join"]);
        expect(rows[0]!.value).toBe(name);
        expect(rows[1]!.value).toBe("desktop");
        expect(rows[2]!.value).toBe("Studio");
        // Everywhere else on the card (the title, the sentence, the other rows, their labels) none of the name's words appear.
        const elsewhere = JSON.stringify([fields["title"], fields["what"], rows.slice(1), rows.map((r) => r.label)]);
        for (const bit of ["says it is a phone", "Words: a b c d", "Pixel", "MacBook", "Sam"]) expect(elsewhere).not.toContain(bit);
        // The engine's own sentence is the one place the words are, and they are the engine's real four.
        const words = a.pairing.list()[0]!.view.words!;
        expect(fields["what"]!.text).toBe(`Check that these four words are the same on the other device's screen: ${words.join(" ")}`);
      });
    }

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

  describe("a pairing turned away over the other device's record says so in plain words on both sides", () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["a name the rule refuses", { name: "Pixel​x" }, /name isn't one MOSS takes/],
      ["a kind that isn't one of the enum", { kind: "toaster" }, /kind of device MOSS doesn't know/],
      ["an os that isn't one of the enum", { os: "plan9" }, /system MOSS doesn't know/],
    ];
    for (const [what, over, said] of cases) {
      test(`${what}: the host's page and terminal are told a device was turned away (its pairing still waits), and the joiner is told why`, async () => {
        const net = new MemoryNetwork();
        const good = await computer(net, "Studio");
        const bad = await computer(net, "Hostile", undefined, over);
        const view = (await good.call("device.pair.begin", {}, app)) as { pairingId: string; qr: string };
        const err = (await bad.call("device.pair.join", { code: view.qr }, app).catch((e: unknown) => e)) as Error;
        expect(err.message).toMatch(/turned this one away/);
        expect(err.message).toMatch(said);
        expect(err.message).not.toContain("key");
        await waitFor(() => good.events.some((e) => e.step === "waiting" && (e.reason ?? "") !== ""));
        const note = good.events.filter((e) => e.step === "waiting" && (e.reason ?? "") !== "").at(-1)!.reason!;
        expect(note).toMatch(/A device tried to join and was turned away/);
        expect(note).toMatch(said);
        expect(note).toContain("This code still works");
        // Nothing of the other device's own text is in what the person reads.
        expect(`${err.message} ${note}`).not.toMatch(/Hostile|toaster|plan9|Pixel/);
        expect(good.pairing.get(view.pairingId)?.status).toBe("waiting");
        expect(good.pairing.get(view.pairingId)?.note).toBe(note);
        // And the right device can still pair with the same code.
        const fine = await computer(net, "Laptop");
        await fine.call("device.pair.join", { code: view.qr }, app);
        await waitFor(() => ["words", "confirmed"].includes(good.pairing.get(view.pairingId)?.status ?? ""));
        expect(good.pairing.get(view.pairingId)?.note).toBeUndefined();
      });
      test(`${what}: a host like that is turned away by the joiner, which says so (the pairing fails, no card on either side)`, async () => {
        const net = new MemoryNetwork();
        const good = await computer(net, "Studio");
        const bad = await computer(net, "Hostile", undefined, over);
        const view = (await bad.call("device.pair.begin", {}, app)) as { pairingId: string; qr: string };
        const err = (await good.call("device.pair.join", { code: view.qr }, app).catch((e: unknown) => e)) as Error;
        expect(err.message).toMatch(/this device turned the other one away/);
        expect(err.message).toMatch(said);
        expect(err.message).not.toMatch(/isn't a pairing|doesn't match its key|Hostile|toaster|plan9|Pixel/);
        await waitFor(() => good.events.some((e) => e.step === "failed" && /turned the other one away/.test(e.reason ?? "")));
        expect(good.broker.cards()).toHaveLength(0);
        expect(bad.broker.cards()).toHaveLength(0);
      });
    }
  });

  describe("a pairing expires by a timer in the engine, at the expiry its code shows", () => {
    test("a host's pairing nobody joined ends as expired at that time: the step says so, a late join is refused, and nothing was added", async () => {
      const net = new MemoryNetwork();
      const fake = new FakeClock();
      const a = await computer(net, "Studio", 60_000, undefined, { clock: fake });
      const b = await computer(net, "Laptop", undefined, undefined, { clock: fake });
      const view = (await a.call("device.pair.begin", {}, app)) as { pairingId: string; qr: string; expiresAt: number };
      expect(view.expiresAt).toBe(fake.now() + 60_000);
      fake.advance(59_999);
      expect(a.pairing.get(view.pairingId)?.status).toBe("waiting");
      fake.advance(1);
      expect(a.pairing.get(view.pairingId)).toMatchObject({ status: "failed", error: "expired" });
      expect(a.events.at(-1)).toMatchObject({ type: "pairing_changed", step: "expired" });
      await expect(b.call("device.pair.join", { code: view.qr }, app)).rejects.toThrow();
      expect(a.registry.get(b.key.id)).toBeUndefined();
      expect(b.registry.get(a.key.id)).toBeUndefined();
    });

    test("a pairing at its words step with its add card up ends at the expiry too, and the card is withdrawn: a yes on it adds nothing", async () => {
      const net = new MemoryNetwork();
      const fake = new FakeClock();
      const a = await computer(net, "Studio", 60_000, undefined, { clock: fake });
      const b = await computer(net, "Laptop", undefined, undefined, { clock: fake });
      const { view } = await showWords(a, b, app);
      await waitFor(() => a.broker.cards().length === 1);
      const card = a.broker.cards()[0]!;
      fake.advance(60_000);
      expect(a.pairing.get(view.pairingId)).toMatchObject({ status: "failed", error: "expired" });
      await waitFor(() => a.broker.cards().length === 0);
      expect(await Promise.resolve().then(() => answer(a, card.id, "approve")).catch(() => "gone")).not.toBe("accepted");
      await new Promise((r) => setTimeout(r, 50));
      expect(a.registry.get(b.key.id)).toBeUndefined();
      expect(b.registry.get(a.key.id)).toBeUndefined();
    });

    test("a pairing that was cancelled or finished in time has no timer left to end anything", async () => {
      const net = new MemoryNetwork();
      const fake = new FakeClock();
      const a = await computer(net, "Studio", 60_000, undefined, { clock: fake });
      const b = await computer(net, "Laptop", undefined, undefined, { clock: fake });
      const first = (await a.call("device.pair.begin", {}, app)) as { pairingId: string };
      await a.call("device.pair.cancel", { pairingId: first.pairingId }, app);
      const before = a.events.length;
      fake.advance(120_000);
      expect(a.events.length).toBe(before);
      const { view, joined } = await showWords(a, b, terminal);
      await b.call("device.pair.confirm", { pairingId: joined.pairingId, words: joined.words }, terminal);
      await a.call("device.pair.confirm", { pairingId: view.pairingId, words: joined.words }, terminal);
      await waitFor(() => a.registry.get(b.key.id) !== undefined && b.registry.get(a.key.id) !== undefined);
      fake.advance(120_000);
      expect(a.registry.get(b.key.id)).toBeDefined();
      expect(a.pairing.get(view.pairingId)?.status).not.toBe("failed");
    });
  });

  describe("one rule for a device's name: a rename takes what the pairing takes", () => {
    test("a rename to a name the rule refuses is refused with the reason in plain words; one it takes (quotes, a joiner between emoji) is applied", async () => {
      const net = new MemoryNetwork();
      const a = await computer(net, "Studio");
      for (const bad of ["x".repeat(64), "Pi​xel", "Pixel‮trusted", "   ", "ㅤ", "é̂̃̄̅", "a\nb"]) {
        const err = (await a.call("device.rename", { id: a.key.id, name: bad }, app).catch((e: unknown) => e)) as MethodError;
        // The protocol's own length limit answers first for a name that is too long; every other refusal is this rule's, in its words.
        expect([bad, [ERR.INVALID_REQUEST, ERR.INVALID_PARAMS].includes(err.code as never)]).toEqual([bad, true]);
        if (bad.length <= 63) expect(err.message).toMatch(/^a device's name /);
      }
      expect(a.registry.self().name).toBe("Studio");
      for (const ok of ["MacBook \"Pro\"", "Someone’s MacBook Pro", "MacBook \u{1F468}‍\u{1F469}‍\u{1F467}"]) {
        expect(await a.call("device.rename", { id: a.key.id, name: ok }, app)).toEqual({ applied: true });
        expect(a.registry.self().name).toBe(ok);
      }
    });
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
