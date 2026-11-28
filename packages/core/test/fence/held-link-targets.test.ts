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

  test("only plain names are looked up, one lstat each (a wildcard or a folder in a name isn't)", () => {
    const looked: string[] = [];
    heldLinkTargets(["/r"], ["*.git", ".husky", ".git/hooks", ".zshrc"], { userHome: "/h", os: "linux", lstat: (p) => { looked.push(p); return undefined; } });
    expect(looked.sort()).toEqual(["/h/.husky", "/h/.zshrc", "/r/.husky", "/r/.zshrc"]);
  });
});
