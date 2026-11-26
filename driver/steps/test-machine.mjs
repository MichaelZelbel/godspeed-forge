// The test-machine step: watches that the hidden checks can observe at all (the verifier's browser stays up,
// one known-good check comes back with a real verdict, every hidden scenario has a tool that can run),
// repairs the verifier's environment when it cannot (an AI writes only in its sandbox copy, an independent
// review reads every line, root applies it, at most three a day), and records the result in
// <state dir>/state.json, which the driver reads. It used to run as its own timer at :07 and :37
// (test-machine.timer); now it is a step of the driver, every 30 minutes, up to 120 minutes. The logic is
// test-machine/test-machine.mjs and test-machine/referee.mjs, moved unchanged apart from where their values
// come from (the settings) and what they do when they reach a dead end: a halt for the driver, never a
// message to the owner.
//
// Halts (reported on every run while they hold):
//   broken         still unhealthy after a repair, or the day's repairs used up
//   repair-halted  a repair's AI did something it may never do; no more repairs until the halt is cleared
//                  (`--clear-halt`: a stop that no program removes by itself)
// A hidden check without a tool is no halt: the driver builds the tool (its tools-missing obstacle).
import path from "node:path";
import { spawnSync } from "node:child_process";
import { look, defaults, toolCoverage } from "./test-machine/test-machine.mjs";
import { gitInDir, factoryAccount } from "../checkout-guard.mjs";

export { defaults, toolCoverage };
export const STEP = { name: "test-machine", everyMinutes: 30, maxMinutes: 120, inRound: false };
export const SETTINGS = [
  { key: "server.factory_user", required: true, meaning: "the account the verifier runs as" },
  { key: "server.factory_uid", required: true, meaning: "its numeric user id" },
  { key: "server.factory_gid", required: true, meaning: "its numeric group id" },
  { key: "server.factory_home", required: true, meaning: "its home folder" },
  { key: "server.netns", required: false, default: "none", meaning: "the network namespace the factory account runs in, when it has one" },
  { key: "ai.models.strong", required: true, meaning: "the model that writes the repair" },
  { key: "owner.name", required: false, default: "the owner", meaning: "how the owner is named in the repair's note on the issue" },
  { key: "steps.test-machine.state_dir", required: false, default: "<server.state_dir>/steps/test-machine", meaning: "this step's state: state.json (read by the driver), decisions, the repair evidence" },
  { key: "steps.test-machine.holdout", required: true, meaning: "the id of the known-good hidden check that must come back with a real verdict (for example H-23)" },
  { key: "steps.test-machine.work", required: false, default: "<server.factory_home>/test-machine", meaning: "where the built checkout of the staged release is kept" },
  { key: "steps.test-machine.referee_work", required: false, default: "<server.factory_home>/referee-repair/run", meaning: "the folder of one repair run" },
  { key: "steps.test-machine.browser_home", required: false, default: "<server.factory_home>/.local/share/holdout-browser", meaning: "where the verifier's Playwright and Chromium live" },
  { key: "steps.test-machine.browser_root", required: false, default: "none", meaning: "the place the tools name for the browser (a link to browser_home is made there on every look)" },
  { key: "steps.test-machine.debs_home", required: false, default: "none", meaning: "where the unpacked libraries two older tools still name live" },
  { key: "steps.test-machine.debs_root", required: false, default: "none", meaning: "the place those tools name (a link to debs_home is made there)" },
  { key: "steps.test-machine.holdouts_root", required: false, default: "the folder holding releases.holdouts_dir", meaning: "the folder of every project's hidden scenarios, which a repair run may never write to" },
  { key: "steps.test-machine.manager_unit", required: false, default: "archonfactory-<project>-manager.service", meaning: "the factory's manager unit, started after an applied repair so the observations run at once" },
  { key: "steps.test-machine.playwright_version", required: false, default: "1.65.1", meaning: "the Playwright version installed when the runtime is missing" },
  { key: "steps.test-machine.repair_minutes", required: false, default: "35", meaning: "minutes the repair's AI may work" },
  { key: "steps.test-machine.observe_minutes", required: false, default: "15", meaning: "minutes one observation may take" },
  { key: "projects[main].releases.tools_dir", required: true, meaning: "the live folder of the verifier's tools (one folder per hidden check)" },
  { key: "projects[main].releases.holdouts_dir", required: true, meaning: "the folder of the hidden scenarios (HOLDOUT.md and judges/)" },
  { key: "projects[main].releases.records_checkout", required: true, meaning: "the checkout of the release records; its releases/ folder says which release is staged" },
  { key: "projects[main].checkout", required: true, meaning: "the factory's checkout of the main project" },
];

const get = (o, dotted) => dotted.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
const posix = (...p) => path.posix.join(...p);

// The TM_* values the old configuration reads, from the settings. Throws, naming the setting, when a value
// a look cannot do without is missing.
export function tmEnv(ctx) {
  const s = ctx.settings, main = ctx.main || (ctx.projects || [])[0];
  if (!main) throw new Error("no project to check");
  const need = (v, name) => { if (v === undefined || v === null || v === "") throw new Error(`the setting ${name} is missing`); return v; };
  const st = k => get(s, `steps.test-machine.${k}`);
  const home = need(get(s, "server.factory_home"), "server.factory_home");
  const rel = main.releases || {};
  const projects = ctx.projects && ctx.projects.length ? ctx.projects : [main];
  const out = {
    TM_REPO: need(main.repository, "the main project's repository"),
    TM_STATE_DIR: st("state_dir") || posix(need(get(s, "server.state_dir"), "server.state_dir"), "steps", "test-machine"),
    TM_RELEASES_DIR: posix(need(rel.records_checkout, "the main project's releases.records_checkout"), "releases"),
    FORGE_USER: need(get(s, "server.factory_user"), "server.factory_user"),
    FORGE_UID: String(need(get(s, "server.factory_uid"), "server.factory_uid")),
    FORGE_GID: String(need(get(s, "server.factory_gid"), "server.factory_gid")),
    TM_FORGE_HOME: home,
    TM_TOOLS_DIR: need(rel.tools_dir, "the main project's releases.tools_dir"),
    TM_SCENARIOS_DIR: need(rel.holdouts_dir, "the main project's releases.holdouts_dir"),
    TM_HOLDOUTS_DIR: st("holdouts_root"),
    TM_WORK: st("work") || posix(home, "test-machine"),
    TM_HOLDOUT: need(st("holdout"), "steps.test-machine.holdout"),
    TM_SOURCE_CHECKOUT: need(main.checkout, "the main project's checkout"),
    TM_CHECKOUTS: projects.map(p => p.checkout).filter(Boolean).join(","),
    TM_REFEREE_WORK: st("referee_work") || posix(home, "referee-repair", "run"),
    TM_STRONG_MODEL: need(get(s, "ai.models.strong"), "ai.models.strong"),
    TM_REPAIR_MINUTES: st("repair_minutes"), TM_OBSERVE_MINUTES: st("observe_minutes"),
    TM_BROWSER_HOME: st("browser_home") || posix(home, ".local", "share", "holdout-browser"),
    TM_BROWSER_ROOT: st("browser_root"),
    TM_DEBS_HOME: st("debs_home"), TM_DEBS_ROOT: st("debs_root"),
    TM_PLAYWRIGHT_VERSION: st("playwright_version"),
    TM_NETNS: get(s, "server.netns"),
    TM_MANAGER_UNIT: st("manager_unit") || (main.project ? `archonfactory-${main.project}-manager.service` : undefined),
    TM_OWNER_NAME: get(s, "owner.name"),
    TM_SETTINGS_DIR: ctx.settingsDir,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

// The configuration a look runs with; also what the driver's reading of the hidden checks' tools uses
// (toolCoverage(envFor(ctx))).
export const envFor = ctx => defaults([...(ctx.dry ? ["--dry-run"] : []), ...(ctx.clearHalt || (ctx.argv || []).includes("--clear-halt") ? ["--clear-halt"] : [])], tmEnv(ctx));

export const clearCommand = (ctx, clearing) => `node ${get(ctx.settings, "server.driver_dir") || "<driver dir>"}/driver.mjs --step test-machine ${clearing ? "--clear-halt " : ""}--settings-dir ${ctx.settingsDir || "<settings dir>"}`;

// -> { ok, summary, halt?, error? }. ctx.deps (stand-ins for the look's effects) and ctx.nowMs are for tests.
export async function run(ctx) {
  let env;
  try { env = envFor(ctx); } catch (e) { return { ok: false, summary: "not set up", error: e.message }; }
  const log = ctx.log || (() => {});
  // The staged release is read from the checkout of the release records, which the stage step keeps; a
  // failed pull is not fatal. Records that live in the factory user's home are pulled as that user, never as root (issue #157).
  if (!env.DRY && !env.CLEAR_HALT && !(ctx.deps && ctx.deps.check)) spawnSync(...gitInDir(factoryAccount(ctx.settings), get(ctx.main, "releases.records_checkout") || ".", ["pull", "--ff-only", "-q"]), { timeout: 120000, stdio: "ignore" });
  let r;
  try { r = await look(env, { log, ...(ctx.nowMs ? { now: ctx.nowMs } : {}), ...(ctx.deps || {}) }); }
  catch (e) { return { ok: false, summary: "the look failed", error: String(e.message).slice(0, 300) }; }
  if (r.cleared) return { ok: true, summary: "halt cleared" };
  const state = r.state || {};
  const summary = r.healthy ? `healthy: ${state.why || ""}` : `not healthy: ${state.why || ""}`;
  return { ok: true, summary, ...(r.halt ? { halt: { ...r.halt, clear: clearCommand(ctx, r.halt.key === "repair-halted") } } : {}) };
}
