import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, chmod, mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetupCommand } from '../lib/cli.mjs';
import { answersFrom, setupRepository } from '../lib/setup.mjs';
import { FACTORY_REVISION } from '../lib/constants.mjs';
import { credentialPath, defaults } from '../lib/config.mjs';
import { testCase } from './cases.mjs';
// test cases: 30

const credentials = {
  id: 12345, slug: 'forge-app', pem: 'PRIVATE KEY', client_secret: 'CLIENT SECRET', webhook_secret: 'WEBHOOK SECRET'
};
const INTERRUPTED = 'Setup stopped because it was interrupted; try setup again to pick up from what it had already done.';
const TERMINATED = 'Setup stopped because this server told it to stop; try setup again to pick up from what it had already done.';
const APPS_KEPT = 'Setup kept the details of your two GitHub Apps for this repository, "Forge builder" and "Forge release", on this server. Trying setup again checks whether they are still on your GitHub account and uses each one that is, instead of creating a new one.';
const BUILDER_KEPT = 'Setup kept the details of your GitHub App "Forge builder" for this repository on this server. Trying setup again checks whether it is still on your GitHub account and uses it if it is, instead of creating a new one.';
const INPUT_CLOSED = 'Setup stopped because the place it was reading your answers from closed before you answered. Try setup again and answer each question it asks.';
const LEFTOVER_BUILDER = 'Setup stopped because it could not finish connecting the builder App. If GitHub created a builder App for owner/repo, delete it in your GitHub App settings, then try setup again.';
const isPresent = async path => { try { await access(path); return true; } catch { return false; } };
const reopened = kind => `If you finished the GitHub page for the ${kind} App during an earlier setup, delete the ${kind} App it made for owner/repo in your GitHub App settings before you create it again.`;
const builderDetails = root => join(credentialPath(join(root, 'state'), 'owner/repo'), 'builder-app.json');

// A setup's whole outside world: the agent, git, gh and the factory commands, GitHub and the owner's answers.
// `waitAt` names the point where the run waits forever: a question, or a command that is still running.
// `questions` records the mission questions asked; `answers` gives the purpose and users answers. With `ask`, the
// address question of the App page at waitAt is asked through it. GitHub refuses the App codes in `spentCodes`, as
// it does a code it already turned into keys. The Apps of the kinds in `deleted` are gone from GitHub: asking about
// one answers that it is missing and says on stderr that it was asked.
function standIn(root, { manifests = [], waitAt, onWait = () => {}, questions = [], answers = ['Keep releases dependable.', 'Small teams.'], ask, spentCodes = [], deleted = [] } = {}) {
  const messages = [];
  const wait = point => {
    if (point !== waitAt) return null;
    onWait();
    return new Promise(() => {});
  };
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
      callback: async flow => {
        const kind = flow.url.endsWith('builder') ? 'builder' : 'release';
        if (`${kind}-callback` === waitAt && ask) { onWait(); return ask('Paste the address your browser shows:'); }
        await wait(`${kind}-callback`);
        return `${kind}-code`;
      },
      exchange: async code => {
        await wait('exchange');
        if (spentCodes.includes(code)) throw Object.assign(new Error('GitHub refused the App code.'), { refused: true });
        // The builder App's details file is then written, and that write waits on its stand-in (see 'command').
        // The named pipe is made here, not when the command starts: a run sweeps left-behind temporaries
        // beside its saves before anything else (#100), and it would take this one away first.
        if (waitAt === 'builder-details') {
          await mkdir(join(builderDetails(root), '..'), { recursive: true, mode: 0o700 });
          execFileSync('mkfifo', [`${builderDetails(root)}.${process.pid}.tmp`]);
          onWait();
        }
        return credentials;
      },
      install: async ({ kind }) => { await wait(`${kind}-install`); return true; },
      appStatus: async ({ kind }) => {
        if (!deleted.includes(kind)) return 'installed';
        process.stderr.write(`asked GitHub about the deleted ${kind} App\n`);
        return 'app-missing';
      }
    },
    prompt: async question => {
      questions.push(question);
      await wait('mission');
      const users = question === 'Who uses it?';
      if (users && waitAt === 'users-question') { onWait(); return ask ? ask(question) : new Promise(() => {}); }
      return answers[users ? 1 : 0];
    },
    output: value => { messages.push(value); console.log(value); }
  };
  return { messages, options };
}

if (process.argv[2] === 'command') {
  // Run as a child: `godspeed-forge setup` as the command runs it, with the stand-in world. It prints "ready"
  // on stderr once it waits; with "terminal", the wait ends with Ctrl-C typed at the question instead.
  // With "closes", the question is asked on real input that then closes: no answer ever comes, as when the
  // owner's input ends, and nothing keeps the process alive but setup itself.
  const [, , , root, waitAt, mode, deleted = ''] = process.argv;
  const terminal = mode === 'terminal';
  const closes = mode === 'closes';
  const stream = new PassThrough();
  const input = closes ? createInterface({ input: stream, output: process.stdout })
    : Object.assign(new EventEmitter(), { close() {}, terminal });
  // Questions on real input go through answersFrom, as the real command asks them.
  const answers = closes ? answersFrom(input) : null;
  if (!closes) setInterval(() => {}, 60_000);
  // Not awaited, as the real command does not: a question that never settles is not an unsettled top-level await.
  runSetupCommand('owner/repo', async () => ({
    ...standIn(root, {
      waitAt,
      deleted: deleted.split(',').filter(Boolean),
      ask: closes ? question => { const answer = answers.question(`${question} `); stream.end(); return answer; } : undefined,
      onWait: () => {
        process.stderr.write('ready\n');
        if (terminal) setImmediate(() => input.emit('SIGINT'));
      }
    }).options,
    input
  }));
} else {
  // Runs the command until it waits at waitAt and until() holds, sends the signal, and returns what it printed,
  // its exit code and how long it took to end after the signal. SIGKILL ends it with no word of its own; any
  // other signal it must stop on itself, by exiting, or with endsBySignal by ending through that same signal
  // once a write it cannot finish holds up its exit. deleted names the Apps that are gone from GitHub during this run.
  async function interrupt(root, waitAt, signal, { until = async () => true, endsBySignal = false, deleted = [] } = {}) {
    const mode = signal === 'terminal' || signal === 'closes' ? signal : '';
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'command', root, waitAt, mode, deleted.join(',')],
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
    for (let tries = 0; !(await until()); tries += 1) {
      assert(tries < 200, `the command never reached the point after ${waitAt}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const signalledAt = Date.now();
    if (!mode) child.kill(signal);
    const { code, killedBy } = await exited;
    const took = Date.now() - signalledAt;
    clearTimeout(timer);
    if (signal === 'SIGKILL') assert.equal(killedBy, 'SIGKILL');
    else assert.equal(killedBy, endsBySignal ? signal : null, `the command was ended by ${killedBy} instead of stopping itself`);
    return { code, took, lines: stdout.trimEnd().split('\n'), stderr: stderr.replace('ready\n', '') };
  }

  // What every interrupted run must look like: the stop sentence last, the kept-Apps line (kept, null when no
  // App exists) just before it exactly when an App exists, nothing raw.
  function assertStopped(result, { code, sentence, kept }) {
    assert.equal(result.code, code);
    assert.equal(result.lines.at(-1), sentence);
    assert.equal(result.lines.filter(line => line.startsWith('Setup stopped because')).length, 1);
    if (kept) assert.equal(result.lines.at(-2), kept);
    assert.equal(result.lines.filter(line => /Setup kept the details of your (two )?GitHub Apps?\b/.test(line)).length, kept ? 1 : 0);
    assert.equal(result.stderr, '');
    assert(!result.lines.some(line => /Error|at .*:\d+:\d+|Errno|ENOENT|EACCES/.test(line)));
  }

  async function nextSetup(root, answers, { spentCodes } = {}) {
    const manifests = [];
    const questions = [];
    const next = standIn(root, { manifests, questions, answers, spentCodes });
    next.options.output = value => next.messages.push(value);
    try {
      const result = await setupRepository('owner/repo', next.options);
      return { manifests, questions, messages: next.messages, result };
    } catch (error) {
      return { manifests, questions, messages: next.messages, error };
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

  // Stopped while waiting for the address from an App's GitHub page, by a signal or by input that closes (#61):
  // no code was saved, so the next run opens that page again, first asking for the App to be deleted only if
  // the owner had finished that page. The signal's sentence says the same, and nothing asks for a deletion
  // outright. Closed input is a stop like any other (issue #56): its own sentence and a non-zero exit. Each stop
  // after the builder App exists says it is kept.
  for (const [stop, code, why] of [['SIGINT', 130, 'it was interrupted'], ['SIGTERM', 143, 'this server told it to stop'], ['closes', 1, null]]) {
    for (const [kind, waitAt, made, kept] of [['builder', 'builder-callback', ['Forge builder', 'Forge release'], null], ['release', 'release-callback', ['Forge release'], BUILDER_KEPT]]) {
      testCase(stop === 'closes' ? `input closes at the ${kind} App address question` : `${stop} after the ${kind} App page was shown`);
      const root = await mkdtemp(join(tmpdir(), 'forge-signal-page-shown-'));
      const result = await interrupt(root, waitAt, stop);
      const sentence = why
        ? `Setup stopped because ${why} before it finished connecting the ${kind} App; try setup again, which opens the GitHub page for the ${kind} App again, and if you had already finished that page, delete the ${kind} App it made for owner/repo in your GitHub App settings first.`
        : INPUT_CLOSED;
      assertStopped(result, { code, sentence, kept });
      if (why) assert.equal(result.lines.at(kept ? -3 : -2), `Create the ${kind} App in your browser: https://example.test/Forge ${kind}`);
      assert(!result.lines.some(line => line.includes('pick up from what it had already done')));
      const next = await nextSetup(root);
      assert.equal(next.error, undefined);
      assert.deepEqual(next.manifests, made);
      assert.equal(next.messages[next.messages.indexOf(reopened(kind)) + 1], `Create the ${kind} App in your browser: https://example.test/Forge ${kind}`);
      assert(!next.messages.some(line => line.includes('delete it in your GitHub App settings')));
      assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    }
  }

  // A pending record that cannot be parsed when the signal comes: the next run cannot tell whether GitHub
  // made the App, so it asks for the leftover to be deleted, and the signal's sentence says so first.
  {
    testCase('SIGINT after the builder App page was shown, with a pending record that cannot be parsed');
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-cut-record-'));
    const pendingPath = join(credentialPath(join(root, 'state'), 'owner/repo'), 'builder-app-pending.json');
    const cutRecord = async () => {
      if (!(await isPresent(pendingPath))) return false;
      await writeFile(pendingPath, '{');
      return true;
    };
    const result = await interrupt(root, 'builder-callback', 'SIGINT', { until: cutRecord });
    assertStopped(result, { code: 130, kept: null,
      sentence: 'Setup stopped because it was interrupted before it finished connecting the builder App; if GitHub created a builder App for owner/repo, delete it in your GitHub App settings before you try setup again, as the next setup will ask you to.' });
    const leftover = await nextSetup(root);
    assert.equal(leftover.error?.message, 'leftover-app');
    assert.equal(leftover.messages.at(-1), LEFTOVER_BUILDER);
    assert.deepEqual(leftover.manifests, []);
    assert(!(await isPresent(pendingPath)));
    const next = await nextSetup(root);
    assert.equal(next.error, undefined);
    assert(!next.messages.includes(reopened('builder')));
    assert.deepEqual(next.manifests, ['Forge builder', 'Forge release']);
    assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
  }

  // Killed, terminated or interrupted after GitHub turned the builder App's code into its keys, while its
  // details file is written (#61): the keys are already in the pending record, so the next run finishes that App
  // from them even though GitHub no longer accepts the code, and creates no second App. A terminated or
  // interrupted run says to try again, after saying the builder App, whose keys this server now holds, is kept,
  // and ends within a few seconds though that write never finishes (#82): by its signal, which a shell reports
  // as 143 or 130. A stopped run leaves no temporary of that save behind, when it can end its requests: right
  // after SIGTERM or SIGINT there is none, and after SIGKILL there is exactly one, which the next run's sweep
  // removes (#100). The saved file's content is the credentials either way.
  for (const [signal, sentence] of [['SIGKILL', null], ['SIGTERM', TERMINATED], ['SIGINT', INTERRUPTED]]) {
    testCase(`${signal} while the builder App details are being saved`);
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-details-'));
    const credentialDirectory = join(builderDetails(root), '..');
    const keysSaved = async () => {
      try { return Boolean(JSON.parse(await readFile(join(credentialDirectory, 'builder-app-pending.json'), 'utf8')).credentials); } catch { return false; }
    };
    const result = await interrupt(root, 'builder-details', signal, { until: keysSaved, endsBySignal: Boolean(sentence) });
    if (sentence) {
      assertStopped(result, { code: null, sentence, kept: BUILDER_KEPT });
      assert(result.took < 8000, `the command took ${result.took} ms to end after ${signal}`);
    } else {
      assert(!result.lines.some(line => line.startsWith('Setup stopped because')), result.lines.join('\n'));
    }
    const temporaries = async () => (await readdir(credentialDirectory)).filter(name => name.endsWith('.tmp'));
    // The App record is saved in the project checkout's `.git` (lib/github-apps.mjs), the one swept folder inside
    // the owner's own project: a temporary a killed save of it left there is swept by the next run too (#100).
    const appRecordTemporary = join(root, 'projects', 'owner/repo', '.git', 'godspeed-forge-apps.json.2147483646.tmp');
    await mkdir(join(appRecordTemporary, '..'), { recursive: true });
    await writeFile(appRecordTemporary, '{"apps": []}');
    if (sentence) assert.deepEqual(await temporaries(), [], 'the stopped run left its temporary behind');
    else assert.equal((await temporaries()).length, 1, 'the killed run left no temporary for the next run to sweep');
    const next = await nextSetup(root, undefined, { spentCodes: ['builder-code'] });
    assert.deepEqual(await temporaries(), [], 'the next run left the temporary behind');
    assert(!(await isPresent(appRecordTemporary)), 'the next run left the App record temporary in the project checkout');
    assert.equal(next.error, undefined);
    assert(!next.messages.some(line => line.includes('delete')), next.messages.join('\n'));
    assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    assert.deepEqual(next.manifests, ['Forge release']);
    assert.deepEqual(JSON.parse(await readFile(builderDetails(root), 'utf8')), credentials);
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

  // The builder App is made, then input closes at the release App's address question. The owner deletes the
  // builder App on GitHub, and the next run stops the same way before it asks GitHub about that App (#90). Its
  // kept-Apps line says only that setup kept the App's details and checks whether the App is still on the
  // owner's GitHub account, never that the deleted App is there.
  {
    testCase('a stop after the owner deleted a saved App on GitHub does not say that App is there');
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-deleted-app-'));
    const first = await interrupt(root, 'release-callback', 'closes');
    assertStopped(first, { code: 1, sentence: INPUT_CLOSED, kept: BUILDER_KEPT });
    // Setup asks GitHub about every App it holds before it shows any App page, so the stop has to come
    // before that: here, while it downloads the build tools.
    const second = await interrupt(root, 'download', 'SIGINT', { deleted: ['builder'] });
    assert.equal(second.stderr, '', 'setup asked GitHub about the deleted App before it stopped');
    assert.equal(second.code, 130);
    assert.deepEqual(second.lines, [
      'Using Claude Code to set up the Forge.',
      BUILDER_KEPT,
      INTERRUPTED
    ]);
    assert(!second.lines.some(line => /already on your GitHub account|kept there/.test(line)));
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

  // Stopped at "Who uses it?" after "What is this software for?" was answered, by a signal or by input that
  // closes: the first answer is kept, so the next run asks only the second question and MISSION.md holds the
  // first answer from the stopped run with the second answer from the next one.
  for (const [stop, code, sentence] of [['SIGINT', 130, INTERRUPTED], ['SIGTERM', 143, TERMINATED], ['closes', 1, INPUT_CLOSED]]) {
    testCase(`${stop === 'closes' ? 'input closes' : stop} at "Who uses it?" keeps the first mission answer`);
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-second-question-'));
    const result = await interrupt(root, 'users-question', stop);
    assertStopped(result, { code, sentence, kept: APPS_KEPT });
    const next = await nextSetup(root, ['Not asked.', 'Second users.']);
    assert.equal(next.error, undefined);
    assert.deepEqual(next.questions, ['Who uses it?']);
    assert(next.messages.at(-1).startsWith('Setup is complete for owner/repo.'));
    const mission = await readFile(join(root, 'projects/owner/repo/MISSION.md'), 'utf8');
    assert.match(mission, /\n## Project mission\n\nWhat this software is for: Keep releases dependable\.\n\nWho uses it: Second users\.\n$/);
    assert(!mission.includes('Not asked.'));
  }

  // GitHub's App check for the real command: every App it asks about is on GitHub and installed, so the run never
  // reaches the real GitHub. Loaded before the command with --import.
  const GITHUB_STAND_IN = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => ({ status: 200, ok: true, headers: new Headers(), json: async () => ({}) });')}`;

  // The real command in a home folder of its own under root, with the agent, git, gh and the factory commands
  // stood in for on its PATH, and GitHub's answers about an App stood in for by GITHUB_STAND_IN. In a terminal (pty) it runs under script(1). onOutput sees all it printed so far
  // and may answer through the child. Returns what it printed, with a terminal's carriage returns and control
  // sequences taken out, and its exit code.
  async function realCommand(root, onOutput, { pty = false } = {}) {
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
    const command = [process.execPath, `--import=${GITHUB_STAND_IN}`, fileURLToPath(new URL('../bin/godspeed-forge.mjs', import.meta.url)), 'setup', 'owner/repo'];
    const env = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` };
    const child = pty
      ? spawn('script', ['-qec', command.map(word => `'${word}'`).join(' '), '/dev/null'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(command[0], command.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => {
      stdout += data;
      onOutput(stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, ''), child);
    });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const code = await new Promise(resolve => child.once('close', resolve));
    clearTimeout(timer);
    return { stdout: stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, ''), stderr, code };
  }

  // The real command, with input that closes while a later question waits (after the builder App's install
  // answer): it prints no raw Node text, such as a warning about an unsettled top-level await, and stops.
  {
    testCase('input closes at a later question');
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-input-closes-'));
    const credentialDirectory = join(root, '.godspeed/forge/state/credentials/owner/repo');
    await mkdir(credentialDirectory, { recursive: true });
    // A key that signs, so setup's check of the saved builder App reaches the stand-in GitHub.
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
    await writeFile(join(credentialDirectory, 'builder-app.json'), JSON.stringify({ ...credentials, pem }), { mode: 0o600 });
    const { stdout, stderr, code } = await realCommand(root, (printed, child) => {
      if (printed.endsWith('installed only on owner/repo: ')) child.stdin.write('yes\n');
      if (printed.endsWith('or no if it is your personal account: ')) child.stdin.end();
    });
    assert(stdout.includes('Type yes if owner is a GitHub organization'), stdout);
    assert.equal(stderr, '');
    assert(!/Warning|await|\^/.test(stdout), stdout);
    // Closed input is a stop like any other (issue #56): one plain sentence and a non-zero exit.
    assert.equal(stdout.trimEnd().split('\n').at(-1), INPUT_CLOSED, stdout);
    assert.equal(code, 1);
  }

  // A stop at an open question starts on a line of its own, with no blank line after it (#82): the real command
  // signalled with its output piped, and in a terminal where Ctrl-D closes the input or Ctrl-C interrupts.
  const ORG_QUESTION = 'Type yes if owner is a GitHub organization, or no if it is your personal account: ';
  for (const [name, pty, stop, code, sentence] of [
    ['SIGINT', false, child => child.kill('SIGINT'), 130, INTERRUPTED],
    ['SIGTERM', false, child => child.kill('SIGTERM'), 143, TERMINATED],
    ['Ctrl-D in a terminal', true, child => child.stdin.write('\x04'), 1, INPUT_CLOSED],
    ['Ctrl-C in a terminal', true, child => child.stdin.write('\x03'), 130, INTERRUPTED]
  ]) {
    testCase(`${name} at an open question stops on a line of its own`);
    const root = await mkdtemp(join(tmpdir(), 'forge-signal-open-question-'));
    let stopped = false;
    const { stdout, stderr, code: exitCode } = await realCommand(root, (printed, child) => {
      if (!stopped && printed.endsWith(ORG_QUESTION)) { stopped = true; stop(child); }
    }, { pty });
    assert.equal(stdout, `Using Claude Code to set up the Forge.\n${ORG_QUESTION}\n${sentence}\n`);
    assert.equal(stderr, '');
    assert.equal(exitCode, code);
  }

  console.log('setup signal tests pass');
}
