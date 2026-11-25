// The one-shot pipes on real Windows pipes: each client is named as itself by its own pipe's single end.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OneShotPipes } from "../../src/ipc/one-shot-pipes";
import { ownHandles } from "../../src/platform/caller-probe";
import { resolveEndpoint } from "../../src/platform/transport";
import { currentUserSid } from "../../src/platform/win-pipe";

const win = process.platform === "win32";

function rig() {
  const endpoint = resolveEndpoint(mkdtempSync(join(tmpdir(), "moss-one-shot-"))).path;
  const named = new Map<object, number>();
  const refused: object[] = [];
  const sockets: object[] = [];
  const pipes = new OneShotPipes({
    endpoint,
    handlers: { open: (s: object) => { sockets.push(s); }, close() {}, data() {} } as never,
    adopt: (s, pid) => { named.set(s, pid); },
    closeAtOnce: (s) => { refused.push(s); (s as { terminate(): void }).terminate(); },
    userSid: currentUserSid,
  });
  const until = async (cond: () => boolean) => { for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(10); };
  return { pipes, named, refused, sockets, until };
}

const clientTo = (path: string, ms: number) => Bun.spawn([process.execPath, "-e", `const s = await Bun.connect({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); await Bun.sleep(${ms}); s.end();`], { stdout: "ignore", stderr: "ignore", windowsHide: true });

describe.skipIf(!win)("one-shot pipes, real", () => {
  test("two clients at once are each named as themselves", async () => {
    const r = rig();
    const p1 = r.pipes.issue().pipe, p2 = r.pipes.issue().pipe;
    const a = clientTo(p1, 4000), b = clientTo(p2, 4000);
    await r.until(() => r.named.size === 2);
    expect([...r.named.values()].sort()).toEqual([a.pid, b.pid].sort());
    expect(r.refused).toEqual([]);
    a.kill(); b.kill();
  });

  test("a client that closes and reconnects, handle numbers reused, is named as itself each time", async () => {
    const r = rig();
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const c = clientTo(r.pipes.issue().pipe, 300);
      await r.until(() => r.named.size === i + 1);
      seen.push([...r.named.values()][i]!);
      expect(seen[i]).toBe(c.pid);
      await c.exited;
    }
  });

  test("a process that connects to another client's one-shot first is named as itself; the intended client is refused and retries cleanly", async () => {
    const r = rig();
    const first = r.pipes.issue().pipe;
    const intruder = clientTo(first, 3000); // knows the name (it listed the pipes): connects first
    await r.until(() => r.named.size === 1);
    expect([...r.named.values()]).toEqual([intruder.pid]);
    const intended = clientTo(first, 1500); // the listener is gone: it cannot connect, and asks again
    await Bun.sleep(600);
    expect(r.named.size).toBe(1);
    const retry = clientTo(r.pipes.issue().pipe, 3000);
    await r.until(() => r.named.size === 2);
    expect([...r.named.values()].sort()).toEqual([intruder.pid, retry.pid].sort());
    intruder.kill(); intended.kill(); retry.kill();
  });

  test("a hundred opens and closes leave no handle behind", async () => {
    const r = rig();
    const before = ownHandles()!.length;
    for (let i = 0; i < 100; i++) {
      const { pipe } = r.pipes.issue();
      const c = await Bun.connect({ unix: pipe, socket: { data() {} } });
      await r.until(() => r.named.size === i + 1);
      c.end();
    }
    await Bun.sleep(500);
    expect(r.pipes.open).toBe(0);
    expect(ownHandles()!.length - before).toBeLessThan(10);
  });

  test("the pipe is this user's alone (its DACL)", () => {
    const r = rig();
    const { pipe } = r.pipes.issue();
    const { pipeDaclSddl } = require("../../src/platform/win-pipe") as typeof import("../../src/platform/win-pipe");
    const sddl = pipeDaclSddl(pipe);
    expect(sddl).not.toBeNull();
    expect(sddl).not.toContain(";;;WD"); // not Everyone
  });
});
