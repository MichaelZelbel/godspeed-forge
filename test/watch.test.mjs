// The page where the owner watches the factory (lib/watch.mjs), its chat answer (lib/owner/watch.mjs) and the lines
// setup ends with. The server is a stand-in: a folder of the test's own is its file system, and systemctl, docker, git,
// bun, caddy and the page's answers are stand-ins, so nothing is installed and nothing reaches the network.
// test cases: 12
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testCase } from './cases.mjs';
import { assertPlain } from './forge-owner-fakes.mjs';
import { ARCHON_REVISION, ARCHON_SOURCE } from '../lib/constants.mjs';
import {
  ADDON_DIR, CONTAINER, DOCKER_CADDYFILE, KEEP_UNIT, NOT_HERE, PAGES_DIR, SAY, SITE_FILE, UNIT, USER, WHY,
  dockerCaddyfile, ensureWatchPage, pageDir, readRecord, runWatchCommand, siteText, watchLines
} from '../lib/watch.mjs';
import { SAY as CHAT, watch as chatWatch } from '../lib/owner/watch.mjs';

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
function server(root, { listening = '', validateFails = false, buildFails = false, answersOutside = true, active = [] } = {}) {
  const calls = [];
  const state = { active: new Set(active), container: null, restarts: 0, runs: 0 };
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const run = async (command, args = [], options = {}) => {
    calls.push({ command, args, options });
    if (command === 'systemctl') {
      const [verb, ...rest] = args;
      if (verb === 'is-active') return state.active.has(rest.at(-1)) ? ok() : { status: 3, stdout: '', stderr: '' };
      if (verb === 'restart' || verb === 'start') { state.active.add(rest[0]); if (rest[0] === `${UNIT}.service`) state.restarts++; }
      return ok();
    }
    if (command === 'docker') {
      if (args[0] === 'ps') return ok('');
      if (args[0] === 'compose') return ok('abc123def4567890\n');
      if (args[0] === 'inspect' && args[1] === 'abc123def4567890') {
        return ok(JSON.stringify([{ State: { Running: true }, Config: { Image: 'caddy:2.10.2-alpine' }, Mounts: [{ Destination: '/data', Type: 'volume', Name: 'gm_godspeed-certificates' }] }]));
      }
      if (args[0] === 'inspect') return state.container ? ok(JSON.stringify([state.container])) : { status: 1, stdout: '[]', stderr: 'Error: No such object' };
      if (args[0] === 'rm') { state.container = null; return ok(); }
      if (args[0] === 'run') {
        state.runs++;
        const label = args[args.indexOf('--label') + 1].split('=');
        state.container = { State: { Running: true }, Config: { Image: args[args.indexOf('XDG_DATA_HOME=/data') + 1], Labels: { [label[0]]: label[1] } } };
        return ok('f00d\n');
      }
    }
    if (command === 'bash' && args[1] === 'command -v bun') return ok('/usr/local/bin/bun\n');
    if (command === '/usr/local/bin/bun' && args[0] === '-e') return ok(HASH);
    if (command === 'git' && args[0] === 'clone') { fs.mkdirSync(at(root, `${args.at(-1)}/.git`), { recursive: true }); return ok(); }
    if (command === 'git' && args.includes('rev-parse')) return ok(`${ARCHON_REVISION}\n`);
    if (command === 'git') return ok();
    if (command === '/usr/local/bin/bun' && args[0] === 'install') return ok();
    if (command === '/usr/local/bin/bun' && args[1] === 'build:web') {
      if (buildFails) return { status: 1, stdout: '', stderr: 'error: vite build failed' };
      write(at(root, `${options.cwd}/packages/web/dist/index.html`), '<html></html>');
      return ok();
    }
    if (command === 'chmod') return ok();
    if (command === 'ss') return ok(listening);
    if (command === '/usr/local/bin/caddy') return validateFails ? { status: 1, stdout: '', stderr: 'Error: adapting config: unrecognized directive: basic_auth' } : ok();
    return { status: 127, stdout: '', stderr: 'not found' };
  };
  // The page's answers: Archon on this server while its service runs; over HTTPS while a site is published, 401 without
  // the sign-in and 200 with the one the record holds.
  const ask = async ({ secure, auth }) => {
    if (!secure) return state.active.has(`${UNIT}.service`) ? 200 : 0;
    if (!answersOutside) return 0;
    const published = state.container || read(at(root, SITE_FILE));
    if (!published) return 0;
    if (!auth) return 401;
    const record = JSON.parse(read(path.join(root, 'state', 'watch.json')));
    return auth === `${record.user}:${record.password}` ? 200 : 401;
  };
  return { run, ask, calls, state };
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
  assert.deepEqual({ ...record, password: '-' }, { format: 1, host: 'srv1.example.com', port: 48445, upstream: 3190, user: USER, password: '-', hash: HASH, revision: ARCHON_REVISION, front: 'docker' });
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
    `ExecStart="/usr/local/bin/bun" "${DIR}/packages/cli/src/cli.ts" serve --port 3190`]) assert.ok(unit.includes(`${line}\n`), line);
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
  fs.writeFileSync(path.join(first.paths.state, 'watch.json'), JSON.stringify({ ...record, revision: '1cfb8fc541580fe5edf15e9a504b572bc9bb45bb' }));
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
  for (const line of ['User=godspeed-forge', 'WorkingDirectory=/home/godspeed-forge', 'Environment="HOME=/home/godspeed-forge"', 'Environment="PATH=/home/godspeed-forge/.local/bin:/usr/local/bin:/usr/bin:/bin"']) assert.ok(unit.includes(`${line}\n`), line);
  const lookup = s.calls.find(c => c.command === 'bash');
  assert.ok(lookup.options.env.PATH.startsWith('/home/godspeed-forge/.local/bin:'), "the factory account's own Bun comes first");
}

testCase("without Godspeed's web address, or with a Godspeed too old to give add-ons one, nothing is installed and the reason is one sentence");
{
  const none = fresh();
  const s = server(none);
  assert.deepEqual(await page(none, s).go(), { ok: false, why: WHY.noFront });
  assert.equal(read(at(none, `/etc/systemd/system/${UNIT}.service`)), null);
  assert.ok(!s.calls.some(c => c.command === 'git'), 'nothing downloaded');
  const old = fresh();
  nativeGodspeed(old, { addons: false });
  const o = server(old);
  assert.deepEqual(await page(old, o).go(), { ok: false, why: WHY.oldGodspeed });
  assert.equal(read(at(old, `/etc/systemd/system/${UNIT}.service`)), null);
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

testCase('asked in the chat, the Forge gives the address and the user name, never the password');
{
  const state = fresh();
  const paths = { state };
  const active = async () => ({ status: 0, stdout: '', stderr: '' });
  const stopped = async () => ({ status: 3, stdout: '', stderr: '' });
  assert.deepEqual(await chatWatch({ kind: 'watch' }, { paths, run: active }), { ok: false, say: CHAT.none });
  fs.writeFileSync(path.join(state, 'watch.json'), JSON.stringify({ format: 1, host: 'srv1.example.com', port: 48445, upstream: 3190, user: 'forge', password: 'Kq7dWm2xPz9bTn4hRv3s', hash: HASH, revision: ARCHON_REVISION }));
  const here = await chatWatch({ kind: 'watch' }, { paths, run: active });
  assert.deepEqual(here, { ok: true, say: "You can watch the factory at https://srv1.example.com:48445. Sign in as forge with the password setup showed you. If you no longer have it, type godspeed-forge watch in your server's terminal, logged in as root, and it shows it again." });
  assert.ok(!here.say.includes('Kq7dWm2xPz9bTn4hRv3s'));
  assert.deepEqual(await chatWatch({ kind: 'watch' }, { paths, run: stopped }), { ok: false, say: CHAT.stopped('https://srv1.example.com:48445') });
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
