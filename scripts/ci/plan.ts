// What a run of ci.yml starts: its jobs, their matrix legs and the macOS runners among them, for a set of changed files and an
// event, read from the workflow's own `if` and `strategy` (nothing is listed here twice). Used to size a run before it starts
// (`scripts/ci/lane start` prints it), to count what a lane's run would have cost, and by scripts/ci-changes.test.ts to hold the
// areas to the jobs behind them.
//
//   bun scripts/ci/plan.ts [--base <rev> | --all | --files a,b] [--event workflow_dispatch|push|pull_request|merge_group] [--only all|acceptance|acceptance-linux] [--list]
//
// Prints the checks and the macOS runners the run would start; `--list` also names every job.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acceptanceUnits, areasFor, CI_AREA_NAMES, type CiArea } from "../ci-changes";
import { ON_GITHUB } from "./acceptance-units";

export type PlanEvent = "pull_request" | "merge_group" | "workflow_dispatch" | "push";

interface Job {
  name?: string;
  if?: string;
  uses?: string;
  "runs-on"?: string;
  strategy?: { matrix?: Record<string, unknown> };
}

export interface PlannedJob {
  id: string;
  /** The checks it starts: one per matrix leg. */
  checks: number;
  macos: number;
  windows: number;
}

export interface Plan {
  jobs: PlannedJob[];
  /** Jobs the run leaves out (skipped: they start no runner). */
  skipped: string[];
  checks: number;
  macos: number;
  windows: number;
}

const ROOT = resolve(import.meta.dir, "..", "..");

export function readWorkflow(file = "ci.yml", root = ROOT): { jobs: Record<string, Job> } {
  return Bun.YAML.parse(readFileSync(join(root, ".github", "workflows", file), "utf8")) as { jobs: Record<string, Job> };
}

/** Evaluate one job `if` over the few forms ci.yml uses; an atom it does not know throws, so a new form fails a test instead of
 *  silently running or skipping a job. */
export function evaluate(cond: string | undefined, ctx: { event: PlanEvent; only: string; areas: Record<string, boolean | string> }): boolean {
  if (cond === undefined) return true;
  const text = cond.trim().replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");
  const tokens = text.match(/\(|\)|&&|\|\||always\(\)|[A-Za-z_.]+\s*(?:==|!=)\s*'[^']*'/g) ?? [];
  if (tokens.join("").replace(/\s/g, "") !== text.replace(/\s/g, "")) throw new Error(`plan: cannot read the condition ${JSON.stringify(cond)}`);
  let at = 0;
  const atom = (t: string): boolean => {
    if (t === "always()") return true;
    const m = /^([A-Za-z_.]+)\s*(==|!=)\s*'([^']*)'$/.exec(t)!;
    const left = m[1]!;
    let value: string;
    if (left === "github.event_name") value = ctx.event;
    else if (left === "github.event.inputs.only") value = ctx.event === "workflow_dispatch" ? ctx.only : "";
    else if (left.startsWith("needs.changes.outputs.")) value = String(ctx.areas[left.slice("needs.changes.outputs.".length)] ?? "");
    else throw new Error(`plan: cannot read ${left} in ${JSON.stringify(cond)}`);
    return m[2] === "==" ? value === m[3] : value !== m[3];
  };
  const primary = (): boolean => {
    const t = tokens[at++]!;
    if (t === "(") { const v = or(); at++; return v; }
    return atom(t);
  };
  const and = (): boolean => { let v = primary(); while (tokens[at] === "&&") { at++; const r = primary(); v = v && r; } return v; };
  const or = (): boolean => { let v = and(); while (tokens[at] === "||") { at++; const r = and(); v = v || r; } return v; };
  return or();
}

/** The legs of a job's matrix, each as its runner (the leg's `runner`, or the job's own `runs-on`). */
function legs(job: Job, units: readonly string[]): string[] {
  const runsOn = typeof job["runs-on"] === "string" && !job["runs-on"].includes("${{") ? job["runs-on"] : "";
  const matrix = job.strategy?.matrix;
  if (matrix === undefined) return [runsOn];
  const include = Array.isArray(matrix.include) ? (matrix.include as Array<Record<string, unknown>>) : [];
  const axes = Object.entries(matrix).filter(([k]) => k !== "include" && k !== "exclude");
  const values = axes.map(([k, v]) => (typeof v === "string" ? (k === "unit" ? [...units] : []) : (v as unknown[])));
  if (axes.length === 0) return include.map((l) => String(l.runner ?? runsOn));
  const runnerAxis = axes.findIndex(([k]) => k === "runner");
  const count = values.reduce((n, v) => n * v.length, 1);
  if (runnerAxis < 0) return Array<string>(count).fill(runsOn);
  // The other axes multiply each runner of the runner axis.
  return values[runnerAxis]!.flatMap((r) => Array<string>(count / values[runnerAxis]!.length).fill(String(r)));
}

/** What the run starts for `areas` (and the acceptance `units`), on `event`. */
export function planFor(areas: Record<CiArea, boolean>, units: readonly string[], event: PlanEvent, only = "all", root = ROOT): Plan {
  const wf = readWorkflow("ci.yml", root);
  const ctx = { event, only, areas: { ...areas } as Record<string, boolean | string> };
  for (const [k, v] of Object.entries(ctx.areas)) ctx.areas[k] = String(v);
  const jobs: PlannedJob[] = [];
  const skipped: string[] = [];
  for (const [id, job] of Object.entries(wf.jobs)) {
    if (!evaluate(job.if, ctx)) { skipped.push(id); continue; }
    if (job.uses !== undefined) {
      // A workflow this one calls: its jobs are this job's checks (all Windows today).
      const called = readWorkflow(job.uses.replace(/^\.\/\.github\/workflows\//, ""), root);
      const n = Object.values(called.jobs).reduce((sum, j) => sum + legs(j, units).length, 0);
      const win = Object.values(called.jobs).flatMap((j) => legs(j, units)).filter((r) => r.startsWith("windows")).length;
      jobs.push({ id, checks: n, macos: 0, windows: win || Object.values(called.jobs).filter((j) => (j["runs-on"] ?? "").startsWith("windows")).length });
      continue;
    }
    const runners = legs(job, units);
    jobs.push({ id, checks: runners.length, macos: runners.filter((r) => r.startsWith("macos")).length, windows: runners.filter((r) => r.startsWith("windows")).length });
  }
  const sum = (f: (j: PlannedJob) => number) => jobs.reduce((n, j) => n + f(j), 0);
  return { jobs, skipped, checks: sum((j) => j.checks), macos: sum((j) => j.macos), windows: sum((j) => j.windows) };
}

/** The plan for the files changed (`undefined`: every area) as a lane's manual run takes them: the areas ci-changes.ts selects. */
export function planForFiles(changed: readonly string[] | undefined, event: PlanEvent = "workflow_dispatch", only = "all", root = ROOT, parked?: readonly string[] | "all"): Plan & { areas: CiArea[]; units: string[] } {
  const areas = areasFor(changed, parked);
  const units = areas.acceptance ? acceptanceUnits(changed) : [];
  return { ...planFor(areas, units, event, only, root), areas: CI_AREA_NAMES.filter((a) => areas[a]), units };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const at = argv.indexOf(name); return at === -1 ? undefined : (argv[at + 1] ?? ""); };
  const { execFileSync } = await import("node:child_process");
  const base = flag("--base");
  const files = flag("--files");
  const changed = argv.includes("--all") ? undefined
    : files !== undefined ? files.split(",").filter(Boolean)
    : base !== undefined ? (() => { try { return execFileSync("git", ["diff", "--name-only", "--no-renames", base, "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean); } catch { return undefined; } })()
    : undefined;
  const event = (flag("--event") ?? "workflow_dispatch") as PlanEvent;
  // The parked areas (ci-changes.ts PARKED): `--parked-base` is the lane's own diff when `--all` is given; `--parked` runs them.
  const parkedBase = flag("--parked-base");
  const parkedDiff = parkedBase === undefined ? undefined : (() => { try { return execFileSync("git", ["diff", "--name-only", "--no-renames", parkedBase, "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean); } catch { return "all" as const; } })();
  const p = planForFiles(changed, event, flag("--only") ?? "all", ROOT, argv.includes("--parked") ? "all" : parkedDiff);
  console.log(`${p.checks} checks start (${p.macos} on macOS, ${p.windows} on Windows), ${p.skipped.length} jobs skipped; areas: ${p.areas.join(" ") || "none"}; acceptance units: ${p.units.length} of ${ON_GITHUB.length}`);
  if (argv.includes("--list")) for (const j of p.jobs) console.log(`  ${j.id}\t${j.checks}\t${j.macos} macOS`);
}
