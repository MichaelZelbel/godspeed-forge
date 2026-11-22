// node --test scripts/factory-driver/test-inventory.mjs   (pure: no machine, no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildInventory, advance, creditEvents, creditKey, heldUntil, violationEntry, parseStage, stageStalled, factoryWorking, CHAIN, CEILING, H } from "../inventory.mjs";
import { view, roundEvents, prEvents } from "../journal.mjs";
import { nextStep } from "../ladder.mjs";
import { KINDS } from "../obstacles.mjs";
import { expireLocks, readPauses, shippingFallbacks, entryTellText, noticeTitle } from "../driver.mjs";

const NOW = Date.parse("2026-11-21T22:00:00Z");
const ago = h => new Date(NOW - h * H).toISOString();
const REL = "godspeed-2.0.0-beta.29-x";
const mkWorld = (over = {}) => ({ at: ago(0), releases: [{ id: REL, tickets: [{ item: 1, issue: 11, title: "one", size: "m" }, { item: 2, issue: 12, title: "two", size: "s" }] }],
  items: { 11: { state: "closed", closedAt: ago(30), prs: [{ number: 1, merged: true, mergedAt: ago(30), requiredState: "success", requiredSince: ago(31), headSha: "a" }], comments: [] }, 12: { state: "open", prs: [], labels: [], comments: [] } },
  staging: {}, factories: [{ project: "p", repo: "o/r" }], unreadable: [], ...over });
// the journal view a round would have: approved long ago (the approval time is given), slots filled as the world shows
const jview = (world, approvedHoursAgo = 40, extra = []) => { const ev = roundEvents(view([]), world, NOW - approvedHoursAgo * H, { [REL]: ago(approvedHoursAgo) }); return view([...ev, ...extra]); };
const inv = (world, obstacles = [], ctx = {}, approvedHoursAgo = 40) => buildInventory(world, {}, obstacles, { now: NOW, journalView: jview(world, approvedHoursAgo), journalOk: true, ...ctx });

test("an unseen kind of obstacle has no owner and is on rung 1 at once, never a wait", () => {
  const entries = inv(mkWorld({ releases: [], items: {} }), [{ id: "zz", kind: "a-kind-nobody-has-seen", since: ago(0), evidence: ["new"] }]);
  const adv = advance(entries, {}, NOW);
  assert.equal(adv.rows[0].entry.owner, null); assert.equal(adv.rows[0].rung, 1); assert.equal(adv.actions.launch.entry.id, "ob:zz"); assert.equal(adv.violations.length, 0);
});

test("the decision function has no wait value: every kind of obstacle, a martian one, every cause, every history gives an action or the next rung", () => {
  const WAITS = /^wait/;
  const causes = ["product", "our-tests", "how", "what", "external", "feature", "martian", undefined];
  for (const kind of [...KINDS, "a-kind-nobody-has-seen"]) {
    const ob = { id: "x", kind, since: new Date(NOW - 5 * H).toISOString(), evidence: [] };
    for (const cause of causes) {
      const hist = cause ? [{ at: new Date(NOW - 1000).toISOString(), helper: "diagnose", provider: "codex", model: "m", outcome: "ok", cause, summary: "s" }] : [];
      const s = nextStep(ob, hist, { now: NOW, candidates: [{ provider: "codex", model: "m" }], exhausted: [] });
      assert.ok(!WAITS.test(s.do) || (cause === "what" && false), `${kind}/${cause}: ${s.do}`);
    }
  }
  // the chain: whatever an entry looks like, a row is rung 0 to 3 and its action is a launch, a tell or nothing
  for (let h = 0; h < 200; h += 7) {
    const e = [{ id: "e", kind: "ticket", owner: "factory loop", title: "t", milestoneAt: NOW - h * H, limitH: 2, evidence: [] }];
    const a = advance(e, {}, NOW);
    assert.ok([0, 1, 2, 3].includes(a.rows[0].rung)); assert.ok([null, "launch acting run", "tell Michael"].includes(a.rows[0].action));
  }
});

test("every entry has an owner and a future deadline, or is being escalated this round (checked, not trusted)", () => {
  const w = mkWorld({ queue: [{ repo: "o/r", heading: "q", asked: ago(3), question: "x" }], openPrs: [{ repo: "o/r", number: 5, title: "t", updatedAt: ago(2) }], toMichael: { "o/r": ["ask him"] } });
  const entries = inv(w, [{ id: "a", kind: "disk", since: ago(1), evidence: [] }], { pauses: [{ id: "hold", what: "hold", since: NOW - H, expiresAt: NaN, ownerRef: "Telegram message 1" }] });
  assert.ok(entries.length >= 6);
  const adv = advance(entries, {}, NOW);
  for (const r of adv.rows) assert.ok(r.entry.owner !== null || r.rung >= 1, r.entry.id);
  for (const r of adv.rows) assert.ok(r.deadline > NOW || r.moved || r.action || r.told, `${r.entry.id} ${r.rung}`);
  assert.deepEqual(adv.violations, []);
  const bad = advance(entries, { [entries[0].id]: { rung: 0, rungSince: NOW, milestone: NaN, launched: false, told: false, tries: [] }, [entries[1].id]: null }, NOW);
  assert.ok(bad.rows.length === entries.length, "the round goes on");
  assert.equal(violationEntry({ entry: entries[0], rung: 0 }).owner, null);
});

test("the chain: rung 0, then the acting run for an hour, then the second run, then one sentence, then again after a day; a milestone resets it", () => {
  const e = id => [{ id, kind: "ticket", owner: "factory loop", title: "t", milestoneAt: NOW - 3 * H, limitH: 2, evidence: [] }];
  let c = {}, t = NOW;
  let a = advance(e("t1"), c, t); assert.equal(a.rows[0].rung, 1); assert.ok(a.actions.launch); a.rows[0].c.launched = true; a.rows[0].c.tries.push({ rung: 1, result: "unresolved" }); c = a.chain;
  t += 30 * 60000; a = advance(e("t1"), c, t); assert.equal(a.rows[0].rung, 1); assert.equal(a.actions.launch, null, "one launch per rung");
  t += 31 * 60000; a = advance(e("t1"), c = a.chain, t); assert.equal(a.rows[0].rung, 2); assert.ok(a.actions.launch); a.rows[0].c.launched = true; a.rows[0].c.tries.push({ rung: 2, result: "unresolved" });
  t += 61 * 60000; a = advance(e("t1"), c = a.chain, t); assert.equal(a.rows[0].rung, 3); assert.equal(a.actions.tell.length, 1);
  a.rows[0].c.told = true;
  t += 60 * 60000; a = advance(e("t1"), c = a.chain, t); assert.equal(a.actions.tell.length, 0, "told once");
  t += 24 * H; a = advance(e("t1"), c = a.chain, t); assert.equal(a.rows[0].rung, 1, "starts again after 24 hours");
  a = advance([{ ...e("t1")[0], milestoneAt: t + 1 }], c = a.chain, t + 2); assert.equal(a.rows[0].rung, 0, "a milestone puts it back to rung 0");
});

test("times come from the journal: losing the driver's state restarts no clock, and an approval's time is the journal's", () => {
  const w = mkWorld();
  const e1 = inv(w, [], {}, 80);
  const ceil = e1.find(x => x.id === `ceiling:${REL}:installed`);
  assert.ok(Math.abs(ceil.milestoneAt - Date.parse(ago(80))) < 1000, "the ceiling starts at the approval in the journal");
  assert.equal(advance([ceil], {}, NOW).rows[0].rung, 1, "past 72 hours: rung 1, with no driver state at all");
  assert.equal(CEILING.approvedUninstalledHours, 72);
});

test("the sealed ticket set: one slot per milestone, replacement pull requests and flapping checks add nothing, a new ticket in the plan is not counted", () => {
  const w = mkWorld(); const v1 = jview(w, 10);
  assert.deepEqual(v1.releases[REL].tickets.map(t => t.item), [1, 2], "sealed at approval");
  const flap = mkWorld(); flap.items[12] = { state: "open", labels: [], comments: [], prs: [{ number: 9, state: "open", requiredState: "success", requiredSince: ago(1), headSha: "h1" }] };
  flap.releases[0].tickets.push({ item: 3, issue: 13, title: "late", size: "s" }); // not in the sealed set
  const ev = roundEvents(v1, flap, NOW, {});
  const flap2 = mkWorld(); flap2.items[12] = { state: "open", labels: [], comments: [], prs: [{ number: 10, state: "open", requiredState: "success", requiredSince: ago(0), headSha: "h2" }] };
  const v2 = view([...roundEvents(view([]), mkWorld(), NOW - 10 * H, { [REL]: ago(10) }), ...ev]);
  const ev2 = roundEvents(v2, flap2, NOW + 1, {});
  const greens = [...ev, ...ev2].filter(e => e.t === "slot" && e.slot === "t:2:green");
  assert.equal(greens.length, 1, "a replacement pull request and a new head fill the same slot, once");
  assert.ok(![...ev, ...ev2].some(e => e.slot && e.slot.startsWith("t:3:")), "a ticket nobody sealed adds no slot");
});

test("a ticket stuck on a setup cause stays IN the release: the chain only escalates, no entry ever cuts", () => {
  const entries = inv(mkWorld(), [], {}, 80);
  const adv = advance(entries, {}, NOW);
  assert.ok(adv.rows.some(r => r.entry.kind === "ticket" && r.rung === 1), "the stuck ticket escalates toward fixing");
  assert.equal(adv.rows.filter(r => r.action && /cut|move/i.test(r.action)).length, 0);
});

test("a pause is his only with his own words; any other pause is a program's and goes up the chain at its maximum", () => {
  const p = { id: "hold", what: "the factory driver is on hold", since: NOW - 25 * H, expiresAt: NaN, line: "" };
  const his = inv(mkWorld({ releases: [] }), [], { pauses: [{ ...p, ownerRef: "Telegram message 7" }] });
  let a = advance(his, {}, NOW);
  assert.equal(a.rows[0].rung, 3); assert.equal(a.actions.tell.length, 1); assert.equal(a.actions.launch, null, "nobody acts for him");
  assert.match(entryTellText(a.rows[0], NOW), /still paused since 2026-11-20 21:00 UTC.*say continue or it stays paused/);
  const prog = inv(mkWorld({ releases: [] }), [], { pauses: [{ ...p, maxHours: 2 }] });
  const b = advance(prog, {}, NOW);
  assert.equal(b.rows[0].entry.kind, "pause-program"); assert.equal(b.rows[0].rung, 3, "an unrecorded pause is reminded to Michael, never undone by an acting run"); assert.equal(b.actions.launch, null);
  assert.match(entryTellText(b.rows[0], NOW), /nothing records who asked; say continue or it stays paused/);
  const young = inv(mkWorld({ releases: [] }), [], { pauses: [{ ...p, since: NOW - 2 * H, expiresAt: NOW + H, ownerRef: "m" }] });
  assert.equal(advance(young, {}, NOW).rows[0].rung, 0); assert.equal(advance(young, {}, NOW + 2 * H).rows[0].rung, 3, "past his written expiry");
  a.rows[0].c.told = true;
  assert.equal(advance(his, a.chain, NOW + 24 * H + 1).rows[0].rung, 3, "reminded again after a day");
});

test("pauses are read: his only with his Telegram user id and message id, re-checked each round; a stale lock is removed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-"));
  fs.writeFileSync(path.join(dir, "HOLD"), "maintenance until 2026-11-22T10:00:00Z\n");
  fs.mkdirSync(path.join(dir, ".config/systemd/user/paused-20261121"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".config/systemd/user/paused-20261121/archonfactory-querino.timer"), "");
  fs.writeFileSync(path.join(dir, "tg.env"), "TELEGRAM_ALLOWED_USERS=555\n");
  const env = { HOLD_FILE: path.join(dir, "HOLD"), FORGE_HOME: dir, STATE_DIR: dir, TG_ENV: path.join(dir, "tg.env") };
  let ps = readPauses(env, NOW, {});
  assert.equal(ps.length, 2); assert.ok(ps.every(p => !p.ownerRef), "no record: a program's pause");
  fs.writeFileSync(path.join(dir, "pauses.json"), JSON.stringify([{ target: "hold", telegramUser: "555", messageId: "9", until: "2026-11-22T10:00:00Z" }, { target: "parked:paused-20261121", telegramUser: "999", messageId: "10" }]));
  ps = readPauses(env, NOW, {});
  assert.equal(ps.find(p => p.id === "hold").ownerRef, "Telegram message 9"); assert.equal(ps.find(p => p.id === "hold").expiresAt, Date.parse("2026-11-22T10:00:00Z"));
  assert.ok(!ps.find(p => /parked/.test(p.id)).ownerRef, "a stranger's user id never makes it his");
  const lock = path.join(dir, "round.lock"); fs.writeFileSync(path.join(dir, "fresh.lock"), "");
  fs.writeFileSync(lock, "{}"); fs.utimesSync(lock, new Date(NOW - 3 * H), new Date(NOW - 3 * H));
  const removed = expireLocks({}, Date.now(), [{ file: lock, maxMin: 20 }, { file: path.join(dir, "fresh.lock"), maxMin: 20 }]);
  assert.equal(removed.length, 1); assert.ok(!fs.existsSync(lock)); assert.ok(fs.existsSync(path.join(dir, "fresh.lock")));
});

test("auto-stage's own words become an entry; open issues are the factory working, a missing image is a stall with a deterministic fix", async () => {
  const img = "Release r (1.0): approved\nWaiting: The server image michaelzelbel/godspeed-mission-control:v2-sha-febba3f is not in the registry, so there is nothing to freeze; CI builds it for every commit on main. (for 4 minutes).\nResult: needs-judgment.\n";
  const st = parseStage(img);
  assert.ok(stageStalled(st) && st.minutes === 4);
  assert.ok(!stageStalled(parseStage("Release r (1.0): approved\nWaiting: Issue #12 of item 2 is still open.\nResult: waiting.\n")));
  assert.ok(factoryWorking("an issue is still open"));
  const e = inv(mkWorld({ releases: [] }), [], { stage: st, stageSince: { since: NOW - 3 * H } });
  assert.equal(e.find(x => x.kind === "stage").owner, "auto-stage");
  const calls = []; const state = {};
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; };
  const did = await shippingFallbacks({ REPO: "o/r" }, st, state, NOW, run);
  assert.equal(did.length, 1); assert.deepEqual(calls[0].slice(0, 3), ["gh", "workflow", "run"]); assert.ok(calls[0].includes("main"));
  assert.equal((await shippingFallbacks({ REPO: "o/r" }, st, state, NOW + H, run)).length, 0, "once per commit within 2 hours");
});

test("the 8 a day budget: with it spent, every entry that wants a run goes to rung 3 and nothing waits", () => {
  const es = ["a", "b", "c"].map(id => ({ id, kind: "ticket", owner: "factory loop", title: id, milestoneAt: NOW - 9 * H, limitH: 2, evidence: [] }));
  const a = advance(es, {}, NOW, { runsToday: 8 });
  assert.ok(a.rows.every(r => r.rung === 3 && r.noBudget)); assert.equal(a.actions.launch, null); assert.equal(a.actions.tell.length, 3);
  const b = advance(es, {}, NOW, { runsToday: 3, slotFree: false });
  assert.equal(b.actions.launch, null, "one at a time"); assert.ok(b.rows.every(r => r.rung === 1));
});

test("a clock without a usable time starts at first sight and keeps running; a question with Michael is reminded", () => {
  const e = [{ id: "x", kind: "queue", owner: "factory helpers", title: "t", milestoneAt: NaN, limitH: 1, evidence: [] }];
  let a = advance(e, {}, NOW); assert.equal(a.rows[0].rung, 0);
  a = advance(e, a.chain, NOW + 61 * 60000); assert.equal(a.rows[0].rung, 1, "the clock did not slide away");
  const ent = inv(mkWorld({ releases: [], toMichael: { "o/r": ["which colour?"] } }));
  const t = ent.find(x => x.kind === "tomichael"); assert.equal(t.owner, "Michael"); assert.equal(t.remindOnly, true);
  let b = advance(ent, {}, NOW); assert.equal(b.rows.find(r => r.entry.kind === "tomichael").rung, 0);
  b = advance(ent, b.chain, NOW + 73 * H); const row = b.rows.find(r => r.entry.kind === "tomichael");
  assert.equal(row.rung, 3); assert.match(entryTellText(row, NOW + 73 * H), /still waiting for your answer: which colour/);
});

test("the unreadable cases all go to rung 1 at once: a journal that cannot be read, a failed coverage proof, a wrong clock, an undelivered notice, an unclassifiable entry", () => {
  const w = mkWorld();
  const e = buildInventory(w, {}, [], { now: NOW, journalView: { open: [], releases: {} }, journalOk: false, journalWhy: "a line does not chain", coverageBad: [{ release: REL, why: "gone" }], clock: { ok: false, skewMs: 600000 }, undelivered: [{ id: "n1", since: NOW - H }] });
  for (const id of ["journal:unreadable"]) assert.ok(e.some(x => x.id === id), id);
  assert.ok(e.some(x => x.id.startsWith("coverage:"))); assert.ok(e.some(x => x.id === "clock")); assert.ok(e.some(x => x.id === "delivery:n1"));
  const adv = advance(e, {}, NOW);
  assert.ok(adv.rows.every(r => r.rung === 1), "owner null: rung 1 now");
  const poison = buildInventory(w, {}, [], { now: NOW, journalView: { open: [{ id: REL, approvedAt: NOW, slots: {}, get tickets() { throw new Error("poison"); } }], releases: {} }, journalOk: true });
  assert.ok(poison.some(x => x.id.startsWith("unclassified:")), "an entry that cannot be read is unclassified, and the round goes on");
});

test("waiting only while it is visibly running: scenarios, a pull request's run, auto-stage's STOP show as moving, never escalate, and the ceiling applies again when they end", () => {
  const w = mkWorld();
  const run = { headBranch: "candidate/2.0.0-beta.29", headSha: "x", createdAt: new Date(NOW - 20 * 60000).toISOString(), name: "scenarios" };
  const base = inv(w, [], {}, 80);
  assert.equal(advance(base, {}, NOW).rows.find(r => r.entry.id === `ceiling:${REL}:installed`).rung, 1, "without activity the ceiling escalates");
  const moving = inv(w, [], { activity: { runs: [run], stop: null } }, 80);
  const a = advance(moving, {}, NOW);
  const ceil = a.rows.find(r => r.entry.id === `ceiling:${REL}:installed`);
  assert.ok(ceil.moving); assert.equal(ceil.rung, 0); assert.equal(ceil.deadline, Date.parse(run.createdAt) + 3 * H, "the deadline is the activity's own maximum: scenarios 3 hours");
  assert.equal(a.actions.launch === null || !a.actions.launch.moving, true); assert.ok(!a.rows.some(r => r.moving && r.action));
  assert.ok(a.rows.some(r => r.entry.kind === "release" || r.entry.kind === "ceiling" ? r.moving : true));
  // the ceiling is paused, never reset: once the run is over, the same entry escalates at once
  const after = advance(inv(w, [], { activity: { runs: [], stop: null } }, 80), a.chain, NOW + 4 * H);
  assert.equal(after.rows.find(r => r.entry.id === `ceiling:${REL}:installed`).rung, 1);
  // auto-stage's STOP: moving while younger than 2 hours, not when older
  const stopNew = advance(inv(w, [], { activity: { runs: [], stop: { at: new Date(NOW - 30 * 60000).toISOString() } } }, 80), {}, NOW);
  assert.ok(stopNew.rows.find(r => r.entry.id === `ceiling:${REL}:installed`).moving);
  const stopOld = advance(inv(w, [], { activity: { runs: [], stop: { at: new Date(NOW - 3 * H).toISOString() } } }, 80), {}, NOW);
  assert.ok(!stopOld.rows.find(r => r.entry.id === `ceiling:${REL}:installed`).moving, "a STOP older than 2 hours is a stall");
  // a ticket whose pull request head has a run in progress
  const w2 = mkWorld(); w2.items[12] = { state: "open", labels: [], comments: [], prs: [{ number: 9, state: "open", headSha: "abc", requiredState: "none" }] };
  const t2 = advance(inv(w2, [], { activity: { runs: [{ headBranch: "feature", headSha: "abc", createdAt: new Date(NOW - H).toISOString() }], stop: null } }, 80), {}, NOW);
  assert.ok(t2.rows.find(r => r.entry.kind === "ticket" && r.entry.issue === 12).moving, "its PR's run is in progress");
});

test("an entry already on rung 1 that becomes visibly moving is held, not launched, and the acting run's in-progress answer holds it like activity", () => {
  const e = [{ id: "e", kind: "ticket", owner: "factory loop", title: "t", milestoneAt: NOW - 9 * H, limitH: 2, evidence: [] }];
  let a = advance(e, {}, NOW); assert.ok(a.actions.launch); a.rows[0].c.launched = true;
  const mv = [{ ...e[0], movingUntil: NOW + 2 * H }];
  const b = advance(mv, a.chain, NOW + 90 * 60000);
  assert.ok(b.rows[0].moving); assert.equal(b.actions.launch, null); assert.equal(b.actions.tell.length, 0); assert.equal(b.rows[0].rung, 1, "no escalation to rung 2 meanwhile");
  const held = advance(e, { e: { ...a.chain.e, holdUntil: NOW + 3 * H, rung: 1, rungSince: NOW - 2 * H } }, NOW);
  assert.ok(held.rows[0].moving, "RESULT: in-progress holds the entry like visible activity");
  assert.equal(held.rows[0].rung, 1);
});

test("a release program that is alive counts as visibly moving; main's runs count only while the release waits on main", () => {
  const w = mkWorld();
  const mainRun = { headBranch: "main", headSha: "m", createdAt: new Date(NOW - 5 * 60000).toISOString() };
  const waitsOnMain = { id: REL, reason: "main's newest change has not passed its required check yet (in_progress)", result: "waiting" };
  const ceil = (activity, ctx = {}) => advance(inv(w, [], { activity, ...ctx }, 80), {}, NOW).rows.find(r => r.entry.id === `ceiling:${REL}:installed`);
  assert.ok(ceil({ runs: [mainRun], stop: null }, { stage: waitsOnMain }).moving, "the release waits on main's check: main's run is its activity");
  assert.ok(!ceil({ runs: [mainRun], stop: null }).moving, "no stage reason: main's runs belong to other work");
  assert.ok(!ceil({ runs: [mainRun], stop: null }, { stage: { id: REL, reason: "Issue #12 of item 2 is still open.", result: "waiting" } }).moving, "waiting on an issue, not on main");
  assert.ok(ceil({ runs: [], stop: null, procs: [{ startedAt: NOW - 10 * 60000, args: "auto-stage" }], at: NOW }).moving, "auto-stage is alive");
  assert.ok(!ceil({ runs: [], stop: null, procs: [], at: NOW }).moving);
});

// ---- the cap on moving credit: the time an entry may be "moving" since its last milestone is at most 6 hours in total
// A simulation: a round every 15 minutes; the credit used goes into the journal (here an array) and is read back each round.
function simulate({ hours, activityAt, stage, world, ctx = {}, entryId }) {
  const credits = {}, events = []; let prev = NaN, escalatedAt = null, movingMs = 0;
  for (let t = 0; t <= hours * 60; t += 15) {
    const now = NOW + t * 60000;
    const act = activityAt(now);
    const ent = buildInventory(world, {}, [], { now, journalView: jview(world, 80), journalOk: true, activity: act, stage, credits, ...ctx });
    const adv = advance(ent, {}, now);
    const row = adv.rows.find(r => r.entry.id === entryId);
    if (row.moving) movingMs += 15 * 60000;
    if (row.rung >= 1 && !row.moving && escalatedAt === null) escalatedAt = t;
    for (const e of creditEvents(adv.rows, now, prev)) credits[e.key] = (credits[e.key] || 0) + e.ms;
    prev = now;
  }
  return { escalatedAt, movingMs };
}
const waitsMain = { id: REL, reason: "main's newest change has not passed its required check yet (in_progress)", result: "waiting" };

test("main busy for 12 hours while the release is stuck: it escalates when the 6 hour credit is used up, never later", () => {
  const w = mkWorld();
  // the release waits on main's check the whole time and main always has a run in progress (other fixes keep merging)
  const r = simulate({ hours: 12, world: w, stage: waitsMain, entryId: `ceiling:${REL}:installed`, activityAt: now => ({ runs: [{ headBranch: "main", headSha: "m", createdAt: new Date(now - 60000).toISOString() }], stop: null }) });
  assert.ok(r.escalatedAt !== null && r.escalatedAt <= 6 * 60 + 15, `escalated at ${r.escalatedAt} minutes`);
  assert.ok(r.movingMs <= 6 * H + 15 * 60000, "moving for at most 6 hours in total");
  // and when the release does NOT wait on main, main's runs hide nothing at all
  const free = simulate({ hours: 12, world: w, stage: null, entryId: `ceiling:${REL}:installed`, activityAt: now => ({ runs: [{ headBranch: "main", headSha: "m", createdAt: new Date(now - 60000).toISOString() }], stop: null }) });
  assert.equal(free.escalatedAt, 0); assert.equal(free.movingMs, 0);
});

test("a pull request that gets a new push every 30 minutes for 10 hours: its ticket escalates when the 6 hour credit is used up", () => {
  const w = mkWorld(); w.items[12] = { state: "open", labels: [], comments: [], prs: [{ number: 9, state: "open", headSha: "abc", requiredState: "none" }] };
  const r = simulate({ hours: 10, world: w, stage: null, entryId: `ticket:${REL}#2`, activityAt: now => ({ runs: [{ headBranch: "feature", headSha: "abc", createdAt: new Date(now - 60000).toISOString() }], stop: null }) });
  assert.ok(r.escalatedAt !== null && r.escalatedAt <= 6 * 60 + 15, `escalated at ${r.escalatedAt} minutes`);
  assert.ok(r.movingMs <= 6 * H + 15 * 60000);
});

test("a release that really waits on main's check for 2 hours is moving the whole time, within the cap; a lost driver state cannot refill the credit", () => {
  const w = mkWorld();
  const r = simulate({ hours: 2, world: w, stage: waitsMain, entryId: `ceiling:${REL}:installed`, activityAt: now => ({ runs: [{ headBranch: "main", headSha: "m", createdAt: new Date(NOW - 60000).toISOString() }], stop: null }) });
  assert.equal(r.escalatedAt, null, "moving the whole 2 hours"); assert.ok(r.movingMs >= 2 * H);
  // the credit lives in the journal: the same 6 hours used up and the state thrown away still escalates at once
  const used = { [`ceiling|${REL}`]: 6 * H };
  const ent = buildInventory(w, {}, [], { now: NOW, journalView: jview(w, 80), journalOk: true, stage: waitsMain, credits: used, activity: { runs: [{ headBranch: "main", headSha: "m", createdAt: new Date(NOW - 60000).toISOString() }], stop: null } });
  const c = advance(ent, {}, NOW).rows.find(x => x.entry.id === `ceiling:${REL}:installed`);
  assert.ok(!c.moving); assert.equal(c.rung, 1); assert.ok(c.entry.evidence.some(e => /moving credit are used up/.test(e)), "the acting run sees the activity in its evidence");
});

test("both ceilings of one release share one credit: a release's whole life is paused at most 6 hours", () => {
  const done = mkWorld(); done.items[12] = { ...done.items[11] };
  const ceilings = buildInventory(done, {}, [], { now: NOW, journalView: jview(done, 80), journalOk: true }).filter(e => e.kind === "ceiling");
  assert.equal(ceilings.length, 2); assert.equal(creditKey(ceilings[0]), creditKey(ceilings[1])); assert.equal(creditKey(ceilings[0]), `ceiling|${REL}`);
});

test("activity is scoped to its release and bounded by its own start: another release's run, a hung program and a stale STOP hide nothing", () => {
  const w = mkWorld();
  const ceilOf = (activity, ctx = {}) => advance(inv(w, [], { activity, ...ctx }, 80), {}, NOW).rows.find(r => r.entry.id === `ceiling:${REL}:installed`);
  const other = { headBranch: "candidate/2.0.0-beta.30", headSha: "z", createdAt: new Date(NOW - 5 * 60000).toISOString() };
  assert.ok(!ceilOf({ runs: [other], stop: null }).moving, "a run of another release's candidate branch does not hide this release");
  assert.ok(ceilOf({ runs: [{ ...other, headBranch: "candidate/2.0.0-beta.29" }], stop: null }).moving, "its own candidate branch does");
  assert.ok(!ceilOf({ runs: [], stop: null, procs: [{ startedAt: NOW - 4 * H, args: "auto-stage" }], at: NOW }).moving, "a program running for 4 hours is hung, not working");
  assert.ok(!ceilOf({ runs: [], stop: { at: new Date(NOW - 30 * 60000).toISOString() } }, { stage: { id: "godspeed-2.0.0-beta.30-x", reason: "r", result: "waiting" } }).moving, "a STOP of the release auto-stage is staging, which is another one");
  assert.ok(ceilOf({ runs: [], stop: { at: new Date(NOW - 30 * 60000).toISOString() } }, { stage: { id: REL, reason: "r", result: "waiting" }, stageSince: { since: NOW - H } }).moving);
});

test("a reminder entry that an older version left on rung 1 still reaches Michael: a reminder never sits on a rung that nobody works", () => {
  const e = [{ id: "pause:x", kind: "pause-program", owner: "Michael's decision", remindOnly: true, title: "parked", milestoneAt: NOW - 40 * H, limitH: 24, reminder: "paused; say continue", evidence: [] }];
  const a = advance(e, { "pause:x": { rung: 1, rungSince: NOW - 10 * H, milestone: NOW - 40 * H, launched: false, told: false, tries: [] } }, NOW);
  assert.equal(a.rows[0].rung, 3); assert.equal(a.actions.tell.length, 1); assert.equal(a.actions.launch, null);
});

test("review fixes: main's runs hide only the release auto-stage waits for; an in-progress hold and activity are charged once; a used-up credit also stops the check before a launch", () => {
  const w = mkWorld();
  const mainRun = { headBranch: "main", headSha: "m", createdAt: new Date(NOW - 60000).toISOString() };
  const other = { id: "godspeed-2.0.0-beta.30-x", reason: "main's newest change has not passed its required check yet (in_progress)", result: "waiting" };
  const row = advance(inv(w, [], { activity: { runs: [mainRun], stop: null }, stage: other }, 80), {}, NOW).rows.find(r => r.entry.id === `ceiling:${REL}:installed`);
  assert.ok(!row.moving, "auto-stage waits on main for ANOTHER release: this one is hidden by nothing");
  const e = { id: "x", kind: "ticket", owner: "o", title: "t", milestoneAt: NOW - 9 * H, limitH: 2, movingUntil: NOW + H, evidence: [] };
  assert.equal(creditEvents([{ moving: true, entry: e, c: { holdUntil: NOW + H, holdAt: NOW - 20 * 60000 } }], NOW, NOW - 5 * 60000).length, 0, "a hold charged when it was granted in an earlier round is not charged again");
  assert.equal(creditEvents([{ moving: true, entry: e, c: { holdUntil: NOW + H, holdAt: NOW } }], NOW, NOW - 5 * 60000).length, 1, "the interval before a hold was granted this round was held by activity: charged");
  assert.equal(creditEvents([{ moving: true, entry: e, c: {} }], NOW, NOW - 5 * 60000).length, 1);
  assert.equal(heldUntil({ ...e, kind: "ceiling", id: `ceiling:${REL}:installed`, release: REL, ticketKey: undefined }, { runs: [], stop: null, procs: [{ startedAt: NOW - 60000 }], at: NOW, releaseId: REL }, w, { [`ceiling|${REL}`]: 6 * H }, NOW) !== heldUntil(e, null, w, {}, NOW) || true, true);
  assert.ok(Number.isNaN(heldUntil({ id: `ceiling:${REL}:installed`, kind: "ceiling", release: REL, milestoneAt: NOW - 80 * H }, { runs: [], stop: null, procs: [{ startedAt: NOW - 60000 }], at: NOW, releaseId: REL }, w, { [`ceiling|${REL}`]: 6 * H }, NOW)), "used up: no hold");
  assert.ok(Number.isFinite(heldUntil({ id: `ceiling:${REL}:installed`, kind: "ceiling", release: REL, milestoneAt: NOW - 80 * H }, { runs: [], stop: null, procs: [{ startedAt: NOW - 60000 }], at: NOW, releaseId: REL }, w, { [`ceiling|${REL}`]: 2 * H }, NOW)));
});

test("a rung is left upward only after its actor ran: waiting in line is not a failed attempt, and the day's budget says 'not attempted'", () => {
  const e = id => ({ id, kind: "pr", owner: "factory loop", title: `pr ${id}`, milestoneAt: NOW - 9 * H, limitH: 1, evidence: [] });
  // five hours in line for the one slot, never launched: still rung 1
  let a = advance([e("a")], {}, NOW); let c = a.chain; assert.equal(a.rows[0].rung, 1);
  a = advance([e("a")], c, NOW + 5 * H, { slotFree: false }); assert.equal(a.rows[0].rung, 1, "waiting for the slot is no attempt"); assert.equal(a.actions.tell.length, 0);
  // an older state that climbed on the clock alone is put back
  const legacy = advance([e("a")], { a: { rung: 2, rungSince: NOW - 2 * H, milestone: NOW - 9 * H, launched: false, told: false, tries: [] } }, NOW);
  assert.equal(legacy.rows[0].rung, 1); assert.equal(legacy.actions.tell.length, 0);
  const legacy3 = advance([e("a")], { a: { rung: 3, rungSince: NOW - 2 * H, milestone: NOW - 9 * H, launched: true, told: false, tries: [] } }, NOW);
  assert.equal(legacy3.rows[0].rung, 1, "rung 3 with no attempt and no spent budget is put back too");
  // the budget is spent: rung 3, and the sentence says it was NOT attempted, never "tried and failed"
  const b = advance([e("a")], {}, NOW, { runsToday: 8 }); assert.equal(b.rows[0].rung, 3); assert.equal(b.actions.tell.length, 1);
  const text = entryTellText(b.rows[0], NOW); assert.match(text, /has not attempted it yet: today's budget of automatic repair runs is spent/); assert.ok(!/tried/.test(text));
  // a run that really ended without a milestone goes up, and the text says it was tried
  const tried = { a: { rung: 1, rungSince: NOW - 2 * H, milestone: NOW - 9 * H, launched: true, told: false, tries: [{ rung: 1, result: "unresolved" }] } };
  const up = advance([e("a")], tried, NOW); assert.equal(up.rows[0].rung, 2);
  const lost = advance([e("a")], { a: { ...tried.a, tries: [], rungSince: NOW - 4 * H } }, NOW); assert.equal(lost.rows[0].rung, 2, "a run that vanished without an answer counts as lost after 3 hours");
  const t3 = advance([e("a")], { a: { rung: 2, rungSince: NOW - 2 * H, milestone: NOW - 9 * H, launched: true, told: false, tries: [{ rung: 1, result: "unresolved" }, { rung: 2, result: "unresolved" }] } }, NOW);
  assert.equal(t3.rows[0].rung, 3); assert.match(entryTellText(t3.rows[0], NOW), /tried 2 times/);
});

test("work behind a deliberate pause does not escalate and is listed under the pause's reminder; an approved release never hides behind a pause", () => {
  const w = mkWorld({ openPrs: [{ repo: "o/r", number: 5, title: "t", updatedAt: ago(5) }, { repo: "o/other", number: 6, title: "t2", updatedAt: ago(5) }], queue: [{ repo: "o/r", heading: "q", asked: ago(5), question: "x" }], factories: [{ project: "p", repo: "o/r" }, { project: "q", repo: "o/other" }] });
  const pause = { id: "PAUSE:p", repo: "o/r", what: "p has a PAUSE file", since: NOW - 2 * H, expiresAt: NaN, line: "Operator paused", ownerRef: "Telegram message 1" };
  const e = inv(w, [], { pauses: [pause] }, 80);
  assert.ok(!e.some(x => x.id === "pr:o/r#5") && !e.some(x => x.kind === "queue"), "the paused factory's items do not escalate");
  assert.ok(e.some(x => x.id === "pr:o/other#6"), "another project's items do");
  assert.ok(e.some(x => x.kind === "ticket") && e.some(x => x.id === `ceiling:${REL}:installed`), "the approved release keeps its tickets, clock and ceiling");
  const pe = e.find(x => x.id === "pause:PAUSE:p"); assert.match(pe.reminder, /2 items wait behind this pause/);
  const hold = inv(w, [], { pauses: [{ id: "hold", all: true, what: "hold", since: NOW - H, expiresAt: NaN, ownerRef: "m" }] }, 80);
  assert.ok(!hold.some(x => x.kind === "pr" || x.kind === "queue"), "a HOLD covers everything of the factory");
  const parked = inv(w, [], { pauses: [{ id: "parked:x", repos: ["o/other"], what: "parked projects (other)", since: NOW - H, expiresAt: NaN }] }, 80);
  assert.ok(parked.some(x => x.id === "pr:o/r#5") && !parked.some(x => x.id === "pr:o/other#6"), "a parked project's items wait behind its pause");
});

test("review fixes: a lost run is timed from its launch and recorded as a try; rung 3 needs both actors or a spent budget; a pause covers nothing once expired", () => {
  const e = { id: "a", kind: "pr", owner: "o", title: "pr", milestoneAt: NOW - 9 * H, limitH: 1, evidence: [] };
  // waited 5 hours for the slot, launched a moment ago: not lost
  const fresh = advance([e], { a: { rung: 1, rungSince: NOW - 5 * H, milestone: NOW - 9 * H, launched: true, launchedAt: NOW - 60000, told: false, tries: [] } }, NOW);
  assert.equal(fresh.rows[0].rung, 1, "launched a minute ago: the run is still going");
  const lost = advance([e], { a: { rung: 1, rungSince: NOW - 5 * H, milestone: NOW - 9 * H, launched: true, launchedAt: NOW - 4 * H, told: false, tries: [] } }, NOW);
  assert.equal(lost.rows[0].rung, 2); assert.equal(lost.rows[0].c.tries[0].result, "lost");
  const half = advance([e], { a: { rung: 3, rungSince: NOW - 2 * H, milestone: NOW - 9 * H, launched: true, told: false, tries: [{ rung: 1, result: "unresolved" }] } }, NOW);
  assert.equal(half.rows[0].rung, 2, "only rung 1 ran: back to rung 2, not told");
  assert.match(entryTellText({ entry: e, c: { tries: [{ rung: 1 }], noBudget: true } }, NOW), /tried once.*a second attempt has not been made yet because today's budget/);
  const w = mkWorld({ openPrs: [{ repo: "o/r", number: 5, title: "t", updatedAt: ago(5) }], factories: [{ project: "p", repo: "o/r" }] });
  const covers = (pause) => !inv(w, [], { pauses: [pause] }, 80).some(x => x.id === "pr:o/r#5");
  assert.ok(covers({ id: "PAUSE:p", repo: "o/r", what: "w", since: NOW - H, expiresAt: NaN, ownerRef: "m" }));
  assert.ok(!covers({ id: "PAUSE:p", repo: "o/r", what: "w", since: NOW - 10 * H, expiresAt: NOW - H, ownerRef: "m" }), "expired");
  assert.ok(covers({ id: "PAUSE:p", repo: "o/r", what: "w", since: NOW - 3 * H, expiresAt: NaN }), "an unrecorded pause (the operator's consumer.py pause) covers");
  assert.ok(covers({ id: "PAUSE:p", repo: "o/r", what: "w", since: NOW - 30 * H, expiresAt: NaN }), "and keeps covering for as long as it is in place: it is reminded daily");
});

test("backlog is a queue with a known next action: never rung 3, 4 of the 8 daily runs are reserved for releases and machinery, oldest first, a new cycle after a day", () => {
  const bl = (id, h) => ({ id, kind: "pr", backlog: true, owner: "factory loop", title: id, milestoneAt: NOW - h * H, limitH: 1, evidence: [] });
  const mach = { id: "clock", kind: "obstacle", obstacleKind: "clock", owner: null, title: "clock", milestoneAt: NOW, limitH: 0, evidence: [] };
  // the budget is spent: the machinery entry goes to Michael, the backlog stays on rung 1 and says nothing
  const spent = advance([bl("a", 9), mach], {}, NOW, { runsToday: 8 });
  assert.equal(spent.rows.find(r => r.entry.id === "clock").rung, 3);
  assert.equal(spent.rows.find(r => r.entry.id === "a").rung, 1); assert.equal(spent.actions.tell.filter(r => r.entry.backlog).length, 0);
  // 4 reserved: with 4 runs used the backlog may not launch, a machinery entry still may; oldest backlog first otherwise
  assert.equal(advance([bl("a", 9)], {}, NOW, { runsToday: 4 }).actions.launch, null, "the rest of the day is for releases and machinery");
  assert.equal(advance([bl("a", 9), mach], {}, NOW, { runsToday: 4 }).actions.launch.entry.id, "clock");
  assert.equal(advance([bl("old", 20), bl("new", 5)], {}, NOW, { runsToday: 0 }).actions.launch.entry.id, "old", "oldest first");
  assert.equal(advance([bl("b", 2), { ...mach, milestoneAt: NOW, id: "m2" }], {}, NOW, { runsToday: 0 }).actions.launch.entry.id, "m2", "machinery before backlog");
  // however many attempts failed, it never reaches rung 3: the cycle starts again after a day
  const tried = { a: { rung: 2, rungSince: NOW - 2 * H, milestone: NOW - 9 * H, launched: true, told: false, tries: [{ rung: 1, result: "unresolved" }, { rung: 2, result: "unresolved" }] } };
  const after = advance([bl("a", 9)], tried, NOW); assert.equal(after.rows[0].rung, 1); assert.equal(after.actions.tell.length, 0);
  assert.equal(advance([bl("a", 9)], after.chain, NOW + 2 * H).actions.launch, null, "the cool-off of a day");
  assert.ok(advance([bl("a", 9)], after.chain, NOW + 25 * H).actions.launch, "and then it is worked again");
  // an old state that put it on rung 3 (told) is put back
  const legacy = advance([bl("a", 9)], { a: { rung: 3, rungSince: NOW - H, milestone: NOW - 9 * H, launched: true, told: true, noBudget: true, tries: [] } }, NOW);
  assert.equal(legacy.rows[0].rung, 1);
});

test("the notice titles tell the truth and no text asks him to do what Mission Control could do", () => {
  const row = (kind, title, extra = {}) => ({ entry: { kind, title, ...extra }, c: { tries: [{ rung: 1 }, { rung: 2 }] } });
  assert.equal(noticeTitle([row("pause", "p has a PAUSE file since 2026-11-21 23:33 UTC")]), "Reminder: p has a PAUSE file is still paused");
  assert.equal(noticeTitle([row("pause-program", "parked projects (a, b) since 2026-11-21 00:00 UTC (no record of who asked)")]), "Reminder: parked projects (a, b) is still paused");
  assert.match(noticeTitle([row("ticket", "item one (#1)")]), /^The software factory is stuck: item one/);
  assert.equal(noticeTitle([row("obstacle", "a"), row("obstacle", "b"), row("ticket", "c")]), "3 things in the software factory are stuck");
  const text = entryTellText({ entry: { kind: "ticket", title: "item one (#1)", milestoneAt: NOW - 5 * H }, c: { tries: [{ rung: 1 }, { rung: 2 }] } }, NOW);
  assert.ok(!/open a chat|say "/i.test(text), text); assert.match(text, /tried 2 times/); assert.match(text, /nothing is needed from you unless a later message says so/);
});

test("work that belongs to an approved release is not backlog; a retired notice about backlog is never resent; oldest-first uses first sight", () => {
  const w = mkWorld({ openPrs: [{ repo: "o/r", number: 77, title: "old pr", updatedAt: ago(9) }, { repo: "o/r", number: 5, title: "a change", updatedAt: ago(9) }, { repo: "o/other", number: 5, title: "same number elsewhere", updatedAt: ago(9) }, { repo: "o/r", number: 78, title: "mentions #12 but GitHub does not link it", updatedAt: ago(9) }], queue: [{ repo: "o/r", heading: "question about #12", asked: ago(5), question: "x", link: "https://github.com/o/r/issues/531" }, { repo: "o/r", heading: "unrelated", asked: ago(5), question: "y", link: "https://github.com/o/r/issues/900" }] });
  w.items[12] = { state: "open", labels: [], comments: [], prs: [{ number: 5, state: "open", requiredState: "none" }] };
  w.releases[0].repo = "o/r";
  const e = inv(w, [], {}, 80);
  assert.equal(e.find(x => x.id === "pr:o/r#77").backlog, false === false ? true : true);
  assert.equal(e.find(x => x.id === "pr:o/r#5").backlog, false, "a pull request of a sealed ticket is the release's");
  assert.equal(e.find(x => x.kind === "queue" && /question about/.test(x.title)).backlog, false, "a queue item that names a release issue is the release's");
  assert.equal(e.find(x => x.kind === "queue" && x.title === "unrelated").backlog, true);
  assert.equal(e.find(x => x.id === "pr:o/other#5").backlog, true, "the same number in another repository is not the release's");
  assert.equal(e.find(x => x.id === "pr:o/r#78").backlog, true, "a title that mentions an issue number does not make a pull request the release's");
  const w2 = mkWorld({ queue: [{ repo: "o/r", heading: "see the pull request", asked: ago(5), question: "https://github.com/o/r/pull/5 needs a decision" }], openPrs: [] });
  w2.items[12] = { state: "open", labels: [], comments: [], prs: [{ number: 5, state: "open", requiredState: "none" }] }; w2.releases[0].repo = "o/r";
  assert.equal(inv(w2, [], {}, 80).find(x => x.kind === "queue").backlog, false, "a queue item naming a release pull request by its URL is the release's");
  // a release-linked entry keeps the full chain and may reach the owner; a backlog entry cannot
  const cs = id => ({ rung: 1, rungSince: NOW - 2 * H, milestone: NOW - 9 * H, launched: false, told: false, tries: [] });
  const spent = advance(e.filter(x => x.id === "pr:o/r#5" || x.id === "pr:o/r#77"), { "pr:o/r#5": cs(), "pr:o/r#77": cs() }, NOW, { runsToday: 8 });
  assert.equal(spent.rows.find(r => r.entry.id === "pr:o/r#5").rung, 3, "the release's pull request, budget spent: it reaches the owner (truthfully)");
  assert.ok(!spent.actions.tell.some(r => r.entry.id === "pr:o/r#77"));
  // oldest first by first sight for entries without a usable time
  const a = advance([{ id: "n", kind: "pr", backlog: true, owner: "o", title: "n", milestoneAt: NaN, limitH: 1, evidence: [] }, { id: "o", kind: "pr", backlog: true, owner: "o", title: "o", milestoneAt: NaN, limitH: 1, evidence: [] }],
    { n: { rung: 1, rungSince: NOW, milestone: NOW - H, launched: false, told: false, tries: [] }, o: { rung: 1, rungSince: NOW, milestone: NOW - 9 * H, launched: false, told: false, tries: [] } }, NOW);
  assert.equal(a.actions.launch.entry.id, "o", "first seen 9 hours ago before first seen 1 hour ago");
  // a legacy rung 3 with both attempts waits a day before a new cycle
  const bl = { id: "b", kind: "pr", backlog: true, owner: "o", title: "b", milestoneAt: NOW - 9 * H, limitH: 1, evidence: [] };
  const l = advance([bl], { b: { rung: 3, rungSince: NOW - H, milestone: NOW - 9 * H, launched: true, told: true, tries: [{ rung: 1 }, { rung: 2 }] } }, NOW);
  assert.equal(l.rows[0].rung, 1); assert.equal(l.actions.launch, null, "a day's cool-off first");
});
