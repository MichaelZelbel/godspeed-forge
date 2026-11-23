// The owner's requests the chat hands to the Forge (lib/owner/releases.mjs, lib/owner/questions.mjs) and the App
// tokens they use (lib/app-token.mjs), against a stand-in GitHub on 127.0.0.1 and a stand-in bridge to Godspeed.
// The acceptance of tickets 02 (filing) and 05 (go, take it back, release status) of the Forge 0.1.0 plan, and the
// answer half of ticket 03. No network, no AI.
// test cases: 15
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCase } from './cases.mjs';
import { fakeGithub, standInBridge, setUpProject, standInGh, tmpDir, assertPlain } from './forge-owner-fakes.mjs';
import { appToken, AppTokenError, forgetAppTokens } from '../lib/app-token.mjs';
import { plan, go, takeBack, status } from '../lib/owner/releases.mjs';
import { answer } from '../lib/owner/questions.mjs';
import { releaseRecord, saveRelease, saveQuestions, readQuestions, emptyQuestions, factsFile, WAITING_FILE } from '../driver/steps/owner/records.mjs';
import { idOf, keyOf } from '../driver/steps/owner/questions.mjs';
import { projectWords, planWords, goWords, takeBackWords, statusWords, answerWords, questionMessage, questionsGone, stageWords, notPlain } from '../driver/steps/owner/words.mjs';

const gh = await fakeGithub();
const REPO = 'acme/my-app', SIDE = 'acme/side', EMPTY = 'acme/empty';
const state = tmpDir('forge-state-');
const appApps = setUpProject(state, gh, REPO);
setUpProject(state, gh, SIDE);
setUpProject(state, gh, EMPTY);
const bridge = standInBridge();
const T = Date.parse('2026-11-22T10:00:00Z');
const ctx = (over = {}) => ({ gs: bridge, config: {}, paths: { state }, now: T, log: () => {}, githubApi: gh.url, ...over });
const P0 = '0'.repeat(40), C1 = 'c'.repeat(40);
// the version public before: v1.2.0, the live copy on it
const app = gh.repo(REPO);
app.refs['tags/v1.2.0'] = P0;
app.refs['heads/live'] = P0;
app.releases.push({ id: 900, tag_name: 'v1.2.0', name: '1.2.0', body: 'earlier', prerelease: false, draft: false, html_url: 'https://github.example/acme/my-app/releases/900' });
app.latestId = 900;
const goodPlan = {
  version: '1.3.0',
  summary: 'Sign-in works again, and lists can be sorted.',
  items: [
    { title: 'Sign-in keeps you signed in', outcome: 'People stay signed in after they close the app.', size: 'light', why: 'Two reports say people are signed out every day; the session is kept for thirty days, as the sign-in page promises.' },
    { title: 'Sort a list by date', outcome: 'People can sort any list by the date they added things.', size: 'full', why: 'The owner asked for it twice; newest first is the default, since that is what the list shows today.' }
  ],
  later: 'Dark mode waits for a later release.'
};
// the writes to the repository (an App's own token request is not one)
const writesSince = n => gh.S.calls.slice(n).filter(c => c.method !== 'GET' && !c.path.startsWith('/app/'));
const sentences = text => text.split(/(?<=[.?!])\s+(?=[A-Z0-9])/).filter(Boolean);

testCase('an App token is minted from the saved App details, kept until shortly before it expires, and never shown');
{
  forgetAppTokens();
  const before = gh.S.calls.length;
  const t1 = await appToken({ repository: REPO, role: 'builder', paths: { state }, api: gh.url });
  assert.match(t1, /^ghs_builder_\d+$/);
  assert.deepEqual(gh.S.calls.slice(before).map(c => `${c.method} ${c.path}`), ['GET /repos/acme/my-app/installation', `POST /app/installations/${gh.S.apps[JSON.parse(fs.readFileSync(path.join(state, 'credentials/acme/my-app/builder-app.json'), 'utf8')).id].installation}/access_tokens`]);
  assert.equal(await appToken({ repository: REPO, role: 'builder', paths: { state }, api: gh.url }), t1, 'the same token while it is fresh');
  assert.equal(gh.S.calls.length, before + 2, 'GitHub was not asked again');
  assert.match(await appToken({ repository: REPO, role: 'release', paths: { state }, api: gh.url }), /^ghs_release_\d+$/, 'each role has its own App');
  forgetAppTokens();
  gh.S.expiresInMs = 4 * 60 * 1000;
  const short = await appToken({ repository: REPO, role: 'builder', paths: { state }, api: gh.url });
  const again = await appToken({ repository: REPO, role: 'builder', paths: { state }, api: gh.url });
  assert.notEqual(again, short, 'a token five minutes from its end is made new');
  gh.S.expiresInMs = 3600 * 1000;
  forgetAppTokens();
  await assert.rejects(appToken({ repository: 'acme/nowhere', role: 'builder', paths: { state }, api: gh.url }), e => e instanceof AppTokenError && e.reason === 'missing' && !/ghs_/.test(e.message));
  await assert.rejects(appToken({ repository: REPO, role: 'admin', paths: { state }, api: gh.url }), e => e instanceof AppTokenError && e.reason === 'role');
  const other = tmpDir('forge-other-');
  fs.mkdirSync(path.join(other, 'credentials/acme/my-app'), { recursive: true });
  fs.writeFileSync(path.join(other, 'credentials/acme/my-app/builder-app.json'), '{"id": 1}');
  await assert.rejects(appToken({ repository: REPO, role: 'builder', paths: { state: other }, api: gh.url }), e => e.reason === 'damaged');
}

testCase('a plan that breaks a rule is refused in one plain sentence, and nothing is filed');
{
  const before = gh.S.calls.length;
  const ask = (over, words = 'Yes, start it.', project = 'my-app') => plan({ id: 'bad', kind: 'plan', project, words, at: '2026-11-22T09:59:00Z', ...goodPlan, ...over }, ctx());
  const say = async (over, words, project) => (await ask(over, words, project)).say;
  assert.equal(await say({ version: 'next' }), 'I did not start my-app: "next" is not a version number like 1.2.0. Nothing was started.');
  assert.equal(await say({ items: [] }), 'I did not start my-app 1.3.0: the plan has no changes in it. Nothing was started.');
  assert.equal(await say({ items: Array.from({ length: 9 }, () => goodPlan.items[0]) }), 'I did not start my-app 1.3.0: the plan has more than 8 changes, so make it smaller. Nothing was started.');
  assert.equal(await say({ items: [{ ...goodPlan.items[0], size: 'huge' }] }), 'I did not start my-app 1.3.0: change 1 is missing what it is, what it changes for the people using it, its size (light, full or large) or why. Nothing was started.');
  for (const items of [[goodPlan.items[0], { ...goodPlan.items[1], title: 'Fix #12' }], [goodPlan.items[0], { ...goodPlan.items[1], outcome: 'login.mjs keeps the session.' }], [goodPlan.items[0], { ...goodPlan.items[1], title: 'The sort ticket' }], [goodPlan.items[0], { ...goodPlan.items[1], outcome: 'Issue 14 is solved.' }]]) {
    assert.equal(await say({ items }), 'I did not start my-app 1.3.0: change 2 is not in everyday words yet: it names a number, a file or the factory\'s own terms. Nothing was started.');
  }
  assert.equal(await say({}, ''), 'I did not start my-app 1.3.0: I need your own yes to start it. Nothing was started.');
  assert.equal(await say({ version: '1.2.0' }), 'I did not start my-app 1.2.0: 1.2.0 is not newer than 1.2.0, the version that is public now. Nothing was started.');
  assert.equal(await say({ version: '1.1.9' }), 'I did not start my-app 1.1.9: 1.1.9 is not newer than 1.2.0, the version that is public now. Nothing was started.');
  assert.equal(await say({}, 'yes', 'other'), 'I do not know a project called "other" here. The Forge is set up for empty, my-app and side.');
  assert.equal(await say({}, 'yes', ''), 'Which project do you mean: empty, my-app or side?');
  assert.deepEqual(writesSince(before), [], 'nothing was written to GitHub');
  assert.equal(fs.existsSync(path.join(state, 'projects/acme/my-app/releases')), false, 'and nothing into the Forge\'s state');
}

testCase('on the yes, each item becomes one issue with the ticket headings, filed through the builder App, and the record says which is which');
{
  const before = gh.S.calls.length;
  const r = await plan({ id: 'req-1', kind: 'plan', project: 'my-app', words: 'Yes, start it.', at: '2026-11-22T09:59:00Z', ...goodPlan }, ctx());
  assert.deepEqual(r, { ok: true, say: 'Started. my-app 1.3.0 is being built now, with 2 changes. I will tell you when it is ready to try.' });
  assertPlain(assert, r.say);
  const posted = writesSince(before);
  assert.deepEqual(posted.map(c => `${c.method} ${c.path} ${c.role}`), ['POST /repos/acme/my-app/issues builder', 'POST /repos/acme/my-app/issues builder']);
  assert.deepEqual(app.issues.map(i => i.title), goodPlan.items.map(i => i.title));
  for (const [k, issue] of app.issues.entries()) {
    const headings = [...issue.body.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    assert.deepEqual(headings, ['Problem', 'Why', 'Why now', 'Outcome', 'Invariants', 'Acceptance', 'Done means']);
    assert.match(issue.body, new RegExp(`^Ticket for acme/my-app 1\\.3\\.0 \\(plan item ${k + 1} of 2\\)\\. Size: ${goodPlan.items[k].size}\\. Depends on: nothing\\.`));
    assert.ok(issue.body.includes(goodPlan.items[k].outcome) && issue.body.includes(goodPlan.items[k].why));
    assert.ok(issue.body.includes(`<!-- godspeed-forge release 1.3.0 item ${k + 1} -->`));
    assert.deepEqual(issue.labels, [], 'the pinned factory\'s intake needs no label: an open issue without needs-owner is work');
  }
  const record = releaseRecord(state, REPO, '1.3.0');
  assert.equal(record.state, 'building');
  assert.deepEqual(record.items.map(i => [i.n, i.issue.number, i.ticket]), [[1, 1, 'tickets/01-sign-in-keeps-you-signed-in.md'], [2, 2, 'tickets/02-sort-a-list-by-date.md']]);
  assert.equal(record.words, 'Yes, start it.');
  assert.equal(record.at, '2026-11-22T09:59:00Z');
  const dir = path.join(state, 'projects/acme/my-app/releases/1.3.0');
  for (const f of ['plan.md', 'release.json', 'tickets/01-sign-in-keeps-you-signed-in.md', 'tickets/02-sort-a-list-by-date.md']) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, `${f} is private`);
  }
  assert.match(fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'), /Approved by the owner on 2026-11-22T09:59:00Z: "Yes, start it\."/);
  const facts = bridge.json(factsFile(REPO));
  assert.equal(facts.release.state, 'building');
  assert.equal(facts.laterFromLastPlan, 'Dark mode waits for a later release.');
}

testCase('a second filing of the same version is refused, and nothing is filed again');
{
  const before = gh.S.calls.length;
  const r = await plan({ id: 'req-2', kind: 'plan', project: 'acme/my-app', words: 'yes', ...goodPlan }, ctx());
  assert.deepEqual(r, { ok: false, say: 'my-app 1.3.0 was already started on 22 November 2026, so I did not start it again.' });
  assert.deepEqual(writesSince(before), []);
  assert.equal(app.issues.length, 2);
}

testCase('a new plan while another release of the project is still being built is refused in one plain sentence, and nothing is filed');
{
  const before = gh.S.calls.length;
  const r = await plan({ id: 'req-next', kind: 'plan', project: 'my-app', words: 'yes', ...goodPlan, version: '1.4.0' }, ctx());
  assert.deepEqual(r, { ok: false, say: 'my-app 1.3.0 is still being built. I can plan the next release once it is public or taken back.' });
  assertPlain(assert, r.say);
  assert.deepEqual(writesSince(before), []);
  assert.equal(releaseRecord(state, REPO, '1.4.0'), null, 'nothing is kept of it either');
}

testCase('a filing GitHub stops part way carries on where it stopped next time, without a second copy of any issue');
{
  const sidePlan = { version: '0.2.0', summary: 'Two small fixes.', items: [goodPlan.items[0], goodPlan.items[1]], later: '' };
  gh.S.fail.push({ method: 'POST', path: /^\/repos\/acme\/side\/issues$/, status: 502, times: 1, skip: 1 });
  const first = await plan({ id: 'side-1', kind: 'plan', project: 'side', words: 'go ahead', plan: sidePlan }, ctx());
  assert.deepEqual(first, { ok: false, say: 'I could not finish starting side 0.2.0: GitHub refused part of it. Ask me again in a few minutes and I will carry on where I stopped.' });
  assert.equal(gh.repo(SIDE).issues.length, 1);
  assert.equal(releaseRecord(state, SIDE, '0.2.0').state, 'filing');
  const second = await plan({ id: 'side-2', kind: 'plan', project: 'side', words: 'go ahead', plan: sidePlan }, ctx());
  assert.deepEqual(second, { ok: true, say: 'Started. side 0.2.0 is being built now, with 2 changes. I will tell you when it is ready to try.' });
  assert.equal(gh.repo(SIDE).issues.length, 2, 'the first issue was not filed twice');
  assert.deepEqual(releaseRecord(state, SIDE, '0.2.0').items.map(i => i.issue.number), [1, 2]);
}

testCase('go makes the staged candidate public through the release App, records the go, and a second go changes nothing');
{
  const record = releaseRecord(state, REPO, '1.3.0');
  app.refs['tags/candidate/1.3.0'] = C1;
  app.releases.push({ id: 5001, tag_name: 'candidate/1.3.0', name: '1.3.0 (to try)', body: 'try', prerelease: true, draft: false, html_url: 'https://github.example/acme/my-app/releases/5001' });
  Object.assign(record, { state: 'staged', candidate: { commit: C1, tag: 'candidate/1.3.0', at: '2026-11-22T09:00:00Z' }, prerelease: { id: 5001, url: 'https://github.example/acme/my-app/releases/5001' }, staging: { at: '2026-11-22T09:00:00Z', link: 'https://github.example/acme/my-app/releases/5001' } });
  record.items.forEach(i => { i.done = { pr: 9, commit: C1, mergedAt: '2026-11-22T08:00:00Z' }; });
  await saveRelease(state, record);
  const facts = bridge.json(factsFile(REPO));
  facts.newestPublicRelease = { version: '1.2.0', tag: 'v1.2.0' }; // as the driver's refresh writes it
  await bridge.writeWorkspaceFile(factsFile(REPO), JSON.stringify(facts));
  assert.equal(await status({ id: 's0', kind: 'status', project: 'my-app' }, ctx()).then(r => r.say), 'my-app 1.3.0 is ready to try at https://github.example/acme/my-app/releases/5001 and waits for your go. 1.2.0 is public.');
  assert.equal((await plan({ id: 'req-staged', kind: 'plan', project: 'my-app', words: 'yes', ...goodPlan, version: '1.4.0' }, ctx())).say, 'my-app 1.3.0 is waiting for your go. I can plan the next release once it is public or taken back.');
  const before = gh.S.calls.length;
  const r = await go({ id: 'go-1', kind: 'go', project: 'my-app', words: 'go', at: '2026-11-22T10:01:00Z' }, ctx());
  assert.deepEqual(r, { ok: true, say: 'my-app 1.3.0 is public now: https://github.example/acme/my-app/releases/5001' });
  assertPlain(assert, r.say);
  assert.ok(writesSince(before).every(c => c.role === 'release'), 'every write went through the release App');
  assert.equal(app.refs['tags/v1.3.0'], C1, 'the version tag is on the candidate\'s commit');
  const rel = app.releases.find(x => x.id === 5001);
  assert.equal(app.latestId, 5001, 'it is the latest release');
  assert.deepEqual([rel.tag_name, rel.name, rel.prerelease], ['v1.3.0', '1.3.0', false]);
  assert.equal(rel.body, 'What changes in 1.3.0:\n\n- People stay signed in after they close the app.\n- People can sort any list by the date they added things.\n');
  assert.equal(app.refs['heads/live'], C1, 'live shows exactly the public version');
  const after = releaseRecord(state, REPO, '1.3.0');
  assert.equal(after.state, 'public');
  assert.deepEqual([after.go.at, after.go.words, after.go.requestId], ['2026-11-22T10:01:00Z', 'go', 'go-1']);
  assert.deepEqual(after.previous, { version: '1.2.0', tag: 'v1.2.0', releaseId: 900, commit: P0 });
  const n = gh.S.calls.length;
  const twice = await go({ id: 'go-2', kind: 'go', project: 'my-app', words: 'go', at: '2026-11-22T10:02:00Z' }, ctx());
  assert.deepEqual(twice, { ok: false, say: 'my-app 1.3.0 is already public, so nothing changed.' });
  assert.deepEqual(writesSince(n), []);
  assert.equal(releaseRecord(state, REPO, '1.3.0').go.requestId, 'go-1', 'the first go stays the recorded one');
}

testCase('a go for a candidate that moved, while nothing is staged, or while it is being built is refused in one sentence');
{
  const side = releaseRecord(state, SIDE, '0.2.0');
  assert.deepEqual(await go({ id: 'g1', kind: 'go', project: 'side', words: 'go' }, ctx()), { ok: false, say: 'side 0.2.0 is still being built, so there is nothing to make public yet.' });
  Object.assign(side, { state: 'checking', candidate: { commit: C1, tag: 'candidate/0.2.0' } });
  await saveRelease(state, side);
  assert.deepEqual(await go({ id: 'g2', kind: 'go', project: 'side', words: 'go' }, ctx()), { ok: false, say: 'side 0.2.0 is still being checked, so there is nothing to make public yet.' });
  assert.equal((await plan({ id: 'side-next', kind: 'plan', project: 'side', words: 'yes', ...goodPlan, version: '0.3.0' }, ctx())).say, 'side 0.2.0 is still being checked. I can plan the next release once it is public or taken back.');
  side.state = 'staged';
  await saveRelease(state, side);
  gh.repo(SIDE).refs['tags/candidate/0.2.0'] = 'd'.repeat(40);
  const before = gh.S.calls.length;
  assert.deepEqual(await go({ id: 'g3', kind: 'go', project: 'side', words: 'go' }, ctx()), { ok: false, say: 'I did not make side 0.2.0 public: it changed after it was put up to try, so it has to be tried again first.' });
  assert.deepEqual(writesSince(before), []);
  assert.equal(releaseRecord(state, SIDE, '0.2.0').go, undefined, 'a refused go is not recorded as a go');
  assert.deepEqual(await go({ id: 'g4', kind: 'go', project: 'empty', words: 'go' }, ctx()), { ok: false, say: 'Nothing of empty is waiting for your go right now.' });
}

testCase('take it back makes the earlier release the latest again, moves live back, marks the taken-back one, deletes nothing, and only once');
{
  const before = gh.S.calls.length;
  const r = await takeBack({ id: 'tb-1', kind: 'take-back', project: 'my-app', words: 'take it back', at: '2026-11-22T11:00:00Z' }, ctx());
  assert.deepEqual(r, { ok: true, say: 'my-app 1.3.0 is taken back. 1.2.0 is public again.' });
  assertPlain(assert, r.say);
  assert.ok(writesSince(before).every(c => c.role === 'release'));
  assert.equal(app.latestId, 900, 'the earlier release is the latest again');
  const rel = app.releases.find(x => x.id === 5001);
  assert.equal(rel.name, '1.3.0 (taken back)');
  assert.equal(rel.body, 'Taken back on 2026-11-22. 1.2.0 is public again.\n\nWhat changes in 1.3.0:\n\n- People stay signed in after they close the app.\n- People can sort any list by the date they added things.\n');
  assert.ok(!JSON.stringify(gh.S.calls.slice(before)).includes('take it back'), 'the owner\'s words never reach GitHub');
  assert.equal(releaseRecord(state, REPO, '1.3.0').takenBack.words, 'take it back', 'they are kept only in the Forge\'s private state');
  assert.equal(app.refs['heads/live'], P0, 'live is back on the earlier version');
  assert.equal(app.refs['tags/v1.3.0'], C1, 'the tag stays');
  assert.equal(app.refs['tags/candidate/1.3.0'], C1);
  assert.ok(app.releases.some(x => x.id === 5001), 'the release stays');
  assert.ok(gh.S.calls.every(c => c.method !== 'DELETE'), 'nothing was ever deleted');
  assert.equal(releaseRecord(state, REPO, '1.3.0').state, 'taken-back');
  const n = gh.S.calls.length;
  assert.deepEqual(await takeBack({ id: 'tb-2', kind: 'take-back', project: 'my-app', words: 'take it back' }, ctx()), { ok: false, say: 'my-app 1.3.0 was already taken back, so nothing changed.' });
  assert.deepEqual(writesSince(n), []);
  assert.deepEqual(await takeBack({ id: 'tb-3', kind: 'take-back', project: 'empty', words: 'take it back' }, ctx()), { ok: false, say: 'I have not made any version of empty public, so there is nothing to take back.' });
}

testCase('release status answers in at most two plain sentences');
{
  const side = releaseRecord(state, SIDE, '0.2.0');
  Object.assign(side, { state: 'building' });
  delete side.candidate;
  side.items[0].done = { pr: 3, commit: C1, mergedAt: '2026-11-22T08:00:00Z' };
  await saveRelease(state, side);
  const q = emptyQuestions();
  q.next = 2;
  q.questions.push({ repository: SIDE, key: keyOf('Colour'), qid: idOf(SIDE, keyOf('Colour')), handle: 'F1', status: 'told', issue: 7, number: 1, heading: 'Colour', text: 'side: Which colour?' });
  await saveQuestions(state, q);
  const said = {
    side: (await status({ id: 's1', kind: 'status', project: 'side' }, ctx())).say,
    app: (await status({ id: 's2', kind: 'status', project: 'my-app' }, ctx())).say,
    empty: (await status({ id: 's3', kind: 'status', project: 'empty' }, ctx())).say
  };
  assert.equal(said.side, 'side 0.2.0 is being built: 1 of 2 changes are done. Nothing is public yet, and 1 question waits for your answer.');
  assert.equal(said.app, 'Nothing new of my-app is being built. 1.2.0 is public.');
  assert.equal(said.empty, 'Nothing new of empty is being built. Nothing is public yet.');
  for (const text of Object.values(said)) { assert.ok(sentences(text).length <= 2, text); assertPlain(assert, text); }
}

testCase('an answer is posted once as an Owner decision with the owner\'s words verbatim; a repeat, an unknown and a withdrawn handle get one plain sentence');
{
  const appIssue = { number: 40, title: 'Owner decisions needed', body: '### 1. Should the welcome screen greet people by name?\nx\n- (a) Greet them by name.\n- (b) Greet them with a plain hello.\n', state: 'open', labels: [], user: { login: `${appApps.builder.slug}[bot]`, type: 'Bot' } };
  const bot = `${appApps.builder.slug}[bot]`.toLowerCase();
  // a stranger's issue with the same title, which a record must never lead an answer to
  app.issues.push({ number: 41, title: 'Owner decisions needed', body: '### 1. Anything?\nx\n', state: 'open', labels: [], user: { login: 'a-stranger', type: 'User' } });
  app.issues.push(appIssue);
  const heading = 'Should the welcome screen greet people by name?';
  const q = emptyQuestions();
  q.next = 3;
  q.questions.push({ repository: REPO, key: keyOf(heading), qid: idOf(REPO, keyOf(heading)), handle: 'F1', status: 'told', issue: 40, openedBy: bot, number: 1, heading, options: [{ label: '(a)', text: 'Greet them by name.' }, { label: '(b)', text: 'Greet them with a plain hello.' }], text: `my-app: ${heading}` });
  q.questions.push({ repository: REPO, key: 'gone', qid: 'gone', handle: 'F2', status: 'withdrawn', issue: 40, openedBy: bot, number: 2, heading: 'Gone' });
  await saveQuestions(state, q);
  const r = await answer({ id: 'a1', kind: 'answer', handle: 'F1', words: 'F1 2', at: '2026-11-22T10:05:00Z' }, ctx());
  assert.deepEqual(r, { ok: true, say: 'Your answer to F1 is passed on to the my-app factory.' });
  const comments = app.comments['40'];
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, [
    'Owner decision (question 1: Should the welcome screen greet people by name?)',
    '',
    '> F1 2',
    '',
    'The owner picked option (b): Greet them with a plain hello.',
    'The owner\'s own words, sent in their chat on 2026-11-22T10:05:00Z, relayed verbatim by the Forge.',
    `<!-- godspeed-forge owner-decision F1 ${idOf(REPO, keyOf(heading))} -->`
  ].join('\n'));
  assert.equal(gh.S.calls.filter(c => c.method === 'POST' && c.path.endsWith('/comments')).at(-1).role, 'builder');
  assert.deepEqual(bridge.json(WAITING_FILE).items, [], 'the answered question no longer waits');
  assert.deepEqual(await answer({ id: 'a2', kind: 'answer', handle: 'F1', words: 'F1 1' }, ctx()), { ok: false, say: 'You already answered F1, so I did not pass this on again.' });
  assert.equal(app.comments['40'].length, 1, 'posted once');
  assert.deepEqual(await answer({ id: 'a3', kind: 'answer', handle: 'F9', words: 'yes' }, ctx()), { ok: false, say: 'I have no question F9 for you. No question is waiting for your answer.' });
  assert.deepEqual(await answer({ id: 'a4', kind: 'answer', words: 'F2: keep it' }, ctx()), { ok: false, say: 'Question F2 was taken back by the my-app factory, so your answer was not passed on.' });
  assert.deepEqual(await answer({ id: 'a5', kind: 'answer', words: 'yes please' }, ctx()), { ok: false, say: 'Tell me which question you are answering, like F1, and your answer.' });
  assert.equal(app.comments['40'].length, 1, 'nothing more was posted');
  const later = readQuestions(state);
  later.questions.push({ repository: REPO, key: 'swapped', qid: 'swapped', handle: 'F3', status: 'told', issue: 41, openedBy: 'a-stranger', number: 1, heading: 'Anything?' });
  await saveQuestions(state, later);
  assert.deepEqual(await answer({ id: 'a6', kind: 'answer', handle: 'F3', words: 'F3 yes' }, ctx()), { ok: false, say: 'I did not pass your answer to F3 on, because that question on GitHub is no longer the factory\'s own.' });
  assert.equal(app.comments['41'], undefined, 'never posted on an issue the factory did not open');
}

testCase('a move of live GitHub refuses the release App because it brings in a workflow change is made once with the owner\'s own sign-in; any other refusal is a plain failure without it');
{
  const ownerGh = standInGh(gh);
  const c = { ...ctx(), config: { commands: { gh: ownerGh.command } } };
  const W = 'e'.repeat(40), L0 = 'f'.repeat(40);
  for (const name of ['wf', 'wf2']) {
    const full = `acme/${name}`;
    setUpProject(state, gh, full);
    Object.assign(gh.repo(full).refs, { 'heads/live': L0, 'tags/candidate/1.0.0': W });
    await saveRelease(state, {
      repository: full, version: '1.0.0', summary: 'One change.', later: '', words: 'yes', at: '2026-11-22T09:00:00Z', requestId: 'x', filedAt: '2026-11-22T09:00:00Z', state: 'staged',
      items: [{ n: 1, title: 'A change', outcome: 'Something works.', size: 'light', why: 'A report.', issue: { number: 1 } }],
      candidate: { commit: W, tag: 'candidate/1.0.0', at: '2026-11-22T09:30:00Z' }
    });
  }
  gh.S.workflowShas.add(W);
  const before = gh.S.calls.length;
  const r = await go({ id: 'wf-go', kind: 'go', project: 'wf', words: 'go' }, c);
  assert.equal(r.ok, true, r.say);
  assert.match(r.say, /^wf 1\.0\.0 is public now: https:\/\/github\.example\/acme\/wf\/releases\/\d+$/);
  assert.equal(gh.repo('acme/wf').refs['heads/live'], W, 'live shows the public version');
  assert.deepEqual(ownerGh.calls(), [['api', '-X', 'PATCH', 'repos/acme/wf/git/refs/heads/live', '-f', `sha=${W}`, '-F', 'force=true']], 'the owner\'s sign-in moved live, once');
  const writes = writesSince(before);
  assert.deepEqual(writes.filter(w => w.role === 'owner').map(w => `${w.method} ${w.path}`), ['PATCH /repos/acme/wf/git/refs/heads/live']);
  assert.ok(writes.filter(w => w.role !== 'owner').every(w => w.role === 'release'), 'the tag and the release stayed with the release App');
  gh.S.workflowShas.add(L0);
  assert.deepEqual(await takeBack({ id: 'wf-tb', kind: 'take-back', project: 'wf', words: 'take it back' }, c), { ok: true, say: 'wf 1.0.0 is taken back. No version was public before it, so none is public now, and the live copy is back where it was before.' });
  assert.equal(gh.repo('acme/wf').refs['heads/live'], L0, 'take it back moved live back to exactly where it was before the go, the same way');
  assert.equal(gh.repo('acme/wf').releases.at(-1).body.split('\n')[0], 'Taken back on 2026-11-22. No earlier release is public.');
  assert.equal(ownerGh.calls().length, 2);
  gh.S.fail.push({ method: 'PATCH', path: /^\/repos\/acme\/wf2\/git\/refs\/heads\/live$/, status: 403, times: 1 });
  const refused = await go({ id: 'wf2-go', kind: 'go', project: 'wf2', words: 'go' }, c);
  assert.deepEqual(refused, { ok: false, say: 'I could not finish making wf2 1.0.0 public: GitHub refused a step. Say go again in a few minutes and I will finish it.' });
  assert.equal(gh.repo('acme/wf2').refs['heads/live'], L0, 'live did not move');
  assert.equal(ownerGh.calls().length, 2, 'another refusal never uses the owner\'s sign-in');
}

testCase('taking back the first public version, with nothing before it, changes nothing on GitHub and says so plainly; go recorded where live was');
{
  const full = 'acme/first', F = '9'.repeat(40);
  setUpProject(state, gh, full);
  gh.repo(full).refs['tags/candidate/0.1.0'] = F;
  await saveRelease(state, {
    repository: full, version: '0.1.0', summary: 'The first version.', later: '', words: 'yes', at: '2026-11-22T09:00:00Z', requestId: 'f', filedAt: '2026-11-22T09:00:00Z', state: 'staged',
    items: [{ n: 1, title: 'It starts', outcome: 'The app starts.', size: 'light', why: 'A first version.', issue: { number: 1 } }],
    candidate: { commit: F, tag: 'candidate/0.1.0', at: '2026-11-22T09:30:00Z' }
  });
  assert.equal((await go({ id: 'f-go', kind: 'go', project: 'first', words: 'go' }, ctx())).ok, true);
  const record = releaseRecord(state, full, '0.1.0');
  assert.deepEqual([record.liveBefore, record.previous], [null, null], 'go recorded that live did not exist and nothing was public before');
  assert.equal(gh.repo(full).refs['heads/live'], F);
  const before = gh.S.calls.length;
  const text = 'first 0.1.0 is the first public version, so there is nothing earlier to go back to, and I changed nothing. To replace it, ask me to plan a fix.';
  assert.deepEqual(await takeBack({ id: 'f-tb', kind: 'take-back', project: 'first', words: 'take it back' }, ctx()), { ok: false, say: text });
  assertPlain(assert, text);
  assert.deepEqual(writesSince(before), [], 'nothing on GitHub changed');
  assert.deepEqual([gh.repo(full).refs['heads/live'], gh.repo(full).latestId, releaseRecord(state, full, '0.1.0').state], [F, gh.repo(full).releases.at(-1).id, 'public']);
  assert.equal(releaseRecord(state, full, '0.1.0').takenBack, undefined);
  assert.equal((await takeBack({ id: 'f-tb2', kind: 'take-back', project: 'first', words: 'take it back' }, ctx())).say, text, 'and says the same again');
}

testCase('right after setup, when automatic work is off, the plan\'s reply says nothing is built yet and how to start it; with automatic work on it stays as it is');
{
  const factoryFiles = { 'auto-off': [], 'auto-on': ['trigger.json', 'schedule.json'], 'auto-paused': ['trigger.json', 'schedule.json', 'PAUSE'] };
  const said = {};
  for (const [name, present] of Object.entries(factoryFiles)) {
    const checkout = tmpDir(`forge-${name}-`);
    fs.mkdirSync(path.join(checkout, '.factory'));
    for (const f of present) fs.writeFileSync(path.join(checkout, '.factory', f), '{}\n');
    setUpProject(state, gh, `acme/${name}`, { checkout });
    const r = await plan({ id: `p-${name}`, kind: 'plan', project: `acme/${name}`, words: 'yes', ...goodPlan, version: '0.1.0' }, ctx());
    assert.equal(r.ok, true, r.say);
    said[name] = r.say;
  }
  const off = name => `Started. ${name} 0.1.0 is planned, with 2 changes. I will tell you when it is ready to try. Automatic work is off, so nothing is built yet: say "run one lap" to watch the first change being made, then "turn on automatic work".`;
  assert.equal(said['auto-off'], off('auto-off'), 'right after setup: no schedule installed');
  assert.equal(said['auto-on'], 'Started. auto-on 0.1.0 is being built now, with 2 changes. I will tell you when it is ready to try.');
  assert.equal(said['auto-paused'], off('auto-paused'), 'the factory is paused');
  assertPlain(assert, said['auto-off']);
  assert.equal(gh.repo('acme/auto-off').issues.length, 2, 'the plan is filed all the same');
}

testCase('every sentence the owner can get from these requests and steps is plain words: no long dash, no internal name, no item number, at most one link');
{
  const R = 'acme/my-app', U = 'https://github.example/acme/my-app/releases/1';
  const texts = [
    projectWords.noneSetUp(), projectWords.unknown('x', [R, 'acme/side']), projectWords.several([R, 'acme/side']),
    planWords.started(R, '1.3.0', 1), planWords.startedOff(R, '1.3.0', 1), planWords.already(R, '1.3.0', T), planWords.noAccess(R, '1.3.0'), planWords.githubFailed(R, '1.3.0'),
    ...['building', 'checking', 'staged'].map(s => planWords.busy(R, '1.3.0', s)),
    ...[planWords.reasons.noYes, planWords.reasons.version('x'), planWords.reasons.notNewer('1.0.0', '1.2.0'), planWords.reasons.noItems, planWords.reasons.tooMany(8), planWords.reasons.item(1), planWords.reasons.notPlain(2), planWords.reasons.summaryNotPlain].map(reason => planWords.refused(R, '1.3.0', reason)),
    ...Object.values(goWords).map(f => f(R, '1.3.0', U)), ...Object.values(takeBackWords).map(f => f(R, '1.3.0', '1.2.0')),
    statusWords.building(R, '1.3.0', 1, 1), statusWords.stuck(R, '1.3.0'), statusWords.checking(R, '1.3.0'), statusWords.staged(R, '1.3.0', U), statusWords.failed(R, '1.3.0'), statusWords.stagingFailed(R, '1.3.0'), statusWords.idle(R),
    statusWords.publicAnd('1.2.0', 2), statusWords.publicAnd(null, 0),
    answerWords.passed(R, 'F1'), answerWords.unknown('F9', ['F1', 'F2']), answerWords.already('F1'), answerWords.withdrawn(R, 'F1'), answerWords.missing, answerWords.failed('F1'), answerWords.untrusted('F1'),
    questionMessage(R, 'F1', { question: 'Should it greet people?', example: 'When you open it, it says Welcome.', choices: ['Greet them.', 'Do not.', 'Ask them.'] }, { deadline: T, fallback: 'keep the plain welcome' }),
    questionMessage(R, 'F1', { question: '', example: '', choices: [] }, { link: 'https://github.example/acme/my-app/issues/3' }),
    questionsGone(R),
    stageWords.ready(R, '1.3.0', U), stageWords.stagingFailed(R, '1.3.0'), stageWords.closedUndone(R, '1.3.0', 'Sort a list'),
    stageWords.failedChecks(R, '1.3.0', [stageWords.check.static, stageWords.check.unit({ passed: 1, total: 2 }), stageWords.check.unit(null), stageWords.check.timeout('unit', 25), stageWords.check.start('static'), stageWords.check.unfinished, stageWords.check.setup])
  ];
  for (const text of texts) {
    assertPlain(assert, text);
    assert.equal(notPlain(text), '', text);
  }
  assert.equal(questionMessage(R, 'F4', { question: 'Should it greet people?', example: '', choices: [] }), 'my-app has a question for you (F4).\nShould it greet people?\nIt waits for your answer.\nReply "F4" and your answer in your own words.');
}

await gh.close();
