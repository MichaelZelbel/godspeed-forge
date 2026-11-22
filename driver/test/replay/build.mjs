// Replay builder (factory driver, Task 13). Rebuilds the world of a recorded stall from what was
// written down at the time: GitHub issue and pull request timelines, the scheduler's journal lines and
// the release plans as they stood in godspeed-dev's history. The result is served to the driver's own
// readWorld through fake deps (replay.mjs), so the replay runs the real reading code, not a copy of it.
//
//   node build.mjs fetch    read GitHub, the server (read-only) and godspeed-dev; write fixtures/ and held-back/
//
// What cannot be known afterwards is said, not guessed: laps that ran, the state of main, a STOP file's
// writer. Those stay empty in the replayed world (see results.md).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { itemIssues } from "../../release-driver/release-driver.mjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = "MichaelZelbel/godspeed-mission-control";
// The five stretches the scheduler log shows with no new work started (Berlin time, +01:00).
// `held` ones are built the same way but stored apart and only ever run: nobody tunes code on them.
export const STALLS = [
  { id: "2026-11-14-0253", at: "2026-11-14T02:53:00+01:00", held: false },
  { id: "2026-11-14-2349", at: "2026-11-14T23:49:00+01:00", held: false },
  { id: "2026-11-17-0701", at: "2026-11-17T07:01:00+01:00", held: false },
  { id: "2026-11-17-1300", at: "2026-11-17T13:00:00+01:00", held: true },
  { id: "2026-11-18-0531", at: "2026-11-18T05:31:00+01:00", held: true },
];
export const stallDir = s => path.join(HERE, s.held ? "held-back" : "fixtures", s.id);

const gh = (args, { json = true } = {}) => {
  const r = spawnSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: false });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")}: ${String(r.stderr).slice(0, 200)}`);
  return json ? JSON.parse(r.stdout) : r.stdout;
};
const ghLines = args => gh([...args, "--paginate", "--jq", ".[]"], { json: false }).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
const ts = v => (v ? Date.parse(v) : NaN);

// The part of a timeline the driver's reading needs: labels, state changes, the comments (what "working"
// is judged by), links to pull requests, and the commits of a pull request.
export function slimTimeline(rows) {
  const ev = [];
  for (const e of rows) {
    const at = e.created_at || e.submitted_at || (e.committer && e.committer.date) || (e.author && e.author.date) || null;
    switch (e.event || (e.sha ? "committed" : "")) {
      case "labeled": case "unlabeled": ev.push({ at, event: e.event, label: e.label && e.label.name }); break;
      case "closed": ev.push({ at, event: "closed", reason: e.state_reason || null }); break;
      case "reopened": ev.push({ at, event: "reopened" }); break;
      case "merged": ev.push({ at, event: "merged" }); break;
      case "commented": ev.push({ at, event: "commented", author: e.user ? e.user.login : e.actor && e.actor.login, body: String(e.body || "").slice(0, 400) }); break;
      case "cross-referenced": if (e.source && e.source.issue) ev.push({ at, event: "xref", number: e.source.issue.number, pr: !!e.source.issue.pull_request }); break;
      case "committed": ev.push({ at, event: "committed", sha: e.sha }); break;
      default: break;
    }
  }
  return ev;
}

async function fetchAll(refresh) {
  fs.mkdirSync(path.join(HERE, "fixtures"), { recursive: true });
  const have = f => !refresh && fs.existsSync(path.join(HERE, "fixtures", f));
  if (!have("github.json")) await fetchGithub();
  if (!have("scheduler-decisions.log")) fetchDecisions();
  fetchTrees();
  fetchMissing();
}

async function fetchGithub() {
  const first = Math.min(...STALLS.map(s => ts(s.at))), last = Math.max(...STALLS.map(s => ts(s.at)));
  const rows = ghLines([`repos/${REPO}/issues?state=all&per_page=100&since=2026-10-01T00:00:00Z`]);
  // everything that existed and was open at some stall: the board of that stall
  const wanted = rows.filter(r => ts(r.created_at) <= last + 3600000 && (!r.closed_at || ts(r.closed_at) >= first - 3600000));
  const items = {}, checks = {};
  for (const r of wanted) {
    const tl = ghLines([`repos/${REPO}/issues/${r.number}/timeline?per_page=100`]);
    items[r.number] = { number: r.number, pr: !!r.pull_request, title: String(r.title || "").slice(0, 120), createdAt: r.created_at, events: slimTimeline(tl) };
  }
  // required check of the pull requests' commits that were the latest at a stall
  for (const it of Object.values(items)) {
    if (!it.pr) continue;
    for (const s of STALLS) {
      const sha = [...it.events].reverse().find(e => e.event === "committed" && ts(e.at) <= ts(s.at) + 3600000);
      if (!sha || checks[sha.sha] || ts(it.createdAt) > ts(s.at) + 3600000) continue;
      try {
        checks[sha.sha] = (gh([`repos/${REPO}/commits/${sha.sha}/check-runs?check_name=required&filter=all&per_page=100`]).check_runs || [])
          .map(x => ({ name: x.name, status: x.status, conclusion: x.conclusion, started_at: x.started_at, completed_at: x.completed_at }));
      } catch { checks[sha.sha] = []; }
    }
  }
  fs.writeFileSync(path.join(HERE, "fixtures", "github.json"), `${JSON.stringify({ repo: REPO, fetchedAt: new Date().toISOString(), items, checks })}\n`);

}

function fetchDecisions() {
  const r = spawnSync("ssh", ["-o", "ConnectTimeout=20", "godspeed-archon",
    `runuser -u godspeed-forge -- env XDG_RUNTIME_DIR=/run/user/1001 journalctl --user -u archonfactory-godspeed-mission-control.service --since "2026-11-13 12:00" -o short-iso --no-pager | grep -aE "python3?\\[[0-9]+\\]: (Launch|No launch|Local STOP|Scheduled launches)"`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !r.stdout) throw new Error(`scheduler log: ${String(r.stderr).slice(0, 200)}`);
  fs.writeFileSync(path.join(HERE, "fixtures", "scheduler-decisions.log"), r.stdout.replace(/\r/g, ""));

}

function fetchTrees() {
  const dev = "C:/godspeed/dev/godspeed-dev";
  for (const s of STALLS) {
    const commit = spawnSync("git", ["-C", dev, "rev-list", "-1", `--before=${s.at}`, "main"], { encoding: "utf8" }).stdout.trim();
    const out = path.join(stallDir(s), "godspeed-dev");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const ar = spawnSync("git", ["-C", dev, "archive", commit, "releases"], { maxBuffer: 256 * 1024 * 1024 });
    const tar = spawnSync("tar", ["-x", "-f", "-"], { input: ar.stdout, cwd: out });
    if (tar.status !== 0) throw new Error(`tar: ${tar.stderr || tar.error}`);
    const rel = path.join(out, "releases");
    for (const d of fs.readdirSync(rel)) if (!/beta\.(2[3-9])|beta\.3/.test(d)) fs.rmSync(path.join(rel, d), { recursive: true, force: true });
    fs.writeFileSync(path.join(stallDir(s), "meta.json"), `${JSON.stringify({ id: s.id, at: s.at, devCommit: commit })}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "fetch") {
  fetchAll(process.argv.includes("--refresh")).then(() => console.log("fixtures written")).catch(e => { console.error(e.message); process.exit(1); });
}

// Issues a stall's release plan names that were already finished before the stretch (so the board listing
// did not carry them), and the pull requests that mention them: the driver reads them for every ticket.
function fetchMissing() {
  const file = path.join(HERE, "fixtures", "github.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const want = new Set();
  for (const s of STALLS) {
    const rel = path.join(stallDir(s), "godspeed-dev", "releases");
    for (const d of fs.readdirSync(rel)) {
      let plan = ""; try { plan = fs.readFileSync(path.join(rel, d, "plan.md"), "utf8"); } catch { continue; }
      for (const m of itemIssues(plan) ? Object.values(itemIssues(plan)) : []) want.add(m);
    }
  }
  const add = n => {
    if (data.items[n]) return;
    try {
      const row = gh([`repos/${REPO}/issues/${n}`]);
      const tl = ghLines([`repos/${REPO}/issues/${n}/timeline?per_page=100`]);
      data.items[n] = { number: n, pr: !!row.pull_request, title: String(row.title || "").slice(0, 120), createdAt: row.created_at, events: slimTimeline(tl) };
      for (const e of data.items[n].events) if (e.event === "xref" && e.pr) add(e.number);
    } catch (e) { console.error(`#${n}: ${e.message}`); }
  };
  for (const n of want) add(n);
  fs.writeFileSync(file, `${JSON.stringify(data)}
`);
}
