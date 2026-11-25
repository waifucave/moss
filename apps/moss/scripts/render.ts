// The renders for the owner's approval: MOSS's window drawn offscreen against the fake engine, scene by scene (a
// conversation with an attachment and a card, the side panel with a live picture and routines, the strip with another
// bot's card, the Plugins page, Settings), light and dark, at a usual and a narrow size, as PNGs.
//
//   bun run scripts/render.ts <out dir> [--2x]     (--2x: twice the pixels, for sharp pictures; the default is unchanged)
//
// Headless and silent: a test build of MOSS in a background-only Electron (MOSS_UI_LOCAL_ELECTRON on macOS, made by
// scripts/background-electron.ts), its window offscreen and never shown, a temp home and user data.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startFakeEngine } from "../test/fake-engine/engine";
import { pagePng } from "../test/picture";

// The long conversation's words (the long-scrolled scene): a person and a bot planning a week's meals.
const ASKS = ["What's in the fridge that should go first?", "Can you make Tuesday vegetarian?", "Add a quick lunch for Wednesday.", "How much is that for the week?", "Swap the fish for something cheaper.", "Put it all in a shopping list."];
const ANSWERS = ["The spinach and the leftover rice. I'd start Monday with a stir-fry that uses both.", "Done: a lentil curry on Tuesday, and the leftovers make Wednesday's lunch too.", "A chickpea wrap takes ten minutes and uses what's already open.", "About $64 with the pantry staples you already have.", "Chicken thighs instead: the same protein for about $9 less.", "The list is ready, grouped by shop aisle, with quantities for two."];
const longText = (i: number): string => (i % 2 === 0 ? ASKS : ANSWERS)[Math.floor(i / 2) % 6]!;
const out = process.argv.slice(2).find((a) => !a.startsWith("--"));
const twice = process.argv.includes("--2x");
if (out === undefined || out === "") {
  console.error("usage: bun run scripts/render.ts <out dir>");
  process.exit(2);
}
const root = join(import.meta.dir, "..");
const local = process.env.MOSS_UI_LOCAL_ELECTRON;
const electron = local !== undefined && local !== "" ? local : (createRequire(join(root, "package.json"))("electron") as string);
if (process.platform === "darwin") {
  const plist = join(dirname(dirname(electron)), "Info.plist");
  const v = spawnSync("plutil", ["-extract", "LSBackgroundOnly", "raw", plist], { encoding: "utf8" });
  if (v.status !== 0 || v.stdout.trim() !== "true") {
    console.error("render: MOSS_UI_LOCAL_ELECTRON must name a background-only Electron (scripts/background-electron.ts)");
    process.exit(2);
  }
}
const built = spawnSync(process.execPath, ["run", "scripts/build.ts", "--test-build"], { cwd: root, encoding: "utf8" });
if (built.status !== 0) {
  console.error(built.stderr);
  process.exit(1);
}
const home = mkdtempSync(join(tmpdir(), "mr-"));
let pid: number | undefined;
const engine = await startFakeEngine({ home, noCards: (process.env.MOSS_RENDER_SCENES ?? "").startsWith("question-"), picturePng: await pagePng(), frameMs: 400, peerPid: () => pid, longTalk: { bot: "maple", messages: 60, text: longText },
  // Two more bots at work, so the status line shows other phrases: reading a file and reading a site.
  running: {
    juniper: { name: "mcp__moss__Browser", argsJson: "{}" },
    brook: { name: "Read", argsJson: JSON.stringify({ file_path: "/Users/someone/Documents/Budget 2026.xlsx" }) },
    ...(process.env.MOSS_RENDER_SCENES === "question" ? {} : { ada: { name: "WebFetch", argsJson: JSON.stringify({ url: "https://www.example.com/lisbon?q=private" }) } }),
  },
});
engine.feed.set({ subject: { kind: "bots", id: "brook" }, state: "working", name: "Brook", tool: "Read", since: Date.now() - 20_000 });
if (process.env.MOSS_RENDER_SCENES !== "question") engine.feed.set({ subject: { kind: "bots", id: "ada" }, state: "working", name: "Ada", tool: "WebFetch", since: Date.now() - 20_000 });
// Kite's conversation ends with a reply in Markdown and a question she is waiting on (the question scene).
engine.say("kite", { type: "user_message", text: "Start a Codex agent on a new project and use terra.", clientName: "MOSS" });
engine.say("kite", { type: "assistant_message", text: "Here is what I can do for you:\n\n- **Start a coding agent for you.** You tell me what to build and where, and I start it in the background.\n- **Look things up.** I search the web and read `notes.txt` when it helps.\n\nRun it later with:\n\n```sh\nnpm test\n```\n\nSee [the docs](https://example.com/docs) for more." });
engine.say("kite", { type: "question_asked", callId: "call_render_1", questions: [{ question: "Which model should the Codex agent use?", header: "Model", multiSelect: false, options: [{ label: "Codex's default (Recommended)", description: "Whatever Codex picks for itself." }, { label: "Use fable", description: "A Claude model." }, { label: "Use opus", description: "A Claude model." }, { label: "Hold off", description: "Do nothing yet." }] }] });
// The card stays open while the conversation goes on past it: the person writes, she replies, the card is still above, open.
engine.say("kite", { type: "user_message", text: "Meanwhile, can you list the folders in the project?", clientName: "MOSS" });
engine.say("kite", { type: "assistant_message", text: "Sure. The project has three folders: `src`, `docs` and `scripts`. I'll hold the agent until you pick a model." });
// The question card's other states, one bot each (the question scenes; MOSS_RENDER_SCENES=question draws only them):
// answered (Cobalt), withdrawn when the turn ended (Fern), a question of several lines (Onyx), an option with a long label (Ada).
const ask = (bot: string, callId: string, questions: unknown[]) => engine.say(bot, { type: "question_asked", callId, questions });
const opts = (...labels: string[]) => labels.map((label) => ({ label, description: "" }));
ask("cobalt", "call_render_answered", [{ question: "Should I retry the sync with the backup drive plugged in?", header: "Backup", multiSelect: false, options: [{ label: "Yes, retry", description: "Run the sync again now." }, { label: "Not today", description: "Leave it for later." }] }]);
engine.say("cobalt", { type: "question_resolved", callId: "call_render_answered", answers: { "Should I retry the sync with the backup drive plugged in?": "Yes, retry" }, by: "user", toBot: true });
engine.say("cobalt", { type: "user_message", answersQuestion: "call_render_answered", text: "My answer to your question \"Should I retry the sync with the backup drive plugged in?\": chose \"Yes, retry\"", clientName: "MOSS" });
engine.say("cobalt", { type: "assistant_message", text: "Thanks. Retrying the sync now; I'll tell you when it's done." });
ask("fern", "call_render_withdrawn", [{ question: "Which folder should the summary go in?", header: "Folder", multiSelect: false, options: [{ label: "Meetings", description: "The meetings folder." }, { label: "Notes", description: "The notes folder." }] }]);
engine.say("fern", { type: "question_resolved", callId: "call_render_withdrawn", answers: {}, by: "aborted" });
ask("onyx", "call_render_lines", [{ question: "Before I resume on Monday, three things are unclear.\n\n1. Should the weekly report still go to the whole team?\n2. Do you want the numbers in euros or dollars?\n3. Is the old archive folder still in use?\n\nWhich of these should I settle first?", header: "Resume", multiSelect: false, options: opts("The report's recipients", "The currency", "The archive folder") }]);
ask("ada", "call_render_long", [{ question: "How should I update the reading list?", header: "Update", multiSelect: false, options: [{ label: "Add the three new books to the end of the list, keep the order I gave you, and mark each one with the month I should start it so that nothing is read twice or skipped", description: "A long label, to see it wrap." }, { label: "Leave it", description: "No change." }] }]);
ask("brook", "call_render_skipped", [{ question: "Should I archive last year's photos to the backup drive?", header: "Archive", multiSelect: false, options: [{ label: "Yes, archive", description: "Move them now." }, { label: "Leave them", description: "Keep them where they are." }] }]);
engine.say("brook", { type: "question_resolved", callId: "call_render_skipped", answers: {}, by: "user", skipped: true, toBot: true });
engine.say("brook", { type: "user_message", answersQuestion: "call_render_skipped", text: "I skipped your question \"Should I archive last year's photos to the backup drive?\". Carry on without an answer.", clientName: "MOSS" });
engine.say("brook", { type: "assistant_message", text: "Understood. I'll leave the photos where they are." });
// Two cards open at once in one conversation (Juniper).
ask("juniper", "call_render_two_a", [{ question: "Which airline should I check first?", header: "Airline", multiSelect: false, options: opts("The one with the 8:05 nonstop", "The cheapest one") }]);
ask("juniper", "call_render_two_b", [{ question: "Is a checked bag still needed?", header: "Bag", multiSelect: false, options: opts("Yes, one bag", "No, carry-on only") }]);
const env: NodeJS.ProcessEnv = { ...process.env, MOSS_HOME: home, MOSS_USER_DATA: join(home, "user-data"), MOSS_TEST_FRONT: "1" };
delete env.MOSS_PROFILE;
delete env.ELECTRON_RUN_AS_NODE;
const dir = resolve(out);
const child = spawn(electron, [root, `--moss-render=${dir}`, ...(twice ? ["--moss-render-scale=2"] : [])], { env, stdio: ["ignore", "inherit", "inherit"] });
pid = child.pid;
const code = await new Promise<number | null>((r) => {
  const t = setTimeout(() => { child.kill("SIGKILL"); r(null); }, 240_000);
  child.on("exit", (c) => { clearTimeout(t); r(c); });
});
await engine.close();
rmSync(home, { recursive: true, force: true });
const run = JSON.parse(readFileSync(join(dir, "render-run.json"), "utf8")) as { ok: boolean; written: string[] };
console.log(`render: ${run.ok ? "ok" : "failed"}, ${run.written.length} pictures in ${dir} (exit ${code})`);
process.exit(run.ok && code === 0 ? 0 : 1);
