// The plan step: once a release is on the first server and ready, the next bug-fix release plans and starts
// itself (the planning AI runs once, its plan is checked by a program, then filed). It folds the old
// auto-plan timer (every 15 minutes, up to 60) into the driver. The helper's logic is in release/auto-plan.mjs,
// moved unchanged except that its settings come from the driver's settings and that "the AI could not plan
// this one, Mission Control has to plan it" is a halt the driver owns, not a message.
import * as P from "./release/auto-plan.mjs";
import { KEYS, prepare, settingsFor, stepValue, refuseMissing, read } from "./release/from-settings.mjs";
import { clearCommandFor } from "./release/halts.mjs";

export const STEP = { name: "plan", everyMinutes: 15, maxMinutes: 60, inRound: false };

const NEEDS = ["repository", "checkout", "recordsCheckout", "ownerLogin", "appLogins"];
export const SETTINGS = [
  ...settingsFor([...NEEDS, "godspeedDir", "ownerName", "gitEmail", "noticesFile"], NEEDS),
  { key: "steps.plan.state_dir", required: true, meaning: "where the step keeps what it did and said (state.json); point it at the existing folder to keep the record of what was said" },
  { key: "steps.plan.standing_decision", required: true, meaning: "the owner's recorded words that let a release that only fixes bugs start without his yes; written into every plan the step starts" },
  { key: "server.factory_user", required: true, meaning: "the factory's account, as which the planning AI and the issue writes run" },
  { key: "server.factory_home", required: true, meaning: "that account's home folder" },
  { key: "server.archon_config", required: true, meaning: "the factory's model settings file, which names the strongest tier the planner uses" },
  { key: "steps.plan.driver_state", required: false, default: "", meaning: "the retired release driver's state.json, read for its prereqs when it exists; may be absent" },
  { key: "steps.plan.max_runs_per_day", required: false, default: 3, meaning: "at most this many planning runs a day" },
  { key: "steps.plan.max_items", required: false, default: 8, meaning: "at most this many items in an automatic release" },
];

function prepared(ctx) {
  const p = prepare(ctx, { need: NEEDS, stepName: "plan", withKeysEnv: false });
  for (const k of ["steps.plan.state_dir", "steps.plan.standing_decision", "server.factory_user", "server.factory_home", "server.archon_config"]) if (!read(ctx, k)) p.missing.push(k);
  if (p.missing.length) return { fail: refuseMissing("plan", p.missing) };
  const sv = (n, d) => stepValue(ctx, "plan", n, d);
  const env = {
    ...p.env,
    AUTO_PLAN_STATE_DIR: sv("state_dir"),
    AUTO_PLAN_FORGE_USER: read(ctx, "server.factory_user"),
    AUTO_PLAN_FORGE_HOME: read(ctx, "server.factory_home"),
    AUTO_PLAN_ARCHON_CONFIG: read(ctx, "server.archon_config"),
    AUTO_PLAN_CODEX_CWD: read(ctx, KEYS.checkout.key),
    AUTO_PLAN_DRIVER_STATE: sv("driver_state", ""),
    AUTO_PLAN_MAX_RUNS_PER_DAY: String(sv("max_runs_per_day", 3)),
    AUTO_PLAN_MAX_ITEMS: String(sv("max_items", 8)),
  };
  return { env };
}

export async function run(ctx) {
  const p = prepared(ctx);
  if (p.fail) return p.fail;
  try {
    const out = await ((ctx.impl && ctx.impl.look) || P.look)({ env: p.env, dry: !!ctx.dry, log: ctx.log || (() => {}), clearHaltCommand: (step, key) => clearCommandFor(ctx, step, key) });
    if (out.error) return { ok: false, summary: "plan: the look could not be made", error: out.error };
    const r = out.result;
    return { ok: true, summary: `plan: ${r.outcome}${r.why ? ` (${r.why})` : ""}`, ...(out.halt ? { halt: out.halt } : {}) };
  } catch (e) {
    return { ok: false, summary: "plan: the look failed", error: e && e.message ? e.message : String(e) };
  }
}

// What the driver runs after it has fixed the cause of a halt: `driver.mjs --step plan --clear-halt <key>`.
export async function clearHalt(ctx, key) {
  const p = prepared(ctx);
  if (p.fail) return p.fail;
  try {
    return { ok: true, summary: P.clearHalt({ env: p.env, key, log: ctx.log || (() => {}) }) };
  } catch (e) {
    return { ok: false, summary: "plan: the halt could not be cleared", error: e && e.message ? e.message : String(e) };
  }
}
