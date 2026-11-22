import { TEST_ENV } from "./env.mjs";
// node --test scripts/factory-driver/test-gate.mjs
import { test } from "./harness.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateStep, gateClear, GATE } from "../gate.mjs";
import { GATE as DM_GATE } from "../deadman/deadman.mjs";
import { GODSPEED_RELEASE, roundEvents, view } from "../journal.mjs";

const MIN = 60000, here = path.dirname(fileURLToPath(import.meta.url));
test("three reads at least 10 minutes apart; two rounds 5 minutes apart are one reading; an absent condition starts over", () => {
  const g = {}, T = 1000000;
  assert.equal(gateStep(g, "k", T).ready, false);
  assert.equal(gateStep(g, "k", T + 5 * MIN).ready, false); assert.equal(g.k.reads.length, 1, "5 minutes later is the same reading");
  assert.equal(gateStep(g, "k", T + 10 * MIN).ready, false); assert.equal(g.k.reads.length, 2);
  assert.equal(gateStep(g, "k", T + 15 * MIN).ready, false, "the third reading is not yet 10 minutes after the second");
  assert.equal(gateStep(g, "k", T + 20 * MIN).ready, true, "three readings 10 minutes apart: ready");
  gateClear(g, new Set()); assert.deepEqual(g, {}, "the condition was absent: everything starts over");
});
test("the three programs carry the same gate and the same definition of a release", () => {
  assert.deepEqual(DM_GATE, GATE, "dead-man and driver: reads, gap and tolerance");
  const watcher = fs.readFileSync(path.join(here, "../watcher/factory-watch.mjs"), "utf8");
  assert.match(watcher, /READS = 3/); assert.match(watcher, /E\.GATE_WAIT_MS \?\? 600000/, "three reads, ten minutes apart");
  const dm = fs.readFileSync(path.join(here, "../deadman/deadman.mjs"), "utf8");
  assert.match(dm, /e\.FD_PLAN_PATTERN/, "the dead-man reads the setting"); assert.equal(String(GODSPEED_RELEASE.source), new RegExp(process.env.FD_PLAN_PATTERN).source, "the driver reads the same setting");
  assert.match(watcher, /E\.PLAN_PATTERN/, "the watcher reads the same setting from a repository variable");
  assert.ok(GODSPEED_RELEASE.test("godspeed-2.0.0-beta.29-x") && !GODSPEED_RELEASE.test("godspeed-forge-0.1.0-first-forge") && !GODSPEED_RELEASE.test("querino-1.0.0-beta.1") && !GODSPEED_RELEASE.test("clerk-0.5.2"));
});
test("the driver judges only Godspeed's own release plans: another product's plan is never journaled, never open", () => {
  const w = { releases: [{ id: "godspeed-forge-0.1.0-first-forge", tickets: [{ item: 1, issue: 1 }] }, { id: "godspeed-2.0.0-beta.29-x", tickets: [{ item: 1, issue: 2 }] }], items: {}, staging: {} };
  const ev = roundEvents(view([]), w, Date.now(), {});
  assert.deepEqual(ev.filter(e => e.t === "approved").map(e => e.release), ["godspeed-2.0.0-beta.29-x"]);
  const v = view([{ t: "approved", release: "querino-1.0.0-beta.1", at: new Date().toISOString(), tickets: [] }, ...ev]);
  assert.deepEqual(v.open.map(r => r.id), ["godspeed-2.0.0-beta.29-x"]);
});
