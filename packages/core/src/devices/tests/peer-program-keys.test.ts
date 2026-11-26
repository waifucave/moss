// Lane XC: a paired computer's program answer keys (MOSS's, the host's, MOSS Code's where it has no single key) reach
// the other computers over the link, so a yes pressed in MOSS on Alpha, or on the host's island there, is a signed
// answer Beta checks itself. The holder takes a key only from that computer's own link, with the key's own registration
// over a statement naming that device and that program; keeps the first key of a program; drops them at a revoke; takes
// each message and each answer once; and an older peer, which serves no such notify, is unaffected.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { programAnswerKeyStatement, programCardAnswerSigningInput, type Program, type SignedCardAnswer } from "@waifucave/moss-protocol";
import { MossApprovalBroker } from "../../approvals/broker";
import { brokerAsker } from "../../computers/ask-user";
import { callCardRenderer } from "../../computers/call-cards";
import { deviceProofVerifier, verifySignedAnswer, type ApprovalEvent } from "../../contracts/approval-broker";
import { MemoryAnswerLedger } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { toBase64 } from "../../identity/bytes";
import { DeviceKey } from "../../identity/device-key";
import { generateEd25519, type Ed25519Key } from "../../identity/keys";
import { DEVICE_PROGRAM_KEYS, DEVICE_UPDATE, shareDeviceUpdates, shareProgramKeys } from "../../links/relay";
import { ProgramKeyTable } from "../../surfaces/program-keys";
import { FileDeviceRegistry, type PeerProgramKeys, programKeysStatement } from "../registry";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const render = callCardRenderer(sha256);
const enc = (s: string) => new TextEncoder().encode(s);
const WRITE = { path: "home/Beta/x.txt", data: { encoding: "utf8" as const, text: "hello" } };

async function computer(name: string, clock: FakeClock) {
  const key = await DeviceKey.loadOrCreate(new MemorySecretStore());
  const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "moss-xc-pk-")), key, clock, self: { name, computer: name, os: "macos" } });
  return { key, registry, name };
}

/** Alpha and Beta, each knowing the other; Alpha's MOSS and host keys registered on Alpha. */
async function pair() {
  const clock = new FakeClock({ start: Date.now() });
  const a = await computer("Alpha", clock);
  const b = await computer("Beta", clock);
  for (const [x, y] of [[a, b], [b, a]] as const) {
    await x.registry.add({ id: y.key.id, name: y.name, kind: "desktop", runsCore: true, computer: y.name, publicKey: y.key.publicKeyBase64 }, { via: "terminal" });
  }
  const table = new ProgramKeyTable();
  const keys: Partial<Record<Program, Ed25519Key>> = {};
  for (const program of ["moss", "host"] as const) {
    const k = generateEd25519();
    keys[program] = k;
    const publicKey = toBase64(k.publicKey);
    const signature = toBase64(k.sign(enc(programAnswerKeyStatement({ device: a.key.id, program, publicKey, held: "none" }))));
    await table.register({ device: a.key.id, program, publicKey, held: "none", signature });
  }
  return { clock, a, b, table, keys };
}

/** What Alpha sends, signed with Alpha's link key (or `signer`). */
function message(p: Awaited<ReturnType<typeof pair>>, at: number, keys = p.table.registrations(p.a.key.id), signer: { sign(d: Uint8Array): Uint8Array } = p.a.key) {
  const msg: PeerProgramKeys = { keys, at };
  return { msg, sig: signer.sign(programKeysStatement(p.a.key.id, msg)) };
}

function registration(device: string, program: Program, k: Ed25519Key, signer: Ed25519Key = k, named: { device?: string; program?: Program } = {}) {
  const publicKey = toBase64(k.publicKey);
  return { program, publicKey, held: "none" as const, registration: toBase64(signer.sign(enc(programAnswerKeyStatement({ device: named.device ?? device, program: named.program ?? program, publicKey, held: "none" })))) };
}

describe("a paired computer's program keys, as the holder takes them (lane XC)", () => {
  test("from that computer's own link, each with its own registration: taken, and each program's key verifies only its own program", async () => {
    const p = await pair();
    const { msg, sig } = message(p, 1);
    expect(await p.b.registry.applyPeerProgramKeys(p.a.key.id, msg, sig)).toBe(true);
    expect(Object.keys(p.b.registry.get(p.a.key.id)!.answerKeys ?? {}).sort()).toEqual(["host", "moss"]);
    const data = enc("an answer");
    const mossSig = p.keys.moss!.sign(data);
    expect(await p.b.registry.verifyProgramAnswer(p.a.key.id, "moss", data, mossSig)).toBe(true);
    // One program's signature never passes as another's, nor as MOSS Code's.
    expect(await p.b.registry.verifyProgramAnswer(p.a.key.id, "host", data, mossSig)).toBe(false);
    expect(await p.b.registry.verifyProgramAnswer(p.a.key.id, "code", data, mossSig)).toBe(false);
  });

  test("only the sender's own record: the same message from a third computer's link names that computer, and its link key doesn't sign Alpha's", async () => {
    const p = await pair();
    const c = await computer("Gamma", p.clock);
    await p.b.registry.add({ id: c.key.id, name: "Gamma", kind: "desktop", runsCore: true, computer: "Gamma", publicKey: c.key.publicKeyBase64 }, { via: "terminal" });
    // Gamma relays Alpha's keys as its own: the registrations name Alpha's device, so they fail for Gamma.
    const keys = p.table.registrations(p.a.key.id);
    const relayed: PeerProgramKeys = { keys, at: 1 };
    expect(await p.b.registry.applyPeerProgramKeys(c.key.id, relayed, c.key.sign(programKeysStatement(c.key.id, relayed)))).toBe(false);
    // Alpha's message with another computer's link signature.
    const { msg } = message(p, 1);
    expect(await p.b.registry.applyPeerProgramKeys(p.a.key.id, msg, c.key.sign(programKeysStatement(p.a.key.id, msg)))).toBe(false);
    expect(p.b.registry.get(p.a.key.id)!.answerKeys).toBeUndefined();
    expect(p.b.registry.get(c.key.id)!.answerKeys).toBeUndefined();
  });

  test("a forged registration, one naming another device, or another program, refuses the whole message", async () => {
    const p = await pair();
    const k = generateEd25519();
    const forged = [
      registration(p.a.key.id, "moss", k, generateEd25519()), // signed by another key
      registration(p.a.key.id, "moss", k, k, { device: p.b.key.id }), // names Beta's device
      registration(p.a.key.id, "moss", k, k, { program: "code" }), // a "code" registration labelled "moss"
    ];
    for (const [i, bad] of forged.entries()) {
      const { msg, sig } = message(p, i + 1, [...p.table.registrations(p.a.key.id).filter((x) => x.program !== "moss"), bad]);
      expect([i, await p.b.registry.applyPeerProgramKeys(p.a.key.id, msg, sig)]).toEqual([i, false]);
    }
    expect(p.b.registry.get(p.a.key.id)!.answerKeys).toBeUndefined();
    // Two keys for one program, or an unknown program: refused too.
    const two = message(p, 10, [...p.table.registrations(p.a.key.id), registration(p.a.key.id, "moss", k)]);
    expect(await p.b.registry.applyPeerProgramKeys(p.a.key.id, two.msg, two.sig)).toBe(false);
    const unknown = message(p, 11, [{ ...registration(p.a.key.id, "moss", k), program: "plugin" as never }]);
    expect(await p.b.registry.applyPeerProgramKeys(p.a.key.id, unknown.msg, unknown.sig)).toBe(false);
  });

  test("a message counts once: the same one again, or an older one, is refused", async () => {
    const p = await pair();
    const first = message(p, 5);
    expect(await p.b.registry.applyPeerProgramKeys(p.a.key.id, first.msg, first.sig)).toBe(true);
    expect(await p.b.registry.applyPeerProgramKeys(p.a.key.id, first.msg, first.sig)).toBe(false);
    const older = message(p, 4);
    expect(await p.b.registry.applyPeerProgramKeys(p.a.key.id, older.msg, older.sig)).toBe(false);
  });

  test("the first key of a program is kept: a different one (the app reinstalled) isn't taken, and is noted so its answers are refused in words", async () => {
    const p = await pair();
    const first = message(p, 1);
    await p.b.registry.applyPeerProgramKeys(p.a.key.id, first.msg, first.sig);
    const fresh = generateEd25519();
    const next = message(p, 2, [registration(p.a.key.id, "moss", fresh), ...p.table.registrations(p.a.key.id).filter((x) => x.program !== "moss")]);
    expect(await p.b.registry.applyPeerProgramKeys(p.a.key.id, next.msg, next.sig)).toBe(true);
    expect(p.b.registry.get(p.a.key.id)!.answerKeys!.moss!.publicKey).toBe(toBase64(p.keys.moss!.publicKey));
    expect(p.b.registry.programKeyReplaced(p.a.key.id, "moss")).toBe(true);
    expect(p.b.registry.programKeyReplaced(p.a.key.id, "host")).toBe(false);
    const data = enc("x");
    expect(await p.b.registry.verifyProgramAnswer(p.a.key.id, "moss", data, fresh.sign(data))).toBe(false);
    expect(await p.b.registry.verifyProgramAnswer(p.a.key.id, "moss", data, p.keys.moss!.sign(data))).toBe(true);
  });

  test("a revoked computer's program keys go at once, and a revoked or unknown device sends none", async () => {
    const p = await pair();
    const first = message(p, 1);
    await p.b.registry.applyPeerProgramKeys(p.a.key.id, first.msg, first.sig);
    await p.b.registry.revoke(p.a.key.id);
    expect(p.b.registry.get(p.a.key.id)!.answerKeys).toBeUndefined();
    const data = enc("x");
    expect(await p.b.registry.verifyProgramAnswer(p.a.key.id, "moss", data, p.keys.moss!.sign(data))).toBe(false);
    const later = message(p, 2);
    expect(await p.b.registry.applyPeerProgramKeys(p.a.key.id, later.msg, later.sig)).toBe(false);
    const stranger = await DeviceKey.fromKey(generateEd25519());
    expect(await p.b.registry.applyPeerProgramKeys(stranger.id, later.msg, later.sig)).toBe(false);
  });

  test("nothing changes on the computer's own side: its own record carries no program keys from a peer's message", async () => {
    const p = await pair();
    const { msg, sig } = message(p, 1);
    // Alpha's message applied to Alpha itself (its own id): refused, its own record untouched.
    expect(await p.a.registry.applyPeerProgramKeys(p.a.key.id, msg, sig)).toBe(false);
    expect(p.a.registry.self().answerKeys).toBeUndefined();
    expect(p.table.keyOf(p.a.key.id, "moss")).toBeDefined();
  });
});

describe("a yes pressed on Alpha, checked by Beta (lane XC)", () => {
  async function answered(program: Program, label: Program = program) {
    const p = await pair();
    const { msg, sig } = message(p, 1);
    await p.b.registry.applyPeerProgramKeys(p.a.key.id, msg, sig);
    // Alpha's broker checks its own programs' presses with its own table, as the daemon's does.
    const broker = new MossApprovalBroker({ clock: p.clock, verify: deviceProofVerifier(p.a.registry, p.table) });
    broker.watch((e: ApprovalEvent) => {
      if (e.type !== "requested") return;
      const card = e.card;
      const at = p.clock.now();
      const signature = toBase64(p.keys[program]!.sign(enc(programCardAnswerSigningInput({ program, id: card.id, hash: card.hash, option: "approve", at }))));
      queueMicrotask(() => void broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "device", device: p.a.key.id, at, signature, program } }, { role: "app" }));
    });
    const need = { needsAnswer: true as const, computer: "Beta", method: "tree.write", card: render({ computer: "Beta", method: "tree.write", params: WRITE })! };
    const answer = await brokerAsker({ broker })(need, { as: { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" } });
    expect(answer).not.toBeNull();
    const ledger = new MemoryAnswerLedger();
    const check = (s: SignedCardAnswer) => verifySignedAnswer(s, { self: "Beta", method: "tree.write", params: WRITE, now: p.clock.now(), sha256, devices: p.b.registry, ledger, render });
    return { p, answer: { ...answer!, program: label }, check };
  }

  test("pressed in MOSS: the answer names its program, and Beta takes it once", async () => {
    const { answer, check } = await answered("moss");
    expect(answer.program).toBe("moss");
    expect(await check(answer)).toBe("ok");
    expect(await check(answer)).toBe("used");
  });

  test("pressed on the host's island (the host's own key): Beta takes it", async () => {
    const { answer, check } = await answered("host");
    expect(await check(answer)).toBe("ok");
  });

  test("MOSS's signature labelled as MOSS Code's or the host's is refused; with no program it is refused as the device's single key", async () => {
    for (const label of ["code", "host"] as const) {
      const { answer, check } = await answered("moss", label);
      expect([label, await check(answer)]).toEqual([label, "bad-signature"]);
    }
    const { answer, check } = await answered("moss");
    const { program: _p, ...bare } = answer;
    expect(await check(bare as SignedCardAnswer)).toBe("bad-device");
  });

  test("an app reinstalled on Alpha (a new MOSS key Beta didn't take): the answer is refused as a replaced key, not a silent bad signature", async () => {
    const { p, check, answer } = await answered("moss");
    const fresh = generateEd25519();
    const next = message(p, 2, [registration(p.a.key.id, "moss", fresh)]);
    await p.b.registry.applyPeerProgramKeys(p.a.key.id, next.msg, next.sig);
    const at = p.clock.now();
    const signature = toBase64(fresh.sign(enc(programCardAnswerSigningInput({ program: "moss", id: answer.card.id, hash: answer.card.hash, option: answer.option, at }))));
    expect(await check({ ...answer, at, signature })).toBe("replaced-key");
  });
});

describe("over the link (lane XC)", () => {
  /** Two computers' transports, in memory: a notify reaches the other side's handler as from the sender. */
  function wires(a: string, b: string) {
    const handlers: Record<string, Map<string, (p: unknown, from: string) => void>> = { [a]: new Map(), [b]: new Map() };
    const watchers: Record<string, ((v: { peer: string; up: boolean }) => void)[]> = { [a]: [], [b]: [] };
    const t = (self: string, other: string) => ({
      connect: async (peer: string) => ({ notify: (m: string, params: unknown) => queueMicrotask(() => handlers[peer]!.get(m)?.(structuredClone(params), self)) }),
      links: () => [{ peer: other, up: true }],
      watch: (fn: (v: { peer: string; up: boolean }) => void) => { watchers[self]!.push(fn); return () => {}; },
      onNotify: (m: string, fn: (p: unknown, from: string) => void) => { handlers[self]!.set(m, fn); return () => {}; },
    });
    return { ta: t(a, b) as never, tb: t(b, a) as never, handlers, up: () => { for (const fn of watchers[a]!) fn({ peer: b, up: true }); for (const fn of watchers[b]!) fn({ peer: a, up: true }); } };
  }
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
    return ok();
  };

  test("Alpha's keys reach Beta when the link comes up, and a key registered later follows", async () => {
    const p = await pair();
    const w = wires(p.a.key.id, p.b.key.id);
    const empty = { registrations: () => [], watch: () => () => {} };
    shareProgramKeys({ transport: w.ta, registry: p.a.registry, key: p.a.key, programs: p.table, clock: p.clock });
    shareProgramKeys({ transport: w.tb, registry: p.b.registry, key: p.b.key, programs: empty, clock: p.clock });
    w.up();
    expect(await until(() => Object.keys(p.b.registry.get(p.a.key.id)?.answerKeys ?? {}).length === 2)).toBe(true);
    // MOSS Code's key registered later (a home with no single key): sent on its registration.
    const code = generateEd25519();
    const r = registration(p.a.key.id, "code", code);
    p.clock.advance(1000);
    await p.table.register({ device: p.a.key.id, program: "code", publicKey: r.publicKey, held: "none", signature: r.registration });
    expect(await until(() => p.b.registry.get(p.a.key.id)?.answerKeys?.code !== undefined)).toBe(true);
  });

  test("an older peer, which serves no such notify, still takes the device update and is otherwise unaffected", async () => {
    const p = await pair();
    const w = wires(p.a.key.id, p.b.key.id);
    shareDeviceUpdates({ transport: w.ta, registry: p.a.registry, key: p.a.key, clock: p.clock });
    shareProgramKeys({ transport: w.ta, registry: p.a.registry, key: p.a.key, programs: p.table, clock: p.clock });
    // Beta on an older build: the device update only.
    shareDeviceUpdates({ transport: w.tb, registry: p.b.registry, key: p.b.key, clock: p.clock });
    await p.a.registry.rename(p.a.key.id, "Alpha Studio").catch(() => undefined);
    w.up();
    expect(w.handlers[p.b.key.id]!.has(DEVICE_UPDATE)).toBe(true);
    expect(w.handlers[p.b.key.id]!.has(DEVICE_PROGRAM_KEYS)).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(p.b.registry.get(p.a.key.id)!.answerKeys).toBeUndefined();
  });
});
