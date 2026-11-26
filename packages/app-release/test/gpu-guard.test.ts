// The GPU guard's flag logic: pure, no Electron, no window.
import { describe, expect, test } from "bun:test";
import { GPU_CLEAN_STARTS_TO_CLEAR, GPU_CRASHES_TO_FLAG, GpuCrashCount, flagText, installGpuGuard, isGpuCrash, startDecision } from "../src/gpu-guard";

describe("startDecision", () => {
  test("no file: acceleration stays on and nothing is written", () => {
    expect(startDecision(undefined, "1.0.0")).toEqual({ disable: false, write: undefined, log: undefined });
  });
  test("a flag of this version: software, the start counted, one line", () => {
    const d = startDecision(flagText("1.0.0"), "1.0.0");
    expect(d.disable).toBe(true);
    expect(JSON.parse(d.write as string)).toEqual({ version: "1.0.0", starts: 1 });
    expect(d.log).toContain("drawing in software");
  });
  test("it clears itself after the clean starts: the next one tries acceleration and removes the file", () => {
    let text: string | undefined = flagText("1.0.0");
    let softwareStarts = 0;
    for (let i = 0; i < 20; i++) {
      const d = startDecision(text, "1.0.0");
      if (!d.disable) { expect(d.write).toBeNull(); break; }
      softwareStarts++;
      text = d.write as string;
    }
    expect(softwareStarts).toBe(GPU_CLEAN_STARTS_TO_CLEAR);
  });
  test("a changed version clears it at once (a fixed driver or a newer Chromium gets its acceleration back)", () => {
    const d = startDecision(flagText("1.0.0"), "1.1.0");
    expect(d.disable).toBe(false);
    expect(d.write).toBeNull();
    expect(d.log).toContain("version changed");
  });
  test("an unreadable or malformed file is no flag and is removed", () => {
    for (const bad of ["", "not json", "null", "[]", '{"version":1,"starts":0}', '{"version":"1","starts":-1}', '{"version":"1","starts":1.5}']) {
      expect(startDecision(bad, "1")).toEqual({ disable: false, write: null, log: undefined });
    }
  });
});

describe("GpuCrashCount", () => {
  test("it flags on the second unexpected GPU exit of a run, once", () => {
    const c = new GpuCrashCount();
    expect(c.note({ type: "GPU", reason: "crashed", exitCode: -2147483645 })).toBe(false);
    expect(c.note({ type: "GPU", reason: "abnormal-exit", exitCode: 1 })).toBe(GPU_CRASHES_TO_FLAG === 2);
    expect(c.note({ type: "GPU", reason: "crashed" })).toBe(false);
    expect(c.crashes).toBe(3);
  });
  test("a clean exit, a kill and another kind of child are not GPU crashes", () => {
    const c = new GpuCrashCount();
    for (const d of [{ type: "GPU", reason: "clean-exit" }, { type: "GPU", reason: "killed" }, { type: "Utility", reason: "crashed" }, { type: "Tab", reason: "crashed" }]) {
      expect(isGpuCrash(d)).toBe(false);
      expect(c.note(d)).toBe(false);
    }
    expect(c.crashes).toBe(0);
  });
});

describe("installGpuGuard", () => {
  const make = (initial?: string, version = "1.0.0") => {
    const files = new Map<string, string>(initial === undefined ? [] : [["/data/gpu-guard.json", initial]]);
    const lines: string[] = [];
    let disabled = 0;
    let listener: ((e: unknown, d: { type: string; reason?: string }) => void) | undefined;
    const app = { getPath: () => "/data", getVersion: () => version, disableHardwareAcceleration: () => { disabled++; }, on: (_ev: "child-process-gone", l: typeof listener) => { listener = l; } };
    const io = { read: (p: string) => files.get(p), write: (p: string, t: string | null) => { if (t === null) files.delete(p); else files.set(p, t); }, join: (d: string, n: string) => `${d}/${n}` };
    return { app: app as never, io, files, lines, disabled: () => disabled, crash: (d: { type: string; reason?: string }) => listener?.({}, d), log: (l: string) => lines.push(l) };
  };
  test("two GPU crashes in a run write the flag; the next start disables acceleration before ready", () => {
    const a = make();
    installGpuGuard(a.app, a.io, a.log);
    expect(a.disabled()).toBe(0);
    a.crash({ type: "GPU", reason: "crashed" });
    expect(a.files.size).toBe(0);
    a.crash({ type: "GPU", reason: "crashed" });
    expect(a.files.get("/data/gpu-guard.json")).toBe(flagText("1.0.0"));
    const b = make(a.files.get("/data/gpu-guard.json"));
    installGpuGuard(b.app, b.io, b.log);
    expect(b.disabled()).toBe(1);
    expect(b.lines.length).toBe(1);
  });
  test("an app whose data folder can't be read runs as before", () => {
    const a = make();
    (a.app as { getPath: () => string }).getPath = () => { throw new Error("no path"); };
    installGpuGuard(a.app, a.io, a.log);
    expect(a.disabled()).toBe(0);
  });
});
