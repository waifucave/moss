import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingFolderNote } from "../../src/fence/win-fenced";
import { explainLauncherCwd } from "../../src/fence/win-launch-errors";

const line = (o: Record<string, unknown>) => `srt-win: launching runner as 'moss-sb-1' (overlay=16 var(s))\n${JSON.stringify(o)}\n`;

describe("the launcher's working-folder refusals, in words", () => {
  test("a remote drive (exit 16) says network or mapped drive", () => {
    const said = explainLauncherCwd(16, line({ code: "mapped_drive_cwd", drive: "Z:\\", message: "x" }));
    expect(said).toContain("network or mapped drive");
    expect(said).toContain("Z:\\");
    expect(said).not.toContain("{");
  });
  test("a folder the account can't use (exit 27) names the folder, says what to try, and never calls it a mapped drive", () => {
    const gone = explainLauncherCwd(27, line({ code: "cwd_unusable", cwd: "C:\\work\\gone", hresult: "0x8007010B", exists: false, driveType: 3, message: "x" }))!;
    expect(gone).toContain("can't enter C:\\work\\gone");
    expect(gone).toContain("isn't there");
    expect(gone).not.toMatch(/mapped|network|DRIVE_REMOTE/i);
    const shut = explainLauncherCwd(27, line({ code: "cwd_unusable", cwd: "C:\\work\\shut", hresult: "0x8007010B", exists: true, driveType: 3, message: "x" }))!;
    expect(shut).toContain("permissions keep the sandbox account out");
    expect(shut).toContain("drive type 3");
    const unknown = explainLauncherCwd(27, line({ code: "cwd_unusable", cwd: "C:\\x", hresult: "0x8007010B", exists: null, driveType: null, message: "x" }))!;
    expect(unknown).toContain("may have been removed");
  });
  test("any other exit, a line for the other code, or no line at all is left alone; output a command printed can't pose as one", () => {
    expect(explainLauncherCwd(0, line({ code: "cwd_unusable", cwd: "C:\\x" }))).toBeNull();
    expect(explainLauncherCwd(1, "")).toBeNull();
    expect(explainLauncherCwd(16, line({ code: "cwd_unusable", cwd: "C:\\x" }))).toBeNull();
    expect(explainLauncherCwd(27, "no json here\n")).toBeNull();
    expect(explainLauncherCwd(27, "{not json}\n")).toBeNull();
    const long = explainLauncherCwd(27, line({ code: "cwd_unusable", cwd: `C:\\${"a".repeat(5000)}`, exists: false }))!;
    expect(long.length).toBeLessThan(900);
  });
  test("a working folder the daemon sees is missing, or a file, is said plainly before any spawn; one that exists is left to the launcher", () => {
    const d = mkdtempSync(join(tmpdir(), "moss-cwd-"));
    try {
      writeFileSync(join(d, "f.txt"), "x");
      expect(missingFolderNote(d)).toBeNull();
      expect(missingFolderNote(join(d, "gone"))).toContain("isn't there");
      expect(missingFolderNote(join(d, "f.txt"))).toContain("isn't a folder");
      expect(missingFolderNote(join(d, "f.txt", "below"))).toContain("isn't there");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
