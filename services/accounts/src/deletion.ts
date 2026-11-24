// The account's deletion at the other services (PROTOCOL.md, "Deleting the account"). The account's object has already
// wiped its own rows and keeps only a mark that refuses every call of the account; this tells each other service to
// forget the account, with an erase token this service mints for itself (never for a device: `erase: true`, which a
// service takes on its account wipe alone and refuses everywhere else), then deletes the person's sign-in at the
// Supabase project. Each step is retried by the object's alarm until it is confirmed; the sign-in goes last, so the
// person's session still works to ask how far the deletion got until everything else is done.

import { b64u } from "../../shared/encoding";
import { fetchableUrl } from "../../shared/web";
import type { Env } from "./env";
import { signerFor } from "./keys";
import type { DeletionStep } from "./wire";

const TIMEOUT_MS = 10_000;
/** An erase token lives as long as an ordinary one; it is used at once. */
const ERASE_TOKEN_SECONDS = 300;
/** The token's `dev`: not a device id (lowercase base32 of 32 characters), so it can never be one. */
export const ERASE_DEVICE = "account-erase";

interface ServiceStep {
  /** Its place in `AUDIENCES` (hooks, push, handshake: the order the deploy renders them in): its token audience and,
   *  without a URL or a binding, its host. */
  index: number;
  path: string;
  url: keyof Pick<Env, "HOOKS_URL" | "PUSH_URL" | "HANDSHAKE_URL">;
  binding: keyof Pick<Env, "HOOKS_SERVICE" | "PUSH_SERVICE" | "HANDSHAKE_SERVICE">;
}

const SERVICES: Record<Exclude<DeletionStep, "sign-in">, ServiceStep> = {
  hooks: { index: 0, path: "/v1/account", url: "HOOKS_URL", binding: "HOOKS_SERVICE" },
  push: { index: 1, path: "/v1/account", url: "PUSH_URL", binding: "PUSH_SERVICE" },
  handshake: { index: 2, path: "/v1/accounts/self", url: "HANDSHAKE_URL", binding: "HANDSHAKE_SERVICE" },
};

const AUD_RE = /^[a-z0-9.-]{1,253}$/;

/**
 * Why this Worker can't finish an account's deletion, or undefined when it can: the sign-in's deletion needs the
 * project's URL and service-role key, and each service's wipe its audience. Checked before anything is deleted, so a
 * deletion never half-starts on a Worker that could never finish it (the request answers 503).
 */
export function deletionUnavailable(env: Pick<Env, "AUTH_URL" | "AUTH_SERVICE_ROLE_KEY" | "AUDIENCES">): string | undefined {
  if (!env.AUTH_SERVICE_ROLE_KEY) return "the sign-in project's service-role key isn't set";
  if (!env.AUTH_URL || !fetchableUrl(env.AUTH_URL)) return "the sign-in project's URL isn't set";
  const auds = (env.AUDIENCES ?? "").split(",").map((a) => a.trim());
  if (auds.length < 3 || auds.slice(0, 3).some((a) => !AUD_RE.test(a))) return "the three services' audiences aren't set";
  return undefined;
}

/** Runs one step; true once the service confirms it (or says there was nothing of the account to forget). */
export async function runDeletionStep(env: Env, account: string, step: DeletionStep): Promise<boolean> {
  try {
    return step === "sign-in" ? await deleteSignIn(env, account) : await wipeService(env, account, SERVICES[step]);
  } catch {
    return false;
  }
}

async function wipeService(env: Env, account: string, s: ServiceStep): Promise<boolean> {
  const aud = env.AUDIENCES.split(",").map((a) => a.trim())[s.index];
  if (!aud || !AUD_RE.test(aud)) return false;
  const binding = env[s.binding];
  const base = env[s.url] || `https://${aud}`;
  if (!binding && !fetchableUrl(base)) return false;
  const iat = Math.floor(Date.now() / 1000);
  const token = await signerFor(env).sign({
    iss: env.ISSUER, aud, sub: account, dev: ERASE_DEVICE, iat, exp: iat + ERASE_TOKEN_SECONDS,
    jti: b64u(crypto.getRandomValues(new Uint8Array(12))), erase: true,
  });
  const url = `${base.replace(/\/+$/, "")}${s.path}`;
  const init: RequestInit = { method: "DELETE", headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) };
  const res = binding ? await binding.fetch(url, init) : await fetch(url, init);
  await res.body?.cancel();
  return res.status === 204 || res.status === 200;
}

/** GoTrue's admin delete, with the project's service-role key: the person's email and sign-in identities go. */
async function deleteSignIn(env: Env, account: string): Promise<boolean> {
  const key = env.AUTH_SERVICE_ROLE_KEY;
  if (!key || !env.AUTH_URL || !fetchableUrl(env.AUTH_URL)) return false;
  const res = await fetch(`${env.AUTH_URL.replace(/\/+$/, "")}/auth/v1/admin/users/${encodeURIComponent(account)}`, {
    method: "DELETE",
    headers: { apikey: key, authorization: `Bearer ${key}` },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.body?.cancel();
  // 404: the project has no such user any more (deleted before, by this or by hand).
  return res.ok || res.status === 404;
}

/** When to try the pending steps again: soon at first, then less often, never longer than six hours apart. */
export function retryDelayMs(tries: number): number {
  const ladder = [60_000, 10 * 60_000, 3600_000];
  return ladder[tries] ?? 6 * 3600_000;
}
