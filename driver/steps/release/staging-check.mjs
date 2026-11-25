#!/usr/bin/env node
// Checks a candidate on the maintainer's own server and whether its proving scenarios passed
// (process.md, section 7, conditions 1 and 3; roles/release.md), and records what it found in
// releases/<release>/staging.json.
//
//   node staging-check.mjs <owner/repo> <version> [--release <id>] [--tell [--later <n>]] [--dry-run]
//   node staging-check.mjs --open [--tell] [<owner/repo>]
//
// --later <n>: the candidate's tests before the go left out n slow ones that run once after it is public (the stage step's
// short run, 25 November 2026); the question says so, so "every scenario passed" is not read as "every test ran".
//
// All read now: the notebook on the server still runs <version> (its health and its version file),
// healthy, as the same instance it was installed as, with a scheduler heartbeat less than 15 minutes
// old; the add-ons still reach the AI through godspeed-model, which describes a configured AI and
// answers one tiny real request (staging.mjs, addonAi; asked only once the notebook itself is
// right); and the newest run of the product's scenarios on the candidate's own tag (staging.mjs,
// scenarios), read from outside. What the scenarios said is recorded ("scenarios"), and promote.mjs
// reads it. A server no longer on the candidate, or no longer healthy, is recorded as failed with
// its exact sentences, and stays failed until the candidate is installed again. A server that
// cannot be reached changes nothing but the last check.
//
// There is no night and no waiting time of any kind (the maintainer, 26 October 2026: "switch us to
// the simple version without the night"). stage-server.mjs runs this right after the install; the
// release step runs it with --tell as soon as the scenarios have finished; and --open is the morning
// run on X30 (scripts/release/staging-daily.sh): the newest candidate tag newer than the public
// stage, if it was put on the server. With --tell it also sends the maintainer one message the first
// time the candidate is healthy on his server with every scenario passed, asking whether to make it
// public, and one the first time its install is found not healthy (tellOnce, below). Never twice.
//
// Exit: 0 ready (healthy on the server, every scenario passed); 3 healthy, and the scenarios have not
// passed yet (none has run on its tag, or one is still running); 1 not healthy, a scenario failed,
// not checked, or refused; 2 usage. A dry run makes every read and prints what it would record, and
// records nothing; without a staging record it takes the install time from the server's own record
// of when its notebook version was installed, and says so.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.mjs";
import * as R from "./release-api.mjs";
import * as G from "./staging.mjs";
import { cfg, configureFromEnv } from "./config.mjs";
import { readDeferrals, deferredWords } from "./scope-amendment.mjs";

export const THIS_FILE = fileURLToPath(import.meta.url);
export const MINUTE = 60 * 1000;

export const USAGE = `usage:
  node staging-check.mjs <owner/repo> <version> [--release <id>] [--tell [--later <n>]] [--dry-run]
  node staging-check.mjs --open [--tell] [<owner/repo>]
  (the self-test is in the Forge's test folder)`;

export const EXIT = { ready: 0, waiting: 3, failed: 1, scenariosFailed: 1, unchecked: 1 };

// What the server shows now, against what was installed.
export function judgeServer({ version, staging, server }) {
  const checked = [];
  const failures = [];
  const nowMs = Date.parse(server.now);
  const h = server.health;
  const instance = staging.healthAfter && staging.healthAfter.instance;
  if (!h) failures.push("The notebook on your server did not answer its health address.");
  else {
    if (h.ok !== true) failures.push(`The notebook on your server does not say it is healthy (ok=${h.ok}).`);
    if (h.version !== version) failures.push(`Your server runs ${h.version}, not ${version}.`);
    if (instance && h.instance !== instance) failures.push(`The notebook on your server is instance ${h.instance}, not ${instance} as it was installed.`);
    const beat = Date.parse(h.scheduler_heartbeat || "");
    if (!beat || nowMs - beat > G.HEARTBEAT_MINUTES * MINUTE) {
      failures.push(`The notebook's scheduler last beat at ${h.scheduler_heartbeat || "no time at all"}, more than ${G.HEARTBEAT_MINUTES} minutes before the server's clock (${server.now}).`);
    }
  }
  if (staging.productCommit && server.commit !== staging.productCommit) {
    failures.push(`The notebook's version file on your server names ${server.commit || "nothing"}, not ${staging.productCommit}.`);
  }
  if (!failures.length) {
    const beatAgo = Math.max(0, Math.round((nowMs - Date.parse(h.scheduler_heartbeat)) / MINUTE));
    checked.push(`Your server runs ${version} (product commit ${String(server.commit).slice(0, 7)}), healthy, as instance ${h.instance}${instance ? ", the one it was installed as" : ""}; its scheduler beat ${beatAgo} minute(s) before the server's clock.`);
  }
  return { checked, failures };
}

export function scenarioWords(sc) {
  if (sc.result === "passed") return `every scenario passed against ${sc.tag} (${sc.url || `run ${sc.run}`})`;
  if (sc.result === "failed") return `the scenarios on ${sc.tag} ended ${sc.conclusion} (${sc.url || `run ${sc.run}`})`;
  if (sc.result === "running") return `the scenarios on ${sc.tag} are still running (${sc.url || `run ${sc.run}`})`;
  if (sc.result === "none") {
    const start = `start them on the tag itself: gh workflow run ${G.SCENARIOS_WORKFLOW} --ref ${sc.tag} -f stage=${sc.tag}`;
    if (!sc.ignored) return `no scenarios have run on ${sc.tag} yet (${start})`;
    return `no scenarios that count have run on ${sc.tag} yet. ${sc.ignored} So ${start}`;
  }
  return `the scenarios could not be read (${sc.problem})`;
}

export async function stagingCheck({ ownerRepo, version, release, dryRun, env, log }) {
  log(`Checking ${version} of ${ownerRepo} on your server (${G.SERVER}) and its scenarios${dryRun ? ". This is a dry run: it makes every read and records nothing." : "."}`);
  const records = new G.Records(env);
  const id = records.findRelease(ownerRepo, version, release);
  let staging = records.json(G.stagingPath(id));
  if (staging && staging.version !== version) R.refuse(`${G.stagingPath(id)} is the record of ${staging.version}, not ${version}, so there is nothing of ${version} to check.`);
  if (!staging && !dryRun) {
    R.refuse(`There is no record that ${version} was put on your server (${G.stagingPath(id)}), so there is nothing to check; stage-server.mjs puts it there.`);
  }
  if (staging && staging.status === "failed") {
    R.refuse(`${version} is recorded as not healthy on your server since ${staging.failedAt} (${(staging.failures || [])[0] || "see its record"}); it stays so until it is installed again.`);
  }

  const server = G.look(env);
  if (!staging) {
    const candidate = await G.candidateStage(env, ownerRepo, version);
    if (!server.reachable) R.refuse(`Your server (${G.SERVER}) could not be reached (${server.why}).`);
    staging = {
      version,
      productCommit: candidate.stage.productCommit,
      installedAt: server.commitSince,
      healthAfter: { instance: server.health && server.health.instance },
      status: "installed",
    };
    log(`  There is no record of ${version} on your server in ${G.stagingPath(id)}. For this dry run the install time is the server's own record of when its notebook version was installed (${server.commitSince}), and the instance is the one it answers as now.`);
  } else {
    log(`  ${G.stagingPath(id)} says: put on your server at ${staging.installedAt}, ${staging.status}${G.scenariosPassed(staging, version) ? ", every scenario passed" : ""}.`);
  }

  const notReached = (why) => {
    const sentence = `Your server (${G.SERVER}) could not be reached (${why}), so ${version} was not checked there.`;
    if (!dryRun) {
      const next = { ...staging, lastCheck: { at: G.isoOf(Date.now()), result: "unchecked", checked: [], failures: [], problem: sentence } };
      records.write({ [G.stagingPath(id)]: G.recordText(next) }, `Check of ${version}: your server could not be reached`);
    }
    R.refuse(`${sentence} Its record says ${staging.status}, as before.`);
  };
  if (!server.reachable) notReached(server.why);
  log(`  The server's clock says ${server.now}; ${G.healthWords(server.health)}.`);

  const v = judgeServer({ version, staging, server });
  // Once the notebook itself is right: whether the add-ons still reach the AI (staging.mjs, addonAi).
  // godspeed-model gone since the install's own check found it answering is a failure too.
  const ai = v.failures.length ? null : G.addonAi(env);
  if (ai && ai.state === "unreachable") notReached(ai.why);
  if (ai) {
    const problem = G.addonAiProblem(ai, { hadCommand: !!staging.addonAi && staging.addonAi.state === "ok" });
    if (problem) v.failures.push(`${problem[0].toUpperCase()}${problem.slice(1)}.`);
    else v.checked.push(G.addonAiWords(ai));
  }
  for (const s of v.checked) log(`  Checked: ${s}`);
  for (const s of v.failures) log(`  FAILED: ${s}`);

  const sc = await G.scenariosOrUnread(env, ownerRepo, version);
  log(`  Scenarios: ${scenarioWords(sc)}.`);

  // Ready also when every failed job is outside the plan's blocking scenarios (the standing waiver of
  // 8 November 2026, staging.mjs); those jobs are named in the message to him and in the record.
  const plan = records.read(`releases/${id}/plan.md`);
  const split = sc.result === "failed" ? G.scenarioFailureSplit({ version, scenarios: sc }, plan, version) : null;
  const standing = !!split && split.blocking.length === 0 && split.nonBlocking.length > 0;
  const result = v.failures.length ? "failed" : sc.result === "unreadable" ? "unchecked" : sc.result === "passed" || standing ? "ready" : sc.result === "failed" ? "scenariosFailed" : "waiting";
  const check = { at: G.isoOf(Date.now()), serverClock: server.now, result, checked: v.checked, failures: v.failures, scenarios: sc.result, ...(standing ? { nonBlocking: split.nonBlocking } : {}) };
  if (ai) check.addonAi = ai;
  const next = { ...staging, lastCheck: check };
  // What could not be read leaves the last known scenarios as they were.
  if (sc.result !== "unreadable") next.scenarios = { ...sc, seenAt: check.at };
  let said;
  if (result === "failed") {
    Object.assign(next, { status: "failed", failedAt: check.at, failures: v.failures });
    said = `${version} is not healthy on your server: ${v.failures[0]}`;
  } else {
    said = `Check of ${version}: ${result}`;
  }

  if (dryRun) {
    log("");
    log(`Would record in ${G.stagingPath(id)}: ${next.status}, scenarios ${sc.result}, and this check as its last (${result}).`);
    log("A dry run records nothing.");
  } else {
    const at = records.write({ [G.stagingPath(id)]: G.recordText(next) }, said.slice(0, 200));
    log(`Recorded ${G.stagingPath(id)}${at ? ` (commit ${at.slice(0, 7)} on main)` : " (it already said this)"}.`);
  }

  if (result === "failed") R.refuse(said);
  if (result === "unchecked") R.refuse(`${sc.problem} So whether every scenario of ${version} passed was not checked; its record says ${next.status}, as before.`);
  if (result === "scenariosFailed") R.refuse(`${version} is healthy on your server, but ${scenarioWords(sc)}, so it is not ready to be made public.`);
  if (result === "ready") {
    log(standing ? `${version} is on your server, healthy; the scenarios that failed are not blocking by the plan: ${split.nonBlocking.map((j) => `"${j}"`).join(", ")}. It waits for your go.` : `${version} is on your server, healthy, and every scenario passed. It waits for your go.`);
    return { result, release: id, record: next };
  }
  log(`${version} is on your server, healthy; ${scenarioWords(sc)}.`);
  return { result, release: id, record: next };
}

// One candidate, then the one message if one is due.
export async function checkAndTell({ ownerRepo, version, release, tell, dryRun, env, log, later = 0 }) {
  let code;
  let id = release;
  try {
    const r = await stagingCheck({ ownerRepo, version, release, dryRun, env, log });
    code = EXIT[r.result];
    id = r.release;
  } catch (e) {
    if (!(e instanceof R.Refused)) throw e;
    console.error(e.message);
    code = 1;
  }
  if (tell && !dryRun) {
    const records = new G.Records(env);
    id = id || records.findRelease(ownerRepo, version, null);
    if (!(await tellOnce({ records, id, version, env, log, later })) && (code === 0 || code === 3)) code = 1;
  }
  return code;
}

// The morning run: the open candidate, if it was put on the server.
export async function checkOpen({ ownerRepo, tell = false, env, log }) {
  const pub = await G.publicState(env, ownerRepo);
  if (!pub.candidate) {
    log(`No candidate of ${ownerRepo} is open: the public has ${pub.publicVersion}, and there is no newer candidate tag. Nothing to check.`);
    return 0;
  }
  const records = new G.Records(env);
  let id;
  try {
    id = records.findRelease(ownerRepo, pub.candidate);
  } catch (e) {
    if (!(e instanceof R.Refused)) throw e;
    log(`${pub.candidate} is open, but ${e.message[0].toLowerCase()}${e.message.slice(1)} Nothing to check.`);
    return 0;
  }
  const staging = records.json(G.stagingPath(id));
  if (!staging || staging.version !== pub.candidate) {
    log(`${pub.candidate} is open and has not been put on your server (no ${G.stagingPath(id)} for it). Nothing to check.`);
    return 0;
  }
  return checkAndTell({ ownerRepo, version: pub.candidate, release: id, tell, dryRun: false, env, log });
}

// THE ASK COMES AS SOON AS IT CAN (the maintainer, 26 October 2026). The first time the candidate is
// healthy on his server and every scenario passed against its tag, he gets one message asking
// whether to make it public; the first time its install is found not healthy, one message naming
// what is wrong. Each once per version and outcome, never again: staging.json keeps when it was sent
// (told), and only a message that went out is marked, so one that could not be sent is tried again
// by the next check. A version he already said go for is not asked about. Returns false only when a
// message was due and could not be sent.
// The sentence about the slow tests that run after the go (later: how many), or "".
export const laterWords = (later) => {
  const n = Number(later) || 0;
  if (n <= 0) return "";
  return ` ${n === 1 ? "One slow test runs" : `${n === 2 ? "Two" : n} slow tests run`} once right after it is public; a failure there is filed as a bug and holds nothing back.`;
};

export async function tellOnce({ records, id, version, env, log, later = 0 }) {
  const staging = records.json(G.stagingPath(id));
  if (!staging || staging.version !== version) return true;
  const told = staging.told || {};
  let outcome;
  let message;
  // Only a run where every scenario passed asks him by itself. When only older, non-blocking scenarios failed,
  // Mission Control brings him the exact result with each failure's one-line cause (process.md, section 7).
  const ready = G.installedHealthy(staging, version) && G.scenariosPassed(staging, version) && !!staging.lastCheck && staging.lastCheck.result === "ready";
  // told.passed is what the code before 26 October 2026 evening wrote once it had asked him.
  if (ready && !told.ready && !told.passed) {
    if (G.goHolds(records.json(G.goPath(id)), staging, version)) return true;
    outcome = "ready";
    // What changed, in the plan's own words: its title after "Godspeed <version>: ".
    const title = (String(records.read(`releases/${id}/plan.md`) || "").match(/^# .*?\d+\.\d+\.\d+\S*:\s*(.+?)\s*$/m) || [])[1];
    // Whatever left the release (a person's decision or the plan's dead-end rule) is named, so "every scenario passed" is not read as "everything came".
    const plan = records.read(`releases/${id}/plan.md`) || "";
    const moved = typeof records.ticketFiles === "function"
      ? deferredWords(plan, readDeferrals(records.json(`releases/${id}/scope-amendment.json`), { id, version, plan, ticketNames: records.ticketFiles(id) }, { strictPerson: false }).deferred)
      : [];
    // A question he was asked and did not answer by its deadline got its default (the factory driver,
    // releases/<id>/defaults-applied.json): named here, so his "go" also covers what was decided for him.
    const defaults = ((records.json(`releases/${id}/defaults-applied.json`) || {}).applied || [])
      .filter((a) => a && a.default).map((a) => `${String(a.heading || `#${a.issue}`).replace(/\s*\(#\d+\)\s*$/, "")}: ${a.default}`);
    message = {
      summary: `${version} is on your server, healthy, and every scenario passed.${title ? ` What changed: ${title}.` : ""}${moved.length ? ` Moved to the next release: ${moved.join("; ")}.` : ""}${defaults.length ? ` Decided by default because no answer came in time: ${defaults.join("; ")}.` : ""}${laterWords(later)} Shall I make it public?`,
      status: "ready for your go",
      act: 'Answer "go", "go, and these later" or "stop, these first".',
    };
  } else if (staging.status === "failed" && !told.failed) {
    outcome = "failed";
    message = {
      summary: `${version} is not healthy on your server: ${G.failureWords(staging)}.`,
      status: "install not healthy",
      act: "Nothing goes public. Say if you want it fixed and put on your server again.",
    };
  } else return true;
  const r = G.onServer(env, G.tellScript(message), { timeoutMs: 240000 });
  const kv = G.keyValues(r.stdout);
  if (r.code !== 0 || kv.notify_exit !== "0") {
    log(`The message to you about ${version} could not be sent (${r.error || r.stderr.trim().split("\n").pop() || `notify exit ${kv.notify_exit || "unknown"}`}); the next check tries again.`);
    return false;
  }
  // The record as it is now, not as it was before the send: a check may have written it meanwhile.
  records.fetch();
  const latest = records.json(G.stagingPath(id)) || staging;
  records.write(
    { [G.stagingPath(id)]: G.recordText({ ...latest, told: { ...(latest.told || {}), [outcome]: G.isoOf(Date.now()) } }) },
    `Told ${cfg.ownerName} once: ${version} ${outcome === "ready" ? "is ready, shall it go public" : "is not healthy on his server"}`,
  );
  log(`Sent you one message: ${message.summary}`);
  return true;
}

export async function main(argv, env = process.env) {
  let args;
  try {
    args = parseArgs(argv, new Set(["release", "later"]), new Set());
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  const { pos, opt } = args;
  const unknown = Object.keys(opt).filter((k) => !["release", "dry-run", "open", "tell", "later"].includes(k));
  if (unknown.length) {
    console.error(`staging-check does not know the option --${unknown[0]}.\n${USAGE}`);
    return 2;
  }
  const log = (s) => console.log(s);
  try {
    if (opt.open) {
      const ownerRepo = pos[0] || G.PRODUCT_REPO;
      if (!/^[^/\s]+\/[^/\s]+$/.test(ownerRepo) || pos.length > 1) {
        console.error(USAGE);
        return 2;
      }
      return await checkOpen({ ownerRepo, tell: !!opt.tell, env, log });
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
    if ("later" in opt && !/^\d+$/.test(String(opt.later))) {
      console.error(`--later needs the number of slow tests that run after the go.\n${USAGE}`);
      return 2;
    }
    return await checkAndTell({ ownerRepo, version, release: typeof opt.release === "string" ? opt.release : null, tell: !!opt.tell, dryRun: !!opt["dry-run"], env, log, later: Number(opt.later || 0) });
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
