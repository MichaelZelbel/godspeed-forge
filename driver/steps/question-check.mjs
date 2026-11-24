// The question-check step: the question accountant (questions/accountant.mjs), run inside every driver round.
// Plain code, no model. For each project's "Owner decisions needed" issue every "### " question must be decided,
// delivered to the owner with a receipt, or younger than an hour. A question in none of these is a halt of this
// step, "factory question reached nobody", which the driver repairs like any other (an acting run at once); still
// in none after two hours, the owner gets one fixed message through Telegram's Bot API (the receipt is the
// message_id), once per question, and it is written to the driver's journal. The counts are in this step's state
// and in `godspeed-forge driver status`.
import fs from "node:fs";
import path from "node:path";
import { envFor as questionsEnv } from "./questions.mjs";
import { loadState, stateFileOf, ghAsFactory, TITLE } from "./questions/factory-owner-questions.mjs";
import { headingsOf, names, deliveredKeys, account, alarmText, alarmId, ALARM_MIN } from "./questions/accountant.mjs";
import { sendTelegram, telegramCreds } from "../facts.mjs";
import { appendEvents } from "../journal.mjs";

export const STEP = { name: "question-check", everyMinutes: 5, maxMinutes: 5, inRound: true };
export const SETTINGS = [];
const MIN = 60000;
export const RECHECK_MIN = 60;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function writeJson(f, data) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(data, null, 2) + "\n"); fs.renameSync(t, f); }
const slug = repo => String(repo).toLowerCase().replace("/", "__");

// The real reads, as the factory's builder-App login: the owner issue (its number is remembered; a closed or renamed
// one is searched again) and the comments of an issue.
export const realReads = env => ({
  ownerIssue(repo, known) {
    if (known) {
      const i = ghAsFactory(env, [`repos/${repo}/issues/${known}`]);
      if (i && i.state === "open" && i.title === TITLE) return { number: i.number, body: i.body || "", url: i.html_url };
    }
    const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${TITLE}"`);
    const hit = ((ghAsFactory(env, [`search/issues?q=${q}&per_page=5`]) || {}).items || []).filter(i => i.title === TITLE).sort((a, b) => b.number - a.number)[0];
    if (!hit) return null;
    const i = ghAsFactory(env, [`repos/${repo}/issues/${hit.number}`]);
    return { number: i.number, body: i.body || "", url: i.html_url };
  },
  comments(repo, n) {
    const all = [];
    for (let p = 1; p <= 10; p++) { const rows = ghAsFactory(env, [`repos/${repo}/issues/${n}/comments?per_page=100&page=${p}`]) || []; all.push(...rows); if (rows.length < 100) break; }
    return all;
  },
  telegram: text => sendTelegram(telegramCreds(env), text),
});

export async function run(ctx) {
  // it checks what the questions step does: with that step off (a new owner's server) there is nothing to check
  if (((ctx.settings || {}).steps || {}).questions && ctx.settings.steps.questions.enabled === false) return { ok: true, summary: "nothing to check: the questions step is off" };
  let env;
  try { env = questionsEnv(ctx); } catch (e) { return { ok: false, summary: "not set up", error: e.message }; }
  const now = ctx.nowMs ? ctx.nowMs() : (Number.isFinite(ctx.now) ? ctx.now : Date.now());
  const io = { ...realReads(env), ...(ctx.accountantDeps || {}) };
  const file = path.join(ctx.stateDir, "state.json");
  const st = readJson(file, {});
  for (const k of ["issues", "firstSeen", "decided", "alarmed", "counts"]) st[k] ||= {};
  const halts = [], unreadable = [], late = [];
  const seenNow = new Set();
  for (const p of env.PROJECTS) {
    const repo = p.repo;
    let issue;
    try { issue = io.ownerIssue(repo, st.issues[repo] || null); } catch (e) { unreadable.push(`${repo}: ${String(e.message).slice(0, 120)}`); for (const k of Object.keys(st.firstSeen)) if (k.startsWith(`${repo}\n`)) seenNow.add(k); continue; }
    if (!issue) { delete st.issues[repo]; st.counts[repo] = { total: 0, decided: 0, delivered: 0, young: 0, nobody: 0 }; continue; }
    st.issues[repo] = issue.number;
    const questions = headingsOf(issue.body);
    let qs = {}; try { qs = loadState(stateFileOf(env, p)); } catch { qs = {}; }
    const delivered = deliveredKeys(qs);
    const fs0 = Object.fromEntries(Object.entries(st.firstSeen).filter(([k]) => k.startsWith(`${repo}\n`)).map(([k, v]) => [k.slice(repo.length + 1), v]));
    // a decision seen on GitHub is believed for an hour, then looked for again (a deleted decision is no decision)
    const decided = new Set(questions.filter(q => { const at = Date.parse(st.decided[`${repo}\n${q.key}`] || ""); return Number.isFinite(at) && now - at < RECHECK_MIN * MIN; }).map(q => q.key));
    // only a question that would otherwise count as reaching nobody costs a look at the comments
    const open = questions.filter(q => !decided.has(q.key) && !delivered.has(q.key) && now - (fs0[q.key] || now) >= 60 * MIN);
    if (open.length) {
      const cache = new Map();
      const read = n => { if (!cache.has(n)) cache.set(n, io.comments(repo, n)); return cache.get(n); };
      try {
        for (const q of open) for (const n of [issue.number, ...q.items]) if (read(n).some(c => names(c.body, q.key))) { decided.add(q.key); st.decided[`${repo}\n${q.key}`] = new Date(now).toISOString(); break; }
      } catch (e) { unreadable.push(`${repo} comments: ${String(e.message).slice(0, 120)}`); for (const q of questions) seenNow.add(`${repo}\n${q.key}`); for (const [k, v] of Object.entries(fs0)) st.firstSeen[`${repo}\n${k}`] = v; continue; } // no conclusion from a failed read
    }
    const { rows, counts } = account({ questions, firstSeen: fs0, decided, delivered, now });
    for (const [k, v] of Object.entries(fs0)) { st.firstSeen[`${repo}\n${k}`] = v; seenNow.add(`${repo}\n${k}`); }
    st.counts[repo] = counts;
    const nobody = rows.filter(r => r.state === "nobody");
    (st.nobody ||= {})[repo] = nobody.map(r => ({ key: r.key, title: r.title, since: new Date(r.since).toISOString() }));
    if (nobody.length) {
      halts.push({ key: `nobody-${slug(repo)}`, words: `Factory question reached nobody: ${nobody.length} question${nobody.length === 1 ? "" : "s"} in the "${TITLE}" issue of ${repo} (${issue.url || `#${issue.number}`}) ${nobody.length === 1 ? "is" : "are"} neither decided nor delivered to the owner with a receipt, an hour or more after appearing: ${nobody.map(r => `"${r.title}"`).join("; ").slice(0, 900)}. The questions step should have decided each at once, paged the owner, or handed it to the decide helper; find out why it did not (its last runs: journalctl -u forge-step-questions; its state: ${path.dirname(env.STATE)}) and repair that. This check looks again every round and the halt ends by itself.` });
      for (const r of nobody) if (now - r.since >= ALARM_MIN * MIN && !st.alarmed[`${repo}\n${r.key}`]) late.push(`${repo}\n${r.key}`);
    }
  }
  for (const k of Object.keys(st.firstSeen)) if (!seenNow.has(k)) delete st.firstSeen[k];
  for (const [k, at] of Object.entries(st.decided)) if (!seenNow.has(k) && now - Date.parse(at) > 7 * 24 * 60 * MIN) delete st.decided[k];
  for (const [k, at] of Object.entries(st.alarmed)) if (!seenNow.has(k) && now - Date.parse(at) > 7 * 24 * 60 * MIN) delete st.alarmed[k];
  let alarm = "";
  if (late.length && !ctx.dry) {
    const text = alarmText(late.length);
    const r = await io.telegram(text);
    const at = new Date(now).toISOString();
    let journaled = false;
    if (env.JOURNAL) { try { appendEvents(env.JOURNAL, [{ t: "notice", id: alarmId(late), at, title: "Factory questions reached nobody", text, receipts: r && r.ok ? { telegram: r.receipt } : {}, failed: r && r.ok ? [] : [(r && r.why) || "no answer"], entries: [] }]); journaled = true; } catch { /* not durable: see below */ } }
    // once per question, and never lost: it counts as said when Telegram took it, or when the journal holds it for the
    // driver's delivery retry; with neither, this check says it again next round
    if ((r && r.ok) || journaled) for (const k of late) st.alarmed[k] = at;
    alarm = r && r.ok ? `; the owner was told about ${late.length} (receipt ${r.receipt})` : journaled ? `; telling the owner about ${late.length} failed (${(r && r.why) || "no answer"}), the driver retries` : `; telling the owner about ${late.length} failed and could not be written down; tried again next round`;
  }
  st.at = new Date(now).toISOString();
  if (!ctx.dry) writeJson(file, st);
  const total = Object.values(st.counts).reduce((a, c) => ({ total: a.total + c.total, decided: a.decided + c.decided, delivered: a.delivered + c.delivered, young: a.young + c.young, nobody: a.nobody + c.nobody }), { total: 0, decided: 0, delivered: 0, young: 0, nobody: 0 });
  const summary = `${total.total} questions: ${total.decided} decided, ${total.delivered} delivered, ${total.young} new, ${total.nobody} reached nobody${unreadable.length ? `; unreadable: ${unreadable.join("; ")}` : ""}${alarm}`;
  return { ok: !unreadable.length, summary, ...(halts.length ? { halt: halts[0], halts } : {}), ...(unreadable.length ? { error: `could not read: ${unreadable.join("; ")}` } : {}) };
}
