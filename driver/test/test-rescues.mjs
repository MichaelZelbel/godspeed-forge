// node --test scripts/factory-driver/test-rescues.mjs   (offline: GitHub and the journal are stand-ins)
// The journal lines are shaped like the AX41's own on 2026-11-18 (journalctl -o json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { weekOf, sessionCommits, handDecisions, unitRescues, countRescues, rescueSentence } from "../rescues.mjs";

const MIN = 60000;
const BOOT = "b0b0";
const us = iso => String(Date.parse(iso) * 1000);
const sys = (iso, unit, job, extra = {}) => ({ __REALTIME_TIMESTAMP: us(iso), _BOOT_ID: BOOT, UNIT: unit, JOB_TYPE: job, JOB_RESULT: "done", MESSAGE: `${job === "start" ? "Started" : "Stopped"} ${unit}`, ...extra });
const usr = (iso, unit, job) => ({ __REALTIME_TIMESTAMP: us(iso), _BOOT_ID: BOOT, USER_UNIT: unit, JOB_TYPE: job, JOB_RESULT: "done", MESSAGE: `${job} ${unit}` });

test("a week runs from Sunday 18:00 to Sunday 18:00, Berlin time, summer and winter", () => {
  const w = weekOf(Date.parse("2026-11-18T18:00:00Z")); // Wednesday 19:00 in Berlin
  assert.equal(w.key, "2026-11-22");
  assert.equal(new Date(w.end).toISOString(), "2026-11-22T17:00:00.000Z");
  assert.equal(new Date(w.start).toISOString(), "2026-11-15T17:00:00.000Z");
  assert.equal(weekOf(Date.parse("2026-11-22T16:59:00Z")).key, "2026-11-22");
  assert.equal(weekOf(Date.parse("2026-11-22T17:00:00Z")).key, "2026-11-29", "Sunday 18:00 starts the next week");
  assert.equal(new Date(weekOf(Date.parse("2026-06-10T12:00:00Z")).end).toISOString(), "2026-06-14T16:00:00.000Z", "summer time");
});

test("a commit counts when a session's trailer is in it; the driver's and auto-stage's own do not", () => {
  const commits = [
    { sha: "a1", commit: { message: "beta.29: move #706 out\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>", committer: { date: "2026-11-18T17:00:00Z" } } },
    { sha: "a2", commit: { message: "beta.29: the default of #706 applies (no answer by its deadline; factory driver)", committer: { date: "2026-11-18T17:01:00Z" } } },
    { sha: "a3", commit: { message: "auto-stage: candidate 2.0.0-beta.29", committer: { date: "2026-11-18T17:02:00Z" } } },
    { sha: "a4", commit: { message: "fix\n\nco-authored-by: claude sonnet 5.5 <noreply@anthropic.com>", committer: { date: "2026-11-18T17:03:00Z" } } },
  ];
  assert.deepEqual(sessionCommits(commits, "MichaelZelbel/godspeed-dev", "releases").map(c => c.id), ["commit:a1", "commit:a4"]);
});

test("an owner decision or question posted by hand counts; the driver's, the relayed answer in his words and anyone else's do not", () => {
  const rows = [
    { id: 1, user: { login: "MichaelZelbel" }, created_at: "2026-11-18T17:00:00Z", html_url: "u1", body: "Owner decision (2026-11-18): judge H-40 on one combined candidate." },
    { id: 2, user: { login: "MichaelZelbel" }, created_at: "2026-11-18T17:00:00Z", html_url: "u2", body: "Owner decision (2026-11-18): x\n<!-- factory-driver:factory-helper-ab-1 -->" },
    { id: 3, user: { login: "MichaelZelbel" }, created_at: "2026-11-18T17:00:00Z", html_url: "u3", body: "Owner decision (question 3: sync)\n\n> yes\n\nHis words, verbatim, sent in Telegram on 2026-11-18." },
    { id: 4, user: { login: "godspeed-dev-builder[bot]" }, created_at: "2026-11-18T17:00:00Z", html_url: "u4", body: "Owner decision (2026-11-18): y" },
    { id: 5, user: { login: "MichaelZelbel" }, created_at: "2026-11-18T17:00:00Z", html_url: "u5", body: "Thanks, looks good." },
    { id: 6, user: { login: "MichaelZelbel" }, created_at: "2026-11-18T17:00:00Z", html_url: "u6", body: "## Owner decision\n\nship it" },
    { id: 7, user: { login: "MichaelZelbel" }, created_at: "2026-11-18T17:00:00Z", html_url: "u7", body: "Owner question: should the reminder repeat?" },
    { id: 8, user: { login: "MichaelZelbel" }, created_at: "2026-11-18T17:00:00Z", html_url: "u8", body: "Owner question (2026-11-18): x\n<!-- factory-driver:factory-helper-cd-2 -->" },
  ];
  assert.deepEqual(handDecisions(rows, "MichaelZelbel/godspeed-mission-control").map(c => c.id), ["comment:MichaelZelbel/godspeed-mission-control:1", "comment:MichaelZelbel/godspeed-mission-control:6", "comment:MichaelZelbel/godspeed-mission-control:7"]);
});

test("units stopped, restarted or started by hand count once each; the driver's own, timers' runs and a user-manager restart's cascade do not", () => {
  const decisions = [{ at: "2026-11-18T15:20:50Z", kind: "housekeeping", done: ["restarted godspeed-forge-web.service"] }];
  const entries = [
    sys("2026-11-18T13:26:19Z", "release-driver.timer", "stop"), // a retired unit: no longer the factory's machinery
    sys("2026-11-18T14:29:46Z", "user@1001.service", "restart"),
    ...["archonfactory-godspeed-mission-control.timer", "archonfactory-querino.timer", "docker.service"].flatMap(u => [usr("2026-11-18T14:29:46Z", u, "stop"), usr("2026-11-18T14:29:47Z", u, "start")]),
    sys("2026-11-18T15:18:36Z", "godspeed-forge-web.service", "stop"), // stopped by hand two minutes before the driver restarted it: counts
    sys("2026-11-18T15:19:36Z", "test-machine.service", "stop"),
    sys("2026-11-18T15:20:00Z", "test-machine.service", "start"), // its timer ran it: never counted
    sys("2026-11-18T15:20:34Z", "godspeed-forge-web.service", "start"), // the driver restarted it (logged)
    sys("2026-11-18T15:34:18Z", "factory-helper-573ea7cac9-5.service", "stop"),
    usr("2026-11-18T15:40:00Z", "archonfactory-querino.timer", "stop"),
    usr("2026-11-18T15:41:00Z", "archonfactory-querino.timer", "start"), // the same hand action: stopped, then started again
    sys("2026-11-18T15:50:00Z", "factory-driver.service", "start"), // the driver's own timer
    sys("2026-11-18T15:55:00Z", "godspeed-forge-web.service", "stop", { _BOOT_ID: "older" }), // another boot
    sys("2026-11-18T15:56:00Z", "godspeed-forge-web.service", "start", { JOB_RESULT: "failed" }),
    { __REALTIME_TIMESTAMP: us("2026-11-18T15:57:00Z"), _BOOT_ID: BOOT, UNIT: "godspeed-forge-web.service", MESSAGE: "godspeed-forge-web.service: Scheduled restart job, restart counter is at 1." },
    sys("2026-11-18T15:57:05Z", "godspeed-forge-web.service", "start"), // systemd's own Restart=: never counted
  ];
  const got = unitRescues(entries, { decisions, bootId: BOOT, bootAt: Date.parse("2026-11-03T13:03:59Z") });
  assert.deepEqual(got.map(r => r.what), [
    "user@1001.service restarted by hand",
    "godspeed-forge-web.service stopped by hand",
    "test-machine.service stopped by hand",
    "factory-helper-573ea7cac9-5.service stopped by hand",
    "archonfactory-querino.timer stopped by hand",
  ]);
  // a unit's main process killed by hand (no stop job) counts; systemd's own limits and the OOM killer do not
  const msg = (iso, unit, m, o = {}) => ({ __REALTIME_TIMESTAMP: us(iso), _BOOT_ID: BOOT, UNIT: unit, MESSAGE: `${unit}: ${m}`, ...o });
  const kills = unitRescues([
    msg("2026-11-18T16:00:00Z", "test-machine.service", "Main process exited, code=killed, status=9/KILL"),
    msg("2026-11-18T16:10:00Z", "factory-helper-ab12-1.service", "Service reached runtime time limit. Stopping."),
    msg("2026-11-18T16:10:01Z", "factory-helper-ab12-1.service", "Main process exited, code=killed, status=15/TERM"),
    msg("2026-11-18T16:20:00Z", "factory-driver.service", "start operation timed out. Terminating."),
    msg("2026-11-18T16:20:01Z", "factory-driver.service", "Main process exited, code=killed, status=15/TERM"),
    msg("2026-11-18T16:30:00Z", "godspeed-forge-web.service", "A process of this unit has been killed by the OOM killer."),
    msg("2026-11-18T16:30:01Z", "godspeed-forge-web.service", "Main process exited, code=killed, status=9/KILL"),
    msg("2026-11-18T16:40:00Z", "auto-stage.service", "Main process exited, code=killed, status=15/TERM"),
    sys("2026-11-18T16:40:00Z", "auto-stage.service", "stop"), // a stop job: counted once, as the stop
    { __REALTIME_TIMESTAMP: us("2026-11-18T16:50:00Z"), _BOOT_ID: BOOT, USER_UNIT: "archonfactory-querino.service", MESSAGE: "archonfactory-querino.service: Main process exited, code=killed, status=9/KILL" },
  ], { decisions: [], bootId: BOOT, bootAt: Date.parse("2026-11-03T13:03:59Z") });
  assert.deepEqual(kills.map(r => r.what), ["test-machine.service killed by hand", "auto-stage.service stopped by hand", "archonfactory-querino.service killed by hand"]);
  // the first ten minutes after a boot are the boot's, not a person's
  assert.deepEqual(unitRescues([sys("2026-11-18T15:05:00Z", "godspeed-forge-web.service", "stop")], { decisions: [], bootId: BOOT, bootAt: Date.parse("2026-11-18T15:00:00Z") }), []);
});

// ---------------------------------------------------------------- a round's count
function world() { return { factories: [{ project: "godspeed-mission-control", repo: "MichaelZelbel/godspeed-mission-control" }, { project: "querino", repo: "MichaelZelbel/querino" }, { project: "x", repo: null }] }; }
function fixture() {
  const asked = [], told = [], recorded = [];
  let commits = [], comments = [], journal = [];
  const fail = new Set();
  const deps = {
    gh: args => {
      const a = args.join(" ");
      asked.push(a);
      if (/\/commits\?/.test(a)) { if (fail.has("commits")) throw new Error("HTTP 502"); return commits.filter(c => a.includes(`path=${encodeURIComponent(c.path)}`) && a.includes(c.repo)); }
      if (/issues\/comments\?/.test(a)) { if (fail.has("comments")) throw new Error("HTTP 502"); return comments.filter(c => a.includes(c.repo)); }
      throw new Error(`unexpected gh ${a}`);
    },
    journal: () => { if (fail.has("units")) throw new Error("journal unreadable"); return journal; },
    boot: () => ({ id: BOOT, at: Date.parse("2026-11-03T13:03:59Z") }),
    decisions: () => [],
  };
  const ctx = (state, now) => ({ state, world: world(), now, record: e => recorded.push(e), notify: (key, text) => { state.told ||= {}; if (state.told[key]) return false; state.told[key] = true; told.push(text); return true; } });
  return { deps, asked, told, recorded, fail, set: x => { commits = x.commits || commits; comments = x.comments || comments; journal = x.journal || journal; }, ctx };
}
const ENV = { DEV_REPO: "MichaelZelbel/godspeed-dev", ENGINE_REPO: "MichaelZelbel/godspeed-engine", REPO: "MichaelZelbel/godspeed-mission-control" };

test("each round counts what came since its last round, per week, once each; a source it could not read is read again", async () => {
  const f = fixture();
  const state = {};
  const t0 = Date.parse("2026-11-18T18:30:00Z"); // Wednesday 19:30 in Berlin: counting starts now
  await countRescues(ENV, f.ctx(state, t0), f.deps);
  assert.equal(state.rescues.since, new Date(t0).toISOString());
  assert.ok(f.asked.some(a => a.includes("repos/MichaelZelbel/godspeed-dev/commits?path=releases&")));
  for (const p of ["scripts%2Ffactory-driver", "scripts%2Ftest-machine", "scripts%2Ffactory-sandbox"]) assert.ok(f.asked.some(a => a.includes(`repos/MichaelZelbel/godspeed-engine/commits?path=${p}&`)), p);
  assert.ok(f.asked.some(a => a.includes("repos/MichaelZelbel/querino/issues/comments?")));
  const session = { repo: "MichaelZelbel/godspeed-engine", path: "scripts/factory-driver", sha: "c1", commit: { message: "fix the driver\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>", committer: { date: "2026-11-18T18:40:00Z" } } };
  const before = { ...session, sha: "c0", commit: { ...session.commit, committer: { date: "2026-11-18T18:00:00Z" } } }; // before the count began
  f.set({ commits: [session, before], comments: [{ repo: "MichaelZelbel/querino", id: 9, user: { login: "MichaelZelbel" }, created_at: "2026-11-18T18:41:00Z", body: "Owner decision: keep the old format" }] });
  f.fail.add("units");
  await countRescues(ENV, f.ctx(state, t0 + 15 * MIN), f.deps);
  const w = state.rescues.weeks["2026-11-22"];
  assert.equal(w.count, 1, "an engine commit is development, never a rescue");
  assert.deepEqual(w.items.map(i => i.kind), ["decision"]);
  assert.deepEqual(w.driverChanges.map(i => i.id), ["commit:c1"], "it is counted apart, as a driver change");
  assert.equal(state.rescues.lastAt.units, new Date(t0).toISOString(), "the journal was not read, so it is read again from where it was");
  assert.ok(f.recorded.some(r => r.kind === "rescue count: a source was not read" && /journal unreadable/.test(r.why)));
  // the same commit and comment again (GitHub's since overlaps): counted once
  f.fail.clear();
  f.set({ journal: [sys("2026-11-18T18:50:00Z", "test-machine.service", "stop")] });
  await countRescues(ENV, f.ctx(state, t0 + 30 * MIN), f.deps);
  assert.equal(state.rescues.weeks["2026-11-22"].count, 2);
  assert.equal(state.rescues.weeks["2026-11-22"].driverChanges.length, 1, "once");
  assert.equal(state.rescues.lastAt.units, new Date(t0 + 30 * MIN).toISOString());
  assert.equal(f.recorded.filter(r => r.kind === "hand rescue").length, 2, "each one is in the driver's log");
  assert.equal(f.recorded.filter(r => r.kind === "driver change").length, 1);
});

test("Sunday 18:00: one sentence with the week's number, 0 included, once; a week counted from Wednesday says so", async () => {
  const f = fixture();
  const state = {};
  const t0 = Date.parse("2026-11-18T18:30:00Z");
  await countRescues(ENV, f.ctx(state, t0), f.deps);
  f.set({ journal: [sys("2026-11-19T10:00:00Z", "test-machine.service", "stop"), sys("2026-11-20T10:00:00Z", "user@1001.service", "restart")],
    commits: [{ repo: "MichaelZelbel/godspeed-dev", path: "releases", sha: "d1", commit: { message: "beta.29 scope\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>", committer: { date: "2026-11-21T10:00:00Z" } } },
      { repo: "MichaelZelbel/godspeed-engine", path: "scripts/test-machine", sha: "d2", commit: { message: "test machine fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>", committer: { date: "2026-11-21T11:00:00Z" } } }] });
  await countRescues(ENV, f.ctx(state, Date.parse("2026-11-21T12:00:00Z")), f.deps);
  assert.deepEqual(f.told, [], "nothing before Sunday 18:00");
  await countRescues(ENV, f.ctx(state, Date.parse("2026-11-22T16:55:00Z")), f.deps);
  assert.deepEqual(f.told, [], "17:55 in Berlin is not yet");
  await countRescues(ENV, f.ctx(state, Date.parse("2026-11-22T17:00:00Z")), f.deps);
  assert.equal(f.told.length, 1);
  assert.equal(f.told[0], "Since Wednesday the factory needed 3 hand rescues: 1 release change made by a session and 2 factory services stopped, started or killed by hand.");
  await countRescues(ENV, f.ctx(state, Date.parse("2026-11-22T17:05:00Z")), f.deps);
  assert.equal(f.told.length, 1, "once");
  // a whole quiet week: N=0 is said too
  f.set({ journal: [], commits: [] });
  await countRescues(ENV, f.ctx(state, Date.parse("2026-11-29T17:00:00Z")), f.deps);
  assert.equal(f.told[1], "This week the factory needed no hand rescues.");
  for (const t of f.told) assert.doesNotMatch(t, /[—–]/);
});

test("the sentence names each kind it counted, in plain words", () => {
  assert.equal(rescueSentence({ release: 2, decision: 1, unit: 0 }, null), "This week the factory needed 3 hand rescues: 2 release changes made by a session and 1 owner decision or question posted by hand.");
  assert.equal(rescueSentence({ release: 0, decision: 0, unit: 1 }, null), "This week the factory needed 1 hand rescue: 1 factory service stopped, started or killed by hand.");
  assert.equal(rescueSentence({ release: 0, decision: 0, unit: 0, "driver-change": 7 }, null), "This week the factory needed no hand rescues.", "driver changes are never named");
});

test("a week counted under the first rule is sorted again: engine commits become driver changes, release commits stay rescues", async () => {
  const f = fixture();
  const state = { rescues: { since: "2026-11-18T17:00:02Z", lastAt: { commits: "2026-11-18T18:00:00Z", comments: "2026-11-18T18:00:00Z", units: "2026-11-18T18:00:00Z" }, told: {},
    weeks: { "2026-11-22": { start: "2026-11-15T17:00:00.000Z", end: "2026-11-22T17:00:00.000Z", count: 3, items: [
      { id: "commit:e1", at: "2026-11-18T17:08:01Z", kind: "commit", what: "godspeed-engine scripts/factory-driver: b3b3bd6 factory-driver: a missing tool" },
      { id: "commit:r1", at: "2026-11-18T17:09:00Z", kind: "commit", what: "godspeed-dev releases: 9e2c7cb beta.29 scope" },
      { id: "unit:x@1", at: "2026-11-18T17:10:00Z", kind: "unit", what: "test-machine.service stopped by hand" } ] } } } };
  await countRescues(ENV, f.ctx(state, Date.parse("2026-11-18T18:05:00Z")), f.deps);
  const w = state.rescues.weeks["2026-11-22"];
  assert.deepEqual(w.items.map(i => [i.id, i.kind]), [["commit:r1", "release"], ["unit:x@1", "unit"]]);
  assert.equal(w.count, 2);
  assert.deepEqual(w.driverChanges.map(i => [i.id, i.kind]), [["commit:e1", "driver-change"]]);
});
