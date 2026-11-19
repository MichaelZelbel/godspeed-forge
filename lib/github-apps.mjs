import { access, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writePrivateJson } from './config.mjs';

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
  return value && typeof value === 'object' && value.id && value.pem
    && typeof value.slug === 'string' && value.slug.trim().length > 0;
}

function displayName(credentials, fallback) {
  const name = typeof credentials?.name === 'string' ? credentials.name.trim() : '';
  return name.length > 0 && name.length <= 60 ? name : fallback;
}

async function exists(path) {
  try {
    await access(path);
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

async function readCredentials(path) {
  const text = await readFile(path, 'utf8');
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

async function readStoredCredentials({ path, legacyPath }) {
  if (await exists(path)) {
    const credentials = await readCredentials(path);
    if (await exists(legacyPath)) await unlink(legacyPath);
    return credentials;
  }
  if (!(await exists(legacyPath))) return null;
  const credentials = await readCredentials(legacyPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rename(legacyPath, path);
  return credentials;
}

async function removeIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Removes the record that the App is installed and, with details, its saved details: in that order, so
// details never go while the record stays.
async function forgetApp(kind, files, { details }) {
  try {
    await removeIfPresent(files.installationPath);
    if (details) await removeIfPresent(files.path);
  } catch {
    throw new AppSetupStop('not-writable', kind);
  }
}

// The App's saved details, or null when setup has not made that App yet. Details that are damaged, or gone
// while the record that the App is installed stays, are restored from the keys the pending record still holds.
// Without those keys setup can no longer use that App: the record goes and then the damaged file, so the next
// run creates and installs the App again instead of skipping it or stopping the same way; the record goes
// first because details gone while it stays would let a run skip that App.
async function savedCredentials(kind, files) {
  let damagedPath = null;
  try {
    const credentials = await readStoredCredentials(files);
    if (credentials) return credentials;
  } catch (error) {
    if (!(error instanceof DamagedCredentials)) throw error;
    damagedPath = error.path;
  }
  if (!damagedPath && !(await exists(files.installationPath))) return null;
  const kept = await keptCredentials(files.pendingPath);
  try {
    if (kept) {
      await writePrivateJson(files.path, kept);
      return kept;
    }
    await removeIfPresent(files.installationPath);
    if (damagedPath) await removeIfPresent(damagedPath);
  } catch {
    throw new AppSetupStop('not-writable', kind);
  }
  throw new AppSetupStop(damagedPath ? 'damaged' : 'missing', kind);
}

// reason 'several' carries in stops the stops of both Apps, when each App has to be created again.
export class AppSetupStop extends Error {
  constructor(reason, kind, stops = []) {
    super(reason);
    this.name = 'AppSetupStop';
    this.reason = reason;
    this.kind = kind;
    this.stops = stops;
  }
}

// Stops after which the next run creates that App again. When both Apps have one, a single stop names both, so
// the owner deletes every App the next run replaces at once; naming only one would leave the other's
// deletion unsaid and that App made twice.
const REMADE = new Set(['missing', 'damaged', 'gone', 'key-rejected']);

function stopFor(stops) {
  const remade = stops.filter(({ reason }) => REMADE.has(reason));
  if (remade.length > 1) return new AppSetupStop('several', remade[0].kind, remade);
  return remade[0] ?? stops[0];
}

// null when there is no record. A record that cannot be parsed reads as damaged: only an in-place rewrite of
// a record holding a code or keys leaves one, so GitHub created that App, and nothing left can finish it.
async function readPending(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
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

async function keptCredentials(pendingPath) {
  const pending = await readPending(pendingPath);
  return validCredentials(pending?.credentials) ? pending.credentials : null;
}

// Best effort: a record that stays behind holds a spent code. The next run removes it once credentials
// are stored, or reports the leftover App when GitHub refuses the code.
async function discardPending(pendingPath) {
  await rm(pendingPath, { force: true }).catch(() => {});
}

// Replaces the contents of an existing private file in place. Unlike `writePrivateJson` it creates,
// renames and removes nothing, so it still works in a folder that no longer accepts new files.
async function overwritePrivateJson(path, value) {
  const handle = await open(path, 'r+');
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
    await unlink(pendingPath);
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
  let pending = await readPending(pendingPath);
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
      if (!reopened) await unlink(pendingPath).catch(() => {});
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

// Keys an earlier run left in the pending record belong to an App the owner may have deleted on GitHub since,
// so before setup uses them GitHub is asked whether that App still exists. While GitHub cannot answer, the
// keys stay and the next run asks again. When the App is gone, its records and keys go, so the next run
// creates that App again instead of stopping on what the deleted App left behind.
async function confirmKeptApp(kind, files, saved, { github, repository }) {
  const kept = await keptCredentials(files.pendingPath);
  if (!kept) return;
  let status;
  try {
    status = await github.appStatus({ credentials: saved ?? kept, repository, kind });
  } catch {
    throw new AppSetupStop('unchecked', kind);
  }
  if (status === 'clock-rejected') throw new AppSetupStop('clock', kind);
  if (status !== 'app-missing' && status !== 'key-rejected') return;
  await forgetApp(kind, files, { details: true });
  try {
    await removeIfPresent(files.pendingPath);
  } catch {
    throw new AppSetupStop('not-writable', kind);
  }
  throw new AppSetupStop(status === 'key-rejected' ? 'key-rejected' : 'gone', kind);
}

// Every App whose saved details are unusable, or whose kept keys belong to an App no longer on GitHub, is
// reported in one stop before anything is created, so the owner deletes each App the next run creates again at
// once. Finding such an App already removed its records, so its stop wins over a later App's other failure:
// lost, the next run would make that App twice.
export async function createApps({ repository, stateDirectory, credentialDirectory, github, output, progress }) {
  const apps = [];
  const stops = [];
  for (const [kind, manifest] of [['builder', builderManifest(repository)], ['release', releaseManifest(repository)]]) {
    const files = appFiles(kind, stateDirectory, credentialDirectory);
    let credentials = null;
    try {
      credentials = await savedCredentials(kind, files);
      await confirmKeptApp(kind, files, credentials, { github, repository });
    } catch (error) {
      if (!(error instanceof AppSetupStop && REMADE.has(error.reason))) throw stops.length ? stopFor(stops) : error;
      stops.push(error);
    }
    apps.push({ kind, manifest, files, credentials });
  }
  if (stops.length) throw stopFor(stops);
  const names = {};
  for (const { kind, manifest, files, credentials: saved } of apps) {
    const { path, installationPath, pendingPath } = files;
    let credentials = saved;
    if (credentials) await discardPending(pendingPath);
    names[kind] = displayName(credentials, manifest.name);
    if (await github.exists?.(installationPath)) continue;
    if (!credentials) {
      credentials = await createApp({ kind, repository, manifest, path, pendingPath, github, output, progress });
      await discardPending(pendingPath);
      if (progress) progress.shownPage = null;
      names[kind] = displayName(credentials, manifest.name);
    }
    const installed = await github.install({ credentials, repository, kind });
    if (!installed) throw new Error(`Install the ${kind} App only on ${repository} before continuing.`);
    await writePrivateJson(installationPath, { repository, confirmed: true });
  }
  return names;
}

// Stops after which a finished setup keeps everything it saved: GitHub could not be asked about an App, or
// refused the App's sign-in because this server's clock is off, so nothing is known to be broken and the next
// run checks both Apps again.
export const keepsFinishedSetup = stop => stop.reason === 'unchecked' || stop.reason === 'clock';

// Confirms on a finished setup that both Apps still have their saved details, are still on GitHub and are
// still installed on the repository. While GitHub could not be asked about one App, or refused its sign-in
// because of this server's clock, nothing more is removed and that is the stop, so the finished record stays and the next run checks both Apps again. Otherwise each App's
// problem is cleaned up first, so the next run rebuilds every broken App and not only the first; then one stop
// names every App the next run creates again, or else the first problem. As in createApps, an App whose records
// reading its details already removed is reported even when the other App's details then fail to read. Returns
// the names of both Apps, as createApps does.
export async function checkApps({ repository, stateDirectory, credentialDirectory, github }) {
  const problems = [];
  const names = {};
  for (const [kind, manifest] of [['builder', builderManifest(repository)], ['release', releaseManifest(repository)]]) {
    const files = appFiles(kind, stateDirectory, credentialDirectory);
    let credentials;
    try {
      credentials = await savedCredentials(kind, files);
    } catch (error) {
      if (!(error instanceof AppSetupStop && (error.reason === 'missing' || error.reason === 'damaged'))) {
        const forgotten = problems.filter(({ stop, files }) => !files && REMADE.has(stop.reason)).map(({ stop }) => stop);
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
    } catch {
      problems.push({ stop: new AppSetupStop('unchecked', kind) });
      continue;
    }
    if (status === 'clock-rejected') problems.push({ stop: new AppSetupStop('clock', kind) });
    else if (status === 'app-missing') problems.push({ stop: new AppSetupStop('gone', kind), files, details: true });
    else if (status === 'key-rejected') problems.push({ stop: new AppSetupStop('key-rejected', kind), files, details: true });
    else if (status === 'not-installed') problems.push({ stop: new AppSetupStop('uninstalled', kind), files, details: false });
  }
  const undecided = problems.find(({ stop }) => keepsFinishedSetup(stop));
  if (undecided) throw undecided.stop;
  for (const { stop, files, details } of problems) {
    if (files) await forgetApp(stop.kind, files, { details });
  }
  if (problems.length) throw stopFor(problems.map(({ stop }) => stop));
  return names;
}
