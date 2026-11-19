import { dirname, join } from 'node:path';
import { writePrivateJson } from './config.mjs';
import { files } from './files.mjs';
import { readSavedFile } from './saved-files.mjs';

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

function manifest(name, repository, permissions) {
  return {
    name,
    url: `https://github.com/${repository}`,
    redirect_url: 'http://127.0.0.1/',
    hook_attributes: { url: 'http://127.0.0.1/', active: false },
    public: false,
    default_permissions: permissions,
    default_events: []
  };
}

function validCredentials(value) {
  return Boolean(value) && typeof value === 'object' && Boolean(value.id) && Boolean(value.pem)
    && typeof value.slug === 'string' && value.slug.trim().length > 0;
}

// A pending record holds { code } (null until GitHub hands one back) and, once GitHub turned the code into
// keys, { code, credentials }.
function validPending(value) {
  return (value.code === null || value.code === undefined || typeof value.code === 'string')
    && (value.credentials === undefined || validCredentials(value.credentials));
}

function displayName(credentials, fallback) {
  const name = typeof credentials?.name === 'string' ? credentials.name.trim() : '';
  return name.length > 0 && name.length <= 60 ? name : fallback;
}

const KINDS = ['builder', 'release'];
const MISSING = Object.freeze({ state: 'missing' });
const readable = saved => saved.state === 'readable';
const unreadable = saved => saved.state === 'unreadable';

function appFiles(kind, stateDirectory, credentialDirectory) {
  return {
    path: join(credentialDirectory, `${kind}-app.json`),
    legacyPath: join(stateDirectory, `${kind}-app.json`),
    installationPath: join(stateDirectory, `${kind}-installation.json`),
    pendingPath: join(credentialDirectory, `${kind}-app-pending.json`)
  };
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
  return Object.entries(record).every(([kind, entry]) => KINDS.includes(kind) && validRecordEntry(entry));
}

// Every file setup keeps about the Apps of a repository, each as readSavedFile finds it: the list of Apps
// (missing when there is no checkout yet) and, per kind, its details (in the credentials folder, and in the
// project folder where an earlier release kept them), its pending record and its install record.
export async function readAppState({ stateDirectory, credentialDirectory, checkout }) {
  const saved = { list: await readSavedFile(join(checkout, APP_RECORD), { valid: validRecord }) };
  for (const kind of KINDS) {
    const { path, legacyPath, pendingPath, installationPath } = appFiles(kind, stateDirectory, credentialDirectory);
    saved[kind] = {
      details: await readSavedFile(path, { valid: validCredentials }),
      legacy: await readSavedFile(legacyPath, { valid: validCredentials }),
      pending: await readSavedFile(pendingPath, { valid: validPending }),
      installation: await readSavedFile(installationPath)
    };
  }
  return saved;
}

// Keys an earlier run left in the App's pending record, or null.
const pendingKeys = ({ pending }) => (readable(pending) && pending.value.credentials) || null;

// The App's details are in a file setup cannot read, and no readable file holds them instead.
const detailsUnreadable = ({ details, legacy }) => unreadable(details) || (details.state === 'missing' && unreadable(legacy));

// The keys of the App this server holds, from its saved details or its pending record, or null.
function heldKeys(entry) {
  if (readable(entry.details)) return entry.details.value;
  if (entry.details.state === 'missing' && readable(entry.legacy)) return entry.legacy.value;
  return pendingKeys(entry);
}

// The stop for the first App file setup cannot read and cannot do without, or null. Unreadable details are
// done without when the pending record still holds the App's keys; an unreadable pending record when the App's
// details are readable; an unreadable list when this server holds the keys of both Apps, as nothing is then
// created that the list would have to name. An unreadable install record is never needed: GitHub says whether
// the App is installed. When the details of both Apps are needed and unreadable, one stop (with no kind) names
// both, so the owner has setup start both afresh at once.
export function unreadableAppStop(saved) {
  if (unreadable(saved.list) && !KINDS.every(kind => heldKeys(saved[kind]))) return new AppSetupStop('list-unreadable');
  const details = KINDS.filter(kind => detailsUnreadable(saved[kind]) && !pendingKeys(saved[kind]));
  if (details.length) return new AppSetupStop('details-unreadable', details.length === 1 ? details[0] : undefined);
  const pending = KINDS.find(kind => unreadable(saved[kind].pending) && !heldKeys(saved[kind]));
  return pending ? new AppSetupStop('pending-unreadable', pending) : null;
}

// Whether any file setup keeps about the Apps is unreadable.
export const anyAppFileUnreadable = saved => unreadable(saved.list)
  || KINDS.some(kind => Object.values(saved[kind]).some(unreadable));

async function removeIfPresent(path) {
  try {
    await files.unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Removes the record that the App is installed and, with details, its saved details (and, with pending, its
// pending record): in that order, so details never go while the record stays. A file setup could not read
// stays as it is. entry, the App's files as readAppState found them, follows what was removed.
async function forgetApp(kind, locations, entry, { details, pending = false }) {
  const remove = async (file, path) => {
    if (unreadable(entry[file])) return;
    await removeIfPresent(path);
    entry[file] = MISSING;
  };
  try {
    await remove('installation', locations.installationPath);
    if (details) await remove('details', locations.path);
    if (pending) await remove('pending', locations.pendingPath);
  } catch {
    throw new AppSetupStop('not-writable', kind);
  }
}

// The App's saved details, or null when setup has not made that App yet. Details an earlier release kept in the
// project folder move to the credentials folder. Details setup cannot read are taken from the keys the pending
// record still holds, and both files stay as they are. Details gone while the record that the App is installed
// stays are restored from those keys; without them setup can no longer use that App, and the record goes so the
// next run creates and installs the App again instead of skipping it. beforeRemoving runs before the record goes;
// when it throws, nothing is removed and the next run finds the same problem. entry, the App's files as
// readAppState found them, follows what was moved, written or removed.
async function savedCredentials(kind, locations, entry, beforeRemoving) {
  const { details, legacy, installation } = entry;
  const kept = pendingKeys(entry);
  try {
    if (readable(details)) {
      if (readable(legacy)) {
        await files.unlink(locations.legacyPath);
        entry.legacy = MISSING;
      }
      return details.value;
    }
    if (details.state === 'missing' && readable(legacy)) {
      await files.mkdir(dirname(locations.path), { recursive: true, mode: 0o700 });
      await files.rename(locations.legacyPath, locations.path);
      Object.assign(entry, { details: legacy, legacy: MISSING });
      return legacy.value;
    }
  } catch (error) {
    throw Object.assign(new AppSetupStop('not-writable', kind), { cause: error, code: error?.code });
  }
  if (detailsUnreadable(entry)) {
    if (kept) return kept;
    throw new AppSetupStop('details-unreadable', kind);
  }
  if (!readable(installation)) return null;
  if (!kept) await beforeRemoving?.();
  try {
    if (kept) {
      await writePrivateJson(locations.path, kept);
      entry.details = { state: 'readable', value: kept };
      return kept;
    }
    await removeIfPresent(locations.installationPath);
    entry.installation = MISSING;
  } catch {
    throw new AppSetupStop('not-writable', kind);
  }
  throw new AppSetupStop('missing', kind);
}

// reason 'several' carries in stops the stops of both Apps, when each App has to be created again; reason
// 'details-unreadable' has no kind when it is about both Apps. name is the name of the App a stop about setup's
// list of the Apps it made names.
export class AppSetupStop extends Error {
  constructor(reason, kind, { stops = [], name } = {}) {
    super(reason);
    this.name = 'AppSetupStop';
    this.reason = reason;
    this.kind = kind;
    this.stops = stops;
    this.appName = name;
  }
}

// Stops after which the next run creates that App again. When both Apps have one, a single stop names both, so
// the owner deletes every App the next run replaces at once; naming only one would leave the other's
// deletion unsaid and that App made twice.
const REMADE = new Set(['missing', 'gone', 'key-rejected', 'recorded']);

function stopFor(stops) {
  const remade = stops.filter(({ reason }) => REMADE.has(reason));
  if (remade.length > 1) return new AppSetupStop('several', remade[0].kind, { stops: remade });
  return remade[0] ?? stops[0];
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
// saved is the pending record as this run read it, which createApps has found readable or missing.
// progress.unopenedPage names a record this run wrote while the page has not been shown yet, so a setup
// that is stopped in that window can remove it: GitHub cannot have created an App before the page opened.
// progress.shownPage names the App ({ kind, pendingPath }) from when its page is shown until its credentials
// are stored, so a stopped setup can say what the next run will do with that record.
async function createApp({ kind, repository, manifest, path, pendingPath, saved, github, output, progress = {} }) {
  let pending = readable(saved) ? saved.value : null;
  if (pending?.credentials) {
    // An earlier run exchanged the code but did not store the keys; they wait in the pending record, and
    // createApps has confirmed that their App is still on GitHub.
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
// goes, so this run asks the owner to install it again. Returns what GitHub said, or undefined when nothing is
// held.
async function confirmHeldApp(kind, locations, entry, held, { github, repository }) {
  if (!held) return undefined;
  let status;
  try {
    status = await github.appStatus({ credentials: held, repository, kind });
  } catch (error) {
    throw new AppSetupStop(error?.refused ? 'refused' : 'unchecked', kind);
  }
  if (status === 'clock-rejected') throw new AppSetupStop('clock', kind);
  if (status === 'not-installed') await forgetApp(kind, locations, entry, { details: false });
  if (status !== 'app-missing' && status !== 'key-rejected') return status;
  await forgetApp(kind, locations, entry, { details: true, pending: true });
  throw new AppSetupStop(status === 'key-rejected' ? 'key-rejected' : 'gone', kind);
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
async function checkRecorded(kind, held, record, locations, entry, { github, gh, fallbackName }) {
  const recorded = record[kind];
  if (recorded && !(held && sameApp(held, recorded))) {
    if (await onGithub(kind, recorded, { github, gh })) {
      if (held && !(await onGithub(kind, recordEntry(held, fallbackName), { github, gh }))) {
        await forgetApp(kind, locations, entry, { details: true, pending: true });
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
// about an App on the list. saved is what readAppState found at the start of the run (read now when not given);
// a file in it setup cannot read is never written, and the list is not written at all when it is one.
export async function createApps({ repository, stateDirectory, credentialDirectory, checkout, gh = 'gh', github, output, progress, saved }) {
  saved ??= await readAppState({ stateDirectory, credentialDirectory, checkout });
  const unreadableStop = unreadableAppStop(saved);
  if (unreadableStop) throw unreadableStop;
  const recordPath = join(checkout, APP_RECORD);
  const record = readable(saved.list) ? { ...saved.list.value } : {};
  const recordedBefore = JSON.stringify(record);
  const saveRecord = async () => { if (!unreadable(saved.list)) await writeAppRecord(recordPath, record); };
  const apps = [];
  const stops = [];
  for (const [kind, manifest] of [['builder', builderManifest(repository)], ['release', releaseManifest(repository)]]) {
    const locations = appFiles(kind, stateDirectory, credentialDirectory);
    const entry = saved[kind];
    let credentials = null;
    let status;
    try {
      credentials = await savedCredentials(kind, locations, entry);
      const held = credentials ?? pendingKeys(entry);
      await checkRecorded(kind, held, record, locations, entry, { github, gh, fallbackName: manifest.name });
      status = await confirmHeldApp(kind, locations, entry, held, { github, repository });
    } catch (error) {
      if (!(error instanceof AppSetupStop && REMADE.has(error.reason))) throw stops.length ? stopFor(stops) : error;
      stops.push(error);
    }
    apps.push({ kind, manifest, locations, entry, credentials, status });
  }
  if (stops.length) throw stopFor(stops);
  if (JSON.stringify(record) !== recordedBefore) await saveRecord();
  const names = {};
  for (const { kind, manifest, locations, entry, credentials: held, status } of apps) {
    const { path, installationPath, pendingPath } = locations;
    let credentials = held;
    // Keys taken from the pending record in place of unreadable details stay there for the next run.
    if (credentials && readable(entry.pending) && !detailsUnreadable(entry)) await discardPending(pendingPath);
    names[kind] = displayName(credentials, manifest.name);
    // An install record setup cannot read is never written; GitHub has said whether the App is installed.
    const installed = unreadable(entry.installation)
      ? status === 'installed'
      : readable(entry.installation) && status !== 'not-installed';
    if (installed) continue;
    if (!credentials) {
      credentials = await createApp({ kind, repository, manifest, path, pendingPath, saved: entry.pending, github, output, progress });
      await discardPending(pendingPath);
      if (progress) progress.shownPage = null;
      names[kind] = displayName(credentials, manifest.name);
      record[kind] = recordEntry(credentials, manifest.name);
      await saveRecord();
    }
    const confirmed = await github.install({ credentials, repository, kind });
    if (!confirmed) throw new Error(`Install the ${kind} App only on ${repository} before continuing.`);
    if (!unreadable(entry.installation)) await writePrivateJson(installationPath, { repository, confirmed: true });
  }
  return names;
}

// The stops of Apps whose records are already gone (missing details), so the next run creates them again.
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
// the names of both Apps, as createApps does. saved is as for createApps; beforeRemoving runs before an App
// whose details are gone loses the record that it is installed.
export async function checkApps({ repository, stateDirectory, credentialDirectory, checkout, github, beforeRemoving, saved }) {
  saved ??= await readAppState({ stateDirectory, credentialDirectory, checkout });
  const problems = [];
  const names = {};
  for (const [kind, manifest] of [['builder', builderManifest(repository)], ['release', releaseManifest(repository)]]) {
    const locations = appFiles(kind, stateDirectory, credentialDirectory);
    const entry = saved[kind];
    let credentials;
    try {
      credentials = await savedCredentials(kind, locations, entry, beforeRemoving);
    } catch (error) {
      if (!(error instanceof AppSetupStop && error.reason === 'missing')) {
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
    else if (status === 'app-missing') problems.push({ stop: new AppSetupStop('gone', kind), locations, entry, details: true });
    else if (status === 'key-rejected') problems.push({ stop: new AppSetupStop('key-rejected', kind), locations, entry, details: true });
    else if (status === 'not-installed') problems.push({ stop: new AppSetupStop('uninstalled', kind), locations, entry, details: false });
  }
  // An App whose records reading its details already removed is reported over an App GitHub could not be asked
  // about or refused to check, or whose sign-in GitHub refused because of this server's clock: lost, the next run would create that
  // App again without the owner deleting the old one.
  const undecided = problems.find(({ stop }) => keepsFinishedSetup(stop));
  if (undecided) {
    const forgotten = forgottenStops(problems);
    throw forgotten.length ? stopFor(forgotten) : undecided.stop;
  }
  for (const { stop, locations, entry, details } of problems) {
    if (locations) await forgetApp(stop.kind, locations, entry, { details });
  }
  if (problems.length) throw stopFor(problems.map(({ stop }) => stop));
  return names;
}

// The pending record of an App, as readSavedFile finds it.
export function pendingRecord(pendingPath) {
  return readSavedFile(pendingPath, { valid: validPending });
}

// The Apps whose details this server holds, by kind ({ builder, release }, each the App's name, absent when
// the server holds none): readable saved details, in the credentials folder or the legacy location, or keys
// waiting in a readable pending record. A file setup cannot read does not count: the next run cannot use what it
// holds until the owner has setup start that file afresh.
export async function savedApps({ stateDirectory, credentialDirectory }) {
  const names = {};
  for (const [kind, { name }] of [['builder', builderManifest('')], ['release', releaseManifest('')]]) {
    const { path, legacyPath, pendingPath } = appFiles(kind, stateDirectory, credentialDirectory);
    const reads = [
      async () => (await readSavedFile(path, { valid: validCredentials })).value,
      async () => (await readSavedFile(legacyPath, { valid: validCredentials })).value,
      async () => (await pendingRecord(pendingPath)).value?.credentials
    ];
    for (const read of reads) {
      const credentials = await read();
      if (!credentials) continue;
      names[kind] = displayName(credentials, name);
      break;
    }
  }
  return names;
}
