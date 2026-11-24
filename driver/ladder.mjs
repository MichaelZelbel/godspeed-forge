// The ladder (factory driver, Task 4): from an obstacle and what was already tried to the next step.
// Pure. It never ends in waiting: every attempt differs from the previous one (provider, model, or a
// note built from what the previous attempt reported), and the end of the ladder is feasibility, a cut
// of a feature that cannot be built, or one plain sentence to Michael.
//
// Step.do: housekeeping | ops | diagnose | product | tests | decide | michael | feasibility | cut |
//          act | wait-external | tell-michael
//          act = move the obstacle's entry to rung 1 of the chain (inventory.mjs): the acting run takes it now.
//          Since 2026-11-21 nothing ends in waiting for a cause outside the helpers' reach: an external or
//          unrecognised cause is act. wait-external remains only for Michael's own product questions.
// history (this obstacle only): [{at, helper, provider, model, outcome, cause, summary, buildable?, approach?}]
//          outcome: "ok" | "failed" | "no report" | ...; helper: a Step.do that ran.
// ctx: {now, candidates:[{provider, model}] in order of preference (the subscription the factory is not
//       using first), exhausted:[provider or "provider/model"], toldAt (when Michael was last told),
//       freeAllow (the free models allowed; FREE_MODEL_ALLOWLIST when not given)}
import { MACHINE_KINDS } from "./obstacles.mjs";

// The free OpenRouter models a helper may ever run on: only those whose size OpenRouter's own model
// data confirms at 100B parameters or more (read 2026-11-18; never one under 30B). Live that evening the
// attempts slid down to liquid/lfm-3-1.7b, particle-1 and flint-v1.0 while Codex and Claude both
// answered, and none of those produced a report. FD_OPENROUTER_ALLOW replaces the list (ai.mjs).
export const FREE_MODEL_ALLOWLIST = [
  "nvidia/nemotron-3-ultra-550b-a55b:free", // 550B total, 55B active
  "thinkingmachines/inkling-2-small:free", // 594B total, 17B active
  "baidu/ernie-5.5-flash-preview:free", // 280B total
  "dots-studio/dots-3-note-preview:free", // 280B total, 16B active
  "nvidia/nemotron-3.5-super-vl:free", // 120B total, 12B active
];
const SUBSCRIPTIONS = ["codex", "claude"];
export const DEFAULT_CANDIDATES = [
  { provider: "claude", model: "claude-sonnet-5-5" }, { provider: "codex", model: "gpt-5.6-terra" },
  { provider: "claude", model: "claude-opus-5-5" }, { provider: "codex", model: "gpt-5.6-sol" },
  ...FREE_MODEL_ALLOWLIST.map(model => ({ provider: "openrouter", model })),
];
export const DIAGNOSIS_FRESH_HOURS = 2;
export const TELL_AFTER_HOURS = 24;
export const NO_AI_TELL_HOURS = 6;
export const FEASIBILITY_AFTER = 3;
export const ESCALATE_AFTER_HOURS = 2; // a stalled release that still has not moved this long after the acting run: Michael is told once
const AI_HELPERS = ["diagnose", "product", "tests", "decide", "michael", "feasibility", "ops"];
const CAUSE_STEP = { product: "product", "our-tests": "tests", how: "decide", what: "michael", external: "act", feature: "product" };
const ts = v => (typeof v === "number" ? v : Date.parse(v));
const H = 3600000;
// machine problems and an unreadable part start with housekeeping, then an AI helper (ops)
const machineLike = k => MACHINE_KINDS.includes(k) || k === "unreadable";

const key = a => `${a.provider}/${a.model}`;
// The AI for the next attempt. While a subscription answers, only the subscriptions are used: the first
// attempt on the usual model of the one the factory does not use, and each next one a step UP their
// ladder (candidates in order: A usual, B usual, A strong, B strong), alternating providers; at the top it
// alternates between the two strong models, or stays on the one left (the note carries the difference).
// Free models only when both subscriptions are used up, and only those on the allowlist; none left is no AI.
function pickAi(history, ctx) {
  const dead = new Set(ctx.exhausted || []);
  const allow = ctx.freeAllow && ctx.freeAllow.length ? ctx.freeAllow : FREE_MODEL_ALLOWLIST;
  const all = (ctx.candidates && ctx.candidates.length ? ctx.candidates : DEFAULT_CANDIDATES).filter(c => !dead.has(c.provider) && !dead.has(key(c)));
  const subs = all.filter(c => SUBSCRIPTIONS.includes(c.provider));
  const free = all.filter(c => c.provider === "openrouter" && allow.includes(c.model));
  const prev = [...history].reverse().find(h => AI_HELPERS.includes(h.helper) && h.provider) || null;
  if (subs.length) {
    if (!prev) return { ...subs[0], prev };
    const i = subs.findIndex(c => key(c) === key(prev));
    // back from a free model, or the previous one's provider is used up: the strongest that answers
    if (i < 0) return { ...subs.at(-1), prev };
    if (i + 1 < subs.length) return { ...subs[i + 1], prev };
    const other = [...subs].reverse().find(c => c.provider !== prev.provider);
    return { ...(other || subs[i]), prev };
  }
  if (!free.length) return null;
  const j = prev ? free.findIndex(c => key(c) === key(prev)) : -1;
  return { ...free[(j + 1) % free.length], prev };
}
function note(prev, extra = "") {
  if (!prev) return extra.trim();
  const said = String(prev.summary || "").trim() || "no report";
  return `The previous attempt (${prev.helper}, ${prev.provider}/${prev.model}) ended ${prev.outcome || "failed"}: ${said} Do something different from it. ${extra}`.trim();
}
const step = (d, history, ctx, extra) => {
  const ai = pickAi(history, ctx);
  if (!ai) return { do: "housekeeping", approachNote: "No AI provider is reachable: probe the providers again." };
  return { do: d, provider: ai.provider, model: ai.model, approachNote: note(ai.prev, extra) };
};

// the latest cause, fresh, and from this episode of the obstacle: an entry from before it (re)appeared
// explains an earlier one (seen live 2026-11-18: a false alarm's diagnosis sent a tests helper to a real idle)
const causeOf = (history, now, since) => {
  const e = [...history].reverse().find(h => h.cause && ["diagnose", "product", "tests", "decide"].includes(h.helper));
  return e && now - ts(e.at) < DIAGNOSIS_FRESH_HOURS * H && !(ts(e.at) < ts(since)) ? e : null;
};
// two attempts that ended because of the feature itself, different in provider or approach
function featureAttemptsDiffer(history) {
  const f = history.filter(h => h.cause === "feature" && !["diagnose", "feasibility"].includes(h.helper));
  for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) {
    if (f[i].provider !== f[j].provider || String(f[i].approach || f[i].summary) !== String(f[j].approach || f[j].summary)) return true;
  }
  return false;
}
const latestCause = history => ([...history].reverse().find(h => h.cause && h.helper !== "feasibility") || {}).cause;

export function nextStep(obstacle, history = [], ctx = {}) {
  const now = ctx.now ?? Date.now();
  const age = now - ts(obstacle.since);
  const told = ctx.toldAt ? ts(ctx.toldAt) : null;

  if (obstacle.kind === "no-ai") {
    if (age >= NO_AI_TELL_HOURS * H && (told === null || now - told >= NO_AI_TELL_HOURS * H)) return { do: "tell-michael", approachNote: "No AI provider has been reachable for hours; say so in one plain sentence." };
    return { do: "housekeeping", approachNote: "Probe every provider again; resume by itself when one answers." };
  }
  if (age >= TELL_AFTER_HOURS * H && told === null) return { do: "tell-michael", approachNote: `Not moving for ${Math.floor(age / H)} hours with no milestone: say in one plain sentence what is stuck and what is being tried.` };

  // closed without its change reaching main: the plan's own rule moves it out at once (auto-stage did
  // this until 2026-11-18); a cut that could not be made goes the usual way
  if (obstacle.kind === "dead-end" && !history.some(h => h.helper === "cut")) return { do: "cut", approachNote: "The ticket's issue was closed and no merged change closed it: under the plan's rule it leaves the release, the rest ships." };
  // a hidden check's tool is missing: the cause is known (our own checking setup), so no diagnosis first
  if (obstacle.kind === "tools-missing") return step("tests", history, ctx, "A hidden check has no tool that can run: restore it (look in the tools folder first) or build it.");
  // a call refused because it would have acted as the owner (owner-guard.mjs): the refusal already stopped it, so no helper is
  // sent; it stays on the record for an hour after the last refusal, and only refusals that go on for longer reach the chain
  if (obstacle.kind === "as-owner") return { do: "wait-external", approachNote: "The guard refused the call, so nothing was posted or pushed under the owner's account; the run signs in only as the Apps." };
  if (machineLike(obstacle.kind)) {
    if (!history.some(h => h.helper === "housekeeping")) return { do: "housekeeping", approachNote: "" };
    // the ops helper traced it to our own checking setup (a missing hidden-check tool, the test machine):
    // that is the tests helper's to repair
    const lastOps = [...history].reverse().find(h => h.helper === "ops" || h.helper === "tests");
    if (lastOps && lastOps.helper === "ops" && lastOps.cause === "our-tests") return step("tests", history, ctx, "The ops helper traced it to our own checking setup.");
    return step("ops", history, ctx, "The housekeeping run did not clear it.");
  }

  const fb = [...history].reverse().find(h => h.helper === "feasibility" && h.buildable !== undefined);
  // a feature leaves only when it cannot be built: never because of our own tests
  if (latestCause(history) === "feature" && featureAttemptsDiffer(history) && fb && fb.buildable === false) {
    return { do: "cut", approachNote: "Two different attempts failed because of the feature itself and feasibility says it cannot be built." };
  }
  const c = causeOf(history, now, obstacle.since);
  if (!c) return step("diagnose", history, ctx, "");
  const asked = [...history].reverse().find(h => h.helper === "michael" && h.outcome === "ok");
  if (c.cause === "what" && asked && now - ts(asked.at) < 24 * H) return { do: "wait-external", approachNote: "Michael was asked with a default and a deadline; the default applies when it passes." };
  // a cause nobody recognises goes to the acting run, never to another diagnosis and never to a wait
  let d = CAUSE_STEP[c.cause] || "act";
  if (d === "act") return { do: "act", approachNote: `The diagnosis said "${c.cause}": ${String(c.summary || "").slice(0, 800)} Do what it found, yourself.` };
  if (d === "product" && history.filter(h => h.helper === "product" && h.outcome !== "ok").length >= FEASIBILITY_AFTER && !fb) d = "feasibility";
  const extra = d === "product" && c.cause === "feature" ? "The feature itself failed last time: try another way to build it." : "";
  return step(d, history, ctx, extra);
}
