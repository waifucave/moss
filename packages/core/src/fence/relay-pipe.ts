// The engine's ends of the pipes to the sandbox's bus relay (Linux; docs/linux-credential-broker.md). The engine never
// blocks on them and never buffers past a bound: a command can stop the relay and leave the pipe unread, and Bun's own
// file sink would then keep everything written in the engine's memory (it accepts writes with no reader and does not
// block). So writes go through `BoundedPipeWriter`: the engine's end is non-blocking, what the pipe can't take waits in a
// queue counted in bytes, and past the cap the writer closes and says so.
import { writeSync } from "node:fs";
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
