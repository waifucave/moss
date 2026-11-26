// `moss device` (device-cli.ts) over a fake daemon connection: the words are typed or nothing is confirmed.
import { describe, expect, test } from "bun:test";
import { runDevice, typedWords, type DeviceConn } from "./device-cli";

const WORDS = ["amber", "river", "stone", "cloud"];

/** A daemon that answers as the engine does for the `cli` role, and says the pairing's steps as events. */
function fakeDaemon(o: { joinWords?: boolean; end?: "done" | "failed"; mainHolder?: string } = {}) {
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
        case "device.list": return { devices: [{ id: "d1", name: "Server", isThis: true, runsCore: true }, { id: "d2", name: "Laptop", runsCore: true }] } as T;
        case "device.revoke": return { applied: true } as T;
        case "main.get": return { lease: { holder: o.mainHolder === undefined ? null : o.mainHolder } } as T;
        // This computer from its own terminal: at once; another computer: its own sealed card there.
        case "main.set": return ((params as { device: string }).device === "d1" ? { applied: true } : { applied: false, card: "card_x" }) as T;
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
    // The payload is printed to paste after `moss device pair --join`, never as an argument (argv is seen by ps and kept in history).
    expect(out.printed.join("\n")).toContain("On the other computer run: moss device pair --join, then paste this:\nmoss-pair:xyz");
    expect(out.printed.join("\n")).not.toContain("--join '");
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

  test("--join asks for the code (never from argv), shows the words the join gave back, and confirms with them typed", async () => {
    const d = fakeDaemon();
    const r = await runDevice(["pair", "--join"], d.conn, io(["ABCD-EFGH", "amber river stone cloud"]));
    expect(r).toEqual({ code: 0, output: "paired" });
    expect(d.calls.find((c) => c.method === "device.pair.join")?.params).toEqual({ code: "ABCD-EFGH" });
    expect(d.calls.find((c) => c.method === "device.pair.confirm")?.params).toEqual({ pairingId: "p2", words: WORDS });
  });

  test("an ending other than done is said, and a bad argument is the usage; there is no flag that skips the words", async () => {
    expect((await runDevice(["pair"], fakeDaemon({ end: "failed" }).conn, io(["amber river stone cloud"]))).output).toContain("the pairing ended: refused");
    // A code on the command line is the usage too: it would put the pairing's secret in argv.
    for (const args of [["pair", "--yes"], ["pair", "--join", "ABCD-EFGH"], ["pair", "--join", "x", "--yes"], ["pair", "--no-words"]]) {
      expect((await runDevice(args, fakeDaemon().conn, io(["amber river stone cloud"]))).code).toBe(2);
    }
  });
});

describe("moss device main (lane XC 5c: the person's way back after a main computer restarts with its peer off)", () => {
  test("says which computer is the main one, or that none is", async () => {
    expect((await runDevice(["main"], fakeDaemon().conn, io([]))).output).toContain("no computer is the main one now");
    expect((await runDevice(["main"], fakeDaemon({ mainHolder: "d1" }).conn, io([]))).output).toBe("Server (this computer) is the main computer");
    expect((await runDevice(["main"], fakeDaemon({ mainHolder: "d2" }).conn, io([]))).output).toBe("Laptop is the main computer");
  });

  test("main set asks y/N; this computer is made the main at once, another waits for its own card; nothing on a no", async () => {
    const no = fakeDaemon();
    expect((await runDevice(["main", "set", "Server"], no.conn, io(["n"]))).output).toBe("not changed");
    expect(no.calls.map((c) => c.method)).not.toContain("main.set");
    const here = fakeDaemon();
    expect((await runDevice(["main", "set", "Server"], here.conn, io(["y"]))).output).toBe("Server is the main computer now");
    expect(here.calls.find((c) => c.method === "main.set")?.params).toEqual({ device: "d1" });
    const there = fakeDaemon();
    expect((await runDevice(["main", "set", "Laptop"], there.conn, io(["yes"]))).output).toContain("waits for your OK on its card");
    // With no terminal to answer in, nothing is changed.
    const silent = fakeDaemon();
    expect((await runDevice(["main", "set", "Server"], silent.conn, { print: () => {} })).output).toBe("not changed");
    expect(silent.calls.map((c) => c.method)).not.toContain("main.set");
  });

  test("main set refuses a device that doesn't run the engine, an unknown name, two of one name, and a bad form", async () => {
    const phone = fakeDaemon();
    const list = phone.conn.request.bind(phone.conn);
    phone.conn.request = (async (method: string, params?: unknown) => method === "device.list"
      ? { devices: [{ id: "d1", name: "Server", isThis: true, runsCore: true }, { id: "d3", name: "iPhone", runsCore: false }, { id: "d4", name: "Twin", runsCore: true }, { id: "d5", name: "Twin", runsCore: true }] }
      : list(method, params)) as typeof phone.conn.request;
    expect((await runDevice(["main", "set", "iPhone"], phone.conn, io(["y"]))).output).toContain("doesn't run the engine");
    expect((await runDevice(["main", "set", "Twin"], phone.conn, io(["y"]))).output).toContain("2 devices are named Twin");
    expect((await runDevice(["main", "set", "Nope"], phone.conn, io(["y"]))).code).toBe(1);
    expect(phone.calls.map((c) => c.method)).not.toContain("main.set");
    expect((await runDevice(["main", "pick", "Server"], fakeDaemon().conn, io(["y"]))).code).toBe(2);
    expect((await runDevice(["main", "set"], fakeDaemon().conn, io(["y"]))).code).toBe(2);
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
    // Two devices of one name: neither is removed, both are listed.
    const twin = fakeDaemon();
    const list = twin.conn.request.bind(twin.conn);
    twin.conn.request = (async (method: string, params?: unknown) => method === "device.list"
      ? { devices: [{ id: "d2", name: "Laptop", kind: "desktop" }, { id: "d9", name: "Laptop", kind: "phone" }] }
      : list(method, params)) as typeof twin.conn.request;
    const both = await runDevice(["revoke", "Laptop"], twin.conn, io(["y"]));
    expect(both.code).toBe(1);
    expect(both.output).toContain("2 devices are named Laptop");
    expect(twin.calls.map((c) => c.method)).not.toContain("device.revoke");
  });

  test("an error from the engine is shown plain (control and bidi characters folded)", async () => {
    const d = fakeDaemon();
    d.conn.request = (async () => { throw new Error("bad\u202e\u0007thing"); }) as typeof d.conn.request;
    const r = await runDevice(["list"], d.conn, io([]));
    expect(r.output).toBe("bad thing");
  });

  test("typed words fold spaces, commas, dashes and case", () => {
    expect(typedWords("  Amber,river - STONE  cloud ")).toEqual(WORDS);
  });
});

describe("moss device key reset (lane XC, xc-6b)", () => {
  const answering = (answer: Record<string, unknown>) => {
    const calls: { method: string; params: unknown }[] = [];
    const conn: DeviceConn = {
      onEvent: () => {},
      close: () => {},
      async request<T>(method: string, params?: unknown): Promise<T> {
        calls.push({ method, params });
        return answer as T;
      },
    };
    return { conn, calls };
  };
  const quiet = { print: () => {} };

  test("asks the engine for that program, and says what it did: opened, accepted, a card to answer, or no key yet", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ opened: true }, /MOSS can register a new key in the next 10 minutes: open MOSS now/],
      [{ accepted: true }, /MOSS's new key is accepted on this computer/],
      [{ card: "card_1" }, /MOSS's new key waits for your OK on its card: answer it in MOSS, or on another of your devices/],
      [{}, /waits for your OK on its card/],
      [{ none: true }, /MOSS holds no key on this computer yet/],
    ];
    for (const [answer, says] of cases) {
      const d = answering(answer);
      const r = await runDevice(["key", "reset", "moss"], d.conn, quiet);
      expect(r.code).toBe(0);
      expect(r.output).toMatch(says);
      expect(d.calls).toEqual([{ method: "device.programKey.reset", params: { program: "moss" } }]);
    }
  });

  test("an unknown program or verb is the usage, and nothing is asked", async () => {
    for (const args of [["key", "reset", "plugin"], ["key", "wipe", "moss"], ["key", "reset"], ["key", "reset", "moss", "extra"]]) {
      const d = answering({ opened: true });
      expect((await runDevice(args, d.conn, quiet)).code).toBe(2);
      expect(d.calls).toEqual([]);
    }
  });
});
