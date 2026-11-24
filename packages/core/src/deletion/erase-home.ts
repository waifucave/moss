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
import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import type { SecretMeta, SecretRef } from "../contracts/secret-store";
import { TOKEN_NAMES } from "../auth/tokens";
import { osStoreItemNames } from "../secrets/file-backend";
import { bunVault, type Vault } from "../secrets/moss-secret-store";
import { OLD_INSTALL_HOME_DIR, otherInstallHome } from "../other-installs";
import { receivedRootOf } from "../bots/staged-files";

/** What erase leaves, said to the person every time. */
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
  if (!check.ok) throw new Error(`erase refused: ${check.why}; nothing was removed`);
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
  for (const name of readdirSync(check.real)) rmSync(join(check.real, name), { recursive: true, force: true });
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
