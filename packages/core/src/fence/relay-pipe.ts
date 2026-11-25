// The engine's ends of the pipes to the sandbox's bus relay (Linux; docs/linux-credential-broker.md). The engine never
// blocks on them and never buffers past a bound: a command can stop the relay and leave the pipe unread, and Bun's own
// file sink would then keep everything written in the engine's memory (it accepts writes with no reader and does not
// block). So writes go through `BoundedPipeWriter`: the engine's end is non-blocking, what the pipe can't take waits in a
// queue counted in bytes, and past the cap the writer closes and says so.
import { readSync, writeSync } from "node:fs";
import { ffiLib, ffiPtr } from "../platform/ffi";

const libc = () => ffiLib("linux-relay-pipe", "libc.so.6", {
  pipe2: { args: ["ptr", "i32"], returns: "i32" },
  close: { args: ["i32"], returns: "i32" },
  fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
});

const O_CLOEXEC = 0o2000000;
const O_NONBLOCK = 0o4000;
const F_GETFL = 3;
const F_SETFL = 4;

/** pipe2(O_CLOEXEC): [read, write], or null. */
export function linuxPipe(): [number, number] | null {
  const lib = libc();
  if (lib === null) return null;
  const fds = new Int32Array(2);
  if ((lib.pipe2!(ffiPtr(fds), O_CLOEXEC) as number) !== 0) return null;
  return [fds[0]!, fds[1]!];
}

export function closeFd(fd: number): void {
  try { libc()?.close!(fd); } catch { /* closed */ }
}

/** Makes one end non-blocking (its own open file description: the other end is untouched). */
export function setNonBlocking(fd: number): boolean {
  const lib = libc();
  if (lib === null) return false;
  const flags = lib.fcntl!(fd, F_GETFL, 0) as number;
  return flags >= 0 && (lib.fcntl!(fd, F_SETFL, flags | O_NONBLOCK) as number) === 0;
}

/** Writes to a non-blocking pipe end without ever blocking, holding at most `cap` bytes the pipe hasn't taken yet. */
export class BoundedPipeWriter {
  #queue: Uint8Array[] = [];
  #pending = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(private readonly fd: number, private readonly cap: number, private readonly overflow: () => void) {}

  /** Bytes written and not yet taken by the pipe. */
  get pending(): number { return this.#pending; }
  get closed(): boolean { return this.#closed; }

  write(b: Uint8Array): void {
    if (this.#closed) return;
    if (this.#pending + b.length > this.cap) {
      this.close();
      try { this.overflow(); } catch { /* best effort */ }
      return;
    }
    this.#queue.push(b);
    this.#pending += b.length;
    this.#flush();
  }

  #flush(): void {
    if (this.#timer !== null) return;
    while (this.#queue.length > 0 && !this.#closed) {
      const head = this.#queue[0]!;
      let n: number;
      try {
        n = writeSync(this.fd, head);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "EAGAIN") {
          // The pipe is full: try again shortly (the reader may never come: the cap ends that).
          this.#timer = setTimeout(() => { this.#timer = null; this.#flush(); }, 5);
          return;
        }
        this.close(); // the relay is gone
        return;
      }
      this.#pending -= n;
      if (n < head.length) this.#queue[0] = head.subarray(n);
      else this.#queue.shift();
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#queue = [];
    this.#pending = 0;
  }
}

/** Reads a non-blocking pipe end the engine alone owns, and closes it exactly once (`close`): no stream of Bun's ever
 *  holds the fd, so nothing else can close its number after it has been reused. As an async iterable it yields what it
 *  reads; while `maxQueued` bytes wait unconsumed it stops reading (the relay then waits, which is backpressure, not
 *  memory). Once the consumer stops (`return`, or `discard()`), it keeps reading and drops everything, so a relay that
 *  is still writing never blocks in its write until the run's timeout. It ends at EOF or `close`. */
export class PipeReader implements AsyncIterable<Uint8Array> {
  #queue: Uint8Array[] = [];
  #queued = 0;
  #wake: (() => void) | null = null;
  #eof = false;
  #closed = false;
  #discard = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #idle = 1;
  readonly #buf: Buffer;
  /** How many times the fd was closed (0 or 1): what the double-close test reads. */
  closes = 0;

  constructor(private readonly fd: number, private readonly maxQueued = 1024 * 1024, chunk = 64 * 1024) {
    this.#buf = Buffer.alloc(chunk);
    this.#schedule(0);
  }

  #schedule(ms: number): void {
    if (this.#closed || this.#eof || this.#timer !== null) return;
    this.#timer = setTimeout(() => { this.#timer = null; this.#pump(); }, ms);
  }

  #pump(): void {
    if (this.#closed || this.#eof) return;
    for (let k = 0; k < 64; k++) {
      if (!this.#discard && this.#queued >= this.maxQueued) return; // the consumer's `next` reschedules
      let n: number;
      try {
        n = readSync(this.fd, this.#buf, 0, this.#buf.length, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "EAGAIN") {
          this.#idle = Math.min(this.#idle * 2, 20);
          this.#schedule(this.#idle);
          return;
        }
        n = 0; // anything else ends the input
      }
      if (n === 0) { this.#eof = true; this.#notify(); return; }
      this.#idle = 1;
      if (!this.#discard) {
        this.#queue.push(Uint8Array.from(this.#buf.subarray(0, n)));
        this.#queued += n;
        this.#notify();
      }
    }
    this.#schedule(0);
  }

  #notify(): void { const w = this.#wake; this.#wake = null; w?.(); }

  /** Stop handing data on, keep draining the pipe. */
  discard(): void {
    this.#discard = true;
    this.#queue = [];
    this.#queued = 0;
    this.#notify();
    this.#schedule(0);
  }

  /** Closes the fd, once, whatever is called after. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#queue = [];
    this.#queued = 0;
    closeFd(this.fd);
    this.closes++;
    this.#notify();
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        for (;;) {
          if (this.#discard || this.#closed) return { done: true, value: undefined };
          const c = this.#queue.shift();
          if (c !== undefined) {
            this.#queued -= c.length;
            this.#schedule(0);
            return { done: false, value: c };
          }
          if (this.#eof) return { done: true, value: undefined };
          await new Promise<void>((r) => { this.#wake = r; });
        }
      },
      return: async (): Promise<IteratorResult<Uint8Array>> => { this.discard(); return { done: true, value: undefined }; },
    };
  }
}
