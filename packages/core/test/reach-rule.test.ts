// The one rule, read once (spec revision 20, §9.5): the protocol's `reachRefusal` for every pair of who sends and whom it
// reaches, each with its answer or the refusal's words, and the bots' `sendMessageRefusal` (bots/tools.ts) answering the
// same function. The owner's ruling of 2026-11-22: any session reaches a session the person started themselves, a bot's too.
import { describe, expect, test } from "bun:test";
import { mayReach, reachRefusal, startedByPerson, type SessionKind, type SessionStarter } from "@waifucave/moss-protocol";
import { sendMessageRefusal } from "../src/bots/tools";

interface Target { id: string; kind: SessionKind; bot?: string; parent?: string; startedBy?: SessionStarter }

const OK = "ok" as const;
type Expect = typeof OK | string;

/** A bot's session (`moss`): conversation, side thread, background agent all read the same, by the bot they carry. */
const BOT_FROM = { id: "f", bot: "moss" };
/** A session the person drives: no bot. */
const PERSON_FROM = { id: "f" };

const refusedBot = (id: string, kind: string) => `${id} is the user's own ${kind} session; SendMessage reaches only your bot's sessions, other bots' conversations and the sessions the user started themselves.`;
const refusedBotChild = (id: string) => `${id} is a session another of the user's sessions started; SendMessage reaches your bot's sessions, other bots' conversations and the sessions the user started themselves.`;
const belongs = (id: string, bot: string) => `${id} belongs to the bot ${bot}; message that bot's conversation instead (SendMessage with to: "${bot}").`;
const personBot = (id: string) => `${id} is a bot's conversation; a session you drive reaches only your other code sessions.`;
const personBelongs = (id: string, bot: string) => `${id} belongs to the bot ${bot}; a session you drive reaches only your other code sessions.`;

/** Every kind of target, with what a bot's session and a session the person drives are each told. */
const TABLE: { who: string; to: Target; bot: Expect; person: Expect }[] = [
  { who: "itself", to: { id: "f", kind: "coding" }, bot: "That is this conversation; SendMessage reaches another one.", person: "That is this session; SendMessage reaches another one." },
  { who: "its own bot's conversation", to: { id: "t1", kind: "bot", bot: "moss" }, bot: OK, person: personBot("t1") },
  { who: "its own bot's side thread", to: { id: "t2", kind: "side-thread", bot: "moss" }, bot: OK, person: personBelongs("t2", "moss") },
  { who: "its own bot's background agent", to: { id: "t3", kind: "agent", bot: "moss", parent: "t1" }, bot: OK, person: personBelongs("t3", "moss") },
  { who: "another bot's conversation", to: { id: "t4", kind: "bot", bot: "luna" }, bot: OK, person: personBot("t4") },
  { who: "another bot's side thread", to: { id: "t5", kind: "side-thread", bot: "luna" }, bot: belongs("t5", "luna"), person: personBelongs("t5", "luna") },
  { who: "another bot's background agent", to: { id: "t6", kind: "agent", bot: "luna", parent: "t4" }, bot: belongs("t6", "luna"), person: personBelongs("t6", "luna") },
  { who: "a code session the person started", to: { id: "t7", kind: "coding", startedBy: { kind: "user" } }, bot: OK, person: OK },
  { who: "an agent session the person started", to: { id: "t8", kind: "agent", startedBy: { kind: "user" } }, bot: OK, person: OK },
  { who: "a session from before revision 20 (no record of who started it, no parent)", to: { id: "t9", kind: "coding" }, bot: OK, person: OK },
  { who: "a child another session started", to: { id: "t10", kind: "coding", parent: "t7", startedBy: { kind: "session", session: "t7" } }, bot: refusedBotChild("t10"), person: OK },
  { who: "a child agent another session started", to: { id: "t11", kind: "agent", parent: "t7", startedBy: { kind: "session", session: "t7" } }, bot: refusedBotChild("t11"), person: OK },
  { who: "a child from before revision 20 (a parent, no record)", to: { id: "t12", kind: "coding", parent: "t7" }, bot: refusedBotChild("t12"), person: OK },
  { who: "a session a routine started, carrying no bot", to: { id: "t13", kind: "coding", startedBy: { kind: "routine", routine: "r" } }, bot: refusedBotChild("t13"), person: OK },
  { who: "a side thread with no bot", to: { id: "t14", kind: "side-thread" }, bot: refusedBot("t14", "side-thread"), person: personBelongs("t14", "?") },
];

describe("reachRefusal: every pair of who sends and whom it reaches", () => {
  for (const row of TABLE) {
    test(`a bot's session to ${row.who}`, () => {
      expect(reachRefusal(BOT_FROM, row.to) ?? OK).toEqual(row.bot);
      expect(sendMessageRefusal({ sessionId: BOT_FROM.id, bot: "moss" }, row.to) ?? OK).toEqual(row.bot);
    });
    test(`a session the person drives to ${row.who}`, () => {
      expect(reachRefusal(PERSON_FROM, row.to) ?? OK).toEqual(row.person);
    });
  }

  test("an ended session takes nothing, from anyone", () => {
    for (const to of [TABLE[1]!.to, TABLE[7]!.to]) {
      for (const status of ["stopped", "failed"] as const) {
        expect(mayReach(BOT_FROM, { ...to, status })).toBe(false);
        expect(mayReach(PERSON_FROM, { ...to, status })).toBe(false);
      }
    }
    expect(mayReach(BOT_FROM, { ...TABLE[7]!.to, status: "idle" })).toBe(true);
  });

  test("whether the person started a session: its record, else (before revision 20) whether it has a parent", () => {
    expect(startedByPerson({ startedBy: { kind: "user" } })).toBe(true);
    expect(startedByPerson({ startedBy: { kind: "user" }, parent: "s_x" })).toBe(true);
    expect(startedByPerson({ startedBy: { kind: "session", session: "s_x" } })).toBe(false);
    expect(startedByPerson({ startedBy: { kind: "bot", bot: "moss" } })).toBe(false);
    expect(startedByPerson({})).toBe(true);
    expect(startedByPerson({ parent: "s_x" })).toBe(false);
  });
});
