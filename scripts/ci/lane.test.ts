// scripts/ci/lane against a stand-in `gh` that answers from canned JSON (through the `--jq` expression the script passes, so the
// script's own jq runs for real): the scoped start, `result`, `wait`'s fallback when the run's job list answers HTTP 502, and `rerun`'s
// single retry. Nothing here reaches GitHub or the network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LANE = join(import.meta.dir, "lane");
const FAKE_GH = `#!/bin/bash
echo "$*" >> "$FAKE_LOG"
fix="$FAKE_FIX"
jq_expr=""; path=""
args=("$@")
[ "$1" = api ] && { shift; while [ $# -gt 0 ]; do case "$1" in --paginate) shift ;; --jq) jq_expr="$2"; shift 2 ;; -*) shift ;; *) path="$1"; shift ;; esac; done
  case "$path" in
    */actions/runs/*/jobs*) [ -n "\${FAKE_JOBS_502:-}" ] && { echo "gh: HTTP 502" >&2; exit 1; }; src="$fix/jobs.json" ;;
    */commits/*/check-runs*) src="$fix/check-runs.json" ;;
    */check-runs/*/annotations) src="$fix/annotations.json" ;;
    */actions/runs/*) src="$fix/run.json" ;;
    */actions/jobs/*) src="$fix/job.json" ;;
    *) echo "fake gh: no fixture for $path" >&2; exit 1 ;;
  esac
  jq -rc "$jq_expr" "$src"; exit $? ; }
set -- "\${args[@]}"
case "$1 $2" in
  "run list") jq_expr=""; while [ $# -gt 0 ]; do [ "$1" = --jq ] && jq_expr="$2"; shift; done; jq -rc "$jq_expr" "$fix/runlist.json" ;;
  "run view") jq_expr=""; while [ $# -gt 0 ]; do [ "$1" = --jq ] && jq_expr="$2"; shift; done; jq -rc "$jq_expr" "$fix/runview.json" ;;
  "run rerun") exit 0 ;;
  "workflow run") printf '[{"databaseId":100,"headSha":"%s"}]' "$FAKE_SHA" > "$fix/runlist.json"; exit 0 ;;
  *) echo "fake gh: unexpected: $*" >&2; exit 1 ;;
esac
`;

let dir: string;
let repo: string;
let origin: string;
let sha: string;
let fixDir: string;

const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

function lane(args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bash", LANE, ...args], {
    cwd: repo, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, FAKE_FIX: fixDir, FAKE_SHA: sha, FAKE_LOG: join(dir, "gh.log"), LANE_TEST_POLL: "0", LANE_TEST_RETRY_SLEEP: "0", LANE_TEST_WAIT_POLL: "0", ...env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const check = (run: string, id: number, name: string, conclusion: string | null, status = "completed") => ({
  id, name, status, conclusion, started_at: "2026-11-24T10:00:00Z", completed_at: conclusion === null ? null : "2026-11-24T10:07:00Z",
  html_url: `https://github.com/o/r/actions/runs/${run}/job/${id}`,
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lane-test-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "gh"), FAKE_GH);
  chmodSync(join(dir, "bin", "gh"), 0o755);
  origin = join(dir, "origin.git");
  repo = join(dir, "repo");
  sh(["git", "init", "--bare", "-b", "main", origin], dir);
  sh(["git", "init", "-b", "lane-int/moss", repo], dir);
  sh(["git", "remote", "add", "origin", origin], repo);
  writeFileSync(join(repo, "a.txt"), "1");
  sh(["git", "add", "a.txt"], repo);
  sh(["git", "commit", "-m", "base"], repo);
  sh(["git", "push", "origin", "lane-int/moss"], repo);
  sh(["git", "fetch", "origin"], repo);
  sh(["git", "checkout", "-b", "lane/x"], repo);
  writeFileSync(join(repo, "b.txt"), "2");
  sh(["git", "add", "b.txt"], repo);
  sh(["git", "commit", "-m", "lane change"], repo);
  sha = sh(["git", "rev-parse", "HEAD"], repo);
  fixDir = join(dir, "fix");
  mkdirSync(fixDir);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixtures(over: { conclusion?: string; attempt?: number; scope?: string }) {
  const jobs = [
    check("100", 1, "changes", "success"), check("100", 2, "names and layout", "success"), check("100", 3, "typecheck", "success"),
    check("100", 4, "acceptance · examples", over.conclusion ?? "failure"), check("100", 5, "acceptance · chain", "success"),
    check("100", 6, "swift (WinterBrowserHost)", "skipped"), check("100", 7, "lane gate", over.conclusion ?? "failure"), check("100", 8, "gate", "success"),
  ];
  writeFileSync(join(fixDir, "jobs.json"), JSON.stringify({ jobs }));
  writeFileSync(join(fixDir, "check-runs.json"), JSON.stringify({ check_runs: [...jobs, check("200", 20, "ios", "success"), check("200", 21, "ios · package tests", "failure")] }));
  writeFileSync(join(fixDir, "annotations.json"), JSON.stringify(over.scope === undefined ? [] : [{ title: "scope", message: over.scope }, { title: "", message: "Process completed with exit code 1." }]));
  writeFileSync(join(fixDir, "run.json"), JSON.stringify({ head_sha: sha, status: "completed", run_attempt: over.attempt ?? 1, conclusion: over.conclusion ?? "failure" }));
  writeFileSync(join(fixDir, "job.json"), JSON.stringify({ steps: [{ name: "Acceptance · examples", conclusion: "failure" }] }));
  writeFileSync(join(fixDir, "runlist.json"), JSON.stringify([{ databaseId: 100, headSha: sha }]));
  writeFileSync(join(fixDir, "runview.json"), JSON.stringify({ status: "completed", conclusion: over.conclusion ?? "failure", url: "https://github.com/o/r/actions/runs/100", headSha: sha }));
}

const SCOPE = "SCOPED RUN: 5 of 22 areas ran, 17 skipped as untouched; 1 of 25 acceptance units (2 file(s) changed since abc; a manual scoped run). Ran: typecheck scripts acceptance. Skipped as untouched: workspaces daemon.";

describe("lane start", () => {
  test("a lane's own branch is started SCOPED from its merge-base with the integration branch; --all and --only are not", () => {
    fixtures({});
    writeFileSync(join(fixDir, "runlist.json"), "[]"); // no run of this commit yet: the fake's `workflow run` makes one
    const mergeBase = sh(["git", "merge-base", "HEAD", "origin/lane-int/moss"], repo);
    writeFileSync(join(dir, "gh.log"), "");
    const r = lane(["start"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`scoped run: your changes since ${mergeBase.slice(0, 9)}`);
    expect(r.out).toContain("run 100");
    const log = readFileSync(join(dir, "gh.log"), "utf8");
    expect(log).toContain(`workflow run ci.yml --ref lane/x -f only=all -f scope=scoped -f base=${mergeBase}`);

    writeFileSync(join(dir, "gh.log"), "");
    writeFileSync(join(fixDir, "runlist.json"), "[]");
    lane(["start", "--all"]);
    expect(readFileSync(join(dir, "gh.log"), "utf8")).toContain("-f only=all -f scope=all");
    expect(readFileSync(join(dir, "gh.log"), "utf8")).not.toContain("base=");

    writeFileSync(join(dir, "gh.log"), "");
    writeFileSync(join(fixDir, "runlist.json"), "[]");
    lane(["start", "--only", "acceptance"]);
    expect(readFileSync(join(dir, "gh.log"), "utf8")).toContain("-f only=acceptance -f scope=all");
  });

  test("with no integration branch to count from, it starts everything (fail closed)", () => {
    writeFileSync(join(dir, "gh.log"), "");
    writeFileSync(join(fixDir, "runlist.json"), "[]");
    const r = lane(["start"], { LANE_BASE_REF: "origin/no-such-branch" });
    expect(r.err).toContain("no merge-base with origin/no-such-branch: running every job");
    expect(readFileSync(join(dir, "gh.log"), "utf8")).toContain("-f scope=all");
  });

  test("an unknown option is refused", () => {
    expect(lane(["start", "--wide"]).code).toBe(2);
  });
});

describe("lane wait and result", () => {
  test("wait prints the jobs, the gate and the scope; a scoped red is still red", () => {
    fixtures({ scope: SCOPE });
    const r = lane(["wait"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("failure\t7m\tacceptance · examples");
    expect(r.out).not.toContain("swift (WinterBrowserHost)");
    expect(r.out).toContain("lane gate: failure");
    expect(r.out).toContain(`scope: ${SCOPE}`);
    expect(r.out).toContain("this is a SCOPED run");
  });

  test("wait of a green scoped run says the green is scoped", () => {
    fixtures({ conclusion: "success", scope: SCOPE });
    const r = lane(["wait"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("lane gate: success");
    expect(r.out).toContain("SCOPED");
  });

  test("a full run's green does not carry the warning, and a run with no scope annotation says it reports none", () => {
    fixtures({ conclusion: "success", scope: "FULL RUN: every area, 25 of 25 acceptance units (a push to an integration branch runs everything). Ran: all." });
    expect(lane(["wait"]).out).not.toContain("this is a SCOPED run");
    fixtures({ conclusion: "success" });
    expect(lane(["wait"]).out).toContain("scope: not reported by this run");
  });

  test("when the run's job list answers HTTP 502, wait reads the commit's check-runs of that run instead", () => {
    fixtures({ scope: SCOPE });
    const r = lane(["wait"], { FAKE_JOBS_502: "1" });
    expect(r.err).toContain("the run's job list did not answer: reading the check-runs");
    expect(r.out).toContain("failure\t7m\tacceptance · examples");
    expect(r.out).toContain("lane gate: failure");
    // The other workflow's checks on the same commit (run 200) are not this run's.
    expect(r.out).not.toContain("ios · package tests");
  });

  test("result prints the gate and every check that is not green, per run, from the check-runs alone", () => {
    fixtures({ scope: SCOPE });
    const r = lane(["result", sha], { FAKE_JOBS_502: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("run 100: 7 checks, 1 skipped");
    expect(r.out).toContain("  lane gate: failure");
    expect(r.out).toContain("  gate: success");
    expect(r.out).toContain("  failure\tacceptance · examples");
    expect(r.out).toContain("run 200: 2 checks, 0 skipped (no gate in it: not a ci.yml run)");
    expect(r.out).toContain("  failure\tios · package tests");
    expect(r.out).toContain(`scope: ${SCOPE}`);
  });

  test("result of a green run says every other check passed", () => {
    fixtures({ conclusion: "success" });
    expect(lane(["result", sha]).out).toContain("every other check: success");
  });
});

describe("lane rerun", () => {
  test("runs only the failed jobs of a finished red run, once", () => {
    fixtures({ attempt: 1 });
    writeFileSync(join(dir, "gh.log"), "");
    const r = lane(["rerun"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "gh.log"), "utf8")).toContain("run rerun 100 --failed");
  });

  test("a second rerun, a green run and a run still running are refused", () => {
    fixtures({ attempt: 2 });
    writeFileSync(join(dir, "gh.log"), "");
    expect(lane(["rerun"]).code).toBe(2);
    expect(lane(["rerun"]).err).toContain("already run again (attempt 2)");
    expect(readFileSync(join(dir, "gh.log"), "utf8")).not.toContain("run rerun");
    fixtures({ attempt: 1, conclusion: "success" });
    expect(lane(["rerun"]).err).toContain("passed: nothing to run again");
    fixtures({ attempt: 1 });
    writeFileSync(join(fixDir, "run.json"), JSON.stringify({ head_sha: sha, status: "in_progress", run_attempt: 1, conclusion: null }));
    expect(lane(["rerun"]).err).toContain("is in_progress");
  });
});
