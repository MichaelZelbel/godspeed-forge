// The owner's side of a scenario, run inside the container against the real Forge: it seeds what setup leaves behind
// for one project, hands the Forge a request the way the chat does, and reads back what the Forge told the owner.
//   node owner.mjs seed                     the project set up, with two Apps whose key is generated here
//   node owner.mjs say <kind> <words> [json]  one chat request through `godspeed-forge inbox`; prints the Forge's answer
//   node owner.mjs factory-issue <title> <body file>  what the factory's manager does: opens an issue as the builder App
//   node owner.mjs notices                  every message the Forge sent the owner, one blank line apart
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mintAppToken } from '/forge/driver/steps/owner/app-token.mjs';
import { githubClient, repoPath } from '/forge/driver/steps/owner/github.mjs';

const home = process.env.HOME;
const repository = 'scenario/sample';
const state = path.join(home, '.godspeed/forge/state');
const workspace = process.env.GODSPEED_WORKSPACE;
const settings = path.join(home, 'settings');
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

function seed() {
  for (const [role, id] of [['builder', 1], ['release', 2]]) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    write(path.join(state, 'credentials', repository, `${role}-app.json`),
      { id, pem: privateKey.export({ type: 'pkcs1', format: 'pem' }), slug: `scenario-${role}` });
  }
  write(path.join(state, 'projects', repository, 'registration.json'),
    { repository, completed: true, checkout: '/scenario/sample', agent: 'codex' });
  fs.mkdirSync(path.join(workspace, '.godspeed'), { recursive: true });
  write(path.join(settings, 'driver.json'), {
    owner: { github_login: 'scenario-owner' },
    server: { factory_user: 'scenario', factory_uid: 10001, factory_home: home, state_dir: path.join(home, 'driver-state') },
    ai: { act_brain_dir: workspace, bins: { codex: 'codex' } },
    forge: { state_dir: state, config: path.join(home, '.godspeed/forge/config.json') },
    steps: { ...Object.fromEntries(['keep-main-green', 'plan', 'question-check', 'questions', 'stage', 'test-machine', 'trust'].map(name => [name, { enabled: false }])),
      'owner-questions': { enabled: true, agent: 'codex' }, 'owner-releases': { enabled: true, work_dir: path.join(home, 'candidates') } }
  });
  write(path.join(settings, 'projects', 'scenario--sample.json'),
    { repository, project: 'sample', checkout: '/scenario/sample', apps: { builder: 'scenario-builder', release: 'scenario-release' }, agent: 'codex' });
}

function say(kind, words, extra = '{}') {
  const id = `${kind}-${Date.now()}`;
  const inbox = path.join(workspace, '.godspeed/forge/inbox');
  write(path.join(inbox, `${id}.json`), { id, kind, project: repository, words, at: new Date().toISOString(), ...JSON.parse(extra) });
  const ran = spawnSync('node', ['/forge/bin/godspeed-forge.mjs', 'inbox'], { encoding: 'utf8', env: process.env });
  if (ran.status !== 0) throw new Error(`The Forge's inbox stopped: ${ran.stdout}${ran.stderr}`);
  const answer = path.join(workspace, '.godspeed/forge/outbox', `${id}.json`);
  if (!fs.existsSync(answer)) throw new Error(`The Forge did not answer the ${kind} request`);
  const { ok, say: said } = JSON.parse(fs.readFileSync(answer, 'utf8'));
  console.log(JSON.stringify({ ok, say: said }));
}

// What the factory's manager does: opens an issue as the project's builder App.
async function factoryIssue(title, bodyFile) {
  const token = await mintAppToken({ credentialDirectory: path.join(state, 'credentials', repository), repository, role: 'builder' });
  const issue = await githubClient({ token }).post(`${repoPath(repository)}/issues`, { title, body: fs.readFileSync(bodyFile, 'utf8') });
  console.log(issue.number);
}

function notices() {
  const file = path.join(workspace, '.godspeed/notices.json');
  const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).notices : [];
  process.stdout.write(list.map(notice => `${notice.text}\n`).join('\n'));
}

const [command, ...args] = process.argv.slice(2);
await ({ seed, say, notices, 'factory-issue': factoryIssue })[command](...args);
