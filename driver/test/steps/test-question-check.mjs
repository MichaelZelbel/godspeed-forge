// node --disable-warning=ExperimentalWarning driver/test/steps/test-question-check.mjs
// test cases: 6
// The question accountant (question-check step): every question decided, delivered with a receipt, or young; any
// other is a halt the driver repairs, and after two hours one fixed message to the owner per question.
import { testCase } from "../../../test/cases.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import * as check from "../../steps/question-check.mjs";
import { headingsOf, names, deliveredKeys, account, alarmText } from "../../steps/questions/accountant.mjs";
import { keyOf, idOf, decisionMarker, markerOf } from "../../steps/questions/factory-owner-questions.mjs";
import { questionCounts, decisionLines, NEW_OWNER_OFF } from "../../cli.mjs";
import { stepEntries } from "../../steps.mjs";
import { readJournal, view } from "../../journal.mjs";

const MIN = 60000, T0 = Date.parse("2026-11-24T12:00:00Z");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qcheck-"));

testCase("the accountant reads every ### heading itself and names each question's state");
{
  assert.deepEqual(headingsOf("x\n### 7. Dark mode (#5)\na\n### The card\nb\n### The card\n").map(q => [q.title, q.items]), [["Dark mode (#5)", [5]], ["The card", []]]);
  const k = keyOf("The card");
  assert.ok(names(`Manager decision (Mission Control, on Alex's standing instruction of 2026-11-24) on the question "The card": option (b).\n${decisionMarker(k)}`, k));
  assert.ok(names(`Owner decision (question 3: The card)\n\n> yes\n${markerOf(9, k)}`, k));
  assert.ok(names("Manager decision (Mission Control, not Alex): about the card, keep it.", k), "a decision that names it by title");
  assert.ok(!names("Manager decision: keep it. The card stays.", k), "the factory manager's own note is not Mission Control's decision");
  assert.ok(!names(`Some comment ${decisionMarker(k)}`, k), "a marker without a decision heading decides nothing");
  assert.deepEqual([...deliveredKeys({ told: { a: { page: { stages: [{ channels: { telegram: { receipt: "5" } } }] } }, b: { page: { stages: [{ channels: { telegram: { why: "502" } } }] } }, c: { page: { stages: [{ channels: { telegram: { receipt: "6" } } }] }, answered: { at: "x" } } } })], ["a"], "a receipt and no answer yet");
  const firstSeen = { old: T0 - 61 * MIN };
  const r = account({ questions: [{ key: "d" }, { key: "p" }, { key: "new" }, { key: "old" }], firstSeen, decided: new Set(["d"]), delivered: new Set(["p"]), now: T0 });
  assert.deepEqual(r.rows.map(x => x.state), ["decided", "delivered", "young", "nobody"]);
  assert.deepEqual(r.counts, { total: 4, decided: 1, delivered: 1, young: 1, nobody: 1 });
  assert.equal(alarmText(3), "3 factory questions have reached neither you nor Mission Control for 2 hours. Mission Control is repairing it.");
}

// one step context, with stand-ins for GitHub and Telegram
const settings = { owner: { github_login: "boss", name: "Alex" }, server: { factory_user: "builder", factory_home: "/srv/builder", state_dir: path.join(tmp, "state"), questions_dir: path.join(tmp, "q") },
  steps: { questions: { godspeed_dir: path.join(tmp, "g"), hermes_home: path.join(tmp, "h") } } };
const main = { repository: "acme/app" };
const world = { body: "", comments: {}, tg: [], tgUp: true };
const deps = { ownerIssue: () => ({ number: 7, body: world.body, url: "https://github.com/acme/app/issues/7" }), comments: (repo, n) => world.comments[n] || [],
  telegram: async t => { world.tg.push(t); return world.tgUp ? { ok: true, receipt: String(1000 + world.tg.length) } : { ok: false, why: "telegram http 502" }; } };
const ctx = (at, extra = {}) => ({ settings, main, projects: [main], env: {}, settingsDir: "/etc/driver", stateDir: path.join(tmp, "state", "steps", "question-check"), now: T0 + at, accountantDeps: deps, ...extra });
const writeQ = s => { fs.mkdirSync(path.join(tmp, "q"), { recursive: true }); fs.writeFileSync(path.join(tmp, "q", "state.json"), JSON.stringify({ v: 2, told: {}, tries: {}, decided: {}, ...s })); };

testCase("a new question is fine for an hour; then, neither decided nor delivered, it is a halt the driver repairs at once");
{
  world.body = "### The card (#12)\nx\n\n### Budget\ny\n\n### Already settled\nz\n";
  world.comments[7] = [{ body: `Manager decision (Mission Control, on Alex's standing instruction of 2026-11-24) on the question "Already settled": keep.\n${decisionMarker(keyOf("Already settled"))}` }];
  writeQ({ told: { [keyOf("Budget")]: { heading: "Budget", page: { stages: [{ at: T0, channels: { telegram: { at: T0, receipt: "55" } } }] } } } });
  let r = await check.run(ctx(0));
  assert.equal(r.ok, true); assert.equal(r.halt, undefined, "young: the questions step has an hour");
  r = await check.run(ctx(61 * MIN));
  assert.equal(r.halt.key, "nobody-acme__app");
  assert.match(r.halt.words, /^Factory question reached nobody: 1 question in the "Owner decisions needed" issue of acme\/app/);
  assert.match(r.halt.words, /"The card \(#12\)"/); assert.ok(!/Budget|Already settled/.test(r.halt.words), "the delivered and the decided one are fine");
  assert.equal(r.summary, "3 questions: 1 decided, 1 delivered, 0 new, 1 reached nobody");
  const s = { steps: { "question-check": { halts: { [r.halt.key]: { words: r.halt.words, since: T0 } } } } };
  const e = stepEntries(s, [{ STEP: check.STEP, SETTINGS: [] }], settings, T0 + 61 * MIN);
  assert.ok(e.some(x => x.id === "halt:question-check:nobody-acme__app" && x.limitH === 0), "a halt entry: the acting run takes it at once");
  assert.equal(world.tg.length, 0, "nothing to the owner yet");
}

testCase("after two hours in no state the owner gets one fixed message with a receipt, written to the journal, never repeated");
{
  const r = await check.run(ctx(121 * MIN));
  assert.deepEqual(world.tg, ["1 factory question has reached neither you nor Mission Control for 2 hours. Mission Control is repairing it."]);
  assert.match(r.summary, /the owner was told about 1 \(receipt 1001\)/);
  const j = readJournal(path.join(tmp, "state", "journal.jsonl"));
  const n = Object.entries(view(j.events).notices).find(([id]) => id.startsWith("question-alarm:"));
  assert.ok(n && n[1].receipts.telegram === "1001" && n[1].text === world.tg[0], "in the driver's journal with its receipt");
  await check.run(ctx(126 * MIN)); await check.run(ctx(300 * MIN));
  assert.equal(world.tg.length, 1, "once per question");
  // a second question reaching nobody later is told once, by itself
  world.body += "### Another one\nq\n";
  await check.run(ctx(301 * MIN)); await check.run(ctx(425 * MIN));
  assert.equal(world.tg.length, 2); assert.ok(world.tg[1].startsWith("1 factory question has"));
}

testCase("a decision posted on the question's item counts, a failed Telegram send is left to the driver's journal retry");
{
  world.comments[12] = [{ body: `Manager decision (Mission Control, not Alex): keep the card.\nThis decides the factory question "The card".\n<!-- factory-question:${idOf(keyOf("The card (#12)"))} -->` }];
  world.body = "### The card (#12)\nx\n\n### Late one\ny\n";
  world.tgUp = false; world.tg.length = 0;
  let r = await check.run(ctx(430 * MIN));
  r = await check.run(ctx(560 * MIN));
  assert.ok(!/The card/.test((r.halt || {}).words || ""), "decided on its item");
  assert.equal(world.tg.length, 1); assert.match(r.summary, /failed \(telegram http 502\), the driver retries/);
  const j = readJournal(path.join(tmp, "state", "journal.jsonl"));
  assert.ok(Object.values(view(j.events).notices).some(n => !Object.keys(n.receipts).length && n.text.startsWith("1 factory question")), "a notice without a receipt: the driver's delivery retry sends it again");
  await check.run(ctx(600 * MIN)); assert.equal(world.tg.length, 1, "this step never sends it twice");
  world.tgUp = true;
}

testCase("an unreadable issue or comment list concludes nothing; the counts show in driver status");
{
  const bad = { ...deps, ownerIssue: () => { throw new Error("HTTP 502"); } };
  const r = await check.run(ctx(700 * MIN, { accountantDeps: bad }));
  assert.equal(r.ok, false); assert.match(r.error, /HTTP 502/);
  const lines = questionCounts(path.join(tmp, "state"));
  assert.equal(lines.length, 1); assert.match(lines[0], /^factory questions of acme\/app: 2 open, \d+ decided, \d+ with the owner \(delivered\), \d+ new, \d+ reached nobody$/);
  assert.ok(NEW_OWNER_OFF.includes("questions"), "a new owner's server has the questions step off");
  const off = await check.run(ctx(0, { settings: { ...settings, steps: { questions: { enabled: false } } } }));
  assert.equal(off.ok, true); assert.match(off.summary, /questions step is off/, "so this check does nothing there either, and reads nothing");
}

testCase("driver status --decisions lists what was decided for the owner, from the journal");
{
  const f = path.join(tmp, "decisions.jsonl");
  fs.writeFileSync(f, [{ t: "decision", at: "2026-11-24T12:00:00.000Z", repo: "acme/app", question: "The card (#12)", choice: "option (b): move it up", how: "recommended", targets: [12] }, { t: "page", at: "2026-11-24T12:01:00.000Z" }, { t: "decision", at: "2026-11-01T12:00:00.000Z", repo: "acme/app", question: "Old", choice: "x", how: "recommended" }].map(e => JSON.stringify(e)).join("\n") + "\n");
  assert.deepEqual(decisionLines(f, 7, T0 + 60 * MIN), ["1 decision in the last 7 days:", `2026-11-24 12:00 UTC, acme/app: "The card (#12)" -> option (b): move it up (recommended, on #12)`]);
  assert.equal(decisionLines(f, 30, T0 + 60 * MIN).length, 3);
  assert.deepEqual(decisionLines(path.join(tmp, "none.jsonl")), ["No decisions are recorded yet."]);
}
