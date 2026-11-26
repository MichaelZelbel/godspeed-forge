// The keep-main-green step: a change that broke the product's main is taken out by itself (a revert, then a
// ticket for the factory). It folds the old keep-main-green timer (every 10 minutes, up to 15) into the
// driver. The helper's logic is in release/keep-main-green.mjs, moved unchanged except that its settings come
// from the driver's settings. It has no hand-off to a person to turn into a halt: what it cannot undo
// becomes a ticket for the factory, which is its own work, so this step never returns a halt.
import * as K from "./release/keep-main-green.mjs";
import { prepare, settingsFor, stepValue, stepStateDir, refuseMissing } from "./release/from-settings.mjs";

export const STEP = { name: "keep-main-green", everyMinutes: 10, maxMinutes: 15, inRound: false };

const NEEDS = ["repository", "tokenScript", "builderApp", "releaseApp"];
export const SETTINGS = [
  ...settingsFor([...NEEDS, "keysEnv"], NEEDS),
  { key: "steps.keep-main-green.state_dir", required: false, default: "", meaning: "where the step keeps what it did (state.json) and its bare clone of the product; default <server.state_dir>/steps/keep-main-green; point it at an existing folder to keep its record" },
  { key: "steps.keep-main-green.check_name", required: false, default: "required", meaning: "the one check main requires" },
];

export async function run(ctx) {
  const p = prepare(ctx, { need: NEEDS, stepName: "keep-main-green", withKeysEnv: true });
  if (p.missing.length) return refuseMissing("keep-main-green", p.missing);
  const env = { ...p.env, KEEP_MAIN_GREEN_STATE_DIR: stepStateDir(ctx, "keep-main-green"), KEEP_MAIN_GREEN_CHECK: stepValue(ctx, "keep-main-green", "check_name", "required") };
  try {
    const out = await ((ctx.impl && ctx.impl.lookOnce) || K.lookOnce)({ env, dry: !!ctx.dry, log: ctx.log || (() => {}) });
    if (out.error) return { ok: false, summary: "keep-main-green: the look could not be made", error: out.error };
    return { ok: true, summary: `keep-main-green: ${out.result.outcome}` };
  } catch (e) {
    return { ok: false, summary: "keep-main-green: the look failed", error: e && e.message ? e.message : String(e) };
  }
}
