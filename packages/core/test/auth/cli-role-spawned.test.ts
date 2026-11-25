// Lane XC, the reader's question on `moss device`: a process the daemon started, also one OUTSIDE the sandbox (the path a
// bot's approved command takes), that connects with the real harness token as the `cli` role is never the person, so it
// can't pair a device. A real daemon on a temp home, a real child started from the daemon's own process, the real socket:
// the child prints only the error code it got. A double-forked child (re-parented away) is caught by the daemon's
// subreaper on Linux; on macOS by its responsible process only when the daemon is its own (as `moss-core supervise`
// starts it), which a test process is not, so that case is Linux's here.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOSS_ERR } from "@waifucave/moss-protocol";
import { catalogPointDecl } from "../../../plugin-sdk/src/catalogs/index";
import { FileSecretStore } from "../../src/auth/secret-store";
import { Drivers } from "../../src/bots/tests/fixtures";
import { FakePluginRegistry } from "../../src/contracts/fakes/plugin-registry";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { MemoryNetwork } from "../../src/links/memory-wire";

setDefaultTimeout(90_000);

const running: RunningDaemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop();
});

const CALLER = join(import.meta.dir, "fixtures", "cli-caller.ts");

async function daemon(): Promise<RunningDaemon> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-xc-cli-")));
  const home = join(root, "home");
  const net = new MemoryNetwork();
  const d = await startDaemon({
    home, secrets: new FileSecretStore(join(home, "secrets.json")), agentProvider: null, appPeer: "none",
    links: { wire: (k) => net.endpoint(k.publicKey), handshake: null, publicTime: null, mainComputer: { watchSleep: false, monotonic: () => performance.now() }, watch: () => () => {}, self: { name: "Studio", os: "macos" } },
    parts: {
      userHome: join(root, "user"),
      bots: { registry: new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [] }), drivers: () => new Drivers().factory, defaultModel: () => ({ model: "winter-test/calls" }) },
      agents: false,
    },
  });
  running.push(d);
  await d.mossParts.ready;
  return d;
}

const env = (d: RunningDaemon, extra: Record<string, string> = {}) => ({ ...process.env, MOSS_TEST_SOCKET: d.socketPath, MOSS_TEST_TOKEN: d.tokens.harness, ...extra });

describe.skipIf(process.platform === "win32")("a process the daemon started never pairs a device as the person", () => {
  test("its own child, outside any sandbox, with the real harness token: no hello as the person, no device.pair.join", async () => {
    const d = await daemon();
    // Started from the daemon's own process (as the runtime starts a bot's approved command outside the sandbox).
    // Async: the daemon answers from this same process, so a blocking spawn would hold it.
    const child = Bun.spawn([process.execPath, CALLER], { env: env(d), stdout: "pipe", stderr: "ignore" });
    await child.exited;
    const said = (await new Response(child.stdout).text()).trim();
    expect(said).toBe(`hello:${MOSS_ERR.NOT_THE_USER}`);
  });

  test.if(process.platform === "linux")("a double-forked child, re-parented away from the daemon: caught by the subreaper, refused the same", async () => {
    const d = await daemon();
    const outFile = join(realpathSync(mkdtempSync(join(tmpdir(), "moss-xc-fork-"))), "said");
    await Bun.spawn([process.execPath, CALLER], { env: env(d, { MOSS_TEST_FORK: "1", MOSS_TEST_OUT: outFile }), stdout: "ignore", stderr: "ignore" }).exited;
    for (let i = 0; i < 200 && !existsSync(outFile); i++) await Bun.sleep(50);
    expect(readFileSync(outFile, "utf8")).toBe(`hello:${MOSS_ERR.NOT_THE_USER}`);
  });
});
