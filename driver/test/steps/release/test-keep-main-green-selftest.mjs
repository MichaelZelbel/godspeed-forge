// The self-test of keep-main-green.mjs, moved out of the shipped file unchanged. It runs the real helper as its own
// process against stand-ins for GitHub and the server (stand-ins.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as R from "../../../steps/release/release-api.mjs";
import * as G from "../../../steps/release/staging.mjs";
import { fileURLToPath as __f2u } from "node:url";
import * as M from "../../../steps/release/keep-main-green.mjs";
import { configure } from "../../../steps/release/config.mjs";
import { TEST_RELEASE_SETTINGS } from "./settings-fixture.mjs";
configure(TEST_RELEASE_SETTINGS);
const { TRAILER, CONFIG_DEFAULTS, loadConfig, requiredState, firstParents, failingJobs, rerunTargets, alsoFailed, neverRevertWhy, releaseLabels, failureExcerpt, revertMessage, revertPullText, ticketText, emptyState, loadState, saveState, look, realHub, makeGit, mintToken, main, HERE, MINUTE, MARK, OK_CONCLUSIONS, failedConclusion, firstLine, short, lastLine, iso, quote, jobKey, stripLogLine, repoPath, repoPathsIn, prRef, failureSection, FOOTER, OUTCOME_WORDS, RERUN_REQUESTS, rerunStep, rerunStuck, judge, act, startRevert, followRevert, stillRed, said, shapePull, lockFile, USAGE } = M;
const THIS_FILE = __f2u(new URL("../../../steps/release/keep-main-green.mjs", import.meta.url));

// ---------- self-test ----------

const SHA = (n) => n.toString(16).padStart(7, "0").padEnd(40, "e"); // short form 0000003

// A stand-in for GitHub: main's commits oldest first, each with its required result, the jobs that
// failed in its push runs, and the pull request it came from. Writes are recorded in w.calls.
function makeWorld(specs) {
  const w = { commits: [], required: {}, runs: {}, pulls: {}, logs: {}, checkNames: {}, issues: [], calls: [], nextId: 1000, labels: {}, closing: {} };
  let parent = null;
  specs.forEach((s, i) => {
    const sha = s.sha || SHA(i + 1);
    w.commits.unshift({ sha, parents: parent ? [parent] : [], title: s.title, message: `${s.title}\n\n${s.body || ""}` });
    parent = sha;
    addRuns(w, sha, s);
    if (s.pr !== null) {
      const number = s.pr && s.pr.number ? s.pr.number : 600 + i;
      w.pulls[number] = { number, title: s.title.replace(/ \(#\d+\)$/, ""), url: `https://github.com/x/pull/${number}`, state: "closed", merged: true, head: SHA(5000 + i), headRef: "archon/task-x", user: "godspeed-dev-builder[bot]", mergedBy: "godspeed-dev-builder[bot]", mergeCommit: sha, ...(s.pr || {}) };
      w.checkNames[SHA(5000 + i)] = s.prChecks || ["suite", "required"];
    }
  });
  return w;
}

function addRuns(w, sha, s) {
  const req = s.required === undefined ? "success" : s.required;
  w.required[sha] = req === null ? null : { status: req === "in_progress" ? "in_progress" : "completed", conclusion: req === "in_progress" ? null : req, started_at: "2026-11-16T03:42:00Z" };
  const runs = [];
  const gateFails = req && req !== "success" && req !== "in_progress";
  runs.push({ id: w.nextId++, workflow: "required", attempt: 1, status: req === "in_progress" ? "in_progress" : "completed", conclusion: gateFails ? "failure" : req === "in_progress" ? null : "success", url: "https://github.com/x/actions/runs/r", jobs: [{ id: w.nextId++, name: "suite", status: "completed", conclusion: s.suiteFails ? "failure" : "success", steps: [] }, { id: w.nextId++, name: "required", status: "completed", conclusion: gateFails ? "failure" : "success", steps: [] }], history: [] });
  for (const f of s.fail || []) {
    const [workflow, job] = f.split(" / ");
    const jobId = w.nextId++;
    runs.push({ id: w.nextId++, workflow, attempt: 1, status: "completed", conclusion: "failure", url: "https://github.com/x/actions/runs/i", jobs: [{ id: jobId, name: job, status: "completed", conclusion: "failure", url: `https://github.com/x/actions/runs/i/job/${jobId}`, steps: [{ name: "Set up job", conclusion: "success" }, { name: "Forgiving habit progress and Telegram calendars", conclusion: "failure" }] }], history: [] });
    w.logs[jobId] = s.log || TAP_SAMPLE;
  }
  for (const f of s.failedBefore || []) {
    const [workflow, job] = f.split(" / ");
    runs.push({ id: w.nextId++, workflow, attempt: 2, status: "completed", conclusion: "success", jobs: [{ id: w.nextId++, name: job, status: "completed", conclusion: "success" }], history: [{ id: w.nextId++, name: job, status: "completed", conclusion: "failure" }] });
  }
  w.runs[sha] = runs;
}

const shaOf = (w, runId) => Object.keys(w.runs).find((sha) => w.runs[sha].some((r) => r.id === runId));

// A rerun ends: the run, its failed jobs (the gate's job, for the gate's run) and, for the gate,
// the commit's `required`.
function finishRerun(w, sha, workflow, conclusion) {
  const run = w.runs[sha].find((r) => r.workflow === workflow);
  run.status = "completed";
  run.conclusion = conclusion;
  for (const j of run.jobs) if (workflow !== "required" || j.name === "required") j.conclusion = conclusion;
  if (workflow === "required") w.required[sha] = { status: "completed", conclusion, started_at: "2026-11-16T08:30:00Z" };
}

function fakeHub(w) {
  const find = (id) => Object.values(w.runs).flat().find((r) => r.id === id);
  const reqOf = (sha) => {
    const r = w.required[sha];
    return r ? requiredState([{ name: "required", ...r }], "required") : { state: "none" };
  };
  let mainReads = 0;
  return {
    // w.mainOnSecondRead: what main looks like the second time one look reads it (a fix landing meanwhile)
    // w.onSecondRead: what changes on GitHub right then
    mainCommits: async () => {
      if (++mainReads === 2 && w.onSecondRead) w.onSecondRead();
      return mainReads >= 2 && w.mainOnSecondRead ? w.mainOnSecondRead : w.commits;
    },
    required: async (sha) => reqOf(sha),
    pushRuns: async (sha, { allAttempts = false } = {}) => (w.runs[sha] || []).map((r) => ({ ...r, jobs: allAttempts ? [...r.jobs, ...(r.history || [])] : r.jobs })),
    rerunFailed: async (id) => {
      const run = find(id);
      if (w.refuseRerun > 0) {
        w.refuseRerun -= 1;
        w.calls.push({ op: "rerun-refused", id });
        R.refuse("GitHub said 403 to POST rerun-failed-jobs (Resource not accessible by integration).");
      }
      w.calls.push({ op: "rerun", id, workflow: run.workflow });
      if (w.ghostRerun) return; // GitHub said yes, and never shows a new attempt
      run.history = [...(run.history || []), ...run.jobs.map((j) => ({ ...j }))]; // the attempt before stays readable
      run.attempt += 1;
      run.status = "in_progress";
      run.conclusion = null;
      if (run.workflow === "required") w.required[shaOf(w, id)] = { status: "in_progress", conclusion: null, started_at: "2026-11-16T08:00:00Z" };
    },
    runInfo: async (id) => {
      const run = find(id);
      return run && !w.runInfoBlind ? { attempt: run.attempt, status: run.status, conclusion: run.conclusion } : null;
    },
    jobLog: async (id) => w.logs[id] || "",
    checkNames: async (sha) => new Set(w.checkNames[sha] || []),
    pullOf: async (commit) => Object.values(w.pulls).find((p) => p.mergeCommit === commit.sha) || null,
    pullLabels: async (n) => w.labels[n] || [],
    closingIssues: async (n) => w.closing[n] || [],
    pull: async (n) => ({ ...w.pulls[n] }),
    findPull: async (branch) => Object.values(w.pulls).find((p) => p.headRef === branch) || null,
    openPull: async ({ branch, title, body }) => {
      const number = 900 + w.calls.filter((c) => c.op === "open").length;
      w.calls.push({ op: "open", branch, title, body });
      w.pulls[number] = { number, title, url: `https://github.com/x/pull/${number}`, state: "open", merged: false, head: w.revertHead || SHA(0xabc), headRef: branch, user: "godspeed-dev-builder[bot]", mergedBy: null, mergeCommit: null };
      return w.pulls[number];
    },
    merge: async (n, opts) => {
      w.calls.push({ op: "merge", n, ...opts });
      if (w.refuseMerge) return { ok: false, status: 405, message: "Required status check is expected" };
      const sha = SHA(0xdef);
      Object.assign(w.pulls[n], { merged: true, state: "closed", mergeCommit: sha });
      if (w.loseMergeAnswer) R.refuse("GitHub's answer to the merge was lost (socket hang up).");
      return { ok: true, sha };
    },
    closePull: async (n, note) => {
      w.calls.push({ op: "close", n, note });
      w.pulls[n].state = "closed";
    },
    createIssue: async ({ title, body, labels }) => {
      if (w.failIssue > 0) {
        w.failIssue -= 1;
        w.calls.push({ op: "issue-failed" });
        R.refuse("GitHub said 502 to POST issues.");
      }
      const number = 700 + w.issues.length;
      w.calls.push({ op: "issue", title, body, labels });
      w.issues.push({ number, title, body, labels });
      return { number, url: `https://github.com/x/issues/${number}` };
    },
    findIssue: async (marker) => {
      const hit = w.issues.find((i) => i.body.includes(marker));
      return hit ? { number: hit.number, url: "u" } : null;
    },
  };
}

const TAP_SAMPLE = `2026-11-16T03:32:37.1123728Z ok 23 - a no, another day
2026-11-16T03:32:37.1344768Z # Subtest: the coach and headache recipes no longer claim "track", and their vendored copies are what ships
2026-11-16T03:32:37.1346278Z not ok 35 - the coach and headache recipes no longer claim "track", and their vendored copies are what ships
2026-11-16T03:32:37.1347060Z   ---
2026-11-16T03:32:37.1347570Z   duration_ms: 1.76789
2026-11-16T03:32:37.1348908Z   location: '/home/runner/work/godspeed-mission-control/godspeed-mission-control/notebook/test/tracker-recipe.test.mjs:58:1'
2026-11-16T03:32:37.1349695Z   failureType: 'testCodeFailure'
2026-11-16T03:32:37.1350243Z   error: 'headache-tracker ships a known revision'
2026-11-16T03:32:37.1351443Z   name: 'AssertionError'
2026-11-16T03:32:37.1360257Z # Subtest: the headache add-on carries the notebook's own YAML module
2026-11-16T03:32:37.1360853Z ok 36 - the headache add-on carries the notebook's own YAML module
2026-11-16T03:32:37.1376322Z not ok 41 - the shipped recipes pass an operation's reply on as it came
2026-11-16T03:32:37.1378556Z   location: '/home/runner/work/godspeed-mission-control/godspeed-mission-control/notebook/test/tracker-recipe.test.mjs:120:1'
2026-11-16T03:32:37.1384975Z not ok 42 - the headache recipe replies with "Tracked:", and the coach recipe says a no in words
2026-11-16T03:32:40.7316403Z # tests 77
2026-11-16T03:32:40.7316996Z # pass 74
2026-11-16T03:32:40.7317213Z # fail 3
2026-11-16T03:32:40.7960755Z ##[error]Process completed with exit code 1.
`;

async function selfTest() {
  const t = R.reporter();
  const cfg = { ...loadConfig({}), stateDir: "/nowhere" };
  const BROKEN = "Integrated Godspeed v2 / image";
  let clock = Date.parse("2026-11-16T04:00:00Z");

  // One look against a world; returns the result, the log and the writes it made.
  const lookAt = async (w, { state, dry = false, git, minutes = 11 } = {}) => {
    clock += minutes * MINUTE;
    const lines = [];
    let saves = 0;
    const calls = w.calls.length;
    const gitCalls = [];
    const fakeGit = git || {
      make: async (a) => {
        gitCalls.push({ op: "make", ...a });
        return w.gitMake || { head: w.revertHead || SHA(0xabc), main: w.commits[0].sha, files: ["notebook/x.mjs"] };
      },
      push: async (a) => {
        gitCalls.push({ op: "push", ...a });
        return w.gitPush || { ok: true };
      },
      preview: async (a) => {
        gitCalls.push({ op: "preview", ...a });
        return w.gitMake || { head: SHA(0xabc), main: w.commits[0].sha, files: ["notebook/x.mjs"] };
      },
    };
    const ctx = { cfg, hub: fakeHub(w), git: fakeGit, state, dry, log: (s) => lines.push(s), now: () => clock, save: () => saves++, token: () => "tok" };
    const result = await look(ctx);
    return { result, log: lines.join("\n"), calls: w.calls.slice(calls), gitCalls, saves };
  };
  const ops = (calls) => calls.map((c) => c.op).join(",");
  // G green (#600), C broke main (#668), D after it, red with it.
  const incident = (extra = {}) =>
    makeWorld([
      { title: "Some earlier change (#599)", required: "success" },
      { title: "Revert \"An older change (#617)\" (#654)", required: "success", pr: { number: 654 } },
      { title: "Reconcile overlapping phone health sums (#668)", required: "failure", fail: [BROKEN], pr: { number: 668 }, prChecks: ["suite", "required", "guide"], ...extra },
      { title: "Release step of 2.0.0-beta.25: the version (#673)", required: "failure", fail: [BROKEN], pr: { number: 673, mergedBy: "godspeed-dev-release[bot]", headRef: "release/2.0.0-beta.25-version", title: "Release step of 2.0.0-beta.25: the version" } },
    ]);
  const C = SHA(3);

  try {
    // ---- green, running: nothing
    const greenWorld = makeWorld([{ title: "a (#1)", required: "success" }, { title: "b (#2)", required: "success" }]);
    const g = await lookAt(greenWorld, { state: emptyState() });
    t.ok(g.result.outcome === "green" && !g.calls.length && !g.saves && /Main is green/.test(g.log), `a green main: nothing is done (${g.log})`);
    const running = makeWorld([{ title: "a (#1)", required: "success" }, { title: "b (#2)", required: "failure", fail: [BROKEN] }, { title: "c (#3)", required: "in_progress" }]);
    const r0 = await lookAt(running, { state: emptyState() });
    t.ok(r0.result.outcome === "checking" && !r0.calls.length, "main's newest commit still being checked: nothing is done, even when an older one failed");

    // ---- the incident, all the way: rerun once, fails again, revert, its checks, merge, ticket
    const w = incident();
    w.labels[668] = ["bug", "beta.25"];
    w.closing[668] = [661];
    const state = emptyState();
    const a1 = await lookAt(w, { state });
    t.ok(
      a1.result.outcome === "rerun-started" && a1.result.culprit === C && ops(a1.calls) === "rerun" && a1.calls[0].workflow === "Integrated Godspeed v2" && state.culprits[C].rerun && a1.saves >= 1,
      `the culprit is the first commit after the newest green one (${short(C)}, not main's head), and only its failed push run is run again, once (${a1.log.split("\n").slice(-1)})`,
    );
    t.ok(/the first after it is 0000003 \(Reconcile overlapping phone health sums \(#668\)\), and the one after it is red with it/.test(a1.log), "the log names the culprit and the commits red with it");
    const a2 = await lookAt(w, { state });
    t.ok(a2.result.outcome === "rerun-running" && !a2.calls.length, "while the rerun runs, nothing more is done");
    finishRerun(w, C, "Integrated Godspeed v2", "failure");
    const a3 = await lookAt(w, { state });
    const opened = a3.calls.find((c) => c.op === "open");
    t.ok(
      a3.result.outcome === "revert-opened" &&
        a3.gitCalls.map((c) => c.op).join(",") === "make,push" &&
        a3.gitCalls[0].culprit === C &&
        a3.gitCalls[1].branch === `keep-main-green/revert-${C.slice(0, 12)}` &&
        a3.gitCalls[1].token === "tok" &&
        opened &&
        opened.title === 'Revert "Reconcile overlapping phone health sums (#668)"' &&
        opened.body.includes(`<!-- keep-main-green:revert ${C} -->`) &&
        opened.body.includes("notebook/test/tracker-recipe.test.mjs") &&
        a3.gitCalls[0].message.includes(`${TRAILER} ${C}`),
      `failed again: exactly the culprit is reverted on a branch of its own and opened as a pull request with the builder token (${a3.log.split("\n").slice(-1)})`,
    );
    const a4 = await lookAt(w, { state });
    t.ok(a4.result.outcome === "revert-waiting" && !a4.calls.length, "the revert waits for its checks");
    w.required[SHA(0xabc)] = { status: "completed", conclusion: "success", started_at: "2026-11-16T05:00:00Z" };
    const a5 = await lookAt(w, { state });
    const merge = a5.calls.find((c) => c.op === "merge");
    const ticket = a5.calls.find((c) => c.op === "issue");
    t.ok(
      a5.result.outcome === "reverted" && merge && merge.sha === SHA(0xabc) && merge.title === 'Revert "Reconcile overlapping phone health sums (#668)" (#900)' && state.reverts[SHA(0xdef)] === C,
      `once its required check passed, the revert is squash-merged pinned to its head (${a5.log.split("\n").slice(-2).join(" | ")})`,
    );
    t.ok(
      ticket &&
        ticket.labels.join(",") === "priority,bug,beta.25" &&
        /^Redo #668 "Reconcile overlapping phone health sums": it broke main and was taken back out$/.test(ticket.title) &&
        ticket.body.includes('"Integrated Godspeed v2" / image, step "Forgiving habit progress and Telegram calendars": 3 of 77 tests failed. Its pull request\'s checks did not run this job.') &&
        ticket.body.includes("notebook/test/tracker-recipe.test.mjs: the coach and headache recipes no longer claim \"track\", and their vendored copies are what ships (headache-tracker ships a known revision)") &&
        ticket.body.includes("#900") &&
        ticket.body.includes("It had closed #661") &&
        ticket.body.includes("```text\nnot ok 35") &&
        ticket.body.includes(`<!-- keep-main-green:redo ${C} -->`) &&
        !/—|–/.test(ticket.body),
      `then one ticket for the factory: priority, the release label of the reverted change, the failing job and tests, a log excerpt, the reverted and the revert pull request (${ticket && ticket.title})`,
    );
    const a6 = await lookAt(w, { state });
    t.ok(!a6.calls.length && a6.result.outcome === "handled", `the next look does not revert or file again (${a6.result.outcome})`);

    // ---- main still red after the revert: the revert gets the flaky guard, then a ticket, never a revert
    w.commits.unshift({ sha: SHA(0xdef), parents: [w.commits[0].sha], title: 'Revert "Reconcile overlapping phone health sums (#668)" (#900)', message: `x\n\n${TRAILER} ${C}` });
    addRuns(w, SHA(0xdef), { required: "failure", fail: ["windows setup / build"] });
    const s1 = await lookAt(w, { state });
    t.ok(s1.result.outcome === "rerun-started" && ops(s1.calls) === "rerun" && s1.calls[0].workflow === "windows setup", `main still red after the revert: the revert's failed jobs are run again once (${s1.log.split("\n").slice(-1)})`);
    finishRerun(w, SHA(0xdef), "windows setup", "failure");
    const s2 = await lookAt(w, { state });
    const still = s2.calls.find((c) => c.op === "issue");
    t.ok(s2.result.outcome === "ticket" && still && /^Main is still broken after #668/.test(still.title) && !s2.calls.some((c) => c.op === "open") && !s2.gitCalls.length, `failed again: a ticket, and the revert is never reverted (${still && still.title})`);
    const s3 = await lookAt(w, { state });
    t.ok(!s3.calls.length && s3.result.outcome === "handled", "and nothing more after that");

    // ---- a failure by chance: the rerun passes, required is run again, main turns green
    const fw = makeWorld([{ title: "a (#1)", required: "success" }, { title: "flaky (#2)", required: "failure", fail: [BROKEN] }]);
    const fstate = emptyState();
    await lookAt(fw, { state: fstate });
    finishRerun(fw, SHA(2), "Integrated Godspeed v2", "success");
    const f2 = await lookAt(fw, { state: fstate });
    t.ok(f2.result.outcome === "required-rerun" && ops(f2.calls) === "rerun" && f2.calls[0].workflow === "required" && !f2.gitCalls.length, `the rerun passed: required on that commit is run again, nothing is reverted (${f2.log.split("\n").slice(-1)})`);
    fw.required[SHA(2)] = { status: "completed", conclusion: "success", started_at: "2026-11-16T09:00:00Z" };
    const f3 = await lookAt(fw, { state: fstate });
    t.ok(f3.result.outcome === "green" && !f3.calls.length, "and main is green after that");

    // ---- a rerun GitHub refuses, or never shows, or cannot say anything about, is never a second failure
    const refusedRerun = incident();
    refusedRerun.refuseRerun = 1;
    const rrs = emptyState();
    const q1 = await lookAt(refusedRerun, { state: rrs });
    const q2 = await lookAt(refusedRerun, { state: rrs, minutes: 30 });
    const q3 = await lookAt(refusedRerun, { state: rrs, minutes: 30 });
    t.ok(
      ops(q1.calls) === "rerun-refused" && /GitHub did not take the rerun/.test(q1.log) && ops(q2.calls) === "rerun" && q3.result.outcome === "rerun-running" && !q3.calls.length && !q3.gitCalls.length,
      `a rerun GitHub refused is asked for again on the next look and waited for, never taken as a second failure (${ops(q1.calls)} | ${ops(q2.calls)} | ${q3.result.outcome})`,
    );
    finishRerun(refusedRerun, C, "Integrated Godspeed v2", "failure");
    const q4 = await lookAt(refusedRerun, { state: rrs });
    t.ok(q4.result.outcome === "revert-opened", "and once that rerun has really failed, the revert follows");
    const ghost = incident();
    ghost.ghostRerun = true;
    const gs = emptyState();
    const ghostLooks = [];
    for (let i = 0; i < 8; i++) ghostLooks.push(await lookAt(ghost, { state: gs, minutes: 25 }));
    const ghostIssues = ghost.calls.filter((c) => c.op === "issue");
    t.ok(
      ghostLooks.every((x) => !x.gitCalls.length && !x.calls.some((c) => c.op === "open")) &&
        ghost.calls.filter((c) => c.op === "rerun").length === 3 &&
        ghostIssues.length === 1 &&
        /^Main is broken since #668 "Reconcile overlapping phone health sums", and its failed jobs could not be run again$/.test(ghostIssues[0].title) &&
        ghostIssues[0].body.includes('GitHub did not run the failed jobs of "Integrated Godspeed v2" again after 3 requests') &&
        gs.culprits[C].outcome === "ticket",
      `a rerun GitHub never runs is asked for three times, then the factory gets one ticket and nothing is reverted on a guess (${ghost.calls.filter((c) => c.op === "rerun").length} requests, ${ghostIssues.length} ticket)`,
    );
    const blind = incident();
    const bs = emptyState();
    await lookAt(blind, { state: bs });
    blind.runInfoBlind = true;
    const b2 = await lookAt(blind, { state: bs, minutes: 60 });
    t.ok(b2.result.outcome === "rerun-running" && !b2.gitCalls.length && !b2.calls.length && /does not say how the rerun/.test(b2.log), "GitHub not saying how a rerun went is a wait, not a failure");
    const b3 = await lookAt(blind, { state: bs, minutes: 30 });
    t.ok(b3.result.guard === "rerun-stuck" && ops(b3.calls) === "issue" && !b3.gitCalls.length, `and after more than an hour of silence, a ticket instead of waiting for ever (${b3.log.split("\n").slice(-2).join(" | ")})`);

    // ---- main read again right before the merge: a fix landing during the look stops it
    const race = incident();
    const rcs = emptyState();
    await lookAt(race, { state: rcs });
    finishRerun(race, C, "Integrated Godspeed v2", "failure");
    await lookAt(race, { state: rcs });
    race.required[SHA(0xabc)] = { status: "completed", conclusion: "success", started_at: "2026-11-16T05:00:00Z" };
    race.mainOnSecondRead = [{ sha: SHA(0x677), parents: [race.commits[0].sha], title: "a fix (#677)", message: "x" }, ...race.commits];
    const m1 = await lookAt(race, { state: rcs });
    t.ok(m1.result.outcome === "revert-waiting" && !m1.calls.some((c) => c.op === "merge") && /main moved to 0000677 during this look/.test(m1.log), `main moving right before the merge: not merged (${m1.log.split("\n").slice(-1)})`);
    race.mainOnSecondRead = null;
    race.onSecondRead = () => {
      race.required[C] = { status: "completed", conclusion: "success", started_at: "2026-11-16T09:00:00Z" };
    };
    const m15 = await lookAt(race, { state: rcs });
    t.ok(m15.result.outcome === "revert-waiting" && !m15.calls.some((c) => c.op === "merge") && /the commit 0000003 is now green/.test(m15.log), `the culprit turning green during the look (main's head still red): not merged (${m15.log.split("\n").slice(-1)})`);
    race.onSecondRead = null;
    race.required[C] = { status: "completed", conclusion: "failure", started_at: "2026-11-16T09:30:00Z" };
    const m2 = await lookAt(race, { state: rcs });
    t.ok(m2.result.outcome === "reverted", "and merged on a later look when main is still red with the same culprit");

    // ---- a culprit that failed by chance, with red commits after it: main's head gets the same one
    //      rerun, and the same check failing again later is never a reason to revert
    const chance = () =>
      makeWorld([
        { title: "g (#1)" },
        { title: "c (#2)", required: "failure", fail: [BROKEN] },
        { title: "d (#3)", required: "failure", fail: [BROKEN] },
        { title: "e (#4)", required: "failure", fail: [BROKEN] },
      ]);
    const toGreenCulprit = async (cw, st) => {
      await lookAt(cw, { state: st });
      finishRerun(cw, SHA(2), "Integrated Godspeed v2", "success");
      await lookAt(cw, { state: st });
      finishRerun(cw, SHA(2), "required", "success");
    };
    const ch = chance();
    const chs = emptyState();
    await toGreenCulprit(ch, chs);
    const h1 = await lookAt(ch, { state: chs });
    t.ok(h1.result.outcome === "head-rerun-started" && chs.culprits[SHA(2)].outcome === "flaky" && ops(h1.calls) === "rerun" && ch.runs[SHA(4)].some((r) => r.status === "in_progress"), `the culprit passed when run again: main's newest commit gets the same one rerun (${h1.log.split("\n").slice(-1)})`);
    finishRerun(ch, SHA(4), "Integrated Godspeed v2", "success");
    const h2 = await lookAt(ch, { state: chs });
    t.ok(h2.result.outcome === "head-required-rerun" && ops(h2.calls) === "rerun", "its jobs passed: its required check is run again");
    finishRerun(ch, SHA(4), "required", "success");
    const h3 = await lookAt(ch, { state: chs });
    t.ok(h3.result.outcome === "green" && !ch.calls.some((c) => ["open", "issue", "merge"].includes(c.op)), "and main is green, with nothing reverted and no ticket");
    const ch2 = chance();
    const ch2s = emptyState();
    await toGreenCulprit(ch2, ch2s);
    await lookAt(ch2, { state: ch2s });
    finishRerun(ch2, SHA(4), "Integrated Godspeed v2", "failure");
    const h4 = await lookAt(ch2, { state: ch2s });
    t.ok(h4.result.outcome === "rerun-started" && h4.result.culprit === SHA(3) && ch2s.heads[SHA(4)].done === "failed-again", `the head failed again: the next culprit is judged as usual (${h4.result.outcome} ${short(h4.result.culprit)})`);
    finishRerun(ch2, SHA(3), "Integrated Godspeed v2", "failure");
    const h5 = await lookAt(ch2, { state: ch2s });
    const h5i = h5.calls.find((c) => c.op === "issue");
    t.ok(h5.result.guard === "known-failure" && !h5.gitCalls.length && h5i && h5i.body.includes("also failed on main shortly before (commit 0000002)"), `and the check that failed by chance on the commit before is a known failure, not a reason to revert (${h5i && h5i.title})`);

    const ch3 = makeWorld([
      { title: "g (#1)" },
      { title: "c (#2)", required: "failure", fail: [BROKEN] },
      { title: "d (#3)", required: "failure", fail: ["windows setup / build"] },
      { title: "e (#4)", required: "failure", fail: ["windows setup / build"] },
    ]);
    const ch3s = emptyState();
    await toGreenCulprit(ch3, ch3s);
    await lookAt(ch3, { state: ch3s });
    finishRerun(ch3, SHA(4), "windows setup", "failure");
    await lookAt(ch3, { state: ch3s });
    finishRerun(ch3, SHA(3), "windows setup", "failure");
    const h6 = await lookAt(ch3, { state: ch3s });
    ch3.commits.unshift({ sha: SHA(0x5), parents: [SHA(4)], title: "f (#5)", message: "f" });
    addRuns(ch3, SHA(0x5), { required: "failure", fail: ["windows setup / build"] });
    const h7 = await lookAt(ch3, { state: ch3s });
    t.ok(h6.result.outcome === "revert-opened" && h6.result.culprit === SHA(3) && h7.result.outcome === "revert-waiting" && !h7.calls.length, `a different check failing on the next commit is reverted as usual, and a new commit arriving meanwhile does not hold that revert up with another rerun (${h6.result.outcome}, then ${h7.result.outcome})`);

    // ---- a rerun that never finishes (queued for ever) ends in a ticket
    const queued = incident();
    const qs = emptyState();
    const queuedLooks = [];
    for (let i = 0; i < 8; i++) queuedLooks.push(await lookAt(queued, { state: qs, minutes: 30 }));
    const qi = queued.calls.filter((c) => c.op === "issue");
    t.ok(qi.length === 1 && /has not finished after \d+ minutes \(in_progress\)/.test(qi[0].body) && !queuedLooks.some((x) => x.gitCalls.length), `a rerun that never finishes ends in one ticket after three hours, and nothing is reverted (${qi.length} ticket)`);

    // ---- giving up on a revert: the ticket is filed even when GitHub refused it the first time
    const lostTicket = incident();
    const lts = emptyState();
    await lookAt(lostTicket, { state: lts });
    finishRerun(lostTicket, C, "Integrated Godspeed v2", "failure");
    await lookAt(lostTicket, { state: lts });
    lostTicket.required[SHA(0xabc)] = { status: "completed", conclusion: "failure", started_at: "2026-11-16T05:00:00Z" };
    lostTicket.failIssue = 1;
    let threw = null;
    try {
      await lookAt(lostTicket, { state: lts });
    } catch (e) {
      threw = e.message;
    }
    const lt2 = await lookAt(lostTicket, { state: lts });
    t.ok(!!threw && lt2.result.guard === "revert-failed" && ops(lt2.calls) === "issue" && lts.culprits[C].outcome === "ticket", `a revert closed on giving up still gets its ticket on the next look when filing it failed (${threw ? "first look stopped" : "no failure"}, then ${ops(lt2.calls)})`);

    // ---- a merge whose answer was lost: found merged, recorded, its ticket filed, never closed
    const lostMerge = incident();
    const lms = emptyState();
    await lookAt(lostMerge, { state: lms });
    finishRerun(lostMerge, C, "Integrated Godspeed v2", "failure");
    await lookAt(lostMerge, { state: lms });
    lostMerge.required[SHA(0xabc)] = { status: "completed", conclusion: "success", started_at: "2026-11-16T05:00:00Z" };
    lostMerge.loseMergeAnswer = true;
    let mergeThrew = null;
    try {
      await lookAt(lostMerge, { state: lms });
    } catch (e) {
      mergeThrew = e.message;
    }
    lostMerge.loseMergeAnswer = false;
    lostMerge.commits.unshift({ sha: SHA(0xdef), parents: [lostMerge.commits[0].sha], title: 'Revert "Reconcile overlapping phone health sums (#668)" (#900)', message: `x\n\n${TRAILER} ${C}` });
    addRuns(lostMerge, SHA(0xdef), { required: "success" });
    const lm2 = await lookAt(lostMerge, { state: lms });
    const lmi = lm2.calls.find((c) => c.op === "issue");
    t.ok(!!mergeThrew && lm2.result.outcome === "green" && !lm2.calls.some((c) => c.op === "close") && lmi && /^Redo #668/.test(lmi.title) && lms.reverts[SHA(0xdef)] === C && lms.culprits[C].outcome === "reverted", `a merge whose answer was lost is found merged on the next look, recorded and ticketed, never closed (${ops(lm2.calls)})`);

    // ---- never reverted: a ticket instead
    const guardCase = async (what, world, expectKind, title) => {
      const st = emptyState();
      const sha = world.commits.find((c) => world.required[c.sha] && world.required[c.sha].conclusion === "failure" && world.required[world.commits[world.commits.indexOf(c) + 1].sha].conclusion === "success").sha;
      await lookAt(world, { state: st });
      for (const run of world.runs[sha]) if (run.status === "in_progress") finishRerun(world, sha, run.workflow, "failure");
      const x = await lookAt(world, { state: st });
      const issue = x.calls.find((c) => c.op === "issue");
      t.ok(x.result.outcome === "ticket" && x.result.guard === expectKind && issue && title.test(issue.title) && !x.gitCalls.length && !x.calls.some((c) => c.op === "open"), `${what}: not reverted, a ticket instead (${issue ? issue.title : x.log.split("\n").slice(-1)})`);
    };
    await guardCase(
      "a release step's change (merged by the release App)",
      makeWorld([{ title: "a (#1)" }, { title: "Release step of 2.0.0-beta.25: the version (#673)", required: "failure", fail: [BROKEN], pr: { number: 673, mergedBy: "godspeed-dev-release[bot]", headRef: "release/x" } }]),
      "release-step",
      /^Main is broken since the release step's change #673/,
    );
    await guardCase("a commit that reached main without a pull request", makeWorld([{ title: "a (#1)" }, { title: "pushed straight to main", required: "failure", fail: [BROKEN], pr: null }]), "release-step", /release step's change commit 0000002/);
    await guardCase("a revert made by anyone", makeWorld([{ title: "a (#1)" }, { title: 'Revert "something (#5)" (#6)', required: "failure", fail: [BROKEN] }]), "revert", /^Main is broken since the revert #601/);
    await guardCase(
      "a check that also failed on the parent of the newest green commit",
      makeWorld([{ title: "p (#1)", failedBefore: [BROKEN] }, { title: "g (#2)" }, { title: "c (#3)", required: "failure", fail: [BROKEN] }]),
      "known-failure",
      /^Main's check "Integrated Godspeed v2 \/ image" fails again, since #602/,
    );
    await guardCase("required failing with no failed push-to-main job (another kind of run failed)", makeWorld([{ title: "a (#1)" }, { title: "c (#2)", required: "failure" }]), "no-push-failure", /without a failing check of its own/);
    const own = makeWorld([{ title: "a (#1)" }, { title: "Something else (#2)", required: "failure", fail: [BROKEN] }]);
    const ownState = emptyState();
    ownState.reverts[SHA(2)] = SHA(9);
    await lookAt(own, { state: ownState });
    finishRerun(own, SHA(2), "Integrated Godspeed v2", "failure");
    const ownX = await lookAt(own, { state: ownState });
    t.ok(ownX.result.guard === "revert" && !ownX.gitCalls.length, "a revert this job made (its state names it) is never reverted");

    // ---- a revert that cannot be made or does not pass: a ticket, its pull request closed, nothing forced
    const conflictWorld = incident();
    conflictWorld.gitMake = { conflict: ["notebook/data/recipe-revisions.json"] };
    const cst = emptyState();
    await lookAt(conflictWorld, { state: cst });
    finishRerun(conflictWorld, C, "Integrated Godspeed v2", "failure");
    const cx = await lookAt(conflictWorld, { state: cst });
    const ci = cx.calls.find((c) => c.op === "issue");
    t.ok(cx.result.guard === "cannot-revert" && ci && ci.body.includes("conflicts with what main holds now (notebook/data/recipe-revisions.json)") && !cx.gitCalls.some((c) => c.op === "push") && !cx.calls.some((c) => c.op === "open"), "a revert that conflicts: nothing pushed or opened, a ticket naming the file");
    const refused = incident();
    refused.gitPush = { ok: false, refused: "refusing to allow a GitHub App to create or update workflow `.github/workflows/x.yml` without `workflows` permission" };
    const rst = emptyState();
    await lookAt(refused, { state: rst });
    finishRerun(refused, C, "Integrated Godspeed v2", "failure");
    const rx = await lookAt(refused, { state: rst });
    t.ok(rx.result.guard === "cannot-revert" && rx.calls.some((c) => c.op === "issue" && c.body.includes("could not be pushed")) && !rx.calls.some((c) => c.op === "open"), "a revert the builder key may not push (a workflow file): a ticket");
    const failing = incident();
    const fst = emptyState();
    await lookAt(failing, { state: fst });
    finishRerun(failing, C, "Integrated Godspeed v2", "failure");
    await lookAt(failing, { state: fst });
    failing.required[SHA(0xabc)] = { status: "completed", conclusion: "failure", started_at: "2026-11-16T05:00:00Z" };
    const fx = await lookAt(failing, { state: fst });
    t.ok(fx.result.guard === "revert-failed" && ops(fx.calls) === "close,issue" && !fx.calls.some((c) => c.op === "merge"), `a revert whose own required check fails is closed, never merged, and a ticket is filed (${ops(fx.calls)})`);
    const stuck = incident();
    stuck.refuseMerge = true;
    const kst = emptyState();
    await lookAt(stuck, { state: kst });
    finishRerun(stuck, C, "Integrated Godspeed v2", "failure");
    await lookAt(stuck, { state: kst });
    stuck.required[SHA(0xabc)] = { status: "completed", conclusion: "success", started_at: "2026-11-16T05:00:00Z" };
    const k1 = await lookAt(stuck, { state: kst });
    await lookAt(stuck, { state: kst });
    const k3 = await lookAt(stuck, { state: kst });
    t.ok(k1.result.outcome === "merge-refused" && k3.result.guard === "revert-failed" && stuck.calls.filter((c) => c.op === "merge").length === 3, "a merge GitHub refuses is tried on three looks, then a ticket");

    // ---- main green again while a revert is open: the revert is closed, never merged
    const fixedWorld = incident();
    const xst = emptyState();
    await lookAt(fixedWorld, { state: xst });
    finishRerun(fixedWorld, C, "Integrated Godspeed v2", "failure");
    await lookAt(fixedWorld, { state: xst });
    fixedWorld.required[SHA(0xabc)] = { status: "completed", conclusion: "success", started_at: "2026-11-16T05:00:00Z" };
    fixedWorld.commits.unshift({ sha: SHA(0x676), parents: [fixedWorld.commits[0].sha], title: "Register the headache recipe text that #668 shipped (#676)", message: "x" });
    addRuns(fixedWorld, SHA(0x676), { required: "in_progress" });
    const x1 = await lookAt(fixedWorld, { state: xst });
    t.ok(x1.result.outcome === "checking" && !x1.calls.length, "a fix by hand landing (its check running): the revert is not merged meanwhile");
    fixedWorld.required[SHA(0x676)] = { status: "completed", conclusion: "success", started_at: "2026-11-16T06:00:00Z" };
    const x2 = await lookAt(fixedWorld, { state: xst });
    t.ok(x2.result.outcome === "green" && ops(x2.calls) === "close" && !fixedWorld.calls.some((c) => c.op === "merge") && xst.culprits[C].outcome === "fixed-elsewhere", "main green again without the revert: the revert is closed, never merged");

    // ---- after a crash: nothing twice
    const crash = incident();
    const crst = emptyState();
    await lookAt(crash, { state: crst });
    finishRerun(crash, C, "Integrated Godspeed v2", "failure");
    crst.culprits[C].revert = { branch: `keep-main-green/revert-${C.slice(0, 12)}`, startedAt: "2026-11-16T04:30:00Z" };
    crash.pulls[950] = { number: 950, title: "Revert", state: "open", merged: false, head: SHA(0xabc), headRef: `keep-main-green/revert-${C.slice(0, 12)}`, url: "u" };
    const cr = await lookAt(crash, { state: crst });
    t.ok(cr.result.outcome === "revert-opened" && cr.result.pr === 950 && !cr.calls.some((c) => c.op === "open") && !cr.gitCalls.length, "a pull request opened before a crash is found by its branch, not opened twice");
    const tw = incident();
    tw.issues.push({ number: 777, title: "t", body: `x <!-- keep-main-green:revert-failed ${C} -->`, labels: [] });
    const tst = emptyState();
    tst.culprits[C] = { title: "x", rerun: { at: "2026-11-16T00:00:00Z", runs: [] }, ticket: { kind: "revert-failed", creatingAt: "2026-11-16T00:00:00Z" } };
    tst.culprits[C].revert = { pr: 960, head: SHA(0xabc), openedAt: "2026-11-16T04:00:00Z", branch: "b" };
    tw.pulls[960] = { number: 960, title: "Revert", state: "open", merged: false, head: SHA(0xabc), headRef: "b", url: "u" };
    tw.required[SHA(0xabc)] = { status: "completed", conclusion: "failure", started_at: "2026-11-16T05:00:00Z" };
    const tx = await lookAt(tw, { state: tst });
    t.ok(!tx.calls.some((c) => c.op === "issue") && tst.culprits[C].ticket.number === 777, `a ticket filed before a crash is found by its marker, not filed twice (${ops(tx.calls)})`);

    // ---- the dry run: names the culprit, says what it would do, changes nothing
    const dw = incident();
    const dst = emptyState();
    const d = await lookAt(dw, { state: dst, dry: true });
    t.ok(
      d.result.outcome === "would-rerun" &&
        !d.calls.length &&
        !d.saves &&
        d.gitCalls.every((c) => c.op === "preview") &&
        /Would run the failed jobs of "Integrated Godspeed v2" \(image\) on 0000003 again once/.test(d.log) &&
        /it came from pull request #668/.test(d.log) &&
        d.log.includes(`Would push that revert to the branch keep-main-green/revert-${C.slice(0, 12)}`),
      `--dry-run names the culprit and what it would do, and writes nothing (${d.log.split("\n").filter((l) => /Would/.test(l)).length} would-lines)`,
    );

    const past = incident();
    past.commits.unshift({ sha: SHA(0x676), parents: [past.commits[0].sha], title: "a fix (#676)", message: "x" });
    addRuns(past, SHA(0x676), { required: null });
    const asOfLines = [];
    const asOfResult = await look({ cfg, hub: fakeHub(past), git: { preview: async () => null }, state: emptyState(), dry: true, asOf: SHA(4).slice(0, 7), log: (s) => asOfLines.push(s), now: () => clock, save: () => {}, token: () => null });
    t.ok(asOfResult.outcome === "would-rerun" && /As if main's newest commit were 0000004/.test(asOfLines.join("\n")) && /the first after it is 0000003/.test(asOfLines.join("\n")), "--dry-run --as-of looks as if an older commit were main's head");
    const asOfAlone = spawnSync(process.execPath, [THIS_FILE, "--as-of", "abc1234"], { encoding: "utf8" });
    t.ok(asOfAlone.status === 2 && /works only with --dry-run/.test(asOfAlone.stderr), "--as-of is refused without --dry-run");

    // ---- reading a job's log
    const ex = failureExcerpt(TAP_SAMPLE);
    t.ok(
      ex.summary === "3 of 77 tests failed" &&
        ex.tests.length === 3 &&
        ex.tests[0].file === "notebook/test/tracker-recipe.test.mjs" &&
        ex.tests[0].error === "headache-tracker ships a known revision" &&
        ex.tests[1].file === "notebook/test/tracker-recipe.test.mjs" &&
        ex.errorLine === "Process completed with exit code 1." &&
        ex.excerpt.startsWith("not ok 35"),
      `a job's log gives the failed tests, their file and error, the count and an excerpt (${ex.summary})`,
    );
    const scen = failureExcerpt("2026-11-16T01:00:00Z FAIL first-day: the chat says\n##[error]Process completed with exit code 1.\n");
    t.ok(scen.tests[0].name === "first-day" && scen.tests[0].error === "the chat says", "and the scenarios' FAIL lines");

    // ---- git: the revert itself, against a real repository
    await gitTest(t);

    // ---- the units: the driver installs the timer now (its units are tested with the driver), so none is tested here
    const stray = spawnSync(process.execPath, [THIS_FILE, "--now"], { encoding: "utf8" });
    t.ok(stray.status === 2 && /does not know --now/.test(stray.stderr), "refuses an option it does not know");
  } catch (e) {
    t.ok(false, `the self-test itself failed: ${e.stack}`);
  }
  console.log(t.failures ? `${t.failures} self-test check(s) failed.` : "All keep-main-green self-tests passed.");
  return t.failures ? 1 : 0;
}

// The revert with real git: a clean one, one that conflicts, one with nothing left to take out.
async function gitTest(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keep-main-green-git-"));
  const g = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    const work = path.join(tmp, "work");
    const origin = path.join(tmp, "origin.git");
    fs.mkdirSync(work);
    g(work, "init", "-q", "-b", "main");
    const commit = (files, msg) => {
      for (const [f, text] of Object.entries(files)) {
        if (text === null) fs.rmSync(path.join(work, f));
        else fs.writeFileSync(path.join(work, f), text);
      }
      g(work, "add", "-A");
      g(work, "commit", "-q", "-m", msg);
      return g(work, "rev-parse", "HEAD");
    };
    commit({ "a.txt": "one\n", "keep.txt": "k\n" }, "base");
    const culprit = commit({ "a.txt": "two\n", "b.txt": "new\n" }, "culprit (#668)");
    const later = commit({ "c.txt": "later\n" }, "later (#673)");
    g(tmp, "clone", "-q", "--bare", work, origin);
    g(origin, "config", "uploadpack.allowFilter", "true");
    g(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const remote = pathToFileURL(origin).href;
    const git = makeGit({ dir: path.join(tmp, "clone.git"), remote, name: "K", email: "k@k" });
    const made = git.make({ culprit, message: `Revert "culprit (#668)"\n\n${TRAILER} ${culprit}\n` });
    const pushed = made.head ? git.push({ head: made.head, branch: "keep-main-green/revert-x", token: null }) : { ok: false };
    const tree = made.head ? g(origin, "ls-tree", "--name-only", "keep-main-green/revert-x").split("\n").sort().join(",") : "";
    const aText = made.head ? g(origin, "show", "keep-main-green/revert-x:a.txt") : "";
    t.ok(
      pushed.ok && tree === "a.txt,c.txt,keep.txt" && aText === "one" && made.files.sort().join(",") === "a.txt,b.txt" && g(origin, "rev-parse", "keep-main-green/revert-x^") === g(origin, "rev-parse", "main"),
      `git takes exactly the culprit back out on top of main, keeps what came after it, and pushes it to its branch (${tree})`,
    );
    commit({ "a.txt": "three\n" }, "touches the same line");
    g(work, "push", "-q", origin, "main");
    const conflict = git.make({ culprit, message: "x" });
    t.ok(Array.isArray(conflict.conflict) && conflict.conflict.join(",") === "a.txt", `a revert that conflicts with main is said with its file and makes nothing (${JSON.stringify(conflict)})`);
    // the release driver's revert on a release branch: on top of the candidate's own commit, whatever main holds now
    const onto = git.make({ culprit, message: "x", onto: later });
    t.ok(
      !!onto.head && onto.main === later && g(origin, "rev-parse", "main") !== later && (onto.files || []).sort().join(",") === "a.txt,b.txt",
      `with onto, the revert is made on that commit even when main has moved on and would conflict (${JSON.stringify(onto)})`,
    );
    commit({ "a.txt": "one\n", "b.txt": null }, "taken back by hand");
    g(work, "push", "-q", origin, "main");
    const empty = git.make({ culprit, message: "x" });
    t.ok(empty.empty === true, "nothing left to take out is said as such");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("keep-main-green self-test", async () => {
  assert.equal(await selfTest(), 0);
});
