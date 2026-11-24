// `session.delete` (the deletion lane, item 3): the person deletes a session or a bot's conversation, from an app (on
// the engine's card) or their own terminal. The host deletes the transcript (and the sessions it started); what is kept
// beside each goes after (`session-files.ts`); a bot's conversation then opens again, empty.
import { SESSIONS_METHODS, type SessionView } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import { handler, type CardOpener, type MethodHandler } from "../devices/rpc";
import { byThePerson } from "./person";
import { journalSessionDeletion, removeSessionFiles, unjournalSessions, type SessionFileDeps } from "./session-files";

export interface SessionDeletionMethodsDeps {
  home: string;
  host: {
    get(id: string): SessionView | undefined;
    remove(id: string): Promise<{ id: string; bot?: string; kind: string }[]>;
  };
  bots?: {
    mainSession(bot: string): string;
    conversationDeleted(bot: string): Promise<void>;
    sessionRemoved(id: string): void;
    /** The bots whose conversations this computer runs (the main computer's): a conversation is deleted only there, where
     *  its copy is the one the others follow. */
    botsRunHere?(): string[];
  };
  openCard: CardOpener;
  files?: Omit<SessionFileDeps, "home">;
  log?(line: string): void;
}

const isMain = (deps: SessionDeletionMethodsDeps, v: SessionView): boolean => {
  if (v.kind !== "bot" || v.bot === undefined || !deps.bots) return false;
  try {
    return deps.bots.mainSession(v.bot) === v.id;
  } catch {
    return false;
  }
};

/** Deletes one session and what it started, then what is kept beside each. */
export async function deleteSession(deps: SessionDeletionMethodsDeps, id: string): Promise<string[]> {
  const v = deps.host.get(id);
  if (!v) throw new ContractError("not_found", `no session ${id}`);
  const main = isMain(deps, v) ? v.bot : undefined;
  // The journal first: a stop from here on is finished at the next start.
  journalSessionDeletion(deps.home, [{ id, ...(v.bot === undefined ? {} : { bot: v.bot }), kind: v.kind }]);
  let removed: { id: string; bot?: string; kind: string }[];
  try {
    removed = await deps.host.remove(id);
  } catch (err) {
    // Nothing of it was deleted: off the journal, so a start never removes a live session's files.
    unjournalSessions(deps.home, [id]);
    throw err;
  }
  journalSessionDeletion(deps.home, removed);
  await removeSessionFiles({ home: deps.home, ...(deps.files ?? {}), ...(deps.log ? { log: deps.log } : {}) }, removed);
  for (const s of removed) deps.bots?.sessionRemoved(s.id);
  if (main !== undefined) await deps.bots?.conversationDeleted(main);
  return removed.map((s) => s.id);
}

export function sessionDeletionMethods(deps: SessionDeletionMethodsDeps): Record<string, MethodHandler> {
  const M = SESSIONS_METHODS;
  return {
    [M.sessionDelete.name]: handler(M.sessionDelete, async (p, ctx) => {
      const v = deps.host.get(p.id);
      if (!v) throw new ContractError("not_found", `no session ${p.id}`);
      const main = isMain(deps, v);
      if (main && v.bot !== undefined && deps.bots?.botsRunHere !== undefined && !deps.bots.botsRunHere().includes(v.bot)) {
        throw new ContractError("refused", `${v.bot}'s conversation runs on another computer: delete it there, where the copy the others follow is kept`);
      }
      const name = (v.title ?? "").trim() || (main ? (v.bot ?? p.id) : p.id);
      const res = await byThePerson(ctx, {
        what: "delete a session", confirm: p.confirm, openCard: deps.openCard,
        card: {
          change: "session-delete",
          title: main ? "Delete this conversation?" : "Delete this session?",
          what: "This deletes it from this computer for good. It can't be undone.",
          rows: [
            { label: main ? "The conversation" : "The session", value: name },
            { label: "Deleted", value: "its messages, the files staged for it or sent to it, its outputs, the side threads and agents it started with their transcripts, and its runtime state and logs" },
            { label: "Stays", value: main ? "the bot, its memory and its files; the conversation starts again, empty" : "files it wrote in your folders, and the bot it belongs to" },
          ],
        },
        run: async () => {
          await deleteSession(deps, p.id);
          return {};
        },
        onError: (err) => deps.log?.(`[sessions] ${p.id}'s deletion didn't finish (${err instanceof Error ? err.name : "error"}): it is finished at the next start`),
      });
      return res.applied ? { applied: true as const } : res;
    }),
  };
}
