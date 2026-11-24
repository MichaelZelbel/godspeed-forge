// The factory's own setup that setup finishes (lib/factory-setup.mjs), with a stand-in coding assistant, a
// stand-in gh and real git pushing to a repository on this machine: the factory's AI is configured, the seven
// proposals are printed numbered and struck by number, the kept ones reach MISSION.md, the journeys and checks are
// written, everything is committed and pushed, and a rerun picks up where a stop left it.
// test cases: 20
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMIT_MESSAGE, CONFIRM_ANSWER_MESSAGE, CONFIRM_QUESTION, FACTORY_MESSAGES, SCRATCH_FILE, STRIKE_ANSWER_MESSAGE, STRIKE_QUESTION, configureArchon, finishFactory,
  struckNumbers, withOutOfScope
} from '../lib/factory-setup.mjs';
import { InputClosed, ReportedSetupError, setupRepository } from '../lib/setup.mjs';
import { createFactorySetup } from '../lib/factory-setup.mjs';
import { defaults } from '../lib/config.mjs';
import { FACTORY_REVISION } from '../lib/constants.mjs';
import { run as runProcess } from '../lib/process.mjs';
import { testCase } from './cases.mjs';

// git as on a fresh server: no name or e-mail of its own.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const REPO = 'owner/app';
const ENTRIES = ['A hosted service other people sign up for.', 'A mobile app.', 'A plugin marketplace.', 'Team accounts with roles.', 'A built in chat.', 'Paid plans.', 'An offline desktop version.'];
const JOURNEYS = '# End-to-end journeys\n\n## A person adds a note\n\n1. Run app add "milk".\n\n**What would make this fail:** the note is not listed.\n\n## A person lists notes\n\n1. Run app list.\n\n**What would make this fail:** an empty list.\n';
const TEMPLATE_MISSION = '# Mission\n\n## What <PRODUCT> is\n\n<paragraph>\n\n## Out of scope -- the factory must never build this\n\n<!--\n  THE SECTION THAT EARNS ITS KEEP.\n-->\n\n**<Category>**\n- <thing>\n- <thing>\n\n## Hard invariants -- not tunable by any issue\n\n1. Something.\n\n## Project mission\n\nWhat this software is for: Notes.\n\nWho uses it: People.\n';
const git = (args, cwd) => runProcess('git', args, { cwd });

// A project as the factory's installer leaves it, cloned from a repository on this machine, and its private state.
async function project({ workflows = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'forge-factory-setup-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  await git(['init', '-q', '--bare', '-b', 'main', remote], root);
  await git(['init', '-q', '-b', 'main', seed], root);
  await writeFile(join(seed, 'README.md'), '# app\n');
  if (workflows) { await mkdir(join(seed, '.github/workflows'), { recursive: true }); await writeFile(join(seed, '.github/workflows/ci.yml'), 'name: ci\n'); }
  await git(['add', '-A'], seed);
  await git(['-c', 'user.name=seed', '-c', 'user.email=seed@example.test', 'commit', '-qm', 'seed'], seed);
  await git(['push', '-q', remote, 'main'], seed);
  const checkout = join(root, 'projects', REPO);
  await mkdir(join(root, 'projects', 'owner'), { recursive: true });
  await git(['clone', '-q', remote, checkout], root);
  for (const [path, text] of Object.entries({
    'MISSION.md': TEMPLATE_MISSION, 'FACTORY.md': '# Factory\n', 'FACTORY_RULES.md': '# Rules\n', 'engineering.md': 'See the policy.\n',
    '.gitignore': '.factory/consumer.json\n.factory/backup/\n', '.ignore': '.factory/holdout/\n', '.claude/settings.json': '{"hooks": {}}\n',
    'factory/consumer.py': '# stand-in\n', '.factory/consumer.json': '{"source": "/private/path"}\n', '.factory/holdout/HOLDOUT.md': '# Holdout scenarios\n', '.factory/hooks/holdout_fence.py': 'print("the fence")\n',
    'harness/END-TO-END.md': '# Runtime scenarios\n\nExample task-service data.\n\n## A person captures a task\n\n1. Add a task called `refill the kalimba humidifier`.\n',
    'harness/harness.config.json': JSON.stringify({ static: '', unit: '', unit_count_pattern: '', required_checks: '', protected_paths: 'MISSION.md,harness/**,.factory/**' }, null, 2)
  })) {
    await mkdir(join(checkout, path, '..'), { recursive: true });
    await writeFile(join(checkout, path), text);
  }
  const state = join(root, 'state', 'projects', REPO);
  await mkdir(state, { recursive: true });
  return { root, remote, checkout, state, home: join(root, 'home') };
}

// The stand-in assistant and gh; `assistant` changes what the assistant writes, `gh` answers gh's calls.
function world(p, { assistant = {}, gh = () => ({ stdout: '' }), agent = 'claude' } = {}) {
  const w = { calls: [], said: [], asked: [], agentRuns: 0 };
  w.run = async (command, args, options = {}) => {
    w.calls.push([command, ...args.map(a => (a.length > 60 ? '<prompt>' : a))].join(' '));
    if (command === 'git') return runProcess(command, args, options);
    if (command === 'gh') return gh(args, w);
    if (command === agent) {
      w.agentRuns += 1;
      if (assistant.fail) throw Object.assign(new Error('failed.'), { stderr: 'boom', stdout: '' });
      if (assistant.tamper) for (const path of ['MISSION.md', '.claude/settings.json']) await writeFile(join(options.cwd, path), 'tampered\n');
      if (assistant.overreach) {
        await writeFile(join(options.cwd, '.factory/hooks/holdout_fence.py'), 'print("the fence is open")\n');
        await writeFile(join(options.cwd, '.factory/hooks/also.py'), 'print("new")\n');
        await mkdir(join(options.cwd, 'harness/new-folder'), { recursive: true });
        await writeFile(join(options.cwd, 'harness/new-folder/extra.md'), 'extra\n');
        await writeFile(join(options.cwd, 'harness/extra.md'), 'extra\n');
        await writeFile(join(options.cwd, 'MISSION.md'), 'rewritten by the assistant\n');
        await rm(join(options.cwd, 'factory/consumer.py'));
        await writeFile(join(options.cwd, 'notes.md'), 'outside the factory\n');
        if (assistant.overreach === 'and fails') throw Object.assign(new Error('failed.'), { stderr: 'boom', stdout: '' });
      }
      const entries = 'entries' in assistant ? assistant.entries : ENTRIES;
      if (entries) await writeFile(join(options.cwd, SCRATCH_FILE), JSON.stringify(entries));
      await writeFile(join(options.cwd, 'harness/END-TO-END.md'), assistant.journeys ?? JOURNEYS);
      const harness = JSON.parse(await readFile(join(options.cwd, 'harness/harness.config.json'), 'utf8'));
      await writeFile(join(options.cwd, 'harness/harness.config.json'), JSON.stringify({ ...harness, static: 'npm run lint', unit: 'npm test', required_checks: assistant.checks ?? 'tests', protected_paths: 'nothing' }, null, 2));
      return { stdout: '' };
    }
    throw new Error(`unexpected ${command}`);
  };
  // answers: for the questions in order; confirms: for the question before anything is sent (yes unless given).
  w.context = (answers, confirms = ['yes']) => ({
    repository: REPO, checkout: p.checkout, agent, agentName: agent === 'claude' ? 'Claude Code' : 'Codex', stateDirectory: p.state,
    commands: { run: w.run, names: { git: 'git', gh: 'gh' } }, config: {},
    prompt: async question => {
      w.asked.push(question);
      const next = question === CONFIRM_QUESTION(REPO) ? confirms.shift() : answers.shift();
      if (next === undefined) throw new InputClosed();
      return next;
    },
    output: line => w.said.push(line)
  });
  return w;
}

const stopOf = async promise => { try { await promise; } catch (error) { return error.message; } return null; };
const remoteFile = async (p, path) => (await git(['show', `main:${path}`], p.remote)).stdout;

testCase('the factory\'s AI: Archon\'s own settings for Claude Code, Sonnet for small and medium work and Opus for large');
{
  const home = await mkdtemp(join(tmpdir(), 'forge-archon-'));
  assert.deepEqual(await configureArchon('claude', { home }), ['defaultAssistant', 'tiers']);
  assert.equal(await readFile(join(home, '.archon/config.yaml'), 'utf8'), [
    '# The Forge\'s setup: the factory\'s AI for Claude Code.',
    'defaultAssistant: claude',
    'tiers:',
    '  small: { provider: claude, model: claude-sonnet-5-5 }',
    '  medium: { provider: claude, model: claude-sonnet-5-5 }',
    '  large: { provider: claude, model: claude-opus-5-5 }', ''
  ].join('\n'));
  assert.equal((await stat(join(home, '.archon/config.yaml'))).mode & 0o777, 0o600);
  assert.deepEqual(await configureArchon('claude', { home }), [], 'run again, it changes nothing');
}

testCase('for Codex the Codex provider with the Codex models the pinned Archon names');
{
  const home = await mkdtemp(join(tmpdir(), 'forge-archon-'));
  await configureArchon('codex', { home });
  assert.match(await readFile(join(home, '.archon/config.yaml'), 'utf8'), /^defaultAssistant: codex\ntiers:\n {2}small: \{ provider: codex, model: gpt-5\.6-luna \}\n {2}medium: \{ provider: codex, model: gpt-5\.6-terra \}\n {2}large: \{ provider: codex, model: gpt-5\.6-sol \}\n$/m);
}

testCase('settings already there are kept: only a missing key is added, below them');
{
  const home = await mkdtemp(join(tmpdir(), 'forge-archon-'));
  await mkdir(join(home, '.archon'));
  const own = 'assistants:\n  claude:\n    model: opus\ntiers:\n  large: { provider: claude, model: opus }\n';
  await writeFile(join(home, '.archon/config.yaml'), own);
  assert.deepEqual(await configureArchon('claude', { home }), ['defaultAssistant']);
  assert.equal(await readFile(join(home, '.archon/config.yaml'), 'utf8'), `${own}\n# The Forge's setup: the factory's AI for Claude Code.\ndefaultAssistant: claude\n`);
  const both = 'defaultAssistant: codex\ntiers:\n  medium: { provider: codex, model: x }\n';
  await writeFile(join(home, '.archon/config.yaml'), both);
  assert.deepEqual(await configureArchon('claude', { home }), []);
  assert.equal(await readFile(join(home, '.archon/config.yaml'), 'utf8'), both, 'a working setting is never replaced');
}

testCase('the seven proposals are printed numbered, the struck ones are dropped, and everything is pushed to the default branch');
{
  const p = await project();
  const w = world(p);
  await finishFactory(w.context(['2 5']), { home: p.home });
  assert.deepEqual(w.said, [
    'Claude Code is reading the project to propose what it must never become, the journeys its users take today and the checks it runs. This takes a few minutes.',
    'Claude Code proposes these seven things the project must never become:',
    ...ENTRIES.map((entry, index) => `${index + 1}. ${entry}`),
    'Setup will add this to owner/app on GitHub:',
    'The 5 things the project must never become that you kept.',
    'These journeys of what the project does today:',
    '1. A person adds a note',
    '2. A person lists notes',
    'The project\'s checks, and the files the build tools need to work.',
    'Setup added the project\'s mission, journeys and checks to owner/app on GitHub.'
  ]);
  assert.deepEqual(w.asked, ['Type the numbers of any that are wrong, separated by spaces, or press Enter to keep all seven:', 'Type yes to add these to owner/app on GitHub, or no to stop here:']);
  assert.equal(STRIKE_QUESTION, w.asked[0]);
  assert.equal(CONFIRM_QUESTION('owner/app'), w.asked[1]);
  const mission = await remoteFile(p, 'MISSION.md');
  assert(mission.includes('## Out of scope -- the factory must never build this\n\n<!--\n  THE SECTION THAT EARNS ITS KEEP.\n-->\n\n- A hosted service other people sign up for.\n- A plugin marketplace.\n- Team accounts with roles.\n- Paid plans.\n- An offline desktop version.\n\n## Hard invariants'), mission);
  assert(!mission.includes('A mobile app.') && !mission.includes('A built in chat.') && !mission.includes('<thing>'));
  assert(mission.endsWith('## Project mission\n\nWhat this software is for: Notes.\n\nWho uses it: People.\n'));
  assert.equal(await remoteFile(p, 'harness/END-TO-END.md'), JOURNEYS);
  assert.deepEqual(JSON.parse(await remoteFile(p, 'harness/harness.config.json')), { static: 'npm run lint', unit: 'npm test', unit_count_pattern: '', required_checks: 'tests', protected_paths: 'MISSION.md,harness/**,.factory/**' }, 'protected_paths is kept as the installer wrote it');
  for (const path of ['factory/consumer.py', '.claude/settings.json', '.ignore', '.factory/holdout/HOLDOUT.md', 'FACTORY_RULES.md']) assert(await remoteFile(p, path), path);
  await assert.rejects(remoteFile(p, '.factory/consumer.json'), 'this server\'s own settings stay out');
  await assert.rejects(remoteFile(p, SCRATCH_FILE), 'the scratch file stays out');
  await assert.rejects(stat(join(p.checkout, SCRATCH_FILE)));
  assert.equal((await git(['log', '-1', '--format=%s|%an|%ae', 'main'], p.remote)).stdout.trim(), `${COMMIT_MESSAGE}|Forge setup|forge-setup@users.noreply.github.com`);
  assert.equal(COMMIT_MESSAGE, 'Set up the AI software factory: what this project must never become, its journeys and its checks');
  assert.match(await readFile(join(p.home, '.archon/config.yaml'), 'utf8'), /^defaultAssistant: claude$/m);
  testCase('a rerun after it finished changes nothing and asks nothing');
  const again = world(p);
  await finishFactory(again.context([]), { home: p.home });
  assert.deepEqual([again.said, again.asked, again.agentRuns], [[], [], 0]);
}

testCase('pressing Enter keeps all seven; an answer that is not numbers from 1 to 7 is asked again');
{
  assert.deepEqual([...struckNumbers('')], []);
  assert.deepEqual([...struckNumbers(' 3, 1 3 ')], [3, 1]);
  for (const wrong of ['8', 'two', '0', '1-3', '2.5']) assert.equal(struckNumbers(wrong), null, wrong);
  const p = await project();
  const w = world(p);
  await finishFactory(w.context(['8', 'all', '']), { home: p.home });
  assert.deepEqual(w.said.filter(line => line === STRIKE_ANSWER_MESSAGE), [STRIKE_ANSWER_MESSAGE, STRIKE_ANSWER_MESSAGE]);
  assert.equal(STRIKE_ANSWER_MESSAGE, 'Setup expects numbers from 1 to 7 here, separated by spaces, so it asks again.');
  for (const entry of ENTRIES) assert((await remoteFile(p, 'MISSION.md')).includes(`- ${entry}\n`), entry);
}

testCase('stopped at the question, a rerun asks it again without asking the assistant again');
{
  const p = await project();
  const w = world(p);
  await assert.rejects(finishFactory(w.context([]), { home: p.home }), InputClosed);
  const again = world(p);
  await finishFactory(again.context(['7']), { home: p.home });
  assert.equal(again.agentRuns, 0);
  assert.equal(again.said[0], 'Claude Code proposes these seven things the project must never become:');
  assert(!(await remoteFile(p, 'MISSION.md')).includes('An offline desktop version.'));
}

testCase('what the assistant must write and did not: each stop says so, and a rerun asks it again');
{
  const cases = [
    [{ fail: true }, 'Setup stopped because Claude Code did not finish reading the project. Try setup again.'],
    [{ entries: ENTRIES.slice(0, 6) }, 'Setup stopped because Claude Code did not write the seven proposals for what the project must never become. Try setup again, which asks it again.'],
    [{ entries: null }, 'Setup stopped because Claude Code did not write the seven proposals for what the project must never become. Try setup again, which asks it again.'],
    [{ journeys: '# Runtime scenarios\n\nExample task-service data.\n\n## A\n\n## B\n' }, 'Setup stopped because Claude Code did not write two to five journeys of what the project does today. Try setup again, which asks it again.'],
    [{ journeys: '# Journeys\n\n## Only one\n' }, 'Setup stopped because Claude Code did not write two to five journeys of what the project does today. Try setup again, which asks it again.']
  ];
  for (const [assistant, message] of cases) {
    const p = await project();
    assert.equal(await stopOf(finishFactory(world(p, { assistant }).context(['']), { home: p.home })), message, JSON.stringify(assistant).slice(0, 80));
    const again = world(p);
    await finishFactory(again.context(['']), { home: p.home });
    assert.equal(again.agentRuns, 1, 'the rerun asks the assistant again');
  }
}

testCase('before anything is sent the owner sees what will be added and says yes; no stops with nothing sent, and a rerun asks again');
{
  const p = await project();
  const before = (await git(['rev-parse', 'main'], p.remote)).stdout.trim();
  const w = world(p);
  assert.equal(await stopOf(finishFactory(w.context([''], ['maybe', 'no']), { home: p.home })), 'Setup stopped because you chose not to add these to owner/app yet, so nothing was sent to GitHub. Try setup again when you want to add them; it asks again.');
  assert(w.said.includes(CONFIRM_ANSWER_MESSAGE) && CONFIRM_ANSWER_MESSAGE === 'Setup expects yes or no here, so it asks again.');
  assert.equal((await git(['rev-parse', 'main'], p.remote)).stdout.trim(), before, 'nothing was pushed');
  assert.equal((await git(['log', '-1', '--format=%s'], p.checkout)).stdout.trim(), 'seed', 'nothing was committed');
  const again = world(p);
  await finishFactory(again.context([], ['yes']), { home: p.home });
  assert.equal(again.agentRuns, 0, 'the assistant is not asked again');
  assert.deepEqual(again.asked, [CONFIRM_QUESTION('owner/app')], 'only the question it stopped at');
  assert.equal(await remoteFile(p, 'harness/END-TO-END.md'), JOURNEYS);
}

for (const [how, outcome] of [['and fails', 'stops'], ['and finishes', 'goes on']]) {
  testCase(`an assistant that changes the factory's own files ${how}: everything it must not touch is put back byte for byte and nothing new it made there is kept`);
  const p = await project();
  const w = world(p, { assistant: { overreach: how } });
  const result = await stopOf(finishFactory(w.context(['']), { home: p.home }));
  assert.equal(result, outcome === 'stops' ? 'Setup stopped because Claude Code did not finish reading the project. Try setup again.' : null);
  assert.equal(await readFile(join(p.checkout, '.factory/hooks/holdout_fence.py'), 'utf8'), 'print("the fence")\n');
  assert.equal(await readFile(join(p.checkout, 'factory/consumer.py'), 'utf8'), '# stand-in\n', 'a file it deleted is back');
  for (const made of ['.factory/hooks/also.py', 'harness/extra.md', 'harness/new-folder']) await assert.rejects(stat(join(p.checkout, made)), made);
  const mission = await readFile(join(p.checkout, 'MISSION.md'), 'utf8');
  assert(!mission.includes('rewritten by the assistant'), mission);
  if (outcome === 'goes on') {
    const committed = (await git(['show', '--name-only', '--format=', 'main'], p.remote)).stdout.trim().split('\n').sort();
    assert.deepEqual(committed, ['.claude/settings.json', '.factory/holdout/HOLDOUT.md', '.factory/hooks/holdout_fence.py', '.gitignore', '.ignore', 'FACTORY.md', 'FACTORY_RULES.md', 'MISSION.md', 'engineering.md', 'factory/consumer.py', 'harness/END-TO-END.md', 'harness/harness.config.json'], 'only the files known before it ran, the two it writes and MISSION.md');
    assert.equal(await remoteFile(p, '.factory/hooks/holdout_fence.py'), 'print("the fence")\n');
  } else {
    assert.equal((await git(['log', '-1', '--format=%s'], p.checkout)).stdout.trim(), 'seed', 'nothing was committed');
  }
}

testCase('what the assistant changed in the files that govern the factory, against its instructions, is put back');
{
  const p = await project();
  await finishFactory(world(p, { assistant: { tamper: true } }).context(['']), { home: p.home });
  assert.equal(await remoteFile(p, '.claude/settings.json'), '{"hooks": {}}\n');
  const mission = await remoteFile(p, 'MISSION.md');
  assert(!mission.includes('tampered') && mission.includes('- A mobile app.\n'), mission);
}

testCase('required checks: "none" for a project without CI workflows; a project with workflows must have them named');
{
  const p = await project();
  await finishFactory(world(p, { assistant: { checks: '' } }).context(['']), { home: p.home });
  assert.equal(JSON.parse(await remoteFile(p, 'harness/harness.config.json')).required_checks, 'none');
  const q = await project({ workflows: true });
  assert.equal(await stopOf(finishFactory(world(q, { assistant: { checks: '' } }).context(['']), { home: q.home })), 'Setup stopped because Claude Code did not write the project\'s checks. Try setup again, which asks it again.');
}

testCase('with Codex the assistant runs as codex exec in the project, sandboxed to it');
{
  const p = await project();
  const w = world(p, { agent: 'codex' });
  await finishFactory(w.context(['']), { home: p.home });
  assert(w.calls.includes('codex exec --sandbox workspace-write <prompt>'), w.calls.join('\n'));
  assert.equal(w.said[0], 'Codex is reading the project to propose what it must never become, the journeys its users take today and the checks it runs. This takes a few minutes.');
  const claude = world(await project());
  await finishFactory(claude.context(['']), { home: p.home });
  assert(claude.calls.includes('claude -p <prompt> --model claude-sonnet-5-5 --permission-mode acceptEdits --output-format text'), claude.calls.join('\n'));
}

testCase('a commit carries the GitHub account gh is signed in as when git on the server has no name');
{
  const p = await project();
  const w = world(p, { gh: args => (args[0] === 'api' && args[1] === 'user' ? { stdout: 'octo 42\n' } : { stdout: '' }) });
  await finishFactory(w.context(['']), { home: p.home });
  assert.equal((await git(['log', '-1', '--format=%an|%ae', 'main'], p.remote)).stdout.trim(), 'octo|42+octo@users.noreply.github.com');
}

testCase('when GitHub moved on meanwhile, setup takes the new commits first and pushes on top');
{
  const p = await project();
  const other = join(p.root, 'other');
  await git(['clone', '-q', p.remote, other], p.root);
  await writeFile(join(other, 'NOTES.md'), 'someone else\n');
  await git(['add', '-A'], other);
  await git(['-c', 'user.name=o', '-c', 'user.email=o@example.test', 'commit', '-qm', 'meanwhile'], other);
  await git(['push', '-q', 'origin', 'main'], other);
  await finishFactory(world(p).context(['']), { home: p.home });
  assert.equal(await remoteFile(p, 'NOTES.md'), 'someone else\n');
  assert.equal((await git(['log', '-1', '--format=%s', 'main'], p.remote)).stdout.trim(), COMMIT_MESSAGE);
}

testCase('a protected default branch: setup opens a pull request and merges it; held for its checks, it stops with its link and a rerun finishes');
{
  const p = await project();
  // GitHub refuses direct pushes to main, as a protected branch does.
  await writeFile(join(p.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && { echo "GH006: Protected branch update failed for refs/heads/main." >&2; exit 1; }; done\nexit 0\n', { mode: 0o755 });
  const pr = { merges: 0, state: 'OPEN' };
  const gh = args => {
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: '' };
    if (args[0] === 'pr' && args[1] === 'create') { pr.created = args; return { stdout: 'https://github.com/owner/app/pull/7\n' }; }
    if (args[0] === 'pr' && args[1] === 'view') return { stdout: `${pr.state}\n` };
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (args.includes('--auto')) { pr.auto = true; return { stdout: '' }; }
      pr.merges += 1;
      if (pr.merges === 1) throw Object.assign(new Error('failed.'), { stderr: 'Base branch policy prohibits the merge\n', stdout: '' });
      pr.state = 'MERGED';
      return { stdout: '' };
    }
    return { stdout: '' };
  };
  // A branch of the name setup would take first is already on GitHub: it is left exactly as it is.
  const seed = join(p.root, 'seed');
  await git(['push', '-q', p.remote, 'main:refs/heads/forge-setup-202611221234'], seed);
  const taken = (await git(['rev-parse', 'forge-setup-202611221234'], p.remote)).stdout.trim();
  const now = () => Date.parse('2026-11-22T12:34:56Z');
  const w = world(p, { gh });
  assert.equal(await stopOf(finishFactory(w.context(['']), { home: p.home, now })), 'Setup stopped because owner/app takes changes only through a pull request that passes its checks, so setup opened one with the project\'s setup files. Once it is merged, try setup again: https://github.com/owner/app/pull/7');
  assert.deepEqual(pr.created.slice(0, 8), ['pr', 'create', '--repo', 'owner/app', '--base', 'main', '--head', 'forge-setup-202611221234-2']);
  assert.equal(pr.auto, true, 'GitHub is asked to merge it once its checks pass');
  assert.equal((await git(['show', 'forge-setup-202611221234-2:harness/END-TO-END.md'], p.remote)).stdout, JOURNEYS, 'the new branch holds the files');
  assert.equal((await git(['rev-parse', 'forge-setup-202611221234'], p.remote)).stdout.trim(), taken, 'the branch that was there is untouched');
  assert(!w.calls.some(call => /\bpush\b.*(--force|-f\b|\+)/.test(call)), w.calls.join('\n'));
  const again = world(p, { gh });
  await finishFactory(again.context([]), { home: p.home, now });
  assert.deepEqual([again.agentRuns, again.asked], [0, []]);
  assert.deepEqual(again.said, ['Setup added the project\'s mission, journeys and checks to owner/app on GitHub.']);
}

testCase('a push GitHub refuses for another reason stops plainly, and a rerun pushes without asking again');
{
  const p = await project();
  await writeFile(join(p.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "connection reset" >&2\nexit 1\n', { mode: 0o755 });
  assert.equal(await stopOf(finishFactory(world(p).context(['']), { home: p.home })), 'Setup stopped because it could not send the project\'s setup files to owner/app on GitHub. Restore this server\'s access to GitHub before trying setup again.');
  await writeFile(join(p.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const again = world(p);
  await finishFactory(again.context([]), { home: p.home });
  assert.deepEqual([again.agentRuns, again.asked], [0, []]);
  assert.equal(await remoteFile(p, 'harness/END-TO-END.md'), JOURNEYS);
}

testCase('a mission without the template\'s out-of-scope section gets one before the project mission');
{
  const plain = '# Mission\n\nOwn words.\n\n## Project mission\n\nWhat this software is for: X.\n\nWho uses it: Y.\n';
  assert.equal(withOutOfScope(plain, ['One.', 'Two.']), '# Mission\n\nOwn words.\n\n## Out of scope: the factory must never build this\n\n- One.\n- Two.\n\n## Project mission\n\nWhat this software is for: X.\n\nWho uses it: Y.\n');
  assert.equal(withOutOfScope(withOutOfScope(TEMPLATE_MISSION, ['One.']), ['One.']), withOutOfScope(TEMPLATE_MISSION, ['One.']), 'writing it twice is writing it once');
}

testCase('setup runs the final check before the factory\'s mission questions and Apps, and its messages are plain');
{
  const p = await project();
  const order = [];
  const w = world(p);
  const run = async (command, args, options = {}) => {
    order.push(`${command} ${args[0]}`);
    if (command === 'claude' && args[0] === 'auth') return { stdout: '' };
    if (command === 'gh' && args[0] === 'repo') return { stdout: '' };
    if (command === 'git' && args[0] === 'remote') return { stdout: `https://github.com/${REPO}.git\n` };
    if (command === 'git' && args[0] === 'clone') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
    if (command === 'git' && (args[0] === 'fetch' || args[0] === 'checkout') && options.cwd !== p.checkout) return { stdout: '' };
    if (command === 'git' && args[0] === 'rev-parse' && options.cwd !== p.checkout) return { stdout: `${FACTORY_REVISION}\n` };
    if (command === 'python3') return { stdout: '' };
    return w.run(command, args, options);
  };
  const said = [];
  const answers = ['Notes.', 'People.', '', 'yes'];
  await setupRepository(REPO, {
    config: { ...defaults(p.root), projectsRoot: join(p.root, 'projects') }, paths: { state: join(p.root, 'state') }, commands: { run },
    github: { appStatus: async () => 'installed', begin: async m => ({ url: `https://example.test/${m.name}` }), callback: async () => 'c', exchange: async () => ({ id: 1, pem: 'K', slug: 's' }), install: async () => true },
    prompt: async () => answers.shift(), output: line => said.push(line), factorySetup: createFactorySetup({ home: p.home })
  });
  const agentAt = order.indexOf('claude -p');
  assert(agentAt > 0 && order.indexOf('python3 factory/consumer.py') < agentAt, order.join(', '));
  assert(said.at(-1).startsWith('Setup is complete for owner/app.'));
  for (const message of [...said, ...Object.values(FACTORY_MESSAGES).map(m => (typeof m === 'function' ? m('Claude Code', 'https://github.com/o/r/pull/1') : m))]) {
    assert((message.match(/https?:\/\//g) ?? []).length <= 1, message);
    assert(!/[–—]/.test(message), message);
    assert(!/factory|archon|config|token/i.test(message), message);
  }
  assert(ReportedSetupError);
}
