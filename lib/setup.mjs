import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { findSignedInAgent } from './agent.mjs';
import { createApps, moveLegacyCredentials } from './github-apps.mjs';
import { FACTORY_REPOSITORY, FACTORY_REVISION } from './constants.mjs';
import { credentialPath, releaseCostMessage, projectStatePath, writePrivateJson } from './config.mjs';

const NO_SIGNED_IN_AGENT_MESSAGE = 'Setup stopped because neither Claude Code nor Codex is signed in. Sign in to one of them before trying setup again.';
const PREPARATION_MESSAGE = 'Setup stopped because the required files could not be downloaded from GitHub. Restore this server\'s access to GitHub before trying setup again.';
const INITIALIZATION_MESSAGE = 'Setup stopped because the downloaded files could not prepare the project. Fix the problem reported during project preparation before trying setup again.';
const GITHUB_CONNECTION_MESSAGE = 'Setup stopped because the GitHub connection was not completed. Complete the GitHub page before trying setup again.';
const FACTORY_SETTINGS = '.factory/consumer.json';
const FINAL_CHECK_FOUND = 'Setup stopped because the final check found that';
const FINAL_CHECK_GUARD = 'the guard keeping your project\'s hidden test scenarios away from the coding agent';
const FINAL_CHECK_MESSAGES = {
  pythonCommand: `${FINAL_CHECK_FOUND} ${FINAL_CHECK_GUARD} does not work on this server, because the python command there does not run Python 3. Install the python-is-python3 package on this server before trying setup again.`,
  guardOpen: `${FINAL_CHECK_FOUND} ${FINAL_CHECK_GUARD} lets the coding agent read those scenarios on this server. Try setup again, which reinstalls the guard.`,
  guardMissing: `${FINAL_CHECK_FOUND} ${FINAL_CHECK_GUARD} is not fully installed in the project. Try setup again, which installs it.`,
  noBash: `${FINAL_CHECK_FOUND} the bash shell is not installed on this server. Install bash before trying setup again.`,
  settings: `${FINAL_CHECK_FOUND} the project's record of which build tools to use is missing or damaged. Try setup again, which writes that record again.`,
  sourceDamaged: folder => `${FINAL_CHECK_FOUND} the copy of the build tools that setup downloaded to this server is incomplete or has been changed. Delete the folder ${folder} on this server before trying setup again.`,
  pinIncomplete: `${FINAL_CHECK_FOUND} the version of the build tools this Forge installs is missing parts that automatic work needs. Install the latest version of the Forge on this server before trying setup again.`,
  programMissing: program => `${FINAL_CHECK_FOUND} the ${program} program the build tools need is not installed on this server. Install ${program} before trying setup again.`,
  timeout: `${FINAL_CHECK_FOUND} the build tools did not answer in time. Try setup again.`,
  pythonTooOld: `${FINAL_CHECK_FOUND} the Python on this server is too old to run the build tools. Install Python 3.9 or newer before trying setup again.`
};
const FINAL_CHECK_MESSAGE = 'Setup stopped because the final check could not confirm that the build tools setup installed on this server work. Try setup again.';

function appsKeptMessage({ builder, release }) {
  return `Your two GitHub Apps for this repository, "${builder}" and "${release}", are already on your GitHub account and are kept there. Trying setup again uses them instead of creating new ones.`;
}

export class ReportedSetupError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ReportedSetupError';
  }
}

function stopSetup(output, message, reason) {
  output(message);
  throw new ReportedSetupError(reason);
}

// Each pattern matches the start of a refusal the pinned factory's doctor raises (factory/consumer.py at
// FACTORY_REVISION), after its "Factory refused: " prefix. The report itself is never shown to the owner;
// a refusal no pattern knows gets the general message.
const FINAL_CHECK_REFUSALS = [
  [/^Holdout fence is open: (?:a builder reading the scenarios|the verifier reading the scenarios|a builder reading a source file) exited (-?\d+), expected \d+\./,
    match => (match[1] === '127' || match[1] === '1') ? FINAL_CHECK_MESSAGES.pythonCommand : FINAL_CHECK_MESSAGES.guardOpen],
  [/^(?:Holdout fence not registered in |\.ignore does not list )/, () => FINAL_CHECK_MESSAGES.guardMissing],
  [/^No bash to run the holdout fence/, () => FINAL_CHECK_MESSAGES.noBash],
  [/^(?:Integration pin required|Invalid consumer settings|Integration revision must be|Source must use an immutable per-pin directory|'[A-Za-z_]+'\s*$)/,
    () => FINAL_CHECK_MESSAGES.settings],
  [/^(?:Source SHA mismatch|Pinned source has changes|Source authoring directory escapes|Source authoring symlink|Untracked authoring file in pinned source|Incomplete Archon source|Archon dependencies missing)/,
    async (match, checkout) => FINAL_CHECK_MESSAGES.sourceDamaged(await buildToolsFolder(checkout))],
  [/^(?:Pinned CLI missing workflow|Incomplete integration source|Native workflow discovery errors|Native workflow list returned no|Invalid native response|Workflow\/command validation failed)/,
    () => FINAL_CHECK_MESSAGES.pinIncomplete],
  [/^\[Errno 2\] No such file or directory: '(?:[^']*\/)?([A-Za-z0-9][A-Za-z0-9._-]{0,39})'/,
    match => FINAL_CHECK_MESSAGES.programMissing(match[1])],
  [/^Command '.*' timed out after /, () => FINAL_CHECK_MESSAGES.timeout]
];

// The folder holding the downloaded build tools, as the project's factory settings record it.
async function buildToolsFolder(checkout) {
  try {
    const { source } = JSON.parse(await readFile(join(checkout, FACTORY_SETTINGS), 'utf8'));
    if (typeof source === 'string' && isAbsolute(source) && /^[\w./ -]+$/.test(source)) return source;
  } catch {}
  return join(homedir(), '.cache/factory/archon');
}

async function finalCheckMessage(report, checkout) {
  const refusal = report.match(/^Factory refused: (.*)$/m)?.[1];
  if (refusal === undefined) {
    return /has no attribute '(?:is_relative_to|removeprefix)'|^SyntaxError: /m.test(report)
      ? FINAL_CHECK_MESSAGES.pythonTooOld : FINAL_CHECK_MESSAGE;
  }
  for (const [pattern, message] of FINAL_CHECK_REFUSALS) {
    const match = refusal.match(pattern);
    if (match) return message(match, checkout);
  }
  return FINAL_CHECK_MESSAGE;
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
  let apps;
  try {
    apps = await createApps({ repository, stateDirectory, credentialDirectory, github, output });
  } catch {
    stopSetup(output, GITHUB_CONNECTION_MESSAGE, 'github');
  }

  const { purpose, users } = await missionAnswers(join(stateDirectory, 'mission.json'), prompt);
  await recordMission(join(checkout, 'MISSION.md'), purpose, users);

  try {
    await commands.run(python, ['factory/consumer.py', 'doctor'], { cwd: checkout });
  } catch (error) {
    const message = await finalCheckMessage(`${error?.stderr ?? ''}\n${error?.stdout ?? ''}`, checkout);
    output(appsKeptMessage(apps));
    stopSetup(output, message, 'final-check');
  }
  await writePrivateJson(join(stateDirectory, 'registration.json'), { repository, checkout, completed: true });
  const releaseCost = releaseCostMessage(agent, agentName, config.releaseCost);
  output(`Setup is complete for ${repository}. Automatic work is off. ${releaseCost} When you are ready to start automatic work, ask me to turn it on.`);
  return { completed: true, checkout };
}
