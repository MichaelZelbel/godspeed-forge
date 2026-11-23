// Makes every file operation, command, GitHub call, question and hold on the repository's setup that setup
// reaches fail, one at a time, from a set of starting states, and checks that setup then stops with one plain
// sentence and a non-zero exit, says which Apps are kept exactly when this server holds an App's details, and
// finishes on retry with one App per role. GitHub calls and commands also fail with plain errors that carry no
// code (as real network failures do), and GitHub calls and questions as if the input closed. Every place in lib/ that reads or writes a file, runs a command, calls GitHub, asks a question
// or takes that hold must be made to fail by some scenario here, so a new step that no scenario reaches fails
// this test.
// test cases: 20
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { files } from '../lib/files.mjs';
import { InputClosed, setupCommand } from '../lib/setup.mjs';
import { signIn, AGENT_QUESTION, CODE_QUESTION } from '../lib/signin.mjs';
import { createFactorySetup, CONFIRM_QUESTION, STRIKE_QUESTION } from '../lib/factory-setup.mjs';
import { defaults } from '../lib/config.mjs';
import { ARCHON_REVISION, FACTORY_REVISION } from '../lib/constants.mjs';
import { testCase } from './cases.mjs';

Error.stackTraceLimit = 100;
const lib = fileURLToPath(new URL('../lib/', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'forge-faults-'));
const repository = 'owner/faults';
const paths = { state: join(root, 'state'), config: join(root, 'config.json') };
const projectsRoot = join(root, 'projects');
const projectState = join(paths.state, 'projects', repository);
const credentialFolder = join(paths.state, 'credentials', repository);
const buildToolsSource = join(root, 'build-tools', ARCHON_REVISION);
const KEPT_BOTH = 'Setup kept the details of your two GitHub Apps for this repository, "Forge builder" and "Forge release", on this server. Trying setup again checks whether they are still on your GitHub account and uses each one that is, instead of creating a new one.';
const keptOne = name => `Setup kept the details of your GitHub App "${name}" for this repository on this server. Trying setup again checks whether it is still on your GitHub account and uses it if it is, instead of creating a new one.`;
const credentialsFor = code => ({ id: 1, pem: 'PRIVATE KEY', slug: code });

// Every line in lib/ that calls one of the points this test makes fail.
const SEAM_CALL = /\bfiles\.\w+\(|\bcommands\.run\(|\brunCommand\(|\bgithub\.\w+(?:\?\.)?\(|\bprompt\(|\.listen\(/;
// Modules whose points setup never reaches in this test, and why.
const EXEMPT = {
  'files.mjs': 'the file operations themselves, which this test makes fail where setup calls them',
  'github-adapter.mjs': 'the real GitHub, which this test replaces with the stand-in whose every call it makes fail',
  'factory-control.mjs': 'the chat\'s inbox handlers, which setup never calls; test/factory-control.test.mjs makes their commands and files fail'
};
// Modules in lib/ that setup does not use at all, and why. Neither check of this file applies to them, and the check
// below follows setup's imports from its entry points, so the day setup reaches one of them it is checked again.
const NOT_SETUP = {
  'godspeed.mjs': 'the bridge to Godspeed, used by the installer, the chat inbox and the driver steps, never by setup',
  'inbox.mjs': 'the chat inbox, which its own service runs, never setup'
};
const sources = new Map();
for (const name of await readdir(lib)) {
  if (name.endsWith('.mjs')) sources.set(join(lib, name), await readFile(join(lib, name), 'utf8'));
}
for (const module of [...Object.keys(EXEMPT), ...Object.keys(NOT_SETUP)]) assert(sources.has(join(lib, module)), `lib/${module} no longer exists`);
{
  const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"]\.\/([\w.-]+\.mjs)['"]/gm;
  const seen = new Set();
  const queue = ['cli.mjs', 'setup.mjs', 'github-adapter.mjs'];
  while (queue.length) {
    const module = queue.pop();
    if (seen.has(module)) continue;
    seen.add(module);
    for (const match of (sources.get(join(lib, module)) ?? '').matchAll(IMPORT)) queue.push(match[1]);
  }
  assert(['files.mjs', 'config.mjs', 'github-apps.mjs', 'agent.mjs', 'process.mjs'].every(module => seen.has(module)), `the walk follows setup's imports (reached ${[...seen].join(', ')})`);
  for (const module of Object.keys(NOT_SETUP)) assert(!seen.has(module), `setup now uses lib/${module}, so this test must make its steps fail too`);
}
const staticSites = [];
for (const [path, text] of sources) {
  const module = path.slice(lib.length);
  if (module in EXEMPT || module in NOT_SETUP) continue;
  text.split('\n').forEach((line, index) => {
    if (!line.trim().startsWith('//') && SEAM_CALL.test(line)) staticSites.push(`${module}:${index + 1}`);
  });
}

// Functions that continue by design after the failure of a step inside them, and the one line that does.
// finishedProjectWorks (#74): a finished setup whose mission or final check cannot be confirmed is set up again.
// removeStaleTemporaries and discardTemporary (#100): the sweep for left-behind temporaries and the removal of
// one are best effort; junk that cannot be removed must never stop a setup.
// letGitUseGh: git's use of gh's sign-in is set up best effort; a push that then fails says so itself.
// identity and defaultBranch: who a commit is by and which branch is the default each have a second source.
const ABSORBED = ['pathExists', 'findSignedInAgent', 'stopIfDamaged', 'replaceMarkedDownload', 'discardPending', 'updatePending', 'prepareFactory', 'finishedProjectWorks', 'removeStaleTemporaries', 'discardTemporary', 'letGitUseGh', 'identity', 'defaultBranch'];
const ABSORBED_SITES = [siteOf('setup.mjs', ".then(entry => entry.isDirectory(), () => false)")];

function siteOf(module, text) {
  const lines = sources.get(join(lib, module)).split('\n');
  const index = lines.findIndex(line => line.includes(text));
  assert(index >= 0, `${module} no longer contains ${text}`);
  return `${module}:${index + 1}`;
}

// A file operation outside the seam could not be made to fail here.
for (const [path, text] of sources) {
  const module = path.slice(lib.length);
  if (module === 'files.mjs' || module in NOT_SETUP) continue;
  assert(!text.includes("from 'node:fs"), `${module} uses the file system without lib/files.mjs, so this test cannot make that step fail`);
}

// Where a point was called from: the first frame in lib/ outside files.mjs, and every lib/ function on the
// stack, awaiting callers included.
function callerOf(stack) {
  const frames = [];
  for (const line of stack.split('\n').slice(1)) {
    const match = line.match(/^\s*at (?:async )?(?:(\S+) \()?(?:file:\/\/)?([^()\s]+):(\d+):\d+\)?$/);
    if (!match || !match[2].startsWith(lib)) continue;
    frames.push({ name: match[1]?.split('.').at(-1), module: match[2].slice(lib.length), line: Number(match[3]) });
  }
  const first = frames.find(frame => frame.module !== 'files.mjs');
  return { site: first ? `${first.module}:${first.line}` : 'outside lib', functions: frames.map(frame => frame.name).filter(Boolean) };
}

// A failure with no code, as fetch and other network calls raise, whose message must not reach the owner.
const plainError = () => new TypeError('fetch failed');

const SYSCALLS = { readFile: 'open', writeFile: 'open', open: 'open', access: 'access' };
function rawError(op) {
  const syscall = SYSCALLS[op] ?? op;
  return Object.assign(new Error(`EACCES: permission denied, ${syscall} '${root}/x'`), {
    code: 'EACCES', errno: -13, syscall, path: `${root}/x`,
    stderr: `GraphQL: failed (${root}/x)\n    at run (${root}/lib.js:1:1)`, stdout: ''
  });
}

// The run being watched: every point call is recorded, and the calls named in faults fail instead of running.
let current = null;
function watch(kind, op, args = []) {
  if (!current) return undefined;
  const index = current.events.length;
  current.events.push({ kind, op, path: kind === 'file' ? String(args[0]) : undefined, ...callerOf(new Error().stack) });
  const fault = current.faults.get(index);
  if (fault) current.fired.push(index);
  return fault;
}
function point(kind, op, call) {
  return (...args) => {
    const fault = watch(kind, op, args);
    if (!fault) return call(...args);
    if (fault === 'closed') return Promise.reject(new InputClosed());
    return Promise.reject(fault === 'plain' ? plainError() : rawError(op));
  };
}
for (const op of Object.keys(files)) files[op] = point('file', op, files[op]);
// A sign-in a command starts: on a fault it ends at once with a failure and shows nothing.
function startPoint(call) {
  return (...args) => {
    if (!watch('start', 'start', args)) return call(...args);
    const output = '';
    return { watch: watcher => { watcher(output); return () => {}; }, write: () => {}, stop: () => {}, done: Promise.resolve({ code: 1, started: true, output }) };
  };
}
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (!watch('lock', 'listen')) return listen.apply(this, args);
  process.nextTick(() => this.emit('error', rawError('listen')));
  return this;
};

function standInGithub() {
  const world = { counts: { builder: 0, release: 0 }, live: { builder: 0, release: 0 }, usedCodes: new Set(), noCallback: null };
  let creating;
  world.github = {
    exists: async path => access(path).then(() => true, () => false),
    begin: async manifest => {
      creating = manifest.name === 'Forge builder' ? 'builder' : 'release';
      world.counts[creating] += 1;
      return { url: `https://example.test/${manifest.name}` };
    },
    callback: async () => creating === world.noCallback ? null : `code-${creating}-${world.counts[creating]}`,
    exchange: async code => {
      if (world.usedCodes.has(code)) throw Object.assign(new Error('GitHub refused the App code.'), { refused: true });
      world.usedCodes.add(code);
      world.live[code.split('-')[1]] += 1;
      return credentialsFor(code);
    },
    install: async () => true,
    // Whether an App on setup's list is still on GitHub: there while the owner has not deleted its role's App.
    appExists: async ({ slug }) => world.live[slug.match(/builder|release/)[0]] > 0,
    // What GitHub says about an App on a finished setup: still there while the owner has not deleted it.
    appStatus: async ({ kind }) => world.live[kind] > 0 ? 'installed' : 'app-missing'
  };
  return world;
}

// The stand-in sign-ins: gh's prints its code and is approved at once, Claude Code's waits for the pasted code.
function standInStart(world) {
  return (command, args) => {
    let output = '';
    let ended = false;
    let resolveDone;
    const watchers = new Set();
    const done = new Promise(resolve => { resolveDone = resolve; });
    const say = text => { output += text; for (const watcher of watchers) watcher(output); };
    const end = code => { if (!ended) { ended = true; resolveDone({ code, started: true, output }); } };
    queueMicrotask(() => {
      if (command === 'gh' && args[0] === 'auth') {
        say('! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n');
        world.githubSignedIn = true;
        end(0);
      } else if (command === 'claude') {
        say('Opening browser to sign in\nIf the browser did not open, visit:\nhttps://claude.ai/oauth/authorize?code=true\nPaste code here if prompted > ');
      } else end(1);
    });
    return {
      watch: watcher => { watchers.add(watcher); watcher(output); return () => watchers.delete(watcher); },
      write: text => { if (command === 'claude' && text.trim()) { world.agentSignedIn = true; end(0); } },
      stop: () => end(null),
      done
    };
  };
}

// The stand-in coding assistant's answer: seven proposals, two journeys and the checks.
async function assistantWrites(cwd, behaviour = {}) {
  if (behaviour.overreach) {
    await writeFile(join(cwd, 'harness/extra.md'), 'not the assistant\'s to write\n');
    await writeFile(join(cwd, 'factory/consumer.py'), '# changed by the assistant\n');
  }
  await writeFile(join(cwd, '.forge-out-of-scope.json'), JSON.stringify(['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.', 'Seven.']));
  await writeFile(join(cwd, 'harness/END-TO-END.md'), '# End-to-end journeys\n\n## A person signs in\n\n1. Open it.\n\n## A person signs out\n\n1. Close it.\n');
  await writeFile(join(cwd, 'harness/harness.config.json'), JSON.stringify({ static: '', unit: 'npm test', required_checks: behaviour.checksLeftEmpty ? '' : 'none', protected_paths: 'changed' }));
}

function standInCommands(behaviour, world = {}) {
  const refused = text => Object.assign(new Error('gh failed.'), { stderr: text, stdout: '' });
  return async (command, args, options = {}) => {
    if (command === 'gh' && args[0] === 'repo' && args[1] === 'clone') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
    if (command === 'gh' && args[0] === 'api' && args[1] === '-i') {
      if (behaviour.signedOut && !world.githubSignedIn) throw refused('To get started with GitHub CLI, please run:  gh auth login\n');
      return { stdout: 'HTTP/2.0 200 OK\nX-Oauth-Scopes: repo, workflow\n\n{}' };
    }
    if (command === 'gh' && args[0] === 'api' && args[1] === 'user') return { stdout: 'octo 42\n' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') { world.pullRequests = (world.pullRequests ?? 0) + 1; return { stdout: `https://github.com/${repository}/pull/${world.pullRequests}\n` }; }
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') return { stdout: '' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return { stdout: world.merged ? 'MERGED\n' : 'OPEN\n' };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
      if (args.includes('--auto')) return { stdout: '' };
      world.mergeTries = (world.mergeTries ?? 0) + 1;
      if (world.mergeTries === 1) throw refused('Base branch policy prohibits the merge\n');
      world.merged = true;
      return { stdout: '' };
    }
    if (command === 'gh') return { stdout: '' };
    if ((command === 'claude' || command === 'codex') && args.includes('status') && behaviour.signedOut && !world.agentSignedIn) throw refused('Not logged in\n');
    if (command === 'claude' && args[0] === '-p') { await assistantWrites(options.cwd, behaviour); return { stdout: '' }; }
    if (command === 'git' && args[0] === 'symbolic-ref') return { stdout: 'origin/main\n' };
    if (command === 'git' && args[0] === 'config') throw refused('');
    if (command === 'git' && args[0] === 'diff') return { stdout: world.committed ? '' : 'MISSION.md\n' };
    if (command === 'git' && args[0] === 'commit') { world.committed = true; return { stdout: '' }; }
    if (command === 'git' && args[0] === 'push' && behaviour.protected && args.at(-1).endsWith('/main')) {
      throw refused('remote: error: GH006: Protected branch update failed for refs/heads/main.\n');
    }
    if (command === 'git' && args[0] === 'clone') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
    if (command === 'git' && args[0] === 'remote') return { stdout: `git@github.com:${repository}.git\n` };
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
    if (command === 'python3' && args[1] === 'init') {
      await mkdir(join(options.cwd, 'factory'), { recursive: true });
      await mkdir(join(options.cwd, '.factory'), { recursive: true });
      await mkdir(buildToolsSource, { recursive: true });
      await mkdir(join(options.cwd, 'harness'), { recursive: true });
      await writeFile(join(options.cwd, 'MISSION.md'), '# Mission\n\n## Out of scope -- the factory must never build this\n\n<!-- the guidance -->\n\n**<Category>**\n- <thing>\n\n## Hard invariants\n');
      await writeFile(join(options.cwd, 'factory/consumer.py'), '# factory stand-in\n');
      await writeFile(join(options.cwd, '.factory/consumer.json'), JSON.stringify({ source: buildToolsSource }));
      await writeFile(join(options.cwd, 'harness/END-TO-END.md'), '# Runtime scenarios\n\nExample task-service data.\n');
      await writeFile(join(options.cwd, 'harness/harness.config.json'), JSON.stringify({ static: '', unit: '', required_checks: '', protected_paths: 'MISSION.md,harness/**' }));
    }
    if (command === 'python3' && args.at(-1) === 'doctor') {
      if (behaviour.doctor === 'fail') throw Object.assign(new Error('python3 failed.'), { stderr: 'doctor failed\n' });
      if (behaviour.doctor === 'refuse') throw Object.assign(new Error('python3 failed.'), { stderr: 'Factory refused: Source SHA mismatch\n' });
    }
    return { stdout: '' };
  };
}

// One run of `godspeed-forge setup`, watched when faults is given.
async function setup(world, { behaviour = {}, faults } = {}) {
  await writeFile(paths.config, JSON.stringify({ ...defaults(root), projectsRoot }));
  world.noCallback = behaviour.noCallback ?? null;
  const output = [];
  const watched = faults ? { events: [], faults, fired: [] } : null;
  const github = Object.fromEntries(Object.entries(world.github).map(([op, call]) => [op, point('github', op, call)]));
  const answers = { 'What is this software for?': 'Purpose.', 'Who uses it?': 'Users.', [AGENT_QUESTION]: 'claude', [CODE_QUESTION]: 'the code', [STRIKE_QUESTION]: '2 5', [CONFIRM_QUESTION(repository)]: 'yes' };
  const start = startPoint(standInStart(world));
  current = watched;
  let code;
  try {
    code = await setupCommand(repository, {
      paths, github, output: line => output.push(line),
      commands: { run: point('command', 'run', standInCommands(behaviour, world)) },
      prompt: point('prompt', 'prompt', async question => answers[question]),
      signIn: context => signIn({ ...context, start }),
      factorySetup: createFactorySetup({ home: join(root, 'home') })
    });
  } finally {
    current = null;
  }
  return { code, output, ...watched };
}

const writeJson = async (path, value) => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
};

// Starting states, each prepared from nothing before every run, and what the run under test does differently.
const SCENARIOS = [
  { name: 'fresh', finish: 'complete' },
  { name: 'resumed', finish: 'complete', arrange: world => setup(world, { behaviour: { doctor: 'fail' } }) },
  { name: 'already set up', finish: 'already', arrange: world => setup(world) },
  { name: 'legacy set up', finish: 'already', arrange: async world => {
    await setup(world);
    await files.rename(join(credentialFolder, 'builder-app.json'), join(projectState, 'builder-app.json'));
  } },
  { name: 'legacy duplicate', finish: 'complete', arrange: async world => {
    await writeJson(join(credentialFolder, 'builder-app.json'), credentialsFor('stored-builder'));
    await writeJson(join(projectState, 'builder-app.json'), credentialsFor('stored-builder'));
    await writeJson(join(projectState, 'builder-installation.json'), { repository, confirmed: true });
    world.live.builder = 1;
  } },
  { name: 'keys waiting', finish: 'complete', arrange: async world => {
    await writeJson(join(credentialFolder, 'builder-app-pending.json'), { code: 'code-builder-0', credentials: credentialsFor('code-builder-0') });
    world.usedCodes.add('code-builder-0');
    world.live.builder = 1;
  } },
  { name: 'code waiting', finish: 'complete', arrange: async world => {
    await writeJson(join(credentialFolder, 'builder-app-pending.json'), { code: 'code-builder-0' });
  } },
  { name: 'spent code', finish: 'complete', arrange: async world => {
    await writeJson(join(credentialFolder, 'builder-app-pending.json'), { code: 'code-builder-0' });
    world.usedCodes.add('code-builder-0');
    world.live.builder = 1;
  } },
  { name: 'refused doctor', finish: 'complete', behaviour: { doctor: 'refuse' } },
  { name: 'marked download', finish: 'complete', arrange: world => setup(world, { behaviour: { doctor: 'refuse' } }) },
  { name: 'damaged App on finished setup', finish: 'complete', arrange: async world => {
    await setup(world);
    await writeJson(join(credentialFolder, 'release-app.json'), '{"id": 1, "pem": "PRIV');
  } },
  { name: 'abandoned page', finish: 'complete', behaviour: { noCallback: 'release' } },
  { name: 'App details lost', finish: 'complete', arrange: async world => {
    await setup(world);
    await rm(join(credentialFolder, 'builder-app.json'));
    await rm(join(projectState, 'builder-installation.json'));
    await rm(join(projectState, 'registration.json'));
  } },
  // #80: an empty saved answers file, found after the Apps exist, and recovered from the project's mission.
  { name: 'empty mission answers', finish: 'complete', arrange: async world => {
    await setup(world, { behaviour: { doctor: 'fail' } });
    await writeJson(join(projectState, 'mission.json'), '');
  } },
  // Neither GitHub nor a coding assistant signed in: setup runs both sign-ins.
  { name: 'signed out', finish: 'complete', behaviour: { signedOut: true } },
  // The default branch takes changes only through a pull request, whose first merge GitHub holds for its checks.
  { name: 'protected branch', finish: 'complete', behaviour: { protected: true } },
  // The coding assistant also changes a file of the factory and adds one to the checks' folder: both are put back.
  { name: 'assistant overreaches', finish: 'complete', behaviour: { overreach: true } },
  // The coding assistant names no CI checks for a project that has no CI workflows: none are required.
  { name: 'no checks named', finish: 'complete', behaviour: { checksLeftEmpty: true } },
  // #100: a temporary a stopped earlier run left beside its saves; the own pid with no save in flight is
  // stale by rule, so the run's sweep looks the folder up and removes the entry.
  { name: 'leftover temporary', finish: 'complete', arrange: async world => {
    await setup(world, { behaviour: { doctor: 'fail' } });
    await writeJson(join(credentialFolder, `builder-app.json.${process.pid}.tmp`), '{"id": 1');
  } }
];

async function prepare(scenario) {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const world = standInGithub();
  await scenario.arrange?.(world);
  return world;
}

const STOP = 'Setup stopped because';
const RAW = /Errno|EACCES|ENOENT|GraphQL|SyntaxError|fetch failed|^\s*at |\bat \S+ \(/m;
const ABSOLUTE_PATH = /(?:^|\s)\/(?:[\w.-]+\/)+/;
const finished = { complete: `Setup is complete for ${repository}.`, already: `The Forge is already set up for ${repository}.` };
const absorbed = event => event.functions.some(name => ABSORBED.includes(name)) || ABSORBED_SITES.includes(event.site);

const validDetails = value => Boolean(value && typeof value === 'object' && value.id && value.pem
  && typeof value.slug === 'string' && value.slug.trim());
async function savedJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

// The kept-Apps line a stop must print, or null: it names every App whose details this server holds after
// the run, saved or waiting in a pending record. Details files setup was kept from reading when it looked for
// them at the stop (a fault fired there) count too: one is written only once GitHub made its App. A pending
// record setup was kept from reading there does not: it may hold no App yet, so its keys are not held.
async function expectedKept(run) {
  const names = {};
  const failedAtStop = path => run.fired.some(index => {
    const event = run.events[index];
    return event.functions.includes('savedApps') && event.path === path;
  });
  for (const kind of ['builder', 'release']) {
    const detailFiles = [join(credentialFolder, `${kind}-app.json`), join(projectState, `${kind}-app.json`)];
    const pendingFile = join(credentialFolder, `${kind}-app-pending.json`);
    const held = (await Promise.all(detailFiles.map(savedJson))).some(validDetails)
      || detailFiles.some(failedAtStop)
      || (!failedAtStop(pendingFile) && validDetails((await savedJson(pendingFile))?.credentials));
    if (held) names[kind] = kind === 'builder' ? 'Forge builder' : 'Forge release';
  }
  if (names.builder && names.release) return KEPT_BOTH;
  return names.builder || names.release ? keptOne(names.builder ?? names.release) : null;
}

async function checkRun(label, run) {
  assert.deepEqual(run.fired, [...run.faults.keys()], `${label}: a fault was not reached`);
  for (const line of run.output) {
    assert(!RAW.test(line), `${label}: raw error text reached the owner: ${line}`);
    assert(!line.includes(root), `${label}: a path on this server reached the owner: ${line}`);
    assert(!ABSOLUTE_PATH.test(line), `${label}: a path reached the owner: ${line}`);
  }
  const stops = run.output.filter(line => line.startsWith(STOP));
  if (run.code === 0) {
    assert.equal(stops.length, 0, `${label}: completed with a stop line`);
    const last = run.output.at(-1);
    assert(last.startsWith(finished.complete) || last === finished.already, `${label}: completed without saying so: ${last}`);
    for (const index of run.faults.keys()) {
      const event = run.events[index];
      assert(absorbed(event), `${label}: setup completed after a failure no step absorbs by design`);
      // A finished setup that cannot be confirmed is set up again, so it must not be called already set up.
      if (event.functions.includes('finishedProjectWorks')) {
        assert(last.startsWith(finished.complete), `${label}: a finished setup that could not be confirmed was not set up again: ${last}`);
      }
    }
    return;
  }
  assert.equal(run.code, 1, `${label}: stopped with exit code ${run.code}`);
  assert.equal(stops.length, 1, `${label}: ${stops.length} stop lines: ${run.output.join(' | ')}`);
  assert(run.output.at(-1).startsWith(STOP), `${label}: the stop line is not the last line`);
  const kept = run.output.filter(line => /^Setup kept the details of your /.test(line));
  const expected = await expectedKept(run);
  assert.deepEqual(kept, expected ? [expected] : [], `${label}: wrong kept-Apps line: ${run.output.join(' | ')}`);
  if (expected) assert.equal(run.output.at(-2), expected, `${label}: the kept-Apps line is not just before the stop`);
}

// Retrying, doing what each stop says about deleting an App, finishes setup with one App per role.
async function checkRetry(label, scenario, world, run) {
  let last = run;
  for (let attempt = 0; last.code !== 0 && attempt < 3; attempt += 1) {
    const stop = last.output.at(-1);
    const kind = /delete/i.test(stop) ? stop.match(/\b(builder|release) App\b/)?.[1] : undefined;
    if (kind && world.live[kind] > 0) world.live[kind] -= 1;
    last = await setup(world);
  }
  assert.equal(last.code, 0, `${label}: retrying did not finish setup: ${last.output.join(' | ')}`);
  if (run.code !== 0) {
    const expected = finished[scenario.finish];
    assert(last.output.at(-1).startsWith(expected), `${label}: retry ended with ${last.output.at(-1)}`);
  }
  assert.deepEqual(world.live, { builder: 1, release: 1 }, `${label}: retrying left the wrong Apps on GitHub`);
}

async function faultRun(scenario, faults) {
  const world = await prepare(scenario);
  const run = await setup(world, { behaviour: scenario.behaviour, faults });
  const label = `${scenario.name}, failing ${[...faults].map(([index, variant]) => {
    const event = run.events[index];
    return `${event ? `${event.kind} ${event.op} at ${event.site}` : `call ${index}`} (${variant})`;
  }).join(' then ')}`;
  await checkRun(label, run);
  await checkRetry(label, scenario, world, run);
  return { run, faults };
}

const injected = new Set();
const depthOne = [];
for (const scenario of SCENARIOS) {
  testCase(`every single failure, starting from: ${scenario.name}`);
  const baseline = await setup(await prepare(scenario), { behaviour: scenario.behaviour, faults: new Map() });
  for (const [index, event] of baseline.events.entries()) {
    const variants = event.kind === 'github' ? ['raw', 'plain', 'closed']
      : event.kind === 'prompt' ? ['raw', 'closed'] : event.kind === 'command' ? ['raw', 'plain'] : ['raw'];
    for (const variant of variants) {
      const result = await faultRun(scenario, new Map([[index, variant]]));
      injected.add(event.site);
      depthOne.push({ scenario, index, variant, events: result.run.events });
    }
  }
}

// Steps reached only after an earlier failure: fail them too, after that first failure.
testCase('steps reached only after an earlier failure, and every step reached by some failure');
for (const site of staticSites.filter(site => !injected.has(site))) {
  const found = depthOne.find(run => run.events.slice(run.index + 1).some(event => event.site === site));
  if (!found) continue;
  const second = found.events.findIndex((event, index) => index > found.index && event.site === site);
  await faultRun(found.scenario, new Map([[found.index, found.variant], [second, 'raw']]));
  injected.add(site);
}

const missing = staticSites.filter(site => !injected.has(site));
assert.deepEqual(missing, [], `setup has a step no fault scenario reaches: ${missing.join(', ')}; add a scenario that reaches it`);
console.log(`${depthOne.length} single failures and ${staticSites.length} points checked`);
await rm(root, { recursive: true, force: true });
