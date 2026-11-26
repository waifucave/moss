// The `computers` unit (lane XC, across computers): two engines, Alpha and Beta, each its own acceptance daemon on its own
// throwaway home, each with its own link sidecar (the built `moss-link`) on loopback with no relay and no lookup (the
// acceptance daemon's MOSS_ACCEPTANCE_LINK_BIN switch). They pair as a person does in the apps: Alpha's app begins
// (`device.pair.begin`), Beta's joins with its QR, the engine raises its own add card on each side with the four words,
// and each is answered as the app's sealed frame answers it; each daemon's terminal (the CLI role) only listens, and
// both must show the same words. Then a bot on Alpha works on Beta's files in real turns on the fake provider.
// Each row's check reads the disks and what the model was given; nothing here starts or reaches anything outside the run.

export const COMPUTERS_PAIR_STEP = "computers: two engines, each with its own link sidecar on loopback (no relay, no lookup), pair as a person does in the apps (the QR, the engine's add card on each side with the four words, each answered)";
export const COMPUTERS_READ_STEP = "computers: a bot on Alpha reads a file on Beta (home/Beta/…): the text only Beta's disk holds";
export const COMPUTERS_WRITE_STEP = "computers: a bot on Alpha writes a file on Beta: it lands on Beta's disk, nothing in the bot's own folder";
export const COMPUTERS_BASH_STEP = "computers: a bot on Alpha runs a command in a folder on Beta: its output names Beta's real folder and reads Beta's file";
export const COMPUTERS_REFUSED_STEP = "computers: Beta refuses what no bot reaches: its run folder's token, its secrets file and another bot's memory never reach the bot on Alpha";
export const COMPUTERS_CARD_STEP = "computers: at the default levels a write on Beta raises one card on Alpha naming Beta, answered yes as MOSS signs it, and lands on Beta's disk after the yes";
export const COMPUTERS_CARD_NO_STEP = "computers: the same card answered no: nothing written on Beta, and the bot told the person said no";
export const COMPUTERS_MOVE_STEP = "computers: mv of a small folder from Alpha to Beta: on Beta with its files, gone from Alpha";
export const COMPUTERS_OFFLINE_STEP = "computers: with Beta's engine stopped, a read on Beta says \"computer offline\" within the bound";

export const COMPUTERS_STEPS = [
  COMPUTERS_PAIR_STEP, COMPUTERS_READ_STEP, COMPUTERS_WRITE_STEP, COMPUTERS_BASH_STEP, COMPUTERS_REFUSED_STEP,
  COMPUTERS_CARD_STEP, COMPUTERS_CARD_NO_STEP, COMPUTERS_MOVE_STEP, COMPUTERS_OFFLINE_STEP,
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
