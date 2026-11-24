// `bot.delete` (the deletion lane, item 4): the person deletes a bot for good, listed or archived, from an app (on the
// engine's card) or their own terminal. Archive (`bot.remove`) stays as it is, beside it. The bot service archives a
// live bot first and then deletes the archive's copy (records.ts `deleteArchived`, journaled in its mark); what is kept
// beside its sessions goes after (`session-files.ts`).
//
// A bot a plugin still brings (one the move hasn't made a record of) isn't the person's to delete here: they remove its
// plugin, which takes its definition; its memory and conversation stay under its id until it is moved and deleted.
import { BOTS_METHODS, ERR } from "@waifucave/moss-protocol";
import { handler, MethodError, type CardOpener, type MethodHandler } from "../devices/rpc";
import { byThePerson } from "./person";
import { journalSessionDeletion, removeSessionFiles, type SessionFileDeps } from "./session-files";

export interface BotDeletionMethodsDeps {
  home: string;
  bots: {
    /** The bot's name as the person sees it, listed or archived; undefined when there is no such bot to delete. */
    nameOf(id: string): string | undefined;
    deleteBot(id: string, before?: (sessions: string[]) => void): Promise<string[]>;
    sessionRemoved(id: string): void;
  };
  openCard: CardOpener;
  files?: Omit<SessionFileDeps, "home">;
  log?(line: string): void;
}

export async function deleteBot(deps: BotDeletionMethodsDeps, id: string): Promise<void> {
  const as = (ids: string[]) => ids.map((s) => ({ id: s, bot: id, kind: "bot" }));
  // Journaled before the bot's copy goes (`before`), so a stop in the middle still removes what is kept beside them.
  const sessions = await deps.bots.deleteBot(id, (ids) => journalSessionDeletion(deps.home, as(ids)));
  const listed = as(sessions);
  await removeSessionFiles({ home: deps.home, ...(deps.files ?? {}), ...(deps.log ? { log: deps.log } : {}) }, listed);
  for (const s of sessions) deps.bots.sessionRemoved(s);
}

export function botDeletionMethods(deps: BotDeletionMethodsDeps): Record<string, MethodHandler> {
  const M = BOTS_METHODS;
  return {
    [M.botDelete.name]: handler(M.botDelete, async (p, ctx) => {
      const name = deps.bots.nameOf(p.id);
      if (name === undefined) throw new MethodError(ERR.NOT_FOUND, `no bot ${p.id} to delete (a bot a plugin brings goes with its plugin)`);
      const res = await byThePerson(ctx, {
        what: "delete a bot", confirm: p.confirm, openCard: deps.openCard,
        card: {
          change: "bot-delete",
          title: "Delete this bot?",
          what: "This deletes the bot from this computer for good. It can't be undone. Archive keeps it instead.",
          rows: [
            { label: "The bot", value: name },
            { label: "Deleted", value: "its instructions and settings, its conversation and side threads, its memory, its scratch files, its agents' transcripts, its routines, your changes to it, and the rules you saved for it" },
            { label: "Stays", value: "files it wrote in your folders, and other bots" },
          ],
        },
        run: async () => {
          await deleteBot(deps, p.id);
          return {};
        },
        onError: (err) => deps.log?.(`[bots] ${p.id}'s deletion didn't finish (${err instanceof Error ? err.name : "error"}): it is finished at the next start`),
      });
      return res.applied ? { applied: true as const } : res;
    }),
  };
}
