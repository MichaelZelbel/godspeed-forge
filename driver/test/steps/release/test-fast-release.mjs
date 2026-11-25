// A finished release reaches the go question within 30 minutes (the Forge 0.3.3, item 7; Michael, 2026-11-25: "a deterministic
// script that actually works, and not this garbage that gets hung up on every single release").
//
// The replay: Godspeed 2.0.0-beta.32 on 24 November 2026, through the stage step, against a stand-in GitHub that keeps time.
// Its last ticket's pull request (#1117, scenarios/ only, so the product built no server image for its merge) merged at about
// 23:05 UTC; that night the go question came at 00:47 after four hand steps. Here the driver starts the step every 15 minutes
// as on the server, and GitHub takes what it took that night or the times the task names: a server image 18 minutes, the
// Windows setup 4, a required check 18 on a pull request and 8 on main, the freeze 1, the short tests 6 with two AI-judged
// jobs failing and 4 more for their one rerun (10 in all), the install on the server 8 beside them. No network, no AI money.
// test cases: 18
import "./settings-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, runCases } from "../case-test.mjs";
import * as A from "../../../steps/release/auto-stage.mjs";
import * as G from "../../../steps/release/staging.mjs";
import * as SC from "../../../steps/release/staging-check.mjs";
import { PRODUCT_REPO } from "../../../steps/release/staging.mjs";

const REPO = PRODUCT_REPO;
const MIN = 60000;
const VERSION = "2.0.0-beta.32";
const ID = "godspeed-2.0.0-beta.32-clear-first-day";
const at = (iso) => Date.parse(iso);
const hex = (s) => (s + "0".repeat(40)).slice(0, 40);

// The product's scenarios/scenario-gate.tsv as it stood on the candidate's tag that night.
export const GATE_TSV = `# job\tgroup
# The release gate: which jobs of .github/workflows/scenarios.yml can hold up a release.
linux-install\trelease
mac-install\trelease
docker-server\trelease
linux-update\trelease
settings-on-install\trelease
voice\tweekly
local-voice\tweekly
update-keeps-everything\trelease
two-machines-move-at-once\tweekly
reminder-from-settings\trelease
reminder-closed-elsewhere\trelease
briefing-breaks-a-rule\trelease
windows-old-names-move\trelease
telegram-language\trelease
brief-asked-in-chat\trelease
talk-prep-honest\trelease
plain-yes\trelease
what-was-that\trelease
first-day\trelease
server-update-keeps-everything\trelease
`;
const FLAKY = ["plain-yes", "talk-prep-honest"]; // the two AI-judged jobs that failed on attempt 1 and passed on the rerun

const PLAN = `---
release: ${ID}
repository: ${REPO}
---

# Godspeed ${VERSION}: clear first day

Status: approved by Michael on 2026-11-24

## What it delivers

1. **Public routes for the talk preparation.** The holdout journeys have a maintained route.
2. **Person pages open the right way.** No sideways pages.

- Issues: item 1 #616, 2 #1033, each labelled \`beta.32\`.
`;

// ---------- the stand-in GitHub, with a clock ----------

function sim(o = {}) {
  const D = { image: 18, windows: 4, prCheck: 18, mainCheck: 8, freeze: 1, firstTests: 6, rerun: 4, slowTests: 35, ...(o.durations || {}) };
  const s = {
    clock: at(o.start || "2026-11-24T22:50:00Z"),
    events: [],
    main: [{ sha: hex("a27a242ba3"), at: at("2026-11-24T22:42:08Z"), image: true }],
    commits: new Map(),
    registry: new Set([hex("a27a242ba3")]),
    artifacts: new Set([hex("a27a242ba3")]),
    checks: new Map([[hex("a27a242ba3"), at("2026-11-24T22:50:00Z")]]),
    runs: [], // builds: {id, wf, sha, branch, event, created, status, conclusion, attempt}
    branches: new Map(),
    scenarioRuns: [],
    pr: null,
    tag: null,
    goAt: null,
    goArgs: null,
    dispatches: [],
    buildDispatches: [],
    notices: [],
    filed: [],
    people: [], // every result that needs a person: a halt, a needs-judgment, a message other than the go question
    looks: [],
    lastMerge: at(o.lastMerge || "2026-11-24T23:05:10Z"),
    issueOpen: true,
    D,
  };
  let nextId = 45500000000;
  const id = () => nextId++;
  s.commits.set(hex("a27a242ba3"), { parents: [], version: false });
  s.schedule = (when, fn) => { s.events.push({ when, fn }); s.events.sort((a, b) => a.when - b.when); };
  s.advance = (to) => {
    while (s.events.length && s.events[0].when <= to) {
      const e = s.events.shift();
      s.clock = Math.max(s.clock, e.when);
      e.fn();
    }
    s.clock = Math.max(s.clock, to);
  };
  const tipOf = () => s.main.filter((c) => c.at <= s.clock).at(-1).sha;
  s.tip = tipOf;
  const onMain = (sha) => s.main.some((c) => c.sha === sha && c.at <= s.clock) || (s.pr && s.pr.merged && s.pr.head === sha);
  // a build run: started now, done after its minutes; the image is published only from main or release/**
  const build = (wf, sha, branch, event) => {
    const minutes = wf === "image" ? D.image : D.windows;
    const run = { id: id(), wf, sha, branch, event, created: s.clock, status: "in_progress", conclusion: null, attempt: 1 };
    s.runs.push(run);
    s.schedule(s.clock + minutes * MIN, () => {
      run.status = "completed";
      run.conclusion = "success";
      (wf === "image" ? s.registry : s.artifacts).add(sha);
    });
    return run;
  };
  // a commit merged into main: GitHub builds the Windows setup for every one, the server image only for some paths
  s.mergeToMain = (sha, { image = false, version = false, parents = null } = {}) => {
    s.commits.set(sha, { parents: parents || [tipOf()], version });
    s.main.push({ sha, at: s.clock, image });
    build("windows", sha, "main", "push");
    if (image) build("image", sha, "main", "push");
    s.checks.set(sha, s.clock + (image ? D.prCheck : D.mainCheck) * MIN);
  };
  // the last ticket's pull request merges (scenarios/ only: no server image for it)
  s.schedule(s.lastMerge, () => {
    s.mergeToMain(hex("dcbba308dc"));
    s.issueOpen = false;
  });
  for (const m of o.factoryMerges || []) s.schedule(at(m.at), () => s.mergeToMain(hex(m.sha), { image: !!m.image }));
  if (o.versionOnMain) {
    // the version was raised on main by hand before the last ticket: the pin itself carries it
    s.commits.get(hex("a27a242ba3")).version = true;
  }
  const versionCarried = (sha) => {
    for (let c = sha, n = 0; c && n < 50; n++) {
      const k = s.commits.get(c);
      if (!k) return false;
      if (k.version) return true;
      c = k.parents[0];
    }
    return false;
  };
  s.versionCarried = versionCarried;
  const pushBranch = (name, sha) => {
    s.branches.set(name, sha);
    if (/^release\//.test(name)) {
      build("windows", sha, name, "push");
      // the image workflow runs on a push only when the push changed its paths (notebook/package.json is one of them)
      if (o.imageOnPush !== false && /^release\/version-/.test(name)) build("image", sha, name, "push");
    }
  };

  const records = new Map([[`releases/${ID}/plan.md`, PLAN], [`releases/${ID}/tickets/01-restore-public-routes.md`, "Ticket 1.\n"], [`releases/${ID}/tickets/02-fix-sideways-person-pages.md`, "Ticket 2.\n"]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fast-release-"));
  const stop = path.join(dir, "factory", ".factory", "STOP");
  fs.mkdirSync(path.dirname(stop), { recursive: true });
  const cfg = { ...A.loadConfig({}), repo: REPO, stateDir: dir, stopFile: stop, noticesFile: path.join(dir, "notices.json"), pollSeconds: 60, fastPollSeconds: 30, lookMinutes: 150, scenarioWaitMinutes: 100 };
  fs.writeFileSync(cfg.noticesFile, JSON.stringify({ notices: [] }));
  s.dir = dir;
  s.stop = stop;
  s.cfg = cfg;
  s.records = records;

  const issueNode = (n) => {
    if (n === 1033) return { number: 1033, state: "CLOSED", stateReason: "COMPLETED", closedByPullRequestsReferences: { nodes: [{ number: 1080, state: "MERGED", mergedAt: "2026-11-24T18:00:00Z", baseRefName: "main", repository: { nameWithOwner: REPO }, mergeCommit: { oid: hex("1096e3b364") } }] }, timelineItems: { nodes: [] } };
    // #616: the factory's pull request #1117 names it (no closing keyword); it is closed with a comment of the builder App
    if (s.issueOpen) return { number: 616, state: "OPEN", stateReason: null, closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [{ __typename: "CrossReferencedEvent", source: { __typename: "PullRequest", number: 1117, state: "OPEN", repository: { nameWithOwner: REPO } } }] } };
    return { number: 616, state: "CLOSED", stateReason: "COMPLETED", closedByPullRequestsReferences: { nodes: [{ number: 1117, state: "MERGED", mergedAt: new Date(s.lastMerge).toISOString(), baseRefName: "main", repository: { nameWithOwner: REPO }, mergeCommit: { oid: hex("dcbba308dc") } }] }, timelineItems: { nodes: [] } };
  };

  const scenarioRun = (tag, only) => {
    const flaky = !only || FLAKY.some((j) => only.includes(j));
    const slow = !only || only.includes("mac-install") || only.includes("windows-old-names-move");
    const run = { id: id(), tag, only, created: s.clock, updated: s.clock, attempt: 1, status: "in_progress", conclusion: null, failed: [] };
    const minutes = slow && !(only && only.every((j) => ["mac-install", "windows-old-names-move"].includes(j))) ? 41 : slow ? D.slowTests : D.firstTests;
    s.scenarioRuns.push(run);
    s.schedule(s.clock + minutes * MIN, () => {
      run.status = "completed";
      run.updated = s.clock;
      if (flaky && run.attempt === 1) {
        run.conclusion = "failure";
        run.failed = ["a plain yes or a button answers the right waiting step", "a talk says when its preparation did not pass, and opens from one that did", "the verdict"];
      } else if (o.slowFails && only && only.includes("windows-old-names-move")) {
        run.conclusion = "failure";
        run.failed = ["an old Windows install moves to the new folder names", "the verdict"];
      } else run.conclusion = "success";
    });
    return run;
  };

  s.ctx = () => {
    const exits = [];
    const stateFile = path.join(dir, "state.json");
    return {
      cfg, env: {}, dry: false, only: null, stateFile,
      state: A.loadState(stateFile),
      log: (line) => (s.log ||= []).push(`${new Date(s.clock).toISOString().slice(11, 19)} ${line}`),
      page: () => { s.pages = (s.pages || 0) + 1; },
      now: () => s.clock,
      sleep: async (ms) => s.advance(s.clock + Math.max(ms, 1000)),
      onExit: (f) => exits.push(f),
      runExits: () => exits.splice(0).forEach((f) => f()),
      records: {
        releases: () => [...new Set([...records.keys()].map((k) => k.split("/")[1]))],
        read: (p) => (records.has(p) ? records.get(p) : null),
        json: (p) => (records.has(p) ? JSON.parse(records.get(p)) : null),
        ticketFiles: () => [...records.keys()].filter((k) => k.includes("/tickets/")),
        fetch: () => {},
        write: (changes) => { for (const [k, v] of Object.entries(changes)) records.set(k, v); return hex("f00d"); },
      },
      publicVersion: async () => s.publicVersion || "2.0.0-beta.31",
      tagCommit: async () => s.tag,
      tagTime: async () => null,
      api: async (method, p) => {
        if (p !== "/graphql") throw new Error(`unexpected api call ${method} ${p}`);
        return { ok: true, status: 200, json: { data: { repository: { labelled: { nodes: [issueNode(616), issueNode(1033)] }, i616: issueNode(616), i1033: issueNode(1033) } } } };
      },
      // the old step's question (kept so the replay can show what the step before 25 November 2026 did): main's newest change, once its check passed
      mainHead: async () => {
        const tip = tipOf();
        return s.checks.get(tip) <= s.clock ? { commit: tip } : { none: "main's newest change has not passed its required check yet (in_progress)" };
      },
      mainTip: async () => tipOf(),
      checkState: async (sha) => (!s.checks.has(sha) ? "none" : s.checks.get(sha) <= s.clock ? "passed" : "running"),
      rerunChecks: async () => 0,
      buildReady: async (kind, sha) => (kind === "image" ? s.registry : s.artifacts).has(sha),
      buildRun: async (kind, sha) => {
        const r = s.runs.filter((x) => x.wf === kind && x.sha === sha && ["push", "workflow_dispatch"].includes(x.event)).at(-1);
        return r ? { id: r.id, status: r.status, conclusion: r.conclusion, startedAt: new Date(r.created).toISOString(), attempt: r.attempt } : null;
      },
      dispatchBuild: async (kind, ref) => {
        s.buildDispatches.push([kind, ref, new Date(s.clock).toISOString()]);
        const sha = ref === "main" ? tipOf() : s.branches.get(ref);
        if (sha) build(kind, sha, ref, "workflow_dispatch");
      },
      rerunFailed: async (runId) => {
        const b = s.runs.find((x) => x.id === runId);
        if (b) return;
        const run = s.scenarioRuns.find((x) => x.id === runId);
        run.attempt++;
        run.status = "in_progress";
        run.conclusion = null;
        run.failed = [];
        s.schedule(s.clock + D.rerun * MIN, () => { run.status = "completed"; run.conclusion = "success"; run.updated = s.clock; });
      },
      versionPull: {
        find: async (branch) => (s.pr && s.pr.branch === branch ? { number: s.pr.number, state: s.pr.merged ? "closed" : "open", merged: s.pr.merged, head: s.pr.head, title: s.pr.title } : null),
        versionAt: async (sha) => (versionCarried(sha) ? VERSION : "2.0.0-beta.31"),
        parentOf: async (sha) => (s.commits.get(sha) || { parents: [null] }).parents[0],
        open: async ({ branch, title, onto }) => {
          if (versionCarried(onto)) return { unchanged: true };
          const v = hex(`3928cfb${s.commits.size}`);
          s.commits.set(v, { parents: [onto], version: true });
          s.pr = { number: 1126, branch, title, head: v, merged: false, openedAt: s.clock };
          s.checks.set(v, s.clock + D.prCheck * MIN);
          pushBranch(branch, v);
          return { pr: 1126, head: v };
        },
        update: async ({ branch, onto }) => {
          const v = hex(`5928cfb${s.commits.size}`);
          s.commits.set(v, { parents: [onto], version: true });
          s.pr = { ...s.pr, head: v };
          s.checks.set(v, s.clock + D.prCheck * MIN);
          pushBranch(branch, v);
          return { head: v };
        },
        pointBranch: async (branch, sha) => { pushBranch(branch, sha); return { branch }; },
        required: async (sha) => ({ state: s.checks.get(sha) <= s.clock ? "passed" : "running" }),
        failures: async () => "nothing failed",
        merge: async ({ pr, head, method }) => {
          if (!s.pr || s.pr.number !== pr || s.pr.head !== head) return { ok: false, message: "status 409" };
          s.pr.merged = true;
          s.pr.method = method;
          const m = hex(`41280c45${s.main.length}`);
          s.mergeToMain(m, { image: true, version: true, parents: [tipOf(), head] });
          return { ok: true, sha: m };
        },
      },
      run: async (args) => {
        const name = path.basename(args[0]);
        if (name === "freeze.mjs") {
          const c = args[args.indexOf("--commit") + 1];
          const refuse = (line) => ({ code: 1, stdout: "", stderr: `${line}\n` });
          if (s.tag) return refuse(`${REPO} already has the tag candidate/${VERSION}, so ${VERSION} was frozen before; nothing was written.`);
          if (!onMain(c)) return refuse(`Commit ${c} is neither on main of ${REPO} nor on its release branch release/${VERSION}, and a candidate is frozen from a commit merged into one of the two.`);
          if (!s.registry.has(c)) return refuse(`The server image ghcr.io/michaelzelbel/godspeed-mission-control:v2-sha-${c} is not in the registry, so there is nothing to freeze; CI builds it for every commit on main.`);
          if (!s.artifacts.has(c)) return refuse(`GitHub holds no Windows setup built for commit ${c.slice(0, 7)} (no artifact windows-setup-${c}): the product's windows setup workflow builds it for every commit on main, so wait for its run on that commit, or name a folder build-exe.sh wrote with --windows. Nothing was written.`);
          if (!versionCarried(c)) return refuse(`/tmp/freeze-windows-x/windows-manifest.json says version 2.0.0-beta.31, not ${VERSION}.`);
          if (!args.includes("--dry-run")) {
            s.advance(s.clock + D.freeze * MIN);
            s.tag = hex("ff49559da2");
            s.frozenCommit = c;
            s.frozenAt = s.clock;
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (name === "stage-server.mjs") {
          // the install takes 8 minutes beside the tests (shorter than they are): its record says when it ended
          records.set(`releases/${ID}/staging.json`, JSON.stringify({ version: VERSION, productCommit: s.frozenCommit, status: "installed", installedAt: new Date(s.clock + 8 * MIN).toISOString(), healthAfter: { ok: true, version: VERSION } }));
          return { code: 0, stdout: "", stderr: "" };
        }
        if (name === "staging-check.mjs") {
          const run = s.scenarioRuns.filter((r) => r.tag === `candidate/${VERSION}`).at(-1);
          if (run && run.status === "completed" && run.conclusion === "success" && !s.goAt) {
            s.goAt = Math.max(s.clock, Date.parse(JSON.parse(records.get(`releases/${ID}/staging.json`)).installedAt));
            s.goArgs = args.slice(1);
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected child ${name}`);
      },
      notify: (n) => { s.notices.push(n); A.queueNotice(cfg.noticesFile, { ...n, facts: [n.text] }); },
      gateJobs: async () => ({ jobs: A.gateReleaseJobs(GATE_TSV) }),
      scenarios: async (version) => {
        const tag = `candidate/${version}`;
        if (!s.tag) return { result: "unreadable", problem: "no tag" };
        const r = s.scenarioRuns.filter((x) => x.tag === tag).at(-1);
        if (!r) return { result: "none", tag };
        const base = { tag, run: r.id, url: `https://github.com/${REPO}/actions/runs/${r.id}`, at: new Date(r.updated).toISOString() };
        if (r.status !== "completed") return { result: "running", ...base };
        return r.conclusion === "success" ? { result: "passed", ...base } : { result: "failed", failedJobs: r.failed, ...base };
      },
      dispatch: async (tag, opts = {}) => {
        if (s.refuseDispatches > 0) { s.refuseDispatches--; throw new Error("GitHub said 422 to starting the scenarios"); }
        s.dispatches.push([tag, opts, new Date(s.clock).toISOString()]);
        if (s.loseDispatches > 0) { s.loseDispatches--; return; } // taken, and never shown
        scenarioRun(tag, opts.only || null);
      },
      runInfo: async (runId) => { const r = s.scenarioRuns.find((x) => x.id === runId); return r ? { attempt: r.attempt, status: r.status } : null; },
      runProgress: async (runId) => {
        const r = s.scenarioRuns.find((x) => x.id === runId);
        const total = r.only ? r.only.length : 17;
        return { done: r.status === "completed" ? total : Math.min(total - 1, Math.floor(((s.clock - r.created) / (D.firstTests * MIN)) * total)), total };
      },
      failedJobs: async (runId) => s.scenarioRuns.find((x) => x.id === runId).failed,
      failedChecks: async () => null,
      jobLog: async (runId, job) => `FAIL ${job.split(" ")[0]}: the AI answered something else\n`,
      mainFailures: async () => ({}),
      openIssues: async () => [],
      fileIssue: async (issue) => { s.filed.push(issue); return { number: 1200 + s.filed.length, url: "x" }; },
    };
  };
  return s;
}

// The driver as on the server: a round every five minutes, which starts the stage step when it is due (15 minutes after its last
// start) and not running. Each result that needs a person is kept. -> the sim
async function driveUntil(s, untilIso, { stopAtGo = true } = {}) {
  const until = at(untilIso);
  let launchedAt = -Infinity;
  while (s.clock < until && !(stopAtGo && s.goAt)) {
    if (s.clock >= launchedAt + 15 * MIN) {
      launchedAt = s.clock;
      const started = s.clock;
      const ctx = s.ctx();
      const r = await A.autoStage(ctx);
      ctx.runExits();
      s.looks.push({ from: new Date(started).toISOString().slice(11, 19), to: new Date(s.clock).toISOString().slice(11, 19), outcome: r.outcome, why: r.why || "" });
      if (r.halt || ["needs-judgment", "halted"].includes(r.outcome)) s.people.push({ at: new Date(s.clock).toISOString(), outcome: r.outcome, halt: r.halt && r.halt.key, words: r.halt && r.halt.words });
    }
    const nextRound = Math.floor(s.clock / (5 * MIN)) * 5 * MIN + 5 * MIN;
    s.advance(nextRound);
  }
  for (const n of s.notices) s.people.push({ at: "", outcome: "message", words: n.text });
  return s;
}
const minutesToGo = (s) => (s.goAt - s.lastMerge) / MIN;

// ---------- the replay ----------

test("beta.32's night, replayed: from the last merge to the go question in at most 30 minutes, with no person and no hand step", async () => {
  const s = await driveUntil(sim({ factoryMerges: [{ at: "2026-11-24T23:34:47Z", sha: "f6a4f8182e" }, { at: "2026-11-25T00:05:00Z", sha: "0e06e287f8" }] }), "2026-11-25T02:00:00Z");
  assert.deepEqual(s.people, [], "nobody was needed: no halt, no decision, no message but the go question");
  assert.ok(s.goAt, `the go question was sent (looks: ${JSON.stringify(s.looks)})`);
  const m = minutesToGo(s);
  assert.ok(m <= 30, `last merge to go question: ${m.toFixed(1)} minutes (looks: ${JSON.stringify(s.looks)})`);
  // what was frozen: the version as one commit on the commit main had when every ticket was done
  assert.equal(s.versionCarried(s.frozenCommit), true);
  assert.equal(s.commits.get(s.frozenCommit).parents[0], hex("dcbba308dc"), "the version commit stands on the last ticket's merge");
  assert.equal(s.pr.method, "merge", "merged with a merge commit, so that very commit is on main");
  assert.equal(s.buildDispatches.length, 0, "the push of the version branch built its image and setup; nothing had to be started by hand");
  // the short run before the go: the release gate without the Mac and the old Windows jobs, read from the gate file
  assert.equal(s.dispatches.length, 1);
  const only = s.dispatches[0][1].only;
  assert.ok(only.includes("first-day") && only.includes("plain-yes") && !only.includes("mac-install") && !only.includes("windows-old-names-move"), only.join(","));
  assert.deepEqual(s.goArgs.slice(-2), ["--later", "2"], "the go question says two slow tests run after it is public");
  assert.equal(fs.existsSync(s.stop), false, "the factory is not left paused");
  console.log(`  modeled: last merge 23:05:10, frozen ${new Date(s.frozenAt).toISOString().slice(11, 19)}, go question ${new Date(s.goAt).toISOString().slice(11, 19)}: ${m.toFixed(1)} minutes`);
});

test("the factory merging every few minutes while the builds run changes nothing: the pinned commit is frozen and nothing waits for main", async () => {
  const merges = [];
  for (let i = 0; i < 6; i++) merges.push({ at: new Date(at("2026-11-24T23:08:00Z") + i * 4 * MIN).toISOString(), sha: `fac${i}`, image: i % 2 === 0 });
  const s = await driveUntil(sim({ factoryMerges: merges }), "2026-11-25T02:00:00Z");
  assert.deepEqual(s.people, []);
  assert.ok(s.goAt && minutesToGo(s) <= 30, `${s.goAt ? minutesToGo(s).toFixed(1) : "no go"} minutes`);
  assert.equal(s.commits.get(s.frozenCommit).parents[0], hex("dcbba308dc"), "not main's newest head");
  assert.ok(s.main.length >= 7, "main moved on meanwhile");
  assert.equal(fs.existsSync(s.stop), false, "nothing held the factory for it");
});

test("a newer release approved while the version builds does not take the step off the pinned one", async () => {
  const s = sim();
  // beta.33 was approved that night while beta.32 was being frozen
  s.schedule(at("2026-11-24T23:10:00Z"), () => s.records.set("releases/godspeed-2.0.0-beta.33-keeps-what-you-add/plan.md", PLAN.replace(/beta\.32/g, "beta.33").replace("#616, 2 #1033", "#1140, 2 #1141")));
  await driveUntil(s, "2026-11-25T02:00:00Z");
  assert.deepEqual(s.people, []);
  assert.ok(s.goAt && minutesToGo(s) <= 30, JSON.stringify(s.looks));
  assert.equal(s.commits.get(s.frozenCommit).parents[0], hex("dcbba308dc"));
});

test("the old step on the same night needed a person: it stopped on the server image nobody built", async () => {
  // what the step did before 25 November 2026, kept as the contrast: run this file against the old auto-stage.mjs and the
  // two tests above fail; here the old behaviour is read from the same stand-in, so the night's first stop is shown
  const s = sim();
  s.advance(at("2026-11-24T23:25:00Z"));
  const ctx = s.ctx();
  const r = await ctx.run([path.join("x", "freeze.mjs"), REPO, VERSION, "--commit", s.tip(), "--no-staging", "--dry-run"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /v2-sha-dcbba308.* is not in the registry/, "the night's refusal at 23:25");
  assert.deepEqual(A.freezeRefusalWords(r.stderr.trim(), VERSION).kind, "build", "now a wait the step ends itself, never a person's decision");
});

test("a commit whose server image GitHub never built is built by the step, once, never a person's decision (the version already on main)", async () => {
  // main already carries the version (raised by hand): the pin itself is frozen, and its image was never built (scenarios/ only)
  const s = await driveUntil(sim({ versionOnMain: true }), "2026-11-25T02:00:00Z");
  assert.deepEqual(s.people, []);
  assert.ok(s.goAt, JSON.stringify(s.looks));
  assert.equal(s.frozenCommit, hex("dcbba308dc"), "the pin itself");
  assert.deepEqual(s.buildDispatches.map(([k, ref]) => [k, ref]), [["image", "release/build-2.0.0-beta.32"]], "the image started once, on a branch at the pin; the Windows setup came from main's push");
  assert.ok(s.log.some((l) => /GitHub had not built the server image for dcbba30, so the release step started that build on release\/build-2\.0\.0-beta\.32/.test(l)), "said so in the look");
  assert.ok(s.log.some((l) => /^.{9}Waiting: building the server image for dcbba30, about 18 minutes \(done about \d\d:\d\d UTC\)/.test(l)), "the look line names the wait and its expected end");
});

test("a version branch whose push started no image build gets one started on it, once", async () => {
  const s = await driveUntil(sim({ imageOnPush: false }), "2026-11-25T02:00:00Z");
  assert.deepEqual(s.people, []);
  assert.ok(s.goAt);
  assert.deepEqual(s.buildDispatches.map(([k, ref]) => [k, ref]), [["image", "release/version-2.0.0-beta.32"]]);
  assert.equal(s.frozenCommit, s.pr.head);
});

test("the look line names each wait with its expected end, and a fresh page every read", async () => {
  const s = await driveUntil(sim(), "2026-11-25T02:00:00Z");
  const waits = s.log.filter((l) => /Waiting: /.test(l));
  assert.ok(waits.some((l) => /building the server image for \w{7}, about 18 minutes \(done about 23:2\d UTC\)/.test(l)), waits.slice(0, 5).join("\n"));
  assert.ok(waits.some((l) => /short tests on candidate\/2\.0\.0-beta\.32, \d+ of 15 done \(done about \d\d:\d\d UTC\)/.test(l)), waits.filter((l) => /short/.test(l)).join("\n"));
  assert.ok(s.pages > 10, "each read is a page of its own");
  assert.ok(waits.some((l) => /Waiting: the release's last tickets are still open \(#616 with its pull request #1117 open\)\./.test(l)), "the watch on the last ticket is the look's line too");
  // the same wait reads the same on every page (its end is a clock time), so the release clock sees no change while it lasts
  const imageLines = new Set(waits.flatMap((l) => l.slice(9).split("; ")).filter((part) => /building the server image/.test(part)));
  assert.equal(imageLines.size, 1, [...imageLines].join("\n"));
});

test("after the go: the slow jobs run once on the tag, a failure is filed and said once, and nothing is held or run again", async () => {
  const s = await driveUntil(sim({ slowFails: true }), "2026-11-25T02:00:00Z");
  assert.ok(s.goAt);
  s.publicVersion = VERSION; // Michael said go, and the candidate was promoted
  await driveUntil(s, "2026-11-25T03:30:00Z", { stopAtGo: false });
  const after = s.dispatches.slice(1);
  assert.equal(after.length, 1, "once");
  assert.deepEqual(after[0][1].only, ["mac-install", "windows-old-names-move"]);
  assert.equal(s.filed.length, 1, "the failed slow job is one bug for the factory");
  assert.match(s.filed[0].title, /an old Windows install moves to the new folder names/);
  assert.match(s.filed[0].body, /in its one run after the release went public/);
  assert.match(s.filed[0].body, /held nothing back/);
  assert.equal(s.notices.length, 1, "one note");
  assert.match(s.notices[0].text, /^After 2\.0\.0-beta\.32 went public, its slow tests ran once and one did not pass\. "an old Windows install moves to the new folder names": .*filed for the factory as #1201.*nothing was held back or taken back\.$/);
  assert.ok(!s.people.some((p) => p.halt), "no halt");
  await driveUntil(s, "2026-11-25T05:00:00Z", { stopAtGo: false });
  assert.equal(s.dispatches.length, 2, "never a second slow run");
  assert.equal(s.notices.length, 1, "never a second note");
});

test("review fix: after the go, a start GitHub refused is asked again; one GitHub took and never showed is said once, never started twice", async () => {
  const s = await driveUntil(sim(), "2026-11-25T02:00:00Z");
  s.publicVersion = VERSION;
  s.refuseDispatches = 1;
  await driveUntil(s, "2026-11-25T02:20:00Z", { stopAtGo: false });
  assert.equal(s.dispatches.length, 2, "refused, then started by the next look");
  const t = sim();
  await driveUntil(t, "2026-11-25T02:00:00Z");
  t.publicVersion = VERSION;
  t.loseDispatches = 1;
  await driveUntil(t, "2026-11-25T04:00:00Z", { stopAtGo: false });
  assert.equal(t.dispatches.length, 2, "never started a second time (it costs money from the test key)");
  assert.equal(t.notices.length, 1);
  assert.equal(t.notices[0].text, "After 2.0.0-beta.32 went public, its slow tests were started but never showed on GitHub, so they did not run. They were not started a second time, because each run costs money from the test key: say if you want them run.");
  assert.equal(A.loadState(path.join(t.dir, "state.json")).releases[ID].longRun.lost, true);
});

test("after the go, slow jobs that pass are only written down", async () => {
  const s = await driveUntil(sim(), "2026-11-25T02:00:00Z");
  s.publicVersion = VERSION;
  await driveUntil(s, "2026-11-25T03:30:00Z", { stopAtGo: false });
  assert.equal(s.dispatches.length, 2);
  assert.equal(s.notices.length, 0);
  assert.equal(s.filed.length, 0);
  assert.equal(A.loadState(path.join(s.dir, "state.json")).releases[ID].longRun.result, "passed");
});

test("the slow jobs never start before the go, and not for a candidate the public went past", async () => {
  const s = await driveUntil(sim(), "2026-11-25T02:00:00Z");
  await driveUntil(s, "2026-11-25T03:00:00Z", { stopAtGo: false });
  assert.equal(s.dispatches.length, 1, "no go yet: nothing more runs");
  s.publicVersion = "2.0.0-beta.33";
  await driveUntil(s, "2026-11-25T04:00:00Z", { stopAtGo: false });
  assert.equal(s.dispatches.length, 1);
  assert.match(A.loadState(path.join(s.dir, "state.json")).releases[ID].longRun.skipped, /went to 2\.0\.0-beta\.33 without it/);
});

// ---------- the pieces ----------

test("the release gate is read from the gate file: every release row, in its order, comments and weekly rows left out", () => {
  const jobs = A.gateReleaseJobs(GATE_TSV);
  assert.equal(jobs.length, 17);
  assert.equal(jobs[0], "linux-install");
  assert.ok(jobs.includes("mac-install") && jobs.includes("windows-old-names-move") && !jobs.includes("voice") && !jobs.includes("job"));
  assert.deepEqual(A.loadConfig({}).afterGoJobs, ["mac-install", "windows-old-names-move"]);
  assert.deepEqual(A.loadConfig({ AUTO_STAGE_AFTER_GO_JOBS: "mac-install" }).afterGoJobs, ["mac-install"]);
});

test("GitHub's answers: the required check, the build run that may publish (never a pull request's), a run's progress", () => {
  assert.equal(A.requiredState([]), "none");
  assert.equal(A.requiredState([{ name: "required", status: "in_progress", started_at: "2026-11-24T23:00:00Z" }]), "running");
  assert.equal(A.requiredState([{ name: "required", status: "completed", conclusion: "failure", started_at: "2026-11-24T23:00:00Z" }, { name: "required", status: "completed", conclusion: "success", started_at: "2026-11-24T23:10:00Z" }]), "passed", "the newest one counts");
  const sha = hex("3928cfb2f5");
  const runs = [
    { id: 1, head_sha: sha, event: "pull_request", status: "completed", conclusion: "success", created_at: "2026-11-24T23:55:22Z" },
    { id: 2, head_sha: sha, event: "push", status: "in_progress", conclusion: null, created_at: "2026-11-24T23:55:19Z", run_started_at: "2026-11-24T23:55:19Z", html_url: "u" },
  ];
  assert.deepEqual(A.newestBuildRun(runs, sha), { id: 2, status: "in_progress", conclusion: null, startedAt: "2026-11-24T23:55:19Z", attempt: 1, url: "u" });
  assert.equal(A.newestBuildRun([runs[0]], sha), null, "a pull request's run publishes nothing");
  assert.deepEqual(A.progressOf([{ status: "completed", conclusion: "success" }, { status: "in_progress" }, { status: "completed", conclusion: "skipped" }]), { done: 1, total: 2 });
});

test("review fix: a check run once more never starts a paid scenario run or a scheduled one", () => {
  const runs = [
    { id: 1, status: "completed", conclusion: "failure", event: "push", path: ".github/workflows/required.yml", name: "required" },
    { id: 2, status: "completed", conclusion: "failure", event: "push", path: ".github/workflows/scenarios.yml", name: "scenarios" },
    { id: 3, status: "completed", conclusion: "failure", event: "schedule", path: ".github/workflows/v2-integrated.yml", name: "Integrated Godspeed v2" },
    { id: 4, status: "completed", conclusion: "cancelled", event: "pull_request", path: ".github/workflows/v2-integrated.yml", name: "Integrated Godspeed v2" },
    { id: 5, status: "completed", conclusion: "success", event: "push", path: ".github/workflows/guide.yml", name: "guide" },
    { id: 6, status: "in_progress", conclusion: null, event: "push", path: ".github/workflows/windows-setup.yml", name: "windows setup" },
    { id: 7, status: "completed", conclusion: "failure", event: "push", path: ".github/workflows/required.yml", name: "required", run_attempt: 2 },
  ];
  assert.deepEqual(A.rerunnable(runs).map((r) => r.id), [1, 4], "a run already run once more (attempt 2) is never asked again");
});

test("review fix (round 2): a check run once more that GitHub refuses is a refusal, so it is asked again and never counted", async () => {
  const runs = [
    { id: 11, status: "completed", conclusion: "failure", event: "pull_request", path: ".github/workflows/required.yml", name: "required" },
    { id: 12, status: "completed", conclusion: "failure", event: "push", path: ".github/workflows/scenarios.yml", name: "scenarios" },
    { id: 13, status: "completed", conclusion: "failure", event: "push", path: ".github/workflows/v2-integrated.yml", name: "Integrated Godspeed v2" },
  ];
  const asked = [];
  const answer = (status) => async (method, p) => { asked.push(p); return { ok: status < 300, status, json: {} }; };
  assert.deepEqual(await A.rerunFailedRuns(answer(201), REPO, runs), { started: [11, 13], refused: null });
  assert.deepEqual(asked, [`/repos/${REPO}/actions/runs/11/rerun-failed-jobs`, `/repos/${REPO}/actions/runs/13/rerun-failed-jobs`], "never the paid scenarios");
  assert.deepEqual(await A.rerunFailedRuns(answer(403), REPO, runs), { started: [], refused: "GitHub said 403 to running the failed jobs of run 11 again" });
  assert.deepEqual(await A.rerunFailedRuns(answer(403), REPO, [runs[1]]), { started: [], refused: null }, "nothing a check may run again: nothing asked, nothing refused");
  // rounds 3 to 5: one taken, the next refused or not answered; the next read sees the taken one on its second attempt and asks
  // only the other, so no run is ever asked twice, whatever was lost (GitHub's attempt count is the record)
  const partly = async (method, p) => (p.includes("/runs/11/") ? { ok: true, status: 201, json: {} } : { ok: false, status: 403, json: {} });
  assert.deepEqual(await A.rerunFailedRuns(partly, REPO, runs), { started: [11], refused: "GitHub said 403 to running the failed jobs of run 13 again" });
  const gone = async (method, p) => { if (p.includes("/runs/13/")) throw new TypeError("fetch failed"); return { ok: true, status: 201, json: {} }; };
  assert.deepEqual(await A.rerunFailedRuns(gone, REPO, runs), { started: [11], refused: "GitHub did not answer the request to run the failed jobs of run 13 again (fetch failed)" });
  asked.length = 0;
  const after = runs.map((r) => (r.id === 11 ? { ...r, run_attempt: 2 } : r)); // run 11 was taken (its answer may even have been lost)
  assert.deepEqual(await A.rerunFailedRuns(answer(201), REPO, after), { started: [13], refused: null });
  assert.deepEqual(asked, [`/repos/${REPO}/actions/runs/13/rerun-failed-jobs`], "run 11 is never asked twice");
});

test("near the end: every open ticket has a pull request of this repository open, named or closing", () => {
  const node = (refs, timeline) => ({ closedByPullRequestsReferences: { nodes: refs }, timelineItems: { nodes: timeline } });
  assert.deepEqual(A.openPullsOf(node([], [{ __typename: "CrossReferencedEvent", source: { __typename: "PullRequest", number: 1117, state: "OPEN", repository: { nameWithOwner: REPO } } }]), REPO), [1117]);
  assert.deepEqual(A.openPullsOf(node([{ number: 9, state: "MERGED" }], [{ __typename: "CrossReferencedEvent", source: { __typename: "PullRequest", number: 5, state: "OPEN", repository: { nameWithOwner: "someone/else" } } }]), REPO), [], "merged ones and other repositories' do not count");
  const verdict = { state: "waiting", waitingOn: ["#616"], waitingIssues: [616] };
  assert.equal(A.nearTheEnd(verdict, { 616: { openPulls: [1117] } }), true);
  assert.equal(A.nearTheEnd(verdict, { 616: { openPulls: [] } }), false, "a ticket nobody works on yet: the next look comes in 15 minutes");
  assert.equal(A.nearTheEnd({ state: "waiting", waitingOn: ["#616", "#7 (could not be read)"], waitingIssues: [616] }, { 616: { openPulls: [1] } }), false, "an unreadable issue is no near end");
});

test("the go question says that slow tests run after it is public, in plain words", () => {
  assert.equal(SC.laterWords(0), "");
  assert.equal(SC.laterWords(2), " Two slow tests run once right after it is public; a failure there is filed as a bug and holds nothing back.");
  assert.equal(SC.laterWords(1), " One slow test runs once right after it is public; a failure there is filed as a bug and holds nothing back.");
});

test("the narrowed run before the go passes the gate staging-check and promote read: tonight's run 45519327689, its rerun included", async () => {
  // the newest run on the tag, titled as the release step's, attempt 2 green after two AI-judged jobs failed on attempt 1;
  // the Mac, the Windows and the weekly jobs skipped
  const tag = `candidate/${VERSION}`;
  const tagCommit = hex("ff49559da2");
  const jobs = [
    { name: "a stranger's Linux install", status: "completed", conclusion: "success" },
    { name: "a plain yes or a button answers the right waiting step", status: "completed", conclusion: "success" },
    { name: "a stranger's Mac install", status: "completed", conclusion: "skipped" },
    { name: "an old Windows install moves to the new folder names", status: "completed", conclusion: "skipped" },
    { name: "the verdict", status: "completed", conclusion: "success" },
  ];
  const api = async (method, p) => {
    if (p.includes("/git/ref/tags/")) return { ok: true, status: 200, json: { object: { type: "commit", sha: tagCommit } } };
    if (p.includes("/actions/workflows/")) return { ok: true, status: 200, json: { workflow_runs: [{ id: 45519327689, head_branch: tag, head_sha: tagCommit, display_title: `scenarios ${tag}`, status: "completed", conclusion: "success", run_attempt: 2, created_at: "2026-11-25T00:36:00Z", updated_at: "2026-11-25T00:46:35Z", html_url: "u" }] } };
    if (p.includes("/jobs")) return { ok: true, status: 200, json: { total_count: jobs.length, jobs } };
    throw new Error(p);
  };
  const sc = await G.scenarios({}, REPO, VERSION, api);
  assert.equal(sc.result, "passed");
  assert.equal(sc.run, 45519327689);
  const staging = { version: VERSION, status: "installed", installedAt: "2026-11-25T00:40:00Z", healthAfter: { ok: true, version: VERSION }, scenarios: { result: sc.result, run: sc.run, tag, tagCommit } };
  assert.equal(G.scenariosPassed(staging, VERSION), true, "what promote.mjs and staging-check read as passed");
  assert.match(SC.scenarioWords(sc), /every scenario passed against candidate\/2\.0\.0-beta\.32/);
});

await runCases();
