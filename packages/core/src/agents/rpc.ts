// Lane K's methods of the protocol's agents area (packages/protocol/src/agents.ts), as handlers lane C's server mounts
// (C-M1: roles, tokens, the caller check). Each checks its params with the method's own schema and throws a
// `ContractError` the server maps to its JSON-RPC code. The bridge's own methods (`bridge.*`, `glossary.query`) are
// served on the daemon's main socket in the bridge role (bridge/handlers.ts), bound to one agent session each.
//
// `session.setModel` for agents and coding sessions is lane D's method; D's handler calls `AgentManager.setModel`.
import { randomUUID } from "node:crypto";
import { AGENTS_METHODS, AgentDefView, ERR, type AgentBackendView, type BackendMark, type Caller, type MethodSpec } from "@waifucave/moss-protocol";
import type { z } from "zod";
import type { AgentBackend } from "../contracts/agent-backend";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { ContractError } from "../contracts/common";
import { MethodError, toMethodError } from "../rpc/handler";
import type { AgentManager } from "./manager";
import { agentTaskText, type AgentDefinitionView } from "./tools";
import type { BackendLook } from "./backend-look";
import type { AgentStartOptions } from "../contracts/agent-start";

export interface AgentMethodsOptions {
  manager: AgentManager;
  backends: () => readonly AgentBackend[];
  /** This computer's name. */
  computer: string;
  /** Display names by backend id; the id when missing. */
  names?: Readonly<Record<string, string>>;
  /** Agent definitions from plugins (`pluginAgentDefinitions` over B-M2's registry). */
  definitions?: () => AgentDefView[];
  /** A plugin's agent definition by the name Glossary gives it (`<plugin>:<id>`), among those that reach a code session
   *  on `backend` (the plugin's scope and `onlyBackends`). As for a bot's `Agent` call it brings words only: its
   *  instructions go before the user's prompt; the backend, folder, computer, model and effort are the user's. */
  definition?: (name: string, backend: string) => AgentDefinitionView | undefined;
  /** This computer's device id: the device of a user's call made on this computer (the app or the terminal here), whose
   *  caller names none. */
  localDevice: () => string;
  /** Each backend's look (`agent.backends`: its icon and colours; spec revision 20, §9.5). Without it none carries one. */
  looks?: (ids: readonly string[]) => Promise<ReadonlyMap<string, BackendLook>>;
  /** What a person starts with before a session exists, and what they started last (`agent.options`, `agent.recent`; the
   *  person's own `agent.start` is remembered through it). Without it neither method is served. */
  startOptions?: AgentStartOptions;
  now?: () => number;
  /** Whether the paired phone `device` may start a session now (`mayStartSessions` over the device registry's record of it).
   *  `agent.start` from a phone's connection (`remote`) is refused unless this says yes; without it none is let start. */
  phoneMayStart?: (device: string) => boolean;
}

export type AgentMethod = (params: unknown, ctx: { caller: Caller }) => Promise<unknown>;


function parse<S extends MethodSpec>(spec: S, raw: unknown): z.output<S["params"]> {
  const r = spec.params.safeParse(raw ?? {});
  if (!r.success) throw new ContractError("invalid", `${spec.name}: ${r.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ")}`);
  return r.data as z.output<S["params"]>;
}

export function agentMethods(o: AgentMethodsOptions): Record<string, AgentMethod> {
  const methods: Record<string, AgentMethod> = {
    [AGENTS_METHODS.agentBackends.name]: async (raw) => {
      parse(AGENTS_METHODS.agentBackends, raw);
      const backends: AgentBackendView[] = [];
      const list = o.backends();
      const looks = await o.looks?.(list.map((b) => b.id)).catch(() => undefined);
      // Every backend is looked at at once: each detection runs the program's `--version`, and one after another a slow one
      // (an adapter MOSS provides is checked too) held the whole answer, and the names with it, behind the others.
      const detected = await Promise.all(list.map((b) => b.detect().catch(() => ({ installed: false, sandboxed: false, version: undefined }))));
      for (const [i, b] of list.entries()) {
        const d = detected[i]!;
        const marks = new Set<BackendMark>(b.quirks.marks);
        if (d.installed && !d.sandboxed) marks.add("unsandboxed");
        backends.push({
          id: b.id,
          name: o.names?.[b.id] ?? (b as { name?: string }).name ?? b.id,
          pluginId: b.pluginId,
          // Devin's cloud is ACP with cloud placement (spec §9.3); a cloud agent with no command to start is a vendor's
          // own API. Local backends, the in-process ones included, are ACP.
          protocol: b.quirks.placement === "cloud" && Object.keys(b.quirks.launch.command).length === 0 ? "cloud" : "acp",
          placement: b.quirks.placement,
          userStartable: b.userStartable !== false,
          ...(looks?.get(b.id)?.icon === undefined ? {} : { icon: looks.get(b.id)!.icon! }),
          ...(looks?.get(b.id)?.iconDark === undefined ? {} : { iconDark: looks.get(b.id)!.iconDark! }),
          ...(looks?.get(b.id)?.color === undefined ? {} : { color: looks.get(b.id)!.color! }),
          ...(looks?.get(b.id)?.color2 === undefined ? {} : { color2: looks.get(b.id)!.color2! }),
          computers: [{
            computer: o.computer, installed: d.installed, sandboxed: d.sandboxed, marks: [...marks],
            ...(d.version === undefined ? {} : { version: d.version.slice(0, 64) }),
          }],
        });
      }
      return { backends };
    },
    [AGENTS_METHODS.agentDefinitions.name]: async (raw) => {
      parse(AGENTS_METHODS.agentDefinitions, raw);
      return { definitions: o.definitions?.() ?? [] };
    },
    [AGENTS_METHODS.agentStart.name]: async (raw, ctx) => {
      const p = parse(AGENTS_METHODS.agentStart, raw);
      if (ctx.caller.kind !== "user") throw new ContractError("refused", "only the user starts a coding session");
      // A phone's start (the owner's decision of 2026-11-24): the same call and the same checks below, with two more. The phone
      // is still a paired phone with an answer key (read from the registry now, so a revocation ends it), and it names this
      // computer, the one its link reaches: starting on another computer through this one is the desktop's door, not a phone's.
      const fromPhone = ctx.caller.client !== "app" && ctx.caller.client !== "cli";
      if (fromPhone) {
        if (ctx.caller.device === undefined || o.phoneMayStart?.(ctx.caller.device) !== true) throw new ContractError("refused", "this phone isn't paired with an answer key any more, so it can't start a session here");
        if (p.computer !== o.computer) throw new ContractError("refused", `a phone starts a session on the computer it is linked to (${o.computer}), not on ${p.computer.slice(0, 80)}`);
      }
      if (o.backends().find((b) => b.id === p.backend)?.userStartable === false) throw new ContractError("refused", `${p.backend.slice(0, 64)} is not an agent a person opens a session with`);
      const def = p.definition === undefined ? undefined : o.definition?.(p.definition, p.backend);
      if (p.definition !== undefined && def === undefined) throw new ContractError("not_found", `no agent definition ${p.definition.slice(0, 120)} reaches a code session on ${p.backend.slice(0, 64)} (Glossary lists them as <plugin>:<id>)`);
      const brief = p.prompt ?? "";
      // The definition's instructions, then the user's words; with none of the user's, its instructions are the task.
      const prompt = def === undefined ? brief : brief === "" ? def.prompt : agentTaskText(def, brief);
      const r = await o.manager.start({
        caller: { kind: "user", device: ctx.caller.device ?? o.localDevice(), clientMessageId: randomUUID() },
        backend: p.backend, computer: p.computer, root: p.root, prompt,
        ...(def === undefined ? {} : { definition: { pluginId: def.pluginId, id: def.id }, title: def.name }),
        ...(p.model === undefined ? {} : { model: p.model }), ...(p.effort === undefined ? {} : { effort: p.effort }),
      });
      // The person's last start (never a bot's or a spawn's: only this method, only the user), kept by the engine for the
      // start page of any client. A first message is not kept; the model and effort are what the person chose.
      // (Not a phone's: the desktop's start page remembers what the person chose at their computer.)
      try {
        if (!fromPhone) o.startOptions?.remember({ backend: p.backend, computer: p.computer, root: p.root, ...(p.model === undefined ? {} : { model: p.model }), ...(p.effort === undefined ? {} : { effort: p.effort }) }, (o.now ?? Date.now)());
      } catch { /* the start went ahead; the memory is a convenience */ }
      return { session: r.sessionId };
    },
  };
  if (o.startOptions !== undefined) {
    const start = o.startOptions;
    methods[AGENTS_METHODS.agentOptions.name] = async (raw) => {
      const p = parse(AGENTS_METHODS.agentOptions, raw);
      return start.options(p.backend, p.computer);
    };
    methods[AGENTS_METHODS.agentRecent.name] = async (raw) => {
      parse(AGENTS_METHODS.agentRecent, raw);
      return start.recent();
    };
  }
  return methods;
}

/** What `agentMethods` needs of the agents the daemon runs (`createAgents`'s). */
export type RunningAgents = Pick<AgentMethodsOptions, "manager" | "backends" | "computer">;

/** The agent definitions plugins contribute (the `agents` point, §5.3): each active entry that is a preset, as the
 *  protocol shows it. An entry that is a path (a Claude-style agent file) isn't a preset, and one that doesn't fit the
 *  view (a computer or root folder it can't name) is left out. */
export function pluginAgentDefinitions(registry: Pick<PluginRegistry, "entries">): AgentDefView[] {
  const out: AgentDefView[] = [];
  for (const c of registry.entries("agents")) {
    if (c.state !== "active" || typeof c.value !== "object" || c.value === null) continue;
    const d = c.value as { id: string; name: string; backend: string; model?: string; effort?: string; computer?: string; root?: string };
    const view = AgentDefView.safeParse({
      id: d.id, name: d.name, pluginId: c.pluginId, backend: d.backend,
      ...(d.model === undefined ? {} : { model: d.model }), ...(d.effort === undefined ? {} : { effort: d.effort }),
      ...(d.computer === undefined ? {} : { computer: d.computer }), ...(d.root === undefined ? {} : { root: d.root }),
    });
    if (view.success) out.push(view.data);
  }
  return out;
}

/** `agentMethods` over agents that start after the server and stop before it: each call reads them through the
 *  getter, and is refused while none run. A thrown `ContractError` becomes its JSON-RPC code (`toMethodError`). */
export function lateAgentMethods(
  agents: () => RunningAgents | undefined,
  o: Pick<AgentMethodsOptions, "localDevice" | "definitions" | "definition" | "looks" | "startOptions" | "now" | "phoneMayStart">,
): Record<string, AgentMethod> {
  const made = new WeakMap<RunningAgents, Record<string, AgentMethod>>();
  const methodsOf = (a: RunningAgents): Record<string, AgentMethod> => {
    let m = made.get(a);
    if (!m) made.set(a, (m = agentMethods({ manager: a.manager, backends: a.backends, computer: a.computer, localDevice: o.localDevice, ...(o.definitions ? { definitions: o.definitions } : {}), ...(o.definition ? { definition: o.definition } : {}), ...(o.looks ? { looks: o.looks } : {}), ...(o.startOptions ? { startOptions: o.startOptions } : {}), ...(o.now ? { now: o.now } : {}), ...(o.phoneMayStart ? { phoneMayStart: o.phoneMayStart } : {}) })));
    return m;
  };
  const names = [AGENTS_METHODS.agentBackends.name, AGENTS_METHODS.agentDefinitions.name, AGENTS_METHODS.agentStart.name, ...(o.startOptions ? [AGENTS_METHODS.agentOptions.name, AGENTS_METHODS.agentRecent.name] : [])];
  return Object.fromEntries(names.map((name) => [name, async (params: unknown, ctx: { caller: Caller }) => {
    const a = agents();
    if (!a) throw new MethodError(ERR.RETRY, "MOSS's agents aren't running on this computer yet: try again in a moment");
    try {
      return await methodsOf(a)[name]!(params, ctx);
    } catch (err) {
      throw toMethodError(err);
    }
  }]));
}
