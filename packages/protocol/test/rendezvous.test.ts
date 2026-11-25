import { expect, test } from "bun:test";
import { engineEndpoint } from "../src/rendezvous";

test("off Windows, and for a path that is no pipe, the endpoint is the endpoint (nothing is asked)", async () => {
  expect(await engineEndpoint("/run/core.sock", { platform: "darwin" })).toBe("/run/core.sock");
  expect(await engineEndpoint("\\\\.\\pipe\\moss-core-x", { platform: "linux" })).toBe("\\\\.\\pipe\\moss-core-x");
  expect(await engineEndpoint("C:\\run\\core.sock", { platform: "win32" })).toBe("C:\\run\\core.sock");
});

test("on Windows a pipe nobody serves is an error, not the old way", async () => {
  await expect(engineEndpoint("\\\\.\\pipe\\moss-core-nobody-serves-this", { platform: "win32", timeoutMs: 500 })).rejects.toBeDefined();
});
