import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetupCommand } from '../lib/cli.mjs';
import { setupRepository } from '../lib/setup.mjs';
import { FACTORY_REVISION } from '../lib/constants.mjs';
import { defaults } from '../lib/config.mjs';
import { testCase } from './cases.mjs';

const credentials = {
  id: 12345, slug: 'forge-app', pem: 'PRIVATE KEY', client_secret: 'CLIENT SECRET', webhook_secret: 'WEBHOOK SECRET'
};
const INTERRUPTED = 'Setup stopped because it was interrupted; try setup again to pick up from what it had already done.';
const TERMINATED = 'Setup stopped because this server told it to stop; try setup again to pick up from what it had already done.';
const APPS_KEPT = 'Your two GitHub Apps for this repository, "Forge builder" and "Forge release", are already on your GitHub account and are kept there. Trying setup again uses them instead of creating new ones.';
const BUILDER_KEPT = 'Your GitHub App "Forge builder" for this repository is already on your GitHub account and is kept there. Trying setup again uses it instead of creating a new one.';
const LEFTOVER_BUILDER = 'Setup stopped because it could not finish connecting the builder App. If GitHub created a builder App for owner/repo, delete it in your GitHub App settings, then try setup again.';
const isPresent = async path => { try { await access(path); return true; } catch { return false; } };

// A setup's whole outside world: the agent, git, gh and the factory commands, GitHub and the owner's answers.
// `waitAt` names the point where the run waits forever: a question, or a command that is still running.
function standIn(root, { manifests = [], waitAt, onWait = () => {} } = {}) {
  const messages = [];
  const wait = point => {
    if (point !== waitAt) return null;
    onWait();
    return new Promise(() => {});
  };
  let answer = 0;
  const options = {
    config: { ...defaults(root), projectsRoot: join(root, 'projects') }, paths: { state: join(root, 'state') },
    commands: {
      run: async (command, args, runOptions = {}) => {
        if (command === 'claude') return { stdout: 'signed in' };
        if (command === 'gh') { await mkdir(join(args.at(-1), '.git'), { recursive: true }); return { stdout: '' }; }
        if (command === 'git' && args[0] === 'remote') {
          return { stdout: `https://github.com/${relative(options.config.projectsRoot, runOptions.cwd)}.git\n` };
        }
        if (command === 'git' && args[0] === 'fetch') await wait('download');
        if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${FACTORY_REVISION}\n` };
        if (command === 'python3' && args.at(-1) === 'init') {
          await mkdir(join(runOptions.cwd, 'factory'), { recursive: true });
          await writeFile(join(runOptions.cwd, 'MISSION.md'), '# Mission\n');
        }
        return { stdout: '' };
      }
    },
    github: {
      exists: isPresent,
      begin: async manifest => {
        manifests.push(manifest.name);
        await wait(`${manifest.name === 'Forge builder' ? 'builder' : 'release'}-question`);
        return { url: `https://example.test/${manifest.name}` };
      },
      callback: async flow => { await wait(`${flow.url.endsWith('builder') ? 'builder' : 'release'}-callback`); return 'app-code'; },
      exchange: async () => { await wait('exchange'); return credentials; },
      install: async ({ kind }) => { await wait(`${kind}-install`); return true; }
    },
    prompt: async () => { await wait('mission'); return ['Keep releases dependable.', 'Small teams.'][answer++ % 2]; },
    output: value => { messages.push(value); console.log(value); }
  };
  return { messages, options };
}

if (process.argv[2] === 'command') {
  // Run as a child: `godspeed-forge setup` as the command runs it, with the stand-in world. It prints "ready"
  // on stderr once it waits; with "terminal", the wait ends with Ctrl-C typed at the question instead.
  const [, , , root, waitAt, terminal] = process.argv;
  const input = Object.assign(new EventEmitter(), { close() {}, terminal: Boolean(terminal) });
  setInterval(() => {}, 60_000);
  await runSetupCommand('owner/repo', async () => ({
    ...standIn(root, {
      waitAt,
      onWait: () => {
        process.stderr.write('ready\n');
        if (terminal) setImmediate(() => input.emit('SIGINT'));
      }
    }).options,
    input
  }));
} else {
  // Runs the command until it waits at waitAt, sends the signal, and returns what it printed and its exit code.
  async function interrupt(root, waitAt, signal) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'command', root, waitAt, signal === 'terminal' ? 'terminal' : ''],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    const exited = new Promise(resolve => child.once('close', (code, killedBy) => resolve({ code, killedBy })));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    await new Promise((resolve, reject) => {
      child.stderr.on('data', data => { stderr += data; if (stderr.includes('ready')) resolve(); });
      exited.then(() => reject(new Error(`the command exited before waiting at ${waitAt}: ${stderr}`)));
    });
    if (signal !== 'terminal') child.kill(signal);
    const { code, killedBy } = await exited;
    clearTimeout(timer);
    assert.equal(killedBy, null, `the command was ended by ${killedBy} instead of stopping itself`);
    return { code, lines: stdout.trimEnd().split('\n'), stderr: stderr.replace('ready\n', '') };
  }

  // What every interrupted run must look like: the stop sentence last, the kept-Apps line (kept, null when no
  // App exists) just before it exactly when an App exists, nothing raw.
  function assertStopped(result, { code, sentence, kept }) {
    assert.equal(result.code, code);
    assert.equal(result.lines.at(-1), sentence);
    assert.equal(result.lines.filter(line => line.startsWith('Setup stopped because')).length, 1);
    if (kept) assert.equal(result.lines.at(-2), kept);
    assert.equal(result.lines.filter(line => /GitHub Apps?\b.*kept/.test(line)).length, kept ? 1 : 0);
    assert.equal(result.stderr, '');
    assert(!result.lines.some(line => /Error|at .*:\d+:\d+|Errno|ENOENT|EACCES/.test(line)));
  }

  async function nextSetup(root) {
    const manifests = [];
    const next = standIn(root, { manifests });
    next.options.output = value => next.messages.push(value);
    try {
      const result = await setupRepository('owner/repo', next.options);
      return { manifests, messages: next.messages, result };
    } catch (error) {
      return { manifests, messages: next.messages, error };
    }
  }

  // Ctrl-C at a question before any App exists: the interrupt sentence and nothing about Apps.
  {
    testCase('Ctrl-C at a question before any App exists');
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-question-'));
    const result = await interrupt(root, 'builder-question', 'SIGINT');
    assertStopped(result, { code: 130, sentence: INTERRUPTED, kept: null });
    assert.deepEqual(result.lines, ['Using Claude Code to set up the Forge.', INTERRUPTED]);
    // The next run is not refused as already running. No App page had been shown, so GitHub made no App and
    // the next run simply asks again and creates one App per role.
    const next = await nextSetup(root);
    assert.equal(next.error, undefined);
    assert(!next.messages.includes(LEFTOVER_BUILDER));
    assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    assert.deepEqual(next.manifests, ['Forge builder', 'Forge release']);
  }

  // The same before the release App's page, terminated, with the builder App already made: the stop says the
  // builder App is kept, and the next run creates only the release App and says nothing about deleting one.
  for (const [waitAt, made, kept] of [['builder-question', ['Forge builder', 'Forge release'], null], ['release-question', ['Forge release'], BUILDER_KEPT]]) {
    testCase(`terminated before the ${waitAt.split('-')[0]} App page was shown`);
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-before-page-'));
    const result = await interrupt(root, waitAt, 'SIGTERM');
    assertStopped(result, { code: 143, sentence: TERMINATED, kept });
    const next = await nextSetup(root);
    assert.equal(next.error, undefined);
    assert(!next.messages.some(line => line.includes('delete it in your GitHub App settings')));
    assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    assert.deepEqual(next.manifests, made);
  }

  // Ctrl-C typed at a terminal reaches the question, not the process; it stops setup the same way.
  {
    testCase('Ctrl-C typed at a terminal');
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-terminal-'));
    const result = await interrupt(root, 'builder-question', 'terminal');
    assertStopped(result, { code: 130, sentence: INTERRUPTED, kept: null });
    // In a terminal the sentence starts on a line of its own instead of running onto the open question.
    assert.deepEqual(result.lines, ['Using Claude Code to set up the Forge.', '', INTERRUPTED]);
  }

  // Stopped while waiting for the address from an App's GitHub page: GitHub may have created that App, and the
  // next run asks for it to be deleted. The stop sentence says that, instead of promising the next run picks
  // up, and the next run then says the same; once that stop is followed, the run after it completes.
  for (const [signal, code, why] of [['SIGINT', 130, 'it was interrupted'], ['SIGTERM', 143, 'this server told it to stop']]) {
    for (const [kind, waitAt, made, kept] of [['builder', 'builder-callback', ['Forge builder', 'Forge release'], null], ['release', 'release-callback', ['Forge release'], BUILDER_KEPT]]) {
      testCase(`${signal} after the ${kind} App page was shown`);
      const root = await mkdtemp(join(tmpdir(), 'forge-signal-page-shown-'));
      const result = await interrupt(root, waitAt, signal);
      const sentence = `Setup stopped because ${why} before it finished connecting the ${kind} App; if GitHub created a ${kind} App for owner/repo, delete it in your GitHub App settings before you try setup again, as the next setup will ask you to.`;
      assertStopped(result, { code, sentence, kept });
      assert.equal(result.lines.at(kept ? -3 : -2), `Create the ${kind} App in your browser: https://example.test/Forge ${kind}`);
      assert(!result.lines.some(line => line.includes('pick up from what it had already done')));
      const next = await nextSetup(root);
      assert(next.error);
      assert.deepEqual(next.manifests, []);
      assert.equal(next.messages.at(-1), `Setup stopped because it could not finish connecting the ${kind} App. If GitHub created a ${kind} App for owner/repo, delete it in your GitHub App settings, then try setup again.`);
      const after = await nextSetup(root);
      assert.equal(after.error, undefined);
      assert(after.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
      assert.deepEqual(after.manifests, made);
    }
  }

  // Stopped while GitHub turns the builder App's code into its credentials: the code is saved, so the next run
  // tries to finish that App, as the sentence says, and creates no second one.
  for (const [signal, code, why] of [['SIGINT', 130, 'it was interrupted'], ['SIGTERM', 143, 'this server told it to stop']]) {
    testCase(`${signal} while the builder App code is being exchanged`);
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-code-saved-'));
    const result = await interrupt(root, 'exchange', signal);
    const sentence = `Setup stopped because ${why} before it finished connecting the builder App; try setup again and it will try to finish this App, and if GitHub no longer accepts it, setup will say what to do.`;
    assertStopped(result, { code, sentence, kept: null });
    const next = await nextSetup(root);
    assert.equal(next.error, undefined);
    assert(!next.messages.some(line => line.includes('delete it in your GitHub App settings')));
    assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    assert.deepEqual(next.manifests, ['Forge release']);
  }

  // Terminated while a step runs, before any App exists; the next run finishes setup from there.
  {
    testCase('terminated while a step runs');
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-step-'));
    const result = await interrupt(root, 'download', 'SIGTERM');
    assertStopped(result, { code: 143, sentence: TERMINATED, kept: null });
    assert.deepEqual(result.lines, ['Using Claude Code to set up the Forge.', TERMINATED]);
    const next = await nextSetup(root);
    assert.equal(next.error, undefined);
    assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    assert.deepEqual(next.manifests, ['Forge builder', 'Forge release']);
  }

  // Stopped at the release App's install question: the builder App exists, the release App was just created.
  // Both are on GitHub, so the stop says both are kept. The next run asks to install the release App again and
  // creates no second App for either role.
  for (const [signal, code, sentence] of [['SIGINT', 130, INTERRUPTED], ['SIGTERM', 143, TERMINATED]]) {
    testCase(`${signal} at the release install question`);
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-one-app-'));
    const result = await interrupt(root, 'release-install', signal);
    assertStopped(result, { code, sentence, kept: APPS_KEPT });
    const next = await nextSetup(root);
    assert.equal(next.error, undefined);
    assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    assert.deepEqual(next.manifests, []);
  }

  // Stopped at the mission question, both Apps on GitHub: the kept-Apps line, then the stop sentence. The next
  // run asks the mission questions again and finishes with the same two Apps.
  for (const [signal, code, sentence] of [['SIGINT', 130, INTERRUPTED], ['SIGTERM', 143, TERMINATED]]) {
    testCase(`${signal} at the mission question, both Apps on GitHub`);
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-apps-'));
    const result = await interrupt(root, 'mission', signal);
    assertStopped(result, { code, sentence, kept: APPS_KEPT });
    assert.deepEqual(result.lines.slice(-2), [APPS_KEPT, sentence]);
    const next = await nextSetup(root);
    assert.equal(next.error, undefined);
    assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    assert.deepEqual(next.manifests, []);
  }

  // The real command, with input that closes while a later question waits (after the builder App's install
  // answer): it prints no raw Node text, such as a warning about an unsettled top-level await, and stops.
  {
    testCase('input closes at a later question');
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-input-closes-'));
    const bin = join(root, 'bin');
    await mkdir(bin);
    const tools = {
      claude: 'echo signed in',
      gh: 'mkdir -p "${@: -1}/.git"',
      git: `case "$1" in remote) echo https://github.com/owner/repo.git;; clone) mkdir -p "\${@: -1}/.git";; rev-parse) echo ${FACTORY_REVISION};; esac`,
      python3: 'if [ "${@: -1}" = init ]; then mkdir -p factory; echo "# Mission" > MISSION.md; fi'
    };
    for (const [name, body] of Object.entries(tools)) {
      await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`);
      await chmod(join(bin, name), 0o755);
    }
    const credentialDirectory = join(root, '.godspeed/forge/state/credentials/owner/repo');
    await mkdir(credentialDirectory, { recursive: true });
    await writeFile(join(credentialDirectory, 'builder-app.json'), JSON.stringify(credentials), { mode: 0o600 });
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/godspeed-forge.mjs', import.meta.url)), 'setup', 'owner/repo'],
      { env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => {
      stdout += data;
      if (stdout.endsWith('installed only on owner/repo: ')) child.stdin.write('yes\n');
      if (stdout.endsWith('or no if it is your personal account: ')) child.stdin.end();
    });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const code = await new Promise(resolve => child.once('close', resolve));
    clearTimeout(timer);
    assert(stdout.includes('Type yes if owner is a GitHub organization'), stdout);
    assert.equal(stderr, '');
    assert(!/Warning|await|\^/.test(stdout), stdout);
    // Closed input is a stop like any other (issue #56): one plain sentence and a non-zero exit.
    assert.equal(stdout.trimEnd().split('\n').at(-1), 'Setup stopped because the place it was reading your answers from closed before you answered. Try setup again and answer each question it asks.', stdout);
    assert.equal(code, 1);
  }

  console.log('setup signal tests pass');
}
