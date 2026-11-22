#!/usr/bin/env node
// The factory driver's keeper (2026-11-18, plan Task 10): it keeps the driver's last good version, puts
// it back when a newer one keeps failing, and repairs the driver when the outside check asks.
//
// WHY. The driver keeps the factory moving, so when the driver itself breaks (a bad update, a stopped
// timer, a lock left behind) nothing moves and nobody is told until Michael notices. systemd keeps the
// driver's timer going; this keeps the driver's code good and answers the outside check's "repair".
//
// WHAT. The driver's installed file set is its programs and briefs (/usr/local/lib/godspeed-forge/
// factory-driver/**), the release-driver modules it imports (.../release-driver/**) and its two units
// (factory-driver.service and .timer). The keeper lives OUTSIDE that set
// (/usr/local/lib/godspeed-factory-driver/keeper.mjs, its own units and the drop-in that hooks it to the
// driver), imports nothing from it at load time, and so still works when the set is broken.
//
//   node keeper.mjs before-install   install.sh, before it copies: saves the installed set
//   node keeper.mjs installed        install.sh, after the copy was verified: records the new set; the
//                                    set it replaced is kept in previous/
//   node keeper.mjs clean            factory-driver-keeper.service (OnSuccess): counts a clean round (one
//                                    that wrote the heartbeat); after 3 the set is copied to last-good/
//   node keeper.mjs failed           factory-driver-rollback.service (OnFailure): counts a failed round;
//                                    after 3 in a row on a set younger than last-good, last-good goes back
//                                    byte for byte, it is logged, and Michael gets one sentence
//   node keeper.mjs repair           factory-driver-repair.service, started by the outside check's single
//                                    word `repair`: nothing when the driver is healthy; else restart its
//                                    timer, clear its failed state, remove a lock no round holds, run one
//                                    round; still not healthy (or a release stuck) -> one ops helper with
//                                    the driver's code, journal and state as context (at most one an hour)
//   node keeper.mjs status           what the keeper knows, as JSON
//
// A person who stops the driver on purpose writes a reason into /usr/local/lib/godspeed-factory-driver/HOLD;
// while it is there, repair changes nothing.
// State: /var/lib/godspeed-factory-driver/keeper.json; every action also goes to decisions.jsonl.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIN = 60000, HOUR = 60 * MIN;
const iso = ms => new Date(ms).toISOString();
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const CLEAN_TO_GOOD = 3, FAILS_TO_ROLLBACK = 2, BROKEN_MINUTES = 20, STUCK_HOURS = 6, REPAIR_HELPER_EVERY_MINUTES = 60;

export const keeperDefaults = (e = process.env) => ({
  HOME_DIR: e.FD_KEEPER_HOME || "/usr/local/lib/godspeed-factory-driver",
  STATE_DIR: e.FD_STATE_DIR || "/var/lib/godspeed-factory-driver",
  ROOTS: { fd: e.FD_LIB || "/usr/local/lib/godspeed-forge/factory-driver", rd: e.FD_RD_LIB || "/usr/local/lib/godspeed-forge/release-driver", units: e.FD_UNITS_DIR || "/etc/systemd/system" },
  UNITS: ["factory-driver.service", "factory-driver.timer"],
  SERVICE: "factory-driver.service", TIMER: "factory-driver.timer",
  SYSTEMCTL: e.FD_SYSTEMCTL || "systemctl",
  GODSPEED_DIR: e.FD_GODSPEED_DIR || "/root/godspeed",
  NOTICES_FILE: e.FD_NOTICES_FILE,
  LOCK_POLL_MS: Number(e.FD_LOCK_POLL_MS || 5000),
  LOCK_WAIT_MS: Number(e.FD_LOCK_WAIT_MS || 11 * MIN),
});

// ---------------------------------------------------------------- files
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function writeJson(f, data) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(data, null, 2) + "\n"); fs.renameSync(t, f); }
const keeperFile = env => path.join(env.STATE_DIR, "keeper.json");
export const readKeeper = env => readJson(keeperFile(env), {}) || {};
const writeKeeper = (env, k) => writeJson(keeperFile(env), k);
const dirOf = (env, name) => path.join(env.HOME_DIR, name);
function record(env, deps, e) { try { fs.mkdirSync(env.STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(env.STATE_DIR, "decisions.jsonl"), JSON.stringify({ at: iso(now(deps)), ...e }) + "\n"); } catch {} }
const now = deps => (deps && deps.now ? deps.now() : Date.now());
function run(argv, timeout = 120000) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout, env: { PATH: SYSTEM_PATH } });
  return { status: r.status, stdout: r.stdout || "", stderr: (r.stderr || "") + (r.error ? r.error.message : "") };
}
const exec = (deps, argv, timeout) => (deps.run || run)(argv, timeout);

// ---------------------------------------------------------------- the set
const walk = (dir, rel = "") => {
  let out = [];
  let names = []; try { names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out = out.concat(walk(dir, r));
    else if (d.isFile() && !/\.keeper-tmp$/.test(d.name)) out.push(r);
  }
  return out;
};
// -> {key: absolute path}, keys "fd/<file>", "rd/<file>", "units/<unit>"
export function listSet(env) {
  const out = {};
  for (const root of ["fd", "rd"]) for (const r of walk(env.ROOTS[root])) out[`${root}/${r}`] = path.join(env.ROOTS[root], ...r.split("/"));
  for (const u of env.UNITS) { const f = path.join(env.ROOTS.units, u); if (fs.existsSync(f)) out[`units/${u}`] = f; }
  return out;
}
const keyPath = (env, key) => { const [root, ...rest] = key.split("/"); if (!env.ROOTS[root] || !rest.length || rest.some(p => p === ".." || !p)) throw new Error(`not a set file: ${key}`); return path.join(env.ROOTS[root], ...rest); };
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const idOf = files => sha(Object.keys(files).sort().map(k => `${files[k].sha256} ${k}`).join("\n")).slice(0, 16);
// -> {id, files: {key: {sha256, mode}}}
export function manifestOf(env, set = listSet(env)) {
  const files = {};
  for (const [k, f] of Object.entries(set)) files[k] = { sha256: sha(fs.readFileSync(f)), mode: fs.statSync(f).mode & 0o777 };
  return { id: idOf(files), files };
}
// The installed set copied into dir (files/<key> and manifest.json), replacing what dir held.
export function snapshot(env, dir, deps = {}) {
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  const set = listSet(env), files = {};
  for (const [k, f] of Object.entries(set)) {
    const buf = fs.readFileSync(f);
    const to = path.join(tmp, "files", ...k.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, buf);
    files[k] = { sha256: sha(buf), mode: fs.statSync(f).mode & 0o777 };
  }
  const m = { id: idOf(files), savedAt: iso(now(deps)), files };
  writeJson(path.join(tmp, "manifest.json"), m);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(tmp, dir);
  return m;
}
const copyDir = (from, to) => { fs.rmSync(to, { recursive: true, force: true }); fs.cpSync(from, to, { recursive: true }); };
// Puts the set saved in dir back, byte for byte: every file written in place (temp file and rename,
// its mode kept), every set file the saved set does not have removed, systemd reloaded, then the
// installed set read again and compared. -> {ok, id, restored, removed}
export function restore(env, dir, deps = {}) {
  const m = readJson(path.join(dir, "manifest.json"), null);
  if (!m || !m.files) throw new Error(`${dir} holds no saved set`);
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  for (const [k, meta] of Object.entries(m.files)) {
    const buf = fs.readFileSync(path.join(dir, "files", ...k.split("/")));
    if (sha(buf) !== meta.sha256) throw new Error(`the saved copy of ${k} is damaged; nothing restored from it`);
  }
  let restored = 0;
  for (const [k, meta] of Object.entries(m.files)) {
    const to = keyPath(env, k), tmp = `${to}.keeper-tmp`;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(tmp, fs.readFileSync(path.join(dir, "files", ...k.split("/"))));
    try { fs.chmodSync(tmp, meta.mode); if (asRoot) fs.chownSync(tmp, 0, 0); } catch {}
    fs.renameSync(tmp, to);
    restored++;
  }
  const removed = [];
  for (const [k, f] of Object.entries(listSet(env))) if (!m.files[k]) { fs.rmSync(f, { force: true }); removed.push(k); }
  exec(deps, [env.SYSTEMCTL, "daemon-reload"]);
  const live = manifestOf(env);
  return { ok: live.id === m.id, id: live.id, restored, removed: removed.sort() };
}

// ---------------------------------------------------------------- the round lock (the driver's own)
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const cmdlineOf = pid => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch { return ""; } };
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Holds the driver's round.lock while fn runs, so no round starts on a half-restored set. A live
// round's lock is waited for; a dead one's is taken over (the driver does the same).
function withRoundLock(env, deps, fn) {
  const f = path.join(env.STATE_DIR, "round.lock");
  const alive = deps.alive || isAlive;
  const deadline = now(deps) + env.LOCK_WAIT_MS;
  for (let tries = 0; ; tries++) {
    try {
      const fd = fs.openSync(f, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: iso(now(deps)), by: "keeper" })); fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = readJson(f, null);
      if (held && Number.isInteger(held.pid) && held.pid !== process.pid && alive(held.pid)) {
        if (now(deps) > deadline || tries > 10000) throw new Error(`a round (process ${held.pid}) still holds the lock`);
        (deps.sleepSync || sleepSync)(env.LOCK_POLL_MS);
        continue;
      }
      fs.rmSync(f, { force: true });
    }
  }
  try { return fn(); } finally { try { if ((readJson(f, {}) || {}).pid === process.pid) fs.rmSync(f, { force: true }); } catch {} }
}

// ---------------------------------------------------------------- install
const heartbeatAt = env => { try { const t = Date.parse(fs.readFileSync(path.join(env.STATE_DIR, "heartbeat"), "utf8").trim()); return Number.isFinite(t) ? t : null; } catch { return null; } };
export function beforeInstall(env, deps = {}) {
  const m = snapshot(env, dirOf(env, "incoming-previous"), deps);
  return { saved: Object.keys(m.files).length, id: m.id };
}
// The set it replaced ran clean: its last round wrote the heartbeat within 15 minutes and succeeded.
function ranClean(env, deps) {
  const hb = heartbeatAt(env);
  if (!hb || now(deps) - hb > 15 * MIN) return false;
  return String(exec(deps, [env.SYSTEMCTL, "show", env.SERVICE, "-p", "Result", "--value"]).stdout || "").trim() === "success";
}
export function installed(env, deps = {}) {
  const k = readKeeper(env), at = iso(now(deps));
  const live = manifestOf(env);
  const incoming = dirOf(env, "incoming-previous");
  const prev = readJson(path.join(incoming, "manifest.json"), null);
  if (k.current && k.current.id === live.id) { fs.rmSync(incoming, { recursive: true, force: true }); return { changed: false, id: live.id }; }
  // the first install with a keeper: the set that ran before it is last-good when its rounds were clean
  if (prev && !k.lastGood && ranClean(env, deps)) {
    copyDir(incoming, dirOf(env, "last-good"));
    k.lastGood = { id: prev.id, markedAt: at, why: "the set installed before the keeper existed ran clean" };
    record(env, deps, { kind: "keeper: marked the replaced set last-good", id: prev.id, why: k.lastGood.why });
  }
  if (prev && prev.id !== live.id) { fs.rmSync(dirOf(env, "previous"), { recursive: true, force: true }); fs.renameSync(incoming, dirOf(env, "previous")); }
  else fs.rmSync(incoming, { recursive: true, force: true });
  k.current = { id: live.id, installedAt: at, cleanRounds: 0 };
  k.failedInRow = 0;
  writeKeeper(env, k);
  record(env, deps, { kind: "keeper: a new set is installed", id: live.id, previous: prev ? prev.id : null, lastGood: k.lastGood ? k.lastGood.id : null });
  return { changed: true, id: live.id, previous: prev ? prev.id : null };
}

// ---------------------------------------------------------------- after each round
export function clean(env, deps = {}) {
  const k = readKeeper(env);
  const hb = heartbeatAt(env);
  if (!hb || (k.lastRoundAt && Date.parse(k.lastRoundAt) >= hb)) return { counted: false, why: "no new heartbeat: the round found another one still going" };
  k.lastRoundAt = iso(hb);
  k.failedInRow = 0;
  const live = manifestOf(env);
  if (!k.current || k.current.id !== live.id) k.current = { id: live.id, installedAt: iso(now(deps)), cleanRounds: 0, outside: "the files changed without install.sh" };
  k.current.cleanRounds = (k.current.cleanRounds || 0) + 1;
  let marked = false;
  if (k.current.cleanRounds >= CLEAN_TO_GOOD && (!k.lastGood || k.lastGood.id !== live.id)) {
    const m = snapshot(env, dirOf(env, "last-good"), deps);
    if (m.id === live.id) {
      k.lastGood = { id: m.id, markedAt: iso(now(deps)), why: `${k.current.cleanRounds} clean rounds` };
      marked = true;
      record(env, deps, { kind: "keeper: marked the installed set last-good", id: m.id, cleanRounds: k.current.cleanRounds });
    }
  }
  writeKeeper(env, k);
  return { counted: true, cleanRounds: k.current.cleanRounds, marked };
}

const ROLLBACK_TEXT = "Your factory driver failed two rounds in a row after its last update, so Mission Control put back the version that last ran cleanly and the factory keeps moving; the newer version waits for a fix.";
const ROLLBACK_FAILED_TEXT = "Your factory driver failed two rounds in a row after its last update, and putting back the version that last ran cleanly did not work, so Mission Control's outside check will start a repair.";
async function defaultTell(env, k, key, text, about, at) {
  const m = await import(pathToFileURL(path.join(env.ROOTS.rd, "release-driver-owner-steps.mjs")).href);
  return m.tell({ GODSPEED_DIR: env.GODSPEED_DIR, NOTICES_FILE: env.NOTICES_FILE }, k, key, text, about, at);
}
export async function failed(env, deps = {}) {
  const k = readKeeper(env), t = now(deps);
  k.failedInRow = (k.failedInRow || 0) + 1;
  k.lastFailedAt = iso(t);
  const live = manifestOf(env), lg = k.lastGood;
  const saved = lg && readJson(path.join(dirOf(env, "last-good"), "manifest.json"), null);
  const younger = !!(lg && saved && saved.id === lg.id && live.id !== lg.id && (!k.current || k.current.id !== live.id || Date.parse(k.current.installedAt) >= Date.parse(lg.markedAt)));
  if (k.failedInRow < FAILS_TO_ROLLBACK || !younger) { writeKeeper(env, k); return { rolledBack: false, failedInRow: k.failedInRow }; }
  let r;
  try {
    r = withRoundLock(env, deps, () => { snapshot(env, dirOf(env, "rolled-back"), deps); return restore(env, dirOf(env, "last-good"), deps); });
  } catch (e) { r = { ok: false, error: String(e.message).slice(0, 300) }; }
  k.rollbacks = [...(k.rollbacks || []).slice(-9), { at: iso(t), from: live.id, to: lg.id, ok: r.ok, ...(r.error ? { error: r.error } : {}) }];
  if (r.ok) { k.current = { id: lg.id, installedAt: iso(t), cleanRounds: 0, rolledBackFrom: live.id }; k.failedInRow = 0; }
  record(env, deps, { kind: r.ok ? "keeper: rolled back" : "keeper: rollback did not work", from: live.id, to: lg.id, failedRounds: FAILS_TO_ROLLBACK, removed: r.removed || [], ...(r.error ? { why: r.error } : {}) });
  try { await (deps.tell || defaultTell)(env, k, `rollback:${live.id}`, r.ok ? ROLLBACK_TEXT : ROLLBACK_FAILED_TEXT, "The factory driver was rolled back", t); }
  catch (e) { record(env, deps, { kind: "keeper: could not tell Michael", why: String(e.message).slice(0, 200) }); }
  writeKeeper(env, k);
  return { rolledBack: !!r.ok, from: live.id, to: lg.id, ...r };
}

// ---------------------------------------------------------------- health and repair
// The releases the driver drives now (state.json `releases`), not installed and not superseded, whose
// newest milestone (ledger.json) is older than STUCK_HOURS. -> [{id, lastMilestoneAt}]
export function releasesOf(stateDir) {
  const state = readJson(path.join(stateDir, "state.json"), null), ledger = readJson(path.join(stateDir, "ledger.json"), null);
  if (!state || !Array.isArray(state.releases) || !ledger) return null;
  const superseded = state.superseded || {};
  const out = [];
  for (const id of state.releases) {
    if (superseded[id]) continue;
    const tickets = Object.entries(ledger).filter(([k]) => k.slice(0, k.lastIndexOf("#")) === id).map(([, v]) => v || {});
    if (tickets.length && tickets.every(t => (t.milestones || []).some(m => m && m.kind === "installed"))) continue;
    const times = tickets.map(t => Date.parse(t.lastMilestoneAt)).filter(Number.isFinite);
    out.push({ id, lastMilestoneAt: times.length ? iso(Math.max(...times)) : null });
  }
  return out;
}
export const stuckReleases = (env, at) => (releasesOf(env.STATE_DIR) || []).filter(r => r.lastMilestoneAt && at - Date.parse(r.lastMilestoneAt) > STUCK_HOURS * HOUR);
export function health(env, deps = {}) {
  const t = now(deps);
  const out = (exec(deps, [env.SYSTEMCTL, "is-active", env.TIMER]).stdout || "").trim();
  const timerActive = out === "active";
  const serviceState = (exec(deps, [env.SYSTEMCTL, "show", env.SERVICE, "-p", "ActiveState", "--value"]).stdout || "").trim() || "unknown";
  const hb = heartbeatAt(env);
  let lock = null;
  const held = readJson(path.join(env.STATE_DIR, "round.lock"), null);
  if (held && Number.isInteger(held.pid)) {
    const alive = (deps.alive || isAlive)(held.pid);
    const cmd = alive ? (deps.cmdline || cmdlineOf)(held.pid) : "";
    const isRound = alive && /driver\.mjs|keeper\.mjs/.test(cmd);
    lock = { pid: held.pid, alive, stale: !isRound && serviceState !== "activating" && serviceState !== "active" };
  }
  const stuck = stuckReleases(env, t);
  const fresh = !!hb && t - hb <= BROKEN_MINUTES * MIN;
  return { healthy: timerActive && fresh && !(lock && lock.stale) && !stuck.length, timerActive, serviceState, lastRoundAt: hb ? iso(hb) : null, fresh,
    failedInRow: readKeeper(env).failedInRow || 0, lock, stuck };
}

const bullets = list => list.filter(Boolean).map(x => `- ${x}`).join("\n");
function helperContext(env, deps, h, changed, k) {
  const journal = String(exec(deps, ["journalctl", "-u", env.SERVICE, "-n", "60", "--no-pager", "-o", "short-iso"]).stdout || "").split("\n")
    .filter(l => l.trim() && !/pam_unix|session (opened|closed)/.test(l)).slice(-30).map(l => `    ${l.slice(0, 300)}`);
  let decisions = [];
  try { decisions = fs.readFileSync(path.join(env.STATE_DIR, "decisions.jsonl"), "utf8").trim().split("\n").slice(-15).map(l => `    ${l.slice(0, 300)}`); } catch {}
  const repairs = (k.repairs || []).slice(-5).map(r => `- ${r.at} repair: ${r.result}`).join("\n");
  return {
    OBSTACLE_ID: "driver", OBSTACLE_KIND: h.stuck.length && h.fresh ? "release-stuck" : "driver-broken", TICKET_KEY: "-", SINCE: h.lastRoundAt || "unknown",
    EVIDENCE: bullets([
      `The factory driver (a round every 5 minutes, factory-driver.timer, as root) ${h.fresh ? "runs" : `has had no clean round since ${h.lastRoundAt || "it was installed"}`}; its timer is ${h.timerActive ? "active" : "not active"}; failed rounds in a row: ${h.failedInRow}; its unit is ${h.serviceState}.`,
      ...h.stuck.map(r => `Release ${r.id} has had no milestone (a check turning green, a merge, a closed issue, staged, installed) since ${r.lastMilestoneAt}, although the driver runs.`),
      `What the keeper did before you: ${changed.join("; ") || "nothing it could do by itself"}.`,
      `The driver's code: ${env.ROOTS.fd} (driver.mjs is one round) and ${env.ROOTS.rd}; its state: ${env.STATE_DIR} (state.json, ledger.json, decisions.jsonl, helpers/<unit>/). They belong to root: read them, never change them.`,
      `The driver's journal, newest last:\n${journal.join("\n") || "    (empty)"}`,
      `Its last decisions, newest last:\n${decisions.join("\n") || "    (none)"}`,
    ]),
    HISTORY: repairs || "Nothing yet.",
    APPROACH_NOTE: "You run as the factory user, not as root: the driver's code, units and state belong to root and you cannot change them. Fix what is on the factory's side (its timers, logins, folders, Docker); when the cause is in the driver itself, name the file and the line in summary, set fixed to false and cause to how.",
  };
}
// The ops helper, through ai.mjs (imported only now, so a broken set never stops the keeper from loading).
async function defaultLaunch(env, { unit, kind, context }) {
  const ai = await import(pathToFileURL(path.join(env.ROOTS.fd, "ai.mjs")).href);
  const aenv = { ...ai.aiDefaults(process.env), STATE_DIR: env.STATE_DIR };
  const list = await ai.providers(aenv, ai.factoryProvider(aenv));
  if (!list.length) throw new Error("no AI is reachable right now");
  const p = list[0];
  await ai.launchHelper(aenv, { unit, kind, provider: p.name, model: p.strong || p.model, briefFile: path.join(env.ROOTS.fd, "helpers", "ops.md"), context });
  return { unit, provider: p.name, model: p.strong || p.model };
}
async function defaultResult(env, unit) {
  const ai = await import(pathToFileURL(path.join(env.ROOTS.fd, "ai.mjs")).href);
  return ai.helperResult({ ...ai.aiDefaults(process.env), STATE_DIR: env.STATE_DIR }, unit);
}
export async function repair(env, deps = {}) {
  const t = now(deps), k = readKeeper(env);
  const out = { at: iso(t), healthy: null, changed: [], helper: null, why: "" };
  const finish = () => {
    k.repairs = [...(k.repairs || []).slice(-19), { at: out.at, result: out.why, changed: out.changed, ...(out.helper ? { helper: out.helper.unit, state: out.helper.state } : {}) }];
    writeKeeper(env, k);
    record(env, deps, { kind: "keeper: repair asked", result: out.why, changed: out.changed, ...(out.helper ? { helper: out.helper.unit, state: out.helper.state, summary: String((out.helper.report || {}).summary || out.helper.reason || "").slice(0, 300) } : {}) });
    return out;
  };
  let hold = null; try { hold = fs.readFileSync(dirOf(env, "HOLD"), "utf8").trim().split("\n")[0] || "no reason given"; } catch {}
  if (hold) { out.why = `held: ${hold}`; return finish(); }
  let h = health(env, deps);
  if (h.healthy) { out.healthy = true; out.why = "the driver is healthy; nothing changed"; return finish(); }
  // the steps that need no AI
  const ok = argv => exec(deps, argv).status === 0;
  if (!h.timerActive && ok([env.SYSTEMCTL, "enable", "--now", env.TIMER])) out.changed.push(`started ${env.TIMER} again`);
  if (h.serviceState === "failed" && ok([env.SYSTEMCTL, "reset-failed", env.SERVICE])) out.changed.push("cleared the driver's failed state");
  if (h.lock && h.lock.stale) {
    try { if ((readJson(path.join(env.STATE_DIR, "round.lock"), {}) || {}).pid === h.lock.pid) fs.rmSync(path.join(env.STATE_DIR, "round.lock"), { force: true }); } catch {}
    out.changed.push(`removed a round lock held by process ${h.lock.pid}, which is ${h.lock.alive ? "not a round" : "no longer running"}`);
  }
  if (out.changed.length) {
    exec(deps, [env.SYSTEMCTL, "start", env.SERVICE], 12 * MIN); // one round now, to see whether that was all
    h = health(env, deps);
    if (h.healthy) { out.healthy = true; out.why = `repaired without a helper: ${out.changed.join("; ")}`; return finish(); }
  }
  out.healthy = false;
  // still not healthy, or a release does not move: one ops helper, at most one an hour
  if (k.lastRepairHelperAt && t - Date.parse(k.lastRepairHelperAt) < REPAIR_HELPER_EVERY_MINUTES * MIN) { out.why = `still not healthy; a repair helper ran less than an hour ago (${k.lastRepairHelperAt}), so none now`; return finish(); }
  let n = (k.repairSeq || 0) + 1;
  while (fs.existsSync(path.join(env.STATE_DIR, "helpers", `factory-helper-driverrepair-${n}`, "run.json"))) n++;
  const unit = `factory-helper-driverrepair-${n}`;
  k.repairSeq = n; k.lastRepairHelperAt = iso(t);
  let started;
  try { started = await (deps.launch || defaultLaunch)(env, { unit, kind: "ops", context: helperContext(env, deps, h, out.changed, k) }); }
  catch (e) { out.why = `still not healthy, and the repair helper could not start: ${String(e.message).slice(0, 200)}`; return finish(); }
  writeKeeper(env, k);
  // wait for it (its unit stops it after 30 minutes), then keep what it found
  const until = t + 36 * MIN;
  let res = { state: "running" };
  for (;;) {
    res = await (deps.result || defaultResult)(env, unit);
    if (res.state !== "running" || now(deps) > until) break;
    await (deps.sleep || (ms => new Promise(r => setTimeout(r, ms))))(30000);
  }
  out.helper = { unit, provider: started && started.provider, model: started && started.model, state: res.state, report: res.report || null, reason: res.reason || "" };
  out.why = res.state === "done" ? `a repair helper ran: ${String((res.report || {}).summary || "").slice(0, 300)}` : `a repair helper ran and ended without a report (${res.reason || res.state})`;
  return finish();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const env = keeperDefaults();
  const cmd = process.argv[2];
  const go = { "before-install": () => beforeInstall(env), installed: () => installed(env), clean: () => clean(env), failed: () => failed(env), repair: () => repair(env),
    status: () => ({ keeper: readKeeper(env), health: health(env), installed: manifestOf(env).id }) }[cmd];
  if (!go) { console.error("usage: keeper.mjs before-install|installed|clean|failed|repair|status"); process.exit(2); }
  Promise.resolve().then(go).then(r => console.log(JSON.stringify(r)), e => { console.error(e.stack || e.message); process.exit(1); });
}
