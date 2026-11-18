import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { findSignedInAgent } from './agent.mjs';
import { AppSetupStop, createApps, moveLegacyCredentials } from './github-apps.mjs';
import { FACTORY_REPOSITORY, FACTORY_REVISION } from './constants.mjs';
import { credentialPath, releaseCostMessage, projectStatePath, writePrivateJson } from './config.mjs';

const NO_SIGNED_IN_AGENT_MESSAGE = 'Setup stopped because neither Claude Code nor Codex is signed in. Sign in to one of them before trying setup again.';
const PREPARATION_MESSAGE = 'Setup stopped because the required files could not be downloaded from GitHub. Restore this server\'s access to GitHub before trying setup again.';
const INITIALIZATION_MESSAGE = 'Setup stopped because the downloaded files could not prepare the project. Fix the problem reported during project preparation before trying setup again.';
const GITHUB_CONNECTION_MESSAGE = 'Setup stopped because the GitHub connection was not completed. Complete the GitHub page before trying setup again.';
const CREDENTIAL_LOCATION_MESSAGE = 'Setup stopped because this server would not let it save the GitHub App keys in its private folder. Allow setup to write to that folder before trying setup again.';
const FINAL_CHECK_MESSAGE = 'Setup stopped because the final check found a problem. Fix the problem reported by the check before trying setup again.';

export class ReportedSetupError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ReportedSetupError';
  }
}

function appStop({ reason, kind }, repository) {
  if (reason === 'not-writable') return [CREDENTIAL_LOCATION_MESSAGE, 'credential-location'];
  if (reason === 'keys-lost') {
    return [`Setup stopped because this server would not let it save the ${kind} App keys in its private folder, and GitHub hands them out only once. Delete the ${kind} App for ${repository} in your GitHub App settings and allow setup to write to that folder, then try setup again.`, 'lost-app-keys'];
  }
  if (reason === 'leftover') {
    return [`Setup stopped because it could not finish connecting the ${kind} App. If GitHub created a ${kind} App for ${repository}, delete it in your GitHub App settings, then try setup again.`, 'leftover-app'];
  }
  return [`Setup stopped because GitHub could not be reached to finish connecting the ${kind} App. Try setup again; it will finish this App without creating another.`, 'github-pending'];
}

function stopSetup(output, message, reason) {
  output(message);
  throw new ReportedSetupError(reason);
}

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

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function missionAnswers(path, prompt) {
  const stored = await readJson(path);
  if (stored?.purpose && stored?.users) return stored;
  const purpose = (await prompt('What is this software for?')).trim();
  const users = (await prompt('Who uses it?')).trim();
  if (!purpose || !users) throw new Error('Both mission answers are required.');
  await writePrivateJson(path, { purpose, users });
  return { purpose, users };
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
  const stateDirectory = projectStatePath(paths.state, repository);
  const credentialDirectory = credentialPath(paths.state, repository);
  const registration = await readJson(join(stateDirectory, 'registration.json'));
  if (registration?.completed === true && registration.repository === repository) {
    await moveLegacyCredentials({ stateDirectory, credentialDirectory });
    output(`The Forge is already set up for ${repository}.`);
    return { completed: true, alreadySetUp: true, checkout: registration.checkout };
  }
  const agent = await findSignedInAgent(commands.run);
  if (!agent) {
    stopSetup(output, NO_SIGNED_IN_AGENT_MESSAGE, 'agent');
  }
  const agentName = agent === 'claude' ? 'Claude Code' : 'Codex';
  output(`Using ${agentName} to set up the Forge.`);

  const checkout = await prepareCheckout(repository, config.projectsRoot, commands);
  const factoryCache = join(paths.state, 'factory');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  try {
    await prepareFactory(factoryCache, commands);
  } catch {
    stopSetup(output, PREPARATION_MESSAGE, 'preparation');
  }
  const python = commands.names?.python ?? 'python3';
  try {
    await commands.run(python, [join(factoryCache, 'bin/factory.py'), 'init'], { cwd: checkout });
  } catch {
    stopSetup(output, INITIALIZATION_MESSAGE, 'initialization');
  }
  try {
    await createApps({ repository, stateDirectory, credentialDirectory, github, output });
  } catch (error) {
    if (error instanceof AppSetupStop) stopSetup(output, ...appStop(error, repository));
    stopSetup(output, GITHUB_CONNECTION_MESSAGE, 'github');
  }

  const { purpose, users } = await missionAnswers(join(stateDirectory, 'mission.json'), prompt);
  await recordMission(join(checkout, 'MISSION.md'), purpose, users);

  try {
    await commands.run(python, ['factory/consumer.py', 'doctor'], { cwd: checkout });
  } catch {
    stopSetup(output, FINAL_CHECK_MESSAGE, 'final-check');
  }
  await writePrivateJson(join(stateDirectory, 'registration.json'), { repository, checkout, completed: true });
  const releaseCost = releaseCostMessage(agent, agentName, config.releaseCost);
  output(`Setup is complete for ${repository}. Automatic work is off. ${releaseCost} When you are ready to start automatic work, ask me to turn it on.`);
  return { completed: true, checkout };
}
