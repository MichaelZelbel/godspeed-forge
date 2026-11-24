#!/usr/bin/env node
// The release driver's gh/git guard (2026-11-15, D-418). The driver's AI run finds `gh` and `git`
// first on its PATH as two one-line shims that call this file; it lets through what the brief allows
// and refuses the rest with a plain reason (exit 3), recording every refusal in RD_GUARD_LOG.
//   gh   reads anything; writes only: comments, issues, pull requests, adding labels; every comment,
//        issue and pull request body carries the run's marker; never on the owner issue; never merge,
//        approve, close, release, workflows, repository settings. Since 2026-11-15 (D-419) an owner
//        decision or question is never posted by the run: it goes into the report, a second AI checks
//        it, and the driver posts it and removes needs-owner itself.
//   git  everything, except a push that forces, deletes, skips hooks, targets main/master/a tag/a
//        protected branch prefix, or carries a commit that changes a protected path.
// It is a backstop, not the boundary: the token is a builder-App token for one repository without
// the workflows permission, and the driver audits the run's commands afterwards (release-driver.mjs).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decide } from "../owner-guard.mjs";

export const PROTECTED_DEFAULT = ["MISSION.md", "FACTORY.md", "FACTORY_RULES.md", "harness/**", ".factory/**", "factory/**", ".claude/settings.json", ".ignore",
  "engineering.md", "AGENTS.md", "CLAUDE.md", ".github/**", ".archon/**", "stage.json"];

// "harness/**" covers harness/ and everything below; "a/b.md" only that file.
export function isProtected(file, globs = PROTECTED_DEFAULT) {
  const f = String(file).replace(/^\.\//, "");
  return globs.some(g => {
    const p = String(g).trim();
    if (!p) return false;
    if (p.endsWith("/**")) { const d = p.slice(0, -3); return f === d || f.startsWith(d + "/"); }
    if (p.includes("*")) { const re = new RegExp("^" + p.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$"); return re.test(f); }
    return f === p;
  });
}

const sameRepo = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

// ---------------------------------------------------------------- gh
const READ_GROUPS = { issue: ["view", "list", "status"], pr: ["view", "list", "diff", "checks", "status", "checkout"], run: ["view", "list", "watch", "download"],
  repo: ["view"], search: null, label: ["list"], status: null, browse: [] };

export function flagValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1] ?? "";
      if (n.startsWith("--") && args[i].startsWith(n + "=")) return args[i].slice(n.length + 1);
      if (!n.startsWith("--") && args[i].startsWith(n) && args[i].length > n.length) return args[i].slice(n.length);
    }
  }
  return null;
}
const has = (args, names) => args.some(a => names.some(n => a === n || (n.startsWith("--") && a.startsWith(n + "="))));
const readMaybe = (p, cwd) => { try { return fs.readFileSync(path.resolve(cwd || process.cwd(), p), "utf8"); } catch { return null; } };

// The text a body-carrying command would post: --body/-b, --body-file/-F, or (for gh api) every
// field and the --input file. null when it cannot be read.
export function bodyOf(args, cwd) {
  const b = flagValue(args, ["--body", "-b"]);
  if (b !== null) return b;
  const f = flagValue(args, ["--body-file", "-F"]);
  if (f !== null) return f === "-" ? null : readMaybe(f, cwd);
  return "";
}
export function apiPayload(args, cwd) {
  const parts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let v = null;
    if (["-f", "-F", "--field", "--raw-field"].includes(a)) v = args[i + 1];
    else if (/^--(raw-)?field=/.test(a)) v = a.slice(a.indexOf("=") + 1);
    else if (/^-[fF]./.test(a)) v = a.slice(2);
    if (v !== null && v !== undefined) {
      const eq = v.indexOf("=");
      const val = eq >= 0 ? v.slice(eq + 1) : v;
      if (val.startsWith("@")) { const t = val === "@-" ? null : readMaybe(val.slice(1), cwd); if (t === null) return null; parts.push(t); } else parts.push(val);
    }
    if (a === "--input" || a.startsWith("--input=")) {
      const p = a === "--input" ? args[i + 1] : a.slice(8);
      if (p === "-") return null;
      const t = readMaybe(p, cwd); if (t === null) return null; parts.push(t);
    }
  }
  return parts.join("\n");
}
// The "body" a REST write would post: its -f/-F body field, or the body of a JSON --input file.
// null when it cannot be read (stdin, a missing file, input that is not JSON), "" when there is none.
export function apiBody(args, cwd) {
  let body = "";
  // with --input the file is the request body and the fields go into the address (gh api's help)
  const input = args.some(a => a === "--input" || a.startsWith("--input="));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let v = null;
    if (["-f", "-F", "--field", "--raw-field"].includes(a)) v = args[i + 1];
    else if (/^--(raw-)?field=/.test(a)) v = a.slice(a.indexOf("=") + 1);
    else if (/^-[fF]./.test(a)) v = a.slice(2);
    if (!input && v !== null && v !== undefined && String(v).split("=")[0] === "body") {
      const val = String(v).slice(5);
      if (val.startsWith("@")) { const t = val === "@-" ? null : readMaybe(val.slice(1), cwd); if (t === null) return null; body = t; } else body = val;
    }
    if (a === "--input" || a.startsWith("--input=")) {
      const p = a === "--input" ? args[i + 1] : a.slice(8);
      if (p === "-") return null;
      const t = readMaybe(p, cwd); if (t === null) return null;
      try { const j = JSON.parse(t); body = j && typeof j.body === "string" ? j.body : ""; } catch { return null; }
    }
  }
  return body;
}

// what the loop and the manager read as authority: an owner decision or question, a manager decision,
// a contract, the reviewer's "Loop review:" (D-419: never from this run, which posts only plain notes)
const DECISION_LINE = /^[\s#>*_`~]*(owner\s+decision\b|owner\s+question\b|owner\s+repair\b|manager\s+decision\b|loop\s+review\s*:|contract\s*(?:[:*_`#~]|$))/i;
// read on the body's first non-empty line, the way the loop reads a comment's heading
export const DECISION_BODY = { test: body => DECISION_LINE.test((String(body || "").split("\n").find(l => l.trim()) || "").trim()) };
const DECISION_WHY = "nothing this run writes may be headed `Owner decision`, `Owner question` or `Owner repair` (those are Michael's words, never ours); the driver posts a `Manager decision (Mission Control, not Michael)` itself, after a second check (put the text in your report's `decision`); reviews, contracts and manager decisions are the loop's, never this run's";
const OWNER_COMMIT = /^[\s#>*_`~]*owner\s+(?:decision|question|repair)\b/i; // a commit subject headed as Michael's own
const LABEL_WHY = "the driver removes needs-owner itself, once it has posted your decision";
// -> "" when allowed, else the reason. ctx: {repo, marker, ownerIssue, cwd}
export function checkGh(args, ctx) {
  const a = args.filter(x => x !== undefined);
  const repoFlag = flagValue(a, ["--repo", "-R"]);
  if (repoFlag !== null && !sameRepo(repoFlag.replace(/^https:\/\/github\.com\//, ""), ctx.repo)) return `only ${ctx.repo} may be used, not ${repoFlag}`;
  const [group, sub, ...rest] = a;
  if (!group || group === "--version" || group === "version" || group === "help" || group === "--help") return "";
  if (group === "auth") return sub === "status" ? "" : "gh auth is not available in this run (no token printing, no login changes)";
  if (group === "api") return checkApi(a.slice(1), ctx);
  const needsMarker = (what) => { const body = bodyOf(a, ctx.cwd); if (body === null) return `the ${what} body must be given with --body or --body-file <file>, so the guard can read it`; return body.includes(ctx.marker) ? "" : `every ${what} must contain the marker ${ctx.marker}`; };
  const issueNumber = () => (rest.find(x => /^#?\d+$/.test(x)) || "").replace("#", "") || (/\/(issues|pull)\/(\d+)/.exec(rest.find(x => /github\.com/.test(x)) || "") || [])[2];
  if (group === "issue" || group === "pr") {
    if ((READ_GROUPS[group] || []).includes(sub)) return "";
    if (sub === "comment") {
      if (has(a, ["--edit-last", "--delete-last"])) return "editing or deleting comments is not allowed";
      if (group === "issue" && Number(issueNumber()) === Number(ctx.ownerIssue)) return `the driver itself notes on the owner issue #${ctx.ownerIssue}; do not post there`;
      const text = bodyOf(a, ctx.cwd);
      if (text !== null && DECISION_BODY.test(text)) return DECISION_WHY;
      return needsMarker("comment");
    }
    if (sub === "create") {
      if (group === "pr") { const base = flagValue(a, ["--base", "-B"]); if (base && base !== "main") return "a pull request from this run goes into main"; }
      return needsMarker(group === "pr" ? "pull request" : "issue");
    }
    if (sub === "edit") {
      const allowed = ["--add-label", "--remove-label", "--repo", "-R"];
      for (let i = 0; i < rest.length; i++) {
        const x = rest[i];
        if (!x.startsWith("-")) continue;
        const name = x.includes("=") ? x.slice(0, x.indexOf("=")) : x;
        if (!allowed.includes(name)) return `gh ${group} edit may only add labels or remove needs-owner (not ${name})`;
        const val = x.includes("=") ? x.slice(x.indexOf("=") + 1) : rest[i + 1];
        if (name === "--remove-label") return String(val).split(",").some(l => l.trim() === "needs-owner") ? LABEL_WHY : "this run removes no labels";
        if (!x.includes("=")) i++;
      }
      return "";
    }
    if (group === "pr" && sub === "update-branch") return has(a, ["--rebase"]) ? "never rebase a pull request branch" : "";
    return `gh ${group} ${sub || ""} is not allowed in this run (no merge, approve, review, close, reopen, ready or delete)`.replace(/\s+/g, " ");
  }
  if (group in READ_GROUPS) { const ok = READ_GROUPS[group]; return ok === null || ok.includes(sub) ? "" : `gh ${group} ${sub || ""} is not allowed in this run`.trim(); }
  return `gh ${group} is not allowed in this run (only issues, pull requests, comments, labels and reads)`;
}

function checkApi(args, ctx) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (["-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache", "-p", "--preview"].includes(x)) { i++; continue; }
    if (x.startsWith("-")) continue;
    positional.push(x);
  }
  const endpoint = String(positional[0] || "").replace(/^https:\/\/api\.github\.com\//, "").replace(/^\//, "");
  const explicit = flagValue(args, ["-X", "--method"]);
  const fields = has(args, ["-f", "-F", "--field", "--raw-field", "--input"]) || args.some(x => /^-[fF]./.test(x));
  const method = (explicit || (fields ? "POST" : "GET")).toUpperCase(); // gh api: POST as soon as a field is given
  if (endpoint === "graphql") {
    const text = apiPayload(args, ctx.cwd);
    if (text === null) return "a GraphQL request must be given as fields or a readable --input file, not stdin";
    // reads only: a mutation names its target by node id, which the guard cannot check; every write
    // this run needs has a gh command or a REST call the guard does check (gh's own commands make
    // their GraphQL writes inside the real gh, after this check)
    return /\bmutation\b/i.test(text) ? "GraphQL mutations are not allowed in this run; use gh issue/pr comment, gh issue/pr edit --add-label/--remove-label needs-owner, gh issue/pr create" : "";
  }
  if (method === "GET" || method === "HEAD") return "";
  const m = /^repos\/([^/]+\/[^/]+)\/(.+?)(\?.*)?$/.exec(endpoint);
  if (!m) return `gh api ${method} ${endpoint} is not allowed in this run`;
  if (!sameRepo(m[1], ctx.repo)) return `only ${ctx.repo} may be written to`;
  const rest = m[2];
  const payload = () => apiPayload(args, ctx.cwd);
  let r;
  if (method === "POST" && (r = /^issues\/(\d+)\/comments$/.exec(rest))) {
    if (Number(r[1]) === Number(ctx.ownerIssue)) return `the driver itself notes on the owner issue #${ctx.ownerIssue}; do not post there`;
    const b = apiBody(args, ctx.cwd);
    if (b !== null && DECISION_BODY.test(b)) return DECISION_WHY;
    return b !== null && b.includes(ctx.marker) ? "" : `every comment's body must contain the marker ${ctx.marker}`;
  }
  if (method === "POST" && /^issues\/\d+\/labels$/.test(rest)) return "";
  if (method === "DELETE" && (r = /^issues\/\d+\/labels\/(.+)$/.exec(rest))) return decodeURIComponent(r[1]) === "needs-owner" ? LABEL_WHY : "this run removes no labels";
  if (method === "POST" && (rest === "issues" || rest === "pulls")) {
    const t = payload(), b = apiBody(args, ctx.cwd);
    if (t === null || b === null || !b.includes(ctx.marker)) return `every issue's and pull request's body must contain the marker ${ctx.marker}`;
    if (rest === "pulls" && (/"base"\s*:\s*"(?!main")/.test(t) || args.some(x => /^base=(?!main$)/.test(String(x))))) return "a pull request from this run goes into main";
    return "";
  }
  return `gh api ${method} ${rest} is not allowed in this run (no merge, review, workflow, ref, setting or edit)`;
}

// ---------------------------------------------------------------- git
const FORBIDDEN_PUSH_FLAGS = ["-f", "--force", "--force-with-lease", "--force-if-includes", "--mirror", "--all", "--branches", "--tags", "--follow-tags", "--delete", "-d", "--no-verify",
  "--prune", "-o", "--push-option", "--repo", "--receive-pack", "--exec"];
// settings that would change where or what a push sends, or what runs: never set in this run
export const GIT_SETTINGS = /core\.hooksPath|core\.sshCommand|credential\.|insteadOf|(^|[\s=])(url|remote|push|branch|alias)\./i;
// git commands that write to a remote other than push (plumbing and the transport helpers)
export const GIT_SENDING = new Set(["send-pack", "http-push", "remote-http", "remote-https", "remote-ftp", "remote-ftps", "receive-pack", "remote-ext", "remote-fd", "bundle-uri", "p4", "svn", "cvsexportcommit"]);
export const PROTECTED_BRANCH = /^(main|master|gh-pages|candidate\/.*|release-step\/.*|owner\/.*|refs\/tags\/.*|.*\.lock)$/;

// args: the push's arguments. git(argv) -> {status, stdout}. -> "" or the reason.
export function checkPush(args, ctx, git) {
  for (const x of args) {
    const name = x.includes("=") ? x.slice(0, x.indexOf("=")) : x;
    if (FORBIDDEN_PUSH_FLAGS.includes(name) || /^-[a-z]*f[a-z]*$/.test(x) && x.startsWith("-") && !x.startsWith("--")) return `git push ${name} is not allowed (no force, delete, mirror, tags or skipped hooks)`;
  }
  const pos = args.filter(x => !x.startsWith("-"));
  const remote = pos[0] || "origin";
  if (remote !== "origin") return "push only to origin";
  const repoUrl = new RegExp(`^https://github\\.com/${ctx.repo.replace(/[.]/g, "\\.")}(\\.git)?$`, "i");
  for (const which of [["remote", "get-url", "origin"], ["remote", "get-url", "--push", "--all", "origin"]]) {
    const urls = (git(which).stdout || "").split("\n").map(s => s.trim()).filter(Boolean);
    if (!urls.length || urls.some(u => !repoUrl.test(u))) return `origin is not ${ctx.repo} (its fetch and push addresses must both be it)`;
  }
  const specs = pos.slice(1);
  if (!specs.length) return "name the branch: git push origin <branch> (what a bare push sends depends on settings)";
  for (const spec of specs) {
    if (spec.startsWith("+")) return "no forced refspecs";
    if (spec.startsWith(":")) return "no deleting branches";
    const [src, dst0] = spec.includes(":") ? spec.split(":") : [spec, spec];
    const dst = String(dst0).replace(/^refs\/heads\//, "");
    if (/^refs\//.test(dst) || PROTECTED_BRANCH.test(dst)) return `pushing to ${dst} is not allowed (only pull request branches and release-driver/... branches)`;
    const local = (git(["rev-parse", "--verify", `${src}^{commit}`]).stdout || "").trim();
    if (!local) return `cannot read ${src}`;
    const remoteLine = (git(["ls-remote", "origin", `refs/heads/${dst}`]).stdout || "").trim();
    const remoteSha = remoteLine.split(/\s+/)[0] || "";
    if (!remoteSha && !/^release-driver\//.test(dst)) return `a new branch from this run is named release-driver/<topic>, not ${dst}`;
    const known = remoteSha && git(["cat-file", "-e", `${remoteSha}^{commit}`]).status === 0;
    if (remoteSha && !known) return `fetch ${dst} first (its remote head is not in this clone)`;
    if (remoteSha && git(["merge-base", "--is-ancestor", remoteSha, local]).status !== 0) return `${dst} on GitHub has commits this push would drop`;
    // main as GitHub has it, never the clone's own origin/main (a local ref can be moved)
    const mainSha = ((git(["ls-remote", "origin", "refs/heads/main"]).stdout || "").trim().split(/\s+/)[0]) || "";
    if (!mainSha || git(["cat-file", "-e", `${mainSha}^{commit}`]).status !== 0) return "fetch main first (GitHub's main is not in this clone)";
    const commits = (git(["rev-list", local, "--not", ...(remoteSha ? [remoteSha] : []), mainSha]).stdout || "").split("\n").map(s => s.trim()).filter(Boolean);
    for (const c of commits) {
      // a commit titled the way Michael's own would be read as his word (2026-11-19: "Owner repair: ..." was reported by the loop as "the owner fixed it personally")
      const subject = (git(["log", "-1", "--format=%s", c]).stdout || "").split(/\r?\n/)[0];
      if (OWNER_COMMIT.test(subject)) return `commit ${c.slice(0, 8)} is titled "${subject.slice(0, 60)}": a commit from this run starts with "Mission Control repair:", never "Owner ..." (that is Michael's word, not ours)`;
      const parents = (git(["rev-list", "--parents", "-n", "1", c]).stdout || "").trim().split(/\s+/).slice(1);
      const blob = (rev, f) => (git(["rev-parse", "--verify", "-q", `${rev}:${f}`]).stdout || "").trim();
      let bad;
      if (parents.length > 1) { // a merge: a protected file may only come out exactly as one merged side had it
        const changed = (git(["diff", "--name-only", parents[0], c]).stdout || "").split("\n").filter(Boolean);
        bad = changed.filter(f => isProtected(f, ctx.protected) && !parents.slice(1).some(p => blob(p, f) === blob(c, f)));
      } else bad = (git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", c]).stdout || "").split("\n").filter(Boolean).filter(f => isProtected(f, ctx.protected));
      if (bad.length) return `commit ${c.slice(0, 8)} changes protected paths (${bad.slice(0, 5).join(", ")}); this run may not change them`;
    }
  }
  return "";
}

// git's own options before the command. Only -C and -c (checked) take a value here, and only the
// harmless ones without a value pass: anything else (--config-env, --git-dir, --exec-path, an
// attached -cx=y) could hide the command or change what it does, so it is refused.
const GIT_FLAGS = new Set(["--no-pager", "-P", "-p", "--paginate", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs",
  "--icase-pathspecs", "--no-optional-locks", "--no-advice", "--bare", "--version", "--help", "-v", "-h", "--html-path", "--man-path", "--info-path"]);
export function gitCommand(args) {
  const pre = []; let i = 0;
  while (i < args.length && String(args[i]).startsWith("-")) {
    const x = args[i];
    if (x === "-C" || x === "-c") {
      // Codex itself runs `git -c core.hooksPath=/dev/null ...` to read the repository: switching
      // hooks off changes nothing this guard relies on, so that one setting passes
      if (x === "-c" && GIT_SETTINGS.test(String(args[i + 1])) && !/^core\.hooksPath=\/dev\/null$/i.test(String(args[i + 1]))) return { pre, cmd: null, rest: [], why: "git -c may not change hooks, credentials, remotes, push settings or aliases" };
      pre.push(x, args[i + 1]); i += 2; continue;
    }
    if (!GIT_FLAGS.has(x)) return { pre, cmd: null, rest: [], why: `the git option ${String(x).split("=")[0]} is not allowed in this run` };
    pre.push(x); i++;
  }
  return { pre, cmd: args[i], rest: args.slice(i + 1), why: "" };
}

// ---------------------------------------------------------------- the shim entry
function refuse(why, tool, args, extra = {}) {
  process.stderr.write(`release-driver guard: refused: ${why}\n`);
  try { if (process.env.RD_GUARD_LOG) fs.appendFileSync(process.env.RD_GUARD_LOG, JSON.stringify({ at: new Date().toISOString(), tool, args: args.join(" ").slice(0, 400), why, ...extra }) + "\n"); } catch {}
  process.exit(3);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [tool, ...args] = process.argv.slice(2);
  const ctx = { repo: process.env.RD_REPO || "", marker: process.env.RD_MARKER || "", ownerIssue: process.env.RD_OWNER_ISSUE || "", cwd: process.cwd(),
    protected: (process.env.RD_PROTECTED || "").split(",").map(s => s.trim()).filter(Boolean) };
  if (!ctx.protected.length) ctx.protected = PROTECTED_DEFAULT;
  const real = tool === "gh" ? (process.env.RD_REAL_GH || "/usr/bin/gh") : (process.env.RD_REAL_GIT || "/usr/bin/git");
  if (tool !== "gh" && tool !== "git") refuse("unknown tool", String(tool), args);
  if (!ctx.repo || !ctx.marker) refuse("the guard has no repository or marker set", tool, args);
  // never as the owner (issue #152): a call whose login is the owner's own is refused before anything else and logged with
  // owner: true, which the factory driver turns into an obstacle; a note whose finding is already on its item is refused as
  // unchanged (owner-guard.mjs, the same check the acting runs' gh and git go through)
  if (process.env.RD_OWNER_LOGIN || process.env.RD_FINDING) {
    const d = decide(tool, args, { owner: process.env.RD_OWNER_LOGIN || "", finding: process.env.RD_FINDING || "", repo: ctx.repo, realGh: process.env.RD_REAL_GH || "/usr/bin/gh", realGit: real,
      cache: process.env.RD_GUARD_LOG ? path.join(path.dirname(process.env.RD_GUARD_LOG), "guard-cache") : "" });
    if (d.why) refuse(d.why, tool, args, { ...(d.owner ? { owner: true } : {}), ...(d.unchanged ? { unchanged: true, finding: process.env.RD_FINDING } : {}) });
  }
  if (tool === "gh") { const why = checkGh(args, ctx); if (why) refuse(why, tool, args); }
  else {
    const { pre, cmd, rest, why: preWhy } = gitCommand(args);
    if (preWhy) refuse(preWhy, tool, args);
    if (cmd === "push") {
      const gitRun = argv => { const r = spawnSync(real, [...pre, ...argv], { encoding: "utf8" }); return { status: r.status, stdout: r.stdout || "" }; };
      const why = checkPush(rest, ctx, gitRun);
      if (why) refuse(why, tool, args);
    }
    const reading = rest.some(x => ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin"].includes(x));
    if (cmd === "config" && !reading && rest.some(x => GIT_SETTINGS.test(x))) refuse("git config may not change hooks, credentials, remotes, push settings or aliases", tool, args);
    if (cmd === "remote" && ["set-url", "add", "rename", "remove", "rm"].includes(rest[0])) refuse("the remotes of this clone stay as they are", tool, args);
    if (GIT_SENDING.has(cmd)) refuse(`git ${cmd} sends to a remote around git push; use git push origin <branch>`, tool, args);
  }
  const r = spawnSync(real, args, { stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
}
