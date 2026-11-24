// The append-only journal (architecture 8.1, 8.4, 8.5): the driver's memory of every approval and every
// milestone, kept in a file that is only ever appended to (one JSON event per line, one writer at a time).
// Times of approvals and milestones are read from here, never from the driver's disposable state, so losing
// the state restarts no clock.
//
// Events:
//   {t:"approved", release, plan, at, tickets:[{item, issue}]}      the ticket set is SEALED here
//   {t:"slot", release, slot, at}                                   a milestone slot filled (once per slot)
//   {t:"installed", release, version, commit, at}                   only after a fresh request proved it (8.7)
//   {t:"left", release, why: "cancelled"|"superseded", by, check, at}   an explicit, recorded exit (8.3)
//   {t:"notice", id, at, receipts:{telegram, github}}               what Michael was told, and the proof
//   {t:"round", at}                                                 the clock of the last round (8.6)
//
// Slots (8.4): per sealed ticket exactly one each of t:<item>:opened | green | merged | closed, plus
// t:<item>:resolved (closed with its merge, or left under D-427); per release r:resolved, r:frozen, r:staged,
// r:scenarios, r:installed. Nothing else adds a slot.
import fs from "node:fs";
import { onMain } from "./delivery.mjs";
import path from "node:path";
import crypto from "node:crypto";

const ts = v => (v ? Date.parse(v) : NaN);
// The ONE definition of a release this server runs (the main project's own release plans, by releases.plan_pattern). The dead-man and the watcher carry the
// same pattern in their own programs (they share no code); test-gate.mjs asserts all three are identical.
// Read from FD_PLAN_PATTERN (the main project's releases.plan_pattern) at each use; no pattern means no plan counts.
let planSource = null, planRx = /(?!)/;
const planPattern = () => { const s = process.env.FD_PLAN_PATTERN || ""; if (s !== planSource) { planSource = s; planRx = s ? new RegExp(s) : /(?!)/; } return planRx; };
export const GODSPEED_RELEASE = { test: id => planPattern().test(String(id)), get source() { return planPattern().source; }, toString: () => String(planPattern()) };

function withLock(file, fn) {
  const lock = `${file}.lock`; let got = false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 60 && !got; i++) {
    try { fs.mkdirSync(lock); got = true; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmdirSync(lock); continue; } } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  if (!got) throw new Error("the journal is locked");
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}
// Every line is {...event, p: <hash of the line before>, h: <hash of p + the event>}: a checksum-framed, hash-chained
// journal (9.4). A line cut in half, edited or removed breaks the chain and the journal reads as "not ok".
const sum = (prev, body) => crypto.createHash("sha256").update(`${prev}\n${body}`).digest("hex").slice(0, 32);
export const GENESIS = "0".repeat(32);
export const frame = (prev, ev) => { const body = JSON.stringify(ev); return JSON.stringify({ ...ev, p: prev, h: sum(prev, body) }); };
function lastHash(file) {
  let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch { return GENESIS; }
  const lines = text.split("\n").filter(l => l.trim());
  if (!lines.length) return GENESIS;
  try { return JSON.parse(lines.at(-1)).h || GENESIS; } catch { return GENESIS; }
}
export function appendEvents(file, events) {
  if (!events.length) return;
  withLock(file, () => {
    let prev = lastHash(file); const out = [];
    for (const e of events) { const line = frame(prev, e); out.push(line); prev = JSON.parse(line).h; }
    fs.appendFileSync(file, out.join("\n") + "\n", { mode: 0o644 });
  });
}
// -> { ok, events, head, why }. A line that does not parse or does not chain makes the whole journal "not ok":
// every release then starts at rung 1 (8.5), which errs toward acting. A missing file is an empty journal.
export function readJournal(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return e.code === "ENOENT" ? { ok: true, events: [], head: GENESIS } : { ok: false, events: [], why: e.message }; }
  const events = []; let prev = GENESIS;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { return { ok: false, events: [], why: "an unreadable line in the journal" }; }
    const { p, h, ...ev } = e;
    if (!ev || typeof ev.t !== "string" || p !== prev || h !== sum(prev, JSON.stringify(ev))) return { ok: false, events: [], why: "a line of the journal does not chain to the one before it" };
    events.push(ev); prev = h;
  }
  return { ok: true, events, head: prev };
}
// The head mirrored on GitHub with each heartbeat must be a line of this journal (it may be behind, never absent).
export function headMirrorOk(file, mirrored) {
  if (!mirrored || mirrored === GENESIS) return true;
  try { return fs.readFileSync(file, "utf8").split("\n").some(l => { try { return JSON.parse(l).h === mirrored; } catch { return false; } }); } catch { return false; }
}
// The one narrow recovery command (9.4): keep every line up to the last good one, record what was cut, and say so.
export function recover(file, now = new Date()) {
  return withLock(file, () => {
    let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch { return { kept: 0, cut: 0 }; }
    const lines = text.split("\n").filter(l => l.trim()); let prev = GENESIS, kept = 0;
    for (const line of lines) {
      try { const { p, h, ...ev } = JSON.parse(line); if (p !== prev || h !== sum(prev, JSON.stringify(ev))) break; prev = h; kept++; } catch { break; }
    }
    fs.copyFileSync(file, `${file}.before-recovery-${now.getTime()}`);
    const line = frame(prev, { t: "recovered", at: now.toISOString(), kept, cut: lines.length - kept });
    fs.writeFileSync(file, lines.slice(0, kept).concat(line).join("\n") + "\n");
    return { kept, cut: lines.length - kept };
  });
}

// The journal as state: { releases: {id: {approvedAt, tickets (sealed), slots: {slot: at}, installed, left, lastMilestoneAt}}, notices: {id: {...}}, lastRoundAt }
export function view(events) {
  const releases = {}, notices = {}, credits = {}, clocks = {};
  let lastRoundAt = NaN, lastRound = null;
  for (const e of events) {
    const at = ts(e.at);
    if (e.t === "approved") releases[e.release] ||= { id: e.release, approvedAt: at, plan: e.plan, tickets: e.tickets || [], slots: {}, installed: null, left: null };
    else if (e.t === "slot" && releases[e.release]) { const r = releases[e.release]; if (!(e.slot in r.slots)) { r.slots[e.slot] = at; if (e.commit) (r.commits ||= {})[e.slot] = e.commit; } }
    else if (e.t === "installed" && releases[e.release]) releases[e.release].installed = { at, version: e.version, commit: e.commit };
    else if (e.t === "left" && releases[e.release]) releases[e.release].left = { at, why: e.why, by: e.by, check: e.check };
    else if (e.t === "notice") {
      const n = notices[e.id] || { at, receipts: {}, sentAt: [], seen: false };
      n.receipts = { ...n.receipts, ...(e.receipts || {}) };
      n.deliveryAttemptAt = Math.max(Number.isFinite(n.deliveryAttemptAt) ? n.deliveryAttemptAt : 0, at);
      if (Object.keys(e.receipts || {}).length) n.sentAt.push(at);
      n.title = e.title || n.title; n.text = e.text || n.text; if (e.entries) n.entries = e.entries; notices[e.id] = n;
    } else if (e.t === "seen" && notices[e.id]) notices[e.id].seen = true;
    else if (e.t === "credit" && e.key) credits[e.key] = (credits[e.key] || 0) + (Number(e.ms) || 0);
    // the release clock (standstill.mjs): when a release's state began, and the steps taken on it, so a lost state file never resets it
    else if (e.t === "clock-end" && e.release) delete clocks[e.release]; // the release paused (the owner's go, a question to him): the next clock starts fresh
    else if (e.t === "clock" && e.release && e.fp) clocks[e.release] = { fp: e.fp, parts: e.parts || null, since: Number(e.since), steps: [], launches: [], tries: [] };
    else if (e.t === "clock-step" && clocks[e.release] && clocks[e.release].fp === e.fp && !clocks[e.release].steps.includes(e.step)) { clocks[e.release].steps.push(e.step); if (e.provider) clocks[e.release].launches.push({ rung: e.step === "helper" ? 1 : 2, provider: e.provider }); }
    else if (e.t === "clock-try" && clocks[e.release] && clocks[e.release].fp === e.fp) clocks[e.release].tries.push({ rung: e.rung, at: e.at, provider: e.provider, result: e.result, summary: e.summary });
    else if (e.t === "round" && Number.isFinite(at)) { lastRoundAt = Math.max(Number.isFinite(lastRoundAt) ? lastRoundAt : 0, at); lastRound = { at, mono: e.mono, boot: e.boot }; }
  }
  for (const r of Object.values(releases)) r.lastMilestoneAt = Math.max(r.approvedAt || 0, ...Object.entries(r.slots).filter(([k]) => !k.startsWith("p:")).map(([, t]) => t).filter(Number.isFinite));
  return { releases, notices, credits, clocks, lastRoundAt, lastRound, open: Object.values(releases).filter(r => GODSPEED_RELEASE.test(r.id) && !r.installed && !r.left) };
}

// ---------------------------------------------------------------- what the sources show, as slots
// Every slot the world shows filled for the SEALED tickets of one release. -> [{slot, at}] (at: the source's own time when it has one)
export function slotsReached(world, release, sealed, staging) {
  const out = [], at = v => (Number.isFinite(ts(v)) ? v : null);
  for (const t of sealed) {
    const item = (world.items || {})[t.issue];
    if (!item) continue; // unreadable: no slot is filled by a missing read
    const prs = item.prs || [], k = `t:${t.item}`;
    const planned = (release.tickets || []).find(x => x.item === t.item);
    if (prs.length) out.push({ slot: `${k}:opened`, at: at(prs[0].createdAt) });
    if (prs.some(p => p.requiredState === "success")) out.push({ slot: `${k}:green`, at: at((prs.find(p => p.requiredState === "success") || {}).requiredSince) });
    const merged = prs.find(onMain); // into main: the release ships main (delivery.mjs)
    if (merged) out.push({ slot: `${k}:merged`, at: at(merged.mergedAt), commit: merged.mergeSha || null });
    else if (item.delivered) out.push({ slot: `${k}:merged`, at: at(item.delivered.mergedAt), commit: item.delivered.commit || null }); // an App named where it is on main (delivery.mjs)
    const closedWithMerge = item.state === "closed" && (!!merged || (item.mergedRefs || []).length > 0 || !!item.delivered);
    if (closedWithMerge) out.push({ slot: `${k}:closed`, at: at(item.closedAt) });
    if (closedWithMerge || (planned && planned.deferred)) out.push({ slot: `${k}:resolved`, at: at(item.closedAt) }); // a D-427 cut fills "resolved"
  }
  const resolved = sealed.length > 0 && sealed.every(t => out.some(s => s.slot === `t:${t.item}:resolved`));
  if (resolved) out.push({ slot: "r:resolved", at: null });
  const sg = staging || null;
  if (sg && sg.tag) out.push({ slot: "r:frozen", at: null });
  if (sg && sg.scenarios && (sg.scenarios.passed === true || /^pass/i.test(String(sg.scenarios.status || sg.scenarios.result || "")))) out.push({ slot: "r:scenarios", at: null });
  if (sg && (sg.stagedAt || /^(staged|installing|installed)$/.test(String(sg.status || "")))) out.push({ slot: "r:staged", at: at(sg.stagedAt) });
  return out;
}

// One round's writes: new approvals (with the sealed ticket set), new slots, the round's own clock.
// approvals: {releaseId: iso time of approval} when known (git); else the time of first sight.
// -> events (not yet appended)
export function roundEvents(v, world, now, approvals = {}, mono = {}) {
  const events = [], nowIso = new Date(now).toISOString();
  for (const rel of world.releases || []) {
    if (!GODSPEED_RELEASE.test(rel.id)) continue; // another product's plan is judged nowhere
    let jr = v.releases[rel.id];
    if (!jr) {
      const tickets = (rel.tickets || []).filter(t => t.issue && !t.deferred).map(t => ({ item: t.item, issue: t.issue }));
      events.push({ t: "approved", release: rel.id, plan: rel.id, at: approvals[rel.id] || nowIso, tickets });
      jr = { slots: {}, tickets };
    }
    for (const s of slotsReached(world, rel, jr.tickets, (world.staging || {})[rel.id])) {
      if (jr.slots && s.slot in jr.slots) continue;
      if (events.some(e => e.t === "slot" && e.release === rel.id && e.slot === s.slot)) continue;
      events.push({ t: "slot", release: rel.id, slot: s.slot, at: s.at || nowIso, ...(s.commit ? { commit: s.commit } : {}) });
    }
  }
  events.push({ t: "round", at: nowIso, mono: mono.uptime, boot: mono.boot });
  return events;
}

// ---------------------------------------------------------------- 8.2 / 9.2 / 9.11 the coverage proof
// By IDENTITY, explained by JOURNALED milestones only, never by the previous round's state:
//   - every open journal release is found in the sources;
//   - every sealed ticket's issue is readable;
//   - every pull request the journal saw for a ticket (event "pr") is still listed for it, or the journal holds that
//     ticket's merged/resolved slot.
// -> [{release, why}]
export function coverage(v, world, prSeen = {}) {
  const bad = [], seen = new Set((world.releases || []).map(r => r.id));
  const readFailed = (world.unreadable || []).some(u => u.part === "releases");
  for (const r of v.open) if (!seen.has(r.id) && !readFailed && !(world.superseded || []).some(s => s.id === r.id))
    bad.push({ release: r.id, why: "it is in the journal but this round's read did not find it" });
  for (const rel of world.releases || []) {
    const jr = v.releases[rel.id]; if (!jr) continue;
    for (const t of jr.tickets || []) {
      const item = (world.items || {})[t.issue];
      if (!item) { if (!readFailed) bad.push({ release: rel.id, why: `sealed ticket ${t.item} (issue ${t.issue}) could not be read` }); continue; }
      const listed = new Set((item.prs || []).map(p => p.number));
      const explained = `t:${t.item}:merged` in jr.slots || `t:${t.item}:resolved` in jr.slots;
      for (const n of (prSeen[`${rel.id}#${t.item}`] || [])) if (!listed.has(n) && !explained)
        bad.push({ release: rel.id, why: `pull request ${n} of ticket ${t.item} was seen before and is gone, and no journaled milestone explains it` });
    }
  }
  return bad;
}
// the pull requests to journal as "seen": [{release, ticket, number}] not yet in the journal
export function prEvents(v, world, now) {
  const out = [];
  for (const rel of world.releases || []) {
    const jr = v.releases[rel.id]; if (!jr) continue;
    for (const t of jr.tickets || []) for (const p of ((world.items || {})[t.issue] || {}).prs || []) {
      const key = `p:${t.item}:${p.number}`;
      if (!(key in jr.slots)) out.push({ t: "slot", release: rel.id, slot: key, at: new Date(now).toISOString() });
    }
  }
  return out;
}
export function prSeenMap(v) {
  const m = {};
  for (const r of Object.values(v.releases)) for (const k of Object.keys(r.slots)) { const x = /^p:(\d+):(\d+)$/.exec(k); if (x) (m[`${r.id}#${x[1]}`] ||= []).push(Number(x[2])); }
  return m;
}

// ---------------------------------------------------------------- 8.3 the containment check
// An older approved release may be superseded by a newer install only when every unfinished ticket of the
// older one is a ticket of the newer one (or was cut). older/newer: {issues:[n], unfinished:[n], cut:[n]}.
// 9.3: the issues of the unfinished tickets must be tickets of the newer release, AND every merge commit of the older
// release must be an ancestor of the newer candidate's commit (git merge-base --is-ancestor, asked through `isAncestor`).
export function containmentCommits(mergeShas, newerCommit, isAncestor) {
  const missing = (mergeShas || []).filter(sha => !isAncestor(sha, newerCommit));
  return { contained: missing.length === 0, missing };
}
export function containment(older, newer) {
  const inNewer = new Set(newer.issues || []), cut = new Set(older.cut || []);
  const missing = (older.unfinished || []).filter(n => !inNewer.has(n) && !cut.has(n));
  return { contained: missing.length === 0, missing };
}

// ---------------------------------------------------------------- 9.10 monotonic intervals
// Intervals are measured with the machine's uptime (it never jumps); the wall clock only anchors timestamps.
// last: the previous round {at, mono, boot}. -> { now (ms), jumped, why }. After a wall-clock jump the round's
// time is the last round's time plus the monotonic interval, and the jump is a stall (rung 1).
export function monotonicNow(wallNow, last, mono) {
  if (!last || !Number.isFinite(last.mono) || !Number.isFinite(mono.uptime) || last.boot !== mono.boot) return { now: wallNow, jumped: false };
  const real = (mono.uptime - last.mono) * 1000, wall = wallNow - last.at;
  if (Math.abs(real - wall) > 5 * 60000) return { now: last.at + real, jumped: true, why: `the wall clock moved ${Math.round(wall / 60000)} minutes while ${Math.round(real / 60000)} minutes passed` };
  return { now: wallNow, jumped: false };
}
export function readMono(read = f => fs.readFileSync(f, "utf8")) {
  try { return { uptime: Number(read("/proc/uptime").split(" ")[0]), boot: read("/proc/sys/kernel/random/boot_id").trim() }; } catch { return { uptime: NaN, boot: "" }; }
}
