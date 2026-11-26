// The factory's own setup, which setup finishes after the GitHub Apps and the two mission questions and before the
// final check, so nothing is left for a separate prompt (the steps of "Instructions for the agent" in Cole Medin's
// README at the pinned revision):
//   step 2  the factory's AI: Archon's own settings for the user setup runs as (~/.archon/config.yaml), for the
//           coding assistant found; settings already there are kept.
//   step 3  the coding assistant, run once without questions in the project (a fixed prompt shipped beside this
//           file), proposes seven things the project must never become, writes two to five journeys of what the
//           project does today and the project's checks; the owner strikes the wrong proposals by number; the kept
//           ones go into MISSION.md's out-of-scope list. The holdout scenarios stay Cole Medin's empty template.
//   then    the owner is shown what will be added (the kept proposals, the journeys, the checks and the factory's own
//           files) and says yes or no; on yes the files the factory's installer wrote and these three are committed and
//           pushed to the default branch with the owner's gh sign-in, or, where GitHub takes changes only through a pull
//           request, pushed to a new branch of their own and opened and merged as one.
// The coding assistant may write only the journeys and the checks. Every other file and folder that governs the
// factory is copied before it runs and put back byte for byte after it ends, whatever its exit, and anything new it
// made there is removed; only the files known before it ran, the two it may write and MISSION.md as setup writes it
// are ever committed.
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
export const CONFIRM_QUESTION = repository => `Type yes to add these to ${repository} on GitHub, or no to stop here:`;
export const CONFIRM_ANSWER_MESSAGE = 'Setup expects yes or no here, so it asks again.';
// The branch a pull request of setup's files comes from: forge-setup-<year month day hour minute, UTC>, with -2, -3
// and so on when a branch of that name is already on GitHub. A branch that is there is never pushed to.
export const SETUP_BRANCH = 'forge-setup';
export const COMMIT_MESSAGE = 'Set up the AI software factory: what this project must never become, its journeys and its checks';
const PROMPT_FILE = new URL('./factory-setup-prompt.md', import.meta.url);
const JOURNEYS = 'harness/END-TO-END.md';
const HARNESS = 'harness/harness.config.json';
// The installed example journeys, which must be gone (a merge assessor that finds them holds every change).
const EXAMPLE_JOURNEYS = /refill the kalimba humidifier|Example task-service data/;
// What the factory's installer writes into the project and what governs the factory and fences the hidden scenarios.
// Before the coding assistant runs, every file and folder here is copied; after it ends it is put back. What existed
// here then is what gets committed with the three files, so every lap's fresh checkout carries the factory and the
// guard of the hidden scenarios. Machine-local files stay out through the .gitignore lines the installer added.
const GUARDED_FILES = ['MISSION.md', 'FACTORY.md', 'FACTORY_RULES.md', 'engineering.md', '.claude/settings.json', '.ignore', '.gitignore'];
const GUARDED_FOLDERS = ['.factory', 'factory', 'harness'];
// The two files the coding assistant writes.
const AGENT_MAY_WRITE = new Set([JOURNEYS, HARNESS]);
const PROTECTED_REFUSAL = /protected branch|GH006|GH013|repository rule violations|must be made through a pull request|required status check|review required/i;
const BEHIND_REFUSAL = /\[rejected\]|non-fast-forward|fetch first/i;

export const FACTORY_MESSAGES = {
  reading: agentName => `${agentName} is reading the project to propose what it must never become, the journeys its users take today and the checks it runs. This takes a few minutes.`,
  proposals: agentName => `${agentName} proposes these seven things the project must never become:`,
  pushed: repository => `Setup added the project's mission, journeys and checks to ${repository} on GitHub.`,
  willAdd: repository => `Setup will add this to ${repository} on GitHub:`,
  keptLine: count => (count === 1 ? 'The 1 thing the project must never become that you kept.' : `The ${count} things the project must never become that you kept.`),
  journeysLine: 'These journeys of what the project does today:',
  otherFiles: 'The project\'s checks, and the files the build tools need to work.',
  declined: repository => `Setup stopped because you chose not to add these to ${repository} yet, so nothing was sent to GitHub. Try setup again when you want to add them; it asks again.`,
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

const absent = error => missing(error) || error?.code === 'ENOTDIR';

// What the guarded paths hold before the coding assistant runs: Map of relative path -> { kind: 'dir' } |
// { kind: 'file', bytes, mode } | { kind: 'allowed' } for the two files it may write | { kind: 'other' } (a link or
// anything else, left as it is).
export async function guardSnapshot(checkout) {
  const entries = new Map();
  const take = async rel => {
    let info;
    try { info = await files.lstat(join(checkout, rel)); } catch (error) { if (absent(error)) return; throw error; }
    if (info.isDirectory()) {
      entries.set(rel, { kind: 'dir' });
      for (const name of [...await files.readdir(join(checkout, rel))].sort()) await take(`${rel}/${name}`);
    } else if (AGENT_MAY_WRITE.has(rel)) {
      entries.set(rel, { kind: 'allowed' });
    } else if (info.isFile()) {
      entries.set(rel, { kind: 'file', bytes: await files.readFile(join(checkout, rel)), mode: info.mode & 0o777 });
    } else {
      entries.set(rel, { kind: 'other' });
    }
  };
  for (const rel of [...GUARDED_FILES, ...GUARDED_FOLDERS]) await take(rel);
  return entries;
}

// Puts the guarded paths back as the snapshot holds them: what is new there is removed (apart from the two files the
// assistant may write), and every file that is missing or differs is written back with its bytes and mode.
export async function guardRestore(checkout, entries) {
  const remove = rel => files.rm(join(checkout, rel), { recursive: true, force: true });
  const sweep = async rel => {
    let info;
    try { info = await files.lstat(join(checkout, rel)); } catch (error) { if (absent(error)) return; throw error; }
    const before = entries.get(rel);
    if (!before) { if (!AGENT_MAY_WRITE.has(rel)) await remove(rel); return; }
    if (before.kind === 'dir') {
      if (!info.isDirectory()) { await remove(rel); return; }
      for (const name of await files.readdir(join(checkout, rel))) await sweep(`${rel}/${name}`);
      return;
    }
    if (before.kind === 'file' && !info.isFile()) await remove(rel);
  };
  for (const rel of [...GUARDED_FILES, ...GUARDED_FOLDERS]) await sweep(rel);
  for (const [rel, before] of entries) {
    if (before.kind === 'dir') { await files.mkdir(join(checkout, rel), { recursive: true }); continue; }
    if (before.kind !== 'file') continue;
    let now = null;
    let mode = null;
    try {
      mode = (await files.lstat(join(checkout, rel))).mode & 0o777;
      now = await files.readFile(join(checkout, rel));
    } catch (error) { if (!absent(error)) throw error; }
    if (now === null || !now.equals(before.bytes) || mode !== before.mode) await writeText(join(checkout, rel), before.bytes, before.mode);
  }
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
  const guarded = await projectFiles(() => guardSnapshot(checkout));
  output(FACTORY_MESSAGES.reading(agentName));
  const [command, args] = agentCommand(agent, await promptText(), models);
  let finished = true;
  try {
    await run(command, args, { cwd: checkout });
  } catch {
    finished = false;
  } finally {
    await projectFiles(() => guardRestore(checkout, guarded));
  }
  if (!finished) throw new SetupStop(FACTORY_MESSAGES.agentFailed(agentName), 'factory-agent');
  const proposed = readProposals((await projectFiles(() => readText(scratch))) ?? '');
  await projectFiles(() => files.rm(scratch, { force: true }));
  if (!proposed) throw new SetupStop(FACTORY_MESSAGES.noProposals(agentName), 'factory-proposals');
  const journeys = await projectFiles(() => readText(join(checkout, JOURNEYS)));
  if (!journeysValid(journeys)) throw new SetupStop(FACTORY_MESSAGES.noJourneys(agentName), 'factory-journeys');
  const written = (await projectFiles(() => readText(join(checkout, HARNESS)))) ?? '';
  const harness = await projectFiles(() => checkedHarness(written, installed, checkout));
  if (!harness) throw new SetupStop(FACTORY_MESSAGES.noChecks(agentName), 'factory-checks');
  // What may be committed: the files the guarded paths held before the assistant ran, the two it writes, and MISSION.md.
  const known = [...guarded].filter(([, entry]) => entry.kind === 'file' || entry.kind === 'allowed').map(([rel]) => rel);
  const stage = [...new Set([...known, 'MISSION.md', JOURNEYS, HARNESS])].sort();
  return { proposed, journeys: journeys.endsWith('\n') ? journeys : `${journeys}\n`, harness, stage };
}

// ---------------------------------------------------------------- the owner says yes before anything is sent
// The journeys' own headings, in order.
export const journeyTitles = journeys => journeys.split('\n').filter(line => /^## \S/.test(line)).map(line => line.slice(3).trim());

async function confirm(progress, { repository, prompt, output }) {
  output(FACTORY_MESSAGES.willAdd(repository));
  output(FACTORY_MESSAGES.keptLine(progress.kept.length));
  output(FACTORY_MESSAGES.journeysLine);
  journeyTitles(progress.journeys).forEach((title, index) => output(`${index + 1}. ${title}`));
  output(FACTORY_MESSAGES.otherFiles);
  for (;;) {
    const answer = String(await prompt(CONFIRM_QUESTION(repository))).trim().toLowerCase();
    if (answer === 'yes') return true;
    if (answer === 'no') return false;
    output(CONFIRM_ANSWER_MESSAGE);
  }
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

// Records the setup files in a commit; false when there was nothing new to record (a rerun after the commit). Only the
// files in stage are added: those known before the coding assistant ran, the two it writes and MISSION.md; files the
// .gitignore lines leave out stay out.
async function commit({ git, who, repository, stage }) {
  try {
    const changed = (await git(['ls-files', '-z', '--others', '--modified', '--deleted', '--exclude-standard', '--', ...stage])).stdout.split('\0').filter(Boolean);
    if (changed.length > 0) await git(['add', '-A', '--', ...new Set(changed)]);
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

// A branch name that GitHub does not have yet: forge-setup-<UTC minute>, then -2, -3 and so on.
export async function freshBranch({ git, now }) {
  const stamp = new Date(now()).toISOString().replace(/[-:T]/g, '').slice(0, 12);
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const name = `${SETUP_BRANCH}-${stamp}${attempt === 1 ? '' : `-${attempt}`}`;
    if ((await git(['ls-remote', '--heads', 'origin', `refs/heads/${name}`])).stdout.trim() === '') return name;
  }
  throw new Error('Every branch name setup tried is taken on GitHub.');
}

async function openPullRequest({ git, run, gh, repository, branch, now }) {
  const head = await freshBranch({ git, now });
  await git(['push', 'origin', `HEAD:refs/heads/${head}`]);
  const body = 'The Forge\'s setup: the files of the AI software factory, what this project must never become (MISSION.md), the journeys its users take today (harness/END-TO-END.md) and its checks (harness/harness.config.json).';
  const created = (await run(gh, ['pr', 'create', '--repo', repository, '--base', branch, '--head', head, '--title', COMMIT_MESSAGE, '--body', body])).stdout;
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
export async function finishFactory(context, { home = homedir(), now = () => Date.now() } = {}) {
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
  const pushContext = { git, gh, run, repository, checkout, now, stage: Array.isArray(progress.stage) ? progress.stage : ['MISSION.md', JOURNEYS, HARNESS] };
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

  if (progress.approved !== true) {
    if (!(await confirm(progress, { repository, prompt, output }))) throw new SetupStop(FACTORY_MESSAGES.declined(repository), 'factory-declined');
    progress = { ...progress, approved: true };
    await save(progress);
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
