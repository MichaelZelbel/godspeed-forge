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
  const s = { root, settingsDir, unitsDir, calls, p, files, round: "good", active: [], journal: "", stopFail: [], stopIgnored: [], startFail: [], enableFail: [], disableFail: [], disableNotFound: [], result: "success", stopRoundFail: false, stepUnits: [] };
  const failed = stderr => ({ status: 1, stdout: "", stderr });
  // a systemd that only records what it was asked. The first round (`systemctl start factory-driver.service`) is good, fails, hangs,
  // or ends without a status file; every other command can be made to fail.
  s.deps = { isRoot: () => true, hasSystemd: () => true, unitsDir, run: (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    if (cmd === "journalctl") return { status: 0, stdout: s.journal, stderr: "" };
    if (cmd !== "systemctl") return { status: 0, stdout: "", stderr: "" };
    const verb = args[0], unit = args[args.length - 1];
    if (verb === "is-active") return { status: 0, stdout: s.active.includes(unit) ? "active\n" : "inactive\n", stderr: "" };
    if (verb === "list-units") return { status: 0, stdout: s.stepUnits.map(u => `${u} loaded active running step\n`).join(""), stderr: "" };
    if (verb === "show") return { status: 0, stdout: `Result=${s.result}\nExecMainStatus=${s.result === "success" ? 0 : 1}\n`, stderr: "" };
    if (verb === "stop") {
      if (/^forge-step-/.test(unit)) { s.stepUnits = s.stepUnits.filter(u => u !== unit); return { status: 0, stdout: "", stderr: "" }; }
      if (unit === "factory-driver.service") return s.stopRoundFail ? failed("Failed to stop factory-driver.service") : { status: 0, stdout: "", stderr: "" };
      if (s.stopFail.includes(unit)) return failed("Failed to stop " + unit);
      if (!s.stopIgnored.includes(unit)) s.active = s.active.filter(u => u !== unit);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (verb === "start" && unit === "factory-driver.service") {
      if (s.round === "fail") return failed("Job for factory-driver.service failed.");
      if (s.round === "hang") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
      if (s.round === "good") { fs.mkdirSync(files.d.server.state_dir, { recursive: true }); fs.writeFileSync(path.join(files.d.server.state_dir, "status.json"), JSON.stringify({ at: new Date(Date.now() + 50).toISOString() })); }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (verb === "start") { if (s.startFail.includes(unit)) return failed("Failed to start " + unit); s.active.push(unit); return { status: 0, stdout: "", stderr: "" }; }
    if (verb === "enable" && s.enableFail.includes(unit)) return failed("Failed to enable " + unit);
    if (verb === "disable") {
      if (s.disableFail.includes(unit)) return failed("Failed to disable unit: Access denied");
      if (s.disableNotFound.includes(unit)) return failed("Failed to disable unit: Unit file " + unit + " does not exist.");
    }
    return { status: 0, stdout: "", stderr: "" };
  } };
  return s;
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

test("systemd is reloaded and the driver's and the dead-man's timers are enabled; without --switch nothing old is touched", async () => {
  const s = server();
  fs.mkdirSync(s.unitsDir, { recursive: true });
  for (const n of ["auto-stage.timer", "auto-stage.service", "old-trust.timer"]) fs.writeFileSync(path.join(s.unitsDir, n), "[Unit]\n");
  const lines = await installDriver({ source, settingsDir: s.settingsDir, deps: s.deps });
  assert.ok(s.calls.includes("systemctl daemon-reload"));
  assert.ok(s.calls.includes("systemctl enable --now factory-driver.timer") && s.calls.includes("systemctl enable --now factory-deadman.timer"));
  assert.ok(!s.calls.some(c => /\b(disable|stop)\b/.test(c)), "nothing is switched off or stopped without --switch");
  assert.ok(lines.some(l => /still on: add --switch/.test(l)));
});

test("--switch is one transaction: the old timers are stopped, not disabled; one round runs; only after a good round are the old units disabled (never deleted) and the timers enabled", async () => {
  const s = server();
  s.active = ["auto-stage.timer", "old-trust.timer"];
  fs.mkdirSync(s.unitsDir, { recursive: true });
  for (const n of ["auto-stage.timer", "auto-stage.service", "old-trust.timer"]) fs.writeFileSync(path.join(s.unitsDir, n), "[Unit]\n");
  const lines = await installDriver({ source, settingsDir: s.settingsDir, switchOver: true, deps: s.deps });
  const at = c => s.calls.indexOf(c);
  assert.ok(at("systemctl stop auto-stage.timer") >= 0 && at("systemctl stop old-trust.timer") >= 0, "the old timers are stopped");
  assert.ok(at("systemctl start factory-driver.service") > at("systemctl stop auto-stage.timer"), "the round runs after they are stopped");
  for (const n of ["auto-stage.timer", "auto-stage.service", "old-trust.timer"]) assert.ok(at(`systemctl disable --now ${n}`) > at("systemctl start factory-driver.service"), `${n} is disabled only after the good round`);
  assert.ok(at("systemctl enable --now factory-driver.timer") > at("systemctl start factory-driver.service") && at("systemctl enable --now factory-deadman.timer") > at("systemctl start factory-driver.service"), "the timers are enabled after it");
  assert.ok(!s.calls.some(c => /\b(rm|mask|delete)\b/.test(c)));
  for (const n of ["auto-stage.timer", "auto-stage.service", "old-trust.timer"]) assert.ok(fs.existsSync(path.join(s.unitsDir, n)), `${n} is still there`);
  assert.ok(lines.some(l => /did one good round/.test(l)) && lines.some(l => /Switched off 3 of the 3 old units/.test(l)));
});

// a server that has an old driver, an old timer running, and units of the driver already in place
function oldServer(edit = () => {}) {
  const s = server();
  s.active = ["auto-stage.timer", "old-trust.timer"];
  edit(s);
  fs.mkdirSync(path.join(s.unitsDir, "factory-driver.service.d"), { recursive: true });
  s.olds = { "factory-driver.service": "[Service]\nExecStart=/old/driver\n", "factory-driver.timer": "[Timer]\nOLD\n", "factory-driver.service.d/keeper.conf": "[Unit]\nOnSuccess=old\n" };
  for (const [n, t] of Object.entries(s.olds)) fs.writeFileSync(path.join(s.unitsDir, n), t);
  for (const n of ["auto-stage.timer", "auto-stage.service", "old-trust.timer"]) fs.writeFileSync(path.join(s.unitsDir, n), "[Unit]\n");
  return s;
}
const switchOf = s => stop(() => installDriver({ source, settingsDir: s.settingsDir, switchOver: true, deps: s.deps }));
const unitsAsBefore = s => { for (const [n, t] of Object.entries(s.olds)) assert.equal(fs.readFileSync(path.join(s.unitsDir, n), "utf8"), t, `${n} is back as it was`); };

test("a first round that fails, or ends with no fresh status.json, puts the previous unit files back, starts the old timers that were running again, disables nothing, and says the round's error in one sentence", async () => {
  for (const round of ["fail", "nostatus"]) {
    const s = oldServer(x => { x.round = round; x.journal = "Error: the world could not be read: gh is not signed in\n"; });
    // the status file of an earlier round is not a sign that this one worked
    fs.mkdirSync(s.files.d.server.state_dir, { recursive: true });
    const status = path.join(s.files.d.server.state_dir, "status.json"); fs.writeFileSync(status, JSON.stringify({ at: new Date(Date.now() - 3600000).toISOString() }));
    const m = await switchOf(s);
    assert.match(m, /^The switch did not happen: /, round);
    assert.match(m, round === "fail" ? /gh is not signed in/ : /without writing a fresh status\.json/, "the round's error, in the sentence");
    assert.ok(!m.includes("\n"), "one paragraph");
    assert.match(m, /What is back: .*the previous unit files are back.*the old timers run again \(auto-stage\.timer, old-trust\.timer\)/);
    assert.match(m, /Everything that was changed is back\./);
    unitsAsBefore(s);
    for (const n of ["factory-deadman.service", "factory-deadman.timer", "factory-driver-keeper.service", "factory-driver-rollback.service", "factory-driver-repair.service"]) assert.equal(fs.existsSync(path.join(s.unitsDir, n)), false, `${n} did not exist before: it is gone again`);
    assert.ok(!s.calls.some(c => /\bdisable\b/.test(c)), "no old unit was disabled");
    assert.ok(!s.calls.some(c => /enable --now/.test(c)), "no timer was turned on");
    const i = s.calls.indexOf("systemctl start factory-driver.service");
    assert.ok(s.calls.indexOf("systemctl stop factory-driver.service", i) > i, "the round's unit is stopped first");
    assert.ok(s.calls.indexOf("systemctl daemon-reload", s.calls.indexOf("systemctl stop factory-driver.service", i)) > 0, "then systemd reads the previous units again");
  }
});

test("a failed switch stops the forge-step-* units the round launched before the old timers start again", async () => {
  const s = oldServer(x => { x.round = "fail"; x.stepUnits = ["forge-step-stage-1.service", "forge-step-ship-2.service"]; });
  const m = await switchOf(s);
  assert.match(m, /the round's step units are stopped \(forge-step-stage-1\.service, forge-step-ship-2\.service\)/);
  assert.deepEqual(s.stepUnits, [], "no step unit is left running");
  const lastStep = s.calls.lastIndexOf("systemctl stop forge-step-ship-2.service");
  assert.ok(lastStep > 0 && lastStep < s.calls.indexOf("systemctl start auto-stage.timer") && lastStep < s.calls.indexOf("systemctl start old-trust.timer"), "step units stop first, then the old timers start");
  assert.match(m, /Everything that was changed is back\./);
});

test("a timer that will not stop, or is still running afterwards, stops the switch before any round: the units are put back and what was stopped runs again", async () => {
  for (const how of ["stopFail", "stopIgnored"]) {
    const s = oldServer(x => { x[how] = ["auto-stage.timer"]; });
    const m = await switchOf(s);
    assert.match(m, /^The switch did not happen: the old timer could not be stopped, so the first round was not started: auto-stage\.timer/, how);
    assert.match(m, how === "stopFail" ? /Failed to stop auto-stage\.timer/ : /it is still running/);
    assert.ok(!s.calls.includes("systemctl start factory-driver.service"), "no round was started beside a running old timer");
    assert.ok(s.calls.includes("systemctl start old-trust.timer"), "the one that did stop runs again");
    assert.ok(!s.calls.includes("systemctl start auto-stage.timer"), "the one that never stopped is not started a second time");
    assert.match(m, /the old timers run again \(old-trust\.timer\)/);
    unitsAsBefore(s);
    assert.ok(!s.calls.some(c => /\bdisable\b|enable --now/.test(c)));
  }
});

test("the round must have ended well: its unit's Result is success, its status.json says it was written after the round started, and a round that hangs is stopped before anything is put back", async () => {
  const bad = oldServer(x => { x.result = "exit-code"; x.journal = "boom\n"; });
  const m = await switchOf(bad);
  assert.match(m, /did not end well \(Result=exit-code, ExecMainStatus=1\): boom/);
  unitsAsBefore(bad);
  // a status file written before the round began, even a moment before, is not this round's
  const stale = oldServer(x => { x.round = "nostatus"; });
  fs.mkdirSync(stale.files.d.server.state_dir, { recursive: true });
  fs.writeFileSync(path.join(stale.files.d.server.state_dir, "status.json"), JSON.stringify({ at: new Date(Date.now() - 1000).toISOString() }));
  assert.match(await switchOf(stale), /without writing a fresh status\.json/, "one second old is old");
  const hang = oldServer(x => { x.round = "hang"; x.journal = "still going\n"; });
  const h = await switchOf(hang);
  assert.match(h, /the first round did not finish within its limit: still going/);
  const i = hang.calls.indexOf("systemctl start factory-driver.service");
  assert.ok(hang.calls.indexOf("systemctl stop factory-driver.service") > i && hang.calls.indexOf("systemctl stop factory-driver.service") < hang.calls.indexOf("systemctl daemon-reload", i), "the hanging round is stopped first, then the units go back");
  const nostop = oldServer(x => { x.round = "hang"; x.stopRoundFail = true; });
  assert.match(await switchOf(nostop), /and the round's unit could not be stopped: Failed to stop factory-driver\.service/);
});

test("what could not be put back is said, and the old timers are never claimed to run when their restart failed", async () => {
  const s = oldServer(x => { x.round = "fail"; x.startFail = ["auto-stage.timer"]; });
  const m = await switchOf(s);
  assert.match(m, /What is NOT back: these old timers could not be started again: auto-stage\.timer\./);
  assert.match(m, /the old timers run again \(old-trust\.timer\)/, "only the one that did start is said to run");
  assert.ok(!/run again \([^)]*auto-stage/.test(m));
  assert.ok(!/Everything that was changed is back/.test(m));
  assert.match(m, /Fix that by hand/);
  // the units themselves cannot be written back
  const t = oldServer(x => { x.round = "fail"; });
  const real = fs.writeFileSync; fs.writeFileSync = (f, ...a) => { if (/factory-driver\.timer$/.test(String(f)) && /OLD/.test(String(a[0]))) throw new Error("read-only file system"); return real(f, ...a); };
  let m2; try { m2 = await switchOf(t); } finally { fs.writeFileSync = real; }
  assert.match(m2, /What is NOT back: the previous unit files could not be put back \(read-only file system\)/);
  assert.ok(!/previous unit files are back/.test(m2));
  assert.match(m2, /the old timers run again/, "the old timers are still started: they are what keeps a driver running");
  // systemd does not reload
  const u = oldServer(x => { x.round = "fail"; });
  const run = u.deps.run; let n = 0; u.deps.run = (c, a) => { if (c === "systemctl" && a[0] === "daemon-reload" && ++n === 2) { u.calls.push("systemctl daemon-reload"); return { status: 1, stdout: "", stderr: "Failed to reload" }; } return run(c, a); };
  assert.match(await switchOf(u), /What is NOT back: .*systemd did not reload its units \(Failed to reload\)/);
});

test("after a good round every enable and every disable is looked at: a timer that will not turn on gives the old program back; an old unit that will not turn off is named, and the new timers stay on", async () => {
  const s = oldServer(x => { x.enableFail = ["factory-deadman.timer"]; });
  const m = await switchOf(s);
  assert.match(m, /^The switch did not complete: factory-deadman\.timer could not be turned on \(Failed to enable factory-deadman\.timer\), so the old program is given back\./);
  assert.match(m, /the old units turned off are on again \(auto-stage\.timer, auto-stage\.service, old-trust\.timer\)/);
  assert.match(m, /the old timers run again \(auto-stage\.timer, old-trust\.timer\)/);
  for (const n of ["auto-stage.timer", "auto-stage.service", "old-trust.timer"]) assert.ok(s.calls.includes(`systemctl enable ${n}`), `${n} is turned on again`);
  unitsAsBefore(s);
  const t = oldServer(x => { x.disableFail = ["auto-stage.service"]; });
  const m2 = await switchOf(t);
  assert.match(m2, /these old units could not be turned off: auto-stage\.service \(Failed to disable unit: Access denied\)/);
  assert.match(m2, /stay stopped/);
  assert.ok(t.calls.includes("systemctl enable --now factory-driver.timer") && t.calls.includes("systemctl enable --now factory-deadman.timer"), "the new timers stay on");
  assert.ok(!t.calls.includes("systemctl start auto-stage.timer") && !t.calls.includes("systemctl start old-trust.timer"), "the old timers are not started again: the driver has taken over");
  for (const n of Object.keys(t.olds)) assert.notEqual(fs.readFileSync(path.join(t.unitsDir, n), "utf8"), t.olds[n], "the new units stay");
  // a unit that is not there at all is not a failure to turn it off
  const ok = oldServer(x => { x.disableNotFound = ["old-trust.timer"]; });
  const lines = await installDriver({ source, settingsDir: ok.settingsDir, switchOver: true, deps: ok.deps });
  assert.ok(lines.some(l => /Switched off 2 of the 3 old units/.test(l)), lines.join(" | "));
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
  assert.ok(calls.some(c => c.startsWith("variable set FACTORY_RECORDS_REPO --repo owner/records --body owner/records")), "the records repository is a variable of its own");
  assert.match(store[".github/workflows/factory-watch.yml"], /PRODUCT_RECORDS_REPO: \$\{\{ vars\.FACTORY_RECORDS_REPO/, "the workflow reads the plans from it, not from its own repository");
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
  // the install is told it is not root, so this test never writes the system's folders; what it stops on is said
  const lines = await driverAfterSetup("acme/app", { paths, config, godspeed: null, platform: "linux", uid: 0, systemd: () => true, output: l => said.push(l), install: { deps: { isRoot: () => false, hasSystemd: () => true, unitsDir: path.join(root, "units"), run: () => ({ status: 0, stdout: "", stderr: "" }) } } });
  const project = JSON.parse(fs.readFileSync(path.join(root, "etc", "godspeed-forge", "projects", "acme--app.json"), "utf8"));
  assert.deepEqual([project.repository, project.checkout === checkout, project.apps], ["acme/app", true, { builder: "acme-builder", release: "acme-release" }]);
  const server_ = JSON.parse(fs.readFileSync(path.join(root, "etc", "godspeed-forge", "driver.json"), "utf8"));
  assert.equal(server_.owner.github_login, "acme");
  assert.deepEqual(lines, [], "a stopped install is said, and setup still counts as finished");
  assert.match(said.join(" "), /installed by root/);
  // a new owner's settings name nothing the driver lacks (the App token program is no longer required)
  const found = await discoverSteps(path.join(source, "steps"));
  assert.doesNotThrow(() => loadSettings(path.join(root, "etc", "godspeed-forge"), { steps: found.steps }));
  // what the owner wrote is never written over
  fs.writeFileSync(path.join(root, "etc", "godspeed-forge", "driver.json"), JSON.stringify({ ...server_, owner: { github_login: "kept" } }));
  await driverAfterSetup("acme/app", { paths, config, godspeed: null, platform: "linux", uid: 0, systemd: () => true, output: () => {}, install: { deps: { isRoot: () => true, hasSystemd: () => true, unitsDir: path.join(root, "units"), run: () => ({ status: 0 }) } } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "etc", "godspeed-forge", "driver.json"), "utf8")).owner.github_login, "kept");
});
