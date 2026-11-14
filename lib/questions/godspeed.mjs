import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const CLASSIFY_SYSTEM = `Return only JSON. Decide whether the supplied question asks the owner for a product or policy choice, rather than an implementation choice. For an owner choice return {"owner":true,"example":"...","choices":["...","..."],"default":"...","applies":"..."}. Otherwise return {"owner":false}. Do not add keys or prose.`;
const MATCH_SYSTEM = `Return only JSON. Match the owner's message to exactly one supplied pending product question. Return {"key":"the supplied key"} only when the message unambiguously answers that question; otherwise return {"key":null}. Do not add keys or prose.`;

async function defaultGodspeedModules(modelCommand) {
  const launcher = await readFile(modelCommand, 'utf8');
  const match = launcher.trim().match(/^import ("(?:[^"\\]|\\.)*");$/);
  if (!match) throw new Error('The Godspeed model launcher does not expose the installed notebook boundary.');
  const modelUrl = new URL(JSON.parse(match[1]));
  const notebook = new URL('../..', modelUrl);
  const [{ Store }, { queueNotice }] = await Promise.all([
    import(new URL('core/records/store.mjs', notebook)),
    import(new URL('core/notices.mjs', notebook))
  ]);
  return { inspect: root => Store.inspect(root), queueNotice };
}

export function createGodspeedAdapter({ root, modelCommand, run, modules = defaultGodspeedModules }) {
  async function model(system, prompt) {
    const { stdout } = await run(process.execPath, [modelCommand, '--workspace', root], {
      input: JSON.stringify({ system, prompt, timeout_ms: 120_000, max_tokens: 2_048 })
    });
    if (stdout.length > 65_536) throw new Error('The Godspeed model response was too large.');
    const result = JSON.parse(stdout);
    if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('The Godspeed model returned no answer.');
    return JSON.parse(result.text);
  }
  return {
    classify: question => model(CLASSIFY_SYSTEM, JSON.stringify(question)),
    match: (message, questions) => model(MATCH_SYSTEM, JSON.stringify({ message, questions })),
    async notice(notice) {
      const boundary = await modules(modelCommand);
      boundary.queueNotice(boundary.inspect(root), notice);
    },
    async messages({ reviewed = [], startedAt } = {}) {
      const boundary = await modules(modelCommand);
      const records = boundary.inspect(root).list('conversation_messages');
      const seen = new Set(reviewed.map(String));
      return records.filter(record => record.role === 'user' && typeof record.created_at === 'string' && record.created_at >= startedAt && !seen.has(String(record.id)) && (
        (record.source_app === 'telegram' && record.conversation_id === 'telegram-owner') ||
        (record.source_app === 'browser-chat' && record.conversation_id === 'browser-owner')
      )).map(record => ({ id: String(record.id), source: record.source_app, content: record.content, createdAt: record.created_at }))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
    }
  };
}

export async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  return async () => file.close().then(() => import('node:fs/promises')).then(fs => fs.unlink(path));
}
