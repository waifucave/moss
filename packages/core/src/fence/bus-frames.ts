// The frames the sandbox's bus relay (`linux-bus-relay.ts`, inside the fence) and the engine's broker
// (`linux-secret-broker.ts`) carry many connections in over one pair of pipes: `[type u8][connection u32][length u32]`,
// little-endian, then `length` bytes. Both ends treat the other as untrusted: a frame past `MAX_FRAME` or of an unknown
// type ends the whole channel.

export const FrameType = { Open: 1, Data: 2, Close: 3 } as const;
export const MAX_FRAME = 64 * 1024;
const HEAD = 9;

export interface Frame { type: number; conn: number; data: Uint8Array }

export function encodeFrame(type: number, conn: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (data.length > MAX_FRAME) throw new Error("frame too big");
  const b = new Uint8Array(HEAD + data.length);
  const v = new DataView(b.buffer);
  v.setUint8(0, type);
  v.setUint32(1, conn >>> 0, true);
  v.setUint32(5, data.length, true);
  b.set(data, HEAD);
  return b;
}

/** Data split into frames no bigger than `MAX_FRAME`. */
export function dataFrames(conn: number, data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += MAX_FRAME) out.push(encodeFrame(FrameType.Data, conn, data.subarray(i, i + MAX_FRAME)));
  return out;
}

/** Turns a byte stream into frames; throws on a bad frame. */
export class FrameReader {
  #buf = new Uint8Array(0);
  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.#buf.length + chunk.length);
    merged.set(this.#buf, 0);
    merged.set(chunk, this.#buf.length);
    const out: Frame[] = [];
    let at = 0;
    while (merged.length - at >= HEAD) {
      const v = new DataView(merged.buffer, merged.byteOffset + at, HEAD);
      const type = v.getUint8(0);
      const conn = v.getUint32(1, true);
      const len = v.getUint32(5, true);
      if (type < FrameType.Open || type > FrameType.Close) throw new Error("bad frame type");
      if (len > MAX_FRAME) throw new Error("frame too big");
      if (merged.length - at < HEAD + len) break;
      out.push({ type, conn, data: merged.slice(at + HEAD, at + HEAD + len) });
      at += HEAD + len;
    }
    this.#buf = merged.slice(at);
    return out;
  }
}
