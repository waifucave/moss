// Deleting a bot (the deletion lane, item 4), through the bot side as a client calls it: the person only; a listed or an
// archived bot goes for good with everything kept by its id (record, instructions, conversation, memory, scratch,
// agents' transcripts, routines, the user's layer, its sessions' driver state); archive keeps working beside it; a stop
// in the middle is finished at the next start; and a bot made later with its name starts with nothing of the old one.
import { isDeletedBot } from "../tombstones";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { MOSS_ERR, type Caller } from "@waifucave/moss-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { boot, removeTemps, tempDir } from "../../bots/tests/fixtures";
import { botPaths, userLayerFile } from "../../bots/paths";
import { journalSessionDeletion } from "../session-files";

afterEach(removeTemps);

const TERMINAL: Caller = { kind: "user", client: "cli" } as Caller;

async function world(home = tempDir()) {
  const b = await boot({ home, clock: new FakeClock(), plugins: [], botSource: "records", modelOffer: () => "offered" });
  const all = b.side.methods({ localDevice: "studio0000000000000" });
  const call = (name: string, params: unknown, caller: Caller = TERMINAL) => all[name]!(params, { caller } as never) as Promise<Record<string, unknown>>;
  return { home, b, call };
}

function named(root: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.name.includes(needle)) out.push(relative(root, p));
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
    }
  };
  walk(root);
  return out;
}

async function madeNova(w: Awaited<ReturnType<typeof world>>) {
  await w.call("bot.create", { name: "Nova", instructions: "You are Nova." });
  const paths = botPaths(w.home, "nova");
  writeFileSync(join(paths.memory, "pets.md"), "Has a cat");
  mkdirSync(paths.scratch, { recursive: true });
  writeFileSync(join(paths.scratch, "draft.txt"), "draft");
  writeFileSync(userLayerFile(w.home, "nova"), "{}");
  mkdirSync(join(w.home, "sessions-runtime"), { recursive: true });
  writeFileSync(join(w.home, "sessions-runtime", "b_nova.json"), "{}");
  mkdirSync(join(w.home, "routines", "nova"), { recursive: true });
  writeFileSync(join(w.home, "routines", "nova", "daily.md"), "every day");
}

describe("deleting a bot", () => {
  test("a listed bot goes for good with everything kept by its id; other bots stay", async () => {
    const w = await world();
    await madeNova(w);
    await w.call("bot.create", { name: "Orbit" });
    expect(await w.call("bot.delete", { id: "nova", confirm: true })).toEqual({ applied: true });
    expect(named(w.home, "nova")).toEqual([]);
    expect(w.b.bots.has("nova")).toBe(false);
    expect(w.b.bots.archivedBots().some((a) => a.id === "nova")).toBe(false);
    expect(w.b.bots.has("orbit")).toBe(true);
    // Sync never brings it back here (its memory and sessions are refused from any computer).
    expect(isDeletedBot(w.home, "nova")).toBe(true);
    expect(isDeletedBot(w.home, "orbit")).toBe(false);
    await w.b.shutdown();
  });

  test("an archived bot can be deleted, and archive and restore still work for the others", async () => {
    const w = await world();
    await madeNova(w);
    await w.call("bot.create", { name: "Orbit" });
    await w.call("bot.remove", { id: "nova" });
    await w.call("bot.remove", { id: "orbit" });
    expect(await w.call("bot.delete", { id: "nova", confirm: true })).toEqual({ applied: true });
    expect(named(w.home, "nova")).toEqual([]);
    await w.call("bot.restore", { id: "orbit" });
    expect(w.b.bots.has("orbit")).toBe(true);
    await w.b.shutdown();
  });

  test("a damaged record of what was deleted: making a bot is refused with the doctor's words, never a spin", async () => {
    const w = await world();
    writeFileSync(join(w.home, "deleted.json"), "{ not json");
    await expect(w.call("bot.create", { name: "Nova" })).rejects.toThrow("can't be read");
    await w.b.shutdown();
  });

  test("a bot made later with the same name starts with nothing of the old one", async () => {
    const w = await world();
    await madeNova(w);
    await w.call("bot.delete", { id: "nova", confirm: true });
    const made = (await w.call("bot.create", { name: "Nova" })) as { bot?: { id?: string }; id?: string };
    // Never the deleted bot's id: what the person's other computers still hold of it can't reach the new one.
    expect(w.b.bots.has("nova")).toBe(false);
    expect(JSON.stringify(made)).not.toContain('"nova"');
    expect(existsSync(join(botPaths(w.home, "nova").memory, "pets.md"))).toBe(false);
    expect(existsSync(join(botPaths(w.home, "nova").scratch, "draft.txt"))).toBe(false);
    await w.b.shutdown();
  });

  test("half done: a deletion its mark says was under way is finished at the next start", async () => {
    const w = await world();
    await madeNova(w);
    await w.call("bot.remove", { id: "nova" });
    await w.b.shutdown();
    // As if stopped right after the mark was written.
    const mark = join(w.home, "archive", "bots", "nova", "archived.json");
    const m = JSON.parse(await Bun.file(mark).text()) as Record<string, unknown>;
    writeFileSync(mark, JSON.stringify({ ...m, state: "deleting" }));
    journalSessionDeletion(w.home, [{ id: "b_nova", bot: "nova", kind: "bot" }]);
    const again = await world(w.home);
    expect(named(w.home, "nova")).toEqual([]);
    expect(again.b.bots.archivedBots().some((a) => a.id === "nova")).toBe(false);
    await again.b.shutdown();
  });
});

describe("bot.delete: who may ask", () => {
  const callers: [string, Caller][] = [
    ["a bot's own session", { kind: "session", sessionId: "b_orbit", sessionKind: "bot", bot: "orbit" } as Caller],
    ["a plugin", { kind: "plugin", pluginId: "acme/thing" } as Caller],
    ["a peer computer", { kind: "peer", device: "x" } as unknown as Caller],
  ];
  for (const [who, caller] of callers) {
    test(`${who} is refused, and nothing is deleted`, async () => {
      const w = await world();
      await madeNova(w);
      const err = await w.call("bot.delete", { id: "nova", confirm: true }, caller).catch((e: unknown) => e);
      expect((err as { code?: number }).code).toBe(MOSS_ERR.NOT_THE_USER);
      expect(w.b.bots.has("nova")).toBe(true);
      expect(existsSync(join(botPaths(w.home, "nova").memory, "pets.md"))).toBe(true);
      await w.b.shutdown();
    });
  }

  test("the person's terminal without its confirmation: nothing happens", async () => {
    const w = await world();
    await madeNova(w);
    await expect(w.call("bot.delete", { id: "nova" })).rejects.toBeDefined();
    expect(w.b.bots.has("nova")).toBe(true);
    await w.b.shutdown();
  });
});
