// The factory driver's settings: <dir>/driver.json (the server's) and <dir>/projects/<owner>--<repo>.json (one per
// repository). Reads, validates, and returns { settings, main, projects, env }, where `env` is the FD_/RD_/DM_
// object the modules already read. Nothing here names a person, a repository or a server: every value comes from
// the files, or from a generic default below. A missing required key is named, and nothing runs.
//
// Steps declare their own keys in `export const SETTINGS = [{ key, required, default, meaning, env? }]`;
// loadSettings collects them from the step modules it is given (see steps.mjs).
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_DIR = "/etc/godspeed-forge";
const csv = v => (Array.isArray(v) ? v.join(",") : String(v ?? ""));
const json = v => (Array.isArray(v) ? JSON.stringify(v) : String(v ?? ""));

// key: where it is in driver.json, or main.* (the main project's file), or releases.* (its `releases` block).
// def: a generic default (a function of the values read so far); env: the variables the modules read.
// Never a default that names a person, a repository, a server or a user.
export const CORE = [
  { key: "owner.github_login", required: true, env: ["FD_OWNER_LOGIN"], meaning: "GitHub login whose 'Owner decision' counts" },
  { key: "owner.telegram_user_ids", def: () => [], env: ["FD_ALLOWED_USERS"], fmt: csv, meaning: "Telegram user ids whose pause words count" },
  { key: "server.factory_user", required: true, env: ["FORGE_USER"], meaning: "the Linux user the factory runs as" },
  { key: "server.factory_uid", required: true, env: ["FORGE_UID", "FD_FORGE_UID"], fmt: String, meaning: "that user's numeric id" },
  { key: "server.factory_gid", def: g => g("server.factory_uid"), env: [], meaning: "that user's group id" },
  { key: "server.factory_home", def: g => `/home/${g("server.factory_user")}`, env: ["FD_FORGE_HOME"], meaning: "the factory user's home" },
  { key: "server.netns", def: () => "", env: ["FD_FORGE_NETNS"], meaning: "the factory's network namespace; empty means none" },
  { key: "server.factory_env_file", def: g => `${g("server.factory_home")}/.factory-env`, env: ["FD_FACTORY_ENV"], meaning: "the factory's own environment file" },
  { key: "server.archon_config", def: g => `${g("server.factory_home")}/.archon/config.yaml`, env: ["FD_ARCHON_CONFIG"], meaning: "the Archon config of the factory user" },
  { key: "server.must_run_units", def: () => [], env: ["FD_MUST_RUN"], fmt: csv, meaning: "long-running units of the factory that must run" },
  { key: "server.state_dir", def: () => "/var/lib/godspeed/forge/driver", env: ["FD_STATE_DIR"], meaning: "the driver's state, journal and status" },
  { key: "server.spool_dir", def: () => "/var/lib/godspeed/forge/spool", env: ["FD_SPOOL", "DM_SPOOL"], meaning: "repair requests from acting runs to the dead-man" },
  { key: "server.deadman_state_dir", def: () => "/var/lib/godspeed/forge/deadman", env: [], meaning: "the dead-man's state" },
  { key: "server.keeper_dir", def: () => "/usr/local/lib/godspeed/forge/keeper", env: ["FD_KEEPER_HOME"], meaning: "where the keeper and the dead-man live, outside the driver's set" },
  { key: "server.driver_dir", def: () => "/usr/local/lib/godspeed/forge/driver", env: ["FD_LIB"], meaning: "where the driver's programs are installed" },
  { key: "server.questions_dir", def: () => "/var/lib/godspeed/forge/questions", env: ["FD_QUESTIONS_DIR", "RD_QUESTIONS_DIR"], meaning: "the owner questions' queue" },
  { key: "server.work_root", def: g => `${g("server.factory_home")}/factory-driver`, env: ["FD_WORK_ROOT"], meaning: "where helper runs get their folders" },
  { key: "server.sandbox_resolve", def: () => "", env: ["FD_SANDBOX_RESOLVE"], meaning: "folder bound as /run/systemd/resolve into the factory's namespace; empty means none" },
  { key: "server.machinery_units", def: () => [], env: ["FD_MACHINERY_UNITS"], fmt: csv, meaning: "the server's own factory units (regular expressions) that count as machinery, not as an owner's rescue" },
  { key: "server.restart_allowed_units", def: () => [], env: ["FD_RESTART_UNITS"], fmt: csv, meaning: "units housekeeping may restart when they fail" },
  { key: "server.never_touch_units", def: () => [], env: ["FD_NEVER_TOUCH"], fmt: csv, meaning: "the owner's own services the factory never touches" },
  { key: "server.never_touch_pattern", def: () => "", env: ["FD_NEVER_TOUCH_PATTERN"], meaning: "regular expression of commands, paths and ports the factory never touches" },
  { key: "server.login_unit", def: () => "", env: ["FD_LOGIN_UNIT"], meaning: "the unit that renews the factory's GitHub login; empty means none" },
  { key: "server.netns_guard_unit", def: () => "", env: ["FD_NETNS_GUARD"], meaning: "the unit that guards the factory's network; empty means none" },
  { key: "server.node", def: () => process.execPath, env: ["FD_NODE"], meaning: "the node program the units run" },
  { key: "server.name_in_messages", def: () => "the owner", env: ["FD_OWNER_NAME"], meaning: "how messages name the owner" },
  { key: "keys.env_file", def: (g, dir) => path.join(dir, "keys.env"), env: ["FD_KEYS_FILE", "RD_KEYS_FILE"], meaning: "the file with the keys (names only are ever shown)" },
  { key: "keys.token_script", required: true, env: ["FD_TOKEN_SCRIPT", "RD_TOKEN_SCRIPT"], meaning: "the program that mints a GitHub App token" },
  { key: "notices.godspeed_notices_file", def: g => `${g("ai.act_brain_dir")}/.godspeed/notices.json`, env: ["FD_NOTICES_FILE", "FD_ACT_NOTICES", "RD_NOTICES_FILE", "DM_NOTICES"], meaning: "the notice queue by which a program reaches the owner's chat" },
  { key: "notices.telegram_env_file", def: () => "", env: ["TG_ENV"], meaning: "env file with the owner's Telegram bot" },
  { key: "notices.telegram_machine_env_file", def: () => "", env: ["TG_MACHINE_ENV"], meaning: "env file with the machine's own Telegram bot" },
  { key: "notices.watch_repo", required: true, env: ["WATCH_REPO", "DM_WATCH_REPO"], meaning: "the repository holding the outside watcher and the heartbeat issue" },
  { key: "notices.watch_issues_repo", def: g => g("notices.watch_repo"), env: ["WATCH_ISSUES_REPO"], meaning: "where the watcher's notice issues are opened" },
  { key: "ai.bins.claude", def: g => `${g("server.factory_home")}/.local/bin/claude`, env: ["FD_CLAUDE_BIN"], fmt: json, meaning: "the Claude program (or a command as a list)" },
  { key: "ai.bins.codex", def: () => "/usr/local/bin/codex", env: ["FD_CODEX_BIN"], fmt: json, meaning: "the Codex program (or a command as a list)" },
  { key: "ai.models.codex", env: ["FD_CODEX_MODEL"], meaning: "Codex model for helpers (built-in default when unset)" },
  { key: "ai.models.codex_strong", env: ["FD_CODEX_STRONG_MODEL"], meaning: "stronger Codex model" },
  { key: "ai.models.claude", env: ["FD_CLAUDE_MODEL"], meaning: "Claude model for helpers" },
  { key: "ai.models.claude_strong", env: ["FD_CLAUDE_STRONG_MODEL"], meaning: "stronger Claude model" },
  { key: "ai.models.check", env: ["FD_CHECK_MODEL"], meaning: "model of the second check" },
  { key: "ai.models.act_codex", env: ["FD_ACT_CODEX_MODEL"], meaning: "Codex model of acting runs" },
  { key: "ai.models.act_claude", env: ["FD_ACT_CLAUDE_MODEL"], meaning: "Claude model of acting runs" },
  { key: "ai.openrouter_allow", def: () => [], env: ["FD_OPENROUTER_ALLOW"], fmt: csv, meaning: "free OpenRouter models a helper may use" },
  { key: "ai.act_brain_dir", required: true, env: ["FD_ACT_BRAIN", "FD_GODSPEED_DIR", "RD_GODSPEED_DIR", "DM_BRAIN"], meaning: "the folder acting runs work in" },
  { key: "budget.act_runs_per_day", def: () => 6, env: ["FD_ACT_RUNS_PER_DAY"], meaning: "acting runs a day" },
  { key: "budget.reserved", def: () => 1, env: ["FD_ACT_RESERVED"], meaning: "of those, kept back for the dead-man" },
  { key: "legacy_units", def: () => [], env: ["FD_LEGACY_UNITS"], fmt: csv, meaning: "units this driver replaces; never treated as factory timers" },
  { key: "main.repository", required: true, env: ["FD_REPO", "RD_REPO"], meaning: "owner/repository the driver drives" },
  { key: "main.project", def: g => String(g("main.repository")).split("/")[1], env: ["FD_PROJECT"], meaning: "the factory's name for that project" },
  { key: "main.checkout", required: true, env: ["FD_SOURCE_CHECKOUT", "FD_FACTORY_CHECKOUT", "RD_SOURCE_CHECKOUT"], meaning: "the factory user's checkout of it" },
  { key: "main.apps.builder", required: true, env: ["FD_BUILDER_APP"], meaning: "the builder App's name (no key here)" },
  { key: "main.apps.release", required: true, env: ["FD_RELEASE_APP"], meaning: "the release App's name (no key here)" },
  { key: "releases.records_repo", requiredWithReleases: true, env: ["FD_DEV_REPO"], meaning: "the repository holding the release plans" },
  { key: "releases.records_checkout", requiredWithReleases: true, env: ["FD_DEV_CHECKOUT", "RD_DEV_CHECKOUT", "DM_DEV"], meaning: "this server's checkout of it" },
  { key: "releases.plan_pattern", requiredWithReleases: true, env: ["FD_PLAN_PATTERN"], meaning: "regular expression a plan folder name matches" },
  { key: "releases.scenarios_workflow", def: () => "scenarios.yml", env: ["FD_SCENARIOS_WORKFLOW"], meaning: "the workflow that runs the hidden checks" },
  { key: "releases.image_workflow", def: () => "", env: ["IMAGE_WORKFLOW"], meaning: "workflow that builds the server image; empty means none" },
  { key: "releases.health_url", requiredWithReleases: true, env: ["FD_HEALTH_URL", "DM_HEALTH"], meaning: "the running server's health address (its version is read from it)" },
  { key: "releases.version_file", requiredWithReleases: true, env: ["FD_VERSION_FILE"], meaning: "the running install's version file (its commit)" },
  { key: "releases.tools_dir", requiredWithReleases: true, env: ["FD_TOOLS_DIR", "RD_TOOLS_DIR"], meaning: "the hidden-check tools" },
  { key: "releases.holdouts_dir", requiredWithReleases: true, env: ["FD_HOLDOUTS_DIR"], meaning: "the hidden scenarios" },
  { key: "releases.engine_repo", def: () => "", env: ["FD_ENGINE_REPO", "FD_CAUSE_ENGINE_REPO"], meaning: "repository where engine causes are filed; empty means none" },
  { key: "steps.questions.to_owner_file", def: () => "to-owner.json", env: ["FD_TO_OWNER_FILE"], meaning: "the file (in the questions folder) listing the questions handed to the owner" },
  { key: "steps.stage.state_dir", def: g => `${g("server.state_dir")}/steps/stage`, env: [], meaning: "the stage step's state folder" },
  { key: "steps.trust.state_dir", def: g => `${g("server.state_dir")}/steps/trust`, env: ["RD_STATE_DIR"], meaning: "the trust step's state folder" },
  { key: "steps.trust.worker_dir", def: g => `${g("server.state_dir")}/steps/trust/queue-worker`, env: ["RD_WORKER_DIR"], meaning: "the question queue worker's folder" },
  { key: "steps.test-machine.state_dir", def: g => `${g("server.state_dir")}/steps/test-machine`, env: [], meaning: "the test machine step's state folder" },
  { key: "steps.test-machine.module", def: g => `${g("server.driver_dir")}/steps/test-machine.mjs`, env: ["FD_TM_MODULE"], meaning: "the test machine's module (tool coverage); empty means unreadable" },
];

const readJson = (file, what) => {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { throw new Error(`${what} ${file} cannot be read: ${e.code || e.message}`); }
  try { return JSON.parse(text); } catch (e) { throw new Error(`${what} ${file} is not valid JSON: ${e.message}`); }
};
const dig = (obj, key) => key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
const has = v => v !== undefined && v !== null && v !== "";

// stepSettings: the SETTINGS arrays of the step modules (design: { key: "steps.<name>.x", required, default, meaning, env? })
export function loadSettings(dir = DEFAULT_DIR, { stepSettings = [], extraEnv = {} } = {}) {
  const settings = readJson(path.join(dir, "driver.json"), "The driver settings file");
  const projects = [];
  const pdir = path.join(dir, "projects");
  let names = [];
  try { names = fs.readdirSync(pdir).filter(n => n.endsWith(".json")).sort(); } catch {}
  for (const n of names) {
    const p = readJson(path.join(pdir, n), "The project settings file");
    p.file = n;
    projects.push(p);
  }
  const withReleases = projects.filter(p => p.releases);
  if (withReleases.length > 1) throw new Error(`More than one project has a releases block (${withReleases.map(p => p.repository || p.file).join(", ")}); the driver drives the releases of exactly one.`);
  const main = withReleases[0] || projects[0] || null;
  const hasReleases = !!(main && main.releases);

  // the file's own value for a key
  const raw = key => {
    if (key.startsWith("projects[main].")) { const rest = key.slice(15); key = rest.startsWith("releases.") ? rest : `main.${rest}`; } // a step's way of naming the main project's keys
    if (key.startsWith("main.")) return main ? dig(main, key.slice(5)) : undefined;
    if (key.startsWith("releases.")) return main && main.releases ? dig(main.releases, key.slice(9)) : undefined;
    return dig(settings, key);
  };
  const specs = [...CORE];
  const seen = new Map(specs.map(s => [s.key, s]));
  // A step's own keys are checked, never defaulted here: a step's `default` is words for the example file, and the step
  // works out its own default from the settings (so a "none" or "<server.state_dir>/..." there is never taken for a value).
  for (const s of stepSettings.flat()) {
    if (!s || !s.key || s.key.includes("[]")) continue;
    if (seen.has(s.key)) { if (s.required) seen.get(s.key).required = true; continue; }
    const d = { key: s.key, required: !!s.required, env: s.env || [], meaning: s.meaning, fmt: s.fmt };
    seen.set(s.key, d); specs.push(d);
  }
  const cache = new Map();
  const resolving = new Set();
  const missing = [];
  const get = key => {
    if (cache.has(key)) return cache.get(key);
    if (resolving.has(key)) throw new Error(`settings default loop at ${key}`);
    resolving.add(key);
    const spec = seen.get(key);
    let v = raw(key);
    if (!has(v) && spec && spec.def) v = spec.def(get, dir);
    resolving.delete(key);
    cache.set(key, v);
    return v;
  };
  for (const s of specs) {
    const v = raw(s.key);
    if (has(v) || (v !== undefined && v !== null && s.key === "server.netns")) continue;
    if (s.required && !(s.def && has(s.def(get, dir)))) missing.push(s.key);
    else if (s.requiredWithReleases && hasReleases && !(s.def && has(s.def(get, dir)))) missing.push(s.key);
  }
  if (!main) missing.push("projects/<owner>--<repo>.json (at least one project file)");
  if (missing.length) throw new Error(`The factory driver's settings in ${dir} lack: ${missing.join(", ")}.`);

  const env = {};
  for (const s of specs) {
    const v = get(s.key);
    if (!has(v) && v !== "") continue;
    if (v === "" && !(s.env || []).includes("FD_FORGE_NETNS")) continue; // an empty value means "unset" except where empty is meant
    const text = s.fmt ? s.fmt(v) : String(v);
    for (const name of s.env || []) env[name] = text;
  }
  if (!hasReleases) delete env.FD_PLAN_PATTERN;
  // derived paths the modules read
  const state = get("server.state_dir"), stage = get("steps.stage.state_dir"), tm = get("steps.test-machine.state_dir");
  env.FD_STATE_DIR = state;
  env.FD_AUTO_STAGE_STATE = `${stage}/state.json`; env.RD_AUTO_STAGE_STATE = env.FD_AUTO_STAGE_STATE;
  env.RD_TM_STATE = `${tm}/state.json`;
  env.HOLD_FILE = `${get("server.keeper_dir")}/HOLD`;
  env.FD_ACT_DIR = `${state}/acts`;
  env.FD_UNITS_DIR = "/etc/systemd/system";
  env.DM_STATUS = `${state}/status.json`; env.DM_KEEPER = `${state}/keeper.json`;
  env.DM_KEEPER_BIN = `${get("server.keeper_dir")}/keeper.mjs`;
  const dm = get("server.deadman_state_dir");
  env.DM_STATE = `${dm}/state.json`; env.DM_ACTS = `${dm}/acts`;
  env.FD_STEPS_STATE = state;
  if (hasReleases) {
    const rc = get("releases.records_checkout");
    env.FD_RELEASES_DIR = `${rc}/releases`; env.RD_RELEASES_DIR = env.FD_RELEASES_DIR; env.DM_RELEASES = env.FD_RELEASES_DIR;
  }
  env.FD_TRUSTED_LOGINS = [get("owner.github_login"), `${get("main.apps.builder")}[bot]`, `${get("main.apps.release")}[bot]`].join(",");
  env.FD_SETTINGS_DIR = dir;
  const passthrough = settings.env && typeof settings.env === "object" ? settings.env : {};
  Object.assign(env, Object.fromEntries(Object.entries(passthrough).map(([k, v]) => [k, String(v)])), extraEnv);
  // the settings as the steps read them: the file's own values with every default put in
  const resolved = JSON.parse(JSON.stringify(settings));
  for (const sp of specs) {
    if (sp.key.startsWith("main.") || sp.key.startsWith("releases.") || sp.key.startsWith("projects[")) continue;
    const v = get(sp.key);
    if (v === undefined || v === null || (v === "" && !has(raw(sp.key)) && sp.key !== "server.netns")) continue;
    const parts = sp.key.split(".");
    let o = resolved;
    for (const k of parts.slice(0, -1)) o = (o[k] && typeof o[k] === "object") ? o[k] : (o[k] = {});
    o[parts.at(-1)] = v;
  }
  if (main && !has(main.project)) main.project = get("main.project");
  const value = key => get(key);
  return { settings: resolved, main, projects, env, get: value, dir, specs };
}

// The env as a file, for the units of the keeper and the dead-man (plain files, no driver code).
export const renderEnvFile = env => `# Written by godspeed-forge driver install from the settings; edit the settings, not this.\n${Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${/[\s"'$\\]/.test(v) ? JSON.stringify(v) : v}`).join("\n")}\n`;

// A plain list of every key (for the example file and the docs).
export const keyList = (stepSettings = []) => [...CORE, ...stepSettings.flat().map(s => ({ key: s.key, required: !!s.required, meaning: s.meaning }))];
