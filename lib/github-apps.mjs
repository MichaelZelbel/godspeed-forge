import { access, mkdir, readFile, rename, unlink } from 'node:fs/promises';
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

export async function createApps({ repository, stateDirectory, credentialDirectory, github, output }) {
  const names = {};
  for (const [kind, value] of [['builder', builderManifest(repository)], ['release', releaseManifest(repository)]]) {
    const path = join(credentialDirectory, `${kind}-app.json`);
    const legacyPath = join(stateDirectory, `${kind}-app.json`);
    const installationPath = join(stateDirectory, `${kind}-installation.json`);
    let credentials = await storedCredentials(kind, path, legacyPath);
    names[kind] = displayName(credentials, value.name);
    if (await github.exists?.(installationPath)) continue;
    if (!credentials) {
      const flow = await github.begin(value);
      output(`Create the ${kind} App in your browser: ${flow.url}`);
      try {
        credentials = await github.complete(flow);
      } catch (error) {
        if (error instanceof AppStepError) error.kind ??= kind;
        throw error;
      }
      if (!validCredentials(credentials)) throw new Error(`GitHub did not return the ${kind} App credentials.`);
      try {
        await writePrivateJson(path, credentials);
      } catch (error) {
        if (typeof error?.code === 'string') {
          throw new AppStepError('credentials', `The ${kind} App credentials could not be saved.`, { cause: error, kind });
        }
        throw error;
      }
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
