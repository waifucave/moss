// A process that speaks to a daemon as the `cli` role with the real harness token and asks for `device.pair.join`
// (cli-role-spawned.test.ts). It prints one line: the JSON-RPC error code of the hello or of the call, or "ok". It
// prints nothing of the token. With MOSS_TEST_FORK=1 it first starts a copy of itself detached and exits, so the copy
// is re-parented away from the daemon (a double fork), and the copy writes its line to MOSS_TEST_OUT.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { MOSS_PROTOCOL_VERSION, encodeLine, LineDecoder, METHODS } from "@waifucave/moss-protocol";

const out = (line: string) => (process.env.MOSS_TEST_OUT ? writeFileSync(process.env.MOSS_TEST_OUT, line) : console.log(line));

if (process.env.MOSS_TEST_FORK === "1") {
  const child = spawn(process.execPath, [import.meta.path], { detached: true, stdio: "ignore", env: { ...process.env, MOSS_TEST_FORK: "0" } });
  child.unref();
  process.exit(0);
}

const decoder = new LineDecoder();
const pending = new Map<number, (m: Record<string, unknown>) => void>();
const socket = await Bun.connect({ unix: process.env.MOSS_TEST_SOCKET!, socket: {
  data(_s, chunk) {
    for (const l of decoder.push(chunk)) {
      const m = JSON.parse(l) as Record<string, unknown>;
      if (typeof m["id"] === "number") { pending.get(m["id"])?.(m); pending.delete(m["id"]); }
    }
  },
  close() { for (const p of pending.values()) p({ error: { code: "closed" } }); pending.clear(); },
} });
let next = 1;
const request = (method: string, params: unknown) => new Promise<Record<string, unknown>>((r) => {
  const id = next++;
  pending.set(id, r);
  socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
});
const code = (m: Record<string, unknown>) => String((m["error"] as { code?: unknown } | undefined)?.code ?? "ok");
const hello = await request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "cli", token: process.env.MOSS_TEST_TOKEN!, clientName: "spawned", features: [] });
if (hello["error"] !== undefined) {
  out(`hello:${code(hello)}`);
} else {
  out(`call:${code(await request("device.pair.join", { code: "not-a-real-pairing-code" }))}`);
}
socket.end();
process.exit(0);
