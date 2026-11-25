import { TEST_ENV } from "./env.mjs";
import test from "./harness.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readWorld, parseDecisions, parseStale, ticketSize, parseRuns, parseProjects, parseStop, writerRuns } from "../world.mjs";
import { housekeep } from "../housekeeping.mjs";

const here = p => new URL(p, import.meta.url);
const PLAN = "release: x\nrepository: MichaelZelbel/godspeed-mission-control\nstatus: approved\n\n- Issues: item 1 #10, 2 #11 (x).\n";
const release = { id: "godspeed-2.0.0-beta.30-x", dir: "/r/beta30", plan: PLAN, staging: null };
const required = (conclusion, at = "2026-11-18T10:00:00Z") => ({ check_runs: [{ name: "required", status: "completed", conclusion, completed_at: at, started_at: at, html_url: "u" }] });

function fakeGh({ failPr = null, prRequired = required("success") } = {}) {
  return args => {
    const a = args.join(" ");
    if (/graphql/.test(a)) { const n = Number(/issue\(number: (\d+)\)/.exec(a)[1]); return { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [{ number: n + 100 }] }, timelineItems: { nodes: [] } } } } }; }
    let m;
    if ((m = /pulls\/(\d+)$/.exec(a))) { if (Number(m[1]) === failPr) throw new Error("HTTP 502"); return { state: "open", merged_at: null, labels: [{ name: "x" }], head: { sha: "sha" + m[1] } }; }
    if (/commits\/sha\d+\/check-runs/.test(a)) return prRequired;
    if (/commits\/sha\d+$/.test(a)) return { commit: { committer: { date: "2026-11-18T09:00:00Z" } } };
    if (/commits\/main$/.test(a)) return { sha: "mainsha" };
    if (/commits\/mainsha\/check-runs/.test(a)) return required("failure", "2026-11-18T08:00:00Z");
    if (/issues\?state=open/.test(a)) return [{ number: 10 }, { number: 11 }, { number: 12, labels: [{ name: "needs-owner" }, { name: "found-list" }] }, { number: 500, pull_request: {} }];
    if ((m = /issues\/(\d+)\/comments/.exec(a))) return [{ user: { login: "MichaelZelbel" }, body: "hi", created_at: "2026-11-18T09:30:00Z" }];
    if ((m = /issues\/(\d+)$/.exec(a))) return { state: "open", labels: [{ name: "needs-owner" }], closed_at: null };
    throw new Error("unexpected " + a);
  };
}
const sh = cmd => {
  if (/journalctl/.test(cmd)) return fs.readFileSync(here("./fixtures/journal.txt"), "utf8");
  if (/workflow runs/.test(cmd)) return JSON.stringify([{ id: "r1", status: "running", startedAt: "2026-11-18T09:00:00Z", lastOutputAt: "2026-11-18T09:50:00Z" }, { id: "r0", status: "completed" }]);
  if (/ps -u/.test(cmd)) return "  42 godspee+ 20000 1 python3 standin_ai.py --run r1\n  43 godspee+ 20000 1 python3 standin_ai.py --run zzz\n  44 godspee+ 60 1 chromium\n";
  if (/df /.test(cmd)) return " 74%\n";
  if (/free/.test(cmd)) return "Mem: 64223 6209 2019 40 56833 58014\n";
  if (/systemctl/.test(cmd)) return "hermes-gateway.service\n";
  if (/gh auth/.test(cmd)) return "ok\n";
  return "";
};
const deps = extra => ({
  gh: fakeGh(extra), sh, now: () => Date.parse("2026-11-18T10:30:00Z"),
  readReleases: () => [{ ...release, hasStaging: false, done: false }],
  readFile: p => { if (/auto-stage/.test(p)) return "{}"; if (/consumer\.json$/.test(p)) return JSON.stringify({ source: "/src", bun: "bun" }); if (/01-ten/.test(p)) return "# Ten\nTicket. Size: large.\n"; throw new Error("no " + p); },
  readDir: () => ["01-ten.md", "02-eleven.md", "README.md"],
});

test("a failing PR becomes unreadable and the rest is still returned", async () => {
  const w = await readWorld(TEST_ENV, deps({ failPr: 111 }));
  assert.ok(w.unreadable.some(u => u.part === "pr#111"));
  assert.equal(w.items[10].prs.length, 1);
  assert.equal(w.items[10].prs[0].number, 110);
  assert.equal(w.items[11].partial, true);
  assert.equal(w.items[10].partial, false);
  assert.deepEqual(w.board.openNeedsOwner, [10, 11]);
});

test("requiredState and requiredSince come from the PR's required check run", async () => {
  const ok = await readWorld(TEST_ENV, deps({ prRequired: required("success", "2026-11-18T10:05:00Z") }));
  assert.equal(ok.items[10].prs[0].requiredState, "success");
  assert.equal(ok.items[10].prs[0].requiredSince, "2026-11-18T10:05:00.000Z");
  const bad = await readWorld(TEST_ENV, deps({ prRequired: required("failure") }));
  assert.equal(bad.items[10].prs[0].requiredState, "failure");
  assert.equal(bad.main.required, "failure");
});

test("scheduler decisions are parsed from the journal", async () => {
  const w = await readWorld(TEST_ENV, deps());
  assert.equal(w.factory.lastDecisions.length, 3);
  assert.match(w.factory.lastDecisions[0].text, /^No launch: workable nothing/);
  assert.match(w.factory.lastDecisions[2].text, /found nothing to start/);
  assert.equal(parseDecisions("garbage").length, 0);
});

test("tickets carry item, issue and size; active runs and stale processes", async () => {
  const w = await readWorld(TEST_ENV, deps());
  const [t1, t2] = w.releases[0].tickets;
  assert.deepEqual([t1.item, t1.issue], [1, 10]);
  assert.equal(t1.size, "l");
  assert.equal(t2.size, "m");
  assert.equal(w.factory.activeRuns.length, 1);
  assert.deepEqual(w.server.staleProcs.map(p => p.pid), [43]); // 42 belongs to an active run, 44 is young
  assert.equal(w.server.diskPct, 74);
  assert.equal(w.server.memAvailPct, 90);
  assert.deepEqual(w.server.failedUnits, ["hermes-gateway.service"]);
  assert.equal(w.server.logins.gh, true);
});

test("a server command that throws is unreadable, not silently empty", async () => {
  const w = await readWorld(TEST_ENV, { ...deps(), sh: cmd => { if (/df /.test(cmd)) throw new Error("boom"); return sh(cmd); } });
  assert.ok(w.unreadable.some(u => u.part === "server/disk"));
  assert.equal(w.server.diskPct, null);
});

test("ticketSize and parseStale basics", () => {
  assert.equal(ticketSize("Ticket. Size: small. Depends on: x"), "s");
  assert.equal(ticketSize("no size here"), "m");
  assert.equal(parseStale("1 u 99999 0 main.mjs\n", [], 180).length, 1);
});

// ---------------------------------------------------------------- Task 8: every factory project
// Archon's own `workflow runs --json` answer, as read live on the AX41 on 2026-11-18 (trimmed).
const ARCHON = JSON.stringify({ runs: [
  { id: "f5eac04b-38a8", workflow_name: "archon-loop", status: "running", started_at: "2026-11-18T13:22:22.000Z", completed_at: null, last_activity_at: "2026-11-18T13:52:26.000Z" },
  { id: "aaaa0001-0000", workflow_name: "archon-loop", status: "pending", started_at: "2026-11-18T13:50:00.000Z", completed_at: null, last_activity_at: null },
  { id: "369b7226-xxxx", workflow_name: "archon-loop", status: "completed", started_at: "2026-11-18T13:17:12.000Z", completed_at: "2026-11-18T13:18:17.000Z", last_activity_at: "2026-11-18T13:17:17.000Z" },
], total: 3, counts: {}, scopeFallback: false });
const CONSUMER = JSON.stringify({ source: "/home/godspeed-forge/.cache/factory/archon/1cfb", bun: "bun" });

test("Archon's real runs answer: pending, running and paused are active; last_activity_at is the last output", () => {
  const r = parseRuns(ARCHON);
  assert.deepEqual(r.map(x => x.id), ["f5eac04b-38a8", "aaaa0001-0000"]);
  assert.equal(r[0].startedAt, "2026-11-18T13:22:22.000Z");
  assert.equal(r[0].lastOutputAt, "2026-11-18T13:52:26.000Z");
  assert.deepEqual(parseRuns("not json"), []);
});

test("the factory's projects are its trigger timers, the managers left out, the main project always first", () => {
  assert.deepEqual(parseProjects("archonfactory-querino.timer enabled enabled\narchonfactory-querino-manager.timer enabled enabled\narchonfactory-godspeed-forge.timer enabled enabled\n", "godspeed-mission-control"),
    ["godspeed-mission-control", "querino", "godspeed-forge"]);
  assert.deepEqual(parseProjects("", "godspeed-mission-control"), ["godspeed-mission-control"]);
});

test("a STOP file names its writer, its process and when it was made", () => {
  assert.deepEqual(parseStop("auto-stage 1424860 2026-11-18T13:47:26.709Z\nThe release step pauses the factory.\n", 0),
    { line: "auto-stage 1424860 2026-11-18T13:47:26.709Z", writer: "auto-stage", pid: 1424860, at: "2026-11-18T13:47:26.709Z" });
  const p = parseStop("stopped by hand\n", Date.parse("2026-11-18T10:00:00Z"));
  assert.equal(p.writer, "stopped"); assert.equal(p.pid, null); assert.equal(p.at, "2026-11-18T10:00:00.000Z");
});

function projectDeps({ stop = null, writerArgs = "", scenarios = [], restarts = "1" } = {}) {
  const calls = [];
  const base = deps();
  return {
    calls,
    ...base,
    sh: (cmd, o = {}) => {
      calls.push({ cmd, asForge: !!o.asForge });
      if (/list-unit-files/.test(cmd)) return "archonfactory-godspeed-mission-control.timer enabled enabled\narchonfactory-querino.timer enabled enabled\narchonfactory-querino-manager.timer enabled enabled\n";
      if (/journalctl --user -u archonfactory-querino/.test(cmd)) return "2026-11-18T15:40:04+01:00 godspeed-archon python[1523560]: No launch: workable nothing; 0 lap(s) active, 0 still choosing.\n";
      if (/workflow runs/.test(cmd)) return /querino/.test(cmd) ? JSON.stringify({ runs: [] }) : ARCHON;
      if (/remote\.origin\.url/.test(cmd)) return /querino/.test(cmd) ? "https://github.com/MichaelZelbel/querino.git\n" : "https://github.com/MichaelZelbel/godspeed-mission-control.git\n";
      if (/ps -p \d+ -o args=/.test(cmd)) return writerArgs;
      if (/user@1001/.test(cmd)) return `${restarts}\n`;
      if (/show -p Id/.test(cmd)) return /querino/.test(cmd) ? "Id=archonfactory-querino.timer\nActiveState=inactive\nLoadState=loaded\n\nId=archonfactory-querino-manager.timer\nActiveState=active\nLoadState=loaded\n"
        : "Id=archonfactory-godspeed-mission-control.timer\nActiveState=active\nLoadState=loaded\n\nId=archonfactory-godspeed-mission-control-manager.timer\nActiveState=inactive\nLoadState=not-found\n";
      if (/netns-guard/.test(cmd)) return "activating\n";
      if (/is-enabled godspeed-forge-web/.test(cmd)) return "enabled\ninactive\n";
      return sh(cmd);
    },
    gh: args => {
      const a = args.join(" ");
      if (/querino\/issues\?state=open/.test(a)) return [{ number: 7 }, { number: 8, labels: [{ name: "found-list" }, { name: "needs-owner" }] }];
      if (/actions\/workflows\/scenarios\.yml\/runs/.test(a)) return { workflow_runs: scenarios };
      return base.gh(args);
    },
    readFile: p => {
      if (/consumer\.json$/.test(p)) return CONSUMER;
      if (/godspeed-mission-control\/\.factory\/STOP$/.test(p) && stop) return stop;
      if (/scope-amendment\.json$/.test(p)) return JSON.stringify({ release: "x", amendments: [{ decidedBy: "release-driver", deferredTickets: ["02-eleven.md"] }] });
      return base.readFile(p);
    },
    mtime: () => Date.parse("2026-11-18T10:00:00Z"),
  };
}

test("every factory project is read: its decisions, its runs (through Archon's own CLI), its repository and its board", async () => {
  const d = projectDeps();
  const w = await readWorld(TEST_ENV, d);
  assert.deepEqual(w.factories.map(f => f.project), ["godspeed-mission-control", "querino"]);
  const [gmc, q] = w.factories;
  assert.equal(gmc.primary, true);
  assert.equal(gmc.repo, "MichaelZelbel/godspeed-mission-control");
  assert.deepEqual(gmc.board, [10, 11]);
  assert.equal(gmc.activeRuns.length, 2);
  assert.equal(w.factory.activeRuns.length, 2, "world.factory is still the main project");
  assert.equal(q.repo, "MichaelZelbel/querino");
  assert.deepEqual(q.board, [7]);
  assert.equal(q.lastDecisions.length, 1);
  assert.equal(q.checkout, "/home/godspeed-forge/querino");
  const runs = d.calls.find(c => /workflow runs/.test(c.cmd) && /querino/.test(c.cmd));
  assert.ok(runs.asForge, "Archon runs as the factory user");
  assert.match(runs.cmd, /bun '\/home\/godspeed-forge\/\.cache\/factory\/archon\/1cfb\/packages\/cli\/src\/cli\.ts' workflow runs --limit 30 --cwd '\/home\/godspeed-forge\/querino' --json/);
  assert.equal(q.stop, null);
});

test("found lists are not on the board, for the main project and for a further project", async () => {
  const w = await readWorld(TEST_ENV, projectDeps());
  assert.deepEqual(w.board.openNeedsOwner, [10, 11]);
  assert.deepEqual(w.factories[0].board, [10, 11]);
  assert.deepEqual(w.factories[1].board, [7]);
});

test("a board whose only needs-owner issues are found lists is empty", async () => {
  const d = projectDeps();
  const gh = d.gh;
  d.gh = args => /issues\?state=open/.test(args.join(" ")) ? [{ number: 12, labels: [{ name: "found-list" }] }] : gh(args);
  const w = await readWorld(TEST_ENV, d);
  assert.deepEqual(w.board.openNeedsOwner, []);
  assert.deepEqual(w.factories.map(f => f.board), [[], []]);
});

test("a STOP file: its writer's life is read (and no scenario run is: nothing depends on it any more)", async () => {
  const stop = "auto-stage 1424860 2026-11-18T13:47:26.709Z\nThe release step pauses the factory while the scenarios run.\n";
  const live = await readWorld(TEST_ENV, projectDeps({ stop, writerArgs: "/usr/local/bin/node /usr/local/lib/godspeed-forge/godspeed-dev/scripts/release/auto-stage.mjs\n",
    scenarios: [{ status: "in_progress", head_branch: "candidate/2.0.0-beta.28", display_title: "scenarios candidate/2.0.0-beta.28" }] }));
  const s = live.factories[0].stop;
  assert.equal(s.file, "/home/godspeed-forge/godspeed-mission-control/.factory/STOP");
  assert.deepEqual([s.writer, s.pid, s.writerAlive], ["auto-stage", 1424860, true]);
  const dead = await readWorld(TEST_ENV, projectDeps({ stop, writerArgs: "", scenarios: [{ status: "completed", head_branch: "candidate/2.0.0-beta.28" }, { status: "in_progress", head_branch: "main" }] }));
  assert.deepEqual([dead.factories[0].stop.writerAlive], [false]);
  const other = await readWorld(TEST_ENV, projectDeps({ stop, writerArgs: "/usr/bin/sleep 100\n" }));
  assert.equal(other.factories[0].stop.writerAlive, false, "a reused process number is not the writer");
});

test("the factory user's manager restarts in the last 30 minutes, and tickets a scope amendment moved out are marked", async () => {
  const w = await readWorld(TEST_ENV, projectDeps({ restarts: "3" }));
  assert.equal(w.server.userManagerStarts, 3);
  const [t1, t2] = w.releases[0].tickets;
  assert.equal(t1.deferred, false);
  assert.equal(t2.deferred, true);
});

test("each project's trigger and manager timer are read (a missing one is no timer), and whether the network guard runs right now", async () => {
  const w = await readWorld(TEST_ENV, projectDeps());
  assert.deepEqual(w.factories[0].timers, { "archonfactory-godspeed-mission-control.timer": "active" });
  assert.deepEqual(w.factories[1].timers, { "archonfactory-querino.timer": "inactive", "archonfactory-querino-manager.timer": "active" });
  assert.equal(w.server.guardRunning, true);
  const d = projectDeps();
  const timerCmd = d.calls;
  await readWorld(TEST_ENV, d);
  assert.ok(timerCmd.find(c => /show -p Id/.test(c.cmd)).asForge, "the factory user's own manager is asked");
});

test("an approved release older than the version installed on the server is superseded: not driven, named once", async () => {
  // today: beta.27 is approved and never finished, beta.28 is installed (its scenarios failed, so it is not done)
  const plan = v => `release: godspeed-${v}-x\nrepository: MichaelZelbel/godspeed-mission-control\nstatus: approved\n\n- Issues: item 1 #10\n`;
  const rels = [
    { id: "godspeed-2.0.0-beta.27-sees-it-through", dir: "/r/27", plan: plan("2.0.0-beta.27"), staging: null, hasStaging: false, done: false },
    { id: "godspeed-2.0.0-beta.28-keeps-watch", dir: "/r/28", plan: plan("2.0.0-beta.28"), staging: { status: "installed", version: "2.0.0-beta.28" }, hasStaging: true, done: false },
  ];
  const w = await readWorld(TEST_ENV, { ...deps(), readReleases: () => rels });
  assert.ok(!w.releases.some(r => r.id === "godspeed-2.0.0-beta.27-sees-it-through"));
  assert.deepEqual(w.superseded, [{ id: "godspeed-2.0.0-beta.27-sees-it-through", version: "2.0.0-beta.27", by: "2.0.0-beta.28" }]);
});

test("a release installed on the owner's server is done: nobody works on it afterwards, failed scenarios or not (Michael, 2026-11-18)", async () => {
  const plan = v => `release: godspeed-${v}-x\nrepository: MichaelZelbel/godspeed-mission-control\nstatus: approved\n\n- Issues: item 1 #10\n`;
  const rels = [
    { id: "godspeed-2.0.0-beta.28-keeps-watch", dir: "/r/28", plan: plan("2.0.0-beta.28"), staging: { status: "installed", version: "2.0.0-beta.28", scenarios: { result: "failed" } }, hasStaging: true, done: false },
    { id: "godspeed-2.0.0-beta.29-x", dir: "/r/29", plan: plan("2.0.0-beta.29"), staging: null, hasStaging: false, done: false },
  ];
  const w = await readWorld(TEST_ENV, { ...deps(), readReleases: () => rels });
  assert.deepEqual(w.releases.map(r => r.id), ["godspeed-2.0.0-beta.29-x"], "only the newer release is driven");
  assert.equal(w.installed.id, "godspeed-2.0.0-beta.28-keeps-watch"); assert.equal(w.installed.version, "2.0.0-beta.28"); assert.equal(w.installed.staging.status, "installed", "the staging record rides along for the fresh install check"); assert.ok(Array.isArray(w.installed.issues));
  assert.deepEqual(w.superseded, []);
  const only = await readWorld(TEST_ENV, { ...deps(), readReleases: () => rels.slice(0, 1) });
  assert.deepEqual(only.releases, [], "nothing newer: nothing to drive");
});

test("a merged pull request that only mentions the issue is recorded, so the item counts as done", async () => {
  const base = deps();
  const w = await readWorld(TEST_ENV, { ...base, gh: args => {
    const a = args.join(" ");
    if (/graphql/.test(a)) return { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] },
      refs: { nodes: [{ source: { __typename: "PullRequest", number: 714, merged: true } }, { source: { __typename: "PullRequest", number: 531, merged: false } }, { source: { __typename: "Issue" } }] } } } } };
    return base.gh(args);
  } });
  assert.deepEqual(w.items[10].mergedRefs, [714]);
  assert.deepEqual(w.items[10].prs, []);
});

test("an enabled unit that must run and is not running counts as down, like a failed one", async () => {
  const w = await readWorld(TEST_ENV, projectDeps());
  assert.ok(w.server.failedUnits.includes("godspeed-forge-web.service"));
});

test("the hidden checks' tools are read the way the test machine reads them; an answer that is not a reading is unreadable", async () => {
  const cov = out => ({ ...deps(), sh: (cmd, o = {}) => (/toolCoverage/.test(cmd) ? (typeof out === "function" ? out(cmd, o) : out) : sh(cmd)) });
  let seen = null;
  const w = await readWorld(TEST_ENV, cov((cmd, o) => { seen = { cmd, asForge: !!o.asForge }; return `noise\n${JSON.stringify({ ids: ["H-1", "H-2", "H-3"], missing: [{ id: "H-2", why: "H-2 has no tool" }] })}\n`; }));
  assert.deepEqual(w.tools, { scenarios: 3, missing: [{ id: "H-2", why: "H-2 has no tool" }] });
  assert.match(seen.cmd, /import\("\/usr\/local\/lib\/godspeed-test-machine\/test-machine\/test-machine\.mjs"\)/, "the test machine's own check, imported, never copied");
  // its path is never an argument: as process.argv[1] it would make the module think it was started
  // itself and run a whole look (seen on the AX41, 2026-11-18 18:03)
  assert.doesNotMatch(seen.cmd, /process\.argv|test-machine\.mjs'?\s*$/);
  assert.equal(seen.asForge, false);
  assert.ok(!w.unreadable.some(u => u.part === "tools"));
  const bad = await readWorld(TEST_ENV, cov(""));
  assert.equal(bad.tools, null);
  assert.ok(bad.unreadable.some(u => u.part === "tools"));
  const noFile = await readWorld(TEST_ENV, cov(JSON.stringify({ ids: [], missing: [], why: "no hidden scenario file", failed: true })));
  assert.equal(noFile.tools, null);
  assert.ok(noFile.unreadable.some(u => u.part === "tools" && /no hidden scenario file/.test(u.error)));
});

test("failed one-off units from systemd-run are collected apart; a named failed unit still counts", async () => {
  const sh2 = cmd => /systemctl --failed/.test(cmd) ? "run-u123.service\nrun-u20610.scope\narchon-loop.service\nrun-my-thing.service\n" : sh(cmd);
  const w = await readWorld(TEST_ENV, { ...deps(), sh: sh2 });
  assert.deepEqual(w.server.anonymousFailedUnits, ["run-u123.service", "run-u20610.scope"]);
  assert.deepEqual(w.server.failedUnits, ["archon-loop.service", "run-my-thing.service"]);
});

test("when both a STOP and a PAUSE file exist, both are read: the PAUSE is never hidden by the STOP", async () => {
  const src = fs.readFileSync(new URL("../world.mjs", import.meta.url), "utf8");
  assert.ok(/if \(name === "PAUSE"\) f\.pause = s;/.test(src) && !/f\.stop = s;\s*break;/.test(src), "the loop no longer stops at the first file");
});

// ---------------------------------------------------------------- the Forge 0.3.3, item 7 (2026-11-25)
// No program makes the factory's STOP any more (the release step used to, while the scenarios ran, and on 2026-11-24 and
// 2026-11-25 that halted the factory). A STOP is read as what it is: a file with a writer's name, a number and a time.
const STAGE_ARGS = "/usr/bin/node /usr/local/lib/godspeed-factory/driver/driver.mjs --step stage --scheduled --settings-dir /etc/godspeed-forge\n";
const OLD_STOP = label => `${label} 2639648 2026-11-24T12:47:44.892Z\nThe release step pauses the factory while the scenarios run (the driver's stage step).\n`;
const BETA31_RUN = status => ({ id: 45396974921, status, conclusion: status === "completed" ? "failure" : null, head_branch: "candidate/2.0.0-beta.31", display_title: "scenarios candidate/2.0.0-beta.31" });

test("item 7: a STOP's writer runs when its name is in the process's command line, and the stage step is no special case", async () => {
  assert.equal(writerRuns("freeze", "/usr/bin/node /x/release/freeze.mjs o/r 1.0.0\n"), true);
  assert.equal(writerRuns("consumer.py", "python3 /x/consumer.py pause\n"), true);
  assert.equal(writerRuns("auto-stage", "/usr/bin/sleep 100\n"), false);
  assert.equal(writerRuns("auto-stage", STAGE_ARGS), false, "the stage step writes no STOP, so its name no longer matches its command");
  assert.equal(writerRuns("", STAGE_ARGS), false);
});

test("item 7: a leftover STOP of an older release step is read like any other STOP, and reading it asks GitHub nothing about scenarios", async () => {
  for (const label of ["auto-stage", "stage"]) {
    const d = projectDeps({ stop: OLD_STOP(label), writerArgs: "", scenarios: [BETA31_RUN("in_progress")] });
    const gh = d.gh, asked = [];
    d.gh = args => { asked.push(args.join(" ")); return gh(args); };
    const w = await readWorld(TEST_ENV, d);
    const s = w.factories[0].stop;
    assert.deepEqual([s.writer, s.pid, s.writerAlive, s.at], [label, 2639648, false, "2026-11-24T12:47:44.892Z"], label);
    assert.equal(s.scenariosRunning, undefined, "nothing says whether scenarios run: no STOP depends on it");
    assert.ok(!asked.some(a => a.includes("actions/workflows")), `no scenario run is read: ${asked.join(" | ")}`);
  }
});
