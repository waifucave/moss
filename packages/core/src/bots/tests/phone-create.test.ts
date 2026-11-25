// `bot.create` from a paired phone (PH3, the owner's decision of 2026-11-24): the same call and the same checks as the desktop's,
// only while the registry still holds the phone with an answer key. Every refusal is the desktop's own or the gate's.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PHONE_BOT_CREATES_PER_DAY, type Caller } from "@waifucave/moss-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { pairedPhone } from "../../agents/tests/phone";
import { instructionsFile } from "../records";
import { boot, removeTemps, tempDir } from "./fixtures";

afterEach(removeTemps);

const DESKTOP: Caller = { kind: "user", client: "app" };

async function setup(o: { answerKey?: boolean; gate?: boolean; second?: boolean } = {}) {
  const clock = new FakeClock();
  const home = tempDir();
  const phone = await pairedPhone(clock, o.answerKey === undefined ? {} : { answerKey: o.answerKey });
  const other = o.second === true ? await pairedPhone(clock, { os: "android" }) : undefined;
  const b = await boot({ home, clock, plugins: [], botSource: "records", modelOffer: (m) => (m === "acme/unset" ? "absent" : "offered") });
  const all = b.side.methods({ localDevice: "studio0000000000000", ...(o.gate === false ? {} : { phoneMay: (d: string) => phone.mayStart(d) || other?.mayStart(d) === true }) });
  const create = (params: unknown, caller: Caller) => all["bot.create"]!(params, { caller } as never) as Promise<{ bot: { id: string; madeBy: unknown } }>;
  const bots = () => (existsSync(`${home}/bots`) ? readdirSync(`${home}/bots`).sort() : []);
  return { b, home, phone, other, create, bots, clock };
}

describe("bot.create from a phone", () => {
  test("a paired phone with an answer key makes a bot the way the desktop does with a name and a model: the same record, made by the user", async () => {
    const s = await setup();
    const fromPhone = await s.create({ name: "Nova", model: "acme/large" }, s.phone.caller());
    const fromDesktop = await s.create({ name: "Nova", model: "acme/large" }, DESKTOP);
    expect(fromPhone.bot).toMatchObject({ id: "nova", model: "acme/large", madeBy: { kind: "user" } });
    expect(fromDesktop.bot).toMatchObject({ id: "nova-2", model: "acme/large", madeBy: { kind: "user" } });
    expect({ ...fromPhone.bot, id: "", mainSession: "" }).toEqual({ ...fromDesktop.bot, id: "", mainSession: "" });
    await s.b.shutdown();
  });

  test("a phone that carries anything but the name and the model is refused, not trimmed: instructions, effort and a face each, and nothing is made; the desktop's own create still takes them", async () => {
    const s = await setup();
    for (const [extra, word] of [
      [{ instructions: "You are Nova." }, "instructions"], [{ instructions: "" }, "instructions"], [{ effort: "high" }, "effort"],
      [{ face: { color: "lagoon" } }, "face"], [{ instructions: "x", effort: "low", face: { color: "sky" } }, "instructions and effort and face"],
    ] as const) {
      await expect(s.create({ name: "Nova", model: "acme/large", ...extra }, s.phone.caller())).rejects.toThrow(`a phone makes a bot with a name and a model only; set the ${word} on the desktop`);
    }
    expect(s.bots()).toEqual([]);
    // The desktop's call is unchanged: the same params make the same bot there.
    const desk = await s.create({ name: "Nova", instructions: "You are Nova.", model: "acme/large", effort: "high", face: { color: "lagoon" } }, DESKTOP);
    expect(desk.bot).toMatchObject({ id: "nova", model: "acme/large", effort: "high", face: { color: "lagoon" }, instructionsBytes: 13 });
    expect(await Bun.file(instructionsFile(s.home, "nova")).text()).toBe("You are Nova.");
    await s.b.shutdown();
  });

  test("a phone makes at most five bots in 24 hours: the sixth is refused with a time to try again, the cap is per device and not the desktop's, and it frees as the day moves", async () => {
    const s = await setup({ second: true });
    const other = s.other!;
    for (let i = 1; i <= PHONE_BOT_CREATES_PER_DAY; i++) {
      await s.create({ name: `Bot ${i}` }, s.phone.caller());
      s.clock.advance(60_000);
    }
    await expect(s.create({ name: "Bot 6" }, s.phone.caller())).rejects.toThrow(/made 5 bots in the last 24 hours.*try again in \d+ (min|h)/);
    expect(s.bots()).toHaveLength(5);
    // Another phone has its own count; the desktop has none.
    expect((other.caller("android") as { device: string }).device).not.toBe((s.phone.caller() as { device: string }).device);
    await s.create({ name: "Other phone" }, other.caller("android"));
    for (let i = 0; i < 7; i++) await s.create({ name: `Desk ${i}` }, DESKTOP);
    // The oldest make leaves the window after 24 hours: one more is let through, not two.
    s.clock.advance(24 * 3600_000 - 5 * 60_000 + 1);
    await s.create({ name: "Bot 6" }, s.phone.caller());
    await expect(s.create({ name: "Bot 7" }, s.phone.caller())).rejects.toThrow(/made 5 bots/);
    await s.b.shutdown();
  });

  test("a make that comes to nothing costs no slot, and the count survives a restart of the engine", async () => {
    const s = await setup();
    for (let i = 0; i < 8; i++) await expect(s.create({ name: "Odd", model: "acme/unset" }, s.phone.caller())).rejects.toThrow();
    for (let i = 1; i <= 4; i++) await s.create({ name: `Bot ${i}` }, s.phone.caller());
    // The engine's restart: a new bot side over the same home reads the same file.
    await s.b.shutdown();
    const again = await boot({ home: s.home, clock: s.clock, plugins: [], botSource: "records" });
    const all = again.side.methods({ localDevice: "studio0000000000000", phoneMay: s.phone.mayStart });
    const create = (params: unknown) => all["bot.create"]!(params, { caller: s.phone.caller() } as never) as Promise<unknown>;
    await create({ name: "Bot 5" });
    await expect(create({ name: "Bot 6" })).rejects.toThrow(/made 5 bots/);
    expect(JSON.parse(readFileSync(`${s.home}/transcripts/.phone-bot-creates.json`, "utf8")).devices[(s.phone.caller() as { device: string }).device]).toHaveLength(5);
    await again.shutdown();
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
