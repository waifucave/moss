// `session.stageFile` and the phone's `files` on `session.send` (PH3, the owner's decision of 2026-11-24), on temp homes. Every refusal
// the design names is here: a phone that isn't paired with an answer key, a file too big, too many, too much a day, a name that tries to
// leave its folder, a link planted in the bot's own folder, something that runs when opened, a file named that this phone didn't send.
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STAGE_FILE_CHUNK_BYTES, STAGE_FILE_DAY_MAX_BYTES, STAGE_FILE_DAY_MAX_FILES, STAGE_FILE_UNSENT_MAX, STAGE_FILE_MAX_BYTES, STAGE_FILE_OPEN_MAX, STAGE_FILE_PENDING_MAX_BYTES, STAGE_IMAGE_MAX_BYTES, type Caller } from "@waifucave/moss-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { pairedPhone, type TestPhone } from "../../agents/tests/phone";
import { botPaths } from "../paths";
import { cleanFileName, createExclusive, FileStager, receivedRootOf, refusedKind, type StageLimits } from "../staged-files";
import { outdirPath } from "../../sessions/outdir";
import { boot, removeTemps, tempDir } from "./fixtures";

/** The received folder of a home called `.moss`: its sibling (`receivedRootOf`), which is what a normal install has. */
const RECEIVED_FOLDER = ".moss-received";

afterEach(removeTemps);

const DESKTOP: Caller = { kind: "user", client: "app" };
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");

async function setup(o: { limits?: Partial<StageLimits>; answerKey?: boolean; apart?: boolean } = {}) {
  const clock = new FakeClock();
  const userHome = tempDir();
  // `apart`: MOSS's home is not a folder of the user's home (a throwaway home somewhere else).
  const home = o.apart === true ? join(tempDir(), "home") : join(userHome, ".moss");
  mkdirSync(home, { recursive: true });
  const phone = await pairedPhone(clock, o.answerKey === undefined ? {} : { answerKey: o.answerKey });
  const b = await boot({ home, userHome, clock, plugins: [], botSource: "records", computer: "Studio" });
  const all = b.side.methods({ localDevice: "studio0000000000000", phoneMay: phone.mayStart, ...(o.limits === undefined ? {} : { stageLimits: o.limits }) });
  const call = (method: string, params: unknown, caller: Caller = phone.caller()) => all[method]!(params, { caller } as never) as Promise<Record<string, any>>;
  await call("bot.create", { name: "Nova", instructions: "You are Nova." }, DESKTOP);
  const session = b.bots.mainSession("nova");
  b.host.open({ id: "s_code", kind: "coding", computer: "Studio", backend: "claude-code" }, new FakeSessionDriver({ canFold: false }));
  /** A whole file, in chunks of `chunk` bytes. */
  const send = async (id: string, name: string, bytes: Uint8Array, caller: Caller = phone.caller(), chunk = STAGE_FILE_CHUNK_BYTES) => {
    let r = await call("session.stageFile", { id, name, size: bytes.length, dataBase64: b64(bytes.subarray(0, chunk)) }, caller);
    for (let at = chunk; at < bytes.length; at += chunk) r = await call("session.stageFile", { id, upload: r.upload, offset: at, dataBase64: b64(bytes.subarray(at, at + chunk)) }, caller);
    return r;
  };
  const scratch = botPaths(home, "nova").scratch;
  return { clock, userHome, home, phone, b, call, session, send, scratch, all };
}
type S = Awaited<ReturnType<typeof setup>>;
const text = (s: string) => new TextEncoder().encode(s);
const fail = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
/** What a message the phone sent carries into the bot's turn. */
const sentInput = (s: S, id: string) => {
  const rec = s.b.host.history(id, { afterSeq: -1, limit: 200 }).filter((r) => r.type === "input" && r.input.from === "user").at(-1) as { input: { files?: { n: number; path: string }[]; text: string } } | undefined;
  return rec?.input;
};

describe("a file from a paired phone to a bot's conversation", () => {
  test("arrives in chunks, lands in the bot's own folder where a dropped file would, is named by the next send, and the bot sees it as a dropped file", async () => {
    const s = await setup();
    const body = new Uint8Array(STAGE_FILE_CHUNK_BYTES * 2 + 123).map((_, i) => i % 251);
    const r = await s.send(s.session, "Notes 1.txt", body);
    expect(r).toMatchObject({ received: body.length, done: true, name: "Notes 1.txt" });
    const dir = join(s.scratch, "attachments", `phone-${r.upload}`);
    const dest = join(dir, "Notes 1.txt");
    expect(Buffer.compare(readFileSync(dest), Buffer.from(body))).toBe(0);
    // Readable by the owner only, and never executable, whatever it is.
    if (posix) {
      expect(statSync(dest).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o077).toBe(0);
    }
    // The same folder-tree form a dropped file is named in (`home/<Computer>/…`), under the bot's scratch folder.
    expect(r.path).toBe(`home/Studio/.moss/scratch/nova/attachments/phone-${r.upload}/Notes 1.txt`);
    // The spool is gone: nothing half-written is left where the bot can see it.
    expect(readdirSync(join(s.home, "transcripts", ".staged-files"))).toEqual([]);
    await s.call("session.send", { id: s.session, message: { text: "read [File #1]", clientMessageId: "m1", files: [{ n: 1, path: r.path }] } });
    expect(sentInput(s, s.session)).toMatchObject({ text: "read [File #1]", files: [{ n: 1, path: r.path }] });
    await s.b.shutdown();
  });

  test("a file for a coding session lands in `.moss-received/<session>/` in the user's home (MOSS's home is closed to its agent), named by its folder-tree path, and is not in its project", async () => {
    const s = await setup();
    const r = await s.send("s_code", "spec.md", text("# spec"));
    expect(r.path).toBe(`home/Studio/${RECEIVED_FOLDER}/s_code/phone-${r.upload}/spec.md`);
    const real = join(realpathSync(s.userHome), RECEIVED_FOLDER, "s_code", `phone-${r.upload}`, "spec.md");
    expect(readFileSync(real, "utf8")).toBe("# spec");
    expect(real.startsWith(`${realpathSync(s.home)}/`)).toBe(false);
    expect(existsSync(join(outdirPath(s.home, "s_code"), "received"))).toBe(false);
    if (posix) expect(statSync(real).mode & 0o777).toBe(0o600);
    await s.call("session.send", { id: "s_code", message: { text: "see [File #1]", clientMessageId: "c1", files: [{ n: 1, path: r.path }] } });
    expect(sentInput(s, "s_code")).toMatchObject({ files: [{ n: 1, path: r.path }] });
    // Cancelling takes the file and its folder away.
    const r2 = await s.send("s_code", "again.md", text("# again"));
    await s.call("session.stageFile", { id: "s_code", upload: r2.upload, cancel: true });
    expect(existsSync(join(realpathSync(s.userHome), RECEIVED_FOLDER, "s_code", `phone-${r2.upload}`))).toBe(false);
    await s.b.shutdown();
  });

  test("the phone can drop an upload: its bytes and its folder go", async () => {
    const s = await setup();
    const r = await s.send(s.session, "a.txt", text("hello"));
    expect(existsSync(join(s.scratch, "attachments", `phone-${r.upload}`))).toBe(true);
    await s.call("session.stageFile", { id: s.session, upload: r.upload, cancel: true });
    expect(existsSync(join(s.scratch, "attachments", `phone-${r.upload}`))).toBe(false);
    await expect(s.call("session.send", { id: s.session, message: { text: "[File #1]", clientMessageId: "m2", files: [{ n: 1, path: r.path }] } })).rejects.toThrow(/isn't one this phone sent/);
    await s.b.shutdown();
  });
});

describe("who may send a file", () => {
  test("a revoked phone, a phone with no answer key, an unknown device, a call with no device and an engine with no gate are refused; nothing is written", async () => {
    const s = await setup();
    const params = { id: s.session, name: "a.txt", size: 2, dataBase64: b64("hi") };
    await expect(s.call("session.stageFile", params, { kind: "user", client: "ios", device: "z".repeat(32) })).rejects.toThrow(/answer key/);
    await expect(s.call("session.stageFile", params, { kind: "user", client: "ios" } as Caller)).rejects.toThrow(/answer key/);
    await expect(s.call("session.stageFile", params, DESKTOP)).rejects.toThrow(/dropping it/);
    await s.phone.revoke();
    await expect(s.call("session.stageFile", params)).rejects.toThrow(/answer key/);
    expect(existsSync(join(s.scratch, "attachments"))).toBe(false);
    await s.b.shutdown();

    const keyless = await setup({ answerKey: false });
    await expect(keyless.call("session.stageFile", { id: keyless.session, name: "a.txt", size: 2, dataBase64: b64("hi") })).rejects.toThrow(/answer key/);
    await keyless.b.shutdown();

    const ungated = await setup();
    const open = ungated.b.side.methods({ localDevice: "studio0000000000000" });
    await expect(open["session.stageFile"]!({ id: ungated.session, name: "a.txt", size: 2, dataBase64: b64("hi") }, { caller: ungated.phone.caller() } as never)).rejects.toThrow(/answer key/);
    await ungated.b.shutdown();
  });

  test("a revocation between two chunks ends the upload at the next one", async () => {
    const s = await setup();
    const first = await s.call("session.stageFile", { id: s.session, name: "a.bin.txt", size: 4, dataBase64: b64("ab") });
    await s.phone.revoke();
    await expect(s.call("session.stageFile", { id: s.session, upload: first.upload, offset: 2, dataBase64: b64("cd") })).rejects.toThrow(/answer key/);
    await s.b.shutdown();
  });

  test("a bot, an agent, a plugin, a peer and the engine itself are refused", async () => {
    const s = await setup();
    for (const caller of [
      { kind: "plugin", pluginId: "spy" }, { kind: "peer", device: "d1" }, { kind: "core" },
      { kind: "session", sessionId: s.session, sessionKind: "bot", bot: "nova" }, { kind: "session", sessionId: "a_1", sessionKind: "agent", bot: "nova" },
    ] as Caller[]) await expect(s.call("session.stageFile", { id: s.session, name: "a.txt", size: 2, dataBase64: b64("hi") }, caller)).rejects.toThrow();
    expect(existsSync(join(s.scratch, "attachments"))).toBe(false);
    await s.b.shutdown();
  });

  test("only a bot's own conversation and a coding session here, not ended: not a side thread, an agent, an unknown session or a finished one", async () => {
    const s = await setup();
    s.b.host.open({ id: "s_agent", kind: "agent", bot: "nova", parent: s.session, computer: "Studio", backend: "claude-code" }, new FakeSessionDriver({ canFold: false }));
    s.b.host.open({ id: "s_elsewhere", kind: "coding", computer: "Laptop", backend: "claude-code" }, new FakeSessionDriver({ canFold: false }));
    for (const id of ["s_agent", "s_elsewhere", "s_nothing"]) await expect(s.call("session.stageFile", { id, name: "a.txt", size: 2, dataBase64: b64("hi") })).rejects.toThrow();
    await s.b.host.stop("s_code", "test");
    await expect(s.call("session.stageFile", { id: "s_code", name: "a.txt", size: 2, dataBase64: b64("hi") })).rejects.toThrow(/ended/);
    await s.b.shutdown();
  });
});

describe("the limits", () => {
  test("a file over the desktop's limit, an empty one, a chunk that isn't base64, a chunk past the frame, a wrong offset and an overrun are refused", async () => {
    const s = await setup();
    const id = s.session;
    // The protocol says it, and so does the engine behind it.
    expect(await fail(s.call("session.stageFile", { id, name: "big.bin.txt", size: STAGE_FILE_MAX_BYTES + 1, dataBase64: b64("x") }))).toMatch(/at most|invalid|too big|<=/i);
    expect(await fail(s.call("session.stageFile", { id, name: "a.txt", size: 4, dataBase64: "!!!!" }))).toMatch(/base64/);
    expect(await fail(s.call("session.stageFile", { id, name: "a.txt", size: 1, dataBase64: b64("xy") }))).toMatch(/longer than the file/);
    const first = await s.call("session.stageFile", { id, name: "a.txt", size: 6, dataBase64: b64("abc") });
    expect(await fail(s.call("session.stageFile", { id, upload: first.upload, offset: 0, dataBase64: b64("abc") }))).toMatch(/starts at byte 3/);
    expect(await fail(s.call("session.stageFile", { id, upload: first.upload, offset: 3, dataBase64: b64("abcdef") }))).toMatch(/longer than the file/);
    // The overrun dropped the upload.
    expect(await fail(s.call("session.stageFile", { id, upload: first.upload, offset: 3, dataBase64: b64("def") }))).toMatch(/no such upload/);
    expect(readdirSync(join(s.home, "transcripts", ".staged-files"))).toEqual([]);
    await s.b.shutdown();
  });

  test("at most four uploads at once, and a device's unsent files can't pass the pending cap", async () => {
    const s = await setup({ limits: { pendingBytes: 100, dayBytes: 10_000, openPerDevice: 2 } });
    const a = await s.call("session.stageFile", { id: s.session, name: "a.txt", size: 10, dataBase64: b64("12345") });
    await s.call("session.stageFile", { id: s.session, name: "b.txt", size: 10, dataBase64: b64("12345") });
    expect(await fail(s.call("session.stageFile", { id: s.session, name: "c.txt", size: 10, dataBase64: b64("12345") }))).toMatch(/at once/);
    await s.call("session.stageFile", { id: s.session, upload: a.upload, cancel: true });
    expect(await fail(s.call("session.stageFile", { id: s.session, name: "big.txt", size: 95, dataBase64: b64("1") }))).toMatch(/waiting to be sent/);
    // The real numbers: four open, two big files held, ten a day.
    expect([STAGE_FILE_OPEN_MAX, STAGE_FILE_PENDING_MAX_BYTES / STAGE_FILE_MAX_BYTES, STAGE_FILE_DAY_MAX_BYTES / STAGE_FILE_MAX_BYTES]).toEqual([4, 2, 10]);
    await s.b.shutdown();
  });

  test("the number of files is bounded too, since one byte is a file: unsent ones waiting, and files started in a day", async () => {
    const s = await setup({ limits: { unsentFiles: 3, dayFiles: 5, openPerDevice: 10 } });
    const made = [];
    for (const n of [1, 2, 3]) made.push(await s.send(s.session, `f${n}.txt`, text("x")));
    expect(await fail(s.send(s.session, "f4.txt", text("x")))).toMatch(/files waiting to be sent; at most 3/);
    // Sending frees a place; the day's count does not come back.
    await s.call("session.send", { id: s.session, message: { text: "[File #1]", clientMessageId: "m5", files: [{ n: 1, path: made[0]!.path }] } });
    for (const gone of [made[1]!, made[2]!]) await s.call("session.stageFile", { id: s.session, upload: gone.upload, cancel: true });
    await s.send(s.session, "f4.txt", text("x"));
    await s.send(s.session, "f5.txt", text("x"));
    expect(await fail(s.send(s.session, "f6.txt", text("x")))).toMatch(/sent 5 files today; at most 5/);
    expect([STAGE_FILE_UNSENT_MAX, STAGE_FILE_DAY_MAX_FILES]).toEqual([40, 200]);
    await s.b.shutdown();
  });

  test("a day's total counts bytes received, an abandoned upload included, across a restart; the next day it starts again", async () => {
    const s = await setup({ limits: { pendingBytes: 1000, dayBytes: 25, openPerDevice: 4 } });
    const a = await s.call("session.stageFile", { id: s.session, name: "a.txt", size: 20, dataBase64: b64("1234567890") });
    await s.call("session.stageFile", { id: s.session, upload: a.upload, cancel: true });
    // Cancelling doesn't give the bytes back.
    expect(await fail(s.call("session.stageFile", { id: s.session, name: "b.txt", size: 20, dataBase64: b64("1") }))).toMatch(/sent 10 MB|sent 0 MB|today/);
    const again = s.b.side.methods({ localDevice: "x", phoneMay: s.phone.mayStart, stageLimits: { pendingBytes: 1000, dayBytes: 25, openPerDevice: 4 } });
    expect(await fail(again["session.stageFile"]!({ id: s.session, name: "b.txt", size: 20, dataBase64: b64("1") }, { caller: s.phone.caller() } as never))).toMatch(/today/);
    s.clock.advance(25 * 60 * 60 * 1000);
    await s.call("session.stageFile", { id: s.session, name: "b.txt", size: 20, dataBase64: b64("1") });
    await s.b.shutdown();
  });

  test("an idle upload goes after 15 minutes, a finished file no message named after a day; a sent one stays", async () => {
    const s = await setup();
    const part = await s.call("session.stageFile", { id: s.session, name: "p.txt", size: 10, dataBase64: b64("12345") });
    const whole = await s.send(s.session, "w.txt", text("whole"));
    const sent = await s.send(s.session, "s.txt", text("sent"));
    await s.call("session.send", { id: s.session, message: { text: "[File #1]", clientMessageId: "m3", files: [{ n: 1, path: sent.path }] } });
    const folder = (r: Record<string, any>) => join(s.scratch, "attachments", `phone-${r.upload}`);
    s.clock.advance(16 * 60 * 1000);
    // Any call sweeps.
    await s.call("session.stageFile", { id: s.session, name: "n.txt", size: 2, dataBase64: b64("ok") });
    expect(readdirSync(join(s.home, "transcripts", ".staged-files")).some((f) => f.startsWith(part.upload))).toBe(false);
    expect(existsSync(folder(whole))).toBe(true);
    s.clock.advance(24 * 60 * 60 * 1000);
    await s.call("session.stageFile", { id: s.session, name: "m.txt", size: 2, dataBase64: b64("ok") });
    expect(existsSync(folder(whole))).toBe(false);
    expect(existsSync(folder(sent))).toBe(true);
    await s.b.shutdown();
  });
});

describe("names and kinds", () => {
  test("a name is cleaned to one safe file name: no separator, no leading dot, no reserved name, no overwrite, a bounded length", () => {
    const cases: [string, string][] = [
      ["../../etc/passwd", "_.._etc_passwd"],
      ["/etc/cron.d/x", "_etc_cron.d_x"],
      ["..\\..\\Windows\\win.ini", "_.._Windows_win.ini"],
      ["~/escape.txt", "~_escape.txt"],
      [".bashrc", "bashrc"],
      ["...hidden", "hidden"],
      ["con", "_con"],
      ["NUL.txt", "_NUL.txt"],
      ["com1.log", "_com1.log"],
      ["LPT9", "_LPT9"],
      ["name. ", "name"],
      ["a\u0000b‮c.txt", "abc.txt"],
      ["", "file"],
      ["...", "file"],
      ["C:evil.txt", "C_evil.txt"],
      ["what?*|<>.txt", "what_.txt"],
    ];
    for (const [raw, want] of cases) {
      const got = cleanFileName(raw);
      expect([raw, got]).toEqual([raw, want]);
      expect(got).not.toMatch(/[/\\:*?"<>|]/);
      expect(got.startsWith(".")).toBe(false);
    }
    const long = cleanFileName(`${"é".repeat(400)}.markdown`);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long.endsWith(".markdown")).toBe(true);
    // Unicode: the same name in two forms is one.
    expect(cleanFileName("é.txt")).toBe(cleanFileName("é.txt"));
  });

  test("what launches when opened, and a program's own bytes, are refused whatever the name", async () => {
    for (const name of ["Chrome.app", "run.command", "setup.EXE", "x.msi", "a.bat", "x.pkg", "evil.dmg", "x.scpt", "y.lnk", "y.jar", "x.desktop"]) {
      expect([name, refusedKind(cleanFileName(name), new Uint8Array(16))]).toEqual([name, expect.stringContaining("runs or installs")]);
    }
    for (const head of [[0x7f, 0x45, 0x4c, 0x46], [0x4d, 0x5a, 0x90, 0], [0xcf, 0xfa, 0xed, 0xfe], [0xfe, 0xed, 0xfa, 0xcf], [0xca, 0xfe, 0xba, 0xbe]]) {
      expect(refusedKind("harmless.txt", new Uint8Array([...head, 0, 0, 0, 0]))).toMatch(/program/);
    }
    // A plain script is data like any file: it has no execute bit.
    expect(refusedKind("build.sh", text("#!/bin/sh\necho hi\n"))).toBeUndefined();
    expect(refusedKind("notes.txt", text("hello"))).toBeUndefined();
    const s = await setup();
    expect(await fail(s.call("session.stageFile", { id: s.session, name: "Totally Safe.app", size: 2, dataBase64: b64("hi") }))).toMatch(/runs or installs/);
    expect(await fail(s.call("session.stageFile", { id: s.session, name: "photo.jpg", size: 8, dataBase64: b64(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0])) }))).toMatch(/program/);
    expect(existsSync(join(s.scratch, "attachments"))).toBe(false);
    await s.b.shutdown();
  });

  test("a name asking to leave its folder, in every spelling, lands inside the file's own folder", async () => {
    const s = await setup();
    for (const name of ["../../../../escape.txt", "..\\..\\escape.txt", "/tmp/escape.txt", "~/escape.txt", ".ssh", "AUX"]) {
      const r = await s.send(s.session, name, text("x"));
      const dest = join(s.scratch, "attachments", `phone-${r.upload}`, r.name);
      expect(existsSync(dest)).toBe(true);
      expect(r.name).not.toMatch(/[/\\]/);
    }
    expect(existsSync(join(s.userHome, "escape.txt"))).toBe(false);
    await s.b.shutdown();
  });
});

describe("the sweep runs on a timer, not only at the next call", () => {
  test("a half-sent upload and a finished file no message named are removed with no call at all, and the timer rests once nothing is held", async () => {
    const s = await setup();
    expect(s.clock.pending()).toBe(0);
    const half = await s.call("session.stageFile", { id: s.session, name: "half.bin", size: 1_000_000, dataBase64: b64(new Uint8Array(1000).fill(65)) });
    const whole = await s.send(s.session, "whole.txt", text("kept a day"));
    const spoolPart = join(s.home, "transcripts", ".staged-files", `${half.upload}.part`);
    const placed = join(s.scratch, "attachments", `phone-${whole.upload}`, "whole.txt");
    expect(existsSync(spoolPart) && existsSync(placed)).toBe(true);
    // One timer, however many files: it is set when something is held.
    expect(s.clock.pending()).toBe(1);
    // Past the idle time (15 minutes) and a sweep: the half-sent upload is gone, with no call made.
    s.clock.advance(21 * 60_000);
    expect(existsSync(spoolPart)).toBe(false);
    expect(existsSync(placed)).toBe(true);
    expect(s.clock.pending()).toBe(1);
    // Past a day: the finished file and its folder are gone too, and with nothing held there is no timer.
    s.clock.advance(24 * 3600_000);
    expect(existsSync(placed)).toBe(false);
    expect(existsSync(join(s.scratch, "attachments", `phone-${whole.upload}`))).toBe(false);
    expect(s.clock.pending()).toBe(0);
    await s.b.shutdown();
  });

  test("a file the next message named is kept, not swept", async () => {
    const s = await setup();
    const r = await s.send(s.session, "named.txt", text("sent"));
    await s.call("session.send", { id: s.session, message: { text: "[File #1]", clientMessageId: "m1", files: [{ n: 1, path: r.path }] } });
    s.clock.advance(3 * 24 * 3600_000);
    expect(existsSync(join(s.scratch, "attachments", `phone-${r.upload}`, "named.txt"))).toBe(true);
    await s.b.shutdown();
  });

  test("the engine's close ends the timer: none is left, and none is set by a call that comes after it", async () => {
    const s = await setup();
    await s.call("session.stageFile", { id: s.session, name: "half.bin", size: 1_000_000, dataBase64: b64(new Uint8Array(1000).fill(65)) });
    expect(s.clock.pending()).toBe(1);
    await s.b.shutdown();
    expect(s.clock.pending()).toBe(0);
    // A call that still reaches the door after the close sweeps as it does at any call, and sets no timer.
    await s.call("session.stageFile", { id: s.session, name: "late.bin", size: 1_000_000, dataBase64: b64(new Uint8Array(1000).fill(65)) }).catch(() => undefined);
    expect(s.clock.pending()).toBe(0);
    s.clock.advance(48 * 3600_000);
  });
});

// Links need no privilege on POSIX hosts only, and file modes mean nothing on Windows: those suites run where they mean something.
const posix = process.platform !== "win32";
describe.skipIf(!posix)("a link planted in the bot's own folder leads nowhere", () => {
  test("`attachments` as a link to a folder outside: refused, and nothing is written there", async () => {
    const s = await setup();
    const outside = join(s.userHome, "outside");
    mkdirSync(outside);
    mkdirSync(s.scratch, { recursive: true });
    symlinkSync(outside, join(s.scratch, "attachments"));
    const r = await fail(s.send(s.session, "a.txt", text("x")));
    expect(r).toMatch(/plain folder|nothing was written/);
    expect(readdirSync(outside)).toEqual([]);
    await s.b.shutdown();
  });

  test("`attachments` as a link to another folder of the bot's own scratch is refused too (the real path must be the expected one)", async () => {
    const s = await setup();
    mkdirSync(join(s.scratch, "elsewhere"), { recursive: true });
    symlinkSync(join(s.scratch, "elsewhere"), join(s.scratch, "attachments"));
    expect(await fail(s.send(s.session, "a.txt", text("x")))).toMatch(/plain folder|nothing was written/);
    expect(readdirSync(join(s.scratch, "elsewhere"))).toEqual([]);
    await s.b.shutdown();
  });

  test("a coding session's folder in `.moss-received`, or `.moss-received` itself, as a link to a folder outside: refused, nothing written", async () => {
    const s = await setup();
    const outside = join(s.userHome, "outside2");
    mkdirSync(outside);
    mkdirSync(join(s.userHome, RECEIVED_FOLDER));
    symlinkSync(outside, join(s.userHome, RECEIVED_FOLDER, "s_code"));
    expect(await fail(s.send("s_code", "a.txt", text("x")))).toMatch(/plain folder|nothing was written/);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(join(s.userHome, RECEIVED_FOLDER), { recursive: true, force: true });
    symlinkSync(outside, join(s.userHome, RECEIVED_FOLDER));
    expect(await fail(s.send("s_code", "a.txt", text("x")))).toMatch(/isn't a plain folder of yours/);
    expect(readdirSync(outside)).toEqual([]);
    await s.b.shutdown();
  });

  test("the bot's scratch folder itself a link out of MOSS's folder: refused", async () => {
    const s = await setup();
    const outside = join(s.userHome, "outside3");
    mkdirSync(outside);
    rmSync(s.scratch, { recursive: true, force: true });
    mkdirSync(join(s.home, "scratch"), { recursive: true });
    symlinkSync(outside, s.scratch);
    expect(await fail(s.send(s.session, "a.txt", text("x")))).toMatch(/isn't inside MOSS's own/);
    expect(readdirSync(outside)).toEqual([]);
    await s.b.shutdown();
  });

  test("nothing is overwritten: a name already taken, in any case the file system folds, keeps its bytes and the new file gets another name", async () => {
    const s = await setup();
    const folder = join(s.scratch, "taken");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "a.txt"), "keep me");
    symlinkSync(join(s.userHome, "nowhere"), join(folder, "b.txt"));
    for (const name of ["a.txt", "b.txt"]) {
      const made = createExclusive(folder, name)!;
      closeSync(made.fd);
      expect(made.path).toBe(join(folder, name.replace(".txt", " (2).txt")));
    }
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("keep me");
    // A link is never followed to make the file: its target was not created.
    expect(existsSync(join(s.userHome, "nowhere"))).toBe(false);
    // On a file system that folds case (APFS by default) `A.TXT` is `a.txt`: the same refusal, the same new name.
    if (existsSync(join(folder, "A.TXT"))) expect(createExclusive(folder, "A.TXT")!.path).toBe(join(folder, "A (3).TXT"));
    // Two files of one name from one phone sit in two folders of their own.
    const r = await s.send(s.session, "a.txt", text("first"));
    const second = await s.send(s.session, "a.txt", text("second"));
    expect(r.upload).not.toBe(second.upload);
    expect(readFileSync(join(s.scratch, "attachments", `phone-${r.upload}`, "a.txt"), "utf8")).toBe("first");
    await s.b.shutdown();
  });

  test("the file is written with no execute bit even when the umask would allow it", async () => {
    const s = await setup();
    const old = process.umask(0);
    try {
      const r = await s.send(s.session, "script.sh", text("#!/bin/sh\necho hi\n"));
      const st = lstatSync(join(s.scratch, "attachments", `phone-${r.upload}`, "script.sh"));
      expect(st.mode & 0o111).toBe(0);
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      process.umask(old);
    }
    await s.b.shutdown();
  });
});

describe("the next send names only what this phone staged for this session", () => {
  const send = (s: S, id: string, files: { n: number; path: string }[], textIn = "see [File #1]", clientMessageId = `m-${Math.random()}`, caller: Caller = s.phone.caller()) =>
    s.call("session.send", { id, message: { text: textIn, clientMessageId, files } }, caller);

  test("a path nobody staged, another phone's file, another session's file, a path in the user's own home and a path outside the tree are refused; nothing is sent", async () => {
    const s = await setup();
    const mine = await s.send(s.session, "a.txt", text("mine"));
    const code = await s.send("s_code", "c.txt", text("code"));
    const before = s.b.host.length(s.session);
    const bad = [
      "home/Studio/Documents/secret.txt", "home/Studio/.ssh/id_ed25519", "home/Studio/.moss/scratch/nova/attachments/phone-deadbeef/a.txt",
      `home/Studio/.moss/scratch/nova/attachments/phone-${mine.upload}/../../../../../.ssh/config`, "bots/nova/memory/MEMORY.md", code.path,
      mine.path.replace(".moss", ".MOSS"),
    ];
    for (const path of bad) expect([path, await fail(send(s, s.session, [{ n: 1, path }]))]).toEqual([path, expect.stringMatching(/isn't one this phone sent/)]);
    expect(s.b.host.length(s.session)).toBe(before);
    // Another phone: the same path, a different device.
    const other = await pairedPhone(s.clock);
    const otherCaller = other.caller();
    const mayBoth = (d: string) => s.phone.mayStart(d) || other.mayStart(d);
    const all = s.b.side.methods({ localDevice: "x", phoneMay: mayBoth });
    expect(await fail(all["session.send"]!({ id: s.session, message: { text: "see [File #1]", clientMessageId: "z1", files: [{ n: 1, path: mine.path }] } }, { caller: otherCaller } as never))).toMatch(/isn't one this phone sent/);
    await s.b.shutdown();
  });

  test("the message must carry [File #n], once per n, at most ten, with a device named", async () => {
    const s = await setup();
    const a = await s.send(s.session, "a.txt", text("a"));
    expect(await fail(send(s, s.session, [{ n: 1, path: a.path }], "no placeholder"))).toMatch(/does not appear/);
    expect(await fail(send(s, s.session, [{ n: 1, path: a.path }, { n: 1, path: a.path }], "[File #1]"))).toMatch(/more than once/);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ n: i + 1, path: a.path }));
    expect(await fail(send(s, s.session, eleven, eleven.map((f) => `[File #${f.n}]`).join(" ")))).toMatch(/at most 10/);
    expect(await fail(send(s, s.session, [{ n: 1, path: a.path }, { n: 2, path: a.path }], "[File #1] [File #2]"))).toMatch(/named twice/);
    expect(await fail(send(s, s.session, [{ n: 1, path: a.path }], "[File #1]", "m9", { kind: "user", client: "ios" } as Caller))).toMatch(/device/);
    await s.b.shutdown();
  });

  test.skipIf(!posix)("a file that is still arriving, one replaced by a link, one changed or gone is refused; one used in another message is refused, and the same message again is not", async () => {
    const s = await setup();
    const open = await s.call("session.stageFile", { id: s.session, name: "p.txt", size: 10, dataBase64: b64("12345") });
    const whole = await s.send(s.session, "w.txt", text("whole"));
    const wDest = join(s.scratch, "attachments", `phone-${whole.upload}`, "w.txt");
    // Swapped for a link to something else after it arrived.
    const secret = join(s.userHome, "secret.txt");
    writeFileSync(secret, "top secret");
    rmSync(wDest);
    symlinkSync(secret, wDest);
    expect(await fail(send(s, s.session, [{ n: 1, path: whole.path }]))).toMatch(/changed since it arrived/);
    rmSync(wDest);
    expect(await fail(send(s, s.session, [{ n: 1, path: whole.path }]))).toMatch(/is gone/);
    writeFileSync(wDest, "whole!!");
    expect(await fail(send(s, s.session, [{ n: 1, path: whole.path }]))).toMatch(/changed since it arrived/);
    writeFileSync(wDest, "whole");
    // A file still arriving has no path yet to name.
    expect(open.path).toBeUndefined();
    await send(s, s.session, [{ n: 1, path: whole.path }], "see [File #1]", "first");
    expect(await fail(send(s, s.session, [{ n: 1, path: whole.path }], "see [File #1]", "second"))).toMatch(/already sent in another message/);
    // The phone's retry of the very message that named it goes through (the host answers it as the first).
    await send(s, s.session, [{ n: 1, path: whole.path }], "see [File #1]", "first");
    await s.b.shutdown();
  });

  test("the desktop's own send is unchanged: a client on this computer names what it always did", async () => {
    const s = await setup();
    const r = await s.call("session.send", { id: s.session, message: { text: "see [File #1]", clientMessageId: "d1", files: [{ n: 1, path: "home/Studio/Documents/x.txt" }] } }, DESKTOP);
    expect(r.seq).toBeGreaterThanOrEqual(0);
    expect(sentInput(s, s.session)?.files).toEqual([{ n: 1, path: "home/Studio/Documents/x.txt" }]);
    await s.b.shutdown();
  });
});

describe("session.composerOffers", () => {
  async function withOffers(o: { answerKey?: boolean } = {}) {
    const s = await setup(o);
    const models = [
      { id: "acme/large", name: "Large", provider: "acme", providerName: "Acme", plugin: "moss/model-acme", efforts: ["low", "high"], defaultEffort: "low", images: true, signedIn: true },
      { id: "acme/text", name: "Text", provider: "acme", providerName: "Acme", plugin: "moss/model-acme", efforts: [], images: false, signedIn: true },
      { id: "other/locked", name: "Locked", provider: "other", providerName: "Other", plugin: "moss/model-other", efforts: [], images: true, signedIn: false },
    ];
    const withComposer = s.b.side.methods({
      localDevice: "studio0000000000000", phoneMay: s.phone.mayStart,
      composer: { models: async () => ({ models, default: "acme/large" }), commands: () => [{ name: "summary.daily", description: "Daily summary" as never }] },
    });
    const offers = (id: string, caller: Caller = s.phone.caller()) => withComposer["session.composerOffers"]!({ id }, { caller } as never) as Promise<Record<string, any>>;
    return { ...s, offers };
  }

  test("a bot's conversation: pictures, files and commands, and no model or effort row (its model is its user layer)", async () => {
    const s = await withOffers();
    expect(await s.offers(s.session)).toEqual({
      kind: "bot", pictures: true,
      pictureChunks: { maxBytes: STAGE_IMAGE_MAX_BYTES, chunkBytes: STAGE_FILE_CHUNK_BYTES },
      files: { maxBytes: STAGE_FILE_MAX_BYTES, perMessage: 10, chunkBytes: STAGE_FILE_CHUNK_BYTES },
      commands: [{ name: "summary.daily", description: "Daily summary" }], models: [], efforts: [],
    });
    await s.b.shutdown();
  });

  test("a coding session: the models whose provider is signed in, its model and effort now, the effort levels of that model", async () => {
    const s = await withOffers();
    const r = await s.offers("s_code");
    expect(r).toMatchObject({ kind: "coding", pictures: true, model: "acme/large", efforts: ["low", "high"], effort: "low" });
    expect((r.models as { id: string }[]).map((m) => m.id)).toEqual(["acme/large", "acme/text"]);
    s.b.host.update("s_code", { model: "acme/text" });
    // A model that takes no pictures: no picture row, and no chunks to send one in.
    const text = await s.offers("s_code");
    expect(text).toMatchObject({ pictures: false, model: "acme/text", efforts: [] });
    expect(text.pictureChunks).toBeUndefined();
    await s.b.shutdown();
  });

  test("the files row is there only for a phone the gate lets in now; a revoked or keyless phone reads it without", async () => {
    const keyless = await withOffers({ answerKey: false });
    expect((await keyless.offers(keyless.session)).files).toBeUndefined();
    expect((await keyless.offers(keyless.session)).pictureChunks).toBeUndefined();
    await keyless.b.shutdown();
    const s = await withOffers();
    expect((await s.offers(s.session)).files).toBeDefined();
    expect((await s.offers(s.session)).pictureChunks).toBeDefined();
    await s.phone.revoke();
    expect((await s.offers(s.session)).files).toBeUndefined();
    expect((await s.offers(s.session)).pictureChunks).toBeUndefined();
    await s.b.shutdown();
  });

  test("a session that isn't a bot's conversation or a coding session, or doesn't exist, has no composer; another computer's session offers no door", async () => {
    const s = await withOffers();
    s.b.host.open({ id: "s_agent", kind: "agent", bot: "nova", parent: s.session, computer: "Studio", backend: "claude-code" }, new FakeSessionDriver({ canFold: false }));
    s.b.host.open({ id: "s_far", kind: "coding", computer: "Laptop", backend: "claude-code" }, new FakeSessionDriver({ canFold: false }));
    await expect(s.offers("s_agent")).rejects.toThrow(/composer/);
    await expect(s.offers("s_none")).rejects.toThrow(/no session/);
    expect(await s.offers("s_far")).toMatchObject({ kind: "coding", pictures: false, models: [] });
    await s.b.shutdown();
  });

  test("the answer fits the phone link's frame with the most it can hold", async () => {
    const s = await withOffers();
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `acme/m${i}`.padEnd(200, "x"), name: "N".repeat(100), provider: "acme", providerName: "Acme", plugin: "moss/model-acme", efforts: Array.from({ length: 16 }, (_, k) => `e${k}`.padEnd(32, "z")), images: true, signedIn: true }));
    const methods = s.b.side.methods({ localDevice: "x", phoneMay: s.phone.mayStart, composer: { models: async () => ({ models: many }), commands: () => Array.from({ length: 500 }, (_, i) => ({ name: `p.cmd${i}`, description: "d".repeat(500) as never })) } });
    const r = await methods["session.composerOffers"]!({ id: "s_code" }, { caller: s.phone.caller() } as never);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(1024 * 1024 - 64 * 1024);
    await s.b.shutdown();
  });
});

describe("the folder a phone's files for coding sessions are kept in, and what removes them", () => {
  const DAY = 24 * 3600_000;
  /** A coding session's file, sent and named by a message. */
  const named = async (s: S, name: string, body: string, id: string) => {
    const r = await s.send("s_code", name, text(body));
    await s.call("session.send", { id: "s_code", message: { text: `see [File #1]`, clientMessageId: id, files: [{ n: 1, path: r.path }] } });
    return r;
  };
  const received = (s: S) => receivedRootOf(s.home);
  const fileOf = (s: S, r: Record<string, any>, name: string) => join(received(s), "s_code", `phone-${r.upload}`, name);

  test("it is a sibling of MOSS's home: ~/.moss gives ~/.moss-received, ~/.moss-dev gives ~/.moss-dev-received, a throwaway home its own sibling", () => {
    expect(receivedRootOf("/Users/a/.moss")).toBe("/Users/a/.moss-received");
    expect(receivedRootOf("/Users/a/.moss-dev/")).toBe("/Users/a/.moss-dev-received");
    expect(receivedRootOf("/tmp/x/home")).toBe("/tmp/x/home-received");
  });

  test("a throwaway home whose parent isn't the user's home never writes the user's home: coding files are refused, and nothing is made beside either", async () => {
    const s = await setup({ apart: true });
    const msg = await fail(s.send("s_code", "a.md", text("x")));
    expect(msg).toMatch(/isn't a folder of your home folder/);
    expect(existsSync(received(s))).toBe(false);
    expect(readdirSync(s.userHome)).toEqual([]);
    await s.b.shutdown();
  });

  test("under a test run nothing is written to a received folder outside the run's temp root (the preload's fence), even beside a home that looks real", async () => {
    expect(process.env.MOSS_TEST_WRITE_ROOT).toBeDefined();
    const stager = new FileStager({ home: "/moss-no-such-root/.moss", userHome: "/moss-no-such-root", computer: "Studio", now: () => 0 });
    expect(() => stager.stage({ device: "d", client: "ios" }, { kind: "coding", session: "s_code" }, { name: "a.md", size: 1, dataBase64: b64("x") })).toThrow(/outside its own temp folder/);
    expect(existsSync("/moss-no-such-root")).toBe(false);
    stager.close();
  });

  test("a file a message named is kept two weeks, then it, its folder and the session's folder go; one sent later stays", async () => {
    const s = await setup();
    const r = await named(s, "spec.md", "# spec", "m1");
    expect(existsSync(fileOf(s, r, "spec.md"))).toBe(true);
    s.clock.advance(13 * DAY);
    const later = await named(s, "later.md", "# later", "m2");
    expect(existsSync(fileOf(s, r, "spec.md"))).toBe(true);
    s.clock.advance(2 * DAY);
    expect(existsSync(fileOf(s, r, "spec.md"))).toBe(false);
    expect(existsSync(join(received(s), "s_code", `phone-${r.upload}`))).toBe(false);
    expect(readFileSync(fileOf(s, later, "later.md"), "utf8")).toBe("# later");
    s.clock.advance(14 * DAY);
    // The last one went: the session's folder and the received folder with it, so nothing is left in the person's home.
    expect(existsSync(received(s))).toBe(false);
    await s.b.shutdown();
  });

  test("a session that sends a lot keeps the newest of what messages named up to a size, the oldest go first", async () => {
    const s = await setup({ limits: { sessionKeepBytes: 10 } });
    const a = await named(s, "a.txt", "aaaaaa", "m1");
    s.clock.advance(60_000);
    const b = await named(s, "b.txt", "bbbbbb", "m2");
    s.clock.advance(60_000);
    const c = await named(s, "c.txt", "cccccc", "m3");
    s.clock.advance(6 * 60_000);
    expect(existsSync(fileOf(s, a, "a.txt"))).toBe(false);
    expect(existsSync(fileOf(s, b, "b.txt"))).toBe(false);
    expect(readFileSync(fileOf(s, c, "c.txt"), "utf8")).toBe("cccccc");
    await s.b.shutdown();
  });

  test("a session the host no longer holds has its folder and records deleted by the next sweep; one it still holds keeps them", async () => {
    const s = await setup();
    s.b.host.open({ id: "s_other", kind: "coding", computer: "Studio", backend: "claude-code" }, new FakeSessionDriver({ canFold: false }));
    const kept = await s.send("s_other", "keep.md", text("keep"));
    const r = await named(s, "spec.md", "# spec", "m1");
    await s.b.host.release("s_code");
    s.b.host.forget("s_code");
    s.clock.advance(6 * 60_000);
    expect(existsSync(join(received(s), "s_code"))).toBe(false);
    expect(readFileSync(join(received(s), "s_other", `phone-${kept.upload}`, "keep.md"), "utf8")).toBe("keep");
    expect(existsSync(fileOf(s, r, "spec.md"))).toBe(false);
    await s.b.shutdown();
  });

  test("empty session folders (and the received folder, once empty) are removed by the sweep", async () => {
    const s = await setup();
    const held = await s.send("s_code", "held.md", text("held"));
    mkdirSync(join(received(s), "s_old", "phone-aaa"), { recursive: true });
    mkdirSync(join(received(s), "s_older"));
    s.clock.advance(6 * 60_000);
    expect(existsSync(join(received(s), "s_old"))).toBe(false);
    expect(existsSync(join(received(s), "s_older"))).toBe(false);
    expect(existsSync(fileOf(s, held, "held.md"))).toBe(true);
    await s.call("session.stageFile", { id: "s_code", upload: held.upload, cancel: true });
    expect(existsSync(received(s))).toBe(false);
    await s.b.shutdown();
  });

  test("a phone-<id> folder swapped for a link to a folder the agent can't write is moved away as a link: the cleanup deletes nothing it leads to (coding)", async () => {
    const s = await setup();
    const r = await s.send("s_code", "spec.md", text("# spec"));
    const outside = join(s.userHome, "denied");
    mkdirSync(outside);
    writeFileSync(join(outside, "spec.md"), "precious");
    writeFileSync(join(outside, "other.txt"), "also precious");
    const folder = join(received(s), "s_code", `phone-${r.upload}`);
    rmSync(folder, { recursive: true });
    symlinkSync(outside, folder);
    s.clock.advance(25 * 3600_000);
    expect(readFileSync(join(outside, "spec.md"), "utf8")).toBe("precious");
    expect(readFileSync(join(outside, "other.txt"), "utf8")).toBe("also precious");
    expect(existsSync(folder)).toBe(false);
    await s.b.shutdown();
  });

  test("the same swap in the bot's scratch folder, and for the folder of a file a message named, deletes nothing it leads to", async () => {
    const s = await setup();
    const outside = join(s.userHome, "denied2");
    mkdirSync(outside);
    writeFileSync(join(outside, "a.txt"), "precious");
    const r = await s.send(s.session, "a.txt", text("hello"));
    const folder = join(s.scratch, "attachments", `phone-${r.upload}`);
    rmSync(folder, { recursive: true });
    symlinkSync(outside, folder);
    await s.call("session.stageFile", { id: s.session, upload: r.upload, cancel: true });
    expect(readFileSync(join(outside, "a.txt"), "utf8")).toBe("precious");
    expect(existsSync(folder)).toBe(false);
    // A named coding file, swapped before its two weeks are up.
    const n = await named(s, "a.txt", "named", "m1");
    const nf = join(received(s), "s_code", `phone-${n.upload}`);
    rmSync(nf, { recursive: true });
    symlinkSync(outside, nf);
    s.clock.advance(15 * DAY);
    expect(readFileSync(join(outside, "a.txt"), "utf8")).toBe("precious");
    expect(existsSync(nf)).toBe(false);
    await s.b.shutdown();
  });
});

// Keeps the helper type referenced when the suite runs alone.
export type { TestPhone };
