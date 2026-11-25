// The chat's "run one lap", "turn on automatic work" and "pause the factory" (lib/factory-control.mjs), with a
// stand-in factory/consumer.py in the project's checkout that records how it was called: each handler runs Cole
// Medin's own command for the project the request names and answers in plain words.
// test cases: 15
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_MESSAGES, KEEP_RUNS_DROPIN, LAP_ARGS, findProject, lap, registeredProjects, scheduleFor, workOff, workOn } from '../lib/factory-control.mjs';
import { run as runProcess } from '../lib/process.mjs';
import { testCase } from './cases.mjs';

// The stand-in consumer: one JSON line per call (its arguments, its folder, HOME and IS_SANDBOX); a file named
// refuse in the checkout makes it refuse as the real one does.
const CONSUMER = `import json, os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(root, 'calls.jsonl'), 'a') as log:
    log.write(json.dumps({'args': sys.argv[1:], 'cwd': os.getcwd(), 'home': os.environ.get('HOME'), 'sandbox': os.environ.get('IS_SANDBOX')}) + '\\n')
if os.path.exists(os.path.join(root, 'refuse')):
    print('Factory refused: Local STOP is set. Use unhalt to permit launch/continuation; cancel remains available', file=sys.stderr)
    sys.exit(1)
if sys.argv[1:2] == ['run']:
    print(json.dumps({'runId': 'run-1', 'status': 'running'}))
`;

async function server(repositories = ['owner/app']) {
  const root = await mkdtemp(join(tmpdir(), 'forge-control-'));
  const state = join(root, 'state');
  const checkouts = {};
  for (const repository of repositories) {
    const checkout = join(root, 'projects', repository);
    await mkdir(join(checkout, 'factory'), { recursive: true });
    await writeFile(join(checkout, 'factory', 'consumer.py'), CONSUMER);
    await mkdir(join(state, 'projects', repository), { recursive: true });
    await writeFile(join(state, 'projects', repository, 'registration.json'), JSON.stringify({ repository, checkout, completed: true }));
    checkouts[repository] = checkout;
  }
  const logged = [];
  const ctx = { gs: null, config: { commands: { python: 'python3' } }, paths: { state }, now: () => Date.parse('2026-11-22T12:00:00Z'), log: line => logged.push(line) };
  return { root, state, checkouts, ctx, logged };
}

const calls = async checkout => (await readFile(join(checkout, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const request = (kind, project = 'owner/app') => ({ id: 'r1', kind, project, words: 'run one lap', at: '2026-11-22T12:00:00Z' });
// Not root, no systemd: the commands run as they are, through the real process runner.
const plainServer = { platform: 'linux', uid: () => 1000, systemd: async () => false, owner: async () => ({ name: 'owner', uid: 1000, gid: 1000, home: '/home/owner' }) };

testCase('run one lap starts one detached lap that waits for the owner\'s approval, in the project\'s checkout');
{
  const s = await server();
  const answer = await lap(request('lap'), s.ctx, plainServer);
  assert.deepEqual(answer, { ok: true, say: 'One lap has started on owner/app: the factory is picking one piece of work and making the change. When the change is ready, it waits for your approval on GitHub before anything is merged.' });
  const made = await calls(s.checkouts['owner/app']);
  assert.deepEqual(made.map(c => c.args), [['run', 'archon-loop', '--input', 'merge=approve', '--detach', '--json']]);
  assert.deepEqual(LAP_ARGS, ['factory/consumer.py', 'run', 'archon-loop', '--input', 'merge=approve', '--detach', '--json']);
  assert.equal(made[0].cwd, s.checkouts['owner/app']);
  assert.deepEqual([made[0].home, made[0].sandbox], ['/home/owner', '1']);
}

testCase('as root where systemd runs, the lap starts in a unit of its own that leaves the detached run alive');
{
  const s = await server();
  const ran = [];
  const deps = { platform: 'linux', uid: () => 0, systemd: async () => true, owner: async () => ({ name: 'root', uid: 0, gid: 0, home: '/root' }), run: async (command, args, options) => { ran.push({ command, args, options }); return { stdout: '{}' }; } };
  assert.equal((await lap(request('lap'), s.ctx, deps)).ok, true);
  assert.equal(ran.length, 1);
  assert.equal(ran[0].command, 'systemd-run');
  const args = ran[0].args;
  for (const part of ['--quiet', '--collect', '--wait', '--pipe', '--unit=forge-lap-owner-app-1795348800000', 'KillMode=process', `--working-directory=${s.checkouts['owner/app']}`, '--setenv=HOME=/root', '--setenv=IS_SANDBOX=1', '--setenv=XDG_RUNTIME_DIR=/run/user/0']) assert(args.includes(part), part);
  assert.deepEqual(args.slice(-8), ['python3', ...LAP_ARGS]);
  assert(!args.some(a => a.startsWith('--uid=')), 'setup ran as root, so the lap does');
  const other = [];
  await lap(request('lap'), s.ctx, { ...deps, owner: async () => ({ name: 'builder', uid: 1001, gid: 1002, home: '/home/builder' }), run: async (c, a) => { other.push(a); return { stdout: '' }; } });
  assert(other[0].includes('--uid=1001') && other[0].includes('--gid=1002') && other[0].includes('--setenv=HOME=/home/builder'), 'as the user setup ran as');
}

testCase('turn on automatic work writes the schedule, installs the timer and resumes scheduled laps');
{
  const s = await server();
  const answer = await workOn(request('work-on'), s.ctx, plainServer);
  assert.deepEqual(answer, { ok: true, say: 'Automatic work is on for owner/app. Every five minutes the factory looks for work, makes one change at a time and merges each change that passes its checks. Say "pause the factory" to stop it starting new work.' });
  assert.deepEqual(JSON.parse(await readFile(join(s.checkouts['owner/app'], '.factory/schedule.json'), 'utf8')), { workflow: 'archon-loop', parallel: 1, inputs: { merge: 'auto' } });
  assert.deepEqual((await calls(s.checkouts['owner/app'])).map(c => c.args), [['schedule', 'install', '--apply'], ['unpause']]);
}

testCase('a schedule already there keeps its own inputs and keys, with archon-loop, merge auto and one lap at a time');
assert.deepEqual(scheduleFor({ workflow: 'archon-manager', parallel: 3, base_branch: 'develop', inputs: { runtime: '/private/runtime.json', merge: 'approve' } }),
  { workflow: 'archon-loop', parallel: 1, base_branch: 'develop', inputs: { runtime: '/private/runtime.json', merge: 'auto' } });
assert.deepEqual(scheduleFor(null), { workflow: 'archon-loop', parallel: 1, inputs: { merge: 'auto' } });

testCase('on Linux the timer\'s user gets lingering first, which root must have and anyone else may be refused');
{
  const s = await server();
  const ran = [];
  const recording = refuseLinger => async (command, args, options) => {
    ran.push([command, ...args].join(' '));
    if (command === 'loginctl') {
      if (refuseLinger) throw Object.assign(new Error('failed.'), { stderr: 'Access denied\n' });
      return { stdout: '' };
    }
    return runProcess(command, args, options);
  };
  const root = { platform: 'linux', uid: () => 0, systemd: async () => true, owner: async () => ({ name: 'root', uid: 0, gid: 0, home: '/root' }) };
  assert.equal((await workOn(request('work-on'), s.ctx, { ...root, run: recording(false) })).ok, true);
  assert.deepEqual(ran, ['loginctl enable-linger root', 'python3 factory/consumer.py schedule install --apply', 'python3 factory/consumer.py unpause']);
  ran.length = 0;
  assert.equal((await workOn(request('work-on'), s.ctx, { ...root, run: recording(true) })).ok, false, 'root without lingering would lose the timer');
  ran.length = 0;
  assert.equal((await workOn(request('work-on'), s.ctx, { ...plainServer, systemd: async () => true, run: recording(true) })).ok, true, 'a user refused lingering keeps the timer while logged in');
}

testCase("turning on automatic work keeps each lap the factory's timer starts alive after the trigger ends, beside its own unit");
{
  const s = await server();
  const home = await mkdtemp(join(tmpdir(), 'forge-home-'));
  const units = join(home, '.config', 'systemd', 'user');
  await mkdir(units, { recursive: true });
  const mine = 'archonfactory-app.service', other = 'archonfactory-other.service';
  await writeFile(join(units, mine), `[Service]\nType=oneshot\nWorkingDirectory=${s.checkouts['owner/app']}\nExecStart=/usr/bin/python3 factory/consumer.py schedule fire\n`);
  await writeFile(join(units, other), '[Service]\nType=oneshot\nWorkingDirectory=/somewhere/else\n');
  await writeFile(join(units, 'archonfactory-app-manager.service'), `[Service]\nWorkingDirectory=${s.checkouts['owner/app']}\nExecStart=/usr/bin/python3 factory/consumer.py run archon-manager\n`);
  const ran = [];
  const run = async (command, args, options) => {
    ran.push([command, ...args].join(' '));
    if (command === 'loginctl' || command === 'systemctl') return { stdout: '' };
    return runProcess(command, args, options);
  };
  const root = { platform: 'linux', uid: () => 0, systemd: async () => true, owner: async () => ({ name: 'root', uid: 0, gid: 0, home }), run };
  assert.equal((await workOn(request('work-on'), s.ctx, root)).ok, true);
  assert.equal(await readFile(join(units, `${mine}.d`, KEEP_RUNS_DROPIN), 'utf8'), '[Service]\n# The Forge: the lap this trigger starts keeps running after the trigger ends.\nKillMode=process\n');
  await assert.rejects(readFile(join(units, `${other}.d`, KEEP_RUNS_DROPIN), 'utf8'), 'another project\'s unit is left alone');
  await assert.rejects(readFile(join(units, 'archonfactory-app-manager.service.d', KEEP_RUNS_DROPIN), 'utf8'), 'a unit of the same project that is not the timer\'s trigger is left alone');
  assert.equal(await readFile(join(units, mine), 'utf8').then(t => t.includes('KillMode')), false, 'the factory\'s own unit is never changed');
  assert.deepEqual(ran, ['loginctl enable-linger root', 'python3 factory/consumer.py schedule install --apply', 'systemctl --user daemon-reload', 'python3 factory/consumer.py unpause']);
}

testCase('pause the factory pauses scheduled laps and lets running ones finish');
{
  const s = await server();
  assert.deepEqual(await workOff(request('work-off'), s.ctx, plainServer), { ok: true, say: 'The factory is paused for owner/app: it starts no new work, and a change it is already making is finished. Say "turn on automatic work" to start it again.' });
  assert.deepEqual((await calls(s.checkouts['owner/app'])).map(c => c.args), [['pause']]);
}

testCase('the owner\'s own pause is announced by a file made before the pause and removed with it, so the driver leaves it alone; a refused pause leaves none');
{
  const s = await server();
  const checkout = s.checkouts['owner/app'];
  const mark = join(checkout, '.factory', 'owner-pause');
  await workOff(request('work-off'), s.ctx, plainServer);
  assert.equal(await readFile(mark, 'utf8'), 'Asked by the owner in the chat: r1.\n', 'made, naming his request');
  await workOn(request('work-on'), s.ctx, plainServer);
  await assert.rejects(readFile(mark, 'utf8'), /ENOENT/, 'turning on automatic work removes it with the pause');
  await writeFile(join(checkout, 'refuse'), '');
  await workOff(request('work-off'), s.ctx, plainServer);
  await assert.rejects(readFile(mark, 'utf8'), /ENOENT/, 'a pause the factory refused leaves no mark behind');
}

testCase('a refusing factory is said plainly, its own words go only to the log');
{
  const s = await server();
  await writeFile(join(s.checkouts['owner/app'], 'refuse'), '');
  assert.deepEqual(await lap(request('lap'), s.ctx, plainServer), { ok: false, say: 'One lap could not be started on owner/app, because the factory refused to start. Try "run one lap" again in a few minutes; if it refuses again, run godspeed-forge setup owner/app in the server\'s terminal, which checks the factory.' });
  assert.deepEqual(await workOn(request('work-on'), s.ctx, plainServer), { ok: false, say: 'Automatic work could not be turned on for owner/app, because this server would not start the factory\'s timer. Try "turn on automatic work" again; if it fails again, run godspeed-forge setup owner/app in the server\'s terminal, which checks the factory.' });
  assert.deepEqual(await workOff(request('work-off'), s.ctx, plainServer), { ok: false, say: 'The factory could not be paused for owner/app. Try "pause the factory" again in a minute.' });
  assert.match(s.logged[0], /^lap on owner\/app: Factory refused: Local STOP is set/);
}

testCase('the project is found by its full name, its short name or its address, and the only one needs no name');
{
  const projects = [{ repository: 'owner/app', checkout: '/a' }];
  for (const name of ['owner/app', 'OWNER/App', 'app', 'https://github.com/owner/app', 'https://github.com/owner/app.git', '', undefined]) {
    assert.equal(findProject(name, projects).project?.repository, 'owner/app', String(name));
  }
}

testCase('with no project, an unknown one or two that match, the answer says which projects there are');
{
  assert.deepEqual(findProject('app', []), { say: 'No project is set up with the Forge on this server yet. Set one up first with godspeed-forge setup owner/repository in the server\'s terminal.' });
  const two = [{ repository: 'alice/app', checkout: '/a' }, { repository: 'bob/app', checkout: '/b' }];
  assert.deepEqual(findProject('app', two), { say: 'Which project do you mean? The ones it has are alice/app and bob/app.' });
  assert.deepEqual(findProject('website', two), { say: 'The Forge has no project called "website" on this server. The ones it has are alice/app and bob/app.' });
  assert.deepEqual(findProject('website', two.slice(0, 1)), { say: 'The Forge has no project called "website" on this server. The one it has is alice/app.' });
  assert.equal(findProject('bob/app', two).project.checkout, '/b');
}

testCase('a request that names no project is for every project set up with the Forge, each answered in its own sentence');
{
  const s = await server(['alice/app', 'bob/site']);
  const answer = await workOff({ id: 'r2', kind: 'work-off', words: 'pause the factory', at: '2026-11-22T12:00:00Z' }, s.ctx, plainServer);
  assert.deepEqual(answer, { ok: true, say: `${CONTROL_MESSAGES.workOff('alice/app')} ${CONTROL_MESSAGES.workOff('bob/site')}` });
  for (const repository of ['alice/app', 'bob/site']) assert.deepEqual((await calls(s.checkouts[repository])).map(c => c.args), [['pause']], repository);
  await writeFile(join(s.checkouts['bob/site'], 'refuse'), '');
  const mixed = await lap({ id: 'r3', kind: 'lap', project: '', words: 'run one lap', at: '2026-11-22T12:00:00Z' }, s.ctx, plainServer);
  assert.deepEqual(mixed, { ok: false, say: `${CONTROL_MESSAGES.lapStarted('alice/app')} ${CONTROL_MESSAGES.lapFailed('bob/site')}` });
  const none = await server([]);
  assert.deepEqual(await workOn({ id: 'r4', kind: 'work-on' }, none.ctx, plainServer), { ok: false, say: CONTROL_MESSAGES.noProject });
}

testCase('only repositories whose setup finished count, read from the Forge\'s private state');
{
  const s = await server(['owner/app', 'owner/site']);
  await writeFile(join(s.state, 'projects', 'owner/site', 'registration.json'), JSON.stringify({ repository: 'owner/site', checkout: '/x', completed: false }));
  await mkdir(join(s.state, 'projects', 'owner', 'half'), { recursive: true });
  assert.deepEqual((await registeredProjects(s.state)).map(p => p.repository), ['owner/app']);
  assert.deepEqual(await registeredProjects(join(s.root, 'nowhere')), []);
  const answer = await lap(request('lap', 'site'), s.ctx, plainServer);
  assert.deepEqual(answer, { ok: false, say: 'The Forge has no project called "site" on this server. The one it has is owner/app.' });
}

testCase('as root for a project set up by another user, the factory\'s command runs as that user');
{
  const s = await server();
  const ran = [];
  await workOff(request('work-off'), s.ctx, { platform: 'linux', uid: () => 0, systemd: async () => false, owner: async () => ({ name: 'builder', uid: 1001, gid: 1001, home: '/home/builder' }), run: async (command, args, options) => { ran.push({ command, args, env: options.env }); return { stdout: '' }; } });
  assert.deepEqual([ran[0].command, ...ran[0].args], ['runuser', '-u', 'builder', '--', 'python3', 'factory/consumer.py', 'pause']);
  assert.equal(ran[0].env.HOME, '/home/builder');
  assert(ran[0].env.PATH.startsWith('/home/builder/.local/bin:/home/builder/.bun/bin:'), 'the tools under the home come first');
}

testCase('every answer is plain: at most one link, no dashes, no one\'s name');
for (const message of [CONTROL_MESSAGES.noProject, ...['lapStarted', 'lapFailed', 'workOn', 'workOnFailed', 'workOff', 'workOffFailed'].map(k => CONTROL_MESSAGES[k]('owner/app')),
  CONTROL_MESSAGES.unknownProject('x', ['a/b', 'c/d']), CONTROL_MESSAGES.whichProject(['a/b', 'c/d'])]) {
  assert((message.match(/https?:\/\//g) ?? []).length <= 1, message);
  assert(!/[–—]/.test(message), message);
  assert(!/Michael/.test(message), message);
}
