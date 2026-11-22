// The factory driver for a new owner (driver/cli.mjs newOwnerSettings, written by setup when the server has no
// driver settings yet): only steps that work with a new owner's settings are on, the driver starts no acting AI runs
// and no AI helpers, and nothing it says names the first owner. A dry round is run against the generated settings
// with GitHub and the server stood in for, and each step the settings turn off is shown to refuse them.
// test cases: 6
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEW_OWNER_OFF, NEW_OWNER_ON, driverAfterSetup, newOwnerSettings, runDriverCommand } from '../driver/cli.mjs';
import { loadSettings } from '../driver/settings.mjs';
import { discoverSteps } from '../driver/steps.mjs';
import { testCase } from './cases.mjs';

const USER = { username: 'root', uid: 0, gid: 0, homedir: '/root' };
const WORKSPACE = '/var/lib/docker/volumes/godspeed-data/_data/workspace';
const found = await discoverSteps();

// The settings folder setup writes for acme/app, with the driver's own folders moved into a temporary folder so
// nothing here can touch the server's.
async function settingsFolder(edit = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'forge-new-owner-'));
  const dir = join(root, 'etc');
  await mkdir(join(dir, 'projects'), { recursive: true });
  const driver = newOwnerSettings('acme/app', { user: USER, godspeed: { workspace: WORKSPACE }, env: {} });
  Object.assign(driver.server, { state_dir: join(root, 'state'), spool_dir: join(root, 'spool'), deadman_state_dir: join(root, 'deadman'), questions_dir: join(root, 'questions'), keeper_dir: join(root, 'keeper'), driver_dir: join(root, 'driver') });
  edit(driver);
  await writeFile(join(dir, 'driver.json'), JSON.stringify(driver, null, 2));
  const checkout = join(root, 'projects', 'acme', 'app');
  await mkdir(join(checkout, '.factory'), { recursive: true });
  await writeFile(join(checkout, '.factory', 'consumer.json'), JSON.stringify({ source: join(root, 'archon'), bun: 'bun' }));
  await writeFile(join(dir, 'projects', 'acme--app.json'), JSON.stringify({ repository: 'acme/app', project: 'app', checkout, apps: { builder: 'acme-builder', release: 'acme-release' }, trust: true }, null, 2));
  return { root, dir };
}

const refusal = fn => { try { fn(); } catch (error) { return error.message; } return null; };

testCase('a new owner\'s driver settings: only the general steps on, no acting runs, no helpers, notices in Godspeed\'s workspace');
{
  const settings = newOwnerSettings('acme/app', { user: USER, godspeed: { workspace: WORKSPACE }, env: {} });
  assert.deepEqual(settings, {
    owner: { github_login: 'acme' },
    steps: {
      plan: { enabled: false }, stage: { enabled: false }, questions: { enabled: false }, 'test-machine': { enabled: false }, trust: { enabled: false }, 'keep-main-green': { enabled: false },
      'owner-releases': { enabled: true }, 'owner-questions': { enabled: true }
    },
    budget: { act_runs_per_day: 0, reserved: 0 },
    env: { FD_MAX_HELPERS: '0' },
    server: { factory_user: 'root', factory_uid: 0, factory_gid: 0, factory_home: '/root' },
    notices: { watch_repo: 'acme/app', godspeed_notices_file: `${WORKSPACE}/.godspeed/notices.json` },
    ai: { act_brain_dir: WORKSPACE }
  });
  assert.deepEqual([NEW_OWNER_OFF, NEW_OWNER_ON], [['plan', 'stage', 'questions', 'test-machine', 'trust', 'keep-main-green'], ['owner-releases', 'owner-questions']]);
  const bridged = newOwnerSettings('acme/app', { user: USER, godspeed: { workspace: WORKSPACE, noticesFile: () => '/srv/godspeed/notices.json' }, env: {} });
  assert.deepEqual([bridged.notices.godspeed_notices_file, bridged.ai.act_brain_dir], ['/srv/godspeed/notices.json', WORKSPACE], 'the bridge names the notice file');
  const without = newOwnerSettings('acme/app', { user: USER, env: {} });
  assert.equal(without.notices.godspeed_notices_file, undefined, 'without the bridge\'s answer the notices file is left to it');
  assert.equal(without.ai.act_brain_dir, '/root/.godspeed/workspace');
  assert(!/Michael|MichaelZelbel/.test(JSON.stringify(settings)));
}

testCase('the settings name nothing the driver lacks, and give it no acting runs and no helpers');
{
  const { dir } = await settingsFolder();
  const loaded = loadSettings(dir, { steps: found.steps });
  assert.equal(loaded.env.FD_ACT_RUNS_PER_DAY, '0');
  assert.equal(loaded.env.FD_ACT_RESERVED, '0');
  assert.equal(loaded.env.FD_MAX_HELPERS, '0');
  assert.equal(loaded.env.FD_OWNER_NAME, 'the owner', 'messages say the owner, never a name of someone else');
  assert.equal(loaded.env.FD_NOTICES_FILE, `${WORKSPACE}/.godspeed/notices.json`);
}

testCase('setup writes these settings once, with the workspace and notice file the bridge to Godspeed names, and never over the owner\'s');
{
  const root = await mkdtemp(join(tmpdir(), 'forge-after-setup-'));
  const paths = { config: join(root, 'etc', 'config.json') };
  const bridge = { workspace: WORKSPACE, noticesFile: () => `${WORKSPACE}/.godspeed/notices.json` };
  const said = [];
  const notRoot = { deps: { isRoot: () => false, hasSystemd: () => true } }; // the install stops before it changes anything
  await driverAfterSetup('acme/app', { paths, config: { projectsRoot: join(root, 'projects') }, godspeed: bridge, platform: 'linux', uid: 0, systemd: () => true, output: line => said.push(line), install: notRoot });
  const written = JSON.parse(await readFile(join(root, 'etc', 'driver.json'), 'utf8'));
  assert.deepEqual([written.notices.godspeed_notices_file, written.ai.act_brain_dir, written.budget], [`${WORKSPACE}/.godspeed/notices.json`, WORKSPACE, { act_runs_per_day: 0, reserved: 0 }]);
  await writeFile(join(root, 'etc', 'driver.json'), JSON.stringify({ ...written, owner: { github_login: 'kept', name: 'Kept' } }));
  await driverAfterSetup('acme/app', { paths, config: { projectsRoot: join(root, 'projects') }, godspeed: null, platform: 'linux', uid: 0, systemd: () => true, install: notRoot });
  assert.equal(JSON.parse(await readFile(join(root, 'etc', 'driver.json'), 'utf8')).owner.name, 'Kept');
}

testCase('each step the settings turn off refuses a new owner\'s settings when turned on');
{
  for (const name of NEW_OWNER_OFF) {
    const { dir } = await settingsFolder(driver => { driver.steps[name] = { enabled: true }; });
    const step = found.steps.find(s => s.name === name);
    assert(step, `the step ${name} is in the driver`);
    const refused = refusal(() => loadSettings(dir, { steps: found.steps }));
    if (refused) {
      assert.match(refused, /lack: /, `${name}: ${refused}`);
      continue;
    }
    const lines = [];
    assert.equal(await runDriverCommand(['step', name, '--dry-run', '--settings-dir', dir], { output: line => lines.push(line) }), 0);
    const result = JSON.parse(lines.at(-1));
    assert.equal(result.ok, false, `${name} ran with a new owner's settings`);
    assert.match(`${result.summary} ${result.error}`, /settings missing|has no value for/, name);
  }
}

// GitHub and the server as a new owner's look on the first round: nothing built yet, every AI reachable.
const roundDeps = {
  gh: args => { const a = args.join(' '); if (/graphql/.test(a)) return { data: { repository: null } }; if (/check-runs/.test(a)) return { check_runs: [] }; if (/commits\//.test(a)) return { sha: 'abc', commit: { committer: { date: '2026-11-22T10:00:00Z' } } }; return []; },
  sh: command => (/gh auth/.test(command) ? 'ok\n' : /codex login/.test(command) ? 'Logged in using ChatGPT\n' : /claude auth/.test(command) ? 'Logged in\n'
    : /df /.test(command) ? ' 20%\n' : /free -m/.test(command) ? 'Mem: 64223 20000 2019 40 40000 40000\n' : ''),
  providers: async () => [{ name: 'claude', model: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' }],
  clockCheck: () => ({ ok: true, ghNow: NaN, skewMs: NaN }), mono: () => ({ uptime: NaN, boot: '' }), refreshTokens: () => [], log: () => {}
};

testCase('a dry round on a new owner\'s settings starts no acting run and no helper, turns the first owner\'s steps off and names nobody');
{
  const { dir, root } = await settingsFolder();
  // gh and systemd as programs, should any step reach for them: they answer nothing and reach nothing.
  const bin = join(root, 'bin');
  await mkdir(bin);
  for (const program of ['gh', 'systemctl', 'systemd-run', 'journalctl']) {
    await writeFile(join(bin, program), '#!/bin/sh\nexit 1\n');
    await chmod(join(bin, program), 0o755);
  }
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const lines = [];
  const code = await runDriverCommand(['round', '--dry-run', '--settings-dir', dir], { output: line => lines.push(line), round: { deps: roundDeps } });
  assert.equal(code, 0, lines.join('\n'));
  const said = lines.join('\n');
  for (const name of NEW_OWNER_OFF) assert(said.includes(`step ${name}: off: the settings turn it off`), `${name}\n${said}`);
  assert(said.includes('unreadable: nothing'), `everything a new owner has can be read:\n${said}`);
  assert(said.includes('factory app: 0 active run(s)'), `the project's own checkout is read:\n${said}`);
  assert(!/launch acting run|would launch factory-helper|factory-act-/.test(said), said);
  assert(!/Michael/.test(said), said);
  testCase('every step that is on runs dry without refusing a new owner\'s settings');
  for (const step of found.steps) {
    if (NEW_OWNER_OFF.includes(step.name)) continue;
    const out = [];
    await runDriverCommand(['step', step.name, '--dry-run', '--settings-dir', dir], { output: line => out.push(line) });
    const result = JSON.parse(out.at(-1) ?? '{}');
    assert(!/settings missing|has no value for|lack: /.test(`${result.summary} ${result.error}`), `${step.name}: ${out.join(' ')}`);
    assert(!/Michael/.test(out.join('\n')), step.name);
  }
}
