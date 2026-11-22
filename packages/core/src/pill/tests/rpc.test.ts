// `user.send` (../rpc.ts), called as the server calls it: the user's words from the Dispatch pill reach a bot's
// conversation or a session through lane D's session.send, a pill.target entry's handler as the plugin's own call, and
// only the user may send them.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_FILES_MAX, BOT_FILE_MAX_BYTES } from "@waifucave/moss-protocol";
import { APP_METHODS, MOSS_ERR, ERR, allowedMethods, type Caller, type MethodSpec } from "@waifucave/moss-protocol";
import type { z } from "zod";
import { flush } from "../../contracts/fakes/clock";
import type { Contribution } from "../../contracts/plugin-registry";
import type { InvokeRequest } from "../../contracts/plugin-host";
import { MethodError, sessionsMethods, type MethodContext } from "../../bots/rpc";
import { ALPHA_FOLDER, boot, pluginFromFolder, removeTemps, tempDir } from "../../bots/tests/fixtures";
import { FakeClock } from "../../contracts/fakes/clock";
import { userSendMethods, withImageMarks } from "../rpc";
import { withFileMarks } from "../attach-files";

afterEach(removeTemps);

const M = APP_METHODS;
const theUser: Caller = { kind: "user", client: "app", device: "studio0000000000000" };
const aBot: Caller = { kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" };
const aPlugin: Caller = { kind: "plugin", pluginId: "weather" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const LIGHTS: Contribution = { point: "ui", pluginId: "home", ref: "ui/0", entryId: "lights", value: { spot: "pill.target", component: "Lights", title: "Lights", handler: "lights" }, state: "active" };
const OFF: Contribution = { ...LIGHTS, entryId: "fan", value: { ...(LIGHTS.value as object), handler: "fan" }, state: "waiting" };

async function setup(withTargets = true) {
  // The user's home folder holds MOSS's own (`~/.moss`), as on a real computer, so a bot's scratch folder has a tree path.
  const userHome = tempDir("moss-user-");
  const home = join(userHome, ".moss");
  mkdirSync(home);
  const clock = new FakeClock();
  const b = await boot({ home, clock, plugins: (await pluginFromFolder(ALPHA_FOLDER, { bundled: true })).inputs });
  const sessions = sessionsMethods({ home, computer: "Studio", bots: b.bots, host: b.host, clock, localDevice: "studio0000000000000" });
  const invoked: InvokeRequest[] = [];
  const staged: string[] = [];
  const methods = userSendMethods({
    bots: b.bots,
    sessions: { ...sessions, "session.stageImage": async (params, ctx) => (staged.push((params as { id: string }).id), sessions["session.stageImage"]!(params, ctx)) },
    sentAs: (id, clientMessageId) => b.host.sentAs(id, clientMessageId),
    files: { home, userHome, computer: "Studio" },
    ...(withTargets ? { targets: { registry: { entries: (point: string) => (point === "ui" ? [LIGHTS, OFF] : []) }, host: { invoke: async <R,>(r: InvokeRequest): Promise<R> => (invoked.push(r), undefined as R) } } } : {}),
  });
  const call = async <S extends MethodSpec>(spec: S, params: unknown, caller: Caller = theUser): Promise<z.output<S["result"]>> =>
    spec.result.parse(await methods[spec.name]!(params, { caller } as MethodContext)) as z.output<S["result"]>;
  const fails = async (params: unknown, caller: Caller = theUser): Promise<MethodError> => {
    const err = await methods[M.userSend.name]!(params, { caller } as MethodContext).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(MethodError);
    return err as MethodError;
  };
  return { b, call, fails, invoked, staged, home, userHome };
}

describe("user.send", () => {
  test("is the app's, as the user: the protocol keeps it from layers, and the handler refuses a bot or a plugin", async () => {
    expect(M.userSend.roles).toEqual(["app"]);
    expect(M.userSend.userOnly).toBe(true);
    expect(allowedMethods("layer").has("user.send")).toBe(false);
    const { b, fails } = await setup();
    const words = { to: { bot: "alpha" }, text: "dim the lights", clientMessageId: "c-1" };
    expect((await fails(words, aBot)).code).toBe(MOSS_ERR.NOT_THE_USER);
    expect((await fails(words, aPlugin)).code).toBe(MOSS_ERR.NOT_THE_USER);
    await b.shutdown();
  });

  test("to a bot: the user's message in its one conversation, as the composer's session.send, deduplicated by the client's id", async () => {
    const { b, call, fails } = await setup();
    const words = { to: { bot: "alpha" }, text: "dim the lights", clientMessageId: "c-1" };
    const sent = await call(M.userSend, words);
    expect(typeof sent.seq).toBe("number");
    expect(await call(M.userSend, words)).toEqual(sent);
    await flush();
    expect(b.drivers.for("b_alpha").turns[0]!).toMatchObject({ origin: "user", input: { from: "user", text: "dim the lights", device: "studio0000000000000" } });
    expect(b.drivers.for("b_alpha").turns).toHaveLength(1);
    expect((await fails({ to: { bot: "nobody" }, text: "x", clientMessageId: "c-2" })).code).toBe(ERR.NOT_FOUND);
    // A bot asleep refuses as the composer's send does.
    b.drivers.for("b_alpha").end();
    await flush();
    b.host.setAsleep("b_alpha", true);
    expect((await fails({ to: { bot: "alpha" }, text: "x", clientMessageId: "c-3" })).code).toBe(MOSS_ERR.BOT_ASLEEP);
    b.host.setAsleep("b_alpha", false);
    await b.shutdown();
  });

  test("to a session by id, and with pictures: staged first, each named in the text", async () => {
    const { b, call } = await setup();
    await call(M.userSend, { to: { session: "b_alpha" }, text: "what's this?", images: [{ mediaType: "image/png", data: PNG }], clientMessageId: "c-4" });
    await flush();
    const input = b.drivers.for("b_alpha").turns[0]!.input as { text: string; images?: { n: number; path: string }[] };
    expect(input.text).toBe("what's this? [Image #1]");
    expect(input.images).toHaveLength(1);
    expect(input.images![0]!.path).toMatch(/\/images\/image_\d+\.png$/);
    expect(withImageMarks("see [Image #1] and", 2)).toBe("see [Image #1] and [Image #2]");
    expect(withImageMarks("", 1)).toBe("[Image #1]");
    await b.shutdown();
  });

  test("a resend with pictures is the first message: nothing staged again, the same seq, one turn", async () => {
    const { b, call, staged } = await setup();
    const words = { to: { bot: "alpha" }, text: "what's this?", images: [{ mediaType: "image/png", data: PNG }, { mediaType: "image/png", data: PNG }], clientMessageId: "c-11" };
    expect(b.host.sentAs("b_alpha", "c-11")).toBeUndefined();
    const first = await call(M.userSend, words);
    expect(staged).toEqual(["b_alpha", "b_alpha"]);
    expect(b.host.sentAs("b_alpha", "c-11")).toEqual({ seq: first.seq! });
    expect(await call(M.userSend, words)).toEqual(first);
    expect(staged).toHaveLength(2);
    // A new message stages its own; an id the host doesn't know answers nothing.
    await call(M.userSend, { ...words, clientMessageId: "c-12" });
    expect(staged).toHaveLength(4);
    expect(b.host.sentAs("b_nobody", "c-11")).toBeUndefined();
    await flush();
    expect(b.drivers.for("b_alpha").turns.filter((t) => (t.input as { text?: string }).text === "what's this? [Image #1] [Image #2]").length).toBeGreaterThanOrEqual(1);
    await b.shutdown();
  });

  test("to a pill.target entry: its handler's send, as the plugin's own call; an entry not active or not there is not installed", async () => {
    const { b, call, fails, invoked } = await setup();
    expect(await call(M.userSend, { to: { target: "home#lights" }, text: "dim to 30%", clientMessageId: "c-5" })).toEqual({});
    expect(invoked).toEqual([{ pluginId: "home", handler: "lights", method: "send", args: { text: "dim to 30%", device: "studio0000000000000" }, caller: { kind: "plugin", pluginId: "home" } }]);
    expect((await fails({ to: { target: "home#fan" }, text: "x", clientMessageId: "c-6" })).code).toBe(MOSS_ERR.NOT_INSTALLED);
    expect((await fails({ to: { target: "home#nothing" }, text: "x", clientMessageId: "c-7" })).code).toBe(MOSS_ERR.NOT_INSTALLED);
    expect((await fails({ to: { target: "home#lights" }, text: "x", images: [{ mediaType: "image/png", data: PNG }], clientMessageId: "c-8" })).code).toBe(ERR.INVALID_PARAMS);
    // Nothing reached a bot.
    await flush();
    expect(b.drivers.for("b_alpha").turns).toHaveLength(0);
    await b.shutdown();
  });

  test("without a plugin host, an entry is not installed and bots still get the user's words", async () => {
    const { b, call, fails } = await setup(false);
    expect((await fails({ to: { target: "home#lights" }, text: "x", clientMessageId: "c-9" })).code).toBe(MOSS_ERR.NOT_INSTALLED);
    expect(typeof (await call(M.userSend, { to: { bot: "alpha" }, text: "hi", clientMessageId: "c-10" })).seq).toBe("number");
    await b.shutdown();
  });
});

// A person drops or picks a file for a bot (spec §6, §8.5): it stays where it is and the bot is given its folder-tree path;
// what the tree can't name is copied into the bot's scratch folder; a refusal is one plain sentence and sends nothing.
describe("user.send with files", () => {
  const sentTurns = async (b: Awaited<ReturnType<typeof setup>>["b"]) => (await flush(), b.drivers.for("b_alpha").turns);
  const filesOf = (turn: { input: unknown }) => (turn.input as { text: string; files?: { n: number; path: string }[] });

  test("a file in the user's home stays where it is: its tree path is named in the text and the turn, nothing is copied", async () => {
    const { b, call, userHome, home } = await setup();
    mkdirSync(join(userHome, "Documents"));
    writeFileSync(join(userHome, "Documents", "report.pdf"), "pdf bytes");
    const sent = await call(M.userSend, { to: { bot: "alpha" }, text: "summarise this", files: [{ path: join(userHome, "Documents", "report.pdf") }], clientMessageId: "f-1" });
    expect(typeof sent.seq).toBe("number");
    const turns = await sentTurns(b);
    const input = filesOf(turns[0]!);
    expect(input.text).toBe("summarise this [File #1]");
    expect(input.files).toEqual([{ n: 1, path: "home/Studio/Documents/report.pdf" }]);
    expect(existsSync(join(home, "scratch", "alpha", "attachments"))).toBe(false);
    await b.shutdown();
  });

  test("a file the tree can't name (outside the home folder) is copied into the bot's scratch folder, and the copy is named", async () => {
    const { b, call, home } = await setup();
    const elsewhere = tempDir("moss-usb-");
    writeFileSync(join(elsewhere, "notes.txt"), "from a stick");
    await call(M.userSend, { to: { bot: "alpha" }, text: "read", files: [{ path: join(elsewhere, "notes.txt") }, { path: join(elsewhere, "notes.txt") }], clientMessageId: "f-2" });
    const input = filesOf((await sentTurns(b))[0]!);
    expect(input.files!.map((f) => f.path)).toEqual(["home/Studio/.moss/scratch/alpha/attachments/f-2/1-notes.txt", "home/Studio/.moss/scratch/alpha/attachments/f-2/2-notes.txt"]);
    expect(readFileSync(join(home, "scratch", "alpha", "attachments", "f-2", "1-notes.txt"), "utf8")).toBe("from a stick");
    await b.shutdown();
  });

  test("past the bounds: a plain refusal, nothing sent and nothing copied", async () => {
    const { b, fails, userHome, home } = await setup();
    const elsewhere = tempDir("moss-usb-");
    const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: join(userHome, `f${i}.txt`) }));
    for (let i = 0; i < BOT_FILES_MAX + 1; i++) writeFileSync(join(userHome, `f${i}.txt`), "x");
    const tooMany = await fails({ to: { bot: "alpha" }, text: "x", files: files(BOT_FILES_MAX + 1), clientMessageId: "f-3" });
    expect(tooMany.code).toBe(ERR.INVALID_PARAMS);
    expect(tooMany.message).toBe(`A message can carry at most ${BOT_FILES_MAX} files; you picked ${BOT_FILES_MAX + 1}.`);
    // Over the size bound (a sparse file, so nothing big is written); a good file beside it is not copied either.
    writeFileSync(join(elsewhere, "ok.txt"), "ok");
    writeFileSync(join(elsewhere, "big.bin"), "");
    truncateSync(join(elsewhere, "big.bin"), BOT_FILE_MAX_BYTES + 1);
    const big = await fails({ to: { bot: "alpha" }, text: "x", files: [{ path: join(elsewhere, "ok.txt") }, { path: join(elsewhere, "big.bin") }], clientMessageId: "f-4" });
    expect(big.message).toBe(`“big.bin” is 51 MB: a file can be at most 50 MB.`);
    expect(existsSync(join(home, "scratch", "alpha", "attachments"))).toBe(false);
    // Exactly at the bound is fine.
    truncateSync(join(elsewhere, "big.bin"), BOT_FILE_MAX_BYTES);
    await b.shutdown();
  });

  test("a folder, a missing file, a relative path and a file inside MOSS's own folder are refused, whatever the path spells", async () => {
    const { b, fails, userHome, home } = await setup();
    mkdirSync(join(userHome, "dir"));
    writeFileSync(join(home, "secret.json"), "{}");
    mkdirSync(join(userHome, "link-dir"));
    symlinkSync(join(home, "secret.json"), join(userHome, "innocent.txt"));
    symlinkSync(home, join(userHome, "link-dir", "moss"));
    const refused = async (path: string, why: RegExp) => {
      const err = await fails({ to: { bot: "alpha" }, text: "x", files: [{ path }], clientMessageId: `f-r-${path.length}` });
      expect(err.code).toBe(ERR.INVALID_PARAMS);
      expect(err.message).toMatch(why);
    };
    await refused(join(userHome, "dir"), /folder or not an ordinary file/);
    await refused(join(userHome, "nothing.txt"), /can't be read/);
    await refused("relative/file.txt", /isn't a file path MOSS can use/);
    await refused(join(home, "secret.json"), /inside MOSS's own folder/);
    // A link planted in the home folder that leads into it, by file or by folder, and a `..` that climbs back in.
    await refused(join(userHome, "innocent.txt"), /inside MOSS's own folder/);
    await refused(join(userHome, "link-dir", "moss", "secret.json"), /inside MOSS's own folder/);
    await refused(join(userHome, "dir", "..", ".moss", "secret.json"), /inside MOSS's own folder/);
    // A case variant of the folder's name (the file system may be case-insensitive) is the same folder, or not a file at all.
    const upper = join(userHome, ".MOSS", "secret.json");
    const err = await fails({ to: { bot: "alpha" }, text: "x", files: [{ path: upper }], clientMessageId: "f-case" });
    expect(err.code).toBe(ERR.INVALID_PARAMS);
    await b.shutdown();
  });

  test("a link in the home folder to an ordinary file elsewhere names the real file's copy; the target must be a bot", async () => {
    const { b, call, fails, userHome } = await setup();
    const elsewhere = tempDir("moss-usb-");
    writeFileSync(join(elsewhere, "real.txt"), "real");
    symlinkSync(join(elsewhere, "real.txt"), join(userHome, "shortcut.txt"));
    await call(M.userSend, { to: { bot: "alpha" }, text: "x", files: [{ path: join(userHome, "shortcut.txt") }], clientMessageId: "f-5" });
    const input = filesOf((await sentTurns(b))[0]!);
    expect(input.files![0]!.path).toBe("home/Studio/.moss/scratch/alpha/attachments/f-5/1-real.txt");
    const toSession = await fails({ to: { session: "b_alpha" }, text: "x", files: [{ path: join(elsewhere, "real.txt") }], clientMessageId: "f-6" });
    expect(toSession.message).toBe("files can only be sent to a bot's conversation");
    const toTarget = await fails({ to: { target: "home#lights" }, text: "x", files: [{ path: join(elsewhere, "real.txt") }], clientMessageId: "f-7" });
    expect(toTarget.code).toBe(ERR.INVALID_PARAMS);
    await b.shutdown();
  });

  test("only the user may send them, and a resend is the first message: nothing copied again", async () => {
    const { b, call, fails, home } = await setup();
    const elsewhere = tempDir("moss-usb-");
    writeFileSync(join(elsewhere, "a.txt"), "a");
    const words = { to: { bot: "alpha" }, text: "x", files: [{ path: join(elsewhere, "a.txt") }], clientMessageId: "f-8" };
    expect((await fails(words, aBot)).code).toBe(MOSS_ERR.NOT_THE_USER);
    expect(existsSync(join(home, "scratch", "alpha", "attachments"))).toBe(false);
    const first = await call(M.userSend, words);
    rmSync(join(home, "scratch", "alpha", "attachments"), { recursive: true });
    expect(await call(M.userSend, words)).toEqual(first);
    expect(existsSync(join(home, "scratch", "alpha", "attachments"))).toBe(false);
    await b.shutdown();
  });

  test("the marks: one for each file the text doesn't name yet", () => {
    expect(withFileMarks("see [File #1] and", 2)).toBe("see [File #1] and [File #2]");
    expect(withFileMarks("", 1)).toBe("[File #1]");
  });
});
