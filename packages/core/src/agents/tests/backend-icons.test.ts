// The real BackendIcons reader: the contract's conformance suite over in-memory files, then the same rules over a real temp
// plugin folder (symlinks, hard links, case variants, `..`, a file that doesn't exist yet, a file that is a folder, sizes).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ICON_FILE_MAX_BYTES } from "@waifucave/moss-protocol";
import { runBackendIconsConformance } from "../../contracts/conformance/backend-icons";
import { EngineBackendIcons, nodeIconFiles } from "../backend-icons";

runBackendIconsConformance((files) => new EngineBackendIcons(files));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path fill="currentColor" d="M0 0h8v8z"/></svg>';

describe("the real reader over a plugin folder on disk", () => {
  let base: string;
  let plugin: string;
  let outside: string;
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "moss-icons-")));
    plugin = join(base, "plugins", "agent-x");
    outside = join(base, "elsewhere");
    mkdirSync(join(plugin, "marks"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(plugin, "marks", "x.svg"), SVG);
    writeFileSync(join(plugin, "marks", "x.png"), PNG);
    writeFileSync(join(outside, "secret.png"), PNG);
    writeFileSync(join(outside, "secret.svg"), SVG);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const reader = () => new EngineBackendIcons(nodeIconFiles(() => 7));

  test("a PNG and an inert SVG inside the folder are served inline", async () => {
    expect(await reader().read(plugin, "marks/x.svg")).toEqual({ icon: { mediaType: "image/svg+xml", data: Buffer.from(SVG).toString("base64"), at: 7 } });
    expect(await reader().read(plugin, "marks/x.png")).toMatchObject({ icon: { mediaType: "image/png" } });
  });

  test("a symlink planted in the folder, to a file or to a folder outside it, is refused", async () => {
    symlinkSync(join(outside, "secret.png"), join(plugin, "marks", "link.png"));
    symlinkSync(outside, join(plugin, "marks", "dir"));
    expect(await reader().read(plugin, "marks/link.png")).toMatchObject({ none: "refused" });
    expect(await reader().read(plugin, "marks/dir/secret.svg")).toMatchObject({ none: "refused" });
    // A link that stays inside is the plugin's own file.
    symlinkSync(join(plugin, "marks", "x.png"), join(plugin, "marks", "inner.png"));
    expect(await reader().read(plugin, "marks/inner.png")).toMatchObject({ icon: { mediaType: "image/png" } });
  });

  test("a hard link planted in the folder to a file kept elsewhere is refused", async () => {
    linkSync(join(outside, "secret.png"), join(plugin, "marks", "hard.png"));
    expect(await reader().read(plugin, "marks/hard.png")).toMatchObject({ none: "refused" });
  });

  test("a path with .. or an absolute path never reaches the disk; the plugin's folder being a link out is refused too", async () => {
    expect(await reader().read(plugin, "../../elsewhere/secret.png")).toMatchObject({ none: "refused" });
    expect(await reader().read(plugin, join(outside, "secret.png"))).toMatchObject({ none: "refused" });
    expect(await reader().read(plugin, "marks/../marks/x.png")).toMatchObject({ none: "refused" });
    // The folder inside the plugin that is a link to the outside: the real path decides.
    symlinkSync(outside, join(plugin, "out"));
    expect(await reader().read(plugin, "out/secret.svg")).toMatchObject({ none: "refused" });
  });

  test("a file that doesn't exist yet is no icon; created or renamed into place later, it is read then", async () => {
    expect(await reader().read(plugin, "marks/late.png")).toMatchObject({ none: "missing" });
    writeFileSync(join(plugin, "marks", "late.tmp"), PNG);
    renameSync(join(plugin, "marks", "late.tmp"), join(plugin, "marks", "late.png"));
    expect(await reader().read(plugin, "marks/late.png")).toMatchObject({ icon: { mediaType: "image/png" } });
  });

  test("a case variant is the file the OS says it is (on a case-insensitive disk the same one, still inside), a folder is no icon, and a file over the cap is refused", async () => {
    const r = await reader().read(plugin, "marks/X.PNG");
    // Case-insensitive volume: found, but its name's extension is checked as the bytes' type, which it is. Case-sensitive: missing.
    expect(["icon" in r, "none" in r && r.none === "missing"].some(Boolean)).toBe(true);
    expect(await reader().read(plugin, "marks")).toMatchObject({ none: "missing" });
    const big = new Uint8Array(ICON_FILE_MAX_BYTES + 5000);
    big.set(PNG);
    writeFileSync(join(plugin, "marks", "big.png"), big);
    expect(await reader().read(plugin, "marks/big.png")).toMatchObject({ none: "refused" });
    // Exactly the cap is served.
    const edge = new Uint8Array(ICON_FILE_MAX_BYTES);
    edge.set(PNG);
    writeFileSync(join(plugin, "marks", "edge.png"), edge);
    expect(await reader().read(plugin, "marks/edge.png")).toMatchObject({ icon: { mediaType: "image/png" } });
  });
});
