// Who may take a ticket out of a release, and how that is read. One reader for freeze (scope-gate.mjs),
// auto-stage.mjs and the message to the maintainer, so they cannot disagree.
//
// Two kinds of decision live in releases/<id>/scope-amendment.json:
//   1. a person's (approvedBy "Michael", his words, his approval), the flat shape that has always existed;
//   2. the release driver's, under the plan's own rule "an item that reaches a dead end leaves the
//      release, the rest ships": decidedBy "release-driver", authority "plan-rule", the rule line
//      quoted verbatim in `words`, `approvalRef` (plan path plus its Status line), `deferredTickets`
//      and `reasons` (per ticket, the evidence).
// The driver adds to the same file over time, so the file may carry the flat entry (a person's, or a
// driver's) and an `amendments` array of further entries. Reading it means: the flat entry, if it has
// `deferredTickets`, plus every element of `amendments`. Each entry stands or falls on its own; the
// deferred tickets are the union of the entries that stand. The old flat file still reads unchanged.
// Why an array and not a rewritten flat file: a person's entry must stay byte for byte what he approved,
// and the driver must never be able to overwrite it when it adds its own.

import path from "node:path";
import { cfg } from "./config.mjs";

const PLAN_APPROVED = /^status:\s*approved\b/im;

export function amendmentEntries(file) {
  if (!file || typeof file !== "object") return [];
  const out = [];
  if (Array.isArray(file.deferredTickets)) out.push({ ...file, amendments: undefined });
  if (Array.isArray(file.amendments)) {
    for (const a of file.amendments) {
      if (a && typeof a === "object") out.push({ release: file.release, version: file.version, ...a, fromArray: true });
    }
  }
  return out;
}

// The drivers that may move a ticket under the plan's rule: the release driver (retired 2026-11-18), auto-stage
// (its own re-freeze), and the factory driver that replaced the release driver (2026-11-18).
export const DRIVERS = ["release-driver", "auto-stage", "factory-driver"];
export const isDriverEntry = (e) => !!e && DRIVERS.includes(e.decidedBy);

export const baseVersionOf = (id) => (String(id).match(/(\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+(?:\.\d+)*)?)/) || [])[1];

// A driver entry's problem in plain words, or null when it stands.
export function driverProblem(e, { id, version, plan, ticketNames }) {
  if (e.authority !== "plan-rule") return `a decision by the release driver names no plan rule as its authority`;
  if (!PLAN_APPROVED.test(plan || "")) return `the plan of ${id} is not approved, so no plan rule can move a ticket out of it`;
  const squash = (t) => String(t || "").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
  const words = squash(e.words);
  // The plan hard-wraps its lines, so the quote is compared with whitespace collapsed; it must be the
  // dead-end rule itself and long enough to be a sentence, not a fragment that happens to occur.
  if (words.length < 30 || !/dead end/i.test(words)) return `a decision by the release driver does not quote the plan's dead-end rule`;
  if (!squash(plan).includes(words)) return `the rule a decision by the release driver quotes is not in the plan of ${id}`;
  if (typeof e.approvalRef !== "string" || e.approvalRef.trim().length < 8) return `a decision by the release driver does not say which approved plan it rests on`;
  // A re-freeze (2.0.0-beta.26.1) belongs to the folder of the version it re-freezes (2.0.0-beta.26): both count.
  const base = (String(id).match(/(\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+(?:\.\d+)*)?)/) || [])[1];
  if (e.release !== id || (e.version !== undefined && e.version !== version && e.version !== base)) return `a decision by the release driver is for another release than ${id}`;
  const d = e.deferredTickets;
  if (!Array.isArray(d) || !d.length || d.some((n) => typeof n !== "string") || new Set(d).size !== d.length) return `a decision by the release driver does not name its tickets once each`;
  const unknown = d.filter((n) => !ticketNames.includes(n));
  if (unknown.length) return `a decision by the release driver names a ticket the release does not have (${unknown.join(", ")})`;
  const r = e.reasons;
  // Evidence is a sentence, a list of sentences, or the driver's record: {why, evidence: [...]}.
  const text = (x) => typeof x === "string" && x.trim().length > 0;
  const said = (v) => text(v) || (Array.isArray(v) && v.some((x) => text(x) || (x && typeof x === "object" && (text(x.url) || text(x.words) || text(x.what)))))
    || (!!v && typeof v === "object" && !Array.isArray(v) && text(v.why) && Array.isArray(v.evidence) && v.evidence.length > 0 && said(v.evidence));
  if (!r || typeof r !== "object" || d.some((n) => !said(r[n]))) return `a decision by the release driver gives no evidence for every ticket it moves`;
  return null;
}

// A person's entry's problem, or null. Same checks freeze always made.
export function personProblem(e, { id, version }) {
  const d = e.deferredTickets;
  // A re-freeze (2.0.0-beta.26.1) is the same release as the folder's version (2.0.0-beta.26): his decision still stands.
  const base = baseVersionOf(id);
  const ok = e.release === id && (e.version === version || e.version === base) && e.approvedBy === cfg.ownerName &&
    typeof e.words === "string" && e.words.trim() && typeof e.approvalRef === "string" && e.approvalRef.trim().length >= 8 &&
    !Number.isNaN(Date.parse(e.approvedAt)) && Array.isArray(d) && new Set(d).size === d.length;
  return ok ? null : "a scope amendment lacks his name, his words, his approval or its date";
}

// -> {deferred: [file names that stand], byDriver: whether a driver entry stands, problems: [plain reasons for entries that do not]}
// strictPerson false: a person's entry is taken as written (auto-stage; freeze checks it itself).
export function readDeferrals(file, ctx, { strictPerson = true } = {}) {
  const deferred = [];
  const problems = [];
  let byDriver = false;
  const ticketNames = ctx.ticketNames.map((n) => path.basename(n));
  for (const e of amendmentEntries(file)) {
    // An entry in the array that names neither a person nor the driver (a typo in decidedBy) never stands.
    const problem = isDriverEntry(e) ? driverProblem(e, { ...ctx, ticketNames })
      : e.fromArray && !e.approvedBy ? "a scope amendment names no one who decided it"
      : strictPerson ? personProblem(e, ctx) : null;
    if (problem) problems.push(problem);
    else {
      if (isDriverEntry(e)) byDriver = true;
      for (const n of e.deferredTickets) if (!deferred.includes(n)) deferred.push(n);
    }
  }
  return { deferred, problems, byDriver };
}

// The release driver never cuts a release down to nothing: some ticket stays in it. (Callers have already made sure
// every ticket that stays is finished.)
export const leavesSomething = (deferred, ticketNames) => ticketNames.map((n) => path.basename(n)).some((n) => !deferred.includes(n));

// "item 2 (A chat says plainly...)" for each deferred ticket, from the plan's own numbered line.
export function deferredWords(plan, deferred) {
  const lines = String(plan || "").split(/\r?\n/);
  return deferred.map((name) => {
    const n = (path.basename(name).match(/^(\d+)/) || [])[1];
    if (!n) return `the ticket ${name}`;
    const line = lines.find((l) => new RegExp(String.raw`^${Number(n)}\.\s`).test(l));
    const title = line && (line.match(/\*\*(.+?)\*\*/) || [])[1];
    return title ? `item ${Number(n)} (${title.replace(/[.\s]+$/, "")})` : `item ${Number(n)}`;
  });
}
