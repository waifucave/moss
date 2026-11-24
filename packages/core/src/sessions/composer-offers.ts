// `session.composerOffers` (PH3): what the phone's composer offers in one conversation, answered in one read from the pieces the
// engine already has (the stage doors, the plugins' commands, the model list). The phone shows a row only when this says the door
// behind it is open, so no row is a promise the engine will refuse. Changes nothing. Owner: lane PH.
import {
  SESSIONS_METHODS, STAGE_FILE_CHUNK_BYTES, STAGE_FILE_MAX_BYTES, STAGE_FILES_PER_MESSAGE_MAX, STAGE_IMAGE_MAX_BYTES, type ModelListing, type SessionView, type Text,
} from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import { handler, requireUser, type MethodHandler } from "../rpc/handler";
import { isPhoneCaller, type PhoneMay } from "../rpc/phone-door";

export interface ComposerOffersDeps {
  view(id: string): SessionView | undefined;
  /** Whether the conversation's own doors are open on this computer: a bot's main conversation that runs here, or a coding
   *  session here; false for any other session, one that has ended, or one another computer runs. Same rule as the stage doors. */
  heldHere(v: SessionView): boolean;
  /** The bot's model (a qualified id), or none. */
  botModel(bot: string): string | undefined;
  /** The models the session may run, as `models.list {session}` lists them, and the user's default. */
  models(session: string): Promise<{ models: readonly ModelListing[]; default?: string }>;
  /** The plugins' commands, as `command.list` lists them. */
  commands(): readonly { name: string; description: Text }[];
  /** Whether this engine takes a phone's files at all (it knows the user's home). */
  filesOpen: boolean;
  phoneMay?: PhoneMay;
}

const MAX_COMMANDS = 200;
const MAX_MODELS = 300;

export function composerOffersMethods(deps: ComposerOffersDeps): Record<string, MethodHandler> {
  const M = SESSIONS_METHODS.sessionComposerOffers;
  return {
    [M.name]: handler(M, async ({ id }, ctx) => {
      const caller = requireUser(ctx, "read what a composer offers");
      const v = deps.view(id);
      if (v === undefined || (v.kind === "bot" && v.bot === undefined)) throw new ContractError("not_found", `no session ${id}`);
      const bot = v.kind === "bot";
      if (!bot && v.kind !== "coding") throw new ContractError("refused", "a composer is a bot's conversation's or a coding session's");
      const here = deps.heldHere(v);
      const { models: listed, default: fallback } = await deps.models(id);
      const model = bot ? deps.botModel(v.bot!) ?? fallback : v.model ?? fallback;
      const current = model === undefined ? undefined : listed.find((m) => m.id === model);
      // Pictures: the door is open, and the model, when it is known, takes them (a model the catalog doesn't know is given the chance).
      const pictures = here && current?.images !== false;
      // Files: the door is open for a phone the gate lets in now (the registry's record of it, as the door itself asks).
      const mayStage = here && deps.filesOpen && (!isPhoneCaller(caller) || (caller.device !== undefined && deps.phoneMay?.(caller.device) === true));
      return {
        kind: bot ? "bot" as const : "coding" as const,
        pictures,
        ...(mayStage && pictures ? { pictureChunks: { maxBytes: STAGE_IMAGE_MAX_BYTES, chunkBytes: STAGE_FILE_CHUNK_BYTES } } : {}),
        ...(mayStage ? { files: { maxBytes: STAGE_FILE_MAX_BYTES, perMessage: STAGE_FILES_PER_MESSAGE_MAX, chunkBytes: STAGE_FILE_CHUNK_BYTES } } : {}),
        commands: deps.commands().slice(0, MAX_COMMANDS).map((c) => ({ name: c.name, description: c.description })),
        // A bot's model and effort are its user layer, which a phone doesn't set: no row (`session.setModel` refuses a bot's conversation).
        models: bot || !here ? [] : listed.filter((m) => m.signedIn).slice(0, MAX_MODELS).map((m) => ({ id: m.id, name: m.name, efforts: [...m.efforts] })),
        ...(bot || !here || model === undefined ? {} : { model }),
        efforts: bot || !here ? [] : [...(current?.efforts ?? [])],
        ...(bot || !here ? {} : (v.effort ?? current?.defaultEffort) === undefined ? {} : { effort: (v.effort ?? current?.defaultEffort)! }),
      };
    }),
  };
}
