import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverProjects, releaseStatePath, writePrivateJson } from './config.mjs';

const SIZES = { light: 1, full: 2, large: 4 };
const REQUIRED = ['problem', 'why', 'whyNow', 'outcome', 'invariants', 'acceptance', 'doneMeans'];

export const proposalSchema = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'version', 'items', 'deferred'],
  properties: {
    summary: { type: 'string' }, version: { type: 'string' },
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'title', ...REQUIRED, 'size', 'dependencies', 'reason', 'sources'], properties: Object.fromEntries(['key', 'title', ...REQUIRED, 'size', 'reason'].map(key => [key, { type: 'string' }]).concat([['dependencies', { type: 'array', items: { type: 'string' } }], ['sources', { type: 'array', minItems: 1, items: { type: 'string' } }]])) } },
    deferred: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'reason'], properties: { title: { type: 'string' }, reason: { type: 'string' } } } }
  }
};

function words(value) {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function strangerPhrases(evidence) {
  return [...evidence.issues, ...evidence.pullRequests]
    .filter(value => value.author?.toLowerCase() !== evidence.viewer?.toLowerCase())
    .flatMap(value => [value.title, value.body].flatMap(text => {
      const source = words(text);
      if (!source.length) return [];
      const width = Math.min(8, source.length);
      return source.slice(0, source.length - width + 1).map((_, index) => source.slice(index, index + width).join(' '));
    }));
}

function itemKeyForSource(source) {
  return source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

function sourcePriorities(evidence) {
  const priorities = new Map();
  evidence.issues.forEach(value => priorities.set(`issue:${value.id}`, value.labels.some(label => /bug|defect|regression/i.test(label)) ? 0 : value.author?.toLowerCase() === evidence.viewer?.toLowerCase() ? 1 : 2));
  evidence.pullRequests.forEach(value => priorities.set(`pr:${value.id}`, value.author?.toLowerCase() === evidence.viewer?.toLowerCase() ? 1 : 2));
  evidence.checks.forEach(value => priorities.set(`check:${value.name}`, 0));
  (evidence.priorDeferred ?? []).forEach((_, index) => priorities.set(`deferred:${index}`, 0));
  return priorities;
}

export function validateProposal(value, evidence) {
  if (!value || typeof value.summary !== 'string' || !/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.version) || !Array.isArray(value.items) || !value.items.length || !Array.isArray(value.deferred)) throw new Error('The planning agent returned an incomplete proposal.');
  let capacity = 0;
  const keys = new Set();
  const priorities = sourcePriorities(evidence);
  let priorPriority = -1;
  for (const item of value.items) {
    if (!item || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.key) || keys.has(item.key) || typeof item.title !== 'string' || !SIZES[item.size] || !Array.isArray(item.dependencies) || !Array.isArray(item.sources) || !item.sources.length || item.sources.some(source => !priorities.has(source)) || item.key !== itemKeyForSource(item.sources[0]) || REQUIRED.some(key => typeof item[key] !== 'string' || !item[key].trim()) || typeof item.reason !== 'string') throw new Error('The planning agent returned an incomplete item.');
    keys.add(item.key); capacity += SIZES[item.size];
    const priority = priorities.get(item.sources[0]);
    if (priority < priorPriority) throw new Error('The proposal does not put urgent work first.');
    priorPriority = priority;
    const written = words([item.title, ...REQUIRED.map(key => item[key]), item.reason].join('\n')).join(' ');
    if (strangerPhrases(evidence).some(phrase => written.includes(phrase))) throw new Error('The planning agent copied a report instead of restating it.');
  }
  if (capacity > 4) throw new Error('The proposed release is too large for one sitting.');
  for (const item of value.items) if (item.dependencies.some(key => !keys.has(key))) throw new Error('The proposal has an unknown dependency.');
  return structuredClone(value);
}

function allowance(items) {
  return ['none', 'about one quarter', 'about half', 'about three quarters', 'about one weekly allowance'][items.reduce((sum, item) => sum + SIZES[item.size], 0)];
}

export function renderOwnerMessage(proposal) {
  const outcomes = proposal.items.map((item, index) => `${index + 1}. ${item.outcome}`).join('\n');
  const deferred = proposal.deferred.length ? proposal.deferred.map(item => `${item.title} (${item.reason})`).join('; ') : 'nothing';
  const message = `${proposal.summary}\n\n${outcomes}\n\nDeferred: ${deferred}\nCost: ${allowance(proposal.items)} of your signed-in agent allowance.\nVersion: ${proposal.version}\n\nShall I start it?`;
  if (/\bticket\b|#\d+|\b(?:issue|pull request|pr)\s*#?\d+\b|(?:^|\s)[\w./-]+\.(?:js|mjs|ts|py|sh|json|md)\b|\bscript\b/i.test(message)) throw new Error('The proposal contains internal details that cannot be shown to the owner.');
  return message;
}

function renderIssue(item) {
  const section = (heading, value) => `## ${heading}\n\n${value}`;
  return [section('Problem', item.problem), section('Why', item.why), section('Why now', item.whyNow), section('Outcome', item.outcome), section('Invariants', item.invariants), section('Acceptance', item.acceptance), section('Done means', item.doneMeans), section('Size', item.size), section('Dependencies', item.dependencies.length ? item.dependencies.join(', ') : 'None'), section('Reason', item.reason)].join('\n\n');
}

async function previousDeferred(project) {
  try {
    const index = JSON.parse(await readFile(join(project.stateDirectory, 'latest-release.json'), 'utf8'));
    const plan = JSON.parse(await readFile(join(project.stateDirectory, 'releases', index.slug, 'plan.json'), 'utf8'));
    return plan.status === 'approved' ? plan.proposal.deferred : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function chooseProject(stateRoot, requested, prompt) {
  const projects = await discoverProjects(stateRoot);
  if (!projects.length) throw new Error('Set up a project before planning a release.');
  const match = value => {
    const lower = value.trim().toLowerCase();
    const full = projects.filter(project => project.repository.toLowerCase() === lower);
    if (full.length) return full;
    return projects.filter(project => project.repository.split('/')[1].toLowerCase() === lower);
  };
  if (requested) {
    const matches = match(requested);
    if (matches.length === 1) return matches[0];
  }
  const answer = await prompt(`Which project should I plan? ${projects.map(project => project.repository).join(', ')}`);
  const matches = match(answer);
  if (matches.length !== 1) throw new Error('Choose one configured project by its full owner/repository name.');
  return matches[0];
}

function planningPrompt({ mission, evidence, deferred, revision, prior }) {
  return `Plan one user-facing release from this evidence. Cite each item's primary evidence first, followed by any supporting evidence, using issue:<id>, pr:<id>, check:<name>, or deferred:<zero-based index>. Set the item key to that primary source with punctuation replaced by hyphens, such as issue-12 or check-required. Bugs, failing checks, and unfinished deferred work come first; findings by the signed-in GitHub user come next; aligned features come last. Decide implementation details. Restate reports in your own words. Use at most four capacity units: light=1, full=2, large=4. Return only the requested structure.\nMission:\n${mission}\nEvidence:\n${JSON.stringify({ ...evidence, deferred })}${revision ? `\nThe owner requested this change: ${revision}\nPrevious proposal: ${JSON.stringify(prior)}` : ''}`;
}

function filingMarker(project, proposal, item) {
  return `godspeed-forge:${project.repository}:${proposal.version}:${item.key}`;
}

async function fileApproved({ stateRoot, project, proposal, evidence, github }) {
  const directory = releaseStatePath(stateRoot, project.repository, proposal.version);
  const path = join(directory, 'plan.json');
  let record;
  try { record = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (record?.status === 'approved') throw new Error('That release version is already approved.');
  if (record && JSON.stringify(record.proposal) !== JSON.stringify(proposal)) throw new Error('That release version has a different unfinished filing.');
  record ??= {
    status: 'filing', repository: project.repository, proposal, issues: {},
    evidence: {
      latestRelease: evidence.latestRelease,
      commits: evidence.commits.map(value => value.sha), issues: evidence.issues.map(value => value.id),
      pullRequests: evidence.pullRequests.map(value => value.id), mergedPullRequests: evidence.mergedPullRequests?.map(value => value.id) ?? [],
      checks: evidence.checks.map(value => value.name)
    }
  };
  await writePrivateJson(path, record);
  for (const item of proposal.items) {
    await writePrivateJson(join(directory, `item-${item.key}.json`), item);
    if (!record.issues[item.key]) {
      const marker = filingMarker(project, proposal, item);
      record.issues[item.key] = await github.findIssueByMarker(marker);
      record.issues[item.key] ??= await github.createIssue({ title: item.title, body: `${renderIssue(item)}\n\n<!-- ${marker} -->` });
      await writePrivateJson(path, record);
    }
  }
  record.status = 'approved';
  await writePrivateJson(path, record);
  const slug = directory.split('/').at(-1);
  await writePrivateJson(join(project.stateDirectory, 'latest-release.json'), { slug, version: proposal.version });
  return record;
}

export async function planRelease(requested, options) {
  const { stateRoot, prompt, output, createRepository, planWithAgent } = options;
  const project = await chooseProject(stateRoot, requested, prompt);
  const github = createRepository(project.repository);
  const evidence = await github.collect();
  evidence.priorDeferred = await previousDeferred(project);
  const mission = await readFile(join(project.checkout, 'MISSION.md'), 'utf8');
  let revision = '';
  let proposal;
  for (;;) {
    try {
      proposal = validateProposal(await planWithAgent({ schema: proposalSchema, prompt: planningPrompt({ mission, evidence, deferred: evidence.priorDeferred, revision, prior: proposal }) }), evidence);
      output(renderOwnerMessage(proposal));
    } catch {
      output('I could not prepare a safe release plan. Nothing was created; please try again.');
      return { approved: false, reason: 'agent' };
    }
    const answer = (await prompt('Your answer:')).trim();
    if (/^yes$/i.test(answer)) break;
    if (/^no$/i.test(answer)) return { approved: false };
    revision = answer;
  }
  const record = await fileApproved({ stateRoot, project, proposal, evidence, github });
  output('The release plan is approved and its work is ready for the factory.');
  return { approved: true, record };
}
