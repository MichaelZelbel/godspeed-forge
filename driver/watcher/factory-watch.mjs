// The outside watcher's whole program. Three dumb rules; alerts through two transports (Telegram, and an issue opened with the
// workflow's own token: authored by github-actions[bot], naming the owner, so GitHub notifies him). It needs no personal token and
// writes no variable: its own last run is the workflow run itself (the driver and the dead-man read the runs API), and "told"
// is kept in the alert issues (one open issue per condition, repeated every 24 hours until the owner closes it).
// Runs in GitHub Actions (node 22, no packages). Dry run: node factory-watch.mjs --dry-run (prints, sends nothing).
const HOUR = 3600000, MIN = 60000;
const E = process.env, DRY = process.argv.includes("--dry-run");
const H = () => ({ authorization: `Bearer ${E.GH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "factory-watch" });
const api = async (path, init = {}) => {
  const r = await fetch(`https://api.github.com/${path}`, { ...init, headers: { ...H(), ...(init.headers || {}) } });
  if (!r.ok && r.status !== 404) throw new Error(`github ${r.status} ${path}`);
  return r.status === 404 ? null : r.json();
};
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const version = n => { const m = /(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?/i.exec(n); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1e9 : +m[4]] : null; };
const cmp = (a, b) => { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const text64 = f => (f ? Buffer.from(f.content || "", "base64").toString() : "");

// rule 2: approved for over 72 hours (from the plan's history in the records repository) with no installed record
async function staleReleases(now) {
  const dirs = (await api(`repos/${E.PRODUCT_RECORDS_REPO}/contents/releases`)) || [];
  const rel = [];
  for (const d of dirs.filter(x => x.type === "dir" && /^godspeed-\d/.test(x.name))) { // the server runs Godspeed only: another product's plan is not "not installed on your server"
    const v = version(d.name); if (!v) continue;
    const plan = await api(`repos/${E.PRODUCT_RECORDS_REPO}/contents/releases/${d.name}/plan.md`);
    const st = await api(`repos/${E.PRODUCT_RECORDS_REPO}/contents/releases/${d.name}/staging.json`);
    let staging = null; if (st) { staging = parse(text64(st)); if (staging === null) throw new Error(`staging.json of ${d.name} is malformed`); }
    rel.push({ name: d.name, v, approved: /^\s*status:\s*approved/im.test(text64(plan)), installed: !!staging && staging.status === "installed" });
  }
  const out = [];
  for (const r of rel.filter(x => x.approved && !x.installed)) {
    if (rel.some(i => i.installed && cmp(i.v, r.v) >= 0)) continue; // an install of the same or a newer version
    const commits = (await api(`repos/${E.PRODUCT_RECORDS_REPO}/commits?path=releases/${r.name}/plan.md&per_page=30`)) || [];
    let at = null;
    for (const c of commits) { // newest first: walk back while the plan said approved; the oldest such commit is the approval
      const f = await api(`repos/${E.PRODUCT_RECORDS_REPO}/contents/releases/${r.name}/plan.md?ref=${c.sha}`);
      if (/^\s*status:\s*approved/im.test(text64(f))) at = Date.parse(c.commit.committer.date); else break;
    }
    if (at && now - at >= 72 * HOUR) out.push({ name: r.name, hours: Math.floor((now - at) / HOUR) });
  }
  return out;
}

// one alert issue per condition: <!-- watch:KEY -->. Open and younger than 24 hours: told. Open and older: told again (a new issue). Closed: seen.
async function lastIssueOf(key) {
  const list = (await api(`repos/${E.WATCH_REPO}/issues?state=all&per_page=50`)) || [];
  return list.find(i => !i.pull_request && i.user && i.user.login === "github-actions[bot]" && String(i.body || "").includes(`<!-- watch:${key} -->`)) || null;
}
const active = new Set();
async function alert(key, title, text, now) {
  active.add(key);
  let prev = await lastIssueOf(key);
  if (prev && String(prev.body || "").includes("<!-- watch:cleared -->")) prev = null; // a cleared occurrence: a new one alerts at once
  if (prev && prev.state === "closed" && !String(prev.body || "").includes("<!-- watch:cleared -->")) return; // seen by the owner: nothing more while the condition holds (one the watcher itself closed as cleared does not count)
  if (prev && now - Date.parse(prev.created_at) < 24 * HOUR) return;
  console.log(`ALERT ${key}: ${text}`);
  if (DRY) return;
  if (E.TG_BOT_TOKEN && E.TG_CHAT_ID) {
    try { await fetch(`https://api.telegram.org/bot${E.TG_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: E.TG_CHAT_ID, text: `${title}\n\n${text}` }) }); } catch {}
  }
  // authored by github-actions[bot] (this workflow's own token) and naming the owner: GitHub sends him the notification
  let opened = null;
  try { opened = await api(`repos/${E.WATCH_REPO}/issues`, { method: "POST", body: JSON.stringify({ title, body: `@MichaelZelbel ${text}\n\n<!-- watch:${key} -->` }) }); } catch (e) { console.log(`issue not opened: ${e.message}`); }
  // one open issue per condition: the one before is closed only AFTER its replacement exists (a failed opening leaves it open, never "seen")
  if (opened && prev && prev.state === "open") { try { await api(`repos/${E.WATCH_REPO}/issues/${prev.number}/comments`, { method: "POST", body: JSON.stringify({ body: "Repeated in a newer issue: this is still the case." }) }); await api(`repos/${E.WATCH_REPO}/issues/${prev.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) }); } catch {} }
}
// an alert issue of a condition that no longer holds is closed by the watcher (it clears itself)
async function closeCleared() {
  const list = (await api(`repos/${E.WATCH_REPO}/issues?state=all&per_page=50`)) || [];
  for (const i of list) {
    const m = /<!-- watch:([^ ]+) -->/.exec(String(i.body || ""));
    if (!m || i.pull_request || !i.user || i.user.login !== "github-actions[bot]" || active.has(m[1])) continue;
    if (String(i.body).includes("<!-- watch:cleared -->")) continue;
    // the condition no longer holds: an open alert is closed, and any alert (an owner-closed one too) is marked cleared, so a later, independent occurrence alerts again
    if (!DRY) { try { if (i.state === "open") await api(`repos/${E.WATCH_REPO}/issues/${i.number}/comments`, { method: "POST", body: JSON.stringify({ body: "This no longer holds: the watcher closed it. Nothing is needed from you." }) }); await api(`repos/${E.WATCH_REPO}/issues/${i.number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", body: `${i.body}\n\n<!-- watch:cleared -->` }) }); } catch {} }
  }
}

// ---------------------------------------------------------------- THE GATE (the same three rules as the driver's gate.mjs, in this program's own words)
// Nothing reaches the owner on one reading: the conditions are evaluated 3 times, 10 minutes apart (GATE_WAIT_MS), each time from a FRESH read of
// every source (the heartbeat variable through the API, not the snapshot the workflow started with); only a condition present in all three is
// alerted, and a source that is unreadable in any of them is a reason to look again, never a reason to alarm.
const WAIT = Number(E.GATE_WAIT_MS ?? 600000), READS = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freshHeartbeat() {
  if (E.HEARTBEAT_TEST !== undefined) return { ok: true, value: parse(E.HEARTBEAT_TEST) };
  try {
    // the heartbeat is the body of one issue marked <!-- factory-heartbeat -->, edited by the driver every round (the workflow token cannot read variables)
    const list = await api(`repos/${E.WATCH_REPO}/issues?state=open&per_page=100&sort=updated&direction=desc`);
    const issue = (list || []).find(i => !i.pull_request && String(i.body || "").startsWith("<!-- factory-heartbeat -->"));
    if (!issue) return { ok: true, value: null }; // read fine: the driver has never written one
    const m = /```json\n([\s\S]*?)\n```/.exec(String(issue.body)); const v = m ? parse(m[1]) : null; return v === null ? { ok: false } : { ok: true, value: v }; // a malformed record is unreadable, not 'missing'
  } catch (e) { console.log(`heartbeat issue: ${e.message}`); return { ok: false }; }
}
// -> { alerts: Map(key -> {title, text}), unreadable: bool, hbValid }
async function evaluate(now) {
  const alerts = new Map(); let unreadable = false, relUnreadable = false;
  const h = await freshHeartbeat();
  if (!h.ok) unreadable = true; // the heartbeat variable could not be read: look again
  const hb = h.value;
  const hbValid = h.ok && !!hb && Number.isFinite(Date.parse(hb.at));
  if (h.ok && (!hbValid || now - Date.parse(hb.at) > 30 * MIN || Date.parse(hb.at) - now > 5 * MIN))
    alerts.set("heartbeat", { title: "The software factory's driver has stopped reporting", text: `The program that keeps your software factory moving has not reported for ${hbValid ? Math.round((now - Date.parse(hb.at)) / MIN) + " minutes" : "a long time"}, so nothing in the factory is being watched. The dead-man on the server keeps checking; nothing is needed from you unless a later message says so.` });
  try { for (const r of await staleReleases(now)) alerts.set(`release:${r.name}`, { title: `Release ${r.name} is not installed yet`, text: `Release ${r.name} was approved ${r.hours} hours ago and is still not installed on your server. Nothing is needed from you unless a later message says so.` }); }
  catch (e) { relUnreadable = true; console.log(`rule 2 could not be read: ${e.message}`); }
  if (hbValid) for (const r of hb.rung3 || []) if (!Object.keys(r.receipts || {}).length && now - Date.parse(r.since) > 30 * MIN)
    alerts.set(`rung3:${r.id}`, { title: "A message from the factory may not have reached you", text: `The factory sent you a message about "${String(r.id).slice(0, 80)}" but neither Telegram nor GitHub confirmed it arrived. Nothing is needed from you unless a later message says so.` });
  return { alerts, unreadable, relUnreadable, hbValid };
}
let held = null, anyUnreadable = false, anyRelUnreadable = false, last = null;
for (let i = 0; i < READS; i++) {
  if (i) await sleep(WAIT);
  const r = await evaluate(Date.now());
  anyUnreadable ||= r.unreadable; anyRelUnreadable ||= r.relUnreadable; last = r;
  held = held ? new Map([...held].filter(([k]) => r.alerts.has(k))) : r.alerts; // present in every read so far
  if (!held.size) break;
}
// the decision is made again on a last fresh evaluation right before anything is sent
if (held.size) { const fin = await evaluate(Date.now()); anyUnreadable ||= fin.unreadable; anyRelUnreadable ||= fin.relUnreadable; last = fin; held = new Map([...held].filter(([k]) => fin.alerts.has(k)).map(([k]) => [k, fin.alerts.get(k)])); } // the text is the last fresh reading's
const now = Date.now();
// (c) per condition: an unreadable heartbeat holds the heartbeat and rung 3 alerts; an unreadable release record holds only the release alerts
for (const [key, a] of held) { const blocked = key.startsWith("release:") ? anyRelUnreadable : anyUnreadable; if (blocked) console.log(`${key}: a source it rests on was unreadable in one of the reads: nothing is sent, the next run looks again`); else await alert(key, a.title, a.text, now); }
// a condition that was evaluated and no longer holds is closed and marked cleared; conditions that could not be evaluated are left alone
if (last) { if (!last.hbValid) for (const i of (await api(`repos/${E.WATCH_REPO}/issues?state=open&per_page=50`).catch(() => [])) || []) { const m = /<!-- watch:(rung3:[^ ]+|heartbeat) -->/.exec(String(i.body || "")); if (m) active.add(m[1]); }
  if (anyRelUnreadable) for (const i of (await api(`repos/${E.WATCH_REPO}/issues?state=all&per_page=50`).catch(() => [])) || []) { const m = /<!-- watch:(release:[^ ]+) -->/.exec(String(i.body || "")); if (m) active.add(m[1]); }
  if (!anyUnreadable) await closeCleared(); }
console.log(`watched at ${new Date(now).toISOString()}: ${held.size} condition(s) held in ${READS} reads`);
