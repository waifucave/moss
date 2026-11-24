// Erase everything (the deletion lane, item 5): the path checks first (links, hard links, `..`, the user's home, `/`,
// another install's home, a project), then what goes and what stays. Every test works in its own temp folders; the
// secrets are a memory store's, never a Keychain.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeychainValues, memoryVault, MossSecretStore } from "../../secrets/moss-secret-store";
import { Secret } from "../../contracts/secret-store";
import { eraseHome, recogniseMossHome } from "../erase-home";
import { runErase } from "../erase-command";
import { homeEraseMethods } from "../erase-rpc";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};

/** A MOSS home as the engine lays it out, under a fake user home. */
function world() {
  const user = temp("moss-erase-user-");
  const home = join(user, ".moss");
  for (const d of ["run", "logs", "sessions", "transcripts/alpha", "bots/alpha/memory"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, "settings.json"), "{}");
  writeFileSync(join(home, "transcripts", "alpha", "b_alpha.ndjson"), "SENTINEL conversation");
  const outside = temp("moss-erase-outside-");
  writeFileSync(join(outside, "keep.txt"), "the person's file");
  return { user, home, outside };
}

describe("erase: which folder", () => {
  test("a MOSS home is recognised; the user's home, /, a project and a folder that isn't one are refused", () => {
    const w = world();
    expect(recogniseMossHome(w.home, w.user)).toMatchObject({ ok: true });
    expect(recogniseMossHome(w.user, w.user).ok).toBe(false);
    expect(recogniseMossHome("/", w.user).ok).toBe(false);
    expect(recogniseMossHome(w.outside, w.user).ok).toBe(false);
    mkdirSync(join(w.home, ".git"));
    expect(recogniseMossHome(w.home, w.user).ok).toBe(false);
  });

  test("a parent of the user's home is refused even if it holds MOSS's folders", () => {
    const w = world();
    const above = join(w.user, "..");
    expect(recogniseMossHome(above, w.user).ok).toBe(false);
  });

  test("`..` in the path is resolved before the checks", () => {
    const w = world();
    expect(recogniseMossHome(join(w.home, "logs", ".."), w.user)).toMatchObject({ ok: true });
    expect(recogniseMossHome(join(w.home, ".."), w.user).ok).toBe(false);
  });

  test("another install's home is refused", () => {
    const w = world();
    const clover = join(w.user, ".clover");
    for (const d of ["run", "logs", "sessions"]) mkdirSync(join(clover, d), { recursive: true });
    expect(recogniseMossHome(clover, w.user).ok).toBe(false);
  });

  test("a home given as a link to a folder that isn't a MOSS home is refused", () => {
    const w = world();
    const link = join(w.user, "fake-home");
    symlinkSync(w.outside, link);
    expect(recogniseMossHome(link, w.user).ok).toBe(false);
  });
});

describe("erase: what goes and what stays", () => {
  test("the home and MOSS's secrets go; links inside are removed as links; a hard link only loses this name", async () => {
    const w = world();
    // A link to a file and one to a folder outside the home, planted inside it.
    symlinkSync(join(w.outside, "keep.txt"), join(w.home, "logs", "planted-file"));
    symlinkSync(w.outside, join(w.home, "bots", "alpha", "planted-dir"));
    // A hard link inside the home to a file outside it.
    linkSync(join(w.outside, "keep.txt"), join(w.home, "hard"));
    const store = new MossSecretStore({ home: w.home, values: new KeychainValues(memoryVault()), status: { backend: "memory", plaintext: false, state: "unlocked" } });
    await store.set({ owner: { kind: "device" }, name: "account:session" }, new Secret("PROBE_SECRET=dummy123"), { synced: false });
    await store.set({ owner: { kind: "plugin", pluginId: "acme/thing" }, name: "api-key" }, new Secret("dummy456"), { synced: true });
    const out = await eraseHome({ home: w.home, userHome: w.user, secrets: store });
    expect(out.secrets).toBe(2);
    expect(existsSync(w.home)).toBe(false);
    expect(readFileSync(join(w.outside, "keep.txt"), "utf8")).toBe("the person's file");
    expect(out.keeps.length).toBeGreaterThan(0);
  });

  test("the folder of files phones sent to coding sessions, beside the home, goes too; a link there is unlinked, not followed", async () => {
    const w = world();
    const received = `${w.home}-received`;
    mkdirSync(join(received, "c_abc", "phone-1"), { recursive: true });
    writeFileSync(join(received, "c_abc", "phone-1", "a.pdf"), "pdf");
    symlinkSync(w.outside, join(received, "planted"));
    await eraseHome({ home: w.home, userHome: w.user });
    expect(existsSync(received)).toBe(false);
    expect(readFileSync(join(w.outside, "keep.txt"), "utf8")).toBe("the person's file");
  });

  test("a home given as a link: the folder it names goes, then the link; nothing beside them", async () => {
    const w = world();
    const link = join(w.user, "moss-link");
    symlinkSync(w.home, link);
    writeFileSync(join(w.user, "beside.txt"), "kept");
    await eraseHome({ home: link, userHome: w.user });
    expect(existsSync(w.home)).toBe(false);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(w.user, "beside.txt"), "utf8")).toBe("kept");
  });

  test("a refused folder loses nothing", async () => {
    const w = world();
    await expect(eraseHome({ home: w.outside, userHome: w.user })).rejects.toThrow(/nothing was removed/);
    expect(readFileSync(join(w.outside, "keep.txt"), "utf8")).toBe("the person's file");
  });
});

describe("moss-core erase: only the person, in their terminal, with MOSS quit", () => {
  const run = (w: ReturnType<typeof world>, o: { running?: boolean; interactive?: boolean; typed?: string | null }) => {
    const lines: string[] = [];
    let loginItem = 0;
    const code = runErase({
      home: w.home, userHome: w.user, engineRunning: async () => o.running ?? false, interactive: o.interactive ?? true,
      readLine: async () => (o.typed === undefined ? "ERASE" : o.typed), out: (l) => lines.push(l), err: (l) => lines.push(l),
      removeLoginItem: async () => void loginItem++,
    });
    return { code, lines, loginItem: () => loginItem };
  };

  test("refused while an engine answers (no bot or agent runs outside one)", async () => {
    const w = world();
    expect(await run(w, { running: true }).code).toBe(1);
    expect(existsSync(w.home)).toBe(true);
  });

  test("refused without a terminal to type in (a pipe from a script)", async () => {
    const w = world();
    expect(await run(w, { interactive: false }).code).toBe(1);
    expect(existsSync(w.home)).toBe(true);
  });

  test("anything but ERASE typed stops it", async () => {
    const w = world();
    expect(await run(w, { typed: "yes" }).code).toBe(1);
    expect(await run(w, { typed: null }).code).toBe(1);
    expect(existsSync(w.home)).toBe(true);
  });

  test("typed: the login item goes first, then the home; what stays is said", async () => {
    const w = world();
    const r = run(w, {});
    expect(await r.code).toBe(0);
    expect(r.loginItem()).toBe(1);
    expect(existsSync(w.home)).toBe(false);
    expect(r.lines.join("\n")).toContain("doesn't remove");
  });
});

describe("home.erase: only the person's yes on the engine's card", () => {
  const setup = (answer: boolean) => {
    const w = world();
    let armed = 0;
    const cards: { change?: string }[] = [];
    const m = homeEraseMethods({
      home: w.home, userHome: w.user, arm: () => void armed++,
      openCard: async (req) => {
        cards.push(req as { change?: string });
        return { card: "card_erase123", allowed: Promise.resolve(answer) };
      },
    });
    return { w, cards, armed: () => armed, call: (caller: unknown) => m["home.erase"]!({}, { caller } as never) };
  };

  for (const [who, caller] of [
    ["a bot's session", { kind: "session", sessionId: "b_alpha" }],
    ["a plugin", { kind: "plugin", pluginId: "acme/thing" }],
    ["a peer computer", { kind: "peer", device: "x" }],
  ] as const) {
    test(`${who} is refused: no card, nothing armed`, async () => {
      const t = setup(true);
      await expect(t.call(caller)).rejects.toBeDefined();
      expect(t.cards).toHaveLength(0);
      expect(t.armed()).toBe(0);
    });
  }

  test("the person's no arms nothing; their yes arms the erase (the engine erases after it stops)", async () => {
    const no = setup(false);
    expect(await no.call({ kind: "user", client: "app" })).toEqual({ applied: false, card: "card_erase123" });
    await Bun.sleep(10);
    expect(no.armed()).toBe(0);
    expect(no.cards[0]?.change).toBe("home-erase");
    const yes = setup(true);
    await yes.call({ kind: "user", client: "app" });
    await Bun.sleep(10);
    expect(yes.armed()).toBe(1);
    // Arming erases nothing by itself.
    expect(existsSync(yes.w.home)).toBe(true);
  });
});
