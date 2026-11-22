// node --test scripts/factory-driver/test-housekeeping.mjs   (offline: every command goes to a stand-in)
import { test } from "node:test";
import assert from "node:assert/strict";
import { housekeep, ALLOWED_RESTART } from "../housekeeping.mjs";

const NOW = Date.parse("2026-11-18T15:00:00Z");
const STANDIN = "/home/godspeed-forge/.archon/workspaces/x/standin_ai.py --scenario H-39";
// A stand-in for the server: `ps` answers from a table, everything else succeeds and is recorded.
function server(procs = {}) {
  const calls = [];
  const deps = {
    sleep: async () => {}, now: () => NOW,
    run: argv => {
      calls.push(argv);
      if (argv[0] === "ps") { const p = procs[argv[argv.length - 1]]; return p ? { status: 0, stdout: `${p.uid} ${p.etimes} ${p.cmd}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "" }; }
      if (argv[0] === "kill" && argv[1] === "-TERM") delete procs[argv[2]];
      return { status: 0, stdout: "Total reclaimed space: 1.2GB\n", stderr: "" };
    },
  };
  return { calls, deps };
}
const world = server => ({ server: { failedUnits: [], diskPct: 50, memAvailPct: 60, staleProcs: [], logins: { gh: true }, ...server } });
const kills = calls => calls.filter(c => c[0] === "kill").map(c => `${c[1]} ${c[2]}`);
const flat = calls => calls.map(c => c.join(" "));

test("a stale process is stopped only after it was read again and is still the same one", async () => {
  const s = server({ 4242: { uid: 1001, etimes: 4 * 3600, cmd: STANDIN } });
  const r = await housekeep({}, world({ staleProcs: [{ pid: 4242, user: "godspeed-forge", ageMin: 240, cmd: STANDIN }] }), s.deps);
  assert.deepEqual(kills(s.calls), ["-TERM 4242"]);
  assert.match(r.done[0], /^stopped stale process 4242/);
  // it survives TERM: KILL, still only after reading it again
  const s2 = server({ 77: { uid: 1001, etimes: 4 * 3600, cmd: STANDIN } });
  s2.deps.run = (orig => argv => (argv[0] === "kill" && argv[1] === "-TERM" ? (s2.calls.push(argv), { status: 0, stdout: "", stderr: "" }) : orig(argv)))(s2.deps.run);
  await housekeep({}, world({ staleProcs: [{ pid: 77, user: "godspeed-forge", ageMin: 240, cmd: STANDIN }] }), s2.deps);
  assert.deepEqual(kills(s2.calls), ["-TERM 77", "-KILL 77"]);
});

test("housekeeping never kills a process whose command changed, whose owner changed, or that is young", async () => {
  // the pid now belongs to another program (the stale one ended and the number was reused)
  const s = server({ 4242: { uid: 1001, etimes: 4 * 3600, cmd: "node /home/godspeed-forge/archon-web/server.js" }, 51: { uid: 0, etimes: 4 * 3600, cmd: STANDIN }, 52: { uid: 1001, etimes: 600, cmd: STANDIN } });
  const r = await housekeep({}, world({ staleProcs: [
    { pid: 4242, user: "godspeed-forge", ageMin: 240, cmd: STANDIN },
    { pid: 51, user: "root", ageMin: 240, cmd: STANDIN },
    { pid: 52, user: "godspeed-forge", ageMin: 240, cmd: STANDIN },
    { pid: 1, user: "root", ageMin: 9999, cmd: "/sbin/init" },
  ] }), s.deps);
  assert.deepEqual(kills(s.calls), []);
  assert.equal(r.failed.length, 4);
  assert.match(r.failed[0], /process 4242 not stopped: it is no longer the stale/);
  // gone already: nothing to do
  const s2 = server({});
  const r2 = await housekeep({}, world({ staleProcs: [{ pid: 999, user: "godspeed-forge", ageMin: 240, cmd: STANDIN }] }), s2.deps);
  assert.deepEqual(kills(s2.calls), []);
  assert.match(r2.done[0], /had already ended/);
});

test("housekeeping never restarts a unit outside the allowlist, and restarts every allowlisted one and the factory user's own", async () => {
  const s = server();
  const r = await housekeep({}, world({ failedUnits: ["nginx.service", "godspeed-clerk.service", "godspeed-https.service", "ssh.service", ...ALLOWED_RESTART,
    "archonfactory-godspeed-mission-control.service", "user:docker.service", "factory-helper-ab12cd34ef-2.service", "rm -rf /;.service"] }), s.deps);
  const restarts = flat(s.calls).filter(c => / restart /.test(c));
  assert.deepEqual(restarts.filter(c => c.startsWith("systemctl restart")).map(c => c.split(" ")[2]), ALLOWED_RESTART);
  const user = s.calls.filter(c => c.includes("--user"));
  assert.deepEqual(user.map(c => c.at(-1)), ["archonfactory-godspeed-mission-control.service", "docker.service"]);
  assert.deepEqual(user[0].slice(0, 8), ["ip", "netns", "exec", "godspeed-forge", "runuser", "-u", "godspeed-forge", "--"], "as the factory user, inside its namespace");
  for (const n of ["nginx.service", "godspeed-clerk.service", "godspeed-https.service", "ssh.service"]) {
    assert.ok(!flat(s.calls).some(c => c.includes(n)), n);
    assert.ok(r.failed.some(f => f.startsWith(`${n} failed and is not on the restart list`)), n);
  }
  assert.ok(r.failed.some(f => /not a unit name/.test(f)));
  assert.ok(restarts.filter(c => c.startsWith("systemctl restart")).every(c => c.endsWith(" --no-block")), "a restart never waits for the unit's run (seen live: the test machine's run held a round)");
});

test("a failed unit with a timer of its own is left to that timer (active or stopped on purpose), never restarted every round", async () => {
  // seen live on 2026-11-18: a session stopped the test machine at 16:19 and the round started it again
  const calls = [];
  const run = argv => { calls.push(argv.join(" ")); return argv[1] === "show" ? { status: 0, stdout: argv.at(-1) === "test-machine.timer" ? "loaded\n" : "not-found\n", stderr: "" } : { status: 0, stdout: "", stderr: "" }; };
  const r = await housekeep({}, world({ failedUnits: ["test-machine.service", "godspeed-forge-web.service"] }), { run, sleep: async () => {} });
  assert.ok(!calls.some(c => /restart test-machine/.test(c)));
  assert.ok(calls.includes("systemctl restart godspeed-forge-web.service --no-block"));
  assert.ok(r.failed.some(f => /^test-machine\.service failed; it has a timer of its own/.test(f)), "said, so the ladder sends the ops helper next");
});

test("housekeeping never touches root's notebook or Hermes, whatever the world says", async () => {
  const s = server({ 600: { uid: 0, etimes: 9 * 3600, cmd: "node /root/godspeed/notebook/main.mjs --port 47831" }, 601: { uid: 1001, etimes: 9 * 3600, cmd: "python3 /root/.hermes/hermes/main.mjs" } });
  const r = await housekeep({}, world({
    failedUnits: ["godspeed-integrated-notebook.service", "hermes-gateway.service", { name: "hermes-gateway.service", user: true }, "user:archonfactory-hermes.service"],
    staleProcs: [{ pid: 600, user: "root", ageMin: 540, cmd: "node /root/godspeed/notebook/main.mjs --port 47831" }, { pid: 601, user: "godspeed-forge", ageMin: 540, cmd: "python3 /root/.hermes/hermes/main.mjs" }],
    logins: { gh: false }, diskPct: 95, memAvailPct: 5,
  }), { ...s.deps, readFile: () => "{\"source\": \"/home/godspeed-forge/.cache/factory/archon/1cfb8fc\"}", writeFile: () => {} });
  for (const c of flat(s.calls)) {
    assert.ok(!/godspeed-integrated-notebook|hermes|\/root\/godspeed|\/root\/\.hermes|4783[1-3]/.test(c), c);
  }
  assert.deepEqual(kills(s.calls), []);
  assert.ok(r.failed.some(f => /godspeed-integrated-notebook\.service is Michael's live Godspeed/.test(f)));
  assert.ok(r.failed.some(f => /hermes-gateway\.service is Michael's live Godspeed/.test(f)));
  // even a direct order reaches no such command: the runner refuses it
  assert.ok(!s.calls.some(c => c.includes("hermes-gateway.service")));
});

test("a failed GitHub login runs the factory's own login unit", async () => {
  const s = server();
  const r = await housekeep({}, world({ logins: { gh: false, codex: "Logged in using ChatGPT", claude: "ok" } }), s.deps);
  assert.deepEqual(flat(s.calls), ["systemctl start godspeed-forge-login.service"]);
  assert.match(r.done[0], /renewed the factory's GitHub login/);
});

test("over 85 % disk: Archon's own worktree cleanup (a day idle) and the factory user's rootless Docker prune; under it, nothing", async () => {
  const s = server();
  const r = await housekeep({}, world({ diskPct: 88 }), { ...s.deps, readFile: () => "{\"source\": \"/home/godspeed-forge/.cache/factory/archon/1cfb8fc\"}" });
  const c = s.calls.map(a => a.join(" "));
  assert.equal(c.length, 2);
  assert.match(c[0], /^ip netns exec godspeed-forge runuser -u godspeed-forge -- env -i HOME=\/home\/godspeed-forge .* bun \/home\/godspeed-forge\/\.cache\/factory\/archon\/1cfb8fc\/packages\/cli\/src\/cli\.ts isolation cleanup 1$/);
  assert.match(c[1], /^ip netns exec godspeed-forge runuser -u godspeed-forge -- env -i .*DOCKER_HOST=unix:\/\/\/run\/user\/1001\/docker\.sock docker system prune -f$/);
  assert.equal(r.done.length, 2);
  const s2 = server();
  await housekeep({}, world({ diskPct: 85 }), s2.deps);
  assert.deepEqual(s2.calls, []);
});

test("MAX_LAPS is left alone unless switched on: nothing reads it (2026-11-18 ruling, memory goes to the ops helper)", async () => {
  const file = { text: "MAX_LAPS=4\n" };
  const s = server();
  const r = await housekeep({}, world({ memAvailPct: 3 }), { ...s.deps, readFile: () => file.text, writeFile: () => { throw new Error("must not write"); } });
  assert.equal(file.text, "MAX_LAPS=4\n");
  assert.deepEqual(r.done, []);
  assert.deepEqual(r.failed, [], "not even tried");
});

test("switched on (LOWER_LAPS): under 15 % memory MAX_LAPS goes down one and the rest of .factory-env stays; plentiful memory puts it back", async () => {
  const file = { text: "# Read by the factory timers.\nDOCKER_HOST=unix:///run/user/1001/docker.sock\n" };
  const io = { readFile: () => file.text, writeFile: (f, t) => { assert.equal(f, "/home/godspeed-forge/.factory-env"); file.text = t; } };
  const housekeepOn = (env, w, d) => housekeep({ LOWER_LAPS: true, ...env }, w, d);
  const s = server();
  let r = await housekeepOn({}, world({ memAvailPct: 9 }), { ...s.deps, ...io });
  assert.match(r.done[0], /MAX_LAPS 4 -> 3/);
  assert.ok(file.text.startsWith("# Read by the factory timers.\nDOCKER_HOST=unix:///run/user/1001/docker.sock\nMAX_LAPS=3\n"));
  r = await housekeepOn({}, world({ memAvailPct: 9 }), { ...s.deps, ...io });
  assert.match(file.text, /^MAX_LAPS=2$/m);
  assert.equal((file.text.match(/lowered from/g) || []).length, 1, "the first value is remembered once");
  r = await housekeepOn({}, world({ memAvailPct: 25 }), { ...s.deps, ...io }); // between: left as it is
  assert.match(file.text, /^MAX_LAPS=2$/m);
  r = await housekeepOn({}, world({ memAvailPct: 55 }), { ...s.deps, ...io });
  assert.equal(file.text, "# Read by the factory timers.\nDOCKER_HOST=unix:///run/user/1001/docker.sock\n");
  assert.match(r.done[0], /back to unset/);
  // never below one lap
  file.text = "MAX_LAPS=1\n";
  r = await housekeepOn({}, world({ memAvailPct: 3 }), { ...s.deps, ...io });
  assert.equal(file.text, "MAX_LAPS=1\n");
});

// ---------------------------------------------------------------- the factory's STOP file (2026-11-18 ruling)
const STOPFILE = "/home/godspeed-forge/godspeed-mission-control/.factory/STOP";
const LINE = "auto-stage 1424860 2026-11-18T13:47:26.709Z";
const stopWorld = (o = {}) => ({ server: { failedUnits: [], staleProcs: [], logins: { gh: true } },
  factories: [{ project: "godspeed-mission-control", stop: { file: STOPFILE, kind: "STOP", line: LINE, writer: "auto-stage", pid: 1424860, at: "2026-11-18T13:47:26.709Z", writerAlive: false, scenariosRunning: false, ...o } }] });

test("a STOP whose writer ended while no scenarios run is removed, after reading it and the process again", async () => {
  const s = server();
  const removed = [];
  const r = await housekeep({}, stopWorld(), { ...s.deps, now: () => Date.parse("2026-11-18T16:00:00Z"), readFile: f => { assert.equal(f, STOPFILE); return `${LINE}\nThe release step pauses the factory.\n`; }, remove: f => removed.push(f) });
  assert.deepEqual(removed, [STOPFILE]);
  assert.match(r.done[0], /removed .*STOP.*auto-stage 1424860/);
  assert.ok(s.calls.some(c => c[0] === "ps" && c.includes("1424860")), "the writer was looked for again");
});

test("a STOP is never removed while its writer lives, while scenarios run or are unknown, without a process, or once it changed", async () => {
  const cases = [
    [{ writerAlive: true }, {}],
    [{ scenariosRunning: true }, {}],
    [{ scenariosRunning: null }, {}],
    [{ pid: null }, {}],
    [{}, { text: "auto-stage 99 2026-11-18T15:00:00Z\n" }],
    [{}, { psAlive: true }],
  ];
  for (const [o, { text, psAlive }] of cases) {
    const s = server(psAlive ? { 1424860: { uid: 0, etimes: 60, cmd: "/usr/local/bin/node /usr/local/lib/godspeed-forge/godspeed-dev/scripts/release/auto-stage.mjs" } } : {});
    const removed = [];
    await housekeep({}, stopWorld(o), { ...s.deps, readFile: () => text || `${LINE}\nx\n`, remove: f => removed.push(f) });
    assert.deepEqual(removed, [], JSON.stringify(o) + (text || "") + (psAlive || ""));
  }
});

test("a stopped factory timer the round names is started again as the factory user, in its namespace; nothing else is started", async () => {
  const s = server();
  const r = await housekeep({}, { server: { failedUnits: [], staleProcs: [], logins: { gh: true } }, timersToStart: ["archonfactory-querino.timer", "evil.timer", "archonfactory-x.service"] }, s.deps);
  const starts = flat(s.calls).filter(c => / start /.test(c));
  assert.equal(starts.length, 1);
  assert.match(starts[0], /^ip netns exec godspeed-forge runuser -u godspeed-forge -- env -i .*XDG_RUNTIME_DIR=\/run\/user\/1001 systemctl --user start archonfactory-querino\.timer$/);
  assert.match(r.done[0], /started archonfactory-querino\.timer again/);
  assert.equal(r.failed.length, 2);
});

test("failed one-off units (systemd-run's generated names) are reset, never restarted, and a bad name is refused", async () => {
  const s = server();
  const r = await housekeep({}, world({ anonymousFailedUnits: ["run-u123.service", "run-u20610.scope", "run-x;rm.service", "archon-loop.service"] }), s.deps);
  const f = flat(s.calls);
  assert.ok(f.includes("systemctl reset-failed run-u123.service"));
  assert.ok(f.includes("systemctl reset-failed run-u20610.scope"));
  assert.ok(!f.some(c => /rm|archon-loop/.test(c)));
  assert.ok(!f.some(c => /restart/.test(c)));
  assert.equal(r.done.filter(d => /reset the failed state/.test(d)).length, 2);
  assert.equal(r.failed.length, 2); // the two bad names are refused, not run
});

test("a PAUSE file is never removed by any program, whoever wrote it, however many rounds pass (the operator's consumer.py ends a second after writing)", async () => {
  const PAUSEFILE = "/home/godspeed-forge/godspeed-mission-control/.factory/PAUSE";
  const w = () => ({ server: { failedUnits: [], staleProcs: [], logins: { gh: true } }, factories: [{ project: "godspeed-mission-control", stop: { file: PAUSEFILE, kind: "PAUSE", line: "consumer.py 4242 2026-11-21T23:33:00Z", writer: "consumer.py", pid: 4242, at: "2026-11-21T23:33:00Z", writerAlive: false, scenariosRunning: false } }] });
  for (const writer of ["consumer.py", "auto-stage", "freeze"]) {
    const removed = [];
    for (let round = 0; round < 3; round++) {
      const s = server();
      const world = w(); world.factories[0].stop.writer = writer;
      await housekeep({}, world, { ...s.deps, now: () => Date.parse("2026-11-22T10:00:00Z"), readFile: () => "consumer.py 4242 2026-11-21T23:33:00Z" + String.fromCharCode(10) + "Operator paused scheduled launches; wakes continue.", remove: f => removed.push(f) });
    }
    assert.deepEqual(removed, [], `${writer}: still there after 3 rounds`);
  }
});

test("a STOP is removed only when a release program wrote it, it has ended, and only after that program's own maximum of 2 hours; an operator's STOP is never removed", async () => {
  const run = async (o, nowIso) => { const removed = []; const s = server(); await housekeep({}, stopWorld(o), { ...s.deps, now: () => Date.parse(nowIso), readFile: () => `${LINE}`, remove: f => removed.push(f) }); return removed; };
  assert.deepEqual(await run({}, "2026-11-18T14:30:00Z"), [], "writer ended 43 minutes ago: not yet");
  assert.deepEqual(await run({}, "2026-11-18T16:00:00Z"), [STOPFILE], "past 2 hours: the forgotten STOP goes");
  assert.deepEqual(await run({ writer: "operator" }, "2026-11-20T00:00:00Z"), [], "a person's STOP stays");
});

test("a STOP that a PAUSE file points at stays; both files are read so a PAUSE is never hidden by a STOP; a STOP past twice its maximum goes though scenarios run", async () => {
  const removed = [];
  const s1 = server();
  await housekeep({}, stopWorld(), { ...s1.deps, now: () => Date.parse("2026-11-18T20:00:00Z"), readFile: () => LINE, remove: f => removed.push(f), realpath: p => "/x/STOP", lstat: () => ({ isSymbolicLink: () => false }) });
  assert.deepEqual(removed, [], "PAUSE resolves to the same file as STOP: it is the operator's pause, the STOP stays");
  const s2 = server();
  await housekeep({}, stopWorld({ scenariosRunning: true }), { ...s2.deps, now: () => Date.parse("2026-11-18T20:00:00Z"), readFile: () => LINE, remove: f => removed.push(f), realpath: p => { throw new Error("no PAUSE"); }, lstat: () => ({ isSymbolicLink: () => false }) });
  assert.deepEqual(removed, [STOPFILE], "6 hours old, writer ended, scenarios still 'running': it goes (past twice the maximum)");
  const s3 = server(); const r3 = [];
  await housekeep({}, stopWorld({ scenariosRunning: true }), { ...s3.deps, now: () => Date.parse("2026-11-18T16:00:00Z"), readFile: () => LINE, remove: f => r3.push(f), realpath: p => { throw new Error("no PAUSE"); }, lstat: () => ({ isSymbolicLink: () => false }) });
  assert.deepEqual(r3, [], "2 hours old with scenarios running: not yet");
});

test("fail closed: an unreadable process table or an unreadable PAUSE link never lets a STOP be removed", async () => {
  const run = async (execOverride, extra = {}) => { const removed = []; const s = server(); await housekeep({}, stopWorld(), { ...s.deps, exec: execOverride || s.deps.exec, now: () => Date.parse("2026-11-19T00:00:00Z"), readFile: () => LINE, remove: f => removed.push(f), realpath: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); }, lstat: () => ({ isSymbolicLink: () => false }), ...extra }); return removed; };
  assert.deepEqual(await run(null), [STOPFILE], "the baseline: the writer ended, a day old: it goes");
  assert.deepEqual(await run(null, { realpath: () => { throw Object.assign(new Error("io"), { code: "EIO" }); } }), [], "a link that cannot be resolved: the STOP stays");
  assert.deepEqual(await run(null, { lstat: () => { throw Object.assign(new Error("io"), { code: "EIO" }); } }), [], "an unreadable lstat: the STOP stays");
});
