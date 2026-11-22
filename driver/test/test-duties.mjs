import { TEST_ENV } from "./env.mjs";
// node --test scripts/factory-driver/test-duties.mjs   (offline)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requiredRunId, seenFromTelegram, readActivity, resendDue, seenCheck, publishHeartbeat, mirroredHead, watcherHealth, supersessionLook, nextReleaseFacts, rung0 } from "../duties.mjs";
import { view, roundEvents } from "../journal.mjs";
import { launchAct, sandboxProps, controlPlane, actDefaults, repairRequest } from "../onduty.mjs";
import { setPause, clearPause, allowedUsers } from "../pause.mjs";

const H = 3600000, NOW = Date.parse("2026-11-21T22:00:00Z");

test("told means seen: a notice is repeated after 2 hours and then every morning until he looks, and the repeats never wait on the seen", () => {
  const n = at => ({ at, sentAt: [at], seen: false });
  assert.equal(resendDue(n(NOW - H), NOW), false); assert.equal(resendDue(n(NOW - 3 * H), NOW), true, "2 hours");
  const twice = { at: NOW - 30 * H, sentAt: [NOW - 30 * H, NOW - 28 * H], seen: false };
  assert.equal(resendDue({ ...twice, sentAt: [NOW - 30 * H, Date.parse("2026-11-21T07:30:00Z")] }, NOW), false, "already sent this morning");
  assert.equal(resendDue(twice, NOW), true, "this morning's repeat is due");
  assert.equal(resendDue({ ...twice, seen: true }, NOW), false, "seen: no more");
  assert.equal(resendDue(twice, Date.parse("2026-11-21T06:00:00Z")), false, "not before the morning");
  // seen = the GitHub issue (transport B) is closed
  assert.equal(seenCheck({ receipts: { github: "https://github.com/o/w/issues/4" } }, () => ({ stdout: JSON.stringify({ state: "closed" }) })).seen, true);
  assert.equal(seenCheck({ receipts: { github: "https://github.com/o/w/issues/4" } }, () => ({ stdout: JSON.stringify({ state: "open" }) })).seen, false);
  assert.equal(seenCheck({ receipts: { telegram: "5" } }, () => { throw new Error("no call"); }).seen, false);
});

test("the heartbeat goes to godspeed-dev with the journal head and the rung 3 receipts; the watcher's own last run is the workflow run, and a silent one is re-enabled or started", () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args.join(" ")); return { status: 0, stdout: "" }; };
  publishHeartbeat({}, { at: "t", journalHead: "h1", rung3: [{ id: "e", since: "s", receipts: { telegram: "1" } }], releases: [] }, run);
  const post = calls.find(c => /-X POST repos\/MichaelZelbel\/godspeed-dev\/issues/.test(c));
  assert.ok(post && /factory-heartbeat/.test(post) && /"head":"h1"/.test(post), "no heartbeat issue yet: it is created, in godspeed-dev, with the journal head");
  const BTX = String.fromCharCode(96).repeat(3), NLX = String.fromCharCode(10);
  const existing = [{ number: 7, user: { login: "MichaelZelbel" }, body: `<!-- factory-heartbeat -->${NLX}record${NLX}${NLX}${BTX}json${NLX}${JSON.stringify({ at: "t0", head: "h9" })}${NLX}${BTX}` }];
  const calls2 = []; publishHeartbeat({}, { at: "t", journalHead: "h2", rung3: [], releases: [] }, (c, a) => { calls2.push(a.join(" ")); return { status: 0, stdout: /state=(open|all)/.test(a.join(" ")) ? JSON.stringify(existing) : "" }; });
  assert.ok(calls2.some(c => /-X PATCH repos\/MichaelZelbel\/godspeed-dev\/issues\/7/.test(c)), "an existing heartbeat issue is edited, never duplicated");
  assert.equal(mirroredHead({}, () => ({ stdout: JSON.stringify(existing) })), "h9", "the mirrored head is read back from that issue");
  const created = new Date(NOW - 3 * H).toISOString();
  const mk = ({ state = "active", createdAt = created, runs = [], calls = [] } = {}) => (c, a) => { calls.push([c, ...a].join(" ")); const u = a.join(" ");
    if (/workflows\/factory-watch.yml\/runs/.test(u)) return { status: 0, stdout: JSON.stringify({ workflow_runs: /event=schedule/.test(u) ? runs.filter(r => r.event === "schedule") : runs }) };
    if (/workflows\/factory-watch.yml$/.test(u)) return { status: 0, stdout: JSON.stringify({ state, created_at: createdAt, updated_at: createdAt }) };
    return { status: 0, stdout: "" }; };
  const dis = [], dst = {}; const w1 = watcherHealth({}, NOW, mk({ state: "disabled_inactivity", calls: dis }), dst);
  assert.equal(w1.ok, true, "disabled and re-enabled: not a fault in itself"); assert.ok(w1.reenabled);
  assert.equal(watcherHealth({}, NOW + 31 * H, mk({ state: "disabled_inactivity", calls: dis }), dst).ok, false, "still disabled after the schedule's own lateness: a fault"); assert.ok(dis.some(x => /factory-watch.yml\/enable/.test(x)), "a disabled workflow is re-enabled");
  // GitHub's scheduler on this account runs hours late: nothing short of 30 hours is a fault
  assert.deepEqual(watcherHealth({}, NOW, mk({ createdAt: new Date(NOW - 3 * H).toISOString() })), { ok: true }, "installed 3 hours ago, no scheduled run yet: counted from the installation, not a fault");
  assert.deepEqual(watcherHealth({}, NOW, mk({ createdAt: new Date(NOW - 29 * H).toISOString() })), { ok: true }, "29 hours since installation: still within GitHub's lateness");
  assert.deepEqual(watcherHealth({}, NOW, mk({ createdAt: new Date(NOW - 100 * H).toISOString(), runs: [{ event: "schedule", created_at: new Date(NOW - 9 * H).toISOString(), status: "completed", conclusion: "success" }] })), { ok: true }, "a scheduled run 9 hours ago (a late one): fine");
  const dc = [], st = {};
  const w2 = watcherHealth({}, NOW, mk({ createdAt: new Date(NOW - 40 * H).toISOString(), calls: dc }), st);
  assert.equal(w2.ok, true, "over 30 hours: first the rung-0 fix, started by hand, not yet a machinery entry"); assert.ok(dc.some(x => /workflow run factory-watch.yml -R MichaelZelbel\/godspeed-dev/.test(x)));
  assert.equal(watcherHealth({}, NOW + 70 * 60000, mk({ createdAt: new Date(NOW - 40 * H).toISOString(), calls: dc }), st).ok, false, "still nothing an hour after being started by hand: a machinery entry");
  assert.equal(watcherHealth({}, NOW, mk({ createdAt: new Date(NOW - 100 * H).toISOString(), runs: [{ event: "schedule", created_at: new Date(NOW - 2 * H).toISOString(), status: "completed", conclusion: "failure" }] }), { watcherDispatch: { at: NOW - 2 * H, dispatched: true } }).ok, true, "a scheduled run happened (even a failed one): the schedule fires; a failing workflow is another question");
  assert.deepEqual(watcherHealth({}, NOW, () => ({ status: 1, stdout: "" })), { ok: true }, "GitHub not readable: external, not a fault");
});

test("supersession leaves the journal only through the containment check; otherwise the older release stays driven and is a stall", () => {
  const world = { superseded: [{ id: "old" }], installed: { id: "new", issues: [11, 12], staging: { productCommit: "c0ffee1" } } };
  const jv = id => ({ releases: { old: { id: "old", tickets: [{ item: 1, issue: 11 }, { item: 2, issue: 99 }], slots: { "t:1:resolved": 1, "t:1:merged": 1 }, commits: { "t:1:merged": "m1" } } } });
  let r = supersessionLook(jv(), world, () => ({ status: 0 }), "/checkout");
  assert.match(r.bad[0].why, /unfinished issues 99 are not in the newer release/); assert.equal(r.leave.length, 0);
  world.installed.issues = [11, 12, 99];
  r = supersessionLook(jv(), world, () => ({ status: 0 }), "/checkout"); assert.equal(r.leave.length, 1); assert.match(r.leave[0].check, /ancestors of c0ffee1/);
  r = supersessionLook(jv(), world, () => ({ status: 1 }), "/checkout"); assert.match(r.bad[0].why, /merge commits are not in the installed commit/);
});

test("the goal between releases: after an install, a next release is approved or proposed, or there is provably nothing to plan", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-")); const plans = path.join(dir, "releases");
  const jv = { releases: { "godspeed-1.0.0": { id: "godspeed-1.0.0", installed: { at: NOW - 7 * H } } } };
  const issues = n => () => ({ stdout: JSON.stringify(Array.from({ length: n }, () => ({}))) });
  assert.equal(await nextReleaseFacts({ REPO: "o/r" }, { releases: [] }, { releases: { "querino-1.0.0": { id: "querino-1.0.0", installed: { at: NOW - 7 * H } } } }, NOW, issues(1), plans), null, "another product installed is not Godspeed");
  assert.deepEqual(await nextReleaseFacts({ REPO: "o/r" }, { releases: [{ id: "x" }] }, jv, NOW, issues(1), plans), { needed: false, installedAt: NOW - 7 * H }, "a release is being driven");
  assert.equal((await nextReleaseFacts({ REPO: "o/r" }, { releases: [] }, jv, NOW, issues(0), plans)).needed, false, "nothing to plan");
  const r = await nextReleaseFacts({ REPO: "o/r" }, { releases: [] }, jv, NOW, issues(1), plans); assert.equal(r.needed, true); assert.match(r.why, /bug or priority/);
  fs.mkdirSync(path.join(plans, "querino-1.0.0-beta.2-x"), { recursive: true }); fs.writeFileSync(path.join(plans, "querino-1.0.0-beta.2-x", "plan.md"), "Status: proposed\n");
  assert.equal((await nextReleaseFacts({ REPO: "o/r" }, { releases: [] }, jv, NOW, issues(1), plans)).needed, true, "another product's proposed plan is not Godspeed's next release");
  fs.mkdirSync(path.join(plans, "godspeed-9.9.9-r2"), { recursive: true }); fs.writeFileSync(path.join(plans, "godspeed-9.9.9-r2", "plan.md"), "Status: proposed\n");
  assert.equal((await nextReleaseFacts({ REPO: "o/r" }, { releases: [] }, jv, NOW, issues(1), plans)).needed, false, "a proposed release counts");
  assert.equal(await nextReleaseFacts({ REPO: "o/r" }, { releases: [] }, { releases: {} }, NOW, issues(1), plans), null, "no install yet");
});

test("rung 0 needs no AI: the run that owns a failed required check is re-run once per head and window, the dead-man's timer is re-enabled", async () => {
  const world = { releases: [{ id: "r", tickets: [{ item: 1, issue: 11 }] }], items: { 11: { state: "open", prs: [{ number: 5, state: "open", requiredState: "failure", headSha: "sha1" }] } } };
  const calls = [], state = {};
  const run = (cmd, args) => { calls.push([cmd, ...args]); if (args[1] && /check-runs/.test(args[1])) return { status: 0, stdout: JSON.stringify({ check_runs: [{ name: "required", conclusion: "cancelled", completed_at: "2026-11-21T10:00:00Z", details_url: "https://github.com/o/r/actions/runs/99/job/1" }] }) }; if (cmd === "systemctl" && args[0] === "is-enabled") return { status: 1, stdout: "disabled" }; return { status: 0, stdout: "" }; };
  const out = await rung0({ REPO: "o/r" }, world, state, NOW, run);
  assert.ok(calls.some(c => c.join(" ").includes("actions/runs/99/rerun-failed-jobs"))); assert.ok(out.some(o => /re-ran the failed checks of pull request 5/.test(o.did))); assert.ok(out.some(o => /dead-man's timer/.test(o.did)));
  const again = await rung0({ REPO: "o/r" }, world, state, NOW + H, run); assert.ok(!again.some(o => /re-ran/.test(o.did)), "once per head within 2 hours");
  const lost = {}; await rung0({ REPO: "o/r" }, world, lost, NOW, (c, a) => (a[1] && /check-runs/.test(a[1]) ? { stdout: JSON.stringify({ check_runs: [] }) } : { status: 0, stdout: "" })); assert.ok(!Object.keys(lost.rung0 || {}).some(k => k.startsWith("rerun:")), "no owning run found: nothing recorded");
  const done = await rung0({ REPO: "o/r" }, { releases: [{ id: "r", tickets: [{ item: 2, issue: 12, file: "02.md" }] }], items: { 12: { state: "closed", prs: [{ merged: true, mergeSha: "d".repeat(40) }] } } }, {}, NOW, run, async (rel, t, sha) => { calls.push(["write", t.file, sha]); return true; });
  assert.ok(done.some(o => /wrote the done line of item 2/.test(o.did))); assert.ok(calls.some(c => c[0] === "write" && c[1] === "02.md"));
  assert.equal(requiredRunId("o/r", "s", () => ({ stdout: "garbage" })), null);
});

test("a Seen tap that arrives before its notice is known is kept, not lost", async () => {
  const state = { tgOffset: 0 };
  const { seenKey } = await import("../facts.mjs");
  assert.deepEqual(await seenFromTelegram({}, state, {}, { pollSeen: async () => ({ seen: [seenKey("n:late")], offset: 9 }) }), [], "the notice is not in the journal yet");
  assert.equal(state.tgOffset, 9);
  assert.deepEqual(await seenFromTelegram({}, state, { "n:late": {} }, { pollSeen: async () => ({ seen: [], offset: 9 }) }), ["n:late"], "the next round matches it");
  assert.deepEqual(await seenFromTelegram({}, state, { "n:late": {} }, { pollSeen: async () => ({ seen: [], offset: 9 }) }), [], "and it is used up");
});

test("an acting run on a release cannot destroy its supervision: no new privileges, no CAP_SYS_ADMIN, the control plane read-only; a driver-repair run may write the driver's install and never the dead-man or the journal", () => {
  const a = { ...actDefaults(TEST_ENV), ACT_DIR: "/var/lib/godspeed-factory-driver/acts" };
  const props = sandboxProps(a);
  assert.ok(props.includes("NoNewPrivileges=yes") && props.some(p => p.startsWith("CapabilityBoundingSet=~CAP_SYS_ADMIN")));
  const ro = props.find(p => p.startsWith("ReadOnlyPaths=")); for (const p of ["/usr/local/lib/godspeed-forge/driver", "/usr/local/lib/godspeed-factory-driver/deadman.mjs", "/etc/systemd/system", "/var/lib/godspeed-factory-driver", "/usr/local/lib/godspeed-factory-driver"]) assert.ok(ro.includes(p), p);
  assert.ok(props.find(p => p.startsWith("ReadWritePaths=")).includes("/acts"), "its own folder stays writable");
  const repair = controlPlane(a, "repair"); assert.ok(!repair.includes("/usr/local/lib/godspeed-forge/driver"), "a repair run may write the driver's install");
  assert.ok(repair.includes("/usr/local/lib/godspeed-factory-driver/deadman.mjs") && repair.includes("/var/lib/godspeed-factory-driver") && repair.includes("/etc/systemd/system"), "never the dead-man, the journal or the units");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "act-")); const calls = [];
  launchAct({}, { ...a, ACT_DIR: dir }, { unit: "factory-act-abc-1", entry: { kind: "ticket", title: "t", evidence: [] }, provider: "codex" }, (c, args) => { calls.push(args); return { status: 0 }; });
  assert.ok(calls[0].includes("NoNewPrivileges=yes") && calls[0].some(x => /ReadOnlyPaths=/.test(x)), "the real launch carries them");
  const f = repairRequest({ ...a, SPOOL: path.join(dir, "spool") }, "the driver's journal head does not match", new Date(NOW));
  assert.match(fs.readFileSync(f, "utf8"), /journal head/);
});

test("an owner pause only with his own Telegram user id and the message it came from", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-")); const f = path.join(dir, "pauses.json");
  assert.throws(() => setPause(f, { target: "hold", why: "x", telegramUser: "999", messageId: "1" }, ["555"]), /only Michael's own Telegram user id/);
  assert.throws(() => setPause(f, { target: "hold", why: "x", telegramUser: "555" }, ["555"]), /id of the message/);
  setPause(f, { target: "hold", why: "x", telegramUser: "555", messageId: "1" }, ["555"]);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8"))[0].messageId, "1");
  clearPause(f, "hold"); assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), []);
});

test("review fixes: supersession needs a freshly verified install and fails closed without a commit to compare", () => {
  const world = { superseded: [{ id: "old" }], installed: { id: "new", issues: [11], staging: { productCommit: "c0ffee1" } } };
  const jv = { releases: { old: { id: "old", tickets: [{ item: 1, issue: 11 }], slots: { "t:1:resolved": 1 }, commits: { "t:1:merged": "m1" } } } };
  assert.match(supersessionLook(jv, world, () => ({ status: 0 }), "/c", false).bad[0].why, /not freshly verified as running/);
  assert.equal(supersessionLook(jv, world, () => ({ status: 0 }), "", true).leave.length, 0, "no checkout to compare: not contained");
  assert.equal(supersessionLook(jv, { ...world, installed: { ...world.installed, staging: {} } }, () => ({ status: 0 }), "/c", true).leave.length, 0, "no commit: not contained");
  assert.equal(supersessionLook(jv, world, () => ({ status: 0 }), "/c", true).leave.length, 1);
});

test("what is visibly moving is read from GitHub's runs in progress or queued and auto-stage's STOP file", () => {
  const run = (cmd, args) => cmd === "ps" ? { stdout: "  600 node --disable-warning=x /usr/local/lib/godspeed-forge/godspeed-dev/scripts/release/auto-stage.mjs\nnode scripts/release/auto-stage.mjs --dry-run\n" } : ({ stdout: JSON.stringify({ workflow_runs: args[1].includes("in_progress") ? [{ head_branch: "candidate/2.0.0-beta.29", head_sha: "s", run_started_at: "2026-11-21T22:00:00Z", name: "scenarios" }] : [] }) });
  const stopAt = new Date(Date.now() - 20 * 60000).toISOString();
  const a = readActivity({ REPO: "o/r" }, { factories: [{ stop: { writer: "auto-stage", at: stopAt, line: "auto-stage 12 x" } }] }, run);
  assert.equal(a.procs.length, 1, "a live auto-stage counts, a dry run does not"); assert.equal(a.runs.length, 1); assert.equal(a.runs[0].headBranch, "candidate/2.0.0-beta.29"); assert.equal(a.stop.at, stopAt);
  assert.equal(readActivity({ REPO: "o/r" }, { factories: [{ stop: { writer: "someone", at: stopAt, line: "x" } }] }, () => ({ stdout: "garbage" })).stop, null, "only auto-stage's own STOP counts, unreadable runs count for nothing");
});

test("review fix: the required run to re-run is the one of the newest completed check by start time, and only when that one is bad", () => {
  const mk = list => () => ({ stdout: JSON.stringify({ check_runs: list }) });
  const bad = (id, start, comp) => ({ name: "required", status: "completed", conclusion: "failure", started_at: start, completed_at: comp, details_url: `https://github.com/o/r/actions/runs/${id}/job/1` });
  assert.equal(requiredRunId("o/r", "s", mk([bad(1, "2026-11-21T10:00:00Z", "2026-11-21T12:00:00Z"), bad(2, "2026-11-21T11:00:00Z", "2026-11-21T11:30:00Z")])), 2, "the check that started last governs, not the one that finished last");
  assert.equal(requiredRunId("o/r", "s", mk([bad(1, "2026-11-21T10:00:00Z", "2026-11-21T10:30:00Z"), { ...bad(2, "2026-11-21T11:00:00Z", "2026-11-21T11:30:00Z"), conclusion: "success" }])), null, "the newest one passed: nothing to re-run");
});

test("a failed lookup of the heartbeat issue never creates a second one; a lookup that worked and found none creates it", () => {
  const calls = [];
  const failing = (c, a) => { calls.push(a.join(" ")); return { status: 1, stdout: "", stderr: "boom" }; };
  assert.equal(publishHeartbeat({}, { at: "t", journalHead: "h", rung3: [], releases: [] }, failing).ok, false);
  assert.ok(!calls.some(c => /-X POST/.test(c)), "no second heartbeat issue after a failed lookup");
  const empty = (c, a) => { calls.push(a.join(" ")); return { status: 0, stdout: "[]" }; };
  assert.equal(publishHeartbeat({}, { at: "t", journalHead: "h", rung3: [], releases: [] }, empty).ok, true);
  assert.ok(calls.some(c => /-X POST/.test(c)), "found none, the lookup worked: created");
});

test("a closed heartbeat issue is reopened by the driver's update, and the lookup asks for the most recently updated first", () => {
  const BT = String.fromCharCode(96).repeat(3), NL = String.fromCharCode(10);
  const closed = [{ number: 7, state: "closed", user: { login: "MichaelZelbel" }, body: `<!-- factory-heartbeat -->${NL}x${NL}${BT}json${NL}{}${NL}${BT}` }];
  const calls = []; publishHeartbeat({}, { at: "t", journalHead: "h", rung3: [], releases: [] }, (c, a) => { calls.push(a.join(" ")); return { status: 0, stdout: /issues\?state=all/.test(a.join(" ")) ? JSON.stringify(closed) : "" }; });
  assert.ok(calls.some(c => /sort=updated&direction=desc/.test(c)), "newest-updated first: the heartbeat is edited every round, so it is always on the first page");
  assert.ok(calls.some(c => /-X PATCH [\s\S]*issues\/7 [\s\S]*state=open/.test(c)), "reopened with the update");
});

test("three failed scheduled runs of the watcher in a row are a dead watcher; one failure is not", () => {
  const mk = conclusions => (c, a) => { const u = a.join(" "); if (/workflows\/factory-watch.yml\/runs/.test(u)) return { status: 0, stdout: JSON.stringify({ workflow_runs: conclusions.map((x, i) => ({ event: "schedule", status: "completed", conclusion: x, created_at: new Date(NOW - (i + 1) * H).toISOString() })) }) }; if (/workflows\/factory-watch.yml$/.test(u)) return { status: 0, stdout: JSON.stringify({ state: "active", created_at: new Date(NOW - 100 * H).toISOString() }) }; return { status: 0, stdout: "" }; };
  assert.equal(watcherHealth({}, NOW, mk(["failure", "success", "failure"])).ok, true, "one failure among successes");
  assert.equal(watcherHealth({}, NOW, mk(["failure", "failure", "failure"])).ok, false, "three failures in a row");
});
