// The chat talks to the Forge through files in Godspeed's workspace, <workspace>/.godspeed/forge/:
//   inbox/<id>.json    a request the assistant wrote: { id, kind, project, words, at, ... } with the owner's own words
//   outbox/<id>.json   the Forge's answer: { id, ok, say }, `say` being the plain words the chat gives the owner
//   inbox/done/        every request the Forge took, so each is handled once, also across restarts
// `godspeed-forge inbox` handles every request waiting there, one at a time, and keeps going after a bad one. A systemd
// path unit starts it when a file lands, and a one-minute timer is the fallback (lib/install/inbox-units.mjs). Two runs
// never overlap: a lock folder in the Forge's private state.
//
// A request is taken by moving it to done/<id>.json before its handler runs, and answered after. A run that was stopped
// in between leaves a taken request with no answer; the next run answers it as interrupted instead of doing it twice.
import nodeFs from 'node:fs';
import path from 'node:path';
import { FORGE_FOLDER, openGodspeed } from './godspeed.mjs';
import { dispatch, SAY } from './owner/index.mjs';
import { defaultPaths, defaults, readConfig } from './config.mjs';

export const INBOX = `${FORGE_FOLDER}/inbox`;
export const DONE = `${INBOX}/done`;
export const OUTBOX = `${FORGE_FOLDER}/outbox`;
export const PROJECTS = `${FORGE_FOLDER}/projects`;
export const WAITING = `${FORGE_FOLDER}/waiting.json`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FRESH_MS = 10000;          // a request this young that cannot be read yet may still be being written
const KEEP_MS = 30 * 86400000;   // answers and taken requests are kept 30 days
const LOCK_STALE_MS = 30 * 60000;

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// The inbox lock: a folder holding the pid of the run that has it, taken over when that run is gone or the lock is old.
export function takeInboxLock(fs, dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), `${process.pid}\n`);
      return () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid = NaN, age = 0;
      try { pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim()); } catch {}
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch {}
      const gone = Number.isInteger(pid) && pid > 0 ? !alive(pid) : age > FRESH_MS;
      if (!gone && age < LOCK_STALE_MS) return null;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
  return null;
}

const idOf = (request, stem) => (request && typeof request.id === 'string' && ID.test(request.id) ? request.id
  : ID.test(stem) ? stem : `request-${stem.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || Date.now()}`);

export async function runInbox({ gs, config = {}, paths = defaultPaths(), now = () => Date.now(), log = () => {}, fs = nodeFs, lockDir, dispatchOptions } = {}) {
  const release = takeInboxLock(fs, lockDir || path.join(paths.state, 'inbox.lock'));
  if (!release) { log('Another run is handling the chat requests.'); return { handled: [], skipped: true }; }
  const handled = [];
  try {
    for (const rel of [INBOX, DONE, OUTBOX]) gs.makeWorkspaceFolder(rel);
    const answered = id => gs.readWorkspaceFile(`${OUTBOX}/${id}.json`) !== null;
    const answer = (id, ok, say) => gs.writeWorkspaceFile(`${OUTBOX}/${id}.json`, `${JSON.stringify({ id, ok, say }, null, 2)}\n`);

    // Requests a stopped run took and never answered.
    for (const name of gs.listWorkspaceFolder(DONE)) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!ID.test(id) || answered(id)) continue;
      try { if (now() - fs.statSync(gs.workspacePath(`${DONE}/${name}`)).mtimeMs > KEEP_MS) continue; } catch { continue; }
      answer(id, false, SAY.interrupted);
      log(`Answered the request ${id} as interrupted: a run took it and stopped before it was done.`);
      handled.push({ id, kind: null, ok: false, interrupted: true });
    }

    const handleOne = async name => {
      const file = gs.workspacePath(`${INBOX}/${name}`);
      let stat;
      try { stat = fs.lstatSync(file); } catch { return null; }
      if (!stat.isFile()) return null;
      const stem = name.slice(0, -5);
      let request = null;
      try { request = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
        if (now() - stat.mtimeMs < FRESH_MS) return null; // still being written: the next run reads it
      }
      const readable = request !== null && typeof request === 'object' && !Array.isArray(request);
      const id = idOf(readable ? request : null, stem);
      if (answered(id)) { // the same request again, answered before: kept, and its answer stands
        gs.moveWorkspaceFile(`${INBOX}/${name}`, `${DONE}/${id}.json.again-${now()}`); // not a .json name: never taken for a request
        return null;
      }
      gs.moveWorkspaceFile(`${INBOX}/${name}`, `${DONE}/${id}.json`);
      let result;
      if (!readable) result = { ok: false, say: SAY.unreadable };
      else {
        try {
          result = await dispatch(request, { gs, config, paths, now: now(), log }, dispatchOptions);
        } catch (error) {
          log(`The ${request.kind} request ${id} failed: ${String(error?.message || error).split('\n')[0]}`);
          result = { ok: false, say: SAY.failed };
        }
      }
      answer(id, result.ok, result.say);
      log(`Answered the ${readable && typeof request.kind === 'string' ? request.kind : 'unreadable'} request ${id}: ${result.ok ? 'done' : 'not done'}.`);
      return { id, kind: readable ? request.kind : null, ok: result.ok, say: result.say };
    };

    // Until the inbox holds nothing new: a request that lands while one is handled is handled in the same run.
    for (let round = 0; round < 50; round++) {
      let progressed = false;
      for (const name of gs.listWorkspaceFolder(INBOX).filter(n => n.endsWith('.json'))) {
        const r = await handleOne(name);
        if (r) { handled.push(r); progressed = true; }
      }
      if (!progressed) break;
    }

    // Old answers and taken requests go after 30 days.
    for (const rel of [DONE, OUTBOX]) {
      for (const name of gs.listWorkspaceFolder(rel)) {
        const file = gs.workspacePath(`${rel}/${name}`);
        try { const s = fs.lstatSync(file); if (s.isFile() && now() - s.mtimeMs > KEEP_MS) fs.unlinkSync(file); } catch {}
      }
    }
  } finally { release(); }
  return { handled };
}

// Whether the inbox folder at `inbox` (its path on this server) holds nothing to do: no request waiting, and every taken
// request answered. The service's one-minute timer asks this first, so an empty inbox costs no look for Godspeed.
export function inboxIdle(inbox, fs = nodeFs) {
  let names;
  try { names = fs.readdirSync(inbox); } catch { return false; }
  if (names.some(n => n.endsWith('.json'))) return false;
  let done = [];
  try { done = fs.readdirSync(path.join(inbox, 'done')); } catch { return true; }
  const outbox = path.join(inbox, '..', 'outbox');
  return done.every(name => { const id = name.slice(0, -5); return !name.endsWith('.json') || !ID.test(id) || fs.existsSync(path.join(outbox, name)); });
}

// `godspeed-forge inbox` -> the exit code. What it says goes to the server's log, never to the owner. FORGE_INBOX, which
// the service sets, names the inbox folder on this server, so a run with nothing to do ends at once.
export async function runInboxCommand({ paths = defaultPaths(), output = line => console.log(line), open = openGodspeed, deps = {}, env = process.env } = {}) {
  if (env.FORGE_INBOX && inboxIdle(env.FORGE_INBOX)) return 0;
  let gs;
  try { gs = await open({ stateDir: paths.state, ...deps }); } catch (error) { output(error.message); return 1; }
  let config;
  try { config = await readConfig(paths.config); } catch { config = defaults(); }
  try {
    const r = await runInbox({ gs, config, paths, log: output, ...(deps.inbox || {}) });
    if (r.handled.length) output(`Handled ${r.handled.length} chat request${r.handled.length === 1 ? '' : 's'}.`);
    return 0;
  } catch (error) { output(`The chat requests could not be handled: ${error.message}`); return 1; }
}
