// test cases: 31
import "./settings-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, runCases } from "../case-test.mjs";
import { spawnSync } from "node:child_process";
import * as P from "../../../steps/release/auto-plan.mjs";
import * as A from "../../../steps/release/auto-stage.mjs";
import { PRODUCT_REPO } from "../../../steps/release/staging.mjs";

const REPO = PRODUCT_REPO;
const plan = ({ version = "2.0.0-beta.26", status = "approved by Michael on 2026-11-16", issues = "item 1 #679, 2 #590, 3 #667", notDo = "- Contract switching (#379), one home (#90): each still needs Michael's answer.\n- The factory's Telegram questions (#600).", repo = REPO } = {}) =>
  `---\nrelease: godspeed-${version}-x\nrepository: ${repo}\n---\n\n# Godspeed ${version}: x\n\nStatus: ${status}\n\n## What it delivers\n\n1. One.\n\nIssues: ${issues}\n\n## What it does not do\n\n${notDo}\n\n## How it is built\n\nCaps: three attempts or two send-backs per item, then \`needs-owner\`; an item that reaches a dead end leaves the release, the rest ships.\n`;
const ready = (version) => ({ version, status: "installed", lastCheck: { result: "ready" } });

// ---------- versions ----------

test("the next version is the next in the line", () => {
  assert.equal(P.nextVersion("2.0.0-beta.26"), "2.0.0-beta.27");
  assert.equal(P.nextVersion("2.0.0-beta.18.1"), "2.0.0-beta.19");
  assert.equal(P.nextVersion("2.0.0"), "2.0.1");
  assert.equal(P.nextVersion("nonsense"), null);
  assert.equal(P.versionWords("2.0.0-beta.27"), "Beta 27");
  assert.equal(P.releaseLabel("2.0.0-beta.27"), "beta.27");
  assert.equal(P.planStatus(plan({ status: "proposed (2026-11-17)" })), "proposed");
});

// ---------- the trigger ----------

const rel = (version, opts = {}, staging = null, slug = "x") => ({ id: `godspeed-${version}-${slug}`, plan: plan({ version, ...opts }), staging });

test("it waits while the newest approved release is not staged (today: beta.26 is still building)", () => {
  const releases = [rel("2.0.0-beta.25", {}, ready("2.0.0-beta.25")), rel("2.0.0-beta.26"), rel("2.0.0-beta.27", { status: "proposed (2026-11-17)" })];
  const t = P.judgeTrigger({ releases, repo: REPO });
  assert.equal(t.start, false);
  assert.match(t.why, /2\.0\.0-beta\.26.*still in flight.*not on the server yet/);
});

test("it waits while the staged record is not installed or its last check is not ready", () => {
  const failed = { ...ready("2.0.0-beta.26"), status: "failed" };
  assert.match(P.judgeTrigger({ releases: [rel("2.0.0-beta.26", {}, failed)], repo: REPO }).why, /not installed/);
  const unchecked = { ...ready("2.0.0-beta.26"), lastCheck: { result: "waiting" } };
  assert.match(P.judgeTrigger({ releases: [rel("2.0.0-beta.26", {}, unchecked)], repo: REPO }).why, /did not find 2\.0\.0-beta\.26 ready/);
});

test("a go over failures counts as finished only when his words are there and every failed job is waived", () => {
  const V = "2.0.0-beta.26";
  const failedCheck = {
    version: V, status: "installed", installedAt: "2026-11-16T07:00:00Z", healthAfter: { ok: true, version: V },
    lastCheck: { result: "scenariosFailed", failures: [] },
    scenarios: { result: "failed", run: 1, failedJobs: ["job a", "job b"] },
  };
  const go = (over = {}) => ({ version: V, at: "2026-11-16T10:00:00Z", words: "go", waived: ["job a", "job b"], ...over });
  const state = (staging, g) => { const r = rel(V, {}, staging); r.go = g; return P.judgeTrigger({ releases: [r], repo: REPO }); };
  assert.equal(state(ready(V), null).start, true, "check ready");
  assert.equal(state(failedCheck, go()).start, true, "every failure waived by the go");
  assert.equal(state(failedCheck, go({ waived: ["job a"] })).start, false, "one failure not waived");
  assert.equal(state(failedCheck, null).start, false, "no go");
  assert.equal(state(failedCheck, go({ words: "" })).start, false, "no words of his");
  assert.match(state(failedCheck, go({ waived: ["job a"] })).why, /still in flight/);
});

test("it starts once the newest approved release is installed and ready, and finds the proposed plan of the next version", () => {
  const releases = [
    rel("2.0.0-beta.25", {}, ready("2.0.0-beta.25")),
    rel("2.0.0-beta.26", { status: "withdrawn (2026-11-15)" }, null, "keeps-its-word"),
    rel("2.0.0-beta.26", {}, ready("2.0.0-beta.26"), "steady"),
    rel("2.0.0-beta.27", { status: "proposed (2026-11-17)" }, null, "sees-it-through"),
    rel("2.0.0-beta.30", {}, null, "clerk-thing"),
  ];
  releases[4].plan = plan({ version: "2.0.0-beta.30", repo: "MichaelZelbel/godspeed-clerk" });
  const t = P.judgeTrigger({ releases, repo: REPO });
  assert.equal(t.start, true, t.why);
  assert.equal(t.staged.id, "godspeed-2.0.0-beta.26-steady");
  assert.equal(t.next, "2.0.0-beta.27");
  assert.equal(t.proposed.id, "godspeed-2.0.0-beta.27-sees-it-through");
});

test("one release in flight at a time: a newer approved or in-progress plan means wait", () => {
  const staged = rel("2.0.0-beta.26", {}, ready("2.0.0-beta.26"));
  assert.match(P.judgeTrigger({ releases: [staged, rel("2.0.0-beta.27")], repo: REPO }).why, /2\.0\.0-beta\.27.*still in flight/);
  assert.match(P.judgeTrigger({ releases: [staged, rel("2.0.0-beta.27", { status: "building" })], repo: REPO }).why, /in progress/);
  assert.equal(P.judgeTrigger({ releases: [staged, rel("2.0.0-beta.27", { status: "withdrawn" })], repo: REPO }).start, true);
  assert.equal(P.judgeTrigger({ releases: [], repo: REPO }).start, false);
});

// ---------- the bugs-only filter ----------

const MZ = { login: "MichaelZelbel", __typename: "User" };
const BOT = { login: "godspeed-dev-builder", __typename: "Bot" };
const issue = (number, labels, author = BOT, title = `issue ${number}`) => ({ number, title, body: `body of ${number}`, author, labels: labels.map((name) => ({ name })), comments: [] });
const OPEN = [
  issue(679, ["bug", "needs-owner"], MZ),
  issue(590, ["needs-owner", "beta.26"]), // a deferred ticket's issue, no bug label
  issue(697, ["bug", "priority"]),
  issue(698, ["priority"]),
  issue(652, []),
  issue(379, ["enhancement", "needs-owner"], MZ),
  issue(90, ["bug", "needs decision"], MZ),
  issue(299, ["bug", "needs-owner"], MZ),
  issue(1, ["known issue"], MZ),
  issue(413, ["needs-owner"], MZ),
  issue(600, ["needs-owner"], MZ),
  issue(800, ["bug"], { login: "stranger", __typename: "User" }),
  issue(801, ["bug"], { login: "godspeed-dev-builder", __typename: "User" }), // a person who took the App's name
];
const STAGED = { id: "godspeed-2.0.0-beta.26-steady", version: "2.0.0-beta.26", plan: plan({ notDo: "- the coach add-on copy against its pin (#299), the owner's approval gate (#413), one home (#90): each needs Michael's answer.\n- The factory's Telegram questions (#600): outside the product." }) };
const AMEND = { deferredTickets: ["02-chat-says-refused-key.md"] };

test("only bugs, priority work and left-over tickets go in; wishes, known issues, questions for Michael and strangers stay out", () => {
  const c = P.bugsOnly({ openIssues: OPEN, staged: STAGED, amendment: AMEND, deferredTexts: { "02-chat-says-refused-key.md": "ticket text" }, nightly: [{ job: "the verdict", cause: "" }, { job: "two computers that move the same reminders at once", cause: "token not set" }] });
  assert.deepEqual(c.sources.map((s) => s.id), ["deferred:02-chat-says-refused-key.md", "#679", "#697", "#698", "scenario:two computers that move the same reminders at once"]);
  assert.deepEqual(c.allowedIssues, [590, 679, 697, 698]);
  const out = Object.fromEntries(c.excluded.map((e) => [e.id, e.why]));
  assert.match(out["#379"], /wish/);
  assert.match(out["#90"], /needs decision/);
  assert.match(out["#299"], /does not do/);
  assert.match(out["#1"], /known issue/);
  assert.match(out["#600"], /does not do/);
  assert.match(out["#800"], /does not trust/);
  assert.match(out["#801"], /does not trust/, "the bare App name counts only when GitHub says it is a bot");
  assert.match(out["#652"], /neither/);
  assert.deepEqual(c.wishes.map((w) => w.id), ["#379", "#413", "#600"]);
  assert.ok(!c.sources.some((s) => s.id === "scenario:the verdict"), "the summary job is not a scenario of its own");
});

test("the proposed plan's own 'does not do' also keeps an issue out", () => {
  const proposed = plan({ version: "2.0.0-beta.27", status: "proposed", notDo: "- The factory machine's notebook service (#698): Mission Control's machinery." });
  const c = P.bugsOnly({ openIssues: OPEN, staged: STAGED, amendment: AMEND, proposedPlan: proposed });
  assert.ok(!c.allowedIssues.includes(698));
});

// ---------- the deterministic check ----------

const BODY = (extra = "") => `${extra}## Problem\nIt breaks.\n\n## Why\nIt matters.\n\n## Why now\nNow.\n\n## Outcome\nFixed.\n\n## Invariants\n- Nothing else changes.\n\n## Acceptance\n- A test.\n\n## Done means\nThe test passes.`;
const item = (number, over = {}) => ({ number, title: `Fix ${number}`, size: "light", depends_on: "nothing", issue: "#679", sources: ["#679"], ticket_slug: `fix-${number}`, body: BODY(), plain_fix: `thing ${number}`, ...over });
const GOOD = () => ({
  title: "sees it through",
  slug: "sees-it-through",
  plan_body: "## What it delivers (what changes for the person)\n\n1. A.\n2. B.\n\n## What it does not do\n\n- #379 needs his answer.\n\n## How it is built\n\nCaps: three attempts or two send-backs per item, then `needs-owner`; an item that reaches a dead end leaves the release, the rest ships.\n",
  items: [item(1), item(2, { issue: "#590", sources: ["deferred:02-chat-says-refused-key.md"], plain_fix: "the chat calling a refused key an outage (#590)" })],
  wishes: [{ source: "#379", words: "Godspeed keeps every contract from costing more than it needs to" }, { source: "#999", words: "made up" }],
  left_out: [],
});
const CONTENT = () => P.bugsOnly({ openIssues: OPEN, staged: STAGED, amendment: AMEND, nightly: [{ job: "two computers that move the same reminders at once", cause: "token not set" }] });

test("a plan of bugs and left-over tickets with every part passes the check", () => {
  const r = P.checkPlan(GOOD(), CONTENT());
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test("the check refuses more than eight items, a source that is no bug, a missing part, a missing cut rule", () => {
  const nine = GOOD();
  nine.items = Array.from({ length: 9 }, (_, i) => item(i + 1, { issue: "new" }));
  assert.match(P.checkPlan(nine, CONTENT()).problems.join(" | "), /9 items, and at most 8/);

  const feature = GOOD();
  feature.items[0] = item(1, { issue: "#379", sources: ["#379"] });
  const fp = P.checkPlan(feature, CONTENT()).problems.join(" | ");
  assert.match(fp, /comes from #379, which is not a bug/);
  assert.match(fp, /built on #379, which is not an open bug/);

  const missing = GOOD();
  missing.items[1].body = BODY().replace("## Why now\nNow.\n\n", "");
  assert.match(P.checkPlan(missing, CONTENT()).problems.join(" | "), /item 2 lacks its "Why now" part/);

  const noRule = GOOD();
  noRule.plan_body = noRule.plan_body.replace(/; an item that reaches.*ships/, "");
  assert.match(P.checkPlan(noRule, CONTENT()).problems.join(" | "), /lacks the rule/);

  const noDoes = GOOD();
  noDoes.plan_body = noDoes.plan_body.replace("## What it does not do", "## Out of scope");
  assert.match(P.checkPlan(noDoes, CONTENT()).problems.join(" | "), /What it does not do/);

  const shared = GOOD();
  shared.items[1] = item(2);
  assert.match(P.checkPlan(shared, CONTENT()).problems.join(" | "), /shares #679/);

  const order = GOOD();
  order.items[1].number = 3;
  assert.match(P.checkPlan(order, CONTENT()).problems.join(" | "), /not numbered/);
  assert.equal(P.checkPlan(null, CONTENT()).ok, false);
});

test("an item that may change what a scenario judges needs its owner decision up front", () => {
  const p = GOOD();
  p.items.push(item(3, { issue: "new", sources: ["scenario:two computers that move the same reminders at once"] }));
  assert.match(P.checkPlan(p, CONTENT()).problems.join(" | "), /item 3 may change what a check or scenario judges but has no owner decision up front/);
  p.items[2].body = BODY("## Owner decision\nOnly equal or stricter.\n\n");
  assert.equal(P.checkPlan(p, CONTENT()).ok, true);
  p.items[2].body = `${BODY()}\n\n## Owner decision\nlate`;
  assert.match(P.checkPlan(p, CONTENT()).problems.join(" | "), /after the problem/);
  const q = GOOD();
  q.items[0].body = BODY().replace("Fixed.", "If the cause is only the scenario, fix the scenario.");
  assert.match(P.checkPlan(q, CONTENT()).problems.join(" | "), /no owner decision up front/);
});

// ---------- composing ----------

test("the composed plan is approved by the standing decision and readable by auto-stage and the release driver", () => {
  const out = GOOD();
  const text = P.planText({ releaseId: "godspeed-2.0.0-beta.27-sees-it-through", version: "2.0.0-beta.27", repo: REPO, out: { ...out, plan_body: `Status: proposed\nIssues: item 1 #1\n${out.plan_body}` }, issues: { 1: 679, 2: 590 }, staged: STAGED, date: "2026-11-18" });
  assert.ok(text.includes(P.statusLine()));
  assert.ok(A.planApproved(text));
  assert.equal(A.planRepository(text), REPO);
  assert.equal(A.planTitle(text), "sees it through");
  assert.deepEqual(A.itemIssues(text), { 1: 679, 2: 590 });
  assert.ok(P.CUT_RULE.test(text));
  assert.equal((text.match(/^Status:/gm) || []).length, 1, "the AI's own Status line is dropped");
  assert.equal((text.match(/Issues:/g) || []).length, 1, "the AI's own Issues line is dropped");
  assert.ok(text.indexOf("Issues: item 1 #679, 2 #590") < text.indexOf("## What it does not do"));
});

test("every ticket gets its first line and the Blocks line in its invariants", () => {
  const t = P.ticketText({ version: "2.0.0-beta.27", item: item(4, { depends_on: "item 2." }), repo: REPO, issue: 679 });
  assert.ok(t.startsWith(`Ticket for 2.0.0-beta.27 (plan item 4). Size: light. Depends on: item 2. Repository: ${REPO}. Issue: #679.\n\n## Problem`));
  assert.ok(P.section(t, "Invariants").includes(P.BLOCKS_LINE));
  assert.ok(t.indexOf(P.BLOCKS_LINE) < t.indexOf("## Acceptance"));
  assert.equal(P.withBlocksLine(P.withBlocksLine(BODY())), P.withBlocksLine(BODY()), "added once");
  assert.equal(P.ticketPath("r", item(4)), "releases/r/tickets/04-fix-4.md");
});

test("the messages are plain: no issue numbers, only real wishes", () => {
  const c = CONTENT();
  assert.equal(P.startedMessage("2.0.0-beta.27", GOOD()), "Beta 27 started: it fixes thing 1 and the chat calling a refused key an outage.");
  assert.equal(P.wishesMessage(GOOD(), c), "This wish waits for your yes: godspeed keeps every contract from costing more than it needs to.");
  const two = { wishes: [{ source: "#379", words: "A." }, { source: "#413", words: "B" }] };
  assert.equal(P.wishesMessage(two, c), "These 2 wishes wait for your yes: a and b.");
  assert.equal(P.wishesMessage({ wishes: [] }, c), null);
});

test("the strongest tier of the factory's config is the model", () => {
  const yaml = "defaultAssistant: codex\nassistants:\n  codex:\n    model: gpt-5.6-terra\ntiers:\n  small: { provider: codex, model: gpt-5.6-terra }\n  medium: { provider: codex, model: gpt-5.6-terra }\n  large: { provider: codex, model: gpt-5.6-sol }\n";
  assert.equal(P.strongestModel(yaml), "gpt-5.6-sol");
  assert.equal(P.strongestModel(yaml.replace(/  large.*\n/, "")), "gpt-5.6-terra");
  assert.equal(P.strongestModel("assistants:\n  codex:\n    model: gpt-x\n"), "gpt-x");
});

// ---------- one look, against stand-ins ----------

const PROPOSED_27 = plan({ version: "2.0.0-beta.27", status: "proposed (2026-11-17). Michael asked: \"Plan Release Godspeed Beta\".", issues: "item 1 #679, 2 #590, 3 #697" });

function world({ staged = ready("2.0.0-beta.26"), codexOut = GOOD(), proposed = PROPOSED_27 } = {}) {
  const files = {
    "releases/godspeed-2.0.0-beta.26-steady/plan.md": STAGED.plan,
    "releases/godspeed-2.0.0-beta.26-steady/scope-amendment.json": JSON.stringify(AMEND),
    "releases/godspeed-2.0.0-beta.26-steady/tickets/02-chat-says-refused-key.md": "Ticket for 2.0.0-beta.26 (plan item 2).\n\n## Problem\nx",
    "roles/planner.md": "# Planner\nsteps",
    "process.md": "## 3. What one release is\nA plan.\n## 4. Next\n",
  };
  if (staged) files["releases/godspeed-2.0.0-beta.26-steady/staging.json"] = JSON.stringify(staged);
  if (proposed) {
    files["releases/godspeed-2.0.0-beta.27-sees-it-through/plan.md"] = proposed;
    files["releases/godspeed-2.0.0-beta.27-sees-it-through/tickets/09-old.md"] = "old ticket";
  }
  const calls = { codex: [], gh: [], commits: [], notices: [], labels: [] };
  const issues = OPEN.map((i) => ({ ...i, labels: [...i.labels] }));
  let now = Date.parse("2026-11-18T08:00:00Z");
  const state = { version: 1, triggers: {}, runs: [] };
  const log = [];
  const ctx = {
    cfg: P.loadConfig({}),
    log: (s) => log.push(s),
    now: () => now,
    dry: false,
    state,
    save: () => {},
    records: {
      releases: () => [...new Set(Object.keys(files).filter((f) => f.startsWith("releases/")).map((f) => f.split("/")[1]))],
      read: (rel) => (rel in files ? files[rel] : null),
      json: (rel) => (rel in files && files[rel] !== null ? JSON.parse(files[rel]) : null),
      ticketFiles: (id) => Object.keys(files).filter((f) => f.startsWith(`releases/${id}/tickets/`) && files[f] !== null),
    },
    openIssues: async () => issues,
    nightly: async () => [],
    model: () => "gpt-5.6-sol",
    codex: async (prompt, schema, model) => {
      calls.codex.push({ prompt, model });
      return typeof codexOut === "function" ? codexOut() : codexOut;
    },
    write: (changes, message) => {
      calls.commits.push({ changes, message });
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) delete files[k];
        else files[k] = v;
      }
      return "c".repeat(40);
    },
    gh: (method, p, body) => {
      calls.gh.push({ method, p, body });
      if (method === "POST" && /\/issues$/.test(p)) {
        const made = issue(900 + calls.gh.length, body.labels);
        made.body = body.body;
        issues.push(made);
        return { number: made.number };
      }
      return {};
    },
    comments: async () => [],
    ensureLabel: async (name) => calls.labels.push(name),
    notify: (n) => calls.notices.push(n),
  };
  return { ctx, files, calls, log, state, tick: (ms) => (now += ms) };
}

test("the full look: it adopts the proposed beta.27, files it in place, and tells him once", async () => {
  const w = world();
  const r = await P.autoPlan(w.ctx);
  assert.equal(r.outcome, "started", w.log.join("\n"));
  assert.equal(w.calls.codex.length, 1);
  assert.equal(w.calls.codex[0].model, "gpt-5.6-sol");
  assert.match(w.calls.codex[0].prompt, /ADOPT THE PROPOSED PLAN/);
  assert.match(w.calls.codex[0].prompt, /<proposed_plan release="godspeed-2.0.0-beta.27-sees-it-through">/);
  assert.ok(!w.calls.codex[0].prompt.includes("body of 800"), "a stranger's text never reaches the planner");
  // one commit, in the proposed plan's own folder, its old ticket removed
  assert.equal(w.calls.commits.length, 1);
  const ch = w.calls.commits[0].changes;
  const planFile = ch["releases/godspeed-2.0.0-beta.27-sees-it-through/plan.md"];
  assert.ok(planFile.includes(P.statusLine()));
  assert.deepEqual(A.itemIssues(planFile), { 1: 679, 2: 590 });
  assert.equal(ch["releases/godspeed-2.0.0-beta.27-sees-it-through/tickets/09-old.md"], null);
  assert.ok(ch["releases/godspeed-2.0.0-beta.27-sees-it-through/tickets/01-fix-1.md"].startsWith("Ticket for 2.0.0-beta.27 (plan item 1)"));
  assert.ok(!Object.keys(ch).some((k) => k.includes("godspeed-2.0.0-beta.27-sees-it-through") === false), "no second plan folder");
  // owner decisions, labels
  const posts = w.calls.gh.filter((c) => /\/comments$/.test(c.p));
  assert.deepEqual(posts.map((c) => c.p.match(/issues\/(\d+)/)[1]), ["679", "590"]);
  assert.match(posts[0].body.body, /^Owner decision \(2026-11-18\): this issue is item 1 of Godspeed 2\.0\.0-beta\.27, a bug-fix release started by the owner's standing decision/);
  assert.deepEqual(w.calls.labels, ["beta.27"]);
  assert.ok(w.calls.gh.some((c) => c.method === "POST" && c.p.endsWith("/issues/679/labels") && c.body.labels[0] === "beta.27"));
  assert.ok(w.calls.gh.some((c) => c.method === "DELETE" && c.p.endsWith("/issues/679/labels/needs-owner")));
  // everything else open stays parked, except priority work
  const parked = w.calls.gh.filter((c) => c.method === "POST" && /labels$/.test(c.p) && c.body.labels[0] === "needs-owner").map((c) => Number(c.p.match(/issues\/(\d+)/)[1]));
  assert.ok(parked.includes(652) && !parked.includes(697) && !parked.includes(698) && !parked.includes(679));
  // told once, wishes once
  assert.deepEqual(w.calls.notices.map((n) => n.id), ["auto-plan-2.0.0-beta.27-started", "auto-plan-2.0.0-beta.27-wishes"]);
  assert.equal(w.calls.notices[0].text, "Beta 27 started: it fixes thing 1 and the chat calling a refused key an outage.");
  // the next look does nothing: beta.27 is now approved and in flight
  const again = await P.autoPlan(w.ctx);
  assert.equal(again.outcome, "waiting");
  assert.equal(w.calls.codex.length, 1);
  assert.equal(w.calls.notices.length, 2);
});

test("it waits, and runs nothing, while beta.26 is not staged", async () => {
  const w = world({ staged: null });
  const r = await P.autoPlan(w.ctx);
  assert.equal(r.outcome, "waiting");
  assert.match(r.why, /2\.0\.0-beta\.26.*not on the server yet/);
  assert.equal(w.calls.codex.length + w.calls.commits.length + w.calls.gh.length + w.calls.notices.length, 0);
});

test("a dry run says what it would do and runs no Codex", async () => {
  const w = world();
  w.ctx.dry = true;
  const r = await P.autoPlan(w.ctx);
  assert.equal(r.outcome, "would-plan");
  assert.equal(r.adopt, true);
  assert.equal(w.calls.codex.length + w.calls.commits.length + w.calls.gh.length + w.calls.notices.length, 0);
  assert.match(w.log.join("\n"), /Would run Codex once/);
});

test("a proposed plan that names no open bug is replaced by a fresh one and marked withdrawn", async () => {
  const w = world({ proposed: plan({ version: "2.0.0-beta.27", status: "proposed", issues: "item 1 #12345" }), codexOut: { ...GOOD(), slug: "Holds Steady" } });
  const r = await P.autoPlan(w.ctx);
  assert.equal(r.releaseId, "godspeed-2.0.0-beta.27-holds-steady");
  assert.doesNotMatch(w.calls.codex[0].prompt, /ADOPT THE PROPOSED PLAN/);
  assert.match(w.calls.commits[0].changes["releases/godspeed-2.0.0-beta.27-sees-it-through/plan.md"], /^Status: withdrawn \(2026-11-18\): none of its items/m);
});

test("a plan that fails the check files nothing, says so once, and is never run again for that trigger", async () => {
  const bad = GOOD();
  bad.items[0] = item(1, { issue: "#379", sources: ["#379"] }); // a wish
  const w = world({ codexOut: bad });
  const r = await P.autoPlan(w.ctx);
  assert.equal(r.outcome, "check-failed");
  assert.equal(w.calls.commits.length + w.calls.gh.length, 0);
  // a halt is the driver's work: the step sends nobody anything, it returns the halt
  assert.equal(w.calls.notices.length, 0);
  assert.equal(r.halt.key, "check-failed");
  assert.match(r.halt.words, /^Beta 27 did not start by itself: the plan the AI wrote for it did not pass its check \(item 1 comes from #379/);
  assert.doesNotMatch(r.halt.words, /Mission Control|by hand|should look/);
  assert.match(r.halt.clear, /--step plan --clear-halt check-failed/);
  assert.ok(w.state.triggers["2.0.0-beta.26"].halted);
  const again = await P.autoPlan(w.ctx);
  assert.equal(again.outcome, "halted");
  assert.equal(again.halt.key, "check-failed", "the halt stands until it is cleared");
  assert.equal(w.calls.codex.length, 1);
  assert.equal(w.calls.notices.length, 0);
});

test("a run that started and never finished is not run again; the daily limit holds", async () => {
  const w = world();
  w.state.triggers["2.0.0-beta.26"] = { codexStartedAt: "2026-11-18T07:00:00Z" };
  const hr = await P.autoPlan(w.ctx);
  assert.equal(hr.outcome, "halted");
  assert.equal(w.calls.codex.length, 0);
  assert.equal(w.calls.notices.length, 0, "a halt queues no notice");
  assert.equal(hr.halt.key, "run-unfinished");
  assert.match(hr.halt.words, /started but did not finish/);

  const v = world();
  v.state.runs = ["2026-11-18T01:00:00Z", "2026-11-18T02:00:00Z", "2026-11-18T03:00:00Z"];
  assert.equal((await P.autoPlan(v.ctx)).outcome, "waiting");
  assert.equal(v.calls.codex.length, 0);
});

test("a new issue is opened for an item without one, and a crash in the filing resumes without a second run or a second issue", async () => {
  const out = GOOD();
  out.items.push(item(3, { issue: "new", sources: ["#697"], body: BODY() }));
  const w = world({ codexOut: out });
  const realWrite = w.ctx.write;
  w.ctx.write = () => {
    throw new Error("push refused");
  };
  await assert.rejects(P.autoPlan(w.ctx), /push refused/);
  const opened = w.calls.gh.filter((c) => c.method === "POST" && /\/issues$/.test(c.p));
  assert.equal(opened.length, 1);
  assert.match(opened[0].body.body, /<!-- auto-plan:2\.0\.0-beta\.27:item-3 -->/);
  w.ctx.write = realWrite;
  const r = await P.autoPlan(w.ctx);
  assert.equal(r.outcome, "started");
  assert.equal(w.calls.codex.length, 1);
  assert.equal(w.calls.gh.filter((c) => c.method === "POST" && /\/issues$/.test(c.p)).length, 1);
  assert.match(w.calls.commits[0].changes["releases/godspeed-2.0.0-beta.27-sees-it-through/plan.md"], /Issues: item 1 #679, 2 #590, 3 #9\d\d/);
});

// ---------- the record commit ----------

test("writeRecords commits written and removed files on top of main and pushes them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-plan-git-"));
  const git = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  spawnSync("git", ["clone", "-q", origin, work]);
  git(work, "config", "user.email", "t@t");
  git(work, "config", "user.name", "t");
  fs.mkdirSync(path.join(work, "releases/r/tickets"), { recursive: true });
  fs.writeFileSync(path.join(work, "releases/r/tickets/09-old.md"), "old");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "origin", "HEAD:main");
  const c = P.writeRecords(work, { "releases/r/plan.md": "plan\n", "releases/r/tickets/09-old.md": null }, "plan r");
  assert.match(c, /^[0-9a-f]{40}$/);
  assert.equal(git(origin, "show", "main:releases/r/plan.md"), "plan");
  assert.equal(spawnSync("git", ["-C", origin, "show", "main:releases/r/tickets/09-old.md"]).status !== 0, true);
  assert.equal(P.writeRecords(work, { "releases/r/plan.md": "plan\n" }, "same"), null, "nothing changes, nothing is committed");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- the carousel: the second deferral is a diagnosis, the third leaves the item out ----------

const amendOf = (id, plan_, issueNo, file = "02-chat-says-refused-key.md") => ({ id, plan: plan_, amendment: { deferredTickets: [file], reasons: { [file]: { item: 2, issue: issueNo, url: `https://github.com/${REPO}/issues/${issueNo}` } } } });
const H = (...ids) => ids.map((v) => amendOf(`godspeed-${v}-x`, plan({ version: v }), 590));

test("a deferral is counted per release, from the flat shape (by the plan Issues line), the reasons shape and the amendments shape", () => {
  const flat = { id: "a", plan: plan({ issues: "item 1 #679, 2 #590" }), amendment: { deferredTickets: ["02-x.md"] } };
  const shaped = amendOf("b", plan(), 590);
  const nested = { id: "c", plan: plan(), amendment: { amendments: [{ deferredTickets: ["02-y.md"], reasons: { "02-y.md": { issue: 590 } } }, { deferredTickets: ["02-y.md"], reasons: { "02-y.md": { issue: 590 } } }] } };
  assert.deepEqual(P.deferralCounts([flat, shaped, nested]), { 590: 3 }, "two amendments inside one release count once");
  assert.deepEqual(P.deferralCounts([{ id: "d", plan: plan(), amendment: { deferredTickets: ["02-z.md"], reasons: { "02-z.md": { url: `https://github.com/${REPO}/issues/77` } } } }]), { 77: 1 });
});

test("first deferral is planned as before; the second becomes a diagnosis source; the third is left out with a sentence", () => {
  const run = (history) => P.bugsOnly({ openIssues: OPEN, staged: STAGED, amendment: AMEND, deferredTexts: { "02-chat-says-refused-key.md": "t" }, history: [...history, amendOf(STAGED.id, STAGED.plan, 590)] });
  const once = run([]);
  assert.equal(once.sources[0].id, "deferred:02-chat-says-refused-key.md");
  const twice = run(H("2.0.0-beta.25"));
  assert.equal(twice.sources[0].id, "diagnose:02-chat-says-refused-key.md");
  assert.equal(twice.sources[0].kind, "diagnosis");
  assert.ok(twice.allowedIssues.includes(590));
  const thrice = run(H("2.0.0-beta.24", "2.0.0-beta.25"));
  assert.ok(!thrice.sources.some((s) => /02-chat/.test(s.id)));
  assert.ok(!thrice.allowedIssues.includes(590));
  assert.equal(thrice.stuck[0].issue, 590);
  assert.match(thrice.excluded.find((e) => e.id === "deferred:02-chat-says-refused-key.md").why, /3 releases/);
  assert.equal(thrice.stuck.length, 1, "the issue loop does not list it a second time");
});

test("a stuck issue stays out even when it is plainly an open bug on its own", () => {
  const open = [...OPEN.filter((i) => i.number !== 590), issue(590, ["bug"])];
  const c = P.bugsOnly({ openIssues: open, staged: STAGED, amendment: { deferredTickets: [] }, history: H("2.0.0-beta.23", "2.0.0-beta.24", "2.0.0-beta.25") });
  assert.ok(!c.allowedIssues.includes(590));
  assert.equal(c.stuck.length, 1);
});

test("a diagnosis ticket is light, stands alone, and carries the no-code, no-judge words; the start message names a stuck item plainly", () => {
  const content = P.bugsOnly({ openIssues: OPEN, staged: STAGED, amendment: AMEND, history: [...H("2.0.0-beta.25"), amendOf(STAGED.id, STAGED.plan, 590)] });
  const out = GOOD();
  out.items = [item(1, { issue: "#590", sources: ["diagnose:02-chat-says-refused-key.md"], size: "full" })];
  assert.match(P.checkPlan(out, content).problems.join(" | "), /diagnosis ticket and must be light/);
  out.items[0].size = "light";
  out.items[0].sources.push("#679");
  assert.match(P.checkPlan(out, content).problems.join(" | "), /may not be combined/);
  out.items[0].sources = ["diagnose:02-chat-says-refused-key.md"];
  assert.equal(P.checkPlan(out, content).ok, true, P.checkPlan(out, content).problems.join(" | "));
  const t = P.ticketText({ version: "2.0.0-beta.27", item: out.items[0], repo: REPO, issue: 590 });
  assert.match(t, /## Diagnosis only[\s\S]*written cause[\s\S]*product, the test or the test machine[\s\S]*may not change product code or any check/);
  assert.ok(!P.ticketText({ version: "2.0.0-beta.27", item: item(2), repo: REPO, issue: 679 }).includes("Diagnosis only"));
  assert.equal(P.startedMessage("2.0.0-beta.27", { items: [item(1)] }, [{ issue: 590, words: "the chat calling a refused key an outage" }]), "Beta 27 started: it fixes thing 1. The chat calling a refused key an outage keeps failing; it waits until you or I decide.");
});

// ---------- prerequisites ----------

const WAITING = [
  { ...issue(697, ["bug", "priority"]), body: "Fails.\n\nDepends on: #616 and #652" },
  { ...issue(670, ["needs-owner"]), body: "Depends on: #652" },
  issue(616, ["needs-owner"]),
  issue(652, []),
  { ...issue(500, ["bug"]), body: "Depends on: #900, #901, #902" },
  { ...issue(900, [], { login: "stranger", __typename: "User" }) },
  issue(901, ["needs decision"]),
  issue(902, ["enhancement"]),
];
const STAGED2 = { id: STAGED.id, version: STAGED.version, plan: plan({ issues: "item 1 #670", notDo: "- nothing (#1)." }) };

test("an open issue a planned item depends on is pulled in and planned first; untrusted and excluded ones are not", () => {
  const c = P.bugsOnly({ openIssues: WAITING, staged: STAGED2, amendment: { deferredTickets: ["01-a.md"], reasons: { "01-a.md": { issue: 670 } } }, history: [] });
  const ids = c.sources.map((s) => s.id);
  assert.ok(ids.indexOf("#652") < ids.indexOf("#697") && ids.indexOf("#616") < ids.indexOf("#697"), ids.join());
  assert.ok(ids.indexOf("#652") < ids.indexOf("deferred:01-a.md"), "the deferred item (670) waits on 652");
  assert.deepEqual(c.needs[697].sort(), [616, 652]);
  assert.match(c.sources.find((s) => s.id === "#616").why, /prerequisite of #697/);
  for (const n of [616, 652]) assert.ok(c.allowedIssues.includes(n));
  const left = Object.fromEntries(c.excluded.map((e) => [e.id, e.why]));
  assert.match(left["#900"], /does not trust/);
  assert.match(left["#901"], /needs decision/);
  assert.match(left["#902"], /wish/);
  assert.ok(!c.allowedIssues.some((n) => [900, 901, 902].includes(n)));
});

test("the release driver's prereqs record counts too, and the issue texts alone work when it is unreadable", () => {
  const open = [issue(697, ["bug"]), issue(616, []), issue(555, [])];
  const withState = P.bugsOnly({ openIssues: open, staged: STAGED2, amendment: null, driverState: { prereqs: { "godspeed-2.0.0-beta.26-steady": { 616: { of: 697, why: "x" }, 654: { of: 0 } }, "godspeed-2.0.0-beta.25-x": { 616: { of: 555 } } } } });
  assert.deepEqual(withState.needs[697], [616]);
  const without = P.bugsOnly({ openIssues: open, staged: STAGED2, amendment: null, driverState: null });
  assert.ok(!without.allowedIssues.includes(616));
  assert.deepEqual(P.driverPrereqs({ prereqs: { r: { 1: { of: 5 }, 2: { of: 5 }, 3: { of: 0 } }, 9: { of: 5 } } })[5].sort(), [1, 2, 9]);
  assert.deepEqual(P.driverPrereqs(null), {});
});

test("the check wants a prerequisite in the plan, before what waits on it, and the limit of eight still holds", () => {
  const c = P.bugsOnly({ openIssues: WAITING, staged: STAGED2, amendment: null, history: [] });
  const body = GOOD().plan_body;
  const mk = (...issues) => ({ ...GOOD(), plan_body: body, items: issues.map((n, i) => item(i + 1, { issue: `#${n}`, sources: [`#${n}`] })) });
  assert.match(P.checkPlan(mk(697), c).problems.join(" | "), /waits on #616, which is not in the plan/);
  assert.match(P.checkPlan(mk(697, 616, 652), c).problems.join(" | "), /must come before item 1 \(#697\)/);
  assert.equal(P.checkPlan(mk(616, 652, 697), c).ok, true, P.checkPlan(mk(616, 652, 697), c).problems.join(" | "));
  const many = mk(616, 652, 697);
  many.items.push(...Array.from({ length: 6 }, (_, i) => item(4 + i, { issue: "new", sources: ["#697"] })));
  assert.match(P.checkPlan(many, c).problems.join(" | "), /9 items, and at most 8/);
});

// ---------- found lists are read whole ----------

const owner = () => P.trusted()[0];
const fakeGithub = (issues) => async (method, url, body) => {
  const q = body.query;
  const node = (c) => ({ author: c.author === undefined ? { login: owner(), __typename: "User" } : c.author, body: c.body, createdAt: "2026-11-23T10:00:00Z" });
  if (q.includes("issues(states")) {
    return { ok: true, status: 200, json: { data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: issues.map((i) => ({ number: i.number, title: i.title, body: "b", createdAt: "x", author: { login: owner(), __typename: "User" }, labels: { nodes: i.labels.map((name) => ({ name })) }, comments: { nodes: i.comments.slice(-3).map(node) } })) } } } } };
  }
  const i = issues.find((x) => x.number === body.variables.number);
  const from = body.variables.after ? Number(body.variables.after) : 0;
  const page = i.comments.slice(from, from + 4);
  return { ok: true, status: 200, json: { data: { repository: { issue: { comments: { pageInfo: { hasNextPage: from + 4 < i.comments.length, endCursor: String(from + 4) }, nodes: page.map(node) } } } } } };
};
const promptFor = (read) => P.buildPrompt({ version: "2.0.0-beta.27", repo: REPO, staged: STAGED, content: { sources: read.map((i) => ({ kind: "issue", id: `#${i.number}`, issue: i.number })), openIssues: Object.fromEntries(read.map((i) => [i.number, i])), allowedIssues: [], wishes: [] }, proposed: null, planner: "p", processSection: "s", maxItems: 8 });
const LIST = [
  ...Array.from({ length: 6 }, (_, k) => ({ body: `Found: line ${k + 1}` })),
  { body: "Found: stranger line", author: { login: "stranger", __typename: "User" } },
  { body: "bookkeeping one" },
  { body: "bookkeeping two" },
];

test("a found list is read whole: all six Found lines and the later comments, never the stranger's", async () => {
  const read = await P.readOpenIssues(fakeGithub([{ number: 7, title: "list", labels: ["found-list", "bug"], comments: LIST }]), REPO);
  const prompt = promptFor(read);
  for (let k = 1; k <= 6; k++) assert.ok(prompt.includes(`Found: line ${k}`), `line ${k}`);
  assert.ok(prompt.includes("bookkeeping one") && prompt.includes("bookkeeping two"));
  assert.ok(!prompt.includes("stranger line"));
  assert.ok(prompt.indexOf("Found: line 1") < prompt.indexOf("Found: line 6"), "oldest first");
});

test("an issue without the label is still read from its last three comments", async () => {
  const read = await P.readOpenIssues(fakeGithub([{ number: 8, title: "plain", labels: ["bug"], comments: LIST }]), REPO);
  const prompt = promptFor(read);
  assert.ok(!prompt.includes("Found: line 1"));
  assert.ok(prompt.includes("bookkeeping one") && prompt.includes("bookkeeping two"));
});

await runCases();
