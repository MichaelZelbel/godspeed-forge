// The owner's answer to one of the factory's questions, as the chat hands it over: `answer` with the question's
// handle (F1, F2, ...; the owner-questions step told it) and the owner's own words, verbatim.
//   async (request, ctx) => ({ ok, say })
//   request = { id, kind: 'answer', handle, words, at, ... }
//   ctx     = { gs, config, paths, now, log }
// It posts the words once on the project's "Owner decisions needed" issue, as the comment the pinned manager reads
// ("Owner decision (question <n>: <question>)" with the words quoted, see driver/steps/owner/questions.mjs),
// through the project's builder App, and marks the question answered. Ticket 03 of the Forge 0.1.0 plan.
import { appToken, AppTokenError } from '../app-token.mjs';
import { githubClient, GithubError, repoPath } from '../../driver/steps/owner/github.mjs';
import { forgePaths, readQuestions, saveQuestions, openQuestions, withLock, writeWaiting, nowMs, iso } from '../../driver/steps/owner/records.mjs';
import { answerBody, markerOf, pickedOption } from '../../driver/steps/owner/questions.mjs';
import { answerWords } from '../../driver/steps/owner/words.mjs';

const handleOf = request => {
  const own = String(request.handle || '').trim();
  const m = /^F\d+$/i.exec(own) || /^\s*(F\d+)\b/i.exec(String(request.words || ''));
  return m ? (m[1] || m[0]).toUpperCase() : '';
};

export async function answer(request, ctx) {
  const state = ctx.paths.state;
  const now = nowMs(ctx.now);
  const handle = handleOf(request);
  const words = typeof request.words === 'string' ? request.words : '';
  if (!handle || !words.trim()) return { ok: false, say: answerWords.missing };
  const result = await withLock(forgePaths(state).questionsLock, async () => {
    const q = readQuestions(state);
    const rec = q.questions.find(x => x.handle === handle);
    if (!rec || rec.status === 'pending' || rec.status === 'kept') return { ok: false, say: answerWords.unknown(handle, openQuestions(q).map(x => x.handle)) };
    if (rec.status === 'answered' || rec.status === 'answered-elsewhere') return { ok: false, say: answerWords.already(handle) };
    if (rec.status === 'withdrawn') return { ok: false, say: answerWords.withdrawn(rec.repository, handle) };
    try {
      const token = await appToken({ repository: rec.repository, role: 'builder', paths: ctx.paths, api: ctx.githubApi, fetch: ctx.fetch });
      const gh = githubClient({ token, api: ctx.githubApi, fetch: ctx.fetch });
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
  if (result.ok) await writeWaiting(ctx.gs, state, now);
  return result;
}
