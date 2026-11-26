// The command itself, run as the owner runs it: every stop exits 1 and prints only the plain sentence.
// test cases: 5
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AFRESH_PARTS } from '../lib/setup.mjs';
import { testCase } from './cases.mjs';

const command = fileURLToPath(new URL('../bin/godspeed-forge.mjs', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'forge-cli-'));
const forge = (...args) => spawnSync(process.execPath, [command, ...args], {
  env: { ...process.env, HOME: home }, input: '', encoding: 'utf8', timeout: 30000
});

testCase('the command without a repository prints how to run it and exits 1');
const usage = forge();
assert.deepEqual([usage.status, usage.stdout, usage.stderr], [1, '', 'Run godspeed-forge setup owner/repository.\n']);

testCase('a repository name not in the form owner/repository stops plainly with exit 1');
const badName = forge('setup', 'bad name');
assert.deepEqual([badName.status, badName.stdout, badName.stderr], [1,
  'Setup stopped because the repository name is not in the form owner/repository. Try setup again with a name in that form.\n', '']);

testCase('an empty settings file stops plainly with exit 1');
const settings = join(home, '.godspeed/forge/config.json');
await mkdir(join(home, '.godspeed/forge'), { recursive: true });
await writeFile(settings, '', { mode: 0o600 });
const empty = forge('setup', 'owner/repo');
assert.deepEqual([empty.status, empty.stdout, empty.stderr], [1,
  'Setup stopped because the Forge\'s settings file on this server cannot be read. Ask me to start the Forge\'s settings afresh, and setup replaces only that file with the default settings.\n', '']);
assert.equal(await readFile(settings, 'utf8'), '');

testCase('--start-afresh names one file setup replaces, and anything else after the repository prints how to run it');
for (const extra of [['--start-afresh'], ['--start-afresh', 'everything'], ['--start-afresh', 'settings', 'mission'], ['settings']]) {
  const refused = forge('setup', 'owner/repo', ...extra);
  assert.deepEqual([refused.status, refused.stdout, refused.stderr], [1, '', 'Run godspeed-forge setup owner/repository.\n']);
}
assert.equal(await readFile(settings, 'utf8'), '');
// The settings are replaced before the repository name is looked at, which then stops setup.
const afresh = forge('setup', 'bad name', '--start-afresh', 'settings');
assert.deepEqual([afresh.status, afresh.stdout, afresh.stderr], [1,
  'Setup stopped because the repository name is not in the form owner/repository. Try setup again with a name in that form.\n', '']);
assert.equal(JSON.parse(await readFile(settings, 'utf8')).projectsRoot, join(home, 'projects'));

testCase('the forge skill maps the words of each stop to every part setup can start afresh, and to no other');
{
  const skill = await readFile(new URL('../skills/forge/SKILL.md', import.meta.url), 'utf8');
  const rows = [...skill.matchAll(/^ *\| (.+) \| `([\w-]+)` \|$/gm)].map(([, words, part]) => [part, words]);
  assert.deepEqual(rows, Object.entries(AFRESH_PARTS).map(([part, { words }]) => [part, words]));
}

await rm(home, { recursive: true, force: true });
