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
async function discardPending(pendingPath) {
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
async function createApp({ kind, manifest, path, pendingPath, github, output }) {
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
    let flow;
    try {
      flow = await github.begin(manifest);
    } catch (error) {
      await files.unlink(pendingPath).catch(() => {});
      throw error;
    }
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

export async function createApps({ repository, stateDirectory, credentialDirectory, github, output }) {
  const names = {};
  for (const [kind, value] of [['builder', builderManifest(repository)], ['release', releaseManifest(repository)]]) {
    const locations = appFiles(kind, stateDirectory, credentialDirectory);
    const { path, installationPath, pendingPath } = locations;
    let credentials = await storedCredentials(kind, locations);
    if (credentials) await discardPending(pendingPath);
    names[kind] = displayName(credentials, value.name);
    if (await github.exists?.(installationPath)) continue;
    if (!credentials) {
      credentials = await createApp({ kind, manifest: value, path, pendingPath, github, output });
      await discardPending(pendingPath);
      names[kind] = displayName(credentials, value.name);
    }
    const installed = await github.install({ credentials, repository, kind });
    if (!installed) throw new Error(`Install the ${kind} App only on ${repository} before continuing.`);
    await writePrivateJson(installationPath, { repository, confirmed: true });
  }
  return names;
}

export async function moveLegacyCredentials({ stateDirectory, credentialDirectory, beforeRemovingDamaged }) {
  for (const kind of ['builder', 'release']) {
    await storedCredentials(kind, appFiles(kind, stateDirectory, credentialDirectory), beforeRemovingDamaged);
  }
}
