import { join } from 'node:path';
import { writePrivateJson } from './config.mjs';

export function builderManifest(repository) {
  return manifest('Forge builder', repository, {
    contents: 'write', pull_requests: 'write', issues: 'write', actions: 'write',
    checks: 'read', statuses: 'read', metadata: 'read'
  });
}

export function releaseManifest(repository) {
  return manifest('Forge release', repository, {
    contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read'
  });
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
    if (await github.exists?.(path)) continue;
    const flow = await github.begin(value);
    output(`Create the ${kind} App in your browser: ${flow.url}`);
    const credentials = await github.complete(flow);
    if (!validCredentials(credentials)) throw new Error(`GitHub did not return the ${kind} App credentials.`);
    await writePrivateJson(path, credentials);
  }
}
