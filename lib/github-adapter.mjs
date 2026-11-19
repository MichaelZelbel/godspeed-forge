import { sign } from 'node:crypto';
import { files } from './files.mjs';
import { AppStepError, registrationAction } from './github-apps.mjs';
import { run as runProcess } from './process.mjs';

const encodePart = value => Buffer.from(JSON.stringify(value)).toString('base64url');

// The token a GitHub App signs with its own key to ask GitHub about itself. iat is set a minute back
// because GitHub refuses a token issued after its own clock, and exp stays under its ten-minute limit.
function appToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${encodePart({ alg: 'RS256', typ: 'JWT' })}.${encodePart({ iat: now - 60, exp: now + 540, iss: String(credentials.id) })}`;
  return `${data}.${sign('sha256', Buffer.from(data), credentials.pem).toString('base64url')}`;
}

// Furthest GitHub's clock may be from this server's before a refused sign-in is put down to the clock.
const CLOCK_SKEW_MS = 60_000;

// Whether GitHub refused an App's sign-in because of this server's clock: the Date GitHub answered with is more
// than a minute from this server's time, or GitHub's message is about the token's issued-at or expiry time.
async function clockRejected(response) {
  const date = Date.parse(response.headers?.get?.('date') ?? '');
  if (Number.isFinite(date) && Math.abs(date - Date.now()) > CLOCK_SKEW_MS) return true;
  let message = '';
  try { message = String((await response.json())?.message ?? ''); } catch {}
  return /\b(iat|exp)\b|issued at|expiration time/i.test(message);
}

export function createGithubAdapter({ input, fetch: request = globalThis.fetch, output = console.log, run = runProcess }) {
  return {
    async exists(path) {
      try { await files.access(path); return true; } catch { return false; }
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
    // when GitHub no longer knows the App or its saved key cannot sign, 'clock-rejected' when GitHub did not
    // accept the App's sign-in because this server's clock is off, or 'key-rejected' when GitHub did not accept
    // it for any other reason (a deleted App or a revoked key). Throws when GitHub cannot answer, with `refused`
    // set when GitHub refused the request.
    async appStatus({ credentials, repository }) {
      const refused = () => Object.assign(new Error('GitHub refused the request to check the App.'), { refused: true });
      let token;
      try { token = appToken(credentials); } catch { return 'app-missing'; }
      const ask = async path => {
        try {
          return await request(`https://api.github.com${path}`, {
            method: 'GET',
            headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'godspeed-forge' }
          });
        } catch {
          throw new Error('GitHub could not be reached to check the App.');
        }
      };
      const app = await ask('/app');
      if (app.status === 404) return 'app-missing';
      if (app.status === 401) return (await clockRejected(app)) ? 'clock-rejected' : 'key-rejected';
      if (app.status === 403) throw refused();
      if (app.status !== 200) throw new Error('GitHub could not be reached to check the App.');
      const [owner, name] = repository.split('/').map(encodeURIComponent);
      const installation = (await ask(`/repos/${owner}/${name}/installation`)).status;
      if (installation === 404) return 'not-installed';
      if (installation === 401 || installation === 403) throw refused();
      if (installation !== 200) throw new Error('GitHub could not be reached to check the App.');
      return 'installed';
    },
    // Whether the App with this slug is still on GitHub. Forge Apps are private, and GitHub answers 404 for a
    // private App to anyone but its owner, so the question is asked as this server's gh sign-in. Throws when
    // GitHub cannot answer, with `refused` set when GitHub refused the request (HTTP 401 or 403).
    async appExists({ slug, gh = 'gh' }) {
      try {
        await run(gh, ['api', '--method', 'GET', `apps/${encodeURIComponent(slug)}`]);
        return true;
      } catch (error) {
        const stderr = error?.stderr ?? '';
        if (/\(HTTP 404\)/.test(stderr)) return false;
        if (/\(HTTP 40[13]\)/.test(stderr)) throw Object.assign(new Error('GitHub refused the request to check the App.'), { refused: true });
        throw new Error('GitHub could not be reached to check the App.');
      }
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
