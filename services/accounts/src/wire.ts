// The account service's wire (PROTOCOL.md): lane H's proposal in the core's identity/account.ts, as built here. The
// statements must stay byte-for-byte what H's AccountClient signs.

import { utf8 } from "../../shared/encoding";

/** The fields of a registration the device signs, each as the request carries it. */
export interface RegisterFields {
  id: string;
  publicKey: string;
  boxKey: string;
  name: string;
  kind: string;
  os?: string;
}

// Keeps its old spelling on purpose: data already on disk (paired devices, sealed boxes, signed records) was made under this value, so it stays. No service is deployed.
/**
 * A registration's statement: lane H's `clover-account-v2 register`, the deterministic CBOR array (the core's
 * links/codec) of the account, every field of the device as sent (`os` null when absent) and `t`. Binding the
 * box key and the record means a session holder can't re-send a device's signature with another box key.
 */
export const registerStatement = (account: string, d: RegisterFields, t: number): Uint8Array =>
  cborArray(["clover-account-v2 register", account, d.id, d.publicKey, d.boxKey, d.name, d.kind, d.os ?? null, t]);

// Keeps its old spelling on purpose: data already on disk (paired devices, sealed boxes, signed records) was made under this value, so it stays. No service is deployed.
export const mintStatement = (account: string, audience: string, device: string, t: number): Uint8Array =>
  utf8(["clover-account-v1 mint", account, audience, device, String(t)].join("\n"));

/**
 * The account's deletion (PROTOCOL.md, "Deleting the account"): the deterministic CBOR of
 * `["moss-account-v1 delete", account, device, t]`, signed by a listed device that isn't revoked. Its own purpose tag,
 * so no registration's or mint's signature can pass as one.
 */
export const deleteStatement = (account: string, device: string, t: number): Uint8Array => cborArray(["moss-account-v1 delete", account, device, t]);

/** A device leaving the account at sign-out (PROTOCOL.md, "Leaving"): `["moss-account-v1 leave", account, device, t]`. */
export const leaveStatement = (account: string, device: string, t: number): Uint8Array => cborArray(["moss-account-v1 leave", account, device, t]);

/**
 * The deterministic CBOR (RFC 8949, shortest heads) of an array of text strings, nulls and non-negative safe
 * integers: the subset a statement uses, encoded as the core's links/codec encodes it.
 */
export function cborArray(items: readonly (string | number | null)[]): Uint8Array {
  const out: number[] = [];
  const head = (major: number, n: number) => {
    const m = major << 5;
    if (n < 24) out.push(m | n);
    else if (n < 0x100) out.push(m | 24, n);
    else if (n < 0x10000) out.push(m | 25, n >> 8, n & 0xff);
    else if (n < 0x100000000) out.push(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    else {
      const big = BigInt(n);
      out.push(m | 27);
      for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((big >> shift) & 0xffn));
    }
  };
  head(4, items.length);
  for (const item of items) {
    if (item === null) out.push(0xf6);
    else if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || item < 0) throw new RangeError("a statement's numbers are non-negative integers");
      head(0, item);
    } else {
      const bytes = utf8(item); // TextEncoder writes a lone surrogate as U+FFFD, as toWellFormed() does in the core
      head(3, bytes.length);
      for (const b of bytes) out.push(b);
    }
  }
  return Uint8Array.from(out);
}

/** The device kinds and systems of the protocol's `DeviceKind` and `Os` (packages/protocol). */
export const DEVICE_KINDS = ["desktop", "server", "cloud", "phone", "browser"] as const;
export const OSES = ["macos", "windows", "linux"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export type Os = (typeof OSES)[number];

/** A device id as lane B's `deviceIdFor` makes it: lowercase base32 of 20 bytes. */
export const DEVICE_ID_RE = /^[a-z2-7]{32}$/;
/** A Supabase user id (the account): what the services accept as `sub`. */
export const ACCOUNT_RE = /^[\x21-\x7e]{1,128}$/;
/** An Ed25519 signature, 64 bytes, base64url. */
export const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

export const LIMITS = {
  /** How far a statement's `t` (ms) may be from the service's clock. */
  statementWindowMs: 10 * 60_000,
  /** The longest an account token lives (the core refuses longer: `ACCOUNT_TOKEN_MAX_MS`). */
  maxTokenSeconds: 300,
  /** Devices an account may have that aren't revoked, and rows kept with the revoked ones. */
  maxDevices: 64,
  maxRows: 256,
  /** A device name, in code points. */
  maxName: 64,
  maxBodyBytes: 16 * 1024,
  /** How long a revoked device's whole row (name, keys, kind, system) is kept: long enough for every device of the
   *  account that was away to learn of the revoke at its next sync. After it only the id and the time are kept
   *  (`revoked_ids`), which is what refuses the device's key if it tries to register again. */
  revokedRowKeepMs: 30 * 24 * 3600_000,
  /** Revoked ids kept per account; past it the oldest is forgotten first. */
  maxRevokedIds: 1024,
} as const;

export interface AccountDevice {
  id: string;
  /** The device's Ed25519 link key, standard base64 (as the core's DeviceKey gives it). */
  publicKey: string;
  /** Its X25519 key for the handshake's account-scope boxes, base64url. */
  boxKey: string;
  name: string;
  kind: DeviceKind;
  os?: Os;
  addedAt: number;
  revokedAt?: number;
}

/** What the account's deletion still has to do (PROTOCOL.md, "Deleting the account"), in the order it does it. */
export const DELETION_STEPS = ["hooks", "push", "handshake", "sign-in"] as const;
export type DeletionStep = (typeof DELETION_STEPS)[number];

export interface DeletionView {
  /** When the deletion was asked for (ms). Everything of the account at this service went then. */
  deletedAt: number;
  /** The steps not confirmed yet; the service retries them on its own until each is. */
  pending: DeletionStep[];
}

/** Lane B's `deviceIdFor` (packages/core/src/contracts/device-registry.ts), which the id must equal. */
export async function deviceIdFor(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey as Uint8Array<ArrayBuffer>)).slice(0, 20);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
