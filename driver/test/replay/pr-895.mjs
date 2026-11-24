// The morning of 2026-11-24 on pull request #895, replayed (issue #152).
//
// What happened: from 05:01 to 06:37 UTC the driver started a new acting run on the same parked pull request every five
// minutes. Each looked, found the same thing ("green, a known repair, parked after its repair limit, only the owner can allow
// another lap"), said so in a comment and answered with a notice; the next round started the next one. 19 comments: 14 as the
// release App, 5 as the owner, because the run was root and root's own gh is logged in as the owner.
//
//   replayGuard(root)   every one of the 19 comments, as the run that wrote it tried to post it (with the login it really used),
//                       through the acting run's gh guard: what reaches GitHub
//   replayChain(root)   the driver's own rounds every five minutes over the same two hours, with a stand-in for the AI that writes
//                       the next comment of the morning the way the real run did: how many runs start, and what reaches GitHub
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GUARD_FILE, prepareAppRun, findingOf, findingMarker, readGuardLog } from "../../owner-guard.mjs";
import { buildInventory } from "../../inventory.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_GH = path.join(HERE, "..", "fake-gh.mjs");
export const OWNER = "MichaelZelbel";
export const RELEASE_BOT = "godspeed-dev-release[bot]";
export const APP_TOKEN = "ghs_release_app_token_for_the_run";
export const STORED_OWNER_TOKEN = "gho_the_owners_own_stored_login";
export const loadFixture = () => JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "2026-11-24-pr-895.json"), "utf8"));

// A GitHub that answers from a file: the comments already on #895, root's stored login (the owner's), the release App's tokens.
export function fakeGitHub(root, fx = loadFixture()) {
  fs.mkdirSync(root, { recursive: true });
  const stateFile = path.join(root, "github.json");
  fs.writeFileSync(stateFile, JSON.stringify({ repo: fx.repo, appLogin: RELEASE_BOT, users: { [STORED_OWNER_TOKEN]: OWNER },
    comments: { [`${fx.repo}#${fx.number}`]: fx.before.map(c => ({ body: c.body, user: { login: c.login }, created_at: c.at })) }, posts: [] }));
  // root's default gh folder: the owner's login, the way `gh auth login` writes it
  const ownerConfig = path.join(root, "root-config");
  fs.mkdirSync(path.join(ownerConfig, "gh"), { recursive: true });
  fs.writeFileSync(path.join(ownerConfig, "gh", "hosts.yml"), `github.com:\n    users:\n        ${OWNER}:\n            oauth_token: ${STORED_OWNER_TOKEN}\n    git_protocol: https\n    oauth_token: ${STORED_OWNER_TOKEN}\n    user: ${OWNER}\n`);
  return { stateFile, ownerConfig, realGh: JSON.stringify([process.execPath, FAKE_GH, "--state", stateFile]), state: () => JSON.parse(fs.readFileSync(stateFile, "utf8")) };
}
// The environment a test child starts from: this machine's, without any GitHub login of its own.
export function cleanEnv(extra = {}) {
  const e = { ...process.env };
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "GH_HOST", "GH_REPO", "XDG_CONFIG_HOME", "GIT_CONFIG_COUNT"]) delete e[k];
  return { ...e, ...extra };
}
// What a run that reached for root's own login had: no GH_CONFIG_DIR and no GH_TOKEN of the run's, so gh reads root's default
// folder, which holds the owner's login (on the server the unit cannot read that folder at all; this is the guard behind it).
export function asRootDid(env, ownerConfig) {
  const e = { ...env, XDG_CONFIG_HOME: ownerConfig };
  delete e.GH_CONFIG_DIR; delete e.GH_TOKEN;
  return e;
}
// The inventory entry of #895 as the driver built it at `at`: GitHub's "last touched" is the newest comment by then.
export function entryAt(fx, state, at) {
  const times = ((state.comments || {})[`${fx.repo}#${fx.number}`] || []).map(c => c.created_at).filter(t => Date.parse(t) <= at).sort();
  const updatedAt = times.at(-1) || "2026-11-24T04:00:00Z";
  return buildInventory({ openPrs: [{ repo: fx.repo, number: fx.number, title: fx.title, url: fx.url, updatedAt }] }, {}, [], { now: at }).find(e => e.id === fx.entryId);
}
// One note through the run's gh guard, as `gh pr comment <n> -R <repo> --body-file <file>`. -> {status, stderr}
export function postThroughGuard({ dir, env, repo, number, body, at }) {
  const file = path.join(dir, `note-${Date.parse(at)}.md`);
  fs.writeFileSync(file, body);
  const r = spawnSync(process.execPath, [GUARD_FILE, "--config", path.join(dir, "guard.json"), "gh", "pr", "comment", String(number), "-R", repo, "--body-file", file],
    { encoding: "utf8", env: { ...env, FAKE_GH_NOW: at } });
  return { status: r.status, stderr: r.stderr || "" };
}

export function replayGuard(root, fx = loadFixture()) {
  const gh = fakeGitHub(root, fx);
  const tries = [];
  fx.comments.forEach((c, i) => {
    const at = Date.parse(c.at);
    const entry = entryAt(fx, gh.state(), at);
    const finding = findingOf(entry);
    const dir = path.join(root, `run-${String(i + 1).padStart(2, "0")}`);
    const p = prepareAppRun({ dir, token: APP_TOKEN, owner: OWNER, finding, repo: fx.repo, realGh: gh.realGh });
    const env = cleanEnv(p.vars);
    const r = postThroughGuard({ dir, env: c.login === OWNER ? asRootDid(env, gh.ownerConfig) : env, repo: fx.repo, number: fx.number, body: `${c.body}\n${findingMarker(finding)}`, at: c.at });
    tries.push({ at: c.at, as: c.login, finding, status: r.status, refused: readGuardLog(path.join(dir, "guard.log")) });
  });
  return { posts: gh.state().posts, tries };
}

// ---------------------------------------------------------------- the driver's own rounds
// The acting run's AI, replaced: it writes the next comment of the morning the way the real run did (as the owner when the real
// one did, and when refused it does what the refusal says, once: the App token), then answers what the real run answered.
function standIn(fx, gh, used) {
  return (file, args, opts) => {
    const c = fx.comments[Math.min(used.n, fx.comments.length - 1)];
    used.n++;
    const finding = opts.env.FD_ACT_FINDING;
    const body = `${c.body}\n${findingMarker(finding)}`;
    let r = postThroughGuard({ dir: used.dir(), env: c.login === OWNER ? asRootDid(opts.env, gh.ownerConfig) : opts.env, repo: fx.repo, number: fx.number, body, at: c.at });
    if (r.status === 3 && /owner's own GitHub account/.test(r.stderr)) r = postThroughGuard({ dir: used.dir(), env: opts.env, repo: fx.repo, number: fx.number, body, at: c.at });
    const answer = `${c.body}\n\nRESULT: notice`;
    if (file === "codex") { fs.writeFileSync(args[args.indexOf("-o") + 1], answer); return { status: 0, stdout: "", stderr: "" }; }
    return { status: 0, stdout: answer, stderr: "" };
  };
}
// -> {launches: [{at, unit, rung, provider}], finished: [{at, unit, result}], posts, obstacles: [kinds seen], state}
export async function replayChain(root, fx = loadFixture(), { rounds = 20, from = "2026-11-24T05:01:00Z" } = {}) {
  const { round, driverDefaults } = await import("../../driver.mjs");
  const { launchAct, runJob } = await import("../../onduty.mjs");
  const { TEST_ENV } = await import("../env.mjs");
  const gh = fakeGitHub(path.join(root, "github"), fx);
  const saved = { per: process.env.FD_ACT_RUNS_PER_DAY, res: process.env.FD_ACT_RESERVED };
  process.env.FD_ACT_RUNS_PER_DAY = "100"; process.env.FD_ACT_RESERVED = "20"; // the server's budget that morning
  try {
    const base = driverDefaults({ ...TEST_ENV, FD_STATE_DIR: path.join(root, "state") }, []);
    const env = { ...base, STATE_DIR: path.join(root, "state"), QUESTIONS_DIR: path.join(root, "questions"), NOTICES_FILE: path.join(root, "notices.json"), REPO: fx.repo,
      ACT: { ...base.ACT, ACT_DIR: path.join(root, "acts"), FACTORY_HOME: path.join(root, "factory"), NOTICES: path.join(root, "notices.json"), REAL_GH: gh.realGh, OWNER_LOGIN: OWNER } };
    let now = Date.parse(from);
    const T0 = now;
    // the chain as it stood at 05:01: the run before had just answered with a notice, and the entry was back on rung 1, untried
    fs.mkdirSync(env.STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.STATE_DIR, "state.json"), JSON.stringify({ chain: { [fx.entryId]: { rung: 1, rungSince: T0 - 60000, milestone: Date.parse("2026-11-22T23:10:00Z"), firstSeenAt: Date.parse("2026-11-22T23:10:00Z"), launched: false, told: false, tries: [] } }, acts: {}, actRuns: [] }));
    const used = { n: 0, current: "", dir: () => used.current };
    const launches = [];
    const world = () => {
      const st = gh.state();
      const times = (st.comments[`${fx.repo}#${fx.number}`] || []).map(c => c.created_at).sort();
      return { releases: [], factories: [], queue: [], toMichael: {}, answeredElsewhere: {}, unreadable: [], items: {}, main: null, server: null, tools: null, installed: null, superseded: [],
        openPrs: [{ repo: fx.repo, number: fx.number, title: fx.title, url: fx.url, updatedAt: times.at(-1) || from }] };
    };
    const deps = {
      now: () => now, log: () => {}, gh: () => { throw new Error("no GitHub in the replay"); }, sh: () => "", records: { read: () => null, write: () => "c0ffee" }, ownerIssue: 600,
      mono: () => ({ uptime: NaN, boot: "" }), rescues: async () => {}, causes: async () => {},
      providers: async () => [{ name: "codex", model: "gpt-5.6-terra", strong: "gpt-5.6-sol" }, { name: "claude", model: "claude-sonnet-5-5", strong: "claude-opus-5-5" }],
      check: () => ({ out: { approve: true, reason: "" }, trouble: "" }), refreshTokens: () => [], gateCfg: { reads: 1, gapMs: 0 }, recheck: async ids => new Set(ids),
      activity: async () => null, rung0: async () => [], watcherHealth: () => ({ ok: true }), mirroredHead: () => "", publishHeartbeat: () => {}, clockCheck: () => ({ ok: true, ghNow: NaN, skewMs: NaN }),
      supersession: () => ({ leave: [], bad: [] }), nextRelease: async () => null, verifyInstalled: () => ({ ok: false, why: "replay" }), seenCheck: () => ({ seen: false }),
      deliver: { telegram: async () => ({ ok: true, receipt: "1" }), issue: () => ({ ok: true, receipt: "https://github.com/o/w/issues/1" }) },
      launchHelper: async (e, o) => ({ unit: o.unit, dir: "/x" }), helperResult: () => ({ state: "running" }), hkDeps: { run: () => ({ status: 0, stdout: "", stderr: "" }), sleep: async () => {} },
      housekeep: async () => ({ done: [], failed: [] }), stageLook: async () => null, pauses: () => [], expireLocks: () => [], fallbacks: async () => [], approvals: async () => ({}),
      readWorld: async () => world(),
      // the real acting run, started at once in place of systemd: its job, its GitHub (the App token, the guard), its answer
      launchAct: (e, a, o) => {
        const l = launchAct(e, a, { ...o, settings: {} }, () => ({ status: 0 }));
        used.current = l.dir;
        launches.push({ at: new Date(now).toISOString(), unit: l.unit, provider: l.provider });
        runJob(l.dir, standIn(fx, gh, used), {}, () => APP_TOKEN);
        return l;
      },
    };
    const obstacles = new Set();
    for (let k = 0; k < rounds; k++) {
      const out = await round(env, deps);
      for (const o of out.obstacles || []) obstacles.add(o.kind);
      now += 5 * 60000;
    }
    const decisions = fs.readFileSync(path.join(env.STATE_DIR, "decisions.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    return { launches, finished: decisions.filter(d => d.kind === "acting run finished"), posts: gh.state().posts, obstacles: [...obstacles], state: JSON.parse(fs.readFileSync(path.join(env.STATE_DIR, "state.json"), "utf8")), decisions };
  } finally {
    if (saved.per === undefined) delete process.env.FD_ACT_RUNS_PER_DAY; else process.env.FD_ACT_RUNS_PER_DAY = saved.per;
    if (saved.res === undefined) delete process.env.FD_ACT_RESERVED; else process.env.FD_ACT_RESERVED = saved.res;
  }
}
