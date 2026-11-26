// The owner-questions step (ticket 03 of the Forge 0.1.0 plan, for every project set up with the Forge): every
// 15 minutes it reads each project's open "Owner decisions needed" issue (the pinned manager's format, see
// owner/questions.mjs), decides for each new question whether it is the owner's (what the software should do for
// the people using it) or the factory's (how it is built: never sent), and tells the owner each of theirs once
// through Godspeed (ctx.godspeed(), the bridge), with a short handle (F1, F2, ...), an example, one sentence per
// choice, the default and when it applies, and the exact words to reply with. The owner's answer comes back
// through the chat as an `answer` request (lib/owner/questions.mjs), which posts it on the issue.
//
// It says once when the questions issue disappears while the factory waits for the owner. What it told, kept
// back and posted is in the Forge's private state (owner-questions/state.json), so nothing is said twice, also
// across restarts. Toward GitHub it only reads, through the project's builder App. It writes waiting.json whole.
//
// A project the Forge has not set up, or whose App details this server does not hold, is skipped quietly. While
// the older questions step is configured (steps.questions.godspeed_dir), that step answers and this one does
// nothing, so no question is told twice.
import fs from "node:fs";
import { tokenFor, missingRecords, forgeState, factoryLogins } from "./owner/access.mjs";
import { projectAgent, agentProgram, detectAgent } from "./owner/agent.mjs";
import { githubClient, repoPath } from "./owner/github.mjs";
import { DEFAULT_STATE, forgePaths, readQuestions, saveQuestions, withLock, writeWaiting, setUpProjects, projectName, nowMs, iso, hasAppDetails } from "./owner/records.mjs";
import { parseQuestions, pickIssue, openedBy, classify, decidesQuestion, agentPrompt, readAgentAnswer, fallbackWords, fallbackFor, OWNER_LABEL, idOf } from "./owner/questions.mjs";
import { questionMessage, questionsGone, questionDecided } from "./owner/words.mjs";
import { runAs } from "./owner/run.mjs";

// forOwner: what the owner reads when this step is not working (never its internal name)
export const STEP = { name: "owner-questions", everyMinutes: 15, maxMinutes: 15, inRound: false, forOwner: "the watch on the factory's questions" };
export const SETTINGS = [
  { key: "forge.state_dir", required: false, default: DEFAULT_STATE, meaning: "the Forge's private state: setup's records, the App details, the release records and what this step told" },
  { key: "steps.owner-questions.agent", required: false, default: "the project's own agent (its file's \"agent\", which setup writes), else setup's record of it, else the one signed in on this server", meaning: "the coding agent asked once when it is unclear whose a question is, and for the plain words of the owner's: claude or codex" },
  { key: "steps.owner-questions.model", required: false, default: "haiku for Claude Code, the agent's own default for Codex", meaning: "the model of that one cheap call" },
  { key: "steps.owner-questions.agent_command", required: false, default: "none", meaning: "a command (a list) that replaces the agent; the prompt is added as its last argument and it answers on its output" },
  { key: "steps.owner-questions.agent_tries", required: false, default: 3, meaning: "runs in which an unclear question may wait for the agent; after them it is left to the factory's own default and never sent" },
  { key: "steps.owner-questions.gh", required: false, default: "the Forge config's commands.gh, else gh", meaning: "the gh whose sign-in the factory runs as; its login is one of the two identities whose questions issue is trusted" },
  { key: "projects[].agent", required: false, default: "what setup used; else the one signed in on this server", meaning: "per project: the coding agent the project uses (claude or codex); setup writes it" },
];

const dig = (o, key) => key.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
// The older, one-owner questions step is configured and on: it tells and relays, so this step stays quiet.
export const olderStepAnswers = settings => !!(dig(settings, "steps.questions.godspeed_dir") && dig(settings, "steps.questions.enabled") !== false);

// The command of the one cheap call: the project's coding agent (claude or codex, owner/agent.mjs), headless; null
// when no agent is known, and then nothing is asked.
export function agentCommand(settings, agent, prompt) {
  const own = dig(settings, "steps.owner-questions.agent_command");
  if (Array.isArray(own) && own.length) return [...own.map(String), prompt];
  if (agent !== "claude" && agent !== "codex") return null;
  const base = agentProgram(settings, agent);
  const model = dig(settings, "steps.owner-questions.model");
  if (agent === "codex") return [...base, "exec", "--skip-git-repo-check", ...(model ? ["-m", String(model)] : []), prompt];
  return [...base, "-p", "--model", String(model || "haiku"), "--output-format", "text", prompt];
}

async function askAgent(ctx, project, q, agent) {
  const prompt = agentPrompt(project.repository, q);
  let out = null;
  try {
    if (ctx.impl && ctx.impl.agent) out = await ctx.impl.agent(prompt, { repository: project.repository, agent });
    else {
      const command = agentCommand(ctx.settings, agent, prompt);
      if (!command) return null;
      const [cmd, ...args] = command;
      const cwd = project.checkout && fs.existsSync(project.checkout) ? project.checkout : undefined;
      const r = runAs(ctx.settings, cmd, args, { cwd, timeoutMs: 120000, env: { IS_SANDBOX: "1" } });
      if (r.status === 0) out = r.stdout;
    }
  } catch { out = null; }
  return out === null ? null : readAgentAnswer(out, q);
}

const labelNames = item => (item.labels || []).map(l => (typeof l === "string" ? l : l && l.name)).filter(Boolean);

async function lookAt(ctx, gs, state, project, now) {
  const repository = project.repository;
  const P = forgePaths(state);
  const gh = githubClient({ token: await tokenFor(ctx, state, repository, "builder"), api: ctx.githubApi, fetch: ctx.fetch });
  const issues = await gh.list(`${repoPath(repository)}/issues?state=open`, 3);
  // only the factory's own questions issue counts: one opened by the builder App or by the gh sign-in it runs as
  const cached = readQuestions(state).ghLogin || null;
  const who = await factoryLogins(ctx.settings, state, project, { ...(ctx.impl && ctx.impl.gh ? { gh: ctx.impl.gh } : {}), cached });
  const issue = pickIssue(issues, who.logins);
  const waitingOnOwner = issues.some(i => labelNames(i).includes(OWNER_LABEL));
  const said = [];
  if (!issue) {
    await withLock(P.questionsLock, async () => {
      const q = readQuestions(state);
      const open = q.questions.filter(x => x.repository === repository && x.status === "told");
      for (const x of open) { x.status = "withdrawn"; x.withdrawnAt = iso(now); }
      if ((open.length || waitingOnOwner) && !q.gone[repository]) {
        const count = Number((q.goneCount || {})[repository] || 0) + 1;
        await gs.sendToOwner(questionsGone(repository), { id: `forge-questions-gone-${idOf(repository, String(count))}` });
        q.gone[repository] = { at: iso(now) };
        q.goneCount = { ...(q.goneCount || {}), [repository]: count };
        said.push("the questions are gone");
      }
      await saveQuestions(state, q);
    });
    return said;
  }
  const parsed = parseQuestions(issue.body).filter(x => !x.note);
  // Who answers, and the owner's words, are worked out before the record is locked: the agent may take a while.
  const before = readQuestions(state);
  const known = new Map(before.questions.filter(x => x.repository === repository).map(x => [x.key, x]));
  const fresh = parsed.filter(x => !known.has(x.key) || known.get(x.key).status === "pending");
  const agent = fresh.length ? projectAgent(ctx.settings, project, state, { detect: (ctx.impl && ctx.impl.detectAgent) || detectAgent }) : null;
  let comments = null;
  const decided = new Map();
  // a question the owner, or the manager, already settled on GitHub is never sent, and one sent is withdrawn
  const open = parsed.filter(x => !known.has(x.key) || ["pending", "told"].includes(known.get(x.key).status));
  if (open.length) {
    comments = await gh.list(`${repoPath(repository)}/issues/${issue.number}/comments`, 5);
    for (const pq of open) {
      const rec = known.get(pq.key);
      const ours = rec && rec.qid ? String(rec.qid) : null;
      if (comments.some(c => !(ours && String(c.body || "").includes(ours)) && decidesQuestion(c, pq, who.logins))) decided.set(pq.key, { status: "answered-elsewhere" });
    }
  }
  for (const pq of fresh) {
    if (decided.has(pq.key)) continue;
    let kind = classify(pq);
    let words = null, asked = false;
    if (kind !== "how") {
      const a = await askAgent(ctx, project, pq, agent);
      asked = true;
      if (a && kind === "unclear") kind = a.for === "factory" ? "how" : "what";
      if (a && a.words) words = a.words;
    }
    decided.set(pq.key, { kind, words, asked });
  }
  await withLock(P.questionsLock, async () => {
    const q = readQuestions(state);
    if (q.gone[repository]) delete q.gone[repository];
    if (who.ghLogin) q.ghLogin = who.ghLogin;
    const mine = q.questions.filter(x => x.repository === repository);
    const keys = new Set(parsed.map(x => x.key));
    for (const x of mine) if (x.status === "told" && !keys.has(x.key)) { x.status = "withdrawn"; x.withdrawnAt = iso(now); }
    const tries = Number(dig(ctx.settings, "steps.owner-questions.agent_tries") || 3);
    for (const pq of parsed) {
      let rec = q.questions.find(x => x.repository === repository && x.key === pq.key);
      if (!rec) {
        rec = { repository, key: pq.key, qid: idOf(repository, pq.key), status: "pending", tries: 0, firstSeen: iso(now) };
        q.questions.push(rec);
      }
      Object.assign(rec, { issue: issue.number, openedBy: openedBy(issue), number: pq.number, heading: pq.heading, options: pq.options });
      const d = decided.get(pq.key);
      if (rec.status === "told" && d && d.status === "answered-elsewhere") {
        rec.status = "withdrawn"; rec.withdrawnAt = iso(now); rec.withdrawnFor = "decided";
        await saveQuestions(state, q);
        await gs.sendToOwner(questionDecided(repository, rec.handle), { id: `forge-question-decided-${rec.qid}` });
        said.push(`${rec.handle} withdrawn, already decided`);
        continue;
      }
      if (rec.status !== "pending" || !d) continue;
      if (d.status === "answered-elsewhere") { rec.status = "answered-elsewhere"; continue; }
      let kind = d.kind;
      if (d.asked) rec.tries = Number(rec.tries || 0) + 1;
      if (kind === "unclear") {
        if (rec.tries < tries) continue; // asked again next run
        // the agent could not say whose it is: it is never put to the owner as if it were theirs; the factory's own
        // default applies, and nothing is said
        rec.kind = "unclear"; rec.status = "kept"; rec.keptAt = iso(now);
        continue;
      }
      rec.kind = kind;
      if (kind === "how") { rec.status = "kept"; rec.keptAt = iso(now); continue; }
      const words = d.words || fallbackWords(pq);
      const handle = rec.handle || `F${q.next++}`;
      rec.handle = handle;
      const text = questionMessage(repository, handle, words, { deadline: pq.deadline, fallback: fallbackFor(pq), recommended: pq.recommended, link: issue.html_url || null });
      await saveQuestions(state, q); // the handle is kept before anything is sent
      await gs.sendToOwner(text, { id: `forge-question-${rec.qid}` });
      const about = words.question || words.example || pq.heading.replace(/\s*\([^)]*#\d+[^)]*\)/g, "").trim();
      Object.assign(rec, { status: "told", toldAt: iso(now), choices: words.choices, text: `${projectName(repository)}: ${about}` });
      await saveQuestions(state, q);
      said.push(`${handle} told`);
    }
    await saveQuestions(state, q);
  });
  return said;
}

// -> { ok, summary, error? }
export async function run(ctx) {
  const settings = ctx.settings || {};
  const state = forgeState(settings);
  if (olderStepAnswers(settings)) return { ok: true, summary: "owner-questions: the questions step answers for these projects, so nothing was done" };
  const registered = new Set(setUpProjects(state).map(p => p.repository));
  const setUp = (ctx.projects || []).filter(p => p && registered.has(p.repository));
  if (!setUp.length) return { ok: true, summary: "owner-questions: no project here is set up with the Forge" };
  // a project whose App details this server does not hold is skipped before Godspeed is even looked for
  const projects = setUp.filter(p => hasAppDetails(state, p.repository));
  const skipped = setUp.filter(p => !projects.includes(p)).map(p => p.repository);
  if (!projects.length) return { ok: true, summary: `owner-questions: nothing to do; skipped (no App details): ${skipped.join(", ")}` };
  let gs;
  try { gs = typeof ctx.godspeed === "function" ? await ctx.godspeed() : null; }
  catch (e) { return { ok: false, summary: "owner-questions: Godspeed could not be reached", error: String(e && e.message || e).slice(0, 300) }; }
  if (!gs) return { ok: false, summary: "owner-questions: no way to reach Godspeed", error: "the driver gave the step no bridge to Godspeed" };
  const now = nowMs(ctx.now);
  const said = [], errors = [];
  for (const project of projects) {
    try { said.push(...(await lookAt(ctx, gs, state, project, now)).map(s => `${project.repository}: ${s}`)); }
    catch (e) {
      if (missingRecords(e)) skipped.push(project.repository);
      else errors.push(`${project.repository}: ${String(e && e.message || e).slice(0, 200)}`);
    }
  }
  try { await writeWaiting(gs, state, now); } catch (e) { errors.push(`waiting list: ${String(e && e.message || e).slice(0, 200)}`); }
  const summary = `owner-questions: ${said.length ? said.join("; ") : "nothing new"}${skipped.length ? `; skipped (no App details): ${skipped.join(", ")}` : ""}`;
  return errors.length ? { ok: false, summary, error: errors.join("; ").slice(0, 400) } : { ok: true, summary };
}
