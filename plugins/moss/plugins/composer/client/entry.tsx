// The composer on the runtime: the `composer` entry, for a session's live tab (MOSS Code's window has no bot's tab, spec
// §9.4: the session is a code session, read with `sessions.read`). It sends the user's
// message through `useUserSend` (the app counts it as the user's only from a real key press or click, §5.5),
// stops the turn, switches the model (the `composer` spot's host callbacks, `useComposerHost`: what any entry in the
// spot gets), and shows the level of the computer it runs on
// (the computer's level shows as a label: a change is a sealed card, which the core can't raise for the app yet).
// Each button draws through `composer.action`, keyed by action id, falling back to its own.
//
// A plugin's own button (a `composer.action` entry under a key that isn't one of the composer's, hold-to-talk among them) is
// drawn among the buttons plugins add, before stop and send, in the spot's order: the composer looks for no key of theirs.
//
// The model list comes from the core's `models.list` (the models a session can switch to).
//
// The slash menu lists the running plugins' commands (the host's `commands`, the bundled composer's only) for this kind
// of session, and runs one as the user (`runCommand`) inside the key press or click that picked it. The rest of the line
// goes to that plugin alone, as the command's args (`argsFor`); the line never goes to the bot. The result, or why it
// didn't run, shows as a row above the box, here only: it isn't added to the conversation, so neither the bot nor any
// other plugin reads it.
import { Spot, useApprovals, useComposerHost, useKept, usePluginApi, useSpotEntries, useTokens, useUserSend } from "@waifucave/moss-plugin-sdk/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Composer } from "./Composer";
import { argsFor, inScope, refusalText, resultText, type SlashCommand } from "./slash";
import { MOSS_LEVELS } from "./levels";
import { S } from "./strings";
import type { ComposerActionId, ComposerModel, ComposerModelChoice, ComposerSlash } from "./types";

type SessionKind = "bot" | "side-thread" | "agent" | "coding";

export interface ComposerEntryProps {
  bot: { id: string; name: string };
  session: string;
  sessionKind?: SessionKind;
}

/** A failed read is tried again after these waits (ms), then left: a read that fails while the window's document reloads, or
 *  while the core is busy, must not leave the picker on what it had when it mounted. */
export const LOAD_RETRY_MS: readonly number[] = [300, 900, 2700];

/** Reads something the composer shows, again whenever `deps` change.
 *  - The value already held stays while the next read runs (no blank between two reads).
 *  - A read that finishes after `deps` changed again is still used while nothing is held yet: the models list takes about
 *    a second on a busy core, and the session's status changes in that second, so throwing the first answer away doubled
 *    the wait (and kept doing so for as long as the status kept changing). Once a value is held, only the newest read counts.
 *  - A read that fails is tried again (LOAD_RETRY_MS), not swallowed into a picker that stays empty. */
function useLoad<T>(load: () => Promise<T> | undefined, deps: readonly unknown[]): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const held = useRef(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number): void => {
      load()?.then(
        (v) => {
          if (!live && held.current) return;
          held.current = true;
          setValue(v);
        },
        () => {
          const wait = LOAD_RETRY_MS[n];
          if (live && wait !== undefined) timer = setTimeout(() => attempt(n + 1), wait);
        },
      );
    };
    attempt(0);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** The catalog's models, read defensively: a qualified id, a label, the provider, the efforts. */
function modelsOf(catalog: unknown): ComposerModel[] {
  const list = (catalog as { models?: unknown[] } | undefined)?.models;
  if (!Array.isArray(list)) return [];
  return list.flatMap((m) => {
    const o = m as { id?: unknown; label?: unknown; name?: unknown; provider?: unknown; providerName?: unknown; plugin?: unknown; signedIn?: unknown; efforts?: unknown; defaultEffort?: unknown };
    if (typeof o.id !== "string") return [];
    const label = typeof o.label === "string" ? o.label : typeof o.name === "string" ? o.name : o.id;
    const provider = typeof o.providerName === "string" ? o.providerName : typeof o.provider === "string" ? o.provider : undefined;
    // A model a third-party plugin brings says which plugin it comes from; MOSS's own (the `moss` tree) don't.
    const from = typeof o.plugin === "string" && o.plugin.split("/")[0] !== "moss" ? o.plugin : undefined;
    const detail = from === undefined ? provider : provider === undefined ? S.modelFrom(from) : `${provider} · ${S.modelFrom(from)}`;
    const efforts = Array.isArray(o.efforts) ? o.efforts.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    return [{
      id: o.id, label, ...(detail !== undefined ? { detail } : {}), ...(typeof o.signedIn === "boolean" ? { signedIn: o.signedIn } : {}),
      ...(efforts.length > 0 ? { efforts } : {}),
      ...(typeof o.defaultEffort === "string" && efforts.includes(o.defaultEffort) ? { defaultEffort: o.defaultEffort } : {}),
    }];
  });
}

/** The agent's other selectable options (`models.list {session}`'s `options`), read defensively: a fixed list of values each. */
function optionsOf(catalog: unknown): { id: string; name: string; current?: string; values: { value: string; label: string }[] }[] {
  const list = (catalog as { options?: unknown[] } | undefined)?.options;
  if (!Array.isArray(list)) return [];
  return list.flatMap((o) => {
    const x = o as { id?: unknown; name?: unknown; current?: unknown; values?: unknown };
    if (typeof x.id !== "string" || !Array.isArray(x.values)) return [];
    const values = x.values.flatMap((v) => {
      const y = v as { value?: unknown; name?: unknown };
      return typeof y.value === "string" ? [{ value: y.value, label: typeof y.name === "string" && y.name !== "" ? y.name : y.value }] : [];
    });
    return values.length === 0 ? [] : [{ id: x.id, name: typeof x.name === "string" && x.name !== "" ? x.name : S.optionFallback(x.id), ...(typeof x.current === "string" ? { current: x.current } : {}), values }];
  });
}

export function ComposerEntry({ props }: { props: ComposerEntryProps }) {
  const api = usePluginApi();
  const host = useComposerHost();
  const send = useUserSend();
  const { cards } = useApprovals();
  // The buttons plugins add under keys of their own (the spot's `*`), in its order.
  const added = useSpotEntries("composer.action", "*", { bot: props.bot }).entries.filter((e) => e.key !== undefined);
  // A pick changes the session's own model: the session is read again after it, so the label says what the next turn runs on.
  const [rev, setRev] = useState(0);
  const session = useLoad(() => api.sessions?.get?.(props.session), [api, props.session, rev]);
  const kind = session?.kind ?? props.sessionKind;
  const computers = useLoad(() => api.computers?.list?.(), [api]);
  // Read again after a pick and when the session's state changes: its agent reports its options once it has started.
  const catalog = useLoad(() => host?.models(), [host, rev, session?.status]);
  // The draft is the user's: it outlives a reload of the window's document (installing or turning on a plugin with
  // its own layer loads it again), per conversation.
  const [draft, setDraft] = useKept<string>(`composer.draft:${props.session}`, "");
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const where = session?.computer;
  const computer = computers?.find((c) => c.name === where);
  const running = session?.status === "prompting" || session?.status === "starting" || session?.status === "cancelling";
  const cardPending = cards.some((c) => c.session === props.session);
  const current = session?.model;
  const effort = session?.effort;
  const models = modelsOf(catalog);
  const currentModel = models.find((m) => m.id === current);
  const options = host === undefined ? [] : optionsOf(catalog);
  const [commands, setCommands] = useState<SlashCommand[] | undefined>(undefined);
  const [slashResult, setSlashResult] = useState<ComposerSlash["result"]>(undefined);

  // A composer whose command list the app refuses (its plugin holds no `commands.run`) has no slash menu: a `/` line is
  // plain text it sends like any other.
  const [noCommands, setNoCommands] = useState(false);
  const slash: ComposerSlash | undefined =
    host !== undefined && !noCommands
      ? {
          commands,
          onOpen: () => {
            setCommands(undefined);
            host.commands!().then(
              (r) => setCommands((Array.isArray(r?.commands) ? r.commands : []).filter((c) => inScope(c, kind))),
              () => {
                setCommands([]);
                setNoCommands(true);
              },
            );
          },
          onRun: (command, rest, display) => {
            const args = argsFor(command.args, rest, display);
            if (!args.ok) {
              setSlashResult({ name: display, text: args.why, refused: true });
              return;
            }
            setSlashResult(undefined);
            const ran = draft;
            // Called inside the key press or click: the host counts it as the user's only then.
            host.runCommand!(command.name, args.args).then(
              (r) => {
                setSlashResult({ name: display, text: resultText(r?.result), refused: false });
                // The line went to the plugin; anything typed since stays.
                setDraft((d) => (d === ran ? "" : d));
              },
              (err: unknown) => setSlashResult({ name: display, text: refusalText(err), refused: true }),
            );
          },
          ...(slashResult ? { result: slashResult } : {}),
          onDismissResult: () => setSlashResult(undefined),
        }
      : undefined;

  // A coding session on an agent that was started on its own default has no model of its own yet: the picker still lists
  // what the agent offers (`models.list {session}`: the models its agent reported, or its list as known), and the pill
  // says so. A pick takes through `session.setModel`, and a refusal shows as it does for any model.
  const model: ComposerModelChoice | undefined =
    host && (current || (kind === "coding" && models.length > 0))
      ? {
          model: current ?? "",
          ...(effort ? { effort } : {}),
          models: current === undefined || models.some((m) => m.id === current) ? models : [{ id: current, label: current }, ...models],
          ...(currentModel?.efforts ? { efforts: currentModel.efforts } : {}),
          ...(currentModel?.defaultEffort ? { defaultEffort: currentModel.defaultEffort } : {}),
          onChange: ({ model: next, effort: asked }) => {
            // The core's composer spot decides what a switch is (a bot's user layer, or the session's own model).
            setNotice(undefined);
            // A level goes with the model only when that model takes it; one that doesn't gets its own default.
            const to = models.find((m) => m.id === next);
            const nextEffort = to?.efforts !== undefined && asked !== undefined && !to.efforts.includes(asked) ? to.defaultEffort : asked;
            host.setModel(next, nextEffort).then(() => setRev((n) => n + 1), () => setNotice(S.modelRefused));
          },
        }
      : undefined;

  // The theme can set the row under the text inside the box (`composer.controls.inside`).
  const tokens = useTokens();
  const controlsInside = Number(tokens["composer.controls.inside"] ?? 0) === 1;

  return (
    <Composer
      controlsInside={controlsInside}
      botName={props.bot.name}
      value={draft}
      onChange={(v) => { setNotice(undefined); setDraft(v); }}
      onSend={(message) => {
        // The user's own words, from inside this key press or click: the app's one door for them (`pill.send`).
        if (!send) return;
        setNotice(undefined);
        void send({ session: props.session }, { text: message.text }).then(() => setDraft(""), (err: unknown) => {
          // The send was refused: the draft stays, and the person is told why in a few words (the reason is in the app's log).
          const text = err instanceof Error ? err.message : "";
          setNotice(/isn't running/.test(text) ? S.sendRefusedStopped : /key press or click/.test(text) ? S.sendRefusedGesture : S.sendRefused);
        });
      }}
      notice={notice}
      running={running}
      onStop={host ? () => void host.interrupt().catch(() => undefined) : undefined}
      cardPending={cardPending}
      {...(slash ? { slash } : {})}
      {...(model ? { model } : {})}
      {...(options.length > 0 && host !== undefined
        ? {
            options: options.map((o) => ({
              id: o.id, name: o.name, ...(o.current !== undefined ? { value: o.current } : {}), values: o.values,
              // The person's pick, through the engine; the agent may refuse it, which is said as a refused model is.
              onChange: (value: string) => {
                setNotice(undefined);
                host.setOption(o.id, value).then(() => setRev((n) => n + 1), () => setNotice(S.optionRefused));
              },
            })),
          }
        : {})}
      {...(computer
        ? {
            level: {
              computer: computer.name,
              level: computer.level,
              levels: MOSS_LEVELS,
              // No onRequest: the core's way to ask for a level change through a sealed card isn't there yet, so the
              // level is a label (computer.setLevel is never called around a card).
            },
          }
        : {})}
      renderAction={(id: ComposerActionId, standard: ReactNode) => (
        <Spot name="composer.action" spotKey={id} props={{ bot: props.bot, session: props.session }} fallback={standard} />
      )}
      added={added.map((e) => (
        <Spot key={`${e.pluginId}#${e.id}`} name="composer.action" spotKey={e.key} entry={`${e.pluginId}#${e.id}`} props={{ bot: props.bot, session: props.session }} />
      ))}
    />
  );
}
