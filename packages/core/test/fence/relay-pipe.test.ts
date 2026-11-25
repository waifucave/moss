// The engine's write end of the pipe to the sandbox's bus relay (Linux): a relay that never reads can't grow the
// engine's memory or block its loop (docs/linux-credential-broker.md). Linux only: the pipe is made through libc.
import { describe, expect, test } from "bun:test";
import { existsSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedPipeWriter, closeFd, linuxPipe, PipeReader, setNonBlocking } from "../../src/fence/relay-pipe";

describe.skipIf(process.platform !== "linux")("linux: the bounded pipe to the relay", () => {
  test("a stalled reader: writes never block, at most the cap waits, and past it the writer closes", () => {
    const [r, w] = linuxPipe()!;
    expect(setNonBlocking(w)).toBe(true);
    const cap = 1024 * 1024;
    let overflowed = 0;
    const writer = new BoundedPipeWriter(w, cap, () => { overflowed++; });
    const chunk = new Uint8Array(64 * 1024);
    let peak = 0;
    const t0 = performance.now();
    for (let k = 0; k < 64 && !writer.closed; k++) {
      writer.write(chunk);
      peak = Math.max(peak, writer.pending);
    }
    // 4 MiB offered to a pipe nobody reads: the pipe took its 64 KiB, the queue held under the cap, then it closed.
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(peak).toBeLessThanOrEqual(cap);
    expect(overflowed).toBe(1);
    expect(writer.closed).toBe(true);
    expect(writer.pending).toBe(0);
    closeFd(r); closeFd(w);
  });

  test("a reader that reads gets every byte, in order", async () => {
    const [r, w] = linuxPipe()!;
    expect(setNonBlocking(w)).toBe(true);
    expect(setNonBlocking(r)).toBe(true);
    const writer = new BoundedPipeWriter(w, 4 * 1024 * 1024, () => { throw new Error("no overflow expected"); });
    const data = new Uint8Array(512 * 1024).map((_, i) => i % 251);
    writer.write(data);
    const got = new Uint8Array(data.length);
    let at = 0;
    const buf = Buffer.alloc(65536);
    while (at < data.length) {
      let n = 0;
      try { n = readSync(r, buf, 0, buf.length, null); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e; }
      got.set(buf.subarray(0, n), at);
      at += n;
      await Bun.sleep(1); // lets the writer's retry run
    }
    expect(Buffer.from(got).equals(Buffer.from(data))).toBe(true);
    expect(writer.pending).toBe(0);
    writer.close();
    closeFd(r); closeFd(w);
  });

  test("the engine's read end is closed exactly once: a later close never hits the fd number's next owner", async () => {
    const [r, w] = linuxPipe()!;
    expect(setNonBlocking(r)).toBe(true);
    const reader = new PipeReader(r);
    writeSync(w, Buffer.from("hello"));
    closeFd(w);
    const got: number[] = [];
    for await (const c of reader) got.push(...c);
    expect(Buffer.from(got).toString()).toBe("hello");
    reader.close();
    // The number is free now: the next open takes it. Every later close of the reader must leave that file alone.
    const dir = mkdtempSync(join(tmpdir(), "moss-sentinel-"));
    const sentinel = openSync(join(dir, "s"), "w+");
    expect(sentinel).toBe(r);
    reader.close();
    reader.close();
    expect(() => fstatSync(sentinel)).not.toThrow();
    expect(reader.closes).toBe(1);
    closeFd(sentinel);
    rmSync(dir, { recursive: true, force: true });
  });

  test("after the consumer stops, the reader keeps draining, so a writer never blocks", async () => {
    const [r, w] = linuxPipe()!;
    expect(setNonBlocking(r)).toBe(true);
    const reader = new PipeReader(r, 64 * 1024);
    const it = reader[Symbol.asyncIterator]();
    writeSync(w, Buffer.alloc(10));
    expect((await it.next()).done).toBe(false);
    await it.return!(); // the broker stopped (an overflow or the run's end)
    // A blocking writer pushes 8 MiB, far past the pipe's 64 KiB and the queue's bound: it never waits forever.
    const chunk = Buffer.alloc(64 * 1024);
    const t0 = performance.now();
    for (let k = 0; k < 128; k++) {
      let at = 0;
      while (at < chunk.length) {
        try { at += writeSync(w, chunk, at); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e; await Bun.sleep(1); }
      }
      if (performance.now() - t0 > 10_000) break;
    }
    expect(performance.now() - t0).toBeLessThan(10_000);
    closeFd(w);
    reader.close();
  });
});

describe.skipIf(process.platform !== "linux")("linux: the bus relay fails closed", () => {
  for (const [why, env] of [["prctl refused", { MOSS_RELAY_TEST_DUMPABLE_FAIL: "1" }], ["no libc", { MOSS_RELAY_TEST_NO_LIBC: "1" }]] as const) {
    test(`it starts nothing when it can't make itself undumpable (${why})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "moss-relay-"));
      const marker = join(dir, "ran");
      const [r1, w1] = linuxPipe()!;
      const [r2, w2] = linuxPipe()!;
      const relay = join(import.meta.dir, "../../src/fence/linux-bus-relay.ts");
      const p = Bun.spawn([process.execPath, relay, "3", "4", "/bin/sh", "-c", `touch '${marker}'`], {
        stdio: ["ignore", "pipe", "pipe", r1, w2] as never, env: { PATH: "/usr/bin:/bin", ...env },
      });
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr as ReadableStream).text()]);
      expect(code).toBe(127);
      expect(err).toContain("moss: the bus relay can't run here (closed)");
      expect(existsSync(marker)).toBe(false);
      for (const fd of [r1, w1, r2, w2]) closeFd(fd);
      rmSync(dir, { recursive: true, force: true });
    });
  }
});
