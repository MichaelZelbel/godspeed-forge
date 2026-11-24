// The release clock (the Forge 0.3.1, ticket 01). Michael, 2026-11-24: "I don't want the release to sit still for even an hour
// without you fixing it", and "Will that be hard-coded so that we can rely on it?" So this is plain code with constants, decided
// from the release's own state alone, never from an AI's word or from work that happens near the release.
//
// Godspeed 2.0.0-beta.31 had every ticket done on 2026-11-23 and did not move for about 28 hours: one acting run answered
// "in-progress" naming nothing anybody could check, it got a two-hour hold, unrelated activity used up the rest of the six-hour
// moving credit, and the next escalation was due 19 hours after the release step began to wait.
//
// THE FORGE 0.3.3: the same clock now runs from the release's approval to its install, in every phase (building tickets, the stage
// step, the test machine, the scenarios), because a release's ticket nobody built stood still for two hours on 2026-11-24 while the
// clock waited for every ticket to be done. Its state gains the tickets' states (buildingState); inReleaseStep below is no longer a
// gate and is kept only for what it says about the release. The only phases without a clock are the owner's go and the wait of
// tickets that all wait on his answer.
// One clock per approved release that has not reached the owner's server:
//   - the release's STATE is the stage step's look at it (look.txt, with its minutes and timestamps taken out), its stage in the
//     auto-stage state file and its staging record; a change of any of them resets the clock and its ladder;
//   - CHECKABLE WORK pauses the clock, only while it runs and only inside its own limit: a GitHub run in progress on the candidate
//     tag, the release branch or the release's version pull request; auto-stage's STOP file younger than its limit; a freeze,
//     install or check program of the release step that is running; and the unit, GitHub run or pull request an acting run's
//     "in-progress" named, once the driver has checked it runs (or is open), for at most an hour after the answer;
//   - never work: the stage step's own repeated waiting sentence, other projects' runs, an acting run's word;
//   - by 20 minutes still an acting run (rung 1), by 40 the other AI (rung 2) whatever rung 1 said, by 60 a repair request to the
//     dead-man naming the release and both tries, and one notice to the owner naming what was tried. Rounds come every five
//     minutes, so each step is taken in the last round before its minute: never late, at most a round or two early.
// The six-hour moving credit and the 24- and 72-hour ceilings stay as outer limits (inventory.mjs); they never delay these steps.
// Pure except checkNamed, whose commands come in as `run`.
import crypto from "node:crypto";

export const STANDSTILL = Object.freeze({
  helperMinutes: 20, // rung 1: an acting run
  otherAiMinutes: 40, // rung 2: the other AI, at once, whatever rung 1 answered
  repairMinutes: 60, // the dead-man's repair request and one notice to the owner
  namedHoldMinutes: 60, // what an acting run's "in-progress" names holds the clock at most this long after the answer
  restartHours: 24, // after the repair step the ladder starts again when the release still has not moved
  firstSightMaxMinutes: 10, // a new state is counted from the last round that saw the old one, never from further back than this
  roundMinutes: 5, // the driver's round comes every five minutes (factory-driver.timer); a step is taken in the last round before its minute
  toleranceMinutes: 1, // rounds start a few seconds early or late: a round within a minute of that is still the one
  runHours: 6, // a GitHub run on the version pull request: its own timeout
  scenariosHours: 3, // a run on the candidate or release branch, and a release program, are bounded by their own start
  stopHours: 2, // auto-stage's STOP file
  claimHours: 3, // the loop's own limit on a claim (a claim older than this is no claim); the same hours the factory is told
  silentMinutes: 30, // a run that has written nothing for this long holds nothing: the same half hour progress.mjs calls not working
});
const MIN = 60000, H = 60 * MIN;

// ---------------------------------------------------------------- the release's state
// The stage step's look without what changes on every look while nothing happens: its minutes ("(for 25 minutes)", "35 minutes
// old") and its timestamps. Everything else it says is the state (a new commit named in it is a change).
export function normaliseLook(text) {
  return String(text || "").split(/\r?\n/)
    .map(l => l.replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?/g, "<time>")
      .replace(/\s*\(for \d+ (?:minute|hour)s?\)/gi, "")
      .replace(/\b\d+ (second|minute|hour|day)s?\b/gi, "<n> $1s")
      .trim())
    .filter(Boolean).join("\n");
}
// A JSON value with its keys in order, without the times of a mere look (a staging record's lastCheck.at, a server clock).
const VOLATILE = new Set(["at", "checkedAt", "lookedAt", "serverClock", "now"]);
export function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).filter(k => !VOLATILE.has(k)).sort().map(k => [k, stable(v[k])]));
  return v;
}
// The release's state is three parts, each kept as its own fingerprint, so that a part that cannot be read this round is taken
// as unchanged (the last known one) while a part that can be read and changed is a change. -> {look, stage, staging}
const h = v => crypto.createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);
export const partsOf = ({ look, autoStage, staging, build }) => ({ look: h(normaliseLook(look)), stage: h(stable(autoStage || null)), staging: h(stable(staging || null)), ...(build === undefined ? {} : { build: build === null ? null : h(build) }) });
// parts: this round's parts, null for one that could not be read; known: the clock's (or the journal's) last parts
// The ticket part exists only while some ticket is unfinished (buildingState): when it ends (the last ticket done) that is itself a change.
export const mergeParts = (parts, known) => Object.fromEntries(["look", "stage", "staging", ...(parts.build !== undefined ? ["build"] : [])].map(k => [k, parts[k] != null ? parts[k] : (known && known[k] != null ? known[k] : h(k === "look" ? "" : k === "build" ? "unread" : null))]));
export const fpOf = parts => h(parts.build != null ? [parts.look, parts.stage, parts.staging, parts.build] : [parts.look, parts.stage, parts.staging]);
// -> the release's state as one fingerprint, and its parts
export function releaseState({ look, autoStage, staging, build }) {
  const parts = partsOf({ look, autoStage, staging, build });
  return { fp: fpOf(parts), parts };
}

// Is the release in the release step's hands? While the factory still builds its tickets, each ticket has its own clock.
// stage: parseStage(look) or null; look: the look's text when it is about this release; journal: the journal's view of the
// release ({tickets, slots}) or null. A release the look does not name (none, or another one) is the release step's once
// every ticket is done: one clock per approved release.
export function inReleaseStep(id, stage, look, journal) {
  if (stage && stage.id === id) {
    if (/^Not complete yet: waiting on /m.test(String(look || ""))) return { yes: false, why: "the factory is still building its tickets" };
    return { yes: true, why: "the release step is working on it" };
  }
  const sealed = (journal && journal.tickets) || [];
  if (sealed.length && sealed.every(t => `t:${t.item}:resolved` in ((journal && journal.slots) || {}))) return { yes: true, why: stage && stage.id ? `every ticket is done, and the release step is working on ${stage.id}` : "every ticket is done and the release step says nothing about it" };
  return { yes: false, why: "the factory is still building its tickets" };
}

// ---------------------------------------------------------------- while the tickets are being built (the Forge 0.3.3)
// The same clock, the same 20/40/60 ladder, for the time before every ticket is done. On 2026-11-24 the last ticket of
// Godspeed 2.0.0-beta.32 (#616) was workable and nobody built it for about two hours: the factory's laps built other items first,
// and the per-ticket owner, "factory loop, rung 0", gives a ticket twelve hours. Michael: "I don't want the release to sit still
// for even an hour without you fixing it."
// The release is standing still while its unfinished tickets have nothing live: no claim of a run that is still writing, and no
// change since the clock began in any ticket's state (an issue opening or closing, a pull request opened, merged, given a new
// commit or a new comment, which is where a review shows). Anything of those starts the count again; an unfinished ticket that
// waits on the owner (needs-owner, on the issue or its pull request) is the parked path's, not this clock's; when every
// unfinished ticket is parked the release waits on his answer and has no clock; when none is left the ticket part is gone. A dependency that is already closed is no reason
// to wait: nothing here looks at dependencies at all, so a ticket whose dependency closed is judged like any other.
// Pure. release: world.releases[i]; world: the driver's world; -> null | { fp, work, lines, unread, open }
const claimLive = (c, now) => Number.isFinite(Date.parse(c.at)) && now - Date.parse(c.at) < STANDSTILL.claimHours * H;
export function buildingState({ release, world, now, activity = null }) {
  const items = (world && world.items) || {};
  const tickets = ((release && release.tickets) || []).filter(t => t.issue && !t.deferred);
  const factories = (world && world.factories) || [];
  const prim = factories.find(f => f.primary !== false) || (world && world.factory) || {};
  const runsRead = !((world && world.unreadable) || []).some(u => /\/runs$/.test(String(u.part || "")));
  const runs = new Map((prim.activeRuns || []).map(r => [String(r.id), r]));
  const parts = [], work = [], lines = [];
  let unread = false, open = 0, parked = 0;
  for (const t of tickets) {
    const it = items[t.issue];
    if (!it) { unread = true; parts.push(`${t.issue}|unread`); continue; }
    const prs = it.prs || [];
    const claims = (it.loopClaims || []).filter(c => claimLive(c, now));
    parts.push([t.issue, it.state, prs.map(p => `${p.number}.${p.state}.${p.merged ? 1 : 0}.${p.headSha || ""}.${(p.comments || []).length}`).join(","), claims.map(c => c.run).join(",")].join("|"));
    if (it.state !== "open") continue;
    if ((it.labels || []).includes("needs-owner") || prs.some(p => p.state === "open" && (p.labels || []).includes("needs-owner"))) { parked++; lines.push(`#${t.issue}: parked on the owner (needs-owner)`); continue; }
    open++;
    let held = false;
    for (const c of claims) {
      const r = runs.get(c.run);
      if (!runsRead) { work.push({ what: `a live claim on #${t.issue} (the factory's runs could not be read)`, until: Date.parse(c.at) + STANDSTILL.claimHours * H }); held = true; }
      else if (r) {
        const last = Date.parse(r.lastOutputAt || r.startedAt);
        const until = Math.min(Date.parse(c.at) + STANDSTILL.claimHours * H, (Number.isFinite(last) ? last : now) + STANDSTILL.silentMinutes * MIN);
        work.push({ what: `a run is building #${t.issue} (claim by run ${c.run})`, until }); held = true;
      }
    }
    const open_prs = prs.filter(p => p.state === "open").map(p => `#${p.number}`);
    lines.push(`#${t.issue}: open, ${held ? "being built" : "no live claim and no run on it"}${open_prs.length ? `, open pull request ${open_prs.join(", ")}` : ", no pull request"}`);
  }
  // a GitHub run on an unfinished ticket's pull request (its checks) holds the clock for the run's own timeout
  const heads = new Set(), branches = new Set();
  for (const t of tickets) for (const p of (((items[t.issue] || {}).prs) || [])) if (p.state === "open") { if (p.headSha) heads.add(p.headSha); if (p.headRef) branches.add(p.headRef); }
  for (const r of (activity && activity.runs) || []) {
    const at = Date.parse(r.createdAt);
    if (Number.isFinite(at) && ((r.headSha && heads.has(r.headSha)) || (r.headBranch && branches.has(r.headBranch)))) work.push({ what: `a GitHub run (${r.name || "a workflow"}) on a ticket's pull request`, until: at + STANDSTILL.runHours * H });
  }
  if (!open && !parked) return null;
  // every unfinished ticket waits on the owner's answer: the questions path owns that wait, with its own escalation to him
  return { fp: h(["build", ...parts]), work, lines, unread, open, parkedOnly: !open, total: tickets.length };
}

// ---------------------------------------------------------------- checkable work
const versionIn = s => (/(\d+\.\d+\.\d+(?:-[a-z]+\.\d+(?:\.\d+)*)?)/i.exec(String(s || "")) || [])[1] || null;
// -> [{what, until}] the work that holds the clock now (until > now). activity: readActivity's {runs, stop, procs}; autoStage: the
// release's auto-stage state (its version pull request is rs.bump); about: the stage step's look is about this release; named:
// what an acting run's in-progress named and the driver found running this round, with the time of the answer; repo: the
// release's repository (a release program names it first: freeze.mjs <repo> <version>, stage-server.mjs <repo> <version>
// --release <id>).
export function workFor({ id, activity, autoStage, about, named = [], now, repo = "", extra = [] }) {
  const out = [...extra];
  const v = versionIn(id), bump = (autoStage && autoStage.bump) || null;
  for (const r of (activity && activity.runs) || []) {
    const at = Date.parse(r.createdAt);
    if (!Number.isFinite(at)) continue;
    if (/^(candidate|release)\//.test(String(r.headBranch || "")) && v && versionIn(r.headBranch) === v) out.push({ what: `a GitHub run (${r.name || "a workflow"}) on ${r.headBranch}`, until: at + STANDSTILL.scenariosHours * H });
    else if (bump && ((bump.head && r.headSha === bump.head) || (bump.branch && r.headBranch === bump.branch))) out.push({ what: `a GitHub run (${r.name || "a workflow"}) on the version pull request${bump.pr ? ` #${bump.pr}` : ""}`, until: at + STANDSTILL.runHours * H });
  }
  // auto-stage's STOP belongs to the release the stage step works on (it writes only the main project's); its programs name the
  // release's version in their arguments, so another release's or project's never count
  if (about && activity && activity.stop && Number.isFinite(Date.parse(activity.stop.at))) out.push({ what: "auto-stage's STOP file (the scenarios run)", until: Date.parse(activity.stop.at) + STANDSTILL.stopHours * H });
  for (const p of (activity && activity.procs) || []) {
    const m = /release\/(freeze|stage-server|staging-check)\.mjs/.exec(String(p.args || ""));
    const args = String(p.args || "").split(/\s+/), ri = args.indexOf("--release");
    const mine = !!m && !!v && !!repo && args.includes(repo) && args.some(a => a === v || a.startsWith(`${v}.`)) && (ri < 0 || args[ri + 1] === id);
    if (mine && Number.isFinite(p.startedAt)) out.push({ what: `the release step's ${m[1]} program`, until: p.startedAt + STANDSTILL.scenariosHours * H });
  }
  for (const n of named || []) if (Number.isFinite(n.answeredAt)) out.push({ what: `${n.what}, which an acting run named and is running`, until: n.answeredAt + STANDSTILL.namedHoldMinutes * MIN });
  return out.filter(w => w.until > now);
}

// ---------------------------------------------------------------- the clock
// prev: this release's clock from the last round, or null. journal: what the journal holds for this release's clock ({fp, since,
// steps}), which a lost or corrupt state file cannot take away. -> { clock, due: ["helper" | "other-ai" | "repair" | "notice"] }
// A new state is counted from the last round that saw the old one (the state changed somewhere after it), so a step is never
// late against the change itself, and at most one round early.
// fp: this round's fingerprint, its unreadable parts taken from the clock's (or with no clock, the journal's) last ones
export function tick(prev, { fp, work, now, lastRoundAt, journal = null }) {
  const held = work.filter(w => w.until > now);
  let c;
  if (!(prev && prev.fp === fp) && journal && journal.fp === fp && Number.isFinite(journal.since)) {
    // the state file lost this clock: the journal has when this state began and which steps were taken (time held by work
    // since then is not known, so it counts as still: the steps come early, never late)
    const launches = [...(journal.launches || [])];
    prev = { fp, since: journal.since, stillMs: Math.max(0, now - journal.since), lastAt: now, cycleFrom: 0, done: Object.fromEntries((journal.steps || []).map(s => [s, true])), tries: [...(journal.tries || [])], launches, rung1Provider: (launches.find(l => l.rung === 1) || {}).provider, named: [] };
  }
  if (prev && prev.fp === fp) {
    c = { ...prev, done: { ...(prev.done || {}) }, tries: [...(prev.tries || [])], launches: [...(prev.launches || [])] };
    if (!held.length) c.stillMs += Math.max(0, now - c.lastAt);
  } else {
    const from = prev && Number.isFinite(prev.lastAt) ? prev.lastAt : lastRoundAt;
    const back = Number.isFinite(from) ? Math.min(Math.max(0, now - from), STANDSTILL.firstSightMaxMinutes * MIN) : 0;
    c = { fp, since: now - back, stillMs: held.length ? 0 : back, cycleFrom: 0, done: {}, tries: [], named: [] };
  }
  c.lastAt = now;
  c.held = held.map(w => w.what);
  const cycle = () => (c.stillMs - (c.cycleFrom || 0)) / MIN;
  if (c.done.repair && cycle() >= STANDSTILL.repairMinutes + STANDSTILL.restartHours * 60) { c.cycleFrom = c.stillMs; c.done = {}; c.tries = []; } // the ladder starts again
  // the last round before the minute: the next round would come after it, and a round's own work takes seconds, so a step is
  // never late against the change; it comes at most one round (two, when the change came just before a round) early
  const m = cycle() + STANDSTILL.roundMinutes + STANDSTILL.toleranceMinutes, due = [];
  if (m >= STANDSTILL.helperMinutes && !c.done.helper) due.push("helper");
  if (m >= STANDSTILL.otherAiMinutes && !c.done.other) due.push("other-ai");
  if (m >= STANDSTILL.repairMinutes && !c.done.repair) due.push("repair");
  if (m >= STANDSTILL.repairMinutes && !c.done.notice) due.push("notice");
  return { clock: c, due };
}
export const stillMinutes = c => Math.floor((c ? c.stillMs : 0) / MIN);
// The next step and the minute it comes at (the clock's own minutes). -> {what, at}
export function nextStep(c) {
  const base = Math.round((c.cycleFrom || 0) / MIN), d = c.done || {};
  if (!d.helper) return { what: "an acting run (rung 1)", at: base + STANDSTILL.helperMinutes };
  if (!d.other) return { what: "the other AI (rung 2)", at: base + STANDSTILL.otherAiMinutes };
  if (!d.repair || !d.notice) return { what: "the repair program and one notice to the owner", at: base + STANDSTILL.repairMinutes };
  return { what: "the ladder again, from rung 1", at: base + STANDSTILL.repairMinutes + STANDSTILL.restartHours * 60 + STANDSTILL.helperMinutes };
}

// ---------------------------------------------------------------- "in-progress" must be checkable
// What an answer names that the driver can check: a systemd unit, a GitHub run (its address or id), a pull request (its address
// or number). -> [{kind: "unit" | "run" | "pr", id, repo, what}]
export function namedIn(text, repo) {
  const t = String(text || ""), out = [], seen = new Set();
  const add = (kind, id, r, what) => { const k = `${kind}:${r || ""}:${id}`; if (!seen.has(k)) { seen.add(k); out.push({ kind, id: String(id), repo: r || repo, what }); } };
  for (const m of t.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/g)) add("run", m[2], m[1], `the GitHub run ${m[2]}`);
  for (const m of t.matchAll(/\b(?:GitHub\s+(?:Actions\s+)?)?(?:workflow\s+)?run(?:\s+id)?\s*#?(\d{6,})\b/gi)) add("run", m[1], null, `the GitHub run ${m[1]}`);
  for (const m of t.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) add("pr", m[2], m[1], `pull request #${m[2]}`);
  for (const m of t.matchAll(/\b(?:pull request|PR)\s*#(\d+)\b/gi)) add("pr", m[1], null, `pull request #${m[1]}`);
  for (const m of t.matchAll(/\b([A-Za-z0-9][A-Za-z0-9@_.:-]*\.service)\b/g)) add("unit", m[1], null, `the unit ${m[1]}`);
  return out;
}
const RUNNING = /^(queued|in_progress|waiting|requested|pending)$/;
// The driver's own machinery is never the work on a release: its round (which is running while it checks), the dead-man, the
// steps (the stage step's run is the one that repeats its waiting sentence) and the acting runs themselves. Beta.31's run said
// "the factory driver is actively running the requested repair".
export const OWN_UNITS = /^(factory-driver|factory-deadman|factory-act-|factory-helper-|factory-repair-|forge-step-)/;
// A named thing holds the release's clock only when it is the release's own work: one of its release programs' units, a GitHub run
// of its repository on its candidate, its release branch, its version pull request or one of its tickets' pull requests, or one of
// those pull requests themselves. Anything else a helper names (another repository's run, any open pull request, a web server's
// unit) is unrelated activity, which never holds it. own: {repo, version, bump (auto-stage's), prNumbers, prHeads}
export const RELEASE_UNITS = /(freeze|scenario|stage-server|staging-check)/i;
export function ownedBy(n, own) {
  if (!n || !own) return false;
  if (n.kind === "unit") return RELEASE_UNITS.test(n.id) && !OWN_UNITS.test(n.id) && !!own.id && n.id.includes(own.id); // a release program's unit that names this release (its id is its plan folder: unique)
  if (String(n.repo || "").toLowerCase() !== String(own.repo || "").toLowerCase()) return false;
  const bump = own.bump || null, nums = (own.prNumbers || []).map(Number), heads = own.prHeads || [];
  if (n.kind === "pr") return (!!bump && Number(n.id) === Number(bump.pr)) || nums.includes(Number(n.id));
  if (n.kind === "run") {
    const b = String(n.headBranch || "");
    return (/^(candidate|release)\//.test(b) && !!own.version && versionIn(b) === own.version) || (!!bump && ((!!bump.branch && b === bump.branch) || (!!bump.head && n.headSha === bump.head))) || (!!n.headSha && heads.includes(n.headSha));
  }
  return false;
}
// Each named thing, checked now. run(cmd, args) -> {status, stdout}. Anything the driver cannot read counts as not running.
export function checkNamed(named, run) {
  return (named || []).map(n => {
    try {
      if (n.kind === "unit") {
        if (!/^[A-Za-z0-9][A-Za-z0-9@_.:-]*\.service$/.test(n.id) || OWN_UNITS.test(n.id)) return { ...n, running: false };
        const r = run("systemctl", ["is-active", n.id]);
        return { ...n, running: /^(active|activating|reloading)$/.test(String(r.stdout || "").trim()) };
      }
      if (!/^[\w.-]+\/[\w.-]+$/.test(n.repo) || !/^\d+$/.test(n.id)) return { ...n, running: false };
      if (n.kind === "run") {
        const r = run("gh", ["api", `repos/${n.repo}/actions/runs/${n.id}`]);
        const j = r.status === 0 ? JSON.parse(r.stdout || "{}") : {};
        return { ...n, running: r.status === 0 && RUNNING.test(String(j.status || "")), headBranch: j.head_branch || null, headSha: j.head_sha || null };
      }
      if (n.kind === "pr") {
        const r = run("gh", ["api", `repos/${n.repo}/pulls/${n.id}`]);
        const p = r.status === 0 ? JSON.parse(r.stdout || "{}") : {};
        return { ...n, running: p.state === "open" && !p.merged_at };
      }
    } catch { /* unreadable: not running */ }
    return { ...n, running: false };
  });
}

// ---------------------------------------------------------------- what the owner reads, and what the dead-man reads
const PROVIDER_WORDS = { codex: "Codex", claude: "Claude" };
// One sentence (two at most), plain: what does not move, what was tried, that the repair program is at it, and that nothing is
// needed from him. versionName: how the release is named to him ("Beta 31"). launches: the acting runs the clock started
// ([{rung, provider}], whether or not they have answered yet). requested: the dead-man has the repair request.
export function noticeText(versionName, launches, requested) {
  const started = (launches || []).filter(l => PROVIDER_WORDS[l.provider]).sort((a, b) => a.rung - b.rung);
  const names = [...new Set(started.map(l => PROVIDER_WORDS[l.provider]))];
  const tried = started.length >= 2 ? `Two AI helpers tried to move it, ${names.length === 2 ? `first ${names[0]} and then ${names[1]}` : `both on ${names[0]}, as the other AI could not be reached`}, and it is still stuck`
    : started.length === 1 ? `One AI helper (${names[0]}) tried to move it and it is still stuck; a second one could not be started`
    : "No AI helper could be started to move it";
  return `${versionName} has not moved for about an hour. ${tried}, so ${requested ? "the repair program is now working on it" : "Mission Control keeps trying to start the repair program"}; nothing is needed from you unless a later message says so.`;
}
// The repair request the dead-man's repair run reads (deadman.mjs puts it into its brief). tries: the answers (and failed starts);
// launches: the runs started, of which one without an answer yet is still running.
export function repairWords(id, minutes, look, tries, launches = []) {
  const lines = String(look || "").split(/\r?\n/).filter(Boolean).slice(0, 6).join(" / ");
  const running = (launches || []).filter(l => !(tries || []).some(t => t.rung === l.rung && t.provider === l.provider)).map(l => ({ rung: l.rung, provider: l.provider, result: "still running" }));
  const did = [...(tries || []), ...running].sort((a, b) => a.rung - b.rung).map(t => `rung ${t.rung} on ${t.provider}: ${t.result}${t.summary ? ` (${String(t.summary).replace(/\s+/g, " ").slice(0, 300)})` : ""}`).join("; ") || "no acting run could be started";
  return `The approved release ${id} has not moved for ${minutes} minutes (the driver's release clock; its state, the stage step's look, auto-stage's state and the staging record, has not changed). The stage step says: ${lines || "nothing (no look about it)"}. What was tried: ${did}. Find out why the release does not move and make it move; if the fault is in the driver, repair the driver.`;
}
