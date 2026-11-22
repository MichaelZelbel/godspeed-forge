// node driver/test/steps/test-referee.mjs   (no network, no AI, no root): the referee repair's whole flow
// test cases: 18
import { testCase } from "../../../test/cases.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { repairLook, copyEvidence, auditRepair } from "../../steps/test-machine/referee.mjs";
process.env.FD_TRUSTED_LOGINS = "boss,godspeed-dev-builder[bot]"; process.env.FD_OWNER_LOGIN = "boss"; // who may decide comes from the settings

const HOUR = 3600 * 1000, NOW = Date.parse("2026-11-15T20:00:00Z");
const bot = { login: "godspeed-dev-builder", __typename: "Bot" };
const TRIAGE = "The pipeline did not retry those observations because the prerequisite verifier work remains open in #652. Its latest recorded blocker is the fenced app-check host's missing `libnspr4.so`, so it cannot yet produce completed browser observations of H-19 and H-20.";
const world = () => ({ items: [{ number: 583, title: "chat state", url: "u583", state: "OPEN", body: "b", comments: [{ createdAt: "2026-11-15T15:54:00Z", url: "c1", author: bot, body: TRIAGE }], prs: [] }] });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rdr-"));
const live = path.join(tmp, "live"), work = path.join(tmp, "work"), stateDir = path.join(tmp, "state");
const freshLive = () => {
  fs.rmSync(live, { recursive: true, force: true }); fs.mkdirSync(path.join(live, "_lib"), { recursive: true }); fs.mkdirSync(path.join(live, "H-19"), { recursive: true });
  fs.writeFileSync(path.join(live, "_lib", "browser.sh"), `export FONTCONFIG_FILE=/tmp/hv-debs/fonts.conf\nsource ${live}/_lib/x\n`);
  fs.writeFileSync(path.join(live, "H-19", "run.sh"), `bash ${live}/_lib/browser.sh\n`);
  fs.writeFileSync(path.join(live, "H-19", "TOOL.md"), "# Tool\n\n## Scenario text\n\nExpect: no surface claims a connection.\n\n## How\nrun\n");
};
const env = { REPO: "o/r", STATE_DIR: stateDir, TOOLS_DIR: live, REFEREE_WORK: work, FORGE_USER: "x", FORGE_HOME: "/h/x", FORGE_UID: 1001, STRONG_MODEL: "sol", REPAIR_MINUTES: 60, OWNER_NAME: "the owner", MANAGER_UNIT: "m.service" };
const prepare = () => { fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(path.join(work, "evidence"), { recursive: true }); fs.cpSync(live, path.join(work, "tools"), { recursive: true }); return { status: 0, stdout: "abc123def456\n" }; };
const report = { summary: "Fonts restored.", cause: "fonts.conf pointed at a missing folder.", changed: ["_lib/browser.sh"], packages: ["fonts-liberation", "fontconfig"], observed: ["H-19 PASS"], product_defects: [], still_blocked: "" };
// the AI stand-in edits its own copy: it sees the copy's own paths, never the live ones
const fixFonts = async ({ work: w }) => {
  const f = path.join(w, "tools", "_lib", "browser.sh"); const t = fs.readFileSync(f, "utf8");
  assert.ok(!t.includes(live) && t.includes(path.join(w, "tools")), "the copy's paths point at the copy");
  fs.writeFileSync(f, t.replace("/tmp/hv-debs/fonts.conf", "/etc/fonts/fonts.conf"));
  return { code: 0, report, events: "" };
};
const posts = [], recs = [];
const deps = (over = {}) => ({ log: () => {}, record: e => recs.push(e), post: async (c, body) => { posts.push({ item: c.item, body }); return true; }, prepare, smoke: () => ({ ok: true, browser: "alive", text_length: 900 }),
  review: () => ({ out: { safe: true, judging_unchanged: true, holdouts_fenced: true, no_incomplete_to_pass: true, reason: "only the font path" } }), fingerprint: () => "same", apt: () => ({ status: 0 }), pkgList: () => ({}), own: () => {}, startManager: () => ({ status: 0 }), ai: fixFonts,
  backup: (dir, file) => { fs.cpSync(dir, file + ".d", { recursive: true }); fs.writeFileSync(file, "backup"); return { status: 0 }; },
  restore: (dir, file) => { fs.cpSync(file + ".d", dir, { recursive: true, force: true }); return { status: 0 }; }, ...over });

testCase("applied: packages, the live file changed (with its own paths again), the observations asked for again, the man");
// applied: packages, the live file changed (with its own paths again), the observations asked for again, the manager started
freshLive(); let state = {}; const apt = [];
let r = await repairLook(env, deps({ apt: a => { if (a[1] !== "-s") apt.push(...a); return { status: 0 }; }, smoke: d => (d === live ? { ok: true, browser: "alive" } : { ok: false, browser: "gone", error: "Target page, context or browser has been closed" }) }), world(), state, NOW, { runId: "R1" });
assert.equal(r.outcome, "applied");
assert.deepEqual(apt, ["install", "-y", "--no-install-recommends", "fonts-liberation", "fontconfig"]);
const b = fs.readFileSync(path.join(live, "_lib", "browser.sh"), "utf8");
assert.ok(b.includes("/etc/fonts/fonts.conf") && b.includes(`source ${live}/_lib/x`), "the change lands in the live tools with the live paths");
assert.ok(posts[0].item === 583 && /Run H-19, H-20 again/.test(posts[0].body) && /no other evidence stands in/.test(posts[0].body) && /before: Target page/.test(posts[0].body), "the observations are asked for again, with the evidence");
assert.equal(r.manager, "started", "the factory's manager pass runs the suite now");
assert.ok(fs.existsSync(path.join(stateDir, "referee", "R1", "tools-before.tgz")) && fs.existsSync(path.join(stateDir, "referee", "R1", "diff.txt")), "a backup and the evidence are kept");
r = await repairLook(env, deps(), world(), state, NOW + HOUR, { runId: "R2" });
assert.equal(r.ran, false, "the same evidence is not repaired twice");

testCase("the review refuses: nothing applied, settled, the owner told");
// the review refuses: nothing applied, settled, the owner told
freshLive(); state = {}; posts.length = 0;
r = await repairLook(env, deps({ review: () => ({ out: { safe: true, judging_unchanged: false, holdouts_fenced: true, no_incomplete_to_pass: true, reason: "changes what H-19 expects" } }) }), world(), state, NOW, { runId: "R3" });
assert.deepEqual([r.outcome, r.tellOwner], ["refused by the review", true]);
assert.ok(fs.readFileSync(path.join(live, "_lib", "browser.sh"), "utf8").includes("/tmp/hv-debs") && !posts.length, "nothing applied, nothing posted");

testCase("what goes in is exactly what was reviewed, even if the folder changes after the review");
// what goes in is exactly what was reviewed, even if the folder changes after the review
freshLive(); state = {};
r = await repairLook(env, deps({ review: () => { fs.writeFileSync(path.join(work, "tools", "_lib", "browser.sh"), "echo SWAPPED AFTER THE REVIEW\n"); return { out: { safe: true, judging_unchanged: true, holdouts_fenced: true, no_incomplete_to_pass: true, reason: "ok" } }; } }), world(), state, NOW, { runId: "R1b" });
assert.equal(r.outcome, "applied");
assert.ok(!fs.readFileSync(path.join(live, "_lib", "browser.sh"), "utf8").includes("SWAPPED") && fs.readFileSync(path.join(live, "_lib", "browser.sh"), "utf8").includes("/etc/fonts/fonts.conf"), "the reviewed text, not the swapped one");
testCase("a change to a scenario's text: refused by the rules before any review");
// a change to a scenario's text: refused by the rules before any review
freshLive(); state = {};
const judge = async ({ work: w }) => { const f = path.join(w, "tools", "H-19", "TOOL.md"); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("no surface claims", "most surfaces do not claim")); return { code: 0, report, events: "" }; };
r = await repairLook(env, deps({ ai: judge, review: () => { throw new Error("must not be asked"); } }), world(), state, NOW, { runId: "R4" });
assert.equal(r.outcome, "refused by the rules"); assert.ok(r.reasons.some(x => /scenario text changed/.test(x)));

testCase("the browser still dies after the change: rolled back; tried again once, then the owner is told");
// the browser still dies after the change: rolled back; tried again once, then the owner is told
freshLive(); state = {};
const removed = []; let pkgs = { fontconfig: "1" };
const dead = { smoke: () => ({ ok: false, browser: "gone", error: "closed" }), pkgList: () => ({ ...pkgs }),
  apt: a => { if (a[0] === "install" && a[1] !== "-s") pkgs = { ...pkgs, "fonts-liberation": "2", "fonts-dejavu-core": "3" }; if (a[0] === "remove") { removed.push(...a.slice(2)); for (const p of a.slice(2)) delete pkgs[p]; } return { status: 0 }; } };
r = await repairLook(env, deps(dead), world(), state, NOW, { runId: "R5" });
assert.deepEqual(removed.sort(), ["fonts-dejavu-core", "fonts-liberation"], "a failed repair removes every package it brought, dependencies too, and none that was there before");
assert.ok(!fs.existsSync(work), "the copy of the tools does not stay");
pkgs = { fontconfig: "1" }; removed.length = 0;
assert.deepEqual([r.outcome, r.tellOwner], ["rolled back", false]);
assert.ok(fs.readFileSync(path.join(live, "_lib", "browser.sh"), "utf8").includes("/tmp/hv-debs"), "the live tools are as before");
r = await repairLook(env, deps(dead), world(), state, NOW + HOUR, { runId: "R6" });
pkgs = { fontconfig: "1" };
assert.deepEqual([r.outcome, r.tellOwner], ["rolled back", true], "the second failure is told");
assert.equal((await repairLook(env, deps(), world(), state, NOW + 2 * HOUR, { runId: "R7" })).ran, false, "and then left for that evidence");

testCase("a failed restore after a failed repair is said at once");
// a failed restore after a failed repair is said at once
freshLive(); state = {};
pkgs = { fontconfig: "1" };
r = await repairLook(env, deps({ ...dead, restore: () => ({ status: 2 }) }), world(), state, NOW, { runId: "R5b" });
assert.deepEqual([r.outcome, r.tellOwner], ["restore failed", true]);
testCase("a change that holds something like a token is refused");
// a change that holds something like a token is refused
freshLive(); state = {};
const leak = async ({ work: w }) => { fs.writeFileSync(path.join(w, "tools", "_lib", "note.txt"), "token ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 here"); return { code: 0, report: { ...report, packages: [] }, events: "" }; };
r = await repairLook(env, deps({ ai: leak, review: () => { throw new Error("must not be asked"); } }), world(), state, NOW, { runId: "R5f" });
assert.ok(r.outcome === "refused by the rules" && r.reasons.some(x => /token or key/.test(x)));
testCase("packages that would upgrade what is installed are refused before anything changes");
// packages that would upgrade what is installed are refused before anything changes
freshLive(); state = {};
r = await repairLook(env, deps({ apt: a => (a[1] === "-s" ? { status: 0, stdout: "Inst fonts-liberation (2 Ubuntu)\nInst fontconfig [1] (2 Ubuntu)\n" } : (() => { throw new Error("must not install"); })()) }), world(), state, NOW, { runId: "R5e" });
assert.ok(r.outcome === "refused by the rules" && /would change what is already installed/.test(r.reasons[0]));
testCase("a version change a failed repair cannot undo is said at once");
// a version change a failed repair cannot undo is said at once
freshLive(); state = {}; pkgs = { fontconfig: "1" };
r = await repairLook(env, deps({ ...dead, apt: a => { if (a[0] === "install" && a[1] !== "-s") pkgs = { fontconfig: "2" }; return { status: 0 }; } }), world(), state, NOW, { runId: "R5d" });
assert.ok(r.outcome === "restore failed" && /versions changed and left: fontconfig/.test(r.why) && r.tellOwner);
testCase("a decision that could not be posted is kept for the driver to post again");
// a decision that could not be posted is kept for the driver to post again
freshLive(); state = {};
r = await repairLook(env, deps({ post: async () => false }), world(), state, NOW, { runId: "R5c" });
assert.ok(r.outcome === "applied" && state.referee.pending.length === 1 && /Run H-19, H-20 again/.test(state.referee.pending[0].body), "an unposted decision waits in pending");
testCase("a link the repair made is refused without being followed");
// a link the repair made is refused without being followed
freshLive(); state = {};
const link = async ({ work: w }) => { try { fs.symlinkSync(path.join(tmp, "secret-of-the-machine"), path.join(w, "tools", "_lib", "leak.txt")); } catch { return { code: 0, report: { ...report, packages: [] }, events: "", skipLink: true }; } return { code: 0, report: { ...report, packages: [] }, events: "" }; };
fs.writeFileSync(path.join(tmp, "secret-of-the-machine"), "TOP SECRET");
r = await repairLook(env, deps({ ai: link, review: () => { throw new Error("must not be asked"); } }), world(), state, NOW, { runId: "R4b" });
if (r.outcome !== "changed nothing") { assert.equal(r.outcome, "refused by the rules"); assert.ok(r.reasons.some(x => /a link/.test(x))); assert.ok(!fs.readFileSync(path.join(stateDir, "referee", "R4b", "diff.txt"), "utf8").includes("TOP SECRET"), "never read"); }
testCase("a run that changed the live tools or the holdouts by any route (a script's side effect): a breach");
// a run that changed the live tools or the holdouts by any route (a script's side effect): a breach
freshLive(); state = {}; let n = 0;
r = await repairLook(env, deps({ fingerprint: () => String(n++) }), world(), state, NOW, { runId: "R8" });
assert.equal(r.outcome, "breach");
testCase("a command that reaches outside: a breach too");
// a command that reaches outside: a breach too
freshLive(); state = {};
const ev = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: `bash -lc 'echo x > ${live}/_lib/browser.sh'` } });
r = await repairLook(env, deps({ ai: async () => ({ code: 0, report, events: ev }) }), world(), state, NOW, { runId: "R9" });
assert.equal(r.outcome, "breach");
testCase("no report (Codex could not work): tried again, the trouble passed on");
// no report (Codex could not work): tried again, the trouble passed on
freshLive(); state = {};
r = await repairLook(env, deps({ ai: async () => ({ code: 1, report: null, events: "", trouble: "quota" }) }), world(), state, NOW, { runId: "R10" });
assert.deepEqual([r.outcome, r.trouble, r.tellOwner], ["no report", "quota", false]);
testCase("an item the AI run routed here is repaired although its words name no environment cue");
// an item the AI run routed here is repaired although its words name no environment cue
freshLive(); state = { referee: { forced: { 583: "t" } } };
const plain = () => ({ items: [{ number: 583, title: "chat state", url: "u583", state: "OPEN", body: "b", comments: [{ createdAt: "2026-11-15T15:54:00Z", url: "c1", author: bot, body: "Loop review: no pull request" }], prs: [] }] });
assert.equal((await repairLook(env, deps(), plain(), state, NOW, { runId: "R12" })).outcome, "applied");
testCase("at most three repairs in 24 hours");
// at most three repairs in 24 hours
state = { referee: { runs: [{ at: new Date(NOW - HOUR).toISOString() }, { at: new Date(NOW - HOUR).toISOString() }, { at: new Date(NOW - HOUR).toISOString() }] } };
assert.ok((await repairLook(env, deps(), world(), state, NOW, { runId: "R11" })).capped);

testCase("the run outputs a review cites are copied for the repair to read; nothing outside the artifacts folder");
// the run outputs a review cites are copied for the repair to read; nothing outside the artifacts folder
{
  const base = path.join(tmp, "ws");
  fs.mkdirSync(path.join(base, "artifacts", "runs", "b01a3a74775a", "holdouts"), { recursive: true });
  fs.writeFileSync(path.join(base, "artifacts", "runs", "b01a3a74775a", "holdouts", "H-19.txt"), "INCOMPLETE");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "no");
  const dest = path.join(tmp, "ev");
  const got = copyEvidence({ ARTIFACTS_BASE: base.split(path.sep).join("/") }, [{ evidence: [{ body: "Evidence is under artifacts/runs/b01a3a74775a/holdouts. Also artifacts/runs/b01a3a74775a/../../../secret.txt" }] }], dest);
  assert.equal(got.length, 1, "the cited run, not a path that climbs out");
  assert.equal(fs.readFileSync(path.join(dest, "b01a3a74775a", "holdouts", "H-19.txt"), "utf8"), "INCOMPLETE");
}

fs.rmSync(tmp, { recursive: true, force: true });

// the audit knows the places from its arguments, never from a default
testCase("the audit's rules name the places it is given: tools, holdouts, checkouts, home, settings");
{
  const ev = c => JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: c } });
  const where = { runDir: "/run/x", live: "/live/tools", holdouts: "/f/holdouts", home: "/f", checkouts: ["/f/app", "/f/side"], settingsDir: "/etc/driver" };
  const why = c => auditRepair(ev(c), where).map(b => b.why);
  assert.deepEqual(why("cp x /live/tools/a"), ["wrote to the live verifier tools"]);
  assert.deepEqual(why("rm /f/holdouts/app/HOLDOUT.md"), ["wrote to the holdout scenarios"]);
  assert.deepEqual(why("cat /f/side/README.md"), ["touched the factory's checkouts or a login"]);
  assert.deepEqual(why("cat ~/.ssh/id_ed25519"), ["touched the factory's checkouts or a login"]);
  assert.deepEqual(why("cat /etc/driver/driver.json"), ["touched a key or token"]);
  assert.deepEqual(why("cat keys.env"), ["touched a key or token"]);
  assert.deepEqual(why("ls /run/x/tools"), [], "its own folder is fine");
  assert.deepEqual(auditRepair(ev("cat /f/app/x"), { runDir: "/run/x", live: "/live/tools" }).map(b => b.why), [], "a place not given is not guessed");
}

