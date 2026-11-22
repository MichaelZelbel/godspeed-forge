// Facts, not beliefs (architecture 6, 8.6, 8.7, 8.11): what the driver asks the outside world instead of
// trusting a record. Every function takes its way of asking as a parameter, so the tests run offline.
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const CLOCK_SKEW_MS = 5 * 60000;
// ---------------------------------------------------------------- 8.6 the clock
// GitHub's own Date header against this machine's clock. -> { ghNow (ms) | NaN, skewMs, ok }
export function clockCheck(now, run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 30000, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root" } })) {
  const r = run("gh", ["api", "-i", "rate_limit"]);
  const m = /^date:\s*(.+)$/im.exec(String(r.stdout || ""));
  const ghNow = m ? Date.parse(m[1]) : NaN;
  if (!Number.isFinite(ghNow)) return { ghNow: NaN, skewMs: NaN, ok: true, unread: true }; // GitHub unreachable is EXTERNAL, not a stall of ours
  return { ghNow, skewMs: now - ghNow, ok: Math.abs(now - ghNow) <= CLOCK_SKEW_MS };
}
// time going backwards since the last journal round is a stall too
export const wentBackwards = (now, lastRoundAt) => Number.isFinite(lastRoundAt) && now < lastRoundAt - 60000;

// ---------------------------------------------------------------- 8.7 "installed" is a fresh fact
export const HEALTH_URL = "http://127.0.0.1:47831/health";
export const VERSION_FILE = "/root/godspeed/.godspeed/integrated-runtime/version";
// A fresh request to the running Godspeed returns the release's version, and the running install's commit
// (its own version file) equals the frozen candidate's product commit. A recorded or cached value never counts.
export function verifyInstalled(release, staging, ask = {}) {
  const health = (ask.health || (() => { const r = spawnSync("curl", ["-s", "-m", "10", HEALTH_URL], { encoding: "utf8" }); try { return JSON.parse(r.stdout); } catch { return null; } }))();
  const commit = String((ask.commit || (() => { try { return fs.readFileSync(VERSION_FILE, "utf8"); } catch { return ""; } }))()).trim();
  const version = String(release.version || (staging && staging.version) || "");
  const frozen = String((staging && (staging.productCommit || staging.commit)) || "").trim();
  if (!health || health.ok !== true) return { ok: false, why: "the running Godspeed did not answer healthy just now" };
  if (!version || health.version !== version) return { ok: false, why: `the running Godspeed reports ${health.version || "no version"}, not ${version || "the release's version"}` };
  if (!frozen || !commit || commit !== frozen) return { ok: false, why: "the running install's commit is not the frozen candidate's commit" };
  return { ok: true, version, commit };
}

// ---------------------------------------------------------------- 8.11 two transports, each with a receipt
export const readEnvFile = file => { try { return Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").map(l => /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2].replace(/^["']|["']$/g, "")])); } catch { return {}; } };
// The machine bot (a separate bot from the chat bot; nothing else polls its updates, checked 2026-11-22: no webhook, no
// other getUpdates) carries transport A and its "Seen" button. Its credentials are a root-only file copied from the machine
// that already sends with it; the chat bot's own file is the fallback (no button: Hermes polls that one).
export const MACHINE_BOT_FILE = "/etc/godspeed-forge/telegram-machine.env";
export const telegramCreds = (env = {}) => {
  const m = readEnvFile(env.TG_MACHINE_ENV || MACHINE_BOT_FILE);
  if (m.BOT_TOKEN && m.CHAT_ID) return { token: m.BOT_TOKEN, chat: m.CHAT_ID, owner: m.CHAT_ID, button: true };
  const e = readEnvFile(env.TG_ENV || "/root/.hermes/.env");
  return { token: e.TELEGRAM_BOT_TOKEN || "", chat: e.TELEGRAM_HOME_CHANNEL || String(e.TELEGRAM_ALLOWED_USERS || "").split(",")[0] || "", owner: "", button: false };
};
export const seenKey = noticeId => crypto.createHash("sha1").update(String(noticeId)).digest("hex").slice(0, 12);
// Transport A: Telegram's sendMessage answer with a message id, and a "Seen" button when the bot is the machine bot.
// -> { ok, receipt, why }
export async function sendTelegram(creds, text, doFetch = fetch, noticeId = "") {
  if (!creds.token || !creds.chat) return { ok: false, why: "no Telegram credentials here" };
  const body = { chat_id: creds.chat, text, ...(creds.button && noticeId ? { reply_markup: { inline_keyboard: [[{ text: "Seen", callback_data: `seen:${seenKey(noticeId)}` }]] } } : {}) };
  try {
    const r = await doFetch(`https://api.telegram.org/bot${creds.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    return j && j.ok && j.result && j.result.message_id ? { ok: true, receipt: String(j.result.message_id) } : { ok: false, why: `telegram http ${r.status}` };
  } catch (e) { return { ok: false, why: `telegram not reached: ${String(e.message).slice(0, 80)}` }; }
}
// The acknowledgement: a callback_query on a "Seen" button from the owner's own user id. Anyone else's tap is ignored.
// -> { seen: [seenKey], offset }
export async function pollSeen(creds, offset = 0, doFetch = fetch) {
  const out = { seen: [], offset };
  if (!creds.button || !creds.token || !creds.owner) return out;
  try {
    const r = await doFetch(`https://api.telegram.org/bot${creds.token}/getUpdates?offset=${offset}&timeout=0&allowed_updates=${encodeURIComponent(JSON.stringify(["callback_query"]))}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (!j.ok) return out; // a 409 here would mean another poller exists: nothing is consumed, the GitHub issue stays the fallback
    for (const u of j.result || []) {
      out.offset = Math.max(out.offset, u.update_id + 1);
      const q = u.callback_query;
      if (q && String(q.from && q.from.id) === String(creds.owner) && /^seen:[0-9a-f]{12}$/.test(String(q.data || ""))) {
        out.seen.push(q.data.slice(5));
        try { await doFetch(`https://api.telegram.org/bot${creds.token}/answerCallbackQuery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callback_query_id: q.id, text: "Seen, thank you" }) }); } catch {}
      }
    }
  } catch { /* unreachable: nothing seen this round */ }
  return out;
}
// Transport B: an issue authored by github-actions[bot] that names the owner (GitHub sends nobody a notification for their OWN activity,
// so an issue opened with his token proves nothing). The notify workflow in godspeed-dev opens it with its own token; the receipt is
// the issue's URL, looked up by the unique ref the message carries. The same message (same ref) is never opened twice.
export const NOTIFY_WORKFLOW = "factory-notify.yml";
export const WATCH_REPO_DEFAULT = "MichaelZelbel/godspeed-dev";
export const refOf = id => crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 12);
const sysRun = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 60000, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root" } });
export function findNotifyIssue(repo, ref, run = sysRun) {
  const r = run("gh", ["api", `repos/${repo}/issues?state=all&per_page=100`]);
  try { const hit = JSON.parse(r.stdout).find(i => !i.pull_request && i.user && i.user.login === "github-actions[bot]" && String(i.body || "").startsWith("@MichaelZelbel") && String(i.body || "").includes(`<!-- ref:${ref} -->`)); return hit ? hit.html_url : null; } catch { return null; }
}
export async function openIssue(repo, title, body, noticeId, run = sysRun, sleep = ms => new Promise(r => setTimeout(r, ms)), tries = 12) {
  const ref = refOf(noticeId || `${title}|${Date.now()}`);
  const have = findNotifyIssue(repo, ref, run);
  if (have) return { ok: true, receipt: have };
  const d = run("gh", ["workflow", "run", NOTIFY_WORKFLOW, "-R", repo, "-f", `title=${String(title).replace(/\s+/g, " ").slice(0, 200)}`, "-f", `body=${String(body).slice(0, 900)}`, "-f", `ref=${ref}`]);
  if (d.status !== 0) return { ok: false, why: `notify workflow: ${String(d.stderr || "").trim().split("\n").pop() || `exit ${d.status}`}`.slice(0, 160) };
  for (let i = 0; i < tries; i++) { await sleep(6000); const url = findNotifyIssue(repo, ref, run); if (url) return { ok: true, receipt: url }; }
  return { ok: false, why: "the notify workflow had not opened the issue yet" }; // the next attempt finds it by its ref and never opens it twice
}
// Both transports. -> { telegram, github } receipts (strings) of those that worked, and `failed` reasons
export async function deliver(env, { title, text, noticeId }, deps = {}) {
  const out = { receipts: {}, failed: [] };
  const a = await (deps.telegram || ((t, id) => sendTelegram(telegramCreds(env), t, fetch, id)))(text, noticeId);
  if (a.ok) out.receipts.telegram = a.receipt; else out.failed.push(a.why);
  const b = await (deps.issue || ((ti, bo, id) => openIssue(env.WATCH_REPO || WATCH_REPO_DEFAULT, ti, bo, id)))(title, text, noticeId); // the workflow adds the @-mention
  if (b.ok) out.receipts.github = b.receipt; else out.failed.push(b.why);
  return out;
}
