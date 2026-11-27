// What the launcher says when it can't start a command in its working folder, in words for the bot or agent that ran it.
// srt-win prints one line of JSON on stderr and exits 16 (`mapped_drive_cwd`: the folder is on a network drive) or 27
// (`cwd_unusable`: the sandbox account couldn't enter the folder, which is not on a network drive: it is gone, or its
// permissions keep the account out; vendor/srt-win patch 0005). Without this the model reads a JSON line and an exit code.

export const LAUNCHER_EXIT_MAPPED_DRIVE = 16;
export const LAUNCHER_EXIT_CWD_UNUSABLE = 27;

/** The launcher's typed refusal in plain words, or null when this is not one (any other exit, or no such line). */
export function explainLauncherCwd(code: number, stderr: string): string | null {
  if (code !== LAUNCHER_EXIT_MAPPED_DRIVE && code !== LAUNCHER_EXIT_CWD_UNUSABLE) return null;
  // Only the LAST line of stderr: the launcher prints its refusal as the end of what it says, and a sandboxed command that
  // itself exits 16 or 27 and prints a matching line leaves its own words after it, or its line is not the last.
  const lines = stderr.split(/\r?\n/).filter((l) => l.trim() !== "");
  for (const line of lines.slice(-1)) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.endsWith("}")) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
    const text = (v: unknown, max = 260): string => (typeof v === "string" ? v.replace(/[\r\n]+/g, " ").slice(0, max) : "");
    if (o.code === "mapped_drive_cwd" && code === LAUNCHER_EXIT_MAPPED_DRIVE) {
      return `The command didn't start: its folder is on a network or mapped drive (${text(o.drive, 80) || "a remote drive"}), and the sandbox account can't use those. Run it from a folder on a local drive.`;
    }
    if (o.code === "cwd_unusable" && code === LAUNCHER_EXIT_CWD_UNUSABLE) {
      const cwd = text(o.cwd, 400) || "its folder";
      const exists = o.exists === false
        ? "The folder isn't there (it was removed or renamed away): run the command from a folder that exists."
        : "The folder may have been removed, or its permissions keep the sandbox account out (it must be able to enter the folder and every folder above it): run the command from another folder, or give the sandbox access to this one.";
      return `The command didn't start: the sandbox account can't enter ${cwd}. ${exists} (launcher: ${text(o.hresult, 20) || "no code"}, drive type ${typeof o.driveType === "number" ? o.driveType : "unknown"}.)`;
    }
  }
  return null;
}
