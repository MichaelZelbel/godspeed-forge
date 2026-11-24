// Read the world once per round (factory driver, Task 1). Anything that cannot be read goes into
// `unreadable`; nothing is concluded from missing data. All outside access is injected (deps), so the
// tests run without GitHub or the server.
import fs from "node:fs";
import path from "node:path";
import { GODSPEED_RELEASE } from "./journal.mjs";
import { readReleases, pickPlans, itemIssues, releaseLabel, planRepository, excludedIssues, requiredState, compareVersions, releaseVersion } from "./release-driver/release-driver.mjs";
import { deliveryClaims, alreadyQuery, claimMerges, onMain } from "./delivery.mjs";

// a unit this driver replaced (settings legacy_units, with or without .service/.timer) belongs to the old program, not to the factory
// ONE predicate, used wherever a unit is started, restarted, re-enabled or turned into an obstacle: an entry with .service or .timer
// names that unit; an entry without a suffix covers both its .service and its .timer.
export const legacyEntries = env => (Array.isArray(env.LEGACY_UNITS) ? env.LEGACY_UNITS : String(env.LEGACY_UNITS || "").split(",")).map(x => String(x).trim()).filter(Boolean);
export const isLegacy = (env, unit) => { const u = String(unit || "").trim(); return legacyEntries(env).some(l => l === u || `${l}.service` === u || `${l}.timer` === u); };
const iso = v => (v ? new Date(v).toISOString() : null);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

export const defaultsFor = (e = process.env) => ({
  REPO: e.FD_REPO || "owner/repository",
  RELEASES_DIR: e.FD_RELEASES_DIR || "",
  AUTO_STAGE_STATE: e.FD_AUTO_STAGE_STATE || "/var/lib/godspeed/forge/driver/steps/stage/state.json",
  // The factory's main project (the one releases come from); every other archonfactory-<project>.timer
  // of the factory user is read too (Querino joined on 2026-11-18, D-425).
  PROJECT: e.FD_PROJECT || "repository",
  FORGE_HOME: e.FD_FORGE_HOME || "/home/factory",
  // each project's checkout as its settings name it ({ project: folder }); a project the settings do not name is <FORGE_HOME>/<project>
  PROJECT_CHECKOUTS: (() => { try { const v = JSON.parse(e.FD_PROJECT_CHECKOUTS || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } })(),
  // A fixed command for the runs (tests); unset, each project's own Archon CLI is asked, the way the
  // factory itself asks it (factory/consumer.py native_json: bun <source>/packages/cli/src/cli.ts).
  ARCHON_RUNS: e.FD_ARCHON_RUNS || "",
  SCENARIOS_WORKFLOW: e.FD_SCENARIOS_WORKFLOW || "scenarios.yml",
  // long-running units of the factory that must run: one that is enabled but stopped counts as down
  // (a plain stop leaves it inactive, not failed, and its own Restart=on-failure does not bring it back)
  LEGACY_UNITS: String(e.FD_LEGACY_UNITS || "").split(",").map(x => x.trim()).filter(Boolean), // units this driver replaces: never a factory timer, never must-run, never an obstacle
  NETNS_GUARD: e.FD_NETNS_GUARD || "",
  MUST_RUN: String(e.FD_MUST_RUN || "").split(",").map(x => x.trim()).filter(Boolean).filter(u => !isLegacy({ LEGACY_UNITS: String(e.FD_LEGACY_UNITS || "").split(",").map(x => x.trim()).filter(Boolean) }, u)),
  FORGE_UID: e.FD_FORGE_UID || e.FORGE_UID || "1000",
  STALE_MINUTES: Number(e.FD_STALE_MINUTES || 180),
  QUESTIONS_DIR: e.FD_QUESTIONS_DIR || "/var/lib/godspeed/forge/questions",
  TO_OWNER_FILE: e.FD_TO_OWNER_FILE || "to-owner.json", // where the queue worker lists what it handed to the owner (steps.questions.to_owner_file)
  // The test machine's own module: its toolCoverage() says which hidden checks have no tool that can run
  // (2026-11-18: the driver never saw a missing tool; only Michael was told, by the test machine).
  TM_MODULE: e.FD_TM_MODULE || "",
  // the builder and release Apps, whose comment on a closed issue may name where its work is on main (delivery.mjs)
  APPS: [e.FD_BUILDER_APP, e.FD_RELEASE_APP].filter(Boolean),
});

const realDeps = env => ({
  readFile: p => fs.readFileSync(p, "utf8"),
  mtime: p => fs.statSync(p).mtimeMs,
  readDir: p => fs.readdirSync(p),
  readReleases: (dir, autoStage) => readReleases(dir, autoStage, GODSPEED_RELEASE),
});

// ------------------------------------------------------------ tickets
const SIZES = { s: "s", small: "s", m: "m", medium: "m", l: "l", large: "l" };
// "Size: large." in a ticket's header decides the size; otherwise "m".
export function ticketSize(text) {
  const head = String(text || "").split(/\r?\n/).slice(0, 12).join("\n");
  const m = /\bsize:\s*(s|m|l|small|medium|large)\b/i.exec(head);
  return m ? SIZES[m[1].toLowerCase()] : "m";
}
// The tickets a release's scope-amendment.json moved to the next release (a person's flat entry and
// every entry of its `amendments`); the driver never drives them for this release.
export function deferredTickets(text) {
  let f; try { f = JSON.parse(text); } catch { return []; }
  if (!f || typeof f !== "object") return [];
  return [...(Array.isArray(f.deferredTickets) ? f.deferredTickets : []),
    ...(Array.isArray(f.amendments) ? f.amendments.flatMap(a => (a && Array.isArray(a.deferredTickets) ? a.deferredTickets : [])) : [])].map(n => path.posix.basename(String(n)));
}
export function readTickets(rel, deps) {
  const root = String(rel.dir || "").replace(/\\/g, "/");
  const dir = path.posix.join(root, "tickets");
  const issues = itemIssues(rel.plan);
  let moved = []; try { moved = deferredTickets(deps.readFile(path.posix.join(root, "scope-amendment.json"))); } catch { /* none */ }
  let files = [];
  try { files = deps.readDir(dir).filter(f => f.endsWith(".md")).sort(); } catch { return []; }
  const out = [];
  for (const file of files) {
    const m = /^(\d+)[-_]/.exec(file);
    if (!m) continue;
    const item = Number(m[1]);
    let text = ""; try { text = deps.readFile(path.posix.join(dir, file)); } catch { /* size defaults */ }
    const h = /^#\s+(.+)$/m.exec(text);
    out.push({ file, item, issue: issues[item] || null, title: h ? h[1].trim() : file.replace(/\.md$/, ""), size: ticketSize(text), deferred: moved.includes(file) });
  }
  return out;
}

// ------------------------------------------------------------ GitHub
const comments = rows => (Array.isArray(rows) ? rows : []).map(c => ({ author: c.user ? c.user.login : "", body: String(c.body || ""), at: iso(c.created_at) }));
const labelNames = x => ((x && x.labels) || []).map(l => (typeof l === "string" ? l : l.name));

function readPr(env, deps, n, unreadable) {
  const part = `pr#${n}`;
  try {
    const p = deps.gh([`repos/${env.REPO}/pulls/${n}`]);
    const sha = p.head && p.head.sha;
    let lastCommitAt = null, requiredSt = { state: "none" };
    if (sha) {
      const c = deps.gh([`repos/${env.REPO}/commits/${sha}`]);
      lastCommitAt = iso(c && c.commit && ((c.commit.committer || {}).date || (c.commit.author || {}).date));
      const runs = (deps.gh([`repos/${env.REPO}/commits/${sha}/check-runs?check_name=required&filter=all&per_page=100`]) || {}).check_runs || [];
      requiredSt = requiredState(runs);
    }
    return {
      number: n, state: String(p.state || "").toLowerCase(), merged: !!p.merged_at, mergedAt: iso(p.merged_at), mergeSha: p.merge_commit_sha || null, base: (p.base && p.base.ref) || null, createdAt: iso(p.created_at), labels: labelNames(p),
      headSha: sha || null, lastCommitAt, requiredState: requiredSt.state, requiredSince: iso(requiredSt.at),
      comments: comments(deps.gh([`repos/${env.REPO}/issues/${n}/comments?per_page=50`])),
    };
  } catch (e) { unreadable.push({ part, error: e.message }); return null; }
}

// The loop's claims on a work item (a comment starting "Loop claim: run <id>"; a run that ends edits it to "released" or
// "withdrawn", so the ones that still start that way are the live ones). The first 50 comments and the newest 30 are read, and a
// comment in both is counted once. -> [{run, at}], newest last
export const CLAIM_PREFIX = /^Loop claim: run (\S+)/;
export function loopClaimsOf(comments) {
  const seen = new Set(), out = [];
  for (const c of comments || []) {
    const m = CLAIM_PREFIX.exec(String(c.body || ""));
    if (!m || !c.at) continue;
    const k = `${m[1]}@${c.at}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push({ run: m[1], at: c.at });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function readItem(env, deps, n, unreadable) {
  let issue;
  try { issue = deps.gh([`repos/${env.REPO}/issues/${n}`]); } catch (e) { unreadable.push({ part: `issue#${n}`, error: e.message }); return null; }
  const item = { number: n, mergedRefs: [], state: String(issue.state || "").toLowerCase(), stateReason: issue.state_reason ? String(issue.state_reason).toLowerCase() : null, labels: labelNames(issue), closedAt: iso(issue.closed_at), prs: [], comments: [], partial: false };
  try { item.comments = comments(deps.gh([`repos/${env.REPO}/issues/${n}/comments?per_page=50`])); }
  catch (e) { unreadable.push({ part: `issue#${n}/comments`, error: e.message }); item.partial = true; }
  item.loopClaims = loopClaimsOf(item.comments);
  let nums = [], appComments;
  try {
    // the issue's newest 30 comments with their authors' type: the same window and shape the release step reads (auto-stage.mjs)
    const q = `query { repository(owner: ${JSON.stringify(env.REPO.split("/")[0])}, name: ${JSON.stringify(env.REPO.split("/")[1])}) { issue(number: ${n}) { closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number } } timelineItems(last: 40, itemTypes: [CONNECTED_EVENT]) { nodes { ... on ConnectedEvent { subject { __typename ... on PullRequest { number } } } } } refs: timelineItems(last: 60, itemTypes: [CROSS_REFERENCED_EVENT]) { nodes { ... on CrossReferencedEvent { source { __typename ... on PullRequest { number merged mergedAt baseRefName mergeCommit { oid } repository { nameWithOwner } } } } } } comments(last: 30) { nodes { body createdAt author { __typename login } } } } } }`;
    const d = deps.gh(["graphql", "-f", `query=${q}`]);
    const i = d.data.repository.issue;
    nums = [...new Set([...i.closedByPullRequestsReferences.nodes.map(x => x.number), ...i.timelineItems.nodes.filter(e => e && e.subject && e.subject.number).map(e => e.subject.number)])];
    // a merged pull request that only mentions the issue (seen live: #679 closed by #714, which does not
    // close it by keyword): the item's change is on main, so it is never a dead end. Only one of this repository merged into
    // main counts: one merged elsewhere is not the item on main, and the release step would wait for a cut the driver never makes
    const same = p => !p.repository || String(p.repository.nameWithOwner || "").toLowerCase() === String(env.REPO).toLowerCase();
    const refs = ((i.refs && i.refs.nodes) || []).filter(e => e && e.source && e.source.__typename === "PullRequest" && e.source.merged).map(e => e.source)
      .filter(p => same(p) && (!p.baseRefName || p.baseRefName === "main"));
    item.mergedRefs = [...new Set(refs.map(p => p.number))];
    // their merges into main, newest first: rung 0 writes the ticket's done line from one, so the release step counts it done too
    item.mergedRefMerges = refs.filter(p => p.mergeCommit && p.mergeCommit.oid && p.baseRefName === "main" && p.repository).map(p => ({ number: p.number, commit: p.mergeCommit.oid, mergedAt: p.mergedAt })).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
    appComments = i.comments && Array.isArray(i.comments.nodes) ? i.comments.nodes : undefined;
    item.loopClaims = loopClaimsOf([...item.comments.map(c => ({ body: c.body, at: c.at })), ...(appComments || []).map(c => ({ body: c.body, at: iso(c.createdAt) }))]);
  } catch (e) { unreadable.push({ part: `issue#${n}/prs`, error: e.message }); item.partial = true; }
  for (const pn of nums) { const p = readPr(env, deps, pn, unreadable); if (p) item.prs.push(p); else item.partial = true; }
  readDelivery(env, deps, item, appComments, unreadable);
  return item;
}
// An issue closed as completed with no merged change linked to it: the builder or release App's comment may name where its work
// is on main ("Delivered by <pull request URL>", "Already delivered on main by #N"), read exactly as the release step reads it
// (delivery.mjs), from the same comments, so the two never disagree. item.claims: how many such comments (left unset when the
// comments were not read: then nothing is concluded from their absence); item.delivered: the newest merge they prove.
function readDelivery(env, deps, item, comments, unreadable) {
  if (item.state !== "closed" || (item.stateReason && item.stateReason !== "completed") || item.prs.some(onMain) || item.mergedRefs.length || !comments) return;
  const claims = deliveryClaims(comments, { repo: env.REPO, apps: env.APPS });
  item.claims = claims.length;
  if (!claims.length) return;
  try {
    const d = deps.gh(["graphql", "-f", `query=${alreadyQuery(env.REPO, claims.map(c => c.number))}`]);
    const data = d && d.data && d.data.repository;
    if (!data) throw new Error("GitHub gave no answer about the delivery the App named");
    const merges = claims.flatMap(c => claimMerges(c, data[`a${c.number}`], env.REPO, item.number)).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
    if (merges.length) item.delivered = merges[0];
  } catch (e) { unreadable.push({ part: `issue#${item.number}/delivery`, error: e.message }); item.partial = true; }
}

// ------------------------------------------------------------ factory and server
// "2026-11-18T05:01:19+01:00 host python3[692609]: No launch: workable nothing; ..." -> {at, text}
export function parseDecisions(journal) {
  const out = [];
  for (const line of String(journal || "").split(/\r?\n/)) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+(?:[+-]\d\d:?\d\d|Z))\s+\S+\s+[^\s:]+?(?:\[\d+\])?:\s+(.*)$/.exec(line);
    if (m && /\b(No launch|nothing to start|launch(ed)?\b)/i.test(m[2]) && !/"launch"/.test(m[2])) out.push({ at: iso(m[1]), text: m[2].trim() });
  }
  return out;
}
// Archon's `workflow runs --json`: {runs: [{id, status, started_at, last_activity_at, ...}], total, counts}
// (read live on the server, 2026-11-18). Active is what the factory itself counts as active
// (consumer.py ACTIVE: pending, running, paused).
export function parseRuns(text) {
  let rows = null;
  try { const j = JSON.parse(text); rows = Array.isArray(j) ? j : (j.runs || null); } catch { /* not JSON */ }
  if (!rows) return [];
  return rows.filter(r => !r.status || /^(pending|running|paused|active|in.progress)$/i.test(String(r.status)))
    .map(r => ({ id: String(r.id || r.runId || ""), workflow: r.workflow_name || null, startedAt: iso(r.startedAt || r.started_at || r.createdAt),
      lastOutputAt: iso(r.lastOutputAt || r.last_output_at || r.last_activity_at || r.updatedAt || r.updated_at) }))
    .filter(r => r.id);
}
// `systemctl --user list-unit-files 'archonfactory-*.timer'` -> the projects, the main one first.
export function parseProjects(text, main) {
  const out = [main];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^archonfactory-([A-Za-z0-9_.-]+?)\.timer\b/.exec(line.trim());
    if (m && !/-manager$/.test(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
// The stage step's STOP: its first line names "auto-stage" (the program the step grew out of), or "stage" once
// somebody relabelled it (a helper did on 2026-11-24, which hid it from the step and from housekeeping both).
export const STAGE_WRITER = /^(auto-stage|stage)$/;
export const isStageStop = st => !!st && STAGE_WRITER.test(String(st.writer || ""));
// Whether the process <args> (ps -o args=) is the writer the STOP names. The stage step runs as
// `node .../driver.mjs --step stage ...`, so its STOP's "auto-stage" is never in its command line: reading
// it that way called a running step's STOP abandoned and sent a helper to "repair" it (2026-11-24).
export function writerRuns(writer, args) {
  const a = String(args || ""), w = String(writer || "");
  if (!w) return false;
  if (STAGE_WRITER.test(w)) return a.includes("auto-stage") || (/\bdriver\.mjs\b/.test(a) && /(^|\s)--step\s+stage(\s|$)/.test(a));
  return a.includes(w);
}
// A STOP or PAUSE file's first line: "<writer> <pid> <iso time>" (auto-stage's), or anything else.
export function parseStop(text, mtimeMs) {
  const line = String(text || "").split(/\r?\n/)[0].trim();
  const tok = line.split(/\s+/);
  const pid = /^\d+$/.test(tok[1] || "") ? Number(tok[1]) : null;
  const stamped = tok[2] && Number.isFinite(Date.parse(tok[2]));
  return { line, writer: tok[0] || null, pid, at: stamped ? tok[2] : iso(mtimeMs) };
}
// `systemctl show -p Id -p ActiveState -p LoadState a b` -> {unit: ActiveState}; a unit that does not
// exist (LoadState not-found) is no timer at all.
export function parseShow(text) {
  const out = {};
  for (const block of String(text || "").split(/\r?\n\s*\r?\n/)) {
    const kv = Object.fromEntries(block.split(/\r?\n/).map(l => /^(\w+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m => [m[1], m[2]]));
    if (kv.Id && kv.LoadState !== "not-found") out[kv.Id] = kv.ActiveState || "unknown";
  }
  return out;
}
const repoOf = url => { const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(String(url || "").trim()); return m ? m[1] : null; };
const q = s => `'${String(s).replace(/'/g, "'\\''")}'`;
export function parseStale(psText, activeIds, minMinutes) {
  const out = [];
  for (const line of String(psText || "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line); // pid user etimes ppid args
    if (!m) continue;
    const [, pid, user, et, , cmd] = m;
    const ageMin = Math.floor(Number(et) / 60);
    if (ageMin >= minMinutes && /standin_ai\.py|chromium|main\.mjs/.test(cmd) && !activeIds.some(id => id && cmd.includes(id))) out.push({ pid: Number(pid), user, ageMin, cmd: cmd.slice(0, 200) });
  }
  return out;
}
const tryRun = (deps, cmd, asForge, unreadable, part) => {
  try { return deps.sh(cmd, { asForge }); } catch (e) { unreadable.push({ part, error: e.message }); return null; }
};
const firstLine = s => String(s || "").trim().split(/\r?\n/)[0] || "";

export const ANONYMOUS_UNIT = /^run-[A-Za-z0-9]+\.(service|scope)$/;
function readServer(env, deps, activeIds, unreadable) {
  const s = { failedUnits: [], anonymousFailedUnits: [], diskPct: null, memAvailPct: null, staleProcs: [], userManagerStarts: null, guardRunning: null, logins: { gh: false, codex: "unknown", claude: "unknown" } };
  const failed = tryRun(deps, "systemctl --failed --no-legend --plain | awk '{print $1}'", false, unreadable, "server/units");
  if (failed !== null) {
    const names = failed.split(/\r?\n/).map(x => x.trim()).filter(Boolean).filter(x => !isLegacy(env, x));
    // systemd-run's generated one-off units (run-u20604.service) belong to nobody: housekeeping clears them, no helper is sent
    s.anonymousFailedUnits = names.filter(x => ANONYMOUS_UNIT.test(x));
    s.failedUnits = names.filter(x => !ANONYMOUS_UNIT.test(x));
  }
  for (const u of env.MUST_RUN || []) {
    if (!/^[A-Za-z0-9_.@-]+\.service$/.test(u)) continue;
    const st = tryRun(deps, `systemctl is-enabled ${u} 2>/dev/null; systemctl is-active ${u} 2>/dev/null; true`, false, unreadable, `server/${u}`);
    if (st === null) continue;
    const [en, act] = String(st).trim().split(/\r?\n/).map(x => x.trim());
    if (en === "enabled" && !/^(active|activating|reloading)$/.test(act || "") && !s.failedUnits.includes(u)) s.failedUnits.push(u);
  }
  const df = tryRun(deps, "df --output=pcent / | tail -1", false, unreadable, "server/disk");
  if (df !== null) s.diskPct = num(df.replace(/[^\d.]/g, ""));
  const mem = tryRun(deps, "free -m | sed -n 2p", false, unreadable, "server/memory");
  if (mem !== null) { const f = mem.trim().split(/\s+/).map(Number); if (f[1] > 0 && Number.isFinite(f[6])) s.memAvailPct = Math.round((f[6] / f[1]) * 100); }
  const ps = tryRun(deps, `ps -u ${env.FORGE_UID} -o pid=,user=,etimes=,ppid=,args=`, false, unreadable, "server/processes");
  if (ps !== null) s.staleProcs = parseStale(ps, activeIds, env.STALE_MINUTES);
  // the factory user's manager started again and again kills every lap (2026-11-18: a guard restarted it every 5 minutes)
  const um = tryRun(deps, `journalctl -u user@${env.FORGE_UID}.service --since -30min -o cat --no-pager | grep -c '^Started user@${env.FORGE_UID}.service' || true`, false, unreadable, "server/user-manager");
  if (um !== null) s.userManagerStarts = num(firstLine(um)) ?? 0;
  // the factory's network guard (another session's, never touched here) may pause the factory's timers
  // while it decides; a timer it holds right now is not a stop
  const guard = tryRun(deps, (env.NETNS_GUARD ? `systemctl is-active ${env.NETNS_GUARD} || true` : "echo inactive"), false, unreadable, "server/netns-guard");
  if (guard !== null) s.guardRunning = /^(active|activating|deactivating|reloading)$/.test(firstLine(guard));
  const gh = tryRun(deps, "gh auth status >/dev/null 2>&1 && echo ok || echo no", true, unreadable, "server/login-gh");
  if (gh !== null) s.logins.gh = firstLine(gh) === "ok";
  const cx = tryRun(deps, "codex login status 2>&1 | head -1", true, unreadable, "server/login-codex");
  if (cx !== null) s.logins.codex = firstLine(cx) || "unknown";
  const cl = tryRun(deps, "claude auth status 2>&1 | head -3 | tr '\\n' ' '", true, unreadable, "server/login-claude");
  if (cl !== null) s.logins.claude = firstLine(cl) || "unknown";
  return s;
}

// The hidden checks' tools, judged exactly as the test machine judges them (its toolCoverage, imported
// from its installed module, never copied): -> {scenarios, missing: [{id, why}]}, or null and unreadable.
// The module's path is written into the script, never passed as an argument: as process.argv[1] it makes
// the test machine believe it was started itself, and it runs a whole look (seen on the server, 2026-11-18).
const coverage = mod => `const m = await import(${JSON.stringify(mod)}); console.log(JSON.stringify(m.toolCoverage(m.defaults([], process.env))))`;
function readTools(env, deps, unreadable) {
  let c = null;
  if (deps.toolCoverage) { // in-process: the driver hands the test-machine step's own reading (toolCoverage(envFor(ctx)))
    try { c = deps.toolCoverage(env); } catch (e) { unreadable.push({ part: "tools", error: `the test machine's tool check failed: ${String(e.message).slice(0, 200)}` }); return null; }
  } else {
    if (!env.TM_MODULE || !/^[\w./-]+\.mjs$/.test(env.TM_MODULE)) return null;
    const out = tryRun(deps, `node --input-type=module -e ${q(coverage(env.TM_MODULE))}`, false, unreadable, "tools");
    if (out === null) return null;
    try { c = JSON.parse(String(out).trim().split(/\r?\n/).pop()); } catch {}
  }
  if (!c || !Array.isArray(c.ids) || !Array.isArray(c.missing)) { unreadable.push({ part: "tools", error: "the test machine's tool check gave no reading" }); return null; }
  if (c.failed) { unreadable.push({ part: "tools", error: `the test machine's tool check failed: ${c.why || "no reason"}` }); return null; }
  return { scenarios: c.ids.length, missing: c.missing.map(m => ({ id: String(m.id), why: String(m.why || `${m.id} has no tool`).slice(0, 300) })) };
}

function readMain(env, deps, unreadable) {
  try {
    const head = deps.gh([`repos/${env.REPO}/commits/main`]);
    const runs = (deps.gh([`repos/${env.REPO}/commits/${head.sha}/check-runs?check_name=required&filter=all&per_page=100`]) || {}).check_runs || [];
    const r = requiredState(runs);
    return { sha: head.sha, required: r.state, since: iso(r.at) };
  } catch (e) { unreadable.push({ part: "main", error: e.message }); return null; }
}

// ------------------------------------------------------------ the factory, every project
const ACTIVE_RUN = /^(queued|in_progress|waiting|requested|pending)$/;
function readFactory(env, deps, project, primary, world, unreadable) {
  const checkout = (env.PROJECT_CHECKOUTS || {})[project] || path.posix.join(env.FORGE_HOME, project);
  const part = `factory/${project}`;
  const f = { project, primary, checkout, repo: primary ? env.REPO : null, lastDecisions: [], activeRuns: [], board: null, stop: null, timers: {} };
  // the trigger and the manager timer: the network guard may pause them (2026-11-18), and a timer that
  // stays inactive stops the project as silently as a STOP file
  const shown = tryRun(deps, `systemctl --user show -p Id -p ActiveState -p LoadState archonfactory-${project}.timer archonfactory-${project}-manager.timer`, true, unreadable, `${part}/timers`);
  if (shown !== null) f.timers = parseShow(shown);
  const journal = tryRun(deps, `journalctl --user -u archonfactory-${project}.service -n 60 --no-pager -o short-iso`, true, unreadable, `${part}/journal`);
  if (journal !== null) f.lastDecisions = parseDecisions(journal);
  let runsCmd = env.ARCHON_RUNS;
  if (!runsCmd) {
    try {
      const c = JSON.parse(deps.readFile(path.posix.join(checkout, ".factory", "consumer.json")));
      if (!c.source) throw new Error("consumer.json names no Archon source");
      const bun = /^[\w./-]+$/.test(String(c.bun || "bun")) ? String(c.bun || "bun") : "bun";
      runsCmd = `cd ${q(checkout)} && ${bun} ${q(path.posix.join(c.source, "packages", "cli", "src", "cli.ts"))} workflow runs --limit 30 --cwd ${q(checkout)} --json`;
    } catch (e) { unreadable.push({ part: `${part}/runs`, error: `the factory's Archon CLI is not known: ${e.message}` }); }
  }
  if (runsCmd) { const runs = tryRun(deps, runsCmd, true, unreadable, `${part}/runs`); if (runs !== null) f.activeRuns = parseRuns(runs); }
  if (!primary) {
    // read as the factory user: root's git never runs in the factory's checkout, not even to read (checkout-guard.mjs, issue #157)
    const url = tryRun(deps, `git config --file ${q(path.posix.join(checkout, ".git", "config"))} --get remote.origin.url`, true, unreadable, `${part}/repository`);
    f.repo = repoOf(url);
  }
  if (primary) f.board = world.board.openNeedsOwner;
  else if (f.repo) {
    try { f.board = (deps.gh([`repos/${f.repo}/issues?state=open&labels=needs-owner&per_page=100`]) || []).filter(x => !x.pull_request && !labelNames(x).includes("found-list")).map(x => x.number); }
    catch (e) { unreadable.push({ part: `board/${project}`, error: e.message }); }
  }
  for (const name of ["STOP", "PAUSE"]) {
    const file = path.posix.join(checkout, ".factory", name);
    let text; try { text = deps.readFile(file); } catch { continue; }
    let mt = Date.now(); try { mt = deps.mtime(file); } catch {}
    const s = { file, kind: name, ...parseStop(text, mt), writerAlive: null, scenariosRunning: null };
    if (s.pid && s.writer) {
      const args = tryRun(deps, `if command -v ps >/dev/null 2>&1; then ps -p ${s.pid} -o args= 2>/dev/null || true; else echo __unknown__; fi`, false, unreadable, `${part}/stop-writer`);
      if (args !== null) s.writerAlive = String(args).includes("__unknown__") ? null : writerRuns(s.writer, args); // unknown stays unknown: nothing is removed on a guess
    } else s.writerAlive = false;
    if (f.repo) {
      try {
        const runs = (deps.gh([`repos/${f.repo}/actions/workflows/${env.SCENARIOS_WORKFLOW}/runs?per_page=20`]) || {}).workflow_runs || [];
        s.scenariosRunning = runs.some(r => ACTIVE_RUN.test(String(r.status || "")) && (/^candidate\//.test(String(r.head_branch || "")) || /candidate\//.test(String(r.display_title || ""))));
      } catch (e) { unreadable.push({ part: `${part}/scenarios`, error: e.message }); }
    }
    if (name === "PAUSE") f.pause = s; // both files may exist: each is read, a PAUSE is never hidden by a STOP
    if (name === "STOP" || !f.stop) f.stop = s;
  }
  return f;
}

// ------------------------------------------------------------ the world
// The questions that reached the owner and still wait for his answer: an entry of a state file's `told` with a page that has a
// receipt (Telegram, email or the urgent issue), not answered and not closed. Only money, publishing and deleting page him.
// -> [{key, heading}]
export function readDeliveredPages(env, deps, unreadable = []) {
  let names = [];
  try { names = (deps.readDir || (d => fs.readdirSync(d)))(env.QUESTIONS_DIR).filter(n => /^state(-[a-z0-9_.-]+)?\.json$/i.test(n)); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    let s;
    try { s = JSON.parse(deps.readFile(path.join(env.QUESTIONS_DIR, n))); } catch (e) { if (e instanceof SyntaxError) unreadable.push({ part: `questions ${n}`, error: e.message }); continue; }
    for (const [key, t] of Object.entries((s && s.told) || {})) {
      const stages = (t && t.page && t.page.stages) || [];
      const reached = stages.some(st => Object.values((st && st.channels) || {}).some(c => c && c.receipt));
      if (t && !t.answered && t.page && !t.page.closed && reached) out.push({ key, heading: String(t.heading || "") });
    }
  }
  return out;
}

// The factory questions the questions step handed to the driver (2026-11-24): `routed` entries marked `mc` in its state
// files (state.json and state-<owner>__<repo>.json), each a question with nothing to pick from that the decide helper
// settles. The step takes an entry off once the decision is on GitHub. -> [{repo, key, heading, ...}]
export function readRoutedQuestions(env, deps, unreadable = []) {
  let names = [];
  try { names = (deps.readDir || (d => fs.readdirSync(d)))(env.QUESTIONS_DIR).filter(n => /^state(-[a-z0-9_.-]+)?\.json$/i.test(n)); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    let s;
    try { s = JSON.parse(deps.readFile(path.join(env.QUESTIONS_DIR, n))); } catch (e) { if (e instanceof SyntaxError) unreadable.push({ part: `questions ${n}`, error: e.message }); continue; }
    for (const [key, v] of Object.entries((s && s.routed) || {})) if (v && v.mc && v.repo && v.heading) out.push({ ...v, key });
  }
  return out;
}

export async function readWorld(env0 = {}, deps0 = {}) {
  const env = { ...defaultsFor(process.env), ...env0 };
  const deps = { ...realDeps(env), ...deps0 };
  const now = deps.now ? deps.now() : Date.now();
  const unreadable = [];
  const world = { at: new Date(now).toISOString(), releases: [], superseded: [], installed: null, items: {}, board: { openNeedsOwner: [] }, main: null, factory: { lastDecisions: [], activeRuns: [] }, server: null, staging: {}, unreadable };

  let autoStage = {};
  try { autoStage = JSON.parse(deps.readFile(env.AUTO_STAGE_STATE)); } catch { /* auto-stage may not have run yet */ }
  let picks = [];
  world.superseded = [];
  try {
    const all = deps.readReleases(env.RELEASES_DIR, autoStage).filter(r => GODSPEED_RELEASE.test(r.id)); // the main project's own plans only, before they are picked, ordered or compared
    picks = pickPlans(all, env.REPO).picks.filter(r => GODSPEED_RELEASE.test(r.id)); // the main project's own release plans only: one definition, everywhere
    // an approved release older than the version installed on the server is superseded (2026-11-18:
    // beta.27 stayed approved and unfinished after beta.28 was installed): never driven, named once.
    // The installed one itself is done (Michael, 2026-11-18 evening: "a release is done once it is
    // installed on my server; nobody works on it afterwards"), whatever its scenarios said.
    const inst = all.filter(r => GODSPEED_RELEASE.test(r.id) && r.staging && r.staging.status === "installed" && releaseVersion(r.id))
      .sort((a, b) => compareVersions(releaseVersion(a.id), releaseVersion(b.id))).at(-1);
    const installed = inst ? releaseVersion(inst.id) : null;
    if (installed) {
      world.installed = { id: inst.id, version: installed, staging: inst.staging || null, issues: Object.values(itemIssues(inst.plan || "")) };
      world.superseded = picks.filter(r => compareVersions(r.version, installed) < 0).map(r => ({ id: r.id, version: r.version, by: installed }));
      picks = picks.filter(r => compareVersions(r.version, installed) > 0);
    }
  } catch (e) { unreadable.push({ part: "releases", error: e.message }); }

  const wanted = new Set();
  for (const r of picks) {
    const version = r.version;
    const tickets = readTickets(r, deps);
    for (const t of tickets) if (t.issue) wanted.add(t.issue);
    for (const n of Object.values(itemIssues(r.plan))) wanted.add(n);
    world.releases.push({ id: r.id, version, label: releaseLabel(version), repo: planRepository(r.plan), plan: r.plan, tickets, excluded: [...excludedIssues(r.plan)] });
    world.staging[r.id] = r.staging || null;
  }
  for (const n of wanted) { const it = readItem(env, deps, n, unreadable); if (it) world.items[n] = it; }

  try {
    const rows = deps.gh([`repos/${env.REPO}/issues?state=open&labels=needs-owner&per_page=100`]) || [];
    world.board.openNeedsOwner = rows.filter(x => !x.pull_request && !labelNames(x).includes("found-list")).map(x => x.number);
  } catch (e) { unreadable.push({ part: "board", error: e.message }); }
  world.main = readMain(env, deps, unreadable);

  const listed = tryRun(deps, "systemctl --user list-unit-files 'archonfactory-*.timer' --no-legend --plain", true, unreadable, "factory/projects");
  world.factories = parseProjects(listed || "", env.PROJECT).map(p => readFactory(env, deps, p, p === env.PROJECT, world, unreadable));
  world.factory = world.factories[0];
  world.server = readServer(env, deps, world.factories.flatMap(f => f.activeRuns.map(r => r.id)), unreadable);
  world.tools = readTools(env, deps, unreadable);
  // the factory's helpers' questions left for Mission Control (owner-questions helper's queue)
  world.queue = []; world.answeredElsewhere = {};
  try { world.queue = (JSON.parse(deps.readFile(path.join(env.QUESTIONS_DIR, "mission-control-queue.json"))).items) || []; } catch (e) { if (e instanceof SyntaxError) unreadable.push({ part: "mission-control-queue", error: e.message }); }
  try { world.answeredElsewhere = JSON.parse(deps.readFile(path.join(env.QUESTIONS_DIR, "answered-elsewhere.json"))) || {}; } catch (e) { if (e instanceof SyntaxError) unreadable.push({ part: "answered-elsewhere", error: e.message }); }
  try { world.toMichael = JSON.parse(deps.readFile(path.join(env.QUESTIONS_DIR, env.TO_OWNER_FILE || process.env.FD_TO_OWNER_FILE || "to-owner.json"))) || {}; } catch (e) { world.toMichael = {}; if (e instanceof SyntaxError) unreadable.push({ part: "to-michael", error: e.message }); }
  world.routedQuestions = readRoutedQuestions(env, deps, unreadable);
  world.deliveredPages = readDeliveredPages(env, deps, unreadable);
  // every open pull request labelled needs-owner in the repositories whose factory runs (parked ones have no factory)
  world.openPrs = [];
  for (const repo of [...new Set([env.REPO, ...world.factories.map(f => f.repo).filter(Boolean)])]) {
    try {
      for (const x of (deps.gh([`repos/${repo}/issues?state=open&labels=needs-owner&per_page=100`]) || []).filter(x => x.pull_request))
        world.openPrs.push({ repo, number: x.number, title: x.title, url: x.html_url, updatedAt: x.updated_at });
    } catch { /* the board's own read reports it; no pull request entries from this repository this round */ }
  }
  return world;
}
