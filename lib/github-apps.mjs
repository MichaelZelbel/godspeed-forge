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

async function readCredentials(path) {
  const text = await files.readFile(path, 'utf8');
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
    throw Object.assign(new AppSetupStop('unreadable', kind, folder), { cause: error, code: error.code });
  }
}

async function readStoredCredentials(kind, { path, legacyPath }) {
  if (await readIn('credentials', kind, () => exists(path))) {
    const credentials = await readIn('credentials', kind, () => readCredentials(path));
    if (await readIn('project', kind, () => exists(legacyPath))) await files.unlink(legacyPath);
    return credentials;
  }
  if (!(await readIn('project', kind, () => exists(legacyPath)))) return null;
  const credentials = await readIn('project', kind, () => readCredentials(legacyPath));
  await files.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await files.rename(legacyPath, path);
  return credentials;
}

async function removeIfPresent(path) {
  try {
    await files.unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Damaged App details are of no use and would stop every later run the same way, so they go, together
// with the record that the App is installed, and the next run creates and installs that App again. The
// record goes first: details gone while it stays would let a run skip that App. beforeRemovingDamaged runs
// before anything is removed; when it throws, nothing is removed and the next run finds the same damage.
// Details that cannot be read at all stop as 'unreadable', and moving them out of the legacy location as
// 'not-writable'; either stop keeps the file system's code.
async function storedCredentials(kind, locations, beforeRemovingDamaged) {
  try {
    return await readStoredCredentials(kind, locations);
  } catch (error) {
    if (error instanceof AppSetupStop) throw error;
    if (typeof error?.code === 'string') {
      throw Object.assign(new AppSetupStop('not-writable', kind), { cause: error, code: error.code });
    }
    if (!(error instanceof DamagedCredentials)) throw error;
    await beforeRemovingDamaged?.();
    try {
      await removeIfPresent(locations.installationPath);
      await removeIfPresent(error.path);
    } catch {
      throw new AppSetupStop('not-writable', kind);
    }
    throw new AppSetupStop('damaged', kind);
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

// Saved details gone while the install record stays would let a run skip an App it has no keys for, so
// the record goes and the owner deletes that App on GitHub before the next run creates it again.
async function savedCredentials(kind, locations, beforeRemovingDamaged) {
  const credentials = await storedCredentials(kind, locations, beforeRemovingDamaged);
  if (credentials || !(await readIn('credentials', kind, () => exists(locations.installationPath)))) return credentials;
  await forgetApp(kind, locations, { details: false });
  throw new AppSetupStop('missing', kind);
}

// folder names, for an 'unreadable' stop, where the details are: 'credentials' or 'project'.
export class AppSetupStop extends Error {
  constructor(reason, kind, folder) {
    super(reason);
    this.name = 'AppSetupStop';
    this.reason = reason;
    this.kind = kind;
    this.folder = folder;
  }
}

// null when there is no record. A record that cannot be parsed reads as one without a code: GitHub may
// have created the App, and nothing left can finish it.
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
    return { code: null };
  }
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
// Its first write is also the check that the private credential location can be written.
// progress.unopenedPage names the record while it exists but the page has not been shown yet, so a setup
// that is stopped in that window can remove it: GitHub cannot have created an App before the page opened.
// progress.shownPage names the App ({ kind, pendingPath }) from when its page is shown until its credentials
// are stored, so a stopped setup can say what the next run will do with that record.
async function createApp({ kind, manifest, path, pendingPath, github, output, progress = {} }) {
  let pending = await readPending(pendingPath, kind);
  if (pending?.credentials) {
    // An earlier run exchanged the code but could not store the keys; they wait in the pending record.
    if (!validCredentials(pending.credentials)) await stopForLeftover(pendingPath, kind);
    await storeCredentials(path, pending.credentials, kind);
    return pending.credentials;
  }
  if (!pending) {
    try {
      await writePrivateJson(pendingPath, { code: null });
    } catch {
      throw new AppSetupStop('not-writable', kind);
    }
    progress.unopenedPage = pendingPath;
    let flow;
    try {
      flow = await github.begin(manifest);
    } catch (error) {
      progress.unopenedPage = null;
      await files.unlink(pendingPath).catch(() => {});
      throw error;
    }
    progress.unopenedPage = null;
    progress.shownPage = { kind, pendingPath };
    output(`Create the ${kind} App in your browser: ${flow.url}`);
    let code;
    try {
      code = await github.callback(flow);
      if (!code) throw new AppStepError('page', 'The GitHub callback address did not contain a temporary code.');
    } catch (error) {
      // An address without GitHub's code means the page was left unfinished and GitHub created no App,
      // so the record goes and the next run opens the page again.
      if (error instanceof AppStepError) {
        error.kind ??= kind;
        await discardPending(pendingPath);
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
  if (!pending.code) await stopForLeftover(pendingPath, kind);
  let credentials;
  try {
    credentials = await github.exchange(pending.code);
  } catch (error) {
    if (error.refused) await stopForLeftover(pendingPath, kind);
    throw new AppSetupStop('pending', kind);
  }
  if (!validCredentials(credentials)) throw new Error(`GitHub did not return the ${kind} App credentials.`);
  try {
    await writePrivateJson(path, credentials);
  } catch {
    // GitHub converts a code only once, so keep the keys in the pending record for the next run to store.
    // If even that fails, the record keeps the spent code: the next run that can write is refused by
    // GitHub, says once to delete the leftover App, and removes the record, so following it works.
    try {
      await overwritePrivateJson(pendingPath, { code: pending.code, credentials });
    } catch {}
    throw new AppStepError('credentials', `The ${kind} App credentials could not be saved.`, { kind });
  }
  return credentials;
}

export async function createApps({ repository, stateDirectory, credentialDirectory, github, output, progress }) {
  const names = {};
  for (const [kind, value] of [['builder', builderManifest(repository)], ['release', releaseManifest(repository)]]) {
    const locations = appFiles(kind, stateDirectory, credentialDirectory);
    const { path, installationPath, pendingPath } = locations;
    let credentials = await savedCredentials(kind, locations);
    if (credentials) await discardPending(pendingPath);
    names[kind] = displayName(credentials, value.name);
    if (await github.exists?.(installationPath)) continue;
    if (!credentials) {
      credentials = await createApp({ kind, manifest: value, path, pendingPath, github, output, progress });
      await discardPending(pendingPath);
      if (progress) progress.shownPage = null;
      names[kind] = displayName(credentials, value.name);
    }
    const installed = await github.install({ credentials, repository, kind });
    if (!installed) throw new Error(`Install the ${kind} App only on ${repository} before continuing.`);
    await writePrivateJson(installationPath, { repository, confirmed: true });
  }
  return names;
}

// Confirms on a finished setup that both Apps still have their saved details, are still on GitHub and are
// still installed on the repository. While GitHub could not be asked about one App, nothing is removed and that
// is the stop, so the finished record stays and the next run checks both Apps again. Otherwise each App's
// problem is cleaned up first, so the next run rebuilds every broken App and not only the first; then the
// first problem is thrown.
export async function checkApps({ repository, stateDirectory, credentialDirectory, github, beforeRemovingDamaged }) {
  const problems = [];
  for (const kind of ['builder', 'release']) {
    const locations = appFiles(kind, stateDirectory, credentialDirectory);
    let credentials;
    try {
      credentials = await savedCredentials(kind, locations, beforeRemovingDamaged);
    } catch (error) {
      if (!(error instanceof AppSetupStop && error.reason === 'missing')) throw error;
    }
    if (!credentials) {
      problems.push({ stop: new AppSetupStop('missing', kind) });
      continue;
    }
    let status;
    try {
      status = await github.appStatus({ credentials, repository, kind });
    } catch {
      problems.push({ stop: new AppSetupStop('unchecked', kind) });
      continue;
    }
    if (status === 'app-missing') problems.push({ stop: new AppSetupStop('gone', kind), locations, details: true });
    else if (status === 'not-installed') problems.push({ stop: new AppSetupStop('uninstalled', kind), locations, details: false });
  }
  const unchecked = problems.find(({ stop }) => stop.reason === 'unchecked');
  if (unchecked) throw unchecked.stop;
  for (const { stop, locations, details } of problems) {
    if (locations) await forgetApp(stop.kind, locations, { details });
  }
  if (problems.length) throw problems[0].stop;
}

// The pending record of an App ({ code } or { code, credentials }), or null when there is none.
export function pendingRecord(pendingPath, kind) {
  return readPending(pendingPath, kind);
}

// The Apps whose details this server holds, by kind ({ builder, release }, each the App's name, absent when
// the server holds none): saved details, in the credentials folder or the legacy location, or keys waiting in
// a pending record. Damaged details do not count. Details setup cannot read do: the App they belong to is on
// GitHub, and only its name is unknown. Never throws: a stop asks this after any failure.
export async function savedApps({ stateDirectory, credentialDirectory }) {
  const names = {};
  for (const [kind, value] of [['builder', builderManifest('')], ['release', releaseManifest('')]]) {
    const { path, legacyPath, pendingPath } = appFiles(kind, stateDirectory, credentialDirectory);
    const reads = [
      () => readCredentials(path),
      () => readCredentials(legacyPath),
      async () => {
        const credentials = (await readPending(pendingPath, kind))?.credentials;
        return validCredentials(credentials) ? credentials : null;
      }
    ];
    for (const read of reads) {
      let credentials;
      try {
        credentials = await read();
      } catch (error) {
        if (error instanceof DamagedCredentials || error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
        credentials = {};
      }
      if (!credentials) continue;
      names[kind] = displayName(credentials, value.name);
      break;
    }
  }
  return names;
}
