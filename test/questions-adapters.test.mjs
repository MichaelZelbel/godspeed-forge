import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createQuestionsGithub } from '../lib/questions/github.mjs';
import { createGodspeedAdapter } from '../lib/questions/godspeed.mjs';

const modelCalls = [];
const records = [
  { id: 'old', role: 'user', content: 'old answer', source_app: 'browser-chat', conversation_id: 'browser-owner', created_at: '2025-12-31T23:59:59Z' },
  { id: 'browser-10', role: 'user', content: 'browser answer', source_app: 'browser-chat', conversation_id: 'browser-owner', created_at: '2026-01-02T00:00:00Z' },
  { id: 'telegram-9', role: 'user', content: 'telegram answer', source_app: 'telegram', conversation_id: 'telegram-owner', created_at: '2026-01-01T00:00:00Z' },
  { id: 'telegram-other', role: 'user', content: 'someone else', source_app: 'telegram', conversation_id: 'telegram-not-owner', created_at: '2026-01-02T00:00:00Z' },
  { id: 'other', role: 'user', content: 'not the owner feed', source_app: 'browser-chat', conversation_id: 'browser-owner-coaching', created_at: '2026-01-03T00:00:00Z' }
];
const queued = [];
const adapter = createGodspeedAdapter({
  root: '/workspace',
  modelCommand: '/product/notebook/bin/godspeed-model.mjs',
  run: async (command, args, options) => {
    modelCalls.push({ command, args, input: JSON.parse(options.input) });
    return { stdout: JSON.stringify({ text: JSON.stringify(modelCalls.length === 1 ? { owner: false } : { key: null }) }) };
  },
  modules: async () => ({ inspect: root => ({ root, list: type => type === 'conversation_messages' ? records : [] }), queueNotice: (store, notice) => queued.push({ store, notice }) })
});
assert.deepEqual(await adapter.classify({ key: 'one' }), { owner: false });
assert.deepEqual(await adapter.match('answer', [{ key: 'one' }]), { key: null });
for (const call of modelCalls) {
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, ['/product/notebook/bin/godspeed-model.mjs', '--workspace', '/workspace']);
  assert.deepEqual(Object.keys(call.input).sort(), ['max_tokens', 'prompt', 'system', 'timeout_ms']);
  assert(call.input.system.length && call.input.prompt.length);
}
await adapter.notice({ id: 'question-one', text: 'Choose one.' });
assert.deepEqual(queued, [{ store: { root: '/workspace', list: queued[0]?.store.list }, notice: { id: 'question-one', text: 'Choose one.' } }]);
assert.deepEqual((await adapter.messages({ reviewed: ['telegram-9'], startedAt: '2026-01-01T00:00:00Z' })).map(({ id, source, content }) => ({ id, source, content })), [
  { id: 'browser-10', source: 'browser-chat', content: 'browser answer' }
]);

// Installer-produced native launchers resolve the notebook modules one directory above bin.
const nativeRoot = await mkdtemp(join(tmpdir(), 'forge-native-boundary-'));
const notebook = join(nativeRoot, 'notebook');
await mkdir(join(notebook, 'bin'), { recursive: true });
await mkdir(join(notebook, 'core/records'), { recursive: true });
await mkdir(join(nativeRoot, 'workspace/.godspeed'), { recursive: true });
await writeFile(join(notebook, 'bin/godspeed-model.mjs'), '');
await writeFile(join(nativeRoot, 'workspace/.godspeed/model.mjs'), `import ${JSON.stringify(pathToFileURL(join(notebook, 'bin/godspeed-model.mjs')).href)};\n`);
await writeFile(join(notebook, 'core/records/store.mjs'), `export class Store { static inspect(root) { return { root, list: () => [{ id: 'native', role: 'user', content: 'native answer', source_app: 'browser-chat', conversation_id: 'browser-owner', created_at: '2026-01-02T00:00:00Z' }] }; } }`);
await writeFile(join(notebook, 'core/notices.mjs'), `export function queueNotice(store, notice) { globalThis.__forgeNativeNotice = { store, notice }; }`);
const nativeAdapter = createGodspeedAdapter({ root: join(nativeRoot, 'workspace'), modelCommand: join(nativeRoot, 'workspace/.godspeed/model.mjs'), run: async () => ({ stdout: '' }) });
await nativeAdapter.notice({ id: 'native-notice', text: 'Native.' });
assert.equal(globalThis.__forgeNativeNotice.notice.id, 'native-notice');
assert.deepEqual((await nativeAdapter.messages({ startedAt: '2026-01-01T00:00:00Z' })).map(value => value.id), ['native']);

// Docker launchers use their declared container capability instead of host module imports.
const dockerRoot = await mkdtemp(join(tmpdir(), 'forge-docker-boundary-'));
await mkdir(join(dockerRoot, '.godspeed'), { recursive: true });
await writeFile(join(dockerRoot, '.godspeed/model.mjs'), '#!/usr/bin/env node\nexport const docker = true;\n');
await writeFile(join(dockerRoot, '.godspeed/model-host.json'), JSON.stringify({ format: 1, kind: 'godspeed-docker', service: 'godspeed', workspace: '/opt/data/full-candidate/workspace' }));
await writeFile(join(dockerRoot, 'compose.yaml'), 'services: {}\n');
await writeFile(join(dockerRoot, '.env'), '');
const dockerRequests = [];
const dockerAdapter = createGodspeedAdapter({
  root: dockerRoot,
  modelCommand: join(dockerRoot, '.godspeed/model.mjs'),
  dockerCommand: process.execPath,
  run: async (command, args, options) => {
    const request = JSON.parse(options.input);
    dockerRequests.push({ command, args, request });
    return { stdout: request.action === 'records' ? JSON.stringify([{ id: 'docker', role: 'user', content: 'docker answer', source_app: 'telegram', conversation_id: 'telegram-owner', created_at: '2026-01-02T00:00:00Z' }]) : '{}' };
  }
});
await dockerAdapter.notice({ id: 'docker-notice', text: 'Docker.' });
assert.deepEqual((await dockerAdapter.messages({ startedAt: '2026-01-01T00:00:00Z' })).map(value => value.id), ['docker']);
assert.deepEqual(dockerRequests.map(value => value.request.action), ['notice', 'records']);
assert(dockerRequests.every(value => value.command === process.execPath && value.args.includes('exec') && value.args.includes('godspeed')));
assert(dockerRequests.every(value => value.request.workspace === '/opt/data/full-candidate/workspace'));

await writeFile(join(dockerRoot, '.godspeed/model-host.json'), JSON.stringify({ format: 1, kind: 'godspeed-docker', service: 'godspeed', workspace: '/opt/data/another-owner/workspace' }));
const redirectedDockerAdapter = createGodspeedAdapter({
  root: dockerRoot,
  modelCommand: join(dockerRoot, '.godspeed/model.mjs'),
  dockerCommand: process.execPath,
  run: async () => assert.fail('An altered Docker descriptor must not reach the container boundary.')
});
await assert.rejects(redirectedDockerAdapter.notice({ id: 'redirected-notice', text: 'Wrong owner.' }), /does not expose a supported notebook boundary/);
await assert.rejects(redirectedDockerAdapter.messages({ startedAt: '2026-01-01T00:00:00Z' }), /does not expose a supported notebook boundary/);

const calls = [];
const github = createQuestionsGithub({ run: async (command, args) => {
  calls.push([command, args]);
  if (args[0] === 'issue' && args[1] === 'list') return { stdout: JSON.stringify([{ number: 4, title: 'Owner decisions needed', body: 'body' }]) };
  if (args[0] === 'api') return { stdout: JSON.stringify([{ body: 'existing' }]) };
  return { stdout: '' };
} });
assert.deepEqual(await github.find('owner/repo'), { number: 4, title: 'Owner decisions needed', body: 'body', comments: [{ body: 'existing' }] });
await github.comment('owner/repo', 4, 'Owner decision\n\nYes.');
assert.deepEqual(calls, [
  ['gh', ['issue', 'list', '--repo', 'owner/repo', '--state', 'open', '--search', 'Owner decisions needed in:title', '--json', 'number,title,body']],
  ['gh', ['api', 'repos/owner/repo/issues/4/comments']],
  ['gh', ['issue', 'comment', '4', '--repo', 'owner/repo', '--body', 'Owner decision\n\nYes.']]
]);
