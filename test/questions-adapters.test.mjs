import assert from 'node:assert/strict';
import { createQuestionsGithub } from '../lib/questions/github.mjs';
import { createGodspeedAdapter } from '../lib/questions/godspeed.mjs';

const modelCalls = [];
const records = [
  { id: 'browser-10', role: 'user', content: 'browser answer', source_app: 'browser-chat', conversation_id: 'browser-owner', created_at: '2026-01-02T00:00:00Z' },
  { id: 'telegram-9', role: 'user', content: 'telegram answer', source_app: 'telegram', conversation_id: 'telegram-owner', created_at: '2026-01-01T00:00:00Z' },
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
