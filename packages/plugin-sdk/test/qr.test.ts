// The QR encoder the pairing page draws a code with (`src/qr.ts`): its structure, its capacities, a golden checked once with an
// independent reader (jsQR, every version from 1 to 40, a text at each version's edge; jsQR itself has a typo in version 23's
// alignment centers, so that one version was checked by its table only), and that the settings plugin's own copy is the same file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { qrCapacity, qrEncode, qrPath } from "../src/qr";

const rows = (text: string): string[] => {
  const c = qrEncode(text);
  return Array.from({ length: c.size }, (_, y) => Array.from({ length: c.size }, (_, x) => (c.dark(x, y) ? "1" : "0")).join(""));
};

describe("the QR encoder", () => {
  test("the byte capacities of level L are the standard's", () => {
    const standard: Record<number, number> = { 1: 17, 2: 32, 3: 53, 4: 78, 5: 106, 6: 134, 7: 154, 10: 271, 15: 520, 20: 858, 23: 1091, 30: 1732, 40: 2953 };
    for (const [v, n] of Object.entries(standard)) expect([v, qrCapacity(Number(v))]).toEqual([v, n]);
  });

  test("the smallest version that holds the text, and a text beyond the largest is refused", () => {
    expect(qrEncode("a".repeat(17)).version).toBe(1);
    expect(qrEncode("a".repeat(18)).version).toBe(2);
    expect(qrEncode("a".repeat(2953)).version).toBe(40);
    expect(() => qrEncode("a".repeat(2954))).toThrow(RangeError);
    expect(() => qrEncode("\ud800")).toThrow(RangeError);
    // Bytes, not characters: three-byte characters take three each.
    expect(qrEncode("€".repeat(6)).version).toBe(2);
  });

  test("a grid of 17 + 4 × version, three finder patterns, timing lines and the dark module", () => {
    const c = qrEncode("clover-pair:1:abc");
    expect(c.size).toBe(17 + 4 * c.version);
    const finder = (x0: number, y0: number) => {
      for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
        const edge = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        expect([x0 + dx, y0 + dy, c.dark(x0 + dx, y0 + dy)]).toEqual([x0 + dx, y0 + dy, edge !== 2]);
      }
    };
    finder(0, 0);
    finder(c.size - 7, 0);
    finder(0, c.size - 7);
    for (let i = 8; i < c.size - 8; i++) {
      expect(c.dark(i, 6)).toBe(i % 2 === 0);
      expect(c.dark(6, i)).toBe(i % 2 === 0);
    }
    expect(c.dark(8, c.size - 8)).toBe(true);
    expect(c.dark(-1, 0)).toBe(false);
    expect(c.dark(c.size, 0)).toBe(false);
  });

  test("the format information is a valid BCH word, twice, naming level L", () => {
    for (const text of ["a", "hello world", "x".repeat(500)]) {
      const c = qrEncode(text);
      const n = c.size;
      const word = (cells: [number, number][]) => cells.reduce((acc, [x, y], i) => acc | ((c.dark(x, y) ? 1 : 0) << i), 0);
      const first = word([[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]);
      const second = word([...Array.from({ length: 8 }, (_, i) => [n - 1 - i, 8] as [number, number]), ...Array.from({ length: 7 }, (_, i) => [8, n - 7 + i] as [number, number])]);
      expect(second).toBe(first);
      const data = (first ^ 0x5412) >>> 10;
      expect(data >>> 3).toBe(1);
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      expect((first ^ 0x5412) & 0x3ff).toBe(rem);
    }
  });

  test("the same text is the same grid, and a golden grid stays put (decoded by an independent reader when it was made)", () => {
    expect(rows("clover-pair:1:abc")).toEqual(rows("clover-pair:1:abc"));
    const hash = createHash("sha256").update(rows("HELLO, MOSS 12345").join("\n")).digest("hex");
    expect(hash).toBe(GOLDEN);
  });

  test("the path draws the dark modules inside a view box with a quiet zone", () => {
    const c = qrEncode("a");
    const { viewBox, d } = qrPath(c, 4);
    expect(viewBox).toBe(`0 0 ${c.size + 8} ${c.size + 8}`);
    let area = 0;
    for (const m of d.matchAll(/M(\d+),(\d+)h(\d+)v1h-\d+z/g)) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(4);
      area += Number(m[3]);
    }
    let dark = 0;
    for (let y = 0; y < c.size; y++) for (let x = 0; x < c.size; x++) if (c.dark(x, y)) dark++;
    expect(area).toBe(dark);
  });

  test("the settings plugin's copy is this file, byte for byte", () => {
    const here = readFileSync(join(import.meta.dir, "..", "src", "qr.ts"), "utf8");
    const copy = readFileSync(join(import.meta.dir, "..", "..", "..", "plugins", "moss", "plugins", "settings", "client", "qr.ts"), "utf8");
    expect(copy).toBe(here);
  });
});

const GOLDEN = "b6be2203c05f6b8ecbccef6b305e5e62c8f2fc8c5420009634ab09a6d7162dcb";
