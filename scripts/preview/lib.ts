// The live preview's pure part (scripts/preview/run.ts is the command): its options, the refusal to run where it must not, the
// environments it hands the engine and the app, the folder layout of its throwaway world, the shims that stand in for three
// agents' programs, and the record that lets `--stop` end a running preview by the pids it started and nothing else.
//
// Everything that decides what a preview may touch is here, so a test can hold it to the isolation list: a temp home and a temp user
// home, the throwaway test keychain, a PATH of its own (never the person's), nothing of the installed apps.
import { basename, dirname, join, resolve, sep } from "node:path";

export const PREVIEW_PREFIX = "mprev-";
/** Where the preview names itself in the window (its title, and one plain line at the window's bottom right, on top of the page and deaf to the mouse). */
export const PREVIEW_BANNER = "PREVIEW from source · not installed · throwaway home";

export type Appearance = "light" | "dark" | "system";

export interface Options {
  mode: "start" | "stop";
  /** Start with no watching: the window shows what the first build made. */
  once: boolean;
  /** Offscreen, one picture, then end (`--shot`). */
  headless: boolean;
  shot?: string;
  /** Open the control door (scripts/preview/ctl.ts drives it): a private socket in the run's own folder, a token in the run's record. Without it the preview opens none. */
  control: boolean;
  /** Start the owner's REAL Claude Code, Codex, OpenCode and Antigravity (real-lib.ts): their real home and a minimal PATH only for those agents, under a hard budget. */
  realAgents: boolean;
  appearance: Appearance;
  /** Where to copy the run's logs (the engine's, the app's, the builds', the fake agents' reports) before its folder is removed. */
  logs?: string;
  /** A start that only builds and seeds, then ends (a test's way to see the world made); never visible. */
  help: boolean;
}

export class UsageError extends Error {}

/** The command line: `--once`, `--stop`, `--headless --shot <png>`, `--appearance light|dark|system`. Anything else is refused. */
export function parseOptions(argv: readonly string[]): Options {
  const o: Options = { mode: "start", once: false, headless: false, control: false, realAgents: false, appearance: "system", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--once") o.once = true;
    else if (a === "--stop") o.mode = "stop";
    else if (a === "--headless") o.headless = true;
    else if (a === "--shot") o.shot = value();
    else if (a === "--logs") o.logs = value();
    else if (a === "--control") o.control = true;
    else if (a === "--real-agents") o.realAgents = true;
    else if (a === "--appearance") {
      const v = value();
      if (v !== "light" && v !== "dark" && v !== "system") throw new UsageError(`--appearance is light, dark or system, not ${v}`);
      o.appearance = v;
    } else if (a === "--help" || a === "-h") o.help = true;
    else throw new UsageError(`unknown argument ${a}`);
  }
  if (o.mode === "stop" && (o.once || o.headless || o.shot !== undefined || o.control || o.realAgents)) throw new UsageError("--stop stands alone");
  if (o.headless && o.shot === undefined && !o.control) throw new UsageError("--headless needs --shot <png> (one picture, then it ends) or --control (it runs until ctl ends it)");
  if (o.realAgents && !o.control) throw new UsageError("--real-agents needs --control: real sessions are started and watched through ctl.ts, which keeps the budget visible");
  if (o.shot !== undefined && o.control) throw new UsageError("--shot and --control do not go together: a controlled preview takes its pictures with ctl.ts shot <png>");
  if (o.shot !== undefined && !o.headless) throw new UsageError("--shot is for --headless: the visible preview is looked at, not photographed");
  if (o.shot !== undefined && !o.shot.endsWith(".png")) throw new UsageError("--shot names a .png file");
  return o;
}

export const USAGE = [
  "scripts/pinned-bun scripts/preview/run.ts            start the preview: one window of MOSS Code from source on a throwaway home, reloaded when its look's source changes",
  "scripts/pinned-bun scripts/preview/run.ts --once     the same, with no watching",
  "scripts/pinned-bun scripts/preview/run.ts --stop     end a running preview (by the pid it recorded)",
  "scripts/pinned-bun scripts/preview/run.ts --headless --shot <png> [--appearance light|dark]   offscreen: one picture of the window, then end",
  "                              --logs <dir> (with any start) copies the run's logs there before its folder is removed",
  "scripts/pinned-bun scripts/preview/run.ts --control [--headless]   start with the control door open: scripts/preview/ctl.ts then drives the window and the engine (ctl.ts --help)",
  "scripts/pinned-bun scripts/preview/run.ts --control --real-agents [--headless]   the same with the owner's REAL Claude Code, Codex, OpenCode and Antigravity (their own logins; at most 2 sessions per agent, 3 turns per session, one-line prompts)",
].join("\n");

/** Why a preview must not start here, or undefined. The first thing the command checks, before any folder or process. */
export function refusal(env: Readonly<Record<string, string | undefined>>, platform: string = process.platform): string | undefined {
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI !== "false") return "this is a CI run (CI is set): the preview is for a person's screen";
  if (env.GITHUB_ACTIONS !== undefined && env.GITHUB_ACTIONS !== "") return "this is a GitHub Actions run: the preview is for a person's screen";
  if (env.NODE_ENV === "test" || env.BUN_TEST !== undefined) return "this is a test run: no test starts the preview";
  if (env.MOSS_TEST_KEYCHAIN !== undefined || env.MOSS_ACCEPTANCE_RUN_PID !== undefined || env.MOSS_KEYCHAIN_SERVICE !== undefined) return "this is inside a test or an acceptance run (its throwaway keychain is set): no run starts the preview";
  if (platform !== "darwin") return "the preview is for macOS (its isolation is the throwaway keychain and a macOS app from source)";
  return undefined;
}

/** The folders of one preview's throwaway world, all under one root made for it. */
export interface Layout {
  root: string;
  userHome: string;
  home: string;
  logs: string;
  tmp: string;
  keychain: string;
  answerKey: string;
  bin: string;
  stubBin: string;
  agents: string;
  work: string;
  pluginWorld: string;
  reloadFile: string;
  userData: string;
  /** The control door's folder (mode 0700) and its two sockets: the app's own (only the preview command dials it) and the command's (ctl.ts dials it). */
  ctlDir: string;
  appDoor: string;
  ctlSock: string;
}

export function layoutFor(root: string): Layout {
  const userHome = join(root, "user");
  return {
    root, userHome, home: join(userHome, ".moss"), logs: join(root, "logs"), tmp: join(root, "tmp"),
    keychain: join(root, "kc", "preview.keychain-db"), answerKey: join(root, "kc", "answer-key"),
    bin: join(root, "bin"), stubBin: join(root, "bin", "engine-stub"), agents: join(root, "agents"), work: join(userHome, "work"),
    pluginWorld: join(root, "plugin-world"), reloadFile: join(root, "reload"), userData: join(root, "user-data"),
    ctlDir: join(root, "ctl"), appDoor: join(root, "ctl", "a.sock"), ctlSock: join(root, "ctl", "c.sock"),
  };
}

/** The path a command is found on in the preview: its own shims first, then the system's and the pinned Bun's folders; never the person's PATH (a real `codex` or `gemini` of theirs must never run). */
export function previewPath(shimDir: string, bunDir: string): string {
  return [shimDir, bunDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
}

interface EnvInput {
  layout: Layout;
  service: string;
  bunDir: string;
}

/** What the engine and the app share (the acceptance run's `baseEnv`, as a whitelist: nothing of the person's environment comes along). */
export function baseEnv(i: EnvInput): Record<string, string> {
  const l = i.layout;
  return {
    PATH: previewPath(l.bin, i.bunDir),
    HOME: l.userHome,
    TMPDIR: l.tmp,
    LANG: "en_US.UTF-8",
    MOSS_HOME: l.home,
    MOSS_PROFILE: "dev",
    // The engine merges the login shell's PATH IN FRONT of its own (login-shell-path.ts mergePathLists): left on, /opt/homebrew/bin's real agents would win over the shims.
    MOSS_LOGIN_SHELL_PATH: "off",
    MOSS_KEYCHAIN_SERVICE: i.service,
    MOSS_TEST_KEYCHAIN: l.keychain,
    MOSS_ACCEPTANCE_PLUGIN_WORLD: l.pluginWorld,
  };
}

/** The engine's environment: the shared one, the run pid the source daemon's caller check takes (the app is this command's child), and the user home the bots' folders are. */
export function daemonEnv(i: EnvInput & { runPid: number; usageInert: Readonly<Record<string, string>> }): Record<string, string> {
  return { ...baseEnv(i), ...i.usageInert, MOSS_ACCEPTANCE_RUN_PID: String(i.runPid), MOSS_ACCEPTANCE_USER_HOME: i.layout.userHome };
}

/** The app's environment. Visible: nothing that opens a debugging door. Headless (`--shot`): the dev opt-in the source app takes for its DevTools port on loopback, so the command can take the picture. */
export function appEnv(i: EnvInput & { headless: boolean; appearance: Appearance; control?: { token: string } }): Record<string, string> {
  const l = i.layout;
  return {
    ...baseEnv(i),
    MOSS_DAEMON_BIN: l.stubBin,
    MOSS_PREVIEW_BANNER: PREVIEW_BANNER,
    MOSS_PREVIEW_RELOAD_FILE: l.reloadFile,
    ...(i.appearance === "system" ? {} : { MOSS_PREVIEW_APPEARANCE: i.appearance }),
    // The DevTools port (loopback, no token) only for the one-picture run; a controlled preview uses its own door and opens no port.
    ...(i.headless && i.control === undefined ? { MOSS_DEV_DEBUG: "1" } : {}),
    // A controlled headless preview shows its window at opacity 0, deaf to the mouse (the app's own measuring mode, unpackaged builds only): the sealed card buttons read themselves visible only in a composited window, and nothing is drawn on the screen.
    ...(i.headless && i.control !== undefined ? { MOSS_TEST_INVISIBLE: "1" } : {}),
    ...(i.control !== undefined ? { MOSS_PREVIEW_CONTROL_SOCKET: l.appDoor, MOSS_PREVIEW_CONTROL_TOKEN: i.control.token } : {}),
  };
}

/** The app's command line after Electron's folder argument. Never a debugging switch in a visible preview; headless is the one place the DevTools port comes, on loopback, for the picture. */
export function appArgs(o: { desktopDir: string; headless: boolean; port?: number; control?: boolean }): string[] {
  return [
    o.desktopDir, "--mute-audio", "--use-mock-keychain",
    ...(o.headless ? ["--moss-headless", ...(o.control === true ? [] : [`--remote-debugging-port=${o.port ?? 0}`])] : []),
  ];
}

/** Everything that reads or writes outside the preview's root, found in an environment: each entry of the list a person asked to keep apart. Empty is the isolation holding. */
/** `allowed`: names of the forbidden set that this env may carry (only the controlled headless APP's MOSS_TEST_INVISIBLE; never the engine's). */
export function isolationProblems(env: Readonly<Record<string, string>>, layout: Layout, realHome: string, allowed: readonly string[] = []): string[] {
  const out: string[] = [];
  const inside = (p: string | undefined): boolean => p !== undefined && (resolve(p) === layout.root || resolve(p).startsWith(`${layout.root}${sep}`));
  for (const k of ["HOME", "TMPDIR", "MOSS_HOME", "MOSS_TEST_KEYCHAIN", "MOSS_DAEMON_BIN", "MOSS_ACCEPTANCE_PLUGIN_WORLD", "MOSS_ACCEPTANCE_USER_HOME", "MOSS_PREVIEW_RELOAD_FILE", "MOSS_PREVIEW_CONTROL_SOCKET"]) {
    if (env[k] !== undefined && !inside(env[k])) out.push(`${k} is ${env[k]}, outside the preview's folder`);
  }
  if (env.MOSS_HOME === undefined || env.HOME === undefined || env.MOSS_TEST_KEYCHAIN === undefined || env.MOSS_KEYCHAIN_SERVICE === undefined) out.push("the home, the user home, the throwaway keychain and its service are not all named");
  if (env.MOSS_KEYCHAIN_SERVICE !== undefined && !/\.test\.preview-[0-9a-f]+$/.test(env.MOSS_KEYCHAIN_SERVICE)) out.push(`the keychain service ${env.MOSS_KEYCHAIN_SERVICE} is not a throwaway one`);
  if (realHome !== "" && env.MOSS_HOME !== undefined && (resolve(env.MOSS_HOME) === join(realHome, ".moss"))) out.push("MOSS_HOME is the person's own home");
  if (env.PATH !== undefined) for (const d of env.PATH.split(":")) if (d.startsWith(realHome) && realHome !== "" && !inside(d) && !d.includes("moss-bun")) out.push(`PATH names ${d}, a folder of the person's`);
  for (const k of Object.keys(env)) {
    if (/^(MOSS_APP_HEADLESS|MOSS_HOST_COMMAND|MOSS_OLD_HOME|MOSS_TEST_INVISIBLE|MOSS_USER_DATA)$/.test(k) && !allowed.includes(k)) out.push(`${k} must not be set`);
  }
  return out;
}

/** The three programs the bundled agent plugins name, which the preview stands a fake ACP agent in for (so `agent.backends` serves their real marks and colours): the program, and the arguments the real one takes before `acp`. */
export const AGENT_SHIMS: readonly { command: string; backend: string }[] = [
  { command: "claude-agent-acp", backend: "claude-code" },
  { command: "codex-acp", backend: "codex" },
  { command: "gemini", backend: "gemini" },
];

/** A shim's text: it answers `--version`, and otherwise is the fake ACP agent on this backend's own config file. */
export function shimScript(o: { bun: string; fake: string; config: string }): string {
  const q = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh\ncase "$*" in\n  *--version*) exec ${q(o.bun)} ${q(o.fake)} ${q(o.config)} --version ;;\n  *) exec ${q(o.bun)} ${q(o.fake)} ${q(o.config)} acp ;;\nesac\n`;
}

// ── the record `--stop` reads ─────────────────────────────────────────────────────────────────────────────────────────

/** One process the preview started, with its start time so a pid a later process reused is never taken for it. */
export interface Started { pid: number; start: string; what: string }
/** `control`: where ctl.ts finds the running preview's door and the token for it; the record is a 0600 file in a 0700 folder, so only this user reads it. */
export interface Record_ { v: 1; pid: number; start: string; root: string; at: number; children: Started[]; control?: { socket: string; token: string } }

export function parseRecord(text: string): Record_ | undefined {
  try {
    const r = JSON.parse(text) as Partial<Record_>;
    if (r.v !== 1 || !Number.isInteger(r.pid) || typeof r.start !== "string" || typeof r.root !== "string" || !Array.isArray(r.children)) return undefined;
    const children = r.children.filter((c): c is Started => c !== null && typeof c === "object" && Number.isInteger((c as Started).pid) && typeof (c as Started).start === "string" && typeof (c as Started).what === "string");
    const c = r.control;
    const control = c !== undefined && c !== null && typeof c.socket === "string" && typeof c.token === "string" && c.socket !== "" && c.token.length >= 32 ? { socket: c.socket, token: c.token } : undefined;
    return { v: 1, pid: r.pid!, start: r.start, root: r.root, at: typeof r.at === "number" ? r.at : 0, children, ...(control !== undefined ? { control } : {}) };
  } catch {
    return undefined;
  }
}

/** A folder this command may delete: one of its own temp folders, directly under the temp folder, by its prefix; never anything else a record names. */
export function ownRoot(root: string, tmp: string): boolean {
  const r = resolve(root);
  return dirname(r) === resolve(tmp) && basename(r).startsWith(PREVIEW_PREFIX) && basename(r).length > PREVIEW_PREFIX.length;
}

/** A pid is still the process the record named when its start time is the recorded one. */
export function sameProcess(recorded: string, now: string | undefined): boolean {
  return now !== undefined && now !== "" && now === recorded;
}

/** The files a preview's source change watches: the plugins' client folders, the base theme and the plugin SDK's UI (relative to the checkout). */
export const WATCHED = ["plugins/moss/plugins", "packages/plugin-sdk/src/ui", "apps/desktop/src/core", "apps/desktop/src/layer"] as const;

/** Whether a changed file (relative to the checkout) is one the look's build reads: a plugin's `client` folder, the base theme's, the SDK's UI, the shell's own. */
export function reloads(rel: string): boolean {
  const p = rel.split(sep).join("/");
  if (p.includes("/node_modules/") || p.endsWith("~") || p.endsWith(".swp") || p.includes("/.git/")) return false;
  if (/^plugins\/moss\/plugins\/[^/]+\/client(\/|$)/.test(p)) return true;
  if (/^plugins\/moss\/plugins\/base-theme\//.test(p)) return true;
  if (/^plugins\/moss\/plugins\/[^/]+\/moss\.json$/.test(p)) return true;
  if (p.startsWith("packages/plugin-sdk/src/ui/")) return true;
  if (/^apps\/desktop\/src\/(core|layer)\//.test(p)) return true;
  return false;
}
