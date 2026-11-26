// What the owner can see of the release clock (the Forge 0.3.3): one line per approved release, on the Forge's own page.
// The page where he watches the factory is Archon's own server, which the Forge only puts a web address and a sign-in in front of, so
// the driver writes this small page into a folder the Forge owns (lib/watch.mjs STATUS_DIR) and the same web address serves it at
// /forge/release-clock.html. Every round rewrites it. Nothing here sends anything to anyone.
import fs from "node:fs";
import path from "node:path";
import { versionWords } from "./release-driver/release-driver-cut.mjs";

export const STATUS_DIR = "/opt/godspeed-forge/watch/status";
const when = ms => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";

// One plain line: where the release is, the minutes since it last made progress, and what happens next at which minute.
// k: a clock of the round's out.standstill ({id, version, inStep, why, minutes, where, next, held})
export function clockLine(k) {
  const name = k.version ? versionWords(k.version) : k.id;
  if (!k.inStep) return `${name}: ${k.why}.`;
  const held = (k.held || []).length ? `, held by ${k.held.join("; ")}` : "";
  return `${name}: ${k.where || "no detail"}; no progress for ${k.minutes} minutes${held}; next: ${k.next.what} at minute ${k.next.at}.`;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export function clockPage(lines, nowMs) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="60"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Release clock</title></head>\n<body style="font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem">\n<h1>Where each release is</h1>\n${lines.length ? `<ul>\n${lines.map(l => `<li>${esc(l)}</li>`).join("\n")}\n</ul>` : "<p>No release is approved and waiting.</p>"}\n<p><small>Written by the factory driver at ${when(nowMs)}; this page refreshes itself every minute.</small></p>\n</body></html>\n`;
}

// Writes release-clock.html (and a plain release-clock.txt) when the folder exists (the watching page is set up); never throws.
export function writeClockPage(dir, clocks, nowMs, fsx = fs) {
  try {
    if (!fsx.existsSync(dir)) return { written: false, why: "the watching page's folder is not there" };
    const lines = (clocks || []).map(clockLine);
    for (const [name, text] of [["release-clock.html", clockPage(lines, nowMs)], ["release-clock.txt", `${lines.join("\n")}\n`]]) {
      const f = path.join(dir, name), tmp = `${f}.${process.pid}.tmp`;
      fsx.writeFileSync(tmp, text, { mode: 0o644 }); fsx.renameSync(tmp, f);
    }
    return { written: true, lines };
  } catch (e) { return { written: false, why: String(e && e.message).slice(0, 160) }; }
}
