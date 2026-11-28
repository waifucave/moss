// Lane XC (the controller's follow-up after 0.0.91): a held name that is a LINK (a stow-managed home: `~/.zshrc` →
// `~/dotfiles/zshrc`) is denied by name, but a write through it lands on its target, which bubblewrap doesn't mount and
// Seatbelt checks by its resolved path. The target is on MOSS's deny-write list too, wherever it lies in a write root,
// on every OS's settings (`shellRunLaterDenies`, `heldLinkTargets`).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heldLinkTargets, heldNames, shellRunLaterDenies } from "../../src/fence/sandbox-settings";
import { hostOs } from "../../src/tree/names";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const posixTest = hostOs() === "windows" ? test.skip : test;

/** A home whose dotfiles stow manages: `.zshrc` and `.envrc` are links into `dotfiles/`, `.bashrc` a plain file, `.profile` a
 *  link outside every root, and a project with its own `.envrc` link. */
function stowHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "xc-held-links-")));
  temps.push(home);
  const dotfiles = join(home, "dotfiles");
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "xc-held-links-out-")));
  temps.push(elsewhere);
  mkdirSync(dotfiles);
  for (const f of ["zshrc", "envrc", "project-envrc"]) writeFileSync(join(dotfiles, f), "# mine\n");
  writeFileSync(join(elsewhere, "profile"), "# mine\n");
  symlinkSync(join(dotfiles, "zshrc"), join(home, ".zshrc"));
  symlinkSync(join(dotfiles, "envrc"), join(home, ".envrc"));
  symlinkSync(join(elsewhere, "profile"), join(home, ".profile"));
  writeFileSync(join(home, ".bashrc"), "# plain\n");
  const project = join(home, "Projects", "app");
  mkdirSync(project, { recursive: true });
  symlinkSync(join(dotfiles, "project-envrc"), join(project, ".envrc"));
  return { home, dotfiles, elsewhere, project };
}

describe("the targets of held names that are links", () => {
  posixTest("a link's target in a write root is denied; one outside every root, a plain file and a missing link add nothing", () => {
    const h = stowHome();
    // The home a root (fully automatic): every link under it whose target is in it.
    expect(heldLinkTargets([h.home], heldNames(), { userHome: h.home, os: hostOs() }).sort()).toEqual([join(h.dotfiles, "envrc"), join(h.dotfiles, "zshrc")].sort());
    // Only the dotfiles folder a root (accept edits draws the home's ordinary folders): the home's links still count,
    // their targets are in that root.
    expect(heldLinkTargets([h.dotfiles], heldNames(), { userHome: h.home, os: hostOs() }).sort()).toEqual([join(h.dotfiles, "envrc"), join(h.dotfiles, "zshrc")].sort());
    // A project root: its own link's target is denied when it lies in a root.
    expect(heldLinkTargets([h.project, h.dotfiles], heldNames(), { userHome: h.home, os: hostOs() })).toContain(join(h.dotfiles, "project-envrc"));
    // No root holds a target: nothing.
    expect(heldLinkTargets([h.project], [".zshrc", ".profile"], { userHome: h.home, os: hostOs() })).toEqual([]);
  });

  posixTest("they are on the shell's deny-write list (`shellRunLaterDenies`), beside the held names", () => {
    const h = stowHome();
    const denies = shellRunLaterDenies([h.dotfiles], { userHome: h.home, mossHome: join(h.home, ".moss"), os: hostOs(), pathFolders: [] });
    expect(denies).toContain(join(h.dotfiles, "zshrc"));
    expect(denies).toContain(join(h.dotfiles, "envrc"));
    expect(denies).not.toContain(join(h.elsewhere, "profile"));
  });

  posixTest("a chain: every link met on the way in a write root is denied, as well as the end", () => {
    // `~/.zshrc` → `~/dotfiles/zshrc` with `~/dotfiles` → `~/Dropbox/dotfiles`: replacing the `~/dotfiles` link would point
    // the held name at another file, so it is denied too.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "xc-held-chain-")));
    temps.push(home);
    const real = join(home, "Dropbox", "dotfiles");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "zshrc"), "# mine\n");
    symlinkSync(real, join(home, "dotfiles"));
    symlinkSync(join(home, "dotfiles", "zshrc"), join(home, ".zshrc"));
    expect(heldLinkTargets([home], [".zshrc"], { userHome: home, os: hostOs() }).sort()).toEqual([join(home, "dotfiles"), join(real, "zshrc")].sort());
    // Only the Dropbox folder a root: the end is denied, the `~/dotfiles` link (outside every root) isn't.
    expect(heldLinkTargets([join(home, "Dropbox")], [".zshrc"], { userHome: home, os: hostOs() })).toEqual([join(real, "zshrc")]);
  });

  posixTest("a dangling link: the path it would resolve to is denied, so the bot can't make it", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "xc-held-dangling-")));
    temps.push(home);
    mkdirSync(join(home, "dotfiles"));
    symlinkSync(join(home, "dotfiles", "envrc"), join(home, ".envrc"));
    // Missing two levels down too: the existing folder's real path plus the rest.
    symlinkSync(join(home, "later", "deep", "zshrc"), join(home, ".zshrc"));
    expect(heldLinkTargets([home], [".envrc", ".zshrc"], { userHome: home, os: hostOs() }).sort()).toEqual([join(home, "dotfiles", "envrc"), join(home, "later", "deep", "zshrc")].sort());
  });

  posixTest("a link at a root, or holding one or the MOSS home, makes nothing read-only: only the link is held, by its name", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "xc-held-at-root-")));
    temps.push(home);
    const projects = join(home, "Projects");
    mkdirSync(join(projects, "app"), { recursive: true });
    mkdirSync(join(home, ".moss"));
    symlinkSync(projects, join(home, ".vscode")); // the link's target IS a root
    symlinkSync(home, join(projects, "app", ".idea")); // the target HOLDS a root
    symlinkSync(join(home, ".moss"), join(projects, ".envrc")); // the target is the MOSS home
    const roots = [projects, join(projects, "app")];
    expect(heldLinkTargets(roots, [".vscode", ".idea", ".envrc"], { userHome: home, os: hostOs(), mossHome: join(home, ".moss") })).toEqual([]);
  });

  test("only plain names are looked up, one lstat each (a wildcard or a folder in a name isn't)", () => {
    const looked: string[] = [];
    heldLinkTargets(["/r"], ["*.git", ".husky", ".git/hooks", ".zshrc"], { userHome: "/h", os: "linux", lstat: (p) => { looked.push(p); return undefined; } });
    expect(looked.sort()).toEqual(["/h/.husky", "/h/.zshrc", "/r/.husky", "/r/.zshrc"]);
  });
});
