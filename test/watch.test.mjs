// The page where the owner watches the factory (lib/watch.mjs), its chat answer (lib/owner/watch.mjs) and the lines
// setup ends with. The server is a stand-in: a folder of the test's own is its file system, and systemctl, docker, git,
// bun, caddy and the page's answers are stand-ins, so nothing is installed and nothing reaches the network.
// test cases: 26
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testCase } from './cases.mjs';
import { assertPlain } from './forge-owner-fakes.mjs';
import { ARCHON_REVISION, ARCHON_SOURCE } from '../lib/constants.mjs';
import {
  ADDON_DIR, CONTAINER, DOCKER_CADDYFILE, FORGE_CADDYFILE, FORGE_UNIT, KEEP_UNIT, NOT_HERE, PAGES_DIR, SAY, SITE_FILE, UNIT, USER, WHY,
  dockerCaddyfile, ensureWatchPage, factoryArchon, pageDir, readRecord, runWatchCommand, siteText, watchLines
} from '../lib/watch.mjs';
import { SAY as CHAT, watch as chatWatch } from '../lib/owner/watch.mjs';
import { prepare, SIDE_FILES, usesDatabaseServer } from '../lib/watch-prepare.mjs';

const tmp = await mkdtemp(path.join(tmpdir(), 'forge-watch-'));
let n = 0;
const fresh = () => { const d = path.join(tmp, `t${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
const at = (root, p) => path.join(root, p);
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const HASH = `$2b$12$${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0'}`;
const DIR = pageDir();
const posix = process.platform !== 'win32';

// Godspeed's Docker server as its one-line installer leaves it, under `root`.
function dockerGodspeed(root, host = 'srv1.example.com') {
  const dir = at(root, '/opt/godspeed-mission-control');
  write(path.join(dir, 'compose.yaml'), 'services: {}\n');
  write(path.join(dir, '.godspeed', 'model-host.json'), JSON.stringify({ format: 1, kind: 'godspeed-docker', service: 'godspeed', workspace: '/opt/data/full-candidate/workspace' }));
  write(path.join(dir, '.env'), `GODSPEED_HOST=${host}\nGODSPEED_SETUP_CODE=secret\n`);
}

// A native Godspeed with its own Caddy, whose Caddyfile reads the add-on folder (or does not, when `addons` is false).
function nativeGodspeed(root, { host = 'srv2.example.org', addons = true } = {}) {
  write(at(root, '/etc/systemd/system/godspeed-https.service'), '[Service]\nExecStart="/usr/local/bin/caddy" run --config "/home/me/.local/state/godspeed/https/Caddyfile" --adapter caddyfile\n');
  write(at(root, '/home/me/.local/state/godspeed/https/Caddyfile'), `{\n\tadmin off\n}\n\n${host} {\n\treverse_proxy 127.0.0.1:47833\n}\n\n${addons ? `import ${ADDON_DIR}/*.caddy\n` : ''}`);
  if (addons) fs.mkdirSync(at(root, ADDON_DIR), { recursive: true });
}

// The stand-in server's commands and the page's answers.
function server(root, { tailnet = null, hostname = null, addresses = '', caddyInstalled = true, apt = true, restartFails = false, listening = '', validateFails = false, buildFails = false, answersOutside = true, active = [], refuse = null, badRevision = null } = {}) {
  const calls = [];
  // frontImage: the image Godspeed's own Caddy runs; an image in brokenImages does not start, one in stoppingImages stops at once.
  const state = { caddy: caddyInstalled, active: new Set(active), container: null, restarts: 0, runs: 0, frontImage: 'caddy:2.10.2-alpine', brokenImages: new Set(), stoppingImages: new Set() };
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const run = async (command, args = [], options = {}) => {
    calls.push({ command, args, options });
    if (command === 'tailscale') return tailnet ? ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${tailnet}.` } })) : { status: 127, stdout: '', stderr: 'not found' };
    if (command === 'hostname') return hostname ? ok(`${hostname}\n`) : ok('localhost\n');
    if (command === 'ip') return ok(addresses);
    if (command === 'getent') return ok(args[1] === 'host.example.net' ? '203.0.113.7 STREAM host.example.net\n' : args[1] === 'elsewhere.example.net' ? '198.51.100.9 STREAM elsewhere.example.net\n' : '');
    if (command === 'bash' && args[1] === 'command -v caddy') return state.caddy ? ok('/usr/bin/caddy\n') : { status: 1, stdout: '', stderr: '' };
    if (command === 'bash' && args[1] === 'command -v apt-get') return apt ? ok('/usr/bin/apt-get\n') : { status: 1, stdout: '', stderr: '' };
    if (command === 'bash' && args[1].includes('apt-get -o DPkg::Lock::Timeout=600 install -y -qq caddy')) { state.caddy = true; return ok(); }
    if (command === 'systemctl') {
      const [verb, ...rest] = args;
      if (verb === 'restart' && restartFails && rest[0] === FORGE_UNIT) return { status: 1, stdout: '', stderr: 'Job for godspeed-forge-https.service failed' };
      if (verb === refuse) return { status: 1, stdout: '', stderr: 'Failed to enable unit: Access denied' };
      if (verb === 'is-active') return state.active.has(rest.at(-1)) ? ok() : { status: 3, stdout: '', stderr: '' };
      if (verb === 'restart' || verb === 'start') { state.active.add(rest[0]); if (rest[0] === `${UNIT}.service`) state.restarts++; }
      return ok();
    }
    if (command === 'docker') {
      if (args[0] === 'ps') return ok('');
      if (args[0] === 'compose') return ok('abc123def4567890\n');
      if (args[0] === 'inspect' && args[1] === 'abc123def4567890') {
        return ok(JSON.stringify([{ State: { Running: true }, Config: { Image: state.frontImage }, Mounts: [{ Destination: '/data', Type: 'volume', Name: 'gm_godspeed-certificates' }] }]));
      }
      if (args[0] === 'inspect') return state.container ? ok(JSON.stringify([state.container])) : { status: 1, stdout: '[]', stderr: 'Error: No such object' };
      if (args[0] === 'rm') { state.container = null; return ok(); }
      if (args[0] === 'run') {
        state.runs++;
        const image = args[args.indexOf('XDG_DATA_HOME=/data') + 1];
        if (state.brokenImages.has(image)) return { status: 125, stdout: '', stderr: `docker: Error response from daemon: pull access denied for ${image}` };
        const label = args[args.indexOf('--label') + 1].split('=');
        state.container = { State: { Running: !state.stoppingImages.has(image) }, Config: { Image: image, Labels: { [label[0]]: label[1] } } };
        state.containerConfig = read(at(root, DOCKER_CADDYFILE));
        return ok('f00d\n');
      }
    }
    if (command === 'bash' && args[1] === 'command -v bun') return ok('/usr/local/bin/bun\n');
    if (command === 'bash' && args[1] === 'command -v runuser') return ok('/usr/sbin/runuser\n');
    if (command === '/usr/local/bin/bun' && args[0] === '-e') return ok(HASH);
    if (command === 'git' && args[0] === 'clone') { fs.mkdirSync(at(root, `${args.at(-1)}/.git`), { recursive: true }); return ok(); }
    if (command === 'git' && args.includes('checkout')) { state.head = args.at(-1); return ok(); }
    if (command === 'git' && args.includes('rev-parse')) return ok(`${state.head}\n`);
    if (command === 'git') return ok();
    if (command === '/usr/local/bin/bun' && args[0] === 'install') return ok();
    if (command === '/usr/local/bin/bun' && args[1] === 'build:web') {
      if (buildFails) return { status: 1, stdout: '', stderr: 'error: vite build failed' };
      write(at(root, `${options.cwd}/packages/web/dist/index.html`), '<html></html>');
      return ok();
    }
    if (command === 'chmod') return ok();
    if (command === 'ss') return ok(listening);
    if (command === '/usr/local/bin/caddy' || command === '/usr/bin/caddy') return validateFails ? { status: 1, stdout: '', stderr: 'Error: adapting config: unrecognized directive: basic_auth' } : ok();
    return { status: 127, stdout: '', stderr: 'not found' };
  };
  // The page's answers: Archon on this server while its service runs; over HTTPS, while a site is published, the request
  // for the sign-in. Every question is kept, to show none carries the password.
  const asked = [];
  const ask = async question => {
    asked.push(question);
    if (!question.secure) return state.active.has(`${UNIT}.service`) && !(badRevision && read(at(root, `/etc/systemd/system/${UNIT}.service`)).includes(badRevision)) ? 200 : 0;
    if (!answersOutside) return 0;
    return state.container || read(at(root, SITE_FILE)) || (state.active.has(FORGE_UNIT) && read(at(root, FORGE_CADDYFILE))) ? 401 : 0;
  };
  return { run, ask, calls, state, asked };
}

function page(root, s, more = {}) {
  const said = [];
  const paths = { state: path.join(root, 'state'), addon: '/usr/local/lib/godspeed-forge' };
  return { said, paths, go: () => ensureWatchPage({ root, run: s.run, ask: s.ask, fs, paths, env: {}, sleep: async () => {}, say: l => said.push(l), node: '/usr/bin/node', settingsDir: '/etc/godspeed-forge', ...more }) };
}
const commandLines = s => s.calls.map(c => [c.command, ...c.args].join(' '));

testCase("on Godspeed's Docker server the page is built from the pinned Archon, signed in, read-only and at its own address");
{
  const root = fresh();
  dockerGodspeed(root);
  const s = server(root, { listening: 'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\n' });
  const p = page(root, s);
  const r = await p.go();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.built, true);
  assert.deepEqual(p.said, [SAY.preparing]);
  const record = readRecord(p.paths, fs);
  assert.deepEqual({ ...record, password: '-' }, { format: 1, host: 'srv1.example.com', port: 48445, upstream: 3190, user: USER, password: '-', hash: HASH, source: ARCHON_SOURCE, revision: ARCHON_REVISION, front: 'docker' });
  assert.match(record.password, /^[A-HJ-NP-Za-km-z2-9]{20}$/);
  if (posix) assert.equal(fs.statSync(path.join(p.paths.state, 'watch.json')).mode & 0o777, 0o600);
  const lines = commandLines(s);
  assert.ok(lines.includes(`git clone --quiet --no-checkout --no-hardlinks ${ARCHON_SOURCE} ${DIR}`), 'Archon from the copy the Forge installs');
  assert.ok(lines.includes(`git -C ${DIR} checkout --quiet --detach ${ARCHON_REVISION}`), 'at the revision the Forge installs');
  assert.ok(lines.includes('/usr/local/bin/bun install --frozen-lockfile') && lines.includes('/usr/local/bin/bun run build:web'));
  assert.ok(lines.includes(`chmod -R a+rX ${DIR}`), "the build is readable for the factory's account");
  assert.equal(read(at(root, `${DIR}/.forge-built`)), `${ARCHON_REVISION}\n`);
  const unit = read(at(root, `/etc/systemd/system/${UNIT}.service`));
  for (const line of ['Environment=HOST=127.0.0.1', 'IPAddressDeny=any', 'IPAddressAllow=localhost', 'Restart=always', 'WantedBy=multi-user.target', 'Environment="HOME=/root"', 'WorkingDirectory=/root',
    'ProtectSystem=strict', 'ProtectHome=read-only', 'CapabilityBoundingSet=', 'AmbientCapabilities=', 'RestrictNamespaces=true', 'SystemCallFilter=~@mount', 'ReadWritePaths="-/root/.archon/archon.db-wal" "-/root/.archon/archon.db-shm"',
    `ExecStartPre=+"/usr/local/bin/bun" "/usr/local/lib/godspeed-forge/lib/watch-prepare.mjs" "${DIR}"`,
    `ExecStart="/usr/local/bin/bun" "${DIR}/packages/cli/src/cli.ts" serve --port 3190`]) assert.ok(unit.includes(`${line}\n`), line);
  assert.equal((unit.match(/^ReadWritePaths=/gm) || []).length, 1, 'the side files are the only files it may write; the database itself stays read-only');
  assert.ok(!/^User=/m.test(unit), 'on a server the Forge set up, the factory and its page run as root');
  assert.ok(!/^Environment=.*ARCHON_TRIGGER_HOST/m.test(unit), 'the page starts no run of its own');
  const run = s.calls.find(c => c.command === 'docker' && c.args[0] === 'run').args;
  for (const want of ['--network', 'host', '--restart', 'unless-stopped', `--name`, CONTAINER, 'org.godspeed.forge.role=https', 'type=bind,src=/opt/godspeed-forge/https,dst=/etc/caddy,readonly',
    'type=volume,src=gm_godspeed-certificates,dst=/data', 'caddy:2.10.2-alpine']) assert.ok(run.includes(want), want);
  const caddyfile = read(at(root, DOCKER_CADDYFILE));
  assert.equal(caddyfile, dockerCaddyfile(siteText({ host: 'srv1.example.com', port: 48445, upstream: 3190, user: USER, hash: HASH })));
  assert.ok(caddyfile.includes(HASH) && !caddyfile.includes(record.password), 'Caddy holds the hash, never the password');
  const hashing = s.calls.find(c => c.args[0] === '-e');
  assert.equal(hashing.options.input, record.password, 'the password reaches the hash on standard input');
  for (const c of s.calls.filter(c => c !== hashing)) assert.ok(!JSON.stringify(c).includes(record.password), 'no other command sees the password');
  assert.ok(!String(read(path.join(p.paths.state, 'watch.log'))).includes(record.password), 'the log never holds the password');
  assert.ok(s.asked.some(q => q.secure && q.port === 48445 && q.host === 'srv1.example.com') && s.asked.some(q => !q.secure && q.port === 3190), 'the address and Archon behind it were both asked');
  for (const q of s.asked) assert.ok(!('auth' in q) && !JSON.stringify(q).includes(record.password), 'no check sends the sign-in, whatever answers on the port');
  const keep = read(at(root, `/etc/systemd/system/${KEEP_UNIT}.timer`));
  assert.ok(keep.includes('OnUnitActiveSec=1h\n') && read(at(root, `/etc/systemd/system/${KEEP_UNIT}.service`)).includes('ExecStart="/usr/bin/node" "/usr/local/lib/godspeed-forge/bin/godspeed-forge.mjs" watch keep\n'));
  assert.ok(lines.includes(`systemctl enable ${UNIT}.service ${KEEP_UNIT}.timer`));
}

testCase('running it again keeps the sign-in and changes nothing that works');
{
  const root = fresh();
  dockerGodspeed(root);
  const s = server(root);
  const first = page(root, s);
  await first.go();
  const before = readRecord(first.paths, fs);
  const calls = s.calls.length, restarts = s.state.restarts, runs = s.state.runs;
  const again = page(root, s);
  const r = await again.go();
  assert.equal(r.ok, true);
  assert.equal(r.built, false);
  assert.deepEqual(again.said, [], 'nothing to prepare, nothing said');
  assert.deepEqual(readRecord(again.paths, fs), before, 'the same address and the same sign-in');
  const later = commandLines({ calls: s.calls.slice(calls) });
  assert.ok(!later.some(l => l.startsWith('git clone') || l.includes('build:web') || l.startsWith('/usr/local/bin/bun -e')), later.join('\n'));
  assert.equal(s.state.restarts, restarts, 'a page that runs is not restarted');
  assert.equal(s.state.runs, runs, 'its web server is not started again');
}

testCase('a new pinned revision is built beside the old one, the page restarts on it and the old build goes once it answers');
{
  const root = fresh();
  dockerGodspeed(root);
  const s = server(root);
  const first = page(root, s);
  await first.go();
  const old = `${PAGES_DIR}/archon-1cfb8fc541580fe5edf15e9a504b572bc9bb45bb`;
  write(at(root, `${old}/.forge-built`), '1cfb8fc541580fe5edf15e9a504b572bc9bb45bb\n');
  fs.rmSync(at(root, DIR), { recursive: true, force: true });
  const record = readRecord(first.paths, fs);
  fs.writeFileSync(path.join(first.paths.state, 'watch.json'), JSON.stringify({ ...record, source: 'https://github.com/coleam00/Archon', revision: '1cfb8fc541580fe5edf15e9a504b572bc9bb45bb' }));
  const restarts = s.state.restarts;
  const p = page(root, s);
  const r = await p.go();
  assert.equal(r.ok, true);
  assert.equal(r.built, true);
  assert.equal(s.state.restarts, restarts + 1);
  assert.equal(readRecord(p.paths, fs).revision, ARCHON_REVISION);
  assert.equal(readRecord(p.paths, fs).password, record.password, 'the sign-in stays');
  assert.ok(!fs.existsSync(at(root, old)), 'the older build is gone');
  assert.ok(fs.existsSync(at(root, `${DIR}/.forge-built`)));
}

testCase("on a native Godspeed the site goes into Godspeed's add-on folder, checked by Caddy before it takes it, on a port nobody else names");
{
  const root = fresh();
  nativeGodspeed(root);
  write(at(root, `${ADDON_DIR}/godspeed-clerk.caddy`), 'srv2.example.org:48444 {\n\treverse_proxy 127.0.0.1:8000\n}\n');
  write(at(root, `${ADDON_DIR}/someone-else.caddy`), 'srv2.example.org:48445 {\n\trespond "hi"\n}\n');
  const s = server(root, { listening: 'LISTEN 0 4096 127.0.0.1:3190 0.0.0.0:*\n' });
  const p = page(root, s);
  const r = await p.go();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.record.host, r.record.port, r.record.upstream, r.record.front], ['srv2.example.org', 48446, 3191, 'own']);
  assert.equal(read(at(root, SITE_FILE)), siteText({ host: 'srv2.example.org', port: 48446, upstream: 3191, user: USER, hash: HASH }));
  if (posix) assert.equal(fs.statSync(at(root, SITE_FILE)).mode & 0o777, 0o644, "readable for Godspeed's Caddy, which runs as the notebook's account");
  const lines = commandLines(s);
  const validate = lines.indexOf('/usr/local/bin/caddy validate --config /home/me/.local/state/godspeed/https/Caddyfile --adapter caddyfile');
  assert.ok(validate >= 0 && validate < lines.indexOf('systemctl restart godspeed-https.service'), 'checked before Caddy takes it');
  assert.ok(!s.calls.some(c => c.command === 'docker' && c.args[0] === 'run'), 'no container of its own on a native Godspeed');
}

testCase('a site Caddy refuses is taken out again, Caddy serves what it served before, and the page is not reported ready');
{
  const root = fresh();
  nativeGodspeed(root);
  const s = server(root, { validateFails: true });
  const p = page(root, s);
  const r = await p.go();
  assert.deepEqual(r, { ok: false, why: WHY.caddy });
  assert.equal(read(at(root, SITE_FILE)), null);
  assert.ok(commandLines(s).includes('systemctl restart godspeed-https.service'), 'Caddy reads its configuration without the file again');
  assert.match(read(path.join(p.paths.state, 'watch.log')), /unrecognized directive/);
}

testCase('the page runs as the account the factory runs as');
{
  const root = fresh();
  dockerGodspeed(root);
  write(at(root, '/etc/godspeed-forge/driver.json'), JSON.stringify({ server: { factory_user: 'godspeed-forge', factory_home: '/home/godspeed-forge' } }));
  const s = server(root);
  const r = await page(root, s).go();
  assert.equal(r.ok, true);
  const unit = read(at(root, `/etc/systemd/system/${UNIT}.service`));
  for (const line of ['User=godspeed-forge', 'WorkingDirectory=/home/godspeed-forge', 'Environment="HOME=/home/godspeed-forge"', 'Environment="PATH=/home/godspeed-forge/.local/bin:/usr/local/bin:/usr/bin:/bin"',
    'ReadWritePaths="-/home/godspeed-forge/.archon/archon.db-wal" "-/home/godspeed-forge/.archon/archon.db-shm"',
    `ExecStartPre=+"/usr/sbin/runuser" -m -u godspeed-forge -- "/usr/local/bin/bun" "/usr/local/lib/godspeed-forge/lib/watch-prepare.mjs" "${DIR}"`]) assert.ok(unit.includes(`${line}\n`), line);
  const lookup = s.calls.find(c => c.command === 'bash');
  assert.ok(lookup.options.env.PATH.startsWith('/home/godspeed-forge/.local/bin:'), "the factory account's own Bun comes first");
}

testCase("without Godspeed's web address, or with a Godspeed too old to give add-ons one, nothing is installed and the reason is one sentence");
{
  const none = fresh();
  const s = server(none);
  assert.deepEqual(await page(none, s).go(), { ok: false, why: WHY.noOwnName });
  assert.equal(read(at(none, `/etc/systemd/system/${UNIT}.service`)), null);
  assert.ok(!s.calls.some(c => c.command === 'git'), 'nothing downloaded');
  const old = fresh();
  nativeGodspeed(old, { addons: false });
  const o = server(old);
  assert.deepEqual(await page(old, o).go(), { ok: false, why: WHY.oldGodspeed });
  assert.equal(read(at(old, `/etc/systemd/system/${UNIT}.service`)), null);
}

const ADDRESSES = '2: eth0    inet 203.0.113.7/24 brd 203.0.113.255 scope global eth0\n';

testCase('with no Godspeed web address, a server on a tailnet gets the page through a Caddy of the Forge\'s own, signed in, and no firewall line');
{
  const root = fresh();
  const s = server(root, { tailnet: 'forge-box.tail1234.ts.net' });
  const p = page(root, s);
  const r = await p.go();
  assert.equal(r.ok, true, JSON.stringify(r));
  const record = readRecord(p.paths, fs);
  assert.equal(record.front, 'forge');
  assert.equal(record.host, 'forge-box.tail1234.ts.net');
  const caddyfile = read(at(root, FORGE_CADDYFILE));
  assert.equal(caddyfile, dockerCaddyfile(siteText({ host: record.host, port: record.port, upstream: record.upstream, user: USER, hash: HASH })));
  const unit = read(at(root, `/etc/systemd/system/${FORGE_UNIT}`));
  for (const line of ['ExecStart="/usr/bin/caddy" run --config "/opt/godspeed-forge/https/own.Caddyfile" --adapter caddyfile', 'ProtectSystem=strict', 'NoNewPrivileges=true', 'Restart=always', 'WantedBy=multi-user.target']) assert.ok(unit.includes(`${line}\n`), line);
  const lines = commandLines(s);
  const order = ['/usr/bin/caddy validate --config /opt/godspeed-forge/https/own.Caddyfile --adapter caddyfile', 'systemctl daemon-reload', `systemctl enable ${FORGE_UNIT}`, `systemctl restart ${FORGE_UNIT}`].map(l => lines.lastIndexOf(l));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `published in order: ${lines.join('\n')}`);
  assert.ok(!lines.some(l => l.includes('apt-get') || l === 'systemctl disable --now caddy.service'), 'Caddy was there: nothing installed, no service touched');
  const said = await watchLines({ ensure: async () => r, platform: 'linux', uid: 0, systemd: () => true });
  assert.equal(said.lines.length, 1, 'a tailnet name needs no word about the hosting company firewall');
  assert.ok(said.lines[0].includes(`https://${record.host}:${record.port}`));
  // the same again changes nothing
  const calls = s.calls.length;
  assert.equal((await page(root, s).go()).ok, true);
  assert.ok(!commandLines({ calls: s.calls.slice(calls) }).some(l => l === `systemctl restart ${FORGE_UNIT}`), 'a web server that runs is not restarted');
}

testCase('with no Godspeed web address and no tailnet, a DNS name that points at this server with port 80 free gives the page its address; anything else is one sentence and nothing is written');
{
  const root = fresh();
  const s = server(root, { hostname: 'host.example.net', addresses: ADDRESSES, listening: 'LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\n' });
  const r = await page(root, s).go();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.record.host, 'host.example.net');
  assert.equal(r.record.front, 'forge');
  for (const [label, options] of [
    ['port 80 is taken', { hostname: 'host.example.net', addresses: ADDRESSES, listening: 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:*\n' }],
    ['the name points elsewhere', { hostname: 'elsewhere.example.net', addresses: ADDRESSES }],
    ['the name has no dot', { hostname: null, addresses: ADDRESSES }],
  ]) {
    const other = fresh();
    const o = server(other, options);
    assert.deepEqual(await page(other, o).go(), { ok: false, why: WHY.noOwnName }, label);
    assert.equal(read(at(other, FORGE_CADDYFILE)), null, label);
    assert.equal(read(at(other, `/etc/systemd/system/${FORGE_UNIT}`)), null, label);
    assert.ok(!o.calls.some(c => c.command === 'git'), `${label}: nothing downloaded`);
  }
}

testCase("Caddy is installed from its own apt source only when it is missing, its packaged service is switched off at once, and a server without apt says so");
{
  const root = fresh();
  const s = server(root, { tailnet: 'a.tail1.ts.net', caddyInstalled: false });
  assert.equal((await page(root, s).go()).ok, true);
  const lines = commandLines(s);
  const install = lines.findIndex(l => l.includes('apt-get -o DPkg::Lock::Timeout=600 install -y -qq caddy'));
  assert.ok(install >= 0 && lines.indexOf('systemctl disable --now caddy.service') > install, lines.join('\n'));
  const none = fresh();
  const o = server(none, { tailnet: 'a.tail1.ts.net', caddyInstalled: false, apt: false });
  assert.deepEqual(await page(none, o).go(), { ok: false, why: WHY.noCaddy });
  assert.equal(read(at(none, FORGE_CADDYFILE)), null);
}

testCase("a Caddy that refuses the site or does not start gives way to the files before, or to none");
{
  const bad = fresh();
  const s = server(bad, { tailnet: 'a.tail1.ts.net', validateFails: true });
  assert.deepEqual(await page(bad, s).go(), { ok: false, why: WHY.front });
  assert.equal(read(at(bad, FORGE_CADDYFILE)), null);
  assert.equal(read(at(bad, `/etc/systemd/system/${FORGE_UNIT}`)), null);
  const good = fresh();
  const g = server(good, { tailnet: 'a.tail1.ts.net' });
  await page(good, g).go();
  const config = read(at(good, FORGE_CADDYFILE)), unit = read(at(good, `/etc/systemd/system/${FORGE_UNIT}`));
  fs.writeFileSync(at(good, FORGE_CADDYFILE), config.replace('basic_auth', '# older'));
  const again = server(good, { tailnet: 'a.tail1.ts.net', restartFails: true });
  assert.deepEqual(await page(good, again).go(), { ok: false, why: WHY.front });
  assert.equal(read(at(good, FORGE_CADDYFILE)), config.replace('basic_auth', '# older'), 'the file before comes back');
  assert.equal(read(at(good, `/etc/systemd/system/${FORGE_UNIT}`)), unit);
}

testCase("an address that does not answer on a tailnet name says what to turn on in Tailscale; elsewhere it says only that it does not answer");
{
  const root = fresh();
  const s = server(root, { tailnet: 'a.tail1.ts.net', answersOutside: false });
  assert.deepEqual(await page(root, s).go(), { ok: false, why: WHY.tailnetCert });
  const dns = fresh();
  assert.deepEqual(await page(dns, server(dns, { hostname: 'host.example.net', addresses: ADDRESSES, answersOutside: false })).go(), { ok: false, why: WHY.address });
}

testCase("once Godspeed has a web address, the Forge's own Caddy goes before the address moves to Godspeed's Caddy");
{
  const root = fresh();
  const s = server(root, { tailnet: 'a.tail1.ts.net' });
  assert.equal((await page(root, s).go()).ok, true);
  dockerGodspeed(root);
  const calls = s.calls.length;
  const r = await page(root, s).go();
  assert.equal(r.ok, true, JSON.stringify(r));
  const later = commandLines({ calls: s.calls.slice(calls) });
  assert.ok(later.includes(`systemctl disable --now ${FORGE_UNIT}`));
  assert.equal(read(at(root, `/etc/systemd/system/${FORGE_UNIT}`)), null);
  assert.equal(read(at(root, FORGE_CADDYFILE)), null);
  assert.equal(r.record.front, 'docker');
  assert.ok(later.indexOf(`systemctl disable --now ${FORGE_UNIT}`) < later.findIndex(l => l.startsWith('docker run')));
}

testCase('a build that fails, or an address that does not answer, is never reported ready');
{
  const root = fresh();
  dockerGodspeed(root);
  const broken = server(root, { buildFails: true });
  const p = page(root, broken);
  assert.deepEqual(await p.go(), { ok: false, why: WHY.build });
  assert.equal(read(at(root, `/etc/systemd/system/${UNIT}.service`)), null, 'no service for pages that are not there');
  assert.match(read(path.join(p.paths.state, 'watch.log')), /vite build failed/);
  const quiet = fresh();
  dockerGodspeed(quiet);
  const s = server(quiet, { answersOutside: false });
  assert.deepEqual(await page(quiet, s).go(), { ok: false, why: WHY.address });
}

testCase('the site asks for the sign-in first, lets only GET and HEAD reach Archon and never its internal paths');
{
  assert.equal(siteText({ host: 'srv1.example.com', port: 48445, upstream: 3190, user: 'forge', hash: HASH }), [
    '# The page where the owner watches the factory. The Forge (godspeed-forge) writes this file and keeps it.',
    "# Archon's own pages, read-only: a visit signs in first, and only GET and HEAD reach Archon.",
    'srv1.example.com:48445 {',
    '\tbasic_auth {',
    `\t\tforge ${HASH}`,
    '\t}',
    '\t@change not method GET HEAD',
    '\trespond @change "This page only shows the factory\'s work." 405',
    '\t@inside path /internal/* /webhooks/* /api/webhooks/*',
    '\trespond @inside 404',
    '\treverse_proxy 127.0.0.1:3190 {',
    '\t\theader_up -X-Archon-User',
    '\t\theader_up -Authorization',
    '\t}',
    '}',
    '',
  ].join('\n'));
  assert.equal(dockerCaddyfile('site\n'), '{\n\tadmin off\n\tauto_https disable_redirects\n}\n\nsite\n');
}

testCase('setup ends with the address and the sign-in in plain words, godspeed-forge watch says the same, and its hourly run never prints the password');
{
  const record = { host: 'srv1.example.com', port: 48445, user: 'forge', password: 'Kq7dWm2xPz9bTn4hRv3s' };
  const host = { platform: 'linux', uid: 0, systemd: () => true };
  const ensure = async () => ({ ok: true, record });
  assert.deepEqual(await watchLines({ ...host, ensure }), { ok: true, lines: [
    'Watch the factory at https://srv1.example.com:48445. Sign in as forge with the password Kq7dWm2xPz9bTn4hRv3s; keep both in your password manager.',
    "If the page does not open, your hosting company's firewall may be blocking it: let port 48445 in there.",
  ] });
  assert.deepEqual(await watchLines({ ...host, ensure: async () => ({ ok: false, why: WHY.start }) }), { ok: false, lines: [
    'The page where you watch the factory could not be set up: it did not start on this server. Type godspeed-forge watch in this terminal, as root, to try again.',
  ] });
  assert.deepEqual(await watchLines({ platform: 'linux', uid: 1000, systemd: () => true, ensure }), { ok: false, lines: [] }, 'not as root, setup says nothing about the page');
  const out = [];
  assert.equal(await runWatchCommand([], { ...host, ensure, output: l => out.push(l) }), 0);
  assert.equal(out.length, 2);
  assert.ok(out[0].includes(record.password));
  const kept = [];
  assert.equal(await runWatchCommand(['keep'], { ...host, ensure, output: l => kept.push(l) }), 0);
  assert.deepEqual(kept, ['The page where you watch the factory answers at https://srv1.example.com:48445.']);
  assert.equal(await runWatchCommand(['keep'], { ...host, ensure: async () => ({ ok: false, why: WHY.busy }), output: () => {} }), 0, 'another run setting it up is no failure');
  const refused = [];
  assert.equal(await runWatchCommand([], { platform: 'linux', uid: 1000, systemd: () => true, output: l => refused.push(l) }), 1);
  assert.deepEqual(refused, [NOT_HERE]);
}

testCase('asked in the chat, the Forge gives the address and the user name, never the password, and only while the address answers');
{
  const state = fresh();
  const paths = { state };
  const asked = [];
  const answering = async q => { asked.push(q); return q.secure ? 401 : 200; };
  const archonDown = async q => (q.secure ? 401 : 0);
  const silent = async () => 0;
  assert.deepEqual(await chatWatch({ kind: 'watch' }, { paths, ask: answering }), { ok: false, say: CHAT.none });
  fs.writeFileSync(path.join(state, 'watch.json'), JSON.stringify({ format: 1, host: 'srv1.example.com', port: 48445, upstream: 3190, user: 'forge', password: 'Kq7dWm2xPz9bTn4hRv3s', hash: HASH, revision: ARCHON_REVISION }));
  const here = await chatWatch({ kind: 'watch' }, { paths, ask: answering });
  assert.deepEqual(here, { ok: true, say: "You can watch the factory at https://srv1.example.com:48445. Sign in as forge with the password setup showed you. If you no longer have it, type godspeed-forge watch in your server's terminal, logged in as root, and it shows it again." });
  assert.ok(!here.say.includes('Kq7dWm2xPz9bTn4hRv3s'));
  assert.deepEqual(asked, [{ secure: true, port: 48445, host: 'srv1.example.com', pathname: '/api/health' }, { port: 3190, pathname: '/api/health' }], 'the address asks for the sign-in and Archon answers; the password is never sent');
  assert.deepEqual(await chatWatch({ kind: 'watch' }, { paths, ask: silent }), { ok: false, say: CHAT.stopped('https://srv1.example.com:48445') });
  assert.deepEqual(await chatWatch({ kind: 'watch' }, { paths, ask: archonDown }), { ok: false, say: CHAT.stopped('https://srv1.example.com:48445') });
}

const COLE = { source: 'https://github.com/coleam00/Archon', revision: '1cfb8fc541580fe5edf15e9a504b572bc9bb45bb' };
// A project the factory works on, with the factory settings Cole Medin's installer writes into its checkout.
function project(root, checkout, archon, { driver = true, state = null } = {}) {
  write(at(root, `${checkout}/.factory/consumer.json`), JSON.stringify({ source: `/root/.cache/factory/archon/${archon.revision}`, revision: archon.revision, bun: 'bun', repository: `${archon.source}.git`, kind: 'integration' }));
  const name = path.posix.basename(checkout);
  if (driver) write(at(root, `/etc/godspeed-forge/projects/owner--${name}.json`), JSON.stringify({ repository: `owner/${name}`, checkout }));
  if (state) write(path.join(state, 'projects', 'owner', name, 'registration.json'), JSON.stringify({ repository: `owner/${name}`, checkout, completed: true }));
}
// The factory download setup keeps in the Forge's private state: Cole Medin's installer, whose manifest names his pin.
const factoryDownload = root => write(path.join(root, 'state', 'factory', 'template', 'factory', 'pack.json'), JSON.stringify({ repository: COLE.source, integration_revision_required: COLE.revision }));

testCase("the page builds the Archon the factory runs on this server, and the Forge's pin when no project names one or they differ");
{
  const root = fresh();
  dockerGodspeed(root);
  factoryDownload(root);
  project(root, '/root/projects/owner/app', COLE);
  project(root, '/root/projects/owner/site', COLE, { driver: false, state: path.join(root, 'state') });
  assert.deepEqual(factoryArchon({ fs, root, state: path.join(root, 'state') }), COLE);
  const s = server(root);
  const r = await page(root, s).go();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.record.source, r.record.revision], [COLE.source, COLE.revision]);
  assert.ok(commandLines(s).includes(`git clone --quiet --no-checkout --no-hardlinks ${COLE.source} ${pageDir(COLE.revision)}`), 'from the copy and revision the factory runs');
  assert.ok(read(at(root, `/etc/systemd/system/${UNIT}.service`)).includes(`${pageDir(COLE.revision)}/packages/cli/src/cli.ts`));
  project(root, '/root/projects/owner/other', { source: ARCHON_SOURCE, revision: ARCHON_REVISION });
  assert.deepEqual(factoryArchon({ fs, root, state: path.join(root, 'state') }), { source: ARCHON_SOURCE, revision: ARCHON_REVISION }, 'projects on different ones while they move: the pin setup installs');
  assert.deepEqual(factoryArchon({ fs, root: fresh() }), { source: ARCHON_SOURCE, revision: ARCHON_REVISION }, 'no project yet: the pin setup installs');
}

testCase("a project's own settings never make the page download and build an Archon the Forge does not vouch for");
{
  const root = fresh();
  dockerGodspeed(root);
  factoryDownload(root);
  const state = path.join(root, 'state');
  project(root, '/home/factory/app', { source: 'https://github.com/someone/Archon', revision: COLE.revision });
  assert.deepEqual(factoryArchon({ fs, root, state }), { source: ARCHON_SOURCE, revision: ARCHON_REVISION }, 'another repository');
  project(root, '/home/factory/app', { source: COLE.source, revision: 'f'.repeat(40) });
  assert.deepEqual(factoryArchon({ fs, root, state }), { source: ARCHON_SOURCE, revision: ARCHON_REVISION }, 'another revision of a trusted repository');
  assert.deepEqual(factoryArchon({ fs, root }), { source: ARCHON_SOURCE, revision: ARCHON_REVISION }, "without the Forge's own factory download, only its own pin");
  project(root, '/home/factory/app', COLE);
  assert.deepEqual(factoryArchon({ fs, root }), { source: ARCHON_SOURCE, revision: ARCHON_REVISION }, "Cole Medin's pin counts only as the Forge's download names it");
  assert.deepEqual(factoryArchon({ fs, root, state }), COLE);
  const s = server(root);
  project(root, '/home/factory/app', { source: 'https://github.com/someone/Archon', revision: COLE.revision });
  assert.equal((await page(root, s).go()).ok, true);
  assert.ok(!commandLines(s).some(l => l.includes('someone')), 'never cloned');
}

testCase('a new version that does not answer gives way to the one before, which runs again, and the hourly check does not try it again');
{
  const root = fresh();
  dockerGodspeed(root);
  factoryDownload(root);
  project(root, '/root/projects/owner/app', COLE);
  const s = server(root, { badRevision: ARCHON_REVISION });
  assert.equal((await page(root, s).go()).ok, true);
  project(root, '/root/projects/owner/app', { source: ARCHON_SOURCE, revision: ARCHON_REVISION });
  const p = page(root, s);
  const r = await p.go();
  assert.equal(r.ok, true, 'the page still answers, on the version before');
  assert.deepEqual([r.record.revision, r.record.failedRevision], [COLE.revision, ARCHON_REVISION]);
  assert.ok(read(at(root, `/etc/systemd/system/${UNIT}.service`)).includes(pageDir(COLE.revision)), 'the unit runs the version before again');
  assert.ok(fs.existsSync(at(root, `${pageDir(COLE.revision)}/.forge-built`)) && fs.existsSync(at(root, `${pageDir(ARCHON_REVISION)}/.forge-built`)), 'both builds stay');
  assert.match(read(path.join(p.paths.state, 'watch.log')), /did not answer/);
  const restarts = s.state.restarts;
  assert.equal((await page(root, s, { wait: false }).go()).ok, true);
  assert.equal(s.state.restarts, restarts, 'the hourly check leaves the page running on the version before');
  await page(root, s).go();
  assert.equal(s.state.restarts, restarts + 2, 'setup or the install line tries the new version again, and gives way again');
}

testCase('systemd refusing to reload, enable or start what the page needs is never reported as ready');
{
  for (const verb of ['daemon-reload', 'enable']) {
    const root = fresh();
    dockerGodspeed(root);
    const p = page(root, server(root, { refuse: verb }));
    assert.deepEqual(await p.go(), { ok: false, why: WHY.start }, verb);
    assert.match(read(path.join(p.paths.state, 'watch.log')), /systemd: Failed to enable unit/);
  }
}

testCase("on Godspeed's Docker server a new web server container that does not start, or stops at once, gives way to the one before");
{
  for (const how of ['brokenImages', 'stoppingImages']) {
    const root = fresh();
    dockerGodspeed(root);
    const s = server(root);
    assert.equal((await page(root, s).go()).ok, true);
    const config = read(at(root, DOCKER_CADDYFILE));
    s.state.frontImage = 'caddy:2.11.4-alpine';
    s.state[how].add('caddy:2.11.4-alpine');
    assert.deepEqual(await page(root, s).go(), { ok: false, why: WHY.front }, how);
    assert.deepEqual([s.state.container?.Config.Image, s.state.container?.State.Running], ['caddy:2.10.2-alpine', true], `${how}: the container before runs again`);
    assert.equal(read(at(root, DOCKER_CADDYFILE)), config, `${how}: with the configuration it had`);
    assert.equal(s.state.containerConfig, config);
  }
}

testCase('a factory that keeps its records in a database server gets no page, because only a database file can be kept read-only to it');
{
  const root = fresh();
  dockerGodspeed(root);
  write(at(root, '/root/.archon/.env'), 'CLAUDE_BIN_PATH=/usr/local/bin/claude\nDATABASE_URL=postgresql://archon@127.0.0.1/archon\n');
  const s = server(root);
  assert.deepEqual(await page(root, s).go(), { ok: false, why: WHY.databaseServer });
  assert.equal(read(at(root, `/etc/systemd/system/${UNIT}.service`)), null);
  assert.ok(!s.calls.some(c => c.command === 'git'), 'nothing downloaded');
  const home = fresh();
  fs.writeFileSync(path.join(home, '.env'), 'export DATABASE_URL="postgresql://archon@db/archon"\n');
  assert.equal(await prepare({ dir: '/x', home, run: () => { throw new Error('must not run'); }, makeKey: async () => { throw new Error('must not run'); } }), 2, 'nor does the page start, if the settings change later');
  assert.deepEqual(fs.readdirSync(home), ['.env']);
  for (const [text, uses] of [['# DATABASE_URL=postgresql://x\n', false], ['DATABASE_URL=\n', false], ['OTHER=1\n', false]]) assert.equal(usesDatabaseServer(text), uses, text);
}

testCase('a failure that throws, even before the page takes its lock, never escapes: setup and the hourly run each say it in one sentence');
{
  const root = fresh();
  const broken = { ...fs, mkdirSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
  const s = server(root);
  assert.deepEqual(await ensureWatchPage({ root, run: s.run, ask: s.ask, fs: broken, paths: { state: path.join(root, 'state'), addon: '/a' }, env: {}, sleep: async () => {} }), { ok: false, why: WHY.start });
  const host = { platform: 'linux', uid: 0, systemd: () => true };
  const thrown = async () => { throw new Error('boom'); };
  assert.deepEqual(await watchLines({ ...host, ensure: thrown }), { ok: false, lines: [SAY.failed(WHY.start, SAY.againWatch)] });
  const said = [];
  assert.equal(await runWatchCommand(['keep'], { ...host, ensure: thrown, output: l => said.push(l) }), 1);
  assert.deepEqual(said, [SAY.failed(WHY.start, SAY.againWatch)]);
}

testCase("before each start the page's preparation makes only what is missing, with Archon's own code, and never opens a database the factory already has");
{
  const dir = '/opt/godspeed-forge/watch/archon-x';
  // a server the factory has not used yet: Archon's own read-only command makes the database
  const home = fresh(), runs = [];
  let keys = 0;
  const run = (command, args) => { runs.push([command, ...args].join(' ')); fs.writeFileSync(path.join(home, 'archon.db'), 'tables'); return { status: 0 }; };
  assert.equal(await prepare({ dir, home, run, makeKey: async () => { keys++; } }), 0);
  assert.deepEqual(runs, [`${process.execPath} ${path.join(dir, 'packages', 'cli', 'src', 'cli.ts')} --cwd ${dir} isolation list`]);
  assert.equal(keys, 1, "Archon's own function makes its local key");
  for (const name of SIDE_FILES) assert.equal(read(path.join(home, name)), '', `${name} is made empty, as SQLite makes it`);
  // a database the factory has: never opened, and side files that are there are left as they are
  const used = fresh();
  fs.writeFileSync(path.join(used, 'archon.db'), 'the factory\'s');
  fs.writeFileSync(path.join(used, 'archon.db-shm'), 'in use');
  const untouched = [];
  assert.equal(await prepare({ dir, home: used, run: (...a) => { untouched.push(a); return { status: 0 }; }, makeKey: async () => {} }), 0);
  assert.deepEqual(untouched, [], 'no Archon command runs on a database that is there');
  assert.equal(read(path.join(used, 'archon.db-shm')), 'in use');
  assert.equal(read(path.join(used, 'archon.db-wal')), '');
  // Archon could not make the database: the start fails, nothing else is made
  const failing = fresh();
  assert.equal(await prepare({ dir, home: failing, run: () => ({ status: 1 }), makeKey: async () => { throw new Error('must not run'); } }), 1);
  assert.deepEqual(fs.readdirSync(failing), []);
}

testCase('everything the owner reads about the page is plain: no long dashes, no internal names, at most one link');
{
  const texts = [SAY.preparing, SAY.installed('https://srv1.example.com:48445'), SAY.login({ address: 'https://srv1.example.com:48445', user: 'forge', password: 'x' }), SAY.firewall(48445), NOT_HERE,
    ...Object.values(WHY).flatMap(why => [SAY.failed(why, SAY.againInstall), SAY.failed(why, SAY.againWatch)]),
    CHAT.here('https://srv1.example.com:48445', 'forge'), CHAT.stopped('https://srv1.example.com:48445'), CHAT.none];
  for (const text of texts) {
    assertPlain(assert, text);
    assert.doesNotMatch(text, /\b(?:Archon|Caddy|systemd|watch\.json|bcrypt)\b/, `no machinery: ${text}`);
  }
}

await rm(tmp, { recursive: true, force: true });
