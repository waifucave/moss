// The one path comparison the fence uses (`pathKey`, `pathWithin`, fold.ts; lane WS8), held to the hostile spellings
// both Windows audits listed: mixed and doubled separators, `.` and `..`, device prefixes (`\\?\`, `\\.\`, UNC),
// drive-relative paths, case, trailing dots and spaces, alternate data streams; and what it leaves to the disk (8.3
// short names, links).
import { describe, expect, test } from "bun:test";
import { pathKey, pathWithin } from "../../src/fence/fold";
import { rootCovered } from "../../src/fence/sandbox-settings";
import { grantedForms, homeReach, opaqueWindowsPath, reachesInside, uncPath, windowsPathRefused } from "../../src/agents/memory";
import { runLaterByName } from "../../src/fence/sandbox-settings";
import { diskSpelling } from "../../src/fence/canonical";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = "C:\\Users\\u\\.moss";

describe("pathKey on Windows: every spelling Windows opens as the same path has one key", () => {
  const same: [string, string][] = [
    ["C:/Users/u/.moss", "forward slashes"],
    ["C:\\Users/u\\.moss", "mixed separators"],
    ["C:\\\\Users\\\\\\u\\.moss\\", "doubled separators and a trailing one"],
    ["C:\\Users\\.\\u\\.\\.moss", "`.` components"],
    ["C:\\Users\\x\\..\\u\\.moss", "a `..` taken lexically"],
    ["C:\\..\\..\\Users\\u\\.moss", "`..` above the drive stays at the drive"],
    ["\\\\?\\C:\\Users\\u\\.moss", "the `\\\\?\\` device prefix"],
    ["\\\\.\\C:\\Users\\u\\.moss", "the `\\\\.\\` device prefix"],
    ["c:\\USERS\\U\\.MOSS", "case"],
    ["C:\\Users\\u\\.moss.", "a trailing dot"],
    ["C:\\Users\\u\\.moss . .", "trailing dots and spaces"],
    ["C:\\Users\\u\\.moss::$DATA", "the default data stream"],
    ["C:\\Users\\u.\\.moss", "a trailing dot on a folder on the way"],
  ];
  for (const [spelling, what] of same) {
    test(what, () => {
      expect(pathKey(spelling, "windows")).toBe(pathKey(ROOT, "windows"));
      expect(pathWithin(spelling, ROOT, "windows")).toBe(true);
      expect(pathWithin(`${spelling}${spelling.endsWith("\\") || spelling.endsWith("/") ? "" : "\\"}secrets.enc`, ROOT, "windows")).toBe(true);
    });
  }
  test("UNC, with or without its device prefix, is one share; `..` never leaves the share", () => {
    const share = "\\\\server\\share\\moss";
    for (const s of ["\\\\?\\UNC\\server\\share\\moss", "\\\\.\\UNC\\server\\share\\moss", "//server/share/moss", "\\\\SERVER\\Share\\x\\..\\moss", "\\\\server\\share\\..\\..\\moss"]) {
      expect([s, pathKey(s, "windows")]).toEqual([s, pathKey(share, "windows")]);
    }
    expect(pathKey(share, "windows")).toBe("//server/share/moss");
    expect(pathWithin("\\\\server\\other\\moss", share, "windows")).toBe(false);
  });
  test("a file's named stream is inside its folder, as the file is", () => {
    expect(pathWithin("C:\\Users\\u\\.moss\\secrets.enc:hidden", ROOT, "windows")).toBe(true);
    expect(pathKey("C:\\Users\\u\\.moss\\secrets.enc:hidden:$DATA", "windows")).toBe(pathKey("C:\\Users\\u\\.moss\\secrets.enc", "windows"));
  });
});

describe("pathKey on Windows: what is NOT the same path stays apart", () => {
  test("a sibling whose name starts like the root is outside it", () => {
    expect(pathWithin("C:\\Users\\u\\.moss-e2e\\x", ROOT, "windows")).toBe(false);
    expect(pathWithin("C:\\Users\\u\\.mossy", ROOT, "windows")).toBe(false);
  });
  test("`..` that climbs out is outside", () => {
    expect(pathWithin("C:\\Users\\u\\.moss\\..\\Documents", ROOT, "windows")).toBe(false);
    expect(pathWithin("C:\\Users\\u\\.moss\\a\\..\\..\\.moss\\b", ROOT, "windows")).toBe(true);
  });
  test("another drive is outside", () => {
    expect(pathWithin("D:\\Users\\u\\.moss\\x", ROOT, "windows")).toBe(false);
  });
  test("a drive-relative or relative path is inside no absolute path (callers pass absolute paths)", () => {
    for (const rel of ["C:Users\\u\\.moss\\x", "C:.moss", "Users\\u\\.moss", ".moss\\x", "..\\.moss"]) {
      expect([rel, pathWithin(rel, ROOT, "windows")]).toEqual([rel, false]);
      expect(pathKey(rel, "windows").startsWith("?rel:")).toBe(true);
    }
    expect(pathWithin(ROOT, "C:.moss", "windows")).toBe(false);
  });
  test("8.3 short names and links are the disk's to resolve: lexically they are other names", () => {
    expect(pathWithin("C:\\PROGRA~1\\MOSS", "C:\\Program Files", "windows")).toBe(false);
  });
});

describe("pathKey on macOS and Linux", () => {
  test("`/` only: a backslash is part of a name there", () => {
    expect(pathWithin("/Users/u/.moss\\x", "/Users/u/.moss", "macos")).toBe(false);
    expect(pathKey("/Users//u/./x/../.moss/", "macos")).toBe(pathKey("/Users/u/.moss", "macos"));
  });
  test("macOS folds case (APFS); Linux doesn't, so one folder never stands for another there", () => {
    expect(pathWithin("/Users/U/.MOSS/x", "/Users/u/.moss", "macos")).toBe(true);
    expect(pathWithin("/home/U/.MOSS/x", "/home/u/.moss", "linux")).toBe(false);
    expect(pathWithin("/home/u/.moss/x", "/home/u/.moss", "linux")).toBe(true);
  });
  test("relative paths stay apart from absolute ones", () => {
    expect(pathWithin("home/u/.moss", "/home/u/.moss", "linux")).toBe(false);
  });
});

describe("the fence's comparisons use it (lane WS8)", () => {
  test("a path strictly under a glob-denied folder is covered on Windows, in any spelling (`denyRegex` knew only `/`)", () => {
    const deny = ["C:\\Users\\u\\**\\.git\\hooks"];
    for (const p of [
      "C:\\Users\\u\\proj\\.git\\hooks\\pre-commit",
      "C:/Users/u/proj/.git/hooks/pre-commit",
      "\\\\?\\C:\\Users\\u\\proj\\.GIT\\hooks\\pre-commit",
      "C:\\Users\\u\\proj\\x\\..\\.git\\hooks.\\pre-commit",
      "C:\\Users\\u\\.git\\hooks",
    ]) expect([p, rootCovered(p, deny, "windows")]).toEqual([p, true]);
    expect(rootCovered("C:\\Users\\u\\proj\\.github\\hooks\\x", deny, "windows")).toBe(false);
    expect(rootCovered("C:\\Users\\other\\proj\\.git\\hooks\\x", deny, "windows")).toBe(false);
  });
  test("a literal deny covers what lies under it in any spelling", () => {
    expect(rootCovered("C:/Users/u/.moss/run/token", ["C:\\Users\\u\\.moss\\run"], "windows")).toBe(true);
    expect(rootCovered("C:\\Users\\u\\.moss\\x\\..\\run\\token", ["C:\\Users\\u\\.moss\\run\\"], "windows")).toBe(true);
    expect(rootCovered("C:\\Users\\u\\.moss\\running", ["C:\\Users\\u\\.moss\\run"], "windows")).toBe(false);
  });
  test("on macOS and Linux it is as before: `/` only, a glob's folder and what is under it", () => {
    expect(rootCovered("/Users/u/proj/.git/hooks/pre-commit", ["/Users/u/**/.git/hooks"], "macos")).toBe(true);
    expect(rootCovered("/home/u/proj/.git/hooks", ["/home/u/**/.git/hooks"], "linux")).toBe(true);
    expect(rootCovered("/home/u/proj/.GIT/hooks", ["/home/u/**/.git/hooks"], "linux")).toBe(false);
  });
});

describe("device paths no comparison can place, and the deny decisions that refuse them (lane WS8)", () => {
  test("a volume GUID path, GLOBALROOT, a pipe or a raw device is opaque; a drive or a share in the device namespace is not", () => {
    for (const p of ["\\\\?\\Volume{0e1b2c3d-1111-2222-3333-444455556666}\\Users\\u\\.ssh", "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume3\\Users", "\\\\.\\pipe\\x", "//./PhysicalDrive0", "\\\\?\\Volume{x}"]) {
      expect([p, opaqueWindowsPath(p, "windows")]).toEqual([p, true]);
    }
    for (const p of ["\\\\?\\C:\\Users\\u", "\\\\.\\C:\\x", "\\\\?\\UNC\\s\\share", "\\\\server\\share\\x", "C:\\Users", "relative\\x"]) {
      expect([p, opaqueWindowsPath(p, "windows")]).toEqual([p, false]);
    }
    expect(opaqueWindowsPath("//./x", "macos")).toBe(false);
  });
  test("the agents' and bots' deny decision (`homeReach`) refuses an opaque path whatever folder it is asked about", () => {
    expect(homeReach("C:\\Users\\u\\.moss", "\\\\?\\Volume{0e1b2c3d-1111-2222-3333-444455556666}\\Users\\u\\.moss\\run\\token", "C:\\Users\\u\\p", "windows")).toBe("inside");
  });
  test("`reachesInside`: the fence's comparison on Windows, the folded one elsewhere", () => {
    expect(reachesInside("\\\\?\\C:\\USERS\\u\\.ssh.\\id", "C:\\Users\\u\\.ssh", "windows")).toBe(true);
    expect(reachesInside("C:/Users/u/x/../.ssh/id", "C:\\Users\\u\\.ssh", "windows")).toBe(true);
    expect(reachesInside("/home/u/.SSH/id", "/home/u/.ssh", "linux")).toBe(true); // folded on Linux too: only denies more
    expect(reachesInside("/Users/u/.sshx/id", "/Users/u/.ssh", "macos")).toBe(false);
  });
});

describe("a share in the file tools' deny decisions on Windows: refused unless inside a granted share root (lane WS8)", () => {
  const granted = ["C:\\Users\\u\\proj", "\\\\nas\\share\\proj"];
  test("every loopback and own-name spelling of this computer is refused (no list of its names is kept)", () => {
    for (const p of [
      "\\\\localhost\\C$\\Users\\u\\.ssh\\id_ed25519", "\\\\127.0.0.1\\C$\\Users\\u\\.moss\\run\\token", "\\\\[::1]\\C$\\x",
      "//LOCALHOST/c$/Users/u/.ssh/id", "\\/localhost\\C$/Users\\u", "\\\\MYPC\\Users\\u\\.ssh", "\\\\?\\UNC\\localhost\\C$\\Users\\u",
      "\\\\.\\UNC\\127.0.0.1\\C$\\x", "//?/unc/localhost/c$/x", "\\\\nas\\share\\other\\x", "\\\\nas\\share\\proj-2\\x",
    ]) {
      expect([p, uncPath(p, "windows") || opaqueWindowsPath(p, "windows"), windowsPathRefused(p, granted, "windows")]).toEqual([p, true, true]);
    }
  });
  test("inside a granted share root: allowed, in any separators and case", () => {
    for (const p of ["\\\\nas\\share\\proj\\x.txt", "//NAS/Share/proj/sub/y", "\\\\?\\UNC\\nas\\share\\proj\\z", "\\\\nas/share\\PROJ", "\\\\nas\\share\\proj\\a\\..\\b"]) {
      expect([p, windowsPathRefused(p, granted, "windows")]).toEqual([p, false]);
    }
  });
  test("a drive path is not a share, and nothing is refused this way off Windows", () => {
    expect(windowsPathRefused("C:\\Users\\u\\x", granted, "windows")).toBe(false);
    expect(windowsPathRefused("\\\\?\\C:\\Users\\u\\x", granted, "windows")).toBe(false);
    expect(windowsPathRefused("//localhost/x", [], "macos")).toBe(false);
  });
  test("`homeReach`, the coding agent's and bots' deny decision: a share outside its granted roots reaches every deny", () => {
    expect(homeReach("C:\\Users\\u\\.ssh", "\\\\localhost\\C$\\Users\\u\\.ssh\\id", "C:\\Users\\u\\proj", "windows")).toBe("inside");
    // A share that fails at once (no such share here), so no lookup waits on the network.
    expect(homeReach("C:\\Users\\u\\.ssh", "\\\\localhost\\ws8-no-such-share\\proj\\x", "\\\\localhost\\ws8-no-such-share\\proj", "windows")).toBeUndefined();
  });
});

describe("run-later places by name, in the disk's own spelling too (lane WS8: a Windows acceptance run's refusal)", () => {
  const long = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\h";
  const short = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\h";
  const spell = (p: string) => p.replace(/^C:\\Users\\RUNNER~1/i, "C:\\Users\\runneradmin").replace(/MCPJSO~1\.JSO$/i, ".mcp.json");
  const homes = { userHome: "C:\\Users\\runneradmin", mossHome: `${long}\\.moss`, os: "windows" as const };
  test("an installed plugin's file named through the home's short name is inside the home, not a project's `.moss`", () => {
    const file = `${short}\\.moss\\plugins\\ws-greeter\\host\\index.ts`;
    expect(runLaterByName(file, { ...homes, spell: (p) => p })).toBe(true); // the refusal the run met: compared as written only
    expect(runLaterByName(file, { ...homes, spell })).toBe(false);
    expect(runLaterByName(file, { ...homes, mossHome: `${short}\\.moss`, spell })).toBe(false); // the home given short
  });
  test("a project's `.moss` is still held, and a short name of a held file is that file", () => {
    expect(runLaterByName("C:\\Users\\runneradmin\\proj\\.moss\\x", { ...homes, spell })).toBe(true);
    expect(runLaterByName("C:\\Users\\RUNNER~1\\proj\\.moss\\x", { ...homes, spell })).toBe(true);
    expect(runLaterByName("C:\\Users\\runneradmin\\proj\\MCPJSO~1.JSO", { ...homes, spell })).toBe(true);
  });
  // The runner's TEMP is spelled with the account's 8.3 name (`C:\Users\RUNNER~1\…`): the real one, on Windows.
  test.skipIf(process.platform !== "win32")("on Windows, a real short-named folder: `diskSpelling` gives it long, and an installed plugin's file there isn't held", () => {
    const d = mkdtempSync(join(tmpdir(), "ws8-short-"));
    try {
      const longD = realpathSync.native(d).replace(/^\\\\\?\\/, "");
      mkdirSync(join(d, ".moss", "plugins", "p"), { recursive: true });
      console.log(`[unit] 8.3: tmp ${d} long ${longD} (short name on the way: ${d.toLowerCase() !== longD.toLowerCase()})`);
      expect(diskSpelling(d).toLowerCase()).toBe(longD.toLowerCase());
      expect(runLaterByName(join(d, ".moss", "plugins", "p", "x.ts"), { userHome: "C:\\Users\\nobody", mossHome: join(longD, ".moss"), os: "windows" })).toBe(false);
      expect(runLaterByName(join(longD, "proj", ".moss", "x"), { userHome: "C:\\Users\\nobody", mossHome: join(longD, ".moss"), os: "windows" })).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("a project on a mapped drive (lane WS9, the reviewer's should-fix): its granted root is judged as it resolves too", () => {
  // `Z:` mapped to `\\\\nas\\share`: Windows resolves every path under it to the share.
  const real = (p: string) => p.replace(/^Z:/i, "\\\\nas\\share");
  test("its files, which resolve to the share, are inside the root granted by its letter", () => {
    const forms = grantedForms(["Z:\\proj"], "Z:\\proj", real);
    expect(forms).toEqual(["Z:\\proj", "\\\\nas\\share\\proj"]);
    for (const p of ["\\\\nas\\share\\proj\\src\\a.ts", "//NAS/share/PROJ/b", "\\\\?\\UNC\\nas\\share\\proj\\c"]) {
      expect([p, windowsPathRefused(p, forms, "windows")]).toEqual([p, false]);
    }
  });
  test("the share outside the project, and this computer's own shares, stay refused", () => {
    const forms = () => grantedForms(["Z:\\proj"], "Z:\\proj", real);
    for (const p of ["\\\\nas\\share\\other\\x", "\\\\nas\\share", "\\\\localhost\\C$\\Users\\u\\.ssh\\id", "\\\\nas\\share\\proj2\\x"]) {
      expect([p, windowsPathRefused(p, forms, "windows")]).toEqual([p, true]);
    }
  });
  test("the roots are resolved only when a share is asked about", () => {
    let resolved = 0;
    const forms = () => { resolved++; return grantedForms(["Z:\\proj"], "Z:\\proj", real); };
    expect(windowsPathRefused("C:\\Users\\u\\x", forms, "windows")).toBe(false);
    expect(resolved).toBe(0);
    windowsPathRefused("\\\\nas\\share\\proj\\x", forms, "windows");
    expect(resolved).toBe(1);
  });
});
