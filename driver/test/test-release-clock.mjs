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
function server({ look = () => LOOK, answers = {}, named = () => false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-clock-"));
  const env = { ...driverDefaults(TEST_ENV, []), STATE_DIR: path.join(root, "state"), QUESTIONS_DIR: path.join(root, "questions"), NOTICES_FILE: path.join(root, "notices.json"), REPO };
  let now = T0;
  const s = { root, env, launched: [], requests: [], deadman: [], told: [], at: () => (now - T0) / MIN };
  s.deps = {
    now: () => now, log: () => {}, mono: () => ({ uptime: NaN, boot: "" }), refreshTokens: () => [],
    readWorld: async () => world(now), stageLook: async () => look((now - T0) / MIN), releaseFiles: () => ({ autoStage: { blocked: {} }, staging: null }),
    // work near the release that is not the release's: main's own checks, another project's candidate
    activity: async () => ({ runs: [{ headBranch: "main", headSha: "m", createdAt: iso(now - 4 * MIN), name: "required" }, { headBranch: "candidate/0.3.0", headSha: "f", createdAt: iso(now - 4 * MIN), name: "scenarios" }], stop: null, procs: [{ startedAt: now - 2 * MIN, args: "node /x/release/auto-stage.mjs" }] }),
    providers: async () => [{ name: "codex", model: "gpt-5.6-terra", strong: "gpt-5.6-sol" }, { name: "claude", model: "claude-sonnet-5-5", strong: "claude-opus-5-5" }],
    launchAct: (e, a, o) => { s.launched.push({ minute: s.at(), unit: o.unit, entry: o.entry.id, provider: o.provider, tried: o.tried, evidence: o.entry.evidence }); },
    // each acting run answers five minutes after its launch with what the test says for its launch number, else it runs on
    actResult: (e, a, unit) => { const l = s.launched.find(x => x.unit === unit); const n = s.launched.indexOf(l) + 1; const said = answers[n]; return said && s.at() >= l.minute + 5 ? { state: "done", result: /RESULT:\s*(\S+)\s*$/.exec(said)[1], said, provider: l.provider } : { state: "running" }; },
    checkNamed: list => list.map(n => ({ ...n, running: named(n, s.at()) })),
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

test("ticket 01: beta.31 replayed, the same waiting sentence for 3 hours and an in-progress naming nothing: an acting run by minute 20, the other AI by minute 40, the repair request and the notice by minute 60", async () => {
  const s = server({ answers: { 1: LIE } });
  for (let m = 0; m <= 180; m += 5) await s.round(m);
  const runs = byClock(s);
  assert.deepEqual(runs.slice(0, 2).map(l => [l.minute, l.provider]), [[20, "codex"], [40, "claude"]], "rung 1 at 20 on Codex, rung 2 at 40 on Claude, whatever rung 1 said");
  assert.ok(s.requests.length >= 1 && s.requests[0].minute <= 60, `the repair request by minute 60 (it came at ${s.requests[0] && s.requests[0].minute})`);
  assert.equal(s.requests.length, 1, "once");
  assert.match(s.requests[0].words, new RegExp(`^The approved release ${ID} has not moved for 60 minutes`));
  assert.match(s.requests[0].words, /rung 1 on codex: unresolved \(answered in-progress, but named nothing the driver could see running: The factory driver is actively running/, "the lie is named as what it was");
  assert.deepEqual(s.deadman, [60], "and the dead-man is started at once to read it");
  const notice = s.told.find(t => /has not moved for an hour/.test(t.text));
  assert.ok(notice && notice.minute <= 60, `the notice by minute 60 (it came at ${notice && notice.minute})`);
  assert.equal(notice.text, "Beta 31 has not moved for an hour. Two AI helpers tried to move it, first Codex and then Claude, and it is still stuck, so the repair program is now working on it; nothing is needed from you unless a later message says so.");
  assert.equal(s.told.filter(t => /has not moved for an hour/.test(t.text)).length, 1, "told once");
  const st = s.state();
  assert.deepEqual(st.standstill[ID].tries.map(t => [t.rung, t.provider, t.result]), [[1, "codex", "unresolved"]], "in-progress naming nothing counts as unresolved; rung 2 still runs");
  assert.ok(!s.log().some(e => e.kind === "acting run launched" && /^(release|stage):/.test(e.entry)), "the chain itself launched nothing for the release: one owner");
  assert.ok(runs.every(l => l.evidence.some(e => /Waiting for the factory driver to move item 1/.test(e))), "each acting run sees the waiting sentence");
  assert.equal(runs.length, 2, "after the repair step nothing more within the 3 hours: the dead-man and the owner have it, and the ladder starts again after a day");
});

test("ticket 01: an in-progress answer that names a GitHub run in progress holds the clock until that run ends, then the clock goes on from where it was", async () => {
  const s = server({ answers: { 1: "The candidate's scenarios run https://github.com/MichaelZelbel/godspeed-mission-control/actions/runs/123456789 is still going.\nRESULT: in-progress" }, named: (n, minute) => n.kind === "run" && n.id === "123456789" && minute < 50 });
  for (let m = 0; m <= 90; m += 5) await s.round(m);
  const runs = byClock(s);
  assert.equal(runs[0].minute, 20);
  assert.ok(!runs.some(l => l.minute > 20 && l.minute < 50), "nothing more while the run it named runs");
  assert.equal(runs[1].minute, 65, "it ended before minute 50; the clock went on from 20 and reached 40 at minute 65");
  assert.equal(s.state().standstill[ID].tries[0].result, "in-progress");
  assert.match(s.state().standstill[ID].tries[0].summary, /the driver sees the GitHub run 123456789 running/);
});

test("ticket 01: a release whose state changes at minute 35 gets no rung 2; its clock starts again from the change", async () => {
  const s = server({ look: m => (m >= 35 ? LOOK.replace("item 1", "item 2") : LOOK) });
  for (let m = 0; m <= 75; m += 5) await s.round(m);
  const runs = byClock(s);
  assert.deepEqual(runs.map(l => l.minute), [20, 50, 70], "rung 1 at 20; the change at 35 (counted from the round at 30) brings a new rung 1 at 50 and its rung 2 at 70, never one at 40");
  assert.equal(runs[1].provider, "codex", "a new state's ladder starts at rung 1");
});

test("ticket 01: driver.mjs --dry-run says, for each release, the clock's minutes and the next step with its minute", async () => {
  const s = server();
  for (let m = 0; m <= 25; m += 5) await s.round(m);
  const out = await round({ ...s.env, DRY: true }, { ...s.deps, now: () => T0 + 30 * MIN });
  const text = describe(out);
  assert.match(text, new RegExp(`release ${ID}: the release clock: still for 30 minutes; next step: the other AI \\(rung 2\\) at minute 40`));
  assert.equal(s.launched.length, 1, "the dry run launched nothing");
  const fresh = server({ look: () => `Release ${ID} (2.0.0-beta.31): x.\nNot complete yet: waiting on #783.\nResult: waiting.\n` });
  const out2 = await round({ ...fresh.env, DRY: true }, fresh.deps);
  assert.match(describe(out2), new RegExp(`release ${ID}: no release clock \\(the factory is still building its tickets\\)`));
});

test("ticket 01: in the chain too, an in-progress that names nothing checkable is unresolved and holds nothing; one naming an open pull request holds until it is closed", async () => {
  // no release: a question left in the factory's queue for five hours, which the chain hands to an acting run at once
  const queued = now => ({ ...world(now), releases: [], items: {}, factories: [{ project: "p", primary: true, repo: REPO, checkout: "/x", lastDecisions: [], activeRuns: [], board: [], stop: null, timers: {} }], queue: [{ repo: REPO, heading: "a question", asked: iso(T0 - 5 * 60 * MIN), question: "q" }] });
  const s = server({ answers: { 1: LIE } });
  s.deps.readWorld = async () => queued(T0);
  await s.round(0);
  const id = s.launched[0].entry;
  assert.match(id, /^queue:/);
  await s.round(5);
  let c = s.state().chain[id];
  assert.deepEqual(c.tries.map(t => t.result), ["unresolved"], "naming nothing: unresolved");
  assert.ok(!(c.holdUntil > T0 + 5 * MIN), "and no hold");
  const t = server({ answers: { 1: "Pull request #1094 is being merged right now.\nRESULT: in-progress" }, named: (n, minute) => n.kind === "pr" && n.id === "1094" && minute < 15 });
  t.deps.readWorld = async () => queued(T0);
  await t.round(0); await t.round(5);
  c = t.state().chain[id];
  assert.deepEqual([c.tries[0].result, c.holdUntil], ["in-progress", T0 + 5 * MIN + 60 * MIN], "an open pull request it named: held, at most an hour");
  await t.round(10);
  assert.equal(t.state().chain[id].holdUntil, T0 + 5 * MIN + 60 * MIN, "still open at 10: still held");
  await t.round(15);
  c = t.state().chain[id];
  assert.equal(c.holdUntil, T0 + 15 * MIN, "closed at 15: the hold ends that round");
  assert.equal(c.tries[0].result, "unresolved", "and the try counts as unresolved");
});
