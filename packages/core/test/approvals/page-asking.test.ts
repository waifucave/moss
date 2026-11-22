// A call a tool's PAGE asked for (MCP Apps) through a bot's approval check: its card says a page asks, is a card every time with no
// "always", and no saved rule of the model's call can answer it (the context's `pageAsking`, set only by the core's page doors).
import { expect, test } from "bun:test";
import { botApprovalCheck } from "../../src/approvals/bot-check";
import type { BotSessionContext } from "../../src/bots/service";
import type { ApprovalRequest } from "../../src/contracts/approval-broker";

const base = { botId: "luna", sessionId: "s1", kind: "bot", computer: "Studio", paths: { scratch: "/tmp" }, caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" } } as unknown as BotSessionContext;
const run = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" } as never;

function asked(ctx: BotSessionContext): Promise<ApprovalRequest> {
  return new Promise((resolve) => {
    const broker = { request: async (req: ApprovalRequest) => { resolve(req); return { allowed: false, by: "user" } as never; } };
    void botApprovalCheck(broker as never, { toolPlugin: () => "acme/charts" })(ctx, () => "user")("mcp__charts__refresh", { n: 1 }, run);
  });
}

test("a model's call of a plugin tool keeps its rule key and its \"always\"; a page's call has neither and says a page asks", async () => {
  const model = await asked(base);
  expect((model as { cardAlways?: boolean }).cardAlways).not.toBe(true);
  expect(model.options).toBeUndefined();
  const page = await asked({ ...base, pageAsking: { plugin: "acme/charts" } } as unknown as BotSessionContext);
  expect((page as { cardAlways?: boolean }).cardAlways).toBe(true);
  expect(page.ruleKey).toBeUndefined();
  expect(page.options?.map((o) => o.kind)).toEqual(["approve", "deny"]);
  expect(JSON.stringify(page.fields.reason)).toContain("A page shown by acme/charts asks to run refresh");
});

test("a page's call to a tool set to always allow runs with no card, and one plain line says so; a model's call logs nothing", async () => {
  const lines: string[] = [];
  const broker = { request: async () => { throw new Error("no card expected"); } };
  const check = botApprovalCheck(broker as never, { toolPlugin: () => "acme/charts", toolSetting: () => ({ setting: "allow" }), log: (l) => lines.push(l) });
  const page = await check({ ...base, pageAsking: { plugin: "acme/charts" } } as unknown as BotSessionContext, () => "user")("mcp__charts__refresh", { n: 1 }, run);
  expect(page?.behavior).toBe("allow");
  expect(lines).toEqual(["mcp-apps: a page shown by acme/charts ran mcp__charts__refresh with no card (the tool is set to always allow in Settings)"]);
  await check(base, () => "user")("mcp__charts__refresh", { n: 1 }, run);
  expect(lines).toHaveLength(1);
});
