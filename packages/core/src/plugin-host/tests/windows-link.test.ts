// The plugin host's link on Windows is a named pipe the daemon listens on (launch.ts): owner-only, and taken only from the host process it
// started. A process that connects first (this one, and another) is closed without being served, and the real host still gets its link.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHostProcess } from "../launch";
import { pipeDaclSddl } from "../../platform/win-pipe";

const windows = process.platform === "win32";

describe.skipIf(!windows)("the plugin host's link on Windows", () => {
  test("a connection that is not the host is closed, and the host that is still gets its link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-hostlink-"));
    const go = join(dir, "go");
    // The host stand-in: prints the pipe's name, waits for `go`, then connects and sends one notification.
    const hostScript = `
      const fs = require("fs");
      console.log("LINK=" + process.env.MOSS_HOST_LINK);
      const wait = () => fs.existsSync(${JSON.stringify(go)}) ? connect() : setTimeout(wait, 50);
      async function connect() {
        const s = await Bun.connect({ unix: process.env.MOSS_HOST_LINK, socket: { data() {}, close() { process.exit(0); } } });
        s.write(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: { from: "the host" } }) + "\\n");
        setTimeout(() => process.exit(0), 6000);
      }
      wait();
    `;
    const seen: string[] = [];
    let name = "";
    const p = spawnHostProcess({ cmd: [process.execPath, "-e", hostScript], env: process.env as Record<string, string>, onOutput: (l) => { if (l.startsWith("LINK=")) name = l.slice(5); else seen.push(l); } });
    try {
      const told = new Promise<unknown>((res) => p.peer.handle("hello", (params) => { res(params); return undefined; }));
      for (let i = 0; i < 100 && name === ""; i++) await Bun.sleep(50);
      expect(name).toMatch(/^\\\\\.\\pipe\\moss-host-[0-9a-f]{32}$/);
      // The pipe is the user's and SYSTEM's alone (the DACL protected: no Everyone, no Authenticated Users).
      const sddl = pipeDaclSddl(name, "server") ?? "";
      expect(sddl).toMatch(/^D:P/);
      expect(sddl).not.toMatch(/;WD\)|;AU\)|;BU\)/);
      // 1. This process (the daemon's own pid, not the host's) connects first: closed, and sent nothing back.
      const closed = (script: string) => new Promise<string>((res) => {
        let got = "";
        Bun.connect({ unix: name, socket: { data(_s, d) { got += Buffer.from(d).toString(); }, close() { res(got); }, error() { res(got); }, open(s) { s.write("{\"jsonrpc\":\"2.0\",\"method\":\"hello\",\"params\":{\"from\":\"" + script + "\"}}\n"); } } }).catch(() => res(got));
      });
      expect(await Promise.race([closed("this process"), Bun.sleep(5000).then(() => "(still open)")])).toBe("");
      // 2. Another process connects first: closed too.
      const other = Bun.spawn([process.execPath, "-e", `Bun.connect({ unix: ${JSON.stringify(name)}, socket: { data() {}, open(s) { s.write('{"jsonrpc":"2.0","method":"hello","params":{"from":"another process"}}\\n'); }, close() { console.log("closed"); process.exit(0); }, error() { console.log("closed"); process.exit(0); } } }).catch(() => { console.log("closed"); process.exit(0); }); setTimeout(() => { console.log("still open"); process.exit(0); }, 5000);`], { stdout: "pipe" });
      expect((await new Response(other.stdout).text()).trim()).toBe("closed");
      // Neither of them was taken for the host: nothing was told.
      expect(await Promise.race([told, Bun.sleep(300).then(() => "(nothing)")])).toBe("(nothing)");
      // 3. The real host connects now and is the link.
      writeFileSync(go, "");
      expect(existsSync(go)).toBe(true);
      expect(await Promise.race([told, Bun.sleep(8000).then(() => "(no link)")])).toEqual({ from: "the host" });
    } finally {
      p.kill();
    }
  }, 40_000);
});
