import { test } from "./harness.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { installDriver, installWatcher, driverFiles, renderUnits, InstallStop } from "../install.mjs";
import { loadSettings, renderEnvFile } from "../settings.mjs";
import { discoverSteps } from "../steps.mjs";
import { runDriverCommand, driverAfterSetup } from "../cli.mjs";

const source = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const example = JSON.parse(fs.readFileSync(path.join(source, "settings.example.json"), "utf8"));
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

// a server, in a folder: the settings, the places the driver goes, and a systemd that only records what it was asked
function server(edit = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-install-"));
  const settingsDir = path.join(root, "etc", "godspeed-forge"), p = x => path.join(root, x);
  const d = JSON.parse(JSON.stringify(example["driver.json"])), pr = JSON.parse(JSON.stringify(example["projects/owner--repository.json"]));
  Object.assign(d.server, { state_dir: p("var/lib/state"), spool_dir: p("var/lib/spool"), deadman_state_dir: p("var/lib/deadman"), questions_dir: p("var/lib/questions"), keeper_dir: p("usr/lib/keeper"), driver_dir: p("usr/lib/driver"), node: "/opt/node/bin/node" });
  d.legacy_units = ["auto-stage.timer", "auto-stage.service", "old-trust.timer"];
  pr.releases.records_checkout = p("srv/records");
  const files = { d, p: pr };
  edit(files);
  fs.mkdirSync(path.join(settingsDir, "projects"), { recursive: true });
  fs.writeFileSync(path.join(settingsDir, "driver.json"), JSON.stringify(files.d));
  fs.writeFileSync(path.join(settingsDir, "projects", "owner--repository.json"), JSON.stringify(files.p));
  const unitsDir = p("etc/systemd/system"), calls = [];
  const deps = { isRoot: () => true, hasSystemd: () => true, unitsDir, run: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { status: 0, stdout: "", stderr: "" }; } };
  return { root, settingsDir, unitsDir, calls, deps, p, files };
}
const stop = async fn => { try { await fn(); } catch (e) { if (e instanceof InstallStop) return e.message; throw e; } return ""; };

test("the install copies the driver without its tests, the keeper and the dead-man outside it, and checks every file against the add-on's", async () => {
  const s = server();
  const lines = await installDriver({ source, settingsDir: s.settingsDir, deps: s.deps });
  const driverDir = s.p("usr/lib/driver"), keeperDir = s.p("usr/lib/keeper");
  const files = driverFiles(source);
  assert.ok(files.includes("driver.mjs") && files.includes("steps.mjs") && files.includes("release-driver/release-driver.mjs") && files.includes("briefs/decide.md"));
  assert.ok(!files.some(f => f.startsWith("test/") || f.startsWith("units/")), "no test and no unit template goes onto the server");
  for (const f of files) assert.equal(sha(path.join(driverDir, f)), sha(path.join(source, f)), f);
  assert.equal(fs.existsSync(path.join(driverDir, "test")), false);
  assert.equal(sha(path.join(keeperDir, "keeper.mjs")), sha(path.join(source, "keeper.mjs")));
  assert.equal(sha(path.join(keeperDir, "deadman.mjs")), sha(path.join(source, "deadman", "deadman.mjs")), "the dead-man stands beside the keeper, outside the driver's folder");
  assert.equal(fs.readFileSync(path.join(s.settingsDir, "driver.env"), "utf8").includes("FD_REPO=owner/repository"), true);
  assert.ok(lines.length >= 5 && lines.every(l => /^[A-Z]/.test(l) && l.endsWith(".")), `one plain line for each thing done: ${lines.join(" | ")}`);
});

test("the units reproduce today's: the driver with flock, its limits and the keeper's hooks, the keeper's three units, the dead-man and its five-minute timer, all with paths from the settings", async () => {
  const s = server();
  await installDriver({ source, settingsDir: s.settingsDir, deps: s.deps });
  const u = n => fs.readFileSync(path.join(s.unitsDir, n), "utf8");
  const drv = u("factory-driver.service");
  assert.ok(drv.includes(`ExecStart=/usr/bin/flock -n /run/factory-driver.flock /opt/node/bin/node ${path.resolve(s.p("usr/lib/driver"))}/driver.mjs --settings-dir ${s.settingsDir}`) || drv.includes("/usr/bin/flock -n /run/factory-driver.flock /opt/node/bin/node"));
  assert.match(drv, /Type=oneshot/); assert.match(drv, /TimeoutStartSec=600/); assert.match(drv, /StateDirectoryMode=0755/);
  assert.match(drv, /ExecStartPre=-\/usr\/bin\/git -C .*srv.records pull --ff-only -q/, "the records checkout is pulled before each round");
  assert.match(u("factory-driver.timer"), /OnCalendar=\*:0\/5/);
  const dropin = u("factory-driver.service.d/keeper.conf");
  assert.match(dropin, /OnSuccess=factory-driver-keeper\.service/); assert.match(dropin, /OnFailure=factory-driver-rollback\.service/);
  for (const [unit, verb] of [["factory-driver-keeper.service", "clean"], ["factory-driver-rollback.service", "failed"], ["factory-driver-repair.service", "repair"]]) assert.match(u(unit), new RegExp(`ExecStart=/opt/node/bin/node .*keeper/keeper\\.mjs ${verb}\\b`), unit);
  const dm = u("factory-deadman.service");
  assert.match(dm, /flock -n \/run\/factory-deadman\.flock \/opt\/node\/bin\/node .*keeper.deadman\.mjs/); assert.match(dm, /TimeoutStartSec=120/);
  const dt = u("factory-deadman.timer");
  assert.match(dt, /OnCalendar=\*:0\/5/); assert.match(dt, /Persistent=true/); assert.match(dt, /AccuracySec=5s/);
  for (const n of ["factory-driver.service", "factory-driver-keeper.service", "factory-deadman.service"]) assert.ok(!/\{\{|\}\}/.test(u(n)), `${n} has no placeholder left`);
  assert.ok(!/MichaelZelbel|godspeed-archon|\/home\/godspeed/.test(drv + dm), "no name of anyone");
});

test("systemd is reloaded and the driver's and the dead-man's timers are enabled; the units the driver replaces are switched off only with --switch, and never deleted", async () => {
  const s = server();
  fs.mkdirSync(s.unitsDir, { recursive: true });
  for (const n of ["auto-stage.timer", "auto-stage.service", "old-trust.timer"]) fs.writeFileSync(path.join(s.unitsDir, n), "[Unit]\n");
  await installDriver({ source, settingsDir: s.settingsDir, deps: s.deps });
  assert.ok(s.calls.includes("systemctl daemon-reload"));
  assert.ok(s.calls.includes("systemctl enable --now factory-driver.timer") && s.calls.includes("systemctl enable --now factory-deadman.timer"));
  assert.ok(!s.calls.some(c => /\bdisable\b/.test(c)), "nothing is switched off without --switch");
  const lines = await installDriver({ source, settingsDir: s.settingsDir, switchOver: true, deps: s.deps });
  for (const n of ["auto-stage.timer", "auto-stage.service", "old-trust.timer"]) assert.ok(s.calls.includes(`systemctl disable --now ${n}`), n);
  assert.ok(!s.calls.some(c => /\b(rm|mask|delete)\b/.test(c)));
  for (const n of ["auto-stage.timer", "auto-stage.service", "old-trust.timer"]) assert.ok(fs.existsSync(path.join(s.unitsDir, n)), `${n} is still there`);
  assert.ok(lines.some(l => /Switched off 3 of the 3 units/.test(l)));
});

test("a missing setting is named and nothing is changed; so is a server without systemd, or a driver folder inside the add-on's own", async () => {
  const s = server(f => { delete f.d.keys.token_script; });
  const m = await stop(() => installDriver({ source, settingsDir: s.settingsDir, deps: s.deps }));
  assert.match(m, /keys\.token_script/); assert.match(m, /Nothing was changed/);
  assert.equal(fs.existsSync(s.p("usr/lib/driver")), false); assert.deepEqual(s.calls, []); assert.equal(fs.existsSync(s.unitsDir), false);
  const ok = server();
  assert.match(await stop(() => installDriver({ source, settingsDir: ok.settingsDir, deps: { ...ok.deps, isRoot: () => false } })), /installed by root on a Linux server that runs systemd/);
  assert.match(await stop(() => installDriver({ source, settingsDir: ok.settingsDir, deps: { ...ok.deps, hasSystemd: () => false } })), /runs systemd/);
  const inside = server(f => { f.d.server.driver_dir = path.join(source, "installed-here"); });
  assert.match(await stop(() => installDriver({ source, settingsDir: inside.settingsDir, deps: inside.deps })), /must not be the add-on's own folder/);
  const same = server(f => { f.d.server.keeper_dir = f.d.server.driver_dir + "/keeper"; });
  assert.match(await stop(() => installDriver({ source, settingsDir: same.settingsDir, deps: same.deps })), /separate folders/);
});

test("installing again is an upgrade: what is no longer part of the driver is removed from its folder, and the keeper saves the set before and records it after", async () => {
  const s = server();
  await installDriver({ source, settingsDir: s.settingsDir, deps: s.deps });
  const driverDir = s.p("usr/lib/driver");
  fs.writeFileSync(path.join(driverDir, "left-over.mjs"), "old\n"); fs.writeFileSync(path.join(driverDir, "briefs", "old-brief.md"), "old\n");
  fs.writeFileSync(path.join(driverDir, "driver.mjs"), "// an older driver\n");
  s.calls.length = 0;
  const lines = await installDriver({ source, settingsDir: s.settingsDir, deps: s.deps });
  assert.equal(fs.existsSync(path.join(driverDir, "left-over.mjs")), false); assert.equal(fs.existsSync(path.join(driverDir, "briefs", "old-brief.md")), false);
  assert.equal(sha(path.join(driverDir, "driver.mjs")), sha(path.join(source, "driver.mjs")));
  const k = s.calls.filter(c => /keeper\.mjs/.test(c));
  assert.match(k[0], /keeper\.mjs before-install$/); assert.match(k.at(-1), /keeper\.mjs installed$/, "saved before, recorded after");
  assert.ok(lines.some(l => /removed 2 that are no longer part of it/.test(l)));
});

test("--watcher puts the three watcher files into the watch repository only when they differ, with every name from repository variables", () => {
  const s = server();
  const loaded = loadSettings(s.settingsDir, { steps: [] });
  const store = {}, calls = [];
  const gh = (cmd, args) => {
    calls.push(args.join(" "));
    const m = /repos\/owner\/records\/contents\/(.+)$/.exec(args[1] || "");
    if (args[0] === "api" && m && args[1] === `repos/owner/records/contents/${m[1]}`) return store[m[1]] ? { status: 0, stdout: JSON.stringify({ sha: "abc", content: Buffer.from(store[m[1]]).toString("base64") }) } : { status: 1, stdout: "", stderr: "Not Found" };
    if (args[0] === "api" && args[1] === "-X") { const p2 = /contents\/(.+?)$/.exec(args[3])[1]; store[p2] = Buffer.from(/content=(.*)$/.exec(args.find(a => a.startsWith("content=")))[1], "base64").toString("utf8"); return { status: 0, stdout: "{}" }; }
    return { status: 0, stdout: "" };
  };
  const first = installWatcher(source, loaded, { run: gh });
  assert.deepEqual(Object.keys(store).sort(), [".github/workflows/factory-notify.yml", ".github/workflows/factory-watch.yml", "scripts/factory-watch.mjs"]);
  assert.ok(first.some(l => /Put \.github\/workflows\/factory-watch\.yml into owner\/records/.test(l)));
  assert.ok(calls.some(c => c.startsWith("variable set FACTORY_OWNER --repo owner/records --body your-github-login")) && calls.some(c => c.startsWith("variable set FACTORY_PLAN_PATTERN")));
  for (const [f, t] of Object.entries(store)) assert.ok(!/MichaelZelbel|godspeed-archon/.test(t), `${f} names no one`);
  assert.match(store[".github/workflows/factory-notify.yml"], /vars\.FACTORY_OWNER/); assert.match(store[".github/workflows/factory-watch.yml"], /vars\.FACTORY_PLAN_PATTERN/);
  calls.length = 0;
  const again = installWatcher(source, loaded, { run: gh });
  assert.ok(!calls.some(c => c.startsWith("api -X PUT")), "unchanged files are not put again");
  assert.ok(again.some(l => /already the add-on's/.test(l)));
});

test("the command: `driver install` says the plain sentence a stop gives; a wrong word prints the usage; `driver round --dry-run` is the driver's own dry run", async () => {
  const said = [];
  assert.equal(await runDriverCommand(["bogus"], { output: l => said.push(l) }), 1);
  assert.match(said.at(-1), /Run godspeed-forge driver install/);
  const s = server(f => { delete f.d.owner.github_login; });
  assert.equal(await runDriverCommand(["install", "--settings-dir", s.settingsDir], { output: l => said.push(l), install: { deps: s.deps } }), 1);
  assert.match(said.at(-1), /owner\.github_login/);
  const good = server();
  assert.equal(await runDriverCommand(["install", "--settings-dir", good.settingsDir, "--switch"], { output: l => said.push(l), install: { deps: good.deps } }), 0);
  assert.ok(good.calls.includes("systemctl disable --now auto-stage.timer"));
});

test("when setup has finished as root where systemd runs, it writes the project's settings and installs the driver; anywhere else it does nothing, and a failure is said, never thrown", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-after-setup-"));
  const paths = { config: path.join(root, "etc", "godspeed-forge", "config.json") };
  const config = { projectsRoot: path.join(root, "projects") };
  const checkout = path.join(config.projectsRoot, "acme", "app");
  fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
  fs.writeFileSync(path.join(checkout, ".git", "godspeed-forge-apps.json"), JSON.stringify({ builder: { name: "B", slug: "acme-builder", id: 1 }, release: { name: "R", slug: "acme-release", id: 2 } }));
  assert.deepEqual(await driverAfterSetup("acme/app", { paths, config, platform: "darwin", uid: 0 }), []);
  assert.deepEqual(await driverAfterSetup("acme/app", { paths, config, platform: "linux", uid: 1000 }), []);
  assert.equal(fs.existsSync(path.join(root, "etc")), false, "not root: nothing written");
  const said = [];
  const lines = await driverAfterSetup("acme/app", { paths, config, platform: "linux", uid: 0, systemd: () => true, output: l => said.push(l), install: { deps: { isRoot: () => true, hasSystemd: () => true, unitsDir: path.join(root, "units"), run: () => ({ status: 0, stdout: "", stderr: "" }) } } });
  const project = JSON.parse(fs.readFileSync(path.join(root, "etc", "godspeed-forge", "projects", "acme--app.json"), "utf8"));
  assert.deepEqual([project.repository, project.checkout === checkout, project.apps], ["acme/app", true, { builder: "acme-builder", release: "acme-release" }]);
  const server_ = JSON.parse(fs.readFileSync(path.join(root, "etc", "godspeed-forge", "driver.json"), "utf8"));
  assert.equal(server_.owner.github_login, "acme");
  assert.deepEqual(lines, [], "the install stopped on what this server cannot tell (the App token program): it says which, and setup still counts as finished");
  assert.match(said.join(" "), /keys\.token_script/);
  // what the owner wrote is never written over
  fs.writeFileSync(path.join(root, "etc", "godspeed-forge", "driver.json"), JSON.stringify({ ...server_, owner: { github_login: "kept" } }));
  await driverAfterSetup("acme/app", { paths, config, platform: "linux", uid: 0, systemd: () => true, output: () => {}, install: { deps: { isRoot: () => true, hasSystemd: () => true, unitsDir: path.join(root, "units"), run: () => ({ status: 0 }) } } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "etc", "godspeed-forge", "driver.json"), "utf8")).owner.github_login, "kept");
});
