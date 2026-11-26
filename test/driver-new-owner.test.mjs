// The factory driver for a new owner (driver/cli.mjs newOwnerSettings, written by setup when the server has no
// driver settings yet): only steps that work with a new owner's settings are on, the driver starts no acting AI runs
// and no AI helpers, and nothing it says names the first owner. A dry round is run against the generated settings
// with GitHub and the server stood in for, and each step the settings turn off is shown to refuse them.
// test cases: 8
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NEW_OWNER_OFF, NEW_OWNER_ON, driverAfterSetup, newOwnerSettings, runDriverCommand } from '../driver/cli.mjs';
import { loadSettings } from '../driver/settings.mjs';
import { discoverSteps } from '../driver/steps.mjs';
import { testCase } from './cases.mjs';
import { publishHeartbeat, watcherHealth, mirroredHead, seenCheck, readActivity, nextReleaseFacts, supersessionLook, rung0 } from '../driver/duties.mjs';
import { deliver } from '../driver/facts.mjs';
import { tell } from '../driver/deadman/deadman.mjs';

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
    notices: { watch_repo: '', godspeed_notices_file: `${WORKSPACE}/.godspeed/notices.json` },
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
  // The install's own lines never follow setup's last sentence; a failed install is one plain sentence.
  assert.equal(said.length, 1, said.join(' | '));
  assert.match(said[0], /^Setup finished, but the part of the Forge that keeps the factory moving could not be installed: .+ Run godspeed-forge driver install to try again\.$/);
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

// Every call that would put something on GitHub: an issue, a comment, an edit, a workflow run, a file.
const WRITE = /-X\s+(?:POST|PATCH|PUT|DELETE)|--method\s+(?:POST|PATCH|PUT|DELETE)|\bworkflow run\b|\bissue (?:create|comment|edit|close|reopen)\b|\/comments\b/i;
const asText = c => (Array.isArray(c) ? c.join(' ') : String(c));
const writesIn = calls => calls.map(asText).filter(s => WRITE.test(s));

testCase('without a watch repository the heartbeat, the outside watcher, notice issues and the dead-man\'s message put nothing on GitHub');
{
  for (const name of ['WATCH_REPO', 'WATCH_ISSUES_REPO', 'DM_WATCH_REPO']) delete process.env[name];
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '[]', stderr: '' }; };
  const env = { REPO: 'acme/app' };
  assert.deepEqual(publishHeartbeat(env, { at: '2026-11-23T10:00:00Z', rung3: [], releases: [] }, run), { ok: true, skipped: 'no watch repository: no heartbeat issue' });
  assert.equal(mirroredHead(env, run), '');
  assert.deepEqual(watcherHealth(env, Date.now(), run, {}), { ok: true });
  const issues = [];
  const d = await deliver(env, { title: 'A title', text: 'A text', noticeId: 'n:1' }, { telegram: async () => ({ ok: false, why: 'no telegram here' }), issue: async (...a) => { issues.push(a); return { ok: true, receipt: 'x' }; } });
  assert.deepEqual([d.receipts, issues], [{}, []], 'no notice issue');
  const root = await mkdtemp(join(tmpdir(), 'forge-deadman-'));
  await tell({ TG_ENV: join(root, 'none.env'), WATCH_REPO: '', OWNER: 'acme', NOTICES: join(root, 'notices.json') }, 'The factory needs a look.', { run, polls: 0, sleep: async () => {} });
  assert.deepEqual(calls, [], 'gh was never asked');
  // with a watch repository (the first owner's server) the heartbeat is written as before
  publishHeartbeat({ WATCH_REPO: 'owner/records' }, { at: '2026-11-23T10:00:00Z', rung3: [], releases: [] }, run);
  assert.ok(calls.some(c => c.join(' ').includes('repos/owner/records/issues')));
}

testCase('a new owner\'s dry round and a real round, with GitHub stood in, open no issue and post no comment anywhere');
{
  for (const name of ['WATCH_REPO', 'WATCH_ISSUES_REPO', 'DM_WATCH_REPO']) delete process.env[name];
  const { dir, root } = await settingsFolder(driver => {
    driver.notices.godspeed_notices_file = join(driver.server.state_dir, '..', 'notices.json');
    driver.ai.act_brain_dir = join(driver.server.state_dir, '..', 'workspace');
  });
  const written = JSON.parse(await readFile(join(dir, 'driver.json'), 'utf8'));
  assert.equal(written.notices.watch_repo, '', 'a new owner\'s settings name no watch repository');
  // gh as a program, should anything reach for it: every call is written down, and it answers nothing
  const bin = join(root, 'bin'), ghLog = join(root, 'gh.log');
  await mkdir(bin);
  await writeFile(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> "${ghLog}"\nexit 1\n`);
  for (const program of ['systemctl', 'systemd-run', 'journalctl']) await writeFile(join(bin, program), '#!/bin/sh\nexit 1\n');
  for (const program of ['gh', 'systemctl', 'systemd-run', 'journalctl']) await chmod(join(bin, program), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: 1, stdout: '', stderr: 'the stand-in answers nothing' }; };
  const issues = [], acting = [];
  const deps = {
    ...roundDeps,
    gh: (args, input) => { calls.push(['gh', ...args]); return roundDeps.gh(args, input); },
    publishHeartbeat: (e, s) => publishHeartbeat(e, s, run),
    watcherHealth: (e, n, _run, s) => watcherHealth(e, n, run, s),
    mirroredHead: e => mirroredHead(e, run),
    seenCheck: n => seenCheck(n, run),
    activity: (e, w) => readActivity(e, w, run, Date.now()),
    nextRelease: (e, w, jv, n) => nextReleaseFacts(e, w, jv, n, run),
    supersession: (jv, w, _run, c, ok) => supersessionLook(jv, w, run, c, ok),
    rung0: (e, w, s, n, _run, ticket) => rung0(e, w, s, n, run, ticket),
    deliver: { telegram: async () => ({ ok: false, why: 'no telegram here' }), issue: async (...a) => { issues.push(a); return { ok: true, receipt: 'x' }; } },
    housekeep: async () => ({ done: [], failed: [] }),
    stepDeps: { isActive: () => false, unitResult: () => '', systemdRun: argv => { calls.push(['systemd-run', ...argv]); return { status: 1, stderr: 'the stand-in starts nothing' }; }, readJson: (file, fallback) => fallback },
    launchAct: async (...a) => { acting.push(a); throw new Error('no acting run for a new owner'); },
    launchHelper: async (...a) => { acting.push(a); throw new Error('no helper for a new owner'); }
  };
  for (const argv of [['round', '--dry-run', '--settings-dir', dir], ['round', '--settings-dir', dir]]) {
    const lines = [];
    const code = await runDriverCommand(argv, { output: line => lines.push(line), round: { deps } });
    assert.equal(code, 0, `${argv.join(' ')}:\n${lines.join('\n')}`);
  }
  let logged = [];
  try { logged = (await readFile(ghLog, 'utf8')).trim().split('\n').filter(Boolean); } catch { logged = []; }
  assert.deepEqual(writesIn([...calls, ...logged]), [], 'nothing was written to GitHub');
  assert.ok(![...calls, ...logged].map(asText).some(s => s.includes('repos/acme/app/issues') && /-X|POST|PATCH/.test(s)), 'no issue on the owner\'s project');
  assert.deepEqual(issues, [], 'no notice issue');
  assert.deepEqual(acting, [], 'no acting run and no helper');
  const state = JSON.parse(await readFile(join(root, 'state', 'state.json'), 'utf8'));
  assert.ok(state && typeof state === 'object', 'the real round ran and kept its state');
}

