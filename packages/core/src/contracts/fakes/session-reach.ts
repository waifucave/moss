// FakeSessionMessenger: the door over a world the test gives, with the protocol's rule and the per-session limit.
import {
  LIST_SESSIONS_MAX, ReachableSession, SESSION_SEND_LIMIT, SESSION_SEND_WINDOW_MS, SendMessageToolInput, mayReach, reachRefusal,
  resolveSessionTo, type SessionView,
} from "@waifucave/moss-protocol";
import type { SessionMessenger, SessionMessengerWorld } from "../session-reach";

export class FakeSessionMessenger implements SessionMessenger {
  readonly #sent = new Map<string, number[]>();

  constructor(private readonly world: SessionMessengerWorld) {}

  #view(id: string): SessionView | undefined {
    return this.world.sessions().find((s) => s.id === id);
  }

  reachable(from: string): ReachableSession[] {
    const me = this.#view(from);
    if (me === undefined) return [];
    return this.world.sessions().filter((s) => mayReach({ id: me.id, bot: me.bot }, s)).slice(0, LIST_SESSIONS_MAX).map((s) => ReachableSession.parse(s));
  }

  async send(from: string, raw: SendMessageToolInput): Promise<{ delivered: string } | { refused: string }> {
    const input = SendMessageToolInput.safeParse(raw);
    if (!input.success) return { refused: "SendMessage takes a message and, to name a session, `to`." };
    const me = this.#view(from);
    if (me === undefined) return { refused: "This session isn't known here." };
    let to: string;
    if (input.data.to === undefined) {
      if (me.bot === undefined || me.parent === undefined) return { refused: "Name the session with `to`; ListSessions lists the ones you may message." };
      to = me.parent;
    } else {
      const hit = resolveSessionTo(input.data.to, this.world.sessions().filter((s) => s.id === input.data.to!.trim() || mayReach({ id: me.id, bot: me.bot }, s)));
      if ("error" in hit) return { refused: hit.error };
      to = hit.session;
    }
    const target = this.#view(to);
    if (target === undefined) return { refused: `No session ${to}.` };
    const why = reachRefusal({ id: me.id, bot: me.bot }, target);
    if (why !== undefined) return { refused: why };
    if (target.status === "stopped" || target.status === "failed") return { refused: `${to} has ended; it takes no messages.` };
    const now = this.world.now();
    const recent = (this.#sent.get(from) ?? []).filter((t) => now - t < SESSION_SEND_WINDOW_MS);
    if (recent.length >= SESSION_SEND_LIMIT) {
      this.#sent.set(from, recent);
      return { refused: `Too many messages: at most ${SESSION_SEND_LIMIT} a minute.` };
    }
    recent.push(now);
    this.#sent.set(from, recent);
    const text = input.data.message;
    if (me.bot === undefined) this.world.deliver(to, { from: "session", session: from, text });
    else if (me.kind === "agent") this.world.deliver(to, { from: "agent", agent: from, text });
    else this.world.deliver(to, { from: "bot", bot: me.bot, session: from, text });
    this.world.link(from, to);
    return { delivered: to };
  }
}
