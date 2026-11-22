// Everything the factory needs on the server itself, installed when it is missing: git, GitHub's `gh`, Python 3.10 or
// newer with venv, Node 22 with npm, bun, uv, Claude Code and Codex. Each from its maker's own source: Ubuntu's packages,
// GitHub's and NodeSource's apt repositories, and the official installers of Bun, uv and Claude Code; Codex with npm.
// Only as root on a server with apt (Ubuntu, Debian). Each install is said in one plain line; what the commands print
// goes to the install log, and its last lines are shown only when an install fails.
import { appendFileSync } from 'node:fs';

const KEYRINGS = 'install -d -m 0755 /etc/apt/keyrings';
// A new server may still be installing its own updates: apt waits up to ten minutes for them instead of failing.
const APT = 'apt-get -o DPkg::Lock::Timeout=600';
export const TOOLS = [
  {
    key: 'basics', name: 'the basic tools the others need',
    present: 'command -v curl && command -v gpg && command -v unzip && test -d /etc/ssl/certs',
    install: `${APT} install -y -qq ca-certificates curl gnupg unzip`,
    apt: true,
  },
  { key: 'git', name: 'Git', present: 'command -v git', install: `${APT} install -y -qq git`, apt: true },
  {
    key: 'gh', name: "GitHub's command line tool", present: 'command -v gh',
    install: [
      KEYRINGS,
      'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg',
      'chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
      `${APT} update -qq`,
      `${APT} install -y -qq gh`,
    ].join('\n'),
  },
  {
    key: 'python', name: 'Python 3.10 or newer with virtual environments',
    present: 'python3 -c "import sys, venv, ensurepip; sys.exit(0 if sys.version_info >= (3, 10) else 1)"',
    install: `${APT} install -y -qq python3 python3-venv`,
    apt: true,
  },
  {
    key: 'node', name: 'Node.js 22',
    present: 'node -e "process.exit(Number(process.versions.node.split(\'.\')[0]) >= 22 ? 0 : 1)" && command -v npm',
    install: [
      KEYRINGS,
      'curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg',
      'chmod go+r /etc/apt/keyrings/nodesource.gpg',
      'echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list',
      `${APT} update -qq`,
      `${APT} install -y -qq nodejs`,
    ].join('\n'),
  },
  {
    key: 'bun', name: 'Bun', present: 'command -v bun',
    install: [
      'curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local/lib/bun bash',
      'ln -sf /usr/local/lib/bun/bin/bun /usr/local/bin/bun',
    ].join('\n'),
  },
  {
    key: 'uv', name: 'uv', present: 'command -v uv',
    install: 'curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh',
  },
  {
    key: 'claude', name: 'Claude Code', present: 'command -v claude',
    install: 'test -x "$HOME/.local/bin/claude" || curl -fsSL https://claude.ai/install.sh | bash',
    // Its installer puts it in ~/.local/bin, which a service or a plain shell does not search.
    after: 'command -v claude >/dev/null || ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude',
  },
  { key: 'codex', name: 'Codex', present: 'command -v codex', install: 'npm install -g --no-fund --no-audit @openai/codex' },
];

export const TOOLS_READY = 'The server has everything the factory needs.';
export const noApt = names => `This server has no apt, so the Forge could not install ${names.join(', ')}. Install ${names.length === 1 ? 'it' : 'them'}, then run this line again.`;
export const toolFailed = (name, reason) => `${name.charAt(0).toUpperCase()}${name.slice(1)} could not be installed${reason ? `: ${reason}` : ''}. Put that right, then run this line again.`;

// -> { ok: true } or { ok: false, stop: the plain sentence }. `run(command, args, options)` never throws (lib/godspeed.mjs
// runCommand); `log` is the install log's path, or null.
export async function installServerTools({ run, say = () => {}, log = null, env = process.env } = {}) {
  const shellEnv = { ...env, DEBIAN_FRONTEND: 'noninteractive', PATH: `/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin${env.PATH ? `:${env.PATH}` : ''}` };
  const sh = (script, timeoutMs = 15 * 60000) => run('bash', ['-c', `set -eu\n${script}`], { env: shellEnv, timeoutMs });
  const record = (what, r) => {
    if (!log) return;
    try { appendFileSync(log, `--- ${new Date().toISOString()} ${what} (exit ${r.status})\n${r.stdout || ''}${r.stderr || ''}\n`); } catch {}
  };
  const reason = r => String(`${r.stderr || ''}\n${r.stdout || ''}`).split('\n').map(l => l.trim()).filter(Boolean).filter(l => !/^(#|\+ )/.test(l)).slice(-1)[0] || '';

  const missing = [];
  for (const tool of TOOLS) if ((await sh(tool.present, 60000)).status !== 0) missing.push(tool);
  if (!missing.length) { say(TOOLS_READY); return { ok: true }; }
  if ((await sh('command -v apt-get', 60000)).status !== 0) {
    say(noApt(missing.filter(t => t.key !== 'basics').map(t => t.name)));
    return { ok: true };
  }
  let updated = false;
  for (const tool of missing) {
    // Installing one may have brought another (Node's packages need curl and gpg, which the basics bring first).
    if (tool.key !== 'basics' && (await sh(tool.present, 60000)).status === 0) continue;
    say(`Installing ${tool.name}.`);
    if (tool.apt && !updated) {
      const u = await sh(`${APT} update -qq`);
      record(`${APT} update`, u);
      if (u.status !== 0) return { ok: false, stop: toolFailed(tool.name, reason(u)) };
      updated = true;
    }
    const r = await sh(tool.after ? `${tool.install}\n${tool.after}` : tool.install);
    record(tool.name, r);
    if (r.status !== 0) return { ok: false, stop: toolFailed(tool.name, reason(r)) };
    const check = await sh(tool.present, 60000);
    if (check.status !== 0) return { ok: false, stop: toolFailed(tool.name, 'it was installed but still cannot be found') };
  }
  say(TOOLS_READY);
  return { ok: true };
}
