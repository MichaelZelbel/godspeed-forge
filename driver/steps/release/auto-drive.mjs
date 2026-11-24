// What auto-stage does when the scenarios of a frozen candidate fail. Deterministic, no AI.
//
//   1. A failed scenario that also failed on main's nightly within the last 3 nights, or whose log
//      names a test-machine cause, does not block: it is named in the message and staging goes on
//      (the plan's standing rule: "Every other failing job is named with its cause and does not block").
//   2. A blocking failure is traced to ONE merged pull request of the release: by the plan's
//      "Blocking scenarios" section (which item a scenario belongs to) or, only when the plan places
//      the scenario nowhere, by the files the failing test's FAIL or error lines name. That pull request
//      is reverted on main (a revert pull request, squash-merged once `required` passes) and its ticket
//      leaves the release through a plan-rule amendment (decidedBy "auto-stage", scope-amendment.mjs).
//      The rebuild itself is NOT cut from main: the branch release/<release version> is made at the
//      failed candidate's own commit, one pull request into it takes the same change out and sets the
//      next candidate version (2.0.0-beta.26.1, then .2), it merges once `required` passes, and the
//      candidate is frozen from that merge. So main may move on meanwhile (the factory, the release
//      driver and keep-main-green all merge into it) and the rebuild still carries only what was tested
//      minus the change. A second rebuild goes on the same branch, from the first rebuild's commit.
//   3. At most 2 re-freezes per release. When the failure cannot be traced to one pull request, the
//      cap is reached, the release would be left empty, or a step fails or waits too long, nothing more
//      is done and he is told once, plainly. No scenario is ever loosened, skipped or renamed here.
//   4. Never promotes, never records his go.
//
// Everything outside (GitHub, git, the freeze) comes in through `d`, so each case is tested with stand-ins.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { amendmentEntries } from "./scope-amendment.mjs";
import { releaseBranch } from "./release-api.mjs";

export const MAX_REFREEZES = 2;
export const DRIVER = "auto-stage";
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const MAIN_NIGHTS = 3;
// How long one step may wait for GitHub before it is given up with a message (the checks of a pull
// request, the Windows setup of the new head).
const WAIT_LIMIT = { "revert-wait": 4 * HOUR, "release-wait": 4 * HOUR, freeze: 3 * HOUR };

// 2.0.0-beta.26 -> 2.0.0-beta.26.1 (n = how many re-freezes were made before this one)
export const nextCandidate = (base, n) => `${base}.${n + 1}`;

const squash = (t) => String(t || "").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();

// The plan's own dead-end rule, as the plan words it (whitespace collapsed), or null when the plan has none.
export function planRuleWords(plan) {
  const m = squash(plan).match(/an item that reaches a dead end leaves the release, the rest ships/i);
  return m ? m[0] : null;
}

export const planStatusLine = (plan) => (String(plan || "").match(/^\s*status:\s*approved\b.*$/im) || [])[0]?.trim() || null;

// ---------- 1. which failures block ----------

// failures: [{job, cause: {plain, environment}, mainDates: [iso], blocking: in the plan's list}]
// -> the same, each with `waive`: why it does not block (or null), `holds`: whether it blocks, and
// `recentMain`: the nights within the window it failed on main.
// listed is false when the plan names no blocking scenarios: then every failure counts as blocking,
// because without a list the plan's rule is that every scenario must pass.
export function judgeFailures({ failures, nowMs, listed }) {
  return failures.map((f) => {
    const recentMain = (f.mainDates || []).filter((d) => nowMs - Date.parse(d) <= (MAIN_NIGHTS + 0.5) * DAY && nowMs >= Date.parse(d) - DAY);
    let waive = null;
    if (listed && !f.blocking) waive = "it is not one of the plan's blocking scenarios";
    else if (recentMain.length) waive = `it also failed on main's nightly tests in the last ${MAIN_NIGHTS} nights, so it is not new with this release`;
    else if (f.cause && f.cause.environment) waive = `its log names a test-machine cause (${f.cause.plain})`;
    return { ...f, waive, holds: !waive, recentMain };
  });
}

// ---------- 2. which pull request ----------

const words = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 3);

// The plan's "Blocking scenarios" bullets as segments: [{name, items: [n], ids: [[from, to]]}].
// "(items 1, 6)" after a name says which plan items the scenario belongs to; "H-19..H-26 (items 2, 3)"
// is a range of hidden scenarios.
export function blockingSegments(plan) {
  const lines = String(plan || "").split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*(?:[-*]\s*)?(?:\*\*)?Blocking scenarios:/i.test(l));
  if (at < 0) return [];
  const bullets = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*[-*]\s+/.test(l)) bullets.push(l.replace(/^\s*[-*]\s+/, ""));
    else if (/^\s+\S/.test(l) && bullets.length) bullets[bullets.length - 1] += ` ${l.trim()}`; // a wrapped line
    else if (l.trim() === "" && !bullets.length) continue;
    else break;
  }
  const out = [];
  for (const b of bullets) {
    const text = b.replace(/[`*]/g, "");
    const re = /([^()]*?)\(([^()]*)\)/g;
    let m;
    let last = 0;
    while ((m = re.exec(text))) {
      last = re.lastIndex;
      const items = [...(m[2].match(/\bitems?\s+([\d,\s]+(?:and\s+\d+)?)/i)?.[1] || "").matchAll(/\d+/g)].map((x) => Number(x[0]));
      out.push(segment(m[1], items));
    }
    if (text.slice(last).replace(/[,.\s]/g, "")) out.push(segment(text.slice(last), []));
  }
  return out;
}

function segment(rawName, items) {
  const name = rawName.replace(/^[,;\s]+|[\s.,;]+$/g, "");
  const ids = [...name.matchAll(/\bH-?(\d+)(?:\s*\.\.\s*H?-?(\d+))?/gi)].map((x) => [Number(x[1]), Number(x[2] || x[1])]);
  return { name, items, ids };
}

// Whether the plan places a failed job at all (some segment matches it), and the plan items it names.
export function placeJob(job, segments) {
  const j = String(job).toLowerCase();
  const items = new Set();
  let placed = false;
  for (const s of segments) {
    const n = Number((j.match(/\bh-?(\d+)\b/i) || [])[1]);
    const byId = n && s.ids.some(([a, b]) => n >= a && n <= b);
    const w = words(s.name);
    const shared = w.filter((x) => j.includes(x)).length;
    const byName = w.length >= 2 && (j.includes(s.name.toLowerCase()) || (shared >= Math.min(3, w.length) && shared / w.length >= 0.6));
    if (byId || byName) {
      placed = true;
      for (const i of s.items) items.add(i);
    }
  }
  return { placed, items: [...items].sort((a, b) => a - b) };
}

export const itemsForJob = (job, segments) => placeJob(job, segments).items;

// Paths the failing test's own FAIL, error and stack lines name (not every path a log mentions: the
// log also names the scenario runner's files, which prove nothing).
export function pathsInLog(logText) {
  const found = new Set();
  const lines = String(logText || "").split("\n").filter((l) => /\bFAIL\b|Error|##\[error\]|^\s*at\s/.test(l));
  for (const l of lines) {
    for (const m of l.matchAll(/(?:^|[\s("'=:@])((?:[\w.-]+\/)+[\w.-]+\.(?:mjs|cjs|js|ts|tsx|json|py|sh|md|yml|yaml|html|css))\b/g)) found.add(m[1].replace(/^\.\//, ""));
  }
  return [...found];
}

// -> {ok: true, pr: {number, commit, title}, items: [n], tickets: [file], how} | {ok: false, why}
// itemPulls: {item: {number, commit, title}} the merged pull request of each plan item that is still in
// the release (a ticket already moved out is left out by the caller, so a second look never points at it).
// pullFiles: {number: [paths]} the files each of those pull requests changed.
// logs: {job: log text}. ticketOfItem: {item: ticket file name}.
export function traceCulprit({ holding, plan, itemPulls, pullFiles, logs, ticketOfItem }) {
  const segments = blockingSegments(plan);
  const byNumber = new Map();
  for (const [item, pr] of Object.entries(itemPulls)) {
    if (!pr || !pr.number || !pr.commit) continue;
    if (!byNumber.has(pr.number)) byNumber.set(pr.number, { pr, items: [] });
    byNumber.get(pr.number).items.push(Number(item));
  }
  const chosen = new Map();
  let how = "the plan's list of blocking scenarios";
  for (const f of holding) {
    const { items } = placeJob(f.job, segments);
    let prs;
    if (items.length) {
      // The plan places the scenario: its items decide, and only those (no guessing across the release).
      prs = [...new Set(items.filter((i) => itemPulls[i] && itemPulls[i].commit).map((i) => itemPulls[i].number))];
      if (!prs.length) return { ok: false, why: `"${f.job}" belongs to plan items that have no change left in the release to take out` };
      if (prs.length > 1) return { ok: false, why: `"${f.job}" belongs to items delivered by ${prs.length} different changes, so I cannot tell which one broke it` };
    } else {
      // The plan places it nowhere: the one change that touched a file the failing test names.
      const named = pathsInLog(logs[f.job]);
      prs = [...byNumber.keys()].filter((n) => (pullFiles[n] || []).some((file) => named.some((p) => file === p || file.endsWith(`/${p}`) || p.endsWith(`/${file}`))));
      if (prs.length !== 1) return { ok: false, why: `I cannot tell which change of this release made "${f.job}" fail` };
      how = "the files the failing test names";
    }
    chosen.set(prs[0], true);
  }
  if (chosen.size !== 1) return { ok: false, why: `the failing tests point at ${chosen.size} different changes, not one` };
  const number = [...chosen.keys()][0];
  const { pr, items } = byNumber.get(number);
  const tickets = items.map((i) => ticketOfItem[i]).filter(Boolean);
  if (!tickets.length) return { ok: false, why: `the change that broke it (#${number}) belongs to no ticket of the release` };
  return { ok: true, pr, items, tickets, how };
}

// ---------- the amendment ----------

// The scope-amendment.json text with one more entry from auto-stage. A person's entry is never touched.
export function withAmendment(existingText, entry) {
  let file = null;
  try {
    file = existingText ? JSON.parse(existingText) : null;
  } catch {
    file = null;
  }
  if (existingText && !file) throw new Error("scope-amendment.json is not JSON, so nothing is added to it");
  const out = file && typeof file === "object" ? { ...file } : { release: entry.release, version: entry.version };
  out.amendments = [...(Array.isArray(out.amendments) ? out.amendments : []), entry];
  return `${JSON.stringify(out, null, 2)}\n`;
}

export const alreadyDeferred = (file) => amendmentEntries(file).flatMap((e) => e.deferredTickets || []);

// A ticket that was delivered and is now taken out again no longer says "done": freeze counts a ticket
// with a done line and a merge on main as in the release, so its status says where it went.
export function movedStatus(body, { pr, revertPr }) {
  const line = `Status: moved to the next release (change #${pr} was taken out of main by #${revertPr})`;
  const text = String(body || "");
  return /^Status:.*$/im.test(text) ? text.replace(/^Status:.*$/im, line) : `${line}\n\n${text}`;
}

// ---------- the messages ----------

// One plain sentence on why nothing more was done, added to the failure message.
export const stoppedWords = (why) => `I did not take anything out by myself: ${why}.`;
export const exhaustedWords = (n) => `I took changes out and built a new version ${n} time${n === 1 ? "" : "s"} already and the test still fails, so I stop here and make nothing public.`;

// ---------- the steps ----------

// rs.drive: {phase, n, candidate, from, culprit, revert, release, next, waitingSince}. One call goes as far as it can and
// returns {outcome} ("waiting", "drive-stopped" or "refrozen"). d: the outside, see auto-drive-real.mjs
// and the tests. stop(why) tells him once and ends the drive.
export async function driveStep({ d, id, base, plan, rs, save, log, now, repo, stop }) {
  const drive = rs.drive;
  const waited = (phase) => {
    drive.waitingSince ||= {};
    drive.waitingSince[phase] ||= new Date(now()).toISOString();
    save();
    return now() - Date.parse(drive.waitingSince[phase]);
  };
  for (let guard = 0; guard < 8; guard++) {
    switch (drive.phase) {
      case "revert-start": {
        const r = await d.startRevert({ number: drive.culprit.number, commit: drive.culprit.commit, why: drive.culprit.why });
        if (r.cannot) return stop(`taking change #${drive.culprit.number} back out of main was not possible (${r.cannot})`);
        drive.revert = { pr: r.pr, head: r.head, openedAt: new Date(now()).toISOString() };
        drive.phase = "revert-wait";
        save();
        log(`Opened the revert #${r.pr} of change #${drive.culprit.number}; it is merged once its check passes.`);
        break;
      }
      case "revert-wait": {
        const r = await d.follow({ pr: drive.revert.pr, head: drive.revert.head, openedAt: drive.revert.openedAt, culprit: drive.culprit.commit, kind: "revert" });
        if (r.state === "failed") return stop(`the revert of change #${drive.culprit.number} did not pass its own checks (${r.why})`);
        if (r.state === "waiting") {
          if (waited("revert-wait") > WAIT_LIMIT["revert-wait"]) return stop(`the revert of change #${drive.culprit.number} has waited more than ${WAIT_LIMIT["revert-wait"] / HOUR} hours for its checks`);
          log(`The revert #${drive.revert.pr} waits for its checks.`);
          return { outcome: "waiting", why: "revert checks" };
        }
        drive.revert.mergeSha = r.sha;
        drive.phase = "amend";
        save();
        log(`The revert #${drive.revert.pr} is merged (${String(r.sha).slice(0, 7)}).`);
        break;
      }
      case "amend": {
        const c = drive.culprit;
        const entry = {
          release: id,
          version: base,
          decidedBy: DRIVER,
          authority: "plan-rule",
          words: planRuleWords(plan),
          approvalRef: `releases/${id}/plan.md: ${planStatusLine(plan)}`,
          approvedAt: new Date(now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
          deferredTickets: c.tickets,
          reasons: Object.fromEntries(c.tickets.map((t) => [t, [`Scenario "${c.job}" failed on candidate ${drive.candidate}: ${c.cause}.`, `Traced to pull request #${c.number} (merge ${String(c.commit).slice(0, 7)}) by ${c.how}; taken out of main by revert #${drive.revert.pr} (${String(drive.revert.mergeSha).slice(0, 7)}).`]])),
        };
        const file = `releases/${id}/scope-amendment.json`;
        const files = { [file]: withAmendment(d.records.read(file), entry) };
        for (const t of c.tickets) {
          const tf = `releases/${id}/tickets/${t}`;
          files[tf] = movedStatus(d.records.read(tf), { pr: c.number, revertPr: drive.revert.pr });
        }
        d.records.write(files, `${base}: ${c.tickets.length} ticket(s) move to the next release (written by auto-stage under the plan's dead-end rule)`);
        drive.phase = "release-start";
        save();
        log(`Wrote the scope amendment: ${c.tickets.join(", ")} move to the next release.`);
        break;
      }
      case "release-start": {
        // The rebuild is cut from the failed candidate's own commit on the release's branch, never from main's
        // head: whatever else reached main meanwhile stays out of it, so main never has to stand still.
        drive.next = nextCandidate(base, drive.n - 1); // drive.n counts re-freezes started, this one included
        const from = drive.from || ((d.records.json(`releases/${id}/staging.json`) || {}).version === drive.candidate ? d.records.json(`releases/${id}/staging.json`).productCommit : null);
        if (!from) return stop(`the commit ${drive.candidate} was frozen from is not recorded, so there is nothing to rebuild it from`);
        const branch = releaseBranch(base);
        const r = await d.startRelease({ branch, from, culprit: drive.culprit.commit, number: drive.culprit.number, why: drive.culprit.why, version: drive.next });
        if (r.cannot) return stop(`${drive.next} could not be started on ${branch} (${r.cannot})`);
        drive.release = { branch, from, pr: r.pr, head: r.head, openedAt: new Date(now()).toISOString() };
        drive.phase = "release-wait";
        save();
        log(`Opened #${r.pr} into ${branch} (cut at ${from.slice(0, 7)}, the commit of ${drive.candidate}): change #${drive.culprit.number} taken out and the version set to ${drive.next}.`);
        break;
      }
      case "release-wait": {
        const r = await d.follow({ pr: drive.release.pr, head: drive.release.head, openedAt: drive.release.openedAt, culprit: drive.culprit.commit, kind: "release" });
        if (r.state === "failed") return stop(`the rebuild of ${drive.next} on ${drive.release.branch} did not pass its checks (${r.why})`);
        if (r.state === "waiting") {
          if (waited("release-wait") > WAIT_LIMIT["release-wait"]) return stop(`the rebuild of ${drive.next} on ${drive.release.branch} has waited more than ${WAIT_LIMIT["release-wait"] / HOUR} hours for its checks`);
          log(`#${drive.release.pr} into ${drive.release.branch} waits for its checks.`);
          return { outcome: "waiting", why: "release branch checks" };
        }
        drive.release.mergeSha = r.sha;
        drive.phase = "freeze";
        save();
        log(`#${drive.release.pr} is merged into ${drive.release.branch} (${String(r.sha).slice(0, 7)}).`);
        break;
      }
      case "freeze": {
        const wait = (why, outcomeWhy) => {
          if (waited("freeze") > WAIT_LIMIT.freeze) return stop(`${drive.next} could not be frozen within ${WAIT_LIMIT.freeze / HOUR} hours (${why})`);
          log(`Not frozen yet: ${why}.`);
          return { outcome: "waiting", why: outcomeWhy };
        };
        // Exactly the merge of the rebuild: the failed candidate's code minus the change, plus the version. A
        // commit somebody else put on the release branch in between was never run through these scenarios.
        const commit = drive.release.mergeSha;
        const extra = await d.extraCommits({ from: drive.release.from, to: commit, allowed: [commit] });
        if (extra.length) return stop(`${extra.length} other change${extra.length === 1 ? "" : "s"} reached ${drive.release.branch} besides the rebuild, so ${drive.next} would carry something none of these tests ran on`);
        const args = [path.join(path.dirname(fileURLToPath(import.meta.url)), "freeze.mjs"), repo, drive.next, "--release", id, "--commit", commit, "--no-staging"];
        const dry = await d.run([...args, "--dry-run"]);
        if (dry.code !== 0) {
          const sentence = dry.stderr.trim().split("\n").pop() || "no reason was given";
          // GitHub builds both for a new commit after it lands; until they are there, the freeze waits.
          if (/GitHub holds no Windows setup built for commit/.test(sentence)) return wait(sentence, "windows setup");
          if (/is not in the registry/.test(sentence)) return wait(sentence, "server image");
          if (!/already has the tag/.test(sentence)) return stop(`the freeze of ${drive.next} was refused (${sentence})`);
          log(`${drive.next} was frozen before (an earlier look did not see it end); carrying on with it.`);
        } else {
          const real = await d.run(args);
          if (real.code !== 0) return stop(`the freeze of ${drive.next} stopped (${real.stderr.trim().split("\n").pop() || "no reason was given"})`);
        }
        d.becameCandidate(drive.next);
        drive.phase = "done";
        save();
        log(`${drive.next} is frozen; its scenarios start next.`);
        return { outcome: "refrozen", version: drive.next };
      }
      default:
        return { outcome: "stopped", why: `drive phase ${drive.phase}` };
    }
  }
  return { outcome: "waiting", why: "drive steps" };
}

export const ticketName = (file) => path.basename(file);
