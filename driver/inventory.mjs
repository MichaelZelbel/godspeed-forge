// The inventory and the chain (2026-11-21, Michael: "an architecture that cannot get stuck").
//
// INVARIANT: every open thing always has (1) an owner that is a program on a timer and (2) a deadline.
// A missed deadline moves it one rung up a fixed, finite chain whose last rung always tells Michael.
// There is no wait state and no owner called "Mission Control" or "a person".
//
//   rung 0  the normal owner (factory loop, auto-stage, the driver's helpers) until its limit without a milestone
//   rung 1  the acting run (full rights, root, the never-list), 1 hour
//   rung 2  a second acting run on the OTHER provider, told what rung 1 tried, 1 hour
//   rung 3  ONE plain sentence to Michael through the notice queue; the entry stays visible; after 24 hours
//           the chain starts again at rung 1. A milestone at any point puts the entry back to rung 0.
//
// Pure: world, ledger, obstacles and the chain's saved state in; entries, their next rung and the
// actions to take (launch an acting run, tell Michael) out. Nothing here talks to a machine.
import { ticketKeyOf, releaseKeyOf, isWorking } from "./progress.mjs";

export const H = 3600000;
const ts = v => (v ? Date.parse(v) : NaN);
// perDay and reservedForRelease are the settings budget.act_runs_per_day and budget.reserved (8 and 4 unless set)
export const CHAIN = { get reservedForRelease() { return Number(process.env.FD_ACT_RESERVED || 4); }, actHours: 1, actHours2: 1, restartHours: 24, get perDay() { return Number(process.env.FD_ACT_RUNS_PER_DAY || 8); }, sameItemHours: 6 };
// rung 0 limits per kind of entry, in hours without a milestone
export const LIMITS = { release: 2, stage: 2, ticket: null /* by size */, pr: 1, queue: 1, obstacle: 2 };
export const SIZE_HOURS = { s: 4, m: 8, l: 16 };
// How the owner is named in what the driver writes: the settings' server.name_in_messages (owner.name unless set),
// which the settings put into FD_OWNER_NAME; "the owner" when there is none.
export const ownerName = () => process.env.FD_OWNER_NAME || "the owner";
const OWNERS = { release: "auto-stage", stage: "auto-stage", ticket: "factory loop", pr: "factory loop", queue: "factory helpers", obstacle: "factory driver helpers", get tomichael() { return ownerName(); } };
export const RUNG_NAMES = ["normal owner", "acting run", "second acting run", "owner told"];
export const rungName = k => (k === 3 ? `${ownerName()} told` : RUNG_NAMES[k]);

// ---- auto-stage's own words: "Release <id> (<version>): ...", "Waiting: <reason> (for N minutes).", "Result: <r>."
export function parseStage(text) {
  const t = String(text || "");
  const rel = /^Release (\S+) \(/m.exec(t);
  const wait = /^Waiting: (.*?)(?: \(for (\d+) (minute|hour)s?\))?\.?\s*$/m.exec(t);
  const res = /^Result: ([\w-]+)/m.exec(t);
  return { id: rel ? rel[1] : null, reason: wait ? wait[1].replace(/\.+$/, "").trim() : null,
    minutes: wait && wait[2] ? Number(wait[2]) * (wait[3] === "hour" ? 60 : 1) : 0, result: res ? res[1] : null };
}
// Only "the factory is still working on open issues" is a wait that is not a stall.
export const factoryWorking = reason => /\b(issues?|tickets?)\b[^.]*\b(still )?(open|not closed|not merged)\b|\bstill open\b/i.test(String(reason || ""));
export const stageStalled = st => !!st && !!st.id && (!!st.reason || st.result === "needs-judgment") && !factoryWorking(st.reason);

const norm = h => String(h).toLowerCase().replace(/#\d+/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const queueKey = (repo, heading) => `${repo}\n${norm(heading)}`;

// ---------------------------------------------------------------- 6. waiting is allowed only while it is visibly running
// Activity that is visibly moving an entry's work: a GitHub Actions run in progress on the candidate or release branch (scenarios:
// 3 hours) or on a ticket's pull request head (its own timeout, 6 hours), auto-stage's STOP file younger than 2 hours. While it
// lasts the entry shows as moving and does not escalate; its deadline is the activity's own maximum. Ceilings are paused by it
// and never reset: when the activity ends they apply again.
export const ACTIVITY = { scenariosHours: 3, runHours: 6, stopHours: 2, inProgressHold: 3, creditHours: 6 };
// A hard cap on moving credit (by construction): the time an entry may spend "moving" since its last milestone is at most
// creditHours in total, summed over every window; a ceiling is paused by at most that much over the release's whole life.
// The credit used is kept in the journal ({t:"credit"}), so a lost state cannot refill it. After the cap, activity holds
// nothing: the entry escalates and the acting run sees the activity in its evidence.
// the activity hold of one entry after the credit cap. -> ms until which it is held, or NaN (no activity, or the credit is used up)
export function heldUntil(e, activity, world, credits, now) {
  const m = movingUntilFor(e, activity, world);
  if (!Number.isFinite(m)) return NaN;
  const remaining = ACTIVITY.creditHours * H - (((credits || {})[creditKey(e)]) || 0);
  return remaining > 0 ? Math.min(m, now + remaining) : NaN;
}
export const creditKeyById = (id, milestone) => (String(id).startsWith("ceiling:") ? `ceiling|${String(id).split(":")[1]}` : `${id}|${Number.isFinite(milestone) ? milestone : "first"}`);
export const creditKey = e => creditKeyById(e.id, e.milestoneAt);
// the credit events of one round: every entry that was held by visible activity this round uses the time since the last round
export function creditEvents(rows, now, prevRoundAt) {
  const ms = Number.isFinite(prevRoundAt) ? Math.max(0, Math.min(now - prevRoundAt, 15 * 60000)) : 0;
  if (!ms) return [];
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (!r.moving || !Number.isFinite(r.entry.movingUntil) || r.entry.movingUntil <= now) continue; // held by activity
    if (r.c && Number.isFinite(r.c.holdUntil) && r.c.holdUntil > now && Number.isFinite(r.c.holdAt) && r.c.holdAt <= prevRoundAt) continue; // an in-progress hold granted in an earlier round was charged when it was granted: never twice (this round's interval is still charged)
    const key = creditKey(r.entry); if (seen.has(key)) continue; seen.add(key);
    out.push({ t: "credit", key, ms, at: new Date(now).toISOString() });
  }
  return out;
}
const versionIn = s => (/(\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?)/i.exec(String(s || "")) || [])[1] || null;
export function movingUntilFor(e, activity, world) {
  if (!activity) return NaN;
  const out = [];
  const runs = activity.runs || [];
  const isRelease = ["release", "ceiling", "stage"].includes(e.kind) || e.obstacleKind === "next-release";
  if (isRelease) {
    const v = versionIn(e.release);
    // a candidate or release branch's run belongs to the release whose version its branch names, no other
    for (const r of runs) if (/^(candidate|release)\//.test(String(r.headBranch || "")) && v && versionIn(r.headBranch) === v) out.push(Date.parse(r.createdAt) + ACTIVITY.scenariosHours * H);
    // main's own checks and image builds that the release waits on: a GitHub run's own timeout
    // (only when auto-stage's own reason names main's check, main's image or main's Windows setup, and only for the release it is waiting for: otherwise main's runs belong to other work and hide nothing)
    const forStage = activity.releaseId ? activity.releaseId === e.release : activity.onlyRelease === e.release;
    if (activity.waitingOnMain && forStage) for (const r of runs) if (r.headBranch === "main") out.push(Date.parse(r.createdAt) + ACTIVITY.runHours * H);
    // auto-stage's STOP and its programs belong to the release it is staging (activity.releaseId); with none known, to the only open release
    const mine = activity.releaseId ? activity.releaseId === e.release : activity.onlyRelease === e.release; // ambiguous (several open releases, none named): it hides nothing
    if (mine) {
      for (const p of activity.procs || []) if (Number.isFinite(p.startedAt)) out.push(p.startedAt + ACTIVITY.scenariosHours * H); // bounded by its own start: a hung program does not hold forever
      if (activity.stop && Number.isFinite(Date.parse(activity.stop.at))) out.push(Date.parse(activity.stop.at) + ACTIVITY.stopHours * H);
    }
  }
  // a step's child that is alive right now is visibly running: its own entry, and the release the stage step works on, are held until its time limit
  for (const [name, r] of Object.entries(activity.stepRuns || {})) {
    const until = Number.isFinite(r.startedAt) ? r.startedAt + (r.maxMin || 60) * 60000 : NaN;
    if (e.step === name) out.push(until);
    else if (isRelease && name === "stage" && (activity.releaseId ? activity.releaseId === e.release : activity.onlyRelease === e.release)) out.push(until);
  }
  if (e.kind === "ticket" || e.ticketKey) {
    const item = e.issue ? (world.items || {})[e.issue] : null;
    const shas = new Set(((item && item.prs) || []).filter(p => p.state === "open" && p.headSha).map(p => p.headSha));
    for (const r of runs) if (shas.has(r.headSha)) out.push(Date.parse(r.createdAt) + ACTIVITY.runHours * H);
  }
  const ok = out.filter(Number.isFinite);
  return ok.length ? Math.max(...ok) : NaN;
}

// ---------------------------------------------------------------- the inventory
// ctx: { now, journalView, journalOk, coverageBad, clock, undelivered, nextRelease, stage: parseStage(...) | null, stageSince: {reasonKey, since} | null (the driver's memory of the
//        same reason), pauses: [pause] }. -> entries [{id, kind, owner, title, milestoneAt (ms), limitH, evidence, ...}]
// Every entry is classified in its own try/catch: one that cannot be read becomes an "unclassified" entry with
// no owner, which goes to rung 1 at once. The inventory itself never throws for a bad input.
const hash = raw => { let h = 0; for (const c of (() => { try { return JSON.stringify(raw); } catch { return String(raw); } })() || "") h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(16); };
const NaN_FLOOR = 0;
export const CEILING = { closedUnstagedHours: 24, approvedUninstalledHours: 72 };
export function buildInventory(world, ledger, obstacles, ctx) {
  let entries = buildEntries(world, ledger, obstacles, ctx);
  // Work that only a paused factory would move does not escalate: it is listed under that pause's daily reminder. An approved
  // release never hides behind a pause (its tickets, ceilings and stage entries keep their clocks).
  const waiting = {};
  const pauses = (ctx.pauses || []).filter(p => p && (p.all || p.repo || (p.repos || []).length));
  if (pauses.length) {
    entries = entries.filter(e => {
      if ((e.kind !== "pr" && e.kind !== "queue") || !e.repo) return true;
      const p = pauses.find(x => (x.all || x.repo === e.repo || (x.repos || []).includes(e.repo)) && !(Number.isFinite(x.expiresAt) && x.expiresAt <= ctx.now) ); // an expired pause covers nothing; every other pause covers its repository's work for as long as it is in place (it is reminded daily)
      if (!p) return true;
      waiting[p.id] = (waiting[p.id] || 0) + 1;
      return false;
    });
    for (const e of entries) if (e.kind === "pause" || e.kind === "pause-program") {
      const n = waiting[String(e.id).replace(/^pause:/, "")];
      if (n) { e.reminder = `${e.reminder} ${n} item${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""} behind this pause.`; e.evidence = [...e.evidence, `${n} needs-owner pull request(s) and queue item(s) wait behind this pause and do not escalate`]; }
    }
  }
  const open = (ctx.journalView && ctx.journalView.open) || [];
  const waitingOnMain = !!(ctx.stage && /(main'?s?\b[^.]*\b(required check|Windows setup|image))|(image\b[^.]*not in the registry)/i.test(String(ctx.stage.reason || "")));
  const activity = ctx.activity ? { ...ctx.activity, waitingOnMain, releaseId: (ctx.stage && ctx.stage.id) || ctx.activity.releaseId, onlyRelease: open.length === 1 ? open[0].id : null } : null;
  for (const e of entries) {
    const m = movingUntilFor(e, activity, world);
    if (!Number.isFinite(m)) continue;
    const h = heldUntil(e, activity, world, ctx.credits, ctx.now);
    if (Number.isFinite(h)) e.movingUntil = h;
    else e.evidence = [...(e.evidence || []), `visible activity is still present on it (a run, a STOP file or a program), but its ${ACTIVITY.creditHours} hours of moving credit are used up: it no longer holds escalation. Look at what is running and decide whether it really moves this.`];
  }
  return entries;
}
function buildEntries(world, ledger, obstacles, ctx) {
  const now = ctx.now, out = [];
  const add = e => out.push({ evidence: [], ...e, owner: e.owner === undefined ? (OWNERS[e.kind] || null) : e.owner });
  const each = (section, list, fn) => {
    for (const raw of Array.isArray(list) ? list : []) {
      try { fn(raw); } catch (e) {
        add({ id: `unclassified:${section}:${hash(raw)}`, kind: "obstacle", obstacleKind: "unclassified", owner: null, title: `an unreadable ${section} entry`, milestoneAt: now, limitH: 0,
          evidence: [`the inventory could not classify this ${section} entry (${String(e && e.message).slice(0, 160)}): ${(() => { try { return JSON.stringify(raw).slice(0, 400); } catch { return String(raw).slice(0, 400); } })()}`] });
      }
    }
  };
  // the steps' health: step:<name> (owner the driver) and halt:<name>:<key> (no owner: rung 1 at once), built by steps.mjs
  for (const e of ctx.stepEntries || []) add(e);
  const obsByTicket = new Set((obstacles || []).filter(o => o && o.ticketKey).map(o => o.ticketKey));
  const jv = ctx.journalView || { open: [], releases: {} };
  const worldRel = new Map((world.releases || []).map(r => [r.id, r]));

  // (8.5) a journal nobody can read: every release starts at rung 1, which errs toward acting
  if (ctx.journalOk === false)
    add({ id: "journal:unreadable", kind: "obstacle", obstacleKind: "journal", owner: null, title: "the approval journal cannot be read", milestoneAt: now, limitH: 0, evidence: [`the append-only journal could not be read: ${ctx.journalWhy || "unknown"}`, "every approved release is treated as stalled until it is repaired"] });
  // (8.2) the coverage proof: a release that vanished from the read, or a shrink nothing explains, is a stall now
  each("coverage", ctx.coverageBad, c => add({ id: `coverage:${c.release}:${hash(c.why)}`, kind: "obstacle", obstacleKind: "coverage", owner: null, title: `coverage proof failed for ${c.release}`, milestoneAt: now, limitH: 0, evidence: [`release ${c.release}: ${c.why}`] }));
  // (8.6) a clock that disagrees with GitHub, or went backwards
  if (ctx.clock && (ctx.clock.ok === false || ctx.clock.backwards))
    add({ id: "clock", kind: "obstacle", obstacleKind: "clock", owner: null, title: "this machine's clock is wrong", milestoneAt: now, limitH: 0, evidence: [ctx.clock.backwards ? "time went backwards since the last round" : `the clock differs from GitHub's by ${Math.round(Math.abs(ctx.clock.skewMs) / 60000)} minutes`] });
  // (8.11) a notice without a receipt for 30 minutes is a stall of the delivery path
  each("notice", ctx.undelivered, n => add({ id: `delivery:${n.id}`, kind: "obstacle", obstacleKind: "delivery", owner: null, title: `a message to ${ownerName()} has no delivery receipt (${n.id})`, milestoneAt: n.since, limitH: 0, evidence: [`notice ${n.id} was written at ${new Date(n.since).toISOString()} and neither Telegram nor GitHub gave a receipt`] }));

  // the releases the journal holds open: each in its own try/catch (isolation), times from the journal only
  each("release", jv.open, jr => {
    const rel = worldRel.get(jr.id);
    const sealed = jr.tickets || [];
    const slotAt = prefix => Math.max(NaN_FLOOR, ...Object.entries(jr.slots).filter(([k]) => k.startsWith(prefix)).map(([, t]) => t));
    let unresolved = 0;
    for (const t of sealed) {
      if (`t:${t.item}:resolved` in jr.slots) continue;
      unresolved++;
      const key = `${jr.id}#${t.item}`;
      if (obsByTicket.has(key)) continue; // an obstacle of this ticket is its entry
      const wt = rel && (rel.tickets || []).find(x => x.item === t.item);
      const last = Math.max(jr.approvedAt || 0, slotAt(`t:${t.item}:`));
      const item = (world.items || {})[t.issue];
      const working = isWorking(key, world, now);
      add({ id: `ticket:${key}`, kind: "ticket", issue: t.issue, title: `${(wt && wt.title) || `item ${t.item}`} (#${t.issue})`, milestoneAt: last, limitH: SIZE_HOURS[(wt && wt.size)] || SIZE_HOURS.m, ticketKey: key,
        evidence: [`ticket ${key} (#${t.issue}): no new milestone since ${new Date(last).toISOString()}${item ? "" : "; its issue could not be read"}`] });
    }
    // all sealed tickets resolved and not installed: the release itself is an entry (its owner is auto-stage)
    if (unresolved === 0 && sealed.length) {
      const last = jr.lastMilestoneAt;
      add({ id: `release:${jr.id}`, kind: "release", release: jr.id, title: `release ${jr.id}`, milestoneAt: last, limitH: LIMITS.release,
        evidence: [`approved release ${jr.id}: every ticket is resolved, but no new milestone (freeze, scenarios, stage step, install) since ${new Date(last).toISOString()}`] });
    }
    // the absolute ceilings: their start never moves (the journal's approval time, the time the last ticket resolved)
    add({ id: `ceiling:${jr.id}:installed`, kind: "ceiling", release: jr.id, owner: "auto-stage", title: `release ${jr.id} approved but not installed after ${CEILING.approvedUninstalledHours} hours`, milestoneAt: jr.approvedAt, limitH: CEILING.approvedUninstalledHours,
      evidence: [`release ${jr.id} was approved at ${new Date(jr.approvedAt).toISOString()} and is not installed (ceiling ${CEILING.approvedUninstalledHours} h; no milestone resets it)`] });
    if (unresolved === 0 && sealed.length && !("r:staged" in jr.slots) && Number.isFinite(jr.slots["r:resolved"]))
      add({ id: `ceiling:${jr.id}:staged`, kind: "ceiling", release: jr.id, owner: "auto-stage", title: `release ${jr.id} finished but not staged after ${CEILING.closedUnstagedHours} hours`, milestoneAt: jr.slots["r:resolved"], limitH: CEILING.closedUnstagedHours,
        evidence: [`the last ticket of release ${jr.id} resolved at ${new Date(jr.slots["r:resolved"]).toISOString()} and the release is not staged (ceiling ${CEILING.closedUnstagedHours} h)`] });
  });
  // (7) between releases: a release was installed and no next one is planned, though there is something to plan
  if (ctx.nextRelease && ctx.nextRelease.needed)
    add({ id: "next-release", kind: "obstacle", obstacleKind: "next-release", owner: "auto-plan", title: "no next release was planned after the last install", milestoneAt: ctx.nextRelease.installedAt, limitH: 6,
      evidence: [`a release was installed at ${new Date(ctx.nextRelease.installedAt).toISOString()}; no next release is approved or proposed, and there is open work to plan (${ctx.nextRelease.why})`] });
  // auto-stage's current waiting reason (same reason, same start)
  if (stageStalled(ctx.stage) && ctx.stageSince)
    add({ id: `stage:${ctx.stage.id}`, kind: "stage", release: ctx.stage.id, title: `auto-stage waits: ${ctx.stage.reason || ctx.stage.result}`, milestoneAt: ctx.stageSince.since, limitH: LIMITS.stage,
      evidence: [`auto-stage's look at release ${ctx.stage.id}: ${ctx.stage.reason ? `Waiting: ${ctx.stage.reason}` : "no reason given"}; Result: ${ctx.stage.result || "none"}`] });
  // every pull request labelled needs-owner in the repositories whose factory runs
  // Work that belongs to an approved release (a pull request of a sealed ticket, a queue item that names one of its issues or pull requests)
  // is NOT backlog: it keeps the release's rungs and may reach Michael.
  const releaseIssues = new Set(), releasePrs = new Set();
  try { for (const jr of (ctx.journalView && ctx.journalView.open) || []) for (const t of jr.tickets || []) { releaseIssues.add(t.issue); for (const p of ((world.items || {})[t.issue] || {}).prs || []) releasePrs.add(p.number); } } catch { /* an unreadable release: its entries are unclassified below */ }
  const relRepos = new Set((world.releases || []).map(r => r.repo).filter(Boolean));
  const sameRepo = repo => relRepos.size === 0 || relRepos.has(repo); // a number means the release's issue or pull request only in the release's repository
  const refsIn = text => [...String(text || "").matchAll(/#(\d+)|\/(?:issues|pull)\/(\d+)/g)].map(m => Number(m[1] || m[2]));
  const ofRelease = (repo, text) => sameRepo(repo) && refsIn(text).some(n => releaseIssues.has(n) || releasePrs.has(n));
  each("pull request", world.openPrs, p =>
    add({ id: `pr:${p.repo}#${p.number}`, kind: "pr", backlog: !(sameRepo(p.repo) && releasePrs.has(p.number)), repo: p.repo, title: `pull request ${p.number} in ${p.repo}: ${p.title}`, milestoneAt: NaN, limitH: LIMITS.pr, evidence: [`open pull request ${p.repo}#${p.number} "${p.title}" labelled needs-owner, last touched ${p.updatedAt}: ${p.url || ""}`] }));
  // the factory's queue: questions left for Mission Control (nobody else will decide them), and the ones with Michael
  const activeRepos = new Set((world.factories || []).map(f => f && f.repo).filter(Boolean));
  const elsewhere = world.answeredElsewhere || {};
  const answered = (repo, heading) => (Array.isArray(elsewhere) ? elsewhere : elsewhere[repo] || []).map(norm).includes(norm(heading));
  each("queue", world.queue, q => {
    if (!q || !q.repo || !q.heading || !activeRepos.has(q.repo) || answered(q.repo, q.heading)) return;
    add({ id: `queue:${queueKey(q.repo, q.heading)}`, kind: "queue", backlog: !ofRelease(q.repo, `${q.heading} ${q.question || ""} ${q.link || ""}`), title: q.heading, milestoneAt: ts(q.asked), limitH: LIMITS.queue, repo: q.repo, queueHeading: q.heading,
      evidence: [`left for Mission Control in the factory's queue since ${q.asked}: ${q.heading}`, `repository ${q.repo}; owner issue ${q.link || "unknown"}`, `question: ${String(q.question || "").slice(0, 3000)}`, `why it came to Mission Control: ${q.why || ""}`] });
  });
  each("to-michael", Object.entries(world.toMichael && !Array.isArray(world.toMichael) ? world.toMichael : {}).flatMap(([repo, list]) => (Array.isArray(list) ? list : []).map(h => ({ repo, h }))), x =>
    add({ id: `tomichael:${queueKey(x.repo, x.h)}`, kind: "tomichael", title: `a question for ${ownerName()}: ${x.h}`, milestoneAt: NaN, limitH: 72, owner: ownerName(), remindOnly: true,
      reminder: `A question about what the software does for its users is still waiting for your answer: ${String(x.h).slice(0, 140)}. Answer it in the chat and the factory goes on.`, evidence: [`a question of what the software does for its users, with ${ownerName()}: ${x.h}`] }));
  // every pause: a HOLD, a PAUSE or STOP file, a deliberately parked project. Owner: Michael's decision, with a
  // reminder deadline (the expiry written in it, else 24 hours): the reminder is the sentence, never an acting run.
  each("pause", ctx.pauses, p => {
    const since = Number.isFinite(p.since) ? p.since : now;
    const when = new Date(since).toISOString().slice(0, 16).replace("T", " ");
    if (p.ownerRef) { // (8.8) his pause exists only with a reference to his own words; no expiry; one reminder a day
      add({ id: `pause:${p.id}`, kind: "pause", owner: `${ownerName()}'s decision`, remindOnly: true, title: `${p.what} since ${when} UTC`, milestoneAt: since, limitH: Number.isFinite(p.expiresAt) ? Math.max(0, (p.expiresAt - since) / H) : 24,
        reminder: `The factory is still paused since ${when} UTC (${p.what}); say continue or it stays paused.`, evidence: [`${p.what}: ${p.line || ""} (his words: ${p.ownerRef})`] });
    } else { // any other pause is a program's: no acting run ever undoes a pause (Michael may have parked it on purpose); he is told
      add({ id: `pause:${p.id}`, kind: "pause-program", owner: `${ownerName()}'s decision`, remindOnly: true, title: `${p.what} since ${when} UTC (no record of who asked)`, milestoneAt: since, limitH: 24,
        reminder: `${p.what} is still paused since ${when} UTC and nothing records who asked; say continue or it stays paused.`,
        evidence: [`${p.what}: ${p.line || ""}`, `there is no pause record with a reference to ${ownerName()}'s own words; a program's stale STOP file is removed by housekeeping, anything else waits for his word, and he is reminded daily`] });
    }
  });
  // every obstacle the driver already has (its helpers are the rung 0 owner); a kind this code has never
  // seen has no owner: it goes to the acting run at once
  each("obstacle", obstacles, o =>
    add({ id: `ob:${o.id}`, kind: "obstacle", obstacleKind: o.kind, title: `${o.kind}: ${o.ticketKey || o.project || o.timer || o.repo || ""}`.trim(), milestoneAt: ts(o.since), limitH: LIMITS.obstacle, obstacleId: o.id, ticketKey: o.ticketKey,
      owner: KNOWN_OBSTACLES.has(o.kind) ? OWNERS.obstacle : null, evidence: o.evidence || [] }));
  return out;
}
export const KNOWN_OBSTACLES = new Set(["parked", "check-failed", "no-progress", "dead-end", "factory-idle", "factory-stopped", "factory-restarts", "main-red", "unreadable", "unit-failed", "disk", "memory", "stale-process", "login", "no-ai", "tools-missing"]);

// ---------------------------------------------------------------- the chain
// chain[id] = { rung, rungSince (ms), milestone (ms), launched (bool: the acting run of this rung started), told (bool), toldAt, tries: [{rung, at, result, summary}] }
// opts: { forceRung1: Set of entry ids (a helper said "external" or a cause nobody knows), actRuns, runsToday, runsPerDay, slotFree }
// -> { chain (new), rows: [{entry, rung, deadline, action}], actions: {launch: row|null, tell: [row]} , violations: [row] }
// how old an entry is for the order: its own time and the time the driver first saw it, whichever is earlier
const ageKey = r => Math.min(Number.isFinite(r.entry.milestoneAt) ? r.entry.milestoneAt : Infinity, Number.isFinite(r.c.firstSeenAt) ? r.c.firstSeenAt : Infinity, Number.isFinite(r.c.milestone) ? r.c.milestone : Infinity);
export function advance(entries, chain0, now, opts = {}) {
  const chain = {};
  const rows = [];
  const force = opts.forceRung1 || new Set();
  const currentRuns = Array.isArray(opts.actRuns)
    ? opts.actRuns.filter(r => Number.isFinite(r && r.at) && r.at <= now && now - r.at < 24 * H)
    : [];
  const runsToday = Array.isArray(opts.actRuns) ? currentRuns.length : (opts.runsToday ?? 0);
  const budget = Math.max(0, (opts.runsPerDay ?? CHAIN.perDay) - runsToday); // acting runs left in the rolling window
  const budgetRetryAt = currentRuns.length ? Math.min(...currentRuns.map(r => r.at + 24 * H)) : now + 1;
  for (const e of entries) {
   try {
    const old = chain0[e.id];
    // an entry without a usable time starts its clock when it is first seen and keeps it (a clock that restarts every round never runs out)
    const first = Number.isFinite(e.milestoneAt) ? e.milestoneAt : now;
    let c = old ? { ...old } : { rung: 0, rungSince: first, milestone: first, firstSeenAt: now, launched: false, told: false, tries: [] };
    if (!Number.isFinite(c.milestone)) c.milestone = first;
    // a milestone after the entry's last one: back to rung 0
    if (Number.isFinite(e.milestoneAt) && e.milestoneAt > c.milestone) c = { rung: 0, rungSince: e.milestoneAt, milestone: e.milestoneAt, launched: false, told: false, tries: [] };
    c.nan = !Number.isFinite(e.milestoneAt);
    let moved = false;
    // 6: while another program visibly works on it (or an acting run reported "in-progress"), it shows as moving: no escalation,
    // no launch, no message; the rung's own hour starts again when the activity ends
    const holdUntil = Math.max(Number.isFinite(e.movingUntil) ? e.movingUntil : 0, Number.isFinite(c.holdUntil) ? c.holdUntil : 0);
    if (holdUntil > now && !e.told && !e.remindOnly) {
      if (c.rung === 1 || c.rung === 2) c.rungSince = now;
      rows.push({ entry: e, rung: c.rung, deadline: holdUntil, moved: false, c, moving: true });
      chain[e.id] = c; continue;
    }
    if (e.told) { chain[e.id] = c; rows.push({ entry: e, rung: 3, deadline: Infinity, action: null, told: true, c }); continue; } // with Michael already
    const base = Number.isFinite(e.milestoneAt) ? e.milestoneAt : c.milestone;
    const limit = (e.limitH ?? LIMITS.obstacle) * H;
    // An entry goes up a rung only after that rung's actor ACTUALLY RAN on it and ended without a milestone (or crashed, or timed
    // out). Waiting in line for the one-at-a-time slot is not a failed attempt. (Older state that climbed on the clock alone is put back.)
    const tried = rung => (c.tries || []).some(t => t.rung === rung);
    // Backlog (needs-owner pull requests and queue items that belong to no approved release) is a queue with a known next action: the
    // next budget window. It never goes to Michael, however long it waits or whatever the budget says; after both actors tried, the cycle
    // starts again after a day. Only an approved release and the machinery's own entries may reach him.
    if (e.backlog) {
      if (c.rung === 3) { if (tried(1) && tried(2)) c.cooldownUntil = now + 24 * H; c.rung = 1; c.rungSince = now; c.launched = false; c.told = false; c.tries = []; moved = true; }
      if (c.rung === 2 && tried(2)) { c.rung = 1; c.rungSince = now; c.launched = false; c.tries = []; c.cooldownUntil = now + 24 * H; moved = true; }
    }
    if (!e.remindOnly) {
      if (c.rung === 2 && !tried(1)) { c.rung = 1; c.rungSince = now; c.launched = false; c.told = false; moved = true; }
      if (c.rung === 3 && !c.told && !(tried(1) && tried(2))) { c.rung = tried(1) ? 2 : 1; c.rungSince = now; c.launched = false; moved = true; } // rung 3 needs both actors to have run
    }
    // a run that vanished without an answer counts as lost 3 hours after it LAUNCHED (not after the entry entered the rung); it is then recorded as a try
    const ranOrLost = rung => {
      if (tried(rung)) return true;
      if (c.launched && now >= (Number.isFinite(c.launchedAt) ? c.launchedAt : c.rungSince) + 3 * H) { (c.tries ||= []).push({ rung, at: new Date(now).toISOString(), provider: "unknown", result: "lost", summary: "the run ended without an answer" }); return true; }
      return false;
    };
    if (e.remindOnly) { // a pause: Michael is reminded when its time is up, and again every 24 hours; nobody acts for him
      if ((c.rung < 3 && now >= base + limit) || (c.rung === 3 && now >= c.rungSince + CHAIN.restartHours * H)) { c.rung = 3; c.rungSince = now; c.told = false; moved = true; }
    } else if (c.rung === 0 && (e.owner === null || force.has(e.id) || now >= base + limit)) { c.rung = 1; c.rungSince = now; c.launched = false; moved = true; }
    else if ((c.rung === 1 || c.rung === 2) && now >= c.rungSince + (c.rung === 1 ? CHAIN.actHours : CHAIN.actHours2) * H && ranOrLost(c.rung)) {
      c.rung += 1; c.rungSince = now; c.launched = false; c.told = false; moved = true;
    } else if (c.rung === 3 && now >= c.rungSince + CHAIN.restartHours * H) { c.rung = 1; c.rungSince = now; c.launched = false; c.told = false; moved = true; }
    if (e.backlog && c.rung === 3) { c.rung = 1; c.rungSince = now; c.launched = false; c.told = false; c.tries = []; c.cooldownUntil = now + 24 * H; moved = true; } // whichever path led here: backlog never reaches the owner
    const deadline = c.rung === 0 ? base + limit : (c.rung === 1 || c.rung === 2) && !c.launched ? Math.max(now + 1, c.rungSince + CHAIN.actHours * H) : c.rungSince + (c.rung === 1 ? CHAIN.actHours : c.rung === 2 ? CHAIN.actHours2 : CHAIN.restartHours) * H;
    rows.push({ entry: e, rung: c.rung, deadline, moved, c });
    chain[e.id] = c;
   } catch (err) { // an entry that breaks the chain is itself stuck: rung 1 now, the round goes on
    const c = { rung: 1, rungSince: now, milestone: now, launched: false, told: false, tries: [] };
    chain[e && e.id] = c; rows.push({ entry: { ...e, owner: null, evidence: [...((e && e.evidence) || []), `the chain failed on this entry: ${String(err.message).slice(0, 160)}`] }, rung: 1, deadline: now + CHAIN.actHours * H, moved: true, c });
   }
  }
  // actions: tell on rung 3 (once), launch one acting run at a time, oldest entry first. A full rolling
  // budget leaves an entry on its acting rung until the earliest current run leaves the window.
  const actions = { launch: null, tell: [] };
  const backlogAllowed = runsToday < CHAIN.perDay - CHAIN.reservedForRelease; // 4 of the 8 daily runs are reserved for releases and machinery
  const awaitingCapacity = rows.filter(r => !r.moving && (r.rung === 1 || r.rung === 2) && !r.c.launched && !r.entry.told && !r.entry.remindOnly && !(r.entry.backlog && now < (r.c.cooldownUntil || 0)));
  const wanting = awaitingCapacity.filter(r => !(r.entry.backlog && !backlogAllowed)).sort((a, b) => (a.entry.backlog ? 1 : 0) - (b.entry.backlog ? 1 : 0) || ageKey(a) - ageKey(b)); // releases and machinery first, then the backlog oldest first
  if (budget <= 0) for (const r of awaitingCapacity) { r.c.budgetRetryAt = budgetRetryAt; r.deadline = budgetRetryAt; }
  else if (wanting.length && opts.slotFree !== false) { actions.launch = wanting[0]; }
  for (const r of rows) if (r.rung === 3 && !r.c.told && !r.entry.told && !r.moving) actions.tell.push(r);
  // the invariant, checked here and not trusted: every entry has an owner and a future deadline, or moved this round
  const violations = [];
  for (const r of rows) {
    r.action = r === actions.launch ? "launch acting run" : actions.tell.includes(r) ? `tell ${ownerName()}` : null;
    const ok = r.entry.owner !== null || r.rung >= 1;
    const future = r.deadline > now;
    if (!ok || !(future || r.moved || r.action)) violations.push(r);
  }
  return { chain, rows, actions, violations };
}
// A violation is itself an entry that goes straight to rung 1 (the caller passes it to advance again).
export const violationEntry = r => ({ id: `invariant:${r.entry.id}`, kind: "obstacle", obstacleKind: "invariant", owner: null, title: `the chain broke its own rule for ${r.entry.id}`, milestoneAt: Date.now(), limitH: 0,
  evidence: [`entry ${r.entry.id} (${r.entry.kind}) had ${r.entry.owner === null ? "no owner" : "no future deadline"} at rung ${r.rung}`] });

export const describeRow = (r, now) => {
  const d = r.deadline === Infinity ? `with ${ownerName()}` : `deadline ${new Date(r.deadline).toISOString().slice(0, 16).replace("T", " ")}Z${r.deadline <= now ? " (passed)" : ""}`;
  return `${r.entry.kind} ${r.entry.title}: owner ${r.rung === 0 ? (r.entry.owner || "none") : rungName(r.rung)}, rung ${r.rung}, ${d}${r.moving ? ", MOVING: visibly working, not escalated" : ""}${r.action ? `, THIS ROUND: ${r.action}` : ""}`;
};
