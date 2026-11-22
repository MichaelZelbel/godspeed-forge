// node --disable-warning=ExperimentalWarning driver/test/steps/test-factory-owner-questions.mjs   (needs bash for the stubbed model)
// test cases: 32
import { testCase } from "../../../test/cases.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert/strict";
import { genericProject, DEFAULT_OWNER, markerOf, plainWords, WORDING_TRIES, parseQuestions, pickIssue, berlinDeadline, checkWords, renderMessage, handleMatch, handleMeaning, keyOf, run, queueNotice, parseProjects, systemFor, stateFileOf, handleSplit, notUnderstood, idOf } from "../../steps/questions/factory-owner-questions.mjs";

// the two projects of the first owner's factory, as a project file's "questions" key brings them (test data)
const PRODUCT = { repo: "MichaelZelbel/godspeed-mission-control", label: "Godspeed", name: "Godspeed", main: true,
  product: "Godspeed, a personal AI assistant program that people install",
  seat: "as a person who writes to Godspeed and reads Godspeed's replies. Godspeed is the one replying.",
  example: "When you write to Godspeed in English and its answer is very short, like 'All right', it sometimes sends you 'I could not translate this' instead of the answer." };
const FORGE = { repo: "MichaelZelbel/godspeed-forge", label: "the Forge add-on", name: "the Forge",
  product: "the Forge, an add-on for Godspeed (a personal AI assistant program): a person who has Godspeed and a software project on GitHub plans a release in one sentence, an AI software factory builds it, the release lands on a test copy, and the person's go makes it public",
  seat: "as a person who tells Godspeed which release of their own software to plan, answers its questions, and reads what it reports about the build. The Forge, speaking through Godspeed, is the one reporting.",
  example: "When you say 'go' to make a finished release public, it sometimes tells you the release is public before your test copy was ever checked." };

testCase("pure parts");
// ---- pure parts
const body = `intro\n\n### 1. Key is out (#522)\nbody one\n- Default: by 2026-11-15 19:15 UTC.\n\n### 2. Second thing\nbody two\n\n\n### Note (manager pass): waiting\nnot a question\n`;
const qs = parseQuestions(body);
assert.equal(qs.length, 2); assert.equal(qs[0].heading, "Key is out (#522)"); assert.ok(!qs[1].body.includes("not a question"));
assert.equal(berlinDeadline("asked 2026-11-10 09:00 UTC; by 2026-11-15 19:15 UTC"), "Sunday 15 November, 20:15 Berlin time");
assert.equal(berlinDeadline("2026-07-01 10:00 UTC"), "Wednesday 1 July, 12:00 Berlin time");
assert.equal(pickIssue([{ title: "Owner decisions needed", state: "closed" }, { title: "x" }, { title: "Owner decisions needed", state: "open", number: 9, updated_at: "2" }, { title: "Owner decisions needed", state: "open", number: 8, updated_at: "1" }]).number, 9);
assert.equal(keyOf("Should we ship it? (#5)"), keyOf("should we  ship it"));
const good = { route: "owner", handle: "sync", about: "Syncing with a settings conflict", experience: "When you edit a setting on two computers, syncing stops for everything.", options: ["Keep stopping everything until you decide.", "Only hold back the one setting."], recommended: 2, reason: "Your notes should never get stuck.", if_nothing: "Nothing changes until you decide." };
assert.equal(checkWords(good), "");
assert.ok(checkWords({ ...good, experience: "The holdout check fails." }).length > 0, "must start with a person's experience");
assert.ok(checkWords({ ...good, options: ["Merge the scenarios (PR #5).", "b"] }).startsWith("jargon"));
assert.ok(checkWords({ ...good, handle: "Sync!" }) === "handle");
const msg = renderMessage(good, "sync", "https://github.com/o/r/issues/7");
assert.ok(msg.startsWith('Question "sync"') && msg.includes('"sync: yes"') && msg.includes('"sync: no"') && msg.includes("issues/7") && !msg.includes("—"));
const cands = [{ key: "a", number: 3 }, { key: "b", number: 4 }];
const st = { told: { a: { handle: "sync", options: good.options, recommended: 2 }, b: { handle: "short replies", options: ["x.", "y."], recommended: 1 } } };
assert.equal(handleMatch("Sync: yes", cands, st).q.number, 3);
assert.equal(handleMatch("short   replies - no thanks, do it differently", cands, st).q.number, 4);
assert.equal(handleMatch("sync 1", cands, st).rest, "1");
assert.equal(handleMatch("sync the files please", cands, st), null, "a sentence that starts with the word is not an answer");
assert.ok(handleMeaning("yes", st.told.a).includes("recommendation, choice 2: Only hold back"));
assert.ok(handleMeaning("No.", st.told.a).includes("choice 1: Keep stopping"));
assert.equal(handleMeaning("keep it but ask me first", st.told.a), null, "handled free text goes through the decision classifier");

testCase("runs with a stubbed model");
// ---- runs with a stubbed model
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oq-"));
const stub = path.join(dir, "stub.mjs");
fs.writeFileSync(stub, `let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{const i=JSON.parse(t);let out;
if(i.system.includes("Telegram message")){const m=/<message>\\n([\\s\\S]*?)\\n<\\/message>/.exec(i.prompt)[1];if(m.includes("BROKEN"))process.exit(1);
 out={answers:[...(m.includes("first")?[{question:1,meaning:"Do the first thing."}]:[]),...(m.includes("second")?[{question:2,meaning:"Choose option b."}]:[])]};}
else if(i.system.includes("finished message")){out={decides:"Whether it stops everything or one setting.",changes_for_user:"What happens to your notes when settings clash.",plain:!/plainfail/i.test(i.prompt),problem:"invented names"};}
else if(i.system.includes("check one example"))out={ok:!i.prompt.includes("BADEXAMPLE")};
else if(i.prompt.includes("TESTS")&&!i.prompt.includes("Michael answers this question"))out={route:"mission-control",why:"It is about how checks work."};
else if(i.prompt.includes("NOMODEL"))process.exit(1);
else{const h=/### ?\\d*\\.? ?|<question>\\n([A-Za-z]+)/.exec(i.prompt);out=${JSON.stringify(good)};out.handle=(/<question>\\n([A-Za-z]+)/.exec(i.prompt)[1]).toLowerCase();}
console.log(JSON.stringify({text:JSON.stringify(out)}));});`);
const setup = name => { const d = fs.mkdtempSync(path.join(os.tmpdir(), name)); fs.mkdirSync(path.join(d, "g", ".godspeed"), { recursive: true }); return d; };
const mkEnv = (d, extra = {}) => ({ REPO: "o/r", FORGE_USER: "x", FORGE_HOME: "/h/x", OWNER_NAME: "Michael", GODSPEED_DIR: path.join(d, "g"), STATE: path.join(d, "state.json"), OQ_ISSUES_FILE: path.join(d, "issues.json"), OQ_MODEL_CMD: `node "${stub.replace(/\\/g, "/")}"`, OQ_MESSAGES_FILE: path.join(d, "messages.json"), OQ_COMMENTS_FILE: path.join(d, "comments.json"), OQ_POST_CMD: `cat >> "${path.join(d, "posts.log").replace(/\\/g, "/")}"; echo '{"id":99}'`, ...extra });
const issue = (d, b, labels = []) => fs.writeFileSync(path.join(d, "issues.json"), JSON.stringify([{ title: "Owner decisions needed", state: "open", number: 7, updated_at: "1", html_url: "https://github.com/o/r/issues/7", body: b, labels }]));
const noticesOf = d => JSON.parse(fs.readFileSync(path.join(d, "g", ".godspeed", "notices.json"), "utf8")).notices;
const posts = d => { try { return (fs.readFileSync(path.join(d, "posts.log"), "utf8").match(/"number"/g) || []).length; } catch { return 0; } };
const quiet = () => {};
const T0 = Date.now(); const ts = s => (T0 + s * 1000) / 1000;

testCase("two questions for him, one about how tests work");
// two questions for him, one about how tests work
const d = setup("oq-a-");
issue(d, "### 1. Sync problem\nbody\n\n### 2. TESTS merge the scenarios\nabout tests\n\n### 3. Short replies\nz\n");
fs.writeFileSync(path.join(d, "comments.json"), "[]"); fs.writeFileSync(path.join(d, "messages.json"), "[]");
assert.deepEqual(run(mkEnv(d), T0, quiet).sent, ["Sync problem", "Short replies"], "the tests question is not sent to him");
const n = noticesOf(d);
assert.equal(n.length, 2); assert.ok(n.every(x => x.written === true && x.text.startsWith("Question \"") && x.text.includes("https://github.com/o/r/issues/7")), "said as written, in English, with a handle");
const q = JSON.parse(fs.readFileSync(path.join(d, "mission-control-queue.json"), "utf8"));
assert.equal(q.items.length, 1); assert.ok(q.items[0].heading.includes("TESTS"));
assert.ok(fs.readFileSync(path.join(d, "g", "notebook", "Factory questions for Mission Control.md"), "utf8").includes("never sent to Telegram"));
assert.equal(run(mkEnv(d), T0 + 1000, quiet).sent.length, 0, "second run is silent");
assert.equal(noticesOf(d).length, 2);

testCase("his answers: by handle first, then by the model; dry run posts nothing");
// his answers: by handle first, then by the model; dry run posts nothing
fs.writeFileSync(path.join(d, "messages.json"), JSON.stringify([
  { id: 1, ts: ts(60), text: "hello, how are you" },
  { id: 2, ts: ts(120), text: "sync: yes" },
  { id: 3, ts: ts(180), text: "go with b for the short one, the second" }]));
run(mkEnv(d, { DRY: true }), T0 + 600e3, quiet);
assert.equal(posts(d), 0);
run(mkEnv(d), T0 + 600e3, quiet);
assert.equal(posts(d), 1, "the handle answer is posted; the model match finds nothing for the number-less question here");
const log = fs.readFileSync(path.join(d, "posts.log"), "utf8");
assert.ok(log.includes("> sync: yes") && log.includes("question 1: Sync problem") && log.includes("recommendation, choice 2"));
run(mkEnv(d), T0 + 900e3, quiet);
assert.equal(posts(d), 1, "never posted twice");

testCase("a question that already has an Owner decision comment is not posted for, and the tests question needs no answe");
// a question that already has an Owner decision comment is not posted for, and the tests question needs no answer
fs.writeFileSync(path.join(d, "comments.json"), JSON.stringify([{ body: "Owner decision (question 3): done.\n" + markerOf(4, keyOf("Short replies")) }]));
fs.writeFileSync(path.join(d, "messages.json"), JSON.stringify([{ id: 4, ts: ts(1000), text: "short: yes" }]));
run(mkEnv(d), T0 + 1200e3, quiet);
assert.equal(posts(d), 1, "already relayed (marker on the issue)");

testCase("a handle reply a week later is still relayed (the model path is limited to a day)");
// a handle reply a week later is still relayed (the model path is limited to a day)
const d7 = setup("oq-g-");
issue(d7, "### 1. Sync problem\nbody\n"); fs.writeFileSync(path.join(d7, "comments.json"), "[]"); fs.writeFileSync(path.join(d7, "messages.json"), "[]");
run(mkEnv(d7), T0, quiet);
fs.writeFileSync(path.join(d7, "messages.json"), JSON.stringify([{ id: 5, ts: ts(7 * 86400), text: "sync: no" }, { id: 6, ts: ts(7 * 86400 + 5), text: "I think the first thing is fine" }]));
run(mkEnv(d7), T0 + 7 * 86400e3 + 60e3, quiet);
assert.equal(posts(d7), 1, "late handle reply relayed; a late free-text message is not guessed at");

testCase("seeded as answered (decided elsewhere): nothing is asked and nothing posted");
// seeded as answered (decided elsewhere): nothing is asked and nothing posted
const d2 = setup("oq-b-");
issue(d2, "### 1. Sync problem\nbody\n"); fs.writeFileSync(path.join(d2, "comments.json"), "[]"); fs.writeFileSync(path.join(d2, "messages.json"), "[]");
run(mkEnv(d2), T0, quiet);
const sj = JSON.parse(fs.readFileSync(path.join(d2, "state.json"), "utf8")); const k = Object.keys(sj.told)[0]; sj.told[k].answered = { by: "hand" };
fs.writeFileSync(path.join(d2, "state.json"), JSON.stringify(sj));
fs.writeFileSync(path.join(d2, "messages.json"), JSON.stringify([{ id: 9, ts: ts(100), text: "sync: no" }]));
run(mkEnv(d2), T0 + 500e3, quiet);
assert.equal(posts(d2), 0); assert.equal(noticesOf(d2).length, 1);

testCase("a message the model never reads is skipped after a few tries, later ones still go through");
// a message the model never reads is skipped after a few tries, later ones still go through
const d3 = setup("oq-c-");
issue(d3, "### 1. First thing\nx\n### 2. Second thing\ny\n"); fs.writeFileSync(path.join(d3, "comments.json"), "[]"); fs.writeFileSync(path.join(d3, "messages.json"), "[]");
run(mkEnv(d3), T0, quiet);
fs.writeFileSync(path.join(d3, "messages.json"), JSON.stringify([{ id: 11, ts: ts(60), text: "BROKEN first" }, { id: 12, ts: ts(70), text: "second one: b" }]));
for (let i = 0; i < 3; i++) { run(mkEnv(d3), T0 + 600e3, quiet); assert.equal(posts(d3), 0); }
run(mkEnv(d3), T0 + 600e3, quiet);
assert.equal(posts(d3), 1);

testCase("an example that fails its own check is never sent, and no 'read it yourself' message replaces it");
// an example that fails its own check is never sent, and no "read it yourself" message replaces it:
// the question waits in Mission Control's queue
const d8 = setup("oq-h-");
issue(d8, "### 5. BADEXAMPLE thing\nx\n");
assert.equal(run(mkEnv(d8), T0, quiet).sent.length, 0);
assert.ok(!fs.existsSync(path.join(d8, "g", ".godspeed", "notices.json")), "nothing reaches him");
assert.ok(JSON.parse(fs.readFileSync(path.join(d8, "mission-control-queue.json"), "utf8")).items[0].heading.includes("BADEXAMPLE"));

testCase("model failing: never sent, however long; in the queue at once and tried again every run, and sent");
// model failing: never sent, however long; in the queue at once and tried again every run, and sent
// as a full plain message once the words work
const d4 = setup("oq-d-");
issue(d4, "### 4. NOMODEL thing\nx\n");
const bad = mkEnv(d4);
for (let i = 0; i < 12; i++) assert.equal(run(bad, T0, quiet).sent.length, 0);
assert.ok(!fs.existsSync(path.join(d4, "g", ".godspeed", "notices.json")), "no fallback message ever");
{ const it = JSON.parse(fs.readFileSync(path.join(d4, "mission-control-queue.json"), "utf8")).items[0];
  assert.ok(it.why.includes(`${WORDING_TRIES} runs`) && it.bounced === true, "after a few tries it is Mission Control's for good, not retried for ever"); }
issue(d4, "### 4. Nomodel fixed\nx\n");
assert.equal(run(bad, T0, quiet).sent.length, 1);
assert.ok(noticesOf(d4)[0].text.startsWith('Question "nomodel"') && noticesOf(d4)[0].text.includes("When you"));
assert.equal(JSON.parse(fs.readFileSync(path.join(d4, "mission-control-queue.json"), "utf8")).items.length, 0, "the old heading left the queue");
testCase("a question Mission Control answered with him in the chat is never asked");
// a question Mission Control answered with him in the chat is never asked
const de = setup("oq-e2-");
issue(de, "### 1. Sync problem\nx\n"); fs.writeFileSync(path.join(de, "answered-elsewhere.json"), JSON.stringify(["Sync problem"]));
assert.equal(run(mkEnv(de), T0, quiet).sent.length, 0);

testCase("one message answering several questions: each handle line its own; text before the first handle");
// one message answering several questions: each handle line its own; text before the first handle
// line and lines without a handle belong to a handle; "no clue" is never relayed as a decision
const dh = setup("oq-k-");
issue(dh, "### 3. Routines thing\nx\n\n### 4. Large files\ny\n\n### 5. Sync problem\nz\n");
fs.writeFileSync(path.join(dh, "comments.json"), "[]"); fs.writeFileSync(path.join(dh, "messages.json"), "[]");
run(mkEnv(dh), T0, quiet);
const dhState = () => JSON.parse(fs.readFileSync(path.join(dh, "state.json"), "utf8"));
assert.deepEqual(Object.values(dhState().told).map(t => t.handle).sort(), ["large", "routines", "sync"]);
fs.writeFileSync(path.join(dh, "messages.json"), JSON.stringify([{ id: 21, ts: ts(60), text: "routines: I have no clue what you want from me, and your question doesn't make sense.\nlarge: yes\nand keep them on this computer\nsync: 1" }]));
run(mkEnv(dh), T0 + 600e3, quiet);
const dhPosts = fs.readFileSync(path.join(dh, "posts.log"), "utf8").split(/(?=\{"repo")/).map(s => JSON.parse(s));
assert.equal(dhPosts.length, 2, "two decisions posted, the not-understood reply is not");
assert.ok(dhPosts[0].body.includes("question 4: Large files") && dhPosts[0].body.includes("> large: yes\n> and keep them on this computer") && !dhPosts[0].body.includes("no clue") && !dhPosts[0].body.includes("sync: 1"));
assert.ok(dhPosts[1].body.includes("question 5: Sync problem") && dhPosts[1].body.includes("choice 1"));
const routinesKey = keyOf("Routines thing");
assert.ok(dhState().told[routinesKey].answered.not_understood && dhState().routed[routinesKey].why.includes("did not understand"));
assert.ok(JSON.parse(fs.readFileSync(path.join(dh, "mission-control-queue.json"), "utf8")).items.some(i => i.heading === "Routines thing"));
assert.equal(handleSplit("thanks!\nsync: no", [{ key: "a", number: 1 }], { told: { a: { handle: "sync" } } })[0].words, "thanks!\nsync: no", "text before the first handle line belongs to it");
assert.ok(notUnderstood("What do you mean?") && notUnderstood("this is unclear") && !notUnderstood("yes, do it"));
testCase("a repeated handle stays where it first stood: text before the first handle line goes to that one");
// a repeated handle stays where it first stood: text before the first handle line goes to that one
const two = handleSplit("ok\nsync: no\nlarge: yes\nsync: and soon", [{ key: "a", number: 1 }, { key: "b", number: 2 }], { told: { a: { handle: "sync" }, b: { handle: "large" } } });
assert.equal(two[0].q.number, 1); assert.equal(two[0].words, "ok\nsync: no\nsync: and soon"); assert.equal(two[1].words, "large: yes");
const three = handleSplit("sync: no\nlarge: yes\nsync: and soon\nplease do it tomorrow", [{ key: "a", number: 1 }, { key: "b", number: 2 }], { told: { a: { handle: "sync" }, b: { handle: "large" } } });
assert.ok(three[0].words.endsWith("please do it tomorrow") && three[1].words === "large: yes", "unlabelled lines belong to the handle named just before them");
assert.equal(handleMatch("sync:\nyes", [{ key: "a", number: 1 }], { told: { a: { handle: "sync" } } }).rest, "yes", "the handle alone, the answer on the next line");

// The exact q3 complaint must not swallow a later explicit large-files answer in the same message.
const dq3 = setup("oq-q3-");
issue(dq3, "### 3. Legacy question\nx\n\n### 4. Large files\ny\n");
fs.writeFileSync(path.join(dq3, "comments.json"), "[]"); fs.writeFileSync(path.join(dq3, "messages.json"), "[]");
run(mkEnv(dq3), T0, quiet);
const dq3State = JSON.parse(fs.readFileSync(path.join(dq3, "state.json"), "utf8"));
dq3State.told[keyOf("Legacy question")].handle = "q3";
dq3State.told[keyOf("Large files")].handle = "large files";
fs.writeFileSync(path.join(dq3, "state.json"), JSON.stringify(dq3State));
fs.writeFileSync(path.join(dq3, "messages.json"), JSON.stringify([{ id: 41, ts: ts(60), text: "q3: I have no clue what you want from me, and your question doesn't make sense.\nlarge files: yes" }]));
run(mkEnv(dq3), T0 + 600e3, quiet);
assert.equal(posts(dq3), 1, "the clear large-files answer is relayed");
assert.ok(fs.readFileSync(path.join(dq3, "posts.log"), "utf8").includes("question 4: Large files"));

// An explicit first answer line keeps its continuation but still decides the recommendation mechanically.
const dc = setup("oq-continuation-");
issue(dc, "### 1. Large files\ny\n");
fs.writeFileSync(path.join(dc, "comments.json"), "[]"); fs.writeFileSync(path.join(dc, "messages.json"), "[]");
run(mkEnv(dc), T0, quiet);
const dcState = JSON.parse(fs.readFileSync(path.join(dc, "state.json"), "utf8"));
dcState.told[keyOf("Large files")].handle = "large files";
fs.writeFileSync(path.join(dc, "state.json"), JSON.stringify(dcState));
fs.writeFileSync(path.join(dc, "messages.json"), JSON.stringify([{ id: 51, ts: ts(60), text: "large files: yes\nbut keep them on this computer" }]));
run(mkEnv(dc), T0 + 600e3, quiet);
const continuationPost = JSON.parse(fs.readFileSync(path.join(dc, "posts.log"), "utf8")).body;
assert.ok(continuationPost.includes("> large files: yes\n> but keep them on this computer"), "all continuation text is preserved");
assert.ok(continuationPost.includes("recommendation, choice 2"), "the leading yes still selects the recommendation");

// A handled free-text reply waits at the existing retry cursor when the classifier is transiently unavailable.
const dr = setup("oq-free-retry-");
issue(dr, "### 1. Free choice\ny\n\n### 2. Large files\ny\n");
fs.writeFileSync(path.join(dr, "comments.json"), "[]"); fs.writeFileSync(path.join(dr, "messages.json"), "[]");
run(mkEnv(dr), T0, quiet);
const drState = JSON.parse(fs.readFileSync(path.join(dr, "state.json"), "utf8"));
drState.told[keyOf("Free choice")].handle = "free";
drState.told[keyOf("Large files")].handle = "large";
fs.writeFileSync(path.join(dr, "state.json"), JSON.stringify(drState));
fs.writeFileSync(path.join(dr, "messages.json"), JSON.stringify([{ id: 61, ts: ts(60), text: "free: choose the slower option because it is safer\nlarge: yes" }]));
const retryFlag = path.join(dr, "classifier-once.flag");
const retryStub = path.join(dr, "classifier-retry.mjs");
fs.writeFileSync(retryStub, `import fs from "node:fs"; let input=""; process.stdin.on("data", c => input += c).on("end", () => { const request = JSON.parse(input); if (!fs.existsSync(${JSON.stringify(retryFlag)})) { fs.writeFileSync(${JSON.stringify(retryFlag)}, "once"); process.exit(1); } console.log(JSON.stringify({ text: JSON.stringify({ answers: [{ question: 1, meaning: "Choose the safer slower option." }] }) })); });`);
const retryEnv = mkEnv(dr, { OQ_MODEL_CMD: `node "${retryStub.replace(/\\/g, "/")}"` });
run(retryEnv, T0 + 600e3, quiet);
let retryState = JSON.parse(fs.readFileSync(path.join(dr, "state.json"), "utf8"));
assert.equal(posts(dr), 1, "the independent explicit answer relays while free text retries");
assert.equal(retryState.last_message_id || 0, 0, "the message cursor stays before the handled reply");
assert.equal(retryState.msg_tries[61], 1, "the existing retry counter records the failure");
run(retryEnv, T0 + 700e3, quiet);
retryState = JSON.parse(fs.readFileSync(path.join(dr, "state.json"), "utf8"));
assert.equal(posts(dr), 2, "the successful retry relays the handled free-text answer once");
assert.equal(retryState.last_message_id, 61, "the cursor advances only after a classifier result");

// A later handled free-text group keeps its own identity on retry after an earlier group posted.
const di = setup("oq-independent-retry-");
issue(di, "### 1. First choice\ny\n\n### 2. Second choice\ny\n");
fs.writeFileSync(path.join(di, "comments.json"), "[]"); fs.writeFileSync(path.join(di, "messages.json"), "[]");
run(mkEnv(di), T0, quiet);
const independentState = JSON.parse(fs.readFileSync(path.join(di, "state.json"), "utf8"));
independentState.told[keyOf("First choice")].handle = "first";
independentState.told[keyOf("Second choice")].handle = "second";
fs.writeFileSync(path.join(di, "state.json"), JSON.stringify(independentState));
fs.writeFileSync(path.join(di, "messages.json"), JSON.stringify([{ id: 62, ts: ts(60), text: "first: choose first\nsecond: choose second" }]));
const independentFlag = path.join(di, "second-classifier-once.flag");
const independentStub = path.join(di, "independent-classifier-retry.mjs");
fs.writeFileSync(independentStub, `import fs from "node:fs"; let input=""; process.stdin.on("data", c => input += c).on("end", () => { const request = JSON.parse(input); const message = /<message>\\n([\\s\\S]*?)\\n<\\/message>/.exec(request.prompt)[1]; const answer = question => console.log(JSON.stringify({ text: JSON.stringify({ answers: [{ question, meaning: question === 1 ? "Choose first." : "Choose second." }] }) })); if (message === "first: choose first") return answer(1); if (message !== "second: choose second") return answer(1); if (!fs.existsSync(${JSON.stringify(independentFlag)})) { fs.writeFileSync(${JSON.stringify(independentFlag)}, "once"); process.exit(1); } answer(2); });`);
const independentEnv = mkEnv(di, { OQ_MODEL_CMD: `node "${independentStub.replace(/\\/g, "/")}"` });
run(independentEnv, T0 + 600e3, quiet);
assert.equal(posts(di), 1, "the first group posts before the second classifier retry");
run(independentEnv, T0 + 700e3, quiet);
assert.equal(posts(di), 2, "the retry posts the second group without re-posting the first");
const independentPosts = fs.readFileSync(path.join(di, "posts.log"), "utf8");
assert.equal((independentPosts.match(/question 1: First choice/g) || []).length, 1, "the first group is never posted twice");
assert.equal((independentPosts.match(/question 2: Second choice/g) || []).length, 1, "the second group survives its retry");

testCase("a question told with the old 'read it yourself' message is asked again properly");
// a question told with the old "read it yourself" message is asked again properly
const df = setup("oq-l-");
issue(df, "### 3. Routines thing\nx\n"); fs.writeFileSync(path.join(df, "comments.json"), "[]"); fs.writeFileSync(path.join(df, "messages.json"), "[]");
fs.writeFileSync(path.join(df, "state.json"), JSON.stringify({ told: { [keyOf("Routines thing")]: { at: new Date(T0).toISOString(), heading: "Routines thing", handle: "q3", sent: "The software factory has a question for you that I could not put into plain words in time." } }, tries: {} }));
fs.writeFileSync(path.join(df, "g", ".godspeed", "notices.json"), JSON.stringify({ notices: [{ id: idOf(keyOf("Routines thing")), text: "old" }] }));
assert.equal(run(mkEnv(df), T0, quiet).sent.length, 1); assert.ok(noticesOf(df)[1].text.startsWith('Question "routines"'));
assert.ok(noticesOf(df)[1].id.endsWith("-again"), "the old message's id does not hide the new one");
testCase("answered in the chat takes a queued question out of the queue");
// answered in the chat takes a queued question out of the queue
fs.writeFileSync(path.join(dh, "answered-elsewhere.json"), JSON.stringify(["Routines thing"]));
run(mkEnv(dh), T0 + 700e3, quiet);
assert.ok(!JSON.parse(fs.readFileSync(path.join(dh, "mission-control-queue.json"), "utf8")).items.some(i => i.heading === "Routines thing"));
// "what do you mean?" without a handle, tied to no question by the model, still reaches the queue
const du = setup("oq-u-");
issue(du, "### 1. Sync problem\nx\n"); fs.writeFileSync(path.join(du, "comments.json"), "[]"); fs.writeFileSync(path.join(du, "messages.json"), "[]");
run(mkEnv(du), T0, quiet);
fs.writeFileSync(path.join(du, "messages.json"), JSON.stringify([{ id: 31, ts: ts(60), text: "what do you mean with that?" }]));
run(mkEnv(du), T0 + 600e3, quiet);
assert.equal(posts(du), 0);
assert.ok(JSON.parse(fs.readFileSync(path.join(du, "mission-control-queue.json"), "utf8")).items.some(i => i.why.includes("what do you mean with that")));
testCase("unreadable issue: nothing for a day, then a halt for the driver (every run while it holds), never a message to");
// unreadable issue: nothing for a day, then a halt for the driver (every run while it holds), never a message to him
const d5 = setup("oq-e-"); const t5 = Date.now();
assert.equal(run(mkEnv(d5), t5, quiet).halts.length, 0);
assert.equal(run(mkEnv(d5), t5 + 23 * 3600e3, quiet).halts.length, 0);
let h5 = run(mkEnv(d5), t5 + 25 * 3600e3, quiet);
assert.deepEqual(h5.sent, []); assert.deepEqual(h5.halts.map(h => h.key), ["unreadable"]); assert.match(h5.halts[0].words, /could not be read for a whole day/);
assert.equal(run(mkEnv(d5), t5 + 49 * 3600e3, quiet).halts.length, 1, "it holds");
assert.ok(!fs.existsSync(path.join(d5, "g", ".godspeed", "notices.json")), "a halt queues no notice");

testCase("the question list is missing while items wait for him: after a day it is a halt, no notice");
// the question list is missing while items wait for him: after a day it is a halt, no notice
const d6 = setup("oq-f-");
fs.writeFileSync(path.join(d6, "issues.json"), JSON.stringify([{ title: "Renamed", state: "open", labels: [{ name: "needs-owner" }] }]));
assert.equal(run(mkEnv(d6), T0, quiet).halts.length, 0);
const h6 = run(mkEnv(d6), T0 + 25 * 3600e3, quiet);
assert.deepEqual(h6.halts.map(h => h.key), ["missing-issue"]); assert.deepEqual(h6.sent, []);
assert.ok(!fs.existsSync(path.join(d6, "g", ".godspeed", "notices.json")), "a halt queues no notice");
assert.equal(queueNotice(path.join(d6, "g", ".godspeed", "notices.json"), { id: "x", text: "x" }), true, "the queue is untouched and still takes notices");
fs.writeFileSync(path.join(d6, "issues.json"), JSON.stringify([{ title: "Owner decisions needed", state: "open", number: 1, updated_at: "1", html_url: "u", body: "no questions", labels: [{ name: "needs-owner" }] }]));
assert.equal(run(mkEnv(d6), T0 + 26 * 3600e3, quiet).halts.length, 0, "the halt ends when the issue is back");

testCase("two projects: the product and the Forge add-on (D-415)");
// ---- two projects: the product and the Forge add-on (D-415)
assert.deepEqual(parseProjects(""), null);
assert.equal(parseProjects('["MichaelZelbel/godspeed-forge"]')[0].label, "godspeed-forge", "a repository alone gets plain words");
assert.equal(parseProjects('["o/thing"]')[0].label, "thing");
assert.throws(() => parseProjects('["not a repo"]'));
assert.ok(systemFor(FORGE, "Michael").includes("The factory builds the Forge") && systemFor(FORGE, "Michael").includes("using the Forge is always the reader, Michael:"));
assert.ok(systemFor(genericProject("a/b")).includes("The owner, " + DEFAULT_OWNER + ", is not"), "the owner is named from the settings, with a plain default");
assert.ok(systemFor(PRODUCT, "Michael").includes("The factory builds Godspeed, a personal AI assistant program"));
const P = PRODUCT.repo, F = FORGE.repo;
const dm = setup("oq-m-");
const both = (pb, fb) => fs.writeFileSync(path.join(dm, "issues.json"), JSON.stringify({
  [P]: [{ title: "Owner decisions needed", state: "open", number: 531, updated_at: "1", html_url: `https://github.com/${P}/issues/531`, body: pb }],
  [F]: [{ title: "Owner decisions needed", state: "open", number: 12, updated_at: "1", html_url: `https://github.com/${F}/issues/12`, body: fb }] }));
testCase("the product told 'Sync problem' before the Forge joined: it is not told again");
// the product told "Sync problem" before the Forge joined: it is not told again
fs.writeFileSync(path.join(dm, "state.json"), JSON.stringify({ told: { [keyOf("Old question")]: { at: new Date(T0).toISOString(), heading: "Old question", handle: "old", options: ["a.", "b."], recommended: 1, sent: "x" } }, tries: {}, last_message_id: 40 }));
both("### 1. Old question\nx\n\n### 2. Sync problem\nproduct body\n", "### 1. Sync problem\nforge body\n\n### 2. TESTS how checks run\nabout tests\n");
fs.writeFileSync(path.join(dm, "comments.json"), JSON.stringify({ [P]: [], [F]: [] })); fs.writeFileSync(path.join(dm, "messages.json"), "[]");
const envM = (extra = {}) => mkEnv(dm, { REPO: undefined, PROJECTS: [PRODUCT, FORGE], ...extra });
const r1 = run(envM(), T0, quiet);
assert.deepEqual(r1.sent, ["For Godspeed: Sync problem", "For the Forge add-on: Sync problem"], "each project's new question, the old one not again");
const nm = noticesOf(dm);
assert.equal(nm.length, 2);
assert.notEqual(nm[0].id, nm[1].id, "the same heading in two projects gives two notices");
assert.ok(nm[0].text.startsWith('Question "sync"\n\nFor Godspeed: When you') && nm[0].text.includes(`${P}/issues/531`));
assert.ok(nm[1].text.startsWith('Question "sync 2"\n\nFor the Forge add-on: When you') && nm[1].text.includes(`${F}/issues/12`), "the handle is unique across projects and the project is named");
assert.ok(fs.existsSync(path.join(dm, "state-michaelzelbel__godspeed-forge.json")), "the Forge keeps its own state");
assert.ok(JSON.parse(fs.readFileSync(path.join(dm, "state.json"), "utf8")).told[keyOf("Old question")], "the product keeps its own state file");
const qm = JSON.parse(fs.readFileSync(path.join(dm, "mission-control-queue.json"), "utf8"));
assert.equal(qm.items.length, 1); assert.equal(qm.items[0].project, "the Forge add-on"); assert.equal(qm.items[0].repo, F);
assert.ok(fs.readFileSync(path.join(dm, "g", "notebook", "Factory questions for Mission Control.md"), "utf8").includes("## For the Forge add-on: TESTS how checks run"));
assert.equal(run(envM(), T0 + 1000, quiet).sent.length, 0, "second run is silent for both");
testCase("replies: by handle to the right project, then a free-text one matched once across both");
// replies: by handle to the right project, then a free-text one matched once across both
const postsOf = () => { try { return fs.readFileSync(path.join(dm, "posts.log"), "utf8").split(/(?=\{"repo")/).filter(Boolean).map(s => JSON.parse(s)); } catch { return []; } };
fs.writeFileSync(path.join(dm, "messages.json"), JSON.stringify([{ id: 39, ts: ts(50), text: "sync 2: yes" }, { id: 41, ts: ts(60), text: "sync 2: yes" }]));
run(envM(), T0 + 600e3, quiet);
let pm = postsOf();
assert.equal(pm.length, 1, "a message before the cursor carried over from the product is not read again");
assert.equal(pm[0].repo, F); assert.equal(pm[0].number, 12); assert.ok(pm[0].body.includes("question 1: Sync problem") && pm[0].body.includes("> sync 2: yes"));
fs.writeFileSync(path.join(dm, "messages.json"), JSON.stringify([{ id: 42, ts: ts(70), text: "for the first one, do it" }]));
run(envM(), T0 + 700e3, quiet);
pm = postsOf();
assert.equal(pm.length, 2, "the free-text answer is posted once, not once per project");
assert.equal(pm[1].repo, P); assert.equal(pm[1].number, 531);
assert.ok(fs.existsSync(path.join(dm, "replies.json")) && JSON.parse(fs.readFileSync(path.join(dm, "replies.json"), "utf8")).last_message_id === 42, "one reply cursor for both projects");
run(envM(), T0 + 800e3, quiet);
assert.equal(postsOf().length, 2, "never posted twice");
testCase("one project unreadable: the other is still told, and the queue note keeps its items");
// one project unreadable: the other is still told, and the queue note keeps its items
const dn = setup("oq-n-");
fs.writeFileSync(path.join(dn, "issues.json"), JSON.stringify({ [F]: [{ title: "Owner decisions needed", state: "open", number: 3, updated_at: "1", body: "### 1. Sync problem\nx\n" }], [P]: "unreadable" }));
fs.writeFileSync(path.join(dn, "comments.json"), "{}"); fs.writeFileSync(path.join(dn, "messages.json"), "[]");
const rn = run(mkEnv(dn, { REPO: undefined, PROJECTS: [PRODUCT, FORGE] }), T0, quiet);
assert.equal(rn.ok, false); assert.deepEqual(rn.sent, ["For the Forge add-on: Sync problem"]);
testCase("while one list is unreadable his replies wait (one cursor for both), and are relayed once it is readable");
// while one list is unreadable his replies wait (one cursor for both), and are relayed once it is readable
fs.writeFileSync(path.join(dn, "messages.json"), JSON.stringify([{ id: 7, ts: ts(60), text: "sync: yes" }]));
run(mkEnv(dn, { REPO: undefined, PROJECTS: [PRODUCT, FORGE] }), T0 + 600e3, quiet);
assert.equal(posts(dn), 0, "no reply relayed while the product's list cannot be read");
const dnIssues = JSON.parse(fs.readFileSync(path.join(dn, "issues.json"), "utf8")); dnIssues[P] = []; fs.writeFileSync(path.join(dn, "issues.json"), JSON.stringify(dnIssues));
run(mkEnv(dn, { REPO: undefined, PROJECTS: [PRODUCT, FORGE] }), T0 + 700e3, quiet);
assert.equal(posts(dn), 1, "relayed once both lists are readable");
testCase("the Mission Control queue keeps an unreadable project's items");
// the Mission Control queue keeps an unreadable project's items
const dq = setup("oq-q-");
fs.writeFileSync(path.join(dq, "issues.json"), JSON.stringify({ [P]: [{ title: "Owner decisions needed", state: "open", number: 1, updated_at: "1", body: "### 1. TESTS product how\nx\n" }], [F]: [] }));
fs.writeFileSync(path.join(dq, "comments.json"), "{}"); fs.writeFileSync(path.join(dq, "messages.json"), "[]");
run(mkEnv(dq, { REPO: undefined, PROJECTS: [PRODUCT, FORGE] }), T0, quiet);
fs.writeFileSync(path.join(dq, "issues.json"), JSON.stringify({ [P]: "unreadable", [F]: [{ title: "Owner decisions needed", state: "open", number: 2, updated_at: "1", body: "### 1. TESTS forge how\nx\n" }] }));
run(mkEnv(dq, { REPO: undefined, PROJECTS: [PRODUCT, FORGE] }), T0 + 1000, quiet);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dq, "mission-control-queue.json"), "utf8")).items.map(i => i.repo).sort(), [P, F].sort());
testCase("a project list with the same repository twice is refused; only the product uses the old state file");
// a project list with the same repository twice is refused; only the product uses the old state file
assert.throws(() => parseProjects(JSON.stringify([F, F.toUpperCase()])));
assert.notEqual(stateFileOf({ STATE: "/s/state.json", MAIN_REPO: PRODUCT.repo }, FORGE), "/s/state.json", "a Forge-only run never uses the product's state");
assert.equal(stateFileOf({ STATE: "/s/state.json" }, PRODUCT), "/s/state.json");
assert.equal(stateFileOf({ STATE: "/s/state.json", MAIN_REPO: PRODUCT.repo }, { repo: PRODUCT.repo.toUpperCase() }), "/s/state.json", "the main project, however its name is cased");
testCase("a question Mission Control's queue worker handed to Michael is asked after all, never routed back");
// a question Mission Control's queue worker handed to Michael is asked after all, never routed back
const dt = setup("oq-t-");
issue(dt, "### 2. TESTS how checks run\nx\n"); fs.writeFileSync(path.join(dt, "comments.json"), "[]"); fs.writeFileSync(path.join(dt, "messages.json"), "[]");
assert.equal(run(mkEnv(dt), T0, quiet).sent.length, 0, "first routed to Mission Control");
fs.writeFileSync(path.join(dt, "to-michael.json"), JSON.stringify(["TESTS how checks run"]));
assert.equal(run(mkEnv(dt), T0 + 1000, quiet).sent.length, 1, "then asked as a full plain message");
assert.ok(noticesOf(dt)[0].text.startsWith('Question "tests"'));
testCase("the worker's decisions are shown in the note");
// the worker's decisions are shown in the note
fs.writeFileSync(path.join(dt, "decisions.jsonl"), JSON.stringify({ at: "2026-11-15T01:00:00Z", kind: "decided", repo: "o/r", question: "Q one", decision: "Do it." }) + "\n");
run(mkEnv(dt, { WORKER_LOG: path.join(dt, "decisions.jsonl") }), T0 + 2000, quiet);
assert.ok(fs.readFileSync(path.join(dt, "g", "notebook", "Factory questions for Mission Control.md"), "utf8").includes("decided (o/r): Q one. Do it."));
testCase("2026-11-15: the 'local voice' message must never reach him");
// ---- 2026-11-15: the "local voice" message must never reach him
const localVoice = `Question "local voice"

For Godspeed: When you write to Godspeed, it can reply using its local voice. This protection is ready, but cannot be added to the maintained release path without your decision.

The choice:
1. Keep the protected local voice behavior and let the team add it to the maintained release path.
2. Drop this protected local voice behavior.

My recommendation is choice 1.`;
const dPlain = setup("oq-pl-");
assert.ok(plainWords(localVoice, mkEnv(dPlain)).startsWith("jargon"), "caught by the word list even when the model would pass it");
const clean2 = renderMessage(good, "sync", "https://github.com/o/r/issues/7", "Godspeed");
assert.equal(plainWords(clean2, mkEnv(dPlain)), "", "a clear message about what a person experiences passes");
assert.ok(plainWords(clean2 + "\nPLAINFAIL", mkEnv(dPlain)).startsWith("not plain"), "the model's plain-words check can fail a message the word list passes");
assert.ok(plainWords(clean2, mkEnv(dPlain, { OQ_MODEL_CMD: "exit 1" })).length > 0, "no answer from the check: not sent");
testCase("a question the model words badly: three tries, then Mission Control's queue for good, never Telegram,");
// a question the model words badly: three tries, then Mission Control's queue for good, never Telegram,
// even when the queue worker handed it over as "for Michael"
const dx = setup("oq-x-");
issue(dx, "### 6. PLAINFAIL thing\nx\n"); fs.writeFileSync(path.join(dx, "comments.json"), "[]"); fs.writeFileSync(path.join(dx, "messages.json"), "[]");
fs.writeFileSync(path.join(dx, "to-michael.json"), JSON.stringify({ "o/r": ["PLAINFAIL thing"] }));
for (let i = 0; i < WORDING_TRIES + 3; i++) assert.equal(run(mkEnv(dx), T0 + i * 1000, quiet).sent.length, 0);
assert.ok(!fs.existsSync(path.join(dx, "g", ".godspeed", "notices.json")), "never sent after repeated failures");
const dxState = JSON.parse(fs.readFileSync(path.join(dx, "state.json"), "utf8"));
assert.ok(dxState.routed[keyOf("PLAINFAIL thing")].final && !dxState.told[keyOf("PLAINFAIL thing")] && !dxState.tries[keyOf("PLAINFAIL thing")]);
assert.equal(JSON.parse(fs.readFileSync(path.join(dx, "mission-control-queue.json"), "utf8")).items[0].bounced, true);
testCase("a question about workflow files is never his, however it would be worded");
// a question about workflow files is never his, however it would be worded
const dtech = setup("oq-tech-");
issue(dtech, "### 2. Add a line to the GitHub workflow for the voice-note test?"+String.fromCharCode(10)+"The factory may not write the workflow file."+String.fromCharCode(10));
assert.equal(run(mkEnv(dtech), T0, quiet).sent.length, 0);
assert.ok(!fs.existsSync(path.join(dtech, "g", ".godspeed", "notices.json")));
assert.equal(JSON.parse(fs.readFileSync(path.join(dtech, "mission-control-queue.json"), "utf8")).items[0].bounced, true);
testCase("a genuine question of what, handed over by the queue worker, with a clear message: still reaches him");
// a genuine question of what, handed over by the queue worker, with a clear message: still reaches him
const dg = setup("oq-gen-");
issue(dg, "### 1. Sync problem\nx\n"); fs.writeFileSync(path.join(dg, "comments.json"), "[]"); fs.writeFileSync(path.join(dg, "messages.json"), "[]");
fs.writeFileSync(path.join(dg, "to-michael.json"), JSON.stringify({ "o/r": ["Sync problem"] }));
assert.deepEqual(run(mkEnv(dg), T0, quiet).sent, ["Sync problem"]);
assert.ok(noticesOf(dg)[0].text.includes("When you edit a setting"));

testCase("the release driver's own question (D-419): asked like the manager's, with the item's link, and his");
// the release driver's own question (D-419): asked like the manager's, with the item's link, and his
// answer goes onto the item's own issue (where the driver reads it), not onto the owner issue
const dd = setup("oq-drv-");
issue(dd, "intro, no questions"); fs.writeFileSync(path.join(dd, "comments.json"), "[]"); fs.writeFileSync(path.join(dd, "messages.json"), "[]");
fs.writeFileSync(path.join(dd, "driver-questions.json"), JSON.stringify({ "o/r": [{ heading: "Sync problem on a release item (#612)", body: "When you edit a setting on two computers, syncing stops.", issue: 612 }] }));
assert.deepEqual(run(mkEnv(dd), T0, quiet).sent, ["Sync problem on a release item (#612)"], "a driver question is asked");
assert.ok(noticesOf(dd)[0].text.includes("https://github.com/o/r/issues/612"), "with the item's own link");
fs.writeFileSync(path.join(dd, "messages.json"), JSON.stringify([{ id: 21, ts: ts(60), text: "sync: yes" }]));
run(mkEnv(dd), T0 + 600e3, quiet);
const dlog = fs.readFileSync(path.join(dd, "posts.log"), "utf8");
assert.ok(dlog.includes('"number":612') && dlog.includes("Owner decision (question 901"), "his answer is posted on the item's issue");
assert.equal(run(mkEnv(dd), T0 + 900e3, quiet).sent.length, 0, "and it is never asked again");
testCase("two items with the same title are two questions");
// two items with the same title are two questions
const d2q = setup("oq-drv2-");
issue(d2q, "intro"); fs.writeFileSync(path.join(d2q, "comments.json"), "[]"); fs.writeFileSync(path.join(d2q, "messages.json"), "[]");
fs.writeFileSync(path.join(d2q, "driver-questions.json"), JSON.stringify({ "o/r": [{ heading: "Sync problem (#612)", body: "When you edit a setting on two computers, syncing stops.", issue: 612 }, { heading: "Sync problem (#613)", body: "When you edit a setting on two computers, syncing stops.", issue: 613 }] }));
assert.equal(run(mkEnv(d2q), T0, quiet).sent.length, 2, "one question per item");
