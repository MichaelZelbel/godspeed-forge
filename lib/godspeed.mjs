// The one bridge between the Forge and the Godspeed it serves. Nothing else in the Forge knows whether Godspeed runs
// natively on this server or in Docker: it asks findGodspeed() where Godspeed is, and works through the bridge.
//
//   findGodspeed({ run, fs, env, fetch, home, roots }) -> { kind: 'native'|'docker', version, workspace, owner: { uid, gid }, docker? } or null
//   godspeedProblem(found, minimum) -> the plain sentence that stops an install, or null
//   createBridge(found, deps) -> the found fields plus readWorkspaceFile, writeWorkspaceFile, installSkill, sendToOwner, noticesFile
//   openGodspeed(deps) -> createBridge(findGodspeed(deps)), throwing a GodspeedStop with the plain sentence when Godspeed is
//                         missing, not running or too old
//
// Docker (Godspeed's own one-line server installer and the hosting providers' one-click): the install folder holds
// compose.yaml and .godspeed/model-host.json (format 1, kind godspeed-docker, service godspeed, the container's workspace).
// It is found among the folders in /opt, then through the running compose service named godspeed. The version and the
// workspace owner's ids come from inside the container (the health answer on its port 47831, asked as the hermes user);
// the workspace is the host side of the container's mount that holds it (docker inspect), so the Forge reads and writes
// the very files the assistant in the container reads.
// Native: GODSPEED_WORKSPACE, GODSPEED_DIR, the GODSPEED_DIR in a home's .godspeed/device.env, then the usual folders; the
// version from the local health answer, then `godspeed --version` (another program named godspeed can shadow the
// product's command, which is why the health answer comes first and an answer that is not a version counts as none).
//
// Every file the Forge writes into the workspace is written whole (a temporary beside it, then a rename) and handed to the
// workspace's owner, so the assistant can read and change it; in Docker that is the container's hermes user.
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { defaultPaths } from './config.mjs';

export const MINIMUM_GODSPEED = '2.0.0-beta.24';
export const HEALTH_URL = 'http://127.0.0.1:47831/health';
export const FORGE_FOLDER = '.godspeed/forge';
export const NOTICES_FILE = '.godspeed/notices.json';
const KEEP_NOTICES = 50; // what Godspeed's own notice writer keeps
const DOCKER_SERVICE = 'godspeed';

export class GodspeedStop extends Error {}

// A command, never throwing: -> { status, stdout, stderr }; status 127 when it could not be started.
export function runCommand(command, args = [], { input, timeoutMs = 120000, env, cwd } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { resolve({ status: 127, stdout: '', stderr: String(error.message) }); return; }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); resolve({ status: 127, stdout, stderr: stderr || String(error.message) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ status: code ?? 1, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

function withDefaults(deps = {}) {
  return {
    run: deps.run || runCommand,
    fs: deps.fs || nodeFs,
    env: deps.env || process.env,
    fetch: deps.fetch || globalThis.fetch,
    home: deps.home || os.homedir(),
    roots: { opt: '/opt', home: '/home', ...(deps.roots || {}) },
    uid: deps.uid ?? process.getuid?.(),
    now: deps.now || (() => Date.now()),
  };
}

// --- versions ----------------------------------------------------------------------------------------------------

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
export const isVersion = value => typeof value === 'string' && VERSION.test(value.trim());

// -> negative, 0 or positive, as a is older than, the same as or newer than b; null when either is not a version.
export function compareVersions(a, b) {
  const pa = VERSION.exec(String(a ?? '').trim()), pb = VERSION.exec(String(b ?? '').trim());
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
  if (!pa[4] || !pb[4]) return (pa[4] ? -1 : 0) - (pb[4] ? -1 : 0); // a release is newer than its pre-releases
  const xa = pa[4].split('.'), xb = pb[4].split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i]);
    if (na && nb) { if (Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) - Number(xb[i]); }
    else if (na !== nb) return na ? -1 : 1;
    else if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

// The version in a `godspeed --version` answer ("godspeed 2.0.0-beta.29" or "2.0.0-beta.29"), or null.
export function versionFromCommand(output) {
  const first = String(output || '').split(/\r?\n/).find(line => line.trim()) || '';
  const value = first.trim().replace(/^godspeed(?: mission control)?\s+/i, '');
  return isVersion(value) ? value.replace(/^v/, '') : null;
}

// --- finding Godspeed --------------------------------------------------------------------------------------------

const isDirectory = (fs, at) => { try { return fs.statSync(at).isDirectory(); } catch { return false; } };
const isFile = (fs, at) => { try { return fs.statSync(at).isFile(); } catch { return false; } };
const readText = (fs, at) => { try { return fs.readFileSync(at, 'utf8'); } catch { return null; } };
const listNames = (fs, at) => { try { return fs.readdirSync(at).sort(); } catch { return []; } };
const lines = text => String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const absolute = p => typeof p === 'string' && path.posix.isAbsolute(p) && !p.split('/').includes('..');

// An install folder of Godspeed's Docker server: compose.yaml and the installer's marker.
export function dockerInstallation(fs, root) {
  if (typeof root !== 'string' || !root) return null;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(root, '.godspeed', 'model-host.json'), 'utf8'));
    if (marker.format !== 1 || marker.kind !== 'godspeed-docker' || marker.service !== DOCKER_SERVICE || !absolute(marker.workspace)) return null;
    const compose = path.join(root, 'compose.yaml');
    if (!isFile(fs, compose)) return null;
    return { root, compose, service: DOCKER_SERVICE, workspace: marker.workspace };
  } catch { return null; }
}

export const composeArgs = install => ['compose', '-f', install.compose, '--project-directory', install.root];
export const execArgs = (install, args) => [...composeArgs(install), 'exec', '-T', '--user', 'hermes', install.service, ...args];

// Asked inside the container as the hermes user: Godspeed's version from its own health answer, and hermes's ids.
const PROBE = `let version=null;try{const r=await fetch('${HEALTH_URL}',{signal:AbortSignal.timeout(10000)});const j=await r.json();if(typeof j.version==='string')version=j.version;}catch{}
console.log(JSON.stringify({version,uid:process.getuid(),gid:process.getgid()}));`;

// The host side of the container's mount that holds `inside`: the mount whose destination is the longest prefix of it.
export function hostPathOf(mounts, inside) {
  let best = null;
  for (const m of Array.isArray(mounts) ? mounts : []) {
    if (!m || typeof m.Destination !== 'string' || typeof m.Source !== 'string' || !m.Source) continue;
    const d = m.Destination.replace(/\/+$/, '') || '/';
    if (inside !== d && !inside.startsWith(d === '/' ? '/' : `${d}/`)) continue;
    if (!best || d.length > best.d.length) best = { d, source: m.Source };
  }
  if (!best) return null;
  const rest = path.posix.relative(best.d, inside);
  return rest ? path.join(best.source, ...rest.split('/')) : best.source;
}

async function findDocker(d) {
  const candidates = [];
  if (d.env.GODSPEED_DOCKER_DIR) candidates.push(d.env.GODSPEED_DOCKER_DIR);
  for (const name of listNames(d.fs, d.roots.opt)) candidates.push(path.join(d.roots.opt, name));
  const ps = await d.run('docker', ['ps', '--filter', `label=com.docker.compose.service=${DOCKER_SERVICE}`, '--format', '{{.Label "com.docker.compose.project.working_dir"}}']);
  if (ps.status === 0) candidates.push(...lines(ps.stdout));
  const installs = [...new Set(candidates)].map(root => dockerInstallation(d.fs, root)).filter(Boolean);
  if (!installs.length) return null;
  let chosen = null, container = '';
  for (const install of installs) {
    const r = await d.run('docker', [...composeArgs(install), 'ps', '-q', install.service]);
    const id = r.status === 0 ? lines(r.stdout)[0] || '' : '';
    if (/^[0-9a-f]{12,64}$/.test(id)) { chosen = install; container = id; break; }
  }
  if (!chosen) return { kind: 'docker', version: null, running: false, workspace: null, owner: null, docker: installs[0] };
  const probe = await d.run('docker', execArgs(chosen, ['node', '--input-type=module', '-e', PROBE]), { timeoutMs: 60000 });
  let answer = {};
  try { answer = JSON.parse(lines(probe.stdout).at(-1) || '{}'); } catch { answer = {}; }
  const inspected = await d.run('docker', ['inspect', container]);
  let workspace = null;
  try { workspace = hostPathOf(JSON.parse(inspected.stdout)[0].Mounts, chosen.workspace); } catch { workspace = null; }
  let owner = Number.isInteger(answer.uid) && Number.isInteger(answer.gid) ? { uid: answer.uid, gid: answer.gid } : null;
  if (!owner && workspace) { try { const s = d.fs.statSync(workspace); owner = { uid: s.uid, gid: s.gid }; } catch { owner = null; } }
  const version = d.env.GODSPEED_VERSION || (isVersion(answer.version) ? answer.version : null);
  return { kind: 'docker', version, running: true, workspace, owner, docker: { ...chosen, container } };
}

// GODSPEED_DIR=... in a home's .godspeed/device.env.
function deviceDir(fs, home) {
  const text = readText(fs, path.join(home, '.godspeed', 'device.env'));
  const m = text && /^[ \t]*GODSPEED_DIR=(.*)$/m.exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

function nativeWorkspace(d) {
  const homes = [d.home];
  if (d.env.SUDO_USER) homes.push(path.join(d.roots.home, d.env.SUDO_USER));
  for (const name of listNames(d.fs, d.roots.home)) homes.push(path.join(d.roots.home, name));
  const candidates = [d.env.GODSPEED_DIR, ...homes.map(h => deviceDir(d.fs, h)), ...homes.flatMap(h => [path.join(h, 'godspeed'), path.join(h, 'godspeed-v2')])];
  return [...new Set(candidates.filter(Boolean))].find(c => isDirectory(d.fs, path.join(c, '.godspeed'))) || null;
}

async function healthVersion(d) {
  if (typeof d.fetch !== 'function') return null;
  try {
    const r = await d.fetch(d.env.GODSPEED_HEALTH_URL || HEALTH_URL, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return isVersion(j?.version) ? j.version : null;
  } catch { return null; }
}

// The product's command on the PATH, in this account's ~/.local/bin, and in that of the account whose home holds the
// workspace (a server's assistant account owns its Godspeed, and root's PATH does not reach it).
async function commandVersion(d, workspace) {
  const commands = ['godspeed', path.join(d.home, '.local', 'bin', 'godspeed')];
  if (workspace) commands.push(path.join(path.dirname(workspace), '.local', 'bin', 'godspeed'));
  for (const command of [...new Set(commands)]) {
    const r = await d.run(command, ['--version'], { timeoutMs: 20000 });
    const v = r.status === 0 ? versionFromCommand(r.stdout) : null;
    if (v) return v;
  }
  return null;
}

async function findNative(d, workspace) {
  const version = d.env.GODSPEED_VERSION || await healthVersion(d) || await commandVersion(d, workspace);
  let owner;
  try { const s = d.fs.statSync(workspace); owner = { uid: s.uid, gid: s.gid }; }
  catch { owner = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }; }
  return { kind: 'native', version: version || null, workspace, owner };
}

export async function findGodspeed(deps = {}) {
  const d = withDefaults(deps);
  if (d.env.GODSPEED_WORKSPACE) return findNative(d, path.resolve(d.env.GODSPEED_WORKSPACE));
  const docker = await findDocker(d);
  if (docker) return docker;
  const workspace = nativeWorkspace(d);
  if (workspace) return findNative(d, workspace);
  const version = d.env.GODSPEED_VERSION || await healthVersion(d);
  return version ? { kind: 'native', version, workspace: null, owner: null } : null;
}

export const STOP = {
  none: 'The Forge needs Godspeed Mission Control on this server, and none was found. Install Godspeed first, then run this line again.',
  notRunning: 'Godspeed is installed on this server but is not running, so the Forge could not check its version and installed nothing. Start Godspeed again (running its own install line does that), then run this line again.',
  noVersion: 'Godspeed was found on this server, but it did not say which version it is, so nothing was installed. Make sure Godspeed is running, then run this line again.',
  noWorkspace: 'Godspeed runs on this server, but the Forge could not find its folder, so nothing was installed. Run this line again with GODSPEED_WORKSPACE set to that folder.',
  tooOld: (version, minimum) => `Godspeed ${version} is installed; the Forge requires Godspeed ${minimum} or newer. Update Godspeed, then run this line again.`,
};

export function godspeedProblem(found, minimum = MINIMUM_GODSPEED) {
  if (!found) return STOP.none;
  if (found.kind === 'docker' && found.running === false) return STOP.notRunning;
  if (!found.version) return STOP.noVersion;
  const order = compareVersions(found.version, minimum);
  if (order === null || order < 0) return STOP.tooOld(found.version, minimum);
  if (!found.workspace) return STOP.noWorkspace;
  return null;
}

// --- the bridge --------------------------------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One writer at a time for a file several programs write: a lock folder beside it, taken over when it is older than
// 30 seconds (its writer is gone), as driver/onduty.mjs does for the notice queue.
export async function withLockFolder(fs, file, fn, { tries = 100, staleMs = 30000 } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let got = false;
  for (let i = 0; i < tries && !got; i++) {
    try { fs.mkdirSync(lock); got = true; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) { fs.rmdirSync(lock); continue; } } catch {}
      await sleep(100);
    }
  }
  if (!got) throw new Error(`${path.basename(file)} is locked by another program`);
  try { return await fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}

function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// The bot's token and the owner's chat from an assistant's .env, the way the Clerk reads them: the home channel first,
// else the one allowed user (their private chat with the bot).
export function telegramCredentials(envText) {
  const env = parseEnv(envText);
  const token = env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN || '';
  const allowed = String(env.TELEGRAM_ALLOWED_USERS || '').split(/[,\s]+/).filter(Boolean);
  const chat = env.TELEGRAM_HOME_CHANNEL || env.TELEGRAM_CHAT_ID || env.CHAT_ID || (allowed.length === 1 ? allowed[0] : '');
  return token && chat ? { token, chat: String(chat) } : null;
}

// Read inside the container, as the Clerk's dockerAssistantEnv does: the verified assistant's home names its .env.
const ASSISTANT_ENV = "const fs=require('node:fs'),path=require('node:path');const d=JSON.parse(fs.readFileSync(path.join(process.argv[1],'.godspeed/assistant.json'),'utf8'));if(!d.verified||!path.isAbsolute(d.home))throw Error('No verified assistant');process.stdout.write(fs.readFileSync(path.join(d.home,'.env'),'utf8'));";

const fit = (text, max = 4000) => { const t = String(text); return t.length <= max ? t : `${t.slice(0, max - 3)}...`; };

export function createBridge(found, deps = {}) {
  if (!found || !found.workspace) throw new GodspeedStop(godspeedProblem(found) || STOP.none);
  const d = withDefaults(deps);
  const fs = d.fs;
  const root = found.workspace;
  const stateDir = deps.stateDir || defaultPaths().state;
  const sentFile = path.join(stateDir, 'godspeed', 'sent.json');

  const at = rel => {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).some(part => part === '..')) {
      throw new Error(`not a path inside the Godspeed workspace: ${rel}`);
    }
    return path.join(root, ...rel.split(/[\\/]/).filter(Boolean));
  };
  // Handed to the workspace's owner: only root may give a file away, and only when the owner is someone else.
  const toOwner = target => {
    if (d.uid !== 0 || !found.owner) return;
    if (d.uid === found.owner.uid && found.owner.uid === 0 && found.owner.gid === 0) return;
    fs.chownSync(target, found.owner.uid, found.owner.gid);
  };
  // Every missing folder from the workspace down to `dir`, each made and handed to the owner.
  const folder = dir => {
    fs.mkdirSync(root, { recursive: true });
    let here = root;
    for (const part of path.relative(root, dir).split(path.sep).filter(Boolean)) {
      here = path.join(here, part);
      try { fs.mkdirSync(here); toOwner(here); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return dir;
  };

  const bridge = {
    kind: found.kind, version: found.version, workspace: root, owner: found.owner, ...(found.docker ? { docker: found.docker } : {}),
    workspacePath: rel => at(rel),
    makeWorkspaceFolder: rel => folder(at(rel)),
    readWorkspaceFile(rel) {
      try { return fs.readFileSync(at(rel), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    // Written whole: a temporary beside the file, handed to the owner, then renamed over it.
    writeWorkspaceFile(rel, content) {
      const file = at(rel);
      folder(path.dirname(file));
      const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(temporary, content, { mode: 0o644 });
        toOwner(temporary);
        fs.renameSync(temporary, file);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch {}
        throw error;
      }
      return file;
    },
    listWorkspaceFolder(rel) { try { return fs.readdirSync(at(rel)).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } },
    moveWorkspaceFile(fromRel, toRel) { const to = at(toRel); folder(path.dirname(to)); fs.renameSync(at(fromRel), to); return to; },
    // A skill folder into <workspace>/skills/<name>/, where the assistant reads every SKILL.md.
    installSkill(name, sourceDir) {
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`not a skill name: ${name}`);
      const written = [];
      const walk = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const inside = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), inside);
          else if (entry.isFile()) written.push(bridge.writeWorkspaceFile(`skills/${name}/${inside}`, fs.readFileSync(path.join(dir, entry.name))));
        }
      };
      walk(sourceDir, '');
      if (!written.length) throw new Error(`the skill ${name} has no files`);
      return written;
    },
    noticesFile: () => path.join(root, ...NOTICES_FILE.split('/')),
    // A notice in Godspeed's own queue (its notebook/core/notices.mjs format), which Godspeed says within 15 minutes.
    async queueNotice(id, text) {
      const file = bridge.noticesFile();
      folder(path.dirname(file));
      return withLockFolder(fs, file, () => {
        let notices = [];
        const old = readText(fs, file);
        if (old !== null && old.trim()) {
          const data = JSON.parse(old);
          if (!Array.isArray(data?.notices)) throw new Error('the queued notices cannot be read');
          notices = data.notices;
        }
        if (notices.some(n => n && n.id === id)) return false;
        const words = String(text).trim();
        notices.push({ id, text: words, at: new Date(d.now()).toISOString(), about: 'A message from the Forge', facts: [words], written: true });
        bridge.writeWorkspaceFile(NOTICES_FILE, `${JSON.stringify({ notices: notices.slice(-KEEP_NOTICES) }, null, 2)}\n`);
        return true;
      });
    },
    async telegram() {
      let text = '';
      if (found.kind === 'docker' && found.docker) {
        const r = await d.run('docker', execArgs(found.docker, ['node', '-e', ASSISTANT_ENV, found.docker.workspace]), { timeoutMs: 60000 });
        text = r.status === 0 ? r.stdout : '';
        return telegramCredentials(text);
      }
      const files = [];
      try {
        const a = JSON.parse(fs.readFileSync(path.join(root, '.godspeed', 'assistant.json'), 'utf8'));
        if (a.verified && typeof a.home === 'string' && path.isAbsolute(a.home)) files.push(path.join(a.home, '.env'));
      } catch {}
      files.push(path.join(root, '.godspeed', 'integrated-runtime', 'hermes', '.env'));
      if (d.env.HERMES_HOME) files.push(path.join(d.env.HERMES_HOME, '.env'));
      files.push(path.join(d.home, '.hermes', '.env'));
      for (const f of files) { const c = telegramCredentials(readText(fs, f)); if (c) return c; }
      return null;
    },
    // Once per id, never twice: through the owner's own assistant's Telegram bot when it has one, else as a Godspeed
    // notice. -> { sent, how: 'telegram'|'notice', already? }.
    // The id is recorded as being sent (written whole) before the request to Telegram leaves, so a run that stops at any
    // later moment never sends it again. Every outcome after the request may have left (an answer, a timeout, a reset, a
    // cut-off or unreadable answer) counts as sent. The notice takes over only when the message certainly never reached
    // the owner: no bot, a failure before the request could leave (the name not found, the connection refused), or
    // Telegram's own refusal. A notice is recorded as being queued first; the queue is kept by id, so queueing it again
    // after a stop never makes two, and a later call finishes it without asking Telegram.
    async sendToOwner(text, { id } = {}) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) throw new Error('a message to the owner needs an id');
      if (typeof text !== 'string' || !text.trim()) throw new Error('a message to the owner needs its words');
      fs.mkdirSync(path.dirname(sentFile), { recursive: true, mode: 0o700 });
      return withLockFolder(fs, sentFile, async () => {
        let sent = {};
        try { sent = JSON.parse(fs.readFileSync(sentFile, 'utf8')) || {}; } catch {}
        const save = (how, state) => {
          sent[id] = { at: new Date(d.now()).toISOString(), how, state };
          const temporary = `${sentFile}.${process.pid}.tmp`;
          fs.writeFileSync(temporary, `${JSON.stringify(sent, null, 2)}\n`, { mode: 0o600 });
          fs.renameSync(temporary, sentFile);
        };
        const notice = async () => {
          save('notice', 'queueing');
          const queued = await bridge.queueNotice(`forge-${id}`, text);
          save('notice', 'sent');
          return queued ? { sent: true, how: 'notice' } : { sent: false, how: 'notice', already: true };
        };
        const before = sent[id];
        if (before) return before.how === 'notice' && before.state === 'queueing' ? notice() : { sent: false, how: before.how, already: true };
        const creds = await bridge.telegram().catch(() => null);
        if (creds) {
          save('telegram', 'sending');
          const outcome = await sendTelegram(d, creds, text);
          if (outcome !== 'not-sent') { save('telegram', outcome); return { sent: true, how: 'telegram' }; }
        }
        return notice();
      });
    },
  };
  return bridge;
}

function telegramBase(env) {
  if (env.FORGE_TELEGRAM_API) {
    if (env.FORGE_TEST !== '1') throw new Error('a stand-in Telegram address is honoured only in test mode');
    return env.FORGE_TELEGRAM_API.replace(/\/+$/, '');
  }
  return 'https://api.telegram.org';
}

// Failures that happen before a request can leave this server: the name was not found, or no connection was made.
const NEVER_LEFT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
const errorCode = error => error?.cause?.code || error?.code || '';

// -> 'sent' when Telegram said it took the message; 'not-sent' only when it certainly did not reach the owner (the
// request never left, or Telegram answered in full that it refused it); 'unsure' for every other outcome after the
// request may have left (no answer in time, a reset, a cut-off or unreadable answer), which counts as sent.
export async function sendTelegram(d, creds, text) {
  let base;
  try { base = telegramBase(d.env); } catch { return 'not-sent'; }
  let response;
  try {
    response = await d.fetch(`${base}/bot${creds.token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: creds.chat, text: fit(text), disable_web_page_preview: true }), signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    return NEVER_LEFT.has(errorCode(error)) ? 'not-sent' : 'unsure';
  }
  let answer;
  try { answer = JSON.parse(await response.text()); } catch { return 'unsure'; }
  if (answer && answer.ok === true) return 'sent';
  // Telegram's own refusal (the bot was blocked, the chat is wrong, too many messages): nothing was delivered.
  if (answer && answer.ok === false && Number.isInteger(answer.error_code) && answer.error_code >= 400 && answer.error_code < 500) return 'not-sent';
  return 'unsure';
}

export async function openGodspeed(deps = {}) {
  const found = await findGodspeed(deps);
  const problem = godspeedProblem(found, deps.minimum || MINIMUM_GODSPEED);
  if (problem) throw new GodspeedStop(problem);
  return createBridge(found, deps);
}
