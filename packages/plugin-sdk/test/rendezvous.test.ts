import { expect, test } from "bun:test";
import { RENDEZVOUS_REQUEST as protocolRequest, engineEndpoint as protocolEndpoint } from "../../protocol/src/rendezvous";
import { RENDEZVOUS_REQUEST, engineEndpoint } from "../src/rendezvous";

test("the plugin SDK's rendezvous dial speaks the protocol package's request, byte for byte", () => {
  expect(RENDEZVOUS_REQUEST).toBe(protocolRequest);
  expect(JSON.parse(RENDEZVOUS_REQUEST)).toEqual({ jsonrpc: "2.0", id: 1, method: "protocol.rendezvous" });
});

test("off Windows, and for a path that is no pipe, the endpoint is the endpoint, like the protocol package's", async () => {
  for (const [path, platform] of [["/run/core.sock", "darwin"], ["\\\\.\\pipe\\x", "linux"], ["C:\\run\\core.sock", "win32"]] as const) {
    expect(await engineEndpoint(path, { platform })).toBe(path);
    expect(await protocolEndpoint(path, { platform })).toBe(path);
  }
});
