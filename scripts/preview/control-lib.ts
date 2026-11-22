// The preview's control commands, pure part: scripts/preview/ctl.ts parses a command line with this and prints what comes back;
// scripts/preview/control.ts (inside the running preview command) runs the parsed request. Nothing here starts a process or opens a socket.
//
// A request is one line of JSON on the preview command's control socket: `{"hello": <token>}` first, then `{id, cmd, args}`. The token
// is made per run (newToken) and kept in the run's record, a file only this user can read; a socket in a folder only this user can
// enter is the first guard, the token the second.
import { randomBytes } from "node:crypto";
import { MAX_REQUEST_BYTES, sameToken } from "../../apps/desktop/src/main/preview-control-rules";
import { MOSS_AREAS } from "../../packages/protocol/src/moss";
import { UsageError } from "./lib";

export { UsageError };

/** The token rule and the request limit are the door's own (apps/desktop/src/main/preview-control-rules.ts), shared so both ends hold one. */
export { sameToken, MAX_REQUEST_BYTES as MAX_LINE };

export const newToken = (): string => randomBytes(32).toString("hex");

export interface CtlRequest { cmd: string; args: Record<string, unknown> }
export interface Parsed { request: CtlRequest; json: boolean; help: boolean }

/** What a target argument names: a CSS selector (it starts like one), a whole line of text or a label (`=Name`), or text the element holds. */
export type Target = { kind: "css"; selector: string } | { kind: "text"; text: string; exact: boolean };

export function classifyTarget(arg: string): Target {
  if (arg === "") throw new UsageError("a target is not empty");
  if (arg.startsWith("css=")) return { kind: "css", selector: arg.slice(4) };
  if (/^[.#\[]/.test(arg) || /^[a-z][a-z0-9-]*[.#\[:>]/i.test(arg) && /[.#\[>]/.test(arg)) return { kind: "css", selector: arg };
  if (arg.startsWith("=")) return { kind: "text", text: arg.slice(1), exact: true };
  return { kind: "text", text: arg, exact: false };
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const NAMED: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 }, escape: { key: "Escape", code: "Escape", vk: 27 }, esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 }, delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 }, down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 }, end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 }, pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};
const MODS: Record<string, number> = { alt: 1, option: 1, opt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

export interface Chord { key: string; code: string; vk: number; text?: string; modifiers: number }

/** `Enter`, `Escape`, `Cmd+K`, `Shift+Tab`, `a`: the key's DevTools fields and its modifier bits (alt 1, ctrl 2, meta 4, shift 8). Text is sent only for a plain printable key. */
export function parseChord(spec: string): Chord {
  const parts = spec.split("+").map((p) => p.trim());
  if (parts.some((p) => p === "") && spec !== "+") throw new UsageError(`"${spec}" is not a key chord (for example Enter, Escape, Cmd+K, Shift+Tab)`);
  const keyName = spec === "+" ? "+" : parts[parts.length - 1]!;
  let modifiers = 0;
  for (const m of spec === "+" ? [] : parts.slice(0, -1)) {
    const bit = MODS[m.toLowerCase()];
    if (bit === undefined) throw new UsageError(`"${m}" is not a modifier (alt, ctrl, meta/cmd, shift)`);
    modifiers |= bit;
  }
  const named = NAMED[keyName.toLowerCase()];
  if (named !== undefined) return { ...named, modifiers, ...(modifiers & (2 | 4) ? { text: undefined } : {}) } as Chord;
  const f = /^f([1-9]|1[0-2])$/i.exec(keyName);
  if (f !== null) return { key: `F${f[1]}`, code: `F${f[1]}`, vk: 111 + Number(f[1]), modifiers };
  if ([...keyName].length !== 1) throw new UsageError(`"${keyName}" is not a key (a single character, a named key such as Enter or Tab, or F1 to F12)`);
  const upper = keyName.toUpperCase();
  const isLetter = /^[a-z]$/i.test(keyName);
  const isDigit = /^[0-9]$/.test(keyName);
  const shifted = isLetter ? ((modifiers & 8) !== 0 ? upper : keyName.toLowerCase()) : keyName;
  return {
    key: shifted, code: isLetter ? `Key${upper}` : isDigit ? `Digit${keyName}` : "", vk: isLetter ? upper.charCodeAt(0) : isDigit ? keyName.charCodeAt(0) : keyName.charCodeAt(0),
    ...(modifiers & (2 | 4 | 1) ? {} : { text: shifted }), modifiers,
  };
}

// ── the command line ─────────────────────────────────────────────────────────────────────────────────────────────────
export const COMMANDS = ["shot", "text", "click", "type", "key", "scroll", "hover", "drag", "go", "wait", "theme", "size", "reload", "end", "call", "events", "sessions", "seed", "logs", "spent", "eval", "frames"] as const;
export type CommandName = (typeof COMMANDS)[number];
export const SCENES = ["message", "child", "waiting", "running", "idle", "ended"] as const;

export const CTL_USAGE = [
  "usage: scripts/pinned-bun scripts/preview/ctl.ts <command> [args] [--json]",
  "",
  "Drives a RUNNING preview that was started with --control (visible or --headless), as a person at its window could, and reads what they would see.",
  "Every command prints one short result and exits 0, or says why not on stderr and exits 1 (2 for a command line that is not understood). --json prints the raw answer.",
  "",
  "the window",
  "  shot <png> [--full]          a picture of the window's page as drawn now. The app captures its own contents: no screen recording, no macOS permission.",
  "                               The system's glass behind the window (the sidebar's vibrancy) is NOT in such a picture; it shows as a plain grey. --full: the whole scrolled page.",
  "  text [--frames]              the window's visible text, its buttons, links and fields named in [brackets]; --frames labels each frame with its address and size",
  "  click <target>               press it with a real mouse event ('--double', '--right' too). A target is text the element shows or is labelled with (=Name: that whole line or label),",
  "                               or a CSS selector (it starts with . # [ or write css=...)",
  "  type <text> [--into <target>]  type text into the focused field (or click --into first)",
  "  key <chord>                  Enter, Escape, Tab, Cmd+K, Shift+Tab, F5, a  (the page sees the key; the system's menu shortcuts are not run)",
  "  scroll [<target>] --dy <px> [--dx <px>]   a wheel over the target (or the window's middle)",
  "  hover <target>               move the mouse onto it",
  "  drag <from> <to>             press on the first, move, release on the second (both in one frame)",
  "  go start | session <id> | <page>   the start page (the canvas), a session's tab, or a sidebar page by its name (Plugins, Archive)",
  "  wait <target> [--timeout <s>]      until the text or selector is drawn (default 30 s); exit 1 if not",
  "  theme light|dark|system      the window's appearance",
  "  size <w>x<h>                 the window's content size in pixels",
  "  reload                       reload the window's page",
  "  end                          close the window, as a person would: the preview ends and cleans up",
  "",
  "the engine (the preview's own, on its throwaway home; nothing else)",
  "  call <method> [<json>]       one engine call as the person's app",
  "  events [--area <a>]... [--for <s>] [--count <n>]   follow the engine's events (areas: " + MOSS_AREAS.join(", ") + "); default 10 s",
  "  sessions                     the sessions (id, backend, status, title)",
  "  seed <scene>                 more sample sessions: " + SCENES.join(", "),
  "  eval <js> [--frame <part of an address>]   run JavaScript in the window's page (or the frame whose address has that part) and print what it returns",
  "  frames                       the window's attached documents (type, session, address)",
  "  spent                        a real-agents preview: the real turns and sessions spent per agent against the budget (2 sessions per agent, 3 turns per session)",
  "  logs [--app|--engine] [--since <Ns|Nm>] [--tail <n>]   the preview's logs (default both, last 60 lines)",
].join("\n");

const num = (name: string, v: string | undefined, lo: number, hi: number): number => {
  const n = Number(v);
  if (v === undefined || v === "" || !Number.isFinite(n) || n < lo || n > hi) throw new UsageError(`${name} is a number from ${lo} to ${hi}`);
  return n;
};

/** A command line (`argv` after the script's name) as a request: its words checked here, never in the preview. */
export function parseCtl(argv: readonly string[]): Parsed {
  const rest: string[] = [];
  const flags = new Map<string, string[]>();
  const valueFlags = new Set(["--frame", "--timeout", "--into", "--dy", "--dx", "--area", "--for", "--count", "--since", "--tail"]);
  let json = false, help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (valueFlags.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      flags.set(a, [...(flags.get(a) ?? []), v]);
    } else if (a.startsWith("--") && ["--full", "--frames", "--double", "--right", "--app", "--engine"].includes(a)) flags.set(a, [""]);
    else if (a.startsWith("--") && a.length > 2) throw new UsageError(`unknown option ${a}`);
    else rest.push(a);
  }
  const has = (f: string): boolean => flags.has(f);
  const one = (f: string): string | undefined => flags.get(f)?.[0];
  if (help || rest.length === 0) return { request: { cmd: "help", args: {} }, json, help: true };
  const cmd = rest[0]! as CommandName;
  if (!(COMMANDS as readonly string[]).includes(cmd)) throw new UsageError(`unknown command ${cmd} (see --help)`);
  const a = rest.slice(1);
  const need = (n: number, what: string): void => { if (a.length !== n) throw new UsageError(`${cmd} takes ${what}`); };
  const only = (...allowed: string[]): void => { for (const f of flags.keys()) if (!allowed.includes(f)) throw new UsageError(`${cmd} does not take ${f}`); };
  const args: Record<string, unknown> = {};
  switch (cmd) {
    case "shot": need(1, "one file name: shot <png> [--full]"); only("--full"); if (!a[0]!.endsWith(".png")) throw new UsageError("shot names a .png file"); args.full = has("--full"); break;
    case "text": need(0, "no argument"); only("--frames"); args.frames = has("--frames"); break;
    case "click": need(1, "one target: click <text-or-selector>"); only("--double", "--right"); args.target = classifyTarget(a[0]!); args.double = has("--double"); args.right = has("--right"); break;
    case "type": need(1, "the text as one argument: type \"hello\" [--into <target>]"); only("--into"); args.text = a[0]; if (one("--into") !== undefined) args.into = classifyTarget(one("--into")!); break;
    case "key": need(1, "one chord: key Enter"); only(); args.chord = parseChord(a[0]!); break;
    case "scroll": if (a.length > 1) throw new UsageError("scroll takes at most one target"); only("--dy", "--dx"); if (a[0] !== undefined) args.target = classifyTarget(a[0]); args.dy = has("--dy") ? num("--dy", one("--dy"), -100000, 100000) : 0; args.dx = has("--dx") ? num("--dx", one("--dx"), -100000, 100000) : 0; if (args.dy === 0 && args.dx === 0) throw new UsageError("scroll needs --dy or --dx"); break;
    case "hover": need(1, "one target"); only(); args.target = classifyTarget(a[0]!); break;
    case "drag": need(2, "two targets: drag <from> <to>"); only(); args.from = classifyTarget(a[0]!); args.to = classifyTarget(a[1]!); break;
    case "go": {
      only();
      if (a[0] === "start" && a.length === 1) args.to = { where: "start" };
      else if (a[0] === "session" && a.length === 2) args.to = { where: "session", id: a[1] };
      else if (a.length === 1 && a[0] !== "session") args.to = { where: "page", name: a[0] };
      else throw new UsageError("go start | go session <id> | go <page name>");
      break;
    }
    case "wait": need(1, "one target"); only("--timeout"); args.target = classifyTarget(a[0]!); args.timeoutS = has("--timeout") ? num("--timeout", one("--timeout"), 1, 600) : 30; break;
    case "theme": need(1, "light, dark or system"); only(); if (!["light", "dark", "system"].includes(a[0]!)) throw new UsageError("theme is light, dark or system"); args.value = a[0]; break;
    case "size": { need(1, "<w>x<h>"); only(); const m = /^(\d{3,4})x(\d{3,4})$/.exec(a[0]!); if (m === null) throw new UsageError("size is <w>x<h> in pixels, for example 1180x760"); args.w = Number(m[1]); args.h = Number(m[2]); if (args.w as number < 320 || args.h as number < 240 || args.w as number > 8000 || args.h as number > 8000) throw new UsageError("a size is 320x240 to 8000x8000"); break; }
    case "eval": need(1, "the JavaScript as one argument: eval \"document.title\" [--frame <part of its address>]"); only("--frame"); args.js = a[0]; if (one("--frame") !== undefined) args.frame = one("--frame"); break;
    case "reload": case "end": case "sessions": case "spent": case "frames": need(0, "no argument"); only(); break;
    case "call": {
      only();
      if (a.length < 1 || a.length > 2) throw new UsageError("call <method> [<json>]");
      if (!/^[a-z][A-Za-z0-9_.]*$/.test(a[0]!)) throw new UsageError(`"${a[0]}" is not a method name`);
      let params: unknown = {};
      if (a[1] !== undefined) { try { params = JSON.parse(a[1]); } catch { throw new UsageError("the call's parameters are not JSON"); } }
      args.method = a[0]; args.params = params; break;
    }
    case "events": {
      need(0, "no argument"); only("--area", "--for", "--count");
      const areas = flags.get("--area") ?? [];
      for (const x of areas) if (!(MOSS_AREAS as readonly string[]).includes(x)) throw new UsageError(`"${x}" is not an area (${MOSS_AREAS.join(", ")})`);
      args.areas = areas.length > 0 ? areas : [...MOSS_AREAS]; args.forS = has("--for") ? num("--for", one("--for"), 1, 3600) : 10; args.count = has("--count") ? num("--count", one("--count"), 1, 100000) : 100000; break;
    }
    case "seed": need(1, `a scene: ${SCENES.join(", ")}`); only(); if (!(SCENES as readonly string[]).includes(a[0]!)) throw new UsageError(`"${a[0]}" is not a scene (${SCENES.join(", ")})`); args.scene = a[0]; break;
    case "logs": {
      need(0, "no argument"); only("--app", "--engine", "--since", "--tail");
      args.which = has("--app") && !has("--engine") ? "app" : has("--engine") && !has("--app") ? "engine" : "both";
      if (has("--since")) { const m = /^(\d+)(s|m|h)$/.exec(one("--since")!); if (m === null) throw new UsageError("--since is a number and s, m or h (for example 90s, 5m)"); args.sinceMs = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"]; }
      args.tail = has("--tail") ? num("--tail", one("--tail"), 1, 5000) : 60; break;
    }
  }
  return { request: { cmd, args }, json, help: false };
}

// ── the wire ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const encodeLine = (m: unknown): string => `${JSON.stringify(m)}\n`;

/** Lines out of chunks; a line longer than `max` is an error (the caller closes). */
export class LineReader {
  private buf = "";
  constructor(private readonly max: number = MAX_REQUEST_BYTES) {}
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
      if (nl > this.max) throw new Error("a line is longer than the limit");
      out.push(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
    if (this.buf.length > this.max) throw new Error("a line is longer than the limit");
    return out;
  }
}

/** What a command's answer looks like on a terminal (no `--json`). */
export function render(cmd: string, result: unknown): string {
  const r = result as Record<string, unknown>;
  switch (cmd) {
    case "text": return String(r.text ?? "");
    case "sessions": {
      const rows = (r.sessions as { id: string; backend?: string; status?: string; title?: string; startedBy?: { kind?: string } }[]) ?? [];
      return rows.length === 0 ? "no sessions" : rows.map((s) => `${s.id}  ${(s.backend ?? "-").padEnd(12)} ${(s.status ?? "-").padEnd(10)} ${s.title ?? "(untitled)"}${s.startedBy?.kind !== undefined && s.startedBy.kind !== "user" ? `  [started by ${s.startedBy.kind}]` : ""}`).join("\n");
    }
    case "call": return JSON.stringify(r.result, null, 2);
    case "logs": return String(r.text ?? "");
    case "spent": case "frames": return String(r.text ?? "");
    case "eval": return typeof r.value === "string" ? r.value : JSON.stringify(r.value);
    case "shot": return `${r.path} (${r.width}x${r.height}${r.full === true ? ", the whole page" : ""})`;
    default: return typeof r.message === "string" ? r.message : JSON.stringify(result);
  }
}
