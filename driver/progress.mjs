// The ledger of real milestones (factory driver, Task 2). Progress is finished things only: a required
// check turning green, a PR merged, an issue closed, the release staged, the release installed.
// Comments and commits are activity, never progress.
export const MILESTONES = ["required-green", "pr-merged", "issue-closed", "staged", "installed"];
export const WORKING_MINUTES = 30;

export const ticketKeyOf = (release, ticket) => `${release.id}#${ticket.item}`;
export const releaseKeyOf = release => `release:${release.id}`;
const ts = v => (v ? Date.parse(v) : NaN);
const maxIso = list => { const t = list.map(ts).filter(Number.isFinite); return t.length ? new Date(Math.max(...t)).toISOString() : null; };

export function findTicket(world, ticketKey) {
  const i = String(ticketKey).lastIndexOf("#");
  const id = ticketKey.slice(0, i), item = Number(ticketKey.slice(i + 1));
  const release = (world.releases || []).find(r => r.id === id);
  const ticket = release && release.tickets.find(t => t.item === item);
  return ticket ? { release, ticket, item: ticket.issue ? (world.items || {})[ticket.issue] || null : null } : null;
}

// the milestones a ticket has reached right now, each with the mark that makes it count once
function reached(world, release, ticket) {
  const out = [];
  const item = ticket.issue ? (world.items || {})[ticket.issue] : null;
  if (item) {
    for (const p of item.prs || []) {
      if (p.requiredState === "success") out.push({ mark: `required-green:${p.number}`, kind: "required-green", at: p.requiredSince || world.at });
      if (p.merged) out.push({ mark: `pr-merged:${p.number}`, kind: "pr-merged", at: p.mergedAt || world.at });
    }
    if (item.state === "closed") out.push({ mark: "issue-closed", kind: "issue-closed", at: item.closedAt || world.at });
  }
  const st = (world.staging || {})[release.id];
  if (st) out.push({ mark: "staged", kind: "staged", at: st.stagedAt || st.at || world.at });
  if (st && st.status === "installed") out.push({ mark: "installed", kind: "installed", at: st.installedAt || st.at || world.at });
  return out;
}

export function activityOf(world, ticketKey) {
  const f = findTicket(world, ticketKey);
  if (!f || !f.item) return [];
  const times = (f.item.comments || []).map(c => c.at);
  for (const p of f.item.prs || []) times.push(p.lastCommitAt, ...(p.comments || []).map(c => c.at));
  for (const r of world.factory ? world.factory.activeRuns || [] : []) if (f.ticket.issue && r.issue === f.ticket.issue) times.push(r.lastOutputAt);
  return times.filter(Boolean);
}

export function updateLedger(prev, world, now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  const ledger = JSON.parse(JSON.stringify(prev || {}));
  for (const release of world.releases || []) {
    for (const ticket of release.tickets || []) {
      if (!ticket.issue) continue;
      const key = ticketKeyOf(release, ticket);
      const e = ledger[key] || (ledger[key] = { firstSeenAt: nowIso, lastMilestoneAt: nowIso, milestones: [], marks: [], lastActivityAt: null });
      const item = (world.items || {})[ticket.issue];
      if (!item) continue; // unreadable: change nothing, conclude nothing
      for (const m of reached(world, release, ticket)) {
        if (e.marks.includes(m.mark)) continue;
        e.marks.push(m.mark);
        e.milestones.push({ kind: m.kind, at: m.at });
      }
      e.lastMilestoneAt = maxIso([e.firstSeenAt, ...e.milestones.map(m => m.at)]);
      e.lastActivityAt = maxIso([e.lastActivityAt, ...activityOf(world, key)]);
    }
    // the release as a whole (2026-11-21): its newest milestone is the newest of any of its tickets and
    // of any change in its staging record (a freeze, a stage step, the install). No cause is looked at:
    // a release that reaches nothing new for hours is stuck, whatever the reason.
    const mine = (release.tickets || []).filter(t => t.issue).map(t => ledger[ticketKeyOf(release, t)]).filter(Boolean);
    const rk = releaseKeyOf(release);
    const first = mine.length ? new Date(Math.min(...mine.map(t => ts(t.firstSeenAt)))).toISOString() : nowIso;
    const isNew = !ledger[rk];
    const r = ledger[rk] || (ledger[rk] = { firstSeenAt: first, lastMilestoneAt: first, stagingMark: null, stagingAt: null });
    const sg = (world.staging || {})[release.id]; // only the fields a stage step changes, never a timestamp of a mere look
    const mark = sg ? JSON.stringify([sg.status, sg.tag, sg.stageCommit, sg.stagedAt, sg.installedAt, sg.finishedAt]) : null;
    if (r.stagingMark !== mark) { if (!isNew) r.stagingAt = nowIso; r.stagingMark = mark; }
    r.lastMilestoneAt = maxIso([r.firstSeenAt, r.stagingAt, ...mine.map(t => t.lastMilestoneAt)]);
  }
  return ledger;
}

// a commit, a comment or run output in the last 30 minutes
export function isWorking(ticketKey, world, now = Date.now()) {
  return activityOf(world, ticketKey).some(t => now - ts(t) <= WORKING_MINUTES * 60000 && now - ts(t) >= -60000);
}
