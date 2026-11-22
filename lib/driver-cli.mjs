// `godspeed-forge driver ...`: the factory driver's commands. The driver itself lives in ../driver; this file only
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

const driverFile = name => pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'driver', name)).href;
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
      return await cli(argv, { log: say, err: say });
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

// What setup does when it has finished, as root on a Linux server with systemd: it writes this project's settings file (and the
// server's, from what setup knows, when there is none) and installs the driver. Whatever stops it is said plainly and never fails
// setup. Returns the lines it said.
export async function driverAfterSetup(repository, { paths, config, output = () => {}, install, platform = process.platform, uid = process.getuid?.(), systemd = () => fs.existsSync('/run/systemd/system') } = {}) {
  if (platform !== 'linux' || uid !== 0 || !systemd()) return [];
  try {
    const dir = path.dirname(paths.config);
    const [owner, name] = repository.split('/');
    const checkout = path.resolve(config?.projectsRoot ?? path.join(os.homedir(), 'projects'), repository);
    let apps = {};
    try { apps = JSON.parse(fs.readFileSync(path.join(checkout, '.git', 'godspeed-forge-apps.json'), 'utf8')); } catch { /* no list: the install names what is missing */ }
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    const projectFile = path.join(dir, 'projects', `${owner}--${name}.json`);
    if (!fs.existsSync(projectFile)) {
      fs.writeFileSync(projectFile, JSON.stringify({ repository, project: name, checkout, apps: { builder: apps.builder?.slug ?? '', release: apps.release?.slug ?? '' }, trust: true }, null, 2) + '\n');
    }
    const serverFile = path.join(dir, 'driver.json');
    if (!fs.existsSync(serverFile)) {
      const user = os.userInfo();
      fs.writeFileSync(serverFile, JSON.stringify({
        owner: { github_login: owner },
        steps: { questions: { enabled: false }, 'test-machine': { enabled: false } },
        server: { factory_user: user.username, factory_uid: user.uid, factory_gid: user.gid, factory_home: user.homedir },
        notices: { watch_repo: repository },
        ai: { act_brain_dir: process.env.GODSPEED_WORKSPACE || path.join(user.homedir, '.godspeed', 'workspace') }
      }, null, 2) + '\n');
    }
    const code = await runDriverCommand(['install', '--settings-dir', dir], { output, install });
    return code === 0 ? ['The factory driver is installed.'] : [];
  } catch (error) {
    output(`The factory driver could not be installed (${error.message}). Run godspeed-forge driver install when that is put right.`);
    return [];
  }
}
