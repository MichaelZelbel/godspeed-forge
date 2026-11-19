import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { files } from './files.mjs';
import { readSavedFile } from './saved-files.mjs';

const SECRET_KEYS = /(?:secret|token|private.?key|app.?id|credential)/i;

// The release-cost estimate setup tells the owner. The numbers and where they come from live here so
// they can be changed in the defaults file without a code change.
export const DEFAULT_RELEASE_COST = {
  message: 'A typical release costs about ${low} to ${high} of {agent} use, based on {basis}. {plan} The Forge adds no separate charge. This is a rough guide, not a quote: a large release can cost more.',
  claude: {
    low: 5,
    high: 40,
    basis: 'Anthropic\'s published average of about $6 a day for one person using Claude Code, with most people under $12, and a release taking one to a few days of that work',
    plan: 'On a Pro or Max plan this comes out of your plan\'s usage limits instead of a separate bill.'
  },
  codex: {
    low: 3,
    high: 25,
    basis: 'OpenAI\'s published usage prices for the Codex models, which are lower than Claude Code\'s, and a release taking one to a few days of agent work',
    plan: 'On a ChatGPT Plus or Pro plan this comes out of your plan\'s usage limits instead of a separate bill.'
  }
};

export function releaseCostMessage(agent, agentName, configured = {}) {
  const message = configured.message ?? DEFAULT_RELEASE_COST.message;
  const estimate = { ...DEFAULT_RELEASE_COST[agent], ...configured[agent] };
  return message.replace(/\{(agent|low|high|basis|plan)\}/g, (_, key) => key === 'agent' ? agentName : String(estimate[key]));
}

export function defaultPaths({ uid = process.getuid?.(), home = homedir(), platform = process.platform } = {}) {
  const system = uid === 0 && platform === 'linux';
  return system
    ? { addon: '/usr/local/lib/godspeed-forge', executable: '/usr/local/bin/godspeed-forge', config: '/etc/godspeed-forge/config.json', state: '/var/lib/godspeed/forge' }
    : { addon: join(home, '.godspeed/addons/godspeed-forge'), executable: join(home, '.local/bin/godspeed-forge'), config: join(home, '.godspeed/forge/config.json'), state: join(home, '.godspeed/forge/state') };
}

export function defaults(home = homedir()) {
  return {
    projectsRoot: join(home, 'projects'),
    releaseCost: DEFAULT_RELEASE_COST,
    commands: { python: 'python3', gh: 'gh', git: 'git' }
  };
}

function assertNoSecrets(value, path = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) {
      throw Object.assign(new Error(`The defaults file cannot contain ${path}${key}.`), { secretField: `${path}${key}` });
    }
    assertNoSecrets(child, `${path}${key}.`);
  }
}

export async function installDefaults(path, value = defaults()) {
  assertNoSecrets(value);
  await files.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await files.open(path, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

// The settings file as readSavedFile finds it. Readable settings that hold a secret throw.
export async function readConfig(path) {
  const saved = await readSavedFile(path);
  if (saved.state === 'readable') assertNoSecrets(saved.value);
  return saved;
}

export function projectStatePath(stateRoot, repository) {
  return join(stateRoot, 'projects', repository);
}

export function credentialPath(stateRoot, repository) {
  return join(stateRoot, 'credentials', repository);
}

export async function writePrivateJson(path, value) {
  await files.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await files.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await files.rename(temporary, path);
}
