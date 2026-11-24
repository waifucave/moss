// The engine's write end of the pipe to the sandbox's bus relay (Linux): a relay that never reads can't grow the
// engine's memory or block its loop (docs/linux-credential-broker.md). Linux only: the pipe is made through libc.
import { describe, expect, test } from "bun:test";
import { readSync } from "node:fs";
import { BoundedPipeWriter, closeFd, linuxPipe, setNonBlocking } from "../../src/fence/relay-pipe";

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
});
