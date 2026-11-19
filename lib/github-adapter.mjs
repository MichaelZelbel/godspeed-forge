import { sign } from 'node:crypto';
import { access } from 'node:fs/promises';
import { AppStepError, registrationAction } from './github-apps.mjs';

const encodePart = value => Buffer.from(JSON.stringify(value)).toString('base64url');

// The token a GitHub App signs with its own key to ask GitHub about itself. iat is set a minute back
// because GitHub refuses a token issued after its own clock, and exp stays under its ten-minute limit.
function appToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${encodePart({ alg: 'RS256', typ: 'JWT' })}.${encodePart({ iat: now - 60, exp: now + 540, iss: String(credentials.id) })}`;
  return `${data}.${sign('sha256', Buffer.from(data), credentials.pem).toString('base64url')}`;
}

export function createGithubAdapter({ input, fetch: request = globalThis.fetch, output = console.log }) {
  return {
    async exists(path) {
      try { await access(path); return true; } catch { return false; }
    },
    async begin(manifest) {
      const owner = new URL(manifest.url).pathname.split('/')[1];
      const organization = await input.question(`Type yes if ${owner} is a GitHub organization, or no if it is your personal account: `);
      const action = registrationAction(owner, organization.trim().toLowerCase() === 'yes');
      const value = JSON.stringify(manifest).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
      const page = `<form id="app" method="post" action="${action}"><input type="hidden" name="manifest" value="${value}"></form><script>document.getElementById('app').submit()</script>`;
      return { url: `data:text/html;base64,${Buffer.from(page).toString('base64')}` };
    },
    async callback() {
      const address = await input.question('After GitHub finishes, paste the address from your browser: ');
      let code;
      try { code = new URL(address.trim()).searchParams.get('code')?.trim(); } catch {}
      if (!code) throw new AppStepError('page', 'The GitHub callback address did not contain a temporary code.');
      return code;
    },
    async exchange(code) {
      const response = await request(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST', headers: { accept: 'application/vnd.github+json', 'user-agent': 'godspeed-forge' }
      });
      // GitHub answers 404 or 422 for a manifest code that is expired or already used.
      if (response.status === 404 || response.status === 422) {
        throw Object.assign(new Error('GitHub refused the App code.'), { refused: true });
      }
      if (!response.ok) throw new Error('GitHub could not create the App.');
      return response.json();
    },
    // 'installed', 'not-installed' when the App is no longer installed on the repository, 'app-missing'
    // when GitHub no longer knows the App or its saved key cannot sign, or 'app-rejected' when GitHub did not
    // accept the App's signed request, which a wrong server clock also causes. Throws when GitHub cannot answer.
    async appStatus({ credentials, repository }) {
      let token;
      try { token = appToken(credentials); } catch { return 'app-missing'; }
      const ask = async path => {
        try {
          return (await request(`https://api.github.com${path}`, {
            method: 'GET',
            headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'godspeed-forge' }
          })).status;
        } catch {
          throw new Error('GitHub could not be reached to check the App.');
        }
      };
      const app = await ask('/app');
      if (app === 404) return 'app-missing';
      if (app === 401) return 'app-rejected';
      if (app !== 200) throw new Error('GitHub could not be reached to check the App.');
      const [owner, name] = repository.split('/').map(encodeURIComponent);
      const installation = await ask(`/repos/${owner}/${name}/installation`);
      if (installation === 404) return 'not-installed';
      if (installation !== 200) throw new Error('GitHub could not be reached to check the App.');
      return 'installed';
    },
    async install({ credentials, repository, kind }) {
      if (!credentials.slug) throw new Error(`GitHub did not return the ${kind} App name needed for installation.`);
      const url = `https://github.com/apps/${encodeURIComponent(credentials.slug)}/installations/new`;
      output(`Install the ${kind} App and choose only ${repository}: ${url}`);
      const answer = await input.question(`Type yes after the ${kind} App is installed only on ${repository}: `);
      return answer.trim().toLowerCase() === 'yes';
    }
  };
}
