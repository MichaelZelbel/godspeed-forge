import { TEST_ENV } from "./env.mjs";
// node --test scripts/factory-driver/test-act.mjs   (offline: GitHub, the records and the second check are stand-ins)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notify, mergeAmendment, cutEntry, applyReport, applyDueDefaults, deferredIn, plain } from "../act.mjs";
import { planCutRule } from "../release-driver/release-driver-cut.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-11-18T15:00:00Z");
// Today's real file (godspeed-dev main, ebab4e2): the release driver's flat entry, and Michael's own entry
// in `amendments` that the old driver's 14:13 cut once overwrote.
const BETA28 = fs.readFileSync(path.join(HERE, "fixtures", "scope-amendment-beta.28.json"), "utf8");
const PLAN28 = fs.readFileSync(path.join(HERE, "fixtures", "plan-beta.28.md"), "utf8");
const ID = "godspeed-2.0.0-beta.28-keeps-watch";
const REPO = "MichaelZelbel/godspeed-mission-control";
const TICKETS = ["01-coach-copy-matches-its-pin.md", "02-work-is-ready-only-when-checked.md", "03-spend-notice.md", "04-one-reminder-for-an-unanswered-question.md", "05-domain-watch.md"];
const entryFor = file => cutEntry({ id: ID, version: "2.0.0-beta.28", rule: planCutRule(PLAN28), file, item: Number(file.slice(0, 2)), issue: 700, why: "the feature cannot be built as asked", evidence: ["feasibility: the API has no such call"], now: NOW });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fd-act-"));
  const env = { REPO, STATE_DIR: path.join(root, "state"), QUESTIONS_DIR: path.join(root, "questions"), NOTICES_FILE: path.join(root, "notices.json") };
  const calls = [];
  const comments = {}; // issue -> comments GitHub would list
  const gh = (args, input) => {
    calls.push({ args, input: input ? JSON.parse(input) : null });
    const m = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments\?/.exec(args[0] || "");
    if (m) return comments[m[1]] || [];
    return {};
  };
  const checks = [];
  const check = a => { checks.push(a); return { approve: true, reason: "keeps the bar" }; };
  return { root, env, calls, comments, gh, check, checks };
}
const posts = calls => calls.filter(c => c.args[0] === "-X" && c.args[1] === "POST" && /\/comments$/.test(c.args[2]));
const unlabels = calls => calls.filter(c => c.args[0] === "-X" && c.args[1] === "DELETE" && /\/labels\/needs-owner$/.test(c.args[2])).map(c => Number(/issues\/(\d+)\//.exec(c.args[2])[1]));

test("mergeAmendment keeps every byte of today's beta.28 file, Michael's entry included, and adds the driver's", () => {
  // tickets 2 and 3 are out by Michael's entry, 4 and 5 by the old driver's: only 1 can still go
  const entry = entryFor("01-coach-copy-matches-its-pin.md");
  const out = mergeAmendment(BETA28, entry);
  // everything up to the end of the last entry in `amendments` and everything after it is unchanged
  const end = BETA28.lastIndexOf("}", BETA28.lastIndexOf("]")) + 1;
  assert.equal(out.slice(0, end), BETA28.slice(0, end));
  assert.ok(out.endsWith(BETA28.slice(end)));
  const before = JSON.parse(BETA28), after = JSON.parse(out);
  assert.deepEqual(after.amendments[0], before.amendments[0]);
  assert.equal(after.amendments[0].approvedBy, "Michael");
  assert.equal(after.amendments[0].words, "Screw your test programs. Finish the release now, put it onto the server, then tell me it's done. / I'm waiting. Put the release onto the server now.");
  assert.deepEqual(after.amendments[1], entry);
  assert.equal(after.amendments[1].decidedBy, "factory-driver");
  for (const k of Object.keys(before).filter(k => k !== "amendments")) assert.deepEqual(after[k], before[k], k); // the release driver's flat entry too
  // a ticket that is already out (Michael's 02, the old driver's 04) is never added again: the text stays as it is
  assert.equal(mergeAmendment(BETA28, entryFor("02-work-is-ready-only-when-checked.md")), BETA28);
  assert.equal(mergeAmendment(out, entry), out);
  // the same with Windows line ends: still byte for byte, the new lines in the file's own style
  const crlf = BETA28.replace(/\n/g, "\r\n");
  const outCrlf = mergeAmendment(crlf, entry);
  assert.equal(outCrlf.slice(0, crlf.lastIndexOf("}", crlf.lastIndexOf("]")) + 1), crlf.slice(0, crlf.lastIndexOf("}", crlf.lastIndexOf("]")) + 1));
  assert.ok(!/[^\r]\n/.test(outCrlf));
});

test("mergeAmendment on a person's flat file adds the list and leaves his entry alone; no file starts a new one; broken JSON is never overwritten", () => {
  const his = `{\n  "release": "${ID}",\n  "version": "2.0.0-beta.28",\n  "approvedBy": "Michael",\n  "words": "Ship it without 2.",\n  "approvalRef": "Telegram, 2026-11-18",\n  "approvedAt": "2026-11-18T10:00:00Z",\n  "deferredTickets": ["02-work-is-ready-only-when-checked.md"]\n}\n`;
  const entry = entryFor("05-domain-watch.md");
  const out = mergeAmendment(his, entry);
  const cut = his.lastIndexOf("]") + 1;
  assert.equal(out.slice(0, cut), his.slice(0, cut));
  assert.ok(out.endsWith("\n}\n"));
  assert.deepEqual(JSON.parse(out), { ...JSON.parse(his), amendments: [entry] });
  const empty = `{\n  "release": "${ID}",\n  "amendments": []\n}\n`;
  assert.deepEqual(JSON.parse(mergeAmendment(empty, entry)).amendments, [entry]);
  assert.deepEqual(JSON.parse(mergeAmendment(null, entry)), { release: ID, version: "2.0.0-beta.28", amendments: [entry] });
  assert.throws(() => mergeAmendment("{\"release\": ", entry), /not JSON/);
  assert.deepEqual(deferredIn(JSON.parse(out)), ["02-work-is-ready-only-when-checked.md", "05-domain-watch.md"]);
});

test("the driver's entry stands on the plan's own rule: its words are in the plan, its approval is the plan's Status line", () => {
  const e = entryFor("03-spend-notice.md");
  assert.equal(e.authority, "plan-rule");
  const squash = t => t.replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
  assert.ok(squash(PLAN28).includes(squash(e.words)) && /dead end/.test(e.words));
  assert.equal(e.approvalRef, `releases/${ID}/plan.md: Status: approved by Michael on 2026-11-17 ("Yes, start it") Proposed by Mission Control the same day on his "Plan release Godspeed beta"; it replaces the withdrawn \`godspeed-2.0.0-beta.28-watches-your-contracts\`, which he sent to the back burner ("select another feature").`);
  assert.deepEqual(e.deferredTickets, ["03-spend-notice.md"]);
  assert.ok(e.reasons["03-spend-notice.md"].evidence.length > 0);
});

test("a decision is posted in the loop's form on exactly the issue and pull request the obstacle names, and needs-owner comes off only there", async () => {
  const s = setup();
  const obstacle = { id: "ab12cd34ef", kind: "parked", ticketKey: `${ID}#3`, issue: 704, pr: 708, evidence: ["needs-owner on PR #708"] };
  const report = { summary: "A question of how.", item: 704, pr: 708, decision: "Use the stored spend total as the seam; the acceptance criteria and every check stay exactly as they are.", post_on: [704, 708, 612, 1], cause: "how" };
  const r = await applyReport(s.env, obstacle, report, { gh: s.gh, kind: "decide", id: "factory-helper-ab12cd34ef-1", startedAt: "2026-11-18T14:40:00Z", now: () => NOW, check: s.check });
  assert.deepEqual(r.failed, []);
  assert.equal(r.done.length, 1);
  const p = posts(s.calls);
  assert.deepEqual(p.map(c => Number(/issues\/(\d+)\//.exec(c.args[2])[1])), [704, 708]);
  assert.match(p[0].input.body, /^Manager decision \(Mission Control, not Michael\): Use the stored spend total as the seam;/);
  assert.ok(p.every(c => !/^\s*Owner (decision|question|repair)/i.test(c.input.body)), "never headed as Michael's own word");
  assert.ok(p[0].input.body.endsWith("<!-- factory-driver:factory-helper-ab12cd34ef-1 -->"));
  assert.deepEqual(unlabels(s.calls), [704, 708]);
  assert.equal(s.checks.length, 1, "the second check saw it before it was posted");
});

test("nothing is posted when Michael decided after the helper started; a check that could not answer posts nothing and asks nobody", async () => {
  const s = setup();
  const obstacle = { id: "ab12cd34ef", kind: "parked", issue: 704 };
  const report = { decision: "Use the direct seam.", summary: "" };
  const s2 = setup();
  s2.comments[704] = [{ user: { login: "MichaelZelbel" }, created_at: "2026-11-18T14:50:00Z", body: "Owner decision (2026-11-18): keep H-39 and wait for the tool.", html_url: "https://github.com/x/issues/704#c1" }];
  const his = await applyReport(s2.env, obstacle, report, { gh: s2.gh, kind: "decide", startedAt: "2026-11-18T14:40:00Z", now: () => NOW, check: s2.check });
  assert.match(his.skipped[0], /Michael decided on #704 since the helper started/);
  assert.deepEqual(posts(s2.calls), []); assert.deepEqual(unlabels(s2.calls), []);
  assert.equal(s2.checks.length, 0);
  // a decision by someone else (not an owner) does not count as his
  const s3 = setup();
  s3.comments[704] = [{ user: { login: "someone" }, created_at: "2026-11-18T14:50:00Z", body: "Owner decision: merge it." }];
  await applyReport(s3.env, obstacle, report, { gh: s3.gh, kind: "decide", startedAt: "2026-11-18T14:40:00Z", now: () => NOW, check: s3.check });
  assert.equal(posts(s3.calls).length, 1);
  // no AI reachable for the check: nothing was judged, so nothing is posted and nobody is asked (the next round asks the check again)
  const none = await applyReport(s.env, obstacle, report, { gh: s.gh, kind: "decide", now: () => NOW, check: () => ({ approve: false, reason: "the second check gave no answer", trouble: "quota" }) });
  assert.match(none.failed[0], /could not answer/);
  assert.ok(!none.asked);
  assert.deepEqual(posts(s.calls), []); assert.deepEqual(unlabels(s.calls), []);
  assert.ok(!fs.existsSync(path.join(s.env.QUESTIONS_DIR, "driver-questions.json")));
});

const questionsOf = env => JSON.parse(fs.readFileSync(path.join(env.QUESTIONS_DIR, "driver-questions.json"), "utf8"))[REPO] || [];

test("a technical decision the second check refuses is tried once more with the reason; refused twice it becomes 'every existing check stays as it is', and Michael is never asked (2026-11-19: helpers 27, 28, 29)", async () => {
  const s = setup();
  const state = {};
  const obstacle = { id: "ab12cd34ef", kind: "parked", issue: 704, evidence: [] };
  const report = { decision: "Manager decision (Mission Control, not Michael): skip the H-39 observation, unit tests are enough.", summary: "" };
  const deps = () => ({ gh: s.gh, kind: "decide", now: () => NOW, title: "Spend notice", state, check: () => ({ approve: false, reason: "it waives a holdout observation", trouble: "" }) });
  const first = await applyReport(s.env, obstacle, report, deps());
  assert.deepEqual(first.failed, []);
  assert.ok(!first.asked, "no question to Michael");
  assert.equal(first.refusal, "it waives a holdout observation", "the reason is returned so the next attempt's brief carries it");
  assert.deepEqual(posts(s.calls), []); assert.deepEqual(unlabels(s.calls), []);
  assert.ok(!fs.existsSync(path.join(s.env.QUESTIONS_DIR, "driver-questions.json")));
  // refused a second time: the option that keeps every existing check exactly as it is, posted as the driver's own, unchecked
  const second = await applyReport(s.env, obstacle, report, deps());
  assert.ok(!second.asked && !second.refusal);
  assert.equal(posts(s.calls).length, 1);
  const body = posts(s.calls)[0].input.body;
  assert.match(body, /^Manager decision \(Mission Control, not Michael\): every existing check, hidden scenario and judge stays exactly as it is/);
  assert.ok(!/H-39|unit tests/.test(body), "the refused text is not what is posted");
  assert.deepEqual(unlabels(s.calls), [704]);
  assert.match(second.done[0], /refused twice/);
  assert.ok(!fs.existsSync(path.join(s.env.QUESTIONS_DIR, "driver-questions.json")), "still no question to Michael");
  assert.deepEqual(state.refusals, {}, "the count starts again");
});

test("a judge that miscounts (cherishly #43, H-20) is the driver's: posted as a Manager decision, never put to Michael; look, scope and what people see still are his", async () => {
  const technical = [
    "Replace the judge of H-20: it counts the line twice, so fix its count; every observation H-20 made is still made.",
    "Retire the 18 hidden scenarios that still expect the old wording and replace them with the new set that checks the same behaviour.",
    "Fix the judge so that it counts a missing line as a miss.",
    "Replace the hidden check's judge with one that counts correctly.",
  ];
  for (const decision of technical) {
    const s = setup();
    const r = await applyReport(s.env, { id: "ab12cd34ef", kind: "parked", issue: 43, pr: 44, evidence: [] }, { decision, summary: "x", cause: "how" }, { gh: s.gh, kind: "decide", id: "factory-helper-ab12cd34ef-1", startedAt: "2026-11-19T06:00:00Z", now: () => Date.parse("2026-11-19T06:31:00Z"), title: "Do we fit", state: {}, check: s.check });
    assert.ok(!r.asked, decision);
    assert.ok(!fs.existsSync(path.join(s.env.QUESTIONS_DIR, "driver-questions.json")), decision);
    assert.equal(s.checks.length, 1, "the independent check looks at it");
    assert.deepEqual(posts(s.calls).map(c => c.input.body.split("\n")[0]), [`Manager decision (Mission Control, not Michael): ${decision}`, `Manager decision (Mission Control, not Michael): ${decision}`], decision);
    assert.deepEqual(unlabels(s.calls), [43, 44], decision);
  }
  // product matters reach him, in plain words, and nothing is posted in his name
  const product = [
    "Decide how the Do we fit? line looks: put it on the card as one short sentence.",
    "Narrow the scope of the card to the first two screens.",
    "The look and feel of the new card follows the plan.",
    "What a player sees on the card changes to one short sentence.",
  ];
  for (const decision of product) {
    const s = setup();
    const r = await applyReport(s.env, { id: "ab12cd34ef", kind: "parked", issue: 42, pr: 43, evidence: [] }, { decision, summary: "x", cause: "how" }, { gh: s.gh, kind: "decide", id: "factory-helper-ab12cd34ef-1", startedAt: "2026-11-19T06:00:00Z", now: () => NOW, title: "Do we fit", state: {}, check: s.check });
    assert.equal(r.asked, true, decision);
    assert.deepEqual(posts(s.calls), [], decision); assert.deepEqual(unlabels(s.calls), [], decision);
    assert.equal(s.checks.length, 0, "no check can approve it: it was never the helper's to decide");
    const q = questionsOf(s.env);
    assert.equal(q.length, 1, decision);
    assert.ok(/^A question about the product/.test(q[0].body) && !/^\s*Owner/i.test(q[0].body) && !/check|judge|scenario|holdout/i.test(q[0].body.split("What Mission Control would do")[0]), q[0].body);
    assert.ok(!("default" in q[0]) && !("deadline" in q[0]), "no default is ever applied for him");
  }
  // the helper itself calling it a question of what, or the product helper's report of one
  const s = setup();
  const r = await applyReport(s.env, { id: "x", kind: "parked", issue: 42, evidence: [] }, { decision: "Use the shorter sentence.", cause: "what" }, { gh: s.gh, kind: "decide", now: () => NOW, state: {}, check: s.check });
  assert.equal(r.asked, true); assert.deepEqual(posts(s.calls), []);
  const s2 = setup();
  const p = await applyReport(s2.env, { id: "x", kind: "check-failed", issue: 42, pr: 43 }, { summary: "s", items: [{ item: 42, pr: 43, action: "narrowed", decision: "Narrow the scope of the card to the first two screens.", what: "" }] }, { gh: s2.gh, kind: "product", now: () => NOW, state: {}, check: s2.check });
  assert.equal(p.asked, true); assert.deepEqual(posts(s2.calls), []);
  // a plain question of how, and a decision that only says nothing is loosened, still go out
  const s3 = setup();
  const ok = await applyReport(s3.env, { id: "x", kind: "parked", issue: 42, evidence: [] }, { decision: "Use the stored fixture as the seam. No scenario is loosened and the acceptance criteria stay as they are.", cause: "how" }, { gh: s3.gh, kind: "decide", now: () => NOW, state: {}, check: s3.check });
  assert.deepEqual(ok.failed, []); assert.ok(!ok.asked);
  assert.match(posts(s3.calls)[0].input.body, /^Manager decision \(Mission Control, not Michael\): Use the stored fixture/);
});

test("a product report's decision about another item is not posted on this obstacle", async () => {
  const s = setup();
  const report = { summary: "s", items: [
    { item: 705, pr: 713, action: "repaired", decision: "Mission Control repair 4f3c2a1 on the branch fixes the defect; review again.", what: "" },
    { item: 612, pr: 0, action: "decided", decision: "Owner decision: something about #612", what: "" },
    { item: 705, pr: 0, action: "left", decision: "", what: "" }] };
  const r = await applyReport(s.env, { id: "x", kind: "check-failed", issue: 705, pr: 713 }, report, { gh: s.gh, kind: "product", now: () => NOW, check: s.check });
  assert.equal(posts(s.calls).length, 2);
  assert.ok(posts(s.calls).every(c => /issues\/(705|713)\//.test(c.args[2])));
  assert.ok(posts(s.calls).every(c => /^Manager decision \(Mission Control, not Michael\): /.test(c.input.body)), "the repair is announced under Mission Control's own heading");
  assert.match(r.skipped[0], /#612 is not about this obstacle/);
});

test("a question for Michael goes to the questions helper in plain words, with no default and no deadline", async () => {
  const s = setup();
  const report = { summary: "s", ask: true, item: 706, question: "Should the domain watch also cover .de addresses — or only .com?", options: ["Only .com", "Both"],
    recommendation: "Only .com", default: "Only .com", default_why: "it is easy to add .de later", deadline_hours: 24, comment: "Which endings should the domain watch cover?" };
  const r = await applyReport(s.env, { id: "cd", kind: "parked", issue: 706 }, report, { gh: s.gh, kind: "michael", now: () => NOW, title: "Domain watch endings" });
  assert.match(r.done[0], /asked Michael about #706; it waits for his answer/);
  const q = questionsOf(s.env)[0];
  assert.equal(q.issue, 706);
  assert.ok(!("default" in q) && !("deadline" in q), "a default or deadline a helper still reports is ignored");
  assert.match(q.body, /Nothing is decided until you answer: no default applies and the item waits for you\.$/);
  assert.ok(!/[—–]/.test(q.body), "no em dash reaches Michael");
  assert.equal(posts(s.calls).length, 1);
  assert.match(posts(s.calls)[0].input.body, /^Question for Michael \(asked by Mission Control, not yet answered\): Which endings/);
  assert.ok(!/^\s*Owner (decision|question|repair)/i.test(posts(s.calls)[0].input.body));
  assert.deepEqual(unlabels(s.calls), []);
  // a question without words is not asked
  const s2 = setup();
  const bad = await applyReport(s2.env, { id: "cd", issue: 706 }, { ...report, question: "" }, { gh: s2.gh, kind: "michael", now: () => NOW });
  assert.match(bad.failed[0], /lacks its words/);
});

test("after a technical question was refused, its paraphrase as a decision still never reaches Michael", async () => {
  const s = setup();
  const state = {};
  const ob = { id: "cd", kind: "parked", issue: 706, evidence: [] };
  await applyReport(s.env, ob, { summary: "s", ask: true, item: 706, question: "Should the judge count what a user sees once or twice?", options: [], recommendation: "" }, { gh: s.gh, kind: "michael", now: () => NOW, state });
  assert.equal(state.technical.cd, true);
  const r = await applyReport(s.env, ob, { decision: "Count what a person sees once.", cause: "how" }, { gh: s.gh, kind: "decide", now: () => NOW, state, check: s.check });
  assert.ok(!r.asked, "not a question for Michael");
  assert.equal(posts(s.calls).length, 1, "decided as a Manager decision");
  assert.deepEqual(state.technical, {}, "and the mark is cleared");
});

test("two refused entries of one report are one refusal: the fallback needs a later attempt", async () => {
  const s = setup();
  const state = {};
  const report = { summary: "s", items: [
    { item: 705, pr: 713, action: "decided", decision: "Skip the H-39 observation.", what: "" },
    { item: 705, pr: 0, action: "decided", decision: "Skip the H-39 observation, unit tests suffice.", what: "" }] };
  const deps = () => ({ gh: s.gh, kind: "product", now: () => NOW, state, check: () => ({ approve: false, reason: "it waives an observation", trouble: "" }) });
  const first = await applyReport(s.env, { id: "x", kind: "check-failed", issue: 705, pr: 713 }, report, deps());
  assert.equal(first.refusal, "it waives an observation");
  assert.deepEqual(posts(s.calls), [], "no fallback from one report");
  assert.equal(state.refusals.x, 1);
  await applyReport(s.env, { id: "x", kind: "check-failed", issue: 705, pr: 713 }, report, deps());
  assert.equal(posts(s.calls).length, 2, "the second report's refusal posts the fixed decision, once per target");
  assert.ok(posts(s.calls).every(c => /every existing check, hidden scenario and judge stays exactly as it is/.test(c.input.body)));
});

test("a question in the machinery's words is never put to Michael, whatever the helper called it", async () => {
  const s = setup();
  const state = {};
  const r = await applyReport(s.env, { id: "cd", kind: "parked", issue: 706 }, { summary: "s", ask: true, item: 706, question: "Should the hidden scenario H-20 judge count the line twice or once?", options: ["Twice", "Once"], recommendation: "Once" }, { gh: s.gh, kind: "michael", now: () => NOW, state });
  assert.ok(!r.done.length && /technical; Michael is not asked/.test(r.skipped[0]));
  assert.match(r.refusal, /decides itself and never asks Michael/, "the next attempt is told to decide it");
  assert.ok(!fs.existsSync(path.join(s.env.QUESTIONS_DIR, "driver-questions.json")));
  // a decision the helper itself called a question of what, but whose words are the machinery's, is decided here
  const d = await applyReport(s.env, { id: "x", kind: "parked", issue: 42, evidence: [] }, { decision: "Fix the judge of H-20 so it counts the line once.", cause: "what" }, { gh: s.gh, kind: "decide", now: () => NOW, state: {}, check: s.check });
  assert.ok(!d.asked); assert.equal(posts(s.calls).length, 1);
});

test("a cut re-reads the file right before writing, keeps what Michael wrote meanwhile, and tells him in one sentence", async () => {
  const s = setup();
  // Michael added an entry after the helper started: the file on main is no longer the one the round began with
  const withLate = mergeAmendment(BETA28, { release: ID, version: "2.0.0-beta.28", approvedBy: "Michael", words: "Leave the later note out.", approvalRef: "Telegram 2026-11-18 15:55", approvedAt: "2026-11-18T14:55:00Z", deferredTickets: ["99-later-note.md"] });
  const files = { [`releases/${ID}/plan.md`]: PLAN28, [`releases/${ID}/scope-amendment.json`]: withLate };
  const writes = [];
  const records = { fetch: () => {}, read: rel => files[rel] ?? null, ticketFiles: () => [...TICKETS, "06-still-in.md"].map(t => `releases/${ID}/tickets/${t}`), // one ticket stays in
    write: (f, msg) => { writes.push({ f, msg }); Object.assign(files, f); return `c${writes.length}`; } };
  const obstacle = { id: "ee11ff2233", kind: "no-progress", ticketKey: `${ID}#1`, issue: 702, evidence: ["two attempts with different providers failed on the feature"] };
  const r = await applyReport(s.env, obstacle, { kind: "cut", why: "the provider gives no spending figure for a day", evidence: ["feasibility: no endpoint reports a daily total"] },
    { gh: s.gh, records, parentText: () => withLate, now: () => NOW, title: "Coach copy", gated: true });
  assert.deepEqual(r.failed, []);
  assert.equal(writes.length, 1);
  const written = writes[0].f[`releases/${ID}/scope-amendment.json`];
  assert.ok(written.startsWith(withLate.slice(0, withLate.lastIndexOf("}", withLate.lastIndexOf("]")) + 1)));
  const j = JSON.parse(written);
  assert.deepEqual(j.amendments.map(a => a.approvedBy || a.decidedBy), ["Michael", "Michael", "factory-driver"]);
  assert.deepEqual(j.amendments[2].deferredTickets, ["01-coach-copy-matches-its-pin.md"]);
  const notices = JSON.parse(fs.readFileSync(s.env.NOTICES_FILE, "utf8")).notices;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].text, "Beta 28 goes on your server without \"The coach installed with Godspeed is exactly the coach its own project released\", because it could not be built as asked; it moves to the next release. Whether it should be in this one after all is your call.");
  assert.ok(!/[—–]/.test(notices[0].text));
  // said once: the same cut again neither writes nor tells
  const again = await applyReport(s.env, obstacle, { kind: "cut", why: "x" }, { gh: s.gh, records, parentText: () => null, now: () => NOW });
  assert.match(again.skipped[0], /already out/);
  assert.equal(writes.length, 1);
});

test("a cut whose write landed on a file changed in between merges again onto that file", async () => {
  const s = setup();
  const late = mergeAmendment(BETA28, { release: ID, version: "2.0.0-beta.28", approvedBy: "Michael", words: "Leave the later note out.", approvalRef: "Telegram", approvedAt: "2026-11-18T14:59:00Z", deferredTickets: ["99-later-note.md"] });
  const files = { [`releases/${ID}/plan.md`]: PLAN28, [`releases/${ID}/scope-amendment.json`]: BETA28 };
  const writes = [];
  const parents = [late, null]; // the first write's parent was Michael's newer file; Records.write had overwritten it
  const records = { read: rel => files[rel] ?? null, ticketFiles: () => [...TICKETS, "06-still-in.md"], write: f => { writes.push(f); Object.assign(files, f); return `c${writes.length}`; } }; // one ticket stays in
  await applyReport(s.env, { id: "ee", ticketKey: `${ID}#1`, issue: 702 }, { kind: "cut", why: "cannot be built" }, { records, parentText: () => parents.shift(), now: () => NOW, state: {} });
  assert.equal(writes.length, 2);
  const final = JSON.parse(files[`releases/${ID}/scope-amendment.json`]);
  assert.deepEqual(final.amendments.map(a => (a.deferredTickets || []).join(",")), ["02-work-is-ready-only-when-checked.md,03-spend-notice.md", "99-later-note.md", "01-coach-copy-matches-its-pin.md"]);
});

test("a cut without the plan's dead-end rule cuts nothing", async () => {
  const s = setup();
  const files = { [`releases/${ID}/plan.md`]: PLAN28.replace(/an item that reaches a dead end leaves the release, the\s+rest ships/, "items wait"), [`releases/${ID}/scope-amendment.json`]: BETA28 };
  let wrote = false;
  const r = await applyReport(s.env, { id: "ee", ticketKey: `${ID}#1`, issue: 702 }, { kind: "cut", why: "x" }, { records: { read: rel => files[rel], ticketFiles: () => TICKETS, write: () => { wrote = true; return "c"; } }, now: () => NOW, state: {} });
  assert.match(r.failed[0], /does not hold the rule/);
  assert.equal(wrote, false);
});

test("a cut never leaves a release with nothing to ship", async () => {
  const s = setup();
  // today's beta.28 file already moves items 2 to 5 out: cutting item 1 would leave nothing
  const files = { [`releases/${ID}/plan.md`]: PLAN28, [`releases/${ID}/scope-amendment.json`]: BETA28 };
  let wrote = false;
  const r = await applyReport(s.env, { id: "ef", ticketKey: `${ID}#1`, issue: 299, evidence: [] }, { why: "x" }, { kind: "cut", records: { read: rel => files[rel], ticketFiles: () => TICKETS, write: () => { wrote = true; return "c"; } }, now: () => NOW, state: {} });
  assert.match(r.failed[0], /nothing to ship/);
  assert.equal(wrote, false);
});

test("a passed deadline never posts a default in his name: the question waits; an answered one is closed without posting", async () => {
  const s = setup();
  fs.mkdirSync(s.env.QUESTIONS_DIR, { recursive: true });
  // 706 and 708 carry the default and deadline an older helper wrote; 709 is a question without either; 707 was answered
  const q = (issue, deadline) => ({ heading: `h (#${issue})`, body: "b", issue, at: "2026-11-17T12:00:00.000Z", default: "Only .com", deadline });
  fs.writeFileSync(path.join(s.env.QUESTIONS_DIR, "driver-questions.json"), JSON.stringify({ [REPO]: [q(706, "2026-11-18T12:00:00.000Z"), q(707, "2026-11-18T12:00:00.000Z"), q(708, "2026-11-19T12:00:00.000Z"), { heading: "h (#709)", body: "b", issue: 709, at: "2026-11-17T12:00:00.000Z" }, { heading: "old", body: "b", issue: 600, at: "x" }] }));
  s.comments[707] = [{ user: { login: "godspeed-dev-builder[bot]" }, created_at: "2026-11-18T09:00:00Z", body: "Owner decision (question 1: h)\n\n> Both endings.\n\nHis words, verbatim, sent in Telegram on 2026-11-18. <!-- factory-owner-questions:abc -->" }];
  s.comments[709] = [{ user: { login: "godspeed-dev-builder[bot]" }, created_at: "2026-11-18T09:00:00Z", body: "Manager decision (Mission Control, not Michael): something of ours. <!-- factory-driver:x -->" }];
  const r = await applyDueDefaults(s.env, { gh: s.gh, now: () => NOW, check: s.check });
  assert.deepEqual(posts(s.calls), [], "no default is posted, however long it has waited");
  assert.deepEqual(unlabels(s.calls), [], "needs-owner stays on everything he has not answered");
  assert.equal(s.checks.length, 0);
  assert.deepEqual(r.done, ["#707: Michael answered; the question is closed"]);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(questionsOf(s.env).map(x => x.issue), [706, 708, 709, 600], "a comment of ours is not his answer");
});

test("every repository the driver asked about is read for his answers, and none gets a default (seen live: #33 of the forge)", async () => {
  const s = setup();
  fs.mkdirSync(s.env.QUESTIONS_DIR, { recursive: true });
  const q = issue => ({ heading: `h (#${issue})`, body: "b", issue, at: "2026-11-17T12:00:00.000Z", default: "Replace it", deadline: "2026-11-18T03:40:00.000Z" });
  fs.writeFileSync(path.join(s.env.QUESTIONS_DIR, "driver-questions.json"), JSON.stringify({ [REPO]: [q(706)], "MichaelZelbel/godspeed-forge": [q(33)] }));
  const r = await applyDueDefaults(s.env, { gh: s.gh, now: () => NOW, check: s.check });
  assert.deepEqual(posts(s.calls), []);
  assert.deepEqual(r.applied, []);
  const left = JSON.parse(fs.readFileSync(path.join(s.env.QUESTIONS_DIR, "driver-questions.json"), "utf8"));
  assert.deepEqual([left[REPO].length, left["MichaelZelbel/godspeed-forge"].length], [1, 1]);
});

test("a factory-idle obstacle has no item of its own: its decision goes only on the board item the helper named", async () => {
  const s = setup();
  const obstacle = { id: "ee12cd34ef", kind: "factory-idle", project: "godspeed-mission-control", repo: REPO, board: [612, 640], evidence: ["idle"] };
  const report = { summary: "A question of how.", item: 640, pr: 0, decision: "Run the check with the stored fixture; the acceptance criteria and every check stay exactly as they are.", cause: "how" };
  const r = await applyReport(s.env, obstacle, report, { gh: s.gh, kind: "decide", id: "factory-helper-ee12cd34ef-1", startedAt: "2026-11-18T14:40:00Z", now: () => NOW, check: s.check });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(posts(s.calls).map(c => Number(/issues\/(\d+)\//.exec(c.args[2])[1])), [640]);
  assert.deepEqual(unlabels(s.calls), [640]);
  const s2 = setup();
  const off = await applyReport(s2.env, obstacle, { ...report, item: 999 }, { gh: s2.gh, kind: "decide", id: "factory-helper-ee12cd34ef-2", startedAt: "2026-11-18T14:40:00Z", now: () => NOW, check: s2.check });
  assert.deepEqual(posts(s2.calls), [], "an item that is not parked on the board is never decided from here");
  assert.ok(off.skipped.length + off.failed.length > 0);
});

test("words for Michael never carry an em or en dash", () => {
  assert.equal(plain("It is stuck — the tool is missing – so it waits."), "It is stuck, the tool is missing, so it waits.");
});

test("THE FUNNEL: a message that reaches notify() without the gate is only filed as pending, never sent", () => {
  const s = setup(); const state = {};
  assert.equal(notify(s.env, { state }, "k1", "Something happened.", "about", NOW), false);
  assert.deepEqual(Object.keys(state.pendingNotices), ["k1"]); assert.equal(state.pendingNotices.k1.text, "Something happened.");
  assert.ok(!fs.existsSync(s.env.NOTICES_FILE), "nothing was written to the notice queue");
  assert.equal(notify(s.env, { state, gated: true }, "k2", "Gated.", "about", NOW), true, "after the gate it is sent");
  assert.match(fs.readFileSync(s.env.NOTICES_FILE, "utf8"), /Gated\./);
});
