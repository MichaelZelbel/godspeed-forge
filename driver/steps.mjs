// The step runner. A step is one folded helper (driver/steps/<name>.mjs): it exports
//   STEP     { name, everyMinutes, maxMinutes, inRound }
//   SETTINGS [{ key, required, default, meaning }]   (checked by settings.mjs, which refuses a missing required key by name)
//   run(ctx) -> { ok, summary, halt?: { key, words, clear }, error? }
//     ctx = { settings, main, projects, env, settingsDir, now, log, dry, argv, clearHalt, stateDir }
//
// Every round (driver.mjs calls stepRound) the runner, for each enabled step:
//   - collects what its last child wrote, <server.state_dir>/steps/<name>/last.json (a child that was killed at its time
//     limit writes nothing: "launched, not running, no newer last.json" counts as a failed run);
//   - starts it, when it is due and not running, as a transient unit of the driver itself (systemd-run, no timer of its
//     own, collected when it ends so a failed step never lingers in `systemctl --failed`);
//   - or runs it inline in a try/catch when it is inRound.
// Step health is part of the inventory, so it has an owner (the driver) and a deadline like everything else:
//   step:<name>          its last 3 runs failed, or no successful run for 3 of its intervals (rung 0: it is started again
//                        by the next round anyway; rung 1 and up: an acting run with its last error)
//   halt:<name>:<key>    the step stopped itself and says why ("Mission Control has to look at it"); it starts at rung 1,
//                        with the halt's words and its `clear` command in the acting run's brief. The step sends nobody
//                        anything about a halt: the owner hears only through the ladder's rung 3, through the gate.
// This file imports nothing that can send a message, and removes nothing a person put there.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIN = 60000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STEPS_DIR = path.join(HERE, "steps");
const dig = (o, key) => key.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
const iso = ms => new Date(ms).toISOString();

// The modules in driver/steps/*.mjs, found by reading the folder, so the runner works before and after any step is added.
export async function discoverSteps(dir = STEPS_DIR) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith(".mjs")).sort(); } catch { /* no steps folder: no steps */ }
  const steps = [], errors = [];
  for (const n of names) {
    try {
      const m = await import(pathToFileURL(path.join(dir, n)).href);
      if (!m.STEP || !m.STEP.name || typeof m.run !== "function") { errors.push(`${n}: not a step (no STEP and run)`); continue; }
      steps.push({ name: m.STEP.name, STEP: m.STEP, SETTINGS: m.SETTINGS || [], run: m.run, file: n });
    } catch (e) { errors.push(`${n}: ${String(e.message).split("\n")[0]}`); }
  }
  return { steps, errors };
}

export const stepConfig = (settings, mod) => {
  const g = k => dig(settings, `steps.${mod.STEP.name}.${k}`);
  const stateDir = dig(settings, "server.state_dir") || "";
  return {
    enabled: g("enabled") !== false,
    every: Number(g("every_minutes") || mod.STEP.everyMinutes),
    max: Number(g("max_minutes") || mod.STEP.maxMinutes),
    stateDir: g("state_dir") || path.join(stateDir, "steps", mod.STEP.name),
  };
};
export const stepUnit = name => `forge-step-${name}`;
export const stepFolder = (settings, name) => path.join(dig(settings, "server.state_dir") || "", "steps", name);
export const lastFile = (settings, name) => path.join(stepFolder(settings, name), "last.json");

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function writeJson(f, data) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(data, null, 2) + "\n"); fs.renameSync(t, f); }

const realDeps = {
  isActive: unit => spawnSync("systemctl", ["is-active", "--quiet", `${unit}.service`]).status === 0,
  unitResult: unit => String(spawnSync("systemctl", ["show", "-p", "Result", "--value", `${unit}.service`], { encoding: "utf8" }).stdout || "").trim(),
  systemdRun: argv => spawnSync("systemd-run", argv, { encoding: "utf8", timeout: 60000 }),
  readJson,
};

// What a step is given.
export const stepContext = (base, mod, extra = {}) => ({
  settings: base.settings, main: base.main, projects: base.projects, env: base.env, settingsDir: base.settingsDir,
  now: base.now, log: base.log || (() => {}), dry: !!base.dry, argv: base.argv || [], clearHalt: !!base.clearHalt,
  stateDir: stepConfig(base.settings, mod).stateDir, ...extra,
});

// A step's answer, taken into the runner's memory of it.
function apply(s, r, endedAt) {
  const res = r && typeof r === "object" ? r : { ok: false, error: "the step returned nothing" };
  s.lastRunAt = endedAt; s.lastOk = !!res.ok; s.lastSummary = String(res.summary || "").slice(0, 300);
  if (res.ok) { s.failuresInRow = 0; s.lastSuccessAt = endedAt; s.lastError = null; }
  else { s.failuresInRow = (s.failuresInRow || 0) + 1; s.lastError = String(res.error || res.summary || "failed").slice(0, 400); }
  const halts = [...(res.halt ? [res.halt] : []), ...(Array.isArray(res.halts) ? res.halts : [])].filter(h => h && h.key);
  if (halts.length) {
    const old = s.halts || {};
    s.halts = Object.fromEntries(halts.map(h => [String(h.key), { words: String(h.words || "").slice(0, 1200), clear: String(h.clear || "").slice(0, 400), since: (old[h.key] || {}).since || endedAt }]));
  } else if (res.ok) s.halts = {}; // a run that finished with no halt: the condition ended (a failed run knows nothing new, so it keeps what it had)
}

// -> { launched: [name], collected: [{name, ok, summary}], running: {name: {startedAt, maxMin}}, errors: [text] }
// state.steps is the runner's memory (the driver's state.json). With ctx.dry nothing is started, run or written.
export async function stepRound(ctx, deps = {}) {
  const D = { ...realDeps, ...deps };
  const now = ctx.now, st = (ctx.state.steps ||= {});
  const out = { launched: [], collected: [], running: {}, errors: [] };
  const driverMjs = ctx.driverMjs || path.join(HERE, "driver.mjs");
  for (const mod of ctx.steps || []) {
    const name = mod.STEP.name, cfg = stepConfig(ctx.settings, mod);
    const s = (st[name] ||= { firstSeenAt: now });
    s.enabled = cfg.enabled;
    if (!cfg.enabled) continue;
    try {
      if (mod.STEP.inRound) {
        if (ctx.dry) continue;
        let r;
        try { r = await mod.run(stepContext(ctx, mod)); } catch (e) { r = { ok: false, error: `${String(e && e.message).slice(0, 300)}` }; }
        apply(s, r, now); s.launchedAt = now; s.settledLaunch = now;
        out.collected.push({ name, ok: !!(r && r.ok), summary: s.lastSummary });
        continue;
      }
      const unit = stepUnit(name);
      const active = !!D.isActive(unit);
      const last = D.readJson(lastFile(ctx.settings, name), null);
      const endedAt = last ? Date.parse(last.endedAt) : NaN;
      if (last && Number.isFinite(endedAt) && endedAt > (s.collectedEnd || 0)) {
        apply(s, last, endedAt); s.collectedEnd = endedAt;
        if (s.launchedAt && endedAt >= s.launchedAt - 1000) s.settledLaunch = s.launchedAt;
        out.collected.push({ name, ok: !!last.ok, summary: s.lastSummary });
      } else if (s.launchedAt && s.settledLaunch !== s.launchedAt && !active) {
        // launched, not running, and no newer last.json: it was killed at its time limit, or never started
        let why = "ended without a result";
        try { const res = D.unitResult(unit); if (res && res !== "success") why += ` (${res})`; } catch { /* the unit is gone: that is normal */ }
        apply(s, { ok: false, error: `the run started ${iso(s.launchedAt)} ${why}; it was killed at its time limit of ${cfg.max} minutes or could not run` }, now);
        s.settledLaunch = s.launchedAt;
        out.collected.push({ name, ok: false, summary: s.lastError });
      }
      if (active) { out.running[name] = { startedAt: s.launchedAt || now, maxMin: cfg.max }; continue; }
      const due = !s.launchedAt || now >= s.launchedAt + cfg.every * MIN;
      if (!due || ctx.dry) continue;
      const argv = [`--unit=${unit}`, "--collect", "--quiet", `--description=Factory driver step: ${name}`, "-p", `RuntimeMaxSec=${cfg.max * 60}`, "-p", "CollectMode=inactive-or-failed", "-p", "TimeoutStopSec=30",
        "--setenv=HOME=/root", "--setenv=LANG=C.UTF-8", ctx.node || process.execPath, driverMjs, "--step", name, "--settings-dir", ctx.settingsDir || ""];
      const r = D.systemdRun(argv);
      if (r.status === 0) { s.launchedAt = now; s.unit = unit; out.launched.push(name); out.running[name] = { startedAt: now, maxMin: cfg.max }; }
      else { apply(s, { ok: false, error: `could not start: ${String(r.stderr || "").trim().split("\n").pop() || `exit ${r.status}`}` }, now); s.launchedAt = now; s.settledLaunch = now; out.collected.push({ name, ok: false, summary: s.lastError }); }
    } catch (e) { out.errors.push(`${name}: ${String(e.message).slice(0, 200)}`); }
  }
  return out;
}

// The inventory entries of the steps' health (see the top). `ctx.steps`: the discovered steps.
export function stepEntries(state, steps, settings, now) {
  const out = [];
  for (const mod of steps || []) {
    const name = mod.STEP.name, cfg = stepConfig(settings, mod), s = (state.steps || {})[name];
    if (!s || !cfg.enabled) continue;
    const window = 3 * Math.max(cfg.every, cfg.max) * MIN;
    const base = s.lastSuccessAt || s.firstSeenAt || now;
    const failing = (s.failuresInRow || 0) >= 3 || now - base > window;
    if (failing && !(s.lastRunAt === undefined && !s.launchedAt)) {
      out.push({ id: `step:${name}`, kind: "step", step: name, owner: "the factory driver", title: `the ${name} step is not working`, milestoneAt: base, limitH: Math.max(1, Math.ceil((3 * cfg.every) / 60)),
        evidence: [`the ${name} step has failed ${s.failuresInRow || 0} runs in a row; its last successful run was ${s.lastSuccessAt ? iso(s.lastSuccessAt) : "never"}`,
          `its last error: ${s.lastError || "none recorded (no run has finished)"}`, `it runs every ${cfg.every} minutes, for at most ${cfg.max}; its state is in ${cfg.stateDir}; its runs are the unit ${stepUnit(name)} (journalctl -u ${stepUnit(name)})`] });
    }
    for (const [key, h] of Object.entries(s.halts || {})) {
      out.push({ id: `halt:${name}:${key}`, kind: "halt", step: name, owner: null, title: `the ${name} step stopped itself (${key})`, milestoneAt: h.since, limitH: 0,
        evidence: [`the ${name} step stopped itself and reports, on every run while it holds: ${h.words}`, ...(h.clear ? [`when it is put right, the step's own command ends the halt: ${h.clear}`] : []),
          `a halt is put right by acting on the server, never by waiting; nothing else moves it`] });
    }
  }
  return out;
}

// For status.json
export function stepStatus(state, steps, settings, running = {}) {
  const out = {};
  for (const mod of steps || []) {
    const name = mod.STEP.name, s = (state.steps || {})[name] || {};
    out[name] = { enabled: stepConfig(settings, mod).enabled, lastRun: s.lastRunAt ? iso(s.lastRunAt) : null, lastOk: s.lastOk === undefined ? null : !!s.lastOk, running: !!running[name], failuresInRow: s.failuresInRow || 0, halt: Object.keys(s.halts || {}) };
  }
  return out;
}

// `driver.mjs --step <name>`: run one step, and write <server.state_dir>/steps/<name>/last.json (not with --dry-run).
export async function runStep(mod, base) {
  const startedAt = Date.now();
  let r;
  try { r = await mod.run(stepContext({ ...base, now: startedAt }, mod)); } catch (e) { r = { ok: false, summary: "the step failed", error: String(e && e.message).slice(0, 400) }; }
  r = r && typeof r === "object" ? r : { ok: false, summary: "the step returned nothing", error: "no answer" };
  const result = { name: mod.STEP.name, startedAt: iso(startedAt), endedAt: iso(Date.now()), ok: !!r.ok, summary: String(r.summary || "").slice(0, 400), ...(r.error ? { error: String(r.error).slice(0, 400) } : {}), ...(r.halt ? { halt: r.halt } : {}), ...(r.halts ? { halts: r.halts } : {}) };
  if (!base.dry) writeJson(lastFile(base.settings, mod.STEP.name), result);
  return result;
}
