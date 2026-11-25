import { TEST_ENV } from "./env.mjs";
import test from "./harness.mjs";
import assert from "node:assert/strict";
import { nextStep, FREE_MODEL_ALLOWLIST } from "../ladder.mjs";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const H = h => new Date(NOW - h * 3600000).toISOString();
const ob = (kind = "parked", sinceH = 1) => ({ id: "abcdef0123", kind, ticketKey: "rel#1", since: H(sinceH), evidence: [] });
const ctx = (o = {}) => ({ now: NOW, ...o });
const A = { provider: "claude", model: "sonnet" }, B = { provider: "codex", model: "gpt-5.6-terra" };
const h = (helper, o = {}) => ({ at: H(0.5), helper, ...A, outcome: "failed", summary: "it broke", ...o });
const diag = (cause, o = {}) => h("diagnose", { outcome: "ok", cause, ...o });

test("machine kinds start with housekeeping, then ops after one failed housekeeping", () => {
  for (const k of ["unit-failed", "disk", "memory", "stale-process", "login"]) {
    assert.equal(nextStep(ob(k), [], ctx()).do, "housekeeping");
    const s = nextStep(ob(k), [h("housekeeping", { provider: undefined, model: undefined })], ctx());
    assert.equal(s.do, "ops");
    assert.ok(s.provider && s.model);
  }
});

test("item 7: a STOP file goes straight to the ops helper, since housekeeping removes none; a stopped timer still starts with housekeeping", () => {
  const stop = { ...ob("factory-stopped"), stop: { file: "/x/.factory/STOP", line: "Operator stopped new factory launches.", writer: "Operator", pid: null } };
  const s = nextStep(stop, [], ctx());
  assert.equal(s.do, "ops");
  assert.ok(s.provider && s.model);
  const pause = { ...ob("factory-stopped"), stop: { file: "/x/.factory/PAUSE", kind: "PAUSE", line: "consumer.py 4242 2026-11-21T23:33:00Z", writer: "consumer.py", pid: 4242 } };
  assert.equal(nextStep(pause, [], ctx()).do, "ops", "a PAUSE file too");
  assert.equal(nextStep({ ...ob("factory-stopped"), timer: "archonfactory-x.timer" }, [], ctx()).do, "housekeeping");
});

test("ticket kinds start with diagnose", () => {
  for (const k of ["parked", "check-failed", "no-progress", "factory-idle", "main-red"]) assert.equal(nextStep(ob(k), [], ctx()).do, "diagnose");
});

test("a diagnosis younger than 2 hours picks the helper by its cause", () => {
  const table = { product: "product", "our-tests": "tests", how: "decide", what: "michael", external: "act", martian: "act" /* a cause nobody knows is never a wait */ };
  for (const [cause, want] of Object.entries(table)) assert.equal(nextStep(ob(), [diag(cause)], ctx()).do, want, cause);
});

test("a diagnosis older than 2 hours is made again", () => {
  assert.equal(nextStep(ob(), [diag("product", { at: H(3) })], ctx()).do, "diagnose");
});

test("each next attempt differs from the previous in provider or model, and carries a note", () => {
  const s = nextStep(ob(), [diag("product")], ctx());
  assert.notEqual(`${s.provider}/${s.model}`, "claude/sonnet");
  assert.match(s.approachNote, /it broke/);
  const one = nextStep(ob(), [diag("product")], ctx({ candidates: [A] }));
  assert.equal(one.provider, "claude");
  assert.match(one.approachNote, /it broke/); // same candidate: the note carries the difference
});

test("the fourth attempt does not repeat the third's provider and model", () => {
  const cands = [A, B];
  const hist = [h("product"), h("product", B), h("product")];
  const s = nextStep(ob(), [diag("product", { at: H(0.1) }), ...hist.map((x, i) => ({ ...x, at: H(0.4 - i * 0.1) }))], ctx({ candidates: cands }));
  const last = hist.at(-1);
  assert.notEqual(`${s.provider}/${s.model}`, `${last.provider}/${last.model}`);
});

test("after 3 failed product attempts: feasibility, once", () => {
  const three = [h("product"), h("product", B), h("product")];
  const s = nextStep(ob(), [diag("product"), ...three], ctx());
  assert.equal(s.do, "feasibility");
  const after = nextStep(ob(), [diag("product"), ...three, h("feasibility", { outcome: "ok", buildable: true })], ctx());
  assert.equal(after.do, "product");
});

test("cut only after two different feature attempts and feasibility buildable false", () => {
  const f1 = h("product", { cause: "feature", summary: "api cannot do it" });
  const f2 = h("product", { ...B, cause: "feature", summary: "other way also impossible" });
  const no = h("feasibility", { outcome: "ok", buildable: false });
  assert.equal(nextStep(ob(), [f1, f2, no], ctx()).do, "cut");
  assert.notEqual(nextStep(ob(), [f1, f2], ctx()).do, "cut"); // no feasibility yet
  assert.notEqual(nextStep(ob(), [f1, no], ctx()).do, "cut"); // only one attempt
  assert.notEqual(nextStep(ob(), [f1, { ...f1 }, no], ctx()).do, "cut"); // same provider, same approach
  assert.notEqual(nextStep(ob(), [f1, f2, h("feasibility", { outcome: "ok", buildable: true })], ctx()).do, "cut");
});

test("our-tests never leads to cut", () => {
  const f1 = h("product", { cause: "feature", summary: "a" });
  const f2 = h("product", { ...B, cause: "feature", summary: "b" });
  const no = h("feasibility", { outcome: "ok", buildable: false });
  const t = h("tests", { cause: "our-tests", summary: "our tool missing" });
  const s = nextStep(ob(), [f1, f2, no, t], ctx());
  assert.notEqual(s.do, "cut");
  assert.equal(s.do, "tests");
  const only = [h("product", { cause: "our-tests" }), h("tests", { ...B, cause: "our-tests" }), h("tests", { cause: "our-tests" }), no];
  assert.notEqual(nextStep(ob(), only, ctx()).do, "cut");
});

test("tell-michael once when the obstacle is 24 hours old", () => {
  assert.equal(nextStep(ob("parked", 25), [], ctx()).do, "tell-michael");
  assert.notEqual(nextStep(ob("parked", 25), [], ctx({ toldAt: H(1) })).do, "tell-michael");
  assert.notEqual(nextStep(ob("parked", 23), [], ctx()).do, "tell-michael");
});

test("no-ai: tell once per 6 hours, otherwise probe again", () => {
  assert.equal(nextStep(ob("no-ai", 2), [], ctx()).do, "housekeeping");
  assert.equal(nextStep(ob("no-ai", 7), [], ctx()).do, "tell-michael");
  assert.equal(nextStep(ob("no-ai", 7), [], ctx({ toldAt: H(1) })).do, "housekeeping");
  assert.equal(nextStep(ob("no-ai", 13), [], ctx({ toldAt: H(7) })).do, "tell-michael");
});

test("exhausted providers are skipped; none left means probing again", () => {
  const s = nextStep(ob(), [], ctx({ exhausted: ["claude"] }));
  assert.equal(s.do, "diagnose");
  assert.notEqual(s.provider, "claude");
  const none = nextStep(ob(), [], ctx({ candidates: [A], exhausted: ["claude/sonnet"] }));
  assert.equal(none.do, "housekeeping");
});

test("Michael asked with a default: the ladder does not ask again within a day", () => {
  const s = nextStep(ob(), [diag("what"), h("michael", { outcome: "ok", at: H(0.2) })], ctx());
  assert.equal(s.do, "wait-external");
});

// ---------------------------------------------------------------- Task 8
test("a dead end goes straight to the plan's cut; a cut that failed goes the usual way", () => {
  assert.equal(nextStep(ob("dead-end"), [], ctx()).do, "cut");
  assert.equal(nextStep(ob("dead-end"), [h("cut", { provider: undefined, model: undefined })], ctx()).do, "diagnose");
});

test("a stopped factory and a restarting user manager are machine problems", () => {
  for (const k of ["factory-stopped", "factory-restarts"]) {
    assert.equal(nextStep(ob(k), [], ctx()).do, "housekeeping");
    assert.equal(nextStep(ob(k), [h("housekeeping", { provider: undefined, model: undefined })], ctx()).do, "ops");
  }
});

test("a machine problem the ops helper traced to our own tests goes to the tests helper", () => {
  const hk = h("housekeeping", { provider: undefined, model: undefined });
  const s = nextStep(ob("unit-failed"), [hk, h("ops", { outcome: "ok", cause: "our-tests", summary: "the H-35 tool folder is missing" })], ctx());
  assert.equal(s.do, "tests");
  assert.equal(nextStep(ob("unit-failed"), [hk, h("ops", { outcome: "ok", cause: "external" })], ctx()).do, "ops");
});

test("a diagnosis from before the obstacle came back does not explain it: a fresh diagnosis first (seen live 2026-11-18)", () => {
  // 16:30 the main project's idle was diagnosed as a false alarm (our-tests); it cleared, and at 16:45 it was idle for real
  const s = nextStep(ob("factory-idle", 0.2), [diag("our-tests", { at: H(0.5) })], ctx());
  assert.equal(s.do, "diagnose");
  assert.equal(nextStep(ob("factory-idle", 0.6), [diag("our-tests", { at: H(0.5) })], ctx()).do, "tests", "a diagnosis of this episode still counts");
});

// ---------------------------------------------------------------- 2026-11-18 19:25: no weak free models
// Live at 17:45 to 18:00 the attempts slid down to liquid/lfm-3-1.7b:free, particle-ai/particle-1:free and
// recursive/flint-v1.0:free while Codex and Claude were both available.
const SUB_LADDER = [{ provider: "codex", model: "gpt-5.6-terra" }, { provider: "claude", model: "claude-sonnet-5-5" },
  { provider: "codex", model: "gpt-5.6-sol" }, { provider: "claude", model: "claude-opus-5-5" }];
const FREE = ["nvidia/nemotron-3-ultra-550b-a55b:free", "liquid/lfm-3-1.7b:free", "particle-ai/particle-1:free", "recursive/flint-v1.0:free", "openrouter/free"]
  .map(model => ({ provider: "openrouter", model }));
// runs n attempts in a row, each failing, and returns the provider/model of each
function attempts(n, c) {
  const hist = [], out = [];
  for (let i = 0; i < n; i++) {
    const s = nextStep(ob("tools-missing"), hist, ctx(c));
    out.push(s.provider ? `${s.provider}/${s.model}` : s.do);
    if (s.provider) hist.push({ at: H(0.1), helper: s.do, provider: s.provider, model: s.model, outcome: "no report", summary: `try ${i}` });
  }
  return out;
}

test("no free model while a subscription is available, however many attempts fail", () => {
  for (const exhausted of [[], ["codex"], ["claude"], ["claude/claude-sonnet-5-5"]]) {
    const seen = attempts(12, { candidates: [...SUB_LADDER, ...FREE], exhausted });
    assert.ok(seen.every(x => !x.startsWith("openrouter/")), `${exhausted}: ${seen.join(", ")}`);
  }
});

test("each different attempt moves up among the subscriptions, alternating providers, and stays at the top", () => {
  assert.deepEqual(attempts(7, { candidates: [...SUB_LADDER, ...FREE] }), ["codex/gpt-5.6-terra", "claude/claude-sonnet-5-5", "codex/gpt-5.6-sol",
    "claude/claude-opus-5-5", "codex/gpt-5.6-sol", "claude/claude-opus-5-5", "codex/gpt-5.6-sol"]);
  // one subscription used up: the other one's stronger model, then it stays there with a new note each time
  assert.deepEqual(attempts(4, { candidates: [...SUB_LADDER, ...FREE], exhausted: ["codex"] }), ["claude/claude-sonnet-5-5", "claude/claude-opus-5-5", "claude/claude-opus-5-5", "claude/claude-opus-5-5"]);
  const top = nextStep(ob("tools-missing"), [h("tests", { provider: "claude", model: "claude-opus-5-5", outcome: "no report", summary: "it broke" })], ctx({ candidates: [...SUB_LADDER, ...FREE], exhausted: ["codex"] }));
  assert.match(top.approachNote, /it broke.*Do something different/);
  // back from a free model (a subscription answers again): the strongest subscription model, never the weakest
  const back = nextStep(ob("tools-missing"), [h("tests", { provider: "openrouter", model: FREE[0].model, outcome: "no report" })], ctx({ candidates: [...SUB_LADDER, ...FREE] }));
  assert.equal(`${back.provider}/${back.model}`, "claude/claude-opus-5-5");
});

test("free models only when both subscriptions are used up, and never a model off the allowlist", () => {
  const both = { candidates: [...SUB_LADDER, ...FREE], exhausted: ["codex", "claude"] };
  assert.deepEqual(attempts(3, both), Array(3).fill("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"));
  // a weak model in the history (the live case) is never continued from
  const after = nextStep(ob("tools-missing"), [h("tests", { provider: "openrouter", model: "liquid/lfm-3-1.7b:free" })], ctx(both));
  assert.equal(after.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
  // only weak free models left: no AI at all rather than a weak one
  const weak = nextStep(ob("tools-missing"), [], ctx({ candidates: [...SUB_LADDER, ...FREE.slice(1)], exhausted: ["codex", "claude"] }));
  assert.equal(weak.do, "housekeeping");
  // an allowlist given by the server's setting replaces the built-in one
  const own = nextStep(ob("tools-missing"), [], ctx({ ...both, freeAllow: ["recursive/flint-v1.0:free"] }));
  assert.equal(own.model, "recursive/flint-v1.0:free");
});

test("the built-in allowlist holds only free models confirmed at 100B parameters or more", () => {
  assert.equal(FREE_MODEL_ALLOWLIST[0], "nvidia/nemotron-3-ultra-550b-a55b:free");
  for (const weak of ["liquid/lfm-3-1.7b:free", "particle-ai/particle-1:free", "recursive/flint-v1.0:free", "openrouter/free", "google/gemma-4-31b-it:free", "inclusionai/ling-3.2-flash:free"]) {
    assert.ok(!FREE_MODEL_ALLOWLIST.includes(weak), weak);
  }
});

test("a missing hidden-check tool goes straight to the tests helper, and the next attempt differs", () => {
  const first = nextStep(ob("tools-missing"), [], ctx({ candidates: [A, B] }));
  assert.equal(first.do, "tests");
  assert.equal(first.provider, "claude");
  const second = nextStep(ob("tools-missing"), [h("tests", { outcome: "no report" })], ctx({ candidates: [A, B] }));
  assert.equal(second.do, "tests");
  assert.equal(second.provider, "codex");
  assert.match(second.approachNote, /Do something different/);
});

test("a refused question for Michael or a refused decision sends the next attempt to decide, never to michael again", () => {
  // the shape the driver leaves after it refuses a technical question: helper decide, cause how, outcome refused
  const refused = h("decide", { outcome: "refused", cause: "how", summary: "Your last answer was refused" });
  assert.equal(nextStep(ob(), [diag("what"), refused], ctx()).do, "decide");
});

test("a missing browser tool tells the owner once, then waits; no helper is ever sent", () => {
  assert.equal(nextStep(ob("browser-missing"), [], ctx()).do, "tell-michael");
  const told = nextStep(ob("browser-missing", 30), [], ctx({ toldAt: H(29) }));
  assert.equal(told.do, "wait-external");
  assert.equal(nextStep(ob("browser-missing", 30), [h("housekeeping")], ctx({ toldAt: H(29), candidates: [A, B] })).do, "wait-external");
});
