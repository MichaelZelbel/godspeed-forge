// A dry run changes nothing. The round already skips every write when it is told --dry-run; this is the second lock on
// the same door, so that a dry run is safe to start on a server where another driver still runs and shares the
// state folders: any write to a file outside the temporary folder, and any command that starts, stops or changes
// something (a unit, a GitHub write, a git write), is refused with a plain error and noted in `refused`.
// driver.mjs imports this file first; it takes effect only when the program was started with --dry-run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

export const refused = [];
const WRITERS = ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "rmSync", "unlinkSync", "rmdirSync", "copyFileSync", "symlinkSync", "cpSync", "truncateSync", "chmodSync", "chownSync", "utimesSync", "mkdtempSync"];
// commands that change something (matched on the whole command line)
export const WRITE_COMMAND = /\bsystemd-run\b|\bsystemctl\b[^|;&]*\b(start|stop|restart|enable|disable|reset-failed|daemon-reload|kill|mask|unmask)\b|\bgh\b[^|;&]*(-X\s*(POST|PATCH|PUT|DELETE)|--method\s*(POST|PATCH|PUT|DELETE)|\bworkflow\s+run\b|\bissue\s+(create|comment|close|edit)\b|\bpr\s+(merge|create|comment|review|close)\b)|\bgit\b[^|;&]*\b(push|commit|pull|add|reset|checkout|merge|rebase|clean|clone)\b|\b(kill|pkill|rm|mv|cp|tee|chmod|chown|apt|apt-get|ln)\s/;

const under = (p, dir) => { const r = path.relative(path.resolve(dir), path.resolve(String(p))); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
const allowedPath = p => { try { return under(p, os.tmpdir()); } catch { return false; } };
const commandLine = (cmd, args) => [cmd, ...(Array.isArray(args) ? args : [])].join(" ");

export function enforceReadOnly() {
  const saved = [];
  const wrap = (obj, name, check) => {
    const orig = obj[name];
    if (typeof orig !== "function") return;
    saved.push([obj, name, orig]);
    obj[name] = function (...a) { check(a); return orig.apply(this, a); };
  };
  for (const n of WRITERS) wrap(fs, n, a => { if (!allowedPath(a[0]) || (n === "renameSync" && !allowedPath(a[1]))) { const e = `dry run: refused ${n} ${a[0]}`; refused.push(e); throw new Error(e); } });
  wrap(fs, "openSync", a => { if (typeof a[1] === "string" && /[wa+]/.test(a[1]) && !allowedPath(a[0])) { const e = `dry run: refused to open ${a[0]} for writing`; refused.push(e); throw new Error(e); } });
  wrap(fs, "createWriteStream", a => { if (!allowedPath(a[0])) { const e = `dry run: refused to write ${a[0]}`; refused.push(e); throw new Error(e); } });
  for (const n of ["spawnSync", "execSync", "execFileSync", "spawn", "exec", "execFile"]) {
    wrap(cp, n, a => {
      const line = n === "execSync" || n === "exec" ? String(a[0]) : commandLine(a[0], a[1]);
      if (WRITE_COMMAND.test(line)) { const e = `dry run: refused to run: ${line.slice(0, 200)}`; refused.push(e); throw new Error(e); }
    });
  }
  syncBuiltinESMExports();
  return () => { for (const [obj, name, orig] of saved.reverse()) obj[name] = orig; syncBuiltinESMExports(); };
}

if (process.argv.includes("--dry-run") && !process.env.FD_NO_READONLY) enforceReadOnly();
