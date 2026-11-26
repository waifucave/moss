// Which shell a terminal opens on Windows: PowerShell 7, else Windows PowerShell, cmd.exe only when neither is there.
import { describe, expect, test } from "bun:test";
import { windowsShell } from "../../src/tree/terminals";

const env = { SystemRoot: "D:\\Win", ComSpec: "D:\\Win\\System32\\cmd.exe" };
const SYSTEM_PS = "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

describe("windowsShell", () => {
  test("PowerShell 7 on the PATH is used, without its banner", () => {
    expect(windowsShell(env, { which: (n) => (n === "pwsh.exe" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : null), exists: () => true })).toEqual(["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoLogo"]);
  });
  test("without it, the Windows PowerShell of the system", () => {
    expect(windowsShell(env, { which: () => null, exists: (p) => p === SYSTEM_PS })).toEqual([SYSTEM_PS, "-NoLogo"]);
  });
  test("with neither, cmd.exe (the ComSpec, else cmd.exe)", () => {
    expect(windowsShell(env, { which: () => null, exists: () => false })).toEqual(["D:\\Win\\System32\\cmd.exe"]);
    expect(windowsShell({}, { which: () => null, exists: () => false })).toEqual(["cmd.exe"]);
  });
});
