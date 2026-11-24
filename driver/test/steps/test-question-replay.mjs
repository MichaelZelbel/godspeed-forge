// node --disable-warning=ExperimentalWarning driver/test/steps/test-question-replay.mjs
// test cases: 2
// A replay of the factory's question state on 2026-11-24: the product's "Owner decisions needed" issue with its 26
// unnumbered questions (the reading of before found none of them), the second project's 4 numbered ones, the retired
// queue's 14 entries nobody read (the Forge's and Querino's among them), and questions told only through the notices
// file, with no delivery receipt. After one run of the questions step and one round of the accountant an hour later,
// every question is decided, delivered to the owner with a receipt, or flagged (a halt, and the driver's own obstacle):
// none is silently skipped.
import { testCase } from "../../../test/cases.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { run as questionsRun } from "../../steps/questions.mjs";
import * as check from "../../steps/question-check.mjs";
import { headingsOf, names, deliveredKeys } from "../../steps/questions/accountant.mjs";
import { keyOf, RETIRED_QUEUE, loadState, stateFileOf } from "../../steps/questions/factory-owner-questions.mjs";
import { readRoutedQuestions } from "../../world.mjs";
import { findObstacles } from "../../obstacles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures", "questions-2026-11-24");
const fx = f => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const MIN = 60000, T0 = Date.parse("2026-11-24T14:00:00Z");
const P = "MichaelZelbel/godspeed-mission-control", C = "example/private-app", F = "MichaelZelbel/godspeed-forge", Q = "MichaelZelbel/querino";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qreplay-"));
const qdir = path.join(tmp, "questions"); fs.mkdirSync(qdir, { recursive: true });
const queue = fx("mission-control-queue.json").items;

// the owner issues: the product's and the second project's as they were; the Forge's and Querino's carry the questions the queue held for them
const ownerIssues = {
  [P]: { number: 531, html_url: `https://github.com/${P}/issues/531`, body: fx("godspeed-531.json").body },
  [C]: { number: 31, html_url: `https://github.com/${C}/issues/31`, body: fx("cherishly-31.json").body },
  [F]: { number: 12, html_url: `https://github.com/${F}/issues/12`, body: queue.filter(i => i.repo === F && i.number < 900).map(i => `### ${i.number}. ${i.heading}\n${i.question}`).join("\n\n") },
  [Q]: { number: 1, html_url: `https://github.com/${Q}/issues/1`, body: queue.filter(i => i.repo === Q && i.number < 900).map(i => `### ${i.number}. ${i.heading}\n${i.question}`).join("\n\n") },
};
fs.writeFileSync(path.join(tmp, "issues.json"), JSON.stringify(Object.fromEntries(Object.entries(ownerIssues).map(([repo, i]) => [repo, [{ title: "Owner decisions needed", state: "open", updated_at: "1", ...i }]]))));
// the release driver's own questions the queue held (its numbers from 901 up)
const dq = {};
for (const i of queue.filter(x => x.number >= 900)) (dq[i.repo] ||= []).push({ heading: i.heading, body: i.question, issue: Number((/#(\d+)/.exec(i.heading) || [])[1]) });
fs.writeFileSync(path.join(qdir, "driver-questions.json"), JSON.stringify(dq));
fs.copyFileSync(path.join(FIX, "mission-control-queue.json"), path.join(qdir, RETIRED_QUEUE));
// the product's state from before: three questions told only through the notices file, no receipt
const toldBefore = ["The empty Recent People card still shows a heart (look and feel)", "Raise or replace the scenarios' OpenRouter key (monthly limit reached)", "Fix the release step that opened a lower version (#726)"];
fs.writeFileSync(path.join(qdir, "state.json"), JSON.stringify({ told: Object.fromEntries(toldBefore.map(h => [keyOf(h), { at: "2026-11-16T08:00:00.000Z", heading: h, notice: "factory-question-x", handle: "x", sent: "..." }])), tries: {}, last_message_id: 0 }));
fs.mkdirSync(path.join(tmp, "g", ".godspeed"), { recursive: true });
fs.writeFileSync(path.join(tmp, "g", ".godspeed", "notices.json"), JSON.stringify({ notices: toldBefore.map((h, i) => ({ id: `factory-question-${i}`, text: h, at: "2026-11-16T08:00:00.000Z" })) }));
fs.writeFileSync(path.join(tmp, "messages.json"), "[]");

// GitHub, Telegram, email and the urgent issue, in memory: what the step posts is what the accountant reads
const comments = {};
const gh = { post: (repo, n, body) => { (comments[`${repo}#${n}`] ||= []).push({ body }); return { id: 1 }; }, read: (repo, n) => comments[`${repo}#${n}`] || [] };
const sent = { tg: [], mails: [], issues: [] };
let receipt = 0;
const channels = { telegram: async t => { sent.tg.push(t); return { ok: true, receipt: String(++receipt) }; }, email: async m => { sent.mails.push(m); return { ok: true, receipt: `m${++receipt}` }; },
  emailReplies: async () => [], openIssue: async m => { sent.issues.push(m); return { ok: true, receipt: `https://github.com/o/w/issues/${++receipt}` }; }, closeIssue: async () => true, issueComments: async () => [] };
const model = path.join(tmp, "model.mjs");
fs.writeFileSync(model, `let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{const i=JSON.parse(t);let out;
if(i.system.includes("finished message"))out={decides:"Whether to pay for more.",changes_for_user:"Whether the checks of the app can run.",plain:true};
else if(i.system.includes("check one example"))out={ok:true};
else out={route:"owner",handle:"key",about:"Paying for the checks' key",experience:"When you wait for a new version, it cannot be checked until the key works again.",options:["Raise the limit now.","Wait until it resets."],recommended:1,reason:"Releases can be checked again at once.",if_nothing:"Nothing is checked until the key resets."};
console.log(JSON.stringify({text:JSON.stringify(out)}));});`);
const settings = { owner: { github_login: "MichaelZelbel", name: "Michael" }, server: { factory_user: "factory", factory_home: "/home/factory", state_dir: path.join(tmp, "driver"), questions_dir: qdir, driver_dir: "/opt/driver" },
  steps: { questions: { godspeed_dir: path.join(tmp, "g"), hermes_home: path.join(tmp, "h") } } };
const projects = [{ repository: P }, { repository: C }, { repository: F }, { repository: Q }];
const env = { OQ_ISSUES_FILE: path.join(tmp, "issues.json"), OQ_MESSAGES_FILE: path.join(tmp, "messages.json"), OQ_MODEL_CMD: `node "${model.replace(/\\/g, "/")}"` };
const ctx = at => ({ settings, main: projects[0], projects, env, settingsDir: "/etc/driver", nowMs: () => T0 + at, now: T0 + at, stateDir: path.join(tmp, "driver", "steps", "question-check"),
  questionDeps: { channels, postComment: gh.post, readComments: gh.read, removeLabel: () => {} },
  accountantDeps: { ownerIssue: repo => ({ number: ownerIssues[repo].number, body: ownerIssues[repo].body, url: ownerIssues[repo].html_url }), comments: gh.read, telegram: channels.telegram } });

testCase("one round: every question of the four projects is decided, delivered with a receipt, or flagged, and none is skipped");
{
  const r = await questionsRun(ctx(0));
  await check.run(ctx(0)); // the accountant runs in every round of the driver, this one too
  assert.equal(r.ok, true, r.error);
  const c = await check.run(ctx(61 * MIN));
  const routed = readRoutedQuestions({ QUESTIONS_DIR: qdir }, { readFile: p => fs.readFileSync(p, "utf8") });
  const obstacles = findObstacles({ routedQuestions: routed }, {}, T0 + 61 * MIN, {});
  // flagged: listed by the accountant as reaching nobody, under a halt the driver repairs, and the driver's own obstacle
  const acc = JSON.parse(fs.readFileSync(path.join(tmp, "driver", "steps", "question-check", "state.json"), "utf8"));
  const halted = new Set((c.halts || []).map(h => h.key));
  const envQ = { STATE: path.join(qdir, "state.json"), MAIN_REPO: P };
  const tally = { decided: 0, delivered: 0, flagged: 0 }, byState = {};
  for (const [repo, i] of Object.entries(ownerIssues)) {
    const st = loadState(stateFileOf(envQ, { repo }));
    const delivered = deliveredKeys(st);
    for (const q of headingsOf(i.body)) {
      const decided = [i.number, ...q.items].some(n => gh.read(repo, n).some(x => names(x.body, q.key)));
      const flagged = halted.has(`nobody-${repo.toLowerCase().replace("/", "__")}`) && (acc.nobody[repo] || []).some(x => x.key === q.key) && obstacles.some(o => o.repo === repo && o.question.key === q.key);
      assert.equal([decided, delivered.has(q.key), flagged].filter(Boolean).length, 1, `${repo}: "${q.title}" is in exactly one state`);
      const state = decided ? "decided" : delivered.has(q.key) ? "delivered" : "flagged";
      tally[state]++; (byState[state] ||= []).push(`${repo.split("/")[1]}: ${q.title}`);
    }
  }
  // the release driver's own questions: decided on their item, paged, or handed to the decide helper
  for (const repo of Object.keys(dq)) {
    const st = loadState(stateFileOf(envQ, { repo }));
    for (const q of dq[repo]) {
      const key = `${keyOf(q.heading)} item ${q.issue}`;
      const ok = st.decided[key] || deliveredKeys(st).has(key) || routed.some(x => x.repo === repo && x.key === key);
      assert.ok(ok, `${repo}: the driver's question "${q.heading}" is settled, paged or with the decide helper`);
    }
  }
  assert.deepEqual(Object.values(tally).reduce((a, b) => a + b, 0), headingsOf(ownerIssues[P].body).length + headingsOf(ownerIssues[C].body).length + headingsOf(ownerIssues[F].body).length + headingsOf(ownerIssues[Q].body).length);
  assert.deepEqual(byState.delivered, ["godspeed-mission-control: Raise or replace the scenarios' OpenRouter key (monthly limit reached)", "querino: querino.ai is still on an old build: publish what `main` holds (only you can)"], "only spending money and publishing page the owner");
  assert.deepEqual(byState.flagged, ["godspeed-forge: The loop's work outside setup waits on question 2 (status, no decision needed beyond 1 and 2)", "godspeed-forge: Edit history of PR #68's description (for your information, no decision needed)"], "notes with nothing to pick from go to the driver's decide helper, and the accountant keeps them visible until it decides");
  assert.equal(tally.decided, 34);
  assert.ok(sent.tg.every(t => /^Question "/.test(t)) && sent.tg.length === 2, "only the pages reach Telegram, each in the page's shape");
  assert.ok(sent.tg.some(t => t.includes(`${P}/issues/531`)), "the OpenRouter key question reaches him");
  globalThis.__replayTally = { tally, telegram: sent.tg.length, routed: routed.length };
}

testCase("the retired queue was handed over entry by entry and set aside; the old notices file was not written; Godspeed's 26 were read");
{
  assert.ok(!fs.existsSync(path.join(qdir, RETIRED_QUEUE)));
  const j = fs.readFileSync(path.join(tmp, "driver", "journal.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  assert.equal(j.filter(e => e.t === "handover").length, 14);
  assert.ok(j.filter(e => e.t === "decision").length >= 25, "every decision is in the driver's journal");
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "g", ".godspeed", "notices.json"), "utf8")).notices.length, 3, "nothing more is put into the notices file");
  assert.equal(headingsOf(ownerIssues[P].body).length, 26);
  const st = loadState(path.join(qdir, "state.json"));
  assert.equal(Object.keys(st.decided).length + Object.values(st.told).filter(t => t.page).length + Object.keys(st.routed || {}).length >= 26, true);
  console.log(`replay: ${JSON.stringify(globalThis.__replayTally)}`);
}
