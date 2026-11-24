// A card about a paired device (the "Revoke this device?" card, a removal's cosign) never reaches that device and can't be answered by it:
// not listed, not read, not sent as an event (nor replayed to a connection that subscribes late), and refused at the engine by the answering
// device's id. Another device sees and answers it as before.
import { describe, expect, test } from "bun:test";
import type { Caller, MossRole } from "@waifucave/moss-protocol";
import { approvalCoreEvents } from "../../src/approvals/core-events";
import { cardMethods } from "../../src/approvals/card-methods";
import { MossApprovalBroker } from "../../src/approvals/broker";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { deviceOfConn, sendCoreEvent } from "../../src/ipc/core-events";
import type { MossConn } from "../../src/ipc/moss";

const LOST = "lost-phone-device-01";
const MINE = "mine-phone-device-01";

const revoke = (about?: string): ApprovalRequest => ({
  kind: "change", origin: "user", computers: [], effect: "other", change: "device-revoke", ...(about === undefined ? {} : { aboutDevice: about }),
  fields: { title: { type: "text", text: "Revoke this device?" } },
});
const conn = (role: MossRole, caller: Caller, areas = ["approvals"]): MossConn & { got: unknown[] } => {
  const got: unknown[] = [];
  return { role, caller, areas: new Set(areas), notify: (_m: string, p: unknown) => void got.push(p), got } as unknown as MossConn & { got: unknown[] };
};
const phone = (device: string) => conn("remote", { kind: "user", client: "ios", device });

async function raised(broker: MossApprovalBroker, req: ApprovalRequest) {
  const decided = broker.request(req);
  await Promise.resolve();
  return { card: broker.cards().at(-1)!, decided };
}

describe("a card about a device", () => {
  test("the events go to every connection but that device's, resolved too; the replay to a late subscriber leaves it out", async () => {
    const broker = new MossApprovalBroker({ clock: new FakeClock() });
    const lost = phone(LOST), mine = phone(MINE), app = conn("app", { kind: "user", client: "app" });
    const r = { connections: () => [lost, mine, app][Symbol.iterator](), now: () => 1 };
    const off = approvalCoreEvents(broker, (event, opts) => sendCoreEvent(r, event, opts), () => 1);
    const { card } = await raised(broker, revoke(LOST));
    expect(lost.got).toEqual([]);
    expect(mine.got.map((e) => (e as { type: string }).type)).toEqual(["card_requested"]);
    expect(app.got.map((e) => (e as { type: string }).type)).toEqual(["card_requested"]);
    // Answered by another device: the lost phone isn't told that either.
    await broker.answer(card.id, { optionId: card.options[0]!.id, hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at: 1 } }, { role: "app" });
    expect(lost.got).toEqual([]);
    expect(mine.got.map((e) => (e as { type: string }).type)).toEqual(["card_requested", "card_resolved"]);
    // A card about no device goes to all.
    await raised(broker, revoke());
    expect(lost.got.map((e) => (e as { type: string }).type)).toEqual(["card_requested"]);
    off();
    expect(deviceOfConn(lost)).toBe(LOST);
    expect(deviceOfConn(app)).toBeUndefined();
  });

  test("card.list and card.get hide it from that device, card.answer refuses it by its id; another device sees and answers it", async () => {
    const clock = new FakeClock();
    const broker = new MossApprovalBroker({ clock, verify: () => true });
    const methods = cardMethods(() => broker);
    const { card, decided } = await raised(broker, revoke(LOST));
    const lost = phone(LOST), mine = phone(MINE);
    expect(((await methods["card.list"]!(lost, {})) as { cards: unknown[] }).cards).toEqual([]);
    expect(((await methods["card.list"]!(mine, {})) as { cards: { id: string }[] }).cards.map((c) => c.id)).toEqual([card.id]);
    await expect(methods["card.get"]!(lost, { id: card.id }) as Promise<unknown>).rejects.toThrow(/no card/);
    expect(((await methods["card.get"]!(mine, { id: card.id })) as { card: { id: string } }).card.id).toBe(card.id);
    const proof = (device: string) => ({ via: "device" as const, device, at: clock.now(), signature: "AAAA" });
    // The verifier here says yes to everything: it is the engine's own id check that refuses.
    expect(await methods["card.answer"]!(lost, { id: card.id, hash: card.hash, option: "deny", proof: proof(LOST) })).toMatchObject({ accepted: false });
    expect(broker.cards().map((c) => c.id)).toEqual([card.id]);
    expect(await methods["card.answer"]!(mine, { id: card.id, hash: card.hash, option: card.options[0]!.id, proof: proof(MINE) })).toEqual({ accepted: true });
    await expect(decided).resolves.toMatchObject({ allowed: true });
    // Read after it resolved: still not the lost phone's.
    await expect(methods["card.get"]!(lost, { id: card.id }) as Promise<unknown>).rejects.toThrow(/no card/);
  });

  test("a card only a computer answers: no phone is sent, listed or shown it (the named one, its other app, another phone), a computer and this computer's app are; the asking phone is", async () => {
    const kinds: Record<string, string> = { [LOST]: "phone", [MINE]: "phone", "second-phone-device-01": "phone", "laptop-desktop-device-01": "desktop" };
    const broker = new MossApprovalBroker({ clock: new FakeClock(), verify: () => true, deviceKind: (id) => kinds[id] });
    const methods = cardMethods(() => broker);
    const lost = phone(LOST), mine = phone(MINE), second = phone("second-phone-device-01");
    const laptop = conn("remote", { kind: "user", client: "app", device: "laptop-desktop-device-01" }), app = conn("app", { kind: "user", client: "app" });
    const r = { connections: () => [lost, mine, second, laptop, app][Symbol.iterator](), now: () => 1 };
    const off = approvalCoreEvents(broker, (event, opts) => sendCoreEvent(r, event, opts), () => 1);
    const { card, decided } = await raised(broker, { ...revoke(LOST), computersOnly: {} });
    const types = (c: { got: unknown[] }) => c.got.map((e) => (e as { type: string }).type);
    for (const c of [lost, mine, second]) expect(c.got).toEqual([]);
    expect(types(laptop)).toEqual(["card_requested"]);
    expect(types(app)).toEqual(["card_requested"]);
    for (const c of [lost, mine, second]) {
      expect(((await methods["card.list"]!(c, {})) as { cards: unknown[] }).cards).toEqual([]);
      await expect(methods["card.get"]!(c, { id: card.id }) as Promise<unknown>).rejects.toThrow(/no card/);
    }
    expect(((await methods["card.list"]!(laptop, {})) as { cards: { id: string }[] }).cards.map((c) => c.id)).toEqual([card.id]);
    const proof = (device: string) => ({ via: "device" as const, device, at: 0, signature: "AAAA" });
    // The other app of the same phone answers on its own link: refused, though the verifier says yes to everything.
    expect(await methods["card.answer"]!(mine, { id: card.id, hash: card.hash, option: "deny", proof: proof(MINE) })).toMatchObject({ accepted: false });
    expect(broker.cards().map((c) => c.id)).toEqual([card.id]);
    // The computer's own app answers; not one phone heard it resolved either.
    await broker.answer(card.id, { optionId: card.options[0]!.id, hash: card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card.id)!, input: "click", at: 1 } }, { role: "app" });
    await expect(decided).resolves.toMatchObject({ allowed: true });
    for (const c of [lost, mine, second]) expect(c.got).toEqual([]);
    expect(types(laptop)).toEqual(["card_requested", "card_resolved"]);
    // A card a phone's own request raised is that phone's too.
    const own = await raised(broker, { ...revoke(LOST), computersOnly: { askedBy: MINE } });
    expect(types(mine)).toEqual(["card_requested"]);
    expect(((await methods["card.list"]!(mine, {})) as { cards: { id: string }[] }).cards.map((c) => c.id)).toEqual([own.card.id]);
    expect(((await methods["card.list"]!(second, {})) as { cards: unknown[] }).cards).toEqual([]);
    off();
  });
});
