// The command itself, run as the owner runs it: every stop exits 1 and prints only the plain sentence.
// test cases: 3
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
await mkdir(join(home, '.godspeed/forge'), { recursive: true });
await writeFile(join(home, '.godspeed/forge/config.json'), '', { mode: 0o600 });
const empty = forge('setup', 'owner/repo');
assert.deepEqual([empty.status, empty.stdout, empty.stderr], [1,
  'Setup stopped because the Forge\'s settings file on this server is damaged. Delete config.json in the folder where the Forge keeps its settings before trying setup again, and setup writes a fresh one.\n', '']);

await rm(home, { recursive: true, force: true });
