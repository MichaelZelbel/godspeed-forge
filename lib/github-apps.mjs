import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { writePrivateJson } from './config.mjs';
import { files } from './files.mjs';

// A GitHub App step that stopped for a cause setup can name to the owner: 'page' when the owner left the
// GitHub page for creating an App unfinished, 'credentials' when the App details GitHub handed over could
// not be saved on this server. kind names the App (builder or release) whose step stopped; createApps sets
// it when the step that threw did not know which App it was working on.
export class AppStepError extends Error {
  constructor(cause, message, options) {
    super(message, options);
    this.name = 'AppStepError';
    this.step = cause;
    this.kind = options?.kind;
  }
}

export const APP_PERMISSIONS = Object.freeze({
  builder: Object.freeze({
    contents: 'write', pull_requests: 'write', issues: 'write', actions: 'write',
    checks: 'read', statuses: 'read', metadata: 'read'
  }),
  release: Object.freeze({
    contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read'
  })
});

const PERMISSION_NAMES = Object.freeze({
  contents: 'Contents',
  pull_requests: 'Pull requests',
  issues: 'Issues',
  actions: 'Actions',
  checks: 'Checks',
  statuses: 'Commit statuses',
  metadata: 'Metadata'
});

function permissionList(permissions, access) {
  const names = Object.entries(permissions)
    .filter(([, value]) => value === access)
    .map(([name]) => PERMISSION_NAMES[name]);
  if (names.length === 1) return names[0];
  if (names.length === 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

function permissionSentence(kind, permissions) {
  const write = permissionList(permissions, 'write');
  const read = permissionList(permissions, 'read');
  return `The ${kind} App has repository permissions for ${write} read/write, plus ${read} read.`;
}

export const APP_PERMISSION_DOCUMENTATION = [
  permissionSentence('builder', APP_PERMISSIONS.builder),
  permissionSentence('release', APP_PERMISSIONS.release)
].join(' ');

export function registrationAction(owner, organization) {
  return organization
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
}

export function builderManifest(repository) {
  return manifest('Forge builder', repository, APP_PERMISSIONS.builder);
}

export function releaseManifest(repository) {
  return manifest('Forge release', repository, APP_PERMISSIONS.release);
}

// The name GitHub shows for the App. GitHub App names are unique across all of GitHub (34 characters at most), and
// the plain 'Forge builder' was taken by another account on the first real setup (23 November 2026), so the owner
// and project go into it: 'Forge builder owner repo', or, when that is too long, the owner and five characters
// that stand for the project.
export function githubAppName(name, repository) {
  const [owner = '', repo = ''] = String(repository).split('/');
  const full = `${name} ${owner} ${repo}`;
  if (full.length <= 34) return full;
  const mark = createHash('sha256').update(String(repository).toLowerCase()).digest('hex').slice(0, 5);
  return `${name} ${owner.slice(0, Math.max(1, 34 - name.length - mark.length - 2))} ${mark}`;
}

function manifest(name, repository, permissions) {
  return {
    name,
    githubName: githubAppName(name, repository),
    url: `https://github.com/${repository}`,
    redirect_url: 'http://127.0.0.1/',
    // No hook_attributes: the Forge uses no webhook, and GitHub refuses a manifest whose hook address is not
    // reachable from the internet ("Hook url is not supported because it isn't reachable over the public
    // Internet"), even an inactive one. Found on the first setup against the real GitHub, 23 November 2026.
    public: false,
    default_permissions: permissions,
    default_events: []
  };
}

function validCredentials(value) {
  return value && typeof value === 'object' && value.id && value.pem
    && typeof value.slug === 'string' && value.slug.trim().length > 0;
}

function displayName(credentials, fallback) {
  const name = typeof credentials?.name === 'string' ? credentials.name.trim() : '';
  return name.length > 0 && name.length <= 60 ? name : fallback;
}

async function exists(path) {
  try {
    await files.access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Stored App details that cannot be parsed or lack a required field. path names the damaged file.
class DamagedCredentials extends Error {
  constructor(path) {
    super('Stored App details are damaged.');
    this.name = 'DamagedCredentials';
    this.path = path;
  }
}

// null when nothing is stored at path: no file, an empty one, or a link whose target is gone (read as missing,
// and left in place for the owner to repair). Contents that are not complete App details are damaged.
async function readCredentials(path) {
  let text;
  try {
    text = await files.readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
  if (text === '') return null;
  let credentials;
  try {
    credentials = JSON.parse(text);
  } catch {
    throw new DamagedCredentials(path);
  }
  if (!validCredentials(credentials)) throw new DamagedCredentials(path);
  return credentials;
}

function appFiles(kind, stateDirectory, credentialDirectory) {
  return {
    path: join(credentialDirectory, `${kind}-app.json`),
    legacyPath: join(stateDirectory, `${kind}-app.json`),
    installationPath: join(stateDirectory, `${kind}-installation.json`),
    pendingPath: join(credentialDirectory, `${kind}-app-pending.json`)
  };
}

// Runs a read of saved App details in folder ('credentials', or 'project' for the legacy location); one the
// file system refuses stops as 'unreadable', keeping the file system's code.
async function readIn(folder, kind, read) {
  try {
    return await read();
  } catch (error) {
    if (typeof error?.code !== 'string') throw error;
    throw Object.assign(new AppSetupStop('unreadable', kind, { folder }), { cause: error, code: error.code });
  }
}

async function readStoredCredentials(kind, { path, legacyPath }) {
  const credentials = await readIn('credentials', kind, () => readCredentials(path));
  if (credentials) {
    if (await readIn('project', kind, () => exists(legacyPath))) await files.unlink(legacyPath);
    return credentials;
  }
  const legacy = await readIn('project', kind, () => readCredentials(legacyPath));
  if (!legacy) return null;
  await files.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await files.rename(legacyPath, path);
  return legacy;
}

async function removeIfPresent(path) {
  try {
    await files.unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Removes the record that the App is installed and, with details, its saved details: in that order, so
// details never go while the record stays.
async function forgetApp(kind, locations, { details }) {
  try {
    await removeIfPresent(locations.installationPath);
    if (details) await removeIfPresent(locations.path);
  } catch {
    throw new AppSetupStop('not-writable', kind);
  }
}

// The App's saved details, or null when setup has not made that App yet. Details that are damaged, or gone
// while the record that the App is installed stays, are restored from the keys the pending record still holds.
// Without those keys setup can no longer use that App: the record goes and then the damaged file, so the next
// run creates and installs the App again instead of skipping it or stopping the same way; the record goes
// first because details gone while it stays would let a run skip that App. beforeRemoving runs before
// anything is removed; when it throws, nothing is removed and the next run finds the same problem.
// Details that cannot be read at all stop as 'unreadable', and moving them out of the legacy location as
// 'not-writable'; either stop keeps the file system's code.
async function savedCredentials(kind, locations, beforeRemoving) {
  let damagedPath = null;
  try {
    const credentials = await readStoredCredentials(kind, locations);
    if (credentials) return credentials;
  } catch (error) {
    if (error instanceof AppSetupStop) throw error;
    if (typeof error?.code === 'string') {
      throw Object.assign(new AppSetupStop('not-writable', kind), { cause: error, code: error.code });
    }
    if (!(error instanceof DamagedCredentials)) throw error;
    damagedPath = error.path;
  }
  if (!damagedPath && !(await readIn('credentials', kind, () => exists(locations.installationPath)))) return null;
  const kept = await keptCredentials(locations.pendingPath, kind);
  if (!kept) await beforeRemoving?.();
  try {
    if (kept) {
      await writePrivateJson(locations.path, kept);
      return kept;
    }
    await removeIfPresent(locations.installationPath);
    if (damagedPath) await removeIfPresent(damagedPath);
  } catch {
    throw new AppSetupStop('not-writable', kind);
  }
  throw new AppSetupStop(damagedPath ? 'damaged' : 'missing', kind);
}

// reason 'several' carries in stops the stops of both Apps, when each App has to be created again. folder
// names, for an 'unreadable' stop, where the details are: 'credentials' or 'project'. name is the name of the
// App a stop about setup's list of the Apps it made names.
export class AppSetupStop extends Error {
  constructor(reason, kind, { stops = [], folder, name } = {}) {
    super(reason);
    this.name = 'AppSetupStop';
    this.reason = reason;
    this.kind = kind;
    this.stops = stops;
    this.folder = folder;
    this.appName = name;
  }
}

// Stops after which the next run creates that App again. When both Apps have one, a single stop names both, so
// the owner deletes every App the next run replaces at once; naming only one would leave the other's
// deletion unsaid and that App made twice.
const REMADE = new Set(['missing', 'damaged', 'gone', 'key-rejected', 'recorded']);

function stopFor(stops) {
  const remade = stops.filter(({ reason }) => REMADE.has(reason));
  if (remade.length > 1) return new AppSetupStop('several', remade[0].kind, { stops: remade });
  return remade[0] ?? stops[0];
}

// null when there is no record. A record that cannot be parsed reads as damaged: only an in-place rewrite of
// a record holding a code or keys leaves one, so GitHub created that App, and nothing left can finish it.
async function readPending(path, kind) {
  let text;
  try {
    text = await readIn('credentials', kind, () => files.readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { damaged: true };
  }
}

async function keptCredentials(pendingPath, kind) {
  const pending = await readPending(pendingPath, kind);
  return validCredentials(pending?.credentials) ? pending.credentials : null;
}

// Best effort: a record that stays behind holds a spent code. The next run removes it once credentials
// are stored, or reports the leftover App when GitHub refuses the code.
export async function discardPending(pendingPath) {
  await files.rm(pendingPath, { force: true }).catch(() => {});
}

// Replaces the contents of an existing private file in place. Unlike `writePrivateJson` it creates,
// renames and removes nothing, so it still works in a folder that no longer accepts new files.
async function overwritePrivateJson(path, value) {
  const handle = await files.open(path, 'r+');
  try {
    await handle.truncate(0);
    await handle.write(`${JSON.stringify(value, null, 2)}\n`, 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function updatePending(pendingPath, value) {
  try {
    await writePrivateJson(pendingPath, value);
  } catch {
    await overwritePrivateJson(pendingPath, value);
  }
}

async function storeCredentials(path, credentials, kind) {
  try {
    await writePrivateJson(path, credentials);
  } catch (error) {
    throw new AppStepError('credentials', `The ${kind} App credentials could not be saved.`, { cause: error, kind });
  }
}

async function stopForLeftover(pendingPath, kind) {
  try {
    await files.unlink(pendingPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new AppSetupStop('not-writable', kind);
  }
  throw new AppSetupStop('leftover', kind);
}

// The pending record (`{ code }`) exists from just before the owner is sent to GitHub until the
// App's credentials are stored, so a retry finishes that App instead of creating a second one.
// Its first write is also the check that the private credential location can be written. A record an earlier
// run left without a code means its page was shown but no address came back: the page opens again, after a
// line asking the owner to delete the App first if they had finished that page, since GitHub then made one
// setup never received. Such a record stays until the App is finished, so every later run says that too.
// Once GitHub turns the code into keys, the keys go into the record before the details file is written, so
// whatever stops setup from there, the next run stores them instead of being refused the spent code.
// progress.unopenedPage names a record this run wrote while the page has not been shown yet, so a setup
// that is stopped in that window can remove it: GitHub cannot have created an App before the page opened.
// progress.shownPage names the App ({ kind, pendingPath }) from when its page is shown until its credentials
// are stored, so a stopped setup can say what the next run will do with that record.
async function createApp({ kind, repository, manifest, path, pendingPath, github, output, progress = {} }) {
  let pending = await readPending(pendingPath, kind);
  if (pending?.damaged) await stopForLeftover(pendingPath, kind);
  if (pending?.credentials) {
    // An earlier run exchanged the code but did not store the keys; they wait in the pending record, and
    // createApps has confirmed that their App is still on GitHub.
    if (!validCredentials(pending.credentials)) await stopForLeftover(pendingPath, kind);
    await storeCredentials(path, pending.credentials, kind);
    return pending.credentials;
  }
  if (!pending?.code) {
    const reopened = Boolean(pending);
    try {
      await writePrivateJson(pendingPath, { code: null });
    } catch {
      throw new AppSetupStop('not-writable', kind);
    }
    if (!reopened) progress.unopenedPage = pendingPath;
    let flow;
    try {
      flow = await github.begin(manifest);
    } catch (error) {
      progress.unopenedPage = null;
      if (!reopened) await files.unlink(pendingPath).catch(() => {});
      throw error;
    }
    progress.unopenedPage = null;
    progress.shownPage = { kind, pendingPath };
    if (reopened) output(`If you finished the GitHub page for the ${kind} App during an earlier setup, delete the ${kind} App it made for ${repository} in your GitHub App settings before you create it again.`);
    output(`Create the ${kind} App in your browser: ${flow.url}`);
    let code;
    try {
      code = await github.callback(flow);
      if (!code) throw new AppStepError('page', 'The GitHub callback address did not contain a temporary code.');
    } catch (error) {
      // An address without GitHub's code means the page was left unfinished and GitHub created no App,
      // so the record this run wrote goes and the next run opens the page again.
      if (error instanceof AppStepError) {
        error.kind ??= kind;
        if (!reopened) await discardPending(pendingPath);
      }
      throw error;
    }
    try {
      await updatePending(pendingPath, { code });
    } catch {
      await stopForLeftover(pendingPath, kind);
    }
    pending = { code };
  }
  let credentials;
  try {
    credentials = await github.exchange(pending.code);
  } catch (error) {
    if (error.refused) await stopForLeftover(pendingPath, kind);
    throw new AppSetupStop('pending', kind);
  }
  if (!validCredentials(credentials)) throw new Error(`GitHub did not return the ${kind} App credentials.`);
  // Best effort: if the record cannot hold the keys either, it keeps the spent code, and the next run that
  // can write is refused by GitHub, says once to delete the leftover App, and removes the record.
  try {
    await updatePending(pendingPath, { code: pending.code, credentials });
  } catch {}
  await storeCredentials(path, credentials, kind);
  return credentials;
}

// Before setup uses an App this server holds, from saved details or keys an earlier run left in the pending
// record, GitHub is asked whether that App still exists: the owner may have deleted it on GitHub since, or this
// server's state may be an older copy. While GitHub cannot answer or refuses the request, nothing goes and the
// next run asks again. When the App is gone, its records and keys go, so the next run creates that App again
// instead of using one GitHub no longer has. When it is no longer installed, the record that it is installed
// goes, so this run asks the owner to install it again.
async function confirmHeldApp(kind, locations, held, { github, repository }) {
  if (!held) return;
  let status;
  try {
    status = await github.appStatus({ credentials: held, repository, kind });
  } catch (error) {
    throw new AppSetupStop(error?.refused ? 'refused' : 'unchecked', kind);
  }
  if (status === 'clock-rejected') throw new AppSetupStop('clock', kind);
  if (status === 'not-installed') await forgetApp(kind, locations, { details: false });
  if (status !== 'app-missing' && status !== 'key-rejected') return;
  await forgetApp(kind, locations, { details: true });
  try {
    await removeIfPresent(locations.pendingPath);
  } catch {
    throw new AppSetupStop('not-writable', kind);
  }
  throw new AppSetupStop(status === 'key-rejected' ? 'key-rejected' : 'gone', kind);
}

// setup's list of the Apps it made for a repository, one per role ({ builder, release }, each { name, slug, id }
// and never a key). It lives in the project checkout's .git folder, outside the Forge's private state folder,
// so it outlasts that state being lost or restored from an older copy, and git never commits it.
export const APP_RECORD = '.git/godspeed-forge-apps.json';

function validRecordEntry(entry) {
  return Boolean(entry) && typeof entry === 'object' && typeof entry.name === 'string'
    && typeof entry.slug === 'string' && entry.slug.trim().length > 0
    && (typeof entry.id === 'number' || (typeof entry.id === 'string' && entry.id.length > 0));
}

function validRecord(record) {
  return Boolean(record) && typeof record === 'object' && !Array.isArray(record)
    && Object.entries(record).every(([kind, entry]) => (kind === 'builder' || kind === 'release') && validRecordEntry(entry));
}

// {} when there is no list yet: no file, an empty one, or a link whose target is gone. A list that cannot be
// parsed is never guessed at or written over: the owner is asked to delete it.
async function readAppRecord(path) {
  let text;
  try {
    text = await files.readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return {};
    throw new AppSetupStop('record-unreadable');
  }
  if (text === '') return {};
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new AppSetupStop('record-damaged');
  }
  if (!validRecord(record)) throw new AppSetupStop('record-damaged');
  return record;
}

async function writeAppRecord(path, record) {
  try {
    await writePrivateJson(path, record);
  } catch {
    throw new AppSetupStop('record-not-writable');
  }
}

const recordEntry = (credentials, fallbackName) => ({
  name: displayName(credentials, fallbackName), slug: credentials.slug, id: credentials.id
});

const sameApp = (credentials, entry) => String(credentials.id) === String(entry.id) && credentials.slug === entry.slug;

// Brings the list's entry for kind up to date with held, the App whose details or kept keys this server holds
// (null when none). An App the list names that is not held is looked up on GitHub first: still there, setup can
// no longer use it, and creating the role's App again would leave two, so setup stops naming it; gone, the list
// forgets it. A held App other than the listed one (state restored from an older copy) is looked up too before
// that stop: gone, its records go as well, so once the owner deletes the listed App the next run creates the
// role's App again instead of keeping one GitHub no longer has. GitHub's answer is never guessed: when it cannot
// be asked, or refuses to answer, setup stops and changes nothing.
async function checkRecorded(kind, held, record, locations, { github, gh, fallbackName }) {
  const recorded = record[kind];
  if (recorded && !(held && sameApp(held, recorded))) {
    if (await onGithub(kind, recorded, { github, gh })) {
      if (held && !(await onGithub(kind, recordEntry(held, fallbackName), { github, gh }))) {
        await forgetApp(kind, locations, { details: true });
        try {
          await removeIfPresent(locations.pendingPath);
        } catch {
          throw new AppSetupStop('not-writable', kind);
        }
      }
      throw new AppSetupStop('recorded', kind, { name: recorded.name });
    }
  }
  if (held) record[kind] = recordEntry(held, fallbackName);
  else delete record[kind];
}

async function onGithub(kind, app, { github, gh }) {
  try {
    return await github.appExists({ slug: app.slug, gh });
  } catch (error) {
    throw new AppSetupStop(error?.refused ? 'record-refused' : 'record-unchecked', kind, { name: app.name });
  }
}

// Every App whose saved details are unusable, whose kept keys belong to an App no longer on GitHub, or that
// setup's list names while this server can no longer use it, is reported in one stop before anything is
// created, so the owner deletes each App the next run creates again at once. Finding such an App already
// removed its records, so its stop wins over a later App's other failure: lost, the next run would make that
// App twice. Each App created is added to the list before it is installed. gh is the command that asks GitHub
// about an App on the list.
export async function createApps({ repository, stateDirectory, credentialDirectory, checkout, gh = 'gh', github, output, progress }) {
  const recordPath = join(checkout, APP_RECORD);
  const record = await readAppRecord(recordPath);
  const recordedBefore = JSON.stringify(record);
  const apps = [];
  const stops = [];
  for (const [kind, manifest] of [['builder', builderManifest(repository)], ['release', releaseManifest(repository)]]) {
    const locations = appFiles(kind, stateDirectory, credentialDirectory);
    let credentials = null;
    try {
      credentials = await savedCredentials(kind, locations);
      const held = credentials ?? await keptCredentials(locations.pendingPath, kind);
      await checkRecorded(kind, held, record, locations, { github, gh, fallbackName: manifest.name });
      await confirmHeldApp(kind, locations, held, { github, repository });
    } catch (error) {
      if (!(error instanceof AppSetupStop && REMADE.has(error.reason))) throw stops.length ? stopFor(stops) : error;
      stops.push(error);
    }
    apps.push({ kind, manifest, locations, credentials });
  }
  if (stops.length) throw stopFor(stops);
  if (JSON.stringify(record) !== recordedBefore) await writeAppRecord(recordPath, record);
  const names = {};
  for (const { kind, manifest, locations, credentials: saved } of apps) {
    const { path, installationPath, pendingPath } = locations;
    let credentials = saved;
    if (credentials) await discardPending(pendingPath);
    names[kind] = displayName(credentials, manifest.name);
    if (await github.exists?.(installationPath)) continue;
    if (!credentials) {
      credentials = await createApp({ kind, repository, manifest, path, pendingPath, github, output, progress });
      await discardPending(pendingPath);
      if (progress) progress.shownPage = null;
      names[kind] = displayName(credentials, manifest.name);
      record[kind] = recordEntry(credentials, manifest.name);
      await writeAppRecord(recordPath, record);
    }
    const installed = await github.install({ credentials, repository, kind });
    if (!installed) throw new Error(`Install the ${kind} App only on ${repository} before continuing.`);
    await writePrivateJson(installationPath, { repository, confirmed: true });
  }
  return names;
}

// The stops of Apps whose records are already gone (missing or damaged details), so the next run creates them again.
function forgottenStops(problems) {
  return problems.filter(({ stop, locations }) => !locations && REMADE.has(stop.reason)).map(({ stop }) => stop);
}

// Stops after which a finished setup keeps everything it saved: GitHub could not be asked about an App, refused
// the request to check it, or refused the App's sign-in because this server's clock is off, so nothing is known
// to be broken and the next run checks both Apps again.
export const keepsFinishedSetup = stop => ['unchecked', 'refused', 'clock'].includes(stop.reason);

// Confirms on a finished setup that both Apps still have their saved details, are still on GitHub and are
// still installed on the repository. While GitHub could not be asked about one App, refused the request to
// check it, or refused its sign-in because of this server's clock, nothing more is removed and that is the stop, so the finished record stays
// and the next run checks both Apps again. Otherwise each App's problem is cleaned up first, so the next run
// rebuilds every broken App and not only the first; then one stop names every App the next run creates again,
// or else the first problem. As in createApps, an App whose records
// reading its details already removed is reported even when the other App's details then fail to read. Returns
// the names of both Apps, as createApps does.
export async function checkApps({ repository, stateDirectory, credentialDirectory, github, beforeRemovingDamaged }) {
  const problems = [];
  const names = {};
  for (const [kind, manifest] of [['builder', builderManifest(repository)], ['release', releaseManifest(repository)]]) {
    const locations = appFiles(kind, stateDirectory, credentialDirectory);
    let credentials;
    try {
      credentials = await savedCredentials(kind, locations, beforeRemovingDamaged);
    } catch (error) {
      if (!(error instanceof AppSetupStop && (error.reason === 'missing' || error.reason === 'damaged'))) {
        const forgotten = forgottenStops(problems);
        throw forgotten.length ? stopFor(forgotten) : error;
      }
      problems.push({ stop: error });
      continue;
    }
    if (!credentials) {
      problems.push({ stop: new AppSetupStop('missing', kind) });
      continue;
    }
    names[kind] = displayName(credentials, manifest.name);
    let status;
    try {
      status = await github.appStatus({ credentials, repository, kind });
    } catch (error) {
      problems.push({ stop: new AppSetupStop(error?.refused ? 'refused' : 'unchecked', kind) });
      continue;
    }
    if (status === 'clock-rejected') problems.push({ stop: new AppSetupStop('clock', kind) });
    else if (status === 'app-missing') problems.push({ stop: new AppSetupStop('gone', kind), locations, details: true });
    else if (status === 'key-rejected') problems.push({ stop: new AppSetupStop('key-rejected', kind), locations, details: true });
    else if (status === 'not-installed') problems.push({ stop: new AppSetupStop('uninstalled', kind), locations, details: false });
  }
  // An App whose records reading its details already removed is reported over an App GitHub could not be asked
  // about or refused to check, or whose sign-in GitHub refused because of this server's clock: lost, the next run would create that
  // App again without the owner deleting the old one.
  const undecided = problems.find(({ stop }) => keepsFinishedSetup(stop));
  if (undecided) {
    const forgotten = forgottenStops(problems);
    throw forgotten.length ? stopFor(forgotten) : undecided.stop;
  }
  for (const { stop, locations, details } of problems) {
    if (locations) await forgetApp(stop.kind, locations, { details });
  }
  if (problems.length) throw stopFor(problems.map(({ stop }) => stop));
  return names;
}

// The pending record of an App ({ code } or { code, credentials }), or null when there is none.
export function pendingRecord(pendingPath, kind) {
  return readPending(pendingPath, kind);
}

// The Apps whose details this server holds, by kind ({ builder, release }, each the App's name, absent when
// the server holds none): saved details, in the credentials folder or the legacy location, or keys waiting in
// a pending record. Damaged details do not count. Details setup cannot read do: a details file is written only
// once GitHub has made its App, so that App is on GitHub and only its name is unknown. A pending record setup
// cannot read does not: one is written as soon as the App's page is shown, before GitHub makes any App, so
// setup cannot promise there is an App to use again. Never throws: a stop asks this after any failure.
export async function savedApps({ stateDirectory, credentialDirectory }) {
  const names = {};
  for (const [kind, value] of [['builder', builderManifest('')], ['release', releaseManifest('')]]) {
    const { path, legacyPath, pendingPath } = appFiles(kind, stateDirectory, credentialDirectory);
    const reads = [
      { read: () => readCredentials(path), unreadableHeld: true },
      { read: () => readCredentials(legacyPath), unreadableHeld: true },
      {
        read: async () => {
          const credentials = (await readPending(pendingPath, kind))?.credentials;
          return validCredentials(credentials) ? credentials : null;
        },
        unreadableHeld: false
      }
    ];
    for (const { read, unreadableHeld } of reads) {
      let credentials;
      try {
        credentials = await read();
      } catch (error) {
        if (!unreadableHeld || error instanceof DamagedCredentials || error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
        credentials = {};
      }
      if (!credentials) continue;
      names[kind] = displayName(credentials, value.name);
      break;
    }
  }
  return names;
}
