#!/usr/bin/env node
// A broken main is undone by itself (Michael, 16 November 2026: "a broken main is undone
// automatically, whoever made the change fixes it at their own pace while everything else keeps
// going").
//
//   node scripts/release/keep-main-green.mjs [--dry-run]    one look (on the server, every 10 minutes)
//   node scripts/release/keep-main-green.mjs --dry-run --as-of <commit>
//                                                           the same look, as if that commit were main's head
//   node scripts/release/keep-main-green.mjs --install-timer puts the service and the timer on the server
//   node scripts/release/keep-main-green.mjs --self-test
//
// WHY. On 16 November 2026 at 03:32 UTC the factory merged product pull request #668. Its pull
// request's checks did not run the integrated tests, so main's "Integrated Godspeed v2" image job
// failed after the merge (3 of 77 tests), `required` on main failed, and the release step
// (auto-stage) waited on main for more than two hours while nothing noticed. GitHub's merge queue
// would have caught it before the merge, but a repository of a personal account cannot have one
// (the API refuses a merge_queue rule with 422). This is the next best thing: the change that broke
// main is taken back out within the hour, and the factory gets a ticket to redo it.
//
// ONE LOOK, each decision one line of the log:
//   1. Main's newest commit and its `required` check. Passed, still running, or not there yet:
//      nothing is done (a revert of this job still open is closed when main is green without it).
//   2. Failed: the culprit is the first commit after the newest one whose `required` passed,
//      following first parents.
//   3. Flaky guard: the failed jobs of the culprit's failing push-to-main runs are run again once,
//      written into the state file first, and a later look decides. They pass: `required` on that
//      commit is run again too, so it turns green, and when main's newest commit is a later one, still
//      red, that one gets the same one rerun; auto-stage and follow-main read the newest `required`
//      run of a commit (check-runs filter=latest), so they move on by themselves. They fail again:
//      the culprit broke main. Only a rerun GitHub ran and finished counts; one GitHub refuses, does
//      not show, says nothing about or never finishes is asked for again and then ends in a ticket,
//      never in a revert.
//   4. The revert: exactly the culprit commit, merged onto main's head without a working tree (git
//      merge-tree with the culprit as base and its first parent as the other side, which is what
//      `git revert` does), pushed to a branch of the product repository, and opened as a pull
//      request with the builder App's token, so `required` waits only for the other checks
//      (required-gate.mjs, isFactoryPull). Once `required` passed on its head, and main, read again
//      right before, still has the same head and the same red commits, it is squash-merged pinned to
//      that head. Main green again without it: it is closed (the reason goes into its description;
//      a comment would notify people), never merged.
//   5. Then a ticket for the factory: what broke (workflow, job, step, test names, a log excerpt),
//      the reverted pull request, and the ask to redo it with that failure fixed. Labelled
//      `priority` and `bug` (Cole's loop takes open issues not labelled needs-owner, priority first:
//      process.md, section 12), plus the release label of the issue the reverted pull request
//      closed, so auto-stage does not freeze that release without the change (an open issue with
//      the release label makes it wait).
//   6. Never reverted, a ticket instead: a change of the release step (merged by the release App,
//      from a `release/` branch, titled "Release step", or on main without a pull request, which only
//      the release App can push), a revert (this job's or anyone's), and a commit whose failing check
//      also failed shortly before, on the parent of the newest green commit or on that commit itself
//      before a rerun made it pass (that check looks unreliable rather than broken by it). Only jobs of push-to-main runs count as failures. A revert that conflicts,
//      cannot be pushed, does not pass its own checks or is refused at the merge forces nothing: a
//      ticket, its pull request closed, and that culprit is done.
//   7. Silence: nothing is ever sent to Michael. The log (the journal) is the record, and when this
//      job cannot do its job, the ticket is the signal.
//
// KEYS. The builder App's token for the product repository only (scripts/gh-app-token.mjs builder,
// its keys from the keys file of the settings): it reads, runs failed jobs again (actions: write),
// pushes the revert branch, opens and merges the pull request and files the ticket. git gets the
// token through its environment (GIT_CONFIG_*), never on a command line or in a file.
// Node's own modules, and git 2.40 or newer (merge-tree --merge-base).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as R from "./release-api.mjs";
import * as G from "./staging.mjs";
import { cfg as RELEASE, configureFromEnv } from "./config.mjs";

export const THIS_FILE = fileURLToPath(import.meta.url);
export const HERE = path.dirname(THIS_FILE);
export const MINUTE = 60 * 1000;
export const MARK = "keep-main-green";
// The line every revert of this job carries in its commit message, so a later look knows it.
export const TRAILER = "Keep-Main-Green: revert of";
export const OK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
export const failedConclusion = (c) => !!c && !OK_CONCLUSIONS.has(c);

// ---------- the one config place ----------

export const CONFIG_DEFAULTS = {
  repo: "", // KEEP_MAIN_GREEN_REPO: the settings' main project repository
  stateDir: "", // KEEP_MAIN_GREEN_STATE_DIR: steps.keep-main-green.state_dir: state.json and the bare clone
  remote: null, // KEEP_MAIN_GREEN_REMOTE: where git fetches and pushes; default https://github.com/<repo>.git
  checkName: "required", // KEEP_MAIN_GREEN_CHECK: the one check main requires
  lookBack: 30, // KEEP_MAIN_GREEN_LOOK_BACK: how many of main's first-parent commits are read at most
  labels: ["priority", "bug"], // KEEP_MAIN_GREEN_LABELS (comma separated)
  releaseApp: "", // KEEP_MAIN_GREEN_RELEASE_APP: steps.keep-main-green.release_app: whose merges are the release step's
  branchPrefix: "keep-main-green/revert-", // KEEP_MAIN_GREEN_BRANCH_PREFIX
  rerunGraceMinutes: 20, // KEEP_MAIN_GREEN_RERUN_GRACE_MINUTES: a rerun GitHub does not show by then is asked for again
  rerunMaxMinutes: 180, // KEEP_MAIN_GREEN_RERUN_MAX_MINUTES: a rerun not finished by then (queued for ever) ends in a ticket
  revertCheckMinutes: 150, // KEEP_MAIN_GREEN_REVERT_CHECK_MINUTES: a revert whose `required` has not ended by then gets a ticket
  mergeTries: 3, // KEEP_MAIN_GREEN_MERGE_TRIES: merges GitHub refuses before a ticket
  gitName: "Godspeed keep-main-green", // the revert commit's author before the squash merge
  gitEmail: "keep-main-green@forge.invalid",
  tokenCommand: null, // KEEP_MAIN_GREEN_TOKEN_COMMAND: default `node <keys.token_script> builder <repo>`
};

export function loadConfig(env = process.env) {
  const d = CONFIG_DEFAULTS;
  const num = (name, def) => (env[name] !== undefined && env[name] !== "" && Number.isFinite(Number(env[name])) ? Number(env[name]) : def);
  const repo = env.KEEP_MAIN_GREEN_REPO || d.repo || RELEASE.productRepo;
  const stateDir = env.KEEP_MAIN_GREEN_STATE_DIR || d.stateDir;
  return {
    repo,
    stateDir,
    cloneDir: path.join(stateDir, "product.git"),
    remote: env.KEEP_MAIN_GREEN_REMOTE || `https://github.com/${repo}.git`,
    checkName: env.KEEP_MAIN_GREEN_CHECK || d.checkName,
    lookBack: num("KEEP_MAIN_GREEN_LOOK_BACK", d.lookBack),
    labels: env.KEEP_MAIN_GREEN_LABELS ? env.KEEP_MAIN_GREEN_LABELS.split(",").map((s) => s.trim()).filter(Boolean) : d.labels,
    releaseApp: env.KEEP_MAIN_GREEN_RELEASE_APP || d.releaseApp || RELEASE.releaseApp,
    branchPrefix: env.KEEP_MAIN_GREEN_BRANCH_PREFIX || d.branchPrefix,
    rerunGraceMinutes: num("KEEP_MAIN_GREEN_RERUN_GRACE_MINUTES", d.rerunGraceMinutes),
    rerunMaxMinutes: num("KEEP_MAIN_GREEN_RERUN_MAX_MINUTES", d.rerunMaxMinutes),
    revertCheckMinutes: num("KEEP_MAIN_GREEN_REVERT_CHECK_MINUTES", d.revertCheckMinutes),
    mergeTries: num("KEEP_MAIN_GREEN_MERGE_TRIES", d.mergeTries),
    gitName: d.gitName,
    gitEmail: d.gitEmail,
    tokenCommand: env.KEEP_MAIN_GREEN_TOKEN_COMMAND || d.tokenCommand,
  };
}

// ---------- pure: reading what GitHub says ----------

export const firstLine = (s) => String(s || "").split("\n")[0].trim();
export const short = (sha) => String(sha || "").slice(0, 7) || "(none)";
export const lastLine = (s) => String(s || "").trim().split("\n").filter(Boolean).pop() || "";
export const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
export const quote = (s) => String(s).replace(/"/g, "'");

// The state of a commit's `required`, from its check runs: {state: passed|failed|running|none}.
// The newest run counts (a rerun replaces the run before it), as follow-main and auto-stage read it.
export function requiredState(checkRuns, name) {
  const run = (checkRuns || []).filter((x) => x.name === name).sort((a, b) => Date.parse(b.started_at || 0) - Date.parse(a.started_at || 0))[0];
  if (!run) return { state: "none" };
  if (run.status !== "completed") return { state: "running", startedAt: run.started_at || null };
  if (run.conclusion === "success" || run.conclusion === "neutral") return { state: "passed", startedAt: run.started_at || null };
  if (run.conclusion === "skipped") return { state: "none" };
  return { state: "failed", conclusion: run.conclusion, startedAt: run.started_at || null };
}

// Main's line of first parents, newest first, from GitHub's list of commits (which also lists the
// commits of merged branches). At most n, starting at main's head or at the commit <from> names.
export function firstParents(list, n, from = null) {
  const bySha = new Map(list.map((c) => [c.sha, c]));
  const chain = [];
  let c = from ? list.find((x) => x.sha.startsWith(from.toLowerCase())) : list[0];
  while (c && chain.length < n) {
    chain.push(c);
    c = bySha.get(c.parents[0]);
  }
  return chain;
}

// The jobs that failed in a commit's push-to-main runs (their newest attempt), not the gate itself.
export function failingJobs(runs, checkName) {
  const out = [];
  for (const run of runs) {
    if (run.status !== "completed" || !failedConclusion(run.conclusion)) continue;
    for (const job of run.jobs || []) {
      if (job.name === checkName || job.status !== "completed" || !failedConclusion(job.conclusion)) continue;
      const step = (job.steps || []).find((s) => failedConclusion(s.conclusion));
      out.push({ run: run.id, workflow: run.workflow, job: job.name, jobId: job.id, conclusion: job.conclusion, step: step ? step.name : null, url: job.url || run.url || null });
    }
  }
  return out;
}

// The failed push-to-main runs to run again: every one with a failed job other than the gate. When
// only the gate itself failed (its checks all passed, or what failed was no push run), the gate's run.
export function rerunTargets(runs, checkName) {
  const failed = runs.filter((r) => r.status === "completed" && failedConclusion(r.conclusion));
  const named = (r) => (r.jobs || []).filter((j) => j.name !== checkName && failedConclusion(j.conclusion)).map((j) => j.name);
  const targets = failed.filter((r) => named(r).length).map((r) => ({ id: r.id, workflow: r.workflow, attempt: r.attempt, jobs: named(r) }));
  if (targets.length) return targets;
  const gate = failed.find((r) => (r.jobs || []).some((j) => j.name === checkName));
  return gate ? [{ id: gate.id, workflow: gate.workflow, attempt: gate.attempt, jobs: [checkName] }] : [];
}

export const jobKey = (f) => `${f.workflow} / ${f.job}`;

// Which of the failing jobs also failed, in any attempt, in the push-to-main runs of another commit.
export function alsoFailed(failing, runsAllAttempts) {
  const before = new Set();
  for (const run of runsAllAttempts) for (const job of run.jobs || []) if (failedConclusion(job.conclusion)) before.add(`${run.workflow} / ${job.name}`);
  return [...new Set(failing.map(jobKey))].filter((k) => before.has(k));
}

// Why a commit must not be reverted, or null. pull: the merged pull request it came from, or null.
export function neverRevertWhy({ commit, pull, state, cfg }) {
  if ((state.reverts && state.reverts[commit.sha]) || String(commit.message || "").includes(TRAILER)) return { kind: "revert", why: "it is a revert this job made" };
  if (/^Revert "/.test(commit.title)) return { kind: "revert", why: "it is itself a revert" };
  if (!pull) return { kind: "release-step", why: "it reached main without a pull request, which only the release App can do" };
  if (pull.headRef && pull.headRef.startsWith(cfg.branchPrefix)) return { kind: "revert", why: "it is a revert this job made" };
  if (pull.mergedBy && pull.mergedBy.toLowerCase() === cfg.releaseApp.toLowerCase()) return { kind: "release-step", why: `the release App merged it (#${pull.number})` };
  if (pull.headRef && /^release\//.test(pull.headRef)) return { kind: "release-step", why: `it came from the release branch ${pull.headRef} (#${pull.number})` };
  if (/^Release step\b/i.test(pull.title || "")) return { kind: "release-step", why: `it is a release step's change (#${pull.number})` };
  return null;
}

// Release labels to carry over to the redo ticket (beta.25, rc.1): what auto-stage waits on.
export const releaseLabels = (labels) => [...new Set(labels.filter((l) => /^(alpha|beta|rc)\.\d+(\.\d+)?$/.test(l)))];

// ---------- pure: what a failed job's log says ----------

export const stripLogLine = (l) => String(l).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "").replace(/\r$/, "");
// /home/runner/work/<repo>/<repo>/notebook/test/x.test.mjs:58:1 -> notebook/test/x.test.mjs
export const repoPath = (p) => String(p).replace(/^file:\/\//, "").replace(/^\/home\/runner\/work\/[^/]+\/[^/]+\//, "").replace(/:\d+:\d+$/, "");
export const repoPathsIn = (line) => String(line).replace(/(?:file:\/\/)?\/home\/runner\/work\/[^/\s]+\/[^/\s]+\//g, "");

// {tests: [{name, file, error}], summary, errorLine, excerpt} from a job's log: node's TAP output
// ("not ok 35 - <name>" with its location and error), the scenarios' "FAIL <name>: <why>", node's
// spec reporter ("✖ <name>"), and the last "##[error]" line.
export function failureExcerpt(logText) {
  const lines = String(logText || "").split("\n").map(stripLogLine);
  const tests = [];
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    const tap = lines[i].match(/^\s*not ok \d+ - (.+?)\s*$/);
    if (tap) {
      if (first < 0) first = i;
      let file = null;
      let error = null;
      for (let j = i + 1; j < Math.min(lines.length, i + 60); j++) {
        if (/^\s*(not )?ok \d+ - |^\s*# Subtest:/.test(lines[j])) break;
        const loc = lines[j].match(/^\s*location: '(.+?)'\s*$/);
        if (loc && !file) file = repoPath(loc[1]);
        const er = lines[j].match(/^\s*error: '(.*)'\s*$/) || lines[j].match(/^\s*error: "(.*)"\s*$/);
        if (er && !error) error = er[1].replace(/\\'/g, "'");
      }
      tests.push({ name: tap[1], file, error });
      continue;
    }
    const fail = lines[i].match(/^FAIL\s+(\S+?):\s*(.*)$/);
    if (fail) {
      if (first < 0) first = i;
      tests.push({ name: fail[1], file: null, error: fail[2] || null });
      continue;
    }
    const spec = lines[i].match(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?\s*$/);
    if (spec && !/^failing tests:?$/i.test(spec[1])) {
      if (first < 0) first = i;
      tests.push({ name: spec[1], file: null, error: null });
    }
  }
  const seen = new Set();
  const unique = tests.filter((t) => (seen.has(t.name) ? false : seen.add(t.name)));
  const total = (lines.map((l) => l.match(/^# tests (\d+)/)).find(Boolean) || [])[1];
  const failed = (lines.map((l) => l.match(/^# fail (\d+)/)).find(Boolean) || [])[1];
  const errorAt = lines.map((l, i) => (/^##\[error\]/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  const errorLine = errorAt === undefined ? null : lines[errorAt].replace(/^##\[error\]\s*/, "").trim();
  const from = first >= 0 ? first : errorAt !== undefined ? Math.max(0, errorAt - 15) : -1;
  // what a reader needs: the failing lines, their file and error; not node's own frames or the TAP bookkeeping
  const noise = /^\s*(---|\.\.\.|duration_ms:|type: 'test'|failureType:|code: 'ERR_|stack: \|-|# Subtest:|ok \d+ - )|\(node:|^\s*async Test\./;
  const excerpt = from < 0 ? "" : lines.slice(from, from + 200).filter((l) => l.trim() && !noise.test(l)).slice(0, 18).map((l) => repoPathsIn(l)).map((l) => (l.length > 220 ? `${l.slice(0, 217)}...` : l)).join("\n").trim();
  return {
    tests: unique,
    summary: total && failed ? `${failed} of ${total} tests failed` : unique.length ? `${unique.length} test${unique.length === 1 ? "" : "s"} failed` : null,
    errorLine,
    excerpt,
  };
}

// ---------- pure: the words of the pull request and the tickets ----------

export const prRef = (n) => (n ? `#${n}` : null);

export function failureSection(failing) {
  if (!failing || !failing.length) return "No push-to-main job failed; only the gate itself did.";
  const parts = [];
  for (const f of failing) {
    const where = `"${f.workflow}" / ${f.job}${f.step ? `, step "${f.step}"` : ""}`;
    const notOnPr = f.prRan === false ? " Its pull request's checks did not run this job." : "";
    parts.push(`- ${where}: ${f.summary || `concluded ${f.conclusion}`}.${notOnPr}${f.url ? ` Run: ${f.url}` : ""}`);
    for (const t of (f.tests || []).slice(0, 8)) parts.push(`  - ${t.file ? `${t.file}: ` : ""}${t.name}${t.error ? ` (${t.error})` : ""}`);
    if (!(f.tests || []).length && f.errorLine) parts.push(`  - ${f.errorLine}`);
  }
  const withExcerpt = failing.find((f) => f.excerpt);
  if (withExcerpt) parts.push("", `Log excerpt (${withExcerpt.workflow} / ${withExcerpt.job}):`, "", "```text", withExcerpt.excerpt, "```");
  return parts.join("\n");
}

export function revertMessage({ culprit, failing }) {
  const what = failing && failing.length ? failing.map(jobKey).join(", ") : "the gate";
  return `Revert "${culprit.title}"\n\nThis reverts commit ${culprit.sha}.\n\nMain's required check failed with it (${what}), so it is taken back out by itself; the change is to be redone with the failure fixed.\n\n${TRAILER} ${culprit.sha}\n`;
}

export function revertPullText({ culprit, pull, failing, repo }) {
  const title = `Revert "${culprit.title}"`;
  const from = pull ? `#${pull.number}` : `commit ${short(culprit.sha)}`;
  const body = [
    `Main's \`required\` check fails since ${from} (commit ${culprit.sha}), and running the failed jobs again did not help, so this takes exactly that commit back out. Everything merged after it stays.`,
    "",
    "What failed on main:",
    failureSection(failing),
    "",
    `Once this pull request's \`required\` check passes it is squash-merged by itself, and the factory gets a ticket to redo ${from} with the failure fixed. Nothing here waits for a person: the factory driver's keep-main-green step does it${repo === G.PRODUCT_REPO ? "" : ` (for ${repo})`}.`,
    "",
    `<!-- ${MARK}:revert ${culprit.sha} -->`,
  ].join("\n");
  return { title, body };
}

export const FOOTER = "Filed by the job that keeps the product's main branch green (the factory driver's keep-main-green step).";

// {title, body} of a ticket. kind: redo | cannot-revert | revert-failed | release-step | revert |
// known-failure | no-push-failure | still-red.
export function ticketText(kind, facts) {
  const { culprit, pull, failing, revert, why, closes } = facts;
  const from = pull ? `#${pull.number}` : `commit ${short(culprit.sha)}`;
  const named = pull ? `${from} "${quote(pull.title)}"` : `${from} "${quote(culprit.title)}"`;
  const what = `What failed on main:\n${failureSection(failing)}`;
  const fixMain = "Please make main's `required` check pass again: fix what failed above on main, in a new pull request whose checks run the job that failed.";
  let title;
  let lead;
  let ask;
  switch (kind) {
    case "redo":
      title = `Redo ${named}: it broke main and was taken back out`;
      lead = `${from} (commit ${short(culprit.sha)}) broke main, so it was taken back out by itself in #${revert.pr} (commit ${short(revert.mergeSha)}), and everything else keeps going.${closes && closes.length ? ` It had closed ${closes.map((n) => `#${n}`).join(", ")}; that work is not on main any more.` : ""}`;
      ask = `Please redo ${from} with the failure above fixed. Start from the change itself (revert commit ${short(revert.mergeSha)} on a new branch, or take ${from}'s branch), fix what failed, and make sure the job that failed on main passes on the pull request too.`;
      break;
    case "cannot-revert":
      title = `Main is broken since ${named}, and taking it back out did not work`;
      lead = `Main's \`required\` check fails since ${from} (commit ${short(culprit.sha)}), and running the failed jobs again did not help. It was not taken back out: ${why}.`;
      ask = fixMain;
      break;
    case "revert-failed":
      title = `Main is broken since ${named}, and its revert did not pass its own checks`;
      lead = `Main's \`required\` check fails since ${from} (commit ${short(culprit.sha)}). Its revert, #${revert.pr}, ${why}, so nothing was forced and the revert was closed.`;
      ask = fixMain;
      break;
    case "release-step":
      title = `Main is broken since the release step's change ${named}`;
      lead = `Main's \`required\` check fails since ${from} (commit ${short(culprit.sha)}), and running the failed jobs again did not help. It was not taken back out, because ${why}.`;
      ask = fixMain;
      break;
    case "revert":
      title = `Main is broken since the revert ${named}`;
      lead = `Main's \`required\` check fails since ${from} (commit ${short(culprit.sha)}), and running the failed jobs again did not help. It was not taken back out, because ${why}: undoing a revert would bring back what it removed.`;
      ask = fixMain;
      break;
    case "known-failure":
      title = `Main's check ${why} fails again, since ${named}`;
      lead = `Main's \`required\` check fails since ${from} (commit ${short(culprit.sha)}), and running the failed jobs again did not help. It was not taken back out, because ${why} also failed on main shortly before${facts.before ? ` (commit ${short(facts.before)})` : ""}, so that check looks unreliable rather than broken by ${from}.`;
      ask = "Please find out why this check fails on main now and then, and make it reliable, or fix it if it is truly broken.";
      break;
    case "no-push-failure":
      title = `Main's required check fails since ${named} without a failing check of its own`;
      lead = `Main's \`required\` check fails on ${from} (commit ${short(culprit.sha)}) and failed again when it was run again, but none of the jobs its push to main ran failed. Whatever it counts as failed came from another kind of run, so nothing was taken back out.`;
      ask = "Please find out which check makes `required` fail on main and fix it.";
      break;
    case "rerun-stuck":
      title = `Main is broken since ${named}, and its failed jobs could not be run again`;
      lead = `Main's \`required\` check fails since ${from} (commit ${short(culprit.sha)}). Before anything is taken back out, the failed jobs are run again once, in case they failed by chance, and that did not work: ${why}. So nothing was taken back out.`;
      ask = "Please make main's `required` check pass again: run the failed jobs again if they failed by chance, or fix what failed above.";
      break;
    case "still-red":
      title = `Main is still broken after ${named} was taken back out`;
      lead = `${from} (commit ${short(culprit.sha)}) broke main and was taken back out in #${revert.pr} (commit ${short(revert.mergeSha)}), but main's \`required\` check still fails on that revert, and running its failed jobs again did not help. Something merged after ${from} is broken too; which one cannot be told, because those changes were checked together with ${from}.`;
      ask = fixMain;
      break;
    default:
      throw new Error(`no ticket text for ${kind}`);
  }
  return { title: title.length > 240 ? `${title.slice(0, 237)}...` : title, body: [lead, "", what, "", ask, "", FOOTER].join("\n").replace(/—|–/g, ",") };
}

// ---------- state ----------

export const emptyState = () => ({ version: 1, culprits: {}, reverts: {}, heads: {} });

export function loadState(file) {
  if (!fs.existsSync(file)) return emptyState();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    R.refuse(`The state file ${file} cannot be read (${e.message}); nothing was done, because guessing could revert twice.`);
  }
  if (!data || typeof data !== "object" || typeof data.culprits !== "object" || typeof data.reverts !== "object") R.refuse(`The state file ${file} has an unknown shape; nothing was done.`);
  return data;
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// ---------- one look ----------

export const OUTCOME_WORDS = {
  reverted: "it was taken back out",
  ticket: "a ticket was filed for it",
  "closed-by-person": "a person closed its revert",
  "changed-by-person": "a person pushed to its revert, so it is theirs",
  "fixed-elsewhere": "main went green without its revert",
  flaky: "it failed by chance and passed when run again",
};

// ctx: {cfg, hub, git, state, save(), log(line), now(), dry, token()}
export async function look(ctx) {
  const { cfg, hub, log, state } = ctx;
  const dry = !!ctx.dry;
  const save = () => {
    if (!dry) ctx.save();
  };
  const now = () => ctx.now();
  const finish = (cs, outcome) => {
    cs.outcome = outcome;
    cs.doneAt = iso(now());
    save();
  };
  const reqCache = new Map();
  const req = async (sha) => {
    if (!reqCache.has(sha)) reqCache.set(sha, await hub.required(sha));
    return reqCache.get(sha);
  };

  // A ticket, filed once: the intent is saved first, and a look after a crash looks for it by its
  // marker before filing it again.
  const fileTicket = async (record, kind, facts, extraLabels = []) => {
    if (record.ticket && record.ticket.number) return record.ticket;
    const marker = `<!-- ${MARK}:${kind} ${facts.culprit.sha} -->`;
    const { title, body } = ticketText(kind, facts);
    const labels = [...new Set([...cfg.labels, ...extraLabels])];
    if (dry) {
      log(`Would file a ticket for the factory, labelled ${labels.join(", ")}: "${title}".`);
      return null;
    }
    if (record.ticket && record.ticket.creatingAt) {
      const found = await hub.findIssue(marker);
      if (found) {
        record.ticket = { kind, number: found.number, url: found.url, at: iso(now()) };
        save();
        log(`The ticket was filed before (#${found.number}); not filed again.`);
        return record.ticket;
      }
    }
    record.ticket = { kind, creatingAt: iso(now()) };
    save();
    const made = await hub.createIssue({ title, body: `${body}\n\n${marker}\n`, labels });
    record.ticket = { kind, number: made.number, url: made.url, at: iso(now()) };
    save();
    log(`Filed #${made.number} for the factory (${labels.join(", ")}): "${title}".`);
    return record.ticket;
  };

  // Closed with the reason added to its description: an edit notifies nobody, a comment would.
  const closeRevert = async (cs, note) => {
    if (dry) {
      log(`Would close the revert #${cs.revert.pr}: ${note}`);
      return;
    }
    await hub.closePull(cs.revert.pr, note);
    log(`Closed the revert #${cs.revert.pr}: ${note}`);
  };

  // The redo ticket of a revert that was merged, when an earlier look could not file it.
  const redoTicket = async (sha, cs) => {
    const labels = cs.pr ? releaseLabels(await hub.pullLabels(cs.pr)) : [];
    const closes = cs.pr ? await hub.closingIssues(cs.pr) : [];
    return fileTicket(cs, "redo", { culprit: { sha, title: cs.title }, pull: cs.pr ? { number: cs.pr, title: cs.prTitle || cs.title } : null, failing: cs.failing, revert: cs.revert, closes }, labels);
  };
  for (const [sha, cs] of Object.entries(state.culprits)) {
    if (cs.revert && cs.revert.mergedAt && !(cs.ticket && cs.ticket.number)) await redoTicket(sha, cs);
  }

  // A revert of this job that GitHub merged: recorded, and the redo ticket filed. Also reached when
  // the merge happened but its answer was lost, and a later look finds the pull request merged.
  const recordMerged = async (sha, cs, mergeSha) => {
    if (dry) {
      log(`The revert #${cs.revert.pr} is merged (${short(mergeSha)}); would record it and file the redo ticket.`);
      return;
    }
    cs.revert.mergedAt = iso(now());
    cs.revert.mergeSha = mergeSha;
    state.reverts[mergeSha] = sha;
    finish(cs, "reverted");
    await redoTicket(sha, cs);
  };

  // Reverts still open whose culprit is no longer what keeps main red are closed, never merged. Each
  // is read first: one GitHub merged meanwhile is recorded as merged, one closed is left closed.
  const closeStale = async (keep, why) => {
    for (const [sha, cs] of Object.entries(state.culprits)) {
      if (cs.outcome || !cs.revert || !cs.revert.pr || cs.revert.mergedAt || keep.has(sha)) continue;
      const pr = await hub.pull(cs.revert.pr);
      if (pr.merged) {
        log(`The revert #${cs.revert.pr} of ${short(sha)} is merged already (its answer was lost).`);
        await recordMerged(sha, cs, pr.mergeCommit);
        continue;
      }
      if (pr.state !== "closed") {
        if (!dry) {
          cs.revert.closedByUs = { at: iso(now()), why: "fixed-elsewhere" };
          save();
        }
        await closeRevert(cs, `main is green again after ${short(sha)} without this revert (${why}), so it is not needed.`);
      }
      if (!dry) finish(cs, cs.revert.closedByUs ? "fixed-elsewhere" : "closed-by-person");
    }
  };

  // ---- 1. main's newest commit
  const chain = firstParents(await hub.mainCommits(cfg.lookBack), cfg.lookBack, dry ? ctx.asOf : null);
  if (!chain.length) R.refuse(ctx.asOf ? `${ctx.asOf} is none of main's newest commits.` : "GitHub listed no commits on main.");
  if (dry && ctx.asOf) log(`As if main's newest commit were ${short(chain[0].sha)} (${chain[0].title}); main's real head is newer.`);
  const head = chain[0];
  const headReq = await req(head.sha);
  if (headReq.state === "passed") {
    log(`Main is green: its newest commit ${short(head.sha)} (${head.title}) passed ${cfg.checkName}.`);
    await closeStale(new Set(), `its newest commit ${short(head.sha)} passed`);
    return { outcome: "green" };
  }
  if (headReq.state !== "failed") {
    log(`Main's newest commit ${short(head.sha)} (${head.title}) ${headReq.state === "running" ? `is still being checked (${cfg.checkName} is running)` : `has no ${cfg.checkName} result yet`}; nothing is done until it has one.`);
    return { outcome: "checking" };
  }

  // ---- 2. the culprit: the first commit after the newest green one
  let gi = -1;
  for (let i = 1; i < chain.length; i++) {
    if ((await req(chain[i].sha)).state === "passed") {
      gi = i;
      break;
    }
  }
  if (gi < 0) {
    log(`Main is red at ${short(head.sha)}, and none of its newest ${chain.length} commits passed ${cfg.checkName}, so which change broke it cannot be told; nothing is done.`);
    return { outcome: "no-green" };
  }
  const green = chain[gi];
  const reds = chain.slice(0, gi);
  const culprit = reds[reds.length - 1];
  log(`Main is red at ${short(head.sha)}. The newest commit that passed ${cfg.checkName} is ${short(green.sha)} (${green.title}); the first after it is ${short(culprit.sha)} (${culprit.title})${reds.length === 2 ? ", and the one after it is red with it" : reds.length > 2 ? `, and the ${reds.length - 1} after it are red with it` : ""}.`);
  await closeStale(new Set(reds.map((c) => c.sha)), `${short(green.sha)}, which came after it, passed`);

  // A culprit of an earlier look that failed by chance and is green now: main's head, still red, gets
  // the same one rerun of its failed jobs and then of its gate, so main turns green. When it fails
  // again there, the next culprit is judged as usual (the check that failed by chance before is a
  // known failure then, never a reason to revert).
  const gcs = state.culprits[green.sha];
  if (gcs && gcs.rerun && !gcs.outcome) {
    log(`${short(green.sha)} failed by chance: it passed when its failed jobs were run again.`);
    if (!dry) finish(gcs, "flaky");
  }
  // Only before the next culprit has started anything itself: a revert under way is never held up by
  // new commits arriving on main.
  const next = state.culprits[culprit.sha];
  const nextUntouched = !next || (!next.rerun && !next.revert && !next.outcome);
  if (gcs && (gcs.outcome === "flaky" || (dry && gcs.rerun)) && head.sha !== culprit.sha && nextUntouched) {
    state.heads ||= {};
    const hs = (state.heads[head.sha] ||= {});
    if (!hs.done) {
      log(`So main's newest commit ${short(head.sha)} gets the same one rerun.`);
      const step = await rerunStep({ ctx, sha: head.sha, record: hs, creq: headReq });
      if (step === "failed-again" || step === "stuck") {
        if (!dry) {
          hs.done = step;
          save();
        }
      } else if (step !== "would-rerun") return { outcome: `head-${step}`, culprit: culprit.sha };
    }
  }

  const cs = (state.culprits[culprit.sha] ||= { title: culprit.title, found: iso(now()) });

  // ---- a culprit dealt with before
  if (cs.outcome === "reverted") return stillRed({ ctx, cs, culprit, reds, req, fileTicket });
  if (cs.outcome) {
    log(`${short(culprit.sha)} was dealt with at ${cs.doneAt}: ${OUTCOME_WORDS[cs.outcome] || cs.outcome}${cs.ticket && cs.ticket.number ? ` (#${cs.ticket.number})` : ""}. Nothing more is done for it while main stays red.`);
    return { outcome: "handled", culprit: culprit.sha };
  }
  const creq = await req(culprit.sha);
  if (creq.state !== "failed") {
    log(`${short(culprit.sha)}'s ${cfg.checkName} is ${creq.state === "running" ? "running" : "not there yet"}; waiting for it.`);
    return { outcome: "waiting", culprit: culprit.sha };
  }

  // ---- a revert already under way. Right before it is merged, main is read again (not from this
  // look's earlier answers): a fix that landed meanwhile means no merge.
  const mainStillRed = async () => {
    const now2 = firstParents(await hub.mainCommits(cfg.lookBack), cfg.lookBack, dry ? ctx.asOf : null);
    if (!now2.length || now2[0].sha !== head.sha) return { ok: false, why: `main moved to ${short(now2[0] && now2[0].sha)} during this look` };
    // every red commit, the culprit included, still red: otherwise the culprit is another commit now
    for (const c of reds) {
      const r = await hub.required(c.sha);
      if (r.state !== "failed") return { ok: false, why: `${c.sha === head.sha ? "main's newest commit" : "the commit"} ${short(c.sha)} is now ${r.state === "passed" ? "green" : r.state}` };
    }
    return { ok: true };
  };
  if (cs.revert && cs.revert.pr) return followRevert({ ctx, cs, culprit, finish, fileTicket, closeRevert, req, mainStillRed, recordMerged });

  // ---- 3. the flaky guard
  if (!cs.revert) {
    const step = await rerunStep({ ctx, sha: culprit.sha, record: cs, creq });
    if (step === "would-rerun") {
      log("If they fail again:");
      const judged = await judge({ ctx, culprit, green });
      await act({ ctx, cs, culprit, judged, finish, fileTicket, preview: true });
      return { outcome: "would-rerun", culprit: culprit.sha };
    }
    if (step === "stuck") return rerunStuck({ ctx, record: cs, culprit, why: cs.rerun.stuck, fileTicket, finish });
    if (step !== "failed-again") return { outcome: step, culprit: culprit.sha };
  }

  // ---- 4 to 6. it broke main
  const judged = await judge({ ctx, culprit, green });
  return act({ ctx, cs, culprit, judged, finish, fileTicket, preview: false });
}

// Runs a commit's failed push-to-main jobs again once, and on later looks says how that went:
// would-rerun | rerun-started | rerun-running | required-rerun | waiting | failed-again | stuck.
// record.rerun keeps {at, runs: [{id, workflow, attemptBefore, requestedAt, requestedRequests}],
// requiredAt, requiredRequests, stuck}.
// Only a rerun GitHub took and finished can fail again: one it refused, or one it does not show,
// is asked for again (at most RERUN_REQUESTS times) and waited for, never counted as a failure, so
// a revert always rests on a second failure GitHub really reported. When GitHub does not run it
// after that, or says nothing about it for a long time, the step is stuck: the caller files a
// ticket instead of waiting for ever.
export const RERUN_REQUESTS = 3;
export async function rerunStep({ ctx, sha, record, creq }) {
  const { cfg, hub, log } = ctx;
  const dry = !!ctx.dry;
  const now = ctx.now();
  const grace = cfg.rerunGraceMinutes * MINUTE;
  const horizon = (RERUN_REQUESTS + 1) * grace;
  const stuck = (why) => {
    record.rerun.stuck = why;
    log(`Stuck: ${why}.`);
    return "stuck";
  };
  const ask = async (what, id, entry, at) => {
    entry[`${at}Requests`] = (entry[`${at}Requests`] || 0) + 1;
    try {
      await hub.rerunFailed(id);
    } catch (e) {
      ctx.save();
      log(`GitHub did not take the rerun of ${what} (${e.message}); the next look asks again.`);
      return false;
    }
    entry[`${at}At`] = iso(ctx.now());
    ctx.save();
    return true;
  };
  if (!record.rerun) {
    const targets = rerunTargets(await hub.pushRuns(sha), cfg.checkName);
    if (!targets.length) {
      log(`No push-to-main run of ${short(sha)} failed that could be run again.`);
      return "failed-again";
    }
    const words = targets.map((t) => `"${t.workflow}" (${t.jobs.join(", ")})`).join(", ");
    if (dry) {
      log(`Would run the failed jobs of ${words} on ${short(sha)} again once, and decide on a later look.`);
      return "would-rerun";
    }
    record.rerun = { at: iso(now), runs: targets.map((t) => ({ id: t.id, workflow: t.workflow, attemptBefore: t.attempt })) };
    ctx.save(); // the intent first: a look after a crash finds GitHub's new attempt instead of asking twice
    let taken = 0;
    for (const r of record.rerun.runs) if (await ask(`"${r.workflow}"`, r.id, r, "requested")) taken++;
    if (taken) log(`Ran the failed jobs of ${words} on ${short(sha)} again once; a later look decides.`);
    return "rerun-started";
  }
  const results = [];
  for (const r of record.rerun.runs) {
    const info = await hub.runInfo(r.id);
    if (!info) {
      if (now - Date.parse(record.rerun.at) > horizon) return stuck(`GitHub has not said for ${Math.round((now - Date.parse(record.rerun.at)) / MINUTE)} minutes how the rerun of "${r.workflow}" went`);
      log(`GitHub does not say how the rerun of "${r.workflow}" on ${short(sha)} is going; waiting.`);
      return "rerun-running";
    }
    if (info.attempt <= r.attemptBefore) {
      const since = r.requestedAt ? now - Date.parse(r.requestedAt) : Infinity;
      if (since < grace) {
        log(`The rerun of "${r.workflow}" does not show on GitHub yet; waiting.`);
      } else if ((r.requestedRequests || 0) >= RERUN_REQUESTS) {
        return stuck(`GitHub did not run the failed jobs of "${r.workflow}" again after ${r.requestedRequests} requests`);
      } else if (dry) {
        log(`The rerun of "${r.workflow}" does not show on GitHub; would ask for it again.`);
      } else {
        await ask(`"${r.workflow}"`, r.id, r, "requested");
      }
      return "rerun-running";
    }
    if (info.status !== "completed") {
      const running = now - Date.parse(r.requestedAt || record.rerun.at);
      if (running > cfg.rerunMaxMinutes * MINUTE) return stuck(`the rerun of "${r.workflow}" has not finished after ${Math.round(running / MINUTE)} minutes (${info.status})`);
      log(`The rerun of "${r.workflow}" on ${short(sha)} is still running.`);
      return "rerun-running";
    }
    results.push({ ...r, passed: !failedConclusion(info.conclusion), conclusion: info.conclusion });
  }
  const failed = results.filter((r) => !r.passed);
  if (failed.length) {
    log(`Run again, ${failed.map((r) => `"${r.workflow}" failed again (${r.conclusion})`).join(", ")}: ${short(sha)} broke main.`);
    return "failed-again";
  }
  // The jobs passed when run again: the gate is run again too, so the commit turns green.
  const rr = record.rerun;
  if (rr.requiredAt && Date.parse(creq.startedAt || 0) > Date.parse(rr.requiredAt)) {
    log(`The jobs passed when run again, but ${cfg.checkName} on ${short(sha)} failed again after its own rerun.`);
    return "failed-again";
  }
  if (rr.requiredAt && now - Date.parse(rr.requiredAt) < grace) {
    log(`${cfg.checkName} on ${short(sha)} was run again; waiting for it.`);
    return "waiting";
  }
  if ((rr.requiredRequests || 0) >= RERUN_REQUESTS) return stuck(`the failed jobs passed when run again, but GitHub did not run ${cfg.checkName} again after ${rr.requiredRequests} requests`);
  const gate = (await hub.pushRuns(sha)).find((r) => r.status === "completed" && failedConclusion(r.conclusion) && (r.jobs || []).some((j) => j.name === cfg.checkName));
  if (!gate) {
    if (now - Date.parse(rr.at) > horizon) return stuck(`the failed jobs passed when run again, but no push-to-main run of ${cfg.checkName} is there to run again`);
    log(`The jobs passed when run again, and no failed run of ${cfg.checkName} on ${short(sha)} is left to run again; waiting.`);
    return "waiting";
  }
  if (dry) {
    log(`The jobs passed when run again; would run ${cfg.checkName} on ${short(sha)} again, so main turns green.`);
    return "waiting";
  }
  if (!(await ask(cfg.checkName, gate.id, rr, "required"))) return "waiting";
  log(`The jobs passed when run again, so ${short(sha)} failed by chance; ran its ${cfg.checkName} check again, so main turns green.`);
  return "required-rerun";
}

// The rerun could not be done: a ticket, and that culprit is done (nothing is reverted on a guess).
export async function rerunStuck({ ctx, record, culprit, why, fileTicket, finish = null, pull = null, failing = null }) {
  const { hub, cfg } = ctx;
  const found = pull || (await hub.pullOf(culprit));
  const jobs = failing || failingJobs(await hub.pushRuns(culprit.sha), cfg.checkName);
  await fileTicket(record, "rerun-stuck", { culprit, pull: found, failing: jobs, why });
  if (ctx.dry) return { outcome: "would-ticket", culprit: culprit.sha, guard: "rerun-stuck" };
  if (finish) finish(record, "ticket");
  return { outcome: "ticket", culprit: culprit.sha, guard: "rerun-stuck" };
}

// Everything known about a culprit that broke main, read only: {failing, pull, guard}.
export async function judge({ ctx, culprit, green }) {
  const { cfg, hub, state } = ctx;
  const failingRaw = failingJobs(await hub.pushRuns(culprit.sha), cfg.checkName);
  const pull = await hub.pullOf(culprit);
  const prChecks = pull && pull.head ? await hub.checkNames(pull.head) : null;
  const failing = [];
  for (const f of failingRaw.slice(0, 4)) {
    let text = "";
    try {
      text = await hub.jobLog(f.jobId);
    } catch {
      /* no log: the ticket says what GitHub's jobs say */
    }
    const ex = failureExcerpt(text);
    failing.push({ ...f, tests: ex.tests.slice(0, 10), summary: ex.summary, errorLine: ex.errorLine, excerpt: ex.excerpt, prRan: prChecks ? prChecks.has(f.job) : null });
  }
  let guard = null;
  if (!failingRaw.length) guard = { kind: "no-push-failure", why: "no push-to-main job failed" };
  guard ||= neverRevertWhy({ commit: culprit, pull, state, cfg });
  // The same check failed shortly before: on the newest green commit itself before it was run again
  // (it passed only on the rerun), or on that commit's parent. Then it looks unreliable.
  for (const before of guard ? [] : [green.sha, green.parents[0]].filter(Boolean)) {
    const same = alsoFailed(failingRaw, await hub.pushRuns(before, { allAttempts: true }));
    if (same.length) {
      guard = { kind: "known-failure", why: `"${same.join('", "')}"`, parent: before };
      break;
    }
  }
  return { failing, pull, guard };
}

// Acts on a judged culprit: a ticket for a guard, otherwise the revert. preview: only says what it would do.
export async function act({ ctx, cs, culprit, judged, finish, fileTicket, preview }) {
  const { cfg, log } = ctx;
  const dry = !!ctx.dry || preview;
  const { failing, pull, guard } = judged;
  const from = pull ? `#${pull.number}` : short(culprit.sha);
  log(`What failed: ${failing.length ? failing.map((f) => `"${f.workflow}" / ${f.job}${f.summary ? ` (${f.summary})` : ""}`).join(", ") : "only the gate"}; it came from ${pull ? `pull request #${pull.number} (${pull.title}), opened by ${pull.user}, merged by ${pull.mergedBy}` : "no pull request"}.`);
  if (!dry) {
    cs.pr = pull ? pull.number : null;
    cs.prTitle = pull ? pull.title : null;
    cs.failing = failing;
  }
  const facts = { culprit, pull, failing };
  if (guard) {
    log(`Not reverted: ${guard.kind === "known-failure" ? `${guard.why} also failed on ${short(guard.parent)} shortly before` : guard.why}.`);
    if (dry) {
      log(`Would file a ticket for the factory, labelled ${cfg.labels.join(", ")}: "${ticketText(guard.kind, { ...facts, why: guard.why }).title}".`);
      return { outcome: "would-ticket", culprit: culprit.sha, guard: guard.kind };
    }
    await fileTicket(cs, guard.kind, { ...facts, why: guard.why, before: guard.parent });
    finish(cs, "ticket");
    return { outcome: "ticket", culprit: culprit.sha, guard: guard.kind };
  }
  return startRevert({ ctx, cs, culprit, pull, failing, finish, fileTicket, preview });
}

// The revert: made with git, pushed to its branch, opened as a pull request with the builder App.
export async function startRevert({ ctx, cs, culprit, pull, failing, finish, fileTicket, preview }) {
  const { cfg, hub, git, log } = ctx;
  const dry = !!ctx.dry || preview;
  const branch = `${cfg.branchPrefix}${culprit.sha.slice(0, 12)}`;
  const text = revertPullText({ culprit, pull, failing, repo: cfg.repo });
  const facts = { culprit, pull, failing };
  if (dry) {
    let made = null;
    try {
      made = git.preview ? await git.preview({ culprit: culprit.sha, message: revertMessage({ culprit, failing }) }) : null;
    } catch (e) {
      log(`The revert could not be tried out here (${e.message}).`);
    }
    if (made && made.conflict) log(`Would not revert: taking ${short(culprit.sha)} back out conflicts with main (${made.conflict.join(", ") || "git named no file"}), so it would file a ticket for the factory instead.`);
    else if (made && made.empty) log(`Would not revert: main no longer holds ${short(culprit.sha)}'s change, so it would file a ticket instead.`);
    else {
      if (made && made.head) log(`Tried out: ${short(culprit.sha)} comes back out of main cleanly (${made.files.length} file${made.files.length === 1 ? "" : "s"}: ${made.files.slice(0, 6).join(", ")}${made.files.length > 6 ? ", ..." : ""}).`);
      log(`Would push that revert to the branch ${branch}, open the pull request "${text.title}" with the builder App, squash-merge it pinned to its head once its ${cfg.checkName} check passes (and main is still red with this culprit), then file a ticket for the factory, labelled ${cfg.labels.join(", ")}: "${ticketText("redo", { ...facts, revert: { pr: "<revert>", mergeSha: "" } }).title}".`);
    }
    return { outcome: "would-revert", culprit: culprit.sha, branch };
  }
  // after a crash between pushing and opening: the pull request may be there already
  if (cs.revert && !cs.revert.pr) {
    const found = await hub.findPull(branch);
    if (found && found.state === "open") {
      cs.revert = { ...cs.revert, pr: found.number, url: found.url, head: found.head, openedAt: cs.revert.startedAt || iso(ctx.now()) };
      ctx.save();
      log(`The revert was opened before (#${found.number}); not opened again.`);
      return { outcome: "revert-opened", culprit: culprit.sha, pr: found.number };
    }
  }
  cs.revert = { branch, startedAt: iso(ctx.now()) };
  ctx.save();
  const made = await git.make({ culprit: culprit.sha, message: revertMessage({ culprit, failing }) });
  let cannot = null;
  if (made.conflict) cannot = `it conflicts with what main holds now (${made.conflict.join(", ") || "git named no file"})`;
  else if (made.empty) cannot = "main no longer holds its change, so there was nothing to take out";
  if (!cannot) {
    const pushed = await git.push({ head: made.head, branch, token: ctx.token() });
    if (!pushed.ok) cannot = `the revert could not be pushed (${pushed.refused})`;
  }
  if (cannot) {
    log(`Not reverted: ${cannot}.`);
    cs.revert.cannot = cannot;
    await fileTicket(cs, "cannot-revert", { ...facts, why: cannot });
    finish(cs, "ticket");
    return { outcome: "ticket", culprit: culprit.sha, guard: "cannot-revert" };
  }
  cs.revert.head = made.head;
  ctx.save();
  const opened = await hub.openPull({ branch, title: text.title, body: text.body });
  cs.revert = { ...cs.revert, pr: opened.number, url: opened.url, openedAt: iso(ctx.now()) };
  ctx.save();
  log(`Opened the revert #${opened.number} (${text.title}) from ${branch}; it is merged once its ${cfg.checkName} check passes.`);
  return { outcome: "revert-opened", culprit: culprit.sha, pr: opened.number };
}

// A revert pull request this job opened: wait for its checks, then merge it or give up with a ticket.
export async function followRevert({ ctx, cs, culprit, finish, fileTicket, closeRevert, req, mainStillRed, recordMerged }) {
  const { cfg, hub, log, state } = ctx;
  const dry = !!ctx.dry;
  const n = cs.revert.pr;
  const facts = { culprit, pull: cs.pr ? { number: cs.pr, title: cs.prTitle || culprit.title } : null, failing: cs.failing, revert: cs.revert };
  const pr = await hub.pull(n);
  const merged = async (sha) => {
    await recordMerged(culprit.sha, cs, sha);
    return { outcome: "reverted", culprit: culprit.sha, pr: n, merge: sha };
  };
  if (pr.merged) {
    log(`The revert #${n} is merged (${short(pr.mergeCommit)}).`);
    if (dry) {
      await recordMerged(culprit.sha, cs, pr.mergeCommit);
      return { outcome: "would-record" };
    }
    return merged(pr.mergeCommit);
  }
  if (pr.state === "closed" && cs.revert.closedByUs && cs.revert.closedByUs.why !== "fixed-elsewhere") {
    // closed by this job on giving up, and the ticket was not filed then
    if (dry) return { outcome: "would-ticket", culprit: culprit.sha };
    await fileTicket(cs, "revert-failed", { ...facts, why: cs.revert.closedByUs.why });
    finish(cs, "ticket");
    return { outcome: "ticket", culprit: culprit.sha, guard: "revert-failed" };
  }
  if (pr.state === "closed") {
    log(`The revert #${n} was closed without this job; a person decided, so nothing more is done for ${short(culprit.sha)}.`);
    if (!dry) finish(cs, "closed-by-person");
    return { outcome: "closed-by-person", culprit: culprit.sha };
  }
  if (pr.head !== cs.revert.head) {
    log(`Somebody pushed to the revert #${n} (its head is ${short(pr.head)}, not ${short(cs.revert.head)}), so it is theirs now; nothing is merged.`);
    if (!dry) finish(cs, "changed-by-person");
    return { outcome: "changed-by-person", culprit: culprit.sha };
  }
  const r = await req(pr.head);
  const age = ctx.now() - Date.parse(cs.revert.openedAt);
  const giveUp = async (why) => {
    log(`The revert #${n} ${why}; nothing is forced.`);
    if (dry) return { outcome: "would-ticket", culprit: culprit.sha };
    cs.revert.closedByUs = { at: iso(ctx.now()), why };
    ctx.save(); // a look after a failure in between still files the ticket
    await closeRevert(cs, `It ${why}, so it is not merged; the factory gets a ticket instead.`);
    await fileTicket(cs, "revert-failed", { ...facts, why });
    finish(cs, "ticket");
    return { outcome: "ticket", culprit: culprit.sha, guard: "revert-failed" };
  };
  if (r.state === "running" || r.state === "none") {
    if (age > cfg.revertCheckMinutes * MINUTE) return giveUp(`has had no ${cfg.checkName} result for ${Math.round(age / MINUTE)} minutes`);
    log(`The revert #${n} waits for its checks (${cfg.checkName} ${r.state === "running" ? "is running" : "has not started"}, ${Math.round(age / MINUTE)} minutes).`);
    return { outcome: "revert-waiting", culprit: culprit.sha, pr: n };
  }
  if (r.state === "failed") return giveUp(`failed its own ${cfg.checkName} check (${r.conclusion})`);
  if (dry) {
    log(`The revert #${n} passed ${cfg.checkName}; would squash-merge it pinned to ${short(pr.head)}.`);
    return { outcome: "would-merge", culprit: culprit.sha, pr: n };
  }
  const still = await mainStillRed();
  if (!still.ok) {
    log(`The revert #${n} passed ${cfg.checkName}, but it is not merged now: ${still.why}. The next look decides.`);
    return { outcome: "revert-waiting", culprit: culprit.sha, pr: n };
  }
  const m = await hub.merge(n, { sha: pr.head, title: `${pr.title} (#${n})`, message: revertMessage({ culprit, failing: cs.failing }) });
  if (!m.ok) {
    cs.revert.mergeTries = (cs.revert.mergeTries || 0) + 1;
    ctx.save();
    if (cs.revert.mergeTries >= cfg.mergeTries) return giveUp(`passed its checks, but GitHub refused to merge it ${cs.revert.mergeTries} times (${m.status}: ${m.message})`);
    log(`GitHub refused to merge the revert #${n} (${m.status}: ${m.message}); the next look tries again (${cs.revert.mergeTries} of ${cfg.mergeTries}).`);
    return { outcome: "merge-refused", culprit: culprit.sha, pr: n };
  }
  log(`Merged the revert #${n} as ${short(m.sha)}: ${short(culprit.sha)} is out of main.`);
  return merged(m.sha);
}

// Main is still red after a revert of this job merged: the revert itself gets the flaky guard, then a
// ticket. A revert of this job is never reverted, and the commits after the culprit cannot be judged.
export async function stillRed({ ctx, cs, culprit, reds, req, fileTicket }) {
  const { log, hub, cfg } = ctx;
  const rev = cs.revert && cs.revert.mergeSha;
  const after = (cs.after ||= {});
  if (after.ticket && after.ticket.number) {
    log(`${short(culprit.sha)} was taken back out, main is still red, and the ticket for that is #${after.ticket.number}; nothing more is done.`);
    return { outcome: "handled", culprit: culprit.sha };
  }
  if (!rev || !reds.some((c) => c.sha === rev)) {
    log(`${short(culprit.sha)} was taken back out, but its revert is not on main's line any more; nothing is done.`);
    return { outcome: "handled", culprit: culprit.sha };
  }
  const rreq = await req(rev);
  if (rreq.state !== "failed") {
    log(`${short(culprit.sha)} was taken back out in ${short(rev)}, whose ${cfg.checkName} is ${rreq.state === "running" ? "running" : "not there yet"}; waiting.`);
    return { outcome: "waiting", culprit: culprit.sha };
  }
  const step = await rerunStep({ ctx, sha: rev, record: after, creq: rreq });
  if (step === "would-rerun") return { outcome: "would-rerun", culprit: rev };
  if (step === "stuck") return rerunStuck({ ctx, record: after, culprit, why: after.rerun.stuck, fileTicket, pull: cs.pr ? { number: cs.pr, title: cs.prTitle || culprit.title } : null, failing: cs.failing || [] });
  if (step !== "failed-again") return { outcome: step, culprit: rev };
  const failing = failingJobs(await hub.pushRuns(rev), cfg.checkName);
  const described = [];
  for (const f of failing.slice(0, 4)) {
    let text = "";
    try {
      text = await hub.jobLog(f.jobId);
    } catch {
      /* no log */
    }
    const ex = failureExcerpt(text);
    described.push({ ...f, tests: ex.tests.slice(0, 10), summary: ex.summary, errorLine: ex.errorLine, excerpt: ex.excerpt, prRan: null });
  }
  log(`Main is still red after ${short(culprit.sha)} was taken back out; the revert is never reverted.`);
  await fileTicket(after, "still-red", { culprit, pull: cs.pr ? { number: cs.pr, title: cs.prTitle || culprit.title } : null, failing: described, revert: cs.revert });
  return { outcome: ctx.dry ? "would-ticket" : "ticket", culprit: culprit.sha, guard: "still-red" };
}

// ---------- the real world: GitHub through the builder App, git ----------

export const said = (r) => (r.json && r.json.message ? r.json.message : `status ${r.status}`);

export function shapePull(p) {
  return {
    number: p.number,
    title: p.title,
    url: p.html_url,
    state: p.state,
    merged: !!p.merged_at,
    head: p.head && p.head.sha,
    headRef: p.head && p.head.ref,
    user: p.user && p.user.login,
    mergedBy: p.merged_by ? p.merged_by.login : null,
    mergeCommit: p.merge_commit_sha || null,
  };
}

export function realHub({ cfg, api }) {
  const repo = cfg.repo;
  const [owner, name] = repo.split("/");
  const J = async (p) => {
    const r = await api("GET", p);
    if (!r.ok) R.refuse(`GitHub said ${r.status} to GET ${p} (${said(r)}).`);
    return r.json;
  };
  const W = async (method, p, body, okStatus = null) => {
    const r = await api(method, p, body);
    if (!(okStatus ? r.status === okStatus : r.ok)) R.refuse(`GitHub said ${r.status} to ${method} ${p} (${said(r)}).`);
    return r.json;
  };
  const graphql = async (query) => {
    const r = await api("POST", "/graphql", { query });
    if (!r.ok || !r.json || !r.json.data) R.refuse(`GitHub's GraphQL said ${r.status}${r.json && r.json.errors ? ` (${r.json.errors.map((e) => e.message).join("; ")})` : ""}.`);
    return r.json.data;
  };
  return {
    mainCommits: async (n) =>
      (await J(`/repos/${repo}/commits?sha=main&per_page=${Math.min(100, n * 2)}`)).map((c) => ({ sha: c.sha, parents: (c.parents || []).map((p) => p.sha), title: firstLine(c.commit.message), message: c.commit.message })),
    required: async (sha) => requiredState((await J(`/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(cfg.checkName)}&filter=latest&per_page=100`)).check_runs, cfg.checkName),
    // The push-to-main runs of a commit, each with its jobs (newest attempt; every attempt with allAttempts).
    pushRuns: async (sha, { allAttempts = false } = {}) => {
      const list = await J(`/repos/${repo}/actions/runs?head_sha=${sha}&event=push&branch=main&per_page=100`);
      const out = [];
      for (const run of list.workflow_runs || []) {
        const failed = run.status === "completed" && failedConclusion(run.conclusion);
        const jobs = failed || allAttempts ? (await J(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100&filter=${allAttempts ? "all" : "latest"}`)).jobs || [] : [];
        out.push({
          id: run.id,
          workflow: run.name,
          attempt: run.run_attempt || 1,
          status: run.status,
          conclusion: run.conclusion,
          url: run.html_url,
          jobs: jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, url: j.html_url, steps: (j.steps || []).map((s) => ({ name: s.name, conclusion: s.conclusion })) })),
        });
      }
      return out;
    },
    rerunFailed: async (runId) => W("POST", `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, {}, 201),
    runInfo: async (runId) => {
      const r = await api("GET", `/repos/${repo}/actions/runs/${runId}`);
      return r.ok && r.json ? { attempt: r.json.run_attempt || 1, status: r.json.status, conclusion: r.json.conclusion } : null;
    },
    jobLog: async (jobId) => {
      const r = await api("GET", `/repos/${repo}/actions/jobs/${jobId}/logs`, undefined, { raw: true });
      return r.ok ? r.bytes.toString("utf8") : "";
    },
    checkNames: async (sha) => new Set(((await J(`/repos/${repo}/commits/${sha}/check-runs?filter=all&per_page=100`)).check_runs || []).map((c) => c.name)),
    // The merged pull request a commit on main came from, or null. A number in the title alone is not proof.
    pullOf: async (commit) => {
      const list = await J(`/repos/${repo}/commits/${commit.sha}/pulls`);
      let n = ((list || []).find((p) => p.merge_commit_sha === commit.sha) || {}).number;
      if (!n) n = Number((commit.title.match(/\(#(\d+)\)\s*$/) || [])[1]) || null;
      if (!n) return null;
      const r = await api("GET", `/repos/${repo}/pulls/${n}`);
      if (!r.ok || r.json.merge_commit_sha !== commit.sha) return null;
      return shapePull(r.json);
    },
    pullLabels: async (n) => {
      const d = await graphql(`query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(n)}) { labels(first: 30) { nodes { name } } closingIssuesReferences(first: 10) { nodes { labels(first: 30) { nodes { name } } } } } } }`);
      const p = d.repository && d.repository.pullRequest;
      if (!p) return [];
      return [...p.labels.nodes.map((l) => l.name), ...p.closingIssuesReferences.nodes.flatMap((i) => i.labels.nodes.map((l) => l.name))];
    },
    closingIssues: async (n) => {
      const d = await graphql(`query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${Number(n)}) { closingIssuesReferences(first: 10) { nodes { number } } } } }`);
      const p = d.repository && d.repository.pullRequest;
      return p ? p.closingIssuesReferences.nodes.map((i) => i.number) : [];
    },
    pull: async (n) => shapePull(await J(`/repos/${repo}/pulls/${n}`)),
    findPull: async (branch) => {
      const list = await J(`/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=10`);
      return list && list.length ? shapePull(list[0]) : null;
    },
    // base: main, except the release driver's pull request into a release branch (auto-drive-real.mjs)
    openPull: async ({ branch, title, body, base = "main" }) => shapePull(await W("POST", `/repos/${repo}/pulls`, { title, head: branch, base, body, maintainer_can_modify: false })),
    merge: async (n, { sha, title, message }) => {
      const r = await api("PUT", `/repos/${repo}/pulls/${n}/merge`, { merge_method: "squash", sha, commit_title: title, commit_message: message });
      return r.ok && r.json && r.json.merged ? { ok: true, sha: r.json.sha } : { ok: false, status: r.status, message: said(r) };
    },
    // the reason goes into the description, not a comment: editing a description notifies nobody
    closePull: async (n, note) => {
      const p = await J(`/repos/${repo}/pulls/${n}`);
      await W("PATCH", `/repos/${repo}/pulls/${n}`, { state: "closed", body: `${p.body || ""}\n\n**Closed without merging:** ${note}` });
    },
    createIssue: async ({ title, body, labels }) => {
      const j = await W("POST", `/repos/${repo}/issues`, { title, body, labels });
      return { number: j.number, url: j.html_url };
    },
    findIssue: async (marker) => {
      const list = await J(`/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=50`);
      const hit = (list || []).find((i) => !i.pull_request && String(i.body || "").includes(marker));
      return hit ? { number: hit.number, url: hit.html_url } : null;
    },
  };
}

// git, in a bare partial clone of its own (dir): no working tree, no checkout of the product.
export function makeGit({ dir, remote, name, email }) {
  const run = (args, { input, env = {} } = {}) => {
    const r = spawnSync("git", args, { input, encoding: "utf8", maxBuffer: 64 << 20, timeout: 10 * MINUTE, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } });
    return { code: r.error ? -1 : r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() || (r.error ? r.error.message : "") };
  };
  const inRepo = (args, opts) => run(["-C", dir, ...args], opts);
  const must = (r, what) => {
    if (r.code !== 0) R.refuse(`git could not ${what} (${lastLine(r.err) || `exit ${r.code}`}).`);
    return r.out;
  };
  const fetch = (culprit, onto = null) => {
    if (!fs.existsSync(path.join(dir, "HEAD"))) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      must(run(["clone", "--quiet", "--bare", "--filter=blob:none", "--depth=1", "--no-tags", remote, dir]), "clone the product repository");
    }
    must(inRepo(["fetch", "--quiet", "--filter=blob:none", "--depth=2", "--no-tags", "origin", culprit, ...(onto ? [onto] : []), "+refs/heads/main:refs/remotes/origin/main"]), `fetch main and ${short(culprit)}`);
  };
  // A commit on top of main's head that takes exactly <culprit> back out, nothing pushed:
  // {head, main, files} | {conflict: [files]} | {empty: true}. onto: another commit to put it on
  // instead of main's head (the release driver's revert on a release branch, auto-drive-real.mjs).
  const make = ({ culprit, message, onto = null }) => {
    fetch(culprit, onto);
    const main = onto || must(inRepo(["rev-parse", "refs/remotes/origin/main"]), "read main");
    const parent = must(inRepo(["rev-parse", `${culprit}^1`]), `read the parent of ${short(culprit)}`);
    const m = inRepo(["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${culprit}`, main, parent]);
    if (m.code === 1) return { conflict: m.out.split("\n").slice(1).filter(Boolean) };
    const tree = must(m, `revert ${short(culprit)} (merge-tree)`).split("\n")[0];
    if (tree === must(inRepo(["rev-parse", `${main}^{tree}`]), "read main's tree")) return { empty: true, main };
    const ident = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    const head = must(inRepo(["commit-tree", tree, "-p", main, "-F", "-"], { input: message, env: ident }), "write the revert commit");
    const files = must(inRepo(["diff", "--name-only", main, head]), "list the files the revert changes").split("\n").filter(Boolean);
    return { head, main, files };
  };
  // Pushes the revert to its branch. The token reaches git only through its environment.
  const push = ({ head, branch, token }) => {
    const env = token
      ? {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: "",
          GIT_CONFIG_KEY_1: `http.${new URL(remote).origin}/.extraheader`,
          GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        }
      : {};
    const p = inRepo(["push", "--quiet", "--force", "origin", `${head}:refs/heads/${branch}`], { env });
    if (p.code !== 0) return { ok: false, refused: (lastLine(p.err) || `exit ${p.code}`).split(token || "\u0000").join("***") };
    return { ok: true };
  };
  return { make, push };
}

export function mintToken(cfg, env) {
  const cmd = cfg.tokenCommand ? cfg.tokenCommand.split(/\s+/) : [process.execPath, RELEASE.tokenScript, "builder", cfg.repo];
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", env });
  const token = (r.stdout || "").trim();
  if (r.status !== 0 || !token) R.refuse(`No builder token for ${cfg.repo} (${lastLine(r.stderr) || `exit ${r.status}`}), so nothing was done.`);
  return token;
}

// There is no lock file here: the driver starts this step as a transient unit of its own (one unit name, so
// systemd never runs two at once), which is what the old lock file did.

// ---------- the command ----------

export const USAGE = `usage:
  node keep-main-green.mjs [--dry-run]
  node keep-main-green.mjs --dry-run --as-of <commit>`;

// One look: what the step runs. -> { result } or { error }. It has no hand-off to a person: a break it cannot
// undo becomes a ticket for the factory, which is its own work.
export async function lookOnce({ env = process.env, dry = false, asOf = null, log = (s) => console.log(s) } = {}) {
  const cfg = loadConfig(env);
  if (!cfg.repo) return { error: "The main project has no repository in the settings, so there is no main to keep green." };
  if (!cfg.stateDir) return { error: "The setting steps.keep-main-green.state_dir is empty, so the step has nowhere to keep what it did." };
  if (!cfg.releaseApp) return { error: "The setting steps.keep-main-green.release_app is empty, so the step cannot tell the release step's merges from others." };
  const tmpClone = dry ? fs.mkdtempSync(path.join(os.tmpdir(), "keep-main-green-try-")) : null;
  try {
    let token = null;
    try {
      token = mintToken(cfg, env);
    } catch (e) {
      if (!dry) throw e;
      log(`${e.message.replace(/, so nothing was done\.$/, "")}; the dry run reads GitHub without a token.`);
    }
    const stateFile = path.join(cfg.stateDir, "state.json");
    const state = loadState(stateFile);
    const git = makeGit({ dir: dry ? path.join(tmpClone, "product.git") : cfg.cloneDir, remote: cfg.remote, name: cfg.gitName, email: cfg.gitEmail });
    const ctx = {
      cfg,
      hub: realHub({ cfg, api: R.githubApi(token, env) }),
      git: dry ? { preview: git.make } : git,
      state,
      dry,
      asOf,
      log,
      now: () => Date.now(),
      save: () => saveState(stateFile, state),
      token: () => token,
    };
    const result = await look(ctx);
    log(`Result: ${result.outcome}${dry ? " (a dry run changes nothing)" : ""}.`);
    return { result };
  } catch (e) {
    if (e instanceof R.Refused) return { error: e.message };
    throw e;
  } finally {
    if (tmpClone) fs.rmSync(tmpClone, { recursive: true, force: true });
  }
}

export async function main(argv, env = process.env) {
  const known = new Set(["--dry-run"]);
  const at = argv.indexOf("--as-of");
  const asOf = at >= 0 ? argv[at + 1] : null;
  if (at >= 0) {
    if (!asOf || !/^[0-9a-f]{7,40}$/i.test(asOf) || !argv.includes("--dry-run")) {
      console.error(`--as-of takes a commit (7 to 40 hex characters) and works only with --dry-run.\n${USAGE}`);
      return 2;
    }
    argv = argv.filter((_, i) => i !== at && i !== at + 1);
  }
  const unknown = argv.find((a) => !known.has(a));
  if (unknown) {
    console.error(`keep-main-green does not know ${unknown}.\n${USAGE}`);
    return 2;
  }
  const out = await lookOnce({ env, dry: argv.includes("--dry-run"), asOf });
  if (out.error) {
    console.error(out.error);
    return 1;
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === THIS_FILE.toLowerCase();
if (isMain) {
  configureFromEnv();
  process.exitCode = await main(process.argv.slice(2));
}
