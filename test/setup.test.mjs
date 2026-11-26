import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, verify } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import {
  AFRESH_PARTS, answersFrom, InputClosed, loadSettings, ReportedSetupError, SetupStop, setupCommand, setupRepository, prepareCheckout,
  repositoryFromRemote, UNEXPECTED_MESSAGE
} from '../lib/setup.mjs';
import { files } from '../lib/files.mjs';
import { findSignedInAgent } from '../lib/agent.mjs';
import {
  APP_PERMISSIONS, APP_PERMISSION_DOCUMENTATION, AppSetupStop, AppStepError, builderManifest, createApps, githubAppName,
  registrationAction, releaseManifest
} from '../lib/github-apps.mjs';
import { createGithubAdapter } from '../lib/github-adapter.mjs';
import { run as runProcess } from '../lib/process.mjs';
import { ARCHON_REVISION, ARCHON_SOURCE, FACTORY_REPOSITORY, FACTORY_REVISION } from '../lib/constants.mjs';
import { credentialPath, defaults, projectStatePath, releaseCostMessage, writePrivateJson } from '../lib/config.mjs';
import { BROWSER_PASSED } from './home.mjs';
import { testCase } from './cases.mjs';
// test cases: 206

const root = await mkdtemp(join(tmpdir(), 'forge-setup-'));
const projectsRoot = join(root, 'projects');
const checkout = join(projectsRoot, 'owner', 'repo');
const state = join(root, 'state');
const messages = [];
const calls = [];
const credentials = {
  id: 12345,
  slug: 'forge-builder-secret-name',
  pem: 'PRIVATE KEY SENTINEL',
  client_secret: 'CLIENT SECRET SENTINEL',
  webhook_secret: 'WEBHOOK SECRET SENTINEL'
};
const manifests = [];
const installations = [];
async function readTree(directory) {
  const values = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) values.push(...await readTree(path));
    else values.push({ name: entry.name, contents: await readFile(path, 'utf8') });
  }
  return values;
}

const isPresent = async path => { try { await stat(path); return true; } catch { return false; } };

const run = async (command, args, options = {}) => {
  calls.push({ command, args, cwd: options.cwd });
  if (command === 'claude') return { stdout: 'signed in' };
  if (command === 'gh') {
    await mkdir(join(args.at(-1), '.git'), { recursive: true });
    return { stdout: '' };
  }
  if (command === 'git' && args[0] === 'clone') {
    await mkdir(join(args.at(-1), '.git'), { recursive: true });
    return { stdout: '' };
  }
  if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
  if (command === 'python3' && args[1] === 'init') {
    await mkdir(join(options.cwd, 'factory'), { recursive: true });
    await writeFile(join(options.cwd, 'MISSION.md'), '# Mission\n\nFactory template.\n');
    await writeFile(join(options.cwd, 'factory/consumer.py'), '# factory stand-in\n');
    await mkdir(join(options.cwd, '.factory'), { recursive: true });
    await writeFile(join(options.cwd, '.factory/consumer.json'), JSON.stringify({ source: join(root, 'cache/factory/archon', args[args.indexOf('--revision') + 1]) }));
  }
  if (command === 'python3' && args.at(-1) === 'doctor' && !(await isPresent(join(options.cwd, args[0])))) {
    throw Object.assign(new Error('Command failed'), { stderr: `python3: can't open file '${join(options.cwd, args[0])}': [Errno 2] No such file or directory\n` });
  }
  return { stdout: '' };
};
testCase('setup with Claude Code writes the mission and creates and installs both Apps');
let answer = 0;
await setupRepository('owner/repo', {
  config: { ...defaults(root), projectsRoot }, paths: { state }, commands: { run },
  github: {
    appExists: async () => false,
    begin: async manifest => { manifests.push(manifest); return { url: `https://example.test/${manifest.name}` }; },
    callback: async () => 'code', exchange: async () => credentials,
    install: async details => { installations.push(details); return true; },
    appStatus: async () => 'installed'
  },
  prompt: async () => ['Keep releases dependable.', 'Small software teams.'][answer++],
  output: value => messages.push(value)
});
const mission = await readFile(join(checkout, 'MISSION.md'), 'utf8');
assert.match(mission, /Factory template/);
assert.match(mission, /Keep releases dependable\./);
assert.match(mission, /Small software teams\./);
const initCall = calls.find(call => call.args[1] === 'init');
assert.equal(initCall.cwd, checkout);
assert.deepEqual(initCall.args.slice(1), ['init', '--source', ARCHON_SOURCE, '--revision', ARCHON_REVISION, '--cache', join(homedir(), '.cache/factory/archon')]);
assert(calls.some(call => call.args.includes(FACTORY_REVISION)));
assert.deepEqual(JSON.parse(await readFile(join(checkout, '.factory/consumer.json'), 'utf8')), { source: join(root, 'cache/factory/archon', ARCHON_REVISION) });

testCase('setup run again on a project set up with the older Archon revision moves it to the current one and keeps the old cache folder');
const olderCheckout = join(projectsRoot, 'owner', 'older');
const oldCache = join(root, 'cache/factory/archon/1cfb8fc541580fe5edf15e9a504b572bc9bb45bb');
const setupOlder = () => {
  let olderAnswer = 0;
  return setupRepository('owner/older', {
    config: { ...defaults(root), projectsRoot }, paths: { state: join(root, 'older-state') },
    commands: { run: async (command, args, options) => command === 'git' && args[0] === 'remote' ? { stdout: 'https://github.com/owner/older.git\n' } : run(command, args, options) },
    github: {
      appExists: async () => false,
      begin: async manifest => ({ url: `https://example.test/${manifest.name}` }),
      callback: async () => 'code', exchange: async () => credentials,
      install: async () => true, appStatus: async () => 'installed'
    },
    prompt: async () => ['Keep releases dependable.', 'Small software teams.'][olderAnswer++],
    output: () => {}
  });
};
await setupOlder();
await mkdir(oldCache, { recursive: true });
await writeFile(join(olderCheckout, '.factory/consumer.json'), JSON.stringify({ source: oldCache }));
await setupOlder();
assert.deepEqual(JSON.parse(await readFile(join(olderCheckout, '.factory/consumer.json'), 'utf8')), { source: join(root, 'cache/factory/archon', ARCHON_REVISION) });
assert(await isPresent(oldCache));
assert(!calls.some(call => call.args.includes('schedule')));
assert.deepEqual(messages, [
  'Using Claude Code to set up the Forge.',
  BROWSER_PASSED,
  'Create the builder App in your browser: https://example.test/Forge builder',
  'Create the release App in your browser: https://example.test/Forge release',
  'Setup is complete for owner/repo. Automatic work is off. A typical release costs about $5 to $40 of Claude Code use, based on Anthropic\'s published average of about $6 a day for one person using Claude Code, with most people under $12, and a release taking one to a few days of that work. On a Pro or Max plan this comes out of your plan\'s usage limits instead of a separate bill. The Forge adds no separate charge. This is a rough guide, not a quote: a large release can cost more. When you are ready, say "plan release repo" in your chat, then "run one lap" to watch the first change being made, then "turn on automatic work".'
]);

testCase('setup with Codex says it is using Codex');
const codexMessages = [];
let codexAnswer = 0;
await setupRepository('owner/codex-repo', {
  config: { ...defaults(root), projectsRoot }, paths: { state: join(root, 'codex-state') },
  commands: { run: async (command, args, options) => command === 'claude' ? Promise.reject(new Error('not signed in')) : run(command, args, options) },
  github: {
    appExists: async () => false,
    begin: async manifest => ({ url: `https://example.test/${manifest.name}` }),
    callback: async () => 'code', exchange: async () => credentials,
    install: async () => true,
    appStatus: async () => 'installed'
  },
  prompt: async () => ['Keep releases dependable.', 'Small software teams.'][codexAnswer++],
  output: value => codexMessages.push(value)
});
assert.deepEqual(codexMessages, [
  'Using Codex to set up the Forge.',
  BROWSER_PASSED,
  'Create the builder App in your browser: https://example.test/Forge builder',
  'Create the release App in your browser: https://example.test/Forge release',
  'Setup is complete for owner/codex-repo. Automatic work is off. A typical release costs about $3 to $25 of Codex use, based on OpenAI\'s published usage prices for the Codex models, which are lower than Claude Code\'s, and a release taking one to a few days of agent work. On a ChatGPT Plus or Pro plan this comes out of your plan\'s usage limits instead of a separate bill. The Forge adds no separate charge. This is a rough guide, not a quote: a large release can cost more. When you are ready, say "plan release codex-repo" in your chat, then "run one lap" to watch the first change being made, then "turn on automatic work".'
]);
testCase('setup messages carry at most one link and no internal names');
for (const message of [...messages, ...codexMessages]) {
  assert((message.match(/https?:\/\//g) ?? []).length <= 1);
  assert(!/factory|archon|config|token/i.test(message));
}
testCase('the release cost message names the agent, the price and its basis');

assert.equal(
  releaseCostMessage('codex', 'Codex', { codex: { low: 10, high: 15 } }),
  'A typical release costs about $10 to $15 of Codex use, based on OpenAI\'s published usage prices for the Codex models, which are lower than Claude Code\'s, and a release taking one to a few days of agent work. On a ChatGPT Plus or Pro plan this comes out of your plan\'s usage limits instead of a separate bill. The Forge adds no separate charge. This is a rough guide, not a quote: a large release can cost more.'
);
assert.equal(
  releaseCostMessage('claude', 'Claude Code', { message: 'About ${low}-${high} on {agent} ({basis}).', claude: { basis: 'measured releases' } }),
  'About $5-$40 on Claude Code (measured releases).'
);
testCase('each App asks only for the permissions it needs and is installed on the repository');
assert.equal(manifests.length, 2);
assert.deepEqual(manifests[0].default_permissions, APP_PERMISSIONS.builder);
assert.deepEqual(manifests[1].default_permissions, APP_PERMISSIONS.release);
assert.equal(installations.length, 2);
assert.deepEqual(installations.map(value => [value.kind, value.repository]), [['builder', 'owner/repo'], ['release', 'owner/repo']]);
for (const manifest of manifests) {
  for (const forbidden of ['administration', 'secrets', 'members', 'workflows', 'deployments']) {
    assert.equal(manifest.default_permissions[forbidden], undefined);
  }
}
for (const kind of ['builder', 'release']) {
  const path = join(state, 'credentials/owner/repo', `${kind}-app.json`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), credentials);
  await assert.rejects(stat(join(state, 'projects/owner/repo', `${kind}-app.json`)));
  assert.deepEqual(JSON.parse(await readFile(join(state, 'projects/owner/repo', `${kind}-installation.json`), 'utf8')), {
    repository: 'owner/repo', confirmed: true
  });
}
testCase('App keys are saved privately and no secret reaches the project state, mission or messages');
assert.deepEqual((await readdir(join(state, 'credentials/owner/repo'))).sort(), ['builder-app.json', 'release-app.json']);
const projectState = (await readTree(join(state, 'projects/owner/repo')))
  .map(file => `${file.name}\n${file.contents}`).join('\n');
assert(!projectState.includes('"code"'));
for (const [field, secret] of Object.entries(credentials)) {
  assert(!projectState.includes(`"${field}"`));
  assert(!projectState.includes(String(secret)));
  assert(!mission.includes(String(secret)));
  assert(!messages.join('\n').includes(String(secret)));
}

testCase('the README documents the App permissions and the App page address follows the owner type');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
assert(readme.includes(APP_PERMISSION_DOCUMENTATION));
assert.equal(registrationAction('owner', false), 'https://github.com/settings/apps/new');
assert.equal(registrationAction('owner', true), 'https://github.com/organizations/owner/settings/apps/new');

for (const [manifest, answer, action, permissions] of [
  [builderManifest('owner/repo'), 'yes', 'https://github.com/organizations/owner/settings/apps/new', {
    contents: 'write', pull_requests: 'write', issues: 'write', actions: 'write',
    checks: 'read', statuses: 'read', metadata: 'read'
  }],
  [releaseManifest('owner/repo'), 'no', 'https://github.com/settings/apps/new', {
    contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read'
  }]
]) {
  testCase(`the App page posts the ${manifest.name} manifest to ${action}`);
  const github = createGithubAdapter({ input: { question: async () => answer } });
  const flow = await github.begin(manifest);
  const page = Buffer.from(flow.url.split(',')[1], 'base64').toString('utf8');
  assert.match(page, new RegExp(`action="${action}"`));
  const encodedManifest = page.match(/name="manifest" value="([^"]+)"/)[1];
  const submittedManifest = JSON.parse(encodedManifest.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  assert.deepEqual(submittedManifest.default_permissions, permissions);
  // GitHub refuses a manifest with a hook address it cannot reach from the internet, even an inactive one.
  assert.equal('hook_attributes' in submittedManifest, false);
  // GitHub App names are unique across GitHub: the posted name carries the owner and project.
  assert.equal(submittedManifest.name, `${manifest.name} owner repo`);
  assert.equal('githubName' in submittedManifest, false);
  assert.deepEqual(submittedManifest.default_events, []);
}

// The organization question takes only yes or no, in any case and with spaces around it; any other answer is
// asked again with one sentence, and opens no App page (#103).
const appPageAction = flow => Buffer.from(flow.url.split(',')[1], 'base64').toString('utf8').match(/action="([^"]+)"/)[1];
for (const [answers, action, retries] of [
  [[' YES '], 'https://github.com/organizations/owner/settings/apps/new', 0],
  [['No'], 'https://github.com/settings/apps/new', 0],
  [['y', 'yes'], 'https://github.com/organizations/owner/settings/apps/new', 1],
  [['n', 'maybe', '', '  ', 'no'], 'https://github.com/settings/apps/new', 4]
]) {
  testCase(`the organization answers ${JSON.stringify(answers)} open ${action} after ${retries} repeated questions`);
  const asked = [];
  const said = [];
  const queue = [...answers];
  const github = createGithubAdapter({
    input: { question: async text => { asked.push(text); return queue.shift(); } },
    output: line => said.push(line)
  });
  assert.equal(appPageAction(await github.begin(builderManifest('owner/repo'))), action);
  assert.equal(queue.length, 0);
  assert.deepEqual(asked, Array(retries + 1).fill('Type yes if owner is a GitHub organization, or no if it is your personal account: '));
  assert.deepEqual(said, Array(retries).fill('Setup expects yes or no here, so it asks again.'));
}

for (const [env, base] of [[{}, 'https://api.github.com'], [{ FORGE_GITHUB_API_URL: '' }, 'https://api.github.com'], [{ FORGE_GITHUB_API_URL: 'http://127.0.0.1:9/' }, 'http://127.0.0.1:9']]) {
  testCase(`the GitHub adapter asks ${base} when FORGE_GITHUB_API_URL is ${JSON.stringify(env.FORGE_GITHUB_API_URL)}`);
  const asked = [];
  const github = createGithubAdapter({
    input: { question: async () => 'yes' }, env,
    fetch: async url => { asked.push(url); return { status: 200, ok: true, json: async () => ({}) }; }
  });
  await github.exchange('a code');
  assert.deepEqual(asked, [`${base}/app-manifests/a%20code/conversions`]);
}

testCase('a typed y then yes at the organization question opens the organization App page');
{
  const typed = new PassThrough();
  const shown = new PassThrough();
  let screen = '';
  shown.on('data', data => { screen += data; });
  const readline = createInterface({ input: typed, output: shown, terminal: true });
  const said = [];
  const github = createGithubAdapter({ input: answersFrom(readline), output: line => said.push(line) });
  const flow = github.begin(builderManifest('owner/repo'));
  const typedAnswers = ['y', 'yes'];
  const typeNext = async () => {
    for (let wait = 0; wait < 200 && !screen.trimEnd().endsWith('personal account:'); wait += 1) await new Promise(resolve => setTimeout(resolve, 5));
    screen = '';
    typed.write(`${typedAnswers.shift()}\r`);
  };
  await typeNext();
  await typeNext();
  assert.equal(appPageAction(await flow), 'https://github.com/organizations/owner/settings/apps/new');
  assert.deepEqual(said, ['Setup expects yes or no here, so it asks again.']);
  readline.close();
}

testCase('input that ends while the organization question waits for yes or no stops it and opens no App page');
{
  const said = [];
  const queue = ['maybe'];
  let asked = 0;
  const github = createGithubAdapter({
    input: { question: async () => { asked += 1; if (queue.length) return queue.shift(); throw new InputClosed(); } },
    output: line => said.push(line)
  });
  await assert.rejects(github.begin(builderManifest('owner/repo')), error => error instanceof InputClosed);
  assert.equal(asked, 2);
  assert.deepEqual(said, ['Setup expects yes or no here, so it asks again.']);
}

testCase('repository names are read from every GitHub remote form and kept apart in state');
assert.equal(repositoryFromRemote('https://github.com/Owner/Repo.git'), 'owner/repo');
assert.equal(repositoryFromRemote('git@github.com:owner/repo.git'), 'owner/repo');
assert.equal(repositoryFromRemote('ssh://git@github.com/owner/repo.git'), 'owner/repo');
assert.equal(repositoryFromRemote('https://github.com/not-owner/repo.git'), 'not-owner/repo');
assert.equal(projectStatePath(state, 'owner/repo'), join(state, 'projects/owner/repo'));
assert.equal(credentialPath(state, 'owner/repo'), join(state, 'credentials/owner/repo'));
assert.notEqual(projectStatePath(state, 'owner--repo/name'), projectStatePath(state, 'owner/repo--name'));
testCase('an existing copy of the same repository is used as it is');
const existing = join(root, 'existing', 'owner', 'repo');
await mkdir(join(existing, '.git'), { recursive: true });
await prepareCheckout('owner/repo', join(root, 'existing'), {
  run: async () => ({ stdout: 'git@github.com:owner/repo.git\n' })
}, () => { throw new Error('must not stop'); });

testCase('a signed-out Claude Code falls back to a signed-in Codex');
const probes = [];
assert.equal(await findSignedInAgent(async command => {
  probes.push(command);
  if (command === 'claude') throw new Error('not signed in');
  return { stdout: 'signed in' };
}), 'codex');
assert.deepEqual(probes, ['claude', 'codex']);

testCase('a failing final check stops with the fallback message and saves no registration');
const failedMessages = [];
let failedAnswer = 0;
await assert.rejects(setupRepository('owner/failing-doctor', {
  config: { projectsRoot, costMessage: 'Cost notice.' }, paths: { state }, commands: {
    run: async (command, args, options = {}) => {
      if (command === 'claude') return { stdout: 'signed in' };
      if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
      if (command === 'python3' && args[1] === 'init') {
        await mkdir(join(options.cwd, 'factory'), { recursive: true });
        await writeFile(join(options.cwd, 'MISSION.md'), '# Mission\n');
        return { stdout: '' };
      }
      if (command === 'python3' && args.at(-1) === 'doctor') throw new Error('doctor output must stay private');
      return { stdout: '' };
    }
  },
  github: {
    appExists: async () => false,
    begin: async () => ({ url: 'https://example.test/create' }), callback: async () => 'code', exchange: async () => credentials,
    install: async () => true,
    appStatus: async () => 'installed'
  },
  prompt: async () => ['Purpose.', 'Users.'][failedAnswer++], output: value => failedMessages.push(value)
}), error => error instanceof ReportedSetupError && error.message === 'final-check');
const FINAL_CHECK_FALLBACK = 'Setup stopped because the final check could not confirm that the build tools setup installed on this server work. Try setup again.';
assert.deepEqual(failedMessages.at(-1), FINAL_CHECK_FALLBACK);
await assert.rejects(stat(join(state, 'projects/owner/failing-doctor/registration.json')));
assert(!failedMessages.some(message => message.includes('schedule')));

testCase('a refused final check stops plainly before any App exists and the retry creates each App once');
const retryRun = async (command, args, options = {}) => {
  if (command === 'claude') return { stdout: 'signed in' };
  if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
  if (command === 'git' && args[0] === 'remote') return { stdout: 'git@github.com:owner/retry-check.git\n' };
  if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
  if (command === 'python3' && args[1] === 'init') {
    await mkdir(join(options.cwd, 'factory'), { recursive: true });
    await writeFile(join(options.cwd, 'MISSION.md'), '# Mission\n');
    return { stdout: '' };
  }
  if (command === 'python3' && args.at(-1) === 'doctor') {
    if (retryCheckPasses) return { stdout: '{}' };
    throw Object.assign(new Error('python3 failed.'), {
      stderr: 'Factory refused: Holdout fence is open: a builder reading the scenarios exited 127, expected 2. '
        + '/bin/sh: 1: python: not found (check that `python` runs Python 3 in bash)\n'
        + 'Traceback (most recent call last):\n  File "/srv/forge/factory/consumer.py", line 244\n'
        + 'TOKEN SENTINEL ghs_report_secret'
    });
  }
  return { stdout: '' };
};
let retryCheckPasses = false;
let retryBegins = 0;
let retryInstalls = 0;
const retryOptions = output => {
  let retryAnswer = 0;
  return {
    config: { ...defaults(root), projectsRoot }, paths: { state }, commands: { run: retryRun },
    github: {
      exists: async path => { try { await stat(path); return true; } catch { return false; } },
      appExists: async () => false,
      begin: async manifest => { retryBegins += 1; return { url: `https://example.test/${manifest.name}` }; },
      callback: async () => 'code', exchange: async () => credentials,
      install: async () => { retryInstalls += 1; return true; },
      appStatus: async () => 'installed'
    },
    prompt: async () => ['Purpose.', 'Users.'][retryAnswer++],
    output
  };
};
const retryFailed = [];
await assert.rejects(setupRepository('owner/retry-check', retryOptions(value => retryFailed.push(value))),
  error => error instanceof ReportedSetupError && error.message === 'final-check');
assert.deepEqual(retryFailed, [
  'Using Claude Code to set up the Forge.',
  BROWSER_PASSED,
  'Setup stopped because the final check found that the guard keeping your project\'s hidden test scenarios away from the coding agent does not work on this server, because the python command there does not run Python 3. Install the python-is-python3 package on this server before trying setup again.'
]);
for (const hidden of ['Factory refused', 'Holdout fence', 'consumer.py', 'Traceback', 'ghs_report_secret', 'report']) {
  assert(!retryFailed.some(message => message.includes(hidden)), hidden);
}
assert(retryFailed.at(-1).split('http').length - 1 <= 1);
await assert.rejects(stat(join(state, 'projects/owner/retry-check/registration.json')));
assert.equal(retryBegins, 0, 'a stop at the final check creates no App');
assert.equal(retryInstalls, 0);
const installsBeforeRetry = retryInstalls;

retryCheckPasses = true;
const retryPassed = [];
assert.deepEqual(
  await setupRepository('owner/retry-check', retryOptions(value => retryPassed.push(value))),
  { completed: true, checkout: join(projectsRoot, 'owner/retry-check'), agent: 'claude' },
  'setup says which coding assistant it used, for the driver\'s settings'
);
assert.deepEqual(retryPassed, [
  'Using Claude Code to set up the Forge.',
  BROWSER_PASSED,
  'Create the builder App in your browser: https://example.test/Forge builder',
  'Create the release App in your browser: https://example.test/Forge release',
  'Setup is complete for owner/retry-check. Automatic work is off. A typical release costs about $5 to $40 of Claude Code use, based on Anthropic\'s published average of about $6 a day for one person using Claude Code, with most people under $12, and a release taking one to a few days of that work. On a Pro or Max plan this comes out of your plan\'s usage limits instead of a separate bill. The Forge adds no separate charge. This is a rough guide, not a quote: a large release can cost more. When you are ready, say "plan release retry-check" in your chat, then "run one lap" to watch the first change being made, then "turn on automatic work".'
]);
assert.equal(retryBegins, 2);
assert.equal(retryInstalls, 2);
assert.deepEqual(JSON.parse(await readFile(join(state, 'projects/owner/retry-check/registration.json'), 'utf8')), { repository: 'owner/retry-check', checkout: join(projectsRoot, 'owner/retry-check'), completed: true, agent: 'claude' }, 'the record of the finished setup keeps the coding assistant it used');

testCase('stopping at the final check again and again creates no App until it passes');
const appsKeptState = join(root, 'apps-kept-state');
const appsKeptProjects = join(root, 'apps-kept-projects');
// The kept-Apps line when only the builder App (named as in the stand-in's credentials, or by default) exists.
const builderKept = name => `Setup kept the details of your GitHub App "${name}" for this repository on this server. Trying setup again checks whether it is still on your GitHub account and uses it if it is, instead of creating a new one.`;
const APPS_KEPT_MESSAGE = 'Setup kept the details of your two GitHub Apps for this repository, "Acme Forge builder" and "Acme Forge release", on this server. Trying setup again checks whether they are still on your GitHub account and uses each one that is, instead of creating a new one.';
let appsKeptCheckPasses = false;
const appsKeptBegins = {};
const appsKeptOptions = output => {
  let appsKeptAnswer = 0;
  return {
    config: { ...defaults(root), projectsRoot: appsKeptProjects }, paths: { state: appsKeptState },
    commands: {
      run: async (command, args, options = {}) => {
        if (command === 'git' && args[0] === 'remote') return { stdout: 'git@github.com:owner/apps-kept.git\n' };
        if (command === 'python3' && args.at(-1) === 'doctor') {
          if (appsKeptCheckPasses) return { stdout: '{}' };
          throw new Error('doctor failed');
        }
        return retryRun(command, args, options);
      }
    },
    github: {
      exists: async path => { try { await stat(path); return true; } catch { return false; } },
      appExists: async () => false,
      begin: async manifest => {
        appsKeptBegins[manifest.name] = (appsKeptBegins[manifest.name] ?? 0) + 1;
        return { url: `https://example.test/${manifest.name}`, name: manifest.name };
      },
      callback: async flow => flow.name,
      exchange: async name => ({ ...credentials, name: name === 'Forge builder' ? 'Acme Forge builder' : 'Acme Forge release' }),
      install: async () => true,
      appStatus: async () => 'installed'
    },
    prompt: async () => ['Purpose.', 'Users.'][appsKeptAnswer++],
    output
  };
};
const appsKeptFirst = [];
await assert.rejects(setupRepository('owner/apps-kept', appsKeptOptions(value => appsKeptFirst.push(value))),
  error => error instanceof ReportedSetupError && error.message === 'final-check');
assert.deepEqual(appsKeptFirst, ['Using Claude Code to set up the Forge.', BROWSER_PASSED, FINAL_CHECK_FALLBACK]);
const appsKeptSecond = [];
await assert.rejects(setupRepository('owner/apps-kept', appsKeptOptions(value => appsKeptSecond.push(value))),
  error => error instanceof ReportedSetupError && error.message === 'final-check');
assert.deepEqual(appsKeptSecond, appsKeptFirst);
assert.deepEqual(appsKeptBegins, {});
appsKeptCheckPasses = true;
const appsKeptPassed = [];
await setupRepository('owner/apps-kept', appsKeptOptions(value => appsKeptPassed.push(value)));
assert(appsKeptPassed.at(-1).startsWith('Setup is complete for owner/apps-kept.'));
assert(!appsKeptPassed.includes(APPS_KEPT_MESSAGE));
assert.deepEqual(appsKeptBegins, { 'Forge builder': 1, 'Forge release': 1 });

testCase('a failing command keeps its output and its error text');
await assert.rejects(
  runProcess(process.execPath, ['-e', 'process.stdout.write("partial"); process.stderr.write("check said no"); process.exit(1)']),
  error => error.message === `${process.execPath} failed.` && error.stderr === 'check said no' && error.stdout === 'partial'
);

// Every refusal the pinned factory's doctor can raise, in its real report text, gets a message naming
// what the check found and the one action that fixes it.
const buildToolsCache = join(root, `cache/factory/archon/${ARCHON_REVISION}`);
const scenariosFolder = ['.factory', 'holdout', ''].join('/');
const found = 'Setup stopped because the final check found that';
const guard = 'the guard keeping your project\'s hidden test scenarios away from the coding agent';
const PYTHON_COMMAND = `${found} ${guard} does not work on this server, because the python command there does not run Python 3. Install the python-is-python3 package on this server before trying setup again.`;
const GUARD_OPEN = `${found} ${guard} lets the coding agent read those scenarios on this server. Try setup again, which reinstalls the guard.`;
const GUARD_MISSING = `${found} ${guard} is not fully installed in the project. Try setup again, which installs it.`;
const SETTINGS = `${found} the project's record of which build tools to use is missing or damaged. Try setup again, which writes that record again.`;
const SOURCE_DAMAGED = `${found} the copy of the build tools that setup downloaded to this server is incomplete or has been changed. Try setup again, which replaces it with a fresh download.`;
const SOURCE_MISSING = `${found} the copy of the build tools that setup downloaded to this server is missing or damaged. Try setup again, which downloads it again.`;
const TOOLS_FAIL = `${found} the build tools fail when they run on this server. Try setup again, which replaces them with a fresh download.`;
const PIN_INCOMPLETE = `${found} the version of the build tools this Forge installs is missing parts that automatic work needs. Install the latest version of the Forge on this server before trying setup again.`;
const refusal = text => `Factory refused: ${text}\n`;
const refusalCases = [
  [refusal('Holdout fence is open: a builder reading the scenarios exited 127, expected 2. /bin/sh: 1: python: not found (check that `python` runs Python 3 in bash)'), PYTHON_COMMAND],
  [refusal('Holdout fence is open: a builder reading the scenarios exited 1, expected 2. SyntaxError: invalid syntax (check that `python` runs Python 3 in bash)'), PYTHON_COMMAND],
  [refusal('Holdout fence is open: a builder reading the scenarios exited 0, expected 2.  (check that `python` runs Python 3 in bash)'), GUARD_OPEN],
  [refusal('Holdout fence not registered in .claude/settings.json for PreToolUse, PostToolUse; rerun factory init'), GUARD_MISSING],
  [refusal(`.ignore does not list ${scenariosFolder}; rerun factory init`), GUARD_MISSING],
  [refusal('No bash to run the holdout fence the way Claude Code runs hooks'), `${found} the bash shell is not installed on this server. Install bash before trying setup again.`],
  [refusal('Integration pin required. Run factory init --source <complete Archon checkout or URL> --revision <40-character SHA> --cache <directory>.'), SETTINGS],
  [refusal('Invalid consumer settings: /srv/project/consumer.json'), SETTINGS],
  [refusal("'source'"), SETTINGS],
  [refusal('Integration revision must be a full lowercase commit SHA'), SETTINGS],
  [refusal(`Pinned source has changes (bun.lock). The pinned tree is verified byte for byte. Restore it with: rm -rf ${buildToolsCache} && python3 bin/factory.py init from your repo.`), SOURCE_DAMAGED],
  [refusal(`Source SHA mismatch: expected ${ARCHON_REVISION}, found 0000000000000000000000000000000000000000`), SOURCE_DAMAGED],
  [refusal('Untracked authoring file in pinned source: /srv/cache/.archon/workflows/extra.yaml'), SOURCE_DAMAGED],
  [refusal('Incomplete Archon source: missing packages/cli/src/cli.ts'), SOURCE_DAMAGED],
  [refusal('Archon dependencies missing; complete the pinned source installation'), SOURCE_DAMAGED],
  [refusal("Pinned CLI missing workflow run capability: ['--workflow-source', '--input', '--adopt', '--detach', '--json']"), PIN_INCOMPLETE],
  [refusal('Incomplete integration source; missing shared workflows: archon-loop, archon-manager'), PIN_INCOMPLETE],
  [refusal("Workflow/command validation failed for archon-loop: {'results': []}"), PIN_INCOMPLETE],
  [refusal("Native workflow discovery errors: ['bad yaml']"), PIN_INCOMPLETE],
  [refusal("[Errno 2] No such file or directory: 'bun'"), `${found} the bun program the build tools need is not installed on this server. Install bun before trying setup again.`],
  [refusal("Command '['/usr/bin/bun', 'cli.ts', 'workflow', '--help']' timed out after 180 seconds"), `${found} the build tools did not answer in time. Try setup again.`],
  [refusal(`[Errno 2] No such file or directory: PosixPath('${buildToolsCache}')`), SOURCE_MISSING],
  [refusal(`[Errno 20] Not a directory: PosixPath('${buildToolsCache}')`), SOURCE_MISSING],
  [refusal(`Command exited 128: ['git', 'rev-parse', 'HEAD']\nfatal: not a git repository (or any of the parent directories): .git`), SOURCE_DAMAGED],
  [refusal(`Command exited 128: ['git', 'status', '--porcelain']\nfatal: not a git repository (or any of the parent directories): .git`), SOURCE_DAMAGED],
  [refusal(`Command exited 1: ['bun', '${buildToolsCache}/packages/cli/src/cli.ts', 'workflow']\nerror: Cannot find module '@archon/core'`), TOOLS_FAIL],
  [refusal(`Command exited 139: ['/usr/local/bin/bun', '${buildToolsCache}/packages/cli/src/cli.ts', 'trigger']\nSegmentation fault`), TOOLS_FAIL],
  ['Traceback (most recent call last):\n  File "factory/consumer.py", line 115\nAttributeError: \'PosixPath\' object has no attribute \'is_relative_to\'\n',
    `${found} the Python on this server is too old to run the build tools. Install Python 3.9 or newer before trying setup again.`]
];
for (const [index, [report, expected]] of refusalCases.entries()) {
  testCase(`final-check refusal ${index + 1} gets its own message`);
  const repository = `owner/check-${index}`;
  const outputs = [];
  let answer = 0;
  await assert.rejects(setupRepository(repository, {
    config: { ...defaults(root), projectsRoot }, paths: { state }, commands: {
      run: async (command, args, options = {}) => {
        if (command === 'claude') return { stdout: 'signed in' };
        if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
        if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
        if (command === 'python3' && args[1] === 'init') {
          await mkdir(join(options.cwd, '.factory'), { recursive: true });
          await writeFile(join(options.cwd, '.factory', 'consumer.json'), JSON.stringify({ source: buildToolsCache }));
          await writeFile(join(options.cwd, 'MISSION.md'), '# Mission\n');
          return { stdout: '' };
        }
        if (command === 'python3' && args.at(-1) === 'doctor') {
          // The last case's report reaches setup on standard output, to show both streams are read.
          throw Object.assign(new Error('python3 failed.'), index === refusalCases.length - 1
            ? { stdout: report, stderr: '' } : { stderr: `${report}TOKEN SENTINEL ghs_report_secret\n` });
        }
        return { stdout: '' };
      }
    },
    github: { appExists: async () => false, begin: async () => ({ url: 'https://example.test/create' }), callback: async () => 'code', exchange: async () => credentials, install: async () => true, appStatus: async () => 'installed' },
    prompt: async () => ['Purpose.', 'Users.'][answer++],
    output: value => outputs.push(value)
  }), error => error instanceof ReportedSetupError && error.message === 'final-check', repository);
  assert.equal(outputs.at(-1), expected, report);
  for (const hidden of ['Factory refused', 'Holdout fence', 'consumer', 'Traceback', 'ghs_report_secret', 'report', 'Archon', 'Errno',
    'PosixPath', 'Command exited', 'fatal', 'rev-parse', 'cli.ts', 'Segmentation', 'archon', 'cache', 'output', 'Delete', root]) {
    assert(!outputs.at(-1).includes(hidden), `${hidden} in: ${outputs.at(-1)}`);
  }
  // No message names a server path.
  assert.deepEqual(outputs.at(-1).match(/\/\S*/g) ?? [], [], outputs.at(-1));
}
testCase('every final-check refusal has a different message');
assert.equal(new Set(refusalCases.map(([, expected]) => expected)).size, 12);

// When the final check finds the downloaded build tools missing, damaged or failing, trying setup again
// replaces that download with no step by hand. The stand-in install downloads the build tools only when their
// folder is not there, as the pinned factory's install does, so a damaged copy is fixed only if setup deletes it.
const replaceCases = [
  ['deleted-folder', folder => rm(folder, { recursive: true, force: true }),
    folder => `[Errno 2] No such file or directory: PosixPath('${folder}')`, SOURCE_MISSING],
  ['folder-is-file', async folder => { await rm(folder, { recursive: true, force: true }); await writeFile(folder, 'not a folder'); },
    folder => `[Errno 20] Not a directory: PosixPath('${folder}')`, SOURCE_MISSING],
  ['git-in-download', folder => writeFile(join(folder, 'damaged'), ''),
    () => "Command exited 128: ['git', 'rev-parse', 'HEAD']\nfatal: not a git repository (or any of the parent directories): .git", SOURCE_DAMAGED],
  ['build-tools-fail', folder => writeFile(join(folder, 'damaged'), ''),
    folder => `Command exited 1: ['bun', '${folder}/packages/cli/src/cli.ts', 'workflow']\nerror: Cannot find module '@archon/core'`, TOOLS_FAIL],
  ['changed-download', folder => writeFile(join(folder, 'damaged'), ''),
    folder => `Pinned source has changes (damaged). The pinned tree is verified byte for byte. Restore it with: rm -rf ${folder} && python3 bin/factory.py init from your repo.`, SOURCE_DAMAGED]
];
for (const [name, damage, report, expected] of replaceCases) {
  testCase(`trying again replaces a build tools download that is ${name}`);
  const repository = `owner/replace-${name}`;
  const caseRoot = join(root, `replace-${name}`);
  const download = join(caseRoot, `cache/factory/archon/${ARCHON_REVISION}`);
  let downloads = 0;
  let checks = 0;
  const options = outputs => {
    let answer = 0;
    return {
      config: { ...defaults(root), projectsRoot: join(caseRoot, 'projects') }, paths: { state: join(caseRoot, 'state') },
      commands: {
        run: async (command, args, runOptions = {}) => {
          if (command === 'git' && args[0] === 'remote') return { stdout: `git@github.com:${repository}.git\n` };
          if (command === 'python3' && args[1] === 'init') {
            await mkdir(join(runOptions.cwd, '.factory'), { recursive: true });
            await writeFile(join(runOptions.cwd, '.factory', 'consumer.json'), JSON.stringify({ source: download }));
            await writeFile(join(runOptions.cwd, 'MISSION.md'), '# Mission\n');
            const present = await stat(download).then(() => true, () => false);
            if (!present) {
              await mkdir(download, { recursive: true });
              downloads += 1;
            }
            return { stdout: '' };
          }
          if (command === 'python3' && args.at(-1) === 'doctor') {
            checks += 1;
            if (checks === 1) await damage(download);
            const whole = await stat(download).then(entry => entry.isDirectory(), () => false)
              && !(await stat(join(download, 'damaged')).then(() => true, () => false));
            if (whole) return { stdout: '{}' };
            throw Object.assign(new Error('python3 failed.'), { stderr: `Factory refused: ${report(download)}\n` });
          }
          return retryRun(command, args, runOptions);
        }
      },
      github: { appExists: async () => false, begin: async () => ({ url: 'https://example.test/create' }), callback: async () => 'code', exchange: async () => credentials, install: async () => true, appStatus: async () => 'installed' },
      prompt: async () => ['Purpose.', 'Users.'][answer++],
      output: value => outputs.push(value)
    };
  };
  const first = [];
  await assert.rejects(setupRepository(repository, options(first)),
    error => error instanceof ReportedSetupError && error.message === 'final-check', name);
  assert.equal(first.at(-1), expected, name);
  assert.equal(downloads, 1, name);
  const second = [];
  await setupRepository(repository, options(second));
  assert(second.at(-1).startsWith(`Setup is complete for ${repository}.`), `${name}: ${second.at(-1)}`);
  assert.equal(downloads, 2, name);
  assert.equal(checks, 2, name);
  assert((await stat(download)).isDirectory(), name);
  assert(!(await readdir(join(caseRoot, 'state'), { recursive: true })).some(entry => entry.endsWith('replace-build-tools.json')), name);
}

testCase('a refusal not about the download leaves it alone, and only download folders are deleted');
// A refusal that is not about the download leaves the download alone on retry, and a recorded folder that is
// not a download folder named with its revision is never deleted.
{
  const caseRoot = join(root, 'replace-other');
  const repository = 'owner/replace-other';
  const download = join(caseRoot, `cache/factory/archon/${ARCHON_REVISION}`);
  const keep = join(caseRoot, 'keep');
  await mkdir(download, { recursive: true });
  await mkdir(keep, { recursive: true });
  let checks = 0;
  const run = (source, report) => async (command, args, runOptions = {}) => {
    if (command === 'git' && args[0] === 'remote') return { stdout: `git@github.com:${repository}.git\n` };
    if (command === 'python3' && args[1] === 'init') {
      await mkdir(join(runOptions.cwd, '.factory'), { recursive: true });
      await writeFile(join(runOptions.cwd, '.factory', 'consumer.json'), JSON.stringify({ source }));
      await writeFile(join(runOptions.cwd, 'MISSION.md'), '# Mission\n');
      return { stdout: '' };
    }
    if (command === 'python3' && args.at(-1) === 'doctor') {
      checks += 1;
      throw Object.assign(new Error('python3 failed.'), { stderr: `Factory refused: ${report}\n` });
    }
    return retryRun(command, args, runOptions);
  };
  for (const [source, report] of [
    [download, 'No bash to run the holdout fence the way Claude Code runs hooks'],
    [download, 'No bash to run the holdout fence the way Claude Code runs hooks'],
    [keep, "Command exited 128: ['git', 'rev-parse', 'HEAD']"],
    [keep, "Command exited 128: ['git', 'rev-parse', 'HEAD']"]
  ]) {
    let answer = 0;
    await assert.rejects(setupRepository(repository, {
      config: { ...defaults(root), projectsRoot: join(caseRoot, 'projects') }, paths: { state: join(caseRoot, 'state') },
      commands: { run: run(source, report) },
      github: { appExists: async () => false, begin: async () => ({ url: 'https://example.test/create' }), callback: async () => 'code', exchange: async () => credentials, install: async () => true, appStatus: async () => 'installed' },
      prompt: async () => ['Purpose.', 'Users.'][answer++],
      output: () => {}
    }), error => error instanceof ReportedSetupError && error.message === 'final-check');
  }
  assert.equal(checks, 4);
  assert((await stat(download)).isDirectory());
  assert((await stat(keep)).isDirectory());
}

testCase('a GitHub connection that fails stops after the final check passed');
const githubFailureMessages = [];
const githubFailureCalls = [];
await assert.rejects(setupRepository('owner/failing-github', {
  config: { projectsRoot, costMessage: 'Cost notice.' }, paths: { state }, commands: {
    run: async (command, args, options = {}) => {
      githubFailureCalls.push({ command, args });
      if (command === 'claude') return { stdout: 'signed in' };
      if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
      if (command === 'python3' && args[1] === 'init') {
        await mkdir(join(options.cwd, 'factory'), { recursive: true });
        await writeFile(join(options.cwd, 'MISSION.md'), '# Mission\n');
      }
      return { stdout: '' };
    }
  },
  github: { appExists: async () => false, begin: async () => { throw new Error('private GitHub detail'); } },
  prompt: async () => { throw new Error('must not prompt'); },
  output: value => githubFailureMessages.push(value)
}), error => error instanceof ReportedSetupError && error.message === 'github');
assert.deepEqual(githubFailureMessages.at(-1), 'Setup stopped because the GitHub connection was not completed. Complete the GitHub page before trying setup again.');
assert(!githubFailureCalls.some(call => call.args.includes('schedule')));
await assert.rejects(stat(join(state, 'projects/owner/failing-github/registration.json')));

testCase('leaving the builder App page unfinished stops plainly');
// The two GitHub App stops with their own cause: the owner leaves the App page unfinished (the real
// adapter receives an address without GitHub's code), and setup cannot save the App GitHub handed over.
const appStepRun = (command, args, options = {}) => {
  if (command === 'claude') return { stdout: 'signed in' };
  if (command === 'gh') return mkdir(join(args.at(-1), '.git'), { recursive: true }).then(() => ({ stdout: '' }));
  if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
  return { stdout: '' };
};
const abandonedOutputs = [];
const abandonedAdapter = createGithubAdapter({
  input: { question: async question => question.startsWith('Type yes if') ? 'no' : 'https://github.com/settings/apps/new\n' },
  fetch: async () => { throw new Error('must not ask GitHub for an App without a code'); },
  output: value => abandonedOutputs.push(value)
});
await assert.rejects(setupRepository('owner/abandoned-page', {
  config: { projectsRoot, costMessage: 'Cost notice.' }, paths: { state }, commands: { run: async (...call) => appStepRun(...call) },
  github: { ...abandonedAdapter, appExists: async () => false, begin: async manifest => { await abandonedAdapter.begin(manifest); return { url: 'https://example.test/create' }; } },
  prompt: async () => { throw new Error('must not prompt'); },
  output: value => abandonedOutputs.push(value)
}), error => error instanceof ReportedSetupError && error.message === 'github');
assert.deepEqual(abandonedOutputs, [
  'Using Claude Code to set up the Forge.',
  BROWSER_PASSED,
  'Create the builder App in your browser: https://example.test/create',
  'Setup stopped because the GitHub page for creating its builder App was left unfinished, so GitHub did not hand that App over. Try setup again, finish creating the builder App on the GitHub page it opens, and paste the address your browser shows afterwards.'
]);
await assert.rejects(stat(join(state, 'projects/owner/abandoned-page/registration.json')));

testCase('leaving the release App page unfinished stops after the builder App');
// The builder App is created and installed, then the owner leaves the release App page unfinished.
const abandonedReleaseOutputs = [];
const abandonedReleaseAdapter = createGithubAdapter({
  input: { question: async question => question.startsWith('Type yes if') ? 'no' : 'https://github.com/settings/apps/new\n' },
  fetch: async () => { throw new Error('must not ask GitHub for an App without a code'); },
  output: value => abandonedReleaseOutputs.push(value)
});
const abandonedReleaseKinds = [];
await assert.rejects(setupRepository('owner/abandoned-release-page', {
  config: { projectsRoot, costMessage: 'Cost notice.' }, paths: { state }, commands: { run: async (...call) => appStepRun(...call) },
  github: {
    ...abandonedReleaseAdapter,
    appExists: async () => false,
    begin: async manifest => { await abandonedReleaseAdapter.begin(manifest); return { url: 'https://example.test/create' }; },
    callback: async flow => abandonedReleaseKinds.length === 0 ? 'code' : abandonedReleaseAdapter.callback(flow),
    exchange: async () => credentials,
    install: async ({ kind }) => { abandonedReleaseKinds.push(kind); return true; },
    appStatus: async () => 'installed'
  },
  prompt: async () => { throw new Error('must not prompt'); },
  output: value => abandonedReleaseOutputs.push(value)
}), error => error instanceof ReportedSetupError && error.message === 'github');
assert.deepEqual(abandonedReleaseKinds, ['builder']);
assert.deepEqual(abandonedReleaseOutputs, [
  'Using Claude Code to set up the Forge.',
  BROWSER_PASSED,
  'Create the builder App in your browser: https://example.test/create',
  'Create the release App in your browser: https://example.test/create',
  builderKept('Forge builder'),
  'Setup stopped because the GitHub page for creating its release App was left unfinished, so GitHub did not hand that App over. Try setup again, finish creating the release App on the GitHub page it opens, and paste the address your browser shows afterwards.'
]);
await assert.rejects(stat(join(state, 'projects/owner/abandoned-release-page/registration.json')));

testCase('a credential folder that stops accepting files stops plainly');
// The folder accepts the pending record (#29) but stops accepting files once GitHub hands the App over.
const unwritableCredentials = credentialPath(state, 'owner/unwritable-credentials');
await mkdir(unwritableCredentials, { recursive: true, mode: 0o700 });
const unwritableOutputs = [];
try {
  await assert.rejects(setupRepository('owner/unwritable-credentials', {
    config: { projectsRoot, costMessage: 'Cost notice.' }, paths: { state }, commands: { run: async (...call) => appStepRun(...call) },
    github: {
      appExists: async () => false,
      begin: async () => ({ url: 'https://example.test/create' }),
      callback: async () => 'code',
      exchange: async () => { await chmod(unwritableCredentials, 0o500); return credentials; },
      install: async () => { throw new Error('must not install unsaved credentials'); },
      appStatus: async () => 'installed'
    },
    prompt: async () => { throw new Error('must not prompt'); },
    output: value => unwritableOutputs.push(value)
  }), error => error instanceof ReportedSetupError && error.message === 'github');
} finally {
  await chmod(unwritableCredentials, 0o700);
}
assert.deepEqual(unwritableOutputs, [
  'Using Claude Code to set up the Forge.',
  BROWSER_PASSED,
  'Create the builder App in your browser: https://example.test/create',
  builderKept('Forge builder'),
  'Setup stopped because it could not save the details of the GitHub App it just created on this server. Let setup write to the credentials folder in the Forge\'s private state folder before trying setup again.'
]);
await assert.rejects(stat(join(unwritableCredentials, 'builder-app.json')));
await assert.rejects(stat(join(state, 'projects/owner/unwritable-credentials/registration.json')));

for (const failure of [
  {
    repository: 'owner/failing-download', command: 'git', argument: 'fetch',
    message: 'Setup stopped because it could not download the build tools from GitHub. Restore this server\'s access to GitHub before trying setup again.'
  },
  {
    repository: 'owner/failing-initialization', command: 'python3', argument: 'init',
    message: 'Setup stopped because the build tools it downloaded could not prepare the project on this server. Install the latest version of the Forge on this server before trying setup again.'
  }
]) {
  testCase(`${failure.repository} stops with its own message`);
  const failureMessages = [];
  const failureCalls = [];
  await assert.rejects(setupRepository(failure.repository, {
    config: { projectsRoot, costMessage: 'Cost notice.' }, paths: { state }, commands: {
      run: async (command, args) => {
        failureCalls.push({ command, args });
        if (command === 'claude') return { stdout: 'signed in' };
        if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
        if (command === failure.command && args.includes(failure.argument)) throw new Error('private setup detail');
        if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
        return { stdout: '' };
      }
    },
    github: { begin: async () => { throw new Error('must not begin GitHub setup'); } },
    prompt: async () => { throw new Error('must not prompt'); },
    output: value => failureMessages.push(value)
  }), error => error instanceof ReportedSetupError && error.message === (failure.argument === 'fetch' ? 'preparation' : 'initialization'));
  assert.deepEqual(failureMessages.at(-1), failure.message);
  assert(!failureMessages.some(message => message.includes('private setup detail')));
  assert(!failureCalls.some(call => call.args.at(-1) === 'doctor' || call.args.includes('schedule')));
  await assert.rejects(stat(join(state, `projects/${failure.repository}/registration.json`)));
}

for (const refusedKind of ['builder', 'release']) {
  testCase(`a refused ${refusedKind} App stops App setup`);
  const refusedState = join(root, `refused-${refusedKind}`);
  await assert.rejects(createApps({ checkout: join(refusedState, 'checkout'),
    repository: 'owner/repo', stateDirectory: refusedState,
    credentialDirectory: join(refusedState, 'credentials'), output: () => {},
    github: {
      appExists: async () => false,
      begin: async () => ({ url: 'https://example.test/create' }),
      callback: async () => 'code', exchange: async () => credentials,
      install: async ({ kind }) => kind !== refusedKind,
      appStatus: async () => 'installed'
    }
  }), new RegExp(`Install the ${refusedKind} App`));
  await assert.rejects(stat(join(refusedState, `${refusedKind}-installation.json`)));
}

testCase('App keys GitHub returns incomplete are not saved');
const incompleteCredentialsState = join(root, 'incomplete-credentials');
await assert.rejects(createApps({ checkout: join(root, 'direct-checkouts', '1'),
  repository: 'owner/repo', stateDirectory: incompleteCredentialsState,
  credentialDirectory: join(incompleteCredentialsState, 'credentials'), output: () => {},
  github: {
    appExists: async () => false,
    begin: async () => ({ url: 'https://example.test/create' }),
    callback: async () => 'code', exchange: async () => ({ id: 12345, pem: 'PRIVATE KEY WITHOUT SLUG' }),
    install: async () => { throw new Error('must not install incomplete credentials'); },
    appStatus: async () => 'installed'
  }
}), /did not return the builder App credentials/);
await assert.rejects(stat(join(incompleteCredentialsState, 'credentials/builder-app.json')));

testCase('App keys saved by an earlier release are moved to the private folder');
const completedLegacyState = join(root, 'completed-legacy');
const completedLegacyCredentials = join(root, 'completed-legacy-credentials');
for (const kind of ['builder', 'release']) {
  await writePrivateJson(join(completedLegacyState, `${kind}-app.json`), { ...credentials, slug: `${kind}-slug` });
  await writePrivateJson(join(completedLegacyState, `${kind}-installation.json`), { repository: 'owner/repo', confirmed: true });
}
await createApps({ checkout: join(root, 'direct-checkouts', '2'),
  repository: 'owner/repo', stateDirectory: completedLegacyState,
  credentialDirectory: completedLegacyCredentials, output: () => {},
  github: {
    exists: async path => { try { await stat(path); return true; } catch { return false; } },
    appExists: async () => false,
    begin: async () => { throw new Error('must not create completed Apps'); },
    install: async () => { throw new Error('must not reinstall completed Apps'); },
    appStatus: async () => 'installed'
  }
});
for (const kind of ['builder', 'release']) {
  const migrated = join(completedLegacyCredentials, `${kind}-app.json`);
  assert.equal((await stat(migrated)).mode & 0o777, 0o600);
  await assert.rejects(stat(join(completedLegacyState, `${kind}-app.json`)));
}

testCase('an interrupted move of earlier App keys resumes');
const interruptedState = join(root, 'interrupted-legacy');
const interruptedCredentials = join(root, 'interrupted-credentials');
await writePrivateJson(join(interruptedState, 'builder-app.json'), credentials);
const resumed = [];
await createApps({ checkout: join(root, 'direct-checkouts', '3'),
  repository: 'owner/repo', stateDirectory: interruptedState,
  credentialDirectory: interruptedCredentials, output: () => {},
  github: {
    exists: async path => { try { await stat(path); return true; } catch { return false; } },
    appExists: async () => false,
    begin: async manifest => ({ url: `https://example.test/${manifest.name}` }),
    callback: async () => 'code', exchange: async () => ({ ...credentials, slug: 'release-slug' }),
    install: async ({ kind }) => { resumed.push(kind); return true; },
    appStatus: async () => 'installed'
  }
});
assert.deepEqual(resumed, ['builder', 'release']);
assert.deepEqual(JSON.parse(await readFile(join(interruptedCredentials, 'builder-app.json'), 'utf8')), credentials);
await assert.rejects(stat(join(interruptedState, 'builder-app.json')));

testCase('a stale earlier App keys file next to the current one is removed');
const duplicateState = join(root, 'duplicate-state');
const duplicateCredentials = join(root, 'duplicate-credentials');
const currentCredentials = { ...credentials, slug: 'current-slug' };
await writePrivateJson(join(duplicateState, 'builder-app.json'), { ...credentials, slug: 'stale-slug' });
await writePrivateJson(join(duplicateCredentials, 'builder-app.json'), currentCredentials);
await assert.rejects(createApps({ checkout: join(root, 'direct-checkouts', '4'),
  repository: 'owner/repo', stateDirectory: duplicateState,
  credentialDirectory: duplicateCredentials, output: () => {},
  github: {
    appExists: async () => false,
    exists: async () => false,
    install: async ({ credentials: installed, kind }) => {
      assert.equal(kind, 'builder');
      assert.deepEqual(installed, currentCredentials);
      return false;
    },
    appStatus: async () => 'installed'
  }
}), /Install the builder App/);
await assert.rejects(stat(join(duplicateState, 'builder-app.json')));

testCase('damaged earlier App keys stop as unreadable and stay as they are');
const malformedState = join(root, 'malformed-state');
const malformedCredentials = join(root, 'malformed-credentials');
await writePrivateJson(join(malformedState, 'builder-app.json'), { id: 12345, pem: 'PRIVATE KEY WITHOUT SLUG' });
await assert.rejects(createApps({ checkout: join(root, 'direct-checkouts', '5'),
  repository: 'owner/repo', stateDirectory: malformedState,
  credentialDirectory: malformedCredentials, output: () => {},
  github: { install: async () => { throw new Error('must not install malformed credentials'); }, appStatus: async () => 'installed' }
}), error => error instanceof AppSetupStop && error.reason === 'details-unreadable' && error.kind === 'builder');
assert.deepEqual(JSON.parse(await readFile(join(malformedState, 'builder-app.json'), 'utf8')), { id: 12345, pem: 'PRIVATE KEY WITHOUT SLUG' });
await assert.rejects(stat(join(malformedCredentials, 'builder-app.json')));

testCase('App keys setup cannot read are not created again');
const inaccessibleState = join(root, 'inaccessible-state');
const inaccessibleCredentials = join(root, 'inaccessible-credentials');
await writePrivateJson(join(inaccessibleState, 'builder-installation.json'), {
  repository: 'owner/repo', confirmed: true
});
await writePrivateJson(join(inaccessibleCredentials, 'builder-app.json'), credentials);
await chmod(inaccessibleCredentials, 0o000);
try {
  await assert.rejects(createApps({ checkout: join(root, 'direct-checkouts', '6'),
    repository: 'owner/repo', stateDirectory: inaccessibleState,
    credentialDirectory: inaccessibleCredentials, output: () => {},
    github: {
      appExists: async () => false,
      begin: async () => { throw new Error('must not recreate inaccessible credentials'); },
      install: async () => { throw new Error('must not install inaccessible credentials'); },
      appStatus: async () => 'installed'
    }
  // The whole folder is closed to setup, so it cannot read the details of either App.
  }), error => error instanceof AppSetupStop && error.reason === 'details-unreadable' && error.kind === undefined);
} finally {
  await chmod(inaccessibleCredentials, 0o700);
}

testCase('with no agent signed in setup stops and writes nothing');
const emptyRoot = join(root, 'no-agent');
const stopped = [];
await assert.rejects(setupRepository('owner/other', {
  config: { projectsRoot: emptyRoot, costMessage: 'Cost notice.' }, paths: { state: join(root, 'no-agent-state') },
  commands: { run: async () => { throw new Error('not signed in'); } },
  github: { begin: async () => { throw new Error('must not run'); } }, prompt: async () => '', output: value => stopped.push(value)
}), error => error instanceof ReportedSetupError && error.message === 'agent');
assert.deepEqual(stopped, ['Setup stopped because neither Claude Code nor Codex is signed in. Sign in to one of them before trying setup again.']);
await assert.rejects(stat(emptyRoot));

// deleted and uninstalled name the Apps GitHub answers for as gone from the account or from the repository;
// unreachable names the Apps whose check fails as if GitHub could not be reached; refused those whose check
// GitHub refuses.
function standInGithub(options = {}) {
  const counts = { builder: 0, release: 0 };
  const installs = { builder: 0, release: 0 };
  const onGithub = { deleted: new Set(), clockRejected: new Set(), keyRejected: new Set(), uninstalled: new Set(), unreachable: new Set(), refused: new Set() };
  const live = { builder: 0, release: 0 };
  const pending = { ...options };
  const usedCodes = new Set();
  let current;
  const github = {
    exists: isPresent,
    begin: async manifest => {
      const kind = manifest.name === 'Forge builder' ? 'builder' : 'release';
      if (pending.failBeginOnce === kind) { delete pending.failBeginOnce; throw new Error('GitHub page could not be prepared'); }
      current = kind;
      counts[kind] += 1;
      live[kind] += 1;
      return { url: `https://example.test/${manifest.name}` };
    },
    callback: async () => current === options.noCallback ? null : `code-${current}-${counts[current]}`,
    exchange: async code => {
      const kind = code.split('-')[1];
      await options.onExchange?.(kind);
      if (pending.failExchangeOnce === kind) { delete pending.failExchangeOnce; throw new Error('network unreachable'); }
      if (pending.refuseExchangeOnce === kind || usedCodes.has(code)) {
        delete pending.refuseExchangeOnce;
        throw Object.assign(new Error('GitHub refused the App code.'), { refused: true });
      }
      usedCodes.add(code);
      return { ...credentials, slug: code };
    },
    install: async ({ kind }) => { installs[kind] += 1; return true; },
    // An App on setup's list is still on GitHub while the owner has not deleted it and it is the role's latest.
    appExists: async ({ slug }) => {
      const kind = slug.split('-')[1];
      if (onGithub.unreachable.has(kind)) throw new Error('network unreachable');
      if (onGithub.refused.has(kind)) throw Object.assign(new Error('refused'), { refused: true });
      return kind in live && live[kind] > 0 && !onGithub.deleted.has(kind) && slug === `code-${kind}-${counts[kind]}`;
    },
    appStatus: async ({ kind }) => {
      if (onGithub.unreachable.has(kind)) throw new Error('network unreachable');
      if (onGithub.refused.has(kind)) throw Object.assign(new Error('refused'), { refused: true });
      if (onGithub.deleted.has(kind)) return 'app-missing';
      if (onGithub.clockRejected.has(kind)) return 'clock-rejected';
      if (onGithub.keyRejected.has(kind)) return 'key-rejected';
      return onGithub.uninstalled.has(kind) ? 'not-installed' : 'installed';
    }
  };
  return { counts, live, installs, onGithub, github };
}

// doctor and init, when given, run before the stand-in final check or build tools install and fail it by throwing.
// startAfresh, when given, is the file the owner asked setup to start afresh.
async function setupAttempt(repository, stateDirectory, github, { doctor, init, startAfresh, choose, closed } = {}) {
  const attemptMessages = [];
  const prompts = [];
  const asked = [];
  const retryRun = async (command, args, options) => {
    if (command === 'git' && args[0] === 'remote') return { stdout: `https://github.com/${repository}.git\n` };
    if (args.at(-1) === 'doctor') await doctor?.();
    if (args[1] === 'init') await init?.();
    return run(command, args, options);
  };
  try {
    await setupRepository(repository, {
      config: { ...defaults(root), projectsRoot }, paths: { state: stateDirectory }, commands: { run: retryRun }, github, startAfresh,
      prompt: async question => {
        if (question.startsWith('Two ')) { asked.push(question); if (closed) throw new InputClosed(); return choose ?? ''; }
        return ['Purpose.', 'Users.'][prompts.push(question) - 1];
      }, output: value => attemptMessages.push(value)
    });
    return { messages: attemptMessages, prompts, asked };
  } catch (error) {
    return { messages: attemptMessages, prompts, asked, error };
  }
}

const REOPENED = (kind, repository) => `If you finished the GitHub page for the ${kind} App during an earlier setup, delete the ${kind} App it made for ${repository} in your GitHub App settings before you create it again.`;
// The stops for an App file setup cannot read and cannot do without.
const DETAILS_UNREADABLE = (kind, repository) => `Setup stopped because the saved details of the ${kind} App for ${repository} on this server cannot be read. Ask me to start the ${kind} App's saved details afresh, and setup replaces only that file and then says what else the ${kind} App needs.`;
const BOTH_DETAILS_UNREADABLE = repository => `Setup stopped because the saved details of the builder and release Apps for ${repository} on this server cannot be read. Ask me to start the saved details of both Apps afresh, and setup replaces only those two files and then says what else the Apps need.`;
const CONNECTION_UNREADABLE = (kind, repository) => `Setup stopped because setup's record of connecting the ${kind} App for ${repository} on this server cannot be read. Ask me to start connecting the ${kind} App afresh, and setup replaces only that record and opens the GitHub page for that App again.`;
const SETTINGS_UNREADABLE = 'Setup stopped because the Forge\'s settings file on this server cannot be read. Ask me to start the Forge\'s settings afresh, and setup replaces only that file with the default settings.';
const LIST_UNREADABLE = repository => `Setup stopped because the list of GitHub Apps that setup keeps in the project folder for ${repository} on this server cannot be read. If your GitHub App settings list a builder or release App for ${repository} that setup is not using, delete it, then ask me to start setup's list of GitHub Apps afresh, and setup replaces only that list.`;
// name: the App's name when setup's list knows it (the default is the stand-in's name for it).
const UNUSABLE = (kind, repository, reason, name = null) => `Setup stopped because the saved details of the ${kind} App${name ? ` "${name}"` : ''} on this server are ${reason}, so setup can no longer use that App; delete ${name ? `"${name}"` : `the ${kind} App for ${repository}`} in your GitHub App settings, then try setup again, which creates a new ${kind} App.`;
// The stop for a saved file the file system will not let setup read.
const DENIED = repository => `Setup stopped because this server would not let setup read one of the files it keeps for ${repository}. Let setup read the files in the folder where the Forge keeps its settings and in the project folder for ${repository}, then try setup again.`;
// The stops for a 401 on GET /app: one GitHub sent because this server's clock is off, and any other.
const CLOCK_STOP = (kind, repository) => [`Setup stopped because GitHub did not accept the sign-in of the ${kind} App for ${repository}, as this server's clock is off. Correct this server's clock, then try setup again.`, 'app-clock'];
const KEY_REJECTED_STOP = (kind, repository) => [`Setup stopped because GitHub no longer accepts the saved key of the ${kind} App for ${repository}. If your GitHub App settings still list a ${kind} App for ${repository}, delete it, then try setup again, which creates it again.`, 'app-key-rejected'];
const BOTH_UNUSABLE = (clause, repository, named = false) => `Setup stopped because ${clause}, so setup can no longer use either App; delete ${named ? '"Forge builder" and "Forge release"' : `any builder or release App for ${repository} that your GitHub App settings still list`}, then try setup again, which creates both Apps again.`;

const pendingFiles = async directory => (await readdir(directory)).filter(name => name.endsWith('-app-pending.json'));
const completedFor = repository => message => message.startsWith(`Setup is complete for ${repository}.`);

testCase('an unwritable credential folder stops, and the retry finishes');
{
  const retryState = join(root, 'retry-unwritable');
  const credentialDirectory = credentialPath(retryState, 'owner/unwritable');
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  await chmod(credentialDirectory, 0o500);
  const standIn = standInGithub();
  let first;
  try {
    first = await setupAttempt('owner/unwritable', retryState, standIn.github);
  } finally {
    await chmod(credentialDirectory, 0o700);
  }
  assert(first.error instanceof ReportedSetupError && first.error.message === 'credential-location');
  assert.equal(first.messages.at(-1), 'Setup stopped because this server would not let it save the GitHub App keys in its private folder. Allow setup to write to that folder before trying setup again.');
  assert(!first.messages.some(message => message.includes('Complete the GitHub page')));
  assert.deepEqual(standIn.counts, { builder: 0, release: 0 });
  const second = await setupAttempt('owner/unwritable', retryState, standIn.github);
  assert.equal(second.error, undefined);
  assert(completedFor('owner/unwritable')(second.messages.at(-1)));
  assert.deepEqual(standIn.counts, { builder: 1, release: 1 });
}

testCase('a lost connection while GitHub hands over the App keys is retried');
{
  const retryState = join(root, 'retry-transport');
  const credentialDirectory = credentialPath(retryState, 'owner/transport');
  const standIn = standInGithub({ failExchangeOnce: 'builder' });
  const first = await setupAttempt('owner/transport', retryState, standIn.github);
  assert(first.error instanceof ReportedSetupError && first.error.message === 'github-pending');
  assert.equal(first.messages.at(-1), 'Setup stopped because GitHub could not be reached to finish connecting the builder App. Try setup again; it will try to finish this App, and if GitHub no longer accepts it, setup will say what to do.');
  const pendingPath = join(credentialDirectory, 'builder-app-pending.json');
  assert.equal((await stat(pendingPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(pendingPath, 'utf8')), { code: 'code-builder-1' });
  assert(!JSON.stringify(await readTree(projectStatePath(retryState, 'owner/transport'))).includes('code-builder'));
  const second = await setupAttempt('owner/transport', retryState, standIn.github);
  assert(completedFor('owner/transport')(second.messages.at(-1)));
  assert.deepEqual(standIn.counts, { builder: 1, release: 1 });
  assert.deepEqual(await pendingFiles(credentialDirectory), []);
}

testCase('GitHub\'s answer lost on the way back: both stops agree and name deleting the App');
{
  // GitHub uses the builder code but its answer is lost on the way back, so the retry's code is refused.
  // The first stop only says setup will try; the second names deleting the App, and the two agree.
  const retryState = join(root, 'retry-answer-lost');
  const credentialDirectory = credentialPath(retryState, 'owner/answer-lost');
  const standIn = standInGithub();
  let loseOnce = true;
  const github = {
    ...standIn.github,
    exchange: async code => {
      const result = await standIn.github.exchange(code);
      if (loseOnce && code.startsWith('code-builder')) { loseOnce = false; throw new Error('network unreachable'); }
      return result;
    }
  };
  const first = await setupAttempt('owner/answer-lost', retryState, github);
  assert(first.error instanceof ReportedSetupError && first.error.message === 'github-pending');
  assert.equal(first.messages.at(-1), 'Setup stopped because GitHub could not be reached to finish connecting the builder App. Try setup again; it will try to finish this App, and if GitHub no longer accepts it, setup will say what to do.');
  assert(!first.messages.some(message => message.includes('without creating another')));
  const second = await setupAttempt('owner/answer-lost', retryState, github);
  assert(second.error instanceof ReportedSetupError && second.error.message === 'leftover-app');
  assert.equal(second.messages.at(-1), 'Setup stopped because it could not finish connecting the builder App. If GitHub created a builder App for owner/answer-lost, delete it in your GitHub App settings, then try setup again.');
  assert.deepEqual(standIn.counts, { builder: 1, release: 0 });
  assert.deepEqual(await pendingFiles(credentialDirectory), []);
}

testCase('the credential folder stops accepting files after GitHub hands out the keys');
{
  // The credential folder stops accepting new files right after GitHub hands out the builder keys.
  const retryState = join(root, 'retry-write-after-exchange');
  const credentialDirectory = credentialPath(retryState, 'owner/write-fail');
  const pendingPath = join(credentialDirectory, 'builder-app-pending.json');
  let lockOnce = true;
  const standIn = standInGithub({
    onExchange: async () => { if (lockOnce) { lockOnce = false; await chmod(credentialDirectory, 0o500); } }
  });
  let first;
  let stillLocked;
  try {
    first = await setupAttempt('owner/write-fail', retryState, standIn.github);
    stillLocked = await setupAttempt('owner/write-fail', retryState, standIn.github);
  } finally {
    await chmod(credentialDirectory, 0o700);
  }
  for (const attempt of [first, stillLocked]) {
    assert(attempt.error instanceof ReportedSetupError && attempt.error.message === 'github');
    assert.equal(attempt.messages.at(-1), 'Setup stopped because it could not save the details of the GitHub App it just created on this server. Let setup write to the credentials folder in the Forge\'s private state folder before trying setup again.');
  }
  assert.equal((await stat(pendingPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(pendingPath, 'utf8')).credentials.slug, 'code-builder-1');
  assert(!JSON.stringify(await readTree(projectStatePath(retryState, 'owner/write-fail'))).includes('SENTINEL'));
  assert.deepEqual(standIn.counts, { builder: 1, release: 0 });
  const second = await setupAttempt('owner/write-fail', retryState, standIn.github);
  assert.equal(second.error, undefined);
  assert(completedFor('owner/write-fail')(second.messages.at(-1)));
  assert.deepEqual(standIn.counts, { builder: 1, release: 1 });
  assert.deepEqual(standIn.live, { builder: 1, release: 1 });
  assert.equal(JSON.parse(await readFile(join(credentialDirectory, 'builder-app.json'), 'utf8')).slug, 'code-builder-1');
  assert.deepEqual(await pendingFiles(credentialDirectory), []);
}

testCase('the App keys file itself cannot be written');
{
  // The keys file itself cannot be written (something else is in its place) while the folder can.
  const retryState = join(root, 'retry-keys-blocked');
  const credentialDirectory = credentialPath(retryState, 'owner/keys-blocked');
  const blockedPath = join(credentialDirectory, 'builder-app.json');
  let blockOnce = true;
  const standIn = standInGithub({
    onExchange: async () => { if (blockOnce) { blockOnce = false; await mkdir(join(blockedPath, 'blocked'), { recursive: true }); } }
  });
  const first = await setupAttempt('owner/keys-blocked', retryState, standIn.github);
  assert(first.error instanceof ReportedSetupError && first.error.message === 'github');
  assert.equal(first.messages.at(-1), 'Setup stopped because it could not save the details of the GitHub App it just created on this server. Let setup write to the credentials folder in the Forge\'s private state folder before trying setup again.');
  await rm(blockedPath, { recursive: true });
  const second = await setupAttempt('owner/keys-blocked', retryState, standIn.github);
  assert(completedFor('owner/keys-blocked')(second.messages.at(-1)));
  assert.deepEqual(standIn.counts, { builder: 1, release: 1 });
  assert.deepEqual(await pendingFiles(credentialDirectory), []);
}

// Keys left in the pending record by a run that could not save them belong to an App the owner may delete on
// GitHub before the retry (#77). The retry asks GitHub first: a deleted App stops it before any install link,
// and the run after that creates a new App; while GitHub cannot be asked, the keys stay for the next run.
async function keysKeptSetup(name) {
  const repository = `owner/${name}`;
  const retryState = join(root, `kept-keys-${name}`);
  const credentialDirectory = credentialPath(retryState, repository);
  const blockedPath = join(credentialDirectory, 'builder-app.json');
  let blockOnce = true;
  const standIn = standInGithub({
    onExchange: async () => { if (blockOnce) { blockOnce = false; await mkdir(join(blockedPath, 'blocked'), { recursive: true }); } }
  });
  const first = await setupAttempt(repository, retryState, standIn.github);
  assert(first.error instanceof ReportedSetupError && first.error.message === 'github');
  await rm(blockedPath, { recursive: true });
  const pendingPath = join(credentialDirectory, 'builder-app-pending.json');
  assert.equal(JSON.parse(await readFile(pendingPath, 'utf8')).credentials.slug, 'code-builder-1');
  return {
    repository, retryState, standIn, credentialDirectory, pendingPath,
    registrationPath: join(projectStatePath(retryState, repository), 'registration.json'),
    attempt: () => setupAttempt(repository, retryState, standIn.github)
  };
}

testCase('kept App keys whose App is still on GitHub finish that App');
{
  const project = await keysKeptSetup('kept-on-github');
  const second = await project.attempt();
  assert.equal(second.error, undefined);
  assert(completedFor(project.repository)(second.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  assert.deepEqual(project.standIn.installs, { builder: 1, release: 1 });
  assert.equal(JSON.parse(await readFile(join(project.credentialDirectory, 'builder-app.json'), 'utf8')).slug, 'code-builder-1');
  assert.deepEqual(await pendingFiles(project.credentialDirectory), []);
}

testCase('kept App keys whose App was deleted on GitHub stop before the install link, and the retry creates it again');
{
  const project = await keysKeptSetup('kept-deleted');
  project.standIn.onGithub.deleted.add('builder');
  project.standIn.live.builder -= 1;
  const second = await project.attempt();
  assertStopped(second, [`Setup stopped because the builder App for ${project.repository} is no longer on your GitHub account. Try setup again, which creates it again; if your GitHub App settings still list a builder App for ${project.repository}, delete it first.`, 'app-missing'], project.retryState);
  assert(!second.messages.some(completedFor(project.repository)));
  assert.deepEqual(project.standIn.installs, { builder: 0, release: 0 });
  await assert.rejects(stat(project.registrationPath));
  assert.deepEqual(await pendingFiles(project.credentialDirectory), []);
  await assert.rejects(stat(join(project.credentialDirectory, 'builder-app.json')));
  project.standIn.onGithub.deleted.clear();
  const third = await project.attempt();
  assert.equal(third.error, undefined);
  assert(completedFor(project.repository)(third.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 2, release: 1 });
  assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
  assert.equal(JSON.parse(await readFile(join(project.credentialDirectory, 'builder-app.json'), 'utf8')).slug, 'code-builder-2');
}

testCase('kept App keys GitHub could not be asked about stay for the next run');
{
  const project = await keysKeptSetup('kept-unchecked');
  const kept = await readFile(project.pendingPath, 'utf8');
  project.standIn.onGithub.unreachable.add('builder');
  const second = await project.attempt();
  assertStopped(second, [`Setup stopped because GitHub could not be reached to check the builder App for ${project.repository}. Restore this server's access to GitHub before trying setup again.`, 'github-check'], project.retryState);
  assert.deepEqual(project.standIn.installs, { builder: 0, release: 0 });
  assert.equal(await readFile(project.pendingPath, 'utf8'), kept);
  project.standIn.onGithub.unreachable.clear();
  const third = await project.attempt();
  assert.equal(third.error, undefined);
  assert(completedFor(project.repository)(third.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  assert.equal(JSON.parse(await readFile(join(project.credentialDirectory, 'builder-app.json'), 'utf8')).slug, 'code-builder-1');
}

testCase('kept App keys whose sign-in GitHub refuses over the clock stay for the next run');
{
  const project = await keysKeptSetup('kept-clock');
  const kept = await readFile(project.pendingPath, 'utf8');
  project.standIn.onGithub.clockRejected.add('builder');
  const second = await project.attempt();
  assertStopped(second, CLOCK_STOP('builder', project.repository), project.retryState);
  assert.deepEqual(project.standIn.installs, { builder: 0, release: 0 });
  assert.equal(await readFile(project.pendingPath, 'utf8'), kept);
  project.standIn.onGithub.clockRejected.clear();
  const third = await project.attempt();
  assert.equal(third.error, undefined);
  assert(completedFor(project.repository)(third.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
}

testCase('kept App keys GitHub no longer accepts stop before the install link, and the retry creates the App again');
{
  const project = await keysKeptSetup('kept-key-rejected');
  project.standIn.onGithub.keyRejected.add('builder');
  const second = await project.attempt();
  assertStopped(second, KEY_REJECTED_STOP('builder', project.repository), project.retryState);
  assert.deepEqual(project.standIn.installs, { builder: 0, release: 0 });
  assert.deepEqual(await pendingFiles(project.credentialDirectory), []);
  await assert.rejects(stat(join(project.credentialDirectory, 'builder-app.json')));
  project.standIn.onGithub.keyRejected.clear();
  project.standIn.live.builder -= 1;
  const third = await project.attempt();
  assert.equal(third.error, undefined);
  assert(completedFor(project.repository)(third.messages.at(-1)));
  assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
}

testCase('App keys lost after the exchange: the owner deletes the App once and setup finishes');
{
  // Nothing in the credential folder can be written after the exchange, not even the pending record:
  // the keys are lost. The owner is told to delete the App once, and following that finishes setup.
  const retryState = join(root, 'retry-keys-lost');
  const credentialDirectory = credentialPath(retryState, 'owner/lost-keys');
  const pendingPath = join(credentialDirectory, 'builder-app-pending.json');
  let lockOnce = true;
  const standIn = standInGithub({
    onExchange: async () => {
      if (!lockOnce) return;
      lockOnce = false;
      await chmod(pendingPath, 0o400);
      await chmod(credentialDirectory, 0o500);
    }
  });
  let first;
  try {
    first = await setupAttempt('owner/lost-keys', retryState, standIn.github);
  } finally {
    await chmod(credentialDirectory, 0o700);
    await chmod(pendingPath, 0o600);
  }
  assert(first.error instanceof ReportedSetupError && first.error.message === 'github');
  assert.equal(first.messages.at(-1), 'Setup stopped because it could not save the details of the GitHub App it just created on this server. Let setup write to the credentials folder in the Forge\'s private state folder before trying setup again.');
  assert(!first.messages.some(message => message.includes('delete')));
  const second = await setupAttempt('owner/lost-keys', retryState, standIn.github);
  assert(second.error instanceof ReportedSetupError && second.error.message === 'leftover-app');
  assert.equal(second.messages.at(-1), 'Setup stopped because it could not finish connecting the builder App. If GitHub created a builder App for owner/lost-keys, delete it in your GitHub App settings, then try setup again.');
  assert.deepEqual(await pendingFiles(credentialDirectory), []);
  standIn.live.builder -= 1;
  const third = await setupAttempt('owner/lost-keys', retryState, standIn.github);
  assert.equal(third.error, undefined);
  assert(completedFor('owner/lost-keys')(third.messages.at(-1)));
  assert.deepEqual(standIn.live, { builder: 1, release: 1 });
  assert.deepEqual(await pendingFiles(credentialDirectory), []);
}

testCase('GitHub refusing the App code once is retried');
{
  const retryState = join(root, 'retry-refused');
  const standIn = standInGithub({ refuseExchangeOnce: 'builder' });
  const first = await setupAttempt('owner/refused', retryState, standIn.github);
  assert(first.error instanceof ReportedSetupError && first.error.message === 'leftover-app');
  assert.equal(first.messages.at(-1), 'Setup stopped because it could not finish connecting the builder App. If GitHub created a builder App for owner/refused, delete it in your GitHub App settings, then try setup again.');
  assert.deepEqual(await pendingFiles(credentialPath(retryState, 'owner/refused')), []);
  standIn.live.builder -= 1;
  const second = await setupAttempt('owner/refused', retryState, standIn.github);
  assert(completedFor('owner/refused')(second.messages.at(-1)));
  assert.deepEqual(standIn.live, { builder: 1, release: 1 });
  assert.equal(standIn.counts.release, 1);
}

testCase('a leftover pending record without a code opens the App page again');
{
  // The page was shown but no address came back (#61): GitHub made no App unless the owner finished the page,
  // so the page opens again, after a line asking for the App to be deleted only in that case.
  const interruptedCredentialDirectory = join(root, 'retry-interrupted', 'credentials');
  const pendingPath = join(interruptedCredentialDirectory, 'builder-app-pending.json');
  await writePrivateJson(pendingPath, { code: null });
  const standIn = standInGithub();
  const printed = [];
  await createApps({ checkout: join(root, 'direct-checkouts', '7'),
    repository: 'owner/repo', stateDirectory: join(root, 'retry-interrupted'),
    credentialDirectory: interruptedCredentialDirectory, github: standIn.github, output: value => printed.push(value)
  });
  assert.deepEqual(standIn.counts, { builder: 1, release: 1 });
  assert.deepEqual(printed, [
    REOPENED('builder', 'owner/repo'),
    'Create the builder App in your browser: https://example.test/Forge builder',
    'Create the release App in your browser: https://example.test/Forge release'
  ]);
  assert.deepEqual(await pendingFiles(interruptedCredentialDirectory), []);

  testCase('an address without GitHub\'s code stops at the App page and the page opens again');
  // An address without GitHub's code means the App page was left unfinished (#44): the stop names that
  // page, the pending record goes, and the next run opens the page again.
  const noCallback = standInGithub({ noCallback: 'builder' });
  const noCallbackCredentials = join(root, 'retry-no-callback', 'credentials');
  await assert.rejects(createApps({ checkout: join(root, 'direct-checkouts', '8'),
    repository: 'owner/repo', stateDirectory: join(root, 'retry-no-callback'),
    credentialDirectory: noCallbackCredentials, github: noCallback.github, output: () => {}
  }), error => error instanceof AppStepError && error.step === 'page' && error.kind === 'builder');
  assert.deepEqual(noCallback.counts, { builder: 1, release: 0 });
  assert.deepEqual(await pendingFiles(noCallbackCredentials), []);
}

// A stop on an App file setup cannot read (#52, #96) names no file or internal detail, carries at most one link,
// and leaves the file as it is; once the owner asks setup to start that file afresh, the next run replaces only
// that file and asks for the GitHub page of that App again.
function assertNoInternalText(message, serverRoot) {
  assert(!/\.json|pending|credentials|Errno|SyntaxError|JSON/i.test(message), message);
  assert(!message.includes(serverRoot), message);
  assert((message.match(/https?:\/\//g) ?? []).length <= 1, message);
}

for (const [kind, damage] of [
  ['builder', { file: 'pending', text: '', name: 'empty-record' }],
  ['release', { file: 'pending', text: '{"code": "code-rel', name: 'cut-record' }],
  ['builder', { file: 'legacy', text: JSON.stringify({ id: 12345, pem: 'PRIVATE KEY WITHOUT SLUG' }), name: 'old-keys' }],
  ['release', { file: 'stored', text: '{"id": 12345, "pem": "PRIV', name: 'cut-keys' }]
]) {
  testCase(`a damaged ${kind} App file (${damage.name}) stops plainly and stays, then starting it afresh opens the App page again`);
  const repository = `owner/${kind}-${damage.name}`;
  const retryState = join(root, `retry-damaged-${kind}-${damage.file}`);
  const credentialDirectory = credentialPath(retryState, repository);
  const damagedPath = {
    pending: join(credentialDirectory, `${kind}-app-pending.json`),
    stored: join(credentialDirectory, `${kind}-app.json`),
    legacy: join(projectStatePath(retryState, repository), `${kind}-app.json`)
  }[damage.file];
  await mkdir(join(damagedPath, '..'), { recursive: true, mode: 0o700 });
  await writeFile(damagedPath, damage.text, { mode: 0o600 });
  const standIn = standInGithub();
  const first = await setupAttempt(repository, retryState, standIn.github);
  const expected = damage.file === 'pending'
    ? [CONNECTION_UNREADABLE(kind, repository), 'unreadable-app-connection', `${kind}-connection`]
    : [DETAILS_UNREADABLE(kind, repository), 'unreadable-app-details', `${kind}-app`];
  assert(first.error instanceof ReportedSetupError && first.error.message === expected[1], `${kind} ${damage.file}`);
  assert.deepEqual(first.messages, [expected[0]]);
  assertNoInternalText(first.messages.at(-1), retryState);
  assert.equal(await readFile(damagedPath, 'utf8'), damage.text);
  assert.equal(standIn.counts[kind], 0);
  const again = await setupAttempt(repository, retryState, standIn.github);
  assert.deepEqual(again.messages, first.messages);
  assert.equal(await readFile(damagedPath, 'utf8'), damage.text);
  const second = await setupAttempt(repository, retryState, standIn.github, { startAfresh: expected[2] });
  assert.equal(second.error, undefined);
  assert.equal(second.messages.includes(REOPENED(kind, repository)), damage.file === 'pending');
  assert(second.messages.includes(`Create the ${kind} App in your browser: https://example.test/Forge ${kind}`));
  assert(completedFor(repository)(second.messages.at(-1)));
  assert.deepEqual(standIn.counts, { builder: 1, release: 1 });
}

// Stored App details damaged after that App was installed: on a finished setup, and on one that stopped
// later. Setup stops without touching them; once the owner has it start them afresh, it asks for that App to be
// deleted, and the next run creates and installs that App again instead of skipping it.
for (const [kind, finished] of [['builder', false], ['release', true]]) {
  testCase(`${kind} App details damaged after install${finished ? ' on a finished setup' : ''} are created and installed again once started afresh`);
  const repository = `owner/${kind}-damaged-${finished ? 'finished' : 'unfinished'}`;
  const retryState = join(root, `retry-damaged-installed-${kind}`);
  const stateDirectory = projectStatePath(retryState, repository);
  const detailsPath = join(credentialPath(retryState, repository), `${kind}-app.json`);
  const standIn = standInGithub();
  assert.equal((await setupAttempt(repository, retryState, standIn.github)).error, undefined);
  if (!finished) await rm(join(stateDirectory, 'registration.json'));
  await writeFile(detailsPath, '{"id": 12345, "pem": "PRIV');
  const first = await setupAttempt(repository, retryState, standIn.github);
  assert(first.error instanceof ReportedSetupError && first.error.message === 'unreadable-app-details', `${kind} ${finished}`);
  assert.equal(first.messages.at(-1), DETAILS_UNREADABLE(kind, repository));
  assertNoInternalText(first.messages.at(-1), retryState);
  assert.equal(await readFile(detailsPath, 'utf8'), '{"id": 12345, "pem": "PRIV');
  assert(await isPresent(join(stateDirectory, `${kind}-installation.json`)));
  const afresh = await setupAttempt(repository, retryState, standIn.github, { startAfresh: `${kind}-app` });
  assert(afresh.error instanceof ReportedSetupError && afresh.error.message === 'missing-app-details', `${kind} ${finished}`);
  assert.equal(afresh.messages.at(-1), UNUSABLE(kind, repository, 'missing'));
  assert(!(await isPresent(join(stateDirectory, `${kind}-installation.json`))));
  standIn.live[kind] -= 1;
  const second = await setupAttempt(repository, retryState, standIn.github);
  assert.equal(second.error, undefined);
  assert(second.messages.includes(`Create the ${kind} App in your browser: https://example.test/Forge ${kind}`));
  assert(completedFor(repository)(second.messages.at(-1)));
  assert.equal(standIn.counts[kind], 2);
  assert(await isPresent(join(stateDirectory, `${kind}-installation.json`)));
  const third = await setupAttempt(repository, retryState, standIn.github);
  assert.deepEqual(third.messages, [`The Forge is already set up for ${repository}.`]);
}

// An empty App details file is unreadable (#96): setup stops and leaves it as it is, and once the owner has
// setup start it afresh, setup does exactly what it does when that file is missing, on a fresh setup and after
// a finished one.
for (const [n, kind, prepare] of [
  [1, 'builder', async (retryState, repository, empty) => {
    if (!empty) return;
    await mkdir(credentialPath(retryState, repository), { recursive: true, mode: 0o700 });
    await writeFile(join(credentialPath(retryState, repository), 'builder-app.json'), '', { mode: 0o600 });
  }],
  [2, 'release', async (retryState, repository, empty, github) => {
    assert.equal((await setupAttempt(repository, retryState, github)).error, undefined);
    const path = join(credentialPath(retryState, repository), 'release-app.json');
    if (empty) await writeFile(path, '');
    // Started afresh, setup runs its whole pass; so does a run after the record of finishing is gone.
    else { await rm(path); await rm(join(retryState, 'projects', ...repository.split('/'), 'registration.json')); }
  }]
]) {
  testCase(`an empty App details file stops and stays, and started afresh reads as missing (case ${n})`);
  const repository = `owner/empty-app-${n}`;
  const runs = [];
  for (const empty of [true, false]) {
    const retryState = join(root, `${empty ? 'empty' : 'deleted'}-app-${n}`);
    const standIn = standInGithub();
    await prepare(retryState, repository, empty, standIn.github);
    if (empty) {
      const stopped = await setupAttempt(repository, retryState, standIn.github);
      assert.deepEqual(stopped.messages, [...(n === 2 ? [builderKept('Forge builder')] : []), DETAILS_UNREADABLE(kind, repository)]);
      assert.equal(await readFile(join(credentialPath(retryState, repository), `${kind}-app.json`), 'utf8'), '');
    }
    const startAfresh = empty ? `${kind}-app` : undefined;
    runs.push({ ...(await setupAttempt(repository, retryState, standIn.github, { startAfresh })), counts: standIn.counts });
  }
  const [emptied, deleted] = runs;
  // Asked to start a file afresh, setup runs its whole pass, so it says which agent it uses first.
  const said = run => run.messages.filter(line => !line.startsWith('Using Claude Code'));
  assert.deepEqual(said(emptied), said(deleted));
  assert.equal(emptied.error?.message, deleted.error?.message);
  assert.deepEqual(emptied.counts, deleted.counts);
  if (n === 1) {
    assert(completedFor(repository)(emptied.messages.at(-1)));
    assert.deepEqual(emptied.counts, { builder: 1, release: 1 });
  }
}

testCase('a damaged file setup cannot replace when asked to start it afresh stops as an unwritable private folder');
{
  // A damaged file setup cannot remove when the owner asks to start it afresh gives the existing stop for an
  // unwritable private folder.
  const repository = 'owner/damaged-locked';
  const retryState = join(root, 'retry-damaged-locked');
  const credentialDirectory = credentialPath(retryState, repository);
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(credentialDirectory, 'builder-app.json'), '{', { mode: 0o600 });
  await chmod(credentialDirectory, 0o500);
  let first;
  try {
    first = await setupAttempt(repository, retryState, standInGithub().github, { startAfresh: 'builder-app' });
  } finally {
    await chmod(credentialDirectory, 0o700);
  }
  assert(first.error instanceof ReportedSetupError && first.error.message === 'credential-location');
  assert.equal(await readFile(join(credentialDirectory, 'builder-app.json'), 'utf8'), '{');
  assert.equal(first.messages.at(-1), 'Setup stopped because this server would not let it save the GitHub App keys in its private folder. Allow setup to write to that folder before trying setup again.');
}

testCase('a pending record with incomplete keys is unreadable and stays');
{
  // A pending record whose saved keys lack a field is damaged too: setup cannot finish that App from it.
  const credentialDirectory = join(root, 'retry-damaged-pending-keys', 'credentials');
  const pendingPath = join(credentialDirectory, 'builder-app-pending.json');
  await writePrivateJson(pendingPath, { code: 'code-builder-1', credentials: { id: 12345, pem: 'PRIVATE KEY WITHOUT SLUG' } });
  await assert.rejects(createApps({ checkout: join(root, 'direct-checkouts', '9'),
    repository: 'owner/repo', stateDirectory: join(root, 'retry-damaged-pending-keys'),
    credentialDirectory, github: standInGithub().github, output: () => {}
  }), error => error instanceof AppSetupStop && error.reason === 'pending-unreadable' && error.kind === 'builder');
  assert.deepEqual(JSON.parse(await readFile(pendingPath, 'utf8')).credentials, { id: 12345, pem: 'PRIVATE KEY WITHOUT SLUG' });
}

testCase('a stored and installed builder App is not created again');
{
  const retryState = join(root, 'retry-builder-stored');
  const credentialDirectory = join(retryState, 'credentials');
  await writePrivateJson(join(credentialDirectory, 'builder-app.json'), { ...credentials, slug: 'builder-slug' });
  await writePrivateJson(join(retryState, 'builder-installation.json'), { repository: 'owner/repo', confirmed: true });
  await writePrivateJson(join(credentialDirectory, 'builder-app-pending.json'), { code: 'code-builder-1' });
  const standIn = standInGithub();
  await createApps({ checkout: join(root, 'direct-checkouts', '10'), repository: 'owner/repo', stateDirectory: retryState, credentialDirectory, github: standIn.github, output: () => {} });
  assert.deepEqual(standIn.counts, { builder: 0, release: 1 });
  assert.deepEqual(await pendingFiles(credentialDirectory), []);
}

testCase('a stop at the release App page finishes on retry');
{
  const retryState = join(root, 'retry-release-stop');
  const standIn = standInGithub({ failBeginOnce: 'release' });
  const first = await setupAttempt('owner/release-stop', retryState, standIn.github);
  assert(first.error instanceof ReportedSetupError && first.error.message === 'github');
  assert.equal(first.messages.at(-1), 'Setup stopped because the GitHub connection was not completed. Complete the GitHub page before trying setup again.');
  assert.deepEqual(await pendingFiles(credentialPath(retryState, 'owner/release-stop')), []);
  const second = await setupAttempt('owner/release-stop', retryState, standIn.github);
  assert(completedFor('owner/release-stop')(second.messages.at(-1)));
  assert.deepEqual(standIn.counts, { builder: 1, release: 1 });
}

// A rerun after a finished setup checks what setup made before saying it is set up (#60). Each missing
// piece stops with one plain message naming it, and following that message gets setup complete again.
const appGoneStops = {
  missing: (kind, repository, name) => [UNUSABLE(kind, repository, 'missing', name), 'missing-app-details'],
  gone: (kind, repository) => [`Setup stopped because the ${kind} App for ${repository} is no longer on your GitHub account. Try setup again, which creates it again; if your GitHub App settings still list a ${kind} App for ${repository}, delete it first.`, 'app-missing'],
  uninstalled: (kind, repository) => [`Setup stopped because the ${kind} App is no longer installed on ${repository}. Try setup again, which asks you to install it again.`, 'app-not-installed'],
  unchecked: (kind, repository) => [`Setup stopped because GitHub could not be reached to check the ${kind} App for ${repository}. Restore this server's access to GitHub before trying setup again.`, 'github-check'],
  refused: (kind, repository) => [`Setup stopped because GitHub refused setup's request to check the ${kind} App for ${repository}, so setup changed nothing. Try setup again; if GitHub refuses again, check in your GitHub settings that the ${kind} App is still installed on ${repository}.`, 'github-refused'],
  clock: CLOCK_STOP,
  keyRejected: KEY_REJECTED_STOP,
  buildTools: repository => [`Setup stopped because the build tools setup installed in the project folder for ${repository} on this server are missing. Try setup again, which installs them again.`, 'factory-missing']
};

const FORGE_APPS_KEPT = 'Setup kept the details of your two GitHub Apps for this repository, "Forge builder" and "Forge release", on this server. Trying setup again checks whether they are still on your GitHub account and uses each one that is, instead of creating a new one.';

async function finishedSetup(name) {
  const repository = `owner/${name}`;
  const retryState = join(root, `finished-${name}`);
  const standIn = standInGithub();
  const first = await setupAttempt(repository, retryState, standIn.github);
  assert(completedFor(repository)(first.messages.at(-1)), name);
  return {
    repository, retryState, standIn,
    stateDirectory: projectStatePath(retryState, repository),
    credentialDirectory: credentialPath(retryState, repository),
    checkout: join(projectsRoot, repository),
    attempt: options => setupAttempt(repository, retryState, standIn.github, options)
  };
}

function assertStopped(attempt, [message, reason], serverRoot) {
  assert(attempt.error instanceof ReportedSetupError, message);
  assert.equal(attempt.error.message, reason);
  assert.equal(attempt.messages.at(-1), message);
  assert(!attempt.messages.some(line => line.includes('already set up')));
  for (const line of attempt.messages) {
    assertNoInternalText(line, serverRoot);
    assert(!/factory|archon|config|token/i.test(line), line);
    for (const secret of Object.values(credentials)) assert(!line.includes(String(secret)), line);
  }
}

// Stored App details that are a link whose target is gone cannot be read (#96): the run stops with the
// unreadable-details sentence instead of reporting setup as done, and leaves the link in place. Once the owner has
// setup start those details afresh, setup does what it does for deleted details: it asks for that App to be
// deleted on GitHub, and the next run creates it again, leaving one App per role.
for (const [kind, finished] of [['builder', false], ['release', true]]) {
  testCase(`a ${kind} App details link whose target is gone stops and stays in place until started afresh`);
  const repository = `owner/${kind}-broken-link-${finished ? 'finished' : 'unfinished'}`;
  const retryState = join(root, `retry-broken-link-${kind}`);
  const stateDirectory = projectStatePath(retryState, repository);
  const linkPath = join(credentialPath(retryState, repository), `${kind}-app.json`);
  const standIn = standInGithub();
  assert.equal((await setupAttempt(repository, retryState, standIn.github)).error, undefined);
  if (!finished) await rm(join(stateDirectory, 'registration.json'));
  await rm(linkPath);
  await symlink(join(retryState, 'gone', 'target.json'), linkPath);
  const first = await setupAttempt(repository, retryState, standIn.github);
  assertStopped(first, [DETAILS_UNREADABLE(kind, repository), 'unreadable-app-details'], retryState);
  assert(!first.messages.some(message => message.startsWith('Setup is complete')), JSON.stringify(first.messages));
  assert((await lstat(linkPath)).isSymbolicLink(), `${kind} link left in place`);
  assert(await isPresent(join(stateDirectory, `${kind}-installation.json`)));
  const afresh = await setupAttempt(repository, retryState, standIn.github, { startAfresh: `${kind}-app` });
  assertStopped(afresh, appGoneStops.missing(kind, repository), retryState);
  assert(!(await isPresent(join(stateDirectory, `${kind}-installation.json`))));
  standIn.live[kind] -= 1;
  const second = await setupAttempt(repository, retryState, standIn.github);
  assert.equal(second.error, undefined);
  assert(second.messages.includes(`Create the ${kind} App in your browser: https://example.test/Forge ${kind}`));
  assert(completedFor(repository)(second.messages.at(-1)));
  assert.deepEqual(standIn.live, { builder: 1, release: 1 });
}

for (const kind of ['builder', 'release']) {
  const other = kind === 'builder' ? 'release' : 'builder';
  testCase(`a finished setup whose ${kind} App was deleted on GitHub stops, then creates it again`);
  {
    // The App was deleted on GitHub.
    const project = await finishedSetup(`${kind}-deleted`);
    project.standIn.onGithub.deleted.add(kind);
    assertStopped(await project.attempt(), appGoneStops.gone(kind, project.repository), project.retryState);
    assert(!(await isPresent(join(project.credentialDirectory, `${kind}-app.json`))));
    assert(!(await isPresent(join(project.stateDirectory, `${kind}-installation.json`))));
    assert(await isPresent(join(project.credentialDirectory, `${other}-app.json`)));
    assert(!(await isPresent(join(project.stateDirectory, 'registration.json'))));
    project.standIn.onGithub.deleted.delete(kind);
    project.standIn.live[kind] -= 1;
    const next = await project.attempt();
    assert.equal(next.error, undefined);
    assert(next.messages.includes(`Create the ${kind} App in your browser: https://example.test/Forge ${kind}`));
    assert(completedFor(project.repository)(next.messages.at(-1)));
    assert.equal(project.standIn.counts[kind], 2);
    assert.equal(project.standIn.counts[other], 1);
    assert.deepEqual((await project.attempt()).messages, [`The Forge is already set up for ${project.repository}.`]);
  }
  testCase(`a finished setup whose ${kind} App details were deleted from this server stops, then creates it again`);
  {
    // The App's saved details were deleted from this server.
    const project = await finishedSetup(`${kind}-details-deleted`);
    await rm(join(project.credentialDirectory, `${kind}-app.json`));
    assertStopped(await project.attempt(), appGoneStops.missing(kind, project.repository, `Forge ${kind}`), project.retryState);
    assert(!(await isPresent(join(project.stateDirectory, `${kind}-installation.json`))));
    assert(!(await isPresent(join(project.stateDirectory, 'registration.json'))));
    // The owner deletes the App, as the stop says, and the next run creates a new one.
    project.standIn.live[kind] -= 1;
    const next = await project.attempt();
    assert(next.messages.includes(`Create the ${kind} App in your browser: https://example.test/Forge ${kind}`));
    assert(completedFor(project.repository)(next.messages.at(-1)));
    assert.deepEqual(project.standIn.counts, { [kind]: 2, [other]: 1 });
    assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
  }
}

testCase('a finished setup whose release App was uninstalled stops, then asks to install it again');
{
  // The App is still on GitHub but no longer installed on the repository: the next run asks to install it
  // again and creates nothing.
  const project = await finishedSetup('release-uninstalled');
  project.standIn.onGithub.uninstalled.add('release');
  assertStopped(await project.attempt(), appGoneStops.uninstalled('release', project.repository), project.retryState);
  assert(await isPresent(join(project.credentialDirectory, 'release-app.json')));
  assert(!(await isPresent(join(project.stateDirectory, 'release-installation.json'))));
  project.standIn.onGithub.uninstalled.delete('release');
  const next = await project.attempt();
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  assert.deepEqual(project.standIn.installs, { builder: 1, release: 2 });
}

testCase('a finished setup with both Apps broken stops on the first, then repairs both');
{
  // Both Apps broken at once: the stop names the first, and the next run repairs both.
  const project = await finishedSetup('both-broken');
  project.standIn.onGithub.deleted.add('builder');
  project.standIn.onGithub.uninstalled.add('release');
  assertStopped(await project.attempt(), appGoneStops.gone('builder', project.repository), project.retryState);
  assert(!(await isPresent(join(project.stateDirectory, 'release-installation.json'))));
  project.standIn.onGithub.deleted.clear();
  project.standIn.onGithub.uninstalled.clear();
  project.standIn.live.builder -= 1;
  const next = await project.attempt();
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 2, release: 1 });
  assert.deepEqual(project.standIn.installs, { builder: 2, release: 2 });
}

testCase('a finished setup stops on an unreachable App check before repairing the other App');
{
  // GitHub answers that the release App is gone but cannot be reached for the builder App: the stop is the
  // unreachable check, nothing is removed, and once GitHub answers for both the next run names both Apps it
  // finds gone in one stop.
  const project = await finishedSetup('one-unchecked');
  const before = await readTree(project.retryState);
  project.standIn.onGithub.deleted.add('release');
  project.standIn.onGithub.unreachable.add('builder');
  assertStopped(await project.attempt(), appGoneStops.unchecked('builder', project.repository), project.retryState);
  assert.deepEqual(await readTree(project.retryState), before);
  project.standIn.onGithub.unreachable.clear();
  project.standIn.onGithub.deleted.add('builder');
  assertStopped(await project.attempt(), [BOTH_UNUSABLE(`the builder and release Apps for ${project.repository} are no longer on your GitHub account`, project.repository), 'apps-unusable'], project.retryState);
  project.standIn.onGithub.deleted.clear();
  project.standIn.live.builder -= 1;
  project.standIn.live.release -= 1;
  const next = await project.attempt();
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 2, release: 2 });
}

testCase('a finished setup whose App sign-in GitHub refuses over the clock keeps every saved file, then is set up again');
{
  // GitHub refuses the builder App's sign-in because this server's clock is off, and answers 404 for the release
  // App: the clock proves nothing is gone, so the stop names it, nothing is removed, and once the clock is right
  // no App is created again.
  const project = await finishedSetup('sign-in-clock');
  const before = await readTree(project.retryState);
  project.standIn.onGithub.clockRejected.add('builder');
  project.standIn.onGithub.deleted.add('release');
  const stopped = await project.attempt();
  assertStopped(stopped, appGoneStops.clock('builder', project.repository), project.retryState);
  assert.equal(stopped.messages.filter(line => line.startsWith('Setup stopped because')).length, 1);
  assert.deepEqual(await readTree(project.retryState), before);
  project.standIn.onGithub.clockRejected.clear();
  project.standIn.onGithub.deleted.clear();
  const again = await project.attempt();
  assert.equal(again.error, undefined);
  assert.deepEqual(again.messages, [`The Forge is already set up for ${project.repository}.`]);
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  assert.deepEqual(project.standIn.installs, { builder: 1, release: 1 });
}

for (const kind of ['builder', 'release']) {
  const other = kind === 'builder' ? 'release' : 'builder';
  testCase(`a finished setup whose ${kind} App key GitHub no longer accepts stops, then creates it again`);
  {
    // GitHub refuses the App's sign-in with the server's clock right: the App was deleted or its key revoked.
    // The stop says to delete the App if it is still listed, its records go, and once the owner has deleted it
    // the next run ends with one App per role.
    const project = await finishedSetup(`${kind}-key-rejected`);
    project.standIn.onGithub.keyRejected.add(kind);
    const stopped = await project.attempt();
    assertStopped(stopped, appGoneStops.keyRejected(kind, project.repository), project.retryState);
    assert.equal(stopped.messages.filter(line => line.startsWith('Setup stopped because')).length, 1);
    assert(!(await isPresent(join(project.credentialDirectory, `${kind}-app.json`))));
    assert(!(await isPresent(join(project.stateDirectory, `${kind}-installation.json`))));
    assert(await isPresent(join(project.credentialDirectory, `${other}-app.json`)));
    assert(!(await isPresent(join(project.stateDirectory, 'registration.json'))));
    project.standIn.onGithub.keyRejected.clear();
    project.standIn.live[kind] -= 1;
    const next = await project.attempt();
    assert.equal(next.error, undefined);
    assert(completedFor(project.repository)(next.messages.at(-1)));
    assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
    assert.deepEqual((await project.attempt()).messages, [`The Forge is already set up for ${project.repository}.`]);
  }
}

testCase('a finished setup whose two App keys GitHub no longer accepts names both Apps in one stop');
{
  const project = await finishedSetup('both-key-rejected');
  project.standIn.onGithub.keyRejected.add('builder');
  project.standIn.onGithub.keyRejected.add('release');
  assertStopped(await project.attempt(), [BOTH_UNUSABLE(`GitHub no longer accepts the saved keys of the builder and release Apps for ${project.repository}`, project.repository), 'apps-unusable'], project.retryState);
  project.standIn.onGithub.keyRejected.clear();
  project.standIn.live.builder -= 1;
  project.standIn.live.release -= 1;
  const next = await project.attempt();
  assert.equal(next.error, undefined);
  assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
}

// Saved App details that setup can no longer read (#61, #96). With the keys still in the pending record the App
// is finished from them, and both files stay as they are; without them setup stops until the owner has it start
// those details afresh, then says the next run creates a new App, and following it gives one App per role on
// GitHub.
testCase('damaged builder details with its keys still in the pending record finish without a new App');
{
  const project = await finishedSetup('damaged-keys-kept');
  const detailsPath = join(project.credentialDirectory, 'builder-app.json');
  const saved = JSON.parse(await readFile(detailsPath, 'utf8'));
  await rm(join(project.stateDirectory, 'registration.json'));
  await writePrivateJson(join(project.credentialDirectory, 'builder-app-pending.json'), { code: 'spent', credentials: saved });
  await writeFile(detailsPath, '{"id": 1');
  const next = await project.attempt();
  assert.equal(next.error, undefined);
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert(!next.messages.some(line => line.includes('delete')), next.messages.join('\n'));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  // The cut-short details are saved again from the keys in the pending record, never left behind as complete.
  assert.deepEqual(JSON.parse(await readFile(detailsPath, 'utf8')), saved);
  const again = await project.attempt();
  assert(completedFor(project.repository)(again.messages.at(-1)) || again.messages.at(-1) === `The Forge is already set up for ${project.repository}.`);
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
}

// An empty details file, or one that links to a removed file, cannot be read (#62, #96): setup stops until the
// owner has it start that file afresh, then does what it does for a deleted one.
for (const [name, slug, damage] of [
  ['an empty builder details file', 'empty', path => writeFile(path, '')],
  ['a builder details file that links to a removed file', 'missing', async path => { await rm(path); await symlink(`${path}.removed`, path); }]
]) {
  testCase(`${name} stops with one sentence, and started afresh the retry completes`);
  const project = await finishedSetup(`unusable-${slug}`);
  await damage(join(project.credentialDirectory, 'builder-app.json'));
  assertStopped(await project.attempt(), [DETAILS_UNREADABLE('builder', project.repository), 'unreadable-app-details'], project.retryState);
  assertStopped(await project.attempt({ startAfresh: 'builder-app' }), [UNUSABLE('builder', project.repository, 'missing'), 'missing-app-details'], project.retryState);
  project.standIn.live.builder -= 1;
  const next = await project.attempt();
  assert.equal(next.error, undefined);
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
}

// Both Apps unusable at once: one run names both, and after the owner deletes them the next run completes.
// Details setup cannot read stop first, naming both Apps when it cannot read either, until the owner has setup
// start them afresh.
for (const [name, slug, finished, breakApps, afresh, clause] of [
  ['a finished setup with both details files damaged', 'both-damaged', true,
    project => Promise.all(['builder', 'release'].map(kind => writeFile(join(project.credentialDirectory, `${kind}-app.json`), '{'))),
    'both-apps', () => 'the saved details of the builder and release Apps on this server are missing'],
  ['an unfinished setup with both details files deleted', 'both-missing', false,
    project => Promise.all(['builder', 'release'].map(kind => rm(join(project.credentialDirectory, `${kind}-app.json`)))),
    undefined, () => 'the saved details of the builder and release Apps on this server are missing'],
  ['a finished setup with the builder App gone and release details damaged', 'gone-and-damaged', true,
    async project => {
      project.standIn.onGithub.deleted.add('builder');
      await writeFile(join(project.credentialDirectory, 'release-app.json'), '{');
    },
    'release-app', repository => `the builder App for ${repository} is no longer on your GitHub account and the saved details of the release App on this server are missing`]
]) {
  testCase(`${name} names both Apps in one stop, then the retry completes`);
  const project = await finishedSetup(slug);
  if (!finished) await rm(join(project.stateDirectory, 'registration.json'));
  await breakApps(project);
  if (afresh) {
    const unreadable = afresh === 'both-apps' ? BOTH_DETAILS_UNREADABLE(project.repository) : DETAILS_UNREADABLE('release', project.repository);
    assertStopped(await project.attempt(), [unreadable, 'unreadable-app-details'], project.retryState);
  }
  assertStopped(await project.attempt({ startAfresh: afresh }), [BOTH_UNUSABLE(clause(project.repository), project.repository), 'apps-unusable'], project.retryState);
  project.standIn.onGithub.deleted.clear();
  project.standIn.live.builder -= 1;
  project.standIn.live.release -= 1;
  const next = await project.attempt();
  assert.equal(next.error, undefined);
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 2, release: 2 });
  assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
}

// setup's list of the Apps it made (#81), kept in the project checkout's .git folder: an App on it that this
// server can no longer use is named for deletion before setup makes that role's App again, whatever the saved
// state says, so GitHub never holds two Apps of one role.
const appRecordPath = project => join(project.checkout, '.git', 'godspeed-forge-apps.json');
const RECORDED_STOP = (kind, repository) => [`Setup stopped because the ${kind} App "Forge ${kind}" for ${repository} is still on your GitHub account, but this server no longer has what setup needs to use it; delete "Forge ${kind}" in your GitHub App settings, then try setup again, which creates a new ${kind} App. Setup kept "Forge ${kind}" and deleted nothing.`, 'app-unusable'];
const BOTH_RECORDED = repository => `${BOTH_UNUSABLE(`the builder App "Forge builder" and the release App "Forge release" for ${repository} are still on your GitHub account but this server no longer has what setup needs to use them`, repository)} Setup kept both and deleted nothing.`;

testCase('setup\'s list of the Apps it made holds each App\'s role, name, slug and id, and no key');
{
  const project = await finishedSetup('app-record');
  const text = await readFile(appRecordPath(project), 'utf8');
  assert.deepEqual(JSON.parse(text), {
    builder: { name: 'Forge builder', slug: 'code-builder-1', id: 12345 },
    release: { name: 'Forge release', slug: 'code-release-1', id: 12345 }
  });
  for (const secret of [credentials.pem, credentials.client_secret, credentials.webhook_secret]) assert(!text.includes(secret));
  assert.equal((await stat(appRecordPath(project))).mode & 0o777, 0o600);
}

// A link to a removed file cannot be read: setup stops on it until the owner has setup start it afresh.
for (const [how, slug, lose, startAfresh] of [
  ['deleted', 'deleted', path => rm(path)],
  ['a link to a removed file', 'link', async path => { await rm(path); await symlink(`${path}.removed`, path); }, 'builder-app']
]) {
  testCase(`builder details ${how} with no install record on an unfinished setup name the App to delete, then it is made once`);
  const project = await finishedSetup(`lost-builder-${slug}`);
  await rm(join(project.stateDirectory, 'registration.json'));
  await rm(join(project.stateDirectory, 'builder-installation.json'));
  await lose(join(project.credentialDirectory, 'builder-app.json'));
  if (startAfresh) {
    assertStopped(await project.attempt(), [DETAILS_UNREADABLE('builder', project.repository), 'unreadable-app-details'], project.retryState);
  }
  assertStopped(await project.attempt({ startAfresh }), RECORDED_STOP('builder', project.repository), project.retryState);
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  project.standIn.live.builder -= 1;
  const next = await project.attempt();
  assert.equal(next.error, undefined);
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 2, release: 1 });
  assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
}

for (const finished of [false, true]) {
  testCase(`both App details gone${finished ? ' on a finished setup' : ''}: no App is made again until the owner deletes both`);
  const project = await finishedSetup(`both-lost-${finished ? 'finished' : 'unfinished'}`);
  if (!finished) await rm(join(project.stateDirectory, 'registration.json'));
  for (const kind of ['builder', 'release']) {
    await rm(join(project.credentialDirectory, `${kind}-app.json`));
    await rm(join(project.stateDirectory, `${kind}-installation.json`));
  }
  const first = finished
    ? [`Setup stopped because the saved details of the builder App "Forge builder" and the release App "Forge release" on this server are missing, so setup can no longer use either App; delete "Forge builder" and "Forge release", then try setup again, which creates both Apps again.`, 'apps-unusable']
    : [BOTH_RECORDED(project.repository), 'apps-unusable'];
  assertStopped(await project.attempt(), first, project.retryState);
  // Trying again without deleting them names both Apps again instead of making a second of each.
  assertStopped(await project.attempt(), [BOTH_RECORDED(project.repository), 'apps-unusable'], project.retryState);
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  project.standIn.live.builder -= 1;
  project.standIn.live.release -= 1;
  const next = await project.attempt();
  assert.equal(next.error, undefined);
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 2, release: 2 });
  assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
}

testCase('an App on setup\'s list that GitHub cannot be asked about stops setup, which creates nothing');
{
  const project = await finishedSetup('record-unchecked');
  await rm(join(project.stateDirectory, 'registration.json'));
  await rm(join(project.stateDirectory, 'builder-installation.json'));
  await rm(join(project.credentialDirectory, 'builder-app.json'));
  const before = await readFile(appRecordPath(project), 'utf8');
  project.standIn.onGithub.unreachable.add('builder');
  assertStopped(await project.attempt(), [`Setup stopped because GitHub could not be reached to check whether the builder App "Forge builder" for ${project.repository} is still on your GitHub account. Restore this server's access to GitHub before trying setup again.`, 'app-record-check'], project.retryState);
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  assert.equal(await readFile(appRecordPath(project), 'utf8'), before);
}

testCase('an App on setup\'s list that GitHub refuses to be asked about stops setup, which creates nothing and changes nothing');
{
  const project = await finishedSetup('record-refused');
  await rm(join(project.stateDirectory, 'registration.json'));
  await rm(join(project.stateDirectory, 'builder-installation.json'));
  await rm(join(project.credentialDirectory, 'builder-app.json'));
  const before = await readFile(appRecordPath(project), 'utf8');
  project.standIn.onGithub.refused.add('builder');
  const refusedStop = [`Setup stopped because GitHub refused setup's request to check whether the builder App "Forge builder" for ${project.repository} is still on your GitHub account, so setup changed nothing. Check that this server's GitHub sign-in is the GitHub account that owns "Forge builder", then try setup again.`, 'app-record-refused'];
  assertStopped(await project.attempt(), refusedStop, project.retryState);
  assertStopped(await project.attempt(), refusedStop, project.retryState);
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  assert.equal(await readFile(appRecordPath(project), 'utf8'), before);
  // Once GitHub answers again, the App on the list is still there and setup names it instead of making a second.
  project.standIn.onGithub.refused.clear();
  assertStopped(await project.attempt(), RECORDED_STOP('builder', project.repository), project.retryState);
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
}

testCase('state restored from an older copy after the owner deleted the App it holds never reports setup complete without that App');
{
  // The restored state still holds the builder App's details, its install record and the list's entry for it,
  // but the owner deleted that App on GitHub. Setup must not finish with it: it stops, and the retry creates it.
  const project = await finishedSetup('restored-deleted');
  await rm(join(project.stateDirectory, 'registration.json'));
  project.standIn.onGithub.deleted.add('builder');
  project.standIn.live.builder -= 1;
  const stopped = await project.attempt();
  assertStopped(stopped, appGoneStops.gone('builder', project.repository), project.retryState);
  assert(!stopped.messages.some(completedFor(project.repository)));
  assert(!stopped.messages.some(line => line.includes('"Forge builder"')));
  await assert.rejects(stat(join(project.credentialDirectory, 'builder-app.json')));
  await assert.rejects(stat(join(project.stateDirectory, 'builder-installation.json')));
  project.standIn.onGithub.deleted.clear();
  const next = await project.attempt();
  assert.equal(next.error, undefined);
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 2, release: 1 });
  assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
  assert.equal(JSON.parse(await readFile(appRecordPath(project), 'utf8')).builder.slug, 'code-builder-2');
}

testCase('state restored from an older copy whose App is no longer installed asks to install it again');
{
  const project = await finishedSetup('restored-uninstalled');
  await rm(join(project.stateDirectory, 'registration.json'));
  project.standIn.onGithub.uninstalled.add('builder');
  const next = await project.attempt();
  assert.equal(next.error, undefined);
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  assert.deepEqual(project.standIn.installs, { builder: 2, release: 1 });
}

testCase('a damaged list of setup\'s Apps is left as it is while this server holds both Apps');
{
  const project = await finishedSetup('record-damaged');
  await rm(join(project.stateDirectory, 'registration.json'));
  await writeFile(appRecordPath(project), '{');
  const next = await project.attempt();
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  assert.equal(await readFile(appRecordPath(project), 'utf8'), '{');
  // Started afresh, the list is replaced with one naming the Apps setup uses, and setup runs to the end again.
  const afresh = await project.attempt({ startAfresh: 'app-list' });
  assert(completedFor(project.repository)(afresh.messages.at(-1)));
  assert.equal(JSON.parse(await readFile(appRecordPath(project), 'utf8')).builder.slug, 'code-builder-1');
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
}

testCase('a damaged list of setup\'s Apps stops setup, which creates nothing, until the owner starts it afresh');
{
  const project = await finishedSetup('record-damaged-app-lost');
  await rm(join(project.stateDirectory, 'registration.json'));
  await rm(join(project.stateDirectory, 'release-installation.json'));
  await rm(join(project.credentialDirectory, 'release-app.json'));
  await writeFile(appRecordPath(project), '{');
  const stopped = await project.attempt();
  assertStopped(stopped, [LIST_UNREADABLE(project.repository), 'unreadable-app-list'], project.retryState);
  assert.equal(await readFile(appRecordPath(project), 'utf8'), '{');
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  project.standIn.live.release -= 1;
  const next = await project.attempt({ startAfresh: 'app-list' });
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 2 });
  assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
  assert.equal(JSON.parse(await readFile(appRecordPath(project), 'utf8')).release.slug, 'code-release-2');
}

testCase('a list of setup\'s Apps that cannot be saved stops setup before it creates anything');
{
  const project = await finishedSetup('record-unwritable');
  await rm(join(project.stateDirectory, 'registration.json'));
  await rm(appRecordPath(project));
  await rm(join(project.stateDirectory, 'release-installation.json'));
  await rm(join(project.credentialDirectory, 'release-app.json'));
  await chmod(join(project.checkout, '.git'), 0o500);
  let stopped;
  try {
    stopped = await project.attempt();
  } finally {
    await chmod(join(project.checkout, '.git'), 0o700);
  }
  assertStopped(stopped, [`Setup stopped because it could not save the list of GitHub Apps it keeps in the project folder for ${project.repository} on this server. Let setup write to that project folder before trying setup again.`, 'app-record'], project.retryState);
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
}

testCase('saved state restored from an older copy names the newer App on GitHub, then creates a new one');
{
  // The saved builder details are those of an older builder App, no longer on GitHub, while the list names
  // the newer one (#79). Once the owner deletes the newer App, the role has none, so setup creates one.
  const project = await finishedSetup('restored-older');
  await rm(join(project.stateDirectory, 'registration.json'));
  await writePrivateJson(join(project.credentialDirectory, 'builder-app.json'), { ...credentials, slug: 'code-builder-0', id: 999 });
  assertStopped(await project.attempt(), RECORDED_STOP('builder', project.repository), project.retryState);
  project.standIn.live.builder -= 1;
  const next = await project.attempt();
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 2, release: 1 });
  assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
  assert.equal(JSON.parse(await readFile(appRecordPath(project), 'utf8')).builder.slug, 'code-builder-2');
}

// An older copy's builder App (code-builder-1) and the newer one setup's list names (code-builder-2) are both
// still on GitHub: two Apps for the role. Only the first has its key on this server.
async function twoBuilders(name, { finished }) {
  const project = await finishedSetup(name);
  if (!finished) await rm(join(project.stateDirectory, 'registration.json'));
  const asksAbout = project.standIn.github.appExists;
  project.standIn.github.appExists = async args => args.slug === 'code-builder-1' || asksAbout(args);
  project.standIn.counts.builder = 2;
  project.standIn.live.builder = 2;
  const list = JSON.parse(await readFile(appRecordPath(project), 'utf8'));
  list.builder = { name: 'Forge builder', slug: 'code-builder-2', id: 777 };
  await writePrivateJson(appRecordPath(project), list);
  return project;
}
const TWO_APPS_QUESTION = repository => `Two builder Apps exist on your GitHub account: "Forge builder" (code-builder-1), whose key this server holds, and "Forge builder" (code-builder-2). Setup can only use the first, and deletes neither. Answer code-builder-1 to use it from now on, and delete the other whenever you like.`;
const TWO_APPS_STOP = repository => [`Setup stopped because your GitHub account holds two builder Apps for ${repository}: "Forge builder" (code-builder-1), whose key this server holds, and "Forge builder" (code-builder-2). Setup kept both and deleted nothing. Try setup again and answer code-builder-1 in chat to use it from now on; delete the other in your GitHub App settings whenever you like.`, 'two-apps'];

for (const finished of [false, true]) {
  testCase(`two builder Apps on GitHub${finished ? ' on a finished setup' : ''}: setup asks which to use, keeps both and then uses the answer`);
  const project = await twoBuilders(`two-apps-${finished ? 'finished' : 'unfinished'}`, { finished });
  const stopped = await project.attempt();
  assertStopped(stopped, TWO_APPS_STOP(project.repository), project.retryState);
  assert.deepEqual(stopped.asked, [TWO_APPS_QUESTION(project.repository)]);
  assert(!stopped.messages.some(completedFor(project.repository)));
  const closed = await project.attempt({ closed: true });
  assertStopped(closed, TWO_APPS_STOP(project.repository), project.retryState);
  assert.deepEqual(project.standIn.live, { builder: 2, release: 1 });
  const wrong = await project.attempt({ choose: 'code-builder-2' });
  assertStopped(wrong, TWO_APPS_STOP(project.repository), project.retryState);
  assert.deepEqual(project.standIn.live, { builder: 2, release: 1 });
  assert.equal(JSON.parse(await readFile(appRecordPath(project), 'utf8')).builder.slug, 'code-builder-2');
  const next = await project.attempt({ choose: ' Code-Builder-1 ' });
  assert.equal(next.error, undefined);
  assert(finished ? next.messages.at(-1).includes('already set up') : completedFor(project.repository)(next.messages.at(-1)));
  assert.equal(next.asked.length, 1);
  assert.deepEqual(project.standIn.counts, { builder: 2, release: 1 });
  assert.deepEqual(project.standIn.live, { builder: 2, release: 1 });
  assert.equal(JSON.parse(await readFile(appRecordPath(project), 'utf8')).builder.slug, 'code-builder-1');
  const again = await project.attempt();
  assert.equal(again.error, undefined);
  assert.deepEqual(again.asked, []);
}

testCase('an App made outside setup under the name setup would give the role stops setup, which makes and deletes nothing');
{
  const project = await finishedSetup('outside-app');
  await rm(join(project.stateDirectory, 'registration.json'));
  await rm(join(project.stateDirectory, 'builder-installation.json'));
  await rm(join(project.credentialDirectory, 'builder-app.json'));
  await rm(appRecordPath(project));
  const asksAbout = project.standIn.github.appExists;
  project.standIn.github.appExists = async args => args.slug === 'forge-builder-owner-outside-app' || asksAbout(args);
  assertStopped(await project.attempt(), [`Setup stopped because a builder App named "Forge builder owner outside-app" is already on your GitHub account, and setup did not make it, so this server does not hold its key and cannot use it. Setup created nothing and deleted nothing; delete "Forge builder owner outside-app" in your GitHub App settings, then try setup again, which creates the builder App.`, 'app-outside'], project.retryState);
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
}

testCase('a finished setup whose role has lost its App still stops instead of reporting success');
{
  const project = await finishedSetup('finished-no-app');
  await rm(join(project.credentialDirectory, 'builder-app.json'));
  const stopped = await project.attempt();
  assert(stopped.error instanceof ReportedSetupError);
  assert(!stopped.messages.some(line => line.includes('already set up') || completedFor(project.repository)(line)));
}

testCase('an older App whose saved details setup holds, which GitHub cannot be asked about, stops setup, which keeps them');
{
  const project = await finishedSetup('restored-older-unchecked');
  await rm(join(project.stateDirectory, 'registration.json'));
  const detailsPath = join(project.credentialDirectory, 'builder-app.json');
  await writePrivateJson(detailsPath, { ...credentials, slug: 'code-olderbuilder-0', id: 999 });
  const details = await readFile(detailsPath, 'utf8');
  project.standIn.onGithub.unreachable.add('olderbuilder');
  assertStopped(await project.attempt(), [`Setup stopped because GitHub could not be reached to check whether the builder App "Forge builder" for ${project.repository} is still on your GitHub account. Restore this server's access to GitHub before trying setup again.`, 'app-record-check'], project.retryState);
  assert.equal(await readFile(detailsPath, 'utf8'), details);
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
}

// Damaged builder details and release details that are a folder: one stop names both and setup changes neither.
// When the owner puts the release details back by hand, the stop names only the builder's, which setup replaces
// once the owner asks it to start them afresh; following each stop never leaves a second builder App.
for (const finished of [true, false]) {
  testCase(`damaged builder details with unreadable release details${finished ? ' on a finished setup' : ''} change neither, then ask for the builder App's deletion`);
  const project = await finishedSetup(`damaged-then-unreadable-${finished ? 'finished' : 'unfinished'}`);
  if (!finished) await rm(join(project.stateDirectory, 'registration.json'));
  const builderPath = join(project.credentialDirectory, 'builder-app.json');
  const releasePath = join(project.credentialDirectory, 'release-app.json');
  const releaseDetails = await readFile(releasePath, 'utf8');
  await writeFile(builderPath, '{');
  await rm(releasePath);
  await mkdir(releasePath);
  assertStopped(await project.attempt(), [BOTH_DETAILS_UNREADABLE(project.repository), 'unreadable-app-details'], project.retryState);
  assert.equal(await readFile(builderPath, 'utf8'), '{');
  assert((await stat(releasePath)).isDirectory());
  await rm(releasePath, { recursive: true });
  await writeFile(releasePath, releaseDetails, { mode: 0o600 });
  assertStopped(await project.attempt(), [DETAILS_UNREADABLE('builder', project.repository), 'unreadable-app-details'], project.retryState);
  assert.equal(await readFile(builderPath, 'utf8'), '{');
  assertStopped(await project.attempt({ startAfresh: 'builder-app' }), [UNUSABLE('builder', project.repository, 'missing'), 'missing-app-details'], project.retryState);
  assert(!(await isPresent(builderPath)));
  project.standIn.live.builder -= 1;
  const next = await project.attempt();
  assert.equal(next.error, undefined);
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 2, release: 1 });
  assert.deepEqual(project.standIn.live, { builder: 1, release: 1 });
}

for (const removed of ['settings', 'folder']) {
  testCase(`a finished setup whose build tools ${removed} are gone stops, then installs them again`);
  // The build tools' settings, or the whole project folder, are gone from this server.
  const project = await finishedSetup(`build-tools-${removed}`);
  await rm(removed === 'settings' ? join(project.checkout, '.factory/consumer.json') : project.checkout, { recursive: true });
  assertStopped(await project.attempt(), appGoneStops.buildTools(project.repository), project.retryState);
  assert(!(await isPresent(join(project.stateDirectory, 'registration.json'))));
  const next = await project.attempt();
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert(await isPresent(join(project.checkout, '.factory/consumer.json')));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
}

// A finished setup whose mission or installed build tools are gone is set up again in the same run, from the
// saved answers and with the same Apps.
for (const [removed, verb, remove] of [
  ['mission', 'is', project => writeFile(join(project.checkout, 'MISSION.md'), '# Mission\n\nFactory template.\n')],
  ['mission file', 'is', project => rm(join(project.checkout, 'MISSION.md'))],
  ['installed build tools', 'are', project => rm(join(project.checkout, 'factory'), { recursive: true })]
]) {
  testCase(`a finished setup whose ${removed} ${verb} gone sets it up again without asking`);
  const project = await finishedSetup(`${removed.replaceAll(' ', '-')}-removed`);
  await remove(project);
  const again = await project.attempt();
  assert.equal(again.error, undefined, removed);
  assert.deepEqual(again.prompts, []);
  assert.equal(again.messages[0], 'Using Claude Code to set up the Forge.');
  assert(completedFor(project.repository)(again.messages.at(-1)));
  assert(!again.messages.some(line => line.includes('already set up')));
  assert.match(await readFile(join(project.checkout, 'MISSION.md'), 'utf8'),
    /\n## Project mission\n\nWhat this software is for: Purpose\.\n\nWho uses it: Users\.\n$/);
  assert(await isPresent(join(project.checkout, 'factory/consumer.py')));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  assert.deepEqual(project.standIn.installs, { builder: 1, release: 1 });
  assert.deepEqual((await project.attempt()).messages, [`The Forge is already set up for ${project.repository}.`]);
}

// A finished setup whose final check now fails stops as a first run stopped by that failure would.
for (const [name, report, message] of [
  ['a named refusal', 'Factory refused: No bash to run the holdout fence (bash not found)',
    'Setup stopped because the final check found that the bash shell is not installed on this server. Install bash before trying setup again.'],
  ['an unknown failure', 'Traceback (most recent call last):\nRuntimeError: something broke',
    'Setup stopped because the final check could not confirm that the build tools setup installed on this server work. Try setup again.']
]) {
  testCase(`a finished setup whose final check now fails with ${name} stops, then completes once fixed`);
  const project = await finishedSetup(`final-check-${name.replaceAll(' ', '-')}`);
  const failing = { doctor: async () => { throw Object.assign(new Error('Command failed'), { stderr: report }); } };
  const stopped = await project.attempt(failing);
  assertStopped(stopped, [message, 'final-check'], project.retryState);
  assert.deepEqual(stopped.messages, ['Using Claude Code to set up the Forge.', BROWSER_PASSED, FORGE_APPS_KEPT, message]);
  assert.deepEqual(stopped.prompts, []);
  assert(!(await isPresent(join(project.stateDirectory, 'registration.json'))));
  assertStopped(await project.attempt(failing), [message, 'final-check'], project.retryState);
  const next = await project.attempt();
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  assert.deepEqual((await project.attempt()).messages, [`The Forge is already set up for ${project.repository}.`]);
}

testCase('a finished setup being set up again says the Apps are kept when it stops before reusing them');
{
  const project = await finishedSetup('repair-init-fails');
  await rm(join(project.checkout, 'MISSION.md'));
  const message = 'Setup stopped because the build tools it downloaded could not prepare the project on this server. Install the latest version of the Forge on this server before trying setup again.';
  const stopped = await project.attempt({ init: async () => { throw new Error('python3 failed.'); } });
  assertStopped(stopped, [message, 'initialization'], project.retryState);
  assert.deepEqual(stopped.messages, ['Using Claude Code to set up the Forge.', BROWSER_PASSED, FORGE_APPS_KEPT, message]);
  assert(completedFor(project.repository)((await project.attempt()).messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
}

testCase('a finished setup with GitHub unreachable changes nothing, and with nothing missing says it is set up');
{
  // GitHub cannot be reached: nothing is changed and the next run checks again. With nothing missing a rerun
  // says it is set up, creates nothing and changes no saved file.
  const project = await finishedSetup('nothing-missing');
  const saved = async () => [await readTree(project.retryState), await readTree(project.checkout)];
  const before = await saved();
  project.standIn.onGithub.unreachable.add('builder').add('release');
  assertStopped(await project.attempt(), appGoneStops.unchecked('builder', project.repository), project.retryState);
  assert.deepEqual(await saved(), before);
  project.standIn.onGithub.unreachable.clear();
  const again = await project.attempt();
  assert.equal(again.error, undefined);
  assert.deepEqual(again.messages, [`The Forge is already set up for ${project.repository}.`]);
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
  assert.deepEqual(project.standIn.installs, { builder: 1, release: 1 });
  assert.deepEqual(await saved(), before);
}

testCase('a finished setup whose App check GitHub refuses keeps every saved file, then says it is set up');
{
  // GitHub refuses the request to check the builder App (#82): the stop says so instead of calling GitHub
  // unreachable, nothing is changed, and once GitHub answers the next run says it is set up.
  const project = await finishedSetup('check-refused');
  const before = await readTree(project.retryState);
  project.standIn.onGithub.refused.add('builder');
  assertStopped(await project.attempt(), appGoneStops.refused('builder', project.repository), project.retryState);
  assert.deepEqual(await readTree(project.retryState), before);
  project.standIn.onGithub.refused.clear();
  const again = await project.attempt();
  assert.equal(again.error, undefined);
  assert.deepEqual(again.messages, [`The Forge is already set up for ${project.repository}.`]);
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
}

testCase('kept App keys whose check GitHub refuses stay for the next run');
{
  const project = await keysKeptSetup('kept-refused');
  const kept = await readFile(project.pendingPath, 'utf8');
  project.standIn.onGithub.refused.add('builder');
  assertStopped(await project.attempt(), appGoneStops.refused('builder', project.repository), project.retryState);
  assert.deepEqual(project.standIn.installs, { builder: 0, release: 0 });
  assert.equal(await readFile(project.pendingPath, 'utf8'), kept);
  project.standIn.onGithub.refused.clear();
  const next = await project.attempt();
  assert.equal(next.error, undefined);
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 1, release: 1 });
}

testCase('an unfinished setup whose App details are gone does not skip that App');
{
  // An unfinished setup whose App details are gone while the App's install record stays does not skip that App.
  const stateDirectory = join(root, 'details-gone-installed');
  const credentialDirectory = join(stateDirectory, 'credentials');
  const installationPath = join(stateDirectory, 'builder-installation.json');
  await writePrivateJson(installationPath, { repository: 'owner/repo', confirmed: true });
  const standIn = standInGithub();
  await assert.rejects(createApps({ checkout: join(root, 'direct-checkouts', '11'), repository: 'owner/repo', stateDirectory, credentialDirectory, github: standIn.github, output: () => {} }),
    error => error instanceof AppSetupStop && error.reason === 'missing' && error.kind === 'builder');
  assert(!(await isPresent(installationPath)));
  assert.deepEqual(standIn.counts, { builder: 0, release: 0 });
}

testCase('a finished setup\'s Apps are not created again');
await createApps({ checkout,
  repository: 'owner/repo', stateDirectory: projectStatePath(state, 'owner/repo'),
  credentialDirectory: credentialPath(state, 'owner/repo'), output: () => {},
  github: { exists: isPresent, begin: async () => { throw new Error('must not create'); }, appStatus: async () => 'installed' }
});

testCase('the GitHub adapter reads the App code and tells refused exchanges from failed ones');
{
  const requests = [];
  const responses = [];
  const adapter = createGithubAdapter({
    input: { question: async () => 'http://127.0.0.1/?code=abc' },
    fetch: async (url, init) => {
      requests.push({ url, method: init.method });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { status: next.status, ok: next.status < 300, json: async () => next.body };
    }
  });
  assert.equal(await adapter.callback(), 'abc');
  const noCode = error => error instanceof AppStepError && error.step === 'page';
  await assert.rejects(createGithubAdapter({ input: { question: async () => 'http://127.0.0.1/' } }).callback(), noCode);
  await assert.rejects(createGithubAdapter({ input: { question: async () => 'not an address' } }).callback(), noCode);
  for (const status of [404, 422]) {
    responses.push({ status });
    await assert.rejects(adapter.exchange('abc'), error => error.refused === true);
  }
  responses.push({ status: 502 });
  await assert.rejects(adapter.exchange('abc'), error => !error.refused);
  responses.push(new TypeError('fetch failed'));
  await assert.rejects(adapter.exchange('abc'), error => !error.refused);
  responses.push({ status: 201, body: credentials });
  assert.deepEqual(await adapter.exchange('abc'), credentials);
  assert(requests.every(request => request.url === 'https://api.github.com/app-manifests/abc/conversions' && request.method === 'POST'));
}

testCase('the GitHub adapter asks this server\'s gh sign-in whether an App is on GitHub, and tells gone, refused and no answer apart');
{
  const asked = [];
  const answers = [];
  const adapter = createGithubAdapter({
    input: {},
    run: async (command, args) => {
      asked.push([command, ...args]);
      const failure = answers.shift();
      if (failure) throw failure;
      return { stdout: '{}', stderr: '' };
    }
  });
  const ghFailed = stderr => Object.assign(new Error('gh failed.'), { stdout: '', stderr });
  answers.push(null);
  assert.equal(await adapter.appExists({ slug: 'forge builder', gh: 'gh-custom' }), true);
  assert.deepEqual(asked.at(-1), ['gh-custom', 'api', '--method', 'GET', 'apps/forge%20builder']);
  answers.push(ghFailed('{"message":"Not Found","status":"404"}gh: Not Found (HTTP 404)\n'));
  assert.equal(await adapter.appExists({ slug: 'forge-builder' }), false);
  assert.equal(asked.at(-1)[0], 'gh');
  for (const failure of [ghFailed('gh: Bad credentials (HTTP 401)\n'), ghFailed('gh: Forbidden (HTTP 403)\n')]) {
    answers.push(failure);
    await assert.rejects(adapter.appExists({ slug: 'forge-builder' }), error => error.refused === true);
  }
  for (const failure of [ghFailed('gh: Server Error (HTTP 502)\n'), new Error('Could not run gh.')]) {
    answers.push(failure);
    await assert.rejects(adapter.appExists({ slug: 'forge-builder' }), error => /could not be reached/.test(error.message) && !error.refused);
  }
}

testCase('the GitHub adapter checks an App as the App itself and tells gone, clock-refused, key-refused, uninstalled, refused and unreachable apart');
{
  // appStatus asks GitHub as the App itself, signed with the App's saved key.
  const requests = [];
  const responses = [];
  const adapter = createGithubAdapter({
    input: { question: async () => '' },
    fetch: async (url, init) => {
      requests.push({ url, method: init.method, authorization: init.headers.authorization });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'number') return { status: next };
      // A 401 carries GitHub's Date header and error message.
      return { status: next.status, headers: new Headers(next.date ? { date: next.date } : {}), json: async () => ({ message: next.message }) };
    }
  });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const app = { ...credentials, pem: privateKey.export({ type: 'pkcs1', format: 'pem' }) };
  const status = async (...answers) => {
    requests.length = 0;
    responses.push(...answers);
    return adapter.appStatus({ credentials: app, repository: 'owner/repo', kind: 'builder' });
  };
  assert.equal(await status(200, 200), 'installed');
  assert.deepEqual(requests.map(request => [request.method, request.url]), [
    ['GET', 'https://api.github.com/app'], ['GET', 'https://api.github.com/repos/owner/repo/installation']
  ]);
  for (const { authorization } of requests) {
    const [header, payload, signature] = authorization.replace(/^Bearer /, '').split('.');
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, String(credentials.id));
    assert(verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
  }
  assert.equal(await status(404), 'app-missing');
  // A 401 is put down to the clock only when GitHub's Date is more than a minute off or its message is about the
  // token's issued-at or expiry time; any other 401 means GitHub no longer accepts the App's key.
  const at = offset => new Date(Date.now() + offset).toUTCString();
  const refused = 'A JSON web token could not be decoded';
  assert.equal(await status({ status: 401, date: at(5 * 60_000), message: refused }), 'clock-rejected');
  assert.equal(await status({ status: 401, date: at(-5 * 60_000), message: refused }), 'clock-rejected');
  assert.equal(await status({ status: 401, date: at(0), message: "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued" }), 'clock-rejected');
  assert.equal(await status({ status: 401, date: at(0), message: "'Expiration time' claim ('exp') is too far in the future" }), 'clock-rejected');
  assert.equal(await status({ status: 401, date: at(0), message: 'Integration not found' }), 'key-rejected');
  assert.equal(await status({ status: 401, date: at(0), message: refused }), 'key-rejected');
  assert.equal(await status({ status: 401 }), 'key-rejected');
  assert.equal(await status(401), 'key-rejected');
  assert.equal(requests.length, 1);
  assert.equal(await status(200, 404), 'not-installed');
  for (const answers of [[502], [200, 500], [200, 429], [new TypeError('fetch failed')]]) {
    await assert.rejects(status(...answers), error => error.message === 'GitHub could not be reached to check the App.' && !error.refused);
    responses.length = 0;
  }
  // A request GitHub refuses is not called a network problem (#82).
  for (const answers of [[200, 401], [200, 403], [403]]) {
    await assert.rejects(status(...answers), error => error.message === 'GitHub refused the request to check the App.' && error.refused === true);
    responses.length = 0;
  }
  requests.length = 0;
  assert.equal(await adapter.appStatus({ credentials, repository: 'owner/repo', kind: 'builder' }), 'app-missing');
  assert.equal(requests.length, 0);
}

async function retryProject(repository) {
  // deleted: the owner has deleted every App setup made for repository on GitHub.
  const record = { prompts: [], begins: 0, calls: [], messages: [], deleted: false };
  const retryState = join(root, 'retry-state');
  const options = ({ failAt, answers = ['First purpose.', 'First users.'], startAfresh } = {}) => ({
    config: { ...defaults(root), projectsRoot: join(root, 'retry-projects') }, paths: { state: retryState }, startAfresh,
    commands: {
      run: async (command, args, runOptions = {}) => {
        record.calls.push({ command, args });
        if (command === 'claude') return { stdout: 'signed in' };
        if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
        if (command === 'git' && args[0] === 'remote') return { stdout: `git@github.com:${repository}.git\n` };
        if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
        if (command === 'python3' && args[1] === 'init') {
          await mkdir(join(runOptions.cwd, 'factory'), { recursive: true });
          try { await stat(join(runOptions.cwd, 'MISSION.md')); } catch {
            await writeFile(join(runOptions.cwd, 'MISSION.md'), '# Mission\n\nFactory template.\n');
          }
          await mkdir(join(runOptions.cwd, '.factory'), { recursive: true });
          await writeFile(join(runOptions.cwd, '.factory/consumer.json'), '{}\n');
        }
        return { stdout: '' };
      }
    },
    github: {
      exists: async path => { try { await stat(path); return true; } catch { return false; } },
      begin: async manifest => {
        record.begins += 1;
        if (failAt === 'github') throw new Error('GitHub page not completed');
        return { url: `https://example.test/${manifest.name}` };
      },
      callback: async () => 'code',
      exchange: async () => credentials,
      install: async () => true,
      appExists: async ({ slug }) => !record.deleted && !slug.startsWith('forge-'),
      appStatus: async () => 'installed'
    },
    // Stops after the Apps and the mission answers, where the final check no longer is.
    factorySetup: async () => { if (failAt === 'after-mission') throw new SetupStop('Stopped after the mission.', 'after-mission'); },
    prompt: async question => { record.prompts.push(question); return answers[record.prompts.length - 1] ?? 'Other.'; },
    output: value => record.messages.push(value)
  });
  const missionPath = join(root, 'retry-projects', repository, 'MISSION.md');
  const missionSections = async () => (await readFile(missionPath, 'utf8')).match(/^## Project mission$/gm)?.length ?? 0;
  return { record, options, missionPath, missionSections, reset: () => {
    record.prompts.length = 0; record.begins = 0; record.calls.length = 0; record.messages.length = 0;
  } };
}

testCase('a stop after the mission answers does not ask them again on retry');
// A stop after the mission answers: the retry does not ask them again.
{
  const project = await retryProject('owner/stopped-after-mission');
  await assert.rejects(setupRepository('owner/stopped-after-mission', project.options({ failAt: 'after-mission' })),
    error => error instanceof ReportedSetupError && error.message === 'after-mission');
  assert.deepEqual(project.record.prompts, ['What is this software for?', 'Who uses it?']);
  project.reset();
  const result = await setupRepository('owner/stopped-after-mission', project.options({ answers: ['Second purpose.', 'Second users.'] }));
  assert.equal(result.completed, true);
  assert.deepEqual(project.record.prompts, []);
  assert.equal(project.record.begins, 0);
  assert.equal(await project.missionSections(), 1);
  const mission = await readFile(project.missionPath, 'utf8');
  assert.match(mission, /What this software is for: First purpose\.\n\nWho uses it: First users\.\n$/);
  assert(!mission.includes('Second'));
  assert.match(project.record.messages.at(-1), /^Setup is complete for owner\/stopped-after-mission\./);
}

testCase('a stop before the mission answers asks them once on retry');
// A stop before the mission answers: the retry asks them once.
{
  const project = await retryProject('owner/stopped-before-mission');
  await assert.rejects(setupRepository('owner/stopped-before-mission', project.options({ failAt: 'github' })),
    error => error instanceof ReportedSetupError && error.message === 'github');
  assert.deepEqual(project.record.prompts, []);
  project.reset();
  await setupRepository('owner/stopped-before-mission', project.options());
  assert.deepEqual(project.record.prompts, ['What is this software for?', 'Who uses it?']);
  assert.equal(await project.missionSections(), 1);
  assert.match(await readFile(project.missionPath, 'utf8'), /\n## Project mission\n\nWhat this software is for: First purpose\.\n\nWho uses it: First users\.\n$/);
}

testCase('an empty mission answer stops setup and keeps only a first answer that was given');
// An empty answer stops setup. An empty first answer keeps nothing, so the next run asks both questions again,
// in order; an empty second answer keeps the first, so the next run asks only the second.
for (const [name, answers, asked] of [
  ['empty-first-answer', [' ', 'First users.'], ['What is this software for?', 'Who uses it?']],
  ['empty-second-answer', ['First purpose.', ''], ['Who uses it?']]
]) {
  const project = await retryProject(`owner/${name}`);
  await assert.rejects(setupRepository(`owner/${name}`, project.options({ answers })),
    error => error instanceof ReportedSetupError && error.message === 'mission');
  assert.equal(project.record.messages.at(-1), 'Setup stopped because both mission questions need an answer: what the software is for and who uses it. Try setup again and answer both.');
  assert.deepEqual(project.record.prompts, ['What is this software for?', 'Who uses it?']);
  project.reset();
  const retried = asked.length === 2 ? ['First purpose.', 'Second users.'] : ['Second users.'];
  assert.equal((await setupRepository(`owner/${name}`, project.options({ answers: retried }))).completed, true);
  assert.deepEqual(project.record.prompts, asked);
  assert.match(await readFile(project.missionPath, 'utf8'), /\n## Project mission\n\nWhat this software is for: First purpose\.\n\nWho uses it: Second users\.\n$/);
}

testCase('setup on a project that is already set up says so and changes nothing');
// Setup on a project that is already set up says so and changes nothing.
{
  const project = await retryProject('owner/already-set-up');
  await setupRepository('owner/already-set-up', project.options());
  assert.deepEqual(project.record.prompts, ['What is this software for?', 'Who uses it?']);
  assert.equal(project.record.begins, 2);
  assert.match(project.record.messages.at(-1), /^Setup is complete for owner\/already-set-up\./);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'retry-state/projects/owner/already-set-up/registration.json'), 'utf8')).completed, true);
  const missionBefore = await readFile(project.missionPath);
  project.reset();
  const result = await setupRepository('owner/already-set-up', project.options({ answers: ['Second purpose.', 'Second users.'] }));
  assert.equal(result.alreadySetUp, true);
  assert.deepEqual(project.record.prompts, []);
  assert.equal(project.record.begins, 0);
  assert.deepEqual(project.record.calls.map(call => call.args), [['factory/consumer.py', 'doctor']]);
  assert.deepEqual(await readFile(project.missionPath), missionBefore);
  assert.deepEqual(project.record.messages, ['The Forge is already set up for owner/already-set-up.']);
}

testCase('a project set up by an earlier release has its credentials moved');
// An already set-up project from an earlier release still has its credentials moved by asking for setup again.
{
  const project = await retryProject('owner/legacy-set-up');
  const legacyState = join(root, 'retry-state/projects/owner/legacy-set-up');
  const legacyCheckout = join(root, 'retry-projects/owner/legacy-set-up');
  await mkdir(join(legacyCheckout, '.git'), { recursive: true });
  await mkdir(join(legacyCheckout, '.factory'), { recursive: true });
  await writeFile(join(legacyCheckout, '.factory/consumer.json'), '{}\n');
  await mkdir(join(legacyCheckout, 'factory'), { recursive: true });
  await writeFile(join(legacyCheckout, 'factory/consumer.py'), '# factory stand-in\n');
  await writeFile(join(legacyCheckout, 'MISSION.md'), '# Mission\n\n## Project mission\n\nWhat this software is for: Purpose.\n\nWho uses it: Users.\n');
  await writePrivateJson(join(legacyState, 'registration.json'), { repository: 'owner/legacy-set-up', checkout: legacyCheckout, completed: true });
  for (const kind of ['builder', 'release']) {
    await writePrivateJson(join(legacyState, `${kind}-app.json`), credentials);
    await writePrivateJson(join(legacyState, `${kind}-installation.json`), { repository: 'owner/legacy-set-up', confirmed: true });
  }
  await setupRepository('owner/legacy-set-up', project.options());
  assert.deepEqual(project.record.messages, ['The Forge is already set up for owner/legacy-set-up.']);
  for (const kind of ['builder', 'release']) {
    await assert.rejects(stat(join(legacyState, `${kind}-app.json`)));
    assert.deepEqual(JSON.parse(await readFile(join(root, `retry-state/credentials/owner/legacy-set-up/${kind}-app.json`), 'utf8')), credentials);
  }
}

// Each stop below prints one plain message with one action, and setup completes once the cause is fixed,
// creating one App per role.
function assertPlainStop(printed, expected, serverRoot) {
  assert.deepEqual(printed, expected);
  for (const message of printed) {
    assert(!/EACCES|permission denied|GraphQL|HTTP|\bat \w|private setup detail/i.test(message), message);
    assert(!message.includes(serverRoot), message);
  }
}

testCase('an unwritable settings folder stops plainly and the defaults still load');
{
  const settingsRoot = join(root, 'unwritable-settings');
  await mkdir(settingsRoot, { mode: 0o500 });
  const printed = [];
  try {
    await assert.rejects(loadSettings(join(settingsRoot, 'forge/config.json'), value => printed.push(value)),
      error => error instanceof ReportedSetupError && error.message === 'settings');
  } finally {
    await chmod(settingsRoot, 0o700);
  }
  assertPlainStop(printed, [
    'Setup stopped because it could not save its settings on this server. Let setup write to the folder where the Forge keeps its settings before trying setup again.'
  ], root);
  assert.deepEqual((await loadSettings(join(settingsRoot, 'forge/config.json'), () => {})).commands, defaults().commands);
}

async function stopThenRetry(name, { prepare, run: failingRun = () => null, onPrompt = async () => {}, afterMission, answers = ['Purpose.', 'Users.'], undo = async () => {}, reason, before = [], message }) {
  testCase(`stop and retry: ${name}`);
  const repository = `owner/${name}`;
  const stopRoot = join(root, 'stops', name);
  const options = { projectsRoot: join(stopRoot, 'projects'), state: join(stopRoot, 'state') };
  await mkdir(options.state, { recursive: true });
  await prepare?.(options);
  let begins = 0;
  let failing = true;
  const setup = printed => {
    let answer = 0;
    return setupRepository(repository, {
      config: { ...defaults(stopRoot), projectsRoot: options.projectsRoot }, paths: { state: options.state },
      commands: {
        run: async (command, args, runOptions = {}) => {
          const failure = failing && await failingRun(command, args, runOptions);
          if (failure instanceof Error) throw failure;
          if (failure) return failure;
          if (command === 'claude') return { stdout: 'signed in' };
          if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
          if (command === 'git' && args[0] === 'remote') return { stdout: `git@github.com:${repository}.git\n` };
          if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
          if (command === 'python3' && args[1] === 'init') await writeFile(join(runOptions.cwd, 'MISSION.md'), '# Mission\n');
          return { stdout: '' };
        }
      },
      github: {
        exists: async path => { try { await stat(path); return true; } catch { return false; } },
        appExists: async () => false,
        begin: async manifest => { begins += 1; return { url: `https://example.test/${manifest.name}` }; },
        callback: async () => 'code',
        exchange: async () => credentials,
        install: async () => true,
        appStatus: async () => 'installed'
      },
      factorySetup: async () => { if (failing) await afterMission?.(); },
      prompt: async () => {
        if (!failing) return ['Purpose.', 'Users.'][answer++];
        if (answer === 0) await onPrompt(options);
        return answers[answer++];
      },
      output: value => printed.push(value)
    });
  };
  const stopped = [];
  try {
    await assert.rejects(setup(stopped), error => error instanceof ReportedSetupError && error.message === reason);
  } finally {
    await undo(options);
  }
  assert.deepEqual(stopped.slice(0, -1), ['Using Claude Code to set up the Forge.', ...before]);
  assertPlainStop(stopped.slice(-1), [message], stopRoot);
  failing = false;
  const retried = [];
  assert.equal((await setup(retried)).completed, true);
  assert.match(retried.at(-1), new RegExp(`^Setup is complete for ${repository}\\.`));
  assert.equal(begins, 2);
}

// A state folder setup cannot write before it makes anything (#87): it says nothing was created.
const PROGRESS_NOTHING_MADE = 'Setup stopped because it could not save its progress on this server, so nothing was created. Let setup write to the folder where the Forge keeps its settings before trying setup again.';
const PROGRESS_APPS_KEPT = 'Setup stopped because it could not save its progress on this server. Let setup write to the folder where the Forge keeps its settings before trying setup again.';
await stopThenRetry('unwritable-state', {
  prepare: async ({ state }) => chmod(state, 0o500),
  undo: async ({ state }) => chmod(state, 0o700),
  reason: 'progress',
  message: PROGRESS_NOTHING_MADE
});

// The same through the command (#87), with every GitHub call counted: exit code 1, the exact lines, nothing asked
// of GitHub and no App made. With an App kept from an earlier run, the kept-Apps line comes first and the stop
// does not say nothing was created.
async function readOnlyStateSetup(name, { firstAnswers, lock }) {
  const repository = `owner/${name}`;
  const stopRoot = join(root, 'read-only-state', name);
  const paths = { state: join(stopRoot, 'state') };
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const standIn = standInGithub();
  const githubCalls = [];
  const github = Object.fromEntries(Object.entries(standIn.github)
    .map(([method, call]) => [method, (...args) => { githubCalls.push(method); return call(...args); }]));
  const options = (answers, printed, prompts) => ({
    config: { ...defaults(stopRoot), projectsRoot: join(stopRoot, 'projects') }, paths,
    commands: {
      run: async (command, args, runOptions) => command === 'git' && args[0] === 'remote'
        ? { stdout: `https://github.com/${repository}.git\n` } : run(command, args, runOptions)
    },
    github,
    prompt: async question => answers[prompts.push(question) - 1],
    output: value => printed.push(value)
  });
  if (firstAnswers) assert.equal(await setupCommand(repository, options(firstAnswers, [], [])), 1);
  const locked = lock(paths.state, repository);
  const printed = [];
  const prompts = [];
  githubCalls.length = 0;
  let code;
  await chmod(locked, 0o500);
  try {
    code = await setupCommand(repository, options(['Purpose.', 'Users.'], printed, prompts));
  } finally {
    await chmod(locked, 0o700);
  }
  return { code, printed, prompts, githubCalls, standIn, stopRoot };
}

testCase('a read-only state folder before setup: one stop, nothing created, exit code 1, GitHub not asked');
{
  const result = await readOnlyStateSetup('read-only-state', { lock: state => state });
  assert.equal(result.code, 1);
  assertPlainStop(result.printed, ['Using Claude Code to set up the Forge.', PROGRESS_NOTHING_MADE], result.stopRoot);
  assert(!/EROFS|EACCES/.test(PROGRESS_NOTHING_MADE));
  assert.deepEqual(result.prompts, []);
  assert.deepEqual(result.githubCalls, []);
  assert.deepEqual(result.standIn.counts, { builder: 0, release: 0 });
}

testCase('a read-only state folder after an earlier run kept the Apps: the kept-Apps line, then the stop');
{
  const result = await readOnlyStateSetup('read-only-state-apps', {
    firstAnswers: ['', 'Users.'],
    lock: (state, repository) => projectStatePath(state, repository)
  });
  assert.equal(result.code, 1);
  assertPlainStop(result.printed, ['Using Claude Code to set up the Forge.', FORGE_APPS_KEPT, PROGRESS_APPS_KEPT], result.stopRoot);
  assert.deepEqual(result.prompts, []);
  assert.deepEqual(result.githubCalls, []);
  assert.deepEqual(result.standIn.counts, { builder: 1, release: 1 });
}

// mission.json lives in the project state folder. One setup cannot read (#96) is never written over: setup asks
// what the project's mission does not already hold, keeps the answers there, and the next run finds them there.
const missionPath = (state, name) => join(state, 'projects', 'owner', name, 'mission.json');
const appPages = [
  'Create the builder App in your browser: https://example.test/Forge builder',
  'Create the release App in your browser: https://example.test/Forge release'
];
for (const [name, prepare, undo] of [
  ['mission-directory', path => mkdir(path, { recursive: true }), () => {}]
]) {
  testCase(`mission answers setup cannot read (${name}) are asked once and never written over`);
  const repository = `owner/${name}`;
  const stateRoot = join(root, 'stops', name);
  const path = missionPath(stateRoot, name);
  await prepare(path);
  const fingerprint = async () => { const entry = await lstat(path); return [entry.mode, entry.isDirectory(), entry.size]; };
  const before = await fingerprint();
  try {
    // Setup stops once, before any page or question, naming the file and leaving it as it is.
    const first = await setupAttempt(repository, stateRoot, standInGithub().github);
    assert.equal(first.error?.message, 'unreadable-saved-file');
    assert.deepEqual(first.prompts, []);
    assert(first.messages.at(-1).includes('start the answers setup saved on this server afresh'));
    assert.deepEqual(await fingerprint(), before);
    // Started afresh, setup asks the questions and finishes.
    const second = await setupAttempt(repository, stateRoot, standInGithub().github, { startAfresh: 'answers' });
    assert.equal(second.error, undefined);
    assert.deepEqual(second.prompts, ['What is this software for?', 'Who uses it?']);
    assert(completedFor(repository)(second.messages.at(-1)));
  } finally {
    await undo(path);
  }
}

// A saved file the file system will not let setup read may hold what setup needs, so setup is never taken on
// without it: one stop before any page or question, the file left as it was, and once the owner lets setup read
// it the next run finishes.
testCase('mission answers the file system will not let setup read stop setup before any page, and are read once allowed');
{
  const name = 'denied-mission';
  const repository = `owner/${name}`;
  const stateRoot = join(root, 'stops', name);
  const path = missionPath(stateRoot, name);
  await writePrivateJson(path, { purpose: 'Purpose.', users: 'Users.' });
  await chmod(path, 0o000);
  try {
    const first = await setupAttempt(repository, stateRoot, standInGithub().github);
    assertStopped(first, [`Setup stopped because this server would not let setup read one of the files it keeps for ${repository}. Let setup read the files in the folder where the Forge keeps its settings and in the project folder for ${repository}, then try setup again.`, 'unreadable-denied'], stateRoot);
    assert.deepEqual(first.prompts, []);
    assert.equal((await lstat(path)).mode & 0o777, 0o000);
  } finally {
    await chmod(path, 0o600);
  }
  const second = await setupAttempt(repository, stateRoot, standInGithub().github);
  assert.equal(second.error, undefined);
  assert.deepEqual(second.prompts, []);
  assert(completedFor(repository)(second.messages.at(-1)));
}

// Answers that cannot be saved are lost: the stop says so and that setup asks them again.
const MISSION_NOT_SAVED = 'Setup stopped because it could not save your answers to the mission questions on this server, so they were not kept. Let setup write to the folder where the Forge keeps its settings, then try setup again; it asks those questions again.';
await stopThenRetry('unwritable-mission', {
  onPrompt: async ({ state }) => chmod(join(state, 'projects', 'owner', 'unwritable-mission'), 0o500),
  undo: async ({ state }) => chmod(join(state, 'projects', 'owner', 'unwritable-mission'), 0o700),
  reason: 'settings',
  before: [BROWSER_PASSED, ...appPages, FORGE_APPS_KEPT],
  message: MISSION_NOT_SAVED
});

// The run after that asks the mission questions once and saves the answers; the run after it asks nothing.
testCase('after mission answers were not saved, the next run asks once and saves them');
{
  const repository = 'owner/mission-not-saved';
  const project = await retryProject(repository);
  const stateDirectory = join(root, 'retry-state/projects/owner/mission-not-saved');
  const options = project.options();
  const ask = options.prompt;
  let locked = false;
  try {
    await assert.rejects(setupRepository(repository, {
      ...options,
      prompt: async question => {
        if (!locked) { locked = true; await chmod(stateDirectory, 0o500); }
        return ask(question);
      }
    }), error => error instanceof ReportedSetupError && error.message === 'settings');
  } finally {
    await chmod(stateDirectory, 0o700);
  }
  assert.deepEqual(project.record.messages.slice(-2), [FORGE_APPS_KEPT, MISSION_NOT_SAVED]);
  assert(!(await isPresent(join(stateDirectory, 'mission.json'))));
  project.reset();
  await assert.rejects(setupRepository(repository, project.options({ failAt: 'after-mission' })),
    error => error instanceof ReportedSetupError && error.message === 'after-mission');
  assert.deepEqual(project.record.prompts, ['What is this software for?', 'Who uses it?']);
  assert(await isPresent(join(stateDirectory, 'mission.json')));
  assert.equal(project.record.begins, 0);
  project.reset();
  assert.equal((await setupRepository(repository, project.options())).completed, true);
  assert.deepEqual(project.record.prompts, []);
  assert.equal(await project.missionSections(), 1);
}

// The first mission answer is saved, then the second cannot be (#84): the stop says only that answer was not kept
// and that the next try asks that question again, which is all the next run asks. When the first save fails, the
// stop is the one above and the next run asks both questions.
const USERS_NOT_SAVED = 'Setup stopped because it could not save your answer to \'Who uses it?\' on this server, so only that answer was not kept. Let setup write to the folder where the Forge keeps its settings, then try setup again; it asks that question again.';
const PURPOSE_NOT_SAVED = 'Setup stopped because it could not save your answer to \'What is this software for?\' on this server, so only that answer was not kept. Let setup write to the folder where the Forge keeps its settings, then try setup again; it asks that question again.';
for (const { name, lockAt, saved, message, kept, prompts } of [
  { name: 'second-answer-not-saved', lockAt: 'Who uses it?', message: USERS_NOT_SAVED,
    kept: { purpose: 'First purpose.' }, prompts: ['Who uses it?'] },
  { name: 'first-answer-not-saved', lockAt: 'What is this software for?', message: MISSION_NOT_SAVED,
    kept: null, prompts: ['What is this software for?', 'Who uses it?'] },
  { name: 'purpose-not-saved-after-users', lockAt: 'What is this software for?', saved: { users: 'Saved users.' },
    message: PURPOSE_NOT_SAVED, kept: { users: 'Saved users.' }, prompts: ['What is this software for?'] }
]) {
  testCase(`mission answer not saved: ${name} stops with exit code 1 and the retry asks only what was not kept`);
  const repository = `owner/${name}`;
  const project = await retryProject(repository);
  const stateDirectory = join(root, 'retry-state/projects/owner', name);
  const missionAnswersPath = join(stateDirectory, 'mission.json');
  if (saved) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(missionAnswersPath, `${JSON.stringify(saved)}\n`);
  }
  const options = project.options();
  const ask = options.prompt;
  let code;
  try {
    code = await setupCommand(repository, {
      ...options,
      prompt: async question => {
        if (question === lockAt) await chmod(stateDirectory, 0o500);
        return ask(question);
      }
    });
  } finally {
    await chmod(stateDirectory, 0o700);
  }
  assert.equal(code, 1);
  assert.deepEqual(project.record.messages.slice(-2), [FORGE_APPS_KEPT, message]);
  assert.equal(project.record.messages.filter(text => text.startsWith('Setup stopped because')).length, 1);
  if (kept) assert.deepEqual(JSON.parse(await readFile(missionAnswersPath, 'utf8')), kept);
  else assert(!(await isPresent(missionAnswersPath)));
  project.reset();
  assert.equal(await setupCommand(repository, project.options({ answers: ['Second answer.', 'Third answer.'] })), 0);
  assert.deepEqual(project.record.prompts, prompts);
  const final = JSON.parse(await readFile(missionAnswersPath, 'utf8'));
  for (const [key, value] of Object.entries(kept ?? {})) assert.equal(final[key], value);
}

// A mission question left empty, after the Apps exist: a plain stop that says the Apps are kept.
for (const [name, answers] of [['empty-purpose', ['', 'Users.']], ['empty-users', ['Purpose.', '  ']]]) {
  await stopThenRetry(name, {
    answers,
    reason: 'mission',
    before: [BROWSER_PASSED, ...appPages, FORGE_APPS_KEPT],
    message: 'Setup stopped because both mission questions need an answer: what the software is for and who uses it. Try setup again and answer both.'
  });
}

// MISSION.md in the project folder cannot be written, or cannot be read, after the Apps exist: each stop says in
// plain words what setup could not do there, with no file name, path or raw error text.
const missionFile = (projectsRoot, name) => join(projectsRoot, 'owner', name, 'MISSION.md');
for (const [name, mode, reason, message] of [
  ['unwritable-mission-file', 0o444, 'mission-file', 'Setup stopped because it could not save your answers to the mission questions in the project folder for owner/unwritable-mission-file on this server. Let setup read and write the files in that project folder, then try setup again.'],
  ['unreadable-mission-file', 0o000, 'unreadable-mission-file', 'Setup stopped because the project\'s mission file in the project folder for owner/unreadable-mission-file on this server cannot be read. Ask me to start the project\'s mission file afresh, and setup replaces only that file with a new one holding your answers to the mission questions.']
]) {
  assert(!/MISSION\.md|\.md\b|EACCES|permission denied/.test(message), message);
  await stopThenRetry(name, {
    onPrompt: async ({ projectsRoot }) => chmod(missionFile(projectsRoot, name), mode),
    undo: async ({ projectsRoot }) => chmod(missionFile(projectsRoot, name), 0o644),
    reason,
    before: [BROWSER_PASSED, ...appPages, FORGE_APPS_KEPT],
    message
  });
}

// A saved mission.json or registration.json that is there but cannot be read (damaged, or empty) is never
// written over (#96). Setup recovers what it held: the answers from the mission section it generated in the
// project, and whether setup finished by running the whole setup again. It opens no GitHub page, asks nothing,
// never says the project is already set up, and leaves the file exactly as it was, on every later run too.
for (const [file, stopAt, text] of [
  ['mission.json', 'after-mission', '{ damaged'],
  ['registration.json', undefined, '{ damaged'],
  ['mission.json', 'after-mission', ''],
  ['registration.json', undefined, '']
]) {
  testCase(`a${text ? ' damaged' : 'n empty'} ${file} stops setup once, naming it, and started afresh setup finishes`);
  const repository = `owner/${text ? 'damaged' : 'empty'}-${file.replace('.json', '')}`;
  const project = await retryProject(repository);
  const retryState = join(root, 'retry-state');
  // An earlier run records both Apps and the saved file: it stops at the final check, or completes.
  if (stopAt) {
    await assert.rejects(setupRepository(repository, project.options({ failAt: stopAt })),
      error => error instanceof ReportedSetupError && error.message === stopAt);
  } else {
    assert.equal((await setupRepository(repository, project.options())).completed, true);
  }
  assert.equal(project.record.begins, 2);
  const path = join(retryState, 'projects', repository, file);
  await writeFile(path, text);
  const part = file === 'mission.json' ? 'answers' : 'progress';
  project.reset();
  await assert.rejects(setupRepository(repository, project.options()),
    error => error instanceof ReportedSetupError && error.message === 'unreadable-saved-file');
  assert(project.record.messages.at(-1).startsWith('Setup stopped because'));
  assert(project.record.messages.at(-1).includes(`${AFRESH_PARTS[part].words} afresh`));
  assert(!project.record.messages.some(message => message.includes('already set up')));
  for (const message of project.record.messages) assertNoInternalText(message, root);
  assert.equal(project.record.begins, 0);
  assert.equal(await readFile(path, 'utf8'), text);
  project.reset();
  assert.equal((await setupRepository(repository, project.options({ startAfresh: part }))).completed, true);
  assert.match(project.record.messages.at(-1), new RegExp(`^Setup is complete for ${repository}\\.`));
  assert.equal(project.record.begins, 0);
  assert.equal(await project.missionSections(), 1);
}

// An empty saved mission answers file (#80, #91) cannot be read. Setup never writes over it: it takes the answers
// it finds in the mission section it generated in the project, asks only what it could not find there, and keeps
// the answers in the project's mission, where the next run finds them again without asking, with the same two
// Apps.
// An App details file emptied after setup stopped at the final check, with both Apps installed: setup stops on
// it and leaves it as it is, and once the owner has setup start it afresh the run does what it does when that
// file is deleted. It stops with the missing-details sentence instead of ending in "Setup is complete", and after
// the owner deletes that App on GitHub the next run creates it again.
for (const kind of ['builder', 'release']) {
  testCase(`a ${kind} App details file emptied after the final-check stop stops, and started afresh reads as missing`);
  const runs = [];
  for (const empty of [true, false]) {
    const repository = `owner/final-check-${empty ? 'empty' : 'deleted'}-${kind}-app`;
    const project = await retryProject(repository);
    await assert.rejects(setupRepository(repository, project.options({ failAt: 'after-mission' })),
      error => error instanceof ReportedSetupError && error.message === 'after-mission');
    const path = join(credentialPath(join(root, 'retry-state'), repository), `${kind}-app.json`);
    if (empty) await writeFile(path, ''); else await rm(path);
    if (empty) {
      project.reset();
      await assert.rejects(setupRepository(repository, project.options()),
        error => error instanceof ReportedSetupError && error.message === 'unreadable-app-details');
      assert.equal(project.record.messages.at(-1), DETAILS_UNREADABLE(kind, repository));
      assert.equal(await readFile(path, 'utf8'), '');
    }
    project.reset();
    const rerun = await setupRepository(repository, project.options({ startAfresh: empty ? `${kind}-app` : undefined }))
      .then(() => undefined, error => error);
    const [message, reason] = appGoneStops.missing(kind, repository);
    assert(rerun instanceof ReportedSetupError && rerun.message === reason, `${kind} ${empty}: ${rerun?.message}`);
    assert.equal(project.record.messages.at(-1), message);
    assert(!project.record.messages.some(line => line.startsWith('Setup is complete')), JSON.stringify(project.record.messages));
    assertNoInternalText(project.record.messages.at(-1), join(root, 'retry-state'));
    runs.push(project.record.messages.map(line => line.replaceAll(repository, 'REPOSITORY')));
    project.reset();
    project.record.deleted = true;
    assert.equal((await setupRepository(repository, project.options())).completed, true);
    assert.equal(project.record.begins, 1);
    assert.match(project.record.messages.at(-1), new RegExp(`^Setup is complete for ${repository}\\.`));
  }
  assert.deepEqual(runs[0], runs[1]);
}

await stopThenRetry('missing-repository', {
  run: (command, args) => command === 'gh' && args[1] === 'clone'
    && Object.assign(new Error('gh failed.'), { stderr: 'GraphQL: Could not resolve to a Repository with the name \'owner/missing-repository\'. (repository)\n' }),
  reason: 'checkout',
  message: 'Setup stopped because GitHub did not let this server download owner/missing-repository: either it does not exist or this server\'s GitHub sign-in cannot reach it. Check the repository name, or give this server\'s GitHub sign-in access to owner/missing-repository, before trying setup again.'
});

for (const [name, stderr] of [
  ['forbidden-repository', 'HTTP 403: Resource not accessible by integration (https://api.github.com/graphql)\n'],
  ['signed-out-repository', 'To get started with GitHub CLI, please run:  gh auth login\n']
]) {
  await stopThenRetry(name, {
    run: (command, args) => command === 'gh' && args[1] === 'clone' && Object.assign(new Error('gh failed.'), { stderr }),
    reason: 'checkout',
    message: `Setup stopped because GitHub did not let this server download owner/${name}: either it does not exist or this server's GitHub sign-in cannot reach it. Check the repository name, or give this server's GitHub sign-in access to owner/${name}, before trying setup again.`
  });
}

await stopThenRetry('unreachable-github', {
  run: (command, args) => command === 'gh' && args[1] === 'clone'
    && Object.assign(new Error('gh failed.'), { stderr: 'error connecting to api.github.com\n' }),
  reason: 'checkout',
  message: 'Setup stopped because owner/unreachable-github could not be downloaded from GitHub. Restore this server\'s access to GitHub before trying setup again.'
});

const realGit = (command, args, runOptions) => command === 'git' && args[0] === 'remote'
  && runProcess('git', args, { ...runOptions, env: { ...process.env, GIT_CEILING_DIRECTORIES: root } }).catch(error => error);
const gitInit = async (folder, ...remote) => {
  await runProcess('git', ['init', '-q', folder]);
  if (remote.length) await runProcess('git', ['-C', folder, 'remote', 'add', 'origin', ...remote]);
};
for (const [name, prepareFolder, message] of [
  ['plain-folder', async folder => writeFile(join(folder, 'notes.txt'), 'not a repository\n'),
    'Setup stopped because the project folder for owner/plain-folder on this server already exists but does not hold a copy of a repository. Move that folder elsewhere before trying setup again.'],
  ['other-repository', async folder => gitInit(folder, 'git@github.com:someone/else.git'),
    'Setup stopped because the project folder for owner/other-repository on this server holds a copy of a different repository. Move that folder elsewhere before trying setup again.'],
  ['no-origin', async folder => gitInit(folder),
    'Setup stopped because the project folder for owner/no-origin on this server holds a copy that setup cannot match to owner/no-origin on GitHub. Move that folder elsewhere before trying setup again.'],
  ['damaged-copy', async folder => mkdir(join(folder, '.git')),
    'Setup stopped because the project folder for owner/damaged-copy on this server holds a copy that setup cannot match to owner/damaged-copy on GitHub. Move that folder elsewhere before trying setup again.'],
  ['unreadable-origin', async folder => gitInit(folder, 'https://example.test/owner/unreadable-origin.git'),
    'Setup stopped because the project folder for owner/unreadable-origin on this server holds a copy that setup cannot match to owner/unreadable-origin on GitHub. Move that folder elsewhere before trying setup again.']
]) {
  await stopThenRetry(name, {
    prepare: async ({ projectsRoot }) => {
      const folder = join(projectsRoot, 'owner', name);
      await mkdir(folder, { recursive: true });
      await prepareFolder(folder);
    },
    run: realGit,
    undo: async ({ projectsRoot }) => rm(join(projectsRoot, 'owner', name), { recursive: true }),
    reason: 'checkout',
    message
  });
}

testCase('a git that cannot start is an error, not a stop');
await gitInit(join(root, 'git-missing', 'owner', 'existing'));
await assert.rejects(
  prepareCheckout('owner/existing', join(root, 'git-missing'), { names: { git: join(root, 'no-such-git') }, run: runProcess },
    message => assert.fail(`a git that cannot start was reported as: ${message}`)),
  /^Error: Could not run /
);

await stopThenRetry('failing-preparation', {
  run: (command, args) => command === 'python3' && args[1] === 'init'
    && Object.assign(new Error('python3 failed.'), { stderr: `Traceback (most recent call last):\nPermissionError: [Errno 13] Permission denied: '${root}/x'\n` }),
  reason: 'initialization',
  before: [BROWSER_PASSED],
  message: 'Setup stopped because the build tools it downloaded could not prepare the project on this server. Install the latest version of the Forge on this server before trying setup again.'
});

// The build tools download runs real git against a stand-in for GitHub: a missing folder (GitHub cannot be
// reached) or a repository without the pinned revision (GitHub no longer has it).
const buildToolsRemote = join(root, 'build-tools-remote.git');
await runProcess('git', ['init', '-q', '--bare', buildToolsRemote]);
const buildToolsWork = join(root, 'build-tools-work');
await runProcess('git', ['clone', '-q', buildToolsRemote, buildToolsWork]);
await runProcess('git', ['-C', buildToolsWork, '-c', 'user.name=Forge test', '-c', 'user.email=forge@example.test',
  'commit', '-q', '--allow-empty', '-m', 'Not the pinned revision']);
await runProcess('git', ['-C', buildToolsWork, 'push', '-q', 'origin', 'HEAD:main']);
const downloadFrom = remote => (command, args, runOptions = {}) => command === 'git' && args[0] !== 'remote'
  && runProcess('git', args, { ...runOptions, env: {
    ...process.env, GIT_CEILING_DIRECTORIES: root, GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_0: FACTORY_REPOSITORY
  } }).catch(error => error);
const DOWNLOAD_STOPS = {
  unreachable: 'Setup stopped because it could not download the build tools from GitHub. Restore this server\'s access to GitHub before trying setup again.',
  revision: 'Setup stopped because it could not download the build tools: GitHub no longer has the version of them that this Forge needs. Install the latest version of the Forge on this server before trying setup again.'
};

await stopThenRetry('unreachable-build-tools', {
  run: downloadFrom(join(root, 'no-such-remote.git')), reason: 'preparation', message: DOWNLOAD_STOPS.unreachable
});
await stopThenRetry('missing-build-tools-revision', {
  run: downloadFrom(buildToolsRemote), reason: 'preparation', message: DOWNLOAD_STOPS.revision
});

// A copy an interrupted download left behind is replaced by a fresh download instead of failing every retry.
await stopThenRetry('damaged-build-tools', {
  prepare: async ({ state }) => mkdir(join(state, 'factory', '.git'), { recursive: true }),
  run: downloadFrom(buildToolsRemote),
  undo: async ({ state }) => {
    assert.equal((await runProcess('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: join(state, 'factory'), env: { ...process.env, GIT_CEILING_DIRECTORIES: root }
    })).stdout.trim(), 'true');
  },
  reason: 'preparation', message: DOWNLOAD_STOPS.revision
});
testCase('a damaged build tools folder is replaced and setup finishes');
{
  const healRoot = join(root, 'stops', 'heal');
  const healState = join(healRoot, 'state');
  await mkdir(join(healState, 'factory', '.git', 'damaged'), { recursive: true });
  const healCalls = [];
  const healed = [];
  let healAnswer = 0;
  const result = await setupRepository('owner/healed-build-tools', {
    config: { ...defaults(healRoot), projectsRoot: join(healRoot, 'projects') }, paths: { state: healState },
    commands: {
      run: async (command, args, runOptions = {}) => {
        healCalls.push([command, args[0]]);
        if (command === 'git' && args[0] === 'fetch' && await stat(join(runOptions.cwd, '.git', 'damaged')).then(() => true, () => false)) {
          throw Object.assign(new Error('git failed.'), { stderr: 'fatal: bad object HEAD\n' });
        }
        return run(command, args, runOptions);
      }
    },
    github: { appExists: async () => false, begin: async manifest => ({ url: `https://example.test/${manifest.name}` }), callback: async () => 'code', exchange: async () => credentials, install: async () => true, appStatus: async () => 'installed' },
    prompt: async () => ['Purpose.', 'Users.'][healAnswer++],
    output: value => healed.push(value)
  });
  assert.equal(result.completed, true);
  assert.match(healed.at(-1), /^Setup is complete for owner\/healed-build-tools\./);
  assert(!healed.some(message => message.startsWith('Setup stopped')));
  assert.deepEqual(healCalls.filter(([command]) => command === 'git').map(([, step]) => step),
    ['fetch', 'clone', 'fetch', 'checkout', 'rev-parse']);
}

// The final record that setup finished cannot be written: the Apps exist, so the stop says they are kept.
{
  const projectState = join(root, 'stops', 'unrecordable-registration', 'state', 'projects', 'owner', 'unrecordable-registration');
  await stopThenRetry('unrecordable-registration', {
    afterMission: async () => chmod(projectState, 0o500),
    undo: async () => chmod(projectState, 0o700),
    reason: 'registration',
    before: [BROWSER_PASSED, ...appPages, FORGE_APPS_KEPT],
    message: 'Setup stopped because it could not record on this server that setup finished. Let setup write to the folder where the Forge keeps its settings before trying setup again.'
  });
}

// Saved App details setup may not read: the stop says they cannot be read, not the GitHub page, and once they can
// be read again setup uses that App instead of creating another.
{
  const repository = 'owner/unreadable-app';
  const project = await retryProject(repository);
  await assert.rejects(setupRepository(repository, project.options({ failAt: 'after-mission' })),
    error => error instanceof ReportedSetupError && error.message === 'after-mission');
  const builderPath = join(credentialPath(join(root, 'retry-state'), repository), 'builder-app.json');
  await chmod(builderPath, 0o000);
  project.reset();
  try {
    await assert.rejects(setupRepository(repository, project.options()),
      error => error instanceof ReportedSetupError && error.message === 'unreadable-denied');
  } finally {
    await chmod(builderPath, 0o600);
  }
  assert.equal(project.record.messages.at(-1), `Setup stopped because this server would not let setup read one of the files it keeps for ${repository}. Let setup read the files in the folder where the Forge keeps its settings and in the project folder for ${repository}, then try setup again.`);
  assert(!project.record.messages.some(message => message.includes('Complete the GitHub page')));
  project.reset();
  assert.equal((await setupRepository(repository, project.options())).completed, true);
  assert.equal(project.record.begins, 0);
}

// The place answers come from closes while setup waits for the address from the browser.
const INPUT_CLOSED = 'Setup stopped because the place it was reading your answers from closed before you answered. Try setup again and answer each question it asks.';
async function closedInputSetup(name, start) {
  const closedRoot = join(root, 'closed-input', name);
  const stream = new PassThrough();
  const input = answersFrom(createInterface({ input: stream }));
  const adapter = createGithubAdapter({ input });
  const printed = [];
  const options = {
    paths: { state: join(closedRoot, 'state'), config: join(closedRoot, 'config.json') },
    commands: { run },
    github: {
      ...adapter,
      appExists: async () => false,
      begin: async manifest => {
        const answered = adapter.begin(manifest);
        stream.write('no\n');
        await answered;
        stream.end();
        return { url: 'https://example.test/create' };
      }
    },
    prompt: question => input.question(question),
    output: value => printed.push(value)
  };
  await writePrivateJson(options.paths.config, { ...defaults(closedRoot), projectsRoot: join(closedRoot, 'projects') });
  return { printed, result: start(options, { ...defaults(closedRoot), projectsRoot: join(closedRoot, 'projects') }) };
}
{
  const closed = await closedInputSetup('repository', (options, config) => setupRepository('owner/closed-input', { ...options, config }));
  await assert.rejects(closed.result, error => error instanceof ReportedSetupError && error.message === 'input-closed');
  assert.deepEqual(closed.printed, [
    'Using Claude Code to set up the Forge.', BROWSER_PASSED, 'Create the builder App in your browser: https://example.test/create', INPUT_CLOSED
  ]);
  const command = await closedInputSetup('command', options => setupCommand('owner/closed-input', options));
  assert.equal(await command.result, 1);
  assert.equal(command.printed.at(-1), INPUT_CLOSED);
  const readline = createInterface({ input: new PassThrough() });
  const answers = answersFrom(readline);
  readline.close();
  await assert.rejects(answers.question('Anything? '), error => error instanceof InputClosed);
}

// A finished setup whose release App details are damaged: setup stops and removes nothing. Once the owner has
// setup start those details afresh, where the record that setup finished cannot be removed, nothing else is
// removed either, so the next run does not wrongly say the Forge is already set up.
{
  const repository = 'owner/damaged-unrecorded';
  const retryState = join(root, 'retry-damaged-unrecorded');
  const credentialDirectory = credentialPath(retryState, repository);
  const standIn = standInGithub();
  assert.equal((await setupAttempt(repository, retryState, standIn.github)).error, undefined);
  const damagedPath = join(credentialDirectory, 'release-app.json');
  await writeFile(damagedPath, '{"id": 12345, "pem": "PRIV');
  const stopped = await setupAttempt(repository, retryState, standIn.github);
  assert(stopped.error instanceof ReportedSetupError && stopped.error.message === 'unreadable-app-details');
  assert.equal(await readFile(damagedPath, 'utf8'), '{"id": 12345, "pem": "PRIV');
  const realRm = files.rm;
  files.rm = async (path, options) => {
    if (path.endsWith('registration.json')) {
      throw Object.assign(new Error(`EACCES: permission denied, unlink '${path}'`), { code: 'EACCES', syscall: 'unlink' });
    }
    return realRm(path, options);
  };
  let first;
  try {
    first = await setupAttempt(repository, retryState, standIn.github, { startAfresh: 'release-app' });
  } finally {
    files.rm = realRm;
  }
  assert(first.error instanceof ReportedSetupError && first.error.message === 'settings');
  assert.equal(first.messages.at(-1), 'Setup stopped because it could not save its settings on this server. Let setup write to the folder where the Forge keeps its settings before trying setup again.');
  assert(await isPresent(join(projectStatePath(retryState, repository), 'release-installation.json')));
  const second = await setupAttempt(repository, retryState, standIn.github);
  assert(second.error instanceof ReportedSetupError && second.error.message === 'missing-app-details');
  assert(!second.messages.some(message => message.includes('already set up')));
  standIn.live.release -= 1;
  const third = await setupAttempt(repository, retryState, standIn.github);
  assert(completedFor(repository)(third.messages.at(-1)));
  assert.deepEqual(standIn.counts, { builder: 1, release: 2 });
}

// A failure no step names stops with the general sentence and never the failure's own text.
{
  const commandRoot = join(root, 'unexpected');
  const paths = { state: join(commandRoot, 'state'), config: join(commandRoot, 'config.json') };
  const commandProjects = join(commandRoot, 'projects');
  await writePrivateJson(paths.config, { ...defaults(commandRoot), projectsRoot: commandProjects });
  const printed = [];
  const realMkdir = files.mkdir;
  files.mkdir = async (path, options) => {
    if (path === join(commandProjects, 'owner')) throw new Error(`boom ${commandRoot}`);
    return realMkdir(path, options);
  };
  try {
    assert.equal(await setupCommand('owner/unexpected', {
      paths, commands: { run }, github: standInGithub().github, prompt: async () => 'Answer.', output: value => printed.push(value)
    }), 1);
  } finally {
    files.mkdir = realMkdir;
  }
  assert.deepEqual(printed, ['Using Claude Code to set up the Forge.', UNEXPECTED_MESSAGE]);
  assert.equal(UNEXPECTED_MESSAGE, 'Setup stopped because of a problem on this server that setup could not identify. Try setup again.');
}

// A repository name setup cannot use, a settings file that cannot be read (damaged, empty, or valid JSON that is
// not an object) and is left as it is, and one that holds a secret. Asked to start the settings afresh, setup
// replaces only that file with the default settings.
{
  const commandRoot = join(root, 'settings-stops');
  const config = join(commandRoot, 'config.json');
  const command = async repository => {
    const printed = [];
    const code = await setupCommand(repository, {
      paths: { state: join(commandRoot, 'state'), config }, commands: { run }, github: standInGithub().github,
      prompt: async () => 'Answer.', output: value => printed.push(value)
    });
    return { code, printed };
  };
  await writePrivateJson(config, { ...defaults(commandRoot), projectsRoot: join(commandRoot, 'projects') });
  assert.deepEqual(await command('owner/bad/name'), { code: 1, printed: [
    'Setup stopped because the repository name is not in the form owner/repository. Try setup again with a name in that form.'
  ] });
  for (const damaged of ['{ damaged', '', '\n', '[]', 'null']) {
    await writeFile(config, damaged);
    assert.deepEqual(await command('owner/repo'), { code: 1, printed: [SETTINGS_UNREADABLE] });
    assert.equal(await readFile(config, 'utf8'), damaged);
  }
  assert.deepEqual(await loadSettings(config, () => {}, undefined, 'settings'), defaults());
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), defaults());
  await writeFile(config, JSON.stringify({ commands: { github_token: 'ghs_secret' } }));
  assert.deepEqual(await command('owner/repo'), { code: 1, printed: [
    'Setup stopped because the Forge\'s settings file on this server contains commands.github_token, which must never be kept there. Remove commands.github_token from config.json in the folder where the Forge keeps its settings before trying setup again.'
  ] });
}

// Saved App details in the old place in the project folder, or a half-finished App record, that setup may not
// read: the stop says which cannot be read, and once they can be read setup uses that App.
for (const [name, place] of [['unreadable-legacy-app', 'legacy'], ['unreadable-pending-app', 'pending']]) {
  const repository = `owner/${name}`;
  const retryState = join(root, 'retry-state');
  const project = await retryProject(repository);
  let lockedPath;
  if (place === 'legacy') {
    await assert.rejects(setupRepository(repository, project.options({ failAt: 'after-mission' })),
      error => error instanceof ReportedSetupError && error.message === 'after-mission');
    lockedPath = join(projectStatePath(retryState, repository), 'builder-app.json');
    await writeFile(lockedPath, await readFile(join(credentialPath(retryState, repository), 'builder-app.json')));
    await rm(join(credentialPath(retryState, repository), 'builder-app.json'));
  } else {
    lockedPath = join(credentialPath(retryState, repository), 'builder-app-pending.json');
    await writePrivateJson(lockedPath, { code: 'code' });
  }
  await chmod(lockedPath, 0o000);
  project.reset();
  try {
    await assert.rejects(setupRepository(repository, project.options()),
      error => error instanceof ReportedSetupError && error.message === 'unreadable-denied');
  } finally {
    await chmod(lockedPath, 0o600);
  }
  assert.equal(project.record.messages.at(-1), DENIED(repository));
  project.reset();
  assert.equal((await setupRepository(repository, project.options())).completed, true);
  assert.equal(project.record.begins, place === 'legacy' ? 0 : 1);
}

testCase('a pending record setup cannot read is not called a kept App');
// The builder App is made and the release App's page was shown but never finished, so its pending record
// holds no App code. When neither the builder details nor that record can be read, the stop says no App is
// kept: the next run cannot use either until it can read them, and setup cannot know that a release App
// exists to use again.
{
  const repository = 'owner/unreadable-pending-no-app';
  const retryState = join(root, 'retry-state');
  const project = await retryProject(repository);
  await assert.rejects(setupRepository(repository, project.options({ failAt: 'after-mission' })),
    error => error instanceof ReportedSetupError && error.message === 'after-mission');
  const credentialFolder = credentialPath(retryState, repository);
  await rm(join(credentialFolder, 'release-app.json'));
  await rm(join(projectStatePath(retryState, repository), 'release-installation.json'), { force: true });
  const builderPath = join(credentialFolder, 'builder-app.json');
  const pendingPath = join(credentialFolder, 'release-app-pending.json');
  await writePrivateJson(pendingPath, { code: null });
  // The release App the first run made is not on GitHub either, as if its page had never been finished.
  project.record.deleted = true;
  await chmod(builderPath, 0o000);
  await chmod(pendingPath, 0o000);
  project.reset();
  try {
    await assert.rejects(setupRepository(repository, project.options()),
      error => error instanceof ReportedSetupError && error.message === 'unreadable-denied');
  } finally {
    await chmod(builderPath, 0o600);
    await chmod(pendingPath, 0o600);
  }
  assert.deepEqual(project.record.messages, [builderKept('Forge builder'), DENIED(repository)]);
  assert(!project.record.messages.some(message => message.includes('"Forge release"')));
  project.reset();
  assert.equal((await setupRepository(repository, project.options())).completed, true);
  assert.equal(project.record.begins, 1);
}

// A release-cost setting setup cannot use stops setup before it records that setup finished, so the next
// run, with that setting mended, finishes instead of saying setup was already done.
{
  const repository = 'owner/bad-release-cost';
  const project = await retryProject(repository);
  const options = project.options();
  await assert.rejects(setupRepository(repository, { ...options, config: { ...options.config, releaseCost: null } }),
    error => error instanceof ReportedSetupError && error.message === 'unexpected');
  assert.equal(project.record.messages.at(-1), UNEXPECTED_MESSAGE);
  assert(!(await isPresent(join(projectStatePath(join(root, 'retry-state'), repository), 'registration.json'))));
  project.reset();
  await setupRepository(repository, project.options());
  assert.match(project.record.messages.at(-1), new RegExp(`^Setup is complete for ${repository}\\.`));
}

testCase('an App name GitHub sees stays within 34 characters and names the owner');
assert.equal(githubAppName('Forge builder', 'owner/repo'), 'Forge builder owner repo');
for (const repository of ['MichaelZelbel/forge-trial-recipes', 'a-very-long-organization-name/and-a-long-repository']) {
  for (const name of ['Forge builder', 'Forge release']) {
    const n = githubAppName(name, repository);
    assert(n.length <= 34, n);
    assert(n.startsWith(`${name} ${repository.split('/')[0].slice(0, 5)}`), n);
    assert.notEqual(n, githubAppName(name, `${repository}-two`));
  }
}

// The Archon source's dependencies are installed by a call of setup's own, before init, and only when it runs.
async function archonInstallRun(repository, { failInstall = false, folderExists = false, failBrowser = null } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'forge-archon-home-'));
  const destination = join(home, '.cache/factory/archon', ARCHON_REVISION);
  if (folderExists) await mkdir(destination, { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const project = await retryProject(repository);
  const options = project.options();
  const inner = options.commands.run;
  const calls = [];
  options.commands.run = async (command, args, runOptions = {}) => {
    calls.push({ command, args, cwd: runOptions.cwd });
    if (command === 'bun' && failInstall) {
      await mkdir(join(runOptions.cwd, 'node_modules'), { recursive: true });
      throw new Error('install failed');
    }
    if (command === 'bash' && failBrowser?.test(args[1])) throw new Error('browser step failed');
    if (command === 'git' && args[0] === 'clone' && args.at(-1) === destination) {
      await mkdir(destination, { recursive: true });
      return { stdout: '' };
    }
    return inner(command, args, runOptions);
  };
  try {
    const outcome = await setupRepository(repository, options).then(() => null, error => error);
    return { outcome, calls, destination, messages: project.record.messages };
  } finally {
    process.env.HOME = previousHome;
  }
}

testCase('setup installs the Archon source with bun and its lockfile before init, in the folder init uses');
{
  const { outcome, calls, destination } = await archonInstallRun('owner/archon-install');
  assert.equal(outcome, null);
  const at = predicate => calls.findIndex(predicate);
  const clone = at(call => call.command === 'git' && call.args[0] === 'clone' && call.args.at(-1) === destination);
  assert(clone >= 0);
  assert.deepEqual(calls[clone].args.slice(0, -1), ['clone', '--no-hardlinks', '--no-checkout', ARCHON_SOURCE]);
  assert.deepEqual(calls[clone + 1].args, ['checkout', '--detach', ARCHON_REVISION]);
  assert.equal(calls[clone + 1].cwd, destination);
  const install = calls.find(call => call.command === 'bun');
  assert.deepEqual(install.args, ['install', '--frozen-lockfile']);
  assert.equal(install.cwd, destination);
  assert(clone + 1 < at(call => call.command === 'bun'));
  assert(calls.findIndex(call => call.command === 'bun') < calls.findIndex(call => call.args[1] === 'init'));
  const init = calls.find(call => call.args[1] === 'init');
  assert.equal(join(init.args[init.args.indexOf('--cache') + 1], ARCHON_REVISION), destination);
  assert.equal(calls.filter(call => call.args[1] === 'init').length, 1);
}

testCase('a failed Archon install stops setup with the initialization message, removes the folder and never reaches init');
{
  const { outcome, calls, destination, messages } = await archonInstallRun('owner/archon-install-fails', { failInstall: true });
  assert(outcome instanceof ReportedSetupError && outcome.message === 'initialization');
  assert(!calls.some(call => call.args[1] === 'init'));
  assert(!(await isPresent(destination)));
  assert.match(messages.at(-1), /could not prepare the project/);
}

testCase('setup leaves an existing Archon folder to init and installs nothing itself');
{
  const { outcome, calls } = await archonInstallRun('owner/archon-folder-there', { folderExists: true });
  assert.equal(outcome, null);
  assert(!calls.some(call => call.command === 'bun'));
  assert(!calls.some(call => call.command === 'git' && call.args[0] === 'clone' && call.args.includes(ARCHON_SOURCE)));
  assert.equal(calls.filter(call => call.args[1] === 'init').length, 1);
}

const BROWSER_STOP = 'Setup stopped because the browser tool could not be installed or could not open a page. Run the Forge\'s install line on this server again, then try setup again.';

testCase('setup installs the pinned browser tool for this user, then proves it opens a page, after the Archon install and before init');
{
  const { outcome, calls, messages } = await archonInstallRun('owner/browser-ok');
  assert.equal(outcome, null);
  const scripts = calls.filter(call => call.command === 'bash').map(call => call.args[1]);
  assert.equal(scripts.length, 3);
  assert.match(scripts[0], /^command -v agent-browser \|\| npm install -g --prefix "\$HOME\/\.local" --no-fund --no-audit agent-browser@0\.44\.0$/);
  assert.equal(scripts[1], 'agent-browser install');
  assert.match(scripts[2], /open "file:\/\/\$dir\/page\.html".*get text body \| grep -q forge-browser-proof/s);
  const at = predicate => calls.findIndex(predicate);
  assert(at(call => call.command === 'bun') < at(call => call.command === 'bash'));
  assert(at(call => call.command === 'bash') < at(call => call.args[1] === 'init'));
  assert.equal(messages.filter(message => message === BROWSER_PASSED).length, 1);
}

testCase('a browser step that fails stops setup in plain words and never reaches init');
for (const [step, failBrowser] of [['install', /^agent-browser install$/], ['proof', /forge-browser-proof/]]) {
  const { outcome, calls, messages } = await archonInstallRun(`owner/browser-fails-${step}`, { failBrowser });
  assert(outcome instanceof ReportedSetupError && outcome.message === 'browser', step);
  assert.equal(messages.at(-1), BROWSER_STOP);
  assert(!messages.includes(BROWSER_PASSED));
  assert(!calls.some(call => call.args[1] === 'init'));
  assert(!/factory|archon|config|token/i.test(BROWSER_STOP));
}
