// push.waifucave.com: waifucave push (spec §10). The user's computer (the moss/push notifier) sends a count;
// this service sends an empty "you have N updates" through Apple to the account's phones and through Web Push
// to its browsers. It never receives content: there is none to receive.
//
//   GET    /v1/vapid                                   -> { publicKey }            for browsers to subscribe
//   PUT    /v1/targets/self  ApnsTarget | FcmTarget | WebPushTarget -> 204         a phone or browser registers itself
//                            (a phone names its app, `moss` or `code`: its APNs topic; FCM is refused, `not_configured`, until it has credentials)
//   DELETE /v1/targets/:id                             -> 204                     stops pushes to that target
//   GET    /v1/targets                                 -> { targets }
//   DELETE /v1/devices/:id                             -> 204                     revokes a device (any id, 24 h 10 min)
//   POST   /v1/notify        { badge, urgent?, phones? } -> { sent, removed, failed }   phones: device ids of the phones to wake first
//   DELETE /v1/account                                 -> 204                     the account's deletion: everything here goes
//
// All but /v1/vapid take the device's waifucave account token; DELETE /v1/account takes only the account service's erase
// token (services/accounts PROTOCOL.md, "Deleting the account"), which nothing else takes.

import { bearerToken } from "../../shared/account-token";
import { verifyAccountTokenFrom, verifyEraseTokenFrom } from "../../shared/jwks";
import { b64u, fromB64u, sha256, utf8 } from "../../shared/encoding";
import { errorResponse, json, readJsonObject } from "../../shared/http";
import { APNS_TOKEN_RE } from "./apns";
import { FCM_TOKEN_RE, fcmConfig } from "./fcm";
import type { Caller, PushDO, Target } from "./push-do";
import type { Env } from "./env";
import { allowedEndpoint, usableSubscriptionKey, vapidPublicKey } from "./webpush";

export { PushDO } from "./push-do";

const TARGET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return serve(request, env);
  },
} satisfies ExportedHandler<Env>;

async function serve(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.split("/").slice(1);
    if (path[0] !== "v1") return errorResponse(404, "not_found");
    if (request.method === "GET" && path.length === 2 && path[1] === "vapid") {
      return json({ publicKey: vapidPublicKey({ subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: "" }) }, 200, {
        "cache-control": "public, max-age=3600",
      });
    }
    return await authenticated(request, env, path.slice(1));
  } catch (err) {
    console.error(`push: unhandled ${err instanceof Error ? err.name : "error"}`);
    return errorResponse(500, "internal");
  }
}

async function accountObject(env: Env, account: string): Promise<DurableObjectStub<PushDO>> {
  return env.PUSH.getByName(b64u(await sha256(utf8(`push-account|${account}`))));
}

async function authenticated(request: Request, env: Env, path: string[]): Promise<Response> {
  if (request.method === "DELETE" && path.length === 1 && path[0] === "account") return eraseAccount(request, env);
  const token = bearerToken(request);
  const identity = token
    ? await verifyAccountTokenFrom(token, env, env.PUSH_AUDIENCE)
    : null;
  if (!identity) return errorResponse(401, "unauthorized");
  const caller: Caller = { owner: b64u(await sha256(utf8(`owner|${identity.account}`))), device: identity.device };
  const stub = await accountObject(env, identity.account);
  const route = `${request.method} ${path[0] ?? ""}${path.length > 1 ? "/:id" : ""}`;
  const id = path[1] ?? "";
  if (path.length > 2) return errorResponse(404, "not_found");

  switch (route) {
    case "POST notify": {
      const { success } = await env.NOTIFY_RATE.limit({ key: identity.account });
      if (!success) return errorResponse(429, "rate_limited", {}, { "retry-after": "60" });
      const body = await readJsonObject(request);
      const badge = body?.badge;
      if (typeof badge !== "number" || !Number.isInteger(badge) || badge < 0 || badge > 99_999) return errorResponse(400, "bad_request");
      const phones = parsePhones(body?.phones);
      if (phones === null) return errorResponse(400, "bad_request");
      const result = await stub.notify(caller, { badge, urgent: body?.urgent === true, ...(phones ? { phones } : {}) });
      if (!result.ok) return errorResponse(result.status, result.error);
      return json({ sent: result.sent, removed: result.removed, failed: result.failed });
    }
    case "PUT targets/:id": {
      if (id !== "self") return errorResponse(404, "not_found");
      const { success } = await env.API_RATE.limit({ key: identity.account });
      if (!success) return errorResponse(429, "rate_limited", {}, { "retry-after": "60" });
      const target = await parseTarget(await readJsonObject(request), env);
      if (!target) return errorResponse(400, "bad_target");
      // No FCM credentials exist yet: a well-formed Android target is refused as what it is, never stored.
      if (target.kind === "fcm" && fcmConfig(env) === null) return errorResponse(503, "not_configured");
      const result = await stub.putTarget(caller, identity.device, target);
      return result.ok ? new Response(null, { status: 204 }) : errorResponse(result.status, result.error);
    }
    case "DELETE targets/:id": {
      const target = id === "self" ? identity.device : id;
      if (!TARGET_ID_RE.test(target)) return errorResponse(404, "not_found");
      if (!(await env.API_RATE.limit({ key: identity.account })).success) return errorResponse(429, "rate_limited", {}, { "retry-after": "60" });
      const result = await stub.deleteTarget(caller, target);
      return result.ok ? new Response(null, { status: 204 }) : errorResponse(result.status, result.error);
    }
    case "GET targets": {
      if (!(await env.API_RATE.limit({ key: identity.account })).success) return errorResponse(429, "rate_limited", {}, { "retry-after": "60" });
      const result = await stub.listTargets(caller);
      return result.ok ? json({ targets: result.targets }) : errorResponse(result.status, result.error);
    }
    case "DELETE devices/:id": {
      if (!TARGET_ID_RE.test(id)) return errorResponse(404, "not_found");
      if (!(await env.API_RATE.limit({ key: identity.account })).success) return errorResponse(429, "rate_limited", {}, { "retry-after": "60" });
      const result = await stub.revokeDevice(caller, id);
      return result.ok ? new Response(null, { status: 204 }) : errorResponse(result.status, result.error);
    }
    default:
      return errorResponse(404, "not_found");
  }
}

/** The account's deletion, on the account service's erase token alone. */
async function eraseAccount(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  const identity = token ? await verifyEraseTokenFrom(token, env, env.PUSH_AUDIENCE) : null;
  if (!identity) return errorResponse(401, "unauthorized");
  const stub = await accountObject(env, identity.account);
  const result = await stub.eraseAccount(b64u(await sha256(utf8(`owner|${identity.account}`))));
  return result.ok ? new Response(null, { status: 204 }) : errorResponse(result.status, result.error);
}

/** `phones` on a notify: absent (no preference), or a short list of device ids; null when it is anything else. */
function parsePhones(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) return null;
  for (const id of value) if (typeof id !== "string" || !TARGET_ID_RE.test(id)) return null;
  return value as string[];
}

/**
 * A phone's APNs token or FCM registration token (each with the phone app it belongs to, `moss` or `code`), or a
 * browser's Web Push subscription; anything else, a push host not listed, or a key
 * that is not on P-256 (which would fail every notify) is refused.
 */
async function parseTarget(body: Record<string, unknown> | null, env: Env): Promise<Target | null> {
  if (!body) return null;
  if (body.kind === "apns") {
    const token = typeof body.token === "string" ? body.token.toLowerCase() : "";
    if (!APNS_TOKEN_RE.test(token)) return null;
    if (body.env !== "production" && body.env !== "sandbox") return null;
    if (body.app !== "moss" && body.app !== "code") return null;
    return { kind: "apns", token, env: body.env, app: body.app };
  }
  if (body.kind === "fcm") {
    const token = typeof body.token === "string" ? body.token : "";
    if (!FCM_TOKEN_RE.test(token)) return null;
    if (body.app !== "moss" && body.app !== "code") return null;
    return { kind: "fcm", token, app: body.app };
  }
  if (body.kind === "webpush") {
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const keys = (body.keys ?? {}) as Record<string, unknown>;
    if (!allowedEndpoint(endpoint, env.WEBPUSH_HOSTS)) return null;
    let p256dh: Uint8Array;
    let auth: Uint8Array;
    try {
      p256dh = fromB64u(String(keys.p256dh ?? ""));
      auth = fromB64u(String(keys.auth ?? ""));
    } catch {
      return null;
    }
    if (p256dh.length !== 65 || p256dh[0] !== 0x04 || auth.length !== 16) return null;
    if (!(await usableSubscriptionKey(p256dh))) return null;
    return { kind: "webpush", endpoint, p256dh: b64u(p256dh), auth: b64u(auth) };
  }
  return null;
}
