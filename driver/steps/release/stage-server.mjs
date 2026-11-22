#!/usr/bin/env node
// Puts one frozen candidate on the maintainer's own server (process.md, section 7, condition 3;
// roles/release.md). freeze.mjs runs it right after it froze the product.
//
//   node stage-server.mjs <owner/repo> <version> [--release <id>] [--dry-run]
//
// It reads stage.json at the tag candidate/<version> from outside, checks the server answers
// healthy and no install is running there, installs the candidate's product commit with the
// product's own native installer (staging.mjs says how and why), waits for it, writes the stage
// file and the ref it came from (candidate/<version>) beside the installation as the public install
// line does, and checks the notebook now answers healthy with <version> and the same instance as
// before, and that the add-ons still reach the AI through godspeed-model (staging.mjs, addonAi; on
// 26 October an install the notebook called healthy left every add-on without it). Then it records
// releases/<release>/staging.json in godspeed-dev: version, machine, product
// commit, the time the install was done (UTC, the server's clock), health before and after, and
// where the installer put its backup, with status "installed". An install that fails is recorded
// as failed, so the status line says so, and the maintainer gets one message naming it. A healthy
// install is checked once more right away together with its scenarios (staging-check.mjs), so he
// is asked whether to make it public as soon as they have passed too. A dry run checks everything
// it can without changing anything, and prints the exact commands it would run on the server.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.mjs";
import * as R from "./release-api.mjs";
import * as G from "./staging.mjs";
import { cfg, configureFromEnv } from "./config.mjs";
import { stagingCheck, tellOnce } from "./staging-check.mjs";

export const THIS_FILE = fileURLToPath(import.meta.url);

export const USAGE = `usage:
  node stage-server.mjs <owner/repo> <version> [--release <id>] [--dry-run]
  (the self-test is in the Forge's test folder)`;

export async function stageServer({ ownerRepo, version, release, dryRun, env, log }) {
  if (ownerRepo.toLowerCase() !== G.PRODUCT_REPO.toLowerCase()) {
    R.refuse(`Only ${G.PRODUCT_REPO} is put on your server; ${ownerRepo} is not it, so nothing was changed.`);
  }
  log(`Putting ${version} of ${ownerRepo} on your server (${G.SERVER})${dryRun ? ". This is a dry run: it reads everything and changes nothing." : "."}`);

  const candidate = await G.candidateStage(env, ownerRepo, version);
  const commit = candidate.stage.productCommit;
  log(`  ${candidate.tag} is commit ${candidate.tagCommit.slice(0, 7)}, read from outside; its stage file names product commit ${commit.slice(0, 7)}.`);

  const records = new G.Records(env);
  const id = records.findRelease(ownerRepo, version, release);
  log(`  Its record goes into the records repository's ${G.stagingPath(id)}.`);

  const before = G.look(env);
  if (!before.reachable) R.refuse(`Your server (${G.SERVER}) could not be reached (${before.why}), so ${version} was not put on it.`);
  if (!before.health || before.health.ok !== true) {
    R.refuse(`The notebook on your server does not answer as healthy now (${G.healthWords(before.health)}), so ${version} was not put on it: a candidate is staged on a server that works, or its install there proves nothing.`);
  }
  if (before.installing > 0) R.refuse(`An install is already running on your server, so ${version} was not put on it; run this again when it has finished.`);
  log(`  Your server answers: ${G.healthWords(before.health)}; it runs product commit ${before.commit.slice(0, 7) || "(none recorded)"}, installed from ${before.stageRef || "no recorded stage"}.`);

  // The server takes every version merged into main by itself (follow-main.mjs), so it often runs
  // the candidate's commit already, healthy; then it is not installed again, only recorded and
  // checked as if it had just been installed (the maintainer's yes of 27 October 2026: freeze
  // without X30). Healthy here is the notebook's word; the add-ons' AI is checked after, as always.
  const alreadyRuns = before.commit === commit && before.health.version === version;
  if (alreadyRuns) log(`  Your server already runs ${version}'s commit ${commit.slice(0, 7)}, since ${before.commitSince || "a time it does not say"}, so it is not installed again.`);
  const pin = G.pinScript({ version, commit, tag: candidate.tag, at: before.now });
  const install = G.installScript({ ownerRepo, version, commit });
  const writeStage = G.writeStageScript({ version, stageText: candidate.text });
  if (dryRun) {
    const wait = G.installWait(env);
    log("");
    log(`Would pin your server to ${version}, so it takes nothing more from main until ${version} is promoted or taken back:`);
    for (const line of pin.trimEnd().split("\n")) log(`  | ${line.length > 160 ? `${line.slice(0, 157)}...` : line}`);
    if (alreadyRuns) log(`Would not install: your server already runs commit ${commit.slice(0, 7)} as ${version}.`);
    else {
      log(`Would run on ${G.SERVER} (ssh ${G.SERVER} bash -s), detached, with its log in ${G.installDir(version)}/install.log:`);
      for (const line of install.trimEnd().split("\n")) log(`  | ${line}`);
      log(`Would then poll every ${Math.round(wait.poll / 1000)} seconds, for at most ${Math.round(wait.max / 60000)} minutes, until the installer writes its exit code:`);
      for (const line of G.pollScript(version).trimEnd().split("\n")) log(`  | ${line}`);
    }
    log(`Would then write the stage file read at ${candidate.tag} (${candidate.text.length} bytes, SHA-256 ${R.sha256Of(Buffer.from(candidate.text)).slice(0, 12)}) and its ref:`);
    for (const line of writeStage.trimEnd().split("\n")) log(`  | ${line.length > 160 ? `${line.slice(0, 157)}...` : line}`);
    log(`Would then ask ${G.HEALTH_URL} on the server for ok=true, version ${version} and instance ${before.health.instance} (the same as now), and the notebook's version file for ${commit}.`);
    log(`Would then check that the add-ons still reach the AI (now ${before.modelCommand || "no godspeed-model on the server"}): godspeed-model --describe names a configured AI, and one one-word request through it answers:`);
    for (const line of G.addonAiScript().trimEnd().split("\n")) log(`  | ${line}`);
    log(
      alreadyRuns
        ? `Would then record ${G.stagingPath(id)} in the records repository as one commit on main: status installed, installed at ${before.commitSince} (when your server took that commit), health before and after.`
        : `Would then record ${G.stagingPath(id)} in the records repository as one commit on main: status installed, installed at the server's clock, health before and after, the backup the installer made.`,
    );
    log("A dry run changes nothing on your server and records nothing.");
    return { dryRun: true, release: id };
  }

  // A version staged again keeps what the maintainer was already told about it: each message goes
  // once per version and outcome, never twice (staging-check.mjs, tellOnce).
  const earlier = records.json(G.stagingPath(id));
  const told = earlier && earlier.version === version && earlier.told ? { told: earlier.told } : {};
  const base = {
    ...told,
    release: id,
    repository: ownerRepo,
    version,
    tag: candidate.tag,
    stageCommit: candidate.tagCommit,
    productCommit: commit,
    machine: G.SERVER,
    installLog: `${G.installDir(version)}/install.log`,
    healthBefore: before.health,
    commitBefore: before.commit,
  };
  const recordFailed = async (failure, extra = {}) => {
    const record = {
      ...base,
      ...extra,
      status: "failed",
      failedAt: G.isoOf(Date.now()),
      failures: [failure],
      lastCheck: { at: G.isoOf(Date.now()), result: "failed", checked: [], failures: [failure], notes: [] },
    };
    records.write({ [G.stagingPath(id)]: G.recordText(record) }, `Staging ${version} on your server failed: ${failure.slice(0, 120)}`);
    await tellOnce({ records, id, version, env, log });
    R.refuse(`${failure} The record says so in ${G.stagingPath(id)}.`);
  };

  // The pin first, so the server takes nothing more from main while the candidate waits.
  const pinned = G.onServer(env, pin, { timeoutMs: 60000 });
  if (pinned.code !== 0 || !G.keyValues(pinned.stdout).pin) {
    R.refuse(`Your server could not be pinned to ${version} (${pinned.error || pinned.stderr.trim().split("\n").pop() || `exit ${pinned.code}`}), so it was not put on it: without the pin it would go on taking new versions from main.`);
  }
  log(`  Pinned your server to ${version} (${G.PIN_ON_SERVER}): it takes nothing more from main until ${version} is promoted or taken back.`);

  let done;
  if (alreadyRuns) {
    done = { exit: 0, backup: "" };
    base.foundRunning = { since: before.commitSince || null };
    base.installLog = null;
  } else {
    const installed = await G.installAt(env, { ownerRepo, version, commit, log });
    if (!installed.started) R.refuse(`The install of ${version} could not be started on your server (${installed.why}); nothing was recorded.`);
    done = installed.done;
    if (!done) {
      await recordFailed(`The installer of ${version} had not finished on your server after ${installed.minutes} minutes; its log is ${base.installLog}.`);
    }
    if (done.exit !== 0) {
      await recordFailed(`The installer of ${version} exited ${done.exit} on your server (an installer that stops halfway starts the notebook that ran before again); its last lines: ${done.tail.split("\n").slice(-3).join(" | ").slice(0, 400)}`, { backup: done.backup || null });
    }
    log(`The installer exited 0${done.backup ? `; it made its backup at ${done.backup}` : ""}.`);
  }

  const wrote = G.onServer(env, writeStage, { timeoutMs: 60000 });
  const wroteKv = G.keyValues(wrote.stdout);
  const want = R.sha256Of(Buffer.from(candidate.text));
  if (wrote.code !== 0 || wroteKv.stage_sha256 !== want || wroteKv.stage_ref !== candidate.tag) {
    await recordFailed(`The stage file of ${version} could not be written beside the installation on your server (it reads SHA-256 ${wroteKv.stage_sha256 || "nothing"} and ref ${wroteKv.stage_ref || "nothing"}, not ${want.slice(0, 12)} and ${candidate.tag}).`, { backup: done.backup || null });
  }
  log(`  Wrote ${G.GODSPEED_ON_SERVER}/.godspeed/stage.json (the stage read at ${candidate.tag}, SHA-256 ${want.slice(0, 12)}) and stage-ref ${candidate.tag}.`);

  // The notebook as that version and the same instance, then whether the add-ons still reach the AI
  // (staging.mjs, checkAfter).
  const { after, problems, addonAi } = G.checkAfter(env, { before, version, commit });
  if (problems.length) {
    await recordFailed(`After the install, ${problems.join("; ")}.`, { backup: done.backup || null, healthAfter: after.health || null, ...(addonAi ? { addonAi } : {}) });
  }
  log(`  ${G.addonAiWords(addonAi)}`);

  const record = {
    ...base,
    // Found already running: since the server took that commit, by the server's own clock.
    installedAt: alreadyRuns ? before.commitSince || after.now : after.now,
    backup: done.backup || null,
    healthAfter: after.health,
    addonAi,
    status: "installed",
    failures: [],
    scenarios: null,
    lastCheck: null,
  };
  const at = records.write({ [G.stagingPath(id)]: G.recordText(record) }, `${version} runs on your server since ${record.installedAt}, healthy`);
  log(`Recorded ${G.stagingPath(id)} in the records repository${at ? ` (commit ${at.slice(0, 7)} on main)` : ""}.`);
  log(`${version} runs on your server since ${record.installedAt} (UTC), same instance, healthy.`);

  // Right away, not the next morning: once its scenarios have passed as well, he is asked. A
  // scenarios run on the tag that is still going is waited for, for a while; none at all is not.
  await askWhenReady({ ownerRepo, version, id, records, env, log });
  const now = records.json(G.stagingPath(id));
  if (now && now.status === "failed") {
    R.refuse(`${version} was installed on your server, but the check right after found it not healthy there: ${(now.failures || [])[0] || "see its record"} The record says so in ${G.stagingPath(id)}.`);
  }
  return { record: now, release: id };
}

export const scenarioWait = (env) => ({
  poll: /^\d+$/.test(env.STAGING_SCENARIOS_POLL_MS || "") ? Number(env.STAGING_SCENARIOS_POLL_MS) : 2 * 60 * 1000,
  max: /^\d+$/.test(env.STAGING_SCENARIOS_MAX_MS || "") ? Number(env.STAGING_SCENARIOS_MAX_MS) : 30 * 60 * 1000,
});

// The check with its scenarios, and the one message if it is due. Whatever goes wrong here, the
// install is already recorded, so it is said, and the next check (staging-check.mjs --tell, or the
// morning run) does the rest.
export async function askWhenReady({ ownerRepo, version, id, records, env, log }) {
  const later = `node ${path.join(path.dirname(THIS_FILE), "staging-check.mjs")} ${ownerRepo} ${version} --tell`;
  try {
    const { poll, max } = scenarioWait(env);
    const since = Date.now();
    const sc = await G.scenariosOrUnread(env, ownerRepo, version);
    if (sc.result === "running") {
      log(`The scenarios on ${sc.tag} are still running (${sc.url || `run ${sc.run}`}); waiting up to ${Math.round(max / 60000)} minutes for them, so you are asked as soon as they pass.`);
      // One anonymous request per look, at most 16 in the 30 minutes: GitHub allows 60 an hour.
      // A look that fails is looked again; a refusal for the rate stops the wait.
      while (Date.now() - since < max) {
        await G.sleep(poll);
        const run = await G.scenarioRunState(env, ownerRepo, sc.run);
        if (run.limited) {
          log(`  GitHub stopped answering for a while (${run.why}), so the wait ends here.`);
          break;
        }
        if (run.completed) break;
      }
    }
    log("");
    log(`Checking it with its scenarios now (staging-check.mjs), so you are asked as soon as both hold:`);
    try {
      const r = await stagingCheck({ ownerRepo, version, release: id, dryRun: false, env, log: (s) => log(`  ${s}`) });
      if (r.result === "waiting") log(`You are asked once its scenarios have passed: start them on ${G.SCENARIOS_WORKFLOW} with --ref candidate/${version} -f stage=candidate/${version} if they are not running, then run ${later}.`);
    } catch (e) {
      if (!(e instanceof R.Refused)) throw e;
      log(`  ${e.message}`);
    }
    await tellOnce({ records, id, version, env, log });
  } catch (e) {
    log(`The check right after the install could not run (${e.message}); ${version} is recorded as installed, and ${later} does the rest.`);
  }
}

export async function main(argv, env = process.env) {
  let args;
  try {
    args = parseArgs(argv, new Set(["release"]), new Set());
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  const { pos, opt } = args;
  const unknown = Object.keys(opt).filter((k) => !["release", "dry-run"].includes(k));
  if (unknown.length) {
    console.error(`stage-server does not know the option --${unknown[0]}.\n${USAGE}`);
    return 2;
  }
  const [ownerRepo, version] = pos;
  if (!ownerRepo || !/^[^/\s]+\/[^/\s]+$/.test(ownerRepo) || !version) {
    console.error(USAGE);
    return 2;
  }
  if (!R.VERSION_PATTERN.test(version)) {
    console.error(`${version} does not look like a version (2.0.0-beta.8).\n${USAGE}`);
    return 2;
  }
  try {
    await stageServer({ ownerRepo, version, release: typeof opt.release === "string" ? opt.release : null, dryRun: !!opt["dry-run"], env, log: (s) => console.log(s) });
    return 0;
  } catch (e) {
    if (e instanceof R.Refused) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === THIS_FILE.toLowerCase();
if (isMain) {
  configureFromEnv();
  process.exitCode = await main(process.argv.slice(2));
}
