// node test-release-driver-cut.mjs   (no network, no AI, no git)
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { planCutRule, planItemNames, findDeadEnds, routedToDeadEnd, factoryDown, proofOnly, machineHold, amendment, cutLook, cutSentence, cutComment, versionWords, CUT_MARKER, PROVIDER_FAILURE } from "../release-driver/release-driver-cut.mjs";
import { run } from "../release-driver/release-driver.mjs";

const HOUR = 3600 * 1000;
const NOW = Date.parse("2026-11-17T10:00:00Z");
const ago = h => new Date(NOW - h * HOUR).toISOString();
const R = "MichaelZelbel/godspeed-mission-control";
const ID = "godspeed-2.0.0-beta.26-steady";
const BOT = { login: "godspeed-dev-builder", __typename: "Bot" }, MICHAEL = { login: "MichaelZelbel", __typename: "User" };

// ---- the plan (beta.26's own words, line breaks as they stand)
const PLAN = `---\nrelease: ${ID}\nrepository: ${R}\n---\n\n# Godspeed 2.0.0-beta.26: steady\n\nStatus: approved by Michael on 2026-11-16 (""go" for beta 25, and "yes" for beta 26, with keep for\nthe Hostinger button."). Proposed the same day.\n\n## What it delivers\n\n1. **Right after a restart the server answers at once** instead. (#679) Full.\n2. **A chat says plainly when the AI key was refused**, instead. (#590) Full.\n3. **A chat never briefly shows the AI as ready right after its connection failed.** (#667) Light.\n4. **A Timeline moment can be linked to a person who already exists.** (#669) Light.\n\nIssues: item 1 #679, 2 #590, 3 #667, 4 #669\n\n## How it is built\n\nan \`Owner decision\` comment (the loop reads the item) and the label \`beta.26\`, and \`needs-owner\`\ncomes off it and its pull request. Everything else stays \`needs-owner\`. Caps: three attempts or\ntwo send-backs per item, then \`needs-owner\`; an item that reaches a dead end leaves the release,\nthe rest ships.\n\n## Proving\n`;
const rule = planCutRule(PLAN);
assert.ok(rule, "the approved plan holds the rule");
assert.equal(rule.words, "Caps: three attempts or\ntwo send-backs per item, then `needs-owner`; an item that reaches a dead end leaves the release,\nthe rest ships.");
assert.ok(PLAN.includes(rule.words), "words: the plan's sentence byte for byte");
assert.equal(rule.statusLine, 'Status: approved by Michael on 2026-11-16 (""go" for beta 25, and "yes" for beta 26, with keep for the Hostinger button.").', "the whole Status sentence, over its line break");
assert.equal(rule.approvedAt, "2026-11-16T00:00:00Z");
assert.equal(planCutRule(PLAN.replace("Status: approved", "Status: proposed")), null, "a plan that is not approved");
assert.equal(planCutRule(PLAN.replace("leaves the release,\nthe rest ships", "waits")), null, "a plan without the rule");
assert.equal(planItemNames(PLAN)[3], "A chat never briefly shows the AI as ready right after its connection failed");
assert.equal(versionWords("2.0.0-beta.26"), "Beta 26");

// ---- dead ends
const D = (at, kind, item, extra = {}) => ({ at: typeof at === "number" ? ago(at) : at, kind, release: ID, item, ...extra });
const finished = h => ({ at: ago(h), kind: "run finished", release: ID, run: `r${h}` });
const item = (number, over = {}) => ({ number, title: `t${number}`, url: `https://github.com/${R}/issues/${number}`, state: "OPEN", labels: ["beta.26"], comments: [], prs: [], ...over });
const runAt = h => [finished(h)];
// (a) authorized twice, last 7 hours ago, nothing merged since
let decisions = [D(20, "decided", 590, { handled: true, run: "r20" }), D(7, "repaired", 590, { handled: true, run: "r7" })];
let world = { items: [item(590, { prs: [{ number: 660, url: "p660", state: "OPEN", merged: false, labels: [] }] })] };
let dead = findDeadEnds({ planId: ID, world, decisions, now: NOW, releaseLabel: "beta.26" });
assert.equal(dead.get(590).rule, "a", "(a): authorized twice, nothing merged in six hours");
assert.equal(dead.get(590).evidence.length, 2);
assert.ok(!findDeadEnds({ planId: ID, world, decisions: [decisions[0], D(5, "repaired", 590, { handled: true })], now: NOW }).has(590), "(a) not yet: the last authorization is five hours old");
assert.ok(!findDeadEnds({ planId: ID, world, decisions: [decisions[0], D(7, "repaired", 590, { handled: false })], now: NOW }).has(590), "(a): a decision the check refused is no authorization");
const mergedSince = { items: [item(590, { prs: [{ number: 661, url: "p661", state: "MERGED", merged: true, mergedAt: ago(2), labels: [] }] })] };
assert.ok(!findDeadEnds({ planId: ID, world: mergedSince, decisions, now: NOW }).has(590), "(a): something merged since the last authorization");
assert.ok(!findDeadEnds({ planId: "other", world, decisions, now: NOW }).has(590), "only this release's decisions count");
// (c) left in the last four runs, nothing new
decisions = [...[9, 7, 5, 3].flatMap(h => [D(h, "left", 670, { run: `r${h}`, routed: "none" }), finished(h)])];
world = { items: [item(670, { prs: [{ number: 618, url: "p618", state: "OPEN", merged: false, labels: [], lastCommitAt: ago(12), comments: [] }] })] };
dead = findDeadEnds({ planId: ID, world, decisions, now: NOW });
assert.equal(dead.get(670).rule, "c", "(c): four runs in a row left it, nothing new");
const busy = { items: [item(670, { prs: [{ number: 618, state: "OPEN", labels: [], lastCommitAt: ago(4), comments: [] }] })] };
assert.ok(!findDeadEnds({ planId: ID, world: busy, decisions, now: NOW }).has(670), "(c): a commit in between keeps it alive");
const reviewed = { items: [item(670, { comments: [{ createdAt: ago(6), body: "Loop review: sent back", author: BOT }] })] };
assert.ok(!findDeadEnds({ planId: ID, world: reviewed, decisions, now: NOW }).has(670), "(c): a loop review in between keeps it alive");
const strangerReview = { items: [item(670, { comments: [{ createdAt: ago(6), body: "Loop review: sent back", author: { login: "someone", __typename: "User" } }] })] };
assert.ok(findDeadEnds({ planId: ID, world: strangerReview, decisions, now: NOW }).has(670), "(c): a stranger's review text is not a verdict");
assert.ok(!findDeadEnds({ planId: ID, world, decisions: [...decisions.slice(0, 6), D(3, "nothing", 670, { run: "r3" }), finished(3)], now: NOW }).has(670), "(c): a run that did not leave it breaks the row");
// (b) routed to a prerequisite that is itself a dead end
decisions = [D(20, "decided", 616, { handled: true }), D(8, "decided", 616, { handled: true }), D(1, "left", 670, { routed: "prerequisite", owner_step: "prerequisite", run: "r1" }), finished(1)];
world = { items: [item(670), item(616, { labels: ["bug"], scope: "prerequisite", prereqOf: 670, prs: [{ number: 618, state: "OPEN", labels: [] }] })] };
dead = findDeadEnds({ planId: ID, world, decisions, prereqs: { 618: { of: 670 } }, now: NOW });
assert.equal(dead.get(616).rule, "a");
assert.equal(dead.get(670).rule, "b", "(b): waits on a pull request whose item is a dead end");
assert.match(dead.get(670).why, /#616/);
assert.ok(!findDeadEnds({ planId: ID, world, decisions: decisions.slice(1), prereqs: { 618: { of: 670 } }, now: NOW }).has(670), "(b): its target is still alive, and it has not waited twelve hours");
// (b) left towards the verifier repair for twelve hours with nothing new
decisions = [D(14, "left", 652, { routed: "referee-repair", owner_step: "referee-repair" }), D(13, "left", 652, { routed: "referee-repair", owner_step: "referee-repair" })];
dead = findDeadEnds({ planId: ID, world: { items: [item(652)] }, decisions, now: NOW });
assert.equal(dead.get(652).rule, "b", "(b): twelve hours left towards the repair");
assert.ok(!findDeadEnds({ planId: ID, world: { items: [item(652)] }, decisions: decisions.map(d => ({ ...d, at: ago(10) })), now: NOW }).has(652), "(b): ten hours is not yet twelve");
// a cycle never loops
decisions = [D(2, "left", 1, { routed: "prerequisite" }), D(2, "left", 2, { routed: "prerequisite" })];
assert.equal(findDeadEnds({ planId: ID, world: { items: [item(1), item(2)] }, decisions, prereqs: { 2: { of: 1 }, 1: { of: 2 } }, now: NOW }).size, 0, "a cycle of fresh lefts is no dead end yet");
// (o) Michael moved it, and the label is off
const moved = item(679, { labels: ["bug", "needs-owner"], comments: [{ createdAt: ago(17), url: "c679", author: MICHAEL, body: "Owner decision: **move this startup sign-in investigation to a later release and let the current release ship.**" }] });
dead = findDeadEnds({ planId: ID, world: { items: [moved] }, decisions: [], now: NOW, releaseLabel: "beta.26" });
assert.equal(dead.get(679).rule, "owner-moved");
assert.ok(dead.get(679).evidence[0].words.includes("later release"));
assert.ok(!findDeadEnds({ planId: ID, world: { items: [{ ...moved, labels: ["beta.26"] }] }, decisions: [], now: NOW, releaseLabel: "beta.26" }).has(679), "still labelled for the release: not moved");
assert.ok(!findDeadEnds({ planId: ID, world: { items: [{ ...moved, comments: [{ ...moved.comments[0], author: BOT }] }] }, decisions: [], now: NOW, releaseLabel: "beta.26" }).has(679), "only Michael's own words move it");
// code merged, proof could not run: still a dead end, with its merge named
world = { items: [item(667, { prs: [{ number: 671, url: "p671", state: "MERGED", merged: true, mergedAt: ago(30), labels: [] }] })] };
dead = findDeadEnds({ planId: ID, world, decisions: [D(20, "decided", 667, { handled: true }), D(8, "decided", 667, { handled: true })], now: NOW });
assert.deepEqual(dead.get(667).codeMerged, ["p671"]);
assert.match(cutComment({ plan: { id: ID, version: "2.0.0-beta.26" }, rule, cut: { dead: dead.get(667) } }), /proof moves to the next release.*Nothing here is marked as passed/);

// ---- a routed left towards a dead end is not progress
const dm = new Map([[616, { rule: "a" }]]);
assert.equal(routedToDeadEnd({ item: 670, action: "left", owner_step: "prerequisite", prerequisites: [616] }, dm), true);
assert.equal(routedToDeadEnd({ item: 670, action: "left", owner_step: "prerequisite", prerequisites: [] }, dm, { 616: { of: 670 } }), true, "a target known from the prerequisites map");
assert.equal(routedToDeadEnd({ item: 670, action: "left", owner_step: "prerequisite", prerequisites: [700] }, dm), false);
assert.equal(routedToDeadEnd({ item: 670, action: "left", owner_step: "michael", prerequisites: [616] }, dm), false);

// ---- the factory
const healthy = { lastLaunch: NOW - 0.2 * HOUR, stop: false, pause: false, timer: "active", codexLogin: true, providerFailure: "", tokenOk: true };
assert.deepEqual(factoryDown(healthy, NOW), []);
assert.match(factoryDown({ ...healthy, lastLaunch: NOW - 3 * HOUR }, NOW)[0], /no loop lap started in the last 2 hours/);
assert.deepEqual(factoryDown({ ...healthy, lastLaunch: NOW - 3 * HOUR, lastClaim: NOW - HOUR }, NOW), [], "a loop claim within two hours is a lap");
assert.match(factoryDown({ ...healthy, stop: true }, NOW).join(), /STOP/);
assert.match(factoryDown({ ...healthy, pause: true }, NOW).join(), /paused/);
assert.match(factoryDown({ ...healthy, timer: "inactive" }, NOW).join(), /timer is inactive/);
assert.match(factoryDown({ ...healthy, codexLogin: false }, NOW).join(), /not signed in/);
assert.match(factoryDown({ ...healthy, providerFailure: "quota_exhausted" }, NOW).join(), /allowance used up/);
assert.match(factoryDown({ ...healthy, tokenOk: false, tokenError: "401" }, NOW).join(), /builder token/);
assert.equal(PROVIDER_FAILURE.exec('x "providerFailure":{"class":"quota_exhausted","evidence":"..."}')[1], "quota_exhausted");

// ---- the amendment's exact shape
const plan = { id: ID, version: "2.0.0-beta.26", plan: PLAN, tickets: ["01-restart.md", "02-refused-key.md", "03-never-ready.md", "04-moment.md"] };
const cuts = [{ file: "02-refused-key.md", item: 2, issue: 590, url: "u590", title: "t590", dead: { rule: "a", why: "authorized twice", evidence: [{ at: ago(7), kind: "repaired" }], codeMerged: [] } }];
const am = amendment({ existing: null, plan, rule, cuts, now: NOW, repo: R });
assert.deepEqual(Object.keys(am), ["release", "version", "decidedBy", "authority", "words", "approvalRef", "approvedAt", "decidedAt", "deferredTickets", "reason", "reasons"]);
assert.equal(am.decidedBy, "release-driver"); assert.equal(am.authority, "plan-rule"); assert.ok(!("approvedBy" in am), "never approvedBy for a driver cut");
assert.equal(am.words, rule.words); assert.equal(am.approvalRef, `releases/${ID}/plan.md: ${rule.statusLine}`);
assert.deepEqual(am.deferredTickets, ["02-refused-key.md"]);
assert.deepEqual(Object.keys(am.reasons["02-refused-key.md"]), ["item", "issue", "url", "title", "rule", "why", "decidedAt", "evidence"]);
const am2 = amendment({ existing: am, plan, rule, cuts: [{ ...cuts[0], file: "03-never-ready.md", item: 3, issue: 667, dead: { ...cuts[0].dead, codeMerged: ["p671"] } }], now: NOW + HOUR, repo: R });
assert.deepEqual(am2.deferredTickets, ["02-refused-key.md", "03-never-ready.md"], "a later cut extends the driver's own amendment");
assert.equal(am2.decidedAt, am.decidedAt);
assert.ok(am2.reasons["03-never-ready.md"].proof.includes("nothing is marked passed"));
assert.equal(cutSentence({ plan, cuts: [{ item: 2, dead: { rule: "a" } }, { item: 1, dead: { rule: "owner-moved" } }], names: planItemNames(PLAN) }),
  'Beta 26 goes on your server without "A chat says plainly when the AI key was refused", which got stuck, and without "Right after a restart the server answers at once", which you moved to a later release; they move to the next release.');

// ---- one look's cut, with stand-ins
const mkRecords = (files = {}) => ({ files, writes: [], read(rel) { return this.files[rel] ?? null; }, write(f, msg) { this.writes.push({ f, msg }); Object.assign(this.files, f); return "abc1234"; } });
const lookWorld = () => ({ label: "beta.26", items: [moved, item(590, { prs: [{ number: 660, url: "p660", state: "OPEN", labels: ["needs-owner"] }] }), item(667), item(669, { state: "CLOSED" })] });
const lookDecisions = [D(20, "decided", 590, { handled: true }), D(7, "repaired", 590, { handled: true }), D(1, "repaired", 667, { handled: true }), D(0.5, "decided", 667, { handled: true })];
const look = async (over = {}) => {
  const out = { records: mkRecords(over.files), gh: [], recorded: [], told: [], logs: [], state: over.state || { prereqs: {} } };
  const env = { REPO: R, DRY: !!over.dry };
  out.res = await cutLook(env, { plan, world: over.world || lookWorld(), state: out.state, now: NOW, decisions: over.decisions || lookDecisions, label: "beta.26",
    record: e => out.recorded.push(e), notify: (k, t) => out.told.push({ k, t }), log: m => out.logs.push(m), records: out.records,
    gh: (args, input) => { out.gh.push({ args, body: input ? JSON.parse(input) : null }); return {}; }, factory: () => over.factory || healthy });
  return out;
};
let L = await look();
const written = JSON.parse(L.records.files[`releases/${ID}/scope-amendment.json`]);
assert.deepEqual(written.deferredTickets, ["01-restart.md", "02-refused-key.md"], "the dead end and Michael's move are cut; #667 (authorized half an hour ago) is not");
assert.equal(written.reasons["01-restart.md"].rule, "owner-moved");
assert.match(L.records.writes[0].msg, /move to the next release/);
assert.deepEqual(L.recorded.filter(e => e.kind === "cut").map(e => e.item).sort(), [590, 679]);
const posts = L.gh.filter(g => g.args[1] === "POST" && /comments$/.test(g.args[2]));
assert.equal(posts.length, 2, "one comment on each cut issue");
assert.ok(posts.every(p => p.body.body.includes(CUT_MARKER(ID))));
assert.ok(L.gh.some(g => g.args[1] === "DELETE" && g.args[2].endsWith("/issues/590/labels/beta.26")), "the release label comes off");
assert.ok(L.gh.some(g => g.args[1] === "POST" && g.args[2].endsWith("/issues/590/labels") && g.body.labels[0] === "needs-owner"), "needs-owner goes on the issue (its pull request's label is not enough)");
assert.ok(!L.gh.some(g => g.args[2].endsWith("/issues/679/labels")), "an issue that has needs-owner and no release label is left as it is");
assert.equal(L.told.length, 1); assert.ok(!/#\d/.test(L.told[0].t), "no issue numbers in his sentence");
assert.deepEqual([...L.res.cutIssues].sort(), [590, 679]);
// the next look: already cut, nothing written again, no second comment
const again = await look({ files: L.records.files, state: L.state, world: (() => { const w = lookWorld(); for (const i of w.items) if ([590, 679].includes(i.number)) { i.labels = ["needs-owner"]; i.comments = [...i.comments, { body: CUT_MARKER(ID), createdAt: ago(0), author: BOT }]; } return w; })() });
assert.equal(again.records.writes.length, 0); assert.equal(again.gh.length, 0); assert.equal(again.told.length, 0);
assert.deepEqual([...again.res.cutIssues].sort(), [590, 679], "what is cut stays cut");
// dry run: says what it would cut and whether the rest stages, writes nothing
L = await look({ dry: true });
assert.equal(L.records.writes.length, 0); assert.equal(L.gh.length, 0);
assert.match(L.logs.join("\n"), /would cut[\s\S]*#590[\s\S]*the rest would not stage yet: still open #667/);
// the factory is down: an idle item is not cut, it is recorded and told once
L = await look({ factory: { ...healthy, lastLaunch: NOW - 5 * HOUR } });
assert.equal(L.records.writes.length, 0, "factory down: nothing is cut");
assert.ok(L.recorded.some(e => e.kind === "factory-down" && /no loop lap/.test(e.why)));
assert.equal(L.told.length, 1); assert.match(L.told[0].t, /factory that builds Godspeed is not working/);
const st = L.state;
const L2 = await look({ factory: { ...healthy, lastLaunch: NOW - 5 * HOUR }, state: st });
assert.equal(L2.recorded.filter(e => e.kind === "factory-down").length, 0, "the same reason is recorded once");
assert.equal(L2.told[0].k, L.told[0].k, "and told under the same key (tell says it once)");
const idleOnly = await look({ world: { label: "beta.26", items: [item(670), item(669, { state: "CLOSED" })] }, decisions: [...[9, 7, 5, 3].flatMap(h => [D(h, "left", 670, { run: `r${h}` }), finished(h)])], factory: { ...healthy, stop: true } });
assert.equal(idleOnly.records.writes.length, 0, "an idle item is not cut while the factory is halted");
// a person's amendment is never rewritten; a plan without the rule cuts nothing; nothing done: no cut
L = await look({ files: { [`releases/${ID}/scope-amendment.json`]: JSON.stringify({ release: ID, approvedBy: "Michael", deferredTickets: ["04-moment.md"] }) } });
assert.equal(L.records.writes.length, 0); assert.ok(L.recorded.some(e => e.kind === "cut not made" && /person/.test(e.why)));
const norule = { ...plan, plan: PLAN.replace("an item that reaches a dead end leaves the release,\nthe rest ships", "nothing") };
const recNo = []; await cutLook({ REPO: R }, { plan: norule, world: lookWorld(), state: {}, now: NOW, decisions: lookDecisions, label: "beta.26", record: e => recNo.push(e), notify: () => {}, log: () => {}, records: mkRecords(), gh: () => ({}), factory: () => healthy });
assert.ok(recNo.some(e => e.kind === "cut not made" && /does not hold the rule/.test(e.why)));
L = await look({ world: { label: "beta.26", items: [item(590), item(669)] } });
assert.equal(L.records.writes.length, 0, "no ticket done: a cut would leave nothing to ship");

// ---- the test machine: an item whose only missing proof is a hidden check waits while it is broken
const proofWorld = () => ({ label: "beta.26", items: [item(590, { prs: [{ number: 660, url: "p660", state: "OPEN", labels: [], comments: [{ createdAt: ago(8), author: BOT, body: "Loop review: needs owner. The holdout verifier could not observe: Chromium crashed in the verifier's own environment, so H-19 is INCOMPLETE." }] }] }), item(669, { state: "CLOSED" })] });
assert.equal(proofOnly(proofWorld().items[0], [], ID), true, "the loop's words say the verifier could not observe");
assert.equal(proofOnly(item(590), [D(1, "left", 590, { routed: "referee-repair" })], ID), true, "routed to the verifier repair");
assert.equal(proofOnly(item(590), [D(1, "left", 590, { routed: "prerequisite" })], ID), false);
assert.deepEqual(machineHold(null, NOW), { wait: false, hours: 0, unhealthy: false }, "no state: never holds a cut");
assert.equal(machineHold({ healthy: false, since: ago(5) }, NOW).wait, true);
assert.equal(machineHold({ healthy: false, since: ago(25) }, NOW).wait, false);
const machineLook = async tm => { const out = { records: mkRecords(), recorded: [], logs: [] };
  await cutLook({ REPO: R }, { plan, world: proofWorld(), state: {}, now: NOW, decisions: lookDecisions.filter(d => d.item === 590), label: "beta.26", record: e => out.recorded.push(e), notify: () => {}, log: m => out.logs.push(m), records: out.records, gh: () => ({}), factory: () => healthy, testMachine: tm });
  out.am = out.records.files[`releases/${ID}/scope-amendment.json`] ? JSON.parse(out.records.files[`releases/${ID}/scope-amendment.json`]) : null; return out; };
let M = await machineLook({ healthy: false, since: ago(5), why: "the browser closed" });
assert.equal(M.am, null, "the machine is broken for 5 hours: the item waits");
assert.ok(M.recorded.some(e => e.kind === "cut waits for the test machine" && e.items[0] === 590));
M = await machineLook({ healthy: false, since: ago(30), why: "the browser closed" });
assert.deepEqual(M.am.deferredTickets, ["02-refused-key.md"], "after 24 hours it may go");
assert.match(M.am.reasons["02-refused-key.md"].why, /^proof could not run/);
assert.ok(!/fail/i.test(M.am.reasons["02-refused-key.md"].why), "never called failed");
M = await machineLook({ healthy: true, since: ago(1), why: "ok" });
assert.equal(M.am.reasons["02-refused-key.md"].rule, "a", "a healthy machine: the item's own dead end");

// ---- inside a whole look: a cut item leaves the brief, a route to a dead end is not "moved"
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rd-cut-"));
const stateDir = path.join(tmp, "state");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "decisions.jsonl"), [D(30, "decided", 616, { handled: true }), D(20, "decided", 616, { handled: true })].map(d => JSON.stringify(d)).join("\n") + "\n");
fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ prereqs: { [ID]: { 616: { of: 670 } } } }));
const env = { REPO: R, STATE_DIR: stateDir, QUESTIONS_DIR: path.join(tmp, "q"), WORKER_DIR: path.join(tmp, "w"), IDLE_HOURS: 3, MIN_GAP_MINUTES: 60, MAX_RUNS_PER_DAY: 6, MAX_RUNS_24H: 16, AI_MINUTES: 70, MODEL: "m", STRONG_MODEL: "s", DRY: false, ONCE: true, NOTICES_FILE: path.join(tmp, "notices.json") };
const wholeWorld = () => ({ repo: R, label: "beta.26", main: { sha: "x", required: "success" }, owner: { number: 1, questions: [], decisions: [], comments: [] },
  items: [{ ...moved, ticket: 1 }, item(670, { ticket: 3, labels: ["beta.26", "needs-owner"], parkedAt: ago(1) }), item(616, { scope: "prerequisite", prereqOf: 670, labels: ["needs-owner"], parkedAt: ago(1) }), item(669, { state: "CLOSED", ticket: 4 })] });
const records = mkRecords();
let briefSeen = "";
const report = { summary: "s", wants_stronger_model: false, items: [{ item: 670, pr: 0, action: "left", what: "waits on #616", links: [], decision: "", post_on: [], owner_step: "prerequisite", prerequisites: [616], owner_questions_handled: [], dead_ends_handled: [], michael_question: "" }] };
const r = await run(env, { now: () => NOW, log: () => {}, releases: () => [{ id: ID, version: "2.0.0-beta.26", plan: PLAN.replace("3 #667", "3 #670"), tickets: plan.tickets, dir: tmp, hasStaging: false }], world: wholeWorld, deadEnds: () => [],
  template: "{{STUCK}}\n{{TICKETS}}", protected: [], gh: () => [], check: () => ({ approve: true, reason: "ok" }), noReferee: true, autoStage: () => ({}), records, factory: () => healthy,
  genuineRelay: () => () => false, ai: async (e, c) => { briefSeen = c.brief; return { code: 0, report, events: "", guard: "", runDir: "/w" }; } });
const am3 = JSON.parse(records.files[`releases/${ID}/scope-amendment.json`]);
assert.deepEqual(am3.deferredTickets, ["01-restart.md"], "only Michael's move is cut: #670 was not left by any run yet");
assert.ok(!/#679/.test(briefSeen), "a cut item is not in the AI's brief");
const st3 = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
assert.equal(st3.runs.at(-1).moved, false, "a left routed to a prerequisite that is a dead end does not count as moved");
const dec3 = fs.readFileSync(path.join(stateDir, "decisions.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
assert.ok(dec3.some(d => d.kind === "left" && d.item === 670 && d.dead_end === true));
assert.ok(dec3.some(d => d.kind === "cut" && d.item === 679));
void r;
fs.rmSync(tmp, { recursive: true, force: true });
console.log("release-driver cut: all tests passed");
