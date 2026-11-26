// The one spelling a DENY check compares (src/fence/spelling.ts). The first block runs everywhere with Windows given as an
// option and a fake long-name lookup; the second runs only on a Windows runner against real folders and the four deny sites.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldedSpelling, insideFolded } from "../../src/fence/spelling";
import { holdersWithin } from "../../src/registry/plugin-fence";
import { homeFenceTarget } from "../../src/runtime-sdk/control-plane";
import { storeWriteDenial } from "../../src/runtime-sdk/protected-paths";
import { PermissionRules, RuleAppendError } from "../../src/agent/permission-rules";

const win = { win32: true } as const;
// A lookup that knows one short name, the way the OS does for an existing folder.
const long = (p: string): string | null => {
  const m = /^(c:\\users\\)runner~1((?:\\.*)?)$/i.exec(p);
  return m ? `C:\\Users\\runneradmin${m[2]}` : /^c:\\users$/i.test(p) || /^c:\\$/i.test(p) ? p : null;
};

describe("foldedSpelling and insideFolded with Windows spellings", () => {
  const root = "C:\\Users\\runneradmin\\.moss";
  const inside = (p: string) => insideFolded(p, root, { ...win, long });
  test("mixed case and / against \\ are one place", () => {
    expect(inside("c:/USERS/RunnerAdmin/.MOSS/sdk/projects/x")).toBe(true);
    expect(inside("C:\\Users\\runneradmin\\.moss")).toBe(true);
  });
  test("an 8.3 short name is expanded, also below a folder that does not exist yet", () => {
    expect(inside("C:\\Users\\RUNNER~1\\.moss\\sdk\\new\\file.txt")).toBe(true);
  });
  test("a trailing dot or space on a name, and the extended prefix, are dropped", () => {
    expect(inside("C:\\Users\\runneradmin\\.moss.\\x")).toBe(true);
    expect(inside("C:\\Users\\runneradmin\\.moss \\x")).toBe(true);
    expect(inside("\\\\?\\C:\\Users\\runneradmin\\.moss\\x")).toBe(true);
    expect(inside("\\\\.\\c:\\users\\runneradmin\\.moss\\x")).toBe(true);
    expect(inside("\\??\\C:\\Users\\runneradmin\\.moss\\x")).toBe(true);
  });
  test("a sibling with the same prefix, another drive and a parent are outside", () => {
    expect(inside("C:\\Users\\runneradmin\\.moss-evil\\x")).toBe(false);
    expect(inside("D:\\Users\\runneradmin\\.moss\\x")).toBe(false);
    expect(inside("C:\\Users\\runneradmin")).toBe(false);
  });
  test("off Windows nothing but the lowercase the checks always used", () => {
    expect(foldedSpelling("/A/B\\C.", { win32: false })).toBe("/a/b\\c.");
  });
});

const onWindows = process.platform === "win32";
describe.skipIf(!onWindows)("the four deny sites on a Windows runner (real folders)", () => {
  let base = "";
  let home = "";
  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "inside-sweep-")));
    home = join(base, "moss-home");
    mkdirSync(join(home, "sdk", "projects", "k"), { recursive: true });
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  // The same place spelled the ways Windows takes it.
  const spellings = (p: string): string[] => [
    p.toUpperCase(),
    p.replace(/\\/g, "/"),
    `\\\\?\\${p}`,
    p.replace(/\\([^\\]+)$/, "\\$1."),
  ];

  test("1: a write under sdk/projects is refused in every spelling", () => {
    const target = join(home, "sdk", "projects", "k", "t.jsonl");
    for (const s of [target, ...spellings(target)]) {
      expect(storeWriteDenial("Write", { file_path: s }, { home })).toBeDefined();
    }
  });
  test("2: the home fence covers a dir's children in every spelling", () => {
    const dir = join(home, "cowork");
    mkdirSync(dir, { recursive: true });
    const fence = { dirs: [dir], files: [], segments: [] };
    const child = join(dir, "x", "y.txt");
    for (const s of [child, ...spellings(child)]) expect(homeFenceTarget(s, base, fence)).not.toBeNull();
    expect(homeFenceTarget(join(base, "cowork-other", "y.txt"), base, fence)).toBeNull();
  });
  test("3: a project rule for a folder inside MOSS home is refused in every spelling", () => {
    const rules = new PermissionRules({ globalAllow: () => undefined, mossHome: home });
    const inner = join(home, "plugins", "p");
    mkdirSync(inner, { recursive: true });
    for (const s of [inner, ...spellings(inner)]) expect(() => rules.append("Bash(ls)", "project", s)).toThrow(RuleAppendError);
  });
  test("4: the folders holding a denied path are found whatever the project's spelling", () => {
    const project = join(base, "proj");
    const denied = join(project, "a", "b", "secret.txt");
    mkdirSync(join(project, "a", "b"), { recursive: true });
    const plain = holdersWithin([denied], [project]).length;
    expect(plain).toBeGreaterThan(0);
    for (const s of spellings(project).slice(0, 2)) expect(holdersWithin([denied], [s]).length).toBe(plain);
  });
});
