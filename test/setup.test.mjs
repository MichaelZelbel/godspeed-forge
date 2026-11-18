import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportedSetupError, setupRepository, prepareCheckout, repositoryFromRemote } from '../lib/setup.mjs';
import { findSignedInAgent } from '../lib/agent.mjs';
import {
  APP_PERMISSIONS, APP_PERMISSION_DOCUMENTATION, builderManifest, createApps,
  registrationAction, releaseManifest
} from '../lib/github-apps.mjs';
import { createGithubAdapter } from '../lib/github-adapter.mjs';
import { run as runProcess } from '../lib/process.mjs';
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
    complete: async () => credentials,
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
    complete: async () => credentials,
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
const serializedProjectState = JSON.stringify({
  config: { projectsRoot, releaseCost: { message: 'Release cost.' } },
  paths: { state },
  projectState: await readTree(join(state, 'projects/owner/repo'))
});
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
    begin: async () => ({ url: 'https://example.test/create' }), complete: async () => credentials,
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
      complete: async () => credentials,
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
const SOURCE_DAMAGED = `${found} the copy of the build tools that setup downloaded to this server is incomplete or has been changed. Delete the folder ${buildToolsCache} on this server before trying setup again.`;
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
    github: { begin: async () => ({ url: 'https://example.test/create' }), complete: async () => credentials, install: async () => true },
    prompt: async () => ['Purpose.', 'Users.'][answer++],
    output: value => outputs.push(value)
  }), error => error instanceof ReportedSetupError && error.message === 'final-check', repository);
  assert.equal(outputs.at(-1), expected, report);
  for (const hidden of ['Factory refused', 'Holdout fence', 'consumer', 'Traceback', 'ghs_report_secret', 'report', 'Archon', 'Errno']) {
    assert(!outputs.at(-1).includes(hidden), `${hidden} in: ${outputs.at(-1)}`);
  }
}
assert.equal(new Set(refusalCases.map(([, expected]) => expected)).size, 10);

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
      complete: async () => credentials,
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
    complete: async () => ({ id: 12345, pem: 'PRIVATE KEY WITHOUT SLUG' }),
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
    complete: async () => ({ ...credentials, slug: 'release-slug' }),
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
      complete: async () => credentials,
      install: async () => true
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
  await writePrivateJson(join(legacyState, 'registration.json'), { repository: 'owner/legacy-set-up', checkout: 'unused', completed: true });
  await writePrivateJson(join(legacyState, 'builder-app.json'), credentials);
  await setupRepository('owner/legacy-set-up', project.options());
  assert.deepEqual(project.record.messages, ['The Forge is already set up for owner/legacy-set-up.']);
  await assert.rejects(stat(join(legacyState, 'builder-app.json')));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'retry-state/credentials/owner/legacy-set-up/builder-app.json'), 'utf8')), credentials);
}
