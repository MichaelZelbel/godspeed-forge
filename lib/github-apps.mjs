import { createHash } from 'node:crypto';
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

export const APP_KINDS = Object.freeze(['builder', 'release']);

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

const MANIFESTS = Object.freeze({ builder: builderManifest, release: releaseManifest });

// The name GitHub shows for the App. GitHub App names are unique across all of GitHub (34 characters at most), and
// the plain 'Forge builder' was taken by another account on the first real setup (23 November 2026), so the owner
// and project go into it: 'Forge builder owner repo', or, when that is too long, the owner and eight characters
// that stand for the project.
export function githubAppName(name, repository) {
  const [owner = '', repo = ''] = String(repository).split('/');
  const full = `${name} ${owner} ${repo}`;
  if (full.length <= 34) return full;
  const mark = createHash('sha256').update(String(repository).toLowerCase()).digest('hex').slice(0, 8);
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
const denied = saved => unreadable(saved) && saved.kind === 'denied';

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

// Whether any file setup keeps about the Apps is one the file system refused to let setup read.
export const anyAppFileDenied = saved => [saved.list, ...KINDS.flatMap(kind => Object.values(saved[kind]))].some(denied);

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
// list of the Apps it made names. apps, for a 'two-apps' stop, are the two Apps of the role as { name, slug }: the
// one this server can use first. unusable, on a stop for a file setup cannot read, is the stop for the Apps
// whose records this run removed so that the next run creates them again (see remadeStop).
export class AppSetupStop extends Error {
  constructor(reason, kind, { stops = [], name, unusable, apps } = {}) {
    super(reason);
    this.name = 'AppSetupStop';
    this.reason = reason;
    this.kind = kind;
    this.stops = stops;
    this.appName = name;
    this.unusable = unusable;
    this.apps = apps;
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

// The stop of a run that removed the records of Apps it found unusable (stop, from stopFor): a file about the
// Apps setup cannot read, which those records stood in for, is now one the next run cannot do without, and then
// the stop is that file's, carrying stop, so the one action it gives (delete the App on GitHub, start that file
// afresh) leads to a complete setup instead of to that file's stop on the next run.
function remadeStop(stop, saved) {
  const unreadableStop = unreadableAppStop(saved);
  return unreadableStop ? new AppSetupStop(unreadableStop.reason, unreadableStop.kind, { unusable: stop }) : stop;
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
    // New content first, then the cut: a stop between the two leaves the old record or the new, never an
    // empty one. A pending record only grows (`{code: null}`, `{code}`, `{code, credentials}`).
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await handle.write(text, 0);
    await handle.truncate(Buffer.byteLength(text));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function updatePending(pendingPath, value) {
  try {
    await writePrivateJson(pendingPath, value, { keepOnStop: true });
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
// progress.pageWasShown is true from when the latest page was shown until the next one is being opened; storing credentials does not clear it.
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
      await writePrivateJson(pendingPath, { code: null }, { keepOnStop: true });
    } catch {
      throw new AppSetupStop('not-writable', kind);
    }
    if (!reopened) progress.unopenedPage = pendingPath;
    progress.pageWasShown = false;
    let flow;
    try {
      flow = await github.begin(manifest, { kind });
    } catch (error) {
      progress.unopenedPage = null;
      if (!reopened) await files.unlink(pendingPath).catch(() => {});
      throw error;
    }
    progress.unopenedPage = null;
    progress.shownPage = { kind, pendingPath };
    progress.pageWasShown = true;
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

// The slug GitHub gives an App from its name.
const slugOf = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Two Apps of one role are on GitHub: the one this server holds the key of and another. Only the held one can be
// used, so setup asks the owner to confirm it by its short name; any other answer, no way to ask, or a closed
// input stops with both Apps named. Nothing is deleted either way.
async function chooseHeld(kind, held, recorded, { prompt, fallbackName }) {
  const apps = [{ name: displayName(held, fallbackName), slug: held.slug }, { name: recorded.name, slug: recorded.slug }];
  let answer = '';
  try {
    answer = await prompt?.(`Two ${kind} Apps exist on your GitHub account: "${apps[0].name}" (${apps[0].slug}), whose key this server holds, and "${apps[1].name}" (${apps[1].slug}). Setup can only use the first, and deletes neither. Answer ${apps[0].slug} to use it from now on, and delete the other whenever you like.`) ?? '';
  } catch (error) {
    if (error?.name !== 'InputClosed') throw error;
  }
  if (String(answer).trim().toLowerCase() !== apps[0].slug.toLowerCase()) throw new AppSetupStop('two-apps', kind, { apps });
}

// Brings the list's entry for kind up to date with held, the App whose details or kept keys this server holds
// (null when none). An App the list names that is not held is looked up on GitHub first: still there, setup can
// no longer use it, and creating the role's App again would leave two, so setup stops naming it; gone, the list
// forgets it. A held App other than the listed one (state restored from an older copy) is looked up too before
// that stop: gone, its records go as well, so once the owner deletes the listed App the next run creates the
// role's App again instead of keeping one GitHub no longer has; still there, that is two Apps for the role and
// the owner is asked which to use. A role with no App held or listed is checked for an App of the name setup
// would give it, made outside setup; a pending record means setup's own page for that App was shown, which the next
// step handles. GitHub's answer is never guessed: when it cannot be asked, or refuses to
// answer, setup stops and changes nothing.
async function checkRecorded(kind, held, record, locations, entry, { github, gh, prompt, fallbackName, repository }) {
  const recorded = record[kind];
  if (recorded && !(held && sameApp(held, recorded))) {
    if (await onGithub(kind, recorded, { github, gh })) {
      if (!held) throw new AppSetupStop('recorded', kind, { name: recorded.name });
      if (await onGithub(kind, recordEntry(held, fallbackName), { github, gh })) {
        await chooseHeld(kind, held, recorded, { prompt, fallbackName });
      } else {
        await forgetApp(kind, locations, entry, { details: true, pending: true });
        throw new AppSetupStop('recorded', kind, { name: recorded.name });
      }
    }
  } else if (!held && !recorded && entry.pending.state === 'missing') {
    const outside = { name: MANIFESTS[kind](repository).githubName };
    outside.slug = slugOf(outside.name);
    if (await onGithub(kind, outside, { github, gh })) throw new AppSetupStop('app-outside', kind, { name: outside.name });
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
export async function createApps({ repository, stateDirectory, credentialDirectory, checkout, gh = 'gh', github, output, progress, prompt, saved }) {
  saved ??= await readAppState({ stateDirectory, credentialDirectory, checkout });
  const unreadableStop = unreadableAppStop(saved);
  if (unreadableStop) throw unreadableStop;
  const recordPath = join(checkout, APP_RECORD);
  const record = readable(saved.list) ? { ...saved.list.value } : {};
  const recordedBefore = JSON.stringify(record);
  const saveRecord = async () => { if (!unreadable(saved.list)) await writeAppRecord(recordPath, record); };
  const apps = [];
  const stops = [];
  for (const [kind, manifest] of APP_KINDS.map(kind => [kind, MANIFESTS[kind](repository)])) {
    const locations = appFiles(kind, stateDirectory, credentialDirectory);
    const entry = saved[kind];
    let credentials = null;
    let status;
    try {
      credentials = await savedCredentials(kind, locations, entry);
      const held = credentials ?? pendingKeys(entry);
      await checkRecorded(kind, held, record, locations, entry, { github, gh, prompt, fallbackName: manifest.name, repository });
      status = await confirmHeldApp(kind, locations, entry, held, { github, repository });
    } catch (error) {
      if (!(error instanceof AppSetupStop && REMADE.has(error.reason))) throw stops.length ? remadeStop(stopFor(stops), saved) : error;
      stops.push(error);
    }
    apps.push({ kind, manifest, locations, entry, credentials, status });
  }
  if (stops.length) throw remadeStop(stopFor(stops), saved);
  if (JSON.stringify(record) !== recordedBefore) await saveRecord();
  const names = {};
  for (const { kind, manifest, locations, entry, credentials: held, status } of apps) {
    const { path, installationPath, pendingPath } = locations;
    let credentials = held;
    // Details cut short or emptied (a setup stopped while saving them) are saved again from the keys the pending
    // record still holds: setup never calls itself complete with such a file left behind.
    if (credentials && detailsUnreadable(entry) && ['damaged', 'empty'].includes(entry.details.kind) && pendingKeys(entry)) {
      await storeCredentials(path, credentials, kind);
      entry.details = { state: 'readable', value: credentials };
    }
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

// A problem with an App the owner named for an adopted project, in the owner's words.
export class AdoptedAppProblem extends Error {}

const adoptedMessages = {
  entry: kind => `Setup stopped because the Forge's settings name the ${kind} App without its short name, its number and the file holding its key. Fix adoptedApps in config.json in the folder where the Forge keeps its settings before trying setup again.`,
  key: (kind, slug) => `Setup stopped because the key file of your ${kind} App ${slug} could not be read. Check the key_file path in adoptedApps in config.json in the folder where the Forge keeps its settings before trying setup again.`,
  installed: (kind, slug, repository) => `Setup stopped because your ${kind} App ${slug} is not installed on ${repository}. Install it on that repository only, then try setup again; setup does not make a new App when you named one.`,
  refused: (kind, slug) => `Setup stopped because GitHub did not accept your ${kind} App ${slug} and its key. Check the App's number and key file in adoptedApps in config.json in the folder where the Forge keeps its settings before trying setup again.`,
  unchecked: kind => `Setup stopped because it could not ask GitHub about your ${kind} App. Try setup again.`
};

// The Apps the owner already runs for this project, named in the Forge's config (named: { builder, release }, each
// { slug, id, key_file }), taken in place of new ones: their details are kept where the Forge's own steps read them.
// Nothing is created on GitHub, and an App not installed on exactly this repository is a stop. -> { builder, release } slugs
export async function adoptApps({ repository, named, stateDirectory, credentialDirectory, github }) {
  const slugs = {};
  for (const kind of APP_KINDS) {
    const entry = named?.[kind];
    if (!entry || typeof entry.slug !== 'string' || !entry.slug.trim() || !entry.id || typeof entry.key_file !== 'string' || !entry.key_file) {
      throw new AdoptedAppProblem(adoptedMessages.entry(kind));
    }
    let pem;
    try {
      pem = await files.readFile(entry.key_file, 'utf8');
    } catch {
      throw new AdoptedAppProblem(adoptedMessages.key(kind, entry.slug));
    }
    if (!pem.trim()) throw new AdoptedAppProblem(adoptedMessages.key(kind, entry.slug));
    const credentials = { id: entry.id, slug: entry.slug, pem };
    let status;
    try {
      status = await github.appStatus({ credentials, repository, kind });
    } catch {
      throw new AdoptedAppProblem(adoptedMessages.unchecked(kind));
    }
    if (status === 'not-installed') throw new AdoptedAppProblem(adoptedMessages.installed(kind, entry.slug, repository));
    if (status !== 'installed') throw new AdoptedAppProblem(adoptedMessages.refused(kind, entry.slug));
    const locations = appFiles(kind, stateDirectory, credentialDirectory);
    await storeCredentials(locations.path, credentials, kind);
    await writePrivateJson(locations.installationPath, { repository, confirmed: true });
    slugs[kind] = entry.slug;
  }
  return slugs;
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
export async function checkApps({ repository, stateDirectory, credentialDirectory, checkout, gh = 'gh', github, prompt, beforeRemoving, saved }) {
  saved ??= await readAppState({ stateDirectory, credentialDirectory, checkout });
  const problems = [];
  // Setup's list of the Apps it made names an App whose details are gone; a list that cannot be read names none.
  // It is read only when such a stop happens.
  let listed;
  const named = async stop => {
    if (!checkout || !['missing', 'damaged'].includes(stop.reason)) return stop;
    listed ??= readable(saved.list) ? saved.list.value : {};
    return listed[stop.kind]?.name ? new AppSetupStop(stop.reason, stop.kind, { name: listed[stop.kind].name }) : stop;
  };
  const names = {};
  const held = {};
  for (const [kind, manifest] of APP_KINDS.map(kind => [kind, MANIFESTS[kind](repository)])) {
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
      problems.push({ stop: await named(error) });
      continue;
    }
    if (!credentials) {
      problems.push({ stop: await named(new AppSetupStop('missing', kind)) });
      continue;
    }
    names[kind] = displayName(credentials, manifest.name);
    held[kind] = credentials;
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
    if (locations) await forgetApp(stop.kind, locations, entry, { details, pending: details });
  }
  if (problems.length) throw remadeStop(stopFor(problems.map(({ stop }) => stop)), saved);
  await settleListedApps({ checkout, held, names, gh, github, prompt, saved });
  return names;
}

// Both Apps are usable, so a finished setup is only complete when setup's list names no other App of a role that
// is still on GitHub: that is two Apps for the role, and the owner is asked which to use, after which the list
// names the App in use. A list setup cannot read is never written, and names nothing to settle.
async function settleListedApps({ checkout, held, names, gh, github, prompt, saved }) {
  if (!checkout || !readable(saved.list)) return;
  const recordPath = join(checkout, APP_RECORD);
  const record = { ...saved.list.value };
  let picked = false;
  for (const kind of APP_KINDS) {
    const recorded = record[kind];
    if (!recorded || sameApp(held[kind], recorded) || !(await onGithub(kind, recorded, { github, gh }))) continue;
    await chooseHeld(kind, held[kind], recorded, { prompt, fallbackName: names[kind] });
    record[kind] = recordEntry(held[kind], names[kind]);
    picked = true;
  }
  if (picked) await writeAppRecord(recordPath, record);
}

// The pending record of an App, as readSavedFile finds it.
export function pendingRecord(pendingPath) {
  return readSavedFile(pendingPath, { valid: validPending });
}

// The Apps whose details this server holds, by kind ({ builder, release }, each the App's name, absent when
// the server holds none): readable saved details, in the credentials folder or the legacy location, or keys
// waiting in a readable pending record. Details the file system would not let setup read count too (their App is
// kept, under its default name); a pending record it cannot read does not, as it may hold no App yet.
export async function savedApps({ stateDirectory, credentialDirectory }) {
  const names = {};
  for (const [kind, { name }] of APP_KINDS.map(kind => [kind, MANIFESTS[kind]('')])) {
    const { path, legacyPath, pendingPath } = appFiles(kind, stateDirectory, credentialDirectory);
    const reads = [
      async () => readSavedFile(path, { valid: validCredentials }),
      async () => readSavedFile(legacyPath, { valid: validCredentials }),
      async () => { const pending = await pendingRecord(pendingPath); return pending.state === 'readable' ? { state: 'readable', value: pending.value?.credentials } : pending; }
    ];
    for (const [index, read] of reads.entries()) {
      const entry = await read();
      if (denied(entry) && index < 2) { names[kind] = name; break; }
      if (!entry.value) continue;
      names[kind] = displayName(entry.value, name);
      break;
    }
  }
  return names;
}
