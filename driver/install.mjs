// `godspeed-forge driver install [--settings-dir <dir>] [--switch] [--watcher]`: puts the factory driver on this server.
// Root on Linux with systemd only. In this order, and nothing is changed when the first step fails:
//   1. the settings are read and checked (a missing key is named);
//   2. the keeper saves the set installed now, then the driver (this add-on's driver/ without test/) is copied into
//      server.driver_dir, and the keeper and the dead-man, which live outside that set, into server.keeper_dir;
//   3. the units are written (driver, its timer, the keeper's three units and drop-in, the dead-man and its timer), the files
//      are compared with the add-on's (sha256; a difference puts the previous units back and fails), systemd reloads;
//   4. without --switch the driver's and the dead-man's timers are enabled;
//   5. with --switch the hand-over is one transaction: the old timers are stopped (not disabled), one round runs now, and only when
//      it exits 0 and wrote a fresh status.json are the old units disabled (never deleted) and the timers enabled; otherwise the
//      previous unit files are put back, the old timers that were running run again, and the install stops with the round's error;
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
import { factoryAccount, inside } from "./checkout-guard.mjs";

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
const lastLine = t => String(t || "").trim().split(String.fromCharCode(10)).filter(Boolean).pop() || "";
const firstError = r => lastLine(r.stderr) || lastLine(r.stdout) || `exit ${r.status}`;
// What the first round said went wrong: the last line its unit logged, else what systemctl said.
const roundError = (D, r) => { const j = D.run("journalctl", ["-u", "factory-driver.service", "-n", "30", "--no-pager", "-o", "cat"]); return lastLine(j.stdout) || firstError(r); };
const stateDirective = (dir, key = "StateDirectory") => {
  const rel = path.posix.relative("/var/lib", dir);
  return rel && !rel.startsWith("..") && !path.posix.isAbsolute(rel) ? `${key}=${rel}\n` : ""; // a state folder outside /var/lib is made by the installer instead
};

// The unit files, rendered from driver/units from the settings: { "<file>": text }.
export function renderUnits(source, loaded, envFile, driverDir = loaded.get("server.driver_dir"), unitsDir = realDeps.unitsDir) {
  const g = loaded.get;
  // the records' pull runs as root, so records that live in the factory user's home are pulled as that user (issue #157)
  const rc = g("releases.records_checkout"), acct = factoryAccount({ server: { factory_user: g("server.factory_user"), factory_home: g("server.factory_home") } });
  const asFactory = rc && String(rc).startsWith("/") && acct.user && acct.user !== "root" && acct.home && inside(path.posix.normalize(String(rc)), acct.home);
  const pull = rc ? `ExecStartPre=-${asFactory ? `/usr/sbin/runuser -u ${acct.user} -- /usr/bin/env HOME=${acct.home} ` : ""}/usr/bin/git -C ${rc} pull --ff-only -q\n` : "";
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
  // 3. units: the files they replace are remembered first, so that the way back is always there
  const units = renderUnits(src, loaded, envFile, driverDir, D.unitsDir);
  const previous = {};
  for (const name of Object.keys(units)) { const to = path.join(D.unitsDir, name); previous[name] = fs.existsSync(to) ? fs.readFileSync(to, "utf8") : null; }
  for (const [name, text] of Object.entries(units)) { const to = path.join(D.unitsDir, name); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, text); }
  // 4. what is installed is what is in the add-on
  const wrong = [];
  for (const f of files) { try { if (sha(path.join(src, f)) !== sha(path.join(driverDir, f))) wrong.push(f); } catch { wrong.push(f); } }
  for (const [file, to] of [["keeper.mjs", keeperBin], [path.join("deadman", "deadman.mjs"), path.join(keeperDir, "deadman.mjs")]]) { if (sha(path.join(src, file)) !== sha(to)) wrong.push(to); }
  for (const [name, text] of Object.entries(units)) { if (fs.readFileSync(path.join(D.unitsDir, name), "utf8") !== text) wrong.push(name); }
  const putBack = () => { // the previous unit files, from what was remembered
    for (const [name, text] of Object.entries(previous)) {
      const to = path.join(D.unitsDir, name);
      if (text === null) { fs.rmSync(to, { force: true }); try { fs.rmdirSync(path.dirname(to)); } catch { /* the drop-in folder is not empty or is the units folder */ } } else fs.writeFileSync(to, text);
    }
  };
  if (wrong.length) { putBack(); throw new InstallStop(`The installed files differ from the add-on's: ${wrong.slice(0, 5).join(", ")}${wrong.length > 5 ? ` and ${wrong.length - 5} more` : ""}. The install failed and the previous units are back.`); }
  say.push("Checked every installed file against the add-on's.");
  const reload = D.run("systemctl", ["daemon-reload"]);
  if (reload.status !== 0) { putBack(); throw new InstallStop(`systemd did not reload its units: ${firstError(reload)}. The previous units are back.`); }
  say.push("Wrote the units of the driver, the keeper and the dead-man.");
  const legacy = g("legacy_units") || [];
  const legacyUnits = [...new Set(legacy.flatMap(l => (/\.(service|timer)$/.test(l) ? [l] : [`${l}.timer`, `${l}.service`])))];
  if (!switchOver) {
    for (const t of ["factory-driver.timer", "factory-deadman.timer"]) {
      const r = D.run("systemctl", ["enable", "--now", t]);
      if (r.status !== 0) throw new InstallStop(`${t} could not be turned on: ${firstError(r)}`);
    }
    say.push("Turned on the driver's timer and the dead-man's timer.");
    if (legacy.length) say.push(`The ${legacy.length} units the driver replaces are still on: add --switch to hand over to the driver (they are turned off only after the driver has done one good round, and never deleted).`);
  } else {
    // 5. the switch, which never leaves the server without a driver: the old timers are stopped (not disabled), one round runs now,
    // and only when it was good are the old units disabled and the timers turned on; otherwise everything is put back. Every
    // command's answer is checked, and what was and was not put back is said exactly.
    const stoppable = legacyUnits.filter(u => u.endsWith(".timer"));
    const isActive = u => String(D.run("systemctl", ["is-active", u]).stdout || "").trim() === "active";
    const wasActive = stoppable.filter(isActive);
    const stoppedNow = () => wasActive.filter(u => !isActive(u)); // the ones that really are stopped
    const disabled = [];
    // puts the previous units back and the old timers that were running; -> the sentence saying exactly what is and is not back
    const restoreOld = () => {
      const back = [], notBack = [];
      try { putBack(); back.push("the previous unit files are back"); } catch (e) { notBack.push(`the previous unit files could not be put back (${String(e.message).slice(0, 120)})`); }
      const rl = D.run("systemctl", ["daemon-reload"]);
      if (rl.status === 0) back.push("systemd has read them again"); else notBack.push(`systemd did not reload its units (${firstError(rl)})`);
      const reenabled = [], notReenabled = [];
      for (const u of disabled) { const x = D.run("systemctl", ["enable", u]); (x.status === 0 ? reenabled : notReenabled).push(u); }
      if (reenabled.length) back.push(`the old units turned off are on again (${reenabled.join(", ")})`);
      if (notReenabled.length) notBack.push(`these old units could not be turned on again: ${notReenabled.join(", ")}`);
      const started = [], notStarted = [];
      for (const u of stopped) { const x = D.run("systemctl", ["start", u]); (x.status === 0 ? started : notStarted).push(u); }
      if (started.length) back.push(`the old timers run again (${started.join(", ")})`);
      if (notStarted.length) notBack.push(`these old timers could not be started again: ${notStarted.join(", ")}`);
      if (!stopped.length && !notStarted.length) back.push("no old timer had been running");
      return `${back.length ? `What is back: ${back.join("; ")}. ` : ""}${notBack.length ? `What is NOT back: ${notBack.join("; ")}. Fix that by hand before anything else.` : "Everything that was changed is back."}`.trim();
    };
    let stopped = [];
    // 5a. stop the old timers, and look that each one really stopped
    const stopFailed = [];
    for (const u of wasActive) { const x = D.run("systemctl", ["stop", u]); if (x.status !== 0) stopFailed.push(`${u} (${firstError(x)})`); }
    const stillActive = wasActive.filter(isActive);
    for (const u of stillActive) if (!stopFailed.some(f => f.startsWith(u))) stopFailed.push(`${u} (it is still running)`);
    stopped = wasActive.filter(u => !stillActive.includes(u));
    if (stopFailed.length) throw new InstallStop(`The switch did not happen: the old timer could not be stopped, so the first round was not started: ${stopFailed.join(", ")}. ${restoreOld()}`);
    // 5b. one round, now; the time is taken before it starts
    const statusFile = path.join(g("server.state_dir"), "status.json");
    const t0 = Date.now();
    let failure = "";
    const r = D.run("systemctl", ["start", "factory-driver.service"], { timeout: 11 * 60000 });
    if (r.status !== 0) failure = `the first round ${r.error && r.error.code === "ETIMEDOUT" ? "did not finish within its limit" : "failed"}: ${roundError(D, r)}`;
    else {
      const shown = Object.fromEntries(String(D.run("systemctl", ["show", "-p", "Result,ExecMainStatus", "factory-driver.service"]).stdout || "").split("\n").map(l => l.trim().split("=")).filter(p => p.length === 2));
      if (shown.Result !== "success" || (shown.ExecMainStatus !== undefined && shown.ExecMainStatus !== "0")) failure = `the first round's unit did not end well (Result=${shown.Result || "unknown"}, ExecMainStatus=${shown.ExecMainStatus ?? "unknown"}): ${roundError(D, r)}`;
      else {
        let at = NaN; try { at = Date.parse(JSON.parse(fs.readFileSync(statusFile, "utf8")).at); } catch { /* no readable status file */ }
        if (!(at > t0)) failure = "the first round ended without writing a fresh status.json";
      }
    }
    if (failure) {
      const stop = D.run("systemctl", ["stop", "factory-driver.service"]); // a round that hangs or failed must not go on beside the old one
      throw new InstallStop(`The switch did not happen: ${failure}${stop.status === 0 ? "" : ` (and the round's unit could not be stopped: ${firstError(stop)})`}. ${restoreOld()}`);
    }
    say.push("The driver did one good round on its own.");
    // 5c. hand over: each old unit is turned off and each timer turned on, and each answer is looked at
    const notOff = [];
    for (const u of legacyUnits) {
      const x = D.run("systemctl", ["disable", "--now", u]);
      if (x.status === 0) disabled.push(u);
      else if (!/not-found|does not exist|no such file|not loaded|could not be found/i.test(`${x.stderr || ""}${x.stdout || ""}`)) notOff.push(`${u} (${firstError(x)})`);
    }
    for (const t of ["factory-driver.timer", "factory-deadman.timer"]) {
      const x = D.run("systemctl", ["enable", "--now", t]);
      if (x.status !== 0) throw new InstallStop(`The switch did not complete: ${t} could not be turned on (${firstError(x)}), so the old program is given back. ${restoreOld()}`);
    }
    if (notOff.length) throw new InstallStop(`The driver runs and its timers are on, but these old units could not be turned off: ${notOff.join(", ")}. The old timers that were running stay stopped; turn those units off by hand so the old program does not start again at boot.`);
    say.push(legacy.length ? `Switched off ${disabled.length} of the ${legacyUnits.length} old units (${disabled.join(", ") || "none were on"}); none was deleted. The driver's timer and the dead-man's timer are on.` : "No units are listed as replaced, so none was switched off. The driver's timer and the dead-man's timer are on.");
  }
  const rec = keeper("installed");
  say.push(rec.status === 0 ? "The keeper recorded this set." : `The keeper could not record the set (${firstError(rec)}).`);
  if (watcher) say.push(...installWatcher(src, loaded, D));
  return say;
}

// ---------------------------------------------------------------- the outside watcher
// The watcher's workflows (and the program they run) go into notices.watch_repo through `gh api`, only when different;
// every name in them comes from the repository's variables, which are set here.
export function installWatcher(source, loaded, D = realDeps) {
  const g = loaded.get, repo = g("notices.watch_repo"), say = [];
  if (!repo) return ["There is no watch repository in the settings (notices.watch_repo), so no outside watcher was put anywhere."];
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
  const vars = { FACTORY_OWNER: g("owner.github_login"), FACTORY_PLAN_PATTERN: g("releases.plan_pattern") || "", FACTORY_RECORDS_REPO: g("releases.records_repo") || "" }; // the watcher reads the release plans from the records repository, wherever the watcher itself lives
  for (const [name, value] of Object.entries(vars)) {
    if (!value) continue;
    const r = gh("variable", "set", name, "--repo", repo, "--body", value);
    if (r.status !== 0) throw new InstallStop(`the repository variable ${name} could not be set on ${repo}: ${String(r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`}`);
  }
  say.push(`Set the watcher's repository variables on ${repo} (${Object.keys(vars).filter(k => vars[k]).join(", ")}).`);
  return say;
}
