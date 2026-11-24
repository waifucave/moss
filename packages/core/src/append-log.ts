// The engine's append-only local records (`audit.jsonl`, `routines-audit.jsonl`, `memory/audit.jsonl`, `cleaner.jsonl`)
// rotate as the engine log does (`daemon-log-file.ts`): past 8 MB the file is renamed to `<name>.1`, overwriting the
// previous generation, and a fresh file starts. So none of them grows without end on a computer that runs for years.
import { appendFileSync, renameSync, statSync } from "node:fs";

/** The engine log's own cap (`DAEMON_LOG_MAX_BYTES`). */
export const LOCAL_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** Appends `text` to `path`, first rotating it when the append would take it past `maxBytes`. Throws as `appendFileSync`
 *  does: each caller keeps its own rule for a failed write. */
export function appendRotating(path: string, text: string, maxBytes = LOCAL_LOG_MAX_BYTES): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    // No file yet: nothing to rotate.
  }
  if (size > 0 && size + Buffer.byteLength(text) > maxBytes) {
    try {
      renameSync(path, `${path}.1`);
    } catch {
      // Gone in between: the append below starts it again.
    }
  }
  appendFileSync(path, text);
}
