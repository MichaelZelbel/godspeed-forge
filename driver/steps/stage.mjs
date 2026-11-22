// The stage step: a finished release stages itself (freeze, scenarios, the install on the first server, the
// one message to the owner). It folds the old auto-stage timer (every 15 minutes, up to 200) into the driver.
// The helper's own logic is in release/auto-stage.mjs, moved unchanged except that its settings come from the
// driver's settings and that what used to be a message "Mission Control has to look at it" is a halt the
// driver owns. The messages that are a real result for the owner (it is on your server, shall I make it
// public; some tests failed) are sent as before, with the same ids, into the same queue.
import path from "node:path";
import * as S from "./release/auto-stage.mjs";
import { KEYS, prepare, settingsFor, stepValue, refuseMissing, read } from "./release/from-settings.mjs";
import { clearCommandFor } from "./release/halts.mjs";

export const STEP = { name: "stage", everyMinutes: 15, maxMinutes: 200, inRound: false };

const NEEDS = ["repository", "checkout", "recordsCheckout", "kitBootstrap", "server", "godspeedDir", "tokenScript", "appLogins"];
export const SETTINGS = [
  ...settingsFor([...NEEDS, "routeSuffix", "stagingDir", "healthUrl", "scenariosWorkflow", "timezone", "gitEmail", "serverIsThisMachine", "notifyCommand", "ownerName", "keysEnv", "noticesFile"], NEEDS),
  { key: "steps.stage.state_dir", required: true, meaning: "where the step keeps what it did and said (state.json); point it at the existing folder to keep the record of what was said" },
  { key: "steps.stage.stop_file", required: false, default: "<main.checkout>/.factory/STOP", meaning: "the factory's STOP file, which the step makes while the scenarios run and is the only STOP a program removes" },
  { key: "steps.stage.scenario_wait_minutes", required: false, default: 100, meaning: "how long one look waits for the scenarios, rerun included" },
  { key: "steps.stage.blocked_grace_minutes", required: false, default: 60, meaning: "how long a reason to wait may last before it is a halt" },
  { key: "steps.stage.stop_max_age_minutes", required: false, default: 120, meaning: "a STOP file the step made is removed when older than this" },
  { key: "steps.stage.poll_seconds", required: false, default: 60, meaning: "seconds between two reads of the scenarios" },
  { key: "steps.stage.dispatch_grace_minutes", required: false, default: 10, meaning: "a started scenario run may take this long to show on GitHub" },
  { key: "steps.stage.scenario_mac", required: false, default: true, meaning: "start the scenarios with the Mac job" },
];

function prepared(ctx) {
  const p = prepare(ctx, { need: NEEDS, stepName: "stage", withKeysEnv: true });
  if (!read(ctx, "steps.stage.state_dir")) p.missing.push("steps.stage.state_dir");
  if (p.missing.length) return { fail: refuseMissing("stage", p.missing) };
  const sv = (n, d) => stepValue(ctx, "stage", n, d);
  const checkout = read(ctx, KEYS.checkout.key);
  const env = {
    ...p.env,
    AUTO_STAGE_STATE_DIR: sv("state_dir"),
    AUTO_STAGE_STOP_FILE: sv("stop_file", path.join(checkout, ".factory", "STOP")),
    AUTO_STAGE_SCENARIO_WAIT_MINUTES: String(sv("scenario_wait_minutes", 100)),
    AUTO_STAGE_BLOCKED_GRACE_MINUTES: String(sv("blocked_grace_minutes", 60)),
    AUTO_STAGE_STOP_MAX_AGE_MINUTES: String(sv("stop_max_age_minutes", 120)),
    AUTO_STAGE_POLL_SECONDS: String(sv("poll_seconds", 60)),
    AUTO_STAGE_DISPATCH_GRACE_MINUTES: String(sv("dispatch_grace_minutes", 10)),
    AUTO_STAGE_MAC: String(sv("scenario_mac", true)),
  };
  return { env };
}

export async function run(ctx) {
  const p = prepared(ctx);
  if (p.fail) return p.fail;
  try {
    const out = await ((ctx.impl && ctx.impl.look) || S.look)({ env: p.env, dry: !!ctx.dry, log: ctx.log || (() => {}), clearHaltCommand: (step, key) => clearCommandFor(ctx, step, key) });
    if (out.error) return { ok: false, summary: "stage: the look could not be made", error: out.error };
    const r = out.result;
    return { ok: true, summary: `stage: ${r.outcome}${r.why ? ` (${r.why})` : ""}`, ...(out.halt ? { halt: out.halt } : {}) };
  } catch (e) {
    return { ok: false, summary: "stage: the look failed", error: e && e.message ? e.message : String(e) };
  }
}

// What the driver runs after it has fixed the cause of a halt: `driver.mjs --step stage --clear-halt <key>`.
export async function clearHalt(ctx, key) {
  const p = prepared(ctx);
  if (p.fail) return p.fail;
  try {
    const summary = await S.clearHalt({ env: p.env, key, release: null, log: ctx.log || (() => {}) });
    return { ok: true, summary };
  } catch (e) {
    return { ok: false, summary: "stage: the halt could not be cleared", error: e && e.message ? e.message : String(e) };
  }
}
