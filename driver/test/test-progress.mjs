import test from "node:test";
import assert from "node:assert/strict";
import { updateLedger, isWorking } from "../progress.mjs";

const T0 = Date.parse("2026-11-18T10:00:00Z");
const KEY = "rel#1";
const pr = (o = {}) => ({ number: 5, state: "open", merged: false, mergedAt: null, headSha: "a1", requiredState: "failure", requiredSince: "2026-11-18T09:00:00Z", lastCommitAt: "2026-11-18T08:00:00Z", comments: [], ...o });
const world = (item = {}, extra = {}) => ({
  at: new Date(T0).toISOString(), releases: [{ id: "rel", tickets: [{ item: 1, issue: 10, size: "m" }] }],
  items: { 10: { number: 10, state: "open", labels: [], closedAt: null, comments: [], prs: [pr()], ...item } }, staging: {}, factory: { activeRuns: [] }, ...extra,
});

test("a new comment does not change lastMilestoneAt", () => {
  const l1 = updateLedger({}, world(), T0);
  const w2 = world({ comments: [{ author: "x", body: "hi", at: "2026-11-18T10:20:00Z" }] });
  const l2 = updateLedger(l1, { ...w2, at: "2026-11-18T10:25:00Z" }, T0 + 25 * 60000);
  assert.equal(l2[KEY].lastMilestoneAt, l1[KEY].lastMilestoneAt);
  assert.equal(l2[KEY].lastActivityAt, "2026-11-18T10:20:00.000Z");
});

test("required going from failure to success adds required-green", () => {
  const l1 = updateLedger({}, world(), T0);
  assert.equal(l1[KEY].milestones.length, 0);
  const l2 = updateLedger(l1, world({ prs: [pr({ requiredState: "success", requiredSince: "2026-11-18T10:10:00Z" })] }), T0 + 15 * 60000);
  assert.deepEqual(l2[KEY].milestones.map(m => m.kind), ["required-green"]);
  assert.equal(l2[KEY].lastMilestoneAt, "2026-11-18T10:10:00.000Z");
  const l3 = updateLedger(l2, world({ prs: [pr({ requiredState: "success", requiredSince: "2026-11-18T10:10:00Z" })] }), T0 + 20 * 60000);
  assert.equal(l3[KEY].milestones.length, 1);
});

test("a merged PR adds pr-merged once, a closed issue issue-closed once", () => {
  const merged = world({ state: "closed", closedAt: "2026-11-18T09:50:00Z", prs: [pr({ state: "closed", merged: true, mergedAt: "2026-11-18T09:49:00Z" })] });
  let l = updateLedger({}, merged, T0);
  l = updateLedger(l, merged, T0 + 5 * 60000);
  l = updateLedger(l, merged, T0 + 10 * 60000);
  assert.deepEqual(l[KEY].milestones.map(m => m.kind).sort(), ["issue-closed", "pr-merged"]);
});

test("staged and installed are milestones of every ticket of the release", () => {
  const l1 = updateLedger({}, world({}, { staging: { rel: { status: "staged" } } }), T0);
  assert.deepEqual(l1[KEY].milestones.map(m => m.kind), ["staged"]);
  const l2 = updateLedger(l1, world({}, { staging: { rel: { status: "installed" } } }), T0 + 60000);
  assert.deepEqual(l2[KEY].milestones.map(m => m.kind), ["staged", "installed"]);
});

test("a ticket whose issue could not be read keeps its ledger untouched", () => {
  const l1 = updateLedger({}, world(), T0);
  const w = world(); w.items = {};
  const l2 = updateLedger(l1, w, T0 + 3600000);
  assert.deepEqual(l2, l1);
});

test("isWorking is false when the only activity is 31 minutes old, true at 29", () => {
  const w = c => world({ comments: [{ author: "x", body: "b", at: c }], prs: [pr({ lastCommitAt: "2026-11-18T01:00:00Z" })] });
  assert.equal(isWorking(KEY, w("2026-11-18T09:29:00Z"), T0), false);
  assert.equal(isWorking(KEY, w("2026-11-18T09:31:00Z"), T0), true);
  assert.equal(isWorking(KEY, w("2026-11-18T09:50:00Z"), T0), true);
  const run = world({}, { factory: { activeRuns: [{ id: "r", issue: 10, lastOutputAt: "2026-11-18T09:45:00Z" }] } });
  assert.equal(isWorking(KEY, run, T0), true);
});
