// A small MOSS protocol client for the acceptance run: JSON-RPC 2.0 over NDJSON on the daemon's socket, a hello in
// a role, and answers to the daemon's own requests (`app.ping`, which the pair's heartbeat sends every 5 s).
import { createConnection, type Socket } from "node:net";
import { scaled } from "./time-scale";

export class RpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: unknown) {
    super(`${method}: ${message} (${code})`);
  }
}

type Pending = { method: string; resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };

export class MossClient {
  private seq = 0;
  private buf = "";
  private readonly pending = new Map<string, Pending>();
  private readonly listeners: ((method: string, params: unknown) => void)[] = [];
  private closed = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("close", () => this.onClose());
    socket.on("error", () => this.onClose());
  }

  // Every wait here is the run's patience (time-scale.ts): a hello that a loaded runner answers in 12 s (its load average was 86 at the
  // job's start, run 45381009835's host row) is a slow runner, not a daemon that does not answer.
  static connect(path: string, timeoutMsAsked = 5_000): Promise<MossClient> {
    const timeoutMs = scaled(timeoutMsAsked);
    return new Promise((resolve, reject) => {
      const s = createConnection({ path });
      const t = setTimeout(() => { s.destroy(); reject(new Error(`no answer on the socket within ${timeoutMs} ms`)); }, timeoutMs);
      s.once("connect", () => { clearTimeout(t); resolve(new MossClient(s)); });
      s.once("error", (e) => { clearTimeout(t); reject(e); });
    });
  }

  get isClosed(): boolean { return this.closed; }

  onNotification(fn: (method: string, params: unknown) => void): void { this.listeners.push(fn); }

  request<T = Record<string, unknown>>(method: string, params: unknown = {}, timeoutMsAsked = 15_000): Promise<T> {
    const timeoutMs = scaled(timeoutMsAsked);
    if (this.closed) return Promise.reject(new RpcError(method, -1, "the connection is closed"));
    const id = `a${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(method, -2, `no answer within ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line === "") continue;
      let msg: { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method !== undefined && msg.id !== undefined) { this.answer(msg.id, msg.method); continue; }
      if (msg.method !== undefined) { for (const l of this.listeners) l(msg.method, msg.params); continue; }
      const p = msg.id === undefined ? undefined : this.pending.get(String(msg.id));
      if (p === undefined) continue;
      this.pending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (msg.error !== undefined) p.reject(new RpcError(p.method, msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    }
  }

  /** The daemon's requests to an app: the heartbeat is answered; anything else is refused, as an app that doesn't
   *  serve it would. */
  private answer(id: string | number, method: string): void {
    const body = method === "app.ping" ? { result: { ok: true } } : { error: { code: -32601, message: `the acceptance driver doesn't serve ${method}` } };
    this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
  }

  private onClose(): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new RpcError(p.method, -1, "the connection closed")); this.pending.delete(id); }
  }
}

/** Connects and says hello in `role`; the client is closed again when the hello is refused. */
export async function hello(path: string, role: "app" | "cli" | "layer", token: string, clientName: string, protocolVersion: number, extra: Record<string, unknown> = {}): Promise<{ client: MossClient; result: Record<string, unknown> }> {
  // Windows: the core names a pipe client by scanning its own handles, and when two connections arrive together from different programs it cannot tell
  // them apart: it refuses (-32012) or closes the connection (the client connects again, as its own comment says). A second try is the answer.
  for (let attempt = 0; ; attempt++) {
    const client = await MossClient.connect(path);
    try {
      const result = await client.request("protocol.hello", { protocolVersion, role, token, clientName, features: ["app.quit"], ...extra }, 10_000);
      return { client, result };
    } catch (err) {
      client.close();
      const again = process.platform === "win32" && attempt < 8 && /-32012|the connection closed/.test(String(err));
      if (!again) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
