// The chat inbox (lib/inbox.mjs) and the dispatch by kind (lib/owner/index.mjs): every request is handled once, moved to
// done/, answered in outbox/, and a bad request, an unknown kind, a module not on this server yet or a failing handler
// is answered plainly while the others go on. The handlers are stand-in modules in a folder of the test's own.
// test cases: 17
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testCase } from './cases.mjs';
import { createBridge } from '../lib/godspeed.mjs';
import { runInbox, takeInboxLock, inboxIdle, INBOX, DONE, OUTBOX } from '../lib/inbox.mjs';
import { dispatch, handlerFor, KINDS, SAY } from '../lib/owner/index.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'forge-inbox-'));
let n = 0;
const fresh = () => { const d = path.join(root, `t${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const NOW = Date.parse('2026-11-22T12:00:00Z');

// Stand-in handler modules in <dir>/lib/owner/ and <dir>/lib/, as parts of the Forge would put them; each call is
// written to calls.log beside them.
function handlers(modules) {
  const dir = fresh();
  fs.mkdirSync(path.join(dir, 'lib', 'owner'), { recursive: true });
  for (const [rel, text] of Object.entries(modules)) fs.writeFileSync(path.join(dir, 'lib', rel), text);
  return { base: pathToFileURL(path.join(dir, 'lib', 'owner', 'index.mjs')).href, log: path.join(dir, 'calls.log') };
}
const logging = (log, name, answer) => `import fs from 'node:fs';
export async function ${name}(request, ctx) { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, id: request.id, ctx: Object.keys(ctx).sort(), now: ctx.now, config: ctx.config }) + '\\n'); return ${answer}; }
`;
const calls = log => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

function setup({ uid = 1000 } = {}) {
  const workspace = fresh(), state = fresh(), chowns = [];
  const gs = createBridge({ kind: 'native', version: '2.0.0-beta.29', workspace, owner: { uid: 10000, gid: 10000 } },
    { fs: { ...fs, chownSync: (p, u, g) => chowns.push([p, u, g]) }, uid, stateDir: state });
  const paths = { addon: fresh(), executable: '', config: path.join(state, 'config.json'), state };
  const request = (name, value, mtime) => {
    const file = path.join(workspace, ...INBOX.split('/'), name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
  };
  const outbox = id => { try { return JSON.parse(fs.readFileSync(path.join(workspace, ...OUTBOX.split('/'), `${id}.json`), 'utf8')); } catch { return null; } };
  const list = rel => { try { return fs.readdirSync(path.join(workspace, ...rel.split('/'))).sort(); } catch { return []; } };
  const lines = [];
  const run = (more = {}) => runInbox({ gs, config: { projectsRoot: '/srv/projects' }, paths, now: () => NOW, log: l => lines.push(l), ...more });
  return { workspace, state, gs, paths, request, outbox, list, lines, run, chowns };
}

testCase('the Forge knows the eight kinds the chat can ask for');
assert.deepEqual([...KINDS].sort(), ['answer', 'go', 'lap', 'plan', 'status', 'take-back', 'watch', 'work-off', 'work-on']);

testCase('a request is handled once: answered in the outbox, moved to done, and never run again');
{
  const h = handlers({});
  fs.writeFileSync(path.join(path.dirname(fileURLToPath(h.base)), 'releases.mjs'), logging(h.log, 'status', "{ ok: true, say: 'Version 1.4.0 is public; nothing is being built.' }"));
  const t = setup();
  t.request('status-1.json', { id: 'status-1', kind: 'status', project: 'alice/app', words: 'release status?', at: '2026-11-22T11:59:00Z' });
  const first = await t.run({ dispatchOptions: { base: h.base } });
  assert.deepEqual(first.handled.map(r => [r.id, r.kind, r.ok]), [['status-1', 'status', true]]);
  assert.deepEqual(t.outbox('status-1'), { id: 'status-1', ok: true, say: 'Version 1.4.0 is public; nothing is being built.' });
  assert.deepEqual(t.list(INBOX), ['done']);
  assert.deepEqual(t.list(DONE), ['status-1.json']);
  await t.run({ dispatchOptions: { base: h.base } });
  assert.equal(calls(h.log).length, 1, 'a second run does not run it again');
}

testCase('a handler is given the request and the context { config, gs, log, now, paths }');
{
  const h = handlers({});
  fs.writeFileSync(path.join(path.dirname(fileURLToPath(h.base)), 'questions.mjs'), logging(h.log, 'answer', "{ ok: true, say: 'I passed your answer on.' }"));
  const t = setup();
  t.request('a1.json', { id: 'a1', kind: 'answer', handle: 'F7', project: 'alice/app', words: 'F7 keep it', at: '2026-11-22T11:59:00Z' });
  await t.run({ dispatchOptions: { base: h.base } });
  const [call] = calls(h.log);
  assert.deepEqual(call.ctx, ['config', 'gs', 'log', 'now', 'paths']);
  assert.equal(call.now, NOW);
  assert.deepEqual(call.config, { projectsRoot: '/srv/projects' });
  assert.deepEqual(t.outbox('a1'), { id: 'a1', ok: true, say: 'I passed your answer on.' });
}

testCase('an unknown kind is refused plainly, and the next request is still handled');
{
  const h = handlers({});
  fs.writeFileSync(path.join(path.dirname(fileURLToPath(h.base)), 'releases.mjs'), logging(h.log, 'go', "{ ok: true, say: 'Version 1.5.0 is public now.' }"));
  const t = setup();
  t.request('a.json', { id: 'a', kind: 'delete-everything', words: 'delete it all' });
  t.request('b.json', { id: 'b', kind: 'go', project: 'alice/app', words: 'go' });
  await t.run({ dispatchOptions: { base: h.base } });
  assert.deepEqual(t.outbox('a'), { id: 'a', ok: false, say: 'The Forge did not understand that request and did nothing.' });
  assert.deepEqual(t.outbox('b'), { id: 'b', ok: true, say: 'Version 1.5.0 is public now.' });
}

testCase('a kind whose module is not on this server yet, or lacks its handler, is answered that the Forge cannot do it yet');
{
  const h = handlers({ 'owner/releases.mjs': 'export const nothing = 1;\n' });
  const t = setup();
  t.request('l.json', { id: 'l', kind: 'lap', words: 'run one lap' });
  t.request('g.json', { id: 'g', kind: 'take-back', project: 'alice/app', words: 'take it back' });
  await t.run({ dispatchOptions: { base: h.base } });
  assert.deepEqual(t.outbox('l'), { id: 'l', ok: false, say: 'The Forge cannot do that yet on this server.' });
  assert.deepEqual(t.outbox('g'), { id: 'g', ok: false, say: 'The Forge cannot do that yet on this server.' });
  assert.equal((await handlerFor('work-on', { base: h.base })).handler, null);
  assert.deepEqual(await handlerFor('nonsense', { base: h.base }), { known: false });
}

testCase('a broken module, a handler that throws and one that gives no words are answered plainly and logged');
{
  const h = handlers({
    'owner/questions.mjs': 'export async function answer( {\n',
    'owner/releases.mjs': "export async function plan() { throw new Error('GitHub refused the issue'); }\nexport async function status() { return { ok: true }; }\n",
    'factory-control.mjs': "export async function workOn() { return { ok: true, say: 'Automatic work is on.' }; }\n",
  });
  const t = setup();
  t.request('1.json', { id: 'q1', kind: 'answer', handle: 'F1', words: 'F1 yes' });
  t.request('2.json', { id: 'p1', kind: 'plan', project: 'alice/app', words: 'yes' });
  t.request('3.json', { id: 's1', kind: 'status', words: 'status' });
  t.request('4.json', { id: 'w1', kind: 'work-on', words: 'turn on automatic work' });
  await t.run({ dispatchOptions: { base: h.base } });
  for (const id of ['q1', 'p1', 's1']) assert.deepEqual(t.outbox(id), { id, ok: false, say: 'Something went wrong on the server while the Forge worked on that, so it may not be done. Try again in a few minutes.' });
  assert.deepEqual(t.outbox('w1'), { id: 'w1', ok: true, say: 'Automatic work is on.' });
  assert.ok(t.lines.some(l => l === 'The plan request p1 failed: GitHub refused the issue'), t.lines.join('\n'));
  assert.ok(t.lines.some(l => l === 'The status request s1 failed: the status handler gave no words for the owner'), t.lines.join('\n'));
}

testCase('a request that cannot be read is answered once it is old enough not to be still being written');
{
  const t = setup();
  t.request('broken.json', '{"id": "broken", "kind": ', NOW - 60000);
  t.request('young.json', '{"id": "young", ', NOW - 1000);
  t.request('list.json', '[1, 2]', NOW - 60000);
  await t.run();
  assert.deepEqual(t.outbox('broken'), { id: 'broken', ok: false, say: 'The Forge could not read that request and did nothing.' });
  assert.deepEqual(t.outbox('list'), { id: 'list', ok: false, say: 'The Forge could not read that request and did nothing.' });
  assert.equal(t.outbox('young'), null);
  assert.ok(t.list(INBOX).includes('young.json'), 'a young file waits for the next run');
}

testCase('a request a stopped run took but never answered is answered as interrupted, not done again');
{
  const t = setup();
  fs.mkdirSync(path.join(t.workspace, ...DONE.split('/')), { recursive: true });
  fs.writeFileSync(path.join(t.workspace, ...DONE.split('/'), 'go-7.json'), JSON.stringify({ id: 'go-7', kind: 'go' }));
  fs.utimesSync(path.join(t.workspace, ...DONE.split('/'), 'go-7.json'), new Date(NOW - 60000), new Date(NOW - 60000));
  const r = await t.run();
  assert.deepEqual(t.outbox('go-7'), { id: 'go-7', ok: false, say: 'The Forge was interrupted while it worked on that, so it may not be done. Try again in a few minutes.' });
  assert.deepEqual(r.handled.map(x => [x.id, x.interrupted]), [['go-7', true]]);
}

testCase('the same request again after it was answered keeps its first answer and is not run twice');
{
  const h = handlers({});
  fs.writeFileSync(path.join(path.dirname(fileURLToPath(h.base)), 'releases.mjs'), logging(h.log, 'go', "{ ok: true, say: 'Version 1.5.0 is public now.' }"));
  const t = setup();
  t.request('go-1.json', { id: 'go-1', kind: 'go', project: 'alice/app', words: 'go' });
  await t.run({ dispatchOptions: { base: h.base } });
  t.request('go-1.json', { id: 'go-1', kind: 'go', project: 'alice/app', words: 'go' });
  await t.run({ dispatchOptions: { base: h.base } });
  assert.equal(calls(h.log).length, 1);
  assert.deepEqual(t.list(DONE), ['go-1.json', 'go-1.json.again-1795348800000']);
  assert.equal(inboxIdle(path.join(t.workspace, ...INBOX.split('/'))), true, 'the kept copy is no request waiting for an answer');
  assert.deepEqual((await t.run({ dispatchOptions: { base: h.base } })).handled, [], 'nor is it answered as interrupted');
  assert.equal(t.outbox('go-1').say, 'Version 1.5.0 is public now.');
}

testCase('two runs never overlap, and a lock left by a run that is gone is taken over');
{
  const t = setup();
  t.request('u.json', { id: 'u', kind: 'unknown' });
  const lock = path.join(t.state, 'inbox.lock');
  const release = takeInboxLock(fs, lock);
  assert.ok(release);
  const busy = await t.run();
  assert.deepEqual(busy, { handled: [], skipped: true });
  assert.equal(t.outbox('u'), null);
  release();
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), '999999999\n');
  await t.run();
  assert.equal(t.outbox('u').say, SAY.unknown);
  assert.ok(!fs.existsSync(lock), 'the lock is given back');
}

testCase('answers and taken requests older than 30 days are tidied away');
{
  const t = setup();
  for (const rel of [OUTBOX, DONE]) {
    const dir = path.join(t.workspace, ...rel.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.json'), '{}');
    fs.utimesSync(path.join(dir, 'old.json'), new Date(NOW - 31 * 86400000), new Date(NOW - 31 * 86400000));
  }
  fs.writeFileSync(path.join(t.workspace, ...OUTBOX.split('/'), 'new.json'), '{}');
  await t.run();
  assert.deepEqual(t.list(OUTBOX), ['new.json']);
  assert.deepEqual(t.list(DONE), []);
}

testCase('the folders and answers the Forge writes stay the workspace owner\'s');
{
  const t = setup({ uid: 0 });
  t.request('o.json', { id: 'o', kind: 'unknown' });
  await t.run();
  const owned = t.chowns.map(([p]) => path.relative(t.workspace, p).split(path.sep).join('/'));
  for (const rel of [OUTBOX, DONE]) assert.ok(owned.includes(rel), `${rel} is the owner's`);
  assert.ok(owned.some(p => /^\.godspeed\/forge\/outbox\/o\.json\.\d+\.[0-9a-f]+\.tmp$/.test(p)));
  assert.ok(t.chowns.every(([, u, g]) => u === 10000 && g === 10000));
}

testCase('dispatch without a handler module of the tests answers every kind in words');
{
  for (const kind of KINDS) {
    const r = await dispatch({ id: 'x', kind }, {}).catch(e => ({ thrown: e.message }));
    assert.ok(typeof r.say === 'string' || typeof r.thrown === 'string', kind);
  }
  assert.deepEqual(await dispatch({ id: 'x', kind: 'no-such-kind' }, {}), { ok: false, say: SAY.unknown });
  assert.deepEqual(await dispatch(null, {}), { ok: false, say: SAY.unknown });
}

// The command itself, as the inbox service runs it: a home of the test's own, the Godspeed named outright.
const command = fileURLToPath(new URL('../bin/godspeed-forge.mjs', import.meta.url));
function inboxCommand(env) {
  return spawnSync(process.execPath, [command, 'inbox'], { env: { ...process.env, GODSPEED_HEALTH_URL: 'http://127.0.0.1:9/health', GODSPEED_DIR: '', ...env }, encoding: 'utf8', timeout: 60000 });
}

testCase('godspeed-forge inbox answers the waiting requests and exits 0');
{
  const home = fresh(), workspace = fresh();
  const file = path.join(workspace, ...INBOX.split('/'), 'c1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: 'c1', kind: 'make-coffee', words: 'make coffee' }));
  const r = inboxCommand({ HOME: home, USERPROFILE: home, GODSPEED_WORKSPACE: workspace, GODSPEED_VERSION: '2.0.0-beta.29' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, ...OUTBOX.split('/'), 'c1.json'), 'utf8')), { id: 'c1', ok: false, say: SAY.unknown });
  assert.match(r.stdout, /Handled 1 chat request\./);
}

testCase('godspeed-forge inbox on a server whose Godspeed is too old says so and exits 1');
{
  const home = fresh(), workspace = fresh();
  const r = inboxCommand({ HOME: home, USERPROFILE: home, GODSPEED_WORKSPACE: workspace, GODSPEED_VERSION: '2.0.0-beta.10' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'Godspeed 2.0.0-beta.10 is installed; the Forge requires Godspeed 2.0.0-beta.24 or newer. Update Godspeed, then run this line again.\n');
}

testCase('the service ends at once when its inbox holds nothing to do, without looking for Godspeed');
{
  const workspace = fresh();
  const inbox = path.join(workspace, ...INBOX.split('/'));
  fs.mkdirSync(path.join(inbox, 'done'), { recursive: true });
  fs.mkdirSync(path.join(workspace, ...OUTBOX.split('/')), { recursive: true });
  assert.equal(inboxIdle(inbox), true);
  fs.writeFileSync(path.join(inbox, 'done', 'a1.json'), '{}');
  assert.equal(inboxIdle(inbox), false, 'a taken request with no answer is something to do');
  fs.writeFileSync(path.join(workspace, ...OUTBOX.split('/'), 'a1.json'), '{}');
  assert.equal(inboxIdle(inbox), true);
  fs.writeFileSync(path.join(inbox, 'r.json.tmp'), '{');
  assert.equal(inboxIdle(inbox), true, 'a request still being written is not one yet');
  const home = fresh();
  const idle = inboxCommand({ HOME: home, USERPROFILE: home, FORGE_INBOX: inbox, GODSPEED_WORKSPACE: '', GODSPEED_VERSION: '2.0.0-beta.1' });
  assert.deepEqual([idle.status, idle.stdout], [0, ''], 'no Godspeed was looked for, so its old version was never met');
  fs.writeFileSync(path.join(inbox, 'r.json'), '{"id":"r","kind":"x"}');
  assert.equal(inboxIdle(inbox), false);
  assert.equal(inboxIdle(path.join(workspace, 'missing')), false);
}

testCase('every answer the inbox can give the owner is plain: no dashes of the long kinds');
for (const words of Object.values(SAY)) assert.ok(!/[–—]/.test(words), words);

await rm(root, { recursive: true, force: true });
