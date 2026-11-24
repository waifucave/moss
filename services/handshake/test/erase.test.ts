// The account's deletion at the handshake (services/accounts PROTOCOL.md, "Deleting the account"): only the account
// service's erase token wipes the account scope (its sealed records, waiting messages, the main-computer lease), a
// device's own token never does, an erase token does nothing else, and the account's tokens are refused after.

import { describe, expect, test } from "vitest";

import { HandshakeError } from "../client";
import { accountToken, box, client, worker } from "./helpers";

let accounts = 0;
const uniqueAccount = () => `acct-erase-${Date.now()}-${++accounts}`;
const device = (account: string, id: string) => client().account(() => accountToken({ account, device: id }));

async function refusal(promise: Promise<unknown>): Promise<HandshakeError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HandshakeError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

const wipe = async (token: string) =>
  worker(new Request("https://handshake.test/v1/accounts/self", { method: "DELETE", headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "203.0.113.9" } }));

describe("deleting the account", () => {
  test("an erase token wipes the account scope; the account's tokens are refused after", async () => {
    const account = uniqueAccount();
    const studio = device(account, "studio");
    const laptop = device(account, "laptop");
    await studio.putRecord("addr", "laptop", { gen: 1, box: box() });
    await laptop.sendMessage("studio", "dial", { box: box() });
    expect(await studio.lease("acquire")).toMatchObject({ holder: "studio" });

    expect((await wipe(await accountToken({ account, device: "account-erase", erase: true }))).status).toBe(204);
    expect((await refusal(laptop.get())).status).toBe(410);
    expect((await refusal(studio.inbox())).status).toBe(410);
    expect((await refusal(studio.putRecord("addr", "laptop", { gen: 2, box: box() }))).status).toBe(410);
    // Again: the same answer.
    expect((await wipe(await accountToken({ account, device: "account-erase", erase: true }))).status).toBe(204);
  });

  test("a device's own token can't wipe the account, and an erase token does nothing else", async () => {
    const account = uniqueAccount();
    const studio = device(account, "studio");
    await studio.putRecord("addr", "laptop", { gen: 1, box: box() });
    expect((await wipe(await accountToken({ account, device: "studio" }))).status).toBe(401);
    expect((await device(account, "laptop").get()).records).toHaveLength(1);
    const eraser = client().account(() => accountToken({ account, device: "account-erase", erase: true }));
    expect((await refusal(eraser.get())).status).toBe(401);
  });
});
