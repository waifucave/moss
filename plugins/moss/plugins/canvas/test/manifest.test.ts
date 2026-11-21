import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { validateManifest } from "@waifucave/moss-plugin-sdk";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(root, "moss.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The capability catalog's names (the SDK's generated catalog). */
const CAPABILITIES = new Set<string>((JSON.parse(readFileSync(join(root, "..", "..", "..", "..", "packages", "plugin-sdk", "generated", "catalog.json"), "utf8")) as { capabilities: { name: string }[] }).capabilities.map((c) => c.name));

describe("moss.json (spec §5.9, format 1)", () => {
  test("a child of `moss`: no id of its own, a name, format 1, a client entry that exists", () => {
    expect(manifest.manifest).toBe(1);
    expect(manifest.id).toBeUndefined();
    expect(manifest.name).toBe("Canvas");
    expect(existsSync(join(root, manifest.client.entry))).toBe(true);
    expect(typeof manifest.engines?.moss).toBe("string");
  });

  test("asks only for capabilities the catalog defines, and each for a reason the canvas has", () => {
    // activity.read.bots: a bot's live state, which its face shows; sessions.read + conversation.read: the code sessions and the bots' (a link with a bot's end is heard only by a
    // plugin that reads both kinds); bots.read: a bot's name and face; computers.read: which agents this computer has;
    // sessions.start: + (agent.start, ui.pick for agent.start); user.send: a block's composer; shell.control: Open in MOSS.
    expect([...manifest.capabilities].sort()).toEqual(["activity.read.bots", "bots.read", "computers.read", "conversation.read", "sessions.read", "sessions.start", "shell.control", "user.send"]);
    for (const c of manifest.capabilities) expect([c, CAPABILITIES.has(c)]).toEqual([c, true]);
  });

  test("its entries: the start page (main keyed start) and the tab's corner (session.corner, code tabs only)", async () => {
    const entry = await import(join(root, manifest.client.entry));
    const start = manifest.contributes.ui.find((u: { spot: string }) => u.spot === "main");
    const corner = manifest.contributes.ui.find((u: { spot: string }) => u.spot === "session.corner");
    expect(start).toMatchObject({ key: "start", component: "CanvasStart" });
    expect(corner).toMatchObject({ component: "CanvasCorner", title: expect.any(String), icon: "assets/canvas.svg", when: { session: ["coding", "agent"] } });
    expect(existsSync(join(root, corner.icon))).toBe(true);
    for (const ui of manifest.contributes.ui) expect([ui.component, typeof entry[ui.component]]).toEqual([ui.component, "function"]);
  });

  test("the package is named for the child; client.css exists and the entry imports no CSS", () => {
    expect(pkg.name).toBe("@waifucave/moss-plugin-canvas");
    expect(pkg.private).toBe(true);
    for (const css of manifest.client.css) expect(existsSync(join(root, css))).toBe(true);
    expect(readFileSync(join(root, manifest.client.entry), "utf8")).not.toMatch(/import\s+["'][^"']+\.css["']/);
  });

  test("the client bundle carries no protocol code (the protocol is the tests' and the gallery's only)", () => {
    expect(pkg.dependencies["@waifucave/moss-protocol"]).toBeUndefined();
    for (const f of ["Canvas.tsx", "Block.tsx", "NewSessionPanel.tsx", "Mark.tsx", "entry.tsx", "index.tsx", "layout.ts", "links.ts", "look.ts", "model.ts", "preselect.ts", "source.ts", "strings.ts", "tokens.ts"]) {
      expect([f, readFileSync(join(root, "client", f), "utf8").includes("moss-protocol")]).toEqual([f, false]);
    }
  });

  test("the validator finds nothing it would report, loaded as a bundled part of moss", () => {
    const report = validateManifest(readFileSync(join(root, "moss.json"), "utf8"), { folderName: basename(root), parent: { id: "moss", namespace: "moss" }, bundled: true, file: "moss.json" });
    expect(report.issues.map((i) => `${i.severity} ${i.code} ${i.path}: ${i.message}`)).toEqual([]);
  });
});
