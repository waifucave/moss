// The files a person drops or picks for a bot (`user.send`'s `files`, spec §6 and §8.5: "other attachments stay where they are
// and are passed as folder-tree paths"). Owner: lane DU2. Each file becomes a `[File #n]` of the message with its folder-tree
// path (`home/<Computer>/…`), which the bot's turn names for it (`formatTurnInput`) and its file tools open.
//
//  - A file under the user's home folder stays where it is: the engine reads nothing of it, it only looks (size, kind).
//  - A file the tree doesn't name (outside the user's home: a USB stick, /tmp) is copied, once, into the bot's scratch folder
//    (`<home>/scratch/<bot>/attachments/`, §6.5 "scratch ... is never synced"), and the copy is named.
//  - Refused, in a plain sentence the window shows as it is (`file_reference_invalid`): more than `BOT_FILES_MAX`, a folder or
//    anything not a regular file, a file over `BOT_FILE_MAX_BYTES`, a file that can't be read, a file inside MOSS's own
//    folder (its settings, secrets and logs are the core's, and a copy would hand them to the bot past the fence).
// The path is the user's own pick: the protocol lets only the app's main process call `user.send`, as the user.
import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { BOT_FILE_MAX_BYTES, BOT_FILES_MAX, ERR, FILE_REFERENCE_INVALID, type UserMessageInput } from "@waifucave/moss-protocol";
import { MethodError } from "../rpc/handler";
import { botPaths, homeTreePath } from "../bots/paths";
import { sessionFileStem } from "../sessions/ids";

export interface AttachFilesDeps {
  /** MOSS's home (the engine's folder): nothing in it is attached. */
  home: string;
  /** The user's home folder, which the tree's `home/<Computer>/` is. */
  userHome: string;
  /** This computer's name in the tree. */
  computer: string;
}

const refuse = (why: string): MethodError => new MethodError(ERR.INVALID_PARAMS, why, { code: FILE_REFERENCE_INVALID });

/** A file name as the user would read it, for a refusal. */
const shown = (path: string): string => `“${basename(path).replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").slice(0, 80)}”`;

const MB = 1024 * 1024;

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The `files` of a message to `bot`, with each one's `n` (1-based, in the order given). Throws a `MethodError` with a plain
 *  sentence; nothing is copied for a message any of whose files is refused. */
export async function attachFilesForBot(deps: AttachFilesDeps, o: { bot: string; clientMessageId: string; files: readonly { path: string }[] }): Promise<NonNullable<UserMessageInput["files"]>> {
  if (o.files.length > BOT_FILES_MAX) throw refuse(`A message can carry at most ${BOT_FILES_MAX} files; you picked ${o.files.length}.`);
  const resolve = (path: string): string => {
    try {
      return realpathSync.native(path);
    } catch {
      return path;
    }
  };
  const mossHome = resolve(deps.home);
  const userHome = resolve(deps.userHome);
  // Look at every file first (the whole message is refused or none of it is kept), then copy the ones the tree can't name.
  const looked: { path: string; size: number }[] = [];
  for (const f of o.files) {
    if (!isAbsolute(f.path) || /[\p{Cc}\u2028\u2029]/u.test(f.path)) throw refuse(`${shown(f.path)} isn't a file path MOSS can use.`);
    let path: string;
    let size: number;
    try {
      // The real file (a link is followed, so the checks below judge where it leads, never the link's own spelling).
      path = realpathSync.native(f.path);
      const h = await open(path, "r");
      try {
        const st = await h.stat();
        if (!st.isFile()) throw refuse(`${shown(f.path)} is a folder or not an ordinary file: only files can be attached.`);
        size = st.size;
      } finally {
        await h.close();
      }
    } catch (err) {
      if (err instanceof MethodError) throw err;
      throw refuse(`${shown(f.path)} can't be read: it may have moved, or MOSS may not be allowed to open it.`);
    }
    if (inside(mossHome, path)) throw refuse(`${shown(f.path)} is inside MOSS's own folder, which isn't shared with bots.`);
    if (size > BOT_FILE_MAX_BYTES) throw refuse(`${shown(f.path)} is ${Math.ceil(size / MB)} MB: a file can be at most ${BOT_FILE_MAX_BYTES / MB} MB.`);
    looked.push({ path, size });
  }
  const out: { n: number; path: string }[] = [];
  const made: string[] = [];
  try {
    for (const [i, f] of looked.entries()) {
      const n = i + 1;
      const named = inside(userHome, f.path) ? homeTreePath({ userHome, computer: deps.computer, dir: f.path }) : undefined;
      if (named !== undefined) {
        out.push({ n, path: named });
        continue;
      }
      // Not in the tree: a copy in the bot's scratch folder, one folder per message so two files of one name don't meet.
      const dir = join(botPaths(mossHome, o.bot).scratch, "attachments", sessionFileStem(o.clientMessageId));
      const safeName = basename(f.path).replace(/[\p{Cc}\p{Cf}\u2028\u2029/\\:*?"<>|]+/gu, "_").slice(0, 120) || "file";
      const dest = join(dir, `${n}-${safeName}`);
      const tree = homeTreePath({ userHome, computer: deps.computer, dir: dest });
      if (tree === undefined) throw refuse(`${shown(f.path)} is outside your home folder, and the bot can't reach it from there.`);
      await mkdir(dir, { recursive: true });
      made.push(dir);
      await copyBounded(f.path, dest, BOT_FILE_MAX_BYTES);
      out.push({ n, path: tree });
    }
  } catch (err) {
    for (const dir of made) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (err instanceof MethodError) throw err;
    throw refuse(`A file couldn't be copied for the bot: ${err instanceof Error && err.message === "too-big" ? `it grew past ${BOT_FILE_MAX_BYTES / MB} MB.` : "it may have moved."}`);
  }
  return out;
}

/** Copies `from` to `to`, never more than `max` bytes (a file that grows while it is copied is cut off and refused). */
async function copyBounded(from: string, to: string, max: number): Promise<void> {
  let seen = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      cb(seen > max ? new Error("too-big") : null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(from), cap, createWriteStream(to, { flags: "wx", mode: 0o600 }));
  } catch (err) {
    await rm(to, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** The text with a `[File #n]` for each file it doesn't name yet (as `withImageMarks`). */
export function withFileMarks(text: string, count: number): string {
  let out = text;
  for (let n = 1; n <= count; n++) if (!out.includes(`[File #${n}]`)) out = `${out}${out.length > 0 && !/\s$/.test(out) ? " " : ""}[File #${n}]`;
  return out;
}
