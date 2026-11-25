// What the push fakes (test/node/fakes.ts) record of each request, as the tests read it back.

/** The device tokens the fake APNs treats as MOSS Code's (`apnsToken("c0de")`); every other one is MOSS's. A real token is one bundle id's. */
export const CODE_TOKEN_PREFIX = "c0de";

export interface FakeLogEntry {
  service: "apns" | "webpush" | "unexpected";
  url: string;
  status: number;
  token?: string;
  env?: string;
  topic?: string;
  pushType?: string;
  priority?: string;
  collapseId?: string;
  payload?: unknown;
  providerToken?: string;
  subscription?: string;
  ttl?: string;
  urgency?: string;
  topicHeader?: string;
  decrypted?: unknown;
  vapidSub?: string;
  vapidAud?: string;
  error?: string;
}
