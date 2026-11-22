// Replay of the recorded stalls (factory driver, Task 13).
//   node replay.mjs            run every stall, print the account
//   node replay.mjs --write    also write results.md
// The driver's own readWorld reads a world that answers from the fixtures as they stood at the time;
// findObstacles and nextStep then judge it. A stall passes when, at its first round (the stall's start plus
// FIRST_ROUND_MIN minutes, the time three scheduler decisions need to say "nothing started"), at least one
// obstacle has a next step that is not waiting. The held-back stalls are run exactly the same way and
// listed apart; nobody changes driver code after looking at them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readWorld, defaultsFor } from "../../world.mjs";
import { findObstacles } from "../../obstacles.mjs";
import { nextStep } from "../../ladder.mjs";
import { updateLedger } from "../../progress.mjs";
import { STALLS, HERE, stallDir, REPO } from "./build.mjs";

export const FIRST_ROUND_MIN = 30;
export const WARMUP_HOURS = 12; // rounds before the stall, so the ledger knows the history (no-progress needs it)
const ts = v => (v ? Date.parse(v) : NaN);
const iso = ms => new Date(ms).toISOString();

export function loadGithub(file = path.join(HERE, "fixtures", "github.json")) { return JSON.parse(fs.readFileSync(file, "utf8")); }
export function loadDecisions(file = path.join(HERE, "fixtures", "scheduler-decisions.log")) { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean); }

// one issue or pull request as it was at `t`
export function stateAt(it, t) {
  if (!it || ts(it.createdAt) > t) return null;
  const ev = it.events.filter(e => ts(e.at) <= t).sort((a, b) => ts(a.at) - ts(b.at));
  const labels = new Set();
  let state = "open", reason = null, closedAt = null, mergedAt = null, sha = null, shaAt = null;
  for (const e of ev) {
    if (e.event === "labeled") labels.add(e.label);
    else if (e.event === "unlabeled") labels.delete(e.label);
    else if (e.event === "closed") { state = "closed"; reason = e.reason || null; closedAt = e.at; }
    else if (e.event === "reopened") { state = "open"; reason = null; closedAt = null; mergedAt = null; }
    else if (e.event === "merged") mergedAt = e.at;
    else if (e.event === "committed") { sha = e.sha; shaAt = e.at; }
  }
  return { state, reason, closedAt, mergedAt, labels: [...labels], sha, shaAt, comments: ev.filter(e => e.event === "commented"), xrefs: ev.filter(e => e.event === "xref") };
}

// what the factory's server and GitHub would have answered at time `t`
export function fakeDepsAt(gh, decisions, t) {
  const items = gh.items;
  const at = n => stateAt(items[n], t);
  const label = (a, name) => a.labels.includes(name);
  const ghFn = args => {
    const a = args.join(" ");
    let m;
    if (/graphql/.test(a)) {
      const n = Number(/issue\(number: (\d+)\)/.exec(a)[1]);
      const s = at(n);
      if (!s) throw new Error(`#${n} did not exist yet`);
      const prs = [...new Set(s.xrefs.filter(x => x.pr).map(x => x.number))].filter(p => at(p));
      return { data: { repository: { issue: {
        closedByPullRequestsReferences: { nodes: prs.map(number => ({ number })) }, timelineItems: { nodes: [] },
        refs: { nodes: prs.map(number => ({ source: { __typename: "PullRequest", number, merged: !!at(number).mergedAt } })) },
      } } } };
    }
    if ((m = /pulls\/(\d+)$/.exec(a))) {
      const s = at(Number(m[1])); if (!s) throw new Error("HTTP 404");
      return { state: s.state, merged_at: s.mergedAt, labels: s.labels.map(name => ({ name })), head: { sha: s.sha } };
    }
    if ((m = /commits\/(\w+)\/check-runs/.exec(a))) {
      if (m[1] === "main") return { check_runs: [] }; // main's state is not recorded; never invented
      return { check_runs: (gh.checks[m[1]] || []).filter(r => ts(r.started_at) <= t).map(r => (ts(r.completed_at) > t ? { ...r, status: "in_progress", conclusion: null, completed_at: null } : r)) };
    }
    if ((m = /commits\/main$/.exec(a))) return { sha: "main" };
    if ((m = /commits\/(\w+)$/.exec(a))) {
      const it = Object.values(items).find(x => x.events.some(e => e.sha === m[1]));
      const e = it && it.events.find(x => x.sha === m[1]);
      return { commit: { committer: { date: e ? e.at : null } } };
    }
    if (/issues\?state=open&labels=needs-owner/.test(a)) {
      return Object.values(items).map(it => ({ it, s: at(it.number) })).filter(x => x.s && x.s.state === "open" && label(x.s, "needs-owner"))
        .map(x => ({ number: x.it.number, ...(x.it.pr ? { pull_request: {} } : {}) }));
    }
    if (/actions\/workflows/.test(a)) return { workflow_runs: [] };
    if ((m = /issues\/(\d+)\/comments/.exec(a))) {
      const s = at(Number(m[1])); if (!s) throw new Error("HTTP 404");
      return s.comments.map(c => ({ user: { login: c.author || "" }, body: c.body, created_at: c.at }));
    }
    if ((m = /issues\/(\d+)$/.exec(a))) {
      const s = at(Number(m[1])); if (!s) throw new Error("HTTP 404");
      return { state: s.state, state_reason: s.reason, labels: s.labels.map(name => ({ name })), closed_at: s.closedAt };
    }
    throw new Error(`replay has no answer for: ${a}`);
  };
  const shFn = cmd => {
    if (/journalctl --user -u archonfactory/.test(cmd)) return decisions.filter(l => ts(l.slice(0, 25)) <= t).slice(-60).join("\n");
    if (/list-unit-files/.test(cmd)) return "archonfactory-godspeed-mission-control.timer enabled\n";
    if (/systemctl --user show/.test(cmd)) return "Id=archonfactory-godspeed-mission-control.timer\nActiveState=active\nLoadState=loaded\n\nId=archonfactory-godspeed-mission-control-manager.timer\nActiveState=active\nLoadState=loaded\n";
    if (/^runs$/.test(cmd.trim())) return "[]"; // which laps ran is not recorded: the scheduler's own "N lap(s) active" says it
    if (/df /.test(cmd)) return " 50%\n";
    if (/free -m/.test(cmd)) return "Mem: 64000 6000 2000 40 56000 58000\n";
    if (/gh auth/.test(cmd)) return "ok\n";
    if (/codex login/.test(cmd)) return "Logged in using ChatGPT\n";
    if (/claude auth/.test(cmd)) return "Logged in\n";
    if (/grep -c/.test(cmd)) return "0\n";
    if (/netns-guard/.test(cmd)) return "inactive\n";
    return "";
  };
  return { gh: ghFn, sh: shFn, now: () => t };
}

export async function worldAt(stall, gh, decisions, t) {
  const dir = path.join(stallDir(stall), "godspeed-dev", "releases");
  const env = { REPO, RELEASES_DIR: dir, AUTO_STAGE_STATE: path.join(stallDir(stall), "none.json"), ARCHON_RUNS: "runs", MUST_RUN: [], TM_MODULE: "" }; // which hidden-check tools existed then is not recorded: not read
  const base = fakeDepsAt(gh, decisions, t);
  return readWorld(env, { ...base, readFile: p => { if (/\.factory[\\/](STOP|PAUSE)$/.test(p)) throw new Error("no file"); return fs.readFileSync(p, "utf8"); } });
}

export async function replayStall(stall, gh, decisions) {
  const t0 = ts(stall.at), tFirst = t0 + FIRST_ROUND_MIN * 60000;
  let ledger = {};
  let at = t0 - WARMUP_HOURS * 3600000, last = null;
  const firstSeen = {};
  for (; at <= tFirst; at += 30 * 60000) {
    const world = await worldAt(stall, gh, decisions, at);
    ledger = updateLedger(ledger, world, at);
    const obs = findObstacles(world, ledger, at, { firstSeen });
    for (const o of obs) firstSeen[o.id] ||= o.since;
    last = { world, obs, at };
  }
  const steps = last.obs.map(o => ({ id: o.id, kind: o.kind, key: o.ticketKey || o.project || "", since: o.since, step: nextStep(o, [], { now: last.at }) }));
  const decisionsBefore = decisions.filter(l => ts(l.slice(0, 25)) <= tFirst).slice(-3).map(l => l.replace(/^(\S+)\s+\S+\s+\S+?:\s*/, "$1 ").slice(0, 150));
  return {
    id: stall.id, at: stall.at, held: stall.held, release: last.world.releases.map(r => `${r.id} (${r.tickets.filter(x => !x.deferred).length} tickets)`),
    unreadable: last.world.unreadable.map(u => `${u.part}: ${u.error}`.slice(0, 120)), board: last.world.board.openNeedsOwner.length,
    scheduler: decisionsBefore, steps, pass: steps.some(s => s.step.do !== "wait-external"),
  };
}

export async function replayAll(only) {
  const gh = loadGithub(), decisions = loadDecisions();
  const out = [];
  for (const s of STALLS) if (!only || only.includes(s.id)) out.push(await replayStall(s, gh, decisions));
  return out;
}

export const RESULTS_HEAD = `# Replay of the recorded stalls

Written by \`node replay.mjs --write\`. Each stall is a stretch in the factory scheduler's log (2026-11-13 to
2026-11-18) in which it started no new work for two hours or more. The driver's own world reader runs on the
GitHub timelines (labels, state, comments, pull requests, required checks), the scheduler's decision lines and
godspeed-dev's release plans as they stood at that moment; a round at the stall's start plus 30 minutes judges
it, after rounds every 30 minutes for the 12 hours before so that the ledger has a history. A stall passes when
at least one obstacle has a next step that is not a wait.

What the record cannot say, and the replay therefore does not claim: which laps were running (the scheduler's
own "N lap(s) active" is what counts), the state of main (never red in the replay), whether a STOP file existed,
the exact time a release was staged (auto-stage's state file is empty), and hidden-check results.

The two held-back stalls (2026-11-17 13:00 and 2026-11-18 05:31) are built by the same builder and run by the same
code; their fixtures live in \`held-back/\`, no test runs the driver on them, and no driver code is changed after
looking at their result. A failing held-back stall is a finding to report, not a thing to tune for.

Known approximations (found in review): a pull request that merely mentions an issue counts as linked to it (GitHub's
own "closing" link is not in the timelines); and the first round is judged with an empty history, so for an ordinary
obstacle the ladder's first step, "diagnose", is what passes: the replay proves that the driver would have SEEN the
stall and acted within its first round, not that the action would have ended it.
`;

export function account(rs) {
  const L = [];
  for (const held of [false, true]) {
    L.push(held ? "## Held back (built the same way, only ever run; no code is tuned on these)" : "## Stalls the driver was built against", "");
    for (const r of rs.filter(x => x.held === held)) {
      L.push(`### ${r.id} (${r.at}): ${r.pass ? "PASS" : "FAIL"}`, "");
      L.push(`- release read: ${r.release.join(", ") || "none"}; open items with needs-owner on the board: ${r.board}`);
      L.push(`- scheduler said: ${r.scheduler.map(s => `"${s}"`).join(" / ")}`);
      if (r.unreadable.length) L.push(`- unreadable parts: ${r.unreadable.join("; ")}`);
      if (!r.steps.length) L.push("- obstacles: none");
      for (const s of r.steps) L.push(`- obstacle ${s.kind} ${s.key} (since ${s.since}) -> ${s.step.do}${s.step.provider ? ` with ${s.step.provider}/${s.step.model}` : ""}`);
      L.push("");
    }
  }
  return L.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rs = await replayAll();
  const text = account(rs);
  console.log(text);
  const bad = rs.filter(r => !r.pass);
  if (process.argv.includes("--write")) fs.writeFileSync(path.join(HERE, "results.md"), `${RESULTS_HEAD}\n${text}\n`);
  console.log(`${rs.length - bad.length}/${rs.length} stalls give an obstacle with a next step that is not a wait`);
  process.exit(bad.length ? 1 : 0);
}
