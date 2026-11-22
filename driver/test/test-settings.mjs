import { test } from "./harness.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, renderEnvFile, CORE } from "../settings.mjs";

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const example = JSON.parse(fs.readFileSync(path.join(root, "settings.example.json"), "utf8"));
// The keys the steps ask for (the steps themselves are other files; these are the kinds of key they declare).
const steps = [
  { name: "questions", SETTINGS: [{ key: "steps.questions.godspeed_dir", required: true }, { key: "steps.questions.hermes_home", required: true }, { key: "server.factory_home", required: true }, { key: "projects[].questions", required: false }] },
  { name: "test-machine", SETTINGS: [{ key: "steps.test-machine.holdout", required: true }, { key: "ai.models.strong", required: false }, { key: "server.factory_gid", required: true }, { key: "projects[main].releases.tools_dir", required: true }, { key: "projects[main].releases.holdouts_dir", required: true }, { key: "projects[main].releases.records_checkout", required: true }, { key: "projects[main].checkout", required: true }] },
];
const stepSettings = steps.map(s => s.SETTINGS);

// the example, written out as the settings folder
function folder(edit = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-set-"));
  const d = JSON.parse(JSON.stringify(example["driver.json"])), p = JSON.parse(JSON.stringify(example["projects/owner--repository.json"]));
  const files = { d, p, extra: {} };
  edit(files);
  fs.writeFileSync(path.join(dir, "driver.json"), JSON.stringify(files.d));
  fs.mkdirSync(path.join(dir, "projects"));
  fs.writeFileSync(path.join(dir, "projects", "owner--repository.json"), JSON.stringify(files.p));
  for (const [n, x] of Object.entries(files.extra)) fs.writeFileSync(path.join(dir, "projects", n), JSON.stringify(x));
  return dir;
}
const load = dir => loadSettings(dir, { steps });
const message = fn => { try { fn(); } catch (e) { return e.message; } return ""; };

test("the example file, filled in, is valid, and gives the modules the values they read", () => {
  const s = load(folder());
  assert.equal(s.main.repository, "owner/repository");
  assert.equal(s.env.FD_REPO, "owner/repository");
  assert.equal(s.env.FD_OWNER_LOGIN, "your-github-login");
  assert.equal(s.env.FD_TRUSTED_LOGINS, "your-github-login,your-builder-app[bot],your-release-app[bot]");
  assert.equal(s.env.FD_RELEASES_DIR, "/var/lib/godspeed/forge/records/releases");
  assert.equal(s.env.FD_PLAN_PATTERN, "^release-\\d");
  assert.equal(s.env.FD_AUTO_STAGE_STATE, "/var/lib/godspeed/forge/driver/steps/stage/state.json", "the stage step's state file, from steps.stage.state_dir");
  assert.equal(s.env.HOLD_FILE, "/usr/local/lib/godspeed/forge/keeper/HOLD");
  assert.equal(s.env.FD_TO_OWNER_FILE, "to-owner.json", "the default of the questions step's file");
  assert.equal(s.settings.server.factory_gid, 1000);
  assert.equal(s.settings.steps.questions.to_owner_file, "to-owner.json");
  for (const [k, v] of Object.entries(s.env)) assert.equal(typeof v, "string", k);
});

test("a missing key is refused by name, and nothing else is said about it", () => {
  const miss = (edit, key) => { const m = message(() => load(folder(edit))); assert.match(m, /lack/); assert.ok(m.includes(key), `${key}: ${m}`); };
  miss(f => { delete f.d.owner.github_login; }, "owner.github_login");
  // the App-token program is asked for only by the steps that use one (trust, keep-main-green, stage): a new owner's
  // driver, with those steps off, needs none
  assert.doesNotThrow(() => load(folder(f => { delete f.d.keys.token_script; })));
  const withTrust = message(() => loadSettings(folder(f => { delete f.d.keys.token_script; }), { steps: [...steps, { name: "trust", SETTINGS: [{ key: "keys.token_script", required: true }] }] }));
  assert.ok(withTrust.includes("keys.token_script"), withTrust);
  miss(f => { delete f.d.notices.watch_repo; }, "notices.watch_repo");
  miss(f => { delete f.d.ai.act_brain_dir; }, "ai.act_brain_dir");
  miss(f => { delete f.p.apps.builder; }, "main.apps.builder");
  miss(f => { delete f.p.checkout; }, "main.checkout");
  miss(f => { delete f.p.releases.plan_pattern; }, "releases.plan_pattern");
  miss(f => { delete f.p.releases.tools_dir; }, "releases.tools_dir");
  miss(f => { delete f.d.steps["test-machine"]; }, "steps.test-machine.holdout");
  miss(f => { delete f.d.steps.questions.hermes_home; }, "steps.questions.hermes_home");
  miss(f => { delete f.d.server.factory_user; delete f.d.server.factory_uid; }, "server.factory_user");
  const two = message(() => load(folder(f => { delete f.d.owner.github_login; delete f.d.notices.watch_repo; })));
  assert.ok(two.includes("owner.github_login") && two.includes("notices.watch_repo"), "every missing key is named at once");
});

test("a project without a releases block needs none of the release keys; more than one project with one is refused in plain words", () => {
  const s = load(folder(f => { delete f.p.releases; f.d.steps["test-machine"] = { enabled: false }; })); // the test machine step needs the release records: off
  assert.equal(s.env.FD_PLAN_PATTERN, undefined);
  assert.equal(s.env.FD_RELEASES_DIR, undefined);
  const m = message(() => load(folder(f => { f.extra["owner--second.json"] = { repository: "owner/second", checkout: "/x", apps: { builder: "b", release: "r" }, releases: f.p.releases }; })));
  assert.match(m, /More than one project has a releases block/);
  assert.match(message(() => loadSettings(path.join(os.tmpdir(), "no-such-settings-folder"), { steps })), /cannot be read/);
  assert.match(message(() => load(folder(f => { delete f.p.releases; }))), /steps\.test-machine|releases\.tools_dir/, "the test machine step asks for the release records unless it is turned off");
  const dir = folder(); fs.writeFileSync(path.join(dir, "driver.json"), "{ not json");
  assert.match(message(() => load(dir)), /not valid JSON/);
});

test("the main project is the one with releases, else the first; the other projects are kept", () => {
  const s = load(folder(f => { f.extra["aaa--first.json"] = { repository: "aaa/first", checkout: "/c", apps: { builder: "b", release: "r" } }; }));
  assert.equal(s.main.repository, "owner/repository");
  assert.deepEqual(s.projects.map(p => p.repository).sort(), ["aaa/first", "owner/repository"]);
  const t = load(folder(f => { delete f.p.releases; f.d.steps["test-machine"] = { enabled: false }; f.extra["aaa--first.json"] = { repository: "aaa/first", checkout: "/c", apps: { builder: "b", release: "r" } }; }));
  assert.equal(t.main.repository, "aaa/first");
});

test("a step's own keys are checked, but its default is words for people, never a value taken for the setting", () => {
  const dir = folder();
  const s = loadSettings(dir, { stepSettings: [[{ key: "steps.demo.where", required: false, default: "none", meaning: "x" }]] });
  assert.equal(s.settings.steps.demo, undefined, "'none' is not put into the settings");
  assert.match(message(() => loadSettings(dir, { stepSettings: [[{ key: "steps.demo.must", required: true, meaning: "y" }]] })), /steps\.demo\.must/);
  assert.equal(message(() => loadSettings(dir, { stepSettings: [[{ key: "projects[main].releases.tools_dir", required: true }, { key: "projects[main].checkout", required: true }, { key: "projects[].questions", required: false }]] })), "", "a step's way of naming the main project's keys is understood");
});

test("the settings carry no value of anyone in particular, and an empty netns means none", () => {
  const s = load(folder());
  assert.equal(s.env.FD_FORGE_NETNS, "", "empty is kept where empty is meant");
  const text = JSON.stringify(CORE.map(c => [c.key, c.def ? String(c.def(() => "x", "/etc/godspeed-forge")) : ""]));
  assert.ok(!/MichaelZelbel|godspeed-archon|\/home\/godspeed-forge|hermes/.test(text), "no default names a person, a server or a user");
});

test("the environment file the keeper's and dead-man's units read is the same values, quoted", () => {
  const s = load(folder());
  const text = renderEnvFile(s.env);
  assert.match(text, /^FD_REPO=owner\/repository$/m);
  assert.match(text, /^FD_PLAN_PATTERN="\^release-\\\\d"$/m, "a value with a backslash is quoted so systemd reads it back unchanged");
  assert.ok(!/\bKEY\b|TOKEN=|SECRET/i.test(text.replace(/FD_TOKEN_SCRIPT=\S+/, "")), "no secret is in it: the settings hold none");
});
