import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportedSetupError, setupRepository, prepareCheckout, repositoryFromRemote } from '../lib/setup.mjs';
import { findSignedInAgent } from '../lib/agent.mjs';
import {
  APP_PERMISSIONS, APP_PERMISSION_DOCUMENTATION, AppSetupStop, builderManifest, createApps,
  registrationAction, releaseManifest
} from '../lib/github-apps.mjs';
import { createGithubAdapter } from '../lib/github-adapter.mjs';
import { FACTORY_REVISION } from '../lib/constants.mjs';
import { credentialPath, defaults, projectStatePath, releaseCostMessage, writePrivateJson } from '../lib/config.mjs';

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
  if (command === 'python3' && args.at(-1) === 'init') {
    await mkdir(join(options.cwd, 'factory'), { recursive: true });
    await writeFile(join(options.cwd, 'MISSION.md'), '# Mission\n\nFactory template.\n');
    await writeFile(join(options.cwd, 'factory/consumer.py'), '# factory stand-in\n');
  }
  return { stdout: '' };
};
let answer = 0;
await setupRepository('owner/repo', {
  config: { ...defaults(root), projectsRoot }, paths: { state }, commands: { run },
  github: {
    begin: async manifest => { manifests.push(manifest); return { url: `https://example.test/${manifest.name}` }; },
    callback: async () => 'code', exchange: async () => credentials,
    install: async details => { installations.push(details); return true; }
  },
  prompt: async () => ['Keep releases dependable.', 'Small software teams.'][answer++],
  output: value => messages.push(value)
});
const mission = await readFile(join(checkout, 'MISSION.md'), 'utf8');
assert.match(mission, /Factory template/);
assert.match(mission, /Keep releases dependable\./);
assert.match(mission, /Small software teams\./);
assert.equal(calls.find(call => call.args.at(-1) === 'init').cwd, checkout);
assert(calls.some(call => call.args.includes(FACTORY_REVISION)));
assert(!calls.some(call => call.args.includes('schedule')));
assert.deepEqual(messages, [
  'Using Claude Code to set up the Forge.',
  'Create the builder App in your browser: https://example.test/Forge builder',
  'Create the release App in your browser: https://example.test/Forge release',
  'Setup is complete for owner/repo. Automatic work is off. A typical release costs about $5 to $40 of Claude Code use, based on Anthropic\'s published average of about $6 a day for one person using Claude Code, with most people under $12, and a release taking one to a few days of that work. On a Pro or Max plan this comes out of your plan\'s usage limits instead of a separate bill. The Forge adds no separate charge. This is a rough guide, not a quote: a large release can cost more. When you are ready to start automatic work, ask me to turn it on.'
]);

const codexMessages = [];
let codexAnswer = 0;
await setupRepository('owner/codex-repo', {
  config: { ...defaults(root), projectsRoot }, paths: { state: join(root, 'codex-state') },
  commands: { run: async (command, args, options) => command === 'claude' ? Promise.reject(new Error('not signed in')) : run(command, args, options) },
  github: {
    begin: async manifest => ({ url: `https://example.test/${manifest.name}` }),
    callback: async () => 'code', exchange: async () => credentials,
    install: async () => true
  },
  prompt: async () => ['Keep releases dependable.', 'Small software teams.'][codexAnswer++],
  output: value => codexMessages.push(value)
});
assert.deepEqual(codexMessages, [
  'Using Codex to set up the Forge.',
  'Create the builder App in your browser: https://example.test/Forge builder',
  'Create the release App in your browser: https://example.test/Forge release',
  'Setup is complete for owner/codex-repo. Automatic work is off. A typical release costs about $3 to $25 of Codex use, based on OpenAI\'s published usage prices for the Codex models, which are lower than Claude Code\'s, and a release taking one to a few days of agent work. On a ChatGPT Plus or Pro plan this comes out of your plan\'s usage limits instead of a separate bill. The Forge adds no separate charge. This is a rough guide, not a quote: a large release can cost more. When you are ready to start automatic work, ask me to turn it on.'
]);
for (const message of [...messages, ...codexMessages]) {
  assert((message.match(/https?:\/\//g) ?? []).length <= 1);
  assert(!/factory|archon|config|token/i.test(message));
}

assert.equal(
  releaseCostMessage('codex', 'Codex', { codex: { low: 10, high: 15 } }),
  'A typical release costs about $10 to $15 of Codex use, based on OpenAI\'s published usage prices for the Codex models, which are lower than Claude Code\'s, and a release taking one to a few days of agent work. On a ChatGPT Plus or Pro plan this comes out of your plan\'s usage limits instead of a separate bill. The Forge adds no separate charge. This is a rough guide, not a quote: a large release can cost more.'
);
assert.equal(
  releaseCostMessage('claude', 'Claude Code', { message: 'About ${low}-${high} on {agent} ({basis}).', claude: { basis: 'measured releases' } }),
  'About $5-$40 on Claude Code (measured releases).'
);
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
assert.deepEqual((await readdir(join(state, 'credentials/owner/repo'))).sort(), ['builder-app.json', 'release-app.json']);
const serializedProjectState = JSON.stringify({
  config: { projectsRoot, releaseCost: { message: 'Release cost.' } },
  paths: { state },
  projectState: await readTree(join(state, 'projects/owner/repo'))
});
assert(!serializedProjectState.includes('"code"'));
for (const [field, secret] of Object.entries(credentials)) {
  assert(!serializedProjectState.includes(field));
  assert(!serializedProjectState.includes(String(secret)));
  assert(!mission.includes(String(secret)));
  assert(!messages.join('\n').includes(String(secret)));
}

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
  const github = createGithubAdapter({ input: { question: async () => answer } });
  const flow = await github.begin(manifest);
  const page = Buffer.from(flow.url.split(',')[1], 'base64').toString('utf8');
  assert.match(page, new RegExp(`action="${action}"`));
  const encodedManifest = page.match(/name="manifest" value="([^"]+)"/)[1];
  const submittedManifest = JSON.parse(encodedManifest.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  assert.deepEqual(submittedManifest.default_permissions, permissions);
}

assert.equal(repositoryFromRemote('https://github.com/Owner/Repo.git'), 'owner/repo');
assert.equal(repositoryFromRemote('git@github.com:owner/repo.git'), 'owner/repo');
assert.equal(repositoryFromRemote('ssh://git@github.com/owner/repo.git'), 'owner/repo');
assert.equal(repositoryFromRemote('https://github.com/not-owner/repo.git'), 'not-owner/repo');
assert.equal(projectStatePath(state, 'owner/repo'), join(state, 'projects/owner/repo'));
assert.equal(credentialPath(state, 'owner/repo'), join(state, 'credentials/owner/repo'));
assert.notEqual(projectStatePath(state, 'owner--repo/name'), projectStatePath(state, 'owner/repo--name'));
const existing = join(root, 'existing', 'owner', 'repo');
await mkdir(join(existing, '.git'), { recursive: true });
await prepareCheckout('owner/repo', join(root, 'existing'), {
  run: async () => ({ stdout: 'git@github.com:owner/repo.git\n' })
});
await assert.rejects(prepareCheckout('owner/repo', join(root, 'existing'), {
  run: async () => ({ stdout: 'https://github.com/not-owner/repo.git\n' })
}), /different repository/);

const probes = [];
assert.equal(await findSignedInAgent(async command => {
  probes.push(command);
  if (command === 'claude') throw new Error('not signed in');
  return { stdout: 'signed in' };
}), 'codex');
assert.deepEqual(probes, ['claude', 'codex']);

const failedMessages = [];
let failedAnswer = 0;
await assert.rejects(setupRepository('owner/failing-doctor', {
  config: { projectsRoot, costMessage: 'Cost notice.' }, paths: { state }, commands: {
    run: async (command, args, options = {}) => {
      if (command === 'claude') return { stdout: 'signed in' };
      if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
      if (command === 'python3' && args.at(-1) === 'init') {
        await mkdir(join(options.cwd, 'factory'), { recursive: true });
        await writeFile(join(options.cwd, 'MISSION.md'), '# Mission\n');
        return { stdout: '' };
      }
      if (command === 'python3' && args.at(-1) === 'doctor') throw new Error('doctor output must stay private');
      return { stdout: '' };
    }
  },
  github: {
    begin: async () => ({ url: 'https://example.test/create' }), callback: async () => 'code', exchange: async () => credentials,
    install: async () => true
  },
  prompt: async () => ['Purpose.', 'Users.'][failedAnswer++], output: value => failedMessages.push(value)
}), error => error instanceof ReportedSetupError && error.message === 'final-check');
assert.deepEqual(failedMessages.at(-1), 'Setup stopped because the final check found a problem. Fix the problem reported by the check before trying setup again.');
await assert.rejects(stat(join(state, 'projects/owner/failing-doctor/registration.json')));
assert(!failedMessages.some(message => message.includes('schedule')));

const githubFailureMessages = [];
const githubFailureCalls = [];
await assert.rejects(setupRepository('owner/failing-github', {
  config: { projectsRoot, costMessage: 'Cost notice.' }, paths: { state }, commands: {
    run: async (command, args, options = {}) => {
      githubFailureCalls.push({ command, args });
      if (command === 'claude') return { stdout: 'signed in' };
      if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
      if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
      if (command === 'python3' && args.at(-1) === 'init') {
        await mkdir(join(options.cwd, 'factory'), { recursive: true });
        await writeFile(join(options.cwd, 'MISSION.md'), '# Mission\n');
      }
      return { stdout: '' };
    }
  },
  github: { begin: async () => { throw new Error('private GitHub detail'); } },
  prompt: async () => { throw new Error('must not prompt'); },
  output: value => githubFailureMessages.push(value)
}), error => error instanceof ReportedSetupError && error.message === 'github');
assert.deepEqual(githubFailureMessages.at(-1), 'Setup stopped because the GitHub connection was not completed. Complete the GitHub page before trying setup again.');
assert(!githubFailureCalls.some(call => call.args.at(-1) === 'doctor' || call.args.includes('schedule')));
await assert.rejects(stat(join(state, 'projects/owner/failing-github/registration.json')));

for (const failure of [
  {
    repository: 'owner/failing-download', command: 'git', argument: 'fetch',
    message: 'Setup stopped because the required files could not be downloaded from GitHub. Restore this server\'s access to GitHub before trying setup again.'
  },
  {
    repository: 'owner/failing-initialization', command: 'python3', argument: 'init',
    message: 'Setup stopped because the downloaded files could not prepare the project. Fix the problem reported during project preparation before trying setup again.'
  }
]) {
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
  const refusedState = join(root, `refused-${refusedKind}`);
  await assert.rejects(createApps({
    repository: 'owner/repo', stateDirectory: refusedState,
    credentialDirectory: join(refusedState, 'credentials'), output: () => {},
    github: {
      begin: async () => ({ url: 'https://example.test/create' }),
      callback: async () => 'code', exchange: async () => credentials,
      install: async ({ kind }) => kind !== refusedKind
    }
  }), new RegExp(`Install the ${refusedKind} App`));
  await assert.rejects(stat(join(refusedState, `${refusedKind}-installation.json`)));
}

const incompleteCredentialsState = join(root, 'incomplete-credentials');
await assert.rejects(createApps({
  repository: 'owner/repo', stateDirectory: incompleteCredentialsState,
  credentialDirectory: join(incompleteCredentialsState, 'credentials'), output: () => {},
  github: {
    begin: async () => ({ url: 'https://example.test/create' }),
    callback: async () => 'code', exchange: async () => ({ id: 12345, pem: 'PRIVATE KEY WITHOUT SLUG' }),
    install: async () => { throw new Error('must not install incomplete credentials'); }
  }
}), /did not return the builder App credentials/);
await assert.rejects(stat(join(incompleteCredentialsState, 'credentials/builder-app.json')));

const completedLegacyState = join(root, 'completed-legacy');
const completedLegacyCredentials = join(root, 'completed-legacy-credentials');
for (const kind of ['builder', 'release']) {
  await writePrivateJson(join(completedLegacyState, `${kind}-app.json`), { ...credentials, slug: `${kind}-slug` });
  await writePrivateJson(join(completedLegacyState, `${kind}-installation.json`), { repository: 'owner/repo', confirmed: true });
}
await createApps({
  repository: 'owner/repo', stateDirectory: completedLegacyState,
  credentialDirectory: completedLegacyCredentials, output: () => {},
  github: {
    exists: async path => { try { await stat(path); return true; } catch { return false; } },
    begin: async () => { throw new Error('must not create completed Apps'); },
    install: async () => { throw new Error('must not reinstall completed Apps'); }
  }
});
for (const kind of ['builder', 'release']) {
  const migrated = join(completedLegacyCredentials, `${kind}-app.json`);
  assert.equal((await stat(migrated)).mode & 0o777, 0o600);
  await assert.rejects(stat(join(completedLegacyState, `${kind}-app.json`)));
}

const interruptedState = join(root, 'interrupted-legacy');
const interruptedCredentials = join(root, 'interrupted-credentials');
await writePrivateJson(join(interruptedState, 'builder-app.json'), credentials);
const resumed = [];
await createApps({
  repository: 'owner/repo', stateDirectory: interruptedState,
  credentialDirectory: interruptedCredentials, output: () => {},
  github: {
    exists: async path => { try { await stat(path); return true; } catch { return false; } },
    begin: async manifest => ({ url: `https://example.test/${manifest.name}` }),
    callback: async () => 'code', exchange: async () => ({ ...credentials, slug: 'release-slug' }),
    install: async ({ kind }) => { resumed.push(kind); return true; }
  }
});
assert.deepEqual(resumed, ['builder', 'release']);
assert.deepEqual(JSON.parse(await readFile(join(interruptedCredentials, 'builder-app.json'), 'utf8')), credentials);
await assert.rejects(stat(join(interruptedState, 'builder-app.json')));

const duplicateState = join(root, 'duplicate-state');
const duplicateCredentials = join(root, 'duplicate-credentials');
const currentCredentials = { ...credentials, slug: 'current-slug' };
await writePrivateJson(join(duplicateState, 'builder-app.json'), { ...credentials, slug: 'stale-slug' });
await writePrivateJson(join(duplicateCredentials, 'builder-app.json'), currentCredentials);
await assert.rejects(createApps({
  repository: 'owner/repo', stateDirectory: duplicateState,
  credentialDirectory: duplicateCredentials, output: () => {},
  github: {
    exists: async () => false,
    install: async ({ credentials: installed, kind }) => {
      assert.equal(kind, 'builder');
      assert.deepEqual(installed, currentCredentials);
      return false;
    }
  }
}), /Install the builder App/);
await assert.rejects(stat(join(duplicateState, 'builder-app.json')));

const malformedState = join(root, 'malformed-state');
const malformedCredentials = join(root, 'malformed-credentials');
await writePrivateJson(join(malformedState, 'builder-app.json'), { id: 12345, pem: 'PRIVATE KEY WITHOUT SLUG' });
await assert.rejects(createApps({
  repository: 'owner/repo', stateDirectory: malformedState,
  credentialDirectory: malformedCredentials, output: () => {},
  github: { install: async () => { throw new Error('must not install malformed credentials'); } }
}), /Stored builder App credentials are incomplete/);
assert.deepEqual(JSON.parse(await readFile(join(malformedState, 'builder-app.json'), 'utf8')), {
  id: 12345, pem: 'PRIVATE KEY WITHOUT SLUG'
});
await assert.rejects(stat(join(malformedCredentials, 'builder-app.json')));

const inaccessibleState = join(root, 'inaccessible-state');
const inaccessibleCredentials = join(root, 'inaccessible-credentials');
await writePrivateJson(join(inaccessibleState, 'builder-installation.json'), {
  repository: 'owner/repo', confirmed: true
});
await writePrivateJson(join(inaccessibleCredentials, 'builder-app.json'), credentials);
await chmod(inaccessibleCredentials, 0o000);
try {
  await assert.rejects(createApps({
    repository: 'owner/repo', stateDirectory: inaccessibleState,
    credentialDirectory: inaccessibleCredentials, output: () => {},
    github: {
      begin: async () => { throw new Error('must not recreate inaccessible credentials'); },
      install: async () => { throw new Error('must not install inaccessible credentials'); }
    }
  }), error => error.code === 'EACCES');
} finally {
  await chmod(inaccessibleCredentials, 0o700);
}

const emptyRoot = join(root, 'no-agent');
const stopped = [];
await assert.rejects(setupRepository('owner/other', {
  config: { projectsRoot: emptyRoot, costMessage: 'Cost notice.' }, paths: { state: join(root, 'no-agent-state') },
  commands: { run: async () => { throw new Error('not signed in'); } },
  github: { begin: async () => { throw new Error('must not run'); } }, prompt: async () => '', output: value => stopped.push(value)
}), error => error instanceof ReportedSetupError && error.message === 'agent');
assert.deepEqual(stopped, ['Setup stopped because neither Claude Code nor Codex is signed in. Sign in to one of them before trying setup again.']);
await assert.rejects(stat(emptyRoot));

const isPresent = async path => { try { await stat(path); return true; } catch { return false; } };

function standInGithub(options = {}) {
  const counts = { builder: 0, release: 0 };
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
    install: async () => true
  };
  return { counts, live, github };
}

async function setupAttempt(repository, stateDirectory, github) {
  const attemptMessages = [];
  let attemptAnswer = 0;
  const retryRun = async (command, args, options) => command === 'git' && args[0] === 'remote'
    ? { stdout: `https://github.com/${repository}.git\n` }
    : run(command, args, options);
  try {
    await setupRepository(repository, {
      config: { ...defaults(root), projectsRoot }, paths: { state: stateDirectory }, commands: { run: retryRun }, github,
      prompt: async () => ['Purpose.', 'Users.'][attemptAnswer++], output: value => attemptMessages.push(value)
    });
    return { messages: attemptMessages };
  } catch (error) {
    return { messages: attemptMessages, error };
  }
}

const pendingFiles = async directory => (await readdir(directory)).filter(name => name.endsWith('-app-pending.json'));
const completedFor = repository => message => message.startsWith(`Setup is complete for ${repository}.`);

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

{
  const retryState = join(root, 'retry-transport');
  const credentialDirectory = credentialPath(retryState, 'owner/transport');
  const standIn = standInGithub({ failExchangeOnce: 'builder' });
  const first = await setupAttempt('owner/transport', retryState, standIn.github);
  assert(first.error instanceof ReportedSetupError && first.error.message === 'github-pending');
  assert.equal(first.messages.at(-1), 'Setup stopped because GitHub could not be reached to finish connecting the builder App. Try setup again; it will finish this App without creating another.');
  const pendingPath = join(credentialDirectory, 'builder-app-pending.json');
  assert.equal((await stat(pendingPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(pendingPath, 'utf8')), { code: 'code-builder-1' });
  assert(!JSON.stringify(await readTree(projectStatePath(retryState, 'owner/transport'))).includes('code-builder'));
  const second = await setupAttempt('owner/transport', retryState, standIn.github);
  assert(completedFor('owner/transport')(second.messages.at(-1)));
  assert.deepEqual(standIn.counts, { builder: 1, release: 1 });
  assert.deepEqual(await pendingFiles(credentialDirectory), []);
}

{
  const retryState = join(root, 'retry-write-after-exchange');
  const credentialDirectory = credentialPath(retryState, 'owner/lost-keys');
  const blockedPath = join(credentialDirectory, 'builder-app.json');
  let blockOnce = true;
  const standIn = standInGithub({
    onExchange: async () => { if (blockOnce) { blockOnce = false; await mkdir(join(blockedPath, 'blocked'), { recursive: true }); } }
  });
  const first = await setupAttempt('owner/lost-keys', retryState, standIn.github);
  assert(first.error instanceof ReportedSetupError && first.error.message === 'lost-app-keys');
  assert.equal(first.messages.at(-1), 'Setup stopped because this server would not let it save the builder App keys in its private folder, and GitHub hands them out only once. Delete the builder App for owner/lost-keys in your GitHub App settings and allow setup to write to that folder, then try setup again.');
  assert(!(await isPresent(join(credentialDirectory, 'builder-app-pending.json'))));
  standIn.live.builder -= 1;
  await rm(blockedPath, { recursive: true });
  const second = await setupAttempt('owner/lost-keys', retryState, standIn.github);
  assert(completedFor('owner/lost-keys')(second.messages.at(-1)));
  assert.deepEqual(standIn.live, { builder: 1, release: 1 });
  assert.deepEqual(await pendingFiles(credentialDirectory), []);
}

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

{
  const interruptedCredentialDirectory = join(root, 'retry-interrupted', 'credentials');
  const pendingPath = join(interruptedCredentialDirectory, 'builder-app-pending.json');
  await writePrivateJson(pendingPath, { code: null });
  const standIn = standInGithub();
  await assert.rejects(createApps({
    repository: 'owner/repo', stateDirectory: join(root, 'retry-interrupted'),
    credentialDirectory: interruptedCredentialDirectory, github: standIn.github, output: () => {}
  }), error => error instanceof AppSetupStop && error.reason === 'leftover' && error.kind === 'builder');
  assert.deepEqual(standIn.counts, { builder: 0, release: 0 });
  assert(!(await isPresent(pendingPath)));

  const noCallback = standInGithub({ noCallback: 'builder' });
  const noCallbackCredentials = join(root, 'retry-no-callback', 'credentials');
  await assert.rejects(createApps({
    repository: 'owner/repo', stateDirectory: join(root, 'retry-no-callback'),
    credentialDirectory: noCallbackCredentials, github: noCallback.github, output: () => {}
  }), error => error instanceof AppSetupStop && error.reason === 'leftover' && error.kind === 'builder');
  assert.deepEqual(noCallback.counts, { builder: 1, release: 0 });
  assert.deepEqual(await pendingFiles(noCallbackCredentials), []);
}

{
  const retryState = join(root, 'retry-builder-stored');
  const credentialDirectory = join(retryState, 'credentials');
  await writePrivateJson(join(credentialDirectory, 'builder-app.json'), { ...credentials, slug: 'builder-slug' });
  await writePrivateJson(join(retryState, 'builder-installation.json'), { repository: 'owner/repo', confirmed: true });
  await writePrivateJson(join(credentialDirectory, 'builder-app-pending.json'), { code: 'code-builder-1' });
  const standIn = standInGithub();
  await createApps({ repository: 'owner/repo', stateDirectory: retryState, credentialDirectory, github: standIn.github, output: () => {} });
  assert.deepEqual(standIn.counts, { builder: 0, release: 1 });
  assert.deepEqual(await pendingFiles(credentialDirectory), []);
}

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

await createApps({
  repository: 'owner/repo', stateDirectory: projectStatePath(state, 'owner/repo'),
  credentialDirectory: credentialPath(state, 'owner/repo'), output: () => {},
  github: { exists: isPresent, begin: async () => { throw new Error('must not create'); } }
});

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
  assert.equal(await createGithubAdapter({ input: { question: async () => 'http://127.0.0.1/' } }).callback(), null);
  assert.equal(await createGithubAdapter({ input: { question: async () => 'not an address' } }).callback(), null);
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
