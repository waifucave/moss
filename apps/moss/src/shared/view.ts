// What MOSS's main process hands its window (spec §3.6 "What the engine gives MOSS as plain data", §6.10): plain data,
// states and names, never a sealed card's text and never markup. The window draws it with React text nodes only. Types
// alone, shared by the main process and the window (no Node, no DOM).
import type { ActivityState, BotFace, ToolAvailability } from "@waifucave/moss-protocol";

/** A face's pinned traits (§6.9, lane BT's record): shape, colour, eyes and temper, each optional, the rest from the name. */
export type { BotFace };

/** The engine pieces the window stands on, each served by its own lane: until a piece is served, the window says it is
 *  waiting for it, never shows something made up. */
export type Piece = "bots" | "summaries" | "activity" | "routines" | "memory" | "pictures" | "router" | "tools" | "plugins" | "account" | "devices" | "models" | "key";
export type PieceState = "ready" | "waiting" | "failed";

export type ConnectionKind = "connecting" | "starting-engine" | "connected" | "reconnecting" | "behind" | "refused" | "unavailable" | "stopped";

export interface BotRow {
  id: string;
  name: string;
  /** The traits the person pinned (shape, colour); the rest comes from the name. */
  face?: BotFace;
  /** From the activity feed; `idle` until the feed says otherwise. */
  mood: ActivityState;
  /** The tool's wire name while `working`, never its arguments. */
  tool?: string;
  /** While `working`: the running call's file base name or site host, and a plugin tool's own title, when this window
   *  has the call (the open bot's session); the status line's only inputs besides `mood` and `tool`. */
  detail?: string;
  title?: string;
  last?: { text: string; from: "user" | "bot" | "note"; at: number };
  unread: boolean;
  /** The default bot (her record says the engine made her by default): the one the window opens on by itself. */
  default?: true;
}

/** A card the router placed in MOSS's window: its ids only (its words are sealed, drawn by its own frame). */
export interface CardRow {
  id: string;
  bot?: string;
  kind: string;
  /** In the conversation of the bot it belongs to, or in the window's own strip. */
  place: "conversation" | "strip";
}

export interface MossView {
  connection: { kind: ConnectionKind; reason?: string };
  pieces: Partial<Record<Piece, PieceState>>;
  bots: BotRow[];
  cards: CardRow[];
  /** Whether the microphone can run the voice plugin's talk command now, and why not when it can't. */
  talk?: { ready: true } | { ready: false; why: string };
  /** The engine's release, when connected. */
  engine?: string;
  /** One plain notice for the person (the background host the engine gave up starting), or none. */
  notice?: string;
  /** What the home's setup needs (the engine's `setup.state`): the setup guide opens by itself while it isn't ready and
   *  the person hasn't skipped it. Absent until the engine answers (an older engine never does). */
  setup?: SetupRow;
  /** A card the setup guide waits behind is pending (the old home's copy), though not drawn in this window. */
  setupWaits?: true;
  /** A pairing under way (Settings, Devices), as the engine's steps have it, and how many times the devices changed (the page reads
   *  its list again when this moves). Absent until the person starts a pairing, and until a device changes. */
  pairing?: PairingRow;
  devicesRev?: number;
}

/** The relay this computer's device links use (`device.relay.get`): n0's public relays by default, none, or the person's own server. */
export interface RelayRow {
  mode: "n0" | "off" | "custom";
  url?: string;
  /** The relay plugins installed (listed by what they bring, never by name): shown and not offered, as the links take none yet. Only `relay()` fills it. */
  plugins?: { id: string; name: string; why?: string }[];
}

/** A pairing of this computer with another device (spec §8.1): the code this computer shows (and the text a phone scans) with the time
 *  it stops working, then the step the engine's add card is at. The four words are never here: the engine draws them on its sealed
 *  card, and no part of the window is given them. */
export interface PairingRow {
  /** The short code to enter on the other device, when the engine has one. */
  code?: string;
  /** The pairing's text: what the picture a phone scans holds, and what is typed or pasted on a computer when there is no short code. */
  qr?: string;
  /** When the code stops working, in ms. */
  expiresAt?: number;
  /** Another device is in: the engine's add card is up (or on its way) and holds the four words. */
  checking?: boolean;
  /** The name the other device gave itself, once known. */
  peerName?: string;
  /** While the code waits: a device tried to join and was turned away, said in the engine's words (never the other device's own text). */
  note?: string;
  /** It ended: said in words (a device added, a failure, an expired code). */
  ended?: string;
}

/** The engine's answer to "is this home set up for a first reply" (`setup.state`). */
export interface SetupRow {
  ready: boolean;
  missing: ("provider" | "model" | "default-provider")[];
  /** The providers the person added, by catalog id. */
  providers: string[];
  default?: { model: string; source: "chosen" | "computed"; effort?: string };
  /** The default model the settings name while its provider isn't signed in (`missing` has `default-provider`). */
  signedOut?: string;
  /** Each added provider's recommended default (its family's model and effort), where it has one. */
  recommended?: Record<string, { model: string; effort?: string }>;
  /** The local servers that answered, each one the person has, with how many models it lists (0: none pulled yet). */
  local?: Record<string, number>;
  dismissed: boolean;
}

/** A model provider the setup guide offers, with its own way in: its terms first (a link main opens, or a short text),
 *  then a key or a sign-in. */
export interface ProviderRow {
  pluginId: string;
  name: string;
  /** The catalog providers the plugin serves (its manifest's `models[].provider`): added when setup counts one of them. */
  providers?: string[];
  terms?: { link: true } | { text: string };
  auth: { index: number; method: "api-key" | "oauth-pkce" | "custom" | "core"; state: string; account?: string; help?: string }[];
}

export interface Attachment {
  /** The file's name as shown (its last path segment), never its contents. */
  name: string;
  kind: "file" | "image";
}

/** One question a bot asked (`AskUserQuestion`): its words and its options, as plain data. */
export interface QuestionView {
  question: string;
  /** A short chip (12 characters at most). */
  header?: string;
  /** None: answered by typing; two to four: a menu, always with a free-text box beside it. */
  options: { label: string; description?: string; preview?: string }[];
  multiSelect: boolean;
  placeholder?: string;
}

/** A bot's question in its conversation: pending while it waits for the person, then answered (with what was chosen),
 *  expired (no answer in time) or withdrawn (its turn ended). */
export interface QuestionState {
  callId: string;
  questions: QuestionView[];
  state: "pending" | "answered" | "expired" | "withdrawn";
  /** Keyed by the question's text. */
  answers?: Record<string, string>;
  notes?: Record<string, string>;
}

export interface Message {
  id: string;
  from: "user" | "bot" | "note" | "question";
  /** A bot's question, when `from` is `question` (its text is empty). The same id again is the same question, changed. */
  question?: QuestionState;
  /** The person's and a note's words are drawn as text; the bot's reply as Markdown (bold, lists, code, links), never as
   *  HTML: nothing a model wrote reaches the page as markup. */
  text: string;
  at: number;
  files?: Attachment[];
  /** A note that a turn ended in an error: the conversation offers Try again while it is the last thing there. */
  failed?: true;
  /** A routine's run that failed: its note says why, marked as a failure. */
  routineFailed?: true;
}

export interface ConversationPage {
  bot: string;
  messages: Message[];
  hasMore: boolean;
  /** The seq to page back from. */
  before?: number;
}

export interface RoutineRow {
  id: string;
  name: string;
  /** Its triggers in words (`Every day at 9:00`). */
  schedule: string;
  paused: boolean;
  /** The engine's state: on, paused (by the person or by MOSS), waiting for the person's OK on a raised level, a copy
   *  with the same id, or its bot removed. Only an `active` one can run now. */
  state: "active" | "paused" | "waiting-for-ok" | "duplicate" | "bot-removed";
  /** Why MOSS paused it, while it stays paused. */
  pausedWhy?: string;
  /** Its schedule trigger as written (`every 6h`, `0 8 * * 1-5`), for the edit form; none when it has no schedule. */
  scheduleSpec?: string;
  nextRunAt?: number;
}

/** What the person changes on a routine (`routine.edit`): its file is rewritten by the engine. */
export interface RoutineEdit {
  name?: string;
  schedule?: string;
  instructions?: string;
  paused?: boolean;
}

/** One file of a bot's memory, as the engine serves it to MOSS (`memory.list`): read only here. */
export interface MemoryFileRow {
  path: string;
  size: number;
  modifiedAt: number;
}

export interface PictureRow {
  id: string;
  /** The plugin that publishes it (its id, shown beside the picture), and its name when the engine lists it. */
  publisher: string;
  publisherName?: string;
  tool?: string;
  width: number;
  height: number;
  screen: boolean;
}

/** One frame of a live picture: inert pixels, a data URL of an image the engine checked. */
export interface PictureFrameView {
  id: string;
  seq: number;
  url: string;
}

export interface ToolRow {
  server: string;
  tool: string;
  availability: ToolAvailability;
  /** What the plugin declares, which is the default (`preload` is always on, `on-demand` on demand). */
  declared?: ToolAvailability;
  permission: "allow" | "ask" | "deny";
}

export interface PluginRow {
  id: string;
  name: string;
  enabled: boolean;
  tools: ToolRow[];
}

/** MOSS's own Settings (spec §6.10, R8): each section is the engine's data, or "waiting" while its piece isn't served. */
export interface SettingsView {
  account: { signedIn: boolean; name?: string; email?: string } | "waiting";
  /** The keys and sign-ins of the plugins that have any (models, voices): their state, never a key. */
  signIns: { pluginId: string; name: string; index: number; method: "api-key" | "oauth-pkce" | "custom" | "core"; state: string; account?: string }[] | "waiting";
  /** The approval level of each computer (this one first). */
  computers: { name: string; level: string }[] | "waiting";
  devices: { id: string; name: string; kind: string; here?: boolean; online?: boolean; lastSeen?: number }[] | "waiting";
}

/** One of a plugin's declared bot-scoped settings (a voice plugin's voice for this bot), drawn generically from its schema. */
export interface BotSetting {
  pluginId: string;
  pluginName: string;
  key: string;
  type: "string" | "number" | "boolean" | "enum" | "color" | "secret";
  title: string;
  description?: string;
  options?: { value: string; title: string }[];
  min?: number;
  max?: number;
  value?: unknown;
  set: boolean;
}

/** A bot's own record for its Edit view (the person's: name, model, effort, face pins). The instructions' text is read on
 *  its own (`botInstructions`). */
export interface BotRecordRow {
  id: string;
  name: string;
  model?: string;
  effort?: string;
  face?: BotFace;
  instructionsBytes: number;
}

/** A change to a bot's record or instructions; `null` clears a field back to the default. */
export interface BotEdit {
  name?: string;
  instructions?: string;
  model?: string | null;
  effort?: string | null;
  face?: BotFace | null;
}

/** A model the person can give a bot (`models.list`). */
export interface ModelRow {
  id: string;
  title: string;
  provider: string;
  /** Its provider is signed in, so it can run a turn now. */
  ready: boolean;
}

/** What the window may ask MOSS's main process: a fixed list, never a generic call (preload.ts). */
/** One thing picked or dropped for the composer: its name and id (never a path or bytes); `note` is one plain line to show
 *  (a picture over 10 MB goes as a file). */
export interface Attached { id: string; name: string; kind: "image" | "file"; note?: string }

export interface MossBridge {
  view(): Promise<MossView>;
  onView(fn: (view: MossView) => void): () => void;
  /** What the window shows now: a bot's conversation, or a page with none (presence's `showing`). */
  showing(page: { bot: string } | { page: "plugins" | "settings" | "none" }): void;
  /** A bot's conversation the engine asked this window to show (`app.show` with `what: { kind: "bot" }`, "Open in MOSS" from
   *  MOSS Code): the one waiting when the window loads, and each after it. */
  pendingShow(): Promise<{ bot: string } | undefined>;
  onShow(fn: (what: { bot: string }) => void): () => void;
  conversation(bot: string, before?: number): Promise<ConversationPage | { waiting: true }>;
  onMessage(fn: (bot: string, message: Message) => void): () => void;
  /** Sends the person's words to a bot, with the pictures and the files they picked (`pickAttachments`' and `dropAttachments`'
   *  ids, by kind); main takes it only right after their own key press or click. The engine's refusal of a file (too many,
   *  too big, a folder) comes back as its own plain sentence in `why`. */
  send(bot: string, text: string, images?: readonly string[], files?: readonly string[]): Promise<{ ok: true } | { ok: false; why: string }>;
  /** The person picks what to attach (main's own file dialog, any file): a PNG, JPEG or WebP up to 10 MB is a picture (at most
   *  4), anything else a file (at most 10); their names and the ids `send` takes. Never their bytes or paths in the window. */
  pickAttachments(): Promise<Attached[]>;
  /** Files dropped on the composer: the preload reads each one's path (`webUtils.getPathForFile`), main takes them as the
   *  dialog's. The window gets names and ids, never a path. */
  dropAttachments(files: readonly File[]): Promise<Attached[]>;
  /** The person removed a chip, or its composer went away (they switched bots): main lets go of what it kept for these ids. */
  releaseAttachments(ids: readonly string[]): void;
  /** Makes a bot with the model the person chose in the + flow (one of `models`), so its first turn has a credential. */
  createBot(name: string, model?: string): Promise<{ ok: true; id: string } | { ok: false; why: string }>;
  markRead(bot: string): void;
  routines(bot: string): Promise<RoutineRow[] | { waiting: true }>;
  /** A routine's instructions as its file has them now (`routine.get`), for the edit form. */
  routineInstructions(bot: string, id: string): Promise<{ text: string } | { ok: false; why: string }>;
  /** Runs a routine now (`routine.runNow`), after the person's own press. */
  runRoutine(id: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Pauses, resumes or edits a routine (`routine.edit`), after the person's own press; the engine's why on a refusal. */
  editRoutine(bot: string, id: string, patch: RoutineEdit): Promise<{ ok: true; routine: RoutineRow } | { ok: false; why: string }>;
  /** A bot's memory files and one file's text (`memory.list`, `memory.read`): read only. */
  memory(bot: string): Promise<MemoryFileRow[] | { waiting: true }>;
  memoryFile(bot: string, path: string): Promise<{ text: string } | { ok: false; why: string }>;
  pictures(bot: string): Promise<PictureRow[] | { waiting: true }>;
  openPicture(id: string): Promise<boolean>;
  closePicture(id: string): void;
  onPictureFrame(fn: (frame: PictureFrameView) => void): () => void;
  /** A card's sealed frame for this window: its single-use `moss-sealed://` URL, or undefined. */
  cardFrame(cardId: string): Promise<string | undefined>;
  onCardHeight(fn: (cardId: string, height: number) => void): () => void;
  /** Why a press on a card's button was refused, in plain words, to show beside the card. */
  onCardSaid(fn: (cardId: string, words: string) => void): () => void;
  /** The microphone button: held down and let go (main runs the voice plugin's talk command). */
  talk(phase: "down" | "up"): void;
  plugins(): Promise<PluginRow[] | { waiting: true }>;
  setAvailability(server: string, tool: string, availability: ToolAvailability): Promise<boolean>;
  /** Adds a plugin from a link, behind the normal OK card (the router draws it here); a file is picked by main. */
  addPlugin(from: { link: string } | { file: true }): Promise<{ ok: true } | { ok: false; why: string }>;
  settings(): Promise<SettingsView>;
  botSettings(bot: string): Promise<BotSetting[] | { waiting: true }>;
  /** A person's change to a bot's plugin setting; main takes it only right after their own press. */
  setBotSetting(bot: string, pluginId: string, key: string, value: unknown): Promise<boolean>;
  /** A computer's approval level: the engine raises a sealed card (a sensitive change), which the router places here. */
  setLevel(computer: string, level: string): Promise<boolean>;
  /** Pairing another device (spec §8.1), each the person's own press: show a code here, or enter the other device's. The window is
   *  never given the four words, and has no call that confirms: adding the device and removing one are each the engine's sealed card,
   *  which the router places here. The engine's why on a refusal. */
  pairBegin(): Promise<{ ok: true } | { ok: false; why: string }>;
  pairJoin(code: string): Promise<{ ok: true } | { ok: false; why: string }>;
  pairCancel(): Promise<boolean>;
  removeDevice(id: string): Promise<boolean>;
  /** A tool's permission (always allow / ask / always block), the person's own, after their press. */
  setPermission(server: string, tool: string, permission: "allow" | "ask" | "deny"): Promise<boolean>;
  /** Signs in with one of a plugin's `auth` entries: a key goes in once and never comes back; for a browser sign-in
   *  main opens the page itself (the window never sees the link). */
  signIn(pluginId: string, index: number, key?: string): Promise<{ state: string } | { ok: false; why: string }>;
  /** Signs out of one entry, after the person's yes on a sealed card the router places here. */
  signOut(pluginId: string, index: number): Promise<boolean>;
  botRecord(id: string): Promise<BotRecordRow | { waiting: true }>;
  /** The bot's instructions as they are now (`bot.instructions.get`, the person's own client only), so an edit never
   *  writes over text the person couldn't see; waiting while the engine doesn't serve it. */
  botInstructions(id: string): Promise<{ text: string } | { waiting: true }>;
  editBot(id: string, patch: BotEdit): Promise<boolean>;
  /** Archives a bot after the person's press (nothing is deleted); `archivedBots` lists them and `restoreBot` brings one
   *  back with its conversation whole. */
  archiveBot(id: string): Promise<boolean>;
  /** The deletion lane: each asks the engine, which raises its own sealed card naming what goes and what stays; only the
   *  person's yes there deletes. `false` when the engine didn't take the ask. A bot, listed or archived (`bot.delete`); a
   *  bot's conversation (`session.delete` of its main session: it starts again empty); the account (`account.delete`);
   *  and everything MOSS keeps here (`home.erase`: the apps quit, then the engine erases). */
  deleteBot(id: string): Promise<boolean>;
  deleteConversation(bot: string): Promise<boolean>;
  deleteAccount(): Promise<boolean>;
  eraseEverything(): Promise<boolean>;
  archivedBots(): Promise<{ id: string; name: string }[] | { waiting: true }>;
  restoreBot(id: string): Promise<boolean>;
  /** Try again on the bot's failed latest turn (`session.resend`): the engine sends the same words once more, after the
   *  person's own press. */
  retry(bot: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Answers the bot's waiting question (`session.answer`), after the person's own press: the answers are keyed by the
   *  question's text, and a question that no longer waits is refused in plain words. */
  answer(bot: string, callId: string, answers: Record<string, string>, notes?: Record<string, string>): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Stops the bot's turn now (`session.interrupt`, background tasks keep running), after the person's own press; a question
   *  waiting in it is withdrawn. */
  stop(bot: string): Promise<{ ok: true } | { ok: false; why: string }>;
  /** Opens a link of a bot's reply in the person's browser: http, https or mailto, after the person's own click. */
  openLink(url: string): Promise<boolean>;
  /** The person tried to act on a bot's screen (a click, a key, a scroll): it is watch only, and main says so. */
  pictureInput(kind: "pointer" | "key" | "wheel"): void;
  models(): Promise<ModelRow[] | { waiting: true }>;
  /** The setup guide: the home's setup as the engine has it now, the model providers to add, a provider's terms opened in
   *  the person's browser by main, the default model picked, and the guide skipped (the engine's, for both apps). */
  setup(): Promise<SetupRow | { waiting: true }>;
  setupProviders(): Promise<ProviderRow[] | { waiting: true }>;
  openTerms(pluginId: string): Promise<boolean>;
  setDefaultModel(model: string): Promise<{ ok: true; setup: SetupRow } | { ok: false; why: string }>;
  skipSetup(): Promise<boolean>;
  /** The guide's relay page (spec §8.3): which relay this computer's links use, and the person's choice of another (their own
   *  press); the engine's why on a refusal. */
  relay(): Promise<RelayRow | { waiting: true }>;
  setRelay(choice: RelayRow): Promise<{ ok: true; relay: RelayRow } | { ok: false; why: string }>;
}

/** A mood in words, said beside every face (the kit's README: "a mood is shown by motion alone"). */
export const MOOD_WORDS: Readonly<Record<ActivityState, string>> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  working: "Working",
  asking: "Needs you",
  stuck: "Stuck",
  done: "Done",
  asleep: "Asleep",
};
