import { TEST_ENV } from "./env.mjs";
import test from "./harness.mjs";
import assert from "node:assert/strict";
import { engineGh, repairsFrom, recurring, issueFor, fileCauses, tripleKey } from "../causes.mjs";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const D = d => new Date(NOW - d * 86400000).toISOString();

// one repaired obstacle as decisions.jsonl records it: seen, helper launched, helper finished, cleared
const episode = ({ id, kind = "check-failed", helper = "product", cause = "product", daysAgo, ok = true, cleared = true, summary = "fixed it" }) => [
  { at: D(daysAgo + 0.2), kind: "obstacle", id, obstacle: kind, key: "rel#1" },
  { at: D(daysAgo + 0.1), kind: "launched", unit: `u-${id}`, helper, obstacle: id, obstacleKind: kind },
  { at: D(daysAgo + 0.05), kind: "helper finished", unit: `u-${id}`, obstacle: id, helper, state: ok ? "done" : "failed", cause, summary },
  ...(cleared ? [{ at: D(daysAgo), kind: "obstacle cleared", id }] : []),
];
const lines = recs => recs.map(r => JSON.stringify(r)).join("\n");

test("a repair is a helper that finished well and whose obstacle then cleared", () => {
  const r = repairsFrom(lines(episode({ id: "a", daysAgo: 3 })));
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].kind, r[0].helper, r[0].cause], ["check-failed", "product", "product"]);
  assert.equal(repairsFrom(lines(episode({ id: "a", daysAgo: 3, ok: false }))).length, 0, "a failed helper repaired nothing");
  assert.equal(repairsFrom(lines(episode({ id: "a", daysAgo: 3, cleared: false }))).length, 0, "an obstacle that did not clear was not repaired");
  assert.equal(repairsFrom(lines(episode({ id: "a", daysAgo: 3, helper: "diagnose", cause: "product" }))).length, 0, "a diagnosis repairs nothing");
});

test("the cause of a repair is the helper's own, else the diagnosis made before it", () => {
  const recs = [
    { at: D(3.5), kind: "obstacle", id: "x", obstacle: "parked", key: "" },
    { at: D(3.4), kind: "helper finished", unit: "d1", obstacle: "x", helper: "diagnose", state: "done", cause: "our-tests", summary: "the tool is missing" },
    { at: D(3.3), kind: "launched", unit: "t1", helper: "tests", obstacle: "x", obstacleKind: "parked" },
    { at: D(3.2), kind: "helper finished", unit: "t1", obstacle: "x", helper: "tests", state: "done", cause: "", summary: "built the tool" },
    { at: D(3.1), kind: "obstacle cleared", id: "x" },
  ];
  const r = repairsFrom(lines(recs));
  assert.equal(r.length, 1);
  assert.equal(r[0].cause, "our-tests");
});

test("the same triple repaired twice within 14 days is recurring; once, or 15 days apart, is not", () => {
  const two = repairsFrom(lines([...episode({ id: "a", daysAgo: 2 }), ...episode({ id: "b", daysAgo: 9 })]));
  const rec = recurring(two, NOW);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].count, 2);
  assert.equal(rec[0].where, "product");
  assert.equal(recurring(repairsFrom(lines(episode({ id: "a", daysAgo: 2 }))), NOW).length, 0);
  // two repairs but one of them outside the window
  const old = repairsFrom(lines([...episode({ id: "a", daysAgo: 2 }), ...episode({ id: "b", daysAgo: 16 })]));
  assert.equal(recurring(old, NOW).length, 0);
});

test("a different obstacle kind, helper kind or cause is a different triple", () => {
  const r = repairsFrom(lines([...episode({ id: "a", daysAgo: 2 }), ...episode({ id: "b", daysAgo: 3, kind: "no-progress" }), ...episode({ id: "c", daysAgo: 4, helper: "tests", cause: "product" })]));
  assert.equal(recurring(r, NOW).length, 0);
  assert.notEqual(tripleKey({ kind: "a", helper: "b", cause: "c" }), tripleKey({ kind: "a", helper: "b", cause: "d" }));
});

test("where a cause ticket goes: product -> product bug, our-tests or an ops repair -> engine, the rest none", () => {
  const w = (helper, cause) => recurring(repairsFrom(lines([...episode({ id: "a", daysAgo: 1, helper, cause }), ...episode({ id: "b", daysAgo: 2, helper, cause })])), NOW).map(x => x.where);
  assert.deepEqual(w("product", "product"), ["product"]);
  assert.deepEqual(w("tests", "our-tests"), ["engine"]);
  assert.deepEqual(w("ops", "external"), ["engine"]);
  assert.deepEqual(w("ops", "product"), ["product"]);
  assert.deepEqual(w("decide", "how"), []);
  assert.deepEqual(w("product", "feature"), []);
});

test("the issue is plain and carries its marker, labels and the repairs", () => {
  const rec = recurring(repairsFrom(lines([...episode({ id: "a", daysAgo: 1, summary: "renamed a file" }), ...episode({ id: "b", daysAgo: 2, summary: "renamed it again" })])), NOW)[0];
  const p = issueFor(rec, { REPO: "o/product", CAUSE_ENGINE_REPO: "o/engine" });
  assert.equal(p.repo, "o/product");
  assert.deepEqual(p.labels, ["bug"]);
  assert.match(p.body, /renamed a file/);
  assert.match(p.body, new RegExp(`factory-driver:cause:${rec.key}`));
  assert.doesNotMatch(p.title + p.body, /[—–]/);
  const e = issueFor({ ...rec, where: "engine" }, { REPO: "o/product", CAUSE_ENGINE_REPO: "o/engine" });
  assert.equal(e.repo, "o/engine");
  assert.deepEqual(e.labels, ["driver-cause"]);
});

const fakeGh = (opts = {}) => {
  const calls = [];
  const fn = (args, input) => {
    calls.push({ args, input });
    const a = args.join(" ");
    if (/POST/.test(a)) { if (opts.fail) throw new Error("HTTP 403"); return { number: 900 + calls.length, html_url: "https://github.com/x/y/issues/9" }; }
    const m = /issues\/(\d+)$/.exec(a);
    if (m) return { state: (opts.states || {})[m[1]] || "open", closed_at: (opts.closedAt || {})[m[1]] || null };
    throw new Error("unexpected " + a);
  };
  fn.calls = calls;
  return fn;
};
const decisions = lines([...episode({ id: "a", daysAgo: 2 }), ...episode({ id: "b", daysAgo: 5 })]);

test("fileCauses files one product bug and remembers it; the next round files nothing while it is open", async () => {
  const gh = fakeGh(), state = {}, rec = [];
  const a = await fileCauses({ REPO: "o/product" }, { decisions, gh, state, now: NOW, record: e => rec.push(e), notify: () => {} });
  assert.equal(a.filed.length, 1);
  assert.equal(gh.calls.filter(c => /POST/.test(c.args.join(" "))).length, 1);
  const post = gh.calls.find(c => /POST/.test(c.args.join(" ")));
  assert.match(post.args.join(" "), /repos\/o\/product\/issues/);
  assert.equal(JSON.parse(post.input).labels[0], "bug");
  assert.equal(Object.keys(state.causes).length, 1);
  const again = await fileCauses({ REPO: "o/product" }, { decisions, gh, state, now: NOW + 3600000, record: () => {}, notify: () => {} });
  assert.equal(again.filed.length, 0);
  assert.equal(gh.calls.filter(c => /POST/.test(c.args.join(" "))).length, 1, "never twice while one is open");
});

test("once its issue is closed, only repairs after that count; two new ones file a new issue", async () => {
  const gh = fakeGh({ states: { 77: "closed" }, closedAt: { 77: D(1.5) } });
  const key = recurring(repairsFrom(decisions), NOW)[0].key;
  const state = { causes: { [key]: { issue: 77, repo: "o/product", at: D(4) } } };
  const r1 = await fileCauses({ REPO: "o/product" }, { decisions, gh, state, now: NOW, record: () => {}, notify: () => {} });
  assert.equal(r1.filed.length, 0, "the two old repairs were before the issue closed");
  const more = lines([...episode({ id: "a", daysAgo: 2 }), ...episode({ id: "b", daysAgo: 5 }), ...episode({ id: "c", daysAgo: 1 }), ...episode({ id: "d", daysAgo: 0.5 })]);
  const r2 = await fileCauses({ REPO: "o/product" }, { decisions: more, gh, state, now: NOW, record: () => {}, notify: () => {} });
  assert.equal(r2.filed.length, 1);
});

test("an engine cause with no engine repository the driver can write to goes to the log only; Michael never hears of it", async () => {
  const d = lines([...episode({ id: "a", daysAgo: 1, helper: "tests", cause: "our-tests" }), ...episode({ id: "b", daysAgo: 2, helper: "tests", cause: "our-tests" })]);
  const gh = fakeGh(), rec = [], told = [], st = {};
  const r = await fileCauses({ REPO: "o/product", CAUSE_ENGINE_REPO: "" }, { decisions: d, gh, state: st, now: NOW, record: e => rec.push(e), notify: (k, t) => told.push([k, t]) });
  assert.equal(r.filed.length, 0);
  assert.equal(r.noted.length, 1);
  assert.equal(gh.calls.length, 0);
  assert.equal(rec[0].kind, "cause ticket not filed");
  assert.match(rec[0].title, /tests helper/);
  assert.match(rec[0].body, /factory-driver:cause:/, "the whole ticket text is in the log");
  assert.deepEqual(told, [], "a message he cannot act on is never sent");
  // noted once, not every round
  const r2 = await fileCauses({ REPO: "o/product", CAUSE_ENGINE_REPO: "" }, { decisions: d, gh, state: st, now: NOW + 600000, record: () => {}, notify: () => told.push(["again"]) });
  assert.equal(r2.noted.length, 0);
  assert.deepEqual(told, []);
});

test("an engine cause is filed and later looked up through the engine's own login, a product cause through the driver's", async () => {
  const d = lines([...episode({ id: "a", daysAgo: 1, helper: "ops", cause: "our-tests" }), ...episode({ id: "b", daysAgo: 2, helper: "ops", cause: "our-tests" })]);
  const gh = fakeGh(), ghEngine = fakeGh(), state = {};
  const env = { REPO: "o/product", CAUSE_ENGINE_REPO: "o/engine" };
  const r = await fileCauses(env, { decisions: d, gh, ghEngine, state, now: NOW, record: () => {}, notify: () => { throw new Error("no notice"); } });
  assert.equal(r.filed.length, 1);
  assert.equal(gh.calls.length, 0, "the driver's login never sees the engine repository");
  const post = ghEngine.calls.find(c => /POST/.test(c.args.join(" ")));
  assert.match(post.args.join(" "), /repos\/o\/engine\/issues/);
  assert.deepEqual(JSON.parse(post.input).labels, ["driver-cause"]);
  await fileCauses(env, { decisions: d, gh, ghEngine, state, now: NOW + 600000, record: () => {} });
  assert.ok(ghEngine.calls.some(c => /^repos\/o\/engine\/issues\/\d+$/.test(c.args.join(" "))), "whether it is still open is asked of the engine's login too");
  assert.equal(gh.calls.length, 0);
});

test("the engine's login is a token for the engine repository alone, allowed only to write issues, given to gh through its environment", () => {
  const minted = [], ran = [];
  const g = engineGh({ CAUSE_ENGINE_REPO: "o/engine", KEYS_FILE: "/k", TOKEN_SCRIPT: "/t" }, {
    mint: (e, perms) => { minted.push([e.REPO, perms]); return "tok123"; },
    spawn: (file, args, opts) => { ran.push({ file, args, env: opts.env, input: opts.input }); return { status: 0, stdout: '{"number": 5}', stderr: "" }; },
  });
  assert.deepEqual(g(["-X", "POST", "repos/o/engine/issues", "--input", "-"], "{}"), { number: 5 });
  g(["repos/o/engine/issues/5"]);
  assert.deepEqual(minted, [["o/engine", "issues=write,metadata=read"]], "minted once, narrow");
  assert.equal(ran[0].file, "gh");
  assert.ok(!ran[0].args.join(" ").includes("tok123"), "never on the command line");
  assert.equal(ran[0].env.GH_TOKEN, "tok123");
  assert.notEqual(ran[0].env.HOME, "/root", "never root's own GitHub login");
});

test("a GitHub refusal is recorded and retried next round, never thrown", async () => {
  const gh = fakeGh({ fail: true }), rec = [], state = {};
  const r = await fileCauses({ REPO: "o/product" }, { decisions, gh, state, now: NOW, record: e => rec.push(e), notify: () => {} });
  assert.equal(r.filed.length, 0);
  assert.equal(r.failed.length, 1);
  assert.equal(state.causes, undefined);
});
