// The owner's release requests, as the chat hands them over (lib/inbox.mjs reads <workspace>/.godspeed/forge/inbox/
// and calls these): `plan` (an approved plan), `go`, `take-back` and `status`. Each is
//   async (request, ctx) => ({ ok, say })
//   request = { id, kind, project, words, at, ... }   words: the owner's own words, verbatim
//   ctx     = { gs, config, paths, now, log }         gs: the bridge to Godspeed (lib/godspeed.mjs), of which only
//                                                     readWorkspaceFile, writeWorkspaceFile, sendToOwner and workspace
//                                                     are used; paths.state: the Forge's private state
// `say` is what the owner reads, in plain words (driver/steps/owner/words.mjs holds every sentence).
//
// plan: tickets 02 (filing) of the Forge 0.1.0 plan. go, takeBack, status: ticket 05, the plain profile. Writes to
// GitHub go through the project's Apps (lib/app-token.mjs): issues through the builder App, tags, releases and the
// branch `live` through the release App. Nothing is deleted, ever.
import { appToken, AppTokenError } from '../app-token.mjs';
import { githubClient, GithubError, repoPath, refCommit, setBranch, makeTag } from '../../driver/steps/owner/github.mjs';
import {
  forgePaths, setUpProjects, resolveProject, cleanVersion, compareVersions, releaseRecords, releaseRecord, saveRelease, activeRelease, automaticWork,
  publicRelease, withLock, writePrivate, writeWaiting, updateFacts, releaseFacts, readQuestions, openQuestions, readWorkspaceJson,
  factsFile, projectName, nowMs, iso
} from '../../driver/steps/owner/records.mjs';
import { projectWords, planWords, goWords, takeBackWords, statusWords, notPlain, releaseNotes } from '../../driver/steps/owner/words.mjs';
import { ownerBranchMove } from '../../driver/steps/owner/owner-gh.mjs';
import { profileFromSettingsFolder, runStep, stepEnv } from '../../driver/steps/owner/profile.mjs';
import { join } from 'node:path';

export const MAX_ITEMS = 8;
const IN_FLIGHT = new Set(['filing', 'building', 'checking', 'checked', 'staged']);
export const SIZES = Object.freeze(['light', 'full', 'large']);

const answer = (ok, say, extra = {}) => ({ ok, say, ...extra });

// The repository the request names, among those set up here. prefer: which to take when no project is named.
export function projectFor(ctx, named, prefer = () => false) {
  const projects = setUpProjects(ctx.paths.state);
  if (!projects.length) return { say: projectWords.noneSetUp() };
  const r = resolveProject(projects, named, prefer);
  if (r.repository) return { repository: r.repository };
  if (r.several) return { say: projectWords.several(r.several) };
  return { say: projectWords.unknown(String(named || ''), r.known) };
}

const client = async (ctx, repository, role) => githubClient({
  token: await appToken({ repository, role, paths: ctx.paths, api: ctx.githubApi, fetch: ctx.fetch }), api: ctx.githubApi, fetch: ctx.fetch
});
// The owner's own gh sign-in, for the one move GitHub refuses the release App: one that brings in a change to the
// project's workflow files (driver/steps/owner/owner-gh.mjs).
const ownerMove = ctx => ownerBranchMove((ctx.config && ctx.config.commands && ctx.config.commands.gh) || 'gh');
// The project's own public step or undo (its profile), run before anything changes on GitHub.
// -> '' when it ran fine or the project has none, else what to tell the owner it said
function ownStep(ctx, repository, which, { version, commit }) {
  const state = ctx.paths.state;
  const project = setUpProjects(state).find(p => p.repository === repository);
  const found = profileFromSettingsFolder(repository, { dir: ctx.settingsDir });
  if (found.problem) return found.problem;
  const line = found.profile[which];
  if (!line) return '';
  const minutes = found.profile.timeout_minutes || 25;
  const env = stepEnv({ state, repository, version, commit });
  const r = runStep({}, line, { cwd: project && project.checkout, minutes, env });
  return r.ok ? '' : (r.cause || 'It failed without saying why.');
}
const logged = (ctx, line) => { try { ctx.log?.(line); } catch { /* a log that fails changes nothing */ } };

// ---------------------------------------------------------------- the plan, checked by program
const ownerText = text => !notPlain(text) && !/\bissues?\s*#?\d+\b/i.test(String(text));
const filled = s => typeof s === 'string' && s.trim().length > 0;

// -> { plan } | { reason } (a reason in the owner's words)
export function checkPlan(raw) {
  const plan = raw && typeof raw === 'object' ? raw : {};
  const version = cleanVersion(plan.version);
  if (!version) return { reason: planWords.reasons.version(String(plan.version ?? '')) };
  const items = Array.isArray(plan.items) ? plan.items : [];
  if (!items.length) return { reason: planWords.reasons.noItems };
  if (items.length > MAX_ITEMS) return { reason: planWords.reasons.tooMany(MAX_ITEMS) };
  for (const [i, item] of items.entries()) {
    if (!item || !filled(item.title) || !filled(item.outcome) || !filled(item.why) || !SIZES.includes(String(item.size || '').trim().toLowerCase())) return { reason: planWords.reasons.item(i + 1) };
    if (!ownerText(item.title) || !ownerText(item.outcome)) return { reason: planWords.reasons.notPlain(i + 1) };
  }
  if (!filled(plan.summary) || !ownerText(plan.summary) || (plan.later && !ownerText(typeof plan.later === 'string' ? plan.later : JSON.stringify(plan.later)))) {
    return { reason: planWords.reasons.summaryNotPlain };
  }
  return {
    plan: {
      version,
      summary: plan.summary.trim(),
      later: typeof plan.later === 'string' ? plan.later.trim() : Array.isArray(plan.later) ? plan.later.map(String).join(' ') : '',
      items: items.map((item, i) => ({ n: i + 1, title: item.title.trim(), outcome: item.outcome.trim(), size: String(item.size).trim().toLowerCase(), why: item.why.trim() }))
    }
  };
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
export const ticketName = item => `${String(item.n).padStart(2, '0')}-${slug(item.title)}.md`;
export const issueMarker = (version, n) => `<!-- godspeed-forge release ${version} item ${n} -->`;

// One ticket, with ticket 02's headings, for the factory to build. Its text is the Forge's own restatement of the
// owner's approved plan; nothing a stranger wrote is copied in.
export function ticketText(repository, record, item) {
  return [
    `Ticket for ${repository} ${record.version} (plan item ${item.n} of ${record.items.length}). Size: ${item.size}. Depends on: nothing.`,
    '',
    '## Problem',
    `${item.title}.`.replace(/\.\.$/, '.'),
    '',
    '## Why',
    item.why,
    '',
    '## Why now',
    `The owner approved ${record.version} with this in it: ${record.summary}`,
    '',
    '## Outcome',
    item.outcome,
    '',
    '## Invariants',
    '- What works for the people using it today keeps working.',
    '- Nothing outside this outcome changes.',
    '',
    '## Acceptance',
    '- A test shows the outcome above for the people using it.',
    '- The project\'s own checks pass.',
    '',
    '## Done means',
    'The outcome above is true for the people using it, its tests exist, and the project\'s own checks pass.',
    ''
  ].join('\n');
}

export function planText(repository, record) {
  return [
    '---',
    `release: ${projectName(repository)}-${record.version}`,
    `repository: ${repository}`,
    '---',
    '',
    `# ${projectName(repository)} ${record.version}`,
    '',
    `Approved by the owner on ${record.at}: "${record.words}"`,
    '',
    record.summary,
    '',
    '## Items',
    ...record.items.map(i => `${i.n}. **${i.title}** (${i.size}): ${i.outcome}\n   Why: ${i.why}`),
    '',
    '## Waits for later',
    record.later || 'Nothing named.',
    ''
  ].join('\n');
}

// ---------------------------------------------------------------- plan
export async function plan(request, ctx) {
  const state = ctx.paths.state;
  const now = nowMs(ctx.now);
  const raw = request.plan && typeof request.plan === 'object' ? request.plan : request;
  const where = projectFor(ctx, request.project);
  if (where.say) return answer(false, where.say);
  const repository = where.repository;
  const version = cleanVersion(raw.version);
  if (!filled(request.words)) return answer(false, planWords.refused(repository, version, planWords.reasons.noYes));
  const P = forgePaths(state);
  const existing = version ? releaseRecord(state, repository, version) : null;
  if (existing && existing.state !== 'filing') return answer(false, planWords.already(repository, existing.version, Date.parse(existing.filedAt) || now));
  // one release of a project at a time: a new plan waits until the one in flight is public or taken back (a release
  // whose checks failed does not hold it up: the owner is told to plan the next one)
  const inFlight = activeRelease(releaseRecords(state, repository));
  if (inFlight && inFlight.version !== version && IN_FLIGHT.has(inFlight.state)) return answer(false, planWords.busy(repository, inFlight.version, inFlight.state));
  let record = existing;
  if (!record) {
    const checked = checkPlan(raw);
    if (checked.reason) return answer(false, planWords.refused(repository, version, checked.reason));
    record = {
      repository, version: checked.plan.version, summary: checked.plan.summary, later: checked.plan.later,
      words: String(request.words), at: request.at || iso(now), requestId: request.id ?? null, filedAt: iso(now), state: 'filing',
      items: checked.plan.items.map(i => ({ ...i, ticket: `tickets/${ticketName(i)}`, issue: null }))
    };
  }
  let gh;
  try {
    gh = await client(ctx, repository, 'builder');
  } catch (e) {
    logged(ctx, `plan ${repository} ${record.version}: ${e.message}`);
    return answer(false, e instanceof AppTokenError ? planWords.noAccess(repository, record.version) : planWords.githubFailed(repository, record.version));
  }
  const rp = repoPath(repository);
  try {
    if (!existing) {
      const latest = await gh.get(`${rp}/releases/latest`);
      const latestVersion = latest && cleanVersion(latest.tag_name);
      if (latestVersion && compareVersions(record.version, latestVersion) <= 0) return answer(false, planWords.refused(repository, record.version, planWords.reasons.notNewer(record.version, latestVersion)));
    }
    const fresh = await withLock(P.releaseLock(repository), async () => {
      const again = releaseRecord(state, repository, record.version);
      if (again && again.state !== 'filing') return { say: planWords.already(repository, again.version, Date.parse(again.filedAt) || now) };
      if (!again) {
        const dir = P.releaseDir(repository, record.version);
        await writePrivate(join(dir, 'plan.md'), planText(repository, record));
        for (const item of record.items) await writePrivate(join(dir, item.ticket), ticketText(repository, record, item));
        await saveRelease(state, record);
      } else record = again;
      return {};
    });
    if (fresh.say) return answer(false, fresh.say);
    let recent = null;
    for (const item of record.items) {
      if (item.issue && item.issue.number) continue;
      const marker = issueMarker(record.version, item.n);
      recent ||= await gh.list(`${rp}/issues?state=all&sort=created&direction=desc`, 2);
      let issue = recent.find(i => !i.pull_request && String(i.body || '').includes(marker));
      if (!issue) issue = await gh.post(`${rp}/issues`, { title: item.title, body: `${ticketText(repository, record, item)}\n${marker}\n` });
      item.issue = { number: issue.number, url: issue.html_url };
      await saveRelease(state, record);
    }
    record.state = 'building';
    record.startedAt = iso(now);
    await saveRelease(state, record);
  } catch (e) {
    logged(ctx, `plan ${repository} ${record.version}: ${e.message}`);
    if (!(e instanceof GithubError)) throw e;
    return answer(false, planWords.githubFailed(repository, record.version));
  }
  await updateFacts(ctx.gs, repository, facts => ({ ...facts, updated: iso(now), status: 'being built', release: releaseFacts(record), laterFromLastPlan: record.later || null }));
  // right after setup the factory does not start work by itself: then the owner hears how to get it going
  const checkout = setUpProjects(state).find(p => p.repository === repository)?.checkout;
  const words = automaticWork(checkout) === false ? planWords.startedOff : planWords.started;
  return answer(true, words(repository, record.version, record.items.length));
}

// ---------------------------------------------------------------- go
const hasActive = (state, states) => repository => {
  const a = activeRelease(releaseRecords(state, repository));
  return !!(a && states.includes(a.state));
};

export async function go(request, ctx) {
  const state = ctx.paths.state;
  const now = nowMs(ctx.now);
  const where = projectFor(ctx, request.project, hasActive(state, ['staged']));
  if (where.say) return answer(false, where.say);
  const repository = where.repository;
  const records = releaseRecords(state, repository);
  const active = activeRelease(records);
  if (!active) {
    const newest = records.at(-1);
    return answer(false, newest && newest.state === 'public' ? goWords.already(repository, newest.version) : goWords.nothing(repository));
  }
  if (active.state === 'filing' || active.state === 'building') return answer(false, goWords.building(repository, active.version));
  if (active.state === 'checking' || active.state === 'checked') return answer(false, goWords.checking(repository, active.version));
  if (!active.candidate || !active.candidate.commit) return answer(false, goWords.nothing(repository));
  const version = active.version;
  const commit = active.candidate.commit;
  let gh;
  try {
    gh = await client(ctx, repository, 'release');
  } catch (e) {
    logged(ctx, `go ${repository} ${version}: ${e.message}`);
    return answer(false, goWords.failed(repository, version));
  }
  const rp = repoPath(repository);
  const P = forgePaths(state);
  try {
    const tagged = await refCommit(gh, repository, `tags/${active.candidate.tag || `candidate/${version}`}`);
    if (tagged !== commit) return answer(false, goWords.moved(repository, version));
    const record = await withLock(P.releaseLock(repository), async () => {
      const r = releaseRecord(state, repository, version);
      if (!r.go) {
        const latest = await gh.get(`${rp}/releases/latest`);
        r.previous = latest && latest.tag_name !== `v${version}`
          ? { version: cleanVersion(latest.tag_name) || latest.tag_name, tag: latest.tag_name, releaseId: latest.id, commit: await refCommit(gh, repository, `tags/${latest.tag_name}`) }
          : null;
        r.liveBefore = await refCommit(gh, repository, 'heads/live');
        // a go on a release whose checks failed carries the owner's words as their reason
        r.go = { at: request.at || iso(now), words: String(request.words ?? ''), requestId: request.id ?? null, despiteFailedChecks: r.state === 'failed' && !(r.failed && r.failed.staging), recordedAt: iso(now) };
        await saveRelease(state, r);
      }
      return r;
    });
    const publicProblem = ownStep(ctx, repository, 'public', { version, commit });
    if (publicProblem) return answer(false, goWords.publicStepFailed(repository, version, publicProblem));
    const tag = `v${version}`;
    if ((await makeTag(gh, repository, tag, commit)) === 'elsewhere') return answer(false, goWords.tagElsewhere(repository, version));
    const notes = releaseNotes(record);
    const body = { tag_name: tag, name: version, body: notes, prerelease: false, draft: false, make_latest: 'true' };
    let release;
    const own = await gh.get(`${rp}/releases/tags/${encodeURIComponent(tag)}`);
    if (own) release = await gh.patch(`${rp}/releases/${own.id}`, body);
    else if (record.prerelease && record.prerelease.id) release = await gh.patch(`${rp}/releases/${record.prerelease.id}`, body);
    else release = await gh.post(`${rp}/releases`, { ...body, target_commitish: commit });
    await setBranch(gh, repository, 'live', commit, { ownerMove: ownerMove(ctx) });
    await withLock(P.releaseLock(repository), async () => {
      const r = releaseRecord(state, repository, version);
      Object.assign(r, { state: 'public', public: { at: iso(now), tag, releaseId: release.id, url: release.html_url, notes } });
      await saveRelease(state, r);
    });
    const done = releaseRecord(state, repository, version);
    await updateFacts(ctx.gs, repository, facts => ({ ...facts, updated: iso(now), status: 'public', release: releaseFacts(done), public: { version, at: done.public.at, url: done.public.url } }));
    await writeWaiting(ctx.gs, state, now);
    return answer(true, record.go.despiteFailedChecks ? goWords.publicDespite(repository, version, release.html_url) : goWords.public(repository, version, release.html_url));
  } catch (e) {
    logged(ctx, `go ${repository} ${version}: ${e.message}`);
    if (!(e instanceof GithubError)) throw e;
    return answer(false, goWords.failed(repository, version));
  }
}

// ---------------------------------------------------------------- take it back
export async function takeBack(request, ctx) {
  const state = ctx.paths.state;
  const now = nowMs(ctx.now);
  const lastPublic = repository => [...releaseRecords(state, repository)].reverse().find(r => r.state === 'public' || r.state === 'taken-back') || null;
  const where = projectFor(ctx, request.project, repository => lastPublic(repository)?.state === 'public');
  if (where.say) return answer(false, where.say);
  const repository = where.repository;
  const last = lastPublic(repository);
  if (!last) return answer(false, takeBackWords.nothing(repository));
  if (last.state === 'taken-back') return answer(false, takeBackWords.already(repository, last.version));
  const version = last.version;
  const previous = last.previous && last.previous.releaseId ? last.previous : null;
  // what `live` pointed to before the go (go records it, null when go made the branch); else the earlier release
  const back = last.liveBefore || (previous && previous.commit) || null;
  // the first public version, with nothing before it: there is nothing to return to, so nothing changes
  if (!previous && !back) return answer(false, takeBackWords.first(repository, version));
  const P = forgePaths(state);
  const rp = repoPath(repository);
  let gh;
  try {
    gh = await client(ctx, repository, 'release');
  } catch (e) {
    logged(ctx, `take back ${repository} ${version}: ${e.message}`);
    return answer(false, takeBackWords.failed(repository, version));
  }
  try {
    // the owner's words are kept here, in the Forge's private state, and never put on GitHub
    const record = await withLock(P.releaseLock(repository), async () => {
      const r = releaseRecord(state, repository, version);
      r.takenBack ||= { at: request.at || iso(now), words: String(request.words ?? ''), requestId: request.id ?? null };
      await saveRelease(state, r);
      return r;
    });
    const undoProblem = ownStep(ctx, repository, 'undo', { version, commit: last.candidate && last.candidate.commit });
    if (undoProblem) return answer(false, takeBackWords.undoFailed(repository, version, undoProblem));
    const note = `Taken back on ${iso(now).slice(0, 10)}. ${previous ? `${previous.version} is public again.` : 'No earlier release is public.'}`;
    await gh.patch(`${rp}/releases/${record.public.releaseId}`, {
      name: `${version} (taken back)`, body: `${note}\n\n${record.public.notes || releaseNotes(record)}`, prerelease: true, make_latest: 'false'
    });
    if (previous) await gh.patch(`${rp}/releases/${previous.releaseId}`, { make_latest: 'true' });
    if (back) await setBranch(gh, repository, 'live', back, { ownerMove: ownerMove(ctx) });
    await withLock(P.releaseLock(repository), async () => {
      const r = releaseRecord(state, repository, version);
      Object.assign(r, { state: 'taken-back' });
      r.takenBack.done = iso(now);
      await saveRelease(state, r);
    });
    const done = releaseRecord(state, repository, version);
    await updateFacts(ctx.gs, repository, facts => ({
      ...facts, updated: iso(now), status: previous ? 'public' : 'idle', release: releaseFacts(done),
      public: previous ? { version: previous.version, at: null, url: null } : null
    }));
    return answer(true, previous ? takeBackWords.done(repository, version, previous.version) : takeBackWords.doneNoPrevious(repository, version));
  } catch (e) {
    logged(ctx, `take back ${repository} ${version}: ${e.message}`);
    if (!(e instanceof GithubError)) throw e;
    return answer(false, takeBackWords.failed(repository, version));
  }
}

// ---------------------------------------------------------------- release status
// At most two plain sentences: what is being built, on staging or waiting for the owner, and what is public. Read
// from the Forge's records and the facts file the driver refreshes every 15 minutes; GitHub is not asked.
export async function status(request, ctx) {
  const state = ctx.paths.state;
  const where = projectFor(ctx, request.project, hasActive(state, ['filing', 'building', 'checking', 'checked', 'staged', 'failed']));
  if (where.say) return answer(false, where.say);
  const repository = where.repository;
  const records = releaseRecords(state, repository);
  const active = activeRelease(records);
  const pub = publicRelease(records);
  const facts = (await readWorkspaceJson(ctx.gs, factsFile(repository))) || {};
  const questions = openQuestions(readQuestions(state)).filter(q => q.repository === repository).length;
  let first;
  if (!active) first = statusWords.idle(repository);
  else if (active.state === 'filing' || active.state === 'building') {
    first = active.items.some(i => i.closedUndone) ? statusWords.stuck(repository, active.version)
      : statusWords.building(repository, active.version, active.items.filter(i => i.done).length, active.items.length);
  } else if (active.state === 'checking' || active.state === 'checked') first = statusWords.checking(repository, active.version);
  else if (active.state === 'staged') first = statusWords.staged(repository, active.version, active.staging && active.staging.link);
  else first = active.failed && active.failed.staging ? statusWords.stagingFailed(repository, active.version) : statusWords.failed(repository, active.version);
  const publicVersion = pub ? pub.version : (facts.public && facts.public.version) || (facts.newestPublicRelease && facts.newestPublicRelease.version) || null;
  return answer(true, `${first} ${statusWords.publicAnd(publicVersion, questions)}`);
}
