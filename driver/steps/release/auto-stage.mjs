#!/usr/bin/env node
// A finished release stages itself (Mission Control D-414, Michael, 14 November 2026).
//
//   node scripts/release/auto-stage.mjs [--dry-run] [--release <id>]   one look (the timer: every 15 minutes)
//   node scripts/release/auto-stage.mjs --explain <release-id>           what it would write into each ticket
//   node scripts/release/auto-stage.mjs --install-help                   how it is installed on a server
//
// WHY. roles/release.md says what the release step does once the last ticket of an approved release
// is merged, but nothing noticed that moment: on 14 November 2026 beta.24's six items were merged by
// 00:50 and nothing happened for 13 hours, because a person had to see it and start the step. This
// is that person's noticing, as a script on the factory's server. It never decides anything the
// release step decides by judgment, and it never promotes (promote.mjs and record-go.mjs stay
// manual, process.md section 7: nothing public without his go).
//
// WHAT IT DOES, in one look, stopping at the first thing that says wait:
//   1. Picks the newest release folder whose plan.md says "status: approved", that is newer than what
//      the public has and has no staging.json yet (or one it started itself and has not finished).
//      An approved release older than the version installed on the owner's server is superseded:
//      skipped with one log line, as the factory driver skips it (18 November 2026, beta.27).
//   2. Reads the tickets. THE SIGNAL THAT A TICKET IS DONE is its issue: closed as completed and
//      closed by a merged pull request (GitHub's closedByPullRequestsReferences, which names the
//      merge commit). Before the release step a ticket file says nothing: `Status: done (merge <sha>)`
//      is written by the release step, so this writes it from exactly that merge commit (beta.24's
//      six tickets agree with it, see --explain). The ticket-to-issue link is the plan's own
//      "Issues: item 1 #489, 2 #491, ..." line, the ticket's number being the item. An issue still
//      open means wait. A ticket without an issue, an issue closed without being done (the factory
//      cut it) or without a merged pull request means a person decides (scope-amendment.json), so
//      it says so once (since 17 November 2026: a ticket whose issue was closed with nothing of it on
//      main leaves the release under the plan's dead-end rule instead, see below).
//   3. Waits and says so ONCE when the plan itself says a change under .github/ is done by hand
//      (beta.24: "Mission Control adds it by hand" for a scenario job; the Apps have no `workflows`
//      permission), or when freeze.mjs --dry-run refuses (its sentence is the reason; the
//      Windows setup of a new commit may still be building, so a refusal that may pass by itself is
//      only said after it has lasted blockedGraceMinutes; one that will not pass by itself is said at
//      once). Nothing of this halts: every look tries again and carries on the moment the reason is
//      gone. A person who did the hand step writes the line
//      "Auto-stage: proceed" into the plan; a plan with a "## Release step" section was taken over by
//      a person and is left alone.
//      SINCE 17 NOVEMBER 2026 (Michael: every stall needed him or Mission Control) these resolve
//      themselves: a wrong version is raised by the release step's own pull request (versionStep:
//      the builder App opens release/version-<version> with notebook/package.json and the README's
//      "New in" section written from the plan's delivered items, the release App approves and merges
//      it once `required` passed; a failed check is said once with its cause and it is merged when it
//      passes); a tag that exists already is carried on from. His "go" before anything is public
//      stays his. A ticket whose issue was closed with nothing on main is moved to the next release
//      under the plan's dead-end rule by the factory driver alone since 18 November 2026 (only the
//      driver moves tickets; engine scripts/factory-driver/): this step waits for that amendment and
//      says nothing, and goes on once freeze's own reader accepts it.
//   4. Runs exactly the steps of roles/release.md with the existing scripts, never re-implementing
//      them: freeze.mjs --no-staging (so the scenarios can start on the tag first, step 3 of the
//      role, and run beside the install), the scenarios on candidate/<version>, stage-server.mjs,
//      staging-check.mjs --tell.
//   5. Pauses Cole Medin's factory while the scenarios run (the scenario AI key is small and a lap
//      would spend it too) by creating <factory>/.factory/STOP, and removes it in every case: when
//      the step ends, fails, or the process is stopped. A STOP file this script made is also removed
//      at the start of the next look when it is older than stopMaxAgeMinutes, because a stale STOP
//      stops every lap silently. A STOP somebody else made is never touched.
//   6. MONEY: at most one candidate run, plus one rerun of only the failed jobs. The dispatch is
//      written to the state file before it happens, and a crash in between is resumed by looking at
//      GitHub, never by dispatching again.
//   7. Every scenario passed: staging-check.mjs --tell sends him "it is on your server, shall I make
//      it public?". Some failed: that message is never sent by staging-check, and on 14 November
//      nobody told him. So this sends ONE plain message: each failed test in one sentence, its cause
//      read from the job log (the scenarios print "FAIL <name>: <what went wrong>"), and whether it
//      looks caused by this release or by the test machines (it also failed on main's nights, or
//      GitHub limited requests, or the AI answered nothing). His go then goes through record-go.mjs
//      with --cause per failed job, which stays manual.
//   8. Once only: the state file (stateDir/state.json) keeps what was done and said, so a release is
//      staged and announced once. Messages go through Godspeed's notice queue with an id made from
//      the release and the reason, so even a crash between sending and saving cannot send twice.
//
// MOVES INTO THE FORGE ADD-ON UNCHANGED (D-414): no secret is in here and nothing is hard-coded to
// his server except the defaults in CONFIG_DEFAULTS, each overridable with an AUTO_STAGE_* variable.
// Reads and the scenario start use the login of the machine's `gh` (roles/release.md step 3 starts
// the scenarios with plain `gh workflow run`: the release App has no actions=write, and no issue
// or pull request read either); the release App's keys are used only inside freeze.mjs, and the
// records are pushed with the checkout's own git credential, as the release scripts always did.
// The service pulls this checkout from godspeed-dev's main before every look and runs it as root:
// whoever can push to that main (the owner and the release App, by its rules) can change what runs
// there. That is the trust the follow-main timer already rests on.
//
// Node's own modules only.
import fs from "node:fs";
import { readDeferrals, leavesSomething, deferredWords } from "./scope-amendment.mjs";
import * as D from "./auto-drive.mjs";
import { realDrive, realVersionPull } from "./auto-drive-real.mjs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as R from "./release-api.mjs";
import * as G from "./staging.mjs";
import { cfg as RELEASE, need, configText, configureFromEnv } from "./config.mjs";
import { makeHalt, plainHaltWords, OWNER_YES_KEYS } from "./halts.mjs";
import { deliveryClaims, alreadyQuery, alreadyMerges, namesIssue } from "../../delivery.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(THIS_FILE);
// The helpers it starts as their own processes (each reads its settings from FORGE_RELEASE_CONFIG).
const helper = (name) => path.join(HERE, name);
const MINUTE = 60 * 1000;

// ---------- the one config place ----------

export const CONFIG_DEFAULTS = {
  repo: "", // AUTO_STAGE_REPO: the settings' main project repository
  stateDir: "", // AUTO_STAGE_STATE_DIR: steps.stage.state_dir
  stopFile: "", // AUTO_STAGE_STOP_FILE: steps.stage.stop_file, else <the main project's checkout>/.factory/STOP
  stopMaxAgeMinutes: 120, // AUTO_STAGE_STOP_MAX_AGE_MINUTES
  noticesFile: "", // AUTO_STAGE_NOTICES_FILE: notices.godspeed_notices_file
  scenarioMac: true, // AUTO_STAGE_MAC: the role's "-f mac=true once per candidate"
  scenarioWaitMinutes: 100, // AUTO_STAGE_SCENARIO_WAIT_MINUTES: how long one look waits for the scenarios, rerun included
  pollSeconds: 60, // AUTO_STAGE_POLL_SECONDS
  dispatchGraceMinutes: 10, // AUTO_STAGE_DISPATCH_GRACE_MINUTES: a started run may take this long to show
  blockedGraceMinutes: 60, // AUTO_STAGE_BLOCKED_GRACE_MINUTES: a refusal must last this long before it is a halt
  ghTokenCommand: "gh auth token", // AUTO_STAGE_GH_TOKEN_COMMAND
};

export function loadConfig(env = process.env) {
  const num = (name, def) => (env[name] !== undefined && env[name] !== "" && Number.isFinite(Number(env[name])) ? Number(env[name]) : def);
  const d = CONFIG_DEFAULTS;
  return {
    repo: env.AUTO_STAGE_REPO || d.repo || RELEASE.productRepo,
    stateDir: env.AUTO_STAGE_STATE_DIR || d.stateDir,
    stopFile: env.AUTO_STAGE_STOP_FILE || d.stopFile,
    stopMaxAgeMinutes: num("AUTO_STAGE_STOP_MAX_AGE_MINUTES", d.stopMaxAgeMinutes),
    noticesFile: env.AUTO_STAGE_NOTICES_FILE || d.noticesFile || RELEASE.noticesFile || `${G.GODSPEED_ON_SERVER}/.godspeed/notices.json`,
    scenarioMac: env.AUTO_STAGE_MAC === undefined ? d.scenarioMac : !/^(0|false|no)$/i.test(env.AUTO_STAGE_MAC),
    scenarioWaitMinutes: num("AUTO_STAGE_SCENARIO_WAIT_MINUTES", d.scenarioWaitMinutes),
    pollSeconds: num("AUTO_STAGE_POLL_SECONDS", d.pollSeconds),
    dispatchGraceMinutes: num("AUTO_STAGE_DISPATCH_GRACE_MINUTES", d.dispatchGraceMinutes),
    blockedGraceMinutes: num("AUTO_STAGE_BLOCKED_GRACE_MINUTES", d.blockedGraceMinutes),
    ghTokenCommand: env.AUTO_STAGE_GH_TOKEN_COMMAND || d.ghTokenCommand,
  };
}

// ---------- pure: which release, which version ----------

// 2.0.0-beta.24 from godspeed-2.0.0-beta.24-never-empty-handed; null when the folder names none.
export function releaseVersion(id) {
  const m = String(id).match(/(\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+(?:\.\d+)*)?)/);
  return m && R.VERSION_PATTERN.test(m[1]) ? m[1] : null;
}

export const planApproved = (plan) => /^\s*status:\s*approved\b/im.test(String(plan || ""));
export const planRepository = (plan) => (String(plan || "").match(/^repository:\s*`?([^\s`]+)/im) || [])[1] || null;
export const planTitle = (plan) => (String(plan || "").match(/^# .*?\d+\.\d+\.\d+\S*:\s*(.+?)\s*$/m) || [])[1] || null;
export const planProceeds = (plan) => /^\s*auto-stage:\s*(proceed|go)\b/im.test(String(plan || ""));
export const planTakenOver = (plan) => /^##\s+Release step\b/im.test(String(plan || ""));

// The newest version installed on the owner's server: the release folders whose staging.json says
// "installed", by the release's own version (its folder name, so a re-freeze 2.0.0-beta.26.1 of
// beta.26 is still beta.26). releases: [{id, staging}]. -> version or null.
export function installedVersion(releases) {
  return releases.filter((r) => r.staging && r.staging.status === "installed" && releaseVersion(r.id))
    .map((r) => releaseVersion(r.id)).sort(G.compareVersions).at(-1) || null;
}

// The newest release to look at. releases: [{id, plan, hasStaging}]; inProgress: ids this script
// started and has not finished; publicVersion: what the public has; installedVersion: what the owner's
// server has. An approved release older than that is superseded (18 November 2026: beta.27 stayed
// approved after beta.28 was installed, and every look picked it and said needs-judgment, which can
// keep the next release from staging); it is skipped, as the factory driver skips it. Returns
// {pick, why, superseded}.
export function pickRelease({ releases, inProgress = [], publicVersion = null, installedVersion: installed = null, repo = RELEASE.productRepo }) {
  const approved = releases
    .map((r) => ({ ...r, version: releaseVersion(r.id) }))
    .filter((r) => r.version && planApproved(r.plan) && String(planRepository(r.plan) || "").toLowerCase() === repo.toLowerCase())
    .filter((r) => !publicVersion || G.compareVersions(r.version, publicVersion) > 0)
    .sort((a, b) => G.compareVersions(b.version, a.version));
  const superseded = installed ? approved.filter((r) => G.compareVersions(r.version, installed) < 0) : [];
  const usable = approved.filter((r) => !superseded.includes(r));
  const found = pickFrom(usable, inProgress);
  return { ...found, superseded };
}
function pickFrom(usable, inProgress) {
  const started = usable.find((r) => inProgress.includes(r.id));
  if (started) return { pick: started, why: "it was started here and is not finished" };
  const open = usable.find((r) => !r.hasStaging);
  if (open) return { pick: open, why: "approved, newer than the public version, and not on the server yet" };
  if (usable.length) return { pick: null, why: `the newest approved release, ${usable[0].version}, is already staged (its staging.json exists)` };
  return { pick: null, why: "no approved release is newer than what the public has" };
}

// ---------- pure: tickets and their issues ----------

// {1: 489, 2: 491, ...} from the plan's "Issues: item 1 #489, 2 #491, ..." line (items 1 #452, 2 #372 ...).
export function itemIssues(plan) {
  const out = {};
  const line = String(plan || "").split(/\r?\n/).find((l) => /\bIssues:/.test(l));
  if (!line) return out;
  for (const m of line.slice(line.indexOf("Issues:") + 7).matchAll(/(?:items?\s+)?(\d+)\s+#(\d+)/gi)) out[Number(m[1])] = Number(m[2]);
  return out;
}

export const ticketItem = (file) => {
  const m = path.basename(file).match(/^(\d+)/);
  return m ? Number(m[1]) : null;
};

const DONE_LINE = /^Status:\s*done\b.*\bmerge\s+([0-9a-f]{40})\b/im;

// The ticket text with `Status: done (merge <sha>)` as its first line, replacing a Status line.
export function markTicket(body, merge) {
  const line = `Status: done (merge ${merge})`;
  const text = String(body || "");
  if (/^Status:.*$/im.test(text)) return text.replace(/^Status:.*$/im, line);
  return `${line}\n\n${text}`;
}

// What the issues say about the release's tickets.
//   tickets: [{file, body}], issues: {number: {state, stateReason, merges: [{number, mergedAt, commit, repo, base}]}}
//   extraOpen: numbers of open issues that carry the release's label but are no ticket's.
//   deferred: ticket file names a person deferred (scope-amendment.json); freeze.mjs checks that decision itself.
//   repo: the product repository; only its pull requests into main count, and a ticket that says it
//   belongs to another repository is a person's.
// -> {state: "complete" | "waiting" | "judgment", marks: [{file, merge, issue}], waitingOn: [..], reasons: [..],
//     deadEnds: [{file, item, issue, why}]}
// The reasons are written for him: the plan's item number, no file names or issue numbers.
// deadEnds are the tickets whose issue was closed and nothing of it reached main (closed without being
// done, or closed with no merged change): under the plan's dead-end rule they leave the release.
export function judgeCompleteness({ tickets, plan, issues, extraOpen = [], deferred = [], repo = null }) {
  const items = itemIssues(plan);
  const marks = [];
  const waitingOn = [];
  const reasons = [];
  const deadEnds = [];
  for (const t of tickets) {
    if (DONE_LINE.test(t.body)) continue; // the release step (or this script) already wrote it
    if (deferred.includes(path.basename(t.file))) continue;
    const item = ticketItem(t.file);
    const number = item === null ? null : items[item];
    const which = item === null ? `the ticket ${path.basename(t.file)}` : `item ${item} of the plan`;
    const other = (t.body.match(/^Repository:\s*([^\s]+)/im) || [])[1];
    if (repo && other && other.replace(/[.,;:]+$/, "").toLowerCase() !== repo.toLowerCase()) {
      reasons.push(`${which} belongs to another repository, which I do not read`);
      continue;
    }
    if (!number) {
      reasons.push(`${which} has no issue named in the plan`);
      continue;
    }
    const issue = issues[number];
    if (!issue) {
      waitingOn.push(`#${number} (could not be read)`); // GitHub's answer: the next look reads it again
      continue;
    }
    if (issue.state !== "CLOSED") {
      waitingOn.push(`#${number}`);
      continue;
    }
    if (issue.stateReason && issue.stateReason !== "COMPLETED") {
      reasons.push(`${which} was closed without being done (${String(issue.stateReason).toLowerCase().replace(/_/g, " ")})`);
      deadEnds.push({ file: t.file, item, issue: number, why: `its issue was closed without being done (${String(issue.stateReason).toLowerCase().replace(/_/g, " ")})` });
      continue;
    }
    const merged = (issue.merges || [])
      .filter((m) => m.mergedAt && m.commit && (!repo || !m.repo || m.repo.toLowerCase() === repo.toLowerCase()) && (!m.base || m.base === "main"))
      .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
    if (!merged.length) {
      reasons.push(`${which} is closed but no merged change on main closed it`);
      deadEnds.push({ file: t.file, item, issue: number, why: "its issue was closed but no merged change on main closed it" });
      continue;
    }
    marks.push({ file: t.file, merge: merged[0].commit, issue: number });
  }
  for (const n of extraOpen) waitingOn.push(`#${n}`);
  if (waitingOn.length) return { state: "waiting", marks, waitingOn, reasons, deadEnds };
  if (reasons.length) return { state: "judgment", marks, waitingOn, reasons, deadEnds };
  return { state: "complete", marks, waitingOn, reasons, deadEnds };
}

// ---------- pure: what the plan says is done by hand ----------

// The sentence of the plan (before its own "Release step" log) that says a step is done by hand, or
// null. Beta.24: "Mission Control adds it by hand once item 3's pull request says what it should do."
// Only a change under .github/ (a workflow, a scenario job) is a hand step: the Apps have no
// `workflows` permission. Everything else the plan may call "by hand" (the version bump above all)
// the release step does itself (17 November 2026: the version is a pull request of its own).
export function planNeedsHand(plan) {
  if (planProceeds(plan)) return null;
  let text = String(plan || "");
  const at = text.search(/^##\s+Release step\b/im);
  if (at >= 0) text = text.slice(0, at);
  text = text.replace(/[`*]/g, "");
  // Paragraph by paragraph, then sentence and list item by sentence and list item.
  for (const para of text.split(/\r?\n[ \t]*\r?\n/)) {
    const flat = para.replace(/[ \t]*\r?\n[ \t]*/g, " ");
    for (const s of flat.split(/(?<=[.!?;])\s+|\s+(?=[-*]\s)/)) {
      if (!/\bby hand\b|\bhand-written\b|\bhand-made\b/i.test(s)) continue;
      if (!/\.github\b|\bworkflows?\b|scenario job/i.test(s)) continue;
      if (!/\b(needs?|needed|will|once|has to|have to|must|waits? for)\b/i.test(s)) continue; // a step still ahead
      return s.replace(/^[-*]\s+/, "").trim().slice(0, 300);
    }
  }
  return null;
}

// A refusal of freeze.mjs in everyday words, whether it can pass by itself (waits), and what kind it is:
// "version" (the release step raises it with a pull request of its own), "tagged" (frozen already: the
// next look carries on from the tag), or null.
export function freezeRefusalWords(sentence, version) {
  const s = String(sentence || "").trim();
  const v = s.match(/says version (\S+?),? not (\S+?)\.?(?:\s|$)/);
  if (v) {
    return { waits: false, kind: "version", words: `the product still says it is version ${v[1]} instead of ${v[2]}, so its version number has to be raised first` };
  }
  if (/GitHub holds no Windows setup built for commit/.test(s)) return { waits: true, words: "GitHub has not finished building the Windows setup for the newest change" };
  if (/open approved-plan tickets/.test(s)) return { waits: false, words: "some tickets of the plan are not marked as finished" };
  if (/already has the tag/.test(s)) return { waits: true, kind: "tagged", words: `${version} was frozen already, so the next look carries on from its tag` };
  return { waits: true, words: s.replace(/\b[0-9a-f]{40}\b/g, (x) => x.slice(0, 7)).replace(/\s+/g, " ").slice(0, 300) };
}

// ---------- pure: the version change (a pull request of the release step) ----------

// The branch the version change is opened on. release/ marks it as the release step's for keep-main-green.
export const versionBranch = (version) => `release/version-${version}`;
export const versionTitle = (version) => `Release step of ${version}: the version`;
export const GUIDE_TRAILER = "Guide-Reviewed: none-needed (only the version number and the README list of what is new changed, and the update page has no step that depends on the version)";

// One item of the plan's "What it delivers" list in everyday words: its bold headline and the rest of
// that sentence, without the issue numbers, pull requests and sizes the plan carries for the builders.
function everydayItem(text) {
  const t = String(text)
    .replace(/\s*\([^()]*(?:#\d+|pull request|issue)[^()]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const bold = t.match(/^\*\*(.+?)\*\*/);
  if (!bold) return (t.match(/^[^.!?]*[.!?]/) || [t])[0].trim();
  if (/[.!?]$/.test(bold[1])) return bold[0];
  const rest = t.slice(bold[0].length).match(/^[^.!?]*[.!?]/);
  return `${bold[0]}${rest ? rest[0] : "."}`;
}

// The items of the plan that ship: [{item, line, headline}], in the plan's order. deferred: ticket file
// names moved to the next release (their number is the item). An item only about the tests (its headline
// names a test or a scenario) changes nothing a person sees and is left out, as beta.25's list did.
export function deliveredItems(plan, deferred = []) {
  const text = String(plan || "").replace(/\r\n/g, "\n");
  const head = text.match(/^##\s+What it delivers.*$/im);
  if (!head) return [];
  let body = text.slice(head.index + head[0].length);
  const end = body.search(/^##\s/m);
  if (end >= 0) body = body.slice(0, end);
  const moved = new Set(deferred.map((f) => ticketItem(f)).filter((n) => n !== null));
  const items = [];
  let cur = null;
  for (const line of body.split("\n")) {
    const m = line.match(/^(\d+)\.\s+(.*)$/);
    if (m) items.push((cur = { item: Number(m[1]), text: m[2] }));
    else if (cur && /^\s+\S/.test(line)) cur.text += ` ${line.trim()}`;
    else cur = null;
  }
  return items
    .filter((i) => !moved.has(i.item))
    .map((i) => {
      const line = everydayItem(i.text);
      return { item: i.item, line, headline: (line.match(/^\*\*(.+?)\*\*/) || [, line])[1] };
    })
    .filter((i) => i.line && !/\b(scenarios?|tests?)\b/i.test(i.headline));
}

// The README's "## New in <version>" section, written from the approved plan: its theme's first
// sentence, then each item that ships.
export function versionNotes({ plan, version, deferred = [] }) {
  const theme = (String(plan || "").replace(/\s+/g, " ").match(/\bThe theme:\s*([^.!?]+[.!?])/) || [])[1];
  const intro = theme || (planTitle(plan) ? `${planTitle(plan).replace(/^./, (c) => c.toUpperCase())}.` : null);
  const items = deliveredItems(plan, deferred);
  const lines = items.length ? items.map((i) => `- ${i.line}`) : ["- Repairs to Godspeed's own tests; nothing you use changes."];
  return [`## New in ${version}`, "", ...(intro ? [intro, ""] : []), ...lines, ""].join("\n");
}

// notebook/package.json with the version set, or null when it has no version line.
export function withVersion(pkgText, version) {
  const next = String(pkgText).replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  return next === String(pkgText) && !String(pkgText).includes(`"${version}"`) ? null : next;
}

// The README with the section above the newest "## New in" section (at the end when there is none).
// Unchanged when it has a section for this version already.
export function withReadmeSection(readme, version, section) {
  const text = String(readme || "");
  if (R.readmeSection(text, version)) return text;
  const at = text.search(/^## New in /m);
  if (at < 0) return `${text.replace(/\s*$/, "")}\n\n${section}`;
  return `${text.slice(0, at)}${section}\n${text.slice(at)}`;
}

// ---------- pure: why a scenario failed, in everyday words ----------

const stripLogLine = (l) => String(l).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "").replace(/\r$/, "");

// The cause of one failed job from its log: {line, plain, environment}. environment is true when the
// cause belongs to the test machines or the services they call, not to Godspeed.
export function classifyFailure(logText, jobName = "") {
  const lines = String(logText || "").split("\n").map(stripLogLine);
  const fail = lines.find((l) => /^FAIL\s+\S+?:/.test(l)) || null;
  const err = [...lines].reverse().find((l) => /^##\[error\]/.test(l)) || null;
  const line = (fail || err || "").trim();
  const reason = fail ? fail.replace(/^FAIL\s+\S+?:\s*/, "") : line.replace(/^##\[error\]\s*/, "");
  const modelFailed = lines.some((l) => /model-request-failed/.test(l));
  if (/rate.?limit|limiting requests|limited requests|GitHub answered (403|429)/i.test(line) || /x-ratelimit-remaining: 0/i.test(line)) {
    return { line, plain: "GitHub limited how many requests the shared test machines could make", environment: true };
  }
  if (/chat says\s*$|empty (chat )?(answer|reply|response)|answer (was|came back) empty|no answer from/i.test(reason) || (modelFailed && /chat/i.test(`${reason} ${jobName}`))) {
    return { line, plain: "the chat answer came back empty", environment: true };
  }
  if (modelFailed) return { line, plain: "the AI the tests use did not answer", environment: true };
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|\b50[234]\b|runner (lost|received a shutdown)|lost communication/i.test(line)) {
    return { line, plain: "a request timed out or the test machine was lost", environment: true };
  }
  // Causes that belong to the test machine, named in the log: a verifier that could not observe, a secret or token the run was not given.
  if (lines.some((l) => /\bINCOMPLETE\b/.test(l))) return { line, plain: "the checking tool could not finish observing (verifier INCOMPLETE)", environment: true };
  if (lines.some((l) => /(secret|token|api[ _-]?key)\b.{0,40}\b(is |was |are )?(missing|not set|not provided|empty|unset)|missing (required )?(secret|token|api[ _-]?key)|Bad credentials|Input required and not supplied/i.test(l))) {
    return { line, plain: "a secret or token the test machines need was missing", environment: true };
  }
  if (/ECONNREFUSED|socket hang up|ESOCKETTIMEDOUT|runner has received a shutdown signal|No space left on device|The operation was canceled|network is unreachable/i.test(line)) {
    return { line, plain: "the test machine or its network failed", environment: true };
  }
  const cleaned = reason.replace(/https?:\/\/\S+/g, "").replace(/\b[0-9a-f]{12,}\b/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return { line, plain: "the test stopped and its log gives no reason", environment: false };
  return { line, plain: cleaned.length > 220 ? `${cleaned.slice(0, 217)}...` : cleaned, environment: false };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// ["2026-11-11T..", "2026-11-12T.."] -> "11 and 12 November"
export function formatDates(isoList) {
  const days = [...new Set(isoList.map((s) => String(s).slice(0, 10)))].sort();
  const byMonth = new Map();
  for (const d of days) {
    const [, m, day] = d.split("-").map(Number);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(day);
  }
  const join = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  return join([...byMonth.entries()].map(([m, ds]) => `${join(ds.map(String))} ${MONTHS[m - 1]}`));
}

// The one message when some scenarios failed. failures: [{job, cause: {plain, environment}, mainDates: [iso], blocking}]
export function failureMessage({ version, title = null, failures, installHealthy = true, aggregate = [] }) {
  const n = failures.length;
  // The summary job fails with the others; record-go.mjs needs it named only when it failed alone.
  const withThem = aggregate.length ? `, and with ${n === 1 ? "it" : "them"} ${aggregate.join(" and ")}` : "";
  if (!n) {
    return `${version}${title ? ` (${title})` : ""} ${installHealthy ? "is on your server and healthy, but " : ""}the test run failed and its log names no single test${aggregate.length ? ` (only ${aggregate.join(" and ")} failed)` : ""}, so I cannot say why. I will not ask you to make it public on that; I look into it first.`;
  }
  const parts = [];
  parts.push(
    installHealthy
      ? `${version}${title ? ` (${title})` : ""} is on your server and healthy, but ${n === 1 ? "one test" : `${n} tests`} did not pass${withThem}.`
      : `${version} did not pass ${n === 1 ? "one test" : `${n} tests`}${withThem}.`,
  );
  for (const f of failures) {
    let judge;
    if (f.mainDates && f.mainDates.length) judge = `The same test also failed on main on ${formatDates(f.mainDates)}, so it is not new with this release.`;
    else if (f.cause.environment) judge = "That looks like a problem with the test machines, not with this release.";
    else judge = "I cannot tell yet whether this release caused it.";
    const why = f.cause.plain.replace(/[.\s]+$/, "");
    parts.push(`"${f.job}": ${why}. ${judge}${f.blocking ? " It tests something this release adds, so it holds the release back unless you accept it." : ""}`);
  }
  const anyBlocking = failures.some((f) => f.blocking);
  parts.push(
    anyBlocking
      ? `Every other test passed. I would look into the one that holds it back before making this public. Tell me if you want that.`
      : `Every other test passed. Shall I make it public anyway? Say "go" and I note these causes with your go, or say "stop" and I look into them first.`,
  );
  const text = parts.join(" ");
  return text.replace(/—|–/g, ",");
}

// ---------- state ----------

export function loadState(file) {
  if (!fs.existsSync(file)) return { version: 1, releases: {} };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`The state file ${file} cannot be read (${e.message}); nothing was done, because guessing could run the scenarios twice.`);
  }
  if (!data || typeof data !== "object" || typeof data.releases !== "object") throw new Error(`The state file ${file} has an unknown shape; nothing was done.`);
  return data;
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export const releaseState = (state, id) => (state.releases[id] ||= {});

// A look that cannot do its job (an expired gh login, GitHub refusing every read) would fail every
// 15 minutes without a word, and noticing is this script's whole purpose: after six hours of the same
// trouble he is told once. A look that works clears it.
export function trackFailure(state, nowMs, message, afterMs = 6 * 3600 * 1000) {
  state.failing ||= { since: new Date(nowMs).toISOString() };
  state.failing.last = String(message).slice(0, 200);
  if (!state.failing.told && nowMs - Date.parse(state.failing.since) >= afterMs) {
    state.failing.told = new Date(nowMs).toISOString();
    return { notify: true };
  }
  return { notify: false };
}
export const clearFailure = (state) => {
  delete state.failing;
};

// ---------- the factory's STOP file ----------

const STOP_MARK = "auto-stage";

// Creates the STOP file unless one is there already. Returns true when this call made it.
export function createStop(file, now, pid = process.pid) {
  if (fs.existsSync(file)) return false;
  if (!fs.existsSync(path.dirname(file))) return false; // no factory here: nothing to pause, and no folder made as root in someone's checkout
  try {
    fs.writeFileSync(file, `${STOP_MARK} ${pid} ${new Date(now).toISOString()}\nThe release step pauses the factory while the scenarios run (the driver's stage step).\n`, { flag: "wx" });
  } catch (e) {
    if (e.code === "EEXIST") return false; // somebody made it a moment ago
    throw e;
  }
  return true;
}

export const stopIsMine = (file) => {
  try {
    return fs.readFileSync(file, "utf8").startsWith(STOP_MARK);
  } catch {
    return false;
  }
};

// Removes a STOP file this script made; never one somebody else made. Returns whether it removed.
export function removeStop(file) {
  if (!fs.existsSync(file) || !stopIsMine(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

// At the start of a look: a STOP this script made that is older than the limit is removed.
export function guardStaleStop(file, now, maxAgeMinutes) {
  if (!fs.existsSync(file) || !stopIsMine(file)) return { removed: false };
  const age = now - fs.statSync(file).mtimeMs;
  if (age <= maxAgeMinutes * MINUTE) return { removed: false, ageMinutes: Math.round(age / MINUTE) };
  fs.rmSync(file, { force: true });
  return { removed: true, ageMinutes: Math.round(age / MINUTE) };
}

// ---------- the notice queue (notebook core/notices.mjs format) ----------

export function queueNotice(file, { id, text, about, facts, at = new Date().toISOString() }) {
  let notices = [];
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, "utf8")); // unreadable: throw, writing back would erase the queue
    if (!Array.isArray(data && data.notices)) throw new Error("the queued notices cannot be read");
    notices = data.notices;
  } else if (!fs.existsSync(path.dirname(file))) throw new Error(`${path.dirname(file)} does not exist, so there is no Godspeed here to tell him`);
  if (notices.some((n) => n && n.id === id)) return false;
  notices.push({ id, text, at, about, facts: facts || [text], written: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ notices }, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return true;
}

// ---------- the real world: GitHub through gh's login, children, notices ----------

function ghToken(cfg) {
  const [cmd, ...args] = cfg.ghTokenCommand.split(/\s+/);
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  const token = (r.stdout || "").trim();
  if (r.status !== 0 || !token) R.refuse(`No GitHub login to read with (${cfg.ghTokenCommand} gave nothing), so nothing was done.`);
  return token;
}

function runChild(cmdArgs, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, cmdArgs, { cwd: RELEASE.recordsRoot || undefined, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const issueFragment = "number state stateReason comments(last: 30) { nodes { body author { __typename login } } } closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number mergedAt baseRefName repository { nameWithOwner } mergeCommit { oid } } }";

// What the issues of a release say: {issues: {n: {state, stateReason, merges}}, extraOpen: [n]}.
export async function readIssues({ api, repo, label, numbers }) {
  const [owner, name] = repo.split("/");
  const aliases = [...new Set(numbers)].map((n) => `i${n}: issue(number: ${n}) { ${issueFragment} }`).join("\n");
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    labelled: issues(labels: [${JSON.stringify(label)}], first: 100, states: [OPEN, CLOSED]) { nodes { ${issueFragment} } }
    ${aliases} } }`;
  const r = await api("POST", "/graphql", { query });
  if (!r.ok || !r.json || !r.json.data || !r.json.data.repository) {
    const said = r.json && r.json.errors ? r.json.errors.map((e) => e.message).join("; ") : `status ${r.status}`;
    R.refuse(`GitHub could not tell the state of the release's issues (${said}).`);
  }
  const repoData = r.json.data.repository;
  const shape = (n) => ({
    state: n.state,
    stateReason: n.stateReason,
    merges: ((n.closedByPullRequestsReferences && n.closedByPullRequestsReferences.nodes) || []).map((p) => ({ number: p.number, mergedAt: p.mergedAt, commit: p.mergeCommit && p.mergeCommit.oid, repo: p.repository && p.repository.nameWithOwner, base: p.baseRefName })),
  });
  const issues = {};
  const comments = {};
  const take = (n) => { issues[n.number] = shape(n); comments[n.number] = (n.comments && n.comments.nodes) || []; };
  for (const n of repoData.labelled.nodes) take(n);
  for (const n of numbers) if (repoData[`i${n}`]) take(repoData[`i${n}`]);
  await addDeliveredByComment({ api, repo, issues, comments });
  const extraOpen = repoData.labelled.nodes.filter((n) => n.state === "OPEN" && !numbers.includes(n.number)).map((n) => n.number);
  return { issues, extraOpen };
}

// The factory sometimes closes an issue with a comment ("Delivered by <pull request URL>") instead of
// a GitHub closing reference. Such a close counts as done only when all three hold: the comment is by
// the builder or release App, the pull request it names is merged into main of this repository, and
// that pull request's body or branch names the issue. Its merge commit is then the ticket's merge.
// The Apps also close an issue whose work was on main before the release was filed with "Already delivered
// on main by #N" (Godspeed beta.31's ticket 01, 2026-11-23): #N is a pull request merged into main of this
// repository, or an issue closed by one, and the App's comment on the closed issue is itself the link (no
// "names the issue" check). The newest such merge is the ticket's merge (../../delivery.mjs reads both kinds).
export const deliveryAuthors = () => RELEASE.deliveryAuthors;
export async function addDeliveredByComment({ api, repo, issues, comments }) {
  const [owner, name] = repo.split("/");
  const wanted = {}; // pull request number -> [issue numbers that name it in a delivery comment]
  const already = {}; // number an "Already delivered on main by #N" comment names -> [issue numbers]
  for (const [n, issue] of Object.entries(issues)) {
    if (issue.state !== "CLOSED" || (issue.stateReason && issue.stateReason !== "COMPLETED") || (issue.merges || []).some((m) => m.mergedAt && m.commit && (!m.repo || m.repo.toLowerCase() === repo.toLowerCase()) && (!m.base || m.base === "main"))) continue;
    // Only the Apps: a person can register the same name, but GitHub types his comment User, not Bot.
    for (const claim of deliveryClaims(comments[n], { repo, apps: deliveryAuthors() })) ((claim.kind === "url" ? wanted : already)[claim.number] ||= []).push(Number(n));
  }
  await addAlreadyDelivered({ api, repo, issues, already });
  const numbers = Object.keys(wanted);
  if (!numbers.length) return;
  const aliases = numbers.map((k) => `p${k}: pullRequest(number: ${Number(k)}) { number merged mergedAt baseRefName headRefName body mergeCommit { oid } }`).join("\n");
  const r = await api("POST", "/graphql", { query: `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${aliases} } }` });
  const data = r.ok && r.json && r.json.data && r.json.data.repository;
  if (!data) return; // unreadable: the ticket stays "closed but no merged change", a person's to judge
  for (const k of numbers) {
    const pr = data[`p${k}`];
    if (!pr || !pr.mergedAt || !pr.mergeCommit || pr.baseRefName !== "main") continue;
    for (const n of wanted[k]) {
      if (!namesIssue(pr, n, repo)) continue;
      issues[n].merges = [...(issues[n].merges || []), { number: pr.number, mergedAt: pr.mergedAt, commit: pr.mergeCommit.oid, repo, base: pr.baseRefName, viaComment: true }];
    }
  }
}
// The "Already delivered on main by #N" claims: what each #N is (a pull request, or an issue and what closed it), in one read.
async function addAlreadyDelivered({ api, repo, issues, already }) {
  const numbers = Object.keys(already);
  if (!numbers.length) return;
  const r = await api("POST", "/graphql", { query: alreadyQuery(repo, numbers) });
  const data = r.ok && r.json && r.json.data && r.json.data.repository;
  if (!data) return; // unreadable: the ticket stays "closed but no merged change", and the next look reads it again
  for (const k of numbers) {
    const merges = alreadyMerges(data[`a${Number(k)}`], repo);
    for (const n of already[k]) {
      const have = new Set((issues[n].merges || []).map((m) => m.commit));
      issues[n].merges = [...(issues[n].merges || []), ...merges.filter((m) => !have.has(m.commit))];
    }
  }
}

// ---------- one look ----------

// ctx: {cfg, env, log, now(), dry, records, api, state, stateFile, run(args)->{code,stdout,stderr},
//       notify({id, text, about}), sleep(ms), scenarios(version), read..., }
export async function autoStage(ctx) {
  ctx.lookHalt = null;
  const result = await lookStage(ctx);
  const halt = ctx.lookHalt || persistedHalt(ctx);
  return halt ? { ...result, halt } : result;
}

// The first halt that is still standing in the state (a halt stays until it is cleared).
function persistedHalt(ctx) {
  for (const rs of Object.values((ctx.state && ctx.state.releases) || {})) {
    if (rs && rs.halted) {
      const key = rs.halted.key || "halted";
      return makeHalt(ctx, "stage", key, rs.halted.words || plainHaltWords(rs.halted.why));
    }
  }
  return null;
}

async function lookStage(ctx) {
  const { cfg, log, records } = ctx;
  const now = () => ctx.now();
  const dry = !!ctx.dry;
  const save = () => {
    if (!dry) saveState(ctx.stateFile, ctx.state);
  };

  const stale = dry
    ? { removed: false }
    : guardStaleStop(cfg.stopFile, now(), cfg.stopMaxAgeMinutes);
  if (stale.removed) log(`A STOP file of this script was ${stale.ageMinutes} minutes old, so it was removed (the factory runs again).`);

  const pub = await ctx.publicVersion();
  const names = records.releases();
  const stagingOf = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
  const releases = names.map((id) => { const s = records.read(G.stagingPath(id)); return { id, plan: records.read(`releases/${id}/plan.md`) || "", hasStaging: !!s, staging: stagingOf(s) }; });
  const unfinished = Object.entries(ctx.state.releases).filter(([, v]) => v && v.started && !v.finished && !v.halted).map(([k]) => k);
  const installed = installedVersion(releases);
  const { pick, why, superseded } = pickRelease({ releases, inProgress: ctx.only ? [ctx.only] : unfinished, publicVersion: pub, installedVersion: installed, repo: cfg.repo });
  if (!ctx.only) for (const r of superseded) log(`Superseded: ${r.version} is approved but older than ${installed}, which is installed on your server; it is skipped.`);
  const chosen = ctx.only ? (releases.find((r) => r.id === ctx.only) ? { ...releases.find((r) => r.id === ctx.only), version: releaseVersion(ctx.only) } : null) : pick;
  if (!chosen) {
    log(`Nothing to stage: ${why}.`);
    return { outcome: "nothing" };
  }
  const { id, plan } = chosen;
  const baseVersion = chosen.version; // the release (its tickets, issues and label)
  const rs = releaseState(ctx.state, id);
  // A re-freeze is a new candidate of the same release: 2.0.0-beta.26.1, then .2 (auto-drive.mjs).
  const version = rs.candidate || baseVersion;
  log(`Release ${id} (${version}): ${why}.`);

  if (rs.finished) {
    log(`Already staged and announced at ${rs.finished}; nothing to do.`);
    return { outcome: "finished" };
  }
  if (rs.halted) {
    log(`Halted at ${rs.halted.at}: ${rs.halted.why}. Nothing more is done automatically until the halt is cleared.`);
    return { outcome: "halted" };
  }
  if (planTakenOver(plan) && !rs.started && !rs.freezeStartedAt) {
    log("The plan has its own 'Release step' section: a person took the release step over, so this leaves it alone.");
    return { outcome: "person" };
  }

  // ---- things said once
  const sayOnce = (key, text, about) => {
    rs.told ||= {};
    if (rs.told[key]) return false;
    const plain = text.replace(/—|–/g, ",");
    if (dry) {
      log(`Would tell him once (${key}): ${plain}`);
      return false;
    }
    try {
      ctx.notify({ id: `auto-stage-${version}-${key}`, text: plain, about });
    } catch (e) {
      // not marked as said, so the next look tries again
      throw new R.Refused(`The message to him could not be queued (${e.message}); the next look tries again.`);
    }
    rs.told[key] = new Date(now()).toISOString();
    save();
    log(`Told him (${key}): ${plain}`);
    return true;
  };
  // A halt is kept in the state until it is cleared and handed to the driver, which owns it. Nobody is told
  // from here: the words go into the driver's inventory and climb its ladder.
  const haltWith = (key, words, why) => {
    if (!dry) {
      rs.halted = { at: new Date(now()).toISOString(), why, key, words };
      delete rs.halting;
      save();
    }
    log(`Halted (${key}): ${words}`);
  };
  const short = (words) => crypto.createHash("sha1").update(words).digest("hex").slice(0, 8);
  const clearBlock = (key) => {
    if (rs.blocked && rs.blocked[key] && !dry) {
      delete rs.blocked[key];
      save();
    }
  };
  // A reason to wait. It is said once per reason: at once when it will not pass by itself, otherwise
  // only when it has lasted (a build still running, main's check still going). Nothing halts here:
  // every look tries again, so the release goes on by itself the moment the reason is gone. Only a
  // change under .github/ is a person's by hand (hand: true); the Apps may not touch it.
  const blocked = (key, words, { immediate = false, hand = false } = {}) => {
    rs.blocked ||= {};
    const since = rs.blocked[key] || new Date(now()).toISOString();
    if (!dry) rs.blocked[key] = since;
    const lasted = now() - Date.parse(since);
    log(`Waiting: ${words}${lasted > 0 ? ` (for ${Math.round(lasted / MINUTE)} minutes)` : ""}.`);
    // Not told to anybody: a reason that will not pass by itself (at once) or has lasted (after the grace) is a
    // halt for the driver. The reasons that pass by themselves stay a state of this step, never a halt.
    if (immediate && hand) {
      ctx.lookHalt = makeHalt(ctx, "stage", `blocked-${key}`, `Godspeed ${version} is finished and waiting for the release step, but it cannot be started automatically: ${words}.`);
    } else if (immediate) {
      ctx.lookHalt = makeHalt(ctx, "stage", `blocked-${key}`, `Godspeed ${version} is finished, but its release step cannot go on yet: ${words}.`);
    } else if (lasted >= cfg.blockedGraceMinutes * MINUTE) {
      ctx.lookHalt = makeHalt(ctx, "stage", `blocked-${key}`, `Godspeed ${version} is finished, but its release step has been waiting for over an hour: ${words}.`);
    }
    save();
  };

  if (rs.halting && !rs.halted) {
    // an intent to halt that an earlier version of this step saved before it could say it
    haltWith(rs.halting.key, rs.halting.words || plainHaltWords(rs.halting.text), rs.halting.why);
    return { outcome: "halted" };
  }

  // A candidate is being taken out and rebuilt (auto-drive.mjs): carry that on before anything else.
  if (rs.drive && !["done", "stopped"].includes(rs.drive.phase)) {
    if (dry) {
      log(`The release is being rebuilt without change #${rs.drive.culprit.number} (step ${rs.drive.phase}); the next look would carry on.`);
      return { outcome: "would-continue" };
    }
    return driveOn({ ctx, id, base: baseVersion, plan, rs, save, sayOnce, version });
  }

  const tag = await ctx.tagCommit(version);
  const hand = planNeedsHand(plan);

  if (tag && rs.freezeStartedAt && !rs.frozen && !rs.halted) {
    // This script began the freeze and did not see it end: the candidate may have no published release.
    haltWith("freeze-unfinished", `Godspeed ${version} was complete and its freeze was started, but it was not seen to end, and the candidate may be half made. Nothing is public.`, "the freeze was started here and did not finish cleanly");
    return { outcome: "halted", why: "freeze unfinished" };
  }

  if (!tag) {
    // ---- 1. the tickets, from the issues
    const files = records.ticketFiles(id);
    const tickets = files.map((file) => ({ file, body: records.read(file) || "" }));
    if (!tickets.length) {
      log("The release has no ticket files, so there is nothing to read the completeness from.");
      return { outcome: "waiting" };
    }
    const items = itemIssues(plan);
    const label = baseVersion.includes("-") ? baseVersion.slice(baseVersion.indexOf("-") + 1) : baseVersion;
    const read = await readIssues({ api: ctx.api, repo: cfg.repo, label, numbers: Object.values(items) });
    // A person's entries are taken as written (freeze checks them itself); the release driver's must
    // stand on the plan (scope-amendment.mjs), or they move nothing and the ticket is waited for.
    const { deferred, problems: amendProblems, byDriver } = readDeferrals(records.json(`releases/${id}/scope-amendment.json`), { id, version: baseVersion, plan, ticketNames: files }, { strictPerson: false });
    for (const p of amendProblems) log(`Not taken as a reason to leave a ticket out: ${p}.`);
    const verdict = judgeCompleteness({ tickets, plan, issues: read.issues, extraOpen: read.extraOpen, deferred, repo: cfg.repo });
    if (verdict.state === "waiting") {
      log(`Not complete yet: waiting on ${verdict.waitingOn.join(", ")}.`);
      return { outcome: "waiting", waitingOn: verdict.waitingOn };
    }
    if (verdict.state === "judgment" && verdict.deadEnds.length && verdict.deadEnds.length === verdict.reasons.length && D.planRuleWords(plan)) {
      // A ticket whose issue was closed with nothing of it on main reached a dead end. Under the plan's
      // own rule it leaves the release and the rest ships, but only the factory driver moves tickets
      // (2026-11-18): wait for its amendment, quietly (it acts within minutes and tells him itself).
      log(`Waiting for the factory driver to move ${deferredWords(plan, verdict.deadEnds.map((e) => path.basename(e.file))).join(" and ")} to the next release under the plan's rule.`);
      return { outcome: "waiting", why: "dead ends" };
    }
    if (verdict.state === "judgment") {
      blocked("tickets", `${verdict.reasons.join("; ")}${D.planRuleWords(plan) ? "" : ", and the plan has no rule that lets such an item leave the release"}`, { immediate: true });
      return { outcome: "needs-judgment", why: "tickets" };
    }
    if (byDriver && !leavesSomething(deferred, files)) {
      blocked("tickets", "every ticket of the release was moved out, which would leave nothing to release", { immediate: true });
      return { outcome: "needs-judgment", why: "tickets" };
    }
    clearBlock("tickets");
    if (hand) {
      blocked("by-hand", `the plan says one step is done by hand ("${hand.replace(/"/g, "'")}")`, { immediate: true, hand: true });
      return { outcome: "needs-judgment", why: "by hand" };
    }
    log(`Every ticket of ${version} is closed and merged${verdict.marks.length ? `; ${verdict.marks.length} ticket file(s) still lack their "Status: done (merge ...)" line` : ""}.`);

    // ---- the commit to freeze: main's head, once its required check passed
    const head = await ctx.mainHead();
    if (head.none) {
      blocked("main-check", head.none);
      return { outcome: "waiting", why: "main's check" };
    }
    clearBlock("main-check");
    log(`Main is at ${head.commit.slice(0, 7)} and its required check passed.`);

    const base = [helper("freeze.mjs"), cfg.repo, version, "--commit", head.commit, "--no-staging"];
    if (dry && verdict.marks.length) {
      log(`Would write "Status: done (merge ...)" into ${verdict.marks.length} ticket file(s): ${verdict.marks.map((m) => `${path.basename(m.file)} -> ${m.merge.slice(0, 7)} (issue #${m.issue})`).join(", ")}.`);
      log(`Would run: node ${base.join(" ")} --dry-run, and then the same without --dry-run, then start the scenarios on candidate/${version}.`);
      return { outcome: "would-freeze", commit: head.commit };
    }
    // The ticket lines go in first: the freeze reads them from godspeed-dev's main (its scope check),
    // so its own dry run below can only say yes once they are there. They are true whatever follows:
    // each says which merge closed which issue.
    if (verdict.marks.length) {
      const files2 = {};
      for (const m of verdict.marks) files2[m.file] = markTicket(records.read(m.file) || "", m.merge);
      const commit = records.write(files2, `${version}: tickets done with their merge commits (written by auto-stage from the closed issues)`);
      log(`Wrote the ticket status lines into the records repository${commit ? ` (${commit.slice(0, 7)})` : " (already there)"}.`);
    }

    // ---- a dry run of the freeze (it writes nothing, so a dry look runs it too): a refusal is a wait,
    // the version change, or a cause said once while every look tries again
    const check = await ctx.run([...base, "--dry-run"]);
    if (check.code !== 0) {
      const sentence = check.stderr.trim().split("\n").filter(Boolean).pop() || `freeze exited ${check.code}`;
      const w = freezeRefusalWords(sentence, version);
      if (w.kind === "tagged") {
        // frozen meanwhile (by a person or a look that crashed): the next look carries on from the tag
        log(`candidate/${version} exists already; the next look carries on from it.`);
        return { outcome: "waiting", why: "tag exists" };
      }
      if (w.kind === "version" && !rs.candidate && ctx.versionPull) {
        clearBlock("freeze");
        return versionStep({ ctx, version, plan, deferred, rs, save, sayOnce, blocked, clearBlock });
      }
      blocked("freeze", w.words, { immediate: !w.waits });
      return { outcome: "needs-judgment", why: sentence };
    }
    if (dry) {
      log(`The freeze's own dry run says yes. Would run: node ${base.join(" ")}, then start the scenarios on candidate/${version}.`);
      return { outcome: "would-freeze", commit: head.commit };
    }
    clearBlock("freeze");
    for (const k of ["version", "version-check", "version-merged"]) clearBlock(k);
    rs.started = new Date(now()).toISOString();
    rs.freezeStartedAt = rs.started;
    save();
    log(`Freezing ${version} from ${head.commit.slice(0, 7)}.`);
    const frozen = await ctx.run(base);
    if (frozen.code !== 0) {
      const sentence = frozen.stderr.trim().split("\n").filter(Boolean).pop() || `freeze exited ${frozen.code}`;
      haltWith("freeze-failed", `Godspeed ${version} was complete and its release step started, but the freeze stopped: ${freezeRefusalWords(sentence, version).words}. Nothing is public.`, `the freeze failed: ${sentence}`);
      return { outcome: "halted", why: sentence };
    }
    rs.frozen = new Date(now()).toISOString();
    save();
  } else if (!rs.started) {
    // Frozen by a person (or an earlier version of the release step): continue from the tag, but not at
    // once: its maker may be about to start the scenarios or the install as well.
    const tagTime = await ctx.tagTime(tag);
    if (tagTime && now() - tagTime < 2 * cfg.dispatchGraceMinutes * MINUTE) {
      log(`candidate/${version} is only ${Math.round((now() - tagTime) / MINUTE)} minutes old and was not frozen here; waiting before taking over, in case its maker carries on.`);
      return { outcome: "waiting", why: "tag is new" };
    }
    if (!dry) {
      rs.started = new Date(now()).toISOString();
      save();
    }
    log(`candidate/${version} exists already; continuing with its scenarios and the server.`);
  }

  if (dry) {
    log(`candidate/${version} exists; the next look would continue with its scenarios and the server.`);
    return { outcome: "would-continue" };
  }
  return stageFrozen({ ctx, id, version, base: baseVersion, plan, rs, save, sayOnce, haltWith, tag });
}

// ---------- the version: a pull request of the release step ----------

// The product's version is raised by one pull request (notebook/package.json and the README's "New in"
// section), opened with the builder App on release/version-<version> and, once `required` passed,
// approved and merged with the release App (roles/release.md step 1: GitHub refuses an approval from
// the pull request's own author). It never touches .github/, so no person is needed. A crash is resumed
// by looking at GitHub for that branch's pull request, never by opening a second one.
// -> {outcome}; the next look (main at the new commit, its Windows setup built) freezes as always.
async function versionStep({ ctx, version, plan, deferred, rs, save, sayOnce, blocked, clearBlock }) {
  const { log } = ctx;
  const vp = ctx.versionPull;
  const dry = !!ctx.dry;
  const branch = versionBranch(version);
  const title = versionTitle(version);
  const pr = await vp.find(branch);
  const keep = (over) => {
    if (dry) return;
    rs.bump = { ...(rs.bump || {}), branch, ...over };
    save();
  };
  if (!pr) {
    const section = versionNotes({ plan, version, deferred });
    const items = deliveredItems(plan, deferred);
    if (dry) {
      log(`Would open the pull request "${title}" on ${branch} (builder App): notebook/package.json says ${version}, and the README gets this section:\n${section}`);
      return { outcome: "would-raise-version" };
    }
    keep({ openingAt: new Date(ctx.now()).toISOString() }); // the intent first: a crash after the open is found by its branch
    const moved = deferred.length ? ` ${deferredWords(plan, deferred).join(", ")} moved to the next release and ${deferred.length === 1 ? "is" : "are"} not listed.` : "";
    const body = `Sets the notebook's version to ${version} so the candidate can be frozen, and adds the README's "New in ${version}" section from the approved plan's "What it delivers" (${items.length ? `items ${items.map((i) => i.item).join(", ")}` : "no item a person notices"}).${moved}\n\nOpened by auto-stage (the release step) with the builder App; approved and merged with the release App once \`required\` passes. Only notebook/package.json and README.md change.\n\n${GUIDE_TRAILER}\n`;
    const r = await vp.open({ branch, version, title, body, section, message: `${title}\n\n${GUIDE_TRAILER}\n` });
    if (r.cannot) {
      blocked("version", `the pull request that raises the version could not be opened (${r.cannot})`, { immediate: true });
      return { outcome: "needs-judgment", why: r.cannot };
    }
    keep({ pr: r.pr, head: r.head, openedAt: new Date(ctx.now()).toISOString() });
    log(`Opened #${r.pr}, "${title}"; it is merged once its required check passes.`);
    return { outcome: "waiting", why: "version pull request opened" };
  }
  keep({ pr: pr.number });
  if (pr.merged) {
    blocked("version-merged", `the version change #${pr.number} is merged, and main's newest change does not carry it into a Windows setup yet`);
    return { outcome: "waiting", why: "version merged" };
  }
  if (pr.state === "closed") {
    blocked("version", `the pull request that raises the version (#${pr.number}) was closed without being merged`, { immediate: true });
    return { outcome: "needs-judgment", why: "version pull request closed" };
  }
  const req = await vp.required(pr.head);
  if (req.state === "failed") {
    const cause = await vp.failures(pr.head);
    if (dry) log(`#${pr.number}'s required check failed: ${cause}.`);
    else sayOnce(`version-failed-${String(pr.head).slice(0, 7)}`, `Godspeed ${version} is finished, but the pull request that raises its version number did not pass its checks: ${cause}. I keep watching it and merge it by myself as soon as it passes.`, `Godspeed ${version}: the version change failed its checks`);
    return { outcome: "waiting", why: "version checks failed" };
  }
  if (req.state !== "passed") {
    blocked("version-check", `the pull request that raises the version (#${pr.number}) waits for its required check (${req.state})`);
    return { outcome: "waiting", why: "version checks" };
  }
  clearBlock("version-check");
  if (dry) {
    log(`Would approve and merge #${pr.number} with the release App (its required check passed).`);
    return { outcome: "would-merge-version" };
  }
  const m = await vp.merge({ pr: pr.number, head: pr.head, title: `${pr.title || title} (#${pr.number})`, message: `${GUIDE_TRAILER}\n` });
  if (!m.ok) {
    const tries = (rs.bump.mergeRefused || 0) + 1;
    keep({ mergeRefused: tries });
    log(`GitHub refused to merge #${pr.number} (${m.message}); the next look tries again.`);
    if (tries >= 3) blocked("version", `GitHub refused to merge the version change #${pr.number} ${tries} times (${m.message})`, { immediate: true });
    return { outcome: "waiting", why: "version merge refused" };
  }
  keep({ merged: m.sha, mergedAt: new Date(ctx.now()).toISOString() });
  log(`Merged #${pr.number} (${String(m.sha).slice(0, 7)}): the product now says ${version}. The next look freezes once main's check and its Windows setup are there.`);
  return { outcome: "waiting", why: "version merged" };
}

// ---------- the frozen candidate: scenarios, server, the one message ----------

async function stageFrozen({ ctx, id, version, base, plan, rs, save, sayOnce, haltWith, tag }) {
  const { cfg, log, records } = ctx;
  const now = () => ctx.now();
  const tagName = `candidate/${version}`;
  // One deadline for the whole look, both waits included: the look ends well inside the unit's timeout,
  // and the next look picks up whatever is still running.
  const deadline = now() + cfg.scenarioWaitMinutes * MINUTE;

  // The scenarios as GitHub shows them, except that a rerun GitHub does not show yet is still running
  // (reading the old "failed" would be the old answer).
  const readScenarios = async () => {
    const sc = await ctx.scenarios(version);
    if (sc.result === "failed" && rs.rerunAt && rs.rerunFromAttempt != null && sc.run) {
      const info = await ctx.runInfo(sc.run);
      if (now() - Date.parse(rs.rerunAt) < 15 * MINUTE && (!info || info.attempt <= rs.rerunFromAttempt || info.status !== "completed")) return { ...sc, result: "running" };
    }
    return sc;
  };
  const waitDone = async () => {
    let sc = await readScenarios();
    while (!["passed", "failed"].includes(sc.result) && now() < deadline) {
      await ctx.sleep(cfg.pollSeconds * 1000);
      sc = await readScenarios();
    }
    return sc;
  };

  let sc = await readScenarios();
  if (sc.result === "unreadable") {
    log(`The scenarios on ${tagName} cannot be read now (${sc.problem}); nothing is started and the next look tries again.`);
    return { outcome: "waiting", why: "scenarios unreadable" };
  }
  if (sc.result === "none" && !rs.dispatchedAt && sc.ignored && !rs.dispatchApproved) {
    // Somebody ran scenarios on this tag that do not count (a wrong stage in the title): a second paid run on top is theirs to decide.
    haltWith("scenarios-ignored", `Godspeed ${version} is frozen, but the tests that already ran on it do not count (${sc.ignored}). Another test run costs money from the test key, so none was started: only the owner gives that yes.`, "scenarios on the tag do not count; not started again (money)");
    return { outcome: "halted", why: "scenarios ignored" };
  }

  // The factory is paused only while something runs or may still be rerun: a look that merely tries the
  // install again does not hold it up.
  const needStop = sc.result === "none" || sc.result === "running" || (sc.result === "failed" && !rs.rerunAt);
  const madeStop = needStop && (createStop(cfg.stopFile, now()) || stopIsMine(cfg.stopFile)); // a STOP of ours left by a killed look is taken back
  ctx.onExit(() => {
    if (madeStop && removeStop(cfg.stopFile)) log("The factory's STOP file was removed.");
  });
  log(madeStop ? "The factory is paused while the scenarios run (STOP file made)." : needStop ? "A STOP file was there already, not made here; it is left as it is." : "Nothing is running, so the factory is not paused.");
  let decided = null;
  try {
    // ---- the scenarios: one candidate run, never a second dispatch
    if (sc.result === "none") {
      if (rs.dispatchedAt) {
        const age = now() - Date.parse(rs.dispatchedAt);
        if (age < cfg.dispatchGraceMinutes * MINUTE) {
          log(`The scenarios were started ${Math.round(age / MINUTE)} minutes ago and GitHub does not show the run yet; waiting.`);
          return { outcome: "waiting", why: "run not visible yet" };
        }
        haltWith("scenarios-lost", `Godspeed ${version} is frozen, but the tests that were started do not show on GitHub, and they were not started a second time: another test run costs money from the test key, and only the owner gives that yes.`, "the scenarios were started but GitHub shows no run on the tag; not started a second time (money)");
        return { outcome: "halted", why: "dispatch lost" };
      }
      rs.dispatchedAt = new Date(now()).toISOString(); // before the dispatch: a crash in between never starts a second run
      save();
      await ctx.dispatch(tagName);
      log(`The scenarios were started on ${tagName}${cfg.scenarioMac ? " (with the Mac job)" : ""}.`);
    } else {
      log(`Scenarios on ${tagName}: ${sc.result}${sc.url ? ` (${sc.url})` : ""}; not started again.`);
    }

    // ---- the server, beside the run (stage-server waits for the run itself, up to 30 minutes)
    records.fetch();
    const hasStaging = stagingIsFor(records, id, version);
    let serverProblem = null;
    const server = hasStaging
      ? Promise.resolve(null)
      : ctx
          .run([helper("stage-server.mjs"), cfg.repo, version, "--release", id])
          .then((r) => {
            if (r.code !== 0) serverProblem = r.stderr.trim().split("\n").filter(Boolean).pop() || `stage-server exited ${r.code}`;
            log(r.code === 0 ? `${version} is on the server.` : `stage-server stopped: ${serverProblem}`);
          })
          .catch((e) => {
            serverProblem = e.message;
          });

    sc = await waitDone();
    await server;
    if (sc.result === "failed" && !rs.rerunAt) {
      const info = await ctx.runInfo(sc.run);
      if (!info) {
        log(`GitHub does not say which attempt run ${sc.run} is on, so the failed jobs are not run again now; the next look decides.`);
        return { outcome: "waiting", why: "run attempt unknown" };
      }
      rs.rerunAt = new Date(now()).toISOString(); // once, and only the failed jobs
      rs.rerunFromAttempt = info.attempt;
      save();
      await ctx.rerunFailed(sc.run);
      log(`Scenario run ${sc.run} failed in ${(sc.failedJobs || []).length} job(s); those jobs only were run once more.`);
      await ctx.sleep(Math.min(cfg.pollSeconds, 30) * 1000);
      sc = await waitDone();
    }
    if (!["passed", "failed"].includes(sc.result)) {
      log(`The scenarios on ${tagName} have not finished (${sc.result}); the next look picks it up.`);
      return { outcome: "waiting", why: "scenarios running" };
    }
    rs.scenarioResult = sc.result;
    decided = sc;

    // ---- no record of the install: the install costs nothing, so a few looks may try it again
    records.fetch();
    if (!stagingIsFor(records, id, version)) {
      rs.serverTries = (rs.serverTries || 0) + 1;
      save();
      if (rs.serverTries < 3) {
        log(`${version} is not on the server yet (${serverProblem || "no record"}); the next look tries again (try ${rs.serverTries} of 3).`);
        return { outcome: "waiting", why: "server" };
      }
      haltWith("not-staged", `Godspeed ${version} is frozen and its tests ran, but it could not be put on the server after three tries (${serverProblem || "no record was written"}). Nothing is public.`, "the install did not work three times");
      return { outcome: "halted", why: "not staged" };
    }
  } finally {
    if (madeStop && removeStop(cfg.stopFile)) log("The factory's STOP file was removed.");
  }
  const staged = decided; // the answer the look itself saw; a read after the wait could be a GitHub hiccup

  // ---- the record and the message
  records.fetch();
  const check = await ctx.run([helper("staging-check.mjs"), cfg.repo, version, "--release", id, "--tell"]);
  log(`staging-check: exit ${check.code}${check.stderr.trim() ? ` (${check.stderr.trim().split("\n").pop()})` : ""}.`);
  records.fetch();
  const staging = records.json(G.stagingPath(id));
  if (staging && staging.status === "failed") {
    // staging-check --tell has sent the "not healthy" message by itself; nothing more is said here.
    rs.finished = new Date(now()).toISOString();
    save();
    log(`${version} is recorded as not healthy on the server; staging-check told him once.`);
    return { outcome: "not-healthy" };
  }
  if (staged.result === "passed") {
    rs.finished = new Date(now()).toISOString();
    save();
    log(check.code === 0 ? `Every scenario passed; staging-check --tell sent him the "shall I make it public?" message (once).` : `Every scenario passed; staging-check ended with exit ${check.code}, so whether the "shall I make it public?" message went out is in its output above; the morning check asks again if it did not.`);
    return { outcome: "ready" };
  }

  // some failed: staging-check never tells then
  const allFailed = staged.failedJobs || (await ctx.failedJobs(staged.run)) || [];
  const jobs = allFailed.filter((j) => !G.isAggregateJob(j));
  const aggregate = allFailed.filter((j) => G.isAggregateJob(j));
  const blockingList = G.blockingScenarios(plan);
  const main = await ctx.mainFailures();
  const failures = [];
  for (const job of jobs) {
    const logText = await ctx.jobLog(staged.run, job);
    const cause = classifyFailure(logText, job);
    failures.push({ job, cause, mainDates: main[job] || [], blocking: !!blockingList && blockingList.some((b) => job.toLowerCase().includes(b)) });
  }
  // ---- what the plan allows on its own (auto-drive.mjs)
  const judged = D.judgeFailures({ failures, nowMs: now(), listed: !!blockingList });
  const driving = !!D.planRuleWords(plan) && planApproved(plan) && !!ctx.drive;
  // Said the way the plan's rule reads: a waived failure does not hold the release back, and a failure on main
  // only counts as "not new" within the 3 nights the rule looks at. Without the rule the old message stands.
  const said = driving ? judged.map((f) => ({ ...f, blocking: f.blocking && !f.waive, mainDates: f.recentMain })) : failures;
  const text = failureMessage({ version, title: planTitle(plan), failures: said, installHealthy: G.installedHealthy(staging, version), aggregate });
  const key = rs.candidate ? `scenarios-failed-${version}` : "scenarios-failed";
  const about = `Godspeed ${version} is on your server, some tests failed`;
  const finishWith = (extra, outcome) => {
    sayOnce(key, extra ? `${text} ${extra}` : text, about);
    rs.finished = new Date(now()).toISOString();
    rs.failedJobs = judged.map((f) => ({ job: f.job, cause: f.cause.plain, environment: f.cause.environment, alsoOnMain: f.mainDates.length > 0, ...(f.waive ? { doesNotBlock: f.waive } : {}) }));
    save();
    return { outcome, failures: judged };
  };
  const holding = judged.filter((f) => f.holds);
  if (!holding.length) return finishWith("", "failed-tests"); // only failures that do not block: named with their cause, he decides
  if (!driving) return finishWith("", "failed-tests");
  const n = rs.drive ? rs.drive.n : 0;
  if (n >= D.MAX_REFREEZES) return finishWith(D.exhaustedWords(n), "drive-exhausted");
  if (ctx.dry) {
    log(`Would trace the failing test to one change of the release, take that change out of main and of ${R.releaseBranch(base)} (cut from this candidate's commit), move its ticket to the next release and freeze ${D.nextCandidate(base, n)} from that branch.`);
    return { outcome: "would-drive", failures };
  }
  const itemPulls = await ctx.drive.itemPulls({ plan, base });
  const tickets = records.ticketFiles(id).map((f) => path.basename(f));
  const ticketOfItem = {};
  for (const t of tickets) {
    const i = ticketItem(t);
    if (i !== null) ticketOfItem[i] = t;
  }
  const pullFiles = {};
  for (const pr of Object.values(itemPulls)) if (pr && pr.number && !pullFiles[pr.number]) pullFiles[pr.number] = await ctx.drive.pullFiles(pr.number);
  const logs = {};
  for (const f of holding) logs[f.job] = await ctx.jobLog(staged.run, f.job);
  // What an earlier round already took out is not in the release any more: a failure that still points at it is not
  // explained by it, and is no reason to try the same change again.
  const already = D.alreadyDeferred(records.json(`releases/${id}/scope-amendment.json`));
  for (const [item, t] of Object.entries(ticketOfItem)) if (already.includes(t)) delete itemPulls[item];
  const traced = D.traceCulprit({ holding, plan, itemPulls, pullFiles, logs, ticketOfItem });
  if (!traced.ok) return finishWith(D.stoppedWords(traced.why), "drive-untraced");
  if (!tickets.some((t) => !already.includes(t) && !traced.tickets.includes(t))) return finishWith(D.stoppedWords("taking that change out would leave nothing in the release"), "drive-untraced");
  const first = holding[0];
  rs.drive = {
    phase: "revert-start",
    n: n + 1,
    candidate: version,
    // the commit this candidate was frozen from: the rebuild is cut from it on the release branch (auto-drive.mjs)
    from: staging && staging.version === version && R.COMMIT_PATTERN.test(String(staging.productCommit)) ? staging.productCommit : null,
    culprit: { number: traced.pr.number, commit: traced.pr.commit, tickets: traced.tickets, how: traced.how, job: first.job, cause: first.cause.plain, why: `"${first.job}" failed on ${version}: ${first.cause.plain}` },
  };
  save();
  log(`${traced.how} points at change #${traced.pr.number}; taking it out and building a new version.`);
  return driveOn({ ctx, id, base, plan, rs, save, sayOnce, version });
}

// A staging record counts for this candidate only when it names its version (a re-freeze is the same release folder).
const stagingIsFor = (records, id, version) => {
  const st = records.json(G.stagingPath(id));
  return !!st && st.version === version;
};

// One look's worth of the take-out-and-rebuild. It ends in a message only when it gives up.
async function driveOn({ ctx, id, base, plan, rs, save, sayOnce, version }) {
  const { cfg, log, records } = ctx;
  const stop = (why) => {
    const c = rs.drive.culprit;
    // The halt is kept in the state first: it stands until the driver clears it.
    rs.halted = { at: new Date(ctx.now()).toISOString(), why: `the rebuild stopped: ${why}`, key: `drive-stopped-${rs.drive.n}`, words: `Godspeed ${version} is on the server, but the test "${c.job}" fails (${c.cause}), and it blocks the release. The failure was traced to one change and an attempt was made to take that change out and build a new version, but ${why}. Nothing is public.` };
    rs.drive.phase = "stopped";
    rs.finished = new Date(ctx.now()).toISOString();
    save();
    return { outcome: "drive-stopped", why, halt: makeHalt(ctx, "stage", rs.halted.key, rs.halted.words) };
  };
  const d = {
    ...ctx.drive,
    records,
    run: (args) => ctx.run(args),
    becameCandidate: (next) => {
      rs.candidate = next;
      for (const k of ["rerunAt", "rerunFromAttempt", "dispatchedAt", "scenarioResult", "serverTries", "finished", "failedJobs"]) delete rs[k];
      save();
    },
  };
  return D.driveStep({ d, id, base, plan, rs, save, log, now: () => ctx.now(), repo: cfg.repo, stop });
}

// ---------- the real context ----------

// There is no lock file here: the driver starts this step as a transient unit of its own (one unit name, so
// systemd never runs two at once), which is what the old lock file and its "am I already running" check did.

async function realContext({ cfg, env, dry, only, log, clearHaltCommand }) {
  const token = ghToken(cfg);
  const api = R.githubApi(token, env);
  const childEnv = { ...env, FORGE_RELEASE_CONFIG: configText(), STAGING_READ_TOKEN: token, STAGING_NOTICES_FILE: cfg.noticesFile };
  const readEnv = { ...env, STAGING_READ_TOKEN: token };
  const exits = [];
  const records = new G.Records(env);
  const stateFile = path.join(cfg.stateDir, "state.json");
  const J = async (p) => {
    const r = await api("GET", p);
    if (!r.ok) R.refuse(`GitHub said ${r.status} to ${p}.`);
    return r.json;
  };
  return {
    cfg, env, log, dry, only, records, api, stateFile, clearHaltCommand,
    state: loadState(stateFile),
    now: () => Date.now(),
    sleep,
    onExit: (fn) => exits.push(fn),
    runExits: () => exits.splice(0).forEach((f) => f()),
    run: (args) => runChild(args, childEnv),
    // A real result for the owner (the install is on his server, tests failed): the same queue and ids as ever.
    notify: ({ id, text, about }) => {
      queueNotice(cfg.noticesFile, { id, text, about, facts: [text] });
    },
    publicVersion: async () => (await G.publicState(readEnv, cfg.repo)).publicVersion,
    tagCommit: async (version) => R.refSha(api, cfg.repo, `tags/candidate/${version}`),
    mainHead: async () => {
      const list = await J(`/repos/${cfg.repo}/commits?sha=main&per_page=1`);
      const sha = list[0].sha;
      const cr = await J(`/repos/${cfg.repo}/commits/${sha}/check-runs?check_name=required&filter=latest`);
      const required = (cr.check_runs || []).filter((x) => x.name === "required").sort((a, b) => Date.parse(b.started_at || 0) - Date.parse(a.started_at || 0))[0];
      if (!required || required.status !== "completed" || required.conclusion !== "success") {
        return { none: `main's newest change has not passed its required check yet (${required ? `${required.status} ${required.conclusion || ""}`.trim() : "no check yet"})` };
      }
      return { commit: sha };
    },
    scenarios: (version) => G.scenariosOrUnread(readEnv, cfg.repo, version),
    dispatch: async (tagName) => {
      const inputs = { stage: tagName, ...(cfg.scenarioMac ? { mac: "true" } : {}) };
      const r = await api("POST", `/repos/${cfg.repo}/actions/workflows/${G.SCENARIOS_WORKFLOW}/dispatches`, { ref: tagName, inputs });
      if (r.status !== 204) R.refuse(`GitHub said ${r.status} to starting the scenarios on ${tagName}${r.json && r.json.message ? ` (${r.json.message})` : ""}.`);
    },
    rerunFailed: async (runId) => {
      const r = await api("POST", `/repos/${cfg.repo}/actions/runs/${runId}/rerun-failed-jobs`, {});
      if (!r.ok && r.status !== 201) R.refuse(`GitHub said ${r.status} to running the failed jobs of run ${runId} again.`);
    },
    failedJobs: async (runId) => G.failedJobNames(api, cfg.repo, runId),
    drive: realDrive({ cfg, env, api, log, itemIssues, readIssues }),
    versionPull: realVersionPull({ cfg, env, log, readmeWith: withReadmeSection, versionWith: withVersion }),
    runInfo: async (runId) => {
      const r = await api("GET", `/repos/${cfg.repo}/actions/runs/${runId}`);
      return r.ok && r.json ? { attempt: r.json.run_attempt || 1, status: r.json.status } : null;
    },
    tagTime: async (sha) => {
      const r = await api("GET", `/repos/${cfg.repo}/git/commits/${sha}`);
      return r.ok && r.json && r.json.committer ? Date.parse(r.json.committer.date) : null;
    },
    jobLog: async (runId, jobName) => {
      const jobs = await J(`/repos/${cfg.repo}/actions/runs/${runId}/jobs?per_page=100`);
      const job = (jobs.jobs || []).find((j) => j.name === jobName);
      if (!job) return "";
      const r = await api("GET", `/repos/${cfg.repo}/actions/jobs/${job.id}/logs`, undefined, { raw: true });
      return r.ok ? r.bytes.toString("utf8") : "";
    },
    // job name -> dates (ISO) of main's recent runs of the scenarios in which that job failed
    mainFailures: async () => {
      const out = {};
      try {
        const runs = await J(`/repos/${cfg.repo}/actions/workflows/${G.SCENARIOS_WORKFLOW}/runs?branch=main&event=schedule&status=completed&per_page=8`);
        for (const run of (runs.workflow_runs || []).filter((x) => x.conclusion === "failure")) {
          const jobs = await J(`/repos/${cfg.repo}/actions/runs/${run.id}/jobs?per_page=100`);
          for (const j of jobs.jobs || []) if (j.conclusion === "failure") (out[j.name] ||= []).push(run.created_at);
        }
      } catch {
        /* no history: the message then says it cannot tell */
      }
      return out;
    },
  };
}

const USAGE = `usage:
  node auto-stage.mjs [--dry-run] [--release <id>]
  node auto-stage.mjs --explain <release-id>
  node auto-stage.mjs --clear-halt <key> [--release <id>]`;

// One look: what the step runs. -> { result, halt, error }. A refusal (GitHub or the server said no) is an
// error the driver's step health follows; it is never a message to the owner (the old "six hours" notice).
export async function look({ env = process.env, dry = false, only = null, log = (s) => console.log(s), clearHaltCommand } = {}) {
  const cfg = loadConfig(env);
  need("productRepo", "the main project's repository");
  if (!cfg.stateDir) return { error: "The setting steps.stage.state_dir is empty, so the stage step has nowhere to keep what it did." };
  let ctx;
  try {
    ctx = await realContext({ cfg, env, dry, only, log, clearHaltCommand });
    const onSignal = () => {
      ctx.runExits();
      process.exit(143);
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    const result = await autoStage(ctx);
    log(`Result: ${result.outcome}.`);
    if (!dry && ctx.state.failing) {
      clearFailure(ctx.state);
      saveState(ctx.stateFile, ctx.state);
    }
    return { result, halt: result.halt || null };
  } catch (e) {
    if (e instanceof R.Refused || (e && /^The state file/.test(e.message))) {
      if (ctx && !dry) {
        try {
          trackFailure(ctx.state, Date.now(), e.message);
          saveState(ctx.stateFile, ctx.state);
        } catch {
          /* the failure itself is returned; the next look tries again */
        }
      }
      return { error: e.message };
    }
    throw e;
  } finally {
    if (ctx) ctx.runExits();
  }
}

// Clears a halt after its cause was fixed, and makes the step carry on from where the halt stood.
// -> a plain sentence of what was done.
export async function clearHalt({ env = process.env, key, release = null, ownerSaid = "", ownerRef = "", log = (s) => console.log(s) }) {
  const cfg = loadConfig(env);
  // Clearing these two lets the step start another PAID scenario run, which only the owner may allow.
  if (OWNER_YES_KEYS.has(key) && (!String(ownerSaid || "").trim() || !String(ownerRef || "").trim())) {
    R.refuse(`The halt "${key}" lets another paid test run start, and only the owner's yes allows that: give his words (--owner-said) and where he said them (--owner-ref). Nothing was changed.`);
  }
  if (!cfg.stateDir) R.refuse("The setting steps.stage.state_dir is empty, so there is no state to clear a halt in.");
  const stateFile = path.join(cfg.stateDir, "state.json");
  const state = loadState(stateFile);
  const releases = Object.entries(state.releases).filter(([id, rs]) => rs && (!release || id === release));
  const said = [];
  if (key.startsWith("blocked-")) {
    const k = key.slice("blocked-".length);
    for (const [id, rs] of releases) {
      if (!rs.blocked || !rs.blocked[k]) continue;
      if (k === "by-hand") {
        // the hand step is done: the plan carries the line that tells the step to go on (planProceeds)
        const records = new G.Records(env);
        records.fetch();
        const file = `releases/${id}/plan.md`;
        const plan = records.read(file) || "";
        if (!planProceeds(plan)) records.write({ [file]: `${plan.replace(/\s*$/, "\n")}\nAuto-stage: proceed\n` }, `${releaseVersion(id) || id}: the step done by hand is done (Auto-stage: proceed)`);
      }
      delete rs.blocked[k];
      said.push(`${id}: the waiting reason "${k}" was cleared${k === "by-hand" ? " and the plan now says Auto-stage: proceed" : ""}`);
    }
  } else {
    for (const [id, rs] of releases) {
      const h = rs.halted;
      if (!h || (h.key || "halted") !== key) continue;
      delete rs.halted;
      delete rs.halting;
      if (key === "freeze-failed") {
        delete rs.started;
        delete rs.freezeStartedAt;
      } else if (key === "freeze-unfinished") {
        delete rs.freezeStartedAt;
        rs.frozen = rs.frozen || new Date().toISOString();
      } else if (key === "scenarios-lost" || key === "scenarios-ignored") {
        if (key === "scenarios-lost") delete rs.dispatchedAt;
        else rs.dispatchApproved = true;
        // the owner's yes is kept beside the approval it allowed
        rs.dispatchApproval = { key, said: String(ownerSaid).trim(), ref: String(ownerRef).trim(), at: new Date().toISOString() };
      }
      else if (key === "not-staged") rs.serverTries = 0;
      said.push(`${id}: the halt "${key}" was cleared`);
    }
  }
  if (!said.length) return `Nothing to clear: no release stands on "${key}".`;
  saveState(stateFile, state);
  for (const w of said) log(w);
  return said.join("; ");
}

// The command line of the old timer, kept for a person at a terminal.
export async function main(argv, env = process.env) {
  const log = (s) => console.log(s);
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (["--release", "--explain", "--clear-halt", "--owner-said", "--owner-ref"].includes(a)) values[a.slice(2)] = argv[++i];
    else if (a.startsWith("--")) flags.add(a.slice(2));
    else {
      console.error(USAGE);
      return 2;
    }
  }
  const known = new Set(["dry-run", "release", "explain", "clear-halt", "owner-said", "owner-ref"]);
  for (const f of [...flags, ...Object.keys(values)]) {
    if (!known.has(f)) {
      console.error(`auto-stage does not know the option --${f}.\n${USAGE}`);
      return 2;
    }
  }
  for (const k of ["release", "explain", "clear-halt"]) {
    if (k in values && (!values[k] || values[k].startsWith("--"))) {
      console.error(`--${k} needs ${k === "clear-halt" ? "a key" : "a release id"}.\n${USAGE}`);
      return 2;
    }
  }
  try {
    if (values["clear-halt"]) {
      await clearHalt({ env, key: values["clear-halt"], release: values.release || null, ownerSaid: values["owner-said"] || "", ownerRef: values["owner-ref"] || "", log });
      return 0;
    }
    const dry = flags.has("dry-run") || !!values.explain;
    if (values.explain) {
      const cfg = loadConfig(env);
      const ctx = await realContext({ cfg, env, dry: true, only: null, log });
      return await explain(ctx, values.explain);
    }
    const out = await look({ env, dry, only: values.release || null, log });
    if (out.error) {
      console.error(out.error);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof R.Refused) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

// Prints what would be written into each ticket of a release, and whether it equals what is there.
export async function explain(ctx, id) {
  const { cfg, records, log } = ctx;
  const plan = records.read(`releases/${id}/plan.md`);
  if (plan === null) R.refuse(`There is no release ${id} on the records repository's main.`);
  const version = releaseVersion(id);
  if (!version) R.refuse(`${id} names no version, so there is nothing to explain.`);
  const files = records.ticketFiles(id);
  const tickets = files.map((file) => ({ file, body: records.read(file) || "" }));
  const items = itemIssues(plan);
  const label = version.includes("-") ? version.slice(version.indexOf("-") + 1) : version;
  const read = await readIssues({ api: ctx.api, repo: cfg.repo, label, numbers: Object.values(items) });
  // ignore the ticket's own Status line: show what the issues alone say
  const bare = tickets.map((t) => ({ ...t, body: t.body.replace(/^Status:.*$/im, "Status: open") }));
  const verdict = judgeCompleteness({ tickets: bare, plan, issues: read.issues, extraOpen: read.extraOpen });
  log(`Release ${id}: the issues say ${verdict.state}${verdict.waitingOn.length ? ` (waiting on ${verdict.waitingOn.join(", ")})` : ""}${verdict.reasons.length ? `; ${verdict.reasons.join("; ")}` : ""}.`);
  // A rebuilt candidate (auto-drive.mjs) is frozen from the release branch, not main, and the tickets of the
  // change it took out are moved to the next release: their issue still names the merge on main.
  const rs = ctx.state && ctx.state.releases ? ctx.state.releases[id] : null;
  if (rs && rs.candidate && rs.candidate !== version) {
    const rel = rs.drive && rs.drive.release;
    log(`Its candidate is now ${rs.candidate}, rebuilt on ${R.releaseBranch(version)}${rel && rel.from ? ` from ${rel.from.slice(0, 7)}` : ""}${rel && rel.mergeSha ? `, frozen from ${rel.mergeSha.slice(0, 7)}` : ""}, not from main.`);
  }
  const moved = new Set(readDeferrals(records.json(`releases/${id}/scope-amendment.json`), { id, version, plan, ticketNames: files }, { strictPerson: false }).deferred);
  let same = 0;
  for (const m of verdict.marks) {
    if (moved.has(path.basename(m.file))) {
      log(`  ${path.basename(m.file)}: issue #${m.issue}, merge ${m.merge.slice(0, 7)} on main (moved to the next release by a scope amendment, so it is not in the candidate)`);
      continue;
    }
    const had = (records.read(m.file) || "").match(DONE_LINE);
    const verdictWord = had ? (had[1] === m.merge ? "same as the recorded merge" : `DIFFERENT from the recorded merge ${had[1].slice(0, 7)}`) : "not recorded yet";
    if (had && had[1] === m.merge) same++;
    log(`  ${path.basename(m.file)}: issue #${m.issue}, merge ${m.merge.slice(0, 7)} (${verdictWord})`);
  }
  const counted = verdict.marks.filter((m) => !moved.has(path.basename(m.file))).length;
  log(`${same} of ${counted} derived merge commits equal the ones the release step recorded.`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === THIS_FILE.toLowerCase();
if (isMain) {
  configureFromEnv();
  process.exitCode = await main(process.argv.slice(2));
}
