#!/usr/bin/env node
// The factory dead-man (architecture 5, 7, 9). A tiny program with its own timer that shares NO code with the
// factory driver. It reads plain files and the running Godspeed's /health, and applies dumb rules:
//
//   1. RELEASE: a release plan approved more than 72 hours ago (its approval time from the plan file's own history)
//      and not running on the server (the version /health reports is older), with no message about it in 24 hours:
//      one sentence to Michael through both transports. It does not read the driver's status for this.
//   2. DRIVER: the driver's status file is older than 20 minutes, or its last 3 rounds failed, or a release run filed a
//      repair request in the spool. First the deterministic rollback (the keeper's `repair`, before any AI); if the
//      driver is still unhealthy after 20 minutes a driver-repair run on Codex; after another hour one on Claude;
//      after both another hour: one sentence to Michael. A repair run may write the driver's install and never this
//      program, the journal or the units.
//   3. It keeps the driver's timer enabled (the driver does the same for this one's).
//   node factory-deadman.mjs [--dry-run]      node factory-deadman.mjs --run <dir>   (inside a repair unit)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOUR = 3600000, MIN = 60000;
export const RULES = { ceilingHours: 72, silenceHours: 24, driverStaleMinutes: 20, failedRounds: 3, rollbackGraceMinutes: 20, repairHours: 1 };
export const defaults = (e = process.env) => ({
  RELEASES: e.DM_RELEASES || "",
  DEV: e.DM_DEV || "",
  STATUS: e.DM_STATUS || "/var/lib/godspeed/forge/driver/status.json",
  KEEPER: e.DM_KEEPER || "/var/lib/godspeed/forge/driver/keeper.json",
  NODE: e.FD_NODE || process.execPath, // server.node: the node the units run
  KEEPER_BIN: e.DM_KEEPER_BIN || "/usr/local/lib/godspeed/forge/keeper/keeper.mjs",
  SPOOL: e.DM_SPOOL || "/var/lib/godspeed/forge/spool",
  STATE: e.DM_STATE || "/var/lib/godspeed/forge/deadman/state.json",
  ACTS: e.DM_ACTS || "/var/lib/godspeed/forge/deadman/acts",
  NOTICES: e.DM_NOTICES || "",
  HEALTH: e.DM_HEALTH || e.FD_HEALTH_URL || "",
  OWNER: e.FD_OWNER_LOGIN || "",
  FACTORY_HOME: e.FD_FORGE_HOME || "/home/factory",
  // the factory's checkouts: read-only for a repair run, which works on the driver (issue #157); its own copy of the list, as it shares no code
  CHECKOUTS: (() => { let m = {}; try { const v = JSON.parse(e.FD_PROJECT_CHECKOUTS || "{}"); if (v && typeof v === "object" && !Array.isArray(v)) m = v; } catch { /* none */ }
    return [...new Set([...Object.values(m), e.FD_SOURCE_CHECKOUT].filter(c => typeof c === "string" && /^\/[^\s]+$/.test(c)).map(c => path.posix.normalize(c).replace(/\/+$/, "")))]; })(),
  CLAUDE_BIN: (() => { const v = e.FD_CLAUDE_BIN || ""; try { const j = JSON.parse(v); return Array.isArray(j) ? j[0] : v; } catch { return v || `${e.FD_FORGE_HOME || "/home/factory"}/.local/bin/claude`; } })(),
  DRIVER_DIR: e.FD_LIB || "/usr/local/lib/godspeed/forge/driver",
  KEEPER_HOME: e.FD_KEEPER_HOME || "/usr/local/lib/godspeed/forge/keeper",
  STATE_DIR: e.FD_STATE_DIR || "/var/lib/godspeed/forge/driver",
  PLAN_PATTERN: e.FD_PLAN_PATTERN || "",
  TG_ENV: e.DM_TG_ENV || ((e.TG_MACHINE_ENV && fs.existsSync(e.TG_MACHINE_ENV)) ? e.TG_MACHINE_ENV : (e.TG_ENV || "")),
  WATCH_REPO: e.DM_WATCH_REPO || e.WATCH_ISSUES_REPO || e.WATCH_REPO || "",
  BRAIN: e.DM_BRAIN || "/root/brain",
  DRY: process.argv.includes("--dry-run"),
});
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return NaN; } };
const versionOf = name => { const m = /^(.*?)-?(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?(?:-|$)/i.exec(name); return m ? { group: m[1], v: [Number(m[2]), Number(m[3]), Number(m[4]), m[5] === undefined ? 1e9 : Number(m[5])] } : null; };
const cmp = (a, b) => { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const parseVersion = s => { const m = /(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?/i.exec(String(s || "")); return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1e9 : Number(m[4])] : null; };
const sys = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 60000, env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/root" }, ...opts });

// ---------------------------------------------------------------- THE GATE (the same three rules as the driver's gate.mjs, written here on its own)
// Nothing reaches Michael on one reading: (a) the same condition on 3 consecutive runs at least 10 minutes apart (it starts over when the
// condition is absent), (b) a fresh re-read of every source the condition depends on right before sending, (c) no source unreadable in it.
export const GATE = { reads: 3, gapMs: 10 * 60000, toleranceMs: 0 };
export function gateStep(gate, key, now, cfg = GATE) {
  const g = (gate[key] ||= { reads: [] }), last = g.reads.at(-1);
  if (last === undefined || now - last >= cfg.gapMs - cfg.toleranceMs) g.reads.push(now);
  g.reads = g.reads.slice(-cfg.reads);
  return g.reads.length >= cfg.reads && g.reads.at(-1) - g.reads[0] >= (cfg.reads - 1) * (cfg.gapMs - cfg.toleranceMs);
}
export function gateClear(gate, present) { for (const k of Object.keys(gate)) if (!present.has(k)) delete gate[k]; }

// ---------------------------------------------------------------- rule 1: approval time and the running version
// -> [{id, approvedAt}] approved plans newer than `running` (the version /health reports; null when unreadable).
export function approvedNewer(cfg, running, run = sys) {
  let names = []; try { names = fs.readdirSync(cfg.RELEASES); } catch { return []; }
  const out = []; out.unreadable = false;
  for (const n of names) {
    if (!(cfg.PRODUCT || (cfg.PLAN_PATTERN ? new RegExp(cfg.PLAN_PATTERN) : /(?!)/)).test(n)) continue; // the server runs the main project only: another product's plan is not 'not running on your server'
    const v = versionOf(n); if (!v) continue;
    let text = ""; try { text = fs.readFileSync(path.join(cfg.RELEASES, n, "plan.md"), "utf8"); } catch { continue; }
    if (!/^\s*status:\s*approved/im.test(text)) continue;
    if (running && cmp(v.v, running) <= 0) continue; // already running (or older than what runs)
    try { if (JSON.parse(fs.readFileSync(path.join(cfg.RELEASES, n, "staging.json"), "utf8")).status === "installed") continue; } catch (e) { if (e && e.code !== "ENOENT") { out.unreadable = true; continue; } /* no staging record at all: not installed */ }
    const g = run("git", ["-C", cfg.DEV, "log", "--format=%cI", "-i", "-G", "^\\s*status:\\s*approved", "--", `releases/${n}/plan.md`]);
    const last = String(g.stdout || "").trim().split("\n").filter(Boolean).at(-1);
    if (!Number.isFinite(Date.parse(last))) { out.unreadable = true; continue; } // the plan's history could not be read: not a guess from a file time
    out.push({ id: n, approvedAt: Date.parse(last) });
  }
  return out;
}
export function runningVersion(cfg, ask = () => sys("curl", ["-s", "-m", "10", cfg.HEALTH])) {
  try { const h = JSON.parse(ask().stdout); return h && h.ok ? parseVersion(h.version) : null; } catch { return null; }
}
export function releaseSays(pending, messages, now, rules = RULES) {
  const quiet = k => !(messages[k] && now - messages[k] < rules.silenceHours * HOUR);
  return pending.filter(r => now - r.approvedAt >= rules.ceilingHours * HOUR && quiet(`release:${r.id}`)).map(r => ({ key: `release:${r.id}`,
    text: `Release ${r.id} was approved ${Math.floor((now - r.approvedAt) / HOUR)} hours ago and is still not running on your server. The factory keeps working on it; nothing is needed from you unless a later message says so.` }));
}

// ---------------------------------------------------------------- rule 2: the driver's health and the repair ladder
export function driverHealth(cfg, now) {
  const missing = !fs.existsSync(cfg.STATUS);
  const st = readJson(cfg.STATUS, null), k = readJson(cfg.KEEPER, {});
  const unreadable = !missing && st === null; // the file is there and cannot be read: not a verdict about the driver
  const at = st ? Date.parse(st.at) : NaN;
  const spool = (() => { try { return fs.readdirSync(cfg.SPOOL).filter(n => /^repair-.*\.json$/.test(n)); } catch { return []; } })();
  const reasons = [];
  if (!Number.isFinite(at) || now - at > RULES.driverStaleMinutes * MIN || at - now > 5 * MIN) reasons.push(Number.isFinite(at) ? (at > now ? "its status file is dated in the future" : `its status file is ${Math.round((now - at) / MIN)} minutes old`) : "it has no status file");
  if ((k.failedInRow || 0) >= RULES.failedRounds) reasons.push(`its last ${k.failedInRow} rounds failed`);
  if (spool.length) reasons.push(`a release run asked for a repair (${spool.length} request(s))`);
  const classes = [...new Set(reasons.map(r => (/status|dated/.test(r) ? "status" : /rounds failed/.test(r) ? "keeper" : "spool")))].sort();
  return { healthy: reasons.length === 0, reasons, spool, unreadable, key: `driver:${classes.join("+")}` };
}
// state.repair = {since, rollbackAt, codexAt, claudeAt, toldAt}. -> the next step: "rollback" | "codex" | "claude" | "tell" | null
export function repairStep(rep, health, now, rules = RULES) {
  if (health.healthy) return { step: null, rep: null };
  const r = rep && rep.since ? { ...rep } : { since: now };
  if (!r.rollbackAt) return { step: "rollback", rep: { ...r, rollbackAt: now } };
  if (!r.codexAt && now - r.rollbackAt >= rules.rollbackGraceMinutes * MIN) return { step: "codex", rep: { ...r, codexAt: now } };
  if (r.codexAt && !r.claudeAt && now - r.codexAt >= rules.repairHours * HOUR) return { step: "claude", rep: { ...r, claudeAt: now } };
  if (r.claudeAt && !r.toldAt && now - r.claudeAt >= rules.repairHours * HOUR) return { step: "tell", rep: { ...r, toldAt: now } };
  return { step: null, rep: r };
}
const REPAIR_BRIEF = (why, tried, cfg = defaults()) => `You are the factory dead-man's repair run: root on this server, in Mission Control's brain folder (AGENTS.md and rules/ bind you). The software factory's driver (${cfg.DRIVER_DIR}, one round every 5 minutes, unit factory-driver.service; state ${cfg.STATE_DIR}) is not healthy: ${why}. ${tried ? `Earlier repair attempts: ${tried}\n` : ""}Make it healthy: read its journal (journalctl -u factory-driver.service), its decisions log and status, fix the cause, and leave a good round behind within 30 minutes (the keeper rolls an install back by itself otherwise). You may write the driver's install; you may NEVER touch the dead-man (${cfg.KEEPER_HOME}/deadman.mjs and its units), the journal (${cfg.STATE_DIR}/journal.jsonl) or the outside watcher.${(cfg.CHECKOUTS || []).length ? ` The factory's checkouts (${cfg.CHECKOUTS.join(", ")}) are read-only for you: never write in them by any route (not with git or any other program, not through systemd-run or another unit, not as another user), since that makes their files root's and the factory cannot fetch; work on code in a clone of your own (mktemp -d).` : ""} Never anything outward to people, never spend money, never loosen a check. Never pass --owner-said or --owner-ref, never write the owner's words or his go anywhere, and never clear a halt that says it needs the owner's yes: say it is the owner's step. Your last line: RESULT: resolved | RESULT: unresolved`;
// a driver-repair run: writable driver install, read-only dead-man, journal and units
export function launchRepair(cfg, unit, provider, why, tried, run = sys) {
  const dir = path.join(cfg.ACTS, unit); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ provider, model: provider === "claude" ? "claude-opus-5-5" : "gpt-5.6-sol", brain: cfg.BRAIN, factoryHome: cfg.FACTORY_HOME, claudeBin: cfg.CLAUDE_BIN, prompt: REPAIR_BRIEF(why, tried, cfg), actsDir: cfg.ACTS, minutes: 50 }));
  const r = run("systemd-run", [`--unit=${unit}`, "--collect", "--quiet", "-p", "RuntimeMaxSec=3300", "-p", "NoNewPrivileges=yes", "-p", "CapabilityBoundingSet=~CAP_SYS_ADMIN CAP_SYS_PTRACE CAP_SYS_MODULE CAP_SYS_BOOT CAP_SYS_TIME CAP_SYS_RAWIO", "-p", "ProtectControlGroups=yes", "-p", "ProtectKernelModules=yes",
    "-p", `ReadOnlyPaths=${[`${cfg.KEEPER_HOME}/deadman.mjs`, "/etc/systemd/system", cfg.STATE_DIR, cfg.KEEPER_HOME, ...(cfg.CHECKOUTS || []).map(c => `-${c}`)].join(" ")}`, "-p", `ReadWritePaths=${cfg.ACTS} ${cfg.SPOOL}`,
    "--setenv=HOME=/root", process.execPath, fileURLToPath(import.meta.url), "--run", dir]);
  return r.status === 0;
}
// The repair run's AI signs in with the factory user's files, linked into its own home. Anything else in a link's place is moved
// aside with the date in its name and the link is made again (the Forge 0.3.1: a plain file had taken the place of the acting runs'
// Claude link, and every run failed to sign in for two days). Its own copy: the dead-man shares no code with the driver.
export function linkLogin(target, link, now = Date.now()) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let st = null; try { st = fs.lstatSync(link); } catch { /* not there */ }
  if (st && st.isSymbolicLink() && path.resolve(fs.readlinkSync(link)) === path.resolve(target)) return "kept";
  if (st) { const day = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); let aside = `${link}.replaced-${day}`; for (let i = 1; fs.existsSync(aside); i++) aside = `${link}.replaced-${day}-${i}`; fs.renameSync(link, aside); }
  fs.symlinkSync(target, link);
  return st ? "moved aside" : "linked";
}
function runJob(dir) { // inside the repair unit (this file's own runner: no driver code)
  const job = readJson(path.join(dir, "job.json"), null); if (!job) throw new Error("no job");
  const last = path.join(dir, "last.txt"); let r;
  const root = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  if (job.provider === "claude") {
    const home = path.join(job.actsDir, "claude-home"); fs.mkdirSync(home, { recursive: true });
    for (const [from, to] of [[`${job.factoryHome}/.claude/.credentials.json`, ".credentials.json"], [`${job.factoryHome}/.claude.json`, ".claude.json"]]) linkLogin(from, path.join(home, to));
    r = spawnSync(job.claudeBin, ["-p", "--model", job.model, "--dangerously-skip-permissions"], { input: job.prompt, cwd: job.brain, encoding: "utf8", timeout: job.minutes * 60000, maxBuffer: 64 << 20, env: { PATH: `${path.dirname(job.claudeBin)}:${root}`, HOME: "/root", CLAUDE_CONFIG_DIR: home, IS_SANDBOX: "1" } });
    fs.writeFileSync(last, r.stdout || "");
  } else {
    const home = path.join(job.actsDir, "codex-home"); fs.mkdirSync(home, { recursive: true });
    linkLogin(`${job.factoryHome}/.codex/auth.json`, path.join(home, "auth.json"));
    r = spawnSync("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "danger-full-access", "-m", job.model, "-C", job.brain, "-o", last, "-"], { input: job.prompt, encoding: "utf8", timeout: job.minutes * 60000, maxBuffer: 64 << 20, env: { PATH: root, HOME: "/root", CODEX_HOME: home } });
  }
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ at: new Date().toISOString(), said: (fs.existsSync(last) ? fs.readFileSync(last, "utf8") : "").slice(-3000) }));
}

// ---------------------------------------------------------------- telling Michael: two transports, a receipt each (its own senders)
const tgCreds = f => { try { const e = Object.fromEntries(fs.readFileSync(f, "utf8").split("\n").map(l => /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2].replace(/^["']|["']$/g, "")])); return { token: e.BOT_TOKEN || e.TELEGRAM_BOT_TOKEN, chat: e.CHAT_ID || e.TELEGRAM_HOME_CHANNEL || String(e.TELEGRAM_ALLOWED_USERS || "").split(",")[0] }; } catch { return {}; } };
export async function tell(cfg, text, deps = {}) {
  const receipts = {};
  const c = tgCreds(cfg.TG_ENV);
  if (c.token && c.chat) { try { const r = await (deps.fetch || fetch)(`https://api.telegram.org/bot${c.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: c.chat, text }), signal: AbortSignal.timeout(20000) }); const j = await r.json(); if (j.ok && j.result && j.result.message_id) receipts.telegram = String(j.result.message_id); } catch {} }
  // transport B: the notify workflow opens an issue authored by github-actions[bot] that names the owner (his own token would notify nobody);
  // only where there is a watch repository (a new owner has none, and nothing is posted on their project's repository)
  if (cfg.WATCH_REPO) try {
    const run = deps.run || sys, ref = deps.ref || crypto.createHash("sha1").update(`deadman|${text}|${Math.floor(Date.now() / 86400000)}`).digest("hex").slice(0, 12);
    const find = () => { try { const hit = JSON.parse(run("gh", ["api", `repos/${cfg.WATCH_REPO}/issues?state=all&per_page=100`]).stdout).find(i => i.user && i.user.login === "github-actions[bot]" && String(i.body || "").startsWith(`@${cfg.OWNER}`) && String(i.body || "").includes(`<!-- ref:${ref} -->`)); return hit ? hit.html_url : null; } catch { return null; } };
    let url = find();
    if (!url) {
      const d = run("gh", ["workflow", "run", "factory-notify.yml", "-R", cfg.WATCH_REPO, "-f", `title=The software factory needs a look`, "-f", `body=${text.slice(0, 900)}`, "-f", `ref=${ref}`]);
      for (let i = 0; i < (d.status === 0 ? (deps.polls ?? 10) : 0) && !url; i++) { await (deps.sleep || (ms => new Promise(r => setTimeout(r, ms))))(6000); url = find(); }
    }
    if (url) receipts.github = url;
  } catch {}
  // and Godspeed's own notice queue, under the same one-writer lock as every other program
  try {
    const lock = `${cfg.NOTICES}.lock`; let got = false;
    for (let i = 0; i < 60 && !got; i++) { try { fs.mkdirSync(lock); got = true; } catch (e) { if (e.code !== "EEXIST") throw e; try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmdirSync(lock); continue; } } catch {} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } }
    if (!got) throw new Error("locked");
    try {
    let notices = []; if (fs.existsSync(cfg.NOTICES)) { const d = JSON.parse(fs.readFileSync(cfg.NOTICES, "utf8")); if (!Array.isArray(d && d.notices)) throw new Error("unreadable"); notices = d.notices; }
    const nid = `deadman-${crypto.createHash("sha1").update(text).digest("hex").slice(0, 10)}-${Math.floor(Date.now() / 86400000)}`; // one queue notice per text and day
    if (notices.some(n => n && n.id === nid)) throw new Error("already queued today");
    notices.push({ id: nid, text, at: new Date().toISOString(), about: "The factory is stuck", facts: [text], written: true });
    const tmp = `${cfg.NOTICES}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ notices }, null, 2) + "\n"); fs.renameSync(tmp, cfg.NOTICES);
    } finally { try { fs.rmdirSync(lock); } catch {} }
  } catch {}
  return receipts;
}

export async function run(cfg, now = Date.now(), log = console.log, deps = {}) {
  const state = readJson(cfg.STATE, { messages: {}, repair: null }); state.messages ||= {};
  const done = []; let launched = false;
  // rule 1
  const running = runningVersion(cfg, deps.health);
  const pending = running ? approvedNewer(cfg, running, deps.run) : []; // an unreadable /health says nothing about any release (unknown is not 'not running')
  const says0 = releaseSays(pending, state.messages, now);
  // rule 2
  const health = driverHealth(cfg, now);
  const rs = repairStep(state.repair, health, now);
  const tellStep = rs.step === "tell";
  if (tellStep) rs.step = null; // decided below, behind the gate
  state.repair = rs.rep;
  log(`running version ${running ? running.join(".") : "unreadable"}; approved and newer: ${pending.map(p => p.id).join(", ") || "none"}; driver ${health.healthy ? "healthy" : `NOT healthy (${health.reasons.join("; ")})`}; step: ${rs.step || (tellStep ? "tell" : "none")}; to say: ${says0.length}`);
  // THE GATE for every message of this program
  state.gates ||= {};
  const wanting = new Set([...says0.map(s => s.key), ...(tellStep && !health.unreadable ? [health.key] : [])]);
  gateClear(state.gates, wanting);
  const gcfg = deps.gateCfg || GATE;
  const readyKeys = new Set([...wanting].filter(k => gateStep(state.gates, k, now, gcfg)));
  if (pending.unreadable) for (const k of [...readyKeys]) if (!k.startsWith("driver:")) readyKeys.delete(k); // (c) the release sources unreadable: only the release messages look again
  const sure = new Set();
  if (readyKeys.size && !cfg.DRY) { // (b) every source read again right now; (c) an unreadable one means: look again
    const running2 = runningVersion(cfg, deps.health2 || deps.health);
    const pending2 = running2 ? approvedNewer(cfg, running2, deps.run) : null;
    const health2 = driverHealth(cfg, Date.now() > now ? Date.now() : now);
    for (const k of readyKeys) {
      if (k.startsWith("driver:")) { if (!health2.unreadable && !health2.healthy && health2.key === k) sure.add(k); }
      else if (pending2 && !pending2.unreadable && releaseSays(pending2, {}, now).some(s => s.key === k)) sure.add(k);
    }
  }
  const says = says0.filter(s => sure.has(s.key));
  if (cfg.DRY) { for (const s of says0) log(`  would say (behind the gate): ${s.text}`); return { says: says0, health, step: rs.step }; }
  for (const s of says) { const rc = await tell(cfg, s.text, deps); if (Object.keys(rc).length) state.messages[s.key] = now; done.push({ say: s.key, receipts: rc }); } // told only with a receipt
  if (rs.step === "rollback") { // the rollback counts as attempted only when the keeper itself exited 0; otherwise it is asked again next time
    const kr = (deps.run || sys)(cfg.NODE, [cfg.KEEPER_BIN, "repair"]);
    if (!kr || kr.status !== 0) { if (state.repair) delete state.repair.rollbackAt; done.push({ keeper: "repair failed", why: String((kr && (kr.stderr || (kr.error && kr.error.message))) || "no answer").trim().split(String.fromCharCode(10)).pop().slice(0, 200) }); }
  }
  else if (rs.step === "codex" || rs.step === "claude") launched = launchRepair(cfg, `factory-repair-${rs.step}-${Math.floor(now / 1000)}`, rs.step, health.reasons.join("; ") + health.spool.map(f => { try { return ` | request: ${fs.readFileSync(path.join(cfg.SPOOL, f), "utf8").slice(0, 1500)}`; } catch { return ""; } }).join(""), rs.step === "claude" ? "a Codex repair run did not make the driver healthy" : "the keeper's rollback did not make the driver healthy", deps.run);
  if ((rs.step === "codex" || rs.step === "claude") && !launched && state.repair) { const fk = rs.step + "Fails"; state.repair[fk] = (state.repair[fk] || 0) + 1; if (state.repair[fk] < 3) delete state.repair[rs.step + "At"]; } // the run did not start: that rung is tried again, up to 3 times; after that it counts, so the ladder always reaches the owner
  else if (tellStep && sure.has(health.key)) { const rc = await tell(cfg, `The program that keeps your software factory moving is still broken after an automatic rollback and two repair attempts (${health.reasons.join("; ")}). The dead-man keeps checking; nothing is needed from you unless a later message says so.`, deps); done.push({ say: health.key, receipts: rc }); if (!Object.keys(rc).length && state.repair) state.repair.toldAt = null; }
  else if (tellStep && state.repair) state.repair.toldAt = null; // not through the gate yet: the step is taken again next run
  if (launched && health.spool.length) for (const f of health.spool) { try { fs.renameSync(path.join(cfg.SPOOL, f), path.join(cfg.SPOOL, f.replace(/^repair-/, "handled-"))); } catch {} }
  fs.mkdirSync(path.dirname(cfg.STATE), { recursive: true }); fs.writeFileSync(cfg.STATE, JSON.stringify(state, null, 2) + "\n");
  return { says, health, step: rs.step, done };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  (async () => {
    try {
      const i = process.argv.indexOf("--run");
      if (i >= 0) return runJob(process.argv[i + 1]);
      await run(defaults());
    } catch (e) { console.error("factory-deadman failed:", e.message); process.exit(1); }
  })();
}
