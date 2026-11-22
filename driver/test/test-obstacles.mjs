import { TEST_ENV } from "./env.mjs";
import test from "./harness.mjs";
import assert from "node:assert/strict";
import { findObstacles, obstacleId } from "../obstacles.mjs";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const H = h => new Date(NOW - h * 3600000).toISOString();
const M = m => new Date(NOW - m * 60000).toISOString();
const pr = (o = {}) => ({ number: 5, state: "open", merged: false, labels: [], requiredState: "pending", requiredSince: M(5), lastCommitAt: H(9), comments: [], ...o });
const item = (o = {}) => ({ number: 10, state: "open", labels: [], closedAt: null, comments: [], prs: [pr()], partial: false, ...o });
const world = (it = {}, extra = {}) => ({
  at: new Date(NOW).toISOString(), releases: [{ id: "rel", tickets: [{ item: 1, issue: 10, size: "m" }] }], items: { 10: item(it) },
  board: { openNeedsOwner: [] }, main: { sha: "m", required: "success", since: H(1) }, factory: { lastDecisions: [], activeRuns: [] }, unreadable: [],
  server: { failedUnits: [], diskPct: 50, memAvailPct: 80, staleProcs: [], logins: { gh: true, codex: "Logged in using ChatGPT", claude: "unknown" } }, staging: {}, ...extra,
});
const ledger = (hAgo = 1) => ({ "rel#1": { firstSeenAt: H(hAgo), lastMilestoneAt: H(hAgo), milestones: [], lastActivityAt: null } });
const kinds = os => os.map(o => o.kind);

test("a healthy world has no obstacles", () => assert.deepEqual(findObstacles(world(), ledger(), NOW), []));

test("parked: needs-owner on the issue or on its PR, immediately", () => {
  const a = findObstacles(world({ labels: ["needs-owner"] }), ledger(0.1), NOW);
  assert.deepEqual(kinds(a), ["parked"]);
  assert.equal(a[0].ticketKey, "rel#1");
  assert.equal(a[0].issue, 10);
  const b = findObstacles(world({ prs: [pr({ labels: ["needs-owner"] })] }), ledger(0.1), NOW);
  assert.deepEqual(kinds(b), ["parked"]);
  assert.equal(b[0].pr, 5);
});

test("check-failed: required red for 20 minutes and no running lap", () => {
  const red = m => world({ prs: [pr({ requiredState: "failure", requiredSince: M(m) })] });
  assert.deepEqual(kinds(findObstacles(red(10), ledger(), NOW)), []);
  assert.deepEqual(kinds(findObstacles(red(25), ledger(), NOW)), ["check-failed"]);
  const working = red(25);
  working.items[10].comments = [{ author: "x", body: "b", at: M(5) }];
  assert.deepEqual(kinds(findObstacles(working, ledger(), NOW)), []);
});

test("no-progress: by size, and not when working", () => {
  assert.deepEqual(kinds(findObstacles(world(), ledger(7), NOW)), []);
  const o = findObstacles(world(), ledger(9), NOW);
  assert.deepEqual(kinds(o), ["no-progress"]);
  assert.equal(o[0].since, H(9));
  const l = world();
  l.releases[0].tickets[0].size = "l";
  assert.deepEqual(kinds(findObstacles(l, ledger(9), NOW)), []);
  const s = world();
  s.releases[0].tickets[0].size = "s";
  assert.deepEqual(kinds(findObstacles(s, ledger(5), NOW)), ["no-progress"]);
  const w = world({ comments: [{ author: "x", body: "b", at: M(10) }] });
  assert.deepEqual(kinds(findObstacles(w, ledger(9), NOW)), []);
});

test("a ticket whose issue is closed with a merged PR is never an obstacle", () => {
  const w = world({ state: "closed", labels: ["needs-owner"], prs: [pr({ state: "closed", merged: true, requiredState: "failure", requiredSince: H(5) })] });
  assert.deepEqual(findObstacles(w, ledger(20), NOW), []);
});

test("an unreadable part is an obstacle and never produces no-progress for the tickets it covers", () => {
  const w = world({ partial: true });
  w.unreadable = [{ part: "issue#10/prs", error: "HTTP 502" }];
  assert.deepEqual(kinds(findObstacles(w, ledger(30), NOW)), ["unreadable"]);
  const gone = world();
  gone.items = {};
  gone.unreadable = [{ part: "issue#10", error: "HTTP 502" }];
  assert.deepEqual(kinds(findObstacles(gone, ledger(30), NOW)), ["unreadable"]);
});

test("factory-idle: three idle decisions while needs-owner items wait", () => {
  const d = text => ({ at: H(1), text });
  const idle = [d("No launch: workable nothing; 1 lap(s) active"), d("No launch: found nothing to start"), d("No launch: workable nothing")];
  assert.deepEqual(kinds(findObstacles(world({}, { factory: { lastDecisions: idle, activeRuns: [] }, board: { openNeedsOwner: [10] } }), ledger(), NOW)), ["factory-idle"]);
  assert.deepEqual(kinds(findObstacles(world({}, { factory: { lastDecisions: idle, activeRuns: [] } }), ledger(), NOW)), []);
  const mixed = [...idle.slice(0, 2), d("Launch: archon-loop")];
  assert.deepEqual(kinds(findObstacles(world({}, { factory: { lastDecisions: mixed, activeRuns: [] }, board: { openNeedsOwner: [10] } }), ledger(), NOW)), []);
});

test("main-red", () => {
  const o = findObstacles(world({}, { main: { sha: "abc", required: "failure", since: H(2) } }), ledger(), NOW);
  assert.deepEqual(kinds(o), ["main-red"]);
  assert.equal(o[0].since, H(2));
});

test("machine kinds: unit, disk, memory, stale process, login", () => {
  const server = { failedUnits: ["x.service"], diskPct: 93, memAvailPct: 4, staleProcs: [{ pid: 77, user: "g", ageMin: 400, cmd: "chromium" }], logins: { gh: false, codex: "Not logged in", claude: "unknown" } };
  const o = findObstacles(world({}, { server }), ledger(), NOW);
  assert.deepEqual(kinds(o).sort(), ["disk", "login", "login", "memory", "stale-process", "unit-failed"]);
});

test("no-ai comes from cfg and keeps its start time", () => {
  const o = findObstacles(world(), ledger(), NOW, { noAi: { since: H(7), evidence: "all providers returned 429" } });
  assert.deepEqual(kinds(o), ["no-ai"]);
  assert.equal(o[0].since, H(7));
});

test("ids are stable across rounds and cfg.firstSeen fixes since", () => {
  const w = world({ labels: ["needs-owner"] });
  const a = findObstacles(w, ledger(), NOW)[0], b = findObstacles(w, ledger(), NOW + 600000)[0];
  assert.equal(a.id, b.id);
  assert.equal(a.id, obstacleId("parked", "rel#1"));
  assert.match(a.id, /^[0-9a-f]{10}$/);
  assert.equal(findObstacles(w, ledger(), NOW, { firstSeen: { [a.id]: H(3) } })[0].since, H(3));
});

// ---------------------------------------------------------------- Task 8
test("a ticket a scope amendment moved to the next release is never driven for this one", () => {
  const w = world({ labels: ["needs-owner"] });
  w.releases[0].tickets[0].deferred = true;
  assert.deepEqual(findObstacles(w, ledger(30), NOW), []);
});

test("dead-end: an issue closed as not planned, or closed an hour with no change linked, leaves under the plan's rule", () => {
  const notPlanned = findObstacles(world({ state: "closed", stateReason: "not_planned", closedAt: M(5), prs: [] }), ledger(), NOW);
  assert.deepEqual(kinds(notPlanned), ["dead-end"]);
  assert.equal(notPlanned[0].issue, 10);
  assert.deepEqual(kinds(findObstacles(world({ state: "closed", stateReason: "completed", closedAt: H(2), prs: [] }), ledger(), NOW)), ["dead-end"]);
  assert.deepEqual(kinds(findObstacles(world({ state: "closed", stateReason: "completed", closedAt: M(20), prs: [] }), ledger(), NOW)), [], "just closed: its change may still be linking");
  assert.deepEqual(kinds(findObstacles(world({ state: "closed", stateReason: "completed", closedAt: H(2), prs: [], partial: true }), ledger(), NOW)), [], "missing data: conclude nothing");
  assert.deepEqual(kinds(findObstacles(world({ state: "closed", stateReason: "completed", closedAt: H(2), prs: [pr({ state: "open" })] }), ledger(), NOW)), [], "an open change is still on its way");
  // seen live on 2026-11-18: #679 was closed by #714, which only mentions it; a finished item is never cut
  assert.deepEqual(findObstacles(world({ state: "closed", stateReason: "completed", closedAt: H(16), prs: [], mergedRefs: [714] }), ledger(), NOW), []);
});

const factory = (o = {}) => ({ project: "godspeed-mission-control", primary: true, repo: "MichaelZelbel/godspeed-mission-control", checkout: "/home/godspeed-forge/godspeed-mission-control", lastDecisions: [], activeRuns: [], board: [], stop: null, ...o });
const idleDecisions = [{ at: H(1), text: "No launch: workable nothing" }, { at: M(30), text: "No launch: workable nothing" }, { at: M(5), text: "No launch: found nothing to start" }];

test("factory-idle is judged per project, each with its own board", () => {
  const w = world({}, { factories: [factory({ lastDecisions: idleDecisions, board: [] }), factory({ project: "querino", primary: false, repo: "MichaelZelbel/querino", lastDecisions: idleDecisions, board: [7, 8] })] });
  const o = findObstacles(w, ledger(), NOW);
  assert.deepEqual(kinds(o), ["factory-idle"]);
  assert.equal(o[0].project, "querino");
  assert.equal(o[0].repo, "MichaelZelbel/querino");
  assert.deepEqual(o[0].board, [7, 8]);
  assert.equal(o[0].id, obstacleId("factory-idle", "factory:querino"));
  const main = findObstacles(world({}, { factories: [factory({ lastDecisions: idleDecisions, board: [10] })] }), ledger(), NOW);
  assert.equal(main[0].id, obstacleId("factory-idle", "factory"), "the main project keeps its id");
});

test("a project with a lap running is not idle, whatever the scheduler says about launching (seen live 2026-11-18)", () => {
  // the live diagnosis: "workable nothing; 1 lap(s) active" while that lap worked on PR #727
  const said = n => [1, 2, 3].map(i => ({ at: M(30 - i), text: `No launch: workable nothing; ${n} lap(s) active, 0 still choosing.` }));
  assert.deepEqual(findObstacles(world({}, { factories: [factory({ lastDecisions: said(1), board: [10] })] }), ledger(), NOW), []);
  assert.deepEqual(findObstacles(world({}, { factories: [factory({ lastDecisions: said(0), board: [10], activeRuns: [{ id: "r1", workflow: "archon-loop" }] })] }), ledger(), NOW), [], "an active loop run");
  assert.deepEqual(kinds(findObstacles(world({}, { factories: [factory({ lastDecisions: said(0), board: [10], activeRuns: [{ id: "m1", workflow: "archon-manager" }] })] }), ledger(), NOW)), ["factory-idle"], "a manager run is not a lap");
});

test("factory-stopped: legit while its writer lives and the candidate's scenarios run, for at most 4 hours", () => {
  const stop = (o = {}) => world({}, { factories: [factory({ stop: { file: "/home/godspeed-forge/godspeed-mission-control/.factory/STOP", kind: "STOP", line: "auto-stage 9 x", writer: "auto-stage", pid: 9, at: H(1), writerAlive: true, scenariosRunning: true, ...o } })] });
  assert.deepEqual(findObstacles(stop(), ledger(), NOW), []);
  assert.deepEqual(kinds(findObstacles(stop({ at: H(5) }), ledger(), NOW)), ["factory-stopped"], "over the cap");
  assert.deepEqual(kinds(findObstacles(stop({ writerAlive: false, scenariosRunning: false }), ledger(), NOW)), ["factory-stopped"]);
  assert.deepEqual(kinds(findObstacles(stop({ scenariosRunning: false }), ledger(), NOW)), ["factory-stopped"]);
  assert.deepEqual(findObstacles(stop({ scenariosRunning: null }), ledger(), NOW), [], "unknown: the unreadable obstacle says so, nothing is concluded");
  const o = findObstacles(stop({ writerAlive: false, scenariosRunning: false }), ledger(), NOW)[0];
  assert.equal(o.project, "godspeed-mission-control");
  assert.equal(o.since, H(1));
});

test("factory-restarts: the factory user's manager started more than twice in 30 minutes", () => {
  const base = { failedUnits: [], diskPct: 50, memAvailPct: 80, staleProcs: [], logins: { gh: true } };
  assert.deepEqual(findObstacles(world({}, { server: { ...base, userManagerStarts: 2 } }), ledger(), NOW), []);
  assert.deepEqual(kinds(findObstacles(world({}, { server: { ...base, userManagerStarts: 3 } }), ledger(), NOW)), ["factory-restarts"]);
});

test("factory-stopped: a project's timer that is not active for two rounds while the network guard is not running", () => {
  const w = (guardRunning = false) => world({}, { factories: [factory({ timers: { "archonfactory-godspeed-mission-control.timer": "inactive", "archonfactory-godspeed-mission-control-manager.timer": "active" } })],
    server: { failedUnits: [], diskPct: 50, memAvailPct: 80, staleProcs: [], guardRunning, logins: { gh: true } } });
  assert.deepEqual(findObstacles(w(), ledger(), NOW, { timerRounds: { "archonfactory-godspeed-mission-control.timer": 1 } }), [], "one round can be the guard's own pause");
  const o = findObstacles(w(), ledger(), NOW, { timerRounds: { "archonfactory-godspeed-mission-control.timer": 2 } });
  assert.deepEqual(kinds(o), ["factory-stopped"]);
  assert.equal(o[0].timer, "archonfactory-godspeed-mission-control.timer");
  assert.equal(o[0].id, obstacleId("factory-stopped", "timer:archonfactory-godspeed-mission-control.timer"));
  assert.deepEqual(findObstacles(w(true), ledger(), NOW, { timerRounds: { "archonfactory-godspeed-mission-control.timer": 5 } }), [], "the guard is deciding right now");
});

test("tools-missing: a hidden check without a tool that runs is one obstacle naming each, never concluded from no reading", () => {
  const tools = { scenarios: 39, missing: [{ id: "H-12", why: "H-12 has no tool" }, { id: "H-35", why: "H-35 has no tool: its command names /t/H-35/run.sh, which is not there" }] };
  const os = findObstacles(world({}, { tools }), ledger(), NOW);
  assert.deepEqual(kinds(os), ["tools-missing"]);
  assert.equal(os[0].id, obstacleId("tools-missing", "tools:H-12,H-35"));
  // the id names the missing checks: a new episode (H-41 to H-43 at 19:07) never inherits an old one's attempts
  const again = findObstacles(world({}, { tools: { scenarios: 43, missing: [{ id: "H-43", why: "H-43 has no tool" }, { id: "H-41", why: "H-41 has no tool" }] } }), ledger(), NOW);
  assert.equal(again[0].id, obstacleId("tools-missing", "tools:H-41,H-43"), "sorted, so the order they are read in does not matter");
  assert.notEqual(again[0].id, os[0].id);
  assert.match(os[0].evidence.join("\n"), /H-12 has no tool/);
  assert.match(os[0].evidence.join("\n"), /H-35 has no tool: its command names/);
  assert.deepEqual(findObstacles(world({}, { tools: { scenarios: 39, missing: [] } }), ledger(), NOW), [], "every check has its tool");
  assert.deepEqual(findObstacles(world({}, { tools: null }), ledger(), NOW), [], "no reading: nothing concluded (the unreadable part says so itself)");
});

test("a PAUSE never raises factory-stopped (the pause entry covers it); a STOP still does", () => {
  const mk = kind => world({}, { factories: [factory({ stop: { file: `/home/godspeed-forge/godspeed-mission-control/.factory/${kind}`, kind, line: "consumer.py 4242 2026-11-21T23:33:00Z", writer: "consumer.py", pid: 4242, at: "2026-11-21T23:33:00.000Z", writerAlive: false, scenariosRunning: false }, activeRuns: [] })] });
  assert.equal(findObstacles(mk("PAUSE"), {}, Date.parse("2026-11-22T10:00:00Z")).filter(o => o.kind === "factory-stopped").length, 0);
  assert.equal(findObstacles(mk("STOP"), {}, Date.parse("2026-11-22T10:00:00Z")).filter(o => o.kind === "factory-stopped").length, 1);
});
