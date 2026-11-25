// A project's own steps (its profile), shared by the driver (building, checking and staging a candidate) and the
// add-on (the public step and its undo). The profile is kept in the driver settings file of the project
// (projects/<owner>--<repository>.json, key "profile"), or in a JSON file with the same keys that the owner names
// there by path: a file inside the project is never looked for by itself, because the factory merges changes to the
// project without anyone watching, and a command from such a file would then run on this server unapproved.
import fs from "node:fs";
import path from "node:path";
import { shellAs } from "./run.mjs";
import { defaultSettingsDir } from "../../settings.mjs";
import { forgePaths } from "./records.mjs";

const isLine = v => typeof v === "string" && v.trim().length > 0;
const safeRelative = p => isLine(p) && !path.isAbsolute(p) && !p.split(/[\\/]/).includes("..");

// -> { commands: [], produces: [] } | { problem }
function buildOf(raw) {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!b || !Array.isArray(b.commands) || !b.commands.length || !b.commands.every(isLine)) return { problem: "its build needs a list of commands, each a line of text" };
  const produces = b.produces === undefined ? [] : b.produces;
  if (!Array.isArray(produces) || !produces.every(safeRelative)) return { problem: "what its build produces must be a list of paths inside the project, none going up out of it" };
  return { commands: b.commands.map(c => c.trim()), produces };
}

function checksOf(raw) {
  if (!Array.isArray(raw)) return { problem: "its extra checks must be a list" };
  const checks = [];
  for (const [i, c] of raw.entries()) {
    const run = typeof c === "string" ? c : c && c.run;
    if (!isLine(run)) return { problem: `extra check ${i + 1} has no command` };
    checks.push({ name: isLine(c && c.name) ? c.name.trim() : `check ${i + 1}`, run: run.trim() });
  }
  return { checks };
}

// project: the project's settings (profile: an object, or the path of a JSON file; a relative path is read from the
// project's checkout). -> { profile } | { problem }; profile has only the keys that are set.
export function resolveProfile(project) {
  let raw = project && project.profile;
  if (typeof raw === "string") {
    const file = path.resolve(project.checkout || ".", raw);
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { problem: "the profile file the settings name could not be read" }; }
  }
  const merged = { ...(project || {}), ...(raw && typeof raw === "object" ? raw : {}) };
  const profile = { staging_url: merged.staging_url, health: merged.health, deploy: merged.deploy, public: merged.public, undo: merged.undo };
  for (const key of ["deploy", "health", "public", "undo"]) {
    if (profile[key] !== undefined && !isLine(profile[key])) return { problem: `the ${key} step in its profile must be a line of text` };
  }
  if (merged.build !== undefined) {
    const built = buildOf(merged.build);
    if (built.problem) return { problem: built.problem };
    profile.build = built;
  }
  if (merged.checks !== undefined) {
    const checked = checksOf(merged.checks);
    if (checked.problem) return { problem: checked.problem };
    profile.checks = checked.checks;
  }
  if (merged.timeout_minutes !== undefined) {
    const n = Number(merged.timeout_minutes);
    if (!(n > 0)) return { problem: "its timeout must be a number of minutes" };
    profile.timeout_minutes = n;
  }
  return { profile };
}

// What a failed command said, for the owner: the end of its output.
export function causeOf(r, minutes) {
  if (r.timedOut) return `It did not finish within ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  if (r.error || r.status === 127) return "It could not start.";
  const text = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n").map(l => l.trimEnd()).filter(Boolean).slice(-15).join("\n");
  return text.length > 1500 ? text.slice(-1500) : text;
}

// The variables every profile step sees; the build's output is kept in the release's own private folder, never the project.
export function stepEnv({ state, repository, version, commit }) {
  return { FORGE_VERSION: version, FORGE_CANDIDATE_COMMIT: commit || "", FORGE_BUILD_DIR: path.join(forgePaths(state).releaseDir(repository, version), "build") };
}

// Runs one command of the profile -> { ok, cause, stdout }
export function runStep(settings, line, { cwd, minutes, env = {} }) {
  const r = shellAs(settings, line, { cwd, timeoutMs: minutes * 60000, env });
  return { ok: r.status === 0 && !r.timedOut, cause: r.status === 0 && !r.timedOut ? "" : causeOf(r, minutes), stdout: r.stdout };
}

// The profile of a project as the add-on finds it, from the same settings folder the driver reads (--settings-dir as
// handed on, else FD_SETTINGS_DIR, else the driver's default) and by the same rule: the project file whose
// "repository" names it (or that is named <owner>--<repository>.json). No file means no profile of its own; a file that cannot be read or parsed is a problem.
export function profileFromSettingsFolder(repository, { dir } = {}) {
  const folder = path.join(dir || process.env.FD_SETTINGS_DIR || defaultSettingsDir(), "projects");
  let names;
  try { names = fs.readdirSync(folder).filter(n => n.endsWith(".json")).sort(); } catch (e) {
    return e && (e.code === "ENOENT" || e.code === "ENOTDIR") ? { profile: {} } : { problem: "the settings folder holding its profile could not be read" };
  }
  for (const name of names) {
    let project;
    try { project = JSON.parse(fs.readFileSync(path.join(folder, name), "utf8")); } catch { return { problem: `the settings file ${name} holding its profile could not be read` }; }
    if (project && (project.repository === repository || name === `${String(repository).replace("/", "--")}.json`)) return resolveProfile(project);
  }
  return { profile: {} };
}
