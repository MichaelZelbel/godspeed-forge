import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import { findSignedInAgent } from './agent.mjs';
import { APP_RECORD, AppSetupStop, AppStepError, checkApps, createApps, discardPending, pendingRecord, savedApps } from './github-apps.mjs';
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
const MISSION_ANSWERS_NOT_SAVED_MESSAGE = 'Setup stopped because it could not save your answers to the mission questions on this server, so they were not kept. Let setup write to the folder where the Forge keeps its settings, then try setup again; it asks those questions again.';
const MISSION_ANSWERS_MESSAGE = 'Setup stopped because both mission questions need an answer: what the software is for and who uses it. Try setup again and answer both.';
const MISSION_FILE_MESSAGES = {
  read: repository => `Setup stopped because it could not read the project's mission in the project folder for ${repository} on this server, so it could not add your answers to the mission questions there. Let setup read and write the files in that project folder, then try setup again.`,
  write: repository => `Setup stopped because it could not save your answers to the mission questions in the project folder for ${repository} on this server. Let setup read and write the files in that project folder, then try setup again.`
};
const MISSION_HEADING = '## Project mission';
const FACTORY_SETTINGS = '.factory/consumer.json';
const BUILD_TOOLS_MISSING_MESSAGE = repository => `Setup stopped because the build tools setup installed in the project folder for ${repository} on this server are missing. Try setup again, which installs them again.`;
const PROJECT_FOLDER_UNREADABLE_MESSAGE = repository => `Setup stopped because it could not look in the project folder for ${repository} on this server. Let setup read that folder before trying setup again.`;
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

// The line before a stop for the Apps whose details this server holds, or null when it holds none.
function appsKeptMessage({ builder, release }) {
  if (builder && release) {
    return `Your two GitHub Apps for this repository, "${builder}" and "${release}", are already on your GitHub account and are kept there. Trying setup again uses them instead of creating new ones.`;
  }
  const name = builder ?? release;
  if (!name) return null;
  return `Your GitHub App "${name}" for this repository is already on your GitHub account and is kept there. Trying setup again uses it instead of creating a new one.`;
}

export class ReportedSetupError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ReportedSetupError';
  }
}

// What setup says when a signal ends it, and the exit code a shell gives a command the signal ended.
const SIGNAL_STOPS = {
  SIGINT: { code: 130, message: 'Setup stopped because it was interrupted; try setup again to pick up from what it had already done.', why: 'it was interrupted' },
  SIGTERM: { code: 143, message: 'Setup stopped because this server told it to stop; try setup again to pick up from what it had already done.', why: 'this server told it to stop' }
};

// The stop sentence for a signal. Once an App's GitHub page was shown, GitHub may have created that App, and
// what the next run does depends on its pending record: with keys saved it stores them, with a code saved it
// tries to finish the App, with neither it opens the page again, and a record it cannot parse it reports as a
// leftover App to delete. The sentence says which.
async function signalStopMessage(signal, shownPage, repository) {
  const { message, why } = SIGNAL_STOPS[signal];
  if (!shownPage) return message;
  const { kind, pendingPath } = shownPage;
  let pending;
  try {
    pending = await pendingRecord(pendingPath, kind);
  } catch {
    return message;
  }
  if (!pending || pending.credentials) return message;
  const start = `Setup stopped because ${why} before it finished connecting the ${kind} App`;
  if (pending.damaged) {
    return `${start}; if GitHub created a ${kind} App for ${repository}, delete it in your GitHub App settings before you try setup again, as the next setup will ask you to.`;
  }
  if (pending.code) {
    return `${start}; try setup again and it will try to finish this App, and if GitHub no longer accepts it, setup will say what to do.`;
  }
  return `${start}; try setup again, which opens the GitHub page for the ${kind} App again, and if you had already finished that page, delete the ${kind} App it made for ${repository} in your GitHub App settings first.`;
}

// Setup ended by a signal (SIGINT or SIGTERM); exitCode is the code the command exits with.
export class SetupInterrupted extends ReportedSetupError {
  constructor(signal) {
    super('interrupted');
    this.name = 'SetupInterrupted';
    this.signal = signal;
    this.exitCode = SIGNAL_STOPS[signal].code;
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
// so each question also ends when the interface closes. A question shown on the interface's output and still
// open then is ended with a line break, so the stop that follows starts on a line of its own.
export function answersFrom(readline) {
  let closed = false;
  let open = 0;
  const whenClosed = new Promise((_, reject) => readline.once('close', () => {
    closed = true;
    if (open > 0) readline.output?.write('\n');
    reject(new InputClosed());
  }));
  whenClosed.catch(() => {});
  return {
    async question(text) {
      if (closed) throw new InputClosed();
      open += 1;
      try {
        return await Promise.race([readline.question(text), whenClosed]);
      } finally {
        open -= 1;
      }
    }
  };
}

// Where saved App details live, as an 'unreadable' stop names them.
const APP_DETAILS_FOLDERS = {
  credentials: () => 'the credentials folder',
  project: repository => `the folder projects/${repository}`
};

// Why setup can no longer use an App whose stop means the next run creates it again.
function unusableClause({ reason, kind, appName }, repository) {
  if (reason === 'recorded') return `the ${kind} App "${appName}" for ${repository} is still on your GitHub account but this server no longer has what setup needs to use it`;
  if (reason === 'gone') return `the ${kind} App for ${repository} is no longer on your GitHub account`;
  if (reason === 'key-rejected') return `GitHub no longer accepts the saved key of the ${kind} App for ${repository}`;
  return `the saved details of the ${kind} App on this server are ${reason}`;
}

function severalClause([first, second], repository) {
  if (first.reason !== second.reason) return `${unusableClause(first, repository)} and ${unusableClause(second, repository)}`;
  if (first.reason === 'recorded') {
    return `the builder App "${first.appName}" and the release App "${second.appName}" for ${repository} are still on your GitHub account but this server no longer has what setup needs to use them`;
  }
  if (first.reason === 'gone') return `the builder and release Apps for ${repository} are no longer on your GitHub account`;
  if (first.reason === 'key-rejected') return `GitHub no longer accepts the saved keys of the builder and release Apps for ${repository}`;
  return `the saved details of the builder and release Apps on this server are ${first.reason}`;
}

function appStop({ reason, kind, folder, stops, appName }, repository) {
  if (reason === 'not-writable') return [CREDENTIAL_LOCATION_MESSAGE, 'credential-location'];
  if (reason === 'recorded') {
    return [`Setup stopped because the ${kind} App "${appName}" for ${repository} is still on your GitHub account, but this server no longer has what setup needs to use it; delete "${appName}" in your GitHub App settings, then try setup again, which creates a new ${kind} App.`, 'app-unusable'];
  }
  if (reason === 'record-unchecked') {
    return [`Setup stopped because GitHub could not be reached to check whether the ${kind} App "${appName}" for ${repository} is still on your GitHub account. Restore this server's access to GitHub before trying setup again.`, 'app-record-check'];
  }
  if (reason === 'record-damaged') {
    return [`Setup stopped because the list of GitHub Apps that setup keeps in the project folder for ${repository} on this server is damaged. Delete the file ${APP_RECORD} in that project folder before trying setup again.`, 'damaged-app-record'];
  }
  if (reason === 'record-unreadable') return [PROJECT_FOLDER_UNREADABLE_MESSAGE(repository), 'project-folder'];
  if (reason === 'record-not-writable') {
    return [`Setup stopped because it could not save the list of GitHub Apps it keeps in the project folder for ${repository} on this server. Let setup write to that project folder before trying setup again.`, 'app-record'];
  }
  if (reason === 'unreadable') {
    return [`Setup stopped because it could not read the saved details of the ${kind} App on this server. Let setup read ${APP_DETAILS_FOLDERS[folder](repository)} in the Forge's private state folder before trying setup again.`, 'unreadable-app'];
  }
  if (reason === 'leftover') {
    return [`Setup stopped because it could not finish connecting the ${kind} App. If GitHub created a ${kind} App for ${repository}, delete it in your GitHub App settings, then try setup again.`, 'leftover-app'];
  }
  if (reason === 'damaged' || reason === 'missing') {
    return [`Setup stopped because ${unusableClause({ reason, kind }, repository)}, so setup can no longer use that App; delete the ${kind} App for ${repository} in your GitHub App settings, then try setup again, which creates a new ${kind} App.`,
      reason === 'damaged' ? 'damaged-app' : 'missing-app-details'];
  }
  if (reason === 'several') {
    return [`Setup stopped because ${severalClause(stops, repository)}, so setup can no longer use either App; delete any builder or release App for ${repository} that your GitHub App settings still list, then try setup again, which creates both Apps again.`, 'apps-unusable'];
  }
  if (reason === 'gone') {
    return [`Setup stopped because the ${kind} App for ${repository} is no longer on your GitHub account. Try setup again, which creates it again; if your GitHub App settings still list a ${kind} App for ${repository}, delete it first.`, 'app-missing'];
  }
  if (reason === 'uninstalled') {
    return [`Setup stopped because the ${kind} App is no longer installed on ${repository}. Try setup again, which asks you to install it again.`, 'app-not-installed'];
  }
  if (reason === 'unchecked') {
    return [`Setup stopped because GitHub could not be reached to check the ${kind} App for ${repository}. Restore this server's access to GitHub before trying setup again.`, 'github-check'];
  }
  if (reason === 'key-rejected') {
    return [`Setup stopped because GitHub no longer accepts the saved key of the ${kind} App for ${repository}. If your GitHub App settings still list a ${kind} App for ${repository}, delete it, then try setup again, which creates it again.`, 'app-key-rejected'];
  }
  if (reason === 'clock') {
    return [`Setup stopped because GitHub did not accept the sign-in of the ${kind} App for ${repository}, as this server's clock is off. Correct this server's clock, then try setup again.`, 'app-clock'];
  }
  if (reason === 'pending') {
    return [`Setup stopped because GitHub could not be reached to finish connecting the ${kind} App. Try setup again; it will try to finish this App, and if GitHub no longer accepts it, setup will say what to do.`, 'github-pending'];
  }
  return [UNEXPECTED_MESSAGE, 'unexpected'];
}

async function stopFor(error, repository, shownPage) {
  if (error instanceof SetupInterrupted) return [await signalStopMessage(error.signal, shownPage, repository), 'interrupted'];
  if (error instanceof SetupStop) return [error.message, error.reason];
  if (error instanceof InputClosed) return [INPUT_CLOSED_MESSAGE, 'input-closed'];
  if (error instanceof AppSetupStop) return appStop(error, repository);
  return [UNEXPECTED_MESSAGE, 'unexpected'];
}

// The one way setup stops: one plain sentence, after the line saying which GitHub Apps are kept whenever this
// server holds the details of one (apps, from savedApps), then a ReportedSetupError naming the reason (the
// SetupInterrupted itself for a signal).
async function reportStop(error, { output, apps = {}, repository, shownPage }) {
  const [message, reason] = await stopFor(error, repository, shownPage);
  const kept = appsKeptMessage(apps);
  if (kept) output(kept);
  output(message);
  throw error instanceof SetupInterrupted ? error : new ReportedSetupError(reason);
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

// apps: the Apps whose details this server holds, for the kept-Apps line, when known.
export async function loadSettings(path, output, apps) {
  try {
    await installDefaults(path);
    return await readConfig(path);
  } catch (error) {
    await reportStop(settingsStop(error), { output, apps: await apps?.() });
  }
}

// The Apps whose details this server holds for repository, or none when its name is not valid.
function appsHeld(repository, paths) {
  if (!isRepositoryName(repository)) return {};
  return savedApps({
    stateDirectory: projectStatePath(paths.state, repository),
    credentialDirectory: credentialPath(paths.state, repository)
  });
}

// Exit code of `godspeed-forge setup`: 0 when setup completed or was already done, 1 when it stopped, and the
// signal's code (130 or 143) when a signal stopped it. options are setupRepository's; without options.config
// the settings are read from paths.config.
export async function setupCommand(repository, options) {
  try {
    const config = options.config
      ?? await loadSettings(options.paths.config, options.output, () => appsHeld(repository, options.paths));
    await setupRepository(repository, { ...options, config });
    return 0;
  } catch (error) {
    if (!(error instanceof ReportedSetupError)) options.output(UNEXPECTED_MESSAGE);
    return error instanceof SetupInterrupted ? error.exitCode : 1;
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

// { value: null } when the file is not saved yet or is empty, { damaged: true } when it is there but does not hold
// valid JSON. Errors reading the file are left to the caller.
async function readSaved(path) {
  let text;
  try {
    text = await files.readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { value: null };
    throw error;
  }
  if (text === '') return { value: null };
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

// mission.json sits in the project state folder, so failing to read or save it is a settings stop. A failed
// save also tells the owner the answers were not kept, because the next run asks them again.
// The first answer is saved as soon as it is given, so a setup stopped at the second question asks only that
// one next time. An empty first answer is not saved.
async function missionAnswers(path, prompt, damagedMessage) {
  const save = answers => onFileError(MISSION_ANSWERS_NOT_SAVED_MESSAGE, 'settings', () => writePrivateJson(path, answers));
  const saved = await onFileError(SETTINGS_MESSAGE, 'settings', () => readSaved(path));
  if (saved.damaged) throw new SetupStop(damagedMessage, 'damaged-settings');
  const stored = saved.value;
  if (stored?.purpose && stored?.users) return stored;
  let purpose = stored?.purpose;
  if (!purpose) {
    purpose = (await prompt('What is this software for?')).trim();
    if (purpose) await save({ purpose });
  }
  const users = (await prompt('Who uses it?')).trim();
  if (!purpose || !users) throw new SetupStop(MISSION_ANSWERS_MESSAGE, 'mission');
  await save({ purpose, users });
  return { purpose, users };
}

// A file system error while reading the mission file becomes the read stop, one while writing it the save stop.
async function recordMission(path, purpose, users, repository) {
  const existing = await onFileError(MISSION_FILE_MESSAGES.read(repository), 'mission-file', () => files.readFile(path, 'utf8'));
  const block = `\n${MISSION_HEADING}\n\nWhat this software is for: ${purpose}\n\nWho uses it: ${users}\n`;
  const updated = existing.includes(MISSION_HEADING)
    ? existing.replace(/\n## Project mission\n[\s\S]*$/, block)
    : `${existing.trimEnd()}${block}`;
  await onFileError(MISSION_FILE_MESSAGES.write(repository), 'mission-file', () => files.writeFile(path, updated));
}

// What a failure while setting up the GitHub Apps stops with.
function appsStop(error) {
  if (error instanceof AppSetupStop || error instanceof InputClosed) return error;
  const stepMessage = error instanceof AppStepError && error.kind ? APP_STEP_MESSAGES[error.step]?.(error.kind) : undefined;
  if (stepMessage) return new SetupStop(stepMessage, 'github');
  if (typeof error?.code === 'string') return new SetupStop(SETTINGS_MESSAGE, 'settings');
  return new SetupStop(GITHUB_CONNECTION_MESSAGE, 'github');
}

// The project still holds the mission setup wrote and passes the final check. Anything unreadable or failing
// is left for the setup pass that follows to repair, or to report as a first run would.
async function finishedProjectWorks(checkout, commands, python) {
  const mission = await files.readFile(join(checkout, 'MISSION.md'), 'utf8').catch(() => '');
  if (!mission.includes(MISSION_HEADING)) return false;
  return commands.run(python, ['factory/consumer.py', 'doctor'], { cwd: checkout }).then(() => true, () => false);
}

// options.interrupted, when given, resolves with the name of a signal (SIGINT or SIGTERM) that ends setup.
// Setup then stops where it is, says so through the one stop path, and rejects with SetupInterrupted. The step
// it was on says nothing more; the caller stops whatever that step had running.
export async function setupRepository(repository, options) {
  // unopenedPage and shownPage: see createApps.
  const progress = { unopenedPage: null, shownPage: null };
  let stopped = false;
  const output = value => { if (!stopped) options.output(value); };
  const interrupted = options.interrupted
    ? options.interrupted.then(signal => { throw new SetupInterrupted(signal); })
    : new Promise(() => {});
  interrupted.catch(() => {});
  try {
    if (!isRepositoryName(repository)) throw new SetupStop(REPOSITORY_NAME_MESSAGE, 'repository-name');
    const release = await holdSetup(options.paths.state, repository);
    if (!release) throw new SetupStop(SETUP_RUNNING_MESSAGE(repository), 'in-progress');
    try {
      return await Promise.race([runSetup(repository, { ...options, output }, progress), interrupted]);
    } catch (error) {
      stopped = true;
      // Stopped before an App page was shown: GitHub made no App, so the next run starts that App afresh.
      if (error instanceof SetupInterrupted && progress.unopenedPage) await discardPending(progress.unopenedPage);
      throw error;
    } finally {
      stopped = true;
      await release();
    }
  } catch (error) {
    stopped = true;
    // Every stop says which Apps are kept, whether this run made them or an earlier one did, installed or not.
    const apps = await appsHeld(repository, options.paths);
    await reportStop(error, { output: options.output, apps, repository, shownPage: progress.shownPage });
  }
}

// The project folder is still a copy of the repository and still holds the settings the build tools wrote:
// true or false, or a stop when the folder cannot be looked in.
async function buildToolsPresent(checkout, repository) {
  if (typeof checkout !== 'string') return false;
  const look = async check => {
    try {
      return await check();
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
      if (typeof error?.code === 'string') throw new SetupStop(PROJECT_FOLDER_UNREADABLE_MESSAGE(repository), 'project-folder');
      throw error;
    }
  };
  if (!(await look(async () => (await files.stat(join(checkout, '.git'))).isDirectory()))) return false;
  return look(async () => { await files.access(join(checkout, FACTORY_SETTINGS), constants.R_OK); return true; });
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
  const python = commands.names?.python ?? 'python3';
  // A finished setup is reported as such only while what it made is still there and works. When an App or the
  // build tools are gone the record of the finished setup goes too and setup stops, so the next run sets up
  // what is missing; when GitHub could not be asked, or refused an App's sign-in because of this server's clock,
  // nothing changes and the next run asks again. An App whose details are damaged goes after the record. When the
  // mission is gone or the final check fails, the record goes and this run sets the project up again, reusing the
  // Apps and the saved mission answers.
  if (registration?.completed === true && registration.repository === repository) {
    // Once per run: an App whose details were unusable already removed the record before its own records went.
    let forgotten = false;
    const forgetFinished = async () => {
      if (forgotten) return;
      await onFileError(SETTINGS_MESSAGE, 'settings', () => files.rm(registrationPath, { force: true }));
      forgotten = true;
    };
    try {
      await checkApps({ repository, stateDirectory, credentialDirectory, github, beforeRemovingDamaged: forgetFinished });
    } catch (error) {
      // An App that is gone, uninstalled, without usable details or whose saved key GitHub no longer accepts: the
      // next run sets it up again. (Damaged or missing details forgot the record before they went.) Any other
      // stop changed nothing, and the next run checks again.
      if (error instanceof AppSetupStop && ['missing', 'damaged', 'several', 'gone', 'key-rejected', 'uninstalled'].includes(error.reason)) {
        await forgetFinished();
      }
      throw error;
    }
    if (!(await buildToolsPresent(registration.checkout, repository))) {
      await forgetFinished();
      throw new SetupStop(BUILD_TOOLS_MISSING_MESSAGE(repository), 'factory-missing');
    }
    if (await finishedProjectWorks(registration.checkout, commands, python)) {
      output(`The Forge is already set up for ${repository}.`);
      return { completed: true, alreadySetUp: true, checkout: registration.checkout };
    }
    await forgetFinished();
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
  await replaceMarkedDownload(stateDirectory);
  try {
    await commands.run(python, [join(factoryCache, 'bin/factory.py'), 'init'], { cwd: checkout });
  } catch {
    throw new SetupStop(INITIALIZATION_MESSAGE, 'initialization');
  }
  try {
    await createApps({ repository, stateDirectory, credentialDirectory, checkout, gh: commands.names?.gh ?? 'gh', github, output, progress });
  } catch (error) {
    throw appsStop(error);
  }

  const { purpose, users } = await missionAnswers(missionPath, prompt, DAMAGED_MESSAGES.mission(repository));
  await recordMission(join(checkout, 'MISSION.md'), purpose, users, repository);

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
