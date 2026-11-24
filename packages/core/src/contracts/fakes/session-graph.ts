// FakeSessionGraph: the graph in memory. FakeSessionSource: sessions and links played from a scene (`SAMPLE_SESSION_SCENE`
// or a test's own), for anything that reads sessions to be built before the engine serves the graph.
import {
  SUBAGENTS_MAX, SESSION_LINKS_RECENT_MAX, SessionLinkEvent, SessionSubagent, foldSessionEvents, pluginMayHear, MOSS_EVENTS,
  type SessionLinkPair, type SessionLinksResult,
  type SessionGraphState, type SessionKind, type SessionLinkKind, type SessionSceneStep, type SessionStarter, type SessionView,
} from "@waifucave/moss-protocol";
import type { FeedReader } from "../activity-feed";
import { ContractError, Listeners, type Unsubscribe } from "../common";
import type { SessionGraph, SessionGraphFields } from "../session-graph";

interface Node {
  kind: SessionKind;
  bot?: string;
  by: SessionStarter;
  ended: boolean;
  idle: boolean;
  tasks: Set<string>;
  subagents: SessionSubagent[];
}

const LINK_SPEC = MOSS_EVENTS.get("session_link")!;

/** Whether a reader may hear a link: the user always; a plugin by both ends' kinds. */
export function readerHearsLink(reader: FeedReader, link: SessionLinkEvent): boolean {
  return reader.kind === "user" || pluginMayHear(LINK_SPEC, reader.capabilities, link);
}

export class FakeSessionGraph implements SessionGraph {
  readonly #nodes = new Map<string, Node>();
  readonly #changes = new Listeners<{ session: string; fields: SessionGraphFields }>();
  readonly #links = new Set<{ reader: FeedReader; fn: (l: SessionLinkEvent) => void }>();
  readonly #last = new Map<string, string>();
  /** Every link between two sessions, in order (the pairs are counted from it). */
  #kept: SessionLinkEvent[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  #node(id: string): Node {
    const n = this.#nodes.get(id);
    if (n === undefined) throw new ContractError("invalid", `no session ${id}`);
    return n;
  }

  #starterOf(n: Node): string | undefined {
    return n.by.kind === "session" ? n.by.session : n.by.kind === "bot" ? n.by.session : undefined;
  }

  #changed(id: string): void {
    if (!this.#nodes.has(id)) return;
    const fields = this.fields(id);
    const key = JSON.stringify(fields);
    if (this.#last.get(id) === key) return;
    this.#last.set(id, key);
    this.#changes.emit({ session: id, fields });
  }

  started(session: string, kind: SessionKind, by: SessionStarter, bot?: string): void {
    if (this.#nodes.has(session)) throw new ContractError("conflict", `${session} has started already`);
    const node: Node = { kind, by, ended: false, idle: false, tasks: new Set(), subagents: [], ...(bot !== undefined ? { bot } : {}) };
    this.#nodes.set(session, node);
    this.#changed(session);
    const starter = this.#starterOf(node);
    if (starter !== undefined) this.#changed(starter);
  }

  ended(session: string): void {
    const n = this.#node(session);
    if (n.ended) return;
    n.ended = true;
    n.tasks.clear();
    this.#kept = this.#kept.filter((l) => l.to.session !== session && (l.from.end !== "session" || l.from.session !== session));
    this.#changed(session);
    const starter = this.#starterOf(n);
    if (starter !== undefined) this.#changed(starter);
  }

  taskStarted(session: string, task: string): void {
    const n = this.#node(session);
    if (n.ended) return;
    n.tasks.add(task);
    this.#changed(session);
    const starter = n.idle ? this.#starterOf(n) : undefined;
    if (starter !== undefined) this.#changed(starter);
  }

  taskEnded(session: string, task: string): void {
    const n = this.#node(session);
    n.tasks.delete(task);
    this.#changed(session);
    const starter = n.idle ? this.#starterOf(n) : undefined;
    if (starter !== undefined) this.#changed(starter);
  }

  subagent(parent: string, row: SessionSubagent): void {
    const n = this.#node(parent);
    const parsed = SessionSubagent.safeParse(row);
    if (!parsed.success) throw new ContractError("invalid", "a subagent row is an id, a name, a model, a state and its times");
    let r = parsed.data;
    if (r.state !== "running" && r.endedAt === undefined) r = { ...r, endedAt: this.now() };
    const at = n.subagents.findIndex((s) => s.id === r.id);
    if (at >= 0) n.subagents[at] = { ...r, startedAt: n.subagents[at]!.startedAt };
    else n.subagents.push(r);
    while (n.subagents.length > SUBAGENTS_MAX) {
      const ended = n.subagents.findIndex((s) => s.state !== "running");
      n.subagents.splice(ended >= 0 ? ended : 0, 1);
    }
    this.#changed(parent);
  }

  idled(session: string): void {
    const n = this.#node(session);
    if (n.ended || n.idle) return;
    n.idle = true;
    const starter = this.#starterOf(n);
    if (starter !== undefined) this.#changed(starter);
  }

  busy(session: string): void {
    const n = this.#node(session);
    if (!n.idle) return;
    n.idle = false;
    const starter = this.#starterOf(n);
    if (starter !== undefined) this.#changed(starter);
  }

  link(from: string | undefined, to: string, kind: SessionLinkKind): SessionLinkEvent {
    if (from === to) throw new ContractError("invalid", "a link joins two sessions");
    const t = this.#node(to);
    const f = from === undefined ? undefined : this.#node(from);
    const event = SessionLinkEvent.parse({
      type: "session_link", ts: this.now(),
      from: f === undefined ? { end: "user" } : { end: "session", session: from, kind: f.kind, ...(f.bot !== undefined ? { bot: f.bot } : {}) },
      to: { session: to, kind: t.kind, ...(t.bot !== undefined ? { bot: t.bot } : {}) },
      link: kind,
    });
    if (event.from.end === "session") this.#kept.push(event);
    for (const l of [...this.#links]) if (readerHearsLink(l.reader, event)) l.fn(event);
    return event;
  }

  links(reader: FeedReader, since?: number): SessionLinksResult {
    const heard = this.#kept.filter((l) => readerHearsLink(reader, l));
    const pairs = new Map<string, SessionLinkPair>();
    for (const l of heard) {
      if (l.from.end !== "session") continue;
      const key = `${l.from.session}>${l.to.session}`;
      const old = pairs.get(key);
      pairs.set(key, { from: l.from, to: l.to, last: l.link, lastAt: l.ts, count: (old?.count ?? 0) + 1 });
    }
    const recent = heard.slice(-SESSION_LINKS_RECENT_MAX).filter((l) => since === undefined || l.ts > since);
    return { pairs: [...pairs.values()], links: recent.map((l) => ({ ...l })) };
  }

  fields(session: string): SessionGraphFields {
    const n = this.#node(session);
    const children = [...this.#nodes.values()].filter((c) => !c.ended && (!c.idle || c.tasks.size > 0) && this.#starterOf(c) === session).length;
    const tasks = n.tasks.size;
    return {
      startedBy: n.by,
      ...(tasks + children > 0 ? { waiting: { tasks, children } } : {}),
      ...(n.subagents.length > 0 ? { subagents: n.subagents.map((s) => ({ ...s })) } : {}),
    };
  }

  watch(fn: (change: { session: string; fields: SessionGraphFields }) => void): Unsubscribe {
    return this.#changes.add(fn);
  }

  watchLinks(reader: FeedReader, fn: (link: SessionLinkEvent) => void): Unsubscribe {
    const entry = { reader, fn };
    this.#links.add(entry);
    return () => void this.#links.delete(entry);
  }
}

/** Sessions and links from a scene, as a reader of the engine sees them: `list`, `watch` for views and `watchLinks`
 *  (gated by both ends' kinds), played with `schedule` (a test's own clock; timers by default). */
export class FakeSessionSource {
  #state: SessionGraphState = foldSessionEvents([]);
  readonly #views = new Listeners<SessionView>();
  readonly #links = new Set<{ reader: FeedReader; fn: (l: SessionLinkEvent) => void }>();

  play(scene: readonly SessionSceneStep[], schedule: (ms: number, fn: () => void) => () => void = (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  }): () => void {
    const stops = scene.map((step) => schedule(step.at, () => this.apply(step.event)));
    return () => { for (const s of stops) s(); };
  }

  /** One wire event, now. */
  apply(event: SessionSceneStep["event"]): void {
    this.#state = foldSessionEvents([event], this.#state);
    if (event.type === "session_changed") this.#views.emit(event.session);
    else for (const l of [...this.#links]) if (readerHearsLink(l.reader, event)) l.fn(event);
  }

  list(): SessionView[] {
    return Object.values(this.#state.sessions);
  }

  watch(fn: (view: SessionView) => void): Unsubscribe {
    return this.#views.add(fn);
  }

  watchLinks(reader: FeedReader, fn: (link: SessionLinkEvent) => void): Unsubscribe {
    const entry = { reader, fn };
    this.#links.add(entry);
    return () => void this.#links.delete(entry);
  }
}
