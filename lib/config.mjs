import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const SECRET_KEYS = /(?:secret|token|private.?key|app.?id|credential)/i;

export function defaultPaths({ uid = process.getuid?.(), home = homedir(), platform = process.platform } = {}) {
  const system = uid === 0 && platform === 'linux';
  return system
    ? { addon: '/usr/local/lib/godspeed-forge', executable: '/usr/local/bin/godspeed-forge', config: '/etc/godspeed-forge/config.json', state: '/var/lib/godspeed/forge' }
    : { addon: join(home, '.godspeed/addons/godspeed-forge'), executable: join(home, '.local/bin/godspeed-forge'), config: join(home, '.godspeed/forge/config.json'), state: join(home, '.godspeed/forge/state') };
}

export function defaults(home = homedir()) {
  return {
    projectsRoot: join(home, 'projects'),
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
  }
}

export async function readConfig(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  assertNoSecrets(value);
  return value;
}

export function projectStatePath(stateRoot, repository) {
  return join(stateRoot, 'projects', repository);
}

export function releaseStatePath(stateRoot, repository, version) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.includes('..')) {
    throw new Error('The registered repository name is invalid.');
  }
  const slug = version.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error('The release version is invalid.');
  return join(projectStatePath(stateRoot, repository), 'releases', slug);
}

export async function discoverProjects(stateRoot) {
  const projects = [];
  const root = join(stateRoot, 'projects');
  let owners;
  try { owners = await readdir(root, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return projects;
    throw error;
  }
  for (const owner of owners.filter(entry => entry.isDirectory())) {
    const repositories = await readdir(join(root, owner.name), { withFileTypes: true });
    for (const repository of repositories.filter(entry => entry.isDirectory())) {
      const expected = `${owner.name}/${repository.name}`;
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected) || expected.includes('..')) continue;
      try {
        const registration = JSON.parse(await readFile(join(root, expected, 'registration.json'), 'utf8'));
        const checkout = typeof registration.checkout === 'string' && (await stat(registration.checkout)).isDirectory();
        if (registration.completed === true && registration.repository?.toLowerCase() === expected.toLowerCase() && checkout) {
          projects.push({ ...registration, stateDirectory: join(root, expected) });
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
  }
  return projects.sort((a, b) => a.repository.localeCompare(b.repository));
}

export async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
