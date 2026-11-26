// Which shell a terminal opens on Windows: PowerShell 7, else Windows PowerShell, cmd.exe only when neither is there.
import { describe, expect, test } from "bun:test";
import { LocalTerminals, pipeEnter, windowsShell } from "../../src/tree/terminals";

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

describe("pipeEnter (a shell on pipes reads Enter as a line end)", () => {
  test("a lone \\r becomes \\n, \\r\\n stays one line end, text and other control keys are untouched", () => {
    expect(pipeEnter("echo ok\r")).toBe("echo ok\n");
    expect(pipeEnter("a\r\nb\r\n")).toBe("a\nb\n");
    expect(pipeEnter("a\rb\r")).toBe("a\nb\n");
    expect(pipeEnter("\u0003\u001b[A")).toBe("\u0003\u001b[A");
  });
});

// The real thing, on a Windows runner only: type `echo ok` into the shell a terminal opens and read `ok` back on a line of its own.
describe.skipIf(process.platform !== "win32")("a real Windows shell runs the typed line", () => {
  test("echo ok comes back as ok", async () => {
    const heard: string[] = [];
    const terminals = new LocalTerminals();
    const id = terminals.open(process.cwd(), { cols: 100, rows: 30 }, { device: null }, (o) => { heard.push(o.data); });
    try {
      await terminals.write(id, "echo ok\r");
      const until = Date.now() + 60_000;
      while (!/(^|\n)ok\r?\n/.test(heard.join("")) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      expect(heard.join("")).toMatch(/(^|\n)ok\r?\n/);
    } finally { terminals.close(id); }
  }, 90_000);
});
