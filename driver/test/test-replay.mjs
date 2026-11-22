import { TEST_ENV } from "./env.mjs";
// node --test scripts/factory-driver/test-*.mjs
// The replay's own machinery, and the stalls the driver was built against. The held-back stalls are only
// ever run by `node replay/replay.mjs`; no test runs the driver on them (the last test only checks that their
// scheduler lines are in the fixture), so nothing here can pull code towards them.
import test from "node:test";
import assert from "node:assert/strict";
import { stateAt, fakeDepsAt, replayAll, loadGithub, loadDecisions } from "./replay/replay.mjs";
import { STALLS } from "./replay/build.mjs";

const T = s => Date.parse(s);
const issue = { number: 1, pr: false, createdAt: "2026-11-10T10:00:00Z", events: [
  { at: "2026-11-10T10:00:01Z", event: "labeled", label: "bug" },
  { at: "2026-11-10T12:00:00Z", event: "labeled", label: "needs-owner" },
  { at: "2026-11-11T12:00:00Z", event: "unlabeled", label: "needs-owner" },
  { at: "2026-11-12T12:00:00Z", event: "closed", reason: "not_planned" },
  { at: "2026-11-13T12:00:00Z", event: "reopened" },
  { at: "2026-11-10T13:00:00Z", event: "commented", author: "a", body: "hi" },
] };

test("an item as it was: labels, state and comments at a moment, nothing from after", () => {
  assert.equal(stateAt(issue, T("2026-11-09T00:00:00Z")), null, "not created yet");
  const a = stateAt(issue, T("2026-11-10T14:00:00Z"));
  assert.deepEqual(a.labels.sort(), ["bug", "needs-owner"]);
  assert.equal(a.comments.length, 1);
  assert.deepEqual(stateAt(issue, T("2026-11-11T13:00:00Z")).labels, ["bug"]);
  const c = stateAt(issue, T("2026-11-12T13:00:00Z"));
  assert.deepEqual([c.state, c.reason, c.closedAt], ["closed", "not_planned", "2026-11-12T12:00:00Z"]);
  const d = stateAt(issue, T("2026-11-14T00:00:00Z"));
  assert.deepEqual([d.state, d.reason, d.closedAt], ["open", null, null]);
});

test("the fake GitHub answers what the driver's reading asks, as of the moment", () => {
  const gh = { items: { 1: issue }, checks: {} };
  const deps = fakeDepsAt(gh, [], T("2026-11-10T14:00:00Z"));
  const row = deps.gh(["repos/o/r/issues/1"]);
  assert.deepEqual([row.state, row.labels.map(l => l.name).sort()], ["open", ["bug", "needs-owner"]]);
  assert.deepEqual(deps.gh(["repos/o/r/issues?state=open&labels=needs-owner&per_page=100"]).map(x => x.number), [1]);
  assert.throws(() => fakeDepsAt(gh, [], T("2026-11-01T00:00:00Z")).gh(["repos/o/r/issues/1"]), /404/);
  assert.throws(() => deps.gh(["repos/o/r/nonsense"]), /no answer/);
});

test("the stalls the driver was built against each yield an obstacle whose next step is not a wait", async () => {
  const seen = STALLS.filter(s => !s.held).map(s => s.id);
  assert.equal(seen.length, 3);
  const out = await replayAll(seen);
  for (const r of out) {
    assert.ok(r.steps.length > 0, `${r.id}: no obstacle`);
    assert.ok(r.pass, `${r.id}: only waiting steps: ${JSON.stringify(r.steps.map(s => [s.kind, s.step.do]))}`);
    assert.deepEqual(r.unreadable, [], `${r.id}: a part of the world could not be rebuilt`);
  }
});

test("the scheduler fixture really holds the five stretches without a launch", () => {
  const lines = loadDecisions();
  for (const s of STALLS) {
    const t = Date.parse(s.at);
    const after = lines.filter(l => Date.parse(l.slice(0, 25)) >= t).slice(0, 8);
    assert.ok(after.length >= 8);
    assert.ok(after.every(l => /No launch|STOP|paused/.test(l)), `${s.id}: a launch right after the stretch began`);
  }
  assert.ok(Object.keys(loadGithub().items).length > 100);
});
