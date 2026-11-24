// The one path comparison the fence uses (`pathKey`, `pathWithin`, fold.ts; lane WS8), held to the hostile spellings
// both Windows audits listed: mixed and doubled separators, `.` and `..`, device prefixes (`\\?\`, `\\.\`, UNC),
// drive-relative paths, case, trailing dots and spaces, alternate data streams; and what it leaves to the disk (8.3
// short names, links).
import { describe, expect, test } from "bun:test";
import { pathKey, pathWithin } from "../../src/fence/fold";
import { rootCovered } from "../../src/fence/sandbox-settings";

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
