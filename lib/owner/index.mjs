// What the owner asks for in the chat, by kind, to the code that carries it out. lib/inbox.mjs hands every request
// here. A handler is `async (request, ctx) => ({ ok, say })`, with ctx = { gs, config, paths, now, log }: `gs` the bridge
// to Godspeed (lib/godspeed.mjs), `config` the Forge's settings, `paths` its folders (lib/config.mjs defaultPaths),
// `now` the time in milliseconds, `log` a line for the server's log. `say` is the plain words the chat gives the owner.
//
// The modules are loaded when a request of their kind arrives, so a module that is not on this server yet (or lacks
// the handler) is answered plainly instead of stopping every other kind.
import { fileURLToPath } from 'node:url';

const HANDLERS = {
  plan: ['./releases.mjs', 'plan'],
  go: ['./releases.mjs', 'go'],
  'take-back': ['./releases.mjs', 'takeBack'],
  status: ['./releases.mjs', 'status'],
  answer: ['./questions.mjs', 'answer'],
  'work-on': ['../factory-control.mjs', 'workOn'],
  'work-off': ['../factory-control.mjs', 'workOff'],
  lap: ['../factory-control.mjs', 'lap'],
};

export const KINDS = Object.freeze(Object.keys(HANDLERS));

export const SAY = {
  unknown: 'The Forge did not understand that request and did nothing.',
  notYet: 'The Forge cannot do that yet on this server.',
  failed: 'Something went wrong on the server while the Forge worked on that, so it may not be done. Try again in a few minutes.',
  unreadable: 'The Forge could not read that request and did nothing.',
  interrupted: 'The Forge was interrupted while it worked on that, so it may not be done. Try again in a few minutes.',
};

// Whether the import failed because the module itself is not there (not because something it imports is missing).
function moduleMissing(error, url) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') return false;
  if (error.url === url) return true;
  const file = fileURLToPath(url);
  return String(error.message).includes(`'${file}'`) || String(error.message).includes(`'${url}'`);
}

// -> { known: false } for a kind the Forge does not have; { known: true, handler } where handler is null when its module
// or its export is not on this server. Any other failure to load (a broken module) is thrown.
export async function handlerFor(kind, { base = import.meta.url } = {}) {
  if (typeof kind !== 'string' || !Object.hasOwn(HANDLERS, kind)) return { known: false };
  const [specifier, name] = HANDLERS[kind];
  const url = new URL(specifier, base).href;
  let mod;
  try { mod = await import(url); } catch (error) {
    if (moduleMissing(error, url)) return { known: true, handler: null };
    throw error;
  }
  return { known: true, handler: typeof mod[name] === 'function' ? mod[name] : null };
}

// -> { ok, say }. A handler that throws, or answers without words for the owner, throws here; the inbox answers that
// plainly and keeps going.
export async function dispatch(request, ctx, options = {}) {
  const found = await handlerFor(request?.kind, options);
  if (!found.known) return { ok: false, say: SAY.unknown };
  if (!found.handler) return { ok: false, say: SAY.notYet };
  const answer = await found.handler(request, ctx);
  if (!answer || typeof answer !== 'object' || typeof answer.say !== 'string' || !answer.say.trim()) {
    throw new Error(`the ${request.kind} handler gave no words for the owner`);
  }
  return { ok: answer.ok === true, say: answer.say.trim() };
}
