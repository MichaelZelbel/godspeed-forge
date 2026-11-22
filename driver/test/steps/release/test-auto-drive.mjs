// test cases: 10
import "./settings-fixture.mjs";
import assert from "node:assert/strict";
import { test, runCases } from "../case-test.mjs";
import * as D from "../../../steps/release/auto-drive.mjs";

const plan = `Status: approved by Michael

**Blocking scenarios:**

- the fresh installed server and browser check, restart included (items 1, 6)
- Docker and Linux import made-up Hevy workouts (item 9)
- two computers that move the same reminders at once (its token arrives with product PR #681)
- hidden scenarios in godspeed-holdouts: H-19..H-26 and H-29 (items 2, 3), H-14..H-17
  (item 7), H-32 (item 4)

Every other failing job is named. An item that reaches a dead end leaves the release,
the rest ships.
`;

test("the plan's own rule is found even when the plan wraps it, and its status line is read", () => {
  assert.match(D.planRuleWords(plan), /^An item that reaches a dead end leaves the release, the rest ships$/i);
  assert.equal(D.planRuleWords("nothing here"), null);
  assert.equal(D.planStatusLine(plan), "Status: approved by Michael");
});

test("the blocking list says which plan items a scenario belongs to, ranges of hidden scenarios included", () => {
  const seg = D.blockingSegments(plan);
  assert.deepEqual(D.itemsForJob("fresh installed server and browser check", seg), [1, 6]);
  assert.deepEqual(D.itemsForJob("Docker and Linux import made-up Hevy workouts", seg), [9]);
  assert.deepEqual(D.itemsForJob("holdouts H-22 chat says key refused", seg), [2, 3]);
  assert.deepEqual(D.itemsForJob("holdouts H-15 talk prepared", seg), [7]);
  assert.deepEqual(D.itemsForJob("holdouts H-32", seg), [4]);
  assert.deepEqual(D.itemsForJob("two computers move the same reminders at once", seg), [], "named, but the plan gives no item");
});

test("failures are waived for main's last 3 nights or a test-machine cause, and nothing else", () => {
  const now = Date.parse("2026-11-17T10:00:00Z");
  const f = (over) => ({ job: "j", cause: { plain: "x", environment: false }, mainDates: [], blocking: true, ...over });
  const [a, b, c, d, e] = D.judgeFailures({
    nowMs: now,
    listed: true,
    failures: [f({}), f({ mainDates: ["2026-11-15T03:00:00Z"] }), f({ mainDates: ["2026-11-10T03:00:00Z"] }), f({ cause: { plain: "net", environment: true } }), f({ blocking: false })],
  });
  assert.deepEqual([a.holds, b.holds, c.holds, d.holds, e.holds], [true, false, true, false, false]);
  assert.match(b.waive, /last 3 nights/);
  assert.match(d.waive, /test-machine cause/);
  // without a list in the plan nothing is waived for being outside it
  assert.equal(D.judgeFailures({ nowMs: now, listed: false, failures: [f({ blocking: false })] })[0].holds, true);
});

test("tracing: one change from the plan; the files when the plan gives none; several changes is no answer", () => {
  const itemPulls = { 1: { number: 5, commit: "a".repeat(40) }, 2: { number: 6, commit: "b".repeat(40) }, 3: { number: 6, commit: "b".repeat(40) } };
  const ticketOfItem = { 1: "01-a.md", 2: "02-b.md", 3: "03-c.md" };
  const base = { plan, itemPulls, pullFiles: {}, logs: {}, ticketOfItem };
  const one = D.traceCulprit({ ...base, holding: [{ job: "holdouts H-22" }] });
  assert.equal(one.ok, true);
  assert.equal(one.pr.number, 6);
  assert.deepEqual(one.tickets, ["02-b.md", "03-c.md"], "a change that delivered two items takes both out");
  const two = D.traceCulprit({ ...base, holding: [{ job: "holdouts H-22" }, { job: "fresh installed server and browser check" }] });
  assert.equal(two.ok, false);
  const byFile = D.traceCulprit({ ...base, plan: "", holding: [{ job: "x" }], logs: { x: "Error at core/a.mjs:4" }, pullFiles: { 5: ["core/a.mjs"], 6: ["core/b.mjs"] } });
  assert.equal(byFile.pr.number, 5);
  assert.match(byFile.how, /files/);
});

test("the amendment is added beside a person's decision, which stays as it was", () => {
  const person = { release: "r", version: "v", approvedBy: "Michael", words: "later", approvalRef: "chat:1234567", approvedAt: "2026-11-06T14:00:00Z", deferredTickets: ["01-a.md"] };
  const out = JSON.parse(D.withAmendment(JSON.stringify(person), { decidedBy: "auto-stage", deferredTickets: ["02-b.md"] }));
  assert.deepEqual({ ...out, amendments: undefined }, { ...person, amendments: undefined });
  assert.equal(out.amendments.length, 1);
  const fresh = JSON.parse(D.withAmendment(null, { release: "r", version: "v", decidedBy: "auto-stage", deferredTickets: ["02-b.md"] }));
  assert.equal(fresh.release, "r");
  assert.throws(() => D.withAmendment("{not json", {}), /not JSON/);
});

test("the next candidate is named by the re-freezes already started", () => {
  assert.equal(D.nextCandidate("2.0.0-beta.26", 0), "2.0.0-beta.26.1");
  assert.equal(D.nextCandidate("2.0.0-beta.26", 1), "2.0.0-beta.26.2");
});

// One drive from the amendment on, against stand-ins. main is not part of `d` at all: the rebuild never reads it.
function standIns({ staging = { version: "2.0.0-beta.26", productCommit: "8".repeat(40) }, extra = [] } = {}) {
  const calls = [];
  const files = new Map([[`releases/r/staging.json`, JSON.stringify(staging)]]);
  const d = {
    records: { read: (p) => files.get(p) ?? null, json: (p) => (files.has(p) ? JSON.parse(files.get(p)) : null), write: (f) => Object.entries(f).forEach(([k, v]) => files.set(k, v)) },
    startRelease: async (x) => (calls.push(["release", x]), { pr: 901, head: "s".repeat(40) }),
    follow: async (x) => (calls.push(["follow", x.pr, x.kind]), { state: "merged", sha: "d".repeat(40) }),
    extraCommits: async (x) => (calls.push(["extra", x]), extra),
    run: async (args) => (calls.push(["run", args]), { code: 0, stdout: "", stderr: "" }),
    becameCandidate: (v) => calls.push(["candidate", v]),
  };
  return { d, calls };
}
const drive = (over = {}) => ({ phase: "release-start", n: 1, candidate: "2.0.0-beta.26", revert: { pr: 900, mergeSha: "c".repeat(40) }, culprit: { number: 6, commit: "b".repeat(40), why: "x", tickets: ["02-b.md"] }, ...over });
const step = (d, rs) => D.driveStep({ d, id: "r", base: "2.0.0-beta.26", plan, rs, save: () => {}, log: () => {}, now: () => Date.parse("2026-11-17T10:00:00Z"), repo: "o/p", stop: (why) => ({ outcome: "drive-stopped", why }) });

test("the rebuild is cut from the failed candidate's own commit on release/<version> and frozen from its merge", async () => {
  const { d, calls } = standIns();
  const rs = { drive: drive() };
  const r = await step(d, rs);
  assert.equal(r.outcome, "refrozen");
  const [, asked] = calls.find((c) => c[0] === "release");
  assert.deepEqual({ branch: asked.branch, from: asked.from, culprit: asked.culprit, version: asked.version }, { branch: "release/2.0.0-beta.26", from: "8".repeat(40), culprit: "b".repeat(40), version: "2.0.0-beta.26.1" });
  assert.deepEqual(calls.find((c) => c[0] === "follow").slice(1), [901, "release"]);
  const freeze = calls.filter((c) => c[0] === "run").map((c) => c[1]);
  assert.ok(freeze.length === 2 && freeze.every((a) => a[a.indexOf("--commit") + 1] === "d".repeat(40) && a.includes("2.0.0-beta.26.1")));
  assert.equal(rs.drive.release.mergeSha, "d".repeat(40));
});

test("a second rebuild goes on the same branch, from the first rebuild's commit", async () => {
  const { d, calls } = standIns({ staging: { version: "2.0.0-beta.26.1", productCommit: "e".repeat(40) } });
  await step(d, { drive: drive({ n: 2, candidate: "2.0.0-beta.26.1" }) });
  const [, asked] = calls.find((c) => c[0] === "release");
  assert.deepEqual([asked.branch, asked.from, asked.version], ["release/2.0.0-beta.26", "e".repeat(40), "2.0.0-beta.26.2"]);
});

test("without the failed candidate's commit there is nothing to cut from: it stops", async () => {
  const { d, calls } = standIns({ staging: { version: "2.0.0-beta.25", productCommit: "8".repeat(40) } });
  const r = await step(d, { drive: drive() });
  assert.equal(r.outcome, "drive-stopped");
  assert.match(r.why, /not recorded/);
  assert.equal(calls.length, 0);
});

test("a commit recorded at the drive's start wins over the staging record", async () => {
  const { d, calls } = standIns();
  await step(d, { drive: drive({ from: "f".repeat(40) }) });
  assert.equal(calls.find((c) => c[0] === "release")[1].from, "f".repeat(40));
});

await runCases();
