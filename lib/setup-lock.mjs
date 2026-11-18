import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

// The name lives in Linux's abstract socket namespace: holding it creates no file, and the kernel frees it
// when the holding process exits or is killed, so a crashed setup never leaves the repository blocked.
function setupName(stateRoot, repository) {
  const key = `${resolve(stateRoot)}\n${repository.toLowerCase()}`;
  return `\0godspeed-forge-setup-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

// Resolves to a function that releases the hold, or to null when another setup for the repository holds it.
export function holdSetup(stateRoot, repository) {
  return new Promise((resolveHold, reject) => {
    const server = createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? resolveHold(null) : reject(error));
    server.listen(setupName(stateRoot, repository), () => {
      server.unref();
      resolveHold(() => new Promise(done => server.close(() => done())));
    });
  });
}
