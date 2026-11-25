// `moss device` (device-cli.ts) over a fake daemon connection: the words are typed or nothing is confirmed.
import { describe, expect, test } from "bun:test";
import { runDevice, typedWords, type DeviceConn } from "./device-cli";

const WORDS = ["amber", "river", "stone", "cloud"];

/** A daemon that answers as the engine does for the `cli` role, and says the pairing's steps as events. */
function fakeDaemon(o: { joinWords?: boolean; end?: "done" | "failed" } = {}) {
  const calls: { method: string; params: unknown }[] = [];
  let listener: (ev: Record<string, unknown>) => void = () => {};
  const say = (ev: Record<string, unknown>) => queueMicrotask(() => listener(ev));
  const conn: DeviceConn & { closed: boolean } = {
    closed: false,
    onEvent: (fn) => { listener = fn; },
    close() { this.closed = true; },
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      switch (method) {
        case "events.subscribe": return {} as T;
        case "device.pair.begin":
          say({ type: "pairing_changed", pairingId: "p1", step: "words", words: WORDS, peerName: "Studio‮" });
          return { pairingId: "p1", code: "ABCD-EFGH", qr: "moss-pair:xyz" } as T;
        case "device.pair.join": return { pairingId: "p2", ...(o.joinWords === false ? {} : { words: WORDS }) } as T;
        case "device.pair.confirm": {
          const id = (params as { pairingId: string }).pairingId;
          say({ type: "pairing_changed", pairingId: id, step: o.end ?? "done", ...(o.end === "failed" ? { reason: "refused" } : {}) });
          return { applied: true } as T;
        }
        case "device.pair.cancel": return { ok: true } as T;
        case "device.list": return { devices: [{ id: "d1", name: "Server", isThis: true }, { id: "d2", name: "Laptop" }] } as T;
        case "device.revoke": return { applied: true } as T;
        default: throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { conn, calls };
}

const io = (answers: (string | undefined)[], printed: string[] = []) => ({
  printed,
  print: (l: string) => printed.push(l),
  ask: async () => answers.shift(),
  waitMs: 2_000,
});

describe("moss device pair", () => {
  test("begins, prints the code and the payload to join with, and confirms only with the words typed", async () => {
    const d = fakeDaemon();
    const out = io(["Amber river, STONE-cloud"]);
    const r = await runDevice(["pair"], d.conn, out);
    expect(r).toEqual({ code: 0, output: "paired" });
    expect(out.printed.join("\n")).toContain("Pairing code: ABCD-EFGH");
    expect(out.printed.join("\n")).toContain("moss device pair --join 'moss-pair:xyz'");
    expect(out.printed.join("\n")).toContain(`these four words: ${WORDS.join(" ")}`);
    // The other device's own name is shown plain: the bidi control is gone.
    expect(out.printed.join("\n")).not.toContain("‮");
    expect(d.calls.find((c) => c.method === "device.pair.confirm")?.params).toEqual({ pairingId: "p1", words: WORDS });
    expect(d.conn.closed).toBe(true);
  });

  test("a wrong word cancels the pairing; nothing is confirmed", async () => {
    const d = fakeDaemon();
    const r = await runDevice(["pair"], d.conn, io(["amber river stone rain"]));
    expect(r.code).toBe(1);
    expect(r.output).toContain("didn't match");
    expect(d.calls.map((c) => c.method)).toContain("device.pair.cancel");
    expect(d.calls.map((c) => c.method)).not.toContain("device.pair.confirm");
  });

  test("a yes is not the words; an empty line isn't either", async () => {
    for (const said of ["y", "yes", "", undefined]) {
      const d = fakeDaemon();
      const r = await runDevice(["pair"], d.conn, io([said]));
      expect([said, r.code]).toEqual([said, 1]);
      expect(d.calls.map((c) => c.method)).not.toContain("device.pair.confirm");
    }
  });

  test("with no terminal to type in, nothing is begun", async () => {
    const d = fakeDaemon();
    const r = await runDevice(["pair"], d.conn, { print: () => {} });
    expect(r.code).toBe(1);
    expect(d.calls).toEqual([]);
  });

  test("--join takes a code, shows the words the join gave back, and confirms with them typed", async () => {
    const d = fakeDaemon();
    const r = await runDevice(["pair", "--join", "ABCD-EFGH"], d.conn, io(["amber river stone cloud"]));
    expect(r).toEqual({ code: 0, output: "paired" });
    expect(d.calls.find((c) => c.method === "device.pair.join")?.params).toEqual({ code: "ABCD-EFGH" });
    expect(d.calls.find((c) => c.method === "device.pair.confirm")?.params).toEqual({ pairingId: "p2", words: WORDS });
  });

  test("an ending other than done is said, and a bad argument is the usage; there is no flag that skips the words", async () => {
    expect((await runDevice(["pair"], fakeDaemon({ end: "failed" }).conn, io(["amber river stone cloud"]))).output).toContain("the pairing ended: refused");
    for (const args of [["pair", "--yes"], ["pair", "--join"], ["pair", "--join", "x", "--yes"], ["pair", "--no-words"]]) {
      expect((await runDevice(args, fakeDaemon().conn, io(["amber river stone cloud"]))).code).toBe(2);
    }
  });
});

describe("moss device list and revoke", () => {
  test("lists the devices, this one marked; revoke asks y/N and removes only after a yes; never this computer", async () => {
    expect((await runDevice(["list"], fakeDaemon().conn, io([]))).output).toBe("Server (this computer)\nLaptop");
    const no = fakeDaemon();
    expect((await runDevice(["revoke", "Laptop"], no.conn, io(["n"]))).output).toBe("not removed");
    expect(no.calls.map((c) => c.method)).not.toContain("device.revoke");
    const yes = fakeDaemon();
    expect((await runDevice(["revoke", "Laptop"], yes.conn, io(["y"]))).output).toBe("removed Laptop");
    expect(yes.calls.find((c) => c.method === "device.revoke")?.params).toEqual({ id: "d2" });
    expect((await runDevice(["revoke", "Server"], fakeDaemon().conn, io(["y"]))).output).toBe("that is this computer");
    expect((await runDevice(["revoke", "Nope"], fakeDaemon().conn, io(["y"]))).code).toBe(1);
  });

  test("typed words fold spaces, commas, dashes and case", () => {
    expect(typedWords("  Amber,river - STONE  cloud ")).toEqual(WORDS);
  });
});
