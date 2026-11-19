import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACTORY_REVISION } from '../lib/constants.mjs';
import { testCase } from './cases.mjs';
// test cases: 5

// Setup driven the way a chat relay or a script drives it: the real command with its answers piped in (#99).

const INPUT_CLOSED = 'Setup stopped because the place it was reading your answers from closed before you answered. Try setup again and answer each question it asks.';
const ORG_QUESTION = 'Type yes if owner is a GitHub organization, or no if it is your personal account: ';
const ADDRESS_QUESTION = 'After GitHub finishes, paste the address from your browser: ';
const RETRY = 'Setup expects yes or no here, so it asks again.';
const PAGE = /^(Create the (builder|release) App in your browser: )data:text\/html;base64,\S+$/;

// GitHub stood in for, loaded before the command with --import: a manifest code turns into an App named after the
// code, with a key that signs, and every App asked about is on GitHub and installed.
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const GITHUB_STAND_IN = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = async url => ({
  status: 200, ok: true, headers: new Headers(),
  json: async () => {
    const code = /app-manifests\\/([^/]+)\\/conversions/.exec(url)?.[1];
    return code ? { id: code.length, slug: 'forge-' + code, pem: ${JSON.stringify(pem)}, client_secret: 'CLIENT SECRET', webhook_secret: 'WEBHOOK SECRET' } : {};
  }
});`)}`;

// The real command in a home folder of its own, with the agent, git, gh and the factory commands stood in for on
// its PATH and its standard input and output piped. `piped` is written to its input before it starts asking, and
// `onOutput` sees all it printed so far and may answer through the child. Returns what it printed, with each App
// page's long address shortened to <page>, what it wrote to stderr, its exit code and its home folder.
async function pipedSetup({ piped = '', end = true, onOutput = () => {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'forge-piped-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const tools = {
    claude: 'echo signed in',
    gh: 'case "$1" in api) echo "{}";; *) mkdir -p "${@: -1}/.git";; esac',
    git: `case "$1" in remote) echo https://github.com/owner/repo.git;; clone) mkdir -p "\${@: -1}/.git";; rev-parse) echo ${FACTORY_REVISION};; esac`,
    python3: 'if [ "${@: -1}" = init ]; then mkdir -p factory; echo "# Mission" > MISSION.md; fi'
  };
  for (const [name, body] of Object.entries(tools)) {
    await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  }
  const command = [`--import=${GITHUB_STAND_IN}`, fileURLToPath(new URL('../bin/godspeed-forge.mjs', import.meta.url)), 'setup', 'owner/repo'];
  const child = spawn(process.execPath, command, { env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'pipe'] });
  if (piped) child.stdin.write(piped);
  if (end) child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; onOutput(stdout, child); });
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer);
  const lines = stdout.split('\n').map(line => line.replace(PAGE, '$1<page>'));
  return { stdout: lines.join('\n'), raw: stdout, stderr, code, root };
}

{
  testCase('answers piped all at once answer each question in order');
  const answers = ['no', 'https://example.com/?code=builder1', 'yes', 'no', 'https://example.com/?code=release1', 'yes', 'Keep releases dependable.', 'Small teams.'];
  const { stdout, stderr, code, root } = await pipedSetup({ piped: `${answers.join('\n')}\n` });
  const lines = stdout.split('\n');
  const complete = lines.findIndex(line => line.startsWith('Setup is complete for owner/repo.'));
  assert(complete > 0, stdout);
  assert.deepEqual(lines.slice(0, complete), [
    'Using Claude Code to set up the Forge.',
    ORG_QUESTION,
    'Create the builder App in your browser: <page>',
    ADDRESS_QUESTION,
    'Install the builder App and choose only owner/repo: https://github.com/apps/forge-builder1/installations/new',
    'Type yes after the builder App is installed only on owner/repo: ',
    ORG_QUESTION,
    'Create the release App in your browser: <page>',
    ADDRESS_QUESTION,
    'Install the release App and choose only owner/repo: https://github.com/apps/forge-release1/installations/new',
    'Type yes after the release App is installed only on owner/repo: ',
    'What is this software for? ',
    'Who uses it? '
  ], stdout);
  assert.equal(stderr, '');
  assert.equal(code, 0);
  const mission = await readFile(join(root, 'projects/owner/repo/MISSION.md'), 'utf8');
  assert.match(mission, /What this software is for: Keep releases dependable\.\n\nWho uses it: Small teams\.\n$/);
}

{
  testCase('input already closed still prints the question it stops at');
  const { stdout, stderr, code } = await pipedSetup();
  assert.equal(stdout, `Using Claude Code to set up the Forge.\n${ORG_QUESTION}\n${INPUT_CLOSED}\n`);
  assert.equal(stderr, '');
  assert.equal(code, 1);
}

{
  testCase('a piped answer to a waiting question ends its line');
  let answered = false;
  const { stdout, stderr, code } = await pipedSetup({
    end: false,
    onOutput: (printed, child) => {
      if (!answered && printed.endsWith(ORG_QUESTION)) { answered = true; child.stdin.write('no\n'); }
      if (printed.endsWith(ADDRESS_QUESTION)) child.stdin.end();
    }
  });
  assert.equal(stdout, `Using Claude Code to set up the Forge.\n${ORG_QUESTION}\nCreate the builder App in your browser: <page>\n${ADDRESS_QUESTION}\n${INPUT_CLOSED}\n`);
  assert.equal(stderr, '');
  assert.equal(code, 1);
}

// The organization question takes only yes or no; a piped answer that is neither is asked again and opens no App
// page, and input that ends while it waits for yes or no stops setup (#103).
const pageAction = raw => {
  const address = /Create the builder App in your browser: data:text\/html;base64,(\S+)/.exec(raw)?.[1];
  return address && /action="([^"]+)"/.exec(Buffer.from(address, 'base64').toString('utf8'))[1];
};

{
  testCase('a piped y then yes at the organization question opens the organization App page');
  const { stdout, raw, stderr, code } = await pipedSetup({ piped: 'y\nyes\n' });
  assert.equal(stdout, `Using Claude Code to set up the Forge.\n${ORG_QUESTION}\n${RETRY}\n${ORG_QUESTION}\nCreate the builder App in your browser: <page>\n${ADDRESS_QUESTION}\n${INPUT_CLOSED}\n`);
  assert.equal(pageAction(raw), 'https://github.com/organizations/owner/settings/apps/new');
  assert.equal(stderr, '');
  assert.equal(code, 1);
}

{
  testCase('piped input that ends after an answer that is neither yes nor no stops setup with no App page');
  const { stdout, stderr, code } = await pipedSetup({ piped: 'maybe\n' });
  assert.equal(stdout, `Using Claude Code to set up the Forge.\n${ORG_QUESTION}\n${RETRY}\n${ORG_QUESTION}\n${INPUT_CLOSED}\n`);
  assert.equal(stderr, '');
  assert.equal(code, 1);
}
