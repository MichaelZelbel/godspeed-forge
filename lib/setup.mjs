import { access, constants, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import { findSignedInAgent } from './agent.mjs';
import { AppStepError, createApps, moveLegacyCredentials } from './github-apps.mjs';
import { holdSetup } from './setup-lock.mjs';
import { FACTORY_REPOSITORY, FACTORY_REVISION } from './constants.mjs';
import {
  credentialPath, installDefaults, readConfig, releaseCostMessage, projectStatePath, writePrivateJson
} from './config.mjs';

const NO_SIGNED_IN_AGENT_MESSAGE = 'Setup stopped because neither Claude Code nor Codex is signed in. Sign in to one of them before trying setup again.';
const DOWNLOAD_MESSAGES = {
  unreachable: 'Setup stopped because it could not download the build tools from GitHub. Restore this server\'s access to GitHub before trying setup again.',
  revision: 'Setup stopped because it could not download the build tools: GitHub no longer has the version of them that this Forge needs. Install the latest version of the Forge on this server before trying setup again.'
};
// git's words when GitHub was reached but does not have the pinned revision.
const REVISION_MISSING = /not our ref|couldn't find remote ref|unadvertised object|no such remote ref/i;
const INITIALIZATION_MESSAGE = 'Setup stopped because the build tools it downloaded could not prepare the project on this server. Install the latest version of the Forge on this server before trying setup again.';
const SETTINGS_MESSAGE = 'Setup stopped because it could not save its settings on this server. Let setup write to the folder where the Forge keeps its settings before trying setup again.';
// A saved file that can be read but no longer holds what setup wrote. The file is named from the Forge's
// private state folder (README: ~/.godspeed/forge/state/, or /var/lib/godspeed/forge/ for root installs),
// never by its full path on this server.
const DAMAGED_MESSAGES = {
  registration: repository => `Setup stopped because the Forge's saved settings for ${repository} on this server are damaged: its record of whether setup finished cannot be read. Delete the file projects/${repository}/registration.json in the Forge's private state folder before trying setup again.`,
  mission: repository => `Setup stopped because the Forge's saved settings for ${repository} on this server are damaged: its saved answers to the mission questions cannot be read. Delete the file projects/${repository}/mission.json in the Forge's private state folder before trying setup again, and setup asks those questions again.`
};
const CHECKOUT_MESSAGES = {
  refused: repository => `Setup stopped because GitHub did not let this server download ${repository}: either it does not exist or this server's GitHub sign-in cannot reach it. Check the repository name, or give this server's GitHub sign-in access to ${repository}, before trying setup again.`,
  download: repository => `Setup stopped because ${repository} could not be downloaded from GitHub. Restore this server's access to GitHub before trying setup again.`,
  notCopy: repository => `Setup stopped because the project folder for ${repository} on this server already exists but does not hold a copy of a repository. Move that folder elsewhere before trying setup again.`,
  otherRepository: repository => `Setup stopped because the project folder for ${repository} on this server holds a copy of a different repository. Move that folder elsewhere before trying setup again.`,
  unknownOrigin: repository => `Setup stopped because the project folder for ${repository} on this server holds a copy that setup cannot match to ${repository} on GitHub. Move that folder elsewhere before trying setup again.`
};
// What gh prints when GitHub answers that the repository is missing or this server's sign-in cannot reach it.
const REPOSITORY_REFUSED = /Could not resolve to a Repository|HTTP 40[134]|gh auth login/i;
const GITHUB_CONNECTION_MESSAGE = 'Setup stopped because the GitHub connection was not completed. Complete the GitHub page before trying setup again.';
const SETUP_RUNNING_MESSAGE = repository => `Setup stopped because another setup for ${repository} is already running on this server. Finish that one first: complete the GitHub page or answer the question it is waiting on.`;
const APP_STEP_MESSAGES = {
  page: kind => `Setup stopped because the GitHub page for creating its ${kind} App was left unfinished, so GitHub did not hand that App over. Try setup again, finish creating the ${kind} App on the GitHub page it opens, and paste the address your browser shows afterwards.`,
  credentials: () => 'Setup stopped because it could not save the details of the GitHub App it just created on this server. Let setup write to the credentials folder in the Forge\'s private state folder before trying setup again.'
};
const MISSION_ANSWERS_MESSAGE = 'Setup stopped because both mission questions need an answer: what the software is for and who uses it. Try setup again and answer both.';
const MISSION_FILE_MESSAGE = 'Setup stopped because it could not save the project\'s mission in the MISSION.md file of the project folder on this server. Let setup read and write that file before trying setup again.';
const FACTORY_SETTINGS = '.factory/consumer.json';
const REPLACE_DOWNLOAD_FILE = 'replace-build-tools.json';
const FINAL_CHECK_FOUND = 'Setup stopped because the final check found that';
const FINAL_CHECK_GUARD = 'the guard keeping your project\'s hidden test scenarios away from the coding agent';
const FINAL_CHECK_MESSAGES = {
  pythonCommand: `${FINAL_CHECK_FOUND} ${FINAL_CHECK_GUARD} does not work on this server, because the python command there does not run Python 3. Install the python-is-python3 package on this server before trying setup again.`,
  guardOpen: `${FINAL_CHECK_FOUND} ${FINAL_CHECK_GUARD} lets the coding agent read those scenarios on this server. Try setup again, which reinstalls the guard.`,
  guardMissing: `${FINAL_CHECK_FOUND} ${FINAL_CHECK_GUARD} is not fully installed in the project. Try setup again, which installs it.`,
  noBash: `${FINAL_CHECK_FOUND} the bash shell is not installed on this server. Install bash before trying setup again.`,
  settings: `${FINAL_CHECK_FOUND} the project's record of which build tools to use is missing or damaged. Try setup again, which writes that record again.`,
  sourceDamaged: `${FINAL_CHECK_FOUND} the copy of the build tools that setup downloaded to this server is incomplete or has been changed. Try setup again, which replaces it with a fresh download.`,
  pinIncomplete: `${FINAL_CHECK_FOUND} the version of the build tools this Forge installs is missing parts that automatic work needs. Install the latest version of the Forge on this server before trying setup again.`,
  programMissing: program => `${FINAL_CHECK_FOUND} the ${program} program the build tools need is not installed on this server. Install ${program} before trying setup again.`,
  sourceMissing: `${FINAL_CHECK_FOUND} the copy of the build tools that setup downloaded to this server is missing or damaged. Try setup again, which downloads it again.`,
  toolsFail: `${FINAL_CHECK_FOUND} the build tools fail when they run on this server. Try setup again, which replaces them with a fresh download.`,
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

// Runs step; a file system error it raises (one carrying a code such as EACCES) becomes the given stop.
async function stopOnFileError(stop, message, reason, step) {
  try {
    return await step();
  } catch (error) {
    if (typeof error?.code === 'string') stop(message, reason);
    throw error;
  }
}

// A file system error while setup reads or writes its own settings.
function withSettings(output, step) {
  return stopOnFileError((message, reason) => stopSetup(output, message, reason), SETTINGS_MESSAGE, 'settings', step);
}

export function loadSettings(path, output) {
  return withSettings(output, async () => {
    await installDefaults(path);
    return readConfig(path);
  });
}

async function prepareStateDirectory(path, output) {
  await withSettings(output, async () => {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await access(path, constants.W_OK);
  });
}

// Each pattern matches the start of a refusal the pinned factory's doctor raises (factory/consumer.py at
// FACTORY_REVISION), after its "Factory refused: " prefix. A folder a command runs in that is missing, or is a
// file, is reported as PosixPath('…'); the doctor runs commands only in the project, which setup has just used,
// and in the downloaded build tools. A failing command is reported as "Command exited N: [its first three
// words]"; the git commands named here are the ones the doctor runs in the downloaded build tools. The report
// itself is never shown to the owner; a refusal no pattern knows gets the general message. A refusal marked
// REPLACE_DOWNLOAD means the downloaded build tools are missing, damaged or failing: the next setup run
// deletes that download before the build tools are installed, so they are downloaded again.
const REPLACE_DOWNLOAD = true;
const FINAL_CHECK_REFUSALS = [
  [/^Holdout fence is open: (?:a builder reading the scenarios|the verifier reading the scenarios|a builder reading a source file) exited (-?\d+), expected \d+\./,
    match => (match[1] === '127' || match[1] === '1') ? FINAL_CHECK_MESSAGES.pythonCommand : FINAL_CHECK_MESSAGES.guardOpen],
  [/^(?:Holdout fence not registered in |\.ignore does not list )/, () => FINAL_CHECK_MESSAGES.guardMissing],
  [/^No bash to run the holdout fence/, () => FINAL_CHECK_MESSAGES.noBash],
  [/^(?:Integration pin required|Invalid consumer settings|Integration revision must be|Source must use an immutable per-pin directory|'[A-Za-z_]+'\s*$)/,
    () => FINAL_CHECK_MESSAGES.settings],
  [/^(?:Source SHA mismatch|Pinned source has changes|Source authoring directory escapes|Source authoring symlink|Untracked authoring file in pinned source|Incomplete Archon source|Archon dependencies missing)/,
    () => FINAL_CHECK_MESSAGES.sourceDamaged, REPLACE_DOWNLOAD],
  [/^(?:Pinned CLI missing workflow|Incomplete integration source|Native workflow discovery errors|Native workflow list returned no|Invalid native response|Workflow\/command validation failed)/,
    () => FINAL_CHECK_MESSAGES.pinIncomplete],
  [/^\[Errno 2\] No such file or directory: '(?:[^']*\/)?([A-Za-z0-9][A-Za-z0-9._-]{0,39})'/,
    match => FINAL_CHECK_MESSAGES.programMissing(match[1])],
  [/^\[Errno (?:2\] No such file or directory|20\] Not a directory): PosixPath\('/,
    () => FINAL_CHECK_MESSAGES.sourceMissing, REPLACE_DOWNLOAD],
  [/^Command exited -?\d+: \['git', '(?:rev-parse', 'HEAD|status', '--porcelain|ls-files)'/,
    () => FINAL_CHECK_MESSAGES.sourceDamaged, REPLACE_DOWNLOAD],
  [/^Command exited -?\d+: \['(?:[^']*[\/\\])?bun(?:\.exe)?'/,
    () => FINAL_CHECK_MESSAGES.toolsFail, REPLACE_DOWNLOAD],
  [/^Command '.*' timed out after /, () => FINAL_CHECK_MESSAGES.timeout]
];

// The folder holding the downloaded build tools, as the project's factory settings record it, or null when
// the record does not name one setup may delete. The pinned factory only accepts a download folder named with
// the full revision it holds, so anything else is not a download and is left alone.
async function buildToolsFolder(checkout) {
  try {
    const { source } = JSON.parse(await readFile(join(checkout, FACTORY_SETTINGS), 'utf8'));
    if (isDownloadFolder(source)) return source;
  } catch {}
  return null;
}

function isDownloadFolder(folder) {
  return typeof folder === 'string' && isAbsolute(folder) && normalize(folder) === folder
    && /^[0-9a-f]{40}$/.test(basename(folder));
}

// { message, replaceDownload } for the doctor's report.
function finalCheckResult(report) {
  const refusal = report.match(/^Factory refused: (.*)$/m)?.[1];
  if (refusal === undefined) {
    return { message: /has no attribute '(?:is_relative_to|removeprefix)'|^SyntaxError: /m.test(report)
      ? FINAL_CHECK_MESSAGES.pythonTooOld : FINAL_CHECK_MESSAGE };
  }
  for (const [pattern, message, replaceDownload = false] of FINAL_CHECK_REFUSALS) {
    const match = refusal.match(pattern);
    if (match) return { message: message(match), replaceDownload };
  }
  return { message: FINAL_CHECK_MESSAGE };
}

// Remembers, in the project's state folder, which download the next setup run replaces. Failing to save it
// leaves that download as it is, and the next final check finds it again.
async function markDownloadForReplacement(stateDirectory, checkout) {
  const folder = await buildToolsFolder(checkout);
  if (folder) await writePrivateJson(join(stateDirectory, REPLACE_DOWNLOAD_FILE), { folder }).catch(() => {});
}

// Deletes the download an earlier final check found missing, damaged or failing, so that installing the build
// tools downloads them again. A download that cannot be deleted is left for the final check to find again.
async function replaceMarkedDownload(stateDirectory) {
  const path = join(stateDirectory, REPLACE_DOWNLOAD_FILE);
  const saved = await readSaved(path).catch(() => ({}));
  if (saved.value === null) return;
  try {
    const folder = saved.value?.folder;
    if (isDownloadFolder(folder)) await rm(folder, { recursive: true, force: true });
    await rm(path, { force: true });
  } catch {}
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

// null when git ran but found no GitHub origin; process.run rejects without stderr only when git could not start.
async function originRepository(git, target, commands) {
  try {
    return repositoryFromRemote((await commands.run(git, ['remote', 'get-url', 'origin'], { cwd: target })).stdout);
  } catch (error) {
    if (!('stderr' in error)) throw error;
    return null;
  }
}

export async function prepareCheckout(repository, projectsRoot, commands, output) {
  const git = commands.names?.git ?? 'git';
  const gh = commands.names?.gh ?? 'gh';
  const target = resolve(projectsRoot, repository);
  if (await pathExists(target)) {
    const copy = await stat(join(target, '.git')).then(entry => entry.isDirectory(), () => false);
    if (!copy) stopSetup(output, CHECKOUT_MESSAGES.notCopy(repository), 'checkout');
    const origin = await originRepository(git, target, commands);
    if (origin === null) stopSetup(output, CHECKOUT_MESSAGES.unknownOrigin(repository), 'checkout');
    if (origin !== repository.toLowerCase()) stopSetup(output, CHECKOUT_MESSAGES.otherRepository(repository), 'checkout');
    return target;
  }
  await mkdir(resolve(projectsRoot, repository.split('/')[0]), { recursive: true });
  try {
    await commands.run(gh, ['repo', 'clone', repository, target]);
  } catch (error) {
    const refused = REPOSITORY_REFUSED.test(`${error?.stderr ?? ''}\n${error?.stdout ?? ''}`);
    stopSetup(output, CHECKOUT_MESSAGES[refused ? 'refused' : 'download'](repository), 'checkout');
  }
  return target;
}

async function downloadFactory(cache, commands) {
  const git = commands.names?.git ?? 'git';
  if (!(await pathExists(join(cache, '.git')))) {
    await mkdir(cache, { recursive: true, mode: 0o700 });
    await commands.run(git, ['clone', '--no-checkout', FACTORY_REPOSITORY, cache]);
  }
  await commands.run(git, ['fetch', '--depth', '1', 'origin', FACTORY_REVISION], { cwd: cache });
  await commands.run(git, ['checkout', '--detach', FACTORY_REVISION], { cwd: cache });
  const head = (await commands.run(git, ['rev-parse', 'HEAD'], { cwd: cache })).stdout.trim();
  if (head !== FACTORY_REVISION) throw Object.assign(new Error('The factory revision could not be verified.'), { revision: true });
}

// The cache is setup's own download folder. A copy an earlier run left behind (an interrupted download, or one
// changed since) can make every later download in it fail, so when it does, setup starts again from nothing.
async function prepareFactory(cache, commands) {
  const existing = await pathExists(join(cache, '.git'));
  try {
    await downloadFactory(cache, commands);
    return;
  } catch (error) {
    if (!existing) throw error;
  }
  await rm(cache, { recursive: true, force: true });
  await downloadFactory(cache, commands);
}

function downloadMessage(error) {
  return error?.revision || REVISION_MISSING.test(`${error?.stderr ?? ''}\n${error?.stdout ?? ''}`)
    ? DOWNLOAD_MESSAGES.revision : DOWNLOAD_MESSAGES.unreachable;
}

// { value: null } when the file is not saved yet, { damaged: true } when it is there but does not hold
// valid JSON. Errors reading the file are left to the caller.
async function readSaved(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { value: null };
    throw error;
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { damaged: true };
  }
}

// Stops, before setup changes anything, when a saved file is damaged. A file that cannot be read at all is
// left to the step that uses it, which reports it as a settings stop.
async function stopIfDamaged(path, output, damagedMessage) {
  const saved = await readSaved(path).catch(() => ({}));
  if (saved.damaged) stopSetup(output, damagedMessage, 'damaged-settings');
}

// mission.json sits in the project state folder, so failing to read or save it is a settings stop.
async function missionAnswers(path, prompt, stop, damagedMessage) {
  const saved = await stopOnFileError(stop, SETTINGS_MESSAGE, 'settings', () => readSaved(path));
  if (saved.damaged) stop(damagedMessage, 'damaged-settings');
  const stored = saved.value;
  if (stored?.purpose && stored?.users) return stored;
  const purpose = (await prompt('What is this software for?')).trim();
  const users = (await prompt('Who uses it?')).trim();
  if (!purpose || !users) stop(MISSION_ANSWERS_MESSAGE, 'mission');
  await stopOnFileError(stop, SETTINGS_MESSAGE, 'settings', () => writePrivateJson(path, { purpose, users }));
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
  const release = await holdSetup(options.paths.state, repository);
  if (!release) stopSetup(options.output, SETUP_RUNNING_MESSAGE(repository), 'in-progress');
  try {
    return await runSetup(repository, options);
  } finally {
    await release();
  }
}

async function runSetup(repository, options) {
  const { config, paths, github, prompt, output } = options;
  const commands = { ...options.commands, names: config.commands };
  const stateDirectory = projectStatePath(paths.state, repository);
  const credentialDirectory = credentialPath(paths.state, repository);
  const registrationPath = join(stateDirectory, 'registration.json');
  const missionPath = join(stateDirectory, 'mission.json');
  // A damaged registration is not a finished setup: it is reported once the opening line is out.
  const registration = (await withSettings(output, () => readSaved(registrationPath))).value;
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
  await stopIfDamaged(registrationPath, output, DAMAGED_MESSAGES.registration(repository));
  await stopIfDamaged(missionPath, output, DAMAGED_MESSAGES.mission(repository));

  await prepareStateDirectory(stateDirectory, output);
  const checkout = await prepareCheckout(repository, config.projectsRoot, commands, output);
  const factoryCache = join(paths.state, 'factory');
  try {
    await prepareFactory(factoryCache, commands);
  } catch (error) {
    stopSetup(output, downloadMessage(error), 'preparation');
  }
  const python = commands.names?.python ?? 'python3';
  await replaceMarkedDownload(stateDirectory);
  try {
    await commands.run(python, [join(factoryCache, 'bin/factory.py'), 'init'], { cwd: checkout });
  } catch {
    stopSetup(output, INITIALIZATION_MESSAGE, 'initialization');
  }
  let apps;
  try {
    apps = await createApps({ repository, stateDirectory, credentialDirectory, github, output });
  } catch (error) {
    const message = error instanceof AppStepError && error.kind ? APP_STEP_MESSAGES[error.step]?.(error.kind) : undefined;
    stopSetup(output, message ?? GITHUB_CONNECTION_MESSAGE, 'github');
  }

  // From here on the Apps are on the owner's GitHub account, so every stop says they are kept.
  const stopKeepingApps = (message, reason) => {
    output(appsKeptMessage(apps));
    stopSetup(output, message, reason);
  };
  const { purpose, users } = await missionAnswers(missionPath, prompt, stopKeepingApps, DAMAGED_MESSAGES.mission(repository));
  await stopOnFileError(stopKeepingApps, MISSION_FILE_MESSAGE, 'mission-file',
    () => recordMission(join(checkout, 'MISSION.md'), purpose, users));

  try {
    await commands.run(python, ['factory/consumer.py', 'doctor'], { cwd: checkout });
  } catch (error) {
    const result = finalCheckResult(`${error?.stderr ?? ''}\n${error?.stdout ?? ''}`);
    if (result.replaceDownload) await markDownloadForReplacement(stateDirectory, checkout);
    stopKeepingApps(result.message, 'final-check');
  }
  await writePrivateJson(join(stateDirectory, 'registration.json'), { repository, checkout, completed: true });
  const releaseCost = releaseCostMessage(agent, agentName, config.releaseCost);
  output(`Setup is complete for ${repository}. Automatic work is off. ${releaseCost} When you are ready to start automatic work, ask me to turn it on.`);
  return { completed: true, checkout };
}
