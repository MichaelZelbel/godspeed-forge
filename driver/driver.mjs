#!/usr/bin/env node
// The factory driver's round (2026-11-18, plan Task 8). Every five minutes (factory-driver.timer, as
// root) one round: read the world once, keep the ledger of real milestones, turn anything that is not
// moving into an obstacle, collect the helpers that finished and act on their reports, keep the server
// clean, and for each obstacle without a running helper take the ladder's next step: at most
// MAX_HELPERS helpers at once, the oldest obstacle first. Only this round changes a release's state;
// Michael's word always wins.
//
//   node driver.mjs             one round
//   node driver.mjs --dry-run   read everything and print what the round would do; launch nothing,
//                               post nothing, write nothing (not even its own state)
//
// State in STATE_DIR (server.state_dir in the settings): state.json (obstacles first seen, each
// obstacle's history, running helpers, what Michael was told), ledger.json, decisions.jsonl (every
// action), heartbeat (the end of the last round), round.lock (pid; a dead pid's lock is taken over),
// helpers/<unit>/ (ai.mjs).
import "./readonly.mjs"; // first: a --dry-run changes nothing
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readWorld, defaultsFor as worldDefaults } from "./world.mjs";
import { updateLedger, findTicket } from "./progress.mjs";
import { findObstacles, MACHINE_KINDS } from "./obstacles.mjs";
import { nextStep } from "./ladder.mjs";
import { appendEvents, readJournal, view as journalView, roundEvents, prEvents, prSeenMap, coverage, headMirrorOk, monotonicNow, GODSPEED_RELEASE, readMono, containment, containmentCommits } from "./journal.mjs";
import { requiredRunId, seenFromTelegram, readActivity, resendDue, seenCheck, sendNotice, publishHeartbeat, mirroredHead, watcherHealth, supersessionLook, nextReleaseFacts, rung0 } from "./duties.mjs";
import { clockCheck, wentBackwards, verifyInstalled, deliver, readEnvFile } from "./facts.mjs";
import { gateStep, gateClear, GATE } from "./gate.mjs";
import { movingUntilFor, heldUntil, creditEvents, creditKeyById, ACTIVITY, buildInventory, advance, violationEntry, describeRow, parseStage, stageStalled, factoryWorking, CHAIN, H as HR } from "./inventory.mjs";
import { actDefaults as onDutyDefaults, launchAct, actResult, markHandled, answeredFile } from "./onduty.mjs";
import { aiDefaults, providers, factoryProvider, ladderCandidates, launchHelper, helperResult, refreshTokens, checkJson, helperDir, UNIT_RE } from "./ai.mjs";
import { applyReport, applyDueDefaults, actDefaults, notify, plain } from "./act.mjs";
import { housekeep, hkDefaults } from "./housekeeping.mjs";
import { stepRound, stepEntries, stepStatus, discoverSteps, runStep } from "./steps.mjs";
import { loadSettings, defaultSettingsDir } from "./settings.mjs";
import { fileCauses, causeDefaults } from "./causes.mjs";
import { countRescues } from "./rescues.mjs";
import { forgeArgv } from "./release-driver/release-driver-owner-steps.mjs";
import { gh as ghForge, SYSTEM_PATH } from "./release-driver/release-driver.mjs";
import { devRecords, versionWords } from "./release-driver/release-driver-cut.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60000, HOUR = 60 * MIN;
const iso = ms => new Date(ms).toISOString();
const AI_STEPS = ["diagnose", "product", "tests", "decide", "michael", "feasibility", "ops"];
export const MAX_HELPERS = 4;
export const HISTORY_KEEP = 20;
export const FRESH_AFTER_MINUTES = 30; // a machine obstacle that comes back after this long starts again at housekeeping

export const driverDefaults = (e = process.env, argv = process.argv) => ({
  ...worldDefaults(e), ...aiDefaults(e), ...actDefaults(e), ...hkDefaults(e), ...causeDefaults(e), ACT: { ...onDutyDefaults(e), ACT_DIR: e.FD_ACT_DIR || `${e.FD_STATE_DIR || "/var/lib/godspeed/forge/driver"}/acts` },
  STATE_DIR: e.FD_STATE_DIR || "/var/lib/godspeed/forge/driver",
  MAX_HELPERS: Number(e.FD_MAX_HELPERS || MAX_HELPERS),
  DEV_CHECKOUT: e.FD_DEV_CHECKOUT || "",
  TOOLS_DIR: e.FD_TOOLS_DIR || "",
  HOLDOUTS_DIR: e.FD_HOLDOUTS_DIR || "",
  HELPERS_DIR: e.FD_HELPERS_DIR || path.join(HERE, "briefs"),
  DRY: argv.includes("--dry-run"),
  // helper kinds not launched on this server for now (a drop-in sets it; e.g. "tests" while another
  // session rebuilds the hidden-check tools): the obstacle waits and the round says why
  HOLD_KINDS: String(e.FD_HOLD_KINDS || "").split(",").map(x => x.trim()).filter(Boolean),
});

// ---------------------------------------------------------------- files
const readJson = (f, d) => {
  let text;
  try { text = fs.readFileSync(f, "utf8"); } catch { return d; }
  try { return JSON.parse(text); } catch {
    try { fs.renameSync(f, `${f}.corrupt-${Date.now()}`); } catch {} // kept for a look; the round rebuilds from the sources
    return d;
  }
};
function writeJson(f, data) { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o755 }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(data, null, 2) + "\n"); fs.renameSync(t, f); }
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
// -> a release function, or null while another round (a live pid) holds the lock; a dead pid's lock is taken over
export function takeLock(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const f = path.join(dir, "round.lock");
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(f, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: iso(Date.now()) })); fs.closeSync(fd);
      return () => { try { if ((readJson(f, {}) || {}).pid === process.pid) fs.rmSync(f, { force: true }); } catch {} };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = readJson(f, null);
      if (held && Number.isInteger(held.pid) && held.pid !== process.pid && alive(held.pid)) return null;
      fs.rmSync(f, { force: true }); // stale (dead pid or unreadable): taken over
    }
  }
  return null;
}

// ---------------------------------------------------------------- the real server
// A command as root, or as the factory user inside its network namespace with its own user manager.
export const shFor = env => (cmd, { asForge = false } = {}) => {
  const u = env.FORGE_USER, uid = env.FORGE_UID;
  const [file, args] = asForge
    ? forgeArgv(env, ["env", "-i", `HOME=/home/${u}`, `PATH=/home/${u}/.local/bin:/usr/local/bin:/usr/bin:/bin`, "LANG=C.UTF-8", `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, "bash", "-c", cmd])
    : ["bash", ["-c", cmd]];
  const r = spawnSync(file, args, { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024, env: { PATH: SYSTEM_PATH } });
  if (r.status !== 0) throw new Error(((r.stderr || "").trim().split("\n").pop() || (r.error && r.error.message) || `exit ${r.status}`).slice(0, 300));
  return r.stdout || "";
};

// ---------------------------------------------------------------- briefs
const bullets = list => (list || []).map(x => `- ${x}`).join("\n") || "- (nothing recorded)";
const historyText = h => (h || []).map(e => `- ${e.at} ${e.helper}${e.provider ? ` (${e.provider}/${e.model})` : ""}: ${e.outcome}${e.cause ? `, cause ${e.cause}` : ""}${e.summary ? `: ${String(e.summary).slice(0, 400)}` : ""}`).join("\n") || "Nothing yet.";
const latest = (h, helper) => [...(h || [])].reverse().find(e => e.helper === helper);
// The values for a brief's {{PLACEHOLDERS}} (ai.mjs fills RUN_ID, NOW, MINUTES, MODEL, MARKER, RUN_DIR, REPO, OWNER_ISSUE, PROTECTED).
export function contextFor(env, ob, step, world, history, readFile = f => fs.readFileSync(f, "utf8")) {
  const f = ob.ticketKey ? findTicket(world, ob.ticketKey) : null;
  const release = f ? f.release : (world.releases || [])[0] || null;
  let ticket = "There is no ticket: the obstacle is about the factory or the server, not one item.";
  if (f) { try { ticket = readFile(path.posix.join(String(f.release.dir || "").replace(/\\/g, "/"), "tickets", f.ticket.file)); } catch { ticket = `Ticket ${f.ticket.file} (#${f.ticket.issue}): ${f.ticket.title}`; } }
  const items = Array.isArray(ob.board)
    ? `The parked items on ${ob.repo || env.REPO}'s board (open, labelled needs-owner): ${ob.board.map(n => `#${n}`).join(", ")}. Decide ONE of them; put its number in "item".`
    : release ? (release.tickets || []).map(t => `- item ${t.item}: #${t.issue || "?"} ${t.title}${t.deferred ? " (moved to the next release)" : ""}`).join("\n") : "";
  const d = latest(history, "diagnose");
  return {
    OBSTACLE_ID: ob.id, OBSTACLE_KIND: ob.kind, TICKET_KEY: ob.ticketKey || ob.project || ob.timer || "-", SINCE: ob.since,
    EVIDENCE: bullets(ob.evidence), HISTORY: historyText(history), APPROACH_NOTE: step.approachNote || "",
    DIAGNOSIS: d ? `${d.cause || "unknown"}: ${d.summary || ""}` : "No diagnosis yet.",
    TICKET: String(ticket).slice(0, 12000), ITEMS: items, PLAN: release ? String(release.plan || "").slice(0, 12000) : "",
    RELEASE: release ? release.id : "-", MAIN_SHA: (world.main && world.main.sha) || "unknown", TOOLS_DIR: env.TOOLS_DIR, HOLDOUTS_DIR: env.HOLDOUTS_DIR,
  };
}

// What Michael reads when something has not moved for a day, or no AI answers for hours: one plain sentence.
export function tellText(ob, world, now) {
  const hours = Math.max(1, Math.floor((now - Date.parse(ob.since)) / HOUR));
  if (ob.kind === "no-ai") return plain(`None of the AIs that keep your factory moving has answered for ${hours} hours, so nothing gets fixed right now; Mission Control keeps trying every five minutes and carries on by itself.`);
  const f = ob.ticketKey ? findTicket(world, ob.ticketKey) : null;
  const what = f ? `"${f.ticket.title}" in ${versionWords((/(\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+(?:\.\d+)*)?)/.exec(f.release.id) || [])[1] || f.release.id)}` : ob.project ? `The factory's work on ${ob.project}` : "The factory";
  return plain(`${what} has not moved for ${hours} hours. Mission Control is on it and tries a different way each time; you need to do nothing unless it asks you.`);
}

// ---------------------------------------------------------------- one round
export async function round(env, deps = {}) {
  let now = deps.now ? deps.now() : Date.now();
  let nowIso = iso(now);
  const log = deps.log || (s => console.log(s));
  const dry = !!env.DRY;
  const release = dry ? () => {} : takeLock(env.STATE_DIR);
  if (!release) { log("another round is still going; this one stops"); return { busy: true }; }
  const stateFile = path.join(env.STATE_DIR, "state.json"), ledgerFile = path.join(env.STATE_DIR, "ledger.json"), decisionsFile = path.join(env.STATE_DIR, "decisions.jsonl");
  const record = e => { if (!dry) fs.appendFileSync(decisionsFile, JSON.stringify({ at: iso(deps.now ? deps.now() : Date.now()), ...e }) + "\n"); };
  try {
    const state = readJson(stateFile, {});
    for (const k of ["firstSeen", "history", "helpers", "seq", "toldAt", "cleared", "timerRounds", "told", "chain", "acts"]) state[k] ||= {};
    state.actRuns ||= []; state.stageWatch ||= null;
    state.defaultsApplied ||= [];
    const gh = deps.gh || ((args, input) => ghForge(env, args, input));
    const out = { obstacles: [], launched: [], applied: [], housekeeping: { done: [], failed: [] }, collected: [], steps: [] };
    const push = (id, e) => { const h = (state.history[id] ||= []); h.push(e); if (h.length > HISTORY_KEEP) h.splice(0, h.length - HISTORY_KEEP); };
    const recordsOf = (() => { let r; return async () => (r ||= deps.records || await devRecords(env)); })();

    // ---- the journal and the clock (9.4, 9.10, 8.6): intervals are monotonic, GitHub's Date header only anchors
    const journalFile = path.join(env.STATE_DIR, "journal.jsonl");
    const roundCredit = {}; // credit granted this round by in-progress answers: counted at once, with the journal's credit and any debt
    try { state.mirroredHead = (deps.mirroredHead || mirroredHead)(env) || state.mirroredHead || ""; } catch {}
    const jread = (deps.readJournal || readJournal)(journalFile);
    const jv0 = journalView(jread.events);
    const creditUsed = k => (jv0.credits[k] || 0) + ((state.creditDebt || {})[k] || 0) + (roundCredit[k] || 0);
    const mono = (deps.mono || readMono)();
    const mn = monotonicNow(now, jv0.lastRound, mono);
    const gc = (deps.clockCheck || clockCheck)(now);
    const clock = { ok: gc.ok && !mn.jumped, skewMs: gc.skewMs, ghNow: gc.ghNow, backwards: wentBackwards(now, jv0.lastRoundAt), jumped: mn.jumped, why: mn.why };
    if (mn.jumped || (Number.isFinite(gc.ghNow) && !gc.ok)) { now = Math.max(mn.jumped ? mn.now : now, Number.isFinite(gc.ghNow) ? gc.ghNow : 0); nowIso = iso(now); } // deadlines count from the later of the two
    else if (clock.backwards) { now = jv0.lastRoundAt; nowIso = iso(now); }

    // ---- logins of running guarded helpers (a token lasts an hour, a product helper up to 90 minutes)
    if (!dry) for (const u of (deps.refreshTokens || refreshTokens)(env)) record({ kind: "renewed a helper's login", unit: u });

    // ---- which AI can work now (the factory's own subscription last of the two)
    const list = await (deps.providers || (() => providers(env, factoryProvider(env))))();
    const candidates = ladderCandidates(list);
    if (!list.length && !state.noAi) { state.noAi = { since: nowIso, evidence: "every provider reported its limit or has no login" }; record({ kind: "no AI reachable" }); }
    if (list.length && state.noAi) { record({ kind: "an AI is reachable again", after: state.noAi.since }); state.noAi = null; }
    const check = deps.check || checkJson(env, list);

    // ---- the world, once (before collecting, so a report is acted on against what is true now)
    const world = await (deps.readWorld || readWorld)(env, { gh, sh: deps.sh || shFor(env), ...(deps.worldDeps || {}) });
    let ledger = readJson(ledgerFile, {});
    const unreadableParts = []; // a release that cannot be evaluated is "unreadable", which escalates
    for (const rel of world.releases || []) {
      try { ledger = updateLedger(ledger, { ...world, releases: [rel] }, now); }
      catch (e) { unreadableParts.push({ part: `release ${rel.id}`, error: String(e.message).slice(0, 200) }); }
    }
    out.releasesStatus = (world.releases || []).map(r => ({ id: r.id, approvedAt: (ledger[`release:${r.id}`] || {}).firstSeenAt || null, lastMilestoneAt: (ledger[`release:${r.id}`] || {}).lastMilestoneAt || null }));
    state.superseded ||= {};
    for (const r of world.superseded || []) if (!state.superseded[r.id]) { state.superseded[r.id] = nowIso; record({ kind: "release superseded", release: r.id, version: r.version, by: r.by, why: `${r.version} is approved but older than ${r.by}, which is installed on the server; it is not driven` }); }
    // ---- the steps (steps.mjs): collect what their children wrote, start the ones that are due, run the inline ones; their health becomes entries
    let stepRes = { launched: [], collected: [], running: {}, errors: [] }, stepEnts = [];
    if (deps.stepsCtx) {
      try {
        stepRes = await stepRound({ ...deps.stepsCtx, state, now, dry, log, node: env.NODE }, deps.stepDeps || {});
        for (const x of stepRes.collected) record({ kind: "step finished", step: x.name, ok: x.ok, summary: x.summary });
        for (const n of stepRes.launched) record({ kind: "step started", step: n });
        for (const e of stepRes.errors) record({ kind: "step runner failed", why: e });
        stepEnts = stepEntries(state, deps.stepsCtx.steps, deps.stepsCtx.settings, now);
      } catch (e) { record({ kind: "steps failed", why: String(e.message).slice(0, 200) }); }
    }
    const withSteps = a => (a ? { ...a, stepRuns: stepRes.running } : a);
    const title = ob => { const f = ob.ticketKey ? findTicket(world, ob.ticketKey) : null; return f ? f.ticket.title : ""; };

    // ---- helpers that finished: the report goes into the obstacle's history and is acted on
    for (const [id, h] of Object.entries(state.helpers)) {
      if (dry) { out.collected.push({ unit: h.unit, state: "not collected (dry run)" }); continue; }
      const r = (deps.helperResult || helperResult)(env, h.unit);
      if (r.state === "running") continue;
      const rep = r.report || {};
      push(id, { at: r.endedAt || nowIso, helper: h.kind, provider: h.provider, model: h.model, unit: h.unit, outcome: r.state === "done" ? "ok" : (r.reason || "failed"),
        ...(rep.cause ? { cause: rep.cause } : {}), summary: String(rep.summary || r.reason || "").slice(0, 600),
        ...(rep.buildable !== undefined ? { buildable: rep.buildable } : {}), ...(rep.approach ? { approach: String(rep.approach).slice(0, 300) } : {}) });
      out.collected.push({ unit: h.unit, state: r.state, reason: r.reason || "" });
      record({ kind: "helper finished", unit: h.unit, obstacle: id, helper: h.kind, state: r.state, why: r.reason || "", cause: rep.cause || "", summary: String(rep.summary || "").slice(0, 300) });
      if (r.state === "done") {
        const a = await applyReport(env, h.obstacle, rep, { gh, kind: h.kind, id: h.unit, startedAt: h.startedAt, state, codex: check, title: h.title || "", records: h.kind === "cut" ? await recordsOf() : undefined });
        record({ kind: "acted on a report", unit: h.unit, obstacle: id, ...a });
        // the independent check refused a technical decision: the next attempt's brief carries why (the ladder's note
        // quotes the previous attempt), so it decides again; refused a second time, act.mjs has already settled it
        if (a.refusal) { const last = (state.history[id] || []).at(-1); if (last) { if (last.helper === "michael") last.helper = "decide"; /* the ladder reads a cause from decide, never from michael */ last.outcome = "refused"; last.cause = "how"; last.summary = `Your last answer was refused: ${a.refusal} Decide it yourself as a technical matter, so that every existing check stays exactly as it is and whatever was objected to no longer applies.`; } }
      }
      delete state.helpers[id];
    }

    // ---- obstacles (a timer counts once it has been seen stopped for two rounds)
    const down = {};
    for (const f of world.factories || []) for (const [u, s] of Object.entries(f.timers || {})) if (!/^(active|activating|reloading)$/.test(s)) down[u] = (state.timerRounds[u] || 0) + 1;
    state.timerRounds = down;
    const fcfg = { firstSeen: state.firstSeen, noAi: state.noAi, timerRounds: down };
    let obstacles;
    try { obstacles = findObstacles({ ...world, unreadable: [...(world.unreadable || []), ...unreadableParts] }, ledger, now, fcfg); }
    catch {
      // one release breaks the evaluation: judge each release alone, the rest of the world once without releases
      obstacles = findObstacles({ ...world, releases: [], unreadable: [...(world.unreadable || []), ...unreadableParts] }, ledger, now, fcfg);
      for (const rel of world.releases || []) {
        try { obstacles.push(...findObstacles({ ...world, releases: [rel], factories: [], factory: null, tools: null, server: null, main: null, unreadable: [] }, ledger, now, fcfg)); }
        catch (e) { obstacles.push(...findObstacles({ ...world, releases: [], unreadable: [{ part: `release ${rel.id}`, error: String(e.message).slice(0, 200) }], factories: [], tools: null, server: null, main: null }, ledger, now, fcfg).filter(o => o.kind === "unreadable")); }
      }
    }
    out.obstacles = obstacles;
    const ids = new Set(obstacles.map(o => o.id));
    for (const o of obstacles) {
      if (!state.firstSeen[o.id]) {
        // a machine problem that comes back after half an hour starts again at housekeeping
        if (MACHINE_KINDS.includes(o.kind) && state.cleared[o.id] && now - Date.parse(state.cleared[o.id]) > FRESH_AFTER_MINUTES * MIN) delete state.history[o.id];
        state.firstSeen[o.id] = o.since; delete state.cleared[o.id];
        record({ kind: "obstacle", id: o.id, obstacle: o.kind, key: o.ticketKey || o.project || o.timer || "", evidence: o.evidence });
      }
    }
    for (const id of Object.keys(state.firstSeen)) if (!ids.has(id)) { delete state.firstSeen[id]; state.cleared[id] = nowIso; record({ kind: "obstacle cleared", id }); }
    for (const [id, at] of Object.entries(state.cleared)) if (now - Date.parse(at) > 7 * 24 * HOUR) { delete state.cleared[id]; delete state.history[id]; delete state.toldAt[id]; delete state.seq[id]; if (state.refusals) delete state.refusals[id]; if (state.technical) delete state.technical[id]; }

    // ---- questions to Michael whose deadline passed: the default applies (listed for the go message)
    if (!dry) {
      const d = await applyDueDefaults(env, { gh, codex: check, now: () => now });
      out.applied = d.applied || [];
      if (d.done.length || d.failed.length) record({ kind: "defaults", ...d });
      for (const a of out.applied) {
        const rel = a.repo && a.repo !== env.REPO ? null : (world.releases || []).find(r => (r.tickets || []).some(t => t.issue === a.issue));
        state.defaultsApplied.push({ ...a, release: rel ? rel.id : null });
        if (rel) {
          try {
            const records = await recordsOf(); const file = `releases/${rel.id}/defaults-applied.json`;
            const have = readJsonText(records.read(file)) || { release: rel.id, applied: [] };
            have.applied.push(a);
            records.write({ [file]: `${JSON.stringify(have, null, 2)}\n` }, `${rel.id}: the default of #${a.issue} applies (no answer by its deadline; factory driver)`);
          } catch (e) { record({ kind: "default not noted for the go message", issue: a.issue, why: String(e.message).slice(0, 200) }); }
        }
      }
    }

    // ---- the next step of every obstacle, the oldest first
    const pending = pendingQuestions(env);
    const steps = [];
    for (const ob of [...obstacles].sort((a, b) => Date.parse(a.since) - Date.parse(b.since))) {
      if (state.helpers[ob.id]) { steps.push({ ob, do: "running", unit: state.helpers[ob.id].unit }); continue; }
      // no provider at all: every one counts as used up, so the ladder probes again instead of launching
      const ctx = () => ({ now, candidates, exhausted: list.length ? [] : ["codex", "claude", "openrouter"], toldAt: state.toldAt[ob.id] || null, freeAllow: env.OPENROUTER_ALLOW });
      let st = nextStep(ob, state.history[ob.id] || [], ctx());
      if (st.do === "tell-michael") {
        const text = tellText(ob, world, now);
        if (!dry) { const a = await applyReport(env, ob, { text, key: `tell:${ob.id}:${Date.parse(ob.since)}`, about: "The factory is stuck", ref: ob.id }, { kind: "tell-michael", state }); record({ kind: "told Michael", obstacle: ob.id, ...a }); }
        else log(`  would tell Michael: ${text}`);
        state.toldAt[ob.id] = nowIso;
        st = nextStep(ob, state.history[ob.id] || [], ctx());
      }
      // a question for Michael on this item (his, or one a refused or owner-only decision became) holds every
      // AI step: the same question is never put to another model until one passes, and no default applies
      if (["michael", "decide", "product"].includes(st.do) && ob.issue && pending.has(`${ob.repo || env.REPO}#${Number(ob.issue)}`)) st = { do: "wait-external", approachNote: "Michael was asked; the item waits for his answer. No default applies and no other model is asked the same question." };
      steps.push({ ob, ...st });
    }


    // ---- locks older than their job's longest run are removed (never a reason for a round to fail)
    if (!dry) { try { for (const x of (deps.expireLocks || expireLocks)(env, now)) record({ kind: "stale lock removed", ...x }); } catch (e) { record({ kind: "lock check failed", why: String(e.message).slice(0, 200) }); } }
    // ---- rung 0: the fixes that need no AI, each at most once per window
    if (!dry) { try { for (const x of await (deps.rung0 || rung0)(env, world, state, now, undefined, async (rel, t, sha) => { // a ticket's done line, from the merge GitHub shows
        const records = await recordsOf(); const file = `releases/${rel.id}/tickets/${t.file}`; const body = records.read(file) || "";
        if (/^Status:\s*done\b.*\bmerge\s+[0-9a-f]{40}\b/im.test(body)) return false;
        const line = `Status: done (merge ${sha})`;
        records.write({ [file]: /^Status:.*$/im.test(body) ? body.replace(/^Status:.*$/im, line) : `${line}

${body}` }, `${rel.id}: item ${t.item} is done, merge ${sha.slice(0, 7)} (factory driver)`);
        return true;
      })) record({ kind: "rung 0", ...x }); } catch (e) { record({ kind: "rung 0 failed", why: String(e.message).slice(0, 200) }); } }
    // ---- the inventory and the chain (inventory.mjs): every open thing has an owner and a deadline
    // acting runs that finished first: what they did goes into the entry's tries
    for (const [eid, a] of Object.entries(state.acts)) {
      if (dry) continue;
      const r = (deps.actResult || actResult)(env, env.ACT, a.unit);
      if (r.state === "running") continue;
      const c = state.chain[eid];
      if (c && r.result === "in-progress" && (c.holds || 0) < 2 && ACTIVITY.creditHours * HR - (creditUsed(creditKeyById(eid, c.nan ? undefined : c.milestone))) > 0) { c.holds = (c.holds || 0) + 1; const ck = creditKeyById(eid, c.nan ? undefined : c.milestone); const grant = Math.min(2 * HR, ACTIVITY.creditHours * HR - creditUsed(ck)); roundCredit[ck] = (roundCredit[ck] || 0) + grant; c.holdUntil = now + grant; c.holdAt = now; c.launched = true; try { appendEvents(journalFile, [{ t: "credit", key: ck, ms: grant, at: nowIso }]); } catch { (state.creditDebt ||= {})[ck] = ((state.creditDebt || {})[ck] || 0) + grant; } (c.tries ||= []).push({ rung: a.rung, at: nowIso, provider: a.provider, result: "in-progress", summary: String(r.said || "").slice(-300) }); } // moving, never a failure
      else if (c) { (c.tries ||= []).push({ rung: a.rung, at: nowIso, provider: a.provider, result: r.result, summary: String(r.said || "").slice(-500) }); if (r.result === "notice") { c.rung = 3; c.rungSince = now; c.launched = true; c.told = false; } } // the notice goes out through both transports below, with receipts // it told Michael itself: rung 3, restarts after 24 hours
      if (a.queue && r.result === "resolved") { try { markHandled(answeredFile(env.ACT), a.queue.repo, a.queue.heading); } catch (e) { record({ kind: "queue item not marked", why: String(e.message).slice(0, 200) }); } }
      record({ kind: "acting run finished", unit: a.unit, entry: eid, provider: a.provider, result: r.result, summary: String(r.said || "").slice(-400) });
      delete state.acts[eid];
    }
    let stage = null;
    try { const text = await (deps.stageLook || stageLookReal)(env); stage = text ? parseStage(text) : null; } catch { stage = null; }
    // deterministic fallbacks for the shipping steps (setup fixes, not cuts), before any acting rung
    if (!dry && stage) { try { for (const x of await (deps.fallbacks || shippingFallbacks)(env, stage, state, now)) record({ kind: "shipping fallback", ...x }); } catch (e) { record({ kind: "shipping fallback failed", why: String(e.message).slice(0, 200) }); } }
    if (stageStalled(stage)) { const key = `${stage.id}\n${stage.reason || stage.result}`; if (!state.stageWatch || state.stageWatch.reasonKey !== key) state.stageWatch = { reasonKey: key, since: now - stage.minutes * MIN }; } else if (stage) state.stageWatch = null;
    world.approvals = {}; try { world.approvals = await (deps.approvals || approvalTimes)(env, world); } catch { /* the ledger's first sight stands in */ }
    out.releasesStatus = out.releasesStatus.map(r => ({ ...r, approvedAt: world.approvals[r.id] || r.approvedAt }));
    let pauses = []; try { pauses = (deps.pauses || readPauses)(env, now, world); } catch (e) { record({ kind: "pauses unreadable", why: String(e.message).slice(0, 200) }); }
    // the journal: new approvals (sealed), new slots, the round's clock; the view is what the inventory reads
    let newEvents = [], jv = jv0, coverageBad = [];
    if (jread.ok) {
      try {
        newEvents = [...roundEvents(jv0, world, now, world.approvals || {}, mono), ...prEvents(jv0, world, now)];
        // "installed" is a fresh fact (8.7) and is re-verified every round (9.5)
        for (const jr of jv0.open) {
          if (!world.installed || world.installed.id !== jr.id) continue;
          const vi = (deps.verifyInstalled || verifyInstalled)({ version: world.installed.version }, world.installed.staging);
          if (vi.ok) newEvents.push({ t: "installed", release: jr.id, version: vi.version, commit: vi.commit, at: nowIso });
        }
        if (!dry) appendEvents(journalFile, newEvents);
        jv = journalView([...jread.events, ...newEvents]);
        coverageBad = coverage(jv, world, prSeenMap(jv0));
      } catch (e) { record({ kind: "journal write failed", why: String(e.message).slice(0, 200) }); }
    }
    if (jread.ok && !headMirrorOk(journalFile, state.mirroredHead)) coverageBad.push({ release: "journal", why: "the journal head mirrored on GitHub is not a line of this journal: it was replaced or rolled back" });
    // the latest installed release stays verified: a recorded install that the running Godspeed no longer shows is a stall
    const installedBad = [];
    const lastInstalled = Object.values(jv.releases).filter(r => r.installed && GODSPEED_RELEASE.test(r.id)).sort((x, y) => y.installed.at - x.installed.at)[0];
    let installedOk = false; // nothing is superseded unless an install was freshly verified this round
    if (!lastInstalled && world.installed) installedOk = (deps.verifyInstalled || verifyInstalled)({ version: world.installed.version }, world.installed.staging).ok;
    if (lastInstalled) {
      const vi = (deps.verifyInstalled || verifyInstalled)({ version: lastInstalled.installed.version }, { productCommit: lastInstalled.installed.commit });
      installedOk = vi.ok;
      // one unreadable answer is a blip (a restart, a busy moment), not a fault: it counts only after 3 rounds in a row
      const prevF = state.installedFails && state.installedFails.id === lastInstalled.id ? state.installedFails.n : 0;
      state.installedFails = { id: lastInstalled.id, n: vi.ok ? 0 : prevF + 1 };
      if (!vi.ok && state.installedFails.n >= 3) installedBad.push({ release: lastInstalled.id, why: `recorded as installed but ${vi.why} (${state.installedFails.n} rounds in a row)` });
    }
    coverageBad.push(...installedBad);
    // The false-alarm class an older version sent (about backlog, "not attempted yet, today's budget is spent") is retired before anything counts it:
    // never resent, never counted as undelivered.
    if (!dry) { const retire = Object.entries(jv.notices).filter(([nid, n]) => !n.seen && n.at < Date.parse("2026-11-22T01:00:00Z") && /today's budget of automatic repair runs is spent/.test(String(n.text || ""))); if (retire.length) { try { appendEvents(journalFile, retire.map(([nid]) => ({ t: "seen", id: nid, at: nowIso, why: "retired: a false alarm about backlog" }))); for (const [nid] of retire) jv.notices[nid].seen = true; } catch {} } }
    const undelivered = Object.entries(jv.notices).filter(([, n]) => !n.seen && !Object.keys(n.receipts || {}).length && now - n.at > 30 * MIN).map(([id, n]) => ({ id, since: n.at }));
    // the outside watcher records its own runs (9.8); a silent one is a stall, and the workflow is re-enabled
    if (!dry) { try { const wh = (deps.watcherHealth || watcherHealth)(env, now, undefined, state); if (!wh.ok) { coverageBad.push({ release: "watcher", why: `${wh.why}${wh.reenabled ? "; the driver re-enabled the workflow" : ""}` }); } } catch { /* GitHub unreachable is EXTERNAL */ } }
    // an older release a newer install passed leaves only after the containment check (8.3, 9.3)
    try {
      const sl = (deps.supersession || supersessionLook)(jv, world, undefined, env.SOURCE_CHECKOUT, installedOk);
      for (const x of sl.bad) coverageBad.push(x);
      if (!dry && sl.leave.length) {
        const ev = sl.leave.map(x => ({ t: "left", release: x.release, why: "superseded", by: x.by, check: x.check, at: nowIso }));
        appendEvents(journalFile, ev); jv = journalView([...jread.events, ...newEvents, ...ev]);
        for (const x of sl.leave) notify(env, { state }, `left:${x.release}`, plain(`${x.release} was not installed itself; its work is part of ${x.by}, which now runs on your server. Nothing is lost.`), "A release was superseded", now); // through the funnel
      }
    } catch (e) { record({ kind: "supersession check failed", why: String(e.message).slice(0, 200) }); }
    const nextRelease = await (deps.nextRelease || nextReleaseFacts)(env, world, jv, now);
    // what is visibly moving (6): GitHub runs in progress and auto-stage's STOP file
    // the credit used so far: the journal's, plus any debt a failed write left in the state (it fails closed: never refilled)
    const debt = (state.creditDebt ||= {});
    const credits = { ...jv.credits }; for (const [k, ms] of Object.entries(debt)) credits[k] = (credits[k] || 0) + ms; for (const [k, ms] of Object.entries(roundCredit)) credits[k] = (credits[k] || 0) + ms;
    let activity = null; try { activity = withSteps(await (deps.activity || ((e, w) => readActivity(e, w, undefined, now)))(env, world)); } catch { activity = null; }
    let entries = [];
    let invCtx = null;
    try { entries = buildInventory(world, ledger, obstacles, invCtx = { now, stepEntries: stepEnts, stage, stageSince: stageStalled(stage) ? state.stageWatch : null, approvals: world.approvals || {}, pauses, activity, credits: credits, journalView: jv, journalOk: jread.ok, journalWhy: jread.why, coverageBad, clock, undelivered, nextRelease }); }
    catch (e) { record({ kind: "inventory failed", why: String(e.message).slice(0, 300) }); out.inventoryFailed = String(e.message).slice(0, 300); }
    const force = new Set(steps.filter(s => s.do === "act").map(s => `ob:${s.ob.id}`)); // a helper said "external", or a cause nobody knows: rung 1 now
    const runsToday = state.actRuns.filter(r => now - r.at < 24 * HR).length;
    const advOpts = { forceRung1: force, runsToday, slotFree: Object.keys(state.acts).length === 0 };
    let adv = advance(entries, state.chain, now, advOpts);
    for (const r of adv.rows) if (r.entry.obstacleKind === "unclassified" || String(r.entry.id).startsWith("unclassified:")) record({ kind: "unclassified entry", entry: r.entry.id, evidence: (r.entry.evidence || []).slice(0, 2) });
    if (adv.violations.length) { // the rule broke itself: that is an entry too, straight to rung 1
      for (const v of adv.violations) record({ kind: "chain violation", entry: v.entry.id, rung: v.rung });
      adv = advance([...entries, ...adv.violations.map(violationEntry)], state.chain, now, advOpts);
    }
    // the moving credit used this round goes into the journal (so a lost state cannot refill it)
    if (!dry && jread.ok) {
      const ce = creditEvents(adv.rows, now, jv0.lastRoundAt);
      const owed = Object.entries(debt).map(([key, ms]) => ({ t: "credit", key, ms, at: nowIso })); // credit a failed write left unrecorded
      try { appendEvents(journalFile, [...ce, ...owed]); for (const k of Object.keys(debt)) delete debt[k]; }
      catch (e) { for (const x of ce) debt[x.key] = (debt[x.key] || 0) + x.ms; record({ kind: "credit not written", why: String(e.message).slice(0, 160) }); } // fails closed: the debt counts until it is written
    }
    out.stepStatus = deps.stepsCtx ? stepStatus(state, deps.stepsCtx.steps, deps.stepsCtx.settings, stepRes.running) : {}; out.journalHead = jread.head; out.clock = clock; out.inventory = adv.rows; out.violations = adv.violations.length; out.actRunsToday = runsToday; out.pauses = pauses;
    // one sentence per entry; when many reach rung 3 together (an old backlog), ONE message names the count and the first three
    const allTells = adv.actions.tell, singles = allTells.filter(r => r.entry.remindOnly || r.entry.reminder);
    // THE GATE (gate.mjs): nothing reaches Michael on one reading. (a) the same condition on 3 reads at least 10 minutes apart; (b) a fresh re-read of
    // every source right before sending; (c) no source unreadable in that re-read (unreadable: look again, never alarm). Reminders are the one exception.
    state.gate ||= {};
    const wanting = allTells.filter(r => !(r.entry.remindOnly || r.entry.reminder));
    gateClear(state.gate, new Set(wanting.map(r => r.entry.id)));
    const gcfg = deps.gateCfg || GATE;
    const readyRows = wanting.filter(r => gateStep(state.gate, r.entry.id, now, gcfg).ready);
    let tells = [];
    if (readyRows.length && !dry) {
      const recheck = deps.recheck || (async ids => {
        // (b) every source again, (c) any of them unreadable means: look again
        const w2 = await (deps.readWorld || readWorld)(env, { gh, sh: deps.sh || shFor(env), ...(deps.worldDeps || {}) });
        if ((w2.unreadable || []).length) return new Set();
        const j2 = (deps.readJournal || readJournal)(journalFile); if (!j2.ok) return new Set();
        const jv2 = journalView([...j2.events]);
        const gc2 = (deps.clockCheck || clockCheck)(now); if (gc2.unread) return new Set();
        let stage2 = null; try { const text2 = await (deps.stageLook || stageLookReal)(env); stage2 = text2 ? parseStage(text2) : null; } catch { return new Set(); }
        let activity2 = null; try { activity2 = await (deps.activity || ((e, w) => readActivity(e, w, undefined, now)))(env, w2); } catch { return new Set(); }
        const l2 = updateLedger(JSON.parse(JSON.stringify(ledger)), w2, now);
        const ob2 = findObstacles(w2, l2, now, fcfg);
        // everything the first decision rested on, read again: coverage, the install check, delivery, pauses, the goal between releases
        const cov2 = coverage(jv2, w2, prSeenMap(jv2));
        if (!headMirrorOk(journalFile, state.mirroredHead)) cov2.push({ release: "journal", why: "the journal head mirrored on GitHub is not a line of this journal: it was replaced or rolled back" });
        try { const wh2 = (deps.watcherHealth || watcherHealth)(env, now, undefined, JSON.parse(JSON.stringify(state))); if (!wh2.ok) cov2.push({ release: "watcher", why: wh2.why }); } catch { /* GitHub unreachable is EXTERNAL */ }
        try { const sl2 = (deps.supersession || supersessionLook)(jv2, w2, undefined, env.SOURCE_CHECKOUT, true); for (const x of sl2.bad) cov2.push(x); } catch { return new Set(); }
        const lastInst2 = Object.values(jv2.releases).filter(r => r.installed && GODSPEED_RELEASE.test(r.id)).sort((x, y) => y.installed.at - x.installed.at)[0];
        if (lastInst2) { const vi2 = (deps.verifyInstalled || verifyInstalled)({ version: lastInst2.installed.version }, { productCommit: lastInst2.installed.commit }); if (!vi2.ok && (state.installedFails && state.installedFails.n >= 3)) cov2.push({ release: lastInst2.id, why: `recorded as installed but ${vi2.why}` }); }
        const undelivered2 = Object.entries(jv2.notices).filter(([, n]) => !n.seen && !Object.keys(n.receipts || {}).length && now - n.at > 30 * MIN).map(([id, n]) => ({ id, since: n.at }));
        let pauses2 = []; try { pauses2 = (deps.pauses || readPauses)(env, now, w2); } catch { return new Set(); }
        let next2 = null; try { next2 = await (deps.nextRelease || nextReleaseFacts)(env, w2, jv2, now); } catch { return new Set(); }
        const e2 = buildInventory(w2, l2, ob2, { ...(invCtx || { now }), now, journalView: jv2, journalOk: true, stage: stage2, stageSince: stageStalled(stage2) ? state.stageWatch : null, activity: activity2, credits, coverageBad: cov2, undelivered: undelivered2, pauses: pauses2, nextRelease: next2, clock: { ok: gc2.ok, skewMs: gc2.skewMs, backwards: false } });
        const chain2 = JSON.parse(JSON.stringify(state.chain || {}));
        const adv2 = advance(e2, chain2, now, { runsToday: state.actRuns.filter(r => now - r.at < 24 * HR).length, slotFree: false });
        return new Set(ids.filter(id => adv2.rows.some(r => r.entry.id === id && r.rung === 3 && !r.moving && !r.entry.told)));
      });
      let sure = new Set();
      try { sure = await recheck(readyRows.map(r => r.entry.id)); } catch { sure = new Set(); }
      tells = readyRows.filter(r => sure.has(r.entry.id));
      for (const r of readyRows) if (!sure.has(r.entry.id)) { delete state.gate[r.entry.id]; record({ kind: "message held", entry: r.entry.id, why: "the fresh re-read did not confirm it, or a source was unreadable: three new readings are needed" }); }
    }
    const triedN = tells.filter(r => (r.c.tries || []).some(t => t.rung === 1 || t.rung === 2)).length, untriedN = tells.length - triedN;
    const groups = tells.length > 2 ? [{ rows: tells, text: plain(`${tells.length} things in the factory are stuck: ${triedN ? `Mission Control tried to fix ${triedN} of them by itself and they are still stuck` : "none of them has been tried yet"}${untriedN ? `${triedN ? ", and " : "; "}${untriedN} ${triedN ? "were" : "were"} not attempted yet because today's budget of automatic repair runs is spent` : ""}. For example: ${tells.slice(0, 3).map(r => String(r.entry.title).replace(/\s+/g, " ").slice(0, 90)).join("; ")}${tells.length > 3 ? `, and ${tells.length - 3} more` : ""}. Mission Control keeps trying; nothing is needed from you unless a later message says so.`), nid: `n:bundle:${crypto.createHash("sha1").update(tells.map(r => r.entry.id).sort().join("|")).digest("hex").slice(0, 12)}:${Math.floor(now / (6 * HR))}` }]
      : tells.map(r => ({ rows: [r], text: entryTellText(r, now), nid: `n:${r.entry.id}:${r.c.rungSince}` }));
    groups.push(...singles.map(r => ({ rows: [r], text: entryTellText(r, now), nid: `n:${r.entry.id}:${r.c.rungSince}` })));
    for (const g of groups) {
      let ok = false;
      if (!dry) {
        // Godspeed's own notice queue, and both transports with a receipt each (8.11); told = at least one receipt
        const a = await applyReport(env, { id: g.rows[0].entry.id }, { text: g.text, key: `tell:${g.nid}`, about: noticeTitle(g.rows) }, { kind: "tell-michael", state, gated: true });
        const n = await sendNotice(env, g.nid, noticeTitle(g.rows), g.text, now, deps.deliver, g.rows.map(r => r.entry.id));
        appendEvents(journalFile, [n]);
        for (const r of g.rows) r.c.receipts = n.receipts;
        record({ kind: "told Michael", entries: g.rows.map(r => r.entry.id), queue: !a.failed.length, receipts: n.receipts, failed: n.failed });
        ok = Object.keys(n.receipts).length > 0;
      }
      if (ok) for (const r of g.rows) { r.c.told = true; r.c.toldAt = nowIso; }
    }
    // THE FUNNEL's flush: requests that reached notify() without the gate (the ladder's 24 hour message, the cut, repeated repairs, the rescues, a supersession) go out only
    // when the same request has stood on 3 readings 10 minutes apart and a fresh re-read of the world is complete and unreadable-free
    if (!dry) {
      const pend = state.pendingNotices || {};
      for (const [k, p] of Object.entries(pend)) if ((p.ref && !ids.has(p.ref)) || now - (p.firstAt || now) > 6 * HR) delete pend[k]; // the condition is gone (or the request is stale): never sent
      state.gatePending ||= {};
      gateClear(state.gatePending, new Set(Object.keys(pend)));
      const readyKeys = Object.keys(pend).filter(k => gateStep(state.gatePending, k, now, gcfg).ready);
      if (readyKeys.length) {
        let okWorld = false;
        let ids3 = ids;
        let w3fresh = null;
        try { const w3 = await (deps.readWorld || readWorld)(env, { gh, sh: deps.sh || shFor(env), ...(deps.worldDeps || {}) }); w3fresh = w3; okWorld = !(w3.unreadable || []).length;
          if (okWorld) { const l3 = updateLedger(JSON.parse(JSON.stringify(ledger)), w3, now); ids3 = new Set(findObstacles(w3, l3, now, fcfg).map(o => o.id)); } } catch { okWorld = false; }
        for (const k of readyKeys) { const pr = pend[k] && pend[k].ref; if (okWorld && pr && !ids3.has(pr)) { delete pend[k]; delete state.gatePending[k]; } } // the obstacle is gone in the fresh read: never sent
        if (deps.recheck) okWorld = (await deps.recheck([])) !== null; // tests
        // a supersession notice says the newer release runs: that is read again before it is said
        const heldLeft = new Set();
        for (const k of readyKeys) if (/^left:/.test(k) && pend[k]) { // the release that the notice says runs is the one verified; a different newest release holds the notice (never sent false, never dropped early)
          const by = (/part of (\S+), which now runs/.exec(String(pend[k].text)) || [])[1];
          const wi = w3fresh && w3fresh.installed; // the fresh read of the world names the release that runs now: it must be the one the notice names
          const vi = wi && wi.id === by ? (deps.verifyInstalled || verifyInstalled)({ version: wi.version }, wi.staging) : { ok: false };
          if (!vi.ok) heldLeft.add(k); } // only this notice waits: the others are not held by it
        for (const k of readyKeys.filter(x => pend[x])) {
          if (!okWorld || heldLeft.has(k)) { delete state.gatePending[k]; record({ kind: "message held", pending: k, why: "a source was unreadable in the fresh re-read: three new readings are needed" }); continue; }
          const p = pend[k];
          const a2 = await applyReport(env, { id: k }, { text: p.text, key: k, about: p.about || "The factory" }, { kind: "tell-michael", state, gated: true });
          const n2 = await sendNotice(env, `p:${k}`, p.about || "The software factory", p.text, now, deps.deliver);
          appendEvents(journalFile, [n2]);
          const delivered = !a2.failed.length || Object.keys(n2.receipts).length > 0;
          if (delivered) { delete pend[k]; delete state.gatePending[k]; } // nothing delivered anywhere: it stays filed and is tried again (never lost)
          record({ kind: delivered ? "told Michael" : "told Michael: nothing delivered, kept", pending: k, queue: !a2.failed.length, receipts: n2.receipts });
        }
      }
    }
    // "told" means seen (9.9): a notice nobody has opened is sent again through both transports after 2 hours and then every
    // morning, and these repeats never wait on the seen
    let tapped = [];
    if (!dry) { try { tapped = await seenFromTelegram(env, state, jv.notices, deps); } catch { tapped = []; } } // his tap on the Seen button counts as much as closing the issue
    if (!dry) for (const [nid, n] of Object.entries(jv.notices)) {
      if (n.seen || !Object.keys(n.receipts || {}).length) continue;
      if (tapped.includes(nid)) { appendEvents(journalFile, [{ t: "seen", id: nid, at: nowIso }]); continue; }
      try {
        const sc = (deps.seenCheck || seenCheck)(n);
        if (sc.seen) { appendEvents(journalFile, [{ t: "seen", id: nid, at: nowIso }]); continue; }
        if (sc.unreadable) continue; // an unreadable lookup: look again, never resend
        const holds = (n.entries || []).some(eid => adv.rows.some(r => r.entry.id === eid && r.rung >= 3 && !r.entry.told === false || (r.entry.id === eid && r.rung >= 3)));
        if (holds && resendDue(n, now)) appendEvents(journalFile, [await sendNotice(env, nid, `Still open: ${n.title || "the software factory needs a look"}`, n.text, now, deps.deliver)]);
      } catch (e) { record({ kind: "resend failed", notice: nid, why: String(e.message).slice(0, 160) }); }
    }
    let L = adv.actions.launch;
    if (L && !dry && entries.length) { // work may have started since the round began (auto-stage's STOP, a run): look again right before launching
      try { const again = withSteps(await (deps.activity || ((e, w) => readActivity(e, w, undefined, now)))(env, world)); const m = heldUntil(L.entry, again && { ...again, waitingOnMain: !!(stage && /(main'?s?\b[^.]*\b(required check|Windows setup|image))|(image\b[^.]*not in the registry)/i.test(String(stage.reason || ""))), releaseId: (stage && stage.id) || undefined, onlyRelease: jv.open.length === 1 ? jv.open[0].id : null }, world, credits, now); if (Number.isFinite(m) && m > now) { record({ kind: "acting run held", entry: L.entry.id, why: "work started on it meanwhile" }); L = null; } } catch { /* unreadable: launch as decided */ }
    }
    if (L && !dry) {
      const names = list.map(p => p.name), first = [...(L.c.tries || [])].reverse().find(t => t.rung === 1); // the latest rung 1 try
      const provider = L.rung === 2
        ? (() => { const w = (first && first.provider) === "claude" ? "codex" : "claude"; return names.includes(w) ? w : null; })() // never the provider rung 1 used
        : names.includes("codex") ? "codex" : names.includes("claude") ? "claude" : null;
      L.c.launched = true; L.c.launchedAt = now; // one launch per rung, whatever happens

      const n = (state.seq[`act:${L.entry.id}`] || 0) + 1;
      const unit = `factory-act-${crypto.createHash("sha1").update(L.entry.id).digest("hex").slice(0, 10)}-${n}`;
      state.seq[`act:${L.entry.id}`] = n;
      try {
        if (!provider) throw new Error("no AI provider is reachable for an acting run");
        (deps.launchAct || launchAct)(env, env.ACT, { unit, entry: L.entry, provider, tried: L.c.tries || [] });
        state.acts[L.entry.id] = { unit, provider, rung: L.rung, startedAt: nowIso, queue: L.entry.kind === "queue" ? { repo: L.entry.repo, heading: L.entry.queueHeading } : null };
        state.actRuns.push({ at: now, entry: L.entry.id, provider }); state.actRuns = state.actRuns.filter(r => now - r.at < 48 * HR);
        record({ kind: "acting run launched", unit, entry: L.entry.id, rung: L.rung, provider });
        state.chain = adv.chain; writeJson(stateFile, state); // saved at once: the run outlives this round, so the next one must know it
      } catch (e) {
        (L.c.tries ||= []).push({ rung: L.rung, at: nowIso, provider: provider || "none", result: "unresolved", summary: `could not start: ${String(e.message).slice(0, 300)}` });
        record({ kind: "acting run launch failed", entry: L.entry.id, why: String(e.message).slice(0, 300) });
      }
    }
    if (!dry) state.chain = adv.chain;

    // ---- housekeeping: the server's hiccups, and the timers whose step is housekeeping
    world.timersToStart = steps.filter(s => s.do === "housekeeping" && s.ob.kind === "factory-stopped" && s.ob.timer).map(s => s.ob.timer);
    if (!dry) {
      out.housekeeping = await (deps.housekeep || housekeep)(env, world, deps.hkDeps || {});
      if (out.housekeeping.done.length || out.housekeeping.failed.length) record({ kind: "housekeeping", ...out.housekeeping });
    }
    const hkSummary = [...out.housekeeping.done, ...out.housekeeping.failed.map(f => `not done: ${f}`)].join("; ").slice(0, 600) || "nothing to do for it";
    for (const s of steps) if (s.do === "housekeeping" && !dry) push(s.ob.id, { at: nowIso, helper: "housekeeping", outcome: out.housekeeping.failed.length ? "failed" : "ok", summary: hkSummary });

    // ---- cuts and helpers
    let running = Object.keys(state.helpers).length;
    for (const s of steps) {
      const ob = s.ob;
      if (s.do === "cut") {
        if (dry) { s.note = "would move the ticket to the next release under the plan's rule"; continue; }
        const last = latest(state.history[ob.id], "feasibility") || {};
        const a = await applyReport(env, ob, { why: last.summary || ob.evidence.join("; "), evidence: ob.evidence }, { gh, kind: "cut", state, title: title(ob), records: await recordsOf() });
        push(ob.id, { at: nowIso, helper: "cut", outcome: a.failed.length || !a.done.length ? "failed" : "ok", summary: [...a.done, ...a.failed, ...a.skipped].join("; ").slice(0, 600) });
        record({ kind: "cut", obstacle: ob.id, ...a });
        continue;
      }
      if (!AI_STEPS.includes(s.do)) continue;
      if ((env.HOLD_KINDS || []).includes(s.do)) { s.note = `held: ${s.do} helpers are paused on this server (FD_HOLD_KINDS)`; continue; }
      if (running >= env.MAX_HELPERS) { s.note = `waits: ${env.MAX_HELPERS} helpers are running`; continue; }
      // the hidden-check tools are one folder: while a tests helper works in it (an earlier set of missing
      // tools, whose obstacle had another id), a new set waits for it instead of a second helper beside it
      if (ob.kind === "tools-missing" && Object.values(state.helpers).some(h => h.kind === "tests" && h.obstacle && h.obstacle.kind === "tools-missing")) { s.note = "waits: a tests helper is still working on the hidden-check tools"; continue; }
      let n = (state.seq[ob.id] || 0) + 1;
      while (fs.existsSync(path.join(helperDir(env, `factory-helper-${ob.id}-${n}`), "run.json"))) n++;
      const unit = `factory-helper-${ob.id}-${n}`;
      if (!UNIT_RE.test(unit)) { s.note = `not a unit name: ${unit}`; continue; }
      s.unit = unit;
      if (dry) { s.note = `would launch ${unit}`; running++; continue; }
      const henv = ob.repo && ob.repo !== env.REPO ? { ...env, REPO: ob.repo, SOURCE_CHECKOUT: ob.checkout || env.SOURCE_CHECKOUT } : env;
      try {
        const h = await (deps.launchHelper || launchHelper)(henv, { unit, kind: s.do, provider: s.provider, model: s.model, briefFile: path.join(env.HELPERS_DIR, `${s.do}.md`),
          context: contextFor(env, ob, s, world, state.history[ob.id] || [], (deps.worldDeps && deps.worldDeps.readFile) || undefined),
          ownerIssue: deps.ownerIssue !== undefined ? deps.ownerIssue : ownerIssueOf(gh, henv.REPO) });
        state.seq[ob.id] = n;
        state.helpers[ob.id] = { unit, kind: s.do, provider: s.provider, model: s.model, startedAt: nowIso, obstacle: ob, title: title(ob) };
        running++;
        out.launched.push({ unit, kind: s.do, provider: s.provider, model: s.model, obstacle: ob.id, obstacleKind: ob.kind });
        record({ kind: "launched", unit, helper: s.do, provider: s.provider, model: s.model, obstacle: ob.id, obstacleKind: ob.kind, note: s.approachNote || "" });
      } catch (e) {
        state.seq[ob.id] = n;
        push(ob.id, { at: nowIso, helper: s.do, provider: s.provider, model: s.model, unit, outcome: "failed", summary: `could not start: ${String(e.message).slice(0, 300)}` });
        record({ kind: "launch failed", unit, obstacle: ob.id, why: String(e.message).slice(0, 300) });
      }
    }
    out.steps = steps.map(s => ({ obstacle: s.ob.id, kind: s.ob.kind, key: s.ob.ticketKey || s.ob.project || s.ob.timer || "", since: s.ob.since, do: s.do, provider: s.provider, model: s.model, unit: s.unit, note: s.note || "" }));

    // ---- a repair that keeps coming back gets one ticket for its cause (causes.mjs)
    if (!dry) {
      try { await (deps.causes || fileCauses)(env, { gh, state, now, record, notify: (key, text) => notify(env, { state }, key, text, "The factory repeats a repair", now) }); }
      catch (e) { record({ kind: "cause tickets failed", why: String(e.message).slice(0, 200) }); }
    }
    // ---- the hand rescues since the last round, per week; Sunday 18:00 one sentence (rescues.mjs)
    if (!dry) { try { await (deps.rescues || countRescues)(env, { state, world, now, record, notify: (key, text) => notify(env, { state }, key, text, "The factory's hand rescues this week", now) }); } catch (e) { record({ kind: "rescue count failed", why: String(e.message).slice(0, 200) }); } }

    if (!dry) {
      // the releases this round drives, for the outside check (heartbeat/status.py); kept when unreadable
      if (!(world.unreadable || []).some(u => u.part === "releases")) state.releases = (world.releases || []).map(r => r.id);
      writeJson(ledgerFile, ledger);
      writeJson(stateFile, state);
      const anchor = out.clock && out.clock.skewMs > 5 * MIN && Number.isFinite(out.clock.ghNow) ? iso(out.clock.ghNow) : nowIso; // never a future time in a file a monitor trusts
      const status = statusOf(out, anchor, now, state); status.guarantee = GUARANTEE; status.journalHead = (deps.readJournal || readJournal)(journalFile).head || out.journalHead; // the head after this round's lines
      status.clock = out.clock;
      status.rung3 = (status.rung3 || []).map(r => ({ ...r, receipts: (state.chain[r.id] || {}).receipts || {} }));
      writeJson(path.join(env.STATE_DIR, "status.json"), status);
      try { (deps.publishHeartbeat || publishHeartbeat)(env, status); } catch { /* GitHub unreachable is EXTERNAL; the watcher will see the silence */ }
      fs.writeFileSync(path.join(env.STATE_DIR, "heartbeat"), `${iso(Date.now())}\n`);
    }
    out.world = world;
    return out;
  } finally { release(); }
}
const readJsonText = t => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
// The repository's "Owner decisions needed" issue: the guard keeps helpers from posting there. "" when none.
const owners = {};
function ownerIssueOf(gh, repo) {
  if (repo in owners) return owners[repo];
  try {
    const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "Owner decisions needed"`);
    const items = ((gh([`search/issues?q=${q}&per_page=5`]) || {}).items || []).filter(i => i.title === "Owner decisions needed").sort((a, b) => b.number - a.number);
    return (owners[repo] = items.length ? items[0].number : "");
  } catch { return ""; }
}
// The issues the driver asked Michael about and whose question is still open (driver-questions.json).
function pendingQuestions(env) {
  const data = readJson(path.join(env.QUESTIONS_DIR, "driver-questions.json"), {});
  return new Set(Object.entries(data || {}).flatMap(([repo, list]) => (Array.isArray(list) ? list : []).filter(q => q && Number.isInteger(Number(q.issue))).map(q => `${repo}#${Number(q.issue)}`)));
}



// ---------------------------------------------------------------- pauses, locks, shipping fallbacks
const IMAGE_WF = env => env.IMAGE_WORKFLOW || process.env.IMAGE_WORKFLOW || "";
const HOLD_FILE = e => e.HOLD_FILE || path.join(e.FD_KEEPER_HOME || "/usr/local/lib/godspeed/forge/keeper", "HOLD");
const when = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : NaN; };
// Every pause that is in force: the keeper's HOLD file, a project's PAUSE or STOP file written by a person (a
// program's STOP is housekeeping's), and a deliberately parked project (its units in a paused-<date> folder).
// An expiry written in it ("until <iso time>") is its deadline.
export function readPauses(env, now, world = {}) {
  const out = readPauseFiles(env, now, world);
  // a pause record counts as his only with his Telegram user id and the message it came from (9.6), re-checked each round
  const recs = (() => { try { return JSON.parse(fs.readFileSync(path.join(env.STATE_DIR, "pauses.json"), "utf8")); } catch { return []; } })();
  const allowed = String(process.env.FD_ALLOWED_USERS || readEnvFile(env.TG_ENV || "").TELEGRAM_ALLOWED_USERS || "").split(",").map(s => s.trim()).filter(Boolean);
  for (const p of out) {
    const rec = (Array.isArray(recs) ? recs : []).find(x => x && x.target === p.id);
    if (rec && rec.messageId && rec.telegramUser && allowed.includes(String(rec.telegramUser))) { p.ownerRef = `Telegram message ${rec.messageId}`; if (rec.until) p.expiresAt = Date.parse(rec.until); }
    else p.maxHours = /^STOP/.test(p.id) ? 2 : 2; // a program's pause expires at its maximum (auto-stage: 2 hours)
  }
  return out;
}
function readPauseFiles(env, now, world = {}) {
  const out = [];
  const expiry = line => { const m = /\buntil\s+(\d{4}-\d\d-\d\d(?:[T ][\d:.]+Z?)?)/i.exec(String(line || "")); return m ? when(m[1].replace(" ", "T")) : NaN; };
  try {
    const f = HOLD_FILE(env), line = (fs.readFileSync(f, "utf8").split("\n")[0] || "").trim();
    out.push({ id: "hold", all: true, what: "the factory driver is on hold", since: fs.statSync(f).mtimeMs, expiresAt: expiry(line), line });
  } catch {}
  for (const f of world.factories || []) {
    for (const st of [f && f.pause, f && f.stop && f.stop.kind === "STOP" && !f.stop.writer ? f.stop : null]) { // a PAUSE and an operator STOP are both pauses, each with its own reminder
      if (st && (st.kind === "PAUSE" || (st.kind === "STOP" && !st.writer))) out.push({ id: `${st.kind}:${f.project}`, repo: f.repo || null, what: `${f.project} has a ${st.kind} file`, since: when(st.at), expiresAt: expiry(st.line), line: st.line });
    }
  }
  try {
    const base = path.join(env.FORGE_HOME || "/home/factory", ".config/systemd/user");
    for (const d of fs.readdirSync(base).filter(n => /^paused-/.test(n))) {
      const names = fs.readdirSync(path.join(base, d)).filter(n => /^archonfactory-.*\.timer$/.test(n) && !/-manager\.timer$/.test(n)).map(n => n.replace(/^archonfactory-|\.timer$/g, ""));
      if (names.length) { const m = /(\d{4})(\d\d)(\d\d)/.exec(d); out.push({ id: `parked:${d}`, repos: names.map(n => `${String(env.REPO || "owner/x").split("/")[0]}/${n}`), what: `parked projects (${names.join(", ")})`, since: m ? when(`${m[1]}-${m[2]}-${m[3]}`) : fs.statSync(path.join(base, d)).mtimeMs, expiresAt: NaN, line: "" }); }
    }
  } catch {}
  return out;
}
// Locks older than the longest run of their job: the round's own (10 minutes + margin), the acting-run folder's
// is a unit with its own limit, auto-stage's (its unit's 200 minutes). -> [{file, ageMin}] removed
export function expireLocks(env, now, locks = env.LOCKS) {
  const list = locks || [{ file: path.join(env.STATE_DIR, "round.lock"), maxMin: 20 }, ...(env.AUTO_STAGE_STATE ? [{ file: path.join(path.dirname(env.AUTO_STAGE_STATE), "auto-stage.lock"), maxMin: 210 }, { file: path.join(path.dirname(env.AUTO_STAGE_STATE), "lock"), maxMin: 210 }] : [])];
  const out = [];
  for (const l of list) {
    try { const age = (now - fs.statSync(l.file).mtimeMs) / MIN; if (age > l.maxMin) { fs.rmSync(l.file, { force: true }); out.push({ file: l.file, ageMin: Math.round(age) }); } } catch {}
  }
  return out;
}
// auto-stage says the server image for main's head is not in the registry, and CI never built it (a push trigger
// with a paths filter skips a merge that touches only other files): dispatch the workflow on main, once per commit.
export async function shippingFallbacks(env, stage, state, now, run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 60000, env: { PATH: SYSTEM_PATH, HOME: "/root" } })) {
  const out = [];
  // the freeze waits on main's required check and it failed, was cancelled or timed out: run it again once per commit and window
  const fc = /required check yet \((failure|failed|cancelled|timed_out)\)/i.exec(String(stage.reason || ""));
  if (fc) {
    const head = (() => { try { return JSON.parse(run("gh", ["api", `repos/${env.REPO}/commits/main`]).stdout).sha; } catch { return null; } })();
    const done = (state.fallbacks ||= {});
    if (head && (!done[`rerun:${head}`] || now - done[`rerun:${head}`] >= 2 * HOUR)) {
      done[`rerun:${head}`] = now;
      const id = requiredRunId(env.REPO, head, run);
      if (id) { const r = run("gh", ["api", "-X", "POST", `repos/${env.REPO}/actions/runs/${id}/rerun-failed-jobs`]); out.push({ did: `re-ran main's failed required check for ${head.slice(0, 7)} once (the freeze was waiting on it)`, ok: r.status === 0 }); }
      else delete done[`rerun:${head}`]; // the run that owns the check was not found: nothing recorded, look again next round
    }
  }
  const m = /image\s+\S+:v2-sha-([0-9a-f]{7,40})\s+is not in the registry/i.exec(String(stage.reason || ""));
  if (m && IMAGE_WF(env)) {
    const done = (state.fallbacks ||= {});
    const key = `image:${m[1]}`;
    if (!done[key] || now - done[key] >= 2 * HOUR) {
      const r = run("gh", ["workflow", "run", IMAGE_WF(env), "-R", env.REPO, "--ref", "main"]);
      done[key] = now;
      out.push({ did: `dispatched ${IMAGE_WF(env)} on main: the image for ${m[1]} was not built`, ok: r.status === 0, why: r.status === 0 ? "" : String(r.stderr || "").slice(0, 200) });
    }
  }
  return out;
}


// When each approved release was approved: the first commit of its plan that holds "Status: approved" (the
// the records repository checkout the driver already reads). {} when git cannot say.
export async function approvalTimes(env, world, run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 15000 })) {
  const out = {};
  for (const r of world.releases || []) {
    const rel = `releases/${r.id}/plan.md`;
    const g = run("git", ["log", "--format=%cI", "-i", "-G", "^\\s*status:\\s*approved", "--", rel], env.DEV_CHECKOUT);
    const last = String(g.stdout || "").trim().split("\n").filter(Boolean).at(-1);
    if (last && Number.isFinite(Date.parse(last))) out[r.id] = last;
  }
  return out;
}

// What Michael reads when an entry reached rung 3: what is stuck, what was tried, the one step only he can take.
// What is guaranteed, said plainly (also in the architecture document): the on-server pair, and the outside net with its real latency
export const GUARANTEE = "The driver and the dead-man on the server each restore the other and catch any single fault within minutes and restore it; if the repair fails, Michael is told after about three hours. The GitHub watcher is the net for the rare case where both die together: GitHub's scheduler on this account runs hours late, so its latency is up to about a day.";
export function entryTellText(r, now) {
  const hours = Math.max(1, Math.floor((now - (Number.isFinite(r.entry.milestoneAt) ? r.entry.milestoneAt : now)) / HOUR));
  const tried = (r.c.tries || []).filter(t => t.rung === 1 || t.rung === 2);
  const what = String(r.entry.title).replace(/\s+/g, " ").slice(0, 160);
  if (r.entry.reminder) return plain(r.entry.reminder);
  const did = tried.length ? `Mission Control tried ${tried.length === 1 ? "once" : `${tried.length} times`} to fix it by itself and it is still stuck${r.c.noBudget && !tried.some(t => t.rung === 2) ? "; a second attempt has not been made yet because today's budget of automatic repair runs is spent" : ""}`
    : r.c.noBudget ? "Mission Control has not attempted it yet: today's budget of automatic repair runs is spent" : "Mission Control has not been able to attempt it yet";
  // never homework: no "open a chat", no "say X"; a step is named only when it needs his credentials or his decision (none is known here)
  return plain(`${what} has not moved for ${hours} hours. ${did}. It keeps trying; nothing is needed from you unless a later message says so.`);
}
// The title says what the message is, never "stuck" for a reminder
export function noticeTitle(rows) {
  const kinds = new Set(rows.map(r => r.entry.kind));
  if (rows.length === 1) {
    const r = rows[0];
    if (r.entry.kind === "pause" || r.entry.kind === "pause-program") return `Reminder: ${String(r.entry.title).replace(/\s+since .*$/, "").replace(/\s*\(no record.*$/, "").slice(0, 80)} is still paused`;
    if (r.entry.kind === "tomichael") return "A question is waiting for you";
    return `The software factory is stuck: ${String(r.entry.title).replace(/\s+/g, " ").slice(0, 70)}`;
  }
  return `${rows.length} things in the software factory are stuck`;
}
// The file the outside checks read (the outside check's script): fresh, and every rung 3 entry with the time it was told.
export function statusOf(out, nowIso, now, state = {}) {
  const rows = out.inventory || [];
  return { at: nowIso, version: 1, releases: out.releasesStatus || [], inventoryFailed: out.inventoryFailed || null, entries: rows.length, violations: out.violations || 0, actRunsToday: out.actRunsToday || 0,
    unannounced: rows.filter(r => r.rung === 3 && !r.entry.told && !r.c.told).map(r => r.entry.id),
    byRung: [0, 1, 2, 3].map(k => rows.filter(r => r.rung === k).length),
    rung3: rows.filter(r => r.rung === 3 && !r.entry.told).map(r => ({ id: r.entry.id, title: String(r.entry.title).slice(0, 160), since: new Date(r.c.rungSince).toISOString(), text: entryTellText(r, now), toldAt: r.c.toldAt || null })),
    steps: out.stepStatus || {},
    rows: rows.filter(r => r.rung > 0).map(r => ({ id: r.entry.id, kind: r.entry.kind, title: String(r.entry.title).slice(0, 120), rung: r.rung, deadline: Number.isFinite(r.deadline) ? new Date(r.deadline).toISOString() : null })) };
}
// The stage step's own account of its look at the newest approved release (the words auto-stage printed for a dry run),
// which the step writes into its state folder (steps.stage.state_dir) as look.txt after every run. Nothing here waits on another
// program: a missing or day-old file is "not known" (null), which the inventory treats as no stage reading at all.
export async function stageLookReal(env) {
  const file = env.STAGE_LOOK_FILE || (env.AUTO_STAGE_STATE ? path.join(path.dirname(env.AUTO_STAGE_STATE), "look.txt") : "");
  if (!file) return null;
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > 24 * HOUR) return null;
    return fs.readFileSync(file, "utf8");
  } catch { return null; }
}

// ---------------------------------------------------------------- the dry run's account
export function describe(out) {
  const w = out.world || {};
  const lines = [];
  for (const r of w.releases || []) {
    lines.push(`release ${r.id}:`);
    for (const t of r.tickets || []) {
      const it = (w.items || {})[t.issue] || {};
      lines.push(`  item ${t.item} #${t.issue || "?"} ${t.deferred ? "moved to the next release" : `${it.state || "unread"}${(it.labels || []).includes("needs-owner") ? ", parked (needs-owner)" : ""}`}: ${t.title}`);
    }
  }
  for (const f of w.factories || []) lines.push(`factory ${f.project}: ${f.activeRuns.length} active run(s), board ${Array.isArray(f.board) ? f.board.length : "?"} parked; last decision: ${(f.lastDecisions.at(-1) || {}).text || "none"}${f.stop ? `; ${f.stop.kind}: "${f.stop.line}" (writer ${f.stop.writerAlive ? "alive" : "not running"}, scenarios ${f.stop.scenariosRunning === null ? "unknown" : f.stop.scenariosRunning ? "running" : "not running"})` : ""}; timers ${Object.entries(f.timers || {}).map(([u, s]) => `${u.replace(/^archonfactory-/, "")}=${s}`).join(", ")}`);
  for (const r of w.superseded || []) lines.push(`release ${r.id}: superseded (older than ${r.by}, installed); not driven`);
  if (w.installed) lines.push(`release ${w.installed.id}: installed on the owner's server, so done; not driven`);
  lines.push(`unreadable: ${(w.unreadable || []).map(u => `${u.part} (${u.error})`).join("; ") || "nothing"}`);
  lines.push(`inventory (${(out.inventory || []).length} entries, ${out.violations || 0} rule violations, ${out.actRunsToday || 0} acting runs in the last 24 h):`);
  for (const r of out.inventory || []) lines.push(`  ${describeRow(r, Date.now())}`);
  lines.push(`obstacles (${out.steps.length}):`);
  for (const s of out.steps) lines.push(`  ${s.kind} ${s.key} since ${s.since}: ${s.do}${s.provider ? ` on ${s.provider}/${s.model}` : ""}${s.note ? ` (${s.note})` : ""}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- the command
//   node driver.mjs [--settings-dir <dir>] [--dry-run]        one round
//   node driver.mjs --step <name> [--clear-halt] [--settings-dir <dir>] [--dry-run]    one step, writing its last.json
// The settings (settings.mjs) are read first and put into the environment the modules read; a missing key is named and nothing runs.
export async function cli(argv = process.argv.slice(2), io = {}) {
  const log = io.log || (s => console.log(s)), err = io.err || (s => console.error(s));
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = opt("--settings-dir") || process.env.FD_SETTINGS_DIR || defaultSettingsDir();
  const dry = argv.includes("--dry-run");
  let found, loaded;
  try {
    found = await discoverSteps();
    loaded = loadSettings(dir, { steps: found.steps });
  } catch (e) { err(e.message); return 1; }
  Object.assign(process.env, loaded.env);
  const base = { settings: loaded.settings, main: loaded.main, projects: loaded.projects, env: loaded.env, settingsDir: dir, dry, argv, clearHalt: argv.includes("--clear-halt"), log };
  if (opt("--step")) {
    const mod = found.steps.find(s => s.name === opt("--step"));
    if (!mod) { err(`there is no step ${opt("--step")} (${found.steps.map(s => s.name).join(", ") || "none installed"})`); return 2; }
    const r = await runStep(mod, base);
    log(JSON.stringify(r));
    return 0; // the result is in last.json; a failed step is the runner's business, not a failed unit
  }
  const env = driverDefaults(process.env, dry ? [...argv, "--dry-run"] : argv);
  // The hidden checks' tools are read in this process, by the test-machine step's own reading (toolCoverage(envFor(ctx))), not by a program started for it.
  const tm = found.steps.find(s => s.name === "test-machine" && s.module && typeof s.module.toolCoverage === "function" && typeof s.module.envFor === "function" && (loaded.settings.steps || {})["test-machine"]?.enabled !== false);
  const worldDeps = tm ? { toolCoverage: () => tm.module.toolCoverage(tm.module.envFor({ ...base, now: Date.now() })) } : {};
  const out = await round(env, { stepsCtx: { ...base, steps: found.steps }, worldDeps, ...(io.deps || {}) });
  if (out.busy) return 0;
  if (env.DRY) log(describe(out));
  else log(`round: ${out.obstacles.length} obstacle(s), ${out.collected.length} helper(s) collected, ${out.launched.length} launched (${out.launched.map(l => `${l.kind} ${l.obstacleKind}`).join(", ") || "none"}), housekeeping ${out.housekeeping.done.length} done / ${out.housekeeping.failed.length} not, ${out.applied.length} applied`);
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  cli().then(code => { process.exitCode = code; }, e => { console.error(e.stack || e.message); process.exit(1); });
}
