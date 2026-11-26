// askUser (R1, "the card on the caller"): when another computer's holder refuses a call until the user answers, this
// computer shows the user that holder's own card through its approval broker and hands back their signed answer.
//
// * The card is the holder's, raised as it is (`ApprovalRequest.boundCard`, lane C): exactly its content and its
//   sealed binding, never re-rendered here, so what the user signs is what the holder rebuilds from the call itself
//   and compares (`verifySignedAnswer`). The card is checked against the refusal first: one bound call, the method
//   the refusal names, on the computer it names (and, for a transfer, its source).
// * It is the asking call's card: its session (withdrawn on the user's interrupt, cancelled when it stops), its bot,
//   and its turn's origin (`askOrigin`: a call that didn't say is unattended, so its card is denied after 10 minutes).
// * Its first line is MOSS's (`callCardTitle`), naming the computer that holds the call; a card that doesn't open
//   with exactly that line isn't shown (the holder words the rest of its card, never the line that says whose it is).
// * Only a device's signature travels: the broker hands back the proof that approved the card
//   (`ApprovalDecision.signed`), with the program whose key signed it (MOSS, MOSS Code, the host), which the holder
//   checks with that program's key alone. An expired or withdrawn card, a refusal or a broker that fails give null,
//   and the call stays refused with the holder's words; the person's no, a yes with no signature (an app without an
//   answer key) and a computer where no device of theirs signs answers each refuse in their own words (lane XC).
import { CallBinding, Card, type SignedCardAnswer } from "@waifucave/moss-protocol";
import type { ActionEffect, ApprovalBroker } from "../contracts/approval-broker";
import { ContractError } from "../contracts/common";
import { askOrigin, type AnswerAsker } from "../tree/judge";
import { callCardTitle } from "./call-cards";

/** The holder's card as a refusal carries it: a card's content, its binding sealed. */
const HolderCard = Card.pick({ kind: true, fields: true, options: true, change: true, children: true }).extend({ binds: CallBinding });

/** What each call a card may bind does, for the request's effect (the card is always shown: rule 9). */
export function effectOfCall(method: string): ActionEffect {
  switch (method) {
    case "tree.remove": return "delete";
    case "tree.move": case "tree.transfer": return "move";
    case "tree.write": case "tree.mkdir": case "tree.symlink": return "edit";
    case "tool.run": case "terminal.open": case "mcp.mirror": return "execute";
    default: return "other";
  }
}

/** No device of the person's here can sign an answer (lane XC): the card would wait for nothing. */
export function noSignerWords(computer: string): string {
  return `${computer} needs your yes from a device that signs its answers (MOSS on a computer, or your phone); none is set up here`;
}

/** A yes that came back unsigned (an app without an answer key): the holder can't check it. */
export function unsignedYesWords(computer: string): string {
  return `your yes here can't be checked by ${computer}: this app has no answer key`;
}

/** The person answered no on the holder's card. */
export function saidNoWords(computer: string): string {
  return `you said no to this on ${computer}'s card`;
}

export function brokerAsker(o: {
  broker: Pick<ApprovalBroker, "request" | "get">;
  /** Whether any of the person's devices can sign an answer (lane XC); false refuses at once, with words that say so. */
  canSign?: () => boolean;
  log?: (line: string) => void;
}): AnswerAsker {
  const log = o.log ?? (() => {});
  return async (need, ctx) => {
    const parsed = HolderCard.safeParse(need.card);
    if (!parsed.success) {
      log(`askUser: ${need.computer}'s refusal of ${need.method} carried no card this computer can show`);
      return null;
    }
    const card = parsed.data;
    const b = card.binds;
    // The card binds the call the refusal names, on the computer it names.
    if (b.method !== need.method || b.computer !== need.computer) {
      log(`askUser: ${need.computer}'s card for ${need.method} binds another call`);
      return null;
    }
    // Its first line is MOSS's, naming the computer that holds the call (the stage 1 review): a paired computer words
    // the rest of its card, never that line. A card without it isn't shown.
    const title = card.fields.title;
    if (title?.type !== "text" || title.text !== callCardTitle(need.computer)) {
      log(`askUser: ${need.computer}'s card for ${need.method} doesn't open with MOSS's line naming it`);
      return null;
    }
    // No device here can sign: refuse now, plainly, instead of a card no answer could lift.
    if (o.canSign !== undefined && !o.canSign()) {
      log(`askUser: ${need.computer}'s card for ${need.method}: no device of the person's here signs answers`);
      throw new ContractError("refused", noSignerWords(need.computer));
    }
    const as = ctx.as;
    const session = as.kind === "session" ? as.sessionId : undefined;
    const bot = as.kind === "session" ? as.bot : undefined;
    let d: Awaited<ReturnType<typeof o.broker.request>>;
    try {
      d = await o.broker.request({
        kind: card.kind, ...(card.change === undefined ? {} : { change: card.change }),
        origin: askOrigin(ctx), computers: [b.computer, ...(b.source === undefined ? [] : [b.source])],
        effect: effectOfCall(need.method), fields: card.fields, boundCard: card,
        ...(session === undefined ? {} : { session }), ...(bot === undefined ? {} : { bot }),
      }, ctx.signal ? { signal: ctx.signal } : {});
    } catch (e) {
      log(`askUser: the approval broker failed on ${need.computer}'s card: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    // The person's own no, on the card: said in its own words (an expired or withdrawn card keeps the holder's refusal).
    if (!d.allowed) {
      if (d.by === "card") throw new ContractError("refused", saidNoWords(need.computer));
      return null;
    }
    if (d.signed === undefined) throw new ContractError("refused", unsignedYesWords(need.computer));
    if (d.cardId === undefined || d.optionId === undefined) return null;
    const shown = o.broker.get(d.cardId)?.card;
    // The card the user answered is the one raised: the holder's binding, as sealed.
    if (!shown || shown.binds?.params !== b.params || shown.binds.method !== b.method || shown.binds.computer !== b.computer) return null;
    const answer: SignedCardAnswer = {
      card: shown, option: d.optionId, device: d.signed.device, at: d.signed.at, signature: d.signed.signature,
      ...(d.signed.children === undefined ? {} : { children: d.signed.children }),
      // The program whose key signed it (MOSS, MOSS Code, the host): the holder checks with that program's key alone.
      ...(d.signed.program === undefined ? {} : { program: d.signed.program }),
    };
    return answer;
  };
}
