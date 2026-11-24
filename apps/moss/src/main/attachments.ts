// What the person picked or dropped for the composer, kept by main until it is sent, removed or its composer goes away (the window
// holds only names and ids, never a path or bytes). Pure file reads: no Electron here, so it is tested on its own.
//
//  - A PNG, JPEG or WebP up to 10 MB goes as a picture; any other file, and a picture over 10 MB, goes as a file for the engine to
//    carry (`user.send`'s `files`). A picture that falls to a file for its size comes back with a plain `note`.
//  - An id leaves when the window says so (`release`: a chip's x, or its composer going away), when a send takes it, or, as a floor
//    that never refuses, when the store is over its bound: the OLDEST goes (the window's own bounds, 4 pictures and 10 files in a
//    message, are lower than the store's, so a floor eviction only ever drops what the window already forgot).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";

export type PickedImage = { name: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string };
export type PickedFile = { name: string; path: string };
export interface Taken { id: string; name: string; kind: "image" | "file"; note?: string }

/** The store's bounds: twice what one message may carry (the window caps a message at 4 pictures and 10 files). */
export const STORE_IMAGES_MAX = 8;
export const STORE_FILES_MAX = 20;
export const PICTURE_MAX_BYTES = 10 * 1024 * 1024;

export class PickedAttachments {
  readonly images = new Map<string, PickedImage>();
  readonly files = new Map<string, PickedFile>();

  /** One path the person chose. `undefined` only for a path that isn't an absolute one. */
  take(path: string): Taken | undefined {
    if (!isAbsolute(path) || path.length > 4096) return undefined;
    const name = basename(path);
    const ext = extname(path).toLowerCase();
    const mediaType = ext === ".png" ? "image/png" as const : ext === ".webp" ? "image/webp" as const : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" as const : undefined;
    const id = randomUUID();
    let note: string | undefined;
    if (mediaType !== undefined) {
      let bytes: Buffer | undefined;
      try { bytes = readFileSync(path); } catch { bytes = undefined; }
      if (bytes !== undefined && bytes.length <= PICTURE_MAX_BYTES) {
        this.images.set(id, { name, mediaType, data: bytes.toString("base64") });
        while (this.images.size > STORE_IMAGES_MAX) this.images.delete(this.images.keys().next().value!);
        return { id, name, kind: "image" };
      }
      if (bytes !== undefined) note = `“${name}” is over 10 MB, so it goes as a file, not as a picture.`;
    }
    this.files.set(id, { name, path });
    while (this.files.size > STORE_FILES_MAX) this.files.delete(this.files.keys().next().value!);
    return { id, name, kind: "file", ...(note === undefined ? {} : { note }) };
  }

  /** The window dropped these ids (a chip's x, or its composer going away). */
  release(ids: readonly string[]): void {
    for (const id of ids) {
      this.images.delete(id);
      this.files.delete(id);
    }
  }
}
