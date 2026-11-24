// A new session (spec §9.4): the person picks a coding agent, any installed one (an `agentBackends` entry a plugin
// brings, MOSS's own `moss-code` among them), and a folder in their own computer's home, and starts it; the window then
// shows its live tab. The folder is chosen in the app's own dialog (`ui.pick`, use `agent.start`): the page holds only a
// token and the folder's name, never a path; `agent.start` is the person's press (`sessions.start`, one call per press).
import { AgentMark, useCore, type AgentMarkProps } from "@waifucave/moss-plugin-sdk/ui";
import { useEffect, useState } from "react";
import { plain } from "./local";
import { S } from "./strings";

type BackendIcon = NonNullable<AgentMarkProps["backend"]["icon"]>;

/** One agent the page offers: its id and name, and whether this computer has it. */
export interface NewSessionAgent {
  id: string;
  name: string;
  installed: boolean;
  /** Its look as `agent.backends` gives it (spec revision 20, §9.5): the mark its plugin ships and its colours. */
  icon?: BackendIcon;
  color?: string;
  color2?: string;
}

/** The agents `agent.backends` lists, for this computer (`self`), MOSS's own first. A backend that says a person can't start it (`userStartable: false`, MOSS's own subagents) is left out. */
export function agentsHere(backends: readonly { id: string; name: unknown; userStartable?: boolean; icon?: BackendIcon; color?: string; color2?: string; computers: readonly { computer: string; installed: boolean }[] }[], here: string | undefined): NewSessionAgent[] {
  const list = backends.filter((b) => b.userStartable !== false).map((b) => ({
    id: b.id,
    name: plain(b.name as never) || b.id,
    installed: b.computers.some((c) => c.installed && (here === undefined || c.computer === here)),
    ...(b.icon !== undefined ? { icon: b.icon } : {}), ...(b.color !== undefined ? { color: b.color } : {}), ...(b.color2 !== undefined ? { color2: b.color2 } : {}),
  }));
  // MOSS's own first, then the agents this computer has, then the rest, each group by name.
  const rank = (a: NewSessionAgent) => (a.id === "moss-code" ? 0 : a.installed ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** `agent.options`'s answer as this page reads it (an agent whose models are known before a session exists). */
export interface StartOptions {
  known?: boolean;
  source?: string;
  models?: { id: string; name: unknown; efforts?: string[]; defaultEffort?: string }[];
  default?: { model?: string; effort?: string };
}
export interface RecentChoices {
  backend?: string;
  model?: string;
  effort?: string;
  byBackend?: { backend: string; model?: string; effort?: string }[];
}

/** The model and effort chosen at first for `agent`: the last the person chose for THAT agent while its list still has it,
 *  else MOSS's coding agent's default (the catalog), else none: an agent with a list of its own starts on its own default
 *  and nothing is sent. */
export function startChoice(agent: string, options: StartOptions | undefined, recent: RecentChoices | undefined): { model?: string; effort?: string } {
  const models = options?.known === true ? options.models ?? [] : [];
  const mine = recent?.byBackend?.find((b) => b.backend === agent) ?? (recent?.backend === agent ? recent : undefined);
  const offered = (id: string | undefined) => models.find((m) => m.id === id);
  const effortOf = (m: NonNullable<ReturnType<typeof offered>>, asked: string | undefined) => (asked !== undefined && (m.efforts ?? []).includes(asked) ? asked : m.defaultEffort);
  const from = offered(mine?.model) ?? offered(options?.default?.model) ?? (options?.source === "catalog" ? models[0] : undefined);
  if (from === undefined) return {};
  const effort = effortOf(from, from.id === mine?.model ? mine?.effort : options?.default?.effort);
  return { model: from.id, ...(effort !== undefined ? { effort } : {}) };
}

/** `layout`: "page" fills the window's main column under the title bar and scrolls; "panel" lays out in whatever container it is put in (a panel or a dialog about 420 to 560 px wide), assuming nothing about the window. */
export function NewSession({ onStarted, layout = "page" }: { onStarted: (session: string) => void; layout?: "page" | "panel" }) {
  const core = useCore();
  const [agents, setAgents] = useState<NewSessionAgent[] | undefined>();
  const [agent, setAgent] = useState<string | undefined>();
  const [folder, setFolder] = useState<{ token: string; name: string } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);
  const [recent, setRecent] = useState<{ token: string; name: string }[]>([]);
  const [last, setLast] = useState<RecentChoices | undefined>();
  const [options, setOptions] = useState<Record<string, StartOptions | undefined>>({});
  // The pick belongs to the agent it was made for (`agent`): a pick of agent A is never sent to agent B.
  const [made, setMade] = useState<{ agent: string; model?: string; effort?: string } | undefined>();
  const choice: { model?: string; effort?: string } = made !== undefined && made.agent === agent ? made : {};

  useEffect(() => {
    let live = true;
    void Promise.all([
      core?.call("agent.backends", {}).catch(() => ({ backends: [] })),
      core?.call("computer.list", {}).catch(() => ({ computers: [] })),
      // What the person started last (the engine keeps it for every client): its agent is preselected, its folders offered.
      core?.call("agent.recent", {}).catch(() => undefined),
    ]).then(async ([b, c, last]) => {
      if (!live) return;
      const here = ((c as { computers?: { name: string; link?: string }[] } | undefined)?.computers ?? []).find((x) => x.link === "self")?.name;
      const list = agentsHere(((b as { backends?: never[] } | undefined)?.backends ?? []), here);
      setAgents(list);
      setLast(last as RecentChoices | undefined);
      const lastAgent = (last as { backend?: string } | undefined)?.backend;
      setAgent((was) => was ?? list.find((a) => a.installed && a.id === lastAgent)?.id ?? list.find((a) => a.installed)?.id);
      if (((last as { folders?: number } | undefined)?.folders ?? 0) > 0) {
        const got = (await core?.call("ui.pick", { kind: "folder", use: "agent.start", recent: true, dialog: false }).catch(() => undefined)) as { recent?: { token?: string; name?: string }[] } | undefined;
        if (live) setRecent((got?.recent ?? []).flatMap((r) => (typeof r.token === "string" ? [{ token: r.token, name: r.name ?? "" }] : [])));
      }
    });
    return () => { live = false; };
  }, [core]);

  // The agent's models, where it has a list before a session exists (`agent.options`); a refusal is just "none known".
  useEffect(() => {
    if (agent === undefined || Object.hasOwn(options, agent)) return;
    let live = true;
    void Promise.resolve(core?.call("agent.options", { backend: agent })).then(
      (o) => live && setOptions((was) => ({ ...was, [agent]: o as StartOptions })),
      () => live && setOptions((was) => ({ ...was, [agent]: undefined })),
    );
    return () => { live = false; };
  }, [core, agent]); // eslint-disable-line react-hooks/exhaustive-deps
  // The pick follows the agent (and what is known of it), preselected as `startChoice` says.
  useEffect(() => {
    if (agent !== undefined && Object.hasOwn(options, agent)) setMade({ agent, ...startChoice(agent, options[agent], last) });
  }, [agent, options, last]);

  const pickFolder = async () => {
    setError(undefined);
    try {
      const got = (await core?.call("ui.pick", { kind: "folder", use: "agent.start" })) as { token?: string; name?: string; cancelled?: boolean } | undefined;
      if (got?.token !== undefined) setFolder({ token: got.token, name: got.name ?? "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const start = async () => {
    if (agent === undefined || folder === undefined) return;
    setError(undefined);
    setStarting(true);
    try {
      const got = (await core?.call("agent.start", { backend: agent, root: folder.token, ...(choice.model !== undefined ? { model: choice.model } : {}), ...(choice.effort !== undefined ? { effort: choice.effort } : {}) })) as { session?: string } | undefined;
      if (got?.session !== undefined) onStarted(got.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  // Start waits until this agent's options have answered and its pick is made.
  const ready = agent !== undefined && folder !== undefined && !starting && made?.agent === agent;
  return (
    <section className="cl-new-session" data-layout={layout} aria-label={S.newSession}>
      <div className="cl-new-session__page">
        <h1 className="cl-new-session__title">{S.newSession}</h1>
        <p className="cl-new-session__detail">{S.newSessionDetail}</p>
        <AgentList agents={agents} value={agent} onChange={setAgent} />
        {agent !== undefined && <ModelRow agent={agents?.find((a) => a.id === agent)?.name ?? agent} options={options[agent]} value={choice} onChange={(v) => setMade({ agent, ...v })} />}
        <FolderRow folder={folder} onPick={() => void pickFolder()} recent={recent} onRecent={setFolder} />
        <div className="cl-new-session__actions">
          <StartButton disabled={!ready} onStart={() => void start()} />
        </div>
        {error !== undefined && <p className="cl-new-session__error" role="alert">{error}</p>}
      </div>
    </section>
  );
}

/** The agents as one row each, the chosen one marked; an agent this computer lacks is a muted row, not selectable. A step of its own. */
export function AgentList({ agents, value, onChange }: { agents: readonly NewSessionAgent[] | undefined; value: string | undefined; onChange: (id: string) => void }) {
  return (
    <div className="cl-new-session__section" role="radiogroup" aria-labelledby="cl-new-session-agents">
      <h2 className="cl-new-session__label" id="cl-new-session-agents">{S.pickAgent}</h2>
      {agents === undefined ? <p className="cl-new-session__status" role="status">{S.loading}</p> : agents.length === 0 ? <p className="cl-new-session__status" role="status">{S.noAgents}</p> : (
        <div className="cl-new-session__agents">
          {agents.map((a) => (
            <label key={a.id} className="cl-new-session__agent" data-installed={a.installed} data-selected={value === a.id}>
              <input type="radio" name="agent" value={a.id} checked={value === a.id} disabled={!a.installed} onChange={() => onChange(a.id)} />
              <AgentMark backend={{ id: a.id, name: a.name, ...(a.icon !== undefined ? { icon: a.icon } : {}), ...(a.color !== undefined ? { color: a.color } : {}), ...(a.color2 !== undefined ? { color2: a.color2 } : {}) }} size={20} />
              <span className="cl-new-session__agent-name">{a.name}</span>
              {!a.installed && <span className="cl-new-session__note">{S.notInstalled}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** The model and effort step, for an agent whose models are known before a session exists: a list to pick from (the agent's
 *  own default first, unless it is MOSS's coding agent), and the efforts of the chosen model. Nothing is shown otherwise. */
export function ModelRow({ agent, options, value, onChange }: { agent: string; options: StartOptions | undefined; value: { model?: string; effort?: string }; onChange: (v: { model?: string; effort?: string }) => void }) {
  const models = options?.known === true ? options.models ?? [] : [];
  if (models.length === 0) return null;
  const efforts = models.find((m) => m.id === value.model)?.efforts ?? [];
  return (
    <div className="cl-new-session__section">
      <h2 className="cl-new-session__label" id="cl-new-session-model">{S.pickModel}</h2>
      <div className="cl-new-session__folder">
        <select className="cl-new-session__select" aria-labelledby="cl-new-session-model" value={value.model ?? ""} onChange={(e) => {
          const m = models.find((x) => x.id === e.target.value);
          if (m === undefined) return onChange({});
          const keep = value.effort !== undefined && (m.efforts ?? []).includes(value.effort) ? value.effort : m.defaultEffort;
          onChange({ model: m.id, ...(keep !== undefined ? { effort: keep } : {}) });
        }}>
          {options?.source !== "catalog" && <option value="">{S.agentsOwnDefault(agent)}</option>}
          {models.map((m) => <option key={m.id} value={m.id}>{plain(m.name as never) || m.id}</option>)}
        </select>
        {efforts.length > 0 && (
          <select className="cl-new-session__select" aria-label={S.pickEffort} value={value.effort ?? ""} onChange={(e) => onChange({ ...(value.model !== undefined ? { model: value.model } : {}), ...(e.target.value !== "" ? { effort: e.target.value } : {}) })}>
            <option value="">{S.defaultEffort}</option>
            {efforts.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

/** The folder step: a button that opens the app's own dialog, and the chosen folder's name beside it. */
export function FolderRow({ folder, onPick, recent = [], onRecent }: { folder: { name: string } | undefined; onPick: () => void; recent?: readonly { token: string; name: string }[]; onRecent?: (f: { token: string; name: string }) => void }) {
  return (
    <div className="cl-new-session__section">
      <h2 className="cl-new-session__label">{S.folder}</h2>
      <div className="cl-new-session__folder">
        <button type="button" className="cl-new-session__button" onClick={onPick}>{folder === undefined ? S.pickFolder : S.changeFolder}</button>
        {folder !== undefined && <span className="cl-new-session__folder-name" title={folder.name}>{folder.name}</span>}
      </div>
      {recent.length > 0 && onRecent !== undefined && (
        <div className="cl-new-session__recent" role="group" aria-label={S.recentFolders}>
          {recent.map((r) => <button key={r.token} type="button" className="cl-new-session__button cl-new-session__recent-folder" onClick={() => onRecent(r)}>{r.name}</button>)}
        </div>
      )}
    </div>
  );
}

/** The one primary button. */
export function StartButton({ disabled, onStart }: { disabled: boolean; onStart: () => void }) {
  return <button type="button" className="cl-new-session__button cl-new-session__start" disabled={disabled} onClick={onStart}>{S.startSession}</button>;
}
