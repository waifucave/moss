// Firebase Cloud Messaging, for Android phones' MOSS and MOSS Code apps. Not configured: no FCM credentials exist yet, so a
// target of this kind is accepted in shape and refused at registration (`not_configured`), and nothing is ever sent to one.
// When the credentials exist, `fcmConfig` returns them from the environment together with the sender that uses them (the
// way `apns.ts` has `ApnsConfig` and `sendApns`), and the refusal in index.ts lifts with it.
//
// The shape is the existing kinds': a registration token the phone's app holds, and the phone app it belongs to (a token is
// one Firebase app's, as an APNs token is one bundle id's).
import type { PushApp } from "../../../packages/protocol/src/push-routing";
import type { Env } from "./env";

export interface FcmTarget {
  /** The app's FCM registration token. */
  token: string;
  app: PushApp;
}

/** What a registration token looks like: URL-safe characters and the `:` of its id, a hundred characters or more. */
export const FCM_TOKEN_RE = /^[A-Za-z0-9_:-]{100,4096}$/;

export interface FcmConfig {
  projectId: string;
}

/** The FCM credentials, or null while there are none (always, for now). */
export function fcmConfig(_env: Env): FcmConfig | null {
  return null;
}
