// Winter Phase 9c (P9c-5): the tap publisher. Never invokes a real `gh` — every `--publish`-path
// test uses a FAKE GhRunner, per the lane's hard constraint (this repo's own release/publish
// scripts are controller-only; `--dry-run` reads local files only and is exercised for real in
// scripts/release-lib.test.ts-style pure-function tests here instead of via the CLI).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caskProblems,
  commitMessageFor,
  currentSha,
  findUnfilledTemplateSlot,
  publishFile,
  putArgsFor,
  renderDryRunEntry,
  tapRun,
  TAP_REPO,
  tapPlan,
  type GhRunner,
} from "./publish-tap";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "moss-publish-tap-test-"));
  temps.push(dir);
  const path = join(dir, "cask.rb");
  writeFileSync(path, content);
  return path;
}

describe("tapPlan", () => {
  test("names both apps' casks, read from the --render-to folder's casks/", () => {
    const plan = tapPlan("/out");
    expect(plan.map((f) => f.repoPath)).toEqual(["Casks/moss-code.rb", "Casks/moss.rb"]);
    expect(plan.map((f) => f.localPath)).toEqual([join("/out", "casks", "moss-code.rb"), join("/out", "casks", "moss.rb")]);
  });
});

describe("caskProblems", () => {
  test("a cask of the version with no slot has none; another version or a slot is named", () => {
    expect(caskProblems("Casks/moss.rb", 'cask "moss" do\n  version "1.111.1"\nend\n', "1.111.1")).toEqual([]);
    expect(caskProblems("Casks/moss.rb", 'cask "moss" do\n  version "1.111.0"\nend\n', "1.111.1")[0]).toContain('does not say version "1.111.1"');
    expect(caskProblems("Casks/moss.rb", 'version "1.111.1"\nsha256 "{{sha256}}"\n', "1.111.1")[0]).toContain("{{sha256}}");
  });
});

describe("commitMessageFor", () => {
  test("names the exact file being published, and carries no session trailer", () => {
    expect(commitMessageFor("Casks/moss.rb")).toBe("chore(tap): publish Casks/moss.rb");
  });
});

describe("putArgsFor", () => {
  test("base64-encodes the content and targets the right repo/path", () => {
    const args = putArgsFor("Casks/moss-code.rb", "cask \"moss-code\" do\nend\n", undefined);
    expect(args).toEqual([
      "api",
      "-X",
      "PUT",
      `repos/${TAP_REPO}/contents/Casks/moss-code.rb`,
      "-f",
      `message=${commitMessageFor("Casks/moss-code.rb")}`,
      "-f",
      `content=${Buffer.from("cask \"moss-code\" do\nend\n", "utf8").toString("base64")}`,
    ]);
  });

  test("omits sha entirely when creating a new file", () => {
    const args = putArgsFor("Casks/moss.rb", "content", undefined);
    expect(args.join(" ")).not.toContain("sha=");
  });

  test("includes sha when updating an existing file", () => {
    const args = putArgsFor("Casks/moss.rb", "content", "abc123def");
    expect(args).toContain("-f");
    expect(args).toContain("sha=abc123def");
  });
});

describe("currentSha", () => {
  test("returns the sha when gh succeeds with a nonempty value", () => {
    const runner: GhRunner = () => "deadbeef\n";
    expect(currentSha(runner, "Casks/moss-code.rb")).toBe("deadbeef");
  });

  test("returns undefined when gh throws (404 — the cask does not exist yet)", () => {
    const runner: GhRunner = () => {
      throw new Error("gh: 404 Not Found");
    };
    expect(currentSha(runner, "Casks/moss.rb")).toBeUndefined();
  });

  test("treats an empty jq result the same as absent, rather than an empty-string sha", () => {
    const runner: GhRunner = () => "";
    expect(currentSha(runner, "Casks/moss-code.rb")).toBeUndefined();
  });

  test("queries the exact repo/path this release publishes to", () => {
    const calls: string[][] = [];
    const runner: GhRunner = (args) => {
      calls.push(args);
      return "sha1\n";
    };
    currentSha(runner, "Casks/moss-code.rb");
    expect(calls).toEqual([["api", `repos/${TAP_REPO}/contents/Casks/moss-code.rb`, "--jq", ".sha"]]);
  });
});

describe("publishFile", () => {
  test("fetches the current sha, then PUTs with it included (updating an existing cask)", () => {
    const localPath = tempFile("cask \"moss-code\" do\nend\n");
    const calls: string[][] = [];
    const runner: GhRunner = (args) => {
      calls.push(args);
      if (args[0] === "api" && args.length === 4) return "existing-sha\n"; // the sha lookup
      return ""; // the PUT itself
    };
    publishFile(runner, { repoPath: "Casks/moss-code.rb", localPath });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["api", `repos/${TAP_REPO}/contents/Casks/moss-code.rb`, "--jq", ".sha"]);
    expect(calls[1]).toEqual(putArgsFor("Casks/moss-code.rb", "cask \"moss-code\" do\nend\n", "existing-sha"));
  });

  test("omits sha on a brand-new cask (the sha lookup 404s)", () => {
    const localPath = tempFile("cask \"moss\" do\nend\n");
    const calls: string[][] = [];
    const runner: GhRunner = (args) => {
      calls.push(args);
      if (args[0] === "api" && args.length === 4) throw new Error("404");
      return "";
    };
    publishFile(runner, { repoPath: "Casks/moss.rb", localPath });

    expect(calls[1]).toEqual(putArgsFor("Casks/moss.rb", "cask \"moss\" do\nend\n", undefined));
  });

  // Fix wave M3 (whole-branch review, Major): a file that still carries an unfilled `{{slot}}`
  // (a template copied by hand, before it is rendered)
  // must never publish literally — no network call at all, not even the sha lookup.
  test("refuses (before any network call) when the file still contains an unfilled {{slot}}", () => {
    const localPath = tempFile('cask "moss" do\n  version "{{version}}"\n  sha256 "{{sha256}}"\nend\n');
    const calls: string[][] = [];
    const runner: GhRunner = (args) => {
      calls.push(args);
      return "";
    };
    expect(() => publishFile(runner, { repoPath: "Casks/moss.rb", localPath })).toThrow(/Casks\/moss\.rb/);
    expect(() => publishFile(runner, { repoPath: "Casks/moss.rb", localPath })).toThrow(/\{\{version\}\}/);
    expect(calls).toHaveLength(0); // never even reached the sha lookup
  });
});

describe("findUnfilledTemplateSlot", () => {
  test("finds the first {{slot}} placeholder", () => {
    expect(findUnfilledTemplateSlot('version "{{version}}"\nsha256 "{{sha256}}"')).toBe("{{version}}");
  });
  test("undefined once every slot has been filled in", () => {
    expect(findUnfilledTemplateSlot('version "0.2.015"\nsha256 "deadbeef"')).toBeUndefined();
  });
  test("a Ruby string-interpolation `#{...}` is not a template slot (different delimiter)", () => {
    expect(findUnfilledTemplateSlot('url "https://example.com/#{version}/x.dmg"')).toBeUndefined();
  });
  test("a slot name spelled inside a Ruby comment line is not an unfilled slot", () => {
    expect(
      findUnfilledTemplateSlot('# CONTROLLER: replace {{version}} and {{sha256}} by hand\n  version "0.2.015"\n'),
    ).toBeUndefined();
  });
  test("a live-stanza slot is still found when comments also spell it", () => {
    expect(findUnfilledTemplateSlot('#   {{version}} -> "0.2.015"\n  version "{{version}}"\n')).toBe("{{version}}");
  });
});

describe("renderDryRunEntry — fix wave M3 (whole-branch review, Major)", () => {
  test("prints the full content when there is no unfilled slot", () => {
    const localPath = tempFile('cask "moss-code" do\nend\n');
    const entry = renderDryRunEntry({ repoPath: "Casks/moss-code.rb", localPath });
    expect(entry).toContain("Casks/moss-code.rb");
    expect(entry).toContain('cask "moss-code" do');
    expect(entry).not.toContain("REFUSED");
  });

  test("prints a REFUSED line naming the file and the slot — never the literal template content — when a slot is unfilled", () => {
    const localPath = tempFile('cask "moss" do\n  version "{{version}}"\nend\n');
    const entry = renderDryRunEntry({ repoPath: "Casks/moss.rb", localPath });
    expect(entry).toContain("Casks/moss.rb");
    expect(entry).toContain("REFUSED");
    expect(entry).toContain("{{version}}");
    expect(entry).not.toContain('cask "moss" do'); // the raw unfilled content is never printed
  });

  test("prints the 'missing on disk' note when the file does not exist yet — never a false refusal", () => {
    const entry = renderDryRunEntry({ repoPath: "Casks/moss-code.rb", localPath: join(tmpdir(), "moss-publish-tap-test-does-not-exist", "moss-code.rb") });
    expect(entry).toContain("missing on disk");
    expect(entry).not.toContain("REFUSED");
  });
});

describe("tapRun: the whole script with a fake gh", () => {
  const V = "1.111.1";
  function folder(moss = `version "${V}"`, code = `version "${V}"`): string {
    const dir = mkdtempSync(join(tmpdir(), "moss-tap-from-"));
    temps.push(dir);
    mkdirSync(join(dir, "casks"));
    writeFileSync(join(dir, "casks", "moss.rb"), `cask "moss" do\n  ${moss}\nend\n`);
    writeFileSync(join(dir, "casks", "moss-code.rb"), `cask "moss-code" do\n  ${code}\nend\n`);
    return dir;
  }
  function drive(argv: string[]) {
    const calls: string[][] = [], out: string[] = [], err: string[] = [];
    const code = tapRun(argv, V, (a) => { calls.push(a); return a.includes("--jq") ? "oldsha\n" : ""; }, (l) => out.push(l), (l) => err.push(l));
    return { code, calls, out: out.join("\n"), err: err.join("\n") };
  }

  test("no --publish is a dry run: prints both casks and their tap paths, and calls gh not once", () => {
    const r = drive(["--from", folder()]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("Casks/moss-code.rb");
    expect(r.out).toContain("Casks/moss.rb");
    expect(r.out).toContain("No network calls made");
    expect(drive(["--dry-run", "--from", folder()]).calls).toEqual([]);
  });

  test("--publish updates both casks (sha lookup then PUT each); a cask of another version or a missing one stops it before any call", () => {
    const dir = folder();
    const r = drive(["--from", dir, "--publish"]);
    expect(r.code).toBe(0);
    expect(r.calls.filter((c) => c.includes("PUT")).map((c) => c[3])).toEqual([`repos/${TAP_REPO}/contents/Casks/moss-code.rb`, `repos/${TAP_REPO}/contents/Casks/moss.rb`]);
    const stale = drive(["--from", folder(`version "1.111.0"`), "--publish"]);
    expect(stale.code).toBe(1);
    expect(stale.calls).toEqual([]);
    const empty = mkdtempSync(join(tmpdir(), "moss-tap-empty-"));
    temps.push(empty);
    const missing = drive(["--from", empty, "--publish"]);
    expect(missing.code).toBe(1);
    expect(missing.calls).toEqual([]);
    expect(drive(["--from", empty]).code).toBe(1); // the dry run refuses too
  });

  test("usage errors: no --from, a stray argument, --publish with --dry-run", () => {
    expect(drive([]).code).toBe(1);
    expect(drive(["--from", folder(), "--force"]).code).toBe(1);
    expect(drive(["--from", folder(), "--publish", "--dry-run"]).code).toBe(1);
  });
});
