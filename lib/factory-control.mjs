// The chat's three words for the factory itself, as inbox handlers: "run one lap" (lap), "turn on automatic work"
// (workOn) and "pause the factory" (workOff). Each is async (request, ctx) => ({ ok, say }), with
// request = { id, kind, project, words, at } and ctx = { gs, config, paths, now, log }; say is the owner's plain words.
//
// They run Cole Medin's own commands in the project's checkout (README "Commands" at the pinned revision):
//   lap      python factory/consumer.py run archon-loop --input merge=approve --detach --json
//            consumer.py adds the inputs the factory supplies itself (the holdout file and the project's
//            protected_paths) unless they are named, so only merge=approve is given: the change waits for the
//            owner's approval on GitHub. As root on Linux with systemd the lap starts in a transient unit of its own
//            that does not kill what it leaves running: the request handler's own unit ends when the handler does, and
//            Archon's detached run would otherwise end with it.
//   workOn   .factory/schedule.json (archon-loop, merge auto, one lap at a time), schedule install --apply, unpause.
//            On Linux the timer is a systemd user timer of the user setup ran as, which needs that user's lingering
//            on (README "The timer on Linux"), so it is turned on first.
//   workOff  pause: the timer starts no new lap and keeps waking the ones already running, so they finish.
// The project is found among the repositories setup finished on this server (its registration records in the Forge's
// private state); a request that names no project is for every one of them, each answered in its own sentence. The
// commands run as the user setup ran as: the owner of the project's checkout.
import { join } from 'node:path';
import { files } from './files.mjs';
import { run as runProcess } from './process.mjs';

export const SCHEDULE = '.factory/schedule.json';
export const LAP_ARGS = ['factory/consumer.py', 'run', 'archon-loop', '--input', 'merge=approve', '--detach', '--json'];

export const CONTROL_MESSAGES = {
  lapStarted: repository => `One lap has started on ${repository}: the factory is picking one piece of work and making the change. When the change is ready, it waits for your approval on GitHub before anything is merged.`,
  lapFailed: repository => `One lap could not be started on ${repository}, because the factory refused to start. Try "run one lap" again in a few minutes; if it refuses again, run godspeed-forge setup ${repository} in the server's terminal, which checks the factory.`,
  workOn: repository => `Automatic work is on for ${repository}. Every five minutes the factory looks for work, makes one change at a time and merges each change that passes its checks. Say "pause the factory" to stop it starting new work.`,
  workOnFailed: repository => `Automatic work could not be turned on for ${repository}, because this server would not start the factory's timer. Try "turn on automatic work" again; if it fails again, run godspeed-forge setup ${repository} in the server's terminal, which checks the factory.`,
  workOff: repository => `The factory is paused for ${repository}: it starts no new work, and a change it is already making is finished. Say "turn on automatic work" to start it again.`,
  workOffFailed: repository => `The factory could not be paused for ${repository}. Try "pause the factory" again in a minute.`,
  noProject: 'No project is set up with the Forge on this server yet. Set one up first with godspeed-forge setup owner/repository in the server\'s terminal.',
  unknownProject: (name, known) => `The Forge has no project called "${name}" on this server. ${listed(known)}`,
  whichProject: known => `Which project do you mean? ${listed(known)}`
};

function listed(known) {
  if (known.length === 1) return `The one it has is ${known[0]}.`;
  return `The ones it has are ${known.slice(0, -1).join(', ')} and ${known.at(-1)}.`;
}

// Every repository setup finished on this server: [{ repository, checkout }], sorted by name.
export async function registeredProjects(stateRoot) {
  const found = [];
  const projects = join(stateRoot, 'projects');
  let owners = [];
  try { owners = await files.readdir(projects); } catch { return found; }
  for (const owner of owners) {
    let names = [];
    try { names = await files.readdir(join(projects, owner)); } catch { continue; }
    for (const name of names) {
      try {
        const record = JSON.parse(await files.readFile(join(projects, owner, name, 'registration.json'), 'utf8'));
        if (record?.completed === true && typeof record.checkout === 'string' && record.repository === `${owner}/${name}`) {
          found.push({ repository: record.repository, checkout: record.checkout });
        }
      } catch {}
    }
  }
  return found.sort((a, b) => a.repository.localeCompare(b.repository));
}

// { project } or { say } naming what exists when the words name none or several. A request without a project name
// means the only project there is (projectsFor makes such a request one for every project).
export function findProject(name, projects) {
  if (projects.length === 0) return { say: CONTROL_MESSAGES.noProject };
  const known = projects.map(p => p.repository);
  const wanted = String(name ?? '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
  if (!wanted) return projects.length === 1 ? { project: projects[0] } : { say: CONTROL_MESSAGES.whichProject(known) };
  const exact = projects.filter(p => p.repository.toLowerCase() === wanted);
  const matches = exact.length ? exact : projects.filter(p => p.repository.split('/')[1].toLowerCase() === wanted);
  if (matches.length === 1) return { project: matches[0] };
  if (matches.length === 0) return { say: CONTROL_MESSAGES.unknownProject(String(name).trim(), known) };
  return { say: CONTROL_MESSAGES.whichProject(matches.map(p => p.repository)) };
}

// The account that owns the checkout (the user setup ran as): { name, uid, gid, home } from the passwd file, or null.
export async function checkoutOwner(checkout, { passwd = '/etc/passwd' } = {}) {
  let uid;
  try { uid = (await files.stat(checkout)).uid; } catch { return null; }
  try {
    for (const line of (await files.readFile(passwd, 'utf8')).split('\n')) {
      const [name, , id, gid, , home] = line.split(':');
      if (name && Number(id) === uid) return { name, uid, gid: Number(gid), home };
    }
  } catch {}
  return null;
}

// The environment the factory's commands get: the owner's home and the folders their tools live in (bun, uv and
// claude sit under the home, and the timer captures this PATH), and the user manager of systemd for the timer.
export function commandEnvironment(owner, base = process.env) {
  const home = owner?.home || base.HOME || '/root';
  const path = [`${home}/.local/bin`, `${home}/.bun/bin`, `${home}/.cargo/bin`, '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', ...(base.PATH ?? '').split(':')]
    .filter((dir, index, all) => dir && all.indexOf(dir) === index).join(':');
  const env = { ...base, HOME: home, PATH: path, IS_SANDBOX: '1' };
  if (owner && Number.isInteger(owner.uid)) {
    env.XDG_RUNTIME_DIR = `/run/user/${owner.uid}`;
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${owner.uid}/bus`;
    if (owner.name) { env.USER = owner.name; env.LOGNAME = owner.name; }
  }
  return env;
}

const realDeps = {
  run: runProcess,
  platform: process.platform,
  uid: () => process.getuid?.(),
  systemd: () => files.access('/run/systemd/system').then(() => true, () => false),
  owner: checkoutOwner
};

// The projects a request is for: the one it names, or every project set up with the Forge when it names none.
// { projects } or { say } naming what exists.
export async function projectsFor(request, ctx) {
  const projects = await registeredProjects(ctx.paths.state);
  if (String(request?.project ?? '').trim() === '') return projects.length ? { projects } : { say: CONTROL_MESSAGES.noProject };
  const found = findProject(request.project, projects);
  return found.say ? { say: found.say } : { projects: [found.project] };
}

// The user setup ran as for a project, and how to run the factory's own command for it.
async function prepare({ repository, checkout }, ctx, D) {
  const owner = await D.owner(checkout);
  const python = ctx.config?.commands?.python ?? 'python3';
  const env = commandEnvironment(owner, D.env ?? process.env);
  // As the checkout's owner when this process is root and they are someone else.
  const asOwner = (command, args) => (D.uid() === 0 && owner && owner.uid !== 0 && owner.name
    ? ['runuser', ['-u', owner.name, '--', command, ...args]] : [command, args]);
  const factory = args => {
    const [command, argv] = asOwner(python, ['factory/consumer.py', ...args]);
    return D.run(command, argv, { cwd: checkout, env });
  };
  return { repository, checkout, owner, env, python, factory };
}

// Runs one handler for each project the request is for; its answer is theirs, each in its own sentence.
async function forEachProject(request, ctx, deps, one) {
  const D = { ...realDeps, ...deps };
  const target = await projectsFor(request, ctx);
  if (target.say) return { ok: false, say: target.say };
  const answers = [];
  for (const project of target.projects) answers.push(await one(await prepare(project, ctx, D), request, ctx, D));
  return { ok: answers.every(answer => answer.ok), say: answers.map(answer => answer.say).join(' ') };
}

function logFailure(ctx, what, error) {
  const text = String(error?.stderr || error?.message || error).trim().split('\n').pop() ?? '';
  ctx.log?.(`${what}: ${text.slice(0, 300)}`);
}

export function lap(request, ctx, deps = {}) {
  return forEachProject(request, ctx, deps, lapOne);
}

async function lapOne(p, request, ctx, D) {
  try {
    if (D.platform === 'linux' && D.uid() === 0 && await D.systemd()) {
      const at = Date.parse(request?.at ?? '') || (typeof ctx.now === 'function' ? ctx.now() : Date.now());
      const unit = `forge-lap-${p.repository.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${at}`;
      await D.run('systemd-run', [
        '--quiet', '--collect', '--wait', '--pipe', `--unit=${unit}`, '-p', 'KillMode=process', `--working-directory=${p.checkout}`,
        ...(p.owner && p.owner.uid !== 0 ? [`--uid=${p.owner.uid}`, `--gid=${p.owner.gid}`] : []),
        ...['HOME', 'PATH', 'IS_SANDBOX', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].filter(key => p.env[key]).map(key => `--setenv=${key}=${p.env[key]}`),
        p.python, ...LAP_ARGS
      ], { cwd: p.checkout, env: p.env });
    } else {
      await p.factory(LAP_ARGS.slice(1));
    }
  } catch (error) {
    logFailure(ctx, `lap on ${p.repository}`, error);
    return { ok: false, say: CONTROL_MESSAGES.lapFailed(p.repository) };
  }
  return { ok: true, say: CONTROL_MESSAGES.lapStarted(p.repository) };
}

// The schedule the timer starts: archon-loop, merging what passes, one lap at a time. Inputs and keys already in
// the file stay, apart from those three.
export function scheduleFor(existing) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const inputs = base.inputs && typeof base.inputs === 'object' && !Array.isArray(base.inputs) ? base.inputs : {};
  return { ...base, workflow: 'archon-loop', parallel: 1, inputs: { ...inputs, merge: 'auto' } };
}

export function workOn(request, ctx, deps = {}) {
  return forEachProject(request, ctx, deps, workOnOne);
}

async function workOnOne(p, request, ctx, D) {
  try {
    const path = join(p.checkout, SCHEDULE);
    let existing = null;
    try { existing = JSON.parse(await files.readFile(path, 'utf8')); } catch {}
    const temporary = `${path}.${process.pid}.tmp`;
    await files.mkdir(join(p.checkout, '.factory'), { recursive: true });
    await files.writeFile(temporary, `${JSON.stringify(scheduleFor(existing), null, 2)}\n`);
    await files.rename(temporary, path);
    if (D.platform === 'linux' && await D.systemd()) {
      // Root may turn lingering on for anyone; another user may be refused it for their own account, and then the
      // timer runs while they are logged in.
      const linger = D.run('loginctl', ['enable-linger', p.owner?.name ?? String(D.uid())], { env: p.env });
      if (D.uid() === 0) await linger; else await linger.catch(() => {});
    }
    await p.factory(['schedule', 'install', '--apply']);
    if (D.platform === 'linux' && await D.systemd()) await keepRunsAlive(p, D);
    await p.factory(['unpause']);
    await files.rm(join(p.checkout, OWNER_PAUSE_FILE), { force: true }).catch(() => {});
  } catch (error) {
    logFailure(ctx, `automatic work on ${p.repository}`, error);
    return { ok: false, say: CONTROL_MESSAGES.workOnFailed(p.repository) };
  }
  return { ok: true, say: CONTROL_MESSAGES.workOn(p.repository) };
}

// The factory's timer service (Cole Medin's template) is a oneshot: when `schedule fire` ends, systemd stops every process
// it started, the lap it just launched included, which then stays pending forever and holds the factory's only slot.
// That is what happened on the first real server (23 November 2026). A drop-in beside his unit, never a change to it,
// keeps the lap running after the trigger ends, the way a lap started from the chat already runs (KillMode=process).
export const KEEP_RUNS_DROPIN = 'forge-keep-runs.conf';
export async function keepRunsAlive(p, D) {
  const home = p.env?.HOME;
  if (!home) return;
  const units = join(home, '.config', 'systemd', 'user');
  let names = [];
  try { names = (await files.readdir(units)).filter(n => /^archonfactory-.*\.service$/.test(n)); } catch { return; }
  let wrote = false;
  for (const name of names) {
    let text = '';
    try { text = await files.readFile(join(units, name), 'utf8'); } catch { continue; }
    const lines = text.split('\n').map(line => line.trim());
    // only the timer's trigger unit of this project: its folder, and `schedule fire` as what it runs
    if (!lines.includes(`WorkingDirectory=${p.checkout}`) || !lines.some(line => line.startsWith('ExecStart=') && /consumer\.py schedule fire\b/.test(line))) continue;
    const folder = join(units, `${name}.d`);
    await files.mkdir(folder, { recursive: true });
    await files.writeFile(join(folder, KEEP_RUNS_DROPIN), '[Service]\n# The Forge: the lap this trigger starts keeps running after the trigger ends.\nKillMode=process\n');
    wrote = true;
  }
  if (!wrote) return;
  const [command, argv] = D.uid() === 0 && p.owner && p.owner.uid !== 0 && p.owner.name
    ? ['runuser', ['-u', p.owner.name, '--', 'systemctl', '--user', 'daemon-reload']] : ['systemctl', ['--user', 'daemon-reload']];
  await D.run(command, argv, { env: p.env });
}

export function workOff(request, ctx, deps = {}) {
  return forEachProject(request, ctx, deps, workOffOne);
}

// The one pause a program of the Forge may leave in the factory's folder: the owner asked for it in the chat. The file made here comes
// BEFORE the pause, so the driver never sees an unmarked PAUSE of his; it is his pause (reminded daily, never lifted) while the file is
// there, and "turn on automatic work" removes both. A PAUSE or STOP without it is somebody else's and the driver raises it.
export const OWNER_PAUSE_FILE = join('.factory', 'owner-pause');
// Once the PAUSE exists, the file names it (its mtime): it is his pause only while that same PAUSE is there.
async function sealOwnersPause(checkout, request) {
  let at;
  try { at = (await files.stat(join(checkout, '.factory', 'PAUSE'))).mtimeMs; } catch { return; }
  await files.writeFile(join(checkout, OWNER_PAUSE_FILE), `Asked by the owner in the chat: ${String(request?.id ?? 'a request')}.\npause-mtime: ${Math.floor(at)}\n`);
}
async function announceOwnersPause(checkout, request) {
  await files.mkdir(join(checkout, '.factory'), { recursive: true });
  await files.writeFile(join(checkout, OWNER_PAUSE_FILE), `Asked by the owner in the chat: ${String(request?.id ?? 'a request')}.\n`);
}

async function workOffOne(p, request, ctx, D) {
  const previous = await files.readFile(join(p.checkout, OWNER_PAUSE_FILE), 'utf8').catch(() => null);
  try {
    await announceOwnersPause(p.checkout, request);
    await p.factory(['pause']);
    await sealOwnersPause(p.checkout, request);
  } catch (error) {
    // a refused request puts back what was there: an earlier pause of his keeps its file, otherwise none is left
    if (previous !== null) await files.writeFile(join(p.checkout, OWNER_PAUSE_FILE), previous).catch(() => {});
    else await files.rm(join(p.checkout, OWNER_PAUSE_FILE), { force: true }).catch(() => {});
    logFailure(ctx, `pause on ${p.repository}`, error);
    return { ok: false, say: CONTROL_MESSAGES.workOffFailed(p.repository) };
  }
  return { ok: true, say: CONTROL_MESSAGES.workOff(p.repository) };
}
