import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import { findSignedInAgent } from './agent.mjs';
import { AppSetupStop, AppStepError, createApps, moveLegacyCredentials } from './github-apps.mjs';
import { holdSetup } from './setup-lock.mjs';
import { constants, files } from './files.mjs';
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
const CREDENTIAL_LOCATION_MESSAGE = 'Setup stopped because this server would not let it save the GitHub App keys in its private folder. Allow setup to write to that folder before trying setup again.';
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
const REGISTRATION_MESSAGE = 'Setup stopped because it could not record on this server that setup finished. Let setup write to the folder where the Forge keeps its settings before trying setup again.';
const INPUT_CLOSED_MESSAGE = 'Setup stopped because the place it was reading your answers from closed before you answered. Try setup again and answer each question it asks.';
const REPOSITORY_NAME_MESSAGE = 'Setup stopped because the repository name is not in the form owner/repository. Try setup again with a name in that form.';
const SETTINGS_DAMAGED_MESSAGE = 'Setup stopped because the Forge\'s settings file on this server is damaged. Delete config.json in the folder where the Forge keeps its settings before trying setup again, and setup writes a fresh one.';
const SETTINGS_SECRET_MESSAGE = field => `Setup stopped because the Forge's settings file on this server contains ${field}, which must never be kept there. Remove ${field} from config.json in the folder where the Forge keeps its settings before trying setup again.`;
// The stop for any failure no step has named: the owner never sees the failure's own text.
export const UNEXPECTED_MESSAGE = 'Setup stopped because of a problem on this server that setup could not identify. Try setup again.';

function appsKeptMessage({ builder, release }) {
  return `Your two GitHub Apps for this repository, "${builder}" and "${release}", are already on your GitHub account and are kept there. Trying setup again uses them instead of creating new ones.`;
}

export class ReportedSetupError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ReportedSetupError';
  }
}

// A stop a step names: message is the one sentence the owner reads, reason the ReportedSetupError's message.
class SetupStop extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'SetupStop';
    this.reason = reason;
  }
}

// The place setup reads the owner's answers from closed before an answer came.
export class InputClosed extends Error {
  constructor() {
    super('The input closed before an answer was given.');
    this.name = 'InputClosed';
  }
}

// Answers read from a readline/promises interface. Its pending question never settles when the input ends,
// so each question also ends when the interface closes.
export function answersFrom(readline) {
  let closed = false;
  const whenClosed = new Promise((_, reject) => readline.once('close', () => {
    closed = true;
    reject(new InputClosed());
  }));
  whenClosed.catch(() => {});
  return {
    question(text) {
      if (closed) return Promise.reject(new InputClosed());
      return Promise.race([readline.question(text), whenClosed]);
    }
  };
}

// Where saved App details live, as an 'unreadable' stop names them.
const APP_DETAILS_FOLDERS = {
  credentials: () => 'the credentials folder',
  project: repository => `the folder projects/${repository}`
};

function appStop({ reason, kind, folder }, repository) {
  if (reason === 'not-writable') return [CREDENTIAL_LOCATION_MESSAGE, 'credential-location'];
  if (reason === 'unreadable') {
    return [`Setup stopped because it could not read the saved details of the ${kind} App on this server. Let setup read ${APP_DETAILS_FOLDERS[folder](repository)} in the Forge's private state folder before trying setup again.`, 'unreadable-app'];
  }
  if (reason === 'leftover') {
    return [`Setup stopped because it could not finish connecting the ${kind} App. If GitHub created a ${kind} App for ${repository}, delete it in your GitHub App settings, then try setup again.`, 'leftover-app'];
  }
  if (reason === 'damaged') {
    return [`Setup stopped because the saved details of the ${kind} App on this server are damaged. Delete the ${kind} App for ${repository} in your GitHub App settings, then try setup again.`, 'damaged-app'];
  }
  if (reason === 'pending') {
    return [`Setup stopped because GitHub could not be reached to finish connecting the ${kind} App. Try setup again; it will try to finish this App, and if GitHub no longer accepts it, setup will say what to do.`, 'github-pending'];
  }
  return [UNEXPECTED_MESSAGE, 'unexpected'];
}

function stopFor(error, repository) {
  if (error instanceof SetupStop) return [error.message, error.reason];
  if (error instanceof InputClosed) return [INPUT_CLOSED_MESSAGE, 'input-closed'];
  if (error instanceof AppSetupStop) return appStop(error, repository);
  return [UNEXPECTED_MESSAGE, 'unexpected'];
}

// The one way setup stops: one plain sentence, after the line saying the Apps are kept when this run has
// both Apps on the owner's account, then a ReportedSetupError naming the reason.
function reportStop(error, { output, apps, repository }) {
  const [message, reason] = stopFor(error, repository);
  if (apps) output(appsKeptMessage(apps));
  output(message);
  throw new ReportedSetupError(reason);
}

// Runs step; a file system error it raises (one carrying a code such as EACCES) becomes the given stop.
async function onFileError(message, reason, step) {
  try {
    return await step();
  } catch (error) {
    if (typeof error?.code === 'string') throw new SetupStop(message, reason);
    throw error;
  }
}

function settingsStop(error) {
  if (error instanceof SyntaxError) return new SetupStop(SETTINGS_DAMAGED_MESSAGE, 'settings-damaged');
  if (error?.secretField) return new SetupStop(SETTINGS_SECRET_MESSAGE(error.secretField), 'settings-secret');
  if (typeof error?.code === 'string') return new SetupStop(SETTINGS_MESSAGE, 'settings');
  return error;
}

export async function loadSettings(path, output) {
  try {
    await installDefaults(path);
    return await readConfig(path);
  } catch (error) {
    reportStop(settingsStop(error), { output });
  }
}

// Exit code of `godspeed-forge setup`: 0 when setup completed or was already done, 1 when it stopped.
export async function setupCommand(repository, { paths, commands, github, prompt, output }) {
  try {
    const config = await loadSettings(paths.config, output);
    await setupRepository(repository, { config, paths, commands, github, prompt, output });
    return 0;
  } catch (error) {
    if (!(error instanceof ReportedSetupError)) output(UNEXPECTED_MESSAGE);
    return 1;
  }
}

async function prepareStateDirectory(path) {
  await onFileError(SETTINGS_MESSAGE, 'settings', async () => {
    await files.mkdir(path, { recursive: true, mode: 0o700 });
    await files.access(path, constants.W_OK);
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
    const { source } = JSON.parse(await files.readFile(join(checkout, FACTORY_SETTINGS), 'utf8'));
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
    if (isDownloadFolder(folder)) await files.rm(folder, { recursive: true, force: true });
    await files.rm(path, { force: true });
  } catch {}
}

function isRepositoryName(repository) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) && !repository.includes('..');
}

async function pathExists(path) {
  try { await files.access(path); return true; } catch { return false; }
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

export async function prepareCheckout(repository, projectsRoot, commands) {
  const git = commands.names?.git ?? 'git';
  const gh = commands.names?.gh ?? 'gh';
  const target = resolve(projectsRoot, repository);
  if (await pathExists(target)) {
    const copy = await files.stat(join(target, '.git')).then(entry => entry.isDirectory(), () => false);
    if (!copy) throw new SetupStop(CHECKOUT_MESSAGES.notCopy(repository), 'checkout');
    const origin = await originRepository(git, target, commands);
    if (origin === null) throw new SetupStop(CHECKOUT_MESSAGES.unknownOrigin(repository), 'checkout');
    if (origin !== repository.toLowerCase()) throw new SetupStop(CHECKOUT_MESSAGES.otherRepository(repository), 'checkout');
    return target;
  }
  await files.mkdir(resolve(projectsRoot, repository.split('/')[0]), { recursive: true });
  try {
    await commands.run(gh, ['repo', 'clone', repository, target]);
  } catch (error) {
    const refused = REPOSITORY_REFUSED.test(`${error?.stderr ?? ''}\n${error?.stdout ?? ''}`);
    throw new SetupStop(CHECKOUT_MESSAGES[refused ? 'refused' : 'download'](repository), 'checkout');
  }
  return target;
}

async function downloadFactory(cache, commands) {
  const git = commands.names?.git ?? 'git';
  if (!(await pathExists(join(cache, '.git')))) {
    await files.mkdir(cache, { recursive: true, mode: 0o700 });
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
  await files.rm(cache, { recursive: true, force: true });
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
    text = await files.readFile(path, 'utf8');
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
async function stopIfDamaged(path, damagedMessage) {
  const saved = await readSaved(path).catch(() => ({}));
  if (saved.damaged) throw new SetupStop(damagedMessage, 'damaged-settings');
}

// mission.json sits in the project state folder, so failing to read or save it is a settings stop.
async function missionAnswers(path, prompt, damagedMessage) {
  const saved = await onFileError(SETTINGS_MESSAGE, 'settings', () => readSaved(path));
  if (saved.damaged) throw new SetupStop(damagedMessage, 'damaged-settings');
  const stored = saved.value;
  if (stored?.purpose && stored?.users) return stored;
  const purpose = (await prompt('What is this software for?')).trim();
  const users = (await prompt('Who uses it?')).trim();
  if (!purpose || !users) throw new SetupStop(MISSION_ANSWERS_MESSAGE, 'mission');
  await onFileError(SETTINGS_MESSAGE, 'settings', () => writePrivateJson(path, { purpose, users }));
  return { purpose, users };
}

async function recordMission(path, purpose, users) {
  const existing = await files.readFile(path, 'utf8');
  const block = `\n## Project mission\n\nWhat this software is for: ${purpose}\n\nWho uses it: ${users}\n`;
  const updated = existing.includes('## Project mission')
    ? existing.replace(/\n## Project mission\n[\s\S]*$/, block)
    : `${existing.trimEnd()}${block}`;
  await files.writeFile(path, updated);
}

// What a failure while setting up the GitHub Apps stops with.
function appsStop(error) {
  if (error instanceof AppSetupStop || error instanceof InputClosed) return error;
  const stepMessage = error instanceof AppStepError && error.kind ? APP_STEP_MESSAGES[error.step]?.(error.kind) : undefined;
  if (stepMessage) return new SetupStop(stepMessage, 'github');
  if (typeof error?.code === 'string') return new SetupStop(SETTINGS_MESSAGE, 'settings');
  return new SetupStop(GITHUB_CONNECTION_MESSAGE, 'github');
}

export async function setupRepository(repository, options) {
  // apps is set once both GitHub Apps are on the owner's account; from then on every stop says they are kept.
  const progress = {};
  try {
    if (!isRepositoryName(repository)) throw new SetupStop(REPOSITORY_NAME_MESSAGE, 'repository-name');
    const release = await holdSetup(options.paths.state, repository);
    if (!release) throw new SetupStop(SETUP_RUNNING_MESSAGE(repository), 'in-progress');
    try {
      return await runSetup(repository, options, progress);
    } finally {
      await release();
    }
  } catch (error) {
    reportStop(error, { output: options.output, apps: progress.apps, repository });
  }
}

async function runSetup(repository, options, progress) {
  const { config, paths, github, prompt, output } = options;
  const commands = { ...options.commands, names: config.commands };
  const stateDirectory = projectStatePath(paths.state, repository);
  const credentialDirectory = credentialPath(paths.state, repository);
  const registrationPath = join(stateDirectory, 'registration.json');
  const missionPath = join(stateDirectory, 'mission.json');
  // A damaged registration is not a finished setup: it is reported once the opening line is out.
  const registration = (await onFileError(SETTINGS_MESSAGE, 'settings', () => readSaved(registrationPath))).value;
  if (registration?.completed === true && registration.repository === repository) {
    // Setup is no longer finished without an App whose details are damaged, so the registration goes before
    // those details do, and the next run sets that App up again.
    await moveLegacyCredentials({
      stateDirectory, credentialDirectory,
      beforeRemovingDamaged: () => onFileError(SETTINGS_MESSAGE, 'settings', () => files.rm(registrationPath, { force: true }))
    });
    output(`The Forge is already set up for ${repository}.`);
    return { completed: true, alreadySetUp: true, checkout: registration.checkout };
  }
  const agent = await findSignedInAgent(commands.run);
  if (!agent) throw new SetupStop(NO_SIGNED_IN_AGENT_MESSAGE, 'agent');
  const agentName = agent === 'claude' ? 'Claude Code' : 'Codex';
  output(`Using ${agentName} to set up the Forge.`);
  await stopIfDamaged(registrationPath, DAMAGED_MESSAGES.registration(repository));
  await stopIfDamaged(missionPath, DAMAGED_MESSAGES.mission(repository));

  await prepareStateDirectory(stateDirectory);
  const checkout = await prepareCheckout(repository, config.projectsRoot, commands);
  const factoryCache = join(paths.state, 'factory');
  try {
    await prepareFactory(factoryCache, commands);
  } catch (error) {
    throw new SetupStop(downloadMessage(error), 'preparation');
  }
  const python = commands.names?.python ?? 'python3';
  await replaceMarkedDownload(stateDirectory);
  try {
    await commands.run(python, [join(factoryCache, 'bin/factory.py'), 'init'], { cwd: checkout });
  } catch {
    throw new SetupStop(INITIALIZATION_MESSAGE, 'initialization');
  }
  try {
    progress.apps = await createApps({ repository, stateDirectory, credentialDirectory, github, output });
  } catch (error) {
    throw appsStop(error);
  }

  const { purpose, users } = await missionAnswers(missionPath, prompt, DAMAGED_MESSAGES.mission(repository));
  await onFileError(MISSION_FILE_MESSAGE, 'mission-file', () => recordMission(join(checkout, 'MISSION.md'), purpose, users));

  try {
    await commands.run(python, ['factory/consumer.py', 'doctor'], { cwd: checkout });
  } catch (error) {
    const result = finalCheckResult(`${error?.stderr ?? ''}\n${error?.stdout ?? ''}`);
    if (result.replaceDownload) await markDownloadForReplacement(stateDirectory, checkout);
    throw new SetupStop(result.message, 'final-check');
  }
  const releaseCost = releaseCostMessage(agent, agentName, config.releaseCost);
  await onFileError(REGISTRATION_MESSAGE, 'registration',
    () => writePrivateJson(registrationPath, { repository, checkout, completed: true }));
  output(`Setup is complete for ${repository}. Automatic work is off. ${releaseCost} When you are ready to start automatic work, ask me to turn it on.`);
  return { completed: true, checkout };
}
