// The sign-ins setup needs before it downloads anything: GitHub's gh with access to the repository and the
// permission to change workflow files, and Claude Code or Codex. A sign-in that already works is reused and
// nothing is asked. A missing one runs that tool's own sign-in for a server without a browser and relays its
// link and code in one plain sentence; the code Claude Code's page shows is read through setup's own question
// and handed to it, never printed. Each stop says what happened and what to do; trying setup again checks again.
//
// Verified 2026-11-22 against gh 2.105.0, Claude Code 2.1.330 and Codex 0.171.0 on Ubuntu 24.04 without a browser:
//   gh auth login --hostname github.com --git-protocol https --web --scopes workflow
//       with its output piped prints "! First copy your one-time code: XXXX-XXXX" and "Open this URL to continue
//       in your web browser: https://github.com/login/device", then waits for the approval; gh auth setup-git after it.
//   claude auth login       prints "If the browser didn't open, visit:", the page's address and "Paste code here if
//                           prompted >", and reads the code from its input. claude auth status exits 1 when signed out.
//   codex login --device-auth   prints https://auth.openai.com/codex/device and a one-time code, then waits.
//                           codex login status exits 1 when signed out. OpenAI's documentation: a personal account
//                           first turns device code sign-in on in its ChatGPT security settings.
import { findSignedInAgent } from './agent.mjs';
import { SetupStop } from './setup.mjs';

export const AGENT_QUESTION = 'Which coding assistant do you use: type claude for Claude Code or codex for Codex:';
export const AGENT_ANSWER_MESSAGE = 'Setup expects claude or codex here, so it asks again.';
export const CODE_QUESTION = 'Paste the code here:';
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' };
const STATUS = { claude: ['auth', 'status'], codex: ['login', 'status'] };
export const GITHUB_LOGIN = ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'workflow'];
const LOGIN = { claude: ['auth', 'login'], codex: ['login', '--device-auth'] };

export const SIGN_IN_MESSAGES = {
  githubLink: (link, code) => `To sign this server in to GitHub, open ${link} in your browser and enter the code ${code}. Setup goes on by itself once GitHub has accepted it.`,
  claudeLink: link => `To sign this server in to Claude Code, open this page in your browser, sign in, and copy the code it shows: ${link}`,
  codexLink: (link, code) => `To sign this server in to Codex, open ${link} in your browser, sign in and enter the code ${code}. If the page does not take the code, first turn on device code sign-in in your ChatGPT security settings. Setup goes on by itself once you are signed in.`,
  noGh: 'Setup stopped because GitHub\'s command line program gh is not installed on this server. Install gh before trying setup again.',
  githubUnreachable: 'Setup stopped because it could not reach GitHub to check this server\'s GitHub sign-in. Restore this server\'s access to GitHub before trying setup again.',
  githubNotStarted: 'Setup stopped because GitHub\'s sign-in did not show its code. Try setup again.',
  githubNotCompleted: 'Setup stopped because the GitHub sign-in was not completed. Try setup again and enter the code it shows on the GitHub page.',
  githubSignedOut: 'Setup stopped because this server is still not signed in to GitHub after the sign-in. Try setup again and approve the sign-in on the GitHub page.',
  noWorkflow: 'Setup stopped because this server\'s GitHub sign-in may not change workflow files, which the build tools need. Try setup again and approve that permission on the GitHub page.',
  noAccess: repository => `Setup stopped because GitHub did not let this server download ${repository}: either it does not exist or this server's GitHub sign-in cannot reach it. Check the repository name, or sign in with a GitHub account that can reach ${repository}, before trying setup again.`,
  agentMissing: agent => `Setup stopped because ${AGENT_NAMES[agent]} is not installed on this server. Install ${AGENT_NAMES[agent]} before trying setup again.`,
  agentNotStarted: agent => `Setup stopped because the ${AGENT_NAMES[agent]} sign-in did not show its page. Try setup again.`,
  agentNotCompleted: agent => `Setup stopped because the ${AGENT_NAMES[agent]} sign-in was not completed. Try setup again and finish signing in on the page it shows.`
};

// How long a sign-in may take to show its link and code before setup gives up on it.
const SHOW_WITHIN_MS = 60_000;
const plainText = text => String(text).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

// Resolves with what find returns from the command's output once it returns something, or null when the command
// ends or the time is up first.
function waitFor(handle, find, ms = SHOW_WITHIN_MS) {
  return new Promise(resolve => {
    let settled = false;
    let unwatch = () => {};
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unwatch();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), ms);
    timer.unref?.();
    unwatch = handle.watch(text => { const found = find(plainText(text)); if (found) finish(found); }) ?? (() => {});
    handle.done.then(result => finish(find(plainText(result.output ?? '')) ?? null));
  });
}

// 'ok', 'signed-out', 'no-access' (GitHub refused or does not know the repository), 'no-workflow' (the sign-in lacks
// the workflow permission), 'unreachable', or 'no-gh' when gh could not start. A sign-in that does not report its
// permissions (a fine-grained token) is taken as it is.
export async function githubAccess(repository, { run, gh = 'gh' }) {
  let result;
  try {
    result = await run(gh, ['api', '-i', `repos/${repository}`]);
  } catch (error) {
    if (!error || !('stderr' in error)) return 'no-gh';
    const text = `${error.stderr ?? ''}\n${error.stdout ?? ''}`;
    if (/gh auth login|HTTP 401|Bad credentials|not logged in/i.test(text)) return 'signed-out';
    if (/HTTP 40[34]|Not Found|Could not resolve to a Repository/i.test(text)) return 'no-access';
    return 'unreachable';
  }
  const scopes = String(result?.stdout ?? '').match(/^x-oauth-scopes:[ \t]*(.*)$/im);
  if (scopes && !scopes[1].split(',').map(scope => scope.trim()).includes('workflow')) return 'no-workflow';
  return 'ok';
}

async function githubSignIn({ start, output, gh }) {
  const handle = start(gh, GITHUB_LOGIN);
  try {
    const shown = await waitFor(handle, text => {
      const code = text.match(/one-time code:\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/i)?.[1];
      const link = text.match(/https:\/\/github\.com\/login\/device\b/)?.[0];
      return code && link ? { code, link } : null;
    });
    if (!shown) {
      handle.stop();
      const result = await handle.done;
      throw new SetupStop(result.started ? SIGN_IN_MESSAGES.githubNotStarted : SIGN_IN_MESSAGES.noGh, 'github-sign-in');
    }
    output(SIGN_IN_MESSAGES.githubLink(shown.link, shown.code));
    const result = await handle.done;
    if (result.code !== 0) throw new SetupStop(SIGN_IN_MESSAGES.githubNotCompleted, 'github-sign-in');
  } finally {
    handle.stop();
  }
}

// Makes sure gh can reach the repository with the workflow permission, signing in when it cannot, and lets git use
// that sign-in for pushes. Throws a SetupStop when it cannot.
export async function ensureGithubSignIn(repository, { run, start, output, gh = 'gh' }) {
  let access = await githubAccess(repository, { run, gh });
  if (access === 'no-gh') throw new SetupStop(SIGN_IN_MESSAGES.noGh, 'github-sign-in');
  if (access === 'unreachable') throw new SetupStop(SIGN_IN_MESSAGES.githubUnreachable, 'github-sign-in');
  if (access !== 'ok') {
    await githubSignIn({ start, output, gh });
    access = await githubAccess(repository, { run, gh });
    if (access === 'no-access') throw new SetupStop(SIGN_IN_MESSAGES.noAccess(repository), 'github-sign-in');
    if (access === 'no-workflow') throw new SetupStop(SIGN_IN_MESSAGES.noWorkflow, 'github-sign-in');
    if (access === 'signed-out') throw new SetupStop(SIGN_IN_MESSAGES.githubSignedOut, 'github-sign-in');
    if (access !== 'ok') throw new SetupStop(SIGN_IN_MESSAGES.githubUnreachable, 'github-sign-in');
  }
  await letGitUseGh({ run, gh });
}

// git pushes with gh's sign-in (gh auth setup-git); a failure here shows as the push's own stop later.
async function letGitUseGh({ run, gh }) {
  try { await run(gh, ['auth', 'setup-git']); } catch {}
}

async function signedIn(agent, run) {
  try { await run(agent, STATUS[agent]); return true; } catch { return false; }
}

async function chooseAgent(prompt, output) {
  for (;;) {
    const answer = String(await prompt(AGENT_QUESTION)).trim().toLowerCase();
    if (answer === 'claude' || answer === 'codex') return answer;
    output(AGENT_ANSWER_MESSAGE);
  }
}

async function agentSignIn(agent, { start, prompt, promptSecret, output }) {
  const handle = start(agent, LOGIN[agent]);
  try {
    const shown = await waitFor(handle, agent === 'claude'
      ? text => { const link = text.match(/https:\/\/\S+/)?.[0]; return link && /paste code/i.test(text) ? { link } : null; }
      : text => {
        const link = text.match(/https:\/\/\S+/)?.[0];
        const code = text.match(/one-time code[^\n]*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/i)?.[1];
        return link && code ? { link, code } : null;
      });
    if (!shown) {
      handle.stop();
      const result = await handle.done;
      throw new SetupStop(result.started ? SIGN_IN_MESSAGES.agentNotStarted(agent) : SIGN_IN_MESSAGES.agentMissing(agent), 'agent-sign-in');
    }
    if (agent === 'claude') {
      output(SIGN_IN_MESSAGES.claudeLink(shown.link));
      // Read without showing it at a terminal, handed only to the sign-in, never written anywhere else.
      const code = String(await (promptSecret ?? prompt)(CODE_QUESTION)).trim();
      handle.write(`${code}\n`);
    } else {
      output(SIGN_IN_MESSAGES.codexLink(shown.link, shown.code));
    }
    await handle.done;
  } finally {
    handle.stop();
  }
}

// 'claude' or 'codex': the coding assistant signed in on this server, Claude Code first when both are. With neither,
// the owner picks one and signs in with its own sign-in; setup then checks again. Throws a SetupStop when it cannot.
export async function ensureAgentSignIn({ run, start, prompt, promptSecret, output }) {
  const found = await findSignedInAgent(run);
  if (found) return found;
  const agent = await chooseAgent(prompt, output);
  await agentSignIn(agent, { start, prompt, promptSecret, output });
  if (await signedIn(agent, run)) return agent;
  throw new SetupStop(SIGN_IN_MESSAGES.agentNotCompleted(agent), 'agent-sign-in');
}

// The sign-in step setup runs before it downloads anything: GitHub first, then the coding assistant. Returns the
// assistant ('claude' or 'codex').
export async function signIn({ repository, run, start, prompt, promptSecret, output, gh = 'gh' }) {
  await ensureGithubSignIn(repository, { run, start, output, gh });
  return ensureAgentSignIn({ run, start, prompt, promptSecret, output });
}
