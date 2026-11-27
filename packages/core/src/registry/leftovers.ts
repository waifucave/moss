// What a plugin leaves when it goes: its secrets, its settings and synced store, its secret files and its data folder.
// `plugin.remove` forgets them at once (`forgetRemovedPlugin`). A folder that goes any other way (deleted by hand, or by
// a sync) leaves them, with a small "left by" record in the MAC'd state (the controller's ruling, 2026-11-11); deleting
// nothing yet. The controller's amended rule: a forget happens only (a) in `plugin.remove`, or (b) when a tree comes
// under an id that HAS a left-by record and its tree and source both differ (another tree hash; another index URL, or
// another npm package name; a local or wrapped plugin is the same only by its tree; the owner's ruling, 2026-11-13). Then it is
// forgotten first, before the new tree is put, and a forget that fails stops it with the reason. With no record,
// nothing is forgotten, ever: records read as empty (a bad MAC, a counter rolled back, a missing key, a home restored
// from a backup) must never cost a plugin its keys. And while the records weren't trusted at start, no left-by record
// is written that run. Accepted residual: what a plugin left in a home from before these records, with no record, stays
// for whatever tree next comes under its id (it asks for its OK as any new tree does).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { PluginProvenance } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import type { PluginRecord } from "../contracts/plugin-registry";
import type { SecretStore } from "../contracts/secret-store";
import { pluginPath } from "../plugin-host/paths";
import type { IndexClient } from "./indexes/client";
import { PluginSecretFiles } from "./secret-files";

/** Tries before a step of a removal is given up on a busy file (Windows keeps a file or folder a process still has open): a few tries over about 2.4 s. */
export const BUSY_TRIES = 9;
export const BUSY_WAIT_MS = 300;
/** The codes that mean "in use, try again": on Windows a held file or folder reports any of these; elsewhere only EBUSY does (EPERM and EACCES there are permission faults, never waited out). */
export function busyCodes(platform: string = process.platform): ReadonlySet<string> {
  return platform === "win32" ? new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]) : new Set(["EBUSY"]);
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn`, again after a short wait while it fails busy; the last failure is thrown. A success (the usual) is done in the same tick. */
export function retryBusy(fn: () => void, sleep: Sleep = realSleep, platform?: string): void | Promise<void> {
  const busy = busyCodes(platform);
  try { return fn(); } catch (e) {
    if (!busy.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
    return (async () => {
      for (let i = 2; ; i++) {
        await sleep(BUSY_WAIT_MS);
        try { return fn(); } catch (err) {
          if (i >= BUSY_TRIES || !busy.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
        }
      }
    })();
  }
}

/** The same for a step that is async (the secrets store). */
export async function retryBusyAsync(fn: () => Promise<void>, sleep: Sleep = realSleep, platform?: string): Promise<void> {
  const busy = busyCodes(platform);
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      if (i >= BUSY_TRIES || !busy.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      await sleep(BUSY_WAIT_MS);
    }
  }
}

/** Thrown by the data folder's step ALONE, when it is still in use after the tries: nothing else has been touched. */
export class DataFolderBusy extends Error {
  constructor(readonly code: string) { super(`a file in its data folder is still in use (${code})`); this.name = "DataFolderBusy"; }
}

/** Thrown when a step AFTER the data folder moved failed: what was already done, and that removing it again finishes the removal. */
export class RemovalIncomplete extends Error {
  constructor(readonly removed: readonly string[], readonly step: string, readonly code: string | undefined, readonly why?: string) {
    super(`removing it stopped part-way: ${removed.join(", ") || "nothing yet"} done; "${step}" failed${code !== undefined ? ` (${code})` : ""}${why !== undefined ? `: ${why}` : ""}. Removing it again finishes the job.`);
    this.name = "RemovalIncomplete";
  }
}

/** The "removing" mark: what a half-done removal needs to finish on the next attempt (the record's own facts, where the data went). */
interface Mark { record: { treeHash?: string; okHash?: string }; children: readonly string[]; kept?: string; at: number }
const markPath = (home: string, id: string): string => `${pluginPath(join(home, "plugin-data", ".removing"), id)}.json`;

/** Makes `parts` under `base` one directory at a time, each a real directory: a link (symlink or junction) planted at any of them is refused, never followed. */
function mkdirNoLink(base: string, parts: readonly string[]): string {
  let dir = base;
  for (const part of parts) {
    dir = join(dir, part);
    let st;
    try { st = lstatSync(dir); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      mkdirSync(dir, { mode: 0o700 });
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ContractError("refused", `${dir} is not a plain folder (a link or a file is there)`);
  }
  return dir;
}

/** Whether a removing mark is there for `id` (a half-done removal): the plugin must be removed again, not switched on. */
export function hasRemovingMark(home: string, id: string, record?: { treeHash?: string; okHash?: string }): boolean {
  const m = readMark(home, id);
  if (m === undefined) return false;
  // The registry holds a different tree under the id now (a reinstall or update that landed): the mark belongs to the old install and is dropped.
  if (record !== undefined && (m.record?.treeHash !== record.treeHash || m.record?.okHash !== record.okHash)) { clearRemovingMark(home, id); return false; }
  return true;
}

/** Drops a removing mark (a reinstall or update of the id owns it now). */
export function clearRemovingMark(home: string, id: string): void {
  try { rmSync(markPath(home, id), { force: true }); } catch { /* none */ }
}

function writeMark(home: string, id: string, mark: Mark): void {
  const path = markPath(home, id);
  const tmp = `${path}.${process.pid}.tmp`;
  mkdirNoLink(home, ["plugin-data", ".removing", ...id.split("/").slice(0, -1)]);
  try { if (lstatSync(path).isSymbolicLink()) rmSync(path, { force: true }); } catch { /* none */ }
  writeFileSync(tmp, JSON.stringify(mark), { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

function readMark(home: string, id: string): Mark | undefined {
  try {
    const path = markPath(home, id);
    if (lstatSync(path).isSymbolicLink()) return undefined;
    const m = JSON.parse(readFileSync(path, "utf8")) as Mark;
    return typeof m === "object" && m !== null ? m : undefined;
  } catch { return undefined; }
}

/** The ids with a removal that stopped part-way (their data moved, the rest to finish): a person's next `plugin.remove` of one finishes it. */
export function pendingRemovals(home: string): string[] {
  const dir = join(home, "plugin-data", ".removing");
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const full = join(d, n);
      try {
        const st = lstatSync(full);
        if (st.isDirectory()) walk(full, `${prefix}${n}/`);
        else if (n.endsWith(".json")) out.push(`${prefix}${n.slice(0, -5)}`);
      } catch { /* gone */ }
    }
  };
  walk(dir, "");
  return out;
}

/** What removing a plugin leaves behind, and where (#332's review): its secrets, its settings file and its synced store
 *  are deleted, for it and each of its children, so a later plugin installed under the same id inherits none of them.
 *  Its data folder is kept, as the spec says (§5.4), but moved out of the id's path to
 *  `<home>/plugin-data/.removed/<id>/<when>-<tree hash>/`, keyed to that install, so another publisher's plugin with
 *  the same id starts with an empty one. No plugin id starts with a dot.
 *
 *  The data folder goes FIRST, tried again briefly while it is in use: on Windows a folder a process still holds open can't
 *  be moved, and when it can't, `DataFolderBusy` is thrown with nothing else touched. Once it has moved, a "removing" mark
 *  is kept and each later step is tried again on a busy file; a step that still fails throws `RemovalIncomplete` naming what
 *  was done, and the next attempt (every step is idempotent) finishes it from the mark. */
export async function forgetRemovedPlugin(o: { home: string; secrets?: Pick<SecretStore, "list" | "delete">; record: Pick<PluginRecord, "id" | "source" | "treeHash" | "okHash" | "provenance">; children: readonly string[]; now?: () => number; deleteData?: boolean; sleep?: Sleep; platform?: string; rename?: (from: string, to: string) => void }): Promise<{ dataKeptAt?: string }> {
  const data = pluginPath(join(o.home, "plugin-data"), o.record.id);
  // The mark is used only for the install it was written for (same tree and OK hashes) and only for where its data went; whether data is
  // deleted is the CALLER's choice, always, never the mark's.
  const found = readMark(o.home, o.record.id);
  const resumed = found !== undefined && found.record?.treeHash === o.record.treeHash && found.record?.okHash === o.record.okHash ? found : undefined;
  if (found !== undefined && resumed === undefined) clearRemovingMark(o.home, o.record.id);
  const keptRoot = join(o.home, "plugin-data", ".removed", ...o.record.id.split("/"));
  let kept: string | undefined = resumed?.kept !== undefined && resolve(resumed.kept).startsWith(resolve(keptRoot) + sep) ? resumed.kept : undefined;
  const deleteData = o.deleteData === true;
  const busy = busyCodes(o.platform);
  const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;
  // The data folder's step: its busy failure is `DataFolderBusy`, and only that.
  const folderStep = async (fn: () => void): Promise<void> => {
    try {
      const r = retryBusy(fn, o.sleep, o.platform);
      if (r !== undefined) await r;
    } catch (e) {
      if (busy.has(codeOf(e) ?? "")) throw new DataFolderBusy(codeOf(e)!);
      throw e;
    }
  };
  // `rmSync` of a link at the folder's name unlinks it (a junction is not followed into its target).
  if (deleteData) {
    await folderStep(() => rmSync(data, { recursive: true, force: true }));
    await folderStep(() => rmSync(join(o.home, "plugin-data", ".removed", ...o.record.id.split("/")), { recursive: true, force: true }));
  } else if (existsSync(data) || (() => { try { return lstatSync(data) !== undefined; } catch { return false; } })()) {
    const hash = (o.record.okHash ?? o.record.treeHash ?? "unknown").replace(/^sha256:/, "").slice(0, 16);
    const to = join(mkdirNoLink(o.home, ["plugin-data", ".removed", ...o.record.id.split("/")]), `${new Date(o.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, "-")}-${hash}`);
    await folderStep(() => (o.rename ?? renameSync)(data, to));
    kept = to;
  }
  // From here the data is gone from its place: a failure says what was done, and the mark lets the next attempt finish.
  const done: string[] = [];
  if (kept !== undefined || deleteData) done.push(deleteData ? "its data folder was deleted" : "its data folder was moved aside");
  try { writeMark(o.home, o.record.id, { record: { ...(o.record.treeHash !== undefined ? { treeHash: o.record.treeHash } : {}), ...(o.record.okHash !== undefined ? { okHash: o.record.okHash } : {}) }, children: o.children, ...(kept !== undefined ? { kept } : {}), at: o.now?.() ?? Date.now() }); } catch (e) { throw new RemovalIncomplete(done, "the removing mark written", codeOf(e), e instanceof Error ? e.message.slice(0, 200) : undefined); }
  const step = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try { await retryBusyAsync(async () => { await fn(); }, o.sleep, o.platform); } catch (e) { throw new RemovalIncomplete(done, name, codeOf(e), e instanceof Error ? e.message.slice(0, 200) : undefined); }
    done.push(name);
  };
  if (kept !== undefined) {
    try { writeFileSync(join(kept, ".moss-removed.json"), JSON.stringify({ id: o.record.id, source: o.record.source, treeHash: o.record.treeHash, okHash: o.record.okHash, provenance: o.record.provenance, removedAt: o.now?.() ?? Date.now() }), { mode: 0o600 }); } catch { /* the folder is kept without its note */ }
  }
  const ids = [o.record.id, ...o.children];
  for (const pluginId of ids) {
    if (o.secrets !== undefined) await step(`${pluginId}'s keys deleted`, async () => { for (const meta of await o.secrets!.list({ kind: "plugin", pluginId })) await o.secrets!.delete(meta.ref); });
    await step(`${pluginId}'s settings deleted`, () => rmSync(`${pluginPath(join(o.home, "settings", "plugins"), pluginId)}.json`, { force: true }));
    await step(`${pluginId}'s synced store deleted`, () => rmSync(`${pluginPath(join(o.home, "settings", "plugin-stores"), pluginId)}.json`, { force: true }));
  }
  // Its secrets' files (`${secretFile:…}`) go with it.
  await step("its secret files released", () => new PluginSecretFiles(o.home).releasePlugin(o.record.id));
  try { rmSync(markPath(o.home, o.record.id), { force: true }); } catch { /* a stale mark is read as nothing left to do */ }
  return kept === undefined ? {} : { dataKeptAt: kept };
}


/** Whether two provenances are the same source: the same index URL, or the same npm package name (the owner's ruling,
 *  2026-11-13). A local folder or a wrapped item is never: only its tree hash says it is the same. */
export function sameSource(a: PluginProvenance | undefined, b: PluginProvenance | undefined): boolean {
  if (a?.index !== undefined || b?.index !== undefined) return a?.index !== undefined && b?.index !== undefined && a.index.url === b.index.url;
  if (a?.npm !== undefined || b?.npm !== undefined) return a?.npm !== undefined && b?.npm !== undefined && a.npm.name === b.npm.name;
  return false;
}

export class Leftovers {
  readonly #o: { home: string; secrets?: Pick<SecretStore, "list" | "delete">; client: IndexClient; trusted?: () => boolean; now?: () => number; log?: (line: string) => void };
  /** The ids settled since they last went away, in this run: a folder read again before its install's record lands
   *  (the watcher's read beside `plugin.install`'s) isn't settled twice, so a wrapper's keys just stored stay. */
  readonly #settled = new Set<string>();
  #untrustedSaid = false;

  /** `trusted`: whether the records read at start were trusted (no bad MAC, no counter rolled back); false, no left-by
   *  record is written this run. */
  constructor(o: { home: string; secrets?: Pick<SecretStore, "list" | "delete">; client: IndexClient; trusted?: () => boolean; now?: () => number; log?: (line: string) => void }) {
    this.#o = o;
  }

  settled(id: string): boolean {
    return this.#settled.has(id);
  }

  /** A plugin's folder went without `plugin.remove`: what it leaves stays, recorded. Not while an update of it is coming
   *  up (its previous version is kept and comes back), and not in a run whose records weren't trusted. */
  left(r: Pick<PluginRecord, "id" | "source" | "treeHash" | "okHash" | "provenance">, children: readonly string[]): void {
    this.#settled.delete(r.id);
    if (this.#o.client.updating()[r.id] !== undefined) return;
    if (this.#o.trusted?.() === false) {
      if (!this.#untrustedSaid) this.#o.log?.("plugins: the records weren't trusted at start (changed outside MOSS, or an older copy put back), so no plugin's leftovers are recorded this run; nothing is deleted");
      this.#untrustedSaid = true;
      return;
    }
    this.#o.client.setLeftBy(r.id, {
      source: r.source, provenance: r.provenance as Record<string, unknown>, at: (this.#o.now ?? Date.now)(), children: [...children],
      ...(r.treeHash !== undefined ? { treeHash: r.treeHash } : {}), ...(r.okHash !== undefined ? { okHash: r.okHash } : {}),
    });
  }

  /** `plugin.remove` forgot what it left: nothing to record. */
  cleared(id: string): void {
    this.#settled.delete(id);
    if (this.#o.client.leftBy(id) !== undefined) this.#o.client.setLeftBy(id, undefined);
  }

  /** A tree comes under `id`: with a left-by record whose tree and source both differ, what was left is forgotten first
   *  (it and the children the record names); otherwise nothing is touched. Throws when the forget fails (a key that
   *  can't be deleted): the tree isn't put. */
  async settle(id: string, incoming: { treeHash?: string; provenance: PluginProvenance }): Promise<void> {
    // Settled already in this run (a wrapper settles before storing its keys, then again as its folder lands).
    if (this.#settled.has(id)) return;
    const rec = this.#o.client.leftBy(id);
    this.#settled.add(id);
    // No record: nothing is forgotten, ever (the amended rule).
    if (rec === undefined) return;
    const prov = rec.provenance as PluginProvenance;
    const same = (rec.treeHash !== undefined && rec.treeHash === incoming.treeHash)
      || sameSource(prov, incoming.provenance);
    if (same) {
      this.#o.client.setLeftBy(id, undefined);
      return;
    }
    try {
      await forgetRemovedPlugin({
        home: this.#o.home, ...(this.#o.secrets !== undefined ? { secrets: this.#o.secrets } : {}), children: rec.children,
        record: { id, source: rec.source as PluginRecord["source"], treeHash: rec.treeHash, okHash: rec.okHash, provenance: prov },
        ...(this.#o.now ? { now: this.#o.now } : {}),
      });
    } catch (err) {
      this.#settled.delete(id);
      throw new ContractError("failed", `what the plugin removed earlier under ${id} left (its keys, settings and data) couldn't be cleared for this one: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
    this.#o.client.setLeftBy(id, undefined);
    this.#o.log?.(`plugins: ${id} comes from another source than the plugin that left its keys, settings and data; they were cleared (its data kept under plugin-data/.removed)`);
  }
}
