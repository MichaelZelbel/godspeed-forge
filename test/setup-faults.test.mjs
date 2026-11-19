// Makes every file operation, command, GitHub call, question and hold on the repository's setup that setup
// reaches fail, one at a time, from a set of starting states, and checks that setup then stops with one plain
// sentence and a non-zero exit, says which Apps are kept exactly when this server holds an App's details, and
// finishes on retry with one App per role. GitHub calls and commands also fail with plain errors that carry no
// code (as real network failures do), and GitHub calls and questions as if the input closed. Every place in lib/ that reads or writes a file, runs a command, calls GitHub, asks a question
// or takes that hold must be made to fail by some scenario here, so a new step that no scenario reaches fails
// this test.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { files } from '../lib/files.mjs';
import { InputClosed, setupCommand } from '../lib/setup.mjs';
import { defaults } from '../lib/config.mjs';
import { FACTORY_REVISION } from '../lib/constants.mjs';
import { testCase } from './cases.mjs';

Error.stackTraceLimit = 100;
const lib = fileURLToPath(new URL('../lib/', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'forge-faults-'));
const repository = 'owner/faults';
const paths = { state: join(root, 'state'), config: join(root, 'config.json') };
const projectsRoot = join(root, 'projects');
const projectState = join(paths.state, 'projects', repository);
const credentialFolder = join(paths.state, 'credentials', repository);
const buildToolsSource = join(root, 'build-tools', FACTORY_REVISION);
const KEPT_BOTH = 'Your two GitHub Apps for this repository, "Forge builder" and "Forge release", are already on your GitHub account and are kept there. Trying setup again uses them instead of creating new ones.';
const keptOne = name => `Your GitHub App "${name}" for this repository is already on your GitHub account and is kept there. Trying setup again uses it instead of creating a new one.`;
const credentialsFor = code => ({ id: 1, pem: 'PRIVATE KEY', slug: code });

// Every line in lib/ that calls one of the points this test makes fail.
const SEAM_CALL = /\bfiles\.\w+\(|\bcommands\.run\(|\brunCommand\(|\bgithub\.\w+(?:\?\.)?\(|\bprompt\(|\.listen\(/;
// Modules whose points setup never reaches in this test, and why.
const EXEMPT = {
  'files.mjs': 'the file operations themselves, which this test makes fail where setup calls them',
  'github-adapter.mjs': 'the real GitHub, which this test replaces with the stand-in whose every call it makes fail'
};
const sources = new Map();
for (const name of await readdir(lib)) {
  if (name.endsWith('.mjs')) sources.set(join(lib, name), await readFile(join(lib, name), 'utf8'));
}
for (const module of Object.keys(EXEMPT)) assert(sources.has(join(lib, module)), `lib/${module} no longer exists`);
const staticSites = [];
for (const [path, text] of sources) {
  const module = path.slice(lib.length);
  if (module in EXEMPT) continue;
  text.split('\n').forEach((line, index) => {
    if (!line.trim().startsWith('//') && SEAM_CALL.test(line)) staticSites.push(`${module}:${index + 1}`);
  });
}

// Functions that continue by design after the failure of a step inside them, and the one line that does.
const ABSORBED = ['pathExists', 'findSignedInAgent', 'stopIfDamaged', 'replaceMarkedDownload', 'discardPending', 'updatePending', 'prepareFactory'];
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
  if (module === 'files.mjs') continue;
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
    // What GitHub says about an App on a finished setup: still there while the owner has not deleted it.
    appStatus: async ({ kind }) => world.live[kind] > 0 ? 'installed' : 'app-missing'
  };
  return world;
}

function standInCommands(behaviour) {
  return async (command, args, options = {}) => {
    if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
    if (command === 'git' && args[0] === 'clone') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
    if (command === 'git' && args[0] === 'remote') return { stdout: `git@github.com:${repository}.git\n` };
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
    if (command === 'python3' && args.at(-1) === 'init') {
      await mkdir(join(options.cwd, 'factory'), { recursive: true });
      await mkdir(join(options.cwd, '.factory'), { recursive: true });
      await mkdir(buildToolsSource, { recursive: true });
      await writeFile(join(options.cwd, 'MISSION.md'), '# Mission\n');
      await writeFile(join(options.cwd, 'factory/consumer.py'), '# factory stand-in\n');
      await writeFile(join(options.cwd, '.factory/consumer.json'), JSON.stringify({ source: buildToolsSource }));
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
  let answer = 0;
  const watched = faults ? { events: [], faults, fired: [] } : null;
  const github = Object.fromEntries(Object.entries(world.github).map(([op, call]) => [op, point('github', op, call)]));
  current = watched;
  let code;
  try {
    code = await setupCommand(repository, {
      paths, github, output: line => output.push(line),
      commands: { run: point('command', 'run', standInCommands(behaviour)) },
      prompt: point('prompt', 'prompt', async () => ['Purpose.', 'Users.'][answer++ % 2])
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
  { name: 'abandoned page', finish: 'complete', behaviour: { noCallback: 'release' } }
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
// the run, saved or waiting in a pending record. Details setup was kept from reading when it looked for them
// at the stop (a fault fired there) count too: setup knows they are there, only not what they hold.
async function expectedKept(run) {
  const names = {};
  for (const kind of ['builder', 'release']) {
    const detailFiles = [join(credentialFolder, `${kind}-app.json`), join(projectState, `${kind}-app.json`)];
    const pendingFile = join(credentialFolder, `${kind}-app-pending.json`);
    const held = (await Promise.all(detailFiles.map(savedJson))).some(validDetails)
      || validDetails((await savedJson(pendingFile))?.credentials)
      || run.fired.some(index => {
        const event = run.events[index];
        return event.functions.includes('savedApps') && [...detailFiles, pendingFile].includes(event.path);
      });
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
      assert(absorbed(run.events[index]), `${label}: setup completed after a failure no step absorbs by design`);
    }
    return;
  }
  assert.equal(run.code, 1, `${label}: stopped with exit code ${run.code}`);
  assert.equal(stops.length, 1, `${label}: ${stops.length} stop lines: ${run.output.join(' | ')}`);
  assert(run.output.at(-1).startsWith(STOP), `${label}: the stop line is not the last line`);
  const kept = run.output.filter(line => / kept there\./.test(line));
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
