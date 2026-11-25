// The driver's two owner steps (driver/steps/owner-questions.mjs, driver/steps/owner-releases.mjs), with a stand-in
// GitHub on 127.0.0.1, a stand-in bridge to Godspeed, a stand-in coding agent, project checkouts with an origin on
// this machine and a stand-in factory/consumer.py. The acceptance of tickets 03 (questions reach the chat) and 04
// (a finished release stages itself) of the Forge 0.1.0 plan, and ticket 02's facts. No network, no AI.
// test cases: 19
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCase } from './cases.mjs';
import { fakeGithub, standInBridge, setUpProject, projectCheckout, standInGh, tmpDir, assertPlain } from './forge-owner-fakes.mjs';
import * as questionsStep from '../driver/steps/owner-questions.mjs';
import * as releasesStep from '../driver/steps/owner-releases.mjs';
import { plan, go, status } from '../lib/owner/releases.mjs';
import { answer } from '../lib/owner/questions.mjs';
import { releaseRecord, saveRelease, readQuestions, factsFile, WAITING_FILE } from '../driver/steps/owner/records.mjs';
import { loadSettings, CORE } from '../driver/settings.mjs';

const gh = await fakeGithub();
const root = tmpDir('forge-steps-');
const state = path.join(root, 'state');
const REPO = 'acme/my-app', SIDE = 'acme/side';
const appApps = setUpProject(state, gh, REPO);
setUpProject(state, gh, SIDE);
// the gh sign-in the factory runs as (its login is the-owner): a project's questions issue opened by it is trusted
const factoryGh = standInGh(gh);
const bridge = standInBridge();
const T = Date.parse('2026-11-22T10:00:00Z');
const agentCalls = [];
const agent = async prompt => {
  agentCalls.push(prompt);
  if (prompt.includes('welcome screen')) return 'Here it is: {"for": "owner", "question": "Should the first screen greet new people by their name?", "example": "When you open the app for the first time, it only says Welcome.", "choices": ["It greets you by your name.", "It keeps the plain welcome."]}';
  if (prompt.includes('in a database')) return '{"for": "factory"}';
  if (prompt.includes('one zip')) return '{"for": "owner", "question": "Should a download come as one file?", "example": "When you download your photos, you get each one on its own.", "choices": ["You get one file with all of them.", "You keep getting each one on its own."]}';
  return 'I am not sure.';
};
const settings = (over = {}) => ({
  owner: { github_login: 'the-owner' },
  server: { factory_user: 'factory', factory_home: path.join(root, 'home'), work_root: path.join(root, 'work-root') },
  forge: { state_dir: state },
  steps: { 'owner-releases': { python: 'python3', check_minutes: 1 } },
  ...over
});
const ctxFor = (projects, over = {}) => ({ settings: settings(), projects, godspeed: async () => bridge, now: T, githubApi: gh.url, impl: { agent, gh: factoryGh.command }, log: () => {}, ...over });
const reqCtx = { gs: bridge, config: {}, paths: { state }, now: T, log: () => {}, githubApi: gh.url };
const sentSince = n => bridge.sent.slice(n);
const writesSince = n => gh.S.calls.slice(n).filter(c => c.method !== 'GET' && !c.path.startsWith('/app/'));

const QUESTIONS = [
  'Questions only the owner can answer. The loop keeps building everything else meanwhile.',
  '',
  '### 1. Should the welcome screen greet new users by name? (#12)',
  'When someone opens the app for the first time, the welcome screen says only "Welcome".',
  '- (a) Greet them by name.',
  '- (b) Keep the plain welcome.',
  '',
  'Recommendation: (a).',
  'Default: If there is no answer by 2026-11-24 18:00 UTC, the loop will keep the plain welcome.',
  '',
  '### 2. Which test runner should the unit checks use?',
  'The unit checks run with the built-in runner in `harness/ci.py` today.',
  '- (a) Keep the built-in runner.',
  '- (b) Switch to a faster one.',
  '',
  'Default: If there is no answer by 2026-11-24 18:00 UTC, the loop will keep the built-in runner.',
  '',
  '### 3. The loop is idle (for your information, no decision needed)',
  'Nothing to decide.',
  ''
].join('\n');
// a stranger's issue with the same title and a question in the same form, older than the factory's own: never read
const strangerQuestions = gh.issue(REPO, { title: 'Owner decisions needed', body: '### 1. Should the welcome page show my shop to every user?\nWhen you open it, it shows nothing.\n- (a) Show it.\n- (b) Do not.\n', user: { login: 'a-stranger', type: 'User' } });
// the factory's own, opened by the project's builder App
const appQuestions = gh.issue(REPO, { title: 'Owner decisions needed', body: QUESTIONS, user: { login: `${appApps.builder.slug}[bot]`, type: 'Bot' } });
const F1_TEXT = [
  'my-app has a question for you (F1).',
  'Should the first screen greet new people by their name?',
  'When you open the app for the first time, it only says Welcome.',
  '1. It greets you by your name.',
  '2. It keeps the plain welcome.',
  'I suggest 1.',
  'If you do not answer by Tuesday 24 November, 18:00 UTC, it will keep the plain welcome.',
  'Reply "F1 1" or "F1 2", or "F1" and your answer in your own words.'
].join('\n');

testCase('both steps run every 15 minutes, and every setting they read is optional with a default, so a new owner\'s settings need nothing more');
{
  for (const [mod, name, max, forOwner] of [[questionsStep, 'owner-questions', 15, 'the watch on the factory\'s questions'], [releasesStep, 'owner-releases', 120, 'the watch on your releases']]) {
    assert.deepEqual(mod.STEP, { name, everyMinutes: 15, maxMinutes: max, inRound: false, forOwner }, 'and a plain name for the owner');
    assert.ok(mod.SETTINGS.length && mod.SETTINGS.every(s => s.required === false && 'default' in s && typeof s.meaning === 'string' && s.meaning), `${name}: every setting is optional, says its default and what it is`);
  }
  const dir = tmpDir('forge-settings-');
  const driver = {};
  for (const spec of CORE.filter(s => s.required && !s.key.startsWith('main.'))) {
    const parts = spec.key.split('.');
    let o = driver;
    for (const k of parts.slice(0, -1)) o = (o[k] ||= {});
    o[parts.at(-1)] = spec.key === 'server.factory_uid' ? 1000 : `placeholder-${parts.at(-1)}`;
  }
  driver.steps = { 'owner-questions': { enabled: true }, 'owner-releases': { enabled: true } };
  fs.writeFileSync(path.join(dir, 'driver.json'), JSON.stringify(driver));
  fs.mkdirSync(path.join(dir, 'projects'));
  fs.writeFileSync(path.join(dir, 'projects', 'acme--my-app.json'), JSON.stringify({ repository: REPO, checkout: '/srv/factory/my-app', apps: { builder: 'b', release: 'r' } }));
  const steps = [questionsStep, releasesStep].map(m => ({ name: m.STEP.name, SETTINGS: m.SETTINGS }));
  assert.doesNotThrow(() => loadSettings(dir, { steps }), 'the two steps ask for nothing a new owner\'s settings lack');
}

testCase('an issue with a question of what and one of how gives exactly one message, for the question of what, with an example, the choices, the default, a handle and the reply words');
{
  const n = bridge.sent.length, w = gh.S.calls.length;
  const r = await questionsStep.run(ctxFor([{ repository: REPO }]));
  assert.equal(r.ok, true, r.error);
  const sent = sentSince(n);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, F1_TEXT);
  assertPlain(assert, sent[0].text);
  assert.equal(agentCalls.length, 1, 'the agent is asked once, for the words of the owner\'s question, and never about the question of how');
  assert.deepEqual(writesSince(w), [], 'GitHub is only read');
  assert.deepEqual(bridge.json(WAITING_FILE).items, [{ handle: 'F1', kind: 'question', project: REPO, text: 'my-app: Should the first screen greet new people by their name?' }]);
  const q = readQuestions(state);
  assert.deepEqual(q.questions.map(x => [x.number, x.status, x.handle || null]), [[1, 'told', 'F1'], [2, 'kept', null]]);
}

testCase('running the step again tells nothing new');
{
  const n = bridge.sent.length, calls = agentCalls.length;
  assert.equal((await questionsStep.run(ctxFor([{ repository: REPO }]))).ok, true);
  assert.deepEqual(sentSince(n), []);
  assert.equal(agentCalls.length, calls, 'and asks the agent nothing');
}

testCase('an unclear question goes to the agent once a run: one of how stays with the factory, one of what is told in the agent\'s words, and one the agent cannot judge is never put to the owner, and nothing is said about it');
{
  const body = [
    '### 1. Should the sign-in page keep its tokens in a database?',
    'People sign in on the page; the tokens are kept in memory today.',
    '- (a) Keep them in a database.',
    '- (b) Keep them in memory.',
    '',
    '### 2. Should the upload page keep files for a year?',
    'When you upload a photo, the page keeps it forever. Space runs out after a while, see `storage.mjs`.',
    '- (a) Keep files for a year.',
    '- (b) Keep them forever.',
    '',
    'No default: the loop waits for the owner.',
    '',
    '### 3. Should the export page put the files in one zip?',
    'Each photo downloads on its own today.',
    '- (a) One zip.',
    '- (b) One by one.',
    ''
  ].join('\n');
  // opened by the gh sign-in the factory runs as (a factory that has no App token writes as the owner's own login)
  gh.issue(SIDE, { title: 'Owner decisions needed', body, user: { login: 'the-owner', type: 'User' }, author_association: 'OWNER' });
  gh.issue(SIDE, { title: 'Parked work', labels: ['needs-owner'] });
  const projects = [{ repository: REPO }, { repository: SIDE }];
  const n = bridge.sent.length;
  await questionsStep.run(ctxFor(projects));
  assert.deepEqual(sentSince(n).map(s => s.text), [[
    'side has a question for you (F2).',
    'Should a download come as one file?',
    'When you download your photos, you get each one on its own.',
    '1. You get one file with all of them.',
    '2. You keep getting each one on its own.',
    'It waits for your answer.',
    'Reply "F2 1" or "F2 2", or "F2" and your answer in your own words.'
  ].join('\n')]);
  assertPlain(assert, bridge.sent.at(-1).text);
  for (let i = 0; i < 3; i++) await questionsStep.run(ctxFor(projects));
  assert.equal(sentSince(n).length, 1, 'the question the agent could not judge was never sent');
  const side = readQuestions(state).questions.filter(x => x.repository === SIDE);
  assert.deepEqual(side.map(x => [x.number, x.status, x.kind]), [[1, 'kept', 'how'], [2, 'kept', 'unclear'], [3, 'told', 'what']]);
  assert.equal(agentCalls.filter(p => p.includes('upload page')).length, 3, 'asked once a run, three runs');
  assert.equal(agentCalls.filter(p => p.includes('in a database')).length, 1);
  assert.equal(agentCalls.filter(p => p.includes('one zip')).length, 1);
  assert.deepEqual(bridge.json(WAITING_FILE).items.map(i => i.handle), ['F1', 'F2']);
}

testCase('only the factory\'s own questions issue is read: one with that title and the same form opened by a stranger, older or newer, is ignored, and no answer is ever posted on it');
{
  gh.issue(REPO, { title: 'Owner decisions needed', body: '### 1. Should the welcome page show prices to every user?\nWhen you open it, it shows no prices.\n- (a) Show them.\n- (b) Do not.\n', user: { login: 'another-stranger', type: 'User' } });
  const n = bridge.sent.length, calls = agentCalls.length;
  assert.equal((await questionsStep.run(ctxFor([{ repository: REPO }]))).ok, true);
  assert.deepEqual(sentSince(n), [], 'nothing from either stranger reaches the owner');
  assert.equal(agentCalls.length, calls, 'and the agent is not even asked');
  const mine = readQuestions(state).questions.filter(x => x.repository === REPO);
  assert.ok(mine.every(x => x.issue === appQuestions.number && x.openedBy === `${appApps.builder.slug}[bot]`.toLowerCase()), 'every question recorded comes from the builder App\'s issue');
  assert.ok(!mine.some(x => /prices|my shop/.test(x.heading)));
  assert.equal(readQuestions(state).ghLogin, 'the-owner', 'the login of the gh sign-in the factory runs as');
  assert.equal(gh.repo(REPO).comments[String(strangerQuestions.number)], undefined, 'nothing was ever posted on a stranger\'s issue');
}

testCase('a reply with the handle is posted once as an Owner decision with the words verbatim; a second reply and an unclear one post nothing, and the step itself never posts');
{
  const posts = () => gh.S.calls.filter(c => c.method === 'POST' && c.path === `/repos/acme/my-app/issues/${appQuestions.number}/comments`).length;
  const r = await answer({ id: 'a1', kind: 'answer', handle: 'F1', words: 'F1 1, and use the name they signed up with.', at: '2026-11-22T10:20:00Z' }, reqCtx);
  assert.deepEqual(r, { ok: true, say: 'Your answer to F1 is passed on to the my-app factory.' });
  const comment = gh.repo(REPO).comments[String(appQuestions.number)][0].body;
  assert.ok(comment.startsWith('Owner decision (question 1: Should the welcome screen greet new users by name? (#12))\n\n> F1 1, and use the name they signed up with.\n\n'), comment);
  assert.ok(!comment.includes('picked option'), 'words beyond a bare choice are left as they are');
  await questionsStep.run(ctxFor([{ repository: REPO }]));
  assert.equal(posts(), 1);
  assert.equal((await answer({ id: 'a2', kind: 'answer', handle: 'F1', words: 'F1 2' }, reqCtx)).ok, false);
  assert.equal((await answer({ id: 'a3', kind: 'answer', words: 'sounds good' }, reqCtx)).ok, false);
  assert.equal(posts(), 1, 'posted once, also after a second and an unclear reply');
}

testCase('the step says once when the questions issue disappears while the factory waits for the owner');
{
  const sideIssue = gh.repo(SIDE).issues.find(i => i.title === 'Owner decisions needed');
  sideIssue.state = 'closed';
  const n = bridge.sent.length;
  await questionsStep.run(ctxFor([{ repository: SIDE }]));
  await questionsStep.run(ctxFor([{ repository: SIDE }]));
  assert.deepEqual(sentSince(n).map(s => s.text), ['The side factory is waiting for a decision from you, but its list of questions for you is gone, so I cannot pass the question on. I will tell you as soon as it asks again.']);
  assertPlain(assert, bridge.sent.at(-1).text);
  assert.equal(readQuestions(state).questions.find(x => x.handle === 'F2').status, 'withdrawn');
  assert.deepEqual(bridge.json(WAITING_FILE).items, [], 'nothing waits on the owner any more');
  // the list comes back, and goes again while the factory still waits: said once more, under its own message id
  sideIssue.state = 'open';
  await questionsStep.run(ctxFor([{ repository: SIDE }]));
  assert.equal(sentSince(n).length, 1, 'nothing is said when it comes back');
  sideIssue.state = 'closed';
  await questionsStep.run(ctxFor([{ repository: SIDE }]));
  await questionsStep.run(ctxFor([{ repository: SIDE }]));
  const gone = sentSince(n);
  assert.equal(gone.length, 2, 'the second disappearance reached the owner through a bridge that says each id once');
  assert.equal(gone[1].text, gone[0].text);
  assert.notEqual(gone[1].id, gone[0].id);
  assert.equal(bridge.attempts.filter(a => a.text === gone[0].text).length, 2, 'and nothing was sent a third time');
}

testCase('a question already decided on GitHub is never sent and one sent is withdrawn; a technical question is never sent and a product question is');
{
  const DEC = 'acme/decided';
  const decApps = setUpProject(state, gh, DEC);
  const bot = `${decApps.builder.slug}[bot]`;
  const body = [
    '### 1. Should the welcome screen show a tour? (#21)', 'When you open it, there is no tour.', '- (a) Show it.', '- (b) Do not.', 'Recommendation: (b).', '',
    '### 2. Should the welcome screen say good morning? (#22)', 'When you open it, it says hello.', '- (a) Say it.', '- (b) Keep hello.', '',
    '### 3. Should the welcome screen use the owner answer? (#23)', 'When you open it, it says hello.', '- (a) Yes.', '- (b) No.', '',
    '### 4. Which test runner should the unit checks use?', 'The unit checks use the built-in runner.', '- (a) Keep it.', '- (b) Switch.', '',
  ].join('\n');
  const issue = gh.issue(DEC, { title: 'Owner decisions needed', body, user: { login: bot, type: 'Bot' } });
  const comments = gh.repo(DEC).comments[String(issue.number)] = [
    { id: 1, body: 'Manager decision (Mission Control, not Michael) (question 1: Should the welcome screen show a tour?)\n\nNo tour.', user: { login: bot } },
    { id: 2, body: 'Owner decision (question 3: Should the welcome screen use the owner answer?)\n\n> yes', user: { login: 'the-owner' } },
  ];
  const n = bridge.sent.length;
  assert.equal((await questionsStep.run(ctxFor([{ repository: DEC }]))).ok, true);
  const sent = sentSince(n);
  assert.equal(sent.length, 1, 'only the undecided product question is sent');
  assert.ok(sent[0].text.includes('good morning') || sent[0].text.includes('question for you'), sent[0].text);
  const recs = readQuestions(state).questions.filter(x => x.repository === DEC);
  assert.deepEqual(recs.map(x => [x.number, x.status]), [[1, 'answered-elsewhere'], [2, 'told'], [3, 'answered-elsewhere'], [4, 'kept']]);
  // question 2 is decided afterwards: it is withdrawn and the owner is told once
  comments.push({ id: 3, body: 'Manager decision (Mission Control, not Michael): question 2: keep hello.', user: { login: bot } });
  await questionsStep.run(ctxFor([{ repository: DEC }]));
  await questionsStep.run(ctxFor([{ repository: DEC }]));
  const after = sentSince(n);
  assert.equal(after.length, 2);
  assert.equal(after[1].text, `decided no longer needs your answer to ${recs[1].handle}: it was already decided, so you can leave it.`);
  assertPlain(assert, after[1].text);
  assert.equal(readQuestions(state).questions.find(x => x.repository === DEC && x.number === 2).status, 'withdrawn');
  assert.ok(!bridge.json(WAITING_FILE).items.some(i => i.project === DEC));
}

testCase('a project the Forge has not set up, or without App details here, is skipped quietly, and the older questions step keeps its projects to itself');
{
  setUpProject(state, gh, 'acme/no-keys');
  fs.rmSync(path.join(state, 'credentials', 'acme', 'no-keys'), { recursive: true, force: true });
  const n = bridge.sent.length, calls = gh.S.calls.length;
  const r = await questionsStep.run(ctxFor([{ repository: 'acme/never-set-up' }, { repository: 'acme/no-keys' }]));
  assert.equal(r.ok, true);
  assert.match(r.summary, /skipped \(no App details\): acme\/no-keys/);
  const rr = await releasesStep.run(ctxFor([{ repository: 'acme/no-keys' }]));
  assert.equal(rr.ok, true);
  const older = await questionsStep.run({ ...ctxFor([{ repository: REPO }]), settings: settings({ steps: { questions: { godspeed_dir: '/srv/godspeed' } } }) });
  assert.equal(older.ok, true);
  assert.match(older.summary, /the questions step answers/);
  assert.deepEqual(sentSince(n), []);
  assert.equal(gh.S.calls.slice(calls).filter(c => !c.path.startsWith('/app/') && !c.path.endsWith('/installation')).length, 0, 'GitHub was not asked about any of them');
  const none = await releasesStep.run(ctxFor([]));
  assert.deepEqual(none, { ok: true, summary: 'owner-releases: no project here is set up with the Forge' });
}

// ---------------------------------------------------------------- releases
const co = projectCheckout(path.join(root, 'app'), { unit: 'echo "3 of 3 pass"' });
const appProject = { repository: REPO, checkout: co.checkout };
const appRepo = gh.repo(REPO);
const DAY = 24 * 3600 * 1000;

testCase('the facts list the newest public release, what merged since, the open work with labels, age and author (bug reports first), the failing checks and what waits; reading files nothing until the yes');
{
  appRepo.refs['tags/v1.2.0'] = co.first;
  appRepo.releases.push({ id: 900, tag_name: 'v1.2.0', name: '1.2.0', body: '', prerelease: false, draft: false, html_url: 'https://github.example/acme/my-app/releases/900', published_at: '2026-11-01T00:00:00Z' });
  appRepo.latestId = 900;
  gh.issue(REPO, { title: 'Add a dark mode', labels: ['enhancement'], user: { login: 'the-owner', type: 'User' }, author_association: 'OWNER', created_at: new Date(T - 20 * DAY).toISOString() });
  gh.issue(REPO, { title: 'Sign-in forgets me', labels: ['bug'], created_at: new Date(T - 5 * DAY).toISOString() });
  gh.issue(REPO, { title: 'The list crashes when empty', labels: ['bug'], created_at: new Date(T - 2 * DAY).toISOString() });
  appRepo.pulls.push({ number: 90, title: 'Tidy the list', body: '', state: 'closed', merged_at: '2026-11-10T00:00:00Z', merge_commit_sha: co.first, base: { ref: 'main' }, user: { login: 'forge-builder[bot]', type: 'Bot' }, created_at: '2026-11-09T00:00:00Z' });
  appRepo.pulls.push({ number: 91, title: 'Try a new sort', body: '', state: 'open', base: { ref: 'main' }, labels: [{ name: 'needs-owner' }], user: { login: 'stranger', type: 'User' }, author_association: 'NONE', created_at: new Date(T - DAY).toISOString() });
  appRepo.checkRuns.push({ name: 'required', conclusion: 'failure' }, { name: 'lint', conclusion: 'success' });
  const w = gh.S.calls.length;
  const r = await releasesStep.run(ctxFor([appProject]));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(writesSince(w), [], 'reading the project files nothing');
  const facts = bridge.json(factsFile(REPO));
  assert.deepEqual(facts.newestPublicRelease, { version: '1.2.0', tag: 'v1.2.0', name: '1.2.0', publishedAt: '2026-11-01T00:00:00Z', url: 'https://github.example/acme/my-app/releases/900' });
  assert.deepEqual(facts.openIssues.map(i => [i.title, i.labels, i.author, i.ageDays]), [
    ['Sign-in forgets me', ['bug'], 'stranger', 5],
    ['The list crashes when empty', ['bug'], 'stranger', 2],
    ['Add a dark mode', ['enhancement'], 'owner', 20]
  ], 'the two bug reports come before the feature request, and the questions issue is not work');
  assert.deepEqual(facts.openPullRequests.map(p => [p.title, p.labels, p.author]), [['Try a new sort', ['needs-owner'], 'stranger']]);
  assert.deepEqual(facts.mergedSince.map(p => p.title), ['Tidy the list']);
  assert.deepEqual(facts.failingChecksOnMain, ['required']);
  assert.equal(facts.status, 'public', 'nothing is being built or waits for the owner, and a version is public');
  assert.equal(facts.release, null);
}

testCase('a release with one item still open does nothing; once it closes with a merged pull request it is frozen on that merge, checked, put up to try and announced exactly once; go then makes it public');
{
  const yes = await plan({ id: 'p1', kind: 'plan', project: 'my-app', words: 'yes', at: '2026-11-22T10:00:00Z', version: '1.3.0', summary: 'Sign-in and the empty list are fixed.', items: [
    { title: 'Sign-in remembers you', outcome: 'People stay signed in.', size: 'light', why: 'Two bug reports.' },
    { title: 'The empty list opens', outcome: 'An empty list opens without an error.', size: 'light', why: 'A bug report.' }
  ], later: 'Dark mode waits.' }, reqCtx);
  assert.equal(yes.ok, true, yes.say);
  const record = releaseRecord(state, REPO, '1.3.0');
  const [one, two] = record.items.map(i => i.issue.number);
  const A = co.commit({ unit: 'echo "3 of 3 pass"' }, 'sign-in');
  gh.merge(REPO, one, A, { mergedAt: '2026-11-22T11:00:00Z' });
  const n = bridge.sent.length, w = gh.S.calls.length;
  await releasesStep.run(ctxFor([appProject]));
  assert.deepEqual(sentSince(n), [], 'one item is still open');
  assert.deepEqual(writesSince(w), []);
  assert.equal(appRepo.refs['tags/candidate/1.3.0'], undefined, 'nothing is frozen');
  assert.equal(releaseRecord(state, REPO, '1.3.0').items[0].done.commit, A);
  const B = co.commit({ unit: 'echo "4 of 4 pass"' }, 'empty list');
  gh.merge(REPO, two, B, { mergedAt: '2026-11-22T12:00:00Z' });
  const r = await releasesStep.run(ctxFor([appProject]));
  assert.equal(r.ok, true, r.error);
  assert.equal(appRepo.refs['tags/candidate/1.3.0'], B, 'frozen on the newest merge');
  assert.deepEqual(co.consumerLog(), [], 'the factory is never paused or unpaused: no program of the Forge does that (0.3.3, item 7)');
  assert.equal(fs.existsSync(path.join(co.checkout, '.factory', 'PAUSE')), false);
  const pre = appRepo.releases.find(x => x.tag_name === 'candidate/1.3.0');
  assert.deepEqual([pre.prerelease, pre.name], [true, '1.3.0 (to try)']);
  assert.equal(appRepo.latestId, 900, 'nothing public changed');
  assert.equal(appRepo.refs['heads/staging'], B, 'the branch staging is on the candidate');
  assert.ok(writesSince(w).every(c => c.role === 'release'), 'tags, releases and branches through the release App');
  const sent = sentSince(n);
  assert.deepEqual(sent.map(s => s.text), [`my-app 1.3.0 is ready to try: ${pre.html_url}. Shall I make it public? Reply go.`]);
  assertPlain(assert, sent[0].text);
  assert.deepEqual(bridge.json(WAITING_FILE).items, [{ handle: 'go', kind: 'staged', project: REPO, text: `my-app 1.3.0 is ready to try at ${pre.html_url}. Reply go to make it public.` }]);
  assert.equal(bridge.json(factsFile(REPO)).status, 'on staging');
  const again = gh.S.calls.length;
  await releasesStep.run(ctxFor([appProject]));
  assert.equal(sentSince(n).length, 1, 'announced once');
  assert.deepEqual(writesSince(again), [], 'and nothing is done twice');
  assert.deepEqual(co.consumerLog(), []);
  const public_ = await go({ id: 'g1', kind: 'go', project: 'my-app', words: 'go', at: '2026-11-22T13:00:00Z' }, reqCtx);
  assert.deepEqual(public_, { ok: true, say: `my-app 1.3.0 is public now: ${pre.html_url}` });
  assert.deepEqual([appRepo.refs['tags/v1.3.0'], appRepo.refs['heads/live'], appRepo.latestId], [B, B, pre.id]);
  assert.deepEqual(bridge.json(WAITING_FILE).items, []);
}

// One more project, set up and planned, with its own checkout. -> { co, project, record }
async function plannedProject(name, harness, profile) {
  const repository = `acme/${name}`;
  const c = projectCheckout(path.join(root, name), harness);
  setUpProject(state, gh, repository, { checkout: c.checkout });
  const r = await plan({ id: `p-${name}`, kind: 'plan', project: repository, words: 'yes', version: '0.1.0', summary: 'One fix.', items: [{ title: 'The page opens', outcome: 'The page opens.', size: 'light', why: 'A report.' }] }, reqCtx);
  assert.equal(r.ok, true, r.say);
  return { co: c, project: { repository, checkout: c.checkout, ...(profile ? { profile } : {}) }, issue: releaseRecord(state, repository, '0.1.0').items[0].issue.number };
}

testCase('a failing check gives one message naming it and its count, run once more alone, with no question about going public, and the factory runs again');
{
  const runs = path.join(root, 'failing-runs.txt');
  const { co: c, project, issue } = await plannedProject('failing', { unit: 'echo "3 of 3 pass"' });
  const bad = c.commit({ unit: `echo run >> "${runs}"; echo "2 of 3 pass"; exit 1` }, 'breaks');
  gh.merge('acme/failing', issue, bad);
  const n = bridge.sent.length;
  await releasesStep.run(ctxFor([project]));
  const text = 'failing 0.1.0 did not pass its own checks, so it is not ready to try. The tests failed, 2 of 3 passed. To fix it, ask me to plan the next failing release.';
  assert.deepEqual(sentSince(n).map(s => s.text), [text]);
  assert.doesNotMatch(text, /go\b/i, 'no question about going public');
  assertPlain(assert, text);
  assert.equal(fs.readFileSync(runs, 'utf8').trim().split('\n').length, 2, 'one run and one rerun of the failed check');
  assert.deepEqual(c.consumerLog(), []);
  const rel = gh.repo('acme/failing');
  assert.equal(rel.refs['tags/candidate/0.1.0'], bad, 'the candidate stays frozen, so a go with a reason can still make it public');
  assert.deepEqual(rel.releases, [], 'nothing is put up to try');
  assert.equal(rel.refs['heads/staging'], undefined);
  await releasesStep.run(ctxFor([project]));
  assert.equal(sentSince(n).length, 1, 'said once');
  // the owner may still make it public, and their words are recorded as the reason
  const anyway = await go({ id: 'g-anyway', kind: 'go', project: 'failing', words: 'go anyway, the failing test is a known flake', at: '2026-11-22T14:00:00Z' }, reqCtx);
  assert.deepEqual(anyway, { ok: true, say: `failing 0.1.0 is public now, although it did not pass its own checks: ${rel.releases.at(-1).html_url}` });
  const record = releaseRecord(state, 'acme/failing', '0.1.0');
  assert.deepEqual([record.state, record.go.despiteFailedChecks, record.go.words], ['public', true, 'go anyway, the failing test is a known flake']);
  assert.deepEqual([rel.refs['tags/v0.1.0'], rel.refs['heads/live'], rel.latestId], [bad, bad, rel.releases.at(-1).id]);
}

testCase('a ready-to-try message that could not leave is sent on the next run, and never twice');
{
  const { co: c, project, issue } = await plannedProject('resend', { unit: 'echo "1 of 1 pass"' });
  const good = c.commit({ unit: 'echo "1 of 1 pass"' }, 'works');
  gh.merge('acme/resend', issue, good);
  const n = bridge.sent.length;
  bridge.failNextSend();
  await releasesStep.run(ctxFor([project])).catch(() => null);
  assert.equal(releaseRecord(state, 'acme/resend', '0.1.0').state, 'staged', 'it is put up to try even though the message did not leave');
  assert.deepEqual(sentSince(n), [], 'nothing reached the owner yet');
  await releasesStep.run(ctxFor([project]));
  const pre = gh.repo('acme/resend').releases.find(x => x.tag_name === 'candidate/0.1.0');
  assert.deepEqual(sentSince(n).map(s => s.text), [`resend 0.1.0 is ready to try: ${pre.html_url}. Shall I make it public? Reply go.`]);
  await releasesStep.run(ctxFor([project]));
  assert.equal(sentSince(n).length, 1, 'and never twice');
}

testCase('when GitHub refuses a step of putting a checked release up to try, the next run finishes it without running the checks again or saying anything twice');
{
  const { co: c, project, issue } = await plannedProject('refused', { unit: 'true' });
  gh.merge('acme/refused', issue, c.commit({ unit: 'true' }, 'change'));
  gh.S.fail.push({ method: 'POST', path: /^\/repos\/acme\/refused\/releases$/, status: 502, times: 1 });
  const n = bridge.sent.length;
  const first = await releasesStep.run(ctxFor([project]));
  assert.equal(first.ok, false, 'the step says it did not finish');
  assert.deepEqual(sentSince(n), []);
  assert.equal(releaseRecord(state, 'acme/refused', '0.1.0').state, 'checked');
  assert.deepEqual((await go({ id: 'g-early', kind: 'go', project: 'refused', words: 'go' }, reqCtx)).say, 'refused 0.1.0 is still being checked, so there is nothing to make public yet.');
  const second = await releasesStep.run(ctxFor([project]));
  assert.equal(second.ok, true, second.error);
  assert.equal(releaseRecord(state, 'acme/refused', '0.1.0').state, 'staged');
  assert.equal(sentSince(n).length, 1);
  assert.match(sentSince(n)[0].text, /^refused 0\.1\.0 is ready to try: https:\/\/github\.example\/acme\/refused\/releases\/\d+\. Shall I make it public\? Reply go\.$/);
  assert.deepEqual(c.consumerLog(), [], 'the checks ran once, the factory was left alone');
}

testCase('a move of staging GitHub refuses the release App because it brings in a workflow change is made once with the owner\'s own sign-in; any other refusal is retried by the App and never uses it');
{
  const ownerGh = standInGh(gh);
  const withGh = { settings: settings({ steps: { 'owner-releases': { python: 'python3', check_minutes: 1, gh: ownerGh.command } } }) };
  const { co: c, project, issue } = await plannedProject('workflows', { unit: 'true' });
  const sha = c.commit({ unit: 'true' }, 'changes a workflow');
  gh.merge('acme/workflows', issue, sha);
  gh.S.workflowShas.add(sha);
  const n = bridge.sent.length;
  const r = await releasesStep.run({ ...ctxFor([project]), ...withGh });
  assert.equal(r.ok, true, r.error);
  assert.equal(gh.repo('acme/workflows').refs['heads/staging'], sha);
  assert.deepEqual(ownerGh.calls(), [['api', '-X', 'POST', 'repos/acme/workflows/git/refs', '-f', 'ref=refs/heads/staging', '-f', `sha=${sha}`]]);
  assert.equal(sentSince(n).length, 1);
  assert.match(sentSince(n)[0].text, /^workflows 0\.1\.0 is ready to try: /);
  await releasesStep.run({ ...ctxFor([project]), ...withGh });
  assert.equal(ownerGh.calls().length, 1, 'once');
  assert.equal(sentSince(n).length, 1);
  // another refusal: the App's own failure, retried by the next run, and the owner's sign-in is never used
  const other = await plannedProject('other-refusal', { unit: 'true' });
  gh.merge('acme/other-refusal', other.issue, other.co.commit({ unit: 'true' }, 'change'));
  gh.S.fail.push({ method: 'POST', path: /^\/repos\/acme\/other-refusal\/git\/refs$/, status: 403, times: 1, skip: 1 });
  const m = bridge.sent.length;
  assert.equal((await releasesStep.run({ ...ctxFor([other.project]), ...withGh })).ok, false);
  assert.equal(releaseRecord(state, 'acme/other-refusal', '0.1.0').state, 'checked');
  assert.equal((await releasesStep.run({ ...ctxFor([other.project]), ...withGh })).ok, true);
  assert.equal(releaseRecord(state, 'acme/other-refusal', '0.1.0').state, 'staged');
  assert.equal(sentSince(m).length, 1);
  assert.equal(ownerGh.calls().length, 1, 'the owner\'s sign-in was not used for it');
}

testCase('an item closed without a merged pull request gives one sentence to the owner and no freeze');
{
  const { project, issue } = await plannedProject('closed', { unit: 'true' });
  gh.repo('acme/closed').issues.find(i => i.number === issue).state = 'closed';
  const n = bridge.sent.length;
  await releasesStep.run(ctxFor([project]));
  await releasesStep.run(ctxFor([project]));
  assert.deepEqual(sentSince(n).map(s => s.text), ['closed 0.1.0 cannot be finished, because "The page opens" was closed without the change being made.']);
  assert.equal(gh.repo('acme/closed').refs['tags/candidate/0.1.0'], undefined, 'nothing is frozen');
  assert.equal(releaseRecord(state, 'acme/closed', '0.1.0').state, 'building');
}

testCase('the factory runs again after a check that hangs, after a run that was stopped in the middle, and a pause the owner made stays');
{
  const { co: c, project, issue } = await plannedProject('slow', { unit: 'true' });
  gh.merge('acme/slow', issue, c.commit({ unit: 'sleep 30' }, 'hangs'));
  const n = bridge.sent.length;
  await releasesStep.run({ ...ctxFor([project]), settings: settings({ steps: { 'owner-releases': { python: 'python3', check_minutes: 0.02 } } }) });
  assert.deepEqual(sentSince(n).map(s => s.text), ['slow 0.1.0 did not pass its own checks, so it is not ready to try. The tests did not finish within 0.02 minutes. To fix it, ask me to plan the next slow release.']);
  assert.deepEqual(c.consumerLog(), []);
  assert.equal(fs.existsSync(path.join(c.checkout, '.factory', 'PAUSE')), false);
  // a run stopped in the middle of its checks: the next one says so once, and a saved pausedByUs of an older version is read by nothing
  const stopped = await plannedProject('stopped', { unit: 'true' });
  const record = releaseRecord(state, 'acme/stopped', '0.1.0');
  Object.assign(record, { state: 'checking', pausedByUs: true, candidate: { commit: stopped.co.first, tag: 'candidate/0.1.0', at: '2026-11-22T09:00:00Z' } });
  await saveRelease(state, record);
  fs.mkdirSync(path.join(stopped.co.checkout, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(stopped.co.checkout, '.factory', 'PAUSE'), 'paused\n');
  const m = bridge.sent.length;
  await releasesStep.run(ctxFor([stopped.project]));
  await releasesStep.run(ctxFor([stopped.project]));
  assert.deepEqual(sentSince(m).map(s => s.text), ['stopped 0.1.0 did not pass its own checks, so it is not ready to try. The checks did not finish. To fix it, ask me to plan the next stopped release.']);
  assert.deepEqual(stopped.co.consumerLog(), [], 'no unpause either');
  assert.equal(fs.existsSync(path.join(stopped.co.checkout, '.factory', 'PAUSE')), true, 'a PAUSE that is there stays: the driver raises it, this step lifts nothing');
  // the owner paused the factory: the checks run, and the pause stays
  const held = await plannedProject('held', { unit: 'true' });
  gh.merge('acme/held', held.issue, held.co.commit({ unit: 'true' }, 'fine'));
  fs.mkdirSync(path.join(held.co.checkout, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(held.co.checkout, '.factory', 'PAUSE'), 'the owner paused it\n');
  await releasesStep.run(ctxFor([held.project]));
  assert.equal(releaseRecord(state, 'acme/held', '0.1.0').state, 'staged');
  assert.deepEqual(held.co.consumerLog(), [], 'neither paused nor unpaused');
  assert.equal(fs.readFileSync(path.join(held.co.checkout, '.factory', 'PAUSE'), 'utf8'), 'the owner paused it\n');
}

testCase('item 7 (the Forge 0.3.3): an owner release check never creates the factory\'s PAUSE or STOP, not while its checks run, and a leftover steps.owner-releases.python is ignored');
{
  const probe = 'd=$(git rev-parse --git-common-dir); test ! -e "$d/../.factory/PAUSE" && test ! -e "$d/../.factory/STOP" && echo "1 of 1 pass"';
  const lap = await plannedProject('lapgoeson', { unit: probe });
  gh.merge('acme/lapgoeson', lap.issue, lap.co.commit({ unit: probe }, 'fine'));
  const n = bridge.sent.length;
  await releasesStep.run({ ...ctxFor([lap.project]), settings: settings({ steps: { 'owner-releases': { python: 'python3', check_minutes: 5 } } }) });
  assert.equal(releaseRecord(state, 'acme/lapgoeson', '0.1.0').state, 'staged', 'the checks, which fail if PAUSE or STOP exists while they run, passed');
  assert.match(sentSince(n)[0].text, /is ready to try/);
  assert.deepEqual(lap.co.consumerLog(), [], 'consumer.py was never asked for anything');
  for (const f of ['PAUSE', 'STOP']) assert.equal(fs.existsSync(path.join(lap.co.checkout, '.factory', f)), false, f);
}

testCase('a project profile sends its staging address as the link, after its deploy and health commands saw the candidate');
{
  const deployed = path.join(root, 'deployed.txt');
  const { co: c, project, issue } = await plannedProject('hosted', { unit: 'true' }, { staging_url: 'https://staging.example', deploy: `echo "$FORGE_VERSION $FORGE_CANDIDATE_COMMIT" > "${deployed}"`, health: `cat "${deployed}"` });
  const commit = c.commit({ unit: 'true' }, 'hosted change');
  gh.merge('acme/hosted', issue, commit);
  const n = bridge.sent.length;
  await releasesStep.run(ctxFor([project]));
  assert.deepEqual(sentSince(n).map(s => s.text), ['hosted 0.1.0 is ready to try: https://staging.example. Shall I make it public? Reply go.']);
  assert.equal(fs.readFileSync(deployed, 'utf8').trim(), `0.1.0 ${commit}`);
  const broken = await plannedProject('broken', { unit: 'true' }, { deploy: 'exit 3' });
  gh.merge('acme/broken', broken.issue, broken.co.commit({ unit: 'true' }, 'change'));
  const m = bridge.sent.length;
  await releasesStep.run(ctxFor([broken.project]));
  assert.deepEqual(sentSince(m).map(s => s.text), ['broken 0.1.0 passed its own checks, but it could not be put on your staging copy, so it is not ready to try.']);
  assert.equal((await status({ id: 'st', kind: 'status', project: 'broken' }, reqCtx)).say, 'broken 0.1.0 could not be put on your staging copy. Nothing is public yet.');
  const g = await go({ id: 'g-broken', kind: 'go', project: 'broken', words: 'go, I will fix the staging copy myself' }, reqCtx);
  assert.match(g.say, /^broken 0\.1\.0 is public now: https:\/\/github\.example\/acme\/broken\/releases\/\d+$/, 'its checks passed, so no "although"');
}

await gh.close();
