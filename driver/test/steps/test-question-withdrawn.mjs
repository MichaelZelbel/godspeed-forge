// node --disable-warning=ExperimentalWarning driver/test/steps/test-question-withdrawn.mjs
// test cases: 5
// Issue #166: a page ends once someone who may decide has decided its question on GitHub, while the heading is still in
// the questions issue. On 2026-11-24 a Manager decision from the factory's own login named the OpenRouter key question
// at 18:25 UTC, and the step still escalated at 18:50 and kept the urgent issue open until the heading was removed.
import { testCase } from "../../../test/cases.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { run, keyOf, idOf, WORDING_TRIES } from "../../steps/questions/factory-owner-questions.mjs";
import { envFor } from "../../steps/questions.mjs";

const MIN = 60000, T0 = Date.parse("2026-11-24T18:00:00Z");
const fwd = p => p.replace(/\\/g, "/");
const BUILDER = "acme-builder[bot]", OWNER = "boss";
const TITLE = "Raise or replace the scenarios' OpenRouter key (monthly limit reached)";
const KEY = keyOf(TITLE);
const PAY = "Options: (a) pay for the bigger plan; (b) wait. Recommendation: (a).";
const setup = name => { const d = fs.mkdtempSync(path.join(os.tmpdir(), name)); fs.writeFileSync(path.join(d, "messages.json"), "[]"); return d; };
const issue = (d, body) => fs.writeFileSync(path.join(d, "issues.json"), JSON.stringify([{ title: "Owner decisions needed", state: "open", number: 7, updated_at: "1", html_url: "https://github.com/acme/app/issues/7", body }]));
// GitHub in memory, with the login of each comment as REST gives it
const github = () => {
  const g = { comments: {}, unreadable: new Set(), posts: [] };
  g.post = (repo, n, body) => { g.posts.push({ n, body }); (g.comments[n] ||= []).push({ body, user: { login: BUILDER } }); return { id: g.posts.length }; };
  g.read = (repo, n) => { if (g.unreadable.has(n)) throw new Error("HTTP 502"); return g.comments[n] || []; };
  g.say = (n, login, body) => (g.comments[n] ||= []).push({ id: 1000 + n, body, user: { login }, html_url: `https://github.com/acme/app/issues/${n}#issuecomment-${1000 + n}` });
  return g;
};
// Telegram, email and the urgent issue, in memory, each with a receipt
const channels = () => {
  const c = { tg: [], mails: [], issues: [], closed: [], n: 0, tgDown: false };
  c.api = { telegram: async t => { if (c.tgDown) return { ok: false, why: "telegram http 502" }; c.tg.push(t); return { ok: true, receipt: String(++c.n) }; },
    email: async m => { c.mails.push(m); return { ok: true, receipt: `mail-${++c.n}` }; }, emailReplies: async () => [],
    openIssue: async m => { c.issues.push(m); return { ok: true, receipt: `https://github.com/acme/watch/issues/${++c.n}` }; },
    closeIssue: async url => { c.closed.push(url); return true; }, issueComments: async () => [] };
  return c;
};
const env = (d, extra = {}) => ({ REPO: "acme/app", FORGE_USER: "x", FORGE_HOME: "/h", OWNER_NAME: "Alex", GODSPEED_DIR: d, STATE: path.join(d, "state.json"), JOURNAL: path.join(d, "journal.jsonl"),
  OQ_ISSUES_FILE: path.join(d, "issues.json"), OQ_MESSAGES_FILE: path.join(d, "messages.json"), OQ_MODEL_CMD: "exit 1", TRUSTED_LOGINS: [OWNER, BUILDER, "acme-release[bot]"], ...extra });
const deps = (g, c) => ({ channels: c.api, postComment: g.post, readComments: g.read, removeLabel: () => {} });
const quiet = () => {};
const stateOf = d => JSON.parse(fs.readFileSync(path.join(d, "state.json"), "utf8"));
const decision = key => `Manager decision (Mission Control, on Alex's standing instruction of 2026-11-24) on the question "${TITLE}": nothing to raise, the key still has money left.\nThis decides the factory question "${TITLE}".\n<!-- factory-question:${idOf(key)} -->`;
// the page as it stood at 18:50 on 2026-11-24: Telegram sent (the fixed message after the wordings failed), then email and the urgent issue
async function openPage(d, g, c, e = env(d)) {
  for (let i = 0; i < WORDING_TRIES; i++) await run(e, T0 + i * 5 * MIN, quiet, deps(g, c));
  assert.equal(c.tg.length, 1, "paged on Telegram");
  await run(e, T0 + 20 * MIN, quiet, deps(g, c));
  assert.equal(c.mails.length, 1); assert.equal(c.issues.length, 1, "the 10-minute step: email and the urgent issue");
  return stateOf(d).told[KEY].page.stages[1].channels.issue.receipt;
}

testCase("an open page whose question a trusted Manager decision names ends at once, with the heading still in the issue: no more sends, the urgent issue closed, the owner told once");
{
  const d = setup("wd-open-"); const g = github(); const c = channels();
  issue(d, `### ${TITLE}\nThe key's monthly limit is reached.\n${PAY}\n`);
  const urgent = await openPage(d, g, c);
  g.say(7, BUILDER, decision(KEY)); // 18:25 UTC: the factory's own login names it by title and by marker
  await run(env(d), T0 + 25 * MIN, quiet, deps(g, c));
  assert.deepEqual(c.closed, [urgent], "the urgent issue closes");
  const t = stateOf(d).told[KEY];
  assert.equal(t.page.closed.why, "withdrawn"); assert.ok(!t.answered, "not his answer");
  assert.equal(t.page.closed.decision, "https://github.com/acme/app/issues/7#issuecomment-1007");
  assert.equal(c.tg.length, 2, "one message to the owner");
  assert.equal(c.tg[1], `Question "f1" no longer needs your answer: it was already decided, so you can leave it. The decision is here: https://github.com/acme/app/issues/7#issuecomment-1007`);
  for (const at of [70, 75, 6 * 60]) await run(env(d), T0 + at * MIN, quiet, deps(g, c)); // the 60-minute step and a 4-hour one would be due
  assert.equal(c.tg.length, 2, "told once, and nothing more on Telegram"); assert.equal(c.mails.length, 1, "no more email"); assert.equal(c.issues.length, 1);
  assert.deepEqual(c.closed, [urgent], "closed once");
  assert.ok(fs.readFileSync(path.join(d, "journal.jsonl"), "utf8").includes('"t":"page closed"'), "in the driver's journal");
}

testCase("a question that pages but is already decided on GitHub, by the owner's own words on its item, is never paged and costs no model call");
{
  const d = setup("wd-new-"); const g = github(); const c = channels();
  const title = "Raise the key's monthly limit (#88)";
  issue(d, `### ${title}\n${PAY}\n`);
  g.say(88, OWNER, `Owner decision: leave it, the key still has money. ${title}`); // by title, no marker
  const calls = path.join(d, "model-calls.log");
  const e = env(d, { OQ_MODEL_CMD: `echo called >> "${fwd(calls)}"; exit 1` });
  for (let i = 0; i <= WORDING_TRIES + 1; i++) { const r = await run(e, T0 + i * 5 * MIN, quiet, deps(g, c)); assert.deepEqual(r.paged, []); }
  assert.equal(c.tg.length + c.mails.length + c.issues.length, 0, "nothing reaches him");
  assert.equal(stateOf(d).told[keyOf(title)], undefined, "no page was started");
  assert.ok(!fs.existsSync(calls), "no model call words a page that will not go out");
  assert.deepEqual(g.posts, [], "and nothing is decided for him on top of it");
}

testCase("a decision from a login that may not decide, or a comment list that cannot be read, changes nothing: the page starts and goes on");
{
  const d = setup("wd-stranger-"); const g = github(); const c = channels();
  const other = "Buy more credits (#90)";
  issue(d, `### ${TITLE}\n${PAY}\n\n### ${other}\n${PAY}\n`);
  g.say(90, "someone", `Owner decision: no. ${other}\n<!-- factory-question:${idOf(keyOf(other))} -->`); // before it is ever paged
  for (let i = 0; i < WORDING_TRIES; i++) await run(env(d), T0 + i * 5 * MIN, quiet, deps(g, c));
  assert.equal(c.tg.length, 2, "both paged: a stranger's decision does not keep a page from starting");
  await run(env(d), T0 + 20 * MIN, quiet, deps(g, c));
  g.say(7, "someone", decision(KEY));
  await run(env(d), T0 + 25 * MIN, quiet, deps(g, c));
  assert.deepEqual(c.closed, [], "a stranger's decision does not end it");
  await run(env(d), T0 + 70 * MIN, quiet, deps(g, c));
  assert.equal(c.tg.filter(t => t.startsWith('Question "f1"\n')).length, 2, "the 60-minute step went out");
  assert.ok(!c.tg.some(t => t.includes("no longer needs")), "and nothing says it is no longer needed");
  // an item whose comments cannot be read proves nothing
  const d2 = setup("wd-unread-"); const g2 = github(); const c2 = channels();
  issue(d2, `### Raise the key's monthly limit (#88)\n${PAY}\n`);
  g2.unreadable.add(88);
  for (let i = 0; i < WORDING_TRIES; i++) await run(env(d2), T0 + i * 5 * MIN, quiet, deps(g2, c2));
  assert.equal(c2.tg.length, 1, "paged");
  // who may decide comes from the settings, per project: the owner and the project's own Apps
  const settings = { owner: { github_login: OWNER, name: "Alex" }, server: { factory_user: "b", factory_home: "/h", state_dir: d }, steps: { questions: { godspeed_dir: d, hermes_home: d } } };
  const main = { repository: "acme/app", apps: { builder: "acme-builder", release: "acme-release" } }, side = { repository: "acme/side", apps: { builder: "side-builder" } };
  assert.deepEqual(envFor({ settings, main, projects: [main, side] }).PROJECTS.map(p => p.trusted), [[OWNER, BUILDER, "acme-release[bot]"], [OWNER, "side-builder[bot]"]]);
}

testCase("the message that a page is no longer needed is tried again until Telegram takes it, then never again; a page closed before this version says nothing");
{
  const d = setup("wd-retry-"); const g = github(); const c = channels();
  issue(d, `### ${TITLE}\n${PAY}\n`);
  await openPage(d, g, c);
  const s = stateOf(d); // a page that ended as withdrawn before this version
  s.told["an older question"] = { at: "2026-11-24T10:00:00Z", heading: "An older question", handle: "older", page: { stages: [{ n: 0, at: 1, channels: { telegram: { at: 1, receipt: "5" } } }], closed: { at: "2026-11-24T11:00:00Z", why: "withdrawn" } } };
  fs.writeFileSync(path.join(d, "state.json"), JSON.stringify(s));
  g.say(7, BUILDER, decision(KEY));
  c.tgDown = true;
  await run(env(d), T0 + 25 * MIN, quiet, deps(g, c));
  assert.equal(stateOf(d).told[KEY].page.closed.why, "withdrawn", "the page ends whether or not the message goes out");
  c.tgDown = false;
  await run(env(d), T0 + 30 * MIN, quiet, deps(g, c));
  await run(env(d), T0 + 35 * MIN, quiet, deps(g, c));
  assert.deepEqual(c.tg.slice(1).map(t => t.split(":")[0]), ['Question "f1" no longer needs your answer'], "sent once it could be, and once only; nothing about the older page");
  assert.equal(stateOf(d).told[KEY].page.closed.note.receipt, "4");
}

testCase("a page whose heading the manager removed tells the owner once too, in its own words");
{
  const d = setup("wd-gone-"); const g = github(); const c = channels();
  issue(d, `### ${TITLE}\n${PAY}\n`);
  await openPage(d, g, c);
  issue(d, "no questions left");
  await run(env(d), T0 + 25 * MIN, quiet, deps(g, c));
  await run(env(d), T0 + 70 * MIN, quiet, deps(g, c));
  assert.equal(c.closed.length, 1);
  assert.deepEqual(c.tg.slice(1), [`Question "f1" no longer needs your answer: the factory took it back, so you can leave it.`]);
}
