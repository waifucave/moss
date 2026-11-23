// An agent whose program MOSS provides (spec §9.3 "An adapter MOSS provides"). Some agents don't speak ACP themselves:
// they run through an ADAPTER, an npm package that speaks ACP on the agent's behalf (Claude Code's and Codex's). A
// plugin's `agentBackends` entry can say its program is such an adapter, in its quirks file's `launch.adapter`: the
// package, its exact version, the integrity of that version's tarball, the file of it that runs, and (optionally) the
// closure of packages it needs, locked the way an npm lockfile locks them. MOSS then fetches exactly that, once, behind
// one card, checks every tarball against its integrity before anything is unpacked, keeps it in a folder of its own
// under the MOSS home, and runs it on MOSS's own runtime. Nothing here names an agent: any plugin may declare one.
//
// What an adapter drives, the person's own program (`claude`, `codex`), is NOT fetched: `uses` names it, MOSS finds
// it on the person's PATH, checks its identity as it checks any agent's, and hands the adapter its path in the
// environment variable the adapter reads.
import { z } from "zod";

/** An npm package name (`@scope/name` or `name`, lowercase, at most 214 characters). */
export const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PackageName = z.string().max(214).regex(NPM_NAME);
/** An exact version: no range, no tag, no pre-release (a prerelease is never pinned). */
const ExactVersion = z.string().max(64).regex(/^\d+\.\d+\.\d+$/);
/** npm's SHA-512 integrity record: `sha512-` and 88 base64 characters. */
export const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const Integrity = z.string().regex(INTEGRITY);

/** A path inside the adapter's folder that a package lands at: `node_modules/<name>`, nested the way npm nests them. */
const PACKAGE_PATH = /^node_modules\/(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)*$/;

/** The adapter's own run file, relative to its package, `/`-separated, no `..`. */
const RunFile = z.string().min(1).max(256).regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@/-]+$/);

/** A locked package: where it lands, which it is, and the integrity its tarball must have. `size` is its tarball's bytes
 *  where the lock's author measured it (the card's "about N MB"). */
export const LockedPackage = z.strictObject({
  path: z.string().max(1024).regex(PACKAGE_PATH),
  name: PackageName,
  version: ExactVersion,
  integrity: Integrity,
  size: z.number().int().min(0).max(512 * 1024 * 1024).optional(),
}).refine((p) => p.path.endsWith(`node_modules/${p.name}`), { message: "its path doesn't end in its name" });
export type LockedPackage = z.infer<typeof LockedPackage>;

/** The most packages one adapter locks. */
export const LOCK_MAX_PACKAGES = 400;

/** A lock file: the packages an adapter needs beside itself, from an npm lockfile (`scripts/agent-adapter-lock.ts`). */
export const LockFileSchema = z.strictObject({
  lock: z.literal(1),
  /** Where each hash came from (the registry's metadata, npm's own lockfile), for whoever reviews a change to it. */
  source: z.string().max(1024),
  packages: z.array(LockedPackage).max(LOCK_MAX_PACKAGES),
}).refine((f) => new Set(f.packages.map((p) => p.path)).size === f.packages.length, { message: "a path is locked twice" });
export type LockFile = z.infer<typeof LockFileSchema>;

/** A program of the person's that the adapter drives: found on PATH, identity-checked, its path handed in `env`. */
export const AdapterUse = z.strictObject({
  program: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  env: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  identity: z.strictObject({ versionArgs: z.array(z.string().max(256)).max(8), versionPattern: z.string().max(1024) }).optional(),
});
export type AdapterUse = z.infer<typeof AdapterUse>;

/** `launch.adapter` in a quirks file. */
export const AdapterDeclSchema = z.strictObject({
  package: PackageName,
  version: ExactVersion,
  integrity: Integrity,
  /** The adapter's own tarball's bytes, where the declaration's author measured it (the card's "about N MB"). */
  size: z.number().int().min(0).max(512 * 1024 * 1024).optional(),
  /** The file of the package that runs, and the runtime that runs it: MOSS's own (the only one there is). */
  run: RunFile,
  runtime: z.literal("moss-bun"),
  /** A JSON file in the plugin's folder (`LockFileSchema`): the packages the adapter needs. None: a bundled adapter. */
  lock: z.string().max(256).optional(),
  uses: z.array(AdapterUse).max(4).optional(),
});
export type AdapterDeclFile = z.infer<typeof AdapterDeclSchema>;

/** A declaration with its lock read in. */
export interface AdapterDecl extends AdapterDeclFile {
  packages: readonly LockedPackage[];
}

/** What a download card says, and what the fetch needs. */
export interface AdapterOffer {
  package: string;
  version: string;
  /** Where the tarballs come from. */
  registry: string;
  /** How many packages are fetched, and their size where the lock measured it. */
  packages: number;
  bytes?: number;
  /** Where MOSS keeps them. */
  folder: string;
  /** The person's programs it drives (`claude`, `codex`), for the card. */
  uses: string[];
  /** Why it is asked again, where a copy was found changed. */
  again?: string;
}

/** What a start of the agent will be, once the adapter is in place (the facts a start card shows, known before the
 *  download: all of them come from the plugin's declaration and this computer, none from the files). */
export interface AdapterStartFacts {
  /** The run file the agent will be started from, in MOSS's own folder. */
  path: string;
  /** The version the start is judged by: the adapter's own. */
  version: string;
  /** Its version is in the range MOSS was tested with. */
  versionOk: boolean;
  /** MOSS admitted a sandbox for it here. */
  sandboxed: boolean;
}

/** The copy a fetch placed and checked whole: what the person's yes for the start may be bound to. */
export interface AdapterPlaced {
  path: string;
  version: string;
  /** The digest of every file of the copy, as MOSS recorded and re-checked it (what an OK for the start names). */
  digest: string;
}

/** An agent backend that can have its adapter provided (`AcpAgentBackend` with a declaration). */
export interface AdapterBackend {
  /** What a card would say, or undefined when no download is needed (a copy is in place, or it can't be used anyway). */
  adapterOffer(): Promise<AdapterOffer | undefined>;
  /** What the start will be once the adapter is in place, or undefined where it can't be told (no runtime to run it).
   *  With `adapterOffer` it lets ONE card ask for the download and the start together. */
  adapterStart?(): Promise<AdapterStartFacts | undefined>;
  /** Fetches and places the adapter (after the person's yes), checks the whole copy, and says what it placed; throws a
   *  `ContractError` saying plainly why not. */
  provideAdapter(): Promise<AdapterPlaced>;
  /** The outcome of the last offer, kept so `detect` can say why the agent isn't there. */
  noteAdapter(outcome: { declined: true } | { failed: string } | { ok: true }): void;
}

/** The plain lines for an adapter that wasn't downloaded: `detect`'s reason, and what a start that was refused by a
 *  combined card's no or failure says. One place, so the two never differ. */
export const adapterDeclinedLine = (label: string): string =>
  `${label}'s adapter wasn't downloaded, because you said no; MOSS asks again the next time you start ${label}`;
export const adapterFailedLine = (label: string, why: string): string => `${label}'s adapter couldn't be downloaded: ${why}`;

export const isAdapterBackend = (b: unknown): b is AdapterBackend =>
  typeof b === "object" && b !== null && typeof (b as AdapterBackend).adapterOffer === "function" && typeof (b as AdapterBackend).provideAdapter === "function";

/** The tarball's address on the registry: npm's own layout (`/<name>/-/<unscoped name>-<version>.tgz`). */
export function tarballUrl(registry: string, name: string, version: string): string {
  return `${registry}/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
}
