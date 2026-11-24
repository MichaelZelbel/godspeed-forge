// The driver's duties around the chain (architecture 7, 8, 9): telling Michael through two transports and
// repeating until he has seen it, the heartbeat on GitHub and the watcher's health, supersession with its
// containment check, the goal between releases, and the rung 0 fixes that need no AI. Every outside call goes
// through a `run` parameter, so each duty is tested offline.
import fs from "node:fs";
import { onMain } from "./delivery.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { containment, containmentCommits, GODSPEED_RELEASE } from "./journal.mjs";
import { deliver, readEnvFile, telegramCreds, pollSeen, seenKey } from "./facts.mjs";

const HOUR = 3600000, MIN = 60000;
const sysRun = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 60000, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root" }, ...opts });
export const WATCH_REPO = env => env.WATCH_REPO || process.env.WATCH_REPO || "";
export const WATCH_WORKFLOW = "factory-watch.yml";

// ---------------------------------------------------------------- 9.9 "told" means seen
// A notice is repeated through both transports 2 hours after it was sent and then every morning (07:00 UTC) until
// he has seen it; the repeats never wait for the seen. Seen = he closed the notice's GitHub issue (transport B).
export function resendDue(notice, now) {
  if (notice.seen) return false;
  const sent = notice.sentAt || [notice.at];
  const last = Math.max(...sent);
  if (sent.length === 1) return now - last >= 2 * HOUR;
  const morning = new Date(now); morning.setUTCHours(7, 0, 0, 0);
  return now >= morning.getTime() && last < morning.getTime();
}
export const DELIVERY_RETRY_MS = 30 * MIN;
// A notice that never obtained any receipt has no durable route to an owner. Retry exactly its
// original two transports on a bounded timer; this is driver housekeeping, never an acting run.
// Old journal records lack deliveryAttemptAt, so their original notice timestamp remains the timer.
export function deliveryRetryDue(notice, now) {
  if (notice.seen || Object.keys(notice.receipts || {}).length) return false;
  const last = Number.isFinite(notice.deliveryAttemptAt) ? notice.deliveryAttemptAt : notice.at;
  return Number.isFinite(last) && now - last >= DELIVERY_RETRY_MS;
}
// -> {seen: bool}. The receipt of transport B is the issue's URL; closed means he looked at it.
export function seenCheck(notice, run = sysRun) {
  const url = notice.receipts && notice.receipts.github;
  const m = url && /repos\/|github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(url);
  if (!m || !m[1]) return { seen: false };
  const r = run("gh", ["api", `repos/${m[1]}/issues/${m[2]}`]);
  try { return { seen: JSON.parse(r.stdout).state === "closed" }; } catch { return { seen: false, unreadable: true }; } // an unreadable lookup is no answer: never a reason to resend
}
// One notice, both transports, a receipt each. -> the journal event
export async function sendNotice(env, id, title, text, now, deps = {}, entries = null) {
  const d = await deliver(env, { title, text, noticeId: id }, deps);
  return { t: "notice", id, at: new Date(now).toISOString(), title, text, receipts: d.receipts, failed: d.failed, ...(entries ? { entries } : {}) };
}

// ---------------------------------------------------------------- 8.10 / 9.8 the heartbeat on GitHub and the watcher's health
// The driver publishes a small status as a repository variable of the private watch repository every round:
// its time, the journal head, and the rung 3 entries with their receipts. The workflow reads it with its own code.
// The heartbeat lives in the body of ONE issue of the watch repository, marked <!-- factory-heartbeat --> (the watcher's own token can read issues, but not
// repository variables, and it must re-read the heartbeat fresh before it alarms). The driver edits it every round: an edit by the owner's own login
// names nobody, so it notifies nobody.
export const HEARTBEAT_MARK = "<!-- factory-heartbeat -->";
const BT = String.fromCharCode(96).repeat(3), NL = String.fromCharCode(10);
export const heartbeatBody = obj => `${HEARTBEAT_MARK}${NL}A machine record of the software factory's driver: nothing to do, please leave it open.${NL}${NL}${BT}json${NL}${JSON.stringify(obj)}${NL}${BT}`;
export const parseHeartbeat = body => { const m = new RegExp(BT + "json" + NL + "([\\s\\S]*?)" + NL + BT).exec(String(body || "")); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };
// -> { ok, issue }: ok is false when the lookup itself failed (never "not found": a failed lookup must not create a second heartbeat issue)
export function lookupHeartbeatIssue(env, run = sysRun) {
  if (!WATCH_REPO(env)) return { ok: true, issue: null }; // no watch repository (a new owner): nothing on GitHub is read or written
  const r = run("gh", ["api", `repos/${WATCH_REPO(env)}/issues?state=all&per_page=100&sort=updated&direction=desc`]);
  if (r.status !== 0 && r.status !== undefined) return { ok: false, issue: null };
  try { return { ok: true, issue: JSON.parse(r.stdout).find(i => !i.pull_request && String(i.body || "").startsWith(HEARTBEAT_MARK)) || null }; } catch { return { ok: r.stdout === "" && r.status === 0, issue: null }; }
}
export const findHeartbeatIssue = (env, run = sysRun) => lookupHeartbeatIssue(env, run).issue;
export function publishHeartbeat(env, status, run = sysRun) {
  if (!WATCH_REPO(env)) return { ok: true, skipped: "no watch repository: no heartbeat issue" };
  const rec = { at: status.at, head: status.journalHead, rung3: (status.rung3 || []).map(r => ({ id: r.id, since: r.since, receipts: r.receipts || {} })), releases: status.releases || [] };
  const body = heartbeatBody(rec), look = lookupHeartbeatIssue(env, run), found = look.issue;
  if (!look.ok) return { ok: false, why: "the heartbeat issue could not be looked up: nothing written (never a second issue)" };
  const r = found ? run("gh", ["api", "-X", "PATCH", `repos/${WATCH_REPO(env)}/issues/${found.number}`, "-f", `body=${body}`, "-f", "state=open"]) // a closed one is reopened: the watcher reads open ones
    : run("gh", ["api", "-X", "POST", `repos/${WATCH_REPO(env)}/issues`, "-f", "title=Factory heartbeat (a machine record, nothing to do)", "-f", `body=${body}`]);
  return r.status === 0 ? { ok: true } : { ok: false, why: String(r.stderr || "").trim().split(NL).pop() };
}
// The mirrored head, read back (9.4)
export function mirroredHead(env, run = sysRun) {
  if (!WATCH_REPO(env)) return "";
  const h = parseHeartbeat((findHeartbeatIssue(env, run) || {}).body);
  return (h && h.head) || "";
}
// The watcher records its own last run (a repository variable it sets each run); if it has not run for an hour the
// driver says so, and re-enables the workflow through the API (GitHub switches scheduled workflows off after 60 days
// of no activity in a repository). -> { ok, why, reenabled }
// GitHub's scheduler on this account runs hours late (repo-standard's "30 5 * * *" actually started between 12:23 and 14:53 UTC for a week),
// so a short "no scheduled run" rule is always false. The watcher is the net for the rare case where the driver AND the dead-man die together;
// its latency is up to about a day. Machinery trouble only when NO scheduled run has happened for 30 hours (before its first one ever: counted
// from when the workflow was installed).
export const WATCHER_STALE_HOURS = 30;
export function watcherHealth(env, now, run = sysRun, state = {}) {
  const repo = WATCH_REPO(env);
  if (!repo) return { ok: true }; // no outside watcher without a watch repository (a new owner)
  const healthy = () => { const dd = (state.watcherDispatch ||= {}); dd.dispatched = false; dd.disabledAt = null; return { ok: true }; };
  let wf = null; try { wf = JSON.parse(run("gh", ["api", `repos/${repo}/actions/workflows/${WATCH_WORKFLOW}`]).stdout); } catch {}
  if (wf && wf.state && wf.state !== "active") {
    const e = run("gh", ["api", "-X", "PUT", `repos/${repo}/actions/workflows/${WATCH_WORKFLOW}/enable`]);
    const dd = (state.watcherDispatch ||= {}); dd.disabledAt ||= now; // disabled and re-enabled: a fault only if that lasts as long as the schedule's own lateness
    return { ok: !(now - dd.disabledAt >= WATCHER_STALE_HOURS * HOUR), why: "the outside watcher's workflow was disabled", reenabled: e.status === 0 };
  }
  let sched = null;
  try { sched = (JSON.parse(run("gh", ["api", `repos/${repo}/actions/workflows/${WATCH_WORKFLOW}/runs?per_page=10&event=schedule`]).stdout).workflow_runs || [])[0] || null; } catch {}
  const since = sched ? Date.parse(sched.created_at) : (wf ? Date.parse(wf.created_at) : NaN); // the last scheduled run, else the installation
  if (!Number.isFinite(since)) return healthy(); // GitHub could not be read: that is EXTERNAL, not a fault of the watcher
  let lastRuns = []; try { lastRuns = (JSON.parse(run("gh", ["api", `repos/${repo}/actions/workflows/${WATCH_WORKFLOW}/runs?per_page=10&event=schedule`]).stdout).workflow_runs || []).filter(r => r.status === "completed").slice(0, 3); } catch {}
  if (lastRuns.length === 3 && lastRuns.every(r => r.conclusion && r.conclusion !== "success")) return { ok: false, why: "the last three scheduled runs of the outside watcher failed" }; // a watcher that fails every time is a dead watcher
  if (now - since <= WATCHER_STALE_HOURS * HOUR) return healthy(); // a scheduled run happened (a failing workflow is a different question from a schedule that never fires)
  // over 30 hours without a scheduled run (or the last one failed): start it by hand once an hour (rung 0); a machinery entry only if that does not help either
  const done = (state.watcherDispatch ||= {});
  if (!done.at || now - done.at >= HOUR) { const d = run("gh", ["workflow", "run", WATCH_WORKFLOW, "-R", repo]); const again = !!done.dispatched; done.at = now; done.dispatched = true; return { ok: !again, dispatched: d.status === 0, why: `no scheduled run of the outside watcher for ${Math.round((now - since) / HOUR)} hours; the driver started it by hand` }; }
  return { ok: false, why: `no scheduled run of the outside watcher for ${Math.round((now - since) / HOUR)} hours, even after being started by hand` };
}

// ---------------------------------------------------------------- 8.3 / 9.3 supersession only after containment
// An older approved release that a newer install passed may leave the journal only when every unfinished ticket of it
// is a ticket of the installed release (or was cut) AND every merge commit of its resolved tickets is an ancestor of the
// installed commit. -> { leave: [{release, by, check}], bad: [{release, why}] }
export function supersessionLook(jv, world, run = sysRun, checkout = "", installedOk = true) {
  const out = { leave: [], bad: [] };
  const inst = world.installed;
  if (!inst) return out;
  // nothing is discarded on a recorded claim: the install must have been freshly verified this round
  if (!installedOk) { for (const s of world.superseded || []) if (jv.releases[s.id] && !jv.releases[s.id].installed && !jv.releases[s.id].left) out.bad.push({ release: s.id, why: `${s.id} would be discarded by ${inst.id}, but ${inst.id} is not freshly verified as running` }); return out; }
  const commit = String((inst.staging && inst.staging.productCommit) || "").trim();
  for (const s of world.superseded || []) {
    const jr = jv.releases[s.id];
    if (!jr || jr.installed || jr.left) continue;
    const unfinished = (jr.tickets || []).filter(t => !(`t:${t.item}:resolved` in jr.slots)).map(t => t.issue);
    const c1 = containment({ unfinished, cut: [] }, { issues: inst.issues || [] });
    const shas = Object.entries(jr.commits || {}).filter(([k]) => /:merged$/.test(k)).map(([, sha]) => sha);
    const isAnc = (sha, to) => !commit || !checkout ? false : run("git", ["-C", checkout, "merge-base", "--is-ancestor", sha, to]).status === 0; // no commit or checkout to compare: not contained
    const c2 = !commit || !checkout ? { contained: false, missing: ["(no commit or checkout to compare)"] } : containmentCommits(shas, commit, isAnc); // fails closed even when there are no merge commits to compare
    if (c1.contained && c2.contained) out.leave.push({ release: s.id, by: inst.id, check: `issues ${unfinished.join(",") || "none"} are in ${inst.id}; ${shas.length} merge commit(s) are ancestors of ${commit.slice(0, 7)}` });
    else out.bad.push({ release: s.id, why: `${s.id} would be discarded by ${inst.id} but ${c1.missing.length ? `its unfinished issues ${c1.missing.join(", ")} are not in the newer release` : `${c2.missing.length} of its merge commits are not in the installed commit`}` });
  }
  return out;
}

// ---------------------------------------------------------------- 7 the goal between releases
// Within 6 hours after an install: a next release is approved or proposed, or there is provably nothing to plan
// (no open bug or priority issue). -> { needed, installedAt, why } or null
export async function nextReleaseFacts(env, world, jv, now, run = sysRun, plansDir = env.RELEASES_DIR) {
  const inst = Object.values(jv.releases).filter(r => r.installed && GODSPEED_RELEASE.test(r.id)).sort((a, b) => b.installed.at - a.installed.at)[0];
  if (!inst) return null;
  const installedAt = inst.installed.at;
  if ((world.releases || []).length) return { needed: false, installedAt };
  let proposed = false;
  try {
    for (const n of fs.readdirSync(plansDir)) {
      if (n === inst.id || !GODSPEED_RELEASE.test(n)) continue;
      const t = fs.readFileSync(path.join(plansDir, n, "plan.md"), "utf8");
      const st = /^\s*status:\s*(\w+)/im.exec(t);
      if (st && /approved|proposed|draft|planning/i.test(st[1]) && !fs.existsSync(path.join(plansDir, n, "staging.json"))) proposed = true;
    }
  } catch { /* unreadable plans: a missing next release is then still a question for the clock */ }
  if (proposed) return { needed: false, installedAt };
  let open = 0;
  for (const label of ["bug", "priority"]) {
    const r = run("gh", ["api", `repos/${env.REPO}/issues?state=open&labels=${label}&per_page=1`]);
    try { open += JSON.parse(r.stdout).filter(x => !x.pull_request).length; } catch { open += 1; /* unreadable counts as work to plan */ }
  }
  return open ? { needed: true, installedAt, why: `${open > 1 ? "open bug or priority issues" : "an open bug or priority issue"}` } : { needed: false, installedAt };
}

// The Actions run that owns the `required` check of a commit, when that check ended badly (failure, cancelled, timed out):
// read from the check run's own link, never "some failed workflow". -> run id or null
export function requiredRunId(repo, sha, run = sysRun) {
  const r = run("gh", ["api", `repos/${repo}/commits/${sha}/check-runs?check_name=required&filter=all&per_page=20`]);
  try {
    // the check that governs the commit is the newest completed one by start time (as the `required` gate reads them)
    const done = (JSON.parse(r.stdout).check_runs || []).filter(c => c.status === "completed" || c.conclusion).sort((a, b) => Date.parse(b.started_at || b.completed_at || 0) - Date.parse(a.started_at || a.completed_at || 0));
    const newest = done.find(c => c.conclusion !== "skipped");
    if (!newest || !["failure", "cancelled", "timed_out"].includes(newest.conclusion)) return null;
    const m = /\/actions\/runs\/(\d+)/.exec(String(newest.details_url || newest.html_url || ""));
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- rung 0: fixes that need no AI, each at most once per window
// state.rung0[key] = time of the last try. -> [{did, ok}]
export async function rung0(env, world, state, now, run = sysRun, writeTicket = null) {
  const out = [], done = (state.rung0 ||= {});
  const once = key => { if (done[key] && now - done[key] < 2 * HOUR) return false; done[key] = now; return true; };
  for (const rel of world.releases || []) for (const t of rel.tickets || []) {
    const item = (world.items || {})[t.issue]; if (!item) continue;
    // a failed required check that nothing re-ran: run it again, once per head and window
    for (const p of item.prs || []) if (p.state === "open" && p.requiredState === "failure" && p.headSha && !(done[`rerun:${p.headSha}`] && now - done[`rerun:${p.headSha}`] < 2 * HOUR)) {
      const id = requiredRunId(env.REPO, p.headSha, run);
      if (!id) continue; // no required run found: nothing is re-run and nothing is recorded, the next round looks again
      done[`rerun:${p.headSha}`] = now;
      const e = run("gh", ["api", "-X", "POST", `repos/${env.REPO}/actions/runs/${id}/rerun-failed-jobs`]); out.push({ did: `re-ran the failed checks of pull request ${p.number}`, ok: e.status === 0 });
    }
    // a ticket whose issue GitHub shows closed by a merged pull request, or closed as completed with an App comment naming a delivery
    // GitHub confirms (delivery.mjs) or a merged pull request into main that mentions it, with no done line in its file: write it.
    // The driver counts such a ticket as done, so the release step must too, or it waits for a cut that never comes (beta.31).
    const pr = (item.prs || []).find(p => onMain(p) && p.mergeSha);
    const completed = item.state === "closed" && (!item.stateReason || item.stateReason === "completed");
    const ref = completed ? (item.mergedRefMerges || [])[0] : null;
    const sha = pr ? pr.mergeSha : item.delivered ? item.delivered.commit : ref ? ref.commit : null;
    if (writeTicket && item.state === "closed" && sha && once(`done:${rel.id}#${t.item}`)) {
      try { const did = await writeTicket(rel, t, sha); if (did) out.push({ did: `wrote the done line of item ${t.item} (merge ${sha.slice(0, 7)})`, ok: true }); } catch (e) { out.push({ did: `could not write the done line of item ${t.item}: ${String(e.message).slice(0, 120)}`, ok: false }); }
    }
  }
  // the dead-man's timer stays enabled (it does the same for the driver's)
  const en = run("systemctl", ["is-enabled", "factory-deadman.timer"]);
  if (en.status !== 0 && en.status !== null && /disabled|masked|not-found/.test(String(en.stdout || en.stderr || "disabled"))) { const e = run("systemctl", ["enable", "--now", "factory-deadman.timer"]); out.push({ did: "re-enabled the dead-man's timer", ok: e.status === 0 }); }
  return out;
}

// ---------------------------------------------------------------- 6 what is visibly moving
// GitHub Actions runs in progress or queued in the release repository, and auto-stage's STOP file (younger than 2 hours).
// -> { runs: [{headBranch, headSha, createdAt, name}], stop: {at} | null }
export function readActivity(env, world, run = sysRun, now = Date.now()) {
  const runs = [];
  for (const status of ["in_progress", "queued"]) {
    const r = run("gh", ["api", `repos/${env.REPO}/actions/runs?status=${status}&per_page=50`]);
    try { for (const x of JSON.parse(r.stdout).workflow_runs || []) runs.push({ headBranch: x.head_branch, headSha: x.head_sha, createdAt: x.run_started_at || x.created_at, name: x.name }); } catch { /* unreadable: nothing is called moving */ }
  }
  let stop = null;
  for (const f of world.factories || []) { const st = f && f.stop; if (f && f.primary !== false && st && /auto-stage/.test(String(st.writer || st.line || "")) && now - Date.parse(st.at) < 2 * HOUR) stop = { at: st.at }; } // auto-stage writes only the main project's
  // a release program alive right now (auto-stage's look, the freeze, the stage-server install): visibly working
  const ps = run("ps", ["-eo", "etimes=,args="]); // elapsed seconds: each program is bounded by its own start
  const procs = String(ps.stdout || "").split(String.fromCharCode(10)).map(l => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(m => m && /release\/(auto-stage|freeze|stage-server|staging-check)\.mjs/.test(m[2]) && !/--dry-run|--explain/.test(m[2])).map(m => ({ startedAt: now - Number(m[1]) * 1000, args: m[2].slice(0, 120) }));
  return { runs, stop, procs, at: now };
}

// 8 / 9.9 the owner's tap on "Seen" (the machine bot's inline button): ids of the notices acknowledged, and the new update offset
export async function seenFromTelegram(env, state, notices, deps = {}) {
  const r = await (deps.pollSeen || (() => pollSeen(telegramCreds(env), state.tgOffset || 0)))();
  state.tgOffset = r.offset;
  // a tap is kept until the notice it belongs to is in the journal (a notice written this very round is not in `notices` yet)
  state.seenKeys = [...new Set([...(state.seenKeys || []), ...r.seen])].slice(-200);
  const matched = Object.keys(notices).filter(id => state.seenKeys.includes(seenKey(id)));
  state.seenKeys = state.seenKeys.filter(k => !matched.some(id => seenKey(id) === k));
  return matched;
}
