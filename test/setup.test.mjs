import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, verify } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, ReportedSetupError, setupRepository, prepareCheckout, repositoryFromRemote } from '../lib/setup.mjs';
import { findSignedInAgent } from '../lib/agent.mjs';
import {
  APP_PERMISSIONS, APP_PERMISSION_DOCUMENTATION, AppSetupStop, AppStepError, builderManifest, createApps,
  registrationAction, releaseManifest
} from '../lib/github-apps.mjs';
import { createGithubAdapter } from '../lib/github-adapter.mjs';
import { run as runProcess } from '../lib/process.mjs';
import { FACTORY_REPOSITORY, FACTORY_REVISION } from '../lib/constants.mjs';
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
    await mkdir(join(options.cwd, '.factory'), { recursive: true });
    await writeFile(join(options.cwd, '.factory/consumer.json'), '{}\n');
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
}, () => { throw new Error('must not stop'); });

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
const FINAL_CHECK_FALLBACK = 'Setup stopped because the final check could not confirm that the build tools setup installed on this server work. Try setup again.';
assert.deepEqual(failedMessages.at(-1), FINAL_CHECK_FALLBACK);
await assert.rejects(stat(join(state, 'projects/owner/failing-doctor/registration.json')));
assert(!failedMessages.some(message => message.includes('schedule')));

const retryRun = async (command, args, options = {}) => {
  if (command === 'claude') return { stdout: 'signed in' };
  if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
  if (command === 'git' && args[0] === 'remote') return { stdout: 'git@github.com:owner/retry-check.git\n' };
  if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
  if (command === 'python3' && args.at(-1) === 'init') {
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
      begin: async manifest => { retryBegins += 1; return { url: `https://example.test/${manifest.name}` }; },
      callback: async () => 'code', exchange: async () => credentials,
      install: async () => { retryInstalls += 1; return true; }
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
  'Create the builder App in your browser: https://example.test/Forge builder',
  'Create the release App in your browser: https://example.test/Forge release',
  'Your two GitHub Apps for this repository, "Forge builder" and "Forge release", are already on your GitHub account and are kept there. Trying setup again uses them instead of creating new ones.',
  'Setup stopped because the final check found that the guard keeping your project\'s hidden test scenarios away from the coding agent does not work on this server, because the python command there does not run Python 3. Install the python-is-python3 package on this server before trying setup again.'
]);
for (const hidden of ['Factory refused', 'Holdout fence', 'consumer.py', 'Traceback', 'ghs_report_secret', 'report']) {
  assert(!retryFailed.some(message => message.includes(hidden)), hidden);
}
assert(retryFailed.at(-1).split('http').length - 1 <= 1);
await assert.rejects(stat(join(state, 'projects/owner/retry-check/registration.json')));
assert.equal(retryBegins, 2);
const installsBeforeRetry = retryInstalls;

retryCheckPasses = true;
const retryPassed = [];
assert.deepEqual(
  await setupRepository('owner/retry-check', retryOptions(value => retryPassed.push(value))),
  { completed: true, checkout: join(projectsRoot, 'owner/retry-check') }
);
assert.deepEqual(retryPassed, [
  'Using Claude Code to set up the Forge.',
  'Setup is complete for owner/retry-check. Automatic work is off. A typical release costs about $5 to $40 of Claude Code use, based on Anthropic\'s published average of about $6 a day for one person using Claude Code, with most people under $12, and a release taking one to a few days of that work. On a Pro or Max plan this comes out of your plan\'s usage limits instead of a separate bill. The Forge adds no separate charge. This is a rough guide, not a quote: a large release can cost more. When you are ready to start automatic work, ask me to turn it on.'
]);
assert.equal(retryBegins, 2);
assert.equal(retryInstalls, installsBeforeRetry);
assert.equal(JSON.parse(await readFile(join(state, 'projects/owner/retry-check/registration.json'), 'utf8')).completed, true);

// A stop at the final check tells the owner their Apps are kept; stopping again and retrying add none.
const appsKeptState = join(root, 'apps-kept-state');
const appsKeptProjects = join(root, 'apps-kept-projects');
const APPS_KEPT_MESSAGE = 'Your two GitHub Apps for this repository, "Acme Forge builder" and "Acme Forge release", are already on your GitHub account and are kept there. Trying setup again uses them instead of creating new ones.';
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
      begin: async manifest => {
        appsKeptBegins[manifest.name] = (appsKeptBegins[manifest.name] ?? 0) + 1;
        return { url: `https://example.test/${manifest.name}`, name: manifest.name };
      },
      callback: async flow => flow.name,
      exchange: async name => ({ ...credentials, name: name === 'Forge builder' ? 'Acme Forge builder' : 'Acme Forge release' }),
      install: async () => true
    },
    prompt: async () => ['Purpose.', 'Users.'][appsKeptAnswer++],
    output
  };
};
const appsKeptFirst = [];
await assert.rejects(setupRepository('owner/apps-kept', appsKeptOptions(value => appsKeptFirst.push(value))),
  error => error instanceof ReportedSetupError && error.message === 'final-check');
assert.equal(appsKeptFirst.at(-1), FINAL_CHECK_FALLBACK);
assert.equal(appsKeptFirst.at(-2), APPS_KEPT_MESSAGE);
assert.equal(appsKeptFirst.filter(message => message.startsWith('Setup stopped because')).length, 1);
assert.deepEqual(appsKeptFirst.filter(message => message.includes('http')), [
  'Create the builder App in your browser: https://example.test/Forge builder',
  'Create the release App in your browser: https://example.test/Forge release'
]);
for (const hidden of ['archon', 'factory', 'doctor', 'consumer', 'credential', '.json', 'forge-builder-secret-name', 'http']) {
  assert(!appsKeptFirst.slice(-2).some(message => message.toLowerCase().includes(hidden)), hidden);
}
const appsKeptSecond = [];
await assert.rejects(setupRepository('owner/apps-kept', appsKeptOptions(value => appsKeptSecond.push(value))),
  error => error instanceof ReportedSetupError && error.message === 'final-check');
assert.deepEqual(appsKeptSecond, ['Using Claude Code to set up the Forge.', APPS_KEPT_MESSAGE, FINAL_CHECK_FALLBACK]);
assert.deepEqual(appsKeptBegins, { 'Forge builder': 1, 'Forge release': 1 });
appsKeptCheckPasses = true;
const appsKeptPassed = [];
await setupRepository('owner/apps-kept', appsKeptOptions(value => appsKeptPassed.push(value)));
assert(appsKeptPassed.at(-1).startsWith('Setup is complete for owner/apps-kept.'));
assert(!appsKeptPassed.includes(APPS_KEPT_MESSAGE));
assert.deepEqual(appsKeptBegins, { 'Forge builder': 1, 'Forge release': 1 });

await assert.rejects(
  runProcess(process.execPath, ['-e', 'process.stdout.write("partial"); process.stderr.write("check said no"); process.exit(1)']),
  error => error.message === `${process.execPath} failed.` && error.stderr === 'check said no' && error.stdout === 'partial'
);

// Every refusal the pinned factory's doctor can raise, in its real report text, gets a message naming
// what the check found and the one action that fixes it.
const buildToolsCache = join(root, 'cache/factory/archon/1cfb8fc541580fe5edf15e9a504b572bc9bb45bb');
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
  [refusal('Source SHA mismatch: expected 1cfb8fc541580fe5edf15e9a504b572bc9bb45bb, found 0000000000000000000000000000000000000000'), SOURCE_DAMAGED],
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
  const repository = `owner/check-${index}`;
  const outputs = [];
  let answer = 0;
  await assert.rejects(setupRepository(repository, {
    config: { ...defaults(root), projectsRoot }, paths: { state }, commands: {
      run: async (command, args, options = {}) => {
        if (command === 'claude') return { stdout: 'signed in' };
        if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
        if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
        if (command === 'python3' && args.at(-1) === 'init') {
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
    github: { begin: async () => ({ url: 'https://example.test/create' }), callback: async () => 'code', exchange: async () => credentials, install: async () => true },
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
  const repository = `owner/replace-${name}`;
  const caseRoot = join(root, `replace-${name}`);
  const download = join(caseRoot, 'cache/factory/archon/1cfb8fc541580fe5edf15e9a504b572bc9bb45bb');
  let downloads = 0;
  let checks = 0;
  const options = outputs => {
    let answer = 0;
    return {
      config: { ...defaults(root), projectsRoot: join(caseRoot, 'projects') }, paths: { state: join(caseRoot, 'state') },
      commands: {
        run: async (command, args, runOptions = {}) => {
          if (command === 'git' && args[0] === 'remote') return { stdout: `git@github.com:${repository}.git\n` };
          if (command === 'python3' && args.at(-1) === 'init') {
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
      github: { begin: async () => ({ url: 'https://example.test/create' }), callback: async () => 'code', exchange: async () => credentials, install: async () => true },
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

// A refusal that is not about the download leaves the download alone on retry, and a recorded folder that is
// not a download folder named with its revision is never deleted.
{
  const caseRoot = join(root, 'replace-other');
  const repository = 'owner/replace-other';
  const download = join(caseRoot, 'cache/factory/archon/1cfb8fc541580fe5edf15e9a504b572bc9bb45bb');
  const keep = join(caseRoot, 'keep');
  await mkdir(download, { recursive: true });
  await mkdir(keep, { recursive: true });
  let checks = 0;
  const run = (source, report) => async (command, args, runOptions = {}) => {
    if (command === 'git' && args[0] === 'remote') return { stdout: `git@github.com:${repository}.git\n` };
    if (command === 'python3' && args.at(-1) === 'init') {
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
      github: { begin: async () => ({ url: 'https://example.test/create' }), callback: async () => 'code', exchange: async () => credentials, install: async () => true },
      prompt: async () => ['Purpose.', 'Users.'][answer++],
      output: () => {}
    }), error => error instanceof ReportedSetupError && error.message === 'final-check');
  }
  assert.equal(checks, 4);
  assert((await stat(download)).isDirectory());
  assert((await stat(keep)).isDirectory());
}

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
  github: { ...abandonedAdapter, begin: async manifest => { await abandonedAdapter.begin(manifest); return { url: 'https://example.test/create' }; } },
  prompt: async () => { throw new Error('must not prompt'); },
  output: value => abandonedOutputs.push(value)
}), error => error instanceof ReportedSetupError && error.message === 'github');
assert.deepEqual(abandonedOutputs, [
  'Using Claude Code to set up the Forge.',
  'Create the builder App in your browser: https://example.test/create',
  'Setup stopped because the GitHub page for creating its builder App was left unfinished, so GitHub did not hand that App over. Try setup again, finish creating the builder App on the GitHub page it opens, and paste the address your browser shows afterwards.'
]);
await assert.rejects(stat(join(state, 'projects/owner/abandoned-page/registration.json')));

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
    begin: async manifest => { await abandonedReleaseAdapter.begin(manifest); return { url: 'https://example.test/create' }; },
    callback: async flow => abandonedReleaseKinds.length === 0 ? 'code' : abandonedReleaseAdapter.callback(flow),
    exchange: async () => credentials,
    install: async ({ kind }) => { abandonedReleaseKinds.push(kind); return true; }
  },
  prompt: async () => { throw new Error('must not prompt'); },
  output: value => abandonedReleaseOutputs.push(value)
}), error => error instanceof ReportedSetupError && error.message === 'github');
assert.deepEqual(abandonedReleaseKinds, ['builder']);
assert.deepEqual(abandonedReleaseOutputs, [
  'Using Claude Code to set up the Forge.',
  'Create the builder App in your browser: https://example.test/create',
  'Create the release App in your browser: https://example.test/create',
  'Setup stopped because the GitHub page for creating its release App was left unfinished, so GitHub did not hand that App over. Try setup again, finish creating the release App on the GitHub page it opens, and paste the address your browser shows afterwards.'
]);
await assert.rejects(stat(join(state, 'projects/owner/abandoned-release-page/registration.json')));

// The folder accepts the pending record (#29) but stops accepting files once GitHub hands the App over.
const unwritableCredentials = credentialPath(state, 'owner/unwritable-credentials');
await mkdir(unwritableCredentials, { recursive: true, mode: 0o700 });
const unwritableOutputs = [];
try {
  await assert.rejects(setupRepository('owner/unwritable-credentials', {
    config: { projectsRoot, costMessage: 'Cost notice.' }, paths: { state }, commands: { run: async (...call) => appStepRun(...call) },
    github: {
      begin: async () => ({ url: 'https://example.test/create' }),
      callback: async () => 'code',
      exchange: async () => { await chmod(unwritableCredentials, 0o500); return credentials; },
      install: async () => { throw new Error('must not install unsaved credentials'); }
    },
    prompt: async () => { throw new Error('must not prompt'); },
    output: value => unwritableOutputs.push(value)
  }), error => error instanceof ReportedSetupError && error.message === 'github');
} finally {
  await chmod(unwritableCredentials, 0o700);
}
assert.deepEqual(unwritableOutputs, [
  'Using Claude Code to set up the Forge.',
  'Create the builder App in your browser: https://example.test/create',
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
}), error => error instanceof AppSetupStop && error.reason === 'damaged' && error.kind === 'builder');
await assert.rejects(stat(join(malformedState, 'builder-app.json')));
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

// deleted and uninstalled name the Apps GitHub answers for as gone from the account or from the repository;
// unreachable names the Apps whose check fails as if GitHub could not be reached.
function standInGithub(options = {}) {
  const counts = { builder: 0, release: 0 };
  const installs = { builder: 0, release: 0 };
  const onGithub = { deleted: new Set(), uninstalled: new Set(), unreachable: new Set() };
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
    appStatus: async ({ kind }) => {
      if (onGithub.unreachable.has(kind)) throw new Error('network unreachable');
      if (onGithub.deleted.has(kind)) return 'app-missing';
      return onGithub.uninstalled.has(kind) ? 'not-installed' : 'installed';
    }
  };
  return { counts, live, installs, onGithub, github };
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

  // An address without GitHub's code means the App page was left unfinished (#44): the stop names that
  // page, the pending record goes, and the next run opens the page again.
  const noCallback = standInGithub({ noCallback: 'builder' });
  const noCallbackCredentials = join(root, 'retry-no-callback', 'credentials');
  await assert.rejects(createApps({
    repository: 'owner/repo', stateDirectory: join(root, 'retry-no-callback'),
    credentialDirectory: noCallbackCredentials, github: noCallback.github, output: () => {}
  }), error => error instanceof AppStepError && error.step === 'page' && error.kind === 'builder');
  assert.deepEqual(noCallback.counts, { builder: 1, release: 0 });
  assert.deepEqual(await pendingFiles(noCallbackCredentials), []);
}

// A stop on damaged App files (#52) names no file or internal detail, carries at most one link, and the
// next run asks for the GitHub page of that App again instead of stopping the same way.
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
    ? [`Setup stopped because it could not finish connecting the ${kind} App. If GitHub created a ${kind} App for ${repository}, delete it in your GitHub App settings, then try setup again.`, 'leftover-app']
    : [`Setup stopped because the saved details of the ${kind} App on this server are damaged. Delete the ${kind} App for ${repository} in your GitHub App settings, then try setup again.`, 'damaged-app'];
  assert(first.error instanceof ReportedSetupError && first.error.message === expected[1], `${kind} ${damage.file}`);
  assert.equal(first.messages.at(-1), expected[0]);
  assert(!first.messages.some(message => message.includes('Complete the GitHub page')));
  assertNoInternalText(first.messages.at(-1), retryState);
  assert(!(await isPresent(damagedPath)));
  assert.equal(standIn.counts[kind], 0);
  const second = await setupAttempt(repository, retryState, standIn.github);
  assert.equal(second.error, undefined);
  assert(!second.messages.includes(first.messages.at(-1)));
  assert(second.messages.includes(`Create the ${kind} App in your browser: https://example.test/Forge ${kind}`));
  assert(completedFor(repository)(second.messages.at(-1)));
  assert.deepEqual(standIn.counts, { builder: 1, release: 1 });
}

// Stored App details damaged after that App was installed: on a finished setup, and on one that stopped
// later. The next run still creates and installs that App again instead of skipping it.
for (const [kind, finished] of [['builder', false], ['release', true]]) {
  const repository = `owner/${kind}-damaged-${finished ? 'finished' : 'unfinished'}`;
  const retryState = join(root, `retry-damaged-installed-${kind}`);
  const stateDirectory = projectStatePath(retryState, repository);
  const standIn = standInGithub();
  assert.equal((await setupAttempt(repository, retryState, standIn.github)).error, undefined);
  if (!finished) await rm(join(stateDirectory, 'registration.json'));
  await writeFile(join(credentialPath(retryState, repository), `${kind}-app.json`), '{"id": 12345, "pem": "PRIV');
  const first = await setupAttempt(repository, retryState, standIn.github);
  assert(first.error instanceof ReportedSetupError && first.error.message === 'damaged-app', `${kind} ${finished}`);
  assert.equal(first.messages.at(-1), `Setup stopped because the saved details of the ${kind} App on this server are damaged. Delete the ${kind} App for ${repository} in your GitHub App settings, then try setup again.`);
  assertNoInternalText(first.messages.at(-1), retryState);
  assert(!(await isPresent(join(stateDirectory, `${kind}-installation.json`))));
  const second = await setupAttempt(repository, retryState, standIn.github);
  assert.equal(second.error, undefined);
  assert(!second.messages.includes(first.messages.at(-1)));
  assert(second.messages.includes(`Create the ${kind} App in your browser: https://example.test/Forge ${kind}`));
  assert(completedFor(repository)(second.messages.at(-1)));
  assert.equal(standIn.counts[kind], 2);
  assert(await isPresent(join(stateDirectory, `${kind}-installation.json`)));
  const third = await setupAttempt(repository, retryState, standIn.github);
  assert.deepEqual(third.messages, [`The Forge is already set up for ${repository}.`]);
}

// Stored App details that are a link whose target is gone are damaged, not finished: the run stops with the
// damaged-App sentence instead of reporting setup as done, and once the owner deletes that App on GitHub the
// next run creates it again, leaving one App per role.
for (const [kind, finished] of [['builder', false], ['release', true]]) {
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
  assert(first.error instanceof ReportedSetupError && first.error.message === 'damaged-app', `${kind} ${finished}`);
  assert.equal(first.messages.at(-1), `Setup stopped because the saved details of the ${kind} App on this server are damaged. Delete the ${kind} App for ${repository} in your GitHub App settings, then try setup again.`);
  assertNoInternalText(first.messages.at(-1), retryState);
  assert(!first.messages.some(message => message.startsWith('Setup is complete') || message.startsWith('The Forge is already set up')));
  await assert.rejects(lstat(linkPath));
  assert(!(await isPresent(join(stateDirectory, `${kind}-installation.json`))));
  standIn.live[kind] -= 1;
  const second = await setupAttempt(repository, retryState, standIn.github);
  assert.equal(second.error, undefined);
  assert(second.messages.includes(`Create the ${kind} App in your browser: https://example.test/Forge ${kind}`));
  assert(completedFor(repository)(second.messages.at(-1)));
  assert.deepEqual(standIn.live, { builder: 1, release: 1 });
}

// An empty App details file is nothing saved: setup does exactly what it does when that file is missing,
// on a fresh setup and after a finished one, and never calls it damaged.
for (const [n, prepare] of [
  [1, async (retryState, repository, empty) => {
    if (!empty) return;
    await mkdir(credentialPath(retryState, repository), { recursive: true, mode: 0o700 });
    await writeFile(join(credentialPath(retryState, repository), 'builder-app.json'), '', { mode: 0o600 });
  }],
  [2, async (retryState, repository, empty, github) => {
    assert.equal((await setupAttempt(repository, retryState, github)).error, undefined);
    const path = join(credentialPath(retryState, repository), 'release-app.json');
    if (empty) await writeFile(path, ''); else await rm(path);
  }]
]) {
  const repository = `owner/empty-app-${n}`;
  const runs = [];
  for (const empty of [true, false]) {
    const retryState = join(root, `${empty ? 'empty' : 'deleted'}-app-${n}`);
    const standIn = standInGithub();
    await prepare(retryState, repository, empty, standIn.github);
    runs.push({ ...(await setupAttempt(repository, retryState, standIn.github)), counts: standIn.counts });
  }
  const [emptied, deleted] = runs;
  assert.deepEqual(emptied.messages, deleted.messages);
  assert.equal(emptied.error?.message, deleted.error?.message);
  assert.deepEqual(emptied.counts, deleted.counts);
  assert(!emptied.messages.some(message => message.includes('damaged')), JSON.stringify(emptied.messages));
  if (n === 1) {
    assert(completedFor(repository)(emptied.messages.at(-1)));
    assert.deepEqual(emptied.counts, { builder: 1, release: 1 });
  }
}

{
  // A damaged file setup cannot remove gives the existing stop for an unwritable private folder.
  const repository = 'owner/damaged-locked';
  const retryState = join(root, 'retry-damaged-locked');
  const credentialDirectory = credentialPath(retryState, repository);
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(credentialDirectory, 'builder-app.json'), '{', { mode: 0o600 });
  await chmod(credentialDirectory, 0o500);
  let first;
  try {
    first = await setupAttempt(repository, retryState, standInGithub().github);
  } finally {
    await chmod(credentialDirectory, 0o700);
  }
  assert(first.error instanceof ReportedSetupError && first.error.message === 'credential-location');
  assert.equal(first.messages.at(-1), 'Setup stopped because this server would not let it save the GitHub App keys in its private folder. Allow setup to write to that folder before trying setup again.');
}

{
  // A pending record whose saved keys lack a field is damaged too: GitHub created the App, so the owner deletes it.
  const credentialDirectory = join(root, 'retry-damaged-pending-keys', 'credentials');
  const pendingPath = join(credentialDirectory, 'builder-app-pending.json');
  await writePrivateJson(pendingPath, { code: 'code-builder-1', credentials: { id: 12345, pem: 'PRIVATE KEY WITHOUT SLUG' } });
  await assert.rejects(createApps({
    repository: 'owner/repo', stateDirectory: join(root, 'retry-damaged-pending-keys'),
    credentialDirectory, github: standInGithub().github, output: () => {}
  }), error => error instanceof AppSetupStop && error.reason === 'leftover' && error.kind === 'builder');
  assert(!(await isPresent(pendingPath)));
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

// A rerun after a finished setup checks what setup made before saying it is set up (#60). Each missing
// piece stops with one plain message naming it, and following that message gets setup complete again.
const appGoneStops = {
  missing: (kind, repository) => [`Setup stopped because the saved details of the ${kind} App on this server are missing. Delete the ${kind} App for ${repository} in your GitHub App settings, then try setup again.`, 'missing-app-details'],
  gone: (kind, repository) => [`Setup stopped because the ${kind} App for ${repository} is no longer on your GitHub account. Try setup again, which creates it again; if your GitHub App settings still list a ${kind} App for ${repository}, delete it first.`, 'app-missing'],
  uninstalled: (kind, repository) => [`Setup stopped because the ${kind} App is no longer installed on ${repository}. Try setup again, which asks you to install it again.`, 'app-not-installed'],
  unchecked: (kind, repository) => [`Setup stopped because GitHub could not be reached to check the ${kind} App for ${repository}. Restore this server's access to GitHub before trying setup again.`, 'github-check'],
  buildTools: repository => [`Setup stopped because the build tools setup installed in the project folder for ${repository} on this server are missing. Try setup again, which installs them again.`, 'factory-missing']
};

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
    attempt: () => setupAttempt(repository, retryState, standIn.github)
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

for (const kind of ['builder', 'release']) {
  const other = kind === 'builder' ? 'release' : 'builder';
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
    const next = await project.attempt();
    assert.equal(next.error, undefined);
    assert(next.messages.includes(`Create the ${kind} App in your browser: https://example.test/Forge ${kind}`));
    assert(completedFor(project.repository)(next.messages.at(-1)));
    assert.equal(project.standIn.counts[kind], 2);
    assert.equal(project.standIn.counts[other], 1);
    assert.deepEqual((await project.attempt()).messages, [`The Forge is already set up for ${project.repository}.`]);
  }
  {
    // The App's saved details were deleted from this server.
    const project = await finishedSetup(`${kind}-details-deleted`);
    await rm(join(project.credentialDirectory, `${kind}-app.json`));
    assertStopped(await project.attempt(), appGoneStops.missing(kind, project.repository), project.retryState);
    assert(!(await isPresent(join(project.stateDirectory, `${kind}-installation.json`))));
    assert(!(await isPresent(join(project.stateDirectory, 'registration.json'))));
    const next = await project.attempt();
    assert(next.messages.includes(`Create the ${kind} App in your browser: https://example.test/Forge ${kind}`));
    assert(completedFor(project.repository)(next.messages.at(-1)));
    assert.deepEqual(project.standIn.counts, { [kind]: 2, [other]: 1 });
  }
}

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

{
  // Both Apps broken at once: the stop names the first, and the next run repairs both.
  const project = await finishedSetup('both-broken');
  project.standIn.onGithub.deleted.add('builder');
  project.standIn.onGithub.uninstalled.add('release');
  assertStopped(await project.attempt(), appGoneStops.gone('builder', project.repository), project.retryState);
  assert(!(await isPresent(join(project.stateDirectory, 'release-installation.json'))));
  project.standIn.onGithub.deleted.clear();
  project.standIn.onGithub.uninstalled.clear();
  const next = await project.attempt();
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 2, release: 1 });
  assert.deepEqual(project.standIn.installs, { builder: 2, release: 2 });
}

{
  // GitHub answers that the release App is gone but cannot be reached for the builder App: the stop is the
  // unreachable check, nothing is removed, and once GitHub answers for both the next runs repair the release
  // App only after checking the builder App again.
  const project = await finishedSetup('one-unchecked');
  const before = await readTree(project.retryState);
  project.standIn.onGithub.deleted.add('release');
  project.standIn.onGithub.unreachable.add('builder');
  assertStopped(await project.attempt(), appGoneStops.unchecked('builder', project.repository), project.retryState);
  assert.deepEqual(await readTree(project.retryState), before);
  project.standIn.onGithub.unreachable.clear();
  project.standIn.onGithub.deleted.add('builder');
  assertStopped(await project.attempt(), appGoneStops.gone('builder', project.repository), project.retryState);
  project.standIn.onGithub.deleted.clear();
  const next = await project.attempt();
  assert(completedFor(project.repository)(next.messages.at(-1)));
  assert.deepEqual(project.standIn.counts, { builder: 2, release: 2 });
}

for (const removed of ['settings', 'folder']) {
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

{
  // An unfinished setup whose App details are gone while the App's install record stays does not skip that App.
  const stateDirectory = join(root, 'details-gone-installed');
  const credentialDirectory = join(stateDirectory, 'credentials');
  const installationPath = join(stateDirectory, 'builder-installation.json');
  await writePrivateJson(installationPath, { repository: 'owner/repo', confirmed: true });
  const standIn = standInGithub();
  await assert.rejects(createApps({ repository: 'owner/repo', stateDirectory, credentialDirectory, github: standIn.github, output: () => {} }),
    error => error instanceof AppSetupStop && error.reason === 'missing' && error.kind === 'builder');
  assert(!(await isPresent(installationPath)));
  assert.deepEqual(standIn.counts, { builder: 0, release: 0 });
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
      return { status: next };
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
  assert.equal(await status(401), 'app-missing');
  assert.equal(requests.length, 1);
  assert.equal(await status(200, 404), 'not-installed');
  for (const answers of [[502], [200, 500], [new TypeError('fetch failed')]]) {
    await assert.rejects(status(...answers), error => error.message === 'GitHub could not be reached to check the App.');
    responses.length = 0;
  }
  requests.length = 0;
  assert.equal(await adapter.appStatus({ credentials, repository: 'owner/repo', kind: 'builder' }), 'app-missing');
  assert.equal(requests.length, 0);
}

async function retryProject(repository) {
  const record = { prompts: [], begins: 0, calls: [], messages: [] };
  const retryState = join(root, 'retry-state');
  const options = ({ failAt, answers = ['First purpose.', 'First users.'] } = {}) => ({
    config: { ...defaults(root), projectsRoot: join(root, 'retry-projects') }, paths: { state: retryState },
    commands: {
      run: async (command, args, runOptions = {}) => {
        record.calls.push({ command, args });
        if (command === 'claude') return { stdout: 'signed in' };
        if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
        if (command === 'git' && args[0] === 'remote') return { stdout: `git@github.com:${repository}.git\n` };
        if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
        if (command === 'python3' && args.at(-1) === 'init') {
          await mkdir(join(runOptions.cwd, 'factory'), { recursive: true });
          try { await stat(join(runOptions.cwd, 'MISSION.md')); } catch {
            await writeFile(join(runOptions.cwd, 'MISSION.md'), '# Mission\n\nFactory template.\n');
          }
          await mkdir(join(runOptions.cwd, '.factory'), { recursive: true });
          await writeFile(join(runOptions.cwd, '.factory/consumer.json'), '{}\n');
        }
        if (command === 'python3' && args.at(-1) === 'doctor' && failAt === 'final-check') throw new Error('doctor failed');
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
      appStatus: async () => 'installed'
    },
    prompt: async question => { record.prompts.push(question); return answers[record.prompts.length - 1] ?? 'Other.'; },
    output: value => record.messages.push(value)
  });
  const missionPath = join(root, 'retry-projects', repository, 'MISSION.md');
  const missionSections = async () => (await readFile(missionPath, 'utf8')).match(/^## Project mission$/gm)?.length ?? 0;
  return { record, options, missionPath, missionSections, reset: () => {
    record.prompts.length = 0; record.begins = 0; record.calls.length = 0; record.messages.length = 0;
  } };
}

// A stop after the mission answers: the retry does not ask them again.
{
  const project = await retryProject('owner/stopped-after-mission');
  await assert.rejects(setupRepository('owner/stopped-after-mission', project.options({ failAt: 'final-check' })),
    error => error instanceof ReportedSetupError && error.message === 'final-check');
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
  assert(!project.record.calls.some(call => call.args.at(-1) === 'doctor'));
  assert.deepEqual(await readFile(project.missionPath), missionBefore);
  assert.deepEqual(project.record.messages, ['The Forge is already set up for owner/already-set-up.']);
}

// An already set-up project from an earlier release still has its credentials moved by asking for setup again.
{
  const project = await retryProject('owner/legacy-set-up');
  const legacyState = join(root, 'retry-state/projects/owner/legacy-set-up');
  const legacyCheckout = join(root, 'retry-projects/owner/legacy-set-up');
  await mkdir(join(legacyCheckout, '.git'), { recursive: true });
  await mkdir(join(legacyCheckout, '.factory'), { recursive: true });
  await writeFile(join(legacyCheckout, '.factory/consumer.json'), '{}\n');
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

async function stopThenRetry(name, { prepare, run: failingRun = () => null, onPrompt = async () => {}, answers = ['Purpose.', 'Users.'], undo = async () => {}, reason, before = [], message }) {
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
          if (command === 'python3' && args.at(-1) === 'init') await writeFile(join(runOptions.cwd, 'MISSION.md'), '# Mission\n');
          return { stdout: '' };
        }
      },
      github: {
        exists: async path => { try { await stat(path); return true; } catch { return false; } },
        begin: async manifest => { begins += 1; return { url: `https://example.test/${manifest.name}` }; },
        callback: async () => 'code',
        exchange: async () => credentials,
        install: async () => true
      },
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

await stopThenRetry('unwritable-state', {
  prepare: async ({ state }) => chmod(state, 0o500),
  undo: async ({ state }) => chmod(state, 0o700),
  reason: 'settings',
  message: 'Setup stopped because it could not save its settings on this server. Let setup write to the folder where the Forge keeps its settings before trying setup again.'
});

// mission.json lives in the project state folder: failing to read or save it is the same settings stop.
// The Apps exist by then, so the stop first says they are kept.
const missionPath = (state, name) => join(state, 'projects', 'owner', name, 'mission.json');
const appPages = [
  'Create the builder App in your browser: https://example.test/Forge builder',
  'Create the release App in your browser: https://example.test/Forge release'
];
const FORGE_APPS_KEPT = 'Your two GitHub Apps for this repository, "Forge builder" and "Forge release", are already on your GitHub account and are kept there. Trying setup again uses them instead of creating new ones.';
for (const [name, mission] of [
  ['unreadable-mission', {
    prepare: async ({ state }) => {
      await writePrivateJson(missionPath(state, 'unreadable-mission'), { purpose: 'Purpose.', users: 'Users.' });
      await chmod(missionPath(state, 'unreadable-mission'), 0o000);
    },
    undo: async ({ state }) => chmod(missionPath(state, 'unreadable-mission'), 0o600)
  }],
  ['mission-directory', {
    prepare: async ({ state }) => mkdir(missionPath(state, 'mission-directory'), { recursive: true }),
    undo: async ({ state }) => rm(missionPath(state, 'mission-directory'), { recursive: true })
  }]
]) {
  await stopThenRetry(name, {
    ...mission,
    reason: 'settings',
    before: [...appPages, FORGE_APPS_KEPT],
    message: 'Setup stopped because it could not save its settings on this server. Let setup write to the folder where the Forge keeps its settings before trying setup again.'
  });
}

// Answers that cannot be saved are lost: the stop says so and that setup asks them again.
const MISSION_NOT_SAVED = 'Setup stopped because it could not save your answers to the mission questions on this server, so they were not kept. Let setup write to the folder where the Forge keeps its settings, then try setup again; it asks those questions again.';
await stopThenRetry('unwritable-mission', {
  onPrompt: async ({ state }) => chmod(join(state, 'projects', 'owner', 'unwritable-mission'), 0o500),
  undo: async ({ state }) => chmod(join(state, 'projects', 'owner', 'unwritable-mission'), 0o700),
  reason: 'settings',
  before: [...appPages, FORGE_APPS_KEPT],
  message: MISSION_NOT_SAVED
});

// The run after that asks the mission questions once and saves the answers; the run after it asks nothing.
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
  await assert.rejects(setupRepository(repository, project.options({ failAt: 'final-check' })),
    error => error instanceof ReportedSetupError && error.message === 'final-check');
  assert.deepEqual(project.record.prompts, ['What is this software for?', 'Who uses it?']);
  assert(await isPresent(join(stateDirectory, 'mission.json')));
  assert.equal(project.record.begins, 0);
  project.reset();
  assert.equal((await setupRepository(repository, project.options())).completed, true);
  assert.deepEqual(project.record.prompts, []);
  assert.equal(await project.missionSections(), 1);
}

// A mission question left empty, after the Apps exist: a plain stop that says the Apps are kept.
for (const [name, answers] of [['empty-purpose', ['', 'Users.']], ['empty-users', ['Purpose.', '  ']]]) {
  await stopThenRetry(name, {
    answers,
    reason: 'mission',
    before: [...appPages, FORGE_APPS_KEPT],
    message: 'Setup stopped because both mission questions need an answer: what the software is for and who uses it. Try setup again and answer both.'
  });
}

// MISSION.md in the project folder cannot be written, or cannot be read, after the Apps exist.
const missionFile = (projectsRoot, name) => join(projectsRoot, 'owner', name, 'MISSION.md');
for (const [name, mode] of [['unwritable-mission-file', 0o444], ['unreadable-mission-file', 0o000]]) {
  await stopThenRetry(name, {
    onPrompt: async ({ projectsRoot }) => chmod(missionFile(projectsRoot, name), mode),
    undo: async ({ projectsRoot }) => chmod(missionFile(projectsRoot, name), 0o644),
    reason: 'mission-file',
    before: [...appPages, FORGE_APPS_KEPT],
    message: 'Setup stopped because it could not save the project\'s mission in the MISSION.md file of the project folder on this server. Let setup read and write that file before trying setup again.'
  });
}

// A saved file that is there but damaged stops setup before it changes anything, with one plain message
// naming the file to delete. Deleting it, as the message says, lets setup run again without creating new Apps.
for (const [file, stopAt, damagedMessage] of [
  ['mission.json', 'final-check', repository => `Setup stopped because the Forge's saved settings for ${repository} on this server are damaged: its saved answers to the mission questions cannot be read. Delete the file projects/${repository}/mission.json in the Forge's private state folder before trying setup again, and setup asks those questions again.`],
  ['registration.json', undefined, repository => `Setup stopped because the Forge's saved settings for ${repository} on this server are damaged: its record of whether setup finished cannot be read. Delete the file projects/${repository}/registration.json in the Forge's private state folder before trying setup again.`]
]) {
  const repository = `owner/damaged-${file.replace('.json', '')}`;
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
  await writeFile(join(retryState, 'projects', repository, file), '{ damaged');
  const before = await readTree(retryState);
  project.reset();
  await assert.rejects(setupRepository(repository, project.options()),
    error => error instanceof ReportedSetupError && error.message === 'damaged-settings');
  assert.deepEqual(project.record.messages, ['Using Claude Code to set up the Forge.', damagedMessage(repository)]);
  for (const message of project.record.messages) {
    assert(!/JSON|position|line \d+ column|SyntaxError|Expected property|\bat \w/.test(message), message);
    assert(!message.includes(root), message);
  }
  assert.equal(project.record.begins, 0);
  assert.deepEqual(project.record.prompts, []);
  assert(!project.record.calls.some(call => call.command !== 'claude'), JSON.stringify(project.record.calls));
  assert.deepEqual(await readTree(retryState), before);
  // The owner deletes the named file, from the Forge's private state folder, and tries setup again.
  await rm(join(retryState, 'projects', ...damagedMessage(repository).match(/Delete the file projects\/(\S+) in/)[1].split('/')));
  project.reset();
  const result = await setupRepository(repository, project.options());
  assert.equal(result.completed, true);
  assert.match(project.record.messages.at(-1), new RegExp(`^Setup is complete for ${repository}\\.`));
  assert.equal(project.record.begins, 0);
  assert.deepEqual(project.record.prompts, file === 'mission.json' ? ['What is this software for?', 'Who uses it?'] : []);
  assert.equal(await project.missionSections(), 1);
}

// An empty saved file is nothing saved: setup carries on as if it were missing, without calling it damaged.
for (const [file, stopAt] of [['mission.json', 'final-check'], ['registration.json', undefined]]) {
  const repository = `owner/empty-${file.replace('.json', '')}`;
  const project = await retryProject(repository);
  if (stopAt) {
    await assert.rejects(setupRepository(repository, project.options({ failAt: stopAt })),
      error => error instanceof ReportedSetupError && error.message === stopAt);
  } else {
    assert.equal((await setupRepository(repository, project.options())).completed, true);
  }
  await writeFile(join(root, 'retry-state', 'projects', repository, file), '');
  project.reset();
  assert.equal((await setupRepository(repository, project.options())).completed, true);
  assert.match(project.record.messages.at(-1), new RegExp(`^Setup is complete for ${repository}\\.`));
  assert(!project.record.messages.some(message => message.includes('damaged')), JSON.stringify(project.record.messages));
  assert.equal(project.record.begins, 0);
  assert.deepEqual(project.record.prompts, file === 'mission.json' ? ['What is this software for?', 'Who uses it?'] : []);
  assert.equal(await project.missionSections(), 1);
}

// An App details file emptied after setup stopped at the final check, with both Apps installed: the rerun does
// what it does when that file is deleted. It stops with the missing-details sentence instead of ending in
// "Setup is complete", and after the owner deletes that App on GitHub the next run creates it again.
for (const kind of ['builder', 'release']) {
  const runs = [];
  for (const empty of [true, false]) {
    const repository = `owner/final-check-${empty ? 'empty' : 'deleted'}-${kind}-app`;
    const project = await retryProject(repository);
    await assert.rejects(setupRepository(repository, project.options({ failAt: 'final-check' })),
      error => error instanceof ReportedSetupError && error.message === 'final-check');
    const path = join(credentialPath(join(root, 'retry-state'), repository), `${kind}-app.json`);
    if (empty) await writeFile(path, ''); else await rm(path);
    project.reset();
    const rerun = await setupRepository(repository, project.options()).then(() => undefined, error => error);
    const [message, reason] = appGoneStops.missing(kind, repository);
    assert(rerun instanceof ReportedSetupError && rerun.message === reason, `${kind} ${empty}: ${rerun?.message}`);
    assert.equal(project.record.messages.at(-1), message);
    assert(!project.record.messages.some(line => line.startsWith('Setup is complete') || line.includes('damaged')),
      JSON.stringify(project.record.messages));
    assertNoInternalText(project.record.messages.at(-1), join(root, 'retry-state'));
    runs.push(project.record.messages.map(line => line.replaceAll(repository, 'REPOSITORY')));
    project.reset();
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

await gitInit(join(root, 'git-missing', 'owner', 'existing'));
await assert.rejects(
  prepareCheckout('owner/existing', join(root, 'git-missing'), { names: { git: join(root, 'no-such-git') }, run: runProcess },
    message => assert.fail(`a git that cannot start was reported as: ${message}`)),
  /^Error: Could not run /
);

await stopThenRetry('failing-preparation', {
  run: (command, args) => command === 'python3' && args.at(-1) === 'init'
    && Object.assign(new Error('python3 failed.'), { stderr: `Traceback (most recent call last):\nPermissionError: [Errno 13] Permission denied: '${root}/x'\n` }),
  reason: 'initialization',
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
    github: { begin: async manifest => ({ url: `https://example.test/${manifest.name}` }), callback: async () => 'code', exchange: async () => credentials, install: async () => true },
    prompt: async () => ['Purpose.', 'Users.'][healAnswer++],
    output: value => healed.push(value)
  });
  assert.equal(result.completed, true);
  assert.match(healed.at(-1), /^Setup is complete for owner\/healed-build-tools\./);
  assert(!healed.some(message => message.startsWith('Setup stopped')));
  assert.deepEqual(healCalls.filter(([command]) => command === 'git').map(([, step]) => step),
    ['fetch', 'clone', 'fetch', 'checkout', 'rev-parse']);
}
