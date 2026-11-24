// MOSS protocol: which phones a push wakes (spec §8, §10; the owner's decision of 2026-11-24: two phone apps per platform,
// MOSS for the bots and MOSS Code for sessions with coding agents, each paired on its own).
//
// This file is the one place the rule is written. It is pure (no imports that run), so the engine and the push service
// both use it:
//
//   * `appForPush`      which app an update belongs to: a bot's, or a coding or agent session's.
//   * `phonesToWake`    the engine's half: from the paired phones, the ones of that app and the ones that recorded
//                       none (and, with none of them, every paired phone rather than none). The ids go to the notifier in `NotifierUpdate.phones`.
//   * `preferThenAll`   the one fallback both halves use: the items that match, or all of them when none does. The push
//                       service uses it on the phones it holds targets for, since it may know phones this computer doesn't.
//
// It is a preference about WHERE a notification goes and nothing more. What a paired device may list or answer is the
// remote allow list's (generated from each method's `roles`) and the answer key's, and neither reads the app. Browsers
// are not phones: a web companion's push is not part of this rule, and keeps going to every browser.
// No imports on purpose: the push service (a Worker in services/push) reads this file by its path, and it must not pull
// the protocol's schemas into the Worker. The names below are the protocol's own (`PhoneApp` in devices.ts, `SessionKind`
// in common.ts), and `test/push-routing.test.ts` fails if either list moves without this one.
export type PushApp = "moss" | "code";
export type PushSessionKind = "bot" | "side-thread" | "agent" | "coding";

/** Which app an update's session belongs to: a bot's conversation and its side threads to MOSS, an agent session and a
 *  coding session to MOSS Code. */
export const APP_OF_SESSION_KIND: Readonly<Record<PushSessionKind, PushApp>> = {
  bot: "moss",
  "side-thread": "moss",
  agent: "code",
  coding: "code",
};

/** Where an update came from. `sessionKind` is the session's kind; `bot` is the bot an update names (a bot's own
 *  message, card or question, which the core sends without a session kind of its own). Neither: a plugin's notice. */
export interface PushOrigin {
  sessionKind?: PushSessionKind;
  bot?: string;
}

/** The app an update's push prefers; undefined for an update that belongs to neither (a plugin's notice), which goes to
 *  every phone. A session's kind wins over a bot it names: an agent a bot started is still a session of MOSS Code. */
export function appForPush(origin: PushOrigin): PushApp | undefined {
  if (origin.sessionKind !== undefined) return APP_OF_SESSION_KIND[origin.sessionKind];
  return origin.bot !== undefined ? "moss" : undefined;
}

/** The items for which `matches` holds; with none, all of them. The one fallback the routing rule has. */
export function preferThenAll<T>(items: readonly T[], matches: (item: T) => boolean): T[] {
  const preferred = items.filter(matches);
  return preferred.length > 0 ? preferred : [...items];
}

/** A paired phone as the engine's registry holds it. */
export interface PairedPhone {
  id: string;
  /** The app it paired as; absent when it recorded none (an old client, an account-added phone). */
  app?: PushApp;
  revokedAt?: number;
}

/**
 * The paired phones an update's push goes to, by device id; undefined when it goes to every phone.
 *   - an update with no app (a plugin's notice): undefined;
 *   - otherwise the unrevoked phones whose app is the update's, and the ones that recorded no app (an old client, a phone
 *     the account added: it keeps getting what it got before, so it counts as matching either app);
 *   - with none of those, the person's other phones rather than none;
 *   - with no phone at all, an empty list (the service still wakes phones it knows from the account, `preferThenAll`).
 */
export function phonesToWake(origin: PushOrigin, phones: readonly PairedPhone[]): string[] | undefined {
  const app = appForPush(origin);
  if (app === undefined) return undefined;
  const live = phones.filter((p) => p.revokedAt === undefined);
  return preferThenAll(live, (p) => p.app === undefined || p.app === app).map((p) => p.id);
}
