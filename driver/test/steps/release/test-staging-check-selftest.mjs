// The self-test of staging-check.mjs, moved out of the shipped file unchanged. It runs the real helper as its own
// process against stand-ins for GitHub and the server (stand-ins.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../../steps/release/args.mjs";
import * as R from "../../../steps/release/release-api.mjs";
import * as G from "../../../steps/release/staging.mjs";
import { readDeferrals, deferredWords } from "../../../steps/release/scope-amendment.mjs";
import { fileURLToPath as __f2u } from "node:url";
import * as M from "../../../steps/release/staging-check.mjs";
import { configure } from "../../../steps/release/config.mjs";
import { TEST_RELEASE_SETTINGS } from "./settings-fixture.mjs";
configure(TEST_RELEASE_SETTINGS);
const { stagingCheck, checkOpen, tellOnce, main, MINUTE, USAGE, EXIT, judgeServer, scenarioWords, checkAndTell } = M;
const THIS_FILE = __f2u(new URL("../../../steps/release/staging-check.mjs", import.meta.url));

// ---------- self-test ----------

function runSelf(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [THIS_FILE, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function selfTest() {
  const S = await import("./stand-ins.mjs");
  const t = R.reporter();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staging-check-self-test-"));
  const VERSION = "2.0.0-beta.7";
  const TAG = `candidate/${VERSION}`;
  const RELEASE = "godspeed-2.0.0-beta.7-test";
  const INSTALLED = "2026-10-27T10:00:00Z";
  const NOW = "2026-10-27T10:20:00Z";
  let n = 0;

  // scenarios: the runs of the product's scenarios workflow, each {result, on} where on is "tag"
  // (started on the candidate's own tag), "main" or "old" (on the tag's name but another commit).
  const run = async ({ server = {}, staging, go = null, args = [], ownerRepo = G.PRODUCT_REPO, open = false, candidate = true, scenarios = [{ result: "success" }], plan = null, files = null } = {}) => {
    const dir = path.join(tmp, `run-${++n}`);
    fs.mkdirSync(dir);
    const w = S.makeWorld();
    const seed = S.seedProduct(w, { ownerRepo: G.PRODUCT_REPO });
    let c = null;
    if (candidate) c = S.seedCandidate(w, seed, { version: VERSION });
    if (c) for (const s of scenarios) S.addScenarioRun(w, seed, { ...s, tag: TAG, commit: s.on === "main" ? seed.mainCommit : s.on === "old" ? seed.betaCommit : c.commit, branch: s.on === "main" ? "main" : TAG });
    const stand = await S.startStandIns(w);
    const ssh = S.writeSshStandIn(dir, S.serverState({ version: VERSION, commit: seed.mainCommit, now: NOW, ...server }));
    const records = S.makeRecordsRepo(path.join(dir, "records"), { [RELEASE]: G.PRODUCT_REPO });
    const record =
      staging === null
        ? null
        : { release: RELEASE, repository: G.PRODUCT_REPO, version: VERSION, productCommit: seed.mainCommit, machine: G.SERVER, installedAt: INSTALLED, healthAfter: { ok: true, version: VERSION, instance: S.SERVER_INSTANCE }, status: "installed", failures: [], scenarios: null, lastCheck: null, ...staging };
    if (record) records.put({ [G.stagingPath(RELEASE)]: record });
    if (plan) records.put({ [`releases/${RELEASE}/plan.md`]: plan });
    if (files) records.put(files);
    if (go) records.put({ [G.goPath(RELEASE)]: { release: RELEASE, version: VERSION, words: "go", where: "telegram", ...go } });
    try {
      const env = { ...S.standInEnv({ urls: stand.urls, tokenScript: "none" }), ...ssh.env, RELEASE_RECORDS_ROOT: records.root };
      const r = await runSelf(open ? ["--open", ownerRepo, ...args] : [ownerRepo, VERSION, ...args], env);
      return { r, ssh, records, seed, staging: records.json(G.stagingPath(RELEASE)), commits: records.commits() };
    } finally {
      await stand.close();
    }
  };
  const told = (r) => r.ssh.state().told || [];

  try {
    // ---- healthy on the server and every scenario passed on the tag: ready, at once, no night
    const good = await run();
    t.ok(
      good.r.code === 0 &&
        good.staging.status === "installed" &&
        good.staging.scenarios.result === "passed" &&
        G.scenariosPassed(good.staging, VERSION) &&
        good.staging.lastCheck.result === "ready" &&
        good.staging.lastCheck.checked.some((s) => /runs 2\.0\.0-beta\.7/.test(s)) &&
        !/night/i.test(good.r.stdout),
      `twenty minutes after the install, healthy and every scenario passed on its tag: ready, recorded, with no night to wait for (exit ${good.r.code} ${good.r.stderr.trim()})`,
    );
    t.ok(!good.ssh.calls().some((c) => c.op === "jobs"), "asks the server nothing about the night's jobs: there is no night");

    // ---- the scenarios decide whether it is ready
    const none = await run({ scenarios: [] });
    t.ok(none.r.code === 3 && none.staging.scenarios.result === "none" && /no scenarios have run on candidate\/2\.0\.0-beta\.7 yet/.test(none.r.stdout), `no scenarios run on its tag yet: healthy, not ready (exit ${none.r.code})`);
    const running = await run({ scenarios: [{ status: "in_progress" }] });
    t.ok(running.r.code === 3 && running.staging.scenarios.result === "running", `scenarios still running: not ready yet (exit ${running.r.code})`);
    const failedSc = await run({ scenarios: [{ result: "failure" }] });
    t.ok(
      failedSc.r.code === 1 && failedSc.staging.status === "installed" && failedSc.staging.scenarios.result === "failed" && /not ready to be made public/.test(failedSc.r.stderr),
      `a failed scenario run: not ready, and the install is not held against it (exit ${failedSc.r.code}: ${failedSc.r.stderr.trim()})`,
    );
    const jobsFailed = await run({ scenarios: [{ result: "failure", jobs: [{ name: "the Charm Challenge, start to finish", status: "completed", conclusion: "failure" }, { name: "the Wingman, start to finish", status: "completed", conclusion: "success" }, { name: "a later job", status: "completed", conclusion: "skipped" }] }] });
    t.ok(jobsFailed.staging.scenarios.result === "failed" && JSON.stringify(jobsFailed.staging.scenarios.failedJobs) === JSON.stringify(["the Charm Challenge, start to finish", "a later job"]), "a failed run records the jobs that did not pass (failedJobs), for a maintainer's waiver");
    t.ok(!("failedJobs" in failedSc.staging.scenarios), "a failed run whose jobs cannot be read records no failedJobs, so nothing can be waived");
    // the standing waiver (8 November 2026): failures outside the plan's blocking scenarios do not stop "ready"
    const BLOCK_PLAN = ["---", `release: ${RELEASE}`, `repository: ${G.PRODUCT_REPO}`, "---", "", "# Godspeed 2.0.0-beta.7: the test release", "", "Blocking scenarios: workouts-from-hevy", ""].join("\n");
    const jobsOf = (names) => names.map((name) => ({ name, status: "completed", conclusion: name.startsWith("old") ? "failure" : name.startsWith("workouts") ? "failure" : "success" }));
    const outside = await run({ plan: BLOCK_PLAN, scenarios: [{ result: "failure", jobs: jobsOf(["old charm job", "fine job"]) }] });
    t.ok(outside.r.code === 0 && outside.staging.lastCheck.result === "ready" && JSON.stringify(outside.staging.lastCheck.nonBlocking) === JSON.stringify(["old charm job"]) && /not blocking by the plan: "old charm job"/.test(outside.r.stdout), `failed jobs outside the plan's blocking list: ready, the jobs named (exit ${outside.r.code} ${outside.r.stderr.trim()})`);
    const inside = await run({ plan: BLOCK_PLAN, scenarios: [{ result: "failure", jobs: jobsOf(["old charm job", "workouts-from-hevy"]) }] });
    t.ok(inside.r.code === 1 && inside.staging.lastCheck.result === "scenariosFailed", `a failed blocking scenario: not ready (exit ${inside.r.code})`);
    const noList = await run({ scenarios: [{ result: "failure", jobs: jobsOf(["old charm job"]) }] });
    t.ok(noList.r.code === 1 && noList.staging.lastCheck.result === "scenariosFailed", "a plan with no blocking list: a failed job still blocks");
    const onMain = await run({ scenarios: [{ result: "success", on: "main" }] });
    t.ok(onMain.r.code === 3 && onMain.staging.scenarios.result === "none", "a passed run started from main, not on the tag, does not count");
    const defaultStage = await run({ scenarios: [{ result: "success", title: "scenarios beta" }] });
    t.ok(
      defaultStage.r.code === 3 &&
        defaultStage.staging.scenarios.result === "none" &&
        defaultStage.staging.scenarios.ignored === 'One run on candidate/2.0.0-beta.7 is titled "scenarios beta", not "scenarios candidate/2.0.0-beta.7", so it proved another stage and does not count.' &&
        /no scenarios that count have run on candidate\/2\.0\.0-beta\.7 yet\. One run on .* So start them on the tag itself/.test(defaultStage.r.stdout),
      `a passed run on the tag left at the default stage (titled "scenarios beta") does not count, and the record says so in one sentence (${JSON.stringify(defaultStage.staging.scenarios.ignored)})`,
    );
    const untitled = await run({ scenarios: [{ result: "success", title: "scenarios" }, { result: "failure", title: "scenarios", created: "2026-10-27T10:06:00Z" }] });
    t.ok(
      untitled.r.code === 3 &&
        untitled.staging.scenarios.result === "none" &&
        untitled.staging.scenarios.ignored === "2 runs on candidate/2.0.0-beta.7 have no stage in their title, from before the workflow named it, so which stage they proved cannot be told, and they do not count.",
      `runs from before the workflow named its stage do not count either, and are not said to have proved another stage (${JSON.stringify(untitled.staging.scenarios.ignored)})`,
    );
    const both = await run({ scenarios: [{ result: "success", title: "scenarios beta" }, { result: "success", title: "scenarios main", created: "2026-10-27T10:06:00Z" }, { result: "success", title: "scenarios", created: "2026-10-27T10:07:00Z" }] });
    t.ok(
      both.staging.scenarios.ignored ===
        '2 runs on candidate/2.0.0-beta.7 are titled "scenarios beta" or "scenarios main", not "scenarios candidate/2.0.0-beta.7", so they proved another stage and do not count. One run on candidate/2.0.0-beta.7 has no stage in its title, from before the workflow named it, so which stage it proved cannot be told, and it does not count.',
      `both kinds are named, each in its own sentence (${JSON.stringify(both.staging.scenarios.ignored)})`,
    );
    const titledAmongOthers = await run({ scenarios: [{ result: "success", created: "2026-10-27T10:01:00Z" }, { result: "failure", title: "scenarios beta", created: "2026-10-27T10:09:00Z" }] });
    t.ok(
      titledAmongOthers.r.code === 0 && titledAmongOthers.staging.scenarios.result === "passed",
      "the newest run titled for the candidate decides; a newer one that proved beta is not taken for it",
    );
    const otherCommit = await run({ scenarios: [{ result: "success", on: "old" }] });
    t.ok(otherCommit.r.code === 3 && otherCommit.staging.scenarios.result === "none", "a passed run on the tag's name but another commit does not count");
    const rerun = await run({ scenarios: [{ result: "failure", created: "2026-10-27T10:01:00Z" }, { result: "success", created: "2026-10-27T10:09:00Z" }] });
    t.ok(rerun.r.code === 0 && rerun.staging.scenarios.result === "passed", "the newest run on the tag counts: a failure fixed by a run after it passes");
    const regressed = await run({ scenarios: [{ result: "success", created: "2026-10-27T10:01:00Z" }, { result: "failure", created: "2026-10-27T10:09:00Z" }] });
    t.ok(regressed.r.code === 1 && regressed.staging.scenarios.result === "failed", "a newer run that failed undoes an older pass");

    // ---- the server no longer runs the candidate, or runs it unhealthy: failed, and it stays so
    const otherVersion = await run({ server: { health: { version: "2.0.0-beta.6" } } });
    t.ok(otherVersion.r.code === 1 && otherVersion.staging.status === "failed" && /runs 2\.0\.0-beta\.6, not 2\.0\.0-beta\.7/.test(otherVersion.staging.failures.join(" ")), "fails when the server runs another version");
    const sick = await run({ server: { health: { ok: false } } });
    t.ok(sick.r.code === 1 && sick.staging.status === "failed", "fails when the notebook is not healthy");
    const staleBeat = await run({ server: { heartbeat: "2026-10-27T09:00:00Z" } });
    t.ok(staleBeat.r.code === 1 && /scheduler last beat/.test(staleBeat.staging.failures.join(" ")), "fails when the scheduler's heartbeat is older than 15 minutes");
    const newInstance = await run({ server: { health: { instance: "a-fresh-instance" } } });
    t.ok(newInstance.r.code === 1 && /instance a-fresh-instance/.test(newInstance.staging.failures.join(" ")), "fails when the notebook is another instance than the one installed");
    const stillFailed = await run({ staging: { status: "failed", failedAt: "2026-10-27T10:05:00Z", failures: ["an earlier failure"] } });
    t.ok(stillFailed.r.code === 1 && stillFailed.staging.status === "failed" && /until it is installed again/.test(stillFailed.r.stderr) && !stillFailed.ssh.calls().length, "a failed install stays failed until it is installed again, and the server is not asked");

    // ---- the add-ons must still reach the AI (staging.mjs, addonAi), asked once the notebook is right
    const aiCalls = (x) => x.ssh.calls().filter((c) => c.op === "addon-ai");
    t.ok(
      aiCalls(good).length === 1 && good.staging.lastCheck.checked.some((s) => /^The add-ons reach the AI: .*answered\.$/.test(s)) && good.staging.lastCheck.addonAi.state === "ok",
      "checks that the add-ons still reach the AI, and records it with the check",
    );
    const lostAi = await run({ args: ["--tell"], server: { addonAi: { ask: [S.modelSaid(1, "The selected Godspeed model could not answer. Check its connection and usage allowance.\n")] } } });
    t.ok(
      lostAi.r.code === 1 &&
        lostAi.staging.status === "failed" &&
        lostAi.staging.failures[0] === "The add-ons on your server cannot reach the AI: The selected Godspeed model could not answer. Check its connection and usage allowance." &&
        told(lostAi).length === 1 &&
        told(lostAi)[0].summary === "2.0.0-beta.7 is not healthy on your server: the add-ons there cannot reach the AI since it was installed." &&
        !(lostAi.staging.told || {}).ready,
      `fails when the add-ons cannot reach the AI though every scenario passed, and the one message names it instead of asking for a go (${JSON.stringify(told(lostAi)[0] && told(lostAi)[0].summary)})`,
    );
    const gone = await run({ staging: { addonAi: { state: "ok", command: S.MODEL_COMMAND } }, server: { addonAi: null } });
    t.ok(gone.r.code === 1 && gone.staging.status === "failed" && /godspeed-model, which was there before, is gone/.test(gone.staging.failures[0]), "fails when godspeed-model, which answered at the install, is gone");
    const older = await run({ server: { addonAi: null } });
    t.ok(
      older.r.code === 0 && older.staging.status === "installed" && older.staging.lastCheck.checked.some((s) => /^Your server has no godspeed-model/.test(s)),
      `a server that had no godspeed-model at the install either (an older Godspeed) says so, and is ready (exit ${older.r.code} ${older.r.stderr.trim()})`,
    );
    const aiAway = await run({ server: { addonAi: { unreachable: true } } });
    t.ok(aiAway.r.code === 1 && aiAway.staging.status === "installed" && aiAway.staging.lastCheck.result === "unchecked", "a server that does not answer the add-ons' AI check is not checked, and the record stays installed");
    t.ok(!aiCalls(otherVersion).length && !aiCalls(sick).length, "when the notebook itself is not right, the add-ons' AI is not asked, so the failure names the notebook");

    // ---- what cannot be checked changes nothing but the last check
    const away = await run({ server: { unreachable: true } });
    t.ok(away.r.code === 1 && away.staging.status === "installed" && away.staging.lastCheck.result === "unchecked", `an unreachable server is not checked, and the record stays installed (exit ${away.r.code}: ${away.r.stderr.trim()})`);

    // ---- no record at all, and the dry run
    const nothing = await run({ staging: null });
    t.ok(nothing.r.code === 1 && /no record that 2\.0\.0-beta\.7 was put on your server/.test(nothing.r.stderr) && !nothing.ssh.calls().length, "refuses without a staging record, before it asks the server anything");
    const dry = await run({ staging: null, args: ["--dry-run"] });
    t.ok(
      dry.r.code === 0 && !dry.staging && dry.commits === 1 && /server's own record of when its notebook version was installed/.test(dry.r.stdout) && /A dry run records nothing/.test(dry.r.stdout),
      `--dry-run without a record takes the install time from the server, prints what it checks, and records nothing (exit ${dry.r.code})`,
    );

    // ---- the morning run
    const openGood = await run({ open: true });
    t.ok(openGood.r.code === 0 && openGood.staging.lastCheck.result === "ready", `--open checks the open candidate (exit ${openGood.r.code} ${openGood.r.stderr.trim()})`);
    const nothingOpen = await run({ open: true, candidate: false });
    t.ok(nothingOpen.r.code === 0 && /No candidate .* is open/.test(nothingOpen.r.stdout) && !nothingOpen.ssh.calls().length, "--open with no candidate newer than the public one checks nothing");
    const notStaged = await run({ open: true, staging: null });
    t.ok(notStaged.r.code === 0 && /has not been put on your server/.test(notStaged.r.stdout) && !notStaged.ssh.calls().length, "--open with a candidate not put on the server checks nothing");

    // ---- the ask comes as soon as it can: one message the first time it is ready, one the first
    //      time its install is not healthy, through the bot lane of mc-notify, never twice
    const ask = await run({ args: ["--tell"] });
    t.ok(
      ask.r.code === 0 &&
        told(ask).length === 1 &&
        told(ask)[0].summary === "2.0.0-beta.7 is on your server, healthy, and every scenario passed. Shall I make it public?" &&
        /^\/usr\/local\/bin\/mc-notify --lane bot --profile godspeed --source release-staging /.test(told(ask)[0].notify) &&
        !!(ask.staging.told || {}).ready,
      `the first time it is ready, one message asks whether to make it public, through mc-notify's bot lane, and it is recorded (${JSON.stringify(told(ask)[0] && told(ask)[0].summary)})`,
    );
    const named = await run({ args: ["--tell"], plan: `---\nrelease: ${RELEASE}\nrepository: ${G.PRODUCT_REPO}\n---\n\n# Godspeed 2.0.0-beta.7: the chat answers faster, and voice notes come back quicker\n\n## In plain words\n` });
    t.ok(
      told(named).length === 1 && told(named)[0].summary === "2.0.0-beta.7 is on your server, healthy, and every scenario passed. What changed: the chat answers faster, and voice notes come back quicker. Shall I make it public?",
      `the ask names what changed, in the plan's own title (${JSON.stringify(told(named)[0] && told(named)[0].summary)})`,
    );
    const defaulted = await run({ args: ["--tell"], files: { [`releases/${RELEASE}/defaults-applied.json`]: { release: RELEASE, applied: [{ issue: 706, heading: "Which endings should the domain watch cover? (#706)", default: "Only .com", at: "2026-10-27T09:00:00Z" }] } } });
    t.ok(
      told(defaulted).length === 1 && told(defaulted)[0].summary === "2.0.0-beta.7 is on your server, healthy, and every scenario passed. Decided by default because no answer came in time: Which endings should the domain watch cover?: Only .com. Shall I make it public?",
      `the ask names every default that applied because he did not answer in time (${JSON.stringify(told(defaulted)[0] && told(defaulted)[0].summary)})`,
    );
    const askMorning = await run({ open: true, args: ["--tell"] });
    t.ok(askMorning.r.code === 0 && told(askMorning).length === 1, "the morning run asks too, when nothing asked before");
    const toldBefore = await run({ args: ["--tell"], staging: { told: { ready: "2026-10-27T10:10:00Z" } } });
    t.ok(toldBefore.r.code === 0 && told(toldBefore).length === 0, "a version he was already asked about is never asked about again");
    const askedByOldCode = await run({ args: ["--tell"], staging: { status: "running", told: { passed: "2026-10-27T10:10:00Z" } } });
    t.ok(askedByOldCode.r.code === 0 && told(askedByOldCode).length === 0, "a version the code before this one already asked about (told.passed) is not asked about again");
    const goGiven = await run({ args: ["--tell"], go: { at: "2026-10-27T10:15:00Z" } });
    t.ok(goGiven.r.code === 0 && told(goGiven).length === 0, "a version he already said go for is not asked about");
    const notYet = await run({ args: ["--tell"], scenarios: [{ status: "in_progress" }] });
    t.ok(notYet.r.code === 3 && told(notYet).length === 0, "nothing is asked while the scenarios have not passed");
    const scFailedTell = await run({ args: ["--tell"], scenarios: [{ result: "failure" }] });
    t.ok(scFailedTell.r.code === 1 && told(scFailedTell).length === 0, "a failed scenario run asks nothing: the release step fixes it first");
    const bad = await run({ args: ["--tell"], server: { health: { version: "2.0.0-beta.6" } } });
    t.ok(
      bad.r.code === 1 && told(bad).length === 1 && told(bad)[0].summary === "2.0.0-beta.7 is not healthy on your server: your server runs 2.0.0-beta.6 instead." && !!(bad.staging.told || {}).failed,
      `the first time the install is found not healthy, one message names it (${JSON.stringify(told(bad)[0] && told(bad)[0].summary)})`,
    );
    const badAgain = await run({ args: ["--tell"], staging: { status: "failed", failedAt: "2026-10-27T10:05:00Z", failures: ["Your server runs 2.0.0-beta.6, not 2.0.0-beta.7."], told: { failed: "2026-10-27T10:06:00Z" } } });
    t.ok(badAgain.r.code === 1 && told(badAgain).length === 0, "a failure he was already told about is never told again");
    const untold = await run({ open: true, args: ["--tell"], staging: { status: "failed", failedAt: "2026-10-27T10:05:00Z", failures: ["The installer of 2.0.0-beta.7 exited 1 on your server"] } });
    t.ok(told(untold).length === 1 && /its install did not finish well\.$/.test(told(untold)[0].summary), "a failed install whose message could not go out before is told by the next check");
    const notSent = await run({ args: ["--tell"], server: { tellExit: 4 } });
    t.ok(
      notSent.r.code === 1 && told(notSent).length === 1 && !(notSent.staging.told || {}).ready && /the next check tries again/.test(notSent.r.stdout),
      "a message that could not be sent is not marked, so the next check tries again",
    );
    const quietRun = await run({ open: true });
    t.ok(quietRun.r.code === 0 && told(quietRun).length === 0, "without --tell nothing is sent");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(t.failures ? `${t.failures} self-test check(s) failed.` : "All staging-check self-tests passed.");
  return t.failures ? 1 : 0;
}

test("staging-check self-test", async () => {
  assert.equal(await selfTest(), 0);
});
