// node driver/test/steps/test-test-machine.mjs   (no network, no AI, no browser)
// test cases: 21
import { testCase } from "../../../test/cases.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { asForgeArgv } from "../../steps/test-machine/referee.mjs";
import { stagedRelease, commandOf, verdictOf, judgeHealth, nextState, look, POINTER_MARK, pointerLine, withPointer, toolsIndex, ensureFindable, browserReady, browserInstallScript, scenarioIds, toolCoverage } from "../../steps/test-machine/test-machine.mjs";

const HOUR = 3600 * 1000;
const NOW = Date.parse("2026-11-17T12:00:00Z");
const R = "MichaelZelbel/godspeed-mission-control";

testCase("which release is on the server");
// ---- which release is on the server
const st = (version, status = "installed", commit = "a".repeat(40)) => ({ status, version, productCommit: commit, repository: R });
assert.deepEqual(stagedRelease([{ id: "b24", staging: st("2.0.0-beta.24") }, { id: "b25", staging: st("2.0.0-beta.25", "installed", "b".repeat(40)) }, { id: "b26", staging: st("2.0.0-beta.26", "failed") }], R),
  { id: "b25", version: "2.0.0-beta.25", commit: "b".repeat(40) }, "the newest installed one; a failed install does not count");
assert.equal(stagedRelease([{ id: "x", staging: { ...st("2.0.0-beta.25"), repository: "MichaelZelbel/godspeed-forge" } }], R), null, "another repository's");
assert.equal(stagedRelease([], R), null);

testCase("the holdout's own command");
// ---- the holdout's own command
const TOOL = "# Tool for H-23\n\n## Scenario text\n\nsecret\n\n## Command\n\n    source {tools}/_lib/browser.sh && node {tools}/_lib/aistate.js {id} {target} {out} {target}/.factory/holdout/judges\n\n`{target}` is the checkout.\n\n## Needs\n";
assert.equal(commandOf(TOOL, { id: "H-23", tools: "/t", target: "/c", out: "/o", judges: "/h/judges" }), "source /t/_lib/browser.sh && node /t/_lib/aistate.js H-23 /c /o /h/judges", "the judges beside the hidden scenarios");
assert.equal(commandOf("# no command\n", { id: "H-1", tools: "/t", target: "/c", out: "/o", judges: "/j" }), null);

testCase("verdicts: INCOMPLETE never becomes PASS");
// ---- verdicts: INCOMPLETE never becomes PASS
assert.equal(verdictOf("x\nfinding: y\nverdict: FAIL\n"), "FAIL");
assert.equal(verdictOf("verdict: PASS\n...\nverdict: INCOMPLETE\n"), "INCOMPLETE", "the last verdict line counts");
assert.equal(verdictOf("Error: browser closed\n"), "INCOMPLETE", "no verdict line is INCOMPLETE");
assert.equal(verdictOf("the verdict: PASS would be nice"), "INCOMPLETE", "only a verdict line");
assert.equal(judgeHealth({ smoke: { ok: true }, holdout: { id: "H-23", verdict: "FAIL" } }).healthy, true, "a real FAIL is a working machine");
assert.equal(judgeHealth({ smoke: { ok: true }, holdout: { id: "H-23", verdict: "INCOMPLETE" } }).healthy, false);
assert.equal(judgeHealth({ smoke: { ok: false, error: "EPERM" }, holdout: { id: "H-23", verdict: "PASS" } }).healthy, false, "the browser must stay up");
let s = nextState(null, { healthy: false, why: "w" }, NOW);
assert.equal(s.since, new Date(NOW).toISOString());
assert.equal(nextState(s, { healthy: false, why: "w2" }, NOW + HOUR).since, s.since, "since moves only when health changes");
assert.equal(nextState(s, { healthy: true, why: "ok" }, NOW + HOUR).since, new Date(NOW + HOUR).toISOString());

testCase("whole looks with stand-ins");
// ---- whole looks with stand-ins
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tm-"));
const env = { REPO: R, STATE_DIR: path.join(tmp, "state"), HOLDOUT: "H-23", DRY: false, NOTICES_FILE: path.join(tmp, "notices.json"), FORGE_USER: "f", FORGE_HOME: "/h/f" };
const told = () => (fs.existsSync(env.NOTICES_FILE) ? JSON.parse(fs.readFileSync(env.NOTICES_FILE, "utf8")).notices : []);
const stateNow = () => JSON.parse(fs.readFileSync(path.join(env.STATE_DIR, "state.json"), "utf8"));
const decisions = () => fs.readFileSync(path.join(env.STATE_DIR, "decisions.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const staged = { id: "b25", version: "2.0.0-beta.25", commit: "c".repeat(40) };
let clock = NOW, repairs = 0, observed = [];
const base = { now: () => clock, log: () => {} };
// healthy: state written, no repair
let r = await look(env, { ...base, check: () => ({ staged, target: "/c", smoke: { ok: true, browser: "alive" }, holdout: { id: "H-23", verdict: "FAIL" } }), repair: async () => { repairs++; return {}; } });
assert.ok(r.healthy && repairs === 0);
assert.equal(stateNow().healthy, true); assert.equal(stateNow().release, "2.0.0-beta.25");
testCase("unhealthy: the repair runs on the failed check, then the observations again outside the sandbox");
// unhealthy: the repair runs on the failed check, then the observations again outside the sandbox
clock += HOUR;
let candsSeen = null;
r = await look(env, { ...base, check: () => ({ staged, target: "/c", smoke: { ok: true }, holdout: { id: "H-23", verdict: "INCOMPLETE", last: "verdict: INCOMPLETE" } }),
  repair: async (e, d, w, state, now, ctx) => { repairs++; candsSeen = ctx.cands; return { ran: true, outcome: "applied", observedIds: ["H-31"] }; },
  observe: (id, t) => { observed.push(`${id}@${t}`); return { id, verdict: id === "H-23" ? "PASS" : "INCOMPLETE", last: "verdict" }; }, smoke: () => ({ ok: true }) });
assert.equal(repairs, 1); assert.equal(candsSeen[0].item, 0); assert.deepEqual(candsSeen[0].ids, ["H-23"]);
assert.match(candsSeen[0].evidence[0].body, /INCOMPLETE/);
assert.deepEqual(observed, ["H-23@/c", "H-31@/c"], "the named observations run again on the same checkout");
assert.ok(r.healthy, "healthy again after a repair whose observation came back with a real verdict");
const after = decisions().find(d => d.kind === "observed after the repair");
assert.deepEqual(after.verdicts.map(v => `${v.id}:${v.verdict}`), ["H-23:PASS", "H-31:INCOMPLETE"], "real verdicts recorded; an INCOMPLETE stays INCOMPLETE");
assert.equal(r.halt, undefined, "healthy again: no halt");
testCase("a repair that did not help: a halt for the driver, and nothing told to anybody");
// a repair that did not help: a halt for the driver, and nothing told to anybody
clock += HOUR;
const broken = { ...base, check: () => ({ staged, target: "/c", smoke: { ok: false, error: "browser closed" }, holdout: null }), repair: async () => ({ ran: true, outcome: "rolled back" }) };
r = await look(env, broken);
assert.ok(!r.healthy); assert.equal(stateNow().healthy, false);
assert.equal(r.halt.key, "broken"); assert.match(r.halt.words, /cannot run its hidden checks/);
assert.ok(!/H-\d|#\d/.test(r.halt.words), "no ids in the plain words");
assert.equal(told().length, 0, "a halt queues no notice"); assert.ok(!fs.existsSync(env.NOTICES_FILE));
assert.ok(!decisions().some(d => /told/.test(d.kind)), "nothing is recorded as told");
clock += HOUR;
r = await look(env, { ...broken, repair: async () => ({ ran: false, capped: true, why: "3 repairs in the last 24 hours" }) });
assert.equal(r.halt.key, "broken", "the day's repairs used up: still the same halt"); assert.equal(told().length, 0);
const since = stateNow().since;
clock += HOUR;
await look(env, broken);
assert.equal(stateNow().since, since, "since stays while it stays broken");
testCase("a dry run repairs nothing and writes nothing");
// a dry run repairs nothing and writes nothing
const env2 = { ...env, STATE_DIR: path.join(tmp, "dry"), DRY: true };
let dryRepairs = 0;
await look(env2, { ...base, check: () => ({ staged, smoke: { ok: false, error: "x" }, holdout: null }), repair: async () => { dryRepairs++; return {}; } });
assert.equal(dryRepairs, 0); assert.ok(!fs.existsSync(env2.STATE_DIR));
testCase("a check that throws is unhealthy, not a crash");
// a check that throws is unhealthy, not a crash
const env3 = { ...env, STATE_DIR: path.join(tmp, "s3") };
r = await look(env3, { ...base, check: () => { throw new Error("clone failed"); }, repair: async () => ({ ran: false, why: "none" }) });
assert.equal(r.healthy, false); assert.match(JSON.parse(fs.readFileSync(path.join(env3.STATE_DIR, "state.json"), "utf8")).why, /clone failed/);
testCase("a repair the audit stopped halts every further repair (a halt for the driver) until --clear-halt");
// a repair the audit stopped halts every further repair (a halt for the driver) until --clear-halt
const env4 = { ...env, STATE_DIR: path.join(tmp, "s4"), NOTICES_FILE: path.join(tmp, "n4.json") };
let rep4 = 0;
const bad = { ...base, check: () => ({ staged, target: "/c", smoke: { ok: true }, holdout: { id: "H-23", verdict: "INCOMPLETE" } }), repair: async () => { rep4++; return { ran: true, outcome: "breach", breaches: [{ why: "wrote to the live verifier tools" }] }; } };
r = await look(env4, bad);
assert.ok(JSON.parse(fs.readFileSync(path.join(env4.STATE_DIR, "state.json"), "utf8")).halted);
assert.equal(r.halt.key, "repair-halted"); assert.match(r.halt.words, /stopped itself/); assert.ok(!fs.existsSync(env4.NOTICES_FILE), "a halt queues no notice");
r = await look(env4, bad);
assert.equal(rep4, 1, "halted: no second repair"); assert.equal(r.halt.key, "repair-halted", "the halt holds while it is halted");
await look({ ...env4, CLEAR_HALT: true }, bad);
assert.ok(!JSON.parse(fs.readFileSync(path.join(env4.STATE_DIR, "state.json"), "utf8")).halted, "--clear-halt");

testCase("findable: the tools and the browser where a verifier looks (PR #671: a shallow find, a PATH probe)");
// ---- findable: the tools and the browser where a verifier looks (PR #671: a shallow find, a PATH probe)
assert.equal(commandOf("## Command\n\n`source {tools}/_lib/browser.sh && node {tools}/H-34/run.js H-34 {target} {out} /j`\n\nRecords screenshots.\n", { id: "H-34", tools: "/t", target: "/c", out: "/o", judges: "/j" }),
  "source /t/_lib/browser.sh && node /t/H-34/run.js H-34 /c /o /j", "a command written as one code span (H-34's TOOL.md)");
assert.equal(commandOf("## Command\n\n`{target}` is the checkout under test.\n", { id: "H-1", tools: "/t", target: "/c", out: "/o", judges: "/j" }), null, "a sentence that starts with code is not a command");
const HOLD = "# Holdout scenarios\n\nIntro.\n\n## How these scenarios are run\n\nBlack-box.\n\n## H-01 A title\nSteps: x\n";
const line = pointerLine("/tools");
const withLine = withPointer(HOLD, line);
assert.ok(withLine.indexOf(line) > withLine.indexOf("## How these scenarios are run") && withLine.indexOf(line) < withLine.indexOf("## H-01"), "the line sits in the section on how they are run, outside every scenario");
assert.equal(withLine.replace(`\n\n${line}`, ""), HOLD, "nothing else changes");
assert.equal(withPointer(withLine, line), null, "once");
assert.equal(withPointer(withLine, pointerLine("/other")).split(POINTER_MARK).length, 2, "a stale line is replaced, not added");
assert.match(withPointer("# Holdout scenarios\n\n## H-01 x\n", line), /^# Holdout scenarios\n\nTools and browser/, "no such section: after the title");
assert.match(toolsIndex([{ id: "H-10", command: "c10" }, { id: "H-9", command: null }], "/tools", "/b"), /- H-9: its TOOL.md names no command yet\n- H-10: `c10`/);
testCase("the whole step on a stand-in home: /tmp/hv-pw still a real folder, the home folder not made yet");
// the whole step on a stand-in home: /tmp/hv-pw still a real folder, the home folder not made yet
const fh = fs.mkdtempSync(path.join(os.tmpdir(), "tm-find-"));
const T = path.join(fh, "tools"), S = path.join(fh, "holdouts"), B = path.join(fh, "hv-pw"), HOME = path.join(fh, "home");
const BH = path.join(HOME, ".local", "share", "holdout-browser"), D = path.join(fh, "hv-debs"), DH = path.join(HOME, ".local", "share", "holdout-debs");
const runtime = dir => { for (const d of [path.join(dir, "node_modules", "playwright"), path.join(dir, "browsers", "chromium-1255"), path.join(dir, "browsers", "chromium_headless_shell-1255")]) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(dir, "node_modules", "playwright", "package.json"), "{\"version\":\"1.65.1\"}"); };
for (const d of [path.join(T, "H-23"), path.join(T, "H-34"), path.join(T, "H-31.pre-1"), path.join(T, "_lib"), S, path.join(D, "root"), HOME]) fs.mkdirSync(d, { recursive: true });
runtime(B);
fs.writeFileSync(path.join(T, "H-23", "TOOL.md"), TOOL);
fs.writeFileSync(path.join(T, "H-34", "TOOL.md"), "## Command\n\n`node {tools}/H-34/run.js H-34 {target} {out}`\n");
fs.writeFileSync(path.join(S, "HOLDOUT.md"), HOLD);
const fenv = { TOOLS_DIR: T, SCENARIOS_DIR: S, BROWSER_ROOT: B, BROWSER_HOME: BH, DEBS_ROOT: D, DEBS_HOME: DH, PLAYWRIGHT_VERSION: "1.65.1", FORGE_HOME: HOME, FORGE_UID: 1001, FORGE_GID: 1001 };
// stand-in for the factory user's shell: a copy does what cp -a does, an install makes a runtime
let scripts = [], installWorks = true;
const forge = script => { scripts.push(script); const m = /cp -a '([^']+)'\/\. '([^']+)'\//.exec(script); if (m) { fs.cpSync(m[1], m[2], { recursive: true }); return { status: 0 }; } const h = /cd '([^']+)'/.exec(script); if (installWorks) runtime(h[1]); return installWorks ? { status: 0 } : { status: 1, stderr: "npm ERR! network" }; };
const toolsBefore = fs.readFileSync(path.join(T, "H-23", "TOOL.md"), "utf8");
let f = ensureFindable(fenv, true, { asForge: forge });
assert.ok(f.ok && f.changed.length === 9, `a dry run names nine changes: ${f.changed}`);
assert.ok(!scripts.length && !fs.existsSync(path.join(T, "README.md")) && fs.readFileSync(path.join(S, "HOLDOUT.md"), "utf8") === HOLD && fs.lstatSync(B).isDirectory() && !fs.existsSync(BH), "and makes none");
f = ensureFindable(fenv, false, { asForge: forge });
assert.ok(f.ok, f.why); assert.equal(f.changed.length, 9);
assert.ok(browserReady(BH), "the runtime is in the home folder"); assert.match(scripts[0], /^set -e; cp -a /, "copied from /tmp while that was still a real folder");
assert.ok(fs.lstatSync(B).isSymbolicLink() && browserReady(B), "/tmp/hv-pw is now a link to it");
assert.ok(fs.lstatSync(D).isSymbolicLink() && fs.existsSync(path.join(DH, "root")), "/tmp/hv-debs too");
assert.ok(!fs.readdirSync(fh).some(n => n.includes(".old-")), "the old /tmp folder is gone");
const readme = fs.readFileSync(path.join(T, "README.md"), "utf8");
assert.match(readme, new RegExp(`- H-23: \`source ${T.replace(/\\/g, "\\\\")}/_lib/browser.sh`), "each tool's own command");
assert.match(readme, /- H-34: `node .*H-34\/run.js H-34 \{target\} \{out\}`/); assert.ok(!/H-31\.pre/.test(readme), "an old copy is not a tool");
assert.ok(fs.readFileSync(path.join(S, "HOLDOUT.md"), "utf8").includes(pointerLine(T, ["H-01"])), "the line names the one scenario without a tool");
assert.match(readme, /- H-01: no tool yet/);
assert.ok(fs.existsSync(path.join(HOME, ".node_modules", "playwright")), "Playwright as a global module");
assert.ok(fs.existsSync(path.join(HOME, ".cache", "ms-playwright", "chromium-1255")), "Chromium where Playwright looks by default");
assert.match(fs.readFileSync(path.join(HOME, ".local", "bin", "chromium"), "utf8"), /--no-sandbox/);
assert.equal(fs.readFileSync(path.join(T, "H-23", "TOOL.md"), "utf8"), toolsBefore, "no tool changed");
scripts = [];
assert.deepEqual(ensureFindable(fenv, false, { asForge: forge }).changed, [], "the next look changes nothing"); assert.equal(scripts.length, 0);
testCase("a reboot: /tmp is empty again; the next look makes the links again and installs nothing");
// a reboot: /tmp is empty again; the next look makes the links again and installs nothing
fs.rmSync(B, { recursive: true, force: true }); fs.rmSync(D, { recursive: true, force: true });
f = ensureFindable(fenv, false, { asForge: forge });
assert.deepEqual(f.changed.sort(), [`${B} -> ${BH}`, `${D} -> ${DH}`].sort(), "after a reboot: only the two links"); assert.equal(scripts.length, 0);
assert.ok(browserReady(B));
testCase("the home folder lost too: Playwright at the pinned version, installed fresh, and recorded");
// the home folder lost too: Playwright at the pinned version, installed fresh, and recorded
fs.rmSync(BH, { recursive: true, force: true });
f = ensureFindable(fenv, false, { asForge: forge });
assert.ok(f.ok && f.changed.includes(`${BH} installed (Playwright 1.65.1 and its Chromium)`), f.changed.join());
assert.match(scripts.at(-1), /npm install .*playwright@1\.65\.1\n.*PLAYWRIGHT_BROWSERS_PATH='[^']*holdout-browser'\/browsers \.\/node_modules\/\.bin\/playwright install chromium$/);
assert.ok(browserReady(BH));
testCase("an install that fails: said, and nothing points at nothing");
// an install that fails: said, and nothing points at nothing
fs.rmSync(BH, { recursive: true, force: true }); installWorks = false;
f = ensureFindable(fenv, false, { asForge: forge });
assert.ok(!f.ok && /could not be installed .*network/.test(f.why), f.why);
assert.throws(() => browserInstallScript({ home: "/h", version: "1; rm -rf /" }), /not a Playwright version/);
installWorks = true; ensureFindable(fenv, false, { asForge: forge });
fs.writeFileSync(path.join(HOME, ".local", "bin", "chromium"), "#!/bin/sh\necho mine\n");
assert.match(ensureFindable(fenv, false, { asForge: forge }).why, /someone else's/, "a chromium someone else put there is left alone");
testCase("without a home folder for it (the old setting): the runtime in /tmp is used as it is, or missing is said");
// without a home folder for it (the old setting): the runtime in /tmp is used as it is, or missing is said
const old = { ...fenv, BROWSER_HOME: undefined, DEBS_HOME: undefined, BROWSER_ROOT: path.join(fh, "none") };
f = ensureFindable(old, false, { asForge: forge });
assert.ok(!f.ok && /browser runtime is missing/.test(f.why), "no runtime: said, nothing pointed at nothing");
testCase("a look records what it made findable, and a failure there never stops the check");
// a look records what it made findable, and a failure there never stops the check
const env5 = { ...env, STATE_DIR: path.join(tmp, "s5") };
await look(env5, { ...base, findable: () => ({ ok: true, changed: ["README.md"], left: [] }), check: () => ({ staged, target: "/c", smoke: { ok: true }, holdout: { id: "H-23", verdict: "PASS" } }) });
assert.ok(fs.readFileSync(path.join(env5.STATE_DIR, "decisions.jsonl"), "utf8").includes("made findable"));
r = await look({ ...env, STATE_DIR: path.join(tmp, "s6") }, { ...base, findable: () => { throw new Error("disk full"); }, check: () => ({ staged, target: "/c", smoke: { ok: true }, holdout: { id: "H-23", verdict: "FAIL" } }) });
assert.ok(r.healthy, "the check still ran");

testCase("every hidden scenario has a tool whose command can run (2026-11-18: seven scenarios had none");
// ---- every hidden scenario has a tool whose command can run (2026-11-18: seven scenarios had none
// and the watcher said healthy, because it ran only H-23)
const SCEN = "# Holdout scenarios\n\n```\n## H-01 A short title in the user's words\nSteps: ...\n```\n\n## How these scenarios are run\n\nx\n\n## H-33 First\nx\n\n## H-02 Second\nx\n\n## H-23 Third\nx\n\n## H-35 Fourth\nx\n\n## H-36 Fifth\nx\n\n## H-37 Sixth\nx\n";
assert.deepEqual(scenarioIds(SCEN), ["H-33", "H-02", "H-23", "H-35", "H-36", "H-37"], "every scenario heading, in file order; the example inside the code block is no scenario");
assert.deepEqual(scenarioIds("```text\n~~~\n## H-99 example only\n~~~\n```\n## H-40 real\n"), ["H-40"], "a fence closes only with its own kind of marker");
assert.deepEqual(scenarioIds("~~~~\n## H-98 x\n```\n## H-97 y\n~~~~\n## H-41 z\n"), ["H-41"]);
assert.deepEqual(scenarioIds("~~~text\n~~~not-a-close\n## H-99 example\n~~~\n## H-40 real\n"), ["H-40"], "a closing marker has nothing after it");
assert.deepEqual(scenarioIds("   ## H-41 indented heading\n    ## H-42 a code line\n"), ["H-41"], "a heading may be indented up to three spaces");
const ct = fs.mkdtempSync(path.join(os.tmpdir(), "tm-cover-"));
const CT = path.join(ct, "tools"), CS = path.join(ct, "holdouts");
for (const d of ["H-33", "H-02", "H-23", "H-36", "H-37", "_lib"].map(x => path.join(CT, x)).concat([path.join(CS, "judges")])) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(CS, "HOLDOUT.md"), SCEN);
fs.writeFileSync(path.join(CT, "_lib", "brief.py"), "#"); fs.writeFileSync(path.join(CT, "_lib", "browser.sh"), "#"); fs.writeFileSync(path.join(CT, "_lib", "aistate.js"), "//");
for (const id of ["H-33", "H-02"]) fs.writeFileSync(path.join(CT, id, "TOOL.md"), "## Command\n\n    python3 -I {tools}/_lib/brief.py {id} {target} {out} {judges}\n");
fs.writeFileSync(path.join(CT, "H-23", "TOOL.md"), TOOL);
fs.writeFileSync(path.join(CT, "H-36", "TOOL.md"), "# Tool for H-36\n\nNot written yet.\n");
fs.writeFileSync(path.join(CT, "H-37", "TOOL.md"), "## Command\n\n    source {tools}/_lib/browser.sh && node {tools}/H-37/run.js {target} {out}\n");
const cov = toolCoverage({ TOOLS_DIR: CT, SCENARIOS_DIR: CS });
assert.deepEqual(cov.ids, ["H-33", "H-02", "H-23", "H-35", "H-36", "H-37"]);
assert.deepEqual(cov.missing.map(m => m.id), ["H-35", "H-36", "H-37"], cov.missing.map(m => m.why).join("; "));
assert.match(cov.missing[0].why, /^H-35 has no tool$/);
assert.match(cov.missing[1].why, /^H-36 has no tool: its TOOL\.md names no command$/);
assert.match(cov.missing[2].why, /^H-37 has no tool: its command names .*H-37[\\/]run\.js, which is not there$/);
fs.writeFileSync(path.join(CT, "H-37", "run.js"), "//");
assert.deepEqual(toolCoverage({ TOOLS_DIR: CT, SCENARIOS_DIR: CS }).missing.map(m => m.id), ["H-35", "H-36"], "a command whose files are there runs");
assert.deepEqual(toolCoverage({ TOOLS_DIR: CT, SCENARIOS_DIR: path.join(ct, "none") }), { ids: [], missing: [], why: "no hidden scenario file", failed: true }, "no scenario file: the check failed");
assert.equal(toolCoverage({ TOOLS_DIR: CT }).failed, undefined, "no scenario folder set (a stand-in setup): nothing to judge");
assert.match(judgeHealth({ smoke: { ok: true }, holdout: { id: "H-23", verdict: "PASS" }, coverage: { ids: [], missing: [], why: "EACCES", failed: true } }).why, /could not be checked \(EACCES\)/, "a check that could not be made is no proof");
const env8 = { ...env, STATE_DIR: path.join(tmp, "s8"), NOTICES_FILE: path.join(tmp, "n8.json") };
r = await look(env8, { ...base, coverage: () => { throw new Error("EACCES"); }, check: () => ({ staged, target: "/c", smoke: { ok: true }, holdout: { id: "H-23", verdict: "PASS" } }), repair: async () => { throw new Error("no repair"); } });
assert.equal(r.healthy, false);
// Michael cannot act on it: the factory driver reads the tools itself, so nothing goes to him (2026-11-18 19:25)
assert.equal(fs.existsSync(env8.NOTICES_FILE), false, "no notice to Michael when the tools could not be checked");
const log8 = fs.readFileSync(path.join(env8.STATE_DIR, "decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(e => e.kind === "tools missing");
assert.equal(log8.length, 1); assert.match(log8[0].why, /cannot tell which hidden checks/);
testCase("the health: a working browser and a real H-23 verdict are not enough while a scenario has no tool");
// the health: a working browser and a real H-23 verdict are not enough while a scenario has no tool
const hv = judgeHealth({ smoke: { ok: true }, holdout: { id: "H-23", verdict: "FAIL" }, coverage: cov });
assert.equal(hv.healthy, false); assert.equal(hv.tools, true);
assert.match(hv.why, /^H-35 has no tool; H-36 has no tool: its TOOL\.md names no command; H-37 has no tool: its command names /);
assert.equal(judgeHealth({ smoke: { ok: true }, holdout: { id: "H-23", verdict: "PASS" }, coverage: { ids: ["H-23"], missing: [] } }).healthy, true);
assert.match(judgeHealth({ smoke: { ok: false, error: "EPERM" }, holdout: null, coverage: cov }).why, /browser/, "a broken browser is said first: the repair is for it");
assert.match(judgeHealth({ smoke: { ok: false, error: "EPERM" }, holdout: null, coverage: cov }).why, /; also H-35 has no tool; H-36 has no tool/, "and the missing tools are said with it");
assert.ok(!judgeHealth({ smoke: { ok: false, error: "EPERM" }, holdout: null, coverage: cov }).tools, "the environment repair still runs for the browser");
testCase("a look: unhealthy, said in state.json, no environment repair for a missing tool, and nothing to Michael");
// a look: unhealthy, said in state.json, no environment repair for a missing tool, and nothing to Michael:
// the factory driver builds the tool itself (its tools-missing obstacle), so it is logged once, never sent
// (one reached him at 19:07 on 2026-11-18 for H-41 to H-43, a message he could not act on)
const env7 = { ...env, STATE_DIR: path.join(tmp, "s7"), NOTICES_FILE: path.join(tmp, "n7.json") };
let rep7 = 0;
const noTool = { ...base, coverage: () => cov, check: () => ({ staged, target: "/c", smoke: { ok: true }, holdout: { id: "H-23", verdict: "FAIL" } }), repair: async () => { rep7++; return { ran: true, outcome: "applied" }; } };
r = await look(env7, noTool);
const s7 = JSON.parse(fs.readFileSync(path.join(env7.STATE_DIR, "state.json"), "utf8"));
assert.equal(r.healthy, false); assert.equal(s7.healthy, false); assert.match(s7.why, /^H-35 has no tool/);
assert.deepEqual(s7.tools.missing, ["H-35", "H-36", "H-37"]); assert.equal(s7.tools.scenarios, 6);
assert.equal(rep7, 0, "a missing tool is no fault of the environment: the environment repair does not run");
assert.equal(fs.existsSync(env7.NOTICES_FILE), false, "no notice to Michael for a missing tool");
const toolsLog7 = () => fs.readFileSync(path.join(env7.STATE_DIR, "decisions.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(e => e.kind === "tools missing");
assert.equal(toolsLog7().length, 1); assert.deepEqual(toolsLog7()[0].missing, ["H-35", "H-36", "H-37"]);
clock += HOUR; await look(env7, noTool);
assert.equal(toolsLog7().length, 1, "logged once per episode");
assert.equal(fs.existsSync(env7.NOTICES_FILE), false, "still nothing to Michael");
clock += HOUR; r = await look(env7, { ...noTool, coverage: () => ({ ids: cov.ids, missing: [] }) });
assert.ok(r.healthy, "healthy again once every scenario has its tool");
testCase("the list at the top of the tools folder names a scenario without a tool, and the line in the");
// the list at the top of the tools folder names a scenario without a tool, and the line in the
// scenario file says which have none instead of claiming every one has
assert.match(toolsIndex([{ id: "H-23", command: "c" }], "/tools", "/b", ["H-35"]), /- H-23: `c`\n- H-35: no tool yet/);
assert.match(pointerLine("/tools", ["H-35", "H-36"]), /^Tools and browser for the verifier: every scenario here has a tool in \/tools\/<id>\/ except H-35 and H-36, which have none yet \(/);
assert.match(pointerLine("/tools", []), /every scenario here already has a tool in \/tools\/<id>\//);
const fenvC = { TOOLS_DIR: CT, SCENARIOS_DIR: CS, BROWSER_ROOT: B, BROWSER_HOME: BH, PLAYWRIGHT_VERSION: "1.65.1" };
installWorks = true; f = ensureFindable(fenvC, false, { asForge: forge });
assert.ok(f.ok, f.why);
assert.match(fs.readFileSync(path.join(CT, "README.md"), "utf8"), /- H-35: no tool yet/);
assert.ok(fs.readFileSync(path.join(CS, "HOLDOUT.md"), "utf8").includes("except H-35 and H-36, which have none yet"), "the line is true");
fs.rmSync(ct, { recursive: true, force: true });
fs.rmSync(fh, { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
testCase("the factory account's own network namespace: inside it once it exists, plain runuser before");
// ---- the factory account's own network namespace: inside it once it exists, plain runuser before
assert.deepEqual(asForgeArgv({ NETNS: "factory-ns" }, ["-u", "f", "--", "true"], () => true), ["ip", ["netns", "exec", "factory-ns", "runuser", "-u", "f", "--", "true"]]);
assert.deepEqual(asForgeArgv({}, ["-u", "f"], () => true), ["runuser", ["-u", "f"]], "none set: no namespace, whatever exists");
assert.deepEqual(asForgeArgv({ NETNS: "factory-ns" }, ["-u", "f"], () => false), ["runuser", ["-u", "f"]], "no namespace yet");
assert.deepEqual(asForgeArgv({ NETNS: "" }, ["-u", "f"], () => true), ["runuser", ["-u", "f"]], "turned off");

