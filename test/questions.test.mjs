import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatOwnerDecision, parseDecisionBlocks, runQuestionRelay } from '../lib/questions/relay.mjs';

const root = await mkdtemp(join(tmpdir(), 'forge-questions-'));
const project = join(root, 'projects/owner/repo');
await mkdir(project, { recursive: true });
await writeFile(join(project, 'registration.json'), JSON.stringify({ repository: 'owner/repo', completed: true }));
const issue = {
  number: 7,
  body: `### 1. Which greeting should people see?\n\nChoose Friendly or Formal.\n\n### 2. Which database library should we use?\n\nChoose A or B.`,
  comments: []
};
const notices = [];
const comments = [];
let messages = [];
const godspeed = {
  classify: async question => question.title.includes('greeting')
    ? { owner: true, example: 'A new visitor opens the welcome page.', choices: ['Friendly says “Welcome!”', 'Formal says “Good day.”'], default: 'Friendly', applies: 'to new visitors' }
    : { owner: false },
  notice: async notice => { if (!notices.some(item => item.id === notice.id)) notices.push(notice); },
  messages: async cursors => messages.filter(message => String(message.id) > String(cursors[message.source] ?? '')),
  match: async () => null
};
const github = {
  find: async () => issue,
  comment: async (repository, number, body) => { comments.push({ repository, number, body }); issue.comments.push({ body }); }
};

assert.equal(parseDecisionBlocks(issue.body).length, 2);
await runQuestionRelay({ stateRoot: root, github, godspeed });
assert.equal(notices.length, 1);
assert.equal(comments.length, 0);
assert.match(notices[0].text, /^A new visitor opens the welcome page\./);
assert.match(notices[0].text, /Choice 1: Friendly says “Welcome!”/);
assert.match(notices[0].text, /Default: Friendly/);
assert.match(notices[0].text, /Reply Q-[A-F0-9]{6}: followed by your answer\.$/);
assert(!/workflow|check|merge gate|judge|holdout/i.test(notices[0].text));
await runQuestionRelay({ stateRoot: root, github, godspeed });
assert.equal(notices.length, 1, 'a second lap must not repeat the question');

const handle = notices[0].text.match(/Q-[A-F0-9]{6}/)[0];
messages = [{ id: 1, source: 'browser', role: 'user', content: `${handle}: Use Friendly.` }];
await runQuestionRelay({ stateRoot: root, github, godspeed });
assert.deepEqual(comments, [{ repository: 'owner/repo', number: 7, body: formatOwnerDecision(`${handle}: Use Friendly.`) }]);
await runQuestionRelay({ stateRoot: root, github, godspeed });
assert.equal(comments.length, 1, 'a restart must not repeat the comment');

// A clear reply without a handle is accepted only when the model selects a supplied pending key.
const secondRoot = await mkdtemp(join(tmpdir(), 'forge-questions-match-'));
const secondProject = join(secondRoot, 'projects/owner/other');
await mkdir(secondProject, { recursive: true });
await writeFile(join(secondProject, 'registration.json'), JSON.stringify({ repository: 'owner/other', completed: true }));
const secondIssue = { ...issue, comments: [] };
const secondComments = [];
let pendingKey;
const matchingGodspeed = {
  ...godspeed,
  notice: async notice => { pendingKey = notice.id.replace('forge-question-', ''); },
  messages: async () => [{ id: 2, source: 'telegram', content: 'Please use Friendly.' }],
  match: async () => ({ key: pendingKey })
};
await runQuestionRelay({ stateRoot: secondRoot, github: {
  find: async () => secondIssue,
  comment: async (repository, number, body) => secondComments.push(body)
}, godspeed: matchingGodspeed });
assert.deepEqual(secondComments, [formatOwnerDecision('Please use Friendly.')]);

// Once the issue disappears, one plain notice is sent while a question is pending.
const goneRoot = await mkdtemp(join(tmpdir(), 'forge-questions-gone-'));
const goneProject = join(goneRoot, 'projects/owner/gone');
await mkdir(goneProject, { recursive: true });
await writeFile(join(goneProject, 'registration.json'), JSON.stringify({ repository: 'owner/gone', completed: true }));
let open = true;
const goneNotices = [];
await runQuestionRelay({ stateRoot: goneRoot, github: { find: async () => open ? issue : null }, godspeed: { ...godspeed, notice: async value => goneNotices.push(value), messages: async () => [] } });
open = false;
await runQuestionRelay({ stateRoot: goneRoot, github: { find: async () => null }, godspeed: { ...godspeed, notice: async value => goneNotices.push(value) } });
await runQuestionRelay({ stateRoot: goneRoot, github: { find: async () => null }, godspeed: { ...godspeed, notice: async value => goneNotices.push(value) } });
assert.equal(goneNotices.length, 2);

// An uncertain comment is not retried; an exact comment observed later reconciles the receipt.
const uncertainRoot = await mkdtemp(join(tmpdir(), 'forge-questions-uncertain-'));
const uncertainProject = join(uncertainRoot, 'projects/owner/uncertain');
await mkdir(uncertainProject, { recursive: true });
await writeFile(join(uncertainProject, 'registration.json'), JSON.stringify({ repository: 'owner/uncertain', completed: true }));
const uncertainIssue = { ...issue, comments: [] };
let uncertainHandle;
let attempts = 0;
const uncertainGodspeed = {
  ...godspeed,
  notice: async value => { uncertainHandle = value.text.match(/Q-[A-F0-9]{6}/)?.[0]; },
  messages: async cursors => cursors.browser ? [] : [{ id: 3, source: 'browser', content: `${uncertainHandle}: Friendly.` }]
};
await assert.rejects(runQuestionRelay({
  stateRoot: uncertainRoot,
  github: { find: async () => uncertainIssue, comment: async () => { attempts++; throw new Error('unknown result'); } },
  godspeed: uncertainGodspeed
}), /could not finish/);
const uncertainState = JSON.parse(await readFile(join(uncertainProject, 'questions.json'), 'utf8'));
const uncertainItem = Object.values(uncertainState.told)[0];
assert.equal(uncertainItem.status, 'needs_review');
uncertainIssue.comments.push({ body: uncertainItem.commentBody });
await runQuestionRelay({ stateRoot: uncertainRoot, github: { find: async () => uncertainIssue, comment: async () => { attempts++; } }, godspeed: uncertainGodspeed });
assert.equal(attempts, 1);
assert.equal(Object.values(JSON.parse(await readFile(join(uncertainProject, 'questions.json'), 'utf8')).told)[0].status, 'posted');

const saved = JSON.parse(await readFile(join(project, 'questions.json'), 'utf8'));
assert.equal(saved.told[Object.keys(saved.told)[0]].status, 'posted');
