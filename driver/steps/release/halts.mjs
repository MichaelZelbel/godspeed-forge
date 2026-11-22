// A halt is what a step returns when a person's help used to be asked for: a plain reason (what
// happened, no instruction to anyone) and the exact command an acting AI run with root uses to clear
// the halt after it has fixed the cause. The step sends nobody anything about it; the driver turns
// the halt into an inventory entry that climbs its ladder.
export function clearCommandFor(ctx, step, key) {
  if (ctx && typeof ctx.clearHaltCommand === "function") return ctx.clearHaltCommand(step, key);
  const dir = (ctx && ctx.settings && ctx.settings.server && ctx.settings.server.driver_dir) || "<driver_dir>";
  const sd = ctx && ctx.settingsDir ? ` --settings-dir ${ctx.settingsDir}` : "";
  return `node ${dir}/driver.mjs --step ${step} --clear-halt ${key}${sd}`;
}

export function makeHalt(ctx, step, key, words) {
  return { key, words: String(words).replace(/\s+/g, " ").trim(), clear: clearCommandFor(ctx, step, key) };
}

// An old message's text (from a state file written before the fold) without its hand-off sentence.
export function plainHaltWords(text) {
  return String(text || "")
    .replace(/\s*Mission Control (?:has to|should) (?:look at it|do that part by hand[^.]*|plan this one)\.?/gi, "")
    .replace(/\s+and I will not (?:carry on|try again) by myself\./gi, ".")
    .replace(/\s*I will not (?:carry on|try again) by myself\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}
