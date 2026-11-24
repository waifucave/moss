// platform-ci.json's reasons point at jobs and steps ("runs in windows-fence.yml | <step name>", "the tree job"): each must exist in the workflows, so
// a reason can never again name a job or step that is not there (the acceptance-windows "chain step" once said a test ran that no workflow ran).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const lists = JSON.parse(readFileSync(join(root, "packages/core/test/platform-ci.json"), "utf8")) as Record<string, Record<string, string | { cause: string }>>;
const reasons: [string, string][] = [];
for (const k of ["linuxSkips", "darwinGateAllowed", "linuxKnownFailures"]) for (const [f, v] of Object.entries(lists[k] ?? {})) reasons.push([f, typeof v === "string" ? v : v.cause]);
const workflow = (file: string): string => readFileSync(join(root, ".github/workflows", file), "utf8");
const allWorkflows = ["ci.yml", "windows-fence.yml"].map(workflow).join("\n");

describe("platform-ci.json's reasons", () => {
  test("every `(runs in <workflow>.yml | <step name>)` names a workflow file with a step of that name", () => {
    for (const [file, why] of reasons) {
      for (const m of why.matchAll(/runs in (\S+\.yml) \| ([^;)]+)/g)) {
        const wf = m[1]!, step = m[2]!.trim();
        expect(existsSync(join(root, ".github/workflows", wf)), `${file}: ${wf} is not a workflow`).toBe(true);
        expect(workflow(wf).includes(`- name: ${step}`), `${file}: ${wf} has no step named "${step}"`).toBe(true);
      }
    }
  });
  test("a reason naming a job (\"the X job\") finds a job of that name in the workflows, and none names a step that does not exist", () => {
    for (const [file, why] of reasons) {
      expect(/acceptance-windows chain step/.test(why), `${file}: names the acceptance-windows chain step, which is no workflow's`).toBe(false);
      for (const m of why.matchAll(/\bthe ([A-Za-z][\w-]*) job\b/g)) {
        const name = m[1]!.toLowerCase();
        if (["link", "tree", "windows"].includes(name) || name === "machine") expect(new RegExp(`^  ${name}[\\w-]*:|name: [^\\n]*\\b${name}\\b`, "mi").test(allWorkflows), `${file}: no job "${name}" in the workflows`).toBe(true);
      }
    }
  });
});
