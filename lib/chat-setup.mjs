// Setup from the chat. The terminal command runs setup (lib/setup.mjs) with a readline; the chat cannot wait inside one
// request, so a worker (`godspeed-forge setup-chat owner/repository`, started by lib/owner/setup.mjs) runs the same
// setup with the adapters made here, and the chat's `setup` requests talk to it through two small files in the Forge's
// private state, each written by one side only:
//   <state>/chat-setup/<owner>--<repo>.json         the worker's: { repository, workerPid, status, log, ask }
//     status 'running' | 'asking' | 'done' | 'stopped'; log the plain sentences said so far; ask the question the worker
//     waits on, { n, kind, text }, kind 'continue' (only the word continue answers it) or 'text'
//   <state>/chat-setup/<owner>--<repo>.reply.json   the chat's: { delivered, answer }, delivered how many log entries the
//     owner has been told, answer { n, text } the owner's words for the ask numbered n
// The files hold what the chat is told anyway (links, the GitHub and Codex one-time codes, the owner's own words). The
// Claude Code sign-in code, a GitHub App's code and keys, and every token never reach them.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppStepError, registrationAction } from './github-apps.mjs';
import { startCallback } from './chat-callback.mjs';
import { createGithubAdapter, manifestPage, ORGANIZATION_ANSWER_MESSAGE } from './github-adapter.mjs';
import { ensureGithubSignIn, ensureAgentSignIn } from './signin.mjs';
import { SetupStop } from './setup.mjs';
import { STRIKE_QUESTION } from './factory-setup.mjs';
import { readRecord, addressOf } from './watch.mjs';
import { SAY as WATCH_SAY } from './owner/watch.mjs';
import { run as runProcess, start as startProcess } from './process.mjs';

export const CHAT_SETUP_MESSAGES = {
  claudeStep: "Claude Code has one step that cannot happen in this chat, because the code it shows must never be typed here. Open your server's terminal, logged in as root, and type claude auth login. Finish signing in on the page it opens, copy the code into the terminal, and then say \"continue\" here. Do not paste the code in this chat.",
  claudeCode: 'That looks like more than the word continue, so nothing was kept. Never paste the sign-in code here: type it in the server\'s terminal. When you are done there, say "continue".',
  needsPage: "Setup stopped because the page that gives this chat a way back from GitHub needs updating. Type godspeed-forge watch in your server's terminal, logged in as root, then say the setup request here again.",
  nobodyAnswered: repository => `Setup stopped because nobody answered for a day. Say "set up the Forge for ${repository}" again and it carries on from where it stopped.`,
  strikeQuestion: 'Type the numbers of any that are wrong, separated by spaces, or say "keep all" to keep all seven:',
  closing: 'Setup is finished. If you no longer have the page\'s password, it is shown again in the server\'s terminal.'
};

const DAY_MS = 24 * 3600 * 1000;
const APP_WAIT_MS = 30 * 60000;

export function chatSetupFiles(paths, repository) {
  const dir = join(paths.state, 'chat-setup');
  const slug = repository.replace('/', '--').toLowerCase();
  return { dir, session: join(dir, `${slug}.json`), reply: join(dir, `${slug}.reply.json`) };
}

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// One whole file at a time, so the other side never reads half of it.
export function saveJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

// The worker's side of the two files. ask() waits for the owner's words; it ends the setup by a stop after a day.
export function openSession(paths, repository, { pollMs = 500, answerWithinMs = DAY_MS } = {}) {
  const files = chatSetupFiles(paths, repository);
  const state = { repository, workerPid: process.pid, status: 'running', log: [], ask: null };
  const save = () => saveJson(files.session, state);
  let counter = 0;
  save();
  return {
    state,
    say(text) { state.log.push(text); save(); },
    async ask(kind, text) {
      state.log.push(text);
      state.ask = { n: ++counter, kind, text };
      state.status = 'asking';
      save();
      const until = Date.now() + answerWithinMs;
      for (;;) {
        const answer = readJson(files.reply)?.answer;
        if (answer?.n === state.ask.n && typeof answer.text === 'string') {
          state.ask = null;
          state.status = 'running';
          save();
          return answer.text;
        }
        if (Date.now() > until) throw new SetupStop(CHAT_SETUP_MESSAGES.nobodyAnswered(repository), 'chat-timeout');
        await sleep(pollMs);
      }
    },
    finish(status) { state.status = status; state.ask = null; save(); }
  };
}

// The first paragraph of the README's section called Who ... or Users ..., when it has one.
function readmeUsers(readme) {
  const section = readme.match(/^#{1,4}[ \t]+(?:who|users?|audience)\b.*\n+([^#][^\n]*(?:\n[^#\n][^\n]*)*)/im);
  return section?.[1].replace(/\s+/g, ' ').trim() || null;
}

const firstParagraph = readme => readme.split(/\n\s*\n/).map(part => part.trim()).find(part => part && !part.startsWith('#') && !part.startsWith('![') && !part.startsWith('<'))?.replace(/\s+/g, ' ');

// What the project says about itself: the repository's GitHub description (else its README's first paragraph) for what it
// is for, and the README's own section on who it is for. Only what is found is returned; nothing is made up.
export async function draftMission({ repository, checkout, run, gh = 'gh', readme = path => readFileSync(path, 'utf8') }) {
  let description = '';
  try { description = String((await run(gh, ['repo', 'view', repository, '--json', 'description', '--jq', '.description'])).stdout ?? '').trim(); } catch {}
  let text = '';
  for (const name of ['README.md', 'readme.md', 'README']) {
    try { text = readme(join(checkout, name)); break; } catch {}
  }
  const purpose = description || firstParagraph(text) || null;
  const users = readmeUsers(text);
  return { ...(purpose && { purpose }), ...(users && { users }) };
}

// The chat's GitHub adapter: the terminal one's checks and exchange, with the pages reached through the watch page's
// address and the App's code delivered to the listener, and the install confirmed by asking GitHub instead of the owner.
function chatGithub({ session, getListener, run, gh, base, sleepMs = 5000, appWaitMs = APP_WAIT_MS }) {
  const ownerIsOrganization = async owner => {
    try { return String((await run(gh, ['api', `users/${owner}`, '--jq', '.type'])).stdout).trim() === 'Organization'; } catch {}
    for (;;) {
      const answer = (await session.ask('text', `Type yes if ${owner} is a GitHub organization, or no if it is your personal account:`)).trim().toLowerCase();
      if (answer === 'yes' || answer === 'no') return answer === 'yes';
      session.say(ORGANIZATION_ANSWER_MESSAGE);
    }
  };
  return {
    ...base,
    async begin(manifest, { kind }) {
      const owner = new URL(manifest.url).pathname.split('/')[1];
      const action = registrationAction(owner, await ownerIsOrganization(owner));
      const listener = getListener();
      listener.setPage(kind, manifestPage(action, { ...manifest, redirect_url: listener.doneUrl(kind) }));
      return { url: listener.pageUrl(kind), kind };
    },
    async callback({ kind }) {
      const code = await getListener().waitFor(kind, appWaitMs);
      if (!code) throw new AppStepError('page', 'The GitHub page for creating the App was not finished.');
      return code;
    },
    async install({ credentials, repository, kind }) {
      if (!credentials.slug) throw new Error(`GitHub did not return the ${kind} App name needed for installation.`);
      session.say(`Install the ${kind} App and choose only ${repository}: https://github.com/apps/${encodeURIComponent(credentials.slug)}/installations/new`);
      let lastError = null;
      for (let waited = 0; waited <= appWaitMs; waited += sleepMs) {
        try {
          if (await base.appStatus({ credentials, repository }) === 'installed') return true;
          lastError = null;
        } catch (error) { lastError = error; }
        await sleep(sleepMs);
      }
      if (lastError) throw new Error(`GitHub could not say whether the ${kind} App is installed: ${lastError.message}`);
      return false;
    }
  };
}

// setupCommand's options for a chat setup: -> { options, close }. deps are the seams a test replaces.
export function createChatSetup({ repository, paths, session, deps = {} }) {
  const run = deps.run ?? runProcess;
  const start = deps.start ?? startProcess;
  let listener = null;
  const probe = deps.probe ?? (async url => (await fetch(url)).ok);
  // The terminal asks to "press Enter" to keep every entry; the chat cannot send an empty answer, so it asks in words.
  const prompt = async text => {
    if (text !== STRIKE_QUESTION) return session.ask('text', text);
    const answer = await session.ask('text', CHAT_SETUP_MESSAGES.strikeQuestion);
    return /^\s*(keep(\s+all)?|none|no|all)\s*[.!]?\s*$/i.test(answer) ? '' : answer;
  };
  const signIn = async context => {
    const record = readRecord(paths);
    if (!record?.callbackPort) throw new SetupStop(CHAT_SETUP_MESSAGES.needsPage, 'callback');
    listener = await (deps.startCallback ?? startCallback)({ port: record.callbackPort, origin: addressOf(record) });
    if (!await probe(listener.pingUrl).catch(() => false)) throw new SetupStop(CHAT_SETUP_MESSAGES.needsPage, 'callback');
    await ensureGithubSignIn(repository, { run: context.run, start, output: context.output, gh: context.gh });
    return ensureAgentSignIn({ ...context, start, claudeStep: () => session.ask('continue', CHAT_SETUP_MESSAGES.claudeStep) });
  };
  const options = {
    paths, commands: { run }, prompt, promptSecret: prompt, output: text => session.say(text), signIn,
    draftMission: ({ repository: name, checkout }) => draftMission({ repository: name, checkout, run }),
    github: chatGithub({ session, getListener: () => listener, run, gh: 'gh', base: createGithubAdapter({ input: null }), ...deps.github }),
    afterSetup: async (name, config, result) => {
      try {
        await deps.afterSetup?.(name, config, result);
        const record = readRecord(paths);
        if (record) session.say(WATCH_SAY.here(addressOf(record), record.user));
      } finally { session.finish('done'); }
    }
  };
  return { options, close: async () => { await listener?.close(); } };
}
