// Runs setup from every combination of what this server has saved about each App and whether GitHub still has
// it, with an owner who, after each stop, deletes on GitHub every App role the stop asks them to delete and
// tries again, up to three times. GitHub must never hold more than one App per role at any point, and setup must
// end complete or already set up, using, for each role whose App the owner deleted, an App that is on GitHub.
// Each combination starts from a real finished setup, then changes per App: its details file (kept, deleted,
// empty, a link to a removed file, or damaged), whether a pending record still holds its keys, whether the
// record that it is installed stays, and whether it is still on GitHub; and whether the record that setup
// finished stays. Kept details and keys may also be those of an older App of the
// role than the one setup listed (state restored from an older copy), which is itself on GitHub or gone. The
// owner deletes the Apps a stop names in quotes, or else every App of each role it names. Combinations run 16
// at a time, each in its own folders.
// test cases: 8
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupRepository, UNEXPECTED_MESSAGE } from '../lib/setup.mjs';
import { credentialPath, defaults, projectStatePath } from '../lib/config.mjs';
import { FACTORY_REVISION } from '../lib/constants.mjs';
import './home.mjs';
import { testCase } from './cases.mjs';

const root = await mkdtemp(join(tmpdir(), 'forge-combinations-'));
const KINDS = ['builder', 'release'];
const DETAILS = ['kept', 'deleted', 'empty', 'broken link', 'damaged'];
const OLDER = ['on GitHub', 'gone'];
const ROLE_STATES = DETAILS.flatMap(details => [false, true].flatMap(pending => [false, true].flatMap(installed => [
  { details, pending, installed },
  ...(details === 'kept' ? OLDER.map(older => ({ details, pending, installed, older })) : [])
])));
const CONCURRENT = 16;
const RETRIES = 3;

// GitHub, as far as setup sees it: the Apps each role has, by slug. A second App of a role is a violation.
function standInGithub() {
  const world = { apps: { builder: new Set(), release: new Set() }, codes: new Map(), names: new Map(), deleted: new Set(), spent: new Set(), violations: [], made: 0 };
  let creating;
  const listed = slug => KINDS.some(kind => world.apps[kind].has(slug));
  world.github = {
    exists: path => access(path).then(() => true, () => false),
    begin: async manifest => {
      creating = manifest.name === 'Forge builder' ? 'builder' : 'release';
      return { url: `https://example.test/${creating}` };
    },
    callback: async () => `code-${creating}-${world.made + 1}`,
    exchange: async code => {
      if (world.spent.has(code)) throw Object.assign(new Error('GitHub refused the App code.'), { refused: true });
      world.spent.add(code);
      const kind = code.split('-')[1];
      if (world.apps[kind].size > 0) world.violations.push(`a second ${kind} App while ${[...world.apps[kind]].join(', ')} is on GitHub`);
      world.made += 1;
      const app = { id: world.made, slug: `combo-${kind}-${world.made}`, pem: 'PRIVATE KEY', name: `Forge ${kind} ${world.made}` };
      world.apps[kind].add(app.slug);
      world.codes.set(app.slug, code);
      world.names.set(app.name, { kind, slug: app.slug });
      return app;
    },
    install: async () => true,
    appExists: async ({ slug }) => listed(slug),
    appStatus: async ({ credentials }) => listed(credentials?.slug) ? 'installed' : 'app-missing'
  };
  return world;
}

async function attempt(repository, folder, github) {
  const output = [];
  let answer = 0;
  const run = async (command, args, options = {}) => {
    if (command === 'claude') return { stdout: 'signed in' };
    if (command === 'gh' || (command === 'git' && args[0] === 'clone')) {
      await mkdir(join(args.at(-1), '.git'), { recursive: true });
      return { stdout: '' };
    }
    if (command === 'git' && args[0] === 'remote') return { stdout: `https://github.com/${repository}.git\n` };
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
    if (command === 'python3' && args[1] === 'init') {
      await mkdir(join(options.cwd, 'factory'), { recursive: true });
      await mkdir(join(options.cwd, '.factory'), { recursive: true });
      await writeFile(join(options.cwd, 'MISSION.md'), '# Mission\n');
      await writeFile(join(options.cwd, 'factory/consumer.py'), '# factory stand-in\n');
      await writeFile(join(options.cwd, '.factory/consumer.json'), '{}\n');
    }
    return { stdout: '' };
  };
  try {
    await setupRepository(repository, {
      config: { ...defaults(folder), projectsRoot: join(folder, 'projects') }, paths: { state: join(folder, 'state') },
      commands: { run }, github, prompt: async question => question.startsWith('Two ') ? question.match(/Answer (\S+) to use/)[1] : ['Purpose.', 'Users.'][answer++ % 2], output: line => output.push(line)
    });
    return { output, completed: true };
  } catch {
    return { output, completed: false };
  }
}

async function arrange(kind, state, onGithub, { stateDirectory, credentialDirectory, world }) {
  const detailsPath = join(credentialDirectory, `${kind}-app.json`);
  const listed = JSON.parse(await readFile(detailsPath, 'utf8'));
  let details = listed;
  if (state.older) {
    details = { id: 900, slug: `combo-${kind}-older`, pem: 'PRIVATE KEY', name: `Forge ${kind} older` };
    world.codes.set(details.slug, `code-${kind}-older`);
    world.spent.add(`code-${kind}-older`);
    world.names.set(details.name, { kind, slug: details.slug });
    if (state.older === 'on GitHub') world.apps[kind].add(details.slug);
    await writeFile(detailsPath, JSON.stringify(details));
  }
  if (state.pending) {
    await writeFile(join(credentialDirectory, `${kind}-app-pending.json`), JSON.stringify({ code: world.codes.get(details.slug), credentials: details }));
  }
  if (!state.installed) await rm(join(stateDirectory, `${kind}-installation.json`));
  if (state.details === 'deleted') await rm(detailsPath);
  if (state.details === 'empty') await writeFile(detailsPath, '');
  if (state.details === 'broken link') { await rm(detailsPath); await symlink(`${detailsPath}.removed`, detailsPath); }
  if (state.details === 'damaged') await writeFile(detailsPath, '{"id": 1, "pem": "PRIV');
  if (!onGithub) world.apps[kind].delete(listed.slug);
}

const describe = (kind, state, onGithub) => `${kind} details ${state.details}${state.older ? ` of an older App ${state.older}` : ''}, ${state.pending ? '' : 'no '}keys kept, ${state.installed ? '' : 'not '}installed, ${onGithub ? 'on' : 'gone from'} GitHub`;

function deleteNamed(stop, world) {
  const named = [...stop.matchAll(/"([^"]+)"/g)].map(([, name]) => world.names.get(name)).filter(Boolean);
  if (named.length) for (const { kind, slug } of named) { world.apps[kind].delete(slug); world.deleted.add(kind); }
  else for (const kind of KINDS) if (new RegExp(`\\b${kind}\\b`).test(stop)) { world.apps[kind].clear(); world.deleted.add(kind); }
}

// The problems one combination ends with: none when it passes.
async function combination(name, finished, roles) {
  const folder = join(root, name);
  const repository = `owner/${name}`;
  const world = standInGithub();
  const fresh = await attempt(repository, folder, world.github);
  if (!fresh.completed) return [`the first setup did not complete: ${fresh.output.at(-1)}`];
  const stateDirectory = projectStatePath(join(folder, 'state'), repository);
  const context = { stateDirectory, credentialDirectory: credentialPath(join(folder, 'state'), repository), world };
  for (const [kind, { state, onGithub }] of Object.entries(roles)) await arrange(kind, state, onGithub, context);
  if (!finished) await rm(join(stateDirectory, 'registration.json'));
  let last = await attempt(repository, folder, world.github);
  const lines = [...last.output];
  for (let retry = 0; !last.completed && retry < RETRIES; retry += 1) {
    const stop = last.output.at(-1) ?? '';
    if (/delete/i.test(stop)) deleteNamed(stop, world);
    last = await attempt(repository, folder, world.github);
    lines.push(...last.output);
  }
  const problems = [...world.violations];
  const end = last.output.at(-1) ?? '';
  if (!end.startsWith(`Setup is complete for ${repository}.`) && end !== `The Forge is already set up for ${repository}.`) {
    problems.push(`setup did not end complete: ${end}`);
  }
  if (lines.includes(UNEXPECTED_MESSAGE)) problems.push('setup stopped for a reason it could not identify');
  // A complete setup uses, for each role, an App that is on GitHub, whether the owner deleted one or it was
  // already gone.
  for (const kind of KINDS) {
    const held = await readFile(join(context.credentialDirectory, `${kind}-app.json`), 'utf8').then(JSON.parse, () => null);
    if (last.completed && !world.apps[kind].has(held?.slug)) {
      problems.push(world.deleted.has(kind)
        ? `after the owner deleted the ${kind} App, setup ended using one that is not on GitHub`
        : `setup ended complete using a ${kind} App that is not on GitHub`);
    }
  }
  await rm(folder, { recursive: true, force: true });
  return problems;
}

async function pool(jobs) {
  const failures = [];
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENT }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const problems = await job.run();
      if (problems.length) failures.push(`${job.label}: ${problems.join('; ')}`);
    }
  }));
  return failures;
}

for (const finished of [false, true]) {
  for (const builderOnGithub of [true, false]) {
    for (const releaseOnGithub of [true, false]) {
      const label = `${finished ? 'finished' : 'unfinished'} setup, builder App ${builderOnGithub ? 'on' : 'gone from'} GitHub, release App ${releaseOnGithub ? 'on' : 'gone from'} GitHub`;
      testCase(`every saved state of both Apps: ${label}`);
      const prefix = `${finished ? 'f' : 'u'}${builderOnGithub ? 1 : 0}${releaseOnGithub ? 1 : 0}`;
      const jobs = ROLE_STATES.flatMap((builder, b) => ROLE_STATES.map((release, r) => {
        const roles = { builder: { state: builder, onGithub: builderOnGithub }, release: { state: release, onGithub: releaseOnGithub } };
        return {
          label: `${label}; ${describe('builder', builder, builderOnGithub)}; ${describe('release', release, releaseOnGithub)}`,
          run: () => combination(`combo-${prefix}-${b}-${r}`, finished, roles)
        };
      }));
      const failures = await pool(jobs);
      assert.deepEqual(failures.slice(0, 5), [], `${failures.length} of ${jobs.length} combinations failed`);
    }
  }
}
await rm(root, { recursive: true, force: true });
