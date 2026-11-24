// node --disable-warning=ExperimentalWarning driver/test/steps/test-factory-owner-questions.mjs   (needs bash for the stubbed model)
// test cases: 25
import { testCase } from "../../../test/cases.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { genericProject, DEFAULT_OWNER, markerOf, plainWords, WORDING_TRIES, parseQuestions, pickIssue, berlinDeadline, checkWords, renderMessage, handleMatch, handleMeaning, keyOf, run, parseProjects, systemFor, stateFileOf, handleSplit, notUnderstood, idOf, RETIRED_QUEUE, decisionMarker, STATE_VERSION } from "../../steps/questions/factory-owner-questions.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// the two projects of the first owner's factory, as a project file's "questions" key brings them (test data)
const PRODUCT = { repo: "MichaelZelbel/godspeed-mission-control", label: "Godspeed", name: "Godspeed", main: true,
  product: "Godspeed, a personal AI assistant program that people install",
  seat: "as a person who writes to Godspeed and reads Godspeed's replies. Godspeed is the one replying.",
  example: "When you write to Godspeed in English and its answer is very short, like 'All right', it sometimes sends you 'I could not translate this' instead of the answer." };
const FORGE = { repo: "MichaelZelbel/godspeed-forge", label: "the Forge add-on", name: "the Forge",
  product: "the Forge, an add-on for Godspeed (a personal AI assistant program): a person who has Godspeed and a software project on GitHub plans a release in one sentence, an AI software factory builds it, the release lands on a test copy, and the person's go makes it public",
  seat: "as a person who tells Godspeed which release of their own software to plan, answers its questions, and reads what it reports about the build. The Forge, speaking through Godspeed, is the one reporting.",
  example: "When you say 'go' to make a finished release public, it sometimes tells you the release is public before your test copy was ever checked." };

// A question whose recommended answer would spend money: the only kind (with publishing and deleting people's data)
// that pages the owner. Every other question is decided at once.
const PAY = "Options: (a) pay for the bigger plan; (b) wait. Recommendation: (a).";

testCase("pure parts: every ### heading is a question, numbered or not, and a numbered one keeps its old key");
const body = `intro\n\n### 1. Key is out (#522)\nbody one\n- Default: by 2026-11-15 19:15 UTC.\n\n### 2. Second thing\nbody two\n\n\n### A note without a number\nnow a question too\n## Earlier passes\nnot a question\n#### a sub heading stays inside`;
const qs = parseQuestions(body);
assert.deepEqual(qs.map(q => [q.number, q.heading]), [[1, "Key is out (#522)"], [2, "Second thing"], [3, "A note without a number"]]);
assert.equal(qs[0].key, keyOf("Key is out (#522)"), "the key is the title without its number, as before");
assert.ok(!qs[2].body.includes("not a question"), "a ## heading ends a question");
assert.deepEqual(parseQuestions("### Unnumbered first\nx\n### 1. Numbered\ny").map(q => q.number), [2, 1], "an unnumbered question never takes a number the manager used");
assert.equal(berlinDeadline("asked 2026-11-10 09:00 UTC; by 2026-11-15 19:15 UTC"), "Sunday 15 November, 20:15 Berlin time");
assert.equal(pickIssue([{ title: "Owner decisions needed", state: "closed" }, { title: "x" }, { title: "Owner decisions needed", state: "open", number: 9, updated_at: "2" }, { title: "Owner decisions needed", state: "open", number: 8, updated_at: "1" }]).number, 9);
assert.equal(keyOf("Should we ship it? (#5)"), keyOf("should we  ship it"));
const good = { route: "owner", handle: "sync", about: "Syncing with a settings conflict", experience: "When you edit a setting on two computers, syncing stops for everything.", options: ["Keep stopping everything until you decide.", "Only hold back the one setting."], recommended: 2, reason: "Your notes should never get stuck.", if_nothing: "Nothing changes until you decide." };
assert.equal(checkWords(good), "");
assert.ok(checkWords({ ...good, experience: "The holdout check fails." }).length > 0, "must start with a person's experience");
assert.ok(checkWords({ ...good, options: ["Merge the scenarios (PR #5).", "b"] }).startsWith("jargon"));
const msg = renderMessage(good, "sync", "https://github.com/o/r/issues/7");
assert.ok(msg.startsWith('Question "sync"') && msg.includes('"sync: yes"') && msg.includes('"sync: no"') && msg.includes("issues/7") && !msg.includes("—"));
const cands = [{ key: "a", number: 3 }, { key: "b", number: 4 }];
const st = { told: { a: { handle: "sync", options: good.options, recommended: 2 }, b: { handle: "short replies", options: ["x.", "y."], recommended: 1 } } };
assert.equal(handleMatch("Sync: yes", cands, st).q.number, 3);
assert.equal(handleMatch("short   replies - no thanks, do it differently", cands, st).q.number, 4);
assert.equal(handleMatch("sync the files please", cands, st), null, "a sentence that starts with the word is not an answer");
assert.ok(handleMeaning("yes", st.told.a).includes("recommendation, choice 2: Only hold back"));
assert.ok(handleMeaning("No.", st.told.a).includes("choice 1: Keep stopping"));
assert.equal(handleMeaning("keep it but ask me first", st.told.a), null, "handled free text goes through the decision classifier");

testCase("today's issues: Godspeed's 26 unnumbered questions and the second project's 4 numbered ones are all read");
{
  const fx = f => JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "questions-2026-11-24", f), "utf8")).body;
  assert.equal(parseQuestions(fx("godspeed-531.json")).length, 26, "the numbered-only reading of before found none of these");
  assert.deepEqual(parseQuestions(fx("cherishly-31.json")).map(q => q.number), [7, 8, 9, 10]);
}

// ---- runs with a stubbed model and stubbed channels
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oq-"));
const stub = path.join(dir, "stub.mjs");
fs.writeFileSync(stub, `let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{const i=JSON.parse(t);let out;
if(i.system.includes("Telegram message")){const m=/<message>\\n([\\s\\S]*?)\\n<\\/message>/.exec(i.prompt)[1];if(m.includes("BROKEN"))process.exit(1);
 out={answers:[...(m.includes("first")?[{question:1,meaning:"Do the first thing."}]:[]),...(m.includes("second")?[{question:2,meaning:"Choose option b."}]:[])]};}
else if(i.system.includes("finished message")){out={decides:"Whether it stops everything or one setting.",changes_for_user:"What happens to your notes when settings clash.",plain:!/plainfail/i.test(i.prompt),problem:"invented names"};}
else if(i.system.includes("check one example"))out={ok:!i.prompt.includes("BADEXAMPLE")};
else if(i.prompt.includes("NOMODEL"))process.exit(1);
else{out=${JSON.stringify(good)};out.handle=(/<question>\\n([A-Za-z]+)/.exec(i.prompt)[1]).toLowerCase();}
console.log(JSON.stringify({text:JSON.stringify(out)}));});`);
const setup = name => { const d = fs.mkdtempSync(path.join(os.tmpdir(), name)); fs.mkdirSync(path.join(d, "g", ".godspeed"), { recursive: true }); fs.writeFileSync(path.join(d, "comments.json"), "[]"); fs.writeFileSync(path.join(d, "messages.json"), "[]"); return d; };
const fwd = p => p.replace(/\\/g, "/");
const mkEnv = (d, extra = {}) => ({ REPO: "o/r", FORGE_USER: "x", FORGE_HOME: "/h/x", OWNER_NAME: "Michael", GODSPEED_DIR: path.join(d, "g"), STATE: path.join(d, "state.json"), JOURNAL: path.join(d, "journal.jsonl"), OQ_ISSUES_FILE: path.join(d, "issues.json"), OQ_MODEL_CMD: `node "${fwd(stub)}"`, OQ_MESSAGES_FILE: path.join(d, "messages.json"), OQ_COMMENTS_FILE: path.join(d, "comments.json"), OQ_POST_CMD: `cat >> "${fwd(path.join(d, "posts.log"))}"; echo '{"id":99}'`, OQ_LABEL_CMD: `cat >> "${fwd(path.join(d, "labels.log"))}"`, ...extra });
const issue = (d, b, labels = []) => fs.writeFileSync(path.join(d, "issues.json"), JSON.stringify([{ title: "Owner decisions needed", state: "open", number: 7, updated_at: "1", html_url: "https://github.com/o/r/issues/7", body: b, labels }]));
const postsOf = d => { try { return fs.readFileSync(path.join(d, "posts.log"), "utf8").split(/(?=\{"repo")/).filter(Boolean).map(s => JSON.parse(s)); } catch { return []; } };
const posts = d => postsOf(d).length;
const labelsOf = d => { try { return fs.readFileSync(path.join(d, "labels.log"), "utf8").split(/(?=\{"repo")/).filter(Boolean).map(s => JSON.parse(s).number); } catch { return []; } };
const journalOf = d => { try { return fs.readFileSync(path.join(d, "journal.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const stateOf = (d, f = "state.json") => JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
// the channels a page uses, in memory: every Telegram message, email and urgent issue, with a receipt each
const channels = () => {
  const c = { tg: [], mails: [], issues: [], closed: [], replies: [], comments: {}, n: 100 };
  c.api = { telegram: async t => { c.tg.push(t); return { ok: true, receipt: String(++c.n) }; }, email: async m => { c.mails.push(m); return { ok: true, receipt: `mail-${++c.n}` }; },
    emailReplies: async () => c.replies, openIssue: async m => { c.issues.push(m); return { ok: true, receipt: `https://github.com/o/w/issues/${++c.n}` }; },
    closeIssue: async url => { c.closed.push(url); return true; }, issueComments: async url => c.comments[url] || [] };
  return c;
};
const quiet = () => {};
const T0 = Date.now(); const ts = s => (T0 + s * 1000) / 1000;
const MIN = 60000;

testCase("a question with a recommendation is decided at once, signed under the standing instruction, never asked");
{
  const d = setup("oq-dec-"); const c = channels();
  issue(d, `### Move the card (#12)\nThe card sits low.\nOptions: (a) keep it; (b) move it up. Recommendation: (b). Default after 2026-11-25 10:00 UTC: wait.\n\n### Pick a colour (#13)\nOptions: (a) red; (b) blue. Recommendation: (b).\n`);
  const r = await run(mkEnv(d), T0, quiet, { channels: c.api });
  assert.deepEqual(r.decided, ["Move the card (#12)", "Pick a colour (#13)"]); assert.deepEqual(r.paged, []);
  assert.equal(c.tg.length, 0, "nothing reaches him");
  const p = postsOf(d);
  assert.deepEqual(p.map(x => x.number), [12, 13], "on the item the question names");
  assert.ok(p[0].body.startsWith(`Manager decision (Mission Control, on Michael's standing instruction of 2026-11-24) on the question "Move the card" (https://github.com/o/r/issues/7): option (b): move it up.`));
  assert.ok(p[0].body.includes(decisionMarker(keyOf("Move the card (#12)"))) && !/owner decision/i.test(p[0].body), "never headed Owner decision");
  assert.deepEqual(labelsOf(d).sort(), [12, 13], "needs-owner comes off: the question was the item's only park");
  const j = journalOf(d).filter(e => e.t === "decision");
  assert.deepEqual(j.map(e => [e.question, e.how, e.choice]), [["Move the card (#12)", "recommended", "option (b): move it up"], ["Pick a colour (#13)", "recommended", "option (b): blue"]]);
  const again = await run(mkEnv(d), T0 + 5 * MIN, quiet, { channels: c.api });
  assert.equal(again.decided.length, 0); assert.equal(posts(d), 2, "never decided twice");
}

testCase("a decision already on the item (the step's state was lost) is not posted again; a question without an item is decided on the owner issue");
{
  const d = setup("oq-lost-"); const c = channels();
  issue(d, "### Move the card (#12)\nOptions: (a) keep it; (b) move it up. Recommendation: (b).\n\n### A general question\nOptions: (a) keep it; (b) change it. Recommendation: (a).\n");
  fs.writeFileSync(path.join(d, "comments.json"), JSON.stringify([{ body: `Manager decision (Mission Control, on Michael's standing instruction of 2026-11-24) on the question "Move the card": option (b).\n${decisionMarker(keyOf("Move the card (#12)"))}` }]));
  await run(mkEnv(d), T0, quiet, { channels: c.api });
  assert.deepEqual(postsOf(d).map(x => x.number), [7], "only the new one, on the owner issue itself");
  assert.ok(stateOf(d).decided[keyOf("Move the card (#12)")], "taken as decided");
  assert.ok(!labelsOf(d).includes(7), "the owner issue keeps its labels");
}

testCase("needs-owner stays while another open question holds the same item, and comes off once that one is decided too");
{
  const d = setup("oq-park-"); const c = channels();
  issue(d, `### Move the card (#12)\nOptions: (a) keep it; (b) move it up. Recommendation: (b).\n\n### Status of #12 (#12)\nFor your information.\n`);
  const r = await run(mkEnv(d), T0, quiet, { channels: c.api });
  assert.deepEqual(r.routed, ["Status of #12 (#12)"], "nothing to pick from: the driver's decide helper");
  assert.deepEqual(labelsOf(d), [], "#12 is still held by the other question");
  const routed = stateOf(d).routed[keyOf("Status of #12 (#12)")];
  assert.ok(routed.mc && routed.repo === "o/r" && routed.issue === 12 && routed.link === "https://github.com/o/r/issues/7" && routed.body.includes("For your information"), "everything the driver needs to decide it");
  // the decide helper's decision lands on #12, naming the question
  fs.writeFileSync(path.join(d, "comments.json"), JSON.stringify([{ body: `Manager decision (Mission Control, not Michael): nothing to decide.\nThis decides the factory question "Status of #12".\n<!-- factory-question:${idOf(keyOf("Status of #12 (#12)"))} -->` }]));
  await run(mkEnv(d), T0 + 5 * MIN, quiet, { channels: c.api });
  assert.ok(!stateOf(d).routed[keyOf("Status of #12 (#12)")] && stateOf(d).decided[keyOf("Status of #12 (#12)")], "off the driver's list once decided");
  assert.deepEqual(labelsOf(d), [12], "and the item is free");
}

testCase("a page: a question whose answer would spend money goes to Telegram with a receipt, then email and the urgent issue, then again");
{
  const d = setup("oq-page-"); const c = channels();
  issue(d, `### Budget for the scenario key\nThe key is out.\n${PAY}\n`);
  const r = await run(mkEnv(d), T0, quiet, { channels: c.api });
  assert.deepEqual(r.paged, ["Budget for the scenario key"]); assert.equal(posts(d), 0, "nothing is decided for him");
  assert.equal(c.tg.length, 1); assert.ok(c.tg[0].startsWith('Question "budget"') && c.tg[0].includes("https://github.com/o/r/issues/7"));
  const t = stateOf(d).told[keyOf("Budget for the scenario key")];
  assert.equal(t.crucial, "money"); assert.equal(t.page.stages[0].channels.telegram.receipt, "101", "Telegram's message_id is the receipt");
  await run(mkEnv(d), T0 + 5 * MIN, quiet, { channels: c.api });
  assert.equal(c.tg.length + c.mails.length + c.issues.length, 1, "nothing more before 10 minutes");
  await run(mkEnv(d), T0 + 10 * MIN, quiet, { channels: c.api });
  assert.equal(c.mails.length, 1); assert.equal(c.issues.length, 1);
  assert.match(c.mails[0].subject, /^Your factory needs your answer: Budget for the scenario key \[q:[0-9a-f]{10}\]$/);
  assert.equal(c.issues[0].title, "Budget for the scenario key"); assert.ok(c.issues[0].body.includes('Question "budget"'));
  await run(mkEnv(d), T0 + 60 * MIN, quiet, { channels: c.api });
  assert.equal(c.tg.length, 2); assert.equal(c.mails.length, 2); assert.equal(c.issues.length, 1, "one urgent issue per page");
  await run(mkEnv(d), T0 + 120 * MIN, quiet, { channels: c.api });
  assert.equal(c.tg.length, 2, "then only every 4 hours");
  assert.ok(journalOf(d).some(e => e.t === "page" && e.tried.some(x => x.channel === "issue" && x.ok)), "every page send is in the driver's journal");
}

testCase("his Telegram answer by handle is relayed as an Owner decision and ends the page: its urgent issue closes");
{
  const d = setup("oq-ack-"); const c = channels();
  issue(d, `### Budget for the scenario key\n${PAY}\n`);
  await run(mkEnv(d), T0, quiet, { channels: c.api });
  await run(mkEnv(d), T0 + 10 * MIN, quiet, { channels: c.api });
  fs.writeFileSync(path.join(d, "messages.json"), JSON.stringify([{ id: 2, ts: ts(700), text: "budget: yes" }]));
  await run(mkEnv(d), T0 + 15 * MIN, quiet, { channels: c.api });
  const p = postsOf(d);
  assert.equal(p.length, 1); assert.ok(p[0].body.startsWith("Owner decision (question 1: Budget for the scenario key)") && p[0].body.includes("> budget: yes"));
  assert.deepEqual(c.closed, [c.issues.length ? "https://github.com/o/w/issues/103" : ""].filter(Boolean), "the urgent issue closes the moment he answers");
  const before = c.tg.length + c.mails.length;
  await run(mkEnv(d), T0 + 120 * MIN, quiet, { channels: c.api });
  assert.equal(c.tg.length + c.mails.length, before, "an answered page sends nothing more");
}

testCase("an answer by email, or a comment on the urgent issue, counts as much as Telegram, verbatim");
{
  const d = setup("oq-mail-"); const c = channels();
  issue(d, `### Budget for the scenario key\n${PAY}\n\n### Buy more credits\n${PAY}\n`);
  await run(mkEnv(d), T0, quiet, { channels: c.api });
  await run(mkEnv(d), T0 + 10 * MIN, quiet, { channels: c.api });
  const ref = /\[q:([0-9a-f]{10})\]/.exec(c.mails[0].subject)[1];
  c.replies = [{ id: "e1", at: T0 + 11 * MIN, subject: `Re: x [q:${ref}]`, text: "2\nRegards" }];
  const buyIssue = stateOf(d).told[keyOf("Buy more credits")].page.stages[1].channels.issue.receipt;
  c.comments[buyIssue] = [{ id: "c1", at: T0 + 12 * MIN, text: "buy: let us wait a month" }];
  await run(mkEnv(d), T0 + 13 * MIN, quiet, { channels: c.api });
  const p = postsOf(d);
  assert.equal(p.length, 2);
  assert.ok(p.some(x => x.body.includes("> 2\n> Regards") && x.body.includes("sent by email") && x.body.includes("choice 2")));
  assert.ok(p.some(x => x.body.includes("> buy: let us wait a month") && x.body.includes("written on the urgent issue")));
  assert.equal(c.closed.length, 2, "both pages end");
}

testCase("a withdrawn question ends its page and closes its urgent issue; nothing is sent for it again");
{
  const d = setup("oq-gone-"); const c = channels();
  issue(d, `### Budget for the scenario key\n${PAY}\n`);
  await run(mkEnv(d), T0, quiet, { channels: c.api });
  await run(mkEnv(d), T0 + 10 * MIN, quiet, { channels: c.api });
  issue(d, "no questions left");
  await run(mkEnv(d), T0 + 15 * MIN, quiet, { channels: c.api });
  assert.equal(c.closed.length, 1);
  assert.equal(stateOf(d).told[keyOf("Budget for the scenario key")].page.closed.why, "withdrawn");
}

testCase("the model words a page badly three runs in a row: the fixed plain message goes out, with the choices and how to answer");
{
  const d = setup("oq-tpl-"); const c = channels();
  issue(d, `### 4. NOMODEL budget\nThe key is out.\nOptions: (a) raise the key's monthly limit; (b) wait until it resets. Recommendation: (a).\n`);
  for (let i = 0; i < WORDING_TRIES - 1; i++) { await run(mkEnv(d), T0 + i * 5 * MIN, quiet, { channels: c.api }); assert.equal(c.tg.length, 0); }
  await run(mkEnv(d), T0 + 10 * MIN, quiet, { channels: c.api });
  assert.equal(c.tg.length, 1);
  assert.equal(c.tg[0], `Question "f4"\n\nNOMODEL budget\n\nThe choice:\n1. raise the key's monthly limit.\n2. wait until it resets.\n\nThe factory's manager recommends choice 1: raise the key's monthly limit.\n\nThis one needs you because it would spend money or raise a spending limit, subscription or paid plan. Nothing else in the factory waits for it.\n\nTo answer, reply "f4: 1" or "f4: 2" for that choice, or "f4:" and what you want in your own words.\n\nAll the detail is here: https://github.com/o/r/issues/7`);
  fs.writeFileSync(path.join(d, "messages.json"), JSON.stringify([{ id: 3, ts: ts(900), text: "f4: 2" }]));
  await run(mkEnv(d), T0 + 15 * MIN, quiet, { channels: c.api });
  assert.ok(postsOf(d)[0].body.includes("He chose choice 2: wait until it resets"), "the template's choices are what his number means");
}

testCase("his answers: by handle first, then by the model; a dry run posts and sends nothing; never posted twice");
{
  const d = setup("oq-ans-"); const c = channels();
  issue(d, `### 1. Sync problem\n${PAY}\n\n### 2. Short replies\n${PAY}\n`);
  await run(mkEnv(d), T0, quiet, { channels: c.api });
  fs.writeFileSync(path.join(d, "messages.json"), JSON.stringify([{ id: 1, ts: ts(60), text: "hello, how are you" }, { id: 2, ts: ts(120), text: "sync: yes" }, { id: 3, ts: ts(180), text: "go with b for the second" }]));
  const tg = c.tg.length;
  await run(mkEnv(d, { DRY: true }), T0 + 600e3, quiet, { channels: c.api });
  assert.equal(posts(d), 0); assert.equal(c.tg.length, tg, "a dry run sends nothing");
  await run(mkEnv(d), T0 + 600e3, quiet, { channels: c.api });
  assert.equal(posts(d), 2);
  const log = postsOf(d).map(p => p.body).join("\n");
  assert.ok(log.includes("> sync: yes") && log.includes("question 1: Sync problem") && log.includes("recommendation, choice 2") && log.includes("question 2: Short replies"));
  await run(mkEnv(d), T0 + 900e3, quiet, { channels: c.api });
  assert.equal(posts(d), 2, "never posted twice");
}

testCase("a handle reply a week later is still relayed; a late free-text message is not guessed at");
{
  const d = setup("oq-late-"); const c = channels();
  issue(d, `### 1. Sync problem\n${PAY}\n`);
  await run(mkEnv(d), T0, quiet, { channels: c.api });
  fs.writeFileSync(path.join(d, "messages.json"), JSON.stringify([{ id: 5, ts: ts(7 * 86400), text: "sync: no" }, { id: 6, ts: ts(7 * 86400 + 5), text: "I think the first thing is fine" }]));
  await run(mkEnv(d), T0 + 7 * 86400e3 + 60e3, quiet, { channels: c.api });
  assert.equal(posts(d), 1);
}

testCase("a message the model never reads is skipped after a few tries, later ones still go through");
{
  const d = setup("oq-broken-"); const c = channels();
  issue(d, `### 1. First thing\n${PAY}\n### 2. Second thing\n${PAY}\n`);
  await run(mkEnv(d), T0, quiet, { channels: c.api });
  fs.writeFileSync(path.join(d, "messages.json"), JSON.stringify([{ id: 11, ts: ts(60), text: "BROKEN first" }, { id: 12, ts: ts(70), text: "second one: b" }]));
  for (let i = 0; i < 3; i++) { await run(mkEnv(d), T0 + 600e3, quiet, { channels: c.api }); assert.equal(posts(d), 0); }
  await run(mkEnv(d), T0 + 600e3, quiet, { channels: c.api });
  assert.equal(posts(d), 1);
}

testCase("one message answering several pages: each handle line its own; 'no clue' is never relayed, it goes to the driver");
{
  const d = setup("oq-multi-"); const c = channels();
  issue(d, `### 3. Routines thing\n${PAY}\n\n### 4. Large files\n${PAY}\n\n### 5. Sync problem\n${PAY}\n`);
  await run(mkEnv(d), T0, quiet, { channels: c.api });
  assert.deepEqual(Object.values(stateOf(d).told).map(t => t.handle).sort(), ["large", "routines", "sync"]);
  fs.writeFileSync(path.join(d, "messages.json"), JSON.stringify([{ id: 21, ts: ts(60), text: "routines: I have no clue what you want from me, and your question doesn't make sense.\nlarge: yes\nand keep them on this computer\nsync: 1" }]));
  await run(mkEnv(d), T0 + 600e3, quiet, { channels: c.api });
  const p = postsOf(d);
  assert.equal(p.length, 2, "two decisions posted, the not-understood reply is not");
  assert.ok(p[0].body.includes("question 4: Large files") && p[0].body.includes("> large: yes\n> and keep them on this computer") && !p[0].body.includes("no clue"));
  assert.ok(p[1].body.includes("question 5: Sync problem") && p[1].body.includes("choice 1"));
  const rk = keyOf("Routines thing");
  assert.ok(stateOf(d).told[rk].answered.not_understood && stateOf(d).routed[rk].mc && /did not understand/.test(stateOf(d).routed[rk].why), "the driver's decide helper takes it, with what he wrote");
  assert.ok(/never spend|without spending money/i.test(stateOf(d).routed[rk].why), "and it may not spend money for him");
  assert.equal(handleSplit("thanks!\nsync: no", [{ key: "a", number: 1 }], { told: { a: { handle: "sync" } } })[0].words, "thanks!\nsync: no");
  assert.ok(notUnderstood("What do you mean?") && notUnderstood("this is unclear") && !notUnderstood("yes, do it"));
  const two = handleSplit("ok\nsync: no\nlarge: yes\nsync: and soon", [{ key: "a", number: 1 }, { key: "b", number: 2 }], { told: { a: { handle: "sync" }, b: { handle: "large" } } });
  assert.equal(two[0].words, "ok\nsync: no\nsync: and soon"); assert.equal(two[1].words, "large: yes");
  assert.equal(handleMatch("sync:\nyes", [{ key: "a", number: 1 }], { told: { a: { handle: "sync" } } }).rest, "yes");
}

testCase("a handled free-text reply waits at the retry cursor while the classifier is down, and posts once when it is back");
{
  const d = setup("oq-retry-"); const c = channels();
  issue(d, `### 1. Free choice\n${PAY}\n\n### 2. Large files\n${PAY}\n`);
  await run(mkEnv(d), T0, quiet, { channels: c.api });
  const s0 = stateOf(d); s0.told[keyOf("Free choice")].handle = "free"; s0.told[keyOf("Large files")].handle = "large"; fs.writeFileSync(path.join(d, "state.json"), JSON.stringify(s0));
  fs.writeFileSync(path.join(d, "messages.json"), JSON.stringify([{ id: 61, ts: ts(60), text: "free: choose the slower option because it is safer\nlarge: yes" }]));
  const flag = path.join(d, "once.flag"), st2 = path.join(d, "retry.mjs");
  fs.writeFileSync(st2, `import fs from "node:fs"; let input=""; process.stdin.on("data", c => input += c).on("end", () => { if (!fs.existsSync(${JSON.stringify(flag)})) { fs.writeFileSync(${JSON.stringify(flag)}, "once"); process.exit(1); } console.log(JSON.stringify({ text: JSON.stringify({ answers: [{ question: 1, meaning: "Choose the safer slower option." }] }) })); });`);
  const env = mkEnv(d, { OQ_MODEL_CMD: `node "${fwd(st2)}"` });
  await run(env, T0 + 600e3, quiet, { channels: c.api });
  assert.equal(posts(d), 1, "the explicit answer relays while the free text retries");
  assert.equal(stateOf(d).msg_tries[61], 1);
  await run(env, T0 + 700e3, quiet, { channels: c.api });
  assert.equal(posts(d), 2); assert.equal(stateOf(d).last_message_id, 61);
}

testCase("unreadable issue: nothing for a day, then a halt for the driver, never a message to him");
{
  const d = setup("oq-unread-"); const c = channels(); const t5 = Date.now();
  assert.equal((await run(mkEnv(d), t5, quiet, { channels: c.api })).halts.length, 0);
  const h = await run(mkEnv(d), t5 + 25 * 3600e3, quiet, { channels: c.api });
  assert.deepEqual(h.halts.map(x => x.key), ["unreadable"]); assert.match(h.halts[0].words, /could not be read for a whole day/);
  assert.equal(c.tg.length, 0, "a halt pages nobody");
}

testCase("the question list is missing while items wait for him: after a day it is a halt; it ends when the issue is back");
{
  const d = setup("oq-miss-"); const c = channels();
  fs.writeFileSync(path.join(d, "issues.json"), JSON.stringify([{ title: "Renamed", state: "open", labels: [{ name: "needs-owner" }] }]));
  assert.equal((await run(mkEnv(d), T0, quiet, { channels: c.api })).halts.length, 0);
  assert.deepEqual((await run(mkEnv(d), T0 + 25 * 3600e3, quiet, { channels: c.api })).halts.map(h => h.key), ["missing-issue"]);
  fs.writeFileSync(path.join(d, "issues.json"), JSON.stringify([{ title: "Owner decisions needed", state: "open", number: 1, updated_at: "1", html_url: "u", body: "no questions", labels: [{ name: "needs-owner" }] }]));
  assert.equal((await run(mkEnv(d), T0 + 26 * 3600e3, quiet, { channels: c.api })).halts.length, 0);
}

testCase("two projects: each decided on its own repository, pages unique across both, one reply cursor");
{
  assert.deepEqual(parseProjects(""), null);
  assert.equal(parseProjects('["o/thing"]')[0].label, "thing");
  assert.throws(() => parseProjects('["not a repo"]'));
  assert.throws(() => parseProjects(JSON.stringify([FORGE.repo, FORGE.repo.toUpperCase()])));
  assert.ok(systemFor(FORGE, "Michael").includes("The factory builds the Forge"));
  assert.ok(systemFor(genericProject("a/b")).includes("The owner, " + DEFAULT_OWNER + ", is not"));
  const P = PRODUCT.repo, F = FORGE.repo;
  const d = setup("oq-two-"); const c = channels();
  fs.writeFileSync(path.join(d, "issues.json"), JSON.stringify({
    [P]: [{ title: "Owner decisions needed", state: "open", number: 531, updated_at: "1", html_url: `https://github.com/${P}/issues/531`, body: `### Sync problem\n${PAY}\n\n### The card (#40)\nOptions: (a) keep; (b) move. Recommendation: (b).\n` }],
    [F]: [{ title: "Owner decisions needed", state: "open", number: 12, updated_at: "1", html_url: `https://github.com/${F}/issues/12`, body: `### 1. Sync problem\n${PAY}\n` }] }));
  fs.writeFileSync(path.join(d, "comments.json"), JSON.stringify({ [P]: [], [F]: [] }));
  const envM = (extra = {}) => mkEnv(d, { REPO: undefined, PROJECTS: [PRODUCT, FORGE], ...extra });
  const r = await run(envM(), T0, quiet, { channels: c.api });
  assert.deepEqual(r.paged, ["For Godspeed: Sync problem", "For the Forge add-on: Sync problem"]); assert.deepEqual(r.decided, ["For Godspeed: The card (#40)"]);
  assert.ok(c.tg[0].startsWith('Question "sync"\n\nFor Godspeed: When you') && c.tg[1].startsWith('Question "sync 2"\n\nFor the Forge add-on: When you'));
  assert.deepEqual(postsOf(d).map(p => [p.repo, p.number]), [[P, 40]]);
  assert.ok(fs.existsSync(path.join(d, "state-michaelzelbel__godspeed-forge.json")), "the Forge keeps its own state");
  fs.writeFileSync(path.join(d, "messages.json"), JSON.stringify([{ id: 41, ts: ts(60), text: "sync 2: yes" }]));
  await run(envM(), T0 + 600e3, quiet, { channels: c.api });
  const last = postsOf(d).at(-1);
  assert.equal(last.repo, F); assert.equal(last.number, 12); assert.ok(last.body.includes("question 1: Sync problem"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, "replies.json"), "utf8")).last_message_id, 41, "one reply cursor for both projects");
  assert.notEqual(stateFileOf({ STATE: "/s/state.json", MAIN_REPO: P }, FORGE), "/s/state.json");
  assert.equal(stateFileOf({ STATE: "/s/state.json", MAIN_REPO: P }, { repo: P.toUpperCase() }), "/s/state.json");
}

testCase("one project unreadable: the other is still settled, and his replies wait until both lists are readable");
{
  const P = PRODUCT.repo, F = FORGE.repo;
  const d = setup("oq-oneun-"); const c = channels();
  fs.writeFileSync(path.join(d, "issues.json"), JSON.stringify({ [F]: [{ title: "Owner decisions needed", state: "open", number: 3, updated_at: "1", body: `### 1. Sync problem\n${PAY}\n` }], [P]: "unreadable" }));
  fs.writeFileSync(path.join(d, "comments.json"), "{}");
  const env = mkEnv(d, { REPO: undefined, PROJECTS: [PRODUCT, FORGE] });
  const r = await run(env, T0, quiet, { channels: c.api });
  assert.equal(r.ok, false); assert.deepEqual(r.paged, ["For the Forge add-on: Sync problem"]);
  fs.writeFileSync(path.join(d, "messages.json"), JSON.stringify([{ id: 7, ts: ts(60), text: "sync: yes" }]));
  await run(env, T0 + 600e3, quiet, { channels: c.api });
  assert.equal(posts(d), 0, "no reply relayed while the product's list cannot be read");
  const i2 = JSON.parse(fs.readFileSync(path.join(d, "issues.json"), "utf8")); i2[P] = []; fs.writeFileSync(path.join(d, "issues.json"), JSON.stringify(i2));
  await run(env, T0 + 700e3, quiet, { channels: c.api });
  assert.equal(posts(d), 1);
}

testCase("a question Mission Control answered with him in the chat is never asked");
{
  const d = setup("oq-chat-"); const c = channels();
  issue(d, `### 1. Sync problem\n${PAY}\n`); fs.writeFileSync(path.join(d, "answered-elsewhere.json"), JSON.stringify(["Sync problem"]));
  const r = await run(mkEnv(d), T0, quiet, { channels: c.api });
  assert.equal(r.paged.length + r.decided.length, 0); assert.equal(c.tg.length, 0);
}

testCase("the release driver's own question: a product choice it would make is decided at once on the item and leaves its list");
{
  const d = setup("oq-drv-"); const c = channels();
  issue(d, "intro, no questions");
  fs.writeFileSync(path.join(d, "driver-questions.json"), JSON.stringify({ "o/r": [{ heading: "The card's look (#612)", body: "A question about the product (it is about look and feel). Nothing is decided until you answer, and the item waits for you. What Mission Control would do: keep the grey card.", issue: 612 }] }));
  const r = await run(mkEnv(d), T0, quiet, { channels: c.api });
  assert.deepEqual(r.decided, ["The card's look (#612)"]); assert.equal(c.tg.length, 0);
  assert.deepEqual(postsOf(d).map(p => p.number), [612]); assert.ok(postsOf(d)[0].body.includes(": keep the grey card."));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, "driver-questions.json"), "utf8"))["o/r"], [], "the item no longer waits on it");
  assert.deepEqual(labelsOf(d), [612]);
}

testCase("the release driver's question that would spend money pages him, and his answer goes onto the item's own issue");
{
  const d = setup("oq-drv2-"); const c = channels();
  issue(d, "intro");
  fs.writeFileSync(path.join(d, "driver-questions.json"), JSON.stringify({ "o/r": [{ heading: "Sync problem on a release item (#612)", body: `When you edit a setting on two computers, syncing stops.\n${PAY}`, issue: 612 }] }));
  assert.deepEqual((await run(mkEnv(d), T0, quiet, { channels: c.api })).paged, ["Sync problem on a release item (#612)"]);
  assert.ok(c.tg[0].includes("https://github.com/o/r/issues/612"), "with the item's own link");
  fs.writeFileSync(path.join(d, "messages.json"), JSON.stringify([{ id: 21, ts: ts(60), text: "sync: yes" }]));
  await run(mkEnv(d), T0 + 600e3, quiet, { channels: c.api });
  assert.ok(postsOf(d)[0].number === 612 && postsOf(d)[0].body.includes("Owner decision (question 901"));
}

testCase("the retired queue is handed over once: each entry looked at again, written to the journal, the file set aside");
{
  const d = setup("oq-drain-"); const c = channels();
  issue(d, `### 1. Sync problem\nOptions: (a) keep; (b) change. Recommendation: (b).\n\n### 2. Old thing gone\nx\n`);
  fs.writeFileSync(path.join(d, "state.json"), JSON.stringify({ v: STATE_VERSION, told: {}, tries: {}, routed: { [keyOf("Sync problem")]: { at: "2026-11-16T08:00:00Z", heading: "Sync problem", number: 1, why: "how" } } }));
  fs.writeFileSync(path.join(d, RETIRED_QUEUE), JSON.stringify({ items: [{ repo: "o/r", heading: "Sync problem", asked: "2026-11-16T08:00:00Z" }, { repo: "x/gone", heading: "Elsewhere", asked: "2026-11-17T08:00:00Z" }] }));
  const r = await run(mkEnv(d), T0, quiet, { channels: c.api });
  assert.ok(r.decided.includes("Sync problem"), "a question that waited in the queue is decided now");
  assert.ok(!fs.existsSync(path.join(d, RETIRED_QUEUE)), "the queue file is gone");
  assert.equal(fs.readdirSync(d).filter(n => n.startsWith(`${RETIRED_QUEUE}.drained-`)).length, 1, "kept beside it, never deleted");
  assert.deepEqual(journalOf(d).filter(e => e.t === "handover").map(e => e.question), ["Sync problem", "Elsewhere"]);
  await run(mkEnv(d), T0 + 5 * MIN, quiet, { channels: c.api });
  assert.ok(!fs.existsSync(path.join(d, RETIRED_QUEUE)), "and nothing writes it again");
}

testCase("no code path writes the retired queue file (only the drain sets it aside, and readers may still look)");
{
  const root = path.join(HERE, "..", "..");
  const files = [];
  const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) { if (e.name !== "test") walk(f); } else if (f.endsWith(".mjs")) files.push(f); } };
  walk(root);
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => { if (/mission-control-queue|RETIRED_QUEUE/.test(l)) assert.ok(!/write|append|copyFile/.test(l), `${path.relative(root, f)}:${i + 1} writes the retired queue: ${l.trim()}`); });
  }
  const src = fs.readFileSync(path.join(root, "steps", "questions", "factory-owner-questions.mjs"), "utf8");
  assert.ok(!/writeMissionControlQueue|Factory questions for Mission Control\.md|notices\.json/.test(src.replace(/\/\/.*$/gm, "")), "no queue and no notice file is written by the questions step");
}

testCase("state from before 2026-11-24: questions told only through the notices file (no receipt) and those routed to the queue are looked at again; answered ones stay");
{
  const d = setup("oq-v1-"); const c = channels();
  issue(d, `### 1. Told without receipt\nOptions: (a) keep; (b) change. Recommendation: (a).\n\n### 2. Answered before\n${PAY}\n\n### 3. Routed before\n${PAY}\n`);
  fs.writeFileSync(path.join(d, "state.json"), JSON.stringify({ told: { [keyOf("Told without receipt")]: { at: "2026-11-16T08:00:00Z", heading: "Told without receipt", notice: "factory-question-x", handle: "told" }, [keyOf("Answered before")]: { at: "2026-11-16T08:00:00Z", heading: "Answered before", handle: "ans", answered: { at: "2026-11-16T09:00:00Z" } } }, tries: { x: 2 }, routed: { [keyOf("Routed before")]: { at: "2026-11-16T08:00:00Z", heading: "Routed before", final: true } }, unworded: {} }));
  const r = await run(mkEnv(d), T0, quiet, { channels: c.api });
  assert.deepEqual(r.decided, ["Told without receipt"]); assert.deepEqual(r.paged, ["Routed before"], "it would spend money: paged now, with a receipt");
  const s = stateOf(d);
  assert.equal(s.v, STATE_VERSION); assert.ok(s.told[keyOf("Answered before")].answered, "his answered question is never asked again");
}
