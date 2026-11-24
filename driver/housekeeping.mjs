// Hiccups handled alone (2026-11-18, plan Task 6; the concept's point 6). Deterministic, no AI:
//   stale processes  a factory process older than its allowed time is stopped, but only after its
//                    command line was read again and is still exactly what the world saw, and still
//                    the factory user's
//   failed units     restarted only when allowlisted (ALLOWED_RESTART) or one of the factory user's own
//                    units (archonfactory-*, its rootless docker); nothing else, ever
//   login            the factory's GitHub login is renewed by its own unit; an acting run that could not sign in gets its
//                    sign-in links put back (onduty.mjs linkLogins) and one tiny sign-in check on the smallest model
//   disk > 85 %      Archon's own cleanup of worktrees idle for a day (it skips any a live run holds),
//                    then `docker system prune -f` in the factory user's rootless Docker
//   checkouts        every project checkout in the factory user's home is that user's alone: files another user owns
//                    (a root process wrote there) go back to it with a chown limited to that checkout, and its
//                    `git fetch` must work, every round (the Forge 0.3.1, ticket 08, issue #157)
//   memory < 15 %    fewer laps: MAX_LAPS in the factory's .factory-env goes down one (and back to what
//                    it was once memory is plentiful again). OFF unless env.LOWER_LAPS: nothing reads
//                    MAX_LAPS yet (2026-11-18 ruling), so tight memory goes to the ops helper instead
//   STOP file        the factory's .factory/STOP (or PAUSE) whose writer has ended while no candidate's
//                    scenarios run is removed (the release step forgot it; it stops every lap silently),
//                    after the file and the process were read again (2026-11-18 ruling)
// Michael's live Godspeed always comes first and is never touched: not its notebook, not Hermes, not
// the owner's own folders and ports.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ANONYMOUS_UNIT, isLegacy } from "./world.mjs";
import { forgeArgv } from "./release-driver/release-driver-owner-steps.mjs";
import { linkLogins, signinCheck, actDefaults } from "./onduty.mjs";
import { isRoot, inside } from "./checkout-guard.mjs";

export const RELEASE_PROGRAMS = /^(auto-stage|freeze|stage-server)$/, STOP_MAX_HOURS = 2;
export const ALLOWED_RESTART = String(process.env.FD_RESTART_UNITS || "").split(",").map(x => x.trim()).filter(Boolean);
export const NEVER_TOUCH = String(process.env.FD_NEVER_TOUCH || "").split(",").map(x => x.trim()).filter(Boolean);
const FORBIDDEN = process.env.FD_NEVER_TOUCH_PATTERN ? new RegExp(process.env.FD_NEVER_TOUCH_PATTERN, "i") : /(?!)/;
export const FACTORY_USER_UNIT = /^(archonfactory-[A-Za-z0-9_.@-]+|docker)\.(service|timer)$/;
export const STALE_CMD = /standin_ai\.py|chromium|main\.mjs/;
export const DISK_PCT = 85, MEM_PCT = 15, MEM_RESTORE_PCT = 40;
export const DEFAULT_MAX_LAPS = 4;
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const LOWERED = /^# factory-driver: MAX_LAPS lowered from (\S+) at (\S+)$/m;

export const hkDefaults = (e = process.env) => ({
  FORGE_USER: e.FORGE_USER || "factory",
  FORGE_UID: String(e.FORGE_UID || "1000"),
  FORGE_NETNS: e.FD_FORGE_NETNS !== undefined ? e.FD_FORGE_NETNS : "",
  SYSTEMCTL: e.FD_SYSTEMCTL || "systemctl",
  FACTORY_ENV: e.FD_FACTORY_ENV || "/home/factory/.factory-env",
  FACTORY_CHECKOUT: e.FD_FACTORY_CHECKOUT || "/home/factory/repository",
  // the factory user's home and each project's checkout ({ project: folder }), as the settings name them (world.mjs reads the same)
  FORGE_HOME: e.FD_FORGE_HOME || `/home/${e.FORGE_USER || "factory"}`,
  PROJECT_CHECKOUTS: (() => { try { const v = JSON.parse(e.FD_PROJECT_CHECKOUTS || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } })(),
  STALE_MINUTES: Number(e.FD_STALE_MINUTES || 180),
  LOWER_LAPS: e.FD_LOWER_LAPS === "1",
  LOGIN_UNIT: e.FD_LOGIN_UNIT || "",
  LEGACY_UNITS: String(e.FD_LEGACY_UNITS || "").split(",").map(x => x.trim()).filter(Boolean),
});

function run(argv, { maxBuffer, timeout } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: timeout || 10 * 60000, env: { PATH: SYSTEM_PATH }, ...(maxBuffer ? { maxBuffer } : {}) }); // SIGTERM at the limit: runuser hands it on
  return { status: r.status, stdout: r.stdout || "", stderr: (r.stderr || "") + (r.error ? r.error.message : "") };
}
const lastLine = t => String(t || "").trim().split("\n").pop() || "";
const norm = s => String(s || "").replace(/\s+/g, " ").trim();
// A command as the factory user, inside its network namespace, with a clean environment.
const asForge = (env, cmd, extra = []) => forgeArgv(env, ["env", "-i", `HOME=/home/${env.FORGE_USER}`, `PATH=/home/${env.FORGE_USER}/.local/bin:/usr/local/bin:/usr/bin:/bin`, "LANG=C.UTF-8",
  `XDG_RUNTIME_DIR=/run/user/${env.FORGE_UID}`, ...extra, ...cmd]).flat();

// The unit's scope: "user" for the factory user's own units, "system" otherwise. Accepts a name,
// "user:<name>", or {name, user|scope}.
const unitOf = u => {
  if (u && typeof u === "object") return { name: String(u.name || ""), user: u.user === true || u.scope === "user" };
  const s = String(u || "");
  return s.startsWith("user:") ? { name: s.slice(5), user: true } : { name: s, user: /^archonfactory-/.test(s) };
};

// deps: {run(argv, {maxBuffer}) -> {status, stdout, stderr}, sleep(ms), now(), readFile, writeFile, root, exists(path)}
// -> {done: [string], failed: [string], repairs: [what a repair changed, for the round's record]}
export async function housekeep(env0, world, deps = {}) {
  const env = { ...hkDefaults(process.env), ...env0 };
  const exec = (argv, opts) => {
    const line = argv.join(" ");
    if (FORBIDDEN.test(line)) throw new Error(`refused: ${line.slice(0, 200)} touches a service of the owner's that the factory never touches`);
    return (deps.run || run)(argv, opts);
  };
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const out = { done: [], failed: [], repairs: [] };
  const server = (world && world.server) || {};

  // ---- stale processes: read again, then stop only what is still exactly the same process
  for (const p of server.staleProcs || []) {
    const pid = Number(p.pid);
    if (!Number.isInteger(pid) || pid <= 1) { out.failed.push(`process ${p.pid}: not a process number`); continue; }
    const look = () => { const r = exec(["ps", "-o", "uid=,etimes=,args=", "-p", String(pid)]); const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(String(r.stdout || "").trim()); return r.status === 0 && m ? { uid: m[1], ageMin: Math.floor(Number(m[2]) / 60), cmd: m[3] } : null; };
    const same = f => f && f.uid === env.FORGE_UID && norm(f.cmd).slice(0, 200) === norm(p.cmd).slice(0, 200) && f.ageMin >= env.STALE_MINUTES && STALE_CMD.test(f.cmd) && !FORBIDDEN.test(f.cmd);
    try {
      const fresh = look();
      if (!fresh) { out.done.push(`process ${pid} had already ended`); continue; }
      if (!same(fresh)) { out.failed.push(`process ${pid} not stopped: it is no longer the stale ${norm(p.cmd).slice(0, 80)} the round saw`); continue; }
      exec(["kill", "-TERM", String(pid)]);
      await sleep(10000);
      const after = look();
      if (after && same(after)) exec(["kill", "-KILL", String(pid)]);
      out.done.push(`stopped stale process ${pid} (${fresh.ageMin} minutes old: ${norm(fresh.cmd).slice(0, 80)})`);
    } catch (e) { out.failed.push(`process ${pid}: ${lastLine(e.message).slice(0, 200)}`); }
  }

  // ---- failed units: the allowlist and the factory user's own units, nothing else
  for (const u of server.failedUnits || []) {
    const { name, user } = unitOf(u);
    if (!/^[A-Za-z0-9_.@-]+\.(service|timer|socket)$/.test(name)) { out.failed.push(`${name}: not a unit name`); continue; }
    if (NEVER_TOUCH.includes(name) || FORBIDDEN.test(name)) { out.failed.push(`${name} is one of the owner's own services: never touched`); continue; }
    if (/^factory-helper-/.test(name)) continue; // a helper's own unit: the driver collects it
    if (isLegacy(env, name)) continue; // a unit of the program this driver replaced: left alone, never started
    let argv = null;
    if (!user && ALLOWED_RESTART.includes(name)) {
      // a unit with a timer of its own (the test machine, auto-stage, the login) is left to that timer:
      // restarting it every round would run it every five minutes, and a stop may be deliberate (seen
      // live 2026-11-18: a session stopped the test machine at 16:19 and the round started it again);
      // saying so sends the ops helper
      const timer = name.replace(/\.service$/, ".timer");
      if (timer !== name) { try { if (String(exec([env.SYSTEMCTL, "show", "-p", "LoadState", "--value", timer]).stdout || "").trim() === "loaded") { out.failed.push(`${name} failed; it has a timer of its own, which runs it again, so it is not restarted here`); continue; } } catch {} }
      // --no-block: a restart never waits for the unit's run (seen live 2026-11-18: the test machine's
      // run held a round for minutes)
      argv = [env.SYSTEMCTL, "restart", name, "--no-block"];
    }
    else if (user && FACTORY_USER_UNIT.test(name)) argv = asForge(env, ["systemctl", "--user", "restart", name]);
    if (!argv) { out.failed.push(`${name} failed and is not on the restart list; left alone`); continue; }
    try {
      const r = exec(argv);
      if (r.status === 0) out.done.push(`restarted ${user ? "the factory user's " : ""}${name}`);
      else out.failed.push(`${name} did not restart: ${lastLine(r.stderr).slice(0, 200) || `exit ${r.status}`}`);
    } catch (e) { out.failed.push(`${name}: ${lastLine(e.message).slice(0, 200)}`); }
  }

  // ---- one-off units from systemd-run (run-u20604.service): they belong to nobody, so only their failed state is cleared
  for (const name of server.anonymousFailedUnits || []) {
    if (!ANONYMOUS_UNIT.test(name)) { out.failed.push(`${name}: not a one-off unit name`); continue; }
    try {
      const r = exec([env.SYSTEMCTL, "reset-failed", name]);
      if (r.status === 0) out.done.push(`reset the failed state of one-off unit ${name}`);
      else out.failed.push(`${name} was not reset: ${lastLine(r.stderr).slice(0, 200) || `exit ${r.status}`}`);
    } catch (e) { out.failed.push(`${name}: ${lastLine(e.message).slice(0, 200)}`); }
  }

  // ---- the factory's GitHub login
  if (server.logins && server.logins.gh === false && env.LOGIN_UNIT) {
    try {
      const r = exec([env.SYSTEMCTL, "start", env.LOGIN_UNIT]);
      if (r.status === 0) out.done.push(`renewed the factory's GitHub login (${env.LOGIN_UNIT})`);
      else out.failed.push(`the factory's GitHub login was not renewed: ${lastLine(r.stderr).slice(0, 200) || `exit ${r.status}`}`);
    } catch (e) { out.failed.push(`login: ${lastLine(e.message).slice(0, 200)}`); }
  }

  // ---- the acting runs' AI sign-in (the Forge 0.3.1, ticket 04): the links back to the factory user's files, then one tiny check.
  // A provider that answers is marked repaired (world.actLoginsRepaired), so its login obstacle clears and its runs start again.
  const act = (env0 && env0.ACT) || actDefaults(process.env);
  for (const provider of Object.keys((world && world.actLogins) || {})) {
    if (!["claude", "codex"].includes(provider)) continue;
    try {
      const links = (deps.linkLogins || linkLogins)(act.FACTORY_HOME, act.ACT_DIR, provider);
      const moved = links.filter(l => l.did !== "kept");
      const check = (deps.signinCheck || signinCheck)(act, provider);
      const what = moved.length ? `linked ${moved.map(l => `${l.file}${l.aside ? ` (the file there kept as ${path.basename(l.aside)})` : ""}`).join(", ")} again` : "its links were in place";
      if (check.ok) { out.done.push(`the acting runs sign in to ${provider} again: ${what}, and a sign-in check (${check.why}) worked`); ((world.actLoginsRepaired ||= [])).push(provider); }
      else out.failed.push(`the acting runs still cannot sign in to ${provider}: ${what}, but the sign-in check failed (${check.why})`);
    } catch (e) { out.failed.push(`the acting runs' ${provider} sign-in: ${lastLine(e.message).slice(0, 200)}`); }
  }

  // ---- the factory's checkouts (the Forge 0.3.1, ticket 08, issue #157): each one is the factory user's alone, and its fetch works.
  // On 2026-11-22 a root process checked out a branch in the main checkout; from then on the factory user's `git fetch` failed on a
  // file root owned and the factory built on a main a day old until a person gave the files back two days later. Every round, for
  // each checkout in the factory user's home: the files another user owns are found and given back with a chown limited to that
  // checkout, on its own filesystem, never through a link, and `git fetch` runs as the factory user to prove it works. Only as root
  // (only root can give files back). A factory that runs as root owns its checkouts as root and no file can stop root's fetch, so
  // there only the fetch is checked.
  const root = deps.root !== undefined ? !!deps.root : isRoot();
  const user = String(env.FORGE_USER || ""), home = String(env.FORGE_HOME || "").replace(/\/+$/, "");
  const absolute = p => /^(\/|[A-Za-z]:\/)[^\s]*$/.test(p); // the server's folders (a Windows test machine's C:/ too), none with a space
  if (root && user && home.length > 1 && absolute(home)) {
    const named = [...Object.values(env.PROJECT_CHECKOUTS || {}), env.FACTORY_CHECKOUT].filter(c => typeof c === "string" && c);
    const exists = deps.exists || (p => fs.existsSync(p));
    const real = deps.realpath || (p => fs.realpathSync(p));
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    for (const c of [...new Set(named)]) {
      // only a folder strictly inside the factory user's home, named plainly, holding a git checkout, and none of the owner's own
      if (!absolute(c) || path.posix.normalize(c) !== c || c.endsWith("/") || c === home || !inside(c, home) || FORBIDDEN.test(c) || !exists(path.posix.join(c, ".git"))) continue;
      // and reached through no link: the factory's laps run as that user and could point a link elsewhere, where a chown must never go
      let through = ""; try { through = String(real(c)).replace(/\\/g, "/"); } catch { continue; }
      if (through !== c) { out.failed.push(`the factory's checkout ${c} is reached through a link (it is ${through.slice(0, 200)}), so its owners were not checked`); continue; }
      // `find` walks the checkout itself: one filesystem (-xdev), links never followed; -execdir gives each file back from its own folder
      const notTheirs = ["find", c, "-xdev", "!", "-user", user];
      const foreign = () => {
        const r = exec([...notTheirs, "-printf", "%u\\t%P\\n"], { maxBuffer: 256 * 1024 * 1024, timeout: 120000 });
        if (r.status !== 0) return { error: lastLine(r.stderr) || `exit ${r.status}` };
        const files = String(r.stdout || "").split("\n").filter(Boolean).map(l => { const i = l.indexOf("\t"); return { owner: l.slice(0, i), rel: l.slice(i + 1) }; });
        return { files };
      };
      try {
        const seen = user === "root" ? { files: [] } : foreign();
        if (seen.error) { out.failed.push(`the owners of the files in the factory's checkout ${c} could not be read: ${seen.error.slice(0, 200)}`); continue; }
        let repair = null;
        if (seen.files.length) {
          const gitOwn = seen.files.filter(f => f.rel === ".git" || f.rel.startsWith(".git/"));
          const owners = [...new Set(seen.files.map(f => f.owner))].sort();
          const sample = [...gitOwn, ...seen.files.filter(f => !gitOwn.includes(f))].slice(0, 3).map(f => f.rel);
          const ch = exec([...notTheirs, "-execdir", "chown", "-h", "--", `${user}:`, "{}", "+"], { timeout: 300000 });
          const left = ch.status === 0 ? foreign() : null;
          if (ch.status !== 0 || !left || left.error || left.files.length) {
            const why = ch.status !== 0 ? lastLine(ch.stderr) || `exit ${ch.status}` : left && left.error ? `its owners could not be read again: ${left.error}` : `${plural(left.files.length, "file is", "files are")} still not its`;
            out.failed.push(`the factory's checkout ${c} has ${plural(seen.files.length, "file that is", "files that are")} not ${user}'s (${owners.join(", ")}: ${sample.join(", ")}), and it could not be given back: ${why.slice(0, 200)}`);
          } else repair = { what: "checkout ownership", checkout: c, files: seen.files.length, gitFiles: gitOwn.length, owners, sample };
        }
        // a minute at most: one stalled remote must never hold the round (it has ten minutes in all)
        const f = exec(asForge(env, ["git", "-C", c, "fetch", "--quiet", "--no-write-fetch-head", "origin"], [`HOME=${home}`, "GIT_TERMINAL_PROMPT=0"]), { timeout: 60000 });
        const fetched = f.status === 0;
        if (!fetched) out.failed.push(`the factory's checkout ${c} cannot fetch: ${(lastLine(f.stderr) || `exit ${f.status}`).slice(0, 200)}`);
        if (repair) {
          out.repairs.push({ ...repair, fetch: fetched ? "works" : `fails: ${(lastLine(f.stderr) || `exit ${f.status}`).slice(0, 200)}` });
          out.done.push(`gave the factory's checkout ${c} back to ${user}: ${plural(repair.files, "file was", "files were")} not its (${repair.owners.join(", ")})${repair.gitFiles ? `, ${repair.gitFiles} of them git's own (${repair.sample.filter(s => s === ".git" || s.startsWith(".git/")).slice(0, 1).join("")})` : ""}; its git fetch ${fetched ? "works again" : "still fails"}`);
        }
      } catch (e) { out.failed.push(`the factory's checkout ${c}: ${lastLine(e.message).slice(0, 200)}`); }
    }
  }

  // ---- disk: Archon's own cleanup (worktrees idle a day; it skips any a live run holds), then Docker
  if (Number.isFinite(server.diskPct) && server.diskPct > DISK_PCT) {
    let source = "";
    try { source = JSON.parse((deps.readFile || (f => fs.readFileSync(f, "utf8")))(path.posix.join(env.FACTORY_CHECKOUT, ".factory", "consumer.json"))).source || ""; } catch {}
    if (!source) out.failed.push("disk: the factory's Archon source is not known (.factory/consumer.json), so its worktrees were not cleaned");
    else {
      try {
        const r = exec(asForge(env, ["bun", path.posix.join(source, "packages", "cli", "src", "cli.ts"), "isolation", "cleanup", "1"]));
        if (r.status === 0) out.done.push(`cleaned Archon worktrees idle for a day or more (${lastLine(r.stdout).slice(0, 120) || "done"})`);
        else out.failed.push(`Archon's cleanup failed: ${lastLine(r.stderr || r.stdout).slice(0, 200) || `exit ${r.status}`}`);
      } catch (e) { out.failed.push(`Archon's cleanup: ${lastLine(e.message).slice(0, 200)}`); }
    }
    try {
      const r = exec(asForge(env, ["docker", "system", "prune", "-f"], [`DOCKER_HOST=unix:///run/user/${env.FORGE_UID}/docker.sock`]));
      if (r.status === 0) out.done.push(`pruned the factory user's Docker (${lastLine(r.stdout).slice(0, 120) || "done"})`);
      else out.failed.push(`docker prune failed: ${lastLine(r.stderr).slice(0, 200) || `exit ${r.status}`}`);
    } catch (e) { out.failed.push(`docker prune: ${lastLine(e.message).slice(0, 200)}`); }
  }

  // ---- a factory timer the round found stopped for two rounds (while the network guard was not running)
  for (const name of ((world && world.timersToStart) || []).filter(n => !isLegacy(env, n))) {
    if (!/^archonfactory-[A-Za-z0-9_.-]+\.timer$/.test(String(name))) { out.failed.push(`${name}: not one of the factory's timers; left alone`); continue; }
    try {
      const r = exec(asForge(env, ["systemctl", "--user", "start", name]));
      if (r.status === 0) out.done.push(`started ${name} again (the factory user's timer had stopped)`);
      else out.failed.push(`${name} did not start: ${lastLine(r.stderr).slice(0, 200) || `exit ${r.status}`}`);
    } catch (e) { out.failed.push(`${name}: ${lastLine(e.message).slice(0, 200)}`); }
  }

  // ---- the factory's STOP (never a PAUSE): removed only when its writer ended and no candidate's scenarios run
  for (const f of (world && world.factories) || []) {
    const st = f && f.stop;
    if (!st || !st.writer || !Number.isInteger(st.pid) || st.writerAlive !== false) continue;
    // Only a forgotten STOP of a long-running release program (auto-stage, the freeze, the stage-server install) that has ended, and
    // only after that program's own maximum (2 hours). A PAUSE file is a pause: NO program ever removes it, whoever wrote it
    // (the operator's `consumer.py pause` ends a second after writing, so its writer is always "ended").
    if (st.kind === "PAUSE" || /\/\.factory\/PAUSE$/.test(String(st.file || ""))) continue;
    if (!RELEASE_PROGRAMS.test(String(st.writer))) continue;
    const ageMs = (deps.now ? deps.now() : Date.now()) - Date.parse(st.at);
    if (!(ageMs >= STOP_MAX_HOURS * 3600000)) continue;
    // scenarios still running keep a STOP for a while (their own maximum); a STOP older than twice its writer's maximum goes anyway
    if (st.scenariosRunning !== false && !(ageMs >= 2 * STOP_MAX_HOURS * 3600000)) continue;
    // a PAUSE that is a link to this STOP would be deleted with it: then the STOP stays
    try {
      const lst = deps.lstat || (p => fs.lstatSync(p)), real = deps.realpath || (p => fs.realpathSync(p));
      const pausePath = String(st.file).replace(/STOP$/, "PAUSE");
      let linked = false;
      try { linked = lst(String(st.file)).isSymbolicLink(); } catch (e) { if (e && e.code !== "ENOENT") linked = true; } // an unreadable answer fails closed
      try { if (!linked) linked = real(pausePath) === real(String(st.file)); } catch (e) { if (e && e.code && e.code !== "ENOENT") linked = true; } // only "no such file" means there is no PAUSE
      if (linked) { out.failed.push(`${st.file} not removed: a PAUSE file points at it`); continue; }
    } catch { /* cannot look: leave it */ continue; }
    if (!/\/\.factory\/STOP$/.test(String(st.file || "")) || FORBIDDEN.test(st.file)) { out.failed.push(`${st.file}: not a factory STOP file`); continue; }
    try {
      const read = deps.readFile || (p => fs.readFileSync(p, "utf8"));
      let now = ""; try { now = String(read(st.file)).split(/\r?\n/)[0].trim(); } catch { out.done.push(`${st.file} is gone already`); continue; }
      if (now !== st.line) { out.failed.push(`${st.file} not removed: it changed since the round read it`); continue; }
      const r = exec(["ps", "-o", "args=", "-p", String(st.pid)]);
      if (r.status === 0 && String(r.stdout || "").includes(st.writer)) { out.failed.push(`${st.file} not removed: its writer ${st.writer} ${st.pid} runs again`); continue; }
      const dead = (r.status === 1 && !String(r.stdout || "").trim()) || (r.status === 0 && !String(r.stdout || "").includes(st.writer));
      if (!dead) { out.failed.push(`${st.file} not removed: the process table could not be read, so the writer is not known to have ended`); continue; } // fails closed
      (deps.remove || (p => fs.rmSync(p, { force: true })))(st.file);
      out.done.push(`removed ${st.file} ("${st.line}"): its writer ${st.writer} ${st.pid} has ended and no candidate's scenarios run, so the factory runs again`);
    } catch (e) { out.failed.push(`${st.file}: ${lastLine(e.message).slice(0, 200)}`); }
  }

  // ---- memory: fewer laps while it is tight, the old number back once it is plentiful (switched off:
  // nothing reads MAX_LAPS yet, so tight memory is an obstacle for the ops helper)
  if (env.LOWER_LAPS && Number.isFinite(server.memAvailPct) && (server.memAvailPct < MEM_PCT || server.memAvailPct >= MEM_RESTORE_PCT)) {
    try {
      const read = deps.readFile || (f => fs.readFileSync(f, "utf8"));
      const write = deps.writeFile || ((f, t) => fs.writeFileSync(f, t)); // in place: the file keeps its owner and mode
      let text = ""; try { text = read(env.FACTORY_ENV); } catch { text = ""; }
      const m = /^MAX_LAPS=(\d+)\s*$/m.exec(text);
      const mark = LOWERED.exec(text);
      if (server.memAvailPct < MEM_PCT) {
        const cur = m ? Number(m[1]) : DEFAULT_MAX_LAPS;
        if (cur > 1) {
          const next = cur - 1;
          let t = m ? text.replace(/^MAX_LAPS=\d+\s*$/m, `MAX_LAPS=${next}`) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}MAX_LAPS=${next}\n`;
          if (!mark) t = `${t}${t.endsWith("\n") ? "" : "\n"}# factory-driver: MAX_LAPS lowered from ${m ? m[1] : "unset"} at ${new Date(deps.now ? deps.now() : Date.now()).toISOString()}\n`;
          write(env.FACTORY_ENV, t);
          out.done.push(`memory is tight (${server.memAvailPct}% available): MAX_LAPS ${cur} -> ${next}`);
        }
      } else if (mark) {
        const was = mark[1];
        let t = text.replace(LOWERED, "").replace(/\n{2,}$/, "\n");
        t = was === "unset" ? t.replace(/^MAX_LAPS=\d+\s*\n?/m, "") : t.replace(/^MAX_LAPS=\d+\s*$/m, `MAX_LAPS=${was}`);
        write(env.FACTORY_ENV, t);
        out.done.push(`memory is plentiful again (${server.memAvailPct}% available): MAX_LAPS back to ${was}`);
      }
    } catch (e) { out.failed.push(`MAX_LAPS: ${lastLine(e.message).slice(0, 200)}`); }
  }
  return out;
}
