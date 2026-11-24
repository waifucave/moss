// scripts/ci-changes.ts: which CI jobs a change runs, for the kinds of change the lanes make.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { units } from "./acceptance/shards";
import { NOT_ON_GITHUB, ON_GITHUB } from "./ci/acceptance-units";
import { planForFiles } from "./ci/plan";
import { acceptanceUnits, areasFor, CI_AREA_NAMES, isKnown, matches, matchesAny, queueAreasFor, scopeOf, unmapped, type CiArea } from "./ci-changes";

const on = (changed: string[]): CiArea[] => CI_AREA_NAMES.filter((a) => areasFor(changed)[a]);

describe("ci-changes", () => {
  test("patterns: a folder prefix, a one-folder file prefix, globs, and exact paths", () => {
    expect(matches("apps/desktop/src/main/index.ts", "apps/")).toBe(true);
    expect(matches("appsx/a.ts", "apps/")).toBe(false);
    expect(matches("scripts/verify-runtimes-compiled.ts", "scripts/verify-")).toBe(true);
    expect(matches("scripts/verify-x/y.ts", "scripts/verify-")).toBe(false);
    expect(matches("plugins/moss/plugins/shell/package.json", "**/package.json")).toBe(true);
    expect(matches("package.json", "**/package.json")).toBe(true);
    expect(matches("services/hello/tsconfig.test.json", "**/tsconfig*.json")).toBe(true);
    expect(matches("VERSION", "VERSION")).toBe(true);
    expect(matches("VERSIONS.json", "VERSION")).toBe(false);
  });

  test("docs and reports run no area (only the names-and-layout checks and the gate)", () => {
    expect(on(["docs/moss-plan.md", "docs/research/2026-11-05-x.md", "README.md"])).toEqual([]);
  });

  test("a change to MOSS's own plugins: their tests, the app that loads them, the gallery and the typecheck", () => {
    // (and the acceptance run, which loads the bundled plugins: any plugin file but a test file starts every unit)
    // (and the core's and the scripts' suites, which walk plugins/ and read the bundled manifests, the theme and the marks)
    expect(on(["plugins/moss/plugins/shell/src/a.tsx", "plugins/moss/plugins/shell/test/a.test.ts"])).toEqual(["workspaces", "app", "gallery", "typecheck", "core", "scripts", "acceptance"]);
    expect(on(["plugins/moss/plugins/shell/test/a.test.ts"])).toEqual(["workspaces", "app", "gallery", "typecheck", "core", "scripts"]);
    expect(on(["plugins/moss/plugins/shell/package.json"])).toEqual(["workspaces", "app", "gallery", "typecheck", "lockfiles", "core", "scripts", "acceptance"]);
    // Another top-level plugin (a bot's) is not loaded by the app's own build.
    expect(on(["plugins/alpha/tab/theme.json"])).toEqual(["workspaces", "gallery", "typecheck", "core", "scripts", "acceptance"]);
  });

  test("the packages: packaging/ and the app's builder config build and open the Linux packages; an app change does too", () => {
    expect(on(["packaging/linux/after-install.sh"])).toEqual(["packages", "installers", "scripts"]);
    expect(on(["apps/desktop/electron-builder.yml"])).toEqual(["workspaces", "app", "packages", "installers", "typecheck", "scripts", "acceptance"]);
  });

  test("MOSS's packages and installers build when MOSS's builder config, host layout or icons change (not for its window's code alone)", () => {
    for (const f of ["apps/moss/electron-builder.yml", "apps/moss/scripts/host-helper.mjs", "apps/moss/build/icons/16x16.png", "apps/moss/package.json"]) {
      expect(areasFor([f]).packages, f).toBe(true);
      expect(areasFor([f]).installers, f).toBe(true);
    }
    expect(areasFor(["apps/moss/src/window/a.tsx"]).installers).toBe(false);
    expect(areasFor(["packaging/moss.rb.tmpl"]).installers).toBe(true);
    expect(areasFor(["scripts/release/artifacts.ts"]).packages).toBe(true);
  });

  test("the installers' release build runs for what makes them, never for code, CI's own files or a lockfile alone", () => {
    for (const f of ["scripts/release/lib.ts", "packaging/windows/installer.nsh", "apps/desktop/electron-builder.yml", "apps/desktop/package.json", "scripts/build-packages.ts", "packages/update-feed/src/index.ts"]) {
      expect(areasFor([f]).installers).toBe(true);
    }
    for (const f of ["bun.lock", ".bun-version", ".github/workflows/ci.yml", "packages/core/src/daemon.ts", "apps/desktop/src/main/index.ts", "packages/cli/src/main.ts"]) {
      expect(areasFor([f]).installers).toBe(false);
    }
    expect(areasFor(undefined).installers).toBe(true);
  });

  test("the merge queue's sweep (its own workflow): the scripts' tests, which run its step against stand-ins", () => {
    // (and the core's: one of its tests reads every workflow's triggers)
    expect(on([".github/workflows/queue-sweep.yml"])).toEqual(["core", "scripts"]);
  });

  test("a service's change: its tests and the typecheck", () => {
    expect(on(["services/forwarder/src/index.ts"])).toEqual(["workspaces", "typecheck"]);
  });

  test("macOS: a merge-queue run takes three macOS jobs (its machine's, the sealed-core gate's and the one for core, cli, scripts and verify, which runs in legs); a pull request takes none (the local gate); Swift runs on demand only", () => {
    type Job = { if?: string; "runs-on"?: string; strategy?: { matrix?: { include?: string | Array<{ runner: string }> } } };
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, Job> }).jobs;
    type Event = "pull_request" | "merge_group" | "workflow_dispatch";
    const runsOn = (j: Job, event: Event): boolean => {
      const cond = j.if ?? "";
      if (cond.includes("github.event_name == 'workflow_dispatch'") && event !== "workflow_dispatch") return false;
      if (cond.includes("github.event_name != 'pull_request'") && event === "pull_request") return false;
      return true;
    };
    const isMac = (j: Job, event: Event): boolean => {
      if (j["runs-on"] === "macos-latest") return true;
      const include = j.strategy?.matrix?.include;
      if (typeof include === "string") return include.includes("macos");
      return (include ?? []).some((r) => r.runner.startsWith("macos"));
    };
    const macJobs = (changed: string[], event: Event = "merge_group"): string[] => {
      // (a pull request and a merge-queue group take the union with the old map; a lane's run the new map alone)
      const areas = event === "merge_group" || event === "pull_request" ? queueAreasFor(changed) : areasFor(changed);
      return Object.entries(jobs).flatMap(([id, j]) => {
        const wanted = [...(j.if ?? "").matchAll(/needs\.changes\.outputs\.(\w+) == 'true'/g)].some((m) => areas[m[1] as CiArea]);
        return wanted && runsOn(j, event) && isMac(j, event) ? [id] : [];
      });
    };
    // The machine job runs every machine, macOS among them, and never on a pull request.
    expect((jobs.machine!.strategy!.matrix!.include as Array<{ runner: string }>).map((r) => r.runner)).toContain("macos-latest");
    expect(jobs.machine!.if).toStartWith("github.event_name != 'pull_request' && ");
    expect(macJobs(["packages/core/src/daemon.ts"])).toEqual(["machine", "sealed-core", "macos"]);
    expect(macJobs(["bun.lock"])).toEqual(["machine", "sealed-core", "macos"]);
    expect(macJobs([".github/workflows/ci.yml"])).toEqual(["machine", "sealed-core", "macos"]);
    expect(macJobs(["packages/cli/src/main.ts"])).toEqual(["machine", "sealed-core", "macos"]);
    // An apple/ change: the Swift kits on demand only; the core's tests read apple/ (the guest's sources, the Computer Use core, the plist pins), so its macos job runs.
    expect(macJobs(["apple/ComputerUse/WinterBrowserHost/Sources/Host.swift"])).toEqual(["macos"]);
    expect(macJobs(["apple/ComputerUse/WinterBrowserHost/Sources/Host.swift"], "workflow_dispatch")).toEqual(["macos", "swift"]);
    expect(on(["apple/ComputerUse/WinterBrowserHost/Sources/Host.swift"])).not.toContain("scriptsmac");
    expect(macJobs(["scripts/embed-runtimes.sh"])).toEqual(["macos"]);
    expect(on(["scripts/embed-runtimes.sh"])).toEqual(expect.arrayContaining(["scripts", "scriptsmac"]));
    expect(macJobs(["plugins/moss/plugins/shell/src/a.tsx"])).toEqual(["machine", "macos"]);
    expect(macJobs(["docs/moss-plan.md"])).toEqual([]);
    // A pull request takes no hosted macOS runner, whatever it changes.
    for (const change of ["packages/core/src/daemon.ts", ".github/workflows/ci.yml", "apple/ComputerUse/WinterBrowserHost/Sources/Host.swift", "scripts/embed-runtimes.sh", "plugins/moss/plugins/shell/src/a.tsx"]) {
      expect(macJobs([change], "pull_request")).toEqual([]);
    }
  });

  // Owner's ruling, November 10: a pull request runs the quick Linux checks only; the four machines and everything
  // else run in the merge queue (and on a manual run). `gate` needs every job either path can run.
  test("a pull request runs only the quick Linux jobs; the merge queue and a manual run run every job; gate needs them all", () => {
    type Job = { if?: string; "runs-on"?: string; needs?: string | string[]; strategy?: { matrix?: { include?: Array<{ runner: string }>; runner?: string[] } } };
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, Job> }).jobs;
    type Event = "pull_request" | "merge_group" | "workflow_dispatch" | "push";
    const can = (j: Job, event: Event): boolean => {
      const cond = j.if ?? "";
      // The acceptance run and the lane gate: a push to an integration branch and a manual run only.
      if (cond.includes("github.event_name == 'push' || github.event_name == 'workflow_dispatch'") && event !== "push" && event !== "workflow_dispatch") return false;
      if (cond.includes("github.event_name == 'workflow_dispatch'") && !cond.includes("github.event_name == 'push'") && event !== "workflow_dispatch") return false;
      if (cond.includes("github.event_name == 'pull_request'") && event !== "pull_request") return false;
      if (cond.includes("github.event_name != 'pull_request'") && event === "pull_request") return false;
      return true;
    };
    const runners = (j: Job): string[] => [...(j["runs-on"] !== undefined && !j["runs-on"].includes("${{") ? [j["runs-on"]] : []), ...(j.strategy?.matrix?.include ?? []).map((r) => r.runner), ...(j.strategy?.matrix?.runner ?? [])];
    const on = (event: Event): string[] => Object.keys(jobs).filter((id) => id !== "gate" && can(jobs[id]!, event)).sort();
    // What only a push to an integration branch and a manual run take, besides the dispatch-only jobs.
    const LANE_ONLY = ["acceptance", "lane-gate", "acceptance-linux"];
    expect(on("pull_request")).toEqual(["changes", "core-linux", "lockfiles", "names", "protocol-codegen", "scripts", "test-extension", "typecheck", "workspaces-pr"]);
    for (const id of on("pull_request")) expect([id, runners(jobs[id]!).every((r) => r.startsWith("ubuntu-24.04") && !r.endsWith("-arm"))]).toEqual([id, true]);
    // The merge queue: every job a change can take, but the PR-only one, the dispatch-only ones and the lane's two.
    expect(on("merge_group")).toEqual(Object.keys(jobs).filter((id) => !["gate", "workspaces-pr", "swift", "swift-cowork-launcher", "libkrun-queue", ...LANE_ONLY].includes(id)).sort());
    for (const id of ["machine", "machine-windows", "packages", "installers", "installers-windows", "tree", "tree-windows", "link", "link-windows", "linux-repo-signatures", "gallery", "macos"]) {
      expect([id, on("merge_group").includes(id), on("workflow_dispatch").includes(id), on("push").includes(id), on("pull_request").includes(id)]).toEqual([id, true, true, true, false]);
    }
    // A push to an integration branch runs what a manual run does, but for the dispatch-only jobs (the Swift kits, Cowork).
    expect(on("push")).toEqual(on("workflow_dispatch").filter((id) => !["swift", "swift-cowork-launcher", "libkrun-queue", "acceptance-linux"].includes(id)));
    for (const id of LANE_ONLY.filter((x) => x !== "acceptance-linux")) expect([id, on("pull_request").includes(id), on("merge_group").includes(id), on("push").includes(id), on("workflow_dispatch").includes(id)]).toEqual([id, false, false, true, true]);
    // The Linux acceptance (lane LX) is on a manual run only: not on a pull request, in the merge queue or on a push, and neither gate waits for it.
    expect(["acceptance-linux", on("pull_request").includes("acceptance-linux"), on("merge_group").includes("acceptance-linux"), on("push").includes("acceptance-linux"), on("workflow_dispatch").includes("acceptance-linux")]).toEqual(["acceptance-linux", false, false, false, true]);
    // The machines: Windows is its own job, so the lane gate can leave it out.
    expect(runners(jobs.machine!).sort()).toEqual(["macos-latest", "ubuntu-24.04", "ubuntu-24.04-arm"]);
    expect(runners(jobs["machine-windows"]!)).toEqual(["windows-latest"]);
    // gate: always, and it needs every job any of the three runs can take (the dispatch-only Cowork jobs aside, which
    // were never part of it).
    const gate = jobs.gate!;
    expect(gate.if).toBe("always()");
    const needs = new Set(Array.isArray(gate.needs) ? gate.needs : [gate.needs]);
    const ran = new Set([...on("pull_request"), ...on("merge_group"), ...on("workflow_dispatch")].filter((id) => !["swift-cowork-launcher", "libkrun-queue", ...LANE_ONLY].includes(id)));
    expect([...ran].filter((id) => !needs.has(id))).toEqual([]);
    // The PR's workspaces job is the machine job's step, on linux-x64.
    expect(JSON.stringify(jobs["workspaces-pr"])).toContain("scripts/with-private-secret-service.sh bun scripts/workspaces.ts run test");
  });

  test("any package's source runs the scripts job, whose source scans (the native channel's anti-wiring test) read every src/", () => {
    for (const f of ["packages/cli/src/worker-entry-probe.ts", "packages/test-harness/src/x.ts", "packages/core/src/daemon.ts", "scripts/build-daemon.ts"]) {
      expect([f, on([f]).includes("scripts")]).toEqual([f, true]);
    }
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, { steps?: Array<{ run?: string; "working-directory"?: string }> }> }).jobs;
    const scan = jobs.scripts?.steps?.find((s) => (s.run ?? "").includes("anti-wiring.test.ts"));
    expect([scan?.["working-directory"], scan?.run]).toEqual(["packages/core", "bun test test/cowork/native/anti-wiring.test.ts"]);
  });

  test("the core: its own, the CLI's and the scripts' tests, the daemon, the packages that carry it, the compiled gates and the Swift kits (WinterKit runs its daemon); not the app", () => {
    const core = on(["packages/core/src/daemon.ts"]);
    expect(core).toEqual(["workspaces", "daemon", "packages", "typecheck", "core", "cli", "scripts", "scriptsmac", "verify", "acceptance"]);
    expect(core).not.toContain("app");
  });

  test("a model plugin alone runs the core's suite (lane A's catalog and generator check), and other plugins don't", () => {
    expect(on(["plugins/moss/plugins/model-openai/moss.json"])).toContain("core");
    expect(on(["plugins/moss/plugins/model-anthropic/src/catalog.ts"])).toContain("core");
    // (any plugin runs it: the core's scans walk plugins/ and read the bundled manifests)
    expect(on(["plugins/moss/plugins/shell/src/a.tsx"])).toContain("core");
    expect(on(["apps/moss/src/main/index.ts"])).not.toContain("core");
  });

  test("the tree job (Linux and Windows) runs for the tree's and the computers' code and tests, and their conformance suites", () => {
    for (const f of ["packages/core/src/tree/index.ts", "packages/core/src/computers/registry.ts", "packages/core/test/tree/x.test.ts",
      "packages/core/test/computers/x.test.ts", "packages/core/src/contracts/tests/tree.test.ts", "packages/core/src/contracts/tests/computer-registry.test.ts",
      "packages/core/src/agents/backend.ts", "packages/core/src/agents/process/launch.ts", "packages/core/src/agents/tests/windows-path.test.ts",
      "plugins/moss/plugins/agent-cursor/moss.json", "plugins/moss/plugins/agent-gemini/moss.json"]) {
      expect(on([f]), f).toContain("tree");
    }
    expect(on(["packages/core/src/daemon.ts"])).not.toContain("tree");
    expect(on(["plugins/moss/plugins/agent-cursor/quirks.json"])).not.toContain("tree");
    expect(on(["packages/core/src/contracts/tests/secret-store.test.ts"])).not.toContain("tree");
    // The secrets file's code and tests (lane SF) take the Windows leg, whose step reads the file's key from Credential Manager.
    for (const f of ["packages/core/src/secrets/file-backend.ts", "packages/core/test/secrets/secrets-file-backend.test.ts", "packages/core/src/auth/secret-store.ts"]) expect(on([f]), f).toContain("tree");
  });

  test("the link job runs for the sidecar, the links, and the devices and identity under them; the sidecar's change builds the packages too", () => {
    // (no workspace package lives in native/: the sidecar's change takes no machine for the workspaces' tests)
    expect(on(["native/link/src/main.rs"])).toEqual(["packages", "link"]);
    for (const f of ["packages/core/src/links/sidecar-wire.ts", "packages/core/src/devices/registry.ts", "packages/core/src/identity/account.ts",
      "packages/core/src/contracts/link-transport.ts", "packages/core/src/clock/system-clock.ts", "packages/protocol/src/index.ts"]) expect(on([f]), f).toContain("link");
    expect(on(["packages/core/src/daemon.ts"])).not.toContain("link");
    expect(on(["native/link-sidecar/src/main.rs"])).not.toContain("link");
  });

  test("every CI step that runs the link tests requires the sidecar, so a missing build fails instead of skipping", () => {
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, { steps?: Array<{ run?: string; env?: Record<string, string> }> }> }).jobs;
    const steps = Object.values(jobs).flatMap((j) => j.steps ?? []).filter((s) => /bun test\b.*\bsrc\/links\b/.test(s.run ?? ""));
    // The macOS job's, the Linux link job's and its Windows twin's (the same steps by YAML anchor).
    expect(steps.length).toBe(3);
    for (const s of steps) expect(s.env?.MOSS_LINK_REQUIRE_BINARY).toBe("1");
  });

  test("the services' shared source and the sign-in stub run the core's suite (its account tests import them)", () => {
    expect(on(["services/shared/account-token.ts"])).toContain("core");
    expect(on(["packages/test-harness/src/signin-stub.ts"])).toContain("core");
    // (any package's source: the core's anti-wiring scan walks packages/)
    expect(on(["packages/test-harness/src/workers.ts"])).toContain("core");
    expect(on(["services/push/src/index.ts"])).not.toContain("core");
  });

  test("the Swift tests run for apple/ and CI's own definition, and not for the protocol or the CLI", () => {
    expect(on(["apple/ComputerUse/WinterBrowserHost/Sources/Host.swift"])).toEqual(["core", "scripts", "swift"]);
    expect(on(["packages/protocol/generated/fixtures/x.json"])).not.toContain("swift");
    expect(on(["packages/protocol/src/methods.ts"])).not.toContain("swift");
    expect(on(["packages/cli/src/main.ts"])).not.toContain("swift");
    // Only apple/ and CI's own definition run them: not the core, the toolchain or a lockfile.
    expect(on(["packages/core/src/daemon.ts"])).not.toContain("swift");
    for (const g of [".bun-version", "package.json", "bun.lock", "pnpm-lock.yaml"]) expect(on([g]), g).not.toContain("swift");
    expect(on(["scripts/ci-changes.ts"])).toContain("swift");
  });

  test("CI itself runs every area but the installers; the toolchain, the root manifest or a lockfile every area but the Swift kits and the installers; so does no diff", () => {
    for (const f of [".github/workflows/ci.yml", "scripts/ci-changes.ts"]) expect(on([f])).toEqual(CI_AREA_NAMES.filter((a) => a !== "installers"));
    // (the Cowork launcher's Swift tests are CI's own definition's too, like the browser host's)
    for (const f of [".bun-version", "package.json", "bun.lock", "pnpm-lock.yaml", ".npmrc", ".gitattributes"]) expect(on([f]), f).toEqual(CI_AREA_NAMES.filter((a) => a !== "swift" && a !== "installers" && a !== "cowork"));
    expect(CI_AREA_NAMES.filter((a) => areasFor(undefined)[a])).toEqual(CI_AREA_NAMES);
  });

  test("ci.yml has a job, or a matrix of them, behind every area, and the gate waits for them all", () => {
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, { if?: string; needs?: string | string[] }> }).jobs;
    // A job may serve several areas (`… == 'true' || … == 'true'`), each step taking its own.
    const gated = Object.values(jobs).flatMap((j) => [...(j.if ?? "").matchAll(/needs\.changes\.outputs\.(\w+) == 'true'/g)].map((m) => m[1]!));
    expect([...new Set(gated)].sort()).toEqual([...CI_AREA_NAMES].sort());
    const gateNeeds = jobs.gate?.needs;
    const all = Object.keys(jobs).filter((id) => !["gate", "acceptance", "acceptance-linux", "lane-gate", "swift-cowork-launcher", "libkrun-queue"].includes(id));
    expect([...(Array.isArray(gateNeeds) ? gateNeeds : [])].sort()).toEqual(all.sort());
  });
});

// The merge queue (main's protection): a queued PR is tested on top of the latest main before it lands, which needs CI,
// and so `gate`, to run on its merge group, with the areas taken from the group's own base.
describe("CI on a merge-queue group", () => {
  const ci = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as {
    on: Record<string, unknown>;
    jobs: Record<string, { if?: string; outputs?: Record<string, string>; steps?: { id?: string; run?: string; env?: Record<string, string> }[] }>;
  };

  test("the changes job hands on every area: its outputs are exactly the areas ci-changes.ts writes", () => {
    // A job keyed to an area the outputs leave out reads an empty string, is skipped every time, and the gate passes.
    const outputs = ci.jobs.changes?.outputs ?? {};
    // …and the acceptance units the run starts and its scope, which the acceptance jobs' matrix and the lane gate read.
    expect(Object.keys(outputs).sort()).toEqual([...CI_AREA_NAMES, "acceptance_units", "scope", "scope_ran", "scope_skipped"].sort());
    for (const [name, value] of Object.entries(outputs)) expect(value, name).toBe(`\${{ steps.areas.outputs.${name} }}`);
  });

  test("ci.yml runs on merge_group, and gate runs whatever happened", () => {
    expect(Object.keys(ci.on)).toContain("merge_group");
    expect(ci.jobs.gate?.if).toBe("always()");
  });

  test("the changes job compares a group with the base it was built on", () => {
    const step = ci.jobs.changes?.steps?.find((s) => s.id === "areas");
    expect(step?.env?.GROUP_BASE).toBe("${{ github.event.merge_group.base_sha }}");
    expect(step?.run).toContain('merge_group)');
    expect(step?.run).toContain('--base "$GROUP_BASE"');
  });
});

// The lane gate: lanes work on `lane-int/*` branches with no pull request, so CI runs on a push to them and by hand on a
// lane's own branch, and `lane-gate` is the one result a lane reads: `gate` without the Windows jobs, plus the acceptance run.
describe("CI for the lanes", () => {
  type Job = { if?: string; needs?: string | string[]; "runs-on"?: string; uses?: string; strategy?: { matrix?: { unit?: string; include?: Array<{ runner: string }>; runner?: string[] } } };
  const ci = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as {
    on: { push?: { branches?: string[] }; workflow_dispatch?: { inputs?: Record<string, unknown> } };
    concurrency: { group: string; "cancel-in-progress": string };
    jobs: Record<string, Job>;
  };
  const needsOf = (id: string): string[] => { const n = ci.jobs[id]!.needs; return Array.isArray(n) ? n : n === undefined ? [] : [n]; };
  // A job that calls one of this repo's workflows (`uses: ./.github/workflows/<file>`) runs on that workflow's jobs' runners.
  const runnersOf = (j: Job): string[] => j.uses?.startsWith("./.github/workflows/")
    ? Object.values((Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", j.uses.slice(2)), "utf8")) as { jobs: Record<string, Job> }).jobs).flatMap((c) => runnersOf(c))
    : [...(j["runs-on"] !== undefined && !j["runs-on"].includes("${{") ? [j["runs-on"]] : []), ...(j.strategy?.matrix?.include ?? []).map((r) => r.runner), ...(j.strategy?.matrix?.runner ?? [])].filter((r): r is string => typeof r === "string");

  test("a push to an integration branch runs CI, a newer push or manual run on a ref cancels the one it supersedes, a merge group never does, and a run of an integration branch is never cancelled while it runs", () => {
    expect(ci.on.push?.branches).toEqual(["lane-int/**"]);
    expect(Object.keys(ci.on)).toEqual(expect.arrayContaining(["pull_request", "merge_group", "push", "workflow_dispatch"]));
    // A push is the integration branch's tip: the run that is running finishes, one newer push waits behind it and a still newer one
    // replaces the waiting one (GitHub's concurrency without cancel-in-progress), so the tip gets whole runs. A pull request and a
    // lane's own manual run still cancel the run they supersede.
    expect(ci.concurrency["cancel-in-progress"]).toBe("${{ github.event_name != 'merge_group' && github.event_name != 'push' }}");
    expect(ci.concurrency.group).toContain("github.head_ref || github.ref");
    // A manual run of the acceptance alone is its own group.
    expect(ci.concurrency.group).toContain("github.event.inputs.only");
    expect(Object.keys(ci.on.workflow_dispatch?.inputs ?? {})).toEqual(["only", "scope", "base"]);
    // The scope input defaults to everything: only `scripts/ci/lane start` asks for a scoped run, with the base it counts from.
    expect((ci.on.workflow_dispatch!.inputs!.scope as { default: string }).default).toBe("all");
  });

  test("the lane gate is the gate without the Windows jobs, plus the acceptance run", () => {
    const windows = Object.keys(ci.jobs).filter((id) => runnersOf(ci.jobs[id]!).some((r) => r.startsWith("windows")));
    expect(windows.sort()).toEqual(["installers-windows", "link-windows", "machine-windows", "sealed-core-windows", "tree-windows", "windows-fence"]);
    const gate = needsOf("gate");
    const lane = needsOf("lane-gate");
    expect(lane.sort()).toEqual([...gate.filter((id) => !windows.includes(id)), "acceptance"].sort());
    // Every job the full gate needs is a Windows job or the lane gate's too: nothing weakens `gate`.
    for (const id of windows) expect([id, gate.includes(id)]).toEqual([id, true]);
    expect(ci.jobs["lane-gate"]!.if).toContain("always()");
    expect(ci.jobs.gate!.if).toBe("always()");
  });

  test("the acceptance run is one macOS job per unit the run needs (the changes job's list, of ON_GITHUB), and every unit of shards.ts is on GitHub or says why not (NOT_ON_GITHUB)", () => {
    const acceptance = ci.jobs.acceptance!;
    expect(acceptance["runs-on"]).toBe("macos-latest");
    // The matrix is the changes job's list: the Linux run takes the same one, and both wait for the changes job and its `acceptance` area.
    expect(acceptance.strategy!.matrix!.unit).toBe("${{ fromJSON(needs.changes.outputs.acceptance_units) }}");
    expect(ci.jobs["acceptance-linux"]!.strategy!.matrix!.unit).toBe("${{ fromJSON(needs.changes.outputs.acceptance_units) }}");
    for (const id of ["acceptance", "acceptance-linux"]) {
      expect(needsOf(id), id).toEqual(["changes"]);
      expect(ci.jobs[id]!.if, id).toContain("needs.changes.outputs.acceptance == 'true'");
    }
    // The units a run can start are ON_GITHUB: the line a new unit is added to.
    const matrix = [...ON_GITHUB];
    const known = units().map((u) => u.id as string);
    // One name once, and one that exists.
    expect(new Set(matrix).size).toBe(matrix.length);
    for (const u of matrix) expect(known).toContain(u);
    // The chain is the long pole and every row no other unit names: it always runs.
    expect(matrix).toContain("chain");
    // A unit that exists is on GitHub or has its reason not to be, never neither and never both: adding a unit to
    // shards.ts fails here until its lane adds ONE name to the matrix line of ci.yml or one entry to NOT_ON_GITHUB.
    for (const id of known) {
      const where = [matrix.includes(id) ? "the matrix" : "", NOT_ON_GITHUB[id] !== undefined ? "NOT_ON_GITHUB" : ""].filter(Boolean);
      expect([id, where.length]).toEqual([id, 1]);
    }
    for (const reason of Object.values(NOT_ON_GITHUB)) expect(reason.length).toBeGreaterThan(20);
  });

  test("the macOS job's legs deal the core's tests in thirds and between them run every part the one job ran", () => {
    const legs = (ci.jobs.macos as unknown as { strategy: { matrix: { include: Array<{ shard: number; parts: string }> } } }).strategy.matrix.include;
    expect(legs.map((l) => l.shard)).toEqual([1, 2, 3]);
    expect(legs.flatMap((l) => l.parts.split(" ").filter(Boolean)).sort()).toEqual(["cli", "link", "scripts", "verify"]);
    const run = JSON.stringify(ci.jobs.macos);
    expect(run).toContain("--darwin --shard ${{ matrix.shard }}/3");
  });
  test("the real agent adapters' proof runs for the agent plugins and the agents' code, on Linux x64 and arm64 and in the macOS job, on GitHub only (never a pull request), and both gates wait for it", () => {
    expect(on(["plugins/moss/plugins/agent-codex/quirks.json"])).toContain("adapters");
    expect(on(["packages/core/src/agents/backend.ts"])).toContain("adapters");
    expect(on(["plugins/moss/plugins/shell/src/a.tsx"])).not.toContain("adapters");
    type Job = { if?: string; needs?: string | string[]; strategy?: { matrix?: { runner?: string[] } }; steps?: Array<{ run?: string; env?: Record<string, string> }> };
    const jobs = (Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, Job> }).jobs;
    const job = jobs["agent-adapters"]!;
    expect(job.if).toContain("github.event_name != 'pull_request'");
    expect(job.strategy?.matrix?.runner).toEqual(["ubuntu-24.04", "ubuntu-24.04-arm"]);
    // The switch the proof refuses to run without is set by these two places only.
    const proofSteps = (j: Job) => (j.steps ?? []).filter((x) => (x.run ?? "").includes("adapter-real.proof.ts"));
    expect(proofSteps(job).map((x) => x.env?.MOSS_REAL_ADAPTERS)).toEqual(["1"]);
    expect(proofSteps(jobs.macos!).map((x) => x.env?.MOSS_REAL_ADAPTERS)).toEqual(["1"]);
    expect(Object.entries(jobs).filter(([, j]) => proofSteps(j).length > 0).map(([id]) => id).sort()).toEqual(["agent-adapters", "macos"]);
    for (const gate of ["lane-gate", "gate"]) expect([gate, (jobs[gate]!.needs as string[]).includes("agent-adapters")]).toEqual([gate, true]);
  });
});

describe("the path-to-area map", () => {
  test("a `!` pattern takes paths back out of the patterns before it; an area's own list is the only place it is read", () => {
    expect(matchesAny("scripts/embed-runtimes.sh", ["scripts/", "!scripts/ci/"])).toBe(true);
    expect(matchesAny("scripts/ci/lane", ["scripts/", "!scripts/ci/"])).toBe(false);
    expect(matchesAny("docs/a.md", ["scripts/", "!scripts/ci/"])).toBe(false);
  });

  // Each row: the files, the areas they start (every area is listed: a new area, or a path that starts one it should not, shows here),
  // and the acceptance units. "all" is every unit of ON_GITHUB.
  type Row = { name: string; files: string[]; areas: CiArea[]; units: string[] | "all" };
  const ROWS: Row[] = [
    { name: "a document", files: ["docs/moss-spec.md", "README.md", "follow_up.md", "LICENSE"], areas: [], units: [] },
    // The iPhone apps and the phone core have their own workflows: no desktop job, no macOS runner, only the scripts' Linux tests.
    { name: "the iPhone apps", files: ["apps/ios/project.yml", "apps/ios/Apps/MOSS/Assets.xcassets/AccentColor.colorset/Contents.json", "apps/ios/Packages/MossPhoneKit/Package.swift", "apps/ios/Scripts/make-icons.swift"], areas: ["scripts"], units: [] },
    { name: "the iOS workflow", files: [".github/workflows/ios.yml"], areas: ["core","scripts"], units: [] },
    { name: "the phone core (lane PC, when it lands)", files: ["native/phone-core/src/lib.rs", "native/phone-core/Cargo.toml"], areas: ["scripts"], units: [] },
    { name: "the native helpers", files: ["native/sandbox/windows-probe.cs", "native/input/macos/Package.swift", "native/link-sidecar/src/main.rs"], areas: ["scripts"], units: [] },
    { name: "the link sidecar", files: ["native/link/src/main.rs"], areas: ["packages", "link"], units: [] },
    // The harness and its steps: a test file starts none, a step file its own unit, anything shared every unit.
    { name: "a test of the acceptance harness", files: ["scripts/acceptance/sealed-press.test.ts"], areas: ["typecheck", "core", "scripts"], units: [] },
    { name: "one unit's step file", files: ["scripts/acceptance/canvas-step.ts"], areas: ["typecheck", "core", "scripts", "acceptance"], units: ["canvas"] },
    { name: "the acceptance driver", files: ["scripts/acceptance/run.ts"], areas: ["typecheck", "core", "scripts", "acceptance"], units: "all" },
    { name: "the window's steps", files: ["scripts/acceptance/ui-steps.ts"], areas: ["typecheck", "core", "scripts", "acceptance"], units: "all" },
    { name: "a fixture of the acceptance", files: ["scripts/acceptance/fixtures/acceptance-ui/moss.json"], areas: ["typecheck", "core", "scripts", "acceptance"], units: "all" },
    { name: "the unit runner", files: ["scripts/ci/acceptance-unit.ts"], areas: ["typecheck", "core", "scripts", "acceptance"], units: "all" },
    // CI's own scripts take no macOS leg of the scripts' darwin tests: none reads them.
    { name: "the lane script", files: ["scripts/ci/lane"], areas: ["workspaces", "daemon", "app", "packages", "gallery", "typecheck", "lockfiles", "extension", "core", "cli", "scripts", "scriptsmac", "codegen", "verify", "tree", "link", "linuxrepo", "adapters", "acceptance"], units: "all" },
    { name: "the Windows fence's CI scripts", files: ["scripts/ci/windows-fence/hold-account.ts", "scripts/ci/windows-fence/remove.ps1"], areas: ["workspaces", "daemon", "app", "typecheck", "core", "cli", "scripts"], units: [] },
    { name: "a script the macOS tests read", files: ["scripts/embed-runtimes.sh"], areas: ["typecheck", "core", "scripts", "scriptsmac"], units: [] },
    // The shared packages start everything that builds on them.
    { name: "the protocol", files: ["packages/protocol/src/agents.ts", "packages/protocol/generated/moss/agents.json"], areas: ["workspaces", "daemon", "packages", "gallery", "typecheck", "core", "cli", "scripts", "codegen", "verify", "link", "acceptance"], units: "all" },
    { name: "the plugin SDK", files: ["packages/plugin-sdk/src/views.ts", "packages/plugin-sdk/generated/catalog.json"], areas: ["workspaces", "daemon", "app", "packages", "gallery", "typecheck", "core", "cli", "scripts", "verify", "acceptance"], units: "all" },
    { name: "the engine's source", files: ["packages/core/src/agents/driver.ts"], areas: ["workspaces", "daemon", "packages", "typecheck", "core", "cli", "scripts", "scriptsmac", "verify", "adapters", "acceptance"], units: "all" },
    { name: "the engine's tests only", files: ["packages/core/test/fence/win-fenced.test.ts"], areas: ["workspaces", "daemon", "packages", "typecheck", "core", "cli", "scripts", "verify"], units: [] },
    { name: "a service", files: ["services/push/src/index.ts", "services/push/wrangler.jsonc"], areas: ["workspaces", "typecheck"], units: [] },
    { name: "an app of the desktop's", files: ["apps/moss/src/main/press.ts", "apps/desktop/src/main/ui/brokers.ts"], areas: ["workspaces", "app", "packages", "typecheck", "core", "scripts", "acceptance"], units: "all" },
    { name: "an app's tests only", files: ["apps/moss/test/press-sequences.test.ts"], areas: ["workspaces", "app", "typecheck", "scripts"], units: [] },
    { name: "the SDK's examples directory", files: ["examples/sample-echo/src/index.ts"], areas: ["workspaces", "typecheck", "core"], units: [] },
    { name: "the Cowork launcher", files: ["apple/Cowork/WinterCoworkLauncher/Package.swift"], areas: ["core", "scripts", "scriptsmac", "swift", "cowork"], units: [] },
    { name: "the brand assets and the release notes", files: ["assets/brand/lockup-on-dark.svg", "releases/notes/0.113.0.md"], areas: ["scripts"], units: [] },
  ];

  for (const row of ROWS) {
    test(`${row.name}: ${row.areas.join(" ") || "no area"}; ${row.units === "all" ? "every acceptance unit" : row.units.length === 0 ? "no acceptance unit" : `the ${row.units.join(", ")} unit`}`, () => {
      // Every area, in CI_AREA_NAMES' order.
      expect(on(row.files)).toEqual(CI_AREA_NAMES.filter((a) => row.areas.includes(a)));
      expect(acceptanceUnits(row.files)).toEqual(row.units === "all" ? [...ON_GITHUB] : ON_GITHUB.filter((u) => (row.units as string[]).includes(u)));
      expect(unmapped(row.files)).toEqual([]);
    });
  }

  test("a path no area maps runs every area and every unit (fail closed), the inert ones run none", () => {
    for (const f of ["newtop/x.ts", "apps/android/build.gradle", "native/newlib/src/lib.rs", "Makefile", "docs-but-not/x.md"]) {
      expect([f, isKnown(f)]).toEqual([f, false]);
      expect(on([f]), f).toEqual([...CI_AREA_NAMES]);
      expect(acceptanceUnits([f]), f).toEqual([...ON_GITHUB]);
    }
    // One stray path in an otherwise small change: everything.
    expect(on(["docs/a.md", "apps/android/x.kt"])).toEqual([...CI_AREA_NAMES]);
    for (const f of ["docs/a/b.md", "README.md", "CONTRIBUTING.md", ".gitignore"]) expect([f, isKnown(f), on([f])]).toEqual([f, true, []]);
    // A change with no files (an empty diff) runs nothing; no diff to go on runs everything.
    expect(on([])).toEqual([]);
    expect(areasFor(undefined).acceptance).toBe(true);
    expect(acceptanceUnits(undefined)).toEqual([...ON_GITHUB]);
  });

  test("every tracked file is mapped: no path of this checkout runs the whole table by accident", () => {
    const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: join(import.meta.dir, ".."), stdout: "pipe" }).stdout.toString().split("\n").filter(Boolean);
    expect(unmapped(tracked)).toEqual([]);
  });

  test("a folder of native/ that holds a workspace package is covered by the workspaces' tests", () => {
    for (const dir of readdirSync(join(import.meta.dir, "..", "native"), { withFileTypes: true })) {
      if (dir.isDirectory() && existsSync(join(import.meta.dir, "..", "native", dir.name, "package.json"))) expect(areasFor([`native/${dir.name}/src/x.ts`]).workspaces, dir.name).toBe(true);
    }
  });

  test("a rename counts both paths: a file moved out of one area into another is a change to both", () => {
    // ci-changes reads `git diff --name-only --no-renames`: the old path is a change too (the source holds the flag).
    expect(readFileSync(join(import.meta.dir, "ci-changes.ts"), "utf8")).toContain('"--no-renames"');
  });

  test("what builds on a package starts when the package changes: the jobs of a dependent's source are the jobs of the dependency's", () => {
    const root = join(import.meta.dir, "..");
    const dirs = ["packages", "services", "examples", "extensions"].flatMap((d) => readdirSync(join(root, d), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${d}/${e.name}`))
      .concat(["apps/desktop", "apps/moss", "plugins/moss/plugins/shell"]);
    const pkgs = new Map<string, { dir: string; deps: string[] }>();
    for (const dir of dirs) {
      const file = join(root, dir, "package.json");
      if (!existsSync(file)) continue;
      const p = JSON.parse(readFileSync(file, "utf8")) as { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      pkgs.set(p.name, { dir, deps: Object.entries({ ...p.dependencies, ...p.devDependencies }).filter(([, v]) => v.startsWith("workspace:")).map(([k]) => k) });
    }
    const dependentsOf = (name: string, seen = new Set<string>()): Set<string> => {
      for (const [other, p] of pkgs) if (p.deps.includes(name) && !seen.has(other)) { seen.add(other); dependentsOf(other, seen); }
      return seen;
    };
    // The jobs a source file of a package starts on a lane's manual run (a test file starts no unit, so a source file stands for it).
    const jobsOf = (dir: string): string[] => planForFiles([`${dir}/src/__probe.ts`]).jobs.map((j) => j.id).sort();
    // What a dependency's change does NOT have to start of its dependent's: jobs behind the dependent's own files. (The engine's own
    // test-harness is a dev dependency of the engine, whose suites run on the core's own areas; the services' account tests import
    // the harness's stub, which the `core` area names itself: ci-changes.ts.)
    const OWN: Record<string, string[]> = {
      "packages/core": ["tree", "link", "adapters", "windows-fence"],
      "packages/test-harness": ["core", "daemon", "verify", "cli", "macos", "sealed-core", "sealed-core-windows", "core-linux", "machine", "machine-windows", "packages", "windows-fence", "agent-adapters", "link", "tree", "link-windows", "tree-windows", "scripts", "acceptance", "gallery", "installers", "installers-windows", "linux-repo-signatures", "test-extension", "lockfiles", "codegen"],
    };
    const missing: string[] = [];
    for (const [name, p] of pkgs) {
      for (const dependent of dependentsOf(name)) {
        const d = pkgs.get(dependent)!;
        const need = jobsOf(d.dir).filter((j) => !jobsOf(p.dir).includes(j) && !(OWN[p.dir] ?? []).includes(j));
        if (need.length > 0 && p.dir.startsWith("packages/")) missing.push(`${p.dir} -> ${d.dir}: ${need.join(" ")}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

// The lanes merged into lane-int/moss between 2026-11-17 and 2026-11-24 (git log origin/main..origin/lane-int/moss): each one's real
// changed files (trimmed to a file or two per folder), the areas a manual scoped run takes for them, the acceptance units and whether a
// macOS runner starts. A lane that touched the engine or the app still takes the whole table, as it must; one that touched the iPhone apps,
// a service, a CI script or an engine test file takes a few Linux jobs. A change to the map that moves one of these shows here.
describe("regression list: the lanes of this week", () => {
  type Lane = { lane: string; what: string; files: string[]; areas: CiArea[]; units: string[] | "all"; macos: boolean };
  const LANES: Lane[] = [
    { lane: "press under load", what: "PL: the main-process press gates, the stall watch, the app log", files: ["apps/desktop/src/main/index.ts","apps/desktop/test/send-gate-load.test.ts","apps/moss/src/main/index.ts","apps/moss/test/moss-app-log.test.ts","packages/app-release/src/app-log.ts","packages/app-release/src/stall-watch.ts","packages/app-release/test/app-log-safety.test.ts","packages/app-release/test/stall-watch.test.ts","apps/desktop/test/send-gate-sequences.test.ts","apps/moss/test/file-log.test.ts","apps/moss/test/press-load.test.ts","apps/moss/test/press-sequences.test.ts","apps/moss/src/window/conversation/Conversation.tsx","apps/moss/test/window.test.tsx"],
      areas: ["workspaces","app","packages","typecheck","core","scripts","acceptance"], units: "all", macos: true },
    { lane: "iOS apps", what: "IA: the two iPhone apps and their workflow", files: ["apps/ios/Packages/MossPhoneKit/Sources/MossPhoneKit/Views/PairingScreen.swift",".github/workflows/ios.yml","apps/ios/.gitignore","apps/ios/Apps/MOSS/Assets.xcassets/AccentColor.colorset/Contents.json","apps/ios/Apps/MOSSCode/Assets.xcassets/AccentColor.colorset/Contents.json","apps/ios/Scripts/make-icons.swift","apps/ios/project.yml"],
      areas: ["core","scripts"], units: [], macos: true },
    { lane: "devices and pairing settings", what: "DV: pairing by QR, device names, the relay choice", files: ["apps/moss/src/main/engine.ts","apps/moss/src/shared/view.ts","apps/moss/src/window/settings/SettingsPage.tsx","apps/moss/test/ma2-pages.test.tsx","docs/devices-map.md","packages/protocol/src/devices.ts","plugins/moss/plugins/settings/client/SettingsModal.tsx","packages/core/src/devices/names.ts","packages/core/src/ipc/device-links.ts","packages/core/src/links/pairing.ts","packages/core/test/ipc/device-links.test.ts","apps/desktop/src/main/ui/tree-calls.ts","apps/desktop/test/runtime.test.ts","apps/desktop/test/tree-calls.test.ts"],
      areas: ["workspaces","daemon","app","packages","gallery","typecheck","core","cli","scripts","scriptsmac","codegen","verify","link","acceptance"], units: "all", macos: true },
    { lane: "Windows fence WS5/WS6", what: "WS: sandbox remove on Windows", files: ["packages/cli/src/main.ts","packages/core/src/fence/win-fenced.ts","packages/core/src/index.ts","packages/core/test/fence/win-fenced.e2e.test.ts","scripts/ci/windows-fence/remove.ps1","scripts/ci/windows-fence/hold-account.ts"],
      areas: ["workspaces","daemon","app","packages","typecheck","core","cli","scripts","scriptsmac","verify","acceptance"], units: "all", macos: true },
    { lane: "push service", what: "the push service's topics per phone app", files: ["services/push/wrangler.jsonc","services/push/src/apns.ts","services/push/src/env.ts","services/push/src/fcm.ts","services/push/src/index.ts","services/push/src/push-do.ts","services/push/test/fake-log.ts","services/push/test/node/fakes.ts","services/push/test/notifier-integration.test.ts","services/push/test/push.test.ts","services/push/test/routing.test.ts","services/push/vitest.config.ts"],
      areas: ["workspaces","typecheck"], units: [], macos: true },
    { lane: "phone push routing", what: "the notifier, the registry and the engine's pairing record", files: ["plugins/moss/plugins/push/src/notifier.ts","packages/core/src/daemon.ts","packages/core/src/notify/core-updates.ts","packages/plugin-sdk/src/api/plugin-api.ts","packages/protocol/src/push-routing.ts","packages/protocol/test/push-routing.test.ts","plugins/moss/plugins/notifications/src/notifier.ts","packages/core/src/contracts/device-registry.ts","packages/core/src/devices/registry.ts","packages/core/src/identity/sas.ts","packages/core/src/links/pairing.ts","packages/core/test/ipc/link-clients.test.ts","packages/plugin-sdk/src/views.ts","packages/protocol/generated/moss/core.json"],
      areas: ["workspaces","daemon","app","packages","gallery","typecheck","core","cli","scripts","scriptsmac","codegen","verify","link","acceptance"], units: "all", macos: true },
    { lane: "phone start", what: "a paired phone starts a coding session", files: ["packages/core/src/agents/tests/adapter-card.test.ts","packages/protocol/test/session-graph.test.ts","packages/core/test/ipc/link-clients.test.ts","packages/protocol/generated/moss/agents.json","packages/protocol/src/agents.ts","packages/protocol/test/remote-start.test.ts","packages/core/src/contracts/device-registry.ts","packages/core/src/daemon.ts","packages/core/src/devices/tests/registry.test.ts"],
      areas: ["workspaces","daemon","packages","gallery","typecheck","core","cli","scripts","scriptsmac","codegen","verify","link","adapters","acceptance"], units: "all", macos: true },
    { lane: "agents early start", what: "the idle timer of an early-started agent", files: ["packages/core/src/agents/driver.ts"],
      areas: ["workspaces","daemon","packages","typecheck","core","cli","scripts","scriptsmac","verify","adapters","acceptance"], units: "all", macos: true },
    { lane: "CI lane wait", what: "scripts/ci/lane polls once a minute", files: ["scripts/ci/lane"],
      areas: ["workspaces","daemon","app","packages","gallery","typecheck","lockfiles","extension","core","cli","scripts","scriptsmac","codegen","verify","tree","link","linuxrepo","adapters","acceptance"], units: "all", macos: true },
    { lane: "composer model read", what: "the composer's model read and acceptance row 11", files: ["plugins/moss/plugins/composer/client/entry.tsx","scripts/acceptance/ui-steps.ts"],
      areas: ["workspaces","app","gallery","typecheck","core","scripts","acceptance"], units: "all", macos: true },
    { lane: "core test only", what: "one engine test file", files: ["packages/core/test/fence/win-fenced.test.ts"],
      areas: ["workspaces","daemon","packages","typecheck","core","cli","scripts","verify"], units: [], macos: true },
    { lane: "plugin-sdk views", what: "the SDK's generated views.ts", files: ["packages/plugin-sdk/src/views.ts"],
      areas: ["workspaces","daemon","app","packages","gallery","typecheck","core","cli","scripts","verify","acceptance"], units: "all", macos: true },
  ];
  for (const l of LANES) {
    test(`${l.lane} (${l.what}): ${l.areas.join(" ")}; ${l.units === "all" ? "every unit" : l.units.length === 0 ? "no unit" : l.units.join(" ")}; ${l.macos ? "macOS runners" : "no macOS runner"}`, () => {
      expect(on(l.files)).toEqual(l.areas);
      expect(acceptanceUnits(l.files)).toEqual(l.units === "all" ? [...ON_GITHUB] : l.units);
      expect(planForFiles(l.files).macos > 0).toBe(l.macos);
      expect(unmapped(l.files)).toEqual([]);
    });
  }
});

describe("the scope a run states", () => {
  const all = (changed: string[] | undefined) => { const areas = areasFor(changed); return scopeOf({ changed, areas, units: areas.acceptance ? acceptanceUnits(changed) : [], why: "a manual scoped run", base: "8ce5aef0b" }); };

  test("a scoped run says SCOPED RUN, how many areas ran and were skipped, and the acceptance units; a full one says FULL RUN", () => {
    const s = all(["apps/ios/project.yml"]);
    expect(s.scope).toBe("SCOPED RUN: 1 of 22 areas ran, 21 skipped as untouched; 0 of 25 acceptance units (1 file(s) changed since 8ce5aef0b; a manual scoped run)");
    expect(s.ran).toEqual(["scripts"]);
    expect(s.skipped).toContain("acceptance");
    expect(all(undefined).scope).toStartWith("FULL RUN: every area, 25 of 25 acceptance units");
    // CI's own definition runs every area but the installers: still a scoped run, which says so.
    expect(all([".github/workflows/ci.yml"]).scope).toStartWith("SCOPED RUN: 21 of 22 areas ran, 1 skipped as untouched; 25 of 25 acceptance units");
    expect(all([".github/workflows/ci.yml", "packaging/linux/after-install.sh"]).scope).toStartWith("FULL RUN: every area, 25 of 25 acceptance units, as the 2 file(s) changed since 8ce5aef0b touched them all");
  });

  test("a path no area maps says so in the scope: the run is full because it could not be sure", () => {
    const s = all(["apps/android/x.kt"]).scope;
    expect(s).toContain("FULL RUN");
    expect(s).toContain("1 changed path(s) no area maps, e.g. apps/android/x.kt (fail closed");
  });

  test("an acceptance-only run says so", () => {
    const areas = Object.fromEntries(CI_AREA_NAMES.map((a) => [a, a === "acceptance"])) as Record<CiArea, boolean>;
    expect(scopeOf({ changed: [], areas, units: ON_GITHUB, why: "a manual run of only: acceptance", onlyAcceptance: true }).scope).toBe("ACCEPTANCE ONLY: 25 of 25 acceptance units; no other area (a manual run of only: acceptance)");
  });

  test("the CLI prints the same lines the workflow's outputs carry", () => {
    const run = (args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "ci-changes.ts"), ...args], { stdout: "pipe", env: { ...process.env, GITHUB_OUTPUT: "" } }).stdout.toString();
    const out = run(["--all", "--why", "a push to an integration branch runs everything"]);
    expect(out).toContain("acceptance=true");
    expect(out).toContain(`acceptance_units=${JSON.stringify([...ON_GITHUB])}`);
    expect(out).toContain("scope=FULL RUN: every area, 25 of 25 acceptance units (a push to an integration branch runs everything)");
    expect(run(["--only-acceptance", "--why", "x"])).toContain("workspaces=false\n");
    // A base that cannot be read here runs every area, and the scope says why.
    const bad = run(["--base", "0000000000000000000000000000000000000000", "--why", "a manual scoped run"]);
    expect(bad).toContain("scope=FULL RUN: every area");
    expect(bad).toContain("could not be read here: fail closed");
  });
});
