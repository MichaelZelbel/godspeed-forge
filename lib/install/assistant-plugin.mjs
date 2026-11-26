// The Forge's plugin for the owner's assistant (Hermes): before each turn it shows the model what the Forge waits
// for (assistant-plugin/godspeed-forge), the way Godspeed's coach, journal and headache add-ons show theirs. Without
// it a bare "go" after a ready-to-try message reached nobody: the Forge sends straight to the owner, so the chat had
// not seen the message (found on the first real release, 23 November 2026).
//
// installAssistantPlugin(gs, source, deps) -> 'installed' | 'unchanged' | 'skipped'
//   - finds the assistant's home in <workspace>/.godspeed/assistant.json (a path inside the container on Docker,
//     mapped to the server through the volume that holds the workspace);
//   - writes the plugin's files and workspace.txt (the workspace as the assistant sees it), owned by the workspace's
//     owner, and adds godspeed-forge to plugins.enabled in the assistant's config.yaml;
//   - when anything changed, restarts the assistant's chat so it loads the plugin: on Docker the Godspeed service
//     (docker compose restart), natively `hermes gateway restart`. A restart that fails changes nothing else; the
//     plugin then loads at the chat's next start.
// Nothing here is ever fatal to the install.
import fs from 'node:fs';
import path from 'node:path';
import { run as runProcess } from '../process.mjs';

export const PLUGIN = 'godspeed-forge';
const FILES = ['plugin.yaml', '__init__.py'];

// The assistant's home on this server, or null.
export function assistantHome(gs) {
  let home;
  try { home = JSON.parse(gs.readWorkspaceFile('.godspeed/assistant.json') ?? 'null')?.home; } catch { return null; }
  if (typeof home !== 'string' || !(path.posix.isAbsolute(home) || path.isAbsolute(home))) return null;
  if (gs.kind !== 'docker') return home;
  const inside = gs.docker?.workspace;
  if (typeof inside !== 'string' || !gs.workspace) return null;
  const containerRoot = path.posix.dirname(inside);
  if (!home.startsWith(`${containerRoot}/`)) return null;
  return path.join(path.dirname(gs.workspace), ...home.slice(containerRoot.length + 1).split('/'));
}

// config.yaml with godspeed-forge in plugins.enabled; null when it is already there.
// config.yaml with godspeed-forge in plugins.enabled; null when it is already there or when the list is written in a
// form this does not recognise (then the file is left exactly as it is, never given a second `enabled`).
export function enablePlugin(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex(line => /^plugins:\s*$/.test(line));
  if (start === -1) {
    if (lines.some(line => /^plugins:/.test(line))) return null; // plugins written some other way: leave it
    return `${String(text ?? '').replace(/\n*$/, '\n')}plugins:\n  enabled: ["${PLUGIN}"]\n`;
  }
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || lines[end] === '')) end++;
  const at = lines.slice(start + 1, end).findIndex(line => /^\s+enabled:/.test(line));
  if (at === -1) { lines.splice(start + 1, 0, `  enabled: ["${PLUGIN}"]`); return lines.join('\n'); }
  const i = start + 1 + at;
  const inline = lines[i].match(/^(\s+enabled:\s*)\[(.*)\]\s*(#.*)?$/);
  if (inline) {
    const names = inline[2].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    if (names.includes(PLUGIN)) return null;
    lines[i] = `${inline[1]}[${[...names, PLUGIN].map(n => `"${n}"`).join(', ')}]`;
    return lines.join('\n');
  }
  if (/^\s+enabled:\s*(#.*)?$/.test(lines[i])) {
    // a block list: "  enabled:" then one "    - name" per line
    let j = i + 1;
    const items = [];
    while (j < end && /^\s+-\s/.test(lines[j])) { items.push(lines[j]); j++; }
    if (!items.length) return null;
    if (items.some(line => line.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, '') === PLUGIN)) return null;
    const indent = items[0].match(/^(\s+-\s+)/)[1];
    lines.splice(j, 0, `${indent}${PLUGIN}`);
    return lines.join('\n');
  }
  return null;
}

// Writes the file only when its words change, keeping its owner and its mode (config.yaml can hold keys, 0600).
function writeIfDifferent(file, content, owner) {
  let before = null, mode = null;
  try { before = fs.readFileSync(file, 'utf8'); mode = fs.statSync(file).mode & 0o777; } catch {}
  if (before === content) return false;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: mode ?? 0o644 });
  if (mode !== null) fs.chmodSync(temporary, mode);
  if (owner && typeof owner.uid === 'number') { try { fs.chownSync(temporary, owner.uid, owner.gid); } catch {} }
  fs.renameSync(temporary, file);
  return true;
}

// The account a uid belongs to, from /etc/passwd: { name, home } or null.
function account(uid, passwd = '/etc/passwd') {
  try {
    for (const line of fs.readFileSync(passwd, 'utf8').split('\n')) {
      const [name, , id, , , home] = line.split(':');
      if (Number(id) === uid) return { name, home };
    }
  } catch {}
  return null;
}

export async function installAssistantPlugin(gs, source, { run = runProcess, uid = process.getuid?.(), passwd } = {}) {
  try {
    const home = assistantHome(gs);
    if (!home || !fs.existsSync(home)) return 'skipped';
    const folder = path.join(home, 'plugins', PLUGIN);
    fs.mkdirSync(folder, { recursive: true });
    if (gs.owner && typeof gs.owner.uid === 'number') { try { fs.chownSync(folder, gs.owner.uid, gs.owner.gid); } catch {} }
    let changed = false;
    for (const name of FILES) changed = writeIfDifferent(path.join(folder, name), fs.readFileSync(path.join(source, 'assistant-plugin', PLUGIN, name), 'utf8'), gs.owner) || changed;
    const seen = gs.kind === 'docker' ? gs.docker.workspace : gs.workspace;
    changed = writeIfDifferent(path.join(folder, 'workspace.txt'), `${seen}\n`, gs.owner) || changed;
    const config = path.join(home, 'config.yaml');
    let text = null;
    try { text = fs.readFileSync(config, 'utf8'); } catch {}
    if (text !== null) {
      const enabled = enablePlugin(text);
      if (enabled !== null) changed = writeIfDifferent(config, enabled, gs.owner) || changed;
    }
    if (!changed) return 'unchanged';
    try {
      if (gs.kind === 'docker') {
        await run('docker', ['compose', '-f', gs.docker.compose, '--project-directory', gs.docker.root, 'restart', gs.docker.service ?? 'godspeed']);
      } else {
        // Natively the chat belongs to the workspace's owner: its restart runs as them, never as root, so the
        // assistant.json the owner can write never makes root run anything.
        let executable = 'hermes';
        try { executable = JSON.parse(gs.readWorkspaceFile('.godspeed/assistant.json'))?.executable || 'hermes'; } catch {}
        const ownerUid = typeof gs.owner?.uid === 'number' ? gs.owner.uid : uid;
        if (uid === 0 && ownerUid !== 0) {
          const who = account(ownerUid, passwd);
          if (who) {
            await run('runuser', ['-u', who.name, '--', executable, 'gateway', 'restart'], { env: { ...process.env, HOME: who.home, USER: who.name, LOGNAME: who.name, HERMES_HOME: home, XDG_RUNTIME_DIR: `/run/user/${ownerUid}` } });
          }
        } else {
          await run(executable, ['gateway', 'restart'], { env: { ...process.env, HERMES_HOME: home } });
        }
      }
    } catch { /* the plugin loads at the chat's next start */ }
    return 'installed';
  } catch {
    return 'skipped';
  }
}
