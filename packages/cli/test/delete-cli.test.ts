// The person's deletions from their terminal (the deletion lane): nothing is sent without a terminal and DELETE typed.
import { describe, expect, test } from "bun:test";
import { runDelete } from "../src/delete-cli";

function env(o: { interactive?: boolean; typed?: string | null; answer?: unknown } = {}) {
  const sent: { method: string; params: unknown }[] = [];
  const lines: string[] = [];
  return {
    sent, lines,
    e: {
      request: async (method: string, params: unknown) => {
        sent.push({ method, params });
        return o.answer ?? { applied: true };
      },
      interactive: o.interactive ?? true,
      readLine: async () => (o.typed === undefined ? "DELETE" : o.typed),
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(l),
    },
  };
}

describe("moss account|session|bot delete", () => {
  test("typed DELETE: the engine's method with confirm, and what stays is said", async () => {
    const t = env({ answer: { applied: true, pending: ["sign-in"] } });
    expect(await runDelete(["account", "delete"], t.e)).toBe(0);
    expect(t.sent).toEqual([{ method: "account.delete", params: { confirm: true, typed: "DELETE" } }]);
    expect(t.lines.join("\n")).toContain("Stays:");
    expect(t.lines.join("\n")).toContain("sign-in");
    const s = env();
    expect(await runDelete(["session", "delete", "c_abc"], s.e)).toBe(0);
    expect(s.sent).toEqual([{ method: "session.delete", params: { id: "c_abc", confirm: true } }]);
    const b = env();
    expect(await runDelete(["bot", "delete", "nova"], b.e)).toBe(0);
    expect(b.sent).toEqual([{ method: "bot.delete", params: { id: "nova", confirm: true } }]);
  });

  test("without a terminal, or with anything but DELETE typed, nothing is sent", async () => {
    for (const o of [{ interactive: false }, { typed: "yes" }, { typed: null }]) {
      const t = env(o);
      expect(await runDelete(["bot", "delete", "nova"], t.e)).toBe(1);
      expect(t.sent).toEqual([]);
    }
  });

  test("a usage line for anything else", async () => {
    const t = env();
    expect(await runDelete(["session", "delete"], t.e)).toBe(2);
    expect(await runDelete(["bot", "rm", "x"], t.e)).toBe(2);
    expect(t.sent).toEqual([]);
  });
});
