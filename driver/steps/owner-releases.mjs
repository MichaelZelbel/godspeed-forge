// The owner-releases step (ticket 04 of the Forge 0.1.0 plan, the plain profile, for every project set up with
// the Forge). Every 15 minutes, for each project:
//   1. it refreshes the project's facts file in Godspeed's workspace (.godspeed/forge/projects/<owner>--<repo>.json):
//      the newest public release, what merged since, the open issues and pull requests with their labels, age and
//      whether the owner or a stranger wrote them, failing checks on the default branch, what the last plan left
//      for later, and what is being built, staged or public. The chat makes a plan from it and answers status.
//   2. when every item of the newest approved release that is not staged yet (lib/owner/releases.mjs files them)
//      is closed by a merged pull request on the default branch, it freezes `candidate/<version>` on the newest of
//      those merges, pauses the factory's scheduled laps (`python factory/consumer.py pause` in the checkout) while
//      the project's own checks (harness/harness.config.json: static and unit) run on the candidate in a temporary
//      worktree, always unpauses (only a pause it made itself), makes a GitHub pre-release to try, moves the branch
//      `staging` to the candidate, and sends exactly one message: the link and "Shall I make it public? Reply go.",
//      or the failed checks, one plain sentence each, and no go question. A failed check is run once more, alone.
//      An item closed without a merged pull request gets one sentence and no freeze.
// A project profile may add, in the project's settings file: "profile": { "staging_url", "deploy", "health" }:
// staging_url is the link the owner gets instead of the pre-release's page, deploy runs after `staging` moved
// (with FORGE_CANDIDATE_COMMIT and FORGE_VERSION set), and health must then succeed and print the candidate's
// commit (its first seven characters are enough). The plain profile needs none of them.
//
// Tags, releases and branches go through the project's release App; reads go through its builder App. It never
// makes anything public: that is the owner's go (lib/owner/releases.mjs). What it did and said is in the release's
// record, so a release is staged and announced once, also across restarts. A project the Forge has not set up,
// or whose App details this server does not hold, is skipped quietly; a project the older stage step drives
// (a `releases` block) gets its facts refreshed and is never staged here.
import fs from "node:fs";
import path from "node:path";
import { githubClient, repoPath, referencedIssues, makeTag, setBranch, refCommit } from "./owner/github.mjs";
import {
  DEFAULT_STATE, forgePaths, releaseRecords, saveRelease, releaseRecord, activeRelease, publicRelease, withLock, writeWaiting,
  setUpProjects, updateFacts, releaseFacts, readQuestions, openQuestions, cleanVersion, projectName, nowMs, iso, readJson, hasAppDetails,
} from "./owner/records.mjs";
import { stageWords, releaseNotes } from "./owner/words.mjs";
import { ownerBranchMove } from "./owner/owner-gh.mjs";
import { runAs, shellAs } from "./owner/run.mjs";
import { tokenFor, missingRecords, forgeState, forgeCommand } from "./owner/access.mjs";
import { TITLE as QUESTIONS_TITLE } from "./owner/questions.mjs";

// forOwner: what the owner reads when this step is not working (never its internal name)
export const STEP = { name: "owner-releases", everyMinutes: 15, maxMinutes: 120, inRound: false, forOwner: "the watch on your releases" };
export const SETTINGS = [
  { key: "forge.state_dir", required: false, default: DEFAULT_STATE, meaning: "the Forge's private state: setup's records, the App details and the release records" },
  { key: "forge.config", required: false, default: "/etc/godspeed-forge/config.json", meaning: "the Forge's own config, whose commands.python runs the factory's pause and unpause" },
  { key: "steps.owner-releases.python", required: false, default: "the Forge config's commands.python, else python3", meaning: "the Python that runs the factory's pause and unpause" },
  { key: "steps.owner-releases.gh", required: false, default: "the Forge config's commands.gh, else gh", meaning: "the gh signed in as the owner, used only when GitHub refuses the release App a move of staging that brings in a change to the project's workflow files" },
  { key: "steps.owner-releases.check_minutes", required: false, default: 25, meaning: "how long one of the project's checks may run on a candidate" },
  { key: "steps.owner-releases.work_dir", required: false, default: "<server.work_root>/candidates", meaning: "where the temporary worktree of a candidate is made (the factory's account must be able to write there)" },
  { key: "projects[].profile.staging_url", required: false, default: "none: the pre-release's page", meaning: "per project: the address of the staging copy, sent as the link to try" },
  { key: "projects[].profile.deploy", required: false, default: "none", meaning: "per project: a command that puts the candidate on the staging copy once the branch staging moved" },
  { key: "projects[].profile.health", required: false, default: "none", meaning: "per project: a command that succeeds and prints the running commit once the staging copy is up" },
];

const dig = (o, key) => key.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
const QUIET_TITLES = new Set([QUESTIONS_TITLE, "Loop metrics"]);
const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const DAY = 24 * 3600 * 1000;

// The older one-owner stage step drives this project's releases (its `releases` block), so this step never stages it.
export const olderStepStages = (settings, project) => !!(project && project.releases && dig(settings, "steps.stage.enabled") !== false);
const profileOf = project => ({ ...(project || {}), ...((project && project.profile) || {}) });

export const forgePython = settings => forgeCommand(settings, "owner-releases", "python", "python3");
export const forgeGh = settings => forgeCommand(settings, "owner-releases", "gh", "gh");

function authorKind(item, repository, settings) {
  const user = item.user || {};
  const login = String(user.login || "");
  if (user.type === "Bot" || /\[bot\]$/i.test(login)) return "factory";
  const owners = [dig(settings, "owner.github_login"), repository.split("/")[0]].filter(Boolean).map(s => String(s).toLowerCase());
  if (owners.includes(login.toLowerCase()) || ["OWNER", "MEMBER", "COLLABORATOR"].includes(item.author_association)) return "owner";
  return "stranger";
}
const labelsOf = item => (item.labels || []).map(l => (typeof l === "string" ? l : l && l.name)).filter(Boolean);
// Ticket 02's order for what a release takes first: what is wrong for the people using it (bug reports), then what
// the owner found, then the rest; the oldest first within each. The facts list the open issues in that order.
const BUG = /\b(?:bugs?|defects?|regressions?|broken|crash\w*|errors?)\b/i;
export const rank = row => (row.labels.some(l => BUG.test(l)) || BUG.test(row.title) ? 0 : row.author === "owner" ? 1 : 2);
const ordered = rows => [...rows].sort((a, b) => rank(a) - rank(b) || b.ageDays - a.ageDays || a.number - b.number);

// ---------------------------------------------------------------- the project's own checks on the candidate
const countOf = (text, pattern) => {
  const both = /(\d+)\s+of\s+(\d+)\s+pass/i.exec(text);
  if (both) return { passed: Number(both[1]), total: Number(both[2]) };
  if (pattern) {
    try {
      const m = new RegExp(pattern).exec(text);
      if (m && m[2] !== undefined) return { passed: Number(m[1]), total: Number(m[2]) };
    } catch { /* a pattern that is not a regular expression gives no count */ }
  }
  return null;
};

// -> [{ name, ok, sentence? }]. Pauses the factory's scheduled laps for the run and always unpauses, also when a
// check fails, throws or times out; a pause someone else made stays. record.pausedByUs is saved before the pause,
// so a run that is killed has its pause lifted by the next one.
export async function runChecks(ctx, project, record, save) {
  const settings = ctx.settings || {};
  const checkout = project.checkout;
  const minutes = Number(dig(settings, "steps.owner-releases.check_minutes") || 25);
  const python = forgePython(settings);
  const pauseFile = path.join(checkout, ".factory", "PAUSE");
  const results = [];
  const workRoot = dig(settings, "steps.owner-releases.work_dir") || path.join(dig(settings, "server.work_root") || path.join(dig(settings, "server.factory_home") || "/tmp", "factory-driver"), "candidates");
  const tree = path.join(workRoot, `${projectName(project.repository)}-${record.version}-${Date.now()}`);
  let pausedByUs = false;
  try {
    if (!fs.existsSync(pauseFile)) {
      record.pausedByUs = true;
      await save();
      pausedByUs = true;
      const p = runAs(settings, python, ["factory/consumer.py", "pause"], { cwd: checkout, timeoutMs: 120000 });
      if (p.status !== 0 && ctx.log) ctx.log(`could not pause the factory of ${project.repository}; the checks run anyway`);
    }
    runAs(settings, "git", ["-C", checkout, "fetch", "--quiet", "origin"], { timeoutMs: 300000 });
    runAs(settings, "mkdir", ["-p", workRoot]);
    const add = runAs(settings, "git", ["-C", checkout, "worktree", "add", "--detach", tree, record.candidate.commit], { timeoutMs: 300000 });
    if (add.status !== 0) return [{ name: "setup", ok: false, sentence: stageWords.check.setup }];
    const config = readJson(path.join(tree, "harness", "harness.config.json"), {}) || {};
    for (const name of ["static", "unit"]) {
      const line = typeof config[name] === "string" ? config[name].trim() : "";
      if (!line) continue;
      let r = shellAs(settings, line, { cwd: tree, timeoutMs: minutes * 60000 });
      if (r.status !== 0) r = shellAs(settings, line, { cwd: tree, timeoutMs: minutes * 60000 }); // once more, only this one
      if (r.status === 0) { results.push({ name, ok: true }); continue; }
      const sentence = r.timedOut ? stageWords.check.timeout(name, minutes)
        : r.error || r.status === 127 ? stageWords.check.start(name)
        : name === "static" ? stageWords.check.static : stageWords.check.unit(countOf(`${r.stdout}\n${r.stderr}`, config.unit_count_pattern));
      results.push({ name, ok: false, sentence });
    }
    return results;
  } catch (e) {
    if (ctx.log) ctx.log(`the checks of ${project.repository} ${record.version} stopped: ${e && e.message}`);
    return [...results, { name: "unfinished", ok: false, sentence: stageWords.check.unfinished }];
  } finally {
    if (pausedByUs) runAs(settings, python, ["factory/consumer.py", "unpause"], { cwd: checkout, timeoutMs: 120000 });
    record.pausedByUs = false;
    try { runAs(settings, "git", ["-C", checkout, "worktree", "remove", "--force", tree], { timeoutMs: 120000 }); } catch { /* the folder goes with the next prune */ }
  }
}

// ---------------------------------------------------------------- one project
// What the facts are made from, read from GitHub through the project's builder App.
async function readProject(ctx, state, project) {
  const repository = project.repository;
  const rp = repoPath(repository);
  const reader = githubClient({ token: await tokenFor(ctx, state, repository, "builder"), api: ctx.githubApi, fetch: ctx.fetch });
  const info = await reader.get(rp);
  const branch = (info && info.default_branch) || "main";
  const latest = await reader.get(`${rp}/releases/latest`);
  const openAll = await reader.list(`${rp}/issues?state=open`, 3);
  const openPulls = await reader.list(`${rp}/pulls?state=open`, 1);
  const closedPulls = await reader.list(`${rp}/pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc`, 2);
  let runs = [];
  try { runs = await reader.list(`${rp}/commits/${encodeURIComponent(branch)}/check-runs`, 1); } catch { runs = []; }
  return { reader, rp, branch, latest, openAll, openPulls, closedPulls, runs };
}

// The project's facts file, refreshed once, without moving any release: what setup writes at its end, so the
// owner's first "plan release" finds the project before the driver's first round. ctx: { settings, githubApi, fetch }.
export async function refreshFacts(ctx, gs, state, project, now = Date.now()) {
  await writeFacts(ctx, gs, state, project, nowMs(now), await readProject(ctx, state, project));
}

async function lookAt(ctx, gs, state, project, now) {
  const settings = ctx.settings || {};
  const repository = project.repository;
  const said = [];
  const read = await readProject(ctx, state, project);
  const { reader, rp, branch, closedPulls } = read;
  const P = forgePaths(state);
  const lock = fn => withLock(P.releaseLock(repository), fn);
  const fresh = version => releaseRecord(state, repository, version);

  let record = activeRelease(releaseRecords(state, repository));
  if (record && !olderStepStages(settings, project)) {
    if (record.state === "checking") {
      // a run that was stopped in the middle of the checks: lift its pause, and the release did not pass
      const r = fresh(record.version);
      if (r.pausedByUs && project.checkout) runAs(settings, forgePython(settings), ["factory/consumer.py", "unpause"], { cwd: project.checkout, timeoutMs: 120000 });
      await lock(async () => {
        const x = fresh(record.version);
        if (x.state !== "checking") return;
        Object.assign(x, { state: "failed", pausedByUs: false, failed: { at: iso(now), sentences: [stageWords.check.unfinished] } });
        await saveRelease(state, x);
      });
      record = fresh(record.version);
      await gs.sendToOwner(stageWords.failedChecks(repository, record.version, record.failed.sentences), { id: `forge-release-failed-${repository}-${record.version}` });
      said.push(`${record.version}: the checks did not finish`);
    } else if (record.state === "building") {
      said.push(...(await advance(ctx, gs, state, project, record, { reader, rp, branch, closedPulls, now, lock, fresh })));
      record = fresh(record.version);
    } else if (record.state === "checked") {
      // its checks passed and GitHub refused a step of putting it up to try: the step is tried again, nothing twice
      said.push(...(await putUp(ctx, gs, state, project, fresh(record.version), { rp, now })));
    } else if (record.state === "staged" && record.staging && record.staging.link) {
      // The one message is sent again on every run until it has left: the bridge sends each id once, so a message that
      // failed to leave (as the first real staging message did) is not lost, and a sent one is never repeated.
      const out = await gs.sendToOwner(stageWords.ready(repository, record.version, record.staging.link), { id: `forge-release-staged-${repository}-${record.version}` });
      if (out && out.sent) said.push(`${record.version}: ready to try`);
    } else if (record.state === "failed" && record.failed) {
      const words = record.failed.staging ? stageWords.stagingFailed(repository, record.version) : stageWords.failedChecks(repository, record.version, record.failed.sentences || []);
      const out = await gs.sendToOwner(words, { id: `forge-release-failed-${repository}-${record.version}` });
      if (out && out.sent) said.push(`${record.version}: did not pass`);
    }
  }

  await writeFacts(ctx, gs, state, project, now, read);
  return said;
}

async function writeFacts(ctx, gs, state, project, now, { branch, latest, openAll, openPulls, closedPulls, runs }) {
  const settings = ctx.settings || {};
  const repository = project.repository;
  const records = releaseRecords(state, repository);
  const newest = records.at(-1) || null;
  const active = activeRelease(records);
  const pub = publicRelease(records);
  const questions = openQuestions(readQuestions(state)).filter(q => q.repository === repository).length;
  const age = at => Math.max(0, Math.floor((now - Date.parse(at)) / DAY));
  const row = item => ({ number: item.number, title: item.title, labels: labelsOf(item), ageDays: age(item.created_at), author: authorKind(item, repository, settings) });
  const latestVersion = latest ? (cleanVersion(latest.tag_name) || latest.tag_name) : null;
  const status = active ? ({ filing: "being built", building: "being built", checking: "being built", checked: "being built", staged: "on staging", failed: "waiting for the owner" })[active.state]
    : questions ? "waiting for the owner" : pub || latest ? "public" : "idle";
  await updateFacts(gs, repository, () => ({
    repository, name: projectName(repository), updated: iso(now), defaultBranch: branch,
    status: questions && status === "being built" ? "being built, waiting for the owner" : status,
    newestPublicRelease: latest ? { version: latestVersion, tag: latest.tag_name, name: latest.name || latest.tag_name, publishedAt: latest.published_at || null, url: latest.html_url || null } : null,
    mergedSince: closedPulls.filter(pr => pr.merged_at && (!latest || !latest.published_at || pr.merged_at > latest.published_at))
      .map(pr => ({ number: pr.number, title: pr.title, mergedAt: pr.merged_at, author: authorKind(pr, repository, settings) })),
    openIssues: ordered(openAll.filter(i => !i.pull_request && !QUIET_TITLES.has(String(i.title).trim())).map(row)),
    openPullRequests: openPulls.map(row),
    failingChecksOnMain: [...new Set(runs.filter(r => FAILING.has(r.conclusion)).map(r => r.name))],
    laterFromLastPlan: newest ? newest.later || null : null,
    release: releaseFacts(active || newest),
    public: pub ? { version: pub.version, at: pub.public && pub.public.at, url: pub.public && pub.public.url } : latest ? { version: latestVersion, at: latest.published_at || null, url: latest.html_url || null } : null,
    waitingForOwner: { questions, staged: !!(active && active.state === "staged") },
  }));
}

// A building release: what each item's issue says now; one sentence for an item closed without a change; and,
// when every item is done, the freeze, the checks and the one message.
async function advance(ctx, gs, state, project, record, { reader, rp, branch, closedPulls, now, lock, fresh }) {
  const settings = ctx.settings || {};
  const repository = project.repository;
  const said = [];
  const looked = [];
  for (const item of record.items) {
    if (!item.issue || !item.issue.number) { looked.push({ n: item.n, state: "open" }); continue; }
    const issue = await reader.get(`${rp}/issues/${item.issue.number}`);
    if (issue && issue.state === "open") { looked.push({ n: item.n, state: "open" }); continue; }
    let pull = closedPulls.find(pr => pr.merged_at && (!pr.base || pr.base.ref === branch) && referencedIssues(pr.body).includes(item.issue.number));
    if (!pull && issue) {
      const comments = await reader.list(`${rp}/issues/${item.issue.number}/comments`, 2);
      const linked = [...new Set(comments.flatMap(c => [...String(c.body || "").matchAll(/\/pull\/(\d+)\b/g)].map(m => Number(m[1]))))];
      for (const n of linked) {
        const pr = await reader.get(`${rp}/pulls/${n}`);
        if (pr && pr.merged_at && (!pr.base || pr.base.ref === branch)) { pull = pr; break; }
      }
    }
    looked.push(pull ? { n: item.n, state: "done", done: { pr: pull.number, commit: pull.merge_commit_sha, mergedAt: pull.merged_at } } : { n: item.n, state: "undone" });
  }
  const tell = [];
  await lock(async () => {
    const r = fresh(record.version);
    if (r.state !== "building") return;
    for (const l of looked) {
      const item = r.items.find(i => i.n === l.n);
      if (l.state === "done") { item.done = l.done; delete item.closedUndone; }
      else if (l.state === "open") { delete item.done; delete item.closedUndone; }
      else {
        delete item.done;
        item.closedUndone ||= { at: iso(now) };
        if (!item.closedUndone.told) tell.push(item);
      }
    }
    await saveRelease(state, r);
  });
  for (const item of tell) {
    await gs.sendToOwner(stageWords.closedUndone(repository, record.version, item.title), { id: `forge-release-undone-${repository}-${record.version}-${item.n}` });
    await lock(async () => {
      const r = fresh(record.version);
      const i = r.items.find(x => x.n === item.n);
      if (i && i.closedUndone) { i.closedUndone.told = iso(now); await saveRelease(state, r); }
    });
    said.push(`${record.version}: "${item.title}" was closed without a change`);
  }
  if (looked.some(l => l.state !== "done")) return said;

  // every item is done: the freeze, on the newest of the merges
  const done = looked.map(l => l.done).filter(d => d && d.commit).sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt)));
  const commit = done.at(-1) && done.at(-1).commit;
  if (!commit) return said;
  const releaser = githubClient({ token: await tokenFor(ctx, state, repository, "release"), api: ctx.githubApi, fetch: ctx.fetch });
  const tag = `candidate/${record.version}`;
  const made = await makeTag(releaser, repository, tag, commit);
  if (made === "elsewhere") throw new Error(`the tag ${tag} already points at another commit, so ${record.version} was not frozen`);
  let r;
  await lock(async () => {
    r = fresh(record.version);
    if (r.state !== "building") { r = null; return; }
    Object.assign(r, { state: "checking", candidate: { commit, tag, at: iso(now) }, checkRuns: 1 });
    await saveRelease(state, r);
  });
  if (!r) return said;
  const save = () => saveRelease(state, r);
  const checks = project.checkout ? await runChecks(ctx, project, r, save) : [{ name: "setup", ok: false, sentence: stageWords.check.setup }];
  r.checks = checks;
  const failed = checks.filter(c => !c.ok);
  if (failed.length) {
    Object.assign(r, { state: "failed", failed: { at: iso(now), sentences: failed.map(c => c.sentence) } });
    await save();
    await gs.sendToOwner(stageWords.failedChecks(repository, r.version, r.failed.sentences), { id: `forge-release-failed-${repository}-${r.version}` });
    said.push(`${r.version}: the checks failed`);
    return said;
  }
  r.state = "checked";
  await save();
  return [...said, ...(await putUp(ctx, gs, state, project, r, { rp, now, releaser }))];
}

// A candidate that passed its checks: the pre-release to try, the branch staging, the profile's own staging copy,
// and the one message. Each GitHub step is safe to repeat, so a refusal half way is tried again by the next run.
async function putUp(ctx, gs, state, project, r, { rp, now, releaser }) {
  const settings = ctx.settings || {};
  const repository = project.repository;
  const said = [];
  const save = () => saveRelease(state, r);
  const { commit, tag } = r.candidate;
  releaser ||= githubClient({ token: await tokenFor(ctx, state, repository, "release"), api: ctx.githubApi, fetch: ctx.fetch });
  const notes = releaseNotes(r);
  let pre = await releaser.get(`${rp}/releases/tags/${encodeURIComponent(tag)}`);
  if (!pre) pre = await releaser.post(`${rp}/releases`, { tag_name: tag, target_commitish: commit, name: `${r.version} (to try)`, body: notes, prerelease: true, draft: false, make_latest: "false" });
  r.prerelease = { id: pre.id, url: pre.html_url };
  if (r.stagingBefore === undefined) r.stagingBefore = await refCommit(releaser, repository, "heads/staging");
  await setBranch(releaser, repository, "staging", commit, { ownerMove: ownerBranchMove(forgeGh(settings)) });
  await save();
  const profile = profileOf(project);
  if (profile.deploy || profile.health) {
    const minutes = Number(dig(settings, "steps.owner-releases.check_minutes") || 25);
    const env = { FORGE_CANDIDATE_COMMIT: commit, FORGE_VERSION: r.version };
    let ok = true;
    if (profile.deploy) ok = shellAs(settings, String(profile.deploy), { cwd: project.checkout, timeoutMs: minutes * 60000, env }).status === 0;
    if (ok && profile.health) {
      const h = shellAs(settings, String(profile.health), { cwd: project.checkout, timeoutMs: 5 * 60000, env });
      ok = h.status === 0 && h.stdout.includes(commit.slice(0, 7));
    }
    if (!ok) {
      Object.assign(r, { state: "failed", failed: { at: iso(now), sentences: [], staging: true } });
      await save();
      await gs.sendToOwner(stageWords.stagingFailed(repository, r.version), { id: `forge-release-failed-${repository}-${r.version}` });
      said.push(`${r.version}: the staging copy did not take it`);
      return said;
    }
  }
  const link = profile.staging_url || pre.html_url;
  Object.assign(r, { state: "staged", staging: { at: iso(now), link } });
  await save();
  await gs.sendToOwner(stageWords.ready(repository, r.version, link), { id: `forge-release-staged-${repository}-${r.version}` });
  said.push(`${r.version}: ready to try`);
  return said;
}

// -> { ok, summary, error? }
export async function run(ctx) {
  const settings = ctx.settings || {};
  const state = forgeState(settings);
  const registered = new Map(setUpProjects(state).map(p => [p.repository, p]));
  const setUp = (ctx.projects || []).filter(p => p && registered.has(p.repository))
    .map(p => ({ ...p, checkout: p.checkout || registered.get(p.repository).checkout }));
  if (!setUp.length) return { ok: true, summary: "owner-releases: no project here is set up with the Forge" };
  // a project whose App details this server does not hold is skipped before Godspeed is even looked for
  const projects = setUp.filter(p => hasAppDetails(state, p.repository));
  const skipped = setUp.filter(p => !projects.includes(p)).map(p => p.repository);
  if (!projects.length) return { ok: true, summary: `owner-releases: nothing to do; skipped (no App details): ${skipped.join(", ")}` };
  let gs;
  try { gs = typeof ctx.godspeed === "function" ? await ctx.godspeed() : null; }
  catch (e) { return { ok: false, summary: "owner-releases: Godspeed could not be reached", error: String(e && e.message || e).slice(0, 300) }; }
  if (!gs) return { ok: false, summary: "owner-releases: no way to reach Godspeed", error: "the driver gave the step no bridge to Godspeed" };
  const now = nowMs(ctx.now);
  const said = [], errors = [];
  for (const project of projects) {
    try { said.push(...(await lookAt(ctx, gs, state, project, now)).map(s => `${project.repository} ${s}`)); }
    catch (e) {
      if (missingRecords(e)) skipped.push(project.repository);
      else errors.push(`${project.repository}: ${String(e && e.message || e).slice(0, 200)}`);
    }
  }
  try { await writeWaiting(gs, state, now); } catch (e) { errors.push(`waiting list: ${String(e && e.message || e).slice(0, 200)}`); }
  const summary = `owner-releases: ${said.length ? said.join("; ") : "nothing new"}${skipped.length ? `; skipped (no App details): ${skipped.join(", ")}` : ""}`;
  return errors.length ? { ok: false, summary, error: errors.join("; ").slice(0, 400) } : { ok: true, summary };
}
