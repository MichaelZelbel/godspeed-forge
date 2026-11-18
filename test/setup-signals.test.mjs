import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetupCommand } from '../lib/cli.mjs';
import { ReportedSetupError, setupRepository } from '../lib/setup.mjs';
import { FACTORY_REVISION } from '../lib/constants.mjs';
import { defaults } from '../lib/config.mjs';

const credentials = {
  id: 12345, slug: 'forge-app', pem: 'PRIVATE KEY', client_secret: 'CLIENT SECRET', webhook_secret: 'WEBHOOK SECRET'
};
const INTERRUPTED = 'Setup stopped because it was interrupted; try setup again to pick up from what it had already done.';
const TERMINATED = 'Setup stopped because this server told it to stop; try setup again to pick up from what it had already done.';
const APPS_KEPT = 'Your two GitHub Apps for this repository, "Forge builder" and "Forge release", are already on your GitHub account and are kept there. Trying setup again uses them instead of creating new ones.';
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
      callback: async () => 'app-code',
      exchange: async () => credentials,
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
  const input = Object.assign(new EventEmitter(), { close() {} });
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

  // What every interrupted run must look like: the stop sentence last, the kept-Apps line exactly when both
  // Apps exist, nothing raw.
  function assertStopped(result, { code, sentence, appsKept }) {
    assert.equal(result.code, code);
    assert.equal(result.lines.at(-1), sentence);
    assert.equal(result.lines.filter(line => line.startsWith('Setup stopped because')).length, 1);
    assert.equal(result.lines.at(-2) === APPS_KEPT, appsKept);
    if (!appsKept) assert(!result.lines.some(line => /GitHub Apps?\b.*kept/.test(line)));
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
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-question-'));
    const result = await interrupt(root, 'builder-question', 'SIGINT');
    assertStopped(result, { code: 130, sentence: INTERRUPTED, appsKept: false });
    assert.deepEqual(result.lines, ['Using Claude Code to set up the Forge.', INTERRUPTED]);
    // The next run is not refused as already running. The builder App page was being prepared, so it says
    // once, as for any setup that ended there (#29), to delete a builder App if GitHub made one; then the
    // run after creates one App per role.
    const next = await nextSetup(root);
    assert(next.error instanceof ReportedSetupError && next.error.message === 'leftover-app');
    assert.equal(next.messages.at(-1), LEFTOVER_BUILDER);
    assert.deepEqual(next.manifests, []);
    const after = await nextSetup(root);
    assert.equal(after.error, undefined);
    assert.deepEqual(after.manifests, ['Forge builder', 'Forge release']);
  }

  // Ctrl-C typed at a terminal reaches the question, not the process; it stops setup the same way.
  {
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-terminal-'));
    const result = await interrupt(root, 'builder-question', 'terminal');
    assertStopped(result, { code: 130, sentence: INTERRUPTED, appsKept: false });
  }

  // Terminated while a step runs, before any App exists; the next run finishes setup from there.
  {
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-step-'));
    const result = await interrupt(root, 'download', 'SIGTERM');
    assertStopped(result, { code: 143, sentence: TERMINATED, appsKept: false });
    assert.deepEqual(result.lines, ['Using Claude Code to set up the Forge.', TERMINATED]);
    const next = await nextSetup(root);
    assert.equal(next.error, undefined);
    assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    assert.deepEqual(next.manifests, ['Forge builder', 'Forge release']);
  }

  // Stopped at the release App's install question: the builder App exists, the release App was just created.
  // No stop there names kept Apps (the kept-Apps line is for the point where both are set up), so neither
  // does this one. The next run asks to install it again and creates no second App for either role.
  for (const [signal, code, sentence] of [['SIGINT', 130, INTERRUPTED], ['SIGTERM', 143, TERMINATED]]) {
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-one-app-'));
    const result = await interrupt(root, 'release-install', signal);
    assertStopped(result, { code, sentence, appsKept: false });
    const next = await nextSetup(root);
    assert.equal(next.error, undefined);
    assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    assert.deepEqual(next.manifests, []);
  }

  // Stopped at the mission question, both Apps on GitHub: the kept-Apps line, then the stop sentence. The next
  // run asks the mission questions again and finishes with the same two Apps.
  for (const [signal, code, sentence] of [['SIGINT', 130, INTERRUPTED], ['SIGTERM', 143, TERMINATED]]) {
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-apps-'));
    const result = await interrupt(root, 'mission', signal);
    assertStopped(result, { code, sentence, appsKept: true });
    assert.deepEqual(result.lines.slice(-2), [APPS_KEPT, sentence]);
    const next = await nextSetup(root);
    assert.equal(next.error, undefined);
    assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    assert.deepEqual(next.manifests, []);
  }

  console.log('setup signal tests pass');
}
