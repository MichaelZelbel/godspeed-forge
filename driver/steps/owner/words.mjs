// Every sentence the owner steps and requests say to the owner, in one place, so each is tested by its exact
// text (test/forge-owner-requests.test.mjs, test/forge-owner-steps.test.mjs). Plain English, at most one link,
// no internal names, no em or en dashes (engineering.md, "Messages to the owner").
import { projectName } from "./records.mjs";

const N = repository => projectName(repository);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = items => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const orList = items => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
export const day = ms => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(ms));
export const when = ms => {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(d).replace(",", "");
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${date}, ${time} UTC`;
};

// ---------------------------------------------------------------- the project the owner named
export const projectWords = {
  noneSetUp: () => "The Forge is not set up for any project on this server yet.",
  unknown: (named, known) => `I do not know a project called "${named}" here. The Forge is set up for ${list(known.map(projectName))}.`,
  several: names => `Which project do you mean: ${orList(names.map(projectName))}?`,
};

// ---------------------------------------------------------------- plan
export const planWords = {
  started: (repository, version, n) => `Started. ${N(repository)} ${version} is being built now, with ${plural(n, "change", "changes")}. I will tell you when it is ready to try.`,
  // the same, while the project's factory does not start work by itself (automatic work is off, as after setup)
  startedOff: (repository, version, n) => `Started. ${N(repository)} ${version} is planned, with ${plural(n, "change", "changes")}. I will tell you when it is ready to try. Automatic work is off, so nothing is built yet: say "run one lap" to watch the first change being made, then "turn on automatic work".`,
  refused: (repository, version, reason) => `I did not start ${N(repository)}${version ? ` ${version}` : ""}: ${reason} Nothing was started.`,
  already: (repository, version, ms) => `${N(repository)} ${version} was already started on ${day(ms)}, so I did not start it again.`,
  noAccess: (repository, version) => `I could not start ${N(repository)} ${version}: this server cannot reach the project on GitHub. Run setup for ${repository} again on the server, then ask me again.`,
  githubFailed: (repository, version) => `I could not finish starting ${N(repository)} ${version}: GitHub refused part of it. Ask me again in a few minutes and I will carry on where I stopped.`,
  busy: (repository, version, state) => `${N(repository)} ${version} ${state === "staged" ? "is waiting for your go" : state === "checking" || state === "checked" ? "is still being checked" : "is still being built"}. I can plan the next release once it is public or taken back.`,
  reasons: {
    noYes: "I need your own yes to start it.",
    version: v => `"${v}" is not a version number like 1.2.0.`,
    notNewer: (v, latest) => `${v} is not newer than ${latest}, the version that is public now.`,
    noItems: "the plan has no changes in it.",
    tooMany: max => `the plan has more than ${max} changes, so make it smaller.`,
    item: i => `change ${i} is missing what it is, what it changes for the people using it, its size (light, full or large) or why.`,
    notPlain: i => `change ${i} is not in everyday words yet: it names a number, a file or the factory's own terms.`,
    summaryNotPlain: "the one line about the release is not in everyday words yet: it names a number, a file or the factory's own terms.",
  },
};

// ---------------------------------------------------------------- go, take it back, release status
export const goWords = {
  public: (repository, version, url) => `${N(repository)} ${version} is public now: ${url}`,
  publicDespite: (repository, version, url) => `${N(repository)} ${version} is public now, although it did not pass its own checks: ${url}`,
  already: (repository, version) => `${N(repository)} ${version} is already public, so nothing changed.`,
  nothing: repository => `Nothing of ${N(repository)} is waiting for your go right now.`,
  building: (repository, version) => `${N(repository)} ${version} is still being built, so there is nothing to make public yet.`,
  checking: (repository, version) => `${N(repository)} ${version} is still being checked, so there is nothing to make public yet.`,
  moved: (repository, version) => `I did not make ${N(repository)} ${version} public: it changed after it was put up to try, so it has to be tried again first.`,
  tagElsewhere: (repository, version) => `I did not make ${N(repository)} ${version} public: GitHub already has a version ${version} that is something else.`,
  failed: (repository, version) => `I could not finish making ${N(repository)} ${version} public: GitHub refused a step. Say go again in a few minutes and I will finish it.`,
};
export const takeBackWords = {
  done: (repository, version, previous) => `${N(repository)} ${version} is taken back. ${previous} is public again.`,
  doneNoPrevious: (repository, version) => `${N(repository)} ${version} is taken back. No version was public before it, so none is public now, and the live copy is back where it was before.`,
  first: (repository, version) => `${N(repository)} ${version} is the first public version, so there is nothing earlier to go back to, and I changed nothing. To replace it, ask me to plan a fix.`,
  already: (repository, version) => `${N(repository)} ${version} was already taken back, so nothing changed.`,
  nothing: repository => `I have not made any version of ${N(repository)} public, so there is nothing to take back.`,
  failed: (repository, version) => `I could not finish taking back ${N(repository)} ${version}: GitHub refused a step. Ask me again in a few minutes and I will finish it.`,
};
export const statusWords = {
  building: (repository, version, done, n) => `${N(repository)} ${version} is being built: ${done} of ${n} ${n === 1 ? "change is" : "changes are"} done.`,
  stuck: (repository, version) => `${N(repository)} ${version} is stuck: a change was closed without being made.`,
  checking: (repository, version) => `${N(repository)} ${version} is finished and being checked.`,
  staged: (repository, version, link) => `${N(repository)} ${version} is ready to try${link ? ` at ${link}` : ""} and waits for your go.`,
  failed: (repository, version) => `${N(repository)} ${version} did not pass its own checks.`,
  stagingFailed: (repository, version) => `${N(repository)} ${version} could not be put on your staging copy.`,
  idle: repository => `Nothing new of ${N(repository)} is being built.`,
  publicAnd: (version, questions) => `${version ? `${version} is public` : "Nothing is public yet"}${questions ? `, and ${plural(questions, "question waits", "questions wait")} for your answer` : ""}.`,
};

// ---------------------------------------------------------------- the factory's questions
export const answerWords = {
  passed: (repository, handle) => `Your answer to ${handle} is passed on to the ${N(repository)} factory.`,
  unknown: (handle, open) => `I have no question ${handle} for you.${open.length ? ` The open ${open.length === 1 ? "one is" : "ones are"} ${list(open)}.` : " No question is waiting for your answer."}`,
  already: handle => `You already answered ${handle}, so I did not pass this on again.`,
  withdrawn: (repository, handle) => `Question ${handle} was taken back by the ${N(repository)} factory, so your answer was not passed on.`,
  missing: "Tell me which question you are answering, like F1, and your answer.",
  failed: handle => `I could not pass your answer to ${handle} on: GitHub refused it. Send it again in a few minutes.`,
  untrusted: handle => `I did not pass your answer to ${handle} on, because that question on GitHub is no longer the factory's own.`,
};

// The one message for a question of what the software should do. w: { example, choices[] }; deadline: ms or
// null; fallback: what the factory does without an answer (null when it waits).
// link: the question on GitHub, given only when nothing of it could be put in everyday words.
export function questionMessage(repository, handle, w, { deadline = null, fallback = null, link = null } = {}) {
  const lines = [`${N(repository)} has a question for you (${handle}).`];
  if (w.question) lines.push(w.question);
  if (w.example) lines.push(w.example);
  if (!w.question && !w.example) lines.push(link ? `I could not put it in everyday words, so here it is as the factory wrote it: ${link}` : "I could not put it in everyday words.");
  (w.choices || []).forEach((c, i) => lines.push(`${i + 1}. ${c}`));
  if (fallback && deadline) lines.push(`If you do not answer by ${when(deadline)}, it will ${fallback}.`);
  else if (fallback) lines.push(`If you do not answer, it will ${fallback}.`);
  else lines.push("It waits for your answer.");
  const n = (w.choices || []).length;
  const picks = Array.from({ length: n }, (_, i) => `"${handle} ${i + 1}"`);
  lines.push(n ? `Reply ${orList(picks)}, or "${handle}" and your answer in your own words.` : `Reply "${handle}" and your answer in your own words.`);
  return lines.join("\n");
}
export const questionsGone = repository => `The ${N(repository)} factory is waiting for a decision from you, but its list of questions for you is gone, so I cannot pass the question on. I will tell you as soon as it asks again.`;

// ---------------------------------------------------------------- a finished release
export const stageWords = {
  ready: (repository, version, link) => `${N(repository)} ${version} is ready to try: ${link}. Shall I make it public? Reply go.`,
  failedChecks: (repository, version, sentences) => `${N(repository)} ${version} did not pass its own checks, so it is not ready to try. ${sentences.join(" ")} To fix it, ask me to plan the next ${N(repository)} release.`,
  stagingFailed: (repository, version) => `${N(repository)} ${version} passed its own checks, but it could not be put on your staging copy, so it is not ready to try.`,
  closedUndone: (repository, version, title) => `${N(repository)} ${version} cannot be finished, because "${title}" was closed without the change being made.`,
  check: {
    static: "The code checks failed.",
    unit: count => count ? `The tests failed, ${count.passed} of ${count.total} passed.` : "The tests failed.",
    timeout: (name, minutes) => `The ${name === "static" ? "code checks" : "tests"} did not finish within ${plural(minutes, "minute", "minutes")}.`,
    start: name => `The ${name === "static" ? "code checks" : "tests"} could not start.`,
    unfinished: "The checks did not finish.",
    setup: "The copy to check could not be made on this server.",
  },
};

// The notes of a release, on the pre-release to try and on the public release: the plan's item sentences, what
// changes for the people using it.
export const releaseNotes = r => `What changes in ${r.version}:\n\n${r.items.map(i => `- ${String(i.outcome).trim()}`).join("\n")}\n`;

// ---------------------------------------------------------------- the rules every owner text is held to
const FILE = /\b[\w.-]+\.(?:md|mjs|cjs|js|jsx|ts|tsx|json|ya?ml|py|sh|toml|lock|txt|html|css)\b/i;
const INTERNAL = /\b(?:workflows?|merge gates?|judges?|holdouts?|pull requests?|tickets?|harness|scenarios?)\b/i;
// -> "" when the text may reach the owner, else why not. strict: the coding agent's words, which also may not
// talk about the factory's own machinery at all.
export function notPlain(text, { strict = false } = {}) {
  const t = String(text || "");
  if (/[–—]/.test(t)) return "a long dash";
  if (/#\d/.test(t) || /\b(?:issue|item|PR)\s*#?\d+\b/i.test(t)) return "an item number";
  if (/`/.test(t)) return "code";
  if (FILE.test(t)) return "a file name";
  if (INTERNAL.test(t)) return "an internal name";
  if ((t.match(/https?:\/\//gi) || []).length > (strict ? 0 : 1)) return strict ? "a link" : "more than one link";
  if (strict && /\b(?:branch(?:es)?|merges?|merged|CI|pipelines?|tests?|checks?|commits?|repositor(?:y|ies)|code)\b/i.test(t)) return "the factory's own terms";
  return "";
}
