import { TEST_ENV } from "./env.mjs";
// node --test scripts/factory-driver/test-driver.mjs   (offline: GitHub, the server and the AIs are stand-ins)
// A full round over today's real state (2026-11-18): 25 open items carry needs-owner, the release's
// pull requests #708, #713 and #715 were parked because a hidden-check tool is missing, and the
// scheduler says "workable nothing" three times running.
import { test } from "./harness.mjs";
import { enforceReadOnly, refused } from "../readonly.mjs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { round, takeLock, tellText, contextFor, driverDefaults, describe } from "../driver.mjs";
import { obstacleId } from "../obstacles.mjs";

const NOW = Date.parse("2026-11-18T16:00:00Z");
const REPO = "MichaelZelbel/godspeed-mission-control";
const ID = "godspeed-2.0.0-beta.29-every-lane-busy";
const PLAN = `---\nrelease: ${ID}\nrepository: ${REPO}\n---\nStatus: approved by Michael on 2026-11-18\n\n# Godspeed 2.0.0-beta.29: every lane busy\n\nIssues: item 1 #704, 2 #705, 3 #706, 4 #667\n\nThe plan's rule: an item that reaches a dead end leaves the release, the rest ships.\n`;
const TICKETS = ["01-work-is-ready-only-when-checked.md", "02-one-reminder.md", "03-domain-watch.md", "04-ai-status.md"];
const PARKED = { 704: 708, 705: 713, 706: 715 }; // issue -> its parked pull request
const BOARD = [704, 705, 706, 710, 279, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 319];
const JOURNAL = [
  "2026-11-18T16:40:02+01:00 godspeed-archon python3[1]: No launch: workable nothing; 0 lap(s) active, 0 still choosing.",
  "2026-11-18T16:45:02+01:00 godspeed-archon python3[2]: No launch: workable nothing; 0 lap(s) active, 0 still choosing.",
  "2026-11-18T16:50:02+01:00 godspeed-archon python3[3]: No launch: workable nothing; 0 lap(s) active, 0 still choosing.",
].join("\n");
const REFUSED = "Loop review: refused. The hidden check H-35 cannot run: its tool does not exist on the test machine (the verifier could not observe).";

function fixture({ questions = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-round-"));
  const env = { ...driverDefaults(TEST_ENV, []), STATE_DIR: path.join(root, "state"), QUESTIONS_DIR: path.join(root, "questions"), NOTICES_FILE: path.join(root, "notices.json"), REPO };
  if (questions) { fs.mkdirSync(env.QUESTIONS_DIR, { recursive: true }); fs.writeFileSync(path.join(env.QUESTIONS_DIR, "driver-questions.json"), JSON.stringify({ [REPO]: questions })); }
  const posted = [];
  const gh = (args, input) => {
    const a = args.join(" ");
    let m;
    if (args[0] === "-X") { posted.push({ args, input }); return {}; }
    if (/graphql/.test(a)) { const n = Number(/issue\(number: (\d+)\)/.exec(a)[1]); return { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: PARKED[n] ? [{ number: PARKED[n] }] : n === 667 ? [{ number: 690 }] : [] }, timelineItems: { nodes: [] } } } } }; }
    if ((m = /pulls\/(\d+)$/.exec(a))) { const n = Number(m[1]); return n === 690 ? { state: "closed", merged_at: "2026-11-18T09:00:00Z", labels: [], head: { sha: "s690" } } : { state: "open", merged_at: null, labels: [{ name: "needs-owner" }], head: { sha: `s${n}` } }; }
    if (/commits\/s\d+\/check-runs/.test(a)) return { check_runs: [{ name: "required", status: "completed", conclusion: "failure", completed_at: "2026-11-18T10:00:00Z", started_at: "2026-11-18T09:50:00Z" }] };
    if (/commits\/s\d+$/.test(a)) return { commit: { committer: { date: "2026-11-18T09:40:00Z" } } };
    if (/commits\/main$/.test(a)) return { sha: "9a72d3811" };
    if (/commits\/9a72d3811\/check-runs/.test(a)) return { check_runs: [{ name: "required", status: "completed", conclusion: "success", completed_at: "2026-11-18T13:00:00Z" }] };
    if (/issues\?state=open&labels=needs-owner/.test(a)) return BOARD.map(number => ({ number }));
    if ((m = /issues\/(\d+)\/comments/.exec(a))) return PARKED[Number(m[1])] || Object.values(PARKED).includes(Number(m[1])) ? [{ user: { login: "godspeed-dev-builder[bot]" }, body: REFUSED, created_at: "2026-11-18T10:05:00Z" }] : [];
    if ((m = /issues\/(\d+)$/.exec(a))) { const n = Number(m[1]); return n === 667 ? { state: "closed", state_reason: "completed", closed_at: "2026-11-18T09:01:00Z", labels: [] } : { state: "open", labels: [{ name: "needs-owner" }], closed_at: null }; }
    throw new Error(`unexpected gh ${a}`);
  };
  const sh = cmd => {
    if (/list-unit-files/.test(cmd)) return "archonfactory-godspeed-mission-control.timer enabled enabled\narchonfactory-godspeed-mission-control-manager.timer enabled enabled\n";
    if (/show -p Id/.test(cmd)) return "Id=archonfactory-godspeed-mission-control.timer\nActiveState=active\nLoadState=loaded\n\nId=archonfactory-godspeed-mission-control-manager.timer\nActiveState=active\nLoadState=loaded\n";
    if (/journalctl --user/.test(cmd)) return JOURNAL;
    if (/workflow runs/.test(cmd)) return JSON.stringify({ runs: [{ id: "old", status: "completed", started_at: "2026-11-18T13:22:22Z" }] });
    if (/user@1001/.test(cmd)) return "0\n";
    if (/netns-guard/.test(cmd)) return "inactive\n";
    if (/df /.test(cmd)) return " 61%\n";
    if (/free -m/.test(cmd)) return "Mem: 64223 20000 2019 40 40000 40000\n";
    if (/gh auth/.test(cmd)) return "ok\n";
    if (/codex login/.test(cmd)) return "Logged in using ChatGPT\n";
    if (/claude auth/.test(cmd)) return "Logged in\n";
    if (/toolCoverage/.test(cmd)) return JSON.stringify({ ids: ["H-1", "H-2"], missing: [] });
    return "";
  };
  const worldDeps = {
    now: () => NOW,
    readReleases: () => [{ id: ID, dir: `/releases/${ID}`, plan: PLAN, hasStaging: false, staging: null, done: false }],
    readDir: () => [...TICKETS, "README.md"],
    readFile: p => {
      if (/consumer\.json$/.test(p)) return JSON.stringify({ source: "/home/godspeed-forge/.cache/factory/archon/1cfb", bun: "bun" });
      const t = TICKETS.find(f => p.endsWith(f));
      if (t) return `# ${t.slice(3, -3).replace(/-/g, " ")}\n\nSize: medium.\n`;
      throw new Error(`no ${p}`);
    },
  };
  const launched = [];
  const records = { writes: [], read: () => null, write(files, msg) { this.writes.push({ files, msg }); return "c0ffee"; } };
  const results = {};
  const deps = {
    now: () => NOW, log: () => {}, gh, sh, worldDeps, records, ownerIssue: 600, mono: () => ({ uptime: NaN, boot: "" }), // the machine's own uptime says nothing about the test's pretend clock
    rescues: async () => {}, // the hand-rescue count reads root's GitHub and the journal: never in a test
    providers: async () => [{ name: "codex", model: "gpt-5.6-terra", strong: "gpt-5.6-sol" }, { name: "claude", model: "claude-sonnet-5-5", strong: "claude-opus-5-5" }],
    check: () => ({ out: { approve: true, reason: "keeps the bar" }, trouble: "" }),
    refreshTokens: () => [],
    gateCfg: { reads: 1, gapMs: 0 }, recheck: async ids => new Set(ids), // the gate has its own tests with the real rules
    activity: async () => null, rung0: async () => [], watcherHealth: () => ({ ok: true }), mirroredHead: () => "", publishHeartbeat: () => {}, clockCheck: () => ({ ok: true, ghNow: NaN, skewMs: NaN }), supersession: () => ({ leave: [], bad: [] }), nextRelease: async () => null, verifyInstalled: () => ({ ok: false, why: "test" }), seenCheck: () => ({ seen: false }),
    deliver: { telegram: async () => ({ ok: true, receipt: "42" }), issue: () => ({ ok: true, receipt: "https://github.com/o/w/issues/1" }) },
    launchHelper: async (e, o) => { launched.push({ env: e, ...o }); return { unit: o.unit, dir: "/x" }; },
    helperResult: (e, unit) => results[unit] || { state: "running" },
    hkDeps: { run: () => ({ status: 0, stdout: "", stderr: "" }), sleep: async () => {} },
  };
  return { root, env, deps, launched, records, posted, results };
}

test("today's real state: a diagnose helper for each parked release ticket and one for the idle factory; the release's files are never written", async () => {
  const f = fixture();
  const out = await round(f.env, f.deps);
  const kinds = out.obstacles.map(o => o.kind).sort();
  assert.deepEqual(kinds, ["factory-idle", "parked", "parked", "parked"]);
  assert.deepEqual(f.launched.map(l => l.kind), ["diagnose", "diagnose", "diagnose", "diagnose"]);
  const forTickets = f.launched.filter(l => /#\d$/.test(l.context.TICKET_KEY)).map(l => l.context.TICKET_KEY).sort();
  assert.deepEqual(forTickets, [`${ID}#1`, `${ID}#2`, `${ID}#3`]);
  const idle = f.launched.find(l => l.context.OBSTACLE_KIND === "factory-idle");
  assert.match(idle.context.ITEMS, /#704, #705, #706, #710/);
  assert.equal(idle.unit, `factory-helper-${obstacleId("factory-idle", "factory")}-1`);
  for (const l of f.launched) {
    assert.equal(l.provider, "codex", "the first of the rotation (the subscription the factory does not use)");
    assert.match(l.briefFile, /briefs[\\/]diagnose\.md$/);
    assert.equal(l.ownerIssue, 600);
  }
  const t1 = f.launched.find(l => l.context.TICKET_KEY === `${ID}#1`);
  assert.match(t1.context.EVIDENCE, /needs-owner on issue #704/);
  assert.match(t1.context.TICKET, /^# work is ready only when checked/);
  assert.match(t1.context.PLAN, /Issues: item 1 #704/);
  assert.equal(f.records.writes.length, 0, "scope-amendment.json is never written by a diagnosis");
  assert.equal(f.posted.length, 0, "nothing posted on GitHub");
  const state = JSON.parse(fs.readFileSync(path.join(f.env.STATE_DIR, "state.json"), "utf8"));
  assert.equal(Object.keys(state.helpers).length, 4);
  assert.ok(fs.existsSync(path.join(f.env.STATE_DIR, "heartbeat")));
  const log = fs.readFileSync(path.join(f.env.STATE_DIR, "decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(log.filter(e => e.kind === "launched").length, 4);
  assert.equal(log.filter(e => e.kind === "obstacle").length, 4);

  // the next round: every helper still runs, nothing is launched twice
  const again = await round(f.env, f.deps);
  assert.equal(f.launched.length, 4);
  assert.deepEqual(again.steps.map(s => s.do), ["running", "running", "running", "running"]);
});

test("at most four helpers at once, the oldest obstacle first", async () => {
  const f = fixture();
  f.env.MAX_HELPERS = 2;
  const out = await round(f.env, f.deps);
  assert.equal(f.launched.length, 2);
  assert.equal(out.steps.filter(s => /waits: 2 helpers are running/.test(s.note)).length, 2);
  const since = out.steps.map(s => Date.parse(s.since));
  assert.deepEqual(since, [...since].sort((a, b) => a - b));
});

test("a helper that never wrote a report counts as failed, and the next attempt runs on another AI with a note", async () => {
  const f = fixture();
  await round(f.env, f.deps);
  const first = f.launched.find(l => l.context.TICKET_KEY === `${ID}#1`);
  f.results[first.unit] = { state: "failed", reason: "no report: the helper ended without finishing (killed, timed out or crashed)", endedAt: "2026-11-18T15:59:00Z" };
  await round(f.env, f.deps);
  const second = f.launched.filter(l => l.context.TICKET_KEY === `${ID}#1`);
  assert.equal(second.length, 2);
  assert.equal(second[1].kind, "diagnose");
  assert.equal(second[1].provider, "claude", "a different AI");
  assert.match(second[1].context.APPROACH_NOTE, /no report.*Do something different/);
  assert.match(second[1].context.HISTORY, /diagnose \(codex\/gpt-5\.6-terra\): no report/);
  assert.equal(second[1].unit.endsWith("-2"), true);
});

test("a diagnosis of 'how' sends the decide helper; its decision is checked, posted on the item and the parked PR, and needs-owner comes off", async () => {
  const f = fixture();
  await round(f.env, f.deps);
  const d = f.launched.find(l => l.context.TICKET_KEY === `${ID}#1`);
  f.results[d.unit] = { state: "done", endedAt: "2026-11-18T16:04:00Z", report: { cause: "how", evidence: ["H-35 has no tool"], summary: "A question of how the check runs." } };
  await round(f.env, f.deps);
  const dec = f.launched.filter(l => l.context.TICKET_KEY === `${ID}#1`).at(-1);
  assert.equal(dec.kind, "decide");
  assert.match(dec.context.DIAGNOSIS, /^how: A question of how/);
  f.results[dec.unit] = { state: "done", endedAt: "2026-11-18T16:10:00Z", report: { summary: "s", item: 704, pr: 708, decision: "Build the H-35 tool first; the acceptance criteria and every check stay exactly as they are.", cause: "how" } };
  await round(f.env, f.deps);
  const comments = f.posted.filter(p => p.args[1] === "POST" && /comments$/.test(p.args[2]));
  assert.deepEqual(comments.map(p => /issues\/(\d+)\//.exec(p.args[2])[1]), ["704", "708"]);
  assert.match(JSON.parse(comments[0].input).body, /^Manager decision \(Mission Control, not Michael\): Build the H-35 tool first/);
  assert.ok(comments.every(c => !/^\s*Owner (decision|question|repair)/i.test(JSON.parse(c.input).body)));
  assert.equal(f.records.writes.length, 0);
});

test("a decision the second check refuses is tried once more with the reason in its brief; refused again it keeps every check as it is; Michael is never asked (2026-11-19, helpers 27, 28, 29)", async () => {
  const f = fixture();
  f.deps.check = () => ({ out: { approve: false, reason: "it waives a holdout observation" }, trouble: "" });
  await round(f.env, f.deps);
  const d = f.launched.find(l => l.context.TICKET_KEY === `${ID}#1`);
  f.results[d.unit] = { state: "done", endedAt: "2026-11-18T16:04:00Z", report: { cause: "how", evidence: ["H-35 has no tool"], summary: "A question of how the check runs." } };
  await round(f.env, f.deps);
  const dec = f.launched.filter(l => l.context.TICKET_KEY === `${ID}#1`).at(-1);
  assert.equal(dec.kind, "decide");
  f.results[dec.unit] = { state: "done", endedAt: "2026-11-18T16:10:00Z", report: { summary: "s", item: 704, pr: 708, decision: "Treat the unit tests as the observation for H-35.", cause: "how" } };
  const before = f.launched.length;
  await round(f.env, f.deps);
  const posted = () => f.posted.filter(p => p.args[1] === "POST" && /comments$/.test(p.args[2]));
  assert.deepEqual(posted(), [], "the first refusal posts nothing");
  assert.ok(!fs.existsSync(path.join(f.env.QUESTIONS_DIR, "driver-questions.json")), "and asks nobody");
  // the next attempt's brief carries the reason
  const again = f.launched.slice(before).filter(l => l.context.TICKET_KEY === `${ID}#1`);
  assert.equal(again.length, 1, "one more attempt");
  assert.match(JSON.stringify(again[0].context), /Your last answer was refused: it waives a holdout observation/);
  f.results[again[0].unit] = { state: "done", endedAt: "2026-11-18T16:20:00Z", report: { summary: "s", item: 704, pr: 708, decision: "Treat the unit tests as the observation for H-35, again.", cause: "how" } };
  await round(f.env, f.deps);
  const c = posted();
  assert.deepEqual(c.map(p => /issues\/(\d+)\//.exec(p.args[2])[1]), ["704", "708"]);
  assert.match(JSON.parse(c[0].input).body, /^Manager decision \(Mission Control, not Michael\): every existing check, hidden scenario and judge stays exactly as it is/);
  assert.ok(!fs.existsSync(path.join(f.env.QUESTIONS_DIR, "driver-questions.json")), "Michael was never asked");
});

test("a product question holds the item for Michael: no other model is asked the same question until he answers", async () => {
  const f = fixture();
  await round(f.env, f.deps);
  const d = f.launched.find(l => l.context.TICKET_KEY === `${ID}#1`);
  f.results[d.unit] = { state: "done", endedAt: "2026-11-18T16:04:00Z", report: { cause: "how", evidence: ["H-35 has no tool"], summary: "A question of how the check runs." } };
  await round(f.env, f.deps);
  const dec = f.launched.filter(l => l.context.TICKET_KEY === `${ID}#1`).at(-1);
  f.results[dec.unit] = { state: "done", endedAt: "2026-11-18T16:10:00Z", report: { summary: "s", item: 704, pr: 708, decision: "Decide how the card looks: one short sentence.", cause: "how" } };
  const before = f.launched.length;
  const out = await round(f.env, f.deps);
  assert.deepEqual(f.posted.filter(p => p.args[1] === "POST" && /comments$/.test(p.args[2])), [], "nothing is posted in anyone's name");
  const q = JSON.parse(fs.readFileSync(path.join(f.env.QUESTIONS_DIR, "driver-questions.json"), "utf8"))[REPO];
  assert.equal(q.length, 1); assert.equal(q[0].issue, 704);
  assert.ok(!("default" in q[0]) && !("deadline" in q[0]));
  await round(f.env, f.deps); await round(f.env, f.deps);
  assert.deepEqual(f.launched.slice(before).filter(l => l.context.TICKET_KEY === `${ID}#1`), [], "the question goes to Michael, it does not relaunch");
  assert.equal(out.steps.find(s => s.key === `${ID}#1`).do, "wait-external", "the item waits for him");
  fs.writeFileSync(path.join(f.env.QUESTIONS_DIR, "driver-questions.json"), JSON.stringify({ [REPO]: [] }));
  await round(f.env, f.deps);
  assert.ok(f.launched.slice(before).some(l => l.context.TICKET_KEY === `${ID}#1`), "once he answered it moves again");
});

test("a held helper kind is not launched (FD_HOLD_KINDS=tests while another session rebuilds the hidden-check tools)", async () => {
  const f = fixture();
  f.env.HOLD_KINDS = ["tests"];
  await round(f.env, f.deps);
  const d = f.launched.find(l => l.context.TICKET_KEY === `${ID}#1`);
  f.results[d.unit] = { state: "done", report: { cause: "our-tests", summary: "The hidden check H-35 has no tool." } };
  const out = await round(f.env, f.deps);
  assert.equal(f.launched.filter(l => l.kind === "tests").length, 0);
  assert.match(out.steps.find(s => s.key === `${ID}#1`).note, /held: tests helpers are paused on this server/);
  assert.deepEqual(driverDefaults({ ...TEST_ENV, FD_HOLD_KINDS: "tests, ops" }, []).HOLD_KINDS, ["tests", "ops"]);
});

test("one tests helper at a time on the tools folder: a new set of missing tools waits while the last set's helper still runs", async () => {
  const f = fixture();
  f.env.MAX_HELPERS = 10;
  const { readWorld } = await import("../world.mjs");
  let missing = ["H-41"];
  f.deps.readWorld = async (e, d) => ({ ...(await readWorld(e, d)), tools: { scenarios: 43, missing: missing.map(id => ({ id, why: `${id} has no tool` })) } });
  await round(f.env, f.deps);
  const first = f.launched.filter(l => l.kind === "tests");
  assert.equal(first.length, 1);
  assert.equal(first[0].context.OBSTACLE_ID, obstacleId("tools-missing", "tools:H-41"));
  missing = ["H-41", "H-42", "H-43"]; // a new episode (a new id) while the first helper still works in the same folder
  const out = await round(f.env, f.deps);
  assert.equal(f.launched.filter(l => l.kind === "tests").length, 1, "no second tests helper in the same tools folder");
  assert.match(out.steps.find(s => s.kind === "tools-missing").note, /waits: a tests helper is still working on the hidden-check tools/);
  f.results[first[0].unit] = { state: "done", endedAt: "2026-11-18T16:30:00Z", report: { summary: "restored H-41" } };
  await round(f.env, f.deps);
  const now = f.launched.filter(l => l.kind === "tests");
  assert.equal(now.length, 2, "once it finished, the new set gets its own helper");
  assert.equal(now[1].context.OBSTACLE_ID, obstacleId("tools-missing", "tools:H-41,H-42,H-43"));
  assert.equal(now[1].context.HISTORY, "Nothing yet.", "the new episode starts with its own history");
});

test("a superseded release is named once in the log and never driven", async () => {
  const f = fixture();
  const { readWorld } = await import("../world.mjs");
  f.deps.readWorld = async (e, d) => ({ ...(await readWorld(e, d)), superseded: [{ id: "godspeed-2.0.0-beta.27-sees-it-through", version: "2.0.0-beta.27", by: "2.0.0-beta.28" }] });
  await round(f.env, f.deps);
  await round(f.env, f.deps);
  const log = fs.readFileSync(path.join(f.env.STATE_DIR, "decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(e => e.kind === "release superseded");
  assert.equal(log.length, 1);
  assert.match(log[0].why, /2\.0\.0-beta\.27 is approved but older than 2\.0\.0-beta\.28, which is installed/);
});

test("two rounds at once: a live round's lock stops the second; a dead round's lock is taken over", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-lock-"));
  const release = takeLock(dir);
  assert.ok(release);
  fs.writeFileSync(path.join(dir, "round.lock"), JSON.stringify({ pid: process.ppid, at: "x" })); // a live process holds it
  assert.equal(takeLock(dir), null);
  fs.writeFileSync(path.join(dir, "round.lock"), JSON.stringify({ pid: 2147483646, at: "x" })); // nobody has this pid
  const again = takeLock(dir);
  assert.ok(again, "a stale lock is taken over");
  again();
  assert.equal(fs.existsSync(path.join(dir, "round.lock")), false);
  const f = fixture();
  fs.mkdirSync(f.env.STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(f.env.STATE_DIR, "round.lock"), JSON.stringify({ pid: process.ppid }));
  assert.deepEqual(await round(f.env, f.deps), { busy: true });
  assert.equal(f.launched.length, 0);
});

test("the dry run reads everything, launches nothing and writes nothing, and says what it would do", async () => {
  const f = fixture();
  const out = await round({ ...f.env, DRY: true }, f.deps);
  assert.equal(f.launched.length, 0);
  assert.equal(fs.existsSync(f.env.STATE_DIR), false, "not even its own state");
  const text = describe(out);
  assert.match(text, /item 1 #704 open, parked \(needs-owner\)/);
  assert.match(text, /factory-idle godspeed-mission-control since .*: diagnose on codex\/gpt-5\.6-terra \(would launch factory-helper-/);
  assert.equal(out.steps.length, 4);
});

const snapshot = dir => { const out = {}; const walk = d => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, n.name); if (n.isDirectory()) walk(f); else out[path.relative(dir, f)] = crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex"); } }; walk(dir); return out; };
test("a dry run is safe beside a driver that still runs on the same state folder: it starts no step and no unit and changes no file (state, journal, last.json, status.json, heartbeat), and the lock refuses a write if one were tried", async () => {
  const f = fixture();
  // the other driver's state, already there
  const stateDir = f.env.STATE_DIR; fs.mkdirSync(path.join(stateDir, "steps", "alpha"), { recursive: true });
  for (const [n, t] of [["state.json", "{\"firstSeen\":{}}"], ["journal.jsonl", ""], ["status.json", "{\"at\":\"2026-11-18T15:00:00Z\"}"], ["heartbeat", "2026-11-18T15:00:00Z"], ["steps/alpha/last.json", "{\"ok\":true,\"endedAt\":\"2026-11-18T15:00:00Z\"}"]]) fs.writeFileSync(path.join(stateDir, n), t);
  const before = snapshot(stateDir);
  const runs = [];
  const fakeStep = { name: "alpha", STEP: { name: "alpha", everyMinutes: 10, maxMinutes: 30, inRound: false }, SETTINGS: [], run: async () => { runs.push("ran"); return { ok: true }; } };
  const inline = { name: "inl", STEP: { name: "inl", everyMinutes: 10, maxMinutes: 30, inRound: true }, SETTINGS: [], run: async () => { runs.push("ran inline"); return { ok: true }; } };
  const stepsCtx = { steps: [fakeStep, inline], settings: { server: { state_dir: stateDir }, steps: {} }, main: {}, projects: [], env: {}, settingsDir: "/etc/example", dry: true };
  const restore = enforceReadOnly(), attempts = refused.length;
  let out;
  try { out = await round({ ...f.env, DRY: true }, { ...f.deps, stepsCtx, stepDeps: { systemdRun: () => { runs.push("systemd-run"); return { status: 0 }; }, isActive: () => false, unitResult: () => "" } }); }
  finally { restore(); }
  assert.deepEqual(runs, [], "no step and no unit was started");
  assert.equal(f.launched.length, 0);
  assert.deepEqual(snapshot(stateDir), before, "not one file of the shared state folder changed");
  assert.equal(refused.length, attempts, "the read-only lock never had to refuse anything");
  assert.ok(out.stepStatus && out.stepStatus.alpha, "status.steps is still worked out (and not written)");
  const said = describe(out);
  assert.match(said, /^step alpha: last run fine at 2026-11-18 15:00Z; would launch forge-step-alpha$/m, "one line per step: its last result and what the round would do");
  assert.match(said, /^step inl: never ran; inline: would run in this round$/m);
  // the lock itself: a write outside the temporary folder, and a command that changes something, are refused
  const restore2 = enforceReadOnly();
  try {
    assert.throws(() => fs.writeFileSync("/var/lib/definitely-not-here/x", "x"), /dry run: refused/);
    assert.throws(() => fs.mkdirSync("/etc/definitely-not-here"), /dry run: refused/);
    const cp = await import("node:child_process");
    assert.throws(() => cp.spawnSync("systemd-run", ["--unit=x", "true"]), /dry run: refused/);
    assert.throws(() => cp.spawnSync("systemctl", ["start", "x.service"]), /dry run: refused/);
    assert.throws(() => cp.spawnSync("gh", ["api", "-X", "PATCH", "repos/o/r/issues/1"]), /dry run: refused/);
    assert.throws(() => cp.spawnSync("gh", ["workflow", "run", "x.yml"]), /dry run: refused/);
    assert.throws(() => cp.spawnSync("git", ["-C", "/x", "push"]), /dry run: refused/);
    fs.writeFileSync(path.join(f.root, "inside-tmp.txt"), "scratch is allowed");
  } finally { restore2(); }
  fs.writeFileSync(path.join(f.root, "after.txt"), "writes work again once the lock is lifted");
});

test("no AI at all: recorded, and after six hours Michael gets one plain sentence; nothing launches", async () => {
  const f = fixture();
  f.deps.providers = async () => [];
  const t0 = NOW;
  await round(f.env, { ...f.deps, now: () => t0 });
  assert.equal(f.launched.length, 0);
  await round(f.env, { ...f.deps, now: () => t0 + 6.5 * 3600000 });
  const notices = JSON.parse(fs.readFileSync(f.env.NOTICES_FILE, "utf8")).notices;
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /None of the AIs that keep your factory moving has answered for 6 hours/);
  assert.doesNotMatch(notices[0].text, /[—–]/);
  await round(f.env, { ...f.deps, now: () => t0 + 7 * 3600000 });
  assert.equal(JSON.parse(fs.readFileSync(f.env.NOTICES_FILE, "utf8")).notices.length, 1, "once");
  assert.equal(f.launched.length, 0);
});

test("a question Michael was asked waits for its default instead of asking again", async () => {
  const f = fixture({ questions: [{ heading: "h (#704)", body: "b", issue: 704, at: "2026-11-18T15:00:00Z", default: "Only .com", deadline: "2026-11-19T03:00:00Z" }] });
  await round(f.env, f.deps);
  const d = f.launched.find(l => l.context.TICKET_KEY === `${ID}#1`);
  f.results[d.unit] = { state: "done", report: { cause: "what", summary: "A product choice." } };
  await round(f.env, f.deps);
  assert.equal(f.launched.filter(l => l.context.TICKET_KEY === `${ID}#1`).length, 1, "no michael helper while his question is open");
});

test("words for Michael are plain and name the item", () => {
  const world = { releases: [{ id: ID, tickets: [{ item: 1, issue: 704, title: "Work is ready only when checked" }] }], items: {} };
  const t = tellText({ kind: "parked", ticketKey: `${ID}#1`, since: "2026-11-17T12:00:00Z" }, world, NOW);
  assert.equal(t, "\"Work is ready only when checked\" in Beta 29 has not moved for 28 hours. Mission Control is on it and tries a different way each time; you need to do nothing unless it asks you.");
  const c = contextFor(driverDefaults(TEST_ENV, []), { id: "x", kind: "unit-failed", since: "s", evidence: ["unit x failed"] }, { approachNote: "" }, { releases: [], main: { sha: "abc" } }, []);
  assert.match(c.TICKET, /no ticket/);
  assert.equal(c.HISTORY, "Nothing yet.");
});

test("every round hands the repairs to the cause tickets, and a failure there never stops the round", async () => {
  const f = fixture();
  const seen = [];
  f.deps.causes = async (env, d) => { seen.push({ repo: env.REPO, hasGh: typeof d.gh === "function", hasState: !!d.state, now: d.now }); };
  await round(f.env, f.deps);
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].hasGh, seen[0].hasState, seen[0].now], [true, true, NOW]);
  const g = fixture();
  g.deps.causes = async () => { throw new Error("boom"); };
  const out = await round(g.env, g.deps);
  assert.ok(out.obstacles.length > 0);
  const log = fs.readFileSync(path.join(g.env.STATE_DIR, "decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(log.some(e => e.kind === "cause tickets failed" && /boom/.test(e.why)));
  const d = fixture();
  d.env.DRY = true;
  d.deps.causes = async () => { throw new Error("must not run in a dry run"); };
  await round(d.env, d.deps);
});

test("every round notes the releases it drives for the outside check; a release folder it could not read keeps the last list", async () => {
  const f = fixture();
  await round(f.env, f.deps);
  const state = () => JSON.parse(fs.readFileSync(path.join(f.env.STATE_DIR, "state.json"), "utf8"));
  assert.deepEqual(state().releases, [ID]);
  f.deps.worldDeps = { ...f.deps.worldDeps, readReleases: () => { throw new Error("EIO"); } };
  await round(f.env, f.deps);
  assert.deepEqual(state().releases, [ID], "nothing is concluded from missing data");
});

test("every round counts the hand rescues with the world and the state it has, and a failure there never stops the round", async () => {
  const f = fixture();
  const seen = [];
  f.deps.rescues = async (env, d) => { seen.push({ factories: (d.world.factories || []).length, hasState: !!d.state, now: d.now }); d.notify("rescues:test", "This week the factory needed no hand rescues."); };
  await round(f.env, f.deps);
  assert.deepEqual(seen, [{ factories: 1, hasState: true, now: NOW }]);
  assert.ok(!fs.existsSync(f.env.NOTICES_FILE) || !/needed no hand rescues/.test(fs.readFileSync(f.env.NOTICES_FILE, "utf8")), "the funnel: filed as pending in the round that counted");
  await round(f.env, f.deps); // the next round's flush sends it (the test gate is one reading)
  assert.match(fs.readFileSync(f.env.NOTICES_FILE, "utf8"), /This week the factory needed no hand rescues\./);
  const g = fixture();
  g.deps.rescues = async () => { throw new Error("boom"); };
  const out = await round(g.env, g.deps);
  assert.ok(out.obstacles.length > 0);
  const log = fs.readFileSync(path.join(g.env.STATE_DIR, "decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(log.some(e => e.kind === "rescue count failed" && /boom/.test(e.why)));
  const d = fixture();
  d.env.DRY = true;
  d.deps.rescues = async () => { throw new Error("must not run in a dry run"); };
  await round(d.env, d.deps);
});

// ---- the inventory and the chain inside a real round (2026-11-21)
import { readWorld } from "../world.mjs";
const statusOfRound = env => JSON.parse(fs.readFileSync(path.join(env.STATE_DIR, "status.json"), "utf8"));

test("a poison entry never stops the round: it becomes an unclassified entry on rung 1 and an acting run takes it", async () => {
  const fx = fixture();
  const acts = [];
  fx.deps.stageLook = async () => null; fx.deps.pauses = () => []; fx.deps.expireLocks = () => []; fx.deps.fallbacks = async () => [];
  fx.deps.readWorld = async (e, d) => { const w = await readWorld(e, d); w.openPrs = [{ get repo() { throw new Error("poison"); } }]; return w; };
  fx.deps.launchAct = (e, a, o) => { acts.push(o); };
  await round({ ...fx.env, ACT: { ...fx.env.ACT, ACT_DIR: path.join(fx.root, "acts") } }, fx.deps);
  const st = statusOfRound(fx.env);
  assert.ok(st.rows.some(r => r.id.startsWith("unclassified:") && r.rung === 1), "the poison entry is on rung 1");
  assert.ok(acts.some(o => o.entry.id.startsWith("unclassified:")), "an acting run was started for it");
  assert.ok(st.entries > 1, "the other entries were still classified");
});

test("rung 3 with every transport down stays unannounced and is retried; once a receipt exists it is told, and sent exactly once", async () => {
  const fx = fixture();
  fx.deps.stageLook = async () => null; fx.deps.expireLocks = () => []; fx.deps.fallbacks = async () => [];
  fx.deps.pauses = () => [{ id: "hold", what: "the factory driver is on hold", since: NOW - 30 * 3600000, expiresAt: NaN, line: "maintenance", ownerRef: "Telegram message 7" }];
  fx.deps.deliver = { telegram: async () => ({ ok: false, why: "telegram not reached" }), issue: () => ({ ok: false, why: "github issue: down" }) };
  await round(fx.env, fx.deps);
  let st = statusOfRound(fx.env);
  assert.deepEqual(st.unannounced, ["pause:hold"], "no receipt: not told, and the status file says so");
  assert.match(st.rung3[0].text, /still paused since .*say continue or it stays paused/);
  fx.deps.deliver = { telegram: async () => ({ ok: true, receipt: "42" }), issue: () => ({ ok: true, receipt: "https://github.com/o/w/issues/1" }) };
  await round(fx.env, fx.deps);
  st = statusOfRound(fx.env);
  assert.deepEqual(st.unannounced, []);
  assert.deepEqual(st.rung3[0].receipts, { telegram: "42", github: "https://github.com/o/w/issues/1" }, "both receipts recorded");
  const sent = () => fs.readFileSync(path.join(fx.env.STATE_DIR, "journal.jsonl"), "utf8").split(String.fromCharCode(10)).filter(l => /"t":"notice"/.test(l) && /"telegram"/.test(l)).length;
  const n1 = sent();
  await round(fx.env, fx.deps);
  assert.equal(sent(), n1, "told once; not sent again every round");
});

test("a zero-receipt owner notice retries its original transports without an acting run", async () => {
  const fx = fixture();
  fx.deps.stageLook = async () => null; fx.deps.expireLocks = () => []; fx.deps.fallbacks = async () => [];
  let now = NOW; fx.deps.now = () => now;
  fx.deps.pauses = () => [{ id: "hold", what: "the factory driver is on hold", since: NOW - 30 * 3600000, expiresAt: NaN, line: "maintenance", ownerRef: "Telegram message 7" }];
  const deliveries = [];
  fx.deps.deliver = {
    telegram: async () => { deliveries.push("telegram"); return deliveries.length > 4 ? { ok: true, receipt: "42" } : { ok: false, why: "telegram down" }; },
    issue: async () => { deliveries.push("github"); return deliveries.length > 4 ? { ok: true, receipt: "https://github.com/o/w/issues/1" } : { ok: false, why: "github down" }; },
  };
  const acts = []; fx.deps.launchAct = (e, a, o) => acts.push(o);
  await round(fx.env, fx.deps);
  fx.deps.pauses = () => [];
  now += 31 * 60000;
  await round(fx.env, fx.deps);
  let events = fs.readFileSync(path.join(fx.env.STATE_DIR, "journal.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  let notices = events.filter(e => e.t === "notice");
  assert.equal(acts.length, 0, "a failed internal delivery retry never consumes an AI acting-run budget");
  assert.equal(notices.length, 2, "the failed retry is appended for audit, never overwrites history");
  assert.equal(notices[1].id, notices[0].id, "a failed retry remains one internal delivery state under the original identity");
  assert.deepEqual(notices[1].receipts, {}, "the failed retry records its missing receipt");
  assert.ok(!notices.some(n => /delivery:/.test(n.id)), "delivery failure never makes an owner delivery notice");
  now += 31 * 60000;
  await round(fx.env, fx.deps);
  events = fs.readFileSync(path.join(fx.env.STATE_DIR, "journal.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  notices = events.filter(e => e.t === "notice");
  assert.equal(acts.length, 0, "receipt recovery remains outside the AI acting-run budget");
  assert.equal(notices.length, 3, "the next bounded retry remains append-only");
  assert.equal(notices[2].id, notices[0].id, "the successful retry keeps the existing notice identity");
  assert.deepEqual(notices[2].receipts, { telegram: "42", github: "https://github.com/o/w/issues/1" }, "a direct receipt clears the zero-receipt condition");
});

test("a legacy zero-receipt notice uses its original timestamp, keeps its ID, and stops after a receipt", async () => {
  const fx = fixture();
  fx.deps.stageLook = async () => null; fx.deps.pauses = () => []; fx.deps.expireLocks = () => []; fx.deps.fallbacks = async () => [];
  let now = NOW; fx.deps.now = () => now;
  const { appendEvents } = await import("../journal.mjs");
  fs.mkdirSync(fx.env.STATE_DIR, { recursive: true });
  const journal = path.join(fx.env.STATE_DIR, "journal.jsonl");
  appendEvents(journal, [{ t: "notice", id: "n:legacy:zero", at: new Date(NOW - 30 * 60000).toISOString(), title: "legacy", text: "delivery failed", receipts: {} }]);
  const calls = [];
  fx.deps.deliver = {
    telegram: async () => { calls.push("telegram"); return { ok: true, receipt: "42" }; },
    issue: async () => { calls.push("github"); return { ok: true, receipt: "https://github.com/o/w/issues/1" }; },
  };
  await round(fx.env, fx.deps);
  let notices = fs.readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse).filter(e => e.t === "notice" && e.id === "n:legacy:zero");
  assert.equal(notices.length, 2, "the original at timestamp made the legacy record due without a deliveryAttemptAt field");
  assert.equal(notices[1].id, notices[0].id, "the direct retry retains the legacy notice identity");
  assert.deepEqual(calls, ["telegram", "github"]);
  now += 31 * 60000;
  await round(fx.env, fx.deps);
  notices = fs.readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse).filter(e => e.t === "notice" && e.id === "n:legacy:zero");
  assert.equal(notices.length, 2, "a receipt stops further direct delivery retries");
  assert.deepEqual(calls, ["telegram", "github"]);
});

test("the acting runs are at most 8 in a rolling day: a full budget waits quietly until capacity returns", async () => {
  const fx = fixture();
  fx.deps.stageLook = async () => null; fx.deps.pauses = () => []; fx.deps.expireLocks = () => []; fx.deps.fallbacks = async () => [];
  const acts = [];
  fx.deps.launchAct = (e, a, o) => { acts.push(o); };
  fx.deps.clockCheck = () => ({ ok: false, ghNow: NOW - 20 * 60000, skewMs: 20 * 60000 }); // the machinery's own entry: the clock is wrong
  fs.mkdirSync(fx.env.STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "state.json"), JSON.stringify({ actRuns: Array.from({ length: 8 }, (_, i) => ({ at: NOW - i * 3600000, entry: `x${i}`, provider: "codex" })) }));
  fx.deps.readWorld = async (e, d) => { const w = await readWorld(e, d); w.queue = [{ repo: REPO, heading: "a question", asked: new Date(NOW - 5 * 3600000).toISOString(), question: "q" }]; w.factories[0].repo = REPO; return w; };
  await round(fx.env, fx.deps);
  assert.equal(acts.length, 0, "no run: the day's budget is spent");
  const st = statusOfRound(fx.env);
  assert.ok(!st.rung3.some(r => r.id === "ob:" || r.id === "clock"), "the machinery's own entry stayed in the acting chain");
  assert.ok(!st.rung3.some(r => r.id.startsWith("queue:")), "the backlog item never did");
  const clock = st.rows.find(r => r.id === "clock");
  assert.equal(clock.deadline, new Date(NOW + 17 * 3600000).toISOString(), "the driver passes its running-record timestamps through to the inventory");
  assert.ok(!fs.existsSync(fx.env.NOTICES_FILE), "a full budget does not call the owner");
  fx.deps.now = () => NOW + 17 * 3600000;
  await round(fx.env, fx.deps);
  assert.equal(acts.length, 1, "the next round launches normally when the earliest run leaves the window");
});

test("a backlog of needs-owner pull requests and queue items never reaches Michael, whatever the budget says, and waits quietly for the next window", async () => {
  const fx = fixture();
  fx.deps.stageLook = async () => null; fx.deps.pauses = () => []; fx.deps.expireLocks = () => []; fx.deps.fallbacks = async () => [];
  fs.mkdirSync(fx.env.STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "state.json"), JSON.stringify({ actRuns: Array.from({ length: 8 }, (_, i) => ({ at: NOW - i * 3600000, entry: `x${i}`, provider: "codex" })) }));
  fx.deps.readWorld = async (e, d) => { const w = await readWorld(e, d); w.factories[0].repo = REPO; w.queue = ["a", "b", "c", "d"].map(h => ({ repo: REPO, heading: `question ${h}`, asked: new Date(NOW - 5 * 3600000).toISOString(), question: "q" })); w.openPrs = [1, 2, 3].map(n => ({ repo: REPO, number: 900 + n, title: `old pr ${n}`, updatedAt: new Date(NOW - 9 * 3600000).toISOString() })); return w; };
  await round(fx.env, fx.deps);
  const st = statusOfRound(fx.env);
  assert.deepEqual(st.rung3.filter(r => /^(queue|pr):/.test(r.id)), [], "none of the seven backlog items reached rung 3");
  assert.equal(fs.existsSync(fx.env.NOTICES_FILE) ? JSON.parse(fs.readFileSync(fx.env.NOTICES_FILE, "utf8")).notices.filter(n => /question [a-d]|old pr/.test(n.text)).length : 0, 0, "Michael was told nothing about them");
});

test("a corrupt state file is moved aside and rebuilt; one release that cannot be evaluated never stops the round", async () => {
  const fx = fixture();
  fx.deps.stageLook = async () => null; fx.deps.pauses = () => []; fx.deps.expireLocks = () => []; fx.deps.fallbacks = async () => [];
  fs.mkdirSync(fx.env.STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "state.json"), "{ this is not json");
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "ledger.json"), "garbage");
  fx.deps.readWorld = async (e, d) => { const w = await readWorld(e, d); w.releases.push({ id: "poison-release", get tickets() { throw new Error("poison"); }, plan: "" }); return w; };
  const out = await round(fx.env, fx.deps);
  assert.ok(fs.readdirSync(fx.env.STATE_DIR).some(n => n.startsWith("state.json.corrupt-")), "the corrupt file was kept aside");
  assert.ok(out.obstacles.some(o => o.kind === "unreadable" && /poison-release/.test(JSON.stringify(o.evidence))), "the poison release is an unreadable obstacle, which escalates");
  assert.ok(statusOfRound(fx.env).entries > 1, "the other release was still evaluated and the status file written");
});

test("notices an older version sent about backlog (and bundles of it) are retired: never resent, never counted as undelivered", async () => {
  const fx = fixture();
  fx.deps.stageLook = async () => null; fx.deps.pauses = () => []; fx.deps.expireLocks = () => []; fx.deps.fallbacks = async () => [];
  fx.deps.now = () => Date.parse("2026-11-22T02:00:00.000Z");
  const { appendEvents } = await import("../journal.mjs");
  fs.mkdirSync(fx.env.STATE_DIR, { recursive: true });
  const at = "2026-11-22T00:45:00.000Z";
  const falseBudgetText = "6 things are stuck: none of them has been tried yet; 6 were not attempted yet because today's budget of automatic repair runs is spent.";
  appendEvents(path.join(fx.env.STATE_DIR, "journal.jsonl"), [
    { t: "notice", id: "n:pr:o/r#95:1", at, title: "old", text: "x has not moved for 9 hours. Mission Control has not attempted it yet: today's budget of automatic repair runs is spent. It", receipts: { telegram: "1" } },
    { t: "notice", id: "n:bundle:abc:5", at, title: "old", text: falseBudgetText, receipts: {} },
    { t: "notice", id: "n:bundle:after-cutoff:6", at: "2026-11-22T01:15:00.000Z", title: "old", text: falseBudgetText, receipts: {} },
    { t: "notice", id: "n:ob:keep:1", at, title: "real", text: "something real that was told", receipts: { telegram: "2" } },
  ]);
  fx.deps.deliver = { telegram: async () => ({ ok: true, receipt: "9" }), issue: () => ({ ok: true, receipt: "https://github.com/o/w/issues/9" }) };
  await round(fx.env, fx.deps);
  const events = fs.readFileSync(path.join(fx.env.STATE_DIR, "journal.jsonl"), "utf8").split(String.fromCharCode(10)).filter(Boolean).map(JSON.parse);
  assert.equal(events.filter(e => e.t === "seen" && e.id === "n:bundle:after-cutoff:6" && /false alarm/.test(e.why || "")).length, 1, "the post-cutoff false alarm is append-only retired");
  assert.equal(events.filter(e => e.t === "notice" && e.id === "n:bundle:after-cutoff:6").length, 1, "the post-cutoff zero-receipt false alarm is never direct-retried");
  assert.equal(events.filter(e => e.t === "seen" && /false alarm/.test(e.why || "")).length, 3, "both older false alarms and the post-cutoff false alarm are retired, the real notice kept");
  assert.ok(!statusOfRound(fx.env).rows.some(r => r.id.startsWith("delivery:")), "and no delivery entry");
});

test("one unreadable answer about the installed release is a blip, three in a row is a fault", async () => {
  const fx = fixture();
  fx.deps.stageLook = async () => null; fx.deps.pauses = () => []; fx.deps.expireLocks = () => []; fx.deps.fallbacks = async () => [];
  const { appendEvents } = await import("../journal.mjs");
  fs.mkdirSync(fx.env.STATE_DIR, { recursive: true });
  appendEvents(path.join(fx.env.STATE_DIR, "journal.jsonl"), [{ t: "approved", release: "godspeed-9.9.9-x", plan: "x", at: "2026-11-20T00:00:00Z", tickets: [] }, { t: "installed", release: "godspeed-9.9.9-x", version: "9.9.9", commit: "abc", at: "2026-11-20T01:00:00Z" }]);
  fx.deps.verifyInstalled = () => ({ ok: false, why: "the running Godspeed did not answer healthy just now" });
  const faults = async () => { await round(fx.env, fx.deps); return statusOfRound(fx.env).rows.filter(r => /coverage proof failed for godspeed-9.9.9-x/.test(r.title)).length; };
  assert.equal(await faults(), 0, "first unreadable answer: a blip"); assert.equal(await faults(), 0, "second: still a blip");
  assert.equal(await faults(), 1, "third in a row: a fault");
  fx.deps.verifyInstalled = () => ({ ok: true, version: "9.9.9", commit: "abc" });
  assert.equal(await faults(), 0, "an answer again: the count starts over");
});

test("THE GATE in the driver: a message needs 3 readings 10 minutes apart and a fresh re-read that confirms it with nothing unreadable; reminders are exempt", async () => {
  const fx = fixture();
  fx.deps.stageLook = async () => null; fx.deps.expireLocks = () => []; fx.deps.fallbacks = async () => [];
  fx.deps.pauses = () => [{ id: "hold", what: "the factory driver is on hold", since: NOW - 30 * 3600000, expiresAt: NaN, line: "x", ownerRef: "Telegram message 7" }]; // a reminder
  fx.deps.clockCheck = () => ({ ok: false, ghNow: NOW - 20 * 60000, skewMs: 20 * 60000 }); // a machinery entry that wants a message
  fs.mkdirSync(fx.env.STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "state.json"), JSON.stringify({ actRuns: Array.from({ length: 8 }, (_, i) => ({ at: NOW - i * 3600000, entry: `x${i}`, provider: "codex" })), chain: { clock: { rung: 2, rungSince: NOW - 2 * 3600000, milestone: NOW + 24 * 3600000, launched: true, told: false, tries: [{ rung: 1, result: "unresolved" }, { rung: 2, result: "unresolved" }] } } }));
  fx.deps.gateCfg = { reads: 3, gapMs: 10 * 60000, toleranceMs: 60000 };
  let sure = true; fx.deps.recheck = async ids => (sure ? new Set(ids) : new Set());
  const notices = () => (fs.existsSync(fx.env.NOTICES_FILE) ? JSON.parse(fs.readFileSync(fx.env.NOTICES_FILE, "utf8")).notices : []);
  const at = min => { fx.deps.now = () => NOW + min * 60000; };
  at(0); await round(fx.env, fx.deps);
  assert.ok(notices().some(n => /still paused/.test(n.text)), "the reminder is exempt: it went out on the first reading");
  assert.ok(!notices().some(n => /clock/.test(n.text) || /has not moved/.test(n.text)), "the machinery message did not: one reading");
  at(5); await round(fx.env, fx.deps); assert.ok(!notices().some(n => /has not moved/.test(n.text)), "5 minutes later is not a second reading");
  at(10); await round(fx.env, fx.deps); assert.ok(!notices().some(n => /has not moved/.test(n.text)), "second reading");
  sure = false; at(20); await round(fx.env, fx.deps);
  assert.ok(!notices().some(n => /has not moved/.test(n.text)), "third reading, but the fresh re-read did not confirm it (or a source was unreadable): held");
  sure = true; at(25); await round(fx.env, fx.deps); at(35); await round(fx.env, fx.deps);
  assert.ok(!notices().some(n => /has not moved/.test(n.text)), "a held message starts the three readings over");
  at(45); await round(fx.env, fx.deps);
  assert.ok(notices().some(n => /has not moved/.test(n.text)), "three new readings 10 minutes apart and the re-read confirms: sent");
});

test("THE FUNNEL in the driver: a request that arrives without the gate (the rescues, a repeated repair, the cut) goes out only after 3 readings 10 minutes apart and a re-read with nothing unreadable", async () => {
  const fx = fixture();
  fx.deps.stageLook = async () => null; fx.deps.pauses = () => []; fx.deps.expireLocks = () => []; fx.deps.fallbacks = async () => [];
  fx.deps.gateCfg = { reads: 3, gapMs: 10 * 60000, toleranceMs: 0 };
  fx.deps.rescues = async (env, d) => { d.notify("rescues:funnel", "Funnel test message."); };
  let okWorld = true; fx.deps.recheck = async () => (okWorld ? new Set() : null);
  const sent = () => fs.existsSync(fx.env.NOTICES_FILE) && /Funnel test message\./.test(fs.readFileSync(fx.env.NOTICES_FILE, "utf8"));
  const at = min => { fx.deps.now = () => NOW + min * 60000; };
  for (const m of [0, 5, 10, 15, 20]) { at(m); await round(fx.env, fx.deps); assert.ok(!sent(), `round at ${m}: not yet (the request was filed at the end of round 0; readings at 5, 15, 25)`); }
  at(25); await round(fx.env, fx.deps); assert.ok(sent(), "three readings 10 minutes apart: sent");
});

test("a resend only happens while the condition the notice was about still holds", async () => {
  const fx = fixture();
  fx.deps.stageLook = async () => null; fx.deps.pauses = () => []; fx.deps.expireLocks = () => []; fx.deps.fallbacks = async () => [];
  const { appendEvents } = await import("../journal.mjs");
  fs.mkdirSync(fx.env.STATE_DIR, { recursive: true });
  appendEvents(path.join(fx.env.STATE_DIR, "journal.jsonl"), [{ t: "notice", id: "n:ob:gone:1", at: new Date(NOW - 3 * 3600000).toISOString(), title: "t", text: "something that no longer holds", receipts: { telegram: "1" }, entries: ["ob:gone"] }]);
  let sent = 0; fx.deps.deliver = { telegram: async () => { sent++; return { ok: true, receipt: "9" }; }, issue: () => ({ ok: true, receipt: "https://github.com/o/w/issues/9" }) };
  await round(fx.env, fx.deps);
  assert.equal(sent, 0, "2 hours passed, but the entry it was about is gone: no repeat");
});

// ---------------------------------------------------------------- the Forge 0.3.1, ticket 03 (#140)
// Godspeed beta.31: ticket 01's issue was closed as completed because its work was already on main, the release step called it a
// dead end and waited for the driver to move it, and the driver, which counted it as done, never did. Now the driver and the release
// step read the App's "Already delivered on main by #N" alike (delivery.mjs), and a ticket closed with nothing named is cut at once.
const MERGE_876 = "5d29db0" + "4".repeat(33);
function closedTicketFixture({ closedAgoMin, comments = [], refs = [], linked = null }) {
  const f = fixture();
  const closedAt = new Date(NOW - closedAgoMin * 60000).toISOString();
  const gh0 = f.deps.gh;
  f.ghCalls = [];
  f.deps.gh = (args, input) => {
    const a = args.join(" ");
    f.ghCalls.push(a);
    if (/issueOrPullRequest\(number: 861\)/.test(a)) return { data: { repository: { a861: { __typename: "Issue", number: 861, state: "CLOSED", closedByPullRequestsReferences: { nodes: [{ number: 876, merged: true, mergedAt: "2026-11-17T10:00:00Z", baseRefName: "main", mergeCommit: { oid: MERGE_876 }, repository: { nameWithOwner: REPO } }] } } } } };
    // the issue as GitHub's GraphQL gives it: its newest comments with their authors' type, and the merged pull requests that mention it
    if (linked && new RegExp(`pulls/${linked.number}$`).test(a)) return { state: "closed", merged_at: "2026-11-17T10:00:00Z", merge_commit_sha: linked.sha, base: { ref: linked.base }, labels: [], head: { sha: `s${linked.number}` } };
    if (/issue\(number: 704\)/.test(a)) return { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: linked ? [{ number: linked.number }] : [] }, timelineItems: { nodes: [] }, refs: { nodes: refs.map(source => ({ source: { __typename: "PullRequest", merged: true, ...source } })) }, comments: { nodes: comments } } } } };
    if (/issues\/704\/comments/.test(a)) return [];
    if (/issues\/704$/.test(a)) return { state: "closed", state_reason: "completed", closed_at: closedAt, labels: [] };
    return gh0(args, input);
  };
  // the records repository holds the plan and its tickets, so the cut can write its amendment
  f.records.read = p => (/plan\.md$/.test(p) ? PLAN : null);
  f.records.ticketFiles = () => TICKETS.map(t => `releases/${ID}/tickets/${t}`);
  f.deps.stageLook = async () => null; f.deps.pauses = () => []; f.deps.expireLocks = () => []; f.deps.fallbacks = async () => [];
  return f;
}
const amendmentWrites = f => f.records.writes.filter(w => Object.keys(w.files).some(k => /scope-amendment\.json$/.test(k)));

test("ticket 03: a ticket whose issue was closed as completed with nothing named is moved by the driver's cut in the next round", async () => {
  const f = closedTicketFixture({ closedAgoMin: 2 });
  const first = await round(f.env, f.deps);
  assert.ok(!first.obstacles.some(o => o.kind === "dead-end"), "closed two minutes ago: a delivery may still be named this round");
  assert.equal(amendmentWrites(f).length, 0);
  f.deps.now = () => NOW + 5 * 60000; f.deps.worldDeps.now = () => NOW + 5 * 60000;
  const second = await round(f.env, f.deps);
  const dead = second.obstacles.find(o => o.kind === "dead-end");
  assert.ok(dead, "the next round: a dead end");
  assert.match(dead.evidence.join(" "), /nothing names where its work is on main/);
  assert.equal(second.steps.find(s => s.obstacle === dead.id).do, "cut");
  const w = amendmentWrites(f);
  assert.equal(w.length, 1, "and the cut moved it that round");
  assert.deepEqual(JSON.parse(w[0].files[`releases/${ID}/scope-amendment.json`]).amendments.flatMap(a => a.deferredTickets), [TICKETS[0]]);
});

test("ticket 03: the builder App's 'Already delivered on main by #861' (an issue closed by the merged #876) counts as done in the driver: no dead end, no cut, the ticket resolved; the same words by a person are nothing named", async () => {
  const said = __typename => [{ author: { login: "godspeed-dev-builder", __typename }, body: "Already delivered on main by #861 with #590 and #795." }];
  const f = closedTicketFixture({ closedAgoMin: 120, comments: said("Bot") });
  const out = await round(f.env, f.deps);
  assert.ok(!out.obstacles.some(o => o.kind === "dead-end"), "two hours after the close, still not a dead end: it is delivered");
  assert.equal(amendmentWrites(f).length, 0, "nothing cut");
  assert.equal(out.world.items[704].delivered.commit, MERGE_876, "the merge of #876 is its delivery");
  const events = fs.readFileSync(path.join(f.env.STATE_DIR, "journal.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(events.some(e => e.t === "slot" && e.release === ID && e.slot === "t:1:resolved"), "the journal counts ticket 1 as resolved");
  assert.ok(events.some(e => e.t === "slot" && e.release === ID && e.slot === "t:1:merged" && e.commit === MERGE_876));
  const person = closedTicketFixture({ closedAgoMin: 120, comments: said("User") });
  const out2 = await round(person.env, person.deps);
  assert.ok(!person.ghCalls.some(a => /issueOrPullRequest/.test(a)), "a person's comment is not even looked up");
  assert.ok(out2.obstacles.some(o => o.kind === "dead-end"), "a person who took the App's name is not the App: nothing is named");
  assert.equal(amendmentWrites(person).length, 1);
});

test("ticket 03: rung 0 writes the done line of a ticket the App delivered, from the merge GitHub confirms", async () => {
  const { rung0 } = await import("../duties.mjs");
  const world = { releases: [{ id: ID, tickets: [{ item: 1, issue: 704, file: TICKETS[0] }] }], items: { 704: { number: 704, state: "closed", prs: [], delivered: { number: 876, commit: MERGE_876, mergedAt: "2026-11-17T10:00:00Z" } } } };
  const wrote = [];
  const out = await rung0({ REPO }, world, {}, NOW, () => ({ status: 0, stdout: "enabled" }), async (rel, t, sha) => { wrote.push([rel.id, t.item, sha]); return true; });
  assert.deepEqual(wrote, [[ID, 1, MERGE_876]]);
  assert.match(out[0].did, /wrote the done line of item 1 \(merge 5d29db0\)/);
});

test("ticket 03: a ticket closed as completed that a merged pull request into main only mentions is done for the driver, and rung 0 writes its done line from that merge, so the release step counts it done too", async () => {
  const f = closedTicketFixture({ closedAgoMin: 120, refs: [{ number: 876, mergedAt: "2026-11-17T10:00:00Z", baseRefName: "main", mergeCommit: { oid: MERGE_876 }, repository: { nameWithOwner: REPO } }] });
  const wrote = [];
  const { rung0 } = await import("../duties.mjs");
  f.deps.rung0 = (env, world, state, now, run, write) => rung0(env, world, state, now, () => ({ status: 0, stdout: "enabled" }), write);
  f.records.read = p => (/plan\.md$/.test(p) ? PLAN : /tickets\//.test(p) ? "# a ticket\n" : null);
  const out = await round(f.env, f.deps);
  assert.ok(!out.obstacles.some(o => o.kind === "dead-end"), "never cut: its change is on main");
  for (const w of f.records.writes) for (const [file, text] of Object.entries(w.files)) if (/tickets\//.test(file)) wrote.push([file, text.split("\n")[0]]);
  assert.deepEqual(wrote, [[`releases/${ID}/tickets/${TICKETS[0]}`, `Status: done (merge ${MERGE_876})`]], "the done line, which the release step honours, so it never waits for a cut");
});

test("ticket 03: a mention by a pull request merged elsewhere than this repository's main is not the item on main: the driver cuts it, as the release step expects, and never writes a foreign merge as its done line", async () => {
  for (const ref of [{ number: 877, mergedAt: "2026-11-17T10:00:00Z", baseRefName: "beta", mergeCommit: { oid: "b".repeat(40) }, repository: { nameWithOwner: REPO } },
    { number: 12, mergedAt: "2026-11-17T10:00:00Z", baseRefName: "main", mergeCommit: { oid: "c".repeat(40) }, repository: { nameWithOwner: "someone/else" } }]) {
    const f = closedTicketFixture({ closedAgoMin: 120, refs: [ref] });
    const { rung0 } = await import("../duties.mjs");
    f.deps.rung0 = (env, world, state, now, run, write) => rung0(env, world, state, now, () => ({ status: 0, stdout: "enabled" }), write);
    const out = await round(f.env, f.deps);
    assert.ok(out.obstacles.some(o => o.kind === "dead-end"), `${ref.repository.nameWithOwner}#${ref.number} into ${ref.baseRefName}: a dead end`);
    assert.equal(amendmentWrites(f).length, 1, "moved by the cut");
    assert.ok(!f.records.writes.some(w => Object.keys(w.files).some(k => /tickets\//.test(k))), "no done line from it");
  }
});

test("ticket 03: a linked pull request merged into another branch than main is not the item on main either: no done line from it, and the driver cuts the ticket as the release step expects", async () => {
  const f = closedTicketFixture({ closedAgoMin: 120, linked: { number: 880, base: "beta", sha: "e".repeat(40) } });
  const { rung0 } = await import("../duties.mjs");
  f.deps.rung0 = (env, world, state, now, run, write) => rung0(env, world, state, now, () => ({ status: 0, stdout: "enabled" }), write);
  const out = await round(f.env, f.deps);
  assert.equal(out.world.items[704].prs[0].base, "beta");
  assert.ok(out.obstacles.some(o => o.kind === "dead-end"), "a dead end");
  assert.ok(!f.records.writes.some(w => Object.keys(w.files).some(k => /tickets\//.test(k))), "no done line from a merge into beta");
  assert.equal(amendmentWrites(f).length, 1, "moved by the cut");
  const main = closedTicketFixture({ closedAgoMin: 120, linked: { number: 881, base: "main", sha: "d".repeat(40) } });
  const out2 = await round(main.env, main.deps);
  assert.ok(!out2.obstacles.some(o => o.kind === "dead-end"), "the same pull request merged into main: done");
});

