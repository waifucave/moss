// The `bot.*` methods of bots as engine data (protocol `bots.ts`, `BOTS_METHODS`), served with records as the bots'
// source (`bots/source.ts`); with plugins as the source only `bot.move.status` is served, and the rest stay "not served
// yet". Owner: lane BT. The server checks roles, capabilities and `userOnly` before a handler runs; each handler that
// changes something checks the caller again (`requireUser`): a bot's or a plugin's call never counts as the person's.
import { BOTS_METHODS, type ChangeResult } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import type { DurableSessionHost } from "../sessions/durable-host";
import { projectRecords, readsSealed, type WireEvent } from "../sessions/wire";
import { handler, requireUser, type MethodHandler } from "../rpc/handler";
import { isPhoneCaller, requirePairedPhone, type PhoneMay } from "../rpc/phone-door";
import { PhoneBotCap } from "./phone-bot-cap";
import type { PluginBotSettings } from "./plugin-bot-settings";
import type { BotService } from "./service";

export interface BotRecordMethodsDeps {
  bots: BotService;
  host: Pick<DurableSessionHost, "history" | "length">;
  /** Every plugin's bot-scoped settings for one bot, with their schema (`bot.pluginSettings`); without it, not served. */
  pluginSettingViews?: PluginBotSettings["views"];
  /** Whether the paired phone `device` may act on this computer now (`mayStartSessions` over the device registry's record of it).
   *  `bot.create` from a phone's connection (`remote`) is refused unless this says yes; without it none is let make a bot. */
  phoneMay?: PhoneMay;
  /** MOSS's home, where a phone's day count of made bots is kept (`transcripts/.phone-bot-creates.json`), and the clock that dates it.
   *  Without them a phone's create is refused: the cap can't be kept. */
  capHome?: { home: string; now: () => number; perDay?: number };
}

const SCAN_STEP = 200;

export function botRecordMethods(deps: BotRecordMethodsDeps): Record<string, MethodHandler> {
  const { bots, host } = deps;
  const M = BOTS_METHODS;
  const status: Record<string, MethodHandler> = {
    [M.botMoveStatus.name]: handler(M.botMoveStatus, async () => bots.moveStatus()),
  };
  const store = bots.records;
  if (store === undefined) return status;
  const cap = deps.capHome === undefined ? undefined : new PhoneBotCap(deps.capHome);
  const must = (id: string) => {
    if (!store.has(id)) throw new ContractError("not_found", `no bot ${id}`);
  };
  return {
    ...status,
    [M.botRecords.name]: handler(M.botRecords, async () => ({ bots: store.list() })),
    [M.botCreate.name]: handler(M.botCreate, async ({ name, instructions, model, effort, face }, ctx) => {
      const caller = requireUser(ctx, "make a bot");
      // A phone's call (the owner's decision of 2026-11-24): the same call, from a phone that is still paired with an answer key
      // now. It is the person's own act from that device, as the desktop's is from the app, with two limits the desktop doesn't have.
      requirePairedPhone(caller, deps.phoneMay, "make a bot");
      let taken: number | undefined;
      if (isPhoneCaller(caller)) {
        // "A name and a model, exactly as the desktop's plus does": anything else is refused, not dropped, so the app learns.
        const extra = [instructions !== undefined && "instructions", effort !== undefined && "effort", face !== undefined && "face"].filter((k) => k !== false);
        if (extra.length > 0) throw new ContractError("refused", `a phone makes a bot with a name and a model only; set the ${extra.join(" and ")} on the desktop`);
        if (cap === undefined) throw new ContractError("refused", "this engine can't count a phone's bots, so a phone can't make one here");
        taken = cap.take(caller.device!);
      }
      try {
        const bot = await bots.createBot({
          name, ...(instructions === undefined ? {} : { instructions }), ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }), ...(face === undefined ? {} : { face }),
        }, { kind: "user" });
        return { bot };
      } catch (err) {
        if (taken !== undefined) cap!.give(caller.device!, taken);
        throw err;
      }
    }),
    [M.botEdit.name]: handler(M.botEdit, async ({ id, patch }, ctx): Promise<ChangeResult> => {
      requireUser(ctx, "change a bot");
      must(id);
      await bots.editBot(id, patch);
      return { applied: true };
    }),
    [M.botRemove.name]: handler(M.botRemove, async ({ id }, ctx) => {
      requireUser(ctx, "remove a bot");
      await bots.archiveBot(id);
      return { ok: true as const };
    }),
    // The person's own client only (the method is `userOnly`; checked again here): the text they are about to edit.
    [M.botInstructionsGet.name]: handler(M.botInstructionsGet, async ({ id }, ctx) => {
      requireUser(ctx, "read a bot's instructions");
      must(id);
      return { text: store.instructions(id) };
    }),
    [M.botArchived.name]: handler(M.botArchived, async () => ({ bots: bots.archivedBots() })),
    [M.botRestore.name]: handler(M.botRestore, async ({ id }, ctx) => {
      requireUser(ctx, "bring a bot back");
      return { bot: await bots.restoreBot(id) };
    }),
    // One page of a bot's one conversation, newest last: its main session's history, read back from `before` until the
    // page holds `limit` events. A reader other than the person's own app and devices gets cards without their sealed
    // parts.
    [M.botConversation.name]: handler(M.botConversation, async ({ id, before, limit }, ctx) => {
      must(id);
      const session = bots.mainSession(id);
      const opts = { kind: "bot" as const, sealed: !readsSealed(ctx.caller) };
      const length = host.length(session);
      const eventsIn = (start: number, end: number) => projectRecords(host.history(session, { afterSeq: start - 1, limit: end - start }), opts);
      let end = Math.min(before ?? length, length);
      const page: WireEvent[] = [];
      let hasMore = false;
      while (end > 0) {
        const start = Math.max(0, end - SCAN_STEP);
        const events = eventsIn(start, end);
        const need = limit - page.length;
        if (events.length > need) {
          page.unshift(...events.slice(events.length - need));
          hasMore = true;
          break;
        }
        page.unshift(...events);
        end = start;
        if (page.length === limit) {
          for (let e = end; e > 0 && !hasMore; e = Math.max(0, e - SCAN_STEP)) hasMore = eventsIn(Math.max(0, e - SCAN_STEP), e).length > 0;
          break;
        }
      }
      return { session, events: page as Record<string, unknown>[], hasMore };
    }),
    ...(deps.pluginSettingViews === undefined ? {} : {
      [M.botPluginSettings.name]: handler(M.botPluginSettings, async ({ id }) => {
        must(id);
        return { plugins: await deps.pluginSettingViews!(id) };
      }),
    }),
    [M.botSummaries.name]: handler(M.botSummaries, async () => ({ summaries: bots.summaries() })),
    [M.botMarkRead.name]: handler(M.botMarkRead, async ({ id, at }, ctx) => {
      requireUser(ctx, "mark a bot's conversation read");
      bots.markRead(id, at);
      return { ok: true as const };
    }),
  };
}
