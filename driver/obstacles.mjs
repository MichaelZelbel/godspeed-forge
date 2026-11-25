// Anything that is not moving is an obstacle (factory driver, Task 3). Pure: world and ledger in,
// obstacles out. An unreadable part is an obstacle of its own and never leads to a conclusion about
// the tickets it covers (no "no-progress", no "nothing to do").
import crypto from "node:crypto";
import { isWorking, ticketKeyOf } from "./progress.mjs";
import { onMain } from "./delivery.mjs";

export const KINDS = ["question", "parked", "check-failed", "no-progress", "dead-end", "factory-idle", "factory-stopped", "factory-restarts", "main-red", "unreadable", "unit-failed", "disk", "memory", "stale-process", "login", "no-ai", "tools-missing"];
export const TICKET_KINDS = ["parked", "check-failed", "no-progress", "dead-end"];
// machine problems: housekeeping first, then the ops helper (ladder.mjs)
export const MACHINE_KINDS = ["unit-failed", "disk", "memory", "stale-process", "login", "factory-stopped", "factory-restarts"];
// stopHours: a STOP made by the release step while the candidate's scenarios run is legit this long
// (2026-11-18 ruling); maxRestarts: starts of the factory user's manager in 30 minutes that are still fine;
// deadEndHours: a closed issue with no change linked, but an App's comment naming a delivery GitHub does not confirm, is a dead
// end after this long (a change may still be linking); deadEndUnnamedMinutes: one closed as completed with nothing at all named
// is one after a single round, so the cut moves it in the next round (the Forge 0.3.1: beta.31 waited 28 hours on such a ticket)
export const CONFIG = { allowedHours: { s: 4, m: 8, l: 16 }, checkRedMinutes: 20, idleDecisions: 3, diskPct: 90, memAvailPct: 10, stopHours: 2, maxRestarts: 2, deadEndHours: 1, deadEndUnnamedMinutes: 5 };

export const obstacleId = (kind, key) => crypto.createHash("sha1").update(`${kind}\n${key}`).digest("hex").slice(0, 10);
const IDLE = /workable nothing|found nothing to start/i;
const ts = v => (v ? Date.parse(v) : NaN);
const BAD_LOGIN = /not logged|logged out|no (credentials|login)|expired|unauthori|error|failed|invalid/i;

// The acting runs' own sign-in (their homes link the factory user's files): a run that could not sign in (onduty.mjs loginFailure)
// is a login obstacle of its provider, which housekeeping repairs. actLogins: {provider: {at, said}}
export const actLoginObstacles = (actLogins, seen = {}, nowIso = new Date().toISOString()) => Object.entries(actLogins || {}).map(([provider, x]) => {
  const id = obstacleId("login", `act:${provider}`);
  return { id, kind: "login", provider, since: seen[id] || (x && x.at) || nowIso, evidence: [`the acting runs could not sign in to ${provider}: ${String((x && x.said) || "").slice(-200)}`] };
});

export function findObstacles(world, ledger = {}, now = Date.now(), cfg0 = {}) {
  const cfg = { ...CONFIG, ...cfg0, allowedHours: { ...CONFIG.allowedHours, ...(cfg0.allowedHours || {}) } };
  const seen = cfg.firstSeen || {};
  const nowIso = new Date(now).toISOString();
  const out = [];
  const add = (kind, key, o, evidence) => {
    const id = obstacleId(kind, key);
    out.push({ id, kind, ...o, since: seen[id] || o.since || nowIso, evidence });
  };

  for (const release of world.releases || []) {
    for (const ticket of release.tickets || []) {
      if (!ticket.issue || ticket.deferred) continue; // a ticket moved to the next release is not driven here
      const key = ticketKeyOf(release, ticket);
      const item = (world.items || {})[ticket.issue];
      if (!item) continue; // unreadable: its own obstacle says so
      const prs = item.prs || [];
      // done: a pull request merged into main closed it or names it, or the builder or release App's comment names a delivery
      // GitHub confirms; a merge into another branch is not the item on main, as the release step judges it too
      if (item.state === "closed" && (prs.some(onMain) || (item.mergedRefs || []).length || item.delivered)) continue;
      const base = { ticketKey: key, issue: ticket.issue };
      // closed without its change reaching main: the plan's dead-end rule (what auto-stage did until 2026-11-18). When the reading
      // of its comments found nothing at all named (item.claims === 0, world.mjs), it waits one round, not an hour, so the release
      // step never waits on the driver for it; an issue whose comments were not read that way keeps the hour
      const nothingNamed = item.claims === 0;
      if (item.state === "closed" && !item.partial && !prs.some(p => p.state === "open")
        && (item.stateReason === "not_planned" || now - ts(item.closedAt) >= (nothingNamed ? cfg.deadEndUnnamedMinutes * 60000 : cfg.deadEndHours * 3600000))) {
        add("dead-end", key, { ...base, since: item.closedAt || nowIso }, [`issue #${ticket.issue} was closed${item.stateReason ? ` (${item.stateReason.replace(/_/g, " ")})` : ""} at ${item.closedAt} and no merged change closed it${nothingNamed ? "; nothing names where its work is on main" : item.claims > 0 ? "; the change an App's comment names is not merged into main" : ""}`]);
        continue;
      }
      const parkedPr = prs.find(p => p.state === "open" && (p.labels || []).includes("needs-owner"));
      const parkedIssue = (item.labels || []).includes("needs-owner");
      if (parkedIssue || parkedPr) {
        add("parked", key, { ...base, ...(parkedPr ? { pr: parkedPr.number } : {}) }, [`needs-owner on ${parkedIssue ? `issue #${ticket.issue}` : `PR #${parkedPr.number}`}`]);
        continue;
      }
      const red = prs.find(p => p.state === "open" && p.requiredState === "failure" && now - ts(p.requiredSince) >= cfg.checkRedMinutes * 60000);
      if (red && !isWorking(key, world, now)) {
        add("check-failed", key, { ...base, pr: red.number, since: red.requiredSince }, [`required failed on PR #${red.number} since ${red.requiredSince}`, "no lap has produced output in the last 30 minutes"]);
        continue;
      }
      const l = ledger[key];
      if (item.partial || !l) continue; // missing data: conclude nothing
      const hours = cfg.allowedHours[ticket.size] || cfg.allowedHours.m;
      if (now - ts(l.lastMilestoneAt) >= hours * 3600000 && !isWorking(key, world, now)) {
        add("no-progress", key, { ...base, since: l.lastMilestoneAt }, [`no milestone since ${l.lastMilestoneAt} (allowed ${hours} h for size ${ticket.size})`]);
      }
    }
  }

  // every project of the factory, each judged with its own board; the main project keeps the id "factory"
  const factories = Array.isArray(world.factories) ? world.factories
    : [{ ...(world.factory || {}), primary: true, board: (world.board && world.board.openNeedsOwner) || [] }];
  for (const f of factories) {
    const fkey = f.primary ? "factory" : `factory:${f.project}`;
    const where = { project: f.project || null, repo: f.repo || null, checkout: f.checkout || null };
    const last = (f.lastDecisions || []).slice(-cfg.idleDecisions);
    const board = Array.isArray(f.board) ? f.board : [];
    // a lap that runs is work: "workable nothing; 1 lap(s) active" is not idle (seen live 2026-11-18: the
    // lap was busy with a pull request's checks); a manager run is not a lap
    const lapsSaid = Number((/(\d+) lap\(s\) active/.exec((last.at(-1) || {}).text || "") || [])[1] || 0);
    const lapRuns = (f.activeRuns || []).filter(r => !/manager/.test(String(r.workflow || ""))).length;
    if (last.length === cfg.idleDecisions && last.every(d => IDLE.test(d.text)) && board.length > 0 && lapsSaid === 0 && lapRuns === 0) {
      add("factory-idle", fkey, { since: last[0].at, ...where, board: [...board] }, [`${f.project || "the factory"}: last ${cfg.idleDecisions} scheduler decisions: "${last.at(-1).text}"`, `${board.length} open item(s) carry needs-owner`]);
    }
    // a trigger or manager timer that is not active for two rounds, while the network guard is not
    // deciding right now (it pauses them; cfg.timerRounds: rounds each has been seen inactive)
    const guard = world.server && world.server.guardRunning;
    for (const [unit, state] of Object.entries(f.timers || {})) {
      if (/^(active|activating|reloading)$/.test(state) || guard !== false) continue;
      if (((cfg.timerRounds || {})[unit] || 0) < 2) continue;
      add("factory-stopped", `timer:${unit}`, { ...where, timer: unit }, [`${unit} of the factory user is ${state} for ${(cfg.timerRounds || {})[unit]} rounds, and the network guard is not running`]);
    }
    const st = f.stop;
    // a PAUSE is a pause (the inventory's pause entry covers it): it is never a fault of the factory. Every STOP is one: no program
    // makes the factory's STOP any more (the Forge 0.3.3, item 7), so each one is somebody's and the ops helper decides
    if (st && !f.pause && st.kind !== "PAUSE" && !/\/\.factory\/PAUSE$/.test(String(st.file || ""))) {
      add("factory-stopped", `stop:${f.project}`, { since: st.at, ...where, stop: { file: st.file, line: st.line, writer: st.writer, pid: st.pid } },
        [`${st.file} is there since ${st.at}: "${st.line}"`, `its writer ${st.writerAlive ? "is still running" : "is not running"}`]);
    }
  }
  // a hidden check without a tool that can run: the loop's verifier refuses every change it covers. The
  // id names the missing checks, so a new set (H-41 to H-43 at 19:07 on 2026-11-18) is a new episode
  // that never inherits an earlier one's attempts
  const t = world.tools;
  const missingIds = t && Array.isArray(t.missing) ? [...new Set(t.missing.map(m => String(m.id)))].sort((a, b) => a.localeCompare(b, "en", { numeric: true })) : [];
  if (t && Array.isArray(t.missing) && t.missing.length) add("tools-missing", `tools:${missingIds.join(",")}`, {}, [...t.missing.map(m => m.why), `${t.missing.length} of ${t.scenarios} hidden checks cannot run, so every change they cover waits`]);
  if (world.main && world.main.required === "failure") add("main-red", "main", { since: world.main.since }, [`required is red on main (${world.main.sha})`]);
  for (const u of world.unreadable || []) add("unreadable", u.part, {}, [`could not read ${u.part}: ${u.error}`]);

  const s = world.server;
  if (s) {
    for (const u of s.failedUnits || []) add("unit-failed", u, {}, [`unit ${u} failed`]);
    if (s.diskPct != null && s.diskPct >= cfg.diskPct) add("disk", "disk", {}, [`disk ${s.diskPct}% full`]);
    if (s.memAvailPct != null && s.memAvailPct <= cfg.memAvailPct) add("memory", "memory", {}, [`${s.memAvailPct}% memory available`]);
    if (Number.isFinite(s.userManagerStarts) && s.userManagerStarts > cfg.maxRestarts) add("factory-restarts", "user-manager", {}, [`the factory user's manager (user@) started ${s.userManagerStarts} times in the last 30 minutes; every restart ends the laps that run`]);
    for (const p of s.staleProcs || []) add("stale-process", String(p.pid), {}, [`process ${p.pid} (${p.user}) running ${p.ageMin} min: ${p.cmd}`]);
    const lg = s.logins || {};
    if (lg.gh === false) add("login", "gh", {}, ["gh is not logged in"]);
    for (const k of ["codex", "claude"]) {
      if (lg[k] && lg[k] !== "unknown" && BAD_LOGIN.test(lg[k]) && (/not logged in/i.test(lg[k]) || !/logged in/i.test(lg[k]))) add("login", k, {}, [`${k}: ${lg[k]}`]);
    }
  }
  out.push(...actLoginObstacles(world.actLogins, seen, nowIso));
  if (cfg.noAi) add("no-ai", "no-ai", { since: cfg.noAi.since }, [cfg.noAi.evidence || "no AI provider reachable"]);
  // a factory question the questions step handed to the driver (it offers nothing to pick from): the decide helper's
  // (ladder.mjs). Its time counts from when the driver first saw it, never from when it was asked.
  for (const q of world.routedQuestions || []) {
    const issue = Number(q.issue);
    add("question", `${q.repo}
${q.key}`, { repo: q.repo, ...(Number.isInteger(issue) && issue > 0 ? { issue } : {}), ownerIssue: Number(q.ownerIssue) || null,
      question: { key: q.key, heading: q.heading, link: q.link || "", items: Array.isArray(q.items) ? q.items : [], driver: !!q.driver } },
      [`a question from the factory of ${q.repo}${q.driver ? "" : ` (its "Owner decisions needed" issue ${q.link || ""})`}, handed to the driver because it offers no options or no recommendation to take: "${q.heading}"`,
        `the question as the manager wrote it: ${String(q.body || "").slice(0, 3000)}`, `why it came to the driver: ${q.why || "nothing to pick from"}`,
        `the decision goes on #${Number.isInteger(issue) && issue > 0 ? issue : "?"}${q.items && q.items.length > 1 ? ` (the question also names ${q.items.slice(1).map(n => `#${n}`).join(", ")})` : ""}`]);
  }
  return out;
}
