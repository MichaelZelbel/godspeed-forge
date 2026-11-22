// The one gate every message to the owner goes through (2026-11-22, after four batches of false alarms in one night, each fixed one
// case at a time). Nothing reaches him on one reading:
//   (a) the same condition on 3 consecutive reads at least 10 minutes apart (a condition that is absent in between starts over);
//   (b) a fresh re-read of every source the condition depends on, immediately before sending;
//   (c) no source in that re-read unreadable: an unreadable source is a reason to look again, never a reason to alarm.
// Reminders are the one exception (a pause is reminded daily by design). The dead-man and the watcher share no code with the driver
// and carry the same three rules in their own programs; test-gate.mjs asserts the three agree.
export const GATE = { reads: 3, gapMs: 10 * 60000, toleranceMs: 0 }; // exactly: readings at least 10 minutes apart

// state.gate[key] = { reads: [ms, ...] }. Call once per round for every condition that wants a message. -> { ready, n }
export function gateStep(gate, key, now, cfg = GATE) {
  const g = (gate[key] ||= { reads: [] });
  const last = g.reads.at(-1);
  if (last === undefined || now - last >= cfg.gapMs - (cfg.toleranceMs || 0)) g.reads.push(now);
  g.reads = g.reads.slice(-cfg.reads);
  const n = g.reads.length;
  const ready = n >= cfg.reads && g.reads.at(-1) - g.reads[0] >= (cfg.reads - 1) * (cfg.gapMs - (cfg.toleranceMs || 0));
  return { ready, n };
}
// a condition that did not hold this round starts over
export function gateClear(gate, presentKeys) {
  for (const k of Object.keys(gate)) if (!presentKeys.has(k)) delete gate[k];
}
