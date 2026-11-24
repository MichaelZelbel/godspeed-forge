#!/usr/bin/env node
// The release driver (2026-11-15, D-418): the owner's second brain for Cole Medin's software factory.
//
// WHY. Cole's loop works single issues. At 2 review send-backs or 3 attempts it labels the item
// `needs-owner` and never touches it again until an owner acts; its manager lists those on the
// "Owner decisions needed" issue and gives defaults only to questions. In Cole's own demo the owner
// (his own Claude, his "second brain") answered on the work item itself (`Owner decision (...)`,
// even repairing a pull request's code), and the loop continued. Godspeed had no such step: on
// 15 November beta.25 sat with four items parked, decisions posted on the owner issue were honoured
// for one lap at most (#583 re-parked twelve minutes after one, #596 freed once by chance), main was
// red for hours, and the queue worker's "left for Mission Control" pile was read by nobody.
//
// WHAT. One goal: every approved release not yet on the owner's server (oldest first, since 2026-11-17) reaches "every ticket closed by a merged pull request"
// (and a green main), so auto-stage can freeze and stage it, without Michael.
//   1. A deterministic watcher (this file, every 15 minutes as root, no AI): picks every approved
//      release plan not yet installed and ready on the owner's server, oldest first, reads its tickets' issues and pull requests, main's
//      `required` check and the two dead-end queues, and builds the stuck set: an issue or its pull
//      request labelled needs-owner; an open ticket with no comment, commit or run for IDLE_HOURS;
//      dead-end entries (the queue worker's "left for Mission Control", the questions
//      helper's "could not be put into plain words") of this repository. It starts the AI only when
//      the set holds an entry the driver has not acted on yet, at most once an hour unless a new
//      item got parked, at most MAX_RUNS_PER_DAY times a day, never two at once (lock).
//   2. The AI run: `codex exec` as godspeed-forge in a fresh clone of the product repository, with a
//      builder-App token minted for that one repository (no workflows permission) as its GitHub
//      login, and `gh`/`git` behind a guard (release-driver-guard.mjs). The fixed brief
//      (release-driver-brief.md beside this file) tells it what it may do: decide questions of how on
//      the work item in the form the loop honours, repair a clear defect on a stuck pull request's
//      branch, narrow an item once, and hand only a
//      genuine product choice towards Michael. It ends with a structured report.
//   3. Afterwards, deterministically: the run's commands are audited (a breach halts the driver
//      until --clear-halt), every reported action is checked on GitHub (the run's marker in its
//      comments), owner-issue questions it settled get one note on the owner issue and go into
//      answered-elsewhere.json, dead-end entries it settled are marked there and in the queue
//      worker's log (so the note "Factory questions for Mission Control" shows them handled), a
//      product choice is recorded and forwarded to the questions helper's plain-words path
//      (to-michael.json) once the manager has put it on the owner issue. One line per action in
//      decisions.jsonl.
// Since D-419 (2026-11-15) nothing ends in "left for Mission Control": the owner-side steps in
// release-driver-owner-steps.mjs (trust, prerequisites, the second check on every decision, landing an
// additive protected workflow change through the release App, questions straight to Michael, notices)
// take what the AI run may not do (the verifier repair moved to the test machine's own program,
// scripts/test-machine/, on 2026-11-17); the release
// is followed through auto-stage until it is healthy on his server with every scenario passed.
// Since 2026-11-17 an item that reached a dead end leaves the release under the approved plan's own rule
// (release-driver-cut.mjs writes releases/<id>/scope-amendment.json for it), so the rest ships.
// It never approves, releases, deploys, writes to Telegram, or changes a check; the one merge it makes
// is the landing step's, of an approved, green, purely additive protected change.
// What holds the AI to that: GitHub itself (a builder token for one repository, no workflows
// permission, and main's rules, which only the release App bypasses), the guard, the brief, and the
// audit afterwards. The guard is a backstop, not a wall: the AI runs as godspeed-forge with Codex's
// full access, exactly like the factory's own builders (until 2026-11-15 Codex's sandbox could not start on this host; it can since D-419, which the repair and the checks use),
// so it could read its token or the user's own builder login and talk to GitHub some other way; the
// audit looks for that in its commands and halts the driver when it finds it.
//
//   node release-driver.mjs              one look (the timer)
//   node release-driver.mjs --dry-run    print the stuck set, the gate and the brief; change nothing
//   node release-driver.mjs --once       start the AI now if anything is stuck (skips the hourly and
//                                        unchanged gates, not the daily cap or a halt)
//   node release-driver.mjs --clear-halt after a Mission Control session looked at the breach
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ownerLogin, isTrusted, blockerRefs, loopWords, capState, codexTrouble, TROUBLE_WORDS, secondCheck, codexJson, forgeArgv, tell, askMichael, pruneQuestions, trustLook, landingLook, genuineRelay, firstWithMarker, asManagerDecision, asQuestion, ownerHeaded, ownerOnlyReason, MANAGER_HEADING, KEEP_CHECKS_DECISION, technicalWords } from "./release-driver-owner-steps.mjs";
import { isProtected as guardIsProtected, DECISION_BODY } from "./release-driver-guard.mjs";
import { cutLook, routedToDeadEnd, factoryFacts, recordsToken } from "./release-driver-cut.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOUR = 3600 * 1000;
export const MARKER_PREFIX = "release-driver:";
export const OWNER_TITLE = "Owner decisions needed";
export const DRIVER_EMAIL = "release-driver@factory.invalid";

export const defaults = (argv = process.argv, e = process.env) => ({
  REPO: e.RD_REPO || "owner/repository",
  RELEASES_DIR: e.RD_RELEASES_DIR || "/var/lib/godspeed/forge/records/releases",
  STATE_DIR: e.RD_STATE_DIR || "/var/lib/godspeed/forge/driver/steps/trust",
  QUESTIONS_DIR: e.RD_QUESTIONS_DIR || "/var/lib/godspeed/forge/questions",
  WORKER_DIR: e.RD_WORKER_DIR || "/var/lib/godspeed/forge/driver/steps/trust/queue-worker",
  FORGE_USER: e.FORGE_USER || "factory",
  SOURCE_CHECKOUT: e.RD_SOURCE_CHECKOUT || "/home/factory/repository",
  WORK_ROOT: e.RD_WORK_ROOT || e.FD_WORK_ROOT || "/home/factory/factory-driver",
  BRIEF: e.RD_BRIEF || (fs.existsSync(path.join(HERE, "release-driver-brief.md")) ? path.join(HERE, "release-driver-brief.md") : path.join(HERE, "brief.md")),
  GUARD: e.RD_GUARD || path.join(HERE, "release-driver-guard.mjs"),
  TOKEN_SCRIPT: e.RD_TOKEN_SCRIPT || "/usr/local/bin/gh-app-token.mjs",
  KEYS_FILE: e.RD_KEYS_FILE || "/etc/godspeed-forge/keys-file",
  MODEL: e.RD_MODEL || "gpt-5.6-terra",
  STRONG_MODEL: e.RD_STRONG_MODEL || "gpt-5.6-sol",
  IDLE_HOURS: Number(e.RD_IDLE_HOURS || 3),
  MIN_GAP_MINUTES: Number(e.RD_MIN_GAP_MINUTES || 60),
  MAX_RUNS_PER_DAY: Number(e.RD_MAX_RUNS_PER_DAY || 6), // AI runs in 24 hours that moved nothing
  MAX_RUNS_24H: Number(e.RD_MAX_RUNS_24H || 16), // the spend ceiling: every AI run in 24 hours
  GODSPEED_DIR: e.RD_GODSPEED_DIR || "/root/brain",
  NOTICES_FILE: e.RD_NOTICES_FILE,
  AUTO_STAGE_STATE: e.RD_AUTO_STAGE_STATE || "/var/lib/godspeed/forge/driver/steps/stage/state.json",
  DEV_CHECKOUT: e.RD_DEV_CHECKOUT || "/var/lib/godspeed/forge/records",
  TOOLS_DIR: e.RD_TOOLS_DIR || "/home/factory/holdout-tools",
  TM_STATE: e.RD_TM_STATE || "/var/lib/godspeed/forge/driver/steps/test-machine/state.json", // the test machine's watcher (scripts/test-machine/)
  AI_MINUTES: Number(e.RD_AI_MINUTES || 45),
  DRY: argv.includes("--dry-run"), ONCE: argv.includes("--once"), CLEAR_HALT: argv.includes("--clear-halt"), TRUST_ONLY: argv.includes("--trust-only"),
  RD_GH_CMD: e.RD_GH_CMD,
});

// ---------------------------------------------------------------- versions and plans (pure)
// -1, 0 or 1 the way semantic versions order (the records repository scripts/release/staging.mjs).
export function compareVersions(a, b) {
  const split = v => { const s = String(v); const cut = s.indexOf("-"); return { main: (cut < 0 ? s : s.slice(0, cut)).split(".").map(Number), pre: cut < 0 ? [] : s.slice(cut + 1).split(".") }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < 3; i++) if ((x.main[i] || 0) !== (y.main[i] || 0)) return (x.main[i] || 0) < (y.main[i] || 0) ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const nx = /^\d+$/.test(x.pre[i]), ny = /^\d+$/.test(y.pre[i]);
    if (nx && ny && Number(x.pre[i]) !== Number(y.pre[i])) return Number(x.pre[i]) < Number(y.pre[i]) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x.pre[i] !== y.pre[i]) return x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
}
export const releaseVersion = id => { const m = String(id).match(/(\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+(?:\.\d+)*)?)/); return m ? m[1] : null; };
export const planApproved = plan => /^\s*status:\s*approved\b/im.test(String(plan || ""));
export const planRepository = plan => (String(plan || "").match(/^repository:\s*`?([^\s`]+)/im) || [])[1] || null;
export const releaseLabel = version => (String(version).includes("-") ? String(version).slice(String(version).indexOf("-") + 1) : String(version));
// {1: 609, 2: 583, ...} from the plan's "Issues: item 1 #609, 2 #583, ..." line (auto-stage's rule).
export function itemIssues(plan) {
  const out = {};
  const line = String(plan || "").split(/\r?\n/).find(l => /\bIssues:/.test(l));
  if (!line) return out;
  for (const m of line.slice(line.indexOf("Issues:") + 7).matchAll(/(?:items?\s+)?(\d+)\s+#(\d+)/gi)) out[Number(m[1])] = Number(m[2]);
  return out;
}
// The release to drive: the newest approved plan of this repository that is not yet on the owner's
// server, healthy, with every scenario passed (D-419; until then the driver stopped once staging.json
// existed, and auto-stage says a failed scenario or a judgment step once and leaves it). Only a plan
// newer than every finished one counts, so an old approved plan that was never staged is not driven.
// done: staging.json exists, its install is not recorded as failed, and auto-stage either finished it
// with every scenario passed or never handled it (staged by hand before auto-stage existed).
// done: installed and healthy on his server (staging.json status "installed") and every scenario passed
// there. An older release that never got there is passed over once a newer one is done (pickPlan).
export const releaseDone = (staging, rs) => !!staging && staging.status === "installed" && !(rs && rs.halted)
  && !!staging.scenarios && staging.scenarios.result === "passed" && !(rs && (rs.failedJobs || []).length);
// Every approved plan of this repository that is not yet on the owner's server and newer than every
// finished one, oldest first (2026-11-17: the driver used to look only at the newest, so a release
// that was still unshipped when a newer one was approved was never looked at again).
export function pickPlans(releases, repo) {
  const usable = releases.map(r => ({ ...r, version: releaseVersion(r.id) }))
    .filter(r => r.version && planApproved(r.plan) && String(planRepository(r.plan) || "").toLowerCase() === String(repo).toLowerCase())
    .sort((a, b) => compareVersions(b.version, a.version));
  if (!usable.length) return { picks: [], why: `no approved release plan for ${repo}` };
  const isDone = r => (r.done !== undefined ? r.done : r.hasStaging);
  const done = usable.find(isDone);
  const picks = usable.filter(r => !isDone(r) && (!done || compareVersions(r.version, done.version) > 0)).reverse();
  if (!picks.length) return { picks, why: `the newest approved release, ${usable[0].version}, is on the owner's server already` };
  return { picks, why: `${picks.map(r => r.version).join(", ")}: approved and not yet healthy on the owner's server with every scenario passed` };
}
export function pickPlan(releases, repo) {
  const { picks, why } = pickPlans(releases, repo);
  const open = picks.at(-1) || null;
  if (!open) return { pick: null, why };
  return { pick: open, why: open.hasStaging ? `${open.version} is staged but not yet healthy on the owner's server with every scenario passed` : `${open.version} is approved and not staged yet` };
}
// The issue numbers (#N) an approved plan names under its "What it does not do" section, and only there.
// The driver does not drive them for that release, neither as a priority issue nor as a prerequisite.
export function excludedIssues(plan) {
  const out = new Set();
  let level = 0, inside = false;
  for (const line of String(plan || "").split(/\r?\n/)) {
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      if (inside && h[1].length <= level) break;
      if (!inside && /^what it does not do\b/i.test(h[2])) { inside = true; level = h[1].length; }
      continue;
    }
    if (inside) for (const m of line.matchAll(/#(\d+)\b/g)) out.add(Number(m[1]));
  }
  return out;
}
export function readReleases(dir, autoStage = {}, only = null) { // `only`: a test on the directory name, so another product's plan is never opened
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && (!only || only.test(d.name))).map(d => {
    const plan = path.join(dir, d.name, "plan.md"), st = path.join(dir, d.name, "staging.json");
    let staging = null; try { staging = fs.existsSync(st) ? JSON.parse(fs.readFileSync(st, "utf8")) : null; } catch { staging = { status: "unreadable" }; }
    const rs = ((autoStage && autoStage.releases) || {})[d.name] || null;
    return { id: d.name, dir: path.join(dir, d.name), plan: fs.existsSync(plan) ? fs.readFileSync(plan, "utf8") : "", hasStaging: !!staging, staging, autoStage: rs, done: releaseDone(staging, rs) };
  });
}

// ---------------------------------------------------------------- the owner issue (pure)
// The helpers' own key (answered-elsewhere.json and to-michael.json are matched with it, so it stays
// theirs: reference numbers do not count), and an exact one that keeps them, for this driver's own ids.
export const keyOf = heading => String(heading).toLowerCase().replace(/#\d+/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const exactKey = heading => String(heading).toLowerCase().replace(/[^\p{L}\p{N}#]+/gu, " ").trim();
export function parseQuestions(body) { // the questions helper's own rule: "### N. heading"
  const out = []; let cur = null;
  for (const line of String(body || "").replace(/\r/g, "").split("\n")) {
    const h = /^###\s+(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (h) { cur = { number: Number(h[1]), heading: h[2], lines: [] }; out.push(cur); continue; }
    if (/^#{1,3}\s/.test(line)) { cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  return out.map(q => ({ number: q.number, heading: q.heading, body: q.lines.join("\n").trim(), key: keyOf(q.heading) }));
}
const sha = s => crypto.createHash("sha1").update(String(s)).digest("hex");
const iso = ms => new Date(ms).toISOString();
const short = t => String(t || "").replace(/\s+/g, " ").trim();
const utc = t => (t ? String(t).slice(0, 16).replace("T", " ") + " UTC" : "unknown time");
export const markerOf = runId => `<!-- ${MARKER_PREFIX}${runId} -->`;

// ---------------------------------------------------------------- the stuck set (pure)
// world: {repo, items: [{number, title, url, state, labels, updatedAt, parkedAt, ticket, ownerDecisions:[{at}],
//         prs: [{number, url, state, merged, labels, updatedAt, parkedAt, lastCommitAt, ownerDecisions}]}],
//         main: {sha, required, url}, owner: {number, questions, decisions: [{at, body}]}, deadEnds: [{heading, ...}]}
// productChoices: {issue: {at}} items waiting on Michael (left out until a newer owner decision names them).
// choice: {at, forwarded?}. Answered: an owner decision on the item itself (not the driver's) after the
// choice, or, once it was forwarded, an owner-issue decision whose first line names that question.
export function answeredSince(world, item, choice) {
  const t = Date.parse(choice.at);
  const mine = (item.ownerDecisions || []).some(d => Date.parse(d.at) > t); // on the issue, where the question was asked
  // the questions helper heads its relayed answer with the heading minus its "(#596, PR #605)" part
  const asked = keyOf(String(choice.forwarded || "").replace(/\s*\(#\d+[^)]*\)/g, ""));
  const onOwner = !!asked && ((world.owner && world.owner.decisions) || [])
    .some(d => Date.parse(d.at) > t && keyOf(String(d.body || "").split("\n")[0]).includes(asked));
  return mine || onOwner;
}
export function stuckSet(world, { now, idleHours = 3, productChoices = {}, reauthorized = {}, refused = {} }) {
  const stuck = [], waiting = [], working = [];
  for (const it of world.items || []) {
    if (it.state !== "OPEN") continue;
    const open = (it.prs || []).filter(p => p.state === "OPEN");
    const parks = [];
    if ((it.labels || []).includes("needs-owner")) parks.push({ where: `#${it.number}`, at: it.parkedAt || "unknown" });
    for (const p of open) if ((p.labels || []).includes("needs-owner")) parks.push({ where: `PR #${p.number}`, at: p.parkedAt || "unknown" });
    if (it.claimedAt && now - Date.parse(it.claimedAt) < CLAIM_HOURS * HOUR) { working.push({ item: it.number, title: it.title, url: it.url, since: it.claimedAt }); continue; } // a loop run works it now
    const choice = productChoices[it.number];
    const answered = choice ? answeredSince(world, it, choice) : false;
    if (choice && !answered) { waiting.push({ item: it.number, title: it.title, url: it.url, since: choice.at, question: choice.question }); continue; }
    const base = { item: it.number, title: it.title, url: it.url, prs: open.map(p => ({ number: p.number, url: p.url })), ticket: it.ticket ?? null, reauthorized: reauthorized[it.number] || 0, refusal: (refused[it.number] || {}).reason || "", latest: it.latest || "", scope: it.scope || null, prereqOf: it.prereqOf || null };
    if (parks.length) {
      const at = parks.map(p => p.at).sort().at(-1);
      // the id moves with the park and with any new word on it (a comment that is not a claim), so an
      // item the driver left is looked at again once someone adds to it
      stuck.push({ ...base, id: `parked:${it.number}@${at}${it.lastWordAt ? `/${it.lastWordAt}` : ""}${answered ? "+answered" : ""}`, kind: "parked", since: at, why: `needs-owner on ${parks.map(p => p.where).join(" and ")}${answered ? "; Michael answered the product choice since" : ""}` });
      continue;
    }
    // a pull request with merge conflicts that nobody touched for an hour is stuck too (D-419: #618)
    const dirty = open.filter(p => p.mergeable === "CONFLICTING" && (!p.lastCommitAt || now - Date.parse(p.lastCommitAt) > HOUR));
    if (dirty.length) {
      stuck.push({ ...base, id: `dirty:${it.number}@${dirty.map(p => `${p.number}:${p.head || p.lastCommitAt || "?"}`).join(",")}${it.lastWordAt ? `/${it.lastWordAt}` : ""}`, kind: "dirty", since: dirty[0].lastCommitAt || "", why: `pull request ${dirty.map(p => `#${p.number}`).join(", ")} has merge conflicts with main and nobody has touched it for an hour` });
      continue;
    }
    // activity: a comment (claims included: a run), a commit or a check; a label or title change is not
    const times = [it.lastCommentAt || it.updatedAt, ...open.flatMap(p => [p.lastCommentAt || p.updatedAt, p.lastCommitAt, p.lastCheckAt])].filter(Boolean).map(t => Date.parse(t)).filter(Number.isFinite);
    const last = times.length ? Math.max(...times) : 0;
    if (last && now - last > idleHours * HOUR) stuck.push({ ...base, id: `idle:${it.number}@${iso(last)}`, kind: "idle", since: iso(last), why: `no comment, commit or run for ${Math.floor((now - last) / HOUR)} hours` });
  }
  for (const s of world.staging || []) stuck.push(s); // after the freeze: what auto-stage could not finish (D-419)
  // A red main is not stuck work here: keep-main-green (the records repository, scripts/release/keep-main-green.mjs) is its one owner. It reruns, reverts or files a priority issue, and that issue is worked like any other.
  const waitingOn = new Set(waiting.map(w => w.item));
  for (const d of world.deadEnds || []) if (![...waitingOn].some(n => new RegExp(`#${n}(?!\\d)`).test(d.heading))) stuck.push({ id: `dead-end:${sha(exactKey(d.heading)).slice(0, 10)}${sha(`${d.question || ""}\n${d.why || ""}`).slice(0, 6)}`, kind: "dead-end", item: 0, question: d.question || "", questionNumber: d.number ?? null, title: d.heading, heading: d.heading, url: d.link || "", why: d.why || "left for Mission Control", source: d.source, prs: [] });
  return { stuck, waiting, working };
}

// ---------------------------------------------------------------- a park before any lap (pure)
// The beta.25 trial (2026-11-15 14:44): the driver's decisions lifted three parks, and two minutes
// later one of the loop's eight parallel dispatchers parked all three again "for the cap", before
// any run had worked them, reading only the pull requests' last "Loop review:" comments. A park like
// that ignores the owner's decision; the driver lifts it again without an AI run, at most RELIFTS
// times per item and release, and says so on the item in the loop's own words.
export const RELIFTS = 2;
// -> {driverDecisionAt, driverDecisionUrl, claimTimes}: the driver's newest "Owner decision" on the
// issue and the times of every loop claim on the issue and its pull requests.
export function driverTrail(issueComments, prComments = []) {
  // only what the factory's own accounts wrote: a stranger can type a marker or a claim too (D-419)
  issueComments = (issueComments || []).filter(c => isTrusted(c.author)); prComments = (prComments || []).filter(c => isTrusted(c.author));
  const mine = (issueComments || []).filter(c => /^\s*(?:Owner|Manager) decision\b/i.test(c.body || "") && String(c.body || "").includes(MARKER_PREFIX))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
  // a run's claim comment is edited to "Loop claim released: run ..." when the run ends, and keeps the
  // time it was made: both forms are a run that worked the item ("withdrawn" is a run that lost it)
  const claimTimes = [...(issueComments || []), ...(prComments || [])].filter(c => /^\s*Loop claim(?::|\s+released\b)[^\n]*?\brun\b/i.test(c.body || "")).map(c => c.createdAt).filter(Boolean).sort();
  // the newest review that sent the item to the owner: the dispatcher reads its "needs owner" as standing until answered
  const review = [...(prComments || []), ...(issueComments || [])].filter(c => /^\s*Loop review:\s*needs owner\b/i.test(c.body || ""))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
  return { driverDecisionAt: mine ? mine.createdAt : null, driverDecisionUrl: mine ? mine.url || "" : "", claimTimes, needsOwnerReviewUrl: review ? review.url || "" : "" };
}
// Items to lift again: open, parked (issue or an open pull request), the park newer than the driver's
// own decision, no loop claim between the two, fewer than RELIFTS lifts so far.
// Claims are read on the issue (the loop claims the work item): any claim newer than the decision is
// newer than a comment still in the window, so it is never cut off. waiting: items whose park is a
// product choice the driver itself asked; never lifted.
export function planRelifts(world, relifts = {}, release = "", waiting = {}) {
  const out = [];
  for (const it of world.items || []) {
    if (it.state !== "OPEN" || !it.driverDecisionAt || waiting[it.number]) continue;
    const open = (it.prs || []).filter(p => p.state === "OPEN");
    const labelled = [(it.labels || []).includes("needs-owner") ? { at: it.parkedAt } : null, ...open.filter(p => (p.labels || []).includes("needs-owner")).map(p => ({ at: p.parkedAt }))].filter(Boolean);
    if (!labelled.length || labelled.some(x => !x.at)) continue; // a park whose time is not known is never lifted
    const parks = labelled.map(x => x.at);
    // every park newer than the decision (an older one is not this case), and soon after it
    if (parks.some(t => !(Date.parse(t) > Date.parse(it.driverDecisionAt)))) continue;
    const park = parks.sort().at(-1);
    if (Date.parse(park) - Date.parse(it.driverDecisionAt) > CLAIM_HOURS * HOUR) continue;
    if ((it.claimTimes || []).some(t => Date.parse(t) > Date.parse(it.driverDecisionAt) && Date.parse(t) <= Date.parse(park))) continue; // a run worked it: a real park
    if ((relifts[`${release}#${it.number}`] || 0) >= RELIFTS) continue;
    out.push({ item: it.number, park, decisionAt: it.driverDecisionAt, decisionUrl: it.driverDecisionUrl, reviewUrl: it.needsOwnerReviewUrl || "", prs: open.map(p => ({ number: p.number, url: p.url, parked: (p.labels || []).includes("needs-owner") })),
      issueParked: (it.labels || []).includes("needs-owner") });
  }
  return out;
}
export function reliftBody(r, at, tag) {
  const pr = r.prs[0];
  return `${MANAGER_HEADING}: the needs-owner label added at ${utc(r.park)} came before any loop run worked this item under the manager decision ${r.decisionUrl || `of ${utc(r.decisionAt)}`}. That decision stands (${iso(at).slice(0, 10)}): Mission Control lets this item continue${pr ? ` (route continue on pull request #${pr.number})` : ""}. Under loop-pick's caps rule, count attempts and \`Loop review: sent back\` comments only from that decision; do not label this item needs-owner again for caps reached before it.${r.reviewUrl ? ` This is the decision that the review ${r.reviewUrl} (\`Loop review: needs owner\`) asked for on a question of how, so that review no longer holds the item.` : ""} The acceptance criteria and every check stay exactly as they are.\n\n${pr ? `Hold cleared, review for merge: ${pr.url}` : "Hold cleared."}\n<!-- ${MARKER_PREFIX}${tag} -->`;
}

// ---------------------------------------------------------------- the gate (pure)
export const ACTED_HOURS = 6;
export function gate({ stuck, state, now, once = false, maxPerDay = 6, maxRuns = 16, minGapMinutes = 60 }) {
  if (state.halted) return { run: false, why: `halted since ${utc(state.halted.at)}: ${state.halted.why} (a Mission Control session clears it with --clear-halt)` };
  if (!stuck.length) return { run: false, why: "nothing is stuck" };
  const acted = new Set(state.acted || []);
  // what a run covered (decided, left, or found nothing to do) is looked at again after six hours without
  // change, so a blocker nothing resolved never waits silently for good
  const stale = id => { const t = (state.acted_at || {})[id]; return !!t && now - Date.parse(t) > ACTED_HOURS * HOUR; };
  const fresh = stuck.filter(e => !acted.has(e.id) || stale(e.id));
  if (!fresh.length && !once) return { run: false, why: "nothing stuck changed since the driver last acted", fresh };
  // a release that is moving is never frozen for the night (D-419): only runs that moved nothing count
  // towards the idle cap; a ceiling bounds the spend over any 24 hours
  const cap = capState(state.runs || [], now, { maxIdle: maxPerDay, maxRuns });
  if (cap.capped) return { run: false, why: cap.why, capped: true, fresh };
  const last = state.last_run ? Date.parse(state.last_run.at) : 0;
  // newly parked: the label went on after the last AI run started (an old park the last run did not
  // settle waits for the hourly gap like everything else)
  const newPark = fresh.some(e => e.kind === "parked" && (!last || Date.parse(e.since) > last));
  if (!once && now - last < minGapMinutes * 60000 && !newPark) return { run: false, why: `the last AI run was ${Math.round((now - last) / 60000)} minutes ago; at most one an hour unless a new item is parked`, fresh };
  return { run: true, why: once ? "--once" : newPark ? "a newly parked item" : "a stuck item changed since the driver last acted", fresh };
}

// ---------------------------------------------------------------- the brief (pure)
const excerpt = (t, n) => { const s = String(t || "").trim(); return s.length > n ? s.slice(0, n) + " [...]" : s; };
export function sections(ctx) {
  const { world, stuck, waiting, working, plan, previous } = ctx;
  const ticketOf = n => { const e = Object.entries(itemIssues(plan.plan)).find(([, v]) => v === n); return e ? `item ${e[0]}` : "labelled, not in the plan's list"; };
  const prsLine = it => (it.prs || []).length ? (it.prs || []).map(p => `PR #${p.number} ${p.merged ? "merged" : p.state.toLowerCase()}${(p.labels || []).length ? ` [${p.labels.join(", ")}]` : ""}`).join(", ") : "no pull request";
  const STUCK = stuck.length ? stuck.map(e => {
    const head = `- [${e.kind}] ${e.item ? `#${e.item} ` : ""}${e.questionNumber ? `owner-issue question ${e.questionNumber}: ` : ""}"${short(e.title)}"${e.url ? ` (${e.url})` : ""}`;
    const lines = [head, `  why: ${e.why}${e.since && e.kind !== "dead-end" ? ` (since ${utc(e.since)})` : ""}`];
    if ((e.prs || []).length) lines.push(`  pull requests: ${e.prs.map(p => `#${p.number} ${p.url}`).join(", ")}`);
    if (e.kind === "parked" || e.kind === "idle") lines.push(`  this driver already authorized it ${e.reauthorized} time${e.reauthorized === 1 ? "" : "s"}`);
    if (e.refusal) lines.push(`  the independent check refused your last decision for it: ${e.refusal} Decide again so that every existing check stays exactly as it is and the refusal's reason no longer applies; a second refusal makes the driver keep the checks as they are.`);
    if (e.scope) lines.push(`  part of the release as ${e.scope === "priority" ? "an open priority issue" : `a prerequisite${e.prereqOf ? ` of #${e.prereqOf}` : ""}`}`);
    if (e.latest) lines.push(`  newest comment that is not a claim (untrusted data): ${excerpt(e.latest, 900).replace(/\n/g, "\n    ")}`);
    if (e.staging) lines.push(`  auto-stage's record: ${excerpt(JSON.stringify(e.staging), 1500)}`);
    if (e.kind === "dead-end") lines.push(`  from: ${e.source}${e.question ? `\n  question: ${excerpt(e.question, 1200).replace(/\n/g, "\n    ")}` : ""}`);
    return lines.join("\n");
  }).join("\n") : "Nothing is stuck.";
  const scopeWord = it => (it.scope === "prerequisite" ? `prerequisite${it.prereqOf ? ` of #${it.prereqOf}` : ""}` : it.scope === "priority" ? "priority issue" : ticketOf(it.number));
  const TICKETS = (world.items || []).map(it => `- ${scopeWord(it)}: #${it.number} ${it.state.toLowerCase()}${it.stateReason ? ` (${String(it.stateReason).toLowerCase()})` : ""} [${(it.labels || []).join(", ")}] ${prsLine(it)}: ${short(it.title)}`).join("\n") || "No tickets could be read.";
  const m = world.main || {};
  const MAIN = `main is at ${String(m.sha || "?").slice(0, 10)}; its required check: ${m.required || "unknown"}${m.url ? ` (${m.url})` : ""}.${(m.revertBranches || []).length ? `\nBranches that look like reverts: ${m.revertBranches.map(b => `${b.name} at ${String(b.sha).slice(0, 10)}${b.checks ? ` (checks: ${b.checks})` : ""}`).join("; ")}.` : ""}${(m.openPrs || []).length ? `\nOpen pull requests: ${m.openPrs.map(p => `#${p.number} ${p.headRefName}${(p.labels || []).length ? ` [${p.labels.join(", ")}]` : ""} "${short(p.title)}"`).join("; ")}.` : ""}`;
  const owner = world.owner || {};
  const OWNER_QUESTIONS = (owner.questions || []).length ? owner.questions.map(q => `### ${q.number}. ${q.heading}\n${excerpt(q.body, 1500)}`).join("\n\n") : "None.";
  const DEAD_ENDS = (world.deadEnds || []).length ? world.deadEnds.map(d => `- "${d.heading}" (${d.source}; why: ${short(d.why)})`).join("\n") : "None.";
  const WAITING = (waiting || []).length ? waiting.map(w => `- #${w.item} "${short(w.title)}", asked ${utc(w.since)}: ${short(w.question)}`).join("\n") : "Nothing.";
  const PREVIOUS = (previous || []).length ? previous.map(p => `- ${utc(p.at)} ${p.kind}${p.item ? ` #${p.item}` : ""}${p.pr ? ` (PR #${p.pr})` : ""}: ${excerpt(short(p.what || p.why || ""), 300)}${p.check ? ` [second check: ${excerpt(short(p.check), 300)}]` : ""}`).join("\n") : "Nothing yet.";
  const WORKING = (working || []).length ? working.map(w => `- #${w.item} "${short(w.title)}", claimed by a loop run at ${utc(w.since)}`).join("\n") : "Nothing.";
  return { STUCK, TICKETS, MAIN, OWNER_QUESTIONS, DEAD_ENDS, WAITING, WORKING, PREVIOUS };
}
export function renderBrief(template, ctx) {
  const s = sections(ctx);
  const values = { ...s, RELEASE: ctx.plan.version, REPO: ctx.world.repo, RUN_ID: ctx.runId, NOW: utc(iso(ctx.now)), DATE: iso(ctx.now).slice(0, 10), MINUTES: String(ctx.minutes || 60),
    MODEL: ctx.model, MARKER: markerOf(ctx.runId), OWNER_ISSUE: String((ctx.world.owner && ctx.world.owner.number) || "?"), PROTECTED: (ctx.protected || []).join(", "),
    MAIN_SHA: String((ctx.world.main && ctx.world.main.sha) || "?").slice(0, 10), RUN_DIR: ctx.runDir || "..", PLAN_PATH: ctx.plan.dir || ctx.plan.id, OWNER_LOGIN: process.env.FD_OWNER_LOGIN || "the owner", BUILDER_LOGIN: `${process.env.FD_BUILDER_APP || "builder"}[bot]`, RELEASE_LOGIN: `${process.env.FD_RELEASE_APP || "release"}[bot]`, PLAN: excerpt(ctx.plan.plan, 14000) };
  return String(template).replace(/\{\{([A-Z_]+)\}\}/g, (all, k) => (k in values ? values[k] : all));
}

// The report the AI ends with (codex --output-schema: every property required, nothing else).
export const OWNER_STEPS = ["none", "referee-repair", "prerequisite", "protected-landing", "staging-retry", "michael"];
export const REPORT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "items", "wants_stronger_model"],
  properties: {
    summary: { type: "string" },
    items: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["item", "pr", "action", "what", "links", "decision", "post_on", "owner_step", "prerequisites", "owner_questions_handled", "dead_ends_handled", "michael_question"],
      properties: {
        item: { type: "integer" }, pr: { type: "integer" },
        action: { type: "string", enum: ["decided", "repaired", "narrowed", "asked-michael", "left", "nothing"] },
        what: { type: "string" }, links: { type: "array", items: { type: "string" } },
        decision: { type: "string" }, post_on: { type: "array", items: { type: "integer" } },
        owner_step: { type: "string", enum: OWNER_STEPS }, prerequisites: { type: "array", items: { type: "integer" } },
        owner_questions_handled: { type: "array", items: { type: "integer" } }, dead_ends_handled: { type: "array", items: { type: "string" } },
        michael_question: { type: "string" },
      } } },
    wants_stronger_model: { type: "boolean" },
  },
};
const HANDLED = ["decided", "repaired", "narrowed"];
export function validReport(r) {
  return !!r && typeof r === "object" && typeof r.summary === "string" && Array.isArray(r.items) && r.items.every(i => i && Number.isInteger(i.item) && typeof i.action === "string");
}

// ---------------------------------------------------------------- the audit (pure)
const rx = t => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HOME_DIR = () => process.env.FD_FORGE_HOME || "/home/factory";
const PROJECT_DIR = () => String(process.env.FD_SOURCE_CHECKOUT || "/home/factory/repository").split("/").pop();
const SETTINGS_DIR = () => process.env.FD_SETTINGS_DIR || "/etc/godspeed-forge";
const AUDIT_RULES = () => [
  [/\/holdouts\b|holdout-tools/i, "touched the hidden holdout scenarios"],
  [new RegExp(`${rx(HOME_DIR())}/(${rx(PROJECT_DIR())}|\\.archon|\\.config/gh|\\.ssh|\\.codex|holdouts)\\b`), "touched the factory's own files or a login"],
  [new RegExp(`(~|\\$HOME|${rx(HOME_DIR())})/(bin|\\.local/bin)\\b`), "touched the factory user's own programs"],
  [new RegExp(`${rx(SETTINGS_DIR())}|keys\\.env|\\bgh\\s+auth\\s+token\\b|\\bGH_TOKEN=|\\bGITHUB_TOKEN=|hosts\\.yml`), "touched a key or token"],
  [/(^|[\s;&|'"(`])\/(usr\/)?bin\/(gh|git)\b/, "called gh or git around the guard"],
  [/--no-verify\b/, "skipped hooks"],
  [/\b(send-pack|http-push|git-remote-https?|git-receive-pack|remote-https?)\b/, "sent to GitHub around git push"],
  [/\bgh\s+pr\s+merge\b|\bgh\s+pr\s+review\b[^\n]*--approve|mergePullRequest|\/pulls\/\d+\/merge\b/, "tried to merge or approve"],
  [/oauth_token|\$GH_CONFIG_DIR|\b(cat|less|more|head|tail|grep|sed|awk|cp|base64|strings|xxd|od)\b[^\n]*\/gh\/[^\s'"]*hosts/, "read the run's GitHub login"],
  [/\b(curl|wget|httpie|nc|ncat|openssl)\b[^\n]*github\.com|\bhttps?\s+[^\n]*api\.github\.com|(fetch|requests\.(get|post|put|patch|delete)|urlopen|https?\.request|Net::HTTP)[^\n]*api\.github\.com/, "talked to GitHub around gh and git"],
];
// codex --json events -> [{why, what}]. runDir: the run's own folder; a file changed outside it is a breach.
export function auditEvents(text, { runDir = "" } = {}) {
  const auditRules = AUDIT_RULES();
  const out = [], seen = new Set();
  const add = (why, what) => { const k = why + "\n" + what; if (!seen.has(k)) { seen.add(k); out.push({ why, what: String(what).slice(0, 300) }); } };
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const it = e && e.item;
    if (!it || (e.type !== "item.started" && e.type !== "item.completed")) continue;
    if (it.type === "command_execution") for (const [re, why] of auditRules) if (re.test(String(it.command || ""))) add(why, it.command);
    if (it.type === "file_change") for (const ch of it.changes || []) {
      const raw = String(ch.path || "");
      if (!raw || !runDir) continue;
      const p = raw.startsWith("/") ? path.posix.normalize(raw) : path.posix.resolve(runDir, "repo", raw); // relative: from the clone, where Codex works
      if (!(p === runDir || p.startsWith(runDir + "/"))) add("changed a file outside the run folder", raw);
    }
  }
  return out;
}

// ---------------------------------------------------------------- files
const readJson = (file, dflt) => { if (!fs.existsSync(file)) return dflt; return JSON.parse(fs.readFileSync(file, "utf8")); };
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
const appendLine = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(obj) + "\n"); };
const listFor = (data, repo) => (Array.isArray(data) ? data : (data && data[repo]) || []);
export function addHeading(file, repo, heading) {
  const data = readJson(file, {});
  const obj = Array.isArray(data) ? { [repo]: data } : data;
  if ((obj[repo] || []).map(keyOf).includes(keyOf(heading))) return false;
  obj[repo] = [...(obj[repo] || []), heading];
  writeJson(file, obj);
  return true;
}
export function readDecisions(file, n = 15) {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-n); } catch { return []; }
}

// ---------------------------------------------------------------- the dead-end queues
// The queue worker's items it left for Mission Control and the helper's questions it could not put
// into plain words, for this repository, still open on the owner issue and not answered elsewhere.
export function readDeadEnds(env, repo, openQuestions = []) {
  const answered = new Set(listFor(readJson(path.join(env.QUESTIONS_DIR, "answered-elsewhere.json"), {}), repo).map(keyOf));
  const open = new Map(openQuestions.map(q => [q.key, q]));
  const same = r => String(r || "").toLowerCase() === String(repo).toLowerCase();
  const out = new Map();
  const queue = readJson(path.join(env.QUESTIONS_DIR, "mission-control-queue.json"), { items: [] }).items || [];
  for (const i of queue) if (i && i.bounced && same(i.repo) && i.heading && !answered.has(keyOf(i.heading)))
    out.set(exactKey(i.heading), { source: "the questions helper could not put it into plain words for Michael", heading: i.heading, number: Number.isInteger(i.number) ? i.number : null, why: i.why || "", question: i.question || "", link: i.link || "" });
  const worker = readJson(path.join(env.WORKER_DIR, "state.json"), { items: {} }).items || {};
  for (const v of Object.values(worker)) {
    if (!v || v.status !== "left-for-mission-control" || !same(v.repo) || !v.heading || answered.has(keyOf(v.heading))) continue;
    const q = open.get(keyOf(v.heading));
    // the worker keeps an item for good; once the manager removed its question from the owner issue
    // (answered, defaulted or withdrawn) nothing is waiting on it any more
    if (!q) continue;
    const had = out.get(exactKey(v.heading));
    out.set(exactKey(v.heading), { source: had ? `${had.source}; the queue worker left it for Mission Control` : "the queue worker left it for Mission Control", heading: v.heading, number: q.number, why: v.why || (had && had.why) || "", question: (had && had.question) || q.body, link: (had && had.link) || "" });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- GitHub (as the factory user's builder login)
const CLEAN_PATH = "/usr/local/bin:/usr/bin:/bin";
const ROOT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
// inside the factory's network namespace when env.FORGE_NETNS names it (the factory driver; forgeArgv)
export const asForge = (env, cmd, extra = []) => forgeArgv(env, ["env", "-i", `HOME=/home/${env.FORGE_USER}`, `PATH=${CLEAN_PATH}`, "LANG=C.UTF-8", ...extra, ...cmd]);
export function gh(env, args, input) {
  if (env.RD_GH_CMD) { // tests: a stand-in that gets {args, input} and answers JSON
    const r = spawnSync("bash", ["-c", env.RD_GH_CMD], { input: JSON.stringify({ args, input: input || null }), encoding: "utf8" });
    if (r.status !== 0) throw new Error((r.stderr || "").trim() || "gh failed");
    return JSON.parse(r.stdout || "null");
  }
  const [file, argv] = asForge(env, ["gh", "api", ...args]);
  const r = spawnSync(file, argv, { input, encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024, env: { PATH: ROOT_PATH } });
  if (r.status !== 0) throw new Error((r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`);
  return JSON.parse(r.stdout || "null");
}
const gql = (env, query) => { const r = gh(env, ["graphql", "-f", `query=${query}`]); if (!r || !r.data) throw new Error("GitHub gave no data"); return r.data; };
const checkRepo = repo => { if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`not a repository: ${repo}`); return repo.split("/"); };
const ISSUE_FIELDS = `number title state stateReason url updatedAt body author { login __typename }
  labels(first: 30) { nodes { name } }
  comments(last: 25) { nodes { createdAt body url author { login __typename } } }
  timelineItems(last: 60, itemTypes: [LABELED_EVENT, CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) { nodes { __typename
    ... on LabeledEvent { createdAt label { name } }
    ... on CrossReferencedEvent { source { __typename ... on PullRequest { number } } }
    ... on ConnectedEvent { subject { __typename ... on PullRequest { number } } } } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number } }`;
const PR_FIELDS = `number title state url isDraft mergedAt updatedAt headRefName headRefOid body mergeable author { login __typename }
  files(first: 100) { nodes { path } }
  closingIssuesReferences(first: 5) { nodes { number } }
  labels(first: 30) { nodes { name } }
  comments(last: 25) { nodes { createdAt body url author { login __typename } } }
  timelineItems(last: 60, itemTypes: [LABELED_EVENT]) { nodes { ... on LabeledEvent { createdAt label { name } } } }
  commits(last: 1) { nodes { commit { committedDate oid checkSuites(last: 20) { nodes { updatedAt } } } } }`;
const headOf = p => (((p.commits && p.commits.nodes) || [])[0] || {}).commit || null;
const lastCommentOf = n => (((n.comments && n.comments.nodes) || []).map(c => c.createdAt).filter(Boolean).sort().at(-1)) || null;
const labelsOf = n =>((n.labels && n.labels.nodes) || []).map(l => l.name);
const parkedAtOf = n => (((n.timelineItems && n.timelineItems.nodes) || []).filter(e => e && e.__typename !== "CrossReferencedEvent" && e.label && e.label.name === "needs-owner").map(e => e.createdAt).sort().at(-1)) || null;
const isDriver = body => String(body || "").includes(MARKER_PREFIX);
// only the owner's and the factory's own Apps' decisions count (the repository is public)
const ownerDecisionsOf = n => ((n.comments && n.comments.nodes) || []).filter(c => /^\s*Owner decision\b/i.test(c.body || "") && !isDriver(c.body) && isTrusted(c.author)).map(c => ({ at: c.createdAt }));
// The loop marks the item it works with "Loop claim: run <id>" and later "Loop claim released: run <id>"
// (or withdrawn); a claim is live until then or until it is CLAIM_HOURS old (loop-pick). -> ISO time or null
export const CLAIM_HOURS = 6;
export function liveClaim(nodes, now) {
  const sorted = [...(nodes || [])].filter(c => isTrusted(c.author)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const ended = new Set(sorted.map(c => /^\s*Loop claim (?:released|withdrawn)\b[^\n]*?run ([0-9a-f-]{8,})/i.exec(c.body || "")).filter(Boolean).map(m => m[1]));
  const claim = [...sorted].reverse().find(c => /^\s*Loop claim:\s*run ([0-9a-f-]{8,})/i.test(c.body || ""));
  if (!claim) return null;
  const id = /run ([0-9a-f-]{8,})/i.exec(claim.body)[1];
  if (ended.has(id) || now - Date.parse(claim.createdAt) > CLAIM_HOURS * HOUR) return null;
  return claim.createdAt;
}
const latestOf = nodes => { const c = [...(nodes || [])].reverse().find(x => !/^\s*Loop claim\b/i.test(x.body || "")); return c ? `${utc(c.createdAt)} ${c.author ? c.author.login : "?"}: ${c.body}` : ""; };
export const refsIssue = (body, n) => new RegExp(`\\b(fix(e[sd])?|close[sd]?|resolve[sd]?|refs?|part of|continues)\\b:?\\s+(#|https://github\\.com/[\\w.-]+/[\\w.-]+/issues/)${n}\\b`, "i").test(String(body || ""));

// extra: {prereqs: {number: {of}}}: what release items wait on, driven as part of the release (D-419). A pull request among them stands for the issue it refs, or
// for itself when it refs none.
export function fetchWorld(env, plan, extra = {}) {
  const repo = env.REPO; const [owner, name] = checkRepo(repo);
  const planned = [...new Set(Object.values(itemIssues(plan.plan)))];
  const wanted = [...new Set(Object.keys(extra.prereqs || {}).map(Number))].filter(n => n > 0 && !planned.includes(n)).slice(0, 20);
  const prOnly = new Map(), alias = new Map();
  if (wanted.length) {
    const d0 = gql(env, `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${wanted.map(n => `x${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { number } ... on PullRequest { number body state closingIssuesReferences(first: 5) { nodes { number } } } }`).join("\n")} } }`);
    for (const n of wanted) {
      const x = d0.repository[`x${n}`];
      if (!x || x.__typename !== "PullRequest") continue;
      const refs = [...new Set([...((x.closingIssuesReferences && x.closingIssuesReferences.nodes) || []).map(i => i.number), ...[...String(x.body || "").matchAll(/\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|refs?|part of)\b:?\s+#(\d+)/gi)].map(m => Number(m[1]))])];
      if (refs.length) alias.set(n, refs[0]); else prOnly.set(n, true);
    }
  }
  const extraIssues = [...new Set(wanted.map(n => alias.get(n) || n).filter(n => !prOnly.has(n)))].filter(n => !planned.includes(n));
  const numbers = [...new Set([...planned, ...extraIssues])];
  let priority = new Set(); // open issues labelled priority: the owner's "before everything else" (keep-main-green's tickets among them)
  const scopeOf = n => (planned.includes(n) ? null : priority.has(n) ? "priority" : "prerequisite");
  const ofOf = n => { const direct = (extra.prereqs || {})[n]; if (direct) return direct.of; const pr = [...alias].find(([, v]) => v === n); return pr ? ((extra.prereqs || {})[pr[0]] || {}).of : null; };
  const label = releaseLabel(plan.version);
  const q1 = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    labelled: issues(labels: [${JSON.stringify(label)}], first: 50, states: [OPEN]) { nodes { ${ISSUE_FIELDS} } }
    priority: issues(labels: ["priority"], first: 20, states: [OPEN]) { nodes { ${ISSUE_FIELDS} } }
    ${numbers.map(n => `i${n}: issue(number: ${n}) { ${ISSUE_FIELDS} }`).join("\n")}
  }
  owner: search(query: ${JSON.stringify(`repo:${repo} is:issue is:open in:title "${OWNER_TITLE}"`)}, type: ISSUE, first: 5) { nodes { ... on Issue { number title url body comments(last: 100) { nodes { createdAt body author { login __typename } } } } } } }`;
  const d1 = gql(env, q1);
  const issues = new Map();
  for (const n of numbers) if (d1.repository[`i${n}`]) issues.set(n, d1.repository[`i${n}`]);
  for (const n of d1.repository.labelled.nodes || []) if (!issues.has(n.number)) issues.set(n.number, n);
  priority = new Set(((d1.repository.priority && d1.repository.priority.nodes) || []).map(n => n.number));
  for (const n of (d1.repository.priority && d1.repository.priority.nodes) || []) if (!issues.has(n.number)) issues.set(n.number, n);
  const candidates = new Map();
  for (const [n, i] of issues) {
    const closedBy = ((i.closedByPullRequestsReferences && i.closedByPullRequestsReferences.nodes) || []).map(p => p.number);
    const tl = (i.timelineItems && i.timelineItems.nodes) || [];
    const linked = tl.filter(e => e.__typename === "ConnectedEvent" && e.subject && e.subject.number).map(e => e.subject.number);
    const crossed = tl.filter(e => e.__typename === "CrossReferencedEvent" && e.source && e.source.__typename === "PullRequest").map(e => e.source.number);
    candidates.set(n, { strong: new Set([...closedBy, ...linked]), weak: new Set(crossed) });
  }
  const prNumbers = [...new Set([...[...candidates.values()].flatMap(c => [...c.strong, ...c.weak]), ...prOnly.keys()])].slice(0, 60);
  const prs = new Map();
  if (prNumbers.length) {
    const d2 = gql(env, `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${prNumbers.map(n => `p${n}: pullRequest(number: ${n}) { ${PR_FIELDS} }`).join("\n")} } }`);
    for (const n of prNumbers) if (d2.repository[`p${n}`]) prs.set(n, d2.repository[`p${n}`]);
  }
  const ticketOf = n => { const e = Object.entries(itemIssues(plan.plan)).find(([, v]) => v === n); return e ? Number(e[0]) : null; };
  const items = [...issues.values()].sort((a, b) => (ticketOf(a.number) ?? 99) - (ticketOf(b.number) ?? 99) || a.number - b.number).map(i => {
    const c = candidates.get(i.number);
    const own = [...prs.values()].filter(p => (c.strong.has(p.number) || (c.weak.has(p.number) && refsIssue(p.body, i.number))) && !(p.state === "CLOSED" && !p.mergedAt));
    return {
      number: i.number, title: i.title, url: i.url, state: i.state, stateReason: i.stateReason, labels: labelsOf(i), updatedAt: i.updatedAt,
      body: i.body || "", author: i.author ? i.author.login : "", scope: scopeOf(i.number), prereqOf: ofOf(i.number), comments: (i.comments && i.comments.nodes) || [],
      parkedAt: parkedAtOf(i), ticket: ticketOf(i.number), ownerDecisions: ownerDecisionsOf(i), lastCommentAt: lastCommentOf(i),
      ...driverTrail([...((i.comments && i.comments.nodes) || [])], own.flatMap(p => (p.comments && p.comments.nodes) || [])),
      lastWordAt: lastCommentOf({ comments: { nodes: [...((i.comments && i.comments.nodes) || []), ...own.flatMap(p => (p.comments && p.comments.nodes) || [])].filter(c => !/^\s*Loop claim\b/i.test(c.body || "") && !isDriver(c.body)) } }),
      claimedAt: liveClaim([...((i.comments && i.comments.nodes) || []), ...own.flatMap(p => (p.comments && p.comments.nodes) || [])], Date.now()),
      latest: latestOf([...((i.comments && i.comments.nodes) || []), ...own.flatMap(p => (p.comments && p.comments.nodes) || [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))),
      prs: own.map(p => ({ number: p.number, url: p.url, title: p.title, state: p.state, merged: !!p.mergedAt, mergedAt: p.mergedAt || null, draft: p.isDraft, labels: labelsOf(p), updatedAt: p.updatedAt, headRefName: p.headRefName,
        head: p.headRefOid, mergeable: p.mergeable, author: p.author ? p.author.login : "", files: ((p.files && p.files.nodes) || []).map(f => f.path), comments: (p.comments && p.comments.nodes) || [],
        closes: ((p.closingIssuesReferences && p.closingIssuesReferences.nodes) || []).map(x => x.number),
        parkedAt: parkedAtOf(p), lastCommentAt: lastCommentOf(p), lastCommitAt: headOf(p) ? headOf(p).committedDate : null,
        lastCheckAt: headOf(p) ? ((((headOf(p).checkSuites || {}).nodes) || []).map(c => c.updatedAt).filter(Boolean).sort().at(-1) || null) : null,
        ownerDecisions: ownerDecisionsOf(p) })),
    };
  });
  // a pull request that stands for itself (it refs no issue)
  for (const n of prOnly.keys()) {
    const p = prs.get(n);
    if (!p) continue;
    const pc = (p.comments && p.comments.nodes) || [];
    items.push({ number: n, title: p.title, url: p.url, state: p.state === "MERGED" ? "CLOSED" : p.state, labels: labelsOf(p), updatedAt: p.updatedAt, body: p.body || "", author: p.author ? p.author.login : "",
      scope: scopeOf(n), prereqOf: ofOf(n), comments: [], ticket: null, ownerDecisions: [], lastCommentAt: lastCommentOf(p), prOnly: true, ...driverTrail([], pc),
      lastWordAt: lastCommentOf({ comments: { nodes: pc.filter(c => !/^\s*Loop claim\b/i.test(c.body || "") && !isDriver(c.body)) } }),
      claimedAt: liveClaim(pc, Date.now()), latest: latestOf(pc.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))),
      prs: [{ number: p.number, url: p.url, title: p.title, state: p.state, merged: !!p.mergedAt, mergedAt: p.mergedAt || null, draft: p.isDraft, labels: labelsOf(p), updatedAt: p.updatedAt, headRefName: p.headRefName, head: p.headRefOid, mergeable: p.mergeable,
        author: p.author ? p.author.login : "", files: ((p.files && p.files.nodes) || []).map(f => f.path), comments: pc, closes: [], parkedAt: parkedAtOf(p), lastCommentAt: lastCommentOf(p),
        lastCommitAt: headOf(p) ? headOf(p).committedDate : null, lastCheckAt: null, ownerDecisions: ownerDecisionsOf(p) }] });
  }
  const ownerIssue = ((d1.owner && d1.owner.nodes) || []).filter(i => i && i.title === OWNER_TITLE).sort((a, b) => b.number - a.number)[0] || null;
  const ownerOut = ownerIssue ? { number: ownerIssue.number, url: ownerIssue.url, questions: parseQuestions(ownerIssue.body),
    decisions: ((ownerIssue.comments && ownerIssue.comments.nodes) || []).filter(c => /^\s*Owner decision\b/i.test(c.body || "") && isTrusted(c.author)).map(c => ({ at: c.createdAt, body: String(c.body).slice(0, 600) })),
    comments: ((ownerIssue.comments && ownerIssue.comments.nodes) || []).map(c => String(c.body || "")) } : { number: null, url: "", questions: [], decisions: [], comments: [] };
  return { repo, label, items, main: readMain(env, repo), owner: ownerOut };
}
// main's head and its `required` check: "success", "failure" (the newest completed run failed and no
// newer one passed), "pending" or "none"; plus revert branches and open pull requests for the brief.
export function requiredState(runs) {
  const req = (runs || []).filter(r => r.name === "required" && r.conclusion !== "skipped").sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  const done = req.find(r => r.status === "completed");
  if (!req.length) return { state: "none" };
  if (!done) return { state: "pending", url: req[0].html_url };
  return { state: done.conclusion === "success" ? "success" : ["neutral"].includes(done.conclusion) ? "success" : "failure", url: done.html_url, at: done.completed_at || done.started_at };
}
function readMain(env, repo) {
  const head = gh(env, [`repos/${repo}/commits/main`]);
  const runs = (gh(env, [`repos/${repo}/commits/${head.sha}/check-runs?check_name=required&filter=all&per_page=100`]) || {}).check_runs || [];
  const r = requiredState(runs);
  let revertBranches = [], openPrs = [];
  try {
    const branches = [];
    for (let p = 1; p <= 5; p++) { const rows = gh(env, [`repos/${repo}/branches?per_page=100&page=${p}`]) || []; branches.push(...rows); if (rows.length < 100) break; }
    revertBranches = branches.filter(b => /revert/i.test(b.name)).slice(0, 5).map(b => {
      let checks = "";
      try {
        const cr = (gh(env, [`repos/${repo}/commits/${b.commit.sha}/check-runs?filter=latest&per_page=100`]) || {}).check_runs || [];
        const named = cr.filter(c => c.name !== "rerun");
        const count = {};
        for (const c of named) { const k = c.status === "completed" ? c.conclusion : c.status; count[k] = (count[k] || 0) + 1; }
        const failed = named.filter(c => c.status === "completed" && !["success", "skipped", "neutral"].includes(c.conclusion)).map(c => c.name).slice(0, 5);
        checks = named.length ? `${Object.entries(count).map(([k, v]) => `${v} ${k}`).join(", ")}${failed.length ? `; not passed: ${failed.join("; ")}` : ""}` : "none";
      } catch { checks = "unknown"; }
      return { name: b.name, sha: b.commit.sha, checks };
    });
    openPrs = (gh(env, [`repos/${repo}/pulls?state=open&per_page=50`]) || []).map(p => ({ number: p.number, title: p.title, headRefName: p.head && p.head.ref, labels: (p.labels || []).map(l => l.name) }));
  } catch { /* the brief then shows less; the stuck set does not depend on it */ }
  return { sha: head.sha, required: r.state, url: r.url || "", at: r.at || "", revertBranches, openPrs };
}

// ---------------------------------------------------------------- the guarded run (real)
// Exported since 2026-11-18 for the factory driver's helpers (../factory-driver/ai.mjs), which run in
// the same guarded setup: a fresh clone, a builder-App token for the one repository, gh and git behind
// the guard, the audit afterwards. One copy of it, here.
export const FORGE_PATH = CLEAN_PATH;
export const SYSTEM_PATH = ROOT_PATH;
export function asForgeSh(env, script, input, extraEnv = []) {
  const [file, argv] = asForge(env, ["bash", "-c", script], extraEnv);
  const r = spawnSync(file, argv, { input, encoding: "utf8", timeout: 15 * 60000, maxBuffer: 16 * 1024 * 1024, env: { PATH: ROOT_PATH } });
  if (r.status !== 0) throw new Error(`as ${env.FORGE_USER}: ${(r.stderr || "").trim().split("\n").slice(-2).join(" ") || `exit ${r.status}`}`);
  return r.stdout || "";
}
const sh = asForgeSh;
// A builder-App token for the one repository, without the workflows permission; the App keys are
// read here, for this one child, and never put in this process's environment or the AI's.
export const TOKEN_PERMISSIONS = "contents=write,issues=write,pull_requests=write,metadata=read,checks=read,statuses=read,actions=read";
// permissions: narrower than a builder's for a token that only files issues (the cause tickets, 2026-11-18)
export function mintToken(env, permissions = TOKEN_PERMISSIONS) {
  const keys = Object.fromEntries(fs.readFileSync(env.KEYS_FILE, "utf8").split("\n").map(l => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m => [m[1], m[2].replace(/^["']|["']$/g, "")]));
  const r = spawnSync(process.execPath, [env.TOKEN_SCRIPT, "builder", env.REPO, "--permissions", permissions],{ encoding: "utf8", timeout: 60000, env: { PATH: ROOT_PATH, ...keys } });
  const token = (r.stdout || "").trim();
  if (r.status !== 0 || !/^[\w.-]+$/.test(token)) throw new Error("no builder token: " + ((r.stderr || "").trim().split("\n").pop() || r.status));
  return token;
}
const builderLogin = env => `${env.BUILDER_APP || process.env.FD_BUILDER_APP || "builder"}[bot]`;
export function writeLogin(env, ghDir, token) {
  const hosts = ["github.com:", "    git_protocol: https", "    users:", `        ${builderLogin(env)}:`, `            oauth_token: ${token}`, `    oauth_token: ${token}`, `    user: ${builderLogin(env)}`, ""].join("\n");
  sh(env, `set -eu; umask 077; mkdir -p "${ghDir}"; t="$(mktemp "${ghDir}/.hosts.XXXXXXXX")"; cat > "$t"; mv -f "$t" "${ghDir}/hosts.yml"`, hosts);
}
// The run folder's parts (pure). work: the run's own folder under the factory user's home.
export const guardedPaths = work => ({ work, ghDir: path.posix.join(work, "gh"), bin: path.posix.join(work, "bin"), repoDir: path.posix.join(work, "repo"), guardLog: path.posix.join(work, "guard.log") });
// The environment the AI runs with (pure): the guard's shims first on its PATH, the run's own login,
// and what the guard reads (the repository, the run's marker, the owner issue, the protected paths).
// The owner's login (RD_OWNER_LOGIN) makes the guard refuse any call made with it, and a finding (RD_FINDING, the obstacle in its
// present state) makes it refuse a note already on its item (owner-guard.mjs, issue #152).
export const guardedEnv = (env, p, { marker, ownerIssue = "", protectedPaths = [], owner = env.OWNER_LOGIN || process.env.FD_OWNER_LOGIN || "", finding = "" }) => [`PATH=${p.bin}:${CLEAN_PATH}`, `GH_CONFIG_DIR=${p.ghDir}`, "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "GIT_TERMINAL_PROMPT=0",
  `RD_REPO=${env.REPO}`, `RD_MARKER=${marker}`, `RD_OWNER_ISSUE=${ownerIssue || ""}`, `RD_PROTECTED=${(protectedPaths || []).join(",")}`, `RD_GUARD_LOG=${p.guardLog}`,
  ...(owner ? [`RD_OWNER_LOGIN=${owner}`] : []), ...(finding ? [`RD_FINDING=${finding}`] : [])];
// Sets up the guarded run in `work` (emptied first): a token-backed login, the gh and git shims that
// call the guard, and a fresh clone of the product at origin/main. -> guardedPaths(work)
export function prepareGuardedRun(env, work, { gitName = "Godspeed release driver", gitEmail = DRIVER_EMAIL } = {}) {
  const p = guardedPaths(work);
  sh(env, `set -eu; umask 077; rm -rf "${work}"; mkdir -p "${path.posix.dirname(work)}" "${work}" "${p.bin}"; touch "${p.guardLog}"`);
  writeLogin(env, p.ghDir, mintToken(env));
  const shim = tool => `#!/bin/sh\nexec ${process.execPath} ${env.GUARD} ${tool} "$@"\n`;
  sh(env, `set -eu; cat > "${p.bin}/gh"; chmod 755 "${p.bin}/gh"`, shim("gh"));
  sh(env, `set -eu; cat > "${p.bin}/git"; chmod 755 "${p.bin}/git"`, shim("git"));
  sh(env, [
    "set -eu",
    `git clone -q "${env.SOURCE_CHECKOUT}" "${p.repoDir}"`,
    `cd "${p.repoDir}"`,
    `git remote set-url origin "https://github.com/${env.REPO}.git"`,
    `git config user.name "${gitName}"`,
    `git config user.email "${gitEmail}"`,
    "git fetch -q origin '+refs/heads/*:refs/remotes/origin/*' --prune",
    "git checkout -q -B main origin/main",
  ].join("\n"), null, [`GH_CONFIG_DIR=${p.ghDir}`, "GIT_TERMINAL_PROMPT=0"]);
  return p;
}
// After the run: the login goes first, the guard's log is kept in recordDir, the folder is removed.
export function cleanupGuardedRun(p, recordDir) {
  try { fs.rmSync(path.join(p.ghDir, "hosts.yml"), { force: true }); } catch {}
  try { if (recordDir && fs.existsSync(p.guardLog)) fs.copyFileSync(p.guardLog, path.join(recordDir, "guard.log")); } catch {}
  try { fs.rmSync(p.work, { recursive: true, force: true }); } catch (e) { console.error("could not remove", p.work, e.message); }
}
export const workDir = env => (env.WORK_ROOT ? path.posix.join(env.WORK_ROOT, "run") : "");
async function realAI(env, ctx) {
  const work = workDir(env); // one folder for every run (one at a time): Codex records each folder it trusts, so a new one per run would grow its list for ever
  const p = guardedPaths(work);
  const { ghDir, repoDir, guardLog } = p;
  const rec = ctx.recordDir;
  let refresh = null;
  try {
    prepareGuardedRun(env, work);
    sh(env, `set -eu; cat > "${work}/schema.json"`, JSON.stringify(REPORT_SCHEMA));
    // the token lasts an hour: a fresh one every 20 minutes
    refresh = setInterval(() => { try { writeLogin(env, ghDir, mintToken(env)); } catch (e) { console.error("token refresh failed:", e.message); } }, 20 * 60000);
    const model = ctx.model;
    const envList = guardedEnv(env, p, { marker: markerOf(ctx.runId), ownerIssue: ctx.ownerIssue, protectedPaths: ctx.protected });
    // The factory's own builders run Codex with full access as this user (Archon's codex provider);
    // Codex's own sandbox works here since D-419 (the repair and the checks use it); this run keeps full
    // access like the builders for now, held by the guard, the audit and the second check.
    const argv = ["-u", env.FORGE_USER, "--", "env", "-i", `HOME=/home/${env.FORGE_USER}`, "LANG=C.UTF-8", ...envList,
      "codex", "exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "danger-full-access", "-m", model, "-C", repoDir,
      "--output-schema", path.join(work, "schema.json"), "-o", path.join(work, "report.json"), "-"];
    const out = fs.openSync(path.join(rec, "events.jsonl"), "w"), err = fs.openSync(path.join(rec, "codex.err"), "w");
    const code = await new Promise(resolve => {
      const child = spawn("runuser", argv, { stdio: ["pipe", out, err], env: { PATH: ROOT_PATH }, detached: true });
      const kill = setTimeout(() => { try { process.kill(-child.pid, "SIGTERM"); } catch {} setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 30000); }, env.AI_MINUTES * 60000);
      child.on("exit", (c, s) => { clearTimeout(kill); resolve(c === null ? `signal ${s}` : c); });
      child.on("error", e => { clearTimeout(kill); resolve(`spawn failed: ${e.message}`); });
      child.stdin.end(ctx.brief);
    });
    fs.closeSync(out); fs.closeSync(err);
    const reportFile = path.join(work, "report.json");
    let report = null;
    try { report = JSON.parse(fs.readFileSync(reportFile, "utf8")); } catch { report = null; }
    const guard = fs.existsSync(guardLog) ? fs.readFileSync(guardLog, "utf8") : "";
    return { code, report, events: fs.readFileSync(path.join(rec, "events.jsonl"), "utf8"), guard, runDir: work, err: fs.readFileSync(path.join(rec, "codex.err"), "utf8").slice(-4000) };
  } finally {
    if (refresh) clearInterval(refresh);
    cleanupGuardedRun(p, rec);
  }
}

// ---------------------------------------------------------------- after the run
// The note on the owner issue only points at the decision on the work item (which passed the second
// check); it repeats none of the AI run's own words.
export function ownerNote(q, item, runId, at) {
  return `${MANAGER_HEADING} (question ${q.number}: ${q.heading})\n\nHandled on the work item by Mission Control's release driver, not by Michael: see its manager decision on #${item.item}, which an independent check approved before it was posted.\n\nRelease driver run ${runId}, ${utc(typeof at === "number" ? iso(at) : at)}.\n<!-- release-driver-handled:${sha(keyOf(q.heading)).slice(0, 10)} -->`;
}

// ---------------------------------------------------------------- after the run (pure, continued)
// The numbers a reported decision goes on: the item, its own open pull requests, and what this run
// itself opened (a revert, a narrowed issue). Another release item never: it gets its own decision and
// its own second check (posting removes needs-owner from every target).
export function decisionTargets(item, world, created = []) {
  const it = (world.items || []).find(i => i.number === item.item);
  const own = it ? (it.prs || []).filter(p => p.state === "OPEN").map(p => p.number) : [];
  const mine = n => own.includes(n) || created.includes(n);
  // an item outside the release gets no decision from this run (the check had no context for it)
  return [...new Set([...(it ? [item.item] : []), ...own, ...[item.pr, ...(item.post_on || [])].filter(mine)])].filter(n => Number.isInteger(n) && n > 0);
}
// The heading a helper's decision is posted under (see MANAGER_HEADING): never the owner's own.
export const asDecision = (text) => asManagerDecision(text);
// Prerequisites the loop's newest words (its last three comments: a later note must not hide them) name
// for each release item, and "Depends on: #n" in its body; what is closed by now falls away when fetched.
export function findPrereqs(world) {
  const out = {};
  for (const it of world.items || []) {
    if (it.state !== "OPEN") continue;
    const own = [it.number, ...(it.prs || []).map(p => p.number)];
    const words = loopWords([...(it.comments || []), ...(it.prs || []).filter(p => p.state === "OPEN").flatMap(p => p.comments || [])]);
    const text = [...words.map(w => w.body), ...String(it.body || "").split("\n").filter(l => /^\s*depends on:/i.test(l))].join("\n");
    for (const n of blockerRefs(text, own)) if (!out[n]) out[n] = { of: it.number, why: "the loop's newest words on it" };
  }
  return out;
}
// After the freeze: what auto-stage could not finish for the release (D-419). -> [] or one entry
export function stagingEntries(plan) {
  const rs = plan.autoStage, st = plan.staging;
  if (plan.done || (!rs && !st)) return [];
  let why = "";
  if (st && st.status === "failed") why = `the install on the owner's server is not healthy: ${short((st.failures || []).join("; ")).slice(0, 300) || "staging.json says failed"}`;
  else if (rs && rs.halted) why = `auto-stage stopped: ${short(rs.halted.why).slice(0, 300)}`;
  else if (rs && (rs.failedJobs || []).length) why = `candidate scenarios failed: ${rs.failedJobs.map(f => `${f.job} (${f.environment ? "looks like the test machines" : "looks like the release"}${f.alsoOnMain ? ", also failed on main" : ""}: ${short(f.cause).slice(0, 120)})`).join("; ")}`;
  else if (st && st.scenarios && st.scenarios.result === "failed") why = `candidate scenarios failed: ${(st.scenarios.failedJobs || []).map(j => j.name || j).join(", ")}`;
  else if (rs && rs.told && !rs.started) why = `auto-stage waits for a judgment step: ${Object.keys(rs.told).join(", ")}`;
  else if (st && st.status === "installed" && !(st.scenarios && st.scenarios.result) && Date.now() - Date.parse(st.installedAt || (rs && rs.finished) || 0) > 3 * HOUR) why = "it is installed on the owner's server, but its candidate scenarios have no result after three hours";
  else if (st && !["installed", "failed"].includes(st.status) && Date.now() - Date.parse(st.installedAt || (rs && (rs.finished || rs.started)) || 0) > 3 * HOUR) why = `its staging record says "${st.status}" and nothing has finished it for three hours`;
  if (!why) return [];
  const summary = { auto_stage: rs ? { started: rs.started, frozen: rs.frozen, finished: rs.finished, halted: rs.halted, failedJobs: rs.failedJobs, told: rs.told } : null,
    staging: st ? { status: st.status, failures: st.failures, scenarios: st.scenarios ? { result: st.scenarios.result, run: st.scenarios.run, url: st.scenarios.url, failedJobs: st.scenarios.failedJobs } : null } : null };
  return [{ id: `staging:${plan.id}@${sha(JSON.stringify(summary)).slice(0, 12)}`, kind: "staging", item: 0, title: `${plan.version} after the freeze`, url: (st && st.scenarios && st.scenarios.url) || "", since: (rs && (rs.finished || rs.started)) || "", why, staging: summary, prs: [] }];
}

// ---------------------------------------------------------------- the trust pass
// Its own lock and state file (trust.json), so the two-minute timer (--trust-only) and a look never write
// over each other. A failure keeps the cursor where it was and throws. -> {handled} | {busy} | {dry}
export function trustPass(env, deps, now, record) {
  if (env.DRY) return { dry: true };
  fs.mkdirSync(env.STATE_DIR, { recursive: true });
  const file = path.join(env.STATE_DIR, "trust.json"), lock = path.join(env.STATE_DIR, "trust.lock");
  try { if (now - fs.statSync(lock).mtimeMs > 30 * 60000) fs.rmSync(lock); } catch {}
  let fd;
  try { fd = fs.openSync(lock, "wx"); } catch (e) { if (e.code === "EEXIST") return { busy: true }; throw e; }
  try {
    const st = readJson(file, {});
    const handled = trustLook(env, deps.trustGh || deps.gh || ((a, i) => gh(env, a, i)), st, now, record);
    writeJson(file, st);
    return { handled };
  } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}

// ---------------------------------------------------------------- one look
export async function run(env, deps = {}) {
  const log = deps.log || console.log;
  const now = deps.now ? deps.now() : Date.now();
  if (env.TRUST_ONLY) { // the two-minute timer: only the trust pass, nothing else
    const record = e => { fs.mkdirSync(env.STATE_DIR, { recursive: true }); appendLine(path.join(env.STATE_DIR, "decisions.jsonl"), { at: iso(Date.now()), ...e }); };
    try { const r = trustPass(env, deps, now, record); log(r.busy ? "a trust pass is going; this one stops" : `trust pass: ${r.handled || 0} handled`); return r; }
    catch (e) { record({ kind: "trust look failed", why: String(e.message).slice(0, 200) }); log(`trust pass failed: ${e.message}`); return { failed: true }; }
  }
  if (!env.DRY) fs.mkdirSync(env.STATE_DIR, { recursive: true });
  const stateFile = path.join(env.STATE_DIR, "state.json");
  const decisionsFile = path.join(env.STATE_DIR, "decisions.jsonl");
  const lock = path.join(env.STATE_DIR, "run.lock");
  let fd;
  if (!env.DRY) {
    try { if (now - fs.statSync(lock).mtimeMs > 3 * HOUR) fs.rmSync(lock); } catch {}
    try { fd = fs.openSync(lock, "wx"); } catch (e) { if (e.code === "EEXIST") { log("another release driver run is going; this one stops"); return { busy: true }; } throw e; }
    fs.writeSync(fd, JSON.stringify({ started: iso(now), pid: process.pid })); // the watchdog reads when this look began
  }
  // a sign of life for the watchdog: the lock's time moves every five minutes while a look goes on
  const beat = fd !== undefined ? setInterval(() => { try { fs.utimesSync(lock, new Date(), new Date()); } catch {} }, 5 * 60000) : null;
  try { const out = await runLocked(env, deps, { now, log, stateFile, decisionsFile }); if (!env.DRY) writeJson(path.join(env.STATE_DIR, "finished.json"), { at: iso(Date.now()) }); return out; }
  finally { if (beat) clearInterval(beat); if (fd !== undefined) { fs.closeSync(fd); fs.rmSync(lock, { force: true }); } }
}

const HALT_TEXT = why => `The program that keeps your Godspeed release moving stopped itself, because its AI did something it is never allowed to do (${why}). Nothing more happens on the release until Mission Control has looked at it and switched it back on. Ask Mission Control to look at it when you can.`;

async function runLocked(env, deps, { now, log, stateFile, decisionsFile }) {
  const state = readJson(stateFile, {});
  state.acted ||= []; state.runs ||= []; state.product_choices ||= {}; state.owner_notes ||= []; state.prereqs ||= {}; state.told ||= {}; state.refused ||= {};
  let breached = false; // an AI run's audit found a breach: nothing is posted after it
  let sweepFailed = false; // the check for decisions posted around the guard could not be made
  let created = []; // the pull requests and issues the AI run itself opened
  let world = null;
  const save =() => { if (!env.DRY) writeJson(stateFile, state); };
  const record = entry => { if (!env.DRY) appendLine(decisionsFile, { at: iso(deps.now ? deps.now() : Date.now()), ...entry }); };
  const notify = (key, text, about) => { try { if ((deps.tell || tell)(env, state, key, text, about, now, log)) record({ kind: "told Michael", what: text }); } catch (e) { record({ kind: "telling Michael failed", why: String(e.message).slice(0, 200) }); } };
  const codexFailed = (kind, where) => notify(`codex:${kind}:${iso(now).slice(0, 10)}`, `The AI that keeps your Godspeed release moving could not work (${where}): ${TROUBLE_WORDS[kind] || TROUBLE_WORDS.other}. Nothing moves on the release until it can.`, "The release driver's AI cannot work");
  const halt = (why, run) => {
    state.halted = { at: iso(now), run, why };
    record({ kind: "halted", run, why });
    notify(`halt:${state.halted.at}`, HALT_TEXT(why), "The release driver stopped itself");
  };
  if (state.last_run && state.last_run.outcome === "running" && !env.DRY) { // the last run died before it finished (this run holds the lock now)
    state.acted = state.acted_before || [];
    state.last_run.outcome = "died before it finished";
    appendLine(decisionsFile, { at: iso(now), kind: "run died", run: state.last_run.id, why: "the last AI run ended without finishing (killed or crashed); its stuck set may be tried again" });
    let events = "";
    try { events = fs.readFileSync(path.join(env.STATE_DIR, "runs", String(state.last_run.id), "events.jsonl"), "utf8"); } catch {}
    const breaches = auditEvents(events, { runDir: workDir(env) });
    if (breaches.length) {
      for (const b of breaches) appendLine(decisionsFile, { at: iso(now), kind: "audit breach", run: state.last_run.id, what: b.what, why: b.why });
      halt(breaches.map(b => b.why).filter((v, i, a) => a.indexOf(v) === i).join("; "), state.last_run.id);
    }
    writeJson(stateFile, state);
  }
  if (env.CLEAR_HALT) { if (state.halted) { record({ kind: "halt cleared", why: state.halted.why }); delete state.halted; save(); log("halt cleared"); } else log("not halted"); return { cleared: true }; }
  if (state.halted) notify(`halt:${state.halted.at}`, HALT_TEXT(state.halted.why), "The release driver stopped itself"); // said once, also for a halt from before this version
  const ghw = deps.gh || ((args, input) => gh(env, args, input));
  // ---- trust first, every look (also with no release to drive, also while halted: the public factory
  // runs on): a decision-style comment from another account never reaches the loop or this run
  let trustFailed = false;
  if (!env.DRY) { try { trustPass(env, { ...deps, gh: ghw }, now, e => record(e)); } catch (e) { trustFailed = true; record({ kind: "trust look failed", why: String(e.message).slice(0, 200) }); } }

  const autoStage = deps.autoStage ? deps.autoStage() : readJson(env.AUTO_STAGE_STATE, {});
  const releases = deps.releases ? deps.releases() : readReleases(env.RELEASES_DIR, autoStage);
  const { picks, why: planWhy } = pickPlans(releases, env.REPO);
  if (!picks.length) { log(planWhy); state.last_look = { at: iso(now), why: planWhy }; save(); return { plan: null, why: planWhy }; }
  // Every approved release not yet on the owner's server is looked at, oldest first, in one look: one
  // lock, one AI-run budget (the gate counts every run), and at most one AI run per look.
  const claimedByOlder = new Set(); // priority issues and prerequisites an older release of this look already drives
  let out = null;
  const failures = [];
  for (const plan of picks) {
    try { out = await driveRelease(plan); }
    catch (e) { // one release that cannot be read must not stop the others
      record({ kind: "release look failed", release: plan.id, why: String(e.message).slice(0, 300) }); log(`${plan.version}: look failed: ${e.message}`);
      failures.push(e); continue;
    }
    if (out.runId || state.halted) break;
  }
  if (!out && failures.length) throw failures[0]; // none could be read: the service fails, as it did before
  return out;

  async function driveRelease(plan) {
    breached = false; sweepFailed = false; created = []; world = null;
    const marker = id => `<!-- ${MARKER_PREFIX}${id} -->`;

    // ---- the release, with what its items wait on
    const previous = readDecisions(decisionsFile, 400);
    state.prereqs[plan.id] ||= {};
    // what this approved plan says it does not do (its "What it does not do" section) is not driven for
    // this release, as a priority issue or as a prerequisite; recorded once, never a notice
    const excluded = excludedIssues(plan.plan);
    const planned = new Set(Object.values(itemIssues(plan.plan)));
    const downChain = new Set(); // prerequisites that fell away because what they waited on is excluded
    const isExcluded = n => (excluded.has(Number(n)) && !planned.has(Number(n))) || downChain.has(Number(n));
    for (let again = true; again;) { // a prerequisite of an excluded issue falls away too, down a chain
      again = false;
      for (const [n, v] of Object.entries(state.prereqs[plan.id])) if (isExcluded(n) || (v && isExcluded(v.of))) { delete state.prereqs[plan.id][n]; downChain.add(Number(n)); again = true; }
    }
    const dropExcluded = () => {
      state.excluded ||= {};
      const noted = state.excluded[plan.id] ||= [];
      const gone = [];
      for (let again = true; again;) { // down the chain: what waits on something dropped is dropped
        again = false;
        for (const i of world.items || []) if (!gone.includes(i) && i.scope && (isExcluded(i.number) || (i.scope === "prerequisite" && isExcluded(i.prereqOf)))) { gone.push(i); downChain.add(i.number); again = true; }
      }
      if (!gone.length) return;
      world.items = world.items.filter(i => !gone.includes(i));
      for (const i of gone) if (!noted.includes(i.number)) {
        noted.push(i.number);
        record({ kind: "excluded by the plan", release: plan.id, item: i.number, what: `#${i.number} is named under "What it does not do" in the approved plan${excluded.has(i.number) ? "" : ` (it waits on #${i.prereqOf}, which the plan excludes)`}; it is not driven for this release` });
      }
    };
    const scope = () => ({ prereqs: state.prereqs[plan.id] });
    world = deps.world ? deps.world(plan, scope()) : fetchWorld(env, plan, scope());
    dropExcluded();
    for (let pass = 0; pass < 2; pass++) {
      const found = findPrereqs(world);
      const fresh = Object.entries(found).filter(([n]) => !isExcluded(n) && !state.prereqs[plan.id][n] && !(world.items || []).some(i => i.number === Number(n) && i.scope === null));
      for (const [n, v] of fresh) { state.prereqs[plan.id][n] = { ...v, at: iso(now) }; record({ kind: "prerequisite found", release: plan.id, item: Number(n), what: `#${n} is something #${v.of} waits on (${v.why}); it is driven as part of the release` }); }
      for (const it of world.items || []) if (it.scope === "prerequisite" && it.state !== "OPEN") delete state.prereqs[plan.id][it.number]; // done
      if (!fresh.length || deps.world) break;
      world = fetchWorld(env, plan, scope());
      dropExcluded();
    }
    save();
    world.deadEnds = deps.deadEnds ? deps.deadEnds(world) : readDeadEnds(env, env.REPO, world.owner.questions || []);
    world.staging = stagingEntries(plan);

    // ---- the cut (release-driver-cut.mjs): an item that reached a dead end leaves the release under the
    // approved plan's own rule, the rest ships; what was cut is no longer driven for this release
    let cut = { dead: new Map(), cutIssues: new Set() };
    if (!state.halted) {
      try {
        cut = await cutLook(env, { plan, world, state, now, log, gh: ghw, records: deps.records, label: world.label || releaseLabel(plan.version),
          decisions: deps.allDecisions ? deps.allDecisions() : readDecisions(decisionsFile, 1000000),
          record: e => record(e), notify,
          factory: deps.factory || (() => factoryFacts(env, { now, world, mint: () => mintToken(env) })),
          testMachine: deps.testMachine ? deps.testMachine() : (() => { try { return readJson(env.TM_STATE, null); } catch { return null; } })() });
      } catch (e) { record({ kind: "cut look failed", release: plan.id, why: String(e.message).slice(0, 300) }); log(`cut look failed: ${e.message}`); }
      if (cut.cutIssues.size) {
        const gone = n => cut.cutIssues.has(n);
        world.items = (world.items || []).filter(i => !gone(i.number) && !(i.scope === "prerequisite" && gone(Number(i.prereqOf))));
        for (const [n, v] of Object.entries(state.prereqs[plan.id] || {})) if (v && gone(Number(v.of))) delete state.prereqs[plan.id][n];
      }
      save();
    }
    // a priority issue or prerequisite an older release of this look already drives is driven once, by it
    world.items = (world.items || []).filter(i => !i.scope || !claimedByOlder.has(i.number));
    for (const i of world.items) claimedByOlder.add(i.number);
    // the dead-end entries are repo-wide: the oldest release takes them, the others do not repeat them
    world.deadEnds = (world.deadEnds || []).filter(d => !claimedByOlder.has(`dead-end:${exactKey(d.heading)}`));
    for (const d of world.deadEnds) claimedByOlder.add(`dead-end:${exactKey(d.heading)}`);
    const reauthorized = {};
    for (const p of previous) if (p.release === plan.id && ["decided", "repaired"].includes(p.kind) && p.item && p.handled) reauthorized[p.item] = (reauthorized[p.item] || 0) + 1;

    // ---- a park the loop added after the driver's decision and before any run worked it: lifted again
    // without an AI run (planRelifts says why). The text restates the driver's own decision, which passed
    // the second check when it was posted, so it adds nothing a check could refuse.
    state.relifts ||= {};
    for (const rl of planRelifts(world, state.relifts, plan.id, state.product_choices)) {
      const key = `${plan.id}#${rl.item}`;
      if (env.DRY) { log(`would lift the park on #${rl.item} again (parked at ${utc(rl.park)}, after the driver's decision and before any run)`); continue; }
      const reliftText = reliftBody(rl, now, `relift:${iso(now)}`);
      const rc = (deps.check || (a => secondCheck(env, a, { codex: deps.codex || ((p, s) => codexJson(env, p, s)) })))({ decision: reliftText, item: world.items.find(i => i.number === rl.item) || { number: rl.item }, context: `The loop parked this item at ${rl.park}, after the driver's checked decision ${rl.decisionUrl} and before any run worked it.` });
      if (!rc.approve) {
        record({ kind: "park lift refused by the second check", release: plan.id, item: rl.item, check: rc.reason });
        // a technical matter, never Michael's: one more look later, and after a second refusal the item is left as it is
        if (!rc.trouble) { state.refused[`relift:${key}`] = (state.refused[`relift:${key}`] || 0) + 1; if (state.refused[`relift:${key}`] >= 2) state.relifts[key] = RELIFTS; save(); }
        continue;
      }
      state.relifts[key] = (state.relifts[key] || 0) + 1; save();
      try {
        const body = reliftText;
        if (rl.issueParked) ghw(["-X", "DELETE", `repos/${env.REPO}/issues/${rl.item}/labels/needs-owner`]);
        for (const p of rl.prs.filter(x => x.parked)) ghw(["-X", "DELETE", `repos/${env.REPO}/issues/${p.number}/labels/needs-owner`]);
        ghw(["-X", "POST", `repos/${env.REPO}/issues/${rl.item}/comments`, "--input", "-"], JSON.stringify({ body }));
        for (const p of rl.prs) ghw(["-X", "POST", `repos/${env.REPO}/issues/${p.number}/comments`, "--input", "-"], JSON.stringify({ body }));
        const it = world.items.find(i => i.number === rl.item);
        it.labels = (it.labels || []).filter(l => l !== "needs-owner");
        for (const p of it.prs || []) p.labels = (p.labels || []).filter(l => l !== "needs-owner");
        it.lastCommentAt = iso(now);
        record({ kind: "park lifted again", release: plan.id, item: rl.item, what: `the loop parked #${rl.item} at ${utc(rl.park)}, after the driver's decision (${rl.decisionUrl || utc(rl.decisionAt)}) and before any run worked it; lifted again (${state.relifts[key]} of ${RELIFTS})` });
        save();
      } catch (e) { record({ kind: "park lift failed", release: plan.id, item: rl.item, why: String(e.message).slice(0, 200) }); }
    }

    const protectedPaths = deps.protected || readProtected(env);
    const runCodex = deps.codex || ((p, s) => codexJson(env, p, s));
    // Every owner decision the driver posts (the AI run's, the repair's) is first judged by a second,
    // independent read-only AI run against the never-loosen rules (D-419); a refusal posts nothing.
    const postedIds = new Set(); // the comments the driver itself posted in this look
    // why the second check refused the last decision ("" when it did not refuse: it approved, or could not answer)
    let refusal = "";
    async function postDecision({ item, title, decision, targets, context, runId: rid, noCheck = false }) {
      const wi = (world.items || []).find(i => i.number === item) || { number: item, title };
      refusal = "";
      const check = noCheck ? { approve: true, reason: "the fixed decision that keeps every existing check as it is" } : (deps.check || (a => secondCheck(env, a, { codex: runCodex })))({ decision, item: wi, context });
      if (!check.approve) {
        record({ kind: "decision refused by the second check", release: plan.id, run: rid, item, what: String(decision).slice(0, 600), check: check.reason });
        if (check.trouble) codexFailed(check.trouble, "the second check of a decision");
        else refusal = short(check.reason) || "the second check refused it";
        return false;
      }
      if (breached || sweepFailed || !targets.length) return false;
      const body = `${String(decision).trim()}\n${marker(rid)}`;
      let ok = true;
      for (const n of targets) {
        try { const c = ghw(["-X", "POST", `repos/${env.REPO}/issues/${n}/comments`, "--input", "-"], JSON.stringify({ body })); if (c && c.id) postedIds.add(c.id); } catch (e) { ok = false; record({ kind: "posting a decision failed", release: plan.id, run: rid, item: n, why: String(e.message).slice(0, 200) }); continue; }
        try { ghw(["-X", "DELETE", `repos/${env.REPO}/issues/${n}/labels/needs-owner`]); } catch { /* not labelled */ }
      }
      record({ kind: "decision posted", release: plan.id, run: rid, item, what: String(decision).slice(0, 600), check: check.reason, on: targets });
      return ok;
    }
    // ---- a release pull request whose only blocker is an additive change to protected workflow files
    if (!state.halted) {
      const prs = (world.items || []).filter(i => i.state === "OPEN").flatMap(i => (i.prs || []).filter(p => p.state === "OPEN").map(p => ({ ...p, issues: i.prOnly ? [] : [i.number] })));
      const issuesOf = p => [...new Set([...(p.issues || []), ...(p.closes || [])])];
      const results = landingLook(env, { gh: ghw, ghRelease: deps.ghRelease || ((args, input) => ghRelease(env, args, input)), codex: runCodex }, prs, state, now, e => record({ release: plan.id, ...e }),
        { marker: marker(`landing:${iso(now)}`), protectedGlobs: protectedPaths, isProtected: guardIsProtected, issuesOf,
          checkDecision: a => (deps.check || (x => secondCheck(env, x, { codex: runCodex })))(a) });
      for (const r of results) if (["review-failed", "check-refused"].includes(r.status) && r.trouble) codexFailed(r.trouble, "the review of a protected change");
      if (results.length) save();
    }

    const { stuck, waiting, working } = stuckSet(world, { now, idleHours: env.IDLE_HOURS, productChoices: state.product_choices, reauthorized, refused: state.refused });

    // a product choice the manager has since put on the owner issue goes to the plain-words path (a
    // choice the driver asked through the questions helper directly is already there)
    if (!env.DRY) for (const [n, choice] of Object.entries(state.product_choices)) {
      if (choice.forwarded || choice.direct) continue;
      const q = (world.owner.questions || []).find(x => new RegExp(`#${n}\\b`).test(x.heading));
      if (!q) continue;
      const answered = listFor(readJson(path.join(env.QUESTIONS_DIR, "answered-elsewhere.json"), {}), env.REPO).map(keyOf).includes(q.key);
      if (answered) continue;
      addHeading(path.join(env.QUESTIONS_DIR, env.TO_OWNER_FILE || process.env.FD_TO_OWNER_FILE || "to-owner.json"), env.REPO, q.heading);
      choice.forwarded = q.heading;
      record({ kind: "product choice forwarded", release: plan.id, item: Number(n), what: `owner-issue question ${q.number} "${q.heading}" handed to the questions helper's plain-words path` });
      save();
    }
    // a question to Michael leaves the helper's file only when its item is closed or he answered it there
    try {
      const live = q => { const it = (world.items || []).find(i => i.number === Number(q.issue)); if (!it) return true; if (it.state !== "OPEN") return false; return !(it.ownerDecisions || []).some(d => Date.parse(d.at) > Date.parse(q.at || 0)); };
      pruneQuestions(env, env.REPO, live);
    } catch {}

    // the acted-on set belongs to one release at a time: the other releases' sets are kept aside
    state.acted_by ||= {};
    if (state.acted_release && state.acted_release !== plan.id) {
      state.acted_by[state.acted_release] = { acted: state.acted || [], acted_before: state.acted_before || [], acted_at: state.acted_at || {} };
      const mine = state.acted_by[plan.id] || {};
      state.acted = mine.acted || []; state.acted_before = mine.acted_before || []; state.acted_at = mine.acted_at || {};
    }
    state.acted_release = plan.id;
    const g = gate({ stuck, state, now, once: env.ONCE, maxPerDay: env.MAX_RUNS_PER_DAY, maxRuns: env.MAX_RUNS_24H, minGapMinutes: env.MIN_GAP_MINUTES });
    const show = () => stuck.map(e => `  ${e.id}  ${e.why}`).join("\n");
    log(`${plan.version}: ${stuck.length} stuck${stuck.length ? `:\n${show()}` : ""}${waiting.length ? `\n  waiting on Michael: ${waiting.map(w => `#${w.item}`).join(", ")}` : ""}\ngate: ${g.run ? "start the AI" : "no AI run"} (${g.why})`);
    state.last_look = { at: iso(now), release: plan.id, stuck: stuck.map(e => e.id), why: g.why };
    // a cap that keeps a stuck item waiting for more than an hour is said once (never a silent stop)
    if (g.capped && (g.fresh || []).length) {
      state.cap_blocked ||= {};
      state.cap_blocked[plan.id] ||= iso(now);
      if (now - Date.parse(state.cap_blocked[plan.id]) > HOUR) notify(`cap:${plan.id}:${state.cap_blocked[plan.id]}`, `The program that keeps your Godspeed release moving has used its AI allowance for now (${g.why}), so ${stuck.length === 1 ? "one stuck item waits" : `${stuck.length} stuck items wait`} until runs from the last 24 hours age out. Nothing is lost; it carries on by itself.`, "The release driver waits for its allowance");
    } else if (state.cap_blocked) delete state.cap_blocked[plan.id];

    const runId = `${iso(now).slice(0, 16).replace(/[-:T]/g, "")}-${sha(now + plan.id).slice(0, 6)}`;
    // ---- after the freeze: failed candidate scenarios the run judged to be the test machines' run again
    if (!env.DRY && !state.halted) { try { if (stagingRetry(env, deps, plan, state, now, e => record({ release: plan.id, ...e }), notify)) save(); } catch (e) { record({ kind: "staging retry failed", release: plan.id, why: String(e.message).slice(0, 200) }); } }

    // The verifier repair is the test machine's own program since 2026-11-17 (scripts/test-machine/,
    // Michael: "It's not the driver's job to fix code itself; it's the driver's job to drive the release").
    // The driver only reads whether the machine can observe (cutLook's testMachine).

    const strong = !!(state.escalate_for || {})[plan.id];
    const model = strong ? env.STRONG_MODEL : env.MODEL;
    const template = deps.template ?? fs.readFileSync(env.BRIEF, "utf8");
    const brief = renderBrief(template, { world, stuck, waiting, working, plan, previous: previous.slice(-15), runId, now, model, minutes: env.AI_MINUTES - 10, protected: protectedPaths, runDir: workDir(env) || ".." });
    if (env.DRY) { log(`\n----- the brief run ${runId} would get -----\n${brief}\n----- end of the brief -----`); return { plan, stuck, waiting, gate: g, brief }; }
    if (!g.run) { save(); return { plan, stuck, gate: g }; }
    // an untrusted comment that could not be neutralised must not reach this run: the next look tries again
    if (trustFailed) { save(); log("no AI run: the trust look failed"); return { plan, stuck, gate: { ...g, run: false, why: "the trust look failed" } }; }

    // ---- the AI run
    const recordDir = path.join(env.STATE_DIR, "runs", runId);
    fs.mkdirSync(recordDir, { recursive: true });
    fs.writeFileSync(path.join(recordDir, "brief.md"), brief);
    const startedAt = iso(deps.now ? deps.now() : Date.now());
    state.last_run = { at: startedAt, id: runId, model, outcome: "running" };
    state.runs = [...state.runs, { at: startedAt, id: runId, model }].slice(-60);
    const actedBefore = state.acted;
    state.acted_release = plan.id;
    state.acted_before = actedBefore;
    state.acted = stuck.map(e => e.id);
    if (strong) delete state.escalate_for[plan.id];
    save();
    record({ kind: "run started", release: plan.id, run: runId, model, why: g.why, stuck: stuck.map(e => e.id) });
    let res;
    try { res = await (deps.ai || realAI)(env, { runId, brief, model, recordDir, ownerIssue: world.owner.number, protected: protectedPaths, plan }); }
    catch (e) { res = { code: `failed: ${e.message}`, report: null, events: "", guard: "", err: e.message }; }
    if (res.report) fs.writeFileSync(path.join(recordDir, "report.json"), JSON.stringify(res.report, null, 2) + "\n");

    // ---- the audit
    const breaches = auditEvents(res.events, { runDir: res.runDir || "" });
    const refusals = String(res.guard || "").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    for (const r of refusals) record({ kind: "guard refused", release: plan.id, run: runId, what: `${r.tool} ${r.args}`, why: r.why });
    if (breaches.length) {
      breached = true;
      for (const b of breaches) record({ kind: "audit breach", release: plan.id, run: runId, what: b.what, why: b.why });
      halt(breaches.map(b => b.why).filter((v, i, a) => a.indexOf(v) === i).join("; "), runId);
    }
    // a decision or question the run posted around its guard (it holds a token with full access): the
    // driver posts those only after the second check, so any other one from the factory's App during the
    // run, not the questions helper's relay and not on the owner issue, is deleted, and the driver halts
    try {
      const relay = (deps.genuineRelay || genuineRelay)(env);
      const all = [];
      for (let p = 1; ; p++) { const rows = ghw([`repos/${env.REPO}/issues/comments?since=${encodeURIComponent(startedAt)}&sort=created&direction=asc&per_page=100&page=${p}`]) || []; all.push(...rows); if (rows.length < 100) break; if (p >= 50) throw new Error("too many comments since the run began to read them all"); }
      const issueComments = n => { const out = []; for (let p = 1; p <= 30; p++) { const rows = ghw([`repos/${env.REPO}/issues/${n}/comments?per_page=100&page=${p}`]) || []; out.push(...rows); if (rows.length < 100) break; } return out; };
      const isRelay = c => { const m = relay(c.body); return !!m && firstWithMarker(c, m, issueComments(String(c.issue_url || "").split("/").pop())); };
      // the loop and the manager write reviews, contracts and manager decisions as this same App, so
      // those count only when they carry this driver's marker; an owner decision or question the loop never
      // writes, so one no helper's state confirms is the run's
      const during = all.filter(c => isTrusted(c.user && c.user.login) && (c.user && c.user.login) !== ownerLogin() && String(c.created_at || "") >= startedAt.slice(0, 19) && DECISION_BODY.test(String(c.body || ""))
        && !postedIds.has(c.id) && (String(c.body || "").includes(MARKER_PREFIX) || (ownerHeaded(c.body) && !isRelay(c))));
      for (const c of during) {
        try { ghw(["-X", "DELETE", `repos/${env.REPO}/issues/comments/${c.id}`]); } catch {}
        breaches.push({ why: "posted an owner decision around the guard", what: `${c.html_url}: ${String(c.body || "").slice(0, 200)}` });
      }
    } catch (e) { sweepFailed = true; record({ kind: "post-run comment check failed", release: plan.id, run: runId, why: `${String(e.message).slice(0, 200)}; nothing of this run is posted, the next run decides again` }); }
    if (breaches.length && !breached) {
      breached = true;
      for (const b of breaches.filter(b => b.why === "posted an owner decision around the guard")) record({ kind: "audit breach", release: plan.id, run: runId, what: b.what, why: b.why });
      halt(breaches.map(b => b.why).filter((v, i, a) => a.indexOf(v) === i).join("; "), runId);
    }
    fs.writeFileSync(path.join(recordDir, "audit.json"), JSON.stringify({ breaches, refusals }, null, 2) + "\n");

    // ---- what it decided: checked by a second AI, then posted by the driver; nothing after a breach
    const report = validReport(res.report) ? res.report : null;
    const elsewhere = path.join(env.QUESTIONS_DIR, "answered-elsewhere.json");
    const results = [];
    const covered = new Set();
    let moved = 0;
    if (!report) {
      record({ kind: "no report", release: plan.id, run: runId, why: `the AI run ended (${res.code}) without a usable report` });
      const kind = codexTrouble(res.err || "");
      if (kind || String(res.code) !== "0") codexFailed(kind || "other", "its run on the stuck items");
    }
    // the pull requests and issues this run itself opened (marked with its marker)
    try { created = (ghw([`repos/${env.REPO}/issues?state=open&sort=created&direction=desc&per_page=30`]) || []).filter(i => String(i.created_at || "") >= startedAt.slice(0, 19) && String(i.body || "").includes(MARKER_PREFIX + runId)).map(i => i.number); } catch {}
    const refusedNow = new Set(); // an item the check refused in this run: counted once, however many entries the report has for it
    for (const item of (report ? report.items : [])) {
      const wi = (world.items || []).find(i => i.number === item.item);
      const context = [wi ? `${wi.title}\n${String(wi.body || "").slice(0, 2000)}` : "", wi ? wi.latest : "", stuck.find(e => e.item === item.item)?.why || ""].join("\n\n");
      let handled = false, routed = "";
      // a question to Michael in the machinery's words is a technical matter: it is not asked, and the item goes the way of a left item with nowhere to go
      if (!breaches.length && (item.action === "asked-michael" || (item.action === "left" && item.owner_step === "michael")) && (state.refused[item.item] || technicalWords(item.michael_question, item.decision, item.what, wi && wi.title))) {
        record({ kind: "technical question not asked", release: plan.id, run: runId, item: item.item || null, what: short(item.michael_question).slice(0, 300) });
        item.action = "left"; item.owner_step = "none";
        if (item.item > 0 && !state.refused[item.item]) state.refused[item.item] = { n: 0, reason: "a question in the machinery's words was not asked of Michael" }; // a technical item by definition: its retry never turns into a question for him
      }
      if (breaches.length) { /* nothing is acted on after a breach */ }
      else if (HANDLED.includes(item.action) && String(item.decision || "").trim()) {
        // 2026-11-19: only a product matter (what people get or see, scope, look and feel) goes to Michael,
        // in plain words. Everything technical is decided here: a decision the second check refused is tried
        // once more with the reason in the next brief, and refused twice it becomes the option that keeps
        // every existing check exactly as it is. Nothing technical is ever put to Michael.
        const toMichael = (why) => {
          try {
            const text = short(asDecision(item.decision)).slice(MANAGER_HEADING.length).replace(/^\s*:\s*/, "");
            ghw(["-X", "POST", `repos/${env.REPO}/issues/${item.item}/labels`, "--input", "-"], JSON.stringify({ labels: ["needs-owner"] }));
            askMichael(env, { repo: env.REPO, issue: item.item, heading: `${short(wi ? wi.title : item.what).slice(0, 80)} (#${item.item}, ref ${sha(`${why}|${text}`).slice(0, 8)})`,
              body: `A question about the product (${why}). Nothing is decided until you answer. What Mission Control would do: ${text.slice(0, 1500)}`, now });
            state.product_choices[item.item] = { at: startedAt, question: short(`${why}: ${text}`).slice(0, 600), direct: true };
            item.asked = true;
            record({ kind: "product choice", release: plan.id, run: runId, item: item.item, what: `${why}: ${text}`.slice(0, 600) });
          } catch (e) { record({ kind: "product choice not recorded", release: plan.id, run: runId, item: item.item, why: String(e.message).slice(0, 200) }); }
        };
        const only = technicalWords(wi && wi.title) || state.refused[item.item] ? "" : ownerOnlyReason(item.decision, item.what);
        if (only && item.item > 0) toMichael(only);
        else {
          handled = await postDecision({ item: item.item, title: wi ? wi.title : "", decision: asDecision(item.decision), targets: decisionTargets(item, world, created), context, runId });
          if (handled) delete state.refused[item.item];
          else if (refusal && item.item > 0) {
            const had = state.refused[item.item] || { n: 0 };
            const again = refusedNow.has(item.item);
            refusedNow.add(item.item);
            if (!again) state.refused[item.item] = { n: had.n + 1, reason: refusal.slice(0, 300) };
            if (!again && had.n + 1 >= 2) {
              // refused twice: the option that keeps every existing check exactly as it is, and move on
              handled = await postDecision({ item: item.item, title: wi ? wi.title : "", decision: KEEP_CHECKS_DECISION, targets: decisionTargets(item, world, created), context, runId, noCheck: true });
              if (handled) delete state.refused[item.item];
            }
          }
        }
      } else if (item.action === "asked-michael" && item.item > 0 && String(item.michael_question || "").trim()) {
        try {
          const q = asQuestion(short(item.decision || item.what));
          ghw(["-X", "POST", `repos/${env.REPO}/issues/${item.item}/comments`, "--input", "-"], JSON.stringify({ body: `${q}\n${marker(runId)}` }));
          ghw(["-X", "POST", `repos/${env.REPO}/issues/${item.item}/labels`, "--input", "-"], JSON.stringify({ labels: ["needs-owner"] }));
          askMichael(env, { repo: env.REPO, issue: item.item, heading: `${short(wi ? wi.title : item.what).slice(0, 80)} (#${item.item})`, body: short(item.michael_question), now });
          state.product_choices[item.item] = { at: startedAt, question: short(item.michael_question).slice(0, 600), direct: true };
          item.asked = true;
          record({ kind: "product choice", release: plan.id, run: runId, item: item.item, what: short(item.michael_question).slice(0, 600) });
        } catch (e) { record({ kind: "product choice not recorded", release: plan.id, run: runId, item: item.item, why: String(e.message).slice(0, 200) }); }
      } else if (item.action === "left") {
        routed = item.owner_step || "none";
        if (routed === "referee-repair") { /* the test machine's watcher repairs and re-observes on its own */ }
        else if (routed === "prerequisite") for (const n of (item.prerequisites || []).filter(n => n > 0 && n !== item.item && !isExcluded(n))) state.prereqs[plan.id][n] ||= { of: item.item, at: iso(now), why: "the driver's run named it" };
        else if (routed === "staging-retry") state.staging_retry = { release: plan.id, at: iso(now), why: short(item.what).slice(0, 300) };
        else if (routed === "michael" && item.item > 0 && String(item.michael_question || "").trim()) {
          askMichael(env, { repo: env.REPO, issue: item.item, heading: `${short(wi ? wi.title : item.what).slice(0, 80)} (#${item.item})`, body: short(item.michael_question), now });
          state.product_choices[item.item] = { at: startedAt, question: short(item.michael_question).slice(0, 600), direct: true };
        } else if (routed !== "protected-landing") {
          // a "left" with nowhere to go is never the end: the next run gets the stronger model, and the
          // second time the driver decides it itself: every existing check stays as it is, the work goes on (never a question to Michael)
          state.unrouted ||= {};
          const k = `${plan.id}#${item.item}`;
          state.unrouted[k] = (state.unrouted[k] || 0) + 1;
          (state.escalate_for ||= {})[plan.id] = true;
          if (state.unrouted[k] >= 2 && item.item > 0) { try { if (await postDecision({ item: item.item, title: wi ? wi.title : "", decision: KEEP_CHECKS_DECISION, targets: decisionTargets(item, world, created), context, runId, noCheck: true })) { handled = true; delete state.unrouted[k]; } } catch (e) { record({ kind: "fixed decision not posted", release: plan.id, item: item.item, why: String(e.message).slice(0, 200) }); } }
          routed = "unrouted";
        }
      }
      // a route towards a dead end is not progress: it no longer counts as moved (release-driver-cut.mjs)
      const deadRoute = routedToDeadEnd(item, cut.dead, state.prereqs[plan.id]);
      if (handled || (routed && routed !== "unrouted" && !deadRoute) || item.asked) moved++;
      results.push({ ...item, handled, routed });
      record({ kind: item.action, release: plan.id, run: runId, item: item.item || null, pr: item.pr || null, what: item.what, links: item.links, handled, routed: routed || undefined, owner_step: item.owner_step, ...(deadRoute ? { dead_end: true } : {}) });
      const settledHere = handled || item.action === "nothing" || (item.action === "left" && routed && routed !== "unrouted") || (item.action === "asked-michael" && item.asked);
      const matched = [];
      for (const e of stuck) {
        const match = (e.item && e.item === item.item) || (e.kind === "dead-end" && ((item.dead_ends_handled || []).some(h => keyOf(h) === keyOf(e.heading)) || (item.item > 0 && new RegExp(`#${item.item}(?!\\d)`).test(e.heading))))
          || (e.kind === "staging" && item.item === 0 && (item.owner_step === "staging-retry" || item.action !== "left"));
        if (match) matched.push(e.id);
      }
      if (!handled) { if (settledHere) matched.forEach(id => covered.add(id)); continue; }
      let failed = false;
      const known = (wi ? wi.prs : []).filter(p => p.state === "OPEN").map(p => p.number);
      const names = q => [item.item, item.pr, ...known].some(n => n > 0 && new RegExp(`#${n}(?!\\d)`).test(q));
      const questions = world.owner.questions || [];
      const wanted = [...(item.owner_questions_handled || []).map(n => questions.find(x => x.number === n)),
        ...(item.dead_ends_handled || []).map(h => questions.find(x => x.key === keyOf(h)))].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
      for (const q of wanted) {
        if (!world.owner.number) continue;
        if (!names(q.heading)) { record({ kind: "owner issue not noted", release: plan.id, run: runId, item: item.item || null, why: `question ${q.number} "${q.heading}" does not name #${item.item}` }); continue; }
        const tag = `release-driver-handled:${sha(keyOf(q.heading)).slice(0, 10)}`;
        try {
          const posted = state.owner_notes.includes(tag) || (world.owner.comments || []).some(b => b.includes(tag))
            || (ghw([`repos/${env.REPO}/issues/${world.owner.number}/comments?per_page=100&since=${encodeURIComponent(iso(now - 30 * 24 * HOUR))}`]) || []).some(c => String(c.body || "").includes(tag));
          if (!posted) { const c = ghw(["-X", "POST", `repos/${env.REPO}/issues/${world.owner.number}/comments`, "--input", "-"], JSON.stringify({ body: ownerNote(q, item, runId, Date.now()) })); if (c && c.id) postedIds.add(c.id); }
          if (!state.owner_notes.includes(tag)) state.owner_notes = [...state.owner_notes, tag].slice(-200);
          addHeading(elsewhere, env.REPO, q.heading);
          record({ kind: "owner issue noted", release: plan.id, run: runId, item: item.item || null, what: `question ${q.number} "${q.heading}" marked handled on #${world.owner.number} and in answered-elsewhere.json` });
        } catch (e) { failed = true; record({ kind: "owner issue note failed", release: plan.id, run: runId, item: item.item || null, why: String(e.message).slice(0, 200) }); }
      }
      for (const h of item.dead_ends_handled || []) {
        const d = (world.deadEnds || []).find(x => keyOf(x.heading) === keyOf(h));
        if (!d) continue;
        if (!names(d.heading)) { record({ kind: "dead end not marked", release: plan.id, run: runId, item: item.item || null, why: `"${d.heading}" does not name #${item.item}` }); continue; }
        try {
          addHeading(elsewhere, env.REPO, d.heading);
          appendLine(path.join(env.WORKER_DIR, "decisions.jsonl"), { at: iso(Date.now()), kind: "handled by the release driver", repo: env.REPO, question: d.heading, what: `${short(item.what).slice(0, 300)} (${(item.links || [])[0] || `#${item.item}`})` });
          record({ kind: "dead end handled", release: plan.id, run: runId, item: item.item || null, what: `"${d.heading}" marked handled (answered-elsewhere.json, queue worker log)` });
        } catch (e) { failed = true; record({ kind: "dead end marking failed", release: plan.id, run: runId, item: item.item || null, why: String(e.message).slice(0, 200) }); }
      }
      if (!failed) matched.forEach(id => covered.add(id));
    }
    state.acted = [...new Set([...actedBefore.filter(id => stuck.some(e => e.id === id) && !covered.has(id) && !(state.acted_at && state.acted_at[id] && now - Date.parse(state.acted_at[id]) > ACTED_HOURS * HOUR)), ...covered])];
    state.acted_at = Object.fromEntries(state.acted.map(id => [id, covered.has(id) ? startedAt : ((state.acted_at || {})[id] || startedAt)]));
    if (report && report.wants_stronger_model && !strong) (state.escalate_for ||= {})[plan.id] = true;
    const runEntry = state.runs.find(r => r.id === runId);
    if (runEntry) runEntry.moved = moved > 0;
    state.last_run = { ...state.last_run, outcome: report ? `${results.length} item${results.length === 1 ? "" : "s"}${breaches.length ? ", halted" : ""}` : `no report (${res.code})`, summary: report ? report.summary : "" };
    record({ kind: "run finished", release: plan.id, run: runId, why: `exit ${res.code}`, what: report ? report.summary : "", breaches: breaches.length, refusals: refusals.length, moved });
    save();
    log(`run ${runId}: ${state.last_run.outcome}${report ? `\n${report.summary}` : ""}`);
    return { plan, stuck, gate: g, runId, report, results, breaches, refusals };
  }
}

// The release App, narrowed to merging (contents, pull requests, workflows): the only identity GitHub
// lets merge a change to workflow files. The key is read for the one child that mints the token.
let releaseCache = null;
function ghRelease(env, args, input) {
  if (!releaseCache || Date.now() - releaseCache.at > 30 * 60000) {
    const keys = Object.fromEntries(fs.readFileSync(env.KEYS_FILE, "utf8").split("\n").map(l => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m => [m[1], m[2].replace(/^["']|["']$/g, "")]));
    const r = spawnSync(process.execPath, [env.TOKEN_SCRIPT, "release", env.REPO, "--permissions", "contents=write,pull_requests=write,workflows=write"], { encoding: "utf8", timeout: 60000, env: { PATH: ROOT_PATH, ...keys } });
    const token = (r.stdout || "").trim();
    if (r.status !== 0 || !/^[\w.-]+$/.test(token)) throw new Error("no release App token: " + ((r.stderr || "").trim().split("\n").pop() || r.status));
    releaseCache = { token, at: Date.now() };
  }
  const r = spawnSync("gh", ["api", ...args], { input, encoding: "utf8", timeout: 120000, env: { PATH: ROOT_PATH, HOME: "/root", GH_TOKEN: releaseCache.token } });
  if (r.status !== 0) throw new Error((r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`);
  return JSON.parse(r.stdout || "null");
}

// After the freeze (D-419): when the AI run judged the candidate's failed scenarios to be the test
// machines' (owner step staging-retry), only the failed jobs run once more, at most twice per release,
// as the builder App (an empty gh folder and its token, never root's own login, the owner's). A rerun
// that passes goes to staging-check, which records it and tells him "it is on your server" (once, its own rule).
export const ghRoot = (env, args, input, spawn = spawnSync) => {
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-gh-"));
  try {
    const token = mintToken(env, "actions=write,metadata=read");
    const r = spawn("gh", ["api", ...args], { input, encoding: "utf8", timeout: 120000, env: { PATH: ROOT_PATH, GH_CONFIG_DIR: ghDir, GH_TOKEN: token, GH_PROMPT_DISABLED: "1" } });
    if (r.status !== 0) throw new Error((r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`);
    return JSON.parse(r.stdout || "null");
  } finally { fs.rmSync(ghDir, { recursive: true, force: true }); }
};
export function stagingRetry(env, deps, plan, state, now, record, notify = () => {}) {
  const want = state.staging_retry;
  if (!want || want.release !== plan.id) return false;
  const run = plan.staging && plan.staging.scenarios && plan.staging.scenarios.run;
  if (!run) return false; // nothing recorded to run again yet
  const ghr = deps.ghRoot || ((args, input) => ghRoot(env, args, input));
  state.staging_reruns ||= {};
  const r = (state.staging_reruns[plan.id] ||= { count: 0 });
  if (!r.run || r.done) {
    if (r.count >= 2) {
      record({ kind: "staging reruns used up", what: `run ${run} was run again twice and still failed; the next AI run decides what is left` });
      notify(`staging-reruns:${plan.id}`, `${plan.staging && plan.staging.status === "installed" ? `Godspeed ${plan.version} is on your server, but some` : `Godspeed ${plan.version} is not finished: some`} of its tests still failed after being run again twice on the test machines. The release program now treats them as real problems and has the factory look at them; you do not need to do anything.`, `Godspeed ${plan.version}: tests still failing`);
      delete state.staging_retry;
      return true;
    }
    ghr(["-X", "POST", `repos/${env.REPO}/actions/runs/${run}/rerun-failed-jobs`]);
    Object.assign(r, { count: r.count + 1, run, at: iso(now), done: false });
    record({ kind: "staging rerun started", what: `candidate scenarios run ${run}, its failed jobs only (${r.count} of 2)` });
    return true;
  }
  const info = ghr([`repos/${env.REPO}/actions/runs/${run}`]);
  if (!info || info.status !== "completed" || Date.parse(info.updated_at || 0) < Date.parse(r.at)) return false;
  r.done = true;
  if (info.conclusion === "success") {
    const c = (deps.stagingCheck || (() => spawnSync(process.execPath, ["scripts/release/staging-check.mjs", env.REPO, plan.version, "--release", plan.id, "--tell"], { cwd: env.DEV_CHECKOUT, encoding: "utf8", timeout: 20 * 60000, env: { PATH: ROOT_PATH, HOME: "/root", RECORDS_PUSH_TOKEN: recordsToken(env) } })))();
    record({ kind: "staging check after the rerun", what: `run ${run} passed on its rerun; staging-check exit ${c.status}` });
    delete state.staging_retry;
  } else record({ kind: "staging rerun failed", what: `run ${run}: ${info.conclusion}` });
  return true;
}

function readProtected(env) {
  const fallback = ["MISSION.md", "FACTORY.md", "FACTORY_RULES.md", "harness/**", ".factory/**", "factory/**", ".claude/settings.json", ".ignore", "engineering.md", "AGENTS.md", "CLAUDE.md", ".github/**", ".archon/**", "stage.json"];
  try {
    const cfg = gh(env, [`repos/${env.REPO}/contents/harness/harness.config.json?ref=main`]);
    const list = String(JSON.parse(Buffer.from(cfg.content, "base64").toString()).protected_paths || "").split(",").map(s => s.trim()).filter(Boolean);
    return [...new Set([...fallback, ...list])];
  } catch { return fallback; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(defaults()).then(() => process.exit(0), e => { console.error("release-driver failed:", e.message); process.exit(1); });
}
