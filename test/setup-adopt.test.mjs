// A project that already runs the factory joins the Forge as it is: setup changes nothing in it, reports what it
// adopted, says when the installed build tools are not the pinned ones, and uses the Apps the owner names.
// test cases: 4
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupRepository, readySentence } from '../lib/setup.mjs';
import { credentialPath, defaults, projectStatePath } from '../lib/config.mjs';
import { ARCHON_REVISION } from '../lib/constants.mjs';
import { BROWSER_PASSED } from './home.mjs';
import { testCase } from './cases.mjs';

const repository = 'owner/adopted';
const root = await mkdtemp(join(tmpdir(), 'forge-adopt-'));
const checkout = join(root, 'projects', repository);
const FACTORY_SETTINGS = ['.factory', 'consumer.json'];

const SAMPLE = {
  'MISSION.md': '# Mission\n\nA kalimba humidifier app, in the owner\'s words.\n',
  'harness/harness.config.json': '{"static": "make lint", "unit": "make test"}\n',
  '.claude/settings.json': '{"hooks": {"owner": "kept"}}\n',
  'harness/END-TO-END.md': '# Journeys\n\n## Add a task\n',
  'factory/consumer.py': '# the owner\'s factory\n',
  '.factory/schedule.json': '{"every": "15m", "timers": ["lap", "release"]}\n',
  '.factory/timers/lap.timer': '[Timer]\nOnCalendar=*:0/15\n'
};

async function sampleCheckout(revision) {
  await mkdir(join(checkout, '.git'), { recursive: true });
  const settings = revision === undefined ? { source: '/somewhere/else' } : { source: join(root, 'cache/archon', revision), revision };
  for (const [name, text] of Object.entries(SAMPLE)) {
    await mkdir(join(checkout, name, '..'), { recursive: true });
    await writeFile(join(checkout, name), text);
  }
  await writeFile(join(checkout, ...FACTORY_SETTINGS), `${JSON.stringify(settings)}\n`);
}
async function snapshot() {
  const out = {};
  const walk = async folder => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path); else out[path.slice(checkout.length)] = await readFile(path, 'utf8');
    }
  };
  await walk(checkout);
  return out;
}

async function named() {
  const entries = {};
  for (const [kind, id] of [['builder', 11], ['release', 12]]) {
    const key_file = join(root, `${kind}.pem`);
    await writeFile(key_file, 'PEM');
    entries[kind] = { slug: `own-${kind}`, id, key_file };
  }
  return entries;
}
async function attempt(state, { apps, github = {} } = {}) {
  const calls = [];
  const output = [];
  const created = { begin: 0, install: 0 };
  const stand = {
    appStatus: async () => 'installed', begin: async () => { created.begin += 1; return { url: 'https://example.test' }; },
    callback: async () => 'code', exchange: async () => ({ id: 1, pem: 'K', slug: 's' }), install: async () => { created.install += 1; return true; },
    ...github
  };
  let error;
  const run = async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'git' && args[0] === 'remote') return { stdout: `https://github.com/${repository}.git\n` };
    return { stdout: '' };
  };
  await setupRepository(repository, {
    config: { ...defaults(root), projectsRoot: join(root, 'projects'), ...(apps ? { adoptedApps: { [repository]: apps } } : {}) },
    paths: { state }, commands: { run }, github: stand,
    prompt: async () => { throw new Error('adoption asks nothing'); }, output: line => output.push(line),
    signIn: async () => 'claude', factorySetup: async () => { throw new Error('the factory setup must not run'); }
  }).catch(e => { error = e; });
  return { calls, output, created, error };
}
const FOUND = `Found the factory already installed in ${repository}, so setup adopted it and changed nothing in it.`;
const KEPT = 'Kept as they are: the project mission, the journeys, the factory\'s settings, its schedule and its timers.';
const DONE = `Setup is complete for ${repository}. Your factory keeps running as it is. ${readySentence(repository)}`;

testCase('setting up a checkout that already runs the factory leaves its mission, harness settings and schedule as they were, and reports the adoption');
const state = join(root, 'state-1');
await sampleCheckout(ARCHON_REVISION);
const before = await snapshot();
const first = await attempt(state, { apps: await named() });
assert.equal(first.error, undefined);
assert.deepEqual(await snapshot(), before, 'every file byte for byte as it was');
assert.deepEqual(first.calls.filter(c => /factory\.py|consumer\.py|clone|schedule|systemctl|crontab|claude|bun install/.test(c)), [], first.calls.join(' | '));
assert.deepEqual(first.output, ['Using Claude Code to set up the Forge.', BROWSER_PASSED, FOUND, KEPT, 'Using your GitHub Apps own-builder and own-release.', DONE]);
assert.deepEqual(JSON.parse(await readFile(join(projectStatePath(state, repository), 'registration.json'), 'utf8')), { repository, checkout, completed: true, agent: 'claude', adopted: true });
const again = await attempt(state, { apps: await named() });
assert.equal(again.output.at(-1), `The Forge is already set up for ${repository}.`);
assert.deepEqual(await snapshot(), before);

testCase('the Apps the owner names are used and none is created');
assert.deepEqual(JSON.parse(await readFile(join(credentialPath(state, repository), 'builder-app.json'), 'utf8')), { id: 11, slug: 'own-builder', pem: 'PEM' });
assert.deepEqual(first.created, { begin: 0, install: 0 });

testCase('an App the owner named that is not installed on the project, or whose key cannot be read, stops adoption with one sentence and records nothing');
{
  const notInstalled = await attempt(join(root, 'state-2'), { apps: await named(), github: { appStatus: async () => 'not-installed' } });
  assert.equal(notInstalled.output.at(-1), `Setup stopped because your builder App own-builder is not installed on ${repository}. Install it on that repository only, then try setup again; setup does not make a new App when you named one.`);
  const apps = await named();
  apps.release.key_file = join(root, 'missing.pem');
  const noKey = await attempt(join(root, 'state-3'), { apps });
  assert.match(noKey.output.at(-1), /^Setup stopped because the key file of your release App own-release could not be read\./);
  for (const stopped of [notInstalled, noKey]) assert.deepEqual(stopped.created, { begin: 0, install: 0 });
  assert.deepEqual(await snapshot(), before);
  await assert.rejects(readFile(join(projectStatePath(join(root, 'state-2'), repository), 'registration.json')), { code: 'ENOENT' });
}

testCase('a different or unknown version of the build tools gets one sentence, and a project the Forge began installing in is not adopted');
{
  await sampleCheckout('b'.repeat(40));
  const differs = await attempt(join(root, 'state-4'), { apps: await named() });
  assert.equal(differs.output.at(-2), `The factory installed here runs on build tools bbbbbbb and this Forge expects ${ARCHON_REVISION.slice(0, 7)}; setup left it as it is.`);
  assert.equal(differs.output.at(-1), DONE);
  await sampleCheckout();
  const unknown = await attempt(join(root, 'state-5'), { apps: await named() });
  assert.equal(unknown.output.at(-2), 'Setup could not tell which version of the build tools the installed factory runs on and left it as it is.');
  await writeFile(join(checkout, '.git', 'godspeed-forge-install.json'), '{}\n');
  const began = await attempt(join(root, 'state-6'), { apps: await named() });
  assert(!began.output.includes(FOUND), 'the Forge began installing here, so this is not an owner\'s factory');
  assert(began.calls.some(c => c.startsWith('git clone')), 'the normal setup went on to download the factory');
}
