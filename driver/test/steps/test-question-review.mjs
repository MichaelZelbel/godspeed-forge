// node --disable-warning=ExperimentalWarning driver/test/steps/test-question-review.mjs
// test cases: 17
// What the first independent review of the question work (Codex, 2026-11-24) found, each kept from coming back.
import { testCase } from "../../../test/cases.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { run, parseQuestions, keyOf, idOf, decisionMarker, STATE_VERSION, retireNotices, readOwnerMessages } from "../../steps/questions/factory-owner-questions.mjs";
import { severityOf, categoryOf } from "../../steps/questions/severity.mjs";
import { pickOption } from "../../steps/questions/choices.mjs";
import { addressOf, mailReplies, openUrgent } from "../../steps/questions/pager.mjs";
import * as check from "../../steps/question-check.mjs";
import { findObstacles } from "../../obstacles.mjs";
import { applyReport } from "../../act.mjs";

const MIN = 60000, T0 = Date.parse("2026-11-24T15:00:00Z");
const fwd = p => p.replace(/\\/g, "/");
const setup = name => { const d = fs.mkdtempSync(path.join(os.tmpdir(), name)); fs.writeFileSync(path.join(d, "messages.json"), "[]"); return d; };
const issue = (d, body) => fs.writeFileSync(path.join(d, "issues.json"), JSON.stringify([{ title: "Owner decisions needed", state: "open", number: 7, updated_at: "1", html_url: "https://github.com/o/r/issues/7", body }]));
// GitHub in memory: comments per item, a post that can be made to fail
const github = () => {
  const g = { comments: {}, fail: new Set(), posts: [] };
  g.post = (repo, n, body) => { if (g.fail.has(n)) throw new Error("HTTP 502"); g.posts.push(n); (g.comments[n] ||= []).push({ body }); return { id: g.posts.length }; };
  g.read = (repo, n) => g.comments[n] || [];
  return g;
};
const channels = () => { const c = { tg: [], n: 0 }; c.api = { telegram: async t => { c.tg.push(t); return { ok: true, receipt: String(++c.n) }; }, email: async () => ({ ok: false, off: true, why: "no email settings on this server" }), emailReplies: async () => [], openIssue: async () => ({ ok: false, off: true, why: "no urgent repository on this server" }), closeIssue: async () => true, issueComments: async () => [] }; return c; };
const env = (d, extra = {}) => ({ REPO: "o/r", FORGE_USER: "x", FORGE_HOME: "/h", OWNER_NAME: "Alex", GODSPEED_DIR: d, STATE: path.join(d, "state.json"), JOURNAL: path.join(d, "journal.jsonl"), OQ_ISSUES_FILE: path.join(d, "issues.json"), OQ_MESSAGES_FILE: path.join(d, "messages.json"), OQ_MODEL_CMD: "exit 1", ...extra });
const deps = (g, c) => ({ channels: c.api, postComment: g.post, readComments: g.read, removeLabel: () => {} });
const quiet = () => {};
const PAY = "Options: (a) pay for the bigger plan; (b) wait. Recommendation: (a).";

testCase("two questions that differ only in their numbers are two questions, each decided on its own item");
{
  assert.deepEqual(parseQuestions("### Should it sync? (#12)\nx\n### Should it sync? (#13)\ny").map(q => q.key), ["should it sync", "should it sync items 13"]);
  const d = setup("rv-dup-"); const g = github();
  issue(d, "### Should it sync? (#12)\nOptions: (a) yes; (b) no. Recommendation: (a).\n\n### Should it sync? (#13)\nOptions: (a) yes; (b) no. Recommendation: (b).\n");
  const r = await run(env(d), T0, quiet, deps(g, channels()));
  assert.equal(r.decided.length, 2); assert.deepEqual(g.posts, [12, 13]);
  assert.ok(g.comments[13][0].body.includes("option (b): no") && g.comments[13][0].body.includes(decisionMarker("should it sync items 13")));
}

testCase("the page rule: dangerous wording without options pages, negated and harmless mentions do not, a purpose change is never taken");
{
  assert.equal(severityOf({ heading: "What should happen next?", body: "Should we publish it for everyone?" }).category, "publish", "with nothing to pick from, the question's own text counts");
  for (const [t, c] of [["delete user data", "delete"], ["send invitations to customers", "publish"], ["increase the monthly cap", "money"], ["No new key is needed, raise the limit", "money"]]) assert.equal((categoryOf(t) || {}).category, c, t);
  for (const t of ["Do not publish this yet", "show the billing address", "show the payment form", "without spending money", "a closed person can still delete their account"]) assert.equal(categoryOf(t), null, t);
  const p = pickOption({ heading: "h", body: "Options: (a) keep it for couples; (b) change the project's purpose to serve teams. Recommendation: (b)." });
  assert.equal(p.how, "keeps the mission"); assert.equal(p.option.label, "a");
  assert.equal(pickOption({ heading: "h", body: "Options: (a) a new mission for teams; (b) a different purpose. Recommendation: (a)." }), null, "no option keeps it: the decide helper, never a mission change by rule");
}

testCase("a decision with several items is complete only when every item has it; a failed post is finished next run, never posted twice");
{
  const d = setup("rv-multi-"); const g = github();
  issue(d, "### One more lap each (#20 / PR #21)\nOptions: (a) one lap each; (b) close them. Recommendation: (a).\n");
  g.fail.add(21);
  const r1 = await run(env(d), T0, quiet, deps(g, channels()));
  assert.deepEqual(r1.decided, []); assert.deepEqual(g.posts, [20]);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8")).decided[keyOf("One more lap each (#20 / PR #21)")], "not decided while #21 lacks it");
  g.fail.clear();
  const r2 = await run(env(d), T0 + 5 * MIN, quiet, deps(g, channels()));
  assert.equal(r2.decided.length, 1); assert.deepEqual(g.posts, [20, 21], "#20 is not posted again");
}

testCase("an unwritable journal keeps a decision from being recorded as made; the next run records it without posting again");
{
  const d = setup("rv-journal-"); const g = github();
  issue(d, "### Move the card (#30)\nOptions: (a) keep; (b) move. Recommendation: (b).\n");
  fs.mkdirSync(path.join(d, "journal-is-a-folder"));
  const r1 = await run(env(d, { JOURNAL: path.join(d, "journal-is-a-folder") }), T0, quiet, deps(g, channels()));
  assert.deepEqual(r1.decided, []); assert.deepEqual(g.posts, [30]);
  const r2 = await run(env(d), T0 + 5 * MIN, quiet, deps(g, channels()));
  assert.equal(r2.decided.length, 1); assert.deepEqual(g.posts, [30]);
  assert.ok(fs.readFileSync(path.join(d, "journal.jsonl"), "utf8").includes('"t":"decision"'));
}

testCase("a page goes on escalating while its project's list cannot be read");
{
  const d = setup("rv-unread-"); const g = github(); const c = channels();
  issue(d, `### Budget\n${PAY}\n`);
  await run(env(d, { OQ_MODEL_CMD: "exit 1" }), T0, quiet, deps(g, c));
  await run(env(d), T0 + 5 * MIN, quiet, deps(g, c)); await run(env(d), T0 + 10 * MIN, quiet, deps(g, c));
  assert.equal(c.tg.length, 1, "paged with the fixed message after three wordings failed");
  await run(env(d), T0 + 20 * MIN, quiet, deps(g, c)); // the 10-minute step (no email, no urgent repository here)
  fs.writeFileSync(path.join(d, "issues.json"), "not json");
  await run(env(d), T0 + 75 * MIN, quiet, deps(g, c));
  assert.equal(c.tg.length, 2, "the 60-minute step went out though the list was unreadable");
  assert.ok(!JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8")).told[keyOf("Budget")].page.closed, "and an unreadable list never withdraws it");
}

testCase("only the owner's own replies count: his Telegram account, his exact email address; the urgent issue is found again by its marker");
{
  const d = setup("rv-who-");
  fs.writeFileSync(path.join(d, "m.json"), JSON.stringify([{ id: 1, ts: 10, text: "budget: yes", user: 555 }, { id: 2, ts: 11, text: "budget: no", user: 42 }]));
  assert.deepEqual(readOwnerMessages({ OQ_MESSAGES_FILE: path.join(d, "m.json"), OWNER_TELEGRAM_IDS: ["42"] }, 0, 0).map(m => m.id), [2]);
  assert.equal(addressOf("Owner <owner@example.com>"), "owner@example.com");
  fs.writeFileSync(path.join(d, "keys.env"), "AGENTMAIL_READ_KEY=r\n");
  const f = async url => /messages\?/.test(url) ? { ok: true, json: async () => ({ messages: [{ message_id: "a", from: "x <owner@example.com.evil.test>", subject: "Re: [q:0123456789]" }, { message_id: "b", from: "notowner@example.com", subject: "Re: [q:0123456789]" }] }) } : { ok: true, json: async () => ({ text: "yes" }) };
  assert.deepEqual(await mailReplies({ OWNER_EMAIL: "owner@example.com", MAIL_INBOX: "i", KEYS_FILE: path.join(d, "keys.env") }, 0, f), [], "an address that only contains his is not his");
  const calls = [];
  const gh = (args, input) => { calls.push(args.join(" ")); if (/issues\?state=open/.test(args[1] || "")) return [{ number: 9, html_url: "https://github.com/o/w/issues/9", body: "text\n<!-- factory-question:factory-question-abc -->" }]; return {}; };
  assert.deepEqual(openUrgent({ URGENT_REPO: "o/w", URGENT_LABEL: "alex-urgent" }, { title: "t", body: "b\n<!-- factory-question:factory-question-abc -->" }, gh), { ok: true, receipt: "https://github.com/o/w/issues/9", number: 9 });
  assert.ok(!calls.some(x => /-X POST repos\/o\/w\/issues /.test(`${x} `)), "an issue opened before is never opened twice");
}

testCase("the upgrade takes the old unreceipted notices out of Godspeed's notice file, and nothing else in it");
{
  const d = setup("rv-notices-"); const g = github();
  issue(d, "### Move the card (#40)\nOptions: (a) keep; (b) move. Recommendation: (b).\n");
  fs.writeFileSync(path.join(d, "state.json"), JSON.stringify({ told: { [keyOf("Move the card (#40)")]: { at: "2026-11-16T08:00:00Z", heading: "Move the card (#40)", notice: "factory-question-old" } }, tries: {} }));
  fs.writeFileSync(path.join(d, "notices.json"), JSON.stringify({ notices: [{ id: "factory-question-old", text: "old" }, { id: "backup-failed", text: "keep me" }] }));
  await run(env(d, { NOTICES_FILE: path.join(d, "notices.json") }), T0, quiet, deps(g, channels()));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, "notices.json"), "utf8")).notices.map(n => n.id), ["backup-failed"]);
  const s = JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8"));
  assert.equal(s.v, STATE_VERSION); assert.equal(s.retired_notices, undefined); assert.ok(s.decided[keyOf("Move the card (#40)")]);
  assert.equal(retireNotices(path.join(d, "none.json"), ["x"]), true);
  fs.writeFileSync(path.join(d, "odd.json"), "[1,2]"); assert.equal(retireNotices(path.join(d, "odd.json"), ["x"]), false, "a file of another layout is never rewritten");
}

testCase("the accountant looks for a decision again after an hour: a deleted one is no decision");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rv-acc-"));
  const settings = { owner: { github_login: "boss", name: "Alex" }, server: { factory_user: "b", factory_home: "/h", state_dir: path.join(tmp, "s"), questions_dir: path.join(tmp, "q") }, steps: { questions: { godspeed_dir: tmp, hermes_home: tmp } } };
  const comments = { 7: [{ body: `Manager decision (Mission Control, on Alex's standing instruction of 2026-11-24) on the question "The card": keep.\n${decisionMarker(keyOf("The card"))}` }] };
  const ctx = at => ({ settings, main: { repository: "acme/app" }, projects: [{ repository: "acme/app" }], env: {}, stateDir: path.join(tmp, "s", "steps", "question-check"), now: T0 + at,
    accountantDeps: { ownerIssue: () => ({ number: 7, body: "### The card\nx\n", url: "u" }), comments: (r, n) => comments[n] || [], telegram: async () => ({ ok: true, receipt: "1" }) } });
  await check.run(ctx(0));
  assert.equal((await check.run(ctx(61 * MIN))).halt, undefined, "decided");
  comments[7] = [];
  assert.equal((await check.run(ctx(90 * MIN))).halt, undefined, "within the hour the decision found is believed");
  assert.equal((await check.run(ctx(125 * MIN))).halt.key, "nobody-acme__app", "an hour later it is looked for again, and it is gone");
}

testCase("a question handed to the driver that names several items is decided on each of them, and counts as decided only then");
{
  const d = setup("rv-route-"); const g = github();
  issue(d, "### Status of two items (#50 / PR #51)\nFor your information.\n");
  await run(env(d), T0, quiet, deps(g, channels()));
  const routed = JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8")).routed;
  const key = keyOf("Status of two items (#50 / PR #51)");
  assert.deepEqual(routed[key].items, [50, 51]);
  const [ob] = findObstacles({ routedQuestions: [{ ...routed[key], key }] }, {}, T0, {});
  const posted = [];
  await applyReport({ REPO: "o/r" }, ob, { decision: "Nothing to change.", cause: "how" }, { kind: "decide", gh: (args, input) => { if (args.includes("POST")) posted.push(Number(/issues\/(\d+)\/comments/.exec(args[2])[1])); return []; }, check: () => ({ approve: true, reason: "ok" }), id: "u", state: {} });
  assert.deepEqual(posted, [50, 51], "the decide helper's decision goes on both");
  g.comments[50] = [{ body: `Manager decision (Mission Control, not Alex): nothing.\n<!-- factory-question:${idOf(key)} -->` }];
  await run(env(d), T0 + 5 * MIN, quiet, deps(g, channels()));
  assert.ok(JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8")).routed[key], "only one of its items has it: still the driver's");
  g.comments[51] = g.comments[50];
  await run(env(d), T0 + 10 * MIN, quiet, deps(g, channels()));
  const s = JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8"));
  assert.ok(!s.routed[key] && s.decided[key]);
}

// ---- the second round of the review
testCase("two pages whose titles differ only in their numbers stay two pages on the next run: each paged once");
{
  const d = setup("rv2-pages-"); const g = github(); const c = channels();
  issue(d, `### Budget (#60)\n${PAY}\n\n### Budget (#61)\n${PAY}\n`);
  for (const at of [0, 5, 10]) await run(env(d), T0 + at * MIN, quiet, deps(g, c));
  assert.equal(c.tg.length, 2);
  await run(env(d), T0 + 15 * MIN, quiet, deps(g, c));
  const told = JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8")).told;
  assert.deepEqual(Object.keys(told).sort(), ["budget", "budget items 61"]); assert.equal(c.tg.length, 2, "neither is paged again");
}

testCase("with no recommendation, an option that changes what the project is for is never the one taken");
{
  const p = pickOption({ heading: "h", body: "Options: (a) change the purpose to teams; (b) change the purpose to families." });
  assert.equal(p, null, "every option changes it: the decide helper");
  const q = pickOption({ heading: "h", body: "Options: (a) change the purpose to teams; (b) keep it as it is for now." });
  assert.equal(q.option.label, "b");
}

testCase("a mention is not an action: an invoice shown, no money, an app-store link, a build cache, a banner, a button");
{
  for (const t of ["show the invoice", "costs no money", "keep the app store link", "purge the build cache", "an announcement banner in the app", "where the Publish button sits", "a newsletter signup field"]) assert.equal(categoryOf(t), null, t);
  for (const [t, c] of [["publish what main holds", "publish"], ["submit it to the App Store", "publish"], ["wipe the database", "delete"], ["purge inactive accounts", "delete"], ["spend more money", "money"], ["announce it to users", "publish"]]) assert.equal((categoryOf(t) || {}).category, c, t);
}

testCase("the decide helper's decision on a question counts as made only once it is in the journal");
{
  const d = setup("rv2-route-"); const g = github();
  issue(d, "### Status of #70 (#70)\nFor your information.\n");
  await run(env(d), T0, quiet, deps(g, channels()));
  const key = keyOf("Status of #70 (#70)");
  g.comments[70] = [{ body: `Manager decision (Mission Control, on Alex's standing instruction of 2026-11-24): nothing to change.\n<!-- factory-question:${idOf(key)} -->` }];
  fs.mkdirSync(path.join(d, "jdir"));
  await run(env(d, { JOURNAL: path.join(d, "jdir") }), T0 + 5 * MIN, quiet, deps(g, channels()));
  assert.ok(JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8")).routed[key], "unjournaled: still the driver's");
  await run(env(d), T0 + 10 * MIN, quiet, deps(g, channels()));
  assert.ok(JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8")).decided[key]);
  const j = fs.readFileSync(path.join(d, "journal.jsonl"), "utf8");
  assert.ok(j.includes("the driver's decide helper") && j.includes("nothing to change."), "with the choice it made");
}

testCase("the two-hour message is never lost: with Telegram down and the journal unwritable, it is tried again next round");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rv2-alarm-"));
  fs.mkdirSync(path.join(tmp, "s", "journal.jsonl"), { recursive: true }); // the journal cannot be written
  const settings = { owner: { github_login: "boss", name: "Alex" }, server: { factory_user: "b", factory_home: "/h", state_dir: path.join(tmp, "s"), questions_dir: path.join(tmp, "q") }, steps: { questions: { godspeed_dir: tmp, hermes_home: tmp } } };
  const sent = []; let up = false;
  const ctx = at => ({ settings, main: { repository: "acme/app" }, projects: [{ repository: "acme/app" }], env: {}, stateDir: path.join(tmp, "s", "steps", "question-check"), now: T0 + at,
    accountantDeps: { ownerIssue: () => ({ number: 7, body: "### Nobody has it\nx\n", url: "u" }), comments: () => [], telegram: async t => { sent.push(t); return up ? { ok: true, receipt: "9" } : { ok: false, why: "telegram http 502" }; } } });
  await check.run(ctx(0)); await check.run(ctx(121 * MIN));
  assert.equal(sent.length, 1);
  up = true;
  const r = await check.run(ctx(126 * MIN));
  assert.equal(sent.length, 2, "said again, since nothing held it"); assert.match(r.summary, /receipt 9/);
  await check.run(ctx(131 * MIN)); assert.equal(sent.length, 2, "and then never again");
}

// ---- the third round of the review
testCase("outward wording the list missed pages; 'not recommended' is never the recommendation; an audience change is never taken");
{
  for (const t of ["email the newsletter to subscribers", "share it on social media", "launch it in the App Store"]) assert.equal((categoryOf(t) || {}).category, "publish", t);
  for (const t of ["launch the next lap", "a share button for social media", "keep the app store link"]) assert.equal(categoryOf(t), null, t);
  const p = pickOption({ heading: "h", body: "- **A.** Rewrite it all. Not recommended: too much.\n- **B.** Keep it." });
  assert.equal(p.how, "most reversible"); assert.equal(p.option.label, "b");
  assert.equal(pickOption({ heading: "h", body: "- **A.** Rewrite it all (not recommended).\n- **B.** Keep it." }).option.label, "b");
  assert.equal(pickOption({ heading: "h", body: "Options: (a) change who the app serves to teams; (b) change who the app serves to families." }), null);
}

testCase("a question the manager removed after honouring the decide helper's decision is still journaled as decided");
{
  const d = setup("rv3-gone-"); const g = github();
  issue(d, "### Status of #80 (#80)\nFor your information.\n");
  await run(env(d), T0, quiet, deps(g, channels()));
  const key = keyOf("Status of #80 (#80)");
  g.comments[80] = [{ body: `Manager decision (Mission Control, on Alex's standing instruction of 2026-11-24): nothing to change.\n<!-- factory-question:${idOf(key)} -->` }];
  issue(d, "no questions left");
  await run(env(d), T0 + 5 * MIN, quiet, deps(g, channels()));
  const s = JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8"));
  assert.ok(!s.routed[key] && s.decided[key]); assert.ok(fs.readFileSync(path.join(d, "journal.jsonl"), "utf8").includes("nothing to change."));
  // the same words about another item are a new question (the key leaves numbers out), and one withdrawn with no
  // decision simply leaves
  issue(d, "### Status of #81 (#81)\nFor your information.\n");
  const r81 = await run(env(d), T0 + 10 * MIN, quiet, deps(g, channels()));
  assert.deepEqual(r81.routed, ["Status of #81 (#81)"], "not taken for the earlier, decided question");
  issue(d, "no questions left");
  await run(env(d), T0 + 15 * MIN, quiet, deps(g, channels()));
  const s2 = JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8"));
  assert.ok(!s2.routed[keyOf("Status of #81 (#81)")] && !s2.decided[keyOf("Status of #81 (#81)")]);
}

testCase("a two-hour message Telegram took while the journal could not be written is written down, with its receipt, on a later round");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rv3-alarm-"));
  const jdir = path.join(tmp, "s", "journal.jsonl"); fs.mkdirSync(jdir, { recursive: true });
  const settings = { owner: { github_login: "boss", name: "Alex" }, server: { factory_user: "b", factory_home: "/h", state_dir: path.join(tmp, "s"), questions_dir: path.join(tmp, "q") }, steps: { questions: { godspeed_dir: tmp, hermes_home: tmp } } };
  const sent = [];
  const ctx = at => ({ settings, main: { repository: "acme/app" }, projects: [{ repository: "acme/app" }], env: {}, stateDir: path.join(tmp, "s", "steps", "question-check"), now: T0 + at,
    accountantDeps: { ownerIssue: () => ({ number: 7, body: "### Nobody has it\nx\n", url: "u" }), comments: () => [], telegram: async t => { sent.push(t); return { ok: true, receipt: "77" }; } } });
  await check.run(ctx(0)); await check.run(ctx(121 * MIN));
  assert.equal(sent.length, 1);
  fs.rmdirSync(jdir);
  await check.run(ctx(126 * MIN));
  assert.equal(sent.length, 1, "never sent twice");
  const j = fs.readFileSync(jdir, "utf8");
  assert.ok(j.includes('"t":"notice"') && j.includes('"telegram":"77"'), "in the journal with its receipt");
}
