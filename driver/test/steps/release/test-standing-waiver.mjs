import "./settings-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as G from "../../../steps/release/staging.mjs";

// The standing waiver of 8 November 2026: a release is blocked only by its new features' scenarios.
const V = "2.0.0-beta.20";
const staging = (failedJobs, over = {}) => ({ version: V, scenarios: { result: "failed", run: 7, failedJobs, ...over } });
const PLAN = "# plan\n\n**Blocking scenarios:**\n\n- the new thing works (new-thing)\n- a second new thing\n\n## Next\n";

test("reads the blocking list inline, as bullets, and says none when there is no line", () => {
  assert.deepEqual(G.blockingScenarios("Blocking scenarios: `a one`, b two; c three.\n"), ["a one", "b two", "c three"]);
  assert.deepEqual(G.blockingScenarios(PLAN), ["the new thing works", "new-thing", "a second new thing"]);
  assert.equal(G.blockingScenarios("# plan\nnothing here\n"), null);
  assert.equal(G.blockingScenarios("Blocking scenarios:\n\n## Next\n"), null);
});

test("the real beta.20 plan names its five blocking scenarios (phrase and short name each)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const plan = fs.readFileSync(path.join(here, "fixtures", "godspeed-2.0.0-beta.20-nothing-private-left", "plan.md"), "utf8");
  const list = G.blockingScenarios(plan);
  assert.equal(list.length, 10, "five phrases and their five short names");
  for (const slug of ["workouts-from-hevy", "day-becomes-facts", "hermes-update-rollback", "first-day", "talk-prep-honest"]) assert.ok(list.includes(slug), slug);
  const split = G.scenarioFailureSplit(staging(["the Charm Challenge, start to finish", "Docker and Linux import made-up Hevy workouts", "the verdict"]), plan, V);
  assert.deepEqual(split.blocking, ["Docker and Linux import made-up Hevy workouts"]);
  assert.deepEqual(split.nonBlocking, ["the Charm Challenge, start to finish"]);
  assert.deepEqual(split.aggregate, ["the verdict"]);
});

test("a scenario named by its short name in the plan blocks a job named after it", () => {
  const plan = "Blocking scenarios:\n\n- the long phrase (some-short-name, item 2)\n";
  assert.deepEqual(G.blockingScenarios(plan), ["the long phrase", "some-short-name"]);
  assert.deepEqual(G.scenarioFailureSplit(staging(["some-short-name, start to finish"]), plan, V).blocking, ["some-short-name, start to finish"]);
});

test("a plan without a blocking list keeps the old rule", () => {
  assert.equal(G.scenarioFailureSplit(staging(["x job"]), "# plan\n", V), null);
  assert.equal(G.scenariosClear(staging(["x job"]), "# plan\n", V), false);
});

test("clear only when every failure is outside the list and at least one real job failed", () => {
  assert.equal(G.scenariosClear(staging(["an old job", "the verdict"]), PLAN, V), true);
  assert.equal(G.scenariosClear(staging(["an old job", "the new thing works, end to end", "the verdict"]), PLAN, V), false);
  assert.equal(G.scenariosClear(staging(["the verdict"]), PLAN, V), false);
  assert.equal(G.scenariosClear(staging(undefined), PLAN, V), false);
  assert.equal(G.scenariosClear({ version: V, scenarios: { result: "passed", run: 1 } }, PLAN, V), true);
  assert.equal(G.scenariosClear(staging(["an old job"], { result: "running" }), PLAN, V), false);
});

test("the go is accepted only with a cause for each non-blocking job; his waiver covers a blocking one", () => {
  const go = (over) => ({ version: V, prompt: "an old job failed (the test AI account was rate limited); flaky", ...over });
  const cause = [{ job: "an old job", cause: "the test AI account was rate limited" }];
  assert.deepEqual(G.scenarioFailuresAccepted(staging(["an old job", "the verdict"]), PLAN, go({ nonBlocking: cause }), V), { waived: [], nonBlocking: cause });
  assert.equal(G.scenarioFailuresAccepted(staging(["an old job"]), PLAN, go({}), V), null);
  assert.equal(G.scenarioFailuresAccepted(staging(["an old job"]), PLAN, go({ prompt: "an old job failed", nonBlocking: cause }), V), null, "the prompt he saw must carry the cause");
  assert.equal(G.scenarioFailuresAccepted(staging(["an old job"]), PLAN, go({ nonBlocking: [{ job: "an old job", cause: " " }] }), V), null);
  assert.equal(G.scenarioFailuresAccepted(staging(["the new thing works, e2e"]), PLAN, go({ nonBlocking: [{ job: "the new thing works, e2e", cause: "flaky" }] }), V), null);
  const both = G.scenarioFailuresAccepted(staging(["an old job", "the new thing works, e2e", "the verdict"]), PLAN, go({ waived: ["the new thing works, e2e"], nonBlocking: cause }), V);
  assert.deepEqual(both.waived, ["the new thing works, e2e"]);
  assert.equal(both.nonBlocking.length, 1);
});
