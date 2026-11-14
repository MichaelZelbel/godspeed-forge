import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateJson } from './config.mjs';

export const APP_PERMISSIONS = Object.freeze({
  builder: Object.freeze({
    contents: 'write', pull_requests: 'write', issues: 'write', actions: 'write',
    checks: 'read', statuses: 'read', metadata: 'read'
  }),
  release: Object.freeze({
    contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read'
  })
});

export const APP_PERMISSION_DOCUMENTATION = 'The builder App has repository permissions for Contents, Pull requests, Issues, and Actions read/write, plus Checks, Commit statuses, and Metadata read. The release App has Contents and Pull requests read/write, plus Checks, Actions, and Metadata read.';

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
  return value && typeof value === 'object' && value.id && value.pem;
}

export async function createApps({ repository, stateDirectory, github, output }) {
  for (const [kind, value] of [['builder', builderManifest(repository)], ['release', releaseManifest(repository)]]) {
    const path = join(stateDirectory, `${kind}-app.json`);
    const installationPath = join(stateDirectory, `${kind}-installation.json`);
    if (await github.exists?.(installationPath)) continue;
    let credentials;
    if (await github.exists?.(path)) {
      credentials = JSON.parse(await readFile(path, 'utf8'));
    } else {
      const flow = await github.begin(value);
      output(`Create the ${kind} App in your browser: ${flow.url}`);
      credentials = await github.complete(flow);
      if (!validCredentials(credentials)) throw new Error(`GitHub did not return the ${kind} App credentials.`);
      await writePrivateJson(path, credentials);
    }
    const installed = await github.install({ credentials, repository, kind });
    if (!installed) throw new Error(`Install the ${kind} App only on ${repository} before continuing.`);
    await writePrivateJson(installationPath, { repository, confirmed: true });
  }
}
