// An account's push targets: its phones' APNs device tokens and its browsers' Web Push subscriptions. A notify
// fans a count out to each; a target the push service reports gone is removed, and one APNs calls a bad token
// is removed only after several such answers in a row (a wrong topic at our end would answer the same).
// Revoking a device (DELETE /v1/devices/:id, what the account service's revocation calls) keeps it from
// registering or notifying with a token it already holds, for 24 hours and 10 minutes: past that, every
// token issued before the revocation has expired. Removing a target only stops pushes to it.

import { DurableObject } from "cloudflare:workers";

import { preferThenAll, type PushApp } from "../../../packages/protocol/src/push-routing";
import { utf8 } from "../../shared/encoding";
import { sendApns, type SendOutcome } from "./apns";
import { apnsConfig, maxTargets, pushTimeoutMs, vapidConfig, type Env } from "./env";
import type { FcmTarget } from "./fcm";
import { sendWebPush } from "./webpush";

export interface Caller {
  owner: string;
  device: string;
}

export type Target =
  | { kind: "apns"; token: string; env: "production" | "sandbox"; app: PushApp }
  | ({ kind: "fcm" } & FcmTarget)
  | { kind: "webpush"; endpoint: string; p256dh: string; auth: string };

/** A phone's target (APNs, FCM), as against a browser's: the ones a push's `phones` preference is about. */
const isPhone = (t: Target): t is Extract<Target, { kind: "apns" | "fcm" }> => t.kind === "apns" || t.kind === "fcm";

export interface TargetInfo {
  id: string;
  kind: Target["kind"];
  env?: string;
  /** For a phone: the app it registered as. */
  app?: PushApp;
  /** For a browser, only its push service's host: the endpoint itself is a bearer capability. */
  host?: string;
  added: number;
}

export interface NotifyResult {
  sent: number;
  removed: number;
  failed: number;
}

export type Refusal = { ok: false; status: 403 | 409 | 410; error: string };

const TTL_SECONDS = 24 * 3600;
/** Bad-token answers in a row before a phone's target is forgotten. */
const SUSPECT_LIMIT = 3;
/** How long a revocation is kept: the longest account-token lifetime (24 h), plus clock skew and margin. */
export const REVOCATION_KEEP_MS = 24 * 3600 * 1000 + 10 * 60 * 1000;
/** After the account is deleted, how long the mark that refuses its tokens is kept: as long as any token minted before
 *  the deletion can live (the same window as a revocation's). Then the object forgets the account entirely. */
export const ERASED_KEEP_MS = REVOCATION_KEEP_MS;

export class PushDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private owner: string | null | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    if (!this.sql.exec("SELECT 1 AS x FROM meta WHERE k = 'schema'").toArray().length) {
      // Frozen at the first deploy: any later change needs a new schema version and a step that migrates to it.
      this.sql.exec(`
        CREATE TABLE targets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, added INTEGER NOT NULL,
                              failures INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
        CREATE TABLE revoked (id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;
        INSERT INTO meta (k, v) VALUES ('schema', '1');
      `);
    }
  }

  private ownerMatches(owner: string): boolean {
    if (this.owner === undefined) {
      this.owner = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'owner'").toArray()[0]?.v ?? null;
    }
    if (this.owner === null) {
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('owner', ?)", owner);
      this.owner = owner;
    }
    return this.owner === owner;
  }

  /** When the account was deleted here (`eraseAccount`), while its tokens may still be live. */
  private erasedAt(): number | undefined {
    const v = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'erased'").toArray()[0]?.v;
    return v === undefined ? undefined : Number(v);
  }

  private refuse(caller: Caller): Refusal | null {
    if (this.erasedAt() !== undefined) return { ok: false, status: 410, error: "account_deleted" };
    if (!this.ownerMatches(caller.owner)) return { ok: false, status: 403, error: "wrong_account" };
    if (this.sql.exec("SELECT 1 AS x FROM revoked WHERE id = ? AND at > ?", caller.device, Date.now() - REVOCATION_KEEP_MS).toArray().length > 0) {
      return { ok: false, status: 403, error: "revoked" };
    }
    return null;
  }

  async putTarget(caller: Caller, id: string, target: Target): Promise<{ ok: true } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    const data = JSON.stringify(target);
    const existing = this.sql.exec<{ data: string }>("SELECT data FROM targets WHERE id = ?", id).toArray()[0];
    if (existing?.data === data) return { ok: true };
    if (!existing) {
      const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM targets").one().n;
      if (count >= maxTargets(this.env)) return { ok: false, status: 409, error: "too_many_targets" };
    }
    this.sql.exec(
      `INSERT INTO targets (id, kind, data, added) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, failures = 0`,
      id,
      target.kind,
      data,
      Date.now(),
    );
    return { ok: true };
  }

  /** Removes a target: its device stops receiving pushes, and may register again. */
  async deleteTarget(caller: Caller, id: string): Promise<{ ok: true } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    this.sql.exec("DELETE FROM targets WHERE id = ?", id);
    return { ok: true };
  }

  /**
   * Revokes a device (spec §8.1), whether or not it has a target: it loses its target and cannot register or
   * notify again with a token it holds. Revocations older than every token they guard against are pruned
   * here, so the list stays bounded by age.
   */
  async revokeDevice(caller: Caller, id: string): Promise<{ ok: true } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    const now = Date.now();
    this.sql.exec("DELETE FROM revoked WHERE at <= ?", now - REVOCATION_KEEP_MS);
    this.sql.exec("INSERT INTO revoked (id, at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at", id, now);
    this.sql.exec("DELETE FROM targets WHERE id = ?", id);
    return { ok: true };
  }

  /**
   * The account's deletion (the account service's erase token, never a device's): every target and revocation goes, and
   * a mark refuses every token of the account until the last one minted before the deletion has ended; then the alarm
   * clears the object. Again: the same answer.
   */
  async eraseAccount(owner: string): Promise<{ ok: true } | Refusal> {
    if (this.erasedAt() !== undefined) return { ok: true };
    if (!this.ownerMatches(owner)) return { ok: false, status: 403, error: "wrong_account" };
    const now = Date.now();
    this.sql.exec("DELETE FROM targets");
    this.sql.exec("DELETE FROM revoked");
    this.sql.exec("DELETE FROM meta WHERE k = 'owner'");
    this.sql.exec("INSERT INTO meta (k, v) VALUES ('erased', ?)", String(now));
    this.owner = undefined;
    await this.ctx.storage.setAlarm(now + ERASED_KEEP_MS);
    return { ok: true };
  }

  override async alarm(): Promise<void> {
    const at = this.erasedAt();
    if (at === undefined) return;
    if (Date.now() < at + ERASED_KEEP_MS) {
      await this.ctx.storage.setAlarm(at + ERASED_KEEP_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.owner = undefined;
    this.migrate();
  }

  async listTargets(caller: Caller): Promise<{ ok: true; targets: TargetInfo[] } | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    const targets = this.rows().map(({ id, target, added }) => {
      const info: TargetInfo = { id, kind: target.kind, added };
      if (target.kind === "apns") {
        info.env = target.env;
        info.app = target.app;
      } else if (target.kind === "fcm") info.app = target.app;
      else info.host = new URL(target.endpoint).host;
      return info;
    });
    return { ok: true, targets };
  }

  /**
   * Sends the count to the account's targets, content-free, and forgets the ones their push service says are gone.
   * `phones` (device ids; a target's id is its device's) is the computer's preference for which PHONES to wake, from which
   * app each is: the phones among them it holds a target for, and every phone when it holds none (the computer may not know
   * every phone the account has: `preferThenAll`, the one rule in packages/protocol push-routing.ts). Browsers are not phones
   * and get every push, as before.
   */
  async notify(caller: Caller, input: { badge: number; urgent: boolean; phones?: readonly string[] }): Promise<({ ok: true } & NotifyResult) | Refusal> {
    const refused = this.refuse(caller);
    if (refused) return refused;
    const now = Date.now();
    const payload = utf8(JSON.stringify({ n: input.badge }));
    const all = this.rows();
    const preferred = input.phones === undefined ? undefined : new Set(input.phones);
    const woken = preferred === undefined ? all.filter((r) => isPhone(r.target)) : preferThenAll(all.filter((r) => isPhone(r.target)), (r) => preferred.has(r.id));
    const rows = all.filter((r) => !isPhone(r.target) || woken.includes(r));
    const outcomes = await Promise.all(
      rows.map(async ({ target }): Promise<SendOutcome> => {
        try {
          // FCM has no credentials yet, so no target of its kind is ever registered (index.ts); one that is there anyway is not sent to.
          if (target.kind === "fcm") return { ok: false, gone: false, status: 0, reason: "not_configured" };
          return target.kind === "apns"
            ? await sendApns(apnsConfig(this.env), target, input.badge, now)
            : await sendWebPush(vapidConfig(this.env), target, payload, {
                urgent: input.urgent,
                now,
                ttlSeconds: TTL_SECONDS,
                timeoutMs: pushTimeoutMs(this.env),
              });
        } catch {
          return { ok: false, gone: false, status: 0, reason: "network" };
        }
      }),
    );
    const result: NotifyResult = { sent: 0, removed: 0, failed: 0 };
    outcomes.forEach((outcome, i) => {
      const row = rows[i]!;
      // Written only when something changes: a success after failures, a failure, a removal.
      if (outcome.ok) {
        result.sent += 1;
        if (row.failures > 0) this.sql.exec("UPDATE targets SET failures = 0 WHERE id = ?", row.id);
      } else if (outcome.gone || (outcome.suspect && row.failures + 1 >= SUSPECT_LIMIT)) {
        this.sql.exec("DELETE FROM targets WHERE id = ?", row.id);
        result.removed += 1;
      } else {
        if (outcome.suspect) this.sql.exec("UPDATE targets SET failures = failures + 1 WHERE id = ?", row.id);
        result.failed += 1;
      }
    });
    return { ok: true, ...result };
  }

  private rows(): { id: string; target: Target; added: number; failures: number }[] {
    return this.sql
      .exec<{ id: string; data: string; added: number; failures: number }>("SELECT id, data, added, failures FROM targets ORDER BY added")
      .toArray()
      .map((row) => ({ id: row.id, target: JSON.parse(row.data) as Target, added: row.added, failures: row.failures }));
  }
}
