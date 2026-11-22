// Running a program for the owner steps: as the factory's own account when the driver runs as root (the project
// checkout, its git sign-in and the coding agent's sign-in are that account's), else as whoever runs the driver.
import { spawnSync } from "node:child_process";

const isRoot = () => typeof process.getuid === "function" && process.getuid() === 0;

// -> { status, stdout, stderr, timedOut, error }
export function runAs(settings, cmd, args = [], { cwd, timeoutMs = 120000, env = {}, input } = {}) {
  const user = settings && settings.server && settings.server.factory_user;
  const home = (settings && settings.server && settings.server.factory_home) || (user ? `/home/${user}` : "");
  const extra = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const options = { cwd, encoding: "utf8", timeout: timeoutMs, input, maxBuffer: 64 * 1024 * 1024, killSignal: "SIGKILL" };
  const r = isRoot() && user && user !== "root"
    ? spawnSync("runuser", ["-u", user, "--", "env", `HOME=${home}`, ...extra, cmd, ...args], options)
    : spawnSync(cmd, args, { ...options, env: { ...process.env, ...env } });
  const timedOut = !!(r.error && r.error.code === "ETIMEDOUT") || r.signal === "SIGKILL";
  return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), timedOut, error: r.error && !timedOut ? r.error : null };
}

// A shell command line from the project's own settings. As the factory's account it runs in a login shell, so
// the tools in that account's home are on its PATH, as they are for the factory itself.
export const shellAs = (settings, line, opts = {}) => {
  const user = settings && settings.server && settings.server.factory_user;
  const login = isRoot() && user && user !== "root";
  return runAs(settings, "bash", [login ? "-lc" : "-c", line], opts);
};
