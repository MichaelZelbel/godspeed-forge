// What a factory question offers and what its manager recommends, read from the question's own text with plain
// rules (no model): the options, the recommendation, and the one option Mission Control takes when the owner is
// not asked (2026-11-24, the owner's standing instruction: only a question whose answer would spend money,
// publish or send to other people, or irreversibly delete people's data stops anything; see severity.mjs).
//
// The manager writes options two ways, both seen live on 2026-11-24:
//   inline   "Options: (a) keep the heart; (b) use the same people icon. Recommendation: (b). Default after ..."
//            "Options: raise the key's monthly limit, or put a new key in the secret. Recommendation: raise the limit."
//   a list   "- **A.** Keep it as it is." ... "Recommendation: **A** for now, **B** later."
// The release driver's own questions use "1. ..." lines and "Recommended: ...", and a decision a helper wanted to
// make carries "What Mission Control would do: ...".

const clean = t => String(t || "").replace(/\*\*/g, "").replace(/\s+/g, " ").replace(/^[\s;,.]+|[\s;,]+$/g, "").replace(/\s+or$/i, "").replace(/[.;,\s]+$/, "").trim();

// "(a)", "**A**", "**A.**", "A.", "option a", "1." at the start of a text -> the label ("a".."e" or "1".."9"), else null.
// A bare lowercase "a" is the article, never a label.
export function leadingLabel(text) {
  const t = String(text || "").trim();
  const m = /^\(([a-eA-E1-9])\)/.exec(t) || /^\*\*\s*(?:option\s+)?([A-Ea-e1-9])\s*[.):]?\s*\*\*/i.exec(t) || /^option\s+([a-e1-9])\b/i.exec(t)
    || /^([A-E1-9])[.):](?=\s|$)/.exec(t) || /^([A-E])(?=\s*(?:,|;|$|\s+(?:for now|now|first|then|and|so|because|since)\b))/.exec(t);
  return m ? m[1].toLowerCase() : null;
}

// The top-level pieces of an unlabelled "X, or Y" / "X; or Y" list (a comma inside parentheses does not split).
function splitOr(text) {
  const parts = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++; else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "," || c === ";") && /^[,;]\s+or\s+/i.test(text.slice(i))) { parts.push(text.slice(start, i)); const m = /^[,;]\s+or\s+/i.exec(text.slice(i)); start = i + m[0].length; i = start - 1; }
  }
  parts.push(text.slice(start));
  return parts.map(clean).filter(Boolean);
}

// -> [{label, text}] in order. The first form found wins: a list of labelled lines, then the "Options:" line.
export function parseOptions(body) {
  const lines = String(body || "").replace(/\r/g, "").split("\n");
  const listed = [];
  for (const line of lines) {
    const m = /^\s*[-*]\s+(?:\*\*)?\s*(?:option\s+)?\(?([A-Ea-e])\)?\s*[.):]?\s*(?:\*\*)?\s*[.):]?\s+(.+)$/i.exec(line) || /^\s*([1-9])[.)]\s+(.+)$/.exec(line);
    if (m && (/^[A-E1-9]$/.test(m[1]) || /^\s*[-*]\s+(?:\*\*|\(|option\b)/i.test(line))) listed.push({ label: m[1].toLowerCase(), text: clean(m[2]) });
  }
  if (listed.length >= 2) return listed;
  for (const line of lines) {
    const m = /\bOptions?:\s*(.+?)(?=\s+(?:My\s+)?[Rr]ecommend(?:ation|ed)\s*:|$)/.exec(line);
    if (!m) continue;
    const text = m[1];
    const marks = [...text.matchAll(/\(([a-eA-E])\)\s*/g)];
    if (marks.length >= 2) return marks.map((mk, i) => ({ label: mk[1].toLowerCase(), text: clean(text.slice(mk.index + mk[0].length, i + 1 < marks.length ? marks[i + 1].index : text.length)) })).filter(o => o.text);
    const parts = splitOr(text);
    if (parts.length >= 2) return parts.map((p, i) => ({ label: String.fromCharCode(97 + i), text: p, unlabelled: true }));
  }
  return [];
}

// -> {text, label} | null. The first recommendation line; it ends where the line's default starts.
export function parseRecommendation(body) {
  for (const line of String(body || "").replace(/\r/g, "").split("\n")) {
    const m = /(?:^|[\s.])(?<![Nn][Oo][Tt]\s)(?:My\s+)?[Rr]ecommend(?:ation|ed)\s*:\s*(.+?)(?=\s+Default\b|$)/.exec(line) || /\bWhat Mission Control would do:\s*(.+)$/.exec(line); // "Not recommended:" is no recommendation
    if (!m) continue;
    const text = String(m[1]).replace(/\*\*/g, "").trim().replace(/\s+/g, " ");
    if (!text) continue;
    return { text, label: leadingLabel(m[1]) };
  }
  return null;
}

// The words that make one option easier to undo than another (the owner's standing instruction: with no
// recommendation, the most reversible option).
const UNDOABLE = /\b(keep|kept|leave|left as|as it is|as is|unchanged|wait|for now|until|do nothing|nothing changes|no change|stays?|later|follow-up|optional)\b/gi;
const FINAL = /\b(delete|deleted|remove|removes|drop|close|closes|replace|retire|migrate|rewrite|permanent(?:ly)?|for good|cannot)\b/gi;
const score = t => (String(t).match(UNDOABLE) || []).length - 2 * (String(t).match(FINAL) || []).length;
// what the project is: its mission, its purpose, who it is for. An option that changes one of these is never taken for
// him; the option that keeps it is.
const MISSION = /\b(?:mission|purpose|audience|target (?:group|users|market)|(?:new|different|another|other) (?:kind of users|market)|who (?:it|the (?:\w+ )?(?:product|app|project|site|service)) (?:is for|serves|is meant for)|whom (?:it|the \w+) serves|what the (?:product|app|project) is|(?:serve|serves|serving|target|targets|targeting|built for|made for|meant for) (?:\w+ ){0,3}instead of)\b/i;
const CHANGES = /\b(?:amend|amends|amendment|change|changes|changing|new|different|another|widen|widens|narrow|narrows|redefine|redefines|replace|replaces|pivot|serve|serves)\b/i;

// The option Mission Control takes for a question the owner is not asked.
// -> {how: "recommended" | "keeps the mission" | "most reversible", label, option, text, recommendation} | null (nothing to pick
// from, or only options that change the mission)
export function pickOption(q) {
  const body = String(q.body || "");
  const options = parseOptions(body);
  // an option can carry the recommendation itself ("- **A.** Now: ... **Recommended:** visitors get the fixes")
  const marked = options.find(o => /(?<!\bnot\s)\brecommended\b\s*[:)]|\(recommended\)/i.test(o.text)); // "not recommended" never marks one
  const rec = marked ? { text: marked.text, label: marked.label } : parseRecommendation(body);
  const byLabel = l => options.find(o => o.label === l) || (/^[1-9]$/.test(l || "") ? options[Number(l) - 1] : null) || (/^[a-e]$/.test(l || "") && options[0] && /^[1-9]$/.test(options[0].label) ? options[l.charCodeAt(0) - 97] : null);
  if (rec) {
    const opt = rec.label ? byLabel(rec.label) : null;
    const said = opt ? opt.text : rec.text;
    // a mission change is never taken for him: the option that keeps the mission as it is
    if (MISSION.test(said) && CHANGES.test(said)) {
      const keep = options.filter(o => !(MISSION.test(o.text) && CHANGES.test(o.text))).sort((a, b) => score(b.text) - score(a.text))[0];
      if (keep) return { how: "keeps the mission", label: keep.label, option: keep, text: keep.text, recommendation: rec.text, options };
      return null; // no option keeps it: nothing is taken by rule, the driver's decide helper settles it
    }
    return { how: "recommended", label: opt ? opt.label : null, option: opt || null, text: said, recommendation: rec.text, options, labelUnresolved: !!(rec.label && !opt) };
  }
  // with no recommendation: the most reversible of the options that keep the mission; none keeps it, nothing by rule
  const keeping = options.map((o, i) => ({ o, i, s: score(o.text) })).filter(x => !(MISSION.test(x.o.text) && CHANGES.test(x.o.text)));
  if (keeping.length) {
    const best = keeping.sort((a, b) => b.s - a.s || a.i - b.i)[0].o;
    return { how: "most reversible", label: best.label, option: best, text: best.text, recommendation: "", options };
  }
  return null;
}

// The items a question is about: the issue and pull request numbers in its heading ("(#958 / PR #990, #950 / PR #953)").
export const itemsOf = heading => [...new Set([...String(heading || "").matchAll(/#(\d+)/g)].map(m => Number(m[1])).filter(n => n > 0))].slice(0, 6);
