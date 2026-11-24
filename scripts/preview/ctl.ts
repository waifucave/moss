// Drives a RUNNING preview that was started with `--control` (scripts/preview/run.ts), as a person at its window could, and reads what
// they would see. See `--help`. It finds the preview by its record (a file only this user can read: the control socket's path and
// token) and talks to that one socket; it starts nothing, and where no preview runs it says so and exits 1.
import { refusal } from "./lib";
{
  const why = refusal(process.env);
  if (why !== undefined) {
    process.stderr.write(`preview ctl: not running: ${why}\n`);
    process.exit(2);
  }
}
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CTL_USAGE, LineReader, UsageError, encodeLine, parseCtl, render } from "./control-lib";
import { parseRecord, sameProcess } from "./lib";

const RECORD = join(tmpdir(), "moss-preview-state", "running.json");

const fail = (msg: string, code = 1): never => { process.stderr.write(`preview ctl: ${msg}\n`); process.exit(code); };

function startOf(pid: number): string | undefined {
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).trim() || undefined; } catch { return undefined; }
}

let parsed;
try { parsed = parseCtl(process.argv.slice(2)); } catch (err) {
  if (err instanceof UsageError) fail(`${err.message}\n(scripts/pinned-bun scripts/preview/ctl.ts --help)`, 2);
  throw err;
}
if (parsed.help) { process.stdout.write(`${CTL_USAGE}\n`); process.exit(0); }
const { request, json } = parsed;

let record;
try { record = parseRecord(readFileSync(RECORD, "utf8")); } catch { record = undefined; }
if (record === undefined || !sameProcess(record.start, startOf(record.pid))) fail("no preview is running. Start one with: scripts/pinned-bun scripts/preview/run.ts --control");
if (record!.control === undefined) fail("the running preview was not started with --control. Restart it: scripts/pinned-bun scripts/preview/run.ts --stop, then run.ts --control");
const control = record!.control!;

const sock = createConnection({ path: control.socket });
const reader = new LineReader();
let answered = false;
sock.setEncoding("utf8");
sock.on("error", (e) => fail(`cannot reach the preview's control socket (${e.message}). It may have just ended.`));
sock.on("close", () => { if (!answered) fail("the preview closed the connection before it answered"); });
sock.on("connect", () => {
  sock.write(encodeLine({ hello: control.token }));
  sock.write(encodeLine({ id: 1, cmd: request.cmd, args: request.args }));
});
sock.on("data", (chunk: string) => {
  let lines: string[];
  try { lines = reader.push(chunk); } catch { fail("an answer was longer than the limit"); return; }
  for (const line of lines) {
    const m = JSON.parse(line) as { hello?: string; id?: number; ok?: boolean; result?: any; error?: string; event?: unknown };
    if (m.hello !== undefined || m.id === undefined) continue;
    if (m.event !== undefined) {
      const e = m.event as { method: string; params: unknown };
      process.stdout.write(json ? `${JSON.stringify(m.event)}\n` : `${summary(e.params)}\n`);
      continue;
    }
    answered = true;
    if (m.ok !== true) fail(m.error ?? "the command failed");
    finish(m.result);
  }
});

/** One event on one line: the area and type, then what it carries, cut short. */
function summary(params: unknown): string {
  const p = params as { area?: string; event?: { type?: string }; type?: string } | undefined;
  const type = `${p?.area ?? "?"}.${p?.event?.type ?? p?.type ?? "event"}`;
  const text = JSON.stringify(params);
  return `${type}  ${text.length > 220 ? `${text.slice(0, 217)}...` : text}`;
}

function finish(result: any): void {
  if (request.cmd === "shot") {
    const out = resolve(String(process.argv.slice(2).find((a) => a.endsWith(".png"))));
    writeFileSync(out, Buffer.from(result.png as string, "base64"));
    const shown = { path: out, width: result.width, height: result.height, full: result.full };
    process.stdout.write(json ? `${JSON.stringify(shown)}\n` : `${render("shot", shown)}\n`);
  } else {
    process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${render(request.cmd, result)}\n`);
  }
  sock.end();
  process.exit(0);
}
