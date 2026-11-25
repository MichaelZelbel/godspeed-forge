// The sweep of temporaries left beside private saves, and the removal of a failed save's own temporary (#100):
// the sweep must take only the temporaries of saves whose process is gone and that it can read, and never the
// saved file itself, a temporary of a live save, or a file it cannot look up or read.
// test cases: 5
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { files } from '../lib/files.mjs';
import { createApps } from '../lib/github-apps.mjs';
import { abandonSaves, removeStaleTemporaries, writePrivateJson } from '../lib/config.mjs';
import { testCase } from './cases.mjs';

// A pid no process can have, so `process.kill(pid, 0)` answers ESRCH: the writer is gone.
const GONE = 2147483646;
// A pid of a process that is running and belongs to this user: the test's own parent.
const LIVE = process.ppid;

testCase('a later run removes only temporaries of saves that are gone and that it can read');
{
  const folder = await mkdtemp(join(tmpdir(), 'forge-private-saves-'));
  const saved = join(folder, 'builder-app.json');
  await writeFile(saved, '{"id": 1}\n', { mode: 0o600 });
  const unreadable = join(folder, `mission.json.${GONE}.tmp`);
  await writeFile(unreadable, '{"id": 1', { mode: 0o000 });
  await mkdir(join(folder, `registration.json.${GONE - 1}.tmp`));
  await symlink(saved, join(folder, `pending.json.${GONE - 2}.tmp`));
  await writeFile(join(folder, `builder-app-pending.json.${LIVE}.tmp`), '{"code": "x"}');
  await writeFile(join(folder, `notes.${GONE - 3}.tmp`), 'not a saved file');
  await writeFile(join(folder, `builder-app.json.${process.pid}.tmp`), '{"id": 1');
  await writeFile(join(folder, `builder-app.json.${GONE}.tmp`), '{"id": 1');

  await removeStaleTemporaries(folder);
  await removeStaleTemporaries(join(folder, 'missing'));

  const names = new Set(await readdir(folder));
  assert.equal(await readFile(saved, 'utf8'), '{"id": 1}\n', 'the saved file was touched');
  assert((await files.lstat(saved)).isFile());
  assert(names.has(`mission.json.${GONE}.tmp`), 'the temporary that cannot be read was removed');
  assert(names.has(`registration.json.${GONE - 1}.tmp`), 'the temporary that is a directory was removed');
  assert(names.has(`pending.json.${GONE - 2}.tmp`), 'the temporary that is a link was removed');
  assert(names.has(`builder-app-pending.json.${LIVE}.tmp`), 'the temporary of a live save was removed');
  assert(names.has(`notes.${GONE - 3}.tmp`), 'a file that is not a save\'s temporary was removed');
  assert(!names.has(`builder-app.json.${process.pid}.tmp`), 'the run\'s own stale temporary stayed');
  assert(!names.has(`builder-app.json.${GONE}.tmp`), 'the temporary of a save whose writer is gone stayed');
  await chmod(unreadable, 0o600);
  await rm(folder, { recursive: true, force: true });
}

testCase('a save that fails removes its temporary');
{
  const folder = await mkdtemp(join(tmpdir(), 'forge-private-saves-'));
  const rename = files.rename;
  files.rename = async () => {
    throw Object.assign(new Error(`EACCES: permission denied, rename '${folder}/x.json'`), { code: 'EACCES' });
  };
  try {
    await assert.rejects(writePrivateJson(join(folder, 'x.json'), { a: 1 }), { code: 'EACCES' });
    assert.deepEqual((await readdir(folder)).filter(name => name.endsWith('.tmp')), []);
  } finally {
    files.rename = rename;
    await rm(folder, { recursive: true, force: true });
  }
}
testCase('the sweep takes a temporary a real save wrote');
{
  const folder = await mkdtemp(join(tmpdir(), 'forge-private-saves-'));
  const rename = files.rename;
  const unlink = files.unlink;
  // A save that cannot finish and cannot remove its own temporary: the rename fails and the unlink does
  // nothing, so the temporary the writer itself built stays on disk for the sweep to take.
  files.rename = async () => {
    throw Object.assign(new Error(`EACCES: permission denied, rename '${folder}/builder-app.json'`), { code: 'EACCES' });
  };
  files.unlink = async () => {};
  try {
    await assert.rejects(writePrivateJson(join(folder, 'builder-app.json'), { id: 1 }), { code: 'EACCES' });
  } finally {
    files.rename = rename;
    files.unlink = unlink;
  }
  assert.equal((await readdir(folder)).filter(name => name.endsWith('.tmp')).length, 1,
    'the failed save left no temporary for the sweep to take');
  await removeStaleTemporaries(folder);
  assert.deepEqual((await readdir(folder)).filter(name => name.endsWith('.tmp')), [],
    'the sweep left the temporary a real save wrote behind');
  await rm(folder, { recursive: true, force: true });
}

testCase('a stopped run abandons its saves except those marked keepOnStop');
{
  const folder = await mkdtemp(join(tmpdir(), 'forge-private-saves-'));
  const rename = files.rename;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  files.rename = async (from, to) => { await held; return rename(from, to); };
  try {
    const kept = writePrivateJson(join(folder, 'builder-app-pending.json'), { code: 'c' }, { keepOnStop: true });
    const dropped = writePrivateJson(join(folder, 'settings.json'), { a: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    await abandonSaves();
    release();
    await kept;
    await assert.rejects(dropped, { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(join(folder, 'builder-app-pending.json'), 'utf8')), { code: 'c' });
    assert.deepEqual((await readdir(folder)).sort(), ['builder-app-pending.json']);
  } finally {
    files.rename = rename;
    await rm(folder, { recursive: true, force: true });
  }
}
testCase('a stop landing on any save of an App\'s pending record still lets that save finish, for both roles');
{
  const root = await mkdtemp(join(tmpdir(), 'forge-private-saves-'));
  const [stateDirectory, credentialDirectory, checkout] = ['state', 'credentials', 'checkout'].map(name => join(root, name));
  for (const folder of [stateDirectory, credentialDirectory, join(checkout, '.git')]) await mkdir(folder, { recursive: true });
  const rename = files.rename;
  const finished = [];
  // The stop arrives while each pending-record save is in flight; a save dropped by it fails its rename.
  files.rename = async (from, to) => {
    const pending = to.endsWith('-app-pending.json');
    if (pending) await abandonSaves();
    await rename(from, to);
    if (pending) finished.push(JSON.parse(await readFile(to, 'utf8')));
  };
  const keys = { id: 7, slug: 'forge-app', pem: 'PRIVATE KEY' };
  const github = {
    begin: async () => ({ url: 'https://github.test/page' }),
    callback: async () => 'code-1',
    exchange: async () => keys,
    install: async () => true
  };
  try {
    await createApps({ repository: 'owner/repo', stateDirectory, credentialDirectory, checkout, github, output: () => {} });
    assert.deepEqual(finished, ['builder', 'release'].flatMap(() => [{ code: null }, { code: 'code-1' }, { code: 'code-1', credentials: keys }]));
  } finally {
    files.rename = rename;
    await rm(root, { recursive: true, force: true });
  }
}
console.log('private save tests pass');
