// The read-back of a Windows access list (platform/win-acl.ts): the parse on any OS, the real thing on Windows.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentUserSid } from "../../src/platform/win-pipe";
import { ownerOnlyProblem, ownerOnlyProblemOfSddl } from "../../src/platform/win-acl";
import { systemDirectory } from "../../src/secrets/private-file";

const ME = "S-1-5-21-1-2-3-1001";
describe("an access list read back as SDDL", () => {
  test("the user, SYSTEM and Administrators alone: fine, whoever of them owns it", () => {
    expect(ownerOnlyProblemOfSddl(`O:${ME}G:DUD:PAI(A;OICI;FA;;;${ME})(A;OICI;FA;;;SY)`, ME)).toBeNull();
    expect(ownerOnlyProblemOfSddl(`O:BAG:DUD:PAI(A;OICI;FA;;;${ME})`, ME)).toBeNull();
    expect(ownerOnlyProblemOfSddl(`O:SYD:P(A;;GA;;;${ME})(A;;GA;;;BA)(D;;FA;;;WD)`, ME)).toBeNull();
  });
  test("another account's allow entry, Everyone, Users or Authenticated Users is refused", () => {
    expect(ownerOnlyProblemOfSddl(`O:${ME}D:PAI(A;OICI;FA;;;${ME})(A;OICI;0x1200a9;;;AU)`, ME)).toMatch(/grants access to AU/);
    expect(ownerOnlyProblemOfSddl(`O:${ME}D:P(A;;FA;;;WD)`, ME)).toMatch(/WD/);
    expect(ownerOnlyProblemOfSddl(`O:${ME}D:P(A;;FA;;;S-1-5-32-545)`, ME)).toMatch(/S-1-5-32-545/);
  });
  test("a folder owned by someone else is refused, however clean its list", () => {
    expect(ownerOnlyProblemOfSddl(`O:S-1-5-21-9-9-9-500D:P(A;;FA;;;${ME})`, ME)).toMatch(/owned by S-1-5-21-9-9-9-500/);
    expect(ownerOnlyProblemOfSddl(`D:P(A;;FA;;;${ME})`, ME)).toMatch(/owned by no one/);
  });
});

describe.skipIf(process.platform !== "win32")("the real access list of a folder on Windows", () => {
  const icacls = (...a: string[]) => Bun.spawnSync([`${systemDirectory()}\\icacls.exe`, ...a], { stdout: "ignore", stderr: "ignore" }).exitCode;
  test("locked to the user it is read back as owner-only; with another account allowed it is refused", () => {
    const me = currentUserSid()!;
    const dir = join(mkdtempSync(join(tmpdir(), "moss-acl-")), "locked");
    mkdirSync(dir);
    expect(icacls(dir, "/inheritance:r", "/grant:r", `*${me}:(OI)(CI)F`)).toBe(0);
    expect(ownerOnlyProblem(dir, me)).toBeNull();
    expect(icacls(dir, "/grant", "*S-1-5-32-545:(OI)(CI)R")).toBe(0); // BUILTIN\Users
    expect(ownerOnlyProblem(dir, me)).toMatch(/S-1-5-32-545/);
  });
});
