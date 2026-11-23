// The page where the owner watches the factory: Archon's own web pages, showing every project, every run (lap) and
// each step of a run, behind a web address of its own and a sign-in, and unable to start or change anything.
//
// What ensureWatchPage puts on a server (root, Linux, systemd), each step looking for its own result first, so running
// it again changes only what is missing or out of date:
//   1. a copy of Archon at the revision the Forge installs (lib/constants.mjs), built once for its web pages in
//      /opt/godspeed-forge/watch/archon-<revision>, which the factory's account can read, apart from the copy the
//      factory checks, which stays untouched; a new revision is built beside the old one, which goes once the new one
//      answers;
//   2. the sign-in: the user name "forge" and a password made on this server, kept with the page's record in the
//      Forge's private state (watch.json, 0600); Caddy holds only its bcrypt hash;
//   3. the service godspeed-forge-watch: Archon's server as the account the factory runs as (driver.json's
//      server.factory_user, root on a server the Forge set up), listening on 127.0.0.1 only. It has no
//      ARCHON_TRIGGER_HOST, so it starts no run of its own, and systemd lets it reach no address but this server's
//      own, so it cannot reach GitHub or an AI either: Archon's six-hourly tidy-up of old work folders, which runs in
//      every Archon server, cannot finish and changes nothing;
//   4. the web address: https://<the server's name>:<port>, through the Caddy that gives Godspeed's notebook its
//      address, the same way the Clerk gives Paperless its address (godspeed-clerk lib/install/https.mjs). On a
//      native Godspeed a site file of the Forge's own in /etc/caddy/godspeed-addons/ (docs/full-version/
//      addon-model.md in Godspeed: checked with caddy validate first, taken out again when Caddy refuses it); on
//      Godspeed's Docker server a Caddy container of the Forge's own that shares the certificates of Godspeed's. The
//      site asks for the sign-in first, lets only GET and HEAD through (so nothing on the page can start, stop or
//      answer a run) and never hands on Archon's internal and webhook paths;
//   5. the firewall on the server itself lets the port in (ufw or firewalld, when one is on);
//   6. an hourly timer (godspeed-forge-watch-keep) that runs this again, so a site, container or service that went
//      missing comes back.
// The page counts as ready only when Archon answers on this server and the address answers over HTTPS: refusing a
// visit without the sign-in, and letting one with it see Archon's health answer.
import nodeFs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ARCHON_REVISION, ARCHON_SOURCE } from './constants.mjs';
import { composeArgs, dockerInstallation, runCommand } from './godspeed.mjs';
import { defaultPaths } from './config.mjs';
import { takeInboxLock } from './inbox.mjs';

export const UNIT = 'godspeed-forge-watch';
export const KEEP_UNIT = 'godspeed-forge-watch-keep';
export const USER = 'forge';
// The Clerk gives Paperless 48444; the Forge's page starts one above it and never takes that one.
export const FIRST_PORT = 48445;
const CLERK_PORT = 48444;
export const FIRST_UPSTREAM = 3190;
export const PAGES_DIR = '/opt/godspeed-forge/watch';
export const ADDON_DIR = '/etc/caddy/godspeed-addons';
export const SITE_FILE = `${ADDON_DIR}/godspeed-forge.caddy`;
export const DOCKER_CADDYFILE = '/opt/godspeed-forge/https/Caddyfile';
export const CONTAINER = 'godspeed-forge-https';
const OWNER_LABEL = 'org.godspeed.forge.role';
const OWN_UNIT = 'godspeed-https.service';
const SERVER_CADDYFILE = '/etc/caddy/Caddyfile';
const NOTEBOOK_SITE = '/etc/caddy/godspeed-notebook.caddy';
const CLERK_DOCKER_CADDYFILE = '/opt/godspeed-clerk/https/Caddyfile';
const ADDON_IMPORT = /^\s*import\s+\/etc\/caddy\/godspeed-addons\/\*\.caddy\s*$/m;
// Letters and digits nobody mistakes for one another when typing them from a screen.
const PASSWORD_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const BCRYPT = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;
// Run with bun, which the factory needs on every Forge server: the password comes on standard input, never as an argument.
const HASH_SCRIPT = 'const p=(await Bun.stdin.text()).trim();process.stdout.write(await Bun.password.hash(p,{algorithm:"bcrypt",cost:12}))';

// What the owner reads. `again` ends a failure with what to do: the install line and setup each say it their own way.
export const SAY = {
  preparing: 'Preparing the page where you watch the factory. This takes a few minutes.',
  installed: address => `The page where you watch the factory is at ${address}. Type godspeed-forge watch here to see how to sign in.`,
  login: ({ address, user, password }) => `Watch the factory at ${address}. Sign in as ${user} with the password ${password}; keep both in your password manager.`,
  firewall: port => `If the page does not open, your hosting company's firewall may be blocking it: let port ${port} in there.`,
  failed: (why, again) => `The page where you watch the factory could not be set up: ${why}. ${again}`,
  againInstall: 'Run this line again to try once more.',
  againWatch: 'Type godspeed-forge watch in this terminal, as root, to try again.',
};
export const WHY = {
  noFront: "this server has no web address from Godspeed for it to share, because Godspeed's notebook has none yet",
  oldGodspeed: 'the Godspeed on this server is too old to give add-ons a web address; update Godspeed first',
  noName: "Godspeed's web address on this server has no name the page can use",
  noBun: 'Bun, which the factory needs, is not installed on this server',
  login: 'its sign-in could not be made',
  build: "the factory's pages could not be downloaded and prepared",
  start: 'it did not start on this server',
  caddy: "Godspeed's web server did not take its address",
  front: 'the web server that gives it its address did not start',
  address: 'it does not answer at its address yet',
  busy: 'it is being set up right now by another run; wait a few minutes',
};

const at = (root, p) => (root === '/' ? p : path.join(root, p));
const readText = (fs, file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const lastLine = r => String(`${r.stderr || ''}\n${r.stdout || ''}`).split('\n').map(l => l.trim()).filter(Boolean).at(-1) || `exit ${r.status}`;

export const recordPath = paths => path.join(paths.state, 'watch.json');
export const pageDir = (revision = ARCHON_REVISION) => `${PAGES_DIR}/archon-${revision}`;
export const addressOf = record => `https://${record.host}:${record.port}`;

// The page's record: { format, host, port, upstream, user, password, hash, revision, front }, or null.
export function readRecord(paths, fs = nodeFs) {
  try {
    const r = JSON.parse(fs.readFileSync(recordPath(paths), 'utf8'));
    return r && typeof r === 'object' && r.format === 1 ? r : null;
  } catch { return null; }
}

function writeRecord(paths, record, fs) {
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const file = recordPath(paths), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function makePassword(pick = randomInt) {
  let out = '';
  for (let i = 0; i < 20; i++) out += PASSWORD_LETTERS[pick(PASSWORD_LETTERS.length)];
  return out;
}

// --- the Caddy that gives Godspeed its address -------------------------------------------------------------------

// The first site name in a Caddyfile: a line "<name>[:port] {" outside the global options and snippets, with a dot in it.
export function firstSite(text) {
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:https:\/\/)?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d+)?\s*\{\s*$/i);
    if (m && m[1].includes('.')) return m[1].toLowerCase();
  }
  return null;
}

// The program and the --config file of an ExecStart= line.
function execParts(exec) {
  const words = [...String(exec).matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(m => (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]));
  const i = words.indexOf('--config');
  return { program: words[0] || null, caddyfile: i >= 0 ? words[i + 1] || null : null };
}

// Godspeed's Docker server: the running `https` service of its compose project, its certificate storage and its host.
async function dockerFront(install, { run, fs }) {
  const id = await run('docker', [...composeArgs(install), 'ps', '-q', 'https']);
  const container = String(id.stdout || '').trim().split('\n')[0];
  if (id.status !== 0 || !/^[a-f0-9]{12,64}$/.test(container)) return null;
  const inspected = await run('docker', ['inspect', container]);
  try {
    const c = JSON.parse(inspected.stdout)[0];
    const data = c.Mounts.find(m => m.Destination === '/data');
    if (!c.State.Running || !data || !['volume', 'bind'].includes(data.Type) || !c.Config.Image) return null;
    const host = readText(fs, path.join(install.root, '.env'))?.match(/^GODSPEED_HOST=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (!host || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) return null;
    return { kind: 'docker', install, host: host.toLowerCase(), image: c.Config.Image, storage: { type: data.Type, source: data.Type === 'volume' ? data.Name : data.Source }, caddyfile: DOCKER_CADDYFILE };
  } catch { return null; }
}

// -> { kind: 'own'|'caddy', unit, caddyfile, program, addonDir? } | { kind: 'docker', ... } | { kind: 'none' }
export async function findFront({ run, fs = nodeFs, root = '/', env = process.env } = {}) {
  const read = p => readText(fs, at(root, p));
  const native = front => {
    const texts = [read(front.caddyfile), ...(front.kind === 'caddy' ? [read(NOTEBOOK_SITE)] : [])];
    return texts.some(t => ADDON_IMPORT.test(t || '')) ? { ...front, addonDir: ADDON_DIR } : front;
  };
  const unit = read(`/etc/systemd/system/${OWN_UNIT}`);
  if (unit) {
    const { program, caddyfile } = execParts(unit.match(/^ExecStart=(.*)$/m)?.[1] || '');
    if (caddyfile && read(caddyfile) !== null) return native({ kind: 'own', unit: OWN_UNIT, caddyfile, program: program || 'caddy' });
  }
  if ((await run('systemctl', ['is-active', '--quiet', 'caddy'])).status === 0 && read(SERVER_CADDYFILE) !== null) {
    return native({ kind: 'caddy', unit: 'caddy.service', caddyfile: SERVER_CADDYFILE, program: 'caddy' });
  }
  const candidates = [];
  if (env.GODSPEED_DOCKER_DIR) candidates.push(env.GODSPEED_DOCKER_DIR);
  try { for (const name of fs.readdirSync(at(root, '/opt')).sort()) candidates.push(path.join(at(root, '/opt'), name)); } catch { /* no /opt */ }
  const ps = await run('docker', ['ps', '--filter', 'label=com.docker.compose.service=godspeed', '--format', '{{.Label "com.docker.compose.project.working_dir"}}']);
  if (ps.status === 0) candidates.push(...String(ps.stdout).split('\n').map(l => l.trim()).filter(Boolean));
  for (const dir of [...new Set(candidates)]) {
    const install = dockerInstallation(fs, dir);
    if (!install) continue;
    const front = await dockerFront(install, { run, fs });
    if (front) return front;
  }
  return { kind: 'none' };
}

export function serverName(front, { fs = nodeFs, root = '/' } = {}) {
  const read = p => readText(fs, at(root, p));
  if (front.kind === 'docker') return front.host;
  if (front.kind === 'own') return firstSite(read(front.caddyfile));
  if (front.kind === 'caddy') return firstSite(read(NOTEBOOK_SITE)) || firstSite(read(SERVER_CADDYFILE));
  return null;
}

// The site: the sign-in first, then only GET and HEAD, never Archon's internal and webhook paths, then Archon.
export function siteText({ host, port, upstream, user, hash }) {
  return [
    "# The page where the owner watches the factory. The Forge (godspeed-forge) writes this file and keeps it.",
    "# Archon's own pages, read-only: a visit signs in first, and only GET and HEAD reach Archon.",
    `${host}:${port} {`,
    '\tbasic_auth {',
    `\t\t${user} ${hash}`,
    '\t}',
    '\t@change not method GET HEAD',
    '\trespond @change "This page only shows the factory\'s work." 405',
    '\t@inside path /internal/* /webhooks/* /api/webhooks/*',
    '\trespond @inside 404',
    `\treverse_proxy 127.0.0.1:${upstream} {`,
    '\t\theader_up -X-Archon-User',
    '\t}',
    '}',
    '',
  ].join('\n');
}

export const dockerCaddyfile = site => `{\n\tadmin off\n\tauto_https disable_redirects\n}\n\n${site}`;

// Ports Caddy files on this server already name.
function namedPortTexts({ fs, root, front }) {
  const read = p => readText(fs, at(root, p));
  const texts = [read(SERVER_CADDYFILE), read(NOTEBOOK_SITE), read(CLERK_DOCKER_CADDYFILE)];
  if (front?.caddyfile && front.kind !== 'docker') texts.push(read(front.caddyfile));
  try {
    for (const name of fs.readdirSync(at(root, ADDON_DIR))) if (name.endsWith('.caddy') && `${ADDON_DIR}/${name}` !== SITE_FILE) texts.push(read(`${ADDON_DIR}/${name}`));
  } catch { /* no add-on folder */ }
  return texts.filter(Boolean);
}

export function freePort({ texts = [], listening = '', from, skip = [] }) {
  for (let p = from; p < from + 40; p++) {
    if (skip.includes(p)) continue;
    if (texts.some(t => new RegExp(`:${p}\\b`).test(t))) continue;
    if (new RegExp(`:${p}\\s`).test(listening)) continue;
    return p;
  }
  return null;
}

async function openPort(run, port) {
  const ufw = await run('ufw', ['status']);
  if (ufw.status === 0 && /^Status: active/m.test(ufw.stdout)) await run('ufw', ['allow', `${port}/tcp`]);
  if ((await run('firewall-cmd', ['--state'])).status === 0) {
    await run('firewall-cmd', ['--quiet', '--permanent', `--add-port=${port}/tcp`]);
    await run('firewall-cmd', ['--quiet', '--reload']);
  }
}

function writeKeep(file, text, fs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.forge-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, file);
}

// A native Godspeed's Caddy: the Forge's own file in the add-on folder, checked before Caddy takes it, and taken out
// again (Caddy restarted or reloaded once more) when the check, the restart or the reload fails. -> { ok, changed }.
async function publishNative({ front, site, run, fs, root }) {
  const file = at(root, SITE_FILE);
  const before = readText(fs, file);
  if (before === site) return { ok: true, changed: false };
  writeKeep(file, site, fs);
  const take = () => (front.kind === 'own' ? run('systemctl', ['restart', front.unit]) : run('systemctl', ['reload', 'caddy']));
  const putBack = async () => {
    if (before === null) fs.rmSync(file, { force: true }); else writeKeep(file, before, fs);
    await take();
  };
  const checked = await run(front.program, ['validate', '--config', front.caddyfile, '--adapter', 'caddyfile'], { timeoutMs: 60000 });
  if (checked.status !== 0) { await putBack(); return { ok: false, detail: lastLine(checked) }; }
  const taken = await take();
  if (taken.status !== 0) { await putBack(); return { ok: false, detail: lastLine(taken) }; }
  return { ok: true, changed: true };
}

// Godspeed's Docker server: its Caddy reads no add-on folder, so the Forge runs a Caddy container of its own on the
// host's network, sharing the certificate storage of Godspeed's (Caddy coordinates instances through shared storage),
// with no admin endpoint and no redirect port. Only the page's port listens.
async function publishDocker({ front, site, run, fs, root }) {
  const config = dockerCaddyfile(site);
  const file = at(root, front.caddyfile);
  const before = readText(fs, file);
  const inspected = await run('docker', ['inspect', CONTAINER]);
  let old = null;
  try { old = JSON.parse(inspected.stdout)[0] || null; } catch { old = null; }
  if (old && old.Config?.Labels?.[OWNER_LABEL] !== 'https') return { ok: false, detail: `a container named ${CONTAINER} belongs to something else` };
  if (old?.State?.Running && old.Config.Image === front.image && before === config) return { ok: true, changed: false };
  writeKeep(file, config, fs);
  if (old) {
    const removed = await run('docker', ['rm', '-f', CONTAINER]);
    if (removed.status !== 0) return { ok: false, detail: lastLine(removed) };
  }
  const r = await run('docker', ['run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped', '--network', 'host', '--label', `${OWNER_LABEL}=https`,
    '--mount', `type=bind,src=${path.posix.dirname(front.caddyfile)},dst=/etc/caddy,readonly`,
    '--mount', `type=${front.storage.type},src=${front.storage.source},dst=/data`, '-e', 'XDG_DATA_HOME=/data', front.image,
    'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], { timeoutMs: 300000 });
  if (r.status !== 0) return { ok: false, detail: lastLine(r) };
  return { ok: true, changed: true };
}

// --- the account, Bun and Archon's pages -------------------------------------------------------------------------

// The account the factory runs as: driver.json's server.factory_user (and its home), else root.
export function factoryAccount({ fs = nodeFs, root = '/', settingsDir = '/etc/godspeed-forge' } = {}) {
  let server = {};
  try { server = JSON.parse(fs.readFileSync(at(root, path.posix.join(settingsDir, 'driver.json')), 'utf8')).server || {}; } catch { server = {}; }
  const user = typeof server.factory_user === 'string' && /^[a-z_][a-z0-9_.-]{0,31}$/i.test(server.factory_user) ? server.factory_user : 'root';
  if (user === 'root') return { user, home: '/root' };
  const home = typeof server.factory_home === 'string' && server.factory_home.startsWith('/') ? server.factory_home : `/home/${user}`;
  return { user, home };
}

async function findBun(run, account) {
  const r = await run('bash', ['-c', 'command -v bun'], { env: { ...process.env, PATH: `${account.home}/.local/bin:${account.home}/.bun/bin:/usr/local/bin:/usr/bin:/bin` } });
  const found = r.status === 0 ? String(r.stdout).trim().split('\n')[0] : '';
  return found.startsWith('/') ? found : null;
}

// Archon at the pinned revision, its web pages built, in a folder of its own. A folder without the finished mark (a
// build that stopped half way) is built again from nothing. -> { ok, built } or { ok: false, detail }.
async function buildPages({ run, fs, root, bun, say, log }) {
  const dir = pageDir();
  const mark = `${dir}/.forge-built`;
  if (readText(fs, at(root, mark))?.trim() === ARCHON_REVISION) return { ok: true, built: false };
  say(SAY.preparing);
  fs.rmSync(at(root, dir), { recursive: true, force: true });
  fs.mkdirSync(at(root, PAGES_DIR), { recursive: true, mode: 0o755 });
  const env = { ...process.env, HOME: process.env.HOME || '/root', HUSKY: '0', PATH: `${path.posix.dirname(bun)}:/usr/local/bin:/usr/bin:/bin${process.env.PATH ? `:${process.env.PATH}` : ''}` };
  const steps = [
    ['git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', ARCHON_SOURCE, dir], {}, 15],
    ['git', ['-C', dir, 'checkout', '--quiet', '--detach', ARCHON_REVISION], {}, 5],
    [bun, ['install', '--frozen-lockfile'], { cwd: dir }, 30],
    [bun, ['run', 'build:web'], { cwd: dir }, 20],
  ];
  for (const [command, args, options, minutes] of steps) {
    const r = await run(command, args, { ...options, env, timeoutMs: minutes * 60000 });
    log(`${command} ${args.join(' ')}: exit ${r.status}\n${String(r.stdout || '').slice(-2000)}${String(r.stderr || '').slice(-2000)}`);
    if (r.status !== 0) return { ok: false, detail: lastLine(r) };
  }
  const head = await run('git', ['-C', dir, 'rev-parse', 'HEAD'], { env });
  if (String(head.stdout).trim() !== ARCHON_REVISION) return { ok: false, detail: 'the download is not the revision the Forge installs' };
  if (!fs.existsSync(at(root, `${dir}/packages/web/dist/index.html`))) return { ok: false, detail: 'the build left no pages' };
  fs.writeFileSync(at(root, mark), `${ARCHON_REVISION}\n`, { mode: 0o644 });
  return { ok: true, built: true };
}

// --- the units ---------------------------------------------------------------------------------------------------

export function pageUnit({ account, bun, dir, upstream }) {
  return [
    "# The page where the owner watches the factory: Archon's own server, read-only behind the Forge's web address",
    '# (lib/watch.mjs). It listens on this server only, starts no run (no ARCHON_TRIGGER_HOST) and may reach no other',
    '# address, so it cannot reach GitHub or an AI.',
    '[Unit]',
    "Description=The Forge: the page where the owner watches the factory",
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    ...(account.user === 'root' ? [] : [`User=${account.user}`]),
    `WorkingDirectory=${account.home}`,
    `Environment=${quote(`HOME=${account.home}`)}`,
    'Environment=HOST=127.0.0.1',
    'Environment=LANG=C.UTF-8',
    `Environment=${quote(`PATH=${account.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`)}`,
    `ExecStart=${quote(bun)} ${quote(`${dir}/packages/cli/src/cli.ts`)} serve --port ${upstream}`,
    'IPAddressDeny=any',
    'IPAddressAllow=localhost',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'Restart=always',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

export function keepUnits({ node, forge }) {
  return {
    [`${KEEP_UNIT}.service`]: [
      '[Unit]',
      "Description=The Forge: look after the page where the owner watches the factory",
      '',
      '[Service]',
      'Type=oneshot',
      'Environment=HOME=/root',
      'Environment=LANG=C.UTF-8',
      `ExecStart=${quote(node)} ${quote(forge)} watch keep`,
      'TimeoutStartSec=45min',
      '',
    ].join('\n'),
    [`${KEEP_UNIT}.timer`]: [
      '[Unit]',
      "Description=The Forge: look after the watching page every hour",
      '',
      '[Timer]',
      'OnBootSec=10min',
      'OnUnitActiveSec=1h',
      'RandomizedDelaySec=5min',
      `Unit=${KEEP_UNIT}.service`,
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n'),
  };
}

function writeUnits(units, { fs, root, unitsDir }) {
  let changed = false;
  for (const [name, text] of Object.entries(units)) {
    const file = at(root, path.posix.join(unitsDir, name));
    if (readText(fs, file) === text) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o644 });
    changed = true;
  }
  return changed;
}

// --- answers -----------------------------------------------------------------------------------------------------

// The status code of one GET on this server, or 0 when nothing answered. secure: over HTTPS with the page's name (the
// certificate is not checked here: this asks the server's own Caddy, whose certificate is Caddy's job).
export function ask({ secure = false, port, host = '127.0.0.1', pathname = '/', auth = null, timeoutMs = 10000 }) {
  return new Promise(resolve => {
    const headers = { host: secure ? `${host}:${port}` : `127.0.0.1:${port}` };
    if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
    const options = { host: '127.0.0.1', port, path: pathname, method: 'GET', headers, timeout: timeoutMs };
    if (secure) Object.assign(options, { servername: host, rejectUnauthorized: false });
    const request = (secure ? https : http).request(options, response => { response.resume(); resolve(response.statusCode || 0); });
    request.on('timeout', () => { request.destroy(); resolve(0); });
    request.on('error', () => resolve(0));
    request.end();
  });
}

async function waitFor(check, { tries, waitMs, sleep }) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return true;
    if (i < tries - 1) await sleep(waitMs);
  }
  return false;
}

// --- the whole page ----------------------------------------------------------------------------------------------

// -> { ok: true, record, built } or { ok: false, why, record? }. Never throws for anything on the server; `say` hears
// only the line that the pages are being prepared (when they are).
export async function ensureWatchPage(o = {}) {
  const run = o.run || runCommand, fs = o.fs || nodeFs, root = o.root || '/', paths = o.paths || defaultPaths();
  const say = o.say || (() => {}), sleep = o.sleep || (ms => delay(ms)), check = o.ask || ask;
  const unitsDir = o.unitsDir || '/etc/systemd/system';
  const settingsDir = o.settingsDir || process.env.FORGE_SETTINGS_DIR || '/etc/godspeed-forge';
  const logFile = path.join(paths.state, 'watch.log');
  const log = text => { try { fs.appendFileSync(logFile, `--- ${new Date().toISOString()} ${text}\n`, { mode: 0o600 }); } catch { /* the log is a help, never a stop */ } };
  const fail = (why, detail) => { if (detail) log(`stopped: ${why}: ${detail}`); return { ok: false, why }; };

  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const lockDir = path.join(paths.state, 'watch.lock');
  let release = takeInboxLock(fs, lockDir);
  for (let waited = 0; !release && o.wait !== false && waited < 45 * 60000; waited += 5000) {
    await sleep(5000);
    release = takeInboxLock(fs, lockDir);
  }
  if (!release) return { ok: false, why: WHY.busy };
  try {
    // 1. the address: Godspeed's Caddy, and the name it serves
    const front = await findFront({ run, fs, root, env: o.env || process.env });
    if (front.kind === 'none') return fail(WHY.noFront);
    if (front.kind !== 'docker' && !front.addonDir) return fail(WHY.oldGodspeed);
    const host = serverName(front, { fs, root });
    if (!host) return fail(WHY.noName);

    // 2. Bun, the sign-in and the ports, kept in the record
    const account = factoryAccount({ fs, root, settingsDir });
    const bun = await findBun(run, account);
    if (!bun) return fail(WHY.noBun);
    const saved = readRecord(paths, fs) || {};
    let { user, password, hash } = saved;
    if (user !== USER || typeof password !== 'string' || password.length < 16 || !BCRYPT.test(String(hash))) {
      user = USER;
      password = (o.makePassword || makePassword)();
      const hashed = await run(bun, ['-e', HASH_SCRIPT], { input: password, timeoutMs: 60000 });
      hash = String(hashed.stdout || '').trim();
      if (hashed.status !== 0 || !BCRYPT.test(hash)) return fail(WHY.login, lastLine(hashed));
    }
    const listening = (await run('ss', ['-ltnH'])).stdout || '';
    const port = Number.isInteger(saved.port) ? saved.port : freePort({ texts: namedPortTexts({ fs, root, front }), listening, from: FIRST_PORT, skip: [CLERK_PORT] });
    const upstream = Number.isInteger(saved.upstream) ? saved.upstream : freePort({ listening, from: FIRST_UPSTREAM });
    if (!port || !upstream) return fail(WHY.start, 'no free port');
    const record = { format: 1, host, port, upstream, user, password, hash, revision: saved.revision || null, front: front.kind };
    writeRecord(paths, record, fs);

    // 3. Archon's pages at the pinned revision
    const pages = await buildPages({ run, fs, root, bun, say, log });
    if (!pages.ok) return fail(WHY.build, pages.detail);

    // 4. the service, started again when it changed or does not run
    const dir = pageDir();
    const unitChanged = writeUnits({ [`${UNIT}.service`]: pageUnit({ account, bun, dir, upstream }) }, { fs, root, unitsDir });
    const forge = path.posix.join(paths.addon, 'bin', 'godspeed-forge.mjs');
    const keepNode = o.node || execNode(readText(fs, at(root, path.posix.join(unitsDir, `${KEEP_UNIT}.service`))), fs, root) || process.execPath;
    const keepChanged = writeUnits(keepUnits({ node: keepNode, forge }), { fs, root, unitsDir });
    if (unitChanged || keepChanged) await run('systemctl', ['daemon-reload']);
    await run('systemctl', ['enable', `${UNIT}.service`, `${KEEP_UNIT}.timer`]);
    const active = (await run('systemctl', ['is-active', '--quiet', `${UNIT}.service`])).status === 0;
    if (unitChanged || pages.built || !active || saved.revision !== ARCHON_REVISION) {
      const r = await run('systemctl', ['restart', `${UNIT}.service`]);
      if (r.status !== 0) return fail(WHY.start, lastLine(r));
    }
    if ((await run('systemctl', ['is-active', '--quiet', `${KEEP_UNIT}.timer`])).status !== 0) await run('systemctl', ['start', `${KEEP_UNIT}.timer`]);
    if (!(await waitFor(async () => (await check({ port: upstream, pathname: '/api/health' })) === 200, { tries: 60, waitMs: 2000, sleep }))) {
      return fail(WHY.start, 'Archon did not answer on this server');
    }
    record.revision = ARCHON_REVISION;
    writeRecord(paths, record, fs);

    // 5. the address, and the server's own firewall
    const site = siteText({ host, port, upstream, user, hash });
    const published = front.kind === 'docker' ? await publishDocker({ front, site, run, fs, root }) : await publishNative({ front, site, run, fs, root });
    if (!published.ok) return fail(front.kind === 'docker' ? WHY.front : WHY.caddy, published.detail);
    await openPort(run, port);
    const answers = await waitFor(async () => (await check({ secure: true, port, host, pathname: '/api/health' })) === 401
      && (await check({ secure: true, port, host, pathname: '/api/health', auth: `${user}:${password}` })) === 200, { tries: 30, waitMs: 3000, sleep });
    if (!answers) return fail(WHY.address, 'the address did not answer 401 without the sign-in and 200 with it');

    // 6. older builds go once this one answers
    try {
      for (const name of fs.readdirSync(at(root, PAGES_DIR))) {
        if (name.startsWith('archon-') && name !== path.posix.basename(dir)) fs.rmSync(at(root, `${PAGES_DIR}/${name}`), { recursive: true, force: true });
      }
    } catch { /* nothing to tidy */ }
    return { ok: true, record, built: pages.built };
  } catch (error) {
    return fail(WHY.start, String(error?.message || error));
  } finally {
    release();
  }
}

// The Node an existing keep unit runs with, while that file is still there.
function execNode(unitText, fs, root) {
  const exec = String(unitText || '').match(/^ExecStart=(.*)$/m)?.[1];
  if (!exec) return null;
  const node = execParts(exec).program;
  return node && fs.existsSync(at(root, node)) ? node : null;
}

// Whether this process may set up the page: root on Linux with systemd.
export const canHost = ({ platform = process.platform, uid = process.getuid?.(), systemd = () => nodeFs.existsSync('/run/systemd/system') } = {}) => platform === 'linux' && uid === 0 && systemd();

// The lines setup ends with (also on a repository already set up), and what `godspeed-forge watch` prints: the address
// and the sign-in, or the one sentence that says why the page could not be set up. Nothing where this process may not set
// it up. -> { ok, lines }.
export async function watchLines(o = {}) {
  if (!canHost(o)) return { ok: false, lines: [] };
  const r = await (o.ensure || ensureWatchPage)(o);
  if (!r.ok) return { ok: false, lines: [SAY.failed(r.why, SAY.againWatch)] };
  return { ok: true, lines: [SAY.login({ address: addressOf(r.record), user: r.record.user, password: r.record.password }), SAY.firewall(r.record.port)] };
}

export const NOT_HERE = "The page where you watch the factory is set up on the Linux server the factory runs on, by root. Type godspeed-forge watch in that server's terminal, logged in as root.";

// `godspeed-forge watch`: sets the page up or brings it up to date, then prints the address and the sign-in.
// `godspeed-forge watch keep`: the hourly timer's run; it prints the address only, never the password, and a page another
// run is setting up right now is no failure. -> the exit code.
export async function runWatchCommand(args = [], o = {}) {
  const output = o.output || (line => console.log(line));
  if (!canHost(o)) { output(NOT_HERE); return 1; }
  if (args[0] === 'keep') {
    const r = await (o.ensure || ensureWatchPage)({ ...o, wait: false, say: output });
    if (r.ok) output(`The page where you watch the factory answers at ${addressOf(r.record)}.`);
    else output(SAY.failed(r.why, SAY.againWatch));
    return r.ok || r.why === WHY.busy ? 0 : 1;
  }
  const { ok, lines } = await watchLines({ ...o, say: output });
  for (const line of lines) output(line);
  return ok ? 0 : 1;
}
