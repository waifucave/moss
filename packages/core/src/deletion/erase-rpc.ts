// `home.erase` (the deletion lane, item 5) from an app's Settings: the person's yes on the engine's card, and then the
// engine itself erases, last, after it has stopped (`arm`: the daemon tells the apps to quit, stops, and runs
// `eraseHome` in its stop's tail, where nothing of its own still writes to the home). The home is checked before the card
// is raised, so a home erase would refuse never asks.
import { APP_METHODS } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import { handler, type CardOpener, type MethodHandler } from "../devices/rpc";
import { ERASE_KEEPS, recogniseMossHome } from "./erase-home";
import { byThePerson } from "./person";

export interface HomeEraseMethodsDeps {
  home: string;
  userHome?: string;
  openCard: CardOpener;
  /** Erase once stopped: the daemon's own (it quits the apps, stops, erases). */
  arm(): void;
}

export function homeEraseMethods(deps: HomeEraseMethodsDeps): Record<string, MethodHandler> {
  const M = APP_METHODS;
  return {
    [M.homeErase.name]: handler(M.homeErase, async (_p, ctx) => {
      const check = recogniseMossHome(deps.home, deps.userHome);
      if (!check.ok) throw new ContractError("refused", `erase refused: ${check.why}`);
      const res = await byThePerson(ctx, {
        what: "erase everything", confirm: undefined, openCard: deps.openCard,
        card: {
          change: "home-erase",
          title: "Erase everything MOSS keeps here?",
          what: "MOSS and MOSS Code quit, and everything MOSS keeps on this computer is deleted for good. It can't be undone.",
          rows: [
            { label: "Deleted", value: "your conversations, bots, memory, settings, plugins, routines and logs, MOSS's saved keys and logins, and starting MOSS at login" },
            { label: "Stays", value: ERASE_KEEPS.join("; ") },
          ],
        },
        run: async () => {
          deps.arm();
          return {};
        },
      });
      return res.applied ? { applied: true as const } : res;
    }),
  };
}
