// The one rule, read once (spec revision 20, §9.5): the protocol's `reachRefusal` for every pair of who sends and whom it
// reaches, with the engine's record of which bots have messaged the sender as a third dimension, each with its answer or the
// refusal's words, and the bots' `sendMessageRefusal` (bots/tools.ts) answering the same function.
//
// The owner's rule, 2026-11-22 (his words): "a session created by a bot may message that bot and any other session. that session
// cannot message other bots unless they message it first. a session created by the user may message any other session, it still
// cannot message bots unless these bots message it first". What a bot's own conversation or side thread reaches is as merged before.
import { describe, expect, test } from "bun:test";
import { mayReach, reachRefusal, startedByPerson, REACH_RULE_LINES, type SessionKind, type SessionStarter } from "@waifucave/moss-protocol";
import { sendMessageRefusal } from "../src/bots/tools";

interface Target { id: string; kind: SessionKind; bot?: string; parent?: string; startedBy?: SessionStarter }
interface From { id: string; kind: SessionKind; bot?: string }

const OK = "ok" as const;
type Expect = typeof OK | string;

/** A bot's own conversation, and one of its side threads: the bot itself, reading the rule as merged. */
const BOT_CONVERSATION: From = { id: "f", kind: "bot", bot: "moss" };
const BOT_SIDE_THREAD: From = { id: "f", kind: "side-thread", bot: "moss" };
/** A session a bot created (its background agent). */
const BOT_CREATED: From = { id: "f", kind: "agent", bot: "moss" };
/** A session the person created: no bot. */
const PERSON_CREATED: From = { id: "f", kind: "coding" };

const refusedBot = (id: string, kind: string) => `${id} is the user's own ${kind} session; SendMessage reaches only your bot's sessions, other bots' conversations and the sessions the user started themselves.`;
const refusedBotChild = (id: string) => `${id} is a session another of the user's sessions started; SendMessage reaches your bot's sessions, other bots' conversations and the sessions the user started themselves.`;
const belongs = (id: string, bot: string) => `${id} belongs to the bot ${bot}; message that bot's conversation instead (SendMessage with to: "${bot}").`;
/** What a session (a bot-created one, or the person's) is told about a bot it may not reach yet. */
const first = (id: string, what: "conversation" | "side thread", bots: boolean) =>
  `${id} is a bot's ${what}; a session reaches a bot only after that bot has messaged it first${bots ? " (your own bot always)" : ""}.`;

/** Every kind of target, with what each kind of sender is told while NO bot has messaged it. `agent` is a session a bot (`moss`)
 *  created, `person` a session the person created. */
const TABLE: { who: string; to: Target; botItself: Expect; agent: Expect; person: Expect }[] = [
  { who: "itself", to: { id: "f", kind: "coding" }, botItself: "That is this conversation; SendMessage reaches another one.", agent: "That is this session; SendMessage reaches another one.", person: "That is this session; SendMessage reaches another one." },
  { who: "its own bot's conversation", to: { id: "t1", kind: "bot", bot: "moss" }, botItself: OK, agent: OK, person: first("t1", "conversation", false) },
  { who: "its own bot's side thread", to: { id: "t2", kind: "side-thread", bot: "moss" }, botItself: OK, agent: OK, person: first("t2", "side thread", false) },
  { who: "its own bot's background agent", to: { id: "t3", kind: "agent", bot: "moss", parent: "t1" }, botItself: OK, agent: OK, person: OK },
  { who: "another bot's conversation", to: { id: "t4", kind: "bot", bot: "luna" }, botItself: OK, agent: first("t4", "conversation", true), person: first("t4", "conversation", false) },
  { who: "another bot's side thread", to: { id: "t5", kind: "side-thread", bot: "luna" }, botItself: belongs("t5", "luna"), agent: first("t5", "side thread", true), person: first("t5", "side thread", false) },
  { who: "another bot's background agent", to: { id: "t6", kind: "agent", bot: "luna", parent: "t4" }, botItself: belongs("t6", "luna"), agent: OK, person: OK },
  { who: "a code session the person started", to: { id: "t7", kind: "coding", startedBy: { kind: "user" } }, botItself: OK, agent: OK, person: OK },
  { who: "an agent session the person started", to: { id: "t8", kind: "agent", startedBy: { kind: "user" } }, botItself: OK, agent: OK, person: OK },
  { who: "a session from before revision 20 (no record of who started it, no parent)", to: { id: "t9", kind: "coding" }, botItself: OK, agent: OK, person: OK },
  { who: "a child another session started", to: { id: "t10", kind: "coding", parent: "t7", startedBy: { kind: "session", session: "t7" } }, botItself: refusedBotChild("t10"), agent: OK, person: OK },
  { who: "a child agent another session started", to: { id: "t11", kind: "agent", parent: "t7", startedBy: { kind: "session", session: "t7" } }, botItself: refusedBotChild("t11"), agent: OK, person: OK },
  { who: "a child from before revision 20 (a parent, no record)", to: { id: "t12", kind: "coding", parent: "t7" }, botItself: refusedBotChild("t12"), agent: OK, person: OK },
  { who: "a session a routine started, carrying no bot", to: { id: "t13", kind: "coding", startedBy: { kind: "routine", routine: "r" } }, botItself: refusedBotChild("t13"), agent: OK, person: OK },
  { who: "a side thread with no bot", to: { id: "t14", kind: "side-thread" }, botItself: refusedBot("t14", "side-thread"), agent: first("t14", "side thread", true), person: first("t14", "side thread", false) },
];

describe("reachRefusal: every pair of who sends and whom it reaches (no bot has messaged the sender)", () => {
  for (const row of TABLE) {
    test(`a bot's own conversation, and a side thread of it, to ${row.who}`, () => {
      for (const from of [BOT_CONVERSATION, BOT_SIDE_THREAD]) {
        expect(reachRefusal(from, row.to) ?? OK).toEqual(row.botItself);
        expect(sendMessageRefusal({ sessionId: from.id, bot: "moss", kind: from.kind }, row.to) ?? OK).toEqual(row.botItself);
      }
    });
    test(`a session a bot created to ${row.who}`, () => {
      expect(reachRefusal(BOT_CREATED, row.to) ?? OK).toEqual(row.agent);
    });
    test(`a session the person created to ${row.who}`, () => {
      expect(reachRefusal(PERSON_CREATED, row.to) ?? OK).toEqual(row.person);
    });
  }
});

describe("the third dimension: a bot that has messaged the sender first", () => {
  const BOT_TARGETS = TABLE.filter((r) => r.to.kind === "bot" || (r.to.kind === "side-thread" && r.to.bot !== undefined));

  test("a session reaches a bot's conversation and side threads once that bot has written to it, and not before, and not another bot's", () => {
    for (const row of BOT_TARGETS) {
      const bot = row.to.bot!;
      const other = bot === "luna" ? "moss" : "luna";
      for (const from of [BOT_CREATED, PERSON_CREATED]) {
        expect([from.kind, row.who, reachRefusal(from, row.to, (b) => b === bot) ?? OK]).toEqual([from.kind, row.who, OK]);
        // A different bot's message opens nothing; neither does no message at all.
        const expected = from === BOT_CREATED && bot === "moss" ? OK : (reachRefusal(from, row.to) ?? OK);
        expect([from.kind, row.who, reachRefusal(from, row.to, (b) => b === other) ?? OK]).toEqual([from.kind, row.who, expected]);
        expect([from.kind, row.who, reachRefusal(from, row.to, () => false) ?? OK]).toEqual([from.kind, row.who, expected]);
      }
    }
  });

  test("the bot's message opens that bot's conversation and side threads, never its agents or another bot's anything", () => {
    const wroteLuna = (b: string) => b === "luna";
    expect(reachRefusal(PERSON_CREATED, { id: "x", kind: "bot", bot: "luna" }, wroteLuna)).toBeUndefined();
    expect(reachRefusal(PERSON_CREATED, { id: "x", kind: "side-thread", bot: "luna" }, wroteLuna)).toBeUndefined();
    expect(reachRefusal(PERSON_CREATED, { id: "x", kind: "bot", bot: "moss" }, wroteLuna)).toBeDefined();
    expect(reachRefusal(PERSON_CREATED, { id: "x", kind: "side-thread", bot: "moss" }, wroteLuna)).toBeDefined();
    // A bot's agent is a session (it takes any session's message with no fact at all).
    expect(reachRefusal(PERSON_CREATED, { id: "x", kind: "agent", bot: "moss", parent: "b" })).toBeUndefined();
  });

  test("a bot's own conversation and side thread do not read the fact: they reach what they always did", () => {
    for (const row of TABLE) for (const from of [BOT_CONVERSATION, BOT_SIDE_THREAD]) {
      expect([row.who, reachRefusal(from, row.to, () => true) ?? OK]).toEqual([row.who, row.botItself]);
    }
  });

  test("an ended session takes nothing, from anyone, with the fact or without it", () => {
    const conversation = TABLE[1]!.to;
    const code = TABLE[7]!.to;
    for (const status of ["stopped", "failed"] as const) {
      for (const from of [BOT_CONVERSATION, BOT_CREATED, PERSON_CREATED]) {
        expect(mayReach(from, { ...code, status }, () => true)).toBe(false);
        expect(mayReach(from, { ...conversation, status }, () => true)).toBe(false);
      }
    }
    expect(mayReach(PERSON_CREATED, { ...code, status: "idle" })).toBe(true);
    expect(mayReach(PERSON_CREATED, { ...conversation, status: "idle" })).toBe(false);
    expect(mayReach(PERSON_CREATED, { ...conversation, status: "idle" }, (b) => b === "moss")).toBe(true);
  });

  test("the rule's lines are the owner's, with his words behind each", () => {
    expect(REACH_RULE_LINES.filter((l) => l.ruled === "owner").length).toBe(4);
    expect(REACH_RULE_LINES.length).toBe(6);
  });
});

describe("whether the person started a session", () => {
  test("its record, else (before revision 20) whether it has a parent", () => {
    expect(startedByPerson({ startedBy: { kind: "user" } })).toBe(true);
    expect(startedByPerson({ startedBy: { kind: "user" }, parent: "s_x" })).toBe(true);
    expect(startedByPerson({ startedBy: { kind: "session", session: "s_x" } })).toBe(false);
    expect(startedByPerson({ startedBy: { kind: "bot", bot: "moss" } })).toBe(false);
    expect(startedByPerson({})).toBe(true);
    expect(startedByPerson({ parent: "s_x" })).toBe(false);
  });
});
