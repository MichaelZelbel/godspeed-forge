// The units that run `godspeed-forge inbox` as root: a path unit that starts it as soon as the chat writes a request
// into the inbox folder (its path on this server, also when Godspeed runs in Docker), and a one-minute timer as the
// fallback for a change the path unit missed. The service is a oneshot, so systemd never runs two at once, and the
// inbox's own lock covers a run started by hand.
import nodeFs from 'node:fs';
import path from 'node:path';

export const UNIT = 'godspeed-forge-inbox';
export const UNITS_READY = 'The Forge now answers requests from the chat.';

const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function inboxUnits({ node, forge, inbox }) {
  return {
    [`${UNIT}.service`]: [
      '[Unit]',
      'Description=The Forge: requests from the owner\'s chat',
      '',
      '[Service]',
      'Type=oneshot',
      'Environment=HOME=/root',
      'Environment=LANG=C.UTF-8',
      `Environment=${quote(`FORGE_INBOX=${inbox}`)}`,
      `ExecStart=${quote(node)} ${quote(forge)} inbox`,
      'TimeoutStartSec=20min',
      '',
    ].join('\n'),
    [`${UNIT}.path`]: [
      '[Unit]',
      'Description=The Forge: watch for requests from the owner\'s chat',
      '',
      '[Path]',
      `PathChanged=${inbox}`,
      `Unit=${UNIT}.service`,
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n'),
    [`${UNIT}.timer`]: [
      '[Unit]',
      'Description=The Forge: look for requests from the owner\'s chat every minute',
      '',
      '[Timer]',
      'OnBootSec=1min',
      'OnUnitActiveSec=1min',
      'AccuracySec=10s',
      `Unit=${UNIT}.service`,
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n'),
  };
}

// Writes the units (only those that changed), reloads systemd and starts the path unit and the timer.
// -> { ok: true } or { ok: false, why }.
export async function installInboxUnits({ run, fs = nodeFs, unitsDir = '/etc/systemd/system', node, forge, inbox }) {
  const units = inboxUnits({ node, forge, inbox });
  fs.mkdirSync(unitsDir, { recursive: true });
  for (const [name, text] of Object.entries(units)) {
    const file = path.join(unitsDir, name);
    let old = null;
    try { old = fs.readFileSync(file, 'utf8'); } catch {}
    if (old !== text) fs.writeFileSync(file, text, { mode: 0o644 });
  }
  for (const args of [['daemon-reload'], ['enable', `${UNIT}.path`, `${UNIT}.timer`], ['restart', `${UNIT}.path`, `${UNIT}.timer`]]) {
    const r = await run('systemctl', args, { timeoutMs: 60000 });
    if (r.status !== 0) return { ok: false, why: String(r.stderr || '').trim().split('\n').pop() || `systemctl ${args[0]} failed` };
  }
  return { ok: true };
}
