// node --test scripts/factory-driver/test-keeper.mjs   (offline: systemctl, the AI and Michael's queue are stand-ins)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keeperDefaults, listSet, manifestOf, snapshot, restore, beforeInstall, installed, clean, failed, repair, health, readKeeper, stuckReleases } from "../keeper.mjs";

const T0 = Date.parse("2026-11-18T18:00:00Z");
const MIN = 60000;
const SET_A = {
  "fd/driver.mjs": "export const a = 1;\n",
  "fd/world.mjs": "export const w = 'A';\n",
  "fd/helpers/ops.md": "# Ops\nversion A\n",
  "rd/release-driver.mjs": "export const r = 1;\n",
  "units/factory-driver.service": "[Service]\nExecStart=/usr/local/bin/node driver.mjs\n",
  "units/factory-driver.timer": "[Timer]\nOnCalendar=*:0/5\n",
};

function fixture(files = SET_A) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-keeper-"));
  const env = keeperDefaults({ FD_KEEPER_HOME: path.join(root, "keeper"), FD_STATE_DIR: path.join(root, "state"), FD_LIB: path.join(root, "fd"), FD_RD_LIB: path.join(root, "rd"), FD_UNITS_DIR: path.join(root, "units") });
  fs.mkdirSync(env.STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(root, "units"), { recursive: true });
  fs.writeFileSync(path.join(root, "units", "godspeed-forge-web.service"), "not part of the set\n");
  writeSet(env, files);
  let now = T0;
  const calls = [], told = [], records = () => { try { return fs.readFileSync(path.join(env.STATE_DIR, "decisions.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const sys = { timer: "active", service: "inactive", result: "success" };
  const deps = {
    now: () => now,
    sleep: async () => {},
    sleepSync: () => {},
    run: argv => {
      calls.push(argv.join(" "));
      const a = argv.join(" ");
      if (/is-active factory-driver\.timer/.test(a)) return { status: sys.timer === "active" ? 0 : 3, stdout: `${sys.timer}\n`, stderr: "" };
      if (/show factory-driver\.service -p ActiveState --value/.test(a)) return { status: 0, stdout: `${sys.service}\n`, stderr: "" };
      if (/show factory-driver\.service -p Result --value/.test(a)) return { status: 0, stdout: `${sys.result}\n`, stderr: "" };
      if (/enable --now factory-driver\.timer/.test(a)) sys.timer = "active";
      if (/reset-failed factory-driver\.service/.test(a)) sys.service = "inactive";
      if (/^journalctl/.test(a)) return { status: 0, stdout: "2026-11-18T19:00:01+01:00 godspeed-archon node[1]: TypeError: x is not a function\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    tell: (env2, k, key, text) => { k.told ||= {}; if (k.told[key]) return false; k.told[key] = true; told.push(text); return true; },
    alive: () => false,
    cmdline: () => "",
  };
  const round = async ok => { // one round of the driver: a clean one writes the heartbeat, then its OnSuccess/OnFailure unit runs
    now += 5 * MIN;
    if (ok) { fs.writeFileSync(path.join(env.STATE_DIR, "heartbeat"), `${new Date(now).toISOString()}\n`); return clean(env, deps); }
    return failed(env, deps);
  };
  return { root, env, deps, calls, told, records, sys, round, advance: ms => { now += ms; }, at: () => now };
}
function writeSet(env, files) {
  for (const [k, text] of Object.entries(files)) {
    const [root, ...rest] = k.split("/");
    const base = { fd: env.ROOTS.fd, rd: env.ROOTS.rd, units: env.ROOTS.units }[root];
    const f = path.join(base, ...rest);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
}
const liveTexts = env => Object.fromEntries(Object.entries(listSet(env)).map(([k, f]) => [k, fs.readFileSync(f, "utf8")]));
// install.sh's order: the keeper saves what is installed, the new files are copied, the keeper records them
const install = (fx, files, remove = []) => {
  beforeInstall(fx.env, fx.deps);
  for (const k of remove) fs.rmSync(listSet(fx.env)[k]);
  writeSet(fx.env, files);
  return installed(fx.env, fx.deps);
};

test("the set is the driver's files, its release-driver modules and its two units, nothing else", async () => {
  const fx = fixture();
  assert.deepEqual(Object.keys(listSet(fx.env)).sort(), Object.keys(SET_A).sort());
  const m = manifestOf(fx.env);
  assert.match(m.id, /^[0-9a-f]{16}$/);
  writeSet(fx.env, { "fd/world.mjs": "export const w = 'B';\n" });
  assert.notEqual(manifestOf(fx.env).id, m.id, "one changed byte is another set");
});

test("a snapshot restores byte-identical files, removes what the newer set added and reloads systemd", async () => {
  const fx = fixture({ ...SET_A, "fd/blob.bin": "\u0000ÿ\r\n binary-ish \u0001" });
  const before = liveTexts(fx.env);
  const saved = snapshot(fx.env, path.join(fx.env.HOME_DIR, "last-good"));
  writeSet(fx.env, { "fd/driver.mjs": "export const a = 2; // broken\n", "fd/causes.mjs": "new in the newer set\n" });
  fs.rmSync(listSet(fx.env)["fd/helpers/ops.md"]);
  const r = restore(fx.env, path.join(fx.env.HOME_DIR, "last-good"), fx.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(liveTexts(fx.env), before);
  for (const [k, f] of Object.entries(listSet(fx.env))) assert.ok(fs.readFileSync(f).equals(fs.readFileSync(path.join(fx.env.HOME_DIR, "last-good", "files", k))), `${k} byte-identical`);
  assert.equal(manifestOf(fx.env).id, saved.id);
  assert.deepEqual(r.removed, ["fd/causes.mjs"]);
  assert.ok(fx.calls.includes("systemctl daemon-reload"));
  assert.ok(fs.existsSync(path.join(fx.root, "units", "godspeed-forge-web.service")), "a unit outside the set is never touched");
});

test("a set is marked last-good after its first 3 clean rounds; a round that wrote no heartbeat does not count", async () => {
  const fx = fixture();
  install(fx, {});
  await fx.round(true); await fx.round(true);
  // a round that found another one still going ends cleanly but writes no heartbeat
  fx.advance(5 * MIN); clean(fx.env, fx.deps);
  assert.equal(readKeeper(fx.env).current.cleanRounds, 2);
  assert.equal(readKeeper(fx.env).lastGood, undefined);
  await fx.round(true);
  const k = readKeeper(fx.env);
  assert.equal(k.current.cleanRounds, 3);
  assert.equal(k.lastGood.id, manifestOf(fx.env).id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fx.env.HOME_DIR, "last-good", "manifest.json"), "utf8")).id, k.lastGood.id);
  assert.ok(fx.records().some(r => r.kind === "keeper: marked the installed set last-good"));
});

test("2 failed rounds in a row on a set younger than its last-good put last-good back, byte for byte, and tell Michael once", async () => {
  const fx = fixture();
  install(fx, {});
  for (let i = 0; i < 3; i++) await fx.round(true);
  const good = liveTexts(fx.env);
  const goodId = manifestOf(fx.env).id;
  install(fx, { "fd/driver.mjs": "throw new Error('broken');\n", "fd/causes.mjs": "new\n" });
  const bad = manifestOf(fx.env).id;
  assert.equal(fs.existsSync(path.join(fx.env.HOME_DIR, "previous", "manifest.json")), true, "install.sh keeps the set it replaced");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fx.env.HOME_DIR, "previous", "manifest.json"), "utf8")).id, goodId);
  // a clean round between failures starts the count again
  await fx.round(false); await fx.round(true); await fx.round(false);
  assert.equal(manifestOf(fx.env).id, bad, "one failure at a time rolls nothing back");
  const r = await fx.round(false);
  assert.equal(r.rolledBack, true);
  assert.deepEqual(liveTexts(fx.env), good);
  assert.equal(manifestOf(fx.env).id, goodId);
  const k = readKeeper(fx.env);
  assert.equal(k.current.id, goodId);
  assert.equal(k.failedInRow, 0);
  assert.equal(k.rollbacks.at(-1).from, bad);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fx.env.HOME_DIR, "rolled-back", "manifest.json"), "utf8")).id, bad, "the set taken out is kept for a look");
  assert.equal(fx.told.length, 1);
  assert.doesNotMatch(fx.told[0], /[—–]/);
  assert.equal(fx.told[0].split(/[.!?](\s|$)/).filter(s => s && s.trim()).length, 1, "one sentence");
  assert.ok(fx.records().some(x => x.kind === "keeper: rolled back" && x.from === bad && x.to === goodId));
  // the round lock was taken and given back
  assert.equal(fs.existsSync(path.join(fx.env.STATE_DIR, "round.lock")), false);
  // and it stays put: three more failures on last-good itself change nothing
  await fx.round(false); await fx.round(false); await fx.round(false);
  assert.equal(fx.told.length, 1);
  assert.equal(readKeeper(fx.env).rollbacks.length, 1);
});

test("failing rounds with no last-good, or on last-good itself, roll nothing back", async () => {
  const fx = fixture();
  install(fx, {});
  for (let i = 0; i < 5; i++) await fx.round(false);
  assert.equal(readKeeper(fx.env).failedInRow, 5);
  assert.deepEqual(fx.told, []);
  assert.equal(fs.existsSync(path.join(fx.env.HOME_DIR, "rolled-back")), false);
});

test("a rollback waits for a round that holds the lock and takes over the lock of a dead one", async () => {
  const fx = fixture();
  install(fx, {});
  for (let i = 0; i < 3; i++) await fx.round(true);
  install(fx, { "fd/driver.mjs": "broken\n" });
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "round.lock"), JSON.stringify({ pid: 999999, at: "x" }));
  let checks = 0;
  fx.deps.alive = pid => pid === 999999 && ++checks < 2; // the round ends after one look
  await fx.round(false);
  const r = await fx.round(false);
  assert.equal(r.rolledBack, true);
  assert.ok(checks >= 2);
  assert.equal(fs.existsSync(path.join(fx.env.STATE_DIR, "round.lock")), false);
});

test("reinstalling the same files keeps the count; the first install seeds last-good from the set that ran clean before the keeper", async () => {
  const fx = fixture();
  // Phase 1: the driver ran for hours without the keeper; its last round was clean
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "heartbeat"), `${new Date(T0 - 2 * MIN).toISOString()}\n`);
  const phase1 = manifestOf(fx.env).id;
  install(fx, { "fd/keeperhook.mjs": "new\n" });
  let k = readKeeper(fx.env);
  assert.equal(k.lastGood.id, phase1, "the set that ran clean is last-good");
  assert.match(k.lastGood.why, /ran clean/);
  assert.notEqual(k.current.id, phase1);
  await fx.round(true);
  install(fx, {}); // the same files again
  k = readKeeper(fx.env);
  assert.equal(k.current.cleanRounds, 1, "the count goes on");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fx.env.HOME_DIR, "previous", "manifest.json"), "utf8")).id, phase1, "previous is still the set before");
  // a set that was failing is never seeded
  const fx2 = fixture();
  fx2.sys.result = "exit-code";
  fs.writeFileSync(path.join(fx2.env.STATE_DIR, "heartbeat"), `${new Date(T0 - 2 * MIN).toISOString()}\n`);
  install(fx2, { "fd/x.mjs": "x\n" });
  assert.equal(readKeeper(fx2.env).lastGood, undefined);
});

// ---------------------------------------------------------------- repair
function healthyState(fx, { releases = ["godspeed-2.0.0-beta.29-every-lane-busy"], milestoneAgoH = 1, installedRelease = false } = {}) {
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "heartbeat"), `${new Date(fx.at() - 3 * MIN).toISOString()}\n`);
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "state.json"), JSON.stringify({ releases, superseded: { "godspeed-2.0.0-beta.27-sees-it-through": "x" } }));
  const ms = new Date(fx.at() - milestoneAgoH * 3600000).toISOString();
  const ledger = {};
  for (const id of [...releases, "godspeed-2.0.0-beta.27-sees-it-through"]) for (const n of [1, 2]) ledger[`${id}#${n}`] = { firstSeenAt: ms, lastMilestoneAt: ms, milestones: installedRelease ? [{ kind: "staged" }, { kind: "installed" }] : [{ kind: "pr-merged", at: ms }] };
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "ledger.json"), JSON.stringify(ledger));
}
const writes = calls => calls.filter(c => /^systemctl (enable|start|stop|restart|reset-failed|daemon-reload)/.test(c));

test("repair leaves a healthy driver exactly as it is", async () => {
  const fx = fixture();
  install(fx, {});
  healthyState(fx);
  const launched = [];
  fx.deps.launch = async (e, x) => { launched.push(x); return { unit: x.unit }; };
  fx.calls.length = 0;
  const r = await repair(fx.env, fx.deps);
  assert.equal(r.healthy, true);
  assert.deepEqual(r.changed, []);
  assert.deepEqual(writes(fx.calls), []);
  assert.deepEqual(launched, []);
  assert.ok(fx.records().some(x => x.kind === "keeper: repair asked" && /healthy; nothing changed/.test(x.result)));
});

test("an installed release, a superseded one or a fresh milestone is never stuck; six hours without one is", async () => {
  const fx = fixture();
  healthyState(fx, { milestoneAgoH: 7, installedRelease: true });
  assert.deepEqual(stuckReleases(fx.env, fx.at()), []);
  healthyState(fx, { milestoneAgoH: 5 });
  assert.deepEqual(stuckReleases(fx.env, fx.at()), []);
  healthyState(fx, { milestoneAgoH: 7 });
  assert.deepEqual(stuckReleases(fx.env, fx.at()).map(r => r.id), ["godspeed-2.0.0-beta.29-every-lane-busy"]);
  assert.equal(health(fx.env, fx.deps).healthy, false);
});

test("repair starts a stopped timer and a round; a helper goes only when that did not help, at most one an hour", async () => {
  const fx = fixture();
  install(fx, {});
  healthyState(fx);
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "heartbeat"), `${new Date(fx.at() - 40 * MIN).toISOString()}\n`);
  fx.sys.timer = "inactive";
  const launched = [];
  fx.deps.launch = async (e, x) => { launched.push(x); return { unit: x.unit }; };
  fx.deps.result = () => ({ state: "done", report: { fixed: true, summary: "the timer was stopped by hand", cause: "external" } });
  // the round it starts is clean
  const run = fx.deps.run;
  fx.deps.run = argv => { const r = run(argv); if (argv.join(" ") === "systemctl start factory-driver.service") fs.writeFileSync(path.join(fx.env.STATE_DIR, "heartbeat"), `${new Date(fx.at()).toISOString()}\n`); return r; };
  const r = await repair(fx.env, fx.deps);
  assert.deepEqual(r.changed, ["started factory-driver.timer again"]);
  assert.equal(r.healthy, true);
  assert.deepEqual(launched, []);
  assert.ok(fx.calls.includes("systemctl enable --now factory-driver.timer"));
  // now the rounds keep failing: the round it starts writes nothing
  fx.deps.run = run;
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "heartbeat"), `${new Date(fx.at() - 40 * MIN).toISOString()}\n`);
  fx.sys.service = "failed";
  const r2 = await repair(fx.env, fx.deps);
  assert.deepEqual(r2.changed, ["cleared the driver's failed state"]);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].kind, "ops");
  assert.match(launched[0].unit, /^factory-helper-driverrepair-1$/);
  assert.match(launched[0].context.EVIDENCE, /TypeError: x is not a function/, "the driver's journal is in the helper's evidence");
  assert.match(launched[0].context.APPROACH_NOTE, /factory user/);
  assert.equal(r2.helper.report.summary, "the timer was stopped by hand");
  // a second call within the hour sends nobody
  fx.advance(20 * MIN);
  const r3 = await repair(fx.env, fx.deps);
  assert.equal(launched.length, 1);
  assert.match(r3.why, /less than an hour ago/);
});

test("repair removes a round lock held by a process that is not a round; a hold file stops everything", async () => {
  const fx = fixture();
  install(fx, {});
  healthyState(fx);
  fs.writeFileSync(path.join(fx.env.STATE_DIR, "round.lock"), JSON.stringify({ pid: 4242, at: "x" }));
  fx.deps.alive = pid => pid === 4242;
  fx.deps.cmdline = () => "/usr/sbin/cron -f"; // the number was reused after a killed round
  fx.deps.launch = async () => { throw new Error("no helper needed"); };
  const r = await repair(fx.env, fx.deps);
  assert.deepEqual(r.changed, ["removed a round lock held by process 4242, which is not a round"]);
  assert.equal(fs.existsSync(path.join(fx.env.STATE_DIR, "round.lock")), false);
  // a person stopped the driver on purpose
  fs.writeFileSync(path.join(fx.env.HOME_DIR, "HOLD"), "stopped by a session for maintenance\n");
  fx.sys.timer = "inactive";
  fx.calls.length = 0;
  const r2 = await repair(fx.env, fx.deps);
  assert.match(r2.why, /held: stopped by a session/);
  assert.deepEqual(writes(fx.calls), []);
});
