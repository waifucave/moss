// `bot.create` from a paired phone (PH3, the owner's decision of 2026-11-24): the same call and the same checks as the desktop's,
// only while the registry still holds the phone with an answer key. Every refusal is the desktop's own or the gate's.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import type { Caller } from "@waifucave/moss-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { pairedPhone } from "../../agents/tests/phone";
import { instructionsFile } from "../records";
import { boot, removeTemps, tempDir } from "./fixtures";

afterEach(removeTemps);

const DESKTOP: Caller = { kind: "user", client: "app" };

async function setup(o: { answerKey?: boolean; gate?: boolean } = {}) {
  const clock = new FakeClock();
  const home = tempDir();
  const phone = await pairedPhone(clock, o.answerKey === undefined ? {} : { answerKey: o.answerKey });
  const b = await boot({ home, clock, plugins: [], botSource: "records", modelOffer: (m) => (m === "acme/unset" ? "absent" : "offered") });
  const all = b.side.methods({ localDevice: "studio0000000000000", ...(o.gate === false ? {} : { phoneMay: phone.mayStart }) });
  const create = (params: unknown, caller: Caller) => all["bot.create"]!(params, { caller } as never) as Promise<{ bot: { id: string; madeBy: unknown } }>;
  const bots = () => (existsSync(`${home}/bots`) ? readdirSync(`${home}/bots`).sort() : []);
  return { b, home, phone, create, bots };
}

describe("bot.create from a phone", () => {
  test("a paired phone with an answer key makes a bot the way the desktop does: the same record, made by the user", async () => {
    const s = await setup();
    const fromPhone = await s.create({ name: "Nova", instructions: "You are Nova.", model: "acme/large", face: { color: "lagoon" } }, s.phone.caller());
    const fromDesktop = await s.create({ name: "Nova", instructions: "You are Nova.", model: "acme/large", face: { color: "lagoon" } }, DESKTOP);
    expect(fromPhone.bot).toMatchObject({ id: "nova", model: "acme/large", face: { color: "lagoon" }, madeBy: { kind: "user" }, instructionsBytes: 13 });
    expect(fromDesktop.bot).toMatchObject({ id: "nova-2", madeBy: { kind: "user" } });
    expect(await Bun.file(instructionsFile(s.home, "nova")).text()).toBe("You are Nova.");
    await s.b.shutdown();
  });

  test("an Android phone is held to the same gate", async () => {
    const s = await setup();
    expect((await s.create({ name: "Droid" }, s.phone.caller("android"))).bot.id).toBe("droid");
    await s.b.shutdown();
  });

  test("the name and model checks are the desktop's: the same refusal, from either, and nothing is made", async () => {
    const s = await setup();
    for (const params of [{ name: "" }, { name: "x".repeat(10_000) }, { name: "Odd", model: "acme/unset" }]) {
      const desk = await s.create(params, DESKTOP).then(() => "made", (e: Error) => e.message);
      const phone = await s.create(params, s.phone.caller()).then(() => "made", (e: Error) => e.message);
      expect(desk).not.toBe("made");
      expect(phone).toBe(desk);
    }
    expect(s.bots()).toEqual([]);
    await s.b.shutdown();
  });

  test("a revoked phone, a phone with no answer key, a device the registry doesn't know, a call naming no device, and an engine with no gate are refused, and nothing is made", async () => {
    const revoked = await setup();
    await revoked.phone.revoke();
    await expect(revoked.create({ name: "Nova" }, revoked.phone.caller())).rejects.toThrow(/isn't paired with an answer key/);
    expect(revoked.bots()).toEqual([]);
    await revoked.b.shutdown();

    const keyless = await setup({ answerKey: false });
    await expect(keyless.create({ name: "Nova" }, keyless.phone.caller())).rejects.toThrow(/answer key/);
    expect(keyless.bots()).toEqual([]);
    await keyless.b.shutdown();

    const s = await setup();
    await expect(s.create({ name: "Nova" }, { kind: "user", client: "ios", device: "z".repeat(32) })).rejects.toThrow(/answer key/);
    await expect(s.create({ name: "Nova" }, { kind: "user", client: "ios" } as Caller)).rejects.toThrow(/answer key/);
    await s.b.shutdown();

    const ungated = await setup({ gate: false });
    await expect(ungated.create({ name: "Nova" }, ungated.phone.caller())).rejects.toThrow(/answer key/);
    await ungated.b.shutdown();
  });

  test("a revocation between two calls ends the next one: the registry is read per call", async () => {
    const s = await setup();
    await s.create({ name: "One" }, s.phone.caller());
    await s.phone.revoke();
    await expect(s.create({ name: "Two" }, s.phone.caller())).rejects.toThrow(/answer key/);
    expect(s.bots()).toEqual(["one"]);
    await s.b.shutdown();
  });

  test("every other kind of caller is refused: a bot, an agent, a plugin, a peer and the engine itself", async () => {
    const s = await setup();
    for (const caller of [
      { kind: "plugin", pluginId: "spy" }, { kind: "peer", device: "d1" },
      { kind: "session", sessionId: "b_x", sessionKind: "bot", bot: "x" }, { kind: "session", sessionId: "a_1", sessionKind: "agent", bot: "x" },
      { kind: "core" },
    ] as Caller[]) await expect(s.create({ name: "Rogue" }, caller)).rejects.toThrow();
    expect(s.bots()).toEqual([]);
    await s.b.shutdown();
  });
});
