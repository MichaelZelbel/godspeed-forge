import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { constants, files } from './files.mjs';

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

// The models the factory's AI uses for small, medium and large work, written into Archon's own settings by setup for
// the coding assistant found (Cole Medin's step 2: Sonnet for small and medium work and Opus for large with Claude
// Code; for Codex the models the pinned Archon revision names as its built-in Codex tiers). A config.json written
// before this setting existed has none, and these apply.
export const DEFAULT_FACTORY_MODELS = {
  claude: { small: 'claude-sonnet-5-5', medium: 'claude-sonnet-5-5', large: 'claude-opus-5-5' },
  codex: { small: 'gpt-5.6-luna', medium: 'gpt-5.6-terra', large: 'gpt-5.6-sol' }
};

// The browser tool the factory's checkers drive (agent-browser from npm), pinned like every other version here. A
// config.json written before this setting existed has none, and this applies.
export const DEFAULT_BROWSER = { package: 'agent-browser', version: '0.44.0' };

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
    factoryModels: DEFAULT_FACTORY_MODELS,
    browser: DEFAULT_BROWSER,
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

export async function readConfig(path) {
  const value = JSON.parse(await files.readFile(path, 'utf8'));
  assertNoSecrets(value);
  return value;
}

export function projectStatePath(stateRoot, repository) {
  return join(stateRoot, 'projects', repository);
}

export function credentialPath(stateRoot, repository) {
  return join(stateRoot, 'credentials', repository);
}

// One owner of the temporary's name (#100): the temporary of a save of `saved` is `saved` with the writing
// process's id before `.tmp`, and every private save's name ends in `.json`, which is what keeps the sweep
// off the saved file itself and away from git's own files in the checkout's `.git`. The writer builds the
// name with temporaryName; the sweep parses it with a pattern built from the same pieces, so the two cannot
// drift apart.
const SAVED_SUFFIX = '.json';
const TEMPORARY_SUFFIX = '.tmp';

function temporaryName(saved, pid = process.pid) {
  return `${saved}.${pid}${TEMPORARY_SUFFIX}`;
}

// The same shape temporaryName builds: a `.json` saved name, a dot, the writer's pid, `.tmp`.
const TEMPORARY = new RegExp(`^(?<saved>.+\\${SAVED_SUFFIX})\\.(?<pid>\\d+)\\${TEMPORARY_SUFFIX}$`);

// The temporaries of saves that have started and not settled, so a stopped run can unlink its own.
const saving = new Set();

// Removing a temporary is best effort: it must never turn a failed save into a different failure.
async function discardTemporary(path) {
  await files.unlink(path).catch(() => {});
}

// `keepOnStop` marks a save of data that cannot be obtained again (an App's single-use code or keys): a
// stopped run lets it finish instead of unlinking its temporary.
export async function writePrivateJson(path, value, { keepOnStop = false } = {}) {
  const temporary = temporaryName(path);
  if (!keepOnStop) saving.add(temporary);
  try {
    await files.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await files.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await files.rename(temporary, path);
  } catch (error) {
    await discardTemporary(temporary);
    throw error;
  } finally {
    saving.delete(temporary);
  }
}

// Unlinks the temporaries of this run's saves still in flight, so a stopped run leaves none behind when it
// can. Not awaited by its caller, whose wait for pending requests lets the unlinks finish before exit.
export function abandonSaves() {
  return Promise.all([...saving].map(discardTemporary));
}

// A temporary of a save whose writer is gone, judging by the pid in its name.
function writerGone(pid, path) {
  if (pid === process.pid) return !saving.has(path);
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === 'ESRCH';
  }
  return false;
}

// Removes the temporaries of saves whose process is gone from one folder of private saves, before this run
// reads or writes anything there (#100). Never touches a saved file, the temporary of a live save, or a file
// it cannot read or look up; anything else it cannot list, inspect or remove it skips, so junk never stops a
// setup.
export async function removeStaleTemporaries(folder) {
  let names;
  try {
    names = await files.readdir(folder);
  } catch {
    return;
  }
  await Promise.all(names.map(async name => {
    const match = name.match(TEMPORARY);
    if (!match || !writerGone(Number(match.groups.pid), join(folder, name))) return;
    const path = join(folder, name);
    try {
      const entry = await files.lstat(path);
      if (entry.isDirectory() || entry.isSymbolicLink()) return;
      await files.access(path, constants.R_OK);
      await discardTemporary(path);
    } catch {}
  }));
}
