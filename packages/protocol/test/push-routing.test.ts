// Which phones a push wakes (push-routing.ts): the one rule, as a table, and the checks that its import-free copies of the
// protocol's names still are the protocol's names.
import { describe, expect, test } from "bun:test";
import { DeviceKind, PHONE_APPS, PhoneApp, DeviceView } from "../src/devices";
import { ClientKind, DeviceOs, SessionKind, isComputerOs } from "../src/common";
import { WINDOW_PROGRAMS } from "../src/surfaces";
import { MOSS_METHODS, allowedMethods } from "../src/moss";
import { APP_OF_SESSION_KIND, appForPush, phonesToWake, preferThenAll, type PairedPhone, type PushApp, type PushOrigin, type PushSessionKind } from "../src/push-routing";

describe("push-routing's names are the protocol's", () => {
  test("the phone apps are the programs that have windows (devices.ts and surfaces.ts)", () => {
    expect([...PHONE_APPS]).toEqual([...WINDOW_PROGRAMS]);
    expect(PhoneApp.options).toEqual(["moss", "code"]);
    // Type-level: the import-free names accept each other's values.
    const app: PushApp = PhoneApp.parse("code");
    expect(app).toBe("code");
  });

  test("every session kind has an app, and the table lists no other", () => {
    expect(Object.keys(APP_OF_SESSION_KIND).sort()).toEqual([...SessionKind.options].sort());
    const kinds: PushSessionKind[] = [...SessionKind.options];
    expect(kinds.length).toBe(4);
    for (const k of kinds) expect(PHONE_APPS).toContain(APP_OF_SESSION_KIND[k]);
  });
});

const A = "a".repeat(20);
const B = "b".repeat(20);
const C = "c".repeat(20);
const phone = (id: string, app?: PushApp, revokedAt?: number): PairedPhone => ({ id, ...(app ? { app } : {}), ...(revokedAt === undefined ? {} : { revokedAt }) });

describe("appForPush: which app an update belongs to", () => {
  const table: [string, PushOrigin, PushApp | undefined][] = [
    ["a bot's own update (a message, card or question: a bot, no session kind)", { bot: "luna" }, "moss"],
    ["a bot's conversation", { sessionKind: "bot", bot: "luna" }, "moss"],
    ["a bot's side thread", { sessionKind: "side-thread", bot: "luna" }, "moss"],
    ["a coding session", { sessionKind: "coding" }, "code"],
    ["an agent session", { sessionKind: "agent" }, "code"],
    ["an agent session a bot started is still MOSS Code's", { sessionKind: "agent", bot: "luna" }, "code"],
    ["a plugin's notice: neither", {}, undefined],
  ];
  for (const [name, origin, app] of table) test(name, () => expect(appForPush(origin)).toBe(app));
});

describe("phonesToWake: the paired phones a push goes to", () => {
  const table: [string, PushOrigin, PairedPhone[], string[] | undefined][] = [
    ["a bot's update goes to the MOSS phones", { bot: "luna" }, [phone(A, "moss"), phone(B, "code")], [A]],
    ["a coding session's goes to the MOSS Code phones", { sessionKind: "coding" }, [phone(A, "moss"), phone(B, "code")], [B]],
    ["an agent session's goes to the MOSS Code phones", { sessionKind: "agent" }, [phone(A, "moss"), phone(B, "code")], [B]],
    ["two phones of the matching app both get it", { bot: "luna" }, [phone(A, "moss"), phone(B, "moss"), phone(C, "code")], [A, B]],
    ["no phone of the matching app: the other phones rather than none", { sessionKind: "coding" }, [phone(A, "moss")], [A]],
    ["no phone of the matching app, two others", { bot: "luna" }, [phone(A, "code"), phone(B, "code")], [A, B]],
    ["a phone that recorded no app matches either app: it gets a coding session's update beside the MOSS Code phone", { sessionKind: "coding" }, [phone(A, "moss"), phone(B), phone(C, "code")], [B, C]],
    ["a phone that recorded no app matches either app: it gets a bot's update beside the MOSS phone", { bot: "luna" }, [phone(A), phone(B, "moss"), phone(C, "code")], [A, B]],
    ["a phone with no app and a phone of the other app only: the first still gets it", { sessionKind: "coding" }, [phone(A, "moss"), phone(B)], [B]],
    ["a revoked phone with no app is still left out", { bot: "luna" }, [phone(A, undefined, 3), phone(B, "moss")], [B]],
    ["only phones with no app: all of them", { bot: "luna" }, [phone(A), phone(B)], [A, B]],
    ["a revoked phone of the matching app is left out, so the other phones get it", { bot: "luna" }, [phone(A, "moss", 5), phone(B, "code")], [B]],
    ["a revoked phone is never woken, matching or not", { sessionKind: "coding" }, [phone(A, "code", 5), phone(B, "code"), phone(C, "moss", 7)], [B]],
    ["every phone revoked: nobody", { bot: "luna" }, [phone(A, "moss", 5)], []],
    ["no phone at all: an empty list (the service wakes the account's phones it knows)", { bot: "luna" }, [], []],
    ["a plugin's notice: every phone, so no list", {}, [phone(A, "moss"), phone(B, "code")], undefined],
  ];
  for (const [name, origin, phones, want] of table) test(name, () => expect(phonesToWake(origin, phones)).toEqual(want));

  test("it never reads or changes what it is given", () => {
    const phones = Object.freeze([Object.freeze(phone(A, "moss")), Object.freeze(phone(B, "code"))]);
    expect(phonesToWake({ sessionKind: "coding" }, phones)).toEqual([B]);
  });
});

describe("preferThenAll", () => {
  test("the matches; with none, a copy of all; never an empty list for a non-empty one", () => {
    expect(preferThenAll([1, 2, 3, 4], (n) => n % 2 === 0)).toEqual([2, 4]);
    const all = [1, 3];
    const none = preferThenAll(all, (n) => n % 2 === 0);
    expect(none).toEqual([1, 3]);
    expect(none).not.toBe(all);
    expect(preferThenAll([], () => true)).toEqual([]);
  });
});

describe("Android, and the app on a device's view", () => {
  test("android is a client kind and a phone's OS, and no computer's", () => {
    expect(ClientKind.options).toEqual(["app", "cli", "ios", "android", "web"]);
    expect(DeviceOs.safeParse("android").success).toBe(true);
    expect(isComputerOs("android")).toBe(false);
    expect(DeviceKind.safeParse("phone").success).toBe(true);
  });

  test("a device view takes an app of the two and no other", () => {
    expect(DeviceView.shape.app.safeParse("moss").success).toBe(true);
    expect(DeviceView.shape.app.safeParse("code").success).toBe(true);
    expect(DeviceView.shape.app.safeParse("host").success).toBe(false);
    expect(DeviceView.shape.app.safeParse(undefined).success).toBe(true);
  });
});

describe("routing moved no allow list", () => {
  test("the remote role's methods are the ones its methods' `roles` give, and card.list/get/answer stay on it", () => {
    const remote = allowedMethods("remote");
    for (const m of ["card.list", "card.get", "card.answer"]) expect([m, remote.has(m)]).toEqual([m, true]);
    // No method names a phone app: the app is recorded data, not a role.
    for (const spec of MOSS_METHODS.values()) expect(JSON.stringify(spec.roles)).not.toMatch(/"(moss|code)"/);
  });
});
