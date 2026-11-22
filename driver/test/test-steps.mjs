import { TEST_ENV } from "./env.mjs";
import { test } from "./harness.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverSteps, stepRound, stepEntries, stepStatus, runStep, stepUnit, lastFile, stepConfig } from "../steps.mjs";
import { advance, buildInventory, movingUntilFor } from "../inventory.mjs";
import { nextStep } from "../ladder.mjs";
import { KINDS } from "../obstacles.mjs";
import { statusOf } from "../driver.mjs";
import { housekeep } from "../housekeeping.mjs";
import { defaultsFor, isLegacy } from "../world.mjs";

const MIN = 60000, NOW = Date.parse("2026-11-22T12:00:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fd-steps-"));
const fake = (name, o = {}) => ({ name, STEP: { name, everyMinutes: o.every ?? 10, maxMinutes: o.max ?? 30, inRound: !!o.inRound }, SETTINGS: [], run: o.run || (async () => ({ ok: true, summary: "fine" })) });
function world(over = {}) {
  const dir = tmp();
  const settings = { server: { state_dir: path.join(dir, "state") }, steps: {}, ...over };
  return { dir, settings, state: {}, runs: [], deps: null };
}
const mk = (w, o = {}) => ({ steps: o.steps || [fake("alpha")], settings: w.settings, main: {}, projects: [], env: {}, settingsDir: "/etc/example", state: w.state, now: w.now ?? NOW, dry: !!o.dry, log: () => {}, node: "/usr/bin/node", driverMjs: "/opt/driver/driver.mjs" });
const depsFor = (w, o = {}) => ({
  isActive: () => !!(o.active), unitResult: () => o.result || "", readJson: f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } },
  systemdRun: argv => { w.runs.push(argv); return o.fail ? { status: 1, stderr: "Failed to start transient service" } : { status: 0, stderr: "" }; },
});
const writeLast = (w, name, r) => { const f = lastFile(w.settings, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(r)); };

test("steps are found by reading the folder: before any is added there are none, afterwards each is there", async () => {
  const dir = tmp();
  assert.deepEqual((await discoverSteps(dir)).steps, [], "an empty folder");
  assert.deepEqual((await discoverSteps(path.join(dir, "nowhere"))).steps, [], "no folder");
  fs.writeFileSync(path.join(dir, "one.mjs"), 'export const STEP = { name: "one", everyMinutes: 5, maxMinutes: 9, inRound: false };\nexport const SETTINGS = [{ key: "steps.one.x", required: false, meaning: "x" }];\nexport async function run() { return { ok: true, summary: "hi" }; }\n');
  fs.writeFileSync(path.join(dir, "notes.mjs"), "export const nothing = 1;\n");
  fs.writeFileSync(path.join(dir, "readme.txt"), "not code");
  const r = await discoverSteps(dir);
  assert.deepEqual(r.steps.map(s => s.name), ["one"]);
  assert.equal(r.steps[0].SETTINGS[0].key, "steps.one.x");
  assert.equal(r.errors.length, 1, "a module that is no step is named, not run");
  assert.match(r.errors[0], /notes\.mjs/);
});

test("a step that is due is started as a transient unit of the driver, collected when it ends, and not started again while it runs or before it is due", async () => {
  const w = world(), d = depsFor(w);
  const out = await stepRound(mk(w), d);
  assert.deepEqual(out.launched, ["alpha"]);
  const argv = w.runs[0].join(" ");
  for (const part of [`--unit=${stepUnit("alpha")}`, "--collect", "CollectMode=inactive-or-failed", "RuntimeMaxSec=1800", "/opt/driver/driver.mjs --step alpha --settings-dir /etc/example"]) assert.ok(argv.includes(part), part);
  assert.ok(!argv.includes("OnCalendar") && !/timer/i.test(argv), "no timer of its own");
  const w2 = world({ keys: { env_file: "/etc/x/keys-file" }, steps: { alpha: { env: { STAGING_ON_SERVER_ITSELF: "1" } } } });
  await stepRound(mk(w2), depsFor(w2));
  assert.ok(w2.runs[0].includes("EnvironmentFile=-/etc/x/keys-file") && w2.runs[0].includes("--setenv=STAGING_ON_SERVER_ITSELF=1"), "the keys file and a step's own environment reach the child");
  w.now = NOW + 5 * MIN; await stepRound(mk(w), d);
  assert.equal(w.runs.length, 1, "not due yet");
  w.now = NOW + 11 * MIN; const o2 = await stepRound(mk(w), depsFor(w, { active: true }));
  assert.equal(w.runs.length, 1, "due, but its child is still running");
  assert.deepEqual(Object.keys(o2.running), ["alpha"], "a running child is visibly running");
  assert.equal(o2.running.alpha.maxMin, 30);
  w.now = NOW + 12 * MIN; await stepRound(mk(w), depsFor(w));
  assert.equal(w.runs.length, 2, "ended and due again");
});

test("what the child wrote is collected: a good run, a failed run, three failures make an entry for the driver to own", async () => {
  const w = world(), d = depsFor(w);
  await stepRound(mk(w), d);
  writeLast(w, "alpha", { name: "alpha", startedAt: new Date(NOW).toISOString(), endedAt: new Date(NOW + MIN).toISOString(), ok: true, summary: "all fine" });
  w.now = NOW + 2 * MIN; let o = await stepRound(mk(w), d);
  assert.deepEqual(o.collected.map(c => [c.name, c.ok]), [["alpha", true]]);
  assert.equal(w.state.steps.alpha.failuresInRow, 0);
  assert.deepEqual(stepEntries(w.state, mk(w).steps, w.settings, w.now), [], "healthy: no entry");
  for (let i = 1; i <= 3; i++) {
    w.now = NOW + (10 + 12 * i) * MIN;
    await stepRound(mk(w), d); // starts it again
    writeLast(w, "alpha", { name: "alpha", startedAt: new Date(w.now).toISOString(), endedAt: new Date(w.now + MIN).toISOString(), ok: false, summary: "no", error: `boom ${i}` });
    w.now += 2 * MIN; await stepRound(mk(w), d);
  }
  assert.equal(w.state.steps.alpha.failuresInRow, 3);
  const e = stepEntries(w.state, mk(w).steps, w.settings, w.now);
  assert.equal(e.length, 1);
  assert.equal(e[0].id, "step:alpha"); assert.equal(e[0].kind, "step"); assert.equal(e[0].owner, "the factory driver");
  assert.ok(e[0].evidence.join("\n").includes("boom 3"), "the acting run is given the last error");
  assert.ok(Number.isFinite(e[0].milestoneAt) && e[0].limitH > 0, "an owner and a deadline like everything else");
});

test("a child killed at its time limit writes nothing: launched, not running, no newer last.json counts as a failed run, once", async () => {
  const w = world();
  await stepRound(mk(w), depsFor(w));
  w.now = NOW + 40 * MIN;
  const o = await stepRound(mk(w), depsFor(w, { result: "timeout" }));
  assert.equal(w.state.steps.alpha.failuresInRow, 1);
  assert.match(w.state.steps.alpha.lastError, /ended without a result \(timeout\)/);
  assert.equal(o.collected[0].ok, false);
  const before = w.state.steps.alpha.failuresInRow;
  w.now += 5 * MIN; await stepRound(mk(w), depsFor(w, { active: true })); // the launch that followed is running
  assert.equal(w.state.steps.alpha.failuresInRow, before, "the same launch is never counted twice");
  assert.equal(w.runs.length, 2, "it was started again at once, being due");
  const cmd = w.runs[0].join(" ");
  assert.ok(cmd.includes("CollectMode=inactive-or-failed"), "a killed step does not stay in systemctl --failed");
});

test("a step that cannot be started is a failed run, and the next round tries again when it is due", async () => {
  const w = world();
  const o = await stepRound(mk(w), depsFor(w, { fail: true }));
  assert.deepEqual(o.launched, []);
  assert.equal(w.state.steps.alpha.failuresInRow, 1);
  assert.match(w.state.steps.alpha.lastError, /could not start: Failed to start transient service/);
});

test("a halt is an entry that starts at rung 1 with the halt's words and its clear command; it ends when the step runs without it; the owner is told nothing by the runner", async () => {
  const w = world(), d = depsFor(w);
  await stepRound(mk(w), d);
  writeLast(w, "alpha", { name: "alpha", endedAt: new Date(NOW + MIN).toISOString(), ok: true, summary: "stopped itself", halt: { key: "broken", words: "The hidden checks cannot observe anything any more.", clear: "node /opt/driver/driver.mjs --step alpha --clear-halt" } });
  w.now = NOW + 3 * MIN; await stepRound(mk(w), d);
  const es = stepEntries(w.state, mk(w).steps, w.settings, w.now);
  const h = es.find(e => e.id === "halt:alpha:broken");
  assert.ok(h, "the entry halt:<name>:<key>");
  assert.equal(h.owner, null, "no program owns it: it starts at rung 1");
  const text = h.evidence.join("\n");
  assert.ok(text.includes("cannot observe anything") && text.includes("--clear-halt"), "its words and its clear command go into the acting run's brief");
  const adv = advance(es, {}, w.now);
  const row = adv.rows.find(r => r.entry.id === h.id);
  assert.equal(row.rung, 1);
  assert.equal(adv.actions.launch && adv.actions.launch.entry.id, h.id, "an acting run is launched at once");
  assert.deepEqual(adv.actions.tell, [], "a halt never sends the owner anything by itself: only rung 3, through the gate");
  writeLast(w, "alpha", { name: "alpha", endedAt: new Date(NOW + 20 * MIN).toISOString(), ok: true, summary: "fine again" });
  w.now = NOW + 22 * MIN; await stepRound(mk(w), d);
  assert.deepEqual(stepEntries(w.state, mk(w).steps, w.settings, w.now).filter(e => e.kind === "halt"), [], "the condition ended: the entry is gone");
});

test("an inline step runs inside the round in a try/catch: a step that throws is a failed run and never stops the round or the other steps", async () => {
  const w = world();
  let ran = [];
  const steps = [fake("boom", { inRound: true, run: async () => { ran.push("boom"); throw new Error("it broke"); } }), fake("calm", { inRound: true, run: async () => { ran.push("calm"); return { ok: true, summary: "done" }; } })];
  const o = await stepRound(mk(w, { steps }), depsFor(w));
  assert.deepEqual(ran, ["boom", "calm"]);
  assert.equal(w.runs.length, 0, "nothing is started as a unit");
  assert.equal(w.state.steps.boom.failuresInRow, 1); assert.match(w.state.steps.boom.lastError, /it broke/);
  assert.equal(w.state.steps.calm.lastOk, true);
  assert.equal(o.errors.length, 0);
});

test("a disabled step is not started, not collected and not an entry", async () => {
  const w = world({ steps: { alpha: { enabled: false } } });
  await stepRound(mk(w), depsFor(w));
  assert.equal(w.runs.length, 0);
  assert.deepEqual(stepEntries(w.state, mk(w).steps, w.settings, NOW + 99 * 60 * MIN), []);
  assert.equal(stepConfig(w.settings, fake("alpha")).enabled, false);
  assert.equal(stepConfig({ server: { state_dir: "/s" }, steps: { alpha: { every_minutes: 3, max_minutes: 4 } } }, fake("alpha")).every, 3, "the cadence can be set in the settings");
});

test("a dry run starts nothing", async () => {
  const w = world(), d = depsFor(w);
  const steps = [fake("alpha"), fake("inline", { inRound: true, run: async () => { w.runs.push("ran inline"); return { ok: true }; } })];
  const o = await stepRound(mk(w, { dry: true, steps }), d);
  assert.deepEqual(w.runs, []);
  assert.deepEqual(o.launched, []);
});

test("`driver.mjs --step <name>` runs one step and writes its last.json; a dry run writes nothing; a step that throws still leaves a failed result", async () => {
  const w = world();
  const base = { settings: w.settings, main: {}, projects: [], env: {}, settingsDir: "/etc/x", dry: false, argv: [] };
  const r = await runStep(fake("alpha", { run: async ctx => ({ ok: true, summary: `state ${path.basename(ctx.stateDir)}`, halt: { key: "k", words: "w", clear: "c" } }) }), base);
  assert.equal(r.ok, true); assert.equal(r.summary, "state alpha"); assert.equal(r.halt.key, "k");
  assert.deepEqual(JSON.parse(fs.readFileSync(lastFile(w.settings, "alpha"), "utf8")).halt, { key: "k", words: "w", clear: "c" });
  const w2 = world();
  await runStep(fake("alpha"), { ...base, settings: w2.settings, dry: true });
  assert.equal(fs.existsSync(lastFile(w2.settings, "alpha")), false);
  const bad = await runStep(fake("alpha", { run: async () => { throw new Error("nope"); } }), { ...base, settings: w2.settings });
  assert.equal(bad.ok, false); assert.match(bad.error, /nope/);
  assert.equal(JSON.parse(fs.readFileSync(lastFile(w2.settings, "alpha"), "utf8")).ok, false);
  const seen = []; await runStep(fake("alpha", { run: async ctx => { seen.push([ctx.clearHalt, ctx.argv, ctx.settingsDir, ctx.dry]); return { ok: true }; } }), { ...base, settings: w2.settings, argv: ["--step", "alpha", "--clear-halt"], clearHalt: true });
  assert.deepEqual(seen, [[true, ["--step", "alpha", "--clear-halt"], "/etc/x", false]], "the step is given argv, clearHalt, settingsDir and dry");
});

test("a running child holds its own entry and the release the stage step works on, until its time limit", () => {
  const now = NOW;
  const activity = { runs: [], stepRuns: { stage: { startedAt: now - 10 * MIN, maxMin: 200 }, alpha: { startedAt: now - MIN, maxMin: 30 } }, releaseId: "godspeed-2.0.0-beta.30-x" };
  const own = movingUntilFor({ id: "step:alpha", kind: "step", step: "alpha" }, activity, { items: {} });
  assert.equal(own, now - MIN + 30 * MIN);
  const release = movingUntilFor({ id: "release:r", kind: "release", release: "godspeed-2.0.0-beta.30-x" }, activity, { items: {} });
  assert.equal(release, now - 10 * MIN + 200 * MIN, "the stage child works on the release");
  assert.ok(Number.isNaN(movingUntilFor({ id: "step:other", kind: "step", step: "other" }, activity, { items: {} })), "another step's child holds nothing of it");
});

test("the inventory holds the steps' entries; status.json says what each step did", async () => {
  const w = world();
  w.state.steps = { alpha: { firstSeenAt: NOW - 3 * 60 * MIN, lastRunAt: NOW - MIN, lastOk: false, failuresInRow: 3, lastError: "boom", halts: { k: { words: "w", clear: "c", since: NOW - 60 * MIN } } } };
  const steps = [fake("alpha")];
  const ents = stepEntries(w.state, steps, w.settings, NOW);
  const inv = buildInventory({ releases: [], items: {}, queue: [], factories: [] }, {}, [], { now: NOW, stepEntries: ents, journalView: { open: [], releases: {} } });
  assert.deepEqual(inv.filter(e => e.kind === "step" || e.kind === "halt").map(e => e.id).sort(), ["halt:alpha:k", "step:alpha"]);
  const adv = advance(inv, {}, NOW);
  const st = statusOf({ inventory: adv.rows, stepStatus: stepStatus(w.state, steps, w.settings, { alpha: {} }) }, new Date(NOW).toISOString(), NOW, {});
  assert.deepEqual(st.steps.alpha, { enabled: true, lastRun: new Date(NOW - MIN).toISOString(), lastOk: false, running: true, failuresInRow: 3, halt: ["k"] });
});

test("the ladder never ends in a wait: not for any obstacle kind, the ones a step brings, or one nobody knows", () => {
  const ob = (kind, sinceH = 1) => ({ id: "abcdef0123", kind, ticketKey: "rel#1", since: new Date(NOW - sinceH * 3600000).toISOString(), evidence: [] });
  const failed = h => ({ at: new Date(NOW - 1800000).toISOString(), helper: h, provider: "claude", model: "sonnet", outcome: "failed", summary: "it broke" });
  for (const kind of [...KINDS, "step-failed", "step-halted", "a-kind-nobody-has-seen"]) {
    for (const history of [[], [failed("diagnose")], [failed("diagnose"), failed("ops"), failed("product")]]) {
      const s = nextStep(ob(kind), history, { now: NOW });
      assert.ok(s.do && !/^wait/.test(s.do), `${kind}: ${s.do}`);
      assert.equal(s.waitUntil, undefined, `${kind} has no wait value`);
    }
  }
});

test("steps.mjs can send nobody anything and removes no pause: it imports nothing that delivers, and no runtime file removes a PAUSE", () => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const root = path.join(here, "..");
  const src = fs.readFileSync(path.join(root, "steps.mjs"), "utf8");
  for (const mod of ["facts", "act", "duties", "ai", "onduty", "causes", "rescues"]) assert.ok(!new RegExp(`from\\s+["']\\./${mod}\\.mjs["']`).test(src), `steps.mjs does not import ${mod}`);
  for (const f of ["driver.mjs", "housekeeping.mjs", "duties.mjs", "act.mjs", "onduty.mjs", "keeper.mjs", "steps.mjs", "pause.mjs"]) {
    const t = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!/(rmSync|unlinkSync|rmdirSync)\([^)]*PAUSE/.test(t), `${f} never removes a PAUSE file`);
  }
});

test("units listed as replaced (legacy_units) are never factory timers, never must-run, never an obstacle, never started or restarted", async () => {
  const e = { FD_LEGACY_UNITS: "auto-stage.timer,auto-stage.service,test-machine", FD_MUST_RUN: "auto-stage.service,web.service,test-machine.service" };
  assert.deepEqual(defaultsFor(e).MUST_RUN, ["web.service"], "a replaced unit is not a unit that must run");
  assert.ok(isLegacy({ LEGACY_UNITS: ["test-machine"] }, "test-machine.timer") && isLegacy({ LEGACY_UNITS: ["test-machine"] }, "test-machine.service") && !isLegacy({ LEGACY_UNITS: ["test-machine"] }, "web.service"));
  const calls = [];
  const env = { ...defaultsFor(TEST_ENV), LEGACY_UNITS: ["auto-stage.timer", "auto-stage.service", "test-machine"], SYSTEMCTL: "systemctl", FORGE_NETNS: "" };
  const server = { failedUnits: ["auto-stage.service", "test-machine.service", "web.service"], anonymousFailedUnits: [], logins: {} };
  await housekeep({ ...env, ALLOWED_RESTART: undefined }, { server, timersToStart: ["auto-stage.timer", "archonfactory-x.timer"], factories: [] }, { run: (argv) => { calls.push(argv.join(" ")); return { status: 0, stdout: "", stderr: "" }; }, sleep: async () => {} });
  assert.ok(!calls.some(c => /auto-stage|test-machine/.test(c)), `nothing is done to a replaced unit: ${calls.join(" | ")}`);
});

test("the driver reads the hidden checks' tools in its own process through the test-machine step: its answer reaches the world, and a failure of it is only an unreadable part", async () => {
  const { readWorld } = await import("../world.mjs");
  const w = await readWorld(TEST_ENV, { gh: () => { throw new Error("no GitHub in a test"); }, sh: () => "", now: () => NOW, readReleases: () => [], readFile: () => { throw new Error("none"); }, readDir: () => [], toolCoverage: () => ({ ids: ["H-1", "H-2"], missing: [{ id: "H-2", why: "H-2 has no tool" }] }) });
  assert.deepEqual(w.tools, { scenarios: 2, missing: [{ id: "H-2", why: "H-2 has no tool" }] });
  const bad = await readWorld(TEST_ENV, { gh: () => { throw new Error("no GitHub in a test"); }, sh: () => "", now: () => NOW, readReleases: () => [], readFile: () => { throw new Error("none"); }, readDir: () => [], toolCoverage: () => { throw new Error("the setting steps.test-machine.holdout is missing"); } });
  assert.equal(bad.tools, null);
  assert.ok(bad.unreadable.some(u => u.part === "tools" && /holdout is missing/.test(u.error)));
});
