// What both apps do about a GPU that keeps dying (a VM, Remote Desktop, a broken driver, a machine with no GPU at all).
//
// Chromium restarts its GPU process when it exits unexpectedly, and after a few exits in a row gives up with "GPU process
// isn't usable. Goodbye." and takes the whole app down. Nothing can be changed in a running app (`disableHardwareAcceleration`
// must run before `ready`), so the guard remembers: after GPU_CRASHES_TO_FLAG unexpected GPU exits in one run it writes a flag in the app's own
// user data, and the next start calls `app.disableHardwareAcceleration()` before `ready` (software drawing). The flag clears
// itself: after GPU_CLEAN_STARTS_TO_CLEAR starts with it set (the acceleration is tried again, and flags again at once if it
// still dies), and at once when the app's version changed (a fixed driver or a newer Chromium gets its acceleration back).
// Nothing is shown to the person; each decision is one plain log line.
//
// Pure: the file's text goes in and comes out (the apps do the reading and writing), so this runs under a test with no Electron.

import { closeSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GPU_FLAG_FILE = "gpu-guard.json";
/** Unexpected GPU exits in one run before the next start draws in software. */
export const GPU_CRASHES_TO_FLAG = 2;
/** Starts with the flag set before acceleration is tried again. */
export const GPU_CLEAN_STARTS_TO_CLEAR = 5;
/** The flag file is a few dozen bytes: text longer than this is no flag (and is removed), never parsed. */
export const GPU_FLAG_MAX_CHARS = 2048;

interface Flag { version: string; starts: number }

export interface StartDecision {
  /** Call `app.disableHardwareAcceleration()` before `ready`. */
  disable: boolean;
  /** The file's new text: undefined leaves it as it is, null removes it. */
  write: string | null | undefined;
  /** The one plain line to log, or undefined. */
  log: string | undefined;
}

function parse(raw: string | undefined): Flag | undefined {
  if (raw === undefined || raw.length > GPU_FLAG_MAX_CHARS) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null) return undefined;
    const { version, starts } = v as Record<string, unknown>;
    if (typeof version !== "string" || typeof starts !== "number" || !Number.isInteger(starts) || starts < 0) return undefined;
    return { version, starts };
  } catch {
    return undefined;
  }
}

/** What the start does, from the flag file's text (undefined: no file) and this app's version. An unreadable file is no flag. */
export function startDecision(raw: string | undefined, version: string): StartDecision {
  const flag = parse(raw);
  if (flag === undefined) return { disable: false, write: raw === undefined ? undefined : null, log: undefined };
  if (flag.version !== version) return { disable: false, write: null, log: `gpu: the app's version changed (${flag.version} to ${version}): hardware acceleration is tried again` };
  const starts = flag.starts + 1;
  if (starts > GPU_CLEAN_STARTS_TO_CLEAR) return { disable: false, write: null, log: `gpu: ${GPU_CLEAN_STARTS_TO_CLEAR} starts drew in software: hardware acceleration is tried again` };
  return { disable: true, write: JSON.stringify({ version, starts }), log: `gpu: the GPU process died repeatedly in an earlier run: drawing in software (start ${starts} of ${GPU_CLEAN_STARTS_TO_CLEAR})` };
}

/** The flag file's text for a run that has seen the GPU die. */
export function flagText(version: string): string {
  return JSON.stringify({ version, starts: 0 });
}

/** Electron's `child-process-gone` details, the part this reads. */
export interface GoneDetails { type: string; reason?: string; exitCode?: number }

/** Whether a gone child is a GPU process that did not exit on purpose. */
export function isGpuCrash(d: GoneDetails): boolean {
  return d.type === "GPU" && d.reason !== "clean-exit" && d.reason !== "killed";
}

/** Counts the unexpected GPU exits of one run; `note` says true on the one that makes the flag (once). */
export class GpuCrashCount {
  #n = 0;
  #flagged = false;
  note(d: GoneDetails): boolean {
    if (!isGpuCrash(d)) return false;
    this.#n++;
    if (this.#flagged || this.#n < GPU_CRASHES_TO_FLAG) return false;
    this.#flagged = true;
    return true;
  }
  get crashes(): number { return this.#n; }
}

/** The part of Electron's `app` the guard uses, and the file system it reads and writes the flag through (both are seams for a test). */
export interface GpuGuardApp {
  getPath(name: "userData"): string;
  getVersion(): string;
  disableHardwareAcceleration(): void;
  on(event: "child-process-gone", listener: (event: unknown, details: GoneDetails) => void): unknown;
}
export interface GpuGuardFiles {
  read(path: string): string | undefined;
  /** null removes the file. */
  write(path: string, text: string | null): void;
  join(dir: string, name: string): string;
}

/** Called once, before `ready`: reads the flag and turns acceleration off for this run when it says so, and watches this run's GPU exits. Never throws: a guard that
 *  can't read or write its file changes nothing. */
export function installGpuGuard(app: GpuGuardApp, files: GpuGuardFiles, log: (line: string) => void): GpuGuard {
  let own: () => void = () => {};
  try {
    const file = files.join(app.getPath("userData"), GPU_FLAG_FILE);
    const version = app.getVersion();
    const decision = startDecision(files.read(file), version);
    // What the start changes in the file (a start counted, the flag cleared) waits for `ownStart`: a second instance that is about to quit on the single-instance lock is not a start.
    own = () => {
      if (decision.write !== undefined) { try { files.write(file, decision.write); } catch { /* the flag stays as it was */ } }
      if (decision.log !== undefined) log(decision.log);
    };
    if (decision.disable) app.disableHardwareAcceleration();
    const count = new GpuCrashCount();
    app.on("child-process-gone", (_e, details) => {
      try {
        if (!count.note(details)) return;
        files.write(file, flagText(version));
        log(`gpu: the GPU process died ${count.crashes} times in this run: the next start draws in software`);
      } catch { /* nothing to do about it here */ }
    });
  } catch { /* an app that can't say where its data is runs as it always did */ }
  let done = false;
  return { ownStart: () => { if (done) return; done = true; try { own(); } catch { /* nothing to do about it here */ } } };
}

/** What the guard hands back: the app calls `ownStart` once it holds the single-instance lock (a start that is going on). */
export interface GpuGuard { ownStart(): void }

/** The real file system for the guard: a read takes at most GPU_FLAG_MAX_CHARS + 1 bytes (a larger file is returned too long to parse, never read whole). */
export const nodeGpuFiles: GpuGuardFiles = {
  read(path) {
    let fd: number;
    try { fd = openSync(path, "r"); } catch { return undefined; }
    try {
      const buf = Buffer.alloc(GPU_FLAG_MAX_CHARS + 1);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf8");
    } catch { return undefined; } finally { try { closeSync(fd); } catch { /* closed */ } }
  },
  write(path, text) { if (text === null) rmSync(path, { force: true }); else writeFileSync(path, text); },
  join,
};
