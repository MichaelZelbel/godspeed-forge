// node --disable-warning=ExperimentalWarning driver/test/steps/test-question-driver.mjs
// test cases: 4
// A factory question with nothing to pick from is the driver's own work (no queue without a reader): the world reads it
// from the questions step's state, it is an obstacle of kind "question", the decide helper settles it with the second
// check, and the decision names the question so the questions step and the accountant see it.
import { testCase } from "../../../test/cases.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { readRoutedQuestions } from "../../world.mjs";
import { findObstacles } from "../../obstacles.mjs";
import { nextStep, QUESTION_TRIES } from "../../ladder.mjs";
import { applyReport } from "../../act.mjs";
import { decidesQuestion, keyOf } from "../../steps/questions/factory-owner-questions.mjs";
import { names } from "../../steps/questions/accountant.mjs";

const H = 3600000, T0 = Date.parse("2026-11-24T12:00:00Z");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qdrv-"));
const key = keyOf("Status of #12 (#12)");
fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ routed: { [key]: { mc: true, at: "2026-11-16T08:00:00Z", repo: "acme/app", heading: "Status of #12 (#12)", number: 2, why: "nothing to pick from", link: "https://github.com/acme/app/issues/7", ownerIssue: 7, issue: 12, items: [12], body: "For your information." }, old: { at: "x", heading: "old routed, from before" } } }));
fs.writeFileSync(path.join(dir, "state-acme__side.json"), JSON.stringify({ routed: {} }));
fs.writeFileSync(path.join(dir, "mission-control-queue.json.drained-x"), "{}");
const world = { routedQuestions: readRoutedQuestions({ QUESTIONS_DIR: dir }, { readFile: p => fs.readFileSync(p, "utf8") }) };

testCase("the world reads the questions handed to the driver, and each is an obstacle whose time starts when the driver sees it");
{
  assert.deepEqual(world.routedQuestions.map(q => [q.repo, q.key, q.issue]), [["acme/app", key, 12]], "only entries marked for the driver; the old queue's are not");
  const [ob] = findObstacles(world, {}, T0, {});
  assert.equal(ob.kind, "question"); assert.equal(ob.repo, "acme/app"); assert.equal(ob.issue, 12);
  assert.equal(ob.since, new Date(T0).toISOString(), "not from 2026-11-16: a question that waited in a queue is not a day-old stall");
  assert.ok(ob.evidence.some(e => e.includes("For your information.")) && ob.question.heading === "Status of #12 (#12)");
  assert.equal(readRoutedQuestions({ QUESTIONS_DIR: path.join(dir, "none") }, { readFile: p => fs.readFileSync(p, "utf8") }).length, 0);
}

testCase("the ladder: the decide helper at once, never a message to the owner, the acting run after three attempts, and a wait once it is decided");
{
  const [ob] = findObstacles(world, {}, T0, {});
  const ctx = { now: T0 + 30 * H, candidates: [{ provider: "codex", model: "m1" }, { provider: "claude", model: "m2" }] };
  const s = nextStep(ob, [], ctx);
  assert.equal(s.do, "decide", "even 30 hours on, no 'has not moved' message: the accountant tells the owner, not this ladder");
  assert.match(s.approachNote, /standing instruction of 2026-11-24/); assert.match(s.approachNote, /never yours: spending money/);
  const tries = Array.from({ length: QUESTION_TRIES }, (_, i) => ({ at: new Date(T0 + i * H).toISOString(), helper: "decide", provider: "codex", model: "m1", outcome: "ok", cause: "what" }));
  assert.equal(nextStep(ob, tries, ctx).do, "act");
  assert.equal(nextStep(ob, [...tries.slice(0, 1), { at: new Date(T0 + 2 * H).toISOString(), helper: "decided", outcome: "ok" }], ctx).do, "wait-external");
}

testCase("the decide helper's decision is posted on the question's item, names the question, and no product wording turns it into a question for the owner");
{
  const [ob] = findObstacles(world, {}, T0, {});
  const calls = [];
  const gh = (args, input) => { calls.push([args, input ? JSON.parse(input) : null]); return []; };
  const out = await applyReport({ REPO: "acme/main", QUESTIONS_DIR: dir, STATE_DIR: dir }, ob, { decision: "Keep the card's look and feel as it is; nothing changes for the people who use it.", cause: "how", summary: "decided" },
    { kind: "decide", gh, check: () => ({ approve: true, reason: "fine" }), id: "factory-helper-x-1", startedAt: new Date(T0).toISOString(), state: {} });
  assert.deepEqual(out.failed, []);
  const posts = calls.filter(c => c[0].includes("POST"));
  assert.equal(posts.length, 1); assert.equal(posts[0][0][2], "repos/acme/app/issues/12/comments", "on the question's own repository and item");
  const body = posts[0][1].body;
  assert.ok(body.startsWith("Manager decision (Mission Control, on the owner's standing instruction of 2026-11-24): Keep the card's look and feel"), "the heading the factory's Archon honours for a product question, never the technical-only one");
  assert.ok(decidesQuestion(body, key) && names(body, key), "the questions step and the accountant both see it as deciding this question");
  assert.ok(!calls.some(c => c[0].includes("DELETE")), "needs-owner is the questions step's to lift, once no other question holds the item");
  assert.deepEqual(out.question.targets, [12]);
  assert.ok(!fs.existsSync(path.join(dir, "driver-questions.json")), "look and feel did not become a question for the owner");
}

testCase("a question decision refused twice by the second check posts the option that keeps every check, naming the question");
{
  const [ob] = findObstacles(world, {}, T0, {});
  const state = {}; const calls = [];
  const gh = (args, input) => { calls.push([args, input ? JSON.parse(input) : null]); return []; };
  const deps = { kind: "decide", gh, check: () => ({ approve: false, reason: "loosens a check" }), id: "u", state };
  const a = await applyReport({ REPO: "acme/main" }, ob, { decision: "Skip the check.", cause: "how" }, deps);
  assert.ok(a.refusal && !calls.length);
  const b = await applyReport({ REPO: "acme/main" }, ob, { decision: "Skip the check again.", cause: "how" }, deps);
  assert.ok(b.fallback); assert.ok(calls[0][1].body.includes("every existing check, hidden scenario and judge stays exactly as it is") && decidesQuestion(calls[0][1].body, key));
}
