// Paging the owner for the few factory questions only he can answer (severity.mjs), modelled on on-call paging
// (PagerDuty, Opsgenie): one page per question (de-duplicated by its key), it needs an acknowledgement (his answer,
// from any channel), and it escalates channel by channel on a timer until it gets one. Plain code: every send is
// an HTTP call or a `gh` call whose answer carries a receipt, and nothing here asks a model anything.
//
//   0 min    Telegram (the chat bot, so his reply lands where the relay reads it; the machine bot when there is none)
//   10 min   email (AgentMail by default), and an issue labelled <owner>-urgent in the urgent repository, which a
//            hook of Mission Control's own shows at the top of every chat
//   60 min   Telegram and email once more
//   then     Telegram and email every 4 hours, never more often
// A channel that has no settings on this server is skipped and said in the step's summary; a send that got no
// receipt is tried again on the next run of the step (an email carries an idempotency key, so it is never sent twice).
// The urgent issue is closed the moment the question is answered or withdrawn.
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { readEnvFile, sendTelegram } from "../../facts.mjs";

const MIN = 60000;
export const LADDER = { emailAfterMin: 10, repeatAfterMin: 60, everyHours: 4 };
export const ref = key => crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 10);

// ---------------------------------------------------------------- the schedule (pure)
// page: {stages: [{n, at, channels: {telegram|email|issue: {receipt?, why?, at}}}]}
// -> {n, channels: [...]} of the stage that is due now, or null
export function dueStage(page, now) {
  const st = (page && page.stages) || [];
  if (!st.length) return { n: 0, channels: ["telegram"] };
  const start = st[0].at;
  if (st.length === 1) return now - start >= LADDER.emailAfterMin * MIN ? { n: 1, channels: ["email", "issue"] } : null;
  if (st.length === 2) return now - start >= LADDER.repeatAfterMin * MIN ? { n: 2, channels: ["telegram", "email"] } : null;
  return now - st.at(-1).at >= LADDER.everyHours * 60 * MIN ? { n: st.length, channels: ["telegram", "email"] } : null;
}
// the channels of the latest stage that have no receipt yet and were not skipped (no settings): tried again
export const unreceipted = page => {
  const last = ((page && page.stages) || []).at(-1);
  return last ? Object.entries(last.channels || {}).filter(([, v]) => !v.receipt && !v.off).map(([k]) => k) : [];
};
export const receipts = page => ((page && page.stages) || []).flatMap(s => Object.entries(s.channels || {}).filter(([, v]) => v.receipt).map(([k, v]) => ({ channel: k, receipt: v.receipt, at: v.at })));
// the urgent issue a page opened (the one receipt of the "issue" channel)
export const urgentIssue = page => { const r = receipts(page).find(x => x.channel === "issue"); return r ? r.receipt : null; };

// ---------------------------------------------------------------- the channels (real)
// The chat bot's credentials first: his reply must land in the chat whose messages the relay reads.
export function chatCreds(env) {
  const e = readEnvFile(env.TG_ENV || "");
  const chat = e.TELEGRAM_HOME_CHANNEL || String(e.TELEGRAM_ALLOWED_USERS || "").split(",")[0].trim();
  if (e.TELEGRAM_BOT_TOKEN && chat) return { token: e.TELEGRAM_BOT_TOKEN, chat, button: false, bot: "chat" };
  const m = readEnvFile(env.TG_MACHINE_ENV || "");
  if (m.BOT_TOKEN && m.CHAT_ID) return { token: m.BOT_TOKEN, chat: m.CHAT_ID, button: false, bot: "machine" };
  return { token: "", chat: "", button: false, bot: "" };
}
const key = (env, name) => readEnvFile(env.KEYS_FILE || "")[name] || process.env[name] || "";
export const mailReady = env => !!(env.OWNER_EMAIL && env.MAIL_INBOX && key(env, env.MAIL_SEND_KEY_NAME || "AGENTMAIL_SEND_KEY"));

export async function sendMail(env, { subject, text, idem }, doFetch = fetch) {
  const token = key(env, env.MAIL_SEND_KEY_NAME || "AGENTMAIL_SEND_KEY");
  if (!env.OWNER_EMAIL || !env.MAIL_INBOX || !token) return { ok: false, off: true, why: "no email settings on this server" };
  try {
    const r = await doFetch(`${env.MAIL_API || "https://api.agentmail.to"}/v0/inboxes/${encodeURIComponent(env.MAIL_INBOX)}/messages/send`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": idem },
      body: JSON.stringify({ to: env.OWNER_EMAIL, subject, text }), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    return j && j.message_id ? { ok: true, receipt: String(j.message_id), thread: j.thread_id ? String(j.thread_id) : undefined } : { ok: false, why: `email http ${r.status}` };
  } catch (e) { return { ok: false, why: `email not reached: ${String(e.message).slice(0, 80)}` }; }
}
// His replies to a page's email: received mail from his address whose subject carries the page's reference.
// -> [{id, at, subject, text}] | null (unreadable: nothing is concluded)
export async function mailReplies(env, after, doFetch = fetch) {
  const token = key(env, env.MAIL_READ_KEY_NAME || "AGENTMAIL_READ_KEY");
  if (!env.OWNER_EMAIL || !env.MAIL_INBOX || !token) return [];
  const base = `${env.MAIL_API || "https://api.agentmail.to"}/v0/inboxes/${encodeURIComponent(env.MAIL_INBOX)}/messages`;
  const get = async url => { const r = await doFetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`http ${r.status}`); return r.json(); };
  try {
    const list = await get(`${base}?labels=received&limit=50&after=${encodeURIComponent(new Date(after).toISOString())}`);
    const out = [];
    for (const m of (list.messages || []).filter(m => String(m.from || "").toLowerCase().includes(String(env.OWNER_EMAIL).toLowerCase()) && /\[q:[0-9a-f]{10}\]/.test(String(m.subject || "")))) {
      const full = await get(`${base}/${encodeURIComponent(m.message_id)}`);
      out.push({ id: String(m.message_id), at: Date.parse(m.timestamp || full.timestamp || 0) || after, subject: String(m.subject || ""), text: String(full.extracted_text || full.text || m.preview || "") });
    }
    return out;
  } catch { return null; }
}
// the urgent repository is the owner's own (the watch repository): root's gh, never the factory's App
const rootGh = (args, input) => {
  const r = spawnSync("gh", args, { input, encoding: "utf8", timeout: 60000, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root" } });
  if (r.status !== 0) throw new Error(((r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`).slice(0, 200));
  return r.stdout ? JSON.parse(r.stdout) : null;
};
export function openUrgent(env, { title, body }, gh = rootGh) {
  if (!env.URGENT_REPO || !env.URGENT_LABEL) return { ok: false, off: true, why: "no urgent repository on this server" };
  try { gh(["api", "-X", "POST", `repos/${env.URGENT_REPO}/labels`, "--input", "-"], JSON.stringify({ name: env.URGENT_LABEL, color: "B60205", description: "A question only the owner can answer; closes itself when answered" })); } catch { /* it exists already */ }
  try {
    const r = gh(["api", "-X", "POST", `repos/${env.URGENT_REPO}/issues`, "--input", "-"], JSON.stringify({ title, body, labels: [env.URGENT_LABEL] }));
    return r && r.number ? { ok: true, receipt: String(r.html_url || `https://github.com/${env.URGENT_REPO}/issues/${r.number}`), number: r.number } : { ok: false, why: "the issue was not opened" };
  } catch (e) { return { ok: false, why: `issue: ${e.message}` }; }
}
export function closeUrgent(env, url, gh = rootGh) {
  const m = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(String(url || ""));
  if (!m) return false;
  gh(["api", "-X", "PATCH", `repos/${m[1]}/issues/${m[2]}`, "--input", "-"], JSON.stringify({ state: "closed", state_reason: "completed" }));
  return true;
}
// his comments on the urgent issue (his own login only) -> [{id, at, text}] | null (unreadable)
export function urgentComments(env, url, gh = rootGh) {
  const m = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(String(url || ""));
  if (!m) return [];
  try {
    const rows = gh(["api", `repos/${m[1]}/issues/${m[2]}/comments?per_page=100`]) || [];
    return rows.filter(c => c && c.user && String(c.user.login).toLowerCase() === String(env.OWNER_LOGIN || "").toLowerCase() && String(c.body || "").trim())
      .map(c => ({ id: String(c.id), at: Date.parse(c.created_at) || 0, text: String(c.body) }));
  } catch { return null; }
}

// The channels the step uses; a test passes its own.
export const realChannels = env => ({
  telegram: text => sendTelegram(chatCreds(env), text),
  telegramReady: () => !!chatCreds(env).token,
  email: msg => sendMail(env, msg),
  emailReady: () => mailReady(env),
  emailReplies: after => mailReplies(env, after),
  openIssue: msg => openUrgent(env, msg),
  closeIssue: url => closeUrgent(env, url),
  issueComments: url => urgentComments(env, url),
});

// ---------------------------------------------------------------- one step of one page
// told: the question's record (told[key] in the questions state); msg: {text, subject, title, body}.
// Sends what is due (a new stage, or the latest stage's channels without a receipt) and records each answer.
// -> [{channel, ok, receipt?, why?}] of what was tried
export async function pageStep(told, msg, now, ch) {
  const page = (told.page ||= { stages: [] });
  const tried = [];
  const due = dueStage(page, now);
  let stage, channels;
  if (due) { stage = { n: due.n, at: now, channels: {} }; page.stages.push(stage); channels = [...due.channels]; }
  else { stage = page.stages.at(-1); channels = unreceipted(page); }
  // the urgent issue, once due, is tried on every run until it is open (or the server has no urgent repository)
  const issueOff = page.stages.some(s => s.channels.issue && s.channels.issue.off);
  if (page.stages.length >= 2 && !urgentIssue(page) && !issueOff && !channels.includes("issue")) channels.push("issue");
  for (const c of channels) {
    let r;
    if (c === "telegram") r = await ch.telegram(msg.text);
    else if (c === "email") r = await ch.email({ subject: msg.subject, text: msg.mail, idem: `factory-question|${msg.ref}|${stage.n}` });
    else if (c === "issue") r = urgentIssue(page) ? { ok: true, receipt: urgentIssue(page), again: true } : await ch.openIssue({ title: msg.title, body: msg.body });
    else continue;
    if (r && r.again) continue; // one urgent issue per page, whatever the stage
    stage.channels[c] = { at: now, ...(r && r.ok ? { receipt: r.receipt, ...(r.thread ? { thread: r.thread } : {}) } : { why: (r && r.why) || "no answer", ...(r && r.off ? { off: true } : {}) }) };
    tried.push({ channel: c, ok: !!(r && r.ok), ...(r && r.ok ? { receipt: r.receipt } : { why: (r && r.why) || "no answer" }) });
  }
  return tried;
}
