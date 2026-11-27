// `device.programKey.set` (lane RT, spec revision 19 ruling C): one answer key per (device, program), the program being
// the calling connection's (`MossConn.program`: its signed identity on macOS, its surface elsewhere), never a word in
// the call. The first key of a program, and the same key again, apply at once. Another key in place of a held one is a
// sensitive change, as replacing the device's single key is (`device.answerKey.set`): it takes the held key's
// hand-over (`programAnswerKeyRotateStatement`, checked before any card shows) and the user's yes on a sealed change card
// bound to exactly that hand-over, and the key changes only on that yes (`ProgramKeyTable.replace`, which checks again).
// As for the single key, this device's own signed answer never approves its own key's replacement.
import { createHash } from "node:crypto";
import { ERR, MOSS_ERR, SURFACES_METHODS, type ChangeResult, type Program } from "@waifucave/moss-protocol";
import { answerKeyFingerprint } from "../approvals/answer-key-rotation";
import { boundCardRecord, callBindingOf, type ApprovalBroker, type CallRequestBinding } from "../contracts/approval-broker";
import { isContractError } from "../contracts/common";
import { answerKeyWords } from "../identity/sas";
import { MossRpcError, type MossHandler } from "../ipc/moss";
import type { ProgramKeyHandOver, ProgramKeyInput, ProgramKeyTable } from "./program-keys";

/** The call the card binds; a binding only, never a method on the wire. */
export const PROGRAM_KEY_ROTATE = "device.programKey.rotate";

const NAMES: Record<Program, string> = { moss: "MOSS", code: "MOSS Code", host: "MOSS's background helper" };

export interface ProgramKeyMethodsDeps {
  table: () => ProgramKeyTable | undefined;
  /** This computer's device id. */
  device: () => string;
  /** The broker and this computer's name, for a replacement's card; undefined until the approvals run. */
  rotation: () => { broker: Pick<ApprovalBroker, "request" | "get" | "watch">; computer: string } | undefined;
  /** Lane XC, xc-6b: whether an UNSIGNED press in a sealed frame proves the person, for a lost key's card. True only
   *  where the `app` role is checked by its signature (macOS, the program from the signed identity); on Linux and
   *  Windows any process running as the person can claim the role and press, so there only a device's own key counts. */
  sealedPressProvesPerson?: () => boolean;
  /** Lane XC, xc-6b: whether any of the person's devices other than `program` on this one can sign an answer (a paired
   *  phone's key, MOSS Code's key here, another computer's app): the lost-key card can then be answered. */
  otherSigners?: (program: Program) => boolean;
  log?: (line: string) => void;
}

/** The binding of a lost key's card: a binding only, never a method on the wire (xc-6b). */
export const PROGRAM_KEY_LOST = "device.programKey.lost";

/** What MOSS shows while its key waits on the lost-key card (apps/moss answer-key.ts says it). */
export function lostKeyWaitingWords(program: Program): string {
  return `${NAMES[program]} can't confirm your answers on this computer: its key was lost or changed. Approve the card on another of your devices, or run \`moss device key reset ${program}\` in a terminal.`;
}

const REFUSED: Record<string, string> = {
  "no-current-key": "this program holds no answer key yet",
  "same-key": "that is the key this program holds",
  "not-current": "the hand-over isn't from the key this program holds",
  stale: "the hand-over is too old: sign a new one",
  "bad-signature": "the hand-over doesn't verify",
};

export function programKeyMethods(deps: ProgramKeyMethodsDeps): Record<string, MossHandler> {
  let rotating: AbortController | undefined;
  /** Each program's new key waiting on its lost-key card here (one per program; a newer key withdraws it). */
  const lost = new Map<Program, { input: ProgramKeyInput; ctl: AbortController; card?: string }>();

  /** The OK-only notice after the person's terminal took a new key (kept until seen, as the terminal-change cards are). */
  const notice = (program: Program, input: ProgramKeyInput) => {
    const asked = deps.rotation();
    if (asked === undefined) return;
    void asked.broker.request({
      kind: "change", change: "answer-key-lost", origin: "user", computers: [asked.computer], effect: "other", waitsForUser: true,
      fields: {
        title: { type: "text", text: `${NAMES[program]}'s new key was accepted from your terminal` },
        what: { type: "text", text: `Your terminal let ${NAMES[program]} register a new answer key on this computer. If you didn't run moss device key reset here, remove this computer from your devices on another one.` },
        detail: { type: "rows", rows: [{ label: "Computer", value: asked.computer, name: true }, { label: "New key", value: answerKeyWords(input.publicKey).join(" ") }] },
      },
      options: [{ id: "ok", kind: "approve", label: "OK" }],
    } as Parameters<typeof asked.broker.request>[0]).catch(() => undefined);
  };

  /** A new key for a program whose held key can't hand it over (lost): one card on this computer, answered by another
   *  of the person's devices' own keys (a phone, MOSS Code's key here, another computer's app), or, where the `app` role
   *  is signature-checked (macOS), by a press in the signed app's sealed frame. Never by the new key itself, which isn't
   *  held, so no signature of it verifies. The key changes only on that yes (`adoptLost`). */
  const askLost = (program: Program, input: ProgramKeyInput): Promise<ChangeResult> => {
    const waiting = lost.get(program);
    if (waiting !== undefined && waiting.input.publicKey === input.publicKey && waiting.card !== undefined) return Promise.resolve({ applied: false, card: waiting.card });
    const asked = deps.rotation();
    if (asked === undefined) throw new MossRpcError(ERR.RETRY, "a new answer key takes the approvals, which aren't running on this computer yet: try again in a moment");
    waiting?.ctl.abort();
    const ctl = new AbortController();
    const entry: { input: ProgramKeyInput; ctl: AbortController; card?: string } = { input, ctl };
    lost.set(program, entry);
    const binds: CallRequestBinding = {
      computer: asked.computer, method: PROGRAM_KEY_LOST,
      params: { device: input.device, program, to: input.publicKey, toAlg: input.alg ?? "ed25519", held: input.held },
    };
    const sealed = callBindingOf(binds, (text) => createHash("sha256").update(text).digest("hex"));
    return new Promise<ChangeResult>((resolve, reject) => {
      const off = asked.broker.watch((e) => {
        if (e.type !== "requested" || e.card.binds?.method !== sealed.method || e.card.binds.params !== sealed.params) return;
        off();
        entry.card = e.card.id;
        resolve({ applied: false, card: e.card.id });
      });
      const decision = asked.broker.request({
        kind: "change", change: "answer-key-lost", origin: "user", computers: [asked.computer], effect: "other", binds, waitsForUser: true,
        fields: {
          title: { type: "text", text: `Accept ${NAMES[program]}'s new key on this computer?` },
          what: { type: "text", text: `${NAMES[program]} on this computer has a new answer key. Approve only if you reinstalled ${NAMES[program]} or cleared its data here.` },
          detail: { type: "rows", rows: [{ label: "Computer", value: asked.computer, name: true }, { label: "New key", value: answerKeyWords(input.publicKey).join(" ") }] },
        },
        options: [{ id: "approve", kind: "approve", label: "Accept the new key" }, { id: "deny", kind: "deny", label: "Keep the old key" }],
      } as Parameters<typeof asked.broker.request>[0], { signal: ctl.signal });
      decision.then(async (d) => {
        off();
        reject(new MossRpcError(ERR.RETRY, "the new key's card couldn't be shown: try again"));
        if (lost.get(program) === entry) lost.delete(program);
        if (!d.allowed || d.by !== "card") return;
        // Who said yes: another device's own key, or another program's key here (never the asking program's own); an
        // unsigned press only where the app role is checked (macOS by its signature, Linux and Windows by its image).
        const s = d.signed;
        const ok = s !== undefined ? !(s.device === input.device && (s.program ?? "code") === program) : deps.sealedPressProvesPerson?.() === true;
        if (!ok) {
          deps.log?.(`[surfaces] ${program}'s new key wasn't taken: the yes on its card can't stand for the person here`);
          return;
        }
        await table().adoptLost(input).catch((err: unknown) => deps.log?.(`[surfaces] ${program}'s new key wasn't taken after its card (${err instanceof Error ? err.message.slice(0, 120) : "refused"})`));
      }, (err: unknown) => {
        off();
        if (lost.get(program) === entry) lost.delete(program);
        reject(err);
      });
    });
  };
  const table = () => {
    const t = deps.table();
    if (t === undefined) throw new MossRpcError(ERR.RETRY, "this computer's answer keys aren't open yet: try again in a moment");
    return t;
  };

  return {
    [SURFACES_METHODS.deviceProgramKeyReset.name]: async (conn, params) => {
      if (conn.role !== "cli") throw new MossRpcError(MOSS_ERR.NOT_THE_USER, "only the person's own terminal resets a program's answer key");
      const program = (params as { program: Program }).program;
      const t = table();
      const device = deps.device();
      if (program === "code" && t.codeIsSingleKey(device)) throw new MossRpcError(ERR.INVALID_REQUEST, "MOSS Code's key is this desktop's single answer key: device.answerKey.set replaces it", { code: "single-key" });
      if (t.keyOf(device, program) === undefined) return { none: true };
      const waiting = lost.get(program);
      // Where the card can be answered (the checked app's own press: every OS's daemon, by its signature or its image;
      // anywhere: another device's own key), the terminal sends the person to it.
      const answerable = deps.sealedPressProvesPerson?.() === true || deps.otherSigners?.(program) === true;
      if (waiting !== undefined && answerable) return waiting.card === undefined ? {} : { card: waiting.card };
      if (waiting !== undefined) {
        // A daemon whose app role isn't checked at all (`appPeer: "none"`), and nothing else of the person's can answer
        // the card: the terminal takes the waiting key itself, and the card becomes a notice. This rests on the CLI
        // caller check alone (the person's own terminal: outside the sandbox, not under a process the daemon started),
        // no weaker than an unchecked app role, whose first key proves only "a process running as you".
        waiting.ctl.abort();
        lost.delete(program);
        await t.adoptLost(waiting.input);
        notice(program, waiting.input);
        return { accepted: true };
      }
      // Nothing waiting yet: where the card can be answered (macOS, or another device's key), the program's next try
      // raises it, and the terminal opens nothing. Only where nothing else could answer does the reset open (10 minutes,
      // once), resting on the CLI caller check alone (as above).
      if (answerable) return {};
      t.openReset(device, program);
      return { opened: true };
    },
    [SURFACES_METHODS.deviceProgramKeySet.name]: async (conn, params): Promise<ChangeResult> => {
      const program = conn.program;
      if (conn.role !== "app" || program === undefined) throw new MossRpcError(MOSS_ERR.NOT_THE_USER, "only a program of this desktop holds its answer key");
      const table = deps.table();
      if (table === undefined) throw new MossRpcError(ERR.RETRY, "this computer's answer keys aren't open yet: try again in a moment");
      const p = params as { publicKey: string; held: ProgramKeyInput["held"]; alg?: ProgramKeyInput["alg"]; signature: string; rotation?: ProgramKeyHandOver };
      const input: ProgramKeyInput = { device: deps.device(), program, publicKey: p.publicKey, held: p.held, ...(p.alg !== undefined ? { alg: p.alg } : {}), signature: p.signature };
      let r;
      try {
        r = await table.register(input);
      } catch (err) {
        if (isContractError(err)) throw new MossRpcError(ERR.INVALID_PARAMS, err.message);
        throw err;
      }
      if (r.applied) {
        // Taken in place of a lost key by the person's terminal reset: an OK-only notice says so (xc-6b).
        if (r.reset === true) {
          const waiting = lost.get(program);
          if (waiting !== undefined) { waiting.ctl.abort(); lost.delete(program); }
          notice(program, input);
        }
        return { applied: true };
      }
      // MOSS Code's key is the device's single key: its own door replaces it (a card here could only be approved for nothing).
      if (program === "code" && table.codeIsSingleKey(input.device)) throw new MossRpcError(ERR.INVALID_REQUEST, "MOSS Code's key is this desktop's single answer key: device.answerKey.set replaces it", { code: "single-key" });
      // No hand-over: the held key was lost (xc-6b). The person decides on this computer's card; the new key never
      // vouches for itself.
      if (!p.rotation) return askLost(program, input);
      const why = await table.checkHandOver(input, p.rotation);
      if (why !== "ok") throw new MossRpcError(ERR.INVALID_REQUEST, REFUSED[why] ?? "refused", { code: why });
      const asked = deps.rotation();
      if (asked === undefined) throw new MossRpcError(ERR.RETRY, "replacing an answer key takes the approvals, which aren't running on this computer yet: try again in a moment");
      // One replacement at a time: this one's card withdraws the one before.
      rotating?.abort();
      const ctl = new AbortController();
      rotating = ctl;
      const held = table.keyOf(input.device, program)!;
      const binds: CallRequestBinding = {
        computer: asked.computer, method: PROGRAM_KEY_ROTATE,
        params: { device: input.device, program, from: held.publicKey, fromAlg: held.alg ?? "ed25519", to: input.publicKey, toAlg: input.alg ?? "ed25519", held: input.held, at: p.rotation.at },
      };
      const sealed = callBindingOf(binds, (text) => createHash("sha256").update(text).digest("hex"));
      const handOver = p.rotation;
      return new Promise<ChangeResult>((resolve, reject) => {
        const off = asked.broker.watch((e) => {
          if (e.type !== "requested" || e.card.binds?.method !== sealed.method || e.card.binds.params !== sealed.params) return;
          off();
          resolve({ applied: false, card: e.card.id });
        });
        const decision = asked.broker.request({
          kind: "change", change: "answer-key-rotate", origin: "user", computers: [asked.computer], effect: "other", binds,
          fields: {
            title: { type: "text", text: `Replace ${NAMES[program]}'s answer key` },
            what: { type: "text", text: `Replace the key ${NAMES[program]} answers cards with on this computer? Approve only if you asked for this here.` },
            detail: { type: "rows", rows: [
              { label: "Current key", value: answerKeyFingerprint(held.alg ?? "ed25519", held.publicKey) },
              { label: "New key", value: answerKeyFingerprint(input.alg ?? "ed25519", input.publicKey) },
              { label: "Kept in", value: input.held },
            ] },
          },
          options: [{ id: "approve", kind: "approve", label: "Replace the key" }, { id: "deny", kind: "deny", label: "Keep the current key" }],
        }, { signal: ctl.signal });
        decision.then(async (d) => {
          off();
          // Settled with no card shown (the approvals stopped): the call says so; after a card, this changes nothing.
          reject(new MossRpcError(ERR.RETRY, "the replacement's card couldn't be shown: try again"));
          if (rotating === ctl) rotating = undefined;
          const record = boundCardRecord(asked.broker, d);
          // Approved, and not by this device's own signed answer (the key being replaced can't vouch for its replacement).
          if (!record || record.card.change !== "answer-key-rotate" || record.device === input.device) return;
          await table.replace(input, handOver).catch((err: unknown) => deps.log?.(`[surfaces] ${program}'s answer key wasn't replaced after its card (${err instanceof Error ? err.message.slice(0, 120) : "refused"})`));
        }, (err: unknown) => {
          off();
          reject(err);
        });
      });
    },
  };
}
