// A small, bounded D-Bus wire codec (the D-Bus specification's "Message Protocol"), for the Linux credential broker
// (`linux-secret-broker.ts`, docs/linux-credential-broker.md): it reads what a fenced command sends, which is hostile
// input, and it speaks to the user's real session bus as a client. Every read is bounded: the message's size, the
// signature's length, nesting, and each array against what is left of the message. Anything malformed throws a
// `WireError`; the broker drops that connection. Writes are always little-endian.

export class WireError extends Error {}

/** The largest message either side accepts (the spec allows 128 MiB; nothing the broker serves comes close). */
export const MAX_MESSAGE = 1024 * 1024;
/** How deep containers nest (the spec's own limits are 32 arrays and 32 structs). */
export const MAX_DEPTH = 64;
/** How many values one message may decode to (an `av` of a megabyte is hundreds of thousands of objects). */
export const MAX_VALUES = 1_000_000;

export class Variant {
  constructor(readonly sig: string, readonly value: DValue) {}
}
/** A decoded value: numbers for the integer types up to 32 bits and `d`, bigint for `x` and `t`, a string for `s`,
 *  `o` and `g`, an array for an array or a struct, a two-element array for a dict entry, a `Variant` for `v`. */
export type DValue = number | bigint | boolean | string | Variant | DValue[];

export const MessageType = { Call: 1, Return: 2, Error: 3, Signal: 4 } as const;
export const Flag = { NoReply: 1, NoAutoStart: 2 } as const;

export interface Message {
  type: number;
  flags: number;
  serial: number;
  path?: string;
  iface?: string;
  member?: string;
  error?: string;
  replySerial?: number;
  dest?: string;
  sender?: string;
  signature: string;
  body: DValue[];
  /** Set only when a message declared descriptors (the broker refuses those). */
  unixFds?: number;
}

const ALIGN: Record<string, number> = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, h: 4, s: 4, o: 4, g: 1, v: 1, a: 4, "(": 8, "{": 8 };

/** Splits a signature into its complete types; throws on anything that isn't one. */
export function splitSignature(sig: string): string[] {
  if (sig.length > 255) throw new WireError("signature too long");
  const out: string[] = [];
  let i = 0;
  while (i < sig.length) {
    const end = completeType(sig, i, 0, 0);
    out.push(sig.slice(i, end));
    i = end;
  }
  return out;
}

function completeType(sig: string, i: number, arrays: number, structs: number): number {
  const c = sig[i];
  if (c === undefined) throw new WireError("signature ends early");
  if ("ybnqiuxtdhsogv".includes(c)) return i + 1;
  if (c === "a") {
    if (arrays >= 32) throw new WireError("arrays nest too deep");
    if (sig[i + 1] === "{") {
      const k = sig[i + 2];
      if (k === undefined || !"ybnqiuxtdhsog".includes(k)) throw new WireError("bad dict key");
      const v = completeType(sig, i + 3, arrays + 1, structs + 1);
      if (sig[v] !== "}") throw new WireError("bad dict entry");
      return v + 1;
    }
    return completeType(sig, i + 1, arrays + 1, structs);
  }
  if (c === "(") {
    if (structs >= 32) throw new WireError("structs nest too deep");
    let j = i + 1;
    if (sig[j] === ")") throw new WireError("empty struct");
    while (sig[j] !== ")") {
      if (j >= sig.length) throw new WireError("unclosed struct");
      j = completeType(sig, j, arrays, structs + 1);
    }
    return j + 1;
  }
  throw new WireError(`bad type code ${JSON.stringify(c)}`);
}

const OBJECT_PATH = /^\/$|^(\/[A-Za-z0-9_]+)+$/;
export const isObjectPath = (p: string): boolean => OBJECT_PATH.test(p);

class Reader {
  off = 0;
  depth = 0;
  values = 0;
  constructor(readonly buf: Buffer, readonly le: boolean, readonly end: number, readonly base = 0, readonly maxValues = MAX_VALUES) {}
  need(n: number): void { if (this.off + n > this.end) throw new WireError("message ends early"); }
  align(n: number): void {
    const pad = (n - ((this.off - this.base) % n)) % n;
    this.need(pad);
    for (let k = 0; k < pad; k++) if (this.buf[this.off + k] !== 0) throw new WireError("non-zero padding");
    this.off += pad;
  }
  u8(): number { this.need(1); return this.buf[this.off++]!; }
  u32(): number { this.align(4); this.need(4); const v = this.le ? this.buf.readUInt32LE(this.off) : this.buf.readUInt32BE(this.off); this.off += 4; return v; }
  str(len: number): string {
    this.need(len + 1);
    const bytes = this.buf.subarray(this.off, this.off + len);
    if (this.buf[this.off + len] !== 0 || bytes.includes(0)) throw new WireError("bad string");
    const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    this.off += len + 1;
    return s;
  }
  value(t: string): DValue {
    if (++this.values > this.maxValues) throw new WireError("too many values in one message");
    const c = t[0]!;
    const le = this.le;
    switch (c) {
      case "y": return this.u8();
      case "b": { const v = this.u32(); if (v > 1) throw new WireError("bad boolean"); return v === 1; }
      case "n": { this.align(2); this.need(2); const v = le ? this.buf.readInt16LE(this.off) : this.buf.readInt16BE(this.off); this.off += 2; return v; }
      case "q": { this.align(2); this.need(2); const v = le ? this.buf.readUInt16LE(this.off) : this.buf.readUInt16BE(this.off); this.off += 2; return v; }
      case "i": { this.align(4); this.need(4); const v = le ? this.buf.readInt32LE(this.off) : this.buf.readInt32BE(this.off); this.off += 4; return v; }
      case "u": case "h": return this.u32();
      case "x": { this.align(8); this.need(8); const v = le ? this.buf.readBigInt64LE(this.off) : this.buf.readBigInt64BE(this.off); this.off += 8; return v; }
      case "t": { this.align(8); this.need(8); const v = le ? this.buf.readBigUInt64LE(this.off) : this.buf.readBigUInt64BE(this.off); this.off += 8; return v; }
      case "d": { this.align(8); this.need(8); const v = le ? this.buf.readDoubleLE(this.off) : this.buf.readDoubleBE(this.off); this.off += 8; return v; }
      case "s": return this.str(this.u32());
      case "o": { const s = this.str(this.u32()); if (!isObjectPath(s)) throw new WireError("bad object path"); return s; }
      case "g": { const s = this.str(this.u8()); splitSignature(s); return s; }
      case "v": {
        const sig = this.str(this.u8());
        const types = splitSignature(sig);
        if (types.length !== 1) throw new WireError("a variant holds one type");
        return new Variant(sig, this.nested(() => this.value(sig)));
      }
      case "a": {
        const len = this.u32();
        const elem = t.slice(1);
        this.align(ALIGN[elem[0]!]!);
        if (len > this.end - this.off) throw new WireError("array longer than the message");
        const stop = this.off + len;
        const out: DValue[] = [];
        this.nested(() => {
          while (this.off < stop) out.push(elem[0] === "{" ? this.entry(elem) : this.value(elem));
        });
        if (this.off !== stop) throw new WireError("array overruns its length");
        return out;
      }
      case "(": {
        this.align(8);
        const inner = splitSignature(t.slice(1, -1));
        return this.nested(() => inner.map((x) => this.value(x)));
      }
      default: throw new WireError(`bad type ${c}`);
    }
  }
  entry(t: string): DValue[] {
    this.align(8);
    const inner = t.slice(1, -1);
    const k = inner[0]!;
    return this.nested(() => [this.value(k), this.value(inner.slice(1))]);
  }
  nested<T>(f: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new WireError("nested too deep");
    try { return f(); } finally { this.depth--; }
  }
}

class Writer {
  parts: number[] = [];
  buf = Buffer.alloc(256);
  len = 0;
  ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const b = Buffer.alloc(size);
    this.buf.copy(b, 0, 0, this.len);
    this.buf = b;
  }
  align(n: number): void { const pad = (n - (this.len % n)) % n; this.ensure(pad); this.buf.fill(0, this.len, this.len + pad); this.len += pad; }
  u8(v: number): void { this.ensure(1); this.buf[this.len++] = v & 0xff; }
  u32(v: number): void { this.align(4); this.ensure(4); this.buf.writeUInt32LE(v >>> 0, this.len); this.len += 4; }
  str(s: string, short = false): void {
    const b = Buffer.from(s, "utf8");
    if (short) this.u8(b.length); else this.u32(b.length);
    this.ensure(b.length + 1);
    b.copy(this.buf, this.len);
    this.len += b.length;
    this.buf[this.len++] = 0;
  }
  value(t: string, v: DValue): void {
    const c = t[0]!;
    const num = (): number => { if (typeof v !== "number") throw new WireError(`expected a number for ${c}`); return v; };
    switch (c) {
      case "y": this.u8(num()); return;
      case "b": this.u32(v === true ? 1 : 0); return;
      case "n": this.align(2); this.ensure(2); this.buf.writeInt16LE(num(), this.len); this.len += 2; return;
      case "q": this.align(2); this.ensure(2); this.buf.writeUInt16LE(num(), this.len); this.len += 2; return;
      case "i": this.align(4); this.ensure(4); this.buf.writeInt32LE(num(), this.len); this.len += 4; return;
      case "u": case "h": this.u32(num()); return;
      case "x": this.align(8); this.ensure(8); this.buf.writeBigInt64LE(BigInt(v as bigint | number), this.len); this.len += 8; return;
      case "t": this.align(8); this.ensure(8); this.buf.writeBigUInt64LE(BigInt(v as bigint | number), this.len); this.len += 8; return;
      case "d": this.align(8); this.ensure(8); this.buf.writeDoubleLE(num(), this.len); this.len += 8; return;
      case "s": case "o": if (typeof v !== "string") throw new WireError("expected a string"); this.str(v); return;
      case "g": if (typeof v !== "string") throw new WireError("expected a signature"); this.str(v, true); return;
      case "v": {
        if (!(v instanceof Variant)) throw new WireError("expected a variant");
        this.str(v.sig, true);
        this.value(v.sig, v.value);
        return;
      }
      case "a": {
        if (!Array.isArray(v)) throw new WireError("expected an array");
        const elem = t.slice(1);
        this.u32(0);
        const at = this.len - 4;
        this.align(ALIGN[elem[0]!]!);
        const start = this.len;
        for (const e of v) {
          if (elem[0] === "{") {
            if (!Array.isArray(e) || e.length !== 2) throw new WireError("expected a dict entry");
            this.align(8);
            const inner = elem.slice(1, -1);
            this.value(inner[0]!, e[0]!);
            this.value(inner.slice(1), e[1]!);
          } else this.value(elem, e);
        }
        this.buf.writeUInt32LE(this.len - start, at);
        return;
      }
      case "(": {
        if (!Array.isArray(v)) throw new WireError("expected a struct");
        const inner = splitSignature(t.slice(1, -1));
        if (inner.length !== v.length) throw new WireError("struct arity");
        this.align(8);
        inner.forEach((x, k) => this.value(x, v[k]!));
        return;
      }
      default: throw new WireError(`bad type ${c}`);
    }
  }
  done(): Buffer { return this.buf.subarray(0, this.len); }
}

/** Marshals values of a signature (little-endian), as a body starting at an 8-aligned offset. */
export function marshalBody(signature: string, body: readonly DValue[]): Buffer {
  const types = splitSignature(signature);
  if (types.length !== body.length) throw new WireError("body arity");
  const w = new Writer();
  types.forEach((t, k) => w.value(t, body[k]!));
  return w.done();
}

/** Encodes a whole message, little-endian. */
export function encodeMessage(m: Message): Buffer {
  const body = marshalBody(m.signature, m.body);
  const fields: DValue[] = [];
  const add = (code: number, sig: string, v: DValue | undefined) => { if (v !== undefined) fields.push([code, new Variant(sig, v)]); };
  add(1, "o", m.path); add(2, "s", m.iface); add(3, "s", m.member); add(4, "s", m.error);
  add(5, "u", m.replySerial); add(6, "s", m.dest); add(7, "s", m.sender);
  if (m.signature !== "") add(8, "g", m.signature);
  add(9, "u", m.unixFds);
  const w = new Writer();
  w.u8(0x6c); w.u8(m.type); w.u8(m.flags); w.u8(1); w.u32(body.length); w.u32(m.serial);
  w.value("a(yv)", fields);
  w.align(8);
  w.ensure(body.length);
  body.copy(w.buf, w.len);
  w.len += body.length;
  return Buffer.from(w.done());
}

/** The full length of the message at the start of `buf`, once its fixed header is there (null before); throws when
 *  the message would pass `max`. */
export function messageLength(buf: Buffer, max = MAX_MESSAGE): number | null {
  if (buf.length < 16) return null;
  const e = buf[0];
  if (e !== 0x6c && e !== 0x42) throw new WireError("bad endianness");
  const le = e === 0x6c;
  if (buf[3] !== 1) throw new WireError("bad protocol version");
  const body = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fields = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  if (body > max || fields > max) throw new WireError("message too big");
  const total = 16 + fields + ((8 - ((16 + fields) % 8)) % 8) + body;
  if (total > max) throw new WireError("message too big");
  return total;
}

/** Decodes one whole message (`messageLength` long); throws on anything malformed or past `maxValues` values. */
export function decodeMessage(buf: Buffer, maxValues = MAX_VALUES): Message {
  const le = buf[0] === 0x6c;
  const r = new Reader(buf, le, buf.length, 0, maxValues);
  r.off = 1;
  const type = r.u8();
  const flags = r.u8();
  r.u8();
  if (type < 1 || type > 4) throw new WireError("bad message type");
  const bodyLen = r.u32();
  const serial = r.u32();
  if (serial === 0) throw new WireError("serial 0");
  const fields = r.value("a(yv)") as DValue[][];
  r.align(8);
  if (r.off + bodyLen !== buf.length) throw new WireError("bad body length");
  const m: Message = { type, flags, serial, signature: "", body: [] };
  const seen = new Set<number>();
  for (const [code, v] of fields as [number, Variant][]) {
    if (seen.has(code)) throw new WireError("a header field twice");
    seen.add(code);
    const want: Record<number, string> = { 1: "o", 2: "s", 3: "s", 4: "s", 5: "u", 6: "s", 7: "s", 8: "g", 9: "u" };
    if (want[code] === undefined) continue; // unknown fields are ignored, as the spec says
    if (v.sig !== want[code]) throw new WireError("a header field of the wrong type");
    const val = v.value;
    switch (code) {
      case 1: m.path = val as string; break;
      case 2: m.iface = val as string; break;
      case 3: m.member = val as string; break;
      case 4: m.error = val as string; break;
      case 5: m.replySerial = val as number; break;
      case 6: m.dest = val as string; break;
      case 7: m.sender = val as string; break;
      case 8: m.signature = val as string; break;
      case 9: m.unixFds = val as number; break;
    }
  }
  if (type === MessageType.Call && (m.path === undefined || m.member === undefined)) throw new WireError("a call needs a path and a member");
  if ((type === MessageType.Return || type === MessageType.Error) && m.replySerial === undefined) throw new WireError("a reply needs its serial");
  const body = new Reader(buf, le, buf.length, r.off, maxValues);
  body.values = r.values;
  body.off = r.off;
  m.body = splitSignature(m.signature).map((t) => body.value(t));
  if (body.off !== buf.length) throw new WireError("body longer than its signature");
  return m;
}

/** A buffer of incoming bytes that yields whole messages; throws on a malformed one, one past `maxMessage` or
 *  `maxValues`, or input past `maxBuffered`. */
export class MessageReader {
  #chunks: Buffer[] = [];
  #size = 0;
  constructor(readonly maxBuffered = 4 * MAX_MESSAGE, readonly maxMessage = MAX_MESSAGE, readonly maxValues = MAX_VALUES) {}
  push(b: Uint8Array): void {
    this.#size += b.length;
    if (this.#size > this.maxBuffered) throw new WireError("too much buffered input");
    this.#chunks.push(Buffer.from(b));
  }
  get buffered(): number { return this.#size; }
  /** The bytes not yet taken, as one buffer (the SASL phase reads lines from it). */
  take(n: number): Buffer {
    const all = Buffer.concat(this.#chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.#chunks = rest.length ? [rest] : [];
    this.#size = rest.length;
    return out;
  }
  peek(): Buffer {
    if (this.#chunks.length > 1) this.#chunks = [Buffer.concat(this.#chunks)];
    return this.#chunks[0] ?? Buffer.alloc(0);
  }
  next(): Message | null {
    const head = this.peek();
    const n = messageLength(head, this.maxMessage);
    if (n === null || head.length < n) return null;
    return decodeMessage(Buffer.from(this.take(n)), this.maxValues);
  }
  /** How many whole messages wait in the buffer, read from their headers alone (nothing is decoded); throws on a
   *  header that is bad or past `maxMessage`. */
  whole(): number {
    const b = this.peek();
    let at = 0;
    let n = 0;
    for (;;) {
      const len = messageLength(b.subarray(at), this.maxMessage);
      if (len === null || b.length - at < len) return n;
      n++;
      at += len;
    }
  }
}
