// The `computers` unit (lane XC, across computers): two engines, Alpha and Beta, each its own acceptance daemon on its own
// throwaway home, each with its own link sidecar (the built `moss-link`) on loopback with no relay and no lookup (the
// acceptance daemon's MOSS_ACCEPTANCE_LINK_BIN switch). They pair through the product's own path: Alpha's
// `device.pair.begin`, Beta's `device.pair.join` with its QR, the four words read from each daemon's own terminal (the CLI
// role) and `device.pair.confirm` there. Then a bot on Alpha works on Beta's files in real turns on the fake provider.
// Each row's check reads the disks and what the model was given; nothing here starts or reaches anything outside the run.

export const COMPUTERS_PAIR_STEP = "computers: two engines, each with its own link sidecar on loopback (no relay, no lookup), pair through the product's own path (the QR, the four words in each user's terminal, the confirm there)";
export const COMPUTERS_READ_STEP = "computers: a bot on Alpha reads a file on Beta (home/Beta/…): the text only Beta's disk holds";
export const COMPUTERS_WRITE_STEP = "computers: a bot on Alpha writes a file on Beta: it lands on Beta's disk, nothing in the bot's own folder";
export const COMPUTERS_BASH_STEP = "computers: a bot on Alpha runs a command in a folder on Beta: its output names Beta's real folder and reads Beta's file";
export const COMPUTERS_REFUSED_STEP = "computers: Beta refuses what no bot reaches: its run folder's token, its secrets file and another bot's memory never reach the bot on Alpha";
export const COMPUTERS_CARD_STEP = "computers: at Beta's default level a write on Beta raises Beta's own card, answered on Alpha, and lands after the yes";
export const COMPUTERS_MOVE_STEP = "computers: mv of a small folder from Alpha to Beta: on Beta with its files, gone from Alpha";
export const COMPUTERS_OFFLINE_STEP = "computers: with Beta's engine stopped, a read on Beta says \"computer offline\" within the bound";

export const COMPUTERS_STEPS = [
  COMPUTERS_PAIR_STEP, COMPUTERS_READ_STEP, COMPUTERS_WRITE_STEP, COMPUTERS_BASH_STEP, COMPUTERS_REFUSED_STEP,
  COMPUTERS_CARD_STEP, COMPUTERS_MOVE_STEP, COMPUTERS_OFFLINE_STEP,
] as const;

/** The dummy texts the run plants on Beta (never a secret: each says so). */
export const BETA_NOTE = "ACCEPTANCE-BETA-NOTE kept only on Beta's disk";
export const BETA_TOKEN_DUMMY = "ACCEPTANCE-DUMMY-TOKEN-not-a-secret";
export const BETA_SECRETS_DUMMY = "ACCEPTANCE-DUMMY-SECRETS-not-a-secret";
export const BETA_MEMORY_DUMMY = "ACCEPTANCE-DUMMY-OTHER-BOT-MEMORY";

/** How long a read on a stopped computer may take to say so. */
export const OFFLINE_BOUND_MS = 20_000;

/** One tool result as the model was given it. */
export interface Seen { text: string; isError: boolean }

/** What's wrong with a refused read's result, or undefined: an error (or a refusal), and the dummy never in it. */
export function refusedWrong(what: string, seen: Seen | undefined, dummy: string): string | undefined {
  if (seen === undefined) return `${what}: the bot was given no result`;
  if (seen.text.includes(dummy)) return `${what}: the dummy text reached the bot`;
  if (!seen.isError && !/refus|fenced|not allowed|can't|cannot|denied/i.test(seen.text)) return `${what}: not refused (${seen.text.slice(0, 160)})`;
  return undefined;
}

/** What's wrong with a "computer offline" result, or undefined. */
export function offlineWrong(seen: Seen | undefined, tookMs: number): string | undefined {
  if (seen === undefined) return "the bot was given no result";
  if (!seen.text.includes("computer offline")) return `not "computer offline" (${seen.text.slice(0, 160)})`;
  if (tookMs > OFFLINE_BOUND_MS) return `it took ${tookMs} ms, past ${OFFLINE_BOUND_MS} ms`;
  return undefined;
}
