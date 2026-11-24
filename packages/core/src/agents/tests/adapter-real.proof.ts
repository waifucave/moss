// The REAL pinned adapters of every bundled agent plugin that declares `launch.adapter`, fetched from the real npm registry
// and started on the repo's pinned Bun with the flags and environment the engine uses (agents/testing/adapter-proof.ts).
// It runs ON GITHUB ONLY: a runner may download from the public registry, and a person's machine does not do that without a
// yes. It is not a `*.test.ts` file (no suite picks it up), and it refuses to run unless MOSS_REAL_ADAPTERS=1, which only
// the CI job `agent adapters` (and the macOS leg of `macos`) sets:
//   cd packages/core && MOSS_REAL_ADAPTERS=1 bun test ./src/agents/tests/adapter-real.proof.ts
// The real `claude` and `codex` are not used: a stand-in program prints a matching `--version` line and records that it
// was started, and how many arguments it got (never the arguments), so what the proof shows is that each adapter loads with
// no network at start-up (`--no-install`), answers `initialize`, and, where it goes further, reaches for the person's program.
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readAdapter } from "../plugin-backends";
import { AdapterProofError, proveAdapter } from "../testing/adapter-proof";
import { bundledBackends } from "../testing/bundled-backends";

if (process.env["MOSS_REAL_ADAPTERS"] !== "1") throw new Error("this proof downloads from the public npm registry: it runs on GitHub only (MOSS_REAL_ADAPTERS=1, set by CI's `agent adapters` job)");
setDefaultTimeout(600_000);

/** What each person's program prints for `--version` (matching the plugin's identity pattern). */
const STAND_IN_VERSIONS: Record<string, string | { version: string; jsonRpc: true }> = {
  claude: "2.1.316 (Claude Code)",
  // Codex's adapter drives `codex app-server` and answers no `initialize` of its own before that server is up: its stand-in speaks JSON-RPC.
  codex: { version: "codex-cli 0.100.0", jsonRpc: true },
};

const adapters = Object.values(bundledBackends()).filter((b) => b.file.adapter !== undefined);

describe("the real adapters", () => {
  test("every bundled plugin that declares an adapter is covered (Claude Code and Codex at least)", () => {
    expect(adapters.map((b) => b.id)).toEqual(expect.arrayContaining(["claude-code", "codex"]));
  });

  for (const b of adapters) {
    test(`${b.id}: ${b.file.adapter!.package} ${b.file.adapter!.version} is fetched from the registry, verified, and starts on the pinned Bun with --no-install and answers initialize`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `moss-real-${b.id}-`));
      try {
        const adapter = readAdapter(b.folder, b.file.adapter!);
        const p = await proveAdapter({
          id: b.id, name: b.name, quirks: b.quirks, adapter, home: join(dir, "moss"), work: join(dir, "work"), runtime: process.execPath,
          standIns: STAND_IN_VERSIONS, startMs: 90_000,
        });
        const line = `${b.id} ${p.version} on ${process.platform}-${process.arch}: ${p.packages} package(s) fetched and verified in ${p.fetchMs} ms; initialize answered in ${p.initialize.ms} ms (ACP v${p.initialize.protocolVersion}, agent "${p.initialize.agent}"); session/new ${p.session.ok ? "succeeded" : `failed: ${p.session.error}`}; stand-ins ${JSON.stringify(p.standIns)}`;
        console.log(`adapter proof: ${line}`);
        if (process.env["GITHUB_STEP_SUMMARY"]) appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `- ${line}\n`);
        if (!p.session.ok) console.log(`adapter proof: ${b.id}'s stderr tail:\n${p.stderrTail}`);
      } catch (err) {
        if (err instanceof AdapterProofError) throw err;
        throw new Error(`${b.id}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
