// `session.stagePicture` (PH3 follow-up, 2026-11-24): a picture from a paired phone, in chunks. The phone's link ends a stream at 1 MiB a frame
// (`IROH_MAX_FRAME_BYTES`), so `session.stageImage`'s single request (sized to the desktop's 8 MiB line) cannot carry an ordinary photo from a
// phone; a 4 MiB picture goes here in 512 KiB chunks, each request under the frame, is checked by its first bytes at once and as a whole at the
// end by the desktop door's own checks, and is named by the phone's next `session.send` as `images`. The desktop's `session.stageImage` is untouched.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { IROH_MAX_FRAME_BYTES, STAGE_FILE_CHUNK_BYTES, STAGE_IMAGE_MAX_BYTES, type Caller } from "@waifucave/moss-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { pairedPhone } from "../../agents/tests/phone";
import type { StageLimits } from "../staged-files";
import { boot, removeTemps, tempDir } from "./fixtures";

const oldTmp = process.env.MOSS_TMPDIR;
afterEach(() => {
  removeTemps();
  if (oldTmp === undefined) delete process.env.MOSS_TMPDIR;
  else process.env.MOSS_TMPDIR = oldTmp;
});

const DESKTOP: Caller = { kind: "user", client: "app" };
const b64 = (s: Uint8Array) => Buffer.from(s).toString("base64");

/** A picture of `size` bytes that begins as a JPEG does (the bytes are never decoded, only told by their first bytes). */
const jpeg = (size: number, fill = 7): Uint8Array => {
  const out = new Uint8Array(size).fill(fill);
  out.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01].slice(0, size), 0);
  return out;
};
const png = (size: number): Uint8Array => {
  const out = new Uint8Array(size).fill(3);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return out;
};

async function setup(o: { limits?: Partial<StageLimits> } = {}) {
  const clock = new FakeClock();
  const userHome = tempDir();
  // A picture is staged in the session's own temp folder: this test's is inside its own temp home.
  process.env.MOSS_TMPDIR = join(userHome, "os-tmp");
  mkdirSync(process.env.MOSS_TMPDIR, { recursive: true });
  const home = join(userHome, ".moss");
  mkdirSync(home, { recursive: true });
  const phone = await pairedPhone(clock);
  const b = await boot({ home, userHome, clock, plugins: [], botSource: "records", computer: "Studio" });
  const all = b.side.methods({ localDevice: "studio0000000000000", phoneMay: phone.mayStart, ...(o.limits === undefined ? {} : { stageLimits: o.limits }) });
  /** Every request a call makes, measured as the phone link would carry it. */
  const frames: number[] = [];
  const call = (method: string, params: unknown, caller: Caller = phone.caller()) => {
    frames.push(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 9007199254740991, method, params })));
    return all[method]!(params, { caller } as never) as Promise<Record<string, any>>;
  };
  await call("bot.create", { name: "Nova" }, DESKTOP);
  frames.length = 0;
  const session = b.bots.mainSession("nova");
  b.host.open({ id: "s_code", kind: "coding", computer: "Studio", backend: "claude-code" }, new FakeSessionDriver({ canFold: false }));
  const picture = async (id: string, mediaType: string, bytes: Uint8Array, caller: Caller = phone.caller(), chunk = STAGE_FILE_CHUNK_BYTES) => {
    let r = await call("session.stagePicture", { id, mediaType, size: bytes.length, dataBase64: b64(bytes.subarray(0, chunk)) }, caller);
    for (let at = chunk; at < bytes.length; at += chunk) r = await call("session.stagePicture", { id, upload: r.upload, offset: at, dataBase64: b64(bytes.subarray(at, at + chunk)) }, caller);
    return r;
  };
  const spool = join(home, "transcripts", ".staged-files");
  return { clock, userHome, home, phone, b, call, session, picture, frames, all, spool };
}
type S = Awaited<ReturnType<typeof setup>>;
const fail = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const sentInput = (s: S, id: string) => (s.b.host.history(id, { afterSeq: -1, limit: 200 }).filter((r) => r.type === "input" && r.input.from === "user").at(-1) as { input: { images?: { n: number; path: string }[] } } | undefined)?.input;

describe("a picture from a paired phone", () => {
  test("a 4 MiB picture crosses the phone's link in frames under its 1 MiB limit, is staged whole, and is named by the next send; the same picture in one request could not cross", async () => {
    const s = await setup();
    const body = jpeg(4 * 1024 * 1024);
    // In one request, as `session.stageImage` takes it, the picture is over the frame the phone's link carries.
    expect(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.stageImage", params: { id: s.session, mediaType: "image/jpeg", dataBase64: b64(body) } }))).toBeGreaterThan(IROH_MAX_FRAME_BYTES);
    const r = await s.picture(s.session, "image/jpeg", body);
    expect(r).toMatchObject({ received: body.length, done: true });
    // Eight chunks, each a request the link carries.
    expect(s.frames).toHaveLength(8);
    for (const f of s.frames) expect(f).toBeLessThan(IROH_MAX_FRAME_BYTES);
    // The bytes are in the session's image folder, as the desktop's door puts them, owner-only.
    expect(r.path).toBe(join(process.env.MOSS_TMPDIR!, `moss-session-${s.session}`, "images", "image_1.jpg").replace(/^\/var\//, "/private/var/"));
    expect(Buffer.compare(readFileSync(r.path), Buffer.from(body))).toBe(0);
    if (process.platform !== "win32") expect(statSync(r.path).mode & 0o777).toBe(0o600);
    // Nothing is left half-written, and the ledger holds no upload for it.
    expect(readdirSync(s.spool)).toEqual([]);
    await s.call("session.send", { id: s.session, message: { text: "look at [Image #1]", clientMessageId: "m1", images: [{ n: 1, path: r.path }] } });
    expect(sentInput(s, s.session)).toMatchObject({ images: [{ n: 1, path: r.path }] });
    await s.b.shutdown();
  });

  test("a picture for a coding session works the same, and the first chunk alone can be a whole small picture", async () => {
    const s = await setup();
    const small = png(2000);
    const r = await s.picture("s_code", "image/png", small);
    expect(r).toMatchObject({ received: 2000, done: true });
    expect(Buffer.compare(readFileSync(r.path), Buffer.from(small))).toBe(0);
    await s.call("session.send", { id: "s_code", message: { text: "[Image #1]", clientMessageId: "c1", images: [{ n: 1, path: r.path }] } });
    expect(sentInput(s, "s_code")).toMatchObject({ images: [{ n: 1, path: r.path }] });
    await s.b.shutdown();
  });

  test("a message may name only a picture this device staged for this session: another's, another session's and one nobody staged are refused", async () => {
    const s = await setup();
    const mine = await s.picture(s.session, "image/jpeg", jpeg(700_000));
    const other = await pairedPhone(s.clock, { os: "android" });
    const all2 = s.b.side.methods({ localDevice: "x", phoneMay: (d: string) => s.phone.mayStart(d) || other.mayStart(d) });
    const call2 = (m: string, p: unknown, caller: Caller) => all2[m]!(p, { caller } as never) as Promise<Record<string, any>>;
    // Another device cannot name mine, and mine cannot be named for a session it wasn't staged for.
    expect(await fail(call2("session.send", { id: s.session, message: { text: "[Image #1]", clientMessageId: "x1", images: [{ n: 1, path: mine.path }] } }, other.caller("android")))).toMatch(/isn't an image this device staged/);
    expect(await fail(s.call("session.send", { id: "s_code", message: { text: "[Image #1]", clientMessageId: "x2", images: [{ n: 1, path: mine.path }] } }))).toMatch(/isn't an image this device staged/);
    expect(await fail(s.call("session.send", { id: s.session, message: { text: "[Image #1]", clientMessageId: "x3", images: [{ n: 1, path: "/etc/hosts" }] } }))).toMatch(/isn't an image this device staged/);
    await s.b.shutdown();
  });

  test("what isn't a picture is refused at the first chunk, before the rest is sent: wrong bytes, a type that disagrees, too big, too short to tell", async () => {
    const s = await setup();
    const not = new Uint8Array(1000).fill(65);
    expect(await fail(s.picture(s.session, "image/png", not))).toMatch(/Only PNG, JPEG/);
    expect(await fail(s.picture(s.session, "image/png", jpeg(1000)))).toMatch(/is image\/jpeg, not the declared image\/png/);
    expect(await fail(s.call("session.stagePicture", { id: s.session, mediaType: "image/jpeg", size: STAGE_IMAGE_MAX_BYTES + 1, dataBase64: b64(jpeg(100)) }))).toMatch(/size|too big|at most/i);
    expect(await fail(s.call("session.stagePicture", { id: s.session, mediaType: "image/jpeg", size: 100_000, dataBase64: b64(jpeg(4)) }))).toMatch(/too short/);
    // A script or a program dressed as a picture is no picture.
    expect(await fail(s.picture(s.session, "image/jpeg", new TextEncoder().encode("#!/bin/sh\nrm -rf ~\n")))).toMatch(/Only PNG, JPEG/);
    // Nothing was held for any of them: the spool was never even made.
    expect(existsSync(s.spool) ? readdirSync(s.spool) : []).toEqual([]);
    await s.b.shutdown();
  });

  test("a whole picture that fails the desktop door's own checks is dropped, whole: a cut-off or padded upload, and chunks out of order", async () => {
    const s = await setup();
    const first = await s.call("session.stagePicture", { id: s.session, mediaType: "image/jpeg", size: 600_000, dataBase64: b64(jpeg(STAGE_FILE_CHUNK_BYTES)) });
    expect(first).toMatchObject({ received: STAGE_FILE_CHUNK_BYTES, done: false });
    // The next chunk must start where the last one ended.
    expect(await fail(s.call("session.stagePicture", { id: s.session, upload: first.upload, offset: 5, dataBase64: b64(jpeg(1000)) }))).toMatch(/next chunk starts at byte/);
    // Chunks past the size said drop the upload.
    expect(await fail(s.call("session.stagePicture", { id: s.session, upload: first.upload, offset: STAGE_FILE_CHUNK_BYTES, dataBase64: b64(new Uint8Array(200_000)) }))).toMatch(/longer than/);
    expect(await fail(s.call("session.stagePicture", { id: s.session, upload: first.upload, offset: STAGE_FILE_CHUNK_BYTES, dataBase64: b64(new Uint8Array(10)) }))).toMatch(/no such upload/);
    expect(readdirSync(s.spool)).toEqual([]);
    await s.b.shutdown();
  });

  test("a picture and a file are two doors: an upload begun at one cannot be continued or cancelled at the other", async () => {
    const s = await setup();
    const p = await s.call("session.stagePicture", { id: s.session, mediaType: "image/jpeg", size: 1_000_000, dataBase64: b64(jpeg(STAGE_FILE_CHUNK_BYTES)) });
    expect(await fail(s.call("session.stageFile", { id: s.session, upload: p.upload, offset: STAGE_FILE_CHUNK_BYTES, dataBase64: b64(jpeg(1000)) }))).toMatch(/no such upload/);
    expect(await fail(s.call("session.stageFile", { id: s.session, upload: p.upload, cancel: true }))).toMatch(/no such upload/);
    const f = await s.call("session.stageFile", { id: s.session, name: "a.txt", size: 1_000_000, dataBase64: b64(new Uint8Array(STAGE_FILE_CHUNK_BYTES).fill(65)) });
    expect(await fail(s.call("session.stagePicture", { id: s.session, upload: f.upload, offset: STAGE_FILE_CHUNK_BYTES, dataBase64: b64(jpeg(1000)) }))).toMatch(/no such upload/);
    // The phone can drop its own picture.
    await s.call("session.stagePicture", { id: s.session, upload: p.upload, cancel: true });
    expect(existsSync(join(s.spool, `${p.upload}.part`))).toBe(false);
    await s.b.shutdown();
  });

  test("pictures count in the device's limits: the open uploads, the bytes a day, and the files a day", async () => {
    const s = await setup({ limits: { dayBytes: 3_000_000, dayFiles: 3, openPerDevice: 2 } });
    await s.picture(s.session, "image/jpeg", jpeg(1_200_000));
    await s.picture(s.session, "image/jpeg", jpeg(1_200_000));
    expect(await fail(s.picture(s.session, "image/jpeg", jpeg(1_200_000)))).toMatch(/at most 3 MB a day|a day/);
    // Open ones: two may be on their way at once, the third waits.
    const s2 = await setup({ limits: { openPerDevice: 2 } });
    for (let i = 0; i < 2; i++) await s2.call("session.stagePicture", { id: s2.session, mediaType: "image/jpeg", size: 1_000_000, dataBase64: b64(jpeg(STAGE_FILE_CHUNK_BYTES)) });
    expect(await fail(s2.call("session.stagePicture", { id: s2.session, mediaType: "image/jpeg", size: 1_000_000, dataBase64: b64(jpeg(STAGE_FILE_CHUNK_BYTES)) }))).toMatch(/can be on their way at once/);
    await s.b.shutdown();
    await s2.b.shutdown();
  });

  test("a picture half-sent is removed after the idle time, as a half-sent file is", async () => {
    const s = await setup();
    const first = await s.call("session.stagePicture", { id: s.session, mediaType: "image/jpeg", size: 1_000_000, dataBase64: b64(jpeg(STAGE_FILE_CHUNK_BYTES)) });
    expect(existsSync(join(s.spool, `${first.upload}.part`))).toBe(true);
    s.clock.advance(16 * 60_000);
    expect(await fail(s.call("session.stagePicture", { id: s.session, upload: first.upload, offset: STAGE_FILE_CHUNK_BYTES, dataBase64: b64(jpeg(100)) }))).toMatch(/no such upload/);
    expect(existsSync(join(s.spool, `${first.upload}.part`))).toBe(false);
    await s.b.shutdown();
  });

  test("who may: a phone paired with an answer key, to a session here; the desktop, a bot, a plugin and an unpaired phone are refused; the desktop's own door is the one it was", async () => {
    const s = await setup();
    const params = { id: s.session, mediaType: "image/jpeg", size: 100, dataBase64: b64(jpeg(100)) };
    for (const caller of [DESKTOP, { kind: "plugin", pluginId: "spy" }, { kind: "core" }, { kind: "session", sessionId: s.session, sessionKind: "bot", bot: "nova" }, { kind: "user", client: "ios" }, { kind: "user", client: "ios", device: "z".repeat(32) }] as Caller[]) {
      expect(await fail(s.call("session.stagePicture", params, caller))).not.toBe("ok");
    }
    // An unknown session, a session another computer runs and a session that isn't a conversation.
    expect(await fail(s.call("session.stagePicture", { ...params, id: "s_none" }))).toMatch(/no session/);
    s.b.host.open({ id: "s_far", kind: "coding", computer: "Laptop", backend: "claude-code" }, new FakeSessionDriver({ canFold: false }));
    expect(await fail(s.call("session.stagePicture", { ...params, id: "s_far" }))).toMatch(/runs on Laptop/);
    // The desktop's own call still stages a small picture in one request, exactly as it did.
    const png1 = png(300);
    const desk = await s.call("session.stageImage", { id: s.session, mediaType: "image/png", dataBase64: b64(png1) }, DESKTOP);
    expect(Buffer.compare(readFileSync(desk.path), Buffer.from(png1))).toBe(0);
    await s.phone.revoke();
    expect(await fail(s.call("session.stagePicture", params))).toMatch(/isn't paired with an answer key/);
    await s.b.shutdown();
  });
});
