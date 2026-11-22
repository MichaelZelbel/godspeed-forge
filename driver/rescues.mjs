// The hand-rescue count (2026-11-18, plan Task 11; the concept's point 10: it learns instead of growing).
//
// WHY. Every time a person or a session has to step in by hand, the factory did not keep itself
// moving. Counted by the machine, not remembered by whoever helped, the number shows whether the
// driver is getting better; each rescue is also a drill case waiting to be written.
//
// WHAT (the controller's ruling of 2026-11-18 evening: development is not a rescue). A rescue is:
//   release    a session's change to a release's state: a commit on godspeed-dev releases/** whose
//              message carries a `Co-Authored-By: Claude` trailer (the driver's and auto-stage's own
//              commits carry none)
//   decision   an `Owner decision` or `Owner question` comment on the factory's repositories posted by
//              Michael's account without the driver's `factory-driver:` marker and without the relay's
//              "His words, verbatim" (his own decisions are never a rescue)
//   unit       a stop or restart job of the factory's units in the journal, a start of what nothing
//              starts on its own (the web page, timers, the factory's Docker), and a unit's main
//              process killed with no stop job, minus what the driver, the keeper or the drill logged
//              in decisions.jsonl, systemd's own restarts, time limits and OOM kills, the first ten
//              minutes after a boot, and the cascade of a user-manager restart (one rescue, not
//              thirty). The same unit again within 3 minutes is the same rescue. A process killed by
//              hand outside a unit leaves no trace in the journal and is not seen.
// Engine code commits with the trailer (scripts/factory-driver/**, scripts/test-machine/**,
// scripts/factory-sandbox/**) are counted apart as driver changes, never in the rescue number.
// GitHub is read with root's gh (read only). A source that cannot be read is read again next round
// from where it was; nothing is concluded from it meanwhile.
// Stored per week in state.json (`rescues`), a week running from Sunday 18:00 to Sunday 18:00, Berlin
// time; at the first round after Sunday 18:00, one sentence to Michael through notices.json, N=0 too,
// naming only rescues.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MIN = 60000;
const engineLead = what => { const n = String(process.env.FD_ENGINE_REPO || "").split("/").pop(); return !!n && String(what).startsWith(`${n} `); };
const iso = ms => new Date(ms).toISOString();
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const OVERLAP_MINUTES = 30; // GitHub's `since` is read with this overlap; ids keep it to one count
export const WEEKS_KEPT = 8;
// [repository key, path, kind]: a session's commit on a release is a rescue, one on the engine a driver change
export const COMMIT_PATHS = [["DEV_REPO", "releases", "release"], ["ENGINE_REPO", "scripts/factory-driver", "driver-change"], ["ENGINE_REPO", "scripts/test-machine", "driver-change"], ["ENGINE_REPO", "scripts/factory-sandbox", "driver-change"]];
const TRAILER = /^co-authored-by:\s*claude\b/im;
const OWNER_DECISION = /^[\s#>*_`~]*owner\s+(?:decision|question)\b/i;
const DRIVER_MARK = /factory-driver:/;
const HIS_WORDS = /\bhis words, verbatim\b|\bin (?:michael's|his) own words\b|factory-owner-questions:/i;
// The factory's machinery: the system's units and the factory user's own (journal field USER_UNIT).
const csvOf = v => String(v || "").split(",").map(x => x.trim()).filter(Boolean);
const uidOf = () => String(process.env.FD_FORGE_UID || process.env.FORGE_UID || "1000");
// factory-driver's own units, plus the server's machinery units from the settings (regular expressions, e.g. a unit and its timer)
const sysUnit = () => new RegExp(`^(factory-driver\\.(service|timer)|factory-helper-[a-z0-9-]+\\.service|forge-step-[\\w-]+\\.service|${[...csvOf(process.env.FD_MACHINERY_UNITS), `user@${uidOf()}\\.service`].join("|")})$`);
const USER_UNIT = /^(archonfactory-[\w.@-]+\.(service|timer)|docker\.service)$/;
// a start counts only for what nothing starts on its own (a service's timer runs it every few minutes)
const startCounted = () => new RegExp(`^(${[...csvOf(process.env.FD_MUST_RUN).map(u => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "[\\w.@-]+\\.timer", "docker\\.service"].join("|")})$`);

export const rescueDefaults = (e = process.env) => ({
  DEV_REPO: e.FD_DEV_REPO || "",
  ENGINE_REPO: e.FD_ENGINE_REPO || "",
  REPO: e.FD_REPO || "owner/repository",
  STATE_DIR: e.FD_STATE_DIR || "/var/lib/godspeed/forge/driver",
  FORGE_UID: String(e.FD_FORGE_UID || e.FORGE_UID || "1000"),
});

// ---------------------------------------------------------------- weeks, Berlin time
const TZ = "Europe/Berlin";
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
function parts(ms) { const o = {}; for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value; return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: WD.indexOf(o.weekday) }; }
// the instant of a wall-clock time in Berlin
function berlin(y, m, d, h) {
  const want = Date.UTC(y, m - 1, d, h);
  let t = want;
  for (let i = 0; i < 3; i++) { const p = parts(t); t += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s); }
  return t;
}
const pad = n => String(n).padStart(2, "0");
// -> {key: the Sunday that ends it (YYYY-MM-DD), start, end}: Sunday 18:00 to Sunday 18:00, Berlin time
export function weekOf(ms) {
  const p = parts(ms);
  let add = (7 - p.wd) % 7;
  if (add === 0 && p.h >= 18) add = 7;
  const e = new Date(Date.UTC(p.y, p.m - 1, p.d + add)), s = new Date(Date.UTC(p.y, p.m - 1, p.d + add - 7));
  return { key: `${e.getUTCFullYear()}-${pad(e.getUTCMonth() + 1)}-${pad(e.getUTCDate())}`,
    start: berlin(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate(), 18), end: berlin(e.getUTCFullYear(), e.getUTCMonth() + 1, e.getUTCDate(), 18) };
}
const weekday = ms => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long" }).format(new Date(ms));

// ---------------------------------------------------------------- the three sources (pure)
const first = t => String(t || "").split("\n")[0].trim();
export function sessionCommits(commits, repo, where, kind = "release") {
  return (Array.isArray(commits) ? commits : []).filter(c => c && c.sha && c.commit && TRAILER.test(String(c.commit.message || "")))
    .map(c => ({ id: `commit:${c.sha}`, at: (c.commit.committer && c.commit.committer.date) || (c.commit.author && c.commit.author.date), kind,
      what: `${repo.split("/")[1]} ${where}: ${String(c.sha).slice(0, 7)} ${first(c.commit.message).slice(0, 100)}` }));
}
export function handDecisions(rows, repo) {
  return (Array.isArray(rows) ? rows : []).filter(c => c && c.user && c.user.login === (process.env.FD_OWNER_LOGIN || "") && !DRIVER_MARK.test(String(c.body || "")) && !HIS_WORDS.test(String(c.body || ""))
    && OWNER_DECISION.test((String(c.body || "").split("\n").find(l => l.trim()) || "").trim()))
    .map(c => ({ id: `comment:${repo}:${c.id}`, at: c.created_at, kind: "decision", what: `${repo}: ${c.html_url || `comment ${c.id}`}` }));
}
// A record in decisions.jsonl that names the unit, a few minutes around the event, with a verb that
// explains it (the driver and the keeper start things; only the drill logs a stop).
function explained(e, decisions) {
  const verb = e.job === "stop" || e.job === "kill" ? /stop|kill/i : /start|renew|launch|enable/i;
  return (decisions || []).some(d => {
    const t = Date.parse(d && d.at);
    if (!Number.isFinite(t) || e.at < t - 5 * MIN || e.at > t + 2 * MIN) return false;
    const s = JSON.stringify(d);
    for (let i = s.indexOf(e.unit); i >= 0; i = s.indexOf(e.unit, i + 1)) if (verb.test(s.slice(Math.max(0, i - 60), i + e.unit.length + 20))) return true;
    return false;
  });
}
// journal entries (journalctl -o json) -> the hand actions on the factory's units
export function unitRescues(entries, { decisions = [], bootId = null, bootAt = 0 } = {}) {
  const ev = (entries || []).map(e => ({ at: Number(e.__REALTIME_TIMESTAMP) / 1000, unit: String(e.UNIT || e.USER_UNIT || ""), user: !e.UNIT && !!e.USER_UNIT,
    job: e.JOB_TYPE || "", result: e.JOB_RESULT || "", boot: e._BOOT_ID || null, msg: String(e.MESSAGE || "") })).filter(e => Number.isFinite(e.at) && e.unit).sort((a, b) => a.at - b.at);
  const autoRestarts = ev.filter(e => /Scheduled restart job/.test(e.msg));
  // systemd's own reasons to end a process: a time limit, a timed-out start or stop, the OOM killer
  const ownEnds = ev.filter(e => /runtime time limit|timed out|OOM killer|Watchdog timeout/i.test(e.msg));
  const userManager = ev.filter(e => e.unit === `user@${uidOf()}.service` && e.job);
  const out = [], last = {};
  for (const e of ev) {
    if (bootId && e.boot && e.boot !== bootId) continue;
    if (e.at < bootAt + 10 * MIN) continue;
    if (!(e.user ? USER_UNIT : sysUnit()).test(e.unit)) continue;
    // a unit's main process killed with no stop job around it: someone sent the signal by hand
    if (!e.job && /Main process exited, code=killed/.test(e.msg)) {
      if (ev.some(x => x.unit === e.unit && x.job && Math.abs(x.at - e.at) <= 30000)) continue;
      if (ownEnds.some(x => x.unit === e.unit && e.at - x.at >= 0 && e.at - x.at <= 2 * MIN)) continue;
      e.job = "kill";
    } else if (e.result !== "done") continue;
    if (e.job === "start") {
      if (!startCounted().test(e.unit)) continue;
      if (autoRestarts.some(a => a.unit === e.unit && e.at - a.at >= 0 && e.at - a.at <= 5 * MIN)) continue;
    } else if (!["stop", "restart", "kill"].includes(e.job)) continue;
    if (e.user && userManager.some(u => Math.abs(u.at - e.at) <= 2 * MIN)) continue;
    if (explained(e, decisions)) continue; // a kill is explained by a record that says it stopped or killed the unit
    if (last[e.unit] !== undefined && e.at - last[e.unit] <= 3 * MIN) continue;
    last[e.unit] = e.at;
    out.push({ id: `unit:${e.unit}@${Math.round(e.at)}`, at: iso(e.at), kind: "unit", what: `${e.unit} ${{ restart: "restarted", stop: "stopped", kill: "killed", start: "started" }[e.job]} by hand` });
  }
  return out;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// one plain sentence; since: the weekday counting began when it began during the week, else null
export function rescueSentence(counts, since) {
  const n = (counts.release || 0) + (counts.decision || 0) + (counts.unit || 0); // driver changes are never a rescue
  const head = since ? `Since ${since} the factory needed` : "This week the factory needed";
  if (!n) return `${head} no hand rescues.`;
  const bits = [counts.release ? plural(counts.release, "release change made by a session", "release changes made by a session") : "",
    counts.decision ? plural(counts.decision, "owner decision or question posted by hand", "owner decisions or questions posted by hand") : "",
    counts.unit ? plural(counts.unit, "factory service stopped, started or killed by hand", "factory services stopped, started or killed by hand") : ""].filter(Boolean);
  const list = bits.length > 1 ? `${bits.slice(0, -1).join(", ")} and ${bits.at(-1)}` : bits[0];
  return `${head} ${plural(n, "hand rescue", "hand rescues")}: ${list}.`;
}

// ---------------------------------------------------------------- the real server (read only)
function rootGh(args) {
  const r = spawnSync("gh", ["api", ...args], { encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: { PATH: SYSTEM_PATH, HOME: "/root", GH_PROMPT_DISABLED: "1" } });
  if (r.status !== 0) throw new Error(((r.stderr || "").trim().split("\n").pop() || (r.error && r.error.message) || `exit ${r.status}`).slice(0, 200));
  return JSON.parse(r.stdout || "null");
}
const FIELDS = "--output-fields=UNIT,USER_UNIT,JOB_TYPE,JOB_RESULT,MESSAGE";
function journal(env, from, until) {
  const read = filter => {
    const r = spawnSync("journalctl", [...filter, `--since=@${Math.floor(from / 1000)}`, `--until=@${Math.ceil(until / 1000)}`, "-o", "json", "--no-pager", FIELDS], { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024, env: { PATH: SYSTEM_PATH } });
    if (r.status !== 0) throw new Error(((r.stderr || "").trim().split("\n").pop() || `journalctl exit ${r.status}`).slice(0, 200));
    return String(r.stdout || "").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };
  return [...read(["_PID=1"]), ...read([`_UID=${env.FORGE_UID}`, "_COMM=systemd"])];
}
function boot() {
  const id = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().replace(/-/g, "");
  const up = Number(fs.readFileSync("/proc/uptime", "utf8").split(/\s+/)[0]);
  return { id, at: Date.now() - up * 1000 };
}
function recentDecisions(env) {
  try { return fs.readFileSync(path.join(env.STATE_DIR, "decisions.jsonl"), "utf8").trim().split("\n").slice(-3000).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}

// ---------------------------------------------------------------- one round
// ctx: {state, world, now, record, notify(key, text)}; deps: {gh, journal(from, until), boot(), decisions()}
export async function countRescues(env0, ctx, deps = {}) {
  const env = { ...rescueDefaults(process.env), ...env0 };
  const { state, world, now } = ctx;
  const record = ctx.record || (() => {});
  const gh = deps.gh || rootGh;
  const nowIso = iso(now);
  const r = (state.rescues ||= { since: nowIso, lastAt: {}, weeks: {}, told: {} });
  r.lastAt ||= {}; r.weeks ||= {}; r.told ||= {};
  const since = Date.parse(r.since);
  const from = source => Date.parse(r.lastAt[source] || r.since);
  const found = [];
  const source = (name, fn) => {
    try { found.push(...fn(from(name))); r.lastAt[name] = nowIso; }
    catch (e) { record({ kind: "rescue count: a source was not read", source: name, why: String(e.message).slice(0, 200) }); }
  };
  source("commits", f => COMMIT_PATHS.flatMap(([key, where, kind]) => sessionCommits(gh([`repos/${env[key]}/commits?path=${encodeURIComponent(where)}&since=${iso(f - OVERLAP_MINUTES * MIN)}&per_page=100`]), env[key], where, kind)));
  const repos = [...new Set([env.REPO, ...((world && world.factories) || []).map(x => x && x.repo)].filter(x => /^[\w.-]+\/[\w.-]+$/.test(String(x || ""))))];
  source("comments", f => repos.flatMap(repo => handDecisions(gh([`repos/${repo}/issues/comments?since=${iso(f - OVERLAP_MINUTES * MIN)}&per_page=100&sort=updated&direction=desc`]), repo)));
  source("units", f => { const b = (deps.boot || boot)(); return unitRescues((deps.journal || ((a, z) => journal(env, a, z)))(f - 5 * MIN, now), { decisions: (deps.decisions || (() => recentDecisions(env)))(), bootId: b.id, bootAt: b.at }); });

  // a week counted under the first rule (every session commit a rescue) is sorted again once
  for (const w of Object.values(r.weeks)) {
    w.driverChanges ||= [];
    if (!(w.items || []).some(i => i.kind === "commit")) continue;
    for (const i of w.items.filter(x => x.kind === "commit")) {
      if (engineLead(i.what)) { if (!w.driverChanges.some(d => d.id === i.id)) w.driverChanges.push({ ...i, kind: "driver-change" }); }
      else i.kind = "release";
    }
    w.items = w.items.filter(i => i.kind !== "commit");
    w.count = w.items.length;
  }

  // per week, each once
  const lastUnit = (r.lastUnit ||= {});
  for (const item of found.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const at = Date.parse(item.at);
    if (!Number.isFinite(at) || at < since) continue; // before the count began
    const wk = weekOf(at);
    const w = (r.weeks[wk.key] ||= { start: iso(wk.start), end: iso(wk.end), count: 0, items: [], driverChanges: [] });
    w.driverChanges ||= [];
    if (item.kind === "driver-change") { // development: counted apart, never a rescue
      if (w.driverChanges.some(i => i.id === item.id)) continue;
      w.driverChanges.push({ id: item.id, at: item.at, kind: item.kind, what: String(item.what).slice(0, 200) });
      record({ kind: "driver change", what: item.what, at: item.at, week: wk.key });
      continue;
    }
    if (w.items.some(i => i.id === item.id)) continue;
    if (item.kind === "unit") { const u = item.what.split(" ")[0]; if (lastUnit[u] && at - Date.parse(lastUnit[u]) <= 3 * MIN && at >= Date.parse(lastUnit[u])) continue; lastUnit[u] = item.at; }
    w.items.push({ id: item.id, at: item.at, kind: item.kind, what: String(item.what).slice(0, 200) });
    w.count = w.items.length;
    record({ kind: "hand rescue", rescue: item.kind, what: item.what, at: item.at, week: wk.key });
  }

  // the first round after Sunday 18:00 (Berlin): the week that ended, in one sentence
  const cur = weekOf(now), prev = weekOf(cur.start - 1);
  let told = null;
  if (!r.told[prev.key] && since < prev.end) {
    const items = (r.weeks[prev.key] || { items: [] }).items;
    const counts = { release: 0, decision: 0, unit: 0 };
    for (const i of items) counts[i.kind] = (counts[i.kind] || 0) + 1;
    told = rescueSentence(counts, since > prev.start ? weekday(since) : null);
    const said = ctx.notify ? ctx.notify(`rescues:${prev.key}`, told) : false;
    r.told[prev.key] = nowIso;
    record({ kind: "told Michael the week's hand rescues", week: prev.key, count: items.length, driverChanges: ((r.weeks[prev.key] || {}).driverChanges || []).length, said: !!said, text: told });
  }

  // keep the newest weeks only
  const keep = Object.keys(r.weeks).sort().slice(-WEEKS_KEPT);
  for (const k of Object.keys(r.weeks)) if (!keep.includes(k)) delete r.weeks[k];
  for (const k of Object.keys(r.told)) if (k < (keep[0] || prev.key) && k !== prev.key) delete r.told[k];
  for (const [u, at] of Object.entries(lastUnit)) if (now - Date.parse(at) > 60 * MIN) delete lastUnit[u];
  return { found: found.length, week: cur.key, count: (r.weeks[cur.key] || { count: 0 }).count, told };
}
