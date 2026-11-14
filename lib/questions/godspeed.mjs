import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function createGodspeedAdapter({ root, modelCommand, run }) {
  function modelJson(stdout) {
    if (stdout.length > 65_536) throw new Error('The Godspeed model response was too large.');
    return JSON.parse(stdout);
  }
  return {
    async classify(question) {
      const { stdout } = await run(process.execPath, [modelCommand, 'godspeed-model', '--workspace', root], {
        input: JSON.stringify({ task: 'classify-owner-question', question })
      });
      return modelJson(stdout);
    },
    async match(message, questions) {
      const { stdout } = await run(process.execPath, [modelCommand, 'godspeed-model', '--workspace', root], {
        input: JSON.stringify({ task: 'match-owner-reply', message, questions })
      });
      return modelJson(stdout);
    },
    async notice(notice) {
      const path = join(root, '.godspeed/notices.json');
      const document = await readJson(path, { notices: [] });
      if (!Array.isArray(document.notices)) throw new Error('Godspeed notices are malformed.');
      if (!document.notices.some(item => item.id === notice.id)) {
        document.notices = [...document.notices, notice].slice(-50);
        await atomic(path, document);
      }
    },
    async messages(cursors = {}) {
      const document = await readJson(join(root, '.godspeed/conversation_messages.json'), []);
      const records = Array.isArray(document) ? document : document.records;
      if (!Array.isArray(records)) throw new Error('Godspeed conversation records are malformed.');
      return records.filter(record => record.role === 'user' && record.authenticatedOwner === true &&
        ['telegram', 'browser'].includes(record.source) && String(record.id) > String(cursors[record.source] ?? ''))
        .sort((a, b) => String(a.createdAt ?? a.id).localeCompare(String(b.createdAt ?? b.id)));
    }
  };
}

export async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  return async () => file.close().then(() => import('node:fs/promises')).then(fs => fs.unlink(path));
}
