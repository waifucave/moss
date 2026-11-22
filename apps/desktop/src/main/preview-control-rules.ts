// The control door's pure rules (apps/desktop/src/main/preview-control.ts serves them; scripts/preview/control-lib.test.ts holds them to
// their cases). No electron here, so a test can import it. Preview build only: index.ts reaches preview-control.ts behind the compile-time mark.
import { timingSafeEqual } from "node:crypto";
import { lstatSync } from "node:fs";

/** A request line the door reads at most this long (a DevTools command is small; the results flow the other way). */
export const MAX_REQUEST_BYTES = 1024 * 1024;
/** The protocol's name, also what the release gate looks for. */
export const PREVIEW_CONTROL_NAME = "moss-preview-control";

/** Whether `a` equals `b` without a timing difference on where they differ. */
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Why the socket's folder may not hold the door: it must be a real folder (not a link), owned by this user, and closed to everyone else. */
export function folderProblem(path: string): string | undefined {
  let st;
  try { st = lstatSync(path); } catch { return `${path} does not exist`; }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${path} is not a plain folder`;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return `${path} is not owned by this user`;
  if ((st.mode & 0o077) !== 0) return `${path} is open to other users (mode ${(st.mode & 0o777).toString(8)})`;
  return undefined;
}

