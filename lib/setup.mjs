import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { findSignedInAgent } from './agent.mjs';
import { createApps } from './github-apps.mjs';
import { FACTORY_REPOSITORY, FACTORY_REVISION } from './constants.mjs';
import { projectStatePath, writePrivateJson } from './config.mjs';

const NO_SIGNED_IN_AGENT_MESSAGE = 'Setup stopped because neither Claude Code nor Codex is signed in. Sign in to one of them before trying setup again.';
const GITHUB_CONNECTION_MESSAGE = 'Setup stopped because the GitHub connection was not completed. Complete the GitHub page before trying setup again.';
const FINAL_CHECK_MESSAGE = 'Setup stopped because the final check found a problem. Fix the problem reported by the check before trying setup again.';

export function validateRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.includes('..')) {
    throw new Error('Use a repository name in the form owner/repository.');
  }
  return repository;
}

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

export function repositoryFromRemote(remote) {
  const value = remote.trim().replace(/\.git$/, '');
  const match = value.match(/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/i);
  return match?.[1].toLowerCase() ?? null;
}

export async function prepareCheckout(repository, projectsRoot, commands) {
  const git = commands.names?.git ?? 'git';
  const gh = commands.names?.gh ?? 'gh';
  const target = resolve(projectsRoot, repository);
  if (await pathExists(target)) {
    if (!(await stat(join(target, '.git'))).isDirectory()) throw new Error('The project path exists but is not a Git checkout.');
    const remote = (await commands.run(git, ['remote', 'get-url', 'origin'], { cwd: target })).stdout.trim();
    if (repositoryFromRemote(remote) !== repository.toLowerCase()) {
      throw new Error('The project path belongs to a different repository.');
    }
    return target;
  }
  await mkdir(resolve(projectsRoot, repository.split('/')[0]), { recursive: true });
  await commands.run(gh, ['repo', 'clone', repository, target]);
  return target;
}

async function prepareFactory(cache, commands) {
  const git = commands.names?.git ?? 'git';
  if (!(await pathExists(join(cache, '.git')))) {
    await mkdir(cache, { recursive: true, mode: 0o700 });
    await commands.run(git, ['clone', '--no-checkout', FACTORY_REPOSITORY, cache]);
  }
  await commands.run(git, ['fetch', '--depth', '1', 'origin', FACTORY_REVISION], { cwd: cache });
  await commands.run(git, ['checkout', '--detach', FACTORY_REVISION], { cwd: cache });
  const head = (await commands.run(git, ['rev-parse', 'HEAD'], { cwd: cache })).stdout.trim();
  if (head !== FACTORY_REVISION) throw new Error('The factory revision could not be verified.');
}

async function recordMission(path, purpose, users) {
  const existing = await readFile(path, 'utf8');
  const block = `\n## Project mission\n\nWhat this software is for: ${purpose}\n\nWho uses it: ${users}\n`;
  const updated = existing.includes('## Project mission')
    ? existing.replace(/\n## Project mission\n[\s\S]*$/, block)
    : `${existing.trimEnd()}${block}`;
  await writeFile(path, updated);
}

export async function setupRepository(repository, options) {
  validateRepository(repository);
  const { config, paths, github, prompt, output } = options;
  const commands = { ...options.commands, names: config.commands };
  const agent = await findSignedInAgent(commands.run);
  if (!agent) {
    output(NO_SIGNED_IN_AGENT_MESSAGE);
    return { completed: false, reason: 'agent' };
  }
  output(`Using ${agent} to set up the Forge.`);
  output(config.costMessage);

  const checkout = await prepareCheckout(repository, config.projectsRoot, commands);
  const stateDirectory = projectStatePath(paths.state, repository);
  const factoryCache = join(paths.state, 'factory');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await prepareFactory(factoryCache, commands);
  const python = commands.names?.python ?? 'python3';
  await commands.run(python, [join(factoryCache, 'bin/factory.py'), 'init'], { cwd: checkout });
  try {
    await createApps({ repository, stateDirectory, github, output });
  } catch {
    output(GITHUB_CONNECTION_MESSAGE);
    throw new Error('The Forge setup is incomplete because the GitHub connection was not completed.');
  }

  const purpose = await prompt('What is this software for?');
  const users = await prompt('Who uses it?');
  if (!purpose.trim() || !users.trim()) throw new Error('Both mission answers are required.');
  await recordMission(join(checkout, 'MISSION.md'), purpose.trim(), users.trim());

  try {
    await commands.run(python, ['factory/consumer.py', 'doctor'], { cwd: checkout });
  } catch {
    output(FINAL_CHECK_MESSAGE);
    throw new Error('The Forge setup is incomplete because the factory doctor found a problem.');
  }
  output('The factory doctor found no problems.');
  await writePrivateJson(join(stateDirectory, 'registration.json'), { repository, checkout, completed: true });
  output('The factory schedule remains off. To start it when you are ready, run: python3 factory/consumer.py schedule install --apply');
  return { completed: true, checkout };
}
