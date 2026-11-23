// The page where the owner watches the factory: Archon's own web pages, showing every project, every run (lap) and
// each step of a run, behind a web address of its own and a sign-in, and unable to start or change anything.
//
// What ensureWatchPage puts on a server (root, Linux, systemd), each step looking for its own result first, so running
// it again changes only what is missing or out of date:
//   1. a copy of the Archon the factory runs on this server (factoryArchon: the copy and revision its projects' factory
//      settings name, when the Forge vouches for it; else the Forge's pin in lib/constants.mjs, the one setup installs),
//      built once for its web pages in /opt/godspeed-forge/watch/archon-<revision>, which the factory's account can
//      read, apart from the copy the factory checks, which stays untouched; a new revision is built beside the old
//      one, which goes once the new one answers, and runs again when the new one does not;
//   2. the sign-in: the user name "forge" and a password made on this server, kept with the page's record in the
//      Forge's private state (watch.json, 0600); Caddy holds only its bcrypt hash;
//   3. the service godspeed-forge-watch: Archon's server as the account the factory runs as (driver.json's
//      server.factory_user, root on a server the Forge set up), listening on 127.0.0.1 only, and unable to change
//      anything: Archon's server also resumes runs that wait (a run stopped by an AI's usage limit, a waiting step)
//      and tidies old work folders, so systemd makes every file read-only to it (the factory's database too, so its
//      connection is read-only) but the database's two side files SQLite needs for reading, and lets it reach no
//      address but this server's own. It has no ARCHON_TRIGGER_HOST. What its server would need to write first (the
//      database on a server the factory has not used yet, Archon's local key, the side files) lib/watch-prepare.mjs
//      makes before each start, as the factory's account, with Archon's own code;
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
import { usesDatabaseServer } from './watch-prepare.mjs';

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
  databaseServer: 'the factory keeps its records in a database server, which the page could change, so it is not set up',
};

const at = (root, p) => (root === '/' ? p : path.join(root, p));
class SystemdRefused extends Error {}
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
    '\t\theader_up -Authorization',
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
// with no admin endpoint and no redirect port. Only the page's port listens. (The official Caddy image has no
// entrypoint; its command is the `caddy run` given here.) A new container that does not start, or stops at once, gives
// way to the one before, with the configuration it had, so an update never takes the address away.
async function publishDocker({ front, site, run, fs, root, sleep }) {
  const config = dockerCaddyfile(site);
  const file = at(root, front.caddyfile);
  const before = readText(fs, file);
  const inspect = async () => { try { return JSON.parse((await run('docker', ['inspect', CONTAINER])).stdout)[0] || null; } catch { return null; } };
  const old = await inspect();
  if (old && old.Config?.Labels?.[OWNER_LABEL] !== 'https') return { ok: false, detail: `a container named ${CONTAINER} belongs to something else` };
  if (old?.State?.Running && old.Config.Image === front.image && before === config) return { ok: true, changed: false };
  const start = image => run('docker', ['run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped', '--network', 'host', '--label', `${OWNER_LABEL}=https`,
    '--mount', `type=bind,src=${path.posix.dirname(front.caddyfile)},dst=/etc/caddy,readonly`,
    '--mount', `type=${front.storage.type},src=${front.storage.source},dst=/data`, '-e', 'XDG_DATA_HOME=/data', image,
    'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], { timeoutMs: 300000 });
  writeKeep(file, config, fs);
  if (old) {
    const removed = await run('docker', ['rm', '-f', CONTAINER]);
    if (removed.status !== 0) { if (before === null) fs.rmSync(file, { force: true }); else writeKeep(file, before, fs); return { ok: false, detail: lastLine(removed) }; }
  }
  const r = await start(front.image);
  if (r.status === 0) {
    await sleep(3000);
    const started = await inspect();
    if (started?.State?.Running && !started.State.Restarting) return { ok: true, changed: true };
  }
  // the one before runs again
  await run('docker', ['rm', '-f', CONTAINER]);
  if (before === null) fs.rmSync(file, { force: true }); else writeKeep(file, before, fs);
  if (old?.Config?.Image && before !== null) await start(old.Config.Image);
  return { ok: false, detail: r.status !== 0 ? lastLine(r) : 'the new container stopped at once' };
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

const REVISION = /^[0-9a-f]{40}$/;
const SOURCE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const readJson = (fs, file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// The Archon versions the Forge itself vouches for, and so the only ones it builds as root: its own pin
// (lib/constants.mjs) and the pin of the factory download setup keeps in the Forge's root-only state (Cole Medin's
// installer at FACTORY_REVISION names it in template/factory/pack.json). A project's own settings never add one.
export function trustedArchons({ fs = nodeFs, state } = {}) {
  const pins = [{ source: ARCHON_SOURCE, revision: ARCHON_REVISION }];
  const pack = state ? readJson(fs, path.join(state, 'factory', 'template', 'factory', 'pack.json')) : null;
  const source = String(pack?.repository || '').replace(/\.git$/, '');
  if (SOURCE.test(source) && REVISION.test(String(pack?.integration_revision_required))) pins.push({ source, revision: pack.integration_revision_required });
  return pins;
}

// The Archon the factory runs on this server: the source and revision every project's factory settings
// (<checkout>/.factory/consumer.json, which Cole Medin's installer writes) name, for the projects the driver's settings
// and the Forge's setup records know, when that is one the Forge vouches for (trustedArchons). The page shows the
// factory's database, so it runs exactly that Archon. On a server with no project yet, with projects on different ones
// while they move to a new pin, or with settings naming one the Forge does not vouch for, it is the Forge's pin
// (lib/constants.mjs). -> { source, revision }.
export function factoryArchon({ fs = nodeFs, root = '/', settingsDir = '/etc/godspeed-forge', state }) {
  const trusted = trustedArchons({ fs, state });
  const checkouts = new Set();
  const list = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
  const projects = at(root, path.posix.join(settingsDir, 'projects'));
  for (const name of list(projects)) if (name.endsWith('.json')) checkouts.add(readJson(fs, path.join(projects, name))?.checkout);
  if (state) {
    for (const owner of list(path.join(state, 'projects'))) {
      for (const repo of list(path.join(state, 'projects', owner))) {
        const r = readJson(fs, path.join(state, 'projects', owner, repo, 'registration.json'));
        if (r?.completed === true) checkouts.add(r.checkout);
      }
    }
  }
  const found = new Map();
  for (const checkout of checkouts) {
    if (typeof checkout !== 'string' || !checkout.startsWith('/')) continue;
    const s = readJson(fs, at(root, path.posix.join(checkout, '.factory', 'consumer.json')));
    const source = String(s?.repository || '').replace(/\.git$/, '');
    const pin = trusted.find(p => p.source.toLowerCase() === source.toLowerCase() && p.revision === s?.revision);
    found.set(pin ? `${pin.source}@${pin.revision}` : 'untrusted', pin || null);
  }
  found.delete('untrusted');
  return found.size === 1 ? [...found.values()][0] : { source: ARCHON_SOURCE, revision: ARCHON_REVISION };
}

// That Archon, its web pages built, in a folder of its own. A folder without the finished mark (a build that stopped
// half way) is built again from nothing. -> { ok, built } or { ok: false, detail }.
async function buildPages({ run, fs, root, bun, say, log, archon }) {
  const dir = pageDir(archon.revision);
  const mark = `${dir}/.forge-built`;
  if (readText(fs, at(root, mark))?.trim() === archon.revision) return { ok: true, built: false };
  say(SAY.preparing);
  fs.rmSync(at(root, dir), { recursive: true, force: true });
  fs.mkdirSync(at(root, PAGES_DIR), { recursive: true, mode: 0o755 });
  const env = { ...process.env, HOME: process.env.HOME || '/root', HUSKY: '0', PATH: `${path.posix.dirname(bun)}:/usr/local/bin:/usr/bin:/bin${process.env.PATH ? `:${process.env.PATH}` : ''}` };
  const steps = [
    ['git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', archon.source, dir], {}, 15],
    ['git', ['-C', dir, 'checkout', '--quiet', '--detach', archon.revision], {}, 5],
    [bun, ['install', '--frozen-lockfile'], { cwd: dir }, 30],
    [bun, ['run', 'build:web'], { cwd: dir }, 20],
  ];
  for (const [command, args, options, minutes] of steps) {
    const r = await run(command, args, { ...options, env, timeoutMs: minutes * 60000 });
    log(`${command} ${args.join(' ')}: exit ${r.status}\n${String(r.stdout || '').slice(-2000)}${String(r.stderr || '').slice(-2000)}`);
    if (r.status !== 0) return { ok: false, detail: lastLine(r) };
  }
  const head = await run('git', ['-C', dir, 'rev-parse', 'HEAD'], { env });
  if (String(head.stdout).trim() !== archon.revision) return { ok: false, detail: 'the download is not the revision the factory runs' };
  if (!fs.existsSync(at(root, `${dir}/packages/web/dist/index.html`))) return { ok: false, detail: 'the build left no pages' };
  // Root built it; the factory's account runs it, also where root's umask keeps new files to itself.
  const readable = await run('chmod', ['-R', 'a+rX', dir], { timeoutMs: 10 * 60000 });
  if (readable.status !== 0) return { ok: false, detail: lastLine(readable) };
  fs.writeFileSync(at(root, mark), `${archon.revision}\n`, { mode: 0o644 });
  return { ok: true, built: true };
}

// --- the units ---------------------------------------------------------------------------------------------------

// prepare: the Forge's lib/watch-prepare.mjs; runuser: where runuser is on this server.
export function pageUnit({ account, bun, dir, upstream, prepare, runuser = '/usr/sbin/runuser' }) {
  const asAccount = account.user === 'root' ? '' : `${quote(runuser)} -m -u ${account.user} -- `;
  const database = `${account.home}/.archon/archon.db`;
  return [
    "# The page where the owner watches the factory: Archon's own server behind the Forge's web address (lib/watch.mjs).",
    '# It can change nothing. Every file on this server is read-only to it but the two side files of the factory\'s',
    '# database, which SQLite needs for reading (the database itself is read-only, so its connection is too); it may',
    '# reach no address but this server\'s own, so neither GitHub nor an AI; and it starts no run (no ARCHON_TRIGGER_HOST).',
    '# Archon\'s own background work (resuming a run that waits, tidying old work folders) fails at its first write.',
    '# Before each start, lib/watch-prepare.mjs makes what is missing, as the factory\'s account, with Archon\'s own code.',
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
    `ExecStartPre=+${asAccount}${quote(bun)} ${quote(prepare)} ${quote(dir)}`,
    `ExecStart=${quote(bun)} ${quote(`${dir}/packages/cli/src/cli.ts`)} serve --port ${upstream}`,
    'ProtectSystem=strict',
    'ProtectHome=read-only',
    `ReadWritePaths=${quote(`-${database}-wal`)} ${quote(`-${database}-shm`)}`,
    'PrivateTmp=true',
    'IPAddressDeny=any',
    'IPAddressAllow=localhost',
    'NoNewPrivileges=true',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'RestrictNamespaces=true',
    'SystemCallFilter=~@mount',
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

  let release = null;
  try {
    fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    const lockDir = path.join(paths.state, 'watch.lock');
    release = takeInboxLock(fs, lockDir);
    for (let waited = 0; !release && o.wait !== false && waited < 45 * 60000; waited += 5000) {
      await sleep(5000);
      release = takeInboxLock(fs, lockDir);
    }
    if (!release) return { ok: false, why: WHY.busy };

    // 1. the address: Godspeed's Caddy, and the name it serves
    const front = await findFront({ run, fs, root, env: o.env || process.env });
    if (front.kind === 'none') return fail(WHY.noFront);
    if (front.kind !== 'docker' && !front.addonDir) return fail(WHY.oldGodspeed);
    const host = serverName(front, { fs, root });
    if (!host) return fail(WHY.noName);

    // 2. Bun, the sign-in and the ports, kept in the record
    const account = factoryAccount({ fs, root, settingsDir });
    // Only a database file can be made read-only to the page; Archon on a database server it would reach and change.
    if (usesDatabaseServer(readText(fs, at(root, `${account.home}/.archon/.env`)))) return fail(WHY.databaseServer);
    const bun = await findBun(run, account);
    if (!bun) return fail(WHY.noBun);
    // The preparation before each start runs as the factory's account; root needs no runuser.
    const found = account.user === 'root' ? null : (await run('bash', ['-c', 'command -v runuser'], { env: { ...process.env, PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } }));
    const runuser = found ? String(found.stdout || '').trim().split('\n')[0] : null;
    if (found && !runuser?.startsWith('/')) return fail(WHY.start, 'runuser is not on this server');
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
    const record = { format: 1, host, port, upstream, user, password, hash, source: saved.source || null, revision: saved.revision || null, front: front.kind };
    if (saved.failedRevision) record.failedRevision = saved.failedRevision;
    writeRecord(paths, record, fs);
    const built = revision => typeof revision === 'string' && fs.existsSync(at(root, `${pageDir(revision)}/.forge-built`));
    const previous = SOURCE.test(String(saved.source)) && REVISION.test(String(saved.revision)) && built(saved.revision) ? { source: saved.source, revision: saved.revision } : null;

    // 3. the Archon the factory runs, its pages built. The hourly check does not try again a version that did not
    // answer; the install line, setup and godspeed-forge watch do.
    let archon = factoryArchon({ fs, root, settingsDir, state: paths.state });
    if (o.wait === false && previous && saved.failedRevision === archon.revision) archon = previous;
    const pages = await buildPages({ run, fs, root, bun, say, log, archon });
    if (!pages.ok) return fail(WHY.build, pages.detail);

    // 4. the service, started again when it changed or does not run. A new version that does not answer gives way to
    // the one before, which runs again, so an update never takes the page away.
    const prepare = path.posix.join(paths.addon, 'lib', 'watch-prepare.mjs');
    const unitFor = revision => pageUnit({ account, bun, dir: pageDir(revision), upstream, prepare, runuser });
    const systemctl = async args => { const r = await run('systemctl', args); if (r.status !== 0) throw new SystemdRefused(lastLine(r)); };
    const answering = () => waitFor(async () => (await check({ port: upstream, pathname: '/api/health' })) === 200, { tries: 60, waitMs: 2000, sleep });
    const unitChanged = writeUnits({ [`${UNIT}.service`]: unitFor(archon.revision) }, { fs, root, unitsDir });
    const forge = path.posix.join(paths.addon, 'bin', 'godspeed-forge.mjs');
    const keepNode = o.node || execNode(readText(fs, at(root, path.posix.join(unitsDir, `${KEEP_UNIT}.service`))), fs, root) || process.execPath;
    const keepChanged = writeUnits(keepUnits({ node: keepNode, forge }), { fs, root, unitsDir });
    try {
      if (unitChanged || keepChanged) await systemctl(['daemon-reload']);
      await systemctl(['enable', `${UNIT}.service`, `${KEEP_UNIT}.timer`]);
      const active = (await run('systemctl', ['is-active', '--quiet', `${UNIT}.service`])).status === 0;
      if (unitChanged || pages.built || !active || saved.revision !== archon.revision) {
        const restarted = await run('systemctl', ['restart', `${UNIT}.service`]);
        if (restarted.status !== 0 || !(await answering())) {
          const why = restarted.status !== 0 ? lastLine(restarted) : 'Archon did not answer on this server';
          if (!previous || previous.revision === archon.revision) return fail(WHY.start, why);
          log(`the page on ${archon.revision} did not answer (${why}); it runs again on ${previous.revision}`);
          writeUnits({ [`${UNIT}.service`]: unitFor(previous.revision) }, { fs, root, unitsDir });
          await systemctl(['daemon-reload']);
          await systemctl(['restart', `${UNIT}.service`]);
          if (!(await answering())) return fail(WHY.start, `neither ${archon.revision} nor ${previous.revision} answered`);
          record.failedRevision = archon.revision;
          archon = previous;
        }
      } else if (!(await answering())) return fail(WHY.start, 'Archon did not answer on this server');
      if ((await run('systemctl', ['is-active', '--quiet', `${KEEP_UNIT}.timer`])).status !== 0) await systemctl(['start', `${KEEP_UNIT}.timer`]);
    } catch (error) {
      if (error instanceof SystemdRefused) return fail(WHY.start, `systemd: ${error.message}`);
      throw error;
    }
    if (record.failedRevision === archon.revision) delete record.failedRevision;
    Object.assign(record, { source: archon.source, revision: archon.revision });
    writeRecord(paths, record, fs);
    const dir = pageDir(archon.revision);

    // 5. the address, and the server's own firewall
    const site = siteText({ host, port, upstream, user, hash });
    const published = front.kind === 'docker' ? await publishDocker({ front, site, run, fs, root, sleep }) : await publishNative({ front, site, run, fs, root });
    if (!published.ok) return fail(front.kind === 'docker' ? WHY.front : WHY.caddy, published.detail);
    await openPort(run, port);
    const answers = await waitFor(async () => (await check({ secure: true, port, host, pathname: '/api/health' })) === 401
      && (await check({ secure: true, port, host, pathname: '/api/health', auth: `${user}:${password}` })) === 200, { tries: 30, waitMs: 3000, sleep });
    if (!answers) return fail(WHY.address, 'the address did not answer 401 without the sign-in and 200 with it');

    // 6. older builds go once this one answers; a newer one that did not answer stays for the next try
    const keep = new Set([dir, record.failedRevision ? pageDir(record.failedRevision) : dir].map(d => path.posix.basename(d)));
    try {
      for (const name of fs.readdirSync(at(root, PAGES_DIR))) {
        if (name.startsWith('archon-') && !keep.has(name)) fs.rmSync(at(root, `${PAGES_DIR}/${name}`), { recursive: true, force: true });
      }
    } catch { /* nothing to tidy */ }
    return { ok: true, record, built: pages.built };
  } catch (error) {
    return fail(WHY.start, String(error?.message || error));
  } finally {
    release?.();
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
  let r;
  try { r = await (o.ensure || ensureWatchPage)(o); } catch { r = { ok: false, why: WHY.start }; }
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
    let r;
    try { r = await (o.ensure || ensureWatchPage)({ ...o, wait: false, say: output }); } catch { r = { ok: false, why: WHY.start }; }
    if (r.ok) output(`The page where you watch the factory answers at ${addressOf(r.record)}.`);
    else output(SAY.failed(r.why, SAY.againWatch));
    return r.ok || r.why === WHY.busy ? 0 : 1;
  }
  const { ok, lines } = await watchLines({ ...o, say: output });
  for (const line of lines) output(line);
  return ok ? 0 : 1;
}
