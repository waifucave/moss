// A path's long names on Windows without following any link: `GetLongPathNameW` expands an 8.3 short name (`RUNNER~1`) and fixes the case of each part
// that exists, and leaves a junction or a symlink as the path spelled it. (`realpath` follows links, which loses the spelling a rule on the link needs.)
import { ffiLib, ffiPtr } from "./ffi";

function lib() {
  return ffiLib("long-name", "kernel32.dll", { GetLongPathNameW: { args: ["ptr", "ptr", "u32"], returns: "u32" } });
}

/** The long form of an existing path, or null when it doesn't exist, is too long for the buffer, or the call is not available (not Windows). */
export function getLongPathName(path: string): string | null {
  const k = process.platform === "win32" ? lib() : null;
  if (!k) return null;
  const input = Buffer.from(`${path}\0`, "utf16le");
  const out = Buffer.alloc(2 * 32768);
  const n = k.GetLongPathNameW!(ffiPtr(input), ffiPtr(out), 32768) as number;
  if (n === 0 || n >= 32768) return null;
  return out.subarray(0, n * 2).toString("utf16le");
}
