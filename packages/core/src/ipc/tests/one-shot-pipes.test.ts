// The one-shot pipes (Windows' naming of a client): the logic with seams, on every OS; the real pipes are in test/platform/one-shot-pipes-windows.test.ts.
import { describe, expect, test } from "bun:test";
import { OneShotPipes, OneShotRefused } from "../one-shot-pipes";

type H = { open(s: object): void; close(s: object): void; data(s: object, c: unknown): void };
function rig(over: Partial<ConstructorParameters<typeof OneShotPipes>[0]> = {}) {
  const log: string[] = [];
  const adopted: Array<[object, number]> = [];
  const closed: object[] = [];
  const opened: object[] = [];
  const listeners = new Map<string, { h: H; stopped: boolean }>();
  const pipes = new OneShotPipes({
    endpoint: "\\\\.\\pipe\\moss-core-abc",
    handlers: { open: (s: object) => { opened.push(s); }, close() {}, data() {} } as never,
    adopt: (s: object, pid: number) => { adopted.push([s, pid]); },
    closeAtOnce: (s: object) => { closed.push(s); },
    userSid: () => "S-1-5-21-1",
    listen: (path, h) => { const l = { h: h as unknown as H, stopped: false }; listeners.set(path, l); return { stop: () => { l.stopped = true; log.push(`stop ${path.slice(-4)}`); } }; },
    lock: () => 1,
    userOf: () => "S-1-5-21-1",
    ...over,
  });
  return { pipes, log, adopted, closed, opened, listeners };
}

describe("OneShotPipes", () => {
  test("a rendezvous names a fresh unguessable pipe under the well-known one's name", () => {
    const { pipes } = rig();
    const a = pipes.issue(), b = pipes.issue();
    expect(a.pipe).toMatch(/^\\\\\.\\pipe\\moss-core-abc-[0-9a-f]{32}$/);
    expect(a.pipe).not.toBe(b.pipe);
    expect(a.ttlMs).toBe(5000);
  });

  test("the one connection with exactly one connected end is named by that end's pid, and the listener stops", () => {
    const { pipes, adopted, opened, listeners, closed } = rig({ ends: () => ({ used: 1, pids: [4242] }) });
    const { pipe } = pipes.issue();
    const l = listeners.get(pipe)!;
    const s = {};
    l.h.open(s);
    expect(adopted).toEqual([[s, 4242]]);
    expect(opened).toEqual([s]);
    expect(closed).toEqual([]);
    expect(l.stopped).toBe(true);
    expect(pipes.open).toBe(0);
  });

  test("two ends on the name (a connection racing in): the one that opens is refused, and so is the next, never named by what is left", () => {
    const { pipes, adopted, listeners, closed } = rig({ ends: () => ({ used: 2, pids: [1, 2] }) });
    const { pipe } = pipes.issue();
    const l = listeners.get(pipe)!;
    const s1 = {}, s2 = {};
    l.h.open(s1);
    l.h.open(s2);
    expect(adopted).toEqual([]);
    expect(closed).toEqual([s1, s2]);
  });

  test("a second connection after the first is refused even when its own scan shows one end", () => {
    const answers = [{ used: 1, pids: [7] }, { used: 1, pids: [8] }];
    const { pipes, adopted, listeners, closed } = rig({ ends: () => answers.shift()! });
    const { pipe } = pipes.issue();
    const l = listeners.get(pipe)!;
    const s1 = {}, s2 = {};
    l.h.open(s1);
    l.h.open(s2);
    expect(adopted).toEqual([[s1, 7]]);
    expect(closed).toEqual([s2]);
  });

  test("an unreadable handle list refuses the connection", () => {
    const { pipes, adopted, listeners, closed } = rig({ ends: () => null });
    const l = listeners.get(pipes.issue().pipe)!;
    const s = {};
    l.h.open(s);
    expect(adopted).toEqual([]);
    expect(closed).toEqual([s]);
  });

  test("nobody connecting: the listener is stopped when the time is up", async () => {
    const { pipes, listeners } = rig({ ttlMs: 20 });
    const l = listeners.get(pipes.issue().pipe)!;
    expect(pipes.open).toBe(1);
    await Bun.sleep(80);
    expect(l.stopped).toBe(true);
    expect(pipes.open).toBe(0);
  });

  test("a pipe that cannot be made this user's alone is not handed out, and its listener is stopped", () => {
    const { pipes, listeners } = rig({ lock: () => 0 });
    expect(() => pipes.issue()).toThrow(OneShotRefused);
    expect([...listeners.values()].every((l) => l.stopped)).toBe(true);
    expect(pipes.open).toBe(0);
    expect(() => rig({ userSid: () => null }).pipes.issue()).toThrow(OneShotRefused);
  });

  test("bounded: at most sixteen pending, and a rate cap; a hundred opened and used leave none pending", () => {
    const { pipes, listeners } = rig({ maxPerWindow: 1000, ends: () => ({ used: 1, pids: [5] }) });
    const made: string[] = [];
    for (let i = 0; i < 16; i++) made.push(pipes.issue().pipe);
    expect(() => pipes.issue()).toThrow(OneShotRefused);
    for (const p of made) listeners.get(p)!.h.open({});
    expect(pipes.open).toBe(0);
    for (let i = 0; i < 100; i++) listeners.get(pipes.issue().pipe)!.h.open({});
    expect(pipes.open).toBe(0);
    expect([...listeners.values()].every((l) => l.stopped)).toBe(true);
    const capped = rig({ maxPerWindow: 3 });
    for (let i = 0; i < 3; i++) capped.pipes.issue();
    expect(() => capped.pipes.issue()).toThrow(OneShotRefused);
  });

  test("an end whose client has already gone still counts: the end that remains is not taken for this connection's own", () => {
    // x connected, wrote and left (its end is used but its pid cannot be read); a's end is the one the scan can read.
    const { pipes, adopted, listeners, closed } = rig({ ends: () => ({ used: 2, pids: [9] }) });
    const l = listeners.get(pipes.issue().pipe)!;
    const sx = {};
    l.h.open(sx);
    expect(adopted).toEqual([]);
    expect(closed).toEqual([sx]);
  });

  test("a client that is not this user's is refused, this user's is named", () => {
    const other = rig({ ends: () => ({ used: 1, pids: [11] }), userOf: () => "S-1-5-21-2" });
    const lo = other.listeners.get(other.pipes.issue().pipe)!;
    const so = {};
    lo.h.open(so);
    expect(other.adopted).toEqual([]);
    expect(other.closed).toEqual([so]);
    const unknown = rig({ ends: () => ({ used: 1, pids: [11] }), userOf: () => null });
    const lu = unknown.listeners.get(unknown.pipes.issue().pipe)!;
    lu.h.open({});
    expect(unknown.adopted).toEqual([]);
    const mine = rig({ ends: () => ({ used: 1, pids: [11] }), userOf: () => "s-1-5-21-1" });
    const lm = mine.listeners.get(mine.pipes.issue().pipe)!;
    const sm = {};
    lm.h.open(sm);
    expect(mine.adopted).toEqual([[sm, 11]]);
  });
});
