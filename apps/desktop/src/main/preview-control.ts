// The live preview's control door (scripts/preview/run.ts --control): ONLY the preview build has it. index.ts imports this module inside
// `typeof __MOSS_PREVIEW_BUILD__ === "string"`, a compile-time mark that is `false` in every other build, so a release or test-marked
// build neither contains this file's code nor reads the two environment names below (scripts/test-build.ts's asar gate looks for both).
//
// What it is: a Unix socket in the preview's own temp folder, and ONE peer on it, the preview command (scripts/preview/run.ts), which
// relays the person-at-the-window's actions for scripts/preview/ctl.ts. It forwards DevTools-protocol commands to the main window's own
// page (webContents.debugger: the app drives and reads its own contents; there is no remote-debugging port, no screen recording and no
// macOS permission) and runs four app-level actions. Rules, each enforced where it is written below:
//   1. The socket's folder is private to this user (mode 0700, owned by it) and the socket itself is mode 0600; a folder that is not is refused.
//   2. Nothing is served before the first line names the token (a random value the command made for this run); a wrong one closes the connection.
//   3. One peer at a time: a second connection while one is open is closed at once.
//   4. A request line is bounded; an oversized one closes the connection.
//   5. It ends with the app (the server dies with the process; the socket file is in the run's own folder, removed with it).
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { nativeTheme, type BrowserWindow } from "electron";
import { MAX_REQUEST_BYTES, PREVIEW_CONTROL_NAME, folderProblem, sameToken } from "./preview-control-rules";

export interface PreviewControl { server: Server; close(): void }

/** The app's own engine connection (the one that reports the window's presence), for the one answer below. */
export interface PreviewEngine { request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> }

export function startPreviewControl(o: { socketPath: string; token: string; window: () => BrowserWindow | undefined; engine: () => PreviewEngine | undefined; headless: boolean; log: (line: string) => void }): PreviewControl | undefined {
  const problem = folderProblem(dirname(o.socketPath));
  if (problem !== undefined) { o.log(`${PREVIEW_CONTROL_NAME}: not serving: ${problem}`); return undefined; }
  if (o.token.length < 32) { o.log(`${PREVIEW_CONTROL_NAME}: not serving: the token is too short`); return undefined; }
  rmSync(o.socketPath, { force: true });
  let peer: Socket | undefined;
  let attached = false;
  const send = (s: Socket, m: unknown): void => { if (!s.destroyed) s.write(`${JSON.stringify(m)}\n`); };

  const onCdpEvent = (_e: unknown, method: string, params: unknown, sessionId?: string): void => {
    if (peer !== undefined) send(peer, { event: { method, params, ...(sessionId !== undefined ? { sessionId } : {}) } });
  };
  const attach = (win: BrowserWindow): void => {
    if (attached) return;
    win.webContents.debugger.attach("1.3");
    win.webContents.debugger.on("message", onCdpEvent as never);
    attached = true;
  };

  const handle = async (s: Socket, req: { id?: number; cdp?: { method?: string; params?: object; sessionId?: string }; app?: string; value?: unknown }): Promise<void> => {
    const id = typeof req.id === "number" ? req.id : 0;
    try {
      const win = o.window();
      if (win === undefined || win.isDestroyed()) throw new Error("the window is not open");
      if (req.cdp !== undefined) {
        if (typeof req.cdp.method !== "string") throw new Error("a protocol command names its method");
        attach(win);
        const result = await win.webContents.debugger.sendCommand(req.cdp.method, req.cdp.params ?? {}, req.cdp.sessionId);
        send(s, { id, result });
      } else if (req.app === "theme") {
        if (req.value !== "light" && req.value !== "dark" && req.value !== "system") throw new Error("a theme is light, dark or system");
        nativeTheme.themeSource = req.value;
        send(s, { id, result: { theme: req.value } });
      } else if (req.app === "size") {
        const v = req.value as { w?: number; h?: number } | undefined;
        if (v === undefined || !Number.isInteger(v.w) || !Number.isInteger(v.h) || v.w! < 320 || v.h! < 240 || v.w! > 8000 || v.h! > 8000) throw new Error("a size is whole pixels, 320x240 to 8000x8000");
        win.setContentSize(v.w!, v.h!);
        send(s, { id, result: { w: v.w, h: v.h } });
      } else if (req.app === "reload") {
        win.webContents.reloadIgnoringCache();
        send(s, { id, result: { reloaded: true } });
      } else if (req.app === "card.answer") {
        // ONE named card, answered the way the window's own sealed button answers (card.frame, then card.answer on the connection that draws it): the engine takes a card placed
        // in a window only from that connection. The command names the card; nothing here lists or sweeps.
        const v = req.value as { id?: unknown; hash?: unknown; option?: unknown } | undefined;
        if (typeof v?.id !== "string" || typeof v.hash !== "string" || typeof v.option !== "string") throw new Error("an answer names the card, its hash and the option");
        const engine = o.engine();
        if (engine === undefined) throw new Error("the app is not connected to its engine");
        const frame = await engine.request<{ channel: string }>("card.frame", { id: v.id }, 15_000);
        const result = await engine.request<{ accepted: boolean; reason?: string }>("card.answer", { id: v.id, hash: v.hash, option: v.option, proof: { via: "sealed-frame", frame: frame.channel, input: "click", at: Date.now() } }, 30_000);
        o.log(`${PREVIEW_CONTROL_NAME}: answered card ${v.id} with ${v.option}: ${result.accepted ? "taken" : "refused"}`);
        send(s, { id, result });
      } else if (req.app === "front") {
        if (o.headless) throw new Error("this preview is headless: it has no window to bring forward");
        win.show();
        win.focus();
        send(s, { id, result: { front: true } });
      } else if (req.app === "close") {
        // As a person closing the window: the app ends and the preview command ends everything it started.
        send(s, { id, result: { closing: true } });
        win.close();
      } else throw new Error("an unknown request");
    } catch (err) {
      send(s, { id, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const server = createServer((s) => {
    if (peer !== undefined && !peer.destroyed) { s.destroy(); return; }
    let authed = false;
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) { s.destroy(); return; }
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { hello?: unknown; id?: number; cdp?: never; app?: string; value?: unknown };
        try { msg = JSON.parse(line); } catch { s.destroy(); return; }
        if (!authed) {
          if (typeof msg.hello !== "string" || !sameToken(msg.hello, o.token)) { s.destroy(); return; }
          authed = true;
          peer = s;
          send(s, { hello: "ok" });
          continue;
        }
        void handle(s, msg);
      }
    });
    s.on("close", () => { if (peer === s) peer = undefined; });
    s.on("error", () => { if (peer === s) peer = undefined; });
  });
  server.listen(o.socketPath, () => {
    // The mode is set the moment the file exists; the folder is already closed to others, so nothing could open it before.
    try { chmodSync(o.socketPath, 0o600); } catch { /* the folder's mode still holds */ }
    o.log(`${PREVIEW_CONTROL_NAME}: serving ${o.socketPath}`);
  });
  return { server, close: () => { try { server.close(); } catch { /* gone */ } rmSync(o.socketPath, { force: true }); } };
}
