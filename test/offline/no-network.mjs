// Loaded into every node process the test suite starts (test/run.sh adds it to NODE_OPTIONS): a connection
// or name lookup for anything but this machine is refused before it leaves, and is written to
// $FORGE_TEST_NETWORK_LOG so test/run.sh fails the test file that made it, even when the code under test
// turns the refusal into an ordinary stop. Connections to this machine (stand-in servers, the setup lock)
// and to local sockets still work.
import dns from 'node:dns';
import { appendFileSync, writeSync } from 'node:fs';
import net from 'node:net';

const LOCAL = new Set(['localhost', '::1', '::', '0.0.0.0', '']);
const isLocal = host => host === undefined || host === null || LOCAL.has(String(host).toLowerCase())
  || /^127\./.test(host) || /^::ffff:127\./i.test(host) || String(host).toLowerCase().endsWith('.localhost');

function refuse(what) {
  const line = `${what} (${process.argv.slice(1).join(' ')})`;
  try { if (process.env.FORGE_TEST_NETWORK_LOG) appendFileSync(process.env.FORGE_TEST_NETWORK_LOG, `${line}\n`); } catch {}
  try { writeSync(2, `The test suite refused a network connection: ${line}\n`); } catch {}
  return Object.assign(new Error(`The test suite does not reach the network: ${what}`), { code: 'ENETUNREACH' });
}

// The target of a Socket#connect call, in each form node accepts: (options), ([options, callback]) as node
// passes internally, (port, host), (path).
function target(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first !== null && typeof first === 'object') return first;
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first };
  return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const { path, host, port } = target(args);
  if (path === undefined && !isLocal(host)) {
    const error = refuse(`connect to ${host}:${port}`);
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return connect.apply(this, args);
};

const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (!isLocal(host) && net.isIP(host) === 0) {
    const error = refuse(`look up ${host}`);
    const callback = rest.at(-1);
    if (typeof callback === 'function') process.nextTick(() => callback(error));
    return {};
  }
  return lookup.call(this, host, ...rest);
};
const lookupPromise = dns.promises.lookup;
dns.promises.lookup = function (host, ...rest) {
  if (!isLocal(host) && net.isIP(host) === 0) return Promise.reject(refuse(`look up ${host}`));
  return lookupPromise.call(this, host, ...rest);
};
