// A QR code from a piece of text, as modules (the dark squares), for a page to draw as an image: the pairing code a phone scans
// (spec §8.1). Byte mode, error correction level L, versions 1 to 40, the mask with the lowest penalty. Nothing here reads or sends
// anything: the text goes in, a grid of true/false comes out. The pairing page of the settings plugin keeps a byte-identical copy
// (`plugins/moss/plugins/settings/client/qr.ts`, a test holds them together), because a plugin's own build takes only its own files.

/** Error correction codewords per block, and the number of blocks, by version (index 0 unused), at level L. */
const ECC_PER_BLOCK = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const BLOCKS = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];
/** The format bits' code for level L. */
const LEVEL_L_BITS = 1;
const MIN_VERSION = 1;
const MAX_VERSION = 40;

export interface QrCode {
  /** Modules on a side (17 + 4 × version). */
  readonly size: number;
  readonly version: number;
  /** Whether the module at column `x`, row `y` is dark (false outside the code). */
  dark(x: number, y: number): boolean;
}

const rawDataModules = (ver: number): number => {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
};
const dataCodewords = (ver: number): number => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver]! * BLOCKS[ver]!;

/** How many bytes of text one version holds. */
export const qrCapacity = (version: number): number => {
  const bits = dataCodewords(version) * 8 - 4 - (version < 10 ? 8 : 16);
  return Math.floor(bits / 8);
};

// ---- Reed-Solomon over GF(256), polynomial 0x11D ----

const gfMul = (x: number, y: number): number => {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
};
const rsDivisor = (degree: number): number[] => {
  const result: number[] = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
};
const rsRemainder = (data: readonly number[], divisor: readonly number[]): number[] => {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = result[i]! ^ gfMul(coef, factor);
    });
  }
  return result;
};

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

// ---- the grid ----

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    const make = () => Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.modules = make();
    this.fn = make();
    this.drawFunctionPatterns();
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.fn[y]![x] = true;
  }

  private drawFunctionPatterns(): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(n - 4, 3);
    this.finder(3, n - 4);
    const pos = alignmentPositions(this.version);
    const last = pos.length - 1;
    pos.forEach((cx, i) => {
      pos.forEach((cy, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      });
    });
    this.formatBits(0);
    this.versionBits();
  }

  private finder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  formatBits(mask: number): void {
    const data = (LEVEL_L_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(bits, i));
    this.set(8, n - 8, true);
  }

  private versionBits(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, bit(bits, i));
      this.set(b, a, bit(bits, i));
    }
  }

  drawCodewords(data: readonly number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.fn[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (!this.fn[y]![x] && invert) this.modules[y]![x] = !this.modules[y]![x]!;
      }
    }
  }

  /** The standard four penalty rules, summed. */
  penalty(): number {
    const n = this.size;
    const m = this.modules;
    let total = 0;
    const lines = (get: (a: number, b: number) => boolean): void => {
      for (let a = 0; a < n; a++) {
        let run = 1;
        for (let b = 1; b <= n; b++) {
          if (b < n && get(a, b) === get(a, b - 1)) run++;
          else {
            if (run >= 5) total += 3 + (run - 5);
            run = 1;
          }
        }
        // finder-like 1:1:3:1:1 beside four light modules
        for (let b = 0; b + 11 <= n; b++) {
          const pattern = (p: readonly number[]): boolean => p.every((v, k) => get(a, b + k) === (v === 1));
          if (pattern([1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]) || pattern([0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1])) total += 40;
        }
      }
    };
    lines((y, x) => m[y]![x]!);
    lines((x, y) => m[y]![x]!);
    let dark = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (m[y]![x]) dark++;
        if (x + 1 < n && y + 1 < n && m[y]![x] === m[y]![x + 1] && m[y]![x] === m[y + 1]![x] && m[y]![x] === m[y + 1]![x + 1]) total += 3;
      }
    }
    total += (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
    return total;
  }
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** The UTF-8 of `text`; a lone surrogate is refused (it has no UTF-8). */
function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xd800 && c <= 0xdfff) throw new RangeError("the text has a lone surrogate");
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** The QR code for `text`, or a RangeError when it is longer than the largest code holds (2,953 bytes). */
export function qrEncode(text: string): QrCode {
  const bytes = utf8(text);
  let version = MIN_VERSION;
  while (version <= MAX_VERSION && bytes.length > qrCapacity(version)) version++;
  if (version > MAX_VERSION) throw new RangeError("the text is too long for a QR code");
  const bits: number[] = [];
  const push = (value: number, count: number): void => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacityBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < dataCodewords(version); pad ^= 0xec ^ 0x11) data.push(pad);

  // Blocks, each with its error correction, interleaved.
  const numBlocks = BLOCKS[version]!;
  const eccLen = ECC_PER_BLOCK[version]!;
  const raw = Math.floor(rawDataModules(version) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const blocks: number[][] = [];
  const divisor = rsDivisor(eccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) all.push(block[i]!);
    });
  }

  let best: Grid | undefined;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = new Grid(version);
    g.drawCodewords(all);
    g.applyMask(mask);
    g.formatBits(mask);
    const p = g.penalty();
    if (p < bestPenalty) {
      best = g;
      bestPenalty = p;
    }
  }
  const grid = best!;
  return {
    size: grid.size,
    version,
    dark: (x, y) => x >= 0 && y >= 0 && x < grid.size && y < grid.size && grid.modules[y]![x]!,
  };
}

/** An SVG path (`d`) drawing the dark modules as 1 × 1 squares from (0, 0), each row's runs joined, plus a quiet zone of `border`
 *  modules around it in the view box: `viewBox="0 0 {size + 2 × border} {size + 2 × border}"`, the path moved by the border. */
export function qrPath(code: QrCode, border = 4): { viewBox: string; d: string } {
  const parts: string[] = [];
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.dark(x, y)) continue;
      let run = 1;
      while (x + run < code.size && code.dark(x + run, y)) run++;
      parts.push(`M${x + border},${y + border}h${run}v1h-${run}z`);
      x += run;
    }
  }
  const side = code.size + border * 2;
  return { viewBox: `0 0 ${side} ${side}`, d: parts.join("") };
}
