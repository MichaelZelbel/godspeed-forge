import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from './godspeed.mjs';
import { readPrivateJson, writePrivateJson } from '../config.mjs';

const FORBIDDEN = ['workflow', 'check', 'merge gate', 'judge', 'holdout'];

export function parseDecisionBlocks(body) {
  const headings = [...String(body).matchAll(/^###\s+\d+\.\s+(.+)$/gm)];
  return headings.map((heading, index) => ({
    title: heading[1].trim(),
    block: String(body).slice(heading.index, headings[index + 1]?.index ?? undefined).trim()
  })).filter(question => question.title && question.title.length <= 500 && question.block.length > question.title.length && question.block.length <= 12_000);
}

export function questionIdentity(repository, issue, question) {
  const digest = createHash('sha256').update(`${repository}\n${issue}\n${question.title.toLowerCase()}\n${question.block}`).digest('hex');
  return { key: digest, handle: `Q-${digest.slice(0, 6).toUpperCase()}` };
}

export function validateClassification(value) {
  if (!value || typeof value !== 'object' || typeof value.owner !== 'boolean') return null;
  if (!value.owner) return { owner: false };
  if (typeof value.example !== 'string' || !value.example.trim() || value.example.length > 2_000 ||
      !Array.isArray(value.choices) || value.choices.length < 2 || value.choices.length > 8 || value.choices.some(choice => typeof choice !== 'string' || !choice.trim() || choice.length > 1_000) ||
      typeof value.default !== 'string' || !value.default.trim() || value.default.length > 1_000 ||
      typeof value.applies !== 'string' || !value.applies.trim() || value.applies.length > 1_000) return null;
  return { owner: true, example: value.example.trim(), choices: value.choices.map(choice => choice.trim()), default: value.default.trim(), applies: value.applies.trim() };
}

export function formatQuestionNotice(question, classification, handle) {
  const choices = classification.choices.map((choice, index) => `Choice ${index + 1}: ${choice}`).join('\n');
  const text = `${classification.example}\n\n${question.title}\n${choices}\nDefault: ${classification.default}\nThis applies ${classification.applies}.\n\nReply ${handle}: followed by your answer.`;
  if (FORBIDDEN.some(word => text.toLowerCase().includes(word))) throw new Error('The owner notice contains an internal term.');
  return text;
}

export function formatOwnerDecision(message) {
  return `Owner decision\n\n${message}`;
}

function validateMatch(value, keys) {
  if (value === null || value?.key === null) return null;
  return value && typeof value.key === 'string' && keys.includes(value.key) ? value.key : undefined;
}

async function registrations(stateRoot) {
  const root = join(stateRoot, 'projects');
  let owners;
  try { owners = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const values = [];
  for (const owner of owners.filter(entry => entry.isDirectory())) {
    const repositories = await readdir(join(root, owner.name), { withFileTypes: true });
    for (const repository of repositories.filter(entry => entry.isDirectory())) {
      const directory = join(root, owner.name, repository.name);
      try {
        const registration = await readPrivateJson(join(directory, 'registration.json'));
        if (registration.completed === true && registration.repository === `${owner.name}/${repository.name}`) values.push({ ...registration, directory });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return values;
}

async function readState(path) {
  try { return await readPrivateJson(path); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, told: {}, reviewed: {} }; throw error; }
}

export async function runQuestionRelay({ stateRoot, github, godspeed, output = () => {} }) {
  let release;
  try { release = await acquireLock(join(stateRoot, 'questions.lock')); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('The question relay is already running.'); throw error; }
  const failures = [];
  try {
    const messagePath = join(stateRoot, 'question-messages.json');
    const messageState = await readMessageState(messagePath);
    await writePrivateJson(messagePath, messageState);
    const contexts = [];
    for (const registration of await registrations(stateRoot)) {
      try {
        const context = await prepareRepository(registration, { github, godspeed });
        if (context) contexts.push(context);
      }
      catch (error) { failures.push(`${registration.repository}: ${error.message}`); }
    }
    const completeCandidateSet = failures.length === 0;
    let messages = [];
    try { messages = await godspeed.messages(messageState); }
    catch (error) { failures.push(`owner messages: ${error.message}`); }
    for (const message of messages) {
      try {
        const reviewed = await processMessage(message, contexts, godspeed, completeCandidateSet);
        if (reviewed) {
          messageState.reviewed.push(String(message.id));
          await writePrivateJson(messagePath, messageState);
        }
      } catch (error) { failures.push(`owner message ${message.id}: ${error.message}`); }
    }
  } finally { await release(); }
  if (failures.length) {
    failures.forEach(output);
    throw new Error(`The question relay could not finish ${failures.length} ${failures.length === 1 ? 'repository' : 'repositories'}.`);
  }
}

async function readMessageState(path) {
  try {
    const value = await readPrivateJson(path);
    if (typeof value.startedAt !== 'string' || !value.startedAt) throw new Error('The owner message receipt is malformed.');
    return { version: 1, startedAt: value.startedAt, reviewed: Array.isArray(value.reviewed) ? value.reviewed.map(String) : [] };
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, startedAt: new Date().toISOString(), reviewed: [] }; throw error; }
}

async function prepareRepository(registration, { github, godspeed }) {
  const path = join(registration.directory, 'questions.json');
  const state = await readState(path);
  state.told ??= {};
  state.reviewed ??= {};
  const issue = await github.find(registration.repository);
  const pending = Object.values(state.told).filter(item => item.status === 'pending' || item.status === 'needs_review');
  if (!issue) {
    if (pending.length && !state.disappearanceNoticed) {
      await godspeed.notice({ id: `forge-questions-gone-${createHash('sha256').update(registration.repository).digest('hex').slice(0, 16)}`, text: `The decision list for ${registration.repository} closed before your answer arrived. Reopen it on GitHub if you still want the answer recorded.` });
      state.disappearanceNoticed = true;
      await writePrivateJson(path, state);
    }
    return null;
  }
  state.disappearanceNoticed = false;
  for (const item of Object.values(state.told).filter(item => item.status === 'needs_review')) {
    if ((issue.comments ?? []).some(comment => (comment.body ?? comment) === item.commentBody)) item.status = 'posted';
  }
  await writePrivateJson(path, state);
  const handles = new Set(Object.values(state.told).map(item => item.handle));
  for (const question of parseDecisionBlocks(issue.body)) {
    const identity = questionIdentity(registration.repository, issue.number, question);
    if (state.told[identity.key] || state.reviewed[identity.key]) continue;
    if (handles.has(identity.handle)) throw new Error('Two questions have the same reply handle.');
    const classification = validateClassification(await godspeed.classify({ key: identity.key, ...question }));
    if (!classification) throw new Error('The question classification was malformed.');
    if (!classification.owner) {
      state.reviewed[identity.key] = { owner: false };
      await writePrivateJson(path, state);
      continue;
    }
    const text = formatQuestionNotice(question, classification, identity.handle);
    await godspeed.notice({ id: `forge-question-${identity.key}`, text });
    state.told[identity.key] = { ...identity, title: question.title, status: 'pending' };
    handles.add(identity.handle);
    await writePrivateJson(path, state);
  }
  return { registration, github, issue, state, path };
}

async function processMessage(message, contexts, godspeed, completeCandidateSet) {
  if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('An owner message was malformed.');
  const available = contexts.flatMap(context => Object.values(context.state.told)
    .filter(item => item.status === 'pending').map(item => ({ ...item, context })));
  if (!completeCandidateSet) return false;
  const handled = available.filter(item => message.content.startsWith(`${item.handle}:`));
  if (handled.length > 1) throw new Error('The reply handle is ambiguous.');
  let selected = handled[0];
  if (selected && !message.content.slice(selected.handle.length + 1).trim()) return true;
  if (!selected && available.length) {
    const match = validateMatch(await godspeed.match(message.content, available.map(({ key, title, context }) => ({ key, title, repository: context.registration.repository }))), available.map(item => item.key));
    if (match === undefined) throw new Error('The reply match was malformed.');
    selected = available.find(item => item.key === match);
  }
  if (!selected) return true;
  const { context } = selected;
  const body = formatOwnerDecision(message.content);
  const existing = (context.issue.comments ?? []).some(comment => (comment.body ?? comment) === body);
  if (!existing) {
    context.state.told[selected.key].status = 'needs_review';
    context.state.told[selected.key].commentBody = body;
    await writePrivateJson(context.path, context.state);
    await context.github.comment(context.registration.repository, context.issue.number, body);
  }
  context.state.told[selected.key].status = 'posted';
  context.state.told[selected.key].messageId = String(message.id);
  await writePrivateJson(context.path, context.state);
  return true;
}
