// Setup from the chat (lib/owner/setup.mjs, lib/chat-setup.mjs): the owner's `setup` requests against a worker that runs the
// real setup with stand-in commands and GitHub, in this process. No network, no AI.
// test cases: 10
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { testCase } from './cases.mjs';
import { tmpDir } from './forge-owner-fakes.mjs';
import { setup } from '../lib/owner/setup.mjs';
import { createChatSetup, openSession, chatSetupFiles, CHAT_SETUP_MESSAGES, draftMission } from '../lib/chat-setup.mjs';
import { setupCommand, DRAFT_MESSAGES } from '../lib/setup.mjs';
import { defaults, credentialPath } from '../lib/config.mjs';
import { FACTORY_REVISION } from '../lib/constants.mjs';
import { STRIKE_QUESTION, CONFIRM_QUESTION, struckNumbers } from '../lib/factory-setup.mjs';

const REPO = 'owner/repo';
const CODE = 'GITHUB-CODE-SENTINEL';
const KEY = 'PRIVATE KEY SENTINEL';
// Ports come from this process's id and stay below the range the system hands out to connections, so test runs in parallel never share one.
let nextPort = 20000 + (process.pid % 120) * 100;
const timing = { pollMs: 10, maxMs: 15000, quietMs: 3000 };

// One server: a state folder with the watch page's record, a projects folder, and the commands setup runs.
function world({ claude = true, factory = null, appStatus = async () => 'installed', appWaitMs = 5000, startWorker: replaceWorker = null } = {}) {
  const PORT = nextPort++;
  const root = tmpDir('forge-chat-setup-');
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'watch.json'), JSON.stringify({ format: 1, host: 'forge.test', port: 48445, upstream: 3190, callbackPort: PORT, user: 'forge', password: 'WATCH-PASSWORD-SENTINEL', hash: 'x', revision: 'r' }));
  const projectsRoot = path.join(root, 'projects');
  const S = { claudeSignedIn: claude, pushed: 0, workspaceMarker: null };
  const run = async (command, args, options = {}) => {
    if (command === 'claude') { if (!S.claudeSignedIn) throw Object.assign(new Error('signed out'), { stderr: 'not logged in' }); return { stdout: 'signed in' }; }
    if (command === 'codex') throw Object.assign(new Error('signed out'), { stderr: 'not logged in' });
    if (command === 'gh' && args[0] === 'api' && args[1] === '-i') return { stdout: 'HTTP/2 200\nx-oauth-scopes: repo, workflow\n' };
    if (command === 'gh' && args[0] === 'api') return { stdout: 'User\n' };
    if (command === 'gh' && args[0] === 'repo') return { stdout: 'A booking page for bakers\n' };
    if (command === 'gh') return { stdout: '' };
    if (command === 'git' && args[0] === 'clone') { fs.mkdirSync(path.join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
    if (command === 'git' && args[0] === 'remote') return { stdout: `https://github.com/${REPO}.git\n` };
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
    if (command === 'python3' && args[1] === 'init') {
      fs.mkdirSync(path.join(options.cwd, 'factory'), { recursive: true });
      fs.writeFileSync(path.join(options.cwd, 'MISSION.md'), '# Mission\n');
      fs.writeFileSync(path.join(options.cwd, 'factory/consumer.py'), '#\n');
      fs.writeFileSync(path.join(options.cwd, 'README.md'), '# App\n\nBooks bakers.\n\n## Who uses it\n\nFreelance bakers and their customers.\n');
      fs.mkdirSync(path.join(options.cwd, '.factory'), { recursive: true });
      fs.writeFileSync(path.join(options.cwd, '.factory/consumer.json'), JSON.stringify({ source: path.join(root, 'cache') }));
    }
    return { stdout: '' };
  };
  const base = {
    exists: async file => { try { fs.accessSync(file); return true; } catch { return false; } },
    exchange: async code => { S.exchanged = [...(S.exchanged ?? []), code]; return { id: 7, slug: `forge-${S.exchanged.length}`, pem: KEY, client_secret: 'CS', webhook_secret: 'WS' }; },
    appExists: async () => false,
    appStatus: (...args) => appStatus(...args)
  };
  const files = chatSetupFiles({ state }, REPO);
  const workers = [];
  const S2 = {};
  // The worker, in this process; its session is what the handler talks to.
  const startWorker = async repository => {
    const session = openSession({ state }, repository, { pollMs: 10, answerWithinMs: 60000 });
    const { options, close } = createChatSetup({ repository, paths: { state }, session, deps: { run, start: () => { throw new Error('no sign-in expected'); }, probe: async () => true, github: { base, sleepMs: 5, appWaitMs } } });
    const interrupted = new Promise(resolve => { S2.interrupt = resolve; });
    workers.push((async () => {
      await setupCommand(repository, { ...options, ...(factory && { factorySetup: context => factory(context, options.prompt, S) }), interrupted, config: { ...defaults(root), projectsRoot } });
      await close();
      if (session.state.status !== 'done') session.finish('stopped');
    })());
  };
  const bridge = { workspacePath: rel => path.join(root, 'workspace', rel), writeWorkspaceFile: (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, 'workspace', rel)), { recursive: true }); fs.writeFileSync(path.join(root, 'workspace', rel), text); } };
  const ctx = { paths: { state }, gs: bridge, startWorker: replaceWorker ?? startWorker, timing };
  const say = async (words, project = REPO) => (await setup({ kind: 'setup', project, words }, ctx)).say;
  const marker = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'workspace', '.godspeed/forge/setup.json'), 'utf8')); } catch { return null; } };
  return { interrupt: signal => S2.interrupt(signal), port: PORT, root, state, S, say, files, workers, marker, projectsRoot, ctx };
}

// The owner's browser: the page the link opens (through the watch page, here straight to the listener) and GitHub's redirect.
const local = (link, w) => `http://127.0.0.1:${w.port}${new URL(link).pathname}`;
const linkIn = (text, pattern) => text.match(pattern)[0];
async function createApp(w, text, kind) {
  const pattern = new RegExp(`https://forge\\.test:48445/forge-setup/[0-9a-f]{32}/create`);
  // A slow machine can cut a reply before the link is said: wait for the link itself, not for a quiet moment.
  for (let tries = 0; !pattern.test(text) && tries < 20; tries++) text += '\n' + await w.say('');
  const link = linkIn(text, pattern);
  const page = await (await fetch(local(link, w))).text();
  assert.match(page, /method="post" action="https:\/\/github\.com\/settings\/apps\/new"/);
  const redirect = page.match(/redirect_url&quot;:&quot;([^&]+)&quot;/)[1];
  assert.match(redirect, /^https:\/\/forge\.test:48445\/forge-setup\/[0-9a-f]{32}\/done$/);
  assert.match(page, new RegExp(`Forge ${kind}`));
  assert.equal((await fetch(`${local(redirect, w)}?code=${CODE}-${kind}`)).status, 200);
}
const allText = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8')).join('\n');

// Turns until the drafted mission is shown: the Apps' links, the browser steps between them.
async function toDraft(w) {
  const first = await w.say('set up the Forge for owner/repo');
  await createApp(w, first, 'builder');
  const second = await w.say('');
  await createApp(w, second, 'release');
  return { first, second, third: await w.say('') };
}
const missionFile = w => path.join(w.state, 'projects', REPO, 'mission.json');
const registered = w => fs.existsSync(path.join(w.state, 'projects', REPO, 'registration.json'));

testCase('one chat conversation sets a project up: links, the drafted mission shown before anything is saved, and the finish');
{
  const w = world();
  const { first, second, third } = await toDraft(w);
  assert.match(first, /Using Claude Code to set up the Forge\./);
  assert.match(first, /Create the builder App in your browser: https:\/\/forge\.test:48445\/forge-setup\/[0-9a-f]{32}\/create/);
  assert.ok(!/godspeed-forge setup/.test(first), 'no terminal line');
  assert.deepEqual(w.marker(), { repository: REPO, awaiting: true });
  assert.match(second, /Install the builder App and choose only owner\/repo: https:\/\/github\.com\/apps\/forge-1\/installations\/new/);
  assert.match(third, /Install the release App and choose only owner\/repo/);
  assert.ok(third.endsWith(`Here is what I read from the project.\nWhat it is for: A booking page for bakers\nWho uses it: Freelance bakers and their customers.\n\n${DRAFT_MESSAGES.question}`));
  assert.ok(!fs.existsSync(missionFile(w)), 'nothing is saved before the yes');
  assert.ok(!fs.readFileSync(path.join(w.projectsRoot, REPO, 'MISSION.md'), 'utf8').includes('booking page'));
  assert.deepEqual(w.S.exchanged, [`${CODE}-builder`, `${CODE}-release`]);

  const last = await w.say('yes');
  assert.deepEqual(JSON.parse(fs.readFileSync(missionFile(w), 'utf8')), { purpose: 'A booking page for bakers', users: 'Freelance bakers and their customers.' });
  assert.match(fs.readFileSync(path.join(w.projectsRoot, REPO, 'MISSION.md'), 'utf8'), /What this software is for: A booking page for bakers/);
  assert.match(last, /Setup is complete for owner\/repo\./);
  assert.match(last, /You can watch the factory at https:\/\/forge\.test:48445\./);
  assert.ok(registered(w));
  assert.equal(w.marker(), null, 'the marker goes when setup ends');
  await Promise.all(w.workers);

  // Nothing secret reaches what the chat is told or the session files: no App code, key or password.
  const chat = allText(path.join(w.state, 'chat-setup')) + [first, second, third, last].join('\n');
  for (const secret of [CODE, KEY, 'WATCH-PASSWORD-SENTINEL', 'CS', 'WS']) assert.ok(!chat.includes(secret) || secret.length < 3, secret);
  assert.deepEqual(fs.readdirSync(path.join(w.state, 'chat-setup')).sort(), ['owner--repo.json', 'owner--repo.reply.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(w.files.session).mode & 0o777, 0o600);
}

testCase('a no to the draft asks the two questions, and the owner\'s own answers are what is saved');
{
  const w = world();
  await toDraft(w);
  assert.equal(await w.say('no'), 'What is this software for?');
  assert.ok(!fs.existsSync(missionFile(w)));
  assert.equal(await w.say('Orders for a small bakery'), 'Who uses it?');
  const last = await w.say('The bakery staff');
  assert.deepEqual(JSON.parse(fs.readFileSync(missionFile(w), 'utf8')), { purpose: 'Orders for a small bakery', users: 'The bakery staff' });
  assert.match(last, /Setup is complete/);
  await Promise.all(w.workers);
}

testCase('a Claude owner who is not signed in is told the one terminal step, a pasted code is refused unstored, and continue goes on once signed in');
{
  const w = world({ claude: false });
  const asked = await w.say('set up the Forge for owner/repo');
  assert.match(asked, /Which coding assistant do you use/);
  const step = await w.say('claude');
  assert.equal(step, CHAT_SETUP_MESSAGES.claudeStep);
  assert.equal(await w.say('Y8q-PASTED-CODE-SENTINEL'), CHAT_SETUP_MESSAGES.claudeCode);
  assert.ok(!allText(path.join(w.state, 'chat-setup')).includes('PASTED-CODE-SENTINEL'), 'the code is stored nowhere');
  w.S.claudeSignedIn = false;
  const again = await w.say('continue');
  assert.equal(again, CHAT_SETUP_MESSAGES.claudeStep, 'still signed out: the same step again');
  w.S.claudeSignedIn = true;
  const next = await w.say('continue');
  assert.match(next, /Using Claude Code to set up the Forge\./);
  assert.match(next, /Create the builder App in your browser/);
}

testCase('without the watch page\'s way back setup stops in one sentence and says what to do');
{
  const w = world();
  fs.rmSync(path.join(w.state, 'watch.json'));
  assert.equal(await w.say('set up the Forge for owner/repo'), CHAT_SETUP_MESSAGES.needsPage);
  await Promise.all(w.workers);
  assert.equal(JSON.parse(fs.readFileSync(w.files.session, 'utf8')).status, 'stopped');
  assert.ok(!registered(w));
}

testCase('a setup whose worker was interrupted starts again on the next request and picks up from what was saved');
{
  const w = world();
  const first = await w.say('set up the Forge for owner/repo');
  assert.match(first, /Create the builder App/);
  const before = w.workers.length;
  w.interrupt('SIGTERM');
  assert.match(await w.say('how is setup going'), /^Setup stopped because this server told it to stop before it finished connecting the builder App;/);
  assert.equal(w.workers.length, before, 'what was left to say is said before anything starts again');
  const resumed = await w.say('set up the Forge for owner/repo');
  assert.equal(w.workers.length, before + 1, 'a new worker started');
  assert.match(resumed, /Create the builder App in your browser/);
  assert.ok(!registered(w), 'nothing was pushed or registered');
}

testCase('a request for another project while one setup is open is refused, and a name that is not a project gets a question');
{
  const w = world();
  await w.say('set up the Forge for owner/repo');
  assert.equal(await w.say('set up the Forge for other/thing', 'other/thing'), 'The Forge is already setting up owner/repo. Finish that one first, or say how it is going.');
  assert.equal(await w.say('set up the Forge', 'not a project'), 'Tell me which GitHub project to set up, as owner/repository.');
}

testCase('the draft is only what the project says: its description, its README, and a Who section when it has one');
{
  const read = text => () => text;
  const run = async () => ({ stdout: '' });
  assert.deepEqual(await draftMission({ repository: REPO, checkout: '/x', run, readme: read('# App\n\nFirst paragraph.\n\nSecond.\n') }), { purpose: 'First paragraph.' });
  assert.deepEqual(await draftMission({ repository: REPO, checkout: '/x', run, readme: () => { throw new Error('none'); } }), {});
  const described = async () => ({ stdout: 'From GitHub\n' });
  assert.deepEqual(await draftMission({ repository: REPO, checkout: '/x', run: described, readme: read('# App\n\nIntro.\n\n## Users\n\nBakers\nand cooks.\n\n## Install\n') }), { purpose: 'From GitHub', users: 'Bakers and cooks.' });
}

testCase('the strike list, the confirmation and the push run in the chat: numbers strike, "keep all" keeps, no sends nothing, yes sends once');
{
  const entries = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  const factory = async ({ output }, prompt, S) => {
    output('Proposed:');
    entries.forEach((entry, index) => output(`${index + 1}. ${entry}`));
    let kept;
    for (;;) {
      const struck = struckNumbers(await prompt(STRIKE_QUESTION));
      if (struck) { kept = entries.filter((_, index) => !struck.has(index + 1)); break; }
    }
    S.kept = kept;
    while (String(await prompt(CONFIRM_QUESTION(REPO))).trim().toLowerCase() !== 'yes') S.declined = (S.declined ?? 0) + 1;
    S.pushed += 1;
  };
  for (const [answer, expected] of [['2 5', ['one', 'three', 'four', 'six', 'seven']], ['keep all', entries]]) {
    const w = world({ factory });
    await toDraft(w);
    const list = await w.say('yes');
    assert.match(list, /1\. one[\s\S]*7\. seven/);
    assert.match(list, /say "keep all"/);
    assert.ok(!/press Enter/.test(list));
    const confirm = await w.say(answer);
    assert.match(confirm, new RegExp(CONFIRM_QUESTION(REPO).slice(0, 20)));
    assert.deepEqual(w.S.kept, expected);
    await w.say('no');
    assert.equal(w.S.pushed, 0, 'no push without a yes');
    const last = await w.say('yes');
    assert.equal(w.S.pushed, 1);
    assert.match(last, /Setup is complete/);
    await Promise.all(w.workers);
  }
}

testCase('an App install check that keeps failing throws what GitHub said, one that recovers goes on, one that never installs says no');
{
  const install = appStatus => {
    const session = { say: () => {} };
    const { options } = createChatSetup({ repository: REPO, paths: { state: tmpDir('forge-chat-install-') }, session, deps: { github: { base: { appStatus }, sleepMs: 5, appWaitMs: 40 } } });
    return options.github.install({ credentials: { slug: 'forge-1' }, repository: REPO, kind: 'builder' });
  };
  await assert.rejects(install(async () => { throw new Error('GitHub is down'); }), /could not say whether the builder App is installed: GitHub is down/);
  let calls = 0;
  assert.equal(await install(async () => { if (calls++ === 0) throw new Error('blip'); return 'installed'; }), true);
  assert.equal(await install(async () => 'missing'), false);
}

testCase('a worker that cannot start, never opens a session, or dies while the owner waits on it is answered with the terminal command');
{
  const terminal = /godspeed-forge setup owner\/repository/;
  const fast = { pollMs: 5, maxMs: 100, quietMs: 20 };
  const throwing = world({ startWorker: async () => { throw new Error('no systemd'); } });
  const a = await setup({ kind: 'setup', project: REPO, words: 'set up' }, throwing.ctx);
  assert.equal(a.ok, false);
  assert.match(a.say, terminal);

  const silent = world({ startWorker: async () => {} });
  const b = await setup({ kind: 'setup', project: REPO, words: 'set up' }, { ...silent.ctx, timing: fast });
  assert.equal(b.ok, false);
  assert.match(b.say, terminal);

  const dying = world({ startWorker: async () => { throw new Error('a running worker is not restarted'); } });
  const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  fs.mkdirSync(dying.files.dir, { recursive: true });
  fs.writeFileSync(dying.files.session, JSON.stringify({ repository: REPO, workerPid: worker.pid, status: 'running', log: ['one'], ask: null }));
  fs.writeFileSync(dying.files.reply, JSON.stringify({ delivered: 1, answer: null }));
  setTimeout(() => worker.kill('SIGKILL'), 30);
  const c = await setup({ kind: 'setup', project: REPO, words: 'how is it going' }, { ...dying.ctx, timing: { pollMs: 5, maxMs: 2000, quietMs: 20 } });
  assert.equal(c.ok, false);
  assert.match(c.say, terminal);
  assert.equal(dying.marker(), null);
}

process.exit(0);
