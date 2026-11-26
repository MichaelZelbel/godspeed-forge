// The stage step: a finished release stages itself (freeze, scenarios, the install on the first server, the
// one message to the owner). It folds the old auto-stage timer (every 15 minutes, up to 200) into the driver.
// The helper's own logic is in release/auto-stage.mjs, moved unchanged except that its settings come from the
// driver's settings and that what used to be a message "Mission Control has to look at it" is a halt the
// driver owns. The messages that are a real result for the owner (it is on your server, shall I make it
// public; some tests failed) are sent as before, with the same ids, into the same queue.
import fs from "node:fs";
import path from "node:path";
import * as S from "./release/auto-stage.mjs";
import { prepare, settingsFor, stepValue, stepStateDir, refuseMissing, read } from "./release/from-settings.mjs";
import { clearCommandFor } from "./release/halts.mjs";

export const STEP = { name: "stage", everyMinutes: 15, maxMinutes: 200, inRound: false };

const NEEDS = ["repository", "checkout", "recordsCheckout", "kitBootstrap", "server", "tokenScript", "builderApp", "releaseApp"];
export const SETTINGS = [
  ...settingsFor([...NEEDS, "routeSuffix", "stagingDir", "healthUrl", "scenariosWorkflow", "timezone", "gitEmail", "serverIsThisMachine", "notifyCommand", "ownerName", "keysEnv", "noticesFile", "godspeedDir"], NEEDS),
  { key: "steps.stage.state_dir", required: false, default: "", meaning: "where the step keeps what it did and said (state.json); default <server.state_dir>/steps/stage; point it at an existing folder to keep the record of what was said" },
  { key: "steps.stage.scenario_wait_minutes", required: false, default: 100, meaning: "how long one look waits for the scenarios, rerun included" },
  { key: "steps.stage.blocked_grace_minutes", required: false, default: 60, meaning: "how long a reason to wait may last before it is a halt" },
  { key: "steps.stage.poll_seconds", required: false, default: 60, meaning: "seconds between two reads of the scenarios" },
  { key: "steps.stage.dispatch_grace_minutes", required: false, default: 10, meaning: "a started scenario run may take this long to show on GitHub" },
  { key: "steps.stage.scenario_mac", required: false, default: true, meaning: "start the scenarios with the Mac job (only for a stage whose gate file cannot name the release tests)" },
  { key: "steps.stage.fast_poll_seconds", required: false, default: 30, meaning: "seconds between two reads while what the step waits on is moving (the last tickets' pull requests, the builds, the checks, the tests)" },
  { key: "steps.stage.look_minutes", required: false, default: 150, meaning: "how long one look may keep watching before it ends (the step's unit allows 200)" },
  { key: "steps.stage.after_go_jobs", required: false, default: "mac-install,windows-old-names-move", meaning: "the release-gate jobs that are not run before the go but once on the tag after the release went public (comma separated)" },
  { key: "steps.stage.windows_workflow", required: false, default: "windows-setup.yml", meaning: "the product's workflow that builds the Windows setup" },
];

function prepared(ctx) {
  const p = prepare(ctx, { need: NEEDS, stepName: "stage", withKeysEnv: true });
  if (p.missing.length) return { fail: refuseMissing("stage", p.missing) };
  const sv = (n, d) => stepValue(ctx, "stage", n, d);
  const env = {
    ...p.env,
    AUTO_STAGE_STATE_DIR: stepStateDir(ctx, "stage"),
    AUTO_STAGE_SCENARIO_WAIT_MINUTES: String(sv("scenario_wait_minutes", 100)),
    AUTO_STAGE_BLOCKED_GRACE_MINUTES: String(sv("blocked_grace_minutes", 60)),
    AUTO_STAGE_POLL_SECONDS: String(sv("poll_seconds", 60)),
    AUTO_STAGE_DISPATCH_GRACE_MINUTES: String(sv("dispatch_grace_minutes", 10)),
    AUTO_STAGE_MAC: String(sv("scenario_mac", true)),
    AUTO_STAGE_FAST_POLL_SECONDS: String(sv("fast_poll_seconds", 30)),
    AUTO_STAGE_LOOK_MINUTES: String(sv("look_minutes", 150)),
    AUTO_STAGE_AFTER_GO_JOBS: String(sv("after_go_jobs", "mac-install,windows-old-names-move")),
    AUTO_STAGE_WINDOWS_WORKFLOW: String(sv("windows_workflow", "windows-setup.yml")),
    ...(read(ctx, "imageWorkflow") ? { AUTO_STAGE_IMAGE_WORKFLOW: String(read(ctx, "imageWorkflow")) } : {}),
  };
  return { env };
}

// The account of a real run, in the words of the old dry run ("Release <id> (<version>): ...", "Waiting: ...
// (for N minutes).", "Result: <outcome>."): the driver reads it from <state_dir>/look.txt and treats a missing
// or day-old file as unknown. A dry run writes nothing.
function writeLook(dir, lines) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "look.txt");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, [...lines, ""].join(String.fromCharCode(10)));
    fs.renameSync(tmp, file);
  } catch {
    /* the look is only for the driver's reading: a missing file is read as unknown */
  }
}

export async function run(ctx) {
  const p = prepared(ctx);
  if (p.fail) return p.fail;
  const dry = !!ctx.dry;
  const lines = [];
  const say = (line) => {
    lines.push(String(line));
    // after every line: a run lasts up to 200 minutes, and the driver reads this file while it goes on
    if (!dry) writeLook(p.env.AUTO_STAGE_STATE_DIR, lines);
    if (ctx.log) ctx.log(line);
  };
  try {
    // A look that keeps watching starts a fresh page for every read: the driver reads the newest "Waiting:" line as where the
    // release is (look.txt), so an old page's line must not stay above it. The log keeps every line.
    const page = () => { lines.length = 0; };
    const out = await ((ctx.impl && ctx.impl.look) || S.look)({ env: p.env, dry, log: say, page, clearHaltCommand: (step, key) => clearCommandFor(ctx, step, key) });
    if (!dry) writeLook(p.env.AUTO_STAGE_STATE_DIR, out.error ? [...lines, `Not looked: ${out.error}`] : lines);
    if (out.error) return { ok: false, summary: "stage: the look could not be made", error: out.error };
    const r = out.result;
    return { ok: true, summary: `stage: ${r.outcome}${r.why ? ` (${r.why})` : ""}`, ...(out.halt ? { halt: out.halt } : {}) };
  } catch (e) {
    if (!dry) writeLook(p.env.AUTO_STAGE_STATE_DIR, [...lines, `Not looked: ${e && e.message ? e.message : String(e)}`]);
    return { ok: false, summary: "stage: the look failed", error: e && e.message ? e.message : String(e) };
  }
}

// What the driver runs after it has fixed the cause of a halt: `driver.mjs --step stage --clear-halt <key>`.
// scenarios-lost and scenarios-ignored also need opts.ownerSaid and opts.ownerRef (--owner-said, --owner-ref):
// clearing them lets another paid test run start, which only the owner gives.
export async function clearHalt(ctx, key, opts = {}) {
  const p = prepared(ctx);
  if (p.fail) return p.fail;
  try {
    const summary = await S.clearHalt({ env: p.env, key, release: null, ownerSaid: opts.ownerSaid || ctx.ownerSaid || "", ownerRef: opts.ownerRef || ctx.ownerRef || "", log: ctx.log || (() => {}) });
    return { ok: true, summary };
  } catch (e) {
    return { ok: false, summary: "stage: the halt could not be cleared", error: e && e.message ? e.message : String(e) };
  }
}
