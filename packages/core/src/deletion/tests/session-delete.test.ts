// Deleting a session (the deletion lane, item 3): the person only; the session, the sessions it started and every file a
// session id names under the home (and its staged images' temp folder) go; a stop in the middle is finished at the next
// start; nothing outside what it names is touched, and a link in its folders is removed, never followed.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { MOSS_ERR } from "@waifucave/moss-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import type { CardOpener, MethodContext } from "../../devices/rpc";
import { DurableSessionHost } from "../../sessions/durable-host";
import { outdirPath } from "../../sessions/outdir";
import { transcriptPaths } from "../../agents/transcript";
import { sessionTmpDirPath } from "../../agent/session-tmp";
import { runtimeStderrPath } from "../../runtime-sdk/turn-loop/runtime-stderr";
import { deleteSession, sessionDeletionMethods } from "../session-rpc";
import { finishSessionDeletions, journalSessionDeletion } from "../session-files";
import { receivedRootOf } from "../../bots/staged-files";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function world() {
  const home = mkdtempSync(join(tmpdir(), "moss-session-del-"));
  const tmp = mkdtempSync(join(tmpdir(), "moss-session-tmp-"));
  const before = process.env.MOSS_TMPDIR;
  process.env.MOSS_TMPDIR = tmp;
  const outside = mkdtempSync(join(tmpdir(), "moss-outside-"));
  writeFileSync(join(outside, "keep.txt"), "the person's file");
  const clock = new FakeClock({ start: 1_800_000_000_000 });
  const host = new DurableSessionHost({ home, clock, approvals: new FakeApprovalBroker({ clock }), warn: () => {} });
  cleanups.push(() => {
    if (before === undefined) delete process.env.MOSS_TMPDIR;
    else process.env.MOSS_TMPDIR = before;
    for (const d of [home, tmp, outside, receivedRootOf(home)]) rmSync(d, { recursive: true, force: true });
  });
  const deletedRuntime: string[] = [];
  const removed: string[] = [];
  const deps = {
    home, host, openCard: (async () => ({ allowed: Promise.resolve(false) })) as CardOpener,
    files: { deleteRuntimeTranscript: async (b: string) => void deletedRuntime.push(b) },
    bots: { mainSession: () => "none", conversationDeleted: async () => undefined, sessionRemoved: (id: string) => void removed.push(id) },
  };
  return { home, tmp, outside, host, clock, deps, deletedRuntime, removed };
}

/** Every file and folder under `root` whose path names `needle`. */
function named(root: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.name.includes(needle)) out.push(relative(root, p));
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
    }
  };
  walk(root);
  return out;
}

/** The files the writers keep beside a session, made where each writer makes them. */
function writeSideFiles(home: string, id: string, outside: string): void {
  mkdirSync(join(home, "sessions-runtime"), { recursive: true });
  writeFileSync(join(home, "sessions-runtime", `${id}.json`), JSON.stringify({ backendSessionId: "0b5b7c2e-1111-4222-8333-944455556666" }));
  writeFileSync(runtimeStderrPath(home, id), "SENTINEL stderr");
  mkdirSync(outdirPath(home, id), { recursive: true });
  writeFileSync(join(outdirPath(home, id), "report.md"), "out");
  // A link the session's outputs folder holds to the person's own folder: removed as a link, never followed.
  symlinkSync(outside, join(outdirPath(home, id), "link-out"));
  const agents = transcriptPaths(home, id).dir;
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "acp.ndjson"), "{}");
  mkdirSync(join(home, "scratch", "_", id), { recursive: true });
  writeFileSync(join(home, "scratch", "_", id, "work.txt"), "w");
  mkdirSync(sessionTmpDirPath(id), { recursive: true });
  writeFileSync(join(sessionTmpDirPath(id), "image.png"), "png");
  // A file a paired phone sent to it, in the folder beside the home.
  mkdirSync(join(receivedRootOf(home), id, "phone-1"), { recursive: true });
  writeFileSync(join(receivedRootOf(home), id, "phone-1", "notes.pdf"), "pdf");
}

describe("deleting a session", () => {
  test("every file its id names goes, with the sessions it started; the person's files and other sessions stay", async () => {
    const w = world();
    w.host.open({ id: "c_aaaa11112222", kind: "coding", computer: "Studio" }, new FakeSessionDriver());
    w.host.open({ id: "a_child1111222", kind: "agent", parent: "c_aaaa11112222", computer: "Studio" }, new FakeSessionDriver());
    w.host.open({ id: "c_other1112222", kind: "coding", computer: "Studio" }, new FakeSessionDriver());
    await w.host.sendUser("c_aaaa11112222", { text: "SENTINEL message", device: "studio000000000000", sentAt: w.clock.now(), clientMessageId: "m1" });
    writeSideFiles(w.home, "c_aaaa11112222", w.outside);
    writeSideFiles(w.home, "a_child1111222", w.outside);

    const gone = await deleteSession(w.deps, "c_aaaa11112222");
    expect(gone.sort()).toEqual(["a_child1111222", "c_aaaa11112222"]);
    for (const id of gone) {
      expect(named(w.home, id)).toEqual([]);
      expect(existsSync(join(receivedRootOf(w.home), id))).toBe(false);
      expect(named(w.tmp, id)).toEqual([]);
      expect(w.host.get(id)).toBeUndefined();
    }
    expect(w.removed.sort()).toEqual(gone.sort());
    expect(w.deletedRuntime).toHaveLength(2);
    // The link was removed as a link: what it pointed to is untouched.
    expect(readFileSync(join(w.outside, "keep.txt"), "utf8")).toBe("the person's file");
    // Another session stays.
    expect(w.host.get("c_other1112222")).toBeDefined();
    expect(named(w.home, "c_other1112222").length).toBeGreaterThan(0);
    // No journal left behind.
    expect(existsSync(join(w.home, "transcripts", "deleting.json"))).toBe(false);
  });

  test("a restart doesn't bring it back", async () => {
    const w = world();
    w.host.open({ id: "c_bbbb11112222", kind: "coding", computer: "Studio" }, new FakeSessionDriver());
    await w.host.sendUser("c_bbbb11112222", { text: "hello", device: "studio000000000000", sentAt: w.clock.now(), clientMessageId: "m1" });
    await deleteSession(w.deps, "c_bbbb11112222");
    await w.host.close();
    const again = new DurableSessionHost({ home: w.home, clock: w.clock, approvals: new FakeApprovalBroker({ clock: w.clock }), warn: () => {} });
    expect(again.get("c_bbbb11112222")).toBeUndefined();
    await again.close();
  });

  test("half done: what the journal names is finished at the next start", async () => {
    const w = world();
    writeSideFiles(w.home, "c_cccc11112222", w.outside);
    journalSessionDeletion(w.home, [{ id: "c_cccc11112222", kind: "coding" }]);
    expect(await finishSessionDeletions({ home: w.home })).toBe(1);
    expect(named(w.home, "c_cccc11112222")).toEqual([]);
    expect(named(w.tmp, "c_cccc11112222")).toEqual([]);
    expect(existsSync(join(w.home, "transcripts", "deleting.json"))).toBe(false);
  });
});

describe("session.delete: who may ask", () => {
  const callers: [string, unknown][] = [
    ["a bot's or an agent's session", { kind: "session", sessionId: "b_alpha" }],
    ["a plugin", { kind: "plugin", pluginId: "acme/thing" }],
    ["a peer computer", { kind: "peer", device: "x" }],
  ];
  for (const [who, caller] of callers) {
    test(`${who} is refused, and nothing is deleted`, async () => {
      const w = world();
      w.host.open({ id: "c_dddd11112222", kind: "coding", computer: "Studio" }, new FakeSessionDriver());
      const m = sessionDeletionMethods(w.deps);
      const err = await m["session.delete"]!({ id: "c_dddd11112222", confirm: true }, { caller } as MethodContext).catch((e: unknown) => e);
      expect((err as { code?: number }).code).toBe(MOSS_ERR.NOT_THE_USER);
      expect(w.host.get("c_dddd11112222")).toBeDefined();
    });
  }

  test("the person's terminal needs its own confirmation", async () => {
    const w = world();
    w.host.open({ id: "c_eeee11112222", kind: "coding", computer: "Studio" }, new FakeSessionDriver());
    const m = sessionDeletionMethods(w.deps);
    const ctx = { caller: { kind: "user", client: "cli" } } as MethodContext;
    await expect(m["session.delete"]!({ id: "c_eeee11112222" }, ctx)).rejects.toBeDefined();
    expect(w.host.get("c_eeee11112222")).toBeDefined();
    expect(await m["session.delete"]!({ id: "c_eeee11112222", confirm: true }, ctx)).toEqual({ applied: true });
    expect(w.host.get("c_eeee11112222")).toBeUndefined();
  });

  test("an app gets the engine's card; a no deletes nothing", async () => {
    const w = world();
    w.host.open({ id: "c_ffff11112222", kind: "coding", computer: "Studio", title: "Plans" }, new FakeSessionDriver());
    let asked: { change?: string; fields?: { detail?: { rows: { value: string }[] } } } | undefined;
    const openCard: CardOpener = async (req) => {
      asked = req as typeof asked;
      return { card: "card_abc123", allowed: Promise.resolve(false) };
    };
    const m = sessionDeletionMethods({ ...w.deps, openCard });
    const res = await m["session.delete"]!({ id: "c_ffff11112222", confirm: true }, { caller: { kind: "user", client: "app" } } as MethodContext);
    expect(res).toEqual({ applied: false, card: "card_abc123" });
    expect(asked?.change).toBe("session-delete");
    expect(asked?.fields?.detail?.rows[0]?.value).toBe("Plans");
    await Bun.sleep(10);
    expect(w.host.get("c_ffff11112222")).toBeDefined();
  });
});
