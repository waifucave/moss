// What main keeps for the composer (main/attachments.ts): a chip removed or a composer gone gives its id back, the store never
// refuses (its oldest goes), and a picture over 10 MB goes as a file with a plain line saying so.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PICTURE_MAX_BYTES, PickedAttachments, STORE_FILES_MAX, STORE_IMAGES_MAX } from "../src/main/attachments";

const dir = mkdtempSync(join(tmpdir(), "moss-attach-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, body = "x"): string => { const p = join(dir, name); writeFileSync(p, body); return p; };

describe("the store of picked attachments", () => {
  test("ten picked then removed: the eleventh attaches (a removed chip gives its id back)", () => {
    const a = new PickedAttachments();
    for (let round = 0; round < 3; round++) {
      const got = Array.from({ length: 10 }, (_, i) => a.take(file(`f${round}-${i}.txt`))!);
      expect(got.every((g) => g.kind === "file")).toBe(true);
      a.release(got.map((g) => g.id));
      expect(a.files.size).toBe(0);
    }
    const eleventh = a.take(file("eleventh.txt"));
    expect(eleventh?.kind).toBe("file");
    expect(a.files.size).toBe(1);
  });

  test("a composer gone (its ids released) clears what it held, pictures too; an id it never held is ignored", () => {
    const a = new PickedAttachments();
    const png = a.take(file("a.png", "png"))!;
    const doc = a.take(file("a.txt"))!;
    expect([png.kind, doc.kind]).toEqual(["image", "file"]);
    a.release([png.id, doc.id, "not-an-id"]);
    expect([a.images.size, a.files.size]).toEqual([0, 0]);
  });

  test("as a floor it never refuses: past its bound the oldest goes", () => {
    const a = new PickedAttachments();
    const ids = Array.from({ length: STORE_FILES_MAX + 3 }, (_, i) => a.take(file(`g${i}.txt`))!.id);
    expect(a.files.size).toBe(STORE_FILES_MAX);
    expect(a.files.has(ids[0]!)).toBe(false);
    expect(a.files.has(ids[ids.length - 1]!)).toBe(true);
    const pics = Array.from({ length: STORE_IMAGES_MAX + 2 }, (_, i) => a.take(file(`p${i}.png`, "png"))!);
    expect(pics.every((p) => p.kind === "image")).toBe(true); // pictures stay pictures: they don't degrade to files
    expect(a.images.size).toBe(STORE_IMAGES_MAX);
  });

  test("a picture over 10 MB goes as a file, with one plain line saying so; one at the bound is a picture", () => {
    const a = new PickedAttachments();
    const big = join(dir, "big.png");
    writeFileSync(big, "");
    truncateSync(big, PICTURE_MAX_BYTES + 1);
    expect(a.take(big)).toMatchObject({ kind: "file", name: "big.png", note: "“big.png” is over 10 MB, so it goes as a file, not as a picture." });
    const edge = join(dir, "edge.png");
    writeFileSync(edge, "");
    truncateSync(edge, PICTURE_MAX_BYTES);
    expect(a.take(edge)?.kind).toBe("image");
  });

  test("a path that isn't absolute is taken for nothing", () => {
    expect(new PickedAttachments().take("relative/a.txt")).toBeUndefined();
  });
});
