// scripts/ci/plan.ts: what a run of ci.yml starts for a change.
import { describe, expect, test } from "bun:test";
import { areasFor, CI_AREA_NAMES } from "../ci-changes";
import { ON_GITHUB } from "./acceptance-units";
import { evaluate, planFor, planForFiles } from "./plan";

const ids = (files: string[] | undefined, event: "workflow_dispatch" | "push" | "pull_request" | "merge_group" = "workflow_dispatch", only = "all"): string[] =>
  planForFiles(files, event, only).jobs.map((j) => j.id);

describe("evaluate: the forms ci.yml's job conditions use", () => {
  const ctx = (event: "push" | "workflow_dispatch" | "pull_request", only = "all", areas: Record<string, boolean | string> = {}) => ({ event, only, areas });

  test("events, the manual input, areas, and/or with parentheses, always()", () => {
    expect(evaluate("github.event_name != 'pull_request' && (needs.changes.outputs.core == 'true' || needs.changes.outputs.cli == 'true')", ctx("push", "all", { cli: "true" }))).toBe(true);
    expect(evaluate("github.event_name != 'pull_request' && (needs.changes.outputs.core == 'true' || needs.changes.outputs.cli == 'true')", ctx("pull_request", "all", { cli: "true" }))).toBe(false);
    expect(evaluate("github.event_name != 'pull_request' && (needs.changes.outputs.core == 'true' || needs.changes.outputs.cli == 'true')", ctx("push", "all", {}))).toBe(false);
    expect(evaluate("(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.event.inputs.only != 'acceptance-linux'", ctx("workflow_dispatch", "acceptance-linux"))).toBe(false);
    expect(evaluate("(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.event.inputs.only != 'acceptance-linux'", ctx("push", "acceptance-linux"))).toBe(true);
    expect(evaluate("${{ always() && (github.event_name == 'push') }}", ctx("push"))).toBe(true);
    expect(evaluate(undefined, ctx("push"))).toBe(true);
  });

  test("a form it does not know throws, so a new kind of condition fails a test instead of running or skipping a job unseen", () => {
    expect(() => evaluate("contains(github.ref, 'x')", ctx("push"))).toThrow();
    expect(() => evaluate("github.actor == 'x'", ctx("push"))).toThrow();
  });
});

describe("planFor: the checks and macOS runners a run starts", () => {
  test("every area on a push: one macOS job per unit of the acceptance, the machine's, the sealed core's, the core's three legs and the installers'", () => {
    const p = planForFiles(undefined, "push");
    expect(p.jobs.find((j) => j.id === "acceptance")!.checks).toBe(ON_GITHUB.length);
    expect(p.jobs.find((j) => j.id === "macos")!.macos).toBe(3);
    expect(p.jobs.find((j) => j.id === "machine")!.macos).toBe(1);
    expect(p.macos).toBe(ON_GITHUB.length + 3 + 1 + 1 + 1);
    // A push takes none of the dispatch-only jobs.
    for (const id of ["acceptance-linux", "swift", "swift-cowork-launcher", "libkrun-queue"]) expect(p.skipped).toContain(id);
  });

  test("a manual run of everything is a push's and the Linux acceptance: the parked Swift kits and Cowork stay out; --parked adds them", () => {
    const push = ids(undefined, "push");
    const dispatch = ids(undefined, "workflow_dispatch");
    expect(dispatch.filter((id) => !push.includes(id)).sort()).toEqual(["acceptance-linux"]);
    const parked = planForFiles(undefined, "workflow_dispatch", "all", undefined, "all").jobs.map((j) => j.id);
    expect(parked.filter((id) => !push.includes(id)).sort()).toEqual(["acceptance-linux", "libkrun-queue", "swift", "swift-cowork-launcher"]);
    // ... and the lane's own diff does it (what `lane start --all` sends): the host's folder runs the host's job and not Cowork's.
    const own = planForFiles(undefined, "workflow_dispatch", "all", undefined, ["apple/ComputerUse/WinterBrowserHost/Sources/Host.swift"]).jobs.map((j) => j.id);
    expect(own).toContain("swift");
    expect(own).not.toContain("swift-cowork-launcher");
    expect(planForFiles(undefined, "workflow_dispatch").jobs.find((j) => j.id === "acceptance-linux")!.checks).toBe(ON_GITHUB.length);
  });

  test("a document starts the names-and-layout check and the gates, and no runner but Linux's", () => {
    const p = planForFiles(["docs/moss-spec.md"]);
    expect(p.jobs.map((j) => j.id)).toEqual(["changes", "names", "lane-gate", "gate"]);
    expect(p.macos).toBe(0);
  });

  test("the iPhone apps and the phone core start no macOS job and no desktop acceptance", () => {
    for (const files of [["apps/ios/project.yml"], ["apps/ios/Packages/MossPhoneKit/Package.swift"], ["native/phone-core/src/lib.rs"]]) {
      const p = planForFiles(files);
      expect(p.macos, files.join()).toBe(0);
      expect(p.jobs.map((j) => j.id), files.join()).not.toContain("acceptance");
      expect(p.jobs.map((j) => j.id), files.join()).not.toContain("machine");
      expect(p.checks, files.join()).toBeLessThanOrEqual(6);
    }
  });

  test("a CI script or the acceptance harness's test takes none of the scripts' own macOS legs, but the core's (its scans walk scripts/); one unit's step file starts that unit", () => {
    expect(areasFor(["scripts/ci/weston.sh"]).scriptsmac).toBe(false);
    expect(areasFor(["scripts/acceptance/sealed-press.test.ts"]).scriptsmac).toBe(false);
    // the core's Linux shards walk scripts/ (its daemon-spawn pin reads every script); no macOS leg of the core does
    expect(planForFiles(["scripts/ci/weston.sh"]).macos).toBe(0);
    expect(planForFiles(["scripts/acceptance/sealed-press.test.ts"]).macos).toBe(0);
    const p = planForFiles(["scripts/acceptance/canvas-step.ts"]);
    expect(p.jobs.find((j) => j.id === "acceptance")!.checks).toBe(1);
    expect(p.macos).toBe(1);
    expect(p.units).toEqual(["canvas"]);
    // The Linux acceptance takes the same one unit.
    expect(p.jobs.find((j) => j.id === "acceptance-linux")!.checks).toBe(1);
  });

  test("the iPhone workflow's own edit takes the core's Linux shards (one of its tests reads every workflow's triggers) and no macOS leg", () => {
    const p = planForFiles([".github/workflows/ios.yml"]);
    expect(p.areas).toEqual(["corelinux", "scripts"]);
    expect(p.macos).toBe(0);
    expect(p.jobs.map((j) => j.id)).toContain("core-linux");
  });

  test("a Windows-only edit starts the Windows jobs and no macOS runner: the fence workflow and its scripts, not the machine, the sealed core or the macOS legs", () => {
    for (const f of [".github/workflows/windows-fence.yml", "scripts/ci/windows-fence/build-launcher.ps1"]) {
      const p = planForFiles([f]);
      expect(p.macos, f).toBe(0);
      expect(p.areas, f).toContain("windows");
      const ids = p.jobs.map((j) => j.id);
      expect(ids, f).toEqual(expect.arrayContaining(["windows-fence", "machine-windows"]));
      for (const id of ["machine", "sealed-core", "macos"]) expect(ids, f).not.toContain(id);
    }
  });

  test("a change to the Cowork launcher takes its Swift job and the patch queue's; nothing else does", () => {
    expect(ids(["apple/Cowork/WinterCoworkLauncher/Package.swift"])).toEqual(expect.arrayContaining(["swift-cowork-launcher", "libkrun-queue"]));
    expect(ids(["packages/core/src/daemon.ts"])).not.toContain("swift-cowork-launcher");
    expect(ids(["packages/core/src/daemon.ts"])).not.toContain("libkrun-queue");
    expect(ids(["packages/core/src/cowork/native/launcher.ts"])).toEqual(expect.arrayContaining(["swift-cowork-launcher", "libkrun-queue"]));
    // CI's own definition changes nearly everything, and neither Cowork's jobs nor the browser host's (parked: their own sources only).
    expect(ids([".github/workflows/ci.yml"])).toEqual(expect.arrayContaining(["acceptance"]));
    for (const id of ["swift-cowork-launcher", "libkrun-queue", "swift"]) expect(ids([".github/workflows/ci.yml"])).not.toContain(id);
  });

  test("an acceptance-only manual run starts the acceptance (both machines), the names check and the gates, and no suite", () => {
    const areas = Object.fromEntries(CI_AREA_NAMES.map((a) => [a, a === "acceptance"])) as ReturnType<typeof areasFor>;
    const p = planFor(areas, ON_GITHUB, "workflow_dispatch", "acceptance");
    expect(p.jobs.map((j) => j.id).sort()).toEqual(["acceptance", "acceptance-linux", "changes", "gate", "lane-gate", "names"]);
    const mac = planFor(areas, ON_GITHUB, "workflow_dispatch", "acceptance-linux");
    expect(mac.jobs.map((j) => j.id)).not.toContain("acceptance");
    expect(mac.jobs.map((j) => j.id)).toContain("acceptance-linux");
  });

  test("a pull request starts none of the lane's or the macOS jobs", () => {
    const p = planForFiles(["packages/core/src/daemon.ts"], "pull_request");
    expect(p.macos).toBe(0);
    expect(p.jobs.map((j) => j.id)).not.toContain("acceptance");
    expect(p.jobs.map((j) => j.id)).not.toContain("lane-gate");
  });
});
