// The person's deletions from their own terminal (the deletion lane): `moss account delete`, `moss session delete <id>`,
// `moss bot delete <id>`. Each says what goes and what stays, asks the person to type DELETE, and only then sends the
// engine's method with `confirm: true`. The engine checks the caller too: a terminal inside a bot's or an agent's session
// counts as that session there and is refused, whatever it types.

export type DeleteRequest = (method: string, params: unknown) => Promise<unknown>;

export interface DeleteCliEnv {
  request: DeleteRequest;
  interactive: boolean;
  readLine(): Promise<string | null>;
  out(line: string): void;
  err(line: string): void;
}

export const DELETE_WORD = "DELETE";

export const DELETE_USAGE = [
  "usage: moss account delete            delete your waifucave account (this computer's sign-in and the devices it added go too)",
  "       moss session delete <session>  delete a session or a bot's conversation on this computer",
  "       moss bot delete <bot>          delete a bot for good (moss bot archive keeps it instead)",
].join("\n");

interface Plan {
  method: string;
  params: Record<string, unknown>;
  what: string;
  goes: string;
  stays: string;
}

function planOf(argv: readonly string[]): Plan | string {
  const [area, verb, id] = argv;
  if (verb !== "delete") return DELETE_USAGE;
  if (area === "account") {
    return {
      method: "account.delete", params: {}, what: "your waifucave account",
      goes: "at waifucave: your sign-in, your devices' list, your phones' push addresses, your computers' webhook keys and waiting webhooks, your account's connection records; here: your sign-in and the devices only your account added",
      stays: "your conversations, bots, memory, settings and files, and devices you paired by code; your other computers sign out when they next reach waifucave",
    };
  }
  if ((area === "session" || area === "bot") && (id === undefined || id === "")) return DELETE_USAGE;
  if (area === "session") {
    return {
      method: "session.delete", params: { id }, what: `the session ${id}`,
      goes: "its messages, the files staged for it or sent to it, its outputs, the side threads and agents it started, its runtime state and logs",
      stays: "files it wrote in your folders; a bot's conversation starts again, empty",
    };
  }
  if (area === "bot") {
    return {
      method: "bot.delete", params: { id }, what: `the bot ${id}`,
      goes: "its instructions and settings, its conversation and side threads, its memory, scratch files, agents' transcripts, routines, your changes to it, and the rules you saved for it",
      stays: "files it wrote in your folders, and other bots",
    };
  }
  return DELETE_USAGE;
}

export async function runDelete(argv: readonly string[], env: DeleteCliEnv): Promise<number> {
  const plan = planOf(argv);
  if (typeof plan === "string") {
    env.err(plan);
    return 2;
  }
  if (!env.interactive) {
    env.err(`run this in your own terminal: it asks you to type ${DELETE_WORD}`);
    return 1;
  }
  env.out(`This deletes ${plan.what} for good. It can't be undone.`);
  env.out(`Deleted: ${plan.goes}.`);
  env.out(`Stays: ${plan.stays}.`);
  env.out(`Type ${DELETE_WORD} to delete, anything else to stop:`);
  if ((await env.readLine())?.trim() !== DELETE_WORD) {
    env.out("Nothing was deleted.");
    return 1;
  }
  try {
    const r = (await env.request(plan.method, { ...plan.params, confirm: true })) as { applied?: boolean; pending?: string[] };
    const pending = r.pending ?? [];
    env.out(pending.length > 0 ? `Deleted. waifucave still confirms: ${pending.join(", ")}; it finishes on its own.` : "Deleted.");
    return 0;
  } catch (err) {
    env.err(err instanceof Error ? err.message : "the deletion failed");
    return 1;
  }
}
