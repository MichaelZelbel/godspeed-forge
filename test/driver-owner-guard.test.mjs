// A helper never writes as the owner, and never says the same thing twice (the Forge 0.3.1, issue #152). On 2026-11-24 the
// driver started an acting run on the same parked pull request every five minutes, and between 05:02 and 06:34 UTC the runs
// posted the same finding 19 times, 5 of them under the owner's own account: the run was root, and root's gh is the owner's.
// These cases hold the acting run to the Apps' tokens (the real gh and git are asked), its gh and git guard to refusing the
// owner's login and a finding already on the item, the chain to climbing instead of starting the same run again, and replay
// that morning: from the comments GitHub has, and through the driver's own rounds.
// test cases: 16
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { testCase } from './cases.mjs';
import { TEST_ENV } from '../driver/test/env.mjs';
import {
  findingOf, findingMarker, findingsIn, stateText, commentOf, findingWhy, ownerWhy, tokenIdentity, decide, prepareAppRun, appVars,
  mintAppToken, runRepos, asOwnerObstacles, readGuardLog, GUARD_FILE, AS_OWNER_MINUTES,
} from '../driver/owner-guard.mjs';
import { prompt, launchAct, actResult, runJob, sandboxProps, actDefaults, noticeHeld, sameFindingAgain } from '../driver/onduty.mjs';
import { advance, buildInventory, KNOWN_OBSTACLES } from '../driver/inventory.mjs';
import { nextStep } from '../driver/ladder.mjs';
import { obstacleId } from '../driver/obstacles.mjs';
import { guardedEnv } from '../driver/release-driver/release-driver.mjs';
import { launchHelper, helperResult } from '../driver/ai.mjs';
import { replayGuard, replayChain, fakeGitHub, cleanEnv, asRootDid, loadFixture, OWNER, RELEASE_BOT, APP_TOKEN, STORED_OWNER_TOKEN } from '../driver/test/replay/pr-895.mjs';

const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `owner-guard-${name}-`));
const REPO = 'MichaelZelbel/godspeed-mission-control';
const prEntry = updatedAt => buildInventory({ openPrs: [{ repo: REPO, number: 895, title: 'The page-wide layout check', url: `https://github.com/${REPO}/pull/895`, updatedAt }] }, {}, [], { now: Date.parse('2026-11-24T06:00:00Z') })[0];
const realGit = process.env.FORGE_TEST_REAL_GIT || 'git';
// a real gh or git answer, compared without ever printing a token
const ghToken = env => { const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', env }); return r.status === 0 ? r.stdout.trim() : ''; };
const gitPassword = (env, globalConfig) => {
  const r = spawnSync(realGit, ['credential', 'fill'], { encoding: 'utf8', input: 'protocol=https\nhost=github.com\n\n', env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig } });
  return ((/^password=(.*)$/m.exec(r.stdout || '') || [])[1] || '').trim();
};

testCase('the finding: the same item in the same state, whatever "last touched" says; another state is another finding');
{
  const a = prEntry('2026-11-24T05:02:23Z'), b = prEntry('2026-11-24T06:33:56Z');
  assert.match(findingOf(a), /^[0-9a-f]{10} [0-9a-f]{12}$/);
  assert.equal(findingOf(a), findingOf(b), 'our own comment touching the pull request changes nothing');
  assert.doesNotMatch(stateText(a), /2026-11-24/);
  const other = { ...a, evidence: [...a.evidence, 'required failed on PR #895 since 2026-11-24T07:00:00Z'] };
  assert.notEqual(findingOf(other), findingOf(a), 'a new fact is a new state');
  assert.equal(findingOf(other).split(' ')[0], findingOf(a).split(' ')[0], 'the item part stays');
  const ob = { id: 'a146e21b33', kind: 'stale-process', evidence: ['process 41 (root) running 45 min: node x'] };
  assert.equal(findingOf(ob), findingOf({ ...ob, evidence: ['process 41 (root) running 50 min: node x'] }), 'a running count is not a new state');
  assert.deepEqual(findingsIn(`x\n${findingMarker(findingOf(a))}\n`), [findingOf(a)]);
}

testCase('a note is read from every way gh posts one; other calls are not notes');
{
  const d = tmp('notes');
  fs.writeFileSync(path.join(d, 'b.md'), 'from a file');
  assert.deepEqual(commentOf(['pr', 'comment', '895', '-R', REPO, '--body-file', 'b.md'], d), { repo: REPO, number: 895, body: 'from a file', review: true });
  assert.deepEqual(commentOf(['issue', 'comment', `https://github.com/${REPO}/issues/12`, '--body', 'hi'], d), { repo: REPO, number: 12, body: 'hi', review: false });
  assert.deepEqual(commentOf(['pr', 'comment', '--body', '42', '895'], d), { repo: null, number: 895, body: '42', review: true }, 'a value is never taken for the number');
  assert.equal(commentOf(['pr', 'comment', '895', '--body-file', '-'], d).body, null, 'stdin cannot be read');
  assert.deepEqual(commentOf(['pr', 'close', '895', '-R', REPO, '--comment', 'closing'], d), { repo: REPO, number: 895, body: 'closing', review: true });
  assert.equal(commentOf(['pr', 'close', '895', '-R', REPO], d), null);
  assert.equal(commentOf(['pr', 'review', '895', '--approve'], d), null);
  assert.equal(commentOf(['pr', 'review', '895', '--comment', '-b', 'looks fine'], d).body, 'looks fine');
  assert.deepEqual(commentOf(['api', '-X', 'POST', `repos/${REPO}/issues/895/comments`, '-f', 'body=via rest'], d), { repo: REPO, number: 895, body: 'via rest', review: false });
  fs.writeFileSync(path.join(d, 'in.json'), JSON.stringify({ body: 'from input' }));
  assert.equal(commentOf(['api', `repos/${REPO}/issues/895/comments`, '--input', 'in.json'], d).body, 'from input');
  assert.ok(commentOf(['api', 'graphql', '-f', 'query=mutation { addComment(input: {subjectId: "x", body: "y"}) { clientMutationId } }'], d).graphql);
  assert.equal(commentOf(['api', 'graphql', '-f', 'query={ viewer { login } }'], d), null, 'a read is not a note');
  assert.equal(commentOf(['api', `repos/${REPO}/issues/895/comments`], d), null, 'reading comments is not a note');
  for (const a of [['pr', 'view', '895'], ['pr', 'merge', '895', '--squash'], ['workflow', 'run', 'x.yml']]) assert.equal(commentOf(a, d), null, a.join(' '));
  // taking a note away or rewriting it would let the same finding be posted again: those are refused as edits
  for (const a of [['pr', 'comment', '895', '--delete-last', '--yes'], ['issue', 'comment', '12', '--edit-last', '--body', 'x'], ['api', '-X', 'DELETE', `repos/${REPO}/issues/comments/5`],
    ['api', '-X', 'PATCH', `repos/${REPO}/issues/comments/5`, '-f', 'body=x'], ['api', '-X', 'PUT', `repos/${REPO}/pulls/895/reviews/7/dismissals`, '-f', 'message=x']]) assert.equal(commentOf(a, d).edit, true, a.join(' '));
  assert.ok(commentOf(['api', 'graphql', '-f', 'query=mutation { deleteIssueComment(input: {id: "x"}) { clientMutationId } }'], d).graphql);
  assert.ok(commentOf(['api', 'graphql', '-f', 'query=mutation { minimizeComment(input: {subjectId: "x", classifier: OUTDATED}) { clientMutationId } }'], d).graphql);
  assert.equal(commentOf(['api', '-X', 'POST', `repos/${REPO}/issues/comments/5/reactions`, '-f', 'content=+1'], d), null, 'a reaction is no note');
}

testCase('a note without the run\'s finding line, or with another, is refused; one whose finding is on the item already is refused as unchanged');
{
  const f = findingOf(prEntry('2026-11-24T05:00:00Z'));
  const mark = findingMarker(f);
  const none = () => [];
  const c = body => ({ repo: REPO, number: 895, body });
  assert.deepEqual(findingWhy(c(`found it\n${mark}`), { finding: f }, none), { why: '' });
  assert.match(findingWhy(c('found it'), { finding: f }, none).why, /ends with this hidden line, exactly: <!-- factory-driver:finding/);
  assert.match(findingWhy(c(`x\n${findingMarker('0123456789 0123456789ab')}`), { finding: f }, none).why, /its own finding line and no other/);
  assert.match(findingWhy({ ...c(null) }, { finding: f }, none).why, /not on stdin/);
  assert.match(findingWhy({ repo: null, number: 895, body: `x ${mark}` }, { finding: f }, none).why, /-R <owner\/repo>/);
  const said = [{ event: 'commented', at: '2026-11-24T05:02:23Z', body: 'an older note' }, { event: 'commented', at: '2026-11-24T05:03:00Z', body: `said first\n${mark}` }];
  const quiet = [...said, { event: 'commented', at: '2026-11-24T05:07:19Z', body: `another run's note ${findingMarker('0123456789 0123456789ab')}` }, { event: 'subscribed', at: '2026-11-24T05:08:00Z', body: '' }];
  const there = findingWhy(c(`said again\n${mark}`), { finding: f }, () => quiet);
  assert.equal(there.unchanged, true); assert.match(there.why, /^unchanged: this finding is already on MichaelZelbel\/godspeed-mission-control#895, and nothing has happened there since/);
  const at = '2026-11-24T05:30:00Z';
  for (const [what, e] of [['a commit', { event: 'committed', at }], ['the head arriving (an older commit pushed late)', { event: 'head-arrived', at }], ['a person\'s comment', { event: 'commented', at, body: 'Owner decision: one more lap' }],
    ['a label', { event: 'unlabeled', at }], ['a review', { event: 'reviewed', at, body: '' }], ['a close', { event: 'closed', at }]])
    assert.deepEqual(findingWhy(c(`said again\n${mark}`), { finding: f }, () => [...said, e]), { why: '' }, `${what} after the note: a new state, a new note`);
  assert.match(findingWhy({ repo: REPO, number: 895, body: null, edit: true }, { finding: f }, none).why, /never edited, deleted or hidden/);
  assert.match(findingWhy(c(`x ${mark}`), { finding: f }, () => { throw new Error('HTTP 502'); }).why, /could not be read \(HTTP 502\); try again/);
  assert.deepEqual(findingWhy(c('anything'), { finding: '' }, none), { why: '' }, 'no finding: no check');
  assert.match(findingWhy({ graphql: true, body: 'x' }, { finding: f }, none).why, /gh issue comment or gh pr comment/);
}

testCase('whose login: an App\'s token passes without asking GitHub, the owner\'s is refused, one nobody can name is refused');
{
  const root = tmp('who');
  const gh = fakeGitHub(root);
  assert.deepEqual(tokenIdentity('ghs_abc', { realGh: gh.realGh }), { kind: 'app' });
  assert.deepEqual(tokenIdentity('', { realGh: gh.realGh }), { kind: 'none' });
  const cache = path.join(root, 'cache');
  assert.deepEqual(tokenIdentity(STORED_OWNER_TOKEN, { realGh: gh.realGh, cache, env: cleanEnv() }), { kind: 'user', login: OWNER });
  assert.equal(fs.readdirSync(cache).length, 1, 'asked once, then kept by the token\'s hash');
  assert.ok(!fs.readFileSync(path.join(cache, fs.readdirSync(cache)[0]), 'utf8').includes(STORED_OWNER_TOKEN), 'the token itself is never kept');
  assert.deepEqual(tokenIdentity('gho_nobody_knows', { realGh: gh.realGh, env: cleanEnv() }), { kind: 'user', unknown: true });
  assert.match(ownerWhy({ kind: 'user', login: 'michaelzelbel' }, OWNER), /would act as MichaelZelbel, the owner's own GitHub account/);
  assert.match(ownerWhy({ kind: 'user', unknown: true }, OWNER), /could not tell whose GitHub login/);
  assert.equal(ownerWhy({ kind: 'app' }, OWNER), '');
  assert.equal(ownerWhy({ kind: 'user', login: 'someone-else' }, OWNER), '');
}

testCase('the acting run\'s environment: the real gh sees only the App token, and the real git gets only the App token, though the owner\'s login is stored in the default places');
{
  const root = tmp('real');
  const xdg = path.join(root, 'config');
  fs.mkdirSync(path.join(xdg, 'gh'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'gh', 'hosts.yml'), `github.com:\n    users:\n        ${OWNER}:\n            oauth_token: ${STORED_OWNER_TOKEN}\n    git_protocol: https\n    oauth_token: ${STORED_OWNER_TOKEN}\n    user: ${OWNER}\n`);
  const base = cleanEnv({ XDG_CONFIG_HOME: xdg });
  assert.ok(ghToken(base) === STORED_OWNER_TOKEN, 'as the acting run was until now: gh uses the stored owner login');
  const p = prepareAppRun({ dir: path.join(root, 'run'), token: APP_TOKEN, owner: OWNER, realGh: 'gh' });
  assert.deepEqual(fs.readdirSync(path.join(root, 'run', 'gh')), [], 'its own gh folder is empty');
  assert.ok(ghToken({ ...base, ...p.vars }) === APP_TOKEN, 'with the run\'s environment: only the App token');
  // root's gitconfig hands the owner's login to git through a stored helper
  const gcfg = path.join(root, 'gitconfig');
  fs.writeFileSync(gcfg, `[credential]\n\thelper =\n[credential "https://github.com"]\n\thelper =\n\thelper = "!f() { echo username=${OWNER}; echo password=${STORED_OWNER_TOKEN}; }; f"\n`);
  assert.ok(gitPassword(base, gcfg) === STORED_OWNER_TOKEN, 'as until now: git gets the owner\'s login');
  assert.ok(gitPassword({ ...base, ...p.vars }, gcfg) === APP_TOKEN, 'the stored helper is off, and the one left hands out the App token');
  assert.ok(gitPassword({ ...base, ...appVars({ ghDir: path.join(root, 'run', 'gh'), realGh: 'gh' }) }, gcfg) === '', 'no App token: no login at all, never the owner\'s');
}

testCase('a helper run with the owner\'s login stored in the default gh config cannot post; with its own environment it posts as the App');
{
  const root = tmp('post');
  const gh = fakeGitHub(root);
  const fx = loadFixture();
  const finding = findingOf(prEntry('2026-11-24T05:00:00Z'));
  const dir = path.join(root, 'run');
  const p = prepareAppRun({ dir, token: APP_TOKEN, owner: OWNER, finding, repo: fx.repo, realGh: gh.realGh });
  for (const tool of ['gh', 'git']) assert.match(fs.readFileSync(path.join(dir, 'bin', tool), 'utf8'), new RegExp(`owner-guard\\.mjs" --config ".*guard\\.json" ${tool} "\\$@"`));
  fs.writeFileSync(path.join(dir, 'note.md'), `Green, a known repair, parked.\n${findingMarker(finding)}\n`);
  const post = env => spawnSync(process.execPath, [GUARD_FILE, '--config', path.join(dir, 'guard.json'), 'gh', 'pr', 'comment', '895', '-R', fx.repo, '--body-file', path.join(dir, 'note.md')], { encoding: 'utf8', env });
  const env = cleanEnv(p.vars);
  const asOwner = post(asRootDid(env, gh.ownerConfig));
  assert.equal(asOwner.status, 3);
  assert.match(asOwner.stderr, /owner guard: refused: this call would act as MichaelZelbel, the owner's own GitHub account/);
  assert.deepEqual(gh.state().posts, [], 'nothing reached GitHub');
  const log = readGuardLog(path.join(dir, 'guard.log'));
  assert.equal(log.length, 1); assert.equal(log[0].owner, true); assert.match(log[0].args, /pr comment 895/);
  const asApp = post(env);
  assert.equal(asApp.status, 0, asApp.stderr);
  assert.deepEqual(gh.state().posts.map(x => x.login), [RELEASE_BOT]);
  const again = post(env);
  assert.equal(again.status, 3); assert.match(again.stderr, /unchanged: this finding is already on/);
  assert.equal(gh.state().posts.length, 1, 'the same finding is never posted twice');
  assert.equal(readGuardLog(path.join(dir, 'guard.log')).at(-1).unchanged, true);
}

testCase('git: a push goes out only over https and never with the owner\'s login; where it goes is read the way git reads it');
{
  const root = tmp('git');
  const gh = fakeGitHub(root);
  const gcfg = path.join(root, 'gitconfig');
  fs.writeFileSync(gcfg, `[credential]\n\thelper =\n[credential "https://github.com"]\n\thelper =\n\thelper = "!f() { echo username=${OWNER}; echo password=${STORED_OWNER_TOKEN}; }; f"\n`);
  const env = cleanEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gcfg });
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => { const r = spawnSync(realGit, args, { cwd: repo, encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q'); git('remote', 'add', 'origin', `https://github.com/${REPO}.git`); git('remote', 'add', 'ssh', `git@github.com:${REPO}.git`);
  const app = { ...env, ...appVars({ ghDir: path.join(root, 'gh'), token: APP_TOKEN, realGh: gh.realGh }) };
  const d = (args, e = app) => decide('git', args, { owner: OWNER, realGit, realGh: gh.realGh }, { env: e, cwd: repo }).why;
  assert.match(d(['push', 'origin', 'fix'], env), /owner's own GitHub account/, 'root\'s stored helper hands out the owner\'s login');
  assert.equal(d(['push', 'origin', 'fix']), '', 'the run\'s own environment: the App token');
  assert.equal(d(['push']), '', 'no remote named: origin');
  assert.match(d(['push', 'ssh', 'fix']), /pushes only over https/, 'an ssh remote');
  assert.match(d(['push', `git@github.com:${REPO}.git`, 'fix']), /pushes only over https.*git@github\.com/, 'an ssh address');
  assert.match(d(['push', `ssh://git@github.com/${REPO}.git`, 'fix']), /pushes only over https/);
  assert.match(d(['push', `https://x:${STORED_OWNER_TOKEN}@github.com/${REPO}.git`, 'fix']), /owner's own GitHub account/, 'a login written into the address');
  git('config', 'remote.pushDefault', 'ssh');
  assert.match(d(['push']), /pushes only over https/, 'the push default, read as git reads it');
  git('config', '--unset', 'remote.pushDefault');
  git('config', 'url.git@github.com:.pushInsteadOf', 'https://github.com/');
  assert.match(d(['push', 'origin', 'fix']), /pushes only over https/, 'a remote rewritten to ssh');
  assert.match(d(['push', `https://github.com/${REPO}.git`, 'fix']), /pushes only over https/, 'an address rewritten to ssh');
  assert.equal(d(['push', '../elsewhere', 'fix']), '', 'a folder on this machine');
  assert.equal(d(['status'], env), '', 'nothing else is asked about');
}

testCase('the acting run: its unit cannot read root\'s gh folder, its job and brief carry the App token\'s repositories and the finding, never the owner\'s login');
{
  const dir = tmp('act');
  const a = { ...actDefaults({ ...TEST_ENV, FD_DEV_REPO: 'MichaelZelbel/godspeed-dev' }), ACT_DIR: dir };
  assert.ok(sandboxProps(a).includes('InaccessiblePaths=-/root/.config/gh'));
  const entry = prEntry('2026-11-24T05:02:23Z');
  const p = prompt(entry, [], '/x/onduty.mjs', a);
  assert.doesNotMatch(p, /logged in as the owner/);
  assert.match(p, /gh and git sign in as the release App: its token is in GH_TOKEN \(for MichaelZelbel\/godspeed-mission-control, MichaelZelbel\/godspeed-dev\)/);
  assert.match(p, /The owner's own GitHub login is not available to this run and is never used/);
  assert.ok(p.includes(`ends with this hidden line, exactly: ${findingMarker(findingOf(entry))}`));
  assert.doesNotMatch(p, /THE SAME FINDING AGAIN/, 'a first look is a first look');
  const calls = [];
  launchAct({}, a, { unit: 'factory-act-abc-1', entry, provider: 'codex', settings: {} }, (c, args) => { calls.push(args); return { status: 0 }; });
  assert.ok(calls[0].includes('InaccessiblePaths=-/root/.config/gh'));
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'factory-act-abc-1', 'job.json'), 'utf8'));
  assert.deepEqual(job.github.repos, ['MichaelZelbel/godspeed-mission-control', 'MichaelZelbel/godspeed-dev']);
  assert.equal(job.github.finding, findingOf(entry)); assert.equal(job.github.owner, 'MichaelZelbel');
  let seen = null, minted = null;
  runJob(path.join(dir, 'factory-act-abc-1'), (file, args, opts) => { seen = opts.env; fs.writeFileSync(args[args.indexOf('-o') + 1], 'done\nRESULT: resolved'); return { status: 0 }; }, {}, o => { minted = o; return APP_TOKEN; });
  assert.equal(minted.app, 'release'); assert.deepEqual(minted.repos, job.github.repos);
  assert.equal(seen.GH_TOKEN, APP_TOKEN);
  assert.equal(seen.GH_CONFIG_DIR, path.join(dir, 'factory-act-abc-1', 'gh'));
  assert.equal(seen.GIT_CONFIG_KEY_0, 'credential.helper'); assert.equal(seen.GIT_CONFIG_VALUE_0, '', 'every stored helper off');
  assert.ok(seen.PATH.startsWith(path.join(dir, 'factory-act-abc-1', 'bin')), 'gh and git are the guard\'s shims first');
  assert.equal(seen.FD_ACT_FINDING, findingOf(entry));
  const guard = JSON.parse(fs.readFileSync(path.join(dir, 'factory-act-abc-1', 'guard.json'), 'utf8'));
  assert.equal(guard.owner, 'MichaelZelbel'); assert.equal(guard.finding, findingOf(entry));
  // no token could be made: the run has no GitHub login at all, and never falls back to root's
  runJob(path.join(dir, 'factory-act-abc-1'), (file, args, opts) => { seen = opts.env; fs.writeFileSync(args[args.indexOf('-o') + 1], 'RESULT: unresolved'); return { status: 0 }; }, {}, () => '');
  assert.equal(seen.GH_TOKEN, undefined); assert.equal(seen.GH_CONFIG_DIR, path.join(dir, 'factory-act-abc-1', 'gh'));
}

testCase('a run whose note was refused as unchanged answers "unchanged"; the next rung is told to decide it under the standing instruction; a finding is told to the owner once');
{
  const dir = tmp('result');
  const a = { ...actDefaults(TEST_ENV), ACT_DIR: dir };
  const unit = 'factory-act-abc-2';
  fs.mkdirSync(path.join(dir, unit), { recursive: true });
  fs.writeFileSync(path.join(dir, unit, 'result.json'), JSON.stringify({ result: 'notice', said: 'parked after its repair limit; the owner must allow one more lap.\nRESULT: notice', provider: 'codex' }));
  assert.equal(actResult({}, a, unit).result, 'notice', 'nothing refused: its own answer');
  fs.writeFileSync(path.join(dir, unit, 'guard.log'), `${JSON.stringify({ at: 'x', tool: 'gh', why: 'unchanged: ...', unchanged: true })}\n${JSON.stringify({ at: 'y', tool: 'gh', why: 'as owner', owner: true })}\n`);
  const r = actResult({}, a, unit);
  assert.equal(r.result, 'unchanged'); assert.match(r.said, /^unchanged: the same finding/); assert.equal(r.asOwner, 1);
  fs.writeFileSync(path.join(dir, unit, 'result.json'), JSON.stringify({ result: 'resolved', said: 'merged', provider: 'codex' }));
  assert.equal(actResult({}, a, unit).result, 'resolved', 'a run that resolved it stays resolved');
  const again = sameFindingAgain([{ result: 'unchanged' }], { ...a, OWNER_NAME: 'Michael' });
  assert.match(again, /THE SAME FINDING AGAIN/);
  assert.match(again, /"Manager decision \(Mission Control, on Michael's standing instruction of 2026-11-24\)"/);
  assert.match(again, /spending money .*publishing .*sending anything to anyone but the owner.*deleting people's data/);
  assert.equal(sameFindingAgain([{ result: 'unresolved' }], a), '');
  assert.match(prompt(prEntry('x'), [{ at: 't', provider: 'codex', result: 'notice', summary: 's' }], '/x/onduty.mjs', a), /say it is the owner's step\.\n\nTHE SAME FINDING AGAIN/);
  assert.match(noticeHeld(path.join(dir, unit)), /^unchanged: .*nothing queued/, 'a run whose note was unchanged tells the owner nothing new');
  const fresh = path.join(dir, 'factory-act-abc-3'); fs.mkdirSync(fresh);
  assert.equal(noticeHeld(fresh), '', 'a run with something new queues its notice as before');
  assert.equal(noticeHeld(''), '');
}

testCase('the chain: a backlog entry whose rung 1 run told the owner climbs to rung 2 and is never started on rung 1 again; after rung 2 it rests a day');
{
  const T = Date.parse('2026-11-24T05:06:00Z');
  const e = prEntry('2026-11-24T05:02:23Z');
  assert.equal(e.backlog, true);
  // the driver's collection after a notice: rung 3, launched, told false (driver.mjs)
  const afterNotice = tries => ({ [e.id]: { rung: 3, rungSince: T, milestone: T - 3600000 * 30, firstSeenAt: T - 3600000 * 30, launched: true, told: false, tries } });
  let adv = advance([e], afterNotice([{ rung: 1, at: 'x', provider: 'codex', result: 'notice' }]), T, { actRuns: [] });
  assert.equal(adv.chain[e.id].rung, 2, 'the other provider next');
  assert.equal(adv.actions.launch && adv.actions.launch.entry.id, e.id);
  assert.equal(adv.chain[e.id].tries.length, 1, 'and it is told what rung 1 tried');
  adv = advance([e], afterNotice([{ rung: 1, result: 'notice' }, { rung: 2, result: 'unchanged' }]), T, { actRuns: [] });
  assert.equal(adv.chain[e.id].rung, 1); assert.ok(adv.chain[e.id].cooldownUntil >= T + 24 * 3600000, 'both tried: a day\'s rest');
  assert.equal(adv.actions.launch, null);
  // "unchanged" on rung 2 is a try: the backlog entry rests a day at once and is never started meanwhile (it never reaches the owner)
  const c2 = { [e.id]: { rung: 2, rungSince: T, milestone: T - 3600000 * 30, firstSeenAt: T - 3600000 * 30, launched: true, told: false, tries: [{ rung: 1, result: 'notice' }, { rung: 2, result: 'unchanged' }] } };
  const rest = advance([e], c2, T + 5 * 60000, { actRuns: [] });
  assert.equal(rest.actions.launch, null, 'never started again');
  assert.equal(rest.chain[e.id].rung, 1); assert.ok(rest.chain[e.id].cooldownUntil >= T + 5 * 60000 + 24 * 3600000);
  const later = advance([e], rest.chain, T + 61 * 60000, { actRuns: [] });
  assert.equal(later.actions.launch, null, 'and not an hour later either');
  assert.deepEqual(later.actions.tell, []);
}

testCase('a call refused as the owner is an obstacle for an hour after the last refusal, on the record, and sends no helper');
{
  const root = tmp('obstacle');
  const actDir = path.join(root, 'acts'), helpersDir = path.join(root, 'helpers');
  const now = Date.parse('2026-11-24T05:20:00Z');
  fs.mkdirSync(path.join(actDir, 'factory-act-a0098f7db4-24'), { recursive: true });
  fs.writeFileSync(path.join(actDir, 'factory-act-a0098f7db4-24', 'guard.log'), [
    { at: '2026-11-24T05:07:19Z', tool: 'gh', args: 'pr comment 895 -R o/r --body-file n.md', why: 'as the owner', owner: true },
    { at: '2026-11-24T05:08:00Z', tool: 'gh', args: 'pr comment 895', why: 'unchanged', unchanged: true },
  ].map(x => JSON.stringify(x)).join('\n'));
  fs.mkdirSync(path.join(helpersDir, 'factory-helper-x-1'), { recursive: true });
  fs.writeFileSync(path.join(helpersDir, 'factory-helper-x-1', 'guard.log'), `${JSON.stringify({ at: '2026-11-24T05:10:00Z', tool: 'git', args: 'push origin x', why: 'owner', owner: true })}\n`);
  const obs = asOwnerObstacles({ actDir, helpersDir }, now);
  assert.deepEqual(obs.map(o => o.kind), ['as-owner', 'as-owner']);
  assert.equal(obs[0].id, obstacleId('as-owner', 'acting runs'), 'the id obstacles.mjs gives');
  assert.equal(obs[0].since, '2026-11-24T05:07:19Z');
  assert.match(obs[0].evidence[0], /1 call\(s\) of an acting run would have acted as the owner and were refused; nothing was posted or pushed under the owner's account/);
  assert.match(obs[0].evidence[1], /factory-act-a0098f7db4-24: gh pr comment 895/);
  assert.deepEqual(asOwnerObstacles({ actDir, helpersDir }, Date.parse('2026-11-24T05:07:19Z') + (AS_OWNER_MINUTES + 5) * 60000), [], 'an hour after the last refusal it is gone');
  assert.equal(nextStep(obs[0], [], { now }).do, 'wait-external', 'no helper: the refusal already stopped it');
  assert.ok(KNOWN_OBSTACLES.has('as-owner'), 'the driver\'s own: it reaches the chain only when refusals go on past its limit');
}

testCase('the factory helpers: their guard knows the owner\'s login and the obstacle\'s finding, and refuses a call made as the owner');
{
  const envList = guardedEnv({ REPO: 'o/r' }, { bin: '/w/bin', ghDir: '/w/gh', guardLog: '/w/guard.log' }, { marker: '<!-- m -->', owner: OWNER, finding: '0123456789 0123456789ab' });
  assert.ok(envList.includes(`RD_OWNER_LOGIN=${OWNER}`)); assert.ok(envList.includes('RD_FINDING=0123456789 0123456789ab'));
  const root = tmp('helper');
  const gh = fakeGitHub(root);
  const guard = path.join(path.dirname(GUARD_FILE), 'release-driver', 'release-driver-guard.mjs');
  const r = spawnSync(process.execPath, [guard, 'gh', 'pr', 'comment', '895', '-R', 'o/r', '--body', 'x <!-- m -->'], { encoding: 'utf8',
    env: asRootDid(cleanEnv({ RD_REPO: 'o/r', RD_MARKER: '<!-- m -->', RD_OWNER_LOGIN: OWNER, RD_REAL_GH: gh.realGh, RD_GUARD_LOG: path.join(root, 'guard.log') }), gh.ownerConfig) });
  assert.equal(r.status, 3); assert.match(r.stderr, /release-driver guard: refused: this call would act as MichaelZelbel/);
  assert.equal(readGuardLog(path.join(root, 'guard.log'))[0].owner, true);
  assert.deepEqual(gh.state().posts, []);
}

testCase('a factory helper\'s brief carries the obstacle\'s finding with its marker, and a note refused as unchanged makes its result "unchanged"');
{
  const root = tmp('launch');
  const env = { REPO: 'o/r', STATE_DIR: path.join(root, 'state'), WORK_ROOT: path.join(root, 'work'), FORGE_USER: 'f', NODE: process.execPath, SYSTEMD_RUN: 'x', SYSTEMCTL: 'x', CODEX_BIN: ['codex'], CLAUDE_BIN: ['claude'], FORGE_NETNS: '', HELPER_MEMORY_MAX: '1G' };
  const brief = path.join(root, 'brief.md'); fs.writeFileSync(brief, 'Every comment carries the marker `{{MARKER}}`.');
  const ob = { id: 'a146e21b33', kind: 'parked', evidence: ['needs-owner on PR #708'] };
  let envSeen = null;
  const deps = { forgeIds: () => ({ uid: 0, gid: 0 }), chown: () => {}, spawn: (f, args) => { envSeen = args.filter(x => String(x).startsWith('--setenv=')); return { status: 0, stdout: '', stderr: '' }; },
    prepare: (e, work) => { fs.mkdirSync(work, { recursive: true }); return { work, ghDir: path.join(work, 'gh'), bin: path.join(work, 'bin'), repoDir: work, guardLog: path.join(work, 'guard.log') }; } };
  await launchHelper(env, { unit: 'factory-helper-a146e21b33-1', kind: 'diagnose', provider: 'codex', model: 'm', briefFile: brief, finding: findingOf(ob) }, deps);
  const said = fs.readFileSync(path.join(env.STATE_DIR, 'helpers', 'factory-helper-a146e21b33-1', 'prompt.md'), 'utf8');
  assert.ok(said.includes(`<!-- factory-driver:factory-helper-a146e21b33-1 --> ${findingMarker(findingOf(ob))}`));
  assert.ok(envSeen.includes(`--setenv=RD_FINDING=${findingOf(ob)}`));
  const dir = path.join(env.STATE_DIR, 'helpers', 'factory-helper-a146e21b33-1');
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ cause: 'how', summary: 's' }));
  fs.writeFileSync(path.join(dir, 'exit.json'), JSON.stringify({ code: 0, at: '2026-11-24T05:00:00Z' }));
  fs.writeFileSync(path.join(dir, 'guard.log'), `${JSON.stringify({ at: 'x', tool: 'gh', why: 'unchanged: ...', unchanged: true })}\n`);
  const r = helperResult(env, 'factory-helper-a146e21b33-1', { spawn: () => ({ stdout: 'inactive' }), cleanup: () => {} });
  assert.equal(r.unchanged, true); assert.equal(r.state, 'done');
}

testCase('the App token: the release App for the run\'s repositories of one owner, the keys only in the token script\'s own environment, none without keys');
{
  const root = tmp('mint');
  const keys = path.join(root, 'keys.env'); fs.writeFileSync(keys, 'GODSPEED_RELEASE_APP_ID=1\nGODSPEED_RELEASE_APP_KEY_B64="abc"\n');
  const calls = [];
  const t = mintAppToken({ tokenScript: '/s/gh-app-token.mjs', keysFile: keys, repos: ['o/a', 'o/b'] }, (node, args, opts) => { calls.push({ args, env: opts.env }); return { status: 0, stdout: 'ghs_minted\n' }; });
  assert.equal(t, 'ghs_minted');
  assert.deepEqual(calls[0].args, ['/s/gh-app-token.mjs', 'release', 'o/a,o/b']);
  assert.equal(calls[0].env.GODSPEED_RELEASE_APP_KEY_B64, 'abc'); assert.ok(!('GH_TOKEN' in calls[0].env));
  const fallback = [];
  assert.equal(mintAppToken({ tokenScript: '/s/t.mjs', keysFile: keys, repos: ['o/a', 'o/b'] }, (n, args) => { fallback.push(args[2]); return args[2].includes(',') ? { status: 1, stdout: '' } : { status: 0, stdout: 'ghs_one' }; }), 'ghs_one');
  assert.deepEqual(fallback, ['o/a,o/b', 'o/a'], 'an App not on every repository: the item\'s own');
  assert.equal(mintAppToken({ tokenScript: '/s/t.mjs', keysFile: path.join(root, 'none'), repos: ['o/a'] }, () => { throw new Error('never asked'); }), '');
  assert.deepEqual(runRepos({ repo: 'o/x' }, { REPO: 'o/a', DEV_REPO: 'p/dev' }), ['o/x', 'o/a'], 'one owner only');
}

testCase('replay of the PR #895 morning: the 19 comments, each tried the way the run that wrote it did, leave one comment on GitHub, as the release App, none as the owner');
{
  const fx = loadFixture();
  assert.equal(fx.comments.length, 19);
  assert.deepEqual([fx.comments.filter(c => c.login === OWNER).length, fx.comments.filter(c => c.login === RELEASE_BOT).length], [5, 14], 'as GitHub has them');
  const g = replayGuard(tmp('replay-guard'));
  assert.equal(g.posts.length, 1, 'at most one comment');
  assert.equal(g.posts[0].login, RELEASE_BOT, 'none as the owner');
  assert.ok(g.posts[0].body.includes(findingMarker(g.tries[0].finding)));
  assert.equal(new Set(g.tries.map(t => t.finding)).size, 1, 'one finding all morning: the pull request did not change');
  assert.equal(g.tries.filter(t => t.refused.some(r => r.owner)).length, 5, 'every try as the owner refused');
  assert.equal(g.tries.filter(t => t.refused.some(r => r.unchanged)).length, 13, 'every repeat refused as unchanged');
}

testCase('replay of the PR #895 morning through the driver\'s rounds: two runs instead of twenty, one comment, none as the owner, the refusal an obstacle');
{
  const fx = loadFixture();
  assert.equal(fx.launches.length, 20, 'the morning had twenty runs in these twenty rounds');
  const c = await replayChain(tmp('replay-chain'));
  assert.deepEqual(c.launches.map(l => l.provider), ['codex', 'claude'], 'rung 1, then rung 2 on the other provider, then a day\'s rest');
  assert.deepEqual(c.finished.map(f => f.result), ['notice', 'unchanged']);
  assert.equal(c.posts.length, 1); assert.equal(c.posts[0].login, RELEASE_BOT);
  assert.ok(c.obstacles.includes('as-owner'), 'the second run reached for the owner\'s login: refused, and an obstacle');
  assert.ok(c.state.chain[fx.entryId].cooldownUntil >= Date.parse('2026-11-25T05:06:00Z'), 'a day\'s rest after the second run');
  assert.ok(c.decisions.some(d => d.kind === 'obstacle' && d.obstacle === 'as-owner'), 'on the record');
}
