// The bot's agent tools (spec §9.3 "How a delegation runs"): `Agent` and `TaskStop`, in a neutral shape: a name, a
// description that stands on its own, a JSON Schema and a `run`. The embedded runtime registers them as core tools
// (lane A, with lane D for the bot's session). `SendMessage` and `ListAgents` are the bot's own tools (lane D's
// bots/tools.ts, the controller's ruling: one `ListAgents`): `SendMessage` reaches an agent through the
// session host, as it reaches any session, and `ListAgents` lists the agents from `AgentManager.sessionHooks().agents`.
import { RESERVED_BACKEND_IDS } from "./plugin-backends";
import { ContractError, isContractError } from "../contracts/common";
import type { AgentBackendOptions, BackendModelOption, Level, TurnOrigin } from "@waifucave/moss-protocol";
import type { AgentManager } from "./manager";

export interface CoreToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: unknown): Promise<{ text: string; isError: boolean }>;
}

/** The calling bot's session, as the runtime knows it. */
export interface AgentToolCaller {
  bot: string;
  session: string;
  origin: TurnOrigin;
  /** A routine's raised level, for a side thread's delegations (§7). */
  level?: Level;
}

function fail(err: unknown): { text: string; isError: true } {
  const msg = err instanceof Error ? err.message : String(err);
  return { text: isContractError(err) ? `${msg} (${err.code})` : msg, isError: true };
}

function str(input: unknown, key: string): string | undefined {
  const v = (input as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export interface AgentToolOptions {
  backends?: () => string[];
  /** The runtime's own `TaskStop`, which this one hides (A-M3's `shadowBuiltins`): a task id that names none of the
   *  bot's agents is passed on to it, so the bot's background commands and monitors still stop. */
  stopRuntimeTask?: (taskId: string) => Promise<{ text: string; isError: boolean }>;
  /** Whether the bot may start an agent on `model` (lane D's provider check, #311 S1): a provider the user didn't
   *  choose or allow for the bot asks the user first, and a no refuses the call. */
  checkModel?: (model: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** A plugin's agent definition by the name Glossary gives it (`<plugin>:<id>`). It brings words only (the
   *  controller's ruling): its instructions go before the bot's brief, and nothing else of it is taken; the backend,
   *  the model, the effort, the folder, the computer and the tools are the bot's alone. */
  definition?: (name: string) => AgentDefinitionView | undefined;
  /** The bot's own model now: MOSS's own agents (`moss`, `moss-code`) run on it when the bot names none, rather
   *  than on the user's default, which may be a provider the bot doesn't use. */
  botModel?: () => string | undefined;
  /** What a backend offers to start with, before any session exists (`agent.options`: the plugin's declared list, or what a
   *  session of it once reported). Reading it starts nothing. Without it `Agent` passes the model on as given. */
  modelsOf?: (backend: string) => Promise<AgentBackendOptions | undefined>;
}

/** The most models a refusal or a listing names. */
const MODELS_SHOWN = 24;

/** The model `asked` names among `models`: its id, else an id by case, else a display name (never a prefix or a guess). */
export function modelOffered(models: readonly BackendModelOption[], asked: string): BackendModelOption | undefined {
  const want = asked.trim().toLowerCase();
  return models.find((m) => m.id === asked) ?? models.find((m) => m.id.toLowerCase() === want) ?? models.find((m) => nameText(m).toLowerCase() === want);
}

function nameText(m: BackendModelOption): string {
  return typeof m.name === "string" ? m.name : m.name.en;
}

/** A backend's models in words: each id with its name where that differs, its efforts, and the default. */
export function modelsWords(o: AgentBackendOptions): string {
  const shown = o.models.slice(0, MODELS_SHOWN).map((m) => {
    const name = nameText(m);
    return `${m.id}${name !== "" && name !== m.id ? ` (${name})` : ""}${m.efforts.length > 0 ? ` [efforts: ${m.efforts.join(", ")}]` : ""}`;
  });
  const more = o.models.length > MODELS_SHOWN ? `; and ${o.models.length - MODELS_SHOWN} more` : "";
  const def = o.default?.model !== undefined ? ` Its default is ${o.default.model}.` : "";
  return `${shown.join("; ")}${more}.${def}`;
}

/** What the Agent tool takes of a plugin's agent definition (glossary.ts `AgentDefinition`). */
export interface AgentDefinitionView {
  pluginId: string;
  id: string;
  name: string;
  prompt: string;
  backend?: string;
  model?: string;
  effort?: string;
}

/** The task an agent started from a definition gets: the definition's instructions, then the bot's brief. The same text
 *  the approval card shows (`bot-check.ts`'s `agentStart`). */
export function agentTaskText(def: Pick<AgentDefinitionView, "prompt">, brief: string): string {
  return `${def.prompt === "" ? "" : `${def.prompt}\n\n---\n\n`}${brief}`;
}

export function agentToolDefs(manager: AgentManager, caller: AgentToolCaller, opts: AgentToolOptions = {}): CoreToolDef[] {
  const backends = opts.backends?.() ?? [];
  return [
    {
      name: "Agent",
      description: [
        "Start a background coding agent (Claude Code, Codex, Cursor, Antigravity …) on a task, in a folder of the",
        "folder tree. It returns at once with the agent's session id; the agent works in the background, can message",
        "you with SendMessage while it works, and when it finishes you get a task notification with its final report",
        "and the path to its full transcript. Use ListAgents to see it and TaskStop to stop it; a message you send it",
        "with SendMessage becomes its next prompt. Write the prompt as a complete brief: the agent sees nothing of this",
        "conversation. `model_id` is the chosen agent's OWN model id, never another agent's (Codex takes Codex's models, not",
        "fable or opus); leave it out for the agent's default, and AgentModels shows what an agent offers (it starts",
        "nothing). A model the agent doesn't offer is refused with the ones it does.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "A short title for the task, three to six words." },
          prompt: { type: "string", description: "The task, as a complete brief." },
          backend: backends.length > 0 ? { type: "string", enum: backends, description: "Which agent runs it." } : { type: "string", description: "Which agent runs it (an agent backend's id)." },
          root: { type: "string", description: "The folder it works in, as a folder-tree path: home/<Computer>/…" },
          // Not named `model`: the runtime puts one family's aliases (fable, opus, sonnet, haiku) into the `model` property of any tool
          // named Agent, this one included, so the model would be told those are the only choices.
          model_id: { type: "string", description: "The model id the chosen backend itself offers (AgentModels lists them), or leave out for its default. Not a model of another family." },
          effort: { type: "string", description: "The agent's effort level, where it offers one." },
          computer: { type: "string", description: "The computer to run on; the one holding the root by default." },
          ...(opts.definition === undefined ? {} : { agent: { type: "string", description: "A plugin's agent definition to start from, by the name Glossary lists (<plugin>:<id>): its instructions go before your brief. It brings words only: the backend, the folder and the rest stay yours to give." } }),
        },
        required: ["prompt", "backend", "root"],
        additionalProperties: false,
      },
      run: async (input) => {
        const named = str(input, "agent");
        const def = named === undefined ? undefined : opts.definition?.(named);
        if (named !== undefined && def === undefined) return fail(new ContractError("not_found", `no agent definition ${named.slice(0, 120)} (Glossary lists them as <plugin>:<id>)`));
        const brief = str(input, "prompt");
        const prompt = def === undefined || brief === undefined ? brief : agentTaskText(def, brief);
        const backend = str(input, "backend");
        const root = str(input, "root");
        if (!prompt || !backend || !root) return fail(new ContractError("invalid", "Agent needs a prompt, a backend and a root folder"));
        if (backends.length > 0 && !backends.includes(backend)) return fail(new ContractError("invalid", `no agent backend ${backend.slice(0, 64)} (${backends.join(", ")})`));
        try {
          let model = str(input, "model_id") ?? str(input, "model");
          if (model !== undefined && opts.modelsOf !== undefined && !RESERVED_BACKEND_IDS.has(backend)) {
            // An agent's own list, where it is known: the model is one of its own, by its id; any other is refused with the ones it has.
            const offered = await opts.modelsOf(backend).catch(() => undefined);
            if (offered !== undefined && offered.known && offered.models.length > 0) {
              const hit = modelOffered(offered.models, model);
              if (hit === undefined) return fail(new ContractError("invalid", `${backend} doesn't offer a model "${model.slice(0, 80)}". It offers: ${modelsWords(offered)} Start it again with one of these ids, or leave the model out for its default.`));
              model = hit.id;
            }
          }
          model ??= RESERVED_BACKEND_IDS.has(backend) ? opts.botModel?.() : undefined;
          if (model !== undefined && opts.checkModel !== undefined) {
            const verdict = await opts.checkModel(model);
            if (!verdict.ok) return { text: verdict.reason, isError: true };
          }
          const effort = str(input, "effort");
          const computer = str(input, "computer");
          const title = str(input, "description") ?? def?.name;
          const r = await manager.start({
            caller: { kind: "bot", bot: caller.bot, session: caller.session, origin: caller.origin, ...(caller.level === undefined ? {} : { level: caller.level }) },
            backend, prompt, root, ...(def === undefined ? {} : { definition: { pluginId: def.pluginId, id: def.id } }),
            ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(computer ? { computer } : {}), ...(title ? { title } : {}),
          });
          const from = def === undefined ? "" : ` with ${def.pluginId}'s agent definition ${def.id}`;
          return {
            text: `Started agent ${r.sessionId} (${backend})${from} in ${root}. It runs in the background: you'll get a task notification when it finishes, with its report and its transcript (${r.transcript}). ListAgents shows it; TaskStop stops it.`,
            isError: false,
          };
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      name: "AgentModels",
      description: "The models a coding agent backend offers (its own ids, its efforts and its default), for the `model` of Agent. It starts no session and calls no model provider, but the first look at an agent may run that agent's own list command as a local child process; an agent whose models aren't known until it runs says so, and then Agent takes no model (leave it out) or a model you are told.",
      inputSchema: {
        type: "object",
        properties: { backend: backends.length > 0 ? { type: "string", enum: backends, description: "Which agent." } : { type: "string", description: "Which agent (an agent backend's id)." } },
        required: ["backend"],
        additionalProperties: false,
      },
      run: async (input) => {
        const backend = str(input, "backend");
        if (!backend) return fail(new ContractError("invalid", "AgentModels needs a backend"));
        if (backends.length > 0 && !backends.includes(backend)) return fail(new ContractError("invalid", `no agent backend ${backend.slice(0, 64)} (${backends.join(", ")})`));
        if (opts.modelsOf === undefined) return { text: `The models ${backend} offers aren't known here; leave the model out of Agent for its default.`, isError: false };
        try {
          const o = await opts.modelsOf(backend);
          if (o === undefined || !o.known || o.models.length === 0) return { text: `${backend}'s models aren't known until it runs; leave the model out of Agent for its default.${o?.default?.model !== undefined ? ` Its default is ${o.default.model}.` : ""}`, isError: false };
          return { text: `${backend} offers: ${modelsWords(o)}`, isError: false };
        } catch (err) {
          return fail(err);
        }
      },
    },
    {
      name: "TaskStop",
      description: opts.stopRuntimeTask
        ? "Stop one of your background agents by its session id (it is cancelled, its process ends, and you get its task notification), or one of your background commands or monitors by its task id."
        : "Stop one of your background agents by its session id: it is cancelled, its process ends, and you get its task notification.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: opts.stopRuntimeTask ? "The agent's session id, or the background task's id." : "The agent's session id." },
          ...(opts.stopRuntimeTask ? { task_id: { type: "string", description: "The same as id, as background commands name it." } } : {}),
        },
        ...(opts.stopRuntimeTask ? {} : { required: ["id"] }),
        additionalProperties: false,
      },
      run: async (input) => {
        const id = str(input, "id") ?? (opts.stopRuntimeTask ? str(input, "task_id") : undefined);
        if (!id) return fail(new ContractError("invalid", "TaskStop needs the agent's session id"));
        try {
          await manager.stop(id, { bot: caller.bot });
          return { text: `Stopped ${id}.`, isError: false };
        } catch (err) {
          // Not one of MOSS's agents at all: the runtime's own task (a background command, a monitor), if it has one.
          if (opts.stopRuntimeTask && isContractError(err) && err.code === "not_found") return opts.stopRuntimeTask(id);
          return fail(err);
        }
      },
    },
  ];
}
