// An agent whose program is an adapter MOSS provides (spec §9.3 "An adapter MOSS provides"; the `acp` unit's row 4). The
// fixture (fixtures/acceptance-acp-adapter) is a plugin whose backend declares, in its quirks file's `launch.adapter`, an
// npm package: the run publishes it on its fake registry (registry.npmjs.org, served by name from the run's folder, the
// way the npm plugin rows are) as `acceptance-adapter-pkg` 1.0.0, whose run file records how MOSS started it and then is
// the run's fake ACP agent (the one rows 1 to 3 use). No `claude` or `codex`, no network.
//
//   a. A session started on it raises ONE sealed card (kind change) that names the package, its version, where it comes
//      from, that it is code MOSS will run, and its size; the registry's tarball is absent while it waits, and the NO that
//      answers it leaves the agent unavailable with a plain line that says so: "because you said no", not "couldn't be
//      downloaded", so nothing was asked of the registry (and nothing is in the home).
//   b. The tarball served is another one (the registry, or something on the way, changed it): the card again, a yes, and
//      the session says the download doesn't match the fingerprint; nothing is kept in the home (no package, no staging).
//   c. The real tarball: the card again, pressed in the window; MOSS fetches it, checks its fingerprint, keeps it in
//      `<home>/run/agent-adapters/<package>/<version>/`, starts it on its own runtime with the closed flags, and the
//      turn's reply is in the session; a second session starts with no card.
// Removed afterwards, whatever happened.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fail, leave, until, type ExampleCtx } from "./example-steps";
import { FAKE_NPM_HOST } from "./fake-exa";
import { tgz } from "../../packages/core/src/registry/indexes/tests/tar-fixture";
import { publishNpm, type Files } from "./plugin-world";
import { ACP_PROMPT, ACP_REPLY, FAKE_ACP_AGENT, agentConfig, fixtureWith, reportOf } from "./acp-backend-step";

export const ADAPTER_ID = "acceptance-adapter";
export const ADAPTER_PACKAGE = "acceptance-adapter-pkg";
export const ADAPTER_VERSION = "1.0.0";
const FIXTURE = resolve(import.meta.dir, "fixtures", "acceptance-acp-adapter");

type Card = { id: string; kind: string; session?: string };

/** The adapter package's files: its package.json (npm's tarballs hold one) and its run file, which records how MOSS started
 *  it and then runs the fake agent. Pure, so a test can check it. */
export function adapterFiles(o: { fake: string; ran: string }, version = ADAPTER_VERSION): Files {
  return {
    "package.json": JSON.stringify({ name: ADAPTER_PACKAGE, version }),
    "dist/index.js": [
      `import { appendFileSync } from "node:fs";`,
      `appendFileSync(${JSON.stringify(o.ran)}, JSON.stringify({ execArgv: process.execArgv, entry: process.argv[1], cwd: process.cwd(), configArg: process.argv[2] }) + "\\n");`,
      `await import(${JSON.stringify(o.fake)});`,
      "",
    ].join("\n"),
  };
}

/** The fixture's quirks file with the published package's integrity and size in its `launch.adapter`. Pure. */
export function withAdapter(quirksFile: string, o: { integrity: string; size: number }): string {
  const file = JSON.parse(quirksFile) as { quirks: { launch: { adapter: Record<string, unknown> } } };
  file.quirks.launch.adapter = { ...file.quirks.launch.adapter, integrity: o.integrity, size: o.size };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export const sriOf = (bytes: Uint8Array): string => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export async function adapterRow(ctx: ExampleCtx): Promise<string> {
  try {
    return await run(ctx);
  } finally {
    await leave(ctx, ADAPTER_ID);
  }
}

async function run(ctx: ExampleCtx): Promise<string> {
  const { rpc, root } = ctx;
  const work = join(root, "acp-adapter");
  const folder = join(work, "plugin-src", ADAPTER_ID);
  const config = join(work, "agent", "agent.json");
  const report = join(work, "agent", "report.ndjson");
  const ran = join(work, "agent", "ran.ndjson");
  const world = join(root, "plugin-world");
  const tarball = join(world, FAKE_NPM_HOST, ADAPTER_PACKAGE, "-", `${ADAPTER_PACKAGE}-${ADAPTER_VERSION}.tgz`);
  const kept = join(ctx.home, "run", "agent-adapters");
  mkdirSync(dirname(config), { recursive: true });

  // The package on the fake registry, and its real integrity written into the fixture's declaration.
  await publishNpm(world, ADAPTER_PACKAGE, ADAPTER_VERSION, adapterFiles({ fake: FAKE_ACP_AGENT, ran }));
  const genuine = readFileSync(tarball);
  const integrity = sriOf(genuine);
  cpSync(FIXTURE, folder, { recursive: true });
  const written = fixtureWith({ "moss.json": readFileSync(join(folder, "moss.json"), "utf8"), "quirks.json": readFileSync(join(folder, "quirks.json"), "utf8") }, { bun: process.execPath, fake: FAKE_ACP_AGENT, config });
  writeFileSync(join(folder, "moss.json"), written["moss.json"]!);
  const quirks = withAdapter(written["quirks.json"]!, { integrity, size: genuine.byteLength });
  writeFileSync(join(folder, "quirks.json"), quirks);
  writeFileSync(config, agentConfig(quirks, { report, selection: join(work, "agent", "selection.json"), mcpEnv: { MOSS_TEST_KEYCHAIN: ctx.keychainFile } }));

  // Installed behind its OK card, pressed in the window.
  const installed = await rpc.request<{ id: string }>("plugin.install", { source: { from: "folder", path: folder } }, 60_000);
  if (installed.id !== ADAPTER_ID) fail(`the fixture installed as ${installed.id}`);
  const ok = await until(`${ADAPTER_ID}'s OK card`, 60_000, async () => (await rpc.request<{ cards: (Card & { pluginId?: string })[] }>("card.list")).cards.find((c) => c.kind === "plugin-ok" && c.pluginId === ADAPTER_ID));
  await ctx.pressCard(`${ADAPTER_ID}'s OK card`, (c) => c.id === ok.id);
  await until(`${ADAPTER_ID} running after its OK`, 60_000, async () => {
    const s = (await rpc.request<{ plugin: { state: string } }>("plugin.get", { id: ADAPTER_ID }).catch(() => undefined))?.plugin.state;
    return s === "running" || s === "enabled" ? true : undefined;
  });
  const computer = (await rpc.request<{ computers: { name: string }[] }>("computer.list", {})).computers[0]?.name;
  if (computer === undefined) fail("computer.list lists no computer");
  mkdirSync(join(ctx.userHome, "acp-work"), { recursive: true });
  const listed = (await rpc.request<{ backends: { id: string; computers: { installed: boolean }[] }[] }>("agent.backends", {})).backends.find((b) => b.id === ADAPTER_ID);
  if (listed === undefined) fail("agent.backends doesn't list the adapter backend");
  if (existsSync(kept)) fail(`something is kept in ${kept} before any start`);

  const start = async () => (await rpc.request<{ session: string }>("agent.start", { backend: ADAPTER_ID, computer, root: `home/${computer}/acp-work`, prompt: ACP_PROMPT }, 60_000)).session;
  const adapterCard = (session: string) => until("the download card", 60_000, async () => {
    for (const c of (await rpc.request<{ cards: Card[] }>("card.list")).cards) {
      if (c.session !== session || c.kind !== "change") continue;
      const card = (await rpc.request<{ card: { fields?: Record<string, unknown> } }>("card.get", { id: c.id })).card;
      if (JSON.stringify(card.fields ?? {}).includes("adapter?")) return { id: c.id, text: JSON.stringify(card.fields) };
    }
    return undefined;
  });
  // Waits for `needle` in the session, approving its other cards (a third party's agent is unsandboxed: its own OK); a
  // download card that comes where none may fails the row at once, unanswered.
  const said = async (session: string, needle: string, what: string, adapterMayAsk = false) => {
    const answered = new Set<string>();
    return until(what, 60_000, async () => {
      for (const c of (await rpc.request<{ cards: Card[] }>("card.list")).cards) {
        if (c.session !== session || answered.has(c.id)) continue;
        answered.add(c.id);
        if (!adapterMayAsk && JSON.stringify((await rpc.request<{ card: unknown }>("card.get", { id: c.id })).card).includes("adapter?")) fail(`a download card was raised again (${what})`);
        await ctx.approveCard(c.id);
      }
      const evs = await ctx.history(session).catch(() => []);
      return evs.find((e) => JSON.stringify(e).includes(needle));
    }, async () => `the session's events: ${(await ctx.history(session).catch(() => [])).slice(-5).map((e) => JSON.stringify(e).slice(0, 200)).join(" | ")}`);
  };

  // a. The card names it; the NO leaves it unavailable with the plain line, and nothing was asked of the registry.
  rmSync(tarball, { force: true });
  const a = await start();
  const card = await adapterCard(a);
  for (const part of [ADAPTER_PACKAGE, ADAPTER_VERSION, "npm", "code from npm that MOSS will run", "under 1 MB", "Nothing is downloaded unless you say yes"]) {
    if (!card.text.includes(part)) fail(`the download card doesn't say "${part}": ${card.text.slice(0, 500)}`);
  }
  if (reportOf(report).length > 0 || existsSync(kept)) fail("the agent started or something was kept before the person said yes");
  await ctx.denyCard(card.id);
  await said(a, "because you said no", "the plain line after the NO");
  if (existsSync(join(kept, ADAPTER_PACKAGE))) fail(`the NO left ${join(kept, ADAPTER_PACKAGE)}`);
  if (reportOf(report).length > 0) fail("the agent started after the NO");

  // b. Another tarball than the one the plugin pinned: refused after the yes, nothing kept.
  writeFileSync(tarball, otherTarball({ fake: FAKE_ACP_AGENT, ran: join(work, "evil.ran") }));
  const b = await start();
  await ctx.approveCard((await adapterCard(b)).id);
  await said(b, "doesn't match the fingerprint", "the refusal of a tampered download");
  const left = existsSync(join(kept, ADAPTER_PACKAGE)) ? readdirSync(join(kept, ADAPTER_PACKAGE), { recursive: true }).map(String) : [];
  if (left.length > 0) fail(`a refused download left ${left.join(", ")}`);
  if (reportOf(report).length > 0 || existsSync(join(work, "evil.ran"))) fail("a tampered adapter was started");

  // c. The real tarball: card, the press in the window, fetched, verified, started, a turn; the next start has no card.
  writeFileSync(tarball, genuine);
  const c = await start();
  const pressed = await adapterCard(c);
  await ctx.pressCard("the adapter's download card", (x) => x.id === pressed.id);
  await said(c, ACP_REPLY, "the adapter's reply in the session", true);
  const dir = join(kept, ADAPTER_PACKAGE, ADAPTER_VERSION);
  const entry = join(dir, "node_modules", ADAPTER_PACKAGE, "dist", "index.js");
  if (!existsSync(entry)) fail(`the adapter isn't kept where MOSS keeps it (${entry})`);
  const records = readFileSync(ran, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { execArgv: string[]; entry: string });
  const r = records.at(-1);
  if (r === undefined || realpathSync(r.entry) !== realpathSync(entry)) fail(`the adapter ran from ${r?.entry ?? "nowhere"}, not MOSS's copy ${entry}`);
  for (const flag of ["--no-install", "--no-env-file"]) if (!r!.execArgv.includes(flag)) fail(`MOSS started the adapter without ${flag} (${r!.execArgv.join(" ")})`);
  if (!r!.execArgv.some((f) => f.startsWith("--config="))) fail(`MOSS started the adapter without its own config (${r!.execArgv.join(" ")})`);
  const listing = readdirSync(join(kept, ADAPTER_PACKAGE)).sort().join(",");
  if (listing !== ADAPTER_VERSION) fail(`the package's folder holds ${listing}, not just ${ADAPTER_VERSION} (a staging folder was left)`);
  // Placed once, never asked again: another session starts with no card.
  const d = await start();
  await said(d, ACP_REPLY, "the second session's reply");
  return `4 adapter MOSS provides: a start raised one sealed card (${ADAPTER_PACKAGE} ${ADAPTER_VERSION}, from npm, code MOSS will run, under 1 MB) with the tarball absent, and the NO left the agent unavailable ("because you said no", nothing started, nothing kept); a tampered tarball after a yes was refused at its fingerprint and nothing was kept; the real one after a press in the window was fetched, kept in run/agent-adapters/${ADAPTER_PACKAGE}/${ADAPTER_VERSION}, started on MOSS's own runtime with --no-install --no-env-file --config, and its turn's reply is in the session; a second session started with no card`;
}

/** A tarball that isn't the one the plugin pinned: the same package with a line more. */
const otherTarball = (o: { fake: string; ran: string }): Uint8Array =>
  tgz(Object.entries(adapterFiles(o)).map(([path, data]) => ({ path: `package/${path}`, data: path === "dist/index.js" ? `${data}// not the pinned package\n` : data })));
