// The + flow's choices and what each starts on (spec revision 20, §9.5): every step comes preselected, so Create works at
// once. Pure.
// * The agent: the last one started (`agent.recent`), else MOSS's own, else the first this computer has. Only agents a
//   person can start (`userStartable`) are listed; the ones this computer has come first, MOSS's own first among them.
// * Model and effort: for the agent last started, its last model and effort when it still offers them; else the agent's
//   default (`agent.options`); "unknown until started" is the agent's own default (no model sent).
// * The folder: the one started in last (`ui.pick`'s recent tokens), else none (Create asks for one).
import { MOSS_CODE, type BackendLook } from "./look";

/** A backend as `agent.backends` lists it. */
export interface BackendRow extends BackendLook {
  userStartable?: boolean;
  computers: readonly { computer: string; installed: boolean }[];
}

export interface AgentChoice extends BackendLook {
  installed: boolean;
}

/** `agent.options`'s answer (`AgentBackendOptions`). */
export interface AgentOptions {
  backend: string;
  known: boolean;
  source?: string;
  models: readonly { id: string; name: string | { en?: string }; efforts: readonly string[]; defaultEffort?: string }[];
  efforts?: readonly string[];
  default?: { model?: string; effort?: string };
}

/** `agent.recent`'s answer as a page sees it (`RecentStart`; its folders reach a page only as `ui.pick` tokens). */
export interface RecentStart {
  backend?: string;
  model?: string;
  effort?: string;
}

export interface FolderToken {
  token: string;
  name: string;
}

const plainName = (n: unknown): string => (typeof n === "string" ? n : typeof (n as { en?: unknown } | undefined)?.en === "string" ? (n as { en: string }).en : "");

/** The agents the panel lists, in order. `here`: this computer's name (undefined: any computer counts). */
export function agentChoices(backends: readonly BackendRow[], here: string | undefined): AgentChoice[] {
  const list = backends.filter((b) => b.userStartable !== false).map((b) => ({
    id: b.id,
    name: plainName(b.name) || b.id,
    ...(b.color !== undefined ? { color: b.color } : {}),
    ...(b.color2 !== undefined ? { color2: b.color2 } : {}),
    ...(b.icon !== undefined ? { icon: b.icon } : {}),
    installed: b.computers.some((c) => c.installed && (here === undefined || c.computer === here)),
  }));
  const rank = (a: AgentChoice) => (!a.installed ? 2 : a.id === MOSS_CODE ? 0 : 1);
  return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The agent chosen at first: the last started when it can be started here, else MOSS's own, else the first here. */
export function pickAgent(choices: readonly AgentChoice[], recent: RecentStart | undefined): { agent?: string; from: "last" | "moss" | "first" | "none" } {
  const ok = (id: string | undefined) => choices.find((c) => c.id === id && c.installed);
  const last = ok(recent?.backend);
  if (last !== undefined) return { agent: last.id, from: "last" };
  const own = ok(MOSS_CODE);
  if (own !== undefined) return { agent: own.id, from: "moss" };
  const first = choices.find((c) => c.installed);
  return first !== undefined ? { agent: first.id, from: "first" } : { from: "none" };
}

export interface ModelPick {
  /** Absent: the agent's own default (nothing sent). */
  model?: string;
  effort?: string;
  from: "last" | "default" | "unknown";
}

/** The model and effort chosen at first for `agent`. */
export function pickModel(agent: string, options: AgentOptions | undefined, recent: RecentStart | undefined): ModelPick {
  if (options === undefined || !options.known) return { from: "unknown" };
  const offered = (model: string | undefined) => options.models.find((m) => m.id === model);
  const effortOk = (model: AgentOptions["models"][number] | undefined, effort: string | undefined) =>
    effort !== undefined && ((model?.efforts.length ?? 0) > 0 ? model!.efforts.includes(effort) : (options.efforts ?? []).includes(effort));
  if (recent?.backend === agent && recent.model !== undefined) {
    const m = offered(recent.model);
    if (m !== undefined) return { model: m.id, ...(effortOk(m, recent.effort) ? { effort: recent.effort! } : m.defaultEffort !== undefined ? { effort: m.defaultEffort } : {}), from: "last" };
  }
  const d = offered(options.default?.model) ?? options.models[0];
  const effort = options.default?.effort !== undefined && effortOk(d, options.default.effort) ? options.default.effort : d?.defaultEffort;
  return { ...(d !== undefined ? { model: d.id } : {}), ...(effort !== undefined ? { effort } : {}), from: "default" };
}

/** The efforts the panel offers for a model. */
export function effortsFor(options: AgentOptions | undefined, model: string | undefined): readonly string[] {
  const m = options?.models.find((x) => x.id === model);
  return m !== undefined && m.efforts.length > 0 ? m.efforts : options?.efforts ?? [];
}

export const modelName = (options: AgentOptions | undefined, model: string | undefined): string | undefined => {
  const m = options?.models.find((x) => x.id === model);
  return m === undefined ? undefined : plainName(m.name) || m.id;
};

/** The folder chosen at first: the newest recent one. */
export function pickFolder(recent: readonly FolderToken[] | undefined): FolderToken | undefined {
  return recent?.[0];
}

/** `agent.start`'s params from the choices (`sessions.start`; `root` a pick token): model and effort only when chosen. */
export function startParams(agent: string, folder: FolderToken, pick: { model?: string; effort?: string }): Record<string, string> {
  return { backend: agent, root: folder.token, ...(pick.model !== undefined ? { model: pick.model } : {}), ...(pick.effort !== undefined ? { effort: pick.effort } : {}) };
}
