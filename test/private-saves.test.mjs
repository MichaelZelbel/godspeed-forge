// The sweep of temporaries left beside private saves, and the removal of a failed save's own temporary (#100):
// the sweep must take only the temporaries of saves whose process is gone and that it can read, and never the
// saved file itself, a temporary of a live save, or a file it cannot look up or read.
// test cases: 2
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { files } from '../lib/files.mjs';
import { removeStaleTemporaries, writePrivateJson } from '../lib/config.mjs';
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
console.log('private save tests pass');
