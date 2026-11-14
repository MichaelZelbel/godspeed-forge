import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const SECRET_KEYS = /(?:secret|token|private.?key|app.?id|credential)/i;

export function defaultPaths({ uid = process.getuid?.(), home = homedir(), platform = process.platform } = {}) {
  const system = uid === 0 && platform === 'linux';
  return system
    ? { addon: '/usr/local/lib/godspeed-forge', executable: '/usr/local/bin/godspeed-forge', config: '/etc/godspeed-forge/config.json', state: '/var/lib/godspeed/forge', units: join(home, '.config/systemd/user') }
    : { addon: join(home, '.godspeed/addons/godspeed-forge'), executable: join(home, '.local/bin/godspeed-forge'), config: join(home, '.godspeed/forge/config.json'), state: join(home, '.godspeed/forge/state'), units: join(home, '.config/systemd/user') };
}

export function defaults(home = homedir()) {
  const godspeedRoot = join(home, '.godspeed/workspace');
  return {
    projectsRoot: join(home, 'projects'),
    godspeedRoot,
    costMessage: 'Your signed-in coding agent may use your existing plan while setting up the Forge.',
    commands: { python: 'python3', gh: 'gh', git: 'git' }
  };
}

function assertNoSecrets(value, path = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) throw new Error(`The defaults file cannot contain ${path}${key}.`);
    assertNoSecrets(child, `${path}${key}.`);
  }
}

export async function installDefaults(path, value = defaults()) {
  assertNoSecrets(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readConfig(path);
    const merged = mergeMissing(existing, value);
    if (JSON.stringify(existing) !== JSON.stringify(merged)) await writePrivateJson(path, merged);
  }
}

function mergeMissing(existing, fallback) {
  if (!fallback || typeof fallback !== 'object' || Array.isArray(fallback)) return existing ?? fallback;
  const result = { ...fallback, ...(existing && typeof existing === 'object' ? existing : {}) };
  for (const key of Object.keys(fallback)) result[key] = mergeMissing(existing?.[key], fallback[key]);
  return result;
}

export async function readConfig(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  assertNoSecrets(value);
  return value;
}

export async function readPrivateJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function projectStatePath(stateRoot, repository) {
  return join(stateRoot, 'projects', repository);
}

export async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
