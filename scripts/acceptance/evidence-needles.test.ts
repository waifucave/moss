// Every log line a step of the acceptance run looks for by its literal text in the app's log is a line of the evidence list
// (scripts/acceptance/evidence-lines.ts), which apps/desktop/test/file-log.test.ts holds against the real build's file filter.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_LINES } from "./evidence-lines";

describe("the acceptance steps' log needles", () => {
    // The literal strings the steps look for in the app's log (`includes("layers: ...")`): each is a line of the list. A step that starts
    // relying on a line adds it to scripts/acceptance/evidence-lines.ts and classes it in file-log.ts. What is not a line of its own (an id, a
    // fragment, a line of the MOSS app, which has its own file filter) is not here; the one line no code writes any more is named.
    test("every log line a step looks for by its literal text is in the evidence list", () => {
      const dir = import.meta.dir;
      const NOT_A_LINE_OF_THIS_APP = new Set(["the window's strip for x"]);
      const uncovered: string[] = [];
      let needles = 0;
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "evidence-lines.ts" && !n.endsWith(".test.ts"))) {
        for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
          if (!/appLog|app\.log/.test(l)) continue;
          for (const m of l.matchAll(/\.includes\((["`])((?:(?!\1).)*)\1\)/g)) {
            const needle = m[2]!.replace(/\$\{[^}]*\}/g, "x");
            if (!/^[a-z][a-z -]{0,24}: /.test(needle) || needle.includes("MOSS's")) continue;
            needles++;
            const covered = EVIDENCE_LINES.some((e) => [needle, `${needle}x`, `${needle} x`].some((n) => e.re.test(n)) || e.example.includes(needle));
            if (!covered && !NOT_A_LINE_OF_THIS_APP.has(needle)) uncovered.push(`${f}: ${needle}`);
          }
        }
      }
      expect(uncovered).toEqual([]);
      expect(needles).toBeGreaterThan(8);
    });
});
