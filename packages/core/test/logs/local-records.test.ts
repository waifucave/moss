// The engine's local records (the deletion lane, item 6): the session cleaner's record keeps no title, and the four
// append-only records (`audit.jsonl`, `routines-audit.jsonl`, `memory/audit.jsonl`, `cleaner.jsonl`) rotate the way the
// engine log does: past 8 MB the file becomes `<name>.1` (one previous generation, overwritten) and a fresh one starts.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCleanerLog } from "../../src/sessions/cleaner-log";
import { appendRotating, LOCAL_LOG_MAX_BYTES } from "../../src/append-log";
import { AuditLog } from "../../src/peripheral/audit";
import { RoutineAuditLog } from "../../src/routines/audit";
import { MemoryStore } from "../../src/agent/memory";
import { SessionStore } from "../../src/sessions/store";
import { reapEmptySessions } from "../../src/sessions/reaper";

const home = (): string => mkdtempSync(join(tmpdir(), "moss-local-records-"));

/** A file already at the cap, without writing 8 MB: a sparse file of that length. */
function full(path: string): void {
  writeFileSync(path, "");
  truncateSync(path, LOCAL_LOG_MAX_BYTES);
}

describe("the cleaner's record keeps no title", () => {
  test("appendCleanerLog writes the id, reason and time, never a title even when one is passed", () => {
    const h = home();
    appendCleanerLog(h, { sessionId: "s_1", reason: "reaped: empty", date: "2026-11-24T00:00:00.000Z", ...({ title: "My secret plans" } as object) });
    const text = readFileSync(join(h, "cleaner.jsonl"), "utf8");
    expect(text).not.toContain("My secret plans");
    expect(JSON.parse(text.trim())).toEqual({ sessionId: "s_1", reason: "reaped: empty", date: "2026-11-24T00:00:00.000Z" });
  });

  test("the reaper's line for a titled session has no title", () => {
    const h = home();
    const store = new SessionStore(h);
    const id = store.createSession("global");
    store.append(id, { type: "session_titled", sessionId: id, threadId: "main", title: "Untitled experiment" });
    const created = store.list().find((r) => r.sessionId === id)!;
    const reaped = reapEmptySessions({ store, attachedCount: () => 0, home: h, now: () => created.createdAt + 3_600_000 });
    expect(reaped).toEqual([id]);
    expect(readFileSync(join(h, "cleaner.jsonl"), "utf8")).not.toContain("Untitled experiment");
    store.close();
  });
});

describe("the local records rotate at the engine log's size", () => {
  test("appendRotating: past the cap the file becomes .1 and a new one starts", () => {
    const h = home();
    const path = join(h, "x.jsonl");
    full(path);
    appendRotating(path, "{\"a\":1}\n");
    expect(statSync(`${path}.1`).size).toBe(LOCAL_LOG_MAX_BYTES);
    expect(readFileSync(path, "utf8")).toBe("{\"a\":1}\n");
    // Once more: the previous generation is overwritten, never a .2.
    full(path);
    appendRotating(path, "{\"b\":2}\n");
    expect(readFileSync(path, "utf8")).toBe("{\"b\":2}\n");
    expect(existsSync(`${path}.2`)).toBe(false);
  });

  test("cleaner.jsonl rotates", () => {
    const h = home();
    full(join(h, "cleaner.jsonl"));
    appendCleanerLog(h, { sessionId: "s_2", reason: "reaped: empty", date: "2026-11-24T00:00:00.000Z" });
    expect(existsSync(join(h, "cleaner.jsonl.1"))).toBe(true);
    expect(statSync(join(h, "cleaner.jsonl")).size).toBeLessThan(200);
  });

  test("audit.jsonl (device leases) rotates", () => {
    const h = home();
    const path = join(h, "audit.jsonl");
    full(path);
    new AuditLog(path).append({ action: "acquire" });
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(path).size).toBeLessThan(200);
  });

  test("routines-audit.jsonl rotates", () => {
    const h = home();
    const path = join(h, "routines-audit.jsonl");
    full(path);
    new RoutineAuditLog(path).append({ event: "fire" });
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(path).size).toBeLessThan(200);
  });

  test("memory/audit.jsonl rotates", async () => {
    const h = home();
    mkdirSync(join(h, "memory"), { recursive: true });
    const path = join(h, "memory", "audit.jsonl");
    full(path);
    const mem = new MemoryStore({ mossHome: h, trust: { isTrusted: () => true } });
    const res = await mem.write("user", { name: "pets", description: "d", type: "user", body: "has a cat" } as never, { source: "rpc" });
    expect(res).toMatchObject({ ok: true });
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(path).size).toBeLessThan(400);
  });
});
