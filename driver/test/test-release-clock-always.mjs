// The Forge 0.3.3 (release first, #171): ONE release clock from approval to install, with no phase where it is off. Every standstill
// in the record is replayed through whole rounds of the driver (every five minutes) and must reach the repair program within 60
// minutes: an acting run by 20, the other AI by 40, the repair request and one notice by 60. The clock measures progress (a ticket
// closed, a pull request given a commit or a comment, the stage step's look or state, the staging record), never activity: a live
// claim or an active run holds it only while the run is still writing, and for at most its own limit.
import { TEST_ENV } from "./env.mjs";
// The Forge 0.3.1, ticket 01 (#140, its second comment): a release never stands still for an hour. Whole rounds of the driver,
// every five minutes, against Godspeed 2.0.0-beta.31 as it stood on 2026-11-23: every ticket done, the release step saying the
// same waiting sentence, and one acting run answering "in-progress" naming nothing anybody could check.
import { test } from "./harness.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { round, describe, driverDefaults } from "../driver.mjs";

const T0 = Date.parse("2026-11-23T21:00:00Z"), MIN = 60000;
const REPO = "MichaelZelbel/godspeed-mission-control";
const ID = "godspeed-2.0.0-beta.31-unstuck";
const PLAN = `---\nrelease: ${ID}\nrepository: ${REPO}\n---\nStatus: approved by Michael on 2026-11-23\n\n# Godspeed 2.0.0-beta.31: unstuck\n\nIssues: item 1 #783, 2 #784\n\nThe plan's rule: an item that reaches a dead end leaves the release, the rest ships.\n`;
const LOOK = `Release ${ID} (2.0.0-beta.31): approved, newer than the public version, and not on the server yet.\nWaiting for the factory driver to move item 1 to the next release under the plan's rule.\nResult: waiting.\n`;
const LIE = "The factory driver is actively running the requested repair for the release's already-delivered first item.\n\nRESULT: in-progress"; // beta.31's rung 1, word for word
const iso = ms => new Date(ms).toISOString();

// The world as the driver read it then: both tickets closed with their change on main, nothing parked, a healthy server.
function world(now) {
  const merged = n => ({ number: n, state: "closed", merged: true, mergedAt: iso(T0 - 26 * 60 * MIN), mergeSha: String(n).repeat(10).slice(0, 40).padEnd(40, "a"), base: "main", labels: [], comments: [], requiredState: "success", requiredSince: iso(T0 - 27 * 60 * MIN) });
  return { at: iso(now), releases: [{ id: ID, version: "2.0.0-beta.31", label: "beta.31", repo: REPO, plan: PLAN, tickets: [{ file: "01-already-there.md", item: 1, issue: 783, title: "already there", size: "m" }, { file: "02-b.md", item: 2, issue: 784, title: "b", size: "m" }], excluded: [] }],
    superseded: [], installed: null,
    items: { 783: { number: 783, state: "closed", stateReason: "completed", closedAt: iso(T0 - 24 * 60 * MIN), labels: [], prs: [], mergedRefs: [876], comments: [], partial: false },
      784: { number: 784, state: "closed", stateReason: "completed", closedAt: iso(T0 - 25 * 60 * MIN), labels: [], prs: [merged(880)], mergedRefs: [], comments: [], partial: false } },
    board: { openNeedsOwner: [] }, main: { sha: "m".repeat(40), required: "success", since: iso(T0 - 60 * MIN) }, factories: [], factory: { lastDecisions: [], activeRuns: [] },
    server: { failedUnits: [], anonymousFailedUnits: [], diskPct: 40, memAvailPct: 60, staleProcs: [], userManagerStarts: 0, guardRunning: false, logins: { gh: true, codex: "Logged in using ChatGPT", claude: "Logged in" } },
    tools: null, staging: { [ID]: null }, unreadable: [], queue: [], answeredElsewhere: {}, toMichael: {}, openPrs: [] };
}

// A server's worth of stand-ins: the clock of the test, the AIs' answers, the spool, the dead-man and the transports.
function server({ look = () => LOOK, answers = {}, named = () => false, worldAt = null, runsAt = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-clock-"));
  const env = { ...driverDefaults(TEST_ENV, []), STATE_DIR: path.join(root, "state"), QUESTIONS_DIR: path.join(root, "questions"), NOTICES_FILE: path.join(root, "notices.json"), REPO };
  let now = T0;
  const s = { root, env, launched: [], requests: [], deadman: [], told: [], at: () => (now - T0) / MIN };
  s.deps = {
    now: () => now, log: () => {}, mono: () => ({ uptime: NaN, boot: "" }), refreshTokens: () => [],
    readWorld: async () => (worldAt ? worldAt(now, (now - T0) / MIN) : world(now)), stageLook: async () => look((now - T0) / MIN), releaseFiles: () => ({ autoStage: { blocked: {} }, staging: null }),
    // work near the release that is not the release's: main's own checks, another project's candidate
    activity: async () => ({ runs: [...(runsAt ? runsAt(now, (now - T0) / MIN) : []), { headBranch: "main", headSha: "m", createdAt: iso(now - 4 * MIN), name: "required" }, { headBranch: "candidate/0.3.0", headSha: "f", createdAt: iso(now - 4 * MIN), name: "scenarios" }], stop: null, procs: [{ startedAt: now - 2 * MIN, args: "node /x/release/auto-stage.mjs" }] }),
    providers: async () => [{ name: "codex", model: "gpt-5.6-terra", strong: "gpt-5.6-sol" }, { name: "claude", model: "claude-sonnet-5-5", strong: "claude-opus-5-5" }],
    launchAct: (e, a, o) => { s.launched.push({ minute: s.at(), unit: o.unit, entry: o.entry.id, provider: o.provider, tried: o.tried, evidence: o.entry.evidence }); },
    // each acting run answers five minutes after its launch with what the test says for its launch number, else it runs on
    actResult: (e, a, unit) => { const l = s.launched.find(x => x.unit === unit); const n = s.launched.indexOf(l) + 1; const said = answers[n]; return said && s.at() >= l.minute + 5 ? { state: "done", result: /RESULT:\s*(\S+)\s*$/.exec(said)[1], said, provider: l.provider } : { state: "running" }; },
    // GitHub's answer about a named run: the candidate's run is the release's own (its branch), any other is not
    checkNamed: list => list.map(n => ({ ...n, running: named(n, s.at()), ...(n.kind === "run" ? { headBranch: n.id === "123456789" ? "candidate/2.0.0-beta.31" : "main", headSha: "x" } : {}) })),
    planApproved: () => true,
    repairRequest: words => { s.requests.push({ minute: s.at(), words }); return path.join(root, "spool", `repair-${now}.json`); },
    startDeadman: () => { s.deadman.push(s.at()); },
    deliver: { telegram: async text => { s.told.push({ minute: s.at(), text }); return { ok: true, receipt: "42" }; }, issue: () => ({ ok: true, receipt: "https://github.com/o/w/issues/1" }) },
    gateCfg: { reads: 3, gapMs: 10 * MIN, toleranceMs: 0 }, recheck: async ids => new Set(ids),
    rung0: async () => [], watcherHealth: () => ({ ok: true }), mirroredHead: () => "", publishHeartbeat: () => {}, clockCheck: () => ({ ok: true, ghNow: NaN, skewMs: NaN }), supersession: () => ({ leave: [], bad: [] }), nextRelease: async () => null,
    verifyInstalled: () => ({ ok: false, why: "test" }), seenCheck: () => ({ seen: false }), rescues: async () => {}, causes: async () => {}, approvals: async () => ({}), pauses: () => [], expireLocks: () => [], fallbacks: async () => [],
    launchHelper: async () => ({}), helperResult: () => ({ state: "running" }), check: () => ({ out: { approve: true }, trouble: "" }), ownerIssue: 600,
    hkDeps: { run: () => ({ status: 0, stdout: "", stderr: "" }), sleep: async () => {} },
  };
  s.round = async minute => { now = T0 + minute * MIN; return round(s.env, s.deps); };
  s.state = () => JSON.parse(fs.readFileSync(path.join(env.STATE_DIR, "state.json"), "utf8"));
  s.log = () => fs.readFileSync(path.join(env.STATE_DIR, "decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  return s;
}
const byClock = s => s.launched.filter(l => l.entry === `standstill:${ID}`);

// ---- the record: each standstill as the driver read it. Rounds every five minutes; steps in the round before the minute.
const ID32 = "godspeed-2.0.0-beta.32-clear-first-day";
const LOOK32 = `Release ${ID32} (2.0.0-beta.32): approved, newer than the public version, and not on the server yet.\nNot complete yet: waiting on #616.\nResult: waiting.\n`;
const withRelease = (w, id, version, count) => ({ ...w, releases: [{ ...w.releases[0], id, version, label: version.replace(/^2\.0\.0-/, ""), tickets: Array.from({ length: count }, (_, i) => ({ file: `0${i + 1}-t.md`, item: i + 1, issue: 609 + i, title: `t${i + 1}`, size: "m" })) }], items: {} });
// beta.32 on 2026-11-24: seven of eight tickets closed with their change on main, #616 open and workable, nobody building it; the
// factory's laps are busy with other items (#932, #1005: not in the release). o: claim (a live claim on #616 by this run), prHead, silentFrom
function world32(now, minute, o = {}) {
  const w = withRelease(world(now), ID32, "2.0.0-beta.32", 8);
  for (let n = 609; n <= 615; n++) w.items[n] = { number: n, state: "closed", stateReason: "completed", closedAt: iso(T0 - 3 * 60 * MIN), labels: ["bug", "priority", "beta.32"], prs: [{ number: n + 300, state: "closed", merged: true, mergedAt: iso(T0 - 3 * 60 * MIN), mergeSha: String(n).padEnd(40, "a"), base: "main", labels: [], comments: [], requiredState: "success", requiredSince: iso(T0 - 3 * 60 * MIN) }], mergedRefs: [], comments: [], loopClaims: [], partial: false };
  const claims = o.claim ? [{ run: o.claim, at: iso(T0 + 1 * MIN) }] : [];
  w.items[616] = { number: 616, state: "open", labels: ["bug", "priority", "beta.32"], prs: o.prHead ? [{ number: 950, state: "open", merged: false, labels: [], headSha: o.prHead(minute), comments: [], requiredState: "none" }] : [], mergedRefs: [], comments: [], loopClaims: claims, partial: false };
  const silentFrom = o.silentFrom == null ? Infinity : o.silentFrom;
  w.factory = { lastDecisions: [], activeRuns: [{ id: "lap-932", workflow: "archon-loop", startedAt: iso(now - 20 * MIN), lastOutputAt: iso(now - 1 * MIN) }, ...(o.claim ? [{ id: o.claim, workflow: "archon-loop", startedAt: iso(T0), lastOutputAt: iso(T0 + Math.min(minute, silentFrom) * MIN) }] : [])] };
  w.main = { sha: "m".repeat(40), required: "success", since: iso(T0 - 60 * MIN) };
  w.staging = { [ID32]: null };
  return w;
}
const HEAD = (id, v) => `Release ${id} (${v}): approved, newer than the public version, and not on the server yet.\n`;
const HALT = (id, v) => `${HEAD(id, v)}Halted at 2026-11-22T10:00:00Z: the test machine's step is repair-halted. Nothing more is done automatically until the halt is cleared.\nResult: halted.\n`;
const WAIT = (id, v, why) => `${HEAD(id, v)}Waiting: ${why}.\nResult: waiting.\n`;
const RECORD = [
  ["beta.31: the stage step waits on an already-delivered ticket", { look: () => LOOK }, ID],
  ["beta.32: the last ticket is workable and nobody picks it", { worldAt: (now, m) => world32(now, m), look: () => LOOK32 }, ID32],
  ["the test machine's own halt (repair-halted since 2026-11-22), tickets all done", { look: () => HALT(ID, "2.0.0-beta.31") }, ID],
  ["the test machine's own halt while a ticket is still being built", { worldAt: (now, m) => world32(now, m), look: () => HALT(ID32, "2.0.0-beta.32") }, ID32],
  ["beta.25: a red main keeps the freeze from starting", { worldAt: now => ({ ...world(now), main: { sha: "m".repeat(40), required: "failure", since: iso(T0 - 5 * 60 * MIN) } }), look: () => WAIT(ID, "2.0.0-beta.31", "main's required check is red") }, ID],
  ["beta.25: the version pull request never merges, so the freeze waits", { look: () => WAIT(ID, "2.0.0-beta.31", "the version pull request is open and its checks have not passed") }, ID],
  ["beta.25: the scenarios failed and the failed jobs are never run again", { look: () => WAIT(ID, "2.0.0-beta.31", "the candidate's scenarios ended and the failed jobs are not run again") }, ID],
];
for (const [name, opts, id] of RECORD) {
  test(`one clock, no phase off: ${name}: an acting run by minute 20, the other AI by 40, the repair program and one notice by 60`, async () => {
    const s = server({ ...opts, answers: {} });
    for (let m = 0; m <= 70; m += 5) await s.round(m);
    const runs = s.launched.filter(l => l.entry === `standstill:${id}`);
    assert.deepEqual(runs.slice(0, 2).map(l => l.minute), [15, 35], "rung 1 in the round before minute 20, rung 2 before minute 40");
    assert.equal(s.requests.length, 1, "one repair request");
    assert.ok(s.requests[0].minute <= 60, `by minute 60 (at ${s.requests[0].minute})`);
    assert.equal(s.deadman.length, 1, "the dead-man started at once");
    const told = s.told.filter(t => /has not moved for about an hour/.test(t.text));
    assert.equal(told.length, 1, "one notice");
    assert.ok(told[0].minute <= 60);
  });
}

test("beta.32 tonight: a lap that is writing to the last ticket's claim holds the clock; a silent one releases it after half an hour", async () => {
  const live = server({ worldAt: (now, m) => world32(now, m, { claim: "run-616" }), look: () => LOOK32 });
  for (let m = 0; m <= 180; m += 5) await live.round(m);
  assert.deepEqual(live.launched.filter(l => l.entry === `standstill:${ID32}`), [], "a lap building the last ticket and still writing: nothing escalates for three hours");
  const silent = server({ worldAt: (now, m) => world32(now, m, { claim: "run-616", silentFrom: 60 }), look: () => LOOK32 });
  for (let m = 0; m <= 180; m += 5) await silent.round(m);
  const first = silent.launched.find(l => l.entry === `standstill:${ID32}`);
  assert.ok(first && first.minute >= 90 && first.minute <= 110, `silent from minute 60: held until 90, then the 20 minutes count (first step at ${first && first.minute})`);
});

test("beta.32 tonight: a new commit on the last ticket's pull request is progress and starts the count again", async () => {
  const s = server({ worldAt: (now, m) => world32(now, m, { prHead: min => (min >= 30 ? "b".repeat(40) : "a".repeat(40)) }), look: () => LOOK32 });
  for (let m = 0; m <= 75; m += 5) await s.round(m);
  assert.deepEqual(s.launched.filter(l => l.entry === `standstill:${ID32}`).map(l => l.minute), [15, 40, 60], "rung 1 at 15; the commit at 30 (counted from the round at 25) starts the ladder again: rung 1 at 40, rung 2 at 60");
});

test("a release that is staged and announced waits for the owner's go: the one phase with no clock", async () => {
  const s = server({ look: () => `${HEAD(ID, "2.0.0-beta.31")}Already staged and announced at 2026-11-23T20:00:00Z; nothing to do.\n` });
  for (let m = 0; m <= 180; m += 5) await s.round(m);
  assert.deepEqual(s.launched, []);
  assert.deepEqual(s.requests, []);
});

test("a release whose every unfinished ticket waits on the owner's answer is the questions path's, not the clock's", async () => {
  const s = server({ worldAt: (now, m) => { const w = world32(now, m); w.items[616].labels = ["bug", "needs-owner"]; return w; }, look: () => LOOK32 });
  for (let m = 0; m <= 70; m += 5) await s.round(m);
  assert.deepEqual(s.launched.filter(l => l.entry === `standstill:${ID32}`), []);
});

test("the dry run says, for each release, where it is, the minutes without progress and what comes next", async () => {
  const s = server({ worldAt: (now, m) => world32(now, m), look: () => LOOK32 });
  for (let m = 0; m <= 25; m += 5) await s.round(m);
  const text = describe(await round({ ...s.env, DRY: true }, { ...s.deps, now: () => T0 + 30 * MIN }));
  assert.match(text, new RegExp(`release ${ID32}: the release clock: still for 30 minutes; next step: the other AI \\(rung 2\\) by minute 40.*where it is: 1 of 8 tickets unfinished \\(#616: open, no live claim and no run on it, no pull request\\)`));
});

test("the loop's claims on a ticket: a claim that was released or withdrawn is no claim, one in both comment windows counts once", async () => {
  const { loopClaimsOf } = await import("../world.mjs");
  const got = loopClaimsOf([
    { body: "Loop claim: run abc123\nArea: x", at: "2026-11-24T20:00:00Z" },
    { body: "Loop claim released", at: "2026-11-24T19:00:00Z" },
    { body: "Loop claim withdrawn", at: "2026-11-24T19:10:00Z" },
    { body: "Loop claim: run abc123\nArea: x", at: "2026-11-24T20:00:00Z" },
    { body: "Manager decision: start now", at: "2026-11-24T20:30:00Z" },
  ]);
  assert.deepEqual(got, [{ run: "abc123", at: "2026-11-24T20:00:00Z" }]);
});
