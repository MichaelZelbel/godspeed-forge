import { TEST_ENV } from "./env.mjs";
// The release clock's own rules (standstill.mjs); the whole round, beta.31 replayed, is in test-driver.mjs.
import { test } from "./harness.mjs";
import assert from "node:assert/strict";
import { STANDSTILL, normaliseLook, releaseState, inReleaseStep, workFor, tick, nextStep, namedIn, checkNamed, noticeText, repairWords, OWN_UNITS, ownedBy, partsOf, mergeParts, fpOf } from "../standstill.mjs";
void TEST_ENV;

const MIN = 60000, T0 = Date.parse("2026-11-23T21:00:00Z");
const ID = "godspeed-2.0.0-beta.31-unstuck";
const LOOK = `Release ${ID} (2.0.0-beta.31): approved, newer than the public version, and not on the server yet.\nWaiting for the factory driver to move item 1 to the next release under the plan's rule.\nResult: waiting.\n`;

test("the clock's minutes are constants in code: 20, 40, 60", () => {
  assert.deepEqual([STANDSTILL.helperMinutes, STANDSTILL.otherAiMinutes, STANDSTILL.repairMinutes], [20, 40, 60]);
  assert.ok(Object.isFrozen(STANDSTILL), "nothing changes them at run time");
});

test("the release's state: the stage step's look without its minutes and timestamps, the auto-stage state and the staging record", () => {
  const a = releaseState({ look: "Waiting: the version pull request (#1094) waits for its required check (running) (for 5 minutes).\nMain is at f88f083 and its required check passed.\nA STOP file of this script was 35 minutes old.\nChecked at 2026-11-23T21:05:00Z.", autoStage: { blocked: { "version-check": "2026-11-23T20:00:00Z" } }, staging: null });
  const b = releaseState({ look: "Waiting: the version pull request (#1094) waits for its required check (running) (for 50 minutes).\nMain is at f88f083 and its required check passed.\nA STOP file of this script was 80 minutes old.\nChecked at 2026-11-23T21:50:00Z.", autoStage: { blocked: { "version-check": "2026-11-23T20:00:00Z" } }, staging: null });
  assert.equal(a.fp, b.fp, "the same sentence, later: the same state");
  assert.notEqual(a.fp, releaseState({ look: "Waiting: the version pull request (#1094) waits for its required check (running) (for 5 minutes).\nMain is at 0a1b2c3 and its required check passed.\nA STOP file of this script was 35 minutes old.\nChecked at 2026-11-23T21:05:00Z.", autoStage: { blocked: { "version-check": "2026-11-23T20:00:00Z" } } }).fp, "a new commit named in the look is a change");
  assert.notEqual(releaseState({ look: LOOK }).fp, releaseState({ look: LOOK.replace("item 1", "item 2") }).fp, "another sentence: a new state");
  assert.notEqual(releaseState({ look: LOOK, autoStage: {} }).fp, releaseState({ look: LOOK, autoStage: { started: "2026-11-23T22:00:00Z" } }).fp, "a step in the state file: a new state");
  assert.equal(releaseState({ look: LOOK, staging: { status: "staged", lastCheck: { at: "1", result: "ok" } } }).fp, releaseState({ look: LOOK, staging: { lastCheck: { result: "ok", at: "2" }, status: "staged" } }).fp, "a check's own time is not a change");
  assert.notEqual(releaseState({ look: LOOK, staging: { status: "staged" } }).fp, releaseState({ look: LOOK, staging: { status: "installed" } }).fp);
  assert.equal(normaliseLook("Waiting: x (for 3 hours).\n\n  Result: waiting.  "), "Waiting: x.\nResult: waiting.");
});

test("the clock runs only while the release is in the release step's hands", () => {
  const stage = { id: ID, reason: null, result: "waiting" };
  assert.equal(inReleaseStep(ID, stage, LOOK, null).yes, true, "beta.31: waiting for the driver is the release step's");
  assert.equal(inReleaseStep(ID, stage, `Release ${ID} (2.0.0-beta.31): x.\nNot complete yet: waiting on #783.\nResult: waiting.`, null).yes, false, "the factory still builds a ticket: the ticket's own clock");
  const journal = { tickets: [{ item: 1 }, { item: 2 }], slots: { "t:1:resolved": 1, "t:2:resolved": 2 } };
  assert.deepEqual([inReleaseStep(ID, { id: "godspeed-2.0.0-beta.32-x" }, "", journal).yes, inReleaseStep(ID, { id: "godspeed-2.0.0-beta.32-x" }, "", journal).why], [true, "every ticket is done, and the release step is working on godspeed-2.0.0-beta.32-x"], "one clock per approved release: another release in the release step does not take this one's clock away");
  assert.equal(inReleaseStep(ID, { id: "godspeed-2.0.0-beta.32-x" }, "", null).yes, false, "its tickets not done: not yet");
  assert.equal(inReleaseStep(ID, null, "", journal).yes, true, "no look about it, every ticket done: the release step should be at it");
  assert.equal(inReleaseStep(ID, null, "", { tickets: [{ item: 1 }, { item: 2 }], slots: { "t:1:resolved": 1 } }).yes, false);
});

test("checkable work holds the clock only while it runs and inside its own limit; other projects' runs, main's runs and the release step's own look never do", () => {
  const now = T0 + 60 * MIN;
  const activity = { runs: [
    { headBranch: "candidate/2.0.0-beta.31", createdAt: new Date(now - 30 * MIN).toISOString(), name: "scenarios" },
    { headBranch: "main", createdAt: new Date(now - 5 * MIN).toISOString(), name: "required" },
    { headBranch: "candidate/2.0.0-beta.30", createdAt: new Date(now - 5 * MIN).toISOString(), name: "scenarios" },
    { headBranch: "release/version-2.0.0-beta.31", headSha: "abc", createdAt: new Date(now - 5 * MIN).toISOString(), name: "required" },
  ], stop: { at: new Date(now - 30 * MIN).toISOString() }, procs: [{ startedAt: now - 10 * MIN, args: "node /x/release/auto-stage.mjs" }, { startedAt: now - 10 * MIN, args: "node /x/release/freeze.mjs o/r 2.0.0-beta.31 --commit abc" }, { startedAt: now - 10 * MIN, args: "node /x/release/stage-server.mjs o/r 2.0.0-beta.30 --release godspeed-2.0.0-beta.30-y" }] };
  const w = workFor({ id: ID, activity, autoStage: { bump: { branch: "release/version-2.0.0-beta.31", head: "abc", pr: 1094 } }, about: true, now, repo: "o/r" });
  assert.deepEqual(w.map(x => x.what), ["a GitHub run (scenarios) on candidate/2.0.0-beta.31", "a GitHub run (required) on release/version-2.0.0-beta.31", "auto-stage's STOP file (the scenarios run)", "the release step's freeze program"]);
  assert.deepEqual(workFor({ id: ID, activity: { ...activity, runs: [activity.runs[0]] }, about: false, now, repo: "o/r" }).map(x => x.what), ["a GitHub run (scenarios) on candidate/2.0.0-beta.31", "the release step's freeze program"], "a STOP belongs to the release the stage step looks at; a program to the release whose version it names (beta.30's install is not this one's)");
  assert.deepEqual(workFor({ id: ID, activity: { runs: [{ headBranch: "candidate/2.0.0-beta.31", createdAt: new Date(now - 4 * 60 * MIN).toISOString() }] }, about: true, now }), [], "a run past its own limit holds nothing");
  assert.deepEqual(workFor({ id: ID, activity: null, about: true, named: [{ what: "the GitHub run 9", answeredAt: now - 61 * MIN }], now }), [], "what a helper named holds at most an hour after its answer");
});

test("20, 40, 60: a still release gets an acting run, the other AI, then the repair program and one notice; held work pauses the clock; a change starts it again", () => {
  let c = null; const seen = [];
  // one round of the driver: the clock ticks, and each step that is due is taken (as the round takes it)
  const at = (min, { look = LOOK, work = [] } = {}) => { const r = tick(c, { fp: releaseState({ look }).fp, work, now: T0 + min * MIN, lastRoundAt: T0 + (min - 5) * MIN }); c = r.clock; if (r.due.length) seen.push([min, ...r.due]); for (const d of r.due) c.done[{ helper: "helper", "other-ai": "other", repair: "repair", notice: "notice" }[d]] = true; return r; };
  at(0);
  assert.equal(c.stillMs, 5 * MIN, "a new state counts from the last round that saw the old one");
  for (let m = 5; m <= 90; m += 5) at(m);
  assert.deepEqual(seen, [[15, "helper"], [35, "other-ai"], [55, "repair", "notice"]], "each step by its minute, counted from the last round that saw the release move");
  assert.deepEqual(nextStep(c), { what: "the ladder again, from rung 1", at: 60 + 24 * 60 + 20 });
  // held: the clock does not run while the work runs, and goes on from where it was
  c = null; seen.length = 0;
  at(0); at(5); at(10);
  for (let m = 15; m <= 40; m += 5) at(m, { work: [{ what: "a run", until: T0 + 42 * MIN }] });
  assert.equal(Math.round(c.stillMs / MIN), 15, "15 minutes before the run, none while it ran");
  at(45);
  assert.deepEqual(seen, [[45, "helper"]], "the run ended at 42: the round at 45 goes on from 15 and reaches 20, so the helper comes");
  // a change at minute 35 starts the clock again
  c = null; seen.length = 0;
  for (let m = 0; m <= 30; m += 5) at(m);
  at(35, { look: LOOK.replace("item 1", "item 2") });
  assert.equal(c.done.helper, undefined, "a new state: a new ladder");
  for (let m = 40; m <= 50; m += 5) at(m, { look: LOOK.replace("item 1", "item 2") });
  assert.deepEqual(seen, [[15, "helper"], [50, "helper"]], "no rung 2 at 40; the new state gets its own rung 1 at its own minute 20");
  assert.deepEqual(nextStep(c), { what: "the other AI (rung 2)", at: 40 }, "the new state's own minute 40 comes next");
});

test("an in-progress answer counts only for what it names that the driver can check runs; the driver's own units never count", () => {
  const named = namedIn("The scenarios run https://github.com/o/r/actions/runs/123456789 is still going; pull request #1094 waits for its check; the freeze runs in godspeed-freeze.service; and the factory-driver.service is actively running the repair.", "o/r");
  assert.deepEqual(named.map(n => `${n.kind}:${n.repo}:${n.id}`), ["run:o/r:123456789", "pr:o/r:1094", "unit:o/r:godspeed-freeze.service", "unit:o/r:factory-driver.service"]);
  assert.deepEqual(namedIn("The factory driver is actively running the requested repair for the release's already-delivered first item.\n\nRESULT: in-progress", "o/r"), [], "beta.31's answer names nothing");
  const calls = [];
  const checked = checkNamed(named, (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "systemctl") return { status: 0, stdout: "active\n" };
    if (/actions\/runs\/123456789/.test(args[1])) return { status: 0, stdout: JSON.stringify({ status: "in_progress" }) };
    if (/pulls\/1094/.test(args[1])) return { status: 0, stdout: JSON.stringify({ state: "closed", merged_at: "x" }) };
    return { status: 1, stdout: "" };
  });
  assert.deepEqual(checked.map(n => n.running), [true, false, true, false], "the run runs; the pull request is merged; the freeze unit is active; the driver's own unit is never work");
  assert.ok(!calls.some(c => /factory-driver/.test(c)), "and is not even asked about");
  assert.ok(OWN_UNITS.test("forge-step-stage.service") && OWN_UNITS.test("factory-act-5a6f5cf08f-1.service"));
  assert.deepEqual(checkNamed([{ kind: "run", id: "1", repo: "o/r" }], () => { throw new Error("GitHub is down"); }).map(n => n.running), [false], "unreadable: not running");
});

test("what the owner reads at minute 60, word for word, and what the dead-man's repair run reads", () => {
  const launches = [{ rung: 1, provider: "codex" }, { rung: 2, provider: "claude" }];
  assert.equal(noticeText("Beta 31", launches, true), "Beta 31 has not moved for about an hour. Two AI helpers tried to move it, first Codex and then Claude, and it is still stuck, so the repair program is now working on it; nothing is needed from you unless a later message says so.");
  assert.equal(noticeText("Beta 31", [launches[0], { rung: 2, provider: "codex" }], true), "Beta 31 has not moved for about an hour. Two AI helpers tried to move it, both on Codex, as the other AI could not be reached, and it is still stuck, so the repair program is now working on it; nothing is needed from you unless a later message says so.");
  assert.equal(noticeText("Beta 31", [launches[0]], true), "Beta 31 has not moved for about an hour. One AI helper (Codex) tried to move it and it is still stuck; a second one could not be started, so the repair program is now working on it; nothing is needed from you unless a later message says so.");
  assert.equal(noticeText("Beta 31", [], false), "Beta 31 has not moved for about an hour. No AI helper could be started to move it, so Mission Control keeps trying to start the repair program; nothing is needed from you unless a later message says so.");
  assert.doesNotMatch(noticeText("Beta 31", launches, true), /—|–|#\d|\.mjs|rung/, "plain words: no dash, no numbers of issues, no file or internal names");
  const w = repairWords(ID, 60, LOOK, [{ rung: 1, provider: "codex", result: "unresolved" }], launches);
  assert.match(w, new RegExp(`^The approved release ${ID} has not moved for 60 minutes`));
  assert.match(w, /Waiting for the factory driver to move item 1/); assert.match(w, /rung 1 on codex: unresolved; rung 2 on claude: still running/);
});

test("a clock the state file lost is rebuilt from the journal: when the state began and the steps taken", () => {
  const fp = releaseState({ look: LOOK }).fp;
  const r = tick(null, { fp, work: [], now: T0 + 45 * MIN, lastRoundAt: T0 + 40 * MIN, journal: { fp, since: T0, steps: ["helper", "other"] } });
  assert.equal(Math.round(r.clock.stillMs / MIN), 45, "still since the journal's start, not since now");
  assert.deepEqual(r.due, [], "rung 1 and rung 2 were taken already: not again");
  const later = tick(r.clock, { fp, work: [], now: T0 + 60 * MIN, journal: { fp, since: T0, steps: ["helper", "other"] } });
  assert.deepEqual(later.due, ["repair", "notice"], "and the repair step comes at its minute");
  assert.equal(Math.round(tick(null, { fp, work: [], now: T0 + 45 * MIN, lastRoundAt: T0 + 40 * MIN, journal: { fp: "another", since: T0, steps: [] } }).clock.stillMs / MIN), 5, "the journal's clock of another state is not this one's");
});

test("auto-stage's STOP counts only from the main project, which is the only one auto-stage stops", async () => {
  const { readActivity } = await import("../duties.mjs");
  const now = T0, at = new Date(now - 10 * MIN).toISOString();
  const run = () => ({ status: 0, stdout: "" });
  assert.equal(readActivity({ REPO: "o/r" }, { factories: [{ primary: false, stop: { writer: "auto-stage", at } }] }, run, now).stop, null, "another project's STOP holds nothing");
  assert.deepEqual(readActivity({ REPO: "o/r" }, { factories: [{ primary: true, stop: { writer: "auto-stage", at } }] }, run, now).stop, { at });
});

test("a round that starts a few seconds early still takes its step: never a round late", () => {
  const fp = releaseState({ look: LOOK }).fp;
  let c = null; const due = [];
  // rounds on the five-minute grid, each starting up to two seconds early or late
  for (const [m, jitter] of [[0, 1500], [5, -2000], [10, 800], [15, -1900], [20, -2000], [25, 0]]) { const r = tick(c, { fp, work: [], now: T0 + m * MIN + jitter, lastRoundAt: T0 - 5 * MIN + 1000 }); c = r.clock; if (r.due.length) { due.push([m, ...r.due]); for (const d of r.due) c.done[{ helper: "helper" }[d]] = true; } }
  assert.deepEqual(due[0], [15, "helper"], "the change came after the round at -5: the round at 15 is 20 minutes after it and takes the step");
});


test("only the release's own programs and units count: another project's freeze of the same version number, another release's install, or any unit called scenarios do not", () => {
  const now = T0 + 60 * MIN, procs = [
    { startedAt: now - 5 * MIN, args: "node /x/release/freeze.mjs someone/other 2.0.0-beta.31 --commit c" },
    { startedAt: now - 5 * MIN, args: `node /x/release/stage-server.mjs o/r 2.0.0-beta.31 --release godspeed-2.0.0-beta.31-other` },
    { startedAt: now - 5 * MIN, args: `node /x/release/staging-check.mjs o/r 2.0.0-beta.31 --release ${ID} --tell` }];
  assert.deepEqual(workFor({ id: ID, activity: { runs: [], procs }, about: true, now, repo: "o/r" }).map(w => w.what), ["the release step's staging-check program"]);
  const own = { id: ID, repo: "o/r", version: "2.0.0-beta.31" };
  assert.equal(ownedBy({ kind: "unit", id: "other-project-scenarios.service" }, own), false);
  assert.equal(ownedBy({ kind: "unit", id: "other-project-freeze-2.0.0-beta.31.service" }, own), false, "the same version number of another project");
  assert.equal(ownedBy({ kind: "unit", id: `freeze-${ID}.service` }, own), true, "one that names the release itself");
  assert.equal(ownedBy({ kind: "unit", id: "forge-step-stage.service" }, own), false);
});

test("a lost state file while a source cannot be read: the journal's state stands, never a new ladder; a part that can be read and changed is a change", () => {
  const whole = partsOf({ look: LOOK, autoStage: { blocked: {} }, staging: null });
  const journal = { fp: fpOf(whole), parts: whole, since: T0, steps: ["helper"], launches: [{ rung: 1, provider: "codex" }], tries: [] };
  // the look cannot be read now and the state file is gone: the journal's look stands
  const now = mergeParts({ look: null, stage: whole.stage, staging: whole.staging }, journal.parts);
  const r = tick(null, { fp: fpOf(now), work: [], now: T0 + 35 * MIN, lastRoundAt: T0 + 30 * MIN, journal });
  assert.deepEqual([r.clock.fp, Math.round(r.clock.stillMs / MIN), r.clock.done.helper, r.clock.rung1Provider], [journal.fp, 35, true, "codex"]);
  // the look cannot be read, but the staging record can, and it changed: that is a change, whatever the look says
  const moved = mergeParts({ look: null, stage: whole.stage, staging: partsOf({ staging: { status: "staged" } }).staging }, journal.parts);
  assert.notEqual(fpOf(moved), journal.fp);
  assert.equal(tick(null, { fp: fpOf(moved), work: [], now: T0 + 35 * MIN, lastRoundAt: T0 + 30 * MIN, journal }).clock.done.helper, undefined, "a new ladder");
});

test("the release's files are read each on its own: a corrupt auto-stage state never hides the staging record", async () => {
  const { readReleaseFiles } = await import("../driver.mjs");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clock-files-"));
  fs.writeFileSync(path.join(dir, "state.json"), "{ corrupt");
  fs.mkdirSync(path.join(dir, "releases", ID), { recursive: true });
  fs.writeFileSync(path.join(dir, "releases", ID, "staging.json"), JSON.stringify({ status: "staged" }));
  const r = readReleaseFiles({ AUTO_STAGE_STATE: path.join(dir, "state.json"), RELEASES_DIR: path.join(dir, "releases") }, ID);
  assert.deepEqual([r.autoStage, r.staging, !!(r.unread && r.unread.stage), !!(r.unread && r.unread.staging)], [null, { status: "staged" }, true, false]);
});

