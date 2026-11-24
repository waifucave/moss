// The account's deletion at the forwarder (services/accounts PROTOCOL.md, "Deleting the account"): only the account
// service's erase token wipes the account (its computers' keys and names, its routines, the webhooks held for it, its
// sockets), a device's own token never does, an erase token does nothing else, and a token minted before the deletion
// can't put anything back while it lives.

import { describe, expect, it } from "vitest";

import { b64u } from "../../../plugins/moss/plugins/forwarder/src/wire/bytes";
import { accountToken, apiCall, openSocket, postHook, registerComputer, registeredRoutine, uniqueAccount } from "./helpers";

const erase = (account: string) => accountToken({ account, device: "account-erase", extra: { erase: true } });

describe("deleting the account", () => {
  it("an erase token wipes computers, routines and held webhooks; old tokens and routine keys are refused after", async () => {
    const account = uniqueAccount();
    const computer = await registerComputer(account, "studio");
    const routine = await registeredRoutine(computer, "nightly");
    // Held while nothing is connected.
    expect((await postHook(routine.url, routine.key, JSON.stringify({ secret: "payload" }))).status).toBeLessThan(300);

    expect((await apiCall(await erase(account), "DELETE", "/v1/account")).status).toBe(204);

    expect((await apiCall(computer.token, "GET", "/v1/devices")).status).toBe(410);
    expect((await apiCall(computer.token, "GET", "/v1/routines")).status).toBe(410);
    expect((await apiCall(computer.token, "PUT", "/v1/devices/self", { encKey: b64u(computer.key.publicKey), name: "back" })).status).toBe(410);
    // The routine's address no longer takes webhooks.
    expect((await postHook(routine.url, routine.key, "{}")).status).toBeGreaterThanOrEqual(400);
    // Again: the same answer.
    expect((await apiCall(await erase(account), "DELETE", "/v1/account")).status).toBe(204);
  });

  it("closes the account's open sockets", async () => {
    const account = uniqueAccount();
    const computer = await registerComputer(account, "studio");
    const socket = await openSocket(computer);
    expect((await apiCall(await erase(account), "DELETE", "/v1/account")).status).toBe(204);
    await socket.until(() => socket.closed !== null, 5000, "close");
  });

  it("a device's own token can't wipe the account, and an erase token does nothing else", async () => {
    const account = uniqueAccount();
    const computer = await registerComputer(account, "studio");
    expect((await apiCall(computer.token, "DELETE", "/v1/account")).status).toBe(401);
    expect((await apiCall(computer.token, "GET", "/v1/devices")).status).toBe(200);
    const token = await erase(account);
    expect((await apiCall(token, "GET", "/v1/devices")).status).toBe(401);
    expect((await apiCall(token, "DELETE", "/v1/devices/studio")).status).toBe(401);
    expect((await apiCall(token, "POST", "/v1/tickets")).status).toBe(401);
  });
});
