// A long fenced command, as the daemon runs one (the windows-fence remove step, lane WS5): a coding session's `sleep`
// through the fence's Windows leg, holding its pool account's lease while `sandbox remove` runs. Writes what the
// spawner answered to the file named by argv[2] when the command ends. Uses its own throwaway MOSS home.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MossFence } from "../../../packages/core/src/fence/fence";
import { fencedSpawner } from "../../../packages/core/src/fence/fenced-process";
import type { FencedRun } from "../../../packages/core/src/fence/spawn";

const out = process.argv[2]!;
const home = process.env.USERPROFILE!;
const moss = join(home, ".moss-hold");
const cwd = join(moss, "outputs", "hold");
mkdirSync(cwd, { recursive: true });
const fence = new MossFence({ home, mossHome: moss });
const started = Date.now();
const r = await fencedSpawner({ fence }).run({
  command: "echo started; sleep 900; echo finished", cwd, env: {}, timeoutMs: 1_000_000, shell: "bash",
  who: { caller: { kind: "session", sessionId: "hold", sessionKind: "coding" } } as unknown as FencedRun["who"],
});
writeFileSync(out, JSON.stringify({ ...r, afterMs: Date.now() - started, endedAt: Date.now() }));
