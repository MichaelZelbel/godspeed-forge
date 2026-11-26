// Which factory questions page the owner (2026-11-24, his standing instruction): only the highest severity,
// as on-call paging does it (PagerDuty, Opsgenie: only a critical incident pages a person; everything below it is
// handled and logged). A question pages only when the action Mission Control would take for it would itself
//   money    spend money or raise a spending limit, subscription or paid plan,
//   publish  publish, go live, post publicly or send anything to people other than the owner,
//   delete   irreversibly delete people's data or accounts.
// Nothing else ever pages: scope, the mission (the option that keeps it is taken), look and feel, product behaviour,
// wording, privacy-facing behaviour, tests, checks and laps are decided by Mission Control at once with the
// manager's recommendation, or with none, the most reversible option.
//
// Plain code: a fixed word list per category (page-words.json), no model, so the rule is the same on every run
// and can be read and tested.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickOption, parseOptions } from "./choices.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORDS = JSON.parse(fs.readFileSync(path.join(HERE, "page-words.json"), "utf8"));
export const CATEGORIES = Object.keys(WORDS).filter(k => !k.startsWith("_"));
const compiled = Object.fromEntries(CATEGORIES.map(c => [c, WORDS[c].patterns.map(p => new RegExp(p, "gi"))]));
// a negation right before the words turns them around ("do not publish it yet", "without spending money"); only a
// tight one counts, a few words at most, so a "no" earlier in the sentence never hides an action that pages
const NEGATED = /\b(?:not|never|don'?t|doesn'?t|won'?t|without|instead of|rather than|avoid|avoids|avoiding|refuse to|stop)\s+(?:\w+\s+){0,2}$/i;

// -> {category, why, matched} for the first category a text hits, else null
export function categoryOf(text) {
  const t = String(text || "").replace(/\s+/g, " ");
  for (const c of CATEGORIES) for (const re of compiled[c]) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(t));) {
      if (!NEGATED.test(t.slice(Math.max(0, m.index - 40), m.index))) return { category: c, why: WORDS[c].why, matched: m[0] };
      if (!m[0].length) re.lastIndex++;
    }
  }
  return null;
}

// The text that says what would be done: the option Mission Control would take and the manager's recommendation.
// A recommendation naming an option the text does not list is read together with the heading and every option,
// so an unreadable list never hides a dangerous action.
export function actionText(q, pick = pickOption(q)) {
  if (!pick) return String(q.heading || "");
  if (pick.labelUnresolved) return [q.heading, pick.recommendation, ...parseOptions(q.body).map(o => o.text)].join(" \n ");
  return [pick.text, pick.how === "recommended" ? pick.recommendation : ""].filter(Boolean).join(" \n ");
}

// -> {page: true, category, why, matched, pick} | {page: false, pick}
// pick is null when the question offers nothing to pick from: Mission Control's decide helper takes it, unless the
// question itself (its heading or its text) asks for one of the three actions above.
export function severityOf(q) {
  const pick = pickOption(q);
  const hit = categoryOf(pick ? actionText(q, pick) : `${q.heading} \n ${q.body || ""}`);
  return hit ? { page: true, ...hit, pick } : { page: false, pick };
}
