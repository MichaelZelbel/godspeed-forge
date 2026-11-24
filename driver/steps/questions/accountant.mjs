// The question accountant (2026-11-24): a plain check, with no model, that no factory question sits unseen by both
// the owner and Mission Control. It reads every "### " heading of each project's "Owner decisions needed" issue by
// itself (not through the questions step's parser, so a parser that reads nothing is caught), and puts each
// question in exactly one state:
//   decided    a comment on the issue or on an item the question names, headed `Manager decision (Mission Control`
//              or `Owner decision`, that names it (the question's marker, or its title)
//   delivered  the questions step paged the owner about it and holds a delivery receipt (Telegram's message_id, the
//              email's message id or the urgent issue), and it is not answered yet
//   young      first seen less than YOUNG_MIN minutes ago
//   nobody     none of these: a driver obstacle "factory question reached nobody", and after ALARM_MIN minutes one
//              fixed message to the owner per question, never repeated
import crypto from "node:crypto";
import { keyOf, idOf } from "./factory-owner-questions.mjs";
import { itemsOf } from "./choices.mjs";
import { receipts } from "./pager.mjs";

export const YOUNG_MIN = 60;
export const ALARM_MIN = 120;
const MIN = 60000;

// every "### " heading, numbered or not -> [{title, key, items}]
export function headingsOf(body) {
  const out = [], seen = new Set();
  for (const line of String(body || "").replace(/\r/g, "").split("\n")) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const title = m[1].replace(/^\d+\.\s+/, "");
    const key = keyOf(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ title, key, items: itemsOf(title) });
  }
  return out;
}

const HEAD = /^[\s#>*_`~]*(?:manager decision \(mission control|owner decision)\b/i;
const firstLine = body => (String(body || "").split("\n").find(l => l.trim()) || "").trim();
// a comment that decides this question: headed as a decision, and naming it by marker or by title
export function names(body, key) {
  if (!HEAD.test(firstLine(body))) return false;
  const b = String(body || "");
  return b.includes(`:${idOf(key)} -->`) || ` ${keyOf(b)} `.includes(` ${key} `);
}

// The questions step's own record of a page: delivered while it holds a receipt and is not answered.
export function deliveredKeys(questionsState) {
  const out = new Set();
  for (const [k, t] of Object.entries((questionsState && questionsState.told) || {})) {
    if (!t || t.answered) continue;
    if ((t.page && receipts(t.page).length) || t.receipt) out.add(k);
  }
  return out;
}

// -> {rows: [{title, key, state, since}], counts}
// firstSeen: {key: ms} (updated in place); decided: Set of keys known decided; delivered: Set of keys
export function account({ questions, firstSeen, decided, delivered, now }) {
  const rows = questions.map(q => {
    const since = (firstSeen[q.key] ||= now);
    const state = decided.has(q.key) ? "decided" : delivered.has(q.key) ? "delivered" : now - since < YOUNG_MIN * MIN ? "young" : "nobody";
    return { ...q, state, since };
  });
  const counts = { total: rows.length, decided: 0, delivered: 0, young: 0, nobody: 0 };
  for (const r of rows) counts[r.state]++;
  return { rows, counts };
}

// The one message to the owner, fixed words (the number is the only thing that changes).
export const alarmText = n => n === 1
  ? "1 factory question has reached neither you nor Mission Control for 2 hours. Mission Control is repairing it."
  : `${n} factory questions have reached neither you nor Mission Control for 2 hours. Mission Control is repairing it.`;
export const alarmId = keys => `question-alarm:${crypto.createHash("sha1").update([...keys].sort().join("|")).digest("hex").slice(0, 12)}`;
