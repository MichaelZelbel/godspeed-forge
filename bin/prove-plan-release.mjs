#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { planRelease } from '../lib/planner.mjs';
import { writePrivateJson } from '../lib/config.mjs';

const [directoryArgument, answer, ...extra] = process.argv.slice(2);
if (!directoryArgument || !['yes', 'no'].includes(answer) || extra.length) {
  throw new Error('Run prove-plan-release <empty working directory> <yes|no>.');
}

const root = resolve(directoryArgument);
const stateRoot = join(root, 'state');
const checkout = join(root, 'checkout');
const repositoryName = 'sample/project';
await mkdir(checkout, { recursive: true });
await writeFile(join(checkout, 'MISSION.md'), '# Mission\n\nHelp people keep their project work dependable.\n');
await writePrivateJson(join(stateRoot, 'projects', repositoryName, 'registration.json'), {
  repository: repositoryName, checkout, completed: true
});

const evidence = {
  viewer: 'owner', defaultBranch: 'main', latestRelease: { tag: 'v1.0.0', publishedAt: '2026-01-01' },
  commits: [], mergedPullRequests: [], pullRequests: [], checks: [],
  issues: [
    { id: 1, title: 'Saving can fail', body: 'A report explains that saving sometimes stops normal work.', labels: ['bug'], author: 'visitor', createdAt: '2026-01-02' },
    { id: 2, title: 'Opening can fail', body: 'A report explains that opening sometimes stops normal work.', labels: ['bug'], author: 'owner', createdAt: '2026-01-03' },
    { id: 3, title: 'Add a dashboard', body: 'A request asks for a dashboard in a later improvement.', labels: ['feature'], author: 'visitor', createdAt: '2026-01-04' }
  ]
};
const item = (key, source, title, problem, outcome) => ({
  key, title, problem, why: 'People need their everyday work to remain dependable.', whyNow: 'The failure affects people using the current version.', outcome,
  invariants: 'Working project actions remain available.', acceptance: 'A focused check proves the failure no longer interrupts work.',
  doneMeans: 'The repair works and the focused check passes.', size: 'light', dependencies: [],
  reason: 'Current user failures come before a new capability.', sources: [source]
});
const proposal = {
  summary: 'This release keeps everyday project work dependable.', version: '1.1.0',
  items: [
    item('issue-1', 'issue:1', 'Make saving dependable', 'People can lose progress when saving stops.', 'Saving keeps the person’s progress.'),
    item('issue-2', 'issue:2', 'Make opening dependable', 'People can be blocked when opening stops.', 'Opening reliably returns people to their work.')
  ],
  deferred: [{ title: 'A clearer project overview', reason: 'Current failures are repaired first.' }]
};

const issuePath = join(root, 'issues.json');
const issues = [];
const repository = {
  collect: async () => evidence,
  findIssueByMarker: async marker => issues.find(issue => issue.body.includes(`<!-- ${marker} -->`)) ?? null,
  createIssue: async value => {
    const issue = { ...value, number: issues.length + 1, url: `stand-in://issue/${issues.length + 1}` };
    issues.push(issue);
    await writeFile(issuePath, `${JSON.stringify(issues, null, 2)}\n`);
    return issue;
  }
};
const messages = [];
const result = await planRelease(repositoryName, {
  stateRoot, createRepository: () => repository,
  planWithAgent: async () => proposal,
  verifyWithAgent: async () => ({ items: proposal.items.map(value => ({ key: value.key, primarySource: value.sources[0], associated: true })) }),
  prompt: async () => answer,
  output: message => { messages.push(message); process.stdout.write(`${message}\n`); }
});
if (answer === 'no') await writeFile(issuePath, '[]\n');
process.stdout.write(`${JSON.stringify({ approved: result.approved, issueCount: issues.length, stateRoot })}\n`);

