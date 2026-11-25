// Windows: a client reaches the engine through a pipe made for it alone. The well-known pipe cannot name its client (Bun gives a socket no handle, and
// picking its end among the daemon's handles is elimination), so it answers one request: `protocol.rendezvous`, which gives the name of a one-shot
// pipe (a fresh 128-bit name, this user's alone, ONE accepted connection, a few seconds to use it). The client connects to that, and the engine
// reads its pid from the pipe's single end. On macOS and Linux the endpoint is a Unix socket the OS names the peer of, and nothing changes.
// This is the one place a client changes: `const target = await engineEndpoint(path)` before its own connect, in every client of the engine.
import { createConnection } from "node:net";

/** The pipe a client should connect to for the engine at `endpoint`: on Windows a one-shot pipe from a rendezvous, otherwise `endpoint` itself.
 *  An engine that does not know the rendezvous (older than this client) is dialled the old way, on the endpoint. */
export async function engineEndpoint(endpoint: string, opts: { platform?: string; timeoutMs?: number } = {}): Promise<string> {
  if ((opts.platform ?? process.platform) !== "win32" || !/^\\\\[.?]\\pipe\\/i.test(endpoint)) return endpoint;
  const timeoutMs = opts.timeoutMs ?? 5000;
  return await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ path: endpoint });
    let buf = "";
    let settled = false;
    const done = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error("the engine did not answer the rendezvous"))), timeoutMs);
    socket.once("connect", () => { socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "protocol.rendezvous" })}\n`); });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let msg: { result?: { pipe?: unknown }; error?: { code?: number; message?: string; data?: { rendezvous?: unknown } } };
      try { msg = JSON.parse(buf.slice(0, nl)); } catch { done(() => reject(new Error("the engine's rendezvous answer was not JSON"))); return; }
      if (typeof msg.result?.pipe === "string") { const pipe = msg.result.pipe; done(() => resolve(pipe)); return; }
      // The engine's own refusal (too many pending, the pipe could not be made this user's alone): an error to the caller. Any other error is an engine
      // without the rendezvous (older than this client: it answers an unknown method before the hello with its own error): the old way.
      if (msg.error?.data?.rendezvous === "refused") { const why = msg.error.message ?? "the engine refused the rendezvous"; done(() => reject(new Error(why))); return; }
      done(() => resolve(endpoint));
    });
    socket.once("error", (err) => done(() => reject(err)));
    socket.once("close", () => done(() => reject(new Error("the connection closed"))));
  });
}
