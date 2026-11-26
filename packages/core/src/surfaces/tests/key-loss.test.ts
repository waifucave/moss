// Lane XC, xc-6b: a program on THIS computer whose answer key was lost (reinstalled, its data cleared) registers a new
// one. The new key never vouches for itself: the engine raises one card, taken on another of the person's devices' own
// keys (a phone, MOSS Code's key here), or, only where the app role is checked by its signature (macOS), on the signed
// app's own press. The person's terminal (`device.programKey.reset`) sends them to that card where it can be answered,
// and otherwise (Linux and Windows, nothing else of theirs to answer it) takes the key itself or opens a 10-minute
// window, with an OK-only notice.
import { describe, expect, test } from "bun:test";
import { cardAnswerSigningInput, programAnswerKeyStatement, programCardAnswerSigningInput, type Caller, type Card, type Program } from "@waifucave/moss-protocol";
import { MossApprovalBroker } from "../../approvals/broker";
import { deviceProofVerifier } from "../../contracts/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeDeviceRegistry, makeFakeDevice, makeFakePhone, toBase64, type FakeDevice } from "../../contracts/fakes/device-registry";
import type { MossConn } from "../../ipc/moss";
import { ProgramKeyTable, PROGRAM_KEY_RESET_MS } from "../program-keys";
import { programKeyMethods } from "../rpc";

const enc = (s: string) => new TextEncoder().encode(s);

function conn(connId: number, role: "app" | "cli", program?: Program): MossConn {
  const caller: Caller = { kind: "user", client: role };
  return { connId, role, caller, features: [], clientName: `test-${program ?? role}`, ...(program ? { surface: program, program } : {}), areas: new Set(), send: () => "x", notify: () => {}, follows: new Map() } as MossConn;
}

async function world(o: { macos?: boolean; otherSigners?: boolean } = {}) {
  const clock = new FakeClock({ start: Date.now() });
  const { registry } = await FakeDeviceRegistry.create({ clock, name: "Studio" });
  const device = registry.self().id;
  const table = new ProgramKeyTable({ now: () => clock.now() });
  const broker = new MossApprovalBroker({ clock, localComputer: "Studio", verify: deviceProofVerifier(registry, table) });
  const methods = programKeyMethods({
    table: () => table, device: () => device, rotation: () => ({ broker, computer: "Studio" }),
    sealedPressProvesPerson: () => o.macos === true, otherSigners: () => o.otherSigners === true,
  });
  const set = methods["device.programKey.set"]!;
  const reset = methods["device.programKey.reset"]!;
  const reg = async (k: FakeDevice, program: Program = "moss") =>
    ({ publicKey: k.publicKey, held: "app-keychain" as const, signature: toBase64(await k.sign(enc(programAnswerKeyStatement({ device, program, publicKey: k.publicKey, held: "app-keychain" })))) });
  const moss = conn(2, "app", "moss");
  const terminal = conn(3, "cli");
  const held = () => table.keyOf(device, "moss")?.publicKey;
  /** Resolves when the table holds `k` for MOSS (the yes is asynchronous: both signatures are checked again). */
  const taken = (k: FakeDevice) => new Promise<void>((resolve) => {
    if (held() === k.publicKey) return resolve();
    const off = table.watch((c) => { if (c.device === device && c.key.program === "moss" && c.key.publicKey === k.publicKey) { off(); resolve(); } });
  });
  const open = () => broker.cards().filter((c) => c.change === "answer-key-lost");
  const sealedPress = (card: Card, option = "approve") =>
    broker.answer(card.id, { optionId: option, hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at: clock.now() } }, { role: "app" });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { clock, registry, device, table, broker, set, reset, reg, moss, terminal, held, taken, open, sealedPress, settle };
}

/** MOSS with its first key held, and a new key K2 asking (the first one lost). */
async function lostKey(o: { macos?: boolean; otherSigners?: boolean } = {}) {
  const w = await world(o);
  const k1 = await makeFakeDevice();
  const k2 = await makeFakeDevice();
  expect(await w.set(w.moss, await w.reg(k1))).toEqual({ applied: true });
  const asked = (await w.set(w.moss, await w.reg(k2))) as { applied: false; card: string };
  return { ...w, k1, k2, asked };
}

describe("a program's new key with its old one lost: the card on this computer (lane XC, xc-6b)", () => {
  test("one card with the new key's words; the same key again is the same card; a newer key replaces it; the key holds until a yes", async () => {
    const w = await lostKey();
    expect(w.asked.applied).toBe(false);
    const card = w.broker.get(w.asked.card)!.card;
    expect(card.change).toBe("answer-key-lost");
    expect(card.expiresAt).toBeNull();
    expect(card.options.map((o) => o.label)).toEqual(["Accept the new key", "Keep the old key"]);
    expect(w.held()).toBe(w.k1.publicKey);
    expect(await w.set(w.moss, await w.reg(w.k2))).toEqual({ applied: false, card: w.asked.card });
    const k3 = await makeFakeDevice();
    const again = (await w.set(w.moss, await w.reg(k3))) as { card: string };
    await w.settle();
    expect(again.card).not.toBe(w.asked.card);
    expect(w.open().map((c) => c.id)).toEqual([again.card]);
  });

  test("MOSS Code's own key on this computer says yes: taken; the old key is gone", async () => {
    const w = await lostKey();
    const code = await makeFakeDevice();
    expect(await w.table.register({ device: w.device, program: "code", ...(await w.reg(code, "code")) })).toEqual({ applied: true });
    const card = w.broker.get(w.asked.card)!.card;
    const at = w.clock.now();
    const signature = toBase64(await code.sign(enc(programCardAnswerSigningInput({ program: "code", id: card.id, hash: card.hash, option: "approve", at }))));
    const done = w.taken(w.k2);
    expect(await w.broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "device", device: w.device, at, signature, program: "code" } }, { role: "app" })).toBe("accepted");
    await done;
    expect(w.held()).toBe(w.k2.publicKey);
    // MOSS's next try with the new key is the key it holds.
    expect(await w.set(w.moss, await w.reg(w.k2))).toEqual({ applied: true });
  });

  test("a paired phone's own key says yes: taken", async () => {
    const w = await lostKey();
    const phone = await makeFakePhone();
    await w.registry.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phone.publicKey, answerKey: phone.answerKey }, { via: "terminal" });
    const card = w.broker.get(w.asked.card)!.card;
    const at = w.clock.now();
    const signature = toBase64(await phone.sign(enc(cardAnswerSigningInput({ id: card.id, hash: card.hash, option: "approve", at }))));
    const done = w.taken(w.k2);
    expect(await w.broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "device", device: phone.id, at, signature } }, { role: "remote", device: phone.id })).toBe("accepted");
    await done;
  });

  test("an unsigned press counts only where the app role is checked by its signature (macOS)", async () => {
    const linux = await lostKey({ macos: false });
    expect(await linux.sealedPress(linux.broker.get(linux.asked.card)!.card)).toBe("accepted");
    await linux.settle();
    expect(linux.held()).toBe(linux.k1.publicKey);
    const mac = await lostKey({ macos: true });
    const done = mac.taken(mac.k2);
    expect(await mac.sealedPress(mac.broker.get(mac.asked.card)!.card)).toBe("accepted");
    await done;
  });

  test("keep the old key: the new one isn't taken", async () => {
    const w = await lostKey({ macos: true });
    expect(await w.sealedPress(w.broker.get(w.asked.card)!.card, "deny")).toBe("accepted");
    await w.settle();
    expect(w.held()).toBe(w.k1.publicKey);
  });
});

describe("the person's terminal: moss device key reset (lane XC, xc-6b)", () => {
  test("where the card can be answered (macOS, or another device's key), it sends the person to the card and takes nothing", async () => {
    for (const o of [{ macos: true }, { otherSigners: true }]) {
      const w = await lostKey(o);
      expect(await w.reset(w.terminal, { program: "moss" })).toEqual({ card: w.asked.card });
      expect(w.held()).toBe(w.k1.publicKey);
    }
  });

  test("Linux or Windows with nothing else to answer: the terminal takes the waiting key, the card goes, and an OK-only notice says so", async () => {
    const w = await lostKey({ macos: false, otherSigners: false });
    expect(await w.reset(w.terminal, { program: "moss" })).toEqual({ accepted: true });
    expect(w.held()).toBe(w.k2.publicKey);
    await w.settle();
    const left = w.open();
    expect(left).toHaveLength(1);
    expect(left[0]!.id).not.toBe(w.asked.card);
    expect(left[0]!.options.map((o) => o.label)).toEqual(["OK"]);
    expect(left[0]!.expiresAt).toBeNull();
  });

  test("nothing waiting yet: a 10-minute window for one registration, with a notice; after it, or a second key, the card again", async () => {
    const w = await world({ macos: false, otherSigners: false });
    const k1 = await makeFakeDevice(), k2 = await makeFakeDevice(), k3 = await makeFakeDevice(), k4 = await makeFakeDevice();
    await w.set(w.moss, await w.reg(k1));
    expect(await w.reset(w.terminal, { program: "moss" })).toEqual({ opened: true });
    expect(await w.set(w.moss, await w.reg(k2))).toEqual({ applied: true });
    expect(w.held()).toBe(k2.publicKey);
    await w.settle();
    expect(w.open().map((c) => c.options.map((o) => o.label))).toEqual([["OK"]]);
    // Once: the next new key asks on the card (and only another reset from the terminal takes it).
    expect(((await w.set(w.moss, await w.reg(k3))) as { applied: boolean }).applied).toBe(false);
    expect(w.held()).toBe(k2.publicKey);
    expect(await w.reset(w.terminal, { program: "moss" })).toEqual({ accepted: true });
    expect(w.held()).toBe(k3.publicKey);
    // A window that ran out takes nothing.
    const fresh = await world({ macos: false, otherSigners: false });
    await fresh.set(fresh.moss, await fresh.reg(k1));
    await fresh.reset(fresh.terminal, { program: "moss" });
    fresh.clock.advance(PROGRAM_KEY_RESET_MS + 1);
    expect(((await fresh.set(fresh.moss, await fresh.reg(k4))) as { applied: boolean }).applied).toBe(false);
    expect(fresh.held()).toBe(k1.publicKey);
  });

  test("on macOS with nothing waiting, no window opens: the signed app's next new key asks on the card", async () => {
    const w = await world({ macos: true, otherSigners: false });
    const k1 = await makeFakeDevice();
    await w.set(w.moss, await w.reg(k1));
    expect(await w.reset(w.terminal, { program: "moss" })).toEqual({});
    expect(((await w.set(w.moss, await w.reg(await makeFakeDevice()))) as { applied: boolean }).applied).toBe(false);
    expect(w.held()).toBe(k1.publicKey);
  });

  test("on Linux or Windows with another device that could answer, and nothing waiting, no window opens", async () => {
    const w = await world({ macos: false, otherSigners: true });
    await w.set(w.moss, await w.reg(await makeFakeDevice()));
    expect(await w.reset(w.terminal, { program: "moss" })).toEqual({});
    expect(((await w.set(w.moss, await w.reg(await makeFakeDevice()))) as { applied: boolean }).applied).toBe(false);
  });

  test("only a terminal resets; a program with no key here has nothing to reset", async () => {
    const w = await world();
    await expect(Promise.resolve(w.reset(w.moss, { program: "moss" }))).rejects.toThrow(/terminal/);
    expect(await w.reset(w.terminal, { program: "moss" })).toEqual({ none: true });
  });
});
