// The factory's own setup, which setup finishes after the GitHub Apps and the two mission questions and before the
// final check, so nothing is left for a separate prompt (the steps of "Instructions for the agent" in Cole Medin's
// README at the pinned revision):
//   step 2  the factory's AI: Archon's own settings for the user setup runs as (~/.archon/config.yaml), for the
//           coding assistant found; settings already there are kept.
//   step 3  the coding assistant, run once without questions in the project (a fixed prompt shipped beside this
//           file), proposes seven things the project must never become, writes two to five journeys of what the
//           project does today and the project's checks; the owner strikes the wrong proposals by number; the kept
//           ones go into MISSION.md's out-of-scope list. The holdout scenarios stay Cole Medin's empty template.
//   then    the files the factory's installer wrote and these three are committed and pushed to the default branch
//           with the owner's gh sign-in, or, where GitHub takes changes only through a pull request, opened as one
//           and merged.
// What each part produced is kept in the project's private state (factory-setup.json), so a rerun never asks the
// coding assistant again for what it already wrote, never asks the owner again what they answered, and picks up at
// the part where it stopped.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_FACTORY_MODELS, writePrivateJson } from './config.mjs';
import { files } from './files.mjs';
import { SetupStop } from './setup.mjs';

export const PROGRESS_FILE = 'factory-setup.json';
export const SCRATCH_FILE = '.forge-out-of-scope.json';
export const STRIKE_QUESTION = 'Type the numbers of any that are wrong, separated by spaces, or press Enter to keep all seven:';
export const STRIKE_ANSWER_MESSAGE = 'Setup expects numbers from 1 to 7 here, separated by spaces, so it asks again.';
export const SETUP_BRANCH = 'forge-setup';
export const COMMIT_MESSAGE = 'Set up the AI software factory: what this project must never become, its journeys and its checks';
const PROMPT_FILE = new URL('./factory-setup-prompt.md', import.meta.url);
const JOURNEYS = 'harness/END-TO-END.md';
const HARNESS = 'harness/harness.config.json';
// The installed example journeys, which must be gone (a merge assessor that finds them holds every change).
const EXAMPLE_JOURNEYS = /refill the kalimba humidifier|Example task-service data/;
// What the factory's installer writes into the project, committed with the three files so every lap's fresh checkout
// carries the factory and the guard of the hidden scenarios. Machine-local files stay out through the .gitignore
// lines the installer added.
const INSTALLED_PATHS = ['MISSION.md', 'FACTORY.md', 'FACTORY_RULES.md', 'engineering.md', '.gitignore', '.ignore', '.claude/settings.json', 'factory', 'harness', '.factory'];
// The files that govern the factory and fence the hidden scenarios: the assistant is told to change none of them, and
// whatever it changed there anyway is put back before anything is committed.
const GOVERNING = ['MISSION.md', 'FACTORY.md', 'FACTORY_RULES.md', 'engineering.md', '.claude/settings.json', '.ignore'];
const PROTECTED_REFUSAL = /protected branch|GH006|GH013|repository rule violations|must be made through a pull request|required status check|review required/i;
const BEHIND_REFUSAL = /\[rejected\]|non-fast-forward|fetch first/i;

export const FACTORY_MESSAGES = {
  reading: agentName => `${agentName} is reading the project to propose what it must never become, the journeys its users take today and the checks it runs. This takes a few minutes.`,
  proposals: agentName => `${agentName} proposes these seven things the project must never become:`,
  pushed: repository => `Setup added the project's mission, journeys and checks to ${repository} on GitHub.`,
  models: 'Setup stopped because it could not save which AI models the build tools use in your home folder on this server. Let setup write to your home folder before trying setup again.',
  agentFailed: agentName => `Setup stopped because ${agentName} did not finish reading the project. Try setup again.`,
  noProposals: agentName => `Setup stopped because ${agentName} did not write the seven proposals for what the project must never become. Try setup again, which asks it again.`,
  noJourneys: agentName => `Setup stopped because ${agentName} did not write two to five journeys of what the project does today. Try setup again, which asks it again.`,
  noChecks: agentName => `Setup stopped because ${agentName} did not write the project's checks. Try setup again, which asks it again.`,
  projectFiles: repository => `Setup stopped because it could not read or write the files in the project folder for ${repository} on this server. Let setup read and write the files in that project folder, then try setup again.`,
  progress: 'Setup stopped because it could not save its progress on this server. Let setup write to the folder where the Forge keeps its settings before trying setup again.',
  commit: repository => `Setup stopped because it could not record the project's setup files in the project folder for ${repository} on this server. Try setup again.`,
  push: repository => `Setup stopped because it could not send the project's setup files to ${repository} on GitHub. Restore this server's access to GitHub before trying setup again.`,
  conflict: repository => `Setup stopped because ${repository} on GitHub changed the same files setup writes while it ran. Try setup again.`,
  pullRequestWaiting: (repository, url) => `Setup stopped because ${repository} takes changes only through a pull request that passes its checks, so setup opened one with the project's setup files. Once it is merged, try setup again: ${url}`,
  pullRequestClosed: repository => `Setup stopped because the pull request with the project's setup files for ${repository} was closed without being merged. Try setup again, which opens a new one.`
};

const missing = error => error?.code === 'ENOENT';

async function readText(path) {
  try { return await files.readFile(path, 'utf8'); } catch (error) { if (missing(error)) return null; throw error; }
}

// Writes text through a temporary beside the file and a rename, so a stop never leaves half a file.
async function writeText(path, text, mode) {
  await files.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await files.writeFile(temporary, text, mode ? { mode } : undefined);
    await files.rename(temporary, path);
  } catch (error) {
    await files.unlink(temporary).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------- step 2: the factory's AI
// The Archon settings for the coding assistant found. Archon reads ~/.archon/config.yaml for the user it runs as
// (getting-started/configuration and reference/configuration at the pinned Archon revision): defaultAssistant names the
// provider, and tiers names the model for small, medium and large work. A top-level key the file already has is kept as
// it is; only the missing ones are added, below what is there.
export function archonSettings(agent, models = DEFAULT_FACTORY_MODELS) {
  const tiers = models[agent];
  return {
    defaultAssistant: `defaultAssistant: ${agent}`,
    tiers: ['tiers:', ...['small', 'medium', 'large'].map(size => `  ${size}: { provider: ${agent}, model: ${tiers[size]} }`)].join('\n')
  };
}

// -> the top-level keys it added (none when the file had them all). Throws the file system's error.
export async function configureArchon(agent, { home = homedir(), models } = {}) {
  const path = join(home, '.archon', 'config.yaml');
  const existing = (await readText(path)) ?? '';
  const wanted = archonSettings(agent, models);
  const added = Object.keys(wanted).filter(key => !new RegExp(`^${key}\\s*:`, 'm').test(existing));
  if (added.length === 0) return [];
  const lead = existing === '' ? '' : `${existing.replace(/\s*$/, '')}\n\n`;
  const block = [`# The Forge's setup: the factory's AI for ${agent === 'claude' ? 'Claude Code' : 'Codex'}.`, ...added.map(key => wanted[key])].join('\n');
  await files.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeText(path, `${lead}${block}\n`, 0o600);
  return added;
}

// ---------------------------------------------------------------- step 3: what the coding assistant writes
const oneLine = text => String(text).replace(/\s+/g, ' ').replace(/\s*[–—]\s*/g, ', ').replace(/^[-*\d.)\s]+/, '').trim();

// The seven entries, or null when the scratch file does not hold seven short sentences.
export function readProposals(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  const list = Array.isArray(value) ? value : Array.isArray(value?.entries) ? value.entries : null;
  if (!list || list.length !== 7) return null;
  const entries = list.map(entry => (typeof entry === 'string' ? oneLine(entry) : ''));
  return entries.every(entry => entry.length >= 3 && entry.length <= 300) ? entries : null;
}

export function journeysValid(text) {
  if (typeof text !== 'string' || EXAMPLE_JOURNEYS.test(text)) return false;
  const journeys = text.split('\n').filter(line => /^## \S/.test(line)).length;
  return journeys >= 2 && journeys <= 5;
}

async function workflowFiles(checkout) {
  try {
    return (await files.readdir(join(checkout, '.github', 'workflows'))).filter(name => /\.ya?ml$/.test(name));
  } catch (error) {
    if (missing(error) || error?.code === 'ENOTDIR') return [];
    throw error;
  }
}

// The checks as the assistant wrote them, with protected_paths put back to what the installer wrote. null when the
// file is not a settings object or names no required checks while the project has CI workflows.
export async function checkedHarness(text, before, checkout) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of ['static', 'unit']) if (typeof value[key] !== 'string') value[key] = '';
  if (before && typeof before === 'object' && 'protected_paths' in before) value.protected_paths = before.protected_paths;
  if (typeof value.required_checks !== 'string' || value.required_checks.trim() === '') {
    if ((await workflowFiles(checkout)).length > 0) return null;
    value.required_checks = 'none';
  }
  return value;
}

async function promptText() {
  return files.readFile(PROMPT_FILE, 'utf8');
}

function agentCommand(agent, prompt, models) {
  return agent === 'claude'
    ? ['claude', ['-p', prompt, '--model', models.claude.medium, '--permission-mode', 'acceptEdits', '--output-format', 'text']]
    : ['codex', ['exec', '--sandbox', 'workspace-write', prompt]];
}

async function propose({ repository, checkout, agent, agentName, run, output, models }) {
  const projectFiles = step => step().catch(error => {
    if (typeof error?.code === 'string') throw new SetupStop(FACTORY_MESSAGES.projectFiles(repository), 'factory-files');
    throw error;
  });
  const scratch = join(checkout, SCRATCH_FILE);
  await projectFiles(() => files.rm(scratch, { force: true }));
  const before = await projectFiles(() => readText(join(checkout, HARNESS)));
  let installed = null;
  try { installed = JSON.parse(before); } catch {}
  const governing = [];
  for (const path of GOVERNING) governing.push([path, await projectFiles(() => readText(join(checkout, path)))]);
  output(FACTORY_MESSAGES.reading(agentName));
  const [command, args] = agentCommand(agent, await promptText(), models);
  try {
    await run(command, args, { cwd: checkout });
  } catch {
    throw new SetupStop(FACTORY_MESSAGES.agentFailed(agentName), 'factory-agent');
  }
  for (const [path, text] of governing) {
    if (text !== null && (await projectFiles(() => readText(join(checkout, path)))) !== text) await projectFiles(() => writeText(join(checkout, path), text));
  }
  const proposed = readProposals((await projectFiles(() => readText(scratch))) ?? '');
  await projectFiles(() => files.rm(scratch, { force: true }));
  if (!proposed) throw new SetupStop(FACTORY_MESSAGES.noProposals(agentName), 'factory-proposals');
  const journeys = await projectFiles(() => readText(join(checkout, JOURNEYS)));
  if (!journeysValid(journeys)) throw new SetupStop(FACTORY_MESSAGES.noJourneys(agentName), 'factory-journeys');
  const written = (await projectFiles(() => readText(join(checkout, HARNESS)))) ?? '';
  const harness = await projectFiles(() => checkedHarness(written, installed, checkout));
  if (!harness) throw new SetupStop(FACTORY_MESSAGES.noChecks(agentName), 'factory-checks');
  return { proposed, journeys: journeys.endsWith('\n') ? journeys : `${journeys}\n`, harness };
}

// ---------------------------------------------------------------- the owner strikes the wrong ones
// The numbers in an answer (1 to 7, any order, repeats allowed), or null when it holds anything else.
export function struckNumbers(answer) {
  const words = String(answer).trim().split(/[\s,]+/).filter(Boolean);
  const numbers = words.map(word => (/^[1-7]$/.test(word) ? Number(word) : NaN));
  return numbers.every(Number.isInteger) ? new Set(numbers) : null;
}

async function strike(proposed, { agentName, prompt, output }) {
  output(FACTORY_MESSAGES.proposals(agentName));
  proposed.forEach((entry, index) => output(`${index + 1}. ${entry}`));
  for (;;) {
    const struck = struckNumbers(await prompt(STRIKE_QUESTION));
    if (struck) return proposed.filter((_, index) => !struck.has(index + 1));
    output(STRIKE_ANSWER_MESSAGE);
  }
}

// ---------------------------------------------------------------- MISSION.md's out-of-scope list
// The mission with its out-of-scope section holding exactly the kept entries. The installed template's heading
// ("## Out of scope -- the factory must never build this") and its guidance comment are kept; the placeholder lines
// under them are replaced. A mission without that section gets one, before the project mission setup writes last.
export function withOutOfScope(text, kept) {
  const list = kept.map(entry => `- ${entry}`).join('\n');
  const heading = text.match(/^## Out of scope\b.*$/m);
  if (heading) {
    const start = heading.index + heading[0].length;
    const rest = text.slice(start);
    const next = rest.search(/^## /m);
    const body = next === -1 ? rest : rest.slice(0, next);
    const comment = body.match(/<!--[\s\S]*?-->/)?.[0];
    const section = `\n\n${[comment, list].filter(Boolean).join('\n\n')}\n`;
    return next === -1 ? `${text.slice(0, start)}${section}` : `${text.slice(0, start)}${section}\n${rest.slice(next)}`;
  }
  const section = `## Out of scope: the factory must never build this\n\n${list}\n`;
  const projectMission = text.indexOf('\n## Project mission\n');
  if (projectMission === -1) return `${text.replace(/\s*$/, '')}\n\n${section}`;
  return `${text.slice(0, projectMission).replace(/\s*$/, '')}\n\n${section}${text.slice(projectMission)}`;
}

// ---------------------------------------------------------------- commit and push
function gitIn(run, git, checkout) {
  return args => run(git, args, { cwd: checkout });
}

const failureText = error => `${error?.stderr ?? ''}\n${error?.stdout ?? ''}`;

async function defaultBranch({ git, gh, run, repository }) {
  try {
    const head = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim();
    if (head.startsWith('origin/') && head.length > 7) return head.slice(7);
  } catch {}
  try {
    const name = (await run(gh, ['repo', 'view', repository, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])).stdout.trim();
    if (/^[A-Za-z0-9._/-]+$/.test(name)) return name;
  } catch {}
  return null;
}

// The identity a commit (and a rebase) carries when git on this server has none: the GitHub account gh is signed in as.
async function identity({ git, gh, run }) {
  try {
    if ((await git(['config', 'user.email'])).stdout.trim()) return [];
  } catch {}
  try {
    const [login, id] = (await run(gh, ['api', 'user', '--jq', '.login + " " + (.id|tostring)'])).stdout.trim().split(/\s+/);
    if (login && /^\d+$/.test(id ?? '')) return ['-c', `user.name=${login}`, '-c', `user.email=${id}+${login}@users.noreply.github.com`];
  } catch {}
  return ['-c', 'user.name=Forge setup', '-c', 'user.email=forge-setup@users.noreply.github.com'];
}

// Records the setup files in a commit; false when there was nothing new to record (a rerun after the commit).
async function commit({ git, who, checkout, repository }) {
  const present = [];
  for (const path of INSTALLED_PATHS) {
    try {
      await files.access(join(checkout, path));
      present.push(path);
    } catch (error) {
      if (!missing(error)) throw new SetupStop(FACTORY_MESSAGES.projectFiles(repository), 'factory-files');
    }
  }
  try {
    await git(['add', '-A', '--', ...present]);
    if ((await git(['diff', '--cached', '--name-only'])).stdout.trim() === '') return false;
    await git([...who, 'commit', '-q', '-m', COMMIT_MESSAGE]);
    return true;
  } catch {
    throw new SetupStop(FACTORY_MESSAGES.commit(repository), 'factory-commit');
  }
}

async function merged({ run, gh, url }) {
  return (await run(gh, ['pr', 'view', url, '--json', 'state', '--jq', '.state'])).stdout.trim();
}

// Merges the pull request when GitHub lets it; otherwise asks GitHub to merge it once its checks pass. true when merged.
async function mergePullRequest({ run, gh, url, repository }) {
  for (const method of ['--squash', '--merge', '--rebase']) {
    try {
      await run(gh, ['pr', 'merge', url, '--repo', repository, method, '--delete-branch']);
      return true;
    } catch (error) {
      if (!/not allowed|merge method|is not enabled/i.test(failureText(error))) break;
    }
  }
  await run(gh, ['pr', 'merge', url, '--repo', repository, '--squash', '--auto']).catch(() => {});
  return false;
}

async function openPullRequest({ git, run, gh, repository, branch }) {
  await git(['push', '--force', 'origin', `HEAD:refs/heads/${SETUP_BRANCH}`]);
  try {
    const open = (await run(gh, ['pr', 'list', '--repo', repository, '--head', SETUP_BRANCH, '--state', 'open', '--json', 'url', '--jq', '.[0].url'])).stdout.trim();
    if (open.startsWith('https://')) return open;
  } catch {}
  const body = 'The Forge\'s setup: the files of the AI software factory, what this project must never become (MISSION.md), the journeys its users take today (harness/END-TO-END.md) and its checks (harness/harness.config.json).';
  const created = (await run(gh, ['pr', 'create', '--repo', repository, '--base', branch, '--head', SETUP_BRANCH, '--title', COMMIT_MESSAGE, '--body', body])).stdout;
  const url = created.match(/https:\/\/\S+/)?.[0];
  if (!url) throw new Error('GitHub did not answer with the pull request.');
  return url;
}

// After a merged pull request the local branch takes GitHub's commit, which holds the same files.
async function followMerge({ git, branch }) {
  try {
    await git(['fetch', '-q', 'origin', branch]);
    await git(['reset', '-q', '--keep', `origin/${branch}`]);
  } catch {}
}

// Sends the commit to the default branch. Returns { pushed: true } or { pr: url } when it waits as a pull request.
async function push(context) {
  const { git, who, repository } = context;
  const branch = await defaultBranch(context);
  if (!branch) throw new SetupStop(FACTORY_MESSAGES.push(repository), 'factory-push');
  const toDefault = () => git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  try {
    await toDefault();
    return { pushed: true };
  } catch (error) {
    let refusal = failureText(error);
    if (!PROTECTED_REFUSAL.test(refusal) && BEHIND_REFUSAL.test(refusal)) {
      try {
        await git([...who, 'pull', '-q', '--rebase', 'origin', branch]);
      } catch {
        await git(['rebase', '--abort']).catch(() => {});
        throw new SetupStop(FACTORY_MESSAGES.conflict(repository), 'factory-push');
      }
      try {
        await toDefault();
        return { pushed: true };
      } catch (again) {
        refusal = failureText(again);
      }
    }
    if (!PROTECTED_REFUSAL.test(refusal)) throw new SetupStop(FACTORY_MESSAGES.push(repository), 'factory-push');
  }
  // GitHub takes changes to the default branch only through a pull request.
  let url;
  try {
    url = await openPullRequest({ ...context, branch });
  } catch {
    throw new SetupStop(FACTORY_MESSAGES.push(repository), 'factory-push');
  }
  return { pr: url, branch };
}

// ---------------------------------------------------------------- the step
async function readProgress(path) {
  const text = await readText(path).catch(() => { throw new SetupStop(FACTORY_MESSAGES.progress, 'factory-progress'); });
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {}; // a damaged record holds nothing setup cannot make again
  }
}

// context: what setupRepository hands over ({ repository, checkout, agent, agentName, stateDirectory, commands,
// prompt, output, config }); home: the folder of the user setup runs as.
export async function finishFactory(context, { home = homedir() } = {}) {
  const { repository, checkout, agent, agentName, stateDirectory, commands, prompt, output, config = {} } = context;
  const run = commands.run;
  const names = commands.names ?? {};
  const gh = names.gh ?? 'gh';
  const models = { ...DEFAULT_FACTORY_MODELS, ...(config.factoryModels ?? {}) };
  const progressPath = join(stateDirectory, PROGRESS_FILE);
  const save = value => writePrivateJson(progressPath, value).catch(() => { throw new SetupStop(FACTORY_MESSAGES.progress, 'factory-progress'); });

  try {
    await configureArchon(agent, { home, models });
  } catch (error) {
    if (typeof error?.code === 'string') throw new SetupStop(FACTORY_MESSAGES.models, 'factory-models');
    throw error;
  }

  let progress = await readProgress(progressPath);
  if (progress.pushed === true) return;
  if (!progress.proposed) {
    progress = { ...(await propose({ repository, checkout, agent, agentName, run, output, models })) };
    await save(progress);
  }
  if (!Array.isArray(progress.kept)) {
    progress = { ...progress, kept: await strike(progress.proposed, { agentName, prompt, output }) };
    await save(progress);
  }

  const git = gitIn(run, names.git ?? 'git', checkout);
  const pushContext = { git, gh, run, repository, checkout };
  if (progress.pr) {
    let state;
    try { state = await merged({ run, gh, url: progress.pr }); } catch { throw new SetupStop(FACTORY_MESSAGES.push(repository), 'factory-push'); }
    if (state === 'OPEN' && await mergePullRequest({ run, gh, url: progress.pr, repository })) state = 'MERGED';
    if (state === 'MERGED') {
      await followMerge({ git, branch: (await defaultBranch(pushContext)) ?? 'main' });
      await save({ ...progress, pushed: true });
      output(FACTORY_MESSAGES.pushed(repository));
      return;
    }
    if (state === 'OPEN') throw new SetupStop(FACTORY_MESSAGES.pullRequestWaiting(repository, progress.pr), 'factory-pull-request');
    const { pr, ...rest } = progress;
    await save(rest);
    throw new SetupStop(FACTORY_MESSAGES.pullRequestClosed(repository), 'factory-pull-request');
  }

  const write = async (path, text) => {
    try { await writeText(join(checkout, path), text); } catch (error) {
      if (typeof error?.code === 'string') throw new SetupStop(FACTORY_MESSAGES.projectFiles(repository), 'factory-files');
      throw error;
    }
  };
  await write(JOURNEYS, progress.journeys);
  await write(HARNESS, `${JSON.stringify(progress.harness, null, 2)}\n`);
  let mission;
  try { mission = await files.readFile(join(checkout, 'MISSION.md'), 'utf8'); } catch {
    throw new SetupStop(FACTORY_MESSAGES.projectFiles(repository), 'factory-files');
  }
  await write('MISSION.md', withOutOfScope(mission, progress.kept));

  pushContext.who = await identity(pushContext);
  await commit(pushContext);
  const sent = await push(pushContext);
  if (sent.pushed) {
    await save({ ...progress, pushed: true });
    output(FACTORY_MESSAGES.pushed(repository));
    return;
  }
  await save({ ...progress, pr: sent.pr });
  if (await mergePullRequest({ run, gh, url: sent.pr, repository })) {
    await followMerge({ git, branch: sent.branch });
    await save({ ...progress, pr: sent.pr, pushed: true });
    output(FACTORY_MESSAGES.pushed(repository));
    return;
  }
  throw new SetupStop(FACTORY_MESSAGES.pullRequestWaiting(repository, sent.pr), 'factory-pull-request');
}

// The step as setup takes it (options.factorySetup).
export function createFactorySetup({ home = homedir() } = {}) {
  return context => finishFactory(context, { home });
}
