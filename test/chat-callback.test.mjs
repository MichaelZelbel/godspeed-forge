// The listener behind the watch page's /forge-setup/* path (lib/chat-callback.mjs), on a loopback port.
// test cases: 3
import assert from 'node:assert/strict';
import { testCase } from './cases.mjs';
import { startCallback, CALLBACK_DONE_PAGE } from '../lib/chat-callback.mjs';

const get = async (url, base) => {
  const target = new URL(url);
  const response = await fetch(`http://127.0.0.1:${base}${target.pathname}${target.search}`);
  return { status: response.status, text: await response.text(), type: response.headers.get('content-type') };
};
const post = (url, base) => fetch(`http://127.0.0.1:${base}${new URL(url).pathname}`, { method: 'POST' }).then(r => r.status);

const port = 43000 + Math.floor(Math.random() * 1000);
const listener = await startCallback({ port, origin: 'https://forge.example.com:48445' });

testCase('the listener answers a ping, serves the App page and gives back only what GitHub sent to that App\'s own address');
{
  assert.match(listener.pingUrl, /^https:\/\/forge\.example\.com:48445\/forge-setup\/[0-9a-f]{32}\/ping$/);
  assert.deepEqual(await get(listener.pingUrl, port), { status: 200, text: 'ok', type: 'text/plain' });
  assert.equal((await get(listener.pageUrl('builder'), port)).status, 404, 'no page before one is set');
  listener.setPage('builder', '<form>builder</form>');
  const page = await get(listener.pageUrl('builder'), port);
  assert.deepEqual([page.status, page.text], [200, '<form>builder</form>']);
  assert.notEqual(listener.pageUrl('builder'), listener.pageUrl('release'));
  const waiting = listener.waitFor('builder', 5000);
  const done = await get(`${listener.doneUrl('builder')}?code=abc123`, port);
  assert.deepEqual([done.status, done.text], [200, CALLBACK_DONE_PAGE]);
  assert.equal(await waiting, 'abc123');
  assert.equal(await listener.waitFor('builder', 10), 'abc123', 'a code that came before the wait is kept');
  assert.equal(await listener.waitFor('release', 20), null, 'the other App has no code');
}

testCase('a second code, a wrong address, a missing code and any other method are all refused as not found');
{
  assert.equal((await get(`${listener.doneUrl('builder')}?code=other`, port)).status, 404);
  assert.equal(await listener.waitFor('builder', 10), 'abc123', 'the first code stays');
  assert.equal((await get(`${listener.doneUrl('release')}`, port)).status, 404, 'no code');
  const wrong = `${listener.doneUrl('release').replace(/[0-9a-f]{32}/, '0'.repeat(32))}?code=x`;
  assert.equal((await get(wrong, port)).status, 404);
  assert.equal((await get(`${listener.pingUrl}/more`, port)).status, 404);
  assert.equal(await post(`${listener.doneUrl('release')}?code=x`, port), 404);
  assert.equal(await listener.waitFor('release', 20), null);
}

testCase('closing the listener frees its port');
{
  await listener.close();
  await assert.rejects(() => get(listener.pingUrl, port));
  await (await startCallback({ port, origin: 'https://forge.example.com:48445' })).close();
}
