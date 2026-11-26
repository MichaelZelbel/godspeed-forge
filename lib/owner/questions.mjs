// The owner's answer to one of the factory's questions, as the chat hands it over: `answer` with the question's
// handle (F1, F2, ...; the owner-questions step told it) and the owner's own words, verbatim.
//   async (request, ctx) => ({ ok, say })
//   request = { id, kind: 'answer', handle, words, at, ... }
//   ctx     = { gs, config, paths, now, log }
// It posts the words once on the project's "Owner decisions needed" issue, as the comment the pinned manager reads
// ("Owner decision (question <n>: <question>)" with the words quoted, see driver/steps/owner/questions.mjs),
// through the project's builder App, and marks the question answered. Ticket 03 of the Forge 0.1.0 plan. It posts only on
// the factory's own issue: one with that title opened by the project's builder App or by the gh sign-in the factory runs
// as (the owner-questions step recorded which, and the login), and never on an issue anyone else opened.
import { appToken, AppTokenError } from '../app-token.mjs';
import { githubClient, GithubError, repoPath } from '../../driver/steps/owner/github.mjs';
import { forgePaths, readQuestions, saveQuestions, openQuestions, withLock, writeWaiting, nowMs, iso } from '../../driver/steps/owner/records.mjs';
import { answerBody, markerOf, pickedOption, openedBy, TITLE } from '../../driver/steps/owner/questions.mjs';
import { readAppDetails } from '../../driver/steps/owner/app-token.mjs';
import { answerWords } from '../../driver/steps/owner/words.mjs';

const handleOf = request => {
  const own = String(request.handle || '').trim();
  const m = /^F\d+$/i.exec(own) || /^\s*(F\d+)\b/i.exec(String(request.words || ''));
  return m ? (m[1] || m[0]).toUpperCase() : '';
};

async function trusted(state, rec, issue, q) {
  if (!issue || String(issue.title || '').trim() !== TITLE || !rec.openedBy || openedBy(issue) !== rec.openedBy) return false;
  const logins = new Set();
  try {
    const slug = (await readAppDetails(forgePaths(state).credentialDir(rec.repository), 'builder')).slug;
    if (slug) logins.add(`${String(slug).toLowerCase()}[bot]`);
  } catch { /* no App details: only the gh login */ }
  if (q.ghLogin) logins.add(String(q.ghLogin).toLowerCase());
  return logins.has(rec.openedBy);
}

async function answerOne(request, ctx) {
  const state = ctx.paths.state;
  const now = nowMs(ctx.now);
  const handle = handleOf(request);
  const words = typeof request.words === 'string' ? request.words : '';
  if (!handle || !words.trim()) return { ok: false, say: answerWords.missing };
  return withLock(forgePaths(state).questionsLock, async () => {
    const q = readQuestions(state);
    const rec = q.questions.find(x => x.handle === handle);
    if (!rec || rec.status === 'pending' || rec.status === 'kept') return { ok: false, say: answerWords.unknown(handle, openQuestions(q).map(x => x.handle)) };
    if (rec.status === 'answered' || rec.status === 'answered-elsewhere') return { ok: false, say: answerWords.already(handle) };
    if (rec.status === 'withdrawn') return { ok: false, say: answerWords.withdrawn(rec.repository, handle) };
    try {
      const token = await appToken({ repository: rec.repository, role: 'builder', paths: ctx.paths, api: ctx.githubApi, fetch: ctx.fetch });
      const gh = githubClient({ token, api: ctx.githubApi, fetch: ctx.fetch });
      // the issue is still the factory's own: its title, opened by the identity the step saw, which is the builder App
      // or the factory's gh login
      const issue = await gh.get(`${repoPath(rec.repository)}/issues/${rec.issue}`);
      if (!(await trusted(state, rec, issue, q))) return { ok: false, say: answerWords.untrusted(handle) };
      const path = `${repoPath(rec.repository)}/issues/${rec.issue}/comments`;
      const marker = markerOf(handle, rec.qid);
      const comments = await gh.list(path, 5);
      if (!comments.some(c => String(c.body || '').includes(marker))) {
        const at = request.at || iso(now);
        await gh.post(path, { body: answerBody({ number: rec.number, heading: rec.heading, words, at, handle, qid: rec.qid, picked: pickedOption(words, handle, rec.options) }) });
      }
    } catch (e) {
      try { ctx.log?.(`answer ${handle}: ${e.message}`); } catch { /* a log that fails changes nothing */ }
      if (!(e instanceof GithubError) && !(e instanceof AppTokenError)) throw e;
      return { ok: false, say: answerWords.failed(handle) };
    }
    Object.assign(rec, { status: 'answered', answeredAt: iso(now), answer: { words, at: request.at || iso(now), requestId: request.id ?? null } });
    await saveQuestions(state, q);
    return { ok: true, say: answerWords.passed(rec.repository, handle) };
  });
}

// One chat message may answer several questions ("F1: yes" on one line, "F2: keep it" on the next). Each part that
// starts with its own handle is one answer; a message with one part is one answer, as before.
export function splitAnswers(words) {
  const parts = String(words || '').split(/\s*(?:[\n;]|,(?=\s*F\d+\s*:))\s*(?=F\d+\b)/i).map(x => x.trim()).filter(Boolean);
  return parts.length > 1 && parts.every(x => /^F\d+\b/i.test(x)) ? parts : null;
}

export async function answer(request, ctx) {
  const parts = typeof request.words === 'string' ? splitAnswers(request.words) : null;
  const results = [];
  if (!parts) results.push(await answerOne(request, ctx));
  else for (const [i, words] of parts.entries()) results.push(await answerOne({ ...request, handle: '', words, id: request.id == null ? null : `${request.id}#${i + 1}` }, ctx));
  if (results.some(r => r.ok)) await writeWaiting(ctx.gs, ctx.paths.state, nowMs(ctx.now));
  if (results.length === 1) return results[0];
  return { ok: results.every(r => r.ok), say: results.map(r => r.say).join(' ') };
}
