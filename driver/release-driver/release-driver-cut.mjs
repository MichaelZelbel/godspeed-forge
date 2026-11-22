// The cut (2026-11-17): an item that reaches a dead end leaves the release, the rest ships.
//
// WHY. Beta.26's approved plan says so ("an item that reaches a dead end leaves the release, the rest
// ships"), and beta.25's did too, but nothing carried it out. The driver's AI may not authorize an item
// a third time (brief.md), so it reported such items as `left` towards a prerequisite or the verifier
// repair, the driver counted that as progress, and when the prerequisite was itself stuck the release
// waited in a closed loop (#670 on #616/#618 on #652 on a verifier that could not observe). Auto-stage
// stages only when every ticket's issue is closed or deferred by releases/<id>/scope-amendment.json,
// which until now only a person wrote. This file decides deterministically (no AI judgement) which
// release items are dead ends and writes that amendment for them, under the plan's own rule.
//
// An item is a dead end when it is open and one of these holds (thresholds chosen 2026-11-17):
//   (a) the driver authorized it at least twice (a posted `decided` or `repaired`) and nothing of it
//       merged in the AUTH_IDLE_HOURS (6) since the newest of those: two owner-side laps already failed
//       to land it, and the brief forbids a third;
//   (b) its newest report is `left` towards a prerequisite or the verifier repair, and that target is
//       itself a dead end, or the item has stayed `left` for LEFT_HOURS (12) with nothing new: waiting
//       on something that will not come is a closed loop;
//   (c) it was `left` in each of the last LEFT_RUNS (4) driver runs of the release and no commit,
//       merge or loop review came in between: four looks in a row found nothing that could move it;
//   (o) Michael himself moved it out: it no longer carries the release label and an `Owner decision`
//       he wrote on the issue moves it to a later release. Not idleness: his own words, quoted.
// Only release tickets are cut (prerequisites are judged only as targets of (b)). Code that merged
// but could not be proved because the hidden checks could not run is cut too: it ships in the
// candidate, its proof moves to the next release with the item, and nothing is ever marked passed.
//
// GUARDS. Nothing is cut (1) unless the approved plan holds the rule's words, (2) while the factory
// itself is not working (no lap started for two hours, its STOP or PAUSE file, its timer off, Codex
// signed out or out of allowance, the builder token failing: then every item looks idle and a cut
// would empty the release; the driver records `factory-down` and tells Michael once instead), (3) when
// no ticket of the release is done (a cut would leave nothing to ship), (4) when a person already
// wrote the release's scope-amendment.json (his decision is never rewritten by the driver).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isTrusted, loginOf, loopWords, verifierBlocked, ownerLogin } from "./release-driver-owner-steps.mjs";

const HOUR = 3600 * 1000;
const iso = ms => new Date(ms).toISOString();
const short = t => String(t || "").replace(/\s+/g, " ").trim();
const ROOT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
// a dedupe key kept per release (two releases are driven in one look; one slot would alternate between them)
const perRelease = (state, name) => (state[name] && typeof state[name] === "object" ? state[name] : (state[name] = {}));

export const AUTH_IDLE_HOURS = 6, LEFT_HOURS = 12, LEFT_RUNS = 4, FACTORY_QUIET_HOURS = 2, MACHINE_GRACE_HOURS = 24;
export const CUT_MARKER = id => `<!-- release-driver-cut:${id} -->`;
const AUTHORIZED = ["decided", "repaired"];
const ROUTES = ["prerequisite", "referee-repair"];

// ---------------------------------------------------------------- the plan (pure)
const RULE = /an\s+item\s+that\s+reaches\s+a\s+dead\s+end\s+leaves\s+the\s+release,\s+the\s+rest\s+ships/i;
// -> {words, statusLine, approvedAt} or null. words: the plan's own sentence holding the rule, exactly
// as it stands in plan.md (line breaks included), so plan.md contains it byte for byte.
export function planCutRule(plan) {
  const text = String(plan || "");
  // the Status sentence, which may run over a line break (beta.26's does)
  const status = /^[ \t]*(status:[ \t]*approved\b[\s\S]*?[.!?]["')\]]*)(?=\s|$)/im.exec(text);
  const m = RULE.exec(text);
  if (!status || !m) return null;
  let start = m.index;
  while (start > 0 && !/[.!?]\s/.test(text.slice(start - 2, start)) && text.slice(start - 2, start) !== "\n\n") start--;
  let end = m.index + m[0].length;
  while (end < text.length && !/[.!?]/.test(text[end]) && text.slice(end, end + 2) !== "\n\n") end++;
  if (end < text.length && /[.!?]/.test(text[end])) end++;
  const statusLine = short(status[1]);
  const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(statusLine);
  return { words: text.slice(start, end).replace(/^\s+/, ""), statusLine, approvedAt: date ? `${date[1]}T00:00:00Z` : null };
}
// {2: "A chat says plainly when the AI key was refused", ...} from the plan's "N. **...**" lines
export function planItemNames(plan) {
  const out = {};
  for (const m of String(plan || "").matchAll(/^\s*(\d+)\.\s+\*\*(.+?)\*\*/gm)) out[Number(m[1])] = m[2].replace(/[.,;:]+$/, "").trim();
  return out;
}
export const ticketItem = file => { const m = path.basename(String(file)).match(/^(\d+)/); return m ? Number(m[1]) : null; };
export const versionWords = version => { const pre = String(version).includes("-") ? String(version).slice(String(version).indexOf("-") + 1) : ""; const m = /^([a-z]+)\.(\d+)$/i.exec(pre); return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}` : `Godspeed ${version}`; };

// ---------------------------------------------------------------- dead ends (pure)
// decisions: the driver's whole log (decisions.jsonl lines). prereqs: state.prereqs[release] ({n: {of}}).
// -> Map(number -> {rule, why, evidence: [..], codeMerged: [urls]}) for every open item that is one
export function findDeadEnds({ planId, world, decisions, prereqs = {}, now, releaseLabel = "" }) {
  const items = new Map((world.items || []).map(i => [i.number, i]));
  const mine = (decisions || []).filter(d => d && d.release === planId);
  const runs = mine.filter(d => d.kind === "run finished" && d.run).sort((a, b) => String(a.at).localeCompare(String(b.at))).map(d => d.run);
  const entries = n => mine.filter(d => d.item === n && ["decided", "repaired", "narrowed", "asked-michael", "left", "nothing"].includes(d.kind)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const prsOf = it => it.prs || [];
  const mergedAfter = (it, t) => prsOf(it).some(p => p.merged && p.mergedAt && Date.parse(p.mergedAt) > t);
  const newSince = (it, t) => {
    if (mergedAfter(it, t)) return "a merge";
    if (prsOf(it).some(p => p.state === "OPEN" && p.lastCommitAt && Date.parse(p.lastCommitAt) > t)) return "a commit";
    const reviews = [...(it.comments || []), ...prsOf(it).flatMap(p => p.comments || [])].filter(c => isTrusted(c.author) && /^\s*Loop review:/i.test(c.body || "") && Date.parse(c.createdAt) > t);
    return reviews.length ? "a loop review" : "";
  };
  const line = d => ({ at: d.at, kind: d.kind, run: d.run || null, what: short(d.what).slice(0, 300), ...(d.routed ? { routed: d.routed } : {}), ...((d.links || []).length ? { links: d.links.slice(0, 4) } : {}) });
  // what an item waits on: the release's prerequisites recorded for it (a pull request counts as the
  // item that carries it; the item's own pull request is not something it waits on)
  const targetsOf = n => [...new Set(Object.entries(prereqs || {}).filter(([, v]) => v && Number(v.of) === n).map(([k]) => {
    const k2 = Number(k); if (items.has(k2)) return k2;
    const owner = [...items.values()].find(i => prsOf(i).some(p => p.number === k2)); return owner ? owner.number : k2;
  }))].filter(t => t !== n && items.has(t) && items.get(t).state === "OPEN");
  const memo = new Map(), visiting = new Set();
  const judge = n => {
    if (memo.has(n)) return memo.get(n);
    const it = items.get(n);
    if (!it || it.state !== "OPEN" || visiting.has(n)) return null;
    visiting.add(n);
    const es = entries(n);
    const merged = prsOf(it).filter(p => p.merged).map(p => p.url || `#${p.number}`);
    let out = null;
    // (o) Michael moved it out himself
    const his = (it.comments || []).filter(c => loginOf(c.author) === ownerLogin() && /^\s*Owner decision\b/i.test(c.body || "") && /\b(later|next|another|future)\s+release\b/i.test(c.body || "")).at(-1);
    if (his && releaseLabel && !(it.labels || []).includes(releaseLabel))
      out = { rule: "owner-moved", why: "Michael moved it to a later release himself", evidence: [{ at: his.createdAt, url: his.url || it.url, words: short(his.body).slice(0, 400) }] };
    // (a) authorized twice, nothing merged in AUTH_IDLE_HOURS since
    const auths = es.filter(d => AUTHORIZED.includes(d.kind) && d.handled === true);
    if (!out && auths.length >= 2) {
      const t = Date.parse(auths.at(-1).at);
      if (now - t >= AUTH_IDLE_HOURS * HOUR && !mergedAfter(it, t))
        out = { rule: "a", why: `the release driver authorized it ${auths.length} times, the last at ${auths.at(-1).at.slice(0, 16).replace("T", " ")} UTC, and nothing of it merged in the ${Math.floor((now - t) / HOUR)} hours since`, evidence: auths.map(line) };
    }
    // (c) left in each of the last LEFT_RUNS runs, nothing new between
    if (!out && runs.length >= LEFT_RUNS) {
      const last = runs.slice(-LEFT_RUNS).map(r => es.filter(d => d.run === r).at(-1));
      if (last.every(d => d && d.kind === "left")) {
        const since = Date.parse(last[0].at);
        if (!newSince(it, since)) out = { rule: "c", why: `the last ${LEFT_RUNS} release driver runs each found it stuck, with no new commit, merge or review in between`, evidence: last.map(line) };
      }
    }
    // (b) routed towards something that will not come
    const newest = es.at(-1);
    if (!out && newest && newest.kind === "left" && ROUTES.includes(newest.routed || newest.owner_step)) {
      const deadTarget = targetsOf(n).map(t => [t, judge(t)]).find(([, j]) => j);
      if (deadTarget) out = { rule: "b", why: `it waits on #${deadTarget[0]}, which is itself stuck (${deadTarget[1].why})`, evidence: [line(newest), { target: deadTarget[0], targetRule: deadTarget[1].rule, targetEvidence: deadTarget[1].evidence.slice(0, 4) }] };
      else {
        let i = es.length - 1; while (i > 0 && es[i - 1].kind === "left") i--;
        const since = Date.parse(es[i].at);
        if (now - since >= LEFT_HOURS * HOUR && !newSince(it, since)) out = { rule: "b", why: `it has waited on ${(newest.routed || newest.owner_step) === "referee-repair" ? "a repair of the hidden checks" : "another item"} for ${Math.floor((now - since) / HOUR)} hours with nothing new`, evidence: es.slice(i).map(line) };
      }
    }
    visiting.delete(n);
    if (out) out.codeMerged = merged;
    memo.set(n, out);
    return out;
  };
  const dead = new Map();
  for (const it of items.values()) { const j = judge(it.number); if (j) dead.set(it.number, j); }
  return dead;
}

// A routed `left` whose target is a dead end is not progress (it no longer counts as moved).
export function routedToDeadEnd(reportItem, dead, prereqs = {}) {
  if (reportItem.action !== "left" || !ROUTES.includes(reportItem.owner_step)) return false;
  if (dead.has(reportItem.item)) return true;
  const targets = [...(reportItem.prerequisites || []), ...Object.entries(prereqs || {}).filter(([, v]) => v && Number(v.of) === reportItem.item).map(([k]) => Number(k))];
  return targets.some(t => dead.has(t));
}

// ---------------------------------------------------------------- the test machine (pure)
// An item whose only missing proof is a hidden-check observation: its newest report routes it to the
// verifier repair, or the loop's newest words say the verifier could not observe for its own reasons.
export function proofOnly(it, decisions, planId) {
  const newest = (decisions || []).filter(d => d && d.release === planId && d.item === it.number && ["decided", "repaired", "narrowed", "asked-michael", "left", "nothing"].includes(d.kind)).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1);
  if (newest && newest.kind === "left" && (newest.routed || newest.owner_step) === "referee-repair") return true;
  const words = loopWords([...(it.comments || []), ...(it.prs || []).filter(p => p.state === "OPEN").flatMap(p => p.comments || [])]);
  return words.length > 0 && verifierBlocked(words.map(c => c.body).join(" \n\n "));
}
// tm: the test machine's state.json ({healthy, since, why}) or null (not known: never holds a cut).
// -> {wait: bool, hours}: while it is unhealthy such an item waits, for MACHINE_GRACE_HOURS at most;
// after that it may be cut, its reason "proof could not run", never "failed".
export function machineHold(tm, now) {
  if (!tm || tm.healthy !== false) return { wait: false, hours: 0, unhealthy: false };
  const hours = Math.floor((now - Date.parse(tm.since || 0)) / HOUR);
  return { wait: !(hours >= MACHINE_GRACE_HOURS), hours, unhealthy: true };
}

// ---------------------------------------------------------------- the factory (pure)
// facts: {lastLaunch, lastClaim (ms or 0), stop, pause, timer ("active"|...), codexLogin (bool),
// providerFailure ("" or a class), tokenOk (bool), tokenError}. -> reasons the factory is not working
export function factoryDown(f, now) {
  const reasons = [];
  const lap = Math.max(f.lastLaunch || 0, f.lastClaim || 0);
  if (!lap || now - lap > FACTORY_QUIET_HOURS * HOUR) reasons.push(`no loop lap started in the last ${FACTORY_QUIET_HOURS} hours${lap ? ` (the last at ${iso(lap).slice(0, 16).replace("T", " ")} UTC)` : ""}`);
  if (f.stop) reasons.push("the factory's STOP file is set (halted)");
  if (f.pause) reasons.push("the factory's schedule is paused");
  if (f.timer && f.timer !== "active") reasons.push(`the factory's timer is ${f.timer}`);
  if (f.codexLogin === false) reasons.push("Codex is not signed in");
  if (f.providerFailure) reasons.push(`Codex reported ${f.providerFailure === "quota_exhausted" ? "its allowance used up" : f.providerFailure} in the last ${FACTORY_QUIET_HOURS} hours`);
  if (f.tokenOk === false) reasons.push(`the builder token could not be made${f.tokenError ? ` (${short(f.tokenError).slice(0, 120)})` : ""}`);
  return reasons;
}
export const PROVIDER_FAILURE = /"providerFailure"\s*:\s*\{\s*"class"\s*:\s*"((?:quota|auth|login|unauthori|credit|usage)[a-z_]*)"/i;
// The facts, read on the server as root.
export function factoryFacts(env, { now, world, mint }) {
  const fdir = path.join(env.SOURCE_CHECKOUT, ".factory");
  let lastLaunch = 0; try { lastLaunch = Number(JSON.parse(fs.readFileSync(path.join(fdir, "gate.json"), "utf8")).last_launch || 0) * 1000; } catch {}
  const claims = (world.items || []).flatMap(i => [...(i.comments || []), ...(i.prs || []).flatMap(p => p.comments || [])]).filter(c => isTrusted(c.author) && /^\s*Loop claim:\s*run\b/i.test(c.body || "")).map(c => Date.parse(c.createdAt)).filter(Number.isFinite);
  const forge = (cmd, extra = []) => spawnSync("runuser", ["-u", env.FORGE_USER, "--", "env", "-i", `HOME=/home/${env.FORGE_USER}`, "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", ...extra, ...cmd], { encoding: "utf8", timeout: 60000, env: { PATH: ROOT_PATH } });
  const timer = String(forge(["systemctl", "--user", "is-active", env.FACTORY_TIMER || `archonfactory-${env.PROJECT || String(env.REPO || "").split("/")[1]}.timer`], [`XDG_RUNTIME_DIR=/run/user/${env.FORGE_UID}`]).stdout || "").trim() || "unknown";
  const login = forge(["codex", "login", "status"]);
  const codexLogin = login.status === 0 && /logged in/i.test(`${login.stdout || ""}${login.stderr || ""}`) && !/not logged in/i.test(`${login.stdout || ""}${login.stderr || ""}`);
  let providerFailure = "";
  const logs = env.FACTORY_LOGS || `/home/${env.FORGE_USER}/.archon/logs`;
  try {
    for (const name of fs.readdirSync(logs)) {
      const f = path.join(logs, name); let st; try { st = fs.statSync(f); } catch { continue; }
      if (!st.isFile() || now - st.mtimeMs > FACTORY_QUIET_HOURS * HOUR) continue;
      const fd = fs.openSync(f, "r"); const len = Math.min(st.size, 2 * 1024 * 1024); const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
      const m = PROVIDER_FAILURE.exec(buf.toString("utf8")); if (m) { providerFailure = m[1]; break; }
    }
  } catch {}
  let tokenOk = true, tokenError = "";
  try { mint(); } catch (e) { tokenOk = false; tokenError = e.message; }
  return { lastLaunch, lastClaim: claims.length ? Math.max(...claims) : 0, stop: fs.existsSync(path.join(fdir, "STOP")), pause: fs.existsSync(path.join(fdir, "PAUSE")), timer, codexLogin, providerFailure, tokenOk, tokenError };
}

// ---------------------------------------------------------------- the amendment (pure)
// existing: the release's scope-amendment.json as it is on the records repository's main (or null).
// cuts: [{file, item, issue, url, title, dead}]. -> the new amendment object
export function amendment({ existing, plan, rule, cuts, now, repo }) {
  const prev = existing && existing.decidedBy === "release-driver" ? existing : null;
  const reasons = { ...((prev && prev.reasons) || {}) };
  for (const c of cuts) {
    const merged = c.dead.codeMerged || [];
    reasons[c.file] = {
      item: c.item, issue: c.issue, url: c.url || `https://github.com/${repo}/issues/${c.issue}`, title: c.title || "", rule: c.dead.rule, why: c.dead.why,
      ...(merged.length ? { codeMerged: merged, proof: "its code merged and ships with this candidate; the hidden checks that should prove it could not run, so that proof moves to the next release with the item; nothing is marked passed" } : {}),
      decidedAt: iso(now), evidence: c.dead.evidence,
    };
  }
  const deferred = [...new Set([...((prev && prev.deferredTickets) || []), ...cuts.map(c => c.file)])].sort();
  return {
    release: plan.id, version: plan.version,
    decidedBy: "release-driver", authority: "plan-rule",
    words: rule.words,
    approvalRef: `releases/${plan.id}/plan.md: ${rule.statusLine}`,
    approvedAt: rule.approvedAt,
    decidedAt: (prev && prev.decidedAt) || iso(now),
    deferredTickets: deferred,
    reason: `Under the approved plan's rule (an item that reaches a dead end leaves the release, the rest ships), Mission Control's release driver moved ${deferred.length === 1 ? "this ticket" : "these tickets"} to the next release: ${deferred.map(f => `${f} (#${reasons[f] ? reasons[f].issue : "?"}: ${reasons[f] ? reasons[f].why : "?"})`).join("; ")}. Everything else ships as planned.`,
    reasons,
  };
}
export function cutComment({ plan, rule, cut }) {
  const v = versionWords(plan.version);
  const merged = cut.dead.codeMerged || [];
  const why = cut.dead.rule === "owner-moved" ? "Michael moved it to a later release himself" : cut.dead.why;
  return `Moved to the next release by Mission Control's release driver: ${why}. ${cut.dead.rule === "owner-moved" ? `${v} ships without it.` : `${v}'s approved plan says "${short(RULE.exec(rule.words) ? RULE.exec(rule.words)[0] : rule.words)}", so this item leaves ${v} and the rest ships.`}${merged.length ? ` Its code already merged (${merged.join(", ")}) and ships with ${v}; the hidden checks that should prove it could not run, so that proof moves to the next release with this item. Nothing here is marked as passed.` : ""} The issue stays open with needs-owner for the next release's plan.\n${CUT_MARKER(plan.id)}`;
}
export function cutSentence({ plan, cuts, names }) {
  const v = versionWords(plan.version);
  const name = c => names[c.item] || short(c.title) || `item ${c.item}`;
  const stuck = cuts.filter(c => c.dead.rule !== "owner-moved").map(name), moved = cuts.filter(c => c.dead.rule === "owner-moved").map(name);
  const list = a => (a.length === 1 ? `"${a[0]}"` : `${a.slice(0, -1).map(x => `"${x}"`).join(", ")} and "${a.at(-1)}"`);
  const parts = [stuck.length ? `${list(stuck)}, which got stuck` : "", moved.length ? `${list(moved)}, which you moved to a later release` : ""].filter(Boolean);
  return `${v} goes on your server without ${parts.join(", and without ")}; ${cuts.length === 1 ? "it moves" : "they move"} to the next release.`;
}

// ---------------------------------------------------------------- the records in the records repository
// The same writer auto-stage uses (the records repository scripts/release/staging.mjs Records): one commit on
// the records repository's main, pushed with that checkout's own git credential.
export async function devRecords(env) {
  const mod = await import(pathToFileURL(path.join(env.DEV_CHECKOUT, "scripts", "release", "staging.mjs")).href);
  return new mod.Records({ ...process.env, RELEASE_RECORDS_ROOT: env.DEV_CHECKOUT });
}

// ---------------------------------------------------------------- one look's cut
// ctx: {plan, world, state, now, decisions, record, notify, log, gh, records, factory, label}
// -> {dead: Map, cutIssues: Set (every deferred ticket's issue, the person's included), wouldCut: []}
export async function cutLook(env, ctx) {
  const { plan, world, state, now, decisions, record, notify, log } = ctx;
  const prereqs = (state.prereqs || {})[plan.id] || {};
  const dead = findDeadEnds({ planId: plan.id, world, decisions, prereqs, now, releaseLabel: ctx.label });
  const items = itemIssuesOf(plan.plan);
  const files = ticketFilesOf(plan);
  const fileOf = item => files.find(f => ticketItem(f) === item) || null;
  const records = ctx.records ? ctx.records : await devRecords(env);
  const rel = `releases/${plan.id}/scope-amendment.json`;
  let existing = null; try { const t = records.read(rel); existing = t ? JSON.parse(t) : null; } catch (e) { record({ kind: "cut look failed", release: plan.id, why: `scope-amendment.json could not be read: ${String(e.message).slice(0, 200)}` }); return { dead, cutIssues: new Set(), wouldCut: [] }; }
  const deferred = new Set((existing && existing.deferredTickets) || []);
  const issueOfFile = f => items[ticketItem(f)];
  const cutIssues = new Set([...deferred].map(issueOfFile).filter(Boolean));
  const byIssue = new Map((world.items || []).map(i => [i.number, i]));
  const tickets = Object.entries(items).map(([item, issue]) => ({ item: Number(item), issue, file: fileOf(Number(item)), it: byIssue.get(issue) }));
  let toCut = tickets.filter(t => t.file && t.it && t.it.state === "OPEN" && !deferred.has(t.file) && dead.has(t.issue)).map(t => ({ file: t.file, item: t.item, issue: t.issue, url: t.it.url, title: t.it.title, dead: dead.get(t.issue), it: t.it }));
  // the test machine: an item whose only missing proof is a hidden check waits while the machine cannot
  // observe (its cause is the machine, not the item); after MACHINE_GRACE_HOURS it may go, as "proof could not run"
  const hold = machineHold(ctx.testMachine, now);
  if (hold.unhealthy) {
    const waits = [];
    toCut = toCut.flatMap(c => {
      if (c.dead.rule === "owner-moved" || !proofOnly(c.it, decisions, plan.id)) return [c];
      if (hold.wait) { waits.push(c); return []; }
      return [{ ...c, dead: { ...c.dead, rule: `${c.dead.rule}-proof`, why: `proof could not run: the test machine that runs the hidden checks has not been able to observe for ${hold.hours} hours (${short(ctx.testMachine.why).slice(0, 200)})`, proofCouldNotRun: true } }];
    });
    if (waits.length) {
      const key = `machine:${ctx.testMachine.since}:${waits.map(c => c.issue).join(",")}`;
      if (perRelease(state, "cut_machine_wait")[plan.id] !== key) { perRelease(state, "cut_machine_wait")[plan.id] = key; record({ kind: "cut waits for the test machine", release: plan.id, items: waits.map(c => c.issue), why: `their only missing proof is a hidden check, and the test machine has not been able to observe since ${ctx.testMachine.since} (${short(ctx.testMachine.why).slice(0, 200)})` }); }
      log(`${plan.version} cut: ${waits.map(c => `#${c.issue}`).join(", ")} wait: their only missing proof is a hidden check and the test machine is not healthy (${hold.hours} of ${MACHINE_GRACE_HOURS} hours)`);
    }
  }
  toCut = toCut.map(({ it, ...c }) => c);
  const show = c => `#${c.issue} (item ${c.item}, ${c.file}): ${c.dead.rule === "owner-moved" ? "" : `dead end (${c.dead.rule}): `}${c.dead.why}${(c.dead.codeMerged || []).length ? `; its code merged (${c.dead.codeMerged.join(", ")}), its proof moves with it` : ""}`;
  for (const [n, d] of dead) if (!tickets.some(t => t.issue === n)) log(`  #${n} (not a ticket) is stuck too (${d.rule}): ${d.why}`);
  const rest = tickets.filter(t => !deferred.has(t.file) && !toCut.some(c => c.issue === t.issue));
  const openRest = rest.filter(t => !t.it || t.it.state === "OPEN");
  const stageWords = () => (openRest.length ? `the rest would not stage yet: still open ${openRest.map(t => `#${t.issue} (item ${t.item})`).join(", ")}` : `every other ticket is closed, so the rest would stage (${rest.map(t => `#${t.issue}`).join(", ")})`);
  if (!toCut.length) {
    if (env.DRY) log(`${plan.version} cut: nothing to cut${deferred.size ? ` (already deferred: ${[...deferred].join(", ")})` : ""}; ${stageWords()}`);
    await ensureOnGitHub(env, ctx, existing, tickets, cutIssues);
    return { dead, cutIssues, wouldCut: [] };
  }
  const rule = planCutRule(plan.plan);
  const refuse = (key, why) => { if (perRelease(state, "cut_refused")[plan.id] !== key) { perRelease(state, "cut_refused")[plan.id] = key; record({ kind: "cut not made", release: plan.id, items: toCut.map(c => c.issue), why }); } log(`${plan.version} cut: would cut ${toCut.map(c => `#${c.issue}`).join(", ")}, but ${why}`); return { dead, cutIssues, wouldCut: toCut }; };
  if (!rule) return refuse(`norule:${plan.id}`, "the approved plan does not hold the rule \"an item that reaches a dead end leaves the release, the rest ships\"");
  if (existing && existing.decidedBy !== "release-driver") return refuse(`person:${plan.id}`, "the release's scope-amendment.json was written by a person, and the driver never rewrites his decision");
  if (!tickets.some(t => t.it && t.it.state === "CLOSED")) return refuse(`empty:${plan.id}`, "no ticket of the release is done, so a cut would leave nothing to ship");
  // the factory must be working: otherwise every item looks idle
  const facts = ctx.factory ? ctx.factory() : null;
  const down = facts ? factoryDown(facts, now) : [];
  if (down.length) {
    const why = down.join("; ");
    if (!state.factory_down || state.factory_down.why !== why) { state.factory_down = { since: (state.factory_down && state.factory_down.since) || iso(now), why }; record({ kind: "factory-down", release: plan.id, why, items: toCut.map(c => c.issue) }); }
    notify(`factory-down:${state.factory_down.since}`, `The factory that builds Godspeed is not working right now (${down[0]}), so Mission Control's release program is not moving any stuck item out of ${versionWords(plan.version)} until it works again.`, "The factory is not working");
    log(`${plan.version} cut: would cut ${toCut.map(c => `#${c.issue}`).join(", ")}, but the factory is down: ${why}`);
    return { dead, cutIssues, wouldCut: toCut, factoryDown: down };
  }
  delete state.factory_down;
  if (env.DRY) {
    if (facts) log(`${plan.version} cut: the factory is working (newest lap ${iso(Math.max(facts.lastLaunch || 0, facts.lastClaim || 0)).slice(0, 16).replace("T", " ")} UTC, no STOP or PAUSE, timer ${facts.timer || "?"}, Codex signed in, no allowance failure in ${FACTORY_QUIET_HOURS} hours, builder token made)`);
    log(`${plan.version} cut: would cut\n${toCut.map(c => `  ${show(c)}`).join("\n")}\n  then ${(() => { const after = tickets.filter(t => !deferred.has(t.file) && !toCut.some(c => c.issue === t.issue) && (!t.it || t.it.state === "OPEN")); return after.length ? `the rest would not stage yet: still open ${after.map(t => `#${t.issue}`).join(", ")}` : `every other ticket is closed, so auto-stage would stage the rest (${rest.map(t => `#${t.issue}`).join(", ")})`; })()}`);
    log(`  the amendment it would write:\n${JSON.stringify(amendment({ existing, plan, rule, cuts: toCut, now, repo: env.REPO }), null, 2)}`);
    return { dead, cutIssues: new Set([...cutIssues, ...toCut.map(c => c.issue)]), wouldCut: toCut };
  }
  const next = amendment({ existing, plan, rule, cuts: toCut, now, repo: env.REPO });
  let commit;
  try { commit = records.write({ [rel]: `${JSON.stringify(next, null, 2)}\n` }, `${plan.version}: ${toCut.map(c => c.file).join(", ")} move to the next release (release driver, the plan's dead-end rule)`); }
  catch (e) { record({ kind: "cut failed", release: plan.id, items: toCut.map(c => c.issue), why: `scope-amendment.json could not be written: ${String(e.message).slice(0, 300)}` }); return { dead, cutIssues, wouldCut: toCut }; }
  for (const c of toCut) { record({ kind: "cut", release: plan.id, item: c.issue, ticket: c.file, rule: c.dead.rule, what: c.dead.why, codeMerged: c.dead.codeMerged, commit: commit || null }); cutIssues.add(c.issue); }
  delete perRelease(state, "cut_refused")[plan.id];
  notify(`cut:${plan.id}:${next.deferredTickets.join(",")}`, cutSentence({ plan, cuts: next.deferredTickets.map(f => { const r = next.reasons[f] || {}; return { item: ticketItem(f), title: r.title, dead: { rule: r.rule } }; }), names: planItemNames(plan.plan) }), `Godspeed ${plan.version} ships without some items`);
  await ensureOnGitHub(env, ctx, next, tickets, cutIssues);
  return { dead, cutIssues, wouldCut: toCut, commit };
}
// Every ticket the driver cut: one comment, the release label off, needs-owner on (again each look
// until it holds, so a failed call is repaired by the next look).
async function ensureOnGitHub(env, ctx, amend, tickets, cutIssues) {
  if (env.DRY || !amend || amend.decidedBy !== "release-driver") return;
  const { plan, record, gh } = ctx;
  for (const file of amend.deferredTickets || []) {
    const t = tickets.find(x => x.file === file); if (!t || !t.it || t.it.state !== "OPEN") continue;
    const r = (amend.reasons || {})[file] || {};
    try {
      if (!(t.it.comments || []).some(c => String(c.body || "").includes(CUT_MARKER(plan.id))) && !(ctx.state.cut_commented || []).includes(`${plan.id}#${t.issue}`)) {
        gh(["-X", "POST", `repos/${env.REPO}/issues/${t.issue}/comments`, "--input", "-"], JSON.stringify({ body: cutComment({ plan, rule: { words: amend.words }, cut: { dead: { rule: r.rule, why: r.why, codeMerged: r.codeMerged || [] } } }) }));
        ctx.state.cut_commented = [...(ctx.state.cut_commented || []), `${plan.id}#${t.issue}`].slice(-200);
      }
      if ((t.it.labels || []).includes(ctx.label)) { try { gh(["-X", "DELETE", `repos/${env.REPO}/issues/${t.issue}/labels/${encodeURIComponent(ctx.label)}`]); } catch (e) { if (!/404|not found/i.test(e.message)) throw e; } }
      if (!(t.it.labels || []).includes("needs-owner")) gh(["-X", "POST", `repos/${env.REPO}/issues/${t.issue}/labels`, "--input", "-"], JSON.stringify({ labels: ["needs-owner"] }));
    } catch (e) { record({ kind: "cut not marked on GitHub", release: plan.id, item: t.issue, why: String(e.message).slice(0, 200) }); }
  }
  void cutIssues;
}
function itemIssuesOf(plan) {
  const out = {};
  const line = String(plan || "").split(/\r?\n/).find(l => /\bIssues:/.test(l));
  if (!line) return out;
  for (const m of line.slice(line.indexOf("Issues:") + 7).matchAll(/(?:items?\s+)?(\d+)\s+#(\d+)/gi)) out[Number(m[1])] = Number(m[2]);
  return out;
}
function ticketFilesOf(plan) {
  if (plan.tickets) return plan.tickets;
  try { return fs.readdirSync(path.join(plan.dir, "tickets")).filter(f => f.endsWith(".md")).sort(); } catch { return []; }
}
