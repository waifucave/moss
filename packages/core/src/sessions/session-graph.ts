// The engine's session graph (spec revision 20, §9.5; contract `SessionGraph`, contracts/session-graph.ts). Owner: lane CG.
//
// How sessions hang together, kept in memory beside the host (durable-host.ts), which tells it what happens and adds its
// fields to every view it serves:
// * who started each session (`startedBy`), set once: the host persists it in the session's meta, so a restart registers
//   the same starter again;
// * what a session waits on (`waiting`): its background tasks that will wake it (a backend's task frames, never
//   persisted: a restart has none running) and the sessions it started that have not ended and are not idle (an agent whose
//   turn ended waits for its next message; its starter doesn't wait for it). Children are indexed by their
//   starter, so a read never scans every session (a home holds tens of thousands of ended side threads);
// * the subagents its agent reported (`subagents`), at most `SUBAGENTS_MAX`, the oldest ended ones dropped first; an
//   ended row never runs again;
// * the links (`session_link`): one per delivery from a session (or the person) to another, with no words, heard only by
//   a reader that may read both ends' kinds (`pluginMayHear`, the core events' own gate).
// * the record of links between two sessions (`links`): per pair the last link and a count (at most
//   `SESSION_LINK_PAIRS_MAX` pairs, the most lately used kept), and the newest `SESSION_LINKS_RECENT_MAX` links in order,
//   kept through a `LinkStore` (the host's file beside the transcripts) so it survives a restart; a link from the person
//   joins no two sessions and isn't kept; a session that ends takes its pairs and links with it. At most about 0.5 MB on
//   disk, a few KB in a usual home; written atomically at most once every `LINKS_SAVE_AFTER_MS` while links come (one
//   timer per burst, never a tick), and at once when a session ends and at the host's close.
// Nothing here ticks: every change is a call from the host or a backend.
import {
  MOSS_EVENTS, SESSION_LINK_PAIRS_MAX, SESSION_LINKS_RECENT_MAX, SUBAGENTS_MAX, SessionLinkEvent, SessionLinkPair, SessionSubagent, pluginMayHear,
  type SessionKind, type SessionLinkKind, type SessionLinksResult, type SessionStarter,
} from "@waifucave/moss-protocol";
import type { FeedReader } from "../contracts/activity-feed";
import { ContractError, Listeners, type Unsubscribe } from "../contracts/common";
import type { SessionGraph, SessionGraphFields } from "../contracts/session-graph";

interface Node {
  kind: SessionKind;
  bot?: string;
  by: SessionStarter;
  /** The session it counts as a child of while it runs: its starter's session, when a session started it. */
  starter?: string;
  ended: boolean;
  tasks: Set<string>;
  subagents: SessionSubagent[];
  /** The first delivery from its starter has been heard (that one is the spawn). */
  spawned: boolean;
  /** Its turn ended and nothing is queued for it: it sits idle, which its starter doesn't wait for (`waiting.children`),
   *  until its next turn begins. A child that has not run its first turn is not idle. */
  idle: boolean;
}

const LINK_SPEC = MOSS_EVENTS.get("session_link");

/** Whether a reader may hear a link: the person always; a plugin only when it may read both ends' kinds. */
export function mayHearLink(reader: FeedReader, link: SessionLinkEvent): boolean {
  if (reader.kind === "user") return true;
  return LINK_SPEC !== undefined && pluginMayHear(LINK_SPEC, reader.capabilities, link);
}

/** The session a starter makes its session a child of: another session's, or a bot's from one of its sessions. A
 *  routine's run and the person's sessions are nobody's child. */
export function starterSessionOf(by: SessionStarter): string | undefined {
  return by.kind === "session" ? by.session : by.kind === "bot" ? by.session : undefined;
}

/** Who started a session, as its kind, bot, parent and routine say (a session from before revision 20 carries no
 *  `startedBy`; one whose opener names none gets this): a bot's agent its bot's, from the session that asked; a session
 *  with a parent and no bot the parent's; a routine's side thread its routine's; a bot's other side threads its bot's; a
 *  bot's conversation and the person's code sessions the person's. */
export function derivedStarter(s: { kind: SessionKind; bot?: string | undefined; parent?: string | undefined; routine?: string | undefined }): SessionStarter {
  if (s.kind === "agent" && s.bot !== undefined) return { kind: "bot", bot: s.bot, ...(s.parent === undefined ? {} : { session: s.parent }) };
  if (s.kind === "side-thread" && s.routine !== undefined) return { kind: "routine", routine: s.routine.slice(0, 128), ...(s.bot === undefined ? {} : { bot: s.bot }) };
  if (s.kind === "side-thread" && s.bot !== undefined) return { kind: "bot", bot: s.bot, ...(s.parent === undefined ? {} : { session: s.parent }) };
  if (s.parent !== undefined && s.bot === undefined) return { kind: "session", session: s.parent };
  return { kind: "user" };
}

/** The links record as it is kept on disk. */
export interface KeptLinks {
  v: 1;
  pairs: SessionLinkPair[];
  recent: SessionLinkEvent[];
}

/** Where the links record lives between restarts. */
export interface LinkStore {
  load(): unknown;
  save(kept: KeptLinks): void;
}

/** How long a kept link waits before the record is written: a burst of links is one write. */
export const LINKS_SAVE_AFTER_MS = 3_000;

/** The one timer a pending write uses (a test's own clock; `setTimeout`, unref'd, by default). */
export interface SaveTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMER: SaveTimer = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const pairKey = (from: string, to: string) => `${from}\u0000${to}`;
const fromSession = (l: { from: SessionLinkEvent["from"] }) => (l.from.end === "session" ? l.from.session : undefined);

export class EngineSessionGraph implements SessionGraph {
  readonly #now: () => number;
  readonly #store: LinkStore | undefined;
  readonly #timer: SaveTimer;
  /** The write a kept link is waiting for, if one is. */
  #pendingSave: unknown;
  /** Each pair's last link and count, by `from`/`to`. */
  readonly #pairs = new Map<string, SessionLinkPair>();
  /** The newest links between sessions, oldest first. */
  #recent: SessionLinkEvent[] = [];
  readonly #nodes = new Map<string, Node>();
  /** Each starter's children that have not ended. */
  readonly #children = new Map<string, Set<string>>();
  readonly #changes = new Listeners<{ session: string; fields: SessionGraphFields }>();
  readonly #links = new Set<{ reader: FeedReader; fn: (l: SessionLinkEvent) => void }>();
  /** What each session's fields were when last heard, so an unchanged one isn't heard again. */
  readonly #last = new Map<string, string>();

  constructor(now: () => number = Date.now, store?: LinkStore, timer: SaveTimer = DEFAULT_TIMER) {
    this.#now = now;
    this.#store = store;
    this.#timer = timer;
    this.#loadLinks();
  }

  /** The kept record, each entry checked; a file that doesn't read is an empty record, never a failed start. */
  #loadLinks(): void {
    let raw: unknown;
    try {
      raw = this.#store?.load();
    } catch {
      return;
    }
    if (raw === null || typeof raw !== "object" || (raw as { v?: unknown }).v !== 1) return;
    const { pairs, recent } = raw as { pairs?: unknown; recent?: unknown };
    for (const p of Array.isArray(pairs) ? pairs.slice(-SESSION_LINK_PAIRS_MAX) : []) {
      const ok = SessionLinkPair.safeParse(p);
      const from = ok.success ? fromSession(ok.data) : undefined;
      if (ok.success && from !== undefined) this.#pairs.set(pairKey(from, ok.data.to.session), ok.data);
    }
    for (const l of Array.isArray(recent) ? recent.slice(-SESSION_LINKS_RECENT_MAX) : []) {
      const ok = SessionLinkEvent.safeParse(l);
      if (ok.success && ok.data.from.end === "session") this.#recent.push(ok.data);
    }
  }

  /** A write within `LINKS_SAVE_AFTER_MS`, one for every link of a burst. */
  #saveSoon(): void {
    if (this.#store === undefined || this.#pendingSave !== undefined) return;
    const mine = this.#timer.set(() => {
      // A timer a flush has already answered (cleared, yet fired) writes nothing more.
      if (this.#pendingSave !== mine) return;
      this.#pendingSave = undefined;
      this.#saveLinks();
    }, LINKS_SAVE_AFTER_MS);
    this.#pendingSave = mine;
  }

  /** Writes what waits now (a clean stop). */
  flush(): void {
    if (this.#pendingSave === undefined) return;
    this.#saveLinks();
  }

  #saveLinks(): void {
    if (this.#pendingSave !== undefined) {
      this.#timer.clear(this.#pendingSave);
      this.#pendingSave = undefined;
    }
    if (this.#store === undefined) return;
    // A session known here to have ended (one a restart registered as ended) takes its entries out of the file too.
    const gone = (id: string | undefined) => id !== undefined && this.#nodes.get(id)?.ended === true;
    for (const [k, p] of this.#pairs) if (gone(p.to.session) || gone(fromSession(p))) this.#pairs.delete(k);
    this.#recent = this.#recent.filter((l) => !gone(l.to.session) && !gone(fromSession(l)));
    try {
      this.#store.save({ v: 1, pairs: [...this.#pairs.values()], recent: [...this.#recent] });
    } catch {
      // The record is a convenience: a refused write keeps it in memory, and the next link tries again.
    }
  }

  /** A kept link's session that has ended here (or never was) is no longer drawn. */
  #live(id: string): boolean {
    const n = this.#nodes.get(id);
    return n !== undefined && !n.ended;
  }

  /** Every pair and link that names `session` goes (it ended, or left). */
  #dropLinksOf(session: string): void {
    let changed = false;
    for (const [k, p] of this.#pairs) {
      if (p.to.session !== session && fromSession(p) !== session) continue;
      this.#pairs.delete(k);
      changed = true;
    }
    const kept = this.#recent.filter((l) => l.to.session !== session && fromSession(l) !== session);
    if (kept.length !== this.#recent.length) {
      this.#recent = kept;
      changed = true;
    }
    // A session's end writes at once: its pairs going, or a write that was waiting.
    if (changed || this.#pendingSave !== undefined) this.#saveLinks();
  }

  #keep(event: SessionLinkEvent): void {
    const from = fromSession(event);
    if (from === undefined) return;
    const key = pairKey(from, event.to.session);
    const old = this.#pairs.get(key);
    // Re-inserted, so the map is in the order pairs were last used: the oldest goes first past the bound.
    this.#pairs.delete(key);
    this.#pairs.set(key, { from: event.from, to: event.to, last: event.link, lastAt: event.ts, count: (old?.count ?? 0) + 1 });
    while (this.#pairs.size > SESSION_LINK_PAIRS_MAX) this.#pairs.delete(this.#pairs.keys().next().value!);
    this.#recent.push(event);
    if (this.#recent.length > SESSION_LINKS_RECENT_MAX) this.#recent.splice(0, this.#recent.length - SESSION_LINKS_RECENT_MAX);
    this.#saveSoon();
  }

  links(reader: FeedReader, since?: number): SessionLinksResult {
    const drawn = (l: { from: SessionLinkEvent["from"]; to: { session: string } }) => this.#live(l.to.session) && this.#live(fromSession(l) ?? "");
    const asEvent = (p: SessionLinkPair): SessionLinkEvent => ({ type: "session_link", ts: p.lastAt, from: p.from, to: p.to, link: p.last });
    return {
      pairs: [...this.#pairs.values()].filter((p) => drawn(p) && mayHearLink(reader, asEvent(p))).map((p) => structuredClone(p)),
      links: this.#recent.filter((l) => (since === undefined || l.ts > since) && drawn(l) && mayHearLink(reader, l)).map((l) => structuredClone(l)),
    };
  }

  #node(id: string): Node {
    const n = this.#nodes.get(id);
    if (n === undefined) throw new ContractError("invalid", `no session ${id}`);
    return n;
  }

  #changed(id: string): void {
    if (!this.#nodes.has(id)) return;
    const fields = this.fields(id);
    const key = JSON.stringify(fields);
    if (this.#last.get(id) === key) return;
    this.#last.set(id, key);
    this.#changes.emit({ session: id, fields });
  }

  has(session: string): boolean {
    return this.#nodes.has(session);
  }

  started(session: string, kind: SessionKind, by: SessionStarter, bot?: string, opts: { ended?: boolean; quiet?: boolean } = {}): void {
    if (this.#nodes.has(session)) throw new ContractError("conflict", `${session} has started already`);
    const starter = starterSessionOf(by);
    const node: Node = {
      kind, by: structuredClone(by), ended: opts.ended === true, tasks: new Set(), subagents: [], spawned: false, idle: false,
      ...(bot === undefined ? {} : { bot }), ...(starter === undefined || starter === session ? {} : { starter }),
    };
    this.#nodes.set(session, node);
    if (node.starter !== undefined && !node.ended) this.#childSet(node.starter).add(session);
    // `quiet`: the session's own view is sent by its opener (or read when someone asks, for one registered after a
    // restart: tens of thousands of ended side threads cost nothing more); its starter still hears one more child.
    if (opts.quiet !== true) this.#changed(session);
    if (node.starter !== undefined && !node.ended) this.#changed(node.starter);
  }

  #childSet(starter: string): Set<string> {
    let set = this.#children.get(starter);
    if (set === undefined) {
      set = new Set();
      this.#children.set(starter, set);
    }
    return set;
  }

  ended(session: string): void {
    const n = this.#node(session);
    if (n.ended) return;
    n.ended = true;
    n.tasks.clear();
    this.#dropLinksOf(session);
    if (n.starter !== undefined) {
      const set = this.#children.get(n.starter);
      set?.delete(session);
      if (set?.size === 0) this.#children.delete(n.starter);
    }
    this.#changed(session);
    if (n.starter !== undefined) this.#changed(n.starter);
  }

  /** The session's turn ended with nothing queued: its starter no longer waits for it (until `busy`). */
  idled(session: string): void {
    const n = this.#nodes.get(session);
    if (n === undefined || n.ended || n.idle) return;
    n.idle = true;
    if (n.starter !== undefined) this.#changed(n.starter);
  }

  /** The session began a turn (or a compaction): it is its starter's child to wait for again. */
  busy(session: string): void {
    const n = this.#nodes.get(session);
    if (n === undefined || !n.idle) return;
    n.idle = false;
    if (n.starter !== undefined) this.#changed(n.starter);
  }

  /** Lets a session go (it left this computer's sessions: its bot archived). */
  forget(session: string): void {
    const n = this.#nodes.get(session);
    if (n === undefined) return;
    if (!n.ended) this.ended(session);
    this.#dropLinksOf(session);
    this.#nodes.delete(session);
    this.#last.delete(session);
  }

  taskStarted(session: string, task: string): void {
    const n = this.#node(session);
    if (n.ended || n.tasks.has(task)) return;
    n.tasks.add(task);
    this.#changed(session);
  }

  taskEnded(session: string, task: string): void {
    const n = this.#node(session);
    if (!n.tasks.delete(task)) return;
    this.#changed(session);
  }

  /** Every background task of the session ended at once (the agent's process went away without saying). */
  tasksGone(session: string): void {
    const n = this.#nodes.get(session);
    if (n === undefined || n.tasks.size === 0) return;
    n.tasks.clear();
    this.#changed(session);
  }

  subagent(parent: string, row: SessionSubagent): void {
    const n = this.#node(parent);
    const parsed = SessionSubagent.safeParse(row);
    if (!parsed.success) throw new ContractError("invalid", "a subagent row is an id, a name, a model, a state and its times");
    let r = parsed.data;
    if (r.state !== "running" && r.endedAt === undefined) r = { ...r, endedAt: this.#now() };
    if (r.state === "running" && r.endedAt !== undefined) {
      const { endedAt: _drop, ...running } = r;
      r = running;
    }
    const at = n.subagents.findIndex((s) => s.id === r.id);
    if (at >= 0) {
      const old = n.subagents[at]!;
      // An ended row stays ended, at the time it ended: a late or repeated report never runs it again.
      if (old.state !== "running") return;
      n.subagents[at] = { ...r, startedAt: old.startedAt };
    } else n.subagents.push(r);
    while (n.subagents.length > SUBAGENTS_MAX) {
      const ended = n.subagents.findIndex((s) => s.state !== "running");
      n.subagents.splice(ended >= 0 ? ended : 0, 1);
    }
    this.#changed(parent);
  }

  /** The row `id` under `parent` ended (`done` or `failed`) at `at`, when it is there and still running; whether it was. */
  subagentEnded(parent: string, id: string, state: "done" | "failed", at: number = this.#now()): boolean {
    const n = this.#nodes.get(parent);
    const row = n?.subagents.find((s) => s.id === id);
    if (n === undefined || row === undefined || row.state !== "running") return false;
    this.subagent(parent, { ...row, state, endedAt: at });
    return true;
  }

  /** Each subagent still running under `parent` ends `failed` (its call was closed without a word: a cancel, a restart). */
  subagentsCutOff(parent: string): void {
    const n = this.#nodes.get(parent);
    if (n === undefined) return;
    const now = this.#now();
    let changed = false;
    n.subagents = n.subagents.map((s) => {
      if (s.state !== "running") return s;
      changed = true;
      return { ...s, state: "failed", endedAt: now };
    });
    if (changed) this.#changed(parent);
  }

  /** The kind a link from `from` to `to` is, for a plain delivery: the first one from `to`'s starter session is the
   *  spawn (the words that began it), every other a message. Marks the spawn heard. */
  deliveryKind(from: string, to: string): SessionLinkKind {
    const n = this.#nodes.get(to);
    if (n === undefined || n.spawned || n.starter !== from) return "message";
    n.spawned = true;
    return "spawn";
  }

  link(from: string | undefined, to: string, kind: SessionLinkKind): SessionLinkEvent {
    if (from === to) throw new ContractError("invalid", "a link joins two sessions");
    const t = this.#node(to);
    const f = from === undefined ? undefined : this.#node(from);
    // The first delivery from its starter, whatever it was called, has been heard.
    if (from !== undefined && t.starter === from) t.spawned = true;
    const event = SessionLinkEvent.parse({
      type: "session_link", ts: this.#now(),
      from: f === undefined ? { end: "user" } : { end: "session", session: from, kind: f.kind, ...(f.bot === undefined ? {} : { bot: f.bot }) },
      to: { session: to, kind: t.kind, ...(t.bot === undefined ? {} : { bot: t.bot }) },
      link: kind,
    });
    this.#keep(event);
    for (const l of [...this.#links]) {
      if (!mayHearLink(l.reader, event)) continue;
      try {
        l.fn(structuredClone(event));
      } catch {
        // A listener's failure is its own.
      }
    }
    return event;
  }

  fields(session: string): SessionGraphFields {
    const n = this.#node(session);
    // Its children that have not ended and are not idle: an agent that reported and waits for its next message is not waited for.
    const children = [...(this.#children.get(session) ?? [])].filter((c) => this.#nodes.get(c)?.idle !== true).length;
    const tasks = n.tasks.size;
    return {
      startedBy: structuredClone(n.by),
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
