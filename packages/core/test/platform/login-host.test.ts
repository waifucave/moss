// The host's on-demand task (Windows) and user unit (Linux): the engine starts them (`schtasks /Run /TN \MOSS\moss-host`, `systemctl --user
// start moss-host.service`, host/world.ts) and nothing used to install them. Pure rendering and the manager against a fake OS: nothing here
// calls the real schtasks, systemctl or launchctl, so no platform list names it.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTaskName, hostUnitName } from "../../src/host/world";
import { hostExecutable } from "../../src/platform/login/host-exe";
import { liveLoginOsDeps, type Runner } from "../../src/platform/login/live";
import { loginDisable, loginEnable, loginRemove, loginStatus, type LoginOsDeps, type TaskDef } from "../../src/platform/login/manager";
import { HOST_PROGRAM_ARG, hostUnitPath, renderHostSchtasksXml, renderHostSystemdUnit, type LoginSpec } from "../../src/platform/login/render";

const LINUX_HOST = "/opt/moss-code/moss-code";
const WIN_HOST = "C:\\Users\\me\\AppData\\Local\\Programs\\MOSS Code\\MOSS Code.exe";

function spec(os: "linux" | "win32", host?: string, profile: "dist" | "dev" = "dist"): LoginSpec {
  const home = mkdtempSync(join(tmpdir(), "moss-login-host-"));
  return { os, bin: "/opt/moss/moss-core", home: join(home, ".moss"), logsDir: join(home, ".moss/logs"), profile, homedir: home, winUser: "S-1-5-21-1", ...(host ? { host: { bin: host } } : {}) };
}

function fakeOs() {
  const calls: Array<{ op: string; tasks?: readonly TaskDef[]; drop?: readonly string[] }> = [];
  const hosts = new Set<string>();
  const os: LoginOsDeps = {
    async register(_s, o) { calls.push({ op: "register", tasks: o.tasks, ...(o.drop ? { drop: o.drop } : {}) }); for (const t of o.tasks) if (t.name.includes("moss-host")) hosts.add(t.name); for (const d of o.drop ?? []) hosts.delete(d); return true; },
    async unregister() { calls.push({ op: "unregister" }); hosts.clear(); },
    async query() { return "on"; },
    async hostDefined(s) { return hosts.has(hostTaskName(s.profile)); },
  };
  return { os, calls };
}

describe("the host's names come from the engine's own (host/world.ts)", () => {
  test("the task and the unit the definitions carry are hostTaskName and hostUnitName", () => {
    expect(renderHostSchtasksXml(spec("win32", WIN_HOST))).toContain(`<URI>${hostTaskName("dist")}</URI>`);
    expect(renderHostSchtasksXml(spec("win32", WIN_HOST, "dev"))).toContain(`<URI>${hostTaskName("dev")}</URI>`);
    expect(hostTaskName("dist")).toBe("\\MOSS\\moss-host");
    expect(hostUnitPath(spec("linux", LINUX_HOST))!.endsWith(`/${hostUnitName("dist")}`)).toBe(true);
    expect(hostUnitPath(spec("linux", LINUX_HOST, "dev"))!.endsWith("/moss-host-dev.service")).toBe(true);
  });
});

describe("the host's systemd user unit", () => {
  test("started on demand: no [Install], the graphical session's, inert once the executable is gone", () => {
    const unit = renderHostSystemdUnit(spec("linux", LINUX_HOST));
    expect(unit).toContain(`ExecStart="${LINUX_HOST}" ${HOST_PROGRAM_ARG}`);
    expect(unit).toContain(`ConditionPathExists=${LINUX_HOST}`);
    expect(unit).toContain("After=graphical-session.target");
    expect(unit).toContain("PartOf=graphical-session.target");
    expect(unit).toContain("Restart=no");
    expect(unit).not.toContain("[Install]");
    expect(unit).not.toContain("MOSS_PROFILE");
  });

  test("dev carries its profile; a path with a space stays one argument; a control character is refused", () => {
    expect(renderHostSystemdUnit(spec("linux", LINUX_HOST, "dev"))).toContain('Environment="MOSS_PROFILE=dev"');
    expect(renderHostSystemdUnit(spec("linux", "/opt/my apps/moss-code"))).toContain('ExecStart="/opt/my apps/moss-code" --moss-program=host');
    expect(() => renderHostSystemdUnit(spec("linux", "/opt/x\nExecStart=/bin/sh"))).toThrow(/control character/);
    expect(() => renderHostSystemdUnit(spec("linux"))).toThrow(/spec.host/);
  });
});

describe("the host's Task Scheduler task", () => {
  test("no trigger, the user's interactive session, never elevated, the host program's argument", () => {
    const xml = renderHostSchtasksXml(spec("win32", WIN_HOST));
    expect(xml).toContain("<Triggers />");
    expect(xml).not.toContain("<LogonTrigger>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<UserId>S-1-5-21-1</UserId>");
    expect(xml).toContain(`<Command>${WIN_HOST}</Command>`);
    expect(xml).toContain(`<Arguments>${HOST_PROGRAM_ARG}</Arguments>`);
    expect(xml).toContain("<AllowStartOnDemand>true</AllowStartOnDemand>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  });

  test("a path is XML-escaped, and a control character is refused", () => {
    expect(renderHostSchtasksXml(spec("win32", "C:\\A&B\\MOSS Code.exe"))).toContain("<Command>C:\\A&amp;B\\MOSS Code.exe</Command>");
    expect(() => renderHostSchtasksXml(spec("win32", "C:\\x\n.exe"))).toThrow(/control character/);
    expect(() => renderHostSchtasksXml(spec("win32"))).toThrow(/spec.host/);
  });
});

describe("the manager writes, refreshes and removes the host's definition beside the others", () => {
  test("Linux: enable writes the unit, disable keeps it, remove deletes it, status reports it", async () => {
    const s = spec("linux", LINUX_HOST);
    const f = fakeOs();
    await loginEnable(s, f.os);
    expect(readFileSync(hostUnitPath(s)!, "utf8")).toContain(`ExecStart="${LINUX_HOST}" --moss-program=host`);
    expect((await loginStatus(s, f.os)).host).toBe(true);
    await loginDisable(s, f.os);
    expect(existsSync(hostUnitPath(s)!)).toBe(true);
    await loginRemove(s, f.os);
    expect(existsSync(hostUnitPath(s)!)).toBe(false);
    expect((await loginStatus(s, f.os)).host).toBe(false);
  });

  test("Linux: an upgrade refreshes the unit; with no host installed any left over goes", async () => {
    const s = spec("linux", LINUX_HOST);
    const f = fakeOs();
    await loginEnable(s, f.os);
    await loginEnable({ ...s, host: { bin: "/opt/moss/resources/host/moss-host" } }, f.os);
    expect(readFileSync(hostUnitPath(s)!, "utf8")).toContain('ExecStart="/opt/moss/resources/host/moss-host"');
    const { host: _gone, ...noHost } = s;
    await loginEnable(noHost, f.os);
    expect(existsSync(hostUnitPath(s)!)).toBe(false);
  });

  test("Windows: enable and disable register the host's task with the daemon's; remove deletes it; status reports it", async () => {
    const s = spec("win32", WIN_HOST);
    const f = fakeOs();
    await loginEnable(s, f.os);
    expect(f.calls.at(-1)!.tasks!.map((t) => t.name)).toEqual(["\\MOSS\\moss-core", "\\MOSS\\moss-host"]);
    expect(f.calls.at(-1)!.tasks![1]!.xml).toContain(WIN_HOST);
    expect((await loginStatus(s, f.os)).host).toBe(true);
    await loginDisable(s, f.os);
    expect(f.calls.at(-1)!.tasks!.map((t) => t.name)).toEqual(["\\MOSS\\moss-core", "\\MOSS\\moss-host"]);
    await loginRemove(s, f.os);
    expect((await loginStatus(s, f.os)).host).toBe(false);
  });

  test("Windows: with no host installed the task an older install left is dropped, none is written", async () => {
    const { host: _h, ...s } = spec("win32", WIN_HOST);
    const f = fakeOs();
    await loginEnable(s, f.os);
    expect(f.calls.at(-1)!.tasks!.map((t) => t.name)).toEqual(["\\MOSS\\moss-core"]);
    expect(f.calls.at(-1)!.drop).toEqual(["\\MOSS\\moss-host"]);
  });

  test("Linux remove stops the host's unit through the recorded runner, never a real systemctl", async () => {
    const calls: string[] = [];
    const run: Runner = async (argv) => { calls.push(argv.join(" ")); return { ok: true, out: "" }; };
    await liveLoginOsDeps(run).unregister(spec("linux", LINUX_HOST));
    expect(calls).toContain("systemctl --user stop moss-host.service");
  });
});

describe("which executable the host's definition runs (one rule for MOSS and MOSS Code)", () => {
  function home(records: Record<string, { bundlePath: string; release: string; seenAt?: number }>): string {
    const h = mkdtempSync(join(tmpdir(), "moss-host-exe-"));
    mkdirSync(join(h, "apps"));
    for (const [program, r] of Object.entries(records)) {
      writeFileSync(join(h, "apps", `${program}.json`), JSON.stringify({ record: 1, program, bundlePath: r.bundlePath, release: r.release, carries: { engine: true, host: true }, seenAt: r.seenAt ?? 1 }));
    }
    return h;
  }
  const on = (...present: string[]) => (p: string) => present.includes(p);

  test("only MOSS Code's: its own executable, by OS", () => {
    const h = home({ code: { bundlePath: "/opt/moss-code", release: "1.2.0" } });
    expect(hostExecutable(h, "linux", on("/opt/moss-code", LINUX_HOST))?.bin).toBe(LINUX_HOST);
    const w = home({ code: { bundlePath: "C:\\Users\\me\\AppData\\Local\\Programs\\MOSS Code", release: "1.2.0" } });
    expect(hostExecutable(w, "win32", on("C:\\Users\\me\\AppData\\Local\\Programs\\MOSS Code", WIN_HOST))?.bin).toBe(WIN_HOST);
  });

  test("only MOSS: the host tree it carries", () => {
    const h = home({ moss: { bundlePath: "/opt/moss", release: "1.2.0" } });
    expect(hostExecutable(h, "linux", on("/opt/moss", "/opt/moss/resources/host/moss-host"))?.bin).toBe("/opt/moss/resources/host/moss-host");
    const w = home({ moss: { bundlePath: "C:\\Program Files\\MOSS", release: "1.2.0" } });
    expect(hostExecutable(w, "win32", on("C:\\Program Files\\MOSS", "C:\\Program Files\\MOSS\\resources\\host\\moss-host.exe"))?.bin).toBe("C:\\Program Files\\MOSS\\resources\\host\\moss-host.exe");
  });

  test("both: the newer release wins, and on the same release MOSS Code's own", () => {
    const present = on("/opt/moss-code", LINUX_HOST, "/opt/moss", "/opt/moss/resources/host/moss-host");
    expect(hostExecutable(home({ code: { bundlePath: "/opt/moss-code", release: "1.2.0" }, moss: { bundlePath: "/opt/moss", release: "1.2.0" } }), "linux", present)?.program).toBe("code");
    expect(hostExecutable(home({ code: { bundlePath: "/opt/moss-code", release: "1.2.0" }, moss: { bundlePath: "/opt/moss", release: "1.3.0" } }), "linux", present)?.program).toBe("moss");
    expect(hostExecutable(home({ code: { bundlePath: "/opt/moss-code", release: "1.4.0" }, moss: { bundlePath: "/opt/moss", release: "1.3.0" } }), "linux", present)?.program).toBe("code");
  });

  test("a copy whose executable is gone is no candidate; none at all, or macOS, gives none", () => {
    const h = home({ code: { bundlePath: "/opt/moss-code", release: "1.4.0" }, moss: { bundlePath: "/opt/moss", release: "1.3.0" } });
    expect(hostExecutable(h, "linux", on("/opt/moss-code", "/opt/moss", "/opt/moss/resources/host/moss-host"))?.program).toBe("moss");
    expect(hostExecutable(h, "linux", on("/opt/moss-code", "/opt/moss"))).toBeUndefined();
    expect(hostExecutable(h, "darwin", () => true)).toBeUndefined();
    expect(hostExecutable(mkdtempSync(join(tmpdir(), "moss-host-exe-none-")), "linux", () => true)).toBeUndefined();
  });
});

describe("an app uninstalled between launches: the remaining app's enable repoints or removes the definition", () => {
  test("Linux: MOSS Code removed, MOSS remains: the unit is repointed at MOSS's carried copy; MOSS removed too: the unit goes", async () => {
    const h = mkdtempSync(join(tmpdir(), "moss-host-swap-"));
    mkdirSync(join(h, "apps"));
    const rec = (program: string, bundlePath: string) => writeFileSync(join(h, "apps", `${program}.json`), JSON.stringify({ record: 1, program, bundlePath, release: "1.2.0", carries: { engine: true, host: true }, seenAt: 1 }));
    rec("code", "/opt/moss-code");
    rec("moss", "/opt/moss");
    let present = ["/opt/moss-code", "/opt/moss-code/moss-code", "/opt/moss", "/opt/moss/resources/host/moss-host"];
    const exists = (p: string) => present.includes(p);
    const base = spec("linux");
    const f = fakeOs();
    const launch = async () => { const hx = hostExecutable(h, "linux", exists); await loginEnable({ ...base, ...(hx ? { host: { bin: hx.bin } } : {}) }, f.os); };
    await launch();
    expect(readFileSync(hostUnitPath(base)!, "utf8")).toContain('ExecStart="/opt/moss-code/moss-code"');
    present = present.filter((p) => !p.startsWith("/opt/moss-code"));
    await launch();
    expect(readFileSync(hostUnitPath(base)!, "utf8")).toContain('ExecStart="/opt/moss/resources/host/moss-host"');
    present = [];
    await launch();
    expect(existsSync(hostUnitPath(base)!)).toBe(false);
  });

  test("Windows: the task is registered again with MOSS's copy, then dropped when nothing carries the host", async () => {
    const h = mkdtempSync(join(tmpdir(), "moss-host-swap-win-"));
    mkdirSync(join(h, "apps"));
    const rec = (program: string, bundlePath: string) => writeFileSync(join(h, "apps", `${program}.json`), JSON.stringify({ record: 1, program, bundlePath, release: "1.2.0", carries: { engine: true, host: true }, seenAt: 1 }));
    const code = "C:\\Code", moss = "C:\\Moss";
    rec("code", code);
    rec("moss", moss);
    let present = [code, `${code}\\MOSS Code.exe`, moss, `${moss}\\resources\\host\\moss-host.exe`];
    const exists = (p: string) => present.includes(p);
    const f = fakeOs();
    const launch = async () => { const hx = hostExecutable(h, "win32", exists); await loginEnable({ ...spec("win32"), ...(hx ? { host: { bin: hx.bin } } : {}) }, f.os); };
    await launch();
    expect(f.calls.at(-1)!.tasks![1]!.xml).toContain(`<Command>${code}\\MOSS Code.exe</Command>`);
    present = present.filter((p) => !p.startsWith(code));
    await launch();
    expect(f.calls.at(-1)!.tasks![1]!.xml).toContain(`<Command>${moss}\\resources\\host\\moss-host.exe</Command>`);
    present = [];
    await launch();
    expect(f.calls.at(-1)!.tasks!.map((t) => t.name)).toEqual(["\\MOSS\\moss-core"]);
    expect(f.calls.at(-1)!.drop).toEqual(["\\MOSS\\moss-host"]);
  });
});
