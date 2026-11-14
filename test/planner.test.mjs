import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjects, releaseStatePath, writePrivateJson } from '../lib/config.mjs';
import { planRelease, renderOwnerMessage, validateProposal } from '../lib/planner.mjs';
import { createGithubRepository } from '../lib/github-repository.mjs';
import { createPlanningAgent } from '../lib/agent.mjs';
import { parseArguments } from '../bin/godspeed-forge.mjs';

const root = await mkdtemp(join(tmpdir(), 'forge-planner-'));
const state = join(root, 'state');
async function register(repository, completed = true) {
  const checkout = join(root, 'checkouts', repository);
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, 'MISSION.md'), '# Mission\n\nHelp teams ship dependable software.\n');
  await writePrivateJson(join(state, 'projects', repository, 'registration.json'), { repository, checkout, completed });
}
await register('one/shared');
await register('two/shared');
await register('one/unique');
await register('one/incomplete', false);
assert.deepEqual((await discoverProjects(state)).map(value => value.repository), ['one/shared', 'one/unique', 'two/shared']);
assert.throws(() => releaseStatePath(state, '../escape/repo', '1.0.0'), /invalid/);

const evidence = {
  viewer: 'owner', latestRelease: { tag: 'v1.0.0', publishedAt: '2026-01-01' }, commits: [{ title: 'Merged useful work' }],
  issues: [
    { id: 1, title: 'First bug', body: 'A report from somebody else with enough exact words to exercise copying detection safely.', labels: ['bug'], author: 'stranger' },
    { id: 2, title: 'Second bug', body: 'A different report from somebody else with enough exact words to exercise copying detection.', labels: ['bug'], author: 'owner' },
    { id: 3, title: 'Feature', body: 'People would like a useful improvement in the normal workflow when they use the product.', labels: ['feature'], author: 'stranger' }
  ],
  pullRequests: [{ id: 4, title: 'Open improvement', body: '', labels: [], author: 'owner' }],
  checks: [{ name: 'required', conclusion: 'failure' }]
};
const item = (key, title, outcome, size = 'light') => ({
  key, title, problem: `${title} causes a visible problem.`, why: 'People cannot complete their work.', whyNow: 'It blocks a dependable release.', outcome,
  invariants: 'Existing successful behavior remains available.', acceptance: 'A focused check proves the user outcome.', doneMeans: 'The outcome works and its focused check passes.',
  size, dependencies: [], reason: 'This is the next most useful improvement.', sources: [`issue:${key === 'issue-2' ? 2 : key === 'issue-3' ? 3 : 1}`]
});
const proposal = {
  summary: 'This release makes everyday work more dependable.', version: '1.1.0',
  items: [item('issue-1', 'Repair first failure', 'The first failure no longer interrupts work.'), item('issue-2', 'Repair second failure', 'The second failure no longer interrupts work.')],
  deferred: [{ title: 'A useful improvement', reason: 'The two repairs come first.' }]
};
assert.deepEqual(validateProposal(proposal, evidence), proposal);
assert.throws(() => validateProposal({ ...proposal, items: [{ ...proposal.items[0], key: '../../outside' }] }, evidence), /incomplete item/);
assert.throws(() => validateProposal({ ...proposal, items: [item('issue-1', 'Large', 'A large change works.', 'large'), item('issue-2', 'More', 'More works.')] }, evidence), /too large/);
assert.throws(() => validateProposal({ ...proposal, items: [{ ...proposal.items[0], problem: evidence.issues[0].body }] }, evidence), /copied/);
assert.throws(() => validateProposal({ ...proposal, items: [{ ...proposal.items[0], reason: evidence.issues[0].body }] }, evidence), /copied/);
const shortEvidence = structuredClone(evidence);
shortEvidence.issues[0].body = 'Short copied words';
assert.throws(() => validateProposal({ ...proposal, items: [{ ...proposal.items[0], reason: 'Short copied words' }] }, shortEvidence), /copied/);
shortEvidence.issues[0].title = 'Crash';
assert.throws(() => validateProposal({ ...proposal, items: [{ ...proposal.items[0], reason: 'Crash' }] }, shortEvidence), /copied/);
shortEvidence.issues[0].title = '';
shortEvidence.issues[0].body = 'Freeze';
assert.throws(() => validateProposal({ ...proposal, items: [{ ...proposal.items[0], problem: 'Freeze' }] }, shortEvidence), /copied/);
const featureFirst = { ...proposal, items: [item('issue-3', 'Add requested capability', 'A requested capability works.'), proposal.items[0], proposal.items[1]] };
assert.throws(() => validateProposal(featureFirst, evidence), /urgent work first/);
const swappedSources = { ...proposal, items: [{ ...item('issue-3', 'Add requested capability', 'A requested capability works.'), sources: ['issue:1'] }, { ...item('issue-1', 'Repair failure', 'The failure is repaired.'), sources: ['issue:3'] }] };
assert.throws(() => validateProposal(swappedSources, evidence), /incomplete item/);
const bugsBeforeFeature = { ...proposal, items: [proposal.items[0], proposal.items[1], item('issue-3', 'Add requested capability', 'A requested capability works.')] };
assert.deepEqual(validateProposal(bugsBeforeFeature, evidence).items.map(value => value.key), ['issue-1', 'issue-2', 'issue-3']);
const message = renderOwnerMessage(proposal);
assert(message.endsWith('Shall I start it?'));
assert.match(message, /Cost: about half/);
assert.match(message, /Version: 1\.1\.0/);
for (const forbidden of ['#1', '.mjs', 'script', 'ticket']) assert(!message.toLowerCase().includes(forbidden));
assert.throws(() => renderOwnerMessage({ ...proposal, summary: 'Run a script.' }), /internal details/);
assert.throws(() => renderOwnerMessage({ ...proposal, summary: 'This fixes issue 123.' }), /internal details/);

const created = [];
const outputs = [];
const repository = {
  collect: async () => structuredClone(evidence),
  findIssueByMarker: async () => null,
  createIssue: async value => { created.push(value); return { number: created.length + 10, url: `https://example.test/${created.length + 10}` }; }
};
let selected;
await planRelease('unique', { stateRoot: state, prompt: async () => 'no', output: () => {}, createRepository: name => { selected = name; return repository; }, planWithAgent: async () => proposal });
assert.equal(selected, 'one/unique');
let selectionAnswers = ['two/shared', 'no'];
await planRelease('shared', { stateRoot: state, prompt: async () => selectionAnswers.shift(), output: () => {}, createRepository: name => { selected = name; return repository; }, planWithAgent: async () => proposal });
assert.equal(selected, 'two/shared');
selectionAnswers = ['one/unique', 'no'];
await planRelease('missing', { stateRoot: state, prompt: async () => selectionAnswers.shift(), output: () => {}, createRepository: name => { selected = name; return repository; }, planWithAgent: async () => proposal });
assert.equal(selected, 'one/unique');
await assert.rejects(planRelease(undefined, { stateRoot: join(root, 'empty-state'), prompt: async () => '', output: () => {}, createRepository: () => repository, planWithAgent: async () => proposal }), /Set up a project/);
let answers = ['one/shared', 'make the wording warmer', 'yes'];
let agentCalls = 0;
const approved = await planRelease(undefined, {
  stateRoot: state, prompt: async () => answers.shift(), output: value => outputs.push(value),
  createRepository: () => repository, planWithAgent: async ({ prompt }) => { agentCalls++; if (agentCalls === 2) assert.match(prompt, /make the wording warmer/); return proposal; }
});
assert.equal(approved.approved, true);
assert.equal(agentCalls, 2);
assert.equal(created.length, 2);
assert(created[0].body.includes('## Problem'));
for (const heading of ['Why', 'Why now', 'Outcome', 'Invariants', 'Acceptance', 'Done means', 'Size', 'Dependencies', 'Reason']) assert(created[0].body.includes(`## ${heading}`));
const releaseDirectory = releaseStatePath(state, 'one/shared', '1.1.0');
const plan = JSON.parse(await readFile(join(releaseDirectory, 'plan.json'), 'utf8'));
assert.equal(plan.status, 'approved');
assert.deepEqual(Object.keys(plan.issues), ['issue-1', 'issue-2']);
assert.deepEqual(plan.evidence.issues, [1, 2, 3]);
for (const path of [join(releaseDirectory, 'plan.json'), join(releaseDirectory, 'item-issue-1.json')]) assert.equal((await stat(path)).mode & 0o777, 0o600);

await register('one/no');
answers = ['no'];
const beforeNo = created.length;
assert.equal((await planRelease('one/no', { stateRoot: state, prompt: async () => answers.shift(), output: () => {}, createRepository: () => repository, planWithAgent: async () => ({ ...proposal, version: '2.0.0' }) })).approved, false);
assert.equal(created.length, beforeNo);
await assert.rejects(stat(releaseStatePath(state, 'one/no', '2.0.0')));

await register('one/revised-no');
answers = ['change the wording', 'no'];
const beforeRevisedNo = created.length;
assert.equal((await planRelease('one/revised-no', { stateRoot: state, prompt: async () => answers.shift(), output: () => {}, createRepository: () => repository, planWithAgent: async () => ({ ...proposal, version: '2.1.0' }) })).approved, false);
assert.equal(created.length, beforeRevisedNo);
await assert.rejects(stat(releaseStatePath(state, 'one/revised-no', '2.1.0')));

await register('one/agent-failure');
const failureMessages = [];
const failed = await planRelease('one/agent-failure', { stateRoot: state, prompt: async () => { throw new Error('must not prompt'); }, output: value => failureMessages.push(value), createRepository: () => repository, planWithAgent: async () => { throw new Error('private agent detail'); } });
assert.deepEqual(failed, { approved: false, reason: 'agent' });
assert.deepEqual(failureMessages, ['I could not prepare a safe release plan. Nothing was created; please try again.']);

await register('one/resume');
const resumable = { ...proposal, version: '3.0.0' };
let attempts = 0;
const flaky = { collect: repository.collect, findIssueByMarker: async () => null, createIssue: async value => { attempts++; if (attempts === 2) throw new Error('temporary failure'); return { number: 30, url: 'https://example.test/30', value }; } };
await assert.rejects(planRelease('one/resume', { stateRoot: state, prompt: async () => 'yes', output: () => {}, createRepository: () => flaky, planWithAgent: async () => resumable }), /temporary/);
assert.equal(JSON.parse(await readFile(join(releaseStatePath(state, 'one/resume', '3.0.0'), 'plan.json'), 'utf8')).status, 'filing');
await planRelease('one/resume', { stateRoot: state, prompt: async () => 'yes', output: () => {}, createRepository: () => flaky, planWithAgent: async () => resumable });
assert.equal(attempts, 3);
await assert.rejects(planRelease('one/resume', { stateRoot: state, prompt: async () => 'yes', output: () => {}, createRepository: () => flaky, planWithAgent: async () => resumable }), /already approved/);

await register('one/ambiguous');
const ambiguousProposal = { ...proposal, version: '3.1.0', items: [proposal.items[0]] };
let remoteIssue;
const ambiguous = {
  collect: repository.collect,
  findIssueByMarker: async marker => remoteIssue?.body.includes(marker) ? { number: 41, url: 'https://example.test/41' } : null,
  createIssue: async value => { remoteIssue = value; throw new Error('response lost'); }
};
await assert.rejects(planRelease('one/ambiguous', { stateRoot: state, prompt: async () => 'yes', output: () => {}, createRepository: () => ambiguous, planWithAgent: async () => ambiguousProposal }), /response lost/);
await planRelease('one/ambiguous', { stateRoot: state, prompt: async () => 'yes', output: () => {}, createRepository: () => ambiguous, planWithAgent: async () => ambiguousProposal });
assert.equal(JSON.parse(await readFile(join(releaseStatePath(state, 'one/ambiguous', '3.1.0'), 'plan.json'), 'utf8')).issues['issue-1'].number, 41);

const apiCalls = [];
const responses = new Map([
  ['/user', { login: 'owner' }], ['/repos/acme/app', { default_branch: 'main' }], ['/repos/acme/app/releases?per_page=100', [{ tag_name: 'draft', draft: true }, { tag_name: 'v1.0.0', published_at: '2026-01-01' }]],
  ['/repos/acme/app/issues?state=open&per_page=100', [{ number: 1, title: 'Bug', body: 'Body', labels: [{ name: 'bug' }], created_at: '2026-02-01', user: { login: 'other' } }]],
  ['/repos/acme/app/pulls?state=open&per_page=100', []], ['/repos/acme/app/pulls?state=closed&sort=updated&direction=desc&per_page=100', [{ number: 5, title: 'Merged', merged_at: '2026-02-01', user: { login: 'owner' } }]],
  ['/repos/acme/app/actions/workflows?per_page=100', { workflows: [{ name: 'old', state: 'disabled_manually' }] }], ['/repos/acme/app/commits?sha=main&since=2026-01-01', []],
  ['/repos/acme/app/actions/runs?branch=main&per_page=100', { workflow_runs: [{ name: 'required', status: 'completed', conclusion: 'failure' }] }]
]);
const adapter = createGithubRepository({ repository: 'acme/app', runCommand: async (_command, args) => {
  apiCalls.push(args);
  if (args.includes('POST')) return { stdout: JSON.stringify({ number: 73, html_url: 'https://example.test/73' }) };
  const path = args.find(value => value.startsWith('/'));
  return { stdout: JSON.stringify([responses.get(path)]) };
} });
const collected = await adapter.collect();
assert.equal(collected.issues[0].labels[0], 'bug');
assert.equal(collected.checks[0].conclusion, 'failure');
assert.equal(collected.checks[1].conclusion, 'disabled');
assert.equal(collected.mergedPullRequests[0].id, 5);
assert(apiCalls.some(args => args.some(value => value.includes('/commits?'))));
const createdByAdapter = await adapter.createIssue({ title: 'A title', body: 'A body' });
const createCall = apiCalls.at(-1);
assert(createCall.includes('/repos/acme/app/issues'));
assert(createCall.includes('POST'));
assert(createCall.includes('title=A title'));
assert(createCall.includes('body=A body'));
assert.deepEqual(createdByAdapter, { number: 73, url: 'https://example.test/73' });
responses.set('/repos/acme/app/issues?state=all&per_page=100', [{ number: 74, html_url: 'https://example.test/74', body: 'Filed work\n\n<!-- durable-marker -->' }]);
assert.deepEqual(await adapter.findIssueByMarker('durable-marker'), { number: 74, url: 'https://example.test/74' });
const lookupCall = apiCalls.at(-1);
assert(lookupCall.includes('/repos/acme/app/issues?state=all&per_page=100'));

let schemaWasReadable = false;
const codexPlanner = createPlanningAgent({ agent: 'codex', runCommand: async (_command, args) => {
  const schemaPath = args[args.indexOf('--output-schema') + 1];
  schemaWasReadable = JSON.parse(await readFile(schemaPath, 'utf8')).type === 'object';
  assert(args.includes('--ephemeral'));
  assert(args.includes('read-only'));
  return { stdout: JSON.stringify(proposal) };
} });
assert.deepEqual(await codexPlanner({ schema: { type: 'object' }, prompt: 'Plan.' }), proposal);
assert(schemaWasReadable);
const claudePlanner = createPlanningAgent({ agent: 'claude', runCommand: async (_command, args) => {
  assert(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  return { stdout: JSON.stringify({ structured_output: proposal }) };
} });
assert.deepEqual(await claudePlanner({ schema: { type: 'object' }, prompt: 'Plan.' }), proposal);
assert.deepEqual(parseArguments(['setup', 'owner/repo']), { command: 'setup', repository: 'owner/repo' });
assert.deepEqual(parseArguments(['plan']), { command: 'plan', repository: undefined });
assert.throws(() => parseArguments(['setup']), /setup owner\/repository/);
