// Acting on what a helper reported (2026-11-18, plan Task 6). Only the driver changes a release's
// state; a helper only reports. Michael's word always wins and is never overwritten.
//
//   decide, product   the decision it wrote is checked by a second, independent AI run (the release
//                     driver's secondCheck) and posted as "Manager decision (Mission Control, not
//                     Michael): ...", on the issue and pull request the obstacle names and nowhere else;
//                     needs-owner comes off exactly those. Nothing is posted when Michael wrote an owner
//                     decision there after the helper started. Everything technical (tests, checks, hidden
//                     scenarios and their judges, CI, tooling, process) is decided here and never reaches
//                     Michael. When the second check refuses a technical decision the next attempt is told
//                     why (`refusal` in the result; the driver writes it into the history the next brief
//                     reads); refused a second time, the driver posts the option that keeps every existing
//                     check exactly as it is (KEEP_CHECKS_DECISION) and moves on: no question to Michael,
//                     no other model. Only a product matter (what people get or see, scope, look and feel)
//                     goes to Michael, through the questions helper, in plain words.
//   michael           his question goes to the questions helper (askMichael). No default is ever applied
//                     for him: a question waits until he answers (applyDueDefaults only closes answered
//                     ones).
//   cut               the driver's own entry is added to releases/<id>/scope-amendment.json
//                     (mergeAmendment: every byte that was there stays), read again right before it is
//                     written, and Michael gets one sentence through notices.json.
//   tell-michael      one or two plain sentences through notices.json, once per key.
//   diagnose, feasibility, tests, ops  nothing to post: the ladder reads their reports.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { secondCheck, codexJson, tell, askMichael, loginOf, ownerLogin, trustedLogins, asManagerDecision, asQuestion, ownerOnlyReason, technicalWords, KEEP_CHECKS_DECISION } from "./release-driver/release-driver-owner-steps.mjs";
import { planCutRule, planItemNames, ticketItem, versionWords } from "./release-driver/release-driver-cut.mjs";

const HOUR = 3600 * 1000;
const iso = ms => new Date(ms).toISOString();
const short = t => String(t || "").replace(/\s+/g, " ").trim();
const utc = ms => `${iso(ms).slice(0, 16).replace("T", " ")} UTC`;
export const DRIVER = "factory-driver";
export const MARKER_PREFIX = "factory-driver:";
export const actMarker = id => `<!-- ${MARKER_PREFIX}${id} -->`;
const HANDLED = ["decided", "repaired", "narrowed"];
// Since 2026-11-19 a question has no deadline that decides anything: it waits for Michael (a default
// applied in his name was read by the loop as his word). The old names stay so a helper that still
// reports a deadline or a default is read, and ignored.
export const DEADLINE_HOURS = { min: 4, max: 72, dflt: 12 };
// What these functions read from env. NOTICES_FILE unset: tell() uses Godspeed's notice queue
// (<GODSPEED_DIR>/.godspeed/notices.json), the one path by which a program reaches Michael's chat.
// MODEL, FORGE_USER and FORGE_NETNS: the second check's Codex run as the factory user, in its namespace.
export const actDefaults = (e = process.env) => ({
  REPO: e.FD_REPO || "owner/repository",
  STATE_DIR: e.FD_STATE_DIR || "/var/lib/godspeed/forge/driver",
  QUESTIONS_DIR: e.FD_QUESTIONS_DIR || "/var/lib/godspeed/forge/questions",
  GODSPEED_DIR: e.FD_GODSPEED_DIR || "",
  NOTICES_FILE: e.FD_NOTICES_FILE,
  MODEL: e.FD_CHECK_MODEL || "gpt-5.6-terra",
  FORGE_USER: e.FORGE_USER || "factory",
  FORGE_NETNS: e.FD_FORGE_NETNS !== undefined ? e.FD_FORGE_NETNS : "",
});
// Plain words for Michael: no em or en dashes, ever.
export const plain = t => String(t || "").replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- the amendment (pure)
// The value spans of a JSON object's top-level keys in `text`: {key: [start, end)}, plus where the
// object closes. Strings and nesting respected; null when the text is not one object.
function topLevel(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const str = () => { const s = i; i++; while (i < text.length && text[i] !== "\"") i += text[i] === "\\" ? 2 : 1; i++; return JSON.parse(text.slice(s, i)); };
  const value = () => {
    if (text[i] === "\"") { str(); return; }
    if (text[i] === "{" || text[i] === "[") {
      let depth = 0;
      for (; i < text.length; i++) {
        const c = text[i];
        if (c === "\"") { str(); i--; continue; }
        if (c === "{" || c === "[") depth++;
        else if ((c === "}" || c === "]") && --depth === 0) { i++; return; }
      }
      throw new Error("unbalanced");
    }
    while (i < text.length && !/[,}\]\s]/.test(text[i])) i++;
  };
  try {
    ws(); if (text[i] !== "{") return null; i++;
    const keys = {};
    let first = null;
    for (;;) {
      ws();
      if (text[i] === "}") return { keys, close: i, first };
      const keyAt = i;
      const k = str(); ws(); if (text[i] !== ":") return null; i++; ws();
      const s = i; value(); keys[k] = [s, i, keyAt];
      if (first === null) first = keyAt;
      ws(); if (text[i] === ",") { i++; continue; } if (text[i] === "}") return { keys, close: i, first }; return null;
    }
  } catch { return null; }
}
const indentAt = (text, at) => { const line = text.lastIndexOf("\n", at - 1) + 1; return text.slice(line, at).match(/^[ \t]*/)[0]; };
const lastSolid = (text, before) => { let p = before - 1; while (p >= 0 && /\s/.test(text[p])) p--; return p; };
// Every ticket a scope-amendment.json defers, in either of its shapes (godspeed-dev scope-amendment.mjs).
export const deferredIn = file => [...(file && Array.isArray(file.deferredTickets) ? file.deferredTickets : []),
  ...(file && Array.isArray(file.amendments) ? file.amendments.flatMap(a => (a && Array.isArray(a.deferredTickets) ? a.deferredTickets : [])) : [])];
// The scope-amendment.json text with one more entry in its `amendments` array. Everything that was in
// the file stays byte for byte (Michael's entry, the release driver's flat entry, every other one):
// the entry is inserted as text, never by rewriting the file. Unchanged when every ticket of the entry
// is already deferred. existingJson: the file's text (or null when there is none).
export function mergeAmendment(existingJson, entry) {
  const fresh = () => `${JSON.stringify({ release: entry.release, version: entry.version, amendments: [entry] }, null, 2)}\n`;
  if (existingJson === null || existingJson === undefined || !String(existingJson).trim()) return fresh();
  const text = typeof existingJson === "string" ? existingJson : `${JSON.stringify(existingJson, null, 2)}\n`;
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("scope-amendment.json is not JSON, so nothing is added to it"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("scope-amendment.json is not one object, so nothing is added to it");
  const already = deferredIn(parsed);
  if ((entry.deferredTickets || []).every(t => already.includes(t))) return text;
  const top = topLevel(text);
  if (!top) throw new Error("scope-amendment.json could not be read as text, so nothing is added to it");
  if (top.first === null) return fresh(); // "{}"
  const nl = text.includes("\r\n") ? "\r\n" : "\n"; // the file's own line ends (a Windows checkout)
  const keyIndent = indentAt(text, top.first) || "  ";
  const unit = keyIndent.length ? keyIndent : "  ";
  let out;
  const span = top.keys.amendments;
  if (span) {
    if (!Array.isArray(parsed.amendments)) throw new Error("scope-amendment.json has an `amendments` that is not a list, so nothing is added to it");
    const [s, e] = span; // "[ ... ]"
    const inner = text.slice(s + 1, e - 1);
    const outer = indentAt(text, span[2]);
    const firstEl = inner.search(/\S/);
    const elIndent = firstEl >= 0 ? indentAt(text, s + 1 + firstEl) : outer + unit;
    const body = JSON.stringify(entry, null, unit.length).split("\n").join(`${nl}${elIndent}`);
    if (firstEl < 0) out = `${text.slice(0, s + 1)}${nl}${elIndent}${body}${nl}${outer}${text.slice(e - 1)}`;
    else { const p = lastSolid(text, e - 1) + 1; out = `${text.slice(0, p)},${nl}${elIndent}${body}${text.slice(p)}`; }
  } else {
    const p = lastSolid(text, top.close) + 1;
    const body = JSON.stringify(entry, null, unit.length).split("\n").join(`${nl}${keyIndent}${unit}`);
    out = `${text.slice(0, p)},${nl}${keyIndent}"amendments": [${nl}${keyIndent}${unit}${body}${nl}${keyIndent}]${text.slice(p)}`;
  }
  const check = JSON.parse(out); // what was written must read back as the old file plus this one entry
  const want = { ...parsed, amendments: [...(Array.isArray(parsed.amendments) ? parsed.amendments : []), entry] };
  if (JSON.stringify(check) !== JSON.stringify(want)) throw new Error("adding to scope-amendment.json would change what was there, so nothing is added");
  return out;
}
// The driver's own entry for one ticket that leaves the release under the plan's dead-end rule.
// rule: planCutRule(plan) (the rule's sentence as the plan has it, and its Status line).
export function cutEntry({ id, version, rule, file, item, issue, url, title, why, evidence = [], now }) {
  return {
    release: id, version, decidedBy: DRIVER, authority: "plan-rule", words: rule.words,
    approvalRef: `releases/${id}/plan.md: ${rule.statusLine}`, approvedAt: rule.approvedAt, decidedAt: iso(now),
    deferredTickets: [file],
    reason: `Under the approved plan's rule (an item that reaches a dead end leaves the release, the rest ships), Mission Control's factory driver moved ${file} (#${issue}) to the next release: ${short(why)}. Everything else ships as planned.`,
    reasons: { [file]: { item, issue, ...(url ? { url } : {}), ...(title ? { title } : {}), why: short(why), decidedAt: iso(now), evidence: (evidence.length ? evidence : [short(why)]).map(e => (typeof e === "string" ? short(e) : e)) } },
  };
}

// ---------------------------------------------------------------- GitHub helpers
const DECISION_HEAD = /^[\s#>*_`~]*owner\s+decision\b/i;
// Owner decisions Michael wrote on issue n since `since` (ISO). -> [comment]
function michaelSince(gh, repo, n, since) {
  const rows = [];
  for (let p = 1; p <= 10; p++) {
    const page = gh([`repos/${repo}/issues/${n}/comments?since=${encodeURIComponent(since)}&per_page=100&page=${p}`]) || [];
    rows.push(...page); if (page.length < 100) break;
  }
  return rows.filter(c => loginOf(c.user && c.user.login) === ownerLogin() && String(c.created_at || "") >= String(since).slice(0, 19) && DECISION_HEAD.test(String(c.body || "")));
}
const removeLabel = (gh, repo, n, label) => { try { gh(["-X", "DELETE", `repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`]); } catch (e) { if (!/404|not found|does not exist/i.test(e.message)) throw e; } };

// ---------------------------------------------------------------- applying one report
// deps: {gh(args, input), kind, id (marker id: the helper's unit), startedAt (ISO), now(), check(args),
//        codex(prompt, schema), records {read(rel), write(files, msg), fetch?(), ticketFiles?(id)},
//        parentText(commit, rel), plan, state (for notices said once), title}
// -> {done: [string], skipped: [string], failed: [string]}
export async function applyReport(env0, obstacle, report, deps = {}) {
  const out = { done: [], skipped: [], failed: [] };
  // an obstacle of another factory project (Querino, the forge) acts on that project's repository
  const env = obstacle && obstacle.repo ? { ...env0, REPO: obstacle.repo } : env0;
  const kind = deps.kind || (report && (report.kind || report.helper)) || "";
  const now = deps.now ? deps.now() : Date.now();
  if (!report || typeof report !== "object") { out.skipped.push("no report to act on"); return out; }
  try {
    if (kind === "decide") {
      if (short(report.decision)) await postDecision(env, obstacle, report.decision, report, deps, out, now, report.cause === "what" ? "the helper itself found a question of what the software does for its people" : "");
      else out.skipped.push(`the decide helper posted nothing to decide${short(report.product_choice) ? " (it found a product choice: that is Michael's)" : ""}`);
    } else if (kind === "product") {
      const mine = n => Number.isInteger(n) && n > 0 && (n === obstacle.issue || n === obstacle.pr);
      for (const it of Array.isArray(report.items) ? report.items : []) {
        if (!HANDLED.includes(it.action) || !short(it.decision)) continue;
        if (!mine(it.item) && !mine(it.pr)) { out.skipped.push(`a decision about #${it.item} is not about this obstacle's #${obstacle.issue || obstacle.pr}; not posted`); continue; }
        await postDecision(env, obstacle, it.decision, report, deps, out, now, report.cause === "what" ? "the helper itself found a question of what the software does for its people" : "");
      }
      if (!out.done.length && !out.failed.length && !out.skipped.length) out.skipped.push("the product helper reported no decision to post");
    } else if (kind === "michael") ask(env, obstacle, report, deps, out, now);
    else if (kind === "cut") await cut(env, obstacle, report, deps, out, now);
    else if (kind === "tell-michael") {
      const text = plain(report.text || report.sentence);
      if (!text) out.skipped.push("nothing to tell Michael");
      else if (notify(env, { ...deps, ref: report.ref || null }, report.key || `tell:${obstacle.id}`, text, report.about || "The factory", now)) out.done.push(`told Michael: ${text}`);
      else out.skipped.push("Michael was told this already");
    } else out.skipped.push(`a ${kind || "helper"} report changes nothing on GitHub; the ladder reads it`);
  } catch (e) { out.failed.push(short(e.message).slice(0, 300)); }
  return out;
}

// A product question for Michael (what people get or see, scope, look and feel), from a decision a helper
// wanted to make: through the questions helper in plain words, with no default and no deadline, and the
// item stays needs-owner. Nothing is posted to GitHub in his name.
function toMichael(env, obstacle, targets, why, text, report, deps, out, now) {
  const issue = Number.isInteger(obstacle.issue) && obstacle.issue > 0 ? obstacle.issue : targets[0];
  const what = short(String(text || report.product_choice || report.summary || "").replace(/^[\s#>*_`~]*(?:owner|manager)\s+(?:decision|question|repair)\b(?:\s*\([^)]*\))?\s*[:.-]*\s*/i, ""));
  const body = plain(`A question about the product (${why}). Nothing is decided until you answer, and the item waits for you. What Mission Control would do: ${what.slice(0, 1500)}`);
  // the reference keeps this question apart from an earlier, answered one on the same item (the relay keys by heading)
  const ref = crypto.createHash("sha1").update(`${why}|${what}`).digest("hex").slice(0, 8);
  const heading = `${short(deps.title || what).slice(0, 80)} (#${issue}, ref ${ref})`;
  out.asked = true;
  if (!askMichael(env, { repo: env.REPO, issue, heading, body, now })) { out.skipped.push(`Michael was already asked about #${issue}; nothing is posted in his name`); return; }
  out.done.push(`#${issue} goes to Michael, a product question: ${why}`);
}

async function postDecision(env, obstacle, text, report, deps, out, now, flagged = "") {
  let targets = [...new Set([obstacle.issue, obstacle.pr].filter(n => Number.isInteger(n) && n > 0))];
  // an idle factory has no item of its own: the decision goes on the one parked board item the helper
  // named, and only when that item is on the board the round read (never anywhere else)
  if (!targets.length && Array.isArray(obstacle.board)) {
    const n = Number(report.item);
    if (Number.isInteger(n) && obstacle.board.includes(n)) targets = [n];
    else { out.skipped.push(`#${report.item} is not one of the parked items of ${obstacle.project || "the factory"}'s board; no decision is posted`); return; }
  }
  if (!targets.length) { out.skipped.push("the obstacle names no issue or pull request; no decision is posted"); return; }
  const decision = asManagerDecision(text);
  // Michael's word wins: an owner decision of his that came after the helper started stands alone
  const since = deps.startedAt || report.startedAt;
  if (since) for (const n of targets) {
    const his = michaelSince(deps.gh, env.REPO, n, since);
    if (his.length) { out.skipped.push(`Michael decided on #${n} since the helper started (${his.at(-1).html_url || his.at(-1).created_at}); his decision stands, nothing is posted`); return; }
  }
  // a product matter (what people get or see, scope, look and feel) is Michael's, check or no check
  // (a helper's own `what` only counts when the words are not the machinery's: a test or a judge is never Michael's)
  // an item whose decision the check already refused once is a technical item by definition: it never turns into a question for Michael on the retry
  const refusals = deps.state ? (deps.state.refusals ||= {}) : {};
  const only = technicalWords(deps.title) || refusals[obstacle.id] || (deps.state && deps.state.technical && deps.state.technical[obstacle.id]) ? "" : (flagged && !technicalWords(text) ? flagged : "") || ownerOnlyReason(text);
  if (only) { toMichael(env, obstacle, targets, only, text, report, deps, out, now); return; }
  if (!short(text)) { out.skipped.push("the decide helper posted nothing to decide"); return; }
  const check = (deps.check || (a => secondCheck(env, a, { codex: deps.codex || ((p, s) => codexJson(env, p, s)) })))({
    decision, item: { number: obstacle.issue || obstacle.pr, title: deps.title || "" },
    context: [short(report.summary), ...(obstacle.evidence || [])].filter(Boolean).join("\n") });
  let posted = decision, why = `second check: ${short(check.reason).slice(0, 200)}`;
  if (!check.approve) {
    // no answer from the check at all (no AI reachable): nothing was judged, the next round asks again
    if (check.trouble) { out.failed.push(`the second check could not answer (${short(check.reason).slice(0, 200)}); nothing posted`); return; }
    // the first refusal: the next attempt is told why (the driver puts `refusal` into the history its brief reads)
    // two refused entries of one report are one refusal: the second chance is a later attempt, with the reason in its brief
    if (out.refusal || out.fallback) { out.skipped.push("a decision of this report was already refused; counted once"); return; }
    refusals[obstacle.id] = (refusals[obstacle.id] || 0) + 1;
    if (refusals[obstacle.id] < 2) { out.refusal = short(check.reason).slice(0, 400); out.skipped.push(`the second check refused the decision (${short(check.reason).slice(0, 200)}); one more attempt, told why`); return; }
    // refused twice: the option that keeps every existing check exactly as it is, and move on (no question to Michael, no other model)
    out.fallback = true; posted = KEEP_CHECKS_DECISION; why = `refused twice by the second check (${short(check.reason).slice(0, 150)}); every existing check stays as it is`;
  }
  const body = `${posted}\n${actMarker(deps.id || obstacle.id)}`;
  for (const n of targets) {
    deps.gh(["-X", "POST", `repos/${env.REPO}/issues/${n}/comments`, "--input", "-"], JSON.stringify({ body }));
    removeLabel(deps.gh, env.REPO, n, "needs-owner");
  }
  if (deps.state && deps.state.technical) delete deps.state.technical[obstacle.id];
  delete refusals[obstacle.id]; // only after every post and label change went through: a failure leaves the count, so the next attempt posts again
  out.done.push(`posted a manager decision on ${targets.map(n => `#${n}`).join(" and ")} and took needs-owner off there (${why})`);
}

// One message to Michael through notices.json, once per key (the release driver's tell).
export function notify(env, deps, key, text, about, now) {
  const state = deps.state || readState(env);
  // THE FUNNEL: every message to the owner passes the gate. A request that did not come through it (deps.gated) is only filed as pending; the driver's
  // flush sends it once the same request has stood on 3 readings 10 minutes apart and a fresh re-read confirms it (gate.mjs).
  if (!deps.gated) {
    if (!(state.told && state.told[key])) (state.pendingNotices ||= {})[key] ||= { text: plain(text), about, firstAt: now, ref: deps.ref || null };
    if (!deps.state) writeState(env, state);
    return false;
  }
  const said = tell(env, state, key, plain(text), about, now);
  if (!deps.state) writeState(env, state);
  return said;
}
const stateFile = env => path.join(env.STATE_DIR, "told.json");
const readState = env => { try { return JSON.parse(fs.readFileSync(stateFile(env), "utf8")); } catch { return {}; } };
function writeState(env, s) { fs.mkdirSync(path.dirname(stateFile(env)), { recursive: true }); const t = `${stateFile(env)}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(s, null, 2) + "\n"); fs.renameSync(t, stateFile(env)); }

function ask(env, obstacle, r, deps, out, now) {
  if (r.ask === false) { out.skipped.push("the michael helper found nothing only Michael can decide"); return; }
  const issue = obstacle.issue || r.item;
  const question = plain(r.question);
  if (!question || !Number.isInteger(issue) || issue <= 0) { out.failed.push("the question for Michael lacks its words or its issue; nothing asked"); return; }
  // a question in the machinery's words is a technical matter: not asked, and the next attempt is told to decide it itself
  if (technicalWords(question, r.options, r.recommendation, r.comment, deps.title)) { if (deps.state) (deps.state.technical ||= {})[obstacle.id] = true; out.refusal = "that question is about tests, checks or tooling, which Mission Control decides itself and never asks Michael"; out.skipped.push("the question is technical; Michael is not asked"); return; }
  const options = (Array.isArray(r.options) ? r.options : []).map(plain).filter(Boolean);
  const body = [question, options.length ? options.map((o, i) => `${i + 1}. ${o}`).join("\n") : "", r.recommendation ? `Recommended: ${plain(r.recommendation)}` : "",
    "Nothing is decided until you answer: no default applies and the item waits for you."].filter(Boolean).join("\n\n");
  const heading = `${short(deps.title || question).slice(0, 80)} (#${issue})`;
  if (!askMichael(env, { repo: env.REPO, issue, heading, body, now })) { out.skipped.push(`Michael was already asked about #${issue}`); return; }
  if (short(r.comment) && deps.gh) {
    const q = asQuestion(r.comment);
    try { deps.gh(["-X", "POST", `repos/${env.REPO}/issues/${issue}/comments`, "--input", "-"], JSON.stringify({ body: `${q}\n\nNothing is decided until he answers; no default applies.\n${actMarker(deps.id || obstacle.id)}` })); }
    catch (e) { out.failed.push(`the question could not be noted on #${issue}: ${short(e.message).slice(0, 200)}`); }
  }
  out.done.push(`asked Michael about #${issue}; it waits for his answer`);
}

// The text git has for rel in the commit before `commit` (what the write was based on), or null.
function parentTextGit(records, commit, rel) {
  if (!records.root) return null;
  const r = spawnSync("git", ["-C", records.root, "show", `${commit}^:${rel}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}
async function cut(env, obstacle, r, deps, out, now) {
  const key = String(obstacle.ticketKey || "");
  const at = key.lastIndexOf("#");
  const id = at > 0 ? key.slice(0, at) : "", item = Number(key.slice(at + 1));
  if (!id || !Number.isInteger(item)) { out.failed.push("a cut needs the ticket's release and item; nothing cut"); return; }
  const records = deps.records;
  if (!records) { out.failed.push("the release records cannot be reached; nothing cut"); return; }
  const plan = deps.plan || records.read(`releases/${id}/plan.md`) || "";
  const rule = planCutRule(plan);
  if (!rule) { out.failed.push(`the approved plan of ${id} does not hold the rule "an item that reaches a dead end leaves the release, the rest ships"; nothing cut`); return; }
  const files = (deps.ticketFiles || (x => (records.ticketFiles ? records.ticketFiles(x) : [])))(id).map(f => path.posix.basename(f));
  const file = files.find(f => ticketItem(f) === item);
  if (!file) { out.failed.push(`${id} has no ticket file for item ${item}; nothing cut`); return; }
  const version = (/(\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+(?:\.\d+)*)?)/.exec(id) || [])[1] || "";
  const why = short(r.why || r.blocking_requirement || r.summary || "two different attempts failed because of the feature itself, and the feasibility check found it cannot be built as asked");
  const entry = cutEntry({ id, version, rule, file, item, issue: obstacle.issue, url: obstacle.issue ? `https://github.com/${env.REPO}/issues/${obstacle.issue}` : "", title: deps.title || "", why,
    evidence: [...(Array.isArray(r.evidence) ? r.evidence : []), ...(obstacle.evidence || [])].slice(0, 12), now });
  const rel = `releases/${id}/scope-amendment.json`;
  const msg = `${version}: ${file} moves to the next release (factory driver, the plan's dead-end rule)`;
  // read right before writing (Michael may have written since the helper started), and when the
  // write landed on a different file than the one read (someone pushed between), merge again on top
  let wrote = null;
  if (records.fetch) records.fetch();
  let base = records.read(rel);
  if (base === undefined) base = null;
  // never cut a release down to nothing (freeze's reader refuses that too): some other ticket stays in
  let already = [];
  try { already = base ? deferredIn(JSON.parse(base)).map(f => path.posix.basename(String(f))) : []; } catch { /* mergeAmendment refuses broken JSON below */ }
  if (!files.some(f => f !== file && !already.includes(f))) { out.failed.push(`moving ${file} out would leave ${id} with nothing to ship; nothing cut`); return; }
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (base !== null && deferredIn(JSON.parse(base)).includes(file)) { if (!wrote) { out.skipped.push(`${file} is already out of ${id}`); return; } break; }
    const commit = records.write({ [rel]: mergeAmendment(base, entry) }, msg);
    if (!commit) { wrote = wrote || "unchanged"; break; }
    wrote = commit;
    // Records.write retries on its own when someone pushed first, with the text it was given, so a
    // change made between this read and that write would be lost: the commit's parent says what the
    // file held when it landed; when that is not what was merged, merge onto it and write again
    const parent = (deps.parentText || ((c, p) => parentTextGit(records, c, p)))(commit, rel);
    if (parent === null || parent === base) break;
    base = parent;
  }
  out.done.push(`${file} (#${obstacle.issue}) leaves ${id} under the plan's dead-end rule (${wrote})`);
  const name = planItemNames(plan)[item] || short(deps.title) || `item ${item}`;
  const sentence = `${versionWords(version)} goes on your server without "${name}", because it could not be built as asked; it moves to the next release. Whether it should be in this one after all is your call.`;
  if (notify(env, deps, `cut:${id}:${file}`, sentence, `${versionWords(version)} ships without one item`, now)) out.done.push(`told Michael: ${sentence}`);
  // on GitHub: one comment, the release label off, needs-owner on (the next release's plan picks it up)
  if (deps.gh && obstacle.issue) {
    const label = version.includes("-") ? version.slice(version.indexOf("-") + 1) : version;
    try {
      deps.gh(["-X", "POST", `repos/${env.REPO}/issues/${obstacle.issue}/comments`, "--input", "-"], JSON.stringify({ body: `Moved to the next release by Mission Control's factory driver: ${why}. The approved plan of ${versionWords(version)} says "an item that reaches a dead end leaves the release, the rest ships". The issue stays open for the next release's plan.\n${actMarker(`cut:${id}`)}` }));
      removeLabel(deps.gh, env.REPO, obstacle.issue, label);
      deps.gh(["-X", "POST", `repos/${env.REPO}/issues/${obstacle.issue}/labels`, "--input", "-"], JSON.stringify({ labels: ["needs-owner"] }));
    } catch (e) { out.failed.push(`the cut could not be marked on #${obstacle.issue}: ${short(e.message).slice(0, 200)}`); }
  }
}

// ---------------------------------------------------------------- questions he has answered
// Questions the driver asked Michael (driver-questions.json): an answer since the question (his owner
// decision, or the questions helper's verbatim relay of it) removes it. A deadline, or a default an
// older helper still wrote, decides nothing: until 2026-11-19 the default was posted as an owner decision
// once the deadline passed, and the loop read it as his word. Now the question just stays until he
// answers. (The name is the old one; `applied` stays empty for the callers that still read it.)
// -> {done, skipped, failed, applied: []}
export async function applyDueDefaults(env, deps = {}) {
  const out = { done: [], skipped: [], failed: [], applied: [] };
  const now = deps.now ? deps.now() : Date.now();
  const file = path.join(env.QUESTIONS_DIR, "driver-questions.json");
  let data; try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return out; }
  // every repository the driver asked about (the main project, the forge, Querino), each in its own
  let changed = false;
  for (const repo of Object.keys(data)) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Array.isArray(data[repo])) continue;
    const renv = { ...env, REPO: repo };
    const list = data[renv.REPO] || [];
    const keep = [];
    for (const q of list) {
      if (!q || !Number.isInteger(Number(q.issue))) { keep.push(q); continue; }
      const n = Number(q.issue);
      let answered = false;
      try {
        const rows = deps.gh([`repos/${renv.REPO}/issues/${n}/comments?since=${encodeURIComponent(q.at)}&per_page=100`]) || [];
        answered = rows.some(c => String(c.created_at || "") >= String(q.at).slice(0, 19) && DECISION_HEAD.test(String(c.body || "")) && !String(c.body || "").includes(MARKER_PREFIX)
          && trustedLogins().includes(loginOf(c.user && c.user.login)));
      } catch (e) { out.failed.push(`#${n}: its answer could not be read (${short(e.message).slice(0, 150)}); asked again next round`); keep.push(q); continue; }
      if (answered) { out.done.push(`#${n}: Michael answered; the question is closed`); continue; }
      // no deadline decides anything for him: an unanswered question stays until he answers (2026-11-19)
      keep.push(q);
    }
    if (keep.length !== list.length) { data[repo] = keep; changed = true; }
  }
  if (changed) {
    const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n"); fs.renameSync(tmp, file);
  }
  return out;
}
