// A paired phone starts a coding session on the computer it is linked to (the owner's decision of 2026-11-24: any folder; the
// phone names it; a start raises the same cards as the desktop's, answered on the phone). The call is `agent.start`, the one the
// desktop app uses for a person's own start, with the checks a phone adds: still paired and holding an answer key, this computer
// and no other. What it is NOT is tested too: no bot's agent, no other computer, no revoked or keyless phone, no looser folder.
// Over the real manager and the scripted agent (`World`), the real approval broker contract's fake with the real device-proof
// verifier over a device registry holding the phone, and the real `agentMethods`.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import { makeFakePhone } from "../../contracts/fakes/device-registry";
import { agentMethods, PHONE_LOOK_TTL_MS } from "../rpc";
import { pairedPhone, type TestPhone } from "./phone";
import { waitFor, World, type WorldOptions } from "./world";

setDefaultTimeout(60_000);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const DESKTOP: Caller = { kind: "user", client: "app" };
const LOCAL = "l".repeat(32);

async function make(o: WorldOptions & { phone?: Parameters<typeof pairedPhone>[1] } = {}) {
  const { phone: phoneOpts, ...worldOpts } = o;
  // The phone's registry needs the world's clock, which exists once the world does: a world made first, the phone's verifier read by it later.
  let verify: TestPhone["verify"] | undefined;
  const w = (world = new World({ ...worldOpts, verify: (card, answer, from) => (verify === undefined ? false : verify(card, answer, from)) }));
  const p = await pairedPhone(w.clock, phoneOpts);
  verify = p.verify;
  const remembered: unknown[] = [];
  const optionCalls: string[] = [];
  const listed = backends(w);
  const methods = agentMethods({
    manager: w.manager, backends: () => listed, now: () => w.clock.now(), computer: w.computer, localDevice: () => LOCAL, phoneMayStart: p.mayStart,
    startOptions: { options: async (b: string) => { optionCalls.push(b); return { backend: b, known: true, source: "catalog", models: [{ id: "m1", name: "M1", efforts: ["low", "high"] }] }; }, recent: () => ({ backend: "fake", computer: "Studio", roots: [{ root: "home/Studio/project1", at: 5 }] }), remember: (...a: unknown[]) => void remembered.push(a) } as never,
  });
  const start = (caller: Caller, params: Record<string, unknown>) => methods["agent.start"]!({ backend: "fake", computer: w.computer, root: "home/Studio/project1", prompt: "go", ...params }, { caller }) as Promise<{ session: string }>;
  const refusal = async (caller: Caller, params: Record<string, unknown>) => start(caller, params).then(() => undefined, (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }));
  return { w, p, start, refusal, remembered, methods, optionCalls, detects };
}

/** What the world's backend says of itself, counted: a version line that is the program's own output (with a path in it), and one
 *  backend a person can't start (MOSS's own subagents'). */
let detects = 0;
function backends(w: World) {
  detects = 0;
  const shown = Object.create(w.backend, { detect: { value: async () => { detects++; return { installed: true, sandboxed: true, version: "claude 2.1.316 (/Users/someone/.local/bin/claude)" }; } } });
  const hidden = Object.create(w.backend, { id: { value: "subagents" }, userStartable: { value: false }, detect: { value: async () => { detects++; return { installed: true, sandboxed: true, version: "1" }; } } });
  return [shown, hidden];
}

const coding = (w: World) => w.host.list({ kind: "coding" });

describe("a phone's start in a folder the computer has never run a session in", () => {
  test("raises the no-sandbox OK card as the desktop's start does; nothing runs until the phone's signed answer; a forged one is refused", async () => {
    const { w, p, start } = await make({ sandbox: "none", script: [[{ say: "hello from the phone's session" }]] });
    mkdirSync(join(w.userHome, "brand-new-folder"), { recursive: true });
    const { session } = await start(p.caller(), { root: "home/Studio/brand-new-folder" });
    // The session is a person's own coding session on this computer, started by the phone's device: no bot, no parent.
    const view = w.host.get(session)!;
    expect(view).toMatchObject({ kind: "coding", computer: "Studio", root: "home/Studio/brand-new-folder" });
    expect(view.bot).toBeUndefined();
    expect(view.parent).toBeUndefined();
    const first = w.host.history(session).find((r) => r.type === "input");
    expect(first).toMatchObject({ input: { from: "user", device: p.phone.id, text: "go" } });
    // The card the desktop's start raises: the OK for an agent with no sandbox MOSS counts on, on this session.
    const card = await waitFor(() => w.approvals.cards()[0], "the OK card");
    expect(card).toMatchObject({ kind: "change", change: "agent-unsandboxed", session });
    // The phone sees it as it sees every card (`card.list`, the user's own), and answers it with `card.answer` on its connection.
    expect((await p.cards(w)).cards.map((c) => c.id)).toEqual([card.id]);
    expect(w.report("started")).toEqual([]);
    // A signature by any key but the phone's answer key is no answer; the app's sealed frame is not the phone's to give; and the
    // phone's own signature on the deny option does not approve.
    const stranger = await makeFakePhone();
    expect(await p.answer(w, card, "approve", stranger)).toEqual({ accepted: false, reason: "the answer's signature didn't check out" });
    expect(await p.answer(w, card, "approve", undefined, { via: "sealed-frame", frame: "forged", input: "click", at: w.clock.now() })).toEqual({ accepted: false, reason: "the answer can't come from here" });
    // Another device's id on the proof, over the phone's connection: refused before the broker.
    expect(await p.answer(w, card, "approve", undefined, { via: "device", device: stranger.id, at: w.clock.now(), signature: "AAAA" })).toEqual({ accepted: false, reason: "the answer can't come from here" });
    expect(w.report("started")).toEqual([]);
    // The phone's signed approve: the agent starts and the turn the phone's prompt asked for runs.
    expect(await p.answer(w, card, "approve")).toEqual({ accepted: true });
    await waitFor(() => w.report("started")[0], "the agent starting");
    await waitFor(() => w.host.history(session).some((r) => r.type === "turn_ended") || undefined, "the turn's end");
  });

  test("the phone's no ends it: the agent never starts", async () => {
    const { w, p, start } = await make({ sandbox: "none", script: [[{ say: "never" }]] });
    const { session } = await start(p.caller("android"), {});
    const card = await waitFor(() => w.approvals.cards()[0], "the OK card");
    expect(await p.answer(w, card, "deny")).toEqual({ accepted: true });
    await waitFor(() => w.host.get(session)?.status === "stopped" || w.host.get(session)?.status === "failed" || w.host.history(session).some((r) => r.type === "turn_ended") || undefined, "the start ending");
    expect(w.report("started")).toEqual([]);
  });
});

describe("the cards a phone's start raises are the desktop's", () => {
  /** A card without what differs by session and moment: its id, hash, session, its time and the pieces derived from them. */
  const shape = (c: { [k: string]: unknown }) => JSON.parse(JSON.stringify({ ...c, id: undefined, hash: undefined, session: undefined, createdAt: undefined, expiresAt: undefined, at: undefined, ts: undefined, options: (c.options as { id: string }[]).map((o) => ({ ...o, id: undefined })) }));

  test("the no-sandbox OK (an agent MOSS can't count on, asked once per version and computer): the same card, word for word, from either", async () => {
    const seen: unknown[] = [];
    for (const who of ["desktop", "phone"] as const) {
      const { w, p, start } = await make({ sandbox: "none", script: [[{ say: "x" }]] });
      await start(who === "desktop" ? DESKTOP : p.caller(), {});
      const card = await waitFor(() => w.approvals.cards()[0], "the OK card");
      seen.push(shape(card as never));
      await world?.close();
      world = undefined;
    }
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0]).toMatchObject({ kind: "change", change: "agent-unsandboxed" });
  });

  test("an agent MOSS counts on (its own sandbox admitted) raises no card from either, and both sessions run", async () => {
    const { w, p, start } = await make({ script: [[{ say: "one" }], [{ say: "two" }]] });
    const a = await start(DESKTOP, {});
    const b = await start(p.caller(), {});
    await waitFor(() => w.host.history(a.session).some((r) => r.type === "turn_ended") && w.host.history(b.session).some((r) => r.type === "turn_ended") || undefined, "both turns' ends");
    expect(w.approvals.cards()).toEqual([]);
  });
});

describe("what a phone's sheet reads: agent.backends, agent.options, agent.recent", () => {
  const asked = (methods: Record<string, (p: unknown, c: { caller: Caller }) => Promise<unknown>>, name: string, caller: Caller, params: Record<string, unknown> = {}) => methods[name]!(params, { caller });

  test("the desktop gets every backend with its version line; the phone gets only those a person can start, without the version line", async () => {
    const { p, methods } = await make();
    type Out = { backends: { id: string; pluginId: string; userStartable: boolean; computers: { computer: string; installed: boolean; sandboxed?: boolean; marks: string[]; version?: string }[] }[] };
    const desktop = await asked(methods, "agent.backends", DESKTOP) as Out;
    const phone = await asked(methods, "agent.backends", p.caller()) as Out;
    expect(desktop.backends.map((b) => b.id)).toEqual(["fake", "subagents"]);
    expect(desktop.backends[0]!.computers[0]!.version).toContain("/Users/someone/.local/bin/claude");
    expect(phone.backends.map((b) => b.id)).toEqual(["fake"]);
    // Kept: what draws the choice and says what a start will ask (its name, look, placement, whether it is installed and sandboxed, its marks).
    expect(phone.backends[0]).toMatchObject({ id: "fake", userStartable: true, computers: [{ computer: "Studio", installed: true, sandboxed: true }] });
    expect(Array.isArray(phone.backends[0]!.computers[0]!.marks)).toBe(true);
    // Cut: the program's own version line, which here carries a path on disk.
    expect("version" in phone.backends[0]!.computers[0]!).toBe(false);
    const text = JSON.stringify(phone);
    for (const secret of ["/Users/someone", ".local/bin", "claude 2.1.316"]) expect([secret, text.includes(secret)]).toEqual([secret, false]);
    // The answer carries no path, digest or address of any kind.
    expect(text).not.toMatch(/https?:\/\/|sha256|\/home\/|\\\\|[A-Za-z]:\\/);
  });

  test("a phone's reads of backends and options look at the programs once in 30 seconds; recent is read fresh; the desktop is never held to it", async () => {
    const { w, p, methods, optionCalls } = await make();
    await asked(methods, "agent.backends", p.caller());
    await asked(methods, "agent.backends", p.caller("android"));
    expect(detects).toBe(2); // one look at the two backends, the second answer reused
    await asked(methods, "agent.options", p.caller(), { backend: "fake" });
    await asked(methods, "agent.options", p.caller(), { backend: "fake" });
    expect(optionCalls).toEqual(["fake"]);
    await asked(methods, "agent.options", p.caller(), { backend: "other" });
    expect(optionCalls).toEqual(["fake", "other"]);
    w.clock.advance(PHONE_LOOK_TTL_MS + 1);
    await asked(methods, "agent.backends", p.caller());
    await asked(methods, "agent.options", p.caller(), { backend: "fake" });
    expect(detects).toBe(4);
    expect(optionCalls).toEqual(["fake", "other", "fake"]);
    await asked(methods, "agent.backends", DESKTOP);
    await asked(methods, "agent.backends", DESKTOP);
    expect(detects).toBe(8);
  });

  test("options and recent: the phone is told what the desktop is, and its own starts change neither", async () => {
    const { p, methods, start, remembered } = await make();
    expect(await asked(methods, "agent.options", p.caller(), { backend: "fake" })).toEqual(await asked(methods, "agent.options", DESKTOP, { backend: "fake" }));
    const before = await asked(methods, "agent.recent", p.caller());
    expect(before).toEqual({ backend: "fake", computer: "Studio", roots: [{ root: "home/Studio/project1", at: 5 }] });
    expect(before).toEqual(await asked(methods, "agent.recent", DESKTOP));
    await start(p.caller(), { model: "m1" });
    expect(remembered).toEqual([]); // the phone's own start is not remembered: nothing of it reaches the desktop's start page
    expect(await asked(methods, "agent.recent", p.caller())).toEqual(before);
  });

  test("a revoked phone, a phone with no answer key and a connection with no device read nothing; a label added later is held to the same rule", async () => {
    const live = await make();
    await live.p.revoke();
    for (const name of ["agent.backends", "agent.options", "agent.recent"]) {
      const params = name === "agent.options" ? { backend: "fake" } : {};
      for (const caller of [live.p.caller(), { kind: "user", client: "ios" } as Caller, { kind: "user", client: "web", device: live.p.phone.id } as unknown as Caller]) {
        await expect(asked(live.methods, name, caller, params)).rejects.toMatchObject({ code: "refused" });
      }
    }
    await world?.close();
    world = undefined;
    const keyless = await make({ phone: { answerKey: false } });
    await expect(asked(keyless.methods, "agent.backends", keyless.p.caller())).rejects.toMatchObject({ code: "refused" });
    // The app and the terminal are not held to any of it.
    await expect(asked(keyless.methods, "agent.backends", DESKTOP)).resolves.toBeDefined();
    await expect(asked(keyless.methods, "agent.recent", { kind: "user", client: "cli" } as Caller)).resolves.toBeDefined();
  });
});

describe("what a phone's start is not", () => {
  test("never a bot's agent: the bot, parent and level a caller may add are not read, and a session, plugin or peer caller is refused", async () => {
    const { w, p, start, refusal } = await make({ script: [[{ say: "ok" }]] });
    const { session } = await start(p.caller(), { bot: "alpha", parent: "s_alpha", session: "s_alpha", level: "automatic", kind: "agent", startedBy: { kind: "bot", bot: "alpha" } });
    const view = w.host.get(session)!;
    expect(view.kind).toBe("coding");
    expect(view.bot).toBeUndefined();
    expect(view.parent).toBeUndefined();
    expect(view.startedBy ?? { kind: "user" }).toEqual({ kind: "user" });
    expect(w.host.list({ kind: "agent" })).toEqual([]);
    for (const caller of [{ kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" }, { kind: "plugin", pluginId: "somebody" }, { kind: "peer", device: p.phone.id }] as Caller[]) {
      expect(await refusal(caller, {})).toMatchObject({ code: "refused", message: expect.stringContaining("only the user") });
    }
    expect(coding(w)).toHaveLength(1);
  });

  test("never another computer: a phone naming one is refused before anything opens; the desktop's own door to another computer is the desktop's", async () => {
    const { w, p, refusal } = await make({ otherComputers: { Laptop: "/nowhere" } });
    const named = await refusal(p.caller(), { computer: "Laptop", root: "home/Laptop/project1" });
    expect(named).toMatchObject({ code: "refused", message: expect.stringContaining("linked to (Studio)") });
    expect(coding(w)).toEqual([]);
    // The root on another computer under this computer's name: the manager's own refusal, the same as the desktop's.
    const mixed = await refusal(p.caller(), { root: "home/Laptop/project1" });
    const desktop = await refusal(DESKTOP, { root: "home/Laptop/project1" });
    expect(mixed).toEqual(desktop);
    expect(mixed?.message).not.toContain("linked to");
    // The phone's refusal is the phone's own; the desktop naming Laptop is not met by it.
    expect((await refusal(DESKTOP, { computer: "Laptop", root: "home/Laptop/project1" }))?.message ?? "").not.toContain("linked to");
    expect(coding(w)).toEqual([]);
  });

  test("a revoked phone, a phone with no answer key, an unknown device and a connection with no device are refused; nothing opens", async () => {
    const live = await make();
    const { w, p, start, refusal } = live;
    await start(p.caller(), {});
    expect(coding(w)).toHaveLength(1);
    await p.revoke();
    // The registry's word at the moment of the call: a connection that outlived the revocation by a moment gets nothing.
    expect(await refusal(p.caller(), {})).toMatchObject({ code: "refused", message: expect.stringContaining("isn't paired with an answer key") });
    expect(await refusal(p.caller("android"), {})).toMatchObject({ code: "refused" });
    expect(await refusal({ kind: "user", client: "ios", device: "u".repeat(32) } as Caller, {})).toMatchObject({ code: "refused" });
    expect(await refusal({ kind: "user", client: "ios" } as Caller, {})).toMatchObject({ code: "refused" });
    expect(coding(w)).toHaveLength(1);
    await world?.close();
    world = undefined;
    const keyless = await make({ phone: { answerKey: false } });
    expect(await keyless.refusal(keyless.p.caller(), {})).toMatchObject({ code: "refused" });
    expect(coding(keyless.w)).toEqual([]);
  });

  test("a phone that is no longer in the engine's registry at all (no `phoneMayStart` wired) starts nothing", async () => {
    const w = (world = new World({}));
    const methods = agentMethods({ manager: w.manager, backends: () => [w.backend], computer: w.computer, localDevice: () => LOCAL });
    const caller = { kind: "user", client: "ios", device: "p".repeat(32) } as Caller;
    await expect(methods["agent.start"]!({ backend: "fake", computer: "Studio", root: "home/Studio/project1" }, { caller })).rejects.toMatchObject({ code: "refused" });
    expect(coding(w)).toEqual([]);
  });
});

describe("the folder is validated as the desktop's start validates it, and no looser", () => {
  test("the same refusals, word for word, for the MOSS home, a folder that isn't there, a file path, a path out of the tree and a path through ..", async () => {
    const { w, p, refusal } = await make();
    mkdirSync(join(w.userHome, "docs", "inner"), { recursive: true });
    const roots = [
      "home/Studio/.moss", "home/Studio/.moss/run", "home/Studio/not-there", "home/Studio/project1/../.moss", "home/Studio/docs/../../outside",
      "/etc", "etc", "../escape", "home/NoSuchComputer/project1", "home", "",
    ];
    for (const root of roots) {
      const fromPhone = await refusal(p.caller(), { root });
      const fromDesktop = await refusal(DESKTOP, { root });
      expect([root, fromPhone]).toEqual([root, fromDesktop]);
      expect([root, fromPhone === undefined]).toEqual([root, false]);
    }
    // And a folder both accept, both start in.
    const a = await refusal(p.caller(), { root: "home/Studio/docs/inner" });
    const b = await refusal(DESKTOP, { root: "home/Studio/docs/inner" });
    expect([a, b]).toEqual([undefined, undefined]);
    expect(coding(w).map((v) => v.root)).toEqual(["home/Studio/docs/inner", "home/Studio/docs/inner"]);
  });

  test("a symlink out of the home or into the MOSS home is held to the real folder it leads to, for both", async () => {
    const { w, p, refusal } = await make();
    const { symlinkSync } = await import("node:fs");
    symlinkSync(w.mossHome, join(w.userHome, "into-moss"));
    const fromPhone = await refusal(p.caller(), { root: "home/Studio/into-moss" });
    const fromDesktop = await refusal(DESKTOP, { root: "home/Studio/into-moss" });
    expect(fromPhone).toEqual(fromDesktop);
    expect(fromPhone).toMatchObject({ code: "fenced" });
    expect(coding(w)).toEqual([]);
  });

  test("the model and effort a phone names, and a backend that isn't startable by a person, are the desktop's rules; the phone's start is not the person's `last start`", async () => {
    const { w, p, start, refusal, remembered } = await make();
    expect(await refusal(p.caller(), { backend: "no-such-backend" })).toEqual(await refusal(DESKTOP, { backend: "no-such-backend" }));
    await start(DESKTOP, {});
    await start(p.caller(), { model: "m1", effort: "high" });
    // The desktop's start is remembered for the start page of any client; the phone's is not.
    expect(remembered).toHaveLength(1);
    expect(coding(w)).toHaveLength(2);
  });
});
