// "Set up the Forge for owner/repository" in the chat, and every short reply while that setup waits. A request cannot wait for
// the owner, so setup runs as a worker (`godspeed-forge setup-chat`, lib/chat-setup-command.mjs) and each request here
// only talks to it through the files in lib/chat-setup.mjs: it hands over the owner's words when the worker asks something,
// starts the worker when none runs (also to pick an interrupted setup up again; setup resumes from what it saved), waits a
// while for what the worker has to say, and answers with everything the owner has not yet been told.
//
// ctx: the inbox's { paths, now, log, gs }. ctx.startWorker(repository) and ctx.timing stand in for the real worker and
// waits in a test.
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chatSetupFiles, CHAT_SETUP_MESSAGES, readJson, saveJson } from '../chat-setup.mjs';
import { isRepositoryName } from '../setup.mjs';
import { FORGE_FOLDER } from '../godspeed.mjs';

export const MARKER = `${FORGE_FOLDER}/setup.json`;
export const SAY = {
  noProject: 'Tell me which GitHub project to set up, as owner/repository.',
  other: repository => `The Forge is already setting up ${repository}. Finish that one first, or say how it is going.`,
  working: 'Setup is still working on a step that takes a while. Ask "how is setup going" in a few minutes.',
  cannotStart: 'The Forge could not start setup on this server. Type godspeed-forge setup owner/repository in your server\'s terminal, logged in as root, with your GitHub project in place of owner/repository.',
  nothingNew: 'Setup is waiting for your answer.'
};
const TIMING = { pollMs: 500, maxMs: 90000, quietMs: 3000 };

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// The worker as its own process, outliving the inbox run that starts it: a systemd unit of its own where this server has
// systemd and root, otherwise a detached process.
async function startWorker(repository, ctx) {
  const unit = `forge-setup-${repository.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`;
  const program = ctx.executable ?? process.argv[1];
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    const env = ['HOME', 'PATH'].filter(key => process.env[key]).map(key => `--setenv=${key}=${process.env[key]}`);
    const child = spawn('systemd-run', ['--quiet', '--collect', `--unit=${unit}`, '-p', 'KillMode=process', ...env, process.execPath, program, 'setup-chat', repository], { stdio: 'ignore' });
    const code = await new Promise(resolve => { child.once('error', () => resolve(1)); child.once('exit', resolve); });
    if (code === 0) return;
  }
  spawn(process.execPath, [program, 'setup-chat', repository], { detached: true, stdio: 'ignore' }).unref();
}

export async function setup(request, ctx) {
  const timing = { ...TIMING, ...ctx.timing };
  const repository = typeof request.project === 'string' ? request.project.trim() : '';
  if (!isRepositoryName(repository)) return { ok: false, say: SAY.noProject };
  const files = chatSetupFiles(ctx.paths, repository);
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  const mark = open => ctx.gs?.writeWorkspaceFile && (open
    ? ctx.gs.writeWorkspaceFile(MARKER, `${JSON.stringify({ repository, awaiting: true })}\n`)
    : rmSync(ctx.gs.workspacePath(MARKER), { force: true }));

  const open = readdirSync(files.dir).filter(name => name.endsWith('.json') && !name.endsWith('.reply.json')).map(name => readJson(`${files.dir}/${name}`))
    .find(other => other?.repository && other.repository.toLowerCase() !== repository.toLowerCase() && other.status !== 'done' && other.status !== 'stopped' && alive(other.workerPid));
  if (open) return { ok: false, say: SAY.other(open.repository) };

  let session = readJson(files.session);
  const reply = () => readJson(files.reply) ?? { delivered: 0, answer: null };
  const running = () => session && session.status !== 'done' && session.status !== 'stopped' && alive(session.workerPid);

  // The owner's words answer the question the worker waits on.
  const words = typeof request.words === 'string' ? request.words.trim() : '';
  let answered = null;
  if (session?.ask && running() && words) {
    if (session.ask.kind === 'continue' && !/^continue\W*$/i.test(words)) {
      return { ok: true, say: CHAT_SETUP_MESSAGES.claudeCode };
    }
    answered = session.ask.n;
    saveJson(files.reply, { ...reply(), answer: { n: answered, text: session.ask.kind === 'continue' ? 'continue' : words } });
  }

  // A worker that is gone with everything told starts over; setup picks up from what it saved.
  const untold = () => (session?.log.length ?? 0) > reply().delivered;
  if (!running() && !untold()) {
    for (const file of [files.session, files.reply]) rmSync(file, { force: true });
    try { await (ctx.startWorker ?? (name => startWorker(name, ctx)))(repository); } catch { return { ok: false, say: SAY.cannotStart }; }
    session = null;
  }

  // Wait until the worker asks, ends, or has said something and gone quiet.
  let seen = reply().delivered, changed = Date.now();
  const started = Date.now();
  for (;;) {
    session = readJson(files.session);
    const length = session?.log.length ?? 0;
    if (length !== seen) { seen = length; changed = Date.now(); }
    const told = reply().delivered;
    const finished = session && (session.status === 'done' || session.status === 'stopped' || !alive(session.workerPid));
    if (session && ((session.ask && session.ask.n !== answered) || finished || (length > told && Date.now() - changed >= timing.quietMs))) break;
    if (Date.now() - started >= timing.maxMs) break;
    await sleep(timing.pollMs);
  }

  if (!session) return { ok: false, say: SAY.cannotStart };
  const told = reply().delivered;
  const news = (session?.log ?? []).slice(told);
  saveJson(files.reply, { ...reply(), delivered: session.log.length });
  const finished = session.status === 'done' || session.status === 'stopped';
  const gone = !finished && !alive(session.workerPid);
  mark(!finished && !gone);
  if (news.length) return { ok: true, say: news.join('\n\n') };
  if (session?.ask && session.ask.n !== answered) return { ok: true, say: session.ask.text };
  if (finished) return { ok: session.status === 'done', say: session.status === 'done' ? CHAT_SETUP_MESSAGES.closing : SAY.cannotStart };
  if (gone) return { ok: false, say: SAY.cannotStart };
  return { ok: true, say: SAY.working };
}
