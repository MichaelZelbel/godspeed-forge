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

test("a release whose every unfinished ticket is parked under needs-owner is still a standstill: Mission Control answers the factory's questions at once, so the clock runs (beta.25's four parked tickets)", async () => {
  const s = server({ worldAt: (now, m) => { const w = world32(now, m); w.items[616].labels = ["bug", "needs-owner"]; return w; }, look: () => LOOK32 });
  for (let m = 0; m <= 70; m += 5) await s.round(m);
  const runs = s.launched.filter(l => l.entry === `standstill:${ID32}`);
  assert.deepEqual(runs.slice(0, 2).map(l => l.minute), [15, 35]);
  assert.equal(s.requests.length, 1);
  assert.match(s.requests[0].words, /parked \(needs-owner\)/, "the repair program is told the ticket is parked");
});

test("the one pause besides the go: a question of money, publishing or deleting, delivered to the owner (a receipt), that names the release", async () => {
  const page = { key: "x", heading: "Publish the announcement for #616?" };
  const named = server({ worldAt: (now, m) => ({ ...world32(now, m), deliveredPages: [page] }), look: () => LOOK32 });
  for (let m = 0; m <= 120; m += 5) await named.round(m);
  assert.deepEqual(named.launched, [], "the release waits on the owner for as long as the question waits");
  const other = server({ worldAt: (now, m) => ({ ...world32(now, m), deliveredPages: [{ key: "y", heading: "Delete the old photos of another project" }] }), look: () => LOOK32 });
  for (let m = 0; m <= 30; m += 5) await other.round(m);
  assert.ok(other.launched.length >= 1, "a question that names nothing of the release pauses nothing of it");
});

test("the delivered questions are read from the questions step's state, with the repository each belongs to: a page with a receipt, not answered and not closed", async () => {
  const { readDeliveredPages } = await import("../world.mjs");
  const told = { a: { heading: "Spend on #616", page: { stages: [{ channels: { telegram: { receipt: "42" } } }] } },
    b: { heading: "answered", answered: true, page: { stages: [{ channels: { telegram: { receipt: "43" } } }] } },
    c: { heading: "closed", page: { closed: { at: "x" }, stages: [{ channels: { telegram: { receipt: "44" } } }] } },
    d: { heading: "no receipt", page: { stages: [{ channels: { telegram: { why: "down" } } }] } },
    e: { heading: "decided at once" } };
  const states = { "state.json": { told }, "state-acme__other.json": { told: { z: { heading: "Publish #616", page: { stages: [{ channels: { issue: { receipt: "u" } } }] } } } } };
  const got = readDeliveredPages({ QUESTIONS_DIR: "/q", REPO: "acme/product" }, { readDir: () => Object.keys(states), readFile: p => JSON.stringify(states[p.split(/[\\/]/).pop()]) });
  assert.deepEqual(got, [{ key: "z", heading: "Publish #616", repo: "acme/other" }, { key: "a", heading: "Spend on #616", repo: "acme/product" }]);
});

test("a delivered question pauses a release only when it names one of its tickets as a whole number, in the release's own repository", async () => {
  const { pageNamesRelease } = await import("../standstill.mjs");
  const rel = { id: ID32, version: "2.0.0-beta.32", label: "beta.32", repo: REPO, tickets: [{ issue: 616 }, { issue: 609 }] };
  assert.equal(pageNamesRelease([{ key: "k", heading: "Publish #616?", repo: REPO }], rel), true);
  assert.equal(pageNamesRelease([{ key: "k", heading: "Publish #6160?", repo: REPO }], rel), false, "#6160 is not #616");
  assert.equal(pageNamesRelease([{ key: "k", heading: "Publish #616?", repo: "someone/else" }], rel), false, "another project's #616");
  assert.equal(pageNamesRelease([{ key: "k", heading: "Delete the data of beta.32 users?", repo: REPO }], rel), true, "the release named by its version");
});

test("a ticket that cannot be read keeps its last state, and a change in another ticket still counts as progress", async () => {
  const { buildingState } = await import("../standstill.mjs");
  const rel = { id: ID32, tickets: [{ issue: 615 }, { issue: 616 }] };
  const base = now => { const w = world32(now, 0); return w; };
  const w1 = base(T0);
  const first = buildingState({ release: { ...w1.releases[0], tickets: rel.tickets }, world: w1, now: T0 });
  const w2 = base(T0); w2.items[616] = { ...w2.items[616], partial: true, prs: [] }; // its pull request could not be read this round
  const same = buildingState({ release: { ...w2.releases[0], tickets: rel.tickets }, world: w2, now: T0 + 5 * MIN, prevTokens: first.tokens });
  assert.equal(same.fp, first.fp, "a read that failed is neither progress nor a standstill");
  const w3 = base(T0); w3.items[615] = { ...w3.items[615], state: "open" }; w3.items[616] = { ...w3.items[616], partial: true, prs: [] };
  const other = buildingState({ release: { ...w3.releases[0], tickets: rel.tickets }, world: w3, now: T0 + 10 * MIN, prevTokens: first.tokens });
  assert.notEqual(other.fp, first.fp, "but a visible change in the other ticket is progress, even while one cannot be read");
});

test("the minute-60 notice is held when a question that names the release reached the owner since the round began", async () => {
  let delivered = false;
  const s = server({ worldAt: (now, m) => ({ ...world32(now, m), deliveredPages: delivered ? [{ key: "p", heading: "Publish #616?", repo: REPO }] : [] }), look: () => LOOK32 });
  for (let m = 0; m <= 50; m += 5) await s.round(m);
  const before = s.told.length, readWorld0 = s.deps.readWorld; const calls = [];
  s.deps.readWorld = async (...a) => { calls.push(1); if (calls.length >= 2) delivered = true; return readWorld0(...a); };
  await s.round(55);
  assert.equal(s.told.length, before, "no notice: the release now waits on a question that reached the owner");
  assert.ok(s.log().some(e => e.kind === "message held" && /reached the owner/.test(e.why)));
});

test("a pause ends the clock for good: after the owner's go (or his question) the count starts fresh, it never counts the pause", async () => {
  const paused = m => m >= 25 && m < 105;
  const s = server({ look: m => (paused(m) ? `${HEAD(ID, "2.0.0-beta.31")}Already staged and announced at 2026-11-23T20:00:00Z; nothing to do.\n` : LOOK) });
  for (let m = 0; m <= 160; m += 5) await s.round(m);
  const runs = s.launched.filter(l => l.entry === `standstill:${ID}`).map(l => l.minute);
  assert.deepEqual(runs.filter(m => m < 25), [15], "rung 1 before the pause");
  assert.deepEqual(runs.filter(m => m >= 105), [115, 135], `a new ladder from the end of the pause, rung 1 then rung 2 twenty minutes apart, not every rung at once (steps at ${runs})`);
});

test("the last open ticket cannot be read for a round: it is still open, and the clock goes on", async () => {
  const s = server({ worldAt: (now, m) => { const w = world32(now, m); if (m >= 5) delete w.items[616]; return w; }, look: () => LOOK32 });
  for (let m = 0; m <= 40; m += 5) await s.round(m);
  assert.deepEqual(s.launched.filter(l => l.entry === `standstill:${ID32}`).map(l => l.minute), [15, 35], "an unreadable ticket is neither progress nor the end of the clock");
});

test("another project's runs reader failing does not make this release's writing lap stop holding it", async () => {
  const { buildingState } = await import("../standstill.mjs");
  const w = world32(T0 + 60 * MIN, 60, { claim: "run-616" });
  w.factories = [{ primary: true, project: "main", activeRuns: [{ id: "run-616", startedAt: iso(T0), lastOutputAt: iso(T0 + 59 * MIN) }] }];
  w.unreadable = [{ part: "factory/other/runs", error: "no CLI" }];
  const b = buildingState({ release: w.releases[0], world: w, now: T0 + 60 * MIN });
  assert.ok(b.work.some(x => /a run is building #616/.test(x.what)), "the lap is seen writing and holds the clock");
  w.unreadable = [{ part: "factory/main/runs", error: "no CLI" }];
  const c = buildingState({ release: w.releases[0], world: w, now: T0 + 60 * MIN });
  assert.ok(c.work.every(x => !/a run is building/.test(x.what)), "its own runs reader failing: no evidence of writing");
});

test("the minute-60 fresh read must confirm: a ticket that cannot be read in it holds the notice", async () => {
  let blind = false;
  const s = server({ worldAt: (now, m) => { const w = world32(now, m); if (blind) delete w.items[616]; return w; }, look: () => LOOK32 });
  for (let m = 0; m <= 50; m += 5) await s.round(m);
  const before = s.told.length, readWorld0 = s.deps.readWorld; const calls = [];
  s.deps.readWorld = async (...a) => { calls.push(1); if (calls.length >= 2) blind = true; return readWorld0(...a); };
  await s.round(55);
  assert.equal(s.told.length, before);
  assert.ok(s.log().some(e => e.kind === "message held" && /could not be read in the fresh read/.test(e.why)));
});

test("the state file is lost while the last open ticket cannot be read: the journal's tokens carry the clock on", async () => {
  const s = server({ worldAt: (now, m) => { const w = world32(now, m); if (m >= 10) delete w.items[616]; return w; }, look: () => LOOK32 });
  for (let m = 0; m <= 10; m += 5) await s.round(m);
  fs.unlinkSync(path.join(s.env.STATE_DIR, "state.json")); // the state file is gone; the journal is not
  for (let m = 15; m <= 40; m += 5) await s.round(m);
  assert.deepEqual(s.launched.filter(l => l.entry === `standstill:${ID32}`).map(l => l.minute), [15, 35], "the clock went on from the journal, as if nothing was lost");
});

test("the test machine's repair halt of 2026-11-22, built from the live record: a halt is a standstill, an acting run at once, the other AI by minute 40, the owner told by minute 60", async () => {
  const { advance } = await import("../inventory.mjs");
  // the halt as the AX41 held it (steps/test-machine/last.json, 2026-11-24): key and words as the step wrote them
  const halt = { key: "repair-halted", words: "The program that repairs the test machine for the releases stopped itself at 2026-11-22 23:30 UTC, because its AI did something it is never allowed to do (the repair's AI did something it may not do (changed the live verifier tools, the holdout scenarios or the factory's checkout))", clear: "node /usr/local/lib/godspeed-factory/driver/driver.mjs --step test-machine --clear-halt --settings-dir /etc/godspeed-forge" };
  const since = Date.parse("2026-11-22T23:30:00Z");
  const entry = { id: `halt:test-machine:${halt.key}`, kind: "halt", step: "test-machine", owner: null, title: "the test-machine step stopped itself (repair-halted)", milestoneAt: since, limitH: 0, evidence: [`the test-machine step stopped itself and reports, on every run while it holds: ${halt.words}`, `when it is put right, the step's own command ends the halt: ${halt.clear}`] };
  const t0 = since + 36 * 60 * MIN; // it has held for a day and a half when the new Forge first sees it
  let chain = {}, launches = [], told = null, pending = null;
  for (let m = 0; m <= 70; m += 5) {
    const t = t0 + m * MIN;
    if (pending && t >= pending.until) { pending.row.c.tries.push({ rung: pending.rung, result: "unresolved" }); pending = null; } // an acting run answers five minutes after its launch
    const a = advance([entry], chain, t);
    chain = a.chain;
    if (a.actions.launch) { const r = a.actions.launch; r.c.launched = true; r.c.launchedAt = t; launches.push({ minute: m, rung: r.rung }); pending = { row: r, rung: r.rung, until: t + 5 * MIN }; }
    if (a.actions.tell.length && told === null) { told = m; a.actions.tell[0].c.told = true; }
  }
  assert.deepEqual(launches.map(l => l.rung), [1, 2], "an acting run, then the other AI");
  assert.ok(launches[0].minute <= 20 && launches[1].minute <= 40, `by 20 and by 40 (at ${launches.map(l => l.minute)})`);
  assert.ok(told !== null && told <= 60, `the owner is told by minute 60 (at ${told})`);
});

test("what the owner sees: one line per release on the Forge's own page, rewritten every round", async () => {
  const { clockLine, writeClockPage } = await import("../clockpage.mjs");
  const building = { id: ID32, version: "2.0.0-beta.32", inStep: true, minutes: 4, where: "1 of 8 tickets unfinished (#616: open, being built)", next: { what: "an acting run (rung 1)", at: 20 }, held: ["a run is building #616 (claim by run r1)"] };
  assert.equal(clockLine(building), "Beta 32: 1 of 8 tickets unfinished (#616: open, being built); no progress for 4 minutes, held by a run is building #616 (claim by run r1); next: an acting run (rung 1) at minute 20.");
  const stuck = { ...building, minutes: 22, held: [], next: { what: "the other AI (rung 2)", at: 40 } };
  assert.match(clockLine(stuck), /^Beta 32: .*; no progress for 22 minutes; next: the other AI \(rung 2\) at minute 40\.$/);
  assert.equal(clockLine({ id: ID, version: "2.0.0-beta.31", inStep: false, why: "the release is staged and announced, and waits for the owner's go" }), "Beta 31: the release is staged and announced, and waits for the owner's go.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clockpage-"));
  assert.equal(writeClockPage(dir, [building, stuck], T0).written, true);
  assert.match(fs.readFileSync(path.join(dir, "release-clock.html"), "utf8"), /<li>Beta 32: 1 of 8 tickets unfinished/);
  assert.equal(fs.readFileSync(path.join(dir, "release-clock.txt"), "utf8").trim().split("\n").length, 2);
  assert.equal(writeClockPage(path.join(dir, "missing"), [building], T0).written, false, "no folder (the watching page is not set up): nothing written, nothing thrown");
  // and a whole round of the driver writes it through its own dependency
  const written = [];
  const s = server({ worldAt: (now, m) => world32(now, m), look: () => LOOK32 });
  s.deps.writeClockPage = (d, clocks) => written.push(clocks.map(clockLine));
  await s.round(0);
  assert.match(written[0][0], /^Beta 32: 1 of 8 tickets unfinished \(#616: open, no live claim and no run on it, no pull request\); no progress for 0 minutes; next: an acting run \(rung 1\) at minute 20\.$/);
});

test("the minute-60 gate also holds the repair request, and a run that began since the round's first read holds both", async () => {
  let ci = false;
  const s = server({ worldAt: (now, m) => world32(now, m, { prHead: () => "a".repeat(40) }), runsAt: (now) => (ci ? [{ headBranch: "fix", headSha: "a".repeat(40), createdAt: iso(now - 1 * MIN), name: "required" }] : []), look: () => LOOK32 });
  for (let m = 0; m <= 50; m += 5) await s.round(m);
  const before = { told: s.told.length, requests: s.requests.length };
  const act0 = s.deps.activity; const calls = [];
  s.deps.activity = async (...a) => { calls.push(1); if (calls.length >= 2) ci = true; return act0(...a); };
  await s.round(55);
  assert.equal(s.requests.length, before.requests, "no repair request while a ticket's checks run");
  assert.equal(s.told.length, before.told, "and no notice");
  assert.ok(s.log().some(e => e.kind === "message held" && /checkable runs now/.test(e.why)));
});

test("a question naming beta.31 does not pause beta.3; and an empty open list with an unreadable ticket still holds the notice", async () => {
  const { pageNamesRelease, buildingState } = await import("../standstill.mjs");
  assert.equal(pageNamesRelease([{ key: "k", heading: "Delete the data of beta.31 users?", repo: REPO }], { id: "godspeed-2.0.0-beta.3-x", label: "beta.3", version: "2.0.0-beta.3", repo: REPO, tickets: [] }), false);
  const w = world32(T0, 0); delete w.items[616]; for (let n = 609; n <= 615; n++) w.items[n].state = "closed";
  const b = buildingState({ release: w.releases[0], world: w, now: T0 });
  assert.ok(b && b.unread && b.open === 0, "the unreadable flag survives when no ticket is known to be open");
});

test("a halt's rungs end on their 20 minutes even while the acting run is still working (a run may use 55 minutes)", async () => {
  const { advance } = await import("../inventory.mjs");
  const entry = { id: "halt:test-machine:repair-halted", kind: "halt", step: "test-machine", owner: null, title: "halt", milestoneAt: T0 - 36 * 60 * MIN, limitH: 0, evidence: ["halted"] };
  let chain = {}, launches = [], told = null;
  for (let m = 0; m <= 70; m += 5) {
    const t = T0 + m * MIN, a = advance([entry], chain, t, { slotFree: launches.length === 0 }); // the first run still holds the one-at-a-time slot when rung 2 is due
    chain = a.chain;
    if (a.actions.launch) { a.actions.launch.c.launched = true; a.actions.launch.c.launchedAt = t; launches.push({ minute: m, rung: a.actions.launch.rung }); } // no run ever answers
    if (a.actions.tell.length && told === null) { told = m; a.actions.tell[0].c.told = true; }
  }
  assert.deepEqual(launches.map(l => l.rung), [1, 2]);
  assert.ok(launches[1].minute <= 40, `the other AI by 40 (at ${launches[1].minute})`);
  assert.ok(told !== null && told <= 60, `the owner told by 60 (at ${told})`);
});

test("GitHub's runs that cannot be read are not 'no runs': the fresh read holds the repair request and the notice", async () => {
  const { readActivity } = await import("../duties.mjs");
  const act = readActivity({ REPO }, { factories: [] }, (cmd, args) => (cmd === "gh" ? { status: 1, stdout: "", stderr: "rate limited" } : { status: 0, stdout: "" }), T0);
  assert.equal(act.unreadable, true);
  const ok = readActivity({ REPO }, { factories: [] }, (cmd) => (cmd === "gh" ? { status: 0, stdout: JSON.stringify({ workflow_runs: [] }) } : { status: 0, stdout: "" }), T0);
  assert.equal(ok.unreadable, undefined);
  let blind = false;
  const s = server({ worldAt: (now, m) => world32(now, m), look: () => LOOK32 });
  for (let m = 0; m <= 50; m += 5) await s.round(m);
  const before = { told: s.told.length, req: s.requests.length }, act0 = s.deps.activity; const calls = [];
  s.deps.activity = async (...a) => { calls.push(1); const r = await act0(...a); return calls.length >= 2 ? { ...r, unreadable: true } : r; };
  await s.round(55);
  assert.equal(s.requests.length, before.req); assert.equal(s.told.length, before.told);
  assert.ok(s.log().some(e => e.kind === "message held" && /runs could not be read/.test(e.why)));
});

test("a halt's rung that ended on the clock remembers which AI it ran on, so rung 2 is the other one", async () => {
  const { advance } = await import("../inventory.mjs");
  const entry = { id: "halt:test-machine:repair-halted", kind: "halt", step: "test-machine", owner: null, title: "halt", milestoneAt: T0 - 60 * MIN, limitH: 0, evidence: ["halted"] };
  let a = advance([entry], {}, T0);
  a.actions.launch.c.launched = true; a.actions.launch.c.launchedAt = T0; a.actions.launch.c.launchedProvider = "claude"; // rung 1 ran on Claude, still working
  a = advance([entry], a.chain, T0 + 21 * MIN, { slotFree: false });
  assert.equal(a.actions.launch.rung, 2);
  assert.deepEqual(a.actions.launch.c.tries.map(t => [t.rung, t.provider]), [[1, "claude"]], "the driver picks the other provider from this try");
});

test("the release is missing from a round's read (the records checkout could not be read): its tickets keep their states and the clock goes on", async () => {
  const s = server({ worldAt: (now, m) => { const w = world32(now, m); if (m >= 10) { w.releases = []; w.staging = {}; } return w; }, look: () => LOOK32 });
  s.deps.releaseFiles = () => ({ autoStage: { blocked: {} }, staging: null });
  for (let m = 0; m <= 70; m += 5) await s.round(m);
  assert.deepEqual(s.launched.filter(l => l.entry === `standstill:${ID32}`).map(l => l.minute), [15, 35], "a release that vanished from the read is not progress");
  assert.equal(s.requests.length, 1, "and the repair request still comes by minute 60, the gate judging it the same way");
  assert.equal(s.told.filter(t => /has not moved for about an hour/.test(t.text)).length, 1, "with its one notice");
});

test("a rung left due is not launched while live work holds the clock: the steps come when the work ends", async () => {
  const { tick } = await import("../standstill.mjs");
  const now = T0 + 30 * MIN;
  const clock = { fp: "f", since: T0, stillMs: 30 * MIN, lastAt: now - 5 * MIN, cycleFrom: 0, done: {}, tries: [], launches: [] }; // 30 minutes still, nothing launched (a provider was signed out)
  const held = tick(clock, { fp: "f", work: [{ what: "a run is building #616", until: now + 10 * MIN }], now, lastRoundAt: now - 5 * MIN });
  assert.deepEqual(held.due, [], "nothing while a run is writing");
  const after = tick(held.clock, { fp: "f", work: [], now: now + 15 * MIN, lastRoundAt: now });
  assert.ok(after.due.includes("helper") && after.due.includes("other-ai"), "and both rungs when it ends");
});
