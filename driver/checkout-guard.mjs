// Root never writes in the factory user's folders (issue #157, the Forge 0.3.1 ticket 08).
//
// On 2026-11-22 at 01:16 an acting run (onduty.mjs: Codex, running as root on the first owner's server) checked out a lap's
// branch in the main project's factory checkout and committed a merge there for a pull request. Root's own git config listed
// that checkout as a safe directory, so git let it. From then on HEAD, the index, the logs, 1,298 git files and about 40,000
// working-tree files were root's: the factory user's `git fetch` failed ("unable to append to
// .git/logs/refs/remotes/origin/main: Permission denied"), origin/main stayed a day old, and a lap launch failed with
// "Permission denied accessing repository", until a session gave the files back by hand on 2026-11-24.
//
// The locks on that door:
//   - in the driver's own processes (a round, a step) git as root in a folder inside the factory user's home is refused unless
//     it is wrapped (runuser -u <factory user> --): enforceCheckoutGuard() puts that check in front of child_process, the one
//     runner every step's git goes through, and gitAs() / gitInDir() are the ways to run git there as the factory user;
//   - an acting run and a dead-man's repair run (an AI with a root shell) have the factory's checkouts read-only in their unit
//     (onduty.mjs controlPlane, deadman.mjs launchRepair), and their briefs say where they work instead;
//   - housekeeping gives every checkout back to the factory user each round and proves its `git fetch` works (housekeeping.mjs).
// A guard that only applies to root: anything else cannot make a file root's.
import path from "node:path";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

export const isRoot = () => process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0;
const P = path.posix;

// The factory's account: from the driver's settings ({server: {factory_user, factory_home}}) or from the environment the settings
// make (FORGE_USER, FD_FORGE_HOME). -> {user, home}; user "" when nothing names it.
export function factoryAccount(src = process.env) {
  const s = src && typeof src === "object" && src.server && typeof src.server === "object" ? src.server : null;
  const user = String((s ? s.factory_user : src && src.FORGE_USER) || "").trim();
  const home = String((s ? s.factory_home : src && src.FD_FORGE_HOME) || (user ? `/home/${user}` : "")).trim();
  return { user, home: home && home.startsWith("/") ? P.normalize(home).replace(/(.)\/+$/, "$1") : "" };
}
// Only an account that is someone else than root, with a home of its own, has folders root must not write in.
const guarded = a => !!(a && a.user && a.user !== "root" && a.home && a.home !== "/");

// The project checkouts the settings name (FD_PROJECT_CHECKOUTS, {project: folder}) and the main one (FD_SOURCE_CHECKOUT).
// -> absolute folders, each once
export function checkoutsFrom(e = process.env) {
  let map = {};
  try { const v = JSON.parse(e.FD_PROJECT_CHECKOUTS || "{}"); if (v && typeof v === "object" && !Array.isArray(v)) map = v; } catch { /* none */ }
  const all = [...Object.values(map), e.FD_SOURCE_CHECKOUT].filter(c => typeof c === "string" && c.startsWith("/") && !/\s/.test(c));
  return [...new Set(all.map(c => P.normalize(c).replace(/(.)\/+$/, "$1")))];
}

// Folders are the server's (posix); a Windows test machine's C:\ paths are read the same way.
const norm = p => String(p || "").replace(/\\/g, "/");
const isAbs = p => p.startsWith("/") || /^[A-Za-z]:\//.test(p);
export const inside = (dir, root) => { const r = P.relative(norm(root), norm(dir)); return r === "" || (!r.startsWith("..") && !P.isAbsolute(r)); };
const abs = (base, p) => { const q = norm(p), b = norm(base); return P.normalize(isAbs(q) ? q : isAbs(b) ? P.join(b, q) : P.resolve(b || "/", q)); };

// The folders a git command works in: the folder it starts in (cwd, then each -C, relative to the one before), --git-dir and
// --work-tree (or GIT_DIR and GIT_WORK_TREE), and the new folder of a clone or an init. -> [folder]
const VALUE_OPTIONS = new Set(["-c", "--namespace", "--config-env", "--super-prefix", "--exec-path"]);
export function gitFolders(args, cwd = process.cwd(), env = {}) {
  let dir = String(cwd || process.cwd());
  const out = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = String(args[i]);
    if (a === "-C") { dir = abs(dir, args[++i]); continue; }
    if (a === "--git-dir" || a === "--work-tree") { out.push(abs(dir, args[++i])); continue; }
    const eq = /^--(git-dir|work-tree)=(.*)$/.exec(a);
    if (eq) { out.push(abs(dir, eq[2])); continue; }
    if (VALUE_OPTIONS.has(a)) { i++; continue; }
    if (!a.startsWith("-")) break; // the subcommand
  }
  out.unshift(dir);
  for (const k of ["GIT_DIR", "GIT_WORK_TREE"]) if (env && env[k]) out.push(abs(dir, env[k]));
  const sub = String(args[i] || "");
  if (sub === "clone" || sub === "init") {
    const rest = args.slice(i + 1).map(String), plain = [];
    for (let j = 0; j < rest.length; j++) {
      if (rest[j] === "--") { plain.push(...rest.slice(j + 1)); break; }
      if (/^-(b|o|c|u|j)$|^--(branch|origin|config|upload-pack|template|reference|separate-git-dir|depth|jobs|filter|shallow-since|shallow-exclude|server-option|object-format|initial-branch|ref-format)$/.test(rest[j])) { j++; continue; }
      if (!rest[j].startsWith("-")) plain.push(rest[j]);
    }
    const target = sub === "clone" ? plain[1] : plain[0];
    if (target) out.push(abs(dir, target));
  }
  return out;
}

// `env [-i] [-u NAME] [NAME=value ...] cmd ...` -> { cmd, args, vars } (anything else is returned as it is)
function unwrapEnv(cmd, args) {
  const vars = {};
  if (!/(^|\/)env$/.test(cmd)) return { cmd, args, vars };
  let i = 0;
  for (; i < args.length; i++) {
    const a = String(args[i]);
    if (a === "-i" || a === "--ignore-environment" || a === "-") continue;
    if (a === "-u" || a === "--unset" || a === "-C" || a === "--chdir") { i++; continue; }
    if (a === "--") { i++; break; }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a);
    if (m) { vars[m[1]] = m[2]; continue; }
    break;
  }
  return { cmd: String(args[i] || ""), args: args.slice(i + 1), vars };
}

// The sentence that refuses a git command root would run in the factory user's home, or "" when it may run. `file`, `args`
// and `opts` are what child_process gets. A command wrapped as another user (runuser -u <factory user> -- git ...) is not git
// as root, so it passes.
export function rootGitRefusal(file, args, opts = {}, { account = factoryAccount(), root = isRoot() } = {}) {
  if (!root || !guarded(account)) return "";
  const o = opts && typeof opts === "object" ? opts : {};
  const u = unwrapEnv(String(file || ""), Array.isArray(args) ? args.map(String) : []);
  if (!/(^|\/)git$/.test(u.cmd)) return "";
  const env = { ...(o.env || process.env), ...u.vars };
  const hit = gitFolders(u.args, o.cwd, env).find(d => inside(d, account.home));
  if (!hit) return "";
  return `refused: git ${u.args.slice(0, 6).join(" ")} as root in ${hit}, which is inside the factory user's home (${account.home}); there it runs as ${account.user} (runuser -u ${account.user} --), never as root, so no file of the factory's becomes root's`;
}

// git as the factory user when this process is root and the factory user is someone else, else as it is.
// -> [file, args] for child_process (runuser is in /usr/sbin: the caller's PATH must have it)
export function gitAs(account, args, { root = isRoot() } = {}) {
  if (root && guarded(account)) return ["runuser", ["-u", account.user, "--", "env", `HOME=${account.home}`, "GIT_TERMINAL_PROMPT=0", "git", ...args]];
  return ["git", args];
}
// git -C dir: as the factory user when dir is inside its home (gitAs), else as it is. -> [file, args]
export function gitInDir(account, dir, args, opts = {}) {
  const a = account || {};
  return guarded(a) && String(dir || "").startsWith("/") && inside(P.normalize(String(dir)), a.home) ? gitAs(a, ["-C", dir, ...args], opts) : ["git", ["-C", dir, ...args]];
}

// ---------------------------------------------------------------- the guard in front of child_process
// Every refusal, for the round's record and the tests.
export const refusedGit = [];
let restore = null;
// Puts rootGitRefusal in front of child_process for the whole process (a round, a step), the way readonly.mjs puts the dry run's
// lock there. spawnSync answers a refused command the way it answers one that could not start (status null, error set), so a
// caller that checks the answer fails closed and a round goes on; execFileSync, spawn and execFile throw. Only for root: for
// anyone else it installs nothing. -> the function that takes it away again
export function enforceCheckoutGuard(account = factoryAccount(), { root = isRoot(), log = m => console.error(m) } = {}) {
  if (restore) restore();
  if (!root || !guarded(account)) { restore = null; return () => {}; }
  const saved = [];
  const why = (file, args, opts) => {
    const list = Array.isArray(args) ? args : [];
    const o = Array.isArray(args) ? opts : args;
    const w = rootGitRefusal(file, list, o || {}, { account, root });
    if (w) { refusedGit.push(w); try { log(w); } catch { /* the refusal stands without its line */ } }
    return w;
  };
  const wrap = (name, refuse) => {
    const orig = cp[name];
    if (typeof orig !== "function") return;
    saved.push([name, orig]);
    cp[name] = function (...a) { const w = why(a[0], a[1], a[2]); return w ? refuse(w, a[1], a[2]) : orig.apply(this, a); };
  };
  const thrown = w => { const e = new Error(w); e.code = "EROOTGIT"; throw e; };
  wrap("spawnSync", (w, args, opts) => {
    const o = (Array.isArray(args) ? opts : args) || {};
    const text = o.encoding && o.encoding !== "buffer" ? w : Buffer.from(w);
    const empty = o.encoding && o.encoding !== "buffer" ? "" : Buffer.alloc(0);
    const error = Object.assign(new Error(w), { code: "EROOTGIT" });
    return { pid: 0, output: [null, empty, text], stdout: empty, stderr: text, status: null, signal: null, error };
  });
  for (const n of ["execFileSync", "spawn", "execFile"]) wrap(n, thrown);
  syncBuiltinESMExports();
  restore = () => { for (const [name, orig] of saved.reverse()) cp[name] = orig; syncBuiltinESMExports(); restore = null; };
  return restore;
}
