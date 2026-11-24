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
//   - in the driver's own processes (a round, a step) git as root in a folder inside the factory user's home, called directly or
//     in a shell command line, is refused unless it is wrapped (runuser -u <factory user> --): enforceCheckoutGuard() puts that
//     check in front of child_process, the one runner every step's git goes through, and gitAs() / gitInDir() are the ways to
//     run git there as the factory user;
//   - in the same processes, a file root makes in the factory user's home (the stage step's STOP in a checkout's .factory folder)
//     is given at once to the owner of the folder it is in, so nothing the driver writes there stays root's;
//   - an acting run and a dead-man's repair run (an AI with a root shell) have the factory's checkouts read-only in their unit
//     (onduty.mjs controlPlane, deadman.mjs launchRepair), and their briefs say where they work instead;
//   - housekeeping gives every checkout back to the factory user each round and proves its `git fetch` works (housekeeping.mjs).
// A guard that only applies to root: anything else cannot make a file root's.
import fs from "node:fs";
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

// The programs that only run another command, as the same user: their options (those that take a value, and the one that
// changes the folder), and how many plain words come before the command (timeout's duration).
const WRAPPERS = {
  env: { value: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"], chdir: ["-C", "--chdir"], split: ["-S", "--split-string"], assigns: true },
  nice: { value: ["-n", "--adjustment"] },
  ionice: { value: ["-c", "--class", "-n", "--classdata"] },
  nohup: {}, setsid: {},
  stdbuf: { value: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  timeout: { value: ["-s", "--signal", "-k", "--kill-after"], words: 1 },
  sudo: { value: ["-u", "--user", "-g", "--group", "-D", "--chdir", "-C", "--close-from", "-h", "--host", "-p", "--prompt", "-T", "--command-timeout"], chdir: ["-D", "--chdir"], user: ["-u", "--user"] },
  runuser: { value: ["-u", "--user", "-g", "--group", "-G", "--supp-group", "-w", "--whitelist-environment"], user: ["-u", "--user"] },
};
// `env -C dir X=1 nice -n 5 git ...` -> { cmd: "git", args, vars, cwd, as } with the folder it starts in and the user it runs as
// ("" while still root). A wrapper that runs it as someone else ends the reading: that is no longer root's git.
function unwrap(cmd, args, cwd) {
  const vars = {};
  let as = "";
  for (let depth = 0; depth < 8; depth++) {
    const name = Object.keys(WRAPPERS).find(n => new RegExp(`(^|/)${n}$`).test(cmd));
    if (!name) break;
    const w = WRAPPERS[name], value = new Set(w.value || []);
    let i = 0, words = w.words || 0, next = null;
    for (; i < args.length; i++) {
      const a = String(args[i]);
      if (a === "--") { i++; break; }
      const long = /^(--[a-z-]+)=(.*)$/s.exec(a), short = /^(-[a-zA-Z])(.+)$/s.exec(a);
      const [opt, val] = long ? [long[1], long[2]] : value.has(a) ? [a, String(args[++i] ?? "")] : short && value.has(short[1]) ? [short[1], short[2]] : [a, null];
      if (val !== null || a.startsWith("-")) {
        if ((w.chdir || []).includes(opt) && val !== null) cwd = abs(cwd || process.cwd(), val);
        if ((w.user || []).includes(opt) && val !== null) as = val;
        if ((w.split || []).includes(opt) && val !== null) next = val.trim().split(/\s+/);
        continue;
      }
      const m = w.assigns && /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a);
      if (m) { vars[m[1]] = m[2]; continue; }
      if (words > 0) { words--; continue; }
      break;
    }
    const rest = [...(next || []), ...args.slice(i).map(String)];
    if (as && as !== "root" && as !== "0") return { cmd: "", args: [], vars, cwd, as };
    cmd = String(rest[0] || ""); args = rest.slice(1);
  }
  return { cmd, args, vars, cwd, as };
}

// A shell command line (bash -c, sh -c, shell: true, execSync): it runs git as root in the factory user's home when it calls git
// and names a folder there or starts in one. A reading of the script, not a parse: a script that does both is refused, which only
// ever makes a careful caller run it as the factory user. Its $NAME, ${NAME} and a leading ~ are read with the environment it
// runs with, so "$FD_FORGE_HOME/..." names the home as plainly as the folder itself.
const GIT_WORD = /(^|[\s;&|(`'"])(\S*\/)?git(\s|$)/m;
const PATHS = /(?:^|[\s'"=:(])(\/[^\s'"`;|&()<>:]*)/g;
const expand = (s, env) => s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => String((env || {})[a || b] ?? ""))
  .replace(/(^|[\s'"=:(])~(?=\/|\s|$)/g, (all, pre) => `${pre}${(env || {}).HOME || ""}`);
export function scriptRefusal(script, cwd, account, env = process.env) {
  const s = expand(String(script || ""), env);
  if (!GIT_WORD.test(s)) return "";
  const hit = [...s.matchAll(PATHS)].map(m => P.normalize(m[1])).find(p => inside(p, account.home)) || (cwd && inside(abs("/", cwd), account.home) ? abs("/", cwd) : "");
  if (!hit) return "";
  return `refused: a shell command that runs git as root names ${hit}, which is inside the factory user's home (${account.home}); there git runs as ${account.user} (runuser -u ${account.user} --), never as root, so no file of the factory's becomes root's (${s.replace(/\s+/g, " ").slice(0, 120)})`;
}
const SHELL = /(^|\/)(ba|da|z|k)?sh$/;
// The script of `bash -c <script>` (any flags joined with c, as -lc or -ec), or null.
function shellScript(cmd, args) {
  if (!SHELL.test(cmd)) return null;
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (/^-[a-z]*c[a-z]*$/.test(a)) return String(args[i + 1] || "");
    if (!a.startsWith("-")) return null; // a script file: not read here
  }
  return null;
}

// The sentence that refuses a git command root would run in the factory user's home, or "" when it may run. `file`, `args`
// and `opts` are what child_process gets. A command wrapped as another user (runuser -u <factory user> -- git ...) is not git
// as root, so it passes.
export function rootGitRefusal(file, args, opts = {}, { account = factoryAccount(), root = isRoot() } = {}) {
  if (!root || !guarded(account)) return "";
  const o = opts && typeof opts === "object" ? opts : {};
  const list = Array.isArray(args) ? args.map(String) : [];
  if (o.shell) return scriptRefusal([file, ...list].join(" "), o.cwd, account, o.env || process.env);
  const u = unwrap(String(file || ""), list, o.cwd);
  const env = { ...(o.env || process.env), ...u.vars };
  const script = shellScript(u.cmd, u.args);
  if (script !== null) return scriptRefusal(script, u.cwd, account, env);
  if (!/(^|\/)git$/.test(u.cmd)) return "";
  const folders = gitFolders(u.args, u.cwd, env);
  // and any argument that names a path there (git config --file, worktree add, a clone's source or target, -o, --output=...):
  // root's git names nothing in the factory user's home, not even to read it
  const named = u.args.map(a => (a.startsWith("-") && a.includes("=") ? a.slice(a.indexOf("=") + 1) : a)).filter(a => a.includes("/")).map(a => abs(folders[0], a));
  const hit = [...folders, ...named].find(d => inside(d, account.home));
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
// caller that checks the answer fails closed and a round goes on; execFileSync, spawn, execFile, execSync and exec throw. It also
// gives each file the process makes in the factory user's home to the owner of its folder (givesFilesBack). Only for root: for
// anyone else it installs nothing. fsOps {lstat, stat, lchown} are for the tests. -> the function that takes it away again
export function enforceCheckoutGuard(account = factoryAccount(), { root = isRoot(), log = m => console.error(m), fsOps = null } = {}) {
  if (restore) restore();
  if (!root || !guarded(account)) { restore = null; return () => {}; }
  const saved = [];
  const said = w => { if (w) { refusedGit.push(w); try { log(w); } catch { /* the refusal stands without its line */ } } return w; };
  const why = (file, args, opts) => {
    const list = Array.isArray(args) ? args : [];
    const o = Array.isArray(args) ? opts : args;
    return said(rootGitRefusal(file, list, o && typeof o === "object" ? o : {}, { account, root }));
  };
  // execSync and exec take one shell command line and its options
  const whyLine = (line, opts) => said(scriptRefusal(line, opts && typeof opts === "object" ? opts.cwd : undefined, account, (opts && typeof opts === "object" && opts.env) || process.env));
  const wrap = (name, refuse, check = why) => {
    const orig = cp[name];
    if (typeof orig !== "function") return;
    saved.push([cp, name, orig]);
    cp[name] = function (...a) { const w = check(a[0], a[1], a[2]); return w ? refuse(w, a[1], a[2]) : orig.apply(this, a); };
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
  for (const n of ["execSync", "exec"]) wrap(n, thrown, whyLine);
  givesFilesBack(account, saved, fsOps);
  syncBuiltinESMExports();
  restore = () => { for (const [obj, name, orig] of saved.reverse()) obj[name] = orig; syncBuiltinESMExports(); restore = null; };
  return restore;
}

// ---------------------------------------------------------------- the files root makes there
// A file or folder the process makes in the factory user's home (writeFileSync, appendFileSync, copyFileSync, renameSync,
// symlinkSync, openSync that creates, mkdirSync) is given at once to the owner of the folder it is in, when it came out root's:
// the stage step's STOP in a checkout's .factory folder (also when it is written again through a renamed temporary file), a
// helper's file in its work folder. A folder of root's keeps root's files (someone made it so on purpose). Never through a link:
// lchown changes a link itself. If giving it back fails, the file stays as it is and housekeeping gives it back in its round.
const MAKERS = [["writeFileSync", 0], ["appendFileSync", 0], ["copyFileSync", 1], ["renameSync", 1], ["symlinkSync", 1], ["openSync", 0], ["mkdirSync", 0]];
function givesFilesBack(account, saved, fsOps) {
  const real = { lstat: fs.lstatSync, stat: fs.statSync, lchown: fs.lchownSync };
  const ops = { ...real, ...(fsOps || {}) };
  const there = p => (typeof p === "string" || p instanceof URL) && inside(abs(process.cwd(), String(p instanceof URL ? p.pathname : p)), account.home);
  const giveBack = target => {
    const st = ops.lstat(target);
    if (st.uid !== 0) return;
    const dir = ops.stat(path.dirname(target));
    if (dir.uid === 0) return;
    ops.lchown(target, dir.uid, dir.gid);
  };
  const creates = flags => (typeof flags === "string" ? /[wa]/.test(flags) : typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0);
  for (const [name, at] of MAKERS) {
    const orig = fs[name];
    if (typeof orig !== "function") continue;
    saved.push([fs, name, orig]);
    fs[name] = function (...a) {
      const r = orig.apply(this, a);
      const target = a[at];
      if (!there(target) || (name === "openSync" && !creates(a[1]))) return r;
      try {
        const t = String(target instanceof URL ? target.pathname : target);
        // mkdirSync({recursive}) answers the first folder it made: each one from there down is given back, the outer first
        const first = typeof r === "string" ? r.replace(/^\\\\\?\\/, "") : ""; // (Windows answers with a \\?\ prefix)
        const made = name === "mkdirSync" && first ? (() => { const chain = []; for (let p = t; p.length >= first.length; p = path.dirname(p)) { chain.unshift(p); if (p === first || path.dirname(p) === p) break; } return chain; })() : [t];
        for (const p of made) giveBack(p);
      } catch { /* left as it is: housekeeping gives it back */ }
      return r;
    };
  }
}
