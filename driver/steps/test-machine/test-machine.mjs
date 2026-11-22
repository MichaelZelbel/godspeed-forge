#!/usr/bin/env node
// The test machine's watcher (2026-11-17, "build those three and roll them out"): the hidden
// checks' own health, outside the release driver.
//
// WHY. Until 17 November the release driver repaired the holdout verifier itself, inside a look meant to
// drive a release, and the repair's AI could never see a browser: it runs in Codex's sandbox, which
// refuses loopback sockets and Chromium's own sandbox, so every browser observation stayed INCOMPLETE
// and the release waited on a machine nobody could prove broken or fixed. "It's not the driver's job to
// fix code itself; it's the driver's job to drive the release." So the test machine is its own program:
// it watches, it repairs, and it tells the driver whether proof can run. Since the driver took it in it
// is the driver's "test-machine" step (driver/steps/test-machine.mjs builds its configuration from the
// settings), every 30 minutes, as root.
//
// WHAT:
//   1. Watch. As the factory user, outside any sandbox: a built checkout of the release currently
//      staged on the owner's server (cached per commit), the smoke test (the verifier's browser starts,
//      the notebook binds loopback, a real page stays up), and one known-good holdout (env.HOLDOUT) run
//      exactly as its TOOL.md says. Healthy means the smoke test passed and the holdout came back PASS or
//      FAIL: a real verdict, whatever it is. INCOMPLETE, or no verdict line at all, is unhealthy. So is a
//      hidden scenario without a tool whose command can run (toolCoverage: "H-35 has no tool"). The
//      result goes to <state dir>/state.json ({healthy, since, why, tools, ...}), which the driver reads.
//   2. Repair. Unhealthy: the referee repair (referee.mjs: the AI writes only in its sandbox copy, root
//      applies the reviewed copy, no judge or scenario text changes, INCOMPLETE never becomes PASS), at
//      most 3 a day. After an applied repair this program runs the named observations again itself,
//      outside the sandbox, and records their real verdicts.
//   3. Halt. Still broken after a repair, the day's repairs used up, or a repair the audit stopped: the
//      look returns a halt (key, plain words) and the driver owns it. This program tells nobody. A
//      hidden check without a tool is no halt: the factory driver builds the tool, so it is only logged.
// It never changes a judge or a scenario, never writes PASS for something not observed, and posts
// nothing on GitHub.
//
//   --dry-run     check and print; no repair, no state
//   --clear-halt  after a repair the audit stopped has been looked at
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { repairLook, smoke as refereeSmoke, asForgeArgv } from "./referee.mjs";

const iso = ms => new Date(ms).toISOString();
const short = t => String(t || "").replace(/\s+/g, " ").trim();
const sha = s => crypto.createHash("sha1").update(String(s)).digest("hex");
const ROOT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// The configuration, from TM_* values (the step builds them from the settings; nothing here names a
// server, a user or a person). Whatever is not given stays undefined, and the step refuses to run without
// the values a look needs.
export const defaults = (argv = process.argv, e = process.env) => ({
  REPO: e.TM_REPO,
  STATE_DIR: e.TM_STATE_DIR,
  RELEASES_DIR: e.TM_RELEASES_DIR,
  FORGE_USER: e.FORGE_USER, FORGE_UID: e.FORGE_UID === undefined ? undefined : Number(e.FORGE_UID),
  TOOLS_DIR: e.TM_TOOLS_DIR,
  SCENARIOS_DIR: e.TM_SCENARIOS_DIR,
  HOLDOUTS_DIR: e.TM_HOLDOUTS_DIR || (e.TM_SCENARIOS_DIR ? path.posix.dirname(e.TM_SCENARIOS_DIR) : undefined),
  WORK: e.TM_WORK,
  HOLDOUT: e.TM_HOLDOUT,
  SOURCE_CHECKOUT: e.TM_SOURCE_CHECKOUT,
  CHECKOUTS: e.TM_CHECKOUTS ? String(e.TM_CHECKOUTS).split(",").filter(Boolean) : [],
  REFEREE_WORK: e.TM_REFEREE_WORK,
  STRONG_MODEL: e.TM_STRONG_MODEL, REPAIR_MINUTES: Number(e.TM_REPAIR_MINUTES || 35),
  OBSERVE_MINUTES: Number(e.TM_OBSERVE_MINUTES || 15),
  FORGE_HOME: e.TM_FORGE_HOME, FORGE_GID: e.FORGE_GID === undefined ? undefined : Number(e.FORGE_GID),
  // the place every tool names (/tmp, wiped on reboot) is a link to a folder in the factory user's home
  BROWSER_ROOT: e.TM_BROWSER_ROOT, BROWSER_HOME: e.TM_BROWSER_HOME,
  DEBS_ROOT: e.TM_DEBS_ROOT, DEBS_HOME: e.TM_DEBS_HOME,
  PLAYWRIGHT_VERSION: e.TM_PLAYWRIGHT_VERSION || "1.65.1",
  NETNS: e.TM_NETNS,
  MANAGER_UNIT: e.TM_MANAGER_UNIT,
  OWNER_NAME: e.TM_OWNER_NAME,
  SETTINGS_DIR: e.TM_SETTINGS_DIR,
  DRY: argv.includes("--dry-run"), CLEAR_HALT: argv.includes("--clear-halt"),
});

// ---------------------------------------------------------------- pure
export function compareVersions(a, b) {
  const split = v => { const s = String(v); const cut = s.indexOf("-"); return { main: (cut < 0 ? s : s.slice(0, cut)).split(".").map(Number), pre: cut < 0 ? [] : s.slice(cut + 1).split(".") }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < 3; i++) if ((x.main[i] || 0) !== (y.main[i] || 0)) return (x.main[i] || 0) < (y.main[i] || 0) ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1; if (y.pre[i] === undefined) return 1;
    const nx = /^\d+$/.test(x.pre[i]), ny = /^\d+$/.test(y.pre[i]);
    if (nx && ny && Number(x.pre[i]) !== Number(y.pre[i])) return Number(x.pre[i]) < Number(y.pre[i]) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x.pre[i] !== y.pre[i]) return x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
}
// The release on the owner's server: the newest staging.json of this repository that says installed.
// stagings: [{id, staging}] -> {id, version, commit} or null
export function stagedRelease(stagings, repo) {
  const ok = stagings.filter(s => s.staging && s.staging.status === "installed" && s.staging.version && /^[0-9a-f]{40}$/.test(String(s.staging.productCommit || ""))
    && String(s.staging.repository || repo).toLowerCase() === String(repo).toLowerCase())
    .sort((a, b) => compareVersions(b.staging.version, a.staging.version));
  return ok.length ? { id: ok[0].id, version: ok[0].staging.version, commit: ok[0].staging.productCommit } : null;
}
// The holdout's command from its TOOL.md ("## Command", the first indented line), with the places
// filled in. The judges live beside the hidden scenarios (an older TOOL.md names them inside the target).
export function commandOf(toolMd, { id, tools, target, out, judges }) {
  const sec = /^##\s+Command\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(String(toolMd || ""));
  if (!sec) return null;
  // an indented line, or (H-34's TOOL.md) a line that is one code span and nothing else
  const raw = sec[1].split("\n").find(l => /^( {4}|\t)\S/.test(l) || /^`[^`]+`\s*$/.test(l));
  if (!raw) return null;
  const line = /^`[^`]+`\s*$/.test(raw) ? raw.trim().slice(1, -1) : raw;
  return line.trim().split("{target}/.factory/holdout/judges").join(judges)
    .split("{tools}").join(tools).split("{id}").join(id).split("{target}").join(target).split("{out}").join(out).split("{judges}").join(judges);
}
// The verdict is the last "verdict: X" line; anything else (a crash, no line, a word that is not one
// of the three) is INCOMPLETE. Never PASS without the line saying so.
export function verdictOf(output) {
  const all = [...String(output || "").matchAll(/^\s*verdict:\s*(PASS|FAIL|INCOMPLETE)\b/gim)];
  return all.length ? all.at(-1)[1].toUpperCase() : "INCOMPLETE";
}
// A broken browser or a known-good check without a real verdict is said first, because the environment
// repair is for those; then every scenario without a tool that can run (toolCoverage).
export function judgeHealth({ smoke, holdout, coverage }) {
  // a check of the tools that could not be made is no proof that they are there
  const tools = coverage && coverage.failed ? `the hidden checks' tools could not be checked (${short(coverage.why)})`
    : coverage && coverage.missing && coverage.missing.length ? coverage.missing.map(m => m.why).join("; ") : "";
  // the environment is said first (the repair is for it); a missing tool is said with it, never dropped
  const also = tools ? `; also ${tools}` : "";
  if (!smoke || !smoke.ok) return { healthy: false, why: `the verifier's browser did not stay up on a real page (${short((smoke && (smoke.error || smoke.browser)) || "no answer")})${also}` };
  if (!holdout || !["PASS", "FAIL"].includes(holdout.verdict)) return { healthy: false, why: `the known-good hidden check ${holdout ? holdout.id : "?"} came back ${holdout ? holdout.verdict : "with nothing"}, not a real verdict${also}` };
  if (tools) return { healthy: false, tools: true, why: tools };
  return { healthy: true, why: `the browser stays up and ${holdout.id} came back ${holdout.verdict}${coverage && coverage.ids && coverage.ids.length ? `, and all ${coverage.ids.length} hidden checks have a tool` : ""}` };
}

// ---------------------------------------------------------------- every scenario has a tool (2026-11-18)
// WHY. On 18 November seven hidden scenarios (H-33, H-35 to H-40) had no tool, the loop's verifier
// refused every pull request they cover ("no executable verifier command"), and this watcher said
// healthy, because it judged health by H-23 alone. The holdout writer adds scenarios; nothing added
// their tools, and nothing noticed. So every look reads the scenario ids from the hidden scenario file
// and checks that each has a tool folder whose TOOL.md names a Command and whose files are there.
// It reads ids and paths only, never a scenario's text.
//
// The ids: every "## H-NN" heading, outside fenced code blocks (the file's own example form is one).
export function scenarioIds(md) {
  const ids = []; let fence = null; // the marker that opened the code block: only the same kind closes it
  for (const line of String(md || "").split(/\r?\n/)) {
    // a block opens with a marker (an info string may follow) and closes with the same kind, at least as
    // long, and nothing after it
    if (!fence) { const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line); if (f) { fence = f[1]; continue; } }
    else { const f = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line); if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue; }
    const m = !fence && /^ {0,3}##\s+(H-\d+)\b/.exec(line);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}
// -> {ids, missing: [{id, why}], why?}. A command "runs" when it is named and every file it names in
// the tools folder or beside the scenarios is there; running each one is the loop's job, not a look's.
export function toolCoverage(env, deps = {}) {
  const exists = deps.exists || (p => fs.existsSync(p));
  const read = deps.read || (p => fs.readFileSync(p, "utf8"));
  if (!env.SCENARIOS_DIR) return { ids: [], missing: [], why: "no hidden scenario folder is set" };
  const scen = path.join(env.SCENARIOS_DIR, "HOLDOUT.md");
  if (!exists(scen)) return { ids: [], missing: [], why: "no hidden scenario file", failed: true };
  const ids = scenarioIds(read(scen)), judges = path.posix.join(env.SCENARIOS_DIR, "judges"), roots = [env.TOOLS_DIR, env.SCENARIOS_DIR].filter(Boolean);
  const missing = [];
  for (const id of ids) {
    const md = env.TOOLS_DIR && path.join(env.TOOLS_DIR, id, "TOOL.md");
    if (!md || !exists(md)) { missing.push({ id, why: `${id} has no tool` }); continue; }
    const cmd = commandOf(read(md), { id, tools: env.TOOLS_DIR, target: "{target}", out: "{out}", judges });
    if (!cmd) { missing.push({ id, why: `${id} has no tool: its TOOL.md names no command` }); continue; }
    const gone = cmd.split(/[\s;&|()'"`]+/).filter(t => roots.some(r => t.startsWith(r)) && !t.includes("{")).find(t => !exists(t));
    if (gone) missing.push({ id, why: `${id} has no tool: its command names ${gone}, which is not there` });
  }
  return { ids, missing };
}
// what the driver reads: healthy, since (when it last changed), why
export function nextState(prev, health, now, extra = {}) {
  const changed = !prev || prev.healthy !== health.healthy;
  return { ...extra, healthy: health.healthy, since: changed ? iso(now) : prev.since, why: health.why, checkedAt: iso(now) };
}

// ---------------------------------------------------------------- findable (2026-11-17)
// WHY. On PR #671 the loop's verifier came back INCOMPLETE "no browser" twice, with a working browser
// on the machine: the loop runs Codex with full access, not in a sandbox, and the same verifier got real
// browser verdicts that morning. It never found its tools (`find holdout-tools -maxdepth 2 -type f`
// sees nothing: every file sits one level deeper) and then looked for a browser only on the PATH and in
// the checkout, where none is (Playwright and Chromium live in /tmp/hv-pw, set by _lib/browser.sh). So
// each look makes them findable where a verifier looks: one line in the hidden scenario file (outside
// every scenario), a list of the tools at the tools folder's top, Playwright as a global Node module
// (~/.node_modules), Chromium in Playwright's default place (~/.cache/ms-playwright) and `chromium` on
// the PATH (~/.local/bin). It changes no tool, judge, scenario text or id, and no file of Cole's.
export const POINTER_MARK = "Tools and browser for the verifier:";
// The line says which scenarios have no tool yet (toolCoverage), so it is true; until 18 November it
// claimed every scenario had one while seven had none.
const andList = xs => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
export const pointerLine = (toolsDir, missing = []) => `${POINTER_MARK} every scenario here ${missing.length ? `has a tool in ${toolsDir}/<id>/ except ${andList(missing)}, which ${missing.length === 1 ? "has" : "have"} none yet` : `already has a tool in ${toolsDir}/<id>/`} (run the Command in its TOOL.md; ${toolsDir}/README.md lists them all), and the browser is ready: \`source ${toolsDir}/_lib/browser.sh\` gives Playwright with Chromium, which is also found as require("playwright") and as \`chromium\` on the PATH.`;
// The hidden scenario file with the line in it, in the section on how scenarios are run (never inside
// a scenario); null when it is there already.
export function withPointer(md, line) {
  const lines = String(md || "").split("\n");
  const at = lines.findIndex(l => l.startsWith(POINTER_MARK));
  if (at >= 0) { if (lines[at] === line) return null; lines[at] = line; return lines.join("\n"); }
  let h = lines.findIndex(l => /^##\s+How these scenarios are run\s*$/.test(l));
  if (h < 0) h = lines.findIndex(l => /^#\s/.test(l));
  if (h < 0) return [line, "", ...lines].join("\n");
  lines.splice(h + 1, 0, "", line);
  return lines.join("\n");
}
// tools: [{id, command|null}], missing: scenario ids without a tool folder -> README.md for the top of
// the tools folder
export function toolsIndex(tools, toolsDir, browsers, missing = []) {
  const byId = [...tools, ...missing.filter(id => !tools.some(t => t.id === id)).map(id => ({ id, none: true }))].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  return [
    "# The holdout verifier's tools (never a builder's)", "",
    "Every hidden scenario has its tool here, one folder per id. Run the command below (the same as the",
    "Command in that folder's TOOL.md), with {target} the built checkout under test and {out} a new",
    "evidence folder. Its last line is `verdict: PASS`, `verdict: FAIL` or `verdict: INCOMPLETE`.", "",
    `The browser is ready: \`source ${toolsDir}/_lib/browser.sh\` sets Playwright and Chromium`,
    `(${browsers}). Do not look for a browser on the PATH or in the checkout first.`, "",
    "Written by the test machine's watcher every 30 minutes; change a tool, never this list.", "",
    ...byId.map(t => t.none ? `- ${t.id}: no tool yet` : t.command ? `- ${t.id}: \`${t.command}\`` : `- ${t.id}: its TOOL.md names no command yet`), "",
  ].join("\n");
}
export const WRAPPER_MARK = "# the holdout verifier's Chromium, written by the test machine's watcher";
export const chromiumWrapper = (home, toolsDir) => `#!/bin/sh
${WRAPPER_MARK} (see ${toolsDir}/README.md)
last=""
for c in ${home}/.cache/ms-playwright/chromium-*/chrome-linux*/chrome; do [ -x "$c" ] && last="$c"; done
[ -n "$last" ] || { echo "chromium: the verifier's browser is missing; source ${toolsDir}/_lib/browser.sh" >&2; exit 127; }
exec "$last" --no-sandbox "$@"
`;

const brokenText = state => `The test machine that checks the releases cannot run its hidden checks since ${String(state.since).slice(0, 16).replace("T", " ")} UTC (${short(state.why).slice(0, 300)}), and its automatic repair did not fix it; releases wait for that proof until the cause is put right.`;
const haltedText = state => `The program that repairs the test machine for the releases stopped itself at ${String(state.halted.at).slice(0, 16).replace("T", " ")} UTC, because its AI did something it is never allowed to do (${short(state.halted.why).slice(0, 300)}); nothing more is repaired until someone has looked at it and cleared the halt.`;
const toolsText = (state, coverage) => !coverage.missing.length ? `The test machine that checks the releases cannot tell which hidden checks it has a tool for since ${String(state.since).slice(0, 16).replace("T", " ")} UTC, so releases wait for that proof.` : `${coverage.missing.length === 1 ? "One hidden check" : `${coverage.missing.length} hidden checks`} of the test machine that checks the releases ${coverage.missing.length === 1 ? "has" : "have"} no tool to run ${coverage.missing.length === 1 ? "it" : "them"} since ${String(state.since).slice(0, 16).replace("T", " ")} UTC, so the changes they cover wait until ${coverage.missing.length === 1 ? "it is" : "they are"} written.`;

// ---------------------------------------------------------------- effects
// as the factory account, inside its own network namespace once that exists (referee.mjs, asForgeArgv)
const asForge = (env, script, timeoutMin = 30) => spawnSync(...asForgeArgv(env, ["-u", env.FORGE_USER, "--", "env", "-i", `HOME=${env.FORGE_HOME}`, "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", `XDG_RUNTIME_DIR=/run/user/${env.FORGE_UID}`, "GIT_TERMINAL_PROMPT=0", "bash", "-c", script]),
  { encoding: "utf8", timeout: timeoutMin * 60000, maxBuffer: 64 * 1024 * 1024, env: { PATH: ROOT_PATH } });
const q = s => `'${String(s).replace(/'/g, "'\\''")}'`;
function readStagings(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => { try { return { id: d.name, staging: JSON.parse(fs.readFileSync(path.join(dir, d.name, "staging.json"), "utf8")) }; } catch { return null; } }).filter(Boolean);
}
// a built checkout of one commit, kept between looks (one at a time)
export function prepareTarget(env, commit) {
  const dir = path.posix.join(env.WORK, `target-${commit.slice(0, 12)}`);
  const r = asForge(env, [
    "set -eu", "umask 022", `mkdir -p ${q(env.WORK)}`,
    `for d in ${q(env.WORK)}/target-*; do [ -e "$d" ] && [ "$d" != ${q(dir)} ] && rm -rf "$d"; done`,
    `if [ ! -f ${q(dir)}/notebook/ui/dist/index.html ]; then rm -rf ${q(dir)}; git clone -q https://github.com/${env.REPO}.git ${q(dir)}; git -C ${q(dir)} checkout -q ${commit};`,
    `  cd ${q(dir)}/notebook/ui && npm ci --no-audit --no-fund --cache ${q(env.WORK)}/npm-cache >${q(env.WORK)}/npm.log 2>&1 && npm run build >${q(env.WORK)}/build.log 2>&1; fi`,
    `git -C ${q(dir)} rev-parse HEAD`,
  ].join("\n"), 30);
  if (r.status !== 0) throw new Error(`the checkout of ${commit.slice(0, 10)} could not be built: ${short(r.stderr).slice(-300)}`);
  return dir;
}
// A browser runtime folder is ready when Playwright and both of its Chromium builds are in it.
export function browserReady(dir) {
  try {
    if (!fs.existsSync(path.join(dir, "node_modules", "playwright", "package.json"))) return false;
    const b = fs.readdirSync(path.join(dir, "browsers"));
    return b.some(n => /^chromium-\d+$/.test(n)) && b.some(n => /^chromium_headless_shell-\d+$/.test(n));
  } catch { return false; }
}
const isRealDir = p => { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };
// What installs a runtime in its home folder, as the factory user: a copy of the one in /tmp while that
// is still a real folder, otherwise Playwright at the pinned version and its Chromium, fresh.
export function browserInstallScript({ from, home, version, cache }) {
  if (from) return `set -e; cp -a ${q(from)}/. ${q(home)}/; for l in node_modules/node_modules browsers/browsers; do if [ -L ${q(home)}/$l ]; then rm ${q(home)}/$l; fi; done`;
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error(`not a Playwright version: ${version}`);
  return ["set -e", `cd ${q(home)}`, `[ -f package.json ] || echo '{"name":"holdout-browser","private":true}' > package.json`,
    `npm install --no-audit --no-fund --save-exact${cache ? ` --cache ${q(cache)}` : ""} playwright@${version}`,
    `PLAYWRIGHT_BROWSERS_PATH=${q(home)}/browsers ./node_modules/.bin/playwright install chromium`].join("\n");
}

// Make the tools and the browser findable (see "findable" above). -> {ok, changed: [...], left: [...], why}
// Runs as root; every file it makes belongs to the factory user. dry: says what it would change.
// Since 2026-11-17 the browser lives in the factory user's home (BROWSER_HOME), because /tmp is wiped on
// every reboot; /tmp/hv-pw, which every tool names, is a link to it, made again on every look (the same
// for /tmp/hv-debs, the old unpacked libraries two tools still name). A missing runtime is installed
// again, Playwright at the pinned version. Root never follows the /tmp links (protected_symlinks).
export function ensureFindable(env, dry = false, deps = {}) {
  const changed = [], left = [];
  if (!env.TOOLS_DIR || !fs.existsSync(env.TOOLS_DIR)) return { ok: false, changed, left, why: "no tools folder" };
  const run = deps.asForge || ((script, min) => asForge(env, script, min));
  const own = p => { if (typeof process.getuid === "function" && process.getuid() === 0) fs.lchownSync(p, env.FORGE_UID, env.FORGE_GID); };
  const writeIfNew = (file, text, mode) => {
    let before = null; try { before = fs.readFileSync(file, "utf8"); } catch {}
    if (before === text) return;
    changed.push(file); if (dry) return;
    const t = `${file}.tm-${process.pid}.tmp`;
    fs.writeFileSync(t, text, { mode }); fs.chmodSync(t, mode); own(t); fs.renameSync(t, file);
  };
  const pointsAt = (at, target) => { try { return path.resolve(path.dirname(at), fs.readlinkSync(at)).replace(/[\\/]+$/, "") === path.resolve(target); } catch { return false; } };
  const link = (target, at) => {
    let st = null; try { st = fs.lstatSync(at); } catch {}
    if (st && !st.isSymbolicLink()) { left.push(`${at}: exists and is not a link`); return; }
    if (st && pointsAt(at, target)) return;
    changed.push(`${at} -> ${target}`); if (dry) return;
    if (st) fs.unlinkSync(at);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, "junction"); own(at);
  };
  // the /tmp place a tool names becomes a link; a real folder there (its content is in the home folder
  // by then) moves aside first and goes
  const tmpLink = (target, at) => {
    let st = null; try { st = fs.lstatSync(at); } catch {}
    if (st && st.isSymbolicLink() && pointsAt(at, target)) return;
    changed.push(`${at} -> ${target}`); if (dry) return;
    const aside = st ? `${at}.old-${process.pid}-${Date.now()}` : null;
    if (aside) fs.renameSync(at, aside);
    fs.symlinkSync(target, at, "junction"); own(at);
    if (aside) fs.rmSync(aside, { recursive: true, force: true });
  };
  // 0. the browser out of /tmp
  const home = env.BROWSER_HOME || env.BROWSER_ROOT;
  let ready = !!home && browserReady(home);
  if (env.BROWSER_HOME && !ready) {
    const from = isRealDir(env.BROWSER_ROOT) && browserReady(env.BROWSER_ROOT) ? env.BROWSER_ROOT : null;
    changed.push(from ? `${home} copied from ${from}` : `${home} installed (Playwright ${env.PLAYWRIGHT_VERSION} and its Chromium)`);
    if (dry) ready = true;
    else {
      fs.mkdirSync(home, { recursive: true }); own(home);
      const r = run(browserInstallScript({ from, home, version: env.PLAYWRIGHT_VERSION, cache: env.WORK && path.posix.join(env.WORK, "npm-cache") }), 30);
      ready = browserReady(home);
      if (!ready) return { ok: false, changed, left, why: `the verifier's browser could not be installed in ${home} (${short(`${r.stderr || ""} ${r.stdout || ""}`).slice(-300) || `exit ${r.status}`})` };
    }
  }
  if (!ready) { left.push(`no Playwright in ${home}`); return { ok: false, changed, left, why: `the verifier's browser runtime is missing (${home})` }; }
  if (env.BROWSER_HOME && env.BROWSER_ROOT) tmpLink(env.BROWSER_HOME, env.BROWSER_ROOT);
  if (env.DEBS_HOME && env.DEBS_ROOT) {
    if (!isRealDir(env.DEBS_HOME) && isRealDir(env.DEBS_ROOT)) {
      changed.push(`${env.DEBS_HOME} copied from ${env.DEBS_ROOT}`);
      if (!dry) {
        fs.mkdirSync(env.DEBS_HOME, { recursive: true }); own(env.DEBS_HOME);
        if (run(browserInstallScript({ from: env.DEBS_ROOT, home: env.DEBS_HOME }), 10).status !== 0) left.push(`${env.DEBS_ROOT} could not be copied`);
      }
    }
    if (isRealDir(env.DEBS_HOME) || (dry && isRealDir(env.DEBS_ROOT))) tmpLink(env.DEBS_HOME, env.DEBS_ROOT);
  }
  // 1. the list at the top of the tools folder
  const tools = fs.readdirSync(env.TOOLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && /^H-\d+$/.test(d.name)).map(d => {
    const md = path.join(env.TOOLS_DIR, d.name, "TOOL.md");
    const command = fs.existsSync(md) ? commandOf(fs.readFileSync(md, "utf8"), { id: d.name, tools: env.TOOLS_DIR, target: "{target}", out: "{out}", judges: path.posix.join(env.SCENARIOS_DIR || "", "judges") }) : null;
    return { id: d.name, command };
  });
  const browsers = fs.existsSync(path.join(home, "browsers-latest")) ? path.join(home, "browsers-latest") : path.join(home, "browsers");
  let missing = [];
  try { missing = toolCoverage(env).missing.map(m => m.id); } catch {}
  writeIfNew(path.join(env.TOOLS_DIR, "README.md"), toolsIndex(tools, env.TOOLS_DIR, browsers, missing.filter(id => !tools.some(t => t.id === id))), 0o664);
  // 2. one line in the hidden scenario file
  const holdout = env.SCENARIOS_DIR && path.join(env.SCENARIOS_DIR, "HOLDOUT.md");
  if (holdout && fs.existsSync(holdout)) {
    const next = withPointer(fs.readFileSync(holdout, "utf8"), pointerLine(env.TOOLS_DIR, missing));
    if (next !== null) writeIfNew(holdout, next, fs.statSync(holdout).mode & 0o777);
  } else left.push("no hidden scenario file");
  // 3. Playwright and Chromium where a verifier looks, pointing straight at the home folder
  if (env.FORGE_HOME) {
    link(path.join(home, "node_modules"), path.join(env.FORGE_HOME, ".node_modules"));
    link(browsers, path.join(env.FORGE_HOME, ".cache", "ms-playwright"));
    const bin = path.join(env.FORGE_HOME, ".local", "bin", "chromium");
    let cur = null; try { cur = fs.readFileSync(bin, "utf8"); } catch {}
    if (cur !== null && !cur.includes(WRAPPER_MARK)) left.push(`${bin}: someone else's`);
    else { if (!dry) fs.mkdirSync(path.dirname(bin), { recursive: true }); writeIfNew(bin, chromiumWrapper(env.FORGE_HOME, env.TOOLS_DIR), 0o755); }
  }
  return { ok: true, changed, left, why: left.length ? left.join("; ") : "" };
}

// one hidden check, as the verifier runs it, as its user, outside any sandbox
export function observe(env, id, target, rec) {
  const toolMd = path.join(env.TOOLS_DIR, id, "TOOL.md");
  const out = path.posix.join(env.WORK, "out", `${id}-${Date.now()}`);
  const cmd = fs.existsSync(toolMd) ? commandOf(fs.readFileSync(toolMd, "utf8"), { id, tools: env.TOOLS_DIR, target, out, judges: path.posix.join(env.SCENARIOS_DIR, "judges") }) : null;
  if (!cmd) return { id, verdict: "INCOMPLETE", why: "its TOOL.md names no command" };
  const r = asForge(env, `set -u; rm -rf ${q(path.posix.join(env.WORK, "out"))}; mkdir -p ${q(out)}; cd /tmp; ${cmd} 2>&1; echo "exit: $?"`, env.OBSERVE_MINUTES + 1);
  const text = `${r.stdout || ""}${r.error ? `\n${r.error.message}` : ""}`;
  if (rec) { fs.mkdirSync(rec, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(rec, `${id}.txt`), text.slice(-200000)); }
  const verdict = verdictOf(text);
  const last = text.trim().split("\n").filter(l => /^\s*verdict:/i.test(l)).at(-1) || text.trim().split("\n").at(-1) || "";
  return { id, verdict, last: short(last).slice(0, 300), exit: (/exit: (\d+)\s*$/.exec(text) || [])[1] || String(r.status) };
}

// ---------------------------------------------------------------- one look
export async function look(env, deps = {}) {
  const log = deps.log || console.log;
  const now = deps.now ? deps.now() : Date.now();
  const stateFile = path.join(env.STATE_DIR, "state.json");
  const read = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const state = read(stateFile) || {};
  state.referee ||= { done: {}, runs: [] };
  const record = e => { if (env.DRY) return; fs.mkdirSync(env.STATE_DIR, { recursive: true }); fs.appendFileSync(path.join(env.STATE_DIR, "decisions.jsonl"), JSON.stringify({ at: iso(deps.now ? deps.now() : Date.now()), ...e }) + "\n"); };
  const save = () => { if (env.DRY) return; fs.mkdirSync(env.STATE_DIR, { recursive: true }); const t = `${stateFile}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(state, null, 2) + "\n"); fs.renameSync(t, stateFile); };
  // A hand-off is the driver's work, never a message to the owner: the look returns it as a halt. A halt
  // a look has not set is not there: it ends when the cause does.
  let halt = null;
  const stop = (key, words) => { halt = { key, words }; };
  const result = r => ({ ...r, ...(halt ? { halt } : {}) });
  try {
    if (env.CLEAR_HALT) { if (state.halted) { record({ kind: "halt cleared", why: state.halted.why }); delete state.halted; save(); log("halt cleared"); } else log("not halted"); return { cleared: true }; }
    // 0. the tools and the browser where a verifier looks for them
    let found;
    try { found = (deps.findable || (() => ensureFindable(env, env.DRY)))(); } catch (e) { found = { ok: false, changed: [], left: [], why: String(e.message).slice(0, 200) }; }
    state.findable = { ok: !!found.ok, at: iso(now), why: found.why || "" };
    if (found.changed && found.changed.length) { record({ kind: env.DRY ? "would make findable" : "made findable", what: found.changed }); log(`findable: ${env.DRY ? "would change" : "changed"} ${found.changed.join(", ")}`); }
    if (!found.ok || (found.left && found.left.length)) log(`findable: ${found.why}`);
    // 1. the check
    const check = deps.check || (() => {
      const staged = stagedRelease(readStagings(env.RELEASES_DIR), env.REPO);
      if (!staged) return { staged: null, smoke: { ok: false, error: "no release is recorded as installed on the owner's server" }, holdout: null };
      const target = prepareTarget(env, staged.commit);
      const smoke = (deps.smoke || (t => refereeSmoke(env, env.TOOLS_DIR, t)))(target);
      const holdout = smoke.ok ? observe(env, env.HOLDOUT, target, path.join(env.STATE_DIR, "runs", iso(now).replace(/[:.]/g, ""))) : { id: env.HOLDOUT, verdict: "INCOMPLETE", why: "not run: the browser did not stay up" };
      return { staged, target, smoke, holdout };
    });
    let c;
    try { c = await check(); } catch (e) { c = { staged: null, smoke: { ok: false, error: String(e.message).slice(0, 300) }, holdout: null }; }
    // every scenario has a tool (see "every scenario has a tool" above)
    let coverage;
    try { coverage = (deps.coverage || (() => toolCoverage(env)))(); } catch (e) { coverage = { ids: [], missing: [], why: String(e.message).slice(0, 200), failed: true }; }
    c.coverage = coverage;
    let health = judgeHealth(c);
    const was = state.healthy;
    Object.assign(state, nextState(state.healthy === undefined ? null : state, health, now, { release: c.staged ? c.staged.version : null, commit: c.staged ? c.staged.commit : null, holdout: c.holdout ? { id: c.holdout.id, verdict: c.holdout.verdict } : null, smoke: c.smoke ? { ok: !!c.smoke.ok, browser: c.smoke.browser || "", error: short(c.smoke.error).slice(0, 200) } : null,
      tools: { scenarios: coverage.ids.length, missing: coverage.missing.map(m => m.id), ...(coverage.why ? { why: coverage.why } : {}) } }));
    log(`test machine: ${health.healthy ? "healthy" : "NOT healthy"}: ${health.why}${c.staged ? ` (release ${c.staged.version}, ${c.staged.commit.slice(0, 10)})` : ""}`);
    if (was !== health.healthy) record({ kind: health.healthy ? "healthy" : "unhealthy", why: health.why, release: state.release, holdout: state.holdout });
    if (health.healthy) { save(); return { healthy: true, state }; }
    if (env.DRY) { log("dry run: no repair"); return { healthy: false, state }; }
    save();
    // A scenario without a tool is not a fault of the verifier's environment, so the environment repair
    // would only spend one of the day's three repairs. The factory driver builds the tool (its
    // tools-missing obstacle sends a tests helper; tools it cannot read are its unreadable obstacle), so
    // this is logged once per episode and never a halt, since nobody could clear it by hand (2026-11-18: one
    // reached him at 19:07 for H-41 to H-43).
    if (health.tools) {
      log("no repair: the environment works; what is missing is a tool, which the factory driver builds");
      if (state.tools_logged !== state.since) { record({ kind: "tools missing", missing: coverage.missing.map(m => m.id), why: toolsText(state, coverage) }); state.tools_logged = state.since; }
      save(); return { healthy: false, state };
    }
    // a repair whose audit found a breach stops every further repair until Mission Control looked at it
    if (state.halted) { log(`no repair: halted since ${state.halted.at} (${state.halted.why})`); stop("repair-halted", haltedText(state)); save(); return result({ healthy: false, state }); }
    // 2. the repair, on the failed check itself
    const evidence = `The test machine's own check (${iso(now).slice(0, 16).replace("T", " ")} UTC), as ${env.FORGE_USER} outside any sandbox, on the release installed on the owner's server (${state.release || "none"}, ${String(state.commit || "").slice(0, 10)}): ${health.why}. Smoke test: ${JSON.stringify(c.smoke || {})}. ${c.holdout ? `${c.holdout.id}: ${c.holdout.verdict}${c.holdout.last ? ` (its last line: ${c.holdout.last})` : ""}` : ""}`;
    const cand = { item: 0, title: "the test machine's own check", url: "", ids: [env.HOLDOUT], evidence: [{ url: "", body: evidence }], body: evidence, key: sha(`${health.why}\n${state.commit}\n${iso(now).slice(0, 10)}`).slice(0, 16), prs: [] };
    const res = await (deps.repair || repairLook)(env, { log, record: e => record(e), post: async () => true }, { items: [] }, state, now, { runId: `tm-${iso(now).slice(0, 16).replace(/[-:T]/g, "")}-${sha(now).slice(0, 6)}`, cands: [cand] });
    log(`repair: ${res.ran ? res.outcome : res.why}`);
    if (res.ran && res.outcome === "breach") {
      state.halted = { at: iso(now), why: `the repair's AI did something it may not do (${(res.breaches || []).map(b => b.why).filter((v, i, a) => a.indexOf(v) === i).join("; ")})` };
      record({ kind: "halted", why: state.halted.why });
      stop("repair-halted", haltedText(state));
      save(); return result({ healthy: false, state, repair: res });
    }
    // 3. after an applied repair: the named observations again, here, outside the sandbox
    if (res.ran && res.outcome === "applied") {
      const target = c.target || null;
      const ids = [...new Set([env.HOLDOUT, ...(res.observedIds || [])])];
      const verdicts = target ? ids.map(id => (deps.observe || ((i, t) => observe(env, i, t, path.join(env.STATE_DIR, "runs", `after-${iso(now).replace(/[:.]/g, "")}`))))(id, target)) : [];
      const smoke2 = target ? (deps.smoke || (t => refereeSmoke(env, env.TOOLS_DIR, t)))(target) : { ok: false, error: "no target" };
      record({ kind: "observed after the repair", run: res.runId || null, verdicts: verdicts.map(v => ({ id: v.id, verdict: v.verdict, last: v.last })), smoke: { ok: !!smoke2.ok } });
      health = judgeHealth({ smoke: smoke2, holdout: verdicts.find(v => v.id === env.HOLDOUT), coverage });
      Object.assign(state, nextState(state, health, deps.now ? deps.now() : Date.now(), { holdout: verdicts.find(v => v.id === env.HOLDOUT) ? { id: env.HOLDOUT, verdict: verdicts.find(v => v.id === env.HOLDOUT).verdict } : state.holdout, afterRepair: verdicts.map(v => ({ id: v.id, verdict: v.verdict })) }));
      if (health.healthy) { record({ kind: "healthy", why: `after the repair: ${health.why}` }); save(); return { healthy: true, state, repair: res }; }
    }
    // 4. still broken after a repair, or no repair left today: a halt for the driver
    if ((res.ran && res.outcome !== "applied") || (res.ran && !health.healthy) || res.capped) stop("broken", brokenText(state));
    save();
    return result({ healthy: false, state, repair: res });
  } finally { /* nothing is held between looks: the runner starts one at a time and ends it at its maximum */ }
}

