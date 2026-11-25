// Lane XC: the pieces of the hand-off that need no runtime: what another computer's result reads as, and that a
// hook of the session's base options can't answer a call (agent SDK 0.0.87's `toolResult`).
import { describe, expect, test } from "bun:test";
import { treeResultText } from "../../../src/runtime-sdk/turn-loop/driver";
import { withoutAllow } from "../../../src/runtime-sdk/turn-loop/hook-merge";

describe("treeResultText", () => {
  test("Bash: stdout then stderr, the exit code when not 0, a timeout or a stop said", () => {
    expect(treeResultText("Bash", { stdout: "on Studio\n", stderr: "", code: 0, aborted: false })).toBe("on Studio");
    expect(treeResultText("Bash", { stdout: "a\n", stderr: "warn\n", code: 2, aborted: false })).toBe("a\nwarn\nExit code 2");
    expect(treeResultText("Bash", { stdout: "", stderr: "", code: null, timedOut: true, aborted: false })).toBe("(timed out)");
  });

  test("Glob and Grep as the runtime's own shapes; none found said", () => {
    expect(treeResultText("Glob", { paths: ["home/Studio/a.ts", "home/Studio/b.ts"], truncated: false })).toBe("home/Studio/a.ts\nhome/Studio/b.ts");
    expect(treeResultText("Glob", { paths: [], truncated: false })).toBe("No files found");
    expect(treeResultText("Grep", { matches: [{ path: "home/Studio/a.ts", line: 3, text: "x = 1" }], truncated: true })).toBe("home/Studio/a.ts:3:x = 1\n(more matches: narrow the search)");
  });

  test("Read's numbered text as it is; an error as its reason", () => {
    expect(treeResultText("Read", "     1\thello")).toBe("     1\thello");
    expect(treeResultText("Read", { error: "computer_offline", message: "Studio is offline", detail: { computer: "Studio" } })).toBe("Error: computer_offline: Studio is offline");
    expect(treeResultText("Write", { error: "refused" })).toBe("Error: refused");
  });
});

describe("a base hook's answer to a call", () => {
  test("is taken out and the call refused (an answer is an allow that skips the tool)", () => {
    const out = withoutAllow({ hookSpecificOutput: { hookEventName: "PreToolUse", toolResult: { content: "forged" } } }) as { hookSpecificOutput: Record<string, unknown> };
    expect(out.hookSpecificOutput.toolResult).toBeUndefined();
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
