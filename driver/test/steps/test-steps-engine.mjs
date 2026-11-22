// node driver/test/steps/test-steps-engine.mjs   (no network, no AI)
// The three folded helpers as steps: what they export, how their settings become the old configuration,
// that a dead end is a halt and a halt queues no notice, and that nothing of the first owner's is left in
// the files that ship.
// test cases: 8
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testCase } from "../../../test/cases.mjs";
import * as trust from "../../steps/trust.mjs";
import * as questions from "../../steps/questions.mjs";
import * as tm from "../../steps/test-machine.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const stepsDir = path.join(here, "..", "..", "steps");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "steps-"));
const HOUR = 3600 * 1000;

const settings = {
  owner: { github_login: "boss", name: "Alex" },
  server: { factory_user: "builder", factory_uid: 1234, factory_gid: 1234, factory_home: "/srv/builder", driver_dir: "/opt/driver", state_dir: path.join(tmp, "state"), questions_dir: path.join(tmp, "q") },
  keys: { token_script: "/opt/token.mjs" },
  ai: { models: { strong: "strong-model" } },
  notices: { godspeed_notices_file: path.join(tmp, "notices.json") },
  steps: { questions: { godspeed_dir: path.join(tmp, "g"), hermes_home: path.join(tmp, "hermes") }, "test-machine": { holdout: "H-1", state_dir: path.join(tmp, "tm") } },
};
const main = { repository: "acme/app", project: "app", checkout: "/srv/builder/app", releases: { records_checkout: "/srv/records", tools_dir: path.join(tmp, "tools"), holdouts_dir: "/srv/builder/holdouts/app" } };
const side = { repository: "acme/side", checkout: "/srv/builder/side", questions: { label: "Side", name: "Side" } };
const ctx = (extra = {}) => ({ settings, main, projects: [main, side], env: {}, settingsDir: "/etc/driver", ...extra });

testCase("every step exports its cadence, its settings and run");
for (const [mod, name, every, max] of [[trust, "trust", 2, 9], [questions, "questions", 15, 15], [tm, "test-machine", 30, 120]]) {
  assert.equal(mod.STEP.name, name); assert.equal(mod.STEP.everyMinutes, every); assert.equal(mod.STEP.maxMinutes, max); assert.equal(mod.STEP.inRound, false);
  assert.equal(typeof mod.run, "function");
  assert.ok(mod.SETTINGS.length && mod.SETTINGS.every(s => typeof s.key === "string" && s.meaning && typeof s.required === "boolean"), `${name}: every setting says what it is and whether it is needed`);
  assert.ok(mod.SETTINGS.every(s => s.required || "default" in s), `${name}: an optional setting says its default`);
}

testCase("the questions step builds the old configuration from the settings, the main project first and on the old state file");
{
  const env = questions.envFor(ctx({ projects: [side, main] }));
  assert.deepEqual(env.PROJECTS.map(p => [p.repo, p.main === true]), [["acme/app", true], ["acme/side", false]]);
  assert.equal(env.PROJECTS[1].label, "Side", "a project's own words come from its file");
  assert.equal(env.PROJECTS[0].label, "app", "plain words when the file brings none");
  assert.equal(env.STATE.replace(/\\/g, "/"), settings.server.questions_dir.replace(/\\/g, "/") + "/state.json");
  assert.equal(env.FORGE_HOME, "/srv/builder"); assert.equal(env.OWNER_NAME, "Alex"); assert.equal(env.NOTICES_FILE, settings.notices.godspeed_notices_file);
  const bad = await questions.run({ ...ctx(), settings: { ...settings, steps: { questions: {} } } });
  assert.equal(bad.ok, false); assert.match(bad.error, /steps\.questions\.godspeed_dir/, "a missing setting is named");
}

testCase("a question list that cannot be read for a day is a halt with its clear command, and queues no notice");
{
  const dir = fs.mkdtempSync(path.join(tmp, "q-")); const issues = path.join(dir, "issues.json"); fs.writeFileSync(issues, "not json");
  const s = { ...settings, server: { ...settings.server, questions_dir: dir } };
  const T0 = Date.parse("2026-11-22T10:00:00Z");
  const c = at => ({ ...ctx(), settings: s, projects: [main], env: { OQ_ISSUES_FILE: issues }, nowMs: () => T0 + at });
  let r = await questions.run(c(0));
  assert.equal(r.ok, false); assert.equal(r.halt, undefined, "not yet: a day first");
  r = await questions.run(c(25 * HOUR));
  assert.equal(r.halt.key, "unreadable"); assert.match(r.halt.words, /could not be read for a whole day/);
  assert.equal(r.halt.clear, "node /opt/driver/driver.mjs --step questions --settings-dir /etc/driver");
  assert.ok(!fs.existsSync(settings.notices.godspeed_notices_file), "the step told the owner nothing");
  fs.writeFileSync(issues, "[]");
  r = await questions.run(c(26 * HOUR));
  assert.equal(r.ok, true); assert.equal(r.halt, undefined, "the halt ends with its cause");
}

testCase("the test-machine step builds the old configuration from the settings and names a missing one");
{
  const env = tm.tmEnv(ctx());
  assert.equal(env.TM_REPO, "acme/app"); assert.equal(env.TM_TOOLS_DIR, main.releases.tools_dir); assert.equal(env.TM_RELEASES_DIR, "/srv/records/releases");
  assert.equal(env.FORGE_UID, "1234"); assert.equal(env.TM_WORK, "/srv/builder/test-machine"); assert.equal(env.TM_MANAGER_UNIT, "archonfactory-app-manager.service");
  assert.equal(env.TM_CHECKOUTS, "/srv/builder/app,/srv/builder/side"); assert.equal(env.TM_OWNER_NAME, "Alex");
  const e = tm.envFor(ctx());
  assert.equal(e.HOLDOUTS_DIR, "/srv/builder/holdouts", "the folder of every project's scenarios, by default the parent of the main one's");
  assert.equal(e.NETNS, undefined, "no namespace unless one is set");
  assert.equal(tm.envFor(ctx({ clearHalt: true })).CLEAR_HALT, true);
  const r = await tm.run({ ...ctx(), settings: { ...settings, steps: { "test-machine": {} } } });
  assert.equal(r.ok, false); assert.match(r.error, /steps\.test-machine\.holdout/);
}

testCase("a dead end of the test machine is a halt with its clear command, never a notice; a breach halt is cleared only by --clear-halt");
{
  const staged = { id: "r", version: "1.0.0", commit: "a".repeat(40) };
  const unhealthy = { check: () => ({ staged, target: "/c", smoke: { ok: false, error: "closed" }, holdout: null }), findable: () => ({ ok: true, changed: [], left: [] }), coverage: () => ({ ids: [], missing: [] }) };
  let r = await tm.run({ ...ctx(), deps: { ...unhealthy, repair: async () => ({ ran: true, outcome: "rolled back" }) } });
  assert.equal(r.ok, true); assert.equal(r.halt.key, "broken"); assert.match(r.halt.words, /cannot run its hidden checks/);
  assert.equal(r.halt.clear, "node /opt/driver/driver.mjs --step test-machine --settings-dir /etc/driver", "looking again clears it once the cause is gone");
  r = await tm.run({ ...ctx(), settings: { ...settings, steps: { "test-machine": { holdout: "H-1", state_dir: path.join(tmp, "tm2") } } }, deps: { ...unhealthy, repair: async () => ({ ran: true, outcome: "breach", breaches: [{ why: "wrote to the live verifier tools" }] }) } });
  assert.equal(r.halt.key, "repair-halted"); assert.match(r.halt.words, /stopped itself/);
  assert.equal(r.halt.clear, "node /opt/driver/driver.mjs --step test-machine --clear-halt --settings-dir /etc/driver");
  const again = await tm.run({ ...ctx(), settings: { ...settings, steps: { "test-machine": { holdout: "H-1", state_dir: path.join(tmp, "tm2") } } }, deps: { ...unhealthy, repair: async () => { throw new Error("no second repair while halted"); } } });
  assert.equal(again.halt.key, "repair-halted", "no program removes it");
  const cleared = await tm.run({ ...ctx({ clearHalt: true }), settings: { ...settings, steps: { "test-machine": { holdout: "H-1", state_dir: path.join(tmp, "tm2") } } }, deps: unhealthy });
  assert.deepEqual([cleared.ok, cleared.summary, cleared.halt], [true, "halt cleared", undefined]);
  assert.ok(!fs.existsSync(settings.notices.godspeed_notices_file), "nothing was told to the owner");
  const healthy = await tm.run({ ...ctx(), settings: { ...settings, steps: { "test-machine": { holdout: "H-1", state_dir: path.join(tmp, "tm3") } } }, deps: { ...unhealthy, check: () => ({ staged, target: "/c", smoke: { ok: true }, holdout: { id: "H-1", verdict: "PASS" } }) } });
  assert.equal(healthy.halt, undefined); assert.match(healthy.summary, /^healthy/);
}

testCase("nothing of the first owner is left in the files that ship");
{
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : files.push(f); } };
  walk(stepsDir);
  const banned = [/MichaelZelbel/, /\/home\/godspeed-forge/, /godspeed-archon/, /\/[\w./-]*keys\.env/, /\/usr\/local\/lib\/godspeed-forge\/godspeed-dev/, /\/var\/lib\/godspeed/, /\/etc\/godspeed-forge/, /\/usr\/local\/lib\/godspeed/, /\b1001\b/, /\bMichael\b/];
  const seen = [];
  for (const f of files.filter(f => fs.existsSync(f))) { seen.push(f); const t = fs.readFileSync(f, "utf8"); for (const re of banned) assert.ok(!re.test(t), `${path.relative(stepsDir, f)} holds ${re}`); }
  assert.ok(seen.length >= 8, "the files were found");
}

testCase("a malformed state file stops the questions step with an error, not a crash");
{
  const dir = fs.mkdtempSync(path.join(tmp, "qbad-"));
  fs.writeFileSync(path.join(dir, "state.json"), "{ not json");
  const r = await questions.run({ ...ctx(), settings: { ...settings, server: { ...settings.server, questions_dir: dir } }, projects: [main], env: { OQ_ISSUES_FILE: path.join(dir, "i.json") } });
  assert.equal(r.ok, false); assert.ok(r.error && r.summary);
}

testCase("a persisted halt of the test machine is reported on every run until --clear-halt, also when healthy or only a tool is missing");
{
  const st = { ...settings, steps: { "test-machine": { holdout: "H-1", state_dir: path.join(tmp, "tmh") } } };
  fs.mkdirSync(path.join(tmp, "tmh"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "tmh", "state.json"), JSON.stringify({ halted: { at: "2026-11-22T10:00:00.000Z", why: "wrote to the live tools" }, referee: { done: {}, runs: [] } }));
  const staged = { id: "r", version: "1.0.0", commit: "a".repeat(40) };
  const base = { findable: () => ({ ok: true, changed: [], left: [] }) };
  const healthy = { ...base, coverage: () => ({ ids: ["H-1"], missing: [] }), check: () => ({ staged, target: "/c", smoke: { ok: true }, holdout: { id: "H-1", verdict: "PASS" } }) };
  const toolsOnly = { ...base, coverage: () => ({ ids: ["H-1", "H-2"], missing: [{ id: "H-2", why: "H-2 has no tool" }] }), check: healthy.check };
  for (const deps of [healthy, toolsOnly, healthy]) {
    const r = await tm.run({ ...ctx(), settings: st, deps });
    assert.equal(r.halt && r.halt.key, "repair-halted");
    assert.match(r.halt.clear, /--clear-halt/);
  }
  const cleared = await tm.run({ ...ctx({ clearHalt: true }), settings: st, deps: healthy });
  assert.equal(cleared.summary, "halt cleared");
  assert.equal((await tm.run({ ...ctx(), settings: st, deps: healthy })).halt, undefined, "gone after --clear-halt");
}
