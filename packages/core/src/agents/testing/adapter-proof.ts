// Starts an adapter MOSS provides the way the engine starts it, and speaks ACP to it (the proof behind
// `tests/adapter-real.proof.ts`, which runs on GitHub only, against the real registry, and `tests/adapter-proof.test.ts`,
// which checks this logic offline against a fake registry and the scripted fake agent).
//
// What it does, through the same code the card's yes and a session start take:
//   1. `adapterOffer()` says a download is due, `provideAdapter()` fetches and places it (the store's real fetch, every
//      hash checked before anything is unpacked), `detect()` then reports it installed at the declared version.
//   2. `start()` runs the run file on `runtime` with `ADAPTER_BUN_FLAGS` and the backend's allow-listed environment, with
//      the declaration's `uses` programs resolved on PATH to small stand-ins that record how they were started (and never
//      print their arguments), and reads the wire: `initialize` must be answered, well-formed, within the bound.
//   3. Whatever comes after `initialize` is reported, not required: without a real login `session/new` may fail, and then
//      the proof says whether the adapter reached for the stand-in program.
// A module that doesn't resolve under `--no-install`, a crash at import, an `initialize` that never comes or comes back
// malformed fails with the tail of the adapter's stderr (never an environment).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentQuirks } from "../../contracts/agent-backend";
import { SystemClock } from "../../clock/system-clock";
import { FakeFence } from "../../contracts/fakes/fence";
import type { IndexFetch } from "../../registry/indexes/client";
import type { AdapterDecl } from "../adapter/types";
import { AdapterStore } from "../adapter/store";
import { AcpAgentBackend, type AcpStartSpec } from "../backend";

export class AdapterProofError extends Error {}

export interface AdapterProofInput {
  id: string;
  name?: string;
  quirks: AgentQuirks;
  adapter: AdapterDecl;
  /** The MOSS home the store keeps the adapter in (a temp one). */
  home: string;
  /** A scratch folder for the stand-ins, the person's home and the project. */
  work: string;
  /** The Bun that runs the adapter. */
  runtime: string;
  /** The tarball fetch: the pinned public fetch by default (the real registry). */
  download?: IndexFetch;
  /** One `--version` line per `uses` program, matching its identity pattern; `jsonRpc: true` makes the stand-in answer every
   *  JSON-RPC request it is sent on stdin with an empty result (an adapter that drives a CLI over JSON-RPC, as Codex's does
   *  `codex app-server`, can then get as far as its own `initialize`) and record the methods it was asked. */
  standIns?: Readonly<Record<string, string | { version: string; jsonRpc: true }>>;
  /** The program and arguments, where the quirks hold none (a test's). */
  command?: { program: string; acpArgs: readonly string[] };
  /** How long `initialize` and `session/new` may each take (and the whole start). */
  startMs?: number;
}

export interface AdapterProof {
  version: string;
  digest: string | undefined;
  fetchMs: number;
  packages: number;
  initialize: { ms: number; protocolVersion: number; agent: string };
  session: { ok: true } | { ok: false; error: string };
  /** The stand-in programs: how many times each was started to print its version and to run, and the run's argument counts. */
  standIns: Record<string, { versionChecks: number; runs: number[]; methods: string[] }>;
  stderrTail: string;
}

/** What marks a failure to load: a module the closure lacks (Bun's message under `--no-install`), a crash at import. */
const LOAD_FAILURE = /Cannot find (module|package)|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ResolveMessage|BuildMessage|SyntaxError|Unexpected token|dlopen|\.node['"]? is not|No such built-in module/i;

const TAIL = 3000;

export async function proveAdapter(i: AdapterProofInput): Promise<AdapterProof> {
  const startMs = i.startMs ?? 90_000;
  const bin = join(i.work, "bin");
  const userHome = join(i.work, "home");
  const root = join(i.work, "project");
  const setup = join(i.work, "setup");
  for (const d of [bin, userHome, root, setup]) mkdirSync(d, { recursive: true });

  // The person's own programs the adapter drives, as stand-ins that record how they were started.
  const records: Record<string, string> = {};
  for (const u of i.adapter.uses ?? []) {
    const spec = i.standIns?.[u.program];
    if (spec === undefined) throw new AdapterProofError(`${i.id}: the declaration says the adapter drives ${u.program}, and the proof has no stand-in version line for it`);
    const line = typeof spec === "string" ? spec : spec.version;
    const record = join(i.work, `${u.program}.record`);
    records[u.program] = record;
    writeFileSync(record, "");
    const path = join(bin, u.program);
    if (typeof spec === "string") {
      writeFileSync(path, [
        "#!/bin/sh",
        `if [ "$1" = "--version" ]; then echo ${JSON.stringify(line)}; echo version >> ${JSON.stringify(record)}; exit 0; fi`,
        `echo "run $#" >> ${JSON.stringify(record)}`,
        `echo "stand-in for ${u.program}: not the real program" >&2`,
        "exit 1",
        "",
      ].join("\n"));
    } else {
      // A JSON-RPC responder on the proof's own runtime (never the network: --no-install): one line in, one line out.
      const script = join(i.work, `${u.program}.standin.js`);
      writeFileSync(script, [
        `const fs = require("node:fs");`,
        `const REC = ${JSON.stringify(record)};`,
        `const args = process.argv.slice(2);`,
        `if (args[0] === "--version") { fs.appendFileSync(REC, "version\\n"); console.log(${JSON.stringify(line)}); process.exit(0); }`,
        `fs.appendFileSync(REC, "run " + args.length + "\\n");`,
        `let buf = "";`,
        `process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { fs.appendFileSync(REC, "unparsed\\n"); continue; }`,
        `  if (typeof m.method === "string") fs.appendFileSync(REC, "method " + m.method.slice(0, 64) + "\\n");`,
        `  if (m.id !== undefined && typeof m.method === "string") process.stdout.write(JSON.stringify({ id: m.id, result: m.method === "initialize" ? { userAgent: "stand-in" } : {} }) + "\\n"); } });`,
        `process.stdin.on("end", () => process.exit(0));`,
        "",
      ].join("\n"));
      writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(i.runtime)} --no-install --no-env-file ${JSON.stringify(script)} "$@"\n`);
    }
    chmodSync(path, 0o755);
  }

  // What the wire and the adapter's stderr showed.
  const frames: Record<string, unknown>[] = [];
  const stderr: Buffer[] = [];
  const pids: number[] = [];
  const stderrTail = () => Buffer.concat(stderr).toString("utf8").slice(-TAIL);
  const sent = new Map<string, number>();
  let initialized: { ms: number; result: Record<string, unknown> } | undefined;
  const tap = (dir: "in" | "out", msg: unknown): void => {
    const m = msg as Record<string, unknown>;
    if (frames.length < 200) frames.push({ dir, ...(typeof m["method"] === "string" ? { method: m["method"] } : {}), ...(m["id"] === undefined ? {} : { id: m["id"] }), ...("error" in m ? { error: true } : {}) });
    if (dir === "out" && m["method"] === "initialize" && m["id"] !== undefined) sent.set(String(m["id"]), performance.now());
    if (dir === "in" && m["id"] !== undefined && sent.has(String(m["id"])) && typeof m["result"] === "object" && m["result"] !== null && initialized === undefined) {
      initialized = { ms: Math.round(performance.now() - sent.get(String(m["id"]))!), result: m["result"] as Record<string, unknown> };
    }
  };

  const store = new AdapterStore({ home: i.home, ...(i.download ? { download: i.download } : {}) });
  const backend = new AcpAgentBackend({
    id: i.id, pluginId: `moss/agent-${i.id}`, bundled: true, ...(i.name ? { name: i.name } : {}), quirks: i.quirks, clock: new SystemClock(),
    ...(i.command ? { command: i.command } : {}),
    // The allow-list does the filtering, as in the engine; HOME is the proof's own, so nothing of the runner's is read.
    baseEnv: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: userHome },
    adapter: i.adapter, adapters: store, runtime: () => i.runtime, startTimeoutMs: startMs,
    wire: () => ({ tap, stderr: (c: Uint8Array) => { stderr.push(Buffer.from(c)); }, launched: (pid: number) => { pids.push(pid); }, setupDir: setup }),
  });
  const fail = (what: string): never => {
    throw new AdapterProofError(`${i.id}: ${what}\n--- the adapter's stderr (last ${TAIL} bytes) ---\n${stderrTail() || "(nothing)"}`);
  };

  // 1. The card's yes: the real fetch, then detect.
  if ((await backend.adapterOffer()) === undefined) fail("no download was offered for an adapter that isn't placed");
  const fetched = performance.now();
  try {
    await backend.provideAdapter();
  } catch (err) {
    return fail(`fetching the pinned adapter failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const fetchMs = Math.round(performance.now() - fetched);
  const d = await backend.detect();
  if (!d.installed || !d.identityOk || !d.path) fail(`detect after the download says it isn't usable: ${d.reason ?? "no reason"}`);
  if (d.version !== i.adapter.version) fail(`detect reports version ${d.version ?? "none"}, not the declared ${i.adapter.version}`);
  if (!d.versionOk) fail(`the declared adapter version ${i.adapter.version} is outside the tested range (${d.reason ?? ""})`);

  // 2 and 3. Start it like the engine, bounded; read the wire.
  const spec: AcpStartSpec = {
    sessionId: "s_proof", root,
    fence: new FakeFence({ home: userHome, mossHome: i.home }).policy(),
    bridge: { name: "moss-bridge", command: "/nonexistent/moss-core", args: ["bridge"], env: { MOSS_BRIDGE_TOKEN: "placeholder" }, tools: ["SendMessage", "Glossary"] },
    admitted: { path: d.path!, version: d.version!, ...(d.sha256 === undefined ? {} : { sha256: d.sha256 }) },
  };
  let session: Awaited<ReturnType<AcpAgentBackend["start"]>> | undefined;
  let startError: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"hung">((r) => (timer = setTimeout(() => r("hung"), startMs + 15_000)));
  try {
    const r = await Promise.race([backend.start(spec).then((s) => (session = s), (e: unknown) => { startError = e instanceof Error ? e.message : String(e); }), bound]);
    if (r === "hung") fail(`it neither answered nor failed within ${Math.round((startMs + 15_000) / 1000)} s`);
  } finally {
    clearTimeout(timer);
    await session?.stop().catch(() => undefined);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL"); // pids this proof started
      } catch { /* gone already */ }
    }
  }
  const tail = stderrTail();
  if (LOAD_FAILURE.test(tail) || (startError !== undefined && LOAD_FAILURE.test(startError))) fail(`it didn't load${startError ? ` (${startError.slice(0, 300)})` : ""}`);
  if (initialized === undefined) fail(`initialize was never answered${startError ? ` (${startError.slice(0, 300)})` : ""}`);
  const init = initialized as unknown as { ms: number; result: Record<string, unknown> };
  const pv = init.result["protocolVersion"];
  const info = init.result["agentInfo"] as { name?: unknown } | undefined;
  if (typeof pv !== "number") fail(`initialize came back without a numeric protocolVersion (keys: ${Object.keys(init.result).slice(0, 12).join(", ")})`);
  if (init.ms > startMs) fail(`initialize took ${init.ms} ms`);

  const standIns: AdapterProof["standIns"] = {};
  for (const [program, record] of Object.entries(records)) {
    const lines = readFileSync(record, "utf8").split("\n").filter(Boolean);
    standIns[program] = { versionChecks: lines.filter((l) => l === "version").length, runs: lines.filter((l) => l.startsWith("run ")).map((l) => Number(l.slice(4))), methods: lines.filter((l) => l.startsWith("method ")).map((l) => l.slice(7)) };
  }
  return {
    version: d.version!, digest: d.sha256, fetchMs, packages: 1 + i.adapter.packages.length,
    initialize: { ms: init.ms, protocolVersion: pv as number, agent: typeof info?.name === "string" ? info.name.slice(0, 80) : "(unnamed)" },
    session: startError === undefined ? { ok: true } : { ok: false, error: startError.slice(0, 400) },
    standIns, stderrTail: tail,
  };
}
