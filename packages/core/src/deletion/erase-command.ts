// `moss-core erase` (the deletion lane, item 5): the person, in their own terminal, with MOSS quit, erases everything
// MOSS keeps on this computer. It refuses while an engine answers (a bot or an agent only ever runs inside one, so none
// can be running this), refuses without a terminal to type in, and asks the person to type ERASE before anything goes.
// It takes the login item away first, so nothing starts the engine again into an empty home.
import { join } from "node:path";
import { endpointAnswers, resolveEndpoint } from "../platform/transport";
import { ERASE_KEEPS, eraseHome, recogniseMossHome, type EraseDeps } from "./erase-home";

export const ERASE_USAGE = "usage: moss-core erase   (asks you to type ERASE; quit MOSS and MOSS Code first)";
export const ERASE_WORD = "ERASE";

export interface EraseCommandEnv {
  home: string;
  userHome?: string;
  platform?: NodeJS.Platform;
  engineRunning?: () => Promise<boolean>;
  /** Whether stdin is the person's terminal. */
  interactive: boolean;
  readLine(): Promise<string | null>;
  out(line: string): void;
  err(line: string): void;
  openSecrets?: () => Promise<NonNullable<EraseDeps["secrets"]>>;
  dropFileKey?: () => Promise<void>;
  /** Takes MOSS's login item away (`moss-core autostart remove`). */
  removeLoginItem?: () => Promise<void>;
}

export async function runErase(env: EraseCommandEnv): Promise<number> {
  const platform = env.platform ?? process.platform;
  const running = await (env.engineRunning ?? (() => endpointAnswers(resolveEndpoint(join(env.home, "run"), platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux").path)))();
  if (running) {
    env.err("erase: MOSS is running; quit MOSS Code and MOSS first (or use Settings › Erase everything), then run this again");
    return 1;
  }
  const check = recogniseMossHome(env.home, env.userHome);
  if (!check.ok) {
    env.err(`erase refused: ${check.why}; nothing was removed`);
    return 1;
  }
  if (!env.interactive) {
    env.err(`erase: run this in your own terminal: it asks you to type ${ERASE_WORD}`);
    return 1;
  }
  env.out(`This deletes everything MOSS keeps in ${check.real}: your conversations, bots, memory, settings, plugins, logs and MOSS's saved keys and logins. It can't be undone.`);
  env.out("It doesn't remove:");
  for (const k of ERASE_KEEPS) env.out(`  - ${k}`);
  env.out(`Type ${ERASE_WORD} to erase, anything else to stop:`);
  const typed = (await env.readLine())?.trim();
  if (typed !== ERASE_WORD) {
    env.out("Nothing was erased.");
    return 1;
  }
  try {
    await env.removeLoginItem?.();
  } catch {
    env.err("erase: MOSS's login item couldn't be taken away; remove it in your system's login items");
  }
  let secrets: NonNullable<EraseDeps["secrets"]> | undefined;
  try {
    secrets = await env.openSecrets?.();
  } catch {
    env.err("erase: MOSS's saved keys couldn't be opened; delete them by hand (see the help page)");
  }
  try {
    const out = await eraseHome({ home: env.home, ...(env.userHome ? { userHome: env.userHome } : {}), ...(secrets ? { secrets } : {}), ...(env.dropFileKey ? { dropFileKey: env.dropFileKey } : {}), log: env.err });
    env.out(`Erased ${out.home} and ${out.secrets} saved key(s).${out.secretsLeft > 0 ? ` ${out.secretsLeft} couldn't be deleted: delete them by hand.` : ""}`);
    return 0;
  } catch (err) {
    env.err(err instanceof Error ? err.message : "erase failed");
    return 1;
  }
}
