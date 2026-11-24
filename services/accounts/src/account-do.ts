// One account's devices (PROTOCOL.md): each device's link key, box key, name and kind, when it was added and revoked,
// and the last `t` it signed with, per statement, so a captured request can't be replayed. The Worker has checked
// the sign-in, the shapes and a registration's signature; a mint's, a leave's and a deletion's signature is checked
// here, against the key this object holds.
//
// * A revoked device stays listed for `revokedRowKeepMs` (30 days), so every other device learns of the revoke at its
//   next sync; then its row is cut down to its id and the time (`revoked_ids`), which is all it takes to refuse the
//   device's key if it ever tries to register again (its Supabase session may outlive the revoke: the project's refresh
//   tokens don't end on their own).
// * A device leaves at sign-out (`leave`): its row goes, so it can register again at its next sign-in.
// * The account's deletion (`deleteAccount`): every row here goes at once and a mark (`meta.deleting`) refuses every call
//   of the account; the other services and the sign-in are told by `deletion.ts`, retried by the alarm until each
//   confirms; then the object forgets the account entirely.

import { DurableObject } from "cloudflare:workers";

import { fromB64, fromB64u } from "../../shared/encoding";
import type { Env } from "./env";
import { retryDelayMs, runDeletionStep } from "./deletion";
import { verifyEd25519 } from "./verify";
import { type AccountDevice, DELETION_STEPS, type DeletionStep, type DeletionView, deleteStatement, type DeviceKind, leaveStatement, LIMITS, mintStatement, type Os } from "./wire";

interface Deleting {
  /** The account (the object's name), for the alarm's retries. */
  account: string;
  since: number;
  done: DeletionStep[];
  tries: number;
  /** When the alarm next tries the pending steps. */
  next: number;
}

export type Reply<T = undefined> = { status: number; error?: string; body?: T };

interface DeviceRow extends Record<string, SqlStorageValue> {
  id: string;
  public_key: string;
  box_key: string;
  name: string;
  kind: string;
  os: string | null;
  added_at: number;
  revoked_at: number | null;
  last_t: number;
}

export interface DeviceInput {
  id: string;
  publicKey: string;
  boxKey: string;
  name: string;
  kind: DeviceKind;
  os?: Os;
}

function view(row: DeviceRow): AccountDevice {
  return {
    id: row.id,
    publicKey: row.public_key,
    boxKey: row.box_key,
    name: row.name,
    kind: row.kind as DeviceKind,
    ...(row.os !== null ? { os: row.os as Os } : {}),
    addedAt: row.added_at,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
}

export class AccountDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  private migrate(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, public_key TEXT NOT NULL, box_key TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      os TEXT, added_at INTEGER NOT NULL, revoked_at INTEGER, last_t INTEGER NOT NULL
    ) WITHOUT ROWID`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mints (
      device TEXT NOT NULL, aud TEXT NOT NULL, last_t INTEGER NOT NULL, PRIMARY KEY (device, aud)
    ) WITHOUT ROWID`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS revoked_ids (id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL) WITHOUT ROWID");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID");
  }

  // ---- the account's deletion ----

  private deleting(): Deleting | undefined {
    const v = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'deleting'").toArray()[0]?.v;
    return v === undefined ? undefined : (JSON.parse(v) as Deleting);
  }

  private setDeleting(d: Deleting): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('deleting', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", JSON.stringify(d));
  }

  private deletionView(d: Deleting): DeletionView {
    return { deletedAt: d.since, pending: DELETION_STEPS.filter((s) => !d.done.includes(s)) };
  }

  private static readonly GONE: Reply<never> = { status: 410, error: "account_deleted" };

  /**
   * Deletes the account, asked by a listed device that isn't revoked with its signature over the delete statement and a
   * `t` newer than its last deletion's. Every row here goes at once and the account is refused from then on; the other
   * services and the sign-in follow (`runDeletion`). Asked again while it runs (any session of the account, the rows
   * being gone), it answers how far it got and tries the pending steps again.
   */
  async deleteAccount(account: string, device: string, t: number, sig: string, now: number): Promise<Reply<{ deletion: DeletionView }>> {
    const running = this.deleting();
    if (running) {
      await this.runDeletion(account);
      const d = this.deleting();
      return { status: 200, body: { deletion: d ? this.deletionView(d) : { deletedAt: running.since, pending: [] } } };
    }
    const existing = this.row(device);
    if (!existing || existing.revoked_at !== null) return { status: 403, error: "not_member" };
    if (!(await verifyEd25519(fromB64(existing.public_key), fromB64u(sig), deleteStatement(account, device, t)))) return { status: 403, error: "bad_signature" };
    // From here without a pause: nothing can slip in between the checks and the wipe.
    if (this.deleting()) return { status: 200, body: { deletion: this.deletionView(this.deleting()!) } };
    if (this.row(device)?.revoked_at !== null) return { status: 403, error: "not_member" };
    // No replay to keep: every row goes now, so a captured statement sent again finds no device to speak for (and
    // while the deletion runs, the answer above is only how far it got).
    this.sql.exec("DELETE FROM devices");
    this.sql.exec("DELETE FROM mints");
    this.sql.exec("DELETE FROM revoked_ids");
    const d: Deleting = { account, since: now, done: [], tries: 0, next: now };
    this.setDeleting(d);
    await this.runDeletion(account);
    const after = this.deleting();
    return { status: 200, body: { deletion: after ? this.deletionView(after) : { deletedAt: now, pending: [] } } };
  }

  /** Tries every pending step, the sign-in last and only once the others are done; when all are, forgets the account. */
  private async runDeletion(account: string): Promise<void> {
    const d = this.deleting();
    if (!d) return;
    for (const step of DELETION_STEPS) {
      if (d.done.includes(step)) continue;
      if (step === "sign-in" && DELETION_STEPS.some((s) => s !== "sign-in" && !d.done.includes(s))) break;
      if (await runDeletionStep(this.env, account, step)) d.done.push(step);
    }
    if (DELETION_STEPS.every((s) => d.done.includes(s))) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.migrate();
      return;
    }
    d.next = Date.now() + retryDelayMs(d.tries);
    d.tries += 1;
    this.setDeleting(d);
    await this.schedule();
  }

  // ---- revoked rows ----

  /** Cuts each device revoked longer than `revokedRowKeepMs` ago down to its id and time. */
  private trimRevoked(now: number): void {
    const cutoff = now - LIMITS.revokedRowKeepMs;
    this.sql.exec("INSERT OR REPLACE INTO revoked_ids (id, revoked_at) SELECT id, revoked_at FROM devices WHERE revoked_at IS NOT NULL AND revoked_at <= ?", cutoff);
    this.sql.exec("DELETE FROM devices WHERE revoked_at IS NOT NULL AND revoked_at <= ?", cutoff);
    const over = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM revoked_ids").one().n - LIMITS.maxRevokedIds;
    if (over > 0) this.sql.exec("DELETE FROM revoked_ids WHERE id IN (SELECT id FROM revoked_ids ORDER BY revoked_at LIMIT ?)", over);
  }

  /** The alarm: the deletion's next try, or the next revoked row's trim, whichever is first. */
  private async schedule(): Promise<void> {
    const d = this.deleting();
    const oldest = this.sql.exec<{ at: number | null }>("SELECT MIN(revoked_at) AS at FROM devices WHERE revoked_at IS NOT NULL").one().at;
    const times = [d?.next, oldest === null ? undefined : oldest + LIMITS.revokedRowKeepMs].filter((x): x is number => x !== undefined);
    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  override async alarm(): Promise<void> {
    const d = this.deleting();
    if (d && Date.now() >= d.next) {
      await this.runDeletion(d.account);
      return;
    }
    this.trimRevoked(Date.now());
    await this.schedule();
  }

  /** A device leaving at sign-out: its own signature over the leave statement, with a `t` newer than its registration's.
   *  Its row goes, so it can register again; a revoked device can't leave (its revoke stays). Again: nothing to do. */
  async leave(account: string, device: string, t: number, sig: string): Promise<Reply> {
    if (this.deleting()) return AccountDO.GONE;
    const existing = this.row(device);
    if (!existing) return { status: 204 };
    if (existing.revoked_at !== null) return { status: 403, error: "revoked" };
    if (!(await verifyEd25519(fromB64(existing.public_key), fromB64u(sig), leaveStatement(account, device, t)))) return { status: 403, error: "bad_signature" };
    const now = this.row(device);
    if (!now) return { status: 204 };
    if (now.revoked_at !== null) return { status: 403, error: "revoked" };
    if (t <= now.last_t) return { status: 409, error: "replay" };
    this.sql.exec("DELETE FROM devices WHERE id = ?", device);
    this.sql.exec("DELETE FROM mints WHERE device = ?", device);
    return { status: 204 };
  }

  private row(id: string): DeviceRow | undefined {
    return this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE id = ?", id).toArray()[0];
  }

  /** Adds the device, or updates its name, kind, system and box key (a signed statement newer than its last). */
  async register(device: DeviceInput, t: number, now: number): Promise<Reply<{ device: AccountDevice }>> {
    if (this.deleting()) return AccountDO.GONE;
    this.trimRevoked(now);
    if (this.sql.exec("SELECT 1 AS x FROM revoked_ids WHERE id = ?", device.id).toArray().length > 0) return { status: 403, error: "revoked" };
    const existing = this.row(device.id);
    if (existing) {
      if (existing.revoked_at !== null) return { status: 403, error: "revoked" };
      if (existing.public_key !== device.publicKey) return { status: 409, error: "conflict" };
      if (t <= existing.last_t) return { status: 409, error: "replay" };
      this.sql.exec(
        "UPDATE devices SET box_key = ?, name = ?, kind = ?, os = ?, last_t = ? WHERE id = ?",
        device.boxKey, device.name, device.kind, device.os ?? null, t, device.id,
      );
      return { status: 200, body: { device: view(this.row(device.id)!) } };
    }
    const active = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL").one().n;
    if (active >= LIMITS.maxDevices) return { status: 409, error: "full" };
    const rows = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices").one().n;
    if (rows >= LIMITS.maxRows) {
      // Makes room by forgetting the longest-revoked device; there is always one, since the active ones are fewer.
      this.sql.exec("DELETE FROM devices WHERE id = (SELECT id FROM devices WHERE revoked_at IS NOT NULL ORDER BY revoked_at LIMIT 1)");
    }
    this.sql.exec(
      "INSERT INTO devices (id, public_key, box_key, name, kind, os, added_at, revoked_at, last_t) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
      device.id, device.publicKey, device.boxKey, device.name, device.kind, device.os ?? null, now, t,
    );
    return { status: 201, body: { device: view(this.row(device.id)!) } };
  }

  async list(now: number = Date.now()): Promise<Reply<{ devices: AccountDevice[] }>> {
    if (this.deleting()) return AccountDO.GONE;
    this.trimRevoked(now);
    return { status: 200, body: { devices: this.sql.exec<DeviceRow>("SELECT * FROM devices ORDER BY added_at, id").toArray().map(view) } };
  }

  /** Revokes a device of the account; revoking again changes nothing. One whose row was trimmed is still revoked. */
  async revoke(id: string, now: number): Promise<Reply> {
    if (this.deleting()) return AccountDO.GONE;
    const existing = this.row(id);
    if (!existing) return this.sql.exec("SELECT 1 AS x FROM revoked_ids WHERE id = ?", id).toArray().length > 0 ? { status: 204 } : { status: 404, error: "not_found" };
    if (existing.revoked_at === null) this.sql.exec("UPDATE devices SET revoked_at = ? WHERE id = ?", now, id);
    this.sql.exec("DELETE FROM mints WHERE device = ?", id);
    await this.schedule();
    return { status: 204 };
  }

  /** Whether `device` may have a token for `aud` now: listed, not revoked, its signature good and its `t` new. */
  async allowMint(account: string, device: string, aud: string, t: number, sig: string): Promise<Reply> {
    if (this.deleting()) return AccountDO.GONE;
    const existing = this.row(device);
    if (!existing || existing.revoked_at !== null) return { status: 403, error: "not_member" };
    const key = fromB64(existing.public_key);
    if (!(await verifyEd25519(key, fromB64u(sig), mintStatement(account, aud, device, t)))) return { status: 403, error: "bad_signature" };
    // Everything from here runs without a pause, so a revoke or another mint can't slip in between the check and the
    // write; the revoke is looked at again, since it may have come during the signature check.
    if (this.deleting()) return AccountDO.GONE;
    if (this.row(device)?.revoked_at !== null) return { status: 403, error: "not_member" };
    const last = this.sql.exec<{ last_t: number }>("SELECT last_t FROM mints WHERE device = ? AND aud = ?", device, aud).toArray()[0];
    if (last && t <= last.last_t) return { status: 409, error: "replay" };
    this.sql.exec("INSERT INTO mints (device, aud, last_t) VALUES (?, ?, ?) ON CONFLICT (device, aud) DO UPDATE SET last_t = excluded.last_t", device, aud, t);
    return { status: 200 };
  }
}
