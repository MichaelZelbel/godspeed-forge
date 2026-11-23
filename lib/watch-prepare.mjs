// What Archon's server needs before it runs read-only as the watching page (lib/watch.mjs), made only when missing and
// each with Archon's own code, as the account the factory runs as. The page's service runs this with bun before every
// start (its ExecStartPre, outside the page's read-only sandbox):
//
//   bun watch-prepare.mjs <the page's Archon folder>
//
//   1. the database with its tables, on a server where the factory has not made it yet: Archon's own `isolation list`,
//      a command that only reads, makes it. A database that is there is never opened for writing here, so the page
//      never moves the factory's database to another version;
//   2. Archon's local credential key, which its server makes at its first start: Archon's own function makes it;
//   3. the database's two side files (archon.db-wal and archon.db-shm), which a read-only connection cannot make but
//      needs: SQLite deletes them when the last program that had the database open closes it.
import nodeFs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SIDE_FILES = ['archon.db-wal', 'archon.db-shm'];

// -> the exit code. run(command, args) -> { status }; makeKey() makes the key with Archon's own function.
export async function prepare({ dir, home = path.join(process.env.HOME || '/root', '.archon'), fs = nodeFs, run, makeKey }) {
  const database = path.join(home, 'archon.db');
  if (!fs.existsSync(database)) {
    const made = run(process.execPath, [path.join(dir, 'packages', 'cli', 'src', 'cli.ts'), '--cwd', dir, 'isolation', 'list']);
    if (made.status !== 0 || !fs.existsSync(database)) return 1;
  }
  await makeKey();
  for (const name of SIDE_FILES) {
    const file = path.join(home, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o644 });
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  process.exitCode = await prepare({
    dir,
    run: (command, args) => spawnSync(command, args, { stdio: ['ignore', 'ignore', 'inherit'] }),
    makeKey: async () => (await import(pathToFileURL(path.join(dir, 'packages', 'core', 'src', 'credentials', 'config.ts')).href)).assertProviderKeysKeyAtBoot(),
  });
}
