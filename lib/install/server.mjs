// What the install line does once install.sh has a Node to run it with (lib/install/run.mjs):
//   1. finds Godspeed through the bridge and stops in one plain sentence when it is missing, not running or too old,
//      before anything is installed;
//   2. as root on Linux, installs what the factory needs on the server (lib/install/server-tools.mjs), except on a
//      server that already runs the factory, whose tools stay as they are;
//   3. copies the add-on, gives Godspeed's chat the forge skill and makes the folders the chat and the Forge talk through;
//   4. as root on Linux with systemd, installs the units that answer the chat's requests (lib/install/inbox-units.mjs);
//   5. as root on Linux with systemd, sets up the page where the owner watches the factory (lib/watch.mjs), or brings it
//      up to date: a page that cannot be set up is said in one sentence and never fails the install.
// Running it again updates the add-on and keeps every setting, the page's sign-in too.
import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, findGodspeed, godspeedProblem, MINIMUM_GODSPEED, runCommand } from '../godspeed.mjs';
import { defaultPaths } from '../config.mjs';
import { INBOX } from '../inbox.mjs';
import { installAddon } from './install.mjs';
import { installServerTools } from './server-tools.mjs';
import { installInboxUnits, UNITS_READY } from './inbox-units.mjs';
import { addressOf, ensureWatchPage, SAY as WATCH } from '../watch.mjs';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SAY = {
  found: gs => gs.kind === 'docker' ? `Found Godspeed ${gs.version}, which runs in Docker on this server.` : `Found Godspeed ${gs.version} on this server.`,
  notRoot: "Not running as root, so the server's tools and services were left as they are.",
  factoryHere: 'This server already runs the factory, so its tools were left as they are.',
  installing: version => `Installing the Forge ${version}.`,
  skill: "Godspeed's chat now knows the Forge.",
  noSystemd: 'This server has no systemd, so requests from the chat wait until godspeed-forge inbox runs.',
  unitsFailed: why => `The Forge could not start answering requests from the chat (${why}). Run this line again once that is put right.`,
};

export function installPaths(env = process.env) {
  const root = env.FORGE_INSTALL_ROOT;
  return root
    ? { addon: path.join(root, 'addon'), executable: path.join(root, 'bin', 'godspeed-forge'), config: path.join(root, 'config.json'), state: path.join(root, 'state') }
    : defaultPaths();
}

// The Node the inbox service runs with: the server's own Node 22 or newer; else this one, kept in the Forge's private
// state when install.sh took it out of Godspeed's container into a temporary folder for this run only.
async function serviceNode({ run, fs, env, paths }) {
  const r = await run('bash', ['-c', 'command -v node'], { env: { ...env, PATH: `/usr/local/bin:/usr/bin:/bin${env.PATH ? `:${env.PATH}` : ''}` } });
  const found = r.status === 0 ? r.stdout.trim().split('\n')[0] : '';
  if (found) {
    const v = await run(found, ['-e', 'console.log(process.versions.node)']);
    if (v.status === 0 && Number(v.stdout.trim().split('.')[0]) >= 22) return found;
  }
  if (!env.FORGE_TEMPORARY_NODE || path.resolve(env.FORGE_TEMPORARY_NODE) !== path.resolve(process.execPath)) return process.execPath;
  const kept = path.join(paths.state, 'runtime', 'node');
  fs.mkdirSync(path.dirname(kept), { recursive: true, mode: 0o700 });
  fs.copyFileSync(process.execPath, `${kept}.new`);
  fs.chmodSync(`${kept}.new`, 0o755);
  fs.renameSync(`${kept}.new`, kept);
  return kept;
}

// -> the exit code.
export async function installServer(o = {}) {
  const env = o.env || process.env, fs = o.fs || nodeFs, run = o.run || runCommand;
  const say = o.say || (line => console.log(line)), warn = o.warn || (line => console.error(line));
  const source = path.resolve(env.FORGE_SOURCE || SOURCE);
  const paths = o.paths || installPaths(env);
  const uid = o.uid ?? process.getuid?.();
  const system = uid === 0 && (o.platform || process.platform) === 'linux' && !env.FORGE_INSTALL_ROOT;

  // 1. Godspeed
  const found = await (o.find || findGodspeed)({ env, run, fs, fetch: o.fetch });
  const problem = godspeedProblem(found, env.FORGE_MINIMUM_GODSPEED || MINIMUM_GODSPEED);
  if (problem) { warn(problem); return 1; }
  say(SAY.found(found));

  // 2. the server's tools
  const settingsDir = env.FORGE_SETTINGS_DIR || '/etc/godspeed-forge';
  if (!system) say(SAY.notRoot);
  else if (fs.existsSync(path.join(settingsDir, 'driver.json'))) say(SAY.factoryHere);
  else {
    fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    const r = await (o.installTools || installServerTools)({ run, say, log: path.join(paths.state, 'install.log'), env });
    if (!r.ok) { warn(r.stop); return 1; }
  }

  // 3. the add-on, the skill and the chat's folders
  const version = fs.readFileSync(path.join(source, 'VERSION'), 'utf8').trim();
  say(SAY.installing(version));
  const gs = createBridge(found, { env, run, fs, uid, stateDir: paths.state });
  await installAddon({ source, paths, gs });
  say(SAY.skill);

  // 4. the units that answer the chat
  if (system) {
    const systemd = o.systemd || (() => fs.existsSync('/run/systemd/system'));
    if (!systemd()) say(SAY.noSystemd);
    else {
      const node = await serviceNode({ run, fs, env, paths });
      const r = await installInboxUnits({ run, fs, unitsDir: env.FORGE_UNITS_DIR || '/etc/systemd/system', node, forge: path.join(paths.addon, 'bin', 'godspeed-forge.mjs'), inbox: gs.workspacePath(INBOX) });
      if (!r.ok) { warn(SAY.unitsFailed(r.why)); return 1; }
      say(UNITS_READY);

      // 5. the page where the owner watches the factory
      const page = await (o.watch || ensureWatchPage)({ run, fs, say, paths, node, env, settingsDir });
      say(page.ok ? WATCH.installed(addressOf(page.record)) : WATCH.failed(page.why, WATCH.againInstall));
    }
  }
  return 0;
}
