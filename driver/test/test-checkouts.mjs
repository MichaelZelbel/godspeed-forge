import { TEST_ENV } from "./env.mjs";
// node --test driver/test/test-checkouts.mjs   (the Forge 0.3.1, ticket 08, issue #157: the factory's checkouts stay the factory's)
import { test } from "./harness.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp, { spawnSync } from "node:child_process";
import { rootGitRefusal, gitFolders, gitAs, gitInDir, factoryAccount, checkoutsFrom, enforceCheckoutGuard, refusedGit } from "../checkout-guard.mjs";
import { sandboxProps, controlPlane, actDefaults, prompt, launchAct } from "../onduty.mjs";
import { launchRepair, defaults as deadmanDefaults } from "../deadman/deadman.mjs";
import { supersessionLook } from "../duties.mjs";
import { housekeep } from "../housekeeping.mjs";

const HOME = "/home/godspeed-forge", CHECKOUT = `${HOME}/godspeed-mission-control`;
const FORGE = { user: "godspeed-forge", home: HOME };
const AS_ROOT = { account: FORGE, root: true };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fd-guard-"));

test("issue #157: git as root in the factory user's home is refused however it names the folder; wrapped as the factory user, outside the home, or not as root it runs", () => {
  // what the acting run did on 2026-11-22 at 01:16, and what the factory's own fetch then could not do
  for (const [file, args, opts] of [
    ["git", ["checkout", "archon/task-archon-loop-0601e400"], { cwd: CHECKOUT }],
    ["git", ["-C", CHECKOUT, "fetch", "origin"], {}],
    ["/usr/bin/git", ["-C", HOME, "-C", "godspeed-mission-control", "merge", "origin/main"], { cwd: "/" }],
    ["git", ["-C", "/tmp", "-C", "../home/godspeed-forge/querino", "status"], {}],
    ["git", ["--git-dir=/home/godspeed-forge/godspeed-mission-control/.git", "log"], { cwd: "/" }],
    ["git", ["--work-tree", CHECKOUT, "checkout", "."], { cwd: "/" }],
    ["git", ["log"], { cwd: "/", env: { GIT_DIR: `${CHECKOUT}/.git` } }],
    ["env", ["-i", "HOME=/root", "git", "-C", CHECKOUT, "commit", "-m", "x"], {}],
    ["git", ["-c", "safe.directory=*", "-C", CHECKOUT, "worktree", "add", "/tmp/x"], {}],
    ["git", ["clone", "-q", "https://github.com/o/r.git", `${HOME}/factory-driver/r`], { cwd: "/root" }],
    ["git", ["-C", "/root", "clone", "--depth", "1", "https://github.com/o/r.git", "../home/godspeed-forge/r2"], {}],
    ["git", ["config", "--file", `${CHECKOUT}/.git/config`, "--add", "x.y", "z"], { cwd: "/" }], // a path named anywhere in its arguments
    ["git", ["-C", "/var/lib/x", "worktree", "add", `${HOME}/lap`], {}],
    ["git", ["-C", "/var/lib/x", "diff", `--output=${HOME}/out.diff`], {}],
    ["git", ["clone", "-q", CHECKOUT, "/var/lib/x/repo"], { cwd: "/" }], // root's git names nothing there, not even to read it
  ]) assert.match(rootGitRefusal(file, args, opts, AS_ROOT), /^refused: git .* as root in \/home\/godspeed-forge.*it runs as godspeed-forge \(runuser -u godspeed-forge --\), never as root/, `${file} ${args.join(" ")}`);
  for (const [file, args, opts] of [
    ["runuser", ["-u", "godspeed-forge", "--", "git", "-C", CHECKOUT, "fetch"], {}], // wrapped: the factory user's own git
    ["ip", ["netns", "exec", "godspeed-forge", "runuser", "-u", "godspeed-forge", "--", "git", "-C", CHECKOUT, "fetch"], {}],
    ["git", ["-C", "/usr/local/lib/godspeed-forge/godspeed-dev", "pull", "--ff-only"], {}], // the release records: root's own clone
    ["git", ["-C", "/var/lib/godspeed-keep-main-green/product.git", "fetch"], {}], // a step's own clone
    ["git", ["-C", "/var/lib/x", "push", "origin", "HEAD:refs/heads/fix/a-b", "https://github.com/o/r.git"], {}], // refs and addresses are no folders
    ["git", ["-C", "/home/godspeed-forgery", "status"], {}], // only the home itself, not a name that starts like it
    ["chown", ["-R", "godspeed-forge:", CHECKOUT], {}], // not git
  ]) assert.equal(rootGitRefusal(file, args, opts, AS_ROOT), "", `${file} ${args.join(" ")}`);
  assert.equal(rootGitRefusal("git", ["-C", CHECKOUT, "fetch"], {}, { account: FORGE, root: false }), "", "not root: the factory user's own git");
  assert.equal(rootGitRefusal("git", ["-C", "/root/projects/o/r", "fetch"], {}, { account: { user: "root", home: "/root" }, root: true }), "", "a factory that runs as root (a server the Forge set up) owns its folders as root");
  assert.equal(rootGitRefusal("git", ["-C", CHECKOUT, "fetch"], {}, { account: { user: "", home: "" }, root: true }), "", "no factory user named: nothing to keep");
  assert.deepEqual(gitFolders(["-C", "a", "-C", "b", "status"], "/x"), ["/x/a/b"]);
  // the same git in a shell command line
  for (const [file, args, opts] of [
    ["bash", ["-c", `cd ${CHECKOUT} && git checkout archon/task-archon-loop-0601e400`], {}],
    ["/bin/sh", ["-ec", `git -C '${HOME}/querino' fetch origin`], {}],
    ["bash", ["-lc", "git status --short"], { cwd: CHECKOUT }],
    ["env", ["-i", "PATH=/usr/bin", "bash", "-c", `git config --file "${CHECKOUT}/.git/config" --get remote.origin.url`], {}],
    [`git -C ${CHECKOUT} merge origin/main`, [], { shell: true }],
    ["bash", ["-c", "cd \"$FD_FORGE_HOME/godspeed-mission-control\"; git checkout main"], { env: { FD_FORGE_HOME: HOME } }], // the home through the environment
    ["bash", ["-c", "cd ${FD_FORGE_HOME}/querino && git pull"], { env: { FD_FORGE_HOME: HOME } }],
    ["sh", ["-c", "cd ~/godspeed-mission-control && git status"], { env: { HOME } }],
  ]) assert.match(rootGitRefusal(file, args, opts, AS_ROOT), /^refused: a shell command that runs git as root names \/home\/godspeed-forge/, `${file} ${args.join(" ")}`);
  for (const [file, args] of [
    ["runuser", ["-u", "godspeed-forge", "--", "bash", "-c", `git -C ${CHECKOUT} fetch`]], // wrapped
    ["bash", ["-c", `ls ${CHECKOUT}/.factory; cat ${HOME}/.factory-env`]], // no git
    ["bash", ["-c", "git -C /usr/local/lib/godspeed-forge/godspeed-dev pull --ff-only -q"]], // git elsewhere
    ["bash", ["-c", `curl -s https://github.com/o/r; ls ${HOME}/.digit`]], // the word git only inside other words
  ]) assert.equal(rootGitRefusal(file, args, {}, AS_ROOT), "", `${file} ${args.join(" ")}`);
});

test("issue #157: every driver process (a round, a step) puts the guard up with the factory user its settings name, and the installer's records pull runs as that user when the records live in its home", async () => {
  const { cli } = await import("../driver.mjs");
  const { renderUnits } = await import("../install.mjs");
  const envBefore = { ...process.env }; // the command puts the settings into the environment: the other tests get theirs back
  try {
    const example = JSON.parse(fs.readFileSync(new URL("../settings.example.json", import.meta.url), "utf8"));
    const dir = tmp(); fs.mkdirSync(path.join(dir, "projects"));
    const d = example["driver.json"]; d.server.state_dir = path.join(dir, "state");
    fs.writeFileSync(path.join(dir, "driver.json"), JSON.stringify(d)); fs.writeFileSync(path.join(dir, "projects", "owner--repository.json"), JSON.stringify(example["projects/owner--repository.json"]));
    const guards = [], step = { name: "beta", STEP: { name: "beta", everyMinutes: 10, maxMinutes: 30, inRound: false }, SETTINGS: [], run: async () => ({ ok: true, summary: "fine" }), module: {} };
    const io = { found: { steps: [step], errors: [] }, log: () => {}, err: () => {}, isActive: () => false, guard: a => { guards.push(a); return () => {}; } };
    assert.equal(await cli(["--step", "beta", "--settings-dir", dir], io), 0);
    assert.deepEqual(guards, [{ user: "factory", home: "/home/factory" }]);
  } finally { for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k]; Object.assign(process.env, envBefore); }
  const source = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
  const units = records => renderUnits(source, { dir: "/etc/godspeed-forge", get: k => ({ "releases.records_checkout": records, "server.factory_user": "godspeed-forge", "server.factory_home": HOME, "server.node": "/usr/bin/node", "server.keeper_dir": "/usr/local/lib/k", "server.state_dir": "/var/lib/s", "server.deadman_state_dir": "/var/lib/d", "server.login_unit": "" })[k] }, "/etc/godspeed-forge/driver.env", "/usr/local/lib/d", "/etc/systemd/system")["factory-driver.service"];
  assert.match(units(`${HOME}/records`), /^ExecStartPre=-\/usr\/sbin\/runuser -u godspeed-forge -- \/usr\/bin\/env HOME=\/home\/godspeed-forge \/usr\/bin\/git -C \/home\/godspeed-forge\/records pull --ff-only -q$/m);
  assert.match(units("/usr/local/lib/godspeed-forge/godspeed-dev"), /^ExecStartPre=-\/usr\/bin\/git -C \/usr\/local\/lib\/godspeed-forge\/godspeed-dev pull --ff-only -q$/m, "root's own records clone, as before");
});

test("issue #157: the account and the checkouts come from the settings, the way the driver names them", () => {
  assert.deepEqual(factoryAccount({ server: { factory_user: "godspeed-forge", factory_home: "/home/godspeed-forge/" } }), FORGE);
  assert.deepEqual(factoryAccount({ server: { factory_user: "factory" } }), { user: "factory", home: "/home/factory" });
  assert.deepEqual(factoryAccount(TEST_ENV), FORGE);
  assert.deepEqual(checkoutsFrom({ FD_PROJECT_CHECKOUTS: JSON.stringify({ "godspeed-mission-control": CHECKOUT, querino: `${HOME}/querino/`, bad: "relative/path", spaced: "/home/a b" }), FD_SOURCE_CHECKOUT: CHECKOUT }), [CHECKOUT, `${HOME}/querino`]);
  assert.deepEqual(checkoutsFrom({ FD_PROJECT_CHECKOUTS: "not json" }), []);
});

test("issue #157: the way to run git in a factory folder is as the factory user, and only when the driver is root and the folder is the factory's", () => {
  assert.deepEqual(gitAs(FORGE, ["-C", CHECKOUT, "fetch"], { root: true }), ["runuser", ["-u", "godspeed-forge", "--", "env", `HOME=${HOME}`, "GIT_TERMINAL_PROMPT=0", "git", "-C", CHECKOUT, "fetch"]]);
  assert.deepEqual(gitAs(FORGE, ["status"], { root: false }), ["git", ["status"]]);
  assert.deepEqual(gitInDir(FORGE, CHECKOUT, ["merge-base", "--is-ancestor", "a", "b"], { root: true })[0], "runuser");
  assert.deepEqual(gitInDir(FORGE, "/usr/local/lib/godspeed-forge/godspeed-dev", ["pull", "--ff-only", "-q"], { root: true }), ["git", ["-C", "/usr/local/lib/godspeed-forge/godspeed-dev", "pull", "--ff-only", "-q"]], "root's own records clone stays root's");
  const [file, args] = gitInDir(FORGE, CHECKOUT, ["fetch"], { root: true });
  assert.equal(rootGitRefusal(file, args, {}, AS_ROOT), "", "what it makes passes the guard");
  // the supersession check reads the factory's checkout through it: as the factory user, never root's git there
  const ran = [];
  const world = { installed: { id: "godspeed-2.0.0-beta.31", staging: { productCommit: "c0ffee1" }, issues: [5] }, superseded: [{ id: "godspeed-2.0.0-beta.30" }] };
  const jv = { releases: { "godspeed-2.0.0-beta.30": { tickets: [{ item: 1, issue: 5 }], slots: {}, commits: { "t:1:merged": "abc1234" } } } };
  supersessionLook(jv, world, (cmd, a) => { ran.push([cmd, ...a]); return { status: 0 }; }, CHECKOUT, true, (dir, a) => gitInDir(FORGE, dir, a, { root: true }));
  assert.deepEqual(ran, [["runuser", "-u", "godspeed-forge", "--", "env", `HOME=${HOME}`, "GIT_TERMINAL_PROMPT=0", "git", "-C", CHECKOUT, "merge-base", "--is-ancestor", "abc1234", "c0ffee1"]]);
});

test("issue #157: in the driver's process the guard stands in front of child_process: root's git in a factory folder answers like a command that could not start, the rest runs, and it comes off again", () => {
  const home = tmp(), repo = path.join(home, "checkout");
  fs.mkdirSync(repo);
  assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  const said = [];
  const before = refusedGit.length;
  const off = enforceCheckoutGuard({ user: "factory-test", home }, { root: true, log: m => said.push(m) });
  try {
    for (const run of [cp.spawnSync, spawnSync]) { // the module's function and an imported name, as every step imports it
      const r = run("git", ["-C", repo, "commit", "--allow-empty", "-m", "as root"], { encoding: "utf8" });
      assert.equal(r.status, null);
      assert.equal(r.error.code, "EROOTGIT");
      assert.match(r.stderr, /^refused: git -C .* as root in .*checkout, which is inside the factory user's home/);
    }
    assert.throws(() => cp.execFileSync("git", ["-C", repo, "status"]), /refused: git/);
    assert.throws(() => cp.spawn("git", ["fetch"], { cwd: repo }), /refused: git/);
    assert.throws(() => cp.execSync("git commit --allow-empty -m x", { cwd: repo }), /refused: a shell command that runs git as root/);
    assert.equal(spawnSync("git", ["--version"], { encoding: "utf8", cwd: os.tmpdir() }).status, 0, "git elsewhere runs");
    assert.equal(spawnSync(process.execPath, ["-e", "process.exit(0)"]).status, 0, "anything else runs");
    assert.equal(refusedGit.length - before, 5);
    assert.equal(said.length, 5, "each refusal is said where the round's log goes");
  } finally { off(); }
  assert.equal(spawnSync("git", ["-C", repo, "log", "--oneline"], { encoding: "utf8" }).stdout, "", "nothing was committed in the checkout");
  assert.equal(spawnSync("git", ["-C", repo, "status", "--short"]).status, 0, "taken off: git runs there again");
  assert.equal(enforceCheckoutGuard(FORGE, { root: false })(), undefined, "not root: nothing is put in front");
  assert.equal(cp.spawnSync, spawnSync);
});

test("issue #157: a file the driver's root process makes in the factory user's home is given to the owner of its folder at once: the stage step's STOP, made or written again through a temporary file; a folder of root's keeps root's", async () => {
  const { createStop, removeStop } = await import("../steps/release/auto-stage.mjs");
  const home = tmp(), checkout = path.join(home, "godspeed-mission-control"), factory = path.join(checkout, ".factory"), rootsOwn = path.join(home, "root-only");
  fs.mkdirSync(factory, { recursive: true }); fs.mkdirSync(rootsOwn);
  // what only root sees: everything this process makes comes out root's (uid 0); the factory user's folders are uid 1001
  const given = new Map(), chowned = [];
  const key = p => path.resolve(String(p));
  const fsOps = {
    lstat: p => ({ uid: given.has(key(p)) ? given.get(key(p)) : 0 }),
    stat: p => ({ uid: key(p) === key(rootsOwn) ? 0 : given.get(key(p)) ?? 1001, gid: 1001 }),
    lchown: (p, uid, gid) => { chowned.push([path.relative(home, p).replace(/\\/g, "/"), uid, gid]); given.set(key(p), uid); },
  };
  const off = enforceCheckoutGuard({ user: "factory-test", home }, { root: true, log: () => {}, fsOps });
  try {
    assert.equal(createStop(path.join(factory, "STOP"), Date.parse("2026-11-24T13:00:00Z")), true, "the stage step's own STOP code");
    assert.deepEqual(chowned, [["godspeed-mission-control/.factory/STOP", 1001, 1001]]);
    // the stage step's other way of writing it: a temporary file renamed over it
    const tmpFile = path.join(factory, `STOP.${process.pid}.tmp`);
    fs.writeFileSync(tmpFile, "auto-stage 1 x\n"); given.delete(key(path.join(factory, "STOP")));
    fs.renameSync(tmpFile, path.join(factory, "STOP"));
    assert.deepEqual(chowned.slice(1).map(c => c[0]), [`godspeed-mission-control/.factory/STOP.${process.pid}.tmp`, "godspeed-mission-control/.factory/STOP"]);
    // folders made in one go, the outer first; a file opened to be written; nothing outside the home; a folder of root's keeps its files
    chowned.length = 0;
    fs.mkdirSync(path.join(home, "work", "a", "b"), { recursive: true });
    const fd = fs.openSync(path.join(home, "work", "log.txt"), "a"); fs.closeSync(fd);
    fs.writeFileSync(path.join(rootsOwn, "kept.txt"), "x");
    const outside = path.join(tmp(), "elsewhere.txt"); fs.writeFileSync(outside, "x");
    assert.deepEqual(chowned.map(c => c[0]), ["work", "work/a", "work/a/b", "work/log.txt"]);
    assert.equal(removeStop(path.join(factory, "STOP")), true, "and it still removes its own STOP");
  } finally { off(); }
  chowned.length = 0;
  fs.writeFileSync(path.join(home, "after.txt"), "x");
  assert.deepEqual(chowned, [], "taken off with the guard");
});

test("issue #157: an acting run and a dead-man repair run have the factory's checkouts read-only, and their briefs say where they work instead", () => {
  const e = { ...TEST_ENV, FD_PROJECT_CHECKOUTS: JSON.stringify({ "godspeed-mission-control": CHECKOUT, querino: `${HOME}/querino` }) };
  const a = { ...actDefaults(e), ACT_DIR: "/var/lib/godspeed-factory-driver/acts" };
  for (const mode of ["release", "repair"]) {
    const ro = sandboxProps(a, mode).find(p => p.startsWith("ReadOnlyPaths=")).slice("ReadOnlyPaths=".length).split(" ");
    for (const c of [CHECKOUT, `${HOME}/querino`]) assert.ok(ro.includes(`-${c}`), `${mode}: ${c} read-only (and a checkout not made yet never stops the unit)`);
    assert.ok(controlPlane(a, mode).includes(`-${CHECKOUT}`));
  }
  assert.ok(!sandboxProps(a).some(p => p.startsWith("ReadWritePaths=") && p.includes(HOME)), "nothing of the factory user's home is writable for it");
  const brief = prompt({ kind: "pr", title: "pull request 804", evidence: [] }, [], "/x/onduty.mjs", a);
  assert.match(brief, /THE FACTORY'S CHECKOUTS \(\/home\/godspeed-forge\/godspeed-mission-control, \/home\/godspeed-forge\/querino\) belong to godspeed-forge and are read-only for you/);
  assert.match(brief, /clone it into a folder of your own \(mktemp -d\)/);
  assert.match(brief, /Never write in them by any route: not with git or any other program, not through systemd-run or another unit, not as another user/);
  assert.ok(!/systemd-run --uid/.test(brief), "it is never shown a way around its sandbox");
  assert.match(brief, /never add a checkout to git's safe\.directory/);
  const dir = tmp(), calls = [];
  launchAct({}, { ...a, ACT_DIR: dir }, { unit: "factory-act-abc-1", entry: { kind: "pr", title: "t", evidence: [] }, provider: "codex" }, (c, args) => { calls.push(args); return { status: 0 }; });
  assert.ok(calls[0].some(x => x.startsWith("ReadOnlyPaths=") && x.includes(`-${CHECKOUT}`)), "the real launch carries them");
  // the dead-man's repair run: its own program, its own list from the same settings
  const cfg = { ...deadmanDefaults(e), ACTS: tmp(), SPOOL: tmp() };
  const runs = [];
  launchRepair(cfg, "factory-repair-x-1", "codex", "the round failed", "", (c, args) => { runs.push(args); return { status: 0 }; });
  const ro = runs[0][runs[0].findIndex(x => x.startsWith("ReadOnlyPaths=")) ];
  assert.ok(ro.split(" ").includes(`-${CHECKOUT}`) && ro.split(" ").includes(`-${HOME}/querino`), ro);
  assert.match(JSON.parse(fs.readFileSync(path.join(cfg.ACTS, "factory-repair-x-1", "job.json"), "utf8")).prompt, /The factory's checkouts \(.*godspeed-mission-control.*\) are read-only for you/);
});

// ---------------------------------------------------------------- housekeeping gives a checkout back to the factory user
// A real checkout of a real repository (a bare origin on this machine, a newer commit pushed after the clone, so a fetch appends to
// .git/logs/refs/remotes/origin/main as it did on the AX41), with a stand-in for what only root can do here: which user owns each
// file (find answers from it, chown changes it), and git as the factory user, which cannot write a file root owns under .git.
const FORGE_USER = "godspeed-forge";
const posix = p => p.replace(/\\/g, "/");
function checkoutFixture(rootOwned = []) {
  const top = posix(fs.mkdtempSync(path.join(os.tmpdir(), "fd-checkout-")));
  const home = `${top}/home/${FORGE_USER}`, origin = `${top}/origin.git`, other = `${top}/other`, checkout = `${home}/godspeed-mission-control`;
  const git = (...a) => { const r = spawnSync("git", a, { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  fs.mkdirSync(home, { recursive: true });
  git("init", "-q", "--bare", "-b", "main", origin);
  git("clone", "-q", origin, other); fs.writeFileSync(path.join(other, "README.md"), "one\n");
  git("-C", other, "add", "-A"); git("-C", other, "commit", "-q", "-m", "one"); git("-C", other, "push", "-q", "origin", "HEAD:main");
  git("clone", "-q", origin, checkout);
  // the factory's own fetches: the first makes the log of origin/main, the next commit is what a fetch must bring
  fs.writeFileSync(path.join(other, "README.md"), "two\n"); git("-C", other, "commit", "-q", "-am", "two"); git("-C", other, "push", "-q", "origin", "HEAD:main");
  git("-C", checkout, "fetch", "-q", "origin");
  fs.writeFileSync(path.join(other, "README.md"), "three\n"); git("-C", other, "commit", "-q", "-am", "three"); git("-C", other, "push", "-q", "origin", "HEAD:main");
  const newest = git("-C", other, "rev-parse", "HEAD");
  // who owns what: every file the factory user's, but the ones named (root's, as a root process left them)
  const owner = new Map();
  const walk = (dir, rel = "") => { for (const d of fs.readdirSync(dir, { withFileTypes: true })) { const r = rel ? `${rel}/${d.name}` : d.name; owner.set(r, FORGE_USER); if (d.isDirectory()) walk(path.join(dir, d.name), r); } };
  walk(checkout);
  for (const r of rootOwned) { assert.ok(owner.has(r), `the fixture has ${r}`); owner.set(r, "root"); }
  const calls = [], opts = [];
  const fetchError = "error: unable to append to '.git/logs/refs/remotes/origin/main': Permission denied\nerror: cannot update ref 'refs/remotes/origin/main': unable to append to '.git/logs/refs/remotes/origin/main': Permission denied";
  const deps = { root: true, sleep: async () => {}, exists: p => fs.existsSync(p),
    run: (argv, o) => {
      calls.push(argv); opts.push(o || {});
      if (argv[0] === "find") {
        const user = argv[argv.indexOf("-user") + 1];
        if (argv[1] !== checkout) return { status: 1, stdout: "", stderr: `find: '${argv[1]}': No such file or directory` };
        const theirs = [...owner].filter(([, u]) => u !== user);
        if (argv.includes("-execdir")) { // find ... -execdir chown -h -- <user>: {} +: what it found is the user's now
          const to = argv[argv.indexOf("--") + 1].replace(/:$/, "");
          for (const [r] of theirs) owner.set(r, to);
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: theirs.map(([r, u]) => `${u}\t${r}\n`).join(""), stderr: "" };
      }
      const g = argv.indexOf("git");
      if (g > 0 && argv.includes("fetch")) {
        // the factory user's git: it cannot write what root owns under .git
        if ([...owner].some(([r, u]) => u !== FORGE_USER && r.startsWith(".git/"))) return { status: 1, stdout: "", stderr: fetchError };
        const r = spawnSync("git", argv.slice(g + 1), { encoding: "utf8" });
        return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    } };
  const env = { FORGE_USER, FORGE_UID: "1001", FORGE_NETNS: "godspeed-forge", FORGE_HOME: home, PROJECT_CHECKOUTS: { "godspeed-mission-control": checkout }, FACTORY_CHECKOUT: "" };
  return { top, home, checkout, origin, newest, owner, calls, opts, deps, env, git };
}
const hkWorld = () => ({ server: { failedUnits: [], diskPct: 50, memAvailPct: 60, staleProcs: [], logins: { gh: true } } });
const chowns = calls => calls.filter(c => c[0] === "chown" || (c[0] === "find" && c.includes("chown")));
const giveBack = c => ["find", c, "-xdev", "!", "-user", FORGE_USER, "-execdir", "chown", "-h", "--", `${FORGE_USER}:`, "{}", "+"];
const fetches = calls => calls.filter(c => c.includes("git") && c.includes("fetch"));
const escape = s => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

test("ticket 08 (#157): a checkout with a root-owned .git/logs file goes back to the factory user in one round, and its git fetch works again", async () => {
  const f = checkoutFixture([".git/logs/refs/remotes/origin/main", "README.md"]);
  // as on the AX41: the factory user's own fetch fails on the file root owns
  assert.match(f.deps.run(["ip", "netns", "exec", "godspeed-forge", "runuser", "-u", FORGE_USER, "--", "git", "-C", f.checkout, "fetch", "origin"]).stderr, /unable to append to '\.git\/logs\/refs\/remotes\/origin\/main': Permission denied/);
  f.calls.length = 0; f.opts.length = 0;
  const out = await housekeep(f.env, hkWorld(), f.deps);
  assert.deepEqual(chowns(f.calls), [giveBack(f.checkout)], "one chown, of what is not the factory user's in that checkout: its own filesystem, never through a link");
  assert.ok([...f.owner.values()].every(u => u === FORGE_USER), "every file is the factory user's again");
  const fx = fetches(f.calls);
  assert.equal(fx.length, 1, "one fetch, after the repair");
  assert.deepEqual(fx[0].slice(0, 8), ["ip", "netns", "exec", "godspeed-forge", "runuser", "-u", FORGE_USER, "--"], "as the factory user, inside its network");
  assert.ok(fx[0].includes(`HOME=${f.home}`), "in its own home");
  assert.ok(fx[0].includes("--no-write-fetch-head"), "the factory's own FETCH_HEAD is left alone");
  assert.equal(f.opts[f.calls.indexOf(fx[0])].timeout, 60000, "a stalled remote holds the round a minute at most");
  assert.ok(f.calls.every((c, i) => f.opts[i].timeout > 0 && f.opts[i].timeout <= 300000), "every command of this check has its own limit");
  assert.equal(f.git("-C", f.checkout, "rev-parse", "origin/main"), f.newest, "origin/main is today's main again");
  assert.deepEqual(out.failed, []);
  assert.equal(out.done.length, 1);
  assert.match(out.done[0], new RegExp(`^gave the factory's checkout ${escape(f.checkout)} back to godspeed-forge: 2 files were not its \\(root\\), 1 of them git's own \\(\\.git/logs/refs/remotes/origin/main\\); its git fetch works again$`));
  assert.deepEqual(out.repairs, [{ what: "checkout ownership", checkout: f.checkout, files: 2, gitFiles: 1, owners: ["root"], sample: [".git/logs/refs/remotes/origin/main", "README.md"], fetch: "works" }]);
  // the next round finds nothing to do and says nothing
  f.calls.length = 0; f.opts.length = 0;
  const again = await housekeep(f.env, hkWorld(), f.deps);
  assert.deepEqual(chowns(f.calls), []);
  assert.deepEqual([again.done, again.failed, again.repairs], [[], [], []]);
  assert.equal(fetches(f.calls).length, 1, "the fetch is checked every round");
});

test("ticket 08 (#157): a checkout that cannot fetch for another reason, or whose files could not be given back, is reported and never hidden", async () => {
  const f = checkoutFixture();
  const offline = { ...f.deps, run: (argv, o) => (argv.includes("fetch") ? (f.calls.push(argv), { status: 128, stdout: "", stderr: "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com" }) : f.deps.run(argv, o)) };
  const out = await housekeep(f.env, hkWorld(), offline);
  assert.deepEqual(chowns(f.calls), [], "nothing of root's in it: no chown");
  assert.deepEqual(out.failed, [`the factory's checkout ${f.checkout} cannot fetch: fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com`]);
  assert.deepEqual(out.repairs, []);
  const g = checkoutFixture([".git/HEAD"]);
  const stuck = { ...g.deps, run: (argv, o) => (argv.includes("chown") ? (g.calls.push(argv), { status: 1, stdout: "", stderr: "chown: changing ownership of './HEAD': Operation not permitted" }) : g.deps.run(argv, o)) };
  const out2 = await housekeep(g.env, hkWorld(), stuck);
  assert.equal(chowns(g.calls).length, 1);
  assert.deepEqual(out2.failed, [`the factory's checkout ${g.checkout} has 1 file that is not godspeed-forge's (root: .git/HEAD), and it could not be given back: chown: changing ownership of './HEAD': Operation not permitted`,
    `the factory's checkout ${g.checkout} cannot fetch: error: cannot update ref 'refs/remotes/origin/main': unable to append to '.git/logs/refs/remotes/origin/main': Permission denied`]);
  assert.deepEqual(out2.repairs, []);
  const h = checkoutFixture();
  const unreadable = { ...h.deps, run: (argv, o) => (argv[0] === "find" ? (h.calls.push(argv), { status: 1, stdout: "", stderr: "find: '/x': Input/output error" }) : h.deps.run(argv, o)) };
  const out3 = await housekeep(h.env, hkWorld(), unreadable);
  assert.deepEqual(chowns(h.calls), [], "an owner list that could not be read changes nothing");
  assert.deepEqual(out3.failed, [`the owners of the files in the factory's checkout ${h.checkout} could not be read: find: '/x': Input/output error`]);
});

test("ticket 08 (#157): housekeeping changes owners only inside a checkout in the factory user's home and only as root; a factory that runs as root gets its fetch checked; the stage step's STOP is given back like any other file", async () => {
  const f = checkoutFixture([".git/index"]);
  const look = async (env, deps = f.deps) => { f.calls.length = 0; await housekeep(env, hkWorld(), deps); return f.calls.filter(c => ["find", "chown"].includes(c[0]) || c.includes("fetch")); };
  for (const bad of ["/root/godspeed", f.home, `${f.home}/../other`, "relative/checkout", `${f.top}/origin.git`, "/", `${f.home}/a b`]) {
    assert.deepEqual(await look({ ...f.env, PROJECT_CHECKOUTS: { x: bad } }, { ...f.deps, exists: () => true }), [], `${bad}: not a checkout in the factory user's home, never looked at or changed`);
  }
  assert.deepEqual(await look({ ...f.env, PROJECT_CHECKOUTS: { x: `${f.home}/not-cloned-yet` } }), [], "a checkout not made yet");
  // a link the factory user could have put there: a chown through it could reach anywhere, so nothing is changed and it is said
  fs.symlinkSync(f.checkout, `${f.home}/linked`, "junction");
  const linked = await housekeep({ ...f.env, PROJECT_CHECKOUTS: { x: `${f.home}/linked` } }, hkWorld(), f.deps);
  assert.ok(!f.calls.some(c => c[0] === "chown" || c[0] === "find"), "never looked at or changed through the link");
  assert.match(linked.failed[0], new RegExp(`^the factory's checkout ${escape(f.home)}/linked is reached through a link \\(it is .*godspeed-mission-control\\), so its owners were not checked$`));
  assert.deepEqual(await look(f.env, { ...f.deps, root: false }), [], "not root: it could not give anything back, and nothing of root's can be there");
  // a factory that runs as root (a server the Forge set up) owns its checkouts as root, and no file can stop root's fetch:
  // nothing is given back there, but its fetch is checked like every other's
  const asRoot = await look({ ...f.env, FORGE_USER: "root", FORGE_HOME: f.home, FORGE_NETNS: "" });
  assert.deepEqual(asRoot.map(c => c[0] === "find" ? "find" : c.includes("fetch") ? "fetch" : c[0]), ["fetch"]);
  assert.deepEqual(asRoot[0].slice(0, 4), ["runuser", "-u", "root", "--"]);
  assert.deepEqual(chowns(await look({ ...f.env, PROJECT_CHECKOUTS: {}, FACTORY_CHECKOUT: f.checkout })), [giveBack(f.checkout)], "the main checkout counts when only main.checkout names it");
  // the stage step writes the factory's STOP as root: it is given back and said like any other file of root's, never hidden
  const s = checkoutFixture();
  fs.mkdirSync(`${s.checkout}/.factory`); fs.writeFileSync(`${s.checkout}/.factory/STOP`, "auto-stage 4242 2026-11-24T13:00:00Z\n");
  s.owner.set(".factory", FORGE_USER); s.owner.set(".factory/STOP", "root");
  const staged = await housekeep(s.env, hkWorld(), s.deps);
  assert.deepEqual(chowns(s.calls), [giveBack(s.checkout)]);
  assert.equal(s.owner.get(".factory/STOP"), FORGE_USER);
  assert.deepEqual(staged.repairs.map(r => [r.files, r.sample]), [[1, [".factory/STOP"]]]);
});
