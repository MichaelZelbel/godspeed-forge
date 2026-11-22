// The sign-ins setup runs before it downloads anything (lib/signin.mjs), with stand-ins for gh, Claude Code and
// Codex: what is already signed in is reused without a word, a missing sign-in runs the tool's own sign-in and relays
// its link and code in one plain sentence, and each stop says what happened and what to do.
// test cases: 15
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import {
  AGENT_ANSWER_MESSAGE, AGENT_QUESTION, CODE_QUESTION, GITHUB_LOGIN, SIGN_IN_MESSAGES, ensureAgentSignIn, ensureGithubSignIn,
  githubAccess, signIn
} from '../lib/signin.mjs';
import { start } from '../lib/process.mjs';
import { answersFrom, setupRepository } from '../lib/setup.mjs';
import { defaults } from '../lib/config.mjs';
import { FACTORY_REVISION } from '../lib/constants.mjs';
import { testCase } from './cases.mjs';

const REPO = 'owner/repo';
const failed = (stderr, stdout = '') => Object.assign(new Error('failed.'), { stderr, stdout });
const SCOPES = 'HTTP/2.0 200 OK\nX-Oauth-Scopes: gist, read:org, repo, workflow\n\n{}';

// A server: which sign-ins hold, the commands run, the sign-ins started and what each wrote to them.
function server({ github = 'signed-in', claude = true, codex = false, githubAfter = 'signed-in', agentAfter = true, loginCode = 0, agentStarts = true, show = true } = {}) {
  const world = { github, claude, codex, calls: [], started: [], written: [], said: [], asked: [] };
  world.run = async (command, args) => {
    world.calls.push([command, ...args].join(' '));
    if (command === 'gh' && args[0] === 'api') {
      if (world.github === 'no-gh') throw new Error('Could not run gh.');
      if (world.github === 'signed-out') throw failed('To get started with GitHub CLI, please run:  gh auth login\n');
      if (world.github === 'no-access') throw failed('gh: Not Found (HTTP 404)\n');
      if (world.github === 'unreachable') throw failed('error connecting to api.github.com\n');
      if (world.github === 'no-workflow') return { stdout: 'HTTP/2.0 200 OK\nX-Oauth-Scopes: gist, read:org, repo\n\n{}' };
      if (world.github === 'fine-grained') return { stdout: 'HTTP/2.0 200 OK\nContent-Type: application/json\n\n{}' };
      return { stdout: SCOPES };
    }
    if (command === 'gh') return { stdout: '' };
    if (command === 'claude' && args.join(' ') === 'auth status') { if (!world.claude) throw failed('', '{"loggedIn": false}'); return { stdout: '{"loggedIn": true}' }; }
    if (command === 'codex' && args.join(' ') === 'login status') { if (!world.codex) throw failed('Not logged in\n'); return { stdout: 'Logged in using ChatGPT' }; }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
  world.start = (command, args) => {
    world.started.push([command, ...args].join(' '));
    let output = '';
    let ended = false;
    let resolveDone;
    const watchers = new Set();
    const done = new Promise(resolve => { resolveDone = resolve; });
    const say = text => { output += text; for (const watcher of watchers) watcher(output); };
    const end = code => { if (!ended) { ended = true; resolveDone({ code, started: agentStarts || command === 'gh', output }); } };
    const finish = code => { if (command === 'gh') world.github = githubAfter; else world[command] = agentAfter; end(code); };
    setImmediate(() => {
      if (!agentStarts && command !== 'gh') return end(null);
      if (!show) return end(1);
      if (command === 'gh') {
        say('\n! Failed to copy one-time code to clipboard\n! First copy your one-time code: 53E3-7AAD\nOpen this URL to continue in your web browser: https://github.com/login/device\n');
        setImmediate(() => finish(loginCode));
      } else if (command === 'claude') {
        say("Opening browser to sign in…\nIf the browser didn't open, visit:\nhttps://claude.ai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ");
      } else {
        say('\nWelcome to Codex [v0.171.0]\n\n1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   XCSG-TTIER\n\n');
        setImmediate(() => finish(loginCode));
      }
    });
    return {
      watch: watcher => { watchers.add(watcher); watcher(output); return () => watchers.delete(watcher); },
      write: text => { world.written.push(text); if (command === 'claude') setImmediate(() => finish(loginCode)); },
      stop: () => end(null),
      done
    };
  };
  world.output = line => world.said.push(line);
  world.prompt = answers => async question => { world.asked.push(question); return answers.shift(); };
  return world;
}

async function stopOf(promise) {
  try { await promise; } catch (error) { return error.message; }
  return null;
}

testCase('a server signed in to GitHub with the workflow permission and to Claude Code is asked nothing and told nothing');
{
  const w = server();
  assert.equal(await signIn({ repository: REPO, run: w.run, start: w.start, prompt: w.prompt([]), output: w.output }), 'claude');
  assert.deepEqual(w.said, []);
  assert.deepEqual(w.asked, []);
  assert.deepEqual(w.started, []);
  assert.deepEqual(w.calls, ['gh api -i repos/owner/repo', 'gh auth setup-git', 'claude auth status'], 'git is told to push with gh\'s sign-in');
}

testCase('a sign-in that does not report its permissions (a fine-grained token) is taken as it is');
{
  const w = server({ github: 'fine-grained' });
  await ensureGithubSignIn(REPO, { run: w.run, start: w.start, output: w.output });
  assert.deepEqual(w.started, []);
  assert.equal(await githubAccess(REPO, { run: w.run }), 'ok');
}

for (const [state, why] of [['signed-out', 'not signed in'], ['no-workflow', 'signed in without the workflow permission'], ['no-access', 'signed in to an account that cannot reach the repository']]) {
  testCase(`gh ${why} runs GitHub's own device sign-in and relays its code and link in one sentence`);
  const w = server({ github: state });
  await ensureGithubSignIn(REPO, { run: w.run, start: w.start, output: w.output });
  assert.deepEqual(w.started, [`gh ${GITHUB_LOGIN.join(' ')}`]);
  assert.equal(GITHUB_LOGIN.join(' '), 'auth login --hostname github.com --git-protocol https --web --scopes workflow');
  assert.deepEqual(w.said, ['To sign this server in to GitHub, open https://github.com/login/device in your browser and enter the code 53E3-7AAD. Setup goes on by itself once GitHub has accepted it.']);
  assert.deepEqual(w.calls, ['gh api -i repos/owner/repo', 'gh api -i repos/owner/repo', 'gh auth setup-git']);
}

testCase('each GitHub stop says what happened and what to do');
{
  const stops = [
    [{ github: 'no-gh' }, 'Setup stopped because GitHub\'s command line program gh is not installed on this server. Install gh before trying setup again.'],
    [{ github: 'unreachable' }, 'Setup stopped because it could not reach GitHub to check this server\'s GitHub sign-in. Restore this server\'s access to GitHub before trying setup again.'],
    [{ github: 'signed-out', loginCode: 1, githubAfter: 'signed-out' }, 'Setup stopped because the GitHub sign-in was not completed. Try setup again and enter the code it shows on the GitHub page.'],
    [{ github: 'signed-out', show: false }, 'Setup stopped because GitHub\'s sign-in did not show its code. Try setup again.'],
    [{ github: 'signed-out', githubAfter: 'no-access' }, 'Setup stopped because GitHub did not let this server download owner/repo: either it does not exist or this server\'s GitHub sign-in cannot reach it. Check the repository name, or sign in with a GitHub account that can reach owner/repo, before trying setup again.'],
    [{ github: 'signed-out', githubAfter: 'no-workflow' }, 'Setup stopped because this server\'s GitHub sign-in may not change workflow files, which the build tools need. Try setup again and approve that permission on the GitHub page.'],
    [{ github: 'signed-out', githubAfter: 'signed-out' }, 'Setup stopped because this server is still not signed in to GitHub after the sign-in. Try setup again and approve the sign-in on the GitHub page.']
  ];
  for (const [state, message] of stops) {
    const w = server(state);
    assert.equal(await stopOf(ensureGithubSignIn(REPO, { run: w.run, start: w.start, output: w.output })), message, JSON.stringify(state));
  }
}

testCase('neither assistant signed in: the owner picks one, a wrong answer is asked again');
{
  const w = server({ claude: false, codex: false });
  const agent = await ensureAgentSignIn({ run: w.run, start: w.start, prompt: w.prompt(['cursor', ' Claude ', 'the-one-time-code']), output: w.output });
  assert.equal(agent, 'claude');
  assert.equal(AGENT_QUESTION, 'Which coding assistant do you use: type claude for Claude Code or codex for Codex:');
  assert.deepEqual(w.asked, [AGENT_QUESTION, AGENT_QUESTION, CODE_QUESTION]);
  assert.equal(w.said[0], 'Setup expects claude or codex here, so it asks again.');
  assert.equal(AGENT_ANSWER_MESSAGE, w.said[0]);
}

testCase('Claude Code\'s own sign-in: its page is relayed, the pasted code goes to it and is never printed');
{
  const w = server({ claude: false, codex: false });
  const secret = [];
  const promptSecret = async question => { secret.push(question); return 'the-one-time-code'; };
  await ensureAgentSignIn({ run: w.run, start: w.start, prompt: w.prompt(['claude']), promptSecret, output: w.output });
  assert.deepEqual(secret, [CODE_QUESTION], 'the code is asked for with the question that does not show what is typed');
  assert.deepEqual(w.started, ['claude auth login']);
  assert.deepEqual(w.said, ['To sign this server in to Claude Code, open this page in your browser, sign in, and copy the code it shows: https://claude.ai/oauth/authorize?code=true&state=abc']);
  assert.equal(CODE_QUESTION, 'Paste the code here:');
  assert.deepEqual(w.written, ['the-one-time-code\n']);
  assert(!w.said.join('\n').includes('the-one-time-code'));
  assert.deepEqual(w.calls.slice(-1), ['claude auth status'], 'setup checks again after the sign-in');
}

testCase('at a terminal the pasted code is not shown and is kept out of its history; the next question shows what is typed again');
{
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', chunk => { shown += chunk; });
  const readline = createInterface({ input, output, terminal: true });
  const answers = answersFrom(readline);
  const asked = answers.secretQuestion('Paste the code here: ');
  input.write('secret-code-123\r');
  assert.equal(await asked, 'secret-code-123');
  assert(shown.includes('Paste the code here: '), JSON.stringify(shown));
  assert(!shown.includes('secret'), JSON.stringify(shown));
  assert(shown.endsWith('\n'), 'the answer ends its line');
  assert(!readline.history.includes('secret-code-123'));
  const next = answers.question('Who uses it? ');
  input.write('Small teams\r');
  assert.equal(await next, 'Small teams');
  assert(shown.includes('Small teams'), 'an ordinary answer is shown as it is typed');
  readline.close();
  // Input that closes while the code is asked for shows output again, so the stop that follows is seen.
  const closing = createInterface({ input: new PassThrough(), output: new PassThrough(), terminal: true });
  let after = '';
  closing.output.on('data', chunk => { after += chunk; });
  const closingAnswers = answersFrom(closing);
  const waitingCode = closingAnswers.secretQuestion('Paste the code here: ');
  closing.close();
  await assert.rejects(waitingCode);
  closing.output.write('Setup stopped.');
  assert(after.endsWith('Paste the code here: \nSetup stopped.'), JSON.stringify(after));
  const piped = createInterface({ input: new PassThrough(), output: new PassThrough(), terminal: false });
  const pipedAnswers = answersFrom(piped);
  const pipedAsked = pipedAnswers.secretQuestion('Paste the code here: ');
  piped.input.write('piped-code\n');
  assert.equal(await pipedAsked, 'piped-code', 'piped input is read as it comes');
  piped.close();
}

testCase('Codex\'s own device sign-in: its link and code are relayed with the setting that may be needed first');
{
  const w = server({ claude: false, codex: false });
  assert.equal(await ensureAgentSignIn({ run: w.run, start: w.start, prompt: w.prompt(['codex']), output: w.output }), 'codex');
  assert.deepEqual(w.started, ['codex login --device-auth']);
  assert.deepEqual(w.said, ['To sign this server in to Codex, open https://auth.openai.com/codex/device in your browser, sign in and enter the code XCSG-TTIER. If the page does not take the code, first turn on device code sign-in in your ChatGPT security settings. Setup goes on by itself once you are signed in.']);
}

testCase('a server already signed in to Codex only is asked nothing');
{
  const w = server({ claude: false, codex: true });
  assert.equal(await ensureAgentSignIn({ run: w.run, start: w.start, prompt: w.prompt([]), output: w.output }), 'codex');
  assert.deepEqual([w.asked, w.started], [[], []]);
}

testCase('each assistant stop says what happened and what to do');
{
  const cases = [
    [{ claude: false, agentAfter: false }, 'claude', 'Setup stopped because the Claude Code sign-in was not completed. Try setup again and finish signing in on the page it shows.'],
    [{ claude: false, agentAfter: false }, 'codex', 'Setup stopped because the Codex sign-in was not completed. Try setup again and finish signing in on the page it shows.'],
    [{ claude: false, agentStarts: false }, 'claude', 'Setup stopped because Claude Code is not installed on this server. Install Claude Code before trying setup again.'],
    [{ claude: false, show: false }, 'codex', 'Setup stopped because the Codex sign-in did not show its page. Try setup again.']
  ];
  for (const [state, pick, message] of cases) {
    const w = server(state);
    assert.equal(await stopOf(ensureAgentSignIn({ run: w.run, start: w.start, prompt: w.prompt([pick, 'code']), output: w.output })), message, `${pick} ${JSON.stringify(state)}`);
  }
}

testCase('the sign-in messages are plain: at most one link, no dashes, nothing internal');
for (const message of [
  SIGN_IN_MESSAGES.githubLink('https://github.com/login/device', 'AB-CD'), SIGN_IN_MESSAGES.claudeLink('https://claude.ai/x'),
  SIGN_IN_MESSAGES.codexLink('https://auth.openai.com/codex/device', 'AB-CD'), SIGN_IN_MESSAGES.noGh, SIGN_IN_MESSAGES.githubUnreachable,
  SIGN_IN_MESSAGES.githubNotStarted, SIGN_IN_MESSAGES.githubNotCompleted, SIGN_IN_MESSAGES.githubSignedOut, SIGN_IN_MESSAGES.noWorkflow,
  SIGN_IN_MESSAGES.noAccess(REPO), ...['claude', 'codex'].flatMap(a => [SIGN_IN_MESSAGES.agentMissing(a), SIGN_IN_MESSAGES.agentNotStarted(a), SIGN_IN_MESSAGES.agentNotCompleted(a)])
]) {
  assert((message.match(/https?:\/\//g) ?? []).length <= 1, message);
  assert(!/[–—]/.test(message), message);
  assert(!/factory|archon|config|token/i.test(message), message);
}

testCase('the real start runs a sign-in, shows its output as it comes and hands it the pasted code');
{
  const folder = await mkdtemp(join(tmpdir(), 'forge-signin-'));
  const tool = join(folder, 'pretend-login');
  await writeFile(tool, '#!/bin/sh\necho "visit: https://example.test/page"\nprintf "Paste code here if prompted > "\nread code\necho "$code" > "$1"\n');
  await chmod(tool, 0o755);
  const handle = start(tool, [join(folder, 'received')]);
  const seen = await new Promise(resolve => handle.watch(text => { if (/Paste code/.test(text)) resolve(text); }));
  assert.match(seen, /https:\/\/example\.test\/page/);
  handle.write('pasted\n');
  const result = await handle.done;
  assert.equal(result.code, 0);
  assert.equal(await readFile(join(folder, 'received'), 'utf8'), 'pasted\n');
  const missing = await start(join(folder, 'no-such-program')).done;
  assert.equal(missing.started, false);
}

testCase('setup runs the sign-ins before it downloads anything');
{
  const folder = await mkdtemp(join(tmpdir(), 'forge-signin-setup-'));
  const order = [];
  const w = server({ github: 'signed-out', claude: false });
  const run = async (command, args, options = {}) => {
    order.push(`${command} ${args[0]}`);
    if (command === 'gh' && args[0] === 'api') return w.run(command, args);
    if (command === 'claude' || command === 'codex') return w.run(command, args);
    if (command === 'gh' && args[0] === 'auth') return { stdout: '' };
    throw failed('stopped here on purpose\n');
  };
  const said = [];
  await setupRepository(REPO, {
    config: { ...defaults(folder), projectsRoot: join(folder, 'projects') }, paths: { state: join(folder, 'state') }, commands: { run },
    github: {}, prompt: w.prompt(['claude', 'code']), output: line => said.push(line),
    signIn: context => signIn({ ...context, start: w.start })
  }).catch(() => {});
  assert.deepEqual(w.started, [`gh ${GITHUB_LOGIN.join(' ')}`, 'claude auth login']);
  const firstDownload = order.findIndex(step => step === 'gh repo' || step === 'git clone');
  assert(firstDownload > order.lastIndexOf('claude auth'), order.join(', '));
  assert.equal(said[0], 'To sign this server in to GitHub, open https://github.com/login/device in your browser and enter the code 53E3-7AAD. Setup goes on by itself once GitHub has accepted it.');
  assert.equal(said[2], 'Using Claude Code to set up the Forge.');
  assert(FACTORY_REVISION);
}
