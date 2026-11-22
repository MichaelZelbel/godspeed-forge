// The feasibility gate (process.md, section 3; 18 November 2026). A feature enters an approved plan only
// when its ticket says where its data or service comes from and which check proves it. Michael rejected
// "contract watching" (a comparison of German electricity and insurance contracts) on 17 November because
// nobody had named a source for the prices: the gate stops that kind of feature before it is built.
//
//   Built with: <where the data or service comes from, named concretely: a web address, a protocol, or an
//                existing part of the product in backticks>
//   Proved by:  <the hidden check or scenario that proves it: existing, by name; or to be written, with the
//                tool it is written with>
//
// Bug tickets are exempt (header line "Type: bug.", or a release on the standing decision, which auto-plan writes and which holds only bug tickets).
// The gate applies to a plan approved on or after FEASIBILITY_FROM; earlier plans and plans with no approval date are left alone.
//
//   node scripts/release/feasibility.mjs [releases-dir]      checks every approved plan; exit 1 with the reasons
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FEASIBILITY_FROM = "2026-11-19";
const approved = (plan) => /^\s*status:\s*approved\b/im.test(String(plan || ""));
const approvedOn = (plan) => (String(plan || "").match(/^\s*status:\s*approved\b[^\n]*?(\d{4}-\d\d-\d\d)/im) || [])[1] || null;
export const isBugTicket = (text) => /\bType:\s*bug\b/i.test(String(text || "").split(/\r?\n/).slice(0, 3).join("\n"));
const line = (text, label) => (String(text).match(new RegExp(`^[ \t]*[-*]?[ \t]*${label}:[ \t]*(.*)$`, "im")) || [])[1];

const PLACEHOLDER = /^\W*(tbd|to be (decided|determined|found|defined|clarified)|unknown|n\/?a|none|nothing|\?+|some \w+|still open|later)\W*$/i;
// a backticked name counts only when it looks like a real name: no spaces, and a path, a file, a number, a
// camelCase or an acronym ("`public data`" and "`tests`" are words, not names)
const TICK = { test: (v) => [...String(v).matchAll(/`([^`]+)`/g)].some((m) => !/\s/.test(m[1]) && (/[./_:-]|\d/.test(m[1]) || /^[a-z]+[A-Z]|^[A-Z][a-z]+[A-Z]|^[A-Z][A-Z0-9]{2,}$/.test(m[1]))) };
const PROTOCOL = /\b(OAuth|RDAP|REST|GraphQL|IMAP|SMTP|SFTP|WebDAV|CalDAV|CardDAV|RSS|Atom|MQTT|WebSocket|gRPC|SOAP|OpenAPI|HTTPS?)\b/;
const URLISH = /\b(https?:\/\/\S+|[a-z0-9][a-z0-9-]*\.(com|org|net|de|io|dev|eu|app|gov|info|ai)\b)/i;
const PATHISH = /[\w.-]+\/[\w./-]+/;
const concreteSource = (v) => !PLACEHOLDER.test(v) && (TICK.test(v) || URLISH.test(v) || PATHISH.test(v) || PROTOCOL.test(v));
const namedProof = (v) => !PLACEHOLDER.test(v) && (TICK.test(v) || /\bH-\d+\b/.test(v) || PATHISH.test(v) || /\b[\w-]+\.(test\.mjs|sh|ps1|mjs)\b/.test(v));
const toBeWritten = (v) => /\bto be written|still to (be )?write|will be written|new (hidden )?(check|scenario)\b/i.test(v);
const namesTool = (v) => /\bwith\b[^.;]*(`[^`]+`|[\w-]+\/[\w./-]+)|\btool\b[^.;]*`[^`]+`|`[^`]+`[^.;]*\btool\b/i.test(v);

// plan: the plan.md text; tickets: [{name, text}] -> {ok, problems, skipped}
export function checkFeasibility(plan, tickets) {
  if (!approved(plan)) return { ok: true, problems: [], skipped: "the plan is not approved" };
  // a release that only fixes bugs starts on the standing decision of 17 November 2026 (auto-plan): bug tickets only.
  // Known limit: this trusts the status line; auto-plan's own check (every item comes from a bug source) is what keeps
  // a feature out of such a release.
  if (/^\s*status:\s*approved by standing decision\b/im.test(String(plan))) return { ok: true, problems: [], skipped: "a bug-fix release on the standing decision" };
  const on = approvedOn(plan);
  if (!on) return { ok: true, problems: [], skipped: "the plan has no approval date" };
  if (on < FEASIBILITY_FROM) return { ok: true, problems: [], skipped: "the plan was approved before the gate existed" };
  const problems = [];
  for (const { name, text } of tickets) {
    if (isBugTicket(text)) continue;
    const built = line(text, "Built with"), proved = line(text, "Proved by");
    if (built === undefined) problems.push(`${name} is a feature ticket and has no "Built with:" line: it must name, concretely, where its data or service comes from.`);
    else if (!concreteSource(built)) problems.push(`${name}: "Built with:" does not name its data source or service concretely (a web address, a protocol, or an existing part of the product in backticks).`);
    if (proved === undefined) problems.push(`${name} is a feature ticket and has no "Proved by:" line: it must name the hidden check or scenario that proves it, existing or to be written with its tool.`);
    else if (!namedProof(proved)) problems.push(`${name}: "Proved by:" does not name a hidden check or scenario (by its name, in backticks, or its file).`);
    else if (toBeWritten(proved) && !namesTool(proved)) problems.push(`${name}: "Proved by:" says its check is still to be written but not with which tool.`);
  }
  return { ok: problems.length === 0, problems, skipped: null };
}

export function checkReleasesDir(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const planFile = path.join(dir, d.name, "plan.md");
    if (!fs.existsSync(planFile)) continue;
    const tdir = path.join(dir, d.name, "tickets");
    const tickets = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((f) => f.endsWith(".md")).sort().map((f) => ({ name: f, text: fs.readFileSync(path.join(tdir, f), "utf8") })) : [];
    out.push({ id: d.name, ...checkFeasibility(fs.readFileSync(planFile, "utf8"), tickets) });
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "releases"));
  const results = checkReleasesDir(dir);
  let bad = 0;
  for (const r of results) {
    if (r.ok) continue;
    bad++;
    console.log(`${r.id}: refused`);
    for (const p of r.problems) console.log(`  ${p}`);
  }
  console.log(bad ? `${bad} approved plan(s) refused: a feature ticket must say what it is built with and what proves it.` : `feasibility gate: ${results.length} release folder(s) checked, none refused.`);
  process.exit(bad ? 1 : 0);
}
