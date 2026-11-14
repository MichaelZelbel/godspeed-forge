import { existsSync } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CLASSIFY_SYSTEM = `Return only JSON. Decide whether the supplied question asks the owner for a product or policy choice, rather than an implementation choice. For an owner choice return {"owner":true,"example":"...","choices":["...","..."],"default":"...","applies":"..."}. Otherwise return {"owner":false}. Do not add keys or prose.`;
const MATCH_SYSTEM = `Return only JSON. Match the owner's message to exactly one supplied pending product question. Return {"key":"the supplied key"} only when the message unambiguously answers that question; otherwise return {"key":null}. Do not add keys or prose.`;
const DOCKER_WORKSPACE = '/opt/data/full-candidate/workspace';

const DOCKER_BOUNDARY = `import fs from 'node:fs';
import { Store } from '/opt/godspeed/kit/notebook/core/records/store.mjs';
import { queueNotice } from '/opt/godspeed/kit/notebook/core/notices.mjs';
const request=JSON.parse(fs.readFileSync(0,'utf8'));
const store=Store.inspect(request.workspace);
if(request.action==='records')process.stdout.write(JSON.stringify(store.list('conversation_messages')));
else if(request.action==='notice'){queueNotice(store,request.notice);process.stdout.write('{}');}
else throw Error('Unknown Forge boundary action');`;

async function defaultGodspeedModules(modelCommand, root, run, dockerCommand) {
  const launcher = await readFile(modelCommand, 'utf8');
  const match = launcher.trim().match(/^import ("(?:[^"\\]|\\.)*");$/);
  if (match) {
    const modelUrl = new URL(JSON.parse(match[1]));
    const notebook = new URL('..', modelUrl);
    const [{ Store }, { queueNotice }] = await Promise.all([
      import(new URL('core/records/store.mjs', notebook)),
      import(new URL('core/notices.mjs', notebook))
    ]);
    return { records: async () => Store.inspect(root).list('conversation_messages'), notice: async value => queueNotice(Store.inspect(root), value) };
  }
  const descriptor = JSON.parse(await readFile(join(dirname(modelCommand), 'model-host.json'), 'utf8'));
  if (!descriptor || Object.keys(descriptor).sort().join(',') !== 'format,kind,service,workspace' || descriptor.format !== 1 || descriptor.kind !== 'godspeed-docker' || descriptor.service !== 'godspeed' || descriptor.workspace !== DOCKER_WORKSPACE) {
    throw new Error('The Godspeed model launcher does not expose a supported notebook boundary.');
  }
  const command = dockerCommand ?? ['/usr/bin/docker', '/usr/local/bin/docker'].find(existsSync);
  if (!command || !existsSync(join(root, 'compose.yaml'))) throw new Error('The connected Godspeed Docker boundary is unavailable.');
  const args = ['compose', '-p', 'godspeed-mission-control', '--project-directory', root, '-f', join(root, 'compose.yaml'), '--env-file', join(root, '.env'), 'exec', '-T', '--user', 'hermes', descriptor.service, 'node', '--input-type=module', '--eval', DOCKER_BOUNDARY];
  const request = async value => JSON.parse((await run(command, args, { input: JSON.stringify({ workspace: descriptor.workspace, ...value }) })).stdout || '{}');
  return { records: () => request({ action: 'records' }), notice: value => request({ action: 'notice', notice: value }) };
}

export function createGodspeedAdapter({ root, modelCommand, run, modules = defaultGodspeedModules, dockerCommand }) {
  const boundary = async () => {
    const value = await modules(modelCommand, root, run, dockerCommand);
    if (value.records && value.notice) return value;
    const store = value.inspect(root);
    return { records: async () => store.list('conversation_messages'), notice: async notice => value.queueNotice(store, notice) };
  };
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
      await (await boundary()).notice(notice);
    },
    async messages({ reviewed = [], startedAt } = {}) {
      const records = await (await boundary()).records();
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
