// `godspeed-forge driver install [--settings-dir <dir>] [--switch] [--watcher]`: puts the factory driver on this server.
// Root on Linux with systemd only. In this order, and nothing is changed when the first step fails:
//   1. the settings are read and checked (a missing key is named);
//   2. the keeper saves the set installed now, then the driver (this add-on's driver/ without test/) is copied into
//      server.driver_dir, and the keeper and the dead-man, which live outside that set, into server.keeper_dir;
//   3. the units are written (driver, its timer, the keeper's three units and drop-in, the dead-man and its timer), systemd
//      reloads, and the driver and dead-man timers are enabled;
//   4. --switch turns off the units the driver replaces (legacy_units): disabled, never deleted;
//   5. every installed file is compared with the add-on's (sha256), and a difference fails the install; the keeper records the set;
//   6. one plain line is printed for each thing done.
// --watcher also puts the outside watcher's workflows into notices.watch_repo (only when they differ) and sets its repository variables.
// All effects on the machine go through `deps`, so the tests run on any computer.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverSteps } from "./steps.mjs";
import { loadSettings, renderEnvFile, defaultSettingsDir } from "./settings.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export class InstallStop extends Error {}
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const listFiles = (dir, rel = "") => {
  let out = [];
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out = out.concat(listFiles(dir, r));
    else if (d.isFile()) out.push(r);
  }
  return out.sort();
};
// The files of the driver as installed: everything in driver/ except its tests and the unit templates (those are rendered).
const shipped = rel => !(rel === "test" || rel.startsWith("test/") || rel.startsWith("units/"));
export const driverFiles = source => listFiles(source).filter(shipped);

const realDeps = {
  run: (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 120000, ...opts }),
  isRoot: () => process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0,
  hasSystemd: () => fs.existsSync("/run/systemd/system"),
  unitsDir: "/etc/systemd/system",
};

function fill(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (all, k) => { if (!(k in values)) throw new InstallStop(`a unit template names ${k}, which the installer does not know`); return values[k]; });
}
const stateDirective = (dir, key = "StateDirectory") => {
  const rel = path.posix.relative("/var/lib", dir);
  return rel && !rel.startsWith("..") && !path.posix.isAbsolute(rel) ? `${key}=${rel}\n` : ""; // a state folder outside /var/lib is made by the installer instead
};

// The unit files, rendered from driver/units from the settings: { "<file>": text }.
export function renderUnits(source, loaded, envFile, driverDir = loaded.get("server.driver_dir"), unitsDir = realDeps.unitsDir) {
  const g = loaded.get;
  const pull = g("releases.records_checkout") ? `ExecStartPre=-/usr/bin/git -C ${g("releases.records_checkout")} pull --ff-only -q\n` : "";
  const login = g("server.login_unit");
  const values = {
    NODE: g("server.node"), DRIVER_DIR: driverDir, KEEPER_DIR: g("server.keeper_dir"), SETTINGS_DIR: loaded.dir, ENV_FILE: envFile,
    AFTER_UNITS: login ? ` ${login}` : "", RECORDS_PULL: pull, STATE_DIRECTORY: stateDirective(g("server.state_dir")), DEADMAN_STATE_DIRECTORY: stateDirective(g("server.deadman_state_dir")),
    UNITS_DIR: unitsDir,
  };
  const dir = path.join(source, "units");
  const out = {};
  for (const [file, as] of [["factory-driver.service", "factory-driver.service"], ["factory-driver.timer", "factory-driver.timer"], ["factory-driver-keeper.conf", "factory-driver.service.d/keeper.conf"],
    ["factory-driver-keeper.service", "factory-driver-keeper.service"], ["factory-driver-rollback.service", "factory-driver-rollback.service"], ["factory-driver-repair.service", "factory-driver-repair.service"],
    ["factory-deadman.service", "factory-deadman.service"], ["factory-deadman.timer", "factory-deadman.timer"]]) out[as] = fill(fs.readFileSync(path.join(dir, file), "utf8"), values);
  return out;
}

// -> the lines to print. Throws InstallStop (a plain sentence) when something stops it.
export async function installDriver({ source = HERE, settingsDir = defaultSettingsDir(), switchOver = false, watcher = false, deps = {} } = {}) {
  const D = { ...realDeps, ...deps };
  const say = [];
  if (!D.isRoot() || !D.hasSystemd()) throw new InstallStop("The factory driver is installed by root on a Linux server that runs systemd. Run this as root on that server.");
  // 1. the settings
  const found = await discoverSteps(path.join(source, "steps"));
  let loaded;
  try { loaded = loadSettings(settingsDir, { steps: found.steps }); } catch (e) { throw new InstallStop(`${e.message} Nothing was changed.`); }
  const g = loaded.get;
  const driverDir = path.resolve(g("server.driver_dir")), keeperDir = path.resolve(g("server.keeper_dir")), src = path.resolve(source);
  for (const [dir, what] of [[driverDir, "server.driver_dir"], [keeperDir, "server.keeper_dir"]]) {
    const inside = (a, b) => { const r = path.relative(a, b); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
    if (inside(src, dir) || inside(dir, src)) throw new InstallStop(`${what} (${dir}) must not be the add-on's own folder or inside it, or the add-on inside it. Choose another folder in the settings. Nothing was changed.`);
  }
  if (driverDir === keeperDir || driverDir.startsWith(keeperDir + path.sep) || keeperDir.startsWith(driverDir + path.sep)) throw new InstallStop("server.driver_dir and server.keeper_dir must be separate folders, so that putting a set back never replaces the keeper. Nothing was changed.");
  const files = driverFiles(src);
  // 2. the keeper saves what is installed now; then the set is copied
  const keeperBin = path.join(keeperDir, "keeper.mjs");
  const envFile = path.join(settingsDir, "driver.env");
  const keeper = (cmd) => D.run(g("server.node"), [keeperBin, cmd], { env: { ...process.env, ...loaded.env }, encoding: "utf8" });
  if (fs.existsSync(keeperBin)) { const r = keeper("before-install"); if (r.status !== 0) say.push(`the keeper could not save the installed set first (${String(r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`}); going on`); else say.push("The keeper saved the driver that was installed."); }
  fs.mkdirSync(driverDir, { recursive: true });
  const stale = fs.existsSync(driverDir) ? listFiles(driverDir).filter(f => !files.includes(f)) : [];
  for (const f of stale) fs.rmSync(path.join(driverDir, f), { force: true });
  for (const f of files) { const to = path.join(driverDir, f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(src, f), to); }
  say.push(`Copied the driver (${files.length} files) into ${driverDir}${stale.length ? ` and removed ${stale.length} that are no longer part of it` : ""}.`);
  fs.mkdirSync(keeperDir, { recursive: true });
  fs.copyFileSync(path.join(src, "keeper.mjs"), keeperBin);
  fs.copyFileSync(path.join(src, "deadman", "deadman.mjs"), path.join(keeperDir, "deadman.mjs"));
  say.push(`Put the keeper and the dead-man into ${keeperDir}, outside the driver's own folder, so each can put the other back.`);
  for (const d of [g("server.state_dir"), g("server.spool_dir"), g("server.deadman_state_dir"), g("server.questions_dir")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(envFile, renderEnvFile(loaded.env), { mode: 0o644 });
  // 3. units
  const units = renderUnits(src, loaded, envFile, driverDir, D.unitsDir);
  for (const [name, text] of Object.entries(units)) { const to = path.join(D.unitsDir, name); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, text); }
  const reload = D.run("systemctl", ["daemon-reload"]);
  if (reload.status !== 0) throw new InstallStop(`systemd did not reload its units: ${String(reload.stderr || "").trim().split("\n").pop() || `exit ${reload.status}`}`);
  for (const t of ["factory-driver.timer", "factory-deadman.timer"]) {
    const r = D.run("systemctl", ["enable", "--now", t]);
    if (r.status !== 0) throw new InstallStop(`${t} could not be turned on: ${String(r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`}`);
  }
  say.push("Wrote the units of the driver, the keeper and the dead-man, and turned on the driver's timer and the dead-man's timer.");
  // 4. the units this driver replaces
  if (switchOver) {
    const legacy = g("legacy_units") || [];
    const off = [];
    for (const u of legacy) { const r = D.run("systemctl", ["disable", "--now", u]); if (r.status === 0) off.push(u); }
    say.push(legacy.length ? `Switched off ${off.length} of the ${legacy.length} units the driver replaces (${off.join(", ") || "none were on"}); none was deleted.` : "No units are listed as replaced, so none was switched off.");
  } else if ((g("legacy_units") || []).length) say.push(`The ${g("legacy_units").length} units the driver replaces are still on: add --switch to turn them off (they are never deleted).`);
  // 5. what is installed is what is in the add-on
  const wrong = [];
  for (const f of files) { try { if (sha(path.join(src, f)) !== sha(path.join(driverDir, f))) wrong.push(f); } catch { wrong.push(f); } }
  for (const [file, to] of [["keeper.mjs", keeperBin], [path.join("deadman", "deadman.mjs"), path.join(keeperDir, "deadman.mjs")]]) { if (sha(path.join(src, file)) !== sha(to)) wrong.push(to); }
  for (const [name, text] of Object.entries(units)) { if (fs.readFileSync(path.join(D.unitsDir, name), "utf8") !== text) wrong.push(name); }
  if (wrong.length) throw new InstallStop(`The installed files differ from the add-on's: ${wrong.slice(0, 5).join(", ")}${wrong.length > 5 ? ` and ${wrong.length - 5} more` : ""}. The install failed.`);
  const rec = keeper("installed");
  say.push(rec.status === 0 ? "Checked every installed file against the add-on's, and the keeper recorded this set." : `Checked every installed file against the add-on's; the keeper could not record the set (${String(rec.stderr || "").trim().split("\n").pop() || `exit ${rec.status}`}).`);
  if (watcher) say.push(...installWatcher(src, loaded, D));
  return say;
}

// ---------------------------------------------------------------- the outside watcher
// The watcher's workflows (and the program they run) go into notices.watch_repo through `gh api`, only when different;
// every name in them comes from the repository's variables, which are set here.
export function installWatcher(source, loaded, D = realDeps) {
  const g = loaded.get, repo = g("notices.watch_repo"), say = [];
  const gh = (...args) => D.run("gh", args);
  const files = [["watcher/factory-watch.yml", ".github/workflows/factory-watch.yml"], ["watcher/factory-notify.yml", ".github/workflows/factory-notify.yml"], ["watcher/factory-watch.mjs", "scripts/factory-watch.mjs"]];
  for (const [from, to] of files) {
    const text = fs.readFileSync(path.join(source, from), "utf8");
    const cur = gh("api", `repos/${repo}/contents/${to}`);
    let sha0 = null, same = false;
    if (cur.status === 0) { try { const j = JSON.parse(cur.stdout); sha0 = j.sha; same = Buffer.from(j.content || "", "base64").toString("utf8") === text; } catch { /* not readable: put it again */ } }
    if (same) { say.push(`${to} in ${repo} is already the add-on's.`); continue; }
    const r = gh("api", "-X", "PUT", `repos/${repo}/contents/${to}`, "-f", `message=Factory watcher: ${to}`, "-f", `content=${Buffer.from(text).toString("base64")}`, ...(sha0 ? ["-f", `sha=${sha0}`] : []));
    if (r.status !== 0) throw new InstallStop(`${to} could not be put into ${repo}: ${String(r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`}`);
    say.push(`Put ${to} into ${repo}.`);
  }
  const vars = { FACTORY_OWNER: g("owner.github_login"), FACTORY_PLAN_PATTERN: g("releases.plan_pattern") || "" };
  for (const [name, value] of Object.entries(vars)) {
    if (!value) continue;
    const r = gh("variable", "set", name, "--repo", repo, "--body", value);
    if (r.status !== 0) throw new InstallStop(`the repository variable ${name} could not be set on ${repo}: ${String(r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`}`);
  }
  say.push(`Set the watcher's repository variables on ${repo} (${Object.keys(vars).filter(k => vars[k]).join(", ")}).`);
  return say;
}
