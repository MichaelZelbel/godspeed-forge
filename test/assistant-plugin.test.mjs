// The Forge's plugin for the owner's assistant: it shows the model what the Forge waits for, and the installer puts
// it in place, switches it on and restarts the chat only when something changed, on a native and a Docker Godspeed.
// test cases: 4
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantHome, enablePlugin, installAssistantPlugin, PLUGIN } from '../lib/install/assistant-plugin.mjs';
import { testCase } from './cases.mjs';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = prefix => fs.mkdtempSync(path.join(tmpdir(), prefix));
const CONFIG = 'model:\n  default: x\nplugins:\n  enabled: ["godspeed-coach", "godspeed-journal"]\n\nmcp_servers: {}\n';

function bridge({ kind, workspace, home, inside }) {
  fs.mkdirSync(path.join(workspace, '.godspeed'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.godspeed', 'assistant.json'), JSON.stringify({ verified: true, executable: '/opt/hermes/bin/hermes', home }));
  return {
    kind, workspace, owner: null,
    ...(kind === 'docker' ? { docker: { root: '/opt/install', compose: '/opt/install/compose.yaml', service: 'godspeed', workspace: inside } } : {}),
    readWorkspaceFile: rel => { try { return fs.readFileSync(path.join(workspace, rel), 'utf8'); } catch { return null; } }
  };
}

testCase("the plugin is switched on in the assistant's settings once, keeping every other plugin");
{
  const once = enablePlugin(CONFIG);
  assert.match(once, /enabled: \["godspeed-coach", "godspeed-journal", "godspeed-forge"\]/);
  assert.equal(enablePlugin(once), null, 'already on: nothing to change');
  assert.match(enablePlugin('model:\n  default: x\n'), /plugins:\n {2}enabled: \["godspeed-forge"\]\n$/);
}

testCase('on a native Godspeed the plugin is written beside the others, switched on, and the chat restarted once');
{
  const workspace = tmp('forge-ws-'), home = tmp('forge-hermes-');
  fs.writeFileSync(path.join(home, 'config.yaml'), CONFIG);
  const gs = bridge({ kind: 'native', workspace, home });
  const ran = [];
  const run = async (command, args, options) => { ran.push([command, ...args].join(' ')); assert.equal(options.env.HERMES_HOME, home); return { stdout: '' }; };
  assert.equal(await installAssistantPlugin(gs, SOURCE, { run }), 'installed');
  for (const name of ['plugin.yaml', '__init__.py']) assert.ok(fs.existsSync(path.join(home, 'plugins', PLUGIN, name)), name);
  assert.equal(fs.readFileSync(path.join(home, 'plugins', PLUGIN, 'workspace.txt'), 'utf8'), `${workspace}\n`);
  assert.match(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), /"godspeed-forge"\]/);
  assert.deepEqual(ran, ['/opt/hermes/bin/hermes gateway restart']);
  assert.equal(await installAssistantPlugin(gs, SOURCE, { run }), 'unchanged', 'a second install changes nothing');
  assert.equal(ran.length, 1, 'and restarts nothing');
}

testCase("on a Docker Godspeed the assistant's home is found through the volume, and the Godspeed service is restarted");
{
  const data = tmp('forge-volume-');
  const workspace = path.join(data, 'workspace'), home = path.join(data, 'hermes');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), CONFIG);
  const gs = bridge({ kind: 'docker', workspace, home: '/opt/data/full-candidate/hermes', inside: '/opt/data/full-candidate/workspace' });
  assert.equal(assistantHome(gs), home);
  const ran = [];
  assert.equal(await installAssistantPlugin(gs, SOURCE, { run: async (c, a) => { ran.push([c, ...a].join(' ')); return { stdout: '' }; } }), 'installed');
  assert.equal(fs.readFileSync(path.join(home, 'plugins', PLUGIN, 'workspace.txt'), 'utf8'), '/opt/data/full-candidate/workspace\n', 'the workspace as the assistant sees it');
  assert.deepEqual(ran, ['docker compose -f /opt/install/compose.yaml --project-directory /opt/install restart godspeed']);
  const outside = bridge({ kind: 'docker', workspace: path.join(tmp('forge-other-'), 'workspace'), home: '/somewhere/else', inside: '/opt/data/full-candidate/workspace' });
  assert.equal(await installAssistantPlugin(outside, SOURCE, { run: async () => { throw new Error('never'); } }), 'skipped', 'a home outside the volume is left alone');
}

testCase('before each turn the model reads what waits: a version ready for its go and a question with its handle, and nothing when nothing waits');
{
  const workspace = tmp('forge-plugin-ws-'), folder = tmp('forge-plugin-');
  for (const name of ['plugin.yaml', '__init__.py']) fs.copyFileSync(path.join(SOURCE, 'assistant-plugin', PLUGIN, name), path.join(folder, name));
  fs.writeFileSync(path.join(folder, 'workspace.txt'), `${workspace}\n`);
  fs.mkdirSync(path.join(workspace, '.godspeed', 'forge'), { recursive: true });
  const program = [
    'import importlib.util, json, sys',
    "spec = importlib.util.spec_from_file_location('p', sys.argv[1])",
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'print(json.dumps(m.on_pre_llm_call()))'
  ].join('\n');
  const ask = () => execFileSync('python3', ['-c', program, path.join(folder, '__init__.py')], { encoding: 'utf8' }).trim();
  assert.equal(ask(), 'null', 'no file: nothing');
  fs.writeFileSync(path.join(workspace, '.godspeed', 'forge', 'waiting.json'), JSON.stringify({ items: [
    { handle: 'go', kind: 'staged', project: 'acme/app', text: 'app 1.2.0 is ready to try at https://example.test/r. Reply go to make it public.' },
    { handle: 'F1', kind: 'question', project: 'acme/app', text: 'Should old recipes keep their address?' }
  ] }));
  const context = JSON.parse(ask()).context;
  assert.match(context, /^\[godspeed-forge\] The Forge waits for the owner\./);
  assert.match(context, /app 1\.2\.0 is ready to try .* A reply of just "go" or "make it public" is the go for this version\./);
  assert.match(context, /Question F1: Should old recipes keep their address\? A reply that starts with F1 answers it\./);
  fs.writeFileSync(path.join(workspace, '.godspeed', 'forge', 'waiting.json'), JSON.stringify({ items: [] }));
  assert.equal(ask(), 'null', 'nothing waits: nothing');
}
