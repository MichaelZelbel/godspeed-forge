// One rule for every file setup saves on this server, and the project's MISSION.md (#96): setup reads each of
// them before it shows any GitHub page or asks any question; it never changes one it cannot read unless the owner
// asked it to start that file afresh; it goes on when it can recover what the file held, and otherwise stops with
// one plain sentence whose action leads to a complete setup.
// Each case starts setup from nothing to one point (connecting the builder App, at the first mission question,
// at a refused final check, or finished), makes one saved file there unreadable in one way, and runs setup
// with an owner who does what each stop asks, with stand-ins for GitHub and every command. Cases run 16 at a
// time, each in its own folders.
// test cases: 12
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputClosed, setupCommand } from '../lib/setup.mjs';
import { defaults } from '../lib/config.mjs';
import { FACTORY_REVISION } from '../lib/constants.mjs';
import { afreshPart } from './afresh.mjs';
import { testCase } from './cases.mjs';

const root = await mkdtemp(join(tmpdir(), 'forge-unreadable-'));
// Settings started afresh hold the defaults, which put the projects folder in the home folder: here, root.
process.env.HOME = root;
const projectsRoot = join(root, 'projects');
const CONCURRENT = 16;
const KINDS = ['builder', 'release'];
const STOP = 'Setup stopped because';
const RAW = /Errno|EACCES|ENOENT|EISDIR|ELOOP|SyntaxError|JSON|\.json|\.md\b|^\s*at |\bat \S+ \(/m;
const ABSOLUTE_PATH = /(?:^|\s)\/(?:[\w.-]+\/)+/;

// GitHub as setup sees it: the Apps each role has, by slug.
function standInGithub() {
  const world = { apps: { builder: new Set(), release: new Set() }, names: new Map(), uninstalled: new Set(), pages: 0, installs: 0, made: 0, failCallback: false };
  let creating;
  const listed = slug => KINDS.some(kind => world.apps[kind].has(slug));
  world.github = {
    begin: async manifest => {
      world.pages += 1;
      creating = manifest.name === 'Forge builder' ? 'builder' : 'release';
      return { url: `https://example.test/${creating}` };
    },
    callback: async () => {
      if (world.failCallback) throw new Error('the address never came back');
      return `code-${creating}-${world.made + 1}`;
    },
    exchange: async code => {
      const kind = code.split('-')[1];
      world.made += 1;
      const app = { id: world.made, slug: `unreadable-${kind}-${world.made}`, pem: 'PRIVATE KEY', name: `Forge ${kind} ${world.made}` };
      world.apps[kind].add(app.slug);
      world.names.set(app.name, { kind, slug: app.slug });
      return app;
    },
    install: async () => { world.installs += 1; return true; },
    appExists: async ({ slug }) => listed(slug),
    appStatus: async ({ credentials, kind }) => {
      if (!listed(credentials?.slug)) return 'app-missing';
      return world.uninstalled.has(kind) ? 'not-installed' : 'installed';
    }
  };
  return world;
}

// The owner deletes the Apps a stop names in quotes, or else every App of each role it names.
function deleteNamed(stop, world) {
  const named = [...stop.matchAll(/"([^"]+)"/g)].map(([, name]) => world.names.get(name)).filter(Boolean);
  if (named.length) for (const { kind, slug } of named) world.apps[kind].delete(slug);
  else for (const kind of KINDS) if (new RegExp(`\\b${kind}\\b`).test(stop)) world.apps[kind].clear();
}

function project(name) {
  const folder = join(root, name);
  const repository = `owner/${name}`;
  const state = join(folder, 'state');
  const checkout = join(projectsRoot, repository);
  const projectState = join(state, 'projects', repository);
  const credentials = join(state, 'credentials', repository);
  return {
    name, folder, repository, state, checkout, config: join(folder, 'config.json'), world: standInGithub(),
    buildTools: join(folder, 'build-tools', FACTORY_REVISION),
    files: {
      settings: join(folder, 'config.json'),
      'mission file': join(checkout, 'MISSION.md'),
      'App list': join(checkout, '.git/godspeed-forge-apps.json'),
      'builder details': join(credentials, 'builder-app.json'),
      'release details in the earlier place': join(projectState, 'release-app.json'),
      'builder connection': join(credentials, 'builder-app-pending.json'),
      'builder install record': join(projectState, 'builder-installation.json'),
      'release install record': join(projectState, 'release-installation.json'),
      'mission answers': join(projectState, 'mission.json'),
      'download marker': join(projectState, 'replace-build-tools.json'),
      'finished record': join(projectState, 'registration.json')
    },
    credentials, projectState
  };
}

// The part of setup's state the owner's "start ... afresh" names for each file.
const AFRESH = {
  settings: ['settings'],
  'mission file': ['mission'],
  'App list': ['app-list'],
  'builder details': ['builder-app', 'both-apps'],
  'release details in the earlier place': ['release-app', 'both-apps'],
  'builder connection': ['builder-connection']
};

// One run of `godspeed-forge setup`. at: 'connecting' fails the builder App's address, 'question' closes the
// input at the first question, 'final check' has the final check refuse the downloaded build tools.
async function setup(p, { at, startAfresh } = {}) {
  const output = [];
  let answer = 0;
  const pagesBefore = p.world.pages;
  p.world.failCallback = at === 'connecting';
  const run = async (command, args, options = {}) => {
    if (command === 'claude') return { stdout: 'signed in' };
    if (command === 'gh' || (command === 'git' && args[0] === 'clone')) {
      await mkdir(join(args.at(-1), '.git'), { recursive: true });
      return { stdout: '' };
    }
    if (command === 'git' && args[0] === 'remote') return { stdout: `https://github.com/${p.repository}.git\n` };
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
    if (command === 'python3' && args.at(-1) === 'init') {
      await mkdir(join(options.cwd, 'factory'), { recursive: true });
      await mkdir(join(options.cwd, '.factory'), { recursive: true });
      await mkdir(p.buildTools, { recursive: true });
      await writeFile(join(options.cwd, 'MISSION.md'), '# Mission\n', { flag: 'wx' }).catch(() => {});
      await writeFile(join(options.cwd, 'factory/consumer.py'), '# factory stand-in\n');
      await writeFile(join(options.cwd, '.factory/consumer.json'), JSON.stringify({ source: p.buildTools }));
    }
    if (command === 'python3' && args.at(-1) === 'doctor' && at === 'final check') {
      throw Object.assign(new Error('python3 failed.'), { stderr: 'Factory refused: Source SHA mismatch\n' });
    }
    return { stdout: '' };
  };
  const code = await setupCommand(p.repository, {
    paths: { state: p.state, config: p.config }, commands: { run }, github: p.world.github, startAfresh,
    output: line => output.push(line),
    prompt: async () => {
      if (at === 'question') throw new InputClosed();
      return ['Purpose.', 'Users.'][answer++ % 2];
    }
  });
  return { code, output, pages: p.world.pages - pagesBefore };
}

// Points in setup, each reached from nothing.
const POINTS = {
  connecting: p => setup(p, { at: 'connecting' }),
  question: p => setup(p, { at: 'question' }),
  'final check': p => setup(p, { at: 'final check' }),
  finished: p => setup(p),
  'finished with keys waiting': async p => {
    await setup(p);
    const details = await readFile(p.files['builder details'], 'utf8');
    await writeFile(p.files['builder connection'], JSON.stringify({ code: 'spent', credentials: JSON.parse(details) }), { mode: 0o600 });
  }
};
// The files each point leaves.
const AT = {
  connecting: ['settings', 'mission file', 'builder connection'],
  question: ['settings', 'mission file', 'App list', 'builder details', 'release details in the earlier place', 'builder install record', 'release install record'],
  'final check': ['settings', 'mission file', 'App list', 'builder details', 'release details in the earlier place', 'builder install record', 'release install record', 'mission answers', 'download marker'],
  finished: ['settings', 'mission file', 'App list', 'builder details', 'release details in the earlier place', 'builder install record', 'release install record', 'mission answers', 'finished record'],
  'finished with keys waiting': ['settings', 'builder connection']
};

// Ways a file cannot be read. Text files (the mission file) cannot be damaged JSON.
const UNREADABLE = {
  empty: path => writeFile(path, ''),
  damaged: path => writeFile(path, '{"id": 1, "pem": "PRIV'),
  'a list': path => writeFile(path, '[]'),
  null: path => writeFile(path, 'null'),
  'a link to nothing': async path => { await rm(path); await symlink(`${path}.gone`, path); },
  'a folder': async path => { await rm(path); await mkdir(path); },
  'not readable': path => chmod(path, 0o000)
};
const TEXT_KINDS = ['empty', 'a link to nothing', 'a folder', 'not readable'];

async function fingerprint(path) {
  const entry = await lstat(path).catch(() => null);
  if (!entry) return 'missing';
  const type = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'folder' : 'file';
  const link = type === 'link' ? await readlink(path) : null;
  const bytes = type === 'file' && entry.mode & 0o400 ? (await readFile(path)).toString('base64') : null;
  return JSON.stringify({ type, link, bytes, mode: entry.mode, size: entry.size, mtime: entry.mtimeMs });
}

function checkLines(label, run) {
  const problems = [];
  for (const line of run.output) {
    if (line.includes(root) || ABSOLUTE_PATH.test(line)) problems.push(`${label}: a path reached the owner: ${line}`);
    if (RAW.test(line)) problems.push(`${label}: raw error text or a file name reached the owner: ${line}`);
  }
  const stops = run.output.filter(line => line.startsWith(STOP));
  const last = run.output.at(-1) ?? '';
  if (run.code === 0 ? stops.length || !last.startsWith('Setup is complete for ') : stops.length !== 1 || !last.startsWith(STOP)) {
    problems.push(`${label}: not one stop sentence at the end, or a finish: ${run.output.join(' | ')}`);
  }
  if (run.output.some(line => line.includes('already set up'))) problems.push(`${label}: said already set up`);
  return problems;
}

// The problems of one case: none when it passes. prepare, when given, changes the arranged state further.
async function unreadableCase({ name, point, file, kind, prepare }) {
  const p = project(name);
  await mkdir(p.folder, { recursive: true });
  await writeFile(p.config, JSON.stringify(defaults(root)));
  await POINTS[point](p);
  if (file === 'release details in the earlier place') {
    await rename(join(p.credentials, 'release-app.json'), p.files[file]);
  }
  const path = p.files[file];
  await UNREADABLE[kind](path);
  await prepare?.(p);
  const label = `${file} ${kind} at ${point}`;
  const before = await fingerprint(path);
  const problems = [];
  let replaced = false;
  let run = await setup(p);
  const runs = [run];
  if (run.pages > 0) problems.push(`${label}: a GitHub page was shown before setup recovered or stopped`);
  for (let next = 0; ; next += 1) {
    problems.push(...checkLines(`${label}, run ${runs.length}`, run));
    if (!replaced && await fingerprint(path) !== before) problems.push(`${label}: run ${runs.length} changed the file it could not read`);
    if (run.code === 0 || next === 2) break;
    const stop = run.output.at(-1);
    const startAfresh = afreshPart(stop);
    if (startAfresh) {
      if (!AFRESH[file]?.includes(startAfresh)) problems.push(`${label}: the stop names another file: ${stop}`);
      replaced = true;
    } else if (/delete/i.test(stop)) {
      deleteNamed(stop, p.world);
    }
    run = await setup(p, { startAfresh });
    runs.push(run);
  }
  if (run.code !== 0) problems.push(`${label}: not complete within two more runs: ${runs.map(r => r.output.at(-1)).join(' | ')}`);
  await chmod(path, 0o600).catch(() => {});
  await rm(p.folder, { recursive: true, force: true });
  await rm(p.checkout, { recursive: true, force: true });
  return { problems, runs, path, p };
}

async function pool(cases) {
  const failures = [];
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENT }, async () => {
    while (next < cases.length) {
      const one = cases[next++];
      failures.push(...(await unreadableCase(one)).problems);
    }
  }));
  return failures;
}

const FILES = [...new Set(Object.values(AT).flat())];
let caseNumber = 0;
for (const file of FILES) {
  testCase(`every way the ${file} cannot be read, at every point setup leaves it`);
  const cases = [];
  for (const [point, present] of Object.entries(AT)) {
    if (!present.includes(file)) continue;
    for (const kind of file === 'mission file' ? TEXT_KINDS : Object.keys(UNREADABLE)) {
      cases.push({ name: `u${caseNumber++}`, point, file, kind });
    }
  }
  const failures = await pool(cases);
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length} problems in ${cases.length} cases`);
}

testCase('the four cases #96 started from');
{
  // #88: an empty answers file is found before any App page, and setup carries on.
  const emptyAnswers = await unreadableCase({ name: 'answers-at-question', point: 'question', file: 'mission answers', kind: 'empty',
    prepare: p => mkdir(p.projectState, { recursive: true }).then(() => writeFile(p.files['mission answers'], '', { flag: 'wx' }).catch(() => {})) });
  assert.deepEqual(emptyAnswers.problems, []);
  assert.equal(emptyAnswers.runs[0].pages, 0);
  assert(emptyAnswers.runs[0].output.at(-1).startsWith('Setup is complete for '));
  // #91: an empty answers file and an empty mission file are never written over.
  for (const file of ['mission answers', 'mission file']) {
    const result = await unreadableCase({ name: `empty-${file.replace(' ', '-')}`, point: 'final check', file, kind: 'empty' });
    assert.deepEqual(result.problems, []);
  }
  // #87: a finished setup whose answers cannot be read is set up again, not called already set up.
  const finishedAnswers = await unreadableCase({ name: 'finished-answers', point: 'finished', file: 'mission answers', kind: 'damaged' });
  assert.deepEqual(finishedAnswers.problems, []);
  assert.equal(finishedAnswers.runs.length, 1);
  assert(finishedAnswers.runs[0].output.at(-1).startsWith('Setup is complete for '));
  // An empty install record is not taken as a confirmed install: GitHub says the App is not installed, so setup
  // asks for it to be installed, and leaves the record empty.
  const emptyInstall = await unreadableCase({ name: 'empty-install', point: 'finished', file: 'builder install record', kind: 'empty',
    prepare: p => { p.world.uninstalled.add('builder'); } });
  assert.deepEqual(emptyInstall.problems, []);
  assert.equal(emptyInstall.p.world.installs, 3);
  assert(emptyInstall.runs[0].output.at(-1).startsWith('Setup is complete for '));
}

await rm(root, { recursive: true, force: true });
