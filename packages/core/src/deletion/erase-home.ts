// Erase everything MOSS keeps on this computer (the deletion lane, item 5): the MOSS home's data and MOSS's own secrets
// (on macOS the Keychain items of MOSS's own service, reached through the secret store, which only the engine's binary
// can; on Windows and Linux the secrets file, which is in the home, and its key in the OS store). Only the person: the
// person's own terminal with the engine stopped (`moss-core erase`, which asks them to type it), or their yes on the
// engine's card from an app (`home.erase`), after which the engine stops first and erases last.
//
// The path is checked before anything goes:
// * the home is resolved (a home given as a link is followed once, to the folder it names) and must be a folder MOSS
//   made: its `run` and `logs` folders and one more of what a MOSS home holds;
// * never `/`, the user's home or any folder above it, another install's home (the previous app's or the older one's, `otherInstallHome`), or a
//   folder that holds a `.git` (a project, not a home);
// * inside it, every entry is removed as itself: a link is unlinked, never followed out of the home, and a hard link
//   only loses this name;
// * beside it, the folder of files paired phones sent to coding sessions (`<home>-received`) goes too, as itself.
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import type { SecretMeta, SecretRef } from "../contracts/secret-store";
import { ContractError } from "../contracts/common";
import { TOKEN_NAMES } from "../auth/tokens";
import { osStoreItemNames } from "../secrets/file-backend";
import { bunVault, type Vault } from "../secrets/moss-secret-store";
import { OLD_INSTALL_HOME_DIR, otherInstallHome } from "../other-installs";
import { receivedRootOf } from "../bots/staged-files";

/** What erase leaves, said to the person every time. */
/** The signal that an erase ran, beside the home (the home itself is gone): `<home>-erased`, an empty file. It carries
 *  nothing that is shown: the engine's next start is its only reader (`takeEraseSignalAtStart`), and decides from the
 *  home's marker and what is left. The folder above the home is any runner's to write, so the file is made under
 *  a fresh name (`O_EXCL`, never through a link) and renamed into place, which replaces whatever a runner left at that
 *  name (a link included) instead of following it. */
export const ERASE_SIGNAL_SUFFIX = "-erased";

export function eraseSignalPath(home: string): string {
  const h = resolve(home);
  return join(dirname(h), `${basename(h)}${ERASE_SIGNAL_SUFFIX}`);
}

/** A file the engine keeps in every home it runs (made at each start, `ensureHomeMarker`), inside `run/`: the MOSS home
 *  is write-denied to every runner on every system (fence.ts `policy()`), so only the engine makes or removes it. The
 *  start's reading of an erase rests on `run/erase.started` (the erase's own proof), not on this: a home an older build
 *  ran has no marker yet. */
export function homeMarkerPath(home: string): string {
  return join(home, "run", "home.marker");
}

export function ensureHomeMarker(home: string): void {
  try {
    writeFileSync(homeMarkerPath(home), "moss home\n", { flag: "wx", mode: 0o600 });
  } catch {
    // There already, or `run/` can't be written (the start fails elsewhere).
  }
}

/** The kinds of MOSS data an erase can leave, by the home's top-level names (anything else isn't counted: the engine's
 *  own start makes `logs/` and `run/` before it reads this, and a runner can't write the home). */
export const ERASE_LEFT_KINDS = { bots: "bots", transcripts: "conversations", sessions: "conversations", "sessions-runtime": "conversations", scratch: "files", routines: "routines", plugins: "plugins", "plugin-data": "plugins", "settings.json": "settings" } as const;
export type EraseLeftKind = (typeof ERASE_LEFT_KINDS)[keyof typeof ERASE_LEFT_KINDS];

export interface EraseResult {
  v: 1;
  result: "erased" | "partial";
  /** With `partial`: what is left, as kinds (never a name). */
  left: EraseLeftKind[];
}

/**
 * At the engine's start, before it makes anything of the home: the single reader of the erase's signal. It is taken
 * only as a regular file of this user's (a link or anything else is removed unread) and removed either way. With the
 * home's marker present the home is healthy (a runner planted the signal): nothing. Otherwise the erase ran on it:
 * `erased` when no MOSS data is left, `partial` with the kinds left. Whichever app started the engine, the result waits
 * inside the home (`writeEraseResult`) for MOSS to show once.
 */
export function takeEraseSignalAtStart(home: string, uid: number | undefined = process.getuid?.()): EraseResult | undefined {
  const path = eraseSignalPath(home);
  let ok = false;
  try {
    const st = lstatSync(path);
    ok = st.isFile() && !st.isSymbolicLink() && (uid === undefined || st.uid === uid);
    unlinkSync(path);
  } catch {
    return undefined;
  }
  if (!ok) return undefined;
  let names: string[] = [];
  try {
    names = readdirSync(home);
  } catch {
    // No home: all of it went.
  }
  const left = [...new Set(names.flatMap((n) => (Object.hasOwn(ERASE_LEFT_KINDS, n) ? [ERASE_LEFT_KINDS[n as keyof typeof ERASE_LEFT_KINDS]] : [])))].sort();
  // Only the erase's own proof inside the home (`run/erase.started`, which no runner can write) says it was cut short.
  // Without it, a home that still holds MOSS's data was never erased (a planted signal, or a home an older build ran,
  // which never wrote the marker): nothing is said.
  if (existsSync(eraseStartedPath(home))) return { v: 1, result: left.length === 0 ? "erased" : "partial", left };
  return left.length === 0 ? { v: 1, result: "erased", left: [] } : undefined;
}

/** The erase's proof that it began, inside the home (written first, removed last with `run/`). */
export function eraseStartedPath(home: string): string {
  return join(home, "run", "erase.started");
}

/** Inside the home (`run/`), where no runner can write: MOSS reads it once (apps/moss `erase-outcome.ts`). */
export function eraseResultPath(home: string): string {
  return join(home, "run", "erase-result.json");
}

export function writeEraseResult(home: string, r: EraseResult): void {
  try {
    writeFileSync(eraseResultPath(home), `${JSON.stringify(r)}\n`, { mode: 0o600 });
  } catch {
    // Not shown, then.
  }
}

export function writeEraseSignal(home: string): void {
  const path = eraseSignalPath(home);
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}`);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    closeSync(fd);
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
    // Nowhere to write it: the app shows nothing; the CLI's own erase prints instead.
  }
}

export const ERASE_KEEPS = [
  "the MOSS and MOSS Code apps themselves (uninstall them the usual way)",
  "the apps' own folders: their browser cookies and the key that signs your approvals",
  "your projects, and the .moss folder inside a project you opened",
  "files your bots or agents wrote outside MOSS's folder",
  `the previous app's folder (~/${OLD_INSTALL_HOME_DIR}), if you had one`,
  "anything at your AI providers, plugins' services and waifucave (delete your account first for that)",
] as const;

const HOME_MARKERS = ["settings.json", "transcripts", "sessions", "credentials", "bots", "sdk", "memory"];

export type HomeCheck = { ok: true; real: string; link?: string } | { ok: false; why: string };

/** Whether `home` is a MOSS home erase may remove, resolved. */
export function recogniseMossHome(home: string, userHome: string = homedir()): HomeCheck {
  const given = resolve(home);
  let real: string;
  try {
    real = realpathSync(given);
  } catch {
    return { ok: false, why: `${given} doesn't exist` };
  }
  let st;
  try {
    st = lstatSync(real);
  } catch {
    return { ok: false, why: `${given} can't be read` };
  }
  if (!st.isDirectory()) return { ok: false, why: `${given} isn't a folder` };
  if (real === parse(real).root) return { ok: false, why: "that is the disk's root" };
  let user = resolve(userHome);
  try {
    user = realpathSync(user);
  } catch {
    // A user home that can't be resolved is compared as given.
  }
  if (real === user || user.startsWith(real.endsWith(sep) ? real : real + sep)) return { ok: false, why: `${given} is your home folder or holds it` };
  if (otherInstallHome(real, userHome) !== undefined || otherInstallHome(given, userHome) !== undefined) return { ok: false, why: `${given} is another app's home` };
  if (existsSync(join(real, ".git"))) return { ok: false, why: `${given} holds a .git folder: it looks like a project, not MOSS's home` };
  const dir = (name: string) => {
    try {
      return lstatSync(join(real, name)).isDirectory();
    } catch {
      return false;
    }
  };
  if (!dir("run") || !dir("logs") || !HOME_MARKERS.some((m) => existsSync(join(real, m)))) return { ok: false, why: `${given} doesn't look like a MOSS home` };
  return { ok: true, real, ...(real !== given ? { link: given } : {}) };
}

/**
 * MOSS's own items in the OS store beside the secret store's listed ones, under its service (`keychainService`): the
 * daemon's tokens (`TOKEN_NAMES`) and the inherited names (`osStoreItemNames`) under the base service, and the secrets
 * file's key under `<service>.key`. Each by name: `Bun.secrets` can't list. Never another service's.
 */
export function dropMossOsItems(service: string, vault: (service: string) => Pick<Vault, "delete"> = bunVault): () => Promise<void> {
  return async () => {
    const base = vault(service);
    for (const name of new Set([...osStoreItemNames(), ...Object.values(TOKEN_NAMES)])) await base.delete(name).catch(() => undefined);
    await vault(`${service}.key`).delete("secrets-file-key").catch(() => undefined);
  };
}

export interface EraseDeps {
  home: string;
  userHome?: string;
  /** MOSS's own secrets: every item the store lists is deleted through it (the Keychain items of MOSS's service). */
  secrets?: { list(): Promise<SecretMeta[]>; delete(ref: SecretRef): Promise<unknown> };
  /** MOSS's items in the OS store the secret store doesn't list: the daemon's own tokens and the items kept under the
   *  base service by older builds, and (Windows, Linux) the secrets file's key (`dropMossOsItems`). */
  dropOsItems?(): Promise<void>;
  log?(line: string): void;
}

export interface EraseOutcome {
  /** Secrets deleted, by count (never their names or values). */
  secrets: number;
  /** Secrets that couldn't be deleted (the keyring locked): the person deletes them by hand. */
  secretsLeft: number;
  home: string;
  keeps: readonly string[];
}

/** Erases the home and MOSS's secrets. Throws, before anything is removed, for a home that isn't one. */
export async function eraseHome(deps: EraseDeps): Promise<EraseOutcome> {
  const check = recogniseMossHome(deps.home, deps.userHome);
  if (!check.ok) throw new ContractError("refused", `erase refused: ${check.why}; nothing was removed`);
  // The erase's own proof goes in first (`run/erase.started`): a home an erase got into, whatever is left of it, says so
  // at the next start; `run/` itself goes last, so the proof stays while anything else is left.
  mkdirSync(join(check.real, "run"), { recursive: true });
  writeFileSync(eraseStartedPath(check.real), "erase\n", { mode: 0o600 });
  let secrets = 0;
  let secretsLeft = 0;
  if (deps.secrets) {
    let items: SecretMeta[] = [];
    try {
      items = await deps.secrets.list();
    } catch {
      deps.log?.("erase: MOSS's saved keys couldn't be listed (the keyring is locked?): delete them by hand");
    }
    for (const m of items) {
      try {
        await deps.secrets.delete(m.ref);
        secrets++;
      } catch {
        secretsLeft++;
      }
    }
  }
  try {
    await deps.dropOsItems?.();
  } catch {
    deps.log?.("erase: some of MOSS's items in the OS keyring couldn't be deleted");
  }
  // Every entry removed as itself (rmSync never follows a link inside what it removes), then the folder, then the link
  // the home was given as.
  for (const name of readdirSync(check.real)) if (name !== "run") rmSync(join(check.real, name), { recursive: true, force: true });
  rmSync(join(check.real, "run"), { recursive: true, force: true });
  rmdirSync(check.real);
  // The files paired phones sent to coding sessions live beside the home (`<home>-received`, lane PH): removed as itself, never
  // followed if it is a link.
  const received = receivedRootOf(check.real);
  try {
    const st = lstatSync(received);
    if (st.isSymbolicLink()) unlinkSync(received);
    else if (st.isDirectory()) rmSync(received, { recursive: true, force: true });
  } catch {
    // None.
  }
  if (check.link !== undefined) {
    try {
      if (lstatSync(check.link).isSymbolicLink()) unlinkSync(check.link);
    } catch {
      // Already gone.
    }
  }
  return { secrets, secretsLeft, home: check.real, keeps: ERASE_KEEPS };
}
