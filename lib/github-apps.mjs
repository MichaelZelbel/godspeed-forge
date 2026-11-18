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

async function readCredentials(path, kind) {
  const credentials = JSON.parse(await readFile(path, 'utf8'));
  if (!validCredentials(credentials)) throw new Error(`Stored ${kind} App credentials are incomplete.`);
  return credentials;
}

async function storedCredentials(kind, credentialPath, legacyPath) {
  if (await exists(credentialPath)) {
    const credentials = await readCredentials(credentialPath, kind);
    if (await exists(legacyPath)) await unlink(legacyPath);
    return credentials;
  }
  if (!(await exists(legacyPath))) return null;
  const credentials = await readCredentials(legacyPath, kind);
  await mkdir(dirname(credentialPath), { recursive: true, mode: 0o700 });
  await rename(legacyPath, credentialPath);
  return credentials;
}

export class AppSetupStop extends Error {
  constructor(reason, kind) {
    super(reason);
    this.name = 'AppSetupStop';
    this.reason = reason;
    this.kind = kind;
  }
}

async function readPending(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
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
// Its first write is also the check that the private credential location can be written.
async function createApp({ kind, manifest, path, pendingPath, github, output }) {
  let pending = await readPending(pendingPath);
  if (pending?.credentials) {
    // An earlier run exchanged the code but could not store the keys; they wait in the pending record.
    if (!validCredentials(pending.credentials)) throw new Error(`Stored ${kind} App credentials are incomplete.`);
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
      await unlink(pendingPath).catch(() => {});
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
    const path = join(credentialDirectory, `${kind}-app.json`);
    const legacyPath = join(stateDirectory, `${kind}-app.json`);
    const installationPath = join(stateDirectory, `${kind}-installation.json`);
    const pendingPath = join(credentialDirectory, `${kind}-app-pending.json`);
    let credentials = await storedCredentials(kind, path, legacyPath);
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

export async function moveLegacyCredentials({ stateDirectory, credentialDirectory }) {
  for (const kind of ['builder', 'release']) {
    await storedCredentials(kind, join(credentialDirectory, `${kind}-app.json`), join(stateDirectory, `${kind}-app.json`));
  }
}
