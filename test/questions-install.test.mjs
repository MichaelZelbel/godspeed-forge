import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAddon } from '../lib/install/install.mjs';

const root = await mkdtemp(join(tmpdir(), 'forge-install-questions-'));
const paths = Object.fromEntries(['addon', 'executable', 'config', 'state', 'units'].map(name => [name, join(root, name)]));
paths.executable = join(root, 'bin/godspeed-forge');
const workspace = join(root, 'workspace');
await mkdir(workspace);
await mkdir(join(root, 'config'), { recursive: true });
paths.config = join(root, 'config/config.json');
await writeFile(paths.config, JSON.stringify({ projectsRoot: '/kept', ownerValue: true }));
const calls = [];
const result = await installAddon({ source: new URL('..', import.meta.url).pathname, workspace, paths, scheduler: async (command, args) => calls.push([command, args]) });
const service = await readFile(result.units['godspeed-forge-questions.service'], 'utf8');
const timer = await readFile(result.units['godspeed-forge-questions.timer'], 'utf8');
const config = JSON.parse(await readFile(paths.config, 'utf8'));
assert.match(service, new RegExp(`ExecStart=${paths.executable} questions`));
assert.match(timer, /OnUnitInactiveSec=15min/);
assert.equal(config.projectsRoot, '/kept');
assert.equal(config.ownerValue, true);
assert.equal(config.godspeedRoot, workspace);
assert.equal(config.modelCommand, join(workspace, '.godspeed/model.mjs'));
assert.deepEqual(calls, [
  ['systemctl', ['--user', 'daemon-reload']],
  ['systemctl', ['--user', 'enable', '--now', 'godspeed-forge-questions.timer']]
]);
