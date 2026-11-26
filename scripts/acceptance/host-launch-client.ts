// Windows' half of the harness's stand-in for the service manager (host-step.ts `startHostLauncher`): the command the engine runs as
// `MOSS_HOST_COMMAND`. It hands its arguments (after the launcher's pipe name) and its environment to the launcher, which starts the host
// outside the engine's job, as the Task Scheduler does for the real one, and exits. Linux does the same with a shell and `socat`.
import { connect } from "node:net";

const [pipe, ...argv] = process.argv.slice(2);
if (pipe === undefined || argv.length === 0) process.exit(2);
const env = Object.entries(process.env).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${v}`);
const payload = `${argv.map((a) => `${a}\0`).join("")}\0${env.map((e) => `${e}\0`).join("")}`;
const socket = connect(pipe);
socket.once("connect", () => socket.end(payload));
socket.once("close", () => process.exit(0));
socket.once("error", () => process.exit(1));
