// The deletion lane, item 6: a bot session's agent runtime prints to its stderr whatever it likes (an error that echoes a
// request, a tool's output), and that used to be copied verbatim into the engine log, which is kept long and never
// deleted with the conversation. It now goes to the session's own file beside its runtime state (deleted with the
// session), and the engine log says only that the runtime wrote, how much, and where.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeStderrPath, runtimeStderrSink } from "../runtime-stderr";

describe("a bot session's runtime stderr", () => {
  test("goes to the session's own file, never into the engine log", () => {
    const home = mkdtempSync(join(tmpdir(), "moss-stderr-"));
    const lines: string[] = [];
    const sink = runtimeStderrSink({ home, sessionId: "s_bot1", log: (l) => lines.push(l) });
    sink("API error: the request said SENTINEL-MESSAGE-7731 and the tool said SENTINEL-TOOL-4410\n");
    sink("second line SENTINEL-MESSAGE-7731\n");
    const engineLog = lines.join("\n");
    expect(engineLog).not.toContain("SENTINEL");
    expect(engineLog).toContain("s_bot1");
    // One note per session, not one per chunk.
    expect(lines).toHaveLength(1);
    const file = runtimeStderrPath(home, "s_bot1");
    expect(readFileSync(file, "utf8")).toContain("SENTINEL-TOOL-4410");
  });

  test("the file is capped: past the cap the older half is kept as .1", () => {
    const home = mkdtempSync(join(tmpdir(), "moss-stderr-"));
    const sink = runtimeStderrSink({ home, sessionId: "s_bot2", log: () => undefined, maxBytes: 1024 });
    for (let i = 0; i < 50; i++) sink(`${"x".repeat(100)}\n`);
    const file = runtimeStderrPath(home, "s_bot2");
    expect(statSync(file).size).toBeLessThanOrEqual(1024);
    expect(existsSync(`${file}.1`)).toBe(true);
  });
});
