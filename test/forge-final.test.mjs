// What the review of the three parts together found, each with its test: the coding assistant setup used reaches the
// owner-questions step (and Codex is used when setup used it); the project's facts file is written at the end of setup,
// so the owner's first "plan release" finds the project; and a step that is not working is told to the owner in plain
// words, never by its internal name. With a stand-in GitHub on 127.0.0.1, a stand-in bridge and stand-in coding
// assistants. No network, no AI.
// test cases: 4
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCase } from './cases.mjs';
import { fakeGithub, standInBridge, setUpProject, standInGh, tmpDir, assertPlain } from './forge-owner-fakes.mjs';
import * as questionsStep from '../driver/steps/owner-questions.mjs';
import * as releasesStep from '../driver/steps/owner-releases.mjs';
import { projectAgent, detectAgent, forgetDetectedAgents } from '../driver/steps/owner/agent.mjs';
import { readQuestions, factsFile } from '../driver/steps/owner/records.mjs';
import { driverAfterSetup } from '../driver/cli.mjs';
import { stepEntries } from '../driver/steps.mjs';
import { entryTellText, noticeTitle, bundleTellText } from '../driver/driver.mjs';

const gh = await fakeGithub();
const root = tmpDir('forge-final-');
const state = path.join(root, 'state');
const bridge = standInBridge();
const factoryGh = standInGh(gh);
const T = Date.parse('2026-11-23T10:00:00Z');

// A stand-in coding assistant: logs each call to <name>.log, answers `auth status`/`login status` with exit `status`,
// and prints `answer` for anything else.
function standInAgent(name, { status = 0, answer = '' } = {}) {
  const dir = tmpDir(`forge-${name}-`);
  const file = path.join(dir, name);
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');`,
    `if (args.join(' ') === 'auth status' || args.join(' ') === 'login status') process.exit(${status});`,
    `process.stdout.write(${JSON.stringify(answer)});`,
    ''
  ].join('\n'), { mode: 0o755 });
  return { file, calls: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } } };
}

testCase('the coding assistant setup used is written into the project\'s settings and used for the factory\'s questions: with Codex, Codex is asked and Claude Code never');
{
  const repository = 'acme/codex-app';
  const apps = setUpProject(state, gh, repository);
  const codex = standInAgent('codex', { answer: '{"for": "owner", "question": "Should a download come as one file?", "example": "When you download your photos, you get each one on its own.", "choices": ["You get one file with all of them.", "You keep getting each one on its own."]}' });
  const claude = standInAgent('claude', { status: 1, answer: 'not signed in' });
  gh.issue(repository, { title: 'Owner decisions needed', user: { login: `${apps.builder.slug}[bot]`, type: 'Bot' }, body: '### 1. Should the export page put the files in one zip?\nEach photo downloads on its own today.\n- (a) One zip.\n- (b) One by one.\n' });
  // the settings file setup writes: driverAfterSetup with the agent setup used
  const etc = path.join(root, 'etc-codex');
  const paths = { config: path.join(etc, 'config.json'), state };
  const notRoot = { deps: { isRoot: () => false, hasSystemd: () => true } };
  await driverAfterSetup(repository, { paths, config: { projectsRoot: path.join(root, 'projects') }, agent: 'codex', godspeed: null, platform: 'linux', uid: 0, systemd: () => true, install: notRoot });
  const projectFile = path.join(etc, 'projects', 'acme--codex-app.json');
  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  assert.equal(project.agent, 'codex');
  const settings = { owner: { github_login: 'acme' }, server: { factory_user: 'factory', factory_home: path.join(root, 'home') }, forge: { state_dir: state }, ai: { bins: { codex: codex.file, claude: claude.file } } };
  const n = bridge.sent.length;
  const r = await questionsStep.run({ settings, projects: [project], godspeed: async () => bridge, now: T, githubApi: gh.url, impl: { gh: factoryGh.command }, log: () => {} });
  assert.equal(r.ok, true, r.error);
  assert.equal(bridge.sent.length, n + 1);
  assert.match(bridge.sent.at(-1).text, /^codex-app has a question for you \(F1\)\.\nShould a download come as one file\?\n/);
  assert.equal(codex.calls().length, 1);
  assert.deepEqual(codex.calls()[0].slice(0, 2), ['exec', '--skip-git-repo-check'], 'Codex, headless');
  assert.deepEqual(claude.calls(), [], 'Claude Code was never asked');
  // an older project file without the agent gets the one setup used, and keeps everything else
  fs.writeFileSync(projectFile, JSON.stringify({ ...project, agent: undefined, trust: false }));
  await driverAfterSetup(repository, { paths, config: { projectsRoot: path.join(root, 'projects') }, agent: 'claude', godspeed: null, platform: 'linux', uid: 0, systemd: () => true, install: notRoot });
  assert.deepEqual([JSON.parse(fs.readFileSync(projectFile, 'utf8')).agent, JSON.parse(fs.readFileSync(projectFile, 'utf8')).trust], ['claude', false]);
}

testCase('the agent is the step\'s setting, else the project file\'s, else setup\'s record, else the one signed in on this server, found the way setup finds it');
{
  const repository = 'acme/which-agent';
  setUpProject(state, gh, repository);
  const none = () => null;
  assert.equal(projectAgent({}, { repository, agent: 'codex' }, state, { detect: none }), 'codex');
  assert.equal(projectAgent({ steps: { 'owner-questions': { agent: 'claude' } } }, { repository, agent: 'codex' }, state, { detect: none }), 'claude');
  assert.equal(projectAgent({}, { repository }, state, { detect: none }), null, 'nothing known: no agent, so nothing is asked');
  const registration = path.join(state, 'projects', 'acme', 'which-agent', 'registration.json');
  fs.writeFileSync(registration, JSON.stringify({ ...JSON.parse(fs.readFileSync(registration, 'utf8')), agent: 'codex' }));
  assert.equal(projectAgent({}, { repository }, state, { detect: none }), 'codex', 'setup\'s own record');
  fs.writeFileSync(registration, JSON.stringify({ repository, checkout: null, completed: true }));
  const asked = [];
  const run = (settings, cmd, args) => { asked.push([cmd, ...args].join(' ')); return { status: cmd.endsWith('codex') ? 0 : 1 }; };
  forgetDetectedAgents();
  assert.equal(projectAgent({ ai: { bins: { claude: 'claude', codex: 'codex' } } }, { repository }, state, { detect: s => detectAgent(s, run) }), 'codex');
  assert.deepEqual(asked, ['claude auth status', 'codex login status'], 'claude first, then codex, as setup asks');
  forgetDetectedAgents();
  assert.deepEqual(questionsStep.agentCommand({}, null, 'p'), null);
  assert.deepEqual(questionsStep.agentCommand({ ai: { bins: { codex: 'codex' } } }, 'codex', 'p'), ['codex', 'exec', '--skip-git-repo-check', 'p']);
  assert.deepEqual(questionsStep.agentCommand({ ai: { bins: { claude: '/nowhere/claude' } } }, 'claude', 'p'), ['claude', '-p', '--model', 'haiku', '--output-format', 'text', 'p'], 'a configured program that is not there: the one on PATH');
}

testCase('at the end of setup the project\'s facts file is written once through the bridge, so the first "plan release" finds the project; without a bridge nothing is said');
{
  const repository = 'acme/fresh';
  setUpProject(state, gh, repository);
  gh.issue(repository, { title: 'The list crashes', labels: ['bug'] });
  const etc = path.join(root, 'etc-fresh');
  const workspace = tmpDir('forge-fresh-workspace-');
  const fresh = standInBridge(workspace);
  const said = [];
  const notRoot = { deps: { isRoot: () => false, hasSystemd: () => true } };
  await driverAfterSetup(repository, { paths: { config: path.join(etc, 'config.json'), state }, config: { projectsRoot: path.join(root, 'projects') }, agent: 'claude', godspeed: fresh, githubApi: gh.url, platform: 'linux', uid: 0, systemd: () => true, install: notRoot, output: l => said.push(l) });
  const facts = fresh.json(factsFile(repository));
  assert.ok(facts, 'the facts file is there right after setup');
  assert.deepEqual([facts.repository, facts.name, facts.status, facts.newestPublicRelease, facts.openIssues.map(i => i.title)], [repository, 'fresh', 'idle', null, ['The list crashes']]);
  assert.deepEqual(fresh.sent, [], 'nothing was said to the owner');
  assert.ok(said.every(l => !/facts/i.test(l)));
  const quiet = [];
  await driverAfterSetup('acme/fresh', { paths: { config: path.join(root, 'etc-quiet', 'config.json'), state }, config: { projectsRoot: path.join(root, 'projects') }, agent: 'claude', godspeed: null, githubApi: gh.url, platform: 'linux', uid: 0, systemd: () => true, install: notRoot, output: l => quiet.push(l) });
  assert.ok(quiet.every(l => !/facts|Godspeed(?!-forge)/i.test(l)), 'without a bridge nothing is said about it');
}

testCase('a step that is not working is told to a new owner once, in plain words, never by its internal name; the first owner\'s own steps keep their words');
{
  const before = process.env.FD_ACT_RUNS_PER_DAY;
  const now = T;
  const steps = [questionsStep, releasesStep, { STEP: { name: 'plan', everyMinutes: 15, maxMinutes: 60 } }];
  const failing = { failuresInRow: 3, lastRunAt: now - 3600000, firstSeenAt: now - 7200000, lastError: 'the step failed' };
  const stepState = { steps: { 'owner-questions': { ...failing }, 'owner-releases': { ...failing, halts: { unreadable: { words: 'it could not read', since: now - 3600000 } } }, plan: { ...failing } } };
  const row = entry => ({ entry, c: { tries: [] } });
  try {
    process.env.FD_ACT_RUNS_PER_DAY = '0';
    const entries = stepEntries(stepState, steps, { budget: { act_runs_per_day: 0 }, server: { state_dir: path.join(root, 'driver') } }, now);
    assert.deepEqual(entries.map(e => e.title), ['the watch on the factory\'s questions is not working', 'the watch on your releases is not working', 'the watch on your releases has stopped', 'one of the Forge\'s jobs is not working']);
    const texts = [
      ...entries.map(e => entryTellText(row(e), now)), ...entries.map(e => noticeTitle([row(e)])),
      bundleTellText(entries.map(row), 0), noticeTitle(entries.map(row))
    ];
    assert.equal(texts[0], 'The watch on the factory\'s questions is not working right now. The Forge keeps trying.');
    assert.equal(texts[1], 'The watch on your releases is not working right now. The Forge keeps trying.');
    assert.equal(texts[3], 'One of the Forge\'s jobs is not working right now. The Forge keeps trying.');
    assert.equal(texts[5], 'The watch on your releases is not working right now');
    assert.equal(texts[8], 'The watch on the factory\'s questions, the watch on your releases and one of the Forge\'s jobs are not working right now. The Forge keeps trying.');
    assert.equal(texts[9], 'Some of the Forge\'s jobs are not working right now');
    for (const text of texts) {
      assert.doesNotMatch(text, /owner-releases|owner-questions|\bplan step\b|\bstep\b/i, `no internal name: ${text}`);
      assert.doesNotMatch(text, /nothing is (?:needed|required) from you|Mission Control/i, text);
      assertPlain(assert, text);
    }
    // the first owner's server (acting runs on): his own steps keep their words; the new steps are named plainly there too
    process.env.FD_ACT_RUNS_PER_DAY = '8';
    const his = stepEntries(stepState, steps, { budget: { act_runs_per_day: 8 }, server: { state_dir: path.join(root, 'driver') } }, now);
    assert.equal(his.find(e => e.step === 'plan').title, 'the plan step is not working');
    assert.equal(his.find(e => e.step === 'plan').forOwner, undefined);
    assert.match(entryTellText(row(his.find(e => e.step === 'plan')), now), /^the plan step is not working has not moved for \d+ hours\. Mission Control is still working on it\. It keeps trying; nothing is needed from you unless a later message says so\.$/);
    assert.equal(his.find(e => e.id === 'step:owner-releases').title, 'the watch on your releases is not working');
  } finally {
    if (before === undefined) delete process.env.FD_ACT_RUNS_PER_DAY; else process.env.FD_ACT_RUNS_PER_DAY = before;
  }
}

await gh.close();
