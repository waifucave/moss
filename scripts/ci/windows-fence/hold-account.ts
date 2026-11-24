// Two long fenced commands, as the daemon runs them (the windows-fence remove step), each on its own pool account and
// holding that account's lease while `sandbox remove` runs, both a bot's through its Bash tool: one in the foreground
// (lane WS5) and one in the background (`run_in_background`, rule B, lane WS7), whose end comes back as the session's
// background-task notification. One session's two: two callers' commands whose read grants and denies cross wait for
// each other (rule 3b), as a coding session's and a bot's do. Writes, to the file named by argv[2], what the spawner
// answered the first and what the second's notification said, once both have ended. Uses its own throwaway MOSS home.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MossFence } from "../../../packages/core/src/fence/fence";
import { fencedSpawner } from "../../../packages/core/src/fence/fenced-process";
import { botSandboxSettings } from "../../../packages/core/src/fence/sandbox-settings";
import { windowsShellTools } from "../../../packages/core/src/fence/win-shell-tools";

const out = process.argv[2]!;
const home = process.env.USERPROFILE!;
const moss = join(home, ".moss-hold");
const cwd = join(moss, "outputs", "hold");
const scratch = join(moss, "scratch", "hold");
for (const d of [cwd, scratch, join(moss, "bots", "hold")]) mkdirSync(d, { recursive: true });
const fence = new MossFence({ home, mossHome: moss });
const spawner = fencedSpawner({ fence });
const started = Date.now();
const caller = { kind: "session", sessionId: "hold-bg", sessionKind: "bot", bot: "hold" } as unknown as Parameters<typeof windowsShellTools>[0]["caller"];
let told!: (w: { task: string; status: string; text: string }) => void;
const wake = new Promise<{ task: string; status: string; text: string }>((res) => { told = res; });
const bash = windowsShellTools({
  spawner, caller, kind: "bot", cwd: () => scratch, userHome: home, temp: fence.temp, mossHome: moss,
  sandbox: () => botSandboxSettings(fence.forCaller(caller).policy(), {
    mossHome: moss, userHome: home, level: undefined, windows: true, ownFolders: [scratch, join(moss, "bots", "hold")], pathFolders: [],
  }),
  wake: async (w) => { told(w); },
}).find((t) => t.name === "Bash")!;
// The foreground one, at its longest limit (10 minutes: remove comes well before).
const foreground = bash.run({ command: "echo started; sleep 900; echo finished", timeout: 600_000 })
  .then((r) => ({ kind: r.isError ? "ended" : "exited", stdout: r.text, afterMs: Date.now() - started, endedAt: Date.now() }));
const answer = await bash.run({ command: "echo started; sleep 900; echo finished", run_in_background: true });
// Refused at the start: no notification will come, so the answer is the end.
if (answer.isError) told({ task: "", status: "not started", text: answer.text });
const log = /written to (\S+\.log)/.exec(answer.text)?.[1];
const [fg, w] = await Promise.all([foreground, wake.then((x) => ({ ...x, endedAt: Date.now() }))]);
const logText = log === undefined ? "" : readFileSync(log, "utf8");
writeFileSync(out, JSON.stringify({ ...fg, background: { answer: answer.text, isError: answer.isError, ...w, log: logText } }));
