// The install line's program (lib/install/server.mjs), the server's tools (server-tools.mjs), the units that answer the
// chat (inbox-units.mjs), the forge skill, and the step runner's bridge. apt, the official installers, systemctl and
// Godspeed are stand-ins: nothing is installed on this machine and nothing reaches the network.
// test cases: 16
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCase } from './cases.mjs';
import { installServerTools, TOOLS, TOOLS_READY } from '../lib/install/server-tools.mjs';
import { inboxUnits, installInboxUnits, UNITS_READY } from '../lib/install/inbox-units.mjs';
import { installServer, SAY } from '../lib/install/server.mjs';
import { STOP } from '../lib/godspeed.mjs';
import { stepContext, godspeedBridge, addonBridgeFiles } from '../driver/steps.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'forge-install-'));
let n = 0;
const fresh = () => { const d = path.join(root, `t${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

// A stand-in server: `have` holds the tools it has; an install script "installs" the tool it is for.
function server(have, { apt = true, fail = null } = {}) {
  const scripts = [];
  const run = async (command, args) => {
    assert.equal(command, 'bash');
    const script = args[1].replace(/^set -eu\n/, '');
    const tool = TOOLS.find(t => t.present === script);
    if (tool) return { status: have.has(tool.key) ? 0 : 1, stdout: '', stderr: '' };
    if (script === 'command -v apt-get') return { status: apt ? 0 : 1, stdout: '', stderr: '' };
    scripts.push(script);
    const installing = TOOLS.find(t => script.startsWith(t.install));
    if (installing && fail === installing.key) return { status: 100, stdout: '', stderr: 'E: Unable to locate package gh\n' };
    if (installing) have.add(installing.key);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, scripts };
}

testCase('a server that has every tool hears one line and nothing is installed');
{
  const s = server(new Set(TOOLS.map(t => t.key))), lines = [];
  assert.deepEqual(await installServerTools({ run: s.run, say: l => lines.push(l) }), { ok: true });
  assert.deepEqual(lines, ['The server has everything the factory needs.']);
  assert.deepEqual(s.scripts, []);
}

testCase('a fresh server gets every tool from its maker, each said in one line');
{
  const s = server(new Set()), lines = [];
  assert.deepEqual(await installServerTools({ run: s.run, say: l => lines.push(l) }), { ok: true });
  assert.deepEqual(lines, [
    'Installing the basic tools the others need.', 'Installing Git.', "Installing GitHub's command line tool.",
    'Installing Python 3.10 or newer with virtual environments.', 'Installing Node.js 22.', 'Installing Bun.', 'Installing uv.',
    'Installing Claude Code.', 'Installing Codex.', TOOLS_READY,
  ]);
  assert.equal(s.scripts.filter(x => /^apt-get -o DPkg::Lock::Timeout=600 update -qq$/.test(x)).length, 1, 'the package lists are read once before the first plain package');
  const all = s.scripts.join('\n');
  for (const source of ['https://cli.github.com/packages', 'https://deb.nodesource.com/node_22.x', 'https://bun.sh/install', 'https://astral.sh/uv/install.sh', 'https://claude.ai/install.sh', 'npm install -g --no-fund --no-audit @openai/codex', 'python3 python3-venv python-is-python3']) assert.ok(all.includes(source), source);
  assert.ok(all.includes('ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude'), 'Claude Code is put where every shell finds it');
}

testCase('a tool that cannot be installed stops the install in one plain sentence with the reason');
{
  const s = server(new Set(['basics', 'git']), { fail: 'gh' });
  const r = await installServerTools({ run: s.run });
  assert.deepEqual(r, { ok: false, stop: "GitHub's command line tool could not be installed: E: Unable to locate package gh. Put that right, then run this line again." });
}

testCase('a server without apt that is missing tools stops the install in one sentence naming exactly what is missing');
{
  const s = server(new Set(['basics', 'git', 'python']), { apt: false }), lines = [];
  assert.deepEqual(await installServerTools({ run: s.run, say: l => lines.push(l) }), { ok: false, stop: "This server is missing GitHub's command line tool, Node.js 22, Bun, uv, Claude Code and Codex, which the Forge can install only on a server with apt, so nothing was installed: install them first, then run this line again." });
  assert.deepEqual(lines, []);
  assert.deepEqual(s.scripts, [], 'nothing was tried');
  const one = server(new Set(TOOLS.map(t => t.key).filter(k => k !== 'uv')), { apt: false });
  assert.equal((await installServerTools({ run: one.run })).stop, 'This server is missing uv, which the Forge can install only on a server with apt, so nothing was installed: install it first, then run this line again.');
  const basicsOnly = server(new Set(TOOLS.map(t => t.key).filter(k => k !== 'basics')), { apt: false }), said = [];
  assert.deepEqual(await installServerTools({ run: basicsOnly.run, say: l => said.push(l) }), { ok: true }, 'the basics matter only for installing the others');
  assert.deepEqual(said, [TOOLS_READY]);
}

testCase('the inbox units start godspeed-forge inbox as root when a request lands, and every minute');
{
  const u = inboxUnits({ node: '/usr/bin/node', forge: '/usr/local/lib/godspeed-forge/bin/godspeed-forge.mjs', inbox: '/srv/data/workspace/.godspeed/forge/inbox' });
  assert.deepEqual(Object.keys(u), ['godspeed-forge-inbox.service', 'godspeed-forge-inbox.path', 'godspeed-forge-inbox.timer']);
  assert.ok(u['godspeed-forge-inbox.service'].includes('ExecStart="/usr/bin/node" "/usr/local/lib/godspeed-forge/bin/godspeed-forge.mjs" inbox\n'));
  assert.ok(u['godspeed-forge-inbox.service'].includes('Type=oneshot\n'));
  assert.ok(!/^User=/m.test(u['godspeed-forge-inbox.service']), 'it runs as root');
  assert.ok(u['godspeed-forge-inbox.path'].includes('PathChanged=/srv/data/workspace/.godspeed/forge/inbox\nUnit=godspeed-forge-inbox.service\n'));
  assert.ok(u['godspeed-forge-inbox.timer'].includes('OnUnitActiveSec=1min\n'));
}

testCase('installing the units writes them, reloads systemd and starts the path unit and the timer');
{
  const dir = fresh(), calls = [];
  const run = async (command, args) => { calls.push([command, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' }; };
  assert.deepEqual(await installInboxUnits({ run, unitsDir: dir, node: '/usr/bin/node', forge: '/f.mjs', inbox: '/i' }), { ok: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['godspeed-forge-inbox.path', 'godspeed-forge-inbox.service', 'godspeed-forge-inbox.timer']);
  assert.deepEqual(calls, ['systemctl daemon-reload', 'systemctl enable godspeed-forge-inbox.path godspeed-forge-inbox.timer', 'systemctl restart godspeed-forge-inbox.path godspeed-forge-inbox.timer']);
  const failing = async () => ({ status: 1, stdout: '', stderr: 'Failed to connect to bus\n' });
  assert.deepEqual(await installInboxUnits({ run: failing, unitsDir: dir, node: '/usr/bin/node', forge: '/f.mjs', inbox: '/i' }), { ok: false, why: 'Failed to connect to bus' });
}

// A whole install as root on a Linux server with systemd, Godspeed found in Docker (a stand-in), the tools stand-in.
async function rootInstall({ found, settings = fresh(), tools = async () => ({ ok: true }), uid = 0, systemd = true } = {}) {
  const workspace = found?.workspace, units = fresh(), install = fresh(), lines = [], warnings = [], chowns = [], runs = [];
  const paths = { addon: path.join(install, 'addon'), executable: path.join(install, 'bin', 'godspeed-forge'), config: path.join(install, 'config.json'), state: path.join(install, 'state') };
  let toolsCalled = false;
  const run = async (command, args) => {
    runs.push([command, ...args].join(' '));
    if (command === 'bash') return { status: 0, stdout: '/usr/bin/node\n', stderr: '' };
    if (command === '/usr/bin/node') return { status: 0, stdout: '22.19.0\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const code = await installServer({
    env: { FORGE_SOURCE: repo, FORGE_SETTINGS_DIR: settings, FORGE_UNITS_DIR: units }, paths, uid, platform: 'linux', systemd: () => systemd,
    fs: { ...fs, chownSync: (p, u, g) => chowns.push([p, u, g]) }, run, find: async () => found,
    installTools: async o => { toolsCalled = true; return tools(o); }, say: l => lines.push(l), warn: l => warnings.push(l),
  });
  return { code, lines, warnings, chowns, runs, units, paths, workspace, toolsCalled: () => toolsCalled };
}
const dockerFound = () => {
  const workspace = fresh();
  fs.mkdirSync(path.join(workspace, '.godspeed'));
  return { kind: 'docker', version: '2.0.0-beta.29', running: true, workspace, owner: { uid: 10000, gid: 10000 }, docker: { root: '/srv/gm', compose: '/srv/gm/compose.yaml', service: 'godspeed', workspace: '/opt/data/full-candidate/workspace', container: 'abc' } };
};
const version = fs.readFileSync(path.join(repo, 'VERSION'), 'utf8').trim();

testCase('on Godspeed\'s Docker server the install says each step, gives the chat the forge skill and starts the inbox service');
{
  const r = await rootInstall({ found: dockerFound() });
  assert.equal(r.code, 0, r.warnings.join('\n'));
  assert.deepEqual(r.lines, ['Found Godspeed 2.0.0-beta.29, which runs in Docker on this server.', `Installing the Forge ${version}.`, "Godspeed's chat now knows the Forge.", UNITS_READY]);
  assert.equal(fs.readFileSync(path.join(r.workspace, 'skills', 'forge', 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(repo, 'skills', 'forge', 'SKILL.md'), 'utf8'));
  for (const rel of ['inbox', 'inbox/done', 'outbox', 'projects']) assert.ok(fs.statSync(path.join(r.workspace, '.godspeed', 'forge', ...rel.split('/'))).isDirectory(), rel);
  const owned = r.chowns.map(([p]) => path.relative(r.workspace, p).split(path.sep).join('/'));
  for (const rel of ['skills', 'skills/forge', '.godspeed/forge', '.godspeed/forge/inbox', '.godspeed/forge/outbox']) assert.ok(owned.includes(rel), `${rel} is the hermes user's`);
  assert.ok(r.chowns.every(([, u, g]) => u === 10000 && g === 10000));
  const pathUnit = fs.readFileSync(path.join(r.units, 'godspeed-forge-inbox.path'), 'utf8');
  assert.ok(pathUnit.includes(`PathChanged=${path.join(r.workspace, '.godspeed', 'forge', 'inbox')}\n`), pathUnit);
  assert.ok(fs.readFileSync(path.join(r.units, 'godspeed-forge-inbox.service'), 'utf8').includes(`ExecStart="/usr/bin/node" "${path.join(r.paths.addon, 'bin', 'godspeed-forge.mjs').replace(/\\/g, '\\\\')}" inbox`));
  assert.ok(fs.existsSync(path.join(r.paths.addon, 'lib', 'godspeed.mjs')) && fs.existsSync(path.join(r.paths.addon, 'lib', 'inbox.mjs')));
  assert.ok(fs.existsSync(r.paths.config));
}

testCase('the old setup skill the Forge put there goes, and one the owner changed stays');
{
  const found = dockerFound();
  fs.mkdirSync(path.join(found.workspace, 'skills', 'forge-setup'), { recursive: true });
  fs.writeFileSync(path.join(found.workspace, 'skills', 'forge-setup', 'SKILL.md'), '---\nname: forge-setup\ndescription: Set up the Forge.\n---\n\nRun:\n\n```bash\ngodspeed-forge setup owner/repository\n```\n');
  await rootInstall({ found });
  assert.ok(!fs.existsSync(path.join(found.workspace, 'skills', 'forge-setup')));
  const kept = dockerFound();
  fs.mkdirSync(path.join(kept.workspace, 'skills', 'forge-setup'), { recursive: true });
  fs.writeFileSync(path.join(kept.workspace, 'skills', 'forge-setup', 'SKILL.md'), '---\nname: forge-setup\n---\nMy own notes about godspeed-forge setup owner/repository\n');
  fs.writeFileSync(path.join(kept.workspace, 'skills', 'forge-setup', 'notes.md'), 'mine');
  await rootInstall({ found: kept });
  assert.ok(fs.existsSync(path.join(kept.workspace, 'skills', 'forge-setup', 'notes.md')));
}

testCase('a server that already runs the factory keeps its tools, and a failed tool stops the install before the Forge is copied');
{
  const settings = fresh();
  fs.writeFileSync(path.join(settings, 'driver.json'), '{}\n');
  const kept = await rootInstall({ found: dockerFound(), settings });
  assert.equal(kept.code, 0);
  assert.equal(kept.toolsCalled(), false);
  assert.equal(kept.lines[1], 'This server already runs the factory, so its tools were left as they are.');
  const failed = await rootInstall({ found: dockerFound(), tools: async () => ({ ok: false, stop: 'Codex could not be installed: npm ERR! 404. Put that right, then run this line again.' }) });
  assert.equal(failed.code, 1);
  assert.deepEqual(failed.warnings, ['Codex could not be installed: npm ERR! 404. Put that right, then run this line again.']);
  assert.ok(!fs.existsSync(failed.paths.addon));
}

testCase('on a server without apt that lacks tools the whole install stops before the Forge is copied, with no next step');
{
  const r = await rootInstall({ found: dockerFound(), tools: o => installServerTools({ ...o, run: server(new Set(['basics', 'git', 'python', 'node', 'gh', 'bun', 'uv']), { apt: false }).run }) });
  assert.equal(r.code, 1);
  assert.deepEqual(r.warnings, ['This server is missing Claude Code and Codex, which the Forge can install only on a server with apt, so nothing was installed: install them first, then run this line again.']);
  assert.deepEqual(r.lines, ['Found Godspeed 2.0.0-beta.29, which runs in Docker on this server.']);
  assert.ok(!fs.existsSync(r.paths.addon) && !fs.existsSync(path.join(r.workspace, 'skills', 'forge')));
  assert.deepEqual(fs.readdirSync(r.units), []);
}

testCase('without Godspeed, or with one too old, the install stops in its plain sentence and installs nothing');
{
  const none = await rootInstall({ found: null });
  assert.deepEqual([none.code, none.lines, none.warnings], [1, [], [STOP.none]]);
  assert.ok(!fs.existsSync(none.paths.addon) && !fs.existsSync(path.join(none.units, 'godspeed-forge-inbox.path')));
  const old = await rootInstall({ found: { ...dockerFound(), version: '2.0.0-beta.20' } });
  assert.deepEqual(old.warnings, ['Godspeed 2.0.0-beta.20 is installed; the Forge requires Godspeed 2.0.0-beta.24 or newer. Update Godspeed, then run this line again.']);
}

testCase('not as root, the install leaves the server\'s tools and services alone; without systemd it says how the chat is answered');
{
  const plain = await rootInstall({ found: { ...dockerFound(), kind: 'native' }, uid: 1000 });
  assert.equal(plain.code, 0);
  assert.deepEqual(plain.lines, ['Found Godspeed 2.0.0-beta.29 on this server.', SAY.notRoot, `Installing the Forge ${version}.`, SAY.skill]);
  assert.deepEqual(fs.readdirSync(plain.units), []);
  const noSystemd = await rootInstall({ found: dockerFound(), systemd: false });
  assert.equal(noSystemd.lines.at(-1), 'This server has no systemd, so requests from the chat wait until godspeed-forge inbox runs.');
}

testCase('every step a driver step runs is given the bridge to Godspeed, and a stand-in given to the runner wins');
{
  const mod = { STEP: { name: 'alpha', everyMinutes: 5, maxMinutes: 5 } };
  const ctx = stepContext({ settings: {}, now: 1 }, mod);
  assert.equal(ctx.godspeed, godspeedBridge);
  const standIn = async () => ({ kind: 'native' });
  assert.equal(stepContext({ settings: {}, now: 1, godspeed: standIn }, mod).godspeed, standIn);
  const addon = fresh();
  assert.equal(addonBridgeFiles({ FORGE_ADDON_DIR: addon }, '/home/x')[0], path.join(addon, 'lib', 'godspeed.mjs'));
  fs.mkdirSync(path.join(addon, 'lib'));
  fs.writeFileSync(path.join(addon, 'lib', 'godspeed.mjs'), 'export async function openGodspeed() { return { kind: "stand-in", workspace: "/w" }; }\n');
  const before = process.env.FORGE_ADDON_DIR;
  process.env.FORGE_ADDON_DIR = addon;
  try {
    const gs = await ctx.godspeed();
    assert.deepEqual(gs, { kind: 'stand-in', workspace: '/w' });
    assert.equal(await ctx.godspeed(), gs, 'one bridge for every step of the process');
  } finally { if (before === undefined) delete process.env.FORGE_ADDON_DIR; else process.env.FORGE_ADDON_DIR = before; }
}

const skill = fs.readFileSync(path.join(repo, 'skills', 'forge', 'SKILL.md'), 'utf8');

testCase('the forge skill is found by the chat for every request the plan names');
{
  const front = /^---\nname: forge\ndescription: (.+)\n---\n/.exec(skill);
  assert.ok(front, 'frontmatter with name forge and a one-line description');
  for (const phrase of ['plan release', 'plan the next', 'what should go into the next version', '"go"', 'make it public', 'take it back', 'release status', 'where is the release', 'turn on automatic work', 'pause the factory', 'run one lap', 'F7', 'waiting.json', 'set up the Forge']) assert.ok(front[1].includes(phrase), phrase);
  assert.ok(!fs.existsSync(path.join(repo, 'skills', 'forge-setup')), 'the old setup skill is gone, so two skills never answer the same request');
}

testCase('the forge skill tells the chat how to ask the Forge, and carries the planning rules and the plan\'s exact shape');
{
  for (const must of ['.godspeed/forge/waiting.json', '.godspeed/forge/projects/*.json', '.godspeed/forge/inbox/<id>.json', '.godspeed/forge/outbox/<id>.json', 'two minutes', 'exactly as they wrote it',
    'Tell the owner its `say`, and nothing more', 'godspeed-forge setup owner/repository', 'Shall I start it?', 'what is wrong for the', 'what the owner found', 'features', 'Decide every question of how yourself',
    'Nothing is sent to the Forge before the yes', '"kind": "plan"', '"version"', '"summary"', '"items"', '"outcome"', '"size"', '"why"', '"later"', '"handle": "F7"']) assert.ok(skill.includes(must), must);
  for (const kind of ['go', 'take-back', 'status', 'work-on', 'work-off', 'lap', 'answer']) assert.ok(skill.includes(`kind \`${kind}\``), kind);
}

testCase('everything the owner reads from the install, the skill and the inbox is plain: no long dashes, at most one link');
{
  const texts = [skill, ...Object.values(SAY).map(v => (typeof v === 'function' ? v('X') : v)), ...Object.values(STOP).map(v => (typeof v === 'function' ? v('2.0.0-beta.1', '2.0.0-beta.24') : v)), TOOLS_READY, UNITS_READY];
  for (const text of texts) assert.ok(!/[–—]/.test(text), text.slice(0, 80));
  for (const text of texts.slice(1)) assert.ok((text.match(/https?:\/\//g) || []).length <= 1, text);
  assert.ok(!/https?:\/\//.test(skill), 'the skill sends the owner to no address');
}

await rm(root, { recursive: true, force: true });
