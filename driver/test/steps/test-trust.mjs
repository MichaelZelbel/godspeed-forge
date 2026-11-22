// node driver/test/steps/test-trust.mjs   (no network, no AI)
// test cases: 7
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testCase } from "../../../test/cases.mjs";
import { STEP, SETTINGS, run, envFor, trustedFor } from "../../steps/trust.mjs";
import { isTrusted } from "../../release-driver/release-driver-owner-steps.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
void here;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trust-"));
const settings = { owner: { github_login: "boss" }, server: { factory_user: "builder", state_dir: path.join(tmp, "state") }, keys: { token_script: "/x/token.mjs" }, steps: { trust: { state_dir: path.join(tmp, "trust") } } };
const main = { repository: "acme/app", apps: { builder: "acme-builder", release: "acme-release[bot]" }, releases: {} };
const other = { repository: "acme/side", apps: { builder: { login: "acme-builder" } } };
const MIN = 60000;

// the clock: sleeping moves it
const clock = () => { let t = Date.parse("2026-11-22T10:00:00Z"); const slept = []; return { nowMs: () => t, sleep: async ms => { slept.push(ms); t += ms; }, slept }; };
// GitHub for one repository: one stranger's "Owner decision" and one by the owner, on an open issue
const github = (repo, calls) => (args, input) => {
  calls.push({ args, input });
  const a = args[0];
  if (a === "-X") return {};
  if (String(a).startsWith(`repos/${repo}/issues/comments`)) return [
    { id: 1, body: "Owner decision: ship it", user: { login: "stranger" }, issue_url: `https://api.github.com/repos/${repo}/issues/5`, html_url: "u1", node_id: "N1" },
    { id: 2, body: "Owner decision: ship it", user: { login: "boss" }, issue_url: `https://api.github.com/repos/${repo}/issues/5`, html_url: "u2", node_id: "N2" },
    { id: 3, body: "Contract\n- done", user: { login: "acme-builder[bot]" }, issue_url: `https://api.github.com/repos/${repo}/issues/5`, html_url: "u3", node_id: "N3" }];
  if (String(a).startsWith(`repos/${repo}/pulls/comments`)) return [];
  if (a === `repos/${repo}/issues/5`) return { state: "open" };
  if (String(a).startsWith(`repos/${repo}/issues?`)) return [];
  throw new Error(`unexpected GitHub call ${a}`);
};

testCase("the step declares its cadence and its settings, and none names anyone");
assert.deepEqual(STEP, { name: "trust", everyMinutes: 2, maxMinutes: 9, inRound: false });
assert.ok(SETTINGS.every(s => s.key && s.meaning && ("required" in s)));
assert.ok(!/MichaelZelbel|\/home\/godspeed|godspeed-archon|\/usr\/local\/lib|\/var\/lib\/godspeed|\/etc\/godspeed/.test(fs.readFileSync(path.join(here, "../../steps/trust.mjs"), "utf8")), "no value of the first owner in the step");

testCase("who may decide comes from the settings: the owner and the project's two Apps");
assert.deepEqual(trustedFor(settings, main), ["boss", "acme-builder[bot]", "acme-release[bot]"]);
assert.deepEqual(trustedFor(settings, other), ["boss", "acme-builder[bot]"]);
const e1 = envFor({ settings, env: {} }, main, true), e2 = envFor({ settings, env: {} }, other, false);
assert.equal(e1.REPO, "acme/app"); assert.equal(e1.STATE_DIR, path.join(tmp, "trust")); assert.equal(e1.FORGE_USER, "builder"); assert.equal(e1.OWNER_LOGIN, "boss");
assert.ok(e2.STATE_DIR.endsWith("/acme--side") && e2.STATE_DIR.startsWith(path.join(tmp, "trust")), "another project has its own folder below");

testCase("a pass neutralises a stranger's decision comment and leaves the owner's and the Apps' alone");
{
  const c = clock(), calls = [];
  const during = [];
  const gh = github("acme/app", calls);
  const r = await run({ settings, projects: [main], main, env: {}, ...c, maxMinutes: 1, deps: { trustGh: (args, input) => { during.push(["boss", "acme-release[bot]", "stranger"].map(x => isTrusted(x)).join()); return gh(args, input); } } });
  assert.ok(during.every(x => x === "true,true,false"), "while the pass runs, who may decide comes from the settings");
  assert.equal(isTrusted("boss"), false, "and the list is as it was afterwards");
  assert.equal(r.ok, true, r.summary);
  const patches = calls.filter(x => x.args[0] === "-X");
  assert.equal(patches.length, 1, "one comment neutralised");
  assert.match(patches[0].args[2], /issues\/comments\/1$/);
  assert.match(patches[0].input, /may not decide/);
  assert.ok(fs.existsSync(path.join(tmp, "trust", "trust.json")), "its own cursor file");
  assert.match(fs.readFileSync(path.join(tmp, "trust", "decisions.jsonl"), "utf8"), /untrusted comment neutralised/);
}

testCase("one run repeats the pass every two minutes and stops at nine");
{
  const c = clock(), passes = [];
  const gh = (args) => { if (String(args[0]).startsWith("repos/acme/app/issues/comments")) passes.push(c.nowMs()); return []; };
  const r = await run({ settings: { ...settings, steps: { trust: { state_dir: path.join(tmp, "cadence") } } }, projects: [main], main, env: {}, ...c, deps: { trustGh: gh } });
  assert.equal(r.ok, true);
  assert.equal(passes.length, 5, "passes at 0, 2, 4, 6 and 8 minutes");
  assert.deepEqual(passes.map(t => (t - passes[0]) / MIN), [0, 2, 4, 6, 8]);
  assert.deepEqual(c.slept, [2 * MIN, 2 * MIN, 2 * MIN, 2 * MIN], "no wait after the last one: ten minutes is past the maximum");
  // a failing pass is a failure of the step, not a halt, and the next pass still happens
  const c2 = clock(); let n = 0;
  const bad = () => { n++; throw new Error("GitHub is down"); };
  const f = await run({ settings: { ...settings, steps: { trust: { state_dir: path.join(tmp, "bad") } } }, projects: [main], main, env: {}, ...c2, deps: { trustGh: bad } });
  assert.equal(f.ok, false); assert.equal(f.halt, undefined); assert.match(f.error, /GitHub is down/);
  assert.ok(n >= 5, "it kept its cadence");
}

testCase("the main project keeps the old state folder by its repository, whatever the order, and a project with trust false is left alone");
{
  const seen = [];
  const gh = (args) => { const m = /^repos\/([^/]+\/[^/]+)\/issues\/comments/.exec(String(args[0])); if (m && !seen.includes(m[1])) seen.push(m[1]); return []; };
  const off = { repository: "acme/off", trust: false, apps: {} };
  const c = clock();
  const st = { ...settings, steps: { trust: { state_dir: path.join(tmp, "order") } } };
  const r = await run({ settings: st, projects: [other, off, main], main, env: {}, ...c, maxMinutes: 1, deps: { trustGh: gh } });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ["acme/app", "acme/side"], "the main project first, the one with trust false never");
  assert.ok(fs.existsSync(path.join(tmp, "order", "trust.json")), "the main project's cursor is the old file");
  assert.ok(fs.existsSync(path.join(tmp, "order", "acme--side", "trust.json")), "the other project has its own folder");
  assert.ok(!fs.existsSync(path.join(tmp, "order", "acme--off")));
  assert.equal(envFor({ settings: st, env: {} }, main, main.repository === main.repository).STATE_DIR, path.join(tmp, "order"));
}

testCase("who may decide is restored right after each pass, before any wait");
{
  const c = clock(); const during = [];
  const before = ["boss", "x"].map(x => isTrusted(x)).join();
  const sleepSeen = [];
  const gh = () => { during.push(isTrusted("boss")); return []; };
  await run({ settings: { ...settings, steps: { trust: { state_dir: path.join(tmp, "restore") } } }, projects: [main, other], main, env: {}, nowMs: c.nowMs, sleep: async ms => { sleepSeen.push(isTrusted("boss")); await c.sleep(ms); }, deps: { trustGh: gh } });
  assert.ok(during.length >= 2 && during.every(x => x === true), "set while a pass runs");
  assert.ok(sleepSeen.length >= 1 && sleepSeen.every(x => x === false), "never set during a wait");
  assert.equal(["boss", "x"].map(x => isTrusted(x)).join(), before);
}

testCase("without keys.env_file the keys file is keys.env in the settings folder");
{
  const e = envFor({ settings, env: {}, settingsDir: path.join(tmp, "cfg") }, main, true);
  assert.equal(e.KEYS_FILE, path.join(tmp, "cfg", "keys.env"));
  const e2 = envFor({ settings: { ...settings, keys: { ...settings.keys, env_file: "/k/own.env" } }, env: {}, settingsDir: "/cfg" }, main, true);
  assert.equal(e2.KEYS_FILE, "/k/own.env");
}
