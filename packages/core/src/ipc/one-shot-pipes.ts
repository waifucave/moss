// One pipe per client (Windows). The engine's well-known pipe cannot name a connection's client: Bun gives a socket no handle, and picking its end
// among the daemon's handles is elimination, which a same-user process can steer. A client therefore asks the well-known pipe for a rendezvous
// (`protocol.rendezvous`, the only thing that pipe answers) and gets the name of a pipe made for it alone: a fresh 128-bit name, a second listener,
// the DACL this user's alone, ONE accepted connection, then the listener stops. That pipe's connected ends are the whole of the name's, so when
// the connection opens exactly one end is connected and it is this socket's own; two or more mean a second connection raced in, and then none is
// named. The client's pid is read from that end (`GetNamedPipeClientProcessId`), and the connection is judged as that process from there on.
import { randomBytes } from "node:crypto";
import { pipeEndsOf } from "../platform/caller-probe";
import { lockPipeDacl, processIdentity } from "../platform/win-pipe";

type Handlers<D> = {
  open(socket: any): void; close(socket: any, error?: Error): void; data(socket: any, chunk: any): void | Promise<void>; drain?(socket: any): void;
};

export interface OneShotDeps<D> {
  /** The well-known pipe's path (`\\.\pipe\name`); a one-shot's is it plus `-<random>`. */
  endpoint: string;
  /** The connection handlers the well-known pipe has (a one-shot's connection is handled exactly like it). */
  handlers: Handlers<D>;
  /** Gives a socket its proven client pid, and when it connected. */
  adopt(socket: object, pid: number, connectedAt: number): void;
  /** Closes a socket at once (terminate), so its end does not linger. */
  closeAtOnce(socket: object): void;
  userSid(): string | null;
  /** Test seams. */
  listen?: (path: string, handlers: Handlers<D>) => { stop(closeActive?: boolean): void };
  ends?: (path: string) => { used: number; pids: number[] } | null;
  /** The user (a SID string) a process runs as; the client must be this user's. */
  userOf?: (pid: number) => string | null;
  lock?: (path: string, sid: string) => number;
  now?: () => number;
  ttlMs?: number;
  maxPending?: number;
  /** At most this many rendezvous in `windowMs`. */
  maxPerWindow?: number;
  windowMs?: number;
}

export class OneShotRefused extends Error {}

export class OneShotPipes<D = unknown> {
  private pending = 0;
  private recent: number[] = [];
  /** How many listeners are open (tests: a hundred opens and closes leave none). */
  get open(): number { return this.pending; }

  constructor(private readonly d: OneShotDeps<D>) {}

  /** A rendezvous: makes the pipe and gives its name; throws `OneShotRefused` over the bounds or when the pipe cannot be locked to this user. */
  issue(): { pipe: string; ttlMs: number } {
    const d = this.d, now = (d.now ?? Date.now)(), ttlMs = d.ttlMs ?? 5000;
    this.recent = this.recent.filter((t) => now - t < (d.windowMs ?? 10_000));
    if (this.pending >= (d.maxPending ?? 16) || this.recent.length >= (d.maxPerWindow ?? 200)) throw new OneShotRefused("too many connections are being opened: try again in a moment");
    const sid = d.userSid();
    if (sid === null) throw new OneShotRefused("this user could not be identified");
    const path = `${d.endpoint}-${randomBytes(16).toString("hex")}`;
    let done = false;
    let listener: { stop(closeActive?: boolean): void } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      this.pending--;
      if (timer) clearTimeout(timer);
      try { listener?.stop(); } catch { /* already stopped */ }
    };
    const handlers: Handlers<D> = {
      ...d.handlers,
      open: (socket) => {
        // The first connection stops the listener whatever follows: a one-shot serves one.
        const at = (d.now ?? Date.now)();
        const ends = (d.ends ?? pipeEndsOf)(path);
        const first = !done;
        finish();
        // Named only when EVERY end of the name that is in use (a client that has already gone included, whose pid can no longer be read) is this one:
        // a client that connected, wrote and left must not make the end that remains look like this connection's.
        const pid = ends !== null && ends.used === 1 && ends.pids.length === 1 ? ends.pids[0]! : null;
        // And the client is this user's: the access list is locked just after the listener opens, and in that moment another account could connect.
        const mine = pid !== null && (d.userOf ?? ((p: number) => processIdentity(p)?.userSid ?? null))(pid)?.toUpperCase() === sid.toUpperCase();
        if (!first || pid === null || !mine) { d.handlers.open(socket); d.closeAtOnce(socket); return; } // refused: unnamed, ambiguous or not this user's
        d.adopt(socket, pid, at);
        d.handlers.open(socket);
      },
    };
    this.pending++;
    this.recent.push(now);
    try {
      listener = (d.listen ?? ((p, h) => Bun.listen({ unix: p, socket: h as never })))(path, handlers);
      // The DACL is this user's before the name is sent, so nothing else can have connected (and nobody knows the name).
      if ((d.lock ?? lockPipeDacl)(path, sid) === 0) throw new OneShotRefused("the connection's pipe could not be made this user's alone");
    } catch (err) {
      finish();
      throw err instanceof OneShotRefused ? err : new OneShotRefused("the connection's pipe could not be made");
    }
    timer = setTimeout(finish, ttlMs);
    (timer as { unref?: () => void }).unref?.();
    return { pipe: path, ttlMs };
  }
}
