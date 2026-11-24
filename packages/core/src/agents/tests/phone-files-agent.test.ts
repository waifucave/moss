// A file a phone sends to a coding session reaches the agent as a path it CAN open (PH3 follow-up, 2026-11-24). A coding agent's
// sandbox denies the whole MOSS home and the manager refuses any request into it, so a file in `outputs/<session>/received/` (where
// a first version put it) could not be read by any agent. The file is staged in `.moss-received/<session>/` in the user's home
// instead, named in the message by its folder-tree path, and the agent is told the real one. Over the real manager, the real stager
// and the scripted ACP agent, which reads the paths it is told the way an agent does and honours the sandbox policy its start was given.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { FileStager, RECEIVED_FOLDER, stageTargetOf } from "../../bots/staged-files";
import { waitFor, World, type WorldOptions } from "./world";

setDefaultTimeout(60_000);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const DEVICE = "d".repeat(32);
const WHO = { device: DEVICE, client: "ios" };
const b64 = (s: string) => Buffer.from(s).toString("base64");

async function setup(o: WorldOptions = {}) {
  const w = (world = new World({ script: [[{ say: "ready" }], [{ readNamed: true }, { say: "read them" }]], ...o }));
  let fence: { denyRead: string[]; allowWrite: string[] } | undefined;
  const start = w.backend.start.bind(w.backend);
  w.backend.start = async (spec) => ((fence = spec.fence as typeof fence), start(spec));
  const { sessionId } = await w.manager.start({
    caller: { kind: "user", device: DEVICE, clientMessageId: "m1" }, backend: "fake", prompt: "hello", root: "home/Studio/project1", title: "From the phone",
  });
  await waitFor(() => w.report("prompt").length === 1, "the first turn");
  const stager = new FileStager({ home: w.mossHome, userHome: w.userHome, computer: w.computer, now: () => w.clock.now() });
  const target = () => {
    const t = stageTargetOf(w.host.get(sessionId)!, { mainSession: () => "", botsRunHere: () => [] }, w.computer);
    if (!("target" in t)) throw new Error(t.refusal);
    return t.target;
  };
  const stage = (name: string, text: string) => stager.stage(WHO, target(), { name, size: Buffer.byteLength(text), dataBase64: b64(text) });
  const send = (id: string, text: string, files: { n: number; path: string }[]) =>
    w.host.sendUser(sessionId, { text, device: DEVICE, sentAt: w.clock.now(), clientMessageId: id, files });
  return { w, sessionId, stager, stage, send, fence: () => fence! };
}

describe("a phone's file to a coding session", () => {
  test("the agent is told a real path, outside MOSS's home and outside what its sandbox denies, and reads the bytes there", async () => {
    const s = await setup();
    const staged = s.stage("notes.txt", "the phone's note");
    expect(staged.done).toBe(true);
    // The message names it by its folder-tree path, as every file in a message is; the agent is told the real one.
    expect(staged.path).toBe(`home/Studio/${RECEIVED_FOLDER}/${s.sessionId}/phone-${staged.upload}/notes.txt`);
    const real = join(s.w.userHome, RECEIVED_FOLDER, s.sessionId, `phone-${staged.upload}`, "notes.txt");
    expect(realpathSync(real)).toBe(real);
    // Not in MOSS's home, not in the project, outside every folder the agent's sandbox is denied reading.
    expect(real.startsWith(realpathSync(s.w.mossHome) + sep)).toBe(false);
    expect(real.startsWith(s.w.project + sep)).toBe(false);
    const fence = s.fence();
    expect(fence.denyRead).toContain(s.w.mossHome);
    expect(fence.denyRead.some((d) => real === d || real.startsWith(d + sep))).toBe(false);

    await s.send("m2", "read [File #1]", [{ n: 1, path: staged.path! }]);
    const read = await waitFor(() => s.w.report("file-read")[0], "the agent's read");
    // It was told the real path, asked to read it, was let (no card at this level, no moss-home refusal), and read the phone's bytes.
    expect(s.w.report("prompt")[1]!["text"]).toContain(`[File #1: ${real}]`);
    expect(s.w.report("prompt")[1]!["text"]).not.toContain("home/Studio/");
    expect(read).toMatchObject({ path: real, outcome: "read", text: "the phone's note" });
    expect(s.w.report("answer").map((a) => (a as { kind?: string }).kind)).toEqual(["allow_once"]);
    expect(s.w.approvals.cards()).toEqual([]);
    if (process.platform !== "win32") expect(statSync(real).mode & 0o777).toBe(0o600);
  });

  test("the first version's place could not be read by any agent: a file in outputs/<session>/received/ is refused as the MOSS home, without a card", async () => {
    const s = await setup();
    const old = join(s.w.mossHome, "outputs", s.sessionId, "received", "phone-x");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "notes.txt"), "the phone's note");
    await s.send("m2", "read [File #1]", [{ n: 1, path: join(old, "notes.txt") }]);
    const read = await waitFor(() => s.w.report("file-read")[0], "the agent's read");
    expect(read).toMatchObject({ outcome: "refused" });
    expect(s.w.approvals.cards()).toEqual([]);
  });

  test("a link planted where the file goes leads nowhere: the received folder, or the session's folder in it, as a link is refused and nothing is written outside", async () => {
    const s = await setup();
    const elsewhere = join(s.w.root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const received = join(s.w.userHome, RECEIVED_FOLDER);
    // The session's folder, as a link (a sandboxed agent may write the home, so it could have put it there).
    mkdirSync(received, { recursive: true });
    symlinkSync(elsewhere, join(received, s.sessionId));
    expect(() => s.stage("a.txt", "x")).toThrow(/plain folder|nothing was written/);
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(join(received, s.sessionId));
    // The received folder itself, as a link.
    rmSync(received, { recursive: true, force: true });
    symlinkSync(elsewhere, received);
    expect(() => s.stage("a.txt", "x")).toThrow(/plain folder of yours/);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(join(elsewhere, s.sessionId))).toBe(false);
  });
});
