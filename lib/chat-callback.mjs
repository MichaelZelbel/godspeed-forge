// The listener that gives the chat's setup a way back from GitHub. GitHub's App creation page ends by sending the
// owner's browser to an address with a one-time code, and nothing else carries that code, so while a chat setup waits
// the worker listens here on this server's own loopback and the watch page's site passes /forge-setup/* on to it
// (lib/watch.mjs siteText). Each App has its own random address, so nothing else on the internet can reach a page
// or hand over a code; the first code that arrives at an App's address is the only one taken.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export const CALLBACK_DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>Forge</title><p>You can go back to the chat now.</p>';
const token = () => randomBytes(16).toString('hex');

// -> { pageUrl(kind), doneUrl(kind), pingUrl, setPage(kind, html), waitFor(kind, ms), close() }. origin is the watch
// page's address (https://host:port); the listener binds 127.0.0.1:port. waitFor resolves with the code, or null when
// the time is up.
export async function startCallback({ port, origin, kinds = ['builder', 'release'] }) {
  const tokens = Object.fromEntries(kinds.map(kind => [kind, token()]));
  const pingToken = token();
  const pages = {};
  const codes = {};
  const waiting = {};
  const base = value => `${origin}/forge-setup/${value}`;
  const server = createServer((request, response) => {
    const send = (status, type, body) => { response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); response.end(body); };
    const missing = () => send(404, 'text/plain', 'Not found');
    if (request.method !== 'GET') return missing();
    const url = new URL(request.url, 'http://127.0.0.1');
    const [, root, value, action, ...more] = url.pathname.split('/');
    if (root !== 'forge-setup' || more.length) return missing();
    if (value === pingToken && action === 'ping') return send(200, 'text/plain', 'ok');
    const kind = kinds.find(name => tokens[name] === value);
    if (!kind) return missing();
    if (action === 'create' && pages[kind]) return send(200, 'text/html; charset=utf-8', pages[kind]);
    if (action === 'done') {
      const code = url.searchParams.get('code')?.trim();
      if (!code || codes[kind]) return missing();
      codes[kind] = code;
      waiting[kind]?.(code);
      return send(200, 'text/html; charset=utf-8', CALLBACK_DONE_PAGE);
    }
    return missing();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    pageUrl: kind => `${base(tokens[kind])}/create`,
    doneUrl: kind => `${base(tokens[kind])}/done`,
    pingUrl: `${base(pingToken)}/ping`,
    setPage(kind, html) { pages[kind] = html; },
    waitFor(kind, ms) {
      if (codes[kind]) return Promise.resolve(codes[kind]);
      return new Promise(resolve => {
        const timer = setTimeout(() => { delete waiting[kind]; resolve(null); }, ms);
        timer.unref?.();
        waiting[kind] = code => { clearTimeout(timer); resolve(code); };
      });
    },
    close: () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections?.(); })
  };
}
