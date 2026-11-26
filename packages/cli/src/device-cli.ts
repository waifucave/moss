// `moss device` (lane XC, step 5): pairing a computer from the user's own terminal, so a computer with only the engine
// (a server after `moss-core server install`) can be paired by a person. It speaks to the running daemon as the `cli`
// role with this run's harness token, over the doors the engine already serves to that role:
//
//   moss device pair                 begins a pairing here: prints the code (when the engine has one) and what the other
//                                     device can paste to join (the QR's payload, as text); then the four words, which
//                                     the person TYPES to confirm (`device.pair.confirm`, which checks them)
//   moss device pair --join          joins another device's pairing: it asks for the code or the pasted payload (never
//                                     on the command line: the payload holds the pairing's secret, and argv is seen by
//                                     `ps` and kept in shell history); the same four words
//   moss device list                 the paired devices (`device.list`)
//   moss device revoke <name>        removes one (`device.revoke`), after a y/N question
//   moss device main                 which computer is the main one now (`main.get`)
//   moss device main set <name>      makes a computer the main one (`main.set`), after a y/N question: this computer at once
//                                     (the person's own terminal), another computer on its own sealed card there. The way
//                                     back after a main computer restarts with its peer off (lane XC 5c)
//
// Never a yes/no for the words, never confirmed on its own, no flag that skips them: the words are the check that the
// two devices are each other and not someone in between, and only typing them proves the person compared them. With no
// terminal to type in, the pairing is refused (and cancelled). A wrong word cancels the pairing.

/** One held connection to the daemon, as the CLI: requests, and the events it is sent. */
export interface DeviceConn {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Each `core.event`'s event, as it comes. */
  onEvent(fn: (event: Record<string, unknown>) => void): void;
  close(): void;
}

export interface DeviceIo {
  print(line: string): void;
  /** A line the person types; undefined: no terminal to type in. */
  ask?(question: string): Promise<string | undefined>;
  /** How long a pairing waits for the other device's step (default 10 minutes, the code's own life). */
  waitMs?: number;
}

export interface CliRun { code: number; output: string }

export const DEVICE_USAGE = "usage: moss device pair [--join] | list | revoke <name> | main [set <name>]";

type PairingEvent = { pairingId?: string; step?: string; words?: string[]; peerName?: string; reason?: string };
type PairingView = { pairingId: string; code?: string; qr?: string; words?: string[] };
type Device = { id: string; name: string; isThis?: boolean; kind?: string; runsCore?: boolean; isMain?: boolean };

/** The words as typed, folded: spaces, commas or dashes between them, any letter case. */
export function typedWords(line: string): string[] {
  return line.trim().toLowerCase().split(/[\s,;-]+/).filter((w) => w !== "");
}

/** Plain text of another device's own words (its name, a reason): no control characters, one line, clamped. */
function plain(s: unknown, n = 80): string {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export async function runDevice(args: readonly string[], conn: DeviceConn, io: DeviceIo): Promise<CliRun> {
  const [sub, ...rest] = args;
  try {
    if (sub === "list") {
      const { devices } = await conn.request<{ devices: Device[] }>("device.list", {});
      const lines = devices.map((d) => `${plain(d.name)}${d.isThis === true ? " (this computer)" : ""}${d.kind ? `  ${plain(d.kind, 20)}` : ""}`);
      return { code: 0, output: lines.length === 0 ? "no devices" : lines.join("\n") };
    }
    if (sub === "revoke") {
      const name = rest[0];
      if (name === undefined || rest.length !== 1) return { code: 2, output: DEVICE_USAGE };
      const { devices } = await conn.request<{ devices: Device[] }>("device.list", {});
      const named = devices.filter((x) => x.name === name);
      if (named.length === 0) return { code: 1, output: `no paired device is named ${plain(name)}` };
      // Two of one name: which one is meant isn't said, so none is removed.
      if (named.length > 1) return { code: 1, output: `${named.length} devices are named ${plain(name)}: rename one first (${named.map((x) => `${plain(x.kind ?? "device", 20)} ${plain(x.id, 40)}`).join(", ")})` };
      const d = named[0]!;
      if (d.isThis === true) return { code: 1, output: "that is this computer" };
      const answer = io.ask === undefined ? undefined : await io.ask(`Remove ${plain(d.name)} from your devices? [y/N] `);
      if (answer === undefined || !/^y(es)?$/i.test(answer.trim())) return { code: 1, output: "not removed" };
      const r = await conn.request<{ applied?: boolean; card?: string }>("device.revoke", { id: d.id });
      if (r?.applied === false) return { code: 0, output: `removing ${plain(d.name)} waits for your OK on its card (in the app, or on a paired device)` };
      return { code: 0, output: `removed ${plain(d.name)}` };
    }
    if (sub === "main") return await main(rest, conn, io);
    if (sub === "pair") return await pair(rest, conn, io);
    return { code: 2, output: DEVICE_USAGE };
  } catch (e) {
    return { code: 1, output: plain(e instanceof Error ? e.message : String(e), 500) };
  } finally {
    conn.close();
  }
}

/** `moss device main [set <name>]`: which computer is the main one, or the person's choice of one. */
async function main(rest: readonly string[], conn: DeviceConn, io: DeviceIo): Promise<CliRun> {
  const { devices } = await conn.request<{ devices: Device[] }>("device.list", {});
  if (rest.length === 0) {
    const { lease } = await conn.request<{ lease: { holder?: string | null } }>("main.get", {});
    const holder = lease?.holder ?? null;
    if (holder === null) return { code: 0, output: "no computer is the main one now: choose one with `moss device main set <name>`" };
    const d = devices.find((x) => x.id === holder);
    return { code: 0, output: d === undefined ? "the main computer is one this computer doesn't know" : `${plain(d.name)}${d.isThis === true ? " (this computer)" : ""} is the main computer` };
  }
  if (rest[0] !== "set" || rest.length !== 2) return { code: 2, output: DEVICE_USAGE };
  const name = rest[1]!;
  const named = devices.filter((x) => x.name === name);
  if (named.length === 0) return { code: 1, output: `no paired device is named ${plain(name)}` };
  if (named.length > 1) return { code: 1, output: `${named.length} devices are named ${plain(name)}: rename one first` };
  const d = named[0]!;
  if (d.runsCore !== true) return { code: 1, output: `${plain(d.name)} doesn't run the engine, so it can't be the main computer` };
  const answer = io.ask === undefined ? undefined : await io.ask(`Make ${plain(d.name)} the main computer? Your bots run there from now on. [y/N] `);
  if (answer === undefined || !/^y(es)?$/i.test(answer.trim())) return { code: 1, output: "not changed" };
  const r = await conn.request<{ applied?: boolean; card?: unknown }>("main.set", { device: d.id });
  if (r?.applied === false) return { code: 0, output: `making ${plain(d.name)} the main computer waits for your OK on its card (on ${plain(d.name)}, or a device paired with it)` };
  return { code: 0, output: `${plain(d.name)} is the main computer now` };
}

async function pair(rest: readonly string[], conn: DeviceConn, io: DeviceIo): Promise<CliRun> {
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--join")) return { code: 2, output: DEVICE_USAGE };
  // The words are typed or there is no pairing: with no terminal, nothing is begun.
  if (io.ask === undefined) return { code: 1, output: "pairing needs you to type the four words: run it in a terminal" };
  let code: string | undefined;
  if (rest[0] === "--join") {
    const pasted = (await io.ask("Paste the other computer's pairing code or line: "))?.trim();
    if (pasted === undefined || pasted === "") return { code: 1, output: "no code given: nothing joined" };
    code = pasted;
  }
  const events: PairingEvent[] = [];
  let wake = () => {};
  conn.onEvent((ev) => {
    if (ev["type"] !== "pairing_changed") return;
    events.push(ev as PairingEvent);
    wake();
  });
  await conn.request("events.subscribe", { areas: ["devices"] });
  const waitMs = io.waitMs ?? 10 * 60_000;
  const next = async (id: string, steps: readonly string[]): Promise<PairingEvent> => {
    const end = Date.now() + waitMs;
    for (;;) {
      const got = events.find((e) => e.pairingId === id && e.step !== undefined && steps.includes(e.step));
      if (got !== undefined) return got;
      const left = end - Date.now();
      if (left <= 0) throw new Error("the other device didn't answer in time");
      await new Promise<void>((r) => { wake = r; setTimeout(r, Math.min(left, 1_000)); });
    }
  };
  let view: PairingView;
  if (code === undefined) {
    view = await conn.request<PairingView>("device.pair.begin", {});
    if (view.code !== undefined) io.print(`Pairing code: ${view.code}`);
    if (view.qr !== undefined) io.print(`On the other computer run: moss device pair --join, then paste this:\n${view.qr}\n(or scan the QR in the app)`);
    io.print("Waiting for the other device…");
  } else {
    view = await conn.request<PairingView>("device.pair.join", { code });
  }
  const id = view.pairingId;
  const cancel = async () => { await conn.request("device.pair.cancel", { pairingId: id }).catch(() => undefined); };
  let words = view.words;
  if (words === undefined) {
    const ev = await next(id, ["words", "failed", "expired"]);
    if (ev.step !== "words" || ev.words === undefined) return { code: 1, output: ev.step === "expired" ? "the pairing code expired" : `the pairing ended: ${plain(ev.reason ?? "no reason given", 200)}` };
    words = ev.words;
    if (ev.peerName !== undefined) io.print(`The other device calls itself: ${plain(ev.peerName)}`);
  }
  io.print(`Check that the other device shows these four words: ${words.join(" ")}`);
  const typed = await io.ask("Type the four words to confirm: ");
  if (typed === undefined || typedWords(typed).join(" ") !== words.map((w) => w.toLowerCase()).join(" ")) {
    await cancel();
    return { code: 1, output: "the words didn't match: the pairing is cancelled" };
  }
  await conn.request("device.pair.confirm", { pairingId: id, words: typedWords(typed) });
  const end = await next(id, ["done", "failed", "expired"]);
  if (end.step !== "done") return { code: 1, output: end.step === "expired" ? "the pairing expired" : `the pairing ended: ${plain(end.reason ?? "no reason given", 200)}` };
  return { code: 0, output: "paired" };
}

/** The held connection over the daemon's socket (or the Windows pipe), said hello as the CLI with this run's token. */
export async function openDeviceConn(endpoint: string, token: string): Promise<DeviceConn> {
  const { MOSS_PROTOCOL_VERSION, encodeLine, LineDecoder, METHODS } = await import("@waifucave/moss-protocol");
  const decoder = new LineDecoder();
  const pending = new Map<number, { ok(v: unknown): void; fail(e: Error): void }>();
  const listeners: ((ev: Record<string, unknown>) => void)[] = [];
  const socket = await Bun.connect({ unix: endpoint, socket: {
    data(s, chunk) {
      for (const line of decoder.push(chunk)) {
        const m = JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
        // A request from the daemon (its ping): answered, so the connection stays.
        if (typeof m.method === "string" && m.id !== undefined) { s.write(encodeLine({ jsonrpc: "2.0", id: m.id, result: {} })); continue; }
        if (typeof m.method === "string") {
          const ev = (m.params?.["event"] ?? m.params) as Record<string, unknown> | undefined;
          if (ev !== undefined) for (const l of listeners) l(ev);
          continue;
        }
        const p = typeof m.id === "number" ? pending.get(m.id) : undefined;
        if (!p) continue;
        pending.delete(m.id as number);
        if (m.error) p.fail(Object.assign(new Error(m.error.message), { code: m.error.code })); else p.ok(m.result);
      }
    },
    close() { for (const p of pending.values()) p.fail(new Error("MOSS closed the connection")); pending.clear(); },
  } });
  let next = 1;
  const request = <T>(method: string, params?: unknown) => new Promise<T>((ok, fail) => {
    const id = next++;
    pending.set(id, { ok: ok as (v: unknown) => void, fail });
    socket.write(encodeLine({ jsonrpc: "2.0", id, method, params }));
  });
  await request(METHODS.hello, { protocolVersion: MOSS_PROTOCOL_VERSION, role: "cli", token, clientName: "moss-device", features: [] });
  return { request, onEvent: (fn) => { listeners.push(fn); }, close: () => socket.end() };
}
