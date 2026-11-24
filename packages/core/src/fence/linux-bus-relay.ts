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

type Sock = { write(d: Uint8Array): number; end(): void; data?: { id: number; queue: Uint8Array[] } };
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
const code = await child.exited;
server.stop(true);
try { closeSync(outFd); } catch { /* gone */ }
process.exit(child.signalCode ? 128 + (({ SIGKILL: 9, SIGTERM: 15, SIGINT: 2, SIGHUP: 1 } as Record<string, number>)[child.signalCode] ?? 1) : code);
