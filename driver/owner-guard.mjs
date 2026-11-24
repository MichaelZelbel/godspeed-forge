#!/usr/bin/env node
// No helper ever writes as the owner, and none says the same thing twice (the Forge 0.3.1, issue #152).
//
// WHY. On 2026-11-24 between 05:02 and 06:34 UTC the acting run (onduty.mjs, rung 1 of the chain) was started every five
// minutes on the same parked pull request and wrote the same finding 19 times: 13 times as the release App, 6 times as the
// owner. It runs as root, and root's own gh is logged in as the owner (root's checkout of the owner's brain pushes as him, so
// that login stays where it is); the brief even said so. Nothing a helper writes may appear under the owner's account.
//
// WHAT.
//   prepareAppRun()  the GitHub part of an acting run: GH_TOKEN set to an App token, GH_CONFIG_DIR an empty folder of its own
//                    (root's stored login is invisible; the unit cannot read root's gh folder at all either, onduty.mjs), every
//                    stored git credential helper switched off and the only one left handing git that same App token, and gh
//                    and git found first on PATH as two one-line shims that call this file.
//   decide()         what the shims (and the factory helpers' guard, release-driver-guard.mjs) ask before a call goes through:
//                    whose login it would use. An App's token passes; the owner's login is refused, and the refusal is logged
//                    with owner: true, which the driver turns into an "as-owner" obstacle (asOwnerObstacles). A note on an
//                    issue or pull request carries the run's finding line (the item and a hash of its state, findingOf); a
//                    note whose finding is already on that item is refused as unchanged (logged with unchanged: true), and
//                    the driver records the run as "unchanged" instead of a new finding.
//   mintAppToken()   the App token for the run, made with the token script and the keys file, for this one child.
//
//   node owner-guard.mjs --config <guard.json> gh|git <args...>     (the shims)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { flagValue, bodyOf, apiBody, apiPayload, gitCommand } from "./release-driver/release-driver-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, "/");
export const GUARD_FILE = path.posix.join(HERE, "owner-guard.mjs");
export const FINDING_PREFIX = "factory-driver:finding";
const sha1 = s => crypto.createHash("sha1").update(String(s)).digest("hex");
const ROOT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// ---------------------------------------------------------------- the finding (pure)
// An item's state is what the driver knows about it, without what changes while nothing happens: "last touched <time>" (every
// comment touches a pull request, our own too) and running counts of minutes, hours or rounds.
const VOLATILE = [/\blast touched \S+/gi, /\b\d+(?:\.\d+)?\s*(?:min|mins|minutes?|hours?|rounds?|seconds?)\b/gi];
export const stateText = o => [o.kind || "", o.obstacleKind || "", o.title || "", ...(Array.isArray(o.evidence) ? o.evidence : [])]
  .map(s => VOLATILE.reduce((t, re) => t.replace(re, "~"), String(s))).join("\n");
// An inventory entry or an obstacle -> "<the item, 10 hex> <its state, 12 hex>"
export const findingOf = o => `${sha1(o && o.id).slice(0, 10)} ${sha1(stateText(o || {})).slice(0, 12)}`;
export const FINDING_SHAPE = /^[0-9a-f]{10} [0-9a-f]{12}$/;
export const findingMarker = f => `<!-- ${FINDING_PREFIX} ${f} -->`;
const FINDING_RE = new RegExp(`<!--\\s*${FINDING_PREFIX}\\s+([0-9a-f]{10})\\s+([0-9a-f]{12})\\s*-->`, "g");
export const findingsIn = body => [...String(body || "").matchAll(FINDING_RE)].map(m => `${m[1]} ${m[2]}`);

// ---------------------------------------------------------------- whose login
// An App installation token starts with ghs_. Anything else (gho_, ghp_, ghu_, github_pat_, a classic token) is a person's.
export function tokenKind(token) {
  const t = String(token || "").trim();
  if (!t) return "none";
  return /^ghs_/.test(t) ? "app" : "user";
}
const bins = v => { if (Array.isArray(v)) return v; const s = String(v || "").trim(); if (s.startsWith("[")) return JSON.parse(s); return [s]; };
function run(cmd, args, opts = {}) {
  const [file, ...pre] = bins(cmd);
  const r = spawnSync(file, [...pre, ...args], { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.status, stdout: r.stdout || "", stderr: `${r.stderr || ""}${r.error ? r.error.message : ""}` };
}
// The login behind a token. An App's token needs no question to GitHub; a person's is asked once (GET /user) and kept by the
// token's hash in `cache`. -> {kind: "none"|"app"|"user", login?, unknown?}
export function tokenIdentity(token, { env = process.env, realGh = "/usr/bin/gh", cache = "" } = {}) {
  const kind = tokenKind(token);
  if (kind !== "user") return { kind };
  const file = cache ? path.join(cache, `login-${sha1(token).slice(0, 16)}.json`) : "";
  if (file) { try { const c = JSON.parse(fs.readFileSync(file, "utf8")); if (c && c.login) return { kind, login: c.login }; } catch { /* asked below */ } }
  const ask = { ...env, GH_TOKEN: String(token).trim() };
  delete ask.GITHUB_TOKEN;
  const r = run(realGh, ["api", "user", "--jq", ".login"], { env: ask });
  const login = r.status === 0 ? r.stdout.trim() : "";
  if (!login) return { kind, unknown: true };
  if (file) { try { fs.mkdirSync(cache, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify({ login }), { mode: 0o600 }); } catch { /* asked again next time */ } }
  return { kind, login };
}
// The login a gh call made with `env` would use (gh itself says which token: GH_TOKEN, the config folder, the keyring).
export function ghIdentity({ env = process.env, realGh = "/usr/bin/gh", cache = "", cwd } = {}) {
  const r = run(realGh, ["auth", "token"], { env, cwd });
  return tokenIdentity(r.status === 0 ? r.stdout.trim() : "", { env, realGh, cache });
}
// The login a git push made with `env` would use: the password git's credential helpers hand out for github.com.
export function gitIdentity({ env = process.env, realGit = "/usr/bin/git", realGh = "/usr/bin/gh", pre = [], cwd, cache = "" } = {}) {
  const r = run(realGit, [...pre, "credential", "fill"], { env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" }, cwd, input: "protocol=https\nhost=github.com\n\n" });
  const token = r.status === 0 ? ((/^password=(.*)$/m.exec(r.stdout) || [])[1] || "").trim() : "";
  return tokenIdentity(token, { env, realGh, cache });
}
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
// -> "" when the call may go on, else why it is refused
export function ownerWhy(id, owner) {
  if (!owner || !id || id.kind !== "user") return "";
  if (id.unknown) return "the guard could not tell whose GitHub login this call would use, and a helper uses only the Apps' tokens: use the App token in GH_TOKEN";
  if (same(id.login, owner)) return `this call would act as ${owner}, the owner's own GitHub account, and nothing a helper does may appear under it: use the App token in GH_TOKEN (or mint one with the token script)`;
  return "";
}

// ---------------------------------------------------------------- notes on issues and pull requests (pure)
const VALUE_FLAGS = {
  comment: ["-R", "--repo", "-b", "--body", "-F", "--body-file"],
  close: ["-R", "--repo", "-c", "--comment", "-r", "--reason"],
  review: ["-R", "--repo", "-b", "--body", "-F", "--body-file"],
};
function positionals(rest, valueFlags) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const x = String(rest[i]);
    if (x.startsWith("-")) { if (!x.includes("=") && valueFlags.includes(x)) i++; continue; }
    out.push(x);
  }
  return out;
}
const ITEM_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/;
const repoOf = v => (v === null || v === undefined || v === "" ? null : String(v).replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, ""));
const API_VALUE_FLAGS = ["-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache", "-p", "--preview"];
function apiComment(args, cwd) {
  const pos = [];
  for (let i = 0; i < args.length; i++) { const x = String(args[i]); if (API_VALUE_FLAGS.includes(x)) { i++; continue; } if (x.startsWith("-")) continue; pos.push(x); }
  const endpoint = String(pos[0] || "").replace(/^https:\/\/api\.github\.com\//, "").replace(/^\//, "");
  const explicit = flagValue(args, ["-X", "--method"]);
  const fields = args.some(x => ["-f", "-F", "--field", "--raw-field", "--input"].includes(x) || /^--(raw-)?field=|^--input=/.test(x) || /^-[fF]./.test(x));
  const method = String(explicit || (fields ? "POST" : "GET")).toUpperCase();
  if (endpoint === "graphql") {
    const t = apiPayload(args, cwd);
    if (t !== null && !(/\bmutation\b/i.test(t) && /\b(addComment|addPullRequestReview\w*|addDiscussionComment|updateIssueComment|updatePullRequestReview\w*)\b/.test(t))) return null;
    return { repo: null, number: null, body: t, graphql: true };
  }
  if (method !== "POST" && method !== "PATCH" && method !== "PUT") return null;
  const m = /^repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)\/(comments|reviews)(?:\?.*)?$/.exec(endpoint);
  if (m) return { repo: m[1], number: Number(m[3]), body: apiBody(args, cwd), review: m[4] === "reviews" || m[2] === "pulls" };
  const e = /^repos\/([^/]+\/[^/]+)\/(?:issues|pulls)\/comments\/\d+(?:\?.*)?$/.exec(endpoint);
  if (e) return { repo: e[1], number: null, body: apiBody(args, cwd), edit: true };
  return null;
}
// A gh call that posts a note on an issue or pull request -> {repo, number, body} (repo or number null when the call does not
// name them, body null when it cannot be read); null for every other call.
export function commentOf(args, cwd) {
  const a = args.filter(x => x !== undefined).map(String);
  const [group, sub, ...rest] = a;
  const repoFlag = repoOf(flagValue(a, ["--repo", "-R"]));
  const target = flags => {
    const pos = positionals(rest, flags);
    const url = pos.map(p => ITEM_URL.exec(p)).find(Boolean);
    if (url) return { repo: url[1], number: Number(url[2]) };
    const n = pos.find(p => /^#?\d+$/.test(p));
    return { repo: repoFlag, number: n ? Number(n.replace("#", "")) : null };
  };
  if ((group === "issue" || group === "pr") && sub === "comment") return a.includes("--delete-last") ? null : { ...target(VALUE_FLAGS.comment), body: bodyOf(a, cwd), review: group === "pr" };
  if ((group === "issue" || group === "pr") && sub === "close") { const c = flagValue(a, ["--comment", "-c"]); return c === null ? null : { ...target(VALUE_FLAGS.close), body: c, review: group === "pr" }; }
  if (group === "pr" && sub === "review") {
    if (flagValue(a, ["--body", "-b"]) === null && flagValue(a, ["--body-file", "-F"]) === null) return null;
    return { ...target(VALUE_FLAGS.review), body: bodyOf(a, cwd), review: true };
  }
  if (group === "api") return apiComment(a.slice(1), cwd);
  return null;
}
// What is already on an item: its comments, and on a pull request its reviews. -> [body]
export const existingBodies = ({ env = process.env, realGh = "/usr/bin/gh" } = {}) => (repo, n, review) => {
  const out = [];
  const pages = ep => {
    const rows = [];
    for (let p = 1; p <= 30; p++) {
      const r = run(realGh, ["api", `${ep}?per_page=100&page=${p}`], { env });
      if (r.status !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.status}`);
      const page = JSON.parse(r.stdout || "[]");
      rows.push(...(Array.isArray(page) ? page : []));
      if (!Array.isArray(page) || page.length < 100) break;
    }
    return rows;
  };
  out.push(...pages(`repos/${repo}/issues/${n}/comments`).map(c => String((c && c.body) || "")));
  if (review) { try { out.push(...pages(`repos/${repo}/pulls/${n}/reviews`).map(c => String((c && c.body) || ""))); } catch { /* an issue has no reviews */ } }
  return out;
};
// -> {why, unchanged?}: why is "" when the note may be posted. cfg.finding: the run's finding ("" = no finding check).
export function findingWhy(c, cfg, existing) {
  if (!c || !cfg || !cfg.finding) return { why: "" };
  const mark = findingMarker(cfg.finding);
  if (c.graphql) return { why: "post a note with gh issue comment or gh pr comment (or the REST comments endpoint), so the guard can read it" };
  if (c.edit) return { why: "a note is posted as a new comment, never by editing an earlier one" };
  if (c.body === null || c.body === undefined) return { why: "give the note's text with --body or --body-file <file> (not on stdin), so the guard can read it" };
  const marks = findingsIn(c.body);
  if (!marks.length) return { why: `every note of this run ends with this hidden line, exactly: ${mark}` };
  if (marks.some(f => f !== cfg.finding)) return { why: `this run's notes carry its own finding line and no other, exactly: ${mark}` };
  if (!c.repo || !c.number) return { why: "name the issue or pull request by its number, and the repository with -R <owner/repo>, so the guard can see what is already there" };
  let bodies;
  try { bodies = existing(c.repo, c.number, !!c.review); } catch (e) { return { why: `the notes already on ${c.repo}#${c.number} could not be read (${String(e.message).slice(0, 160)}); try again` }; }
  if (bodies.some(b => findingsIn(b).includes(cfg.finding))) return { unchanged: true, why: `unchanged: this finding is already on ${c.repo}#${c.number}, for the item in this same state, so nothing new is posted. Post nothing else about it.` };
  return { why: "" };
}

// ---------------------------------------------------------------- the guard
// cfg: {owner, finding, repo, realGh, realGit, cache}. -> {why, owner?, unchanged?}
export function decide(tool, args, cfg = {}, { env = process.env, cwd = process.cwd() } = {}) {
  const realGh = cfg.realGh || "/usr/bin/gh", realGit = cfg.realGit || "/usr/bin/git", cache = cfg.cache || "";
  const a = (args || []).map(String);
  if (tool === "gh") {
    const why = cfg.owner ? ownerWhy(ghIdentity({ env, realGh, cache, cwd }), cfg.owner) : "";
    if (why) return { why, owner: true };
    if (!cfg.finding) return { why: "" };
    const c = commentOf(a, cwd);
    if (c && c.number && !c.repo) {
      // no -R: the repository gh itself would post to (GH_REPO, else the folder's own remote)
      const r = run(realGh, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { env, cwd });
      c.repo = r.status === 0 && /^[\w.-]+\/[\w.-]+$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
    }
    return findingWhy(c, cfg, existingBodies({ env, realGh }));
  }
  if (tool === "git") {
    const g = gitCommand(a);
    const pushing = g.cmd ? g.cmd === "push" : a.includes("push");
    if (cfg.owner && pushing) {
      const why = ownerWhy(gitIdentity({ env, realGit, realGh, pre: g.cmd ? g.pre : [], cwd, cache }), cfg.owner);
      if (why) return { why, owner: true };
    }
    return { why: "" };
  }
  return { why: `${tool} is not a tool this guard knows` };
}
const mask = s => String(s).replace(/\b(gh[opsu]_|github_pat_)[\w.-]+/g, "$1***");
export function logRefusal(file, rec) {
  if (!file) return;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...rec })}\n`); } catch { /* the refusal itself still stands */ }
}
export function readGuardLog(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---------------------------------------------------------------- an acting run's GitHub (driver side)
// The repositories the run's App token covers: the item's own, the product's and the release records' (one owner).
export function runRepos(entry, a = {}) {
  const list = [entry && entry.repo, a.REPO, a.DEV_REPO].filter(r => /^[\w.-]+\/[\w.-]+$/.test(String(r || "")));
  const owner = list.length ? list[0].split("/")[0] : "";
  return [...new Set(list.filter(r => same(r.split("/")[0], owner)))];
}
// An App token for the repositories, made with the token script; the App keys are read here, for this one child, and never put
// into the run's environment. -> "" when none could be made (the run then has no GitHub login at all, never the owner's)
export function mintAppToken({ node = process.execPath, tokenScript = "", keysFile = "", app = "release", repos = [] } = {}, spawn = spawnSync) {
  const list = [...new Set((repos || []).filter(r => /^[\w.-]+\/[\w.-]+$/.test(String(r))))];
  if (!tokenScript || !list.length) return "";
  let keys;
  try { keys = Object.fromEntries(fs.readFileSync(keysFile, "utf8").split(/\r?\n/).map(l => /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^["']|["']$/g, "")])); } catch { return ""; }
  const sets = list.length > 1 ? [list, [list[0]]] : [list];
  for (const set of sets) {
    const r = spawn(node, [tokenScript, app, set.join(",")], { encoding: "utf8", timeout: 60000, env: { PATH: ROOT_PATH, ...keys } });
    const t = String((r && r.stdout) || "").trim();
    if (r && r.status === 0 && /^[\w.-]+$/.test(t)) return t;
  }
  return "";
}
// The environment's GitHub part (pure): the App token, an empty gh folder, no stored git credential helper, and one helper that
// hands git the same App token.
export const appVars = ({ ghDir, token = "", realGh = "/usr/bin/gh" }) => ({
  GH_CONFIG_DIR: ghDir, ...(token ? { GH_TOKEN: token } : {}), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0",
  // an empty credential.helper empties the list of helpers git collected from every file before it (root's own runs
  // gh auth git-credential, which would hand out the owner's login); the one after it reads GH_TOKEN, an App's. Without an App
  // token there is no helper at all: gh would fall back to a login kept in the system's keyring, which may be the owner's.
  GIT_CONFIG_COUNT: token ? "2" : "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
  ...(token ? { GIT_CONFIG_KEY_1: "credential.https://github.com.helper", GIT_CONFIG_VALUE_1: `!${bins(realGh).map(shq).join(" ")} auth git-credential` } : {}),
});
// a word for the shell git runs its helper with
const shq = s => (/^[\w./:@=+-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
// Makes the run's empty gh folder, its guard settings and the two shims in `dir`. -> {bin, vars}
export function prepareAppRun({ dir, token = "", owner = "", finding = "", repo = "", node = process.execPath, realGh = "/usr/bin/gh", realGit = "/usr/bin/git" }) {
  const ghDir = path.join(dir, "gh"), bin = path.join(dir, "bin"), cfgFile = path.join(dir, "guard.json");
  fs.mkdirSync(ghDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(bin, { recursive: true, mode: 0o755 });
  fs.writeFileSync(cfgFile, `${JSON.stringify({ owner, finding, repo, log: path.join(dir, "guard.log"), realGh, realGit, cache: path.join(dir, "guard-cache") }, null, 2)}\n`, { mode: 0o600 });
  for (const tool of ["gh", "git"]) fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec "${node}" "${GUARD_FILE}" --config "${cfgFile}" ${tool} "$@"\n`, { mode: 0o755 });
  return { bin, vars: appVars({ ghDir, token, realGh }) };
}

// ---------------------------------------------------------------- the obstacle (driver side)
export const AS_OWNER_MINUTES = 60;
// the same id obstacles.mjs obstacleId gives
const obstacleIdOf = (kind, key) => sha1(`${kind}\n${key}`).slice(0, 10);
// Every call refused because it would have acted as the owner in the last AS_OWNER_MINUTES: one obstacle for the acting runs and
// one for the factory helpers, with the latest refusals as evidence. dirs: {actDir, helpersDir}. -> obstacles
export function asOwnerObstacles(dirs, now = Date.now(), seen = {}) {
  const out = [];
  const since = now - AS_OWNER_MINUTES * 60000;
  for (const [key, dir, who] of [["acting runs", dirs.actDir, "an acting run"], ["factory helpers", dirs.helpersDir, "a factory helper"]]) {
    if (!dir) continue;
    let units = [];
    try { units = fs.readdirSync(dir); } catch { continue; }
    const hits = [];
    for (const unit of units) {
      const file = path.join(dir, unit, "guard.log");
      try { if (fs.statSync(file).mtimeMs < since) continue; } catch { continue; }
      for (const r of readGuardLog(file)) if (r.owner && Date.parse(r.at) >= since) hits.push({ ...r, unit });
    }
    if (!hits.length) continue;
    hits.sort((x, y) => String(x.at).localeCompare(String(y.at)));
    const id = obstacleIdOf("as-owner", key);
    out.push({ id, kind: "as-owner", since: seen[id] || hits[0].at, units: [...new Set(hits.map(h => h.unit))],
      evidence: [`${hits.length} call(s) of ${who} would have acted as the owner and were refused; nothing was posted or pushed under the owner's account`,
        ...hits.slice(-3).map(h => `${h.at} ${h.unit}: ${h.tool} ${String(h.args || "").slice(0, 160)}`)] });
  }
  return out;
}

// ---------------------------------------------------------------- the shim entry
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  let cfg = {}, rest = argv;
  if (argv[0] === "--config") {
    try { cfg = JSON.parse(fs.readFileSync(argv[1], "utf8")); } catch (e) { process.stderr.write(`owner guard: refused: its settings cannot be read (${e.message})\n`); process.exit(3); }
    rest = argv.slice(2);
  }
  const [tool, ...args] = rest;
  let d;
  try { d = decide(tool, args, cfg); } catch (e) { d = { why: `the guard failed (${String(e.message).slice(0, 200)}), so nothing goes through` }; }
  if (d.why) {
    process.stderr.write(`owner guard: refused: ${d.why}\n`);
    logRefusal(cfg.log, { tool, args: mask(args.join(" ")).slice(0, 400), why: d.why, ...(d.owner ? { owner: true } : {}), ...(d.unchanged ? { unchanged: true, finding: cfg.finding } : {}) });
    process.exit(3);
  }
  const [file, ...pre] = bins(tool === "gh" ? (cfg.realGh || "/usr/bin/gh") : (cfg.realGit || "/usr/bin/git"));
  const r = spawnSync(file, [...pre, ...args], { stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
}
