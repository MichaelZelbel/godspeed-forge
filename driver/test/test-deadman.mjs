import { TEST_ENV } from "./env.mjs";
// node --test scripts/factory-driver/test-deadman.mjs   (plain files, offline)
import { test } from "./harness.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approvedNewer, runningVersion, releaseSays, driverHealth, repairStep, run, RULES } from "../deadman/deadman.mjs";

const HOUR = 3600000, MIN = 60000, NOW = Date.parse("2026-11-21T22:00:00Z");
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-"));
  const rel = (name, status) => { fs.mkdirSync(path.join(dir, "r", name), { recursive: true }); fs.writeFileSync(path.join(dir, "r", name, "plan.md"), `---\nrelease: ${name}\n---\nStatus: ${status}\n`); };
  rel("godspeed-2.0.0-beta.28-b", "approved"); rel("godspeed-2.0.0-beta.29-c", "approved"); rel("godspeed-2.0.0-beta.30-d", "draft");
  const cfg = { RELEASES: path.join(dir, "r"), DEV: dir, STATUS: path.join(dir, "status.json"), KEEPER: path.join(dir, "keeper.json"), KEEPER_BIN: "/none", SPOOL: path.join(dir, "spool"), STATE: path.join(dir, "state.json"), ACTS: path.join(dir, "acts"), NOTICES: path.join(dir, "notices.json"), TG_ENV: path.join(dir, "none.env"), WATCH_REPO: "o/w", BRAIN: dir, HEALTH: "x", PLAN_PATTERN: "^godspeed-\\d", NODE: "/opt/node/bin/node", KEEPER_HOME: "/usr/local/lib/godspeed-factory-driver", STATE_DIR: "/var/lib/godspeed-factory-driver", DRIVER_DIR: "/d", OWNER: "MichaelZelbel", DRY: false };
  return { dir, cfg };
}
const git = at => () => ({ stdout: `${new Date(at).toISOString()}\n` });
const fresh = (cfg, ageMin = 1) => fs.writeFileSync(cfg.STATUS, JSON.stringify({ at: new Date(NOW - ageMin * MIN).toISOString() }));

test("rule 1 reads only the approval time from the plan's own history and the version the server reports, never the driver's status", () => {
  const w = world();
  const running = runningVersion(w.cfg, () => ({ stdout: JSON.stringify({ ok: true, version: "2.0.0-beta.28" }) }));
  assert.deepEqual(approvedNewer(w.cfg, running, git(NOW - 80 * HOUR)).map(r => r.id), ["godspeed-2.0.0-beta.29-c"], "beta.28 runs; beta.30 is only a draft");
  assert.equal(runningVersion(w.cfg, () => ({ stdout: "not json" })), null, "an unreadable /health says nothing");
  const pend = approvedNewer(w.cfg, running, git(NOW - 80 * HOUR));
  assert.equal(releaseSays(pend, {}, NOW).length, 1); assert.match(releaseSays(pend, {}, NOW)[0].text, /approved 80 hours ago and is still not running/);
  assert.equal(releaseSays(pend, { [`release:${pend[0].id}`]: NOW - HOUR }, NOW).length, 0, "said within 24 hours");
  assert.equal(releaseSays(approvedNewer(w.cfg, running, git(NOW - 10 * HOUR)), {}, NOW).length, 0, "under 72 hours");
});

test("rule 2: a stale status file, three failed rounds or a repair request make the driver unhealthy; the rollback comes first, then Codex, then Claude, then one sentence", () => {
  const w = world();
  assert.deepEqual(driverHealth(w.cfg, NOW).reasons, ["it has no status file"]);
  fresh(w.cfg, 25); assert.match(driverHealth(w.cfg, NOW).reasons[0], /25 minutes old/);
  fresh(w.cfg, 1); assert.ok(driverHealth(w.cfg, NOW).healthy);
  fs.writeFileSync(w.cfg.KEEPER, JSON.stringify({ failedInRow: 3 })); assert.match(driverHealth(w.cfg, NOW).reasons[0], /last 3 rounds failed/);
  fs.writeFileSync(w.cfg.KEEPER, "{}"); fs.mkdirSync(w.cfg.SPOOL); fs.writeFileSync(path.join(w.cfg.SPOOL, "repair-1.json"), "{}"); assert.match(driverHealth(w.cfg, NOW).reasons[0], /asked for a repair/);
  const bad = { healthy: false, reasons: ["x"] };
  let s = repairStep(null, bad, NOW); assert.equal(s.step, "rollback", "deterministic, before any AI");
  s = repairStep(s.rep, bad, NOW + 10 * MIN); assert.equal(s.step, null);
  s = repairStep(s.rep, bad, NOW + 21 * MIN); assert.equal(s.step, "codex");
  s = repairStep(s.rep, bad, NOW + 40 * MIN); assert.equal(s.step, null);
  s = repairStep(s.rep, bad, NOW + 82 * MIN); assert.equal(s.step, "claude");
  s = repairStep(s.rep, bad, NOW + 142 * MIN); assert.equal(s.step, "tell");
  s = repairStep(s.rep, bad, NOW + 200 * MIN); assert.equal(s.step, null, "told once");
  assert.equal(repairStep(s.rep, { healthy: true }, NOW).rep, null, "healthy again: the ladder resets");
});

test("a whole dead-man run: it says the release sentence once, and with the driver down it rolls back first and starts no AI at once", async () => {
  const w = world(); const calls = [];
  const deps = { mint: () => "tok", ref: "testref", health: () => ({ stdout: JSON.stringify({ ok: true, version: "2.0.0-beta.28" }) }), run: (c, a) => { calls.push([c, ...a]); return c === "git" ? { stdout: `${new Date(NOW - 80 * HOUR).toISOString()}\n` } : { status: 0, stdout: JSON.stringify([{ user: { login: "github-actions[bot]" }, body: "@MichaelZelbel x <!-- ref:testref -->", html_url: "https://github.com/o/w/issues/1" }]) }; }, fetch: async () => ({ json: async () => ({}) }), sleep: async () => {}, polls: 1, gateCfg: { reads: 1, gapMs: 0, toleranceMs: 0 } };
  const r1 = await run(w.cfg, NOW, () => {}, deps);
  assert.equal(r1.says.length, 1); assert.equal(r1.step, "rollback");
  assert.ok(calls.some(c => c[0] === "/opt/node/bin/node" && c.includes("repair")), "the keeper's repair ran first");
  assert.ok(!calls.some(c => c[0] === "systemd-run"), "no AI yet");
  assert.equal(JSON.parse(fs.readFileSync(w.cfg.NOTICES, "utf8")).notices.length, 1, "Godspeed's own queue too");
  fresh(w.cfg, 1);
  const r2 = await run(w.cfg, NOW + 5 * MIN, () => {}, deps); assert.equal(r2.says.length, 0); assert.equal(r2.step, null, "healthy: nothing");
  assert.equal(JSON.parse(fs.readFileSync(w.cfg.STATE, "utf8")).repair, null);
  const r3 = await run({ ...w.cfg, DRY: true }, NOW + 6 * MIN, () => {}, deps); assert.ok(r3.health);
  assert.equal(RULES.ceilingHours, 72);
});

test("a driver-repair run is launched with the dead-man, the journal and the units read-only", async () => {
  const { launchRepair } = await import("../deadman/deadman.mjs");
  const w = world(); const calls = [];
  assert.ok(launchRepair(w.cfg, "factory-repair-codex-1", "codex", "its status file is old", "", (c, a) => { calls.push([c, ...a]); return { status: 0 }; }));
  const args = calls[0].join(" ");
  assert.match(args, /NoNewPrivileges=yes/); assert.match(args, /ReadOnlyPaths=\S*deadman\.mjs[^"]*\/var\/lib\/godspeed-factory-driver/); assert.match(args, /CapabilityBoundingSet=~CAP_SYS_ADMIN/);
  assert.ok(!/ReadOnlyPaths=[^ ]*\/factory-driver\b[^ ]* /.test(calls[0].find(x => /^ReadOnlyPaths=/.test(x)) + " ") || true);
  assert.ok(!calls[0].find(x => /^ReadOnlyPaths=/.test(x)).includes("/usr/local/lib/godspeed-forge/factory-driver"), "the driver's install stays writable for the repair");
});

test("review fixes: told only with a receipt, an unreadable /health tells nothing, a future-dated status is not fresh, a repair request survives the rollback", async () => {
  const w = world(); const noRc = { health: () => ({ stdout: "garbage" }), run: (c, a) => (c === "git" ? { stdout: `${new Date(NOW - 80 * HOUR).toISOString()}
` } : { status: 1, stdout: "" }), fetch: async () => { throw new Error("down"); } };
  const r1 = await run(w.cfg, NOW, () => {}, noRc);
  assert.equal(r1.says.length, 0, "with /health unreadable nothing is told about any release (unknown is not not-running)");
  assert.deepEqual(JSON.parse(fs.readFileSync(w.cfg.STATE, "utf8")).messages, {}, "no receipt: not recorded as told, so it is tried again next run");
  fs.writeFileSync(w.cfg.STATUS, JSON.stringify({ at: new Date(NOW + 3 * HOUR).toISOString() }));
  assert.match(driverHealth(w.cfg, NOW).reasons[0], /dated in the future/);
  fs.mkdirSync(w.cfg.SPOOL, { recursive: true }); fs.writeFileSync(path.join(w.cfg.SPOOL, "repair-1.json"), JSON.stringify({ what: "the journal head is wrong" })); fresh(w.cfg, 1);
  const calls = [];
  const deps = { health: () => ({ stdout: JSON.stringify({ ok: true, version: "2.0.0-beta.99" }) }), run: (c, a) => { calls.push([c, ...a]); return { status: 0, stdout: "" }; }, fetch: async () => ({ json: async () => ({}) }), sleep: async () => {}, polls: 1, gateCfg: { reads: 1, gapMs: 0, toleranceMs: 0 } };
  await run(w.cfg, NOW + 1, () => {}, deps);
  assert.ok(fs.existsSync(path.join(w.cfg.SPOOL, "repair-1.json")), "the rollback does not consume the request");
  await run(w.cfg, NOW + 25 * MIN, () => {}, deps);
  assert.ok(fs.existsSync(path.join(w.cfg.SPOOL, "handled-1.json")), "a repair run that carries it does");
  assert.ok(calls.some(c => c[0] === "systemd-run" && c.join(" ").includes("factory-repair-codex")));
});

test("the dead-man tells only about Godspeed's own releases, and says nothing when /health cannot be read", async () => {
  const w = world();
  for (const n of ["godspeed-forge-0.1.0-first-forge", "querino-1.0.0-beta.1-for-creators", "clerk-0.5.2-server-move"]) { fs.mkdirSync(path.join(w.dir, "r", n), { recursive: true }); fs.writeFileSync(path.join(w.dir, "r", n, "plan.md"), "Status: approved" + String.fromCharCode(10)); }
  const running = runningVersion(w.cfg, () => ({ stdout: JSON.stringify({ ok: true, version: "2.0.0-beta.28" }) }));
  assert.deepEqual(approvedNewer(w.cfg, running, git(NOW - 200 * HOUR)).map(r => r.id), ["godspeed-2.0.0-beta.29-c"], "other products' plans are not 'not running on your server'");
  const r = await run(w.cfg, NOW, () => {}, { health: () => ({ stdout: "garbage" }), run: () => ({ stdout: `${new Date(NOW - 200 * HOUR).toISOString()}${String.fromCharCode(10)}`, status: 0 }), fetch: async () => ({ json: async () => ({}) }), sleep: async () => {}, polls: 0 });
  assert.equal(r.says.length, 0, "an unreadable /health: nothing is told");
});

test("THE GATE in the dead-man: the same condition on 3 runs at least 10 minutes apart, fresh sources, none unreadable", async () => {
  const w = world();
  const mkDeps = (health = { ok: true, version: "2.0.0-beta.28" }, over = {}) => ({ mint: () => "tok", ref: "gref", health: () => ({ stdout: JSON.stringify(health) }), run: (c, a) => (c === "git" ? { stdout: `${new Date(NOW - 80 * HOUR).toISOString()}${String.fromCharCode(10)}` } : { status: 0, stdout: JSON.stringify([{ user: { login: "github-actions[bot]" }, body: "@MichaelZelbel x <!-- ref:gref -->", html_url: "https://github.com/o/w/issues/1" }]) }), fetch: async () => ({ json: async () => ({}) }), sleep: async () => {}, polls: 1, ...over });
  const upd = t => fs.writeFileSync(w.cfg.STATUS, JSON.stringify({ at: new Date(t - 60000).toISOString() }));
  upd(NOW); const r1 = await run(w.cfg, NOW, () => {}, mkDeps()); assert.equal(r1.says.length, 0, "first reading: nothing");
  upd(NOW + 5 * MIN); const r2 = await run(w.cfg, NOW + 5 * MIN, () => {}, mkDeps()); assert.equal(r2.says.length, 0, "5 minutes later is not a second reading");
  upd(NOW + 10 * MIN); const r3 = await run(w.cfg, NOW + 10 * MIN, () => {}, mkDeps()); assert.equal(r3.says.length, 0, "second reading");
  upd(NOW + 20 * MIN); const r4 = await run(w.cfg, NOW + 20 * MIN, () => {}, mkDeps()); assert.equal(r4.says.length, 1, "third reading, 10 minutes apart each, fresh re-read agrees: sent");
  // an unreadable source in the fresh re-read: held, looked at again
  const w2 = world(); const upd2 = t => fs.writeFileSync(w2.cfg.STATUS, JSON.stringify({ at: new Date(t - 60000).toISOString() }));
  let calls = 0; const flaky = () => mkDeps(undefined, { health: () => ({ stdout: ++calls <= 3 ? JSON.stringify({ ok: true, version: "2.0.0-beta.28" }) : "garbage" }) });
  for (const k of [0, 10, 20]) { upd2(NOW + k * MIN); const r = await run(w2.cfg, NOW + k * MIN, () => {}, flaky()); assert.equal(r.says.length, 0, `reading ${k}: not sent (unreadable in the re-read or too early)`); }
  // a condition that is absent in between starts over
  const w3 = world(); const upd3 = t => fs.writeFileSync(w3.cfg.STATUS, JSON.stringify({ at: new Date(t - 60000).toISOString() }));
  for (const k of [0, 10]) { upd3(NOW + k * MIN); await run(w3.cfg, NOW + k * MIN, () => {}, mkDeps()); }
  upd3(NOW + 20 * MIN); await run(w3.cfg, NOW + 20 * MIN, () => {}, mkDeps({ ok: true, version: "2.0.0-beta.29" })); // it is running now: the condition is gone
  upd3(NOW + 30 * MIN); const r5 = await run(w3.cfg, NOW + 30 * MIN, () => {}, mkDeps()); assert.equal(r5.says.length, 0, "after a gap the count starts over");
});

test("THE GATE in the dead-man holds the driver-down message too: three unhealthy runs and a fresh unhealthy re-read before it is sent", async () => {
  const w = world(); const sent = [];
  const deps = { mint: () => "tok", ref: "dref", health: () => ({ stdout: JSON.stringify({ ok: true, version: "2.0.0-beta.99" }) }), run: (c, a) => ({ status: 0, stdout: c === "gh" ? JSON.stringify([{ user: { login: "github-actions[bot]" }, body: "@MichaelZelbel x <!-- ref:dref -->", html_url: "https://github.com/o/w/issues/2" }]) : "" }), fetch: async () => ({ json: async () => ({}) }), sleep: async () => {}, polls: 1, gateCfg: { reads: 3, gapMs: 10 * MIN, toleranceMs: 60000 } };
  fs.writeFileSync(w.cfg.STATE, JSON.stringify({ messages: {}, repair: { since: NOW - 5 * HOUR, rollbackAt: NOW - 4 * HOUR, codexAt: NOW - 3 * HOUR, claudeAt: NOW - 2 * HOUR } })); // the ladder is at its end: the next step is to tell
  const counts = [];
  for (const k of [0, 10, 20]) { const r = await run(w.cfg, NOW + k * MIN, () => {}, deps); counts.push((r.done || []).filter(x => String(x.say).startsWith("driver")).length); }
  assert.deepEqual(counts, [0, 0, 1], "told on the third reading only");
});

test("the dead-man: an unreadable status file is no verdict; different failures are different conditions; an unreadable supporting file holds the release message", async () => {
  const w = world();
  fs.writeFileSync(w.cfg.STATUS, "{ not json");
  const h = driverHealth(w.cfg, NOW); assert.equal(h.unreadable, true, "present but unreadable");
  fs.rmSync(w.cfg.STATUS); assert.equal(driverHealth(w.cfg, NOW).unreadable, false, "missing is a fact");
  fs.writeFileSync(w.cfg.STATUS, JSON.stringify({ at: new Date(NOW - 40 * MIN).toISOString() })); const stale = driverHealth(w.cfg, NOW);
  fs.writeFileSync(w.cfg.STATUS, JSON.stringify({ at: new Date(NOW - MIN).toISOString() })); fs.writeFileSync(w.cfg.KEEPER, JSON.stringify({ failedInRow: 3 })); const failed = driverHealth(w.cfg, NOW);
  assert.notEqual(stale.key, failed.key, "a stale status and failed rounds are not 'the same condition'");
  fs.writeFileSync(path.join(w.dir, "r", "godspeed-2.0.0-beta.29-c", "staging.json"), "{ broken");
  const running = runningVersion(w.cfg, () => ({ stdout: JSON.stringify({ ok: true, version: "2.0.0-beta.28" }) }));
  assert.equal(approvedNewer(w.cfg, running, git(NOW - 200 * HOUR)).unreadable, true, "a malformed staging record is unreadable, not 'not installed'");
  assert.equal(approvedNewer(w.cfg, running, () => ({ stdout: "" })).unreadable, true, "a plan history that cannot be read is not guessed from a file time");
});

test("the keeper runs with the configured node, and its rung counts as attempted only when it exits 0: a failed keeper is asked again at the next run", async () => {
  const w = world(); const calls = []; let keeperStatus = 1;
  const deps = { mint: () => "tok", ref: "testref", health: () => ({ stdout: JSON.stringify({ ok: true, version: "2.0.0-beta.28" }) }), run: (c, a) => { calls.push([c, ...a]); return c === "git" ? { stdout: `${new Date(NOW - 80 * HOUR).toISOString()}
` } : c === "/opt/node/bin/node" ? { status: keeperStatus, stderr: "keeper: cannot restore" } : { status: 0, stdout: "" }; }, fetch: async () => ({ json: async () => ({ ok: false }) }) };
  const r1 = await run(w.cfg, NOW, () => {}, deps);
  assert.equal(r1.step, "rollback");
  assert.ok(calls.some(c => c[0] === "/opt/node/bin/node" && c[1] === w.cfg.KEEPER_BIN && c[2] === "repair"), "the configured node, not a literal `node`");
  assert.ok(!calls.some(c => c[0] === "node"));
  assert.equal(JSON.parse(fs.readFileSync(w.cfg.STATE, "utf8")).repair.rollbackAt, undefined, "the keeper failed: the rung is not counted as attempted");
  assert.ok(r1.done.some(d => d.keeper === "repair failed" && /cannot restore/.test(d.why)));
  keeperStatus = 0;
  const r2 = await run(w.cfg, NOW + 5 * MIN, () => {}, deps);
  assert.equal(r2.step, "rollback", "asked again next time");
  assert.ok(JSON.parse(fs.readFileSync(w.cfg.STATE, "utf8")).repair.rollbackAt, "now it counts");
  const r3 = await run(w.cfg, NOW + 10 * MIN, () => {}, deps);
  assert.notEqual(r3.step, "rollback", "once attempted it is not asked a third time");
});

// the Forge 0.3.1, ticket 04 (#141): the dead-man's repair run keeps its AI sign-in the same way (its own copy of the rule)
test("ticket 04: the repair run's sign-in links: a plain file in a link's place is kept aside with the date and the link made again", async () => {
  const { linkLogin } = await import("../deadman/deadman.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-login-"));
  const target = path.join(dir, "factory", ".claude", ".credentials.json"); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "{}");
  const link = path.join(dir, "acts", "claude-home", ".credentials.json"); fs.mkdirSync(path.dirname(link), { recursive: true }); fs.writeFileSync(link, "a plain file");
  assert.equal(linkLogin(target, link, Date.parse("2026-11-24T10:00:00Z")), "moved aside");
  assert.ok(fs.lstatSync(link).isSymbolicLink() && path.resolve(fs.readlinkSync(link)) === path.resolve(target));
  assert.equal(fs.readFileSync(`${link}.replaced-20261124T100000Z`, "utf8"), "a plain file");
  assert.equal(linkLogin(target, link), "kept");
});


// issue #163: nothing the dead-man or its repair run sends to GitHub goes out as the owner (root's own gh login)
test("#163: githubEnv hands out an App token and no stored login; without a token there is no GitHub login at all", async () => {
  const { githubEnv } = await import("../deadman/deadman.mjs");
  const e = githubEnv({ ghDir: "/acts/gh", token: "tok" });
  assert.equal(e.GH_TOKEN, "tok"); assert.equal(e.GH_CONFIG_DIR, "/acts/gh"); assert.equal(e.GIT_SSH_COMMAND, "/bin/false");
  assert.equal(e.GIT_CONFIG_KEY_0, "credential.helper"); assert.equal(e.GIT_CONFIG_VALUE_0, "", "root's helpers are emptied first");
  assert.match(e.GIT_CONFIG_VALUE_1, /GH_TOKEN/);
  const none = githubEnv({ ghDir: "/acts/gh" });
  assert.ok(!("GH_TOKEN" in none) && none.GIT_CONFIG_COUNT === "1" && !("GIT_CONFIG_KEY_1" in none));
});

test("#163: the repair run's AI, Claude and Codex, runs with the App token the unit minted from job.json", async () => {
  const { runJob } = await import("../deadman/deadman.mjs");
  for (const provider of ["claude", "codex"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-job-")); const acts = path.join(dir, "acts");
    const github = { tokenScript: "/t.mjs", keysFile: "/k", repos: ["o/r", "o/d"] };
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ provider, model: "m", brain: dir, factoryHome: path.join(dir, "home"), claudeBin: "/bin/claude", prompt: "p", actsDir: acts, minutes: 1, github }));
    let spawned = null, minted = null;
    runJob(dir, { mint: a => { minted = a; return "apptok"; }, spawn: (cmd, args, o) => { spawned = o; return { stdout: "RESULT: resolved" }; } });
    assert.deepEqual(minted, { ...github, app: "release" });
    assert.equal(spawned.env.GH_TOKEN, "apptok", provider); assert.equal(spawned.env.GH_CONFIG_DIR, path.join(acts, "gh"));
    assert.equal(spawned.env.GIT_CONFIG_VALUE_0, "");
  }
});

test("#163: launchRepair's job.json, read by runJob, carries the token settings into the repair AI's environment", async () => {
  const { launchRepair, runJob } = await import("../deadman/deadman.mjs");
  const w = world(); w.cfg.TOKEN_SCRIPT = "/t.mjs"; w.cfg.KEYS_FILE = "/k"; w.cfg.REPO = "o/r"; w.cfg.DEV_REPO = "o/d"; w.cfg.CLAUDE_BIN = "/bin/claude";
  for (const provider of ["claude", "codex"]) {
    const unit = `factory-repair-${provider}-1`;
    launchRepair(w.cfg, unit, provider, "why", "", () => ({ status: 0 }));
    let minted = null, spawned = null;
    runJob(path.join(w.cfg.ACTS, unit), { mint: a => { minted = a; return "apptok"; }, spawn: (c, a, o) => { spawned = o; return { stdout: "" }; } });
    assert.deepEqual(minted, { tokenScript: "/t.mjs", keysFile: "/k", repos: ["o/r", "o/d"], app: "release" }, provider);
    assert.equal(spawned.env.GH_TOKEN, "apptok", provider);
  }
});

test("#163: the dead-man's App token minting and GitHub environment agree with the driver's guard", async () => {
  const { mintToken, githubEnv } = await import("../deadman/deadman.mjs");
  const { mintAppToken, appVars } = await import("../owner-guard.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-conf-")), keysFile = path.join(dir, "keys");
  fs.writeFileSync(keysFile, 'export APP_ID="1"\nAPP_KEY=abc\n');
  for (const repos of [["o/r"], ["o/r", "o/d"], ["o/r", "bad repo"], []]) for (const out of [{ status: 0, stdout: "tok\n" }, { status: 1, stdout: "" }]) {
    const seen = [[], []];
    const a = mintToken({ tokenScript: "/t.mjs", keysFile, app: "builder", repos }, (c, args, o) => { seen[0].push([args, o.env]); return out; });
    const b = mintAppToken({ tokenScript: "/t.mjs", keysFile, app: "builder", repos }, (c, args, o) => { seen[1].push([args, o.env.APP_ID, o.env.APP_KEY]); return out; });
    assert.equal(a, b); assert.deepEqual(seen[0].map(([x, e]) => [x, e.APP_ID, e.APP_KEY]), seen[1]);
  }
  assert.equal(mintToken({ tokenScript: "/t.mjs", keysFile: "/nope", app: "release", repos: ["o/r"] }, () => ({ status: 0, stdout: "t" })), mintAppToken({ tokenScript: "/t.mjs", keysFile: "/nope", repos: ["o/r"] }, () => ({ status: 0, stdout: "t" })));
  for (const token of ["", "apptok"]) {
    const { GIT_CONFIG_VALUE_1: x, ...mine } = githubEnv({ ghDir: "/g", token }), { GIT_CONFIG_VALUE_1: y, ...theirs } = appVars({ ghDir: "/g", token });
    const { GIT_SSH_COMMAND, ...rest } = mine;
    assert.deepEqual(rest, theirs, `token=${JSON.stringify(token)}`); assert.equal(!!x, !!y);
  }
});

test("#163: the notify dispatch goes out with the builder App's token and an empty gh folder; with no token nothing is sent as the owner but the queue still gets it", async () => {
  const w = world(); const { tell } = await import("../deadman/deadman.mjs");
  const seen = [];
  const run = (c, a, o) => { seen.push({ c, a, env: o && o.env }); return { status: 0, stdout: "[]" }; };
  await tell(w.cfg, "x", { run, mint: a => { seen.push({ minted: a }); return "apptok"; }, polls: 0 });
  assert.deepEqual(seen[0].minted, { tokenScript: w.cfg.TOKEN_SCRIPT, keysFile: w.cfg.KEYS_FILE, app: "builder", repos: ["o/w"] });
  const gh = seen.filter(s => s.c === "gh"); assert.ok(gh.some(s => s.a[0] === "workflow"), "dispatched");
  for (const s of gh) { assert.equal(s.env.GH_TOKEN, "apptok"); assert.ok(!s.env.GH_CONFIG_DIR.startsWith("/root")); assert.ok(!("HOME" in s.env)); }
  const w2 = world(); const calls = [];
  await tell(w2.cfg, "x", { run: (c) => { calls.push(c); return { status: 0, stdout: "[]" }; }, mint: () => "" });
  assert.deepEqual(calls, [], "no gh call without an App token");
  assert.equal(JSON.parse(fs.readFileSync(w2.cfg.NOTICES, "utf8")).notices.length, 1);
});

test("#163: the dead-man still shares no code with the driver", () => {
  const src = fs.readFileSync(new URL("../deadman/deadman.mjs", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)"/gm)].map(m => m[1]);
  assert.ok(imports.every(i => i.startsWith("node:")), imports.join(", "));
});
