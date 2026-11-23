import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReportedSetupError, setupRepository } from '../lib/setup.mjs';
import { FACTORY_REVISION } from '../lib/constants.mjs';
import { credentialPath, defaults } from '../lib/config.mjs';
import { testCase } from './cases.mjs';
// test cases: 4

const credentials = {
  id: 12345, slug: 'forge-app', pem: 'PRIVATE KEY', client_secret: 'CLIENT SECRET', webhook_secret: 'WEBHOOK SECRET'
};
const running = repository => `Setup stopped because another setup for ${repository} is already running on this server. Finish that one first: complete the GitHub page or answer the question it is waiting on.`;
const inProgress = error => error instanceof ReportedSetupError && error.message === 'in-progress';

function deferred() {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
}

// A setup's whole outside world: the agent, git, gh and the factory commands, GitHub and the owner's answers.
// `beforeAgent` holds the run at its first command; `page` stands in for the owner finishing the GitHub page.
function standIn(root, { manifests = [], beforeAgent = async () => {}, page = async () => {} } = {}) {
  const record = { calls: [], messages: [] };
  let answer = 0;
  const options = {
    config: { ...defaults(root), projectsRoot: join(root, 'projects') }, paths: { state: join(root, 'state') },
    commands: {
      run: async (command, args, runOptions = {}) => {
        record.calls.push(command);
        if (command === 'claude') { await beforeAgent(); return { stdout: 'signed in' }; }
        if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
        if (command === 'git' && args[0] === 'remote') {
          return { stdout: `https://github.com/${relative(options.config.projectsRoot, runOptions.cwd)}.git\n` };
        }
        if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
        if (command === 'python3' && args[1] === 'init') {
          await mkdir(join(runOptions.cwd, 'factory'), { recursive: true });
          await writeFile(join(runOptions.cwd, 'MISSION.md'), '# Mission\n');
          await mkdir(join(runOptions.cwd, '.factory'), { recursive: true });
          await writeFile(join(runOptions.cwd, '.factory/consumer.json'), '{}\n');
        }
        return { stdout: '' };
      }
    },
    github: {
      begin: async manifest => { manifests.push(manifest.name); return { url: `https://example.test/${manifest.name}` }; },
      callback: async flow => { await page(flow); return 'app-code'; },
      exchange: async () => credentials,
      install: async () => true,
      appStatus: async () => 'installed'
    },
    prompt: async () => ['Keep releases dependable.', 'Small teams.'][answer++ % 2],
    output: value => record.messages.push(value)
  };
  return { record, options };
}

async function readTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const values = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) values.push(path, ...await readTree(path));
    else values.push({ path, contents: await readFile(path, 'utf8') });
  }
  return values;
}

const settled = (name, promise) => promise.then(result => ({ name, result }), error => ({ name, error }));

// Run as a child by the kill test below: a setup that waits forever on the GitHub page.
if (process.argv[2] === 'waiting-setup') {
  setInterval(() => {}, 60_000);
  const { options } = standIn(process.argv[3], { page: () => new Promise(() => {}) });
  const begin = options.github.begin;
  options.github.begin = async manifest => { process.stdout.write('ready\n'); return begin(manifest); };
  await setupRepository('owner/repo', options);
} else {
  testCase('two setups for the same repository at once: one runs, the other stops');
  // Two setups for the same repository at once: one runs, the other stops before doing or writing anything.
  {
    const root = await mkdtemp(join(tmpdir(), 'forge-concurrent-'));
    const manifests = [];
    const agentGate = deferred();
    const bothStarted = deferred();
    let started = 0;
    const beforeAgent = () => {
      if (++started === 2) bothStarted.open({ name: 'both', error: new Error('both setups started') });
      return agentGate.promise;
    };
    const first = standIn(root, { manifests, beforeAgent });
    const second = standIn(root, { manifests, beforeAgent });
    const before = await readTree(root);
    const runs = [settled('first', setupRepository('owner/repo', first.options)),
      settled('second', setupRepository('owner/repo', second.options))];
    const loser = await Promise.race([...runs, bothStarted.promise]);
    assert(inProgress(loser.error));
    const winner = loser.name === 'first' ? second : first;
    const stopped = loser.name === 'first' ? first : second;
    assert.deepEqual(stopped.record.messages, [running('owner/repo')]);
    assert.doesNotMatch(stopped.record.messages[0], /lock|process|socket|pid/i);
    assert(!stopped.record.messages[0].includes(root));
    assert.deepEqual(stopped.record.calls, []);
    assert.deepEqual(await readTree(root), before);

    // GitHub names are case-insensitive, so another spelling is the same repository.
    const respelled = standIn(root, { manifests });
    await assert.rejects(setupRepository('Owner/Repo', respelled.options), inProgress);
    assert.deepEqual(respelled.record.messages, [running('Owner/Repo')]);
    assert.deepEqual(respelled.record.calls, []);

    agentGate.open();
    const done = (await Promise.all(runs)).find(run => run.name !== loser.name);
    assert.equal(done.error, undefined);
    assert.equal(done.result.completed, true);
    assert.deepEqual(manifests, ['Forge builder', 'Forge release']);
    const all = [...first.record.messages, ...second.record.messages, ...respelled.record.messages];
    assert.equal(all.filter(message => message.startsWith('Setup is complete for owner/repo.')).length, 1);
    assert(winner.record.messages.at(-1).startsWith('Setup is complete for owner/repo.'));

    const again = standIn(root);
    await setupRepository('owner/repo', again.options);
    assert.deepEqual(again.record.messages, ['The Forge is already set up for owner/repo.']);
  }

  testCase('a setup killed part-way does not keep the repository blocked');
  // A setup killed part-way does not keep the repository blocked.
  {
    const root = await mkdtemp(join(tmpdir(), 'forge-killed-'));
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'waiting-setup', root],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise(resolve => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
      child.stdout.on('data', data => { if (String(data).includes('ready')) resolve(); });
      exited.then(() => reject(new Error('the waiting setup exited early')));
    });
    const blocked = standIn(root);
    await assert.rejects(setupRepository('owner/repo', blocked.options), inProgress);
    assert.deepEqual(blocked.record.messages, [running('owner/repo')]);

    child.kill('SIGKILL');
    await exited;
    // The killed setup may have left the owner finishing the builder App page (#29), so the next setup is
    // not blocked: it opens that page again (#61), asking first for the App to be deleted only if the owner
    // finished the page, and creates one App per role.
    const manifests = [];
    const next = standIn(root, { manifests });
    const result = await setupRepository('owner/repo', next.options);
    assert.equal(result.completed, true);
    assert.deepEqual(manifests, ['Forge builder', 'Forge release']);
    const reminder = 'If you finished the GitHub page for the builder App during an earlier setup, delete the builder App it made for owner/repo in your GitHub App settings before you create it again.';
    assert.equal(next.record.messages[next.record.messages.indexOf(reminder) + 1], 'Create the builder App in your browser: https://example.test/Forge builder');
    assert(!next.record.messages.some(line => line.startsWith('Setup stopped because')));
    assert(next.record.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
  }

  testCase('a second setup while the first waits on the App page stops and leaves the first alone');
  // A second setup while the first waits on the builder App page (#29 with #35): the second stops with the
  // already-running message, gives no advice to delete an App, and leaves the first setup's pending record
  // alone; the first then finishes with one App per role.
  {
    const root = await mkdtemp(join(tmpdir(), 'forge-overlap-page-'));
    const manifests = [];
    const onPage = deferred();
    const pageDone = deferred();
    const first = standIn(root, { manifests, page: async () => { onPage.open(); await pageDone.promise; } });
    const firstRun = settled('first', setupRepository('owner/repo', first.options));
    await onPage.promise;
    const pending = join(credentialPath(first.options.paths.state, 'owner/repo'), 'builder-app-pending.json');
    const pendingBefore = await readFile(pending, 'utf8');
    const second = standIn(root, { manifests });
    await assert.rejects(setupRepository('owner/repo', second.options), inProgress);
    assert.deepEqual(second.record.messages, [running('owner/repo')]);
    assert(!second.record.messages.some(message => /delete/i.test(message)));
    assert.deepEqual(second.record.calls, []);
    assert.equal(await readFile(pending, 'utf8'), pendingBefore);
    pageDone.open();
    const done = await firstRun;
    assert.equal(done.error, undefined);
    assert.equal(done.result.completed, true);
    assert.deepEqual(manifests, ['Forge builder', 'Forge release']);
    assert(first.record.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    await assert.rejects(readFile(pending, 'utf8'));
  }

  testCase('setups for two different repositories run at the same time');
  // Setups for two different repositories run at the same time.
  {
    const root = await mkdtemp(join(tmpdir(), 'forge-two-repositories-'));
    const pages = deferred();
    const bothOnPage = deferred();
    let onPage = 0;
    const page = async () => {
      if (++onPage === 2) bothOnPage.open();
      await pages.promise;
    };
    const one = standIn(root, { page });
    const two = standIn(root, { page });
    const runs = Promise.all([setupRepository('owner/one', one.options), setupRepository('owner/two', two.options)]);
    await bothOnPage.promise;
    pages.open();
    const results = await runs;
    assert(results.every(result => result.completed === true));
    assert(one.record.messages.at(-1).startsWith('Setup is complete for owner/one.'));
    assert(two.record.messages.at(-1).startsWith('Setup is complete for owner/two.'));
  }
}
