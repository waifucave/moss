// Lane XC, xc-6, part 3: a paired computer's app has a new answer key that came with no hand-over (the app reinstalled
// there, its data wiped). The holder asks the person on its OWN card, one per device and program, which the presenting
// computer never sees or answers. A yes takes the key (the old one dead at once), the person's no declines it for good,
// a newer key replaces the open card, and a key still waiting is asked about again after a restart.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { programAnswerKeyStatement, type Card } from "@waifucave/moss-protocol";
import { MossApprovalBroker } from "../../approvals/broker";
import type { ApprovalEvent } from "../../contracts/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { toBase64 } from "../../identity/bytes";
import { DeviceKey } from "../../identity/device-key";
import { generateEd25519, type Ed25519Key } from "../../identity/keys";
import { answerKeyWords } from "../../identity/sas";
import { askAboutNewProgramKeys } from "../../links/relay";
import { brokerCardOpener, deviceView } from "../rpc";
import { FileDeviceRegistry, type PeerProgramKeys, programKeysStatement } from "../registry";

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (k: Ed25519Key) => toBase64(k.publicKey);
const settle = () => new Promise((r) => setTimeout(r, 20));

async function world(dir = mkdtempSync(join(tmpdir(), "moss-xc6-card-")), clock = new FakeClock({ start: Date.now() }), alphaKey?: DeviceKey, betaStore = new MemorySecretStore()) {
  const a = alphaKey ?? (await DeviceKey.loadOrCreate(new MemorySecretStore()));
  const bKey = await DeviceKey.loadOrCreate(betaStore);
  const registry = await FileDeviceRegistry.open({ home: dir, key: bKey, clock, self: { name: "Beta", computer: "Beta", os: "macos" } });
  if (registry.get(a.id) === undefined) await registry.add({ id: a.id, name: "Alpha", kind: "desktop", runsCore: true, computer: "Alpha", publicKey: a.publicKeyBase64 }, { via: "terminal" });
  const broker = new MossApprovalBroker({ clock });
  const shown: Card[] = [];
  const gone: string[] = [];
  broker.watch((e: ApprovalEvent) => {
    if (e.type === "requested") shown.push(e.card);
    else gone.push(e.cardId);
  });
  // The broker's opener, with whether the person answered on the card itself (yes or no), as lane-int's opener gives it
  // (`answered`: the decision was by the card, not an expiry, a withdrawal or a cancel).
  const base = brokerCardOpener(broker);
  const openCard: typeof base = async (req, opts) => {
    let resolved: (by: boolean) => void = () => undefined;
    const answered = new Promise<boolean>((r) => (resolved = r));
    const opened = await base(req, opts);
    const off = broker.watch((e: ApprovalEvent) => {
      if (e.type === "resolved" && e.cardId === opened.card) { off(); resolved(e.outcome === "approved" || e.outcome === "denied"); }
    });
    return { ...opened, answered } as typeof opened;
  };
  const stop = askAboutNewProgramKeys({ registry, openCard });
  let at = 0;
  const send = (k: Ed25519Key) => {
    const registration = toBase64(k.sign(enc(programAnswerKeyStatement({ device: a.id, program: "moss", publicKey: b64(k), held: "none" }))));
    const msg: PeerProgramKeys = { keys: [{ program: "moss", publicKey: b64(k), held: "none", registration }], at: Date.now() + ++at };
    return registry.applyPeerProgramKeys(a.id, msg, a.sign(programKeysStatement(a.id, msg)));
  };
  const open = () => shown.filter((c) => !gone.includes(c.id));
  /** Beta's own app answers, as its sealed frame does. */
  const press = (card: Card, option: "approve" | "deny") =>
    broker.answer(card.id, { optionId: option, hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at: clock.now() } }, { role: "app" });
  const held = () => registry.get(a.id)!.answerKeys?.moss?.publicKey;
  return { a, registry, broker, shown, open, send, press, held, stop, dir, clock, betaStore };
}

describe("part 3: the holder's card for a new key with no hand-over (lane XC, xc-6)", () => {
  test("one card on the holder, about the presenting computer, with the key's four words; a yes there takes the key and the old one is dead", async () => {
    const w = await world();
    const k1 = generateEd25519(), k2 = generateEd25519();
    await w.send(k1);
    expect(w.open()).toHaveLength(0);
    await w.send(k2);
    await settle();
    expect(w.open()).toHaveLength(1);
    const card = w.open()[0]!;
    expect(card.change).toBe("peer-answer-key");
    expect(card.expiresAt).toBeNull();
    expect(JSON.stringify(card.fields)).toContain(answerKeyWords(b64(k2)).join(" "));
    expect(JSON.stringify(card.fields)).toContain("Alpha");
    expect(w.held()).toBe(b64(k1));
    expect(await w.press(card, "approve")).toBe("accepted");
    await settle();
    expect(w.held()).toBe(b64(k2));
    expect(w.registry.pendingProgramKeys()).toEqual([]);
    expect(await w.registry.verifyProgramAnswer(w.a.id, "moss", enc("x"), k1.sign(enc("x")))).toBe(false);
    expect(await w.registry.verifyProgramAnswer(w.a.id, "moss", enc("x"), k2.sign(enc("x")))).toBe(true);
  });

  test("the presenting computer can't answer it: not by its own link, nor as a signed answer relayed by another", async () => {
    const w = await world();
    await w.send(generateEd25519());
    await w.send(generateEd25519());
    await settle();
    const card = w.open()[0]!;
    expect(await w.broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "device", device: w.a.id, at: w.clock.now(), signature: "AAAA" } }, { role: "remote", device: w.a.id })).toBe("bad-origin");
    expect(await w.broker.answer(card.id, { optionId: "approve", hash: card.hash, proof: { via: "device", device: w.a.id, at: w.clock.now(), signature: "AAAA" } }, { role: "peer", device: "someone-else" } as never)).toBe("bad-origin");
    expect(w.open()).toHaveLength(1);
  });

  test("the person's no keeps the old key and declines the new one: the same key raises no second card; another key raises its own", async () => {
    const w = await world();
    const k1 = generateEd25519(), k2 = generateEd25519();
    await w.send(k1);
    await w.send(k2);
    await settle();
    expect(await w.press(w.open()[0]!, "deny")).toBe("accepted");
    await settle();
    expect(w.held()).toBe(b64(k1));
    expect(w.registry.programKeyReplaced(w.a.id, "moss")).toBe(true);
    await w.send(k2);
    await settle();
    expect(w.open()).toHaveLength(0);
    const k3 = generateEd25519();
    await w.send(k3);
    await settle();
    expect(w.open()).toHaveLength(1);
    expect(JSON.stringify(w.open()[0]!.fields)).toContain(answerKeyWords(b64(k3)).join(" "));
  });

  test("three different keys in a row leave one open card, about the last", async () => {
    const w = await world();
    await w.send(generateEd25519());
    const keys = [generateEd25519(), generateEd25519(), generateEd25519()];
    for (const k of keys) {
      await w.send(k);
      await settle();
    }
    expect(w.open()).toHaveLength(1);
    expect(JSON.stringify(w.open()[0]!.fields)).toContain(answerKeyWords(b64(keys[2]!)).join(" "));
    expect(w.registry.pendingProgramKeys().map((p) => p.key.publicKey)).toEqual([b64(keys[2]!)]);
    // A yes on the open card takes the last key.
    await w.press(w.open()[0]!, "approve");
    await settle();
    expect(w.held()).toBe(b64(keys[2]!));
  });

  test("a waiting key survives a restart: its card is shown again", async () => {
    const w = await world();
    await w.send(generateEd25519());
    const k2 = generateEd25519();
    await w.send(k2);
    await settle();
    w.stop();
    await settle();
    const again = await world(w.dir, w.clock, w.a, w.betaStore);
    await settle();
    expect(again.open()).toHaveLength(1);
    expect(JSON.stringify(again.open()[0]!.fields)).toContain(answerKeyWords(b64(k2)).join(" "));
  });

  test("a revoke withdraws the open card", async () => {
    const w = await world();
    await w.send(generateEd25519());
    await w.send(generateEd25519());
    await settle();
    expect(w.open()).toHaveLength(1);
    await w.registry.revoke(w.a.id);
    await settle();
    expect(w.open()).toHaveLength(0);
  });

  test("an opener that can't say the person answered declines nothing: the key keeps waiting", async () => {
    const clock = new FakeClock({ start: Date.now() });
    const a = await DeviceKey.loadOrCreate(new MemorySecretStore());
    const registry = await FileDeviceRegistry.open({ home: mkdtempSync(join(tmpdir(), "moss-xc6-card-")), key: await DeviceKey.loadOrCreate(new MemorySecretStore()), clock, self: { name: "Beta", computer: "Beta", os: "macos" } });
    await registry.add({ id: a.id, name: "Alpha", kind: "desktop", runsCore: true, computer: "Alpha", publicKey: a.publicKeyBase64 }, { via: "terminal" });
    askAboutNewProgramKeys({ registry, openCard: async () => ({ card: "c1", allowed: Promise.resolve(false) }) });
    for (const [i, k] of [generateEd25519(), generateEd25519()].entries()) {
      const registration = toBase64(k.sign(enc(programAnswerKeyStatement({ device: a.id, program: "moss", publicKey: b64(k), held: "none" }))));
      const msg: PeerProgramKeys = { keys: [{ program: "moss", publicKey: b64(k), held: "none", registration }], at: i + 1 };
      await registry.applyPeerProgramKeys(a.id, msg, a.sign(programKeysStatement(a.id, msg)));
    }
    await settle();
    expect(registry.pendingProgramKeys()).toHaveLength(1);
  });

  test("the device list shows each computer's keys as four words: this computer's own from its table, a peer's as held here, the card's words for the same key", async () => {
    const w = await world();
    const k1 = generateEd25519();
    await w.send(k1);
    const own = generateEd25519();
    const self = w.registry.self();
    const views = w.registry.list().map((d) => deviceView(d, self.id, undefined, false, [{ program: "host", publicKey: b64(own) }]));
    expect(views.find((v) => v.id === w.a.id)!.keys).toEqual([{ program: "moss", words: answerKeyWords(b64(k1)) }]);
    expect(views.find((v) => v.id === self.id)!.keys).toEqual([{ program: "host", words: answerKeyWords(b64(own)) }]);
    // Four words, and never the key itself.
    expect(JSON.stringify(views)).not.toContain(b64(k1));
  });

  test("the declined list is capped", async () => {
    const w = await world();
    await w.send(generateEd25519());
    for (let i = 0; i < 20; i++) {
      await w.send(generateEd25519());
      await settle();
      await w.press(w.open()[0]!, "deny");
      await settle();
    }
    expect(w.open()).toHaveLength(0);
    // Twenty declined; the list keeps the last sixteen (the file stays bounded).
    const file = JSON.parse(await Bun.file(join(w.dir, "devices", "registry.json")).text()) as { programDeclined?: Record<string, { moss?: string[] }> };
    expect(file.programDeclined?.[w.a.id]?.moss).toHaveLength(16);
  });
});
