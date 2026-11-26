// Lane XC, xc-6, parts 1 and 2: a paired computer's program key rotated there (the held key's hand-over, its own
// card on that computer) reaches the holder as a chain of hand-overs; the holder takes the new key with no card when
// every step is signed by the key it replaces, names this device and this program, and comes after the holder took
// the held key. The replaced key is dead here at once and never taken again. A revoke clears all the holder kept.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { programAnswerKeyRotateStatement, programAnswerKeyStatement, type Program } from "@waifucave/moss-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { toBase64 } from "../../identity/bytes";
import { DeviceKey } from "../../identity/device-key";
import { generateEd25519, type Ed25519Key } from "../../identity/keys";
import { ProgramKeyTable } from "../../surfaces/program-keys";
import { FileDeviceRegistry, type PeerProgramKeys, type ProgramKeyChange, type ProgramKeyHandOverStep, PROGRAM_HAND_OVER_CLOCK_SLACK_MS, programKeysStatement } from "../registry";

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (k: Ed25519Key) => toBase64(k.publicKey);

async function computer(name: string, clock: FakeClock) {
  const key = await DeviceKey.loadOrCreate(new MemorySecretStore());
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "moss-xc6-")), key, clock, self: { name, computer: name, os: "macos" } });
  return { key, registry };
}

async function world() {
  const clock = new FakeClock({ start: Date.now() });
  const a = await computer("Alpha", clock);
  const b = await computer("Beta", clock);
  await b.registry.add({ id: a.key.id, name: "Alpha", kind: "desktop", runsCore: true, computer: "Alpha", publicKey: a.key.publicKeyBase64 }, { via: "terminal" });
  const events: ProgramKeyChange[] = [];
  b.registry.watchProgramKeys((e) => events.push(e));
  let at = 0;
  /** Alpha's message: `keys` signed with Alpha's link key, each `at` newer. */
  const send = (keys: PeerProgramKeys["keys"]) => {
    const msg: PeerProgramKeys = { keys, at: ++at };
    return b.registry.applyPeerProgramKeys(a.key.id, msg, a.key.sign(programKeysStatement(a.key.id, msg)));
  };
  const reg = (k: Ed25519Key, program: Program = "moss", device = a.key.id) =>
    toBase64(k.sign(enc(programAnswerKeyStatement({ device, program, publicKey: b64(k), held: "none" }))));
  const entry = (k: Ed25519Key, handOvers?: ProgramKeyHandOverStep[], program: Program = "moss") =>
    ({ program, publicKey: b64(k), held: "none" as const, registration: reg(k, program), ...(handOvers ? { handOvers } : {}) });
  const step = (from: Ed25519Key, to: Ed25519Key, stepAt: number, o: { device?: string; program?: Program; signer?: Ed25519Key } = {}): ProgramKeyHandOverStep => ({
    from: b64(from), to: b64(to), at: stepAt,
    signature: toBase64((o.signer ?? from).sign(enc(programAnswerKeyRotateStatement({ device: o.device ?? a.key.id, program: o.program ?? "moss", from: b64(from), to: b64(to), at: stepAt })))),
  });
  const held = () => b.registry.get(a.key.id)!.answerKeys?.moss?.publicKey;
  const verifies = async (k: Ed25519Key) => b.registry.verifyProgramAnswer(a.key.id, "moss", enc("x"), k.sign(enc("x")));
  return { clock, a, b, events, send, entry, step, held, verifies };
}

describe("part 2: a rotation's hand-over chain, taken by the holder with no card", () => {
  test("a chain from the held key: taken; the old key stops verifying at once and is never taken again", async () => {
    const w = await world();
    const k1 = generateEd25519(), k2 = generateEd25519();
    expect(await w.send([w.entry(k1)])).toBe(true);
    w.clock.advance(60_000);
    expect(await w.send([w.entry(k2, [w.step(k1, k2, w.clock.now())])])).toBe(true);
    expect(w.held()).toBe(b64(k2));
    expect(await w.verifies(k2)).toBe(true);
    expect(await w.verifies(k1)).toBe(false);
    expect(w.b.registry.pendingProgramKeys()).toEqual([]);
    expect(w.b.registry.programKeyReplaced(w.a.key.id, "moss")).toBe(false);
    // A rollback: K1 again, with its own valid registration (and a chain K2 -> K1 the attacker can't sign): never taken.
    expect(await w.send([w.entry(k1)])).toBe(true);
    expect(w.held()).toBe(b64(k2));
    expect(w.b.registry.pendingProgramKeys()).toEqual([]);
  });

  test("two rotations while the holder was offline: the whole chain in one message", async () => {
    const w = await world();
    const k1 = generateEd25519(), k2 = generateEd25519(), k3 = generateEd25519();
    await w.send([w.entry(k1)]);
    w.clock.advance(60_000);
    const t = w.clock.now();
    expect(await w.send([w.entry(k3, [w.step(k1, k2, t), w.step(k2, k3, t + 1000)])])).toBe(true);
    expect(w.held()).toBe(b64(k3));
    expect(await w.verifies(k2)).toBe(false);
  });

  test("a forged step, one naming another device or another program, or a chain that doesn't start at the held key: not taken (a card asks)", async () => {
    const w = await world();
    const k1 = generateEd25519();
    await w.send([w.entry(k1)]);
    w.clock.advance(60_000);
    const t = w.clock.now();
    const other = generateEd25519();
    const cases: [string, (k: Ed25519Key) => ProgramKeyHandOverStep[]][] = [
      ["forged", (k) => [w.step(k1, k, t, { signer: generateEd25519() })]],
      ["another device", (k) => [w.step(k1, k, t, { device: w.b.key.id })]],
      ["another program", (k) => [w.step(k1, k, t, { program: "host" })]],
      ["not from the held key", (k) => [w.step(other, k, t)]],
      ["no chain", () => []],
    ];
    for (const [why, chain] of cases) {
      const k = generateEd25519();
      expect([why, await w.send([w.entry(k, chain(k))])]).toEqual([why, true]);
      expect([why, w.held()]).toEqual([why, b64(k1)]);
      expect([why, w.b.registry.pendingProgramKeys().map((p) => p.key.publicKey)]).toEqual([why, [b64(k)]]);
    }
  });

  test("an old hand-over signed before the holder took the held key can't be spliced in", async () => {
    const w = await world();
    const k1 = generateEd25519(), k2 = generateEd25519();
    const before = w.clock.now() - PROGRAM_HAND_OVER_CLOCK_SLACK_MS - 60_000;
    await w.send([w.entry(k1)]);
    w.clock.advance(60_000);
    // K1's hand-over to K2, dated before Beta took K1 (past the clocks' slack): not taken.
    expect(await w.send([w.entry(k2, [w.step(k1, k2, before)])])).toBe(true);
    expect(w.held()).toBe(b64(k1));
    // Within the slack it is taken (two computers' clocks differ a little).
    const k3 = generateEd25519();
    expect(await w.send([w.entry(k3, [w.step(k1, k3, w.clock.now() - 60_000 - 1000)])])).toBe(true);
    expect(w.held()).toBe(b64(k3));
  });

  test("a step dated before the one it follows breaks the chain", async () => {
    const w = await world();
    const k1 = generateEd25519(), k2 = generateEd25519(), k3 = generateEd25519();
    await w.send([w.entry(k1)]);
    w.clock.advance(60_000);
    const t = w.clock.now();
    await w.send([w.entry(k3, [w.step(k1, k2, t), w.step(k2, k3, t - 5000)])]);
    expect(w.held()).toBe(b64(k1));
  });

  test("a replayed message counts once; a holder that reads no chain still takes the message (the link signature doesn't cover it)", async () => {
    const w = await world();
    const k1 = generateEd25519();
    const msg: PeerProgramKeys = { keys: [w.entry(k1, [])], at: 100 };
    const sig = w.a.key.sign(programKeysStatement(w.a.key.id, msg));
    expect(await w.b.registry.applyPeerProgramKeys(w.a.key.id, msg, sig)).toBe(true);
    expect(await w.b.registry.applyPeerProgramKeys(w.a.key.id, msg, sig)).toBe(false);
    // The statement is the same with or without the chain (xc-4's holders verify it as before).
    const { handOvers: _h, ...bare } = msg.keys[0]!;
    expect(Buffer.from(programKeysStatement(w.a.key.id, { keys: [bare], at: 100 })).equals(Buffer.from(programKeysStatement(w.a.key.id, msg)))).toBe(true);
  });
});

describe("part 2, on the computer that rotates: the table keeps the chain and sends it", () => {
  test("replace keeps each hand-over; registrations carry them; a plain register of another key still needs the card", async () => {
    const clock = new FakeClock({ start: Date.now() });
    const table = new ProgramKeyTable({ now: () => clock.now() });
    const device = "dev1";
    const k1 = generateEd25519(), k2 = generateEd25519();
    const input = (k: Ed25519Key) => ({ device, program: "moss" as const, publicKey: b64(k), held: "none" as const, signature: toBase64(k.sign(enc(programAnswerKeyStatement({ device, program: "moss", publicKey: b64(k), held: "none" })))) });
    expect(await table.register(input(k1))).toEqual({ applied: true });
    expect(await table.register(input(k2))).toEqual({ applied: false, card: true });
    const at = clock.now();
    const signature = toBase64(k1.sign(enc(programAnswerKeyRotateStatement({ device, program: "moss", from: b64(k1), to: b64(k2), at }))));
    await table.replace(input(k2), { from: b64(k1), at, signature });
    const sent = table.registrations(device);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.publicKey).toBe(b64(k2));
    expect(sent[0]!.handOvers).toEqual([{ from: b64(k1), to: b64(k2), at, signature }]);
  });
});

describe("part 1: a revoke clears everything the holder kept about the computer's keys", () => {
  test("a waiting key, the declined and retired ones, and the times: gone, and the waiting card is withdrawn", async () => {
    const w = await world();
    const k1 = generateEd25519(), k2 = generateEd25519(), k3 = generateEd25519();
    await w.send([w.entry(k1)]);
    w.clock.advance(60_000);
    await w.send([w.entry(k2, [w.step(k1, k2, w.clock.now())])]);
    await w.send([w.entry(generateEd25519())]);
    await w.send([w.entry(k3)]);
    expect(w.b.registry.pendingProgramKeys()).toHaveLength(1);
    w.events.length = 0;
    await w.b.registry.revoke(w.a.key.id);
    expect(w.events).toEqual([{ type: "settled", device: w.a.key.id, program: "moss" }]);
    expect(w.b.registry.pendingProgramKeys()).toEqual([]);
    expect(w.b.registry.programKeyReplaced(w.a.key.id, "moss")).toBe(false);
    expect(w.b.registry.get(w.a.key.id)!.answerKeys).toBeUndefined();
    expect(await w.verifies(k2)).toBe(false);
  });
});
