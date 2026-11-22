// test cases: 9
// node driver/test/steps/test-steps-release.mjs
// The three release steps (stage, plan, keep-main-green) as the driver calls them: what they ask of the
// settings, what run() returns, and that a halt is returned and never sent. The helpers' own behaviour is
// tested by the moved tests beside this file (driver/test/steps/release/).
import { test, runCases } from "./case-test.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as stage from "../../steps/stage.mjs";
import * as plan from "../../steps/plan.mjs";
import * as kmg from "../../steps/keep-main-green.mjs";
import { prepare } from "../../steps/release/from-settings.mjs";
import { clearCommandFor, makeHalt, plainHaltWords } from "../../steps/release/halts.mjs";
import * as A from "../../steps/release/auto-stage.mjs";
import { cfg } from "../../steps/release/config.mjs";
import * as S from "./release/stand-ins.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const shipped = path.join(here, "..", "..", "steps");

// A settings set with only placeholders: nothing of any real installation.
const ctxFor = (over = {}) => ({
  settings: {
    owner: { github_login: "the-owner" },
    server: { name_in_messages: "Sam", factory_user: "factory", factory_home: "/home/factory", archon_config: "/home/factory/models.yaml", driver_dir: "/opt/driver" },
    keys: { token_script: "/opt/keys/token.mjs", env_file: "" },
    notices: { godspeed_notices_file: "/srv/product/.godspeed/notices.json" },
    steps: {
      stage: { state_dir: "/var/lib/x/stage" },
      plan: { state_dir: "/var/lib/x/plan", standing_decision: 'Sam, 2026-01-01: "bug fixes may start"' },
      "keep-main-green": { state_dir: "/var/lib/x/kmg" },
    },
    ...over.settings,
  },
  main: {
    repository: "owner/product",
    checkout: "/home/factory/product",
    apps: { builder: "acme-builder", release: "acme-release[bot]" },
    releases: { records_checkout: "/srv/records", kit_bootstrap_repo: "owner/kit", server: "box", godspeed_dir: "/srv/product" },
    ...over.main,
  },
  env: {},
  log: () => {},
  dry: true,
  settingsDir: "/etc/forge",
});

test("each step names itself, its timing and the settings it reads", () => {
  assert.deepEqual([stage.STEP, plan.STEP, kmg.STEP].map((s) => [s.name, s.everyMinutes, s.maxMinutes, s.inRound]), [["stage", 15, 200, false], ["plan", 15, 60, false], ["keep-main-green", 10, 15, false]]);
  for (const mod of [stage, plan, kmg]) {
    assert.ok(mod.SETTINGS.length > 3);
    for (const s of mod.SETTINGS) {
      assert.equal(typeof s.key, "string");
      assert.equal(typeof s.meaning, "string", s.key);
      assert.ok("required" in s, s.key);
      if (!s.required) assert.ok("default" in s, `${s.key} is optional, so it says its default`);
    }
  }
  assert.ok(stage.SETTINGS.some((s) => s.key === "releases.kit_bootstrap_repo" && s.required));
  assert.ok(plan.SETTINGS.some((s) => s.key === "steps.plan.standing_decision" && s.required));
  assert.ok(kmg.SETTINGS.some((s) => s.key === "main.apps.release" && s.required));
  for (const [mod, name] of [[stage, "stage"], [plan, "plan"], [kmg, "keep-main-green"]]) {
    const own = mod.SETTINGS.find((s) => s.key === `steps.${name}.state_dir`);
    assert.equal(own.required, false, "a step's state folder has the core's default under the driver's state folder");
  }
});

test("a missing required setting is refused by its name and nothing runs", async () => {
  const c = ctxFor();
  c.main.releases.kit_bootstrap_repo = "";
  c.settings.keys.token_script = "";
  const r = await stage.run(c);
  assert.equal(r.ok, false);
  assert.match(r.error, /releases\.kit_bootstrap_repo/);
  assert.match(r.error, /keys\.token_script/);
  const p = ctxFor();
  p.settings.server.factory_user = "";
  delete p.settings.steps.plan.standing_decision;
  assert.match((await plan.run(p)).error, /server\.factory_user, |server\.factory_user$|steps\.plan\.standing_decision/);
  assert.match((await plan.run(p)).error, /server\.factory_user/);
  const k = ctxFor();
  k.main.apps = {};
  assert.match((await kmg.run(k)).error, /main\.apps\.builder/);
});

test("the helpers are configured from the settings alone, with no value of any installation", () => {
  const { env, missing } = prepare(ctxFor(), { need: ["repository", "checkout", "server", "godspeedDir", "builderApp", "releaseApp", "tokenScript"], stepName: "plan", withKeysEnv: false });
  assert.deepEqual(missing, []);
  assert.equal(cfg.productRepo, "owner/product");
  assert.equal(cfg.recordsRoot, "/srv/records");
  assert.equal(cfg.stagingOnServer, "/srv/product-staging", "derived from the product's folder");
  assert.equal(cfg.noticesFile, "/srv/product/.godspeed/notices.json");
  assert.deepEqual(cfg.deliveryAuthors, ["acme-builder", "acme-release"]);
  assert.deepEqual(cfg.trustedBots, ["acme-builder[bot]", "acme-release[bot]"]);
  assert.equal(cfg.releaseApp, "acme-release[bot]");
  assert.equal(cfg.ownerName, "Sam");
  assert.equal(cfg.standingDecision, 'Sam, 2026-01-01: "bug fixes may start"');
  assert.equal(cfg.timezone, "UTC");
  assert.equal(typeof env.HOME, "string");
});

test("the keys file is read into the environment and its values are not logged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steps-keys-"));
  const file = path.join(dir, "keys.env");
  fs.writeFileSync(file, '# keys\nGODSPEED_RELEASE_APP_ID=123\nexport GODSPEED_RELEASE_APP_KEY_B64="c2VjcmV0"\n\n');
  const c = ctxFor();
  c.settings.keys.env_file = file;
  const logged = [];
  c.log = (s) => logged.push(s);
  const { env } = prepare(c, { need: [], stepName: "stage", withKeysEnv: true });
  assert.equal(env.GODSPEED_RELEASE_APP_ID, "123", "the keys file wins over the machine's environment");
  assert.equal(env.GODSPEED_RELEASE_APP_KEY_B64, "c2VjcmV0");
  assert.equal(logged.join("").includes("c2VjcmV0"), false);
  c.settings.keys.env_file = path.join(dir, "missing.env");
  assert.equal(prepare(c, { need: [], stepName: "stage", withKeysEnv: true }).env.GODSPEED_RELEASE_APP_ID, process.env.GODSPEED_RELEASE_APP_ID, "no keys file is no keys; the helper that needs one says so");
  c.settings.keys.env_file = dir;
  assert.throws(() => prepare(c, { need: [], stepName: "stage", withKeysEnv: true }), /keys\.env_file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a halt carries its key, its plain words and the exact command that clears it", () => {
  const c = ctxFor();
  const h = makeHalt(c, "stage", "freeze-failed", "the freeze stopped:   x");
  assert.deepEqual(Object.keys(h).sort(), ["clear", "key", "words"]);
  assert.equal(h.words, "the freeze stopped: x");
  assert.equal(h.clear, "node /opt/driver/driver.mjs --step stage --clear-halt freeze-failed --settings-dir /etc/forge");
  assert.equal(makeHalt({ ...c, settingsDir: undefined }, "plan", "run-failed", "x").clear, "node /opt/driver/driver.mjs --step plan --clear-halt run-failed");
  const paid = makeHalt(c, "stage", "scenarios-lost", "another test run costs money from the test key");
  assert.match(paid.clear, /--clear-halt scenarios-lost --settings-dir \/etc\/forge --owner-said "<his words>" --owner-ref "<where he said it>"$/);
  assert.doesNotMatch(h.clear, /owner-said/, "every other halt keeps its plain clear");
  assert.equal(clearCommandFor({ clearHaltCommand: (s, k) => `forge ${s} ${k}` }, "plan", "run-failed"), "forge plan run-failed", "the runner's own command wins when it gives one");
  assert.equal(plainHaltWords("Godspeed 2.0.0-beta.9 is frozen. Nothing is public and I will not try again by myself. Mission Control has to look at it."), "Godspeed 2.0.0-beta.9 is frozen. Nothing is public.");
});

// A world for one stage look: the stand-in GitHub is not needed, the helper is stubbed at the seam run() gives
// (ctx.impl.look), so what is tested is the mapping into { ok, summary, halt, error }.
test("run() returns the halt of a look, and a look's refusal as an error, never as a message", async () => {
  const halt = makeHalt(ctxFor(), "stage", "not-staged", "frozen, but not on the server after three tries");
  const c = ctxFor();
  const withHalt = await stage.run({ ...c, impl: { look: async () => ({ result: { outcome: "halted", why: "not staged" }, halt }) } });
  assert.equal(withHalt.ok, true);
  assert.deepEqual(withHalt.halt, halt);
  assert.match(withHalt.summary, /halted/);
  const refused = await stage.run({ ...c, impl: { look: async () => ({ error: "GitHub said 401 to /x." }) } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "GitHub said 401 to /x.");
  assert.equal(refused.halt, undefined);
  const thrown = await plan.run({ ...c, impl: { look: async () => { throw new Error("boom"); } } });
  assert.deepEqual([thrown.ok, thrown.error], [false, "boom"]);
  const fine = await kmg.run({ ...c, impl: { lookOnce: async () => ({ result: { outcome: "green" } }) } });
  assert.deepEqual([fine.ok, fine.halt], [true, undefined]);
});

test("a halt of the stage step queues no notice, however often it is looked at", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steps-halt-"));
  const notices = path.join(dir, "notices.json");
  fs.writeFileSync(notices, JSON.stringify({ notices: [] }));
  const state = { version: 1, releases: { "godspeed-2.0.0-beta.9-x": { started: "2026-01-01T00:00:00Z", halted: { at: "2026-01-01T00:05:00Z", why: "the install did not work three times", key: "not-staged", words: "frozen, but not on the server" } } } };
  const ctx = { state, notify: () => assert.fail("a halt sends nothing") };
  const first = A.autoStage; // the wrapper reads the standing halt from the state even when the look has nothing to do
  assert.equal(typeof first, "function");
  const sent = [];
  ctx.notify = (n) => sent.push(n);
  // two looks that find nothing to stage still return the standing halt
  for (let i = 0; i < 2; i++) {
    const r = await A.autoStage({ cfg: { repo: "owner/product", stopFile: path.join(dir, "STOP"), stopMaxAgeMinutes: 120 }, log() {}, dry: true, state, now: () => Date.now(), publicVersion: async () => "2.0.0-beta.1", records: { releases: () => [], read: () => null, json: () => null }, notify: ctx.notify });
    assert.equal(r.halt.key, "not-staged");
    assert.equal(r.halt.words, "frozen, but not on the server");
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(notices, "utf8")).notices, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("clearing the by-hand halt writes the proceed line into the plan on the records' main, once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steps-hand-"));
  const id = "godspeed-2.0.0-beta.9-x";
  const records = S.makeRecordsRepo(path.join(dir, "records"), { [id]: "owner/product" });
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir);
  A.saveState(path.join(stateDir, "state.json"), { version: 1, releases: { [id]: { blocked: { "by-hand": "2026-01-01T00:00:00Z" } } } });
  const c = ctxFor();
  c.settings.steps.stage.state_dir = stateDir;
  c.main.releases.records_checkout = records.root;
  c.settings.keys.env_file = path.join(dir, "no-keys.env");
  const r = await stage.clearHalt(c, "blocked-by-hand");
  assert.equal(r.ok, true, r.error);
  assert.match(records.show(`releases/${id}/plan.md`), /^Auto-stage: proceed$/m);
  assert.equal(A.loadState(path.join(stateDir, "state.json")).releases[id].blocked["by-hand"], undefined);
  const again = await stage.clearHalt(c, "blocked-by-hand");
  assert.match(again.summary, /Nothing to clear/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no shipped file of the release steps names an installation: no person's repositories, server, paths or key files", () => {
  const banned = [/MichaelZelbel/, /\/home\/godspeed-forge/, /godspeed-archon/, /\/etc\/[\w./-]*keys\.env/, /\/usr\/local\/lib\/godspeed-forge\/godspeed-dev/, /\/var\/lib\/godspeed-/, /\/usr\/local\/bin\/mc-notify/, /zelbel/i];
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(mjs|js|json|md|sh|service|timer)$/.test(e.name)) files.push(p); } };
  walk(path.join(shipped, "release"));
  for (const f of ["stage.mjs", "plan.mjs", "keep-main-green.mjs"]) files.push(path.join(shipped, f));
  assert.ok(files.length >= 17);
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    for (const b of banned) assert.doesNotMatch(text, b, `${path.relative(shipped, f)} must not contain ${b}`);
  }
});

await runCases();
