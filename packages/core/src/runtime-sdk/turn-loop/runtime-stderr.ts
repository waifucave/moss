// A bot session's agent runtime stderr (the deletion lane, item 6). The runtime prints what it likes there: an API error
// that echoes the request, a tool's output, its own debug lines. That is the session's content, so it is kept with the
// session's runtime state (`<home>/sessions-runtime/<session>.stderr.log`, removed when the session is deleted), capped,
// and the engine log, which is kept long and holds every session, gets one line per session saying where it is.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendRotating } from "../../append-log";

/** Per session: enough for a crash's last words, never a growing copy of the conversation. */
export const RUNTIME_STDERR_MAX_BYTES = 1024 * 1024;

const stem = (sessionId: string): string => sessionId.replace(/[^A-Za-z0-9._-]/g, "_");

/** `<home>/sessions-runtime/<session>.stderr.log`, beside the driver's own state file for the session. */
export function runtimeStderrPath(home: string, sessionId: string): string {
  return join(home, "sessions-runtime", `${stem(sessionId)}.stderr.log`);
}

export function runtimeStderrSink(o: { home: string; sessionId: string; log: (line: string) => void; maxBytes?: number }): (chunk: string) => void {
  const path = runtimeStderrPath(o.home, o.sessionId);
  let noted = false;
  let failed = false;
  return (chunk) => {
    if (!noted) {
      noted = true;
      o.log(`bot driver ${o.sessionId}: the runtime wrote to its stderr; kept with the session in sessions-runtime/${stem(o.sessionId)}.stderr.log`);
    }
    if (failed) return;
    try {
      mkdirSync(join(o.home, "sessions-runtime"), { recursive: true, mode: 0o700 });
      appendRotating(path, chunk.endsWith("\n") ? chunk : `${chunk}\n`, o.maxBytes ?? RUNTIME_STDERR_MAX_BYTES);
    } catch (err) {
      failed = true;
      o.log(`bot driver ${o.sessionId}: the runtime's stderr file can't be written (${err instanceof Error ? err.name : "error"})`);
    }
  };
}
