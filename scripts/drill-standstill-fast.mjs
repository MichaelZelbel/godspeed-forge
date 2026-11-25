// The standstill drill's fast mode (called by drill-standstill.sh, never by hand): the REAL installed driver and dead-man, round
// after round, with the clock moved forward. Michael, 2026-11-24: no one-hour drills. Nothing here is a copy of either program: it
// imports the installed driver.mjs and deadman.mjs and calls their own entry points (the driver's `cli`, the dead-man's `run`),
// passing only the time they are to believe it is (the driver's `deps.now`, the dead-man's `now`) and the two stand-ins the real
// timers make true by waiting (the monotonic clock and GitHub's own clock). The acting runs are the real ones: systemd units
// running the drill's stand-in AIs, which this waits for after each round, as the real minutes would have.
//
//   node drill-standstill-fast.mjs <T0 in milliseconds> [minutes, default 65] [step in minutes, default 5]
//
// Writes /var/lib/forge-drill/deadman-fast.json: what the dead-man said in each of its runs, with the minute it was said at.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const T0 = Number(process.argv[2]), TOTAL = Number(process.argv[3] || 65), STEP = Number(process.argv[4] || 5);
if (!Number.isFinite(T0)) { console.error("usage: node drill-standstill-fast.mjs <T0 in ms> [minutes] [step]"); process.exit(2); }
const DRILL = "/var/lib/forge-drill", SETTINGS = "/etc/godspeed-forge";
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

// where the installed programs are: the units name them
const unit = name => fs.readFileSync(`/etc/systemd/system/${name}`, "utf8");
const exec = text => (/^ExecStart=(.*)$/m.exec(text) || [])[1] || "";
const driverMjs = (/(\S+driver\.mjs)/.exec(exec(unit("factory-driver.service"))) || [])[1];
const deadmanMjs = (/(\S+deadman\.mjs)/.exec(exec(unit("factory-deadman.service"))) || [])[1];
if (!driverMjs || !deadmanMjs) { console.error("the installed driver or dead-man was not found in their units"); process.exit(1); }
// the dead-man's environment, as its unit gives it (an EnvironmentFile); the driver reads its own from the settings
for (const l of fs.readFileSync(`${SETTINGS}/driver.env`, "utf8").split("\n")) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim()); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1"); }

const driver = await import(pathToFileURL(driverMjs).href);
const deadman = await import(pathToFileURL(deadmanMjs).href);
const iso = ms => new Date(ms).toISOString();
const said = [];
let now = T0;

// An acting run takes seconds; the real minutes would have let it finish before the next round.
function waitForActs(maxSeconds = 90) {
  const t = Date.now();
  while (Date.now() - t < maxSeconds * 1000) {
    const r = sh("systemctl", ["list-units", "--all", "--no-legend", "--plain", "factory-act-*", "factory-repair-*"]);
    const live = String(r.stdout || "").split("\n").filter(l => /\s(active|activating)\s/.test(l));
    if (!live.length) return;
    sh("sleep", ["2"]);
  }
}
// The driver writes its status with the machine's own clock; the dead-man judges it against this clock. Both come from one time.
function stampStatus() {
  const f = process.env.DM_STATUS || "/var/lib/godspeed/forge/driver/status.json";
  try { const j = JSON.parse(fs.readFileSync(f, "utf8")); j.at = iso(now); fs.writeFileSync(f, JSON.stringify(j)); const s = new Date(now); fs.utimesSync(f, s, s); } catch { /* none yet */ }
  try { const h = path.join(process.env.FD_STATE_DIR || "/var/lib/godspeed/forge/driver", "heartbeat"); fs.writeFileSync(h, `${iso(now)}\n`); const s = new Date(now); fs.utimesSync(h, s, s); } catch { /* none */ }
}

// the first round is the one before minute 0 (the driver has done a round when the release begins to stand still)
for (let minute = -STEP; minute <= TOTAL; minute += STEP) {
  now = T0 + minute * 60000;
  if (minute >= 0 && minute % 15 === 0) sh(`${DRILL}/bin/stage-look`, []); // the stand-in stage step, as its timer would
  const out = [];
  const log = s => out.push(s);
  await driver.cli(["--settings-dir", SETTINGS], { deps: { now: () => now, mono: () => ({ uptime: NaN, boot: "" }), clockCheck: () => ({ ok: true, ghNow: NaN, skewMs: NaN }) }, log });
  waitForActs();
  stampStatus();
  const lines = [];
  await deadman.run(deadman.defaults(process.env), now, s => lines.push(String(s)), {});
  waitForActs();
  for (const t of lines) said.push({ minute, at: iso(now), text: t });
  console.log(`minute ${String(minute).padStart(2)}: driver round done, dead-man run done`);
}
fs.writeFileSync(`${DRILL}/deadman-fast.json`, JSON.stringify(said, null, 1));
console.log(`the dead-man said ${said.length} line(s); kept in ${DRILL}/deadman-fast.json`);
