// test cases: 113
import "./settings-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, runCases } from "../case-test.mjs";
import * as A from "../../../steps/release/auto-stage.mjs";
import * as D from "../../../steps/release/auto-drive.mjs";
import { readDeferrals } from "../../../steps/release/scope-amendment.mjs";
import * as G from "../../../steps/release/staging.mjs";
import * as R from "../../../steps/release/release-api.mjs";
import { PRODUCT_REPO } from "../../../steps/release/staging.mjs";

const REPO = PRODUCT_REPO;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "auto-stage-test-"));

const planFor = (extra = "", status = "approved by Michael on 2026-11-13") =>
  `---\nrelease: godspeed-2.0.0-beta.25-demo\nrepository: ${REPO}\n---\n\n# Godspeed 2.0.0-beta.25: demo release\n\nStatus: ${status}\n\n${extra}\n- Issues: item 1 #101, 2 #102, each labelled \`beta.25\`.\n`;

// ---------- which release ----------

test("the version comes from the folder name", () => {
  assert.equal(A.releaseVersion("godspeed-2.0.0-beta.24-never-empty-handed"), "2.0.0-beta.24");
  assert.equal(A.releaseVersion("godspeed-2.0.0-beta.18.1-first-day-works"), "2.0.0-beta.18.1");
  assert.equal(A.releaseVersion("godspeed-clerk-fixes"), null);
});

test("it picks the newest approved release without a staging record, never a promoted or staged one", () => {
  const r = (id, plan, hasStaging = false) => ({ id, plan, hasStaging });
  const a = r("godspeed-2.0.0-beta.24-x", planFor("", "approved by Michael").replace("beta.25", "beta.24"), true);
  const b = r("godspeed-2.0.0-beta.25-x", planFor());
  const old = r("godspeed-2.0.0-beta.20-x", planFor().replace("beta.25", "beta.20"));
  const draft = r("godspeed-2.0.0-beta.26-x", planFor("", "proposed"));
  const other = r("godspeed-2.0.0-beta.27-x", planFor().replace(REPO, "MichaelZelbel/godspeed-clerk"));
  const all = [a, b, old, draft, other];
  assert.equal(A.pickRelease({ releases: all, publicVersion: "2.0.0-beta.23" }).pick.id, b.id);
  assert.equal(A.pickRelease({ releases: [a, old, draft], publicVersion: "2.0.0-beta.23" }).pick, null, "staged, old, unapproved: nothing");
  assert.match(A.pickRelease({ releases: [a], publicVersion: "2.0.0-beta.23" }).why, /already staged/);
  assert.equal(A.pickRelease({ releases: [b], publicVersion: "2.0.0-beta.25" }).pick, null, "already public");
  const c = { ...b, hasStaging: true };
  assert.equal(A.pickRelease({ releases: [c], inProgress: [c.id], publicVersion: "2.0.0-beta.23" }).pick.id, c.id, "a release it started is resumed after its record exists");
});

test("an approved release older than the version installed on the owner's server is superseded and skipped", () => {
  // 18 November 2026: beta.27 stayed approved (its version pull request #725 closed unmerged) after beta.28
  // was installed, and every look picked it and said needs-judgment, which can keep the next release waiting
  const r = (v, hasStaging = false) => ({ id: `godspeed-${v}-x`, plan: planFor().replace(/beta\.25/g, v.replace("2.0.0-", "")), hasStaging });
  const b27 = r("2.0.0-beta.27"), b28 = r("2.0.0-beta.28", true), b29 = r("2.0.0-beta.29");
  const none = A.pickRelease({ releases: [b27, b28], publicVersion: "2.0.0-beta.26", installedVersion: "2.0.0-beta.28" });
  assert.equal(none.pick, null);
  assert.deepEqual(none.superseded.map((x) => x.id), [b27.id]);
  assert.equal(A.pickRelease({ releases: [b27, b28, b29], publicVersion: "2.0.0-beta.26", installedVersion: "2.0.0-beta.28" }).pick.id, b29.id, "a newer one still goes");
  assert.equal(A.pickRelease({ releases: [b27, b28], publicVersion: "2.0.0-beta.26" }).pick.id, b27.id, "nothing installed known: as before");
  assert.equal(A.pickRelease({ releases: [{ ...b27, hasStaging: true }], inProgress: [b27.id], publicVersion: "2.0.0-beta.26", installedVersion: "2.0.0-beta.28" }).pick, null, "even one it started");
  assert.equal(A.installedVersion([{ id: b27.id, staging: null }, { id: b28.id, staging: { status: "installed" } }, { id: "godspeed-2.0.0-beta.26-x", staging: { status: "installed" } }, { id: b29.id, staging: { status: "failed" } }]), "2.0.0-beta.28");
  assert.equal(A.installedVersion([{ id: b27.id, staging: null }]), null);
});

// ---------- the completeness check ----------

const ticket = (n, body = "Ticket text.\n") => ({ file: `releases/x/tickets/0${n}-t.md`, body });
const issue = (state, reason = "COMPLETED", merges = [{ number: 5, mergedAt: "2026-11-13T10:00:00Z", commit: "a".repeat(40) }]) => ({ state, stateReason: reason, merges });

test("the plan's Issues line links ticket numbers to issues", () => {
  assert.deepEqual(A.itemIssues(planFor()), { 1: 101, 2: 102 });
  assert.deepEqual(A.itemIssues("- Issues: items 1 #452, 2 #372, 3 #262, 5 #453 (replaces #391), 6 #415 (owner ruling"), { 1: 452, 2: 372, 3: 262, 5: 453, 6: 415 });
});

test("every issue closed and merged is complete, and the merge commit comes from the closing pull request", () => {
  const v = A.judgeCompleteness({ tickets: [ticket(1), ticket(2)], plan: planFor(), issues: { 101: issue("CLOSED"), 102: issue("CLOSED", "COMPLETED", [{ number: 6, mergedAt: "2026-11-13T09:00:00Z", commit: "b".repeat(40) }, { number: 7, mergedAt: "2026-11-13T11:00:00Z", commit: "c".repeat(40) }]) } });
  assert.equal(v.state, "complete");
  assert.deepEqual(v.marks.map((m) => [m.issue, m.merge[0]]), [[101, "a"], [102, "c"]], "the newest merged pull request counts");
});

test("an open issue means wait, even when another ticket needs a person", () => {
  const v = A.judgeCompleteness({ tickets: [ticket(1), ticket(2)], plan: planFor(), issues: { 101: issue("OPEN"), 102: issue("CLOSED", "NOT_PLANNED") } });
  assert.equal(v.state, "waiting");
  assert.deepEqual(v.waitingOn, ["#101"]);
});

test("an open issue with the release label that is no ticket also means wait", () => {
  const v = A.judgeCompleteness({ tickets: [ticket(1)], plan: planFor(), issues: { 101: issue("CLOSED") }, extraOpen: [300] });
  assert.equal(v.state, "waiting");
  assert.deepEqual(v.waitingOn, ["#300"]);
});

test("a cut item, a closed issue without a merge, or a ticket without an issue is a person's decision", () => {
  const cut = A.judgeCompleteness({ tickets: [ticket(1)], plan: planFor(), issues: { 101: issue("CLOSED", "NOT_PLANNED") } });
  assert.equal(cut.state, "judgment");
  assert.match(cut.reasons[0], /closed without being done/);
  const nomerge = A.judgeCompleteness({ tickets: [ticket(1)], plan: planFor(), issues: { 101: issue("CLOSED", "COMPLETED", []) } });
  assert.equal(nomerge.state, "judgment");
  assert.match(nomerge.reasons[0], /no merged change on main/);
  const none = A.judgeCompleteness({ tickets: [ticket(3)], plan: planFor(), issues: {} });
  assert.equal(none.state, "judgment");
  assert.match(none.reasons[0], /no issue named/);
});

test("a ticket the release step already marked done is not asked about again", () => {
  const done = ticket(1, `Status: done (merge ${"d".repeat(40)})\n\nText\n`);
  const v = A.judgeCompleteness({ tickets: [done], plan: planFor(), issues: {} });
  assert.equal(v.state, "complete");
  assert.equal(v.marks.length, 0);
});

test("the reasons are written for him: the plan's item, no file names or issue numbers", () => {
  const v = A.judgeCompleteness({ tickets: [ticket(1), ticket(3)], plan: planFor(), issues: { 101: issue("CLOSED", "NOT_PLANNED") } });
  assert.equal(v.state, "judgment");
  assert.deepEqual(v.reasons, ["item 1 of the plan was closed without being done (not planned)", "item 3 of the plan has no issue named in the plan"]);
});

test("only a merged pull request of the product into main counts, never another repository's", () => {
  const other = { number: 9, mergedAt: "2026-11-13T12:00:00Z", commit: "9".repeat(40), repo: "someone/else", base: "main" };
  const onBranch = { number: 8, mergedAt: "2026-11-13T12:30:00Z", commit: "8".repeat(40), repo: REPO, base: "dev" };
  const mine = { number: 7, mergedAt: "2026-11-13T09:00:00Z", commit: "7".repeat(40), repo: REPO, base: "main" };
  const v = A.judgeCompleteness({ tickets: [ticket(1)], plan: planFor(), repo: REPO, issues: { 101: issue("CLOSED", "COMPLETED", [other, onBranch, mine]) } });
  assert.equal(v.state, "complete");
  assert.equal(v.marks[0].merge, "7".repeat(40));
  const none = A.judgeCompleteness({ tickets: [ticket(1)], plan: planFor(), repo: REPO, issues: { 101: issue("CLOSED", "COMPLETED", [other, onBranch]) } });
  assert.equal(none.state, "judgment");
});

test("a ticket that says it belongs to another repository is a person's", () => {
  const v = A.judgeCompleteness({ tickets: [ticket(1, "Repository: MichaelZelbel/godspeed-workouts\n\nText\n")], plan: planFor(), repo: REPO, issues: { 101: issue("CLOSED") } });
  assert.equal(v.state, "judgment");
  assert.match(v.reasons[0], /belongs to another repository/);
});

test("a ticket a person deferred (scope-amendment.json) is not waited for", () => {
  const v = A.judgeCompleteness({ tickets: [ticket(1), ticket(2)], plan: planFor(), repo: REPO, deferred: ["02-t.md"], issues: { 101: issue("CLOSED"), 102: issue("OPEN", null, []) } });
  assert.equal(v.state, "complete");
  assert.equal(v.marks.length, 1);
});

test("the status line goes first, replacing an old one", () => {
  const m = "e".repeat(40);
  assert.equal(A.markTicket("Ticket text.\n", m), `Status: done (merge ${m})\n\nTicket text.\n`);
  assert.equal(A.markTicket("Status: in review\n\nText\n", m), `Status: done (merge ${m})\n\nText\n`);
});

// ---------- what the plan says is done by hand ----------

test("a step the plan says Mission Control does by hand stops it; history and the proceed line do not", () => {
  const beta24 = planFor("- The scenario for item 3 needs a workflow job under `.github/`, which the factory cannot touch: Mission Control adds it by hand once item 3's pull request says what it should do.");
  assert.match(A.planNeedsHand(beta24), /adds it by hand once item 3/);
  assert.equal(A.planNeedsHand(planFor("Mission Control restored 41 files by hand from the laptop; nothing else.")), null);
  assert.equal(A.planNeedsHand(planFor("75 laps, 20 pull requests merged by the runner plus 5 by hand (#481 update workflow job).")), null);
  assert.equal(A.planNeedsHand(planFor("The version bump has to be opened by hand, because the builder App was not allowed to touch package.json.")), null, "the version is the release step's own pull request now, never a hand step");
  assert.match(A.planNeedsHand(planFor("The workflow job under .github/ has to be added by hand, because the builder App was not allowed to touch it.")) || "", /has to be added by hand/, "a was in the sentence does not hide a step still ahead");
  assert.equal(A.planNeedsHand(`${beta24}\nAuto-stage: proceed\n`), null, "the person who did the hand step says so");
  assert.equal(A.planNeedsHand(`${beta24}\n## Release step (2026-11-14)\n\nthe version went in by hand.\n`) !== null, true, "text after the release step log does not hide a step before it");
});

test("freeze refusals come out in everyday words", () => {
  const v = A.freezeRefusalWords("/x/windows-manifest.json says version 2.0.0-beta.24, not 2.0.0-beta.25.", "2.0.0-beta.25");
  assert.match(v.words, /still says it is version 2\.0\.0-beta\.24 instead of 2\.0\.0-beta\.25/);
  assert.equal(v.waits, false);
  assert.equal(A.freezeRefusalWords("GitHub holds no Windows setup built for commit abcdef0 (no artifact windows-setup-x)", "v").waits, true);
});

// ---------- state ----------

test("state is read, saved atomically and refused when damaged", () => {
  const dir = tmp();
  const file = path.join(dir, "sub", "state.json");
  assert.deepEqual(A.loadState(file), { version: 1, releases: {} });
  const s = A.loadState(file);
  A.releaseState(s, "r1").started = "2026-11-14T00:00:00Z";
  A.saveState(file, s);
  assert.equal(A.loadState(file).releases.r1.started, "2026-11-14T00:00:00Z");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"], "no temporary file is left");
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => A.loadState(file), /cannot be read/);
});

test("the notice queue says each id once and keeps what was queued", () => {
  const dir = tmp();
  const file = path.join(dir, "notices.json");
  assert.equal(A.queueNotice(file, { id: "a", text: "one", about: "x" }), true);
  assert.equal(A.queueNotice(file, { id: "a", text: "one again", about: "x" }), false);
  assert.equal(A.queueNotice(file, { id: "b", text: "two", about: "y" }), true);
  const q = JSON.parse(fs.readFileSync(file, "utf8")).notices;
  assert.deepEqual(q.map((n) => [n.id, n.written]), [["a", true], ["b", true]]);
  fs.writeFileSync(file, "garbage");
  assert.throws(() => A.queueNotice(file, { id: "c", text: "three", about: "z" }));
  assert.throws(() => A.queueNotice(path.join(dir, "nowhere", "n.json"), { id: "d", text: "x", about: "y" }), /no Godspeed here/);
});

// ---------- the factory's STOP file ----------

test("STOP: made once, removed by the one that made it, never someone else's", () => {
  const dir = tmp();
  const stop = path.join(dir, ".factory", "STOP");
  assert.equal(A.createStop(stop, Date.now()), false, "no factory folder here: nothing to pause, and no folder is made");
  assert.equal(fs.existsSync(path.dirname(stop)), false);
  fs.mkdirSync(path.dirname(stop));
  assert.equal(A.createStop(stop, Date.now()), true);
  assert.equal(A.createStop(stop, Date.now()), false, "an existing STOP is not taken over");
  assert.equal(A.stopIsMine(stop), true);
  assert.equal(A.removeStop(stop), true);
  assert.equal(fs.existsSync(stop), false);
  fs.writeFileSync(stop, "the owner paused the factory\n");
  assert.equal(A.removeStop(stop), false);
  assert.equal(fs.existsSync(stop), true, "someone else's STOP stays");
  assert.deepEqual(A.guardStaleStop(stop, Date.now() + 10 * 3600 * 1000, 120), { removed: false });
  assert.equal(fs.existsSync(stop), true);
});

test("STOP: one of ours older than the limit is removed at the next look, a young one stays", () => {
  const dir = tmp();
  const stop = path.join(dir, "STOP");
  A.createStop(stop, Date.now());
  const young = A.guardStaleStop(stop, Date.now() + 30 * 60 * 1000, 120);
  assert.equal(young.removed, false);
  assert.equal(fs.existsSync(stop), true);
  const old = A.guardStaleStop(stop, Date.now() + 3 * 3600 * 1000, 120);
  assert.equal(old.removed, true);
  assert.equal(fs.existsSync(stop), false);
});

// ---------- why a test failed, in everyday words ----------

const rateLimitLog = [
  "2026-11-14T13:50:01.000Z Asked about a public repository (try 1 of 3): GitHub answered 403 to https://api.github.com/repos/octocat/Hello-World (x-ratelimit-remaining: 0)",
  '2026-11-14T13:50:02.000Z FAIL two-machines-move-at-once: the live GitHub privacy check, asked about a public repository: the product refused it with "GitHub is limiting requests from this network right now" ; GitHub answered 403 to https://api.github.com/repos/octocat/Hello-World (x-ratelimit-remaining: 0)',
  "2026-11-14T13:50:03.000Z ##[error]Process completed with exit code 1.",
].join("\n");
const charmLog = [
  '2026-11-14T13:46:10.634Z   charm-log | {"verdict":"ask","why":"model-request-failed"}',
  "2026-11-14T13:47:10.000Z FAIL charm-challenge: on the day it started, the card on the Trackers shelf says 0 restarts and the chat says ",
  "2026-11-14T13:47:11.000Z ##[error]Process completed with exit code 1.",
].join("\n");

test("the cause is read from the job's FAIL line and sorted into test machines or the release", () => {
  const rate = A.classifyFailure(rateLimitLog, "two computers that move the same reminders at once");
  assert.equal(rate.environment, true);
  assert.match(rate.plain, /GitHub limited how many requests/);
  const charm = A.classifyFailure(charmLog, "the Charm Challenge, start to finish");
  assert.equal(charm.environment, true);
  assert.match(charm.plain, /chat answer came back empty/);
  const real = A.classifyFailure("2026-11-14T13:00:00Z FAIL talk-prep: the opening said 'Hello' instead of the prepared sentence https://x.example/abc\n", "a talk");
  assert.equal(real.environment, false);
  assert.match(real.plain, /^the opening said 'Hello' instead of the prepared sentence$/);
  assert.match(A.classifyFailure("nothing useful\n", "j").plain, /gives no reason/);
});

test("dates read like a person says them", () => {
  assert.equal(A.formatDates(["2026-11-11T02:00:00Z", "2026-11-12T02:00:00Z"]), "11 and 12 November");
  assert.equal(A.formatDates(["2026-10-30T02:00:00Z", "2026-11-01T02:00:00Z"]), "30 October and 1 November");
  assert.equal(A.formatDates(["2026-11-11T02:00:00Z", "2026-11-11T20:00:00Z"]), "11 November");
});

test("the message for failed tests: each test in one sentence, its cause, and whose fault it looks like", () => {
  const rate = A.classifyFailure(rateLimitLog, "x");
  const charm = A.classifyFailure(charmLog, "x");
  const text = A.failureMessage({
    version: "2.0.0-beta.24",
    title: "never empty-handed",
    failures: [
      { job: "two computers that move the same reminders at once", cause: rate, mainDates: [], blocking: false },
      { job: "the Charm Challenge, start to finish", cause: charm, mainDates: ["2026-11-11T03:00:00Z", "2026-11-12T03:00:00Z"], blocking: false },
    ],
  });
  assert.match(text, /^2\.0\.0-beta\.24 \(never empty-handed\) is on your server and healthy, but 2 tests did not pass\./);
  assert.match(text, /"two computers that move the same reminders at once": GitHub limited how many requests the shared test machines could make\. That looks like a problem with the test machines, not with this release\./);
  assert.match(text, /"the Charm Challenge, start to finish": the chat answer came back empty\. The same test also failed on main on 11 and 12 November, so it is not new with this release\./);
  assert.match(text, /Shall I make it public anyway\?/);
  assert.doesNotMatch(text, /[—–]/, "no dash that reads as machine writing");
  assert.doesNotMatch(text, /\bscenarios?\b|#\d|\.mjs|[0-9a-f]{12,}/i, "no jargon, numbers of issues or hashes");
});

test("a failed run that names no test says so and never offers go", () => {
  const text = A.failureMessage({ version: "2.0.0-beta.25", failures: [] });
  assert.match(text, /names no single test/);
  assert.doesNotMatch(text, /Shall I make it public|0 tests/);
});

test("a failed test of the release's own features says it holds the release back; an unknown cause says so", () => {
  const text = A.failureMessage({
    version: "2.0.0-beta.25",
    failures: [{ job: "a talk always starts", cause: { plain: "the opening was wrong", environment: false }, mainDates: [], blocking: true }],
  });
  assert.match(text, /one test did not pass/);
  assert.match(text, /I cannot tell yet whether this release caused it\./);
  assert.match(text, /holds the release back unless you accept it/);
  assert.doesNotMatch(text, /Shall I make it public anyway/);
});

// ---------- one look, with everything outside faked ----------

function world({ issues, scenarioSeq, planText = planFor(), staging = null, stateFile, extra = {} }) {
  const dir = tmp();
  const id = "godspeed-2.0.0-beta.25-demo";
  const files = new Map([
    [`releases/${id}/plan.md`, planText],
    [`releases/${id}/tickets/01-a.md`, "Ticket one.\n"],
    [`releases/${id}/tickets/02-b.md`, "Ticket two.\n"],
  ]);
  if (staging) files.set(`releases/${id}/staging.json`, JSON.stringify(staging));
  const w = { id, dir, files, calls: [], stopSeenDuring: [], notices: [], tag: null, written: [], scenarioSeq, dispatches: 0, reruns: 0, told: [], extra, staleLeft: extra.staleAfterRerun || 0 };
  const stop = path.join(dir, "factory", "STOP");
  fs.mkdirSync(path.dirname(stop), { recursive: true });
  w.stop = stop;
  // lookMinutes 0: one read per look, as the step did before it kept watching (the fast path's own tests set it)
  const cfg = { ...A.loadConfig({}), repo: REPO, stateDir: dir, stopFile: stop, noticesFile: path.join(dir, "notices.json"), pollSeconds: 0, fastPollSeconds: 0, lookMinutes: 0, scenarioWaitMinutes: 5, blockedGraceMinutes: 60, dispatchGraceMinutes: 10, stopMaxAgeMinutes: 120 };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfg.noticesFile, JSON.stringify({ notices: [] }));
  let clock = Date.parse("2026-11-14T10:00:00Z");
  const exits = [];
  const records = {
    releases: () => [id],
    read: (p) => (files.has(p) ? files.get(p) : null),
    json: (p) => (files.has(p) ? JSON.parse(files.get(p)) : null),
    ticketFiles: () => [...files.keys()].filter((k) => k.includes("/tickets/")),
    fetch: () => {},
    write: (changes, message) => {
      for (const [k, v] of Object.entries(changes)) files.set(k, v);
      w.written.push(message);
      return "f".repeat(40);
    },
  };
  const ctx = {
    cfg, env: {}, log: (s) => (w.log ||= []).push(s), dry: false, records, only: null,
    state: stateFile ? A.loadState(stateFile) : { version: 1, releases: {} },
    stateFile: stateFile || path.join(dir, "state.json"),
    now: () => clock,
    sleep: async (ms) => { clock += Math.max(ms, 1000); },
    onExit: (f) => exits.push(f),
    runExits: () => exits.splice(0).forEach((f) => f()),
    publicVersion: async () => "2.0.0-beta.24",
    tagCommit: async () => w.tag,
    api: async (method, p, body) => {
      if (p === "/graphql") {
        const node = (n) => ({ number: n, state: issues[n].state, stateReason: issues[n].stateReason, closedByPullRequestsReferences: { nodes: issues[n].merges.map((m) => ({ number: m.number, mergedAt: m.mergedAt, mergeCommit: { oid: m.commit } })) } });
        return { ok: true, status: 200, json: { data: { repository: { labelled: { nodes: Object.keys(issues).map((n) => node(Number(n))) }, i101: node(101), i102: node(102) } } } };
      }
      throw new Error(`unexpected api call ${method} ${p}`);
    },
    // main's head, its required check, the builds of a commit: by default all there (the fast path's own tests change them)
    mainTip: async () => w.extra.mainTip || "9".repeat(40),
    checkState: async (sha) => (typeof w.extra.checkState === "function" ? w.extra.checkState(sha) : w.extra.checkState || "passed"),
    rerunChecks: async (sha) => { (w.checkReruns ||= []).push(sha); return 1; },
    buildReady: async (kind, sha) => (w.extra.buildReady ? w.extra.buildReady(kind, sha) : true),
    buildRun: async (kind, sha) => (w.extra.buildRun ? w.extra.buildRun(kind, sha) : null),
    dispatchBuild: async (kind, ref) => { (w.buildDispatches ||= []).push([kind, ref]); },
    gateJobs: async () => (w.extra.gate === undefined ? { missing: true } : w.extra.gate),
    run: async (args) => {
      const name = path.basename(args[0]);
      w.calls.push(`${name}${args.includes("--dry-run") ? " --dry-run" : ""}`);
      w.stopSeenDuring.push([name, fs.existsSync(stop)]);
      if (name === "freeze.mjs") {
        (w.freezeCommits ||= []).push(args[args.indexOf("--commit") + 1]);
        if (w.extra.freezeCheckRefuses && args.includes("--dry-run")) return { code: 1, stdout: "", stderr: `${w.extra.freezeCheckRefuses}\n` };
        if (!args.includes("--dry-run")) w.tag = "1".repeat(40);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (name === "stage-server.mjs") {
        if (w.extra.stageServerThrows) throw new Error("boom");
        if (w.extra.serverDelayMs) await new Promise((r) => setTimeout(r, w.extra.serverDelayMs)); // the install still runs when the scenarios end
        files.set(`releases/${id}/staging.json`, JSON.stringify({ version: args[2], productCommit: "8".repeat(40), status: "installed", installedAt: "2026-11-14T10:30:00Z", healthAfter: { ok: true, version: args[2] } }));
        return { code: 0, stdout: "", stderr: "" };
      }
      if (name === "staging-check.mjs") return { code: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected child ${name}`);
    },
    notify: (n) => { w.notices.push(n); A.queueNotice(cfg.noticesFile, { ...n, facts: [n.text] }); },
    scenarios: async () => {
      const next = w.scenarioSeq.length > 1 ? w.scenarioSeq.shift() : w.scenarioSeq[0];
      return typeof next === "function" ? next(w) : next;
    },
    dispatch: async (tag, opts) => { w.dispatches++; (w.dispatchArgs ||= []).push([tag, opts || {}]); w.stopSeenDuring.push(["dispatch", fs.existsSync(stop)]); },
    rerunFailed: async () => { w.reruns++; },
    runInfo: async () => {
      if (w.extra.runInfoNull) return null;
      if (w.reruns > 0 && w.staleLeft > 0) { w.staleLeft--; return { attempt: 1, status: "completed" }; }
      return { attempt: 1 + w.reruns, status: "completed" };
    },
    tagTime: async () => (w.extra.tagTime === undefined ? null : w.extra.tagTime),
    failedJobs: async () => ["two computers move reminders", "the verdict"],
    failedChecks: async () => null,
    jobLog: async () => rateLimitLog,
    mainFailures: async () => ({}),
    openIssues: async () => { w.listed = (w.listed || 0) + 1; return (w.open ||= []).map((i) => ({ ...i })); },
    fileIssue: async (issue) => {
      w.stopSeenDuring.push(["file", fs.existsSync(stop)]);
      const made = { number: 2000 + (w.filed ||= []).length, url: "x" };
      w.filed.push({ ...issue, number: made.number });
      (w.open ||= []).push({ number: made.number, title: issue.title, body: issue.body });
      return made;
    },
  };
  return { w, ctx, cfg };
}

const closedBoth = {
  101: { state: "CLOSED", stateReason: "COMPLETED", merges: [{ number: 5, mergedAt: "2026-11-13T10:00:00Z", commit: "a".repeat(40) }] },
  102: { state: "CLOSED", stateReason: "COMPLETED", merges: [{ number: 6, mergedAt: "2026-11-13T11:00:00Z", commit: "b".repeat(40) }] },
};
const passed = { result: "passed", run: 7, url: "u", tag: "candidate/2.0.0-beta.25" };
const failed = { result: "failed", run: 7, url: "u", failedJobs: ["two computers move reminders", "the verdict"], tag: "candidate/2.0.0-beta.25" };

test("an unfinished release is waited for: nothing is written, frozen or started", async () => {
  const { w, ctx } = world({ issues: { ...closedBoth, 102: { state: "OPEN", stateReason: null, merges: [] } }, scenarioSeq: [{ result: "none" }] });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "waiting");
  assert.deepEqual(w.written, []);
  assert.deepEqual(w.calls, []);
  assert.equal(w.dispatches, 0);
});

test("a look skips an approved release older than the installed one with one log line, and stages nothing", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }] });
  const id27 = "godspeed-2.0.0-beta.27-sees-it-through", id28 = "godspeed-2.0.0-beta.28-keeps-watch";
  w.files.set(`releases/${id27}/plan.md`, planFor().replace(/beta\.25/g, "beta.27"));
  w.files.set(`releases/${id28}/plan.md`, planFor().replace(/beta\.25/g, "beta.28"));
  w.files.set(`releases/${id28}/staging.json`, JSON.stringify({ version: "2.0.0-beta.28", status: "installed", scenarios: { result: "failed" } }));
  ctx.records = { ...ctx.records, releases: () => [id27, id28] };
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "nothing");
  const said = w.log.filter((l) => /beta\.27/.test(l));
  assert.equal(said.length, 1, w.log.join("\n"));
  assert.match(said[0], /2\.0\.0-beta\.27 is approved but older than 2\.0\.0-beta\.28, which is installed on your server/);
  assert.deepEqual([w.written, w.calls, w.notices, w.dispatches], [[], [], [], 0]);
});

test("a finished release is marked, frozen, run on the tag once, put on the server, and announced by staging-check; the STOP file exists only while it runs", async () => {
  const { w, ctx, cfg } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, { result: "running", run: 7 }, passed] });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "ready");
  assert.equal(w.files.get(`releases/${w.id}/tickets/01-a.md`).split("\n")[0], `Status: done (merge ${"a".repeat(40)})`);
  assert.equal(w.files.get(`releases/${w.id}/tickets/02-b.md`).split("\n")[0], `Status: done (merge ${"b".repeat(40)})`);
  assert.deepEqual(w.calls, ["freeze.mjs --dry-run", "freeze.mjs", "stage-server.mjs", "staging-check.mjs"], "the existing steps, in the role's order, nothing re-implemented");
  assert.equal(w.dispatches, 1);
  assert.deepEqual(w.stopSeenDuring.filter(([n]) => n === "dispatch" || n === "stage-server.mjs").map(([, s]) => s), [true, true], "the factory is paused while the scenarios run and the server is staged");
  assert.equal(fs.existsSync(w.stop), false, "STOP is removed afterwards");
  assert.equal(w.reruns, 0);
  assert.deepEqual(w.notices, [], "staging-check --tell sends the ready message, not this script");
  assert.ok(ctx.state.releases[w.id].finished);
  // the second look has nothing to do
  const again = world({ issues: closedBoth, scenarioSeq: [passed], staging: {} , stateFile: path.join(cfg.stateDir, "state.json") });
  const second = await A.autoStage({ ...again.ctx, state: A.loadState(path.join(cfg.stateDir, "state.json")), records: { ...again.ctx.records, releases: () => [w.id], read: (p) => w.files.get(p) ?? null, json: (p) => (w.files.has(p) ? JSON.parse(w.files.get(p)) : null), ticketFiles: () => [] } });
  assert.match(second.outcome, /nothing|finished/);
  assert.equal(again.w.dispatches, 0);
});

test("failed tests: the failed jobs run once more, then he is told once, and the STOP file is gone", async () => {
  const { w, ctx } = world({
    issues: closedBoth,
    scenarioSeq: [{ result: "none" }, failed, failed, failed],
  });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "failed-tests");
  assert.equal(w.dispatches, 1, "one candidate run");
  assert.equal(w.reruns, 1, "one rerun of the failed jobs only");
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0].text, /1 test did not pass|one test did not pass/);
  assert.match(w.notices[0].text, /GitHub limited how many requests/);
  assert.match(w.notices[0].text, /one test did not pass, and with it the verdict\./, "the summary job is named as failing with the test, not counted as a test");
  // the real message must pass the check record-go.mjs makes of the prompt he saw, for the same failed jobs
  assert.deepEqual(G.jobsPromptMustName(failed.failedJobs), ["two computers move reminders"]);
  for (const job of G.jobsPromptMustName(failed.failedJobs)) assert.ok(w.notices[0].text.includes(job), `the message names ${job}`);
  for (const job of failed.failedJobs) assert.ok(w.notices[0].text.includes(job), `the message names every failed job, ${job}, as beta 24's did`);
  assert.equal(fs.existsSync(w.stop), false);
  // a repeat of the same look never says it twice
  const first = ctx.state.releases[w.id];
  assert.ok(first.told["scenarios-failed"]);
  const ctx2 = { ...ctx, state: A.loadState(ctx.stateFile) };
  const again = await A.autoStage(ctx2);
  assert.match(again.outcome, /finished|nothing/);
  assert.equal(w.notices.length, 1);
  assert.equal(w.reruns, 1);
});

test("a crash while waiting still removes the STOP file", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, () => { throw new Error("boom"); }] });
  await assert.rejects(() => A.autoStage(ctx), /boom/);
  assert.equal(fs.existsSync(w.stop), false);
  assert.equal(w.dispatches, 1);
});

test("a STOP of ours left by a killed look is taken back and removed, not left for two hours", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, passed] });
  A.createStop(w.stop, ctx.now() - 10 * 60 * 1000);
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "ready");
  assert.equal(fs.existsSync(w.stop), false);
});

test("a rerun GitHub does not show yet is not read as the old failure", async () => {
  const done = (w) => (w.reruns > 0 && w.staleLeft <= 0 ? passed : failed);
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, failed, done], extra: { staleAfterRerun: 3 } });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "ready", "the rerun passed; nobody is told the old failure");
  assert.equal(w.reruns, 1);
  assert.deepEqual(w.notices, []);
});

test("trouble putting it on the server is tried again by the next looks, then said once and halted", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, passed], extra: { stageServerThrows: true } });
  const r1 = await A.autoStage(ctx);
  assert.equal(r1.outcome, "waiting");
  assert.equal(w.dispatches, 1);
  const r2 = await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.equal(r2.outcome, "waiting");
  const r3 = await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.equal(r3.outcome, "halted");
  assert.equal(w.dispatches, 1, "the scenarios were never started a second time");
  assert.equal(w.reruns, 0);
  assert.equal(w.notices.length, 0, "a halt is the driver's work: nobody is told from here");
  assert.equal(r3.halt.key, "not-staged");
  assert.match(r3.halt.words, /could not be put on the server after three tries/);
  assert.doesNotMatch(r3.halt.words, /Mission Control|by hand|should look/);
  assert.match(r3.halt.clear, /--step stage --clear-halt not-staged/);
  assert.equal(fs.existsSync(w.stop), false);
});

test("a halt needs no notice queue: a broken queue cannot lose it, and nothing is queued", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }] });
  ctx.dispatch = async () => { w.dispatches++; };
  ctx.notify = () => { throw new Error("no Godspeed here"); };
  const r0 = await A.autoStage(ctx);
  assert.equal(r0.outcome, "waiting", "the run is not visible yet");
  const later = { ...ctx, now: () => ctx.now() + 3600 * 1000, state: A.loadState(ctx.stateFile) };
  const r = await A.autoStage(later);
  assert.equal(r.outcome, "halted");
  assert.equal(r.halt.key, "scenarios-lost");
  const saved = A.loadState(ctx.stateFile).releases[w.id];
  assert.equal(saved.halted.key, "scenarios-lost", "the halt stands in the state until it is cleared");
  assert.equal((saved.told || {})["scenarios-lost"], undefined, "nothing was said");
  assert.equal(w.dispatches, 1);
});

test("a STOP somebody else made is left alone, and the scenarios still run", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, passed] });
  fs.writeFileSync(w.stop, "the owner paused the factory\n");
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "ready");
  assert.equal(fs.existsSync(w.stop), true);
});

test("a crash between starting the scenarios and seeing them never starts a second run", async () => {
  const { w, ctx, cfg } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, { result: "running", run: 7 }] });
  ctx.dispatch = async () => { w.dispatches++; throw new Error("died after the request"); };
  await assert.rejects(() => A.autoStage(ctx), /died after/);
  assert.ok(A.loadState(ctx.stateFile).releases[w.id].dispatchedAt, "the intent was saved before the request");
  // next look, a minute later: GitHub does not show the run yet
  const next = { ...ctx, state: A.loadState(ctx.stateFile), scenarios: async () => ({ result: "none" }), dispatch: async () => { w.dispatches++; } };
  const r = await A.autoStage(next);
  assert.equal(r.outcome, "waiting");
  assert.equal(w.dispatches, 1);
  // much later and still no run: say so once and halt, still no second start
  let clockNow = ctx.now() + 3600 * 1000;
  const later = { ...next, now: () => clockNow, state: A.loadState(ctx.stateFile) };
  const halted = await A.autoStage(later);
  assert.equal(halted.outcome, "halted");
  assert.equal(w.dispatches, 1);
  assert.equal(w.notices.length, 0);
  assert.equal(halted.halt.key, "scenarios-lost");
  assert.match(halted.halt.words, /do not show on GitHub/);
  assert.match(halted.halt.words, /costs money from the test key, and only the owner gives that yes/);
  assert.match(halted.halt.clear, /--owner-said .* --owner-ref /);
  assert.equal(fs.existsSync(cfg.stopFile), false);
});

test("the hand step is not announced while tickets are still open", async () => {
  const hand = planFor("- The scenario for item 3 needs a workflow job under `.github/`: Mission Control adds it by hand once the pull request says what it should do.");
  const { w, ctx } = world({ issues: { ...closedBoth, 102: { state: "OPEN", stateReason: null, merges: [] } }, scenarioSeq: [{ result: "none" }], planText: hand });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "waiting");
  assert.equal(w.notices.length, 0);
});

test("a plan that says a step is done by hand is a halt for the driver and does nothing else", async () => {
  const hand = planFor("- The scenario for item 3 needs a workflow job under `.github/`: Mission Control adds it by hand once the pull request says what it should do.");
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }], planText: hand });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "needs-judgment");
  assert.equal(w.notices.length, 0, "no message about it");
  assert.equal(r.halt.key, "blocked-by-hand");
  assert.match(r.halt.words, /cannot be started automatically/);
  assert.match(r.halt.words, /by hand/);
  assert.doesNotMatch(r.halt.words, /Mission Control has to|tell it to go ahead/);
  assert.deepEqual(w.calls, []);
  const again = await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.equal(again.halt.key, "blocked-by-hand", "the halt stands while the reason stands");
  assert.equal(w.notices.length, 0);
});

test("a refusal of the freeze that is only a wait is not a halt until it has lasted, and then it is a halt, never a message", async () => {
  // since 25 November 2026 a missing build is a wait the step ends itself, never a person's decision (needs-judgment)
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }], extra: { freezeCheckRefuses: "GitHub holds no Windows setup built for commit 9999999 (no artifact)." } });
  const r1 = await A.autoStage(ctx);
  assert.equal(r1.outcome, "waiting");
  assert.equal(r1.halt, undefined, "a build still running is not a halt");
  assert.equal(w.notices.length, 0, "a build still running is not worth a message");
  assert.deepEqual(w.calls, ["freeze.mjs --dry-run"], "nothing was frozen");
  let t = ctx.now();
  const later = { ...ctx, now: () => (t += 2 * 3600 * 1000), state: A.loadState(ctx.stateFile) };
  const rl = await A.autoStage(later);
  assert.equal(w.notices.length, 0);
  assert.equal(rl.halt.key, "blocked-build");
  assert.match(rl.halt.words, /has not finished building the Windows setup/);
});

test("a refusal only a person could lift is a halt at once, never a message", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }], extra: { freezeCheckRefuses: "/x/windows-manifest.json says version 2.0.0-beta.24, not 2.0.0-beta.25." } });
  const r = await A.autoStage(ctx);
  assert.equal(w.notices.length, 0);
  assert.equal(r.halt.key, "blocked-freeze");
  assert.match(r.halt.words, /still says it is version 2\.0\.0-beta\.24 instead of 2\.0\.0-beta\.25/);
});

test("a wait that cleared starts counting again, and a different reason is said again", async () => {
  // the pinned commit's own required check still running is the wait now (main's newest change is never waited for)
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }], extra: { checkState: "running" } });
  await A.autoStage(ctx); // starts counting
  assert.ok(A.loadState(ctx.stateFile).releases[w.id].blocked.build);
  w.extra.checkState = "passed";
  w.extra.freezeCheckRefuses = "There are open approved-plan tickets: 01-a.md.";
  await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.equal(A.loadState(ctx.stateFile).releases[w.id].blocked.build, undefined, "the check passed: its clock is cleared");
  w.extra.checkState = "running";
  w.extra.freezeCheckRefuses = null;
  const t0 = ctx.now() + 3 * 3600 * 1000;
  const r = await A.autoStage({ ...ctx, now: () => t0, state: A.loadState(ctx.stateFile) });
  assert.notEqual(r.halt && r.halt.key, "blocked-build", "a short wait after a long break is not a long wait");
  assert.equal(w.notices.length, 0);
});

test("a scope amendment lets a deferred ticket go", async () => {
  const { w, ctx } = world({ issues: { ...closedBoth, 102: { state: "OPEN", stateReason: null, merges: [] } }, scenarioSeq: [{ result: "none" }, passed] });
  w.files.set(`releases/${w.id}/scope-amendment.json`, JSON.stringify({ deferredTickets: ["02-b.md"] }));
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "ready");
});

test("a tag a person made a minute ago is not started on at once", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }], extra: { tagTime: Date.parse("2026-11-14T09:59:00Z") } });
  w.tag = "1".repeat(40);
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "waiting");
  assert.equal(w.dispatches, 0);
  assert.equal(fs.existsSync(w.stop), false);
});

test("scenarios that cannot be read start nothing and take no STOP", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "unreadable", problem: "GitHub said 502" }] });
  w.tag = "1".repeat(40);
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "waiting");
  assert.equal(w.dispatches, 0);
  assert.deepEqual(w.stopSeenDuring.filter(([n]) => n === "dispatch"), []);
});

test("an option without its value is refused before anything is read", async () => {
  const saved = console.error;
  const said = [];
  console.error = (m) => said.push(m);
  try {
    assert.equal(await A.main(["--explain"]), 2);
    assert.equal(await A.main(["--release", "--dry-run"]), 2);
    assert.equal(await A.main(["--nope"]), 2);
  } finally {
    console.error = saved;
  }
  assert.match(said[0], /--explain needs a release id/);
});

test("a release that was cut down to a decision is a halt for the driver, nothing frozen", async () => {
  const { w, ctx } = world({ issues: { ...closedBoth, 102: { state: "CLOSED", stateReason: "NOT_PLANNED", merges: [] } }, scenarioSeq: [{ result: "none" }] });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "needs-judgment");
  assert.equal(w.notices.length, 0);
  assert.equal(r.halt.key, "blocked-tickets");
  assert.match(r.halt.words, /closed without being done/);
  assert.deepEqual(w.calls, []);
});

test("a dry run says what it would do and changes nothing", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }] });
  ctx.dry = true;
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "would-freeze");
  assert.deepEqual(w.written, []);
  assert.deepEqual(w.calls, []);
  assert.equal(fs.existsSync(ctx.stateFile), false);
  assert.ok(w.log.some((l) => /Would write "Status: done/.test(l)));
});

test("a release staged by hand is not touched (beta.24's case)", async () => {
  const { ctx, w } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }], staging: { version: "2.0.0-beta.25" } });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "nothing");
  assert.match(w.log.join("\n"), /already staged/);
});

test("the config has defaults in one place and takes overrides", () => {
  assert.equal(A.loadConfig({}).stopFile, A.CONFIG_DEFAULTS.stopFile);
  const c = A.loadConfig({ AUTO_STAGE_STOP_FILE: "/x/STOP", AUTO_STAGE_MAC: "false", AUTO_STAGE_STOP_MAX_AGE_MINUTES: "30" });
  assert.equal(c.stopFile, "/x/STOP");
  assert.equal(c.scenarioMac, false);
  assert.equal(c.stopMaxAgeMinutes, 30);
});

test("the server's message path: without mc-notify, tellScript queues a notice once (beta.24 would never have reached him otherwise)", async () => {
  const { spawnSync } = await import("node:child_process");
  const G = await import("../../../steps/release/staging.mjs");
  if (fs.existsSync("/usr/local/bin/mc-notify")) return; // this machine has the bot lane; the other branch is covered by the self-tests
  const dir = tmp();
  const file = path.join(dir, "notices.json");
  fs.writeFileSync(file, JSON.stringify({ notices: [] }));
  const script = G.tellScript({ summary: `2.0.0-beta.25 is on your server, "healthy". Shall I make it public?`, status: "ready for your go", act: 'Answer "go".' });
  const run = () => spawnSync("bash", ["-s"], { input: script, encoding: "utf8", env: { ...process.env, STAGING_NOTICES_FILE: file } });
  const a = run();
  assert.match(a.stdout, /notify_exit=0/, a.stderr);
  run();
  const q = JSON.parse(fs.readFileSync(file, "utf8")).notices;
  assert.equal(q.length, 1, "the same message is queued once");
  assert.equal(q[0].written, true);
  assert.match(q[0].text, /Shall I make it public\? Answer "go"\./);
});

test("a result the look saw is not replaced by a later read that fails", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, passed, { result: "unreadable", problem: "GitHub said 502" }] });
  const seq = w.scenarioSeq;
  let n = 0;
  ctx.scenarios = async () => {
    n++;
    if (n === 1) return { result: "none" };
    if (n === 2) return passed;
    return { result: "unreadable", problem: "GitHub said 502" };
  };
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "ready", "no contradicting message after the ready one");
  assert.deepEqual(w.notices, []);
  assert.equal(seq.length >= 1, true);
});

test("when GitHub does not say which attempt a failed run is on, no rerun is started and nothing is told", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, failed], extra: { runInfoNull: true } });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "waiting");
  assert.equal(w.reruns, 0);
  assert.deepEqual(w.notices, []);
  assert.equal(fs.existsSync(w.stop), false);
});

test("a freeze this script began and did not see end halts the release instead of carrying on", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }] });
  w.tag = "1".repeat(40);
  const rs = A.releaseState(ctx.state, w.id);
  rs.started = rs.freezeStartedAt = new Date(ctx.now() - 3600 * 1000).toISOString();
  A.saveState(ctx.stateFile, ctx.state);
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "halted");
  assert.equal(w.dispatches, 0);
  assert.equal(w.notices.length, 0);
  assert.equal(r.halt.key, "freeze-unfinished");
  assert.match(r.halt.words, /not seen to end/);
});

test("an intent to halt that an older version saved is turned into the halt, without its hand-off sentence", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }] });
  const rs = A.releaseState(ctx.state, w.id);
  rs.started = new Date(ctx.now() - 3600 * 1000).toISOString();
  rs.halting = { key: "freeze-failed", text: "Godspeed 2.0.0-beta.25 was complete, but the freeze stopped: x. Nothing is public and I will not try again by myself. Mission Control has to look at it.", about: "x", why: "the freeze failed: x" };
  A.saveState(ctx.stateFile, ctx.state);
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "halted");
  assert.equal(r.halt.key, "freeze-failed");
  assert.doesNotMatch(r.halt.words, /Mission Control|by myself/);
  assert.equal(A.loadState(ctx.stateFile).releases[w.id].halting, undefined);
  assert.equal(w.notices.length, 0);
});

test("clearing a halt makes the step carry on from where the halt stood", async () => {
  const dir = tmp();
  const env = { AUTO_STAGE_REPO: REPO, AUTO_STAGE_STATE_DIR: dir, AUTO_STAGE_NOTICES_FILE: path.join(dir, "n.json") };
  const state = { version: 1, releases: { r1: { started: "2026-11-14T10:00:00Z", freezeStartedAt: "2026-11-14T10:00:00Z", halted: { at: "2026-11-14T10:05:00Z", why: "the freeze failed: x", key: "freeze-failed", words: "the freeze stopped" } } } };
  A.saveState(path.join(dir, "state.json"), state);
  assert.match(await A.clearHalt({ env, key: "nothing-like-it", log: () => {} }), /Nothing to clear/);
  assert.match(await A.clearHalt({ env, key: "freeze-failed", log: () => {} }), /r1: the halt "freeze-failed" was cleared/);
  const after = A.loadState(path.join(dir, "state.json")).releases.r1;
  assert.equal(after.halted, undefined);
  assert.equal(after.started, undefined, "the freeze is tried again");
  const lost = { version: 1, releases: { r2: { dispatchedAt: "2026-11-14T10:00:00Z", halted: { key: "scenarios-lost", words: "w", why: "w", at: "t" } }, r3: { halted: { key: "scenarios-ignored", words: "w", why: "w", at: "t" } } } };
  A.saveState(path.join(dir, "state.json"), lost);
  // another PAID run needs the owner's recorded yes: without both words and place nothing changes
  for (const key of ["scenarios-lost", "scenarios-ignored"]) {
    for (const given of [{}, { ownerSaid: "yes, run it" }, { ownerRef: "telegram:1" }, { ownerSaid: "  ", ownerRef: "telegram:1" }]) {
      await assert.rejects(() => A.clearHalt({ env, key, log: () => {}, ...given }), /only the owner's yes allows that.*Nothing was changed/);
    }
  }
  const untouched = A.loadState(path.join(dir, "state.json")).releases;
  assert.ok(untouched.r2.halted && untouched.r2.dispatchedAt && untouched.r3.halted && !untouched.r3.dispatchApproved, "nothing changed");
  await A.clearHalt({ env, key: "scenarios-lost", ownerSaid: "yes, run them again", ownerRef: "telegram:msg-77", log: () => {} });
  await A.clearHalt({ env, key: "scenarios-ignored", ownerSaid: "yes, run them", ownerRef: "telegram:msg-78", log: () => {} });
  const l = A.loadState(path.join(dir, "state.json")).releases;
  assert.equal(l.r2.dispatchedAt, undefined, "an accepted new run");
  assert.equal(l.r3.dispatchApproved, true);
  assert.equal(l.r2.dispatchApproval.said, "yes, run them again");
  assert.equal(l.r3.dispatchApproval.ref, "telegram:msg-78", "his yes is kept beside the approval");
  // every other halt keeps its plain clear
  A.saveState(path.join(dir, "state.json"), { version: 1, releases: { r4: { halted: { key: "not-staged", words: "w", why: "w", at: "t" } } } });
  await A.clearHalt({ env, key: "not-staged", log: () => {} });
});

test("scenarios on the tag that do not count are a halt and never answered with a second paid run", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none", ignored: 'One run on candidate/2.0.0-beta.25 is titled "scenarios beta", not "scenarios candidate/2.0.0-beta.25", so it proved another stage and does not count.' }] });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "halted");
  assert.equal(w.dispatches, 0);
  assert.equal(w.notices.length, 0);
  assert.equal(r.halt.key, "scenarios-ignored");
  assert.match(r.halt.words, /do not count/);
  assert.match(r.halt.words, /costs money from the test key/);
  assert.match(r.halt.clear, /--owner-said .* --owner-ref /);
  assert.equal(fs.existsSync(w.stop), false);
});

test("a wait that lasts is one halt per spell, not a new one for every new commit on main, and never a message", async () => {
  // since 25 November 2026 the wait is on the pinned commit, which never follows main: the factory merging on changes nothing
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }], extra: { checkState: "running" } });
  let t = ctx.now();
  const keys = [];
  let last = null;
  for (let i = 0; i < 6; i++) {
    t += 30 * 60 * 1000;
    if (i > 0) w.extra.mainTip = String(i).repeat(40); // a new commit on main every half hour
    last = await A.autoStage({ ...ctx, now: () => t, state: A.loadState(ctx.stateFile) });
    if (last.halt) keys.push(last.halt.key);
  }
  assert.equal(w.notices.length, 0);
  assert.ok(keys.length > 0 && keys.every((k) => k === "blocked-build"), "one key for the whole spell");
  assert.match(last.halt.words, /has been waiting for over an hour/);
  assert.equal(A.loadState(ctx.stateFile).releases[w.id].pin.commit, "9".repeat(40), "the pin never follows main");
});

test("a hand step still ahead is found even when the sentence has a word of history in it", () => {
  assert.match(A.planNeedsHand(planFor("Mission Control adds the workflow job under .github/ by hand once item 3's pull request is merged.")) || "", /by hand/);
  assert.equal(A.planNeedsHand(planFor("The version bump will be opened by hand after the plan is approved.")), null, "only a .github change is a hand step");
});

test("a failure that never goes away is noticed after six hours, once", () => {
  const state = { version: 1, releases: {} };
  const t0 = Date.parse("2026-11-14T10:00:00Z");
  assert.deepEqual(A.trackFailure(state, t0, "GitHub said 401"), { notify: false });
  assert.deepEqual(A.trackFailure(state, t0 + 5 * 3600 * 1000, "GitHub said 401"), { notify: false });
  assert.equal(A.trackFailure(state, t0 + 7 * 3600 * 1000, "GitHub said 401").notify, true);
  assert.equal(A.trackFailure(state, t0 + 8 * 3600 * 1000, "GitHub said 401").notify, false, "once");
  A.clearFailure(state);
  assert.deepEqual(A.trackFailure(state, t0 + 9 * 3600 * 1000, "again"), { notify: false }, "a new spell starts counting again");
});

test("the failure message names the summary job when it failed, so record-go.mjs's prompt check passes for the same jobs", () => {
  const one = { job: "two computers move reminders", cause: { plain: "the key is not set", environment: false }, mainDates: [], blocking: false };
  const withAgg = A.failureMessage({ version: "2.0.0-beta.25", failures: [one], aggregate: ["the verdict"] });
  assert.match(withAgg, /did not pass, and with it the verdict\./);
  const two = A.failureMessage({ version: "2.0.0-beta.25", failures: [one, { ...one, job: "docker import" }], aggregate: ["the verdict"] });
  assert.match(two, /2 tests did not pass, and with them the verdict\./);
  assert.ok(G.jobsPromptMustName(["two computers move reminders", "the verdict"]).every((j) => withAgg.includes(j)));
  const without = A.failureMessage({ version: "2.0.0-beta.25", failures: [one] });
  assert.doesNotMatch(without, /the verdict/);
  const alone = A.failureMessage({ version: "2.0.0-beta.25", failures: [], aggregate: ["the verdict"] });
  assert.ok(G.jobsPromptMustName(["the verdict"]).every((j) => alone.includes(j)), "if the summary job failed alone, the message names it");
});

test("a driver amendment on the plan's rule lets a dead-end ticket go; one that quotes nothing in the plan does not", async () => {
  const rule = "an item that reaches a dead end leaves the release, the rest ships";
  const open102 = { ...closedBoth, 102: { state: "OPEN", stateReason: null, merges: [] } };
  const entry = (w, words) => JSON.stringify({ release: w.id, decidedBy: "release-driver", authority: "plan-rule", words, approvalRef: "plan.md Status: approved", deferredTickets: ["02-b.md"], reasons: { "02-b.md": ["x"] } });
  const a = world({ issues: open102, scenarioSeq: [{ result: "none" }, passed] });
  a.w.files.set(`releases/${a.w.id}/plan.md`, `${a.w.files.get(`releases/${a.w.id}/plan.md`)}
${rule}.
`);
  a.w.files.set(`releases/${a.w.id}/scope-amendment.json`, entry(a.w, rule));
  assert.equal((await A.autoStage(a.ctx)).outcome, "ready");
  const b = world({ issues: open102, scenarioSeq: [{ result: "none" }, passed] });
  b.w.files.set(`releases/${b.w.id}/scope-amendment.json`, entry(b.w, "not in the plan"));
  assert.equal((await A.autoStage(b.ctx)).outcome, "waiting");
});

// ---------- a close by a "Delivered by" comment ----------

test("a close with the builder's 'Delivered by' comment counts when the pull request is merged into main and names the issue", async () => {
  const url = `https://github.com/${REPO}/pull/688`;
  const closed = () => ({ 664: { state: "CLOSED", stateReason: "COMPLETED", merges: [] } });
  const say = (login, body = `Delivered by ${url}`, __typename = "Bot") => ({ 664: [{ author: { __typename, login }, body }] });
  const pr = (over = {}) => ({ number: 688, mergedAt: "2026-11-16T10:00:00Z", baseRefName: "main", headRefName: "archon/task-x", body: "Closes nothing, but this is for #664.", mergeCommit: { oid: "d".repeat(40) }, ...over });
  const run = async (comments, p) => {
    const issues = closed();
    let calls = 0;
    await A.addDeliveredByComment({ repo: REPO, issues, comments, api: async () => { calls++; return { ok: true, json: { data: { repository: { p688: p } } } }; } });
    return { issues, calls };
  };
  const ok = await run(say("godspeed-dev-builder"), pr());
  assert.equal(ok.issues[664].merges[0].commit, "d".repeat(40));
  assert.equal(A.judgeCompleteness({ tickets: [ticket(1)], plan: "- Issues: 1 #664\n", repo: REPO, issues: ok.issues }).marks[0].merge, "d".repeat(40));
  assert.equal((await run(say("godspeed-dev-release[bot]"), pr())).issues[664].merges.length, 1);
  assert.equal((await run(say("godspeed-dev-builder"), pr({ body: "nothing", headRefName: "issue-664-fix" }))).issues[664].merges.length, 1, "the branch may name the issue");
  assert.equal((await run(say("godspeed-dev-builder", `Delivered by ${url}`, "User"), pr())).calls, 0, "a person who took the Apps' name is not the App");
  assert.equal((await run(say("godspeed-dev-builder"), pr({ body: "x", headRefName: "archon/task-archon-loop-a664b0c1" }))).issues[664].merges.length, 0, "a number inside a random branch id is not the issue");
  assert.equal((await run(say("godspeed-dev-builder"), pr({ body: "see https://github.com/MichaelZelbel/godspeed-dev/issues/664", headRefName: "x" }))).issues[664].merges.length, 0, "another repository's issue link");
  assert.equal((await run(say("someone-else"), pr())).calls, 0, "a comment by anyone else is not looked at");
  assert.equal((await run(say("godspeed-dev-builder"), pr({ mergedAt: null }))).issues[664].merges.length, 0, "not merged");
  assert.equal((await run(say("godspeed-dev-builder"), pr({ baseRefName: "beta" }))).issues[664].merges.length, 0, "not into main");
  assert.equal((await run(say("godspeed-dev-builder"), pr({ body: "for #6640", headRefName: "x" }))).issues[664].merges.length, 0, "it must name this issue");
  assert.equal((await run(say("godspeed-dev-builder", "Delivered by https://github.com/other/repo/pull/688"), pr())).calls, 0, "another repository's pull request");
});

// ---------- "Already delivered on main by #N" (the Forge 0.3.1, ticket 03) ----------

// Godspeed 2.0.0-beta.31, 2026-11-23: ticket 01's issue (#783 in the product) was closed as completed by the builder App with
// "Already delivered on main by #861 with #590 and #795". #861 was an issue, closed by the merged pull request #876.
const MERGE_876 = "5d29db0" + "4".repeat(33);
const issue861 = (over = {}) => ({ __typename: "Issue", number: 861, state: "CLOSED", closedByPullRequestsReferences: { nodes: [{ number: 876, merged: true, mergedAt: "2026-11-21T10:00:00Z", baseRefName: "main", mergeCommit: { oid: MERGE_876 }, repository: { nameWithOwner: REPO } }] }, ...over });
const alreadySaid = (login = "godspeed-dev-builder", __typename = "Bot", body = "Already delivered on main by #861 with #590 and #795.") => ({ 783: [{ author: { __typename, login }, body }] });
async function already(comments, node) {
  const issues = { 783: { state: "CLOSED", stateReason: "COMPLETED", merges: [] } };
  const queries = [];
  await A.addDeliveredByComment({ repo: REPO, issues, comments, api: async (m, p, b) => { queries.push(b.query); return { ok: true, json: { data: { repository: { a861: node } } } }; } });
  return { issues, queries, verdict: A.judgeCompleteness({ tickets: [ticket(1)], plan: "- Issues: 1 #783\n", repo: REPO, issues }) };
}

test("ticket 03: beta.31's ticket 01 counts as done: the builder App's 'Already delivered on main by #861' names an issue closed by the merged #876, whose merge is the ticket's", async () => {
  const r = await already(alreadySaid(), issue861());
  assert.equal(r.issues[783].merges[0].number, 876);
  assert.equal(r.verdict.state, "complete", "no dead end: nothing waits for the driver");
  assert.deepEqual(r.verdict.deadEnds, []);
  assert.equal(r.verdict.marks[0].merge, MERGE_876, "the merge of #876 becomes the ticket's merge, for its Status line");
  assert.match(r.queries[0], /a861: issueOrPullRequest\(number: 861\)/);
  assert.equal((await already(alreadySaid("godspeed-dev-release[bot]"), issue861())).verdict.marks[0].merge, MERGE_876, "the release App counts too");
  const pr = { __typename: "PullRequest", number: 861, merged: true, mergedAt: "2026-11-21T09:00:00Z", baseRefName: "main", mergeCommit: { oid: "c".repeat(40) }, repository: { nameWithOwner: REPO } };
  assert.equal((await already(alreadySaid(), pr)).verdict.marks[0].merge, "c".repeat(40), "#N may be the merged pull request itself, and the App's comment is the link (no 'names the issue' check)");
  const two = issue861({ closedByPullRequestsReferences: { nodes: [{ number: 870, mergedAt: "2026-11-20T10:00:00Z", baseRefName: "main", mergeCommit: { oid: "7".repeat(40) }, repository: { nameWithOwner: REPO } }, { number: 876, mergedAt: "2026-11-21T10:00:00Z", baseRefName: "main", mergeCommit: { oid: MERGE_876 }, repository: { nameWithOwner: REPO } }] } });
  assert.equal((await already(alreadySaid(), two)).verdict.marks[0].merge, MERGE_876, "the newest merge wins");
});

test("ticket 03: the same words by a person, or naming something not merged into main of this repository, do not count: the ticket stays a dead end", async () => {
  assert.equal((await already(alreadySaid("godspeed-dev-builder", "Bot"), issue861())).verdict.deadEnds.length, 0, "the App's own comment does count");
  const person = await already(alreadySaid("godspeed-dev-builder", "User"), issue861());
  assert.equal(person.queries.length, 0, "a person who took the App's name is not the App: nothing is even looked up");
  assert.equal(person.verdict.deadEnds.length, 1);
  assert.equal((await already(alreadySaid("someone-else"), issue861())).verdict.deadEnds.length, 1, "anyone else");
  const pr = (over) => ({ __typename: "PullRequest", number: 861, mergedAt: "2026-11-21T09:00:00Z", baseRefName: "main", mergeCommit: { oid: "c".repeat(40) }, repository: { nameWithOwner: REPO }, ...over });
  for (const [node, why] of [[pr({ mergedAt: null, mergeCommit: null }), "a pull request not merged"], [pr({ baseRefName: "beta" }), "merged elsewhere than main"], [pr({ repository: { nameWithOwner: "other/repo" } }), "another repository"],
    [issue861({ state: "OPEN" }), "an issue still open"], [issue861({ closedByPullRequestsReferences: { nodes: [{ number: 876, mergedAt: null, baseRefName: "main", mergeCommit: null }] } }), "an issue closed by nothing merged"], [null, "nothing by that number"]])
    assert.equal((await already(alreadySaid(), node)).verdict.deadEnds.length, 1, why);
  const unreadable = { 783: { state: "CLOSED", stateReason: "COMPLETED", merges: [] } };
  await A.addDeliveredByComment({ repo: REPO, issues: unreadable, comments: alreadySaid(), api: async () => ({ ok: false, status: 502, json: null }) });
  assert.deepEqual(unreadable[783].merges, [], "GitHub not answering proves nothing; the next look reads it again");
});

test("ticket 03: a whole look writes the already-delivered ticket's Status line itself and goes on instead of waiting for the driver", async () => {
  const rule = "an item that reaches a dead end leaves the release, the rest ships";
  const issues = { ...closedBoth, 102: { state: "CLOSED", stateReason: "COMPLETED", merges: [] } };
  const look = (comments) => {
    const made = world({ issues, scenarioSeq: [{ result: "none" }, passed], planText: planFor(`The plan's rule: ${rule}.\n`) });
    const plain = made.ctx.api;
    made.ctx.api = async (method, p, body) => {
      if (p === "/graphql" && /issueOrPullRequest/.test(body.query)) return { ok: true, json: { data: { repository: { a861: issue861() } } } };
      const r = await plain(method, p, body);
      for (const k of ["i102"]) r.json.data.repository[k].comments = { nodes: comments };
      r.json.data.repository.labelled.nodes = r.json.data.repository.labelled.nodes.map((n) => (n.number === 102 ? { ...n, comments: { nodes: comments } } : n));
      return r;
    };
    return made;
  };
  const before = look([]);
  const waited = await A.autoStage(before.ctx);
  assert.equal(waited.outcome, "waiting", "with nothing named, the ticket is a dead end the driver moves");
  assert.ok(before.w.log.some((l) => /Waiting for the factory driver to move/.test(l)));
  const after = look([{ author: { __typename: "Bot", login: "godspeed-dev-builder" }, body: "Already delivered on main by #861 with #590 and #795." }]);
  const went = await A.autoStage(after.ctx);
  assert.notEqual(went.why, "dead ends");
  assert.ok(!after.w.log.some((l) => /Waiting for the factory driver/.test(l)), "it never waits on the driver for it");
  assert.ok(after.w.files.get(`releases/${after.w.id}/tickets/02-b.md`).startsWith(`Status: done (merge ${MERGE_876})`), "the step wrote the Status line itself");
});

// ---------- a failed candidate is taken apart and rebuilt (auto-drive.mjs) ----------

const RULE_LINE = "an item that reaches a dead end leaves the release, the rest ships";
const drivePlan = (blocking = "- two computers move reminders (item 2)") =>
  planFor(`**Blocking scenarios:**\n\n${blocking}\n\nEvery other failing job does not block. The plan's rule: ${RULE_LINE}.\n`);
const realFailLog = "2026-11-14T13:50:02.000Z FAIL two-machines-move-at-once: the reminders disagree after the second computer joined\n2026-11-14T13:50:03.000Z ##[error]Process completed with exit code 1.\n";
const sha = (c) => c.repeat(40);

function driven({ blocking, sequence, extra = {}, over = {}, log = realFailLog, mainFailures = {}, pullFiles = {} } = {}) {
  const made = world({ issues: closedBoth, planText: drivePlan(blocking), scenarioSeq: sequence || [{ result: "none" }, failed, failed, failed], extra });
  const { w, ctx } = made;
  w.driveCalls = [];
  w.follow = {};
  ctx.jobLog = async () => log;
  const plainRun = ctx.run;
  w.freezeArgs = [];
  ctx.run = async (args) => {
    if (args[0].endsWith("freeze.mjs")) w.freezeArgs.push(args);
    return w.refuseDrive && args[0].endsWith("freeze.mjs") && args[2] === "2.0.0-beta.25.1" && args.includes("--dry-run") ? { code: 1, stdout: "", stderr: `${w.refuseDrive}\n` } : plainRun(args);
  };
  ctx.mainFailures = async () => mainFailures;
  ctx.drive = {
    itemPulls: async () => ({ 1: { number: 5, commit: sha("a") }, 2: { number: 6, commit: sha("b") } }),
    pullFiles: async (n) => pullFiles[n] || [],
    extraCommits: async (x) => { (w.extraAsked ||= []).push(x); return []; },
    startRevert: async (x) => { w.driveCalls.push(["revert", x.number]); return w.revertCannot ? { cannot: w.revertCannot } : { pr: 900, head: sha("r") }; },
    startRelease: async (x) => { w.driveCalls.push(["release", x.version]); w.releaseAsked = x; return w.releaseCannot ? { cannot: w.releaseCannot } : { pr: 901, head: sha("s") }; },
    follow: async ({ pr }) => { w.driveCalls.push(["follow", pr]); return w.follow[pr] || { state: "merged", sha: sha(pr === 900 ? "c" : "d") }; },
    ...over,
  };
  return made;
}
const noTouch = (w) => assert.ok(!w.calls.some((c) => /promote|record-go/.test(c)), "never promotes and never records his go");

test("a blocking failure traced by the plan's list takes that change out, defers its ticket and freezes the next version", async () => {
  const { w, ctx } = driven();
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "refrozen");
  assert.equal(r.version, "2.0.0-beta.25.1");
  assert.deepEqual(w.driveCalls.map((c) => c[0] + (c[1] ?? "")), ["revert6", "follow900", "release2.0.0-beta.25.1", "follow901"], "revert on main, merge it, rebuild on the release branch, merge it");
  assert.deepEqual(
    { branch: w.releaseAsked.branch, from: w.releaseAsked.from, culprit: w.releaseAsked.culprit, number: w.releaseAsked.number },
    { branch: "release/2.0.0-beta.25", from: "8".repeat(40), culprit: sha("b"), number: 6 },
    "the release branch is cut from the failed candidate's own commit and takes out exactly the traced change",
  );
  const frozeFrom = w.freezeArgs.filter((a) => a[2] === "2.0.0-beta.25.1").map((a) => a[a.indexOf("--commit") + 1]);
  assert.ok(frozeFrom.length >= 1 && frozeFrom.every((c) => c === sha("d")), "the new candidate is frozen from the release branch's merge, not from main");
  const amend = JSON.parse(w.files.get(`releases/${w.id}/scope-amendment.json`));
  const entry = amend.amendments[0];
  assert.equal(entry.decidedBy, "auto-stage");
  assert.equal(entry.authority, "plan-rule");
  assert.deepEqual(entry.deferredTickets, ["02-b.md"]);
  assert.ok(entry.words.includes("dead end"));
  assert.ok(entry.reasons["02-b.md"].length >= 1);
  const files = [...w.files.keys()].filter((k) => k.includes("/tickets/"));
  const read = readDeferrals(amend, { id: w.id, version: "2.0.0-beta.25", plan: drivePlan(), ticketNames: files });
  assert.deepEqual(read.deferred, ["02-b.md"]);
  assert.deepEqual(read.problems, []);
  assert.ok(w.calls.filter((c) => c === "freeze.mjs").length >= 1, "the freeze ran");
  assert.equal(ctx.state.releases[w.id].candidate, "2.0.0-beta.25.1");
  assert.equal(w.notices.length, 0, "no message while it can still be mended");
  noTouch(w);
});

test("after the re-freeze the next look runs the new candidate's scenarios and, passing, asks him once", async () => {
  const { w, ctx } = driven();
  await A.autoStage(ctx);
  w.scenarioSeq = [{ result: "passed", run: 8, url: "u", tag: "candidate/2.0.0-beta.25.1" }];
  const again = await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.equal(again.outcome, "ready");
  assert.equal(JSON.parse(w.files.get(`releases/${w.id}/staging.json`)).version, "2.0.0-beta.25.1", "the server record is for the new candidate");
  noTouch(w);
});

test("a revert still waiting for its checks is carried on by the next look", async () => {
  const { w, ctx } = driven();
  w.follow[900] = { state: "waiting" };
  const first = await A.autoStage(ctx);
  assert.equal(first.outcome, "waiting");
  assert.equal(w.notices.length, 0);
  delete w.follow[900];
  const second = await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.equal(second.outcome, "refrozen");
  assert.equal(w.driveCalls.filter((c) => c[0] === "revert").length, 1, "the revert is opened once");
});

test("a failure that also failed on main's nightly in the last 3 nights does not block: he is told, nothing is taken out", async () => {
  const { w, ctx } = driven({ mainFailures: { "two computers move reminders": ["2026-11-12T03:00:00Z"] } });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "failed-tests");
  assert.equal(w.driveCalls.length, 0);
  assert.equal(w.notices.length, 1);
  assert.ok(ctx.state.releases[w.id].failedJobs[0].doesNotBlock);
});

test("an old main failure (older than 3 nights) does not excuse a failure", async () => {
  const { ctx } = driven({ mainFailures: { "two computers move reminders": ["2026-11-05T03:00:00Z"] } });
  assert.equal((await A.autoStage(ctx)).outcome, "refrozen");
});

test("a failure whose log names a test-machine cause does not block (secret missing, verifier INCOMPLETE, network)", async () => {
  for (const line of ["##[error]Input required and not supplied: token", "verdict INCOMPLETE: the browser never started", "FAIL x: connect ECONNREFUSED 127.0.0.1:8080"]) {
    const { w, ctx } = driven({ log: `2026-11-14T13:50:02.000Z ${line}\n` });
    const r = await A.autoStage(ctx);
    assert.equal(r.outcome, "failed-tests", line);
    assert.equal(w.driveCalls.length, 0, line);
  }
});

test("a failure the plan cannot place and no file explains is not guessed: he is told once, which test and why", async () => {
  const { w, ctx } = driven({ blocking: "- two computers move reminders" });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "drive-untraced");
  assert.equal(w.driveCalls.length, 0);
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0].text, /two computers move reminders/);
  assert.match(w.notices[0].text, /I did not take anything out by myself: I cannot tell which change/);
  assert.equal(w.files.has(`releases/${w.id}/scope-amendment.json`), false);
});

test("without a plan mapping, the change that touched a file the failing test names is the one", async () => {
  const log = "2026-11-14T13:50:02.000Z FAIL two-machines: Error at notebook/core/reminders.mjs:41\n";
  const { w, ctx } = driven({ blocking: "- two computers move reminders", log, pullFiles: { 5: ["docs/a.md"], 6: ["notebook/core/reminders.mjs", "notebook/test/x.mjs"] } });
  assert.equal((await A.autoStage(ctx)).outcome, "refrozen");
  assert.deepEqual(w.driveCalls[0], ["revert", 6]);
});

test("two changes touching the named file is not one change: nothing is taken out", async () => {
  const log = "2026-11-14T13:50:02.000Z FAIL two-machines: Error at notebook/core/reminders.mjs:41\n";
  const { w, ctx } = driven({ blocking: "- two computers move reminders", log, pullFiles: { 5: ["notebook/core/reminders.mjs"], 6: ["notebook/core/reminders.mjs"] } });
  assert.equal((await A.autoStage(ctx)).outcome, "drive-untraced");
  assert.equal(w.driveCalls.length, 0);
});

test("at most two re-freezes: the third failure is told, not driven", async () => {
  const { w, ctx } = driven();
  ctx.state.releases[w.id] = { candidate: "2.0.0-beta.25.2", drive: { phase: "done", n: 2 } };
  w.tag = sha("1");
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "drive-exhausted");
  assert.equal(w.driveCalls.length, 0);
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0].text, /2 times already and the test still fails/);
});

test("a revert that cannot be made stops it with a halt and changes no scope", async () => {
  const { w, ctx } = driven();
  w.revertCannot = "it conflicts with what main holds now (notebook/core/reminders.mjs)";
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "drive-stopped");
  assert.equal(w.notices.length, 0, "nobody is told from here");
  assert.equal(r.halt.key, "drive-stopped-1");
  assert.match(r.halt.words, /two computers move reminders/);
  assert.match(r.halt.words, /conflicts with what main holds now/);
  assert.doesNotMatch(r.halt.words, /Mission Control|by myself/);
  assert.equal(w.files.has(`releases/${w.id}/scope-amendment.json`), false);
  assert.equal(w.driveCalls.some((c) => c[0] === "release"), false);
  const again = await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.match(again.outcome, /finished|nothing/);
  assert.equal(again.halt.key, "drive-stopped-1", "the halt stands until it is cleared");
  assert.equal(w.notices.length, 0);
});

test("a revert that fails its own checks stops it: no amendment, no new version", async () => {
  const { w, ctx } = driven();
  w.follow[900] = { state: "failed", why: "its required check failed" };
  assert.equal((await A.autoStage(ctx)).outcome, "drive-stopped");
  assert.equal(w.files.has(`releases/${w.id}/scope-amendment.json`), false);
  assert.equal(w.driveCalls.some((c) => c[0] === "release"), false);
});

test("a plan without the dead-end rule is never driven: the old single message", async () => {
  const made = world({ issues: closedBoth, planText: planFor("**Blocking scenarios:**\n\n- two computers move reminders (item 2)\n"), scenarioSeq: [{ result: "none" }, failed, failed, failed] });
  made.ctx.jobLog = async () => realFailLog;
  made.ctx.drive = { itemPulls: async () => { throw new Error("must not be asked"); } };
  assert.equal((await A.autoStage(made.ctx)).outcome, "failed-tests");
  assert.equal(made.w.notices.length, 1);
});

test("a re-freeze is named by the release's version with a suffix, and sorts between its neighbours", () => {
  assert.equal(D.nextCandidate("2.0.0-beta.26", 0), "2.0.0-beta.26.1");
  assert.equal(D.nextCandidate("2.0.0-beta.26", 1), "2.0.0-beta.26.2");
  assert.equal(G.compareVersions("2.0.0-beta.26", "2.0.0-beta.26.1"), -1);
  assert.equal(G.compareVersions("2.0.0-beta.26.2", "2.0.0-beta.27"), -1);
});

test("the reverted ticket stops saying done, so freeze reads it as moved out", async () => {
  const { w, ctx } = driven();
  await A.autoStage(ctx);
  assert.match(w.files.get(`releases/${w.id}/tickets/02-b.md`), /^Status: moved to the next release \(change #6 was taken out of main by #900\)/);
  assert.doesNotMatch(w.files.get(`releases/${w.id}/tickets/01-a.md`), /moved to the next release/, "the other ticket is untouched");
});

test("main moving on while the revert and the rebuild wait does not stop it: the rebuild comes from the release branch", async () => {
  const { w, ctx } = driven();
  w.follow[901] = { state: "waiting" };
  assert.equal((await A.autoStage(ctx)).outcome, "waiting");
  // the factory, the release driver and keep-main-green merge into main meanwhile
  ctx.mainHead = async () => ({ commit: "7".repeat(40) });
  delete w.follow[901];
  const r = await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.equal(r.outcome, "refrozen");
  assert.equal(r.version, "2.0.0-beta.25.1");
  const frozeFrom = w.freezeArgs.filter((a) => a[2] === "2.0.0-beta.25.1").map((a) => a[a.indexOf("--commit") + 1]);
  assert.ok(frozeFrom.length >= 1 && frozeFrom.every((c) => c === sha("d")), "frozen from the release branch's merge, never from main's new head");
  assert.deepEqual(w.extraAsked.at(-1), { from: "8".repeat(40), to: sha("d"), allowed: [sha("d")] }, "only the release branch is checked for anything extra");
  assert.equal(w.notices.length, 0);
  assert.equal(A.loadState(ctx.stateFile).releases[w.id].drive.release.branch, "release/2.0.0-beta.25");
  noTouch(w);
});

test("another change on the release branch besides the rebuild stops it: it would ship what no test ran on", async () => {
  const { w, ctx } = driven({ over: { extraCommits: async () => [sha("9")] } });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "drive-stopped");
  assert.match(r.halt.words, /1 other change reached release\/2\.0\.0-beta\.25 besides the rebuild/);
  assert.equal(w.calls.filter((c) => c === "freeze.mjs").length, 1, "only the first freeze: nothing was frozen again");
  assert.equal(ctx.state.releases[w.id].candidate, undefined);
});

test("a release branch somebody else moved is not built on: a halt with the plain reason", async () => {
  const { w, ctx } = driven();
  w.releaseCannot = "release/2.0.0-beta.25 is at 7777777, not at the failed candidate's own commit 8888888, so somebody else changed it";
  const rb = await A.autoStage(ctx);
  assert.equal(rb.outcome, "drive-stopped");
  assert.match(rb.halt.words, /could not be started on release\/2\.0\.0-beta\.25 \(release\/2\.0\.0-beta\.25 is at 7777777/);
  assert.equal(ctx.state.releases[w.id].candidate, undefined);
});

test("the rebuild's server image not yet in the registry is waited for, like its Windows setup", async () => {
  const { w, ctx } = driven();
  w.refuseDrive = `The server image ghcr.io/x:v2-sha-${sha("d")} is not in the registry, so there is nothing to freeze; CI builds it for every commit on main.`;
  assert.equal((await A.autoStage(ctx)).outcome, "waiting");
  assert.equal(w.notices.length, 0);
});

test("--explain says a rebuilt candidate comes from the release branch and names the moved ticket as moved", async () => {
  const { w, ctx } = driven();
  await A.autoStage(ctx);
  const said = [];
  await A.explain({ ...ctx, state: A.loadState(ctx.stateFile), log: (s) => said.push(s) }, w.id);
  assert.ok(said.some((l) => /candidate is now 2\.0\.0-beta\.25\.1, rebuilt on release\/2\.0\.0-beta\.25 from 8888888, frozen from dddddd/.test(l)), said.join("\n"));
  assert.ok(said.some((l) => /02-b\.md: .*moved to the next release/.test(l)), said.join("\n"));
  assert.ok(said.some((l) => /of 1 derived merge commits/.test(l)), "the moved ticket is not counted");
});

test("a change that delivered every ticket is not taken out: that would leave nothing to release", async () => {
  const { w, ctx } = driven({ over: { itemPulls: async () => ({ 1: { number: 6, commit: sha("b") }, 2: { number: 6, commit: sha("b") } }) } });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "drive-untraced");
  assert.match(w.notices[0].text, /leave nothing in the release/);
  assert.equal(w.driveCalls.length, 0);
});

test("a second round never points at the change an earlier round already took out", async () => {
  const { w, ctx } = driven();
  w.files.set(`releases/${w.id}/scope-amendment.json`, JSON.stringify({ release: w.id, version: "2.0.0-beta.25", amendments: [{ decidedBy: "auto-stage", deferredTickets: ["02-b.md"] }] }));
  ctx.state.releases[w.id] = { candidate: "2.0.0-beta.25.1", drive: { phase: "done", n: 1 } };
  w.tag = sha("1");
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "drive-untraced");
  assert.match(w.notices[0].text, /no change left in the release to take out/);
  assert.equal(w.driveCalls.length, 0);
});

test("the message follows the plan's rule: a failure on main outside the 3 nights is not called old news", async () => {
  const { w, ctx } = driven({ blocking: "- two computers move reminders", mainFailures: { "two computers move reminders": ["2026-11-05T03:00:00Z"] } });
  await A.autoStage(ctx);
  assert.doesNotMatch(w.notices[0].text, /not new with this release|also failed on main/);
});

test("a wait with no end is given up with a message: the checks of the revert, or the Windows setup of the new head", async () => {
  const a = driven();
  a.w.follow[900] = { state: "waiting" };
  assert.equal((await A.autoStage(a.ctx)).outcome, "waiting");
  const state = A.loadState(a.ctx.stateFile);
  state.releases[a.w.id].drive.waitingSince["revert-wait"] = "2026-11-14T01:00:00Z"; // more than 4 hours before the test clock
  const later = await A.autoStage({ ...a.ctx, state });
  assert.equal(later.outcome, "drive-stopped");
  assert.match(later.halt.words, /waited more than 4 hours/);
  const b = driven();
  b.w.refuseDrive = "GitHub holds no Windows setup built for commit 9999999.";
  assert.equal((await A.autoStage(b.ctx)).outcome, "waiting");
  const st = A.loadState(b.ctx.stateFile);
  st.releases[b.w.id].drive.waitingSince.freeze = "2026-11-14T01:00:00Z";
  assert.equal((await A.autoStage({ ...b.ctx, state: st })).outcome, "drive-stopped");
});

test("a freeze that was made but not seen ending is carried on, not stopped on its own tag", async () => {
  const { w, ctx } = driven();
  w.refuseDrive = "MichaelZelbel/x already has the tag candidate/2.0.0-beta.25.1, so 2.0.0-beta.25.1 was frozen before; nothing was written.";
  assert.equal((await A.autoStage(ctx)).outcome, "refrozen");
});

test("a re-freeze is found in the release's own folder by the scripts that look a release up by version", () => {
  const folders = ["godspeed-2.0.0-beta.26-steady", "godspeed-2.0.0-beta.18.1-first-day-works"];
  const plan = `repository: ${REPO}\n`;
  const rec = Object.create(G.Records.prototype);
  rec.releases = () => folders;
  rec.read = () => plan;
  assert.equal(rec.findRelease(REPO, "2.0.0-beta.26.1"), "godspeed-2.0.0-beta.26-steady");
  assert.equal(rec.findRelease(REPO, "2.0.0-beta.18.1"), "godspeed-2.0.0-beta.18.1-first-day-works", "a folder that carries the name itself wins");
});

test("a withdrawn plan with the same version does not stop the release that replaced it", () => {
  const plans = {
    "releases/godspeed-2.0.0-beta.26-keeps-its-word/plan.md": `repository: ${REPO}

Status: withdrawn (2026-11-15).
`,
    "releases/godspeed-2.0.0-beta.26-steady/plan.md": `repository: ${REPO}

Status: approved by Michael on 2026-11-16
`,
  };
  const rec = Object.create(G.Records.prototype);
  rec.releases = () => ["godspeed-2.0.0-beta.26-keeps-its-word", "godspeed-2.0.0-beta.26-steady"];
  rec.read = (p) => plans[p];
  assert.equal(rec.findRelease(REPO, "2.0.0-beta.26"), "godspeed-2.0.0-beta.26-steady");
  assert.equal(rec.findRelease(REPO, "2.0.0-beta.26.1"), "godspeed-2.0.0-beta.26-steady", "a re-freeze too");
  plans["releases/godspeed-2.0.0-beta.26-keeps-its-word/plan.md"] = `repository: ${REPO}

Status: approved
`;
  assert.throws(() => rec.findRelease(REPO, "2.0.0-beta.26"), /2 releases/, "two live plans still need a name");
});

// ---------- the version is the release step's own pull request (17 November 2026) ----------

const beta26Plan = `---
release: godspeed-2.0.0-beta.25-demo
repository: ${REPO}
---

# Godspeed 2.0.0-beta.25: steady

Status: approved by Michael on 2026-11-16.

The theme: Godspeed stays steady and says what is true. A restart answers at once.

## What it delivers (what changes for the person)

1. **Right after a restart the server answers at once** instead of showing "Let's reconnect" for
   a while. (#679) Full.
2. **A chat says plainly when the AI key was refused**, instead of calling it an outage. (#590,
   continuing pull request #660.) Full.
4. **A Timeline moment can be linked to a person who already exists.** (#669, continuing pull
   request #672.) Light.
5. **The screens stop promising what Godspeed no longer does**: deadline reminders beside the
   morning brief, pictures in the GitHub copy. (#664, the maintainer's own finding.) Light.
9. **The Hevy scenario stops finding its own test key** in another scenario's file. (New issue.)
   Light.

- Issues: item 1 #101, 2 #102, each labelled \`beta.25\`.

## What it does not do

- Nothing else.
`;

test("the README section lists only what ships, in everyday words, and never a test-only item", () => {
  const notes = A.versionNotes({ plan: beta26Plan, version: "2.0.0-beta.26", deferred: ["01-restart.md", "02-chat.md"] });
  assert.equal(notes, [
    "## New in 2.0.0-beta.26",
    "",
    "Godspeed stays steady and says what is true.",
    "",
    "- **A Timeline moment can be linked to a person who already exists.**",
    "- **The screens stop promising what Godspeed no longer does**: deadline reminders beside the morning brief, pictures in the GitHub copy.",
    "",
  ].join("\n"));
  const all = A.deliveredItems(beta26Plan, []).map((i) => i.line);
  assert.equal(all[0], `**Right after a restart the server answers at once** instead of showing "Let's reconnect" for a while.`);
  assert.equal(all[1], "**A chat says plainly when the AI key was refused**, instead of calling it an outage.");
  assert.ok(!all.some((l) => /#\d|Full|Light|pull request|Hevy/.test(l)), "no issue numbers, sizes, pull requests or test-only items");
});

test("the version line and the README section are written once, above the newest one", () => {
  const pkg = '{\n  "name": "n",\n  "version": "2.0.0-beta.25",\n  "private": true\n}\n';
  assert.equal(A.withVersion(pkg, "2.0.0-beta.26"), pkg.replace("beta.25", "beta.26"));
  assert.equal(A.withVersion('{"name": "n"}', "2.0.0-beta.26"), null);
  const readme = "# Godspeed\n\nIntro.\n\n## New in 2.0.0-beta.25\n\nOld.\n";
  const section = "## New in 2.0.0-beta.26\n\nNew.\n";
  const once = A.withReadmeSection(readme, "2.0.0-beta.26", section);
  assert.equal(once, "# Godspeed\n\nIntro.\n\n## New in 2.0.0-beta.26\n\nNew.\n\n## New in 2.0.0-beta.25\n\nOld.\n");
  assert.equal(A.withReadmeSection(once, "2.0.0-beta.26", section), once, "a section that is there already is not added again");
});

const PIN = "9".repeat(40); // main's head when every ticket was done (world's mainTip)
const V = "7".repeat(40); // the version commit on top of it
function versioned({ pr = null, required = "running", mergeOk = true, extra = {}, issues = closedBoth } = {}) {
  const made = world({ issues, scenarioSeq: [{ result: "none" }], extra });
  const { w, ctx } = made;
  w.pr = pr;
  w.vcalls = [];
  w.required = required;
  ctx.versionPull = {
    find: async (branch) => { w.vcalls.push(["find", branch]); return w.pr; },
    versionAt: async () => w.extra.versionAtPin || "2.0.0-beta.24",
    parentOf: async () => w.extra.parentOf || PIN,
    open: async (x) => { w.vcalls.push(["open", x.branch, x.title, x.onto]); w.opened = x; w.pr = { number: 701, state: "open", merged: false, head: V, title: x.title }; return { pr: 701, head: V }; },
    update: async (x) => { w.vcalls.push(["update", x.branch, x.onto]); w.pr = { ...w.pr, head: "5".repeat(40) }; return { head: "5".repeat(40) }; },
    pointBranch: async (b, sha) => { w.vcalls.push(["point", b, sha]); return { branch: b }; },
    required: async () => ({ state: w.required }),
    failures: async () => '"suite" failed; the checks failed: suite',
    merge: async (x) => { w.vcalls.push(["merge", x.pr, x.head, x.method]); if (!mergeOk) return { ok: false, message: "status 405" }; w.pr = { ...w.pr, state: "closed", merged: true }; return { ok: true, sha: "6".repeat(40) }; },
  };
  return made;
}

test("a finished release opens the release step's own version pull request once, on the pinned commit; a crash after opening finds it, never a second one", async () => {
  const { w, ctx } = versioned();
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "waiting");
  assert.deepEqual(w.vcalls.filter((c) => c[0] === "open"), [["open", "release/version-2.0.0-beta.25", "Release step of 2.0.0-beta.25: the version", PIN]], "one commit on the pin, not on whatever main is later");
  assert.match(w.opened.section, /^## New in 2\.0\.0-beta\.25\n/);
  assert.match(w.opened.body, /Guide-Reviewed: none-needed \(/, "the guide check is cleared in the pull request");
  assert.match(w.opened.message, /^Release step of 2\.0\.0-beta\.25: the version\n\nGuide-Reviewed: none-needed/);
  const st = A.loadState(ctx.stateFile).releases[w.id];
  assert.deepEqual([st.bump.pr, st.bump.head, st.bump.parent, st.pin.commit], [701, V, PIN, PIN]);
  assert.equal(w.notices.length, 0, "opening it is no news for him");
  // a look that crashed before saving: GitHub has it, and its commit stands on the pin, so nothing is opened again
  const fresh = { ...ctx, state: { version: 1, releases: {} } };
  await A.autoStage(fresh);
  assert.equal(w.vcalls.filter((c) => c[0] === "open").length, 1);
  assert.equal(fresh.state.releases[w.id].bump.head, V, "the pull request found is taken as the step's own");
});

test("main already at a newer version than the approved release: no version pull request is opened", async () => {
  const { w, ctx } = versioned({ extra: { versionAtPin: "2.0.0-beta.28" } });
  const lines = [];
  ctx.log = (x) => lines.push(x);
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "waiting");
  assert.equal(w.vcalls.filter((c) => c[0] === "open").length, 0, "nothing is opened");
  assert.ok(lines.some((l) => /Superseded: .* main already carries the newer 2\.0\.0-beta\.28/.test(l)));
  assert.equal(w.notices.length, 0);
});

test("the version pull request is merged with a merge commit once its own required check passes, and that very commit is frozen in the same look", async () => {
  const { w, ctx } = versioned({ pr: { number: 701, state: "open", merged: false, head: V, title: "Release step of 2.0.0-beta.25: the version" }, required: "running" });
  assert.equal((await A.autoStage(ctx)).outcome, "waiting");
  assert.equal(w.vcalls.filter((c) => c[0] === "merge").length, 0, "not merged while its check runs");
  w.required = "passed";
  w.scenarioSeq = [{ result: "none" }, passed];
  const r = await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.deepEqual(w.vcalls.filter((c) => c[0] === "merge"), [["merge", 701, V, "merge"]], "merged at the head its check passed on, with a merge commit");
  assert.equal(A.loadState(ctx.stateFile).releases[w.id].bump.merged, "6".repeat(40));
  assert.equal(r.outcome, "ready", "frozen and asked in the same look: no second build cycle for the merge");
  assert.deepEqual(w.calls.slice(-4), ["freeze.mjs --dry-run", "freeze.mjs", "stage-server.mjs", "staging-check.mjs"]);
  assert.deepEqual([...new Set(w.freezeCommits)], [V], "the version commit is frozen, not the merge commit and not main's newest head");
  assert.equal(w.notices.length, 0);
});

test("a version pull request whose check failed is run once more, then said once with its cause, and merged by itself once it passes", async () => {
  const { w, ctx } = versioned({ pr: { number: 701, state: "open", merged: false, head: V, title: "t" }, required: "failed" });
  await A.autoStage(ctx);
  assert.deepEqual(w.checkReruns, [V], "its failed jobs are run once more first");
  assert.equal(w.notices.length, 0, "nothing said before that");
  let t = ctx.now() + 3 * 60 * 1000;
  await A.autoStage({ ...ctx, now: () => t, state: A.loadState(ctx.stateFile) });
  t += 60 * 1000;
  await A.autoStage({ ...ctx, now: () => t, state: A.loadState(ctx.stateFile) });
  assert.deepEqual(w.checkReruns, [V], "once, never twice");
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0].text, /raises its version number did not pass its checks: "suite" failed/);
  assert.match(w.notices[0].text, /merge it by myself as soon as it passes/);
  assert.equal(w.vcalls.filter((c) => c[0] === "merge").length, 0);
  w.required = "passed";
  w.scenarioSeq = [{ result: "none" }, passed];
  await A.autoStage({ ...ctx, now: () => t, state: A.loadState(ctx.stateFile) });
  assert.equal(w.vcalls.filter((c) => c[0] === "merge").length, 1);
});

test("a dry look says what the version step would do and does it not", async () => {
  const { w, ctx } = versioned();
  for (const [f, c] of [["01-a.md", "a"], ["02-b.md", "b"]]) w.files.set(`releases/${w.id}/tickets/${f}`, A.markTicket("Ticket.\n", c.repeat(40)));
  ctx.dry = true;
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "would-raise-version");
  assert.equal(w.vcalls.filter((c) => c[0] !== "find").length, 0);
  assert.ok(w.log.some((l) => /## New in 2\.0\.0-beta\.25/.test(l)));
  assert.equal(fs.existsSync(ctx.stateFile), false, "nothing written");
});

test("review fix: a move of the version pull request onto a new pin that a look did not see end is the step's own; somebody else's push is not", async () => {
  const moved = "5".repeat(40);
  const setup = (moving) => {
    const made = versioned({ pr: { number: 701, state: "open", merged: false, head: moved, title: "t" } });
    Object.assign(A.releaseState(made.ctx.state, made.w.id), { pin: { commit: PIN, at: "2026-11-14T09:00:00Z" }, bump: { branch: "release/version-2.0.0-beta.25", pr: 701, head: V, parent: "1".repeat(40), ...(moving ? { moving: PIN } : {}) } });
    return made;
  };
  const ours = setup(true);
  const r1 = await A.autoStage(ours.ctx);
  assert.equal(r1.outcome, "waiting");
  assert.equal(A.loadState(ours.ctx.stateFile).releases[ours.w.id].bump.head, moved, "taken as the step's own commit");
  assert.equal(ours.w.vcalls.filter((c) => c[0] === "update").length, 0, "not moved a second time");
  const theirs = setup(false);
  const r2 = await A.autoStage(theirs.ctx);
  assert.equal(r2.outcome, "needs-judgment");
  assert.match(r2.halt.words, /somebody else pushed to the version pull request #701/);
});

test("review fix: a check run once more that GitHub refused is asked again, never counted as the one", async () => {
  const { w, ctx } = versioned({ pr: { number: 701, state: "open", merged: false, head: V, title: "t" }, required: "failed" });
  let refuse = true;
  ctx.rerunChecks = async (sha) => {
    if (refuse) throw new R.Refused("GitHub said 502 to the rerun.");
    (w.checkReruns ||= []).push(sha);
    return 1;
  };
  await assert.rejects(A.autoStage(ctx), /502/);
  assert.equal((A.loadState(ctx.stateFile).releases[w.id].reruns || {})[V], undefined, "a refused request is not the run once more");
  refuse = false;
  await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.deepEqual(w.checkReruns, [V]);
  assert.ok(A.loadState(ctx.stateFile).releases[w.id].reruns[V]);
  assert.equal(w.notices.length, 0, "nothing said: it was run once more only now");
});

test("review fix: a failed build whose run once more GitHub refused is asked again; only its real second failure halts, with its cause", async () => {
  const box = { attempt: 1, refuse: true };
  const pin = "9".repeat(40);
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }], extra: { buildReady: (kind) => kind !== "image", buildRun: (kind) => (kind === "image" ? { id: 9, status: "completed", conclusion: "failure", startedAt: "2026-11-14T09:40:00Z", attempt: box.attempt, url: "https://x/runs/9" } : null) } });
  ctx.rerunFailed = async () => {
    if (box.refuse) throw new R.Refused("GitHub said 403 to running the failed jobs of run 9 again.");
    box.attempt = 2;
  };
  const r1 = await A.autoStage(ctx);
  assert.equal(r1.outcome, "waiting");
  assert.equal(r1.halt, undefined);
  assert.equal((((A.loadState(ctx.stateFile).releases[w.id].builds || {})[pin] || {}).image || {}).rerunAt, undefined, "not counted");
  box.refuse = false;
  await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.ok(A.loadState(ctx.stateFile).releases[w.id].builds[pin].image.rerunAt, "written down once GitHub took it");
  const r3 = await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.equal(r3.halt.key, "blocked-build-failed");
  assert.match(r3.halt.words, /could not build the server image for 9999999: its run failed, also when it was run once more \(https:\/\/x\/runs\/9\)/);
  assert.deepEqual(w.calls, [], "nothing frozen");
});

test("review fix: a gate file GitHub cannot give now is a wait in the look's line, never a run of every test, and a halt once it lasted", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }], extra: { gate: null } });
  w.tag = "1".repeat(40);
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "waiting");
  assert.equal(w.dispatches, 0, "nothing started without the list");
  assert.ok(w.log.some((l) => /^Waiting: the list of the release's tests on candidate\/2\.0\.0-beta\.25 cannot be read from GitHub now/.test(l)), w.log.join("\n"));
  let t = ctx.now() + 2 * 3600 * 1000;
  const later = await A.autoStage({ ...ctx, now: () => t, state: A.loadState(ctx.stateFile) });
  assert.equal(later.halt.key, "blocked-gate");
});

test("a freeze that says the tag exists is carried on from the tag, not said to him", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }], extra: { freezeCheckRefuses: `${REPO} already has the tag candidate/2.0.0-beta.25, so 2.0.0-beta.25 was frozen before; nothing was written.` } });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "waiting");
  assert.equal(w.notices.length, 0);
});

test("a refusal that will not pass by itself is a halt with its cause, and every look tries again", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }], extra: { freezeCheckRefuses: "There are open approved-plan tickets: 01-a.md." } });
  const rr = await A.autoStage(ctx);
  assert.equal(w.notices.length, 0);
  assert.match(rr.halt.words, /some tickets of the plan are not marked as finished/);
  assert.doesNotMatch(rr.halt.words, /by hand/);
  await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.equal(w.calls.filter((c) => c === "freeze.mjs --dry-run").length, 2, "the next look tried again");
  assert.equal(w.notices.length, 0, "and said nothing");
  w.extra.freezeCheckRefuses = null;
  w.scenarioSeq = [{ result: "none" }, passed];
  assert.equal((await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) })).outcome, "ready", "nothing halted it");
});

test("an item whose issue was closed with nothing on main waits for the factory driver's amendment, quietly; with it the rest ships", async () => {
  // only the factory driver moves tickets (2026-11-18): auto-stage never writes the amendment itself
  const issues = { ...closedBoth, 102: { state: "CLOSED", stateReason: "NOT_PLANNED", merges: [] } };
  const { w, ctx } = world({ issues, scenarioSeq: [{ result: "none" }, passed], planText: drivePlan() });
  const r = await A.autoStage(ctx);
  assert.deepEqual([r.outcome, r.why], ["waiting", "dead ends"]);
  assert.equal(w.files.has(`releases/${w.id}/scope-amendment.json`), false, "nothing written");
  assert.equal(w.notices.length, 0, "nothing said: the driver acts within minutes and tells him itself");
  // the factory driver's entry, the shape its cut writes
  w.files.set(`releases/${w.id}/scope-amendment.json`, JSON.stringify({ release: w.id, version: "2.0.0-beta.25", amendments: [{
    release: w.id, version: "2.0.0-beta.25", decidedBy: "factory-driver", authority: "plan-rule", words: RULE_LINE, approvalRef: `releases/${w.id}/plan.md: Status: approved`,
    deferredTickets: ["02-b.md"], reasons: { "02-b.md": { item: 2, issue: 102, why: "its issue was closed as not planned", evidence: ["issue #102 was closed (not planned)"] } } }] }));
  const again = await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.equal(again.outcome, "ready");
});

test("without the plan's rule an item at a dead end is a halt and nothing is moved; with it, nothing is said while the driver decides", async () => {
  const issues = { ...closedBoth, 102: { state: "CLOSED", stateReason: "NOT_PLANNED", merges: [] } };
  const a = world({ issues, scenarioSeq: [{ result: "none" }] });
  const ra = await A.autoStage(a.ctx);
  assert.equal(ra.outcome, "needs-judgment");
  assert.equal(a.w.files.has(`releases/${a.w.id}/scope-amendment.json`), false);
  assert.equal(a.w.notices.length, 0, "a halt, never a message");
  assert.match(ra.halt.words, /item 2 of the plan was closed without being done \(not planned\), and the plan has no rule that lets such an item leave the release/);
  const both = { 101: { ...issues[102] }, 102: issues[102] };
  const b = world({ issues: both, scenarioSeq: [{ result: "none" }], planText: drivePlan() });
  assert.equal((await A.autoStage(b.ctx)).outcome, "waiting");
  assert.equal(b.w.files.has(`releases/${b.w.id}/scope-amendment.json`), false, "auto-stage never cuts; a release is never cut down to nothing (freeze's reader refuses it)");
  assert.equal(b.w.notices.length, 0);
});

test("a failed run's failed jobs leave out the jobs that were skipped on purpose", async () => {
  const jobs = [["a", "failure"], ["b", "cancelled"], ["c", "skipped"], ["d", "skipped"], ["e", "success"]].map(([name, conclusion]) => ({ name, conclusion }));
  const api = async () => ({ ok: true, json: { total_count: 5, jobs } });
  assert.deepEqual(await G.failedJobNames(api, REPO, 1), ["a", "b"]);
});

// ---------- issue #155 (2026-11-24): the STOP never outlives the scenarios, and a failed candidate is always filed ----------
// Beta.31's candidate run failed at 13:40 UTC; GitHub answered 502 to the run's jobs, every look ended there, and the
// step's STOP (relabelled "stage" by a helper) halted the factory until a person removed it at 14:00.

const JOB = "two computers move reminders";
const FIRST_DAY = "a fresh Docker server turns a first goal into useful work and a matching Telegram brief";
const jobsUnread = { result: "failed", run: 7, url: "u", tag: "candidate/2.0.0-beta.25" }; // the scenarios' own read of the jobs got no answer
const ISSUE_1105 = { number: 1105, title: "The first morning brief on a fresh server does not name the person's first goal (beta.31 candidate scenario)", body: `The 2.0.0-beta.31 candidate's everyday scenario "${FIRST_DAY}" failed (run https://github.com/MichaelZelbel/godspeed-mission-control/actions/runs/45396974921).` };

test("issue #155: the STOP goes the moment the scenarios have ended, before the install is waited for and before anything is read to summarise them", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, passed], extra: { serverDelayMs: 30 } });
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "ready");
  const removed = w.log.indexOf("The factory's STOP file was removed.");
  const onServer = w.log.findIndex((l) => /is on the server\.$/.test(l));
  assert.ok(removed >= 0 && onServer > removed, `the STOP was removed before the install ended:\n${w.log.join("\n")}`);
  assert.deepEqual(w.stopSeenDuring.filter(([n]) => n === "staging-check.mjs").map(([, s]) => s), [false]);
});

test("issue #155: a failed first run lets the factory go while the install still runs, and the one rerun of its failed jobs pauses it again", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, failed, failed, failed], extra: { serverDelayMs: 30 } });
  ctx.rerunFailed = async () => { w.reruns++; w.stopSeenDuring.push(["rerun", fs.existsSync(w.stop)]); };
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "failed-tests");
  const at = (re) => w.log.findIndex((l) => re.test(l));
  const firstRemoved = at(/^The factory's STOP file was removed\.$/);
  assert.ok(firstRemoved >= 0 && at(/is on the server\.$/) > firstRemoved, w.log.join(" / "));
  assert.ok(at(/paused again while the failed jobs run once more/) > at(/is on the server\.$/));
  assert.deepEqual(w.stopSeenDuring.filter(([n]) => n === "rerun").map(([, s]) => s), [true], "paused while the rerun runs");
  assert.equal(w.log.filter((l) => l === "The factory's STOP file was removed.").length, 2, "once after the run, once after its rerun");
  assert.equal(fs.existsSync(w.stop), false);
});

test("issue #155: a failure the rebuild takes out of the release is filed before the rebuild starts", async () => {
  const { w, ctx } = driven();
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "refrozen");
  assert.deepEqual(w.filed.map((i) => i.title), [`Nightly scenario failed: ${JOB}`]);
  assert.ok(ctx.state.releases[w.id].filed[`2.0.0-beta.25 ${JOB}`]);
});

test("issue #155, today's case: the run's jobs answer 502, so its failed jobs are named from its check runs, with the factory running again, and each is filed once, never beside an open issue that names it", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, jobsUnread, jobsUnread, jobsUnread] });
  ctx.failedJobs = async () => { w.stopSeenDuring.push(["jobs", fs.existsSync(w.stop)]); return null; }; // GitHub said 502 to /actions/runs/<id>/jobs
  ctx.failedChecks = async () => { w.stopSeenDuring.push(["checks", fs.existsSync(w.stop)]); return [JOB, FIRST_DAY, "the verdict"]; };
  ctx.jobLog = async () => null; // the same 502
  w.open = [{ ...ISSUE_1105 }];
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "failed-tests");
  assert.equal(fs.existsSync(w.stop), false);
  const summarising = w.stopSeenDuring.filter(([n]) => ["jobs", "checks", "file", "staging-check.mjs"].includes(n));
  assert.ok(summarising.length >= 4 && summarising.every(([, s]) => s === false), `nothing that summarises or files holds the factory: ${JSON.stringify(summarising)}`);
  assert.deepEqual(w.filed.map((i) => i.title), [`Nightly scenario failed: ${JOB}`], "filed by name; the job #1105 names is not filed again, the summary job never");
  assert.deepEqual(w.filed[0].labels, ["bug", "scenario-failure", "archon-triage"], "labelled as main's nightly files a failed everyday scenario");
  assert.match(w.filed[0].body, /The everyday scenario "two computers move reminders" failed on the candidate of 2\.0\.0-beta\.25 \(u\)/);
  assert.match(w.filed[0].body, /Its log could not be read when this was filed/);
  assert.ok(A.namesJob(w.filed[0], JOB) && A.namesJob(ISSUE_1105, FIRST_DAY) && !A.namesJob(ISSUE_1105, JOB));
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0].text, /its log could not be read from GitHub/);
  const rs = ctx.state.releases[w.id];
  assert.equal(rs.filed[`2.0.0-beta.25 ${FIRST_DAY}`].issue, 1105);
  assert.equal(rs.filed[`2.0.0-beta.25 ${FIRST_DAY}`].already, true);
  assert.ok(rs.finished);
  assert.ok(w.log.some((l) => /read from its check runs, because GitHub's list of its jobs did not answer/.test(l)));
});

test("issue #155: when GitHub can name the failed jobs neither from the jobs nor from the check runs, the look ends unfinished with the factory running, and the next look names and files them", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, jobsUnread] });
  ctx.failedJobs = async () => null;
  ctx.failedChecks = async () => null;
  const r1 = await A.autoStage(ctx);
  assert.deepEqual([r1.outcome, r1.why], ["waiting", "failed jobs unknown"]);
  assert.equal(fs.existsSync(w.stop), false, "the factory runs while the summary waits");
  assert.deepEqual([w.notices.length, (w.filed || []).length], [0, 0]);
  assert.equal(ctx.state.releases[w.id].finished, undefined);
  const next = { ...ctx, state: A.loadState(ctx.stateFile), failedChecks: async () => [JOB, "the verdict"] };
  const r2 = await A.autoStage(next);
  assert.equal(r2.outcome, "failed-tests");
  assert.ok(w.log.includes("Nothing is running, so the factory is not paused."));
  assert.deepEqual(w.filed.map((i) => i.title), [`Nightly scenario failed: ${JOB}`]);
  assert.equal(w.notices.length, 1);
  assert.deepEqual([w.dispatches, w.reruns], [1, 1], "one run, one rerun, never more");
  assert.equal(fs.existsSync(w.stop), false);
  const r3 = await A.autoStage({ ...next, state: A.loadState(ctx.stateFile) });
  assert.match(r3.outcome, /finished|nothing/);
  assert.deepEqual([w.filed.length, w.notices.length], [1, 1], "nothing filed or said twice");
});

test("issue #155: a filing GitHub refuses is made by the next look, before anything is said, and nothing twice", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, failed] });
  const fileIssue = ctx.fileIssue;
  ctx.fileIssue = async () => { throw new R.Refused("GitHub said 502 to POST /repos/x/issues."); };
  await assert.rejects(() => A.autoStage(ctx), /502/);
  assert.equal(w.notices.length, 0, "filed first");
  assert.equal(A.loadState(ctx.stateFile).releases[w.id].finished, undefined, "not finished while unfiled");
  assert.equal(fs.existsSync(w.stop), false);
  const r = await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile), fileIssue });
  assert.equal(r.outcome, "failed-tests");
  assert.deepEqual(w.filed.map((i) => i.title), [`Nightly scenario failed: ${JOB}`]);
  assert.match(w.filed[0].body, /What went wrong, as its log says: GitHub limited how many requests/);
  assert.equal(w.notices.length, 1);
});

test("issue #155: a failed candidate is filed before the install's record or a rebuild can end the look", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, failed], extra: { stageServerThrows: true } });
  assert.equal((await A.autoStage(ctx)).outcome, "waiting");
  assert.deepEqual(w.filed.map((i) => i.title), [`Nightly scenario failed: ${JOB}`], "filed on the first look, though the install left no record");
  await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  const r3 = await A.autoStage({ ...ctx, state: A.loadState(ctx.stateFile) });
  assert.equal(r3.halt.key, "not-staged");
  assert.equal(w.filed.length, 1, "once");
  const d = driven({ over: { itemPulls: async () => { throw new R.Refused("GitHub said 502 to /graphql."); } } });
  await assert.rejects(() => A.autoStage(d.ctx), /502/);
  assert.deepEqual(d.w.filed.map((i) => i.title), [`Nightly scenario failed: ${JOB}`], "filed before the rebuild reads anything");
});

test("issue #155: a failed run whose only failed job is the summary job files that one; one that names no failed job files the run", async () => {
  const a = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, { ...failed, failedJobs: ["the verdict"] }] });
  assert.equal((await A.autoStage(a.ctx)).outcome, "failed-tests");
  assert.deepEqual(a.w.filed.map((i) => i.title), ["Nightly scenario failed: the verdict"]);
  const b = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, { ...failed, failedJobs: [] }] });
  assert.equal((await A.autoStage(b.ctx)).outcome, "failed-tests");
  assert.deepEqual(b.w.filed.map((i) => i.title), ["Nightly scenario failed: the scenario run of 2.0.0-beta.25, which names no failed job"]);
  assert.equal(b.w.notices.length, 1);
});

test("issue #155: the stage's read of the public stage file goes through the same retries", async () => {
  const wrapped = [];
  const o2 = R.outside({ env: {}, ownerRepo: "o/r", isPrivate: false, wrap: (f) => { wrapped.push(f); return async () => ({ ok: true, status: 200, bytes: Buffer.from(JSON.stringify({ version: "2.0.0-beta.30" })) }); } });
  const st = await o2.stageAt("beta");
  assert.equal(st.stage.version, "2.0.0-beta.30");
  assert.equal(wrapped.length, 2, "both the API and the raw reads are wrapped");
});

test("issue #155: a STOP of the step relabelled \"stage\" is still the step's own: taken over with this look's process number and removed when the scenarios end", async () => {
  const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [{ result: "none" }, { result: "running", run: 7 }, passed] });
  fs.writeFileSync(w.stop, "stage 2639648 2026-11-24T12:47:44.892Z\nThe release step pauses the factory while the scenarios run (the driver's stage step).\n");
  let during = null;
  ctx.dispatch = async () => { w.dispatches++; during = fs.readFileSync(w.stop, "utf8"); };
  const r = await A.autoStage(ctx);
  assert.equal(r.outcome, "ready");
  assert.match(during, new RegExp(`^auto-stage ${process.pid} `), "written again with the process that runs");
  assert.equal(fs.existsSync(w.stop), false);
  fs.writeFileSync(w.stop, "Operator stopped new factory launches.\n");
  assert.deepEqual([A.stopIsMine(w.stop), A.takeStop(w.stop, ctx.now()), fs.readFileSync(w.stop, "utf8")], [false, false, "Operator stopped new factory launches.\n"], "the operator's STOP is never taken");
});

test("issue #155: a look that finds the scenarios ended removes a STOP an earlier look of the step left behind; somebody else's stays", async () => {
  for (const [text, gone] of [["auto-stage 2639648 2026-11-24T12:47:44.892Z\n", true], ["stage 2639648 2026-11-24T12:47:44.892Z\n", true], ["Operator stopped new factory launches.\n", false]]) {
    const { w, ctx } = world({ issues: closedBoth, scenarioSeq: [failed], staging: { version: "2.0.0-beta.25", productCommit: "8".repeat(40), status: "installed", installedAt: "2026-11-14T09:30:00Z", healthAfter: { ok: true, version: "2.0.0-beta.25" } } });
    w.tag = "1".repeat(40);
    const at = new Date(ctx.now() - 3600 * 1000).toISOString();
    Object.assign(A.releaseState(ctx.state, w.id), { started: at, freezeStartedAt: at, frozen: at, dispatchedAt: at, rerunAt: at, rerunFromAttempt: 1 });
    fs.writeFileSync(w.stop, text);
    const r = await A.autoStage(ctx);
    assert.equal(r.outcome, "failed-tests");
    assert.equal(fs.existsSync(w.stop), !gone, text);
    assert.equal(w.log.some((l) => /left behind was removed/.test(l)), gone, text);
  }
});

test("issue #155: a GitHub read that answers 5xx or nothing is asked again after a pause; a write never is, and the pauses have a budget", async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const answers = (list) => { const calls = []; return { calls, api: async (m, p) => { calls.push([m, p]); const a = list.shift(); if (a instanceof Error) throw a; return a; } }; };
  let s = answers([{ ok: false, status: 502 }, { ok: false, status: 503 }, { ok: true, status: 200, json: { jobs: [] } }]);
  assert.equal((await R.retrying(s.api, { sleep })("GET", "/repos/o/r/actions/runs/45396974921/jobs?per_page=100")).status, 200);
  assert.deepEqual(waits, [5000, 20000]);
  waits.length = 0;
  s = answers([{ ok: false, status: 502 }]);
  assert.equal((await R.retrying(s.api, { sleep })("POST", "/repos/o/r/issues", { title: "x" })).status, 502);
  assert.deepEqual([s.calls.length, waits], [1, []], "a write is never sent twice");
  s = answers([{ ok: false, status: 502 }, { ok: true, status: 200 }]);
  assert.equal((await R.retrying(s.api, { sleep })("POST", "/graphql", { query: "query { viewer { login } }" })).status, 200, "a GraphQL query is a read");
  s = answers([{ ok: false, status: 502 }]);
  assert.equal((await R.retrying(s.api, { sleep })("POST", "/graphql", { query: "mutation { x }" })).status, 502, "a mutation is not");
  s = answers([{ ok: false, status: 404 }]);
  assert.equal((await R.retrying(s.api, { sleep })("GET", "/x")).status, 404);
  assert.equal(s.calls.length, 1, "4xx is an answer");
  waits.length = 0;
  s = answers([1, 2, 3, 4].map(() => new Error("socket hang up")));
  await assert.rejects(() => R.retrying(s.api, { sleep })("GET", "/x"), /socket hang up/);
  assert.deepEqual(waits, [5000, 20000, 60000]);
  waits.length = 0;
  const spent = R.retrying(async () => ({ ok: false, status: 502 }), { sleep, budgetMs: 30000 });
  await spent("GET", "/a");
  await spent("GET", "/b");
  assert.deepEqual(waits, [5000, 20000, 5000], "one caller's pauses stop at its budget");
});

test("issue #155: the failed jobs' names come from the run's check runs when its jobs cannot be read", async () => {
  const runs = [["a", "failure"], ["b", "success"], ["c", "skipped"], ["d", "cancelled"]].map(([name, conclusion]) => ({ name, status: "completed", conclusion }));
  const api = async (m, p) => {
    if (/\/actions\/runs\/45396974921$/.test(p)) return { ok: true, json: { check_suite_id: 99 } };
    if (/\/check-suites\/99\/check-runs\?filter=latest&per_page=100$/.test(p)) return { ok: true, json: { total_count: 4, check_runs: runs } };
    return { ok: false, status: 502 };
  };
  assert.deepEqual(await G.failedCheckNames(api, REPO, 45396974921), ["a", "d"]);
  assert.equal(await G.failedCheckNames(async () => ({ ok: false, status: 502 }), REPO, 1), null);
  assert.equal(await G.failedCheckNames(async () => { throw new Error("socket hang up"); }, REPO, 1), null);
});

await runCases();
