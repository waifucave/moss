// The sandbox's bus relay (docs/linux-credential-broker.md): the first process inside a Linux fence that may use the
// user's keyring. It listens on 127.0.0.1 inside the sandbox's own network namespace, starts the command with
// `DBUS_SESSION_BUS_ADDRESS` naming that port, and carries each connection's bytes to the engine's broker over the two
// pipes it inherits (`bus-frames.ts`). It decides nothing: the command can kill or impersonate it, and the broker parses
// everything that arrives. It exits with the command's status, and the sandbox's pid namespace ends the rest.
//
// Usage (inside bwrap): `<bun> linux-bus-relay.ts <fd from the engine> <fd to the engine> <command> [args...]`
import { closeSync, writeSync } from "node:fs";
import { dataFrames, encodeFrame, FrameReader, FrameType } from "./bus-frames";

const [, , inArg, outArg, ...command] = process.argv;
const inFd = Number(inArg);
const outFd = Number(outArg);
if (!Number.isInteger(inFd) || !Number.isInteger(outFd) || command.length === 0) {
  console.error("moss: the bus relay needs its two fds and a command");
  process.exit(127);
}

// The relay's refusal marker (stderr, exit 127): the fenced process turns it into the run's refusal.
export const RELAY_CLOSED_MARKER = "moss: the bus relay can't run here (closed)";

// libc, for the two calls the relay needs as the sandbox's pid 1: prctl (not dumpable) and waitid/waitpid (reaping).
type Libc = { prctl(o: number, a: number, b: number, c: number, d: number): number; waitid(idtype: number, id: number, info: unknown, options: number): number; waitpid(pid: number, status: unknown, options: number): number };
function openLibc(): Libc | null {
  if (process.platform !== "linux" || process.env.MOSS_RELAY_TEST_NO_LIBC === "1") return null;
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    return dlopen("libc.so.6", {
      prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      waitid: { args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    }).symbols as unknown as Libc;
  } catch { return null; }
}

// Not dumpable, or nothing: the command (same user, same pid namespace) can't open the relay's pipe ends through
// `/proc/1/fd` or trace it. The setting goes back to normal at the command's own exec. If it can't be set, and read back
// as set, the relay starts nothing and says why (fail closed).
const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;
const libc = openLibc();
function refuse(why: string): never {
  console.error(`${RELAY_CLOSED_MARKER}: ${why}`);
  process.exit(127);
}
if (libc === null) refuse("no libc through bun:ffi, so it can't make itself undumpable");
if (process.env.MOSS_RELAY_TEST_DUMPABLE_FAIL === "1" || libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0 || libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) !== 0) {
  refuse("it couldn't make itself undumpable");
}

type Sock ={ write(d: Uint8Array): number; end(): void; data?: { id: number; queue: Uint8Array[] } };
const socks = new Map<number, Sock>();
let nextId = 1;
let channelOpen = true;

const send = (frame: Uint8Array): void => {
  if (!channelOpen) return;
  try {
    let at = 0;
    while (at < frame.length) at += writeSync(outFd, frame, at, frame.length - at);
  } catch { channelOpen = false; }
};

const flush = (s: Sock): void => {
  const q = s.data!.queue;
  while (q.length > 0) {
    const head = q[0]!;
    const n = s.write(head);
    if (n < head.length) { q[0] = head.subarray(Math.max(n, 0)); return; }
    q.shift();
  }
};

const server = Bun.listen<{ id: number; queue: Uint8Array[] }>({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    open(s) {
      const id = nextId++;
      s.data = { id, queue: [] };
      socks.set(id, s as unknown as Sock);
      send(encodeFrame(FrameType.Open, id));
    },
    data(s, d) { for (const f of dataFrames(s.data.id, d)) send(f); },
    drain(s) { flush(s as unknown as Sock); },
    close(s) { if (socks.delete(s.data.id)) send(encodeFrame(FrameType.Close, s.data.id)); },
    error(s) { if (socks.delete(s.data.id)) send(encodeFrame(FrameType.Close, s.data.id)); },
  },
});

// What the engine sends back, frame by frame, to the connection it names.
void (async () => {
  const frames = new FrameReader();
  try {
    for await (const chunk of Bun.file(inFd).stream()) {
      for (const f of frames.push(chunk)) {
        const s = socks.get(f.conn);
        if (s === undefined) continue;
        if (f.type === FrameType.Data) { s.data!.queue.push(f.data); flush(s); }
        else if (f.type === FrameType.Close) { socks.delete(f.conn); s.end(); }
      }
    }
  } catch { /* the channel is gone: connections just stop answering */ }
})();

const child = Bun.spawn(command, {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: `tcp:host=127.0.0.1,port=${server.port}` },
});
// The sandbox's pid 1 (bwrap `--as-pid-1`) inherits every orphan: each one that ends is reaped here, so none stays a
// zombie on the user's process count. The command itself is never reaped here (Bun waits for it): `waitid(WNOWAIT)`
// names the next zombie without taking it, and only one that isn't the command is taken.
const P_ALL = 0, WEXITED = 4, WNOHANG = 1, WNOWAIT = 0x01000000;
const info = new Uint8Array(128);
const status = new Int32Array(1);
const { ptr } = require("bun:ffi") as typeof import("bun:ffi");
const reap = (): void => {
  for (let k = 0; k < 256; k++) {
    info.fill(0);
    if (libc.waitid(P_ALL, 0, ptr(info), WEXITED | WNOHANG | WNOWAIT) !== 0) return; // ECHILD: no children left
    const pid = new DataView(info.buffer).getInt32(16, true); // siginfo_t's si_pid, after three ints and padding
    if (pid === 0 || pid === child.pid) return; // nothing waiting, or only the command (Bun's to take)
    libc.waitpid(pid, ptr(status), WNOHANG);
  }
};
const reaper = setInterval(reap, 100);
try { process.on("SIGCHLD", reap); } catch { /* the interval still reaps */ }
const code = await child.exited;
clearInterval(reaper);
reap();
server.stop(true);
try { closeSync(outFd); } catch { /* gone */ }
process.exit(child.signalCode ? 128 + (({ SIGKILL: 9, SIGTERM: 15, SIGINT: 2, SIGHUP: 1 } as Record<string, number>)[child.signalCode] ?? 1) : code);
