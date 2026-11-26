// The supervisor on an OS with no host lock (Windows, Linux): a running host that outlived the engine is found by its reconnect, not by a lock; a second
// start that loses the host's single-instance lock to it is no crash. Fake clock, no OS.
import { expect, test } from "bun:test";
import type { AppInstallRecord } from "@waifucave/moss-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeHostWorld } from "../../contracts/fakes/host-supervisor";
import { EngineHostSupervisor, HOST_LOST_LOCK_WINDOW_MS, HOST_RECONNECT_GRACE_MS } from "../supervisor";

const app: AppInstallRecord = { record: 1, program: "moss", bundlePath: "C:\\moss\\MOSS.exe", release: "1.111.1", carries: { engine: true, host: true }, seenAt: 1 };
const ready = { pid: 7, release: "1.111.1", bundlePath: app.bundlePath, safeMode: false };

function noLockWorld(): FakeHostWorld {
  const world = new FakeHostWorld();
  world.app = app;
  world.noLock = true;
  return world;
}

test("a restarted engine waits for a live host's reconnect before starting one, and adopts it", async () => {
  const clock = new FakeClock();
  const world = noLockWorld();
  const host = new EngineHostSupervisor({ clock, world });
  const booted = host.boot();
  clock.advance(HOST_RECONNECT_GRACE_MS - 1);
  expect(world.starts).toEqual([]);
  host.ready(ready);
  expect(await booted).toBe("adopted");
  clock.advance(10 * HOST_RECONNECT_GRACE_MS);
  expect(world.starts).toEqual([]);
  expect(host.status()).toMatchObject({ state: "running", pid: 7, crashes: 0 });
});

test("with no host reconnecting, the grace ends and the host is started", async () => {
  const clock = new FakeClock();
  const world = noLockWorld();
  const host = new EngineHostSupervisor({ clock, world });
  const booted = host.boot();
  clock.advance(HOST_RECONNECT_GRACE_MS);
  expect(await booted).toBe("started");
  expect(world.starts).toEqual([{ bundlePath: app.bundlePath, safeMode: false }]);
});

test("a start that quits at once and a live host that then says ready: adopted, no crash, no safe mode", async () => {
  const clock = new FakeClock();
  const world = noLockWorld();
  const host = new EngineHostSupervisor({ clock, world });
  const booted = host.boot();
  clock.advance(HOST_RECONNECT_GRACE_MS);
  await booted;
  clock.advance(500);
  host.exited(); // the second host lost the single-instance lock and quit before its hello
  expect(host.status().crashes).toBe(0);
  expect(host.status().state).toBe("starting");
  clock.advance(HOST_RECONNECT_GRACE_MS - 1_000);
  host.ready(ready); // the live host's reconnect
  clock.advance(10 * HOST_RECONNECT_GRACE_MS);
  expect(host.status()).toMatchObject({ state: "running", pid: 7, crashes: 0, safeMode: false });
  expect(world.starts.length).toBe(1);
});

test("a start that quits at once with no host coming is a crash after the grace, as before", async () => {
  const clock = new FakeClock();
  const world = noLockWorld();
  const host = new EngineHostSupervisor({ clock, world });
  const booted = host.boot();
  clock.advance(HOST_RECONNECT_GRACE_MS);
  await booted;
  host.exited();
  expect(host.status().crashes).toBe(0);
  clock.advance(HOST_RECONNECT_GRACE_MS);
  expect(host.status()).toMatchObject({ state: "restarting", crashes: 1 });
});

test("a start that ran a while before quitting is a crash at once (only a quick quit is read as a lost lock)", async () => {
  const clock = new FakeClock();
  const world = noLockWorld();
  const host = new EngineHostSupervisor({ clock, world });
  const booted = host.boot();
  clock.advance(HOST_RECONNECT_GRACE_MS);
  await booted;
  clock.advance(HOST_LOST_LOCK_WINDOW_MS + 1);
  host.exited();
  expect(host.status()).toMatchObject({ state: "restarting", crashes: 1 });
});

test("the engine stopping during the grace ends the boot as absent and starts nothing", async () => {
  const clock = new FakeClock();
  const world = noLockWorld();
  const host = new EngineHostSupervisor({ clock, world });
  const booted = host.boot();
  host.stop("quit-everything");
  expect(await booted).toBe("absent");
  clock.advance(10 * HOST_RECONNECT_GRACE_MS);
  expect(world.starts).toEqual([]);
});

test("macOS (a lock) is unchanged: no grace, a held lock adopts, none starts at once", async () => {
  const clock = new FakeClock();
  const world = new FakeHostWorld();
  world.app = app;
  const host = new EngineHostSupervisor({ clock, world });
  expect(await host.boot()).toBe("started");
  expect(world.starts.length).toBe(1);
});

test("a cold start (no kept app, no live recorded host) starts at once, no grace", async () => {
  const clock = new FakeClock();
  const world = noLockWorld();
  world.alive = false;
  const host = new EngineHostSupervisor({ clock, world });
  expect(await host.boot()).toBe("started");
  expect(world.starts.length).toBe(1);
});

test("a boot that may have a live host (kept app, or a recorded pid still running) waits the grace", async () => {
  const clock = new FakeClock();
  const world = noLockWorld();
  world.alive = true;
  const host = new EngineHostSupervisor({ clock, world });
  const booted = host.boot();
  expect(world.starts).toEqual([]);
  clock.advance(HOST_RECONNECT_GRACE_MS);
  expect(await booted).toBe("started");
});

test("a ready keeps the host's pid for the next boot, and the peer's pid shows (never 0)", async () => {
  const clock = new FakeClock();
  const world = noLockWorld();
  const host = new EngineHostSupervisor({ clock, world });
  const booted = host.boot();
  host.ready(ready);
  await booted;
  expect(world.noted).toEqual([7]);
});
