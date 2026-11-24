// What a Windows file or folder's access list really says, read back from the OS after `icacls` has been asked to lock it. `icacls
// /inheritance:r /grant:r *SID` removes the inherited entries and replaces only that SID's own grant: an explicit allow entry for another
// account stays, and a folder made by someone else keeps that account as its OWNER (who can rewrite the list later). So the lock is never
// taken for done: the owner and the allow entries are read (`GetNamedSecurityInfoW`, as SDDL) and anything but the user, SYSTEM and
// Administrators is a refusal. One helper for the run folder, the plugin run folder and the secrets files.
import { ffiLib, ffiPtr, ffiWide } from "./ffi";

const SYSTEM_SID = "S-1-5-18", ADMINISTRATORS_SID = "S-1-5-32-544";
/** SDDL's short names for the trustees that can appear on a locked file; any other is read as its own text and, not being the user's SID, refused. */
const SHORT: Record<string, string> = { SY: SYSTEM_SID, BA: ADMINISTRATORS_SID, CO: "S-1-3-0" };

/** The problem with an access list given as SDDL (owner and DACL), or null when only the user, SYSTEM and Administrators own it or may be
 *  allowed in it. Deny entries are harmless. Pure. */
export function ownerOnlyProblemOfSddl(sddl: string, userSid: string): string | null {
  const trusted = new Set([userSid.toUpperCase(), SYSTEM_SID, ADMINISTRATORS_SID]);
  const sid = (t: string): string => (SHORT[t.toUpperCase()] ?? t).toUpperCase();
  const owner = /(?:^|[^A-Z])O:(.+?)(?=G:|D:|S:|$)/.exec(sddl)?.[1] ?? "";
  if (owner === "" || !trusted.has(sid(owner))) return `it is owned by ${owner === "" ? "no one it could read" : sid(owner)}, not the user, Administrators or SYSTEM`;
  const dacl = sddl.slice(sddl.indexOf("D:") + 2);
  if (!sddl.includes("D:")) return "it has no access list";
  const foreign: string[] = [];
  for (const m of dacl.matchAll(/\(([^)]*)\)/g)) {
    const f = m[1]!.split(";");
    const type = f[0] ?? "";
    // Allow entries (A, OA and the callback forms): the trustee is the sixth field, as `type;flags;rights;object;inherit;trustee`.
    if (!/^(A|OA|XA|ZA)$/.test(type)) continue;
    const trustee = sid(f[5] ?? "");
    if (!trusted.has(trustee)) foreign.push(trustee);
  }
  return foreign.length > 0 ? `it grants access to ${[...new Set(foreign)].join(", ")}` : null;
}

/** `path`'s owner and DACL as SDDL, from the OS; null when they can't be read. */
export function sddlOf(path: string): string | null {
  if (process.platform !== "win32") return null;
  const a = ffiLib("win-acl-adv", "advapi32.dll", {
    GetNamedSecurityInfoW: { args: ["ptr", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: { args: ["u64", "u32", "u32", "ptr", "ptr"], returns: "i32" },
  });
  const k = ffiLib("win-acl-k32", "kernel32.dll", { LocalFree: { args: ["u64"], returns: "u64" }, lstrlenW: { args: ["u64"], returns: "i32" } });
  if (a === null || k === null) return null;
  const name = Buffer.from(`${path}\0`, "utf16le");
  const sd = new BigUint64Array(1);
  const OWNER_AND_DACL = 0x1 | 0x4; // OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION
  if ((a.GetNamedSecurityInfoW!(ffiPtr(name), 1 /* SE_FILE_OBJECT */, OWNER_AND_DACL, null, null, null, null, ffiPtr(sd)) as number) !== 0) return null;
  try {
    const str = new BigUint64Array(1), len = new Uint32Array(1);
    if ((a.ConvertSecurityDescriptorToStringSecurityDescriptorW!(sd[0]!, 1, OWNER_AND_DACL, ffiPtr(str), ffiPtr(len)) as number) === 0) return null;
    try { return ffiWide(str[0]!, k.lstrlenW!(str[0]!) as number); } finally { k.LocalFree!(str[0]!); }
  } finally { k.LocalFree!(sd[0]!); }
}

/** Why `path` is not the user's alone on Windows, or null when it is. Fails closed: an access list that can't be read is a problem. */
export function ownerOnlyProblem(path: string, userSid: string): string | null {
  // Off Windows there is no such list to read: a caller with `os: "win32"` there is a test with an injected runner.
  if (process.platform !== "win32") return null;
  const sddl = sddlOf(path);
  return sddl === null ? "its access list could not be read" : ownerOnlyProblemOfSddl(sddl, userSid);
}
