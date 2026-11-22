// Cause tickets (factory driver, Task 14). A repair that has to be made again and again is a symptom:
// when the same (obstacle kind, helper kind, cause) was repaired successfully twice within 14 days, one
// issue asks for the cause to be removed.
//   cause "product"                      -> a `bug` issue in the product repository (auto-plan's bug releases take it)
//   cause "our-tests", or an ops repair  -> a `driver-cause` issue in the engine repository, which the ops
//                                           helper works when no obstacle is open
//   any other cause (how, what, external, feature) has no ticket: those are decisions or the world's, not defects.
// Never twice for the same triple while one is open. Everything outside is injected (deps), so the tests run
// without GitHub.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mintToken } from "./release-driver/release-driver.mjs";

export const WINDOW_DAYS = 14;
export const MIN_REPAIRS = 2;
const REPAIR_HELPERS = ["product", "tests", "ops"];
const DAY = 86400000;
const ts = v => (typeof v === "number" ? v : Date.parse(v));
const plain = t => String(t || "").replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();
export const causeDefaults = (e = process.env) => ({
  // The engine repository engine causes are filed in, through a builder token minted for it alone
  // (engineGh; the driver's own factory login cannot see it). Unset: an engine cause is written to
  // decisions.jsonl only, never filed and never told (Michael gets no message he cannot act on).
  CAUSE_ENGINE_REPO: e.FD_CAUSE_ENGINE_REPO || "",
});
export const ENGINE_TOKEN_PERMISSIONS = "issues=write,metadata=read";
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// gh for the engine repository: the builder App's token for that one repository, allowed to write issues
// and nothing else, minted on first use and handed to gh through its environment (never the command line),
// with an empty config folder so root's own GitHub login is never used instead.
export function engineGh(env, deps = {}) {
  let token = null;
  return (args, input) => {
    token ||= (deps.mint || mintToken)({ ...env, REPO: env.CAUSE_ENGINE_REPO }, ENGINE_TOKEN_PERMISSIONS);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-engine-gh-"));
    try {
      const run = deps.spawn || ((file, a, opts) => spawnSync(file, a, { encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...opts }));
      const r = run("gh", ["api", ...args], { input, env: { PATH: SYSTEM_PATH, HOME: dir, GH_CONFIG_DIR: dir, GH_TOKEN: token, GH_PROMPT_DISABLED: "1" } });
      if (r.status !== 0) throw new Error(((r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`).slice(0, 200));
      return JSON.parse(r.stdout || "null");
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

export const tripleKey = ({ kind, helper, cause }) => [kind, helper, cause].map(x => String(x || "").replace(/[^\w-]+/g, "-")).join(".");

// decisions.jsonl text (or already parsed records) -> the repairs in it, oldest first.
// A repair: a product, tests or ops helper finished well on an obstacle and the obstacle cleared afterwards.
export function repairsFrom(input) {
  const recs = (Array.isArray(input) ? input : String(input || "").split(/\r?\n/))
    .map(l => { if (l && typeof l === "object") return l; try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => ts(a.at) - ts(b.at));
  const kindOf = {}, out = [];
  for (const r of recs) {
    if (r.kind === "obstacle" && r.id) kindOf[r.id] = r.obstacle;
    if (r.kind === "launched" && r.obstacle && r.obstacleKind) kindOf[r.obstacle] = r.obstacleKind;
  }
  recs.forEach((r, i) => {
    if (r.kind !== "helper finished" || r.state !== "done" || !REPAIR_HELPERS.includes(r.helper)) return;
    const cleared = recs.slice(i + 1).find(x => x.kind === "obstacle cleared" && x.id === r.obstacle);
    if (!cleared) return;
    let cause = String(r.cause || "").trim();
    if (!cause) {
      const earlier = [...recs.slice(0, i)].reverse().find(x => x.kind === "helper finished" && x.obstacle === r.obstacle && x.state === "done" && x.cause);
      cause = earlier ? earlier.cause : "unknown";
    }
    out.push({ at: r.at, kind: kindOf[r.obstacle] || "unknown", helper: r.helper, cause, obstacle: r.obstacle, unit: r.unit, summary: plain(r.summary).slice(0, 300), clearedAt: cleared.at });
  });
  return out;
}

const whereOf = r => (r.cause === "product" ? "product" : (r.cause === "our-tests" || r.helper === "ops") && r.cause !== "unknown" ? "engine" : null);

// -> [{key, kind, helper, cause, count, where, repairs}] for every triple with MIN_REPAIRS inside the window.
// since: {key: ms}: only repairs after that moment count (the time its earlier issue was closed).
export function recurring(repairs, now, { since = {}, windowDays = WINDOW_DAYS, minRepairs = MIN_REPAIRS } = {}) {
  const groups = new Map();
  for (const r of repairs) {
    const key = tripleKey(r);
    if (now - ts(r.at) > windowDays * DAY || ts(r.at) > now) continue;
    if (since[key] && ts(r.at) <= since[key]) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const [key, list] of groups) {
    const where = whereOf(list[0]);
    if (list.length >= minRepairs && where) out.push({ key, kind: list[0].kind, helper: list[0].helper, cause: list[0].cause, count: list.length, where, repairs: list });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function issueFor(rec, env) {
  const product = rec.where === "product";
  const what = `${rec.kind} problem repaired ${rec.count} times by the ${rec.helper} helper`;
  const title = product ? `The factory keeps repairing a ${what}` : `Driver cause: a ${what} (${rec.cause})`;
  const days = rec.repairs.map(r => `- ${String(r.at).slice(0, 10)}: ${r.summary || "(no summary)"}`).join("\n");
  const body = [
    `The factory driver repaired the same kind of problem ${rec.count} times within ${WINDOW_DAYS} days: an obstacle of kind "${rec.kind}", fixed by its ${rec.helper} helper, with the cause "${rec.cause}".`,
    "Each repair worked, so nothing stands still, but the cause is still there and will produce the next one.",
    "What it did each time:", days,
    product ? "Find what keeps producing it in the product and remove that, so no repair is needed any more." : "Find what keeps producing it in the factory's own setup and remove that, so no repair is needed any more. The ops helper takes this when no obstacle is open.",
    `<!-- factory-driver:cause:${rec.key} -->`,
  ].join("\n\n");
  return { repo: product ? env.REPO : env.CAUSE_ENGINE_REPO, title: plain(title).slice(0, 120), body, labels: product ? ["bug"] : ["driver-cause"] };
}

function readDecisions(env) {
  try { return fs.readFileSync(path.join(env.STATE_DIR, "decisions.jsonl"), "utf8"); } catch { return ""; }
}

// deps: {decisions (text, else read from STATE_DIR), gh(args, input) for the product, ghEngine(args, input) for
// the engine repository (default engineGh), state (state.json's object; state.causes is written), now,
// record(entry)}. Never throws for a GitHub refusal.
export async function fileCauses(env, deps) {
  const now = deps.now ?? Date.now();
  const out = { filed: [], noted: [], failed: [], skipped: [] };
  const repairs = repairsFrom(deps.decisions !== undefined ? deps.decisions : readDecisions(env));
  let eng = null;
  const ghFor = repo => (env.CAUSE_ENGINE_REPO && repo === env.CAUSE_ENGINE_REPO ? (eng ||= deps.ghEngine || engineGh(env)) : deps.gh);
  const known = (deps.state && deps.state.causes) || {};
  const since = {}, blocked = new Set();
  for (const [key, e] of Object.entries(known)) {
    if (e.noted) { if (now - ts(e.at) < WINDOW_DAYS * DAY) blocked.add(key); else since[key] = ts(e.at); continue; }
    try {
      const it = ghFor(e.repo)([`repos/${e.repo}/issues/${e.issue}`]);
      if (String((it || {}).state).toLowerCase() === "closed") since[key] = ts(it.closed_at) || now; else blocked.add(key);
    } catch { blocked.add(key); } // unreadable: assume it is open; never a second one on a guess
  }
  for (const rec of recurring(repairs, now, { since })) {
    if (blocked.has(rec.key)) { out.skipped.push(rec.key); continue; }
    const p = issueFor(rec, env);
    const note = `${rec.kind} / ${rec.helper} / ${rec.cause}: ${rec.count} repairs in ${WINDOW_DAYS} days`;
    if (!p.repo) {
      // only the log: a message Michael cannot act on is never sent
      deps.record({ kind: "cause ticket not filed", key: rec.key, note: plain(note), title: p.title, body: p.body, why: "no engine repository is set for the driver (FD_CAUSE_ENGINE_REPO)" });
      (deps.state.causes ||= {})[rec.key] = { noted: true, at: new Date(now).toISOString() };
      out.noted.push(rec.key);
      continue;
    }
    try {
      const r = ghFor(p.repo)(["-X", "POST", `repos/${p.repo}/issues`, "--input", "-"], JSON.stringify({ title: p.title, body: p.body, labels: p.labels }));
      (deps.state.causes ||= {})[rec.key] = { issue: r.number, repo: p.repo, at: new Date(now).toISOString() };
      deps.record({ kind: "cause ticket filed", key: rec.key, repo: p.repo, issue: r.number, title: p.title });
      out.filed.push({ key: rec.key, repo: p.repo, issue: r.number });
    } catch (e) {
      deps.record({ kind: "cause ticket failed", key: rec.key, why: String(e.message).slice(0, 200) });
      out.failed.push(rec.key);
    }
  }
  return out;
}
