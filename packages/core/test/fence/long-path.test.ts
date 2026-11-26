import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { longNameOf } from "../../src/approvals/bot-check";

// A file tool's path keeps its own spelling but for 8.3 names and case: no link is followed (a rule on a junction is matched on the junction's spelling).
describe("longNameOf", () => {
  const dir = "C:\\Users\\runneradmin\\Temp";
  const long = (p: string): string | null => (p.toLowerCase().replace("runner~1", "runneradmin") === dir.toLowerCase() ? dir : null);
  test("a short name is expanded through the nearest existing parent; the rest of a new file is as given", () => {
    expect(longNameOf("C:\\Users\\RUNNER~1\\Temp\\new\\a.txt", "C:\\", { long })).toBe("C:\\Users\\runneradmin\\Temp\\new\\a.txt");
  });
  test("a relative path is made absolute against the cwd, and `..` is resolved lexically, not through a link", () => {
    expect(longNameOf("sub\\..\\a.txt", dir, { long })).toBe("C:\\Users\\runneradmin\\Temp\\a.txt");
  });
  test("a path nothing of which exists comes back absolute as given", () => {
    expect(longNameOf("Z:\\none\\a.txt", "C:\\", { long: () => null })).toBe("Z:\\none\\a.txt");
  });
  test.skipIf(process.platform !== "win32")("a real junction in the path stays a junction, and a short temp name is expanded", () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "moss-junction-")));
    try {
      mkdirSync(join(base, "root"));
      mkdirSync(join(base, "elsewhere"));
      writeFileSync(join(base, "elsewhere", "s.json"), "{}");
      expect(spawnSync("cmd.exe", ["/c", "mklink", "/J", join(base, "root", ".claude"), join(base, "elsewhere")]).status).toBe(0);
      const viaLink = join(base, "root", ".claude", "s.json");
      expect(longNameOf(viaLink, base)).toBe(viaLink);
      const shortTmp = join(tmpdir(), base.slice(base.lastIndexOf("moss-junction-")), "root", ".claude", "s.json");
      expect(longNameOf(shortTmp, base).includes("~")).toBe(false);
      expect(longNameOf(shortTmp, base).toLowerCase()).toBe(viaLink.toLowerCase());
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
