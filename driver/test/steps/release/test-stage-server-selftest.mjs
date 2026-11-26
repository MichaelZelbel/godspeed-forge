// test cases: 1
// The self-test of stage-server.mjs, moved out of the shipped file unchanged. It runs the real helper as its own
// process against stand-ins for GitHub and the server (stand-ins.mjs).
import { test, runCases } from "../case-test.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../../steps/release/args.mjs";
import * as R from "../../../steps/release/release-api.mjs";
import * as G from "../../../steps/release/staging.mjs";
import { stagingCheck, tellOnce } from "../../../steps/release/staging-check.mjs";
import { fileURLToPath as __f2u } from "node:url";
import * as M from "../../../steps/release/stage-server.mjs";
import { configure } from "../../../steps/release/config.mjs";
import { TEST_RELEASE_SETTINGS } from "./settings-fixture.mjs";
configure(TEST_RELEASE_SETTINGS);
const { stageServer, main, USAGE, scenarioWait, askWhenReady } = M;
const THIS_FILE = __f2u(new URL("../../../steps/release/stage-server.mjs", import.meta.url));

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stage-server-self-test-"));
  const VERSION = "2.0.0-beta.7";
  const RELEASE = "godspeed-2.0.0-beta.7-test";
  let n = 0;

  // scenarios: runs of the product's scenarios on the candidate's tag that finished before the install did.
  // alreadyRuns: the server took the candidate's commit from main by itself (follow-main.mjs) and
  // runs it as that version; "commit only" runs the commit but answers as another version.
  const SINCE = "2026-10-27T09:30:00Z";
  const run = async ({ server, args = [], ownerRepo = G.PRODUCT_REPO, earlier = null, scenarios = [], limited = false, alreadyRuns = false } = {}) => {
    const dir = path.join(tmp, `run-${++n}`);
    fs.mkdirSync(dir);
    const w = S.makeWorld();
    const seed = S.seedProduct(w, { ownerRepo: G.PRODUCT_REPO });
    const candidate = S.seedCandidate(w, seed, { version: VERSION });
    for (const sc of scenarios) S.addScenarioRun(w, seed, { ...sc, branch: candidate.tag, commit: candidate.commit });
    if (limited) w.runsLimited = true;
    const stand = await S.startStandIns(w);
    const running = alreadyRuns ? { commit: seed.mainCommit, commitSince: SINCE, stageRef: "main", ...(alreadyRuns === true ? { version: VERSION } : {}) } : {};
    const ssh = S.writeSshStandIn(dir, S.serverState({ version: "2.0.0-beta.6", ...server, ...running, installTo: { version: VERSION, commit: seed.mainCommit, ...(server && server.installTo) } }));
    const records = S.makeRecordsRepo(path.join(dir, "records"), { [RELEASE]: G.PRODUCT_REPO });
    if (earlier) records.put({ [G.stagingPath(RELEASE)]: earlier });
    try {
      const env = { ...S.standInEnv({ urls: stand.urls, tokenScript: "none" }), ...ssh.env, RELEASE_RECORDS_ROOT: records.root, STAGING_POLL_MS: "5", STAGING_INSTALL_MAX_MS: "3000", STAGING_SCENARIOS_POLL_MS: "5", STAGING_SCENARIOS_MAX_MS: "400" };
      const r = await runSelf([ownerRepo, VERSION, ...args], env);
      return { r, w, seed, candidate, ssh, records, staging: records.json(G.stagingPath(RELEASE)) };
    } finally {
      await stand.close();
    }
  };

  try {
    // ---- the staging that works
    const good = await run();
    const st = good.staging || {};
    const server = good.ssh.state();
    t.ok(
      good.r.code === 0 &&
        st.status === "installed" &&
        st.version === VERSION &&
        st.productCommit === good.seed.mainCommit &&
        st.machine === G.SERVER &&
        st.installedAt === server.now &&
        st.healthBefore.version === "2.0.0-beta.6" &&
        st.healthAfter.version === VERSION &&
        st.healthAfter.instance === st.healthBefore.instance &&
        st.backup === server.backup,
      `installs the candidate, then records staging.json: status installed, version, product commit, installed-at, health before and after, backup (exit ${good.r.code} ${good.r.stderr.trim()})`,
    );
    const installCall = good.ssh.calls().find((c) => c.op === "install");
    t.ok(
      !!installCall &&
        installCall.script.includes(`GODSPEED_PRODUCT_REF=${good.seed.mainCommit} GODSPEED_STARTER_REF=${good.seed.mainCommit}`) &&
        installCall.script.includes("env -u GODSPEED_DIR PATH=/root/.local/bin:$PATH") &&
        installCall.script.includes(`https://raw.githubusercontent.com/${G.PRODUCT_REPO}/${good.seed.mainCommit}/notebook/scripts/install-native-notebook.sh`) &&
        installCall.script.includes("setsid nohup"),
      "runs the product's native installer at the candidate's commit, detached, with Hermes' folder on PATH and GODSPEED_DIR unset",
    );
    t.ok(
      server.files["stage.json"] === good.candidate.text && server.files["stage-ref"] === `candidate/${VERSION}\n`,
      "writes the stage file exactly as the tag holds it, and stage-ref candidate/<version>, beside the installation",
    );

    // ---- the pin: written before the install, naming the candidate, so the server takes nothing
    //      more from main while it waits for his verdict (follow-main.mjs reads it)
    const ops = good.ssh.calls().map((c) => c.op);
    t.ok(
      !!server.pin && server.pin.version === VERSION && server.pin.commit === good.seed.mainCommit && server.pin.tag === `candidate/${VERSION}` && ops.indexOf("pin") >= 0 && ops.indexOf("pin") < ops.indexOf("install"),
      `pins the server to the candidate before it installs (${JSON.stringify(server.pin)}; ops ${ops.join(",")})`,
    );

    // ---- a server that already runs the candidate's commit, healthy, as that version (it took it
    //      from main by itself) is not installed again: it is recorded and checked as if it had been
    const already = await run({ alreadyRuns: true, scenarios: [{ result: "success" }] });
    const ast = already.staging || {};
    t.ok(
      already.r.code === 0 &&
        !already.ssh.calls().some((c) => c.op === "install" || c.op === "poll") &&
        ast.status === "installed" &&
        ast.installedAt === SINCE &&
        ast.foundRunning &&
        ast.foundRunning.since === SINCE &&
        ast.backup === null &&
        ast.healthAfter.version === VERSION &&
        ast.addonAi.state === "ok" &&
        /already runs 2\.0\.0-beta\.7's commit \w+, since 2026-10-27T09:30:00Z, so it is not installed again/.test(already.r.stdout),
      `a server that already runs the candidate's commit healthy is not installed again; the record says installed since it took that commit (exit ${already.r.code} ${already.r.stderr.trim()})`,
    );
    t.ok(
      already.ssh.state().files["stage.json"] === already.candidate.text && already.ssh.state().stageRef === `candidate/${VERSION}` && already.ssh.state().pin.version === VERSION,
      "it still writes the candidate's stage file and ref beside the installation, and pins the server",
    );
    t.ok((already.ssh.state().told || []).length === 1 && /Shall I make it public\?$/.test(already.ssh.state().told[0].summary), "and he is asked as soon as its scenarios have passed, as after an install");
    const alreadySick = await run({ alreadyRuns: true, server: { addonAi: { describe: S.modelSaid(1, "The connected Godspeed assistant Python runtime was not found\n") } } });
    t.ok(
      alreadySick.r.code === 1 && alreadySick.staging.status === "failed" && /add-ons on your server cannot reach the AI/.test(alreadySick.staging.failures[0]) && !alreadySick.ssh.calls().some((c) => c.op === "install"),
      `one that runs the commit but whose add-ons cannot reach the AI is recorded as failed, as after an install (${(alreadySick.staging && alreadySick.staging.failures[0]) || "no record"})`,
    );
    const commitOnly = await run({ alreadyRuns: "commit only" });
    t.ok(commitOnly.r.code === 0 && commitOnly.ssh.calls().some((c) => c.op === "install") && commitOnly.staging.status === "installed" && !commitOnly.staging.foundRunning, "one that runs the commit but answers as another version is installed, as before");
    const dryAlready = await run({ alreadyRuns: true, args: ["--dry-run"] });
    t.ok(
      dryAlready.r.code === 0 && /Would not install: your server already runs commit/.test(dryAlready.r.stdout) && /Would pin your server to 2\.0\.0-beta\.7/.test(dryAlready.r.stdout) && dryAlready.ssh.calls().every((c) => c.op === "look") && !dryAlready.ssh.state().pin,
      "--dry-run says it would pin the server and would not install, and does neither",
    );
    const noPin = await run({ server: { pinFails: true } });
    t.ok(noPin.r.code === 1 && /could not be pinned/.test(noPin.r.stderr) && !noPin.ssh.calls().some((c) => c.op === "install") && !noPin.staging, `refuses, installing and recording nothing, when the server cannot be pinned (exit ${noPin.r.code})`);

    // ---- refusals before anything is installed
    const sick = await run({ server: { health: { ok: false } } });
    t.ok(
      sick.r.code === 1 && /does not answer as healthy now/.test(sick.r.stderr) && !sick.ssh.calls().some((c) => c.op === "install") && !sick.staging,
      `refuses, installing and recording nothing, when the notebook is not healthy before (exit ${sick.r.code}: ${sick.r.stderr.trim().split("\n")[0]})`,
    );
    const busy = await run({ server: { installing: 1 } });
    t.ok(busy.r.code === 1 && /already running/.test(busy.r.stderr) && !busy.ssh.calls().some((c) => c.op === "install"), `refuses when an install is already running (exit ${busy.r.code})`);
    const away = await run({ server: { unreachable: true } });
    t.ok(away.r.code === 1 && /could not be reached/.test(away.r.stderr) && !away.staging, `refuses when the server cannot be reached (exit ${away.r.code}: ${away.r.stderr.trim().split("\n")[0]})`);
    const other = await run({ ownerRepo: "MichaelZelbel/godspeed-clerk" });
    t.ok(other.r.code === 1 && /Only MichaelZelbel\/godspeed-mission-control is put on your server/.test(other.r.stderr) && !other.ssh.calls().length, `refuses any repository but the product (exit ${other.r.code})`);

    // ---- an install that fails, and one that comes up on another version, are recorded as failed
    const broke = await run({ server: { installTo: { exit: 1 } } });
    t.ok(
      broke.r.code === 1 && broke.staging && broke.staging.status === "failed" && /exited 1/.test(broke.staging.failures[0]),
      `records staging failed when the installer exits non-zero (exit ${broke.r.code}: ${(broke.staging && broke.staging.failures[0]) || "no record"})`,
    );
    const wrongVersion = await run({ server: { installTo: { version: "2.0.0-beta.6" } } });
    t.ok(
      wrongVersion.r.code === 1 && wrongVersion.staging && wrongVersion.staging.status === "failed" && /says version 2\.0\.0-beta\.6, not 2\.0\.0-beta\.7/.test(wrongVersion.staging.failures[0]),
      `records staging failed when the notebook comes up on another version (${(wrongVersion.staging && wrongVersion.staging.failures[0]) || "no record"})`,
    );
    const newInstance = await run({ server: { installTo: { instance: "another-instance" } } });
    t.ok(
      newInstance.r.code === 1 && newInstance.staging && /instance another-instance/.test(newInstance.staging.failures[0]),
      "records staging failed when the notebook comes up as another instance",
    );

    // ---- the add-ons must still reach the AI after the install (staging.mjs, addonAi): on 26 October
    //      beta.7 came up with the notebook healthy while every add-on had lost it. A lost connection
    //      is a failed install, with the one message for it, and he is not asked for a go.
    const aiCalls = (x) => x.ssh.calls().filter((c) => c.op === "addon-ai");
    const sent = (x) => x.ssh.state().told || [];
    const answered = (text = "OK") => S.modelSaid(0, "", JSON.stringify({ text, provider: "openai-codex", model: "gpt-5.5" }));
    t.ok(
      good.staging.addonAi &&
        good.staging.addonAi.state === "ok" &&
        good.staging.addonAi.provider === "openai-codex" &&
        good.staging.addonAi.model === "gpt-5.5" &&
        good.staging.addonAi.command === S.MODEL_COMMAND &&
        /The add-ons reach the AI: \S+godspeed-model names openai-codex gpt-5\.5, and a one-word request through it answered\./.test(good.r.stdout) &&
        aiCalls(good).length >= 1 &&
        aiCalls(good)[0].script.includes("--workspace /root/godspeed --describe") &&
        aiCalls(good)[0].script.includes(`printf '%s' '${JSON.stringify(G.MODEL_REQUEST)}'`) &&
        G.MODEL_REQUEST.max_tokens === 128,
      "after the install, godspeed-model names a configured AI and answers a one-word request (128 tokens at most), and the record keeps which AI answered",
    );
    const lostAi = await run({ server: { installTo: { addonAi: { describe: S.modelSaid(1, "The connected Godspeed assistant Python runtime was not found\n") } } }, scenarios: [{ result: "success" }] });
    t.ok(
      lostAi.r.code === 1 &&
        lostAi.staging.status === "failed" &&
        lostAi.staging.failures[0] === "After the install, the add-ons on your server cannot reach the AI: The connected Godspeed assistant Python runtime was not found." &&
        lostAi.staging.addonAi.state === "failed" &&
        lostAi.staging.addonAi.step === "describe",
      `records the install failed when the add-ons cannot reach the AI after it, though the notebook is healthy (exit ${lostAi.r.code}: ${(lostAi.staging && lostAi.staging.failures[0]) || "no record"})`,
    );
    t.ok(
      sent(lostAi).length === 1 && sent(lostAi)[0].summary === "2.0.0-beta.7 is not healthy on your server: the add-ons there cannot reach the AI since it was installed." && !(lostAi.staging.told || {}).ready,
      `with every scenario passed he is still not asked for a go; he gets the one message naming it (${JSON.stringify(sent(lostAi)[0] && sent(lostAi)[0].summary)})`,
    );
    const noAnswer = await run({ server: { installTo: { addonAi: { ask: [S.modelSaid(1, "The selected Godspeed model could not answer. Check its connection and usage allowance.\n")] } } } });
    t.ok(
      noAnswer.r.code === 1 &&
        noAnswer.staging.status === "failed" &&
        /AI: The selected Godspeed model could not answer\. Check its connection and usage allowance\.$/.test(noAnswer.staging.failures[0]) &&
        noAnswer.staging.addonAi.step === "ask" &&
        noAnswer.staging.addonAi.tries === 2,
      `records the install failed when the one-word request fails, asked twice (${(noAnswer.staging && noAnswer.staging.failures[0]) || "no record"})`,
    );
    const busyOnce = await run({ server: { installTo: { addonAi: { ask: [S.modelSaid(1, "Godspeed is busy with another model request; retry later\n"), answered()] } } } });
    t.ok(busyOnce.r.code === 0 && busyOnce.staging.status === "installed" && busyOnce.staging.addonAi.tries === 2, `a request that fails once and answers when asked again is healthy (exit ${busyOnce.r.code} ${busyOnce.r.stderr.trim()})`);
    const unconfigured = await run({ server: { installTo: { addonAi: { describe: S.modelSaid(0, "", JSON.stringify({ configured: false })) } } } });
    t.ok(unconfigured.r.code === 1 && /cannot reach the AI: godspeed-model --describe names no configured AI/.test(unconfigured.staging.failures[0]), "records the install failed when godspeed-model names no configured AI");
    const noText = await run({ server: { installTo: { addonAi: { ask: [answered("  ")] } } } });
    t.ok(noText.r.code === 1 && /came back without any text/.test(noText.staging.failures[0]), "records the install failed when the request answers without text");
    const gone = await run({ server: { installTo: { addonAi: { command: "" } } } });
    t.ok(gone.r.code === 1 && /cannot reach the AI: godspeed-model, which was there before, is gone/.test(gone.staging.failures[0]), "records the install failed when godspeed-model was there before it and is gone after it");
    const aiAway = await run({ server: { installTo: { addonAi: { unreachable: true } } } });
    t.ok(aiAway.r.code === 1 && /could not be reached to check the add-ons' AI connection/.test(aiAway.staging.failures[0]), "records the install failed when the server does not answer the add-ons' AI check");
    const older = await run({ server: { addonAi: null } });
    t.ok(
      older.r.code === 0 && older.staging.status === "installed" && older.staging.addonAi.state === "absent" && /Your server has no godspeed-model \(a Godspeed older/.test(older.r.stdout),
      `a server with no godspeed-model before or after (an older Godspeed) says so, and that is not a failure (exit ${older.r.code} ${older.r.stderr.trim()})`,
    );
    t.ok(!aiCalls(wrongVersion).length && !aiCalls(broke).length, "when the notebook itself did not come up right, the add-ons' AI is not asked, so the failure names the notebook");

    // ---- a version staged again keeps what he was already told about it, so nothing is sent twice
    const restaged = await run({ earlier: { release: RELEASE, version: VERSION, status: "failed", told: { failed: "2026-10-27T05:04:00Z" } } });
    t.ok(restaged.r.code === 0 && restaged.staging.status === "installed" && restaged.staging.told && restaged.staging.told.failed === "2026-10-27T05:04:00Z", "staging the same version again keeps what he was told about it");
    const brokeAgain = await run({ server: { installTo: { exit: 1 } }, earlier: { release: RELEASE, version: VERSION, status: "failed", told: { failed: "2026-10-27T05:04:00Z" } } });
    t.ok(brokeAgain.r.code === 1 && !(brokeAgain.ssh.state().told || []).length, "an install that fails again is not told again: never twice");
    const otherRecord = await run({ earlier: { release: RELEASE, version: "2.0.0-beta.6", status: "installed", told: { ready: "2026-10-20T05:04:00Z" } } });
    t.ok(otherRecord.r.code === 0 && !otherRecord.staging.told, "a record of another version passes nothing on");

    // ---- the ask comes as soon as it can: right after a healthy install, the candidate is checked
    //      with its scenarios, and when they have passed too he gets the one message asking whether
    //      to make it public; an install that does not come up healthy gets the one message naming it
    const told = (r) => r.ssh.state().told || [];
    t.ok(
      good.staging.lastCheck && good.staging.lastCheck.result === "waiting" && good.staging.scenarios.result === "none" && !told(good).length && /no scenarios have run on candidate\/2\.0\.0-beta\.7 yet/.test(good.r.stdout),
      "right after the install it is checked once more; with no scenarios run on its tag yet, nothing is asked",
    );
    const ready = await run({ scenarios: [{ result: "success" }] });
    t.ok(
      ready.r.code === 0 &&
        told(ready).length === 1 &&
        told(ready)[0].summary === "2.0.0-beta.7 is on your server, healthy, and every scenario passed. Shall I make it public?" &&
        !!(ready.staging.told || {}).ready &&
        ready.staging.lastCheck.result === "ready",
      `when its scenarios passed before the install finished, he is asked right after the install (${JSON.stringify(told(ready)[0] && told(ready)[0].summary)})`,
    );
    const waitedFor = await run({ scenarios: [{ result: "success", pollsUntilDone: 3 }] });
    t.ok(
      waitedFor.r.code === 0 && /still running .*waiting up to/.test(waitedFor.r.stdout) && told(waitedFor).length === 1 && waitedFor.staging.lastCheck.result === "ready",
      `a scenarios run on the tag still going when the install is done is waited for, and he is asked the moment it passes (exit ${waitedFor.r.code} ${waitedFor.r.stderr.trim()})`,
    );
    const neverDone = await run({ scenarios: [{ status: "in_progress" }] });
    t.ok(
      neverDone.r.code === 0 && !told(neverDone).length && neverDone.staging.lastCheck.result === "waiting" && /staging-check\.mjs MichaelZelbel\/godspeed-mission-control 2\.0\.0-beta\.7 --tell/.test(neverDone.r.stdout),
      "a scenarios run that does not finish in time is waited for only so long; nothing is asked, and it says what asks later",
    );
    const limitedWait = await run({ scenarios: [{ result: "success", pollsUntilDone: 50 }], limited: true });
    t.ok(
      limitedWait.r.code === 0 && /GitHub stopped answering for a while .*the wait ends here/.test(limitedWait.r.stdout) && !told(limitedWait).length,
      "a wait that GitHub refuses for its rate limit ends at once, and nothing is asked",
    );
    const scenariosFailed = await run({ scenarios: [{ result: "failure" }] });
    t.ok(scenariosFailed.r.code === 0 && !told(scenariosFailed).length && scenariosFailed.staging.status === "installed", "a healthy install whose scenarios failed is installed, and asks nothing");
    t.ok(
      told(broke).length === 1 && /^2\.0\.0-beta\.7 is not healthy on your server: its install did not finish well\.$/.test(told(broke)[0].summary) && !!(broke.staging.told || {}).failed,
      `an install that fails tells him once, right away (${JSON.stringify(told(broke)[0] && told(broke)[0].summary)})`,
    );

    // ---- the dry run prints the exact commands and changes nothing
    const dry = await run({ args: ["--dry-run"] });
    t.ok(
      dry.r.code === 0 &&
        !dry.staging &&
        dry.ssh.calls().every((c) => c.op === "look") &&
        dry.r.stdout.includes(`GODSPEED_PRODUCT_REF=${dry.seed.mainCommit} GODSPEED_STARTER_REF=${dry.seed.mainCommit}`) &&
        dry.r.stdout.includes("env -u GODSPEED_DIR PATH=/root/.local/bin:$PATH") &&
        dry.r.stdout.includes(`printf '%s\\n' 'candidate/${VERSION}'`),
      `--dry-run only looks at the server, records nothing and prints the exact commands (exit ${dry.r.code}, ops ${dry.ssh.calls().map((c) => c.op).join(",")})`,
    );
    t.ok(
      dry.r.stdout.includes(`(now ${S.MODEL_COMMAND})`) && dry.r.stdout.includes("--workspace /root/godspeed --describe") && !dry.ssh.state().addonAiChecks,
      "--dry-run prints the add-ons' AI check it would make, and does not make it",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(t.failures ? `${t.failures} self-test check(s) failed.` : "All stage-server self-tests passed.");
  return t.failures ? 1 : 0;
}

test("stage-server self-test", async () => {
  assert.equal(await selfTest(), 0);
});

await runCases();
