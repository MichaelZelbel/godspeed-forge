// `godspeed-forge driver ...`: the factory driver's commands (bin/godspeed-forge.mjs hands them over). This file only
// reads the command line and says plain sentences.
//   driver install [--settings-dir <dir>] [--switch] [--watcher]
//   driver round [--dry-run] [--settings-dir <dir>]      (a dry run reads only: it starts nothing and writes nothing)
//   driver status [--settings-dir <dir>]
//   driver step <name> [--clear-halt] [--settings-dir <dir>]
//   driver pause set <target> "<why>" --telegram-user <id> --message-id <id> [--until <iso>] | clear <target>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const driverFile = name => pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), name)).href;
const option = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
export const DRIVER_USAGE = 'Run godspeed-forge driver install, round, status, step <name> or pause.';

// -> the exit code
export async function runDriverCommand(args, io = {}) {
  const say = io.output || (line => console.log(line));
  const [sub, ...rest] = args;
  try {
    if (sub === 'install') {
      const { installDriver, InstallStop } = await import(driverFile('install.mjs'));
      try {
        const lines = await installDriver({ settingsDir: option(rest, '--settings-dir'), switchOver: rest.includes('--switch'), watcher: rest.includes('--watcher'), ...(io.install || {}) });
        for (const l of lines) say(l);
        return 0;
      } catch (e) { if (e instanceof InstallStop) { say(e.message); return 1; } throw e; }
    }
    if (sub === 'round' || sub === 'step') {
      const { cli } = await import(driverFile('driver.mjs'));
      const argv = sub === 'step' ? ['--step', rest[0] ?? '', ...rest.slice(1)] : rest;
      return await cli(argv, { log: say, err: say, ...(io.round || {}) }); // io.round: a test's stand-ins for the round (deps, found)
    }
    if (sub === 'status') return await status(option(rest, '--settings-dir'), say);
    if (sub === 'pause') {
      const { loadSettings, defaultSettingsDir } = await import(driverFile('settings.mjs'));
      const { discoverSteps } = await import(driverFile('steps.mjs'));
      const { pauseCommand } = await import(driverFile('pause.mjs'));
      const found = await discoverSteps();
      const loaded = loadSettings(option(rest, '--settings-dir') || defaultSettingsDir(), { steps: found.steps });
      Object.assign(process.env, loaded.env);
      say(pauseCommand(rest.filter((a, i) => a !== '--settings-dir' && rest[i - 1] !== '--settings-dir')));
      return 0;
    }
  } catch (e) { say(e.message); return 1; }
  say(DRIVER_USAGE);
  return 1;
}

async function status(settingsDir, say) {
  const { loadSettings, defaultSettingsDir } = await import(driverFile('settings.mjs'));
  const { discoverSteps } = await import(driverFile('steps.mjs'));
  const found = await discoverSteps();
  const loaded = loadSettings(settingsDir || defaultSettingsDir(), { steps: found.steps });
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(loaded.get('server.state_dir'), 'status.json'), 'utf8')); } catch { say('The driver has not written its status yet.'); return 0; }
  const age = Math.round((Date.now() - Date.parse(s.at)) / 60000);
  say(`The driver's last round was ${Number.isFinite(age) ? `${age} minutes ago` : 'at a time it did not say'}; ${s.entries ?? 0} open entries (by rung: ${(s.byRung || []).join(', ')}).`);
  for (const [name, st] of Object.entries(s.steps || {})) say(`step ${name}: ${st.enabled === false ? 'off' : st.running ? 'running' : st.lastOk === null ? 'never ran' : st.lastOk ? 'last run fine' : `failing (${st.failuresInRow} in a row)`}${st.halt && st.halt.length ? `, stopped itself: ${st.halt.join(', ')}` : ''}`);
  for (const r of s.rung3 || []) say(`told the owner: ${r.title}`);
  return 0;
}

// The steps a new owner's settings turn off: the first owner's own helpers, each of which refuses or misbehaves with a
// new owner's settings (test/driver-new-owner.test.mjs runs each against them). plan, stage and test-machine need a
// release-records repository and hidden-check tools; questions needs the first owner's chat program; trust and
// keep-main-green need an App-token program and keys file the Forge does not make, and keep-main-green reverts commits
// on main by a check named "required" that a new owner's project does not have.
export const NEW_OWNER_OFF = ['plan', 'stage', 'questions', 'test-machine', 'trust', 'keep-main-green'];
// The general steps for any owner (part of the same release): on from the start.
export const NEW_OWNER_ON = ['owner-releases', 'owner-questions'];

// driver.json for a new owner, from what setup knows: no acting AI runs and no AI helpers of the driver (they spend
// the owner's coding-agent allowance on the first owner's ways of repairing), only the steps that work with it, and,
// when the bridge to Godspeed found it (godspeed: its workspace on this server and noticesFile()), Godspeed's own
// workspace and notice file, which on a Godspeed in Docker are not under this server's home folders.
export function newOwnerSettings(repository, { user = os.userInfo(), godspeed = null, env = process.env } = {}) {
  const [owner] = repository.split('/');
  const workspace = godspeed && typeof godspeed.workspace === 'string' && godspeed.workspace ? godspeed.workspace : null;
  let notices = null;
  try { notices = typeof godspeed?.noticesFile === 'function' ? godspeed.noticesFile() : null; } catch { notices = null; }
  if (!notices && workspace) notices = path.join(workspace, '.godspeed', 'notices.json');
  return {
    owner: { github_login: owner },
    steps: Object.fromEntries([...NEW_OWNER_OFF.map(name => [name, { enabled: false }]), ...NEW_OWNER_ON.map(name => [name, { enabled: true }])]),
    budget: { act_runs_per_day: 0, reserved: 0 },
    env: { FD_MAX_HELPERS: '0' },
    server: { factory_user: user.username, factory_uid: user.uid, factory_gid: user.gid, factory_home: user.homedir },
    notices: { watch_repo: repository, ...(notices ? { godspeed_notices_file: notices } : {}) },
    ai: { act_brain_dir: workspace || env.GODSPEED_WORKSPACE || path.join(user.homedir, '.godspeed', 'workspace') }
  };
}

// The bridge to the Godspeed on this server (lib/godspeed.mjs openGodspeed), or null when there is no bridge or it finds no
// Godspeed it can use; the driver's settings then fall back to the home folder's workspace.
async function godspeedBridge() {
  try {
    const { openGodspeed } = await import(new URL('../lib/godspeed.mjs', import.meta.url).href);
    return typeof openGodspeed === 'function' ? await openGodspeed() : null;
  } catch {
    return null;
  }
}

// What setup does when it has finished, as root on a Linux server with systemd: it writes this project's settings file (and the
// server's, for a new owner, when there is none), with the coding assistant setup used (agent: claude or codex, when
// known), installs the driver, and writes the project's facts file once into Godspeed's workspace, so the owner's first
// "plan release" finds the project before the driver's first round. Whatever stops it is said plainly and never fails
// setup. Returns the lines it said. godspeed: the bridge to Godspeed; when it is not given, it is opened here.
// githubApi and fetch point a test at a stand-in GitHub.
export async function driverAfterSetup(repository, { paths, config, agent, output = () => {}, install, godspeed, githubApi, fetch: fetchImpl, platform = process.platform, uid = process.getuid?.(), systemd = () => fs.existsSync('/run/systemd/system') } = {}) {
  if (platform !== 'linux' || uid !== 0 || !systemd()) return [];
  let bridge = godspeed;
  const openBridge = async () => (bridge === undefined ? (bridge = await godspeedBridge()) : bridge);
  let said = [];
  try {
    const dir = path.dirname(paths.config);
    const [owner, name] = repository.split('/');
    const checkout = path.resolve(config?.projectsRoot ?? path.join(os.homedir(), 'projects'), repository);
    let apps = {};
    try { apps = JSON.parse(fs.readFileSync(path.join(checkout, '.git', 'godspeed-forge-apps.json'), 'utf8')); } catch { /* no list: the install names what is missing */ }
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    const projectFile = path.join(dir, 'projects', `${owner}--${name}.json`);
    const known = agent === 'claude' || agent === 'codex' ? agent : null;
    if (!fs.existsSync(projectFile)) {
      fs.writeFileSync(projectFile, JSON.stringify({ repository, project: name, checkout, apps: { builder: apps.builder?.slug ?? '', release: apps.release?.slug ?? '' }, trust: true, ...(known ? { agent: known } : {}) }, null, 2) + '\n');
    } else if (known) {
      // a project file from before the agent was recorded gets the one setup just used; nothing else in it changes
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(projectFile, 'utf8')); } catch { existing = null; } // a file it cannot read is left as it is
      if (existing && typeof existing === 'object' && !existing.agent) fs.writeFileSync(projectFile, JSON.stringify({ ...existing, agent: known }, null, 2) + '\n');
    }
    const serverFile = path.join(dir, 'driver.json');
    if (!fs.existsSync(serverFile)) {
      fs.writeFileSync(serverFile, JSON.stringify(newOwnerSettings(repository, { godspeed: await openBridge() }), null, 2) + '\n');
    }
    const code = await runDriverCommand(['install', '--settings-dir', dir], { output, install });
    said = code === 0 ? ['The factory driver is installed.'] : [];
  } catch (error) {
    output(`The factory driver could not be installed (${error.message}). Run godspeed-forge driver install when that is put right.`);
  }
  await writeFirstFacts(repository, { paths, openBridge, githubApi, fetch: fetchImpl });
  return said;
}

// The project's facts file, written once at the end of setup with the same refresh the owner-releases step makes. When
// the bridge cannot be opened or anything fails, nothing is said: the driver's next round writes it.
async function writeFirstFacts(repository, { paths, openBridge, githubApi, fetch: fetchImpl }) {
  try {
    if (!paths?.state || !paths?.config) return;
    const gs = await openBridge();
    if (!gs || typeof gs.writeWorkspaceFile !== 'function' || typeof gs.readWorkspaceFile !== 'function') return;
    const dir = path.dirname(paths.config);
    const [owner, name] = repository.split('/');
    const project = JSON.parse(fs.readFileSync(path.join(dir, 'projects', `${owner}--${name}.json`), 'utf8'));
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(path.join(dir, 'driver.json'), 'utf8')); } catch { /* the facts need no server settings */ }
    const { refreshFacts } = await import(driverFile('steps/owner-releases.mjs'));
    await refreshFacts({ settings, githubApi, fetch: fetchImpl }, gs, paths.state, { ...project, repository });
  } catch { /* the driver writes it on its next round */ }
}
