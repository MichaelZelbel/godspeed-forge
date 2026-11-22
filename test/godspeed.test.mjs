// The bridge to Godspeed (lib/godspeed.mjs): finding Godspeed natively and in Docker, the version check, writing into
// the workspace whole and owned by its owner, skills, and messages to the owner once per id. Docker, the health answer,
// Telegram and the commands are stand-ins; nothing reaches the network.
// test cases: 25
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCase } from './cases.mjs';
import {
  compareVersions, versionFromCommand, findGodspeed, godspeedProblem, createBridge, openGodspeed, hostPathOf,
  GodspeedStop, STOP, MINIMUM_GODSPEED,
} from '../lib/godspeed.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'forge-godspeed-'));
let n = 0;
const fresh = () => { const d = path.join(root, `t${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const noFetch = async () => { throw new Error('no health answer here'); };
const health = version => async () => ({ json: async () => ({ ok: true, format: 1, version }) });
const none = async () => ({ status: 127, stdout: '', stderr: 'not found' });

// A Godspeed Docker install folder in <opt>/gm, as the product's server installer writes it.
function dockerFolder(opt) {
  const dir = path.join(opt, 'gm');
  fs.mkdirSync(path.join(dir, '.godspeed'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services: {}\n');
  fs.writeFileSync(path.join(dir, '.godspeed', 'model-host.json'), JSON.stringify({ format: 1, kind: 'godspeed-docker', service: 'godspeed', workspace: '/opt/data/full-candidate/workspace' }));
  return dir;
}
// A stand-in docker: the compose service is running (or not), the probe inside answers, inspect names the mounts.
function dockerRun({ running = true, version = '2.0.0-beta.29', volume, envText = '' }, calls = []) {
  return async (command, args = []) => {
    calls.push([command, ...args].join(' '));
    if (command !== 'docker') return { status: 127, stdout: '', stderr: '' };
    if (args[0] === 'ps') return { status: 0, stdout: '', stderr: '' };
    if (args.includes('exec')) {
      if (args.includes('--input-type=module')) return { status: 0, stdout: `${JSON.stringify({ version, uid: 10000, gid: 10000 })}\n`, stderr: '' };
      return { status: 0, stdout: envText, stderr: '' };
    }
    if (args.includes('ps')) return { status: 0, stdout: running ? '0123456789abcdef\n' : '', stderr: '' };
    if (args[0] === 'inspect') return { status: 0, stdout: JSON.stringify([{ Mounts: [
      { Type: 'volume', Source: path.join(volume, 'anonymous'), Destination: '/opt/data' },
      { Type: 'volume', Source: path.join(volume, '_data'), Destination: '/opt/data/full-candidate' },
    ] }]), stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
}

testCase('versions are compared the way Godspeed numbers them, and a command answer counts only when it is a version');
assert.ok(compareVersions('2.0.0-beta.23', '2.0.0-beta.24') < 0);
assert.ok(compareVersions('2.0.0-beta.29', '2.0.0-beta.24') > 0);
assert.ok(compareVersions('2.0.0', '2.0.0-beta.99') > 0);
assert.ok(compareVersions('2.0.0-rc.1', '2.0.0-beta.99') > 0);
assert.equal(compareVersions('2.0.0-beta.24', '2.0.0-beta.24'), 0);
assert.equal(compareVersions('', '2.0.0'), null);
assert.equal(versionFromCommand('godspeed 2.0.0-beta.29\n'), '2.0.0-beta.29');
assert.equal(versionFromCommand('2.1.0'), '2.1.0');
assert.equal(versionFromCommand('Usage: godspeed <deploy|serve> [options]'), null);
assert.equal(versionFromCommand(''), null);

testCase('the installer and the bridge require the same Godspeed');
const installer = fs.readFileSync(fileURLToPath(new URL('../install.sh', import.meta.url)), 'utf8');
assert.equal(/MINIMUM_GODSPEED="([^"]+)"/.exec(installer)[1], MINIMUM_GODSPEED);

testCase('the host side of the container mount that holds the workspace is the longest one');
assert.equal(hostPathOf([{ Source: '/v/anon', Destination: '/opt/data' }, { Source: '/v/data', Destination: '/opt/data/full-candidate' }], '/opt/data/full-candidate/workspace'), path.join('/v/data', 'workspace'));
assert.equal(hostPathOf([{ Source: '/v/x', Destination: '/opt/database' }], '/opt/data/workspace'), null);

testCase('Godspeed in Docker is found with its version, its workspace on this server and the hermes user as owner');
{
  const opt = fresh(), volume = fresh(), calls = [];
  const dir = dockerFolder(opt);
  const found = await findGodspeed({ run: dockerRun({ volume }, calls), env: {}, fetch: noFetch, home: fresh(), roots: { opt, home: fresh() } });
  assert.equal(found.kind, 'docker');
  assert.equal(found.version, '2.0.0-beta.29');
  assert.equal(found.workspace, path.join(volume, '_data', 'workspace'));
  assert.deepEqual(found.owner, { uid: 10000, gid: 10000 });
  assert.equal(found.docker.root, dir);
  assert.equal(found.docker.container, '0123456789abcdef');
  assert.equal(found.docker.workspace, '/opt/data/full-candidate/workspace');
  assert.ok(calls.some(c => c.includes('exec -T --user hermes godspeed node --input-type=module -e') && c.includes('127.0.0.1:47831/health')), calls.join('\n'));
  assert.equal(godspeedProblem(found), null);
}

testCase('Godspeed in Docker that is not running stops the install in one plain sentence');
{
  const opt = fresh();
  dockerFolder(opt);
  const found = await findGodspeed({ run: dockerRun({ running: false, volume: fresh() }), env: {}, fetch: noFetch, home: fresh(), roots: { opt, home: fresh() } });
  assert.equal(godspeedProblem(found), 'Godspeed is installed on this server but is not running, so the Forge could not check its version and installed nothing. Start Godspeed again (running its own install line does that), then run this line again.');
}

testCase('a native Godspeed is found through the device file, and its version comes from its health answer first');
{
  const home = fresh(), workspace = path.join(fresh(), 'my-godspeed'), calls = [];
  fs.mkdirSync(path.join(workspace, '.godspeed'), { recursive: true });
  fs.mkdirSync(path.join(home, '.godspeed'), { recursive: true });
  fs.writeFileSync(path.join(home, '.godspeed', 'device.env'), `GODSPEED_DIR="${workspace}"\n`);
  const run = async (command, args) => { calls.push(command); return command === 'docker' ? none() : { status: 0, stdout: 'godspeed 2.0.0-beta.25\n', stderr: '' }; };
  const found = await findGodspeed({ run, env: {}, fetch: health('2.0.0-beta.29'), home, roots: { opt: fresh(), home: fresh() } });
  assert.equal(found.kind, 'native');
  assert.equal(found.workspace, workspace);
  assert.equal(found.version, '2.0.0-beta.29');
  assert.ok(!calls.includes('godspeed'), 'the command is not asked when the health answer came');
  assert.ok(Number.isInteger(found.owner.uid) && Number.isInteger(found.owner.gid));
}

testCase('another program named godspeed does not count as Godspeed: the health answer wins, and its own words are no version');
{
  const workspace = fresh();
  fs.mkdirSync(path.join(workspace, '.godspeed'));
  const shadow = async command => (command === 'docker' ? none() : { status: 0, stdout: 'godspeed: deploy static sites fast\nUsage: godspeed <command>\n', stderr: '' });
  const withHealth = await findGodspeed({ run: shadow, env: { GODSPEED_DIR: workspace }, fetch: health('2.0.0-beta.29'), home: fresh(), roots: { opt: fresh(), home: fresh() } });
  assert.equal(withHealth.version, '2.0.0-beta.29');
  const without = await findGodspeed({ run: shadow, env: { GODSPEED_DIR: workspace }, fetch: noFetch, home: fresh(), roots: { opt: fresh(), home: fresh() } });
  assert.equal(without.version, null);
  assert.equal(godspeedProblem(without), 'Godspeed was found on this server, but it did not say which version it is, so nothing was installed. Make sure Godspeed is running, then run this line again.');
  const product = async command => (command === 'docker' ? none() : { status: 0, stdout: 'godspeed 2.0.0-beta.26\n', stderr: '' });
  assert.equal((await findGodspeed({ run: product, env: { GODSPEED_DIR: workspace }, fetch: noFetch, home: fresh(), roots: { opt: fresh(), home: fresh() } })).version, '2.0.0-beta.26');
}

testCase('a Godspeed that belongs to another account is asked through that account\'s own command');
{
  const home = fresh(), account = path.join(fresh(), 'ai'), workspace = path.join(account, 'godspeed'), asked = [];
  fs.mkdirSync(path.join(workspace, '.godspeed'), { recursive: true });
  const own = path.join(account, '.local', 'bin', 'godspeed');
  const run = async command => { asked.push(command); return command === own ? { status: 0, stdout: 'godspeed 2.0.0-beta.27\n', stderr: '' } : none(); };
  const found = await findGodspeed({ run, env: { GODSPEED_DIR: workspace }, fetch: noFetch, home, roots: { opt: fresh(), home: fresh() } });
  assert.equal(found.version, '2.0.0-beta.27');
  assert.deepEqual(asked.filter(c => c !== 'docker'), ['godspeed', path.join(home, '.local', 'bin', 'godspeed'), own]);
}

testCase('a Godspeed older than the Forge needs is named with its version, and none at all is said plainly');
{
  const workspace = fresh();
  fs.mkdirSync(path.join(workspace, '.godspeed'));
  const old = await findGodspeed({ run: none, env: { GODSPEED_DIR: workspace }, fetch: health('2.0.0-beta.23'), home: fresh(), roots: { opt: fresh(), home: fresh() } });
  assert.equal(godspeedProblem(old), 'Godspeed 2.0.0-beta.23 is installed; the Forge requires Godspeed 2.0.0-beta.24 or newer. Update Godspeed, then run this line again.');
  const nothing = await findGodspeed({ run: none, env: {}, fetch: noFetch, home: fresh(), roots: { opt: fresh(), home: fresh() } });
  assert.equal(nothing, null);
  assert.equal(godspeedProblem(nothing), 'The Forge needs Godspeed Mission Control on this server, and none was found. Install Godspeed first, then run this line again.');
  assert.equal(STOP.none, godspeedProblem(null));
  await assert.rejects(openGodspeed({ run: none, env: {}, fetch: noFetch, home: fresh(), roots: { opt: fresh(), home: fresh() } }), e => e instanceof GodspeedStop && e.message === STOP.none);
}

testCase('a Godspeed that answers but whose folder cannot be found asks for the folder');
{
  const found = await findGodspeed({ run: none, env: {}, fetch: health('2.0.0-beta.29'), home: fresh(), roots: { opt: fresh(), home: fresh() } });
  assert.equal(godspeedProblem(found), 'Godspeed runs on this server, but the Forge could not find its folder, so nothing was installed. Run this line again with GODSPEED_WORKSPACE set to that folder.');
}

testCase('GODSPEED_WORKSPACE and GODSPEED_VERSION name the Godspeed outright');
{
  const workspace = fresh();
  const found = await findGodspeed({ run: async () => { throw new Error('nothing is run'); }, env: { GODSPEED_WORKSPACE: workspace, GODSPEED_VERSION: '2.0.0-beta.24' }, fetch: noFetch });
  assert.deepEqual([found.kind, found.version, found.workspace], ['native', '2.0.0-beta.24', path.resolve(workspace)]);
}

// A bridge over a workspace whose owner is someone else, run as root: every chown is recorded instead of done.
function rootBridge(workspace, extra = {}) {
  const chowns = [];
  const recordingFs = { ...fs, chownSync: (p, uid, gid) => chowns.push([p, uid, gid]), ...(extra.fs || {}) };
  const gs = createBridge({ kind: extra.kind || 'native', version: '2.0.0-beta.29', workspace, owner: { uid: 10000, gid: 10000 }, ...(extra.docker ? { docker: extra.docker } : {}) },
    { fs: recordingFs, uid: 0, stateDir: extra.stateDir || fresh(), env: extra.env || {}, fetch: extra.fetch, run: extra.run, home: extra.home || fresh(), now: () => Date.parse('2026-11-22T12:00:00Z') });
  return { gs, chowns };
}

testCase('a file written into the workspace is written whole and handed to the workspace owner, folders too');
{
  const workspace = fresh();
  const { gs, chowns } = rootBridge(workspace);
  const file = gs.writeWorkspaceFile('.godspeed/forge/outbox/a.json', '{"ok":true}\n');
  assert.equal(file, path.join(workspace, '.godspeed', 'forge', 'outbox', 'a.json'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}\n');
  const owned = chowns.map(([p]) => path.relative(workspace, p).split(path.sep).join('/'));
  assert.deepEqual(owned.slice(0, 3), ['.godspeed', '.godspeed/forge', '.godspeed/forge/outbox']);
  assert.match(owned[3], /^\.godspeed\/forge\/outbox\/a\.json\.\d+\.[0-9a-f]+\.tmp$/, 'the temporary is the owner\'s before it becomes the file');
  assert.ok(chowns.every(([, uid, gid]) => uid === 10000 && gid === 10000));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['a.json']);
  assert.equal(gs.readWorkspaceFile('.godspeed/forge/outbox/a.json'), '{"ok":true}\n');
  assert.equal(gs.readWorkspaceFile('.godspeed/forge/outbox/missing.json'), null);
}

testCase('a write that fails leaves the old file as it was and no temporary behind');
{
  const workspace = fresh();
  const { gs } = rootBridge(workspace, { fs: { renameSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } });
  fs.mkdirSync(path.join(workspace, 'x'));
  fs.writeFileSync(path.join(workspace, 'x', 'f.json'), 'old\n');
  assert.throws(() => gs.writeWorkspaceFile('x/f.json', 'new\n'), /disk full/);
  assert.equal(fs.readFileSync(path.join(workspace, 'x', 'f.json'), 'utf8'), 'old\n');
  assert.deepEqual(fs.readdirSync(path.join(workspace, 'x')), ['f.json']);
}

testCase('nothing outside the workspace can be named, and nothing is handed away when not running as root');
{
  const workspace = fresh();
  const { gs } = rootBridge(workspace);
  for (const bad of ['../outside', '/etc/passwd', 'a/../../b', '', 'C:/x']) assert.throws(() => gs.writeWorkspaceFile(bad, 'x'), /not a path inside/);
  const chowns = [];
  const plain = createBridge({ kind: 'native', version: '2.0.0-beta.29', workspace, owner: { uid: 10000, gid: 10000 } }, { fs: { ...fs, chownSync: (...a) => chowns.push(a) }, uid: 1000, stateDir: fresh() });
  plain.writeWorkspaceFile('y/z.txt', 'z');
  assert.deepEqual(chowns, []);
}

testCase('a skill folder is installed into the workspace skills, without hidden files');
{
  const workspace = fresh(), source = fresh();
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: forge\n---\n');
  fs.mkdirSync(path.join(source, 'parts'));
  fs.writeFileSync(path.join(source, 'parts', 'more.md'), 'more');
  fs.writeFileSync(path.join(source, '.hidden'), 'no');
  const { gs, chowns } = rootBridge(workspace);
  gs.installSkill('forge', source);
  assert.equal(fs.readFileSync(path.join(workspace, 'skills', 'forge', 'SKILL.md'), 'utf8'), '---\nname: forge\n---\n');
  assert.equal(fs.readFileSync(path.join(workspace, 'skills', 'forge', 'parts', 'more.md'), 'utf8'), 'more');
  assert.ok(!fs.existsSync(path.join(workspace, 'skills', 'forge', '.hidden')));
  assert.ok(chowns.length >= 4);
  assert.throws(() => gs.installSkill('../evil', source), /not a skill name/);
}

// The owner's assistant, natively: its .env named by the workspace's assistant.json.
function nativeAssistant(workspace, envText) {
  const home = path.join(workspace, '.godspeed', 'hermes');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.godspeed', 'assistant.json'), JSON.stringify({ verified: true, home }));
  fs.writeFileSync(path.join(home, '.env'), envText);
}
// A stand-in Telegram: each answer is a reply object, an Error the request fails with, { raw } for an answer that is not
// JSON, or { cutOff } for an answer whose body breaks off while it is read.
const telegram = (answers, calls) => async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) });
  const next = answers.shift();
  if (next instanceof Error) throw next;
  if (next && next.cutOff) return { status: 200, text: async () => { throw next.cutOff; } };
  if (next && 'raw' in next) return { status: 502, text: async () => next.raw };
  return { status: 200, text: async () => JSON.stringify(next) };
};
const failure = (code, message = 'fetch failed') => Object.assign(new TypeError(message), { cause: Object.assign(new Error(code), { code }) });
const record = (stateDir, id) => JSON.parse(fs.readFileSync(path.join(stateDir, 'godspeed', 'sent.json'), 'utf8'))[id];

testCase('a message to the owner goes through their assistant\'s Telegram bot once per id');
{
  const workspace = fresh(), stateDir = fresh(), calls = [];
  nativeAssistant(workspace, 'TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_ALLOWED_USERS=4242\n');
  const { gs } = rootBridge(workspace, { stateDir, fetch: telegram([{ ok: true, result: {} }], calls) });
  assert.deepEqual(await gs.sendToOwner('Version 1.5.0 is ready to try.', { id: 'staged-1.5.0' }), { sent: true, how: 'telegram' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.deepEqual([calls[0].body.chat_id, calls[0].body.text], ['4242', 'Version 1.5.0 is ready to try.']);
  assert.deepEqual(await gs.sendToOwner('Version 1.5.0 is ready to try.', { id: 'staged-1.5.0' }), { sent: false, how: 'telegram', already: true });
  assert.equal(calls.length, 1, 'the same id is never sent twice');
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'godspeed', 'sent.json'), 'utf8'))['staged-1.5.0'].how, 'telegram');
  assert.ok(!fs.existsSync(gs.noticesFile()));
}

testCase('in Docker the bot\'s token and chat are read inside the container');
{
  const workspace = fresh(), calls = [], runs = [];
  const docker = { root: '/srv/gm', compose: '/srv/gm/compose.yaml', service: 'godspeed', workspace: '/opt/data/full-candidate/workspace', container: 'abc' };
  const run = async (command, args) => { runs.push([command, ...args].join(' ')); return { status: 0, stdout: 'TELEGRAM_BOT_TOKEN=9:z\nTELEGRAM_HOME_CHANNEL=-100\n', stderr: '' }; };
  const { gs } = rootBridge(workspace, { kind: 'docker', docker, run, fetch: telegram([{ ok: true }], calls) });
  assert.deepEqual(await gs.sendToOwner('Hello.', { id: 'd1' }), { sent: true, how: 'telegram' });
  assert.ok(runs[0].startsWith('docker compose -f /srv/gm/compose.yaml --project-directory /srv/gm exec -T --user hermes godspeed node -e '));
  assert.ok(runs[0].endsWith(' /opt/data/full-candidate/workspace'));
  assert.equal(calls[0].body.chat_id, '-100');
}

testCase('when Telegram refuses, the message becomes a Godspeed notice in Godspeed\'s own format, once');
{
  const workspace = fresh(), calls = [];
  nativeAssistant(workspace, 'TELEGRAM_BOT_TOKEN=1:a\nTELEGRAM_CHAT_ID=7\n');
  const { gs, chowns } = rootBridge(workspace, { fetch: telegram([{ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }], calls) });
  assert.deepEqual(await gs.sendToOwner('A question waits for you.', { id: 'q-F7' }), { sent: true, how: 'notice' });
  const notices = JSON.parse(fs.readFileSync(path.join(workspace, '.godspeed', 'notices.json'), 'utf8')).notices;
  assert.deepEqual(notices, [{ id: 'forge-q-F7', text: 'A question waits for you.', at: '2026-11-22T12:00:00.000Z', about: 'A message from the Forge', facts: ['A question waits for you.'], written: true }]);
  assert.ok(chowns.some(([p]) => p.includes('notices.json')), 'the notice queue stays the owner\'s');
  assert.deepEqual(await gs.sendToOwner('A question waits for you.', { id: 'q-F7' }), { sent: false, how: 'notice', already: true });
  assert.equal(JSON.parse(fs.readFileSync(gs.noticesFile(), 'utf8')).notices.length, 1);
  assert.ok(!fs.existsSync(`${gs.noticesFile()}.lock`), 'the lock folder is gone again');
}

testCase('with no bot the notice is added to the queue Godspeed already has, which keeps its newest 50');
{
  const workspace = fresh();
  fs.mkdirSync(path.join(workspace, '.godspeed'));
  const old = Array.from({ length: 50 }, (_, i) => ({ id: `old-${i}`, text: `t${i}`, at: '2026-11-01T00:00:00Z', facts: [`t${i}`] }));
  fs.writeFileSync(path.join(workspace, '.godspeed', 'notices.json'), JSON.stringify({ notices: old }));
  const { gs } = rootBridge(workspace, { fetch: async () => { throw new Error('Telegram is not asked without a bot'); } });
  assert.deepEqual(await gs.sendToOwner('Started.', { id: 'plan-1' }), { sent: true, how: 'notice' });
  const notices = JSON.parse(fs.readFileSync(gs.noticesFile(), 'utf8')).notices;
  assert.equal(notices.length, 50);
  assert.equal(notices[0].id, 'old-1');
  assert.equal(notices.at(-1).id, 'forge-plan-1');
}

testCase('a notice queue that cannot be read is left alone, and the notice is queued once on a later call, without asking Telegram');
{
  const workspace = fresh(), stateDir = fresh();
  fs.mkdirSync(path.join(workspace, '.godspeed'));
  fs.writeFileSync(path.join(workspace, '.godspeed', 'notices.json'), '{"notices": 3}');
  const { gs } = rootBridge(workspace, { stateDir, fetch: noFetch });
  await assert.rejects(gs.sendToOwner('Started.', { id: 'plan-2' }), /cannot be read/);
  assert.equal(fs.readFileSync(gs.noticesFile(), 'utf8'), '{"notices": 3}');
  assert.deepEqual([record(stateDir, 'plan-2').how, record(stateDir, 'plan-2').state], ['notice', 'queueing']);
  fs.writeFileSync(gs.noticesFile(), '{"notices": []}');
  nativeAssistant(workspace, 'TELEGRAM_BOT_TOKEN=1:a\nTELEGRAM_CHAT_ID=7\n');
  const later = rootBridge(workspace, { stateDir, fetch: async () => { throw new Error('Telegram is not asked for a message that is a notice already'); } });
  assert.deepEqual(await later.gs.sendToOwner('Started.', { id: 'plan-2' }), { sent: true, how: 'notice' });
  assert.deepEqual(JSON.parse(fs.readFileSync(gs.noticesFile(), 'utf8')).notices.map(n => n.id), ['forge-plan-2']);
  assert.equal(record(stateDir, 'plan-2').state, 'sent');
  assert.deepEqual(await later.gs.sendToOwner('Started.', { id: 'plan-2' }), { sent: false, how: 'notice', already: true });
}

testCase('every outcome after the request may have left counts as sent: a cut-off answer, a reset, an answer that is not JSON, a server error');
for (const [what, answer] of [
  ['cut off', { cutOff: new TypeError('terminated') }],
  ['reset after sending', failure('ECONNRESET')],
  ['socket closed', failure('UND_ERR_SOCKET', 'other side closed')],
  ['not JSON', { raw: '<html><body>502 Bad Gateway</body></html>' }],
  ['a server error', { ok: false, error_code: 502, description: 'Bad Gateway' }],
]) {
  const workspace = fresh(), stateDir = fresh(), calls = [];
  nativeAssistant(workspace, 'TELEGRAM_BOT_TOKEN=1:a\nTELEGRAM_CHAT_ID=7\n');
  const { gs } = rootBridge(workspace, { stateDir, fetch: telegram([answer, { ok: true }], calls) });
  assert.deepEqual(await gs.sendToOwner('Hello.', { id: 'u1' }), { sent: true, how: 'telegram' }, what);
  assert.ok(!fs.existsSync(gs.noticesFile()), `${what}: no notice on top of what may have reached the owner`);
  assert.deepEqual([record(stateDir, 'u1').how, record(stateDir, 'u1').state], ['telegram', 'unsure'], what);
  assert.deepEqual(await gs.sendToOwner('Hello.', { id: 'u1' }), { sent: false, how: 'telegram', already: true }, what);
  assert.equal(calls.length, 1, `${what}: never asked again`);
}

testCase('only a request that never left becomes a notice: the name not found, the connection refused');
for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']) {
  const workspace = fresh(), stateDir = fresh(), calls = [];
  nativeAssistant(workspace, 'TELEGRAM_BOT_TOKEN=1:a\nTELEGRAM_CHAT_ID=7\n');
  const { gs } = rootBridge(workspace, { stateDir, fetch: telegram([failure(code)], calls) });
  assert.deepEqual(await gs.sendToOwner('Hello.', { id: 'n1' }), { sent: true, how: 'notice' }, code);
  assert.deepEqual(JSON.parse(fs.readFileSync(gs.noticesFile(), 'utf8')).notices.map(n => n.id), ['forge-n1'], code);
}

testCase('the id is recorded as being sent before the request leaves, so a stop between sending and recording never sends it again');
{
  const workspace = fresh(), stateDir = fresh(), calls = [];
  nativeAssistant(workspace, 'TELEGRAM_BOT_TOKEN=1:a\nTELEGRAM_CHAT_ID=7\n');
  const seenBefore = [];
  const delivering = async url => {
    seenBefore.push(record(stateDir, 'c1'));
    calls.push(url);
    return { status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  let saves = 0;
  const stopping = { renameSync: (from, to) => { if (to.endsWith('sent.json') && ++saves === 2) throw new Error('the server stopped'); return fs.renameSync(from, to); } };
  const { gs } = rootBridge(workspace, { stateDir, fetch: delivering, fs: stopping });
  await assert.rejects(gs.sendToOwner('Version 2.0.0 is public.', { id: 'c1' }), /the server stopped/);
  assert.deepEqual([seenBefore[0].how, seenBefore[0].state], ['telegram', 'sending'], 'written before the request left');
  const again = rootBridge(workspace, { stateDir, fetch: delivering });
  assert.deepEqual(await again.gs.sendToOwner('Version 2.0.0 is public.', { id: 'c1' }), { sent: false, how: 'telegram', already: true });
  assert.equal(calls.length, 1, 'Telegram was asked once');
  assert.ok(!fs.existsSync(gs.noticesFile()), 'and no notice repeats it');
}

testCase('no answer from Telegram in time counts as sent, so the owner never gets it twice');
{
  const workspace = fresh(), calls = [];
  nativeAssistant(workspace, 'TELEGRAM_BOT_TOKEN=1:a\nTELEGRAM_CHAT_ID=7\n');
  const { gs } = rootBridge(workspace, { fetch: telegram([Object.assign(new Error('timed out'), { name: 'TimeoutError' })], calls) });
  assert.deepEqual(await gs.sendToOwner('Hello.', { id: 't1' }), { sent: true, how: 'telegram' });
  assert.ok(!fs.existsSync(gs.noticesFile()));
}

testCase('a stand-in Telegram address is honoured only in test mode, and a message needs an id and words');
{
  const workspace = fresh(), calls = [];
  nativeAssistant(workspace, 'TELEGRAM_BOT_TOKEN=1:a\nTELEGRAM_CHAT_ID=7\n');
  const { gs } = rootBridge(workspace, { env: { FORGE_TELEGRAM_API: 'http://127.0.0.1:9' }, fetch: telegram([{ ok: true }], calls) });
  assert.deepEqual(await gs.sendToOwner('Hello.', { id: 'x1' }), { sent: true, how: 'notice' });
  assert.equal(calls.length, 0);
  const test = rootBridge(workspace, { env: { FORGE_TELEGRAM_API: 'http://127.0.0.1:9/', FORGE_TEST: '1' }, fetch: telegram([{ ok: true }], calls) });
  assert.deepEqual(await test.gs.sendToOwner('Hello.', { id: 'x2' }), { sent: true, how: 'telegram' });
  assert.equal(calls[0].url, 'http://127.0.0.1:9/bot1:a/sendMessage');
  await assert.rejects(gs.sendToOwner('Hello.', {}), /needs an id/);
  await assert.rejects(gs.sendToOwner('  ', { id: 'x3' }), /needs its words/);
}

await rm(root, { recursive: true, force: true });
